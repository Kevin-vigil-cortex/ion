import { XaiError } from '../errors'

export interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  interval: number
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type?: string
  expires_in?: number
  scope?: string
  id_token?: string
}

interface RawDeviceCode {
  device_code: string
  user_code: string
  verification_uri?: string
  verification_url?: string
  verification_uri_complete?: string
  expires_in: number
  interval?: number
}

/** Step 1: request a device + user code from the authorization endpoint. */
export async function requestDeviceCode(params: {
  endpoint: string
  clientId: string
  scope: string
  fetchImpl: typeof fetch
}): Promise<DeviceCodeResponse> {
  const res = await params.fetchImpl(params.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: params.clientId, scope: params.scope }).toString()
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new XaiError(`Device authorization request failed (${res.status}): ${text}`, res.status, text)
  }
  const raw = (await res.json()) as RawDeviceCode
  const verificationUri = raw.verification_uri ?? raw.verification_url ?? ''
  return {
    deviceCode: raw.device_code,
    userCode: raw.user_code,
    verificationUri,
    verificationUriComplete: raw.verification_uri_complete,
    expiresIn: raw.expires_in,
    interval: raw.interval ?? 5
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Step 2: poll the token endpoint until the user approves, the code expires, or
 * access is denied. Honors `authorization_pending` and `slow_down` per RFC 8628.
 */
export async function pollForTokens(params: {
  tokenEndpoint: string
  clientId: string
  device: DeviceCodeResponse
  fetchImpl: typeof fetch
  signal?: AbortSignal
  onPending?: () => void
}): Promise<TokenResponse> {
  let intervalMs = params.device.interval * 1000
  const deadline = Date.now() + params.device.expiresIn * 1000

  for (;;) {
    if (params.signal?.aborted) throw new Error('Sign-in was cancelled.')
    if (Date.now() > deadline) throw new Error('The device code expired before approval. Try again.')

    await sleep(intervalMs)

    const res = await params.fetchImpl(params.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: params.device.deviceCode,
        client_id: params.clientId
      }).toString()
    })

    if (res.ok) {
      return (await res.json()) as TokenResponse
    }

    const body = (await res.json().catch(() => ({}))) as { error?: string }
    switch (body.error) {
      case 'authorization_pending':
        params.onPending?.()
        continue
      case 'slow_down':
        intervalMs += 5000
        continue
      case 'access_denied':
        throw new Error('Access was denied in the browser.')
      case 'expired_token':
        throw new Error('The device code expired before approval. Try again.')
      default:
        throw new XaiError(
          `Token polling failed (${res.status}): ${body.error ?? 'unknown error'}`,
          res.status,
          JSON.stringify(body)
        )
    }
  }
}
