import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  IonApi,
  AgentEventPayload,
  OAuthProgress,
  AuthMode,
  ApprovalDecision,
  ApprovalMode,
  Board,
  BrowserCursorEvent,
  BrowserActivityEvent
} from '../shared/ipc'
import { IpcChannel, IpcEvent } from '../shared/ipc'

const api: IonApi = {
  platform: process.platform,

  getConfig: () => ipcRenderer.invoke(IpcChannel.ConfigGet),
  setApiKey: (key: string) => ipcRenderer.invoke(IpcChannel.ConfigSetApiKey, key),
  clearApiKey: () => ipcRenderer.invoke(IpcChannel.ConfigClearApiKey),
  setDefaultModel: (model: string) => ipcRenderer.invoke(IpcChannel.ConfigSetDefaultModel, model),
  setDefaultEffort: (effort: string) =>
    ipcRenderer.invoke(IpcChannel.ConfigSetDefaultEffort, effort),
  setAuthMode: (mode: AuthMode) => ipcRenderer.invoke(IpcChannel.ConfigSetAuthMode, mode),
  setApprovalMode: (mode: ApprovalMode) =>
    ipcRenderer.invoke(IpcChannel.ConfigSetApprovalMode, mode),
  setMemoryEnabled: (value: boolean) => ipcRenderer.invoke(IpcChannel.ConfigSetMemory, value),
  setLearningEnabled: (value: boolean) => ipcRenderer.invoke(IpcChannel.ConfigSetLearning, value),
  setBrowserUseEnabled: (value: boolean) =>
    ipcRenderer.invoke(IpcChannel.ConfigSetBrowserUse, value),
  setComputerUseEnabled: (value: boolean) =>
    ipcRenderer.invoke(IpcChannel.ConfigSetComputerUse, value),

  listModels: () => ipcRenderer.invoke(IpcChannel.ModelsList),
  pickWorkspace: () => ipcRenderer.invoke(IpcChannel.WorkspacePick),

  listSessions: () => ipcRenderer.invoke(IpcChannel.SessionsList),
  getSession: (id: string) => ipcRenderer.invoke(IpcChannel.SessionsGet, id),
  createSession: (params) => ipcRenderer.invoke(IpcChannel.SessionsCreate, params),
  deleteSession: (id: string) => ipcRenderer.invoke(IpcChannel.SessionsDelete, id),
  setSessionWorkspace: (params) => ipcRenderer.invoke(IpcChannel.SessionsSetWorkspace, params),
  setSessionModel: (params) => ipcRenderer.invoke(IpcChannel.SessionsSetModel, params),
  setSessionEffort: (params) => ipcRenderer.invoke(IpcChannel.SessionsSetEffort, params),
  setSessionMode: (params) => ipcRenderer.invoke(IpcChannel.SessionsSetMode, params),

  sendMessage: (params) => ipcRenderer.invoke(IpcChannel.ChatSend, params),
  steerMessage: (params) => ipcRenderer.invoke(IpcChannel.ChatSteer, params),
  suggestWorkspace: (params) => ipcRenderer.invoke(IpcChannel.WorkspaceSuggest, params),
  listSkills: (workspaceRoot) => ipcRenderer.invoke(IpcChannel.SkillsList, workspaceRoot),
  listMcp: (workspaceRoot) => ipcRenderer.invoke(IpcChannel.McpList, workspaceRoot),
  reloadMcp: (workspaceRoot) => ipcRenderer.invoke(IpcChannel.McpReload, workspaceRoot),
  attachmentPreview: (path) => ipcRenderer.invoke(IpcChannel.AttachmentPreview, path),
  localImagePreview: (path) => ipcRenderer.invoke(IpcChannel.LocalImagePreview, path),
  pathForDroppedFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return null
    }
  },
  abortChat: (sessionId: string) => ipcRenderer.invoke(IpcChannel.ChatAbort, sessionId),
  approve: (params: { sessionId: string; callId: string; decision: ApprovalDecision }) =>
    ipcRenderer.invoke(IpcChannel.ChatApprove, params),

  startProxy: () => ipcRenderer.invoke(IpcChannel.ProxyStart),
  stopProxy: () => ipcRenderer.invoke(IpcChannel.ProxyStop),
  proxyStatus: () => ipcRenderer.invoke(IpcChannel.ProxyStatus),

  startOAuth: () => ipcRenderer.invoke(IpcChannel.OAuthStart),
  signOut: () => ipcRenderer.invoke(IpcChannel.OAuthSignOut),

  getBoard: () => ipcRenderer.invoke(IpcChannel.BoardGet),
  saveBoard: (board: Board) => ipcRenderer.invoke(IpcChannel.BoardSave, board),

  listMemories: () => ipcRenderer.invoke(IpcChannel.MemoryList),
  saveMemory: (params) => ipcRenderer.invoke(IpcChannel.MemorySave, params),
  clearMemory: (params) => ipcRenderer.invoke(IpcChannel.MemoryClear, params),

  fsList: (params) => ipcRenderer.invoke(IpcChannel.FsList, params),
  fsCreateFile: (params) => ipcRenderer.invoke(IpcChannel.FsCreateFile, params),
  fsCreateDir: (params) => ipcRenderer.invoke(IpcChannel.FsCreateDir, params),
  fsRename: (params) => ipcRenderer.invoke(IpcChannel.FsRename, params),
  fsDelete: (params) => ipcRenderer.invoke(IpcChannel.FsDelete, params),

  getUsageStats: () => ipcRenderer.invoke(IpcChannel.UsageStats),
  setUserRules: (text: string) => ipcRenderer.invoke(IpcChannel.ConfigSetUserRules, text),
  restoreCheckpoint: (params) => ipcRenderer.invoke(IpcChannel.CheckpointsRestore, params),
  fsWriteFile: (params) => ipcRenderer.invoke(IpcChannel.FsWriteFile, params),
  openInEditor: (params) => ipcRenderer.invoke(IpcChannel.WorkspaceOpenInEditor, params),
  gitCommit: (params) => ipcRenderer.invoke(IpcChannel.GitCommit, params),
  suggestCommitMessage: (params) => ipcRenderer.invoke(IpcChannel.GitSuggestMessage, params),

  onAgentEvent: (cb: (payload: AgentEventPayload) => void) => {
    const listener = (_e: unknown, payload: AgentEventPayload): void => cb(payload)
    ipcRenderer.on(IpcEvent.AgentEvent, listener)
    return () => ipcRenderer.removeListener(IpcEvent.AgentEvent, listener)
  },
  onOAuthProgress: (cb: (progress: OAuthProgress) => void) => {
    const listener = (_e: unknown, progress: OAuthProgress): void => cb(progress)
    ipcRenderer.on(IpcEvent.OAuthProgress, listener)
    return () => ipcRenderer.removeListener(IpcEvent.OAuthProgress, listener)
  },
  onBrowserCursor: (cb: (event: BrowserCursorEvent) => void) => {
    const listener = (_e: unknown, event: BrowserCursorEvent): void => cb(event)
    ipcRenderer.on(IpcEvent.BrowserCursor, listener)
    return () => ipcRenderer.removeListener(IpcEvent.BrowserCursor, listener)
  },
  onBrowserActivity: (cb: (event: BrowserActivityEvent) => void) => {
    const listener = (_e: unknown, event: BrowserActivityEvent): void => cb(event)
    ipcRenderer.on(IpcEvent.BrowserActivity, listener)
    return () => ipcRenderer.removeListener(IpcEvent.BrowserActivity, listener)
  }
}

contextBridge.exposeInMainWorld('ion', api)
