import fg from 'fast-glob'
import { readFile, stat } from 'node:fs/promises'
import type { Tool, ToolContext, ToolResult } from './types'
import { resolveInWorkspace, displayPath } from './paths'
import { loadIgnoreSet } from '../ignore'

const MAX_MATCHES = 200
/** Hard cap on one grep scan — a pathological regex must not hang the loop. */
const GREP_BUDGET_MS = 10_000

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`Missing required string argument "${key}".`)
  return v
}

/**
 * fast-glob resolves patterns against cwd, so an absolute or `..` pattern
 * could match files outside the workspace. Reject those up front.
 */
function invalidGlob(pattern: string): ToolResult | null {
  if (pattern.startsWith('/') || /(^|[/\\])\.\.([/\\]|$)/.test(pattern)) {
    return {
      output: 'Glob patterns must be relative to the workspace root and must not contain "..".',
      isError: true
    }
  }
  return null
}

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files matching a glob pattern (e.g. "src/**/*.ts"). Recursive filenames only — use list_dir for one folder, find_path before a workspace is open, grep for contents.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern relative to the workspace root.' }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  summarize: (args) => `glob ${String(args.pattern ?? '')}`,
  async execute(args, ctx): Promise<ToolResult> {
    const pattern = str(args, 'pattern')
    const bad = invalidGlob(pattern)
    if (bad) return bad
    const ignore = await loadIgnoreSet(ctx.workspaceRoot)
    const matches = await fg(pattern, {
      cwd: ctx.workspaceRoot,
      ignore: ignore.searchGlobs,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false
    })
    const shown = matches.slice(0, MAX_MATCHES)
    const suffix = matches.length > MAX_MATCHES ? `\n\n[${matches.length - MAX_MATCHES} more not shown]` : ''
    return {
      output: shown.length ? shown.join('\n') + suffix : 'No files matched.',
      meta: { count: matches.length }
    }
  }
}

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents for a regular expression. Use glob first to find filenames; read_file for a full file; grep to locate symbols/strings.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      glob: {
        type: 'string',
        description: 'Optional glob to restrict which files are searched (default: all text files).'
      },
      ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
      path: {
        type: 'string',
        description: 'Optional subdirectory or file to search within (relative to the workspace).'
      }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  summarize: (args) => `grep ${String(args.pattern ?? '')}`,
  async execute(args, ctx): Promise<ToolResult> {
    let regex: RegExp
    try {
      regex = new RegExp(str(args, 'pattern'), args.ignore_case === true ? 'i' : undefined)
    } catch (err) {
      return { output: `Invalid regular expression: ${(err as Error).message}`, isError: true }
    }
    const pattern = typeof args.glob === 'string' && args.glob ? args.glob : '**/*'
    const bad = invalidGlob(pattern)
    if (bad) return bad
    const scope =
      typeof args.path === 'string' && args.path
        ? resolveInWorkspace(ctx.workspaceRoot, args.path)
        : ctx.workspaceRoot
    const ignore = await loadIgnoreSet(ctx.workspaceRoot)
    const files = await fg(pattern, {
      cwd: scope,
      ignore: ignore.searchGlobs,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false
    })

    const results: string[] = []
    let total = 0
    let outOfTime = false
    const deadline = Date.now() + GREP_BUDGET_MS
    scan: for (const rel of files) {
      if (ctx.signal.aborted) break
      if (Date.now() > deadline) {
        outOfTime = true
        break
      }
      let abs: string
      try {
        abs = resolveInWorkspace(scope, rel)
      } catch {
        continue // entry escapes the narrowed scope (symlink, odd glob)
      }
      try {
        const info = await stat(abs)
        if (info.size > 2 * 1024 * 1024) continue
      } catch {
        continue
      }
      let content: string
      try {
        content = await readFile(abs, 'utf8')
      } catch {
        continue
      }
      if (content.includes('\u0000')) continue // skip binary
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        // Slow-regex escape hatch: re-check the budget as we chew lines.
        if ((i & 1023) === 1023 && Date.now() > deadline) {
          outOfTime = true
          break scan
        }
        const line = lines[i] as string
        if (regex.test(line)) {
          total++
          if (results.length < MAX_MATCHES) {
            const clipped = line.length > 240 ? `${line.slice(0, 240)}…` : line
            results.push(`${displayPath(ctx.workspaceRoot, abs)}:${i + 1}: ${clipped.trim()}`)
          }
        }
      }
    }
    const notes: string[] = []
    if (total > results.length) notes.push(`[${total - results.length} more matches not shown]`)
    if (outOfTime) {
      notes.push(
        `[stopped after ${GREP_BUDGET_MS / 1000}s — narrow the pattern, glob, or path to finish]`
      )
    }
    const suffix = notes.length ? `\n\n${notes.join('\n')}` : ''
    return {
      output: results.length ? results.join('\n') + suffix : 'No matches found.',
      meta: { matches: total }
    }
  }
}
