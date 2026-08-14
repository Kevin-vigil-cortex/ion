import { Fragment, useState } from 'react'
import { Plus, Trash2, X, AlignLeft, SquareKanban } from 'lucide-react'
import { useStore } from '../store'
import type { BoardCard, BoardColumn } from '../../../shared/ipc'

interface DropTarget {
  columnId: string
  /** Insert before this card; null means append to the end of the column. */
  beforeCardId: string | null
}

export default function BoardView(): React.JSX.Element {
  const board = useStore((s) => s.board)
  const moveCard = useStore((s) => s.moveCard)

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [editing, setEditing] = useState<BoardCard | null>(null)

  if (!board) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-faint">
        Loading board…
      </div>
    )
  }

  const totalCards = board.columns.reduce((n, c) => n + c.cards.length, 0)

  // Avoid a state update (re-render) per dragover event unless the target changed.
  const updateDropTarget = (next: DropTarget | null): void => {
    setDropTarget((prev) =>
      prev &&
      next &&
      prev.columnId === next.columnId &&
      prev.beforeCardId === next.beforeCardId
        ? prev
        : next
    )
  }

  const clearDrag = (): void => {
    setDraggingId(null)
    setDropTarget(null)
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    if (draggingId && dropTarget) {
      void moveCard(draggingId, dropTarget.columnId, dropTarget.beforeCardId)
    }
    clearDrag()
  }

  const showIndicator = (columnId: string, beforeCardId: string | null): boolean =>
    draggingId !== null &&
    dropTarget !== null &&
    dropTarget.columnId === columnId &&
    dropTarget.beforeCardId === beforeCardId &&
    // Dropping a card directly above itself is a no-op; don't suggest otherwise.
    dropTarget.beforeCardId !== draggingId

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-11 shrink-0" />

      <div className="flex shrink-0 items-end justify-between px-6 pb-4">
        <div>
          <div className="flex items-center gap-2 text-base font-semibold text-ink">
            <SquareKanban size={18} className="text-accent" />
            Board
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">
            {totalCards} {totalCards === 1 ? 'card' : 'cards'} across {board.columns.length}{' '}
            {board.columns.length === 1 ? 'column' : 'columns'}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto px-6 pb-6">
        <div className="flex h-full items-start gap-4">
          {board.columns.map((column) => (
            <Column
              key={column.id}
              column={column}
              draggingId={draggingId}
              onDragStart={setDraggingId}
              onDragEnd={clearDrag}
              onDrop={handleDrop}
              updateDropTarget={updateDropTarget}
              showIndicator={showIndicator}
              onOpenCard={setEditing}
            />
          ))}
          <AddColumn />
        </div>
      </div>

      {editing && <CardEditor card={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

interface ColumnProps {
  column: BoardColumn
  draggingId: string | null
  onDragStart(cardId: string): void
  onDragEnd(): void
  onDrop(e: React.DragEvent): void
  updateDropTarget(next: DropTarget | null): void
  showIndicator(columnId: string, beforeCardId: string | null): boolean
  onOpenCard(card: BoardCard): void
}

function Column(props: ColumnProps): React.JSX.Element {
  const { column, draggingId } = props
  const renameColumn = useStore((s) => s.renameColumn)
  const deleteColumn = useStore((s) => s.deleteColumn)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)

  const commitTitle = (): void => {
    const next = titleDraft?.trim()
    if (next && next !== column.title) void renameColumn(column.id, next)
    setTitleDraft(null)
  }

  const removeColumn = (): void => {
    const count = column.cards.length
    if (
      count === 0 ||
      window.confirm(`Delete "${column.title}" and its ${count} card${count === 1 ? '' : 's'}?`)
    ) {
      void deleteColumn(column.id)
    }
  }

  // While a drag is in flight, treat hovering anywhere over the column as
  // "append to end" unless a card refines it to a specific slot.
  const onColumnDragOver = (e: React.DragEvent): void => {
    if (!draggingId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    props.updateDropTarget({ columnId: column.id, beforeCardId: null })
  }

  const onCardDragOver = (e: React.DragEvent, index: number): void => {
    if (!draggingId) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const inTopHalf = e.clientY < rect.top + rect.height / 2
    const anchor = inTopHalf
      ? (column.cards[index]?.id ?? null)
      : (column.cards[index + 1]?.id ?? null)
    props.updateDropTarget({ columnId: column.id, beforeCardId: anchor })
  }

  return (
    <div
      onDragOver={onColumnDragOver}
      onDrop={props.onDrop}
      className="group/col flex max-h-full w-72 shrink-0 flex-col rounded-xl border border-white/10 bg-black/30 backdrop-blur-md"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5">
        {titleDraft !== null ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle()
              if (e.key === 'Escape') setTitleDraft(null)
            }}
            className="w-full rounded-md border border-line bg-card px-1.5 py-0.5 text-[13px] font-semibold text-ink outline-none focus:border-accent"
          />
        ) : (
          <>
            <button
              onDoubleClick={() => setTitleDraft(column.title)}
              title="Double-click to rename"
              className="truncate text-[13px] font-semibold text-ink"
            >
              {column.title}
            </button>
            <span className="rounded-full bg-white/[0.07] px-1.5 text-[11px] text-ink-faint">
              {column.cards.length}
            </span>
            <span className="flex-1" />
            <button
              onClick={removeColumn}
              title="Delete column"
              className="opacity-0 transition group-hover/col:opacity-100"
            >
              <Trash2 size={13} className="text-ink-faint hover:text-ink" />
            </button>
          </>
        )}
      </div>

      <div className="min-h-[44px] flex-1 overflow-y-auto px-2 py-1">
        {column.cards.map((card, index) => (
          <Fragment key={card.id}>
            <DropIndicator show={props.showIndicator(column.id, card.id)} />
            <div
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', card.id)
                e.dataTransfer.effectAllowed = 'move'
                props.onDragStart(card.id)
              }}
              onDragEnd={props.onDragEnd}
              onDragOver={(e) => onCardDragOver(e, index)}
              onClick={() => props.onOpenCard(card)}
              className={`my-[3px] cursor-grab rounded-lg border border-line bg-card px-3 py-2 shadow-sm transition hover:border-ink-faint ${
                draggingId === card.id ? 'opacity-40' : ''
              }`}
            >
              <div className="text-[13px] leading-snug text-ink">{card.title}</div>
              {card.notes.trim().length > 0 && (
                <AlignLeft size={13} className="mt-1.5 text-ink-faint" />
              )}
            </div>
          </Fragment>
        ))}
        <DropIndicator show={props.showIndicator(column.id, null)} />
        {column.cards.length === 0 && !draggingId && (
          <div className="px-2 py-2 text-center text-xs text-ink-faint">No cards</div>
        )}
      </div>

      <AddCard columnId={column.id} />
    </div>
  )
}

