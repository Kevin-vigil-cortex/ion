import { create } from 'zustand'
import type {
  SafeConfig,
  SessionMeta,
  Session,
  ModelInfo,
  AgentEvent,
  ConversationItem,
  ApprovalDecision,
  OAuthProgress,
  Board,
  BoardCard,
  BoardColumn,
  MemoryFile,
  MemoryScope,
  LifetimeUsage,
  ApprovalMode,
  SessionMode,
  WorkspaceMention,
  SkillInfo,
  McpServerInfo
} from '../../shared/ipc'

export type { WorkspaceMention, SkillInfo, McpServerInfo }
import {
  classifyAttachment,
  draftsToPayloads,
  fileToDraft,
  maxBytesFor,
  revokeDraft,
  MAX_ATTACHMENTS,
  type DraftAttachment
} from './media'

const api = window.ion

export type { DraftAttachment }
export type UiAttachment = {
  id: string
  name: string
  mimeType: string
  kind: 'image' | 'file' | 'video'
  path?: string
  previewUrl?: string
  silent?: boolean
}

export type UiStatus =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'awaiting_approval'
  | 'running_tool'
  | 'error'

export interface UiMessage {
  id: string
  kind: 'message'
  role: 'user' | 'assistant'
  content: string
  attachments?: UiAttachment[]
  mentions?: WorkspaceMention[]
  skills?: SkillInfo[]
  reasoning?: string
  /** Set when reasoning starts streaming (drives the live "Thinking" line). */
  reasoningStartedAt?: number
  /** Total thinking time, set when reasoning ends — enables the collapsed "Thought for Xs" row. */
  reasoningMs?: number
}

export type UiToolStatus = 'running' | 'awaiting' | 'done' | 'error'

export interface UiTool {
  id: string
  kind: 'tool'
  callId: string
  name: string
  summary: string
  args?: string
  status: UiToolStatus
  output?: string
  isError?: boolean
}

export interface UiError {
  id: string
  kind: 'error'
  message: string
}

export interface UiFileChange {
  path: string
  created: boolean
  skipped?: boolean
  additions: number
  deletions: number
  diff: string
}

export interface UiChanges {
  id: string
  kind: 'changes'
  checkpointId: string
  files: UiFileChange[]
  restoredPaths: string[]
}

export type UiItem = UiMessage | UiTool | UiError | UiChanges

/** Estimated composition of the model's context (from `context_stats` events). */
export interface ContextStats {
  systemPromptTokens: number
  toolDefTokens: number
  memoryTokens?: number
  conversationTokens: number
  totalTokens: number
}

/** Cumulative provider-reported usage for the open session. */
export interface SessionUsageState {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export type AppView = 'chat' | 'board' | 'memories'

interface AppState {
  config: SafeConfig | null
  models: ModelInfo[]
  sessions: SessionMeta[]

  currentSessionId: string | null
  thread: UiItem[]
  status: UiStatus
  liveReasoning: string
  openAssistantId: string | null
  pendingApproval: { callId: string; summary: string; name: string } | null

  // New-chat drafts (before a session exists)
  draftWorkspace: string | null
  draftModel: string
  draftEffort: string
  draftMode: SessionMode

  settingsOpen: boolean
  mcpServers: McpServerInfo[]
  oauthProgress: OAuthProgress | null

  view: AppView
  board: Board | null
  /** Learned-memory files shown in the Memories view (null until first load). */
  memories: MemoryFile[] | null

  /** Whether the workspace file-explorer panel is expanded. */
  explorerOpen: boolean

  /** Whether the embedded agent-browser panel is expanded in the chat view. */
  browserPanelOpen: boolean
  /** Tool line whose details are open in the right inspector column. */
  selectedToolId: string | null

  /** Context Usage panel data for the open session. */
  contextStats: ContextStats | null
  sessionUsage: SessionUsageState | null
  lifetimeUsage: LifetimeUsage | null

  initialize(): Promise<void>
  refreshSessions(): Promise<void>
  newChat(): void
  openSession(id: string): Promise<void>
  deleteSession(id: string): Promise<void>
  /** Follow-ups typed while a turn is running; sent when it finishes. */
  queuedPrompts: {
    id: string
    text: string
    attachments?: DraftAttachment[]
    mentions?: WorkspaceMention[]
    skills?: SkillInfo[]
  }[]
  draftAttachments: DraftAttachment[]
  draftMentions: WorkspaceMention[]
  draftSkills: SkillInfo[]
  attachmentError: string | null

