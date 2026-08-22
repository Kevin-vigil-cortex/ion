/**
 * End-to-end smoke test of the agent harness using a mock model - no network.
 * Exercises: streaming text, a read tool round-trip, a dangerous-tool approval
 * gate (deny), session persistence, and the event stream.
 */
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
import {
  AgentSession,
  SessionStore,
  MemoryStore,
  defaultTools,
  resolveInWorkspace,
  resolveUserPath,
  loadProjectInstructions,
  summarizeEdit,
  matchGlob,
  loadIgnoreSet,
  parseIgnoreContents,
  isSecretPath,
  formatGitDiff,
  commitPaths,
  collectDiagnostics,
  discoverSkills,
  formatSkillCatalog,
  expandActiveSkills,
  loadMcpConfig,
  interpolateMcpString,
  startMcpHub,
  mcpToolName,
  type Tool,
  type LanguageModel,
  type ModelEvent,
  type ModelStreamOptions,
  type ConversationItem,
  type AgentEvent
} from '@ion/agent'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

class MockModel implements LanguageModel {
  readonly id = 'mock'
  calls = 0
  lastItems: ConversationItem[] = []
  async listModels(): Promise<{ id: string }[]> {
    return [{ id: 'mock' }]
  }
  async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
    this.calls++
    this.lastItems = opts.items
    if (this.calls === 1) {
      yield { type: 'text_delta', text: 'Reading the file first.' }
      yield {
        type: 'tool_call',
        callId: 'call_read',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'hello.txt' })
      }
      yield { type: 'done', finishReason: 'tool_calls' }
    } else if (this.calls === 2) {
      // Should now see the tool result in the transcript.
      const hasResult = opts.items.some(
        (i) => i.kind === 'tool_result' && i.output.includes('hello world')
      )
      assert(hasResult, 'model should receive the read_file result on the second turn')
      yield { type: 'text_delta', text: 'It says hello world.' }
      yield {
        type: 'tool_call',
        callId: 'call_write',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'out.txt', content: 'nope' })
      }
      yield { type: 'done', finishReason: 'tool_calls' }
    } else {
      const denied = opts.items.some(
        (i) => i.kind === 'tool_result' && i.callId === 'call_write' && i.isError
      )
      assert(denied, 'the denied write should appear as an error tool_result')
      yield { type: 'text_delta', text: 'Understood, leaving it as is.' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }
}

/** Replies with plain text and records exactly what the model was shown. */
class RecordingModel implements LanguageModel {
  readonly id = 'mock'
  requests: ConversationItem[][] = []
  async listModels(): Promise<{ id: string }[]> {
    return [{ id: 'mock' }]
  }
  async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
    this.requests.push(opts.items)
    yield { type: 'text_delta', text: `reply ${this.requests.length}` }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/** With memory disabled, the model must only ever see the current turn. */
async function memoryOffCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-mem-'))
  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: null, model: 'mock' })

  const model = new RecordingModel()
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    memoryEnabled: false,
    onEvent: () => {},
    requestApproval: async () => 'deny'
  })

  await agent.send('first message')
  await agent.send('second message')

  const second = model.requests[1]
  assert(second !== undefined, 'model should have been called for the second turn')
  const userMsgs = second!.filter((i) => i.kind === 'message' && i.role === 'user')
  assert(
    userMsgs.length === 1,
    `memory off: model should see exactly 1 user message, got ${userMsgs.length}`
  )
  assert(
    !second!.some((i) => i.kind === 'message' && i.content.includes('first message')),
    'memory off: the prior turn must not be sent to the model'
  )
  assert(
    !second!.some((i) => i.kind === 'message' && i.role === 'assistant'),
    'memory off: prior assistant replies must not be sent to the model'
  )

  // The persisted transcript still keeps the full history for the UI.
  const reloaded = await store.load(session.id)
  assert(
    reloaded !== null && reloaded.items.length === 4,
    `transcript should keep all 4 items, got ${reloaded?.items.length ?? 'none'}`
  )

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: memory-off PASS')
}

/**
 * Closed self-learning loop: (a) the model saves a learning via save_memory
 * (no workspace needed; approval-gated), (b) a brand-new session sees it in
 * the system prompt, (c) with learning disabled there is no injection and no
 * tool.
 */
