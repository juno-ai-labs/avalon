# Engineering MCP

The engineering MCP is Rally's authenticated operator path to the authoritative
SQLite database inside a workspace, work stream, or substream Durable Object.
It recreates the useful part of Cloudflare's dashboard database console through
standard MCP tools at `https://mcp.internal.rallywith.ai/mcp`, including deliberate
repair writes. It is not a product API and it is never available to Rally users
by virtue of product membership.

## Where the code lives

- `apps/engineering-mcp/` is the public MCP Worker, Cloudflare Access verifier,
  tool registry, deployment provisioner, and its tests.
- `apps/api/src/engineering-inspection-bridge.ts` is the private named
  `WorkerEntrypoint` exported by each regional API Worker.
- `apps/api/src/durable-objects/internally-inspectable-durable-object.ts` owns
  the shared raw-SQL Durable Object RPC.
- `apps/api/src/durable-objects/scheduled-alarms.ts` makes every scheduled
  authority inherit that RPC. WorkspaceDO, WorkstreamDO, SubstreamAgent, and
  AutomationAgent therefore have the capability, although this MCP initially
  routes only the first three.
- `packages/contracts/src/engineering-inspection.ts` is the runtime-validated
  RPC vocabulary shared by both Workers.
- `.github/workflows/deploy-api.yml` deploys this Worker only after both
  regional API entrypoints are live and healthy.

## How it works

Cloudflare Access terminates MCP OAuth and Dynamic Client Registration at the
custom hostname. Dynamic registration accepts installed-client loopback
callbacks and hosted callbacks under the supported Claude, ChatGPT, and Cursor
origins. The MCP transport admits those same hosted request origins after
authentication. The origin independently verifies the signed
`Cf-Access-Jwt-Assertion`, including issuer and this application's dedicated
audience. A verified request reaches the stateless MCP handler; every other
request fails closed.

The Worker has two named Service Bindings, one to
`avalon-api-global#EngineeringInspectionBridge` and one to
`avalon-api-eu#EngineeringInspectionBridge`. Every ID-based list tool asks both
regions concurrently. SQL tools first ask both regions to resolve the target
without executing SQL, require exactly one answer, and then send SQL only to
that binding with the resolved authority generation. The regional bridge
revalidates that generation immediately before obtaining the object stub.
Neither region finding a target is a not-found error; both finding it is an
ambiguity error. This means the MCP Worker never guesses a region, silently
prefers Global, or mutates both sides of a duplicate route.

The regional bridge uses D1 only for identity and routing:

| Tool | Route lookup | Authoritative read or write |
| --- | --- | --- |
| `list_workspaces` | Regional `workspaces` plus the workspace authority ledger | D1 identity inventory from both regions |
| `list_workstreams` | Active workspace route at the open regional authority generation | `workspace_workstream_directory` in WorkspaceDO |
| `list_substreams` | Active work-stream route at the open regional authority generation | `substream_directory` in WorkstreamDO, plus main substream `0` |
| `run_workspace_sql` | Resolve, select one region, then revalidate the active workspace route generation | WorkspaceDO SQLite |
| `run_workstream_sql` | Resolve, select one region, then revalidate the active work-stream route generation | WorkstreamDO SQLite |
| `run_substream_sql` | Resolve the active work-stream route and child directory membership, select one region, then revalidate | SubstreamAgent SQLite |

`run_substream_sql` takes workspace, work-stream, and substream IDs. The parent
IDs are not redundant: all three are part of the Durable Object's stable name.
`list_substreams` returns the complete tuple so an MCP client can pass it to the
SQL tool without reconstructing identity.

The shared Durable Object base waits for the object's checked-in migrations,
runs the supplied statement through `ctx.storage.sql.exec`, and returns column
names, JSON-safe rows, and the platform's physical `rowsRead` and `rowsWritten`
counters. SQLite BLOB results are represented as `{ type: "blob", base64 }`.

## Invariants and contracts

- D1 locates authority; it never substitutes for Durable Object product state.
- The bridge accepts only an `active` route in the current
  `durable_object_open` generation with a compatible serving contract. Pending,
  importing, verified, quarantined, and stale-generation routes cannot obtain a
  Durable Object stub.
- SQL resolves both regions without mutation, refuses a duplicate target, and
  executes against exactly one selected binding. The selected bridge rechecks
  the generation so a cutover between resolution and execution fails closed.
- Main substream `0` needs no directory row: route activation happens only after
  creation or import initializes that object. Child substreams still require a
  directory membership row before their stub is obtained.
- The origin verifies Access JWT provenance. A header's presence alone is not
  authentication.
