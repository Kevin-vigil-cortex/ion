import { useEffect } from 'react'
import { useStore } from './store'
import Sidebar from './components/Sidebar'
import NewChatView from './components/NewChatView'
import ChatView from './components/ChatView'
import BoardView from './components/BoardView'
import MemoriesView from './components/MemoriesView'
import SettingsModal from './components/SettingsModal'
import UpdateToast from './components/UpdateToast'
import WorkspaceExplorer from './components/WorkspaceExplorer'
import VideoBackground from './components/VideoBackground'
import AttachmentDropTarget from './components/AttachmentDropTarget'

export default function App(): React.JSX.Element {
  const initialize = useStore((s) => s.initialize)
  const currentSessionId = useStore((s) => s.currentSessionId)
  const view = useStore((s) => s.view)
  const draftWorkspace = useStore((s) => s.draftWorkspace)

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey
      const t = e.target
      const typing =
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (meta && e.key === 'n') {
        e.preventDefault()
        useStore.getState().newChat()
        return
      }
      if (meta && (e.key === 'l' || e.key === 'k')) {
        e.preventDefault()
        window.dispatchEvent(new Event('ion:focus-composer'))
        return
      }
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        useStore.getState().cycleMode()
        return
      }
      if (meta && e.key === '/') {
        e.preventDefault()
        useStore.getState().cycleModel()
        return
      }
      if (meta && e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault()
        void useStore.getState().abort()
        return
      }
      if (e.key === 'Escape') {
        const s = useStore.getState()
        if (s.selectedToolId) {
          s.selectTool(null)
          return
        }
        if (s.settingsOpen) {
          s.setSettingsOpen(false)
          return
        }
        if (!typing) window.dispatchEvent(new Event('ion:focus-composer'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-transparent text-ink">
      <Sidebar />
      <main className="relative isolate flex min-w-0 flex-1 overflow-hidden">
        <VideoBackground />
        {view === 'chat' && draftWorkspace && <WorkspaceExplorer />}
        <div className="min-w-0 flex-1">
          {view === 'board' ? (
            <BoardView />
          ) : view === 'memories' ? (
            <MemoriesView />
          ) : (
            <AttachmentDropTarget>
              {currentSessionId ? <ChatView /> : <NewChatView />}
            </AttachmentDropTarget>
          )}
        </div>
      </main>
      <SettingsModal />
      <UpdateToast />
    </div>
  )
}