async function learningLoopCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-learn-'))
  const store = new SessionStore(join(dir, 'sessions'))
  const memory = new MemoryStore(join(dir, 'memory'))
  const LEARNING = 'The user prefers strict TypeScript and tabs over spaces'

  /** Records what the model was shown (items + offered tool names). */
  class CapturingModel implements LanguageModel {
    readonly id = 'mock'
    requests: { items: ConversationItem[]; toolNames: string[] }[] = []
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      this.requests.push({ items: opts.items, toolNames: opts.tools.map((t) => t.name) })
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  /** Turn 1: saves a global learning, then tries a workspace save (must fail - no workspace). */
  class SavingModel implements LanguageModel {
    readonly id = 'mock'
    calls = 0
    toolNames: string[] = []
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      this.calls++
      if (this.calls === 1) {
        this.toolNames = opts.tools.map((t) => t.name)
        yield {
          type: 'tool_call',
          callId: 'save_global',
          name: 'save_memory',
          arguments: JSON.stringify({ scope: 'global', content: LEARNING })
        }
        yield {
          type: 'tool_call',
          callId: 'save_ws',
          name: 'save_memory',
          arguments: JSON.stringify({ scope: 'workspace', content: 'no workspace is open' })
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: 'Saved for next time.' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }

  // (a) Save through the tool - with NO workspace open. save_memory is
  // approval-gated (persistent prompt-injection surface), so approve it here.
  const events: AgentEvent[] = []
  const approvalsRequested: string[] = []
  const saver = new SavingModel()
  const session1 = await store.create({ workspaceRoot: null, model: 'mock' })
  const agent1 = new AgentSession({
    model: saver,
    store,
    session: session1,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    memoryStore: memory,
    onEvent: (e) => events.push(e),
    requestApproval: async (req) => {
      approvalsRequested.push(req.name)
      return 'approve'
    }
  })
  await agent1.send('Remember: I prefer strict TypeScript')

  assert(
    saver.toolNames.includes('save_memory'),
    'save_memory should be offered even with no workspace open'
  )
  assert(
    !saver.toolNames.includes('read_file'),
    'workspace tools must not be offered without a workspace'
  )
  assert(
    saver.toolNames.includes('find_path'),
    'find_path must be offered without a workspace (project scouting)'
  )
  assert(
    approvalsRequested.includes('save_memory'),
    'save_memory must be approval-gated (persistent prompt-injection surface)'
  )
  const wsFail = events.find((e) => e.type === 'tool_result' && e.callId === 'save_ws')
  assert(
    wsFail && wsFail.type === 'tool_result' && wsFail.isError,
    'workspace-scoped save must fail cleanly when no workspace is open'
  )
  const globalMd = await readFile(join(dir, 'memory', 'global.md'), 'utf8')
  assert(globalMd.includes(LEARNING), 'global.md should contain the saved learning')
  assert(/^- \[\d{4}-\d{2}-\d{2}\] /m.test(globalMd), 'entries should be dated bullets')

  // (b) A brand-new session over the same store sees the learning in its prompt.
  const reader = new CapturingModel()
  const session2 = await store.create({ workspaceRoot: null, model: 'mock' })
  const agent2 = new AgentSession({
    model: reader,
    store,
    session: session2,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    memoryStore: memory,
    onEvent: () => {},
    requestApproval: async () => 'deny'
  })
  await agent2.send('hello again')

  const first = reader.requests[0]!.items[0]!
  assert(
    first.kind === 'message' && first.role === 'system',
    'first item sent to the model should be the system message'
  )
  assert(
    first.kind === 'message' && first.content.includes('## Learned memory'),
    'system prompt should contain the Learned memory section'
  )
  assert(
    first.kind === 'message' && first.content.includes(LEARNING),
    'a learning saved in session 1 must appear in session 2\'s system prompt'
  )

  // (c) Learning disabled: no injection and no save_memory tool.
  const wsRoot = await ensureDir(join(dir, 'ws'))
  const off = new CapturingModel()
  const session3 = await store.create({ workspaceRoot: wsRoot, model: 'mock' })
  const agent3 = new AgentSession({
    model: off,
    store,
    session: session3,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    learningEnabled: false,
    memoryStore: memory,
    onEvent: () => {},
    requestApproval: async () => 'deny'
  })
  await agent3.send('hi')

  const offSystem = off.requests[0]!.items[0]!
  assert(
    offSystem.kind === 'message' && !offSystem.content.includes('## Learned memory'),
    'learning off: no Learned memory section in the prompt'
  )
  assert(
    !off.requests[0]!.toolNames.includes('save_memory'),
    'learning off: save_memory must not be offered'
  )
  assert(
    off.requests[0]!.toolNames.includes('read_file'),
    'learning off: workspace tools still offered normally'
  )

  // Store-level: workspace files get a root header and prune oldest past the cap.
  for (let i = 0; i < 105; i++) await memory.append('workspace', `fact ${i}`, wsRoot)
  const wsMd = await memory.readWorkspace(wsRoot)
  assert(wsMd.startsWith(`# Memory for ${wsRoot}`), 'workspace file starts with its root header')
  const bullets = wsMd.split('\n').filter((l) => l.startsWith('- ')).length
  assert(bullets === 100, `workspace file should prune to 100 entries, got ${bullets}`)
  assert(
    wsMd.includes('] fact 104') && !wsMd.includes('] fact 4\n'),
    'newest entries kept, oldest pruned'
  )
  const listed = await memory.list()
  assert(
    listed.some((m) => m.scope === 'workspace' && m.workspaceRoot === wsRoot),
    'list() should map the workspace file back to its root'
  )

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: learning-loop PASS')
}

/**
 * write_file / edit_file snapshot the pre-edit file and restore it.
 */
async function checkpointCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-cp-'))
  const ws = await ensureDir(join(dir, 'ws'))
  await writeFile(join(ws, 'a.txt'), 'OLD\n', 'utf8')

  class WriteThenStop implements LanguageModel {
    readonly id = 'mock'
    calls = 0
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(): AsyncIterable<ModelEvent> {
      this.calls++
      if (this.calls === 1) {
        yield {
          type: 'tool_call',
          callId: 'w1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'a.txt', content: 'NEW\n' })
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: 'updated' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }

  const events: AgentEvent[] = []
  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: ws, model: 'mock' })
  const agent = new AgentSession({
    model: new WriteThenStop(),
    store,
    session,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    onEvent: (e) => events.push(e),
    requestApproval: async () => 'approve',
    autoApprove: () => true
  })
  await agent.send('rewrite a.txt')

  assert((await readFile(join(ws, 'a.txt'), 'utf8')) === 'NEW\n', 'write_file should land')
  const change = events.find((e) => e.type === 'turn_changes')
  assert(change && change.type === 'turn_changes', 'turn_changes event required')
  assert(change.files.some((f) => f.path === 'a.txt'), 'checkpoint lists a.txt')
  const persisted = await store.load(session.id)
  assert(
    persisted?.items.some((i) => i.kind === 'checkpoint'),
    'checkpoint item must persist'
  )

  await agent.restoreCheckpoint(change.checkpointId)
  assert((await readFile(join(ws, 'a.txt'), 'utf8')) === 'OLD\n', 'restore must write the old contents back')
  assert(
    events.some((e) => e.type === 'checkpoint_restored' && e.paths.includes('a.txt')),
    'restore emits checkpoint_restored'
  )

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: checkpoints PASS')
}

/** userRules land in the system prompt. */
async function userRulesCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-ur-'))
  class Capture implements LanguageModel {
    readonly id = 'mock'
    systemPrompt = ''
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      const first = opts.items[0]
      if (first?.kind === 'message' && first.role === 'system') this.systemPrompt = first.content
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }
  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: null, model: 'mock' })
  const model = new Capture()
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    onEvent: () => {},
    requestApproval: async () => 'deny',
    userRules: 'Never use emojis.'
  })
  await agent.send('hi')
  assert(model.systemPrompt.includes('User rules'), 'user-rules section present')
  assert(model.systemPrompt.includes('Never use emojis.'), 'user rule body present')
  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: user-rules PASS')
}