- The Access application is separate from Ace and has its own audience, while
  its policy and allowed identity providers are copied from Ace at deployment.
- SQL tools are annotated non-read-only, destructive, and non-idempotent. The
  list tools are read-only.
- The SQL text, bindings, returned rows, and error message never enter Worker
  logs. Audit events contain Access subject/email, tool name, target IDs, and a
  fixed outcome code only.
- The private regional entrypoint has no HTTP route. Only a Worker with the
  named Service Binding can call it.

## Boundaries and non-goals

This is an unrestricted engineering console, not a domain RPC. It intentionally
permits schema reads, arbitrary queries, and mutations because production
inspection and repair are the product requirement. Product code must continue
to use typed domain RPCs and must never depend on this surface.

AutomationAgent inherits inspection through the requested scheduler hierarchy,
but no automation MCP tool is registered.

The Worker does not retain query history, cache results, copy databases, or
provide a D1 fallback. It also does not turn Access identity into Rally product
identity or authorization.

## Failure modes and limits

- A missing or invalid Access assertion returns a refusal from the origin; an
  unauthenticated MCP client receives Cloudflare Access's OAuth challenge before
  reaching it.
- A missing D1 route returns not found without creating an object.
- A SQLite error is returned to the authenticated caller and logged only as the
  fixed `tool_failed` code.
- A regional Service Binding failure fails the tool. There is no one-region
  fallback because the absent response could hide an ambiguous identity.
- There is no repository-defined query, row, statement, or execution limit.
  Cloudflare's current Worker RPC and response limits are the effective ceiling;
  adding a defensive limit requires a separately chosen product value.

## Testing

`apps/api/test-workers/engineering-inspection.test.ts` calls the inherited RPC
on real WorkspaceDO, WorkstreamDO, and SubstreamAgent instances under workerd.
It proves bound writes, reads, SQLite metadata, and BLOB serialization.

`apps/engineering-mcp/test/server.test.ts` exercises the production Agents SDK
MCP handler, tool discovery, cross-region aggregation, destructive annotations,
single-region SQL execution, and proof that a duplicate-region resolution makes
no SQL call. `apps/api/test/engineering-inspection-routes.test.ts` exercises the
checked-in regional D1 schema and proves that lifecycle, serving-contract, and
generation fences admit only the current active authority. Existing Access tests own JWT
signature, issuer, audience, cookie, and header verification because this
Worker imports that one verifier rather than forking it.

The deployment workflow dry-runs the MCP bundle during verification and, after
deployment, requires a non-browser `401` carrying an OAuth protected-resource
challenge.

## Regional impact

This subsystem is an explicit operator exception to Rally's ordinary
no-cross-region-content rule. An Access-authorized engineering query can return
EU Durable Object content through the shared MCP Worker and onward to the
operator's MCP client. Neither the MCP Worker nor Global D1 persists that
content, and query material is excluded from logs. The exception exists only
for deliberate engineering inspection; no product request may traverse it.

Both regional API Workers execute SQL locally against their own D1 routes and
Durable Objects. The shared Worker never receives a database handle or a copy of
the SQLite file, only the requested result.

## Security and trust model

Cloudflare Access is the identity and policy authority. Managed OAuth supplies
standards-based authorization and Dynamic Client Registration for remote MCP
clients; the deployment enables loopback redirect registration for installed
clients. Access reuses the same configured identity provider and admission
policy as Ace, but the distinct application/audience prevents an Ace token from
being replayed at the MCP origin.

The SQL capability is production-destructive by design. Access membership is
therefore equivalent to database-console access across both Rally regions.
Policy changes, identity-provider changes, and client approval belong in the
Cloudflare Access application, not in application code.

## Operations

Normal rollout is the API production workflow. It verifies the entire revision,
deploys and health-checks EU before Global, then provisions the Access
application, injects its audience into an ephemeral Wrangler config, and deploys
the MCP Worker. A manual deployment that selects only one region skips the MCP
step, preserving its last known pair of compatible regional entrypoints.

Operator connection instructions for Codex, Claude Code, and Cursor Desktop,
including the first safe schema query and OAuth troubleshooting, live in
[`internal-admin-mcp-server.md`](internal-admin-mcp-server.md).

The provisioner requires `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`. It requires the existing Ace Access application as the
policy, identity-provider, and session-duration source; missing source state is
a deployment failure, not permission to create a broader policy. Generated
configuration contains the Access audience, is owner-readable, and is removed
after Wrangler exits. Redeployment preserves an existing Managed OAuth grant
configuration and administrator-added HTTPS redirect allowlist entries. It also
ensures the supported Claude, ChatGPT, and Cursor hosted origins remain present.
Changing that managed provider list remains an explicit Access administration
decision.

