# Authorization

Rally's internal read authorization primitive composes canonical owner facts into
an explicit decision. It serves member search and resource reads. Search trusts projected decisions across requests; other consumers use canonical resolution. Five-minute authorization freshness is a design goal, not a read deadline. The module does not admit
participants or become a new canonical owner of memberships.

## Where the code lives

| File under `apps/api/src/` | Responsibility |
| --- | --- |
| `services/authorization-policy.ts` | Typed addresses, subject, four outcomes, proof composition, evidence validation, `AccessContext` |
| `services/search-authorization.ts` | KV/regional search decisions, read-through misses and mutation-driven push |
| `durable-objects/search-authorization-universe.ts` | The subjects and resources a push target reaches, read from the WorkspaceDO directories, so a decision is registered before the search that needs it |
| `services/authorization-service.ts` | Member policy, batch-local owner observations and HTTP disclosure adapter |
| `durable-objects/authorization-storage.ts` | Exact attachment locations, inventory revision ordering and shipped migration tables |
| `durable-objects/search-authorization-projection.ts` | Workspace mutation triggers, coalesced push outbox and Queue dispatch |
| `durable-objects/authorization-projection.ts` | Transactional child outbox and reference-only Queue contract |
| `services/authorization-projection-service.ts` | Reloads attachment inventories from their owners when jobs execute |
| `durable-objects/workspace-do.ts` | Legacy snapshot compatibility validation, resource facts, migration fan-out and discovery status |
| `durable-objects/workstream-do.ts`, `sidekick-do.ts` | Canonical parent/private-child facts; automation author, executor and owning work stream |
| `authorization-control.ts` | Private operator Service Binding entrypoint |

## How it works

### Scope grant foundation

`packages/contracts/src/scope-grants.ts` defines member/guest workspace access
classes, exact conversation/workstream grant addresses and restricted/inheriting
child audiences. `services/scope-grant-policy.ts` evaluates these authoritative
facts. Guests never receive the implicit workspace-public member rule. A direct
child grant needs no Main grant; a Main grant does not confer parent management.
Overlapping direct and inherited grants remain independent. Suspension overrides
them all, while archive preserves reading and disables mutation.

First-share preparation starts the addressed participant handoff after canonical
participant checks. Once that conversation completes its handoff, parent viewer checks and canonical authorization
reads use its scope grants. Unmigrated conversations retain the existing behavior
below until their own handoff. The full implementation checklist is in the
[guest sharing PRD](PRDs/2026-09-16_guest-sharing-browser/prd.md).

WorkstreamDO migration 14 installs `scope-grant-storage.ts`'s local tables and
adds child audience with `restricted` as the preserving default. Mutations use
expected-revision checks and immutable operation receipts. Grant changes,
receipts and pending delivery intents commit in one synchronous transaction.
Every grant binds the recipient's current membership incarnation. Removing and
recreating a relationship never revives grants issued to its previous incarnation;
promotion preserves the incarnation and grants. A fresh sharing operation must
explicitly grant the new relationship. Revoked rows remain tombstones, so a delayed
activation cannot recreate access. Frozen legacy imports retain the incarnation
mapping recorded when the migration began; replay cannot rebind that snapshot.
Reusing an operation ID with different input fails; retrying the original input
returns its original result without reapplying it. Delivery acknowledgement is
for one exact revision. The storage class alone is not an authorization boundary.

WorkstreamDO's `readScopeAccess` RPC loads the current D1 relationship and reads
its local scope grants, target readiness and lifecycle. `mutateScopeGrant` admits
the authenticated actor against that same scope and requires an active recipient
for additions. Implicit workspace-public member reading does not authorize
sharing. All local facts are read after the external relationship reads, with no
await between the local decision and the write. Expected denials are typed RPC
results, distinct from transport failures. Abandoned workspaces have no usable
relationship. Migrated conversation reads recheck this relationship and scope after the D1
await. Pending handoff refuses admission. The canonical resolver requests the
exact conversation, so an independent migrated child does not read Main's agent
or require its participation. Its evidence includes relationship incarnation,
relationship revision and the current participant projection revision. Main and
child socket admission compare that version against the local applied projection;
the legacy Main bypass and private-child membership table no longer authorize
migrated conversations. Socket preparation carries the same parent-issued
revision. Public conversation snapshots, feed tickets, read-state and child title
changes accept guest identities only through `requireGrantAuthority` parent
admission. Unmigrated workstreams and Sidekick authoring conversations refuse
that requirement. Other product routes and serving surfaces remain pending before
live rollout; workspace-public legacy visibility never admits a guest here.