async function ignoreCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-ign-'))
  const ws = await ensureDir(join(dir, 'ws'))
  await writeFile(join(ws, '.cursorignore'), 'secret.txt\nprivate/\n', 'utf8')
  await writeFile(join(ws, 'secret.txt'), 'nope', 'utf8')
  await writeFile(join(ws, 'visible.txt'), 'ok', 'utf8')
  await writeFile(join(ws, '.env'), 'KEY=1', 'utf8')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(ws, 'private'), { recursive: true })
  await writeFile(join(ws, 'private', 'x.ts'), 'x', 'utf8')

  const ignore = await loadIgnoreSet(ws)
  assert(ignore.ignores('secret.txt'), 'cursorignore hides secret.txt from search')
  assert(ignore.ignores('private/x.ts'), 'cursorignore dir hides children')
  assert(!ignore.ignores('visible.txt'), 'visible.txt stays searchable')
  assert(ignore.blocksRead('secret.txt'), 'cursorignore blocks reads')
  assert(ignore.blocksRead('.env'), '.env is a secret')
  assert(!isSecretPath('.env.example'), '.env.example is not a secret')
  assert(parseIgnoreContents('!keep.txt\n').some((r) => r.negate), 'negation parsed')

  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: ws, model: 'mock' })
  class ReadSecret implements LanguageModel {
    readonly id = 'mock'
    calls = 0
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(): AsyncIterable<ModelEvent> {
      this.calls++
      if (this.calls === 1) {
        yield {
          type: 'tool_call',
          callId: 'r1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'secret.txt' })
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: 'blocked' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }
  const events: AgentEvent[] = []
  const agent = new AgentSession({
    model: new ReadSecret(),
    store,
    session,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    onEvent: (e) => events.push(e),
    requestApproval: async () => 'deny'
  })
  await agent.send('read secret')
  const result = events.find((e) => e.type === 'tool_result')
  assert(result && result.type === 'tool_result' && result.isError, 'read of ignored file must fail')
  assert(result.output.includes('Blocked'), 'error mentions ignore rules')

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: ignore PASS')
}

async function gitCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-git-'))
  const ws = await ensureDir(join(dir, 'ws'))
  await writeFile(join(ws, 'a.txt'), 'one\n', 'utf8')
  await execFileAsync('git', ['init'], { cwd: ws })
  await execFileAsync('git', ['config', 'user.email', 'ion@test'], { cwd: ws })
  await execFileAsync('git', ['config', 'user.name', 'Ion'], { cwd: ws })
  await execFileAsync('git', ['add', 'a.txt'], { cwd: ws })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: ws })
  await writeFile(join(ws, 'a.txt'), 'two\n', 'utf8')

  const diff = await formatGitDiff(ws)
  assert(diff.includes('two') || diff.includes('a.txt'), 'git_diff should show the working tree change')

  const committed = await commitPaths(ws, 'chore: bump a.txt', ['a.txt'])
  assert(committed.ok, `commit should succeed: ${committed.output}`)
  const clean = await formatGitDiff(ws)
  assert(clean.includes('clean') || !clean.includes('+two'), 'tree should be clean after commit')

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: git PASS')
}

