/**
 * Verifies the OAuth device flow against a fully faked xAI auth server:
 * discovery + endpoint validation, device-code login, refresh-token rotation,
 * serialized concurrent refresh, and the 403 tier-gated path. No network.
 */
import {
  MemoryTokenStore,
  OAuthCredentials,
  loginWithDeviceFlow,
  validateXaiEndpoint
} from '@ion/xai'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

// A minimal JWT (header.payload.signature) with an exp ~1h out.
function fakeJwt(email: string, ttlSec = 3600): string {
  const enc = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc({ email, exp: Math.floor(Date.now() / 1000) + ttlSec })}.sig`
}

interface ServerState {
  pollsLeft: number
  currentRefresh: string
  refreshCount: number
  tierGatedRefresh: boolean
}

function makeFakeFetch(state: ServerState): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const json = (obj: unknown, status = 200): Response =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'content-type': 'application/json' }
      })

    if (url.endsWith('/.well-known/openid-configuration')) {
      return json({
        device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
        token_endpoint: 'https://auth.x.ai/oauth2/token'
      })
    }
    if (url.endsWith('/oauth2/device/code')) {
      return json({
        device_code: 'DEV-123',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://x.ai/device',
        verification_uri_complete: 'https://x.ai/device?code=WXYZ-1234',
        expires_in: 600,
        interval: 0
      })
    }
    if (url.endsWith('/oauth2/token')) {
      const body = new URLSearchParams(String(init?.body))
      const grant = body.get('grant_type')
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (state.pollsLeft > 0) {
          state.pollsLeft--
          return json({ error: 'authorization_pending' }, 400)
        }
        return json({
          access_token: fakeJwt('user@x.ai'),
          refresh_token: state.currentRefresh,
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: fakeJwt('user@x.ai')
        })
      }
      if (grant === 'refresh_token') {
        if (state.tierGatedRefresh) return json({ error: 'tier_denied' }, 403)
        const provided = body.get('refresh_token')
        assert(provided === state.currentRefresh, 'refresh must use the latest rotated token')
        state.refreshCount++
        state.currentRefresh = `refresh-${state.refreshCount}`
        return json({
          access_token: fakeJwt('user@x.ai'),
          refresh_token: state.currentRefresh, // rotates every refresh
          token_type: 'Bearer',
          expires_in: 3600
        })
      }
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

async function main(): Promise<void> {
  // Endpoint validation rejects non-x.ai / non-HTTPS.
  let rejected = false
  try {
    validateXaiEndpoint('https://evil.example.com/token', 'token_endpoint')
  } catch {
    rejected = true
  }
  assert(rejected, 'validateXaiEndpoint must reject non-x.ai hosts')
  validateXaiEndpoint('https://auth.x.ai/oauth2/token', 'token_endpoint')

  const state: ServerState = {
    pollsLeft: 2,
    currentRefresh: 'refresh-0',
    refreshCount: 0,
    tierGatedRefresh: false
  }
  const fetchImpl = makeFakeFetch(state)
  const store = new MemoryTokenStore()

  // Device-code login.
  let sawCode = false
  const tokens = await loginWithDeviceFlow(
    store,
    {
      onDeviceCode: (d) => {
        sawCode = d.userCode === 'WXYZ-1234'
      }
    },
    { fetchImpl }
  )
  assert(sawCode, 'login should surface the user code')
  assert(tokens.account === 'user@x.ai', 'account parsed from id_token')
  assert((await store.read())?.refreshToken === 'refresh-0', 'initial refresh token stored')

  // Build credentials; force refresh via a tiny skew so it rotates.
  const creds = new OAuthCredentials({
    store,
    fetchImpl,
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    refreshSkewMs: 999_999_999 // treat as always-expiring to force refresh
  })

  // Concurrent header requests should trigger exactly one refresh (serialized).
  const [h1, h2] = await Promise.all([creds.authorizationHeader(), creds.authorizationHeader()])
  assert(h1.startsWith('Bearer '), 'header carries bearer token')
  assert(h2.startsWith('Bearer '), 'header carries bearer token')
  assert(
    state.refreshCount === 1,
    `concurrent refresh should be serialized to 1, got ${state.refreshCount}`
  )
  assert(
    (await store.read())?.refreshToken === 'refresh-1',
    'rotated refresh token persisted after refresh'
  )

  // Tier-gated 403 surfaces a clear error and does not loop.
  state.tierGatedRefresh = true
  let tierGatedSeen = false
  const gatedCreds = new OAuthCredentials({
    store,
    fetchImpl,
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    refreshSkewMs: 999_999_999,
    onTierGated: () => {
      tierGatedSeen = true
    }
  })
  let threw = false
  try {
    await gatedCreds.authorizationHeader()
  } catch (err) {
    threw = err instanceof Error && err.message.includes('403')
  }
  assert(threw, 'tier-gated refresh should throw a 403 error')
  assert(tierGatedSeen, 'onTierGated callback should fire on 403')

  console.log('smoke-oauth: PASS (refreshes:', state.refreshCount, ')')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
