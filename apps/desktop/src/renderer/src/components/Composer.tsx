import { useState, useRef, useEffect } from 'react'
import { ArrowUp, Folder, FolderOpen, GitBranch, Paperclip, Sparkles, Square, X, BrainCircuit, FileText, Film } from 'lucide-react'
import { useStore, type DraftAttachment, type WorkspaceMention, type SkillInfo } from '../store'
import { filesFromDataTransfer } from '../media'
import ModelPicker from './ModelPicker'
import PermissionPicker from './PermissionPicker'
import ContextUsage from './ContextUsage'

/** `@token` immediately before the caret, only after start-of-line or whitespace. */
function mentionAtCaret(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = before.match(/(^|[\s])@([^\s@]*)$/)
  if (!m) return null
  return { start: before.length - (m[2]?.length ?? 0) - 1, query: m[2] ?? '' }
}

/** `/skill` immediately before the caret. Cmd+/ is model-cycle - this is a bare slash. */
function slashAtCaret(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = before.match(/(^|[\s])\/([^\s/]*)$/)
  if (!m) return null
  return { start: before.length - (m[2]?.length ?? 0) - 1, query: m[2] ?? '' }
}

function skillMatches(skill: SkillInfo, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return skill.name.includes(q) || skill.description.toLowerCase().includes(q)
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function DraftChip({
  att,
  onRemove
}: {
  att: DraftAttachment
  onRemove: () => void
}): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  const showThumb = Boolean(att.previewUrl) && !broken && (att.kind === 'image' || att.kind === 'video')
  return (
    <div className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/[0.04]" title={att.name}>
      {showThumb ? (
        <>
          <img
            src={att.previewUrl}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setBroken(true)}
          />
          {att.kind === 'video' && (
            <Film size={12} className="absolute bottom-1 left-1 text-white drop-shadow" />
          )}
        </>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1">
          {att.kind === 'video' ? (
            <Film size={14} className="text-ink-muted" />
          ) : (
            <FileText size={14} className="text-ink-muted" />
          )}
          <span className="w-full truncate text-center text-[9px] text-ink-faint">{att.name}</span>
        </div>
      )}
      <button
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 hover:bg-black group-hover:opacity-100"
        title="Remove"
      >
        <X size={10} />
      </button>
    </div>
  )
}