Pure policy tests run with `pnpm --filter @rally/api exec vitest run
test/scope-grant-policy.test.ts`. Storage and populated-schema upgrade tests run
in real workerd with `pnpm --filter @rally/api test:workers
test-workers/scope-grant-storage.test.ts`.
`test-workers/scope-grant-authority.test.ts` additionally drives real WorkstreamDO
RPC with D1 relationships, including child-only sharing, implicit-member denial,
inheritance and lifecycle/relationship rejection.

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
shared within one authorization batch. Each batch gathers conversation IDs from
its requests and resource locations before loading a parent, preserving one parent
RPC across multiple substreams. A mixed response carries migrated scope decisions
alongside legacy facts; each conversation uses its own authority. Canonical checks reload facts. Search instead reuses a subject-and-resource decision from the regional projection.
For member reads, a work stream's main SubstreamAgent owns its scope and roster.
WorkstreamDO adds its canonical private-child membership and ready-state facts.
An automation supplies its own scope, author, executor and child registry; an
owning work stream's canonical roster supplies inherited access. Archived work
streams remain readable. Deleted automations are absent.

Guest membership is observed explicitly from `workspace_members.access_class` in
each canonical batch. Guests cannot use a legacy conversation scope/roster or
Sidekick authoring fallback. For a non-owned resource, a guest always needs a
canonical attachment in an authorized migrated conversation, including resources
whose provider ordinarily makes them workspace-wide for members. Their own upload
drafts retain the existing ownership rule. Connector execution capability checks
remain separate from this resource metadata/content disclosure decision.

Guests can upload and delete their own unsent drafts through the ordinary resource
routes. Exact Main/child attachment mutations admit the target conversation.
Guest attachment also checks the source resource once after loading its metadata,
immediately before committing its link, through the existing resource authorizer.
Product dispatch has already reloaded the current relationship; it does not trust
a caller-supplied guest/member classification. Ordinary members keep the existing
attachment path and personal-connection ownership check, without the added
resource-authorizer round trip on project defaults or origin attachment. Guest
metadata stays inside the mutation until its source check succeeds; a known
resource ID is insufficient for a guest. Upload drafts must be sent with a message; existing
attachment routes accept uploads after publication. Revoking the conversation
also refuses subsequent attachment mutations.

WorkspaceDO supplies resource existence, connection ownership, note visibility,
upload ownership and draft status. A resource requiring an attachment is resolved
through exact `(parent, child, resource)` locations. Each potential grant is
checked against both conversation authority and the canonical attachment
inventory. The reverse index is discovery, never sufficient proof of a grant.
This removes the member search path's serial scan of all work streams and all
children. Content and search passages still come from canonical source records.

Public resource metadata, content, version reads and previews admit workspace-bound
guests through this same policy; the byte handlers recheck after storage awaits.
Resources attached to workstream-owned Sidekick conversations reuse that
Sidekick's viewer admission, including its owning workstream management grant.
Guest admission observations are shared only within the current authorization
batch, like other owner observations. Skill visibility alone does not expose a
Sidekick's resources; existing member authorization remains on its original path.

Explicit resource refresh and artifact open/error/data routes also admit guests.
Refresh runs the existing resource read proof before loading metadata or invoking
its connector, including the no-connection case. Artifact routes delegate to
`ArtifactOpenService` for the same canonical resource proof. Workspace-wide
listing and connector resource resolution remain member-gated pending their
scoped integrations. Watch/unwatch routes use the existing writable Main
conversation admission: watches deliver updates to Main, so a Main or complete
workstream grant can manage them, while a child-only grant cannot. The existing
watch service still requires an attachment in Main and preserves connector scope.
Resource mutations are
scoped as described above: own draft upload/deletion, message publication and
exact-conversation attachment/detachment are guest-enabled; broader management
operations remain member-gated.

### Invitation admission

