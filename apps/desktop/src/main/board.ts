import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Board } from '../shared/ipc'
import { APP_DIR, BOARD_PATH } from './paths'

function defaultBoard(): Board {
  const now = Date.now()
  return {
    updatedAt: now,
    columns: [
      { id: randomUUID(), title: 'To Do', cards: [] },
      { id: randomUUID(), title: 'In Progress', cards: [] },
      { id: randomUUID(), title: 'Done', cards: [] }
    ]
  }
}

/**
 * File-backed Kanban board (`~/.ion/board.json`). The renderer owns the
 * board's shape and sends the whole board on each change; this just persists it.
 */
export class BoardStore {
  async get(): Promise<Board> {
    try {
      const raw = await readFile(BOARD_PATH, 'utf8')
      const parsed = JSON.parse(raw) as Board
      if (Array.isArray(parsed.columns)) return parsed
    } catch {
      // Fall through to a fresh default board.
    }
    const board = defaultBoard()
    await this.save(board)
    return board
  }

  async save(board: Board): Promise<Board> {
    const next: Board = { ...board, updatedAt: Date.now() }
    await mkdir(APP_DIR, { recursive: true })
    // Write-then-rename: a crash mid-write must not truncate the only copy.
    const tmp = `${BOARD_PATH}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
    await rename(tmp, BOARD_PATH)
    return next
  }
}
