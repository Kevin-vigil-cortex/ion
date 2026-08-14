import { Globe } from 'lucide-react'
import { useStore } from '../store'

/** Drag strip + optional agent-browser toggle. Fast/Steer live in the composer. */
export default function ChatToolbar({
  showBrowser = false
}: {
  showBrowser?: boolean
}): React.JSX.Element {
  const browserPanelOpen = useStore((s) => s.browserPanelOpen)
  const setBrowserPanelOpen = useStore((s) => s.setBrowserPanelOpen)

  return (
    <div className="drag flex h-11 shrink-0 items-center justify-end px-3">
      {showBrowser ? (
        <button
          onClick={() => setBrowserPanelOpen(!browserPanelOpen)}
          title={browserPanelOpen ? 'Hide agent browser' : 'Show agent browser'}
          className={`no-drag rounded-md p-1.5 hover:bg-white/5 ${
            browserPanelOpen ? 'text-accent' : 'text-ink-faint hover:text-ink'
          }`}
        >
          <Globe size={15} />
        </button>
      ) : null}
    </div>
  )
}
