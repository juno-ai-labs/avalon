# Demo MCP

The Demo MCP is the internal MCP server, at
`https://demo-mcp.internal.rallywith.ai/mcp`, through which an authorized
person prepares a demo Organization from Claude, ChatGPT or Cursor. It checks a
scenario pack a client's model wrote, shows it as the presenter will read it,
and starts the same durable preparation operation Ace's **New demo** starts,
from that exact pack. It is not a product API and nobody reaches it through
Rally membership: Cloudflare Access decides who connects.

Read it before changing the Demo MCP's tools, the `DemoAdministration`
entrypoint, how a scenario pack is checked or stored, or which pack an
operation runs from. The operation itself — casting, connection copying,
seeding, readiness, retirement — is [`demo-workspaces.md`](demo-workspaces.md)'s.
The product decisions are in
[the Demo MCP PRD](PRDs/2026-10-03_demo-mcp-organization-creation/prd.md), and
the full tool catalog with every wire shape and failure is its
[`design.md`](PRDs/2026-10-03_demo-mcp-organization-creation/design.md).

## Where the code lives

| Path | Role |
| --- | --- |
| `apps/demo-mcp/` | The `rally-demo-mcp` Worker: Access verification, the ten tools, the deploy provisioner, and its tests. Built on the engineering MCP's skeleton. |
| `apps/demo-mcp/src/server.ts` | The tool registry. `advertised()` hands the MCP SDK a tool's JSON Schema and lets arguments through untouched; the entrypoint parses them. |
| `apps/demo-mcp/scripts/deploy.mjs` | Creates or updates the Demo MCP's own Access application (identity providers and session length from Ace, policy from this application only), then deploys the Worker. |
| `apps/api/src/demo-administration.ts` | `DemoAdministration`, the named `WorkerEntrypoint` the Global API exports: one method per tool, each returning a result envelope. |
| `apps/api/src/services/demo-scenarios.ts` | The check (`checkDemoPack`), the preview (`previewDemoPack`), and the store of immutable pack revisions (`storeDemoPackRevision`, `readDemoPackRevision`). |
| `apps/api/src/services/demo-pack.ts` | `DemoPackSchema`: the playability rules, each tagged with the stable code the check reports (`params.rule`). Owned by [`demo-workspaces.md`](demo-workspaces.md). |
| `packages/contracts/src/demo-pack.ts` | `DemoPackShapeSchema`: every field of a pack without the rules. Lives in contracts so the MCP Worker can advertise it. |
| `packages/contracts/src/demo-administration.ts` | The RPC vocabulary, the advertised scenario reference, and `demoOperationIdForRequest`. |
| `packages/db/migrations/0118_demo_scenario_revisions.sql` | The revision table and the columns an operation records about its pack and its requester. |

## How it works

### The path of one call

An MCP client calls a tool. Cloudflare Access has already run Managed OAuth at
the hostname; the Worker verifies the `Cf-Access-Jwt-Assertion` with the shared
verifier and its own audience, builds a stateless `McpServer`, and forwards the
tool's arguments, as sent, with the verified actor (`{ subject, email }`) to the
`DEMO_ADMINISTRATION` Service Binding. The entrypoint parses the arguments
against the contract, runs the same service functions the `/internal/demos`
routes run, and answers `{ ok: true, value }` or `{ ok: false, code, message,
issues? }`. The Worker renders a refusal as an MCP error result whose text is
that code, sentence and issue list, and logs the actor, the tool, the ids it
targeted and the code.

Arguments are not validated by the MCP SDK. The SDK would answer a mismatch
with Zod's own messages, which can quote what the caller sent — an unknown
key's name, for one — and the rule here is that a refusal never echoes the
caller's data ([`naming-a-schema-failure.md`](naming-a-schema-failure.md)).
`advertised()` gives the SDK a Standard Schema whose JSON Schema is the real one
and whose validation lets everything through; the entrypoint's parse is the one
that counts.

### Checking a pack

`checkDemoPack` takes any value and answers either the normalized pack, its
content hash, a summary and the list of entries it derived, or every issue it
found. In order:

1. The shape, through `DemoPackShapeSchema`. A shape failure is reported by path
   and Zod issue code.
2. The presenter's `expect` entry. When the presenter authors no step in a
   room's main conversation, `demoIdleViewerExpectation` derives their flags and
   the check puts that entry in place of whatever the pack said, listing its
   path in `derived`. When the presenter does act, their flags depend on what
   they did; the pack must state them, and a pack that does not is refused with
   `demo_pack_presenter_expect_required`.
