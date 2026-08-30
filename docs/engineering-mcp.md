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
custom hostname. The origin independently verifies the signed
`Cf-Access-Jwt-Assertion`, including issuer and this application's dedicated
audience. A verified request reaches the stateless MCP handler; every other
request fails closed.

The Worker has two named Service Bindings, one to
`avalon-api-global#EngineeringInspectionBridge` and one to
`avalon-api-eu#EngineeringInspectionBridge`. Every ID-based tool asks both
regions concurrently. Exactly one may answer `found`; neither is a not-found
error and both is an ambiguity error. This means the MCP Worker never guesses a
region or silently prefers Global.

The regional bridge uses D1 only for identity and routing:

| Tool | Route lookup | Authoritative read or write |
| --- | --- | --- |
| `list_workspaces` | Regional `workspaces` plus the workspace authority ledger | D1 identity inventory from both regions |
| `list_workstreams` | Workspace ID and workspace authority ledger | `workspace_workstream_directory` in WorkspaceDO |
| `list_substreams` | `workstream_authority_routes.object_name` | `substream_directory` in WorkstreamDO, plus main substream `0` |
| `run_workspace_sql` | Workspace ID and workspace authority ledger | WorkspaceDO SQLite |
| `run_workstream_sql` | `workstream_authority_routes.object_name` | WorkstreamDO SQLite |
| `run_substream_sql` | Work-stream route and child directory membership | SubstreamAgent SQLite |

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
- The bridge checks regional routing before obtaining a stub, so a wrong-region
  lookup cannot create an empty Durable Object.
- A target found in both regions is refused rather than selected.
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
but no automation MCP tool is registered. BlockDashboardAgent does not inherit
the scheduler and remains outside this inspection surface.

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

`apps/engineering-mcp/test/server.test.ts` exercises the actual MCP protocol
handler, tool discovery, cross-region aggregation, destructive annotations, and
the fail-closed duplicate-region result. Existing Access tests own JWT
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
configuration and HTTPS redirect allowlist; changing those values remains an
explicit Access administration decision.

## Changelog

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
