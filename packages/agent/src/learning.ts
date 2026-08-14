import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Persistent learned memory ("self-learning"), distinct from `SessionStore`
 * (chat transcripts). Learnings are markdown bullet files the agent both reads
 * (injected into the system prompt) and writes (via the `save_memory` tool),
 * closing the loop so one session's learnings improve all future sessions.
 */

export type MemoryScope = 'global' | 'workspace'

export interface MemoryFile {
  scope: MemoryScope
  /** Absolute workspace root, or null for the global file (or unparseable header). */
  workspaceRoot: string | null
  /** Absolute path of the markdown file on disk. */
  path: string
  content: string
}

/** Prune caps applied on every append: newest entries win. */
export const MAX_MEMORY_ENTRIES = 100
export const MAX_MEMORY_BYTES = 8 * 1024

const WORKSPACE_HEADER_PREFIX = '# Memory for '

/**
 * File-backed store of durable learnings under `dir` (the host passes e.g.
 * `~/.ion/memory`): `global.md` plus one `workspaces/<hash>.md` per
 * workspace root. Entries are newest-first dated bullets.
 */
export class MemoryStore {
  constructor(private readonly dir: string) {}

  globalPath(): string {
    return join(this.dir, 'global.md')
  }

  workspacePath(workspaceRoot: string): string {
    const hash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12)
    return join(this.dir, 'workspaces', `${hash}.md`)
  }

  private pathFor(scope: MemoryScope, workspaceRoot?: string | null): string {
    if (scope === 'global') return this.globalPath()
    if (!workspaceRoot) throw new Error('A workspace root is required for workspace-scoped memory.')
    return this.workspacePath(workspaceRoot)
  }

  private async read(path: string): Promise<string> {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return ''
    }
  }

  /** Raw markdown of the global memory file ('' when none saved yet). */
  async readGlobal(): Promise<string> {
    return this.read(this.globalPath())
  }

  /** Raw markdown of a workspace's memory file ('' when none saved yet). */
  async readWorkspace(workspaceRoot: string): Promise<string> {
    return this.read(this.workspacePath(workspaceRoot))
  }

  /** Append a learning as a dated bullet at the top (newest first), pruning oldest past the caps. */
  async append(scope: MemoryScope, content: string, workspaceRoot?: string | null): Promise<void> {
    const path = this.pathFor(scope, workspaceRoot)
    const existing = await this.read(path)
    const { preamble, entries } = parseEntries(existing)

    const date = new Date().toISOString().slice(0, 10)
    // Single-line entries keep the file parseable and easy to scan.
    const line = `- [${date}] ${content.replace(/\s+/g, ' ').trim()}`
    entries.unshift(line)

    const header =
      scope === 'workspace' && preamble.length === 0
        ? [`${WORKSPACE_HEADER_PREFIX}${workspaceRoot}`, '']
        : preamble
    await this.write(path, serialize(header, prune(header, entries)))
  }

  /** Overwrite a file wholesale (used by the Memories editor UI). */
  async save(scope: MemoryScope, workspaceRoot: string | null, content: string): Promise<void> {
    const path = this.pathFor(scope, workspaceRoot)
    let text = content.trimEnd()
    // Keep the root header so the file can still be mapped back to its workspace.
    if (scope === 'workspace' && !text.startsWith(WORKSPACE_HEADER_PREFIX)) {
      text = `${WORKSPACE_HEADER_PREFIX}${workspaceRoot}\n\n${text}`
    }
    await this.write(path, text ? `${text}\n` : '')
  }

  /** Delete a memory file entirely. */
  async clear(scope: MemoryScope, workspaceRoot: string | null): Promise<void> {
    await rm(this.pathFor(scope, workspaceRoot), { force: true })
  }

  /** All memory files: global first (always present, even if empty), then workspaces. */
  async list(): Promise<MemoryFile[]> {
    const out: MemoryFile[] = [
      { scope: 'global', workspaceRoot: null, path: this.globalPath(), content: await this.readGlobal() }
    ]
    const wsDir = join(this.dir, 'workspaces')
    let files: string[] = []
    try {
      files = await readdir(wsDir)
    } catch {
      // No workspace memories yet.
    }
    const workspaces: MemoryFile[] = []
    for (const f of files.filter((f) => f.endsWith('.md')).sort()) {
      const path = join(wsDir, f)
      const content = await this.read(path)
      workspaces.push({ scope: 'workspace', workspaceRoot: parseRoot(content), path, content })
    }
    workspaces.sort((a, b) => (a.workspaceRoot ?? a.path).localeCompare(b.workspaceRoot ?? b.path))
    return [...out, ...workspaces]
  }

  private async write(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
}

/** Recover the workspace root from a `# Memory for <root>` first line. */
export function parseRoot(content: string): string | null {
  const first = content.split('\n', 1)[0] ?? ''
  return first.startsWith(WORKSPACE_HEADER_PREFIX)
    ? first.slice(WORKSPACE_HEADER_PREFIX.length).trim() || null
    : null
}

/**
 * Split a file into its preamble (header lines before the first bullet) and
 * entry blocks. A block starts at a `- ` line and keeps any continuation lines,
 * so hand-edited multi-line entries survive a round-trip.
 */
function parseEntries(content: string): { preamble: string[]; entries: string[] } {
  const lines = content.split('\n')
  const preamble: string[] = []
  const entries: string[] = []
  let current: string[] | null = null
  for (const line of lines) {
    if (line.startsWith('- ')) {
      if (current) entries.push(current.join('\n'))
      current = [line]
    } else if (current) {
      current.push(line)
    } else {
      preamble.push(line)
    }
  }
  if (current) entries.push(current.join('\n').trimEnd())
  while (preamble.length > 0 && preamble[preamble.length - 1]!.trim() === '') preamble.pop()
  return { preamble, entries: entries.map((e) => e.trimEnd()) }
}

/** Drop oldest entries (the tail) until both the entry and byte caps hold. */
function prune(preamble: string[], entries: string[]): string[] {
  let kept = entries.slice(0, MAX_MEMORY_ENTRIES)
  while (kept.length > 1 && Buffer.byteLength(serialize(preamble, kept), 'utf8') > MAX_MEMORY_BYTES) {
    kept = kept.slice(0, -1)
  }
  return kept
}

function serialize(preamble: string[], entries: string[]): string {
  const head = preamble.length > 0 ? preamble.join('\n') + '\n\n' : ''
  return head + entries.join('\n') + (entries.length > 0 ? '\n' : '')
}
