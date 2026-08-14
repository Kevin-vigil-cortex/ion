/**
 * Verifies the xAI client translates domain items to a Responses request and
 * parses a streamed SSE response into ModelEvents — using a fake fetch, so no
 * network or key is needed.
 */
import {
  XaiModelClient,
  ApiKeyCredentials,
  getModelMetadata,
  selectableModels,
  FALLBACK_MODELS,
  REASONING_EFFORTS
} from '@ion/xai'
import { estimateCostUsd, type ModelEvent } from '@ion/agent'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9
}

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e))
      controller.close()
    }
  })
}

async function main(): Promise<void> {
  let captured: { url: string; body: unknown; headers: Record<string, string> } | null = null

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    captured = {
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers as Record<string, string>) ?? {}
    }
    const body = sseStream([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1","name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1200,"output_tokens":345,"total_tokens":1545,"input_tokens_details":{"cached_tokens":100},"output_tokens_details":{"reasoning_tokens":40}}}}\n\n'
    ])
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  const client = new XaiModelClient({
    credentials: new ApiKeyCredentials('xai-test-key'),
    fetchImpl: fakeFetch
  })

  const events: ModelEvent[] = []
  for await (const ev of client.stream({
    model: 'grok-4.6',
    items: [
      { kind: 'message', role: 'user', content: 'read a.txt' },
      { kind: 'tool_call', callId: 'x', name: 'read_file', arguments: '{}' },
      { kind: 'tool_result', callId: 'x', output: 'contents', isError: false }
    ],
    tools: [
      {
        name: 'read_file',
        description: 'read',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    ]
  })) {
    events.push(ev)
  }

  // Request shaping
  assert(captured !== null, 'fetch should have been called')
  const cap = captured as unknown as { url: string; body: any; headers: Record<string, string> }
  assert(cap.url.endsWith('/responses'), 'should POST to /responses')
  assert(cap.headers.Authorization === 'Bearer xai-test-key', 'auth header should carry the key')
  assert(cap.body.stream === true, 'request should be streaming')
  assert(cap.body.input[1].type === 'function_call', 'tool_call maps to function_call')
  assert(
    cap.body.input[2].type === 'function_call_output',
    'tool_result maps to function_call_output'
  )
  assert(cap.body.tools[0].type === 'function', 'tools are function-typed for Responses API')

  // Response parsing
  const text = events
    .filter((e) => e.type === 'text_delta')
    .map((e) => (e.type === 'text_delta' ? e.text : ''))
    .join('')
  assert(text === 'Hello there', `expected streamed text, got "${text}"`)
  const toolCall = events.find((e) => e.type === 'tool_call')
  assert(toolCall && toolCall.type === 'tool_call' && toolCall.name === 'read_file', 'tool_call parsed')
  const done = events.find((e) => e.type === 'done')
  assert(done && done.type === 'done' && done.finishReason === 'tool_calls', 'done reason tool_calls')

  // Usage reporting: response.completed carries response.usage.{input,output}_tokens.
  const usage = events.find((e) => e.type === 'usage')
  assert(usage && usage.type === 'usage', 'usage event emitted from response.completed')
  if (usage && usage.type === 'usage') {
    assert(usage.inputTokens === 1200, `usage.inputTokens: ${usage.inputTokens}`)
    assert(usage.outputTokens === 345, `usage.outputTokens: ${usage.outputTokens}`)
    assert(usage.cachedInputTokens === 100, 'cached input tokens parsed')
    assert(usage.reasoningTokens === 40, 'reasoning tokens parsed')
    assert(
      events.indexOf(usage) < events.indexOf(done!),
      'usage arrives before done'
    )
  }

  // Cost math against the published grok-4.6 rates ($2/M in, $6/M out; 2x >= 200k prompt).
  const meta46 = getModelMetadata('grok-4.6')
  assert(meta46.contextWindow === 500_000, 'grok-4.6 context window is 500k')
  assert(
    approx(estimateCostUsd(meta46.pricing, 100_000, 50_000), 0.2 + 0.3),
    'base-tier cost: 100k in + 50k out on grok-4.6 = $0.50'
  )
  assert(
    approx(estimateCostUsd(meta46.pricing, 250_000, 10_000), 250_000 * 4e-6 + 10_000 * 12e-6),
    'long-context tier kicks in at >= 200k prompt tokens (4/12 per MTok)'
  )
  assert(
    approx(estimateCostUsd(meta46.pricing, 1200, 345), 1200 * 2e-6 + 345 * 6e-6),
    'cost for the streamed usage above = $0.00447'
  )
  assert(
    approx(estimateCostUsd(meta46.pricing, 1200, 345, 100), 1100 * 2e-6 + 100 * 0.5e-6 + 345 * 6e-6),
    'cached input tokens bill at the cached rate'
  )
  assert(getModelMetadata('grok-4.5-latest').contextWindow === 500_000, 'alias resolves via prefix')
  assert(
    getModelMetadata('grok-unknown-model').contextWindow === 256_000,
    'unknown models fall back to conservative defaults'
  )

  // Grok request tuning: deterministic default temperature, parallel tool
  // calls advertised, reasoning effort only for models that support it.
  assert(cap.body.temperature === 0.2, `default temperature 0.2, got ${cap.body.temperature}`)
  assert(cap.body.store === false, 'store:false — no server-side transcript')
  assert(!cap.body.include, 'do not request encrypted reasoning (replay 400s as compaction blobs)')
  assert(cap.body.max_tool_calls === 8, 'max_tool_calls caps a single response')
  assert(cap.body.parallel_tool_calls === true, 'parallel_tool_calls passed through')
  assert(
    cap.body.reasoning && cap.body.reasoning.effort === 'medium',
    'grok-4.6 gets reasoning.effort=medium by default'
  )

  await testImageToolResultTranslation()
  await testUserAttachmentTranslation()
  await testUploadFile()
  await testReasoningReplay()
  await testRetryOn429()
  await testEffortSelection()
  testSelectableModels()

  console.log('smoke-xai: PASS (events:', events.length, ')')
}

