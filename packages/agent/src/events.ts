/** High-level status of an agent turn, surfaced to the UI. */
export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'awaiting_approval'
  | 'running_tool'
  | 'error'
  | 'done'

/**
 * Structured events emitted during a turn. The desktop app forwards these over
 * IPC to drive the chat UI.
 */
export type AgentEvent =
  | { type: 'status'; status: AgentStatus }
  | { type: 'assistant_text_delta'; text: string }
  | { type: 'assistant_reasoning_delta'; text: string }
  | { type: 'assistant_message'; content: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string; summary: string }
  | { type: 'tool_approval_request'; callId: string; name: string; arguments: string; summary: string }
  | { type: 'tool_result'; callId: string; output: string; isError: boolean; meta?: Record<string, unknown> }
  | {
      /** Estimated composition of the model input built for this iteration. */
      type: 'context_stats'
      systemPromptTokens: number
      toolDefTokens: number
      /** Present only when a learned-memory prompt section exists. */
      memoryTokens?: number
      conversationTokens: number
      totalTokens: number
    }
  | {
      /** Real token usage reported by the provider for one model call. */
      type: 'usage'
      inputTokens: number
      outputTokens: number
      costUsd?: number
      /** Cumulative totals persisted on the session. */
      sessionInputTokens: number
      sessionOutputTokens: number
      sessionCostUsd?: number
    }
  | {
      /** The agent opened a folder as the session workspace (open_workspace). */
      type: 'workspace_changed'
      workspaceRoot: string
    }
  | {
      /** Files the agent changed this turn - drives the review card. */
      type: 'turn_changes'
      checkpointId: string
      files: Array<{
        path: string
        created: boolean
        skipped?: boolean
        additions: number
        deletions: number
        diff: string
      }>
    }
  | { type: 'checkpoint_restored'; checkpointId: string; paths: string[] }
  | { type: 'error'; message: string }
  | { type: 'done' }

export type AgentEventHandler = (event: AgentEvent) => void
