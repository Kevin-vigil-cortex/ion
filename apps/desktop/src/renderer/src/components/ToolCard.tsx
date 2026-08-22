import { memo } from 'react'
import { Check, X, Loader2, AlertTriangle } from 'lucide-react'
import type { UiTool } from '../store'
import { useStore } from '../store'
import { iconFor, objectFor, parseArgs, verbFor } from '../tool-display'

/**
 * One tool invocation: a slim borderless line. Click opens the inspector
 * column - never expands in the thread (that shoved the chat around).
 */
function ToolCard({ tool }: { tool: UiTool }): React.JSX.Element {
  const selected = useStore((s) => s.selectedToolId === tool.id)
  const selectTool = useStore((s) => s.selectTool)
  const approve = useStore((s) => s.approve)

  const running = tool.status === 'running'
  const failed = tool.status === 'error' || tool.isError
  const verb = verbFor(tool.name, running, tool.summary)
  const object = objectFor(tool.name, parseArgs(tool.args))

  return (
    <div>
      <button
        onClick={() => selectTool(selected ? null : tool.id)}
        className="group flex w-full items-center gap-2 py-1 text-left"
      >
        <span className={`shrink-0 ${selected ? 'text-ink' : 'text-ink-faint'}`}>
          {iconFor(tool.name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className={selected ? 'text-ink-muted' : 'text-ink-faint'}>{verb}</span>
          {object && (
            <span className={`font-mono ${selected ? 'text-ink' : 'text-ink-muted'}`}>
              &nbsp;{object}
            </span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {running && <Loader2 size={13} className="animate-spin text-ink-faint" />}
          {tool.status === 'awaiting' && (
            <span className="text-[11px] font-medium text-accent">needs approval</span>
          )}
          {failed && <AlertTriangle size={13} className="text-red-400" />}
        </span>
      </button>

      {tool.status === 'awaiting' && (
        <div className="mb-1 mt-0.5 flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2">
          <span className="flex-1 text-xs text-ink-muted">
            Allow this {tool.name.replace(/_/g, ' ')}?
          </span>
          <button
            onClick={() => void approve(tool.callId, 'deny')}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-white/5"
          >
            <X size={12} /> Deny
          </button>
          <button
            onClick={() => void approve(tool.callId, 'approve_always')}
            className="rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-white/5"
          >
            Always
          </button>
          <button
            onClick={() => void approve(tool.callId, 'approve')}
            className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-app hover:opacity-90"
          >
            <Check size={12} /> Approve
          </button>
        </div>
      )}
    </div>
  )
}

export default memo(ToolCard)
