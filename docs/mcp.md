# MCP

Ion reads the same `mcp.json` files Cursor does and offers those tools to Grok.
MCP calls use the **same approval story as the terminal** — they ask in Ask /
Approve-for-me, and run unprompted only in Full access (or when the server
lists the tool in `autoApprove`).

## Where to put the file

Later files override the same server name.

| Scope | Paths |
|---|---|
| User | `~/.cursor/mcp.json`, then `~/.ion/mcp.json` |
| Project | `.mcp.json`, `.ion/mcp.json`, `.cursor/mcp.json` |

Project `.cursor/mcp.json` wins on a name clash — **once the workspace is
trusted**.

Project files are trust-gated: a repo's own `mcp.json` is arbitrary code, so
opening a folder never starts its servers. They appear as **Blocked** in
Settings → MCP until you click **Trust workspace** (stored under
`trustedMcpRoots` in `~/.ion/config.json`; remove the entry to revoke). Until
then a project file cannot start anything, override a user server's name, or
apply its `autoApprove` list. User-scope files always work.

## Shape

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_TOKEN}"
      }
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:DOCS_TOKEN}"
      },
      "autoApprove": ["search"]
    }
  }
}
```

- **stdio:** `command` + `args` + optional `env`
- **HTTP:** `url` + optional `headers` (streamable HTTP / JSON-RPC POST)
- `disabled: true` skips a server without deleting it
- `autoApprove` is a list of tool names (or `"*"`) that skip the prompt

Interpolation: `${env:NAME}`, `${workspaceFolder}`, `${userHome}`, `${pathSeparator}`.

## In the app

Settings → MCP lists each server (idle / connected / error / blocked).
**Reload** starts or restarts them. The first chat in a folder also connects.
Tools show up as `mcp_<server>_<tool>`.

Plan mode drops dangerous MCP tools and keeps auto-approved ones.
