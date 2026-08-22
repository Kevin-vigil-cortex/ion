import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type {
  LanguageModel,
  ConversationItem,
  TextMessage,
  ToolDef,
  ModelPricing,
  ToolResultImage,
  MessageAttachment,
  CheckpointItem,
  CheckpointFile
} from './types'
import type { Tool } from './tools/types'
import { toolMap, toToolDefs } from './tools/registry'
import type { AgentEvent, AgentEventHandler } from './events'
import type { Session, SessionStore } from './memory'
import { deriveTitle } from './memory'
import type { MemoryStore } from './learning'
import { createSaveMemoryTool } from './tools/save-memory'
import { createReadSkillTool } from './tools/read-skill'
import {
  discoverSkills,
  formatSkillCatalog,
  type DiscoverSkillsOptions
} from './skills'
import { buildSystemPrompt, buildMemorySection, type LearnedMemory } from './prompt'
import { loadProjectInstructions } from './project-instructions'
import { estimateTokens, estimateItemTokens, estimateCostUsd } from './usage'
import {
  FILE_MUTATORS,
  FILE_READERS,
  snapshotFile,
  buildCheckpointFile,
  restoreFiles,
  checkpointSummary,
  type FileSnapshot
} from './checkpoints'
import { collectDiagnostics } from './tools/diagnostics'

export type ApprovalDecision = 'approve' | 'approve_always' | 'deny'

export interface ApprovalRequest {
  callId: string
  name: string
  arguments: string
  summary: string
}

export interface AgentSessionOptions {
  model: LanguageModel
  store: SessionStore
  session: Session
  tools: Tool[]
  onEvent: AgentEventHandler
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>
  /**
   * Decides per tool whether a dangerous call skips the approval prompt.
   * Lets the host implement permission modes (ask / approve-for-me / full
   * access). Omit for the safest behavior: everything dangerous asks.
   */
  autoApprove?: (tool: Tool) => boolean
  /**
   * Send prior turns to the model (default true). When false, each send() starts
   * from a clean context: the model sees only the system prompt, the new user
   * message, and whatever the current turn produces (tool calls still work).
   * The persisted transcript is unaffected either way.
   */
  memoryEnabled?: boolean
  /**
   * Self-learning (distinct from `memoryEnabled` above): durable learnings from
   * `memoryStore` are injected into the system prompt and the `save_memory`
   * tool is offered so the model can add new ones. Requires `memoryStore`.
   * Default true when a store is provided.
   */
  learningEnabled?: boolean
  /** Where durable learnings live; omit to disable self-learning entirely. */
  memoryStore?: MemoryStore
  /**
   * Read-only planning mode: only non-mutating tools are offered (plus
   * open_workspace so the agent can open a project to read it) and the system
   * prompt instructs the model to explore, then produce an implementation
   * plan instead of making changes.
   */
  planMode?: boolean
  /**
   * Per-token pricing for the active model. When set, provider-reported usage
   * is converted to USD and accumulated on the session (API-key billing);
   * omit when tokens have no direct cost (e.g. subscription OAuth).
   */
  pricing?: ModelPricing
  /** Personal rules (~/.ion/user-rules.md), injected into the system prompt. */
  userRules?: string | null
  /** Extra home skill roots (tests). Omit to scan ~/.ion, ~/.cursor, ~/.claude, ~/.agents. */
  skillDiscover?: DiscoverSkillsOptions
  /** Safety cap on model<->tool round trips per user turn. */
  maxIterations?: number
}

/**
 * Drives one conversation. `send()` runs the full plan -> tool-call -> execute
 * -> reflect loop, persisting after every step and emitting UI events.
 */
export class AgentSession {
  private readonly model: LanguageModel
  private readonly store: SessionStore
  private readonly tools: Map<string, Tool>
  private readonly toolList: Tool[]
  private readonly onEvent: AgentEventHandler
  private readonly requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>
  private readonly autoApprove: (tool: Tool) => boolean
  private readonly memoryEnabled: boolean
  private readonly planMode: boolean
  private readonly learningStore: MemoryStore | null
  private readonly pricing: ModelPricing | null
  private readonly userRules: string | null
  private readonly skillDiscover: DiscoverSkillsOptions | undefined
  private readonly maxIterations: number
  private readonly alwaysAllowed = new Set<string>()

