/**
 * Provider-agnostic domain types for the agent harness.
 *
 * These deliberately avoid any xAI/OpenAI wire shapes. A concrete provider
 * (see `@ion/xai`) implements {@link LanguageModel} by translating
 * these domain items to and from its own API format.
 */

/** A minimal JSON Schema description for a tool's parameters. */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

/** A tool the model is allowed to call, as advertised to the provider. */
export interface ToolDef {
  name: string
  description: string
  parameters: JsonSchema
}

/**
 * A single item in a conversation transcript. This is the unit that is both
 * persisted to disk and sent to the model (after translation).
 */
export type ConversationItem =
  | TextMessage
  | ToolCallItem
  | ToolResultItem
  | ReasoningItem
  | CheckpointItem

/**
 * Encrypted reasoning from a Grok reasoning model. Must be echoed back on
 * the next request so the tool loop keeps its chain-of-thought. Opaque to
 * the UI - never display `encryptedContent`.
 */
export interface ReasoningItem {
  kind: 'reasoning'
  id: string
  encryptedContent: string
  summary?: string
}

/** How a user-dropped file is sent to the model. */
export type AttachmentKind = 'image' | 'file' | 'video'

/**
 * A file the user attached to a chat message. Bytes live on disk (`path`);
 * `base64` is loaded only for the model call and stripped on persist.
 */
export interface MessageAttachment {
  id: string
  name: string
  mimeType: string
  kind: AttachmentKind
  /** Absolute path under the host's attachments dir. */
  path: string
  /** xAI Files API id - documents (and video if the API accepts it). */
  fileId?: string
  /** Image bytes for vision input. Never written to the session JSON. */
  base64?: string
  /** Model-only extras (e.g. sampled video frames) - hide in the bubble. */
  silent?: boolean
}

export interface TextMessage {
  kind: 'message'
  role: 'system' | 'user' | 'assistant'
  content: string
  attachments?: MessageAttachment[]
}

/** An assistant request to invoke a tool. */
export interface ToolCallItem {
  kind: 'tool_call'
  callId: string
  name: string
  /** Raw JSON string of arguments, exactly as produced by the model. */
  arguments: string
}

/** An image captured by a tool (e.g. a screenshot), sent to vision models. */
export interface ToolResultImage {
  mimeType: string
  base64: string
}

/**
 * Files the agent changed in one user turn. Persisted for review / restore.
 * Never sent to the model - the loop strips these before each request.
 */
export interface CheckpointFile {
  path: string
  created: boolean
  skipped?: boolean
  additions: number
  deletions: number
  diff: string
  /** Full pre-edit contents (`null` if the file did not exist). Used to restore. */
  before: string | null
  after: string | null
}

export interface CheckpointItem {
  kind: 'checkpoint'
  id: string
  files: CheckpointFile[]
  restoredPaths?: string[]
}

/** The result of executing a tool, fed back to the model. */
export interface ToolResultItem {
  kind: 'tool_result'
  callId: string
  output: string
  isError: boolean
  /**
   * Optional images attached to this result. Held in memory for the next
   * model call(s) only - the session store strips them on persist so base64
   * payloads never bloat the on-disk transcript.
   */
  images?: ToolResultImage[]
}

/**
 * Provider pricing for a model, in USD per million tokens. `longContext`
 * mirrors xAI's tiered billing: requests whose prompt reaches
 * `thresholdTokens` are billed at the higher rates for all tokens.
 */
export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  cachedInputPerMTok?: number
  longContext?: {
    thresholdTokens: number
    inputPerMTok: number
    outputPerMTok: number
  }
}

/** Metadata about a model exposed by the provider. */
export interface ModelInfo {
  id: string
  /** Optional human label; falls back to `id`. */
  label?: string
  /** Max tokens the model can hold in context, when known. */
  contextWindow?: number
  /** Per-token pricing, when known (API-key billing). */
  pricing?: ModelPricing
  /** Reasoning-effort levels the model accepts, when it supports depth control. */
  efforts?: string[]
}

/** Streaming events emitted by a {@link LanguageModel} during one turn. */
export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning_item'; id: string; encryptedContent: string; summary?: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      cachedInputTokens?: number
      reasoningTokens?: number
    }
  | { type: 'done'; finishReason: 'stop' | 'tool_calls' | 'length' | 'unknown' }

/** Options for a single streamed model turn. */
export interface ModelStreamOptions {
  model: string
  items: ConversationItem[]
  tools: ToolDef[]
  signal?: AbortSignal
}

/**
 * The single seam between the agent core and any provider. Implementations are
 * responsible for auth, transport, and translating {@link ConversationItem}s
 * into their wire format.
 */
export interface LanguageModel {
  readonly id: string
  stream(options: ModelStreamOptions): AsyncIterable<ModelEvent>
  listModels(): Promise<ModelInfo[]>
  /** Upload a private document for `input_file` / `file_id`. */
  uploadFile?(bytes: Uint8Array, filename: string): Promise<string>
}
