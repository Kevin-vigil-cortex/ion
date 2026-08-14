import {
  Plus,
  Search,
  Settings2,
  MessageSquare,
  Trash2,
  Folder,
  SquareKanban,
  GraduationCap
} from 'lucide-react'
import { useStore } from '../store'
import { useMemo, useState } from 'react'
import ionIcon from '../assets/ion-icon.png'

export default function Sidebar(): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const currentSessionId = useStore((s) => s.currentSessionId)
  const config = useStore((s) => s.config)
  const view = useStore((s) => s.view)
  const newChat = useStore((s) => s.newChat)
  const openSession = useStore((s) => s.openSession)
  const deleteSession = useStore((s) => s.deleteSession)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setView = useStore((s) => s.setView)

  const [query, setQuery] = useState('')

  const filtered = useMemo(
    () => sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase())),
    [sessions, query]
  )

  return (
    <aside className="flex h-full w-[248px] flex-col border-r border-white/10 bg-[#17181c]/80 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),16px_0_48px_-16px_rgba(0,0,0,0.7)]">
      <div className="drag h-11 shrink-0" />

      <div className="no-drag px-3">
        <button
          onClick={newChat}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-white hover:bg-white/5"
        >
          <Plus size={16} className="text-white/90" />
          New Chat
        </button>

        <div className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-white/90 hover:bg-white/5">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full bg-transparent text-sm text-white outline-none placeholder:text-white/60"
          />
        </div>

        <button
          onClick={() => setView('board')}
          className={`mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
            view === 'board'
              ? 'bg-white/[0.08] font-medium text-white'
              : 'text-white/90 hover:bg-white/5 hover:text-white'
          }`}
        >
          <SquareKanban size={16} />
          Board
        </button>

        <button
          onClick={() => setView('memories')}
          className={`mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
            view === 'memories'
              ? 'bg-white/[0.08] font-medium text-white'
              : 'text-white/90 hover:bg-white/5 hover:text-white'
          }`}
        >
          <GraduationCap size={16} />
          Memories
        </button>

        <button
          onClick={() => setSettingsOpen(true)}
          className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-white/90 hover:bg-white/5 hover:text-white"
        >
          <Settings2 size={16} />
          Customize
        </button>
      </div>

      <div className="mt-4 px-4 text-[11px] font-medium uppercase tracking-wide text-white/60">
        Chats
      </div>

      <div className="no-drag mt-1 flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-white/60">No chats yet</div>
        ) : (
          filtered.map((s) => (
            <div
              key={s.id}
              onClick={() => openSession(s.id)}
              className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
                s.id === currentSessionId && view === 'chat'
                  ? 'bg-white/[0.08] text-white'
                  : 'text-white/85 hover:bg-white/5 hover:text-white'
              }`}
            >
              <MessageSquare size={15} className="shrink-0 text-white/60" />
              <span className="flex-1 truncate">{s.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void deleteSession(s.id)
                }}
                className="opacity-0 transition group-hover:opacity-100"
                title="Delete chat"
              >
                <Trash2 size={14} className="text-white/60 hover:text-white" />
              </button>
            </div>
          ))
        )}
      </div>

      <button
        onClick={() => setSettingsOpen(true)}
        className="no-drag m-2 flex items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-white/5"
      >
        <img src={ionIcon} alt="Ion" className="h-7 w-7 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-white">Ion</div>
          <div className="flex items-center gap-1 truncate text-xs text-white/60">
            {config?.authMode === 'oauth' ? (
              config.oauth.signedIn ? (
                <span>SuperGrok</span>
              ) : (
                <span>OAuth · signed out</span>
              )
            ) : config?.hasApiKey ? (
              <span>API key</span>
            ) : (
              <span>Not configured</span>
            )}
          </div>
        </div>
        {config?.proxy.enabled && (
          <span title="Proxy running">
            <Folder size={14} className="text-accent" />
          </span>
        )}
      </button>
    </aside>
  )
}
