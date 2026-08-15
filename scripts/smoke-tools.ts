/**
 * Smoke test for the browser-use / computer-use tool plumbing — no Electron,
 * no network. Exercises: factory registration, workspace-less availability,
 * approval gating (browser tools free, computer tools gated), screenshot
 * images flowing to the next model call, persist-stripping of base64,
 * the retained-image cap, and the long-session token budget.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentSession,
  SessionStore,
  defaultTools,
  codeReviewArgs,
  createBrowserTools,
  createComputerTools,
  type BrowserController,
  type ComputerController,
  type LanguageModel,
  type ModelEvent,
  type ModelStreamOptions,
  type ConversationItem,
  type AgentEvent
} from '@ion/agent'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Records every call; returns canned data. */
function mockBrowser(): { controller: BrowserController; calls: string[] } {
  const calls: string[] = []
  const controller: BrowserController = {
    async navigate(url) {
      calls.push(`navigate:${url}`)
      return { url, title: 'Example', canGoBack: false }
    },
    async snapshot() {
      calls.push('snapshot')
      return 'Page: Example (https://example.com)\n[e1] link "More information"'
    },
    async click(target) {
      calls.push(`click:${JSON.stringify(target)}`)
    },
    async type(text) {
      calls.push(`type:${text}`)
    },
    async pressKey(key) {
      calls.push(`press:${key}`)
    },
    async scroll() {
      calls.push('scroll')
    },
    async screenshot() {
      calls.push('screenshot')
      return { base64: PNG_BASE64, mimeType: 'image/png', path: '/tmp/fake.png' }
    },
    async back() {
      calls.push('back')
      return { url: 'https://example.com', title: 'Example', canGoBack: false }
    }
  }
  return { controller, calls }
}

function mockComputer(): { controller: ComputerController; calls: string[] } {
  const calls: string[] = []
  const controller: ComputerController = {
    async screenshot() {
      calls.push('screenshot')
      return { base64: PNG_BASE64, mimeType: 'image/png', path: '/tmp/screen.png', width: 100, height: 100 }
    },
    async moveMouse(x, y) {
      calls.push(`move:${x},${y}`)
    },
    async click(x, y) {
      calls.push(`click:${x},${y}`)
    },
    async type(text) {
      calls.push(`type:${text}`)
    },
    async pressKey(combo) {
      calls.push(`press:${combo}`)
    },
    async scroll() {
      calls.push('scroll')
    },
    async screenSize() {
      return { width: 1920, height: 1080 }
    }
  }
  return { controller, calls }
}

/** Registration + danger flags + workspace requirements. */
function registrationCheck(): void {
  const browser = createBrowserTools(mockBrowser().controller)
  const expectedBrowser = [
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_press_key',
    'browser_scroll',
    'browser_screenshot',
    'browser_back'
  ]
  assert(
    JSON.stringify(browser.map((t) => t.name)) === JSON.stringify(expectedBrowser),
    `browser tool set: ${browser.map((t) => t.name).join(',')}`
  )
  assert(browser.every((t) => t.dangerous === false), 'browser tools are non-dangerous')
  assert(browser.every((t) => t.requiresWorkspace === false), 'browser tools need no workspace')

  const computer = createComputerTools(mockComputer().controller)
  const expectedComputer = [
    'computer_screenshot',
    'computer_move_mouse',
    'computer_click',
    'computer_type',
    'computer_press_key',
    'computer_scroll'
  ]
  assert(
    JSON.stringify(computer.map((t) => t.name)) === JSON.stringify(expectedComputer),
    `computer tool set: ${computer.map((t) => t.name).join(',')}`
  )
  assert(computer.every((t) => t.dangerous === true), 'ALL computer tools are dangerous')
  assert(computer.every((t) => t.requiresWorkspace === false), 'computer tools need no workspace')
  console.log('smoke-tools: registration PASS')
}

/** CodeRabbit wrapper: argv + registry. Does not call the real CLI. */
function codeReviewCheck(): void {
  const tool = defaultTools.find((t) => t.name === 'code_review')
  assert(tool, 'code_review is in defaultTools')
  // Read-only locally, but it uploads the diff to CodeRabbit — approval-gated.
  assert(tool!.dangerous === true, 'code_review requires approval')
  assert(
    JSON.stringify(codeReviewArgs()) ===
      JSON.stringify(['review', '--agent', '--type', 'uncommitted']),
    'default review is uncommitted --agent'
  )
  assert(
    JSON.stringify(codeReviewArgs({ type: 'all', light: true, base: 'main' })) ===
      JSON.stringify(['review', '--agent', '--type', 'all', '--light', '--base', 'main']),
    'all + light + base flags'
  )
  assert(tool!.summarize({ type: 'committed', light: true }) === 'CodeRabbit committed light', 'summarize')
  console.log('smoke-tools: code-review PASS')
}