  addDraftFiles(files: File[]): Promise<void>
  removeDraftAttachment(id: string): void
  clearDraftAttachments(): void
  addDraftMention(mention: WorkspaceMention): void
  removeDraftMention(path: string): void
  addDraftSkill(skill: SkillInfo): void
  removeDraftSkill(name: string): void
  send(
    text: string,
    attachments?: DraftAttachment[],
    opts?: { immediate?: boolean; mentions?: WorkspaceMention[]; skills?: SkillInfo[] }
  ): Promise<void>
  removeQueued(id: string): void
  flushQueue(): Promise<void>
  abort(): Promise<void>
  cycleMode(): void
  cycleModel(): void
  approve(callId: string, decision: ApprovalDecision): Promise<void>
  pickWorkspace(): Promise<void>
  clearWorkspace(): Promise<void>
  selectModel(model: string): Promise<void>
  selectEffort(effort: string): Promise<void>
  selectMode(mode: SessionMode): Promise<void>
  applyEvent(event: AgentEvent): void
  applyStreamDeltas(text: string, reasoning: string): void

  setSettingsOpen(open: boolean): void
  refreshMcp(): Promise<void>
  reloadMcp(): Promise<void>
  refreshConfig(): Promise<void>
  setApiKey(key: string): Promise<void>
  clearApiKey(): Promise<void>
  setAuthMode(mode: 'api_key' | 'oauth'): Promise<void>
  setApprovalMode(mode: ApprovalMode): Promise<void>
  setMemoryEnabled(value: boolean): Promise<void>
  setLearningEnabled(value: boolean): Promise<void>
  setBrowserUseEnabled(value: boolean): Promise<void>
  setComputerUseEnabled(value: boolean): Promise<void>
  startOAuth(): Promise<void>
  signOut(): Promise<void>
  toggleProxy(enabled: boolean): Promise<void>

  setView(view: AppView): void
  setExplorerOpen(open: boolean): void
  setBrowserPanelOpen(open: boolean): void
  selectTool(id: string | null): void
  persistBoard(next: Board): Promise<void>
  addColumn(title: string): Promise<void>
  renameColumn(columnId: string, title: string): Promise<void>
  deleteColumn(columnId: string): Promise<void>
  addCard(columnId: string, title: string): Promise<void>
  updateCard(cardId: string, patch: { title?: string; notes?: string }): Promise<void>
  deleteCard(cardId: string): Promise<void>
  moveCard(cardId: string, toColumnId: string, beforeCardId: string | null): Promise<void>

  refreshMemories(): Promise<void>
  saveMemoryFile(scope: MemoryScope, workspaceRoot: string | null, content: string): Promise<void>
  clearMemoryFile(scope: MemoryScope, workspaceRoot: string | null): Promise<void>

