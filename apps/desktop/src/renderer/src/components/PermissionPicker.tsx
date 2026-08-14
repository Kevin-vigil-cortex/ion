import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, Shield, ListTodo } from 'lucide-react'
import { useStore } from '../store'
import type { ApprovalMode } from '../../../shared/ipc'

/**
 * Codex-style single selector: Plan (read-only session mode) lives in the
 * same menu as the three approval levels. Picking a level while in Plan
 * flips the chat back to Agent mode with that level.
 */
type Choice = 'plan' | ApprovalMode

const CHOICES: { id: Choice; label: string; desc: string; danger?: boolean }[] = [
  { id: 'ask', label: 'Ask for approval', desc: 'Asks before every action.' },
  { id: 'auto', label: 'Approve for me', desc: 'Edits run; terminal and computer use still ask.' },
  { id: 'plan', label: 'Plan', desc: 'Read-only: explores and writes a plan.' },
  { id: 'full', label: 'Full access', desc: 'Never asks.', danger: true }
]

/** Short label for the composer bar; the dropdown shows the full names. */
const SHORT: Record<Choice, string> = {
  plan: 'Plan',
  ask: 'Ask',
  auto: 'Auto',
  full: 'Full access'
}

export default function PermissionPicker(): React.JSX.Element | null {
  const config = useStore((s) => s.config)
  const setApprovalMode = useStore((s) => s.setApprovalMode)
  const draftMode = useStore((s) => s.draftMode)
  const selectMode = useStore((s) => s.selectMode)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  if (!config) return null
  const current: Choice = draftMode === 'plan' ? 'plan' : config.approvalMode

  const choose = (choice: Choice): void => {
    if (choice === 'plan') {
      void selectMode('plan')
    } else {
      // Leaving Plan re-arms the full tool set, then applies the level.
      if (draftMode === 'plan') void selectMode('agent')
      void setApprovalMode(choice)
    }
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Mode & permissions"
        className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs hover:bg-white/5 ${
          current === 'full'
            ? 'text-red-400'
            : current === 'plan'
              ? 'bg-white/[0.08] text-ink'
              : 'text-ink-muted'
        }`}
      >
        {current === 'plan' ? <ListTodo size={13} /> : <Shield size={13} />}
        {SHORT[current]}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[230px] rounded-lg border border-line bg-card py-1 shadow-lg">
          {CHOICES.map((opt) => (
            <button
              key={opt.id}
              onClick={() => choose(opt.id)}
              className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-white/5"
            >
              <div className="min-w-0 flex-1">
                <div className={`text-xs ${opt.danger ? 'text-red-400' : 'text-ink'}`}>
                  {opt.label}
                </div>
                <div className={`text-[11px] ${opt.danger ? 'text-red-400/70' : 'text-ink-faint'}`}>
                  {opt.desc}
                </div>
              </div>
              {current === opt.id && <Check size={13} className="mt-0.5 shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
