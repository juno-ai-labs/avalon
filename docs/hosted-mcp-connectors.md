# Hosted MCP connectors

The hosted-MCP module turns a remote Streamable HTTP MCP server into an Avalon
personal connector without copying the server's tool catalog into source. The
server remains authoritative for tool names, descriptions, and JSON Schemas;
Avalon owns OAuth, tenancy, activation, safety classification, write confirmation,
receipts, credential rotation, and transport limits.

Use this document when adding a hosted MCP provider or changing how a live MCP
tool reaches the model. Provider-specific workspace APIs and webhook ingestion
remain in [`connectors.md`](connectors.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/connectors/src/hosted-mcp.ts` | The reusable OAuth discovery/DCR/PKCE helpers, Streamable HTTP client, paginated `tools/list`, exact `tools/call` forwarding, and live `ToolDefinition` conversion. |
| `packages/connectors/src/types.ts` | `ConnectorDynamicAgentTools`, the adapter facet that declares which grants and connection scopes use a live tool surface. |
| `apps/api/src/services/integrations.ts` | Converts a dynamic connector facet into one connection-specific `HarnessPlugin.loadTools`, validates the live surface against the frozen grant, and routes execution back to the adapter. |
| `packages/agent-harness/src/bind-runtime.ts` | Loads the tools after authorization at `load_plugin`, replaces the empty deferred plugin in the Bind registry, and caches that surface for the run. |
| `packages/connectors/src/{granola,slack,notion}.ts` | Small provider declarations: endpoint, accepted capability, token accessor/refresh wrapper, and the personal-versus-workspace branch. |

## How it works

### Declaring a pass-through connector

The provider adapter builds one declaration and exposes its dynamic facet:

```ts
const personalMcp = createHostedMcpPassthrough({
  providerName: "Example",
  serverUrl: "https://mcp.example.com/mcp",
  capabilities: [ExampleCapabilities.personalMcp],
  connectionScopes: ["personal"],
  capabilityForConnection: () => ExampleCapabilities.personalMcp,
  withAccessToken: (connection, signal, operation) =>
    withFreshProviderToken(connection, signal, operation),
  oauth: {
    redirectUri: "https://api.with-avalon.com/connections/example/callback",
    allowedAuthorizationOrigins: ["https://mcp.example.com"],
  },
});

return {
  dynamicAgentTools: personalMcp.dynamicAgentTools,
  async executeTool(name, args, context) {
    if (context.connection.scope === "personal") {
      return personalMcp.execute(context.connection, name, args, context.signal);
    }
    return executeWorkspaceApiTool(name, args, context);
  },
};
```

That is the entire tool integration. Do not add the MCP server's current tools
to the static `agentPlugin.tools` list. Static tools may remain for a different
scope, as they do for the Granola, Slack, and Notion workspace connections.

With the optional `oauth` block, the same returned object exposes
`personalMcp.authorization.begin`, `.exchangeCode`, `.refresh`, and
`.parseState`. They implement protected-resource discovery,
authorization-server discovery, dynamic client registration, authorization
code plus PKCE, and refresh. No endpoint, fetch policy, or response limit is
declared twice. A provider with its own OAuth dialect, such as Slack, omits the
block, keeps that credential code, and still uses the same pass-through object
for live tools.

### Discovery and activation

The model first sees only Avalon's trusted connector catalog entry. The API
creates the deferred credential plugin with no model tools and a `loadTools`
callback. When the model calls `load_plugin`, the harness reauthorizes the
connection, calls the callback, and only then persists activation and exposes
the returned tools on the next model turn.

The callback enters the credential door, refreshes when necessary, initializes
one MCP session, sends `notifications/initialized`, follows every `tools/list`
cursor, and closes the session when the server assigned an ID. Avalon preserves
the server's input schema. Remote annotations are parsed as bounded metadata but
never lower Avalon's safety policy. A remote name already valid under Avalon's lowercase
canonical-name contract stays unchanged; any other name gets a deterministic
internal alias, and execution maps that alias back to the exact remote name.
Model-facing names then receive Avalon's normal connector prefix and identifier
normalization.

One run caches the loaded surface in both Bind's active registry and the
host-owned plugin object from which read-only inline-child authority is narrowed.
A later run discovers again, so a server can
add, remove, or reshape a tool without an Avalon release. Execution opens a new
session and lists tools before `tools/call`; a tool removed between activation
and use therefore fails closed instead of forwarding an unadvertised name.

### Current scope splits

| Provider | Personal connection | Workspace connection |
| --- | --- | --- |
| Granola | Live hosted-MCP tools under `granola.personal.read`. | Fixed Workspace API reads and signed note webhooks. |
| Slack | Live hosted-MCP tools under `slack.personal.mcp`; legacy personal grants are accepted only to avoid breaking existing rows. | Fixed reviewed Web API tools, Agent, events, and deterministic delivery. |
| Notion | Official hosted-MCP OAuth and live tools under `notion.personal.mcp`. | Public integration bot, selected-page REST tools, and signed webhooks. |

## Invariants

- **`tools/list` is the only tool catalog for a dynamic scope.** Copying one
  observed list into a descriptor creates a second authority that silently
  becomes stale when the provider changes; tests should mock live discovery,
  not enshrine a snapshot.
- **Activation precedes exposure.** The connection is reauthorized and its
  activation is durably recorded before the model sees any live tool. Exposing
  tools first would let a run act through authority it had not persisted.
- **The frozen connection grant still bounds every live tool.** A discovered
  definition receives exactly one capability already granted to that
  connection and valid for its scope. Remote metadata can change a schema; it
  cannot widen Avalon tenancy or capability scope.
- **Every provider-authored tool is a confirmed write.** MCP annotations are
  hints, not contracts, so even `readOnlyHint: true` cannot bypass confirmation
  or a record-before-execute receipt. A future read classification must come
  from a separate Avalon-authored policy; guessing from names or trusting a
  provider hint can turn a newly introduced mutation into an unconfirmed action.
- **The remote name is forwarded exactly.** Avalon may need a safe internal
  alias for a name outside its canonical-name grammar, but `tools/call` receives
  the original value. Forwarding the alias would call a different or nonexistent
  provider operation.
- **Personal and workspace identities remain separate.** Hosted MCP acts with
  the authorizing member's provider identity. A public app or bot connection
  stays workspace-scoped even when a human approved its OAuth screen.

## Boundary

This module owns standards-based hosted-MCP OAuth helpers, transport, live tool
conversion, and deferred exposure to Bind. It exposes `createHostedMcpPassthrough`
to adapters and `loadTools` to the harness.

It does not decide which Avalon member or workspace may use a connection, store
credentials, persist activations or receipts, interpret provider content, or
define a provider's workspace API/webhook behavior. Those remain with the
connection service, credential door, harness host, and provider adapter as
described in [`connectors.md`](connectors.md) and
[`agent-harness.md`](agent-harness.md).

## Failure modes and limits

| Condition | Result |
| --- | --- |
| Discovery, refresh, or MCP initialization fails during `load_plugin` | The load returns `plugin_tools_unavailable`; no activation or partial tool surface is exposed. |
| Server returns no compatible tools | The plugin load fails. Avalon does not activate an empty dynamic plugin. |
| More than 128 tools or 20 cursor pages | Discovery fails with `payload_too_large`. |
| One input schema exceeds 100 KB | Discovery fails before model exposure. |
| Two names collide after model-wire normalization | The whole surface fails closed; Avalon does not choose one. |
| A tool disappears before execution | The fresh pre-call list cannot find it and the call is rejected. |
| MCP response exceeds the provider's configured cap | The request fails rather than truncating protocol JSON. The shared default is 2 MB. |
| Tool output contains large or deeply nested values | Strings are bounded at 80,000 characters, collections at 200 entries per level, and nesting at eight levels before entering the transcript. |
| OAuth discovery advertises a different resource or origin | Authorization stops with `invalid_configuration`; DCR credentials and authorization codes are sent only to the exact MCP resource and explicitly allowed HTTPS origins. |
| A path-specific OAuth metadata document is absent | Discovery falls back from the RFC path-insertion URL to the MCP root well-known URL. Other errors fail without silently changing endpoints. |
| Access token is refused | The adapter's `withAccessToken` wrapper performs the same serialized refresh-and-retry policy as its non-MCP provider calls. |

Streamable HTTP is the supported transport. A `text/event-stream` response on
that endpoint is parsed, but the abstraction does not fall back to a separate
legacy SSE endpoint.

## Testing

`packages/connectors/src/hosted-mcp.test.ts` covers live schema preservation,
annotation-independent write policy, normalized-name collisions, pagination,
session lifecycle, exact forwarding, path-aware OAuth discovery, DCR, PKCE,
exchange, and refresh:

```bash
pnpm --filter @avalon/connectors exec vitest run src/hosted-mcp.test.ts
```

`packages/agent-harness/src/index.test.ts` proves that a deferred dynamic tool
is absent before activation, loaded once, and visible with the server's schema
on the next model turn. Provider suites cover their scope branch and credential
dialect. `apps/api/test/connector-tool-selection.test.ts` protects capability
inheritance for child runs; static tool capabilities must remain exact while an
unloaded dynamic plugin falls back to its frozen MCP grant.

## Regional impact

Discovery and tool execution happen in the Worker region that owns the
connection, and credentials remain encrypted in that region's D1. The generic
OAuth helpers do not introduce a control-plane table or cross-region bridge.
Notion's shared callback host is a separate provider constraint owned by
[`notion-ingress.md`](notion-ingress.md); it routes the authorization back to
the owning region before token exchange and storage.

## Security and trust model

Provider tool descriptions, JSON Schemas, annotations, and results are
untrusted remote input. They may shape only the bounded active tool definition
and result; annotations cannot select Avalon mode or idempotency, and none of
them enter Avalon's standing system policy or connector catalog prose. Provider
content returned by a tool remains untrusted evidence under the connector's
static system message.

OAuth metadata is accepted only over HTTPS and every advertised authorization,
token, and registration endpoint must share an explicitly allowed origin.
Embedded URL credentials are rejected. Access and refresh tokens are never
model-visible. Dynamic tools still pass through normal argument validation,
principal reauthorization, confirmation policy, durable receipt planning, and
result persistence.

## Operations

`dynamic_connector_tools_unavailable` identifies discovery failures while
building an automation creator catalog. Interactive `load_plugin` reports the
bounded `plugin_tools_unavailable` result; use the connection test to distinguish
credential failure from an MCP protocol/surface failure. Inspect the provider's
current `tools/list` response when a formerly working prompt loses a tool—do not
patch a historical snapshot into Avalon.

## Changelog

### 2026-08-12 — Remote hints cannot downgrade write policy

**What changed:** Every hosted-MCP tool now receives write confirmation and a
record-before-execute receipt regardless of `readOnlyHint`. OAuth discovery uses
RFC path insertion before the root fallback, and a loaded deferred surface is
retained on the host plugin so later child narrowing sees the activated tools.

**Why:** Tool annotations are provider hints rather than enforceable contracts;
using one to skip confirmation made a newly added or mislabeled mutation a
silent write. Root-only discovery also failed compliant path-scoped servers,
and keeping loaded tools only inside Bind made the API's child-scope builder see
the original empty placeholder.

**Considered and rejected:** A static read-tool allowlist. It would recreate the
catalog snapshot this abstraction exists to remove. Trusting annotations only
for today's three providers was also rejected because provider ownership does
not make a hint an authorization guarantee.

**Consequences:** Hosted-MCP reads currently ask for confirmation and are not
available to read-only inline children. A future lower-friction read path needs
an independent Avalon-authored policy source. Metadata discovery may issue one
extra 404 request when a server publishes only the root fallback.

Shipped in the pull request for this change.

### 2026-08-12 — Hosted MCP servers own their live tool surfaces

**What changed:** Avalon gained one hosted-MCP abstraction for OAuth discovery,
DCR, PKCE, rotating credentials, Streamable HTTP sessions, live tool discovery,
and exact call forwarding. Granola, Slack, and Notion personal connections use
that live surface; Notion's official MCP server is now the personal counterpart
to its workspace bot connection.

**Why:** Granola and Slack exposed code-authored tool lists derived from one
observed server response. Those lists were snapshots of providers that can add,
remove, or reshape tools without an Avalon release, so the model could be told a
tool existed after the server removed it or never learn a tool the server added.
Adding Notion by copying its documented list would have repeated the same
failure and made every future MCP connector another custom transport.

**Considered and rejected:** Generating source from `tools/list` during releases.
That still makes deploy time, rather than activation time, authoritative and
cannot represent account-dependent surfaces. Eagerly discovering every MCP
connection at run start was also rejected because most credential plugins are
never loaded; it would spend provider calls and refresh tokens without helping
the request.

**Consequences:** New hosted MCP providers add a small declaration instead of a
tool catalog, and tool changes take effect on the next activation. A dynamic
plugin can fail to load when its server returns a malformed or colliding surface,
which is deliberately safer than exposing a partial guess. Future changes must
keep the static catalog trusted, preserve confirmation/receipts, and never turn
remote tool metadata into new Avalon authority.
