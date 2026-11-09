# Rally for Claude

Connects Claude to Rally through Rally's MCP server at
`https://mcp.rallywith.ai/mcp`, and adds two skills: `canvases`, for finding
Canvases, asking Rally to make or change their artifacts, sharing them and
keeping them tidy, and `publishing`, for publishing work made here into one.
The server serves the same two skills to any client that reads skills over
MCP.

## Install

Claude Code:

```
/plugin marketplace add juno-ai-labs/avalon
/plugin install rally@rally
```

The first tool call opens Rally in the browser: sign in, choose the
Organization, and allow access. Claude then acts as you, with exactly your
permissions in that Organization.

Claude.ai and Claude Desktop: Customize, Connectors, Add custom connector,
and enter `https://mcp.rallywith.ai/mcp`.

ChatGPT: in developer mode, add an app (connector) with the same URL and OAuth
authentication.

OpenCode: add Rally to `opencode.json`, then run `opencode mcp auth rally`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "rally": { "type": "remote", "url": "https://mcp.rallywith.ai/mcp" }
    }
  }
}
```

From any of them, ask to publish something you made there (an artifact, a
file, a page) to a Canvas, and it lands as that Canvas's artifact.

How it works is in `docs/rally-mcp.md`.
