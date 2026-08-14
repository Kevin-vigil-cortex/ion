import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConversationItem } from './types'

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  workspaceRoot: string | null
  model: string
  /** Reasoning depth for models that support it; absent = provider default. */
  reasoningEffort?: string
  /** 'plan' = read-only planning mode; absent or 'agent' = normal. */
  mode?: string
}

/** Cumulative provider-reported token usage for one session. */
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  /** Estimated cost in USD; only meaningful for API-key billing. */
  costUsd: number
}

export interface Session extends SessionMeta {
  items: ConversationItem[]
  /** Cumulative usage across all turns; absent for sessions predating tracking. */
  usage?: SessionUsage
}

/**
 * File-backed conversation store. One JSON file per session under `dir`.
 * The directory is injected by the host (the desktop app passes its userData
 * path) so the agent core stays free of Electron.
 */
export class SessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  async create(params: {
    workspaceRoot: string | null
    model: string
    title?: string
    reasoningEffort?: string
    mode?: string
  }): Promise<Session> {
    const now = Date.now()
    const session: Session = {
      id: randomUUID(),
      title: params.title ?? 'New Chat',
      createdAt: now,
      updatedAt: now,
      workspaceRoot: params.workspaceRoot,
      model: params.model,
      ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
      ...(params.mode ? { mode: params.mode } : {}),
      items: []
    }
    await this.save(session)
    return session
  }

  async save(session: Session): Promise<void> {
    await this.ensureDir()
    session.updatedAt = Date.now()
    // Screenshots (`images` on tool results) are transient model input only:
    // stripping them here keeps base64 payloads out of the on-disk JSON while
    // the in-memory session keeps them for the next model call(s).
    const json = JSON.stringify(
      session,
      (key, value) =>
        key === 'images' || key === 'base64' ? undefined : (value as unknown),
      2
    )
    await writeFile(this.file(session.id), json, 'utf8')
  }

  async load(id: string): Promise<Session | null> {
    try {
      const raw = await readFile(this.file(id), 'utf8')
      return JSON.parse(raw) as Session
    } catch {
      return null
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true })
  }

  async list(): Promise<SessionMeta[]> {
    await this.ensureDir()
    const files = await readdir(this.dir)
    const metas: SessionMeta[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await readFile(join(this.dir, f), 'utf8')
        const s = JSON.parse(raw) as Session
        metas.push({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          workspaceRoot: s.workspaceRoot,
          model: s.model,
          ...(s.reasoningEffort ? { reasoningEffort: s.reasoningEffort } : {}),
          ...(s.mode ? { mode: s.mode } : {})
        })
      } catch {
        // Skip corrupt files rather than failing the whole listing.
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt)
  }
}

/** Derive a concise session title from the first user message. */
export function deriveTitle(text: string, fallback?: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const source = clean || fallback?.trim() || ''
  if (!source) return 'New Chat'
  if (source.length <= 48) return source
  return source.slice(0, 47).trimEnd() + '…'
}
