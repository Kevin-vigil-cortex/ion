import { shell, BrowserWindow } from 'electron'
import {
  FileTokenStore,
  OAuthCredentials,
  loginWithDeviceFlow,
  type Credentials
} from '@ion/xai'
import type { OAuthProgress, SafeConfig } from '../shared/ipc'
import { IpcEvent } from '../shared/ipc'
import { AUTH_PATH } from './paths'
import type { AuthManager } from './auth'

/**
 * Desktop-side orchestration of the SuperGrok OAuth device flow: opens the
 * verification URL in the system browser, streams progress to the renderer, and
 * exposes credentials + state to the {@link AuthManager}.
 */
export class OAuthManager {
  private readonly store = new FileTokenStore(AUTH_PATH)
  private readonly credentials: OAuthCredentials
  private signedIn = false
  private account: string | null = null
  private tierGated = false
  private activeLogin: AbortController | null = null

  constructor() {
    this.credentials = new OAuthCredentials({
      store: this.store,
      onTierGated: () => {
        this.tierGated = true
      }
    })
  }

  /** Load persisted state on startup. */
  async init(): Promise<void> {
    await this.credentials.reload()
    this.signedIn = await this.credentials.isSignedIn()
    this.account = await this.credentials.currentAccount()
  }

  /** Wire this manager into the shared AuthManager. */
  attach(auth: AuthManager): void {
    auth.oauthCredentialsProvider = (): Credentials | null => (this.signedIn ? this.credentials : null)
    auth.oauthStateProvider = (): SafeConfig['oauth'] => ({
      signedIn: this.signedIn,
      account: this.account,
      tierGated: this.tierGated
    })
  }

  private broadcast(progress: OAuthProgress): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcEvent.OAuthProgress, progress)
    }
  }

  async start(): Promise<void> {
    this.activeLogin?.abort()
    this.activeLogin = new AbortController()
    this.tierGated = false
    this.broadcast({ stage: 'starting' })

    try {
      const tokens = await loginWithDeviceFlow(this.store, {
        signal: this.activeLogin.signal,
        onDeviceCode: (device) => {
          const url = device.verificationUriComplete ?? device.verificationUri
          this.broadcast({
            stage: 'awaiting_authorization',
            verificationUri: url,
            userCode: device.userCode,
            message: 'Approve access in your browser to finish signing in.'
          })
          void shell.openExternal(url)
        },
        onPending: () => this.broadcast({ stage: 'polling' })
      })

      await this.credentials.reload()
      this.signedIn = true
      this.account = tokens.account ?? (await this.credentials.currentAccount())
      this.broadcast({ stage: 'success', message: 'Signed in with SuperGrok.' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.broadcast({ stage: 'error', message })
      throw err
    } finally {
      this.activeLogin = null
    }
  }

  async signOut(): Promise<void> {
    this.activeLogin?.abort()
    await this.store.clear()
    await this.credentials.reload()
    this.signedIn = false
    this.account = null
    this.tierGated = false
  }
}
