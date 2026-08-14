import type { JsonSchema, ToolResultImage } from '../types'

/** Runtime context handed to every tool on execution. */
export interface ToolContext {
  /**
   * Absolute path all file/terminal operations are confined to. Only tools
   * with `requiresWorkspace: false` ever run without one; they receive `''`.
   */
  workspaceRoot: string
  /** Aborted when the user stops the turn. */
  signal: AbortSignal
}

export interface ToolResult {
  /** Text fed back to the model. */
  output: string
  isError?: boolean
  /**
   * Optional images (e.g. screenshots) shown to vision-capable models
   * alongside the text output. Kept in memory only; never persisted.
   */
  images?: ToolResultImage[]
  /**
   * Optional structured payload surfaced to the UI (e.g. a diff, file list).
   * Never sent to the model.
   */
  meta?: Record<string, unknown>
}

/**
 * A tool the agent can execute on the model's behalf.
 *
 * `dangerous` tools (writes, terminal) are gated behind user approval; read-only
 * tools run automatically.
 */
export interface Tool {
  name: string
  description: string
  parameters: JsonSchema
  /** Whether an execution of this tool requires explicit user approval. */
  dangerous: boolean
  /**
   * Whether the tool needs an open workspace folder (default true). Tools that
   * set this to false (e.g. `save_memory`) are offered even with no workspace.
   */
  requiresWorkspace?: boolean
  /**
   * Produce a short, human-readable summary of what a call will do, shown in
   * the approval prompt and the tool card (e.g. `write src/index.ts`).
   */
  summarize(args: Record<string, unknown>): string
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}
