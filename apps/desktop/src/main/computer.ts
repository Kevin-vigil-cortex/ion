import { BrowserWindow, screen, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import type { ComputerController, ComputerScreenshot } from '@ion/agent'
import { SCREENSHOTS_DIR } from './paths'

const execFileAsync = promisify(execFile)

/**
 * macOS computer-use driver. Deliberately avoids native Node modules
 * (no electron-rebuild pain): mouse and scroll events are posted through
 * CoreGraphics via `osascript -l JavaScript` (the JXA ObjC bridge),
 * keyboard input goes through System Events, and screenshots use
 * /usr/sbin/screencapture. Everything ships with macOS.
 *
 * Visibility: the REAL system cursor is moved in small smoothstep-eased
 * increments inside a single osascript invocation (~25 steps / ~300ms), so
 * the user can watch it travel; clicks additionally flash a small
 * transparent always-on-top ripple window at the click point.
 *
 * Permissions required (System Settings > Privacy & Security):
 * - Accessibility: mouse/keyboard event posting (CGEventPost, System Events)
 * - Screen Recording: meaningful screenshots (otherwise wallpaper only)
 */
export class MacComputerDriver implements ComputerController {
  private highlight: BrowserWindow | null = null

  private assertMac(): void {
    if (process.platform !== 'darwin') {
      throw new Error('Computer use is currently supported on macOS only.')
    }
  }

  private assertAccessibility(): void {
    this.assertMac()
    // prompt=false: never spam the system dialog from a tool call loop.
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      // Ask once so macOS registers the app in the Accessibility pane.
      systemPreferences.isTrustedAccessibilityClient(true)
      throw new Error(
        'macOS Accessibility permission is missing, so mouse/keyboard control is blocked. ' +
          'Grant it in System Settings > Privacy & Security > Accessibility (add/enable Ion - or Electron when running from source), then retry.'
      )
    }
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    this.assertMac()
    const { width, height } = screen.getPrimaryDisplay().size
    return { width, height }
  }

  async screenshot(): Promise<ComputerScreenshot> {
    this.assertMac()
    const status = systemPreferences.getMediaAccessStatus('screen')
    if (status === 'denied' || status === 'restricted') {
      throw new Error(
        'macOS Screen Recording permission is denied, so screenshots would only show the wallpaper. ' +
          'Grant it in System Settings > Privacy & Security > Screen Recording (add/enable Ion - or Electron when running from source), then retry.'
      )
    }
    await mkdir(SCREENSHOTS_DIR, { recursive: true })
    const path = join(SCREENSHOTS_DIR, `screen-${timestamp()}.png`)
    // -x: no shutter sound, -m: main display only, PNG output.
    await execFileAsync('/usr/sbin/screencapture', ['-x', '-m', '-t', 'png', path]).catch(
      (err: Error) => {
        throw new Error(`screencapture failed: ${err.message}`)
      }
    )

    // Downscale from device pixels to logical points so what the model sees
    // maps 1:1 onto computer_click coordinates.
    const raw = nativeImage.createFromBuffer(await readFile(path))
    const logical = screen.getPrimaryDisplay().size
    const scaled =
      raw.getSize().width > logical.width ? raw.resize({ width: logical.width }) : raw
    const png = scaled.toPNG()
    await writeFile(path, png)

    return {
      base64: png.toString('base64'),
      mimeType: 'image/png',
      path,
      width: scaled.getSize().width,
      height: scaled.getSize().height
    }
  }

  async moveMouse(x: number, y: number): Promise<void> {
    this.assertAccessibility()
    const from = screen.getCursorScreenPoint()
    await this.runJxa(mouseMoveScript(from.x, from.y, x, y))
  }

  async click(
    x: number,
    y: number,
    opts: { button: 'left' | 'right'; double: boolean }
  ): Promise<void> {
    this.assertAccessibility()
    const from = screen.getCursorScreenPoint()
    await this.runJxa(mouseClickScript(from.x, from.y, x, y, opts.button, opts.double))
    this.flashHighlight(x, y)
  }

  async type(text: string): Promise<void> {
    this.assertAccessibility()
    // System Events handles plain lines; newlines become explicit Return
    // presses. Long lines are chunked to keep each keystroke call snappy.
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const chunk of chunkString(lines[i] ?? '', 200)) {
        if (chunk.length > 0) {
          await this.runJxa(typeChunkScript(), [Buffer.from(chunk, 'utf8').toString('base64')])
        }
      }
      if (i < lines.length - 1) {
        await this.runJxa(`Application('System Events').keyCode(36)`) // Return
      }
    }
  }

  async pressKey(combo: string): Promise<void> {
    this.assertAccessibility()
    await this.runJxa(pressComboScript(combo))
  }

  async scroll(dx: number, dy: number): Promise<void> {
    this.assertAccessibility()
    await this.runJxa(scrollScript(dx, dy))
  }

  private async runJxa(script: string, args: string[] = []): Promise<string> {
    this.assertMac()
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', script, ...args],
        { timeout: 30_000, maxBuffer: 1024 * 1024 }
      )
      return stdout.trim()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/not allowed|assistive|accessibility|1002|-25211/i.test(message)) {
        throw new Error(
          'macOS blocked the input event (Accessibility permission). Grant Ion (or Electron in dev) access under System Settings > Privacy & Security > Accessibility, then retry.'
        )
      }
      throw new Error(`osascript failed: ${message}`)
    }
  }

  /** Cosmetic click ripple: a tiny transparent always-on-top window. */
  private flashHighlight(x: number, y: number): void {
    try {
      if (!this.highlight || this.highlight.isDestroyed()) {
        this.highlight = new BrowserWindow({
          width: 64,
          height: 64,
          frame: false,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: true,
          focusable: false,
          hasShadow: false,
          resizable: false,
          show: false
        })
        this.highlight.setIgnoreMouseEvents(true)
        this.highlight.setAlwaysOnTop(true, 'screen-saver')
        void this.highlight.loadURL(HIGHLIGHT_DATA_URL)
      }
      this.highlight.setBounds({ x: Math.round(x) - 32, y: Math.round(y) - 32, width: 64, height: 64 })
      this.highlight.showInactive()
      const win = this.highlight
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.hide()
      }, 600)
    } catch {
      // Purely cosmetic - never fail the action over the ripple.
    }
  }
}

