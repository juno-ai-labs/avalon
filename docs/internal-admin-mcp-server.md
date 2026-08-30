# Connecting to the internal admin MCP server

Rally engineering can inspect and deliberately repair the authoritative SQLite
database inside a production workspace, work stream, or substream Durable
Object through the remote MCP endpoint:

```text
https://mcp.internal.rallywith.ai/mcp
```

This is a production administration surface. Its SQL tools can change or delete
data. Connect only from an approved engineering account, inspect the target
before running SQL, and treat every SQL call as production database access.

The server architecture, regional routing, and audit boundary are documented in
[`engineering-mcp.md`](engineering-mcp.md). This document is the operator guide
for connecting an MCP client and making a first safe query.

## Access and authentication

The endpoint is protected by its own Cloudflare Access application. Deployment
copies the identity providers and admission policies from Ace, so sign in with
the same company identity provider and account that you use for
`ace.internal.rallywith.ai`. The MCP application has a separate Access audience:
an Ace token cannot be reused directly.

Cloudflare Access performs the OAuth authorization-code flow and Dynamic Client
Registration. The installed clients below discover that flow from the endpoint,
open a browser for company sign-in, and retain their own OAuth credentials. Do
not create a Cloudflare service token, copy a browser cookie, or put a bearer
token in an MCP configuration file.

The production endpoint becomes available only after a full Global-and-EU API
deployment of a revision containing the engineering MCP. Check the unauthenticated
challenge without sending credentials:

```bash
curl --silent --show-error --dump-header - --output /dev/null \
  --header 'Accept: application/json' \
  https://mcp.internal.rallywith.ai/mcp
```

A ready endpoint returns `401` and a `WWW-Authenticate` header containing
`resource_metadata`. A `404`, DNS error, or ordinary Access `302` means the MCP
deployment or Managed OAuth boundary is not ready; inspect the full API
deployment workflow before debugging a client.

## Codex

Add and authenticate the server from a terminal:

```bash
codex mcp add rally-engineering \
  --url https://mcp.internal.rallywith.ai/mcp
codex mcp login rally-engineering
codex mcp list
```

Complete the company login in the browser opened by `codex mcp login`. Codex
stores the server in `~/.codex/config.toml`; the Codex CLI, Codex desktop app,
and Codex IDE extension on the same host share that configuration. Restart an
already-open app or IDE extension after adding the server, then use `/mcp` to
confirm that it is connected.

The equivalent configuration is:

```toml
[mcp_servers.rally-engineering]
url = "https://mcp.internal.rallywith.ai/mcp"
default_tools_approval_mode = "writes"
```

`writes` preserves an approval prompt for the SQL tools while allowing the
read-only inventory tools without a write prompt. Use `prompt` instead if every
tool invocation should require confirmation.

To clear the OAuth grant or remove the configuration:

```bash
codex mcp logout rally-engineering
codex mcp remove rally-engineering
```

