import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'

function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
}

/**
 * Canonicalize a path that may not fully exist yet: realpath the deepest
 * existing ancestor (resolving any symlinks), then re-attach the untouched
 * remainder. Used so containment checks see where a path REALLY points.
 */
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
 * Resolve a user/model-supplied path against the workspace root and guarantee
 * the result stays inside it. Throws on traversal outside the sandbox.
 *
 * Containment is checked twice: lexically (fast fail on `..` tricks) and on
 * the symlink-resolved real path, so a link inside the workspace pointing at
 * e.g. `~` cannot smuggle reads/writes outside it. The root itself is
 * canonicalized too (macOS puts tmp under the `/tmp -> /private/tmp` link).
 */
export function resolveInWorkspace(workspaceRoot: string, input: string): string {
  const root = resolve(workspaceRoot)
  const target = isAbsolute(input) ? resolve(input) : resolve(root, input)
  if (isOutside(root, target)) {
    throw new Error(`Path "${input}" resolves outside the workspace and was blocked.`)
  }
  if (isOutside(canonicalize(root), canonicalize(target))) {
    throw new Error(
      `Path "${input}" points outside the workspace through a symlink and was blocked.`
    )
  }
  return target
}

/** Format a path relative to the workspace for display. */
export function displayPath(workspaceRoot: string, absolutePath: string): string {
  const rel = relative(resolve(workspaceRoot), absolutePath)
  return rel === '' ? '.' : rel
}
