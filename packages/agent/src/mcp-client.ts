import { spawn, type ChildProcess } from 'node:child_process'
import { resolveUserPath } from './tools/shell-env'
import type { JsonSchema } from './types'
import type { Tool, ToolResult } from './tools/types'
import { loadMcpConfig, type LoadMcpOptions, type McpServerSpec } from './mcp'

const INIT_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 60_000
const MAX_TOOLS = 80
const PROTOCOL = '2024-11-05'

export interface McpServerStatus {
  name: string
  source: 'user' | 'project'
  status: 'connected' | 'error' | 'skipped'
  transport: 'stdio' | 'http'
  toolCount: number
  error?: string
}

export interface McpHub {
  tools: Tool[]
  status: McpServerStatus[]
  close(): Promise<void>
}

interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface CallResult {
  content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

interface RpcSession {
  listTools(): Promise<McpToolDef[]>
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallResult>
  close(): Promise<void>
}

export async function startMcpHub(
  workspaceRoot: string | null,
  options?: LoadMcpOptions
): Promise<McpHub> {
  const specs = await loadMcpConfig(workspaceRoot, options)
  const sessions: RpcSession[] = []
  const status: McpServerStatus[] = []
  const tools: Tool[] = []

  await Promise.all(
    specs.map(async (spec) => {
      const transport: McpServerStatus['transport'] = spec.command ? 'stdio' : 'http'
      if (spec.disabled) {
        status.push({
          name: spec.name,
          source: spec.source,
          status: 'skipped',
          transport,
          toolCount: 0,
          error: 'disabled'
        })
        return
      }
      try {
        const session = spec.command
          ? await connectStdio(spec, workspaceRoot)
          : await connectHttp(spec)
        const listed = await session.listTools()
        sessions.push(session)
        for (const def of listed) {
          if (tools.length >= MAX_TOOLS) break
          tools.push(wrapTool(spec, session, def))
        }
        status.push({
          name: spec.name,
          source: spec.source,
          status: 'connected',
          transport,
          toolCount: listed.length
        })
      } catch (err) {
        status.push({
          name: spec.name,
          source: spec.source,
          status: 'error',
          transport,
          toolCount: 0,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })
  )

  status.sort((a, b) => a.name.localeCompare(b.name))
  return {
    tools,
    status,
    async close() {
      await Promise.all(sessions.map((s) => s.close().catch(() => undefined)))
    }
  }
}

function wrapTool(spec: McpServerSpec, session: RpcSession, def: McpToolDef): Tool {
  const original = def.name
  const auto =
    spec.autoApprove.includes('*') ||
    spec.autoApprove.includes(original)
  return {
    name: mcpToolName(spec.name, original),
    description: `[MCP ${spec.name}] ${def.description?.trim() || original}`,
    dangerous: !auto,
    requiresWorkspace: false,
    parameters: toParams(def.inputSchema),
    summarize: (args) => {
      const brief = Object.keys(args).length ? JSON.stringify(args).slice(0, 80) : ''
      return brief ? `${spec.name}/${original} ${brief}` : `${spec.name}/${original}`
    },
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const result = await session.callTool(original, args, ctx.signal)
        return {
          output: formatContent(result),
          isError: Boolean(result.isError)
        }
      } catch (err) {
        return {
          output: `MCP ${spec.name}/${original} failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true
        }
      }
    }
  }
}

export function mcpToolName(server: string, tool: string): string {
  const name = `mcp_${slug(server)}_${slug(tool)}`
  return name.length > 64 ? name.slice(0, 64) : name
}

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'x'
}

function toParams(schema: Record<string, unknown> | undefined): JsonSchema {
  if (schema && schema.type === 'object') {
    return {
      type: 'object',
      properties: (schema.properties as Record<string, unknown>) ?? {},
      required: Array.isArray(schema.required)
        ? schema.required.filter((x): x is string => typeof x === 'string')
        : undefined,
      additionalProperties:
        typeof schema.additionalProperties === 'boolean' ? schema.additionalProperties : undefined
    }
  }
  return { type: 'object', properties: {}, additionalProperties: true }
}

function formatContent(result: CallResult): string {
  const content = result.content
  if (!Array.isArray(content) || content.length === 0) {
    return result.isError ? 'MCP tool returned an error.' : '(empty)'
  }
  return content
    .map((c) => {
      if (c.type === 'text' || typeof c.text === 'string') return c.text ?? ''
      if (c.type === 'image') return '[image]'
      return JSON.stringify(c)
    })
    .filter(Boolean)
    .join('\n')
}

async function connectStdio(spec: McpServerSpec, workspaceRoot: string | null): Promise<RpcSession> {
  const child = spawn(spec.command!, spec.args, {
    cwd: workspaceRoot || undefined,
    env: { ...process.env, PATH: resolveUserPath(), ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const rpc = new StdioRpc(child)
  try {
    await initialize(rpc)
    return {
      listTools: () => listTools(rpc),
      callTool: (name, args, signal) =>
        rpc.request<CallResult>('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS, signal),
      close: () => rpc.close()
    }
  } catch (err) {
    await rpc.close()
    throw err
  }
}

async function connectHttp(spec: McpServerSpec): Promise<RpcSession> {
  if (!spec.url) throw new Error('url is required')
  const rpc = new HttpRpc(spec.url, spec.headers)
  await initialize(rpc)
  return {
    listTools: () => listTools(rpc),
    callTool: (name, args, signal) =>
      rpc.request<CallResult>('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS, signal),
    close: () => rpc.close()
  }
}

async function initialize(rpc: { request: HttpRpc['request']; notify: HttpRpc['notify'] }): Promise<void> {
  await rpc.request(
    'initialize',
    {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'ion', version: '0.1.0' }
    },
    INIT_TIMEOUT_MS
  )
  await rpc.notify('notifications/initialized')
}

async function listTools(rpc: { request: HttpRpc['request'] }): Promise<McpToolDef[]> {
  const out: McpToolDef[] = []
  let cursor: string | undefined
  for (let i = 0; i < 10; i++) {
    const result = await rpc.request<{ tools?: McpToolDef[]; nextCursor?: string }>(
      'tools/list',
      cursor ? { cursor } : {},
      INIT_TIMEOUT_MS
    )
    if (Array.isArray(result.tools)) out.push(...result.tools)
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  return out
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class StdioRpc {
  private nextId = 1
  private buf = ''
  private stderr = ''
  private readonly pending = new Map<number, Pending>()
  private closed = false

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.feed(chunk))
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000)
    })
    child.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))))
    child.on('exit', (code) => {
      if (this.closed) return
      const extra = this.stderr.trim()
      this.failAll(
        new Error(
          `MCP process exited${code !== null ? ` (${code})` : ''}${extra ? `: ${extra.slice(0, 240)}` : ''}`
        )
      )
    })
  }

  request<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('MCP connection closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id)
        reject(new Error('Aborted'))
      }
      if (signal?.aborted) {
        reject(new Error('Aborted'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value as T)
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        },
        timer
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error('MCP connection closed'))
    this.child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.child.kill('SIGKILL')
        resolve()
      }, 1500)
      this.child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  private write(msg: unknown): void {
    if (!this.child.stdin?.writable) throw new Error('MCP stdin closed')
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  private feed(chunk: string): void {
    this.buf += chunk
    for (;;) {
      const cl = this.buf.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i)
      if (cl) {
        const n = Number(cl[1])
        const start = cl[0].length
        if (this.buf.length < start + n) return
        const body = this.buf.slice(start, start + n)
        this.buf = this.buf.slice(start + n)
        this.handleLine(body)
        continue
      }
      const nl = this.buf.indexOf('\n')
      if (nl < 0) return
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      return
    }
    if (typeof msg.id !== 'number') return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    clearTimeout(pending.timer)
    if (msg.error) pending.reject(new Error(msg.error.message || 'MCP error'))
    else pending.resolve(msg.result)
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}

class HttpRpc {
  private nextId = 1
  private sessionId: string | null = null

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>
  ) {}

  async request<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    const id = this.nextId++
    const msg = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs, signal)
    if (msg && typeof msg === 'object' && 'error' in msg && msg.error) {
      const err = msg.error as { message?: string }
      throw new Error(err.message || 'MCP error')
    }
    return (msg as { result: T }).result
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post(
      { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) },
      INIT_TIMEOUT_MS
    )
  }

  async close(): Promise<void> {
    if (!this.sessionId) return
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': this.sessionId, ...this.headers }
      })
    } catch {
      // best-effort
    }
  }

  private async post(body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const onAbort = (): void => ac.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...this.headers,
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
        },
        body: JSON.stringify(body),
        signal: ac.signal
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
      if (res.status === 202 || res.status === 204) return {}
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      return parseHttpRpc(text, res.headers.get('content-type') ?? '')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

function parseHttpRpc(text: string, contentType: string): unknown {
  if (contentType.includes('text/event-stream')) {
    for (const block of text.split('\n\n')) {
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (!data || data === '[DONE]') continue
      try {
        const obj = JSON.parse(data) as { result?: unknown; error?: unknown }
        if (obj.result !== undefined || obj.error) return obj
      } catch {
        // skip malformed event
      }
    }
    throw new Error('SSE response had no JSON-RPC result')
  }
  return text ? JSON.parse(text) : {}
}