[Scoped invitations](scope-invitations.md) use the same current grant policy for
every target at creation and acceptance. A verified mailbox match is necessary
but insufficient: the sharer's membership incarnation and sharing authority must
remain valid, the recipient relationship must be active, and local invitation
revocation must not have won. Acceptance and target grant operations commit in
one WorkstreamDO transaction. Replays return the receipt without reapplying grants.

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
An incomplete attachment lookup automatically schedules missing discovery and
returns retryable `projection_incomplete` until a canonical grant or complete
negative evidence can be established. That path re-queues exactly the discovery
that is missing and nothing else: a parent whose own discovery has not
completed, or, under a parent that has completed, each individual child receipt
still at `completed = 0`. It writes nothing for a receipt that finished and
nothing for one whose delivery row is still queued, so a retryable failure
cannot reset a workspace or turn repeated reads into repeated writes. Explicit
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
  404. Direct reads with unavailable authority return HTTP 503. Member search
  omits an unverified candidate and says nothing about it: the response carries
  no completeness flag, and the desktop has no partial-results state. The design
  goal is that the projection is complete before the search, through
  mutation-side registration; what remains is eventual consistency within the
  propagation bound, understood and not surfaced. Resource lists keep their own
  `complete` field and retry. No IDs, counts, or source metadata from omitted
  candidates are returned. Provider-wide retrieval errors, cancellation, and
  failed request authentication still fail the request. The request field
  `supportsPartialResults` is accepted and ignored for desktop builds that still
  send it.
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

A dead-lettered projection leaves a receipt at `completed = 0` with no delivery
row behind it, and coverage is workspace-wide, so one such receipt denies every
attachment-gated resource in the workspace to everyone but each resource's own
uploader. The read path re-queues that receipt on every `projection_incomplete`,
which restores coverage without operator action once the underlying consumer or
source is healthy again. That is a retry, not an age-triggered self-heal: the
trigger is the missing receipt, never elapsed time, and a job that keeps failing
keeps dead-lettering. Repair the failing consumer or source first, then replay
the reference-only authorization jobs from the regional activity dead-letter
queue. For a workspace-wide rebuild, trusted
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
Coalescing and transport retries preserve the oldest pending timestamp, including
child discovery coalescing and KV publication retries. A cache-fill retry without
a source mutation has null timing and is excluded from mutation-latency samples. No timer
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

### Explicit visibility experiment

Run `PROBE_TOKEN=... node scripts/measure-kv-visibility.mjs --writer <url>
--reader <url> --reader <url> --samples <n> --interval-ms <n> --observation-ms <n>`.
The caller chooses the experimental sample count, polling resolution, and observation
window; these are not authorization expiry limits. Each sample primes readers before
creation and replacement, records write acknowledgement and first observed version,
reports unfinished observations explicitly, and deletes its synthetic key afterward.
`executionPlacement` records Cloudflare’s `cf-placement` header when present;
`ingressColo` is request ingress, not proof of execution placement. Record the deployed
placement hints with results. Visibility times include polling resolution and use
Worker timestamps; they are not exact replication timestamps. Remove probe deployments
after the experiment. Pair these results with mutation-to-write-ack queue events.

## Changelog

### 2026-09-16 — Bind shared scopes to the workspace relationship

Guest collaboration requires independent Main, child and workstream grants;
workspace membership alone would expose unrelated conversations. Migrated scopes
now use canonical grant and resource-attachment proofs, while legacy scopes remain
member-only until handoff. Grants bind the recipient's membership incarnation,
not just their permanent user ID: otherwise removal and reinvitation silently
restore old shares. Promotion preserves that binding. Import receipts preserve
the original incarnation snapshot, and fresh re-sharing recomputes all affected
participant projections so old sibling grants cannot reappear. Public resource
reads, explicit refresh, artifact access, and scoped draft/attachment mutations use these proofs; workspace-wide
management and browser presentation are still separate integrations. Parent reads
remain batched across substreams so resource/tool checks do not introduce an RPC
per attachment location; partially migrated parents return both kinds of evidence.

### 2026-09-10 — Republish a durable decision after a cached KV miss

