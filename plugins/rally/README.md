# Rally for Claude

Connects Claude to Rally through Rally's MCP server at
`https://mcp.rallywith.ai/mcp`, and adds a skill for working with Canvases:
finding them, asking Rally to make or change their artifacts, sharing them,
and keeping them tidy.

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

How it works is in `docs/rally-mcp.md`.