3. `personal` rooms, which the seeder refuses partway through seeding, are
   refused here as `demo_pack_personal_room_unsupported` before anything is
   written.
4. The rules, through `DemoPackSchema`. Each issue carries its rule's code in
   `params.rule`.

Every issue is `{ path, code, message }`. `message` is a fixed sentence per code
from `ISSUE_MESSAGES`, never the schema's own message, which quotes the pack's
values. `path` uses array indexes and declared field names; a key inside
`spaces`, `rooms` or `roleLabels` is the author's data and is shown by its
position, `{n}`.

`check_demo_scenario` adds a Markdown preview (`previewDemoPack`): one section
per Space, rooms in the presenter's sidebar order with what the presenter finds
there, Breakouts under their rooms, then Sidekicks. When the call carries a
cast, the cast is checked exactly as a start checks it (`checkDemoCastEntries`)
and the preview uses the directory's names.

### Which pack an operation runs from

Every new operation, from Ace or from this server, stores the pack it starts
with in `demo_scenario_revisions` and records the revision on its row, and
every phase reads that copy (`operationPack` in `demo-preparation.ts`). The
built-in pack is snapshotted the same way. A deploy that changes the built-in
pack therefore cannot fail a demo that is preparing; `demo_pack_changed` is
raised only for a row written before migration 0118, which has no revision and
still compares its version with the pack in service.

An unnamed revision is unique by content hash, so two operations from the same
bytes share one row, and a refused or repeated request stores nothing new. The
shipped `packVersion` field keeps saying what a demo was made from: the
built-in version for the built-in scenario, `stored:<contentHash>` for a pack
passed whole.

### Creating, following and closing a demo

`create_demo_organization` derives the operation id from the actor's Access
subject and the client's `requestKey` (`demoOperationIdForRequest`, a version-8
UUID over SHA-256). If that operation exists, it is answered at once — before
the scenario is resolved, checked or stored and before the cast is read — which
is `startDemoOperation`'s own rule for a repeated operation id. Otherwise the
scenario is resolved (the built-in pack, a stored revision, or an inline pack
checked as above) and `startDemoOperation` runs as it does for Ace, with the
pack, the request key and the requester.

`get_demo_operation` and `list_demo_operations` return the shipped
`DemoOperationStatusSchema`, every field, plus fields only this server reads:
the request key, the stored revision and its hash, who asked, `recovery` (the
tool that recovers a failure: `abandon_demo_operation` for a seeded run's own
failure and for `demo_pack_changed`, which a retry replays into the same
failure, otherwise `retry_demo_operation`), and, for one operation, `notices`:
a Ready demo whose presenter has `multiple-workspaces-enabled` off cannot be
switched to, and the notice says so.

`retry_demo_operation` takes the attempt the caller read and refuses with
`demo_operation_changed` when the row has moved past it, so a retry repeated
after a lost response does not supersede the driver the first one launched.
`abandon_demo_operation` is the shipped abandon. `retire_demo_organization`
retires only a workspace an operation published, and only when the caller
repeats its exact name; it then calls the same operator retirement as Ace's
workspaces tab.

## Invariants

- **Seed text reaches the seeder only through this entrypoint or the checked-in
  pack.** A pack this server stores has passed `DemoPackSchema`; there is no
  path that stores or runs an unchecked one. Guard: the entrypoint tests refuse
  an invalid inline pack and assert nothing was written.
- **Every new operation runs from a stored revision.** Without it a deploy fails
  demos in flight again. Guard: "runs every phase from the pack it stored" in
  `demo-operations.test.ts`.
- **A revision is never updated.** `pack_json` is what the demo was made from;
  changing it would make an operation's record untrue. No code path updates the
  table; nothing enforces it beyond that.
- **A repeated create is answered before anything is checked or stored.**
  Checking a repeat against a directory or pack that has moved would refuse a
  retry of a preparation that is running fine. Guard: the replay test, which a
  repeat with an invalid pack must pass.
- **A refusal never echoes the caller's data.** Fixed sentences per code,
  record keys by position, and SDK validation bypassed. Guard:
  `demo-scenarios.test.ts` asserts a refusal contains neither the bad role nor
  the unknown key.
