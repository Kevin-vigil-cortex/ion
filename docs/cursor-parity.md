# Ion vs Cursor - what to steal

Ion exists because people want the **Cursor experience** on a **SuperGrok
subscription**. Cursor is two products glued together: a VS Code fork (Tab,
Cmd+K, live in-buffer diffs) and an **agent harness** (modes, @, rules, queue,
checkpoints, MCP). Ion should be a great harness and a great “open this in
my editor,” not a fake IDE.

Last reviewed: 2026-08-14.

## Already in Ion

| Cursor thing | Ion today |
|---|---|
| Agent loop (search / edit / terminal) | Yes - sandboxed tools + approval |
| Ask / Plan (read-only) | Plan mode |
| Run modes (ask / allowlist / yolo) | ask / auto / full |
| Queue while working | Enter queues a follow-up |
| Image / file paste | Drop, paste, paperclip |
| Context ring | Context Usage panel |
| Folder = project | Open folder + explorer |
| Embedded browser | Browser panel + computer use |
| Chat (sessions, queue, steer) | Yes - stored only on the user's machine (`~/.ion/sessions`) |
| Tool rows → inspector | Right column |
| Stop | Stop button + abort |
| Project instructions + user rules | `AGENTS.md` / `.cursor/rules` + `~/.ion/user-rules.md` |
| `@` mentions | `@file` / `@folder` / `@diff` / `@staged` |
| Checkpoints + diffs | Restore / Apply / open in editor / Commit |
| Skills | `/` palette + `read_skill` |
| MCP | project + user `mcp.json`, same approval as shell |
| Ignore + diagnostics | `.cursorignore` / secrets blocked; auto tsc/eslint/ruff |
| Code review | `code_review` - CodeRabbit CLI on the workspace diff |

## Steal later (wow, not table stakes)

- Side chats (child thread with parent as hidden context)
- Conversation search across past Ion chats
- Debug Mode (inject logs → you reproduce → read a debug ingest)
- Worktrees + `/best-of-n`
- Hooks (`beforeShell`, `afterEdit`)
- Browser subagent + persistent cookies + log-to-file
- Canvases (React artifact beside chat)
- `ion://` deeplinks
- Explore subagent (fast model, many parallel searches, summary only)

## Do not fake

- **Tab** / jump-in-file / cross-file portals - needs an editor + LSP
- **Cmd+K inline edit** - that *is* the editor
- Design Mode (click the running UI → edit the component)
- Cloud Agents, Bugbot-as-a-service, Cursor Blame
- Seatbelt/Landlock “Auto-review” unless we actually sandbox

Honest product line: *Ion is the Grok harness. Cursor (or VS Code, or Xcode)
stays the editor.* Offer “Open in editor” on every hunk.

## Why SuperGrok users bounce off Cursor

They already pay xAI. Cursor’s value is the harness (rules, @, queue, live
edits, review), not the model picker. If Ion loads the repo’s `AGENTS.md`,
lets them `@` a file, and lets them steer mid-turn, it *is* Cursor for
Grok - without a second subscription.