async function skillsCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-skills-'))
  const userRoot = await ensureDir(join(dir, 'user-skills'))
  const ws = await ensureDir(join(dir, 'ws'))
  const isolated = { userRoots: [userRoot] }

  await ensureDir(join(userRoot, 'review'))
  await writeFile(
    join(userRoot, 'review', 'SKILL.md'),
    [
      '---',
      'name: review',
      'description: Review PRs carefully',
      '---',
      '',
      'Look at the user-level diff. Be mean.'
    ].join('\n'),
    'utf8'
  )
  await writeFile(
    join(userRoot, 'secret-sauce.md'),
    [
      '---',
      'name: secret-sauce',
      'description: Never auto-invoke this one',
      'disable-model-invocation: true',
      '---',
      '',
      'Hidden playbook body.'
    ].join('\n'),
    'utf8'
  )

  const userOnly = await discoverSkills(null, isolated)
  assert(userOnly.some((s) => s.name === 'review' && s.source === 'user'), 'user review skill')
  assert(userOnly.some((s) => s.name === 'secret-sauce' && s.disableModelInvocation), 'hidden skill flagged')

  await ensureDir(join(ws, '.cursor', 'skills', 'review'))
  await writeFile(
    join(ws, '.cursor', 'skills', 'review', 'SKILL.md'),
    [
      '---',
      'name: review',
      'description: >-',
      '  Project review style with a folded description',
      '---',
      '',
      'Use the project checklist.'
    ].join('\n'),
    'utf8'
  )
  await writeFile(join(ws, '.cursor', 'skills', 'review', 'checklist.md'), 'item 1\n', 'utf8')

  const skills = await discoverSkills(ws, isolated)
  const review = skills.find((s) => s.name === 'review')
  assert(review?.source === 'project', 'project skill overrides user skill of the same name')
  assert(review?.description.includes('Project review style'), 'folded YAML description parsed')
  assert(skills.some((s) => s.name === 'secret-sauce'), 'user-only skill still listed')

  const catalog = formatSkillCatalog(skills)
  assert(catalog !== null && catalog.includes('`review`'), 'catalog lists review')
  assert(catalog!.includes('Project review style'), 'catalog uses project description')
  assert(!catalog!.includes('secret-sauce'), 'disable-model-invocation omitted from catalog')
  assert(!catalog!.includes('Never auto-invoke'), 'hidden description stays out of catalog')

  const expanded = await expandActiveSkills(['review', 'secret-sauce'], ws, isolated)
  assert(expanded.includes('## Active skills'), 'attached skills get a header')
  assert(expanded.includes('Use the project checklist.'), 'project body wins on attach')
  assert(expanded.includes('Hidden playbook body.'), 'hidden skills still attach via /')

  class Capture implements LanguageModel {
    readonly id = 'mock'
    systemPrompt = ''
    toolNames: string[] = []
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      this.toolNames = opts.tools.map((t) => t.name)
      const first = opts.items[0]
      if (first?.kind === 'message' && first.role === 'system') this.systemPrompt = first.content
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: ws, model: 'mock' })
  const model = new Capture()
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: defaultTools,
    skillDiscover: isolated,
    onEvent: () => {},
    requestApproval: async () => 'deny'
  })
  await agent.send('hi')
  assert(model.toolNames.includes('read_skill'), 'read_skill is offered')
  assert(model.systemPrompt.includes('## Skills'), 'system prompt carries the catalog')
  assert(model.systemPrompt.includes('Project review style'), 'catalog uses project override')
  assert(!model.systemPrompt.includes('secret-sauce'), 'hidden skill stays out of the prompt')

  class SkillCaller implements LanguageModel {
    readonly id = 'mock'
    calls = 0
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(): AsyncIterable<ModelEvent> {
      this.calls++
      if (this.calls === 1) {
        yield {
          type: 'tool_call',
          callId: 'sk1',
          name: 'read_skill',
          arguments: JSON.stringify({ name: 'review' })
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else if (this.calls === 2) {
        yield {
          type: 'tool_call',
          callId: 'sk2',
          name: 'read_skill',
          arguments: JSON.stringify({ name: 'review', file: 'checklist.md' })
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else if (this.calls === 3) {
        yield {
          type: 'tool_call',
          callId: 'sk3',
          name: 'read_skill',
          arguments: JSON.stringify({ name: 'review', file: '../../hello.txt' })
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: 'loaded' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }

  const events: AgentEvent[] = []
  const caller = new SkillCaller()
  const session2 = await store.create({ workspaceRoot: ws, model: 'mock' })
  const agent2 = new AgentSession({
    model: caller,
    store,
    session: session2,
    tools: defaultTools,
    skillDiscover: isolated,
    onEvent: (e) => events.push(e),
    requestApproval: async () => 'deny'
  })
  await agent2.send('use the review skill')
  const results = events.filter((e) => e.type === 'tool_result')
  const body = results.find((e) => e.type === 'tool_result' && e.callId === 'sk1')
  assert(
    body && body.type === 'tool_result' && !body.isError && body.output.includes('Use the project checklist.'),
    'read_skill loads SKILL.md'
  )
  const companion = results.find((e) => e.type === 'tool_result' && e.callId === 'sk2')
  assert(
    companion && companion.type === 'tool_result' && !companion.isError && companion.output.includes('item 1'),
    'read_skill loads companion files'
  )
  const escaped = results.find((e) => e.type === 'tool_result' && e.callId === 'sk3')
  assert(escaped && escaped.type === 'tool_result' && escaped.isError, 'read_skill cannot escape the skill folder')

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: skills PASS')
}

async function mcpCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-mcp-'))
  const userFile = join(dir, 'user-mcp.json')
  const ws = await ensureDir(join(dir, 'ws'))
  const isolated = { userFiles: [userFile], trustProject: true }

  process.env.ION_MCP_TEST = 'from-env'
  assert(
    interpolateMcpString('${workspaceFolder}/x ${userHome} ${env:ION_MCP_TEST}', {
      workspaceRoot: '/proj'
    }).includes('/proj/x') &&
      interpolateMcpString('${userHome}', { workspaceRoot: null }).includes(homedir()) &&
      interpolateMcpString('${env:ION_MCP_TEST}', { workspaceRoot: null }) === 'from-env',
    'mcp.json interpolation'
  )

  await writeFile(
    userFile,
    JSON.stringify({
      mcpServers: {
        echo: { command: 'wrong', args: [] },
        hidden: { command: 'x', args: [], disabled: true },
        broken: { command: 'ion-mcp-does-not-exist', args: [] }
      }
    }),
    'utf8'
  )
  await ensureDir(join(ws, '.cursor'))
  const serverJs = join(dir, 'fake-mcp.mjs')
  await writeFile(serverJs, FAKE_MCP_SERVER, 'utf8')
  await writeFile(
    join(ws, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        echo: {
          command: process.execPath,
          args: [serverJs],
          autoApprove: ['ping']
        }
      }
    }),
    'utf8'
  )

  const specs = await loadMcpConfig(ws, isolated)
  const echo = specs.find((s) => s.name === 'echo')
  assert(echo?.source === 'project', 'project mcp.json overrides user server of the same name')
  assert(echo?.command === process.execPath, 'project command wins')
  assert(specs.some((s) => s.name === 'hidden' && s.disabled), 'disabled server still listed')
  assert(specs.some((s) => s.name === 'broken'), 'user-only server remains')

  const http = await listenFakeHttpMcp()
  await ensureDir(join(ws, '.ion'))
  await writeFile(
    join(ws, '.ion', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        remote: { url: http.url }
      }
    }),
    'utf8'
  )

  // Untrusted (the default): the repo's own servers are blocked - listed but
  // never started, and never allowed to hijack a user server's name.
  const untrusted = await loadMcpConfig(ws, { userFiles: [userFile] })
  const uEcho = untrusted.find((s) => s.name === 'echo')
  assert(
    uEcho?.source === 'user' && uEcho.command === 'wrong' && !uEcho.blocked,
    'untrusted: project cannot override a user server'
  )
  assert(
    untrusted.some((s) => s.name === 'remote' && s.blocked),
    'untrusted: project-only server is listed as blocked'
  )
  const blockedHub = await startMcpHub(ws, { userFiles: [join(dir, 'none.json')] })
  assert(
    blockedHub.status.length > 0 &&
      blockedHub.status.every((s) => s.status === 'blocked') &&
      blockedHub.tools.length === 0,
    'untrusted: hub starts nothing from the project mcp.json'
  )
  await blockedHub.close()

  const hub = await startMcpHub(ws, isolated)
  const echoStatus = hub.status.find((s) => s.name === 'echo')
  const hiddenStatus = hub.status.find((s) => s.name === 'hidden')
  const brokenStatus = hub.status.find((s) => s.name === 'broken')
  const remoteStatus = hub.status.find((s) => s.name === 'remote')
  assert(echoStatus?.status === 'connected' && (echoStatus.toolCount ?? 0) >= 2, 'stdio MCP connected')
  assert(hiddenStatus?.status === 'skipped', 'disabled MCP skipped')
  assert(brokenStatus?.status === 'error', 'missing command surfaces as error')
  assert(remoteStatus?.status === 'connected', `http MCP connected: ${remoteStatus?.error ?? ''}`)
  assert(
    hub.tools.some((t) => t.name === mcpToolName('echo', 'echo') && t.dangerous),
    'MCP tools are dangerous by default'
  )
  assert(
    hub.tools.some((t) => t.name === mcpToolName('echo', 'ping') && !t.dangerous),
    'autoApprove marks a tool safe'
  )

  class Capture implements LanguageModel {
    readonly id = 'mock'
    toolNames: string[] = []
    systemPrompt = ''
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      this.toolNames = opts.tools.map((t) => t.name)
      const first = opts.items[0]
      if (first?.kind === 'message' && first.role === 'system') this.systemPrompt = first.content
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: ws, model: 'mock' })
  const model = new Capture()
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: [...defaultTools, ...hub.tools],
    skillDiscover: { userRoots: [] },
    onEvent: () => {},
    requestApproval: async () => 'deny'
  })
  await agent.send('hi')
  assert(model.toolNames.includes(mcpToolName('echo', 'echo')), 'MCP tools offered to the model')
  assert(model.systemPrompt.includes('mcp_'), 'system prompt mentions MCP')

  class Caller implements LanguageModel {
    readonly id = 'mock'
    calls = 0
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(): AsyncIterable<ModelEvent> {
      this.calls++
      if (this.calls === 1) {
        yield {
          type: 'tool_call',
          callId: 'mcp1',
          name: mcpToolName('echo', 'echo'),
          arguments: JSON.stringify({ text: 'hello' })
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: 'done' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }

  const asked: string[] = []
  const events: AgentEvent[] = []
  const session2 = await store.create({ workspaceRoot: ws, model: 'mock' })
  const agent2 = new AgentSession({
    model: new Caller(),
    store,
    session: session2,
    tools: [...defaultTools, ...hub.tools],
    skillDiscover: { userRoots: [] },
    onEvent: (e) => events.push(e),
    requestApproval: async (req) => {
      asked.push(req.name)
      return 'approve'
    }
  })
  await agent2.send('echo hello')
  assert(asked.includes(mcpToolName('echo', 'echo')), 'dangerous MCP asks like the terminal')
  const result = events.find((e) => e.type === 'tool_result' && e.callId === 'mcp1')
  assert(
    result && result.type === 'tool_result' && !result.isError && result.output.includes('echo:hello'),
    'MCP tool call returns server output'
  )

  const planModel = new Capture()
  const planSession = await store.create({ workspaceRoot: ws, model: 'mock', mode: 'plan' })
  const planAgent = new AgentSession({
    model: planModel,
    store,
    session: planSession,
    tools: [...defaultTools, ...hub.tools],
    skillDiscover: { userRoots: [] },
    planMode: true,
    onEvent: () => {},
    requestApproval: async () => 'deny'
  })
  await planAgent.send('plan')
  assert(!planModel.toolNames.includes(mcpToolName('echo', 'echo')), 'plan mode drops dangerous MCP')
  assert(planModel.toolNames.includes(mcpToolName('echo', 'ping')), 'plan mode keeps autoApprove MCP')

  await hub.close()
  http.close()
  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: mcp PASS')
}

const FAKE_MCP_SERVER = `
process.stdin.setEncoding('utf8')
let buf = ''
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n')
}
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const i = buf.indexOf('\\n')
    if (i < 0) break
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } })
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'ping', description: 'Read-only ping', inputSchema: { type: 'object', properties: {} } }
      ] } })
    } else if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name
      const text = msg.params && msg.params.arguments && msg.params.arguments.text
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: name === 'echo' ? 'echo:' + String(text ?? '') : 'pong' }] } })
    }
  }
})
`

function listenFakeHttpMcp(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        let msg: { id?: number; method?: string } = {}
        try {
          msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as typeof msg
        } catch {
          msg = {}
        }
        res.setHeader('Content-Type', 'application/json')
        if (msg.method === 'initialize') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'httpfake' }
              }
            })
          )
          return
        }
        if (msg.method === 'notifications/initialized') {
          res.statusCode = 202
          res.end()
          return
        }
        if (msg.method === 'tools/list') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { tools: [{ name: 'now', description: 'Time', inputSchema: { type: 'object', properties: {} } }] }
            })
          )
          return
        }
        if (msg.method === 'tools/call') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: 'http-ok' }] }
            })
          )
          return
        }
        res.end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('http mcp listen failed'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close()
      })
    })
  })
}

