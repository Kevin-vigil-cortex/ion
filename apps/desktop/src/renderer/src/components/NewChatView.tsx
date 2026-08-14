import { LogIn } from 'lucide-react'
import { useState } from 'react'
import Composer from './Composer'
import ChatToolbar from './ChatToolbar'
import { useStore } from '../store'

export default function NewChatView(): React.JSX.Element {
  const config = useStore((s) => s.config)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setAuthMode = useStore((s) => s.setAuthMode)
  const startOAuth = useStore((s) => s.startOAuth)
  const oauthProgress = useStore((s) => s.oauthProgress)
  const [oauthBusy, setOAuthBusy] = useState(false)
  const [oauthError, setOAuthError] = useState<string | null>(null)

  const signedIn = Boolean(config?.oauth.signedIn)
  const hasKey = Boolean(config?.hasApiKey)
  const configured = Boolean(config && (hasKey || signedIn))

  return (
    <div className="flex h-full flex-col">
      <ChatToolbar />
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="w-full max-w-[640px]">
          <h1 className="mb-5 text-center text-lg font-medium text-ink">
            What should we build today?
          </h1>
          <Composer variant="center" />

          {!configured && (
            <div className="mt-5 flex flex-col items-center gap-3">
              <button
                disabled={oauthBusy}
                onClick={() => {
                  setOAuthBusy(true)
                  setOAuthError(null)
                  void (config?.authMode === 'oauth' ? Promise.resolve() : setAuthMode('oauth'))
                    .then(() => startOAuth())
                    .catch((e: unknown) =>
                      setOAuthError(e instanceof Error ? e.message : String(e))
                    )
                    .finally(() => setOAuthBusy(false))
                }}
                className="flex items-center gap-2 rounded-lg bg-ink px-3.5 py-2.5 text-sm font-medium text-app hover:opacity-90 disabled:opacity-50"
              >
                <LogIn size={15} />
                {oauthBusy ? 'Waiting for browser…' : 'Sign in with SuperGrok'}
              </button>
              {oauthProgress?.stage === 'awaiting_authorization' && oauthProgress.userCode && (
                <div className="font-mono text-sm tracking-widest text-ink">{oauthProgress.userCode}</div>
              )}
              {oauthError && <div className="text-xs text-red-300">{oauthError}</div>}
              <button
                onClick={() => setSettingsOpen(true)}
                className="text-xs text-ink-faint underline underline-offset-2 hover:text-ink-muted"
              >
                Or use an xAI API key
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
