import { BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AgentSession,
  SessionStore,
  MemoryStore,
  defaultTools,
  createBrowserTools,
  createComputerTools,
  restoreSessionCheckpoint,
  commitPaths,
  formatGitDiff,
  discoverSkills,
  expandActiveSkills,
  loadMcpConfig,
  startMcpHub,
  type McpHub,
  type Tool,
  type Session,
  type SessionMeta,
  type AgentEvent,
  type ModelInfo
} from '@ion/agent'
import {
  XaiModelClient,
  FALLBACK_MODELS,
  getModelMetadata,
  withModelMetadata,
  selectableModels,
  type ReasoningEffort
} from '@ion/xai'
import type {
  ApprovalDecision,
  ApprovalMode,
  ChatAttachmentPayload,
  LifetimeUsage,
  SessionMode,
  WorkspaceMention,
  SkillInfo,
  McpServerInfo
} from '../shared/ipc'
import { deleteSessionAttachments, ingestAttachments } from './attachments'
import { expandWorkspaceMentions } from './workspace-fs'
import { IpcEvent } from '../shared/ipc'
import type { ConfigStore } from './config'
import type { AuthManager } from './auth'
import { SESSIONS_DIR, MEMORY_DIR } from './paths'
import { readUserRules } from './user-rules'
import { UsageStatsStore } from './stats'
import { BrowserBridge } from './browser'
import { MacComputerDriver } from './computer'

/**
 * Codex-style permission modes mapped onto the loop's per-tool auto-approve
 * hook. In 'auto', workspace-confined edits skip the prompt but the unbounded
 * surfaces — arbitrary shell, OS control — and save_memory (persistent
 * prompt-injection vector) still ask.
 */
function approvalPredicate(mode: ApprovalMode): (tool: Tool) => boolean {
  if (mode === 'full') return () => true
  if (mode === 'ask') return () => false
  return (tool) =>
    tool.name !== 'run_terminal' &&
    tool.name !== 'git_commit' &&
    tool.name !== 'save_memory' &&
    // Ships the workspace diff to CodeRabbit's service — always ask first.
    tool.name !== 'code_review' &&
    !tool.name.startsWith('computer_') &&
    !tool.name.startsWith('mcp_')
}

/**
 * Owns live agent instances and bridges them to the renderer: events flow out
 * over IPC, approval decisions flow back in.
 */
export class AgentRuntime {
  private readonly store = new SessionStore(SESSIONS_DIR)
  private readonly memory = new MemoryStore(MEMORY_DIR)
  private readonly usageStats = new UsageStatsStore()
  private readonly agents = new Map<string, AgentSession>()
  private readonly pendingApprovals = new Map<string, (d: ApprovalDecision) => void>()
  /** Drives the embedded browser panel on the agent's behalf. */
  private readonly browser = new BrowserBridge()
  /** OS-level mouse/keyboard/screen control (macOS driver). */
  private readonly computer = new MacComputerDriver()
  /** Live MCP connections, keyed by workspace root ('' if none). */
  private readonly mcpHubs = new Map<string, McpHub>()
  private readonly mcpInflight = new Map<string, Promise<McpHub>>()
  /** Bumped on reload/close so a stale connect cannot overwrite the live hub. */
  private readonly mcpGen = new Map<string, number>()
  /** Agents that must be rebuilt on the next send (late MCP connect, etc.). */
  private readonly staleAgents = new Set<string>()

  constructor(
    private readonly config: ConfigStore,
    private readonly auth: AuthManager
  ) {
    this.browser.init()
  }

  get sessions(): SessionStore {
    return this.store
  }

  /** Durable learned-memory store (self-learning), shared with the Memories UI. */
  get memories(): MemoryStore {
    return this.memory
  }

  /**
   * Rebuild agents so the next send picks up new auth/transport config.
   * Running agents finish their turn first (marked stale, rebuilt when idle):
   * dropping one mid-turn would let a concurrent send spawn a duplicate
   * AgentSession for the same session id.
   */
  invalidateAgents(): void {
    this.invalidateIdleAgents()
  }

  async listSessions(): Promise<SessionMeta[]> {
    return this.store.list()
  }

  async getSession(id: string): Promise<Session | null> {
    return this.store.load(id)
  }

