# Authorization

Rally's internal read authorization primitive composes canonical owner facts into
an explicit decision. It serves member search and resource reads. Ordinary read evidence
may lag a permission change by at most five minutes. The module does not admit
participants or become a new canonical owner of memberships.

## Where the code lives

| File under `apps/api/src/` | Responsibility |
| --- | --- |
| `services/authorization-policy.ts` | Typed addresses, subject, four outcomes, proof composition, five-minute bound, `AccessContext` |
| `services/authorization-service.ts` | Member policy, owner reads, request coalescing, cache validation and HTTP disclosure adapter |
| `durable-objects/authorization-storage.ts` | Workspace SQLite snapshots, exact attachment locations and migration tables |
| `durable-objects/authorization-projection.ts` | Transactional child outbox and reference-only Queue contract |
| `services/authorization-projection-service.ts` | Reloads attachment inventories from their owners when jobs execute |
| `durable-objects/workspace-do.ts` | Snapshot publication, resource facts, migration fan-out and discovery status |
| `durable-objects/workstream-do.ts`, `sidekick-do.ts` | Canonical parent/private-child facts; automation author, executor and owning work stream |
| `authorization-control.ts` | Private operator Service Binding entrypoint |

## How it works

A trusted request creates one `AccessContext`. Addresses identify a workspace
and either a conversation `(parentId, substreamId)`, a resource ID, or a memory
scope ID. `checkMany()` returns one exact decision per candidate;
`readableScopes()` additionally reports whether all candidates could be evaluated.
Unused narrowing and source-view helpers are omitted until a production caller
needs them.

Policies are ordinary TypeScript `fact`, `all` and `any` expressions. There is no
policy interpreter, customer-supplied graph language or hosted policy service.
An alternative attachment location can independently grant access. Denial from
one location does not override a valid grant from another.

Member proofs include a canonical regional workspace-membership observation,
coalesced per request and refreshed when its evidence expires. A long-running
request cannot renew resource grants using its original authentication alone.
For member reads, a work stream's main SubstreamAgent owns its scope and roster.
WorkstreamDO adds its canonical private-child membership and ready-state facts.
An automation supplies its own scope, author, executor and child registry; an
owning work stream's canonical roster supplies inherited access. Archived work
streams remain readable. Deleted automations are absent.

WorkspaceDO supplies resource existence, connection ownership, note visibility,
upload ownership and draft status. A resource requiring an attachment is resolved
through exact `(parent, child, resource)` locations. Each potential grant is
checked against both conversation authority and the canonical attachment
inventory. The reverse index is discovery, never sufficient proof of a grant.
This removes the member search path's serial scan of all work streams and all
children. Content and search passages still come from canonical source records.

### Evidence and caches

Every proof carries `owner`, `revision` and `validatedAt`. Its deadline is the
oldest required observation plus `AUTHORIZATION_FRESHNESS_MS = 300_000`.
Evaluation rejects evidence at the deadline and rejects future timestamps.
Composition, Queue delivery, WorkspaceDO reads and KV publication preserve the
observation time. They cannot start a new five-minute lease.

Each request coalesces identical decisions, parent roster reads and child
attachment-inventory reads. Snapshot and resource-fact RPCs batch the page;
remaining distinct owner checks run serially. Expired request promises are evicted
before a new observation, and the completed batch is checked for freshness. WorkspaceDO stores reusable decision snapshots.
Global may read/write the dedicated `AUTHORIZATION_CACHE` KV namespace; EU does
not access it. KV retention is five minutes, but the embedded evidence deadline
is authoritative even when a cache returns an older value. Snapshot publication
in SQLite rejects older observations, and subsequent writes reclaim expired
rows. KV failure falls through to regional authority.

A negative attachment decision requires completed discovery. Its evidence time
comes from the oldest discovered inventory, not the current time on WorkspaceDO.
If that proof expires, the request refreshes canonical inventories once and
re-evaluates the absence proof. This refresh preserves existing Queue receipts;
it neither resets backfill progress nor renews old observation timestamps. A
failed refresh remains unavailable. Positive decisions only need their independently verified
grant path. An old or delayed index cannot manufacture access.

Resource content, versions and previews check freshness again before returning.
This bounds admission of a response; it does not terminate a response body
already being streamed. Search repeats the check after content validation.

### Agent scope adapters

