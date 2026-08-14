# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting ("Report a vulnerability" under
the repository's **Security** tab) so the issue can be fixed before details
are public. Include reproduction steps and the impact you believe it has.

You should get an acknowledgement within a few days. There is no bug bounty;
credit is given in the fix's release notes unless you prefer otherwise.

## Scope notes

- Ion is a **local** desktop app: API keys and OAuth tokens live only under
  `~/.ion/` (mode `0600`) and are never sent anywhere except xAI's API.
- The threat model, tool-sandbox guarantees, and known residual risks (local
  proxy trust, prompt injection) are documented in
  [docs/security.md](docs/security.md).
