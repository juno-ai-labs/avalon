# Authorization

Rally's internal read authorization primitive composes canonical owner facts into
an explicit decision. It serves member search and resource reads. Search trusts projected decisions across requests; other consumers use canonical resolution. Five-minute authorization freshness is a design goal, not a read deadline. The module does not admit
participants or become a new canonical owner of memberships.

## Where the code lives

| File under `apps/api/src/` | Responsibility |
| --- | --- |
| `services/authorization-policy.ts` | Typed addresses, subject, four outcomes, proof composition, evidence validation, `AccessContext` |
| `services/search-authorization.ts` | KV/regional search decisions, read-through misses and mutation-driven push |
| `services/authorization-service.ts` | Member policy, batch-local owner observations and HTTP disclosure adapter |
| `durable-objects/authorization-storage.ts` | Exact attachment locations, inventory revision ordering and shipped migration tables |
| `durable-objects/search-authorization-projection.ts` | Workspace mutation triggers, coalesced push outbox and Queue dispatch |
| `durable-objects/authorization-projection.ts` | Transactional child outbox and reference-only Queue contract |
| `services/authorization-projection-service.ts` | Reloads attachment inventories from their owners when jobs execute |
| `durable-objects/workspace-do.ts` | Legacy snapshot compatibility validation, resource facts, migration fan-out and discovery status |
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
shared within one authorization batch. Canonical checks reload facts. Search instead reuses a subject-and-resource decision from the regional projection.
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

### Evidence and read lifetime

Every proof carries `owner`, `revision` and `validatedAt`. Observation timestamps
are diagnostic: old evidence does not become unavailable merely because time has
passed. Future timestamps and empty grants remain invalid. Five-minute freshness
is a design goal for propagation and performance, with no code-enforced timeout,
lease duration, or permission-expiration timer.

Canonical authorization checks load owner facts; search cache hits do not. Duplicate resources and shared owners reuse observations within that batch only,
including completed observations. Every later or concurrent check starts its own
batch and observes the owner again. Search admits each source's candidate batch
once before loading and formatting its canonical content; it does not recheck
after each await. Resource-fact RPCs batch the
requested resources. The evaluator, typed addresses and four outcomes are shared
primitives; source loaders remain responsible for their canonical facts.
Automation and inherited workstream identity observations also share this batch
lifetime. Member search exposes candidate continuation even when no candidate on
that page is admitted. This preserves bounded page work and explicit continuation;
it does not promise to conceal the existence of matching index entries. The
position is a deterministic hash and can be correlated with a known source ID.
Content and resource details still require admission. This is the member-only
pagination contract, not a claim that hashing prevents existence inference.
A resource returns after its first valid attachment grant; unrelated
alternative locations do not need to be read once access is established.

Search decision snapshots use Global `AUTHORIZATION_CACHE` KV, with WorkspaceDO
SQLite as the regional fallback (including EU). Keys hash the schema version,
workspace, user, delegation and exact resource address. New keys never read the
legacy snapshots. A miss resolves canonical authority once and stores allowed,
denied or not-found decisions. Cache hits never recheck owners or schedule work.
There is no TTL, age-based denial, or periodic/demand-driven refresh. Relevant
WorkspaceDO row mutations and accepted child inventory deliveries transactionally
record a coalesced push intent. The alarm sends a reference-only
`search_authorization_push_v1` target job to the regional activity queue.
The consumer reloads registered subjects' canonical decisions and publishes
replacements through WorkspaceDO, which orders SQLite and KV publication.
Unavailable owners preserve the previous decision and retry through the queue.
Push jobs identify a changed parent, resource or connection. The registry selects
matching resource addresses, recorded owner dependencies and current attachment
locations, so new grants and removed grants both reach their keys. Pending
mutations coalesce per target. Misses register their key before loading owners,
so concurrent source changes can reach a decision being populated.
Changes reach cached grants and denials without another search. This deliberately
accepts eventual consistency for grants and revocations, including queue and KV
propagation delay. Five minutes remains a design goal, never a refresh trigger.

A cache-admitted message or link uses `readAdmittedSearchContent`, an internal
content-only RPC that checks the object address and waits only for storage
readiness. It does not seat an automation viewer, resolve parent authority again,
or call product authorization. Canonical revision/hash checks and passage
extraction remain. Normal product reads continue through their own access path.
Legacy snapshot RPCs remain inert for rolling compatibility; the shipped SQLite
table is reused under the new key prefix and must not be dropped. EU never reads
Global KV.

The attachment reverse index remains Queue-maintained discovery, never a grant.
Each positive attachment path is checked against its current canonical owner.
Completed negative discovery is usable regardless of observation age; source
changes queue new inventories. Delayed projection can delay a newly available
resource, so five minutes is a propagation goal rather than a guaranteed bound.
Missing discovery queues the existing backfill and returns unavailable until a
canonical grant or completed negative discovery exists. Reads never synchronously
walk all workspace parents to refresh discovery because a timestamp aged.

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
  would misrepresent when canonical authority was observed.
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
- Checks bind canonical observations to the trusted subject, workspace and exact
  resource address. A record for another user or private child cannot authorize a
  read. Policy-version validation remains only in the legacy snapshot wire schema.
