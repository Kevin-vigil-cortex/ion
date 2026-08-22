import type { Tool } from './types'

/**
 * Browser-use tools. The agent core stays Electron-free: the desktop app
 * implements {@link BrowserController} over an embedded webview and injects
 * it via {@link createBrowserTools}. All tools are non-dangerous - they are
 * sandboxed to the embedded browser panel, never the user's own browser or
 * OS - and work without a workspace folder.
 */

/** A screenshot of the embedded browser viewport. */
export interface BrowserScreenshot {
  /** PNG image data. */
  base64: string
  mimeType: string
  /** Absolute path of the saved file, for the user's reference. */
  path: string
  width: number
  height: number
}

export interface BrowserPageInfo {
  url: string
  title: string
}

/**
 * The seam between the browser tools and the host. Implementations drive a
 * real embedded browser (the desktop app uses an Electron <webview> guest)
 * and are responsible for making the activity visible to the user (cursor
 * overlay, panel auto-open).
 */
export interface BrowserController {
  /** Load a URL and wait for the page to settle. */
  navigate(url: string): Promise<BrowserPageInfo>
  /** Compact outline of interactive elements (with refs) plus visible text. */
  snapshot(): Promise<string>
  /** Click an element by snapshot ref, or a viewport coordinate. */
  click(target: { ref?: string; x?: number; y?: number }): Promise<string>
  /** Type text into the focused element, or focus `ref` first. */
  type(text: string, ref?: string): Promise<string>
  /** Press a key or combo, e.g. "Enter", "Tab", "cmd+a". */
  pressKey(key: string): Promise<string>
  /** Scroll the page by dy pixels, or bring a ref into view. */
  scroll(params: { dy?: number; ref?: string }): Promise<string>
  /** Capture the visible viewport. */
  screenshot(): Promise<BrowserScreenshot>
  /** Go back in history. */
  back(): Promise<BrowserPageInfo>
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

/** Build the browser tool set over a host-provided controller. */
export function createBrowserTools(controller: BrowserController): Tool[] {
  const navigate: Tool = {
    name: 'browser_navigate',
    description:
      'Open a URL in the embedded browser panel (visible to the user). Waits for the page to load and returns its title and final URL. Use browser_snapshot afterwards to see the page content.',
    dangerous: false,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL, e.g. "https://example.com".' }
      },
      required: ['url'],
      additionalProperties: false
    },
    summarize: (args) => `browse: ${String(args.url ?? '')}`,
    async execute(args) {
      const url = str(args.url)
      if (!url) return { output: 'Missing required string argument "url".', isError: true }
      const info = await controller.navigate(url)
      return { output: `Loaded "${info.title}" at ${info.url}` }
    }
  }

  const snapshot: Tool = {
    name: 'browser_snapshot',
    description:
      'Capture a compact text outline of the current page: interactive elements (links, buttons, inputs) with stable refs like [e3], plus visible text. Always take a snapshot before clicking or typing so you know the refs. Refs are only valid until the next navigation or snapshot.',
    dangerous: false,
    requiresWorkspace: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize: () => 'browser snapshot',
    async execute() {
      return { output: await controller.snapshot() }
    }
  }

  const click: Tool = {
    name: 'browser_click',
    description:
      'Click an element in the embedded browser. Prefer passing a ref from the latest browser_snapshot (e.g. "e3"); alternatively pass viewport coordinates x,y in CSS pixels. The user watches the cursor move to the target.',
    dangerous: false,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the latest snapshot, e.g. "e3".' },
        x: { type: 'number', description: 'Viewport x in CSS pixels (when no ref).' },
        y: { type: 'number', description: 'Viewport y in CSS pixels (when no ref).' }
      },
      additionalProperties: false
    },
    summarize: (args) =>
      args.ref ? `click ${String(args.ref)}` : `click (${String(args.x)}, ${String(args.y)})`,
    async execute(args) {
      const ref = str(args.ref)
      const x = num(args.x)
      const y = num(args.y)
      if (!ref && (x === undefined || y === undefined)) {
        return { output: 'Pass either "ref" or both "x" and "y".', isError: true }
      }
      return { output: await controller.click({ ref, x, y }) }
    }
  }

  const type: Tool = {
    name: 'browser_type',
    description:
      'Type text into the embedded browser. Pass a ref from the latest snapshot to focus that field first (recommended); without a ref, types into the currently focused element. Does not press Enter - use browser_press_key for that.',
    dangerous: false,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type.' },
        ref: { type: 'string', description: 'Optional input ref from the latest snapshot.' }
      },
      required: ['text'],
      additionalProperties: false
    },
    summarize: (args) => `type "${truncate(String(args.text ?? ''), 40)}"`,
    async execute(args) {
      const text = typeof args.text === 'string' ? args.text : undefined
      if (text === undefined) {
        return { output: 'Missing required string argument "text".', isError: true }
      }
      return { output: await controller.type(text, str(args.ref)) }
    }
  }

  const pressKey: Tool = {
    name: 'browser_press_key',
    description:
      'Press a key or combo in the embedded browser, e.g. "Enter", "Tab", "Escape", "ArrowDown", "cmd+a". Useful for submitting forms after browser_type.',
    dangerous: false,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name or combo like "Enter" or "cmd+a".' }
      },
      required: ['key'],
      additionalProperties: false
    },
    summarize: (args) => `press ${String(args.key ?? '')}`,
    async execute(args) {
      const key = str(args.key)
      if (!key) return { output: 'Missing required string argument "key".', isError: true }
      return { output: await controller.pressKey(key) }
    }
  }

  const scroll: Tool = {
    name: 'browser_scroll',
    description:
      'Scroll the embedded browser page. Pass dy in pixels (positive scrolls down, negative up), or a ref from the latest snapshot to scroll that element into view.',
    dangerous: false,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        dy: { type: 'number', description: 'Vertical scroll amount in pixels.' },
        ref: { type: 'string', description: 'Element ref to scroll into view.' }
      },
      additionalProperties: false
    },
    summarize: (args) =>
      args.ref ? `scroll to ${String(args.ref)}` : `scroll ${String(args.dy ?? 0)}px`,
    async execute(args) {
      const dy = num(args.dy)
      const ref = str(args.ref)
      if (dy === undefined && !ref) {
        return { output: 'Pass "dy" (pixels) or "ref" (element to scroll into view).', isError: true }
      }
      return { output: await controller.scroll({ dy, ref }) }
    }
  }

  const screenshot: Tool = {
    name: 'browser_screenshot',
    description:
      'Capture a screenshot of the embedded browser viewport. The image is attached so you can see the rendered page - use it after significant UI changes or when a snapshot is ambiguous (canvas, images, complex layout).',
    dangerous: false,
    requiresWorkspace: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize: () => 'browser screenshot',
    async execute() {
      const shot = await controller.screenshot()
      return {
        output: `Screenshot captured (${shot.width}x${shot.height}), saved to ${shot.path}. The image is attached.`,
        images: [{ mimeType: shot.mimeType, base64: shot.base64 }],
        meta: { path: shot.path, width: shot.width, height: shot.height }
      }
    }
  }

  const back: Tool = {
    name: 'browser_back',
    description: 'Go back one page in the embedded browser history.',
    dangerous: false,
    requiresWorkspace: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize: () => 'browser back',
    async execute() {
      const info = await controller.back()
      return { output: `Went back to "${info.title}" at ${info.url}` }
    }
  }

  return [navigate, snapshot, click, type, pressKey, scroll, screenshot, back]
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}
