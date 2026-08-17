# Hybrid WorkstreamDO and Supabase architecture

> Created 2026-08-16.
>
> One SQLite-backed Cloudflare Durable Object is authoritative for each work
> stream; global, regional, workspace, connector, suggestion, and query state
> lives in Supabase Postgres. State: [state.md](state.md). Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Related alternatives:
> [Durable Object hierarchy](../2026-08-15_durable-workspace-workstream-conversations/prd.md)
> and [Supabase authority](../2026-08-15_supabase-workspace-workstream-conversations/prd.md).
> Full three-way technical and economic comparison:
> [comparison.md](comparison.md).

## Summary

Avalon gives every work stream one canonical <code>WorkstreamDO</code>. That
object serializes its messages, substreams, compactions, agent runs, queued and
steering input, tool-effect receipts, active output, common metadata, and
ordered event log. It also terminates the work stream's participant WebSockets.
An active inference Worker sends token batches to the same object and receives
steering or cancellation over a temporary executor WebSocket. The result is a
single low-latency authority for the one product aggregate that behaves like an
actor.

Every other product-data domain lives in Supabase. One global Supabase database
stores identity, organizations, billing, invitations, the regional
shard directory, and opaque workspace routing metadata. Regional Supabase
project shards store workspaces, memberships, authorization epochs, connector
credentials and activity, digests, suggestions, resources, user-specific
attention state, sidebar collections, search indexes, generic non-workstream
agent state, and an ordered relational projection of every WorkstreamDO.
There is no <code>WorkspaceDO</code>. Supabase is authoritative for workspace
and user state, but its work-stream tables are read models and recovery material,
never a second write authority.

One Cloudflare Workflow represents one complete agent loop, normally 2–30
minutes and rarely more than two hours during coding. Bounded Cloudflare Workers
perform inference, connector, compaction, search, suggestion, and tool actions.
Daytona remains the Terminal plugin provider. Supabase Realtime carries
workspace/sidebar invalidations and semantic events; it does not carry token
frames. WorkstreamDO WebSockets provide token delivery, reconnect cursors,
steering, and foreground presence without incurring Supabase's per-recipient
Realtime message charges.

## Motivation

The all-Durable-Object design gives work streams excellent isolation and
serialization, but a WorkspaceDO must receive and repair cross-object
projections for every title, state, recency, unread, mention, assignment, and
connector-derived sidebar change. Large workspaces can make that parent a
serialized hotspot, and flexible workspace-wide activity, suggestion, support,
search, and reporting queries require additional indexes or exports.

The all-Supabase design makes the complete sidebar transaction relational, but
puts every active work stream on one shared regional primary. At the launch-safe
500 ms checkpoint cadence, 100 simultaneously observed streams produce about
200 Postgres checkpoint transactions and 400 billed Realtime messages per
second with one viewer each. Supabase currently charges for every Broadcast
send and delivery, and its documented project message-rate limits make
high-fan-out token delivery a product capacity concern even when the underlying
text volume is small. A visual target of 10, 20, or 30 frames per second cannot
be allowed to become a database or Realtime cadence.

Avalon's actual boundary is more favorable than either complete design implies:

- a work stream is an independently serialized, realtime conversation and
  agent-loop aggregate;
- workspace membership, sidebar collections, connector activity, digests,
  suggestions, and cross-work-stream queries are relational aggregates;
- every connector event belongs to exactly one workspace;
- a user usually observes only one or a small number of active work streams;
- a full loop can last for hours, but token generation, tool execution,
  Daytona commands, waits, and user elicitation have different activity
  lifecycles.

The hybrid places each workload on the primitive that matches it. It accepts
one explicit cost: a WorkstreamDO commit and its Supabase projection cannot be
one transaction. That boundary is made safe with an ordered transactional
outbox, contiguous projection watermarks, idempotent receipts, bounded lag,
replay, and reconciliation. It is preferable to pretending both stores are
canonical.

## Goals

1. Give every work stream exactly one SQLite-backed WorkstreamDO that is the
   sole authority for its common state, conversation, substreams, runs,
   effects, active output, compaction, and canonical sequence.
2. Put global identity, organizations, billing, invitations, regional routing,
   workspaces, memberships, connector activity, resources, suggestions,
   digests, user overlays, sidebar collections, search, and generic
   non-workstream agent state in Supabase Postgres.
3. Eliminate WorkspaceDO while preserving transactionally consistent
   workspace-wide and person-specific collections inside each regional
   Supabase shard.
4. Project every canonical WorkstreamDO event into Supabase in order, with
   duplicate safety, gap detection, bounded lag, reconciliation, and an
   explicit authority epoch.
5. Keep token transport off Supabase Realtime and off Postgres's visual-frame
   path while preserving durable recovery, authorization, and a human-smooth
   10, 20, or 30 frame-per-second presentation.
6. Support normal 1–5 second time to first token, 100-token-per-second output,
   seconds-long tools, Daytona Terminal p95 below a minute and 3–5 minute or
   longer tails, 2–30 minute full loops, and rare 2+ hour coding sessions.
7. Commit user messages before acknowledgement and support both queued input
   and steering input that promptly interrupts cancellable work and fences late
   model or tool results.
8. Materialize provider-valid message arrays from ordered typed parts and
   intentional substreams without treating substreams as shards, tabs, jobs,
   runs, or authorization by identifier.
9. Compact a frozen complete-turn prefix while accepting later messages, and
   reject a summary whose authorization, resource, lineage, or materializer
   revision changed.
10. Show Work Streams, In Progress, Completed, Error, last activity, You Are
    Mentioned, Unread, Assigned, Needs Your Input, and suggested work from
    regional Postgres without waking dormant WorkstreamDOs.
11. Store connector ingress, normalized activity, digest provenance, suggested
    work streams, suggested actions, and feedback in the owning workspace's
    regional Supabase shard.
12. Make membership removal stop new admission immediately and terminate
    already-authorized content-bearing WorkstreamDO sockets within a measured,
    bounded revocation interval.
13. Keep all workspace content, Durable Object storage, Supabase storage,
    execution, secrets, logs, and provider processing on an explicitly approved
    regional path, with no cross-region availability fallback.
14. Recover a client switching between two streaming work streams without
    restarting either inference loop and without losing accepted messages,
    sealed parts, or durably checkpointed provisional output.
15. Make cost scale with active work-stream seconds, useful token batches,
    projection volume, observers, stored data, and actual background work—not
    historical work-stream count or idle clients.
16. Permit a frozen WorkstreamDO to be rebuilt or moved from a verified
    Supabase projection only through an explicit authority-epoch transition,
    never by opportunistically promoting a lagging read model.

## Non-goals

1. Supabase work-stream projections are not a second source of truth. Direct
   client, connector, operator, Workflow, or Worker writes to projected
   work-stream state are rejected.
2. This design does not create a WorkspaceDO. Workspace serialization and
   relational queries belong to the regional Postgres transaction boundary.
3. It does not create one Supabase project, database, schema, queue, or
   connection per workspace or work stream. A Supabase project is a coarse
   regional and capacity shard.
4. It does not write one Postgres row, Durable Object row, or Realtime message
   per model token or per visual frame.
5. “Everything is projected” does not mean every transient WebSocket frame is
   retained. Canonical deltas, checkpoint offsets, final content, and semantic
   transitions are retained; presentation-only interpolation is not product
   state.
