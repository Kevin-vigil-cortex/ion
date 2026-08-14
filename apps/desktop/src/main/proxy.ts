import type { ProxyStatus } from '../shared/ipc'
import type { AuthManager } from './auth'
import type { ConfigStore } from './config'

/**
 * Thin lifecycle wrapper around the optional local proxy. The proxy server
 * itself lives in `@ion/proxy`; this manages start/stop from the app.
 */
export class ProxyManager {
  private server: { close: () => Promise<void>; port: number } | null = null

  constructor(
    private readonly config: ConfigStore,
    private readonly auth: AuthManager
  ) {}

  status(): ProxyStatus {
    const running = this.server !== null
    const port = this.server?.port ?? this.config.raw.proxyPort
    return { running, port, url: running ? `http://127.0.0.1:${port}` : null }
  }

  async start(): Promise<ProxyStatus> {
    if (this.server) return this.status()
    const { startProxyServer } = await import('@ion/proxy')
    const port = this.config.raw.proxyPort
    this.server = await startProxyServer({
      port,
      baseUrl: this.config.raw.baseUrl,
      getCredentials: () => this.auth.credentials()
    })
    return this.status()
  }

  async stop(): Promise<ProxyStatus> {
    if (this.server) {
      await this.server.close()
      this.server = null
    }
    return this.status()
  }
}