  refreshLifetimeUsage(): Promise<void>
  setUserRules(text: string): Promise<void>
  restoreCheckpoint(checkpointId: string, path?: string): Promise<void>
  applyFile(relPath: string, content: string): Promise<void>
  openInEditor(relPath: string, line?: number): Promise<void>
  gitCommit(message: string, paths: string[]): Promise<string>
  suggestCommitMessage(): Promise<string>
}

let idCounter = 0
const uid = (prefix: string): string => `${prefix}_${Date.now()}_${idCounter++}`

/**
 * Conversation-only context estimate (~4 chars/token) for a reopened chat.
 * System-prompt/tool-def numbers arrive with the next turn's context_stats.
 */
function contextStatsFromItems(items: ConversationItem[]): ContextStats | null {
  if (items.length === 0) return null
  let conversationTokens = 0
  for (const item of items) {
    const text =
      item.kind === 'message'
        ? item.content
        : item.kind === 'tool_call'
          ? item.name + item.arguments
          : item.kind === 'tool_result'
            ? item.output
            : ''
    conversationTokens += Math.ceil((text?.length ?? 0) / 4)
  }
  return {
    systemPromptTokens: 0,
    toolDefTokens: 0,
    conversationTokens,
    totalTokens: conversationTokens
  }
}

/** Convert a persisted transcript into renderable UI items. */
function threadFromItems(items: ConversationItem[]): UiItem[] {
  const out: UiItem[] = []
  const toolIndex = new Map<string, number>()
  for (const item of items) {
    if (item.kind === 'reasoning') {
      continue
    } else if (item.kind === 'message') {
      if (item.role === 'system') continue
      out.push({
        id: uid('m'),
        kind: 'message',
        role: item.role,
        content: item.content,
        ...(item.role === 'user' && item.attachments?.length
          ? {
              attachments: item.attachments
                .filter((a) => !a.silent)
                .map((a) => ({
                  id: a.id,
                  name: a.name,
                  mimeType: a.mimeType,
                  kind: a.kind,
                  path: a.path
                }))
            }
          : {})
      })
    } else if (item.kind === 'tool_call') {
      const tool: UiTool = {
        id: uid('t'),
        kind: 'tool',
        callId: item.callId,
        name: item.name,
        summary: item.name,
        args: item.arguments,
        status: 'done'
      }
      toolIndex.set(item.callId, out.length)
      out.push(tool)
    } else if (item.kind === 'tool_result') {
      const idx = toolIndex.get(item.callId)
      if (idx !== undefined) {
        const tool = out[idx] as UiTool
        tool.output = item.output
        tool.isError = item.isError
        tool.status = item.isError ? 'error' : 'done'
      }
    } else if (item.kind === 'checkpoint') {
      out.push({
        id: uid('c'),
        kind: 'changes',
        checkpointId: item.id,
        files: item.files.map((f) => ({
          path: f.path,
          created: f.created,
          skipped: f.skipped,
          additions: f.additions,
          deletions: f.deletions,
          diff: f.diff
        })),
        restoredPaths: item.restoredPaths ?? []
      })
    }
  }
  return out
}

let streamText = ''
let streamReasoning = ''
let streamRaf = 0

function queueStreamDelta(kind: 'text' | 'reasoning', chunk: string): void {
  if (kind === 'text') streamText += chunk
  else streamReasoning += chunk
  if (streamRaf) return
  streamRaf = requestAnimationFrame(() => {
    streamRaf = 0
    flushStreamDeltas()
  })
}

function flushStreamDeltas(): void {
  if (streamRaf) {
    cancelAnimationFrame(streamRaf)
    streamRaf = 0
  }
  const text = streamText
  const reasoning = streamReasoning
  streamText = ''
  streamReasoning = ''
  if (!text && !reasoning) return
  useStore.getState().applyStreamDeltas(text, reasoning)
}

export const useStore = create<AppState>((set, get) => {
  let drainingQueue = false
  return {
  config: null,
  models: [],
  sessions: [],
  currentSessionId: null,
  thread: [],
  status: 'idle',
  queuedPrompts: [],
  draftAttachments: [],
  draftMentions: [],
  draftSkills: [],
  attachmentError: null,
  liveReasoning: '',
  openAssistantId: null,
  pendingApproval: null,
  draftWorkspace: null,
  draftModel: 'grok-4.6',
  draftEffort: 'medium',
  draftMode: 'agent',
  settingsOpen: false,
  mcpServers: [],
  oauthProgress: null,
  view: 'chat',
  board: null,
  memories: null,
  // Closed by default: chat is the main surface, the file tree is on demand.
  explorerOpen: false,
  browserPanelOpen: false,
  selectedToolId: null,
  contextStats: null,
  sessionUsage: null,
  lifetimeUsage: null,

  async initialize() {
    const [config, sessions, models, board] = await Promise.all([
      api.getConfig(),
      api.listSessions(),
      api.listModels(),
      api.getBoard()
    ])
    set({
      config,
      sessions,
      models,
      board,
      draftModel: config.defaultModel,
      draftEffort: config.defaultEffort ?? 'medium'
    })

    api.onAgentEvent(({ sessionId, event }) => {
      if (sessionId !== get().currentSessionId) {
        if (event.type === 'done' || event.type === 'workspace_changed') {
          void get().refreshSessions()
        }
        return
      }
      if (event.type === 'assistant_text_delta') {
        queueStreamDelta('text', event.text)
        return
      }
      if (event.type === 'assistant_reasoning_delta') {
        queueStreamDelta('reasoning', event.text)
        return
      }
      flushStreamDeltas()
      get().applyEvent(event)
      if (
        event.type === 'done' ||
        event.type === 'workspace_changed' ||
        event.type === 'error' ||
        (event.type === 'status' && event.status === 'done')
      ) {
        void get().refreshSessions()
      }
    })

    api.onOAuthProgress((progress) => {
      set({ oauthProgress: progress })
      if (progress.stage === 'success' || progress.stage === 'error') {
        void get().refreshConfig()
        if (progress.stage === 'success') void get().refreshSessions()
      }
    })

    // Agent browser activity auto-opens the panel so the user can watch.
    if (api.onBrowserActivity) {
      api.onBrowserActivity((activity) => {
        if (activity.action === 'ensure_visible') {
          set({ browserPanelOpen: true, view: 'chat' })
        }
      })
    }
  },

  async refreshSessions() {
    set({ sessions: await api.listSessions() })
  },

  newChat() {
    flushStreamDeltas()
    for (const a of get().draftAttachments) revokeDraft(a)
    set({
      view: 'chat',
      currentSessionId: null,
      thread: [],
      status: 'idle',
      queuedPrompts: [],
      draftAttachments: [],
      draftMentions: [],
      draftSkills: [],
      attachmentError: null,
      liveReasoning: '',
      openAssistantId: null,
      pendingApproval: null,
      selectedToolId: null,
      draftWorkspace: null,
      contextStats: null,
      sessionUsage: null
    })
    queueMicrotask(() => window.dispatchEvent(new Event('ion:focus-composer')))
  },

  async openSession(id) {
    flushStreamDeltas()
    const session = await api.getSession(id)
    if (!session) return
    set({
      view: 'chat',
      currentSessionId: id,
      thread: threadFromItems(session.items),
      status: 'idle',
      queuedPrompts: [],
      draftAttachments: [],
      draftMentions: [],
      draftSkills: [],
      attachmentError: null,
      liveReasoning: '',
      openAssistantId: null,
      pendingApproval: null,
      selectedToolId: null,
      draftWorkspace: session.workspaceRoot,
      draftModel: session.model,
      draftEffort: session.reasoningEffort ?? get().config?.defaultEffort ?? 'medium',
      draftMode: session.mode === 'plan' ? 'plan' : 'agent',
      contextStats: contextStatsFromItems(session.items),
      sessionUsage: session.usage
        ? {
            inputTokens: session.usage.inputTokens,
            outputTokens: session.usage.outputTokens,
            costUsd: session.usage.costUsd
          }
        : null
    })
  },

  async deleteSession(id) {
    await api.deleteSession(id)
    if (get().currentSessionId === id) get().newChat()
    await get().refreshSessions()
  },

  async addDraftFiles(files) {
    const existing = get().draftAttachments
    const room = MAX_ATTACHMENTS - existing.length
    if (room <= 0) {
      set({ attachmentError: `Max ${MAX_ATTACHMENTS} attachments` })
      return
    }
    const take = files.slice(0, room)
    const added: DraftAttachment[] = []
    let error: string | null = null
    for (const file of take) {
      const kind = classifyAttachment(file.type, file.name)
      if (file.size > maxBytesFor(kind)) {
        error = `${file.name} is too large`
        continue
      }
      added.push(await fileToDraft(file, uid('a')))
    }
    set((s) => ({
      draftAttachments: [...s.draftAttachments, ...added],
      attachmentError: error
    }))
  },

  removeDraftAttachment(id) {
    const found = get().draftAttachments.find((a) => a.id === id)
    if (found) revokeDraft(found)
    set((s) => ({
      draftAttachments: s.draftAttachments.filter((a) => a.id !== id),
      attachmentError: null
    }))
  },

  clearDraftAttachments() {
    for (const a of get().draftAttachments) revokeDraft(a)
    set({ draftAttachments: [], attachmentError: null })
  },

  addDraftMention(mention) {
    set((s) => {
      if (s.draftMentions.some((m) => m.path === mention.path)) return s
      return { draftMentions: [...s.draftMentions, mention] }
    })
  },

  removeDraftMention(path) {
    set((s) => ({ draftMentions: s.draftMentions.filter((m) => m.path !== path) }))
  },

  addDraftSkill(skill) {
    set((s) => {
      if (s.draftSkills.some((x) => x.name === skill.name)) return s
      return { draftSkills: [...s.draftSkills, skill] }
    })
  },

  removeDraftSkill(name) {
    set((s) => ({ draftSkills: s.draftSkills.filter((x) => x.name !== name) }))
  },

  async send(text, attachments, opts) {
    const fromComposer = attachments === undefined
    const atts = attachments ?? get().draftAttachments
    const mentions = opts?.mentions ?? (fromComposer ? get().draftMentions : [])
    const skills = opts?.skills ?? (fromComposer ? get().draftSkills : [])
    const busy = get().status !== 'idle' && get().status !== 'error'

    const uiAtts: UiAttachment[] = atts
      .filter((a) => !a.silent)
      .map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        kind: a.kind,
        path: a.path,
        previewUrl: a.previewUrl
      }))
    const userItem: UiMessage = {
      id: uid('m'),
      kind: 'message',
      role: 'user',
      content: text,
      ...(uiAtts.length ? { attachments: uiAtts } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(skills.length ? { skills } : {})
    }
    const clearDrafts = fromComposer
      ? {
          draftAttachments: [] as DraftAttachment[],
          draftMentions: [] as WorkspaceMention[],
          draftSkills: [] as SkillInfo[],
          attachmentError: null
        }
      : {}
    const payloads = draftsToPayloads(atts)
    const skillNames = skills.map((s) => s.name)
    const wire = {
      text,
      ...(payloads.length ? { attachments: payloads } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(skillNames.length ? { skills: skillNames } : {})
    }

    if (busy && opts?.immediate && get().currentSessionId) {
      set((s) => ({ thread: [...s.thread, userItem], ...clearDrafts }))
      await api.steerMessage({ sessionId: get().currentSessionId!, ...wire })
      return
    }

    if (busy) {
      set((s) => ({
        queuedPrompts: [
          ...s.queuedPrompts,
          {
            id: uid('q'),
            text,
            attachments: atts,
            mentions: mentions.length ? mentions : undefined,
            skills: skills.length ? skills : undefined
          }
        ],
        ...clearDrafts
      }))
      return
    }

    let sessionId = get().currentSessionId
    if (!sessionId) {
      const session = await api.createSession({
        workspaceRoot: get().draftWorkspace,
        model: get().draftModel,
        mode: get().draftMode,
        reasoningEffort: get().draftEffort
      })
      sessionId = session.id
      set({ currentSessionId: sessionId })
      await get().refreshSessions()
    }
    set((s) => ({
      thread: [...s.thread, userItem],
      status: 'thinking',
      openAssistantId: null,
      liveReasoning: '',
      ...clearDrafts
    }))
    await api.sendMessage({ sessionId, ...wire })
  },

  removeQueued(id) {
    set((s) => ({ queuedPrompts: s.queuedPrompts.filter((q) => q.id !== id) }))
  },

  async flushQueue() {
    if (drainingQueue) return
    const next = get().queuedPrompts[0]
    if (!next) return
    const st = get().status
    if (st !== 'idle' && st !== 'error') return
    drainingQueue = true
    set((s) => ({ queuedPrompts: s.queuedPrompts.slice(1) }))
    try {
      await get().send(next.text, next.attachments ?? [], {
        mentions: next.mentions ?? [],
        skills: next.skills ?? []
      })
    } finally {
      drainingQueue = false
    }
  },

  async abort() {
    flushStreamDeltas()
    const id = get().currentSessionId
    if (id) await api.abortChat(id)
    set((s) => ({
      status: 'idle',
      pendingApproval: null,
      openAssistantId: null,
      // Freeze any live "Thinking" stub into a finished "Thought for Xs" row;
      // drop stubs that never produced reasoning or text.
      thread: s.thread
        .filter(
          (it) =>
            !(it.kind === 'message' && it.role === 'assistant' && !it.content.trim() && !it.reasoning)
        )
        .map((it) => {
          if (
            it.kind === 'message' &&
            it.role === 'assistant' &&
            it.reasoningStartedAt !== undefined &&
            it.reasoningMs === undefined
          ) {
            return { ...it, reasoningMs: Date.now() - it.reasoningStartedAt }
          }
          return it
        })
    }))
    // Stopped this turn — fire the next queued steer if there is one.
    void get().flushQueue()
  },

  async approve(callId, decision) {
    const id = get().currentSessionId
    if (!id) return
    await api.approve({ sessionId: id, callId, decision })
    set((s) => ({
      pendingApproval: null,
      thread: s.thread.map((it) =>
        it.kind === 'tool' && it.callId === callId && it.status === 'awaiting'
          ? { ...it, status: decision === 'deny' ? 'error' : 'running' }
          : it
      )
    }))
  },

  async pickWorkspace() {
    const dir = await api.pickWorkspace()
    if (!dir) return
    const id = get().currentSessionId
    if (id) {
      await api.setSessionWorkspace({ id, workspaceRoot: dir })
    }
    set({ draftWorkspace: dir })
  },

  async clearWorkspace() {
    const id = get().currentSessionId
    if (id) await api.setSessionWorkspace({ id, workspaceRoot: null })
    set({ draftWorkspace: null })
  },

  async selectModel(model) {
    const id = get().currentSessionId
    if (id) await api.setSessionModel({ id, model })
    set({ draftModel: model })
    // Clamp the effort if the new model doesn't support the current one
    // (e.g. xhigh is grok-4.6+ only; 4.5 tops out at high).
    const efforts = get().models.find((m) => m.id === model)?.efforts
    if (efforts && efforts.length > 0 && !efforts.includes(get().draftEffort)) {
      await get().selectEffort(efforts[efforts.length - 1]!)
    }
  },

  async selectEffort(effort) {
    const id = get().currentSessionId
    if (id) {
      await api.setSessionEffort({ id, effort })
    }
    // Picker changes also become the default for new chats.
    const config = await api.setDefaultEffort(effort)
    set({ draftEffort: effort, config })
  },

  async selectMode(mode) {
    const id = get().currentSessionId
    if (id) await api.setSessionMode({ id, mode })
    set({ draftMode: mode })
  },

  cycleMode() {
    const s = get()
    const current = s.draftMode === 'plan' ? 'plan' : (s.config?.approvalMode ?? 'ask')
    const order = ['ask', 'auto', 'plan', 'full'] as const
    const idx = order.indexOf(current)
    const next = order[(idx + 1) % order.length] ?? 'ask'
    if (next === 'plan') {
      void get().selectMode('plan')
      return
    }
    if (s.draftMode === 'plan') void get().selectMode('agent')
    void get().setApprovalMode(next)
  },

  cycleModel() {
    const models = get().models
    if (models.length === 0) return
    const idx = models.findIndex((m) => m.id === get().draftModel)
    const next = models[(idx + 1) % models.length]
    if (next) void get().selectModel(next.id)
  },

  applyStreamDeltas(text, reasoning) {
    set((state) => {
      const thread = state.thread.slice()
      let openId = state.openAssistantId
      let msg = openId
        ? (thread.find((it) => it.id === openId && it.kind === 'message') as UiMessage | undefined)
        : undefined
      if (!msg) {
        msg = { id: uid('a'), kind: 'message', role: 'assistant', content: '' }
        thread.push(msg)
        openId = msg.id
      }
      const next: UiMessage = { ...msg }
      if (reasoning) {
        if (next.reasoningStartedAt === undefined) next.reasoningStartedAt = Date.now()
        next.reasoning = (next.reasoning ?? '') + reasoning
      }
      if (text) {
        if (next.reasoningStartedAt !== undefined && next.reasoningMs === undefined) {
          next.reasoningMs = Date.now() - next.reasoningStartedAt
        }
        next.content += text
      }
      const idx = thread.findIndex((it) => it.id === next.id)
      if (idx >= 0) thread[idx] = next
      return { thread, openAssistantId: openId }
    })
  },

  applyEvent(event) {
    set((state) => {
      const thread = state.thread.slice()
      const patch: Partial<AppState> = { thread }

      // Close out a live "Thinking" phase: stamp the duration so the UI
      // collapses it into a "Thought for Xs" row (Cursor-style).
      const finalizeThinking = (msg: UiMessage): UiMessage => {
        if (msg.reasoningStartedAt !== undefined && msg.reasoningMs === undefined) {
          return { ...msg, reasoningMs: Date.now() - msg.reasoningStartedAt }
        }
        return msg
      }

      // When the turn moves on (prose, tools, done): finalize any live
      // thinking rows and drop stubs that have neither text nor reasoning.
      const clearThinking = (): void => {
        for (let i = thread.length - 1; i >= 0; i--) {
          const it = thread[i]
          if (!it || it.kind !== 'message' || it.role !== 'assistant') continue
          if (!it.content.trim() && !it.reasoning) thread.splice(i, 1)
          else thread[i] = finalizeThinking(it)
        }
      }

      const ensureOpenAssistant = (): { msg: UiMessage; idx: number } => {
        if (state.openAssistantId) {
          const idx = thread.findIndex(
            (it) => it.id === state.openAssistantId && it.kind === 'message'
          )
          if (idx >= 0) return { msg: thread[idx] as UiMessage, idx }
        }
        const msg: UiMessage = { id: uid('a'), kind: 'message', role: 'assistant', content: '' }
        thread.push(msg)
        patch.openAssistantId = msg.id
        return { msg, idx: thread.length - 1 }
      }

      switch (event.type) {
        case 'status':
          if (event.status === 'done') {
            patch.status = 'idle'
            patch.openAssistantId = null
          } else if (event.status !== 'idle') {
            patch.status = event.status as UiStatus
          }
          break
        case 'assistant_text_delta': {
          const { msg, idx } = ensureOpenAssistant()
          const next = finalizeThinking(msg)
          thread[idx] = { ...next, content: next.content + event.text }
          break
        }
        case 'assistant_reasoning_delta': {
          const { msg, idx } = ensureOpenAssistant()
          thread[idx] = {
            ...msg,
            reasoningStartedAt: msg.reasoningStartedAt ?? Date.now(),
            reasoning: (msg.reasoning ?? '') + event.text
          }
          break
        }
        case 'assistant_message': {
          const { msg, idx } = ensureOpenAssistant()
          thread[idx] = { ...finalizeThinking(msg), content: event.content }
          patch.openAssistantId = null
          break
        }
        case 'tool_call':
          clearThinking()
          patch.openAssistantId = null
          thread.push({
            id: uid('t'),
            kind: 'tool',
            callId: event.callId,
            name: event.name,
            summary: event.summary,
            args: event.arguments,
            status: 'running'
          })
          break
        case 'tool_approval_request': {
          patch.pendingApproval = {
            callId: event.callId,
            summary: event.summary,
            name: event.name
          }
          const idx = thread.findIndex((it) => it.kind === 'tool' && it.callId === event.callId)
          if (idx >= 0) {
            thread[idx] = { ...(thread[idx] as UiTool), status: 'awaiting' }
          }
          patch.status = 'awaiting_approval'
          break
        }
        case 'tool_result': {
          const idx = thread.findIndex((it) => it.kind === 'tool' && it.callId === event.callId)
          if (idx >= 0) {
            const tool = thread[idx] as UiTool
            thread[idx] = {
              ...tool,
              output: event.output,
              isError: event.isError,
              status: event.isError ? 'error' : 'done'
            }
          }
          break
        }
        case 'context_stats':
          patch.contextStats = {
            systemPromptTokens: event.systemPromptTokens,
            toolDefTokens: event.toolDefTokens,
            ...(event.memoryTokens !== undefined ? { memoryTokens: event.memoryTokens } : {}),
            conversationTokens: event.conversationTokens,
            totalTokens: event.totalTokens
          }
          break
        case 'usage':
          patch.sessionUsage = {
            inputTokens: event.sessionInputTokens,
            outputTokens: event.sessionOutputTokens,
            costUsd: event.sessionCostUsd ?? 0
          }
          break
        case 'workspace_changed':
          // The agent opened a folder via open_workspace mid-turn.
          patch.draftWorkspace = event.workspaceRoot
          break
        case 'turn_changes':
          thread.push({
            id: uid('c'),
            kind: 'changes',
            checkpointId: event.checkpointId,
            files: event.files,
            restoredPaths: []
          })
          break
        case 'checkpoint_restored': {
          const idx = thread.findIndex(
            (it) => it.kind === 'changes' && it.checkpointId === event.checkpointId
          )
          if (idx >= 0) {
            const card = thread[idx] as UiChanges
            thread[idx] = {
              ...card,
              restoredPaths: [...new Set([...card.restoredPaths, ...event.paths])]
            }
          }
          break
        }
        case 'error':
          clearThinking()
          thread.push({ id: uid('e'), kind: 'error', message: event.message })
          patch.status = 'error'
          break
        case 'done':
          clearThinking()
          patch.status = 'idle'
          patch.openAssistantId = null
          break
      }
      return patch
    })
    if (event.type === 'done' || (event.type === 'status' && event.status === 'done')) {
      void get().flushQueue()
    }
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open })
    if (open) void get().refreshMcp()
  },

