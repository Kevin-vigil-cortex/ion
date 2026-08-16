import type {
  AgentEvent,
  SessionMeta,
  Session,
  ModelInfo,
  ConversationItem,
  MemoryFile,
  MemoryScope
} from '@ion/agent'

export type { AgentEvent, SessionMeta, Session, ModelInfo, ConversationItem, MemoryFile, MemoryScope }

export type AuthMode = 'api_key' | 'oauth'

/**
 * How tool actions get approved (Codex-style):
 * - ask:  every dangerous action needs in-chat approval.
 * - auto: workspace file edits auto-approve; terminal, computer use, and
 *         memory saves still ask.
 * - full: nothing asks.
 */
export type ApprovalMode = 'ask' | 'auto' | 'full'

/**
 * Per-chat working mode:
 * - agent: full tool set, makes changes (subject to ApprovalMode).
 * - plan:  read-only — explores the code and delivers an implementation plan.
 */
export type SessionMode = 'agent' | 'plan'

/** Auth/proxy/config state safe to expose to the renderer (no secrets). */
export interface SafeConfig {
  authMode: AuthMode
  defaultModel: string
  /** Default reasoning depth for new chats (low | medium | high | xhigh). */
  defaultEffort: string
  hasApiKey: boolean
  approvalMode: ApprovalMode
  /** When false, the model sees only the current turn — no prior chat history. */
  memoryEnabled: boolean
  /** Self-learning: inject learned memories into the prompt and offer save_memory. */
  learningEnabled: boolean
  /** Offer the embedded-browser tools to the agent (sandboxed to the panel). */
  browserUseEnabled: boolean
  /** Offer OS-level mouse/keyboard/screen tools (approval-gated, macOS). */
  computerUseEnabled: boolean
  baseUrl: string
  proxy: { enabled: boolean; port: number }
  oauth: { signedIn: boolean; account: string | null; tierGated: boolean }
  /** Personal rules from ~/.ion/user-rules.md. */
  userRules: string
  /** App version (package.json), shown in Settings next to update controls. */
  appVersion: string
}

export type ApprovalDecision = 'approve' | 'approve_always' | 'deny'

/** A single Kanban card. */
export interface BoardCard {
  id: string
  title: string
  notes: string
  createdAt: number
  updatedAt: number
}

/** A Kanban column holding an ordered list of cards. */
export interface BoardColumn {
  id: string
  title: string
  cards: BoardCard[]
}

/** The full Kanban board, persisted as one JSON file. */
export interface Board {
  columns: BoardColumn[]
  updatedAt: number
}

/** One entry in a workspace directory listing (file explorer). */
export interface FsEntry {
  name: string
  isDir: boolean
}

/** An `@file` / `@folder` / `@diff` chip the user attached to a prompt. */
export interface WorkspaceMention {
  path: string
  isDir: boolean
  /** Special mentions: working-tree or staged git diff. */
  kind?: 'path' | 'diff' | 'staged'
}

/** A `/skill` the user attached, or a row in the slash palette. */
export interface SkillInfo {
  name: string
  description: string
  source: 'user' | 'project'
}

/** One MCP server from mcp.json, as shown in Settings. */
export interface McpServerInfo {
  name: string
  source: 'user' | 'project'
  /** 'blocked': defined by the project's mcp.json in an untrusted workspace. */
  status: 'idle' | 'connected' | 'error' | 'skipped' | 'blocked'
  transport: 'stdio' | 'http'
  toolCount: number
  error?: string
}

/** Lifetime token/cost totals across all sessions (main-process stats file). */
export interface LifetimeUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface ProxyStatus {
  running: boolean
  port: number
  url: string | null
}

/** OAuth device-flow progress pushed to the renderer during sign-in. */
export interface OAuthProgress {
  stage: 'starting' | 'awaiting_authorization' | 'polling' | 'success' | 'error'
  verificationUri?: string
  userCode?: string
  message?: string
}

/**
 * Auto-update state, pushed from main on every change and returned by
 * checkForUpdates. `unsupported` = dev run or a build packaged without an
 * update feed (plain `npm run package`).
 */
export interface UpdateStatus {
  state: 'idle' | 'unsupported' | 'checking' | 'none' | 'downloading' | 'downloaded' | 'error'
  /** Version being downloaded / ready to install, when known. */
  version?: string
  /** Download progress, 0-100. */
  percent?: number
  message?: string
}

