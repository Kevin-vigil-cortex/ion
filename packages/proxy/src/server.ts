import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { Credentials } from '@ion/xai'

export interface ProxyServerOptions {
  port: number
  /** Upstream xAI base URL, e.g. https://api.x.ai/v1 */
  baseUrl: string
  /** Resolves credentials (OAuth or API key) at request time. */
  getCredentials: () => Promise<Credentials>
  /** Bind host; defaults to loopback so the proxy is never exposed off-box. */
  host?: string
  fetchImpl?: typeof fetch
}

export interface ProxyServerHandle {
  port: number
  close: () => Promise<void>
}

/**
 * Local OpenAI-compatible proxy. It injects the current bearer token so any
 * OpenAI-style client can use a SuperGrok subscription without handling tokens.
 *
 * Routes:
 *   - POST /v1/responses          -> upstream /responses (passthrough)
 *   - POST /v1/chat/completions   -> translated to /responses upstream
 *   - GET  /v1/models             -> upstream /models
 */
export function startProxyServer(options: ProxyServerOptions): Promise<ProxyServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const doFetch = options.fetchImpl ?? globalThis.fetch

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      sendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    // The proxy injects the user's credentials, so only same-machine,
    // non-browser clients may talk to it: a browser page reaching it via
    // DNS rebinding keeps its forged hostname in Host and always sends
    // Origin — reject both. Legit local CLI/SDK clients send neither.
    if (!isLocalHostHeader(req.headers.host)) {
      return sendJson(res, 403, {
        error: { message: 'Forbidden: proxy only accepts requests addressed to localhost.' }
      })
    }
    if (req.headers.origin !== undefined) {
      return sendJson(res, 403, {
        error: { message: 'Forbidden: browser requests are not allowed on this proxy.' }
      })
    }

    if (method === 'GET' && (url === '/health' || url === '/')) {
      return sendJson(res, 200, { ok: true, upstream: baseUrl })
    }

    let authorization: string
    try {
      authorization = await (await options.getCredentials()).authorizationHeader()
    } catch (err) {
      return sendJson(res, 401, {
        error: { message: err instanceof Error ? err.message : 'Not authenticated' }
      })
    }

    if (method === 'GET' && url.startsWith('/v1/models')) {
      const upstream = await doFetch(`${baseUrl}/models`, { headers: { Authorization: authorization } })
      return pipe(upstream, res)
    }

    if (method === 'POST' && url.startsWith('/v1/responses')) {
      const body = await readBody(req)
      const upstream = await doFetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: passHeaders(req, authorization),
        body
      })
      return pipe(upstream, res)
    }

    if (method === 'POST' && url.startsWith('/v1/chat/completions')) {
      const body = await readBody(req)
      const translated = chatCompletionsToResponses(body)
      const upstream = await doFetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: passHeaders(req, authorization),
        body: translated
      })
      return pipe(upstream, res)
    }

    sendJson(res, 404, { error: { message: `No route for ${method} ${url}` } })
  }

  return new Promise((resolve) => {
    server.listen(options.port, host, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : options.port
      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
      })
    })
  })
}

function passHeaders(req: IncomingMessage, authorization: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: authorization
  }
  const accept = req.headers['accept']
  if (typeof accept === 'string') headers['Accept'] = accept
  return headers
}

/** Best-effort translation of a Chat Completions body to a Responses body. */
function chatCompletionsToResponses(raw: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return raw
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  const input = messages.map((m) => {
    const msg = m as { role?: string; content?: unknown }
    return { role: msg.role ?? 'user', content: normalizeContent(msg.content) }
  })
  const out: Record<string, unknown> = { ...parsed, input }
  delete out.messages
  return JSON.stringify(out)
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { text?: unknown }
        return typeof p.text === 'string' ? p.text : ''
      })
      .join('')
  }
  return ''
}

/** Hostnames a legitimate local client would address the proxy by. */
function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false
  // Strip :port (handle bracketed IPv6 too).
  const name = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

const MAX_BODY_BYTES = 25 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function pipe(upstream: Response, res: ServerResponse): Promise<void> {
  res.statusCode = upstream.status
  const contentType = upstream.headers.get('content-type')
  if (contentType) res.setHeader('Content-Type', contentType)

  if (!upstream.body) {
    res.end()
    return
  }
  const reader = upstream.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) res.write(Buffer.from(value))
  }
  res.end()
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(body)
}
