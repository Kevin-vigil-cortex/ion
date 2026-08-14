import { X, Loader2, AlertTriangle } from 'lucide-react'
import { useStore, type UiTool } from '../store'
import { iconFor, objectFor, parseArgs, verbFor } from '../tool-display'

export default function ToolDetailPanel(): React.JSX.Element | null {
  const selectedId = useStore((s) => s.selectedToolId)
  const selectTool = useStore((s) => s.selectTool)
  const tool = useStore((s) => {
    if (!s.selectedToolId) return null
    const item = s.thread.find((it) => it.kind === 'tool' && it.id === s.selectedToolId)
    return item && item.kind === 'tool' ? item : null
  })

  if (!selectedId) return null

  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-white/10 bg-black/25 backdrop-blur-lg">
      <div className="drag flex h-11 shrink-0 items-center justify-between border-b border-white/10 px-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          Tool
        </span>
        <button
          onClick={() => selectTool(null)}
          className="no-drag rounded-md p-1 text-ink-faint hover:bg-white/5 hover:text-ink"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
      {tool ? <ToolBody tool={tool} /> : (
        <div className="px-3 py-4 text-xs text-ink-faint">This tool is no longer in the thread.</div>
      )}
    </aside>
  )
}

function ToolBody({ tool }: { tool: UiTool }): React.JSX.Element {
  const running = tool.status === 'running'
  const failed = tool.status === 'error' || tool.isError
  const verb = verbFor(tool.name, running, tool.summary)
  const object = objectFor(tool.name, parseArgs(tool.args))
  const status =
    tool.status === 'awaiting'
      ? 'Needs approval'
      : running
        ? 'Running'
        : failed
          ? 'Failed'
          : 'Done'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-white/10 px-3 py-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 text-ink-muted">{iconFor(tool.name)}</span>
          <div className="min-w-0 flex-1">
            <div className="text-sm text-ink">{verb}</div>
            {object && (
              <div className="mt-0.5 break-all font-mono text-xs text-ink-muted">{object}</div>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-faint">
          {running && <Loader2 size={11} className="animate-spin" />}
          {failed && <AlertTriangle size={11} className="text-red-400" />}
          <span className={failed ? 'text-red-300' : ''}>{status}</span>
          <span className="text-ink-faint/70">· {tool.name}</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {tool.args && tool.args !== '{}' && (
          <section>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              Input
            </div>
            <pre className="selectable overflow-x-auto whitespace-pre-wrap rounded-md border border-white/10 bg-black/30 p-2 text-[11px] text-ink-muted">
              {prettyJson(tool.args)}
            </pre>
          </section>
        )}
        <section className="min-h-0 flex-1">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
            Output
          </div>
          {tool.output ? (
            <pre className="selectable whitespace-pre-wrap rounded-md border border-white/10 bg-black/30 p-2 text-[11px] text-ink">
              {tool.output}
            </pre>
          ) : (
            <div className="text-xs text-ink-faint">
              {running ? 'Waiting for output…' : 'No output'}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
