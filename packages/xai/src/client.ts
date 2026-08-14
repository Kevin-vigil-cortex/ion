import type {
  LanguageModel,
  ModelEvent,
  ModelInfo,
  ModelStreamOptions,
  ConversationItem,
  ToolDef
} from '@ion/agent'
import type { Credentials } from './auth/types'
import type {
  ResponsesInputItem,
  ResponsesContentPart,
  ResponsesFunctionTool,
  ResponsesRequest,
  StreamedFunctionCallItem,
  StreamedReasoningItem,
  ModelListResponse
} from './types'
import { parseSse } from './sse'
import { XaiError } from './errors'
import {
  DEFAULT_BASE_URL,
  FALLBACK_MODELS,
  supportsReasoningEffort,
  withModelMetadata,
  type ReasoningEffort
} from './models'

export interface XaiClientConfig {
  credentials: Credentials
  /** Defaults to `https://api.x.ai/v1`. Point at the local proxy to use OAuth. */
  baseUrl?: string
  /** Override for tests. */
  fetchImpl?: typeof fetch
  /**
   * Sampling temperature (0–2). Defaults to 0.2: low variance keeps Grok's
   * tool arguments and multi-step plans dependable in agent loops.
   */
  temperature?: number
  /**
   * Cap on generated tokens (output + reasoning). Left unset by default —
   * xAI applies its own 128k default, which is the sensible ceiling here.
   */
  maxOutputTokens?: number
  /**
   * Reasoning depth for grok-4.5/grok-4.6+ (`reasoning.effort`). The API-side
   * default is 'high'; this client defaults to 'medium' as the better
   * latency/depth balance for an interactive tool-calling agent. Note xhigh
   * is grok-4.6+ only (4.5 coerces it to high). Ignored for models without
   * the parameter.
   */
  reasoningEffort?: ReasoningEffort
  /** Max retries for 429/5xx/network failures (default 3, exponential + jitter). */
  maxRetries?: number
}

/** xAI Responses API client implementing the agent's provider interface. */
export class XaiModelClient implements LanguageModel {
  readonly id = 'xai'
  private readonly credentials: Credentials
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly temperature: number
  private readonly maxOutputTokens: number | undefined
  private readonly reasoningEffort: ReasoningEffort
  private readonly maxRetries: number

