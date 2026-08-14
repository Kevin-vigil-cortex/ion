import { useLayoutEffect, useRef } from 'react'
import Composer from './Composer'
import ChatToolbar from './ChatToolbar'
import Message from './Message'
import ToolGroup from './ToolGroup'
import BrowserPanel from './BrowserPanel'
import ToolDetailPanel from './ToolDetailPanel'
import ChangeReview from './ChangeReview'
import { useStore, type UiItem, type UiMessage, type UiError, type UiTool, type UiChanges } from '../store'

/** Collapse runs of consecutive tool calls into one block per run. */
function groupThread(thread: UiItem[]): (UiMessage | UiError | UiChanges | UiTool[])[] {
  const blocks: (UiMessage | UiError | UiChanges | UiTool[])[] = []
  for (const item of thread) {
    const last = blocks[blocks.length - 1]
    if (item.kind === 'tool' && Array.isArray(last)) last.push(item)
    else if (item.kind === 'tool') blocks.push([item])
    else blocks.push(item)
  }
  return blocks
}

export default function ChatView(): React.JSX.Element {
  const thread = useStore((s) => s.thread)
  const status = useStore((s) => s.status)
  const liveId = useStore((s) => s.openAssistantId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinRef = useRef(true)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinRef.current) el.scrollTop = el.scrollHeight
  }, [thread, status])

  const statusLabel: Record<string, string> = {
    thinking: 'Thinking',
    streaming: 'Responding',
    running_tool: 'Running tool',
    awaiting_approval: 'Waiting for approval'
  }

  const last = thread[thread.length - 1]
  const liveThinking =
    last?.kind === 'message' &&
    last.role === 'assistant' &&
    !last.content.trim() &&
    last.reasoningMs === undefined

  return (
    <div className="flex h-full">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <ChatToolbar showBrowser />

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto overscroll-contain"
          onScroll={() => {
            const el = scrollRef.current
            if (!el) return
            pinRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96
          }}
        >
          <div className="mx-auto flex max-w-[720px] flex-col gap-3 px-6 py-6">
            {groupThread(thread).map((block, i, blocks) => {
              if (Array.isArray(block)) return <ToolGroup key={block[0]!.id} tools={block} />
              if (block.kind === 'changes') return <ChangeReview key={block.id} card={block} />
              if (block.kind === 'message')
                return (
                  <Message
                    key={block.id}
                    message={block}
                    precedesTools={Array.isArray(blocks[i + 1])}
                    live={block.id === liveId}
                  />
                )
              return (
                <div
                  key={block.id}
                  className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                >
                  {block.message}
                </div>
              )
            })}

            {((status === 'thinking' && !liveThinking) || status === 'running_tool') && (
              <div className="flex items-center gap-2 text-xs text-ink-faint">
                <span className="inline-flex gap-1">
                  <span className="dot">.</span>
                  <span className="dot">.</span>
                  <span className="dot">.</span>
                </span>
                {statusLabel[status]}
              </div>
            )}
          </div>
        </div>

        <div className="px-6 pb-5">
          <div className="mx-auto max-w-[720px]">
            <Composer variant="bottom" />
          </div>
        </div>
      </div>

      <ToolDetailPanel />
      <BrowserPanel />
    </div>
  )
}