/** A configured reasoningEffort must reach the request body for grok-4.5/4.6. */
async function testEffortSelection(): Promise<void> {
  let body: any = null
  const fakeFetch: typeof fetch = async (_input, init) => {
    body = init?.body ? JSON.parse(String(init.body)) : null
    return new Response(
      sseStream(['event: response.completed\ndata: {"type":"response.completed","response":{"id":"r4"}}\n\n']),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
  }
  const client = new XaiModelClient({
    credentials: new ApiKeyCredentials('xai-test-key'),
    fetchImpl: fakeFetch,
    reasoningEffort: 'xhigh'
  })
  for await (const _ of client.stream({ model: 'grok-4.6', items: [], tools: [] })) void _
  assert(
    body.reasoning && body.reasoning.effort === 'xhigh',
    `configured effort reaches the request, got ${JSON.stringify(body.reasoning)}`
  )
}

/** The app-facing model list is exactly the two reasoning flagships. */
function testSelectableModels(): void {
  const live = [
    { id: 'grok-4.3' },
    { id: 'grok-4.6-20260801' },
    { id: 'grok-4.6' },
    { id: 'grok-code-fast-1' },
    { id: 'grok-4.5' },
    { id: 'grok-4.20-multi-agent' }
  ]
  const picked = selectableModels(live)
  assert(picked.length === 2, `only the two flagships offered, got ${picked.length}`)
  assert(picked[0]!.id === 'grok-4.6' && picked[1]!.id === 'grok-4.5', 'grok-4.6 first, then 4.5')
  assert(
    picked[0]!.efforts?.length === REASONING_EFFORTS.length,
    'grok-4.6 offers all four effort levels'
  )
  assert(
    picked[1]!.efforts?.length === 3 && !picked[1]!.efforts.includes('xhigh'),
    'grok-4.5 tops out at high (xhigh is 4.6+ only)'
  )
  const empty = selectableModels([{ id: 'grok-image-1' }])
  assert(empty === FALLBACK_MODELS, 'listing without flagships falls back to the static pair')
  assert(
    FALLBACK_MODELS.length === 2 &&
      FALLBACK_MODELS[0]!.efforts?.length === 4 &&
      FALLBACK_MODELS[1]!.efforts?.length === 3,
    'fallback list mirrors the per-family effort support'
  )
}

/** Encrypted reasoning items must be echoed back so Grok keeps tool-loop CoT. */
async function testReasoningReplay(): Promise<void> {
  let body: any = null
  const events: ModelEvent[] = []
  const fakeFetch: typeof fetch = async (_input, init) => {
    body = init?.body ? JSON.parse(String(init.body)) : null
    return new Response(
      sseStream([
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","encrypted_content":"enc-blob"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r5"}}\n\n'
      ]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
  }
  const client = new XaiModelClient({
    credentials: new ApiKeyCredentials('xai-test-key'),
    fetchImpl: fakeFetch
  })
  for await (const ev of client.stream({
    model: 'grok-4.6',
    items: [
      { kind: 'message', role: 'user', content: 'go' },
      { kind: 'reasoning', id: 'rs_prev', encryptedContent: 'prev-blob' }
    ],
    tools: []
  })) {
    events.push(ev)
  }
  assert(
    !body.input.some((i: { type?: string }) => i.type === 'reasoning'),
    'reconstructed reasoning items must not be sent (xAI compaction-blob 400)'
  )
  const captured = events.find((e) => e.type === 'reasoning_item')
  assert(
    captured && captured.type === 'reasoning_item' && captured.encryptedContent === 'enc-blob',
    'streamed reasoning item is still parsed if the API sends one'
  )
}

/**
 * A tool_result carrying images must expand into function_call_output plus a
 * follow-up user message with input_image data-URI parts (Grok 4 vision).
 */
async function testImageToolResultTranslation(): Promise<void> {
  let body: any = null
  const fakeFetch: typeof fetch = async (_input, init) => {
    body = init?.body ? JSON.parse(String(init.body)) : null
    return new Response(
      sseStream(['event: response.completed\ndata: {"type":"response.completed","response":{"id":"r2"}}\n\n']),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
  }
  const client = new XaiModelClient({
    credentials: new ApiKeyCredentials('xai-test-key'),
    fetchImpl: fakeFetch
  })
  const events: ModelEvent[] = []
  for await (const ev of client.stream({
    model: 'grok-4.3',
    items: [
      { kind: 'message', role: 'user', content: 'screenshot the page' },
      { kind: 'tool_call', callId: 's1', name: 'browser_screenshot', arguments: '{}' },
      {
        kind: 'tool_result',
        callId: 's1',
        output: 'Screenshot captured.',
        isError: false,
        images: [{ mimeType: 'image/png', base64: 'aGVsbG8=' }]
      }
    ],
    tools: []
  })) {
    events.push(ev)
  }

  assert(body.input.length === 4, `image result expands to 4 input items, got ${body.input.length}`)
  assert(body.input[2].type === 'function_call_output', 'function_call_output kept text-only')
  assert(body.input[2].output === 'Screenshot captured.', 'text output preserved')
  const followUp = body.input[3]
  assert(followUp.role === 'user' && Array.isArray(followUp.content), 'follow-up user message with parts')
  const imgPart = followUp.content.find((p: any) => p.type === 'input_image')
  assert(
    imgPart && imgPart.image_url === 'data:image/png;base64,aGVsbG8=' && imgPart.detail === 'high',
    'input_image part carries base64 data URI at high detail'
  )
  assert(body.reasoning === undefined, 'grok-4.3 gets no reasoning.effort param')
  assert(events.some((e) => e.type === 'done'), 'stream completes')
}

/** User-dropped images and uploaded docs become input_image / input_file parts. */
async function testUserAttachmentTranslation(): Promise<void> {
  let body: any = null
  const fakeFetch: typeof fetch = async (_input, init) => {
    body = init?.body ? JSON.parse(String(init.body)) : null
    return new Response(
      sseStream(['event: response.completed\ndata: {"type":"response.completed","response":{"id":"r6"}}\n\n']),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
  }
  const client = new XaiModelClient({
    credentials: new ApiKeyCredentials('xai-test-key'),
    fetchImpl: fakeFetch
  })
  for await (const _ev of client.stream({
    model: 'grok-4.6',
    items: [
      {
        kind: 'message',
        role: 'user',
        content: 'what is this?',
        attachments: [
          {
            id: 'a1',
            name: 'shot.png',
            mimeType: 'image/png',
            kind: 'image',
            path: '/tmp/shot.png',
            base64: 'aGVsbG8='
          },
          {
            id: 'a2',
            name: 'notes.pdf',
            mimeType: 'application/pdf',
            kind: 'file',
            path: '/tmp/notes.pdf',
            fileId: 'file-abc'
          }
        ]
      }
    ],
    tools: []
  })) {
    // drain
  }
  const msg = body.input[0]
  assert(Array.isArray(msg.content), 'attached user message uses content parts')
  assert(
    msg.content.some((p: { type?: string; text?: string }) => p.type === 'input_text' && p.text === 'what is this?'),
    'text part preserved'
  )
  assert(
    msg.content.some(
      (p: { type?: string; image_url?: string }) =>
        p.type === 'input_image' && p.image_url === 'data:image/png;base64,aGVsbG8='
    ),
    'image attachment becomes input_image'
  )
  assert(
    msg.content.some((p: { type?: string; file_id?: string }) => p.type === 'input_file' && p.file_id === 'file-abc'),
    'document attachment becomes input_file'
  )
}

async function testUploadFile(): Promise<void> {
  let url = ''
  let isForm = false
  const fakeFetch: typeof fetch = async (input, init) => {
    url = String(input)
    isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData
    return new Response(JSON.stringify({ id: 'file-99', filename: 'doc.txt' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  const client = new XaiModelClient({
    credentials: new ApiKeyCredentials('xai-test-key'),
    fetchImpl: fakeFetch
  })
  const id = await client.uploadFile(new TextEncoder().encode('hi'), 'doc.txt')
  assert(id === 'file-99', 'uploadFile returns the file id')
  assert(url.endsWith('/files'), `upload hits /files, got ${url}`)
  assert(isForm, 'upload sends multipart FormData')
}

/** 429s with Retry-After are retried with backoff until success. */
async function testRetryOn429(): Promise<void> {
  let attempts = 0
  const fakeFetch: typeof fetch = async () => {
    attempts++
    if (attempts <= 2) {
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
    }
    return new Response(
      sseStream([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r3"}}\n\n'
      ]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
  }
  const client = new XaiModelClient({
    credentials: new ApiKeyCredentials('xai-test-key'),
    fetchImpl: fakeFetch
  })
  let text = ''
  for await (const ev of client.stream({ model: 'grok-4.6', items: [], tools: [] })) {
    if (ev.type === 'text_delta') text += ev.text
  }
  assert(attempts === 3, `two 429s then success = 3 attempts, got ${attempts}`)
  assert(text === 'ok', 'stream succeeds after retries')

  // Aborts must NOT be retried.
  const controller = new AbortController()
  controller.abort()
  let aborted = false
  let abortAttempts = 0
  const abortFetch: typeof fetch = async () => {
    abortAttempts++
    throw new DOMException('aborted', 'AbortError')
  }
  const abortClient = new XaiModelClient({
    credentials: new ApiKeyCredentials('xai-test-key'),
    fetchImpl: abortFetch
  })
  try {
    for await (const _ of abortClient.stream({
      model: 'grok-4.6',
      items: [],
      tools: [],
      signal: controller.signal
    })) {
      void _
    }
  } catch {
    aborted = true
  }
  assert(aborted, 'aborted request throws')
  assert(abortAttempts <= 1, `aborts are not retried (attempts: ${abortAttempts})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