export default function Composer({ variant }: { variant: 'center' | 'bottom' }): React.JSX.Element {
  const [text, setText] = useState('')
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [hits, setHits] = useState<WorkspaceMention[]>([])
  const [hitIndex, setHitIndex] = useState(0)
  const [slash, setSlash] = useState<{ start: number; query: string } | null>(null)
  const [skillHits, setSkillHits] = useState<SkillInfo[]>([])
  const [skillIndex, setSkillIndex] = useState(0)
  const send = useStore((s) => s.send)
  const abort = useStore((s) => s.abort)
  const queuedPrompts = useStore((s) => s.queuedPrompts)
  const removeQueued = useStore((s) => s.removeQueued)
  const status = useStore((s) => s.status)
  const draftWorkspace = useStore((s) => s.draftWorkspace)
  const pickWorkspace = useStore((s) => s.pickWorkspace)
  const clearWorkspace = useStore((s) => s.clearWorkspace)
  const config = useStore((s) => s.config)
  const setMemoryEnabled = useStore((s) => s.setMemoryEnabled)
  const draftMode = useStore((s) => s.draftMode)
  const draftAttachments = useStore((s) => s.draftAttachments)
  const draftMentions = useStore((s) => s.draftMentions)
  const addDraftMention = useStore((s) => s.addDraftMention)
  const removeDraftMention = useStore((s) => s.removeDraftMention)
  const draftSkills = useStore((s) => s.draftSkills)
  const addDraftSkill = useStore((s) => s.addDraftSkill)
  const removeDraftSkill = useStore((s) => s.removeDraftSkill)
  const attachmentError = useStore((s) => s.attachmentError)
  const addDraftFiles = useStore((s) => s.addDraftFiles)
  const removeDraftAttachment = useStore((s) => s.removeDraftAttachment)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const steerRef = useRef<() => void>(() => {})

  const busy = status !== 'idle' && status !== 'error'
  const canSend =
    Boolean(text.trim()) ||
    draftAttachments.length > 0 ||
    draftMentions.length > 0 ||
    draftSkills.length > 0
  const mentionOpen = mention !== null
  const slashOpen = slash !== null && !mentionOpen

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'
  }, [text])

  useEffect(() => {
    const focus = (): void => textareaRef.current?.focus()
    focus()
    const onSteer = (): void => steerRef.current()
    window.addEventListener('ion:focus-composer', focus)
    window.addEventListener('ion:steer', onSteer)
    return () => {
      window.removeEventListener('ion:focus-composer', focus)
      window.removeEventListener('ion:steer', onSteer)
    }
  }, [])

  useEffect(() => {
    if (!mention || !draftWorkspace) {
      setHits([])
      return
    }
    let cancelled = false
    const t = window.setTimeout(() => {
      void window.ion.suggestWorkspace({ workspaceRoot: draftWorkspace, query: mention.query }).then(
        (rows) => {
          if (cancelled) return
          setHits(rows)
          setHitIndex(0)
        }
      )
    }, 80)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [mention, draftWorkspace])

  useEffect(() => {
    if (!slashOpen || !slash) {
      setSkillHits([])
      return
    }
    let cancelled = false
    const t = window.setTimeout(() => {
      void window.ion.listSkills(draftWorkspace).then((rows) => {
        if (cancelled) return
        const q = slash.query.toLowerCase()
        setSkillHits(rows.filter((s) => skillMatches(s, q)))
        setSkillIndex(0)
      })
    }, 60)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [slash, slashOpen, draftWorkspace])

  const scanMention = (value: string, caret: number): void => {
    setMention(mentionAtCaret(value, caret))
    setSlash(slashAtCaret(value, caret))
  }

  const pickMention = (hit: WorkspaceMention): void => {
    if (!mention) return
    const end = mention.start + 1 + mention.query.length
    const next = `${text.slice(0, mention.start)}${text.slice(end)}`
    setText(next)
    addDraftMention(hit)
    setMention(null)
    setSlash(null)
    setHits([])
    queueMicrotask(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(mention.start, mention.start)
    })
  }

  const submit = (immediate = false): void => {
    const trimmed = text.trim()
    if (
      !trimmed &&
      draftAttachments.length === 0 &&
      draftMentions.length === 0 &&
      draftSkills.length === 0
    )
      return
    setText('')
    setMention(null)
    setHits([])
    setSlash(null)
    setSkillHits([])
    void send(trimmed, undefined, immediate ? { immediate: true } : undefined)
  }

  const pickSkill = (skill: SkillInfo): void => {
    if (!slash) return
    const end = slash.start + 1 + slash.query.length
    const next = `${text.slice(0, slash.start)}${text.slice(end)}`
    setText(next)
    addDraftSkill(skill)
    setSlash(null)
    setSkillHits([])
    queueMicrotask(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(slash.start, slash.start)
    })
  }
  steerRef.current = () => {
    if (canSend) submit(true)
    else textareaRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (slashOpen && (skillHits.length > 0 || e.key === 'Escape')) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setSkillIndex((i) => (skillHits.length ? (i + 1) % skillHits.length : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSkillIndex((i) => (skillHits.length ? (i - 1 + skillHits.length) % skillHits.length : 0))
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey && skillHits[skillIndex]) {
        e.preventDefault()
        e.stopPropagation()
        pickSkill(skillHits[skillIndex]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setSlash(null)
        setSkillHits([])
        return
      }
    }
    if (mentionOpen && (hits.length > 0 || e.key === 'Escape')) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setHitIndex((i) => (hits.length ? (i + 1) % hits.length : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setHitIndex((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0))
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey && hits[hitIndex]) {
        e.preventDefault()
        e.stopPropagation()
        pickMention(hits[hitIndex]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setMention(null)
        setHits([])
        return
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit(true)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(false)
    }
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    const files = filesFromDataTransfer(e.clipboardData)
    if (files.length === 0) return
    e.preventDefault()
    void addDraftFiles(files)
  }

  return (
    <div
      className={`no-drag w-full rounded-2xl border border-white/10 bg-card/80 backdrop-blur-xl shadow-sm ${
        variant === 'center' ? 'shadow-[0_12px_40px_-12px_rgba(0,0,0,0.7)]' : ''
      }`}
    >
      {queuedPrompts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {queuedPrompts.map((q, i) => (
            <div
              key={q.id}
              className="flex max-w-full items-center gap-1.5 rounded-md border border-line bg-white/[0.04] px-2 py-1 text-xs text-ink-muted"
              title={q.text}
            >
              <span className="shrink-0 text-ink-faint">{i + 1}.</span>
              <span className="min-w-0 truncate">
                {q.text ||
                  (q.skills?.length ? `/${q.skills[0]!.name}` : null) ||
                  (q.attachments?.length ? q.attachments[0]!.name : 'Follow-up')}
              </span>
              {q.attachments && q.attachments.length > 0 && (
                <span className="shrink-0 text-ink-faint">
                  +{q.attachments.length}
                </span>
              )}
              <button
                onClick={() => removeQueued(q.id)}
                className="shrink-0 hover:text-ink"
                title="Remove follow-up"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {draftSkills.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {draftSkills.map((s) => (
            <div
              key={s.name}
              className="flex max-w-full items-center gap-1.5 rounded-md border border-line bg-white/[0.04] px-2 py-1 text-xs text-ink-muted"
              title={s.description || s.name}
            >
              <Sparkles size={11} />
              <span className="min-w-0 truncate">/{s.name}</span>
              <button
                onClick={() => removeDraftSkill(s.name)}
                className="shrink-0 hover:text-ink"
                title="Remove skill"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {draftMentions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {draftMentions.map((m) => (
            <div
              key={m.path}
              className="flex max-w-full items-center gap-1.5 rounded-md border border-line bg-white/[0.04] px-2 py-1 text-xs text-ink-muted"
              title={m.path}
            >
              {m.kind === 'diff' || m.kind === 'staged' ? (
                <GitBranch size={11} />
              ) : m.isDir ? (
                <Folder size={11} />
              ) : (
                <FileText size={11} />
              )}
              <span className="min-w-0 truncate">
                {m.kind === 'diff' ? '@diff' : m.kind === 'staged' ? '@staged' : m.path}
              </span>
              <button
                onClick={() => removeDraftMention(m.path)}
                className="shrink-0 hover:text-ink"
                title="Remove mention"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {draftAttachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {draftAttachments.map((a) => (
            <DraftChip key={a.id} att={a} onRemove={() => removeDraftAttachment(a.id)} />
          ))}
        </div>
      )}

      {attachmentError && (
        <div className="px-4 pt-2 text-xs text-red-300">{attachmentError}</div>
      )}

      <div className="relative">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            scanMention(e.target.value, e.target.selectionStart)
          }}
          onClick={(e) => scanMention(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyUp={(e) => scanMention(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={variant === 'center' ? 2 : 1}
          placeholder={
            busy
              ? 'Enter queues · ⌘Enter steers now'
              : draftMode === 'plan'
                ? 'Describe what to plan - nothing gets changed'
                : draftWorkspace
                  ? 'Plan, search, build anything · @ file · / skill'
                  : 'Plan, search, build anything · / skill'
          }
          className="selectable max-h-[220px] w-full resize-none bg-transparent px-4 pt-3.5 text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        {slashOpen && (
          <div className="absolute bottom-full left-3 z-30 mb-1 max-h-56 min-w-[280px] max-w-[400px] overflow-auto rounded-lg border border-line bg-card py-1 shadow-lg">
            {skillHits.length === 0 ? (
              <div className="px-3 py-2 text-xs text-ink-faint">
                {slash.query ? `No skills matching “${slash.query}”` : 'No skills yet - add SKILL.md under .cursor/skills or ~/.ion/skills'}
              </div>
            ) : (
              skillHits.map((skill, i) => (
                <button
                  key={`${skill.source}:${skill.name}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickSkill(skill)
                  }}
                  className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left ${
                    i === skillIndex ? 'bg-white/10 text-ink' : 'text-ink-muted hover:bg-white/5'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-xs">
                    <Sparkles size={12} className="shrink-0" />
                    <span className="font-medium">/{skill.name}</span>
                    <span className="text-[10px] uppercase text-ink-faint">{skill.source}</span>
                  </span>
                  {skill.description && (
                    <span className="line-clamp-2 pl-[18px] text-[11px] text-ink-faint">
                      {skill.description}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
        {mentionOpen && (
          <div className="absolute bottom-full left-3 z-30 mb-1 max-h-56 min-w-[260px] max-w-[360px] overflow-auto rounded-lg border border-line bg-card py-1 shadow-lg">
            {!draftWorkspace ? (
              <div className="px-3 py-2 text-xs text-ink-faint">Open a folder to @ files</div>
            ) : hits.length === 0 ? (
              <div className="px-3 py-2 text-xs text-ink-faint">
                {mention.query ? `No matches for “${mention.query}”` : 'Type to filter files'}
              </div>
            ) : (
              hits.map((hit, i) => (
                <button
                  key={hit.path}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickMention(hit)
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                    i === hitIndex ? 'bg-white/10 text-ink' : 'text-ink-muted hover:bg-white/5'
                  }`}
                >
                  {hit.kind === 'diff' || hit.kind === 'staged' ? (
                    <GitBranch size={12} className="shrink-0" />
                  ) : hit.isDir ? (
                    <Folder size={12} className="shrink-0" />
                  ) : (
                    <FileText size={12} className="shrink-0" />
                  )}
                  <span className="min-w-0 truncate">
                    {hit.kind === 'diff'
                      ? '@diff - working tree'
                      : hit.kind === 'staged'
                        ? '@staged - index'
                        : hit.path}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
        <div className="flex min-w-0 items-center gap-0.5">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const list = e.target.files
              if (list?.length) void addDraftFiles(Array.from(list))
              e.target.value = ''
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-ink-muted hover:bg-white/5 hover:text-ink"
            title="Attach files"
          >
            <Paperclip size={14} />
          </button>
          {draftWorkspace ? (
            <div className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-white/[0.06] px-2 py-1 text-xs text-ink-muted">
              <FolderOpen size={13} className="text-accent" />
              <span className="max-w-[140px] truncate" title={draftWorkspace}>
                {basename(draftWorkspace)}
              </span>
              <button onClick={() => void clearWorkspace()} className="ml-0.5 hover:text-ink">
                <X size={12} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => void pickWorkspace()}
              className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-ink-muted hover:bg-white/5 hover:text-ink"
              title="Open folder"
            >
              <Folder size={14} />
            </button>
          )}
          <ModelPicker />
          <PermissionPicker />
          {config?.memoryEnabled === false && (
            <button
              onClick={() => void setMemoryEnabled(true)}
              title="Chat memory is off - the model won't see earlier messages. Click to turn it back on."
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-accent-soft px-2 py-1 text-xs text-accent hover:opacity-80"
            >
              <BrainCircuit size={13} />
              Memory off
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {busy && (
            <button
              onClick={() => submit(true)}
              title="Steer this turn now (⌘Enter)"
              className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-white/5 hover:text-ink"
            >
              Steer
            </button>
          )}
          <ContextUsage />
          {canSend && (
            <button
              onClick={() => submit(false)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-app transition hover:opacity-90"
              title={busy ? 'Enter queues · ⌘Enter steers now' : 'Send'}
            >
              <ArrowUp size={16} />
            </button>
          )}
          {!busy && !canSend && (
            <button
              disabled
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-app opacity-30"
              title="Send"
            >
              <ArrowUp size={16} />
            </button>
          )}
          {busy && (
            <button
              onClick={() => void abort()}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-app hover:opacity-90"
              title="Stop"
            >
              <Square size={13} fill="currentColor" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