  private session: Session
  private controller: AbortController | null = null
  /** User messages injected mid-turn (Cmd+Enter steer). Flushed at the next iteration. */
  private pendingSteers: TextMessage[] = []
  /** Paths read or edited this send() - used to apply glob-gated rules. */
  private readonly turnTouched = new Set<string>()
  /** Pre-edit snapshots for write_file / edit_file this send(). */
  private readonly turnSnapshots = new Map<string, FileSnapshot>()
  /** Auto-injected get_diagnostics rounds this send() - capped so a red tsc can't loop forever. */
  private autoDiagRounds = 0

  constructor(opts: AgentSessionOptions) {
    this.model = opts.model
    this.store = opts.store
    this.session = opts.session
    this.learningStore = (opts.learningEnabled ?? true) ? (opts.memoryStore ?? null) : null
    this.skillDiscover = opts.skillDiscover
    // With learning on, offer save_memory alongside the host-provided tools.
    let tools = opts.tools
    if (this.learningStore && !tools.some((t) => t.name === 'save_memory')) {
      tools = [...tools, createSaveMemoryTool(this.learningStore)]
    }
    if (!tools.some((t) => t.name === 'read_skill')) {
      tools = [
        ...tools,
        createReadSkillTool(() => this.session.workspaceRoot, this.skillDiscover)
      ]
    }
    this.toolList = tools
    this.tools = toolMap(this.toolList)
    this.onEvent = opts.onEvent
    this.requestApproval = opts.requestApproval
    this.autoApprove = opts.autoApprove ?? (() => false)
    this.memoryEnabled = opts.memoryEnabled ?? true
    this.planMode = opts.planMode ?? false
    this.pricing = opts.pricing ?? null
    this.userRules = opts.userRules ?? null
    this.maxIterations = opts.maxIterations ?? 25
  }

  getSession(): Session {
    return this.session
  }

  abort(): void {
    this.controller?.abort()
  }

  /** True while send() is in the plan → tool → reflect loop. */
  isRunning(): boolean {
    return this.controller !== null
  }

  /**
   * Queue a user message for the next tool-loop iteration. Lands after the
   * current model call / tool batch - not a new turn. No-op text is ignored.
   */
  async steer(userText: string, attachments?: MessageAttachment[]): Promise<void> {
    const prepared = attachments?.length ? await this.prepareAttachments(attachments) : undefined
    const content = userText.trim() || describeAttachments(prepared)
    if (!content && !prepared?.length) return
    this.pendingSteers.push({
      kind: 'message',
      role: 'user',
      content,
      ...(prepared && prepared.length > 0 ? { attachments: prepared } : {})
    })
  }

  /**
   * Restore files from a turn checkpoint. `path` restores one file; omit for all.
   * Safe to call while idle - mid-turn restore is allowed but unusual.
   */
  async restoreCheckpoint(checkpointId: string, path?: string): Promise<string[]> {
    const item = this.session.items.find(
      (i): i is CheckpointItem => i.kind === 'checkpoint' && i.id === checkpointId
    )
    if (!item) throw new Error('Checkpoint not found.')
    if (!this.session.workspaceRoot) throw new Error('No workspace folder is open.')
    const restored = await restoreFiles(this.session.workspaceRoot, item.files, path)
    item.restoredPaths = [...new Set([...(item.restoredPaths ?? []), ...restored])]
    await this.persist()
    this.emit({ type: 'checkpoint_restored', checkpointId, paths: restored })
    return restored
  }

  /** Move queued steers onto the transcript. Returns true when anything landed. */
  private takeSteers(): boolean {
    if (this.pendingSteers.length === 0) return false
    this.session.items.push(...this.pendingSteers)
    this.pendingSteers = []
    return true
  }

  private emit(event: AgentEvent): void {
    this.onEvent(event)
  }

  private async persist(): Promise<void> {
    await this.store.save(this.session)
  }

