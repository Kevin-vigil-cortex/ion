import { useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { useStore } from '../store'

/** Bottom-right pill shown once an update has downloaded and is ready to apply. */
export default function UpdateToast(): React.JSX.Element | null {
  const status = useStore((s) => s.updateStatus)
  const installUpdate = useStore((s) => s.installUpdate)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  if (!status || status.state !== 'downloaded') return null
  if (dismissedVersion === (status.version ?? '')) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-2xl">
      <div>
        <div className="text-sm font-medium text-ink">
          Update ready{status.version ? ` — v${status.version}` : ''}
        </div>
        <div className="text-xs text-ink-faint">Restart Ion to apply it.</div>
      </div>
      <button
        onClick={() => void installUpdate()}
        className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-app hover:opacity-90"
      >
        <RefreshCw size={13} />
        Restart
      </button>
      <button
        onClick={() => setDismissedVersion(status.version ?? '')}
        className="text-ink-faint hover:text-ink"
        aria-label="Dismiss"
      >
        <X size={15} />
      </button>
    </div>
  )
}