// ---- JXA scripts -------------------------------------------------------------
// CoreGraphics constants (not bridged by name in JXA, so numeric):
//   event types: 1 leftDown, 2 leftUp, 3 rightDown, 4 rightUp, 5 mouseMoved
//   buttons: 0 left, 1 right | tap: 0 kCGHIDEventTap
//   event field 1 = kCGMouseEventClickState | scroll units: 0 pixels

function fmt(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Invalid coordinate: ${n}`)
  return String(Math.round(n * 100) / 100)
}

/** Smoothstep-eased cursor glide posted as real CG mouse-moved events. */
function mouseMoveScript(sx: number, sy: number, ex: number, ey: number): string {
  return `
ObjC.import('CoreGraphics');
(function () {
  var sx = ${fmt(sx)}, sy = ${fmt(sy)}, ex = ${fmt(ex)}, ey = ${fmt(ey)};
  var dist = Math.hypot(ex - sx, ey - sy);
  var steps = Math.max(15, Math.min(40, Math.round(dist / 18)));
  for (var i = 1; i <= steps; i++) {
    var t = i / steps;
    var e = t * t * (3 - 2 * t);
    var mv = $.CGEventCreateMouseEvent($(), 5, { x: sx + (ex - sx) * e, y: sy + (ey - sy) * e }, 0);
    $.CGEventPost(0, mv);
    delay(0.011);
  }
})();`
}

function mouseClickScript(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  button: 'left' | 'right',
  double: boolean
): string {
  const down = button === 'right' ? 3 : 1
  const up = button === 'right' ? 4 : 2
  const btn = button === 'right' ? 1 : 0
  return `
ObjC.import('CoreGraphics');
(function () {
  var sx = ${fmt(sx)}, sy = ${fmt(sy)}, ex = ${fmt(ex)}, ey = ${fmt(ey)};
  var dist = Math.hypot(ex - sx, ey - sy);
  var steps = Math.max(15, Math.min(40, Math.round(dist / 18)));
  for (var i = 1; i <= steps; i++) {
    var t = i / steps;
    var e = t * t * (3 - 2 * t);
    var mv = $.CGEventCreateMouseEvent($(), 5, { x: sx + (ex - sx) * e, y: sy + (ey - sy) * e }, 0);
    $.CGEventPost(0, mv);
    delay(0.011);
  }
  var p = { x: ex, y: ey };
  function clickOnce(state) {
    var d = $.CGEventCreateMouseEvent($(), ${down}, p, ${btn});
    $.CGEventSetIntegerValueField(d, 1, state);
    $.CGEventPost(0, d);
    delay(0.04);
    var u = $.CGEventCreateMouseEvent($(), ${up}, p, ${btn});
    $.CGEventSetIntegerValueField(u, 1, state);
    $.CGEventPost(0, u);
  }
  clickOnce(1);
  ${double ? 'delay(0.08); clickOnce(2);' : ''}
})();`
}

function scrollScript(dx: number, dy: number): string {
  // CG scroll sign: positive wheel1 scrolls content UP. The tool contract is
  // "positive dy reveals content further down", hence the negation.
  return `
ObjC.import('CoreGraphics');
(function () {
  var ev = $.CGEventCreateScrollWheelEvent2($(), 0, 2, ${fmt(-dy)}, ${fmt(-dx)}, 0);
  $.CGEventPost(0, ev);
})();`
}

/** Types argv[0] (base64-encoded UTF-8) via System Events. */
function typeChunkScript(): string {
  return `
ObjC.import('Foundation');
function run(argv) {
  var data = $.NSData.alloc.initWithBase64EncodedStringOptions(argv[0], 0);
  var text = $.NSString.alloc.initWithDataEncoding(data, 4).js; // 4 = UTF-8
  Application('System Events').keystroke(text);
}`
}

/** macOS virtual key codes for named (non-character) keys. */
const MAC_KEY_CODES: Record<string, number> = {
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  forwarddelete: 117,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  arrowleft: 123,
  arrowright: 124,
  arrowdown: 125,
  arrowup: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111
}

const JXA_MODIFIERS: Record<string, string> = {
  cmd: 'command down',
  command: 'command down',
  meta: 'command down',
  ctrl: 'control down',
  control: 'control down',
  alt: 'option down',
  option: 'option down',
  shift: 'shift down'
}

function pressComboScript(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('Empty key combo.')
  const keyPart = parts[parts.length - 1] ?? ''
  const mods = parts
    .slice(0, -1)
    .map((p) => JXA_MODIFIERS[p.toLowerCase()])
    .filter((m): m is string => Boolean(m))
  const usingArg = mods.length ? `, { using: [${mods.map((m) => `'${m}'`).join(', ')}] }` : ''

  const named = MAC_KEY_CODES[keyPart.toLowerCase()]
  if (named !== undefined) {
    return `Application('System Events').keyCode(${named}${usingArg});`
  }
  if (/^[a-zA-Z0-9`\-=[\];',./\\]$/.test(keyPart)) {
    const ch = keyPart.toLowerCase().replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    return `Application('System Events').keystroke('${ch}'${usingArg});`
  }
  throw new Error(
    `Unsupported key "${keyPart}". Use a single character or one of: ${Object.keys(MAC_KEY_CODES).join(', ')}.`
  )
}

// ---- misc ---------------------------------------------------------------------

const HIGHLIGHT_HTML = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
<div style="width:16px;height:16px;border-radius:50%;background:rgba(183,121,31,.9);box-shadow:0 0 0 0 rgba(183,121,31,.55);animation:pulse .5s ease-out infinite"></div>
</div><style>@keyframes pulse{to{box-shadow:0 0 0 24px rgba(183,121,31,0)}}</style></body></html>`

const HIGHLIGHT_DATA_URL = `data:text/html;charset=utf-8,${encodeURIComponent(HIGHLIGHT_HTML)}`

function chunkString(text: string, size: number): string[] {
  if (text.length === 0) return ['']
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