/**
 * Browser flow with NO workspace: tools offered, no approvals, screenshot
 * image reaches the next model call, base64 never persisted.
 */
async function browserFlowCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-browser-'))
  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: null, model: 'mock' })
  const { controller, calls } = mockBrowser()

  class BrowsingModel implements LanguageModel {
    readonly id = 'mock'
    turn = 0
    offeredTools: string[] = []
    sawImage = false
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      this.turn++
      if (this.turn === 1) {
        this.offeredTools = opts.tools.map((t) => t.name)
        yield {
          type: 'tool_call',
          callId: 'nav',
          name: 'browser_navigate',
          arguments: JSON.stringify({ url: 'https://example.com' })
        }
        yield {
          type: 'tool_call',
          callId: 'shot',
          name: 'browser_screenshot',
          arguments: '{}'
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        this.sawImage = opts.items.some(
          (i) => i.kind === 'tool_result' && Array.isArray(i.images) && i.images.length > 0
        )
        yield { type: 'text_delta', text: 'Saw the page.' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }

  const events: AgentEvent[] = []
  const model = new BrowsingModel()
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: createBrowserTools(controller),
    skillDiscover: { userRoots: [] },
    onEvent: (e) => events.push(e),
    requestApproval: async () => {
      throw new Error('browser tools must never request approval')
    }
  })
  await agent.send('open example.com and show me')

  assert(
    model.offeredTools.includes('browser_navigate') && model.offeredTools.includes('browser_screenshot'),
    'browser tools offered with no workspace open'
  )
  assert(calls.includes('navigate:https://example.com'), 'navigate reached the controller')
  assert(calls.includes('screenshot'), 'screenshot reached the controller')
  assert(model.sawImage, 'second model call must include the screenshot image')
  assert(
    !events.some((e) => e.type === 'tool_approval_request'),
    'no approval requests for browser tools'
  )
  const shotResult = events.find((e) => e.type === 'tool_result' && e.callId === 'shot')
  assert(
    shotResult && shotResult.type === 'tool_result' && shotResult.output.includes('/tmp/fake.png'),
    'screenshot tool output mentions the saved file path'
  )

  // Persisted JSON must NOT contain base64 image payloads.
  const raw = await readFile(join(dir, 'sessions', `${session.id}.json`), 'utf8')
  assert(!raw.includes(PNG_BASE64), 'base64 screenshot never hits disk')
  assert(!raw.includes('"images"'), 'images key stripped from persisted items')
  // ...while the in-memory session still carries it for the next call.
  assert(
    session.items.some((i) => i.kind === 'tool_result' && i.images?.length),
    'in-memory session retains the image'
  )

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-tools: browser-flow PASS')
}

/** Computer tools: approval gate blocks execution when denied. */
async function computerGateCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-computer-'))
  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: null, model: 'mock' })
  const { controller, calls } = mockComputer()

  class ClickingModel implements LanguageModel {
    readonly id = 'mock'
    turn = 0
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(): AsyncIterable<ModelEvent> {
      this.turn++
      if (this.turn === 1) {
        yield {
          type: 'tool_call',
          callId: 'click1',
          name: 'computer_click',
          arguments: JSON.stringify({ x: 10, y: 20 })
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }

  const events: AgentEvent[] = []
  const agent = new AgentSession({
    model: new ClickingModel(),
    store,
    session,
    tools: createComputerTools(controller),
    skillDiscover: { userRoots: [] },
    onEvent: (e) => events.push(e),
    requestApproval: async (req) => {
      assert(req.name === 'computer_click', `approval requested for ${req.name}`)
      return 'deny'
    }
  })
  await agent.send('click at 10,20')

  assert(
    events.some((e) => e.type === 'tool_approval_request' && e.name === 'computer_click'),
    'computer_click requires approval'
  )
  assert(calls.length === 0, 'denied computer_click must never touch the controller')
  const result = events.find((e) => e.type === 'tool_result' && e.callId === 'click1')
  assert(
    result && result.type === 'tool_result' && result.isError,
    'denied action surfaces as an error tool_result'
  )

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-tools: computer-gate PASS')
}

/** Only the newest 2 screenshots stay in model input; older base64 is dropped. */
async function imageCapCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-cap-'))
  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: null, model: 'mock' })

  // Seed history: three image-bearing tool results from "past" turns.
  for (let i = 0; i < 3; i++) {
    session.items.push({ kind: 'message', role: 'user', content: `turn ${i}` })
    session.items.push({ kind: 'tool_call', callId: `c${i}`, name: 'browser_screenshot', arguments: '{}' })
    session.items.push({
      kind: 'tool_result',
      callId: `c${i}`,
      output: `shot ${i}`,
      isError: false,
      images: [{ mimeType: 'image/png', base64: PNG_BASE64 }]
    })
  }

  class RecordingModel implements LanguageModel {
    readonly id = 'mock'
    items: ConversationItem[] = []
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      this.items = opts.items
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  const model = new RecordingModel()
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: [],
    skillDiscover: { userRoots: [] },
    onEvent: () => {},
    requestApproval: async () => 'deny'
  })
  await agent.send('what changed?')

  const withImages = model.items.filter(
    (i) => i.kind === 'tool_result' && Array.isArray(i.images) && i.images.length > 0
  )
  assert(withImages.length === 2, `only 2 newest screenshots retained, got ${withImages.length}`)
  const oldest = model.items.find((i) => i.kind === 'tool_result' && i.output === 'shot 0')
  assert(
    oldest && oldest.kind === 'tool_result' && !oldest.images,
    'oldest screenshot stripped from model input'
  )

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-tools: image-cap PASS')
}