- Composition preserves each owner observation; it does not rewrite timestamps.
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
Invalid future evidence produces `evidence_invalid`; missing discovery or an unready
child produces `projection_incomplete`. Observation age alone produces no error.

Reference delivery uses the existing five-second regional outbox retry interval.
Workspace Queue dispatch uses Cloudflare's 100-message batch limit. Neither
number is a permission lease. Queue consumer failures retry and can eventually
reach the configured activity dead-letter queue; incomplete receipts prevent
discovery. An unprovisioned registered child therefore requires repair before
negative attachment evidence is complete; it cannot silently disappear from the backfill.

A dead-lettered projection after discovery completes can leave a newly shared
resource denied indefinitely, until that projection is repaired or another source
mutation republishes it. There is no age-triggered self-heal. Repair the failing
consumer or source first, then replay the reference-only authorization jobs from
the regional activity dead-letter queue. For a workspace-wide rebuild, trusted
operator tooling can call `AuthorizationControl.execute({ workspaceId, action:
"backfill" })`; it invokes `beginAuthorizationBackfill` with refresh enabled by
default and queues fresh canonical inventories. Poll `action: "status"` until
coverage completes. This operator binding must be provisioned first; it is not a
product endpoint. The removed synchronous `refreshAuthorizationDiscovery` helper
was internal to the Worker and had no operational caller; repair stays asynchronous.

Cache misses and mutation-driven projection still cost canonical RPCs. Cache-hit hydration avoids
those calls; this change does not claim
the production p50/p90 search goals are met. Measure the complete app path after
deployment, including permission changes and delayed Queue delivery.

## Testing

`test/authorization-policy.test.ts` covers composition, alternate grants,
workspace isolation, aged evidence, future timestamps and explicit incomplete lists.
`test-workers/authorization-storage.test.ts` uses real SQLite migrations for
out-of-order inventory delivery, ignored legacy grants and discovery completion.
`test-workers/conversation-parent-contract.test.ts` exercises stale roster
projections and private-child search before and after queued backfill without activation.
Existing memory, attachment-tool, resource-list, identity-authority and search
projection suites cover the retained integration boundaries.

Run the focused Node tests with `pnpm --filter @rally/api exec vitest run` and
runtime tests with the same command plus `--config vitest.workers.config.ts`.
Runtime fixtures must seed regional routing and canonical objects.
`test-workers/search-authorization.test.ts` covers old KV decisions without owner
reads, initial population, regional persistence, and mutation outbox delivery.
The conversation contract test proves a cached grant stays usable until a push
publishes revocation. Deliberately disabling cache reuse, publication, and queue
delivery makes the corresponding regression tests fail.

## Regional impact

All owner state, Queue references and WorkspaceDO snapshots stay in their
workspace region. Global Wrangler configuration declares a dedicated KV binding
for provisioning on first deployment. The pinned Wrangler 4.129.0 CLI enables
`experimental-provision` and `experimental-auto-create` by default; its binding
provisioner creates or reuses the named resource. No production deployment was
performed to verify that operation. KV stores Global search decisions when bound;
regional SQLite provides the fallback. The binding is therefore absent from the
environment contract's required `productionOnlyBindings` list. EU deliberately has
no authorization KV binding and does not use a Global fallback. See [regionalization](regionalization.md).

## Operations

The private control binding accepts `{workspaceId, action}` where action is
`backfill` or `status`. Regional route validation precedes every operation.
Monitor pending parent/child counts, repair failed sources and replay reference
jobs. No operator activation is required. Proactive backfill avoids retryable
attachment lookups while dormant source inventories are discovered; ordinary
reads also initiate missing discovery. Rolling back the serving implementation
requires a Worker code rollback, not a per-workspace mode change.

### Measuring propagation

`authz_push_timing` is a content-free Workers Logs diagnostic for every queue
attempt. `mutation_to_write_ack_ms` measures the oldest coalesced mutation through
successful publication of the selected decisions. It is populated only for a
completed attempt that wrote keys. Failed attempts report
`elapsed_since_mutation_ms` instead; no-key and fully superseded attempts are not
latency successes. `store` distinguishes Global `kv` from `regional_sqlite`.

The source attachment/roster outbox persists its first mutation timestamp and
carries it through discovery into the WorkspaceDO outbox (`timing_origin =
source_mutation`). Workspace-owned changes start in the WorkspaceDO transaction
(`workspace_mutation`). Directory effects without an originating timestamp also
start when their WorkspaceDO projection changes; their upstream delivery is not
included. Keep these origins separate when assessing another platform consumer.
Existing queued jobs without timing report null totals, not fabricated zeros.
Coalescing and transport retries preserve the oldest pending timestamp. No timer
refreshes decisions, and instrumentation adds no cache-read or authority check.