function DropIndicator({ show }: { show: boolean }): React.JSX.Element {
  return <div className={show ? 'mx-1 my-[3px] h-[3px] rounded-full bg-accent' : 'h-0'} />
}

function AddCard({ columnId }: { columnId: string }): React.JSX.Element {
  const addCard = useStore((s) => s.addCard)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')

  const close = (): void => {
    setOpen(false)
    setText('')
  }

  const commit = (): void => {
    const title = text.trim()
    if (!title) return
    void addCard(columnId, title)
    setText('') // stay open for quick successive adds
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mx-2 mb-2 mt-0.5 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-faint hover:bg-white/5 hover:text-ink-muted"
      >
        <Plus size={14} />
        Add a card
      </button>
    )
  }

  return (
    <div className="shrink-0 px-2 pb-2 pt-0.5">
      <textarea
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Escape') close()
        }}
        placeholder="Card title, Enter to add"
        className="w-full resize-none rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
      />
      <div className="mt-1 flex items-center gap-1.5">
        <button
          onClick={commit}
          className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-app hover:opacity-90"
        >
          Add card
        </button>
        <button onClick={close} className="rounded-md p-1 text-ink-faint hover:bg-white/5">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

function AddColumn(): React.JSX.Element {
  const addColumn = useStore((s) => s.addColumn)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')

  const close = (): void => {
    setOpen(false)
    setTitle('')
  }

  const commit = (): void => {
    const t = title.trim()
    if (!t) return
    void addColumn(t)
    close()
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-72 shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-line px-3 py-2.5 text-[13px] text-ink-faint transition hover:border-ink-faint hover:text-ink-muted"
      >
        <Plus size={14} />
        Add column
      </button>
    )
  }

  return (
    <div className="w-72 shrink-0 rounded-xl border border-white/10 bg-black/30 p-2 backdrop-blur-md">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') close()
        }}
        placeholder="Column name"
        className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          onClick={commit}
          className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-app hover:opacity-90"
        >
          Add column
        </button>
        <button onClick={close} className="rounded-md p-1 text-ink-faint hover:bg-white/5">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

function CardEditor({ card, onClose }: { card: BoardCard; onClose(): void }): React.JSX.Element {
  const updateCard = useStore((s) => s.updateCard)
  const deleteCard = useStore((s) => s.deleteCard)
  const [title, setTitle] = useState(card.title)
  const [notes, setNotes] = useState(card.notes)

  const save = (): void => {
    void updateCard(card.id, { title: title.trim() || card.title, notes })
    onClose()
  }

  const remove = (): void => {
    void deleteCard(card.id)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink">Edit card</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">
              Title
            </label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
              }}
              className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">
              Notes
            </label>
            <textarea
              rows={6}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add more detail…"
              className="w-full resize-none rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          <button
            onClick={remove}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10"
          >
            <Trash2 size={13} />
            Delete
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-app hover:opacity-90"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
