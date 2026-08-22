import { app, BrowserWindow, type WebContents } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BrowserController,
  BrowserPageInfo,
  BrowserScreenshot
} from '@ion/agent'
import { IpcEvent, type BrowserCursorEvent, type BrowserActivityEvent } from '../shared/ipc'
import { SCREENSHOTS_DIR } from './paths'

/** Partition the renderer's <webview> must declare so we recognize it. */
export const AGENT_BROWSER_PARTITION = 'persist:agent-browser'

const NAVIGATE_TIMEOUT_MS = 25_000
const MAX_SNAPSHOT_ELEMENTS = 150
const MAX_SNAPSHOT_TEXT = 4_000

/**
 * Drives the embedded <webview> browser panel from the main process on the
 * agent's behalf: navigation via loadURL, page inspection via injected JS,
 * clicks/keys via trusted sendInputEvent, screenshots via capturePage.
 *
 * Every pointer action first streams a cursor event to the renderer so the
 * fake-cursor overlay glides to the target before the real input fires -
 * that is what makes the agent's browsing watchable.
 */
export class BrowserBridge implements BrowserController {
  private wc: WebContents | null = null
  private attachWaiters: Array<(wc: WebContents) => void> = []
  private initialized = false
  /** Last overlay cursor position, for movement-duration heuristics. */
  private cursor = { x: 60, y: 60 }

