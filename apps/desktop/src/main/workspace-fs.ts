import { promises as fs, realpathSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import { formatGitDiff, loadIgnoreSet } from '@ion/agent'
import type { FsEntry, WorkspaceMention } from '../shared/ipc'

const execFileAsync = promisify(execFile)

function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
}

/** Realpath the deepest existing ancestor, then re-attach the remainder. */
function canonicalize(path: string): string {
  let existing = path
  let remainder = ''
  for (;;) {
    try {
      const real = realpathSync(existing)
      return remainder ? resolve(real, remainder) : real
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return path
      remainder = remainder ? join(basename(existing), remainder) : basename(existing)
      existing = parent
    }
  }
}

/**
 * File-explorer operations, sandboxed to the session's workspace root.
 * Mirrors the traversal guard used by the agent tools
 * (packages/agent/src/tools/paths.ts): every path is checked lexically AND on
 * its symlink-resolved real path, so links cannot smuggle operations outside
 * the workspace.
 */
function resolveInWorkspace(workspaceRoot: string, relPath: string): string {
  if (!workspaceRoot) throw new Error('No workspace is open.')
  const root = resolve(workspaceRoot)
  const target = isAbsolute(relPath) ? resolve(relPath) : resolve(root, relPath)
  if (isOutside(root, target)) {
    throw new Error(`Path "${relPath}" resolves outside the workspace and was blocked.`)
  }
  if (isOutside(canonicalize(root), canonicalize(target))) {
    throw new Error(
      `Path "${relPath}" points outside the workspace through a symlink and was blocked.`
    )
  }
  return target
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** List one directory, folders first, each group alphabetical. */
export async function listDir(workspaceRoot: string, relPath: string): Promise<FsEntry[]> {
  const dir = resolveInWorkspace(workspaceRoot, relPath)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

export async function createFile(workspaceRoot: string, relPath: string): Promise<void> {
  const target = resolveInWorkspace(workspaceRoot, relPath)
  if (await exists(target)) throw new Error(`"${relPath}" already exists.`)
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, '', { flag: 'wx' })
}

export async function createDir(workspaceRoot: string, relPath: string): Promise<void> {
  const target = resolveInWorkspace(workspaceRoot, relPath)
  if (await exists(target)) throw new Error(`"${relPath}" already exists.`)
  await fs.mkdir(target, { recursive: true })
}

/** Rename or move an entry. The destination must not already exist. */
export async function renameEntry(
  workspaceRoot: string,
  fromRelPath: string,
  toRelPath: string
): Promise<void> {
  const from = resolveInWorkspace(workspaceRoot, fromRelPath)
  const to = resolveInWorkspace(workspaceRoot, toRelPath)
  if (from === resolve(workspaceRoot)) throw new Error('Cannot move the workspace root.')
  if (from === to) return
  const nested = relative(from, to)
  if (nested !== '..' && !nested.startsWith('..' + sep) && !isAbsolute(nested)) {
    throw new Error('Cannot move a folder into itself.')
  }
  // Allow case-only renames on case-insensitive filesystems (macOS default).
  if (from.toLowerCase() !== to.toLowerCase() && (await exists(to))) {
    throw new Error(`"${toRelPath}" already exists.`)
  }
  await fs.rename(from, to)
}

/** Overwrite (or create) a text file. Used by chat Apply. */
export async function writeWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
  content: string
): Promise<void> {
  const target = resolveInWorkspace(workspaceRoot, relPath)
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
}

/**
 * Open a workspace file in the user's editor. Prefers Cursor, then VS Code,
 * then the OS default. `line` is 1-based when the editor supports `-g`.
 */
export async function openInEditor(
  workspaceRoot: string,
  relPath: string,
  line?: number
): Promise<void> {
  const abs = resolveInWorkspace(workspaceRoot, relPath)
  const target = line && line > 0 ? `${abs}:${line}` : abs
  for (const bin of ['cursor', 'code']) {
    try {
      await execFileAsync(bin, line && line > 0 ? ['-g', target] : [abs], { timeout: 8_000 })
      return
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'ENOENT') continue
      // Launched but exited non-zero — still treat as opened.
      return
    }
  }
  const err = await shell.openPath(abs)
  if (err) throw new Error(err)
}

/** Move an entry to the system Trash (recoverable). */
export async function deleteEntry(workspaceRoot: string, relPath: string): Promise<void> {
  const target = resolveInWorkspace(workspaceRoot, relPath)
  if (target === resolve(workspaceRoot)) throw new Error('Cannot delete the workspace root.')
  await shell.trashItem(target)
}

const SUGGEST_LIMIT = 40
const SUGGEST_MAX_VISIT = 2_000
const SUGGEST_MAX_DEPTH = 8
const MENTION_FILE_CHARS = 16_000
const MENTION_TOTAL_CHARS = 32_000

/**
 * Fuzzy path picker for `@` mentions. Shallow matches and basename prefixes
 * rank first; junk dirs are skipped.
 */
