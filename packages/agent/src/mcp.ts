import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

const PROJECT_MCP_FILES = ['.mcp.json', '.ion/mcp.json', '.cursor/mcp.json']

export interface LoadMcpOptions {
  /** Override user mcp.json paths (tests). Default: ~/.cursor + ~/.ion. */
  userFiles?: string[]
}

export interface McpServerSpec {
  name: string
  source: 'user' | 'project'
  command?: string
  args: string[]
  env: Record<string, string>
  url?: string
  headers: Record<string, string>
  disabled: boolean
  autoApprove: string[]
}

export interface McpInterpContext {
  workspaceRoot: string | null
  env?: NodeJS.ProcessEnv
}

/** Home-dir mcp.json files, lowest → highest precedence. */
export function defaultUserMcpFiles(): string[] {
  const home = homedir()
  return [join(home, '.cursor', 'mcp.json'), join(home, '.ion', 'mcp.json')]
}

/**
 * Discover + merge mcp.json. Later files override the same server name —
 * project `.cursor/mcp.json` wins over user Ion/Cursor configs.
 */
export async function loadMcpConfig(
  workspaceRoot: string | null,
  options?: LoadMcpOptions
): Promise<McpServerSpec[]> {
  const ctx: McpInterpContext = { workspaceRoot }
  const byName = new Map<string, McpServerSpec>()
  for (const file of options?.userFiles ?? defaultUserMcpFiles()) {
    for (const spec of await readMcpFile(file, 'user', ctx)) byName.set(spec.name, spec)
  }
  if (workspaceRoot) {
    for (const rel of PROJECT_MCP_FILES) {
      for (const spec of await readMcpFile(join(workspaceRoot, rel), 'project', ctx)) {
        byName.set(spec.name, spec)
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function interpolateMcpString(value: string, ctx: McpInterpContext): string {
  const env = ctx.env ?? process.env
  return value
    .replaceAll('${workspaceFolder}', ctx.workspaceRoot ?? '')
    .replaceAll('${userHome}', homedir())
    .replaceAll('${pathSeparator}', sep)
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? '')
}

async function readMcpFile(
  path: string,
  source: McpServerSpec['source'],
  ctx: McpInterpContext
): Promise<McpServerSpec[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const servers = (parsed as { mcpServers?: unknown }).mcpServers
  if (!servers || typeof servers !== 'object') return []

  const out: McpServerSpec[] = []
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    const spec = parseServer(name, value, source, ctx)
    if (spec) out.push(spec)
  }
  return out
}

function parseServer(
  name: string,
  value: unknown,
  source: McpServerSpec['source'],
  ctx: McpInterpContext
): McpServerSpec | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const command = typeof raw.command === 'string' ? interpolateMcpString(raw.command, ctx) : undefined
  const url = typeof raw.url === 'string' ? interpolateMcpString(raw.url, ctx) : undefined
  if (!command && !url) return null
  return {
    name: name.trim() || 'mcp',
    source,
    command,
    args: stringList(raw.args).map((a) => interpolateMcpString(a, ctx)),
    env: stringMap(raw.env, ctx),
    url,
    headers: stringMap(raw.headers, ctx),
    disabled: raw.disabled === true,
    autoApprove: stringList(raw.autoApprove)
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

function stringMap(value: unknown, ctx: McpInterpContext): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = interpolateMcpString(v, ctx)
  }
  return out
}
