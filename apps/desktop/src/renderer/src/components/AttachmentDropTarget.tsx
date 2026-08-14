import { useState, type DragEvent, type ReactNode } from 'react'
import { useStore } from '../store'
import { filesFromDataTransfer } from '../media'

export default function AttachmentDropTarget({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const addDraftFiles = useStore((s) => s.addDraftFiles)
  const [over, setOver] = useState(false)

  const onDragOver = (e: DragEvent): void => {
    if (![...e.dataTransfer.types].includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }

  const onDragLeave = (e: DragEvent): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setOver(false)
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const files = filesFromDataTransfer(e.dataTransfer)
    if (files.length) void addDraftFiles(files)
  }

  return (
    <div className="relative h-full min-w-0 flex-1" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-none border-2 border-dashed border-accent bg-black/55">
          <div className="text-sm font-medium tracking-wide text-ink">Drop to attach</div>
        </div>
      )}
    </div>
  )
}
