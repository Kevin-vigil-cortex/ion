import type { Credentials } from '@ion/xai'
import { ApiKeyCredentials } from '@ion/xai'
import type { SafeConfig } from '../shared/ipc'
import type { ConfigStore } from './config'

/**
 * Produces {@link Credentials} for the active auth mode. The OAuth path is
 * layered in on top of this by `oauth.ts`; here we cover the API-key mode and
 * expose a hook the OAuth manager fills in.
 */
export class AuthManager {
  /** Set by the OAuth manager once wired; returns null when not signed in. */
  oauthCredentialsProvider: (() => Credentials | null) | null = null
  oauthStateProvider: (() => SafeConfig['oauth']) | null = null

  constructor(private readonly config: ConfigStore) {}

  async credentials(): Promise<Credentials> {
    if (this.config.raw.authMode === 'oauth') {
      const creds = this.oauthCredentialsProvider?.() ?? null
      if (!creds) {
        throw new Error(
          'Not signed in with SuperGrok. Open Settings and sign in, or switch to API key mode.'
        )
      }
      return creds
    }
    const key = this.config.getApiKey()
    if (!key) {
      throw new Error('No xAI API key set. Add one in Settings, or switch to SuperGrok OAuth.')
    }
    return new ApiKeyCredentials(key)
  }

  oauthState(): SafeConfig['oauth'] {
    return this.oauthStateProvider?.() ?? { signedIn: false, account: null, tierGated: false }
  }
}
