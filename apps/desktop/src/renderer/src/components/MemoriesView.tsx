import { useEffect, useState } from 'react'
import { GraduationCap, Globe, FolderOpen, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import type { MemoryFile } from '../../../shared/ipc'

const countEntries = (content: string): number =>
  content.split('\n').filter((l) => l.startsWith('- ')).length

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/**
 * Sidebar view over the learned-memory files: the durable learnings the agent
 * saves via `save_memory` and re-reads on every turn. One editable card per file.
 */
export default function MemoriesView(): React.JSX.Element {
  const memories = useStore((s) => s.memories)
  const config = useStore((s) => s.config)
  const refreshMemories = useStore((s) => s.refreshMemories)

  useEffect(() => {
    void refreshMemories()
  }, [refreshMemories])

  if (!memories) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-faint">
        Loading memories…
      </div>
    )
  }

  const totalEntries = memories.reduce((n, m) => n + countEntries(m.content), 0)

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-11 shrink-0" />

      <div className="flex shrink-0 items-end justify-between px-6 pb-4">
        <div>
          <div className="flex items-center gap-2 text-base font-semibold text-ink">
            <GraduationCap size={18} className="text-accent" />
            Memories
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">
            {totalEntries} {totalEntries === 1 ? 'learning' : 'learnings'} the agent saved for
            future sessions
            {config && !config.learningEnabled && (
              <span className="text-amber-300"> - self-learning is off, so none are used</span>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto max-w-[720px] space-y-4">
          {memories.map((file) => (
            <MemoryCard key={file.path} file={file} />
          ))}
        </div>
      </div>
    </div>
  )
}

function MemoryCard({ file }: { file: MemoryFile }): React.JSX.Element {
  const saveMemoryFile = useStore((s) => s.saveMemoryFile)
  const clearMemoryFile = useStore((s) => s.clearMemoryFile)
  const [draft, setDraft] = useState(file.content)

  // Re-sync after saves/clears refresh the list from disk.
  useEffect(() => setDraft(file.content), [file.content])

  const isGlobal = file.scope === 'global'
  const title = isGlobal
    ? 'Global memory'
    : file.workspaceRoot
      ? baseName(file.workspaceRoot)
      : baseName(file.path)
  const subtitle = isGlobal
    ? 'Applies to every chat'
    : (file.workspaceRoot ?? 'Workspace root unknown')
  const entries = countEntries(file.content)
  const dirty = draft !== file.content

  const clear = (): void => {
    if (window.confirm(`Delete all learnings in "${title}"? This cannot be undone.`)) {
      void clearMemoryFile(file.scope, file.workspaceRoot)
    }
  }

  return (
    <div className="rounded-xl border border-line bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        {isGlobal ? (
          <Globe size={15} className="shrink-0 text-accent" />
        ) : (
          <FolderOpen size={15} className="shrink-0 text-ink-muted" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ink">{title}</div>
          <div className="truncate text-[11px] text-ink-faint">{subtitle}</div>
        </div>
        <span className="rounded-full bg-white/[0.07] px-2 py-0.5 text-[11px] text-ink-faint">
          {entries} {entries === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      <textarea
        rows={Math.min(14, Math.max(5, draft.split('\n').length + 1))}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder={'No learnings yet. The agent adds dated bullets here as you chat, e.g.\n- [2026-08-13] Prefers concise commit messages'}
        className="w-full resize-y bg-transparent px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
      />

      <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
        <button
          onClick={clear}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10"
        >
          <Trash2 size={13} />
          Clear
        </button>
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              onClick={() => setDraft(file.content)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-white/5"
            >
              Revert
            </button>
          )}
          <button
            onClick={() => void saveMemoryFile(file.scope, file.workspaceRoot, draft)}
            disabled={!dirty}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-app hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
