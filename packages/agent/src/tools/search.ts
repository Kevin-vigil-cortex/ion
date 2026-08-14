import fg from 'fast-glob'
import { readFile, stat } from 'node:fs/promises'
import type { Tool, ToolContext, ToolResult } from './types'
import { resolveInWorkspace, displayPath } from './paths'
import { loadIgnoreSet } from '../ignore'

const MAX_MATCHES = 200

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`Missing required string argument "${key}".`)
  return v
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
    // Confirm the pattern's base stays in-workspace, then glob from root.
    resolveInWorkspace(ctx.workspaceRoot, '.')
    const ignore = await loadIgnoreSet(ctx.workspaceRoot)
    const matches = await fg(str(args, 'pattern'), {
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
    for (const rel of files) {
      if (ctx.signal.aborted) break
      const abs = resolveInWorkspace(scope, rel)
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
    const suffix = total > results.length ? `\n\n[${total - results.length} more matches not shown]` : ''
    return {
      output: results.length ? results.join('\n') + suffix : 'No matches found.',
      meta: { matches: total }
    }
  }
}
