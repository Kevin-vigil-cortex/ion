import { useState } from 'react'
import {
  X,
  KeyRound,
  LogIn,
  ShieldCheck,
  AlertTriangle,
  Server,
  BrainCircuit,
  GraduationCap,
  Globe,
  MonitorDot,
  Check,
  Plug
} from 'lucide-react'
import { useStore } from '../store'
import type { ApprovalMode } from '../../../shared/ipc'

export default function SettingsModal(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const config = useStore((s) => s.config)
  const setApiKey = useStore((s) => s.setApiKey)
  const clearApiKey = useStore((s) => s.clearApiKey)
  const setAuthMode = useStore((s) => s.setAuthMode)
  const setApprovalMode = useStore((s) => s.setApprovalMode)
  const setMemoryEnabled = useStore((s) => s.setMemoryEnabled)
  const setLearningEnabled = useStore((s) => s.setLearningEnabled)
  const setBrowserUseEnabled = useStore((s) => s.setBrowserUseEnabled)
  const setComputerUseEnabled = useStore((s) => s.setComputerUseEnabled)
  const startOAuth = useStore((s) => s.startOAuth)
  const signOut = useStore((s) => s.signOut)
  const toggleProxy = useStore((s) => s.toggleProxy)
  const oauthProgress = useStore((s) => s.oauthProgress)
  const setUserRules = useStore((s) => s.setUserRules)
  const mcpServers = useStore((s) => s.mcpServers)
  const reloadMcp = useStore((s) => s.reloadMcp)
  const setMcpTrust = useStore((s) => s.setMcpTrust)

  const [keyInput, setKeyInput] = useState('')
  const [mcpBusy, setMcpBusy] = useState(false)
  const [oauthBusy, setOAuthBusy] = useState(false)
  const [oauthError, setOAuthError] = useState<string | null>(null)
  const [rulesDraft, setRulesDraft] = useState<string | null>(null)
  const [rulesSaved, setRulesSaved] = useState(false)

  if (!open || !config) return null

  const mode = config.authMode

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink">Settings</h2>
          <button onClick={() => setOpen(false)} className="text-ink-faint hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto px-5 py-5">
          {/* Auth mode */}
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
              Authentication
            </div>
            <div className="mb-4 inline-flex rounded-lg border border-line bg-card p-0.5">
              <button
                onClick={() => void setAuthMode('api_key')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  mode === 'api_key' ? 'bg-white/[0.08] text-ink' : 'text-ink-muted'
                }`}
              >
                API key
              </button>
              <button
                onClick={() => void setAuthMode('oauth')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  mode === 'oauth' ? 'bg-white/[0.08] text-ink' : 'text-ink-muted'
                }`}
              >
                SuperGrok OAuth
              </button>
            </div>

            {mode === 'api_key' ? (
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  <KeyRound size={14} /> xAI API key
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder={config.hasApiKey ? '•••••••••• (saved)' : 'xai-...'}
                    className="flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => {
                      if (keyInput.trim()) {
                        void setApiKey(keyInput.trim())
                        setKeyInput('')
                      }
                    }}
                    className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-app hover:opacity-90"
                  >
                    Save
                  </button>
                  {config.hasApiKey && (
                    <button
                      onClick={() => void clearApiKey()}
                      className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-white/5"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="text-xs text-ink-faint">
                  Pay-per-token billing. Stored locally at ~/.ion/config.json. Create a key
                  at console.x.ai.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {config.oauth.signedIn ? (
                  <div className="flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2.5 text-sm">
                    <ShieldCheck size={16} className="text-emerald-400" />
                    <span className="flex-1 text-ink">
                      Signed in{config.oauth.account ? ` as ${config.oauth.account}` : ''}
                    </span>
                    <button
                      onClick={() => void signOut()}
                      className="text-xs text-ink-muted underline underline-offset-2 hover:text-ink"
                    >
                      Sign out
                    </button>
                  </div>
                ) : (
                  <button
                    disabled={oauthBusy}
                    onClick={() => {
                      setOAuthBusy(true)
                      setOAuthError(null)
                      startOAuth()
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
                )}
                {!config.oauth.signedIn &&
                  oauthProgress &&
                  oauthProgress.stage === 'awaiting_authorization' && (
                    <div className="space-y-2 rounded-lg border border-line bg-card px-3 py-2.5 text-xs">
                      <div className="text-ink-muted">
                        A browser window opened. Enter this code to approve:
                      </div>
                      {oauthProgress.userCode && (
                        <div className="text-center font-mono text-lg tracking-widest text-ink">
                          {oauthProgress.userCode}
                        </div>
                      )}
                      {oauthProgress.verificationUri && (
                        <div className="break-all text-center text-ink-faint">
                          {oauthProgress.verificationUri}
                        </div>
                      )}
                    </div>
                  )}
                {config.oauth.tierGated && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <span>
                      xAI returned 403 for this account. OAuth API access may be gated for your tier
                      — switch to an API key if inference keeps failing.
                    </span>
                  </div>
                )}
                {oauthError && (
                  <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {oauthError}
                  </div>
                )}
                <p className="text-xs text-ink-faint">
                  Uses your SuperGrok / X Premium+ subscription. Tokens are stored locally at
                  ~/.ion/auth.json and refreshed automatically.
                </p>
              </div>
            )}
          </section>

          {/* User rules */}
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
              User rules
            </div>
            <textarea
              value={rulesDraft ?? config.userRules ?? ''}
              onChange={(e) => {
                setRulesDraft(e.target.value)
                setRulesSaved(false)
              }}
              rows={5}
              placeholder="Always-on personal rules. Injected into every chat."
              className="w-full resize-y rounded-lg border border-line bg-card px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent"
            />
            <div className="mt-2 flex items-center justify-between">
              <p className="text-xs text-ink-faint">Stored at ~/.ion/user-rules.md</p>
              <button
                onClick={() => {
                  void setUserRules(rulesDraft ?? config.userRules ?? '').then(() => {
                    setRulesSaved(true)
                    window.setTimeout(() => setRulesSaved(false), 1500)
                  })
                }}
                className="rounded-md bg-white/[0.08] px-2.5 py-1 text-xs text-ink hover:bg-white/10"
              >
                {rulesSaved ? 'Saved' : 'Save rules'}
              </button>
            </div>
          </section>

          {/* Permissions */}
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
              Permissions
            </div>
            <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
              {(
                [
                  {
                    id: 'ask',
                    label: 'Ask for approval',
                    desc: 'Always ask before file edits, terminal commands, memory saves, and computer use.'
                  },
                  {
                    id: 'auto',
                    label: 'Approve for me',
                    desc: 'File edits in the workspace run without asking. Terminal, MCP, computer use, and memory saves still ask.'
                  },
                  {
                    id: 'full',
                    label: 'Full access',
                    desc: 'Never asks. The agent can edit files, run commands, and control the computer unprompted.',
                    danger: true
                  }
                ] satisfies { id: ApprovalMode; label: string; desc: string; danger?: boolean }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => void setApprovalMode(opt.id)}
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-white/[0.04]"
                >
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-sm font-medium ${opt.danger ? 'text-red-400' : 'text-ink'}`}
                    >
                      {opt.label}
                    </div>
                    <div className={`text-xs ${opt.danger ? 'text-red-400/80' : 'text-ink-faint'}`}>
                      {opt.desc}
                    </div>
                  </div>
                  {config.approvalMode === opt.id && (
                    <Check size={15} className="mt-0.5 shrink-0 text-accent" />
                  )}
                </button>
              ))}
            </div>
          </section>

          {/* Behavior */}
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
              Behavior
            </div>
            <label className="flex items-center justify-between rounded-lg border border-line bg-card px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm text-ink">
                <BrainCircuit size={15} className="text-ink-muted" />
                Chat memory (context)
              </span>
              <input
                type="checkbox"
                checked={config.memoryEnabled}
                onChange={(e) => void setMemoryEnabled(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
            </label>
            <p className="mt-1 text-xs text-ink-faint">
              When off, the model only sees your latest message — earlier turns in the chat are
              not sent. Your visible chat history is kept either way.
            </p>

            <label className="mt-3 flex items-center justify-between rounded-lg border border-line bg-card px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm text-ink">
                <GraduationCap size={15} className="text-ink-muted" />
                Self-learning (memories)
              </span>
              <input
                type="checkbox"
                checked={config.learningEnabled}
                onChange={(e) => void setLearningEnabled(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
            </label>
            <p className="mt-1 text-xs text-ink-faint">
              Unlike chat memory above, this persists across sessions: the agent saves durable
              learnings to ~/.ion/memory and recalls them in every future chat.
            </p>
          </section>

          {/* MCP */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">MCP</div>
              <button
                onClick={() => {
                  setMcpBusy(true)
                  void reloadMcp().finally(() => setMcpBusy(false))
                }}
                disabled={mcpBusy}
                className="rounded-md bg-white/[0.08] px-2.5 py-1 text-xs text-ink hover:bg-white/10 disabled:opacity-50"
              >
                {mcpBusy ? 'Connecting…' : 'Reload'}
              </button>
            </div>
            {mcpServers.length === 0 ? (
              <p className="text-xs text-ink-faint">
                No servers yet. Add a Cursor-style mcp.json at ~/.ion/mcp.json, ~/.cursor/mcp.json,
                or .cursor/mcp.json in the project.
              </p>
            ) : (
              <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
                {mcpServers.map((s) => (
                  <div key={`${s.source}:${s.name}`} className="flex items-start gap-2 px-3 py-2">
                    <Plug size={14} className="mt-0.5 shrink-0 text-ink-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm text-ink">
                        <span className="truncate font-medium">{s.name}</span>
                        <span className="text-[10px] uppercase text-ink-faint">{s.source}</span>
                        <span className="text-[10px] uppercase text-ink-faint">{s.transport}</span>
                      </div>
                      <div className="text-xs text-ink-faint">
                        {s.status === 'connected'
                          ? `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}`
                          : s.status === 'idle'
                            ? 'Not started — send a message or Reload'
                            : s.status === 'skipped'
                              ? 'Disabled'
                              : s.status === 'blocked'
                                ? 'Blocked — workspace not trusted'
                                : s.error || 'Failed'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {mcpServers.some((s) => s.status === 'blocked') && (
              <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2">
                <p className="text-xs text-ink-faint">
                  This project's mcp.json defines servers. They stay off until you trust this
                  workspace to run them.
                </p>
                <button
                  onClick={() => {
                    setMcpBusy(true)
                    void setMcpTrust(true).finally(() => setMcpBusy(false))
                  }}
                  disabled={mcpBusy}
                  className="shrink-0 rounded-md bg-white/[0.08] px-2.5 py-1 text-xs text-ink hover:bg-white/10 disabled:opacity-50"
                >
                  Trust workspace
                </button>
              </div>
            )}
            <p className="mt-1 text-xs text-ink-faint">
              Same approval as the terminal. autoApprove in mcp.json skips the prompt for those
              tools.
            </p>
          </section>

          {/* Agent abilities */}
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
              Agent abilities
            </div>
            <label className="flex items-center justify-between rounded-lg border border-line bg-card px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm text-ink">
                <Globe size={15} className="text-ink-muted" />
                Browser use (embedded panel)
              </span>
              <input
                type="checkbox"
                checked={config.browserUseEnabled}
                onChange={(e) => void setBrowserUseEnabled(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
            </label>
            <p className="mt-1 text-xs text-ink-faint">
              Lets the agent browse the web in a sandboxed panel inside the app, with a visible
              cursor so you can watch. It never touches your real browser.
            </p>

            <label className="mt-3 flex items-center justify-between rounded-lg border border-line bg-card px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm text-ink">
                <MonitorDot size={15} className="text-ink-muted" />
                Computer use (mouse, keyboard, screen)
              </span>
              <input
                type="checkbox"
                checked={config.computerUseEnabled}
                onChange={(e) => void setComputerUseEnabled(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
            </label>
            <p className="mt-1 text-xs text-ink-faint">
              Off by default. Lets the agent control your Mac — every action asks for approval
              unless Permissions is set to Full access. Requires macOS permissions under System Settings &gt;
              Privacy &amp; Security: Screen Recording (screenshots) and Accessibility
              (mouse/keyboard).
            </p>
          </section>

          {/* Proxy */}
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
              Local proxy (optional)
            </div>
            <label className="flex items-center justify-between rounded-lg border border-line bg-card px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm text-ink">
                <Server size={15} className="text-ink-muted" />
                OpenAI-compatible proxy
              </span>
              <input
                type="checkbox"
                checked={config.proxy.enabled}
                onChange={(e) => void toggleProxy(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
            </label>
            <p className="mt-1 text-xs text-ink-faint">
              {config.proxy.enabled
                ? `Running at http://127.0.0.1:${config.proxy.port} — point any OpenAI client here to use your credentials.`
                : `Exposes http://127.0.0.1:${config.proxy.port} so other tools can borrow your auth. Off by default.`}
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