async function diagnosticsCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-diag-'))
  const empty = await collectDiagnostics(dir)
  assert(!empty.hasErrors, 'empty folder is not an error')
  assert(empty.output.includes('No local diagnostics'), 'should explain missing runners')
  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: diagnostics PASS')
}

function diffGlobCheck(): void {
  const d = summarizeEdit('hello\nworld\n', 'hello\nthere\n', 'x.txt')
  assert(d.deletions === 1 && d.additions === 1, 'one line swapped')
  assert(d.diff.includes('-world'), 'diff shows deletion')
  assert(d.diff.includes('+there'), 'diff shows addition')
  assert(matchGlob('*.css', 'styles/app.css'), '*.css matches nested css')
  assert(!matchGlob('*.css', 'styles/app.ts'), '*.css does not match ts')
  assert(matchGlob('src/**/*.ts', 'src/a/b.ts'), '** glob matches')
  console.log('smoke-agent: diff-glob PASS')
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-'))
  const workspace = join(dir, 'ws')
  const sessionsDir = join(dir, 'sessions')
  await writeFile(join(await ensureDir(workspace), 'hello.txt'), 'hello world\n', 'utf8')

  const store = new SessionStore(sessionsDir)
  const session = await store.create({ workspaceRoot: workspace, model: 'mock' })

  const events: AgentEvent[] = []
  const model = new MockModel()
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    onEvent: (e) => events.push(e),
    // Deny the dangerous write to prove the approval gate blocks it.
    requestApproval: async (req) => {
      assert(req.name === 'write_file', 'only the write should require approval')
      return 'deny'
    }
  })

  await agent.send('Check hello.txt then try to overwrite out.txt')

  // The read tool actually ran and produced the file content.
  const toolResults = events.filter((e) => e.type === 'tool_result')
  assert(toolResults.length === 2, `expected 2 tool results, got ${toolResults.length}`)
  const readResult = toolResults.find(
    (e) => e.type === 'tool_result' && e.output.includes('hello world')
  )
  assert(readResult, 'read_file tool result should contain file contents')

  // The write was denied, so out.txt must NOT exist.
  let wrote = true
  try {
    await readFile(join(workspace, 'out.txt'), 'utf8')
  } catch {
    wrote = false
  }
  assert(!wrote, 'denied write_file must not create out.txt')

  // An approval request was emitted for the write.
  assert(
    events.some((e) => e.type === 'tool_approval_request' && e.name === 'write_file'),
    'an approval request should be emitted for write_file'
  )

  // Final assistant message present and session persisted.
  assert(
    events.some((e) => e.type === 'assistant_message' && e.content.includes('hello world')),
    'assistant should report file contents'
  )
  const reloaded = await store.load(session.id)
  assert(reloaded !== null && reloaded.items.length > 0, 'session should persist to disk')
  assert(model.calls === 3, `expected 3 model turns, got ${model.calls}`)

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: PASS (model turns:', model.calls, ', events:', events.length, ')')

  await memoryOffCheck()
  await learningLoopCheck()
  await sandboxCheck()
  await approvalModesCheck()
  await planModeCheck()
  await orphanedToolCallCheck()
  await userPathCheck()
  await projectInstructionsCheck()
  await steerCheck()
  await checkpointCheck()
  await userRulesCheck()
  await diffGlobCheck()
  await ignoreCheck()
  await gitCheck()
  await diagnosticsCheck()
  await skillsCheck()
  await mcpCheck()
}

