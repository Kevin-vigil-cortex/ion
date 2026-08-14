import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { matchGlob } from './glob'

/** Directory names skipped by list/suggest even without a gitignore. */
export const DEFAULT_SKIP_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'target',
  'coverage',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'release'
]

const DEFAULT_FILE_GLOBS = [
  '**/.env',
  '**/.env.*',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/Gemfile.lock'
]

const SECRET_NAMES = new Set(['.env', 'credentials.json', 'id_rsa', 'id_ed25519'])

export interface IgnoreRule {
  glob: string
  negate: boolean
}

export class IgnoreSet {
  readonly searchGlobs: string[]

  constructor(
    private readonly searchRules: IgnoreRule[],
    private readonly blockRules: IgnoreRule[]
  ) {
    this.searchGlobs = toFastGlobIgnore(searchRules)
  }

  /** True when glob / grep / list / @suggest should hide this path. */
  ignores(relPath: string): boolean {
    return applyRules(this.searchRules, toPosix(relPath))
  }

  /**
   * True when the agent must not read or write this path (.cursorignore /
   * .ionignore / secrets). gitignore alone does not block an explicit read.
   */
  blocksRead(relPath: string): boolean {
    const rel = toPosix(relPath)
    if (isSecretPath(rel)) return true
    return applyRules(this.blockRules, rel)
  }
}

export async function loadIgnoreSet(workspaceRoot: string): Promise<IgnoreSet> {
  const defaults = [
    ...DEFAULT_SKIP_DIRS.flatMap((d) => dirRules(d)),
    ...DEFAULT_FILE_GLOBS.map((glob) => ({ glob, negate: false }))
  ]
  const git = parseIgnoreContents((await readOptional(join(workspaceRoot, '.gitignore'))) ?? '')
  const cursor = parseIgnoreContents((await readOptional(join(workspaceRoot, '.cursorignore'))) ?? '')
  const ion = parseIgnoreContents((await readOptional(join(workspaceRoot, '.ionignore'))) ?? '')
  return new IgnoreSet([...defaults, ...git, ...cursor, ...ion], [...cursor, ...ion])
}

/** Parse a gitignore-style file into globs. Exported for tests. */
export function parseIgnoreContents(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let negate = false
    let body = line
    if (body.startsWith('!')) {
      negate = true
      body = body.slice(1)
    }
    rules.push(...lineToRules(body, negate))
  }
  return rules
}

export function isSecretPath(relPath: string): boolean {
  const base = toPosix(relPath).split('/').pop() ?? relPath
  if (base === '.env.example' || base === '.env.sample' || base === '.env.template') return false
  if (SECRET_NAMES.has(base)) return true
  if (base.startsWith('.env.')) return true
  return base.endsWith('.pem') || base.endsWith('.key')
}

function dirRules(name: string): IgnoreRule[] {
  return [
    { glob: name, negate: false },
    { glob: `**/${name}`, negate: false },
    { glob: `**/${name}/**`, negate: false }
  ]
}

function lineToRules(pattern: string, negate: boolean): IgnoreRule[] {
  let p = pattern.replace(/\\/g, '/')
  const rooted = p.startsWith('/')
  if (rooted) p = p.slice(1)
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.slice(0, -1)
  if (!p) return []
  const scoped = rooted || p.includes('/') ? p : `**/${p}`
  const rules: IgnoreRule[] = [{ glob: scoped, negate }]
  if (dirOnly) rules.push({ glob: `${scoped}/**`, negate })
  else rules.push({ glob: `${scoped}/**`, negate })
  return rules
}

function applyRules(rules: IgnoreRule[], rel: string): boolean {
  let ignored = false
  for (const rule of rules) {
    if (matchGlob(rule.glob, rel)) ignored = !rule.negate
  }
  return ignored
}

function toFastGlobIgnore(rules: IgnoreRule[]): string[] {
  return rules.map((r) => (r.negate ? `!${r.glob}` : r.glob))
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
