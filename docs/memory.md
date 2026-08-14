# Self-learning memory

Ion has a closed learning loop: things the model learns in one session
improve every future session. This is prompt/memory-based learning — no
fine-tuning, no network, just markdown files on your disk.

Not to be confused with **Chat memory (context)**, the other Settings toggle,
which only controls whether earlier turns of the *current* chat are re-sent to
the model.

## The loop

1. **Store** — durable learnings live under `~/.ion/memory/`:
   - `global.md` — cross-project learnings (preferences, corrections, habits).
   - `workspaces/<sha256-prefix>.md` — one file per workspace root, starting
     with a `# Memory for <root>` line so the app can map it back.

   Entries are newest-first dated bullets (`- [2026-08-13] …`). Files are
   capped (100 entries / 8 KB); the oldest entries are pruned on write.

2. **Read** — on every turn, `AgentSession` re-reads the global file plus the
   current workspace's file and injects them into the system prompt under a
   `## Learned memory` section, along with instructions to apply them and to
   save new ones. Because the read happens fresh on each send, a learning saved
   in one window is visible to the next turn of any other session immediately.

3. **Write** — the model closes the loop itself with the `save_memory` tool
   (`{ scope: "global" | "workspace", content: string }`). It is not marked
   dangerous, so no approval prompt interrupts the flow, and it is available
   even when no workspace folder is open (workspace scope then fails with a
   clear error). The prompt instructs the model to save user preferences,
   corrections, project facts, and gotchas — and never secrets or trivia.

## Controls

- **Settings → Behavior → "Self-learning (memories)"** (default on). When off,
  nothing is injected into the prompt and the `save_memory` tool is not offered.
- **Sidebar → Memories** — inspect and edit every memory file: a card per file
  with a plain-text editor, Save, and Clear (delete). It's just markdown; edit
  it in any editor too.

## Implementation notes

- `packages/agent/src/learning.ts` — `MemoryStore` (paths, append with pruning,
  list/save/clear). Electron-free and unit-testable; the desktop app hands it
  `~/.ion/memory`.
- `packages/agent/src/tools/save-memory.ts` — the tool (`requiresWorkspace:
  false`, the flag that lets a tool be offered without an open workspace).
- `packages/agent/src/prompt.ts` — `buildMemorySection()` renders the injected
  block.
- The smoke test (`scripts/smoke-agent.ts`, `learningLoopCheck`) proves the
  loop end to end with a mock model: save via tool → new session sees it in
  its system prompt → disabled means no injection and no tool.