  constructor(config: XaiClientConfig) {
    this.credentials = config.credentials
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
    this.temperature = config.temperature ?? 0.2
    this.maxOutputTokens = config.maxOutputTokens
    this.reasoningEffort = config.reasoningEffort ?? 'medium'
    this.maxRetries = config.maxRetries ?? 3
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { Authorization: await this.credentials.authorizationHeader() }
      })
      if (!res.ok) return withModelMetadata(FALLBACK_MODELS)
      const json = (await res.json()) as ModelListResponse
      const models = (json.data ?? [])
        .map((m) => ({ id: m.id, label: m.id }))
        .filter((m) => m.id.includes('grok'))
      return withModelMetadata(models.length ? models : FALLBACK_MODELS)
    } catch {
      return withModelMetadata(FALLBACK_MODELS)
    }
  }

  /**
   * Upload a private file to xAI and return its `file_id` for `input_file`.
   * TTL is 30 days so SuperGrok accounts don't accumulate forever.
   */
  async uploadFile(bytes: Uint8Array, filename: string): Promise<string> {
    const form = new FormData()
    // expires_after must appear before `file` or xAI 400s the upload.
    form.append('purpose', 'assistants')
    form.append('expires_after', '2592000')
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    form.append('file', new Blob([copy]), filename)
    const res = await this.fetchImpl(`${this.baseUrl}/files`, {
      method: 'POST',
      headers: { Authorization: await this.credentials.authorizationHeader() },
      body: form
    })
    if (!res.ok) {
      const text = await safeText(res)
      throw new XaiError(`File upload failed (${res.status}): ${text}`, res.status)
    }
    const json = (await res.json()) as { id?: string }
    if (!json.id) throw new XaiError('File upload returned no id', res.status)
    return json.id
  }

  async *stream(options: ModelStreamOptions): AsyncIterable<ModelEvent> {
    const body: ResponsesRequest = {
      model: options.model,
      input: options.items.flatMap(toInputItems),
      stream: true,
      temperature: this.temperature,
      // Local-only: don't store turns on xAI. Encrypted reasoning is NOT
      // requested — replaying a reconstructed reasoning/compaction blob
      // 400s ("Could not decode the compaction blob"). Function-call pairs
      // are enough for the tool loop.
      store: false,
      // Let Grok emit several independent calls per turn; the agent loop
      // still executes them sequentially for safety.
      parallel_tool_calls: true,
      max_tool_calls: 8
    }
    if (this.maxOutputTokens !== undefined) body.max_output_tokens = this.maxOutputTokens
    if (supportsReasoningEffort(options.model)) {
      body.reasoning = { effort: this.reasoningEffort }
    }
    const tools = options.tools.map(toFunctionTool)
    if (tools.length) body.tools = tools

    const response = await this.postWithRetry(body, options.signal)

    if (!response.ok || !response.body) {
      const text = await safeText(response)
      throw new XaiError(
        `xAI request failed (${response.status}): ${text || response.statusText}`,
        response.status,
        text
      )
    }

    yield* this.readStream(response.body)
  }

  /**
   * POST with resilience: one credential refresh on 401, and exponential
   * backoff + jitter (honoring Retry-After) on 429/5xx and network errors.
   * Aborts always propagate immediately.
   */
  private async postWithRetry(body: ResponsesRequest, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal)

      let response: Response | null = null
      let networkError: unknown = null
      try {
        response = await this.post(body, signal)
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) throw err
        networkError = err
      }

      if (response && response.status === 401 && this.credentials.handleUnauthorized) {
        const refreshed = await this.credentials.handleUnauthorized()
        if (refreshed) response = await this.post(body, signal)
      }

      if (response && !isRetryableStatus(response.status)) return response

      if (attempt >= this.maxRetries) {
        if (response) return response
        throw networkError
      }

      await sleep(retryDelayMs(attempt, response), signal)
    }
  }

  private async post(body: ResponsesRequest, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: await this.credentials.authorizationHeader()
      },
      body: JSON.stringify(body),
      signal
    })
  }

  private async *readStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ModelEvent> {
    let sawToolCall = false
    let completed = false

    for await (const sse of parseSse(stream)) {
      if (sse.data === '[DONE]') break
      let json: Record<string, unknown>
      try {
        json = JSON.parse(sse.data) as Record<string, unknown>
      } catch {
        continue
      }
      const type = (json.type as string | undefined) ?? sse.event

      switch (type) {
        case 'response.output_text.delta': {
          const delta = json.delta
          if (typeof delta === 'string' && delta) yield { type: 'text_delta', text: delta }
          break
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          const delta = json.delta
          if (typeof delta === 'string' && delta) yield { type: 'reasoning_delta', text: delta }
          break
        }
        case 'response.output_item.done': {
          const item = json.item as
            | StreamedFunctionCallItem
            | StreamedReasoningItem
            | undefined
          if (item && item.type === 'function_call') {
            sawToolCall = true
            const callId = item.call_id ?? item.id
            if (!callId) break
            yield {
              type: 'tool_call',
              callId,
              name: item.name,
              arguments: item.arguments ?? '{}'
            }
          } else if (
            item &&
            item.type === 'reasoning' &&
            item.id &&
            typeof item.encrypted_content === 'string' &&
            item.encrypted_content
          ) {
            yield {
              type: 'reasoning_item',
              id: item.id,
              encryptedContent: item.encrypted_content,
              ...(typeof item.summary === 'string' ? { summary: item.summary } : {})
            }
          }
          break
        }
        case 'response.failed':
        case 'error': {
          const message = extractError(json)
          throw new XaiError(`xAI stream error: ${message}`, 0, sse.data)
        }
        case 'response.completed': {
          const usage = extractUsage(json)
          if (usage) yield usage
          completed = true
          break
        }
        default:
          break
      }
    }

    yield {
      type: 'done',
      finishReason: sawToolCall ? 'tool_calls' : completed ? 'stop' : 'unknown'
    }
  }
}