/** Over-budget histories drop oldest items but keep the current turn. */
async function tokenBudgetCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-budget-'))
  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: null, model: 'mock' })

  // ~150k tokens per item (600k chars / 4) — three of these blow the 200k budget.
  const huge = 'x'.repeat(600_000)
  for (let i = 0; i < 3; i++) {
    session.items.push({ kind: 'message', role: 'user', content: `[old ${i}] ${huge}` })
    session.items.push({ kind: 'message', role: 'assistant', content: `ack ${i}` })
  }

  class RecordingModel implements LanguageModel {
    readonly id = 'mock'
    items: ConversationItem[] = []
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: 'mock' }]
    }
    async *stream(opts: ModelStreamOptions): AsyncIterable<ModelEvent> {
      this.items = opts.items
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  const model = new RecordingModel()
  const agent = new AgentSession({
    model,
    store,
    session,
    tools: [],
    skillDiscover: { userRoots: [] },
    onEvent: () => {},
    requestApproval: async () => 'deny'
  })
  await agent.send('current question')

  const sys = model.items[0]
  assert(sys && sys.kind === 'message' && sys.role === 'system', 'system message survives trimming')
  assert(
    !model.items.some((i) => i.kind === 'message' && i.content.startsWith('[old 0]')),
    'oldest over-budget item dropped'
  )
  assert(
    model.items.some((i) => i.kind === 'message' && i.content === 'current question'),
    'current turn always kept'
  )
  assert(
    model.items.length < 1 + session.items.length,
    'trimmed request is smaller than full history'
  )
  // Persisted transcript is untouched by trimming.
  const reloaded = await store.load(session.id)
  assert(
    reloaded !== null && reloaded.items.length === session.items.length,
    'full history still persisted'
  )

  await rm(dir, { recursive: true, force: true })
  console.log('smoke-tools: token-budget PASS')
}

/** User attachment base64 is stripped on persist; path/name stay. */
async function userAttachmentPersistCheck(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-smoke-att-'))
  const store = new SessionStore(join(dir, 'sessions'))
  const session = await store.create({ workspaceRoot: null, model: 'mock' })
  session.items.push({
    kind: 'message',
    role: 'user',
    content: 'see this',
    attachments: [
      {
        id: 'a1',
        name: 'shot.png',
        mimeType: 'image/png',
        kind: 'image',
        path: '/tmp/shot.png',
        base64: PNG_BASE64
      }
    ]
  })
  await store.save(session)
  const raw = await readFile(join(dir, 'sessions', `${session.id}.json`), 'utf8')
  assert(!raw.includes(PNG_BASE64), 'attachment base64 never hits disk')
  assert(raw.includes('shot.png'), 'attachment name persisted')
  assert(raw.includes('/tmp/shot.png'), 'attachment path persisted')
  await rm(dir, { recursive: true, force: true })
  console.log('smoke-tools: user-attachment-persist PASS')
}

async function main(): Promise<void> {
  registrationCheck()
  codeReviewCheck()
  await browserFlowCheck()
  await computerGateCheck()
  await imageCapCheck()
  await tokenBudgetCheck()
  await userAttachmentPersistCheck()
  console.log('smoke-tools: PASS')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