- **The shipped status contract does not change.** Ace parses
  `DemoOperationStatusSchema` strictly; a new field on it would break the Demos
  list the moment an MCP-made demo appeared. Additions live on
  `DemoAdministrationOperationSchema`. Guard: the test that lists an MCP-made
  operation through `/internal/demos` and parses it with Ace's schema.
- **Every answer is an envelope.** A Worker RPC reduces a thrown error to a bare
  `Error`; a code that does not cross is a generic failure on the MCP side.
- **This server retires only what demo preparation published.** Guard: the
  retirement test refuses the template, an unpublished candidate and a wrong
  name.

## Boundary

This module owns the MCP surface, the entrypoint, the check and preview, and
the revision store. It does not own preparing a demo
([`demo-workspaces.md`](demo-workspaces.md)), closing a workspace
([`workspace-retirement.md`](workspace-retirement.md)), the pack's playability
rules (`demo-pack.ts`, also [`demo-workspaces.md`](demo-workspaces.md)), or the
Access verifier it shares with Ace, the engineering MCP and the migration
tracker. It never calls a model, changes a flag, runs SQL, or reads a
credential. The only caller of `DemoAdministration` is the `rally-demo-mcp`
Worker, through its Service Binding.

The PRD's second phase — a named, shared scenario library
(`save_demo_scenario`, `archive_demo_scenario`) and choosing which template
connections a demo receives (`list_template_connections`) — is not built. It
waits until somebody asks; the table's `scenario_id` and `revision` columns are
reserved for it and NULL on every row.

## Failure modes and limits

- **The API does not answer.** The binding throws; the tool answers
  `regional_unavailable` and the model is told to try again once.
- **A call outside Global.** Every method answers `demo_region_unsupported`.
- **An internal fault.** `demo_administration_internal_error`, with the error's
  text in the `demo_administration_failed` log line rather than in the answer.
- **A pack larger than a D1 row.** The insert fails with the platform's error
  and the call answers `demo_administration_internal_error`. No size cap of this
  module's own exists; D1's published row limit is the ceiling.
- **The presenter's flag cannot be evaluated.** A missing or failing `FLAGS`
  binding reads as off, so the notice errs toward warning.
- **Nobody can connect.** The Access application has no policy; see
  **Operations**.

There are no limits of this module's own: no page size, rate, or pack size.

## Testing

| Suite | What it proves |
| --- | --- |
| `apps/api/test/demo-scenarios.test.ts` | The check: the built-in pack passes unchanged; an idle presenter's view is derived and replaces a wrong one; an acting presenter without an entry is refused rather than thrown on; a rule is reported by code with a fixed sentence; a record key is shown by position; a shape failure leaks neither the value nor an unknown key's name; a personal room is refused. The preview's text for a small pack. |
| `apps/api/test/demo-operations.test.ts` | Against the real migrations: every phase runs from the stored pack whatever the pack in service is, a pre-0118 row still meets `demo_pack_changed`, and two operations from one pack share one revision. The entrypoint: one demo per request key, a repeat (even with an invalid pack) stores and launches nothing; an invalid pack is refused with its issues and writes nothing; a shipped refusal crosses by its code; Ace's strict parse accepts an MCP-made operation; a repeated retry starts no second attempt; recovery and the presenter-flag notice; retirement refuses what preparation did not publish and a wrong name; every call outside Global is refused. Each was proved to fail with its production check removed. |
| `apps/api/test-workers/demo-preparation.test.ts` | The whole operation on real objects, now with the revision table declared; its fixture and `test-workers/helpers/demo-workspace-fixture.ts` follow migration 0118's columns. |
| `apps/demo-mcp/test/server.test.ts` | The real Agents SDK handler with a double for the Global binding: the tool list and annotations, the advertised pack shape, arguments forwarded untouched with the verified actor (proved to fail when the SDK validates them), a refusal rendered with its issues and logged by code only, and a binding that did not answer. |

## Data model

