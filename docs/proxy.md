# Local OpenAI-compatible proxy

The proxy lets any OpenAI-style client use your Ion credentials —
especially useful for the SuperGrok OAuth path, where the client would otherwise
need to manage rotating tokens. It is **optional and off by default**.

It binds to loopback only (`127.0.0.1`), so it is never exposed off your machine.

## Security model

The proxy injects **your** credentials into every upstream call, so it guards
who can reach it: requests are rejected unless the `Host` header is localhost
(defeats DNS-rebinding, where a website resolves its own domain to `127.0.0.1`
to reach local servers from your browser), and any request carrying an
`Origin` header (i.e. sent by a browser) is rejected outright. Request bodies
are capped at 25 MB.

What it can't protect against: while the proxy is enabled, **any process on
your machine** can call it and spend your quota. Leave it off unless you're
using it, and treat enabling it as trusting everything running locally.

## Running it

### From the app
**Settings -> Local proxy -> OpenAI-compatible proxy** toggle. The status line
shows the URL (`http://127.0.0.1:8787` by default).

### Headless
```bash
# Uses XAI_API_KEY if present, otherwise your saved SuperGrok OAuth tokens.
npm run proxy

# Options via env:
PORT=8790 npm run proxy
XAI_API_KEY=xai-... npm run proxy
XAI_BASE_URL=https://api.x.ai/v1 npm run proxy
```

## Routes

| Method + path | Upstream | Notes |
|---|---|---|
| `GET /health` | — | Liveness + configured upstream |
| `GET /v1/models` | `GET /models` | Passthrough with bearer injected |
| `POST /v1/responses` | `POST /responses` | Passthrough (streaming preserved) |
| `POST /v1/chat/completions` | `POST /responses` | Translated: `messages` -> `input` |

The proxy injects `Authorization: Bearer <token>` on every upstream request and
refreshes OAuth tokens on demand. Your client can send any placeholder key (or
none); the real credential is added server-side.

## Examples

```bash
# List models
curl http://127.0.0.1:8787/v1/models

# Chat Completions shape (translated to the Responses API upstream)
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"grok-4.6","messages":[{"role":"user","content":"hello"}]}'
```

Point an OpenAI SDK at it by setting the base URL to `http://127.0.0.1:8787/v1`.

## Translation notes

`/v1/chat/completions` is best-effort translated to a Responses request: `messages`
become `input`, and array/multipart message content is flattened to text. For full
fidelity (tools, streaming events, reasoning), prefer `/v1/responses` directly.
