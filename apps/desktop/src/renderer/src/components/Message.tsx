import { memo, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Brain, Check, ChevronDown, Copy, FileText, Film, Folder, GitBranch, Sparkles } from 'lucide-react'
import { useStore, type UiAttachment, type UiMessage } from '../store'

function UserAttachments({ items }: { items: UiAttachment[] }): React.JSX.Element {
  return (
    <div className="mb-2 flex flex-wrap justify-end gap-1.5">
      {items.map((a) => (
        <UserAttachment key={a.id} att={a} />
      ))}
    </div>
  )
}

function UserAttachment({ att }: { att: UiAttachment }): React.JSX.Element {
  const [src, setSrc] = useState(att.previewUrl)
  useEffect(() => {
    if (src || !att.path || att.kind === 'file') return
    void window.ion.attachmentPreview(att.path).then((url) => {
      if (url) setSrc(url)
    })
  }, [att.path, att.kind, src])

  if (src && (att.kind === 'image' || att.kind === 'video')) {
    return (
      <div className="relative max-h-48 max-w-[220px] overflow-hidden rounded-xl border border-line">
        <img src={src} alt={att.name} className="max-h-48 max-w-[220px] object-cover" />
        {att.kind === 'video' && (
          <Film size={12} className="absolute bottom-1.5 left-1.5 text-white drop-shadow" />
        )}
      </div>
    )
  }
  return (
    <div className="flex max-w-[220px] items-center gap-1.5 rounded-lg border border-line bg-white/[0.04] px-2 py-1.5 text-xs text-ink-muted">
      {att.kind === 'video' ? <Film size={12} /> : <FileText size={12} />}
      <span className="truncate">{att.name}</span>
    </div>
  )
}

function thoughtLabel(ms: number): string {
  if (ms < 1000) return 'Thought for <1s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `Thought for ${s}s`
  return `Thought for ${Math.floor(s / 60)}m ${s % 60}s`
}

function Thought({ reasoning, ms }: { reasoning: string; ms: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-ink-faint transition-colors hover:text-ink-muted"
      >
        {thoughtLabel(ms)}
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="selectable mt-1.5 whitespace-pre-wrap border-l border-line pl-3 text-xs leading-relaxed text-ink-faint">
          {reasoning}
        </div>
      )}
    </div>
  )
}

const MIN_THOUGHT_MS = 2000

function Message({
  message,
  precedesTools = false,
  live = false
}: {
  message: UiMessage
  precedesTools?: boolean
  /** Still receiving tokens — render plain text, not markdown. */
  live?: boolean
}): React.JSX.Element | null {
  if (message.role === 'user') {
    const atts = message.attachments?.filter((a) => !a.silent) ?? []
    const canned =
      atts.length > 0 &&
      /^(Look at this attachment:|Look at these attachments:)/.test(message.content.trim())
    const showText = Boolean(message.content.trim()) && !canned
    return (
      <div className="flex flex-col items-end">
        {atts.length > 0 && <UserAttachments items={atts} />}
        {message.skills && message.skills.length > 0 && (
          <div className="mb-1.5 flex max-w-[80%] flex-wrap justify-end gap-1">
            {message.skills.map((s) => (
              <span
                key={s.name}
                className="flex max-w-full items-center gap-1 rounded-md border border-line bg-card px-1.5 py-0.5 text-[11px] text-ink-muted"
                title={s.description || s.name}
              >
                <Sparkles size={10} />
                <span className="truncate">/{s.name}</span>
              </span>
            ))}
          </div>
        )}
        {message.mentions && message.mentions.length > 0 && (
          <div className="mb-1.5 flex max-w-[80%] flex-wrap justify-end gap-1">
            {message.mentions.map((m) => (
              <span
                key={m.path}
                className="flex max-w-full items-center gap-1 rounded-md border border-line bg-card px-1.5 py-0.5 text-[11px] text-ink-muted"
                title={m.path}
              >
                {m.kind === 'diff' || m.kind === 'staged' ? (
                  <GitBranch size={10} />
                ) : m.isDir ? (
                  <Folder size={10} />
                ) : (
                  <FileText size={10} />
                )}
                <span className="truncate">
                  {m.kind === 'diff' ? '@diff' : m.kind === 'staged' ? '@staged' : m.path}
                </span>
              </span>
            ))}
          </div>
        )}
        {showText && (
          <div className="selectable max-w-[80%] whitespace-pre-wrap rounded-2xl border border-line bg-card px-4 py-2.5 text-sm text-ink">
            {message.content}
          </div>
        )}
      </div>
    )
  }

  const thoughtDone = message.reasoningMs !== undefined
  const thought =
    message.reasoning && thoughtDone && message.reasoningMs! >= MIN_THOUGHT_MS ? (
      <Thought reasoning={message.reasoning} ms={message.reasoningMs!} />
    ) : null

  if (!message.content.trim()) {
    if (thoughtDone) return thought

    return (
      <div className="flex min-w-0 items-center gap-2 text-xs text-ink-faint">
        <Brain size={13} className="shrink-0" />
        <span className="shrink-0 font-medium">Thinking</span>
        <span className="inline-flex gap-1">
          <span className="dot">.</span>
          <span className="dot">.</span>
          <span className="dot">.</span>
        </span>
      </div>
    )
  }

  const body = live ? (
    <div className="md selectable whitespace-pre-wrap text-ink">
      {message.content}
      <span className="stream-caret" />
    </div>
  ) : (
    <div className="md selectable text-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {message.content}
      </ReactMarkdown>
    </div>
  )

  const text = message.content.trim()
  // Live tokens start slim — don't open in a bubble and snap smaller when tools land.
  const slim = live || (precedesTools && text.length <= 200 && !text.includes('\n'))
  if (slim) {
    return (
      <div className={`${live ? '' : 'msg-block '}flex flex-col gap-1.5`}>
        {thought}
        {body}
      </div>
    )
  }

  return (
    <div className={`${live ? '' : 'msg-block '}flex flex-col gap-1.5`}>
      {thought}
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl border border-line bg-card px-4 py-3">{body}</div>
      </div>
    </div>
  )
}