Review found that the deferred fill, on finding the decision in the WorkspaceDO
snapshot table after a KV miss, kept it only for the request that had already
answered unavailable; KV caches negative lookups, so the next search missed
again and read the object again, indefinitely. The fill now writes the stored
snapshots back through `writeSearchAuthorizationSnapshots`, which keeps the
generation fence and queues the existing retry when the put fails. A failed
republish is ignored by the fill because the object has already recorded the
retry intent.

### 2026-09-10 — Register the projection from mutations and drop the completeness flag

Review of the deferred fill below asked whether the first-search gap was a
migration artifact. It was not: a key existed only once a search had missed on
it, so every new member, and every member for every new conversation, saw a
shorter first page. The team chose complete consistency as the design goal, with
eventual consistency understood, and asked for the incomplete flag to go. Push
jobs now register the pairs their target reaches before reloading owners, read
from the WorkspaceDO directories through `search-authorization-universe.ts`;
membership mutations publish a `member` push for the user they name; migration
48 queues a push per live parent, connection and attachment-admitted resource.
Connector resources gained a `connection` resource kind because registering
them per resource does not fit: 81,000 synced resources times the member list
in one Durable Object's SQLite, against 18 connections. The row carries
`connection_id`, written by the resource producer, and the read path admits it
by the connection's decision; a connection never changes on a resource after
insert, so no rewrite trigger was needed. The search response lost `complete`,
the route lost its 503 for clients without partial-result support, and the
desktop lost the partial footer and the request flag; the request field is still
accepted for builds that send it. Rejected: an on-demand fill left inline (the
measured slow path), a full re-projection on every `member_directory` event (a
profile edit publishes that topic), and readers-in-index (a larger reversal for
the same outcome). A future change must keep enumeration an over-approximation
that the canonical walk decides, never a grant, and must register a new
readability path here when it adds one.

### 2026-09-10 — Fill search decisions after the response

Member search no longer waits for a canonical owner on a projection miss: the
candidate is omitted, the page is marked incomplete, and the same fill that used
to run inline (registration, owner walk, publication) runs through `waitUntil`.
Measured production searches spent seconds in exactly that inline walk across cold
WorkstreamDO and SubstreamAgent objects. The team chose performance, accepted that
a first search for an unprojected pair shows less, and kept KV as the security
layer with a ten-minute propagation bound. Other resolver callers, memory search
among them, keep the inline fill because nothing hands them a deferral. Content
and display now come from the index, so the content RPC contract above is inert;
see the text-search changelog for the read path. A future change must not put an
owner read back into a member search request to close the first-search gap.

### 2026-09-10 — Retry missing authorization discovery from the unavailable read

`beginAuthorizationBackfill({ refresh: false })` skipped every parent already
present in `authorization_backfill`, complete or not, and only ever queued
parent-level jobs. The unavailable read path is its only `refresh: false`
caller, so any discovery receipt left at `completed = 0` with no delivery row
behind it was never retried. Coverage is workspace-wide, so one such receipt
returned `authorization_unavailable` for every attachment-gated resource in the
workspace, to every member except each resource's own uploader, permanently.

The dominant way to reach that state is a child receipt, not a parent one. A
parent job always returns at the `registerAuthorizationChildren` branch, which
marks the parent complete; `authorization_projection_conversation_not_ready` is
below that return and is therefore reachable only on a child job. The stuck
workspace is thus a *completed* parent with one incomplete child, which the
parent-only guard could never have reached.

The read path now re-queues the specific missing receipt: the parent when its
own discovery is incomplete, otherwise each child still at `completed = 0`. It
skips any receipt whose delivery row is still present, because work already
scheduled — including work waiting out a backoff — does not need requesting
again.

**Considered and rejected:** re-running the parent job to recover a stuck child,
which is the smaller diff, was rejected because a parent job runs with
`refreshExisting` enabled and resets every sibling receipt to `completed = 0`.
That would widen the same workspace-wide outage it is meant to close, for as
long as the re-registered children take to drain. Also rejected: an age or
retry-count trigger, which would introduce the time-based self-heal this design
deliberately does not have, and repairing inside the evaluator, which would put
a write on the read path.

