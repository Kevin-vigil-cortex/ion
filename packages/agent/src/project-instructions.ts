import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { matchGlob, parseGlobList } from './glob'

const MAX_FILE_CHARS = 16_000
const MAX_TOTAL_CHARS = 32_000

const ROOT_FILES = ['AGENTS.md', 'CLAUDE.md', 'ION.md', '.cursorrules']

export interface ProjectInstructionOptions {
  /**
   * Files the agent has read or edited this turn. Glob-gated `.cursor/rules`
   * are injected only when one of these paths matches.
   */
  activePaths?: string[]
}

/**
 * Load the repo's agent brief the way Cursor does: AGENTS.md / CLAUDE.md /
 * ION.md / .cursorrules, plus `.cursor/rules` (always-apply, glob-matched,
 * and a short index of the rest). Missing files are skipped. Capped so a
 * novel-length CLAUDE.md can't eat the window.
 */
export async function loadProjectInstructions(
  workspaceRoot: string,
  options?: ProjectInstructionOptions
): Promise<string | null> {
  const chunks: string[] = []
  let used = 0

  for (const name of ROOT_FILES) {
    const text = await readCapped(join(workspaceRoot, name))
    if (!text) continue
    const room = MAX_TOTAL_CHARS - used
    if (room <= 0) break
    const body = text.length > room ? text.slice(0, room) + '\n\n[truncated]' : text
    chunks.push(`### ${name}\n\n${body}`)
    used += body.length
  }

  if (used < MAX_TOTAL_CHARS) {
    const rules = await loadCursorRules(
      join(workspaceRoot, '.cursor', 'rules'),
      MAX_TOTAL_CHARS - used,
      options?.activePaths ?? []
    )
    chunks.push(...rules)
  }

  if (chunks.length === 0) return null
  return [
    '## Project instructions',
    '',
    'These files live in the open workspace. Follow them. More specific nested',
    "notes win over general ones. They are the project's brief, not user chat.",
    '',
    ...chunks
  ].join('\n')
}

async function loadCursorRules(
  dir: string,
  budget: number,
  activePaths: string[]
): Promise<string[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.mdc') || n.endsWith('.md')).sort()
  } catch {
    return []
  }
  const out: string[] = []
  const catalog: string[] = []
  let used = 0
  for (const name of names) {
    const raw = await readCapped(join(dir, name))
    if (!raw) continue
    const parsed = splitFrontmatter(raw)
    const decision = decideRule(parsed.frontmatter, activePaths)
    const desc = parsed.frontmatter.description ?? parsed.frontmatter.desc
    if (decision === 'skip') continue
    if (decision === 'index') {
      catalog.push(`- \`.cursor/rules/${name}\`${desc ? ` - ${desc}` : ''}`)
      continue
    }
    const room = budget - used
    if (room <= 0) break
    const body =
      parsed.body.length > room ? parsed.body.slice(0, room) + '\n\n[truncated]' : parsed.body
    if (!body.trim()) continue
    out.push(`### .cursor/rules/${name}\n\n${body}`)
    used += body.length
  }
  if (catalog.length > 0 && used < budget) {
    const block = [
      '### Optional rules (not auto-applied)',
      '',
      'These have globs or "apply intelligently" descriptions. Follow them when relevant;',
      'read the file if you need the full text.',
      '',
      ...catalog
    ].join('\n')
    if (block.length <= budget - used) out.push(block)
  }
  return out
}

function decideRule(
  fm: Record<string, string>,
  activePaths: string[]
): 'full' | 'index' | 'skip' {
  const always = fm.alwaysapply ?? fm.alwaysapply
  if (always === 'true') return 'full'
  const globs = parseGlobList(fm.globs ?? fm.glob)
  if (globs.length > 0) {
    if (activePaths.some((p) => globs.some((g) => matchGlob(g, p)))) return 'full'
    return 'index'
  }
  if (always === 'false') return 'index'
  // No globs / no explicit alwaysApply:false → treat as always-on.
  return 'full'
}

function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  if (!text.startsWith('---')) return { frontmatter: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: {}, body: text }
  const raw = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\s*\n/, '')
  const frontmatter: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim()
    const val = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key) frontmatter[key.toLowerCase()] = val
  }
  return { frontmatter, body }
}

async function readCapped(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const trimmed = raw.trim()
    if (!trimmed) return null
    return trimmed.length > MAX_FILE_CHARS
      ? trimmed.slice(0, MAX_FILE_CHARS) + '\n\n[truncated]'
      : trimmed
  } catch {
    return null
  }
}
