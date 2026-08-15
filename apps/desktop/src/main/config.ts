import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import type { ApprovalMode, AuthMode, SafeConfig } from '../shared/ipc'
import { APP_DIR, CONFIG_PATH } from './paths'
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '@ion/xai'

interface StoredConfig {
  authMode: AuthMode
  defaultModel: string
  defaultEffort: string
  apiKey: string | null
  approvalMode: ApprovalMode
  memoryEnabled: boolean
  learningEnabled: boolean
  browserUseEnabled: boolean
  computerUseEnabled: boolean
  baseUrl: string
  proxyPort: number
  /** Workspace roots allowed to start MCP servers from their own .mcp.json. */
  trustedMcpRoots: string[]
}

const DEFAULTS: StoredConfig = {
  authMode: 'oauth',
  defaultModel: DEFAULT_MODEL,
  defaultEffort: 'medium',
  apiKey: null,
  approvalMode: 'ask',
  memoryEnabled: true,
  learningEnabled: true,
  // Embedded browser is sandboxed to the panel: safe to offer by default.
  browserUseEnabled: true,
  // OS-level control is opt-in only.
  computerUseEnabled: false,
  baseUrl: DEFAULT_BASE_URL,
  proxyPort: 8787,
  // A repo's own .mcp.json can run arbitrary commands: off until trusted.
  trustedMcpRoots: []
}

/**
 * Local, file-backed application config. Secrets (the API key) live here on the
 * user's machine only and are never returned raw to the renderer.
 */
export class ConfigStore {
  private data: StoredConfig = { ...DEFAULTS }

  async load(): Promise<void> {
    try {
      const raw = await readFile(CONFIG_PATH, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoredConfig> & { autoApproveAll?: boolean }
      this.data = { ...DEFAULTS, ...parsed }
      // Migrate the pre-permission-modes boolean: "auto-approve all" -> full.
      if (!parsed.approvalMode && parsed.autoApproveAll) this.data.approvalMode = 'full'
      delete (this.data as { autoApproveAll?: boolean }).autoApproveAll
    } catch {
      this.data = { ...DEFAULTS }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(APP_DIR, { recursive: true })
    await writeFile(CONFIG_PATH, JSON.stringify(this.data, null, 2), 'utf8')
    // Config may hold an API key; keep it owner-readable only.
    await chmod(CONFIG_PATH, 0o600).catch(() => {})
  }

  get raw(): Readonly<StoredConfig> {
    return this.data
  }

  getApiKey(): string | null {
    return this.data.apiKey
  }

  async setApiKey(key: string): Promise<void> {
    this.data.apiKey = key.trim() || null
    await this.persist()
  }

  async clearApiKey(): Promise<void> {
    this.data.apiKey = null
    await this.persist()
  }

  async setDefaultModel(model: string): Promise<void> {
    this.data.defaultModel = model
    await this.persist()
  }

  async setDefaultEffort(effort: string): Promise<void> {
    this.data.defaultEffort = effort
    await this.persist()
  }

  async setAuthMode(mode: AuthMode): Promise<void> {
    this.data.authMode = mode
    await this.persist()
  }

  async setApprovalMode(mode: ApprovalMode): Promise<void> {
    this.data.approvalMode = mode
    await this.persist()
  }

  async setMemoryEnabled(value: boolean): Promise<void> {
    this.data.memoryEnabled = value
    await this.persist()
  }

  async setLearningEnabled(value: boolean): Promise<void> {
    this.data.learningEnabled = value
    await this.persist()
  }

  async setBrowserUseEnabled(value: boolean): Promise<void> {
    this.data.browserUseEnabled = value
    await this.persist()
  }

  async setComputerUseEnabled(value: boolean): Promise<void> {
    this.data.computerUseEnabled = value
    await this.persist()
  }

  isMcpTrusted(workspaceRoot: string): boolean {
    return this.data.trustedMcpRoots.includes(workspaceRoot)
  }

  async setMcpTrust(workspaceRoot: string, trusted: boolean): Promise<void> {
    const roots = new Set(this.data.trustedMcpRoots)
    if (trusted) roots.add(workspaceRoot)
    else roots.delete(workspaceRoot)
    this.data.trustedMcpRoots = [...roots]
    await this.persist()
  }

  /** Build the renderer-safe view, merged with live OAuth/proxy status. */
  toSafeConfig(extra: {
    oauth: SafeConfig['oauth']
    proxyEnabled: boolean
    userRules?: string
  }): SafeConfig {
    return {
      authMode: this.data.authMode,
      defaultModel: this.data.defaultModel,
      defaultEffort: this.data.defaultEffort,
      hasApiKey: this.data.apiKey !== null,
      approvalMode: this.data.approvalMode,
      memoryEnabled: this.data.memoryEnabled,
      learningEnabled: this.data.learningEnabled,
      browserUseEnabled: this.data.browserUseEnabled,
      computerUseEnabled: this.data.computerUseEnabled,
      baseUrl: this.data.baseUrl,
      proxy: { enabled: extra.proxyEnabled, port: this.data.proxyPort },
      oauth: extra.oauth,
      userRules: extra.userRules ?? ''
    }
  }
}