| Where | Table | Holds |
| --- | --- | --- |
| Global D1 | `demo_scenario_revisions` | One row per distinct pack an operation started from: the normalized `pack_json`, its SHA-256 `content_hash` (unique among unnamed revisions), who stored it, and when. `scenario_id` and `revision` are for the phase-2 library. |
| Global D1 | `demo_operations` | Gains `scenario_revision_id`, `request_key`, `requested_by_subject` and `requested_by_email`. The rest is [`demo-workspaces.md`](demo-workspaces.md#data-model)'s. |

## Regional impact

Global only. The Worker has one Service Binding, to `avalon-api-global`, and no
fan-out. Every regional API exports `DemoAdministration`, and outside Global
every method refuses. Pack text, which may name a prospect, rests in Global D1
and in the demo Organization's own objects.

## Security and trust model

Cloudflare Access is the only authority on who connects. The Worker verifies
the assertion's signature, issuer and its own audience; an Ace token or an
engineering MCP token is refused. Through this server an operator can create
demo Organizations owned by a template member, seat colleagues or personas in
them, have the template's shareable Google connections copied in, and retire
what demo preparation published. They cannot run SQL, change flags, retire
another workspace, or read credential material.

The actor the entrypoint records is the one the Worker verified; the
entrypoint cannot verify it and trusts the binding. The recorded operator is
therefore only as trustworthy as `rally-demo-mcp`.

A pack this server runs was reviewed by its operator, not by a pull request,
and its text may have been written by a model from material the operator
supplied. It becomes transcript history in a workspace whose live turns can
call the copied Google connections. What bounds that: the copies reach only the
demo Google accounts the template holds; seeded text gains no authority by
being seeded; and each revision and operation records who stored and started
it. A colleague cast in a custom scenario is not told; the PRD keeps that open.

The Worker logs the actor, the tool, the ids a call targeted and the outcome
code. Pack text, cast names, previews and messages never enter its logs.

## Operations

**Connecting a client.** Add `https://demo-mcp.internal.rallywith.ai/mcp` as a
remote MCP server in Claude (Settings → Connectors), Claude Code
(`claude mcp add --transport http rally-demos https://demo-mcp.internal.rallywith.ai/mcp`),
ChatGPT or Cursor, and complete the company sign-in Access opens. The steps,
the `401` readiness check and the troubleshooting in
[`internal-admin-mcp-server.md`](internal-admin-mcp-server.md) apply with this
hostname; there is no service token or cookie to copy.

**Who may connect.** The Access application `Rally demo MCP` has its own
policy, set by hand in Cloudflare Access and preserved by every deploy. The
deploy never copies Ace's. Until a policy exists nobody can connect, and the
deploy job prints a warning saying so.

**A first session.** `list_demo_scenarios`, then `get_demo_scenario` with
`builtin:multiplayer`, edit, `check_demo_scenario` until `ok`, then
`list_demo_cast_candidates` and `create_demo_organization`, and follow it with
`get_demo_operation`. A failed operation's `recovery` names the next tool.

**What to look at.** `demo_mcp_tool_failed` lines in the Worker's logs carry the
code; `demo_administration_failed` in the Global API's logs carries an internal
fault's text. The operation's own phases and gaps are where
[`demo-workspaces.md`](demo-workspaces.md#preparing-a-demo) says.

## Changelog

### 2026-10-03 — A demo can be prepared from any checked pack, through an MCP server of its own

**What changed:** The `rally-demo-mcp` Worker and the Global API's
`DemoAdministration` entrypoint, with ten tools: list, read and check
scenarios (the check returns a preview), list cast candidates, create a demo
from the built-in pack, a stored revision or an inline pack, and list, follow,
retry, abandon and retire operations. Every new operation stores the pack it
starts with and runs from it. The pack's shape moved to
`packages/contracts/src/demo-pack.ts`, and every rule in `DemoPackSchema`
carries a stable code.

**Why:** Every demo showed the same company, a scenario changed only by pull
request and deploy, a deploy failed demos in flight, and the only door was Ace,
whose Access policy is also flag administration and workspace retirement. The
PRD records the case.

**Considered and rejected:** Tools on the engineering MCP, whose Access policy
is Ace's and which carries a SQL console; template variables inside packs,
which cannot add or remove a room; a server that writes scenarios with a model;
an MCP-specific status shape, which Ace's strict parse would refuse; the HTTP
operator route with a bearer token, which adds a secret to rotate; letting the
SDK validate arguments, which echoes the caller's keys.

**Consequences:** Seed text no longer passes code review before it runs; the
check, the template's containment and the recorded operator are what bound it.
The scenario library and connection selection are not built and wait for a
request (the PRD's phase 2). A future change to `DemoOperationStatusSchema`
must remain readable by Ace's deployed parser. Shipped in the change that adds
this document.