  async refreshMcp() {
    set({ mcpServers: await api.listMcp(get().draftWorkspace) })
  },

  async reloadMcp() {
    set({ mcpServers: await api.reloadMcp(get().draftWorkspace) })
  },

  async refreshConfig() {
    set({ config: await api.getConfig() })
  },

  async setApiKey(key) {
    set({ config: await api.setApiKey(key) })
    set({ models: await api.listModels() })
  },

  async clearApiKey() {
    set({ config: await api.clearApiKey() })
  },

  async setAuthMode(mode) {
    set({ config: await api.setAuthMode(mode) })
  },

  async setApprovalMode(mode) {
    set({ config: await api.setApprovalMode(mode) })
  },

  async setMemoryEnabled(value) {
    set({ config: await api.setMemoryEnabled(value) })
  },

  async setLearningEnabled(value) {
    set({ config: await api.setLearningEnabled(value) })
  },

  async setBrowserUseEnabled(value) {
    set({ config: await api.setBrowserUseEnabled(value) })
  },

  async setComputerUseEnabled(value) {
    set({ config: await api.setComputerUseEnabled(value) })
  },

  async startOAuth() {
    set({ oauthProgress: { stage: 'starting' } })
    set({ config: await api.startOAuth() })
    set({ models: await api.listModels() })
  },

