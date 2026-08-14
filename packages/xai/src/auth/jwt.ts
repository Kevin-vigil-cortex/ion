/** Decode a JWT payload without verifying the signature (for exp/email hints only). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Extract the JWT `exp` claim as epoch milliseconds, if present. */
export function jwtExpiryMs(token: string): number | null {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  return typeof exp === 'number' ? exp * 1000 : null
}

/** Best-effort human account label from an id/access token. */
export function accountFromToken(token: string): string | null {
  const payload = decodeJwtPayload(token)
  if (!payload) return null
  const email = payload.email ?? payload.preferred_username ?? payload.sub
  return typeof email === 'string' ? email : null
}
