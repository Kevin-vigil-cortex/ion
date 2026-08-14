import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../store'

/** Mirrors the conservative default in @ion/xai for unknown models. */
const DEFAULT_CONTEXT_WINDOW = 256_000

const SEGMENTS: { key: 'system' | 'tools' | 'memory' | 'conversation'; label: string; color: string }[] = [
  { key: 'system', label: 'System prompt', color: '#8b90a0' },
  { key: 'tools', label: 'Tool definitions', color: '#8f7ce8' },
  { key: 'memory', label: 'Learned memory', color: '#5fae74' },
  { key: 'conversation', label: 'Conversation', color: '#d0653a' }
]

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  const scaled = n < 1_000_000 ? n / 1000 : n / 1_000_000
  const unit = n < 1_000_000 ? 'K' : 'M'
  const s = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, '')
  return s + unit
}

function fmtUsd(v: number): string {
  if (v > 0 && v < 0.01) return '$' + v.toFixed(4)
  return '$' + v.toFixed(2)
}

export default function ContextUsage(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const contextStats = useStore((s) => s.contextStats)
  const sessionUsage = useStore((s) => s.sessionUsage)
  const lifetimeUsage = useStore((s) => s.lifetimeUsage)
  const refreshLifetimeUsage = useStore((s) => s.refreshLifetimeUsage)
  const config = useStore((s) => s.config)
  const models = useStore((s) => s.models)
  const draftModel = useStore((s) => s.draftModel)

  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  useEffect(() => {
    if (open) void refreshLifetimeUsage()
  }, [open, refreshLifetimeUsage])

  const contextWindow =
    models.find((m) => m.id === draftModel)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW

  const counts = {
    system: contextStats?.systemPromptTokens ?? 0,
    tools: contextStats?.toolDefTokens ?? 0,
    memory: contextStats?.memoryTokens,
    conversation: contextStats?.conversationTokens ?? 0
  }
  const total = contextStats?.totalTokens ?? 0
  const pct = Math.min(100, Math.round((total / contextWindow) * 100))

  const rows = SEGMENTS.filter((seg) => (seg.key === 'memory' ? counts.memory !== undefined : true))

  const isApiKey = config?.authMode === 'api_key'

  // Tiny fullness ring for the trigger button.
  const R = 5.5
  const C = 2 * Math.PI * R

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Context usage"
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] tabular-nums text-ink-muted hover:bg-white/5"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" className="-rotate-90">
          <circle cx="7" cy="7" r={R} fill="none" stroke="var(--color-line)" strokeWidth="2.5" />
          <circle
            cx="7"
            cy="7"
            r={R}
            fill="none"
            stroke={pct >= 90 ? '#e5484d' : 'var(--color-accent)'}
            strokeWidth="2.5"
            strokeDasharray={`${(pct / 100) * C} ${C}`}
            strokeLinecap="round"
          />
        </svg>
        {pct}%
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-2 w-[340px] rounded-xl border border-line bg-card p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-ink">Context Usage</span>
            <button onClick={() => setOpen(false)} className="text-ink-faint hover:text-ink">
              <X size={15} />
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between text-[13px] text-ink-muted">
            <span>{pct}% Full</span>
            <span className="tabular-nums">
              ~{fmtTokens(total)} / {fmtTokens(contextWindow)} Tokens
            </span>
          </div>

          <div className="mt-2 flex h-2 w-full gap-px overflow-hidden rounded-full bg-white/[0.08]">
            {rows.map((seg) => {
              const value = counts[seg.key] ?? 0
              if (value <= 0) return null
              return (
                <div
                  key={seg.key}
                  style={{
                    width: `${(value / contextWindow) * 100}%`,
                    minWidth: 3,
                    background: seg.color
                  }}
                />
              )
            })}
          </div>

          <div className="mt-3">
            {rows.map((seg) => (
              <div key={seg.key} className="flex items-center justify-between py-[5px]">
                <span className="flex items-center gap-2.5 text-[13px] text-ink">
                  <span
                    className="h-2.5 w-2.5 rounded-[3px]"
                    style={{ background: seg.color }}
                  />
                  {seg.label}
                </span>
                <span className="text-[13px] tabular-nums text-ink-muted">
                  {fmtTokens(counts[seg.key] ?? 0)}
                </span>
              </div>
            ))}
          </div>

          <div className="my-3 h-px bg-line" />

          <div className="flex items-center justify-between text-[13px]">
            <span className="text-ink">Session tokens</span>
            <span className="tabular-nums text-ink-muted">
              {fmtTokens(sessionUsage?.inputTokens ?? 0)} in /{' '}
              {fmtTokens(sessionUsage?.outputTokens ?? 0)} out
            </span>
          </div>

          {isApiKey ? (
            <>
              <div className="mt-1.5 flex items-center justify-between text-[13px]">
                <span className="text-ink">Cost used (est.)</span>
                <span className="tabular-nums font-medium text-ink">
                  {fmtUsd(sessionUsage?.costUsd ?? 0)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-xs text-ink-faint">
                <span>All time</span>
                <span className="tabular-nums">
                  {fmtUsd(lifetimeUsage?.costUsd ?? 0)} ·{' '}
                  {fmtTokens((lifetimeUsage?.inputTokens ?? 0) + (lifetimeUsage?.outputTokens ?? 0))}{' '}
                  tokens
                </span>
              </div>
            </>
          ) : (
            <p className="mt-1.5 text-xs text-ink-faint">
              Usage is covered by your SuperGrok subscription — no per-token cost.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
