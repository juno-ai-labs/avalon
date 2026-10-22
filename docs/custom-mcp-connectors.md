# Custom MCP connectors

A custom MCP connector is a Model Context Protocol server that somebody in a
workspace pointed Rally at, rather than one Rally ships a declaration for. One
connector type, `custom_mcp`, backs every such server: each connection carries
its own endpoint, its own credential, and — for a workspace connection — its own
policy about how much of that server's catalog Rally may call.

Read this before changing how a configured server is added, authorized, or
narrowed. The transport, OAuth helpers, live discovery, and exact call
forwarding underneath it are the shared hosted-MCP module described in
[`hosted-mcp-connectors.md`](hosted-mcp-connectors.md); the tenancy, credential,
and connection rules it inherits are in [`connectors.md`](connectors.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/lib/connector-plugin-views.ts` | Name-derived model IDs and compatibility aliases over unchanged credential identities. |
| `packages/connectors/src/custom-mcp.ts` | The adapter: per-connection endpoint resolution, header and OAuth authentication, the tool-policy filter, and the person-facing tool inventory. |
| `packages/connectors/src/hosted-mcp.ts` | The shared MCP transport, OAuth discovery/DCR/PKCE, and the `selectTools` narrowing hook this connector supplies. |
| `packages/contracts/src/index.ts` | `CustomMcpConnectionConfigSchema`, `CustomMcpRequestHeadersSchema`, the two request contracts, the settings response, and the header limits. |
| `apps/api/src/services/connection-service.ts` | `createCustomMcp`, `beginCustomMcp`, `getCustomMcpSettings`, `updateCustomMcpToolPolicy`, and the custom-MCP branches of `completeProvider` and `reconnect`. |
| `apps/api/src/routes/connections.ts` | `POST /connections/custom-mcp`, `POST /connections/custom-mcp/start`, `GET /connections/:id/custom-mcp/tools`, `PUT /connections/:id/custom-mcp/tool-policy`, and the OAuth callback. |
| `apps/api/src/lib/connector-registry.ts` | `customMcpConnectorConfig` — the callback URI, which is all this connector needs to be available in a region. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | The provider card, the connect dialog, and the **MCP tools** part of each server's own connection page. |

### Adding a server

A person supplies a name, an HTTPS endpoint, and one of two ways to
authenticate. Both paths refuse anything but HTTPS and reject a URL carrying
embedded credentials, and both normalize the endpoint once, at the entry, so the
string a reconnect is matched against is the string the adapter dials.

- **Request headers.** The header names and values are stored as the
  connection's credential — encrypted at rest, bound to the connection, never
  returned to a client — and replayed on every MCP request.
- **OAuth.** The endpoint travels through Rally's sealed OAuth state to the
  shared hosted-MCP authorization: protected-resource discovery, dynamic client
  registration as `Rally`, authorization code with PKCE, and refresh. Nothing is
  written until the callback returns, so an abandoned authorization leaves no
  half-made connection, and the callback cannot be pointed at a server other
  than the one whose consent screen the person saw.

**Both paths prove the server before reporting success**, through the adapter's
own health check — the same discovery an activation runs, so the connection's
tool policy, the model-facing name normalization, the schema bounds, and the
collision checks all decide it. A connection whose only symptom is a plugin that
fails to load inside somebody's run three days later is the failure this avoids,
and counting the raw catalog instead would let one through: a server whose every
tool a `read_only_tools` connection filters out is not empty, it is unusable.

What an unusable server costs differs by path, deliberately. A header connection
is deleted again — nothing else happened, and there is no grant to keep. An
authorized one is kept and marked `error` with the reason, because the person
completed a consent screen and Rally holds a real credential; the authorization
attempt still fails, so the browser handoff says so and the connection is theirs
to reconnect or remove.

A workspace connection is an administrator's to make, as every workspace
connection is. A personal one is any member's.

### Which server a connection talks to

The endpoint lives in `config_json` rather than beside the credential, because
discovery, execution, and the connections screen all need it and a value only
the decryption path could see would leave a row unable to say where it points.
`createHostedMcpPassthrough` takes a resolver rather than a fixed URL for this
connector, so one adapter serves every configured server.

### Tools

Nothing about a server's catalog is written into Rally. `tools/list` is read at
activation, exactly as it is for Granola, Slack, and Notion, and the model sees
the server's own names, descriptions, and schemas under Rally's normal
execution and receipt policy. A server may add, change, or withdraw a tool
without a Rally release.

A **workspace** connection additionally carries a tool policy:

- `all_tools` — every tool the server advertises.
- `read_only_tools` — only the tools the server itself annotates
  `readOnlyHint: true`. An absent annotation is a write, because most servers
  annotate nothing at all and treating silence as read-only would admit every
  one of them.

The policy is applied at discovery *and* again to the fresh catalog read before
every `tools/call`, so a tool it withholds is unreachable rather than merely
unadvertised — an activation taken while the connection allowed everything
cannot spend a write after the policy narrowed.

A personal connection has no such control and stores `all_tools` whatever a
request asks for. That is not a statement that personal connections are trusted
more: a personal connection acts with its owner's own identity on that server
and is usable by nobody else, so it exposes exactly what that person can already
do. The policy exists because a workspace connection hands one credential to
every member.

### Looking at what a server offers

`GET /connections/:id/custom-mcp/tools` reads the same live catalog an
activation reads and returns, per tool, the server's `readOnlyHint` and
`destructiveHint` and whether the current policy admits it. Each connected
server has its own page under Connections in Settings, and its **MCP tools**
section renders the catalog beside the endpoint, the authentication mode, and
the policy control. A tool the policy withholds stays listed and marked, so a person
can see what is being held back rather than watching it disappear.

That read is also a discovery, so it stores the number of tools the policy
admits as the connection's tool count before answering; a policy save reads the
catalog back through the same path, which is how the Connections list shows the
narrowed count straight away. See
[`connectors.md`](connectors.md#settings-tool-counts).

Settings and the public support guide explain that admitted tools execute within
the connection's granted access and the person's request, without per-tool
confirmation prompts. Server annotations remain informational and cannot grant
additional authority.

## Invariants

- **The endpoint is the account identity.** A generic MCP server need not
  identify a subject, so the normalized resource URL is what `provider_account_id`
  holds and what a reconnect must match. Authorizing an existing connection
  against a different server is refused rather than silently repointing it.
- **The read-only policy narrows; it never authorizes.** Every admitted tool
  still carries `mode: "write"` and a record-before-execute
  receipt, because an MCP annotation is a claim by the server rather than a
  promise to Rally. A server that mislabels a mutation gets it listed as
  read-only, and executes it without a per-tool confirmation prompt.
- **A personal connection's stored policy is `all_tools`.** The adapter reads
  one field for every scope; a personal row that kept a narrower request would
  restrict its owner with no control anywhere to widen it again.
- **Configured headers cannot reach the transport's own headers.**
  `accept`, `content-type`, `content-length`, `host`, `connection`,
  `transfer-encoding`, `mcp-session-id`, and `mcp-protocol-version` are refused
  at the contract, and the transport sets its own after applying whatever the
  connection carries.
- **Remote text is data on every surface it reaches.** Tool names,
  descriptions, annotations, and a server's own error messages are untrusted on
  the way to the model *and* on the way to the settings screen, which bounds
  each and strips its control and bidi characters before rendering. The
  sanitized name is for the screen only: `tools/call` still receives the exact
  remote name the discovery path retained.
- **A credential never crosses a redirect.** The MCP transport sends every
  request with `redirect: "manual"` and treats a 3xx as an answer, so a server
  cannot have Rally re-send a bearer token or a configured header to another
  host by answering with a `Location`.
- **The configured name supplies a model ID, never prompt instructions.** Custom MCP views
  derive IDs such as `plugin_mcp_rally_engineering_3` from the configured name and
  the credential’s allocated ordinal. Names normalize to ASCII identifier characters;
  the existing 70-character model-ID contract bounds the slug while preserving
  the ordinal, so duplicate, truncated, and non-ASCII-only names remain distinct.
  The canonical connection ID, stored `model_plugin_id`, tool wire prefixes, and
  receipts stay unchanged. Conversation and Sidekick catalogs use the same view;
  saved Sidekick bindings accept both the named view and the stored legacy ID.
  Live runs use
  the saved name after removing controls, bidi formatting, and line breaks while preserving
  Unicode joiners, falling back
  to `Custom MCP server` when empty. `HarnessPlugin.activityDisplayName` is
  separate from the static model-facing `displayName`, descriptions, aliases,
  and system messages. Automation catalogs also retain the static display name.
  Transcript activities carry `connectorType` independently so a custom server
  named Slack keeps the Model Context Protocol mark and a connection-specific row.

## Boundary

This module owns what is specific to a person-configured server: its endpoint,
its two authentication modes, its tool policy, and the inventory a person reads.
It owns no transport, no OAuth mechanics, and no tool conversion — those are
`hosted-mcp.ts` — and no tenancy, credential storage, refresh coordination,
receipts, or execution policy, which are the connection service, the
credential door, and the harness exactly as they are for every other connector.

It deliberately does not ingest activity: a configured server has no webhook, no
poll, and no activity types, so nothing here reaches digests, automations,
watches, or work-stream origins.

## Failure modes and limits

| Condition | Result |
| --- | --- |
| A header-authenticated server refuses or cannot be reached at creation | The request fails with `custom_mcp_unreachable` and the row is removed; nothing is left in Connections. |
| An authorized server refuses or cannot be reached at the callback | The attempt fails with `custom_mcp_unreachable` and the desktop says so; the connection is kept, marked `error` with the reason, and can be reconnected or removed. |
| The server offers no tool this connection may use | The same refusal on both paths — including a `read_only_tools` connection to a server that annotates nothing as read-only, which advertises tools and can call none of them. Discovery says which of the two it is, so the answer ("choose All tools") is in the message. |
| A policy change would leave nothing callable | Refused with `custom_mcp_policy_admits_nothing` and the same message; the stored policy does not change. A server that cannot be reached does not block the change, because a belief about a third party is not evidence. |
| The server becomes unreachable later | The settings pane reports the catalog as unreadable and still shows the endpoint and policy; the model's plugin fails to load with `plugin_tools_unavailable`. |
| More than 16 headers, or a header value over 8,192 characters | The create request is refused before anything is written. Set by the team on 2026-09-03. |
| A header value carries a newline, or names a transport header | Refused at the contract, so a configured value can neither split a request nor override what Rally negotiated. |
| An OAuth grant is revoked | The adapter marks the connection `needs_reconnect` only for the OAuth error codes that mean a dead grant; everything else the server names is treated as Rally's problem. |
| A header-authenticated connection is refused by the server | No retry and no reconnect: there is nothing to refresh, and the fix is to edit the headers. |
| Two tools collide after Rally's model-facing normalization | The whole surface fails closed, as it does for every hosted MCP server. |

Every other transport bound — 128 tools, 20 catalog pages, 100 KB per schema,
2 MB per response, 30 seconds per tool — is the shared hosted-MCP module's and is
listed in [`hosted-mcp-connectors.md`](hosted-mcp-connectors.md).

There is deliberately **no cap on how many custom MCP connections a workspace
may hold.** Each one adds a plugin to the catalog every run in that workspace is
built against, so the cost is real; the team decided on 2026-09-03 that a
workspace hitting it is a conversation rather than a refusal.

## Testing

```bash
pnpm --filter @rally/connectors exec vitest run src/custom-mcp.test.ts
pnpm --filter @rally/api exec vitest run test/custom-mcp-connection.test.ts test/connector-plugin-views.test.ts
pnpm --filter @rally/api exec vitest run test/connector-catalog-discovery.test.ts
pnpm --filter @rally/desktop exec vitest run src/renderer/screens/workspace-settings.test.tsx
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts \
  test-workers/workstream-schema-migration.test.ts
```

- `packages/connectors/src/custom-mcp.test.ts` drives a stub MCP server over the
  real transport: per-connection endpoints, header authentication, the read-only
  filter at discovery *and* before a call, the inventory, and an OAuth flow whose
  authorization server is on a different origin from the resource.
- `apps/api/test/custom-mcp-connection.test.ts` covers creation against a stubbed
  server, the rollback when it refuses, the policy update, the administrator
  boundary, and the unreadable-catalog response. It stubs `globalThis.fetch`,
  because the registry builds the adapter from the environment.
- `connector-plugin-views.test.ts` covers name-derived IDs, duplicate and truncated
  names, identifier normalization, and legacy binding aliases. The connection
  suite checks both assembled catalogs and stable tool prefixes; the real-workerd
  `hosted-sidekick.test.ts` checks acceptance and principal-claim rebinding with
  both named and legacy IDs.
- `connector-catalog-discovery.test.ts` checks configured server names, control
  character removal, and the unnamed fallback without changing trusted prose.
- The workerd suite carries the schema half: migration 31 rebuilds
  `connector_connections`, and only a populated object shows whether its
  dependents survived.

## Data model

No new table. `connector_connections` holds a `custom_mcp` row like any other
connection, with `config_json` carrying `serverUrl`, `authMode`, and
`toolPolicy`, and the credential envelope carrying either the request headers or
the OAuth tokens and client registration. WorkspaceDO migration 31 widened the
`connector_type` and `connector_oauth_attempts.provider` CHECK vocabularies to
admit the new value.

## Security and trust model

The endpoint, the headers, and the tool policy are workspace configuration; the
server's responses are not. Tool metadata and results are untrusted remote
content, bounded and stripped on the way to a person and passed to the model
under the connector's static system message.

The OAuth trust anchor is the URL the person typed. For a connector Rally ships,
the allowed authorization-server origins are named in source; a configured server
has no such list, so this connector opts into
`trustAdvertisedAuthorizationServer` and accepts the authorization server the
resource advertises under RFC 9728 — which is what that document exists for, and
what every other MCP client does. Everything else still holds: HTTPS only, no
embedded credentials, and every advertised authorization, token, and registration
endpoint must share the one admitted origin.

Header authentication is a stored secret with no rotation story. Rally never
returns it, but it is replayed verbatim to whatever host the connection names, so
the endpoint and the header are one decision and are captured together.

## Open questions

- **Editing a connection is add-and-remove.** There is no route to change an
  endpoint, replace headers, or rename a server; a change means a new connection
  and deleting the old one.

## Changelog

### 2026-10-22 — Identify configured servers in the model catalog

A run asked to use Rally Engineering loaded Cloudflare Observability instead:
all four configured servers appeared as “Custom MCP server” with identical
aliases, and the first server’s expired authorization was then attributed to
Engineering. Conversation and Sidekick catalogs now derive a model ID from the
configured name plus the stored credential ordinal. Identifier normalization
makes the name searchable without inserting raw configuration into trusted
prompt prose. Rewriting stored IDs or tool prefixes was rejected because saved
bindings and historical receipts depend on them. Keep those identities stable,
retain legacy binding aliases, and preserve the ordinal through truncation.

### 2026-09-11 — Name the server in participant activity

Activity for a configured server now says “Using Engineering MCP” when that is
its saved name. The request exposed a gap: the connection had a name but every
run used the generic connector title. Reusing the model-facing name was rejected
because that field enters trusted prompt headings, and inferring the icon from
the saved name would let a server named Slack join Slack's branded activity.
Participant labels therefore use a separate field, shared Unicode normalization
on live and canonical paths, and explicit connector identity. Model catalogs
remain static; any future named discovery must frame those labels as untrusted
data. The fallback comes from the adapter's manifest name.


### 2026-09-03 — Rally connects MCP servers it does not ship

**What changed:** A `custom_mcp` connector type, with per-connection endpoints,
header or OAuth authentication in either scope, a live tool inventory in
Connections, and a workspace-only read-only tool policy. The shared hosted-MCP
module grew three things to support it: an endpoint resolved per connection,
request authentication as headers rather than only a bearer token, and a
`selectTools` narrowing applied at discovery and before every call. WorkspaceDO
migration 31 widened the two connector CHECK vocabularies.

**Why:** Every connector Rally had was a provider somebody here wrote a
declaration for, so a workspace with an internal MCP server — or any of the
hundreds now published — had no way to use it. The catalog cannot be the limit of
what Rally can reach, and the hosted-MCP module already did all the hard parts
for three providers; what it lacked was the ability for a connection, rather than
a release, to say which server it meant.

**Considered and rejected:** *A separate table and code path for configured
servers*, which would have avoided the migration and lost credential refresh,
plugin construction, receipts, the connections screen, and disable — everything
that makes a connection a connection. *Trusting `readOnlyHint` to lower Rally's
write policy*, which would let a server's own claim skip confirmation for a
mutation; the hint narrows the surface and changes nothing about what an
admitted call must do. *Rebuilding all thirteen dependent tables* in migration
31, which would have restated schemas that later migrations have already
changed, with no test able to notice a column quietly not carried across.
*Disabling foreign keys for the rebuild instead*, which is what the released
migration mode does and what a first draft of 31 did: it does not work.
`PRAGMA foreign_keys = OFF` is silently a no-op once an object event has touched
SQLite, and the workerd test caught the parent's drop cascading a workspace's
webhook receipts away.

**Consequences:** Adding a hosted-MCP provider Rally *does* ship still means a
small declaration; this is not a replacement for one, and a first-party provider
should keep its named authorization origins rather than trusting whatever a
resource advertises. A workspace can now grow its plugin catalog without limit,
which is a cost every run in that workspace pays. Anything that reads
`connector_type` must accept `custom_mcp` — the value reaches telemetry, the
desktop catalog, and the deep-link vocabulary. And a future change to
`connector_connections`' shape inherits the hold-and-restore recipe in migration
31, which is the only one proven to work here.

Shipped in the pull request for this change.
