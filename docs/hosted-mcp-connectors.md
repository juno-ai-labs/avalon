# Hosted MCP connectors

The hosted-MCP module turns a remote Streamable HTTP MCP server into a Rally
personal connector without copying the server's tool catalog into source. The
server remains authoritative for tool names, descriptions, and JSON Schemas;
Rally owns OAuth, tenancy, activation, safety classification, conservative write execution,
receipts, credential rotation, and transport limits.

Use this document when adding a hosted MCP provider or changing how a live MCP
tool reaches the model. Provider-specific workspace APIs and webhook ingestion
remain in [`connectors.md`](connectors.md).

Rally never asks users to confirm a tool call. Read and write tools execute
within existing authorization. The `write` classification below controls serial
execution, durable receipts, read-only child eligibility and uncertain-outcome
handling; it is not a human approval gate. Earlier wording claiming otherwise
was incorrect and must not be used to introduce confirmations.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/connectors/src/hosted-mcp.ts` | The reusable OAuth discovery/DCR/PKCE helpers, Streamable HTTP client, paginated `tools/list`, exact `tools/call` forwarding, and live `ToolDefinition` conversion. |
| `packages/connectors/src/types.ts` | `ConnectorDynamicAgentTools`, the adapter facet that declares which grants and connection scopes use a live tool surface. |
| `apps/api/src/services/connector-tool-inventory.ts` | Validates discovery, persists configured-server metadata with connection fences, and composes plugin descriptions and instructions. |
| `apps/api/src/services/integrations.ts` | Converts a dynamic connector facet into one connection-specific `HarnessPlugin.loadTools`, validates the live surface against the frozen grant, and routes execution back to the adapter. |
| `packages/agent-harness/src/bind-runtime.ts` | Loads the tools after authorization at `load_plugin`, replaces the empty deferred plugin in the Bind registry, and caches that surface for the run. |
| `packages/connectors/src/{apollo,ashby,fireflies,granola,slack,notion}.ts` | Small provider declarations: endpoint, accepted capability, token accessor/refresh wrapper, and the personal-versus-workspace branch. |

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
    redirectUri: "https://api.rallywith.ai/connections/example/callback",
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

Ashby uses this same helper with `https://mcp.ashbyhq.com/mcp/v1`, personal
capability `ashby.personal.mcp`, and authorization origin
`https://mcp-auth.ashbyhq.com`. Its live catalog is never checked in. Workspace
API keys and webhook management are a separate authorization path and do not
enter the MCP transport. See [provider prerequisites](provider-apps.md#ashby-personal-oauth-and-workspace-api-keys)
for metadata observations and outstanding live acceptance.

Apollo.io uses `https://mcp.apollo.io/mcp`, personal capability
`apollo.personal.mcp`, and trusted authorization origin `https://mcp.apollo.io`.
The shared lifecycle handles its regional callback, refresh, reconnect and
revocation; its live catalog is never checked in. Its account identifier is a
resource URL, with no verified provider user. See
[Apollo prerequisites](provider-apps.md#apolloio-personal-oauth-and-sidekick-events).

### Discovery and activation

The model first sees the connector catalog entry. Shipped providers use Rally's
code-authored description; configured servers use their last discovered description
(see [custom MCP connectors](custom-mcp-connectors.md)). The API
creates the deferred credential plugin with no model tools and a `loadTools`
callback. When the model calls `load_plugin`, the harness reauthorizes the
connection, calls the callback, and only then persists activation and exposes
the returned tools on the next model turn. A prior or explicitly attached
activation takes the same path before inference: its live surface is loaded and
hashed before the activation is persisted and handed back to Bind. A failed
restoration stays inactive instead of aborting the run with a missing hash.

The callback enters the credential door, refreshes when necessary, initializes
one MCP session, sends `notifications/initialized`, follows every `tools/list`
cursor, and closes the session when the server assigned an ID. The same session
retains optional `initialize.serverInfo.description` and `initialize.instructions`.
`discoverCatalog` returns those beside the validated tools; `discover` remains the
compatible tools-only adapter method. An absent or blank description becomes an
extractive description of the admitted tool names and descriptions, under the
existing 4,000-character description bound. Instructions retain their full text
within the existing MCP response bound; description whitespace and formatting
controls normalize to one line so remote prose cannot create catalog headings.
There is no model inference or second provider request for this fallback.

For configured servers, the host updates its shared plugin object's description
and `systemMessage` before Bind replaces the deferred registry entry. The latter
combines Rally's static connector policy with server-provided usage instructions,
explicitly subordinate to Rally policy and the user's request. Explicit loads,
restored activations, inline children, and Sidekick catalogs use that same
metadata. A subsequent discovery with no instructions removes the prior text.
Shipped provider adapters retain their code-authored plugin guidance.

 Rally preserves
the server's object-shaped input schema. Remote annotations are parsed as bounded metadata but
never lower Rally's safety policy. A remote name already valid under Rally's lowercase
canonical-name contract stays unchanged; any other name gets a deterministic
internal alias. The dynamic definition separately retains the exact remote
operation name, and execution requires that exact name to remain present.
Model-facing names then receive Rally's normal connector prefix and identifier
normalization.

One run caches the loaded surface in both Bind's active registry and the
host-owned plugin object from which read-only inline-child authority is narrowed.
A later run discovers again, so a server can
add, remove, or reshape a tool without a Rally release. Execution opens a new
session and lists tools before `tools/call`; a tool removed between activation
and use therefore fails closed instead of forwarding an unadvertised name.

Rally is the client identity at both protocol boundaries: dynamic OAuth client
registration defaults `client_name` to `Rally`, and MCP initialization sends
`clientInfo.name = "Rally"`. Provider adapters may override DCR metadata only
when a provider contract requires it. Existing encrypted client registrations
and tokens are not rewritten; the default applies when registering a new client,
while every newly opened MCP session uses the Rally initialization identity.

### Current scope splits

| Provider | Personal connection | Workspace connection |
| --- | --- | --- |
| Apollo.io | Live hosted-MCP tools under `apollo.personal.mcp`. | Not supported. |
| Fireflies | Live hosted-MCP tools under `fireflies.personal.read`. | Three fixed GraphQL reads and a signed meeting webhook the administrator registers by hand. |
| Granola | Live hosted-MCP tools under `granola.personal.read`. | Fixed Workspace API reads and signed note webhooks. |
| Slack | Live hosted-MCP tools under `slack.personal.mcp`; legacy granular personal grants remain on their fixed reviewed Web API tools until reconnect. | Fixed reviewed Web API tools, Agent, events, and deterministic delivery. |
| Notion | Official hosted-MCP OAuth and live tools under `notion.personal.mcp`. | Public integration bot, selected-page REST tools, and signed webhooks. |

Fireflies is the first provider whose authorization server publishes **no
`offline_access`** — its metadata advertises only `profile` and `email`
alongside a `refresh_token` grant. Rally therefore asks for no scope the
provider does not publish, and treats an authorization that returns no refresh
token as reconnect-required rather than as something it can renew later. That is
the expected path for this provider, not a fault, and it is why its personal
connections must be reconnectable: see
[`provider-apps.md`](provider-apps.md#fireflies-personal-oauth-and-workspace-api-keys)
for the metadata and the date it was last read.

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
  cannot widen Rally tenancy or capability scope.
- **Every provider-authored tool is a potential write.** MCP annotations are
  hints, not contracts, so even `readOnlyHint: true` cannot bypass execution safeguards
  or a record-before-execute receipt. A future read classification must come
  from a separate Rally-authored policy; guessing from names or trusting a
  provider hint can turn a newly introduced mutation into an unsafely replayed action.
- **A remote schema may not sink the request it arrives in.** A hosted server's
  `inputSchema` reaches the model verbatim, and a root-level combinator makes a
  provider reject the **whole request, every tool** — a run's core tools taken
  down by one third-party schema, on a connection the person set up correctly.
  Azure OpenAI rejects any root `oneOf`/`anyOf`/`allOf`/`enum`/`const`/`not`, and
  a root that declares no `type: "object"`, whatever the branches look like; xAI
  rejects the narrower case of a root union with a branch it cannot read as an
  object. **The guarantee is not made here.** `repairRootSchemaForProviders` runs
  at `toModelToolDefinitions`, the single point where any tool — Rally's, a
  connector's, a hosted server's, a skill's — becomes a provider payload, so a
  remote schema is corrected on the way to the wire whether or not it arrived
  through this path. `validateDynamicConnectorTools` calls it too, and that call
  is now redundant for safety and kept for a different reason: this is the only
  place that can name the connector and the tool in
  `dynamic_tool_root_schema_repaired`, and a run whose schemas were rewritten
  with no record of which server served them is materially harder to debug.
  The correction **merges** rather than drops: branch properties are folded into
  the root, `required` is intersected across a union and unioned across an
  `allOf`, and a property the branches declare differently becomes a union under
  that property, which providers accept below the root. An earlier version
  deleted the offending keywords instead, which empties a schema whose root is
  only its union — a tool then advertises no parameters while its executor still
  demands them. What a merge cannot carry is the exclusivity between branches;
  that is given up knowingly, because a constraint one provider honours is worth
  less than a request another does not reject outright, and the remote server
  validates its own arguments regardless. It repairs rather than rejects because
  refusing the tool spends the person's capability on a judgement about a
  provider's schema dialect. This is deliberately the *only* schema rewrite Rally
  performs; Bind's sanitizer owns every other dialect difference. The measured
  rule and its limits live in
  [`agent-tools.md`](agent-tools.md#mechanics--where-the-rules-are-enforced).
- **The remote name is forwarded exactly.** Rally may need a safe internal
  alias for a name outside its canonical-name grammar, but `tools/call` receives
  the original value retained at activation. A later operation whose raw name
  equals that alias cannot inherit the confirmed call, and a fresh catalog with
  new canonical-name collisions fails closed.
- **Provider-specific deadlines are keyed by the exact remote name.** A hosted
  MCP declaration may assign a Rally-authored timeout to a known operation
  without copying its schema or making that operation part of Rally's catalog.
  Unnamed and newly introduced operations keep the shared 30-second deadline.
- **Personal and workspace identities remain separate.** Hosted MCP acts with
  the authorizing member's provider identity. A public app or bot connection
  stays workspace-scoped even when a human approved its OAuth screen.

## Boundary

This module owns standards-based hosted-MCP OAuth helpers, transport, live tool
conversion, and deferred exposure to Bind. It exposes `createHostedMcpPassthrough`
to adapters and `loadTools` to the harness.

It does not decide which Rally member or workspace may use a connection, store
credentials, persist activations or receipts, interpret provider content, or
define a provider's workspace API/webhook behavior. Those remain with the
connection service, credential door, harness host, and provider adapter as
described in [`connectors.md`](connectors.md) and
[`agent-harness.md`](agent-harness.md).

## Failure modes and limits

| Condition | Result |
| --- | --- |
| Discovery, refresh, or MCP initialization fails during `load_plugin` | The load returns `plugin_tools_unavailable`; no activation or partial tool surface is exposed. |
| Server returns no compatible tools | The plugin load fails. Rally does not activate an empty dynamic plugin. |
| A tool input schema is not object-shaped | Discovery fails before model exposure. |
| More than 128 tools or 20 cursor pages | Discovery fails with `payload_too_large`. |
| One input schema exceeds 100 KB | Discovery fails before model exposure. |
| Two names collide after model-wire normalization | The whole surface fails closed; Rally does not choose one. |
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
object-shaped schema admission, annotation-independent write policy,
activation-time and fresh-catalog name collisions, pagination,
session lifecycle, exact forwarding, path-aware OAuth discovery, DCR, PKCE,
exchange, and refresh:

```bash
pnpm --filter @rally/connectors exec vitest run src/hosted-mcp.test.ts
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
untrusted remote input. Annotations cannot select Rally mode or idempotency.
Configured-server descriptions may enter the normalized plugin catalog, and
server-provided usage instructions enter only that authorized plugin's active
system-prompt section. They do not replace Rally policy or authorize tools,
credentials, or activity beyond the connection's grants. Ordinary tool results
remain untrusted evidence under the connector's static system message.

OAuth metadata is accepted only over HTTPS and every advertised authorization,
token, and registration endpoint must share an explicitly allowed origin.
Embedded URL credentials are rejected. Access and refresh tokens are never
model-visible. Dynamic tools still pass through normal argument validation,
principal reauthorization, execution policy, durable receipt planning, and
result persistence.

## Operations

`dynamic_connector_tools_unavailable` identifies discovery failures while
building an automation creator catalog. Interactive `load_plugin` reports the
bounded `plugin_tools_unavailable` result; use the connection test to distinguish
credential failure from an MCP protocol/surface failure. Inspect the provider's
current `tools/list` response when a formerly working prompt loses a tool—do not
patch a historical snapshot into Rally.

## Changelog

### 2026-10-22 — Carry configured-server guidance through discovery

A named custom MCP plugin still had the same generic capability description as
every other configured server, while initialization descriptions and usage
instructions were discarded. Discovery now retains both alongside the tools,
uses tool text when no description was supplied, and refreshes the host plugin
before Bind registers it. A separate metadata fetch or model call was rejected:
initialization and tool discovery already have the evidence, and activation
latency matters. Keep the tools-only adapter method compatible, descriptions
single-line, and server instructions in their authorized active-plugin section
under Rally policy; do not turn tool results into standing instructions.

### 2026-10-19 — Apollo.io uses the provider's OAuth and live MCP catalog

Apollo.io personal connections reuse hosted MCP discovery, PKCE, token rotation,
revocation and exact operation forwarding, with no workspace grant. Maintaining
an API-shaped copy of its prospecting and outreach tools would duplicate a
surface Apollo already owns. Its public API does not document general event
subscription management: the API's enrichment callbacks are request results,
while useful business events require a human-configured Apollo Workflow. The
connector therefore advertises no polling, watches or webhook triggers; a future
Sidekick event integration must establish an authenticated payload and personal
audience contract rather than infer events by repeatedly scanning contacts.

### 2026-09-19 — Preserve Workers fetch invocation and provider OAuth metadata

Live Canva discovery failed before reaching the network because the transport
called native `fetch` as a method of its request object. A plain function call
preserves the Workers receiver contract; a workerd regression exercises native
fetch through a local data-URL provider response and fails with the old call.
Explicit OAuth resource configuration now also selects that resource's discovery
URL, since Canva's root and `/mcp` metadata advertise different resource strings.
Optional revocation endpoints are origin-validated and retained with credentials;
RFC 7009 revocation accepts empty success bodies instead of parsing them as JSON.

### 2026-09-19 — Preserve OAuth resource identity and narrowly support native redirects

The OAuth helper preserves the advertised resource string instead of adding a
trailing slash. Canva's resource is its origin, distinct from the MCP endpoint.
An explicit native option permits only HTTP 127.0.0.1 with a port and exact
`/callback` path; ordinary connector redirects still require HTTPS. This keeps
the temporary desktop flow from becoming an arbitrary redirect exception.

### 2026-09-03 — A hosted server can be named by a connection rather than by source

**What changed:** `createHostedMcpPassthrough` accepts a `serverUrl` resolver as
well as a fixed URL, authenticates a request with headers rather than only a
bearer token (`withRequestAuth` beside `withAccessToken`, both through
`HostedMcpRequestAuth`), takes an optional `selectTools` narrowing applied at
discovery *and* to the fresh catalog read before every `tools/call`, and lets a
declaration opt into trusting the authorization server its protected resource
advertises. `HostedMcpAuthorization.begin` takes an optional `serverUrl` for the
same reason. The first user is the custom MCP connector documented in
[`custom-mcp-connectors.md`](custom-mcp-connectors.md).

**Why:** Every provider here is one Rally shipped a declaration for, so the
endpoint, the credential shape, and the trusted OAuth origins could all be
literals. A server somebody configures has none of those: the URL arrives with
the connection, the credential may be a header a person pasted rather than a
token Rally minted, and there is no origin list to check an authorization server
against — RFC 9728 exists precisely so the resource can name its own. Adding a
second MCP transport for that case would have meant a second place for a
provider's contract to diverge from what the model was shown.

**Considered and rejected:** Applying a tool narrowing only at discovery. The
call path re-lists the catalog anyway, and a filter that ran only at activation
would let a surface loaded before a policy narrowed still spend a withheld
write. Keeping `withAccessToken` as the single credential shape and passing a
synthetic token for header authentication was rejected for the obvious reason:
the value is not a token and every layer beneath would have had to pretend it
was.

**Consequences:** A provider Rally ships should keep naming its
`allowedAuthorizationOrigins`; `trustAdvertisedAuthorizationServer` is for a
server whose only trust anchor is the URL a person typed, and turning it on for
a first-party provider would remove a real check. `call()` still requires an
adapter-level endpoint and throws for a resolver-based declaration, because it
has no connection to resolve one from. The collision check before a call still
runs over the *whole* catalog rather than the narrowed one: a name a policy hid
still collides.

### 2026-09-02 — The root-schema correction moved to the wire and now merges

**What changed:** The trust-model bullet above no longer describes
`repairRootUnionForProviders`, its defer-to-the-sanitizer gate, or
`dynamic_tool_root_union_repaired`. The corrector is
`repairRootSchemaForProviders`, it runs for every tool at
`toModelToolDefinitions` rather than only for discovered ones here, it merges a
root combinator instead of deleting it, and the log event is
`dynamic_tool_root_schema_repaired`.

**Why:** Azure OpenAI rejects a root-level combinator whatever its branches look
like, which is stricter than the xAI rule this section was written against, and
a hosted server is not the only source of such a schema. Making the guarantee at
the one chokepoint every tool passes through covers the sources no build-time
test can see. Deleting the keywords was also wrong for a schema whose root is
only its union: it leaves a tool with no parameters at all.

**What a future change has to respect:** the call here is redundant for safety
and exists for the log. Removing it loses the only signal that names which
connector and tool served a schema that needed rewriting.

### 2026-08-29 — Granola meeting queries may run for five minutes

**What changed:** Granola's exact hosted-MCP operation
`query_granola_meetings` now advertises a five-minute tool deadline. The shared
hosted-MCP declaration accepts trusted per-operation deadline overrides; all
other Granola operations and other hosted-MCP providers retain the 30-second
default.

**Why:** A production natural-language meeting query was still progressing when
the inherited 30-second deadline interrupted it. The team selected five minutes
for this operation. Cloudflare documents no hard wall-time limit for
[Durable Object RPC/HTTP](https://developers.cloudflare.com/durable-objects/platform/limits/)
while the caller remains connected, and network waits do not consume the
object's active CPU allowance, so this deadline is supported by the runtime
path. Checked 2026-08-29.

**Considered and rejected:** Raising the shared hosted-MCP deadline would make
every current and future provider operation wait five minutes, including writes.
Hard-coding Granola's observed tool schema would create a second catalog that
could drift from `tools/list`.

**Consequences:** A stalled Granola meeting query can hold its run and provider
connection for up to five minutes before Rally interrupts it. If it is still
unsettled then, it still ends as `ambiguous_external_write`; the longer deadline
gives the provider more time to finish and does not change receipt persistence,
cancellation, or ambiguous-outcome handling.

### 2026-08-25 — The Rally client identity is pinned as one hosted-MCP contract

**What changed:** The broader agent-identity cut-over in #301 changed dynamic
client registration and MCP initialization from Avalon to Rally. This follow-up
uses shared name/version constants for those two boundaries and adds exact tests
for both. The identity is shared across Granola, Slack, and Notion hosted-MCP
sessions; only a provider-specific declaration can override DCR metadata.

**Why:** Duplicated, unasserted identity literals could let authorization records
and active-session logs drift back to two names even after the runtime rename.
One constant and assertions at both protocol boundaries make that drift fail the
connector suite.

**Considered and rejected:** Re-registering every stored OAuth client or forcing
every member to reconnect. Existing provider-issued client IDs and refresh tokens
remain valid and contain authority that a display-name change does not justify
discarding.

**Consequences:** New dynamic registrations and new MCP sessions display Rally.
Existing encrypted credentials continue to refresh normally, so the change does
not rotate secrets or revoke connections.

Shipped in #307; the runtime rename first landed in #301.

### 2026-08-16 — The remote-schema repair defers to the sanitizer

**What changed:** `repairRootUnionForProviders` now returns the schema untouched
unless `nonObjectRootUnionBranches` reports that the sanitizer's own output would
still carry an unreadable root branch. In practice, under `@juno-ai/bind` 13,
that means it never fires.

**Why:** it had become worse than doing nothing. Bind 13 turns a remote
`oneOf: [{required:["pageId"]}, {required:["discussionId"]}]` into
self-sufficient object branches that all nine measured models accept and the
model can read; dropping the composition first threw that constraint away and
told the model nothing about the choice. The layer was written against Bind 11,
where the same drop was the only thing standing between a third-party schema and
a 400 covering the whole request. Both were correct for their dependency; the
mistake would have been leaving it unconditional after the dependency improved.

Gating rather than deleting is the point. A deleted backstop has to be noticed
and rebuilt if a future sanitizer stops handling a shape; a gated one re-engages
on its own, because the gate asks the sanitizer what it actually emitted rather
than assuming a version. The test moved with it: it asserts the outcome — nothing
a remote server serves reaches the wire with an unreadable root branch — across
all four known-fatal shapes, rather than asserting that this particular layer is
what fixed it. The mechanism has already moved once and should be free to move
again.

### 2026-08-16 — A remote schema can no longer fail the request it arrives in

**What changed:** `validateDynamicConnectorTools` now runs every discovered
definition's `inputSchema` through `repairRootUnionForProviders`. A root
`anyOf`/`oneOf` whose branches xAI will not read as objects is dropped — the rest
of the schema is kept and the tool stays available — and the repair logs
`dynamic_tool_root_union_repaired`. Nothing else about a remote schema is
rewritten.

**Why:** the same defect that took every x-ai call in the fleet down for three
days was reachable from any hosted MCP server, and worse from there. xAI answers
a root union with a non-object branch with a 400 covering the **whole request**,
so one third-party tool's schema fails every *other* tool in the run, Rally's
core tools included — on a connection the person set up correctly, from a server
Rally does not control. The first-party half of that fix is a build-time guard
over authored schemas; it cannot see a schema that arrives at run time, and no
test can. The rule had to be enforced where the schema enters instead.

It repairs rather than rejects because rejecting spends the person's capability
on a judgement about a *provider's* schema dialect rather than anything they did,
and the remote server validates its own arguments regardless — so what is given
up is a wire-level constraint Bind's `required` pruning was already erasing for
every provider. Dropping the composition measured 27/27 accepted across nine
models; adding `type: "object"` to the branches instead passes xAI but the
sanitizer then strips their `required` anyway, so it buys nothing.

It lives in `validateDynamicConnectorTools` rather than in the connector adapter
because that is Rally's host-side gate — every dynamic source (Slack, Granola,
Notion) funnels through it — and because putting it in `hosted-mcp.ts` would make
`packages/connectors` depend on `@rally/agent-harness` for one import. A future
change must keep it the only schema rewrite here: the value of "the remote schema
is forwarded as authored" is that a second rewrite is a second place for a
provider's contract to silently diverge from what the model was shown.

### 2026-08-12 — Hosted MCP servers own their live tool surfaces, and remote hints cannot downgrade write policy

**What changed:** Rally gained one hosted-MCP abstraction for OAuth discovery,
DCR, PKCE, rotating credentials, Streamable HTTP sessions, live tool discovery,
and exact call forwarding. Granola, Slack, and Notion personal connections use
that live surface; Notion's official MCP server is now the personal counterpart
to its workspace bot connection.

Every hosted-MCP tool receives write confirmation and a record-before-execute
receipt regardless of `readOnlyHint`. OAuth discovery uses RFC path insertion
before the root fallback, a loaded deferred surface is retained on the host
plugin so later child narrowing sees the activated tools, and exact remote
operation identities survive model-safe aliasing. Restored dynamic activations
load and hash their live surface before persistence.

**Why:** Granola and Slack exposed code-authored tool lists derived from one
observed server response. Those lists were snapshots of providers that can add,
remove, or reshape tools without a Rally release, so the model could be told a
tool existed after the server removed it or never learn a tool the server added.
Adding Notion by copying its documented list would have repeated the same
failure and made every future MCP connector another custom transport.

Tool annotations are provider hints rather than enforceable contracts; using
one to skip confirmation made a newly added or mislabeled mutation a silent
write. Root-only discovery also failed compliant path-scoped servers, and
keeping loaded tools only inside Bind made the API's child-scope builder see
the original empty placeholder. Persisting a restored deferred activation before
loading it left no surface hash, while resolving a call from its alias could
silently select a different provider operation after catalog drift.

**Considered and rejected:** Generating source from `tools/list` during
releases. That still makes deploy time, rather than activation time,
authoritative and cannot represent account-dependent surfaces. Eagerly
discovering every MCP connection at run start was also rejected because most
credential plugins are never loaded; it would spend provider calls and refresh
tokens without helping the request.

A static read-tool allowlist. It would recreate the catalog snapshot this
abstraction exists to remove. Trusting annotations only for today's three
providers was also rejected because provider ownership does not make a hint an
authorization guarantee.

**Consequences:** New hosted MCP providers add a small declaration instead of a
tool catalog, and tool changes take effect on the next activation. A dynamic
plugin can fail to load when its server returns a malformed or colliding surface,
which is deliberately safer than exposing a partial guess. Future changes must
keep the static catalog trusted, preserve confirmation/receipts, and never turn
remote tool metadata into new Rally authority.

Hosted-MCP reads currently ask for confirmation and are not available to
read-only inline children. A future lower-friction read path needs an
independent Rally-authored policy source. Metadata discovery may issue one
extra 404 request when a server publishes only the root fallback. Hosted MCP
schemas must declare a top-level object, and a pre-call catalog collision blocks
the call rather than choosing by provider list order.

Shipped in the pull request for this change.
