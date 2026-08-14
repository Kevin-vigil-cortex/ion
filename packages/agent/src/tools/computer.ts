import type { Tool } from './types'

/**
 * Computer-use tools: OS-level screen/mouse/keyboard control. The agent core
 * stays Electron/OS-free — the desktop app implements
 * {@link ComputerController} (macOS driver first) and injects it via
 * {@link createComputerTools}. Every tool is `dangerous: true` so each action
 * is approval-gated unless the user opts into auto-approval, and the whole
 * set is only offered when the user enables computer use in Settings.
 */

/** A screenshot of the user's screen, scaled to logical (point) resolution. */
export interface ComputerScreenshot {
  base64: string
  mimeType: string
  path: string
  width: number
  height: number
}

/**
 * Host implementation of OS control. Coordinates are logical screen points
 * with the origin at the top-left of the main display — the same space the
 * screenshots are scaled to, so what the model sees maps 1:1 to where it
 * clicks. Implementations must move the real cursor visibly (small steps,
 * never teleport) and should throw errors with actionable permission
 * guidance (Screen Recording / Accessibility on macOS).
 */
export interface ComputerController {
  screenshot(): Promise<ComputerScreenshot>
  /** Smoothly move the real cursor to (x, y). */
  moveMouse(x: number, y: number): Promise<void>
  /** Move to (x, y) then click. */
  click(x: number, y: number, opts: { button: 'left' | 'right'; double: boolean }): Promise<void>
  /** Type text into whatever currently has focus. */
  type(text: string): Promise<void>
  /** Press a key or combo like "enter", "cmd+t", "cmd+shift+4". */
  pressKey(combo: string): Promise<void>
  /** Scroll by (dx, dy) at the current cursor position. */
  scroll(dx: number, dy: number): Promise<void>
  /** Main display size in logical points. */
  screenSize(): Promise<{ width: number; height: number }>
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** Build the computer-use tool set over a host-provided controller. */
export function createComputerTools(controller: ComputerController): Tool[] {
  const screenshot: Tool = {
    name: 'computer_screenshot',
    description:
      'Capture the entire screen. The image is attached and is scaled so its pixels equal logical screen coordinates — use positions you see in it directly with computer_move_mouse / computer_click. Take a fresh screenshot after every significant UI change.',
    dangerous: true,
    requiresWorkspace: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize: () => 'screenshot the screen',
    async execute() {
      const shot = await controller.screenshot()
      return {
        output: `Screen captured (${shot.width}x${shot.height} logical px), saved to ${shot.path}. The image is attached.`,
        images: [{ mimeType: shot.mimeType, base64: shot.base64 }],
        meta: { path: shot.path, width: shot.width, height: shot.height }
      }
    }
  }

  const moveMouse: Tool = {
    name: 'computer_move_mouse',
    description:
      'Move the real system mouse cursor to screen coordinates (x, y). The cursor travels in visible steps so the user can follow it. Origin is the top-left of the main display, in logical points (matching computer_screenshot).',
    dangerous: true,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target x in logical screen points.' },
        y: { type: 'number', description: 'Target y in logical screen points.' }
      },
      required: ['x', 'y'],
      additionalProperties: false
    },
    summarize: (args) => `move mouse to (${String(args.x)}, ${String(args.y)})`,
    async execute(args) {
      const x = num(args.x)
      const y = num(args.y)
      if (x === undefined || y === undefined) {
        return { output: 'Both "x" and "y" number arguments are required.', isError: true }
      }
      await controller.moveMouse(x, y)
      return { output: `Mouse moved to (${Math.round(x)}, ${Math.round(y)}).` }
    }
  }

  const click: Tool = {
    name: 'computer_click',
    description:
      'Move the mouse to (x, y) and click. Supports left/right button and double-click. Verify the target position with computer_screenshot first, and screenshot again afterwards to confirm the effect.',
    dangerous: true,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target x in logical screen points.' },
        y: { type: 'number', description: 'Target y in logical screen points.' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Default "left".' },
        double: { type: 'boolean', description: 'Double-click when true.' }
      },
      required: ['x', 'y'],
      additionalProperties: false
    },
    summarize: (args) =>
      `${args.double ? 'double-' : ''}${args.button === 'right' ? 'right-' : ''}click (${String(args.x)}, ${String(args.y)})`,
    async execute(args) {
      const x = num(args.x)
      const y = num(args.y)
      if (x === undefined || y === undefined) {
        return { output: 'Both "x" and "y" number arguments are required.', isError: true }
      }
      const button = args.button === 'right' ? 'right' : 'left'
      const double = args.double === true
      await controller.click(x, y, { button, double })
      return {
        output: `${double ? 'Double-clicked' : 'Clicked'} ${button} at (${Math.round(x)}, ${Math.round(y)}).`
      }
    }
  }

  const type: Tool = {
    name: 'computer_type',
    description:
      'Type text on the system keyboard into whatever currently has focus. Click the target field first. Use computer_press_key for Enter/Tab/shortcuts.',
    dangerous: true,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type.' }
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
      await controller.type(text)
      return { output: `Typed ${text.length} character(s).` }
    }
  }

  const pressKey: Tool = {
    name: 'computer_press_key',
    description:
      'Press a key or key combo system-wide, e.g. "enter", "tab", "escape", "cmd+t", "cmd+shift+4", "up"/"down"/"left"/"right".',
    dangerous: true,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        combo: { type: 'string', description: 'Key name or combo like "cmd+t".' }
      },
      required: ['combo'],
      additionalProperties: false
    },
    summarize: (args) => `press ${String(args.combo ?? '')}`,
    async execute(args) {
      const combo = typeof args.combo === 'string' && args.combo ? args.combo : undefined
      if (!combo) return { output: 'Missing required string argument "combo".', isError: true }
      await controller.pressKey(combo)
      return { output: `Pressed ${combo}.` }
    }
  }

  const scroll: Tool = {
    name: 'computer_scroll',
    description:
      'Scroll at the current mouse position by (dx, dy). Positive dy scrolls the content down (like swiping up); move the mouse over the target area first.',
    dangerous: true,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        dx: { type: 'number', description: 'Horizontal scroll amount (default 0).' },
        dy: { type: 'number', description: 'Vertical scroll amount (default 0).' }
      },
      additionalProperties: false
    },
    summarize: (args) => `scroll (${String(args.dx ?? 0)}, ${String(args.dy ?? 0)})`,
    async execute(args) {
      const dx = num(args.dx) ?? 0
      const dy = num(args.dy) ?? 0
      if (dx === 0 && dy === 0) {
        return { output: 'Pass a non-zero "dx" or "dy".', isError: true }
      }
      await controller.scroll(dx, dy)
      return { output: `Scrolled by (${dx}, ${dy}).` }
    }
  }

  return [screenshot, moveMouse, click, type, pressKey, scroll]
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}
