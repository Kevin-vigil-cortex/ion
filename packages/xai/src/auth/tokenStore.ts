import { readFile, writeFile, mkdir, rm, chmod, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface StoredTokens {
  accessToken: string
  refreshToken: string
  tokenType: string
  /** Absolute expiry in epoch milliseconds. */
  expiresAt: number
  scope: string
  idToken?: string
  account?: string | null
}

export interface TokenStore {
  read(): Promise<StoredTokens | null>
  write(tokens: StoredTokens): Promise<void>
  clear(): Promise<void>
}

/**
 * File-backed token store. Writes are atomic (temp file + rename) and the file
 * is owner-only (0600) because it holds long-lived refresh tokens.
 */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  async read(): Promise<StoredTokens | null> {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as { xaiOAuth?: StoredTokens }
      return parsed.xaiOAuth ?? null
    } catch {
      return null
    }
  }

  async write(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = join(dirname(this.path), `.auth.${process.pid}.${Date.now()}.tmp`)
    const payload = JSON.stringify({ xaiOAuth: tokens }, null, 2)
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, this.path)
    await chmod(this.path, 0o600).catch(() => {})
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true })
  }
}

/** In-memory store, useful for tests. */
export class MemoryTokenStore implements TokenStore {
  private tokens: StoredTokens | null = null
  async read(): Promise<StoredTokens | null> {
    return this.tokens
  }
  async write(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens
  }
  async clear(): Promise<void> {
    this.tokens = null
  }
}
