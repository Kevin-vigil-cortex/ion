// Tiny glob matcher for .cursor/rules frontmatter.
// Not a full micromatch - covers the patterns those rules actually use.

export function matchGlob(pattern: string, filePath: string): boolean {
  const path = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const raw = pattern.trim().replace(/\\/g, '/')
  if (!raw) return false
  const pat = raw.includes('/') ? raw : `**/${raw}`
  return globToRegExp(pat).test(path)
}

export function parseGlobList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

function globToRegExp(glob: string): RegExp {
  let i = 0
  let out = '^'
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?'
      i += 3
      continue
    }
    if (glob[i] === '*' && glob[i + 1] === '*') {
      out += '.*'
      i += 2
      continue
    }
    if (glob[i] === '*') {
      out += '[^/]*'
      i += 1
      continue
    }
    if (glob[i] === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (glob[i] === '{') {
      const end = glob.indexOf('}', i)
      if (end > i) {
        const inner = glob
          .slice(i + 1, end)
          .split(',')
          .map(escapeRegex)
          .join('|')
        out += `(?:${inner})`
        i = end + 1
        continue
      }
    }
    out += escapeRegex(glob[i]!)
    i += 1
  }
  out += '$'
  return new RegExp(out)
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
