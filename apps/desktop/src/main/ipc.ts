import { ipcMain, dialog, BrowserWindow } from 'electron'
import type {
  AuthMode,
  ApprovalDecision,
  ApprovalMode,
  SafeConfig,
  SessionMode,
  Board,
  MemoryScope,
  WorkspaceMention
} from '../shared/ipc'
import { IpcChannel, type ChatAttachmentPayload } from '../shared/ipc'
import { attachmentPreview, localImagePreview } from './attachments'
import {
  listDir,
  createFile,
  createDir,
  renameEntry,
  deleteEntry,
  writeWorkspaceFile,
  openInEditor,
  suggestWorkspacePaths
} from './workspace-fs'
import { readUserRules, writeUserRules } from './user-rules'
import type { ConfigStore } from './config'
import type { AuthManager } from './auth'
import type { AgentRuntime } from './runtime'
import type { ProxyManager } from './proxy'
import type { BoardStore } from './board'

export interface IpcDeps {
  config: ConfigStore
  auth: AuthManager
  runtime: AgentRuntime
  proxy: ProxyManager
  board: BoardStore
  /** Wired by oauth.ts; absent until then. */
  oauth?: {
    start: () => Promise<void>
    signOut: () => Promise<void>
  }
}

export function registerIpc(deps: IpcDeps): void {
  const { config, auth, runtime, proxy, board } = deps

  const safeConfig = async (): Promise<SafeConfig> =>
    config.toSafeConfig({
      oauth: auth.oauthState(),
      proxyEnabled: proxy.status().running,
      userRules: await readUserRules()
    })

  ipcMain.handle(IpcChannel.ConfigGet, () => safeConfig())

  ipcMain.handle(IpcChannel.ConfigSetApiKey, async (_e, key: string) => {
    await config.setApiKey(key)
    runtime.invalidateAgents()
    return safeConfig()
  })

  ipcMain.handle(IpcChannel.ConfigClearApiKey, async () => {
    await config.clearApiKey()
    runtime.invalidateAgents()
    return safeConfig()
  })

  ipcMain.handle(IpcChannel.ConfigSetDefaultModel, async (_e, model: string) => {
    await config.setDefaultModel(model)
    return safeConfig()
  })

  ipcMain.handle(IpcChannel.ConfigSetDefaultEffort, async (_e, effort: string) => {
    await config.setDefaultEffort(effort)
    return safeConfig()
  })

  ipcMain.handle(IpcChannel.ConfigSetAuthMode, async (_e, mode: AuthMode) => {
    await config.setAuthMode(mode)
    runtime.invalidateAgents()
    return safeConfig()
  })

  ipcMain.handle(IpcChannel.ConfigSetApprovalMode, async (_e, mode: ApprovalMode) => {
    await config.setApprovalMode(mode)
    runtime.invalidateAgents()
    return safeConfig()
  })

  ipcMain.handle(IpcChannel.ConfigSetMemory, async (_e, value: boolean) => {
    await config.setMemoryEnabled(value)
    runtime.invalidateAgents()
    return safeConfig()
  })

  ipcMain.handle(IpcChannel.ConfigSetLearning, async (_e, value: boolean) => {
    await config.setLearningEnabled(value)
    runtime.invalidateAgents()
    return safeConfig()
  })

  ipcMain.handle(IpcChannel.ConfigSetBrowserUse, async (_e, value: boolean) => {
    await config.setBrowserUseEnabled(value)
    runtime.invalidateAgents()
    return safeConfig()
  })

  ipcMain.handle(IpcChannel.ConfigSetComputerUse, async (_e, value: boolean) => {
    await config.setComputerUseEnabled(value)
    runtime.invalidateAgents()
    return safeConfig()
  })

  ipcMain.handle(IpcChannel.ModelsList, () => runtime.listModels())

  ipcMain.handle(IpcChannel.WorkspacePick, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IpcChannel.SessionsList, () => runtime.listSessions())
  ipcMain.handle(IpcChannel.SessionsGet, (_e, id: string) => runtime.getSession(id))
  ipcMain.handle(
    IpcChannel.SessionsCreate,
    (
      _e,
      params: {
        workspaceRoot: string | null
        model?: string
        mode?: SessionMode
        reasoningEffort?: string
      }
    ) => runtime.createSession(params)
  )
  ipcMain.handle(IpcChannel.SessionsDelete, (_e, id: string) => runtime.deleteSession(id))
  ipcMain.handle(
    IpcChannel.SessionsSetWorkspace,
    (_e, params: { id: string; workspaceRoot: string | null }) =>
      runtime.setSessionWorkspace(params.id, params.workspaceRoot)
  )
  ipcMain.handle(
    IpcChannel.SessionsSetModel,
    (_e, params: { id: string; model: string }) => runtime.setSessionModel(params.id, params.model)
  )
  ipcMain.handle(
    IpcChannel.SessionsSetEffort,
    (_e, params: { id: string; effort: string }) =>
      runtime.setSessionEffort(params.id, params.effort)
  )
  ipcMain.handle(
    IpcChannel.SessionsSetMode,
    (_e, params: { id: string; mode: SessionMode }) =>
      runtime.setSessionMode(params.id, params.mode)
  )

  ipcMain.handle(
    IpcChannel.ChatSend,
    (
      _e,
      params: {
        sessionId: string
        text: string
        attachments?: ChatAttachmentPayload[]
        mentions?: WorkspaceMention[]
        skills?: string[]
      }
    ) =>
      runtime.send(
        params.sessionId,
        params.text,
        params.attachments,
        params.mentions,
        params.skills
      )
  )
  ipcMain.handle(
    IpcChannel.ChatSteer,
    (
      _e,
      params: {
        sessionId: string
        text: string
        attachments?: ChatAttachmentPayload[]
        mentions?: WorkspaceMention[]
        skills?: string[]
      }
    ) =>
      runtime.steer(
        params.sessionId,
        params.text,
        params.attachments,
        params.mentions,
        params.skills
      )
  )
  ipcMain.handle(IpcChannel.SkillsList, (_e, workspaceRoot: string | null) =>
    runtime.listSkills(workspaceRoot)
  )
  ipcMain.handle(IpcChannel.McpList, (_e, workspaceRoot: string | null) =>
    runtime.listMcp(workspaceRoot)
  )
  ipcMain.handle(IpcChannel.McpReload, (_e, workspaceRoot: string | null) =>
    runtime.reloadMcp(workspaceRoot)
  )
  ipcMain.handle(
    IpcChannel.WorkspaceSuggest,
    (_e, p: { workspaceRoot: string; query: string }) =>
      suggestWorkspacePaths(p.workspaceRoot, p.query)
  )
  ipcMain.handle(IpcChannel.AttachmentPreview, (_e, path: string) => attachmentPreview(path))
  ipcMain.handle(IpcChannel.LocalImagePreview, (_e, path: string) => localImagePreview(path))
  ipcMain.handle(IpcChannel.ChatAbort, (_e, sessionId: string) => runtime.abort(sessionId))
  ipcMain.handle(
    IpcChannel.ChatApprove,
    (_e, params: { sessionId: string; callId: string; decision: ApprovalDecision }) =>
      runtime.approve(params.sessionId, params.callId, params.decision)
  )

  ipcMain.handle(IpcChannel.BoardGet, () => board.get())
  ipcMain.handle(IpcChannel.BoardSave, (_e, next: Board) => board.save(next))

  // Learned-memory files (self-learning). Mutations return the refreshed list.
  ipcMain.handle(IpcChannel.MemoryList, () => runtime.memories.list())
  ipcMain.handle(
    IpcChannel.MemorySave,
    async (_e, p: { scope: MemoryScope; workspaceRoot: string | null; content: string }) => {
      await runtime.memories.save(p.scope, p.workspaceRoot, p.content)
      return runtime.memories.list()
    }
  )
  ipcMain.handle(
    IpcChannel.MemoryClear,
    async (_e, p: { scope: MemoryScope; workspaceRoot: string | null }) => {
      await runtime.memories.clear(p.scope, p.workspaceRoot)
      return runtime.memories.list()
    }
  )

  // File-explorer operations: stateless, sandboxed to the given workspace root.
  ipcMain.handle(IpcChannel.FsList, (_e, p: { workspaceRoot: string; relPath: string }) =>
    listDir(p.workspaceRoot, p.relPath)
  )
  ipcMain.handle(IpcChannel.FsCreateFile, (_e, p: { workspaceRoot: string; relPath: string }) =>
    createFile(p.workspaceRoot, p.relPath)
  )
  ipcMain.handle(IpcChannel.FsCreateDir, (_e, p: { workspaceRoot: string; relPath: string }) =>
    createDir(p.workspaceRoot, p.relPath)
  )
  ipcMain.handle(
    IpcChannel.FsRename,
    (_e, p: { workspaceRoot: string; fromRelPath: string; toRelPath: string }) =>
      renameEntry(p.workspaceRoot, p.fromRelPath, p.toRelPath)
  )
  ipcMain.handle(IpcChannel.FsDelete, (_e, p: { workspaceRoot: string; relPath: string }) =>
    deleteEntry(p.workspaceRoot, p.relPath)
  )

  ipcMain.handle(IpcChannel.UsageStats, () => runtime.getUsageStats())
  ipcMain.handle(IpcChannel.ConfigSetUserRules, async (_e, text: string) => {
    await writeUserRules(text)
    runtime.invalidateAgents()
    return safeConfig()
  })
  ipcMain.handle(
    IpcChannel.CheckpointsRestore,
    (
      _e,
      p: { sessionId: string; checkpointId: string; path?: string }
    ) => runtime.restoreCheckpoint(p.sessionId, p.checkpointId, p.path)
  )
  ipcMain.handle(
    IpcChannel.FsWriteFile,
    (_e, p: { workspaceRoot: string; relPath: string; content: string }) =>
      writeWorkspaceFile(p.workspaceRoot, p.relPath, p.content)
  )
  ipcMain.handle(
    IpcChannel.WorkspaceOpenInEditor,
    (_e, p: { workspaceRoot: string; relPath: string; line?: number }) =>
      openInEditor(p.workspaceRoot, p.relPath, p.line)
  )
  ipcMain.handle(
    IpcChannel.GitCommit,
    (_e, p: { workspaceRoot: string; message: string; paths: string[] }) =>
      runtime.gitCommit(p.workspaceRoot, p.message, p.paths)
  )
  ipcMain.handle(
    IpcChannel.GitSuggestMessage,
    (_e, p: { sessionId: string; workspaceRoot: string }) =>
      runtime.suggestCommitMessage(p.sessionId, p.workspaceRoot)
  )

  ipcMain.handle(IpcChannel.ProxyStart, () => proxy.start())
  ipcMain.handle(IpcChannel.ProxyStop, () => proxy.stop())
  ipcMain.handle(IpcChannel.ProxyStatus, () => proxy.status())

  ipcMain.handle(IpcChannel.OAuthStart, async () => {
    if (!deps.oauth) throw new Error('OAuth is not available in this build.')
    await deps.oauth.start()
    return safeConfig()
  })

  ipcMain.handle(IpcChannel.OAuthSignOut, async () => {
    if (deps.oauth) await deps.oauth.signOut()
    runtime.invalidateAgents()
    return safeConfig()
  })
}