  async createSession(params: {
    workspaceRoot: string | null
    model?: string
    mode?: SessionMode
    reasoningEffort?: string
  }): Promise<Session> {
    return this.store.create({
      workspaceRoot: params.workspaceRoot,
      model: params.model ?? this.config.raw.defaultModel,
      reasoningEffort: params.reasoningEffort ?? this.config.raw.defaultEffort,
      ...(params.mode === 'plan' ? { mode: 'plan' } : {})
    })
  }

  async deleteSession(id: string): Promise<void> {
    // Stop any in-flight turn (and release its pending approvals) before the
    // session data disappears underneath it.
    this.abort(id)
    this.agents.delete(id)
    this.staleAgents.delete(id)
    await this.store.delete(id)
    await deleteSessionAttachments(id)
  }

  async setSessionWorkspace(id: string, workspaceRoot: string | null): Promise<Session | null> {
    const session = await this.store.load(id)
    if (!session) return null
    session.workspaceRoot = workspaceRoot
    await this.store.save(session)
    // The cached agent holds the old session object; rebuild on next send.
    this.agents.delete(id)
    return session
  }

  async setSessionModel(id: string, model: string): Promise<Session | null> {
    const session = await this.store.load(id)
    if (!session) return null
    session.model = model
    await this.store.save(session)
    this.agents.delete(id)
    return session
  }

  async setSessionEffort(id: string, effort: string): Promise<Session | null> {
    const session = await this.store.load(id)
    if (!session) return null
    session.reasoningEffort = effort
    await this.store.save(session)
    // The cached agent's client was built with the old effort; rebuild.
    this.agents.delete(id)
    return session
  }