/**
 * Translate one domain item into Responses input items. Tool results that
 * carry images expand into the function_call_output plus a follow-up user
 * message with `input_image` parts — the pattern the Responses API expects,
 * since function outputs themselves are text-only. Grok 4+ models accept
 * base64 data URIs (PNG/JPEG, `detail: 'high'` for dense screenshots).
 */
function toInputItems(item: ConversationItem): ResponsesInputItem[] {
  switch (item.kind) {
    case 'message':
      return [{ role: item.role, content: messageContent(item) }]
    case 'reasoning':
      // Never echo reconstructed reasoning/compaction blobs — xAI rejects
      // anything that isn't a verbatim compact-response item.
      return []
    case 'checkpoint':
      return []
    case 'tool_call':
      return [
        { type: 'function_call', call_id: item.callId, name: item.name, arguments: item.arguments }
      ]
    case 'tool_result': {
      const items: ResponsesInputItem[] = [
        { type: 'function_call_output', call_id: item.callId, output: item.output }
      ]
      if (item.images && item.images.length > 0) {
        const parts: ResponsesContentPart[] = [
          {
            type: 'input_text',
            text: `Screenshot(s) captured by tool call ${item.callId}:`
          },
          ...item.images.map(
            (img): ResponsesContentPart => ({
              type: 'input_image',
              image_url: `data:${img.mimeType};base64,${img.base64}`,
              detail: 'high'
            })
          )
        ]
        items.push({ role: 'user', content: parts })
      }
      return items
    }
  }
}

function messageContent(
  item: Extract<ConversationItem, { kind: 'message' }>
): string | ResponsesContentPart[] {
  const atts = item.attachments ?? []
  if (atts.length === 0) return item.content
  const parts: ResponsesContentPart[] = []
  if (item.content.trim()) {
    parts.push({ type: 'input_text', text: item.content })
  } else {
    parts.push({ type: 'input_text', text: 'See attached.' })
  }
  for (const a of atts) {
    if (a.kind === 'image' && a.base64) {
      parts.push({
        type: 'input_image',
        image_url: `data:${a.mimeType || 'image/png'};base64,${a.base64}`,
        detail: 'high'
      })
    } else if (a.fileId) {
      parts.push({ type: 'input_file', file_id: a.fileId })
    }
  }
  return parts
}

function toFunctionTool(tool: ToolDef): ResponsesFunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as Record<string, unknown>
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** Honor Retry-After (seconds or HTTP-date) else exponential backoff + jitter. */
function retryDelayMs(attempt: number, response: Response | null): number {
  const retryAfter = response?.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000)
    const date = Date.parse(retryAfter)
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000)
  }
  const base = Math.min(500 * 2 ** attempt, 8_000)
  return base + Math.floor(Math.random() * 250)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal)
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/**
 * Pull token usage off a `response.completed` payload. Per the xAI Responses
 * API, usage is null on early stream events and populated only on the final
 * event as `response.usage.{input_tokens, output_tokens}` with optional
 * `input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens`.
 */
function extractUsage(
  json: Record<string, unknown>
): Extract<ModelEvent, { type: 'usage' }> | null {
  const response = json.response as
    | {
        usage?: {
          input_tokens?: unknown
          output_tokens?: unknown
          input_tokens_details?: { cached_tokens?: unknown }
          output_tokens_details?: { reasoning_tokens?: unknown }
        } | null
      }
    | undefined
  const usage = response?.usage
  if (!usage || typeof usage !== 'object') return null
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null

  const event: Extract<ModelEvent, { type: 'usage' }> = {
    type: 'usage',
    inputTokens,
    outputTokens
  }
  const cached = usage.input_tokens_details?.cached_tokens
  if (typeof cached === 'number') event.cachedInputTokens = cached
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  if (typeof reasoning === 'number') event.reasoningTokens = reasoning
  return event
}

function extractError(json: Record<string, unknown>): string {
  const err = json.error ?? json.response ?? json
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return JSON.stringify(json)
}