/** Channels invoked from renderer -> main (request/response). */
export const IpcChannel = {
  ConfigGet: 'config:get',
  ConfigSetApiKey: 'config:setApiKey',
  ConfigClearApiKey: 'config:clearApiKey',
  ConfigSetDefaultModel: 'config:setDefaultModel',
  ConfigSetDefaultEffort: 'config:setDefaultEffort',
  ConfigSetAuthMode: 'config:setAuthMode',
  ConfigSetApprovalMode: 'config:setApprovalMode',
  ConfigSetMemory: 'config:setMemory',
  ConfigSetLearning: 'config:setLearning',
  ConfigSetBrowserUse: 'config:setBrowserUse',
  ConfigSetComputerUse: 'config:setComputerUse',
  ModelsList: 'models:list',
  WorkspacePick: 'workspace:pick',
  SessionsList: 'sessions:list',
  SessionsGet: 'sessions:get',
  SessionsCreate: 'sessions:create',
  SessionsDelete: 'sessions:delete',
  SessionsSetWorkspace: 'sessions:setWorkspace',
  SessionsSetModel: 'sessions:setModel',
  SessionsSetEffort: 'sessions:setEffort',
  SessionsSetMode: 'sessions:setMode',
  ChatSend: 'chat:send',
  AttachmentPreview: 'attachment:preview',
  LocalImagePreview: 'attachment:localPreview',
  ChatAbort: 'chat:abort',
  ChatApprove: 'chat:approve',
  ProxyStart: 'proxy:start',
  ProxyStop: 'proxy:stop',
  ProxyStatus: 'proxy:status',
  OAuthStart: 'auth:oauthStart',
  OAuthSignOut: 'auth:signout',
  BoardGet: 'board:get',
  BoardSave: 'board:save',
  MemoryList: 'memory:list',
  MemorySave: 'memory:save',
  MemoryClear: 'memory:clear',
  FsList: 'fs:list',
  FsCreateFile: 'fs:createFile',
  FsCreateDir: 'fs:createDir',
  FsRename: 'fs:rename',
  FsDelete: 'fs:delete',
  WorkspaceSuggest: 'workspace:suggest',
  ChatSteer: 'chat:steer',
  UsageStats: 'usage:stats',
  ConfigSetUserRules: 'config:setUserRules',
  CheckpointsRestore: 'checkpoints:restore',
  FsWriteFile: 'fs:writeFile',
  WorkspaceOpenInEditor: 'workspace:openInEditor',
  GitCommit: 'git:commit',
  GitSuggestMessage: 'git:suggestMessage',
  SkillsList: 'skills:list',
  McpList: 'mcp:list',
  McpReload: 'mcp:reload',
  McpTrust: 'mcp:trust',
  UpdateCheck: 'update:check',
  UpdateInstall: 'update:install'
} as const

/** Channels pushed from main -> renderer (fire-and-forget). */
export const IpcEvent = {
  AgentEvent: 'agent:event',
  OAuthProgress: 'auth:oauthProgress',
  BrowserCursor: 'browser:cursor',
  BrowserActivity: 'browser:activity',
  UpdateStatus: 'update:status'
} as const

/**
 * Agent-driven cursor overlay events for the embedded browser panel.
 * Coordinates are CSS pixels relative to the webview viewport.
 */
export type BrowserCursorEvent =
  | { kind: 'move'; x: number; y: number; durationMs: number }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'hide' }

/** Browser panel activity pushed from main (auto-open panel, URL changes). */
export interface BrowserActivityEvent {
  action: 'ensure_visible' | 'navigated'
  url?: string
}

export interface AgentEventPayload {
  sessionId: string
  event: AgentEvent
}

/** A file the renderer is handing to main to copy into ~/.ion/attachments. */
export interface ChatAttachmentPayload {
  name: string
  mimeType: string
  path?: string
  data?: ArrayBuffer
  silent?: boolean
  skipFrames?: boolean
}