See the current [Codex MCP documentation](https://developers.openai.com/codex/mcp/)
for client-wide configuration and OAuth behavior.

## Claude Code

Install the server at user scope so it is available across repositories:

```bash
claude mcp add --transport http --scope user \
  rally-engineering https://mcp.internal.rallywith.ai/mcp
claude mcp login rally-engineering
claude mcp list
```

If the installed Claude Code version does not have `claude mcp login`, start
Claude Code, run `/mcp`, select `rally-engineering`, and choose **Authenticate**.
Complete the company login in the browser. `/mcp` then shows the connection and
the available tool count.

To clear or remove it:

```bash
claude mcp logout rally-engineering
claude mcp remove --scope user rally-engineering
```

See the current [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
for scopes, OAuth credential handling, and the `/mcp` status panel.

## Cursor Desktop

Create or merge this entry into `~/.cursor/mcp.json` for a personal,
cross-project connection:

```json
{
  "mcpServers": {
    "rally-engineering": {
      "url": "https://mcp.internal.rallywith.ai/mcp"
    }
  }
}
```

Restart Cursor, open **Customize**, find `rally-engineering`, and complete the
OAuth sign-in. Cursor Desktop uses a localhost callback, which the Rally Access
application admits through Dynamic Client Registration. Confirm the six tools
appear under the server before making a query.

Project configuration at `.cursor/mcp.json` also works, but do not commit OAuth
credentials or static authorization headers. The endpoint URL is not a secret;
the Cloudflare Access grant is.

See the current [Cursor MCP documentation](https://cursor.com/docs/mcp) for
configuration locations, OAuth, approvals, and MCP logs.

## Hosted clients

The instructions above cover installed Codex clients, Claude Code, and Cursor
Desktop. Hosted clients use HTTPS callbacks rather than a loopback callback and
are not admitted automatically:

- ChatGPT web uses a published plugin rather than the local Codex MCP
  configuration.
- A Claude.ai custom connector needs its exact HTTPS OAuth callback added to the
  Access application's Managed OAuth redirect allowlist.
- Cursor web and Cloud Agents use
  `https://www.cursor.com/agents/mcp/oauth/callback`, which likewise needs an
  explicit Access allowlist entry.

An Access administrator must review and add a hosted callback before that
surface is used. Do not broaden the redirect allowlist or add a wildcard merely
to make a client connect. Cloudflare documents the distinction in its
[Managed OAuth settings](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

## First safe inspection

Begin with inventory. Do not guess a region or Durable Object name:

1. Call `list_workspaces` and select the exact `workspaceId`.
2. Call `list_workstreams` with that `workspaceId` and select the exact
   `workstreamId`.
3. Call `list_substreams` with that `workstreamId`. Its response includes the
   full workspace, work-stream, and substream ID tuple required by
   `run_substream_sql`.
4. Inspect the schema before querying application rows.

A safe first workspace query is:

```sql
SELECT name, type
FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type, name;
```

For example, ask the client:

```text
Use rally-engineering to list workspaces. Do not run SQL yet.
```

Then, after selecting a returned workspace ID:

```text
Run run_workspace_sql for workspace <workspace-id> with this read-only SQL:
SELECT name, type FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type, name;
```

Use `?` placeholders and the `bindings` array for values instead of assembling
quoted values into SQL. Bindings may be strings, finite numbers, or `null`.

## Tool reference

| Tool | Required identity | Effect |
| --- | --- | --- |
| `list_workspaces` | None | Lists workspace identity records across Global and EU. |
| `list_workstreams` | `workspaceId` | Reads the authoritative WorkspaceDO work-stream directory. |
| `list_substreams` | `workstreamId` | Lists main substream `0` and child substreams from WorkstreamDO. |
| `run_workspace_sql` | `workspaceId`, `sql`, optional `bindings` | Runs arbitrary SQLite in WorkspaceDO. |
| `run_workstream_sql` | `workstreamId`, `sql`, optional `bindings` | Runs arbitrary SQLite in WorkstreamDO. |
| `run_substream_sql` | `workspaceId`, `workstreamId`, `substreamId`, `sql`, optional `bindings` | Runs arbitrary SQLite in SubstreamAgent. |

SQL results include `columns`, JSON-safe `rows`, `rowsRead`, and `rowsWritten`.
BLOB values are returned as `{ "type": "blob", "base64": "..." }`.
`rowsWritten` is Cloudflare's physical SQLite write count, including index
maintenance; it is not a domain-level count of changed records.

## Production safety

- Prefer `SELECT`, `PRAGMA table_info(...)`, and explicit schema inspection
  until a repair is agreed.
- Re-list the target hierarchy immediately before a mutation. IDs, not names,
  determine the Durable Object.
- State the proposed SQL and expected affected domain records before approving
  a write. Use a transaction when multiple statements must succeed together.
- Do not paste customer content returned by a query into logs, issues, pull
  requests, or chat transcripts. EU results remain customer content even though
  this operator path can return them to an authorized engineer.
- The server intentionally has no repository-defined row, statement, or query
  timeout. Add a narrow predicate before selecting a potentially large product
  table.
- The server audits the Access actor, tool, target IDs, and success or failure,
  but deliberately does not log SQL text, bindings, result rows, or SQLite error
  messages.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser login never opens | Run the client's explicit login command or its MCP **Authenticate** action. Confirm the endpoint returns the OAuth `401` challenge above. |
| Access denies the login | Confirm the same company identity is admitted to Ace. The MCP copies Ace's policy but has a separate application and token audience. |
| Redirect URI is rejected | Installed clients must use `localhost` or `127.0.0.1`. A hosted HTTPS callback must be explicitly added to the Access Managed OAuth allowlist. |
| Client remains disconnected after login | Restart or reconnect the client, then inspect `codex mcp list`, Claude Code `/mcp`, or Cursor's **MCP Logs** output. |
| No tools appear | Confirm the configured URL ends in `/mcp`, not merely the hostname. |
| Target is not found | Re-run the list tools from the workspace downward and use the returned IDs. A missing routing record is refused rather than creating an empty object. |
| Target exists in both regions | Stop. The server refuses ambiguous identity by design; repair regional routing before inspecting either object. |
| SQL fails without useful server logs | Read the error returned to the authenticated client. Query text and SQLite errors are intentionally excluded from Worker logs. |
