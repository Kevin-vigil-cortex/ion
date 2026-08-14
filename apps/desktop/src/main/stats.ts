import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_DIR } from './paths'
import type { LifetimeUsage } from '../shared/ipc'

const STATS_PATH = join(APP_DIR, 'usage-stats.json')

/** Lifetime token/cost totals across all sessions, persisted under ~/.ion. */
export class UsageStatsStore {
  private totals: LifetimeUsage | null = null

  async get(): Promise<LifetimeUsage> {
    if (!this.totals) {
      try {
        const raw = await readFile(STATS_PATH, 'utf8')
        const parsed = JSON.parse(raw) as Partial<LifetimeUsage>
        this.totals = {
          inputTokens: parsed.inputTokens ?? 0,
          outputTokens: parsed.outputTokens ?? 0,
          costUsd: parsed.costUsd ?? 0
        }
      } catch {
        this.totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
      }
    }
    return this.totals
  }

  /** Fold one model call's usage into the lifetime totals (best-effort write). */
  async add(delta: { inputTokens: number; outputTokens: number; costUsd: number }): Promise<void> {
    const totals = await this.get()
    totals.inputTokens += delta.inputTokens
    totals.outputTokens += delta.outputTokens
    totals.costUsd += delta.costUsd
    try {
      await mkdir(APP_DIR, { recursive: true })
      await writeFile(STATS_PATH, JSON.stringify(totals, null, 2), 'utf8')
    } catch {
      // Stats are non-critical; never fail an agent turn over them.
    }
  }
}
