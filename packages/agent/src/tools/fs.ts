import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Tool, ToolContext, ToolResult } from './types'
import { resolveInWorkspace, displayPath } from './paths'
import { loadIgnoreSet } from '../ignore'

const MAX_READ_BYTES = 256 * 1024

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`Missing required string argument "${key}".`)
  return v
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a text file within the workspace. Returns up to 256KB. For large files, pass ' +
    'offset (1-based start line) and limit (line count) to read a window. ' +
    'Use grep to search inside files; glob to find paths; list_dir for one directory.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      offset: {
        type: 'number',
        description: 'Optional 1-based line number to start reading from.'
      },
      limit: { type: 'number', description: 'Optional maximum number of lines to return.' }
    },
    required: ['path'],
    additionalProperties: false
  },
  summarize: (args) => `read ${String(args.path ?? '')}`,
  async execute(args, ctx): Promise<ToolResult> {
    const rel = str(args, 'path')
    const abs = resolveInWorkspace(ctx.workspaceRoot, rel)
    const ignore = await loadIgnoreSet(ctx.workspaceRoot)
    if (ignore.blocksRead(displayPath(ctx.workspaceRoot, abs))) {
      return {
        output: `Blocked by ignore rules (.cursorignore / .ionignore / secret file): ${rel}`,
        isError: true
      }
    }
    let info
    try {
      info = await stat(abs)
    } catch {
      return {
        output: `File not found: ${rel}. Check the path with list_dir or glob.`,
        isError: true
      }
    }
    if (info.isDirectory()) {
      return { output: `"${rel}" is a directory — use list_dir to see its entries.`, isError: true }
    }
    const buf = await readFile(abs)
    if (buf.includes(0)) {
      return {
        output: `Binary file — cannot read "${rel}" as text. Use run_terminal for metadata (e.g. file, identify).`,
        isError: true
      }
    }
    const truncated = buf.byteLength > MAX_READ_BYTES
    const text = buf.subarray(0, MAX_READ_BYTES).toString('utf8')

    const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : null
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : null
    if (offset !== null || limit !== null) {
      const lines = text.split('\n')
      const start = (offset ?? 1) - 1
      if (start >= lines.length) {
        return {
          output:
            `Requested offset ${start + 1} is past the ${truncated ? 'readable (256KB-capped) ' : ''}` +
            `end of ${rel} (${lines.length} lines).`,
          isError: true
        }
      }
      const end = limit !== null ? Math.min(start + limit, lines.length) : lines.length
      const window = lines.slice(start, end).join('\n')
      const footer =
        end < lines.length
          ? `\n\n[lines ${start + 1}-${end} of ${lines.length}${truncated ? '+ (file truncated at 256KB)' : ''} — continue with offset: ${end + 1}]`
          : `\n\n[lines ${start + 1}-${end} of ${lines.length}${truncated ? '+ (file truncated at 256KB)' : ''}]`
      return {
        output: window + footer,
        meta: { path: displayPath(ctx.workspaceRoot, abs), bytes: info.size }
      }
    }

    return {
      output: truncated
        ? `${text}\n\n[truncated at ${MAX_READ_BYTES} bytes — use offset/limit to read further]`
        : text,
      meta: { path: displayPath(ctx.workspaceRoot, abs), bytes: info.size }
    }
  }
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Create or overwrite a file with the given content. Parent directories are created as needed.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      content: { type: 'string', description: 'Full file content to write.' }
    },
    required: ['path', 'content'],
    additionalProperties: false
  },
  summarize: (args) => `write ${String(args.path ?? '')}`,
  async execute(args, ctx): Promise<ToolResult> {
    const rel = str(args, 'path')
    const abs = resolveInWorkspace(ctx.workspaceRoot, rel)
    const ignore = await loadIgnoreSet(ctx.workspaceRoot)
    if (ignore.blocksRead(displayPath(ctx.workspaceRoot, abs))) {
      return {
        output: `Blocked by ignore rules (.cursorignore / .ionignore / secret file): ${rel}`,
        isError: true
      }
    }
    const content = str(args, 'content')
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    const lines = content.split('\n').length
    return {
      output: `Wrote ${content.length} bytes (${lines} lines) to ${displayPath(ctx.workspaceRoot, abs)}.`,
      meta: { path: displayPath(ctx.workspaceRoot, abs) }
    }
  }
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact substring in an existing file. `old_string` must appear exactly once unless `replace_all` is true. Always read_file first so old_string matches the file exactly.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of requiring a unique match.'
      }
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false
  },
  summarize: (args) => `edit ${String(args.path ?? '')}`,
  async execute(args, ctx): Promise<ToolResult> {
    const rel = str(args, 'path')
    const abs = resolveInWorkspace(ctx.workspaceRoot, rel)
    const ignore = await loadIgnoreSet(ctx.workspaceRoot)
    if (ignore.blocksRead(displayPath(ctx.workspaceRoot, abs))) {
      return {
        output: `Blocked by ignore rules (.cursorignore / .ionignore / secret file): ${rel}`,
        isError: true
      }
    }
    const oldStr = str(args, 'old_string')
    const newStr = str(args, 'new_string')
    const replaceAll = args.replace_all === true
    let original: string
    try {
      original = await readFile(abs, 'utf8')
    } catch {
      return {
        output:
          `File not found: ${str(args, 'path')}. edit_file only works on existing files — ` +
          'use write_file to create one, or check the path with list_dir or glob.',
        isError: true
      }
    }

    const occurrences = original.split(oldStr).length - 1
    if (occurrences === 0) {
      return {
        output:
          `old_string not found in ${str(args, 'path')}. read_file first to get the exact current contents, then retry with more surrounding context.`,
        isError: true
      }
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        output: `old_string is not unique in ${str(args, 'path')} (${occurrences} matches). Provide more context or set replace_all.`,
        isError: true
      }
    }
    const updated = replaceAll
      ? original.split(oldStr).join(newStr)
      : original.replace(oldStr, newStr)
    await writeFile(abs, updated, 'utf8')
    return {
      output: `Applied edit to ${displayPath(ctx.workspaceRoot, abs)} (${replaceAll ? occurrences : 1} replacement${replaceAll && occurrences > 1 ? 's' : ''}).`,
      meta: { path: displayPath(ctx.workspaceRoot, abs) }
    }
  }
}

