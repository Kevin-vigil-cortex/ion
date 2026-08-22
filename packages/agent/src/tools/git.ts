import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool, ToolContext, ToolResult } from './types'
import { resolveInWorkspace } from './paths'

const execFileAsync = promisify(execFile)
const MAX_DIFF_CHARS = 32_000

async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 20_000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      signal
    })
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: string }
    if (e.code === 'ENOENT') {
      return { ok: false, stdout: '', stderr: 'git is not installed or not on PATH.' }
    }
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr || e.message || String(err) }
  }
}

async function ensureRepo(cwd: string, signal?: AbortSignal): Promise<string | null> {
  const res = await git(cwd, ['rev-parse', '--show-toplevel'], signal)
  if (!res.ok) return res.stderr.trim() || 'Not a git repository.'
  return null
}

function clip(text: string, cap = MAX_DIFF_CHARS): string {
  if (text.length <= cap) return text
  return text.slice(0, cap) + `\n\n[truncated - ${text.length} chars]`
}

/** Status + staged/unstaged diffs for @diff / the git_diff tool. */
export async function formatGitDiff(
  workspaceRoot: string,
  opts: { staged?: boolean; signal?: AbortSignal } = {}
): Promise<string> {
  const err = await ensureRepo(workspaceRoot, opts.signal)
  if (err) return err

  const chunks: string[] = []
  const status = await git(workspaceRoot, ['status', '--short', '--branch'], opts.signal)
  if (status.stdout.trim()) chunks.push('## git status\n\n```\n' + status.stdout.trimEnd() + '\n```')

  if (opts.staged) {
    const staged = await git(workspaceRoot, ['diff', '--cached', '--no-color'], opts.signal)
    chunks.push('## staged\n\n```diff\n' + (staged.stdout.trimEnd() || '(empty)') + '\n```')
  } else {
    const staged = await git(workspaceRoot, ['diff', '--cached', '--no-color'], opts.signal)
    const unstaged = await git(workspaceRoot, ['diff', '--no-color'], opts.signal)
    const untracked = await git(
      workspaceRoot,
      ['ls-files', '--others', '--exclude-standard'],
      opts.signal
    )
    if (staged.stdout.trim()) {
      chunks.push('## staged\n\n```diff\n' + staged.stdout.trimEnd() + '\n```')
    }
    chunks.push('## unstaged\n\n```diff\n' + (unstaged.stdout.trimEnd() || '(empty)') + '\n```')
    if (untracked.stdout.trim()) {
      chunks.push('## untracked\n\n' + untracked.stdout.trimEnd())
    }
  }
  return clip(chunks.join('\n\n') || 'Working tree is clean.')
}

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description:
    'Show git status and diffs for the workspace. Default is branch + staged + unstaged + untracked. ' +
    'Pass staged:true for the index only. Prefer this over run_terminal for git status/diff.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'If true, only the staged (index) diff.'
      }
    },
    additionalProperties: false
  },
  summarize: (args) => (args.staged === true ? 'git diff --staged' : 'git diff'),
  async execute(args, ctx): Promise<ToolResult> {
    const output = await formatGitDiff(ctx.workspaceRoot, {
      staged: args.staged === true,
      signal: ctx.signal
    })
    const failed = output.startsWith('Not a git') || output.includes('not on PATH')
    return { output, isError: failed }
  }
}

export const gitCommitTool: Tool = {
  name: 'git_commit',
  description:
    'Stage the given paths (or all tracked updates if paths is omitted) and create a git commit. ' +
    'Does not push. Write a conventional commit message. Never commit secrets.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message (subject + optional body).' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workspace-relative paths to stage. Omit to `git add -u` (tracked files only).'
      }
    },
    required: ['message'],
    additionalProperties: false
  },
  summarize: (args) => `commit ${String(args.message ?? '').slice(0, 60)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const message = typeof args.message === 'string' ? args.message.trim() : ''
    if (!message) return { output: 'message is required.', isError: true }
    const err = await ensureRepo(ctx.workspaceRoot, ctx.signal)
    if (err) return { output: err, isError: true }

    const paths = Array.isArray(args.paths)
      ? args.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : []
    if (paths.length > 0) {
      const rels = paths.map((p) => {
        resolveInWorkspace(ctx.workspaceRoot, p)
        return p.replace(/\\/g, '/')
      })
      const add = await git(ctx.workspaceRoot, ['add', '--', ...rels], ctx.signal)
      if (!add.ok) return { output: add.stderr || add.stdout || 'git add failed.', isError: true }
    } else {
      const add = await git(ctx.workspaceRoot, ['add', '-u'], ctx.signal)
      if (!add.ok) return { output: add.stderr || add.stdout || 'git add -u failed.', isError: true }
    }

    const commit = await git(ctx.workspaceRoot, ['commit', '-m', message], ctx.signal)
    const text = (commit.stdout + commit.stderr).trim()
    if (!commit.ok) return { output: text || 'git commit failed.', isError: true }
    return { output: text || 'Committed.', meta: { message } }
  }
}

/** Stage specific paths and commit. Used by the review-card Commit button. */
export async function commitPaths(
  workspaceRoot: string,
  message: string,
  paths: string[]
): Promise<{ ok: boolean; output: string }> {
  const result = await gitCommitTool.execute({ message, paths }, {
    workspaceRoot,
    signal: new AbortController().signal
  })
  return { ok: !result.isError, output: result.output }
}
