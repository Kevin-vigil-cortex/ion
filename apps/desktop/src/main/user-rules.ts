import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { APP_DIR, USER_RULES_PATH } from './paths'

/** Personal rules shown in Settings and injected into every system prompt. */
export async function readUserRules(): Promise<string> {
  try {
    return await readFile(USER_RULES_PATH, 'utf8')
  } catch {
    return ''
  }
}

export async function writeUserRules(text: string): Promise<void> {
  await mkdir(APP_DIR, { recursive: true })
  await writeFile(USER_RULES_PATH, text, 'utf8')
  await chmod(USER_RULES_PATH, 0o600).catch(() => {})
}
