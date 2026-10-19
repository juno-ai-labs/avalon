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
application admits through Dynamic Client Registration. Confirm the tools
appear under the server before making a query.

Project configuration at `.cursor/mcp.json` also works, but do not commit OAuth
credentials or static authorization headers. The endpoint URL is not a secret;
the Cloudflare Access grant is.

See the current [Cursor MCP documentation](https://cursor.com/docs/mcp) for
configuration locations, OAuth, approvals, and MCP logs.

## Hosted clients

Claude Code on the web, ChatGPT/Codex hosted surfaces, and Cursor web or Cloud
Agents complete OAuth through HTTPS callbacks owned by their service. The Rally
Access application admits hosted callbacks anywhere under these provider
origins:

- `https://claude.ai/*`
- `https://chatgpt.com/*`
- `https://cursor.com/*`
- `https://www.cursor.com/*`

The MCP transport also admits request `Origin` headers from those four provider
hosts. An authorization success followed by “no MCP server was found” usually
means a new hosted provider was added to OAuth but not to this shared registry.

Add `https://mcp.internal.rallywith.ai/mcp` in the hosted client's connector
settings and choose its normal sign-in action. Dynamic Client Registration
creates the client automatically; do not enter a static OAuth Client ID. The
Cloudflare Access login still requires an engineering identity admitted by the
Ace-derived policy.

Cloudflare supports a trailing `/*` for all paths on a specific HTTPS origin,
but does not document an allow-any-HTTPS-origin setting. Supporting another
hosted provider therefore requires adding its provider origin to the deployment
provisioner. See Cloudflare's
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

For a live web artifact, start from `list_artifacts` with the `workspaceId`.
`run_artifact_sql` opens the supervisor, which holds `artifact_state` (the
current version), `viewer_sessions`, and `error_log` — the last being what a
broken artifact page is usually diagnosed from. A stateful artifact's *own*
tables are in a separate facet database this tool does not reach; use the
product's Data view for those.

For a Sidekick, start from `list_sidekicks` with the `workspaceId` instead. Its
definition revisions, schedules and run history are in the Organization
object: `run_workspace_sql` over the `sidekick_*` tables, filtered by
`sidekick_id`. The same ID passed to `list_substreams` and `run_substream_sql`
as the `workstreamId` opens its conversation, because a Sidekick is a
conversation parent like a work stream.

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
| `list_workspaces` | None | Lists workspace identity records across configured deployments. |
| `list_orgs` | Optional `orderBy`, `direction`, `limit`, `page` | Lists every Organization across regions, newest first unless ordered otherwise, abandoned ones included, with plan, creation time, active member count, and last seen. |
| `search_orgs` | Optional `query`, `plan`, `abandoned`, `createdAfter`, `createdBefore`, plus the ordering and paging inputs | Same rows as `list_orgs`, narrowed by every filter given; abandoned Organizations are left out unless `abandoned` is `include` or `only`. |
| `list_users` | Optional `orderBy`, `direction`, `limit`, `page` | Lists every user across regions, newest first unless ordered otherwise, each with every Organization they belong to: role, guest or member, status, and last seen. |
| `search_users` | Optional `query`, `createdAfter`, `createdBefore`, plus the ordering and paging inputs | Same rows as `list_users`, narrowed to names, emails or IDs containing `query` and to the creation window. |
| `list_workstreams` | `workspaceId` | Reads the authoritative WorkspaceDO work-stream directory. |
| `list_substreams` | `workstreamId` | Lists main substream `0` and child substreams from the Channel's hosted parent in WorkspaceDO. |
| `list_sidekicks` | `workspaceId` | Reads the authoritative WorkspaceDO Sidekick directory, in every lifecycle including deleted. |
| `list_spaces` | `workspaceId` | Lists the Organization's Spaces, archived ones included. Answers an empty list until a product path creates a Space. |
| `list_artifacts` | `workspaceId` | Reads the authoritative WorkspaceDO live web artifact registry. |
| `run_workspace_sql` | `workspaceId`, `sql`, optional `bindings` | Runs arbitrary SQLite in WorkspaceDO, including a Channel's or Space's parent state in the `parent_*` tables. |
| `run_substream_sql` | `workspaceId`, `workstreamId`, `substreamId`, `sql`, optional `bindings` | Runs arbitrary SQLite in SubstreamAgent. |
| `run_artifact_sql` | `workspaceId`, `artifactId`, `sql`, optional `bindings` | Runs arbitrary SQLite in ArtifactHostDO — the artifact's supervisor, not its facet. |
| `list_feature_flags` | None | Lists Ace's managed product flags with their live Flagship definitions. |
| `update_feature_flag` | `key`, `description`, `enabled`, `default_variation`, `rules` | Replaces a managed product flag's whole definition through Ace and notifies connected clients. |
| `list_model_flags` | None | Lists each agent role's model flag with its default and live route. |
| `update_model_flag` | `role`, `routing` | Replaces an agent role's default route plan through Ace after checking each model id on OpenRouter. |
| `query_data_lake` | `lakehouse`, `sql` | Runs read-only Basin SQL against `llm_inference`, `analytics_events`, or `usage_events`. |
| `query_worker_observability` | `view`, `from`, optional `to`, `filters`, `needle`, `calculations`, `groupBys`, `limit`, `offset` | Queries Workers Logs and Traces for every Worker on the account, as the dashboard's Query Builder does. |

SQL results include `columns`, JSON-safe `rows`, `rowsRead`, and `rowsWritten`.
BLOB values are returned as `{ "type": "blob", "base64": "..." }`.
`rowsWritten` is Cloudflare's physical SQLite write count, including index
maintenance; it is not a domain-level count of changed records.

- Prefer `SELECT`, `PRAGMA table_info(...)`, and explicit schema inspection
  until a repair is agreed.

- Re-list the target hierarchy immediately before a mutation. IDs, not names,
  determine the Durable Object.

- State the proposed SQL and expected affected domain records before approving
  a write. Use a transaction when multiple statements must succeed together.

- The server intentionally has no repository-defined row, statement, or query
  timeout. Add a narrow predicate before selecting a potentially large product
  table.

- Read a flag with `list_feature_flags` before `update_feature_flag`, and send
  every rule back. The update replaces the whole definition, so a rule left out
  is deleted for everyone it reached.

- Follow `query_data_lake`'s tool description on scan cost and raw content.

- Narrow `query_worker_observability` to one Worker with a
  `$metadata.service` filter, and read one trace by querying the `events` view
  filtered on `$metadata.traceId`.

- The server audits the Access actor, tool, target IDs, and success or failure,
  but deliberately does not log SQL text, bindings, result rows, or SQLite error
  messages.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser login never opens | Run the client's explicit login command or its MCP **Authenticate** action. Confirm the endpoint returns the OAuth `401` challenge above. |
| Access denies the login | Confirm the same company identity is admitted to Ace. The MCP copies Ace's policy but has a separate application and token audience. |
| Connector registration fails before login | Confirm the hosted client redirects through one of the documented provider origins. New hosted-provider origins must be added to the Access Managed OAuth allowlist and deployed. |
| Client remains disconnected after login | Restart or reconnect the client, then inspect `codex mcp list`, Claude Code `/mcp`, or Cursor's **MCP Logs** output. |
| No tools appear | Confirm the configured URL ends in `/mcp`, not merely the hostname. |
| Target is not found | Re-run the list tools from the workspace downward and use the returned IDs. A missing routing record is refused rather than creating an empty object. |
| Target exists in configured deployments | Stop. The server refuses ambiguous identity by design; repair regional routing before inspecting either object. |
| SQL fails without useful server logs | Read the error returned to the authenticated client. Query text and SQLite errors are intentionally excluded from Worker logs. |