  /**
   * Workspace-bound tools are only offered when a workspace folder is open.
   * Plan mode drops every mutating tool (`dangerous` is exactly that set),
   * keeping open_workspace so the agent can open a project to read it.
   */
  private activeTools(): Tool[] {
    let list = this.toolList
    if (this.planMode) {
      // Keep open_workspace (open a project to read it) and code_review
      // (reads the diff, mutates nothing; approval still gates the upload).
      list = list.filter(
        (t) => !t.dangerous || t.name === 'open_workspace' || t.name === 'code_review'
      )
    }
    if (this.session.workspaceRoot) return list
    return list.filter((t) => t.requiresWorkspace === false)
  }

  /**
   * Load image bytes from disk and upload documents that don't have a file id
   * yet. Failures are non-fatal - the attachment still sits on the message.
   */
  private async prepareAttachments(atts: MessageAttachment[]): Promise<MessageAttachment[]> {
    const out: MessageAttachment[] = []
    for (const a of atts) {
      const next: MessageAttachment = { ...a }
      if (next.kind === 'image' && !next.base64 && next.path) {
        try {
          next.base64 = (await readFile(next.path)).toString('base64')
        } catch {
          // Missing file - model just won't see this image.
        }
      }
      if (
        (next.kind === 'file' || next.kind === 'video') &&
        !next.fileId &&
        next.path &&
        this.model.uploadFile
      ) {
        try {
          next.fileId = await this.model.uploadFile(await readFile(next.path), next.name)
        } catch {
          // Files API rejected it (common for raw video). Frames still go as images.
        }
      }
      out.push(next)
    }
    return out
  }

  /** Read durable learnings fresh so this turn sees anything saved since the last one. */
  private async loadLearnedMemory(): Promise<LearnedMemory | null> {
    if (!this.learningStore) return null
    const root = this.session.workspaceRoot
    return {
      global: await this.learningStore.readGlobal().catch(() => ''),
      workspace: root ? await this.learningStore.readWorkspace(root).catch(() => '') : null
    }
  }

