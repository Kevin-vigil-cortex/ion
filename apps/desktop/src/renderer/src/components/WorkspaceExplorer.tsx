import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  PanelLeftClose,
  Pencil,
  RotateCw,
  Trash2
} from 'lucide-react'
import { useStore } from '../store'
import type { FsEntry } from '../../../shared/ipc'

const api = window.ion

/** Noise never worth rendering, mirroring the agent search tools. */
const HIDDEN = new Set(['.git', 'node_modules'])

/** Workspace-relative path helpers ('' = the workspace root). */
const joinRel = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name)
const parentOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const nameOf = (rel: string): string => (rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel)
const basename = (p: string): string => {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

type Editing =
  | { mode: 'create'; kind: 'file' | 'dir'; parentRel: string }
  | { mode: 'rename'; rel: string }

interface MenuState {
  x: number
  y: number
  rel: string
  isDir: boolean
}

export default function WorkspaceExplorer(): React.JSX.Element | null {
  const root = useStore((s) => s.draftWorkspace)
  const open = useStore((s) => s.explorerOpen)
  const setExplorerOpen = useStore((s) => s.setExplorerOpen)

  /** Loaded directory listings, keyed by workspace-relative path. */
  const [dirs, setDirs] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)

  const fail = useCallback((e: unknown): void => {
    const raw = e instanceof Error ? e.message : String(e)
    // Electron prefixes renderer-visible errors with the invoked channel; strip it.
    setError(raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''))
  }, [])

  const load = useCallback(
    async (rel: string): Promise<void> => {
      if (!root) return
      const entries = await api.fsList({ workspaceRoot: root, relPath: rel })
      setDirs((d) => ({ ...d, [rel]: entries.filter((e) => !HIDDEN.has(e.name)) }))
    },
    [root]
  )

  useEffect(() => {
    setDirs({})
    setExpanded(new Set())
    setSelected(null)
    setEditing(null)
    setMenu(null)
    setError(null)
    load('').catch(fail)
  }, [root, load, fail])

  const isDirRel = (rel: string): boolean =>
    dirs[parentOf(rel)]?.find((e) => e.name === nameOf(rel))?.isDir ?? false

  /** Drop a directory (and everything under it) from the local cache. */
  const forgetSubtree = (rel: string): void => {
    const inside = (k: string): boolean => k === rel || k.startsWith(rel + '/')
    setDirs((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !inside(k))))
    setExpanded((prev) => new Set([...prev].filter((k) => !inside(k))))
  }

  const toggleDir = (rel: string): void => {
    const isOpen = expanded.has(rel)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (isOpen) next.delete(rel)
      else next.add(rel)
      return next
    })
    if (!isOpen && dirs[rel] === undefined) load(rel).catch(fail)
  }

  const refresh = (): void => {
    setError(null)
    load('').catch(fail)
    for (const rel of expanded) {
      // A dir may have vanished outside the app; drop it quietly.
      load(rel).catch(() => forgetSubtree(rel))
    }
  }

  const startCreate = (kind: 'file' | 'dir', parentRel: string): void => {
    setMenu(null)
    setError(null)
    if (parentRel) {
      setExpanded((prev) => new Set(prev).add(parentRel))
      if (dirs[parentRel] === undefined) load(parentRel).catch(fail)
    }
    setEditing({ mode: 'create', kind, parentRel })
  }

  /** Header buttons create inside the selected folder (or the selected file's folder). */
  const createBase = (): string => {
    if (!selected) return ''
    return isDirRel(selected) ? selected : parentOf(selected)
  }

  const commitCreate = async (name: string): Promise<void> => {
    if (editing?.mode !== 'create' || !root) return
    const { kind, parentRel } = editing
    setEditing(null)
    const trimmed = name.trim()
    if (!trimmed) return
    const rel = joinRel(parentRel, trimmed)
    try {
      if (kind === 'file') await api.fsCreateFile({ workspaceRoot: root, relPath: rel })
      else await api.fsCreateDir({ workspaceRoot: root, relPath: rel })
      await load(parentRel)
      setSelected(rel)
    } catch (e) {
      fail(e)
    }
  }

  const startRename = (rel: string): void => {
    setMenu(null)
    setError(null)
    setEditing({ mode: 'rename', rel })
  }

  const commitRename = async (newName: string): Promise<void> => {
    if (editing?.mode !== 'rename' || !root) return
    const from = editing.rel
    setEditing(null)
    const trimmed = newName.trim()
    if (!trimmed || trimmed === nameOf(from)) return
    const to = joinRel(parentOf(from), trimmed)
    try {
      await api.fsRename({ workspaceRoot: root, fromRelPath: from, toRelPath: to })
      const wasExpanded = expanded.has(from)
      forgetSubtree(from)
      await load(parentOf(from))
      if (wasExpanded) {
        setExpanded((prev) => new Set(prev).add(to))
        await load(to)
      }
      setSelected(to)
    } catch (e) {
      fail(e)
    }
  }

  const doDelete = async (rel: string): Promise<void> => {
    setMenu(null)
    if (!root) return
    if (!window.confirm(`Move "${nameOf(rel)}" to the Trash?`)) return
    try {
      await api.fsDelete({ workspaceRoot: root, relPath: rel })
      forgetSubtree(rel)
      setSelected((sel) => (sel && (sel === rel || sel.startsWith(rel + '/')) ? null : sel))
      await load(parentOf(rel))
    } catch (e) {
      fail(e)
    }
  }

  const canDrop = (src: string, targetDir: string): boolean =>
    src !== targetDir && parentOf(src) !== targetDir && !targetDir.startsWith(src + '/')

  const onDropTo = async (targetDir: string): Promise<void> => {
    const src = dragging
    setDragging(null)
    setDropDir(null)
    if (!src || !root || !canDrop(src, targetDir)) return
    const dest = joinRel(targetDir, nameOf(src))
    try {
      await api.fsRename({ workspaceRoot: root, fromRelPath: src, toRelPath: dest })
      forgetSubtree(src)
      await Promise.all([load(parentOf(src)), load(targetDir)])
      if (targetDir) setExpanded((prev) => new Set(prev).add(targetDir))
      setSelected(dest)
    } catch (e) {
      fail(e)
    }
  }

  const renderRow = (entry: FsEntry, dirRel: string, depth: number): React.JSX.Element => {
    const rel = joinRel(dirRel, entry.name)
    const isExpanded = entry.isDir && expanded.has(rel)
    const isRenaming = editing?.mode === 'rename' && editing.rel === rel

    return (
      <div key={rel}>
        {isRenaming ? (
          <div className="flex items-center gap-1 py-px" style={{ paddingLeft: 8 + depth * 14 }}>
            {entry.isDir ? (
              <Folder size={14} className="ml-[13px] shrink-0 text-accent" />
            ) : (
              <FileText size={14} className="ml-[13px] shrink-0 text-ink-faint" />
            )}
            <NameInput
              initial={entry.name}
              onCommit={(v) => void commitRename(v)}
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : (
          <div
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', rel)
              e.dataTransfer.effectAllowed = 'move'
              setDragging(rel)
            }}
            onDragEnd={() => {
              setDragging(null)
              setDropDir(null)
            }}
            onDragOver={(e) => {
              if (!dragging) return
              e.stopPropagation()
              const target = entry.isDir ? rel : dirRel
              if (!canDrop(dragging, target)) {
                setDropDir((prev) => (prev === null ? prev : null))
                return
              }
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropDir((prev) => (prev === target ? prev : target))
            }}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void onDropTo(entry.isDir ? rel : dirRel)
            }}
            onClick={(e) => {
              e.stopPropagation()
              setSelected(rel)
              if (entry.isDir) toggleDir(rel)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setSelected(rel)
              setMenu({ x: e.clientX, y: e.clientY, rel, isDir: entry.isDir })
            }}
            title={rel}
            style={{ paddingLeft: 8 + depth * 14 }}
            className={`flex cursor-pointer items-center gap-1 rounded-md py-[3px] pr-1.5 text-[13px] ${
              selected === rel ? 'bg-white/[0.08] text-ink' : 'text-ink-muted hover:bg-white/5'
            } ${
              dropDir === rel && dragging ? 'bg-accent-soft ring-1 ring-inset ring-accent' : ''
            } ${dragging === rel ? 'opacity-40' : ''}`}
          >
            {entry.isDir ? (
              <ChevronRight
                size={13}
                className={`shrink-0 text-ink-faint transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              />
            ) : (
              <span className="w-[13px] shrink-0" />
            )}
            {entry.isDir ? (
              isExpanded ? (
                <FolderOpen size={14} className="shrink-0 text-accent" />
              ) : (
                <Folder size={14} className="shrink-0 text-accent" />
              )
            ) : (
              <FileText size={14} className="shrink-0 text-ink-faint" />
            )}
            <span className="truncate">{entry.name}</span>
          </div>
        )}
        {entry.isDir && isExpanded && renderChildren(rel, depth + 1)}
      </div>
    )
  }

  const renderChildren = (dirRel: string, depth: number): React.JSX.Element => {
    const entries = dirs[dirRel]
    const creating = editing?.mode === 'create' && editing.parentRel === dirRel ? editing : null
    return (
      <div>
        {creating && (
          <div className="flex items-center gap-1 py-px" style={{ paddingLeft: 8 + depth * 14 }}>
            {creating.kind === 'dir' ? (
              <Folder size={14} className="ml-[13px] shrink-0 text-accent" />
            ) : (
              <FileText size={14} className="ml-[13px] shrink-0 text-ink-faint" />
            )}
            <NameInput
              initial=""
              placeholder={creating.kind === 'dir' ? 'folder name' : 'file name'}
              onCommit={(v) => void commitCreate(v)}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}
        {entries === undefined ? (
          <div className="py-[3px] text-xs text-ink-faint" style={{ paddingLeft: 21 + depth * 14 }}>
            Loading…
          </div>
        ) : entries.length === 0 && !creating ? (
          <div
            className="py-[3px] text-xs italic text-ink-faint"
            style={{ paddingLeft: 21 + depth * 14 }}
          >
            empty
          </div>
        ) : (
          entries.map((e) => renderRow(e, dirRel, depth))
        )}
      </div>
    )
  }

  if (!root) return null

  if (!open) {
    return (
      <div className="flex h-full w-10 shrink-0 flex-col items-center border-r border-white/10 bg-black/25 backdrop-blur-lg">
        <div className="drag h-11 w-full shrink-0" />
        <button
          onClick={() => setExplorerOpen(true)}
          title="Show explorer"
          className="no-drag rounded-md p-1.5 text-ink-muted hover:bg-white/5 hover:text-ink"
        >
          <FolderTree size={15} />
        </button>
      </div>
    )
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-white/10 bg-black/25 backdrop-blur-lg">
      <div className="drag h-11 shrink-0" />

      <div className="no-drag flex shrink-0 items-center gap-0.5 px-2 pb-1">
        <span
          className="min-w-0 flex-1 truncate pl-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint"
          title={root}
        >
          {basename(root)}
        </span>
        <HeaderBtn title="New file" onClick={() => startCreate('file', createBase())}>
          <FilePlus2 size={14} />
        </HeaderBtn>
        <HeaderBtn title="New folder" onClick={() => startCreate('dir', createBase())}>
          <FolderPlus size={14} />
        </HeaderBtn>
        <HeaderBtn title="Refresh" onClick={refresh}>
          <RotateCw size={13} />
        </HeaderBtn>
        <HeaderBtn title="Hide explorer" onClick={() => setExplorerOpen(false)}>
          <PanelLeftClose size={14} />
        </HeaderBtn>
      </div>

      <div
        className={`no-drag min-h-0 flex-1 overflow-y-auto px-2 pb-2 ${
          dragging && dropDir === '' ? 'bg-accent-soft/40' : ''
        }`}
        onClick={() => setSelected(null)}
        onDragOver={(e) => {
          if (!dragging) return
          if (!canDrop(dragging, '')) {
            setDropDir((prev) => (prev === null ? prev : null))
            return
          }
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDropDir((prev) => (prev === '' ? prev : ''))
        }}
        onDrop={(e) => {
          e.preventDefault()
          void onDropTo('')
        }}
      >
        {renderChildren('', 0)}
      </div>

      {error && (
        <div className="no-drag flex shrink-0 items-start justify-between gap-2 border-t border-line px-3 py-2 text-xs text-red-400">
          <span className="selectable min-w-0 break-words">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 text-ink-faint hover:text-ink">
            ×
          </button>
        </div>
      )}

      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          />
          <div
            className="fixed z-50 w-44 rounded-lg border border-line bg-card py-1 shadow-xl"
            style={{
              left: Math.min(menu.x, window.innerWidth - 190),
              top: Math.min(menu.y, window.innerHeight - 170)
            }}
          >
            {menu.isDir && (
              <>
                <MenuItem
                  icon={<FilePlus2 size={13} />}
                  label="New file"
                  onClick={() => startCreate('file', menu.rel)}
                />
                <MenuItem
                  icon={<FolderPlus size={13} />}
                  label="New folder"
                  onClick={() => startCreate('dir', menu.rel)}
                />
                <div className="mx-2 my-1 h-px bg-line" />
              </>
            )}
            <MenuItem icon={<Pencil size={13} />} label="Rename" onClick={() => startRename(menu.rel)} />
            <MenuItem
              icon={<Trash2 size={13} />}
              label="Delete"
              danger
              onClick={() => void doDelete(menu.rel)}
            />
          </div>
        </>
      )}
    </aside>
  )
}

function HeaderBtn(props: {
  title: string
  onClick(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      className="rounded-md p-1 text-ink-faint hover:bg-white/5 hover:text-ink"
    >
      {props.children}
    </button>
  )
}

function MenuItem(props: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      onClick={props.onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${
        props.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-ink hover:bg-white/5'
      }`}
    >
      {props.icon}
      {props.label}
    </button>
  )
}

/** Inline name editor: Enter commits, Escape or blur cancels. */
function NameInput(props: {
  initial: string
  placeholder?: string
  onCommit(value: string): void
  onCancel(): void
}): React.JSX.Element {
  const [value, setValue] = useState(props.initial)
  const committed = useRef(false)
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          committed.current = true
          props.onCommit(value)
        }
        if (e.key === 'Escape') props.onCancel()
      }}
      onBlur={() => {
        if (!committed.current) props.onCancel()
      }}
      placeholder={props.placeholder}
      className="w-full min-w-0 rounded border border-accent bg-card px-1 py-px text-[13px] text-ink outline-none placeholder:text-ink-faint"
    />
  )
}