Memory and attachment tools retain their existing canonical host loaders and
execution-principal validation. They do not construct a second authorization
context from the selection they just authorized: that would only check its own
input. The model cannot supply the execution principal. Existing memory
scope selection and connector visibility SQL remain source-specific adapters;
this release does not replace those loaders or their retrieval engines.

### Migration

Child SQLite triggers commit a reference outbox alongside scope, membership and
attachment changes. The existing alarm sends that reference through the regional
activity Queue. Jobs reload current owner state, so queue payloads contain no
text, grants or bearer permissions. WorkspaceDO owns durable discovery jobs and
per-parent/per-child completion receipts. Delivery acceptance is separate from
completion: a child is complete only after its inventory is applied. Delivery
cleanup is revision-fenced so an accepted send cannot erase newer intent, and
new intent preserves Queue failure backoff. Parent discovery prunes retired
children; even delayed child jobs check the current parent registry.

Deployment enables the core member read path for every workspace. There is no
legacy/shadow mode, activation flag or comparison gate. `backfill` queues parent
discovery followed by child inventories; `status` reports completion receipts.
An incomplete attachment lookup automatically schedules missing discovery without
resetting in-progress jobs, and returns retryable `projection_incomplete` until
a canonical grant or complete negative evidence can be established. Explicit
backfill can refresh existing receipts. Source mutations also queue inventory
updates through their transactional outbox.

Completeness remains an evidence requirement for a negative attachment decision,
not a switch controlling which authorization implementation serves the request.

## Invariants

- Canonical owners stay canonical. Retimestamping a projection as authority
  would extend revocations past the agreed five-minute bound.
- The exact internal outcomes are `allowed`, `denied`, `not_found` and
  `unavailable`. `denied` includes a policy reason; `not_found` means a canonical
  owner established absence; `unavailable` carries a retryable reason.
- Only disclosure adapters collapse denial and absence into a concealed HTTP
  404. Direct reads with unavailable authority return HTTP 503. Search and resource
  lists omit unverified candidates, return verified rows with `complete: false`,
  and retain normal pagination. Completeness describes evaluated candidates,
  not whether more pages exist. The desktop marks partial results and offers a
  retry; it does not describe an unverified empty page as "No results". No IDs,
  counts, or source metadata from omitted candidates are returned. Provider-wide
  retrieval errors, cancellation, and failed request authentication still fail
  the request. The desktop advertises `supportsPartialResults: true`: older
  strict response parsers retain their original wire shape and retryable failure
  for incomplete search, rather than silently misrepresenting partial results.
  Resource page parsers already accept additive fields.
- Subject, workspace, exact address and policy version must match cached
  evidence. A record for another user or private child cannot authorize a read.
- The shortest evidence lifetime governs a conjunction. A newer attachment
  observation cannot renew an older membership proof.
- Missing discovery cannot be treated as confirmed absence. Activation before
  coverage is complete would silently omit private-child-only resources.
- Queue writes and resource changes share durable local intent. A crashed
  dispatcher can retry without reconstructing permissions from an old payload.

## Boundary

This module owns read decisions and their derived evidence. Authentication and
active workspace membership are established by request middleware. Agent
execution authority is established by the host, not tool arguments. Existing
creation, mutation, socket admission and participant admission retain their
current authority paths. See [workstream creation](workstream-creation.md),
[agent harness](agent-harness.md), [agent attachments](agent-attachments.md) and
[text search](text-search.md).

`AuthorizationControl` is a named Worker entrypoint intended only for a private
operator Service Binding. It is not mounted on product HTTP and is deliberately
separate from the read-only engineering inspection bridge. Provision that
binding only for trusted operational tooling. No operator caller binding is
provisioned in this PR; product reads and automatic discovery do not require one.

## Failure modes and limits

Owner failures produce retryable `authority_unavailable` and a diagnostic event.
Expired evidence produces `evidence_expired`; missing discovery or an unready
child produces `projection_incomplete`. A KV outage does not change a denial
into a grant. A failed canonical refresh cannot reuse expired evidence.

Reference delivery uses the existing five-second regional outbox retry interval.
Workspace Queue dispatch uses Cloudflare's 100-message batch limit. Neither
number is a permission lease. Queue consumer failures retry and can eventually
reach the configured activity dead-letter queue; incomplete receipts prevent
discovery. An unprovisioned registered child therefore requires repair before
negative attachment evidence is complete; it cannot silently disappear from the backfill.