6. Workflow is not the work-stream authority, transcript, output buffer, or
   model-context store. Its state remains data-minimal and reconstructable.
7. A Worker request is not the full agent-loop lifetime. Workflow orchestrates
   bounded Worker actions and durable waits.
8. This PRD does not replace Daytona, move Terminal execution into Cloudflare,
   expose a PTY, or change Terminal's existing authorization and reconciliation
   contract.
9. It does not use substreams for physical partitioning, pagination, per-turn
   storage, per-user security, or sidebar identity.
10. It does not promise atomic exactly-once behavior across a Durable Object,
    Postgres, Workflow, model provider, connector, or Daytona. It specifies
    idempotency, effect intent, replay, and reconciliation instead.
11. It does not silently fail an EU workspace over to a Global Supabase shard,
    Durable Object namespace, Worker, queue, provider, log destination, or
    object store.
12. It does not adopt the Cloudflare Actors framework at launch. Native Durable
    Objects expose the exact one-aggregate contract needed here without adding
    another lifecycle, storage, or migration abstraction. Reconsideration
    requires a demonstrated portability or generic-actor need.
13. It does not make the Supabase projection synchronously current for every
    sidebar pixel. The active work stream is immediately current from its DO;
    workspace collections converge under an explicit projection SLO.
14. It does not make a global product-content database or global search index.
    Global Supabase contains only globally required identity, commercial, and
    routing-control facts.

## Product behavior

### Opening a workspace

The desktop resolves the selected workspace through the global routing endpoint.
The signed route names the regional Supabase shard, regional API/Realtime origin,
Cloudflare Durable Object jurisdiction, route epoch, and expiry. The client
establishes a regional session and loads the sidebar from Postgres. No work
stream is woken merely to show its title, description, state, recency, unread
count, mention badge, or assignment.

The initial surface has these states:

- **Loading:** the desktop subscribes to the private workspace common and
  personal Realtime topics, buffers hints, then installs one authorized snapshot
  and durable workspace cursor.
- **Populated:** Postgres returns common cards joined to the current person's
  sparse overlay using keyset pagination.
- **Empty:** there are no visible work streams or suggestions; this is a valid
  database result, not an invitation to wake objects.
- **Offline:** the last local snapshot remains visible with an offline marker.
  Reconnect resumes from the durable workspace event cursor.
- **Error:** authorization, route, schema, or availability errors are distinct.
  The client never guesses another region or treats a stale card as proof that
  its work stream is writable.

### Opening a work stream

The desktop requests a short-lived, single-use socket ticket from the regional
gateway. The gateway checks the live regional membership and route gate, binds
the ticket to person, workspace, work stream, region, authority epoch,
membership revision, capability set, and expiry, then forwards the WebSocket
upgrade to the named WorkstreamDO. The ticket travels in the existing
<code>Sec-WebSocket-Protocol</code> handshake contract and never appears in a
URL.

The DO atomically consumes the ticket. The desktop provides its last canonical
event sequence, active attempt ID, checkpoint revision, and byte offset. The DO
returns either:

- a cursor-bounded snapshot plus later events;
- events after the supplied cursor;
- an explicit snapshot reset when retained replay cannot cover the gap; or
- a terminal authorization/route response containing no content.

The selected work stream becomes interactive only after snapshot and buffered
events reconcile to one cursor. A Supabase projection watermark can explain
sidebar lag but never replaces this hydration protocol.

### Sending queued and steering messages

Every message command has an operation key, expected work-stream revision, and
mode <code>queue</code> or <code>steer</code>. The WorkstreamDO transaction
authenticates the socket capability and current authorization epoch, appends the
typed user part, allocates its canonical sequence, updates run admission, adds a
domain event and projection-outbox item, then acknowledges.

A queued message remains waiting for the next admission boundary. It does not
invalidate the active attempt. Multiple queued messages are admitted exactly
once in canonical order.

A steering message commits the same durable user part and also increments the
run's control revision. The DO sends the new revision over the active executor
WebSocket. The Worker aborts a cancellable model or read-only tool request where
supported. A late output, tool result, or finalization carrying the old revision
cannot win a DO transaction. An irreversible effect begins only after a fresh
effect-intent command commits under the current revision.

If an external write already started, the work stream reports that reality,
reconciles its provider reference, and prevents later stale effects. Steering
does not claim to undo an external side effect.

### Streaming inference

Time to first token is normally 1–5 seconds. Provider token cadence, Worker-to-DO
transport cadence, DO durability cadence, Supabase projection cadence, and
desktop visual cadence are independent:

- the provider streams tokens to the execution Worker;
- the Worker batches output every 50–100 ms, with 10 Hz as the launch target;
- the Worker sends batches over one temporary executor WebSocket whose server
  endpoint is the WorkstreamDO;
- the DO sends useful delta frames to participant sockets and checkpoints its
  bounded active-output tail every 500 ms while observed;
- the DO projects provisional output to Supabase no more than once per second
  while observed and every 2–5 seconds while unobserved;
- the desktop drains each received batch locally at 10, 20, or 30 visual frames
  per second;
- finalization immediately seals one immutable assistant part and projects it.

No empty timer tick writes or broadcasts. A semantic boundary, tool transition,
steering event, finalization, or nearly full chunk flushes immediately.

Text newer than the last DO checkpoint is explicitly provisional and may retract
if an incomplete nondeterministic attempt cannot resume. Supabase's projection
may trail the DO but cannot cause a retraction or select a winner.

### Switching between two streaming work streams

The Electron main process keeps independent caches keyed by work-stream ID. Each
cache contains authority epoch, canonical event cursor, run and attempt IDs,
checkpoint revision, byte offset, hash, active text, and immutable transcript
tail.

When A and B are both running, the desktop may retain both WorkstreamDO sockets
for a bounded active set. Selecting B changes the visible cache; it does not
restart B's Workflow, Worker, provider request, or Daytona command. If B's socket
was closed, the client opens and reconciles B before releasing A. A lost frame
is repaired by cursor or active-output offset, and an old attempt can never be
spliced into a replacement.

Background work streams do not retain sockets merely because they are pinned,
unread, or mentioned. An actively promised completion may keep a hibernatable
socket; otherwise the client closes it and catches up when selected.

### Sidebar and work streams of interest

The regional Postgres read model supplies:

- common metadata: title, description, state, last activity, participant-visible
  error, current run state, and completion time;
- common collections: Work Streams, In Progress, Completed, Error, and recently
  active;
- personal state: You Are Mentioned, Unread, Assigned, Needs Your Input, pinned,
  dismissed, muted, and seen waterline;
- derived interest: work streams selected by explicit state and current-person
  authorization, never by an unbounded model query.

A WorkstreamDO semantic event updates these projections through its ordered
outbox. A Postgres transaction applies the event, updates the common card and
affected personal rows, appends a workspace event, and emits one private
Realtime hint after commit. Active transcript checkpoints do not update the
card, <code>last_active_at</code>, search index, mention rows, or workspace event
log.

The active work-stream header may be newer than the sidebar by the projection
lag. The client accepts the higher authority epoch and canonical sequence from
the DO and labels a materially lagging sidebar as synchronizing. It never writes
the DO value directly into Postgres.

### Connector activity, digests, and suggestions

Connector webhook receipts, raw-body references, normalized activity, resource
versions, audience, provenance, digest windows, suggested work streams,
suggested actions, ranking rounds, feedback, and expiration all live in the
owning regional Supabase shard.