Useful fields are `outbox_ms` (source mutation through final queue dispatch,
including earlier projection hops), `queue_ms` (dispatch through this attempt,
including retries), `selection_ms`, `resolve_ms`, `kv_write_ms`, `duration_ms`,
`selected_keys`, `written_keys`, `superseded_keys`, `attempt`, and `outcome`.
Publication RPCs return acknowledged counts; a failed RPC does not claim writes
whose response was lost. `kv_write_ms` sums acknowledged publication RPCs' KV
call time; `duration_ms` includes RPC transport and all other processing.

In Workers Logs, filter `event = authz_push_timing`, `store = kv`,
`outcome = completed`, and non-null `mutation_to_write_ack_ms`. Group by region,
build SHA, timing origin, and key-count range; report count, p50, p90, p99 and max.
Deduplicate queue retries by workspace, target, mutation timestamp and enqueue
timestamp, taking the earliest successful completion. Separately report failed
attempts and retries so slow failures cannot disappear from the success percentiles.
`authz_push_enqueued` provides the corresponding enqueue record;
`authz_push_enqueue_failed` reports pending count and oldest pending age. Inspect
the regional queue/DLQ for jobs without completion, and query
`search_authorization_push.first_mutated_at` for undelivered outbox age. These
operational logs follow the existing log-level and Workers Logs retention/sampling
configuration; they are not a lossless metrics ledger.

The endpoint is **KV write acknowledged**, not globally visible. A successful
`put` does not establish when another edge serves that version. Before moving a
consumer that needs a visibility bound, measure it with versioned reads from the
regions where that consumer runs. Those probes should be an explicit experiment,
not authorization rechecks on ordinary reads.

## Changelog

### 2026-09-08 — Measure mutation-to-publication latency

The platform needs propagation evidence before reusing search's KV authorization
model. Preserve source mutation time across durable outboxes, coalescing and
Queue retries; emit completed/failed attempt timings and acknowledged key counts.
Separate write acknowledgement from edge visibility and identify measurements
that begin at a WorkspaceDO directory projection, rather than disguising missing
upstream time as full source latency. This uses existing operational logs rather
than adding a measurement service or read-time refresh.

### 2026-09-08 — Trust eventually consistent search decisions

Production searches spent seconds walking canonical conversation owners before
loading content. The product explicitly chose fast, eventually consistent search
authorization. Restore cross-request decisions through KV/regional SQLite and
mutation-driven push, without a five-minute serving deadline or refresh timer. Remove downstream product
authorization and automation seating from admitted search-content reads. Canonical
source text and index revisions remain independently validated. This supersedes
the earlier retirement of cross-request search decisions; future changes must not
silently restore owner rechecks on cache hits.


### 2026-09-08 — Clarify observable pagination metadata

Review identified that explicit candidate continuation exposes index progress even
for a fully rejected page, and deterministic positions can be correlated with known
IDs. Documented that boundary instead of restoring hidden scans or inventing a scan
cap. The approved member search design admits content once per batch and permits
explicit continuation; it does not offer index-existence concealment.

### 2026-09-08 — Use operation-level search admission

Search batches now share one admission decision through canonical content loading,
instead of repeating checks around awaits. Resource admission stops at the first
valid attachment path, and automation and inherited-owner facts are memoized within
the batch. The team explicitly chose to trust correctly implemented platform
primitives and the agreed propagation model. Repeated checks increased serial RPC
cost without serving that contract. Every new batch still reads canonical owners;
there is no cross-request grant cache or code-enforced five-minute expiry.

### 2026-09-08 — Scope authorization observations to a single batch

Review identified repeated owner RPCs within a serial resource batch and later
checks joining an earlier pending observation. Each check now owns a fresh batch,
retaining owner observations only inside it. This avoids repeated reads of shared
owners while preserving a new canonical observation after asynchronous work.
Runtime regressions cover both boundaries and assert that legacy writes leave the
snapshot table unchanged. Removed unused synchronous discovery RPCs and stale
cache test scaffolding. Documented indefinite denial after dead-lettered discovery,
operator repair, and post-rollout cleanup of inert snapshot storage and bindings.

### 2026-09-08 — Freshness is a design goal, not a read deadline

**Changed:** Removed the five-minute evidence cutoff, age-triggered synchronous
workspace discovery, and persisted decision reuse. Coalescing shares only active
canonical reads; later checks observe permission changes without waiting for a timer.

**Why:** Production searches stalled on expired attachment evidence. The user
explicitly replaced the hard five-minute bound with a design goal. Keeping old
snapshots forever would silently retain grants, so snapshot reuse is retired
until it has owner-driven invalidation. The Queue remains the discovery primitive.

**Consequences:** No schema migration or binding deletion is needed. Legacy
snapshot RPCs remain inert during rollout. Ordinary reads still require canonical
grants, unavailable authority remains explicit, and performance must be measured
again; the earlier changelog's five-minute guarantees are superseded.


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