## Changelog

### 2026-09-03 — Engineering inspection exposes no HyperSight controls

**What changed:** HyperSight configuration and runtime concepts were removed
from the documented engineering inspection surface.

**Why:** An operational interface must reflect live authorities; retaining
retired controls would invite writes that no product path can observe.

**Consequences:** Existing regional and read-only inspection boundaries are
unchanged.

Shipped in #541.

### 2026-08-30 — Admit hosted origins to the MCP transport

**What changed:** The stateless MCP handler now admits request `Origin` headers
from the supported Claude, ChatGPT, and Cursor hosted providers. Redirect URI
patterns and transport-origin hostnames now share one checked-in provider
registry.

**Why:** Managed OAuth successfully authorized Claude Code on the web, but the
Agents SDK rejected Claude's subsequent MCP handshake because its default
origin policy for a custom domain admits only localhost-class origins. Claude
reported the resulting `403` as an authorized account with no MCP server.

**Considered and rejected:** Disabling origin validation with `"*"` was rejected
because the Access redirect policy already defines the hosted providers Rally
intends to trust. Maintaining a second provider list inside the Worker was
rejected because it would drift from the deployment allowlist.

**Consequences:** Hosted handshakes from the registered providers reach the MCP
server after Access authentication. Other browser origins remain rejected, and
adding a provider requires one registry change that updates both OAuth
registration and transport admission.

### 2026-08-30 — Admit hosted MCP clients through Managed OAuth

**What changed:** The Access provisioner now permits Dynamic Client Registration
callbacks on every path under the hosted Claude, ChatGPT, and Cursor origins,
while retaining installed-client localhost and loopback callbacks and preserving
administrator-added HTTPS entries.

**Why:** Claude Code on the web registered through an Anthropic-hosted callback,
but the initial Access application admitted only callbacks on the user's own
machine. Client registration therefore failed before company sign-in.

**Considered and rejected:** A single exact Claude callback was rejected because
hosted clients can move callback paths and the operator requirement is to admit
all supported hosted surfaces. An undocumented global HTTPS wildcard was
rejected because Cloudflare documents path wildcards only after a concrete
HTTPS origin.

**Consequences:** Any OAuth client hosted on an admitted provider origin can
dynamically register, but it still receives no database access unless the user
passes the Ace-derived Cloudflare Access policy. Adding another hosted provider
requires a provisioner change and deployment.

### 2026-08-30 — Fence SQL execution behind read-only regional resolution

**What changed:** SQL tools now resolve both regional authorities before they
execute, select exactly one Service Binding, and pass its authority generation
back for a final regional check. All object-routing lookups now require an
active route in the current open, serving-compatible generation. The Access
provisioner now paginates both application and policy inventory, and BLOB
serialization uses bounded chunks instead of per-byte string growth.

**Why:** The first implementation issued SQL to both regions concurrently and
only rejected ambiguity after both calls returned. A duplicate route could
therefore apply one destructive statement twice, and maintenance or stale
routes could address an object that was not the current serving authority.

**Considered and rejected:** Running read-only SQL in both regions and parsing
the statement was rejected because SQLite text is not a reliable capability
boundary and the tools deliberately permit arbitrary statements. Choosing the
first successful region was rejected because a second route is an authority
defect that must remain visible.

**Consequences:** Every SQL call adds one read-only regional resolution round
trip before execution. If authority changes between those phases, the tool
fails without issuing SQL and the operator must retry against the new route.

### 2026-08-30 — Add the Access-protected cross-region SQLite console

**What changed:** Rally gained a stateless remote MCP Worker with six initial
inventory and SQL tools, a private named bridge in both regional API Workers,
and a shared inspectable Durable Object superclass beneath the scheduler.

**Why:** Cloudflare's dashboard can inspect one Durable Object SQLite database,
but engineering agents need the same capability through an authenticated,
discoverable protocol and must be able to find the correct object across both
regions without guessing its name or jurisdiction.

**Considered and rejected:** Cloudflare account APIs were not used as the data
path because they do not expose the dashboard's live arbitrary Durable Object
SQL console as a supported application API. Copying product tables back to D1
would create a second authority. HTTP routes on each object, a shared secret,
and product OAuth were rejected because they widen the raw-SQL boundary or mix
operator identity with Rally membership.

**Consequences:** Access admission now grants deliberate destructive database
console authority across Global and EU. The MCP must deploy after both named
regional entrypoints, raw query material must never be logged or persisted, and
future product callers must not reuse the inspection RPC in place of a typed
domain contract.