A connector-derived action targeting an existing work stream uses a saga:

1. the regional Postgres transaction freezes provenance, authorization epoch,
   requested action, and idempotency key in <code>pending_delivery</code>;
2. a regional Worker obtains a current WorkstreamDO capability and submits the
   command;
3. the DO commits or returns the prior receipt;
4. the Worker records the DO receipt and canonical sequence in Postgres;
5. ambiguous delivery is reconciled by operation key before any retry.

Accepting a suggested work stream creates its global/regional identity and
regional workspace rows first, then creates the canonical DO under a new
authority epoch. The suggestion becomes <code>accepted</code> only after the DO
creation receipt is stored. A crash exposes <code>starting</code>, not a second
work stream.

### Substreams and compaction

Supported substreams remain a finite set: main, private contextual chat, human
fork, fresh sub-agent investigation, parent-forked sub-agent investigation, and
versioned resource chat. A substream is used when content has a coherent
model-context boundary inside one work stream and may later be summarized or
promoted.

A substream is not used for pagination, a tool call, a model turn, a UI tab, a
participant, a Workflow, a socket, or a database partition. Content requiring
its own title, sidebar card, participants, lifecycle, objective, retention, or
completion is another work stream.

Every part receives one work-stream-wide canonical sequence. Audience and
inheritance are explicit; possession of a substream ID grants nothing.
Promotion appends a provenance-bearing summary or reference and never widens
the child audience retroactively.

Compaction freezes a complete-turn source fence, substream lineage,
authorization epoch, resource-inventory revision, materializer version, and
content hashes. Messages committed while the compactor runs receive higher
sequences and remain the raw tail. Publication succeeds only if the frozen
inputs still match. Supabase receives the resulting canonical event after the
DO commits; it does not run an independent compactor over its projection.

### Failure, offline, and degraded behavior

When Supabase is temporarily unavailable, an existing authorized work stream
continues under a bounded DO projection backlog. The active transcript and
steering remain correct, while the sidebar, search, digest, and suggestions may
show a synchronizing state. Once byte, event-count, or age thresholds are
reached, new agent admission pauses before the outbox can exhaust DO storage.
Participant messages may remain available under a separately tested emergency
budget, but no completion is represented as fully synchronized until the
projection receipt arrives.

When a WorkstreamDO restarts, SQLite restores canonical state and the hibernation
API restores server-side socket attachments. Clients still reconcile by cursor.
In-memory buffers, timers, and inferred connection state are never authority.

When Workflow or an execution Worker fails, another Worker claims only the next
fenced action. Provider effects are reconciled from durable intent and provider
references. A lost inference connection either resumes from a provider-verified
cursor or supersedes the incomplete attempt as a whole.

When the regional route or membership is invalid, the gateway and DO fail
closed. No Global shard, old authority epoch, Supabase projection, or client
cache is accepted as an availability fallback.

## Impact on the product contract

None—the proposal refines infrastructure ownership within Avalon's existing
contract. A work stream remains the home for one shared objective and
conversation; substreams remain contextual lanes rather than channels; viewing
does not create participation; connector and agent authority remains explicit;
and there is no global product inbox or global content search.

The visible contract becomes more explicit in four places:

- queued and steering messages have distinct durable states;
- provisional output can retract only at an attempt boundary;
- a sidebar may briefly show <code>synchronizing</code> behind an active work
  stream;
- membership removal has a measured socket-revocation interval rather than an
  implied atomic cross-service guarantee.

## Decision log

None yet.

## Key design decisions

### Topology

~~~mermaid
flowchart LR
  D["Desktop"] --> G["Global routing Worker"]
  G --> GS["Global Supabase control database"]
  D --> R["Regional gateway Worker"]
  R --> RS["Regional Supabase product shard"]
  R --> WDO["One WorkstreamDO per work stream"]
  D <-->|"Participant WebSocket"| WDO
  WDO -->|"Start or wake by opaque ID"| WF["One Workflow per full loop"]
  WF --> EW["Regional execution Worker"]
  EW --> P["LLM providers and Daytona"]
  EW <-->|"Batched output and steering"| WDO
  WDO -->|"Ordered transactional outbox"| PJ["Regional projector Worker"]
  PJ -->|"Contiguous idempotent RPC"| RS
  RS -->|"Workspace and sidebar Realtime hints"| D
~~~

1. **WorkstreamDO is the sole work-stream authority.** Every command that changes
   common work-stream state, transcript order, run control, effects, compaction,
   or active output commits there first. The rejected alternative is dual writes
   to DO and Postgres, which cannot share a transaction and would create
   unresolvable split-brain after ambiguous failure.
2. **Supabase owns workspace and relational domains.** Membership, connector
   activity, resources, digests, suggestions, user attention, workspace events,
   and cross-work-stream queries commit in regional Postgres. The rejected
   alternative is a WorkspaceDO plus a second relational index, which preserves
   both systems' coordination costs.
3. **There is one required global Supabase control database and one or more
   regional Supabase product shards.** A project is a coarse residency/capacity
   shard, not a workspace. Global contains only globally required identity,
   commercial, invitation, and opaque routing facts.
4. **One Workflow represents one complete agent loop.** It stores only opaque
   IDs, revisions, cursors, enums, hashes, budgets, and timing. One Workflow per
   model turn is rejected because it fragments steering, waits, budgets, and
   finalization.
5. **Cloudflare Workers perform all bounded compute.** Supabase Edge Functions
   are not deployed. Model, tool, connector, compaction, embedding, ranking,
   projection, and reconciliation code use the same Worker runtime as Workflow
   adapters.
6. **Two WebSocket classes terminate at WorkstreamDO.** Participant sockets use
   the Hibernation API. A temporary executor socket carries batched output to the
   DO and steering back to the Worker. The executor socket closes during long
   Daytona, timer, or user waits so it does not hold the object active.
7. **Supabase projection is ordered CQRS, not best-effort replication.** Every
   canonical DO event has one authority epoch, sequence, schema version, payload
   hash, and operation identity. Postgres applies only a contiguous prefix and
   records the receipt atomically with derived rows.
8. **Realtime transport and durable projection have separate cadences.** A
   10 Hz Worker-to-DO batch can render at 30 fps locally; DO durability can be
   2 Hz; Supabase projection can be 1 Hz or slower. The rejected alternative is
   tying every clock to the fastest one.
9. **Supabase Realtime is a workspace invalidation bus.** It carries committed
   sidebar, personal-state, connector, suggestion, and projection-watermark
   hints. Workstream tokens use DO sockets. This removes per-recipient Supabase
   token billing and its project message-rate limit from the inference path.
10. **The existing Avalon authentication authority remains the issuer.**
    Supabase accepts its asymmetric OIDC JWTs through supported Third-Party Auth
    or an imported signing key; regional RLS joins a stable platform identity to
    live membership. If that exact integration cannot be proven, client access
    is proxied through the regional Worker until it can—never through a
    client-held service role.
11. **Authorization revocation is deny-first and bounded.** Postgres rejects new
    tickets before dispatching revocation to registered active DOs. Short
    content-bearing leases provide a hard bound when notification or
    acknowledgement is lost.
12. **Daytona remains the Terminal provider.** Workflow starts or reconciles a
    stable provider operation; WorkstreamDO stores its canonical effect intent
    and result. Neither DO nor Workflow runs coding commands directly.
