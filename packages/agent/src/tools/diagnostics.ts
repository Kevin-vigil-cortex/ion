import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool, ToolContext, ToolResult } from './types'
import { resolveUserPath } from './shell-env'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 16 * 1024
const TIMEOUT_MS = 45_000

export interface DiagnosticsReport {
  output: string
  hasErrors: boolean
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function localBin(root: string, name: string): Promise<string | null> {
  const candidate = join(root, 'node_modules', '.bin', name)
  return (await exists(candidate)) ? candidate : null
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<{ code: number; text: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      signal,
      env: { ...process.env, PATH: resolveUserPath() }
    })
    return { code: 0, text: `${stdout}${stderr}` }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string }
    if (e.code === 'ENOENT') return { code: 127, text: `${cmd} not found` }
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message || String(err)
    const code = typeof e.code === 'number' ? e.code : 1
    return { code, text }
  }
}

function clip(text: string): string {
  const t = text.trimEnd()
  if (t.length <= MAX_OUTPUT) return t
  return t.slice(0, MAX_OUTPUT) + `\n\n[truncated — ${t.length} chars]`
}

/**
 * Run whatever linters/typecheckers the repo actually has, scoped to `paths`
 * when the tool supports it. Empty paths = whole project.
 */
export async function collectDiagnostics(
  workspaceRoot: string,
  paths: string[] = [],
  signal?: AbortSignal
): Promise<DiagnosticsReport> {
  const sections: string[] = []
  let hasErrors = false
  let ran = 0

  const tsconfig = await exists(join(workspaceRoot, 'tsconfig.json'))
  const tsc = tsconfig ? await localBin(workspaceRoot, 'tsc') : null
  if (tsc) {
    ran++
    const res = await run(tsc, ['--noEmit', '--pretty', 'false'], workspaceRoot, signal)
    if (res.code !== 0) hasErrors = true
    sections.push(`### tsc (exit ${res.code})\n\n${clip(res.text) || '(clean)'}`)
  }

  const eslintBin = await localBin(workspaceRoot, 'eslint')
  const hasEslintConfig =
    (await exists(join(workspaceRoot, 'eslint.config.js'))) ||
    (await exists(join(workspaceRoot, 'eslint.config.mjs'))) ||
    (await exists(join(workspaceRoot, 'eslint.config.cjs'))) ||
    (await exists(join(workspaceRoot, '.eslintrc'))) ||
    (await exists(join(workspaceRoot, '.eslintrc.js'))) ||
    (await exists(join(workspaceRoot, '.eslintrc.cjs'))) ||
    (await exists(join(workspaceRoot, '.eslintrc.json')))
  if (eslintBin && hasEslintConfig) {
    ran++
    const targets = paths.length ? paths : ['.']
    const res = await run(eslintBin, ['--max-warnings', '0', ...targets], workspaceRoot, signal)
    if (res.code !== 0) hasErrors = true
    sections.push(`### eslint (exit ${res.code})\n\n${clip(res.text) || '(clean)'}`)
  }

  const py = paths.filter((p) => p.endsWith('.py'))
  if (py.length > 0 || (await exists(join(workspaceRoot, 'pyproject.toml')))) {
    const ruff = await localBin(workspaceRoot, 'ruff')
    if (ruff) {
      ran++
      const res = await run(ruff, ['check', ...(py.length ? py : ['.'])], workspaceRoot, signal)
      if (res.code !== 0) hasErrors = true
      sections.push(`### ruff (exit ${res.code})\n\n${clip(res.text) || '(clean)'}`)
    }
  }

  if (ran === 0) {
    return {
      output:
        'No local diagnostics runner found (tsc / eslint / ruff in node_modules/.bin). ' +
        'Install the project deps, or use run_terminal if you know the command.',
      hasErrors: false
    }
  }
  return {
    output: hasErrors
      ? `Diagnostics reported problems. Fix them before claiming the task is done.\n\n${sections.join('\n\n')}`
      : `Diagnostics are clean.\n\n${sections.join('\n\n')}`,
    hasErrors
  }
}

export const getDiagnosticsTool: Tool = {
  name: 'get_diagnostics',
  description:
    'Run the workspace typechecker / linter (tsc, eslint, ruff — whichever is installed locally) ' +
    'and return the errors. After edits, call this (or wait — Ion also auto-runs it) and fix what it reports.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative files to focus eslint/ruff on. tsc is always project-wide.'
      }
    },
    additionalProperties: false
  },
  summarize: (args) => {
    const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === 'string') : []
    return paths.length ? `diagnostics ${paths.join(' ')}` : 'diagnostics'
  },
  async execute(args, ctx): Promise<ToolResult> {
    const paths = Array.isArray(args.paths)
      ? args.paths.filter((p): p is string => typeof p === 'string')
      : []
    const report = await collectDiagnostics(ctx.workspaceRoot, paths, ctx.signal)
    return { output: report.output, isError: report.hasErrors, meta: { hasErrors: report.hasErrors } }
  }
}
