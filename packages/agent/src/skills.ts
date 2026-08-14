import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveInWorkspace } from './tools/paths'

const MAX_SKILL_CHARS = 16_000
const MAX_ACTIVE_CHARS = 24_000

const PROJECT_SKILL_DIRS = ['.ion/skills', '.claude/skills', '.agents/skills', '.cursor/skills']

export interface SkillMeta {
  name: string
  description: string
  /** user = home-dir skills; project = workspace skills (wins on name clash). */
  source: 'user' | 'project'
  /** Directory that contains SKILL.md, or the folder of a flat .md skill. */
  dir: string
  skillPath: string
  disableModelInvocation: boolean
}

export interface DiscoverSkillsOptions {
  /** Override home skill roots (tests). Default: ~/.agents, ~/.claude, ~/.cursor, ~/.ion. */
  userRoots?: string[]
}

/** Home-dir skill folders, lowest → highest precedence. Skips ~/.cursor/skills-cursor. */
export function defaultUserSkillRoots(): string[] {
  const home = homedir()
  return [
    join(home, '.agents', 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.cursor', 'skills'),
    join(home, '.ion', 'skills')
  ]
}

/**
 * Discover SKILL.md packages (and flat `name.md` files). Later roots override
 * the same name — project `.cursor/skills` wins over user Ion skills.
 */
export async function discoverSkills(
  workspaceRoot: string | null,
  options?: DiscoverSkillsOptions
): Promise<SkillMeta[]> {
  const byName = new Map<string, SkillMeta>()
  for (const root of options?.userRoots ?? defaultUserSkillRoots()) {
    for (const skill of await scanSkillRoot(root, 'user')) byName.set(skill.name, skill)
  }
  if (workspaceRoot) {
    for (const rel of PROJECT_SKILL_DIRS) {
      for (const skill of await scanSkillRoot(join(workspaceRoot, rel), 'project')) {
        byName.set(skill.name, skill)
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function formatSkillCatalog(skills: SkillMeta[]): string | null {
  const listed = skills.filter((s) => !s.disableModelInvocation)
  if (listed.length === 0) return null
  const lines = [
    '## Skills',
    '',
    'Specialized playbooks. When a task matches a description, call read_skill',
    'with that name and follow the instructions. The user can also attach one',
    'with `/` in the composer — those arrive as "Active skills" in their message.',
    ''
  ]
  for (const s of listed) {
    const desc = s.description.trim() || '(no description)'
    lines.push(`- \`${s.name}\` (${s.source}): ${desc}`)
  }
  return lines.join('\n')
}

export async function loadSkillBody(skill: SkillMeta): Promise<string> {
  const raw = await readFile(skill.skillPath, 'utf8')
  const parsed = splitFrontmatter(raw)
  const body = parsed.body.trim() || raw.trim()
  return body.length > MAX_SKILL_CHARS ? body.slice(0, MAX_SKILL_CHARS) + '\n\n[truncated]' : body
}

/** Full bodies for `/`-attached skills, capped so a novel-length SKILL.md can't eat the turn. */
export async function expandActiveSkills(
  names: string[],
  workspaceRoot: string | null,
  options?: DiscoverSkillsOptions
): Promise<string> {
  if (names.length === 0) return ''
  const all = await discoverSkills(workspaceRoot, options)
  const chunks: string[] = []
  let used = 0
  for (const name of names) {
    const skill = all.find((s) => s.name === name)
    if (!skill) {
      chunks.push(`### Skill \`${name}\`\n\n(not found)`)
      continue
    }
    const body = await loadSkillBody(skill)
    const room = MAX_ACTIVE_CHARS - used
    if (room <= 0) break
    const text = `### Skill \`/${skill.name}\` (${skill.source})\n\n${body}`
    chunks.push(text.length > room ? text.slice(0, room) + '\n\n[truncated]' : text)
    used += Math.min(text.length, room)
  }
  if (chunks.length === 0) return ''
  return [
    '## Active skills',
    '',
    'The user invoked these with `/`. Follow them for this turn.',
    '',
    ...chunks
  ].join('\n')
}

export async function readSkillFile(skill: SkillMeta, relFile: string): Promise<string> {
  const file = relFile.trim() || 'SKILL.md'
  const abs = resolveInWorkspace(skill.dir, file)
  const raw = await readFile(abs, 'utf8')
  const text = file.toLowerCase() === 'skill.md' ? splitFrontmatter(raw).body.trim() || raw.trim() : raw
  return text.length > MAX_SKILL_CHARS ? text.slice(0, MAX_SKILL_CHARS) + '\n\n[truncated]' : text
}

async function scanSkillRoot(root: string, source: SkillMeta['source']): Promise<SkillMeta[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: SkillMeta[] = []
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    if (ent.isDirectory()) {
      const dir = join(root, ent.name)
      const skillPath = await firstExisting(join(dir, 'SKILL.md'), join(dir, 'skill.md'))
      if (!skillPath) continue
      out.push(await metaFromFile(skillPath, dir, ent.name, source))
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      const skillPath = join(root, ent.name)
      out.push(await metaFromFile(skillPath, root, basename(ent.name, '.md'), source))
    }
  }
  return out
}

async function metaFromFile(
  skillPath: string,
  dir: string,
  fallbackName: string,
  source: SkillMeta['source']
): Promise<SkillMeta> {
  let raw = ''
  try {
    raw = await readFile(skillPath, 'utf8')
  } catch {
    raw = ''
  }
  const fm = splitFrontmatter(raw).frontmatter
  const name = slug(fm.name || fallbackName)
  const disable =
    fm['disable-model-invocation'] === 'true' || fm.disablemodelinvocation === 'true'
  return {
    name,
    description: fm.description ?? '',
    source,
    dir,
    skillPath,
    disableModelInvocation: disable
  }
}

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'skill'
}

async function firstExisting(...paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      const info = await stat(p)
      if (info.isFile()) return p
    } catch {
      // try next
    }
  }
  return null
}

function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  if (!text.startsWith('---')) return { frontmatter: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: {}, body: text }
  const raw = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\s*\n/, '')
  const frontmatter: Record<string, string> = {}
  let pendingKey = ''
  let pending = ''
  const flush = (): void => {
    if (!pendingKey) return
    frontmatter[pendingKey] = pending.trim().replace(/^['"]|['"]$/g, '')
    pendingKey = ''
    pending = ''
  }
  for (const line of raw.split('\n')) {
    if (pendingKey && (line.startsWith('  ') || line.startsWith('\t') || line.trim() === '>')) {
      pending += ' ' + line.trim().replace(/^>\s*-?\s*/, '')
      continue
    }
    flush()
    const i = line.indexOf(':')
    if (i < 0) continue
    pendingKey = line.slice(0, i).trim().toLowerCase()
    pending = line.slice(i + 1).trim()
    if (pending === '>' || pending === '|') pending = ''
  }
  flush()
  return { frontmatter, body }
}
