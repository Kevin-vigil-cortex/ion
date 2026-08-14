/**
 * Starts a fake xAI upstream + the local proxy and exercises all routes,
 * asserting bearer injection and the chat-completions -> responses translation.
 */
import { createServer, request, type IncomingMessage } from 'node:http'
import { startProxyServer } from '@ion/proxy'
import { ApiKeyCredentials } from '@ion/xai'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

async function main(): Promise<void> {
  const seen: { path: string; auth: string | undefined; body: unknown }[] = []

  const upstream = createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readBody(req) : ''
    seen.push({
      path: req.url ?? '',
      auth: req.headers['authorization'],
      body: body ? JSON.parse(body) : null
    })
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: 'grok-4.6' }] }))
    } else {
      res.end(JSON.stringify({ ok: true, echoedPath: req.url }))
    }
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  const upstreamPort = (upstream.address() as { port: number }).port
  const upstreamBase = `http://127.0.0.1:${upstreamPort}/v1`

  const proxy = await startProxyServer({
    port: 0,
    baseUrl: upstreamBase,
    getCredentials: async () => new ApiKeyCredentials('xai-proxy-key')
  })
  const proxyBase = `http://127.0.0.1:${proxy.port}`

  // /health
  const health = await fetch(`${proxyBase}/health`).then((r) => r.json())
  assert((health as { ok: boolean }).ok === true, 'health should report ok')

  // /v1/models -> upstream /models with auth
  const models = (await fetch(`${proxyBase}/v1/models`).then((r) => r.json())) as {
    data: { id: string }[]
  }
  assert(models.data[0]?.id === 'grok-4.6', 'models passthrough returns upstream data')

  // /v1/responses passthrough
  await fetch(`${proxyBase}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-4.6', input: [{ role: 'user', content: 'hi' }] })
  }).then((r) => r.json())

  // /v1/chat/completions -> translated to /responses (messages -> input)
  await fetch(`${proxyBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-4.6',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' }
      ]
    })
  }).then((r) => r.json())

  // Assertions on what the upstream received.
  const modelsCall = seen.find((s) => s.path.endsWith('/models'))
  assert(modelsCall?.auth === 'Bearer xai-proxy-key', 'auth header injected on models')

  const responsesCalls = seen.filter((s) => s.path.endsWith('/responses'))
  assert(responsesCalls.length === 2, `both POSTs should hit /responses, got ${responsesCalls.length}`)
  for (const c of responsesCalls) {
    assert(c.auth === 'Bearer xai-proxy-key', 'auth header injected on responses')
  }
  const translated = responsesCalls[1]?.body as { input?: unknown[]; messages?: unknown }
  assert(Array.isArray(translated.input), 'chat/completions should be translated to input[]')
  assert(translated.messages === undefined, 'translated body should drop messages')
  assert(
    (translated.input as { role: string }[])[1]?.role === 'user',
    'translated input preserves message roles'
  )

  // Anti-abuse guards: forged Host (DNS rebinding) and browser Origin are 403.
  // fetch/undici won't override Host, so send that probe over raw http.
  const upstreamCallsBefore = seen.length
  const rebindStatus = await new Promise<number>((resolve, reject) => {
    request(
      { host: '127.0.0.1', port: proxy.port, path: '/v1/models', headers: { Host: 'evil.example.com' } },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )
      .on('error', reject)
      .end()
  })
  assert(rebindStatus === 403, `forged Host must be rejected, got ${rebindStatus}`)
  const browser = await fetch(`${proxyBase}/v1/models`, {
    headers: { Origin: 'https://evil.example.com' }
  })
  assert(browser.status === 403, `browser Origin must be rejected, got ${browser.status}`)
  assert(seen.length === upstreamCallsBefore, 'rejected requests must never reach upstream')

  await proxy.close()
  await new Promise<void>((r) => upstream.close(() => r()))
  console.log('smoke-proxy: PASS (upstream calls:', seen.length, ')')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