Absence proofs can require a full inventory refresh after five minutes. This
cost is confined to negative discovery; improving it requires a stronger
completeness protocol, not extending cache TTLs. No production latency target
is inferred from local tests.

## Testing

`test/authorization-policy.test.ts` covers composition, alternate grants,
workspace isolation, exact expiration, future timestamps and explicit incomplete lists.
`test-workers/authorization-storage.test.ts` uses real SQLite migrations for
out-of-order inventory delivery, snapshot expiry and discovery completion.
`test-workers/conversation-parent-contract.test.ts` exercises stale roster
projections and private-child search before and after queued backfill without activation.
Existing memory, attachment-tool, resource-list, identity-authority and search
projection suites cover the retained integration boundaries.

Run the focused Node tests with `pnpm --filter @rally/api exec vitest run` and
runtime tests with the same command plus `--config vitest.workers.config.ts`.
Runtime fixtures must seed regional routing and canonical objects; mocking the
permission answer cannot prove that a stale projection is ignored.

## Regional impact

All owner state, Queue references and WorkspaceDO snapshots stay in their
workspace region. Global Wrangler configuration declares a dedicated KV binding
for provisioning on first deployment. The pinned Wrangler 4.129.0 CLI enables
`experimental-provision` and `experimental-auto-create` by default; its binding
provisioner creates or reuses the named resource. No production deployment was
performed to verify that operation. KV is an optional accelerator, so it is not
in the environment contract's required `productionOnlyBindings` list. EU deliberately has no authorization KV
binding and does not use a Global fallback. See [regionalization](regionalization.md).

## Operations

The private control binding accepts `{workspaceId, action}` where action is
`backfill` or `status`. Regional route validation precedes every operation.
Monitor pending parent/child counts, repair failed sources and replay reference
jobs. No operator activation is required. Proactive backfill avoids retryable
attachment lookups while dormant source inventories are discovered; ordinary
reads also initiate missing discovery. Rolling back the serving implementation
requires a Worker code rollback, not a per-workspace mode change.

## Changelog

### 2026-09-07 — Preserve the workstream access-history migration

Main claimed WorkspaceDO migration 37 for personal workstream access history.
Moved the unmerged authorization migration to 38, preserving both schemas and
main's migration ledger. SubstreamAgent authorization remains migration 44.

### 2026-09-07 — Return verified partial results and remove unused helpers

The team chose useful verified results over failing a whole list for one
unavailable authority. Lists now expose `complete: false`; direct reads retain
retryable failure. Desktop search and resource pickers label incompleteness and
retry without exposing unverified candidates. Removed unused `within()` and
`AuthorizedView` rather than carrying an API without a production caller.


### 2026-09-07 — Preserve Sidekick migrations during rebase

Main moved the automation implementation into SidekickDO and claimed the next
object migration numbers. Authorization facts now live on SidekickDO behind the
existing AutomationDO compatibility export. Authorization uses WorkspaceDO
migration 38 and SubstreamAgent migration 44, preserving main's published schemas.

### 2026-09-07 — Verify review findings against canonical authority

Batched page-level evidence reads and removed unbounded distinct-owner fan-out
because the former batch API issued singleton RPCs for every candidate. Fenced
Queue cleanup against concurrent intent, preserved retry backoff, and reconciled
retired child receipts. Stale absence evidence now refreshes canonical inventories
without resetting Queue progress; this can still require a full workspace scan.
Fixed private-child email loading and archived owning-room automation grants.
Removed host wrappers that merely rechecked their own input. Kept the agreed
five-minute read bound and whole-query retryable failures: silently dropping
unverifiable rows would misrepresent an incomplete result as complete.


### 2026-09-07 — Enable authorization on deployment

Removed per-workspace shadow and activation controls at the team's request so
shipping the code enables one read implementation immediately. Retained exact
permission checks, the five-minute freshness bound and complete negative
evidence. Missing discovery starts through the existing Queue automatically;
repeated reads must not reset already progressing jobs. Operator backfill and
status remain for proactive migration and repair.

### 2026-09-07 — Introduce bounded, composable read authority

Search's source verification repeatedly scanned work streams to discover resource
attachments, while projected membership lacked a reliable freshness boundary.
Introduce explicit owner evidence, exact child attachment discovery and a shared
read context. Keep policy as typed local code rather than introducing Oso Cloud
or a general graph interpreter. Preserve the team's five-minute read bound and
regional ownership. Future changes must not exchange complete discovery or
canonical observation time for a faster but misleading empty result.
