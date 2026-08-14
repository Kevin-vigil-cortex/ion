import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Everything the app persists lives under ~/.ion for easy discovery. */
export const APP_DIR = join(homedir(), '.ion')

// One-time migration: the app used to be called Grok Harness. If a legacy data
// dir exists and the new one doesn't, adopt it wholesale (same volume rename).
const LEGACY_DIR = join(homedir(), '.grok-harness')
if (!existsSync(APP_DIR) && existsSync(LEGACY_DIR)) {
  try {
    renameSync(LEGACY_DIR, APP_DIR)
  } catch {
    // Non-fatal: start fresh under APP_DIR; the legacy dir is left untouched.
  }
}

export const CONFIG_PATH = join(APP_DIR, 'config.json')
export const AUTH_PATH = join(APP_DIR, 'auth.json')
export const SESSIONS_DIR = join(APP_DIR, 'sessions')
export const BOARD_PATH = join(APP_DIR, 'board.json')
export const SCREENSHOTS_DIR = join(APP_DIR, 'screenshots')
export const MEMORY_DIR = join(APP_DIR, 'memory')
export const ATTACHMENTS_DIR = join(APP_DIR, 'attachments')
export const USER_RULES_PATH = join(APP_DIR, 'user-rules.md')
