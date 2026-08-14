# Ion

**Ion** is a shareable, open-source AI **agent harness** for xAI's Grok models,
wrapped in a Cursor-style desktop app. It runs entirely on your machine and supports two ways
to authenticate:

- **xAI API key** — pay-per-token billing (`console.x.ai`).
- **SuperGrok OAuth** — sign in with your SuperGrok / X Premium+ subscription; no
  API key required. Tokens live only on your machine and refresh automatically.

The agent core, the provider/auth layer, and the optional local proxy are cleanly
separated so you can reuse or replace any piece.

> Status: early but functional. Runs from source (`npm run dev`) and packages
> into a local, ad-hoc-signed app bundle (`npm run package`). No signed/notarized
> releases are distributed yet.

## Features

- Agentic loop: plan -> stream -> call tools -> execute -> reflect, until done.
- Workspace-sandboxed tools: `read_file`, `write_file`, `edit_file`, `list_dir`,
  `glob`, `grep`, `run_terminal`. File writes and terminal commands are gated
  behind in-chat approval (with a per-session "always allow").
- **Checkpoints + change review**: every turn that edits files gets a
  multi-file diff card — restore per file or the whole turn, open hunks in
  Cursor / VS Code, or Commit with a suggested message. Chat code blocks
  have Copy + Apply. `@diff` / `@staged` attach the real git working tree.
- **Ignore + diagnostics**: `.cursorignore` / `.gitignore` / default denylist
  keep junk and secrets out of search; after edits Ion auto-runs tsc/eslint/ruff.
- **Skills**: type `/` to attach a playbook. Drop a `SKILL.md` (Cursor format)
  in `.cursor/skills/<name>/` or `~/.ion/skills/`. Grok sees a catalog and can
  `read_skill` when a description matches; `/`-attached skills land in the
  message as full instructions.
- **MCP**: same `mcp.json` as Cursor (`~/.ion/mcp.json`, `~/.cursor/mcp.json`,
  `.cursor/mcp.json`). Stdio and HTTP servers become `mcp_*` tools; they ask
  like the terminal unless `autoApprove` is set. See [docs/mcp.md](docs/mcp.md).
- Streaming responses over xAI's **Responses API** with function calling.
- Persisted, resumable **chats** stored as JSON under `~/.ion/sessions` on
  *your* machine — not in this repo, not uploaded anywhere.
- Toggleable chat memory: turn "Chat memory (context)" off in Settings and the model
  sees only your latest message — the visible transcript is kept either way.
- **Self-learning memories**: a closed learning loop — the agent saves durable
  learnings (preferences, project facts, gotchas) via a `save_memory` tool to
  `~/.ion/memory/`, and they're injected into the system prompt of every
  future session. Inspect/edit them in sidebar > Memories; toggle in Settings.
  See [docs/memory.md](docs/memory.md).
- **Browser use**: the agent drives an embedded, sandboxed browser panel inside
  the app — navigate, snapshot the page, click, type, scroll, screenshot — with a
  visible animated cursor overlay so you can watch it work. Screenshots are sent
  to Grok as real image input (grok-4 is vision-capable). Toggle in Settings
  (on by default). See [docs/computer-use.md](docs/computer-use.md).
- **Computer use (macOS)**: opt-in OS-level control — screen screenshots, smooth
  visible mouse movement with a click highlight, keyboard input — every action
  approval-gated. Off by default; needs Screen Recording + Accessibility
  permissions. See [docs/computer-use.md](docs/computer-use.md).
- **Tuned for Grok**: offers the two reasoning flagships (Grok 4.6 and 4.5)
  with a per-chat **reasoning-effort picker** (low → xhigh; xhigh is 4.6-only),
  request defaults built for tool-calling (low temperature, parallel tool
  calls), resilient 429/5xx retry with exponential backoff honoring
  `Retry-After`, a 200k-token context budget with oldest-first trimming, and
  an agentic system prompt built for Grok 4.x.
