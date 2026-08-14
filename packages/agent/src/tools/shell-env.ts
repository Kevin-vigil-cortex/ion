import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SYSTEM_BINS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const COMMON_BINS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']

/**
 * Packaged Electron apps launched from Finder/Dock inherit macOS's GUI PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`). Homebrew, nvm, and /usr/local vanish, so
 * `npm`/`node`/`brew` look "broken" to the model. Rebuild a PATH that keeps
 * whatever the process already has and prepends the bins a login shell would.
 */
export function resolveUserPath(current = process.env.PATH ?? ''): string {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (dir: string, requireExists = true): void => {
    if (!dir || seen.has(dir)) return
    if (requireExists && !existsSync(dir)) return
    seen.add(dir)
    out.push(dir)
  }

  for (const dir of COMMON_BINS) add(dir)
  for (const dir of nvmBins()) add(dir)
  add(join(homedir(), '.local/bin'))
  add(join(homedir(), '.fnm/current/bin'))
  add(join(homedir(), '.volta/bin'))
  add(join(homedir(), '.asdf/shims'))
  add(join(homedir(), '.pyenv/shims'))
  add(join(homedir(), '.rbenv/shims'))
  add(join(homedir(), '.local/share/mise/shims'))

  for (const dir of current.split(':')) add(dir, false)
  for (const dir of SYSTEM_BINS) add(dir)

  return out.join(':')
}

function nvmBins(): string[] {
  const base = join(homedir(), '.nvm/versions/node')
  if (!existsSync(base)) return []
  try {
    return readdirSync(base)
      .filter((v) => existsSync(join(base, v, 'bin')))
      .sort()
      .reverse()
      .map((v) => join(base, v, 'bin'))
  } catch {
    return []
  }
}

/** Mutate `process.env.PATH` so every subsequent spawn sees user bins. */
export function applyUserPath(): void {
  process.env.PATH = resolveUserPath()
}