  async setSessionMode(id: string, mode: SessionMode): Promise<Session | null> {
    const session = await this.store.load(id)
    if (!session) return null
    session.mode = mode
    await this.store.save(session)
    // The cached agent was built with the old mode's tool set; rebuild.
    this.agents.delete(id)
    return session
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const credentials = await this.auth.credentials()
      const client = new XaiModelClient({ credentials, baseUrl: this.config.raw.baseUrl })
      // The app offers only the reasoning flagships (grok-4.6 / grok-4.5).
      return withModelMetadata(selectableModels(await client.listModels()))
    } catch {
      // No auth configured yet, or the network is unavailable.
      return withModelMetadata(FALLBACK_MODELS)
    }
  }

  /** Lifetime usage totals shown in the Context Usage panel. */
  async getUsageStats(): Promise<LifetimeUsage> {
    return this.usageStats.get()
  }

  async listMcp(workspaceRoot: string | null): Promise<McpServerInfo[]> {
    const live = this.mcpHubs.get(mcpKey(workspaceRoot))
    if (live) return live.status
    const specs = await loadMcpConfig(workspaceRoot, {
      trustProject: this.mcpTrusted(workspaceRoot)
    })
    return specs.map((s) => ({
      name: s.name,
      source: s.source,
      status: s.blocked ? 'blocked' : s.disabled ? 'skipped' : 'idle',
      transport: s.command ? 'stdio' : 'http',
      toolCount: 0,
      ...(s.blocked
        ? { error: 'workspace not trusted' }
        : s.disabled
          ? { error: 'disabled' }
          : {})
    }))
  }

  /** Only trusted workspaces may start servers from their own .mcp.json. */
  private mcpTrusted(workspaceRoot: string | null): boolean {
    return workspaceRoot !== null && this.config.isMcpTrusted(workspaceRoot)
  }

  /** Trust (or untrust) a workspace's project mcp.json, then reconnect. */
  async setMcpTrust(workspaceRoot: string, trusted: boolean): Promise<McpServerInfo[]> {
    await this.config.setMcpTrust(workspaceRoot, trusted)
    return this.reloadMcp(workspaceRoot)
  }

  async reloadMcp(workspaceRoot: string | null): Promise<McpServerInfo[]> {
    const hub = await this.ensureMcp(workspaceRoot, true)
    this.invalidateAgents()
    return hub.status
  }

  async closeMcp(): Promise<void> {
    for (const key of new Set([...this.mcpHubs.keys(), ...this.mcpInflight.keys()])) {
      this.mcpGen.set(key, (this.mcpGen.get(key) ?? 0) + 1)
    }
    const hubs = [...this.mcpHubs.values()]
    this.mcpHubs.clear()
    this.mcpInflight.clear()
    await Promise.all(hubs.map((h) => h.close().catch(() => undefined)))
  }

  private async ensureMcp(workspaceRoot: string | null, reconnect = false): Promise<McpHub> {
    const key = mcpKey(workspaceRoot)
    if (reconnect) {
      this.mcpGen.set(key, (this.mcpGen.get(key) ?? 0) + 1)
      const old = this.mcpHubs.get(key)
      this.mcpHubs.delete(key)
      this.mcpInflight.delete(key)
      await old?.close().catch(() => undefined)
    }
    const cached = this.mcpHubs.get(key)
    if (cached) return cached
    const inflight = this.mcpInflight.get(key)
    if (inflight) return inflight
    const gen = this.mcpGen.get(key) ?? 0
    let pending!: Promise<McpHub>
    pending = startMcpHub(workspaceRoot, { trustProject: this.mcpTrusted(workspaceRoot) }).then(
      (hub) => {
        if ((this.mcpGen.get(key) ?? 0) !== gen) {
          // A reload/close superseded this connect: shut the orphan down and
          // fail, so no caller ever holds a closed hub.
          void hub.close().catch(() => undefined)
          if (this.mcpInflight.get(key) === pending) this.mcpInflight.delete(key)
          throw new Error('MCP connection superseded by a reload.')
        }
        this.mcpHubs.set(key, hub)
        if (this.mcpInflight.get(key) === pending) this.mcpInflight.delete(key)
        return hub
      },
      (err: unknown) => {
        if (this.mcpInflight.get(key) === pending) this.mcpInflight.delete(key)
        throw err
      }
    )
    this.mcpInflight.set(key, pending)
    return pending
  }

  /**
   * ensureMcp with a hard budget so a hung MCP server (e.g. one waiting on an
   * editor that isn't running) can never stall a chat send. Past the budget
   * the send proceeds without MCP tools; when the connect eventually lands,
   * idle agents are dropped so the next message picks the tools up.
   */
  private async ensureMcpBudgeted(workspaceRoot: string | null): Promise<McpHub | null> {
    const pending = this.ensureMcp(workspaceRoot)
    const winner = await Promise.race([
      pending.catch(() => null),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), MCP_CONNECT_BUDGET_MS))
    ])
    if (winner !== 'timeout') return winner
    void pending.then(
      () => this.invalidateIdleAgents(),
      () => undefined
    )
    return null
  }

  /**
   * Drop idle agents immediately. Running ones keep this turn's toolset, but
   * are marked stale so the next send rebuilds (picks up late MCP tools).
   */
  private invalidateIdleAgents(): void {
    for (const [id, agent] of this.agents) {
      if (!agent.isRunning()) {
        this.agents.delete(id)
        this.staleAgents.delete(id)
      } else {
        this.staleAgents.add(id)
      }
    }
  }

  async listSkills(workspaceRoot: string | null): Promise<SkillInfo[]> {
    const skills = await discoverSkills(workspaceRoot)
    return skills.map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source
    }))
  }

  async send(
    sessionId: string,
    text: string,
    incoming?: ChatAttachmentPayload[],
    mentions?: WorkspaceMention[],
    skills?: string[]
  ): Promise<void> {
    const agent = await this.getOrCreateAgent(sessionId)
    const expanded = await this.withContext(
      agent.getSession().workspaceRoot,
      text,
      mentions,
      skills
    )
    if (!incoming?.length) {
      await agent.send(expanded)
      return
    }
    let attachments
    try {
      attachments = await ingestAttachments(sessionId, incoming)
    } catch (err) {
      this.broadcast(sessionId, {
        type: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
      return
    }
    await agent.send(expanded, attachments)
  }

  /**
   * Inject into the live turn. If nothing is running, start a normal send
   * so Cmd+Enter never silently drops.
   */
  async steer(
    sessionId: string,
    text: string,
    incoming?: ChatAttachmentPayload[],
    mentions?: WorkspaceMention[],
    skills?: string[]
  ): Promise<void> {
    const live = this.agents.get(sessionId)
    if (!live?.isRunning()) {
      await this.send(sessionId, text, incoming, mentions, skills)
      return
    }
    const expanded = await this.withContext(
      live.getSession().workspaceRoot,
      text,
      mentions,
      skills
    )
    if (!incoming?.length) {
      await live.steer(expanded)
      return
    }
    try {
      await live.steer(expanded, await ingestAttachments(sessionId, incoming))
    } catch (err) {
      this.broadcast(sessionId, {
        type: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private async withContext(
    workspaceRoot: string | null,
    text: string,
    mentions?: WorkspaceMention[],
    skills?: string[]
  ): Promise<string> {
    const parts: string[] = []
    if (text.trim()) parts.push(text)
    if (skills?.length) {
      const block = await expandActiveSkills(skills, workspaceRoot)
      if (block) parts.push(block)
    }
    if (workspaceRoot && mentions?.length) {
      const block = await expandWorkspaceMentions(workspaceRoot, mentions)
      if (block) parts.push(block)
    }
    return parts.join('\n\n')
  }

  abort(sessionId: string): void {
    this.agents.get(sessionId)?.abort()
    // Unblock any approval the loop is waiting on.
    for (const [key, resolve] of this.pendingApprovals) {
      if (key.startsWith(`${sessionId}:`)) {
        resolve('deny')
        this.pendingApprovals.delete(key)
      }
    }
  }

  async restoreCheckpoint(
    sessionId: string,
    checkpointId: string,
    path?: string
  ): Promise<string[]> {
    const live = this.agents.get(sessionId)
    if (live) return live.restoreCheckpoint(checkpointId, path)
    const session = await this.store.load(sessionId)
    if (!session) throw new Error('Session not found.')
    const restored = await restoreSessionCheckpoint(session, checkpointId, path)
    await this.store.save(session)
    this.broadcast(sessionId, { type: 'checkpoint_restored', checkpointId, paths: restored })
    return restored
  }

  async gitCommit(workspaceRoot: string, message: string, paths: string[]): Promise<string> {
    const result = await commitPaths(workspaceRoot, message, paths)
    if (!result.ok) throw new Error(result.output)
    return result.output
  }

  async suggestCommitMessage(sessionId: string, workspaceRoot: string): Promise<string> {
    const session = await this.store.load(sessionId)
    const lastCp = session
      ? [...session.items].reverse().find((i) => i.kind === 'checkpoint')
      : undefined
    const files =
      lastCp && lastCp.kind === 'checkpoint' ? lastCp.files.map((f) => f.path) : []
    const fallback =
      files.length === 1 ? `chore: update ${files[0]}` : `chore: update ${files.length || 'changed'} files`
    const diff =
      lastCp && lastCp.kind === 'checkpoint'
        ? lastCp.files.map((f) => f.diff).join('\n\n')
        : await formatGitDiff(workspaceRoot)

    try {
      const credentials = await this.auth.credentials()
      const client = new XaiModelClient({
        credentials,
        baseUrl: this.config.raw.baseUrl,
        reasoningEffort: 'low'
      })
      let text = ''
      for await (const ev of client.stream({
        model: session?.model ?? this.config.raw.defaultModel,
        items: [
          {
            kind: 'message',
            role: 'system',
            content:
              'Write a conventional commit message for this diff. One subject line ≤72 chars, optional body. No fences, no commentary, no quotes.'
          },
          { kind: 'message', role: 'user', content: diff.slice(0, 12_000) || '(no diff)' }
        ],
        tools: []
      })) {
        if (ev.type === 'text_delta') text += ev.text
      }
      const clean = text
        .trim()
        .replace(/^```[a-z]*\n?|\n?```$/g, '')
        .trim()
      return clean || fallback
    } catch {
      return fallback
    }
  }

  approve(sessionId: string, callId: string, decision: ApprovalDecision): void {
    const key = `${sessionId}:${callId}`
    const resolve = this.pendingApprovals.get(key)
    if (resolve) {
      this.pendingApprovals.delete(key)
      resolve(decision)
    }
  }

  /**
   * App-level tool letting the agent open a folder as this chat's workspace
   * (e.g. after locating it with find_path). Approval-gated because it grants
   * the file/terminal tools access to that folder. It mutates the SAME
   * session object the live AgentSession holds, so the loop's next iteration
   * offers the workspace tools immediately — no new message needed.
   */
  private createOpenWorkspaceTool(sessionId: string, session: Session): Tool {
    return {
      name: 'open_workspace',
      description:
        'Open a folder as this chat\'s workspace. The file, search, and terminal tools ' +
        'unlock immediately after. Use find_path first if you need to locate the folder. ' +
        'Pass an absolute path (~ is allowed).',
      dangerous: true,
      requiresWorkspace: false,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the folder to open.' }
        },
        required: ['path'],
        additionalProperties: false
      },
      summarize: (args) => `open workspace ${String(args.path ?? '')}`,
      execute: async (args) => {
        const raw = typeof args.path === 'string' ? args.path.trim() : ''
        if (!raw) return { output: 'path must be a non-empty string.', isError: true }
        const expanded =
          raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw

        let real: string
        try {
          real = await fs.realpath(expanded)
        } catch {
          return {
            output: `Folder not found: ${raw}. Use find_path to locate the correct folder, then retry with the absolute path.`,
            isError: true
          }
        }
        const stat = await fs.stat(real)
        if (!stat.isDirectory()) {
          return { output: `Not a folder: ${raw}`, isError: true }
        }

        session.workspaceRoot = real
        await this.store.save(session)
        this.broadcast(sessionId, { type: 'workspace_changed', workspaceRoot: real })
        return {
          output: `Workspace opened: ${real}. File, search, and terminal tools are now available.`
        }
      }
    }
  }

  private broadcast(sessionId: string, event: AgentEvent): void {
    if (event.type === 'usage') {
      void this.usageStats.add({
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        costUsd: event.costUsd ?? 0
      })
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcEvent.AgentEvent, { sessionId, event })
    }
  }

  private async getOrCreateAgent(sessionId: string): Promise<AgentSession> {
    const cached = this.agents.get(sessionId)
    if (cached) {
      if (!this.staleAgents.has(sessionId) || cached.isRunning()) return cached
      this.agents.delete(sessionId)
      this.staleAgents.delete(sessionId)
    }

    const session = await this.store.load(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found.`)

    const credentials = await this.auth.credentials()
    const model = new XaiModelClient({
      credentials,
      baseUrl: this.config.raw.baseUrl,
      reasoningEffort: (session.reasoningEffort ??
        this.config.raw.defaultEffort) as ReasoningEffort
    })

    // Workspace tools always; browser/computer tools per config toggles.
    const tools: Tool[] = [...defaultTools, this.createOpenWorkspaceTool(sessionId, session)]
    if (this.config.raw.browserUseEnabled) tools.push(...createBrowserTools(this.browser))
    if (this.config.raw.computerUseEnabled && process.platform === 'darwin') {
      tools.push(...createComputerTools(this.computer))
    }
    const mcp = await this.ensureMcpBudgeted(session.workspaceRoot)
    if (mcp) tools.push(...mcp.tools)

    const userRules = (await readUserRules()).trim() || null
    const agent = new AgentSession({
      model,
      store: this.store,
      session,
      tools,
      autoApprove: approvalPredicate(this.config.raw.approvalMode),
      planMode: session.mode === 'plan',
      memoryEnabled: this.config.raw.memoryEnabled,
      learningEnabled: this.config.raw.learningEnabled,
      memoryStore: this.memory,
      userRules,
      // Cost accounting only applies to API-key billing; OAuth tokens come
      // from the SuperGrok subscription pool.
      pricing:
        this.config.raw.authMode === 'api_key'
          ? getModelMetadata(session.model).pricing
          : undefined,
      onEvent: (event) => this.broadcast(sessionId, event),
      requestApproval: (req) =>
        new Promise<ApprovalDecision>((resolve) => {
          this.pendingApprovals.set(`${sessionId}:${req.callId}`, resolve)
        })
    })

    this.agents.set(sessionId, agent)
    return agent
  }
}

/** How long a chat send waits for MCP servers before starting without them. */
const MCP_CONNECT_BUDGET_MS = 2_500

function mcpKey(workspaceRoot: string | null): string {
  return workspaceRoot ?? ''
}
