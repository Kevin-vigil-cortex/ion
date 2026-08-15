import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool, ToolResult } from './types'
import { resolveUserPath } from './shell-env'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 32 * 1024
const TIMEOUT_MS = 180_000
const TYPES = new Set(['all', 'committed', 'uncommitted'])

const MISSING_CLI =
  'CodeRabbit CLI is not installed (coderabbit not on PATH). ' +
  'Install it from https://docs.coderabbit.ai/cli and run `coderabbit auth login`.'

export type CodeReviewType = 'all' | 'committed' | 'uncommitted'

export interface CodeReviewOptions {
  type?: CodeReviewType
  /** Faster, shallower review. */
  light?: boolean
  /** Compare against this branch (e.g. main). */
  base?: string
}

/** CLI argv for `coderabbit review`. Exported for smoke. */
export function codeReviewArgs(opts: CodeReviewOptions = {}): string[] {
  const type = opts.type && TYPES.has(opts.type) ? opts.type : 'uncommitted'
  const args = ['review', '--agent', '--type', type]
  if (opts.light) args.push('--light')
  const base = opts.base?.trim()
  if (base) args.push('--base', base)
  return args
}

function clip(text: string): string {
  const t = text.trimEnd()
  if (t.length <= MAX_OUTPUT) return t
  return t.slice(0, MAX_OUTPUT) + `\n\n[truncated — ${t.length} chars]`
}

/**
 * Run CodeRabbit against the workspace git repo. Findings are returned as
 * text for the model; a missing CLI / auth failure is an error.
 */
export async function runCodeReview(
  workspaceRoot: string,
  opts: CodeReviewOptions = {},
  signal?: AbortSignal
): Promise<ToolResult> {
  const args = codeReviewArgs(opts)
  try {
    const { stdout, stderr } = await execFileAsync('coderabbit', args, {
      cwd: workspaceRoot,
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal,
      env: { ...process.env, PATH: resolveUserPath() }
    })
    const text = clip(`${stdout}${stderr}`.trim() || 'CodeRabbit reported no findings.')
    return { output: text, meta: { type: args[args.indexOf('--type') + 1] } }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string }
    if (e.code === 'ENOENT') return { output: MISSING_CLI, isError: true }
    const text = clip(`${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || String(err))
    const auth =
      /not authenticated|auth login|unauthorized|login required/i.test(text)
    return {
      output: auth
        ? `${text}\n\nRun \`coderabbit auth login\` in a terminal, then retry.`
        : text || 'CodeRabbit review failed.',
      isError: true
    }
  }
}

export const codeReviewTool: Tool = {
  name: 'code_review',
  description:
    'Run CodeRabbit on the workspace git diff and return findings. ' +
    'Default is uncommitted changes. Use after a meaningful edit set or when the user asks to review. ' +
    'Fix real issues; skip false positives. Prefer this over run_terminal for coderabbit.',
  // Uploads the workspace diff to CodeRabbit's service — approval-gated like
  // the other tools whose effects leave the machine.
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['all', 'committed', 'uncommitted'],
        description: 'What to review. Default: uncommitted.'
      },
      light: {
        type: 'boolean',
        description: 'Faster, shallower review.'
      },
      base: {
        type: 'string',
        description: 'Base branch to compare against (e.g. main).'
      }
    },
    additionalProperties: false
  },
  summarize: (args) => {
    const type = typeof args.type === 'string' ? args.type : 'uncommitted'
    const bits = [type]
    if (args.light === true) bits.push('light')
    if (typeof args.base === 'string' && args.base.trim()) bits.push(`vs ${args.base.trim()}`)
    return `CodeRabbit ${bits.join(' ')}`
  },
  async execute(args, ctx): Promise<ToolResult> {
    const type =
      typeof args.type === 'string' && TYPES.has(args.type)
        ? (args.type as CodeReviewType)
        : undefined
    const base = typeof args.base === 'string' ? args.base : undefined
    return runCodeReview(
      ctx.workspaceRoot,
      { type, light: args.light === true, base },
      ctx.signal
    )
  }
}
