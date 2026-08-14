import type { Tool, ToolResult } from './types'
import type { MemoryStore, MemoryScope } from '../learning'

const SUMMARY_MAX = 60

/**
 * The write side of the self-learning loop: lets the model persist a durable
 * learning that will be injected into every future session's system prompt.
 * Approval-gated: whatever is saved here rides in the system prompt of ALL
 * future chats, so a page or file the agent read mid-turn must not be able to
 * plant persistent instructions silently (indirect prompt injection). Works
 * with no workspace open (global scope).
 */
export function createSaveMemoryTool(store: MemoryStore): Tool {
  return {
    name: 'save_memory',
    description:
      'Save a durable learning to persistent memory so all future sessions benefit. ' +
      'Use for user preferences and corrections, project facts, and gotchas. ' +
      'Never save secrets, credentials, or trivial details. ' +
      'Scope "global" applies everywhere; "workspace" applies only to the current workspace.',
    dangerous: true,
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'workspace'],
          description: '"global" for cross-project learnings, "workspace" for this project only.'
        },
        content: {
          type: 'string',
          description: 'One concise learning (a sentence or two).'
        }
      },
      required: ['scope', 'content'],
      additionalProperties: false
    },
    summarize: (args) => {
      const text = String(args.content ?? '').replace(/\s+/g, ' ').trim()
      return `Remember: ${text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX).trimEnd() + '…' : text}`
    },
    async execute(args, ctx): Promise<ToolResult> {
      const scope = args.scope
      if (scope !== 'global' && scope !== 'workspace') {
        return { output: 'scope must be "global" or "workspace".', isError: true }
      }
      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (!content) {
        return { output: 'content must be a non-empty string.', isError: true }
      }
      if (scope === 'workspace' && !ctx.workspaceRoot) {
        return {
          output: 'No workspace folder is open; save this learning with scope "global" instead.',
          isError: true
        }
      }
      await store.append(scope as MemoryScope, content, ctx.workspaceRoot || null)
      return { output: `Saved to ${scope} memory. It will be available in future sessions.` }
    }
  }
}
