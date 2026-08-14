import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveInWorkspace } from './tools/paths'
import { summarizeEdit } from './diff'
import type { CheckpointFile, CheckpointItem } from './types'
import type { Session } from './memory'

export const FILE_MUTATORS = new Set(['write_file', 'edit_file'])
export const FILE_READERS = new Set(['read_file', 'edit_file', 'write_file'])

/** Skip snapshotting binaries / huge files so sessions stay lean. */
const MAX_SNAPSHOT_BYTES = 512 * 1024

export interface FileSnapshot {
  before: string | null
  after?: string | null
  skipped?: boolean
}

/** Read a workspace file for a checkpoint. `null` = missing. Skips binaries / huge files. */
export async function snapshotFile(
  workspaceRoot: string,
  relPath: string
): Promise<{ content: string | null; skipped: boolean }> {
  let abs: string
  try {
    abs = resolveInWorkspace(workspaceRoot, relPath)
  } catch {
    return { content: null, skipped: true }
  }
  try {
    const buf = await readFile(abs)
    if (buf.includes(0) || buf.byteLength > MAX_SNAPSHOT_BYTES) {
      return { content: null, skipped: true }
    }
    return { content: buf.toString('utf8'), skipped: false }
  } catch {
    return { content: null, skipped: false }
  }
}

export function buildCheckpointFile(
  path: string,
  before: string | null,
  after: string | null,
  skipped: boolean
): CheckpointFile | null {
  if (skipped) {
    return {
      path,
      created: before === null,
      skipped: true,
      additions: 0,
      deletions: 0,
      diff: `[${path} — too large or binary to snapshot]`,
      before: null,
      after: null
    }
  }
  if (after === before) return null
  const summary = summarizeEdit(before, after ?? '', path)
  return {
    path,
    created: before === null && after !== null,
    additions: summary.additions,
    deletions: summary.deletions,
    diff: summary.diff,
    before,
    after
  }
}

/** Write `before` back (or delete if the file was created this turn). */
export async function restoreFiles(
  workspaceRoot: string,
  files: CheckpointFile[],
  onlyPath?: string
): Promise<string[]> {
  const restored: string[] = []
  for (const file of files) {
    if (onlyPath && file.path !== onlyPath) continue
    if (file.skipped) continue
    const abs = resolveInWorkspace(workspaceRoot, file.path)
    if (file.before === null) {
      await rm(abs, { force: true })
    } else {
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, file.before, 'utf8')
    }
    restored.push(file.path)
  }
  return restored
}

/** Restore without a live AgentSession (reopened chat). Mutates `session`. */
export async function restoreSessionCheckpoint(
  session: Session,
  checkpointId: string,
  path?: string
): Promise<string[]> {
  const item = session.items.find(
    (i): i is CheckpointItem => i.kind === 'checkpoint' && i.id === checkpointId
  )
  if (!item) throw new Error('Checkpoint not found.')
  if (!session.workspaceRoot) throw new Error('No workspace folder is open.')
  const restored = await restoreFiles(session.workspaceRoot, item.files, path)
  item.restoredPaths = [...new Set([...(item.restoredPaths ?? []), ...restored])]
  return restored
}

export function checkpointSummary(item: CheckpointItem): Array<{
  path: string
  created: boolean
  skipped?: boolean
  additions: number
  deletions: number
  diff: string
}> {
  return item.files.map((f) => ({
    path: f.path,
    created: f.created,
    ...(f.skipped ? { skipped: true } : {}),
    additions: f.additions,
    deletions: f.deletions,
    diff: f.diff
  }))
}