/** The full API surface exposed on `window.ion`. */
export interface IonApi {
  platform: string
  getConfig(): Promise<SafeConfig>
  setApiKey(key: string): Promise<SafeConfig>
  clearApiKey(): Promise<SafeConfig>
  setDefaultModel(model: string): Promise<SafeConfig>
  setDefaultEffort(effort: string): Promise<SafeConfig>
  setAuthMode(mode: AuthMode): Promise<SafeConfig>
  setApprovalMode(mode: ApprovalMode): Promise<SafeConfig>
  setMemoryEnabled(value: boolean): Promise<SafeConfig>
  setLearningEnabled(value: boolean): Promise<SafeConfig>
  setBrowserUseEnabled(value: boolean): Promise<SafeConfig>
  setComputerUseEnabled(value: boolean): Promise<SafeConfig>
  listModels(): Promise<ModelInfo[]>
  pickWorkspace(): Promise<string | null>
  listSessions(): Promise<SessionMeta[]>
  getSession(id: string): Promise<Session | null>
  createSession(params: {
    workspaceRoot: string | null
    model?: string
    mode?: SessionMode
    reasoningEffort?: string
  }): Promise<Session>
  deleteSession(id: string): Promise<void>
  setSessionWorkspace(params: { id: string; workspaceRoot: string | null }): Promise<Session | null>
  setSessionModel(params: { id: string; model: string }): Promise<Session | null>
  setSessionEffort(params: { id: string; effort: string }): Promise<Session | null>
  setSessionMode(params: { id: string; mode: SessionMode }): Promise<Session | null>
  sendMessage(params: {
    sessionId: string
    text: string
    attachments?: ChatAttachmentPayload[]
    mentions?: WorkspaceMention[]
    skills?: string[]
  }): Promise<void>
  /** Inject a user message into the in-flight turn (Cmd+Enter). */
  steerMessage(params: {
    sessionId: string
    text: string
    attachments?: ChatAttachmentPayload[]
    mentions?: WorkspaceMention[]
    skills?: string[]
  }): Promise<void>
  suggestWorkspace(params: { workspaceRoot: string; query: string }): Promise<WorkspaceMention[]>
  listSkills(workspaceRoot: string | null): Promise<SkillInfo[]>
  listMcp(workspaceRoot: string | null): Promise<McpServerInfo[]>
  reloadMcp(workspaceRoot: string | null): Promise<McpServerInfo[]>
  /** Allow (or revoke) this workspace's own .mcp.json servers, then reconnect. */
  setMcpTrust(params: { workspaceRoot: string; trusted: boolean }): Promise<McpServerInfo[]>
  /** Data-URL preview for an image stored under ~/.ion/attachments. */
  attachmentPreview(path: string): Promise<string | null>
  /** Data-URL preview for a Finder-dropped image still at its original path. */
  localImagePreview(path: string): Promise<string | null>
  /** Absolute path for a File dropped/picked in the renderer (Electron). */
  pathForDroppedFile(file: File): string | null
  abortChat(sessionId: string): Promise<void>
  approve(params: { sessionId: string; callId: string; decision: ApprovalDecision }): Promise<void>
  startProxy(): Promise<ProxyStatus>
  stopProxy(): Promise<ProxyStatus>
  proxyStatus(): Promise<ProxyStatus>
  startOAuth(): Promise<SafeConfig>
  signOut(): Promise<SafeConfig>
  getBoard(): Promise<Board>
  saveBoard(board: Board): Promise<Board>
  listMemories(): Promise<MemoryFile[]>
  saveMemory(params: {
    scope: MemoryScope
    workspaceRoot: string | null
    content: string
  }): Promise<MemoryFile[]>
  clearMemory(params: { scope: MemoryScope; workspaceRoot: string | null }): Promise<MemoryFile[]>
  fsList(params: { workspaceRoot: string; relPath: string }): Promise<FsEntry[]>
  fsCreateFile(params: { workspaceRoot: string; relPath: string }): Promise<void>
  fsCreateDir(params: { workspaceRoot: string; relPath: string }): Promise<void>
  fsRename(params: {
    workspaceRoot: string
    fromRelPath: string
    toRelPath: string
  }): Promise<void>
  fsDelete(params: { workspaceRoot: string; relPath: string }): Promise<void>
  getUsageStats(): Promise<LifetimeUsage>
  setUserRules(text: string): Promise<SafeConfig>
  restoreCheckpoint(params: {
    sessionId: string
    checkpointId: string
    path?: string
  }): Promise<string[]>
  fsWriteFile(params: { workspaceRoot: string; relPath: string; content: string }): Promise<void>
  openInEditor(params: { workspaceRoot: string; relPath: string; line?: number }): Promise<void>
  gitCommit(params: { workspaceRoot: string; message: string; paths: string[] }): Promise<string>
  suggestCommitMessage(params: { sessionId: string; workspaceRoot: string }): Promise<string>
  /** Trigger an update check now; resolves with the status it settled on. */
  checkForUpdates(): Promise<UpdateStatus>
  /** Quit and apply the downloaded update. */
  installUpdate(): Promise<void>
  onAgentEvent(cb: (payload: AgentEventPayload) => void): () => void
  onOAuthProgress(cb: (progress: OAuthProgress) => void): () => void
  onBrowserCursor(cb: (event: BrowserCursorEvent) => void): () => void
  onBrowserActivity(cb: (event: BrowserActivityEvent) => void): () => void
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
}