/**
 * Plan mode: mutating tools (dangerous) are not offered - except
 * open_workspace (open a project to read) and code_review (reads the diff,
 * mutates nothing) - and the system prompt carries the read-only planning
 * instructions.
 */
async function planModeCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-plan-'))
  const store = new SessionStore(join(dir, 'sessions'))
  const ws = await ensureDir(join(dir, 'ws'))

  class Capture implements LanguageModel {
    readonly id = 'mock'
    toolNames: string[] = []
    systemPrompt = ''
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      this.toolNames = opts.tools.map((t) => t.name)
      const first = opts.items[0]
      if (first?.kind === 'message' && first.role === 'system') this.systemPrompt = first.content
      yield { type: 'text_delta', text: 'plan: ...' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  // Host-style open_workspace stand-in: dangerous but allowed in plan mode.
  const openWorkspace: Tool = {
    name: 'open_workspace',
    description: 'open a folder',
    dangerous: true,
    requiresWorkspace: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize: () => 'open workspace',
    execute: async () => ({ output: 'ok' })
  }

  const model = new Capture()
  const session = await store.create({ workspaceRoot: ws, model: 'mock', mode: 'plan' })
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: [...defaultTools, openWorkspace],
    skillDiscover: { userRoots: [] },
    planMode: true,
    onEvent: () => {},
    requestApproval: async () => 'deny'
  })
  await agent.send('how should we add feature X?')

  for (const banned of ['write_file', 'edit_file', 'run_terminal', 'save_memory', 'git_commit']) {
    assert(!model.toolNames.includes(banned), `plan mode must not offer ${banned}`)
  }
  for (const kept of [
    'read_file',
    'list_dir',
    'glob',
    'grep',
    'find_path',
    'open_workspace',
    'git_diff',
    'get_diagnostics',
    'code_review',
    'read_skill'
  ]) {
    assert(model.toolNames.includes(kept), `plan mode should still offer ${kept}`)
  }
  assert(model.systemPrompt.includes('PLAN MODE'), 'system prompt should carry plan instructions')

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: plan-mode PASS')
}

