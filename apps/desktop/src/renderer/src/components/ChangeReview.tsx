import { useState } from 'react'
import { Check, ChevronDown, ExternalLink, GitCommitHorizontal, RotateCcw, Sparkles } from 'lucide-react'
import { useStore, type UiChanges, type UiFileChange } from '../store'

export default function ChangeReview({ card }: { card: UiChanges }): React.JSX.Element {
  const restore = useStore((s) => s.restoreCheckpoint)
  const openInEditor = useStore((s) => s.openInEditor)
  const gitCommit = useStore((s) => s.gitCommit)
  const suggestCommitMessage = useStore((s) => s.suggestCommitMessage)
  const workspace = useStore((s) => s.draftWorkspace)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(card.files[0]?.path ?? null)
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [committed, setCommitted] = useState(false)

  const allRestored =
    card.files.length > 0 && card.files.every((f) => f.skipped || card.restoredPaths.includes(f.path))
  const restorable = card.files.filter((f) => !f.skipped)

  const run = async (path?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await restore(card.checkpointId, path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-medium text-ink">
          {card.files.length} file{card.files.length === 1 ? '' : 's'} changed
        </span>
        {allRestored && (
          <span className="flex items-center gap-1 text-[11px] text-ink-faint">
            <Check size={11} /> Restored
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {workspace && !allRestored && !committed && (
            <button
              disabled={busy}
              onClick={() => setCommitOpen((v) => !v)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-ink-muted hover:bg-white/5 hover:text-ink disabled:opacity-50"
              title="Commit these files"
            >
              <GitCommitHorizontal size={11} />
              Commit
            </button>
          )}
          {committed && (
            <span className="flex items-center gap-1 text-[11px] text-ink-faint">
              <Check size={11} /> Committed
            </span>
          )}
          {restorable.length > 0 && !allRestored && (
            <button
              disabled={busy}
              onClick={() => void run()}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-ink-muted hover:bg-white/5 hover:text-ink disabled:opacity-50"
              title="Restore every file in this turn"
            >
              <RotateCcw size={11} />
              Restore all
            </button>
          )}
        </div>
      </div>

      <div className="divide-y divide-line">
        {card.files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            expanded={openPath === file.path}
            restored={card.restoredPaths.includes(file.path)}
            busy={busy}
            canOpen={Boolean(workspace)}
            onToggle={() => setOpenPath((p) => (p === file.path ? null : file.path))}
            onRestore={() => void run(file.path)}
            onOpen={() => void openInEditor(file.path)}
          />
        ))}
      </div>
      {commitOpen && !committed && (
        <div className="border-t border-line px-3 py-2">
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            rows={3}
            placeholder="Commit message"
            className="w-full resize-y rounded-md border border-line bg-black/30 px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setError(null)
                void suggestCommitMessage()
                  .then((msg) => setCommitMsg(msg))
                  .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setBusy(false))
              }}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-ink-muted hover:bg-white/5 hover:text-ink disabled:opacity-50"
            >
              <Sparkles size={11} />
              Suggest
            </button>
            <button
              disabled={busy || !commitMsg.trim()}
              onClick={() => {
                setBusy(true)
                setError(null)
                void gitCommit(
                  commitMsg.trim(),
                  card.files.filter((f) => !f.skipped).map((f) => f.path)
                )
                  .then(() => {
                    setCommitted(true)
                    setCommitOpen(false)
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setBusy(false))
              }}
              className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-app hover:opacity-90 disabled:opacity-40"
            >
              Commit
            </button>
          </div>
        </div>
      )}
      {error && <div className="border-t border-line px-3 py-2 text-xs text-red-300">{error}</div>}
    </div>
  )
}

function FileRow({
  file,
  expanded,
  restored,
  busy,
  canOpen,
  onToggle,
  onRestore,
  onOpen
}: {
  file: UiFileChange
  expanded: boolean
  restored: boolean
  busy: boolean
  canOpen: boolean
  onToggle: () => void
  onRestore: () => void
  onOpen: () => void
}): React.JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronDown
            size={12}
            className={`shrink-0 text-ink-faint transition-transform ${expanded ? '' : '-rotate-90'}`}
          />
          <span className="min-w-0 truncate font-mono text-xs text-ink">{file.path}</span>
          {file.created && <span className="shrink-0 text-[10px] uppercase text-ink-faint">new</span>}
          {restored && <span className="shrink-0 text-[10px] uppercase text-ink-faint">restored</span>}
        </button>
        {!file.skipped && (
          <span className="shrink-0 font-mono text-[11px]">
            {file.additions > 0 && <span className="text-emerald-400">+{file.additions}</span>}
            {file.additions > 0 && file.deletions > 0 && ' '}
            {file.deletions > 0 && <span className="text-red-400">−{file.deletions}</span>}
          </span>
        )}
        {canOpen && (
          <button
            onClick={onOpen}
            className="rounded-md p-1 text-ink-faint hover:bg-white/5 hover:text-ink"
            title="Open in editor"
          >
            <ExternalLink size={12} />
          </button>
        )}
        {!file.skipped && !restored && (
          <button
            disabled={busy}
            onClick={onRestore}
            className="rounded-md p-1 text-ink-faint hover:bg-white/5 hover:text-ink disabled:opacity-50"
            title="Restore this file"
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
      {expanded && (
        <pre className="diff-block selectable mx-3 mb-2 overflow-x-auto rounded-md border border-white/10 bg-black/30 p-2 text-[11px] leading-relaxed">
          {file.diff.split('\n').map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'diff-add'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'diff-del'
                    : line.startsWith('@@')
                      ? 'diff-hunk'
                      : 'text-ink-muted'
              }
            >
              {line || ' '}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}