const SPECIAL_MENTIONS: Array<{
  path: string
  kind: 'diff' | 'staged'
  aliases: string[]
}> = [
  { path: 'diff', kind: 'diff', aliases: ['diff', 'git', 'changes'] },
  { path: 'staged', kind: 'staged', aliases: ['staged', 'index'] }
]

export async function suggestWorkspacePaths(
  workspaceRoot: string,
  query: string
): Promise<WorkspaceMention[]> {
  const root = resolve(workspaceRoot)
  const q = query.trim().toLowerCase()
  const specials: WorkspaceMention[] = []
  for (const s of SPECIAL_MENTIONS) {
    if (!q || s.aliases.some((a) => a.startsWith(q) || q.startsWith(a))) {
      specials.push({ path: s.path, isDir: false, kind: s.kind })
    }
  }

  const ignore = await loadIgnoreSet(root)
  const hits: { path: string; isDir: boolean; score: number }[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  let visited = 0

  while (queue.length > 0 && visited < SUGGEST_MAX_VISIT) {
    const next = queue.shift()
    if (!next) break
    let entries
    try {
      entries = await fs.readdir(next.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (visited >= SUGGEST_MAX_VISIT) break
      if (ent.name.startsWith('.')) continue
      if (ent.isSymbolicLink()) continue
      const abs = join(next.dir, ent.name)
      const rel = relative(root, abs).split(sep).join('/')
      if (ignore.ignores(rel)) continue
      visited++
      const isDir = ent.isDirectory()
      const score = mentionScore(rel, q)
      if (score < 10) hits.push({ path: rel, isDir, score })
      if (isDir && next.depth + 1 < SUGGEST_MAX_DEPTH) {
        queue.push({ dir: abs, depth: next.depth + 1 })
      }
    }
  }

  hits.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
  return [
    ...specials,
    ...hits.slice(0, SUGGEST_LIMIT).map(({ path, isDir }) => ({ path, isDir, kind: 'path' as const }))
  ]
}

function mentionScore(path: string, query: string): number {
  const p = path.toLowerCase()
  const base = p.split('/').pop() ?? p
  if (!query) return 100 + p.split('/').length
  if (base === query) return 0
  if (base.startsWith(query)) return 1
  if (base.includes(query)) return 2
  if (p.includes(query)) return 3
  return 10
}

/** Read `@`'d files / list `@`'d folders so the model sees the contents. */
export async function expandWorkspaceMentions(
  workspaceRoot: string,
  mentions: WorkspaceMention[]
): Promise<string> {
  if (mentions.length === 0) return ''
  const chunks: string[] = []
  let used = 0
  const ignore = await loadIgnoreSet(workspaceRoot)
  for (const m of mentions) {
    if (used >= MENTION_TOTAL_CHARS) break
    const room = MENTION_TOTAL_CHARS - used
    if (m.kind === 'diff' || m.kind === 'staged') {
      const body = await formatGitDiff(workspaceRoot, { staged: m.kind === 'staged' })
      const title = m.kind === 'staged' ? 'Staged diff' : 'Working tree'
      const text = `### ${title} (@${m.kind})\n\n${body}`
      chunks.push(text.length > room ? text.slice(0, room) + '\n\n[truncated]' : text)
      used += Math.min(text.length, room)
      continue
    }
    try {
      const abs = resolveInWorkspace(workspaceRoot, m.path)
      if (ignore.blocksRead(m.path) || ignore.ignores(m.path)) {
        chunks.push(`### \`${m.path}\`\n\n(ignored — not attached)`)
        continue
      }
      if (m.isDir) {
        const names = (await fs.readdir(abs, { withFileTypes: true }))
          .filter((e) => {
            if (e.name.startsWith('.')) return false
            const child = `${m.path.replace(/\\/g, '/').replace(/\/$/, '')}/${e.name}`
            return !ignore.ignores(child)
          })
          .sort((a, b) =>
            a.isDirectory() === b.isDirectory()
              ? a.name.localeCompare(b.name)
              : a.isDirectory()
                ? -1
                : 1
          )
          .slice(0, 80)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        const body = names.join('\n') || '(empty)'
        const text = `### Folder \`${m.path}\`\n\n${body}`
        chunks.push(text.length > room ? text.slice(0, room) + '\n\n[truncated]' : text)
        used += Math.min(text.length, room)
      } else {
        const buf = await fs.readFile(abs)
        if (buf.includes(0)) {
          chunks.push(`### File \`${m.path}\`\n\n(binary — not attached)`)
          continue
        }
        const raw = buf.toString('utf8')
        const clipped =
          raw.length > MENTION_FILE_CHARS ? raw.slice(0, MENTION_FILE_CHARS) + '\n\n[truncated]' : raw
        const text = `### File \`${m.path}\`\n\n\`\`\`\n${clipped}\n\`\`\``
        chunks.push(text.length > room ? text.slice(0, room) + '\n\n[truncated]' : text)
        used += Math.min(text.length, room)
      }
    } catch {
      chunks.push(`### \`${m.path}\`\n\n(could not read)`)
    }
  }
  if (chunks.length === 0) return ''
  return ['## Attached context', '', 'The user @-mentioned these paths. Use them; do not re-read unless they may have changed.', '', ...chunks].join(
    '\n'
  )
}