**What a future change has to respect:** the delivery-row check is what keeps
this path from amplifying client retries into writes on the workspace object,
which is single-threaded and is also what has to drain the backlog. Re-queueing
must stay idempotent through `enqueueAuthorizationDiscovery`, which upserts on
`[parentId, substreamId]` and preserves an existing `not_before`. The
child-registration guard is deliberately not changed to match; it is reached
from parent jobs that legitimately refresh their whole child set. This extends
the write-owned recovery of the 2026-09-09 entry below to the receipts that
recovery leaves behind.

Reported in production in a Global workspace.

### 2026-09-09 — Make projection recovery write-owned

Pending registration and retry intent now share a SQLite insert trigger; migration
46 queues inherited pending rows. This closes the separate-RPC failure gap without
adding read-time repair. Membership directory sync queues existing projection
targets so removal, departure, and activation publish replacement decisions.
Mixed memory and non-memory batches preserve input ordering across their resolvers.

### 2026-09-09 — Remove remaining search authority work

KV misses now consult the existing durable projection before canonical resolution,
because cached negative lookups otherwise repeat owner reads after publication.
An unavailable first fill is retained as pending and retried through the durable
outbox; later searches return partial results without repeating that owner walk.
WorkspaceDO migration 46 queues existing pending registrations once. A SQLite
insert trigger records new pending snapshots and retry intent atomically, with null
mutation timing for initialization work. Membership directory sync queues registered
projection targets, including memory grants, on the existing write-side outbox.
Paginated search no longer requires a directory read before retrieval: candidate
admission already uses projected decisions. Memory search shares that resolver,
with host-run scope selection and canonical resolution only on initial population
or pushed updates; memory writes retain their canonical path. Memory keys register
scope and parent dependencies for targeted retries. The separate visibility probe
measures KV read visibility without adding probes or freshness checks to searches.

### 2026-09-08 — Trust eventually consistent search decisions and measure mutation-to-publication latency

Production searches spent seconds walking canonical conversation owners before
loading content. The product explicitly chose fast, eventually consistent search
authorization. Restore cross-request decisions through KV/regional SQLite and
mutation-driven push, without a five-minute serving deadline or refresh timer.
Remove downstream product authorization and automation seating from admitted
search-content reads. Canonical source text and index revisions remain
independently validated. This supersedes the earlier retirement of
cross-request search decisions; future changes must not silently restore owner
rechecks on cache hits.

The platform needs propagation evidence before reusing search's KV
authorization model. Preserve source mutation time across durable outboxes,
coalescing and Queue retries; emit completed/failed attempt timings and
acknowledged key counts. Separate write acknowledgement from edge visibility
and identify measurements that begin at a WorkspaceDO directory projection,
rather than disguising missing upstream time as full source latency. This uses
existing operational logs rather than adding a measurement service or
read-time refresh.

### 2026-09-08 — Use operation-level search admission

Search batches now share one admission decision through canonical content loading,
instead of repeating checks around awaits. Resource admission stops at the first
valid attachment path, and automation and inherited-owner facts are memoized within
the batch. The team explicitly chose to trust correctly implemented platform
primitives and the agreed propagation model. Repeated checks increased serial RPC
cost without serving that contract. Every new batch still reads canonical owners;
there is no cross-request grant cache or code-enforced five-minute expiry.

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

### 2026-09-07 — Return verified partial results and remove unused helpers

The team chose useful verified results over failing a whole list for one
unavailable authority. Lists now expose `complete: false`; direct reads retain
retryable failure. Desktop search and resource pickers label incompleteness and
retry without exposing unverified candidates. Removed unused `within()` and
`AuthorizedView` rather than carrying an API without a production caller.

### 2026-09-07 — Introduce bounded, composable read authority, enabled on deployment

Search's source verification repeatedly scanned work streams to discover resource
attachments, while projected membership lacked a reliable freshness boundary.
Introduce explicit owner evidence, exact child attachment discovery and a shared
read context. Keep policy as typed local code rather than introducing Oso Cloud
or a general graph interpreter. Preserve the team's five-minute read bound and
regional ownership. Future changes must not exchange complete discovery or
canonical observation time for a faster but misleading empty result.

Per-workspace shadow and activation controls were removed at the team's request
so shipping the code enables one read implementation immediately, retaining
exact permission checks, the five-minute freshness bound and complete negative
evidence. Missing discovery starts through the existing Queue automatically;
repeated reads must not reset already progressing jobs. Operator backfill and
status remain for proactive migration and repair.