  /** Start watching for the panel's webview guest (idempotent). */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() !== 'webview') return
      this.adopt(contents)
    })
  }

  private adopt(wc: WebContents): void {
    this.wc = wc
    wc.once('destroyed', () => {
      if (this.wc === wc) this.wc = null
    })
    // Keep everything inside the panel: follow popups in the same view.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void wc.loadURL(url)
      return { action: 'deny' }
    })
    const waiters = this.attachWaiters
    this.attachWaiters = []
    for (const resolve of waiters) resolve(wc)
  }

  /** True when a live webview guest is attached. */
  get attached(): boolean {
    return this.wc !== null && !this.wc.isDestroyed()
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  }

  private emitCursor(event: BrowserCursorEvent): void {
    this.broadcast(IpcEvent.BrowserCursor, event)
  }

  private emitActivity(event: BrowserActivityEvent): void {
    this.broadcast(IpcEvent.BrowserActivity, event)
  }

  /**
   * Resolve the live guest webContents, asking the renderer to open the
   * panel (which mounts the webview) and waiting for it to attach.
   */
  private async ensureReady(): Promise<WebContents> {
    this.emitActivity({ action: 'ensure_visible' })
    if (this.wc && !this.wc.isDestroyed()) return this.wc
    const wc = await new Promise<WebContents | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 4_000)
      this.attachWaiters.push((attached) => {
        clearTimeout(timer)
        resolve(attached)
      })
    })
    if (!wc || wc.isDestroyed()) {
      throw new Error(
        'The embedded browser panel is not available. It lives in the chat view - this usually resolves once a chat is open. Retry the browser tool.'
      )
    }
    return wc
  }

  // ---- BrowserController -------------------------------------------------

  async navigate(rawUrl: string): Promise<BrowserPageInfo> {
    const wc = await this.ensureReady()
    const url = normalizeUrl(rawUrl)
    try {
      await withTimeout(wc.loadURL(url), NAVIGATE_TIMEOUT_MS, () => wc.stop())
    } catch (err) {
      // ERR_ABORTED (-3) fires on client-side redirects/SPA takeovers; the
      // page is usually fine. Anything else is a real load failure.
      const code = (err as { errno?: number; code?: string }) ?? {}
      if (code.errno !== -3 && code.code !== 'ERR_ABORTED') {
        throw new Error(
          `Failed to load ${url}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    await sleep(350)
    this.emitActivity({ action: 'navigated', url: wc.getURL() })
    return { url: wc.getURL(), title: wc.getTitle() }
  }

  async snapshot(): Promise<string> {
    const wc = await this.ensureReady()
    const result = (await wc.executeJavaScript(snapshotScript())) as string
    return result
  }

  async click(target: { ref?: string; x?: number; y?: number }): Promise<string> {
    const wc = await this.ensureReady()
    let x: number
    let y: number
    let label = ''
    if (target.ref) {
      const resolved = (await wc.executeJavaScript(resolveRefScript(target.ref, true))) as {
        error?: string
        x?: number
        y?: number
        label?: string
      }
      if (resolved.error) return resolved.error
      x = resolved.x ?? 0
      y = resolved.y ?? 0
      label = resolved.label ? ` (${resolved.label})` : ''
    } else {
      x = target.x ?? 0
      y = target.y ?? 0
    }

    await this.glideTo(x, y)
    wc.focus()
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await sleep(40)
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    this.emitCursor({ kind: 'click', x, y })
    await sleep(250)
    const where = target.ref ? `${target.ref}${label}` : `(${Math.round(x)}, ${Math.round(y)})`
    return `Clicked ${where}. Take a browser_snapshot or browser_screenshot to see the result.`
  }

  async type(text: string, ref?: string): Promise<string> {
    const wc = await this.ensureReady()
    if (ref) {
      const clickMsg = await this.click({ ref })
      if (clickMsg.startsWith('Unknown ref')) return clickMsg
    }
    wc.focus()
    for (const ch of text) {
      if (ch === '\n') {
        pressKeyOn(wc, 'Return', [])
      } else {
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
      }
      await sleep(12)
    }
    return `Typed "${text.length > 60 ? text.slice(0, 59) + '…' : text}"${ref ? ` into ${ref}` : ''}.`
  }

  async pressKey(combo: string): Promise<string> {
    const wc = await this.ensureReady()
    const { keyCode, modifiers } = parseCombo(combo)
    wc.focus()
    pressKeyOn(wc, keyCode, modifiers)
    await sleep(150)
    return `Pressed ${combo}.`
  }

  async scroll(params: { dy?: number; ref?: string }): Promise<string> {
    const wc = await this.ensureReady()
    if (params.ref) {
      const resolved = (await wc.executeJavaScript(resolveRefScript(params.ref, true))) as {
        error?: string
        label?: string
      }
      if (resolved.error) return resolved.error
      await sleep(250)
      return `Scrolled ${params.ref}${resolved.label ? ` (${resolved.label})` : ''} into view.`
    }
    const dy = params.dy ?? 0
    const info = (await wc.executeJavaScript(
      `(function () { window.scrollBy({ top: ${Number(dy)}, behavior: 'smooth' }); return true })()`
    )) as boolean
    void info
    await sleep(400)
    const pos = (await wc.executeJavaScript(
      '(function () { return { y: Math.round(window.scrollY), max: Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight)) } })()'
    )) as { y: number; max: number }
    return `Scrolled by ${dy}px - now at ${pos.y}/${pos.max}px.`
  }

  async screenshot(): Promise<BrowserScreenshot> {
    const wc = await this.ensureReady()
    const image = await wc.capturePage()
    const viewport = (await wc.executeJavaScript(
      '(function () { return { w: window.innerWidth, h: window.innerHeight } })()'
    )) as { w: number; h: number }
    // Scale to logical (CSS px) size so image pixels match click coordinates.
    const scaled =
      image.getSize().width !== viewport.w ? image.resize({ width: viewport.w }) : image
    const png = scaled.toPNG()
    await mkdir(SCREENSHOTS_DIR, { recursive: true })
    const path = join(SCREENSHOTS_DIR, `browser-${timestamp()}.png`)
    await writeFile(path, png)
    return {
      base64: png.toString('base64'),
      mimeType: 'image/png',
      path,
      width: scaled.getSize().width,
      height: scaled.getSize().height
    }
  }

  async back(): Promise<BrowserPageInfo> {
    const wc = await this.ensureReady()
    if (!wc.navigationHistory.canGoBack()) {
      return { url: wc.getURL(), title: `${wc.getTitle()} (no earlier history)` }
    }
    const navigated = new Promise<void>((resolve) => {
      const done = (): void => {
        wc.removeListener('did-navigate', done)
        wc.removeListener('did-navigate-in-page', done)
        resolve()
      }
      wc.once('did-navigate', done)
      wc.once('did-navigate-in-page', done)
      setTimeout(done, 3_000)
    })
    wc.navigationHistory.goBack()
    await navigated
    await sleep(250)
    this.emitActivity({ action: 'navigated', url: wc.getURL() })
    return { url: wc.getURL(), title: wc.getTitle() }
  }

  // ---- helpers -----------------------------------------------------------

  /** Animate the overlay cursor to (x, y) and wait for the glide to finish. */
  private async glideTo(x: number, y: number): Promise<void> {
    const dist = Math.hypot(x - this.cursor.x, y - this.cursor.y)
    const durationMs = Math.max(250, Math.min(650, Math.round(dist * 0.9)))
    this.cursor = { x, y }
    this.emitCursor({ kind: 'move', x, y, durationMs })
    await sleep(durationMs + 80)
  }
}

// ---- injected page scripts -------------------------------------------------

/**
 * Builds the compact interactive-element outline. Elements get refs e1..eN
 * stored on `window.__ghRefs`; refs stay valid until the next snapshot or
 * navigation.
 */
function snapshotScript(): string {
  return `(function () {
    var SEL = 'a[href], button, input, select, textarea, summary, ' +
      '[role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], ' +
      '[role="combobox"], [role="menuitem"], [role="option"], [role="searchbox"], ' +
      '[role="textbox"], [role="switch"], [contenteditable="true"], [onclick]';
    var all = Array.prototype.slice.call(document.querySelectorAll(SEL));
    var visible = all.filter(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    });
    window.__ghRefs = visible;
    var lines = visible.slice(0, ${MAX_SNAPSHOT_ELEMENTS}).map(function (el, i) {
      var r = el.getBoundingClientRect();
      var tag = el.tagName.toLowerCase();
      var role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'input') : tag);
      var name = (el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || '')
        .trim().replace(/\\s+/g, ' ').slice(0, 70);
      var extra = '';
      if (tag === 'a') { extra = ' -> ' + String(el.getAttribute('href') || '').slice(0, 70); }
      if (tag === 'input' || tag === 'textarea') {
        var v = String(el.value || '');
        extra = v ? ' value="' + v.slice(0, 40) + '"' : (el.getAttribute('placeholder') ? ' placeholder="' + String(el.getAttribute('placeholder')).slice(0, 40) + '"' : '');
      }
      if (el.disabled) extra += ' (disabled)';
      var off = (r.bottom < 0 || r.top > window.innerHeight) ? ' (offscreen)' : '';
      return '[e' + (i + 1) + '] ' + role + ' "' + name + '"' + extra + off;
    });
    var bodyText = (document.body ? document.body.innerText : '')
      .replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${MAX_SNAPSHOT_TEXT});
    var scrollMax = Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight));
    return 'Page: ' + document.title + '\\nURL: ' + location.href +
      '\\nViewport: ' + window.innerWidth + 'x' + window.innerHeight +
      ', scroll ' + Math.round(window.scrollY) + '/' + scrollMax + 'px' +
      '\\n\\nInteractive elements (' + visible.length + ' total' +
      (visible.length > ${MAX_SNAPSHOT_ELEMENTS} ? ', first ${MAX_SNAPSHOT_ELEMENTS} listed' : '') + '):\\n' +
      lines.join('\\n') + '\\n\\nVisible text:\\n' + bodyText;
  })()`
}

/**
 * Resolves a snapshot ref to a viewport coordinate, optionally scrolling it
 * into view first. Returns `{ error }` for stale/unknown refs.
 */
function resolveRefScript(ref: string, scrollIntoView: boolean): string {
  const index = Number(String(ref).replace(/^e/i, '')) - 1
  return `(function () {
    var refs = window.__ghRefs;
    var el = refs && refs[${index >= 0 ? index : -1}];
    if (!el || !el.getBoundingClientRect) {
      return { error: 'Unknown ref ${escapeForScript(ref)} - take a new browser_snapshot first (refs reset on navigation).' };
    }
    ${scrollIntoView ? "try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}" : ''}
    var r = el.getBoundingClientRect();
    var label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: label };
  })()`
}

function escapeForScript(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").slice(0, 32)
}

// ---- input helpers ----------------------------------------------------------

function pressKeyOn(wc: WebContents, keyCode: string, modifiers: string[]): void {
  const mods = modifiers as Array<'shift' | 'control' | 'alt' | 'meta'>
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods })
  // Printable keys and Return need a char event for the page to receive input.
  if (keyCode.length === 1 || keyCode === 'Return' || keyCode === 'Space') {
    wc.sendInputEvent({ type: 'char', keyCode, modifiers: mods })
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods })
}

const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
}

const MODIFIER_ALIASES: Record<string, string> = {
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  ctrl: 'control',
  control: 'control',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
}

/** Parse "cmd+shift+a" / "Enter" into Electron sendInputEvent pieces. */
export function parseCombo(combo: string): { keyCode: string; modifiers: string[] } {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  const modifiers: string[] = []
  let key = parts[parts.length - 1] ?? ''
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()]
    if (mod) modifiers.push(mod)
  }
  const alias = KEY_ALIASES[key.toLowerCase()]
  if (alias) key = alias
  return { keyCode: key, modifiers }
}

// ---- misc -------------------------------------------------------------------

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (/^about:blank$/i.test(trimmed)) return trimmed
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void
): Promise<T | void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout()
      resolve()
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