  async signOut() {
    set({ config: await api.signOut(), oauthProgress: null })
  },

  async toggleProxy(enabled) {
    if (enabled) await api.startProxy()
    else await api.stopProxy()
    await get().refreshConfig()
  },

  setView(view) {
    set({ view })
  },

  setExplorerOpen(open) {
    set({ explorerOpen: open })
  },

  setBrowserPanelOpen(open) {
    set({ browserPanelOpen: open })
  },

  selectTool(id) {
    set({ selectedToolId: id })
  },

  /** Optimistically apply a board change, then persist it in the main process. */
  async persistBoard(next) {
    set({ board: next })
    await api.saveBoard(next)
  },

  async addColumn(title) {
    const board = get().board
    if (!board) return
    const column: BoardColumn = { id: uid('col'), title, cards: [] }
    await get().persistBoard({ ...board, columns: [...board.columns, column] })
  },

  async renameColumn(columnId, title) {
    const board = get().board
    if (!board) return
    await get().persistBoard({
      ...board,
      columns: board.columns.map((c) => (c.id === columnId ? { ...c, title } : c))
    })
  },

  async deleteColumn(columnId) {
    const board = get().board
    if (!board) return
    await get().persistBoard({
      ...board,
      columns: board.columns.filter((c) => c.id !== columnId)
    })
  },

