/**
 * Line-based unified diffs for checkpoint review. LCS for normal files;
 * a coarse fallback so a 10k-line rewrite doesn't freeze the UI.
 */

const MAX_LCS_LINES = 2_500
const MAX_DIFF_LINES = 200

export interface DiffSummary {
  additions: number
  deletions: number
  diff: string
}

/** Build a unified diff + add/del counts. `before === null` means the file was created. */
export function summarizeEdit(before: string | null, after: string, path: string): DiffSummary {
  const oldLines = before === null ? [] : splitLines(before)
  const newLines = splitLines(after)
  if (oldLines.length > MAX_LCS_LINES || newLines.length > MAX_LCS_LINES) {
    return {
      additions: newLines.length,
      deletions: oldLines.length,
      diff:
        `--- a/${path}\n+++ b/${path}\n` +
        `@@ file replaced (${oldLines.length} → ${newLines.length} lines) @@\n` +
        `[diff omitted - file too large to preview]`
    }
  }

  const ops = editScript(oldLines, newLines)
  let additions = 0
  let deletions = 0
  for (const op of ops) {
    if (op.t === 'add') additions++
    else if (op.t === 'del') deletions++
  }

  const header = `--- a/${path}\n+++ b/${path}`
  if (additions === 0 && deletions === 0) return { additions: 0, deletions: 0, diff: header }
  return { additions, deletions, diff: `${header}\n${renderUnified(ops)}` }
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

type Op = { t: 'eq' | 'del' | 'add'; s: string }

function editScript(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const table: Uint16Array[] = new Array(n + 1)
  table[0] = new Uint16Array(m + 1)
  for (let i = 1; i <= n; i++) {
    const row = new Uint16Array(m + 1)
    const ai = a[i - 1]
    const prev = table[i - 1]!
    for (let j = 1; j <= m; j++) {
      row[j] = ai === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!)
    }
    table[i] = row
  }

  const ops: Op[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ t: 'eq', s: a[i - 1]! })
      i--
      j--
    } else if (j > 0 && (i === 0 || table[i]![j - 1]! >= table[i - 1]![j]!)) {
      ops.push({ t: 'add', s: b[j - 1]! })
      j--
    } else {
      ops.push({ t: 'del', s: a[i - 1]! })
      i--
    }
  }
  ops.reverse()
  return ops
}

function renderUnified(ops: Op[]): string {
  const lines: string[] = []
  let shown = 0
  let i = 0
  let oldLine = 1
  let newLine = 1

  while (i < ops.length) {
    if (ops[i]!.t === 'eq') {
      oldLine++
      newLine++
      i++
      continue
    }

    const hunkStart = i
    let oldCount = 0
    let newCount = 0
    while (i < ops.length && ops[i]!.t !== 'eq') {
      if (ops[i]!.t === 'del') oldCount++
      else newCount++
      i++
    }

    const ctxBefore = hunkStart > 0 && ops[hunkStart - 1]!.t === 'eq' ? 1 : 0
    const ctxAfter = i < ops.length && ops[i]!.t === 'eq' ? 1 : 0
    const oldStart = oldLine - ctxBefore
    const newStart = newLine - ctxBefore

    if (shown >= MAX_DIFF_LINES) {
      lines.push('[diff truncated]')
      break
    }
    lines.push(`@@ -${Math.max(1, oldStart)},${oldCount + ctxBefore + ctxAfter} +${Math.max(1, newStart)},${newCount + ctxBefore + ctxAfter} @@`)
    shown++

    if (ctxBefore) {
      if (shown++ >= MAX_DIFF_LINES) break
      lines.push(` ${ops[hunkStart - 1]!.s}`)
    }
    for (let k = hunkStart; k < i; k++) {
      if (shown++ >= MAX_DIFF_LINES) {
        lines.push('[diff truncated]')
        return lines.join('\n')
      }
      const op = ops[k]!
      lines.push(`${op.t === 'del' ? '-' : '+'}${op.s}`)
      if (op.t === 'del') oldLine++
      else newLine++
    }
    if (ctxAfter) {
      if (shown++ >= MAX_DIFF_LINES) break
      lines.push(` ${ops[i]!.s}`)
    }
  }
  return lines.join('\n')
}