- Built-in **Kanban board** (sidebar > Board): columns and cards with drag-and-drop,
  inline add/rename/delete, and card notes — persisted to `~/.ion/board.json`.
- Workspace **file explorer** beside the chat: browse the open folder and create,
  rename, move (drag-and-drop), or delete files and folders — deletes go to the
  system Trash.
- **Context Usage panel** (ring button next to Send): see how full the model's
  context window is with a segmented breakdown (system prompt / tool definitions /
  learned memory / conversation), plus real token usage from the API — and, on an
  API key, estimated session + lifetime spend at current xAI per-token rates.
- Optional local **OpenAI-compatible proxy** so any OpenAI-style client can borrow
  your credentials (`/v1/responses`, `/v1/chat/completions`, `/v1/models`).
- A premium dark UI: liquid-glass sidebar over a live deep-space backdrop, with a clean monochrome white accent.

## Requirements

- Node.js 22+ and npm 10+
- macOS, Windows, or Linux (developed on macOS)

## Quick start

```bash
npm install
npm run dev        # launches the Electron app in dev mode
```

Then open **Customize -> Settings** and either paste an xAI API key or switch to
**SuperGrok OAuth** and sign in. Open a folder to give the agent a workspace, and
start chatting.

## Authentication

Two independent paths; the agent talks to whichever is active and never mixes them.

| | API key | SuperGrok OAuth |
|---|---|---|
| Billing | Pay-per-token | Included in your subscription |
| Setup | Paste key in Settings | Browser sign-in (device flow) |
| Stored at | `~/.ion/config.json` (0600) | `~/.ion/auth.json` (0600) |
| Refresh | n/a | Automatic, rotating refresh tokens |

See [docs/authentication.md](docs/authentication.md) for the full flow, including
the known **HTTP 403 tier-gating** caveat for some SuperGrok accounts.

## Local proxy (optional, off by default)

Expose an OpenAI-compatible endpoint backed by your active credentials:

- In the app: **Settings -> Local proxy** toggle.
- Headless: `npm run proxy` (uses `XAI_API_KEY` if set, otherwise your saved
  SuperGrok tokens).

```bash
curl http://127.0.0.1:8787/v1/models
```

The proxy injects your credentials, so it only answers requests addressed to
localhost and refuses anything sent by a browser (`Origin` header) — but any
local process can still use it while it's on. Details, examples, and the full
security model: [docs/proxy.md](docs/proxy.md).

## Project structure

```
ion/
├── apps/
│   └── desktop/          # Electron app (main + preload + React renderer)
├── packages/
│   ├── agent/            # Provider-agnostic harness: loop, tools, memory
│   ├── xai/              # Auth (API key + OAuth) + Responses API client
│   └── proxy/            # Optional local OpenAI-compatible proxy
├── docs/                 # Architecture, auth, proxy, security
└── scripts/              # No-network smoke tests
```

Architecture and data flow: [docs/architecture.md](docs/architecture.md).

## Development

```bash
npm run typecheck   # typecheck every package + the app
npm run smoke       # run the offline smoke tests (agent, xai, oauth, proxy)
npm run build       # production build of the desktop app
```

The smoke tests use mock models and fake HTTP servers, so they need no API key
and make no network calls.

## Packaging

```bash
npm run package     # builds Ion.app into apps/desktop/release/ (gitignored)
```

Bundles the app with electron-builder using **ad-hoc signing** — fine for
installing on your own machine (drag `release/mac-arm64/Ion.app` into
`/Applications`), but other people's Macs will warn on first launch until
notarized releases exist.

## Security

- No secrets are committed or hardcoded. The device-flow client ID is a public
  identifier, not a secret.
- API keys and OAuth tokens are written only under `~/.ion/` with `0600`
  permissions and never sent to the renderer.
- File tools are confined to the workspace folder you choose — checked both
  lexically and through symlinks — and every dangerous tool (writes, terminal,
  memory saves, computer use) is approval-gated.

More: [docs/security.md](docs/security.md) · report privately via
[SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
