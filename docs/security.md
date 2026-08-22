# Security notes

This project is intended to be open-sourced, so credential handling and the tool
sandbox are treated as first-class concerns.

## Secrets

- **Nothing secret is committed or hardcoded.** The only baked-in OAuth value is
  the device-flow **client ID**, which is a public identifier (the same one the
  open-source Hermes agent ships), not a secret.
- **API keys** live in `~/.ion/config.json`.
- **OAuth tokens** live in `~/.ion/auth.json`.
- Both files are written with `0600` (owner read/write only). The auth file is
  written atomically (temp file + rename) so a crash mid-refresh can't corrupt it.
- Secrets never cross to the renderer. IPC exposes only a `SafeConfig`
  (`hasApiKey: boolean`, OAuth `signedIn`/`account`), never raw tokens.

## Token lifetime

- OAuth refresh tokens are single-use and rotate on every refresh. Refreshes are
  collapsed into one in-flight operation and persisted before the new access
  token is used, so a rotating token is never spent twice.
- A `403` on the OAuth surface is treated as tier-gating: the refresh loop stops
  and the UI recommends the API-key path instead of hammering the endpoint.

## Network origins

- OIDC discovery and token endpoints are validated to be **HTTPS on `x.ai`** (or a
  `*.x.ai` subdomain) before any token is sent. See `validateXaiEndpoint`.
- Inference goes to `https://api.x.ai/v1` (configurable base URL).
- The local proxy binds to `127.0.0.1` only, rejects requests whose `Host`
  header isn't localhost (blocks DNS-rebinding from a real browser), rejects
  any request carrying an `Origin` header (browsers always send one
  cross-origin; local CLI/SDK clients don't), and caps request bodies at 25 MB.
  Residual risk: while the proxy is running, **any local process** can use your
  credentials through it - enabling it means trusting the machine it runs on.

## Tool sandbox

- File and terminal tools operate only within the workspace folder the user
  selects. Paths are checked against the workspace root twice: lexically
  (`..` traversal) and after resolving symlinks (`realpath`), so a link inside
  the workspace pointing at e.g. `~` cannot smuggle reads or writes outside it
  (`resolveInWorkspace` in `packages/agent/src/tools/paths.ts`, mirrored by the
  file-explorer IPC in `apps/desktop/src/main/workspace-fs.ts`).
- `run_terminal` runs with the workspace as its working directory, captures
  output, and enforces a timeout. Note that a shell command itself is not
  path-sandboxed - which is exactly why it is approval-gated.
- Dangerous tools (`write_file`, `edit_file`, `run_terminal`, `save_memory`,
  `open_workspace`, and all computer-use tools) require explicit in-chat
  approval by default. Settings > Permissions offers three modes: **Ask for
  approval** (everything asks), **Approve for me** (workspace file edits run
  unprompted; terminal, computer use, and memory saves still ask), and **Full
  access** (nothing asks).

## Prompt injection

Content the agent reads - web pages in the browser panel, files in a cloned
repo - can contain adversarial instructions ("indirect prompt injection").
Mitigations in place:

- `save_memory` is approval-gated: injected text cannot silently persist
  itself into the system prompt of future sessions.
- The learned-memory prompt section instructs the model to treat saved entries
  as notes, not commands, and to flag conflicts.
- The real backstop is the approval gate on every dangerous tool. For that
  reason, avoid the **Full access** permission mode when browsing or working
  with untrusted pages/repos ("Approve for me" keeps the unbounded surfaces
  gated).

## Electron hardening

- The renderer loads over a strict Content-Security-Policy.
- External links open in the system browser via a window-open handler; the app
  never navigates itself to arbitrary URLs.
- All privileged work (fs, network, tokens) happens in the main process; the
  renderer reaches it only through the typed preload bridge.

## Reporting

See [SECURITY.md](../SECURITY.md): report privately via GitHub Security
Advisories on the published repository rather than opening a public issue.