/**
 * Per-tool auto-approve hook (permission modes): with an 'approve for me'
 * style predicate, write_file runs without prompting while run_terminal
 * still asks.
 */
async function approvalModesCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-approve-'))
  const store = new SessionStore(join(dir, 'sessions'))
  const ws = await ensureDir(join(dir, 'ws'))

  class Model implements LanguageModel {
    readonly id = 'mock'
    calls = 0
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(_opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      this.calls++
      if (this.calls === 1) {
        yield {
          type: 'tool_call',
          callId: 'w1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'a.txt', content: 'hi' })
        }
        yield {
          type: 'tool_call',
          callId: 't1',
          name: 'run_terminal',
          arguments: JSON.stringify({ command: 'echo hi' })
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: 'done' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }

  const events: AgentEvent[] = []
  const asked: string[] = []
  const session = await store.create({ workspaceRoot: ws, model: 'mock' })
  const agent = new AgentSession({
    model: new Model(),
    store,
    session,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    onEvent: (e) => events.push(e),
    // 'Approve for me' shape: workspace edits skip the prompt, terminal asks.
    autoApprove: (t) => t.name !== 'run_terminal',
    requestApproval: async (req) => {
      asked.push(req.name)
      return 'deny'
    }
  })
  await agent.send('write then run')

  assert(!asked.includes('write_file'), 'auto-approved write_file must not prompt')
  assert(asked.includes('run_terminal'), 'run_terminal must still prompt')
  const write = events.find((e) => e.type === 'tool_result' && e.callId === 'w1')
  assert(write && write.type === 'tool_result' && !write.isError, 'write_file executed')
  const term = events.find((e) => e.type === 'tool_result' && e.callId === 't1')
  assert(term && term.type === 'tool_result' && term.isError, 'denied run_terminal errors')

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: approval-modes PASS')
}

/**
 * Workspace sandbox: lexical `..` traversal AND symlink escapes are blocked,
 * while benign in-workspace symlinks and not-yet-created paths still resolve.
 */
async function sandboxCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-sandbox-'))
  const ws = await ensureDir(join(dir, 'ws'))
  const outside = await ensureDir(join(dir, 'outside'))
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await writeFile(join(ws, 'inside.txt'), 'ok')
  await symlink(outside, join(ws, 'escape'))
  await symlink(join(ws, 'inside.txt'), join(ws, 'alias.txt'))

  const blocked = (input: string): boolean => {
    try {
      resolveInWorkspace(ws, input)
      return false
    } catch {
      return true
    }
  }

  assert(blocked('../outside/secret.txt'), 'lexical .. traversal must be blocked')
  assert(blocked(join(dir, 'outside', 'secret.txt')), 'absolute outside path must be blocked')
  assert(blocked('escape/secret.txt'), 'reading through an escaping symlink must be blocked')
  assert(blocked('escape'), 'the escaping symlink itself must be blocked')
  assert(!blocked('inside.txt'), 'plain in-workspace file must resolve')
  assert(!blocked('alias.txt'), 'benign in-workspace symlink must resolve')
  assert(!blocked('new-dir/todo.txt'), 'not-yet-created path must resolve (for writes)')

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: sandbox PASS')
}

/**
 * A persisted function_call with no function_call_output (crash / abort /
 * rebuild mid-tool) must be closed before the next model request. xAI 400s
 * unpaired calls.
 */
async function orphanedToolCallCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-orphan-'))
  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: null, model: 'mock' })
  session.items.push(
    { kind: 'message', role: 'user', content: 'old' },
    {
      kind: 'tool_call',
      callId: 'orphan',
      name: 'find_path',
      arguments: '{"query":"Aki"}'
    }
  )
  await store.save(session)

  const model = new RecordingModel()
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    onEvent: () => {},
    requestApproval: async () => 'deny'
  })
  await agent.send('continue')

  const first = model.requests[0]
  assert(first !== undefined, 'model should have been called')
  const results = first!.filter((i) => i.kind === 'tool_result' && i.callId === 'orphan')
  assert(results.length === 1, `orphaned tool_call must be closed, got ${results.length} results`)
  assert(results[0] && results[0].kind === 'tool_result' && results[0].isError, 'synthetic close is an error')

  const reloaded = await store.load(session.id)
  const persisted = reloaded?.items.filter((i) => i.kind === 'tool_result' && i.callId === 'orphan')
  assert(persisted?.length === 1, 'the synthetic result must be persisted')

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: orphaned-tool-call PASS')
}