const LIST_DIR_LIMIT = 200

export const listDirTool: Tool = {
  name: 'list_dir',
  description:
    'List one directory level in the workspace (skips hidden names). Use glob for recursive file patterns, find_path before a workspace is open.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path relative to the workspace root. Defaults to root.'
      }
    },
    additionalProperties: false
  },
  summarize: (args) => `list ${String(args.path ?? '.')}`,
  async execute(args, ctx): Promise<ToolResult> {
    const rel = typeof args.path === 'string' && args.path ? args.path : '.'
    const abs = resolveInWorkspace(ctx.workspaceRoot, rel)
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return {
        output: `Directory not found: ${rel}. Check the path with glob or list_dir on the parent.`,
        isError: true
      }
    }
    const ignore = await loadIgnoreSet(ctx.workspaceRoot)
    const visible = entries
      .filter((e) => {
        if (e.name.startsWith('.')) return false
        const child = displayPath(ctx.workspaceRoot, join(abs, e.name))
        return !ignore.ignores(child)
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    const shown = visible.slice(0, LIST_DIR_LIMIT)
    const lines = await Promise.all(
      shown.map(async (e) => {
        if (e.isDirectory()) return `${e.name}/`
        try {
          const info = await stat(join(abs, e.name))
          return `${e.name} (${info.size} bytes)`
        } catch {
          return e.name
        }
      })
    )
    const skipped = entries.length - visible.length
    const extra =
      visible.length > LIST_DIR_LIMIT
        ? `\n\n[${visible.length - LIST_DIR_LIMIT} more not shown — use glob for a narrower pattern]`
        : skipped > 0
          ? `\n\n[${skipped} hidden/build entries omitted]`
          : ''
    return {
      output: (lines.length ? lines.join('\n') : '(empty directory)') + extra,
      meta: { path: displayPath(ctx.workspaceRoot, abs), count: visible.length }
    }
  }
}
