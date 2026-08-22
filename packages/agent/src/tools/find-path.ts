import { homedir } from 'node:os'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolResult } from './types'

const MAX_RESULTS = 40
const MAX_DEPTH = 6
const MAX_DIRS_VISITED = 30_000
const TIME_BUDGET_MS = 8_000

/** Directories that are never projects and only slow the walk down. */
const SKIP_DIRS = new Set([
  'node_modules',
  'Library',
  'Applications',
  '.Trash',
  '.git',
  '.cache',
  '.npm',
  '.cargo',
  '.rustup',
  '.gradle',
  '.m2',
  '.vscode',
  '.cursor',
  'build',
  'dist',
  'out',
  '.next',
  'target',
  'DerivedData',
  '__pycache__',
  '.venv',
  'venv'
])

/**
 * Workspace-free filename search across the user's home directory so the
 * agent can locate a project folder before any workspace is open (pairs with
 * open_workspace). Implemented as a breadth-first fs walk rather than
 * Spotlight: mdfind silently omits TCC-protected folders (Documents, Desktop,
 * Downloads) for apps without a file-access grant, whereas touching them
 * directly raises the proper macOS permission prompt once. BFS returns
 * shallow (real) hits before copies buried deep in build output.
 */
export const findPathTool: Tool = {
  name: 'find_path',
  description:
    'Search the user\'s home directory for files or folders whose NAME contains a query ' +
    '(case-insensitive). Works without a workspace - use kind:"folder" for project names, ' +
    'then open the hit with open_workspace. Optional root (e.g. "~/Documents") narrows the walk. ' +
    `Returns up to ${MAX_RESULTS} absolute paths, shallowest first. Names only, not contents.`,
  dangerous: false,
  requiresWorkspace: false,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Name or name fragment to look for, e.g. "Aki" or "package.json".'
      },
      kind: {
        type: 'string',
        enum: ['folder', 'file', 'any'],
        description: 'Restrict matches to folders or files. Use "folder" for project names. Default "any".'
      },
      root: {
        type: 'string',
        description: 'Optional directory to search under (absolute or ~/…). Defaults to the home folder.'
      }
    },
    required: ['query'],
    additionalProperties: false
  },
  summarize: (args) => `find "${String(args.query ?? '')}"`,
  async execute(args, ctx): Promise<ToolResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) return { output: 'query must be a non-empty string.', isError: true }
    const kind = args.kind === 'folder' || args.kind === 'file' ? args.kind : 'any'

    const home = homedir()
    const root = resolveSearchRoot(args.root, home)
    const { matches, truncated } = await search(root, query, kind, ctx.signal)

    if (matches.length === 0) {
      return {
        output:
          `No ${kind === 'any' ? 'files or folders' : kind + 's'} named like "${query}" ` +
          `found under ${root} (searched ${MAX_DEPTH} levels deep, skipping hidden and system folders).` +
          (truncated
            ? ' Search stopped early - retry with a more specific query or a narrower root (e.g. "~/Documents").'
            : '')
      }
    }
    const footer = truncated
      ? `\n\n[Search stopped early (time/depth limit). Narrow with kind:"folder" or root:"~/Documents".]`
      : ''
    return { output: matches.join('\n') + footer }
  }
}

function resolveSearchRoot(raw: unknown, home: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return home
  const expanded =
    raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
  if (expanded !== home && !expanded.startsWith(home + '/')) return home
  return expanded
}

async function search(
  root: string,
  query: string,
  kind: 'folder' | 'file' | 'any',
  signal: AbortSignal
): Promise<{ matches: string[]; truncated: boolean }> {
  const q = query.toLowerCase()
  const results: string[] = []
  const deadline = Date.now() + TIME_BUDGET_MS
  let visited = 0
  let truncated = false

  let level: string[] = [root]
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const nextLevel: string[] = []
    for (const dir of level) {
      if (signal.aborted || visited >= MAX_DIRS_VISITED || Date.now() > deadline) {
        truncated = true
        return { matches: finish(results), truncated }
      }
      visited++
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue // unreadable dir (permissions) - skip, keep walking
      }
      for (const entry of entries) {
        const name = entry.name
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
        const isDir = entry.isDirectory()
        if (name.toLowerCase().includes(q)) {
          if (kind === 'any' || (kind === 'folder') === isDir) {
            results.push(join(dir, name))
          }
        }
        // Never descend through symlinks: they can loop or leave $HOME.
        if (isDir && !entry.isSymbolicLink()) nextLevel.push(join(dir, name))
      }
    }
    // Finish the level before stopping so "shallowest first" stays stable.
    if (results.length >= MAX_RESULTS) {
      truncated = true
      return { matches: finish(results), truncated }
    }
    level = nextLevel
  }
  return { matches: finish(results), truncated }
}

function finish(results: string[]): string[] {
  return results.sort((a, b) => a.length - b.length).slice(0, MAX_RESULTS)
}