  async addCard(columnId, title) {
    const board = get().board
    if (!board) return
    const now = Date.now()
    const card: BoardCard = { id: uid('card'), title, notes: '', createdAt: now, updatedAt: now }
    await get().persistBoard({
      ...board,
      columns: board.columns.map((c) =>
        c.id === columnId ? { ...c, cards: [...c.cards, card] } : c
      )
    })
  },

  async updateCard(cardId, patch) {
    const board = get().board
    if (!board) return
    await get().persistBoard({
      ...board,
      columns: board.columns.map((c) => ({
        ...c,
        cards: c.cards.map((card) =>
          card.id === cardId ? { ...card, ...patch, updatedAt: Date.now() } : card
        )
      }))
    })
  },

  async deleteCard(cardId) {
    const board = get().board
    if (!board) return
    await get().persistBoard({
      ...board,
      columns: board.columns.map((c) => ({
        ...c,
        cards: c.cards.filter((card) => card.id !== cardId)
      }))
    })
  },

  async moveCard(cardId, toColumnId, beforeCardId) {
    const board = get().board
    if (!board || cardId === beforeCardId) return

    // Pull the card out of whichever column currently holds it.
    let moved: BoardCard | undefined
    const columns = board.columns.map((c) => {
      const remaining = c.cards.filter((card) => {
        if (card.id !== cardId) return true
        moved = card
        return false
      })
      return remaining.length === c.cards.length ? c : { ...c, cards: remaining }
    })
    const movedCard = moved
    if (!movedCard) return

    // Insert before the anchor card (or append when no anchor / anchor vanished).
    const next = columns.map((c) => {
      if (c.id !== toColumnId) return c
      const cards = [...c.cards]
      const idx = beforeCardId ? cards.findIndex((card) => card.id === beforeCardId) : -1
      if (idx === -1) cards.push(movedCard)
      else cards.splice(idx, 0, movedCard)
      return { ...c, cards }
    })
    await get().persistBoard({ ...board, columns: next })
  },