const markdownComponents = {
  pre({ children }: { children?: React.ReactNode }) {
    return <>{children}</>
  },
  code({ className, children }: { className?: string; children?: React.ReactNode }) {
    const text = String(children).replace(/\n$/, '')
    const block = Boolean(className) || text.includes('\n')
    if (!block) return <code className={className}>{children}</code>
    return <CodeBlock className={className} code={text} />
  }
}

function parseFenceMeta(
  className: string | undefined,
  code: string
): { lang: string; path: string | null } {
  const raw = (className ?? '').replace(/^language-/, '')
  const colon = raw.match(/^([A-Za-z0-9+#]+):(.+\.\w[\w.]*)$/)
  if (colon) return { lang: colon[1] ?? '', path: colon[2] ?? null }
  if (raw.includes('/') && /\.\w[\w.]*$/.test(raw)) return { lang: '', path: raw }
  const first = code.split('\n')[0] ?? ''
  const fileLine = first.match(/^(?:\/\/|#|--)\s*(?:file:\s*)?([\w./\\-]+\.\w[\w.]*)$/)
  if (fileLine?.[1] && !fileLine[1].includes(' ')) return { lang: raw, path: fileLine[1] }
  return { lang: raw, path: null }
}

function CodeBlock({ className, code }: { className?: string; code: string }): React.JSX.Element {
  const workspace = useStore((s) => s.draftWorkspace)
  const applyFile = useStore((s) => s.applyFile)
  const { lang, path: hinted } = parseFenceMeta(className, code)
  const [path, setPath] = useState(hinted ?? '')
  const [askPath, setAskPath] = useState(false)
  const [copied, setCopied] = useState(false)
  const [applied, setApplied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setError('Copy failed')
    }
  }

  const apply = async (target: string): Promise<void> => {
    const rel = target.trim()
    if (!rel) {
      setAskPath(true)
      return
    }
    setError(null)
    try {
      await applyFile(rel, code)
      setApplied(true)
      setAskPath(false)
      window.setTimeout(() => setApplied(false), 1600)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="code-block my-2 overflow-hidden rounded-[10px] border border-white/[0.07] bg-[#0c0e15]">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-faint">
          {path || lang || 'code'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => void copy()}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-white/5 hover:text-ink"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {workspace && (
            <button
              onClick={() => void apply(path)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-white/5 hover:text-ink"
              title={path ? `Write to ${path}` : 'Apply to a workspace file'}
            >
              {applied ? <Check size={11} /> : null}
              {applied ? 'Applied' : 'Apply'}
            </button>
          )}
        </div>
      </div>
      {askPath && (
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="path/relative/to/workspace.ts"
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void apply(path)
              if (e.key === 'Escape') setAskPath(false)
            }}
          />
          <button
            onClick={() => void apply(path)}
            className="text-[11px] text-ink-muted hover:text-ink"
          >
            Save
          </button>
        </div>
      )}
      {error && <div className="px-3 py-1 text-[11px] text-red-300">{error}</div>}
      <pre className="overflow-x-auto px-3.5 py-3 text-[12.5px] leading-relaxed text-[#e9e6df]">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export default memo(Message)