13. **Native Durable Objects are used without the Actors framework.** The product
    needs one concrete aggregate class and explicit schema/projection migrations.
    A generic actor abstraction adds value only after another proven actor type
    shares its lifecycle and portability requirements.
14. **A projection becomes authority only through a fenced transfer.** Rebuild,
    relocation, disaster recovery, or a future platform move freezes the old DO,
    verifies a complete projection/snapshot at a closure sequence and hash,
    increments the authority epoch, and activates exactly one new DO.
15. **Each authority owns its own asynchronous outbox.** A Postgres transaction
    can enqueue connector, digest, suggestion, migration, and generic-agent work
    in Supabase Queues with its domain change; regional Cloudflare Workers
    consume it. A DO transaction cannot atomically enqueue in Postgres, so
    projection begins in the DO's SQLite outbox and is drained by an alarm or
    projector call. Neither queue is mistaken for domain authority.

### Platform primitive validation

The proposal relies on these current platform contracts and revalidates them
before implementation:

- Supabase requires RLS on exposed relations and separates relation/function
  grants from row policies: [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
  and [Securing the Data API](https://supabase.com/docs/guides/api/securing-your-api).
- Supabase accepts supported third-party or imported-key JWTs, subject to issuer
  and asymmetric-key constraints:
  [JWTs](https://supabase.com/docs/guides/auth/jwts) and
  [Third-Party Auth](https://supabase.com/docs/guides/auth/third-party/overview).
- Postgres-owned jobs use the database-backed
  [Supabase Queues](https://supabase.com/docs/guides/queues), while private
  object access follows [Storage RLS](https://supabase.com/docs/guides/storage/security/access-control).
- Supabase bills Realtime by message send/delivery and enforces project rate
  limits: [pricing](https://supabase.com/docs/guides/realtime/pricing) and
  [limits](https://supabase.com/docs/guides/realtime/limits). That is why token
  frames use DO sockets.
- Cloudflare recommends SQLite-backed Durable Objects for new namespaces; their
  storage is private, strongly consistent, and transactional:
  [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
- Participant sockets use the server-side
  [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/);
  active streaming still incurs the request/duration behavior described in
  [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
- Regional creation uses the
  [Durable Object data-location controls](https://developers.cloudflare.com/durable-objects/reference/data-location/),
  and full-loop budgets are checked against current paid
  [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/).

The 2026-07 Supabase changelog locks the managed <code>realtime</code> schema
against application modification, while RLS policies on managed messages remain
supported. The 2026-04 Data API change also means new tables are not assumed to
be automatically exposed. This PRD modifies neither managed schema and requires
explicit exposure/grants in migrations.

## Data model

### Authority map

| Domain | Canonical authority | Supabase representation |
| --- | --- | --- |
| Global identity and sign-in mapping | Global Supabase | Canonical |
| Organizations, billing, invitations | Global Supabase | Canonical |
| Workspace-to-region/shard route | Global Supabase | Canonical |
| Workspace and membership | Regional Supabase | Canonical |
| Workspace authorization epoch | Regional Supabase | Canonical |
| Connector credentials and activity | Regional Supabase | Canonical |
| Digests and suggestions | Regional Supabase | Canonical |
| User seen, mention acknowledgement, pins, assignments | Regional Supabase | Canonical |
| Work-stream identity and DO route | Regional Supabase | Canonical directory |
| Work-stream title/state/last activity | WorkstreamDO | Ordered projection |
| Conversation, substreams, compaction | WorkstreamDO | Ordered projection |
| Work-stream agent runs and effects | WorkstreamDO | Ordered projection |
| Active generated output | WorkstreamDO | Coalesced projection |
| Generic non-workstream agent runs | Regional Supabase | Canonical |
| Large resource bytes | Regional Supabase Storage | Canonical bytes plus Postgres metadata |
| FTS and vectors | Regional Supabase | Derived and rebuildable |
| Full-loop execution progress | WorkstreamDO plus Workflow | DO canonical; Workflow reconstructable |

### Global Supabase tables

The global project contains no work-stream title, description, message,
activity, suggestion, embedding, resource body, sidebar overlay, or regional
database credential.

| Table | Required fields and constraints | Purpose |
| --- | --- | --- |
| <code>global_accounts</code> | platform_user_id PK; issuer and subject unique; state; session_epoch; timestamps | Stable person and global session fence |
| <code>organizations</code> | organization_id PK; billing owner; state; timestamps | Global tenant/commercial scope |
| <code>organization_roles</code> | organization_id plus platform_user_id PK; reviewed role; revision; state | Billing/account administration, never regional content authorization |
| <code>workspace_invitations</code> | invitation_id PK; organization/workspace IDs; recipient binding; selected region; route epoch; role; state; expiry; acceptance receipt | Pre-regional invitation discovery and one-time acceptance |
| <code>billing_entitlements</code> | organization_id PK; opaque provider refs; plan; entitlement revision; state | Commercial admission without product usage replicas |
| <code>regional_shards</code> | shard_id PK; region_key; lifecycle; capacity class; opaque API/Realtime origin refs; schema compatibility; route key ID | Directory of regional Supabase shards and Cloudflare entrypoints |
| <code>workspace_routes</code> | workspace_id PK; organization; immutable region; shard; route_epoch; authority state; move source/destination; closure receipt | Canonical workspace route and global lifecycle |
| <code>routing_commands</code> | command_id PK; operation key unique per workspace; epoch; target shard; allowlisted type; bounded non-content payload; hash; state; retry fields | Transactional global outbox |
| <code>routing_command_attempts</code> | command and attempt PK; dispatcher Workflow; outcome; redacted error; timestamps | Retry diagnostics |
| <code>routing_command_receipts</code> | command_id PK; target shard; regional receipt; epoch; response hash; observed time | Proof that the regional transaction committed |

Global and regional databases never share a transaction. A global command is
acknowledged only after a matching regional receipt with the expected shard,
epoch, operation, and hash is observed.

### Regional Supabase workspace and authorization tables

| Table | Required fields and constraints | Purpose |
| --- | --- | --- |
| <code>platform_identities</code> | regional principal PK; platform_user_id unique; issuer/subject unique; session_epoch; state | Maps the existing identity issuer to the regional principal used by RLS |
| <code>workspace_route_gates</code> | workspace_id PK; local shard/region; route_epoch; state; closure cursor/hash | Rejects wrong-shard and stale global commands |
| <code>global_command_receipts</code> | command_id PK; epoch; payload hash; result state/hash; applied time | Idempotent regional application of global commands |
| <code>workspaces</code> | workspace_id PK; organization; region; shard; route_epoch; name; state; timezone; authorization_epoch; timestamps | Canonical workspace |
| <code>workspace_members</code> | workspace plus platform_user PK; role; membership_revision; state; last_seen_at; timestamps | Live membership and per-workspace attention scheduling |
| <code>workspace_authorization_changes</code> | change_id PK; workspace; authorization epoch; kind; subject; state; deadline; timestamps | Deny-first membership and capability invalidation |
| <code>active_workstream_sessions</code> | workspace/workstream/DO ID/session lease PK; subject; membership revision; authority epoch; expires; last confirmed | Bounded registry for targeted revocation; stale rows expire |
| <code>workstream_revocation_commands</code> | command_id PK; workspace/workstream/DO; target authorization epoch; subject; state; attempt; deadline | Regional outbox to evict active DO sockets |
| <code>workstream_revocation_receipts</code> | command/workstream PK; observed epoch; evicted count; result hash; applied time | Proof of active-object convergence |

Workspace membership is canonical here. Global organization roles do not grant
regional data access. A removed member is denied a new HTTP request, Data API
query, Storage operation, Realtime join, or DO socket ticket as soon as the
regional transaction commits.

### Regional Supabase work-stream directory and projection tables

| Table | Required fields and constraints | Purpose |
| --- | --- | --- |
| <code>workstream_directory</code> | workstream_id PK; workspace; DO class/ID; authority_epoch; lifecycle; created_by; created/closed time | Canonical identity and active DO route, not work-stream content |
| <code>workstream_projection_state</code> | workstream plus authority epoch PK; projected_through_seq; last hash; DO high-water hint; status; lag metrics; schema version; timestamps | Contiguous read-model watermark and health |
| <code>workstream_projection_events</code> | workstream/epoch/seq PK; event_id unique; type; schema; payload hash; bounded payload or content ref; committed/applied times | Immutable ordered replica and rebuild source |
| <code>workstream_cards</code> | workstream PK; workspace; authority epoch; projected seq; title; description; state; error class; last activity; current run state; completed time; revision | Common sidebar/search projection |
| <code>workstream_user_state</code> | workstream plus platform_user PK; seen seq; mention high-water and acknowledgement; assigned/needs-input/pin/mute/dismiss state; revision | Canonical user overlay joined to projected head |
| <code>workstream_mentions</code> | workstream/part/mentioned user PK; canonical seq; audience revision; projected time | Authorized mention provenance |
| <code>workstream_substreams_projection</code> | workstream/substream PK; kind; parent; base seq; audience descriptor; lifecycle; projected seq | Query/export projection |
| <code>workstream_parts_projection</code> | workstream/authority epoch/canonical seq PK; part ID unique; substream; type; author/provenance; audience descriptor; immutable body/ref/hash; timestamps | Queryable immutable conversation projection |
| <code>workstream_active_output_projection</code> | workstream/attempt/chunk PK; checkpoint revision; start/end offset; bounded bytes; hash; state; projected time | Coalesced provisional recovery/read model |
| <code>workstream_run_projection</code> | run ID PK; workstream; input fence; state; control revision; step/tool summary; timing; projected seq | Support and workspace-state projection |
| <code>workspace_events</code> | workspace plus event cursor PK; kind; subject IDs; common/personal audience key; source workstream seq; timestamps | Durable sidebar and offline replay |
| <code>projection_apply_receipts</code> | batch ID PK; shard; event count; per-stream first/last seq hashes; outcome; timestamps | Idempotent projector RPC result |

Only the projector role executes <code>apply_workstream_projection_batch</code>.
The RPC locks projection states in a stable order, rejects a gap, authority
epoch mismatch, conflicting event ID/hash, or stale schema, inserts the immutable
events, updates derived tables, appends workspace events, records the receipt,
and commits once. A poison work stream is isolated from later batches rather
than blocking unrelated streams forever.

The client does not directly mutate common work-stream projections. User-overlay
commands such as seen, pin, mute, or dismiss are regional Postgres commands.
When a seen cursor is newer than the current projection, the regional Worker
attests it against the DO before advancing the Postgres waterline; otherwise the
local UI remains optimistic until projection catches up.

### Regional connector, activity, suggestion, and generic-agent tables

| Family | Representative canonical tables | Contract |
| --- | --- | --- |
| Connector configuration | connections, credentials, capabilities, source routes, watches | Encrypted, versioned, regional, execution-principal scoped |
| Ingress | ingress_receipts, ingress_attempts, content_refs | Exact-byte dedupe, conflict quarantine, pending/finalized Storage state |
| Activity | activity_events, resource_versions, audience edges | One workspace owner, immutable provenance/version/tombstone |
| Digests | schedules, windows, source links, runs, deliveries | Frozen watermark/audience; delivery idempotency separate from generation |
| Suggested work | opportunities, user links/state, provenance graph, ranking rounds, suggested sets | Stored ranking; no model call on read; suggestion is not a work stream before receipt |
| Suggested actions | action proposals, acceptance intents, DO delivery receipts | No side effect before authorized acceptance |
| Generic agent loops | agent_runs, steps, effects, waits, events, active output | Same Workflow driver for non-workstream owners, with Postgres as their domain authority |
| Migration/repair | campaigns, jobs, receipts, exceptions | Bounded, pausable, idempotent regional slices |

The detailed table names may retain Avalon's existing naming during migration,
but the ownership and transaction contracts above are mandatory.

### Regional resources, search, and Storage

Postgres <code>content_refs</code> is authoritative for workspace, visibility,
source version, Storage key, byte count, media type, checksum, encryption state,
retention, and lifecycle. Private Supabase Storage contains large immutable
bytes. A DO conversation part stores only an immutable authorized resource
reference and expected version/hash.

Uploads finalize in Supabase before a WorkstreamDO may reference them. Deletion
revokes Postgres authorization first, invalidates the workspace authorization
or resource-inventory epoch, then removes bytes asynchronously with a receipt.
Database PITR alone does not prove Storage restoration.

Postgres FTS and pgvector index only sealed, currently authorized projected
parts and canonical workspace activity/resources. Embeddings are derived,
versioned, and rebuildable. Active-output chunks are never embedded or indexed.

### WorkstreamDO SQLite tables

Every table is private to one work stream. All sequence, revision, and authority
checks occur in short SQLite transactions.

| Table | Required fields and constraints | Purpose |
| --- | --- | --- |
| <code>object_meta</code> | singleton schema version; workspace/workstream IDs; region; authority epoch; authorization epoch; canonical next seq; projection ack; lifecycle | Identity, migration, and global fences |
| <code>workstream_state</code> | singleton revision; title; description; state; last activity; current run; error/completion fields | Canonical common metadata |
| <code>substreams</code> | substream ID PK; kind; parent; base seq; inheritance; audience descriptor; scope/resource revision; lifecycle; depth | Explicit context lanes |
| <code>conversation_parts</code> | canonical seq unique; part ID unique; substream; type; author/principal; immutable body/ref; turn/tool relation; audience descriptor; hashes; timestamps | Provider-neutral ordered transcript |
| <code>part_relations</code> | source/target/type PK; canonical sequence constraints | Tool pairs, supersession, promotion, replacement, attachment provenance |
| <code>run_control</code> | singleton active run; control revision; admitted through seq; queued through seq; interrupt state; authorization/materializer revisions | Queue, steer, and admission fence |
| <code>agent_runs</code> | run ID PK; owner/input fence; Workflow ID; state; budgets; timing; terminal reason; revision | Canonical full-loop lifecycle |
| <code>agent_steps</code> | run/step PK; action type; claim revision; state; input/output hashes; provider ref; timing | Bounded Workflow action ledger |
| <code>tool_effects</code> | effect ID PK; run/turn/position identity; tool/connection; canonical input hash; intent/result state; provider key/ref; output ref/hash | External-effect idempotency and reconciliation |
| <code>run_wait_events</code> | event ID PK; run; kind; payload hash/ref; created/consumed time | Early-safe durable wake and user/tool events |
| <code>active_output_attempts</code> | attempt ID PK; run/part; generation epoch; checkpoint revision; durable offset/hash; status; provider cursor; timestamps | Stable provisional-output root |
| <code>active_output_chunks</code> | attempt/chunk PK; start/end offsets; bounded 16 KiB bytes; hash; open/sealed/abandoned state | Bounded mutable tail and immutable prior chunks |
| <code>compactions</code> | compaction key unique; substream; source fence/hash; authorization/resource/scope/materializer revisions; summary part; state | Safe frozen-prefix summary |
| <code>command_receipts</code> | operation key PK; actor/principal; command; canonical input hash; result seq/revision/hash; timestamps | User/system command replay |
| <code>domain_events</code> | authority epoch plus canonical seq PK; event ID unique; schema/type; payload hash/ref; timestamp | Canonical event stream |
| <code>projection_outbox</code> | authority epoch plus canonical seq PK/FK to domain event; payload/ref; attempt; next attempt; created time | Transactional Postgres projection source |
| <code>projection_batches</code> | batch ID PK; first/last seq; batch hash; state; attempt; Supabase receipt; timestamps | Delivery and ambiguity reconciliation |
| <code>authorization_commands</code> | regional command ID PK; target authorization epoch; subject; hash; applied time | Idempotent membership/resource revocation |
| <code>socket_lease_epochs</code> | subject and membership revision PK; newest authorization epoch; revoked time | Durable invalidation for hibernated socket attachments |

No durable row is written for every socket, heartbeat, token, or animation
frame. Hibernatable participant connection metadata is stored in bounded,
encrypted WebSocket attachments and rechecked against the durable lease epoch
after wake.

### Cross-system relationships

The system has four deliberate nontransactional edges:

1. **WorkstreamDO to Supabase:** the DO transaction appends its domain event and
   projection outbox together. At-least-once delivery plus a contiguous
   Postgres watermark resolves duplicates, gaps, crashes, and ambiguous
   responses.
2. **Supabase membership to WorkstreamDO:** the Postgres transaction denies new
   admission and appends revocation commands. Active DOs apply the signed epoch,
   evict sockets, and return receipts. Short leases bound missed delivery.
3. **Workflow/Worker to WorkstreamDO:** a Worker claims one fenced action,
   performs at most one external effect, and commits or reconciles through the
   DO. Workflow retries code but never decides domain state.
4. **Postgres metadata to Storage/provider bytes:** pending/finalized/deleting
   states and checksummed receipts resolve uploads, deletion, and external
   effects without a distributed transaction.

## Regional impact

The global Supabase database is one non-product identity and routing-control
plane. Each product region has one or more complete Supabase project shards and
its own Cloudflare Worker deployment, Durable Object namespace/jurisdiction,
secrets, Storage buckets, queues, Workflow adapters, provider configuration, and
observability destinations.

A workspace route contains opaque region, Supabase shard, DO jurisdiction/class,
route epoch, and endpoint identifiers. Product content never crosses the global
database. EU work streams use a Durable Object namespace resolved with the EU
jurisdiction and regional Worker admission; their projections, resources,
connector state, search, and user overlays stay in the assigned EU Supabase
shard.

Workflow input and result contain no prompts, messages, connector bodies, token
text, Terminal output, file bytes, or secrets. The regional Worker loads product
data only after entering the approved regional processing path. Queue, Workflow,
Worker logs, tracing, outbound provider processing, Supabase Realtime/Auth/
Storage/backups/support, and Daytona remain launch-gating contractual paths;
selecting a region in either vendor is not by itself an end-to-end residency
proof.

A same-region Supabase shard move does not change the canonical DO. It freezes
projection delivery, copies and verifies the relational workspace/read model,
switches the regional shard route epoch, and resumes projection to the
destination. A cross-region move is not supported by this PRD. A future
authority move must transfer both regional workspace data and the WorkstreamDO
under one explicit closure protocol.

## Security and trust model

Canonical application tables live in a private schema. The exposed API schema
contains only narrowly granted security-invoker views and RPCs. RLS is enabled
on every exposed relation and as defense in depth on tenant tables. New tables
are not assumed to be Data API-visible: migrations explicitly grant the minimum
table/function access separately from RLS.

Avalon's existing authentication issuer uses asymmetrically signed, short-lived
OIDC JWTs accepted through Supabase Third-Party Auth or an imported signing key.
The regional subject maps to <code>platform_identities</code>. Authorization
does not trust user-editable JWT metadata or a workspace list in a stale token;
RLS and mutation RPCs join the live <code>workspace_members</code> row and its
revision. Key rotation behavior and every regional project configuration are
validated before launch.

Views use <code>security_invoker</code>. UPDATE policies define both visibility
and resulting-row checks and have matching SELECT policies. Any unavoidable
security-definer function lives outside exposed schemas, uses an empty search
path and fully qualified identifiers, performs an explicit live authorization
check, has PUBLIC execution revoked, and is tested under anonymous, member,
removed-member, wrong-workspace, and runner principals.

No client receives a Supabase service role, database password, Storage service
credential, Workflow secret, DO namespace binding, model/provider secret, or
Daytona credential. Cloudflare Workers hold shard-scoped server credentials.
The projector credential can apply only the projection RPC; it cannot mutate
membership, invitations, connector credentials, suggestions, or global routes.

Participant WebSocket tickets remain one-time, short-lived, exact-origin,
person/workspace/workstream/region/epoch bound, and carried in the handshake
subprotocol rather than the URL. A socket attachment is an optimization, not
authorization. Every command validates the durable authority and authorization
epochs; content-bearing leases require renewal after their hard interval.

Membership removal proceeds deny-first:

1. Postgres increments the workspace authorization epoch, marks the membership
   removed, and appends revocation commands in one transaction.
2. New HTTP, Realtime, Storage, and DO ticket admission is denied immediately.
3. A Worker dispatches signed revocation to registered active DOs.
4. Each DO durably advances the epoch, evicts matching sockets, invalidates
   queued private work, and returns a receipt.
5. The product reports removal converged after receipts or the hard content
   lease expires. The launch target is less than two seconds p95 and a 15-second
   hard bound, subject to security review and measured clocks.

Provider/model content, connector payloads, filenames, tool output, Daytona
commands, and projected JSON are untrusted. Projection schemas use reviewed
event types, bounded payloads, strict unknown-field rejection, versioning, and
hash verification. A malformed or unknown event quarantines one work stream
without granting the projector arbitrary SQL.

## Agent behavior

No model-visible tool or plugin contract changes. The hosting contract changes:

1. WorkstreamDO admits a frozen input range and creates a canonical run.
2. It creates or wakes one deterministic Workflow instance.
3. Workflow calls the regional execution Worker with opaque identifiers.
4. The Worker claims one step from the DO under run, control, authorization,
   materializer, and effect revisions.
5. The Worker loads the authorized provider message array and current resource
   references, then performs one model, tool, compaction, or reconciliation
   action.
6. During inference it streams bounded batches over the executor WebSocket.
7. Before a tool side effect it commits immutable effect intent in the DO.
8. It commits a result or classifies the provider outcome as unknown.
9. Workflow continues, waits for a durable event, waits until a time, reconciles,
   or reaches terminal state.
10. The terminal DO transaction seals output, updates common state, appends
    projection events, and returns one winning terminal result.

The loop normally lasts 2–30 minutes. A coding loop may rarely exceed two hours.
No single Worker request must remain open for that whole lifetime. One inference
request may legitimately last minutes while bytes flow; a Daytona command starts
an addressable provider session and later reconciles or receives a callback.
Workflow waits do not require a hot WorkstreamDO or an open participant socket.

Generic non-workstream loops use the same Workflow/Worker driver and effect
protocol, but their domain authority is regional Postgres rather than a fake
WorkstreamDO. The driver accepts an owner kind and calls the owner's claim,
commit, wait, and reconcile adapter.

## Performance and cost

### Token and persistence clocks

For 100 tokens per second and 10,000 tokens total, generation lasts about 100
seconds and produces roughly 40 KiB under a four-byte-per-token planning
assumption.

| Path | Launch cadence | Operations for one 100-second run |
| --- | ---: | ---: |
| Provider to Worker | Native stream | Provider-defined |
| Worker to DO executor socket | 10 Hz, nonempty only | Up to 1,000 incoming frames |
| DO to participant sockets | At most useful transport cadence | Up to 1,000 outgoing frames per observer; local animation may reduce this |
| DO SQLite checkpoint | 500 ms observed | At most 200 bounded-tail transactions |
| Supabase provisional projection | 1 s observed | At most 100 row operations before batching |
| Supabase unobserved projection | 2–5 s | 20–50 row operations |
| Supabase finalization | Immediate | One immutable final part plus semantic projections |
| Desktop presentation | 10/20/30 fps | No platform messages or writes |

The executor sends no frame without new bytes. The DO keeps one checkpoint
request/transaction in flight, sends only the new delta and expected offset, and
mutates only an open bounded chunk. Supabase similarly applies deltas, never the
complete growing prefix.

### Concurrent streams

If each stream projects independently:

| Concurrent observed streams | 500 ms Supabase-only checkpoints | 1 s hybrid projections | 2 s hybrid projections |
| ---: | ---: | ---: | ---: |
| 10 | 20 writes/s | 10 writes/s | 5 writes/s |
| 50 | 100 writes/s | 50 writes/s | 25 writes/s |
| 100 | 200 writes/s | 100 writes/s | 50 writes/s |
| 300 | 600 writes/s | 300 writes/s | 150 writes/s |

The projector may batch contiguous events from multiple work streams in one
RPC, reducing transaction and connection overhead while preserving per-stream
row and WAL work. Provisional tables have no FTS, vector, secondary audience,
sidebar, or trigger fan-out. Only sealed parts enter expensive derived indexes.

At tens of simultaneous streams, write volume is a low concern. At roughly
50–150 it requires production-shaped load tests and appropriate compute. At
hundreds it requires adaptive projection cadence, batching, lag budgets, and a
regional-shard plan. Sustained 500–1,000 streams on one primary is a high-risk
configuration even though raw text throughput remains modest.

### Realtime and socket economics

Supabase Realtime charges per send and per recipient delivery and has per-project
message-rate limits. This design emits no Supabase token hint at 2 Hz. A workspace
Realtime message occurs only for a semantic card/personal event or a materially
advanced projection watermark, and a background desktop closes its socket after
a grace period.

WorkstreamDO charges still matter. Participant and executor incoming WebSocket
messages are metered under Cloudflare's Durable Object pricing and active
inference may keep the object hot. Outgoing DO WebSocket messages are not billed
as requests. The Hibernation API removes idle-duration cost after handlers
finish; it does not make an actively streaming inference free. Batching every
50–100 ms, closing executor sockets during waits, and animating locally are
mandatory cost controls.

Capacity planning tracks:

- active work-stream seconds by region;
- executor and participant incoming frames;
- observers per stream and outgoing bytes;
- DO active duration, requests, SQLite rows written, and storage;
- projection events, rows, bytes, lag, retries, WAL, dead tuples, and vacuum;
- Supabase pool, CPU, disk IOPS/throughput, Realtime connections/messages, and
  egress;
- Workflow steps, state, running/queued instances, and Worker CPU/subrequests;
- provider, embedding, Daytona, and connector usage.

## Failure modes and limits

| Failure | Required behavior |
| --- | --- |
| DO commits; Supabase call fails | Outbox retains the contiguous event; retry returns the same operation; sidebar may synchronize |
| Supabase commits; response is lost | Projector retries the same batch ID; receipt returns without duplicate projection |
| Projection event gap | RPC rejects the batch and requests the missing sequence; it never skips ahead |
| Conflicting event ID or hash | Quarantine the stream and page operations; do not overwrite evidence |
| Projection lag exceeds budget | Slow provisional output first, then pause new runs; never drop final/authorization events |
| WorkstreamDO restart | Rebuild in-memory state from SQLite; socket clients reconcile by cursor |
| Executor socket disconnect | Abort/reconcile provider request; old revision cannot seal; Workflow retries the bounded step |
| Steering notification lost | Commit/effect fences reject the stale revision at the next DO transaction |
| Workflow event arrives before wait | Durable DO wait event is consumed exactly once when Workflow next claims |
| Daytona timeout | Reconcile by named provider operation before retry; unknown writes become participant-visible |
| Membership revoke notification lost | New admission remains denied; short content lease expires within the hard bound |
| Supabase regional shard unavailable | Existing DO may operate only within bounded projection backlog; no other-region fallback |
| DO namespace unavailable | Sidebar projection remains readable and visibly stale; work-stream mutations fail rather than write Postgres |
| Realtime message lost | Workspace client catches up from <code>workspace_events</code>; work-stream client catches up from DO cursor |
| Compaction finishes after new messages | Publish frozen prefix only; new messages remain raw tail |
| Compaction authorization changed | Reject summary and schedule a new fence |
| Restore rolls Postgres backward | Reconcile projection high-watermarks and external effects before reopening admission |
| Projection has newer epoch than old DO | Old DO is closed and cannot accept commands; operator follows authority-transfer receipt |

No table, queue, socket, Workflow state, log, or replay buffer may grow without a
documented byte/count/time bound. Launch values are load-tested rather than
inferred from vendor maxima.

## Rollout

The feature flag is <code>hybrid_workstream_do_authority</code>, evaluated at
workspace creation and pinned to a workspace architecture generation. A
workspace never changes authority because a request saw a different flag value.

1. **Provision global and regional Supabase foundations.** Create private and
   exposed schemas, existing-auth integration, routing, workspace, membership,
   connector, activity, resource, suggestion, projection, generic-run, audit,
   Storage, RLS, backup, and observability contracts. No work-stream authority
   changes.
2. **Deploy the new SQLite WorkstreamDO class.** Add schema versioning, domain
   events, projection outbox, authorization commands, hibernating participant
   sockets, and projector endpoints. Exercise it with synthetic workspaces.
3. **Shadow projection.** Feed current canonical work-stream changes into the
   new projection tables, compare sequence/count/hash/card/user-overlay results,
   and keep all reads on the old path.
4. **Shadow DO authority.** Build candidate DOs from a frozen source snapshot,
   replay held events, and compare provider arrays, compactions, run/effect
   states, and active output without accepting user writes.
5. **Cut over a canary work stream.** Close the old source at one immutable
   sequence/hash, verify a complete Supabase projection, activate exactly one DO
   under an incremented authority epoch, update the regional directory, then
   admit sockets and commands.
6. **Enable workspace/sidebar reads from Supabase.** Keep reconciliation and an
   operator-visible lag/authority view. Never repair by directly editing a
   projected work-stream row.
7. **Scale regionally.** Increase canary percentages only after revocation,
   streaming, projection, restore, migration, cost, and EU gates pass under
   10, 50, 100, and several-hundred-stream tests.
8. **Retire old authorities.** Keep immutable closure receipts and migration
   manifests. Delete legacy state only after retention, export, restore, and
   rollback windows expire.

Before authority cutover, rollback discards the candidate DO/projection. After a
DO becomes authoritative, rollback means disabling new run admission or moving
authority through another fenced transfer; it never means reopening the old
writer beside it.

## Acceptance

### Authority and projection

1. Every work-stream mutation has exactly one canonical DO sequence and one
   authority epoch.
2. Direct writes to common Supabase work-stream projections are denied to
   clients, operators, connector consumers, and generic runners.
3. A crash before and after each DO-outbox, delivery, Postgres-commit, receipt,
   and acknowledgement boundary converges to one contiguous projection.
4. Duplicate batches return the original receipt; gaps and conflicting hashes
   fail closed.
5. A reconciliation job proves card, transcript, run, effect, and projection
   hashes for canary work streams without waking every historical DO.
6. Supabase outage and recovery preserve every canonical event while exposing
   bounded lag and backpressure.

### Realtime, queueing, steering, and switching

7. A 1–5 second TTFT run streams through Worker to DO to desktop without
   Supabase token Broadcast.
8. A 100-token-per-second, 10,000-token run creates no token rows, stays within
   the configured 10 Hz transport, 2 Hz DO checkpoint, and 1 Hz Supabase
   projection ceilings, and seals one byte-identical final part.
9. Local 10, 20, and 30 fps presentation changes neither network nor database
   operation counts.
10. Empty token ticks produce no frame, write, event, or Broadcast.
11. Queued input is admitted once after the active boundary; steering input
    durably increments the revision before acknowledgement.
12. Steering aborts a cancellable inference promptly; an uncancellable late
    result cannot seal or start a later effect.
13. Switching A-to-B-to-A while both stream preserves independent cursors and
    attempts, restarts neither loop, and loses no durable byte through delayed,
    duplicated, missing, or reordered frames.
14. A background desktop closes unused sockets and recovers from cursors without
    reconnect churn or an inference restart.
15. Participant sockets hibernate during quiet periods; a long Daytona or user
    wait does not hold an executor socket or hot DO unnecessarily.

### Sidebar, activity, and suggestions

16. Work Streams, In Progress, Completed, Error, recency, You Are Mentioned,
    Unread, Assigned, and Needs Your Input return from one regional Postgres
    query without waking DOs.
17. A DO state transition updates common and affected personal projections in
    one Postgres transaction and is replayable after a lost Realtime hint.
18. Token checkpoints do not churn sidebar rows, search, vectors, workspace
    events, mention rows, or Realtime.
19. Duplicate and conflicting connector deliveries preserve exact provenance
    and never create duplicate activity, digest, suggestion, or work-stream
    commands.
20. Suggested work remains a proposal until the DO creation receipt is stored;
    accepting twice creates one work stream.
21. A suggested action targeting an existing stream reconciles an ambiguous DO
    delivery by operation key before retry.
22. FTS/vector queries return only current authorized sealed content; active
    output and revoked resources cannot leak.

### Authorization and regional behavior

23. Existing Avalon auth JWTs are accepted through a supported asymmetric
    Supabase configuration; RLS uses live regional membership rather than
    user-editable or stale workspace claims.
24. Anonymous, wrong-workspace, removed-member, private-substream, stale epoch,
    projector, and generic-runner policy suites fail or succeed exactly as
    specified.
25. Membership removal denies new access at commit, evicts active content
    sockets under two seconds p95, and meets the reviewed hard bound when
    notification/acknowledgement is lost.
26. A stale DO, route, ticket, Workflow, Worker, projection, or client cannot
    advance authority or disclose content after an epoch change.
27. EU tests prove global DB minimization and the approved regional path for
    Supabase, DO, Worker, Workflow, queues, Storage, logs, model providers, and
    Daytona; every unavailable component fails closed.

### Agent loops, tools, compaction, and recovery

28. The same driver completes normal 2–30 minute work-stream and non-workstream
    loops.
29. A failure-injected 2+ hour coding loop survives deploys, desktop closure,
    hibernation, early events, Workflow retry, and Daytona tail latency without
    duplicate effects.
30. Workflow state/log inspection contains no product content and remains within
    paid-plan step, event, result, state, running, queued, and creation limits.
31. Tool effects commit intent before execution and reconcile ambiguous provider
    outcomes without blind retries.
32. Messages committed during compaction remain a raw tail; a stale
    authorization/resource/materializer result cannot publish.
33. Restore tests reconcile Postgres, Storage, DO projections, Workflows,
    connector deliveries, and external effects before reopening writes.
34. A fenced rebuild from Supabase activates one new DO only after closure
    cursor/hash verification and authority-epoch increment; the old DO remains
    permanently unable to write.

### Performance and operations

35. Regional load tests cover 10, 50, 100, 300, and target-peak simultaneous
    streams with representative members, connector bursts, sidebar reads,
    offset recovery, search, queue consumers, compaction, and generic loops.
36. Tests record DO requests/duration/rows/storage, Worker CPU/subrequests,
    Workflow steps/state, Postgres latency/locks/pool/WAL/vacuum/IO, projection
    lag/retries, Realtime connections/messages, Storage egress, and total cost.
37. Admission slows provisional projection before final/authorization events
    and pauses safely before any outbox or database limit is exhausted.
38. Alerts cover route/authority mismatch, projection lag/gap/conflict,
    revocation deadline, stuck run/effect, socket churn, database saturation,
    queue age, Storage orphan, migration exception, and restore divergence.

## Open questions

1. **Blocking:** Does Avalon's existing issuer already meet Supabase
   Third-Party Auth's asymmetric OIDC discovery and claim requirements, or must
   it adopt an imported signing key or a Worker-proxied transition?
2. **Blocking:** What contractual path proves EU placement and metadata handling
   for Supabase Database/Auth/Realtime/Storage/backups/support and Cloudflare
   DO/Worker/Workflow/Queue/logs/outbound providers?
3. **Blocking:** Is the proposed under-two-second p95 and 15-second hard
   content-socket revocation bound acceptable, and what lease-renewal traffic
   does it produce at peak?
4. What projection SLO does the sidebar require: p95 below 500 ms, one second,
   or a semantic boundary rather than time?
5. Should observed provisional output project every one second, or can Supabase
   retain only 2–5 second checkpoints plus immediate final content because DO
   PITR is the primary recovery path?
6. What exact event payload size and inline-versus-Storage threshold keeps the
   DO outbox, Queue, Worker request, and Postgres RPC under their tested limits?
7. Does direct per-DO projection remain simpler through the first 100 concurrent
   streams, or does launch require a regional batching buffer/queue?
8. What amount of projection lag pauses only new inference versus all
   participant mutation, and how much DO storage is reserved for that backlog?
9. How many simultaneous foreground/running WorkstreamDO sockets may one desktop
   retain before it must hand off by subscribe-buffer-snapshot?
10. Which work-stream fields are sufficiently common and stable to duplicate in
    the regional directory for routing, if any, without creating a shadow
    authority?
11. What Supabase project compute/disk tier and number of regional shards pass
    the 100- and 300-stream tests with connector, search, vector, and generic
    agent load present?
12. What export, retention, legal-hold, and deletion contract applies when
    canonical DO data and its Supabase projection have different physical
    restoration mechanisms?
13. What production evidence would justify adopting the Cloudflare Actors
    framework after launch rather than keeping the explicit native DO class?
