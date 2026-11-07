# Authorization

Rally's internal read authorization primitive composes canonical owner facts into
an explicit decision. It serves member search and resource reads. Search trusts projected decisions across requests; other consumers use canonical resolution. Five-minute authorization freshness is a design goal, not a read deadline. The module does not admit
participants or become a new canonical owner of memberships.

## Where the code lives

| File under `apps/api/src/` | Responsibility |
| --- | --- |
| `services/authorization-policy.ts` | Typed addresses, subject, four outcomes, proof composition, evidence validation, `AccessContext` |
| `services/search-authorization.ts` | The old KV/regional search decision store. Unread and unpushed since member search filters on row audience ([text search](text-search.md#invariants)); deleted in the audience-filtering PRD's phase 4 |
| `durable-objects/search-authorization-universe.ts` | The subjects and resources a push target reached; unused since phase 3, deleted in phase 4 |
| `services/authorization-service.ts` | Member policy, batch-local owner observations, authorized resource metadata and HTTP disclosure adapter |
| `services/resource-read-projection.ts` | Shared resource presentation projection for admitted and predicate-filtered reads |
| `services/resource-read-rules.ts` | The draft and attachment rules for a resource, shared by the canonical check and the search audience its rows carry |
| `durable-objects/authorization-storage.ts` | Exact attachment locations, inventory revision ordering and shipped migration tables |
| `durable-objects/search-authorization-projection.ts` | The old store's mutation triggers and push outbox; the outbox is no longer flushed, and phase 4 drops both |
| `durable-objects/authorization-projection.ts` | Transactional child outbox and reference-only Queue contract |
| `services/authorization-projection-service.ts` | Reloads attachment inventories from their owners when jobs execute |
| `durable-objects/workspace-do.ts` | Legacy snapshot compatibility validation, resource facts, migration fan-out and discovery status |
| `durable-objects/hosted-conversation.ts`, `hosted-sidekick.ts`, `hosted-canvas.ts` | Canonical parent/child facts; a Sidekick's author, executor and the people it is shared with; a Canvas's audience |
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

Every ready Channel conversation uses parent grants. Historical rosters are
imported once; creation and child publication complete that handoff before
returning. A local roster or directory row never supplies fallback permission.
[Scoped invitations](scope-invitations.md) owns sharing, the upgrade backfill and
handoff recovery; [browser sessions](browser-sessions.md) owns cookie transport.

`scope-grant-storage.ts` keeps each Channel's grants in `WorkspaceDO`'s
`parent_grant*` tables, keyed by `parent_id`
([hosted conversation parents](hosted-conversation-parents.md)), and child
audience uses `restricted` as the preserving default. Mutations use
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

`WorkspaceDO`'s `readScopeAccess` RPC, answered by the hosted parent, loads the current D1 relationship and reads
its local scope grants, target readiness and lifecycle. `mutateScopeGrant` admits
the authenticated actor against that same scope and requires an active recipient
for additions. Implicit workspace-public member reading does not authorize
sharing. All local facts are read after the external relationship reads, with no
await between the local decision and the write. Expected denials are typed RPC
results, distinct from transport failures. Abandoned workspaces have no usable
relationship. Migrated conversation reads recheck this relationship and scope after the D1
await. Pending handoff refuses admission to the addressed conversation until its
source freezes and the parent commits the roster transfer; unrelated conversations
keep their existing path. A failed transfer resumes through the durable alarm.
Falling back to a legacy roster after source authority freezes would create two
competing authorities, so recovery retains this availability tradeoff. The canonical resolver requests the
exact conversation, so an independent migrated child does not read Main's agent
or require its participation. Its evidence includes relationship incarnation,
relationship revision and the current participant projection revision. Main and
child socket admission compare that version against the local applied projection;
explicit grants use the applied projection, while Main retains parent-authorized
implicit workspace-member access with version zero. The private-child membership
table no longer authorizes migrated children. Socket preparation carries the same parent-issued
revision. Public conversation snapshots, feed tickets, read-state and child title
changes accept guest identities only through `requireGrantAuthority` parent
admission. Sidekick authoring conversations retain their separate parent-owned policy.
Organization-wide member visibility never admits a guest.

Pure policy tests run with `pnpm --filter @rally/api exec vitest run
test/scope-grant-policy.test.ts`. Storage and populated-schema upgrade tests run
in real workerd with `pnpm --filter @rally/api test:workers
test-workers/scope-grant-storage.test.ts`.
`test-workers/scope-grant-authority.test.ts` (deleted in plan step C-2) additionally drives the real hosted
parent RPC on `WorkspaceDO` with D1 relationships, including child-only sharing, implicit-member denial,
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

Sidekick resource tools reuse this canonical resource decision for supplied IDs
outside their related conversations. The subject is the server-owned execution
user; an ID in a tool argument supplies only the resource address. A batch read returns resource and artifact metadata with the decision, and
discloses metadata only for admitted resources. This direct read creates no
attachment or additional permission. The
[resource-tool scope](agent-attachments.md#authorized-work-stream-discovery-and-text-hydration)
owns discovery and import revalidation.

An authorization batch may receive the active regional workspace-membership
observation separately produced by trusted request middleware. Attachment reads
and artifact open, data and error routes carry that proof explicitly. The session
query also supplies its incarnation and revision, which a migrated conversation
uses in its grant decision without another D1 relationship lookup. The proof is
server-owned; no HTTP body or header can supply it. A generic `AuthContext`, a retargeted
subject, and every non-request caller load the fact canonically from D1. Each
observation is shared within one authorization batch. Each batch gathers conversation IDs from
its requests and resource locations before loading a parent, preserving one parent
RPC across multiple substreams. Each response carries exact grant decisions for the requested conversations.
Canonical checks reload facts. Main and Breakout scopes are independent: a
Breakout member need not read Main, and reading Main does not admit a restricted
Breakout.
An automation supplies its own scope, author, executor, `people` list
membership and child registry, and `sidekickAdmits` decides from those alone:
its author, its executor and the people it is shared with read it, and a member
also reads an Organization-scoped one. No work stream owns an automation (the
`workstream` scope was retired by WorkspaceDO migration 137), so none supplies
any access. Archived work streams remain readable. Deleted automations are absent.
A Canvas supplies its visibility, creator, participant list, its writer
Sidekick's audience (read live) and whether the person is an owner or
administrator, and `canvasAdmits` decides; it and `sidekickAdmits` are the one
`audienceAdmits` rule over their own facts ([`canvases.md`](canvases.md)).

Guest membership comes from an explicitly carried request observation, or is
read from `workspace_members.access_class`. Guests cannot use a legacy conversation scope/roster or
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
resource-authorizer round trip on Space defaults or origin attachment. Guest
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
guests through this same policy. Each read operation admits its resource once.
The authorization-facts RPC optionally returns resource metadata and the artifact registry row from the
same Organization owner, removing the separate metadata/registry RPC from the
first load. It carries that owner's placement too, so artifact host selection
does not repeat the cold routing lookup through another database facade.
Metadata is disclosed only after the complete policy allows it;
ordinary fact batches do not request these additional rows.

An admitted read finishes without rechecking membership or access after storage
awaits. Revocation is eventually consistent: a concurrent revocation may arrive
after admission, while the next request authenticates again and starts fresh
canonical resource admission. Each read operation starts a fresh authorization
batch, even when its service instance is reused; no settled grant decision or
metadata snapshot is retained.
Search previews retain their independent source-version comparison after storage;
that comparison does not reauthorize. This contract does not relax mutations,
socket admission or the existing artifact viewer-session revocation mechanism.
Resources attached to a Sidekick's conversations reuse that Sidekick's
audience: a guest reads them only from its `people` list, never through a
grant on a Channel or Breakout.
Guest admission observations are shared only within the current authorization
batch, like other owner observations. Skill visibility alone does not expose a
Sidekick's resources; existing member authorization remains on its original path.
Sidekick resource inheritance follows current execution-user admission; see
[`agent-attachments.md`](agent-attachments.md#authorized-work-stream-discovery-and-text-hydration).

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

### Space-derived access

[A Space grants no reader](spaces.md#a-space-starts-organization-wide-and-grants-no-reader), and the
code that once applied a Space's audience to its Channels is gone
([`space-access-sources.md`](space-access-sources.md)). The one exception is
decided at read time and written nowhere: a guest who takes part in a Channel
reads the Organization-wide threads placed in it as a member does
(`ScopedAccessFacts.channelReader`, read by the thread's hosted parent from the
Organization's Space tables;
[`spaces.md`](spaces.md#a-channel-lends-its-public-threads-to-its-guests)).
It admits no private thread, no restricted Breakout and no parent management.
What is left of
Space-derived access is the readers a Space seated before WorkspaceDO migration
94. Their grants still carry `parent_grants.source_kind = 'space'` and stay out
of the shared scope-grant directory, and ordinary removal revokes one like any
other grant. Direct provenance still wins: a
direct add of such a reader promotes the grant to `direct` and publishes it.

**Being able to read a Channel discloses the mark and name of every Space it is
placed in** — the Organization's fact about where the Channel lives, so a
sidebar can draw it there — whether or not the reader is one of those Spaces'
participants. That is a *discovery* disclosure and not an admission: it confers
no read on the Space's other Channels, names none of its participants or
defaults, counts only the Channels that reader can already see, and every write
on the Space is refused `space_access_denied`.
[`spaces.md`](spaces.md#who-may-see-a-space-and-why) owns the predicate and
what it withholds.

### Resources shared with a Space

A resource is readable through every place it is linked, decided from that
place's audience as it is now, never from a copy of who could read it then. A
conversation's links are its inventory, read through its own authority. A
**Space** (the product's Channel) is the other place: a thread's merge into a
Channel links each artifact it embeds to that Space
(`conversation-merge.md` (retired)).

The link is a row in `authorization_locations` with `parent_kind = 'space'`
and `substream_id = '0'`, written by `linkSpaceResources` in the merge's own
WorkspaceDO commit. WorkspaceDO owns the Space, so unlike a conversation's row
the Space row is the record, not discovery. `authorizationResourceFacts` takes
the reader's access class and answers `sharedThrough`: the first linked Space
the reader reaches today, by `WorkspaceSpaceStorage.reach`, the rule the
Channel feed itself is read under (an archived Space still reads). The
authorization service admits on it after the resource's own checks
(connection, note, draft) and before it walks conversation locations, which
no longer include Space rows.

So access follows the Space's membership with nothing to rewrite: a person
added to a private Channel can open what was merged into it, and one removed
cannot, from the next read. Search no longer follows it: the `space:<id>` group
went with Spaces (plan step C-6; see [`text-search.md`](text-search.md#changelog)),
so a merged artifact is found only through a conversation that holds it.

A link outlives the merge that wrote it, as an attachment outlives the message
that cited it: deleting the merge, or merging again without the embed, leaves
the resource shared with the Space. Nothing removes Space rows today.

### Invitation admission

[Scoped invitations](scope-invitations.md) use the same current grant policy for
every target at creation and when a share is claimed, which happens when its
address signs in. A verified mailbox match is necessary but insufficient: the
sharer's membership incarnation and sharing authority must remain valid, the
recipient relationship must be active, and local invitation revocation must not
have won. The claim and its target grant operations commit in one `WorkspaceDO`
transaction. A claimed share is never claimed again, so nothing reapplies grants.

### Evidence and read lifetime

Every proof carries `owner`, `revision` and `validatedAt`. The resolver stamps
`validatedAt` when an authority read returns, using the same isolate clock that
evaluates the proof; an owner's own observation time may be retained for telemetry
but does not order authorization across isolates. Observation timestamps are
diagnostic: old evidence does not become unavailable merely because time has passed.
Future timestamps and empty grants remain invalid. Five-minute freshness is a
design goal for propagation and performance, with no code-enforced timeout, lease
duration, or permission-expiration timer.

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

Parent discovery for a Channel hosted in WorkspaceDO runs where it is enqueued:
the Channel's `parent_children` rows are in the same database, so
`enqueueAuthorizationDiscovery` registers them (the same reconcile
`registerAuthorizationChildren` runs) in the caller's transaction and queues
only the per-conversation jobs. The Queue still carries conversation jobs,
which read a `SubstreamAgent`; and a Channel whose legacy import is still pending, since
serving it needs the async import. The Worker's parent branch in
`projectAuthorization` stays for those and for jobs queued before this change.

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
  returns only rows whose `audience` shares one of the searcher's groups, read
  live per request (see [text search](text-search.md#invariants)); it says
  nothing about what it left out, and the desktop has no partial-results state.
  A failed group read fails the search with 503. Resource lists keep their own
  `complete` field and retry. No IDs, counts, or source metadata from omitted
  candidates are returned. Provider-wide retrieval errors, cancellation, and
  failed request authentication still fail the request. The request field
  `supportsPartialResults` is accepted and ignored for desktop builds that still
  send it.
- Checks bind canonical observations to the trusted subject, workspace and exact
  resource address. A record for another user or private child cannot authorize a
  read. Policy-version validation remains only in the legacy snapshot wire schema.
- Composition preserves each owner's revision. The receiving isolate stamps the
  evidence time after an authority read returns; cross-isolate wall clocks do
  not decide whether an otherwise current proof is valid.
- Missing discovery cannot be treated as confirmed absence. Activation before
  coverage is complete would silently omit private-child-only resources.
- Queue writes and resource changes share durable local intent. A crashed
  dispatcher can retry without reconstructing permissions from an old payload.
- A Space's own visibility is discovery only. A readable Channel discloses its
  Space's mark and name, which confers no read on the Space's other Channels and
  no write on the Space.
- [A Space grants no reader](spaces.md#a-space-starts-organization-wide-and-grants-no-reader). A
  Channel's audience is its own scope and participants, and an
  Organization-wide one also admits a guest who takes part in a Space it is
  placed in (`channelReader`). The one thing a Space
  admits its readers to is a resource linked to it, and only through the
  Space's own audience as it is when the read happens. Guard:
  `channels-threads-navigation.test.ts` (deleted in plan step C-2) "given a merge into a private Channel,
  when a member is added to the Channel later".
- A link records a place, never the people. Copying who could read a resource
  at link time would leave a person added later locked out and a person
  removed still in.
- The scope-grant directory is complete for direct grants and deliberately
  incomplete for Space-derived ones. Anything that treats an absent directory
  row as absent access is wrong; the candidate index narrows a search, and the
  owner's authorization read is still what decides.

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
`test-workers/conversation-parent-contract.test.ts` (deleted in plan step C-2) exercises stale roster
projections and private-child search before and after queued backfill without activation.
`test-workers/resource-read-admission.test.ts` drives attachment and artifact
HTTP routes over real D1, WorkspaceDO and R2, checking first-load RPC counts,
session/membership/grant revocation, admitted reads
during revocation, and membership-incarnation fencing. `test/resource-upload.test.ts`
also covers a search preview whose ownership changes while R2 is being read.
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
latency successes. A superseded key is not a failure: the newer push that took
it owns its publication and its retries. `store` distinguishes Global `kv` from `regional_sqlite`.

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
`selected_keys`, `written_keys`, `unchanged_keys`, `superseded_keys`, `attempt`,
and `outcome`. `unchanged_keys` is the part of `written_keys` whose decision KV
already held, so no KV write was made.
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

### 2026-11-07 — A conversation's read is answered by its Canvas or Sidekick alone

**What changed:** `AuthorizationBatch` no longer asks a Thread parent's
`readAuthorizationFacts` before the hosted parent: every conversation is a
Canvas's or a Sidekick's, and its parent answers in one call. A resource's
`sharedThrough` (the Channel a merge shared it with) and its second policy are
gone.

**Why:** Plan step C-2 of the [Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)
deleted the Thread and Channel hosts these branches read. Asking a parent that
no longer exists first cost a Durable Object round trip on every read for an
answer that was always "absent", and a merge, the only writer of a Channel
share, is gone.

**Consequences:** A resource is readable through the conversation that holds
it and nothing else. Evidence carries the hosted parent's `validatedAt` alone.

### 2026-11-07 — A Canvas is decided by its own audience, through one rule with a Sidekick's

**What changed:** A conversation whose parent is a Canvas, and an artifact
attached to it, are decided by `canvasAdmits` from the Canvas's facts
(`hostedConversationAuthorizationFacts`, which answers a Sidekick or a Canvas
in one call). `canvasAdmits` and `sidekickAdmits` are both `audienceAdmits`
over their own facts; an owner or administrator is admitted to every Canvas.

**Why:** A Canvas owns its audience (the Canvases and Sidekicks decision log),
and its artifacts inherit it rather than a Thread's. Two rules written field
for field would drift.

**Considered and rejected:** A separate artifact-level grant: an artifact is
generated in the Canvas's Chat and attached to it, so the attachment path
already decides it.

**Consequences:** The artifact door (`ArtifactOpenService`) needs no Canvas
branch; it is admitted through the canonical resource decision. Resource
authorization for a hosted conversation is one RPC whichever kind it is.

### 2026-11-07 — A Sidekick's audience is its own

**What changed:** A Sidekick's conversations and the resources in them are
read by whoever the Sidekick is shared with (`sidekickAdmits`): its author, the
person it runs as, anyone on its new `people` list (`sidekick_audience`), and
for an Organization-scoped one every member. The owner rule that also admitted
the participants of a Sidekick's owning Thread or Breakout
(`<owningWorkstreamId>/<owningSubstreamId>`), and the guest path through that
home's grants, are removed, here and in search audience and memory facts.

**Why:** The Canvases and Sidekicks pivot retires Threads, and a Sidekick's
shared conversation is read by the people it is shared with (plan step A-4).
An audience inherited from a Thread would outlive the Thread it came from.

**Consequences:** A Thread-scoped Sidekick is an Organization one since
WorkspaceDO migration 137 (plan step A-5), so its former Thread's people keep
reading it as members do. A guest reaches a Sidekick
only by being named on its list. The rule is one function; a reader that
decides Sidekick access some other way is a defect.

### 2026-10-21 — Admit attachment and artifact reads once per request

**What changed:** Resource reads reuse HTTP membership evidence, including its
incarnation for migrated grants, and authorize once per read operation. The
authorization-facts RPC can return resource metadata and artifact
registry data together. Byte reads no longer repeat authorization after storage.

**Why:** A production image preview spent about one second on its second
authorization RPC after reading R2, with two extra membership lookups and a
separate metadata RPC along the way. The team accepts eventually consistent
revocation, so replaying the full policy around each await paid network latency
for a stronger consistency rule the product does not require.

**Considered and rejected:** A cross-request grant cache adds invalidation state
without removing the first-load metadata hop. Keep fresh request admission and
combine reads already owned by the same Organization instead.

**Consequences:** An in-flight read can finish after revocation. Subsequent
requests reauthenticate and observe canonical grant changes. Read admission is
not mutation authority; membership incarnations and concealment remain part of
the decision.

### 2026-10-19 — A Channel is a place a resource can be shared with

**What changed:** `authorization_locations` holds a new kind of row,
`parent_kind = 'space'`, which a thread's merge into a Channel writes for each
artifact it embeds. The canonical resource check admits whoever reads that
Space today (`sharedThrough`), and search carries a `space:<id>` group for it.

**Why:** The product owner's rule: a merged artifact is readable by everyone in
the parent, the whole Organization for an Organization-wide one and its
participants for a private one, and access must follow those participants as
they change. A Channel had no place to link to, so a Channel merge attached to
the thread instead: the artifact reached the thread's readers, which for a
private thread left most of the Channel out, and for an Organization-wide
thread merged into a private Channel reached far more than the Channel.

**Considered and rejected:** Attaching to the Space's hidden conversation. It
would reuse the conversation path, but that conversation is deliberately kept
out of the authorization universe and has no roster of its own to read. A
separate table of Space links: the location table already has the reverse
index, the search triggers and the backfill's reconcile scoped by parent, and
WorkspaceDO writes both the link and the merge, so a second table would only
be a copy to keep in step. Granting the Channel's current members: that is a
copy of a roster, wrong on the next membership change.

**Consequences:** A location row is no longer always discovery to prove
elsewhere; a Space row is proved where it is read. `registerAuthorizationChildrenInPlace`
reconciles by parent and so never touches a Space's rows, and
`beginAuthorizationBackfill` lists only threads and Sidekicks; a change that
widens either must leave `parent_kind = 'space'` alone. Nothing unlinks a
resource from a Space yet, as nothing removes a Channel merge's attachments.
WorkspaceDO migration 118 links the embeds of every Channel merge made before
this, so no merge is left on the old rule. A new link is counted by its
`RETURNING` row, not `rowsWritten`, which the search trigger inflates.

### 2026-09-25 — A hosted Channel's parent discovery runs in WorkspaceDO

A parent discovery job for a Channel hosted in WorkspaceDO no longer goes
WorkspaceDO to Queue to Worker and back for `resolveHostedParent`,
`listAuthorizationChildren` and `registerAuthorizationChildren`, three calls
into the object that enqueued it. The registration now runs in the enqueueing
transaction and only per-conversation jobs are queued. Conversation jobs keep
the Queue because they read a `SubstreamAgent`, and Sidekick parents because
their children are `sidekick_children` rows, which the in-place path does not
read. A Channel whose legacy import is pending
keeps the Queue too: importing it needs an await, which a transaction cannot
hold. The Worker's parent branch is kept for those and for messages already
queued at deploy.

### 2026-09-25 — A superseded push completes, and an unchanged decision skips KV

Juno Labs' largest Channel (about 1,426 keys) had up to three pushes running at
once every working day. Each push raises the generation of every key it
reaches, so each one dropped the others' writes, and each then failed with
`search_authorization_push_superseded` and retried, which took the keys back.
On 2026-09-24, 22 dispatches made 114 attempts, 10 completed, some reached the
dead-letter queue, and the attempts spent about 84,000 seconds in KV writes
through the WorkspaceDO. A superseded attempt still wrote most of its keys.

The retry existed because a newer claimant might fail before it published. Of
the two claimants, a push retries on its own; a search fill does not. A fill now
claims only keys nobody registered (`claim: 'unregistered'`), so a registered
key is only ever taken by another push, and a superseded push completes. A
fill-created resource or conversation key is still backed by the pending-row
push from migration 46.

Every push also rewrote every decision to KV, though most come out the same.
`search_authorization_keys.published_decision` records the fingerprint of the
decision KV last acknowledged: the outcome and each evidence owner and revision,
without receipt times, which no reader acts on. A matching decision skips the
KV write. The column is cleared before each put, so a put whose outcome is
unknown never counts as held, and a KV miss republishes regardless.

Rejected: a per-target lease so only one push runs at a time. It needs an
expiry for a lost job, which is a number with nothing here to set it from, and
it leaves the whole-target rewrite in place. Still open: a breakout's roster
change pushes its whole parent. Narrowing that target is the next step if
parent pushes stay expensive.

### 2026-09-21 — Stamp authority evidence on the resolver's clock

Healthy artifact and resource reads intermittently returned
`authorization_unavailable` when a WorkspaceDO observation was a few milliseconds
ahead of the calling Worker. The resolver now stamps evidence after each authority
read returns, while preserving the owner's revision as the ordering proof. This
keeps the future-evidence guard without comparing wall clocks across isolates;
clock-skew tolerances were rejected because they would turn an invalid ordering
assumption into an arbitrary authorization limit.

The resolver also accepts a separately typed active-membership observation from
trusted request middleware. The artifact-open route carries it explicitly;
re-reading the same `workspace_members` row there added a serial D1 hop without a
new authority boundary. A generic `AuthContext` is deliberately not evidence:
background callers can retain one and services can retarget one to another user.
Those paths continue to perform the canonical membership read.

### 2026-09-19 — A readable Channel discloses its Space's mark, and nothing else

The composition now runs in both directions. A Space source admits a reader to
a Channel, as this document already recorded; a Channel a person can read now
also discloses the mark and name of every Space it is placed in, so the sidebar
can draw the Channel where it lives instead of in a flat list of rows with no
home. That is discovery rather than admission, and the invariant above says
what it does not carry: no read on the Space's other Channels, no participant,
no default, no count of what the reader cannot see, and no write. The reasoning
and the predicate are in [`spaces.md`](spaces.md#changelog).

### 2026-09-19 — A Space-derived grant is admission without discovery

Space sources compose with a Channel's direct audience, and the grant a Space
seats now carries `source_kind = 'space'` and is never published to the shared
scope-grant directory. That makes this module's candidate index deliberately
incomplete: it is complete for direct grants only, and an absent row no longer
means absent access. The reasoning, and the provenance the composition is
derived from, are in [workstream
authority](workstream-durable-object.md#changelog) — in short, General holds
every Channel in the Organization, so publishing a row per Space-derived reader
per Channel would size one flat index at the Organization times its Channels,
for discovery the Space directory already provides.

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
layer with a ten-minute propagation bound. Other resolver callers keep the inline fill because nothing hands them a
deferral. Content
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
admission already uses projected decisions. Memory search no longer shares that resolver: agent memory decides visibility
inside WorkspaceDO from each fact's sources ([`agent-memory.md`](agent-memory.md)). The separate visibility probe
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
