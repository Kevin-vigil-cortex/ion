import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { useStore } from '../store'

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High'
}

export default function ModelPicker(): React.JSX.Element {
  const models = useStore((s) => s.models)
  const draftModel = useStore((s) => s.draftModel)
  const draftEffort = useStore((s) => s.draftEffort)
  const selectModel = useStore((s) => s.selectModel)
  const selectEffort = useStore((s) => s.selectEffort)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const current = models.find((m) => m.id === draftModel)
  const efforts = current?.efforts ?? []
  const modelLabel = current?.label ?? draftModel
  const label =
    efforts.length > 0
      ? `${modelLabel} · ${EFFORT_LABELS[draftEffort] ?? draftEffort}`
      : modelLabel

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-white/5 hover:text-ink"
      >
        {label}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[190px] rounded-lg border border-line bg-card py-1 shadow-lg">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                void selectModel(m.id)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink hover:bg-white/5"
            >
              <span className="flex-1">{m.label ?? m.id}</span>
              {m.id === draftModel && <Check size={13} className="text-accent" />}
            </button>
          ))}
          {efforts.length > 0 && (
            <>
              <div className="mx-3 my-1 h-px bg-line" />
              <div className="px-3 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
                Reasoning effort
              </div>
              {efforts.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    void selectEffort(e)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink hover:bg-white/5"
                >
                  <span className="flex-1">{EFFORT_LABELS[e] ?? e}</span>
                  {e === draftEffort && <Check size={13} className="text-accent" />}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