/**
 * Repo briefs (AGENTS.md / CLAUDE.md / always-apply .cursor/rules) land in
 * the system prompt. Glob-gated rules stay out until we have file context.
 */
async function projectInstructionsCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-instr-'))
  const ws = await ensureDir(join(dir, 'ws'))
  const { mkdir } = await import('node:fs/promises')
  await writeFile(join(ws, 'AGENTS.md'), 'Always use tabs.', 'utf8')
  await writeFile(join(ws, 'CLAUDE.md'), 'Never invent APIs.', 'utf8')
  await mkdir(join(ws, '.cursor', 'rules'), { recursive: true })
  await writeFile(
    join(ws, '.cursor', 'rules', 'style.mdc'),
    '---\nalwaysApply: true\n---\nPrefer const.\n',
    'utf8'
  )
  await writeFile(
    join(ws, '.cursor', 'rules', 'css-only.mdc'),
    '---\nglobs: "*.css"\ndescription: CSS conventions\n---\nCSS-only rule body.\n',
    'utf8'
  )

  const loaded = await loadProjectInstructions(ws)
  assert(loaded !== null, 'should load project instructions')
  assert(loaded!.includes('Always use tabs.'), 'AGENTS.md must be included')
  assert(loaded!.includes('Never invent APIs.'), 'CLAUDE.md must be included')
  assert(loaded!.includes('Prefer const.'), 'alwaysApply rule must be included')
  assert(!loaded!.includes('CSS-only rule body.'), 'glob-gated rules stay out without a matching path')
  assert(loaded!.includes('CSS conventions'), 'unmatched glob rules appear in the optional index')

  const matched = await loadProjectInstructions(ws, { activePaths: ['styles/app.css'] })
  assert(matched!.includes('CSS-only rule body.'), 'glob rule applies when a touched path matches')

  const empty = await loadProjectInstructions(join(dir, 'empty-missing'))
  assert(empty === null, 'missing folder → no instructions')

  class Capture implements LanguageModel {
    readonly id = 'mock'
    systemPrompt = ''
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      const first = opts.items[0]
      if (first?.kind === 'message' && first.role === 'system') this.systemPrompt = first.content
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: ws, model: 'mock' })
  const model = new Capture()
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    onEvent: () => {},
    requestApproval: async () => 'deny'
  })
  await agent.send('hi')
  assert(model.systemPrompt.includes('Always use tabs.'), 'system prompt must carry AGENTS.md')
  assert(model.systemPrompt.includes('Project instructions'), 'section header present')

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: project-instructions PASS')
}

/**
 * steer() injects a user message into the current turn so the next model
 * call sees it - not a queued new send().
 */
async function steerCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-steer-'))
  const ws = await ensureDir(join(dir, 'ws'))
  await writeFile(join(ws, 'hello.txt'), 'hello\n', 'utf8')

  class Capture implements LanguageModel {
    readonly id = 'mock'
    calls = 0
    userTexts: string[][] = []
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      this.calls++
      this.userTexts.push(
        opts.items
          .filter((i): i is Extract<ConversationItem, { kind: 'message' }> => i.kind === 'message')
          .filter((i) => i.role === 'user')
          .map((i) => i.content)
      )
      if (this.calls === 1) {
        yield {
          type: 'tool_call',
          callId: 'c1',
          name: 'read_file',
          arguments: '{"path":"hello.txt"}'
        }
      } else {
        yield { type: 'text_delta', text: 'steered' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }

  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: ws, model: 'mock' })
  const model = new Capture()
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: defaultTools,
    skillDiscover: { userRoots: [] },
    onEvent: (e) => {
      if (e.type === 'tool_call' && e.name === 'read_file') {
        void agent.steer('use tabs not spaces')
      }
    },
    requestApproval: async () => 'deny'
  })
  await agent.send('read hello.txt')

  assert(model.calls === 2, `steer should keep the turn alive, got ${model.calls} calls`)
  const second = model.userTexts[1]
  assert(second !== undefined, 'second model call must exist')
  assert(
    second!.some((t) => t.includes('use tabs not spaces')),
    `second call must see the steer, got ${JSON.stringify(second)}`
  )
  assert(
    second!.some((t) => t.includes('read hello.txt')),
    'original user message still in context'
  )

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-agent: steer PASS')
}

/** Packaged-app PATH stub must still resolve Homebrew / nvm / /usr/local. */
function userPathCheck(): void {
  const stub = '/usr/bin:/bin:/usr/sbin:/sbin'
  const resolved = resolveUserPath(stub)
  assert(resolved.includes('/usr/bin'), 'system bins stay on PATH')
  assert(
    resolved.includes('/usr/local/bin') || resolved.includes('/opt/homebrew/bin') || resolved.includes('.nvm'),
    'user bins must be prepended when they exist on this machine'
  )
  console.log('smoke-agent: user-path PASS')
}

async function ensureDir(p: string): Promise<string> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(p, { recursive: true })
  return p
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
