import type { Credentials } from './types'
import type { StoredTokens, TokenStore } from './tokenStore'
import { XaiError } from '../errors'
import { discoverOidc, XAI_OAUTH_CLIENT_ID, XAI_OAUTH_SCOPE } from './oidc'
import { requestDeviceCode, pollForTokens, type DeviceCodeResponse, type TokenResponse } from './deviceFlow'
import { jwtExpiryMs, accountFromToken } from './jwt'

const DEFAULT_REFRESH_SKEW_MS = 120_000

function tokensFromResponse(res: TokenResponse, previous?: StoredTokens | null): StoredTokens {
  const now = Date.now()
  const expiresInMs = (res.expires_in ?? 3600) * 1000
  const jwtExp = jwtExpiryMs(res.access_token)
  const expiresAt = jwtExp ?? now + expiresInMs
  return {
    accessToken: res.access_token,
    // xAI rotates the refresh token on every refresh; fall back to the prior
    // one only if the server omitted a new value.
    refreshToken: res.refresh_token ?? previous?.refreshToken ?? '',
    tokenType: res.token_type ?? 'Bearer',
    expiresAt,
    scope: res.scope ?? previous?.scope ?? XAI_OAUTH_SCOPE,
    idToken: res.id_token ?? previous?.idToken,
    account:
      (res.id_token && accountFromToken(res.id_token)) ||
      accountFromToken(res.access_token) ||
      previous?.account ||
      null
  }
}

export interface OAuthCredentialsOptions {
  store: TokenStore
  clientId?: string
  fetchImpl?: typeof fetch
  /** Provide to skip discovery; otherwise discovered lazily and cached. */
  tokenEndpoint?: string
  refreshSkewMs?: number
  /** Called when a refresh returns 403 (tier-gated). */
  onTierGated?: () => void
}

/**
 * OAuth credentials backed by a {@link TokenStore}. Refreshes are serialized so
 * concurrent requests can't race on the single-use, rotating refresh token, and
 * the rotated pair is persisted atomically before the access token is returned.
 */
export class OAuthCredentials implements Credentials {
  readonly kind = 'oauth' as const
  private readonly store: TokenStore
  private readonly clientId: string
  private readonly fetchImpl: typeof fetch
  private readonly refreshSkewMs: number
  private readonly onTierGated?: () => void

  private tokens: StoredTokens | null = null
  private loaded = false
  private tokenEndpoint: string | null
  private pendingRefresh: Promise<void> | null = null

  constructor(opts: OAuthCredentialsOptions) {
    this.store = opts.store
    this.clientId = opts.clientId ?? XAI_OAUTH_CLIENT_ID
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS
    this.tokenEndpoint = opts.tokenEndpoint ?? null
    this.onTierGated = opts.onTierGated
  }

  private async load(): Promise<StoredTokens | null> {
    if (!this.loaded) {
      this.tokens = await this.store.read()
      this.loaded = true
    }
    return this.tokens
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.load()) !== null
  }

  async currentAccount(): Promise<string | null> {
    return (await this.load())?.account ?? null
  }

  async authorizationHeader(): Promise<string> {
    let tokens = await this.load()
    if (!tokens) throw new Error('Not signed in with SuperGrok.')
    if (Date.now() >= tokens.expiresAt - this.refreshSkewMs) {
      await this.refresh()
      tokens = this.tokens!
    }
    return `${tokens.tokenType} ${tokens.accessToken}`
  }

  async handleUnauthorized(): Promise<boolean> {
    try {
      await this.refresh()
      return true
    } catch {
      return false
    }
  }

  /**
   * Collapse concurrent refreshes into one in-flight operation so overlapping
   * requests can't each spend the single-use, rotating refresh token.
   */
  private refresh(): Promise<void> {
    if (this.pendingRefresh) return this.pendingRefresh
    const p = this.doRefresh().finally(() => {
      if (this.pendingRefresh === p) this.pendingRefresh = null
    })
    this.pendingRefresh = p
    return p
  }

  private async resolveTokenEndpoint(): Promise<string> {
    if (this.tokenEndpoint) return this.tokenEndpoint
    const endpoints = await discoverOidc(this.fetchImpl)
    this.tokenEndpoint = endpoints.tokenEndpoint
    return this.tokenEndpoint
  }

  private async doRefresh(): Promise<void> {
    const current = this.tokens ?? (await this.store.read())
    if (!current?.refreshToken) throw new Error('No refresh token available; sign in again.')

    const endpoint = await this.resolveTokenEndpoint()
    const res = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: this.clientId
      }).toString()
    })

    if (res.status === 403) {
      this.onTierGated?.()
      const text = await res.text().catch(() => '')
      throw new XaiError(
        'xAI denied OAuth access for this account (403). Your subscription tier may not be on the API allowlist — use an API key instead.',
        403,
        text
      )
    }
    if (res.status === 400 || res.status === 401) {
      // Refresh token is invalid/expired — force a fresh sign-in.
      await this.store.clear()
      this.tokens = null
      this.loaded = true
      throw new XaiError('Your SuperGrok session expired. Please sign in again.', res.status)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new XaiError(`Token refresh failed (${res.status}).`, res.status, text)
    }

    const updated = tokensFromResponse((await res.json()) as TokenResponse, current)
    await this.store.write(updated)
    this.tokens = updated
    this.loaded = true
  }

  /** Drop the in-memory cache after an external sign-in/out. */
  async reload(): Promise<void> {
    this.loaded = false
    await this.load()
  }
}

export interface LoginCallbacks {
  onDeviceCode: (device: DeviceCodeResponse) => void
  onPending?: () => void
  signal?: AbortSignal
}

/**
 * Run the full device-code login and persist the resulting tokens. Returns the
 * stored token set (including the resolved account label).
 */
export async function loginWithDeviceFlow(
  store: TokenStore,
  callbacks: LoginCallbacks,
  options?: { clientId?: string; fetchImpl?: typeof fetch }
): Promise<StoredTokens> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch
  const clientId = options?.clientId ?? XAI_OAUTH_CLIENT_ID

  const endpoints = await discoverOidc(fetchImpl)
  const device = await requestDeviceCode({
    endpoint: endpoints.deviceAuthorizationEndpoint,
    clientId,
    scope: XAI_OAUTH_SCOPE,
    fetchImpl
  })
  callbacks.onDeviceCode(device)

  const tokenResponse = await pollForTokens({
    tokenEndpoint: endpoints.tokenEndpoint,
    clientId,
    device,
    fetchImpl,
    signal: callbacks.signal,
    onPending: callbacks.onPending
  })

  const tokens = tokensFromResponse(tokenResponse)
  await store.write(tokens)
  return tokens
}
