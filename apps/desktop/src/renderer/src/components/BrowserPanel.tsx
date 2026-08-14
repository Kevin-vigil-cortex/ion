import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, RotateCw, X, Globe } from 'lucide-react'
import { useStore } from '../store'
import type { BrowserCursorEvent } from '../../../shared/ipc'

/**
 * The embedded agent browser: an Electron <webview> guest the agent drives
 * from the main process, plus a fake-cursor overlay that glides to each
 * target and pulses on clicks so the user can watch the agent work. The
 * user keeps full manual control too (URL bar, back, reload).
 */

/** The subset of Electron's WebviewTag API the panel calls directly. */
interface WebviewElement extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  getURL(): string
  canGoBack(): boolean
  goBack(): void
  reload(): void
}

interface Ripple {
  id: number
  x: number
  y: number
}

let rippleId = 0

export default function BrowserPanel(): React.JSX.Element {
  const open = useStore((s) => s.browserPanelOpen)
  const setOpen = useStore((s) => s.setBrowserPanelOpen)

  const webviewRef = useRef<WebviewElement | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [currentUrl, setCurrentUrl] = useState('about:blank')
  const [pageTitle, setPageTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const editingRef = useRef(false)

  // Cursor overlay state, driven by IPC events from the main process.
  const [cursor, setCursor] = useState({ x: 40, y: 40, durationMs: 0, visible: false })
  const [ripples, setRipples] = useState<Ripple[]>([])
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep the webview mounted once it has ever been needed so page state
  // (and the guest process the agent drives) survives collapsing the panel.
  const everOpenedRef = useRef(false)
  if (open) everOpenedRef.current = true

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return

    const syncNav = (): void => {
      setCanGoBack(typeof wv.canGoBack === 'function' ? wv.canGoBack() : false)
      const url = typeof wv.getURL === 'function' ? wv.getURL() : ''
      setCurrentUrl(url)
      if (!editingRef.current) setUrlInput(url === 'about:blank' ? '' : url)
    }
    const onNavigate = (): void => syncNav()
    const onTitle = (e: Event): void => {
      const title = (e as Event & { title?: string }).title
      if (title) setPageTitle(title)
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      syncNav()
    }

    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    return () => {
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
    }
  }, [open])

  useEffect(() => {
    if (!window.ion.onBrowserCursor) return
    const unsubscribe = window.ion.onBrowserCursor((event: BrowserCursorEvent) => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      if (event.kind === 'move') {
        setCursor({ x: event.x, y: event.y, durationMs: event.durationMs, visible: true })
      } else if (event.kind === 'click') {
        setCursor({ x: event.x, y: event.y, durationMs: 120, visible: true })
        const ripple: Ripple = { id: rippleId++, x: event.x, y: event.y }
        setRipples((prev) => [...prev, ripple])
        setTimeout(() => {
          setRipples((prev) => prev.filter((r) => r.id !== ripple.id))
        }, 700)
      } else {
        setCursor((prev) => ({ ...prev, visible: false }))
        return
      }
      // Fade the cursor out when the agent goes quiet for a while.
      hideTimer.current = setTimeout(
        () => setCursor((prev) => ({ ...prev, visible: false })),
        6_000
      )
    })
    return unsubscribe
  }, [])

  const navigateTo = (raw: string): void => {
    const wv = webviewRef.current
    const trimmed = raw.trim()
    if (!wv || !trimmed) return
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    void wv.loadURL(url).catch(() => {})
  }

  return (
    <div
      className="relative h-full shrink-0 overflow-hidden border-l border-line bg-surface transition-[width] duration-200"
      style={{ width: open ? 'min(46%, 760px)' : '0px' }}
      aria-hidden={!open}
    >
      {/* Fixed-width inner shell keeps the webview alive at a real size even
          while the panel is collapsed (display:none would kill the guest). */}
      <div className="flex h-full flex-col" style={{ width: 'max(420px, 100%)' }}>
        <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-2.5">
          <Globe size={14} className="shrink-0 text-accent" />
          <span className="mr-1 text-xs font-medium text-ink-muted">Agent browser</span>
          <button
            onClick={() => webviewRef.current?.goBack()}
            disabled={!canGoBack}
            title="Back"
            className="rounded-md p-1 text-ink-muted enabled:hover:bg-white/5 enabled:hover:text-ink disabled:opacity-35"
          >
            <ArrowLeft size={14} />
          </button>
          <button
            onClick={() => webviewRef.current?.reload()}
            title="Reload"
            className={`rounded-md p-1 text-ink-muted hover:bg-white/5 hover:text-ink ${loading ? 'animate-spin' : ''}`}
          >
            <RotateCw size={13} />
          </button>
          <input
            value={urlInput}
            placeholder={currentUrl === 'about:blank' ? 'Enter a URL…' : currentUrl}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={() => {
              editingRef.current = true
            }}
            onBlur={() => {
              editingRef.current = false
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                navigateTo(urlInput)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            className="min-w-0 flex-1 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
            title={pageTitle || currentUrl}
          />
          <button
            onClick={() => setOpen(false)}
            title="Hide browser panel"
            className="rounded-md p-1 text-ink-faint hover:bg-white/5 hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>

        <div className="relative min-h-0 flex-1 bg-surface">
          {everOpenedRef.current && (
            <webview
              // React 19 passes ref straight through to the custom element.
              ref={(el: HTMLElement | null) => {
                webviewRef.current = el as WebviewElement | null
              }}
              src="about:blank"
              partition="persist:agent-browser"
              className="absolute inset-0 h-full w-full"
            />
          )}

          {/* Cursor overlay: coordinates from main are webview-viewport CSS px,
              which is exactly this container's coordinate space. */}
          <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
            {ripples.map((r) => (
              <span
                key={r.id}
                className="absolute h-8 w-8 animate-ping rounded-full border-2 border-accent bg-accent-soft/60"
                style={{ left: r.x - 16, top: r.y - 16 }}
              />
            ))}
            <div
              className="absolute left-0 top-0 will-change-transform"
              style={{
                transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)`,
                transition: `transform ${cursor.durationMs}ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 300ms ease`,
                opacity: cursor.visible ? 1 : 0
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" className="drop-shadow-md">
                <path
                  d="M5.5 3.2v16.2l4.1-4.0 2.4 5.6 2.8-1.2-2.4-5.5 5.7-0.6L5.5 3.2z"
                  fill="#1b1b1b"
                  stroke="#ffffff"
                  strokeWidth="1.4"
                />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