  async send(userText: string, attachments?: MessageAttachment[]): Promise<void> {
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.turnTouched.clear()
    this.turnSnapshots.clear()
    this.autoDiagRounds = 0

    // A crash, rebuild, or abort can persist a function_call with no
    // function_call_output. xAI rejects the next request if we replay that.
    if (this.closeOrphanedToolCalls('This tool call was interrupted before a result was recorded. Retry if needed.')) {
      await this.persist()
    }

    // With memory off, the model's context starts at this turn's user message.
    const turnStart = this.session.items.length

    const prepared = attachments?.length ? await this.prepareAttachments(attachments) : undefined
    const content = userText.trim() || describeAttachments(prepared)
    const userMsg: TextMessage = {
      kind: 'message',
      role: 'user',
      content,
      ...(prepared && prepared.length > 0 ? { attachments: prepared } : {})
    }
    this.session.items.push(userMsg)
    if (this.session.title === 'New Chat') {
      this.session.title = deriveTitle(userText, prepared?.[0]?.name)
    }
    await this.persist()

    const learnedMemory = await this.loadLearnedMemory()
    // Freeze the date for this send() so the system prefix stays byte-identical
    // across tool-loop iterations (helps xAI prompt cache).
    const promptNow = new Date()

    try {
      let iter = 0
      for (; iter < this.maxIterations; iter++) {
        if (signal.aborted) break
        if (this.takeSteers()) await this.persist()

        this.emit({ type: 'status', status: 'thinking' })

        // Recomputed every iteration: open_workspace can unlock the
        // workspace-bound tools in the middle of a turn, and a newly
        // opened folder may have AGENTS.md the next request should see.
        const tools = this.activeTools()
        const toolDefs = toToolDefs(tools)
        const projectInstructions = this.session.workspaceRoot
          ? await loadProjectInstructions(this.session.workspaceRoot, {
              activePaths: [...this.turnTouched]
            })
          : null
        const skillCatalog = formatSkillCatalog(
          await discoverSkills(this.session.workspaceRoot, this.skillDiscover)
        )

        const systemMsg: TextMessage = {
          kind: 'message',
          role: 'system',
          content: buildSystemPrompt({
            workspaceRoot: this.session.workspaceRoot,
            toolNames: tools.map((t) => t.name),
            learnedMemory,
            planMode: this.planMode,
            now: promptNow,
            projectInstructions,
            userRules: this.userRules,
            skillCatalog
          })
        }
        // Vision hygiene: only the newest screenshots stay in model input.
        capRetainedImages(this.session.items)
        await hydrateAttachmentBytes(this.session.items)

        const rawHistory = this.memoryEnabled
          ? this.session.items
          : this.session.items.slice(turnStart)
        const history = rawHistory.filter((item) => item.kind !== 'checkpoint')
        const turnLen = this.session.items
          .slice(turnStart)
          .filter((item) => item.kind !== 'checkpoint').length
        // Long-session guard: drop oldest items once over the token budget,
        // always keeping the current turn intact.
        const trimmedHistory = fitContextBudget(history, turnLen)
        const items: ConversationItem[] = [systemMsg, ...trimmedHistory]

        this.emitContextStats(systemMsg.content, toolDefs, trimmedHistory, learnedMemory)

        let assistantText = ''
        const pendingCalls: { callId: string; name: string; arguments: string }[] = []
        const reasoningItems: Extract<ConversationItem, { kind: 'reasoning' }>[] = []
        let startedStreaming = false

        for await (const ev of this.model.stream({
          model: this.session.model,
          items,
          tools: toolDefs,
          signal
        })) {
          if (ev.type === 'text_delta') {
            if (!startedStreaming) {
              startedStreaming = true
              this.emit({ type: 'status', status: 'streaming' })
            }
            assistantText += ev.text
            this.emit({ type: 'assistant_text_delta', text: ev.text })
          } else if (ev.type === 'reasoning_delta') {
            this.emit({ type: 'assistant_reasoning_delta', text: ev.text })
          } else if (ev.type === 'reasoning_item') {
            reasoningItems.push({
              kind: 'reasoning',
              id: ev.id,
              encryptedContent: ev.encryptedContent,
              ...(ev.summary ? { summary: ev.summary } : {})
            })
          } else if (ev.type === 'tool_call') {
            pendingCalls.push({ callId: ev.callId, name: ev.name, arguments: ev.arguments })
          } else if (ev.type === 'usage') {
            await this.recordUsage(ev.inputTokens, ev.outputTokens, ev.cachedInputTokens)
          }
        }

        if (reasoningItems.length > 0) {
          this.session.items.push(...reasoningItems)
          await this.persist()
        }

        if (assistantText.trim().length > 0) {
          this.session.items.push({ kind: 'message', role: 'assistant', content: assistantText })
          this.emit({ type: 'assistant_message', content: assistantText })
          await this.persist()
        }

        if (pendingCalls.length === 0) {
          // Cmd+Enter during the last model call: keep the turn alive.
          if (this.takeSteers()) {
            await this.persist()
            continue
          }
          break
        }

        const batchMutated: string[] = []
        let batchAskedDiagnostics = false
        for (const call of pendingCalls) {
          if (signal.aborted) break
          if (call.name === 'get_diagnostics') batchAskedDiagnostics = true
          this.session.items.push({
            kind: 'tool_call',
            callId: call.callId,
            name: call.name,
            arguments: call.arguments
          })
          const tool = this.tools.get(call.name)
          const summary = this.summarizeCall(tool, call.name, call.arguments)
          this.emit({
            type: 'tool_call',
            callId: call.callId,
            name: call.name,
            arguments: call.arguments,
            summary
          })
          await this.persist()

          const result = await this.runTool(tool, call, summary, signal)
          if (FILE_MUTATORS.has(call.name) && !result.isError) {
            try {
              const path = JSON.parse(call.arguments).path
              if (typeof path === 'string') batchMutated.push(path)
            } catch {
              // ignore
            }
          }

          this.session.items.push({
            kind: 'tool_result',
            callId: call.callId,
            output: clipToolOutput(result.output),
            isError: result.isError,
            ...(result.images && result.images.length > 0 ? { images: result.images } : {})
          })
          this.emit({
            type: 'tool_result',
            callId: call.callId,
            output: result.output,
            isError: result.isError,
            meta: result.meta
          })
          await this.persist()
        }

        if (
          !signal.aborted &&
          !this.planMode &&
          batchMutated.length > 0 &&
          !batchAskedDiagnostics &&
          this.autoDiagRounds < 3 &&
          this.session.workspaceRoot &&
          this.tools.has('get_diagnostics')
        ) {
          await this.injectDiagnostics(batchMutated, signal)
        }
      }

      // Ran out of rounds mid-task: say so instead of stopping silently.
      if (iter >= this.maxIterations && !signal.aborted) {
        this.emit({
          type: 'error',
          message: `Stopped after ${this.maxIterations} tool rounds in one turn. Send a follow-up message to continue where it left off.`
        })
      }

      await this.flushCheckpoint()
      this.emit({ type: 'status', status: 'done' })
      this.emit({ type: 'done' })
    } catch (err) {
      // A user-initiated stop is a normal ending, not an error to display.
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        if (this.closeOrphanedToolCalls('Command was cancelled by the user.')) {
          await this.persist()
        }
        await this.flushCheckpoint()
        this.emit({ type: 'status', status: 'done' })
        this.emit({ type: 'done' })
      } else {
        await this.flushCheckpoint()
        const message = err instanceof Error ? err.message : String(err)
        this.emit({ type: 'error', message })
        this.emit({ type: 'status', status: 'error' })
      }
    } finally {
      if (this.takeSteers()) await this.persist()
      this.controller = null
    }
  }

  /** Estimate (chars/4) what this iteration's model input is made of. */
  private emitContextStats(
    systemPrompt: string,
    toolDefs: ToolDef[],
    history: ConversationItem[],
    learnedMemory: LearnedMemory | null
  ): void {
    const memoryTokens = learnedMemory
      ? estimateTokens(buildMemorySection(learnedMemory))
      : undefined
    const systemPromptTokens = Math.max(0, estimateTokens(systemPrompt) - (memoryTokens ?? 0))
    const toolDefTokens = toolDefs.length ? estimateTokens(JSON.stringify(toolDefs)) : 0
    const conversationTokens = history.reduce((n, item) => n + estimateItemTokens(item), 0)
    this.emit({
      type: 'context_stats',
      systemPromptTokens,
      toolDefTokens,
      ...(memoryTokens !== undefined ? { memoryTokens } : {}),
      conversationTokens,
      totalTokens:
        systemPromptTokens + toolDefTokens + (memoryTokens ?? 0) + conversationTokens
    })
  }

  /** Fold provider-reported usage into the session and surface it to the UI. */
  private async recordUsage(
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens?: number
  ): Promise<void> {
    const costUsd = this.pricing
      ? estimateCostUsd(this.pricing, inputTokens, outputTokens, cachedInputTokens)
      : 0
    const usage = this.session.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    usage.inputTokens += inputTokens
    usage.outputTokens += outputTokens
    usage.costUsd += costUsd
    this.session.usage = usage
    this.emit({
      type: 'usage',
      inputTokens,
      outputTokens,
      ...(this.pricing ? { costUsd } : {}),
      sessionInputTokens: usage.inputTokens,
      sessionOutputTokens: usage.outputTokens,
      ...(this.pricing ? { sessionCostUsd: usage.costUsd } : {})
    })
    await this.persist()
  }

  /**
   * Pair every tool_call with a tool_result. Returns true when the transcript
   * changed so the caller can persist. Emits tool_result events so a live UI
   * stops showing the call as still running.
   */
  private closeOrphanedToolCalls(reason: string): boolean {
    const closed = new Set<string>()
    for (const item of this.session.items) {
      if (item.kind === 'tool_result') closed.add(item.callId)
    }
    const orphans = this.session.items.filter(
      (item): item is Extract<ConversationItem, { kind: 'tool_call' }> =>
        item.kind === 'tool_call' && !closed.has(item.callId)
    )
    if (orphans.length === 0) return false
    for (const call of orphans) {
      this.session.items.push({
        kind: 'tool_result',
        callId: call.callId,
        output: reason,
        isError: true
      })
      this.emit({
        type: 'tool_result',
        callId: call.callId,
        output: reason,
        isError: true
      })
    }
    return true
  }

  private summarizeCall(tool: Tool | undefined, name: string, rawArgs: string): string {
    if (!tool) return `${name} (unknown tool)`
    try {
      return tool.summarize(JSON.parse(rawArgs))
    } catch {
      return name
    }
  }

  private async runTool(
    tool: Tool | undefined,
    call: { callId: string; name: string; arguments: string },
    summary: string,
    signal: AbortSignal
  ): Promise<{
    output: string
    isError: boolean
    meta?: Record<string, unknown>
    images?: ToolResultImage[]
  }> {
    if (!tool) {
      return { output: `Unknown tool "${call.name}".`, isError: true }
    }
    if (!this.session.workspaceRoot && tool.requiresWorkspace !== false) {
      return {
        output:
          'No workspace folder is open. Use find_path to locate the project folder, then open_workspace - file, search, and terminal tools unlock on the next tool round.',
        isError: true
      }
    }

    let args: Record<string, unknown>
    try {
      args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {}
    } catch {
      return { output: `Arguments were not valid JSON: ${call.arguments}`, isError: true }
    }

    if (tool.dangerous && !this.autoApprove(tool) && !this.alwaysAllowed.has(tool.name)) {
      this.emit({ type: 'status', status: 'awaiting_approval' })
      this.emit({
        type: 'tool_approval_request',
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
        summary
      })
      const decision = await this.requestApproval({
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
        summary
      })
      if (decision === 'deny') {
        return {
          output:
            'The user denied this action. Do not retry it unless they ask. Offer an alternative or ask what they would prefer.',
          isError: true
        }
      }
      if (decision === 'approve_always') this.alwaysAllowed.add(tool.name)
    }

    this.emit({ type: 'status', status: 'running_tool' })
    const relPath = typeof args.path === 'string' ? args.path : ''
    if (relPath && FILE_READERS.has(tool.name)) this.turnTouched.add(relPath)
    if (relPath && FILE_MUTATORS.has(tool.name) && this.session.workspaceRoot) {
      if (!this.turnSnapshots.has(relPath)) {
        const snap = await snapshotFile(this.session.workspaceRoot, relPath)
        this.turnSnapshots.set(relPath, { before: snap.content, skipped: snap.skipped })
      }
    }

    try {
      const result = await tool.execute(args, {
        workspaceRoot: this.session.workspaceRoot ?? '',
        signal
      })
      if (
        relPath &&
        FILE_MUTATORS.has(tool.name) &&
        this.session.workspaceRoot &&
        !(result.isError ?? false)
      ) {
        const snap = this.turnSnapshots.get(relPath)
        if (snap && !snap.skipped) {
          const after = await snapshotFile(this.session.workspaceRoot, relPath)
          snap.after = after.content
          snap.skipped = after.skipped
        }
      }
      return {
        output: result.output,
        isError: result.isError ?? false,
        meta: result.meta,
        images: result.images
      }
    } catch (err) {
      return { output: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  }

  /**
   * After file edits, run tsc/eslint/ruff and feed errors back as a synthetic
   * get_diagnostics result so the model can fix them without being asked.
   */
  private async injectDiagnostics(paths: string[], signal: AbortSignal): Promise<void> {
    if (!this.session.workspaceRoot) return
    const report = await collectDiagnostics(this.session.workspaceRoot, paths, signal)
    if (!report.hasErrors) return
    this.autoDiagRounds++
    const callId = `diag_${randomUUID()}`
    const args = JSON.stringify({ paths })
    this.session.items.push({
      kind: 'tool_call',
      callId,
      name: 'get_diagnostics',
      arguments: args
    })
    this.emit({
      type: 'tool_call',
      callId,
      name: 'get_diagnostics',
      arguments: args,
      summary: `diagnostics ${paths.join(' ')}`
    })
    this.session.items.push({
      kind: 'tool_result',
      callId,
      output: clipToolOutput(report.output),
      isError: true
    })
    this.emit({
      type: 'tool_result',
      callId,
      output: report.output,
      isError: true,
      meta: { hasErrors: true, auto: true }
    })
    await this.persist()
  }

  /** Persist a reviewable snapshot of every file this turn actually changed. */
  private async flushCheckpoint(): Promise<void> {
    if (this.turnSnapshots.size === 0 || !this.session.workspaceRoot) return
    const files: CheckpointFile[] = []
    for (const [path, snap] of this.turnSnapshots) {
      const built = buildCheckpointFile(path, snap.before, snap.after ?? snap.before, snap.skipped ?? false)
      if (built) files.push(built)
    }
    this.turnSnapshots.clear()
    if (files.length === 0) return
    const item: CheckpointItem = { kind: 'checkpoint', id: randomUUID(), files }
    this.session.items.push(item)
    await this.persist()
    this.emit({
      type: 'turn_changes',
      checkpointId: item.id,
      files: checkpointSummary(item)
    })
  }
}

/**
 * Rough context ceiling for one request (Grok 4.5/4.6 windows are 500k;
 * staying well under keeps headroom for tools + output and avoids the
 * long-context billing tier that starts at 200k prompt tokens).
 */
const CONTEXT_BUDGET_TOKENS = 200_000
/** How many image-bearing tool results keep their screenshots in model input. */
const MAX_RETAINED_IMAGES = 2
/** Cap tool output stored in the transcript so a 256KB read doesn't dominate every later request. */
const MAX_TRANSCRIPT_OUTPUT = 16 * 1024

function describeAttachments(atts: MessageAttachment[] | undefined): string {
  if (!atts || atts.length === 0) return ''
  const visible = atts.filter((a) => !a.silent)
  const names = (visible.length ? visible : atts).map((a) => a.name)
  if (names.length === 1) return `Look at this attachment: ${names[0]}`
  return `Look at these attachments: ${names.join(', ')}`
}

/** Reload image bytes from disk so reopened chats still send vision input. */
async function hydrateAttachmentBytes(items: ConversationItem[]): Promise<void> {
  for (const item of items) {
    if (item.kind !== 'message' || !item.attachments) continue
    for (const a of item.attachments) {
      if (a.kind !== 'image' || a.base64 || !a.path) continue
      try {
        a.base64 = (await readFile(a.path)).toString('base64')
      } catch {
        // File was deleted; skip.
      }
    }
  }
}

function clipToolOutput(output: string): string {
  if (output.length <= MAX_TRANSCRIPT_OUTPUT) return output
  return (
    output.slice(0, MAX_TRANSCRIPT_OUTPUT) +
    `\n\n[truncated for context - ${output.length} chars originally. Re-read with offset/limit or pipe the command to tail if you need the rest.]`
  )
}

/**
 * Strip base64 screenshots from all but the newest image-bearing tool
 * results. Old screenshots stop mattering fast (the page/screen has moved
 * on) and each one is hundreds of KB per request otherwise.
 */
function capRetainedImages(items: ConversationItem[]): void {
  let kept = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item || item.kind !== 'tool_result') continue
    if (!item.images || item.images.length === 0) continue
    kept++
    if (kept > MAX_RETAINED_IMAGES) delete item.images
  }
}

/**
 * Dead-simple token-budget guard for long sessions: estimate size (~4
 * chars/token via estimateItemTokens) and, when over budget, drop the
 * oldest items. The current turn (`protectedTail` items at the end) is
 * never dropped, and the result never leads with an orphaned tool_result
 * whose tool_call was trimmed away.
 */
function fitContextBudget(
  history: ConversationItem[],
  protectedTail: number
): ConversationItem[] {
  let total = 0
  for (const item of history) total += estimateItemTokens(item)
  if (total <= CONTEXT_BUDGET_TOKENS) return history

  const cutoff = Math.max(0, history.length - Math.max(protectedTail, 0))
  let start = 0
  while (start < cutoff && total > CONTEXT_BUDGET_TOKENS) {
    const dropped = history[start]
    if (!dropped) break
    total -= estimateItemTokens(dropped)
    start++
  }
  while (start < cutoff && history[start]?.kind === 'tool_result') start++
  return start === 0 ? history : history.slice(start)
}
