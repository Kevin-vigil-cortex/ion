// Minimal fake xAI upstream for local curl verification of the proxy.
import { createServer } from 'node:http'

const port = Number(process.env.FAKE_PORT ?? 8799)

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const auth = req.headers['authorization'] ?? '(none)'
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/models')) {
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'grok-4.6' }, { id: 'grok-4.5' }] }))
    } else {
      res.end(
        JSON.stringify({
          upstream_saw: { path: req.url, authorization: auth, body: body ? JSON.parse(body) : null }
        })
      )
    }
  })
})

server.listen(port, '127.0.0.1', () => console.log(`fake-upstream listening on ${port}`))
