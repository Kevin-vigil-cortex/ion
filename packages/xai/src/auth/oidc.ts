/**
 * OIDC discovery for the xAI OAuth device flow.
 *
 * The client ID is xAI's public device-flow client (the same value the Hermes
 * agent ships openly); it is an identifier, not a secret. Endpoints are always
 * validated to be HTTPS on the x.ai origin so a poisoned discovery document
 * cannot redirect token traffic elsewhere.
 */
export const XAI_OAUTH_ISSUER = 'https://auth.x.ai'
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access'

export interface OidcEndpoints {
  deviceAuthorizationEndpoint: string
  tokenEndpoint: string
}

/** Reject any endpoint that is not HTTPS on x.ai (or a *.x.ai subdomain). */
export function validateXaiEndpoint(url: string, field: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`xAI OIDC discovery returned an invalid ${field}: ${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`xAI OIDC ${field} must be HTTPS, got: ${url}`)
  }
  const host = parsed.hostname
  if (host !== 'x.ai' && !host.endsWith('.x.ai')) {
    throw new Error(`xAI OIDC ${field} must be on the x.ai origin, got: ${host}`)
  }
  return url
}

export async function discoverOidc(fetchImpl: typeof fetch): Promise<OidcEndpoints> {
  const res = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) {
    throw new Error(`xAI OIDC discovery failed (${res.status}).`)
  }
  const doc = (await res.json()) as {
    device_authorization_endpoint?: string
    token_endpoint?: string
  }

  const deviceEndpoint = doc.device_authorization_endpoint ?? `${XAI_OAUTH_ISSUER}/oauth2/device/code`
  const tokenEndpoint = doc.token_endpoint ?? `${XAI_OAUTH_ISSUER}/oauth2/token`

  return {
    deviceAuthorizationEndpoint: validateXaiEndpoint(deviceEndpoint, 'device_authorization_endpoint'),
    tokenEndpoint: validateXaiEndpoint(tokenEndpoint, 'token_endpoint')
  }
}