  async refreshMemories() {
    set({ memories: await api.listMemories() })
  },

  async saveMemoryFile(scope, workspaceRoot, content) {
    set({ memories: await api.saveMemory({ scope, workspaceRoot, content }) })
  },

  async clearMemoryFile(scope, workspaceRoot) {
    set({ memories: await api.clearMemory({ scope, workspaceRoot }) })
  },

  async refreshLifetimeUsage() {
    try {
      set({ lifetimeUsage: await api.getUsageStats() })
    } catch {
      // A live dev session may run a preload built before this API existed.
    }
  },

  async setUserRules(text) {
    set({ config: await api.setUserRules(text) })
  },

  async restoreCheckpoint(checkpointId, path) {
    const id = get().currentSessionId
    if (!id) return
    await api.restoreCheckpoint({ sessionId: id, checkpointId, path })
  },

  async applyFile(relPath, content) {
    const root = get().draftWorkspace
    if (!root) throw new Error('Open a folder first.')
    await api.fsWriteFile({ workspaceRoot: root, relPath, content })
  },

  async openInEditor(relPath, line) {
    const root = get().draftWorkspace
    if (!root) throw new Error('Open a folder first.')
    await api.openInEditor({ workspaceRoot: root, relPath, line })
  },

  async gitCommit(message, paths) {
    const root = get().draftWorkspace
    if (!root) throw new Error('Open a folder first.')
    return api.gitCommit({ workspaceRoot: root, message, paths })
  },

  async suggestCommitMessage() {
    const root = get().draftWorkspace
    const id = get().currentSessionId
    if (!root || !id) throw new Error('Open a folder and a chat first.')
    return api.suggestCommitMessage({ sessionId: id, workspaceRoot: root })
  }
  }
})
