# Supabase ecosystem research for Avalon workspace and work-stream conversations

**Research date:** 2026-08-15

**Purpose:** source material for a first-principles Supabase implementation of the product contract in the Cloudflare Durable Objects PRD and its user-study flows. This is research, not the Supabase PRD itself.

## Executive conclusion

Avalon can preserve the important product semantics without emulating one Durable Object per workspace or work stream. The idiomatic Supabase authority is one regional Postgres database, with short row-locked transactions providing per-work-stream serialization, relational tables providing workspace-wide projections, private Realtime Broadcast providing low-latency invalidation and active-output coordinate hints, and durable sequence-numbered event tables providing replay. This makes the most awkward Durable Object boundary—the reliable child-to-parent sidebar projection—a local database transaction.

The recommended shape is:

- one required global Supabase control project for sign-in identity,
  invitations/billing, regional-shard inventory, workspace routes/epochs, and
  idempotent routing-command outbox/receipts, with no work-stream content;
- one or more Supabase product-project shards per residency boundary, initially
  `global-us-1` and `eu-1`;
- Postgres as the only authority for conversation ordering, run admission, unread/mention state, sidebar projections, connector normalization, compaction fences, and action lifecycle;
- database Broadcast for transactional semantic invalidation/control hints and
  direct REST Broadcast for post-commit token checkpoint coordinates, with
  generated bodies fetched through live RLS and animated locally at 10/20/30
  fps unless a revocable stream lease is proven;
- durable Supabase Queues (`pgmq`) plus Cron for transactional jobs and wakes;
- Cloudflare Worker fetch handlers for every application/provider/background
  compute action, plus exactly one Cloudflare Workflow per full agent loop;
- Supabase Storage for large immutable bodies and files, with an application table as the authoritative registry;
- pgvector plus Postgres full-text search for the initial, authorization-aware search implementation;
- Daytona remaining the Terminal execution provider and outside the infrastructure replacement scope.

The compute decision is now explicit: Supabase Edge Functions are not selected,
and Avalon will not build a parallel Queue/Cron lease-based workflow engine.
One Cloudflare Workflow is the generic durable loop abstraction for both work-
stream and non-work-stream agents. Bounded Cloudflare Worker fetch handlers
perform connector, model, tool, compaction, embedding, suggestion, migration,
and reconciliation work. Supabase remains the product/realtime authority;
Workflow state contains opaque identifiers and cursors, not prompts, connector
content, model output, or Terminal output. A direct Worker request is not the
full-loop boundary.

Cloudflare service bindings normally execute bound Workers on the same server,
and placement hints can put fetch handlers near a Supabase backend. Those are
performance tools, not an EU proof: Smart Placement does not apply to RPC/named
entrypoints, and Regional Services does not cover Workflow/Queue/Cron triggers
or outgoing Worker subrequests. EU content-bearing actions must enter an EU
Regional Services Worker hostname, while Workflow state/results remain opaque;
the complete path is still contract-gated.

## Research method and product baseline

This document maps the source PRD's complete product model and the 75 showcase/
break flows rather than mechanically translating components. Supabase docs,
changelog, and billing pages cover the data platform; PostgreSQL covers
transaction semantics; Cloudflare docs cover the selected Worker/Workflow
compute, placement, localization, limits, and pricing.

The source contract that must survive the implementation change includes:

- workspace collections and sparse per-user sidebar state;
- work-stream-local ordered parts, provider-neutral message arrays, explicit substreams, and inherited context;
- committed queued messages and committed steering messages;
- safe loop admission, interruption, tool-side-effect fencing, and terminal-state convergence;
- immutable compaction fences that do not lose messages arriving during compaction;
- human-realtime token delivery with durable recovery, not row-per-token storage;
- connector event ingestion, deduplication, activity history, digests, suggested work streams, and suggested actions;
- regional authorization, residency, deletion, export, and migration;
- full agent loops that normally last 2–30 minutes, sometimes exceed two hours, and call Daytona-backed Terminal commands whose p95 is under a minute but whose tail can be 3–5 minutes or longer;
- the same durable loop abstraction for non-work-stream agents.

### Flow coverage map

The Supabase design must be tested against the following source-flow clusters. The identifiers refer to the source `flows.md` and are retained so a later PRD can build a mirrored acceptance suite.

| Product pressure | Source flow coverage | Supabase research focus |
| --- | --- | --- |
| Conversation order, substreams, context visibility, and provider arrays | S01–S10; B06–B10, B16–B19, B22–B23, B26–B28, B39, B44 | Work-stream sequence allocation, immutable parts, scope epochs, compaction lineage, SQL materialization |
| Sidebar, unread, mention, state, interest, and workspace collections | S02, S12, S20, S30; B01–B05, B21 | Same-transaction projections, sparse per-user rows, durable workspace event cursor |
| Connector activity, digests, suggestions, and privacy | S11, S21–S22; B11, B15, B29–B35 | Idempotent ingress receipts, raw-body registry, normalized events, authorization-aware opportunity state |
| Token streaming, reconnect, background clients, and presence | S03, S07–S09, S18, S28–S29; B23, B26, B38 | Bounded checkpoints, REST hints, offset reads, local animation, cursor handshake, connection lifecycle |
| Queueing, steering, safe interruption, tools, and long runs | S04–S06, S17, S31; B07, B17, B24, B44 | Admission RPCs, revision fences, idempotent effects, resumable full-loop driver, Daytona reconciliation |
| Regional placement, identity, authorization, deletion, and export | S13–S15, S19; B14, B20, B25, B32 | Regional projects, live membership checks, cross-project sign-in, storage cleanup |
| Schema/data migration, backfill, rebalancing, and rollback | S16, S23–S27; B12–B13, B35–B37, B40–B43 | Expand/backfill/contract, queue-driven campaigns, PITR limitations, cutover receipts |

## Recommended system topology

### Global control project and regional data shards

Supabase gives every project its own dedicated Postgres instance, and a project
is created in one primary region. Avalon should use a project as a coarse
residency/capacity shard, not per workspace or work stream. Launch uses one EU
and one Global/US product shard; a hot/full region may later add another project
behind the global directory. Each shard contains Database, Auth-session bridge,
Realtime, Queues, Cron, Storage, and vector indexes; Cloudflare provides compute.
See [Compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk)
and [Available regions](https://supabase.com/docs/guides/platform/regions).

All content and derived data for a workspace remain in its chosen regional shard:

- workspace and membership rows;
- work streams, conversation parts, substreams, and compactions;
- runs, steps, effects, queue and migration jobs;
- workspace/work-stream event logs and attention projections;
- connector payloads, activity, digests, suggestions, and embeddings;
- object-storage files and exports;
- audit records and deletion receipts.

This is a larger shared failure and contention domain than a fleet of independent Durable Objects. It trades object-level isolation for relational transactions, direct queries, simpler fan-out projections, and mature SQL operations. The design must compensate with indexes, short transactions, partitioning when measurements justify it, explicit tenant keys on every large table, and capacity alarms.

### Required global identity, shard directory, and routing control project

The global project owns account identity, invitation and billing/entitlement
facts that are global by product definition, `regional_shards`,
`workspace_routes`, and an idempotent `routing_commands` outbox with delivery
attempts and regional receipts. A route is opaque workspace/organization ID,
immutable selected region, current shard, lifecycle, and monotonic route epoch.
It must not contain work-stream titles/descriptions/messages, connector bodies,
sidebar interest state, embeddings, activity-derived counts, or other product
content.

In application-schema terms, the global project pairs managed `auth.users`
with private `global_accounts`, `organizations`, `organization_roles`,
`workspace_invitations`, and `billing_entitlements`, plus the shard directory
and routing tables. Global organization roles are account/billing authority,
not a shortcut around regional membership or RLS. Invitation, entitlement,
suspension, deletion, and move changes commit an identifier-only routing
command in the same global transaction; a shard-local gate and receipt must
converge before regional content admission changes.

Each product shard stores a `workspace_route_gate` and
`global_command_receipts`. A global transaction updates its canonical account/
invitation/billing/route fact and inserts a non-content control command. A
Cloudflare Workflow/Worker delivers it to the target shard's regionalized
Worker; one shard transaction verifies shard/epoch/hash, updates its local gate
or regional identity/invitation fact, and stores a receipt. Global acknowledgement
is a retryable copy of that receipt, never a distributed commit.

A workspace move linearizes at an immutable source-shard closure receipt. The
destination activates only from that cursor/hash; the global route changes
afterwards as a derived pointer. A crash may create temporary unavailability,
never two writable shards. This is the same authority principle as the
Cloudflare global D1 routing plane, implemented in Supabase tables and RPCs.

Supabase Auth is project-local: each project has its own Auth service and `auth` schema. The documentation does not provide a turnkey promise that a JWT issued by one Supabase project is accepted directly by another project's Data API. See [Auth architecture](https://supabase.com/docs/guides/auth/architecture) and [JWTs](https://supabase.com/docs/guides/auth/jwts). The safest Supabase-only design to prototype is:

1. the global Auth project acts as an OAuth 2.1/OIDC identity provider;
2. each regional product project registers that provider as a custom OIDC provider;
3. after global routing, the client obtains a regional Supabase session;
4. a regional identity map connects the provider subject to a stable `platform_user_id`;
5. regional `auth.uid()` is treated as a session principal, not the globally stable application identifier.

Supabase Auth can act as an OAuth/OIDC provider and supports custom OAuth providers, but the exact Supabase-to-Supabase composition, stable-subject mapping, logout propagation, refresh UX, and hosted-provider support must be proven in a spike and confirmed with Supabase. See [OAuth server](https://supabase.com/docs/guides/auth/oauth-server), [OAuth flows](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows), and [Custom OAuth providers](https://supabase.com/docs/guides/auth/custom-oauth-providers).

Do not assume a global access token can call a regional project's REST, Realtime, or Storage endpoints. Importing a shared signing key or building a token broker would enlarge the compromise blast radius across regions and should be rejected unless Supabase explicitly supports and security reviews it. A supported third-party Auth provider is another clean federation option, but it is no longer a Supabase-only identity stack.

### Cross-shard operations

The client resolves workspace region, shard, and route epoch before opening its
shard-local Supabase connection. Server requests use a shard-scoped credential.
Product transactions do not synchronously span databases. Global account
actions enqueue/retry regional commands by ID/hash; shard completion writes a
receipt that the global control plane later observes.

EU workspaces must never silently fail over to the Global/US product project. Availability degradation is preferable to violating a residency boundary.

## Postgres as the product authority

### Why relational authority fits Avalon

The workspace/work-stream hierarchy is a logical ownership model, not a reason to create physically separate databases. A single regional Postgres transaction can update a work stream and all of the workspace sidebar projections affected by that update. This eliminates delivery ambiguity between a `WorkstreamDO` and a `WorkspaceDO` while preserving the conceptual boundary in table keys and service APIs.

The database should use a private application schema such as `avalon_private` for canonical tables and functions. The exposed Data API schema should contain narrowly scoped views and RPC functions. Canonical writes from clients should be prohibited. Supabase recommends enabling RLS on exposed tables and separately managing table/function grants; RLS and grants solve different problems. See [Securing your API](https://supabase.com/docs/guides/api/securing-your-api), [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security), and [Secure data](https://supabase.com/docs/guides/database/secure-data).

### Transaction and serialization model

Use the default `READ COMMITTED` isolation level with explicit row locks for most domain commands:

1. validate the authenticated principal and live membership;
2. insert an idempotency receipt with a unique `(workspace_id, actor_id, operation_key)` or return its prior result;
3. lock the relevant `workstreams` row with `SELECT ... FOR UPDATE`;
4. validate expected revision, active run, compaction scope, and authorization epoch;
5. allocate a work-stream sequence and apply all canonical mutations;
6. update workspace-wide and per-user sidebar projections;
7. insert durable workspace/work-stream events;
8. enqueue follow-up work through `pgmq.send` where needed;
9. call `realtime.send` for private transactionally emitted hints where appropriate;
10. commit and return the durable sequence/revision.

The lock is held only for a short database transaction. It is never held while calling a model, uploading a file, invoking Daytona, waiting for a user, or broadcasting to an external endpoint. PostgreSQL row locks and isolation behavior are documented in [Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html), [Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html), and [`SELECT` locking clauses](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE).

`SERIALIZABLE` should be reserved for genuinely multi-row invariants that cannot be expressed with a known lock order, and the caller must retry SQLSTATE `40001`. Advisory locks are unnecessary when an entity row exists and introduce hash/collision/connection-lifetime hazards. `FOR UPDATE SKIP LOCKED` is appropriate for job claim/backfill workers, not for user commands whose order must be explicit.

Every critical multi-table mutation should be one database function/RPC or one trusted direct-database transaction. A sequence of independent PostgREST requests is not a transaction. Database functions are a good fit for data-intensive logic, but should be `SECURITY INVOKER` by default. Any `SECURITY DEFINER` function needs an empty or fixed `search_path`, explicit schema qualification, revoked default `PUBLIC` execute permission, and a narrow grant. See [Database functions](https://supabase.com/docs/guides/database/functions).

### Idempotency and effect receipts

Network and runtime retries are normal. Each externally submitted command needs a caller-generated idempotency key and a durable receipt containing its canonical result. Queue consumers need a second inbox receipt keyed by queue message or semantic job key. External side effects need an effect table with a unique key such as `(run_id, step_id, effect_kind, effect_key)` and explicit states `planned`, `started`, `succeeded`, `failed`, and `unknown`.

An external call cannot be atomic with Postgres. The safe sequence is to commit the planned effect, make an idempotent provider call with the effect key when the provider supports it, then commit the observed result. A crash after the provider accepted the request but before result commit yields `unknown`; a reconciler must query the provider before retrying. This is especially important for Daytona commands, connector writes, email/message sends, and billable model invocations.

### Authorization and RLS

The JWT identifies a session; the database decides whether that session currently has access. Workspace roles, work-stream visibility, connector scopes, content audiences, and authorization epochs belong in regional tables and are evaluated at the command boundary. Do not embed a potentially large workspace membership list in JWT claims and do not rely on `raw_user_meta_data`, which users can modify. Supabase also notes that JWT-backed authorization is not fresh until the token refreshes. See [RLS user metadata guidance](https://supabase.com/docs/guides/database/postgres/row-level-security) and [Sessions](https://supabase.com/docs/guides/auth/sessions).

Supabase documents a typical JWT lifetime of five minutes to one hour and a one-hour default. Session lifetime policies generally take effect only when a refresh occurs, and an already issued JWT remains valid until expiry unless the application performs a live session check. Strict revocation-sensitive operations therefore query live membership/session epoch in a database function. A removed member's existing Realtime channel also requires explicit eviction or short token/channel renewal; this must not be assumed to happen instantly.

RLS policy columns need indexes. Expensive membership predicates should be expressed so the planner can use stable lookups, and views exposed to clients must use `security_invoker = true` on PostgreSQL 15+ because ordinary views use the creator's permissions by default. See [Tables and views](https://supabase.com/docs/guides/database/tables).

Server-side secret or service-role credentials bypass RLS. They must never enter the desktop client, signed URLs, Broadcast payloads, queue bodies, logs, or connector records. Trusted code must still pass tenant identifiers explicitly and assert them in application functions because bypassing RLS also removes a safety net.

### Database limits and capacity implications

Supabase compute is dedicated per project and is not automatically resized. Published examples range from Micro at 1 GB RAM and roughly $10/month compute to Medium at 4 GB and roughly $60/month, before the rest of the plan and usage. Connection ceilings, baseline IOPS, and throughput depend on compute and disk configuration; the current values must be taken from the [Compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk) table during sizing. General-purpose disks start at 3,000 IOPS and 125 MB/s, but effective throughput can be compute-limited.

Paid disks autoscale by 50% after reaching 90%, subject to a limited number of modifications in a rolling 24-hour period. A project can become read-only around 95% if it cannot grow. Disk only grows, never shrinks. See [Database size and disk autoscaling](https://supabase.com/docs/guides/platform/database-size).

Data API statement timeouts default to short values: Supabase documents three seconds for `anon`, eight seconds for `authenticated`, and a two-minute global default for the `postgres` role, with up to 60 seconds configurable through the dashboard/client paths. Longer maintenance work must use an appropriate direct or pooled connection and function/role settings, not an interactive client request. See [Timeouts](https://supabase.com/docs/guides/database/postgres/timeouts).

Use direct connections for migrations and persistent database servers,
Supavisor session mode when session behavior is needed over IPv4, and Supavisor
transaction mode on port 6543 for any measured short-lived direct Worker/
serverless connection. Transaction pooling cannot safely support session state
or prepared-statement assumptions. See [Connecting to
Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres) and
[Connection management](https://supabase.com/docs/guides/database/connection-management).

The regional primary is shared by conversations, queues, semantic Realtime
database Broadcast, Auth metadata, connector ingestion, and vectors. Queue churn
and row-per-token writes would consume the same WAL, IOPS, and CPU as user
commands. Avalon should use 16 KiB mutable-tail chunks plus periodic delta
checkpoints, send token-coordinate hints through REST Broadcast, batch ingress,
prune transient data, and monitor this shared resource. Native table
partitioning is available, but should follow measured table/maintenance pain
rather than be added speculatively. See [Table
partitioning](https://supabase.com/docs/guides/database/partitions).

Read replicas are asynchronous, read-only, and may be stale. Supabase notes that Auth, Storage, and Realtime do not use the read-replica endpoint; writes always use the primary. Replicas can serve date-grouped historical conversation reads and analytics only when the caller tolerates lag. They cannot provide read-your-write sidebar or compaction correctness. See [Read replicas](https://supabase.com/docs/guides/platform/read-replicas) and [Read-replica prerequisites](https://supabase.com/docs/guides/platform/read-replicas/getting-started).

## Realtime

### Primitive selection

Supabase Realtime offers Broadcast, Presence, and Postgres Changes. Avalon should choose them by semantics rather than treating them as interchangeable.

| Primitive | Avalon use | Why / why not |
| --- | --- | --- |
| Private Broadcast from database | Workspace projection invalidations, durable-event hints, committed run/control hints | Supabase recommends Broadcast for scalability and security; database Broadcast can be emitted with the committing transaction |
| Private direct Broadcast | Body-free active-output coordinates, ephemeral typing/control acceleration | Low latency, but not durable; generated bodies require a proven revocable lease |
| Postgres Changes | Narrow internal/admin prototypes only | Every change is checked against each subscriber and ordered on a single thread; it scales poorly for high-fanout workspace feeds |
| Presence | Online/typing hints at human cadence | Ephemeral and reconciliation-prone; never authority for membership, seen state, run ownership, or billing |

Supabase explicitly recommends Broadcast over Postgres Changes for scalability and security. Its benchmarks explain that Postgres Changes authorizes each change for each subscriber and preserves ordering on a single thread, making the database/realtime path a bottleneck. See [Subscribing to database changes](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes) and [Realtime benchmarks](https://supabase.com/docs/guides/realtime/benchmarks).

### Durable state plus Broadcast hints

Every important change must have a durable, monotonically sequenced database representation. Recommended event tables include `workspace_events(workspace_id, workspace_seq, kind, subject_id, payload, authz_epoch, created_at)` and `workstream_events(workstream_id, workstream_seq, kind, payload, authz_epoch, created_at)`. Their sequences are allocated in the same transaction as the domain mutation and projection update.

The transaction can also call `realtime.send` to a private topic such as `workspace:<id>` or `workstream:<id>`. Supabase Realtime's architecture describes database Broadcast through `realtime.messages` and WAL, with the Realtime extension managing daily partitions and short retention. See [Realtime architecture](https://supabase.com/docs/guides/realtime/architecture) and [Broadcast](https://supabase.com/docs/guides/realtime/broadcast).

The Broadcast payload should be a small invalidation or event envelope with sequence, revision, kind, and IDs. A client that misses it queries durable events after its cursor or reloads an authoritative snapshot. Supabase Broadcast Replay is not the recovery log: database Broadcast replay is limited to private database broadcasts, a 72-hour minimum window, at most 25 messages per request, and timestamp-based replay. Those bounds are too small and imprecise for sidebar and conversation correctness.

### Snapshot/subscription handshake

The client must avoid the race between loading a snapshot and joining a channel. Use one of these proven patterns:

1. subscribe first, buffer envelopes, fetch snapshot plus durable cursor, apply buffered envelopes above that cursor, then continue live; or
2. invoke a server endpoint that establishes the subscription boundary and returns a snapshot cursor with a documented gap-free protocol.

Pattern 1 is implementable with the existing Realtime client and should be the default. Every envelope is deduplicated by sequence, and gaps trigger a durable catch-up query. Reconnect always starts from the last applied durable cursor, never from a Realtime timestamp alone.

### Connection and channel lifecycle

The Electron main process should own one regional Realtime WebSocket per signed-in regional session, then multiplex private channels on it. Join one `workspace:<id>` channel for the active workspace and a small number of `workstream:<id>` channels for open/foreground streams. Do not open one physical socket per work stream.

The paid Realtime limits page currently documents 100 channels per connection, with plan-specific concurrent-connection, message, join, payload, and Presence limits. Pro includes 500 concurrent connections by default, with configurable higher limits and higher-tier defaults; the exact account limit must be checked before launch. Broadcast payloads on paid plans are documented up to 3 MB, while Postgres Changes payloads are 1 MB. See [Realtime limits](https://supabase.com/docs/guides/realtime/limits).

Supabase clients send a heartbeat roughly every 25 seconds and reconnect with backoff. Backgrounded browser contexts can throttle timers and create silent disconnects. In Electron, connection ownership belongs in the main process rather than a throttled renderer. See [Realtime heartbeats](https://supabase.com/docs/guides/troubleshooting/realtime-heartbeat-messages) and [background disconnect guidance](https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794).

Realtime does not provide Durable Object-style WebSocket hibernation. An idle open socket remains a live concurrent connection and generates protocol/heartbeat egress. Avalon should not churn sockets every two or three minutes, but it should use a deliberate lifecycle:

- keep the active workspace connection while the user is interacting;
- leave foreground work-stream channels after a grace period;
- when the whole application is backgrounded and no active run/notification contract needs live delivery, close the socket and catch up from durable cursors on focus;
- when an active run is visible or completion notifications are promised, retain the workspace channel, batch frames, and close after terminal delivery;
- use platform push/OS notification mechanisms for long-background completion if added later, not an indefinitely idle application socket by default.

### Token streaming

Token delivery should split provisional experience from durable recovery. The
architecture review exposed a security constraint: Realtime authorizes a private
channel when it joins, so membership removal is not proven to reauthorize an
uncooperative already-joined subscriber immediately. The launch-safe path is:

- one stable attempt root owns ordered 16 KiB chunks; only the open tail mutates;
- the runner sends only new bytes and commits at most every 500 ms when observed,
  every second when unobserved, when the tail fills, or at a semantic boundary;
  a 250 ms tier is optional only after a regional load test;
- checkpoint revision, offset, frame range, provider cursor, and hash advance in
  the transaction that stores all represented bytes, with one RPC in flight;
- after commit, the trusted runner sends a body-free revision/offset/hash hint
  through the REST Broadcast API. Supabase documents that REST Broadcast goes
  directly through Realtime, while database Broadcast inserts into
  `realtime.messages` and is then read through WAL, so database Broadcast would
  add avoidable database work to every token checkpoint;
- clients call a live RLS-protected offset RPC and fetch only new bytes, so
  removal blocks new bodies and a continuous client never rereads the growing
  prefix;
- completion verifies ordered chunks, seals one immutable conversation part,
  updates work-stream/sidebar state, and emits one terminal event; and
- reconnect reads the active attempt/chunks or sealed part by revision and byte
  offset.

Transport cadence and visual cadence are deliberately independent. The desktop
receives a durable batch roughly twice per second, queues its delta locally, and
drains that queue with `requestAnimationFrame` at a product-selected 10, 20, or
30 visual frames per second. It paces by available tokens/characters and target
latency, not one model token per frame: at 100 tokens/second, a 500 ms batch is
about 50 tokens, so 10/20/30 fps display roughly 10/5/3–4 tokens per frame over
the next half second. This keeps motion continuous without multiplying database
or Realtime traffic. The renderer accelerates within a bounded lag budget when
a late batch arrives, pauses rather than inventing text when the queue empties,
and flushes or reconciles to the sealed final part on completion.

A later high-frequency body path may batch generated text at 50–75 ms and never
exceed 30 frames per second only if Avalon proves a server-rotatable stream
lease/key that blocks a removed already-joined client. An eviction hint or JWT
refresh is insufficient. Active checkpoints support client reconnect; absent a
verified provider-resumable cursor/event spool, an executor crash supersedes the
whole partial generation and starts a new attempt rather than splicing output.

This avoids both row-per-token churn and the quadratic-like copied/WAL payload
of repeatedly replacing one ever-growing text row. For 100 tokens/second and
10,000 tokens, generation lasts about 100 seconds. At the 500 ms default the
executor makes at most 200 nonempty checkpoint transactions—50 tokens each—
and, using four UTF-8 bytes/token for planning, stores about 40 KiB in roughly
three chunks. At 250 ms it would make about 400 checkpoints; at one second,
about 100. The stream protocol needs `(run_id, attempt_id, part_id, revision,
frame_seq, byte_offset)` so stale frames from an interrupted attempt cannot
overwrite the admitted successor.

Realtime billing counts a Broadcast once when sent and again for every receiving
client. The worked run therefore produces 200 sends and 400 billed messages
with one receiver. At 500 ms, `A` observed streams drive about `2A` checkpoint
transactions/second and `2A * (1 + average_receivers)` Realtime
messages/second. One thousand streams with one receiver imply about 2,000
checkpoint transactions and 4,000 Realtime messages/second, above the current
documented default 2,500 messages/second for Pro without Spend Cap/Team. This
requires a limit increase, lower cadence/fan-out, or more regional partitioning,
while DB/WAL/IO capacity remains a separate production-shaped load test.
Protocol frames also contribute to egress. Sending 30 network frames/second for
the 100-second run would create 3,000 sends and 6,000 billed messages with one
receiver—15 times the 2 Hz hint path—without improving durability. Local
10/20/30 fps animation should satisfy visual smoothness first. See
[Broadcast](https://supabase.com/docs/guides/realtime/broadcast), [Realtime
limits](https://supabase.com/docs/guides/realtime/limits), [Realtime message
usage](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages),
[peak connections](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-peak-connections),
[Realtime egress](https://supabase.com/docs/guides/troubleshooting/realtime-egress-faq),
and [compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk).

### Channel authorization and failure semantics

Private channel access is controlled through RLS policies on `realtime.messages`. Disable public access, use topic names that contain opaque tenant/work-stream identifiers, and have receive/send policies query indexed regional membership tables. See [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization).

The protocol's push acknowledgement is disabled by default; a failed send, oversized message, or RLS denial can otherwise appear successful to the publisher. Enable acknowledgement for server-side control messages where the client/library surface permits it, but still use the database event as authority. See [Realtime protocol](https://supabase.com/docs/guides/realtime/protocol).

Open questions requiring an integration test are:

- exactly when a membership removal evicts or reauthorizes an already joined private channel;
- how rapidly a refreshed regional JWT is applied with the Realtime `access_token` event;
- observable ordering between a committed domain row, its durable event, and database Broadcast under retries/reconnect;
- actual per-project join and Broadcast headroom with Avalon's RLS policy complexity;
- whether database Broadcast acknowledgements are exposed in the chosen server client.

Presence payloads are untrusted hints. Supabase Presence tracks join/leave reconciliation and is intended for relatively infrequent state changes, not high-frequency cursor/token updates. See [Presence](https://supabase.com/docs/guides/realtime/presence).

## Queues, Cron, and database webhooks

### Supabase Queues delivery model

Supabase Queues is the managed surface for the `pgmq` Postgres extension. Messages are stored in the regional database, read with a visibility timeout, and remain until explicitly deleted or archived. The quickstart describes a FIFO pull queue without priority, and distinguishes durable logged queues from unlogged queues that can lose data on a database crash. Avalon must use durable Basic queues for product work. See [Queues overview](https://supabase.com/docs/guides/queues), [Queues quickstart](https://supabase.com/docs/guides/queues/quickstart), [Queues API](https://supabase.com/docs/guides/queues/api), and [`pgmq` queues](https://supabase.com/docs/guides/queues/pgmq).

The phrase “exactly once within the visibility window” does not make end-to-end processing exactly once. A worker can commit a domain mutation and crash before deleting the message, so delivery is effectively at least once. Every consumer must claim work, create or find a unique semantic receipt, perform a short transaction, and delete/archive only after the authoritative result commits. Retrying the message must return that result rather than repeat the effect.

The visibility timeout must exceed the p99 duration of the bounded action plus a safety margin. A long action should renew visibility if the deployed `pgmq` version supports the required `set_vt` API, but Avalon must verify the exact extension version and signature in a branch before depending on it. Supabase's breaking-change history records a `pgmq` delay-semantics issue during a 1.4.4-to-1.5.1 upgrade, illustrating why extension behavior and version need a compatibility test. See the [Supabase breaking-change changelog](https://supabase.com/changelog?types=breaking-change).

Supabase does not currently document a managed continuously running queue consumer, a queue throughput SLA, automatic consumer scaling, or a first-class redrive policy/DLQ for this product surface. The application therefore needs:

- a `queue_failures` or dedicated dead-letter queue populated after an explicit `read_ct`/error policy;
- `last_error`, `next_attempt_at`, poison-message classification, and manual replay tooling;
- per-kind concurrency caps and workspace fairness;
- oldest-visible-age, retry-count, and dead-letter alarms;
- load tests that include the queue's WAL/IO impact on user-facing database transactions.

Queue tables are private by default and should remain server-only. Exposing `pgmq_public` functions to clients would require grants and RLS and provides no benefit to Avalon.

### Enqueue atomically with state

Because the queue is Postgres-native, a domain RPC can mutate state, insert events, and call `pgmq.send` in the same database transaction. This is a substantial advantage over an external queue: there is no committed state without its follow-up job and no job pointing at rolled-back state. Queue messages should still contain only identifiers, expected revisions, and job kinds; workers load canonical payloads after authorization/scope checks.

Suggested logical queues are:

- `agent_ready`: run IDs whose next bounded action is due;
- `connector_ingress`: durable raw-receipt IDs awaiting normalization;
- `derived_content`: compaction, embedding, digest, and suggestion jobs;
- `maintenance`: deletion, export, orphan cleanup, and migration chunks.

Use a small number of queues and partition/fairness fields in application tables rather than creating one queue per work stream, workspace, or run.

### Cron as a dispatcher wake-up

Supabase Cron is `pg_cron` with dashboard/API integration. Jobs can run SQL/functions or make HTTP calls. Supabase recommends no more than eight concurrent jobs and no job longer than ten minutes. Schedules range from every second to annual. See [Cron](https://supabase.com/docs/guides/cron).

Use one or a few regional Cron jobs to send an authenticated identifier-only wake
to the shard's Cloudflare Worker hostname, perhaps every second when latency
tests require it. A Cloudflare Cron Trigger may send the same opaque wake. Do
not create one cron job per run or work stream. The database is durable due-time
authority; a scheduler only wakes a bounded Worker dequeue. For EU, trigger code
never reads product content: it calls the Regional Services hostname, whose
fetch handler dequeues IDs and then loads bytes. Queue polling latency and
database load under idle/burst conditions must be measured—one-second schedule
is not a one-second processing SLA.

### Database webhooks are not the durable job bus

Database Webhooks create triggers that call `pg_net` asynchronously after row changes. They are useful for non-critical external invalidations and integrations because they do not block the committing transaction. They are not a replacement for an outbox or Supabase Queue: response history is short-lived, timeouts occur, and application-level redrive/deduplication is still required. See [Database Webhooks](https://supabase.com/docs/guides/database/webhooks) and [Webhook debugging](https://supabase.com/docs/guides/troubleshooting/webhook-debugging-guide-M8sk47).

For Avalon, a trigger or command function should enqueue a durable queue message in the same database transaction. A webhook may additionally notify an external system, whose endpoint must accept an idempotency key and reconcile from the regional database.

## Cloudflare Worker compute plane

Supabase Edge Functions are not selected. A shard-configured Cloudflare Worker
provides authenticated product APIs, connector ingress, queue dequeue, and one
bounded model/tool/compaction/embedding/suggestion/migration/reconciliation
action. It calls narrow database RPCs before and after external work rather than
assembling multi-table transactions in TypeScript. Secrets are shard-scoped in
Cloudflare and never enter Supabase queues, Workflow state, Realtime, or logs.

One Worker request may hold a provider stream while a Workflow step awaits it;
paid Workflow steps have unlimited wall time and bounded active CPU. That makes
a 100-second model stream viable while its Worker checkpoints Supabase every
500 ms. It does not make a Worker request durable authority or a full-loop retry
unit. Deployments, disconnects, CPU/subrequest limits, and ambiguous external
effects remain covered by Postgres receipts and Workflow retries/reconciliation.

Cloudflare service bindings are the normal internal API and execute bound
Workers on the same thread/server by default. For Global/US, an explicit
`placement.region`, `placement.host`, or `placement.hostname` hint on the fetch
handler places database-heavy execution near the Supabase backend. Smart
Placement affects fetch handlers, not RPC or named entrypoints. For EU, use the
regionalized HTTPS hostname rather than inferring locality from service binding
or Workflow placement. Regional Services applies to that hostname's HTTPS
processing but not to Workflow/Queue/Cron triggers or outgoing subrequests, so
the trigger and Workflow carry only opaque IDs and the regionalized Worker
loads all content. See [Worker placement](https://developers.cloudflare.com/workers/configuration/placement/),
[service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/),
and [Data Localization for Workers](https://developers.cloudflare.com/data-localization/how-to/workers/).

Avalon still uses Supabase Realtime for client fan-out and durable database
cursors for recovery. A direct Worker SSE response may optimize the initiating
client only behind the same authorization/attempt/lease contract; it is not the
multi-client authority. Long waits use Workflow sleep/event or provider
callbacks, not hot Worker polling or `waitUntil`.

## Full agent-loop orchestration

### Required semantics

A full loop begins when user input is admitted and ends only at a product terminal state such as completed, waiting for user, failed, interrupted, or cancelled. It includes multiple model turns, tool calls, safe interruption boundaries, retries, and waits. It is not equivalent to one model request or one “turn.” Typical loops last 2–30 minutes. Rare coding loops last more than two hours because they contain many model/tool iterations. Daytona-backed Terminal calls are usually seconds, p95 under a minute, can take 3–5 minutes in the tail, and may have a product cap as high as 15 minutes.

No single Worker request is the durable full loop. A normal model stream may
remain attached to one Workflow step/Worker request, but multiple model/tool/
Terminal/wait iterations span 2–30 minutes or 2+ hours. An open client stream
does not make execution durable.

### Supabase-authoritative run and effect schema

The product ledger is generic across work-stream and non-work-stream loops.
Suggested core records are:

- `agent_runs`: owner type/ID, current state, admitted input range, run/authorization/scope revisions, next action, wake time, budget, driver version, lease metadata, terminal result;
- `agent_steps`: monotonically numbered step attempts, kind, expected revisions, input/output content references, status, retry class, timing, provider identifiers;
- `run_events`: durable state-transition/audit stream;
- `tool_effects`: external side-effect intent, idempotency key, provider reference, outcome, reconciliation state;
- `run_waits`: user/provider/time wait conditions and wake state;
- `run_control`: latest queued/steering revision and requested interruption mode.

The Workflow/Worker driver operates against it as follows:

1. a transactional command admits or appends user input, advances the control revision, and enqueues `agent_ready`;
2. an idempotent dispatcher creates/attaches one Workflow by deterministic run
   ID;
3. one Workflow step calls the shard Worker, which begins exactly one action by
   RPC against expected revisions;
4. the Worker performs one model, ordinary tool, or provider-reconciliation
   action;
5. it commits the result through an RPC that checks attempt, run, authorization, scope, and control revisions;
6. the commit either seals output and enqueues the next step, waits, interrupts, or enters a terminal state;
7. Workflow sleep/event waits and bounded reconciliation steps resume from the
   ledger; unknown effects reconcile before retry.

This handles arbitrary elapsed loop time because Workflow owns orchestration
while no Worker request owns the full loop. Non-work-stream agents use the same
owner-neutral abstraction. Avalon still implements product state transitions,
revision fences, effect reconciliation, visibility, and recovery tests;
Workflow supplies durable step/wait/retry mechanics rather than replacing those
domain rules.

### Queued messages and steering

Both queue and steering actions commit a normal user message/part before returning success. They differ in the control revision:

- **Queue:** commit the message to the work-stream tail but do not invalidate the active attempt. The next admission boundary deterministically batches all eligible queued messages.
- **Steer:** commit the message and atomically increment `control_revision`, record `interrupt_requested_at`, and emit a run-control hint. The active attempt checks that revision before appending output, before and after each model/tool action, and before beginning any irreversible effect.

An active execution Worker may subscribe outbound to a private
`run-control:<run_id>` Realtime channel to reduce interrupt latency. The
committed database revision—not Broadcast delivery—is authority. If the frame is
lost, the next checkpoint/revision check stops stale work. A model/provider
request that cannot be cancelled may finish, but its output is discarded or
marked superseded. An irreversible effect already started is reconciled and
reported; steering cannot pretend it never occurred.

No two attempts may seal output for the same admitted range. Unique run/step keys and compare-and-set RPCs enforce the terminal winner.

### Daytona Terminal integration

Terminal continues to run on Daytona. The orchestration layer stores a durable
Terminal effect before contacting Daytona and uses an Avalon-generated
idempotency/command key where the Daytona API permits it. A short command may
complete in one Worker action. A longer command is an addressable asynchronous
effect:

1. start or attach to the Daytona command and persist its provider command/session reference;
2. return the step to `waiting_provider` and let Workflow wait/sleep;
3. wake through a callback if Daytona provides a reliable authenticated callback, otherwise enqueue a later reconciliation poll;
4. fetch bounded output checkpoints into Storage/database content references;
5. commit the terminal status once, or mark the effect `unknown` for operator/reconciler handling.

Never retry a command solely because a Worker request/Workflow step ended
ambiguously. Reconcile by provider reference first. Terminal output is subject
to the same work-stream authorization and regional content policy as
conversation output, even though Daytona is the execution provider.

### Chosen one-Workflow-per-full-loop driver

Cloudflare Workflows provides durable, individually retried steps and waiting/events whose waiting time does not consume CPU. Paid limits currently include long per-step wall duration, configurable per-step CPU up to five minutes, 1 MiB event/step-result limits, 1 GB persisted state per instance, high step-count limits, and account/workflow creation and running-instance limits. Exact values should be rechecked against [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/) and [Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) at implementation time. Workflow step/storage billing began in August 2026; see [Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/).

One Workflow per full loop fits Avalon's conceptual lifetime better than one Workflow per model turn. A safe coexistence contract is:

- Workflow input contains only `{region, owner_kind, owner_id, run_id}` and perhaps an opaque wake/event identifier;
- each Workflow step calls the selected shard's Cloudflare Worker fetch handler;
- that Worker loads prompts/tool data from regional Supabase, performs the
  bounded action, and transactionally commits the result;
- the response to Workflow contains only a small action enum, revision/cursor, next wait, and integrity hash;
- Supabase `agent_runs`, parts, effects, queues, and event logs remain the authority;
- user steering commits to Supabase first; a Workflow event only accelerates wake-up;
- workflow deletion or recreation does not delete or invent product state.

This avoids storing EU content, secrets, prompts, model output, connector bodies,
or Terminal output in Workflow state. Cloudflare's Regional Services docs do
not pin Workflow/Queue/Cron-triggered execution or outgoing subrequests. For EU,
the Workflow calls an EU regionalized HTTPS Worker and receives only opaque
status; the Worker loads content and checkpoints the EU shard. The complete
Workflow state/log and Worker/provider path requires contractual confirmation.
If unavailable, affected compute features fail closed rather than reverting to
a Supabase-native driver.

Database revision fences, effect receipts, idempotent commands, and durable
events remain mandatory. A Workflow retries code; it cannot make an external
side effect atomic or replace Supabase product authority. One direct Worker
request or a client WebSocket as the full loop is rejected.

## Conversation, substream, and compaction mapping

### Ordered parts

The Supabase implementation should preserve the source PRD's provider-neutral append model rather than collapse conversations into a mutable JSON message array. A `workstreams` row owns `next_seq`, active run/control revisions, lifecycle state, latest activity, and summary pointers. `substreams` identify logical context lanes. Immutable `conversation_parts` use one work-stream-wide `seq` and typed content references. Mutable `active_chunks` exist only while a model step is streaming and are sealed into immutable parts at completion.

The important relational constraints are:

- unique `(workstream_id, seq)` for canonical order;
- unique provider/idempotency keys for external/user submissions;
- every part has a `substream_id`, author/agent identity, part type, content/audience metadata, and authorization/scope epochs;
- a sealed part is immutable; edits create a replacement/revision relation rather than rewriting history invisibly;
- large bodies live in Storage through an authoritative `content_refs` row, while small text may remain inline;
- materializing an LLM request is a deterministic query/function over visible parts, compaction summaries, and the chosen substream lineage.

Postgres supplies the global order cheaply. A row lock on `workstreams` allocates the next sequence, avoiding a process-local mutex and allowing all writers—users, agents, connectors, and migrations—to use the same invariant.

### How substreams should be used

Substreams are semantic context boundaries inside one work stream. They are appropriate for:

- the main human/agent conversation;
- a bounded agent investigation whose output should be summarized or promoted into the main lane;
- a focused document/task lane that inherits an explicitly frozen or live parent context according to policy;
- parallel agent work whose local tool chatter should not pollute every future model request.

They should not be used as:

- a storage shard, pagination device, or workaround for database size;
- one substream per model turn, tool call, user, UI tab, or WebSocket;
- an authorization boundary by themselves;
- a hidden branch with ambiguous ordering or implicit context inheritance;
- a replacement for a separate work stream when the activity needs its own title, lifecycle, sidebar identity, participants, completion state, or retention policy.

Keep one work-stream-wide sequence even when content is authored in different substreams. Each substream declares a supported kind and inheritance mode, its parent, base/fork sequence where relevant, scope revision, and lifecycle. Enforce the source depth limit in the command RPC. The context materializer follows explicit lineage and promotion records; it never loads “all parts that happen to share a work stream.”

RLS must validate part access against the work stream and any audience restriction. A substream identifier alone must not grant access. A promoted summary records its source substream, source sequence range, source scope/authz revisions, compactor model/version, and content hash.

### Compaction

Compaction is a derived-data job, not a rewrite of live history. The command transaction captures an immutable fence containing:

- work stream and substream;
- inclusive source sequence range ending only after a complete turn;
- source content hashes;
- authorization and context-scope revisions;
- compaction format/model version;
- a unique compaction key.

Messages arriving while the compactor runs receive higher work-stream sequences
and remain in the tail. They are never included merely because it observed them
later. The Cloudflare Worker reads exactly the fenced range, calls the model in
a bounded action, and commits only if fence/scope/authz/lineage remain valid.
The materializer uses the sealed summary plus parts above the fence.

If permissions or source revisions changed, the result is rejected and a new job is created. If the same job retries, the unique compaction key returns the already committed summary. Old source parts remain available according to retention/audit policy; compaction alone is not deletion. A message sent during compaction is thus ordinary append traffic, with no special wait and no loss race.

## Workspace/sidebar projections, unread, and mentions

### Common and sparse user-specific state

Unlike the Durable Object topology, Supabase does not need a work-stream process to deliver a sidebar update to a workspace process. The work-stream command RPC updates all affected relational projections in its own transaction.

Recommended common projection columns include:

- work-stream ID, workspace ID, title, short description;
- lifecycle state (`active`, `waiting`, `error`, `completed`, and any product-approved variants);
- last activity timestamp and latest work-stream sequence;
- active run/agent summary and needs-input flag;
- completion/error timestamps and date-bucket inputs;
- suggested-work provenance/state if the row represents a suggestion;
- common projection revision.

Recommended sparse user projection columns include:

- user ID and work-stream ID;
- seen sequence or attention ordinal;
- latest unread/mention ordinal and derived booleans/counts;
- `mentioned_at`, `needs_your_input`, pin/dismiss/mute state;
- last-opened/last-interest timestamp and user projection revision.

Do not eagerly write one row per `(workspace member, work stream)` for every activity. A common row covers everyone. Create a per-user row only when a user opens, is mentioned/assigned, pins/mutes/dismisses, needs input, or otherwise differs from the default. Unread can be computed from the user's waterline and a compact `workstream_attention`/ordinal table; large exact counts may be cached after a threshold.

Mention parsing happens in the authoritative message-append RPC or a transactionally invoked parser function against canonical identity references, not display-name text alone. The same transaction appends the message, increments relevant attention ordinals, upserts mentioned-user projections, updates common state, appends workspace events, and broadcasts an invalidation.

### Collections and the main screen

The regional database can answer All Work Streams, In Progress, Completed, Error, date groups, You Are Mentioned, Unread, Needs Your Input, Pinned, and “of interest” with indexed relational queries. “Of interest” should be a documented union of sparse signals, not an opaque materialization: pin, mention, unread, assignment/input need, open/recent activity, and accepted suggestion.

The initial workspace snapshot RPC returns common rows, the current user's sparse overlays, collection counts, and a durable workspace event cursor. Subsequent Broadcast envelopes identify changed work streams/collections, and the client patches from the durable event API. Derived count tables are acceptable at scale, but each update must occur in the same transaction as the originating projection so the UI cannot observe a permanently split state.

Marking seen is a monotonic RPC (`GREATEST(existing_seen, requested_seen)`) bounded by the highest visible sequence/attention ordinal. It cannot mark unauthorized or future content seen. Presence, open sockets, and render acknowledgements are not a seen write.

### High-fanout caution

A mention of many users or a workspace-wide attention event can still create many sparse rows in one transaction. Put a product limit on explicit mentions, use an audience/attention event plus lazy per-user evaluation for genuinely workspace-wide events, and measure lock/WAL cost. Realtime Broadcast fan-out is also billed per receiver, so workspace-wide “reload everything” messages should be small and uncommon.

## Connector ingress, activity, digests, and suggestions

### Ingress state machine

Connector endpoints should be short, idempotent Cloudflare Worker fetch handlers
configured for the target shard that:

1. validate provider signature, timestamp, and replay window before parsing untrusted content;
2. resolve the regional workspace/connector route without copying content into the global plane;
3. write an `ingress_receipts` row with provider event ID, tenant/connector ID, received timestamp, body hash, schema version, and lifecycle;
4. store a large raw body in the workspace's private regional Storage bucket through a pending/finalized content reference, or store a bounded encrypted body in Postgres;
5. atomically enqueue the receipt ID to `connector_ingress` and return the provider-required acknowledgement.

The unique key should combine connector installation and provider event ID; when a provider does not supply a stable ID, use a documented semantic hash/window. A replay returns the original receipt status. Signature failures and oversized payloads produce audited rejects without creating normalization work.

### Normalization and activity storage

A bounded worker turns each receipt into normalized records such as:

- `connector_resources`: external resource identity, provider version/etag, authorization scope and tombstone state;
- `activity_events`: immutable actor/action/object/timestamp facts, source receipt, audience, normalized payload, content reference;
- `activity_links`: relations to workspaces, work streams, users, resources, and predecessor events;
- `activity_cursor_state`: connector backfill/webhook cursors and reconciliation watermarks;
- `normalization_attempts`: parser version, error class, retry/dead-letter state.

The raw receipt is evidence and replay input; the normalized activity event is the product-facing fact. Neither a vector index nor Realtime message is the activity authority. Updates and deletes from a provider become new version/tombstone events, preserving lineage. Connector authorization scope is captured at ingestion and rechecked at read/derivation time because membership and provider access can change.

### Digests

Digest eligibility is stored as durable due-state in Postgres, grouped by workspace/user/timezone and a source activity watermark. A regional Cron dispatcher enqueues due digest jobs. A worker freezes an eligible activity range and authorization epoch, materializes permitted context, invokes the model, and commits a versioned digest artifact plus source links. Delivery, if any, is a separate idempotent effect.

Late connector events do not rewrite a delivered digest silently. They enter the next digest or produce an explicitly revised digest. A failed model/delivery attempt retains the source watermark and can retry safely.

### Suggested work streams and suggested actions

Opportunity detection consumes normalized activity through queued, versioned workers. Store suggestions in regional Postgres, with at least:

- suggestion ID, workspace, target user/audience, kind, title/summary;
- source activity IDs/watermark and detector/model/prompt versions;
- deduplication/semantic key, score, explanation references;
- authorization/scope epoch and expiration;
- lifecycle (`proposed`, `shown`, `accepted`, `dismissed`, `expired`, `invalidated`);
- accepted work-stream/action IDs and idempotency receipt.

Suggested work streams are not actual work streams until acceptance. Acceptance is one RPC that revalidates permissions/source availability, inserts the real work stream and initial parts, updates sidebar projections, records the acceptance, and emits durable/Broadcast events. Suggested actions remain proposals until the user approves or an explicit policy allows execution; their effect receipts use the same generic agent/tool machinery.

Dismissal and feedback are durable user-specific state. A deleted/inaccessible source invalidates the suggestion and removes it from interest collections. Embeddings may help retrieve/collapse candidates, but cannot decide authorization or be the only provenance.

### Ingestion failure and load isolation

Bursty connectors can contend with conversation traffic because queues and normalized tables share the regional database. Controls should include per-installation rate limits, bounded normalization batches, separate queue concurrency, payload size caps, poison-message DLQ, partitioning/retention for very large immutable activity tables, and priority for interactive commands at the dispatcher. The absence of a published Supabase Queues throughput SLA is a capacity-spike item, not a reason to assume unlimited ingest.

## Storage and large content

Supabase Storage keeps object metadata in Postgres while object bytes live in object storage. Supabase warns that the `storage` schema should be treated as read-only and that deleting metadata directly does not necessarily delete the underlying object; object operations should use the Storage API. See [Storage](https://supabase.com/docs/guides/storage), [Storage schema design](https://supabase.com/docs/guides/storage/schema/design), and [Storage access control](https://supabase.com/docs/guides/storage/security/access-control).

Use private regional buckets for:

- connector raw payloads;
- attachments and large conversation/tool parts;
- Daytona logs/artifacts too large for inline storage;
- import/export chunks;
- optionally large immutable compaction source/result artifacts.

The canonical application record is `content_refs`, not `storage.objects`. It should include workspace/region, bucket/path, lifecycle (`pending`, `ready`, `deleting`, `deleted`, `orphaned`), content hash, byte size, media type, encryption/audience metadata, source kind/ID/revision, uploader principal/effect, and timestamps. Domain rows point to a ready content reference.

Storage upload and domain commit are not one transaction. Use a state machine:

1. allocate a deterministic path and pending `content_refs` row in Postgres;
2. upload bytes and verify expected hash/size;
3. finalize ready plus the domain reference in a transaction;
4. garbage-collect expired pending objects and dangling objects by comparing both systems.

Alternatively, upload to a deterministic content-addressed path first and then finalize a database receipt, with orphan collection. Never make the object visible to readers until the database reference is ready.

Storage RLS applies to client/session operations. Server S3 credentials and service keys bypass RLS, so server code must enforce tenant/path constraints itself. Objects uploaded with a service key can have no owner, and Storage ownership is not an authorization mechanism. See [S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication) and [Object ownership](https://supabase.com/docs/guides/storage/security/ownership).

Use TUS resumable upload for large desktop uploads and S3 multipart for server ingestion. Paid projects document configurable file limits up to 500 GB. Product limits should be far lower and explicit. See [File limits](https://supabase.com/docs/guides/storage/uploads/file-limits) and [S3 uploads](https://supabase.com/docs/guides/storage/uploads/s3-uploads).

Supabase's S3 compatibility does not include object versioning, and deletes are permanent at the object layer. Database backups do not back up Storage bytes. Avalon therefore needs an independent retention/backup/export policy for raw connector evidence and customer files, plus deletion verification. See [S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility) and [Database backups](https://supabase.com/docs/guides/platform/backups).

Signed URLs are short-lived transport capabilities created only after a live regional authorization check. Do not persist them in parts, Broadcasts, logs, or suggestions.

## Full-text, semantic, and vector search

### Postgres full-text search

Use generated `tsvector` columns and GIN indexes for exact/token-aware search over titles, descriptions, permitted message text, actor/resource names, error codes, and normalized activity. PostgreSQL/Supabase supports `websearch_to_tsquery` for user-friendly queries. See [Full-text search](https://supabase.com/docs/guides/database/full-text-search).

The search RPC always starts from an authorized workspace/work-stream/content set and joins search vectors to it. A rank or snippet is derived only after current authorization, audience, deletion, and scope filters.

### pgvector

For the launch architecture, use `pgvector` in each regional database for embeddings of eligible work-stream summaries, activity, digests, and suggestion sources. HNSW is Supabase's recommended general index because it offers a better speed/recall tradeoff and can be created before the table has data; IVFFlat can be useful for specific build/memory profiles but requires tuning and sufficient data. See [Vector columns](https://supabase.com/docs/guides/ai/vector-columns) and [Vector indexes](https://supabase.com/docs/guides/ai/vector-indexes).

`vector` indexes support up to 2,000 dimensions, `halfvec` up to 4,000, with
larger bit vectors under current pgvector limits. Choose the embedding model/
dimension before indexing and store model/version/hash/source/authz epochs beside
each embedding. An async queue regenerates embeddings when content/model changes.
Supabase's [automatic embeddings](https://supabase.com/docs/guides/ai/automatic-embeddings)
example validates the trigger/Queue/Cron pattern; Avalon substitutes its
Cloudflare execution Worker for the example's Edge consumer.

Hybrid search can combine GIN full-text and HNSW semantic results with reciprocal-rank fusion. See [Hybrid search](https://supabase.com/docs/guides/ai/hybrid-search). Vectors remain a rebuildable derived index, never canonical content, provenance, or access control. Candidate retrieval must be constrained by authorized regional rows; filtering after returning unauthorized vectors to application code is unacceptable.

### Vector Buckets

Supabase Vector Buckets are public alpha as of the research date. They target large/cold vector collections stored on S3 and document project/bucket/index and dimension limits, but current public pages disagree on some batch-size guidance, and the examples emphasize service-key access. See the [Vector Buckets public-alpha changelog](https://supabase.com/changelog/40815-public-alpha-manage-vector-buckets-from-the-dashboard), [Vector Bucket limits](https://supabase.com/docs/guides/storage/vector/limits), and [Vector Buckets feature comparison](https://supabase.com/features/vector-buckets).

They are not recommended for Avalon's launch-critical search because:

- alpha APIs/limits can change;
- transactional lifecycle with source rows is weaker than pgvector in the same database;
- tenant RLS, deletion, backup, region, and private-channel integration need more proof;
- work-stream/activity queries require relational authorization joins and low-latency updates.

A later version may use Vector Buckets for a large cold, rebuildable candidate index with Postgres retaining authoritative metadata and access checks. It must never become a cross-region global vector index.

## Secrets and provider credentials

Supabase Vault stores encrypted database secrets and exposes a decrypted view to authorized database code. Encryption uses a per-project key managed outside the database; backups retain encrypted values, while manual cross-project migration requires key-aware handling. Use Vault for database-side `pg_net`/Cron credentials and narrowly scoped secrets a database function truly needs. See [Vault](https://supabase.com/docs/guides/database/vault).

Use Cloudflare Worker secrets for model-provider, connector, Daytona, and
shard-runner credentials needed at runtime. Scope them by product shard and
connector installation where practical. Never include a secret in a queue body,
Workflow input/result, event payload, Realtime frame, part metadata, or log. Do
not use Vault as a general application field-encryption/KMS system without a
separate threat-model decision.

Supabase deprecated legacy access to `app.settings.jwt_secret`; new work should use signing-key/JWKS APIs for Auth and Vault for database secrets. Extension versions are also increasingly platform-controlled rather than application-pinned, so upgrade testing must focus on observed behavior. See the [breaking-change changelog](https://supabase.com/changelog?types=breaking-change).

## Residency, privacy, and enterprise controls

A Supabase project has one primary region, and EU locations are available. That
is necessary but not sufficient evidence for Avalon's complete EEA/EU contract.
Realtime is globally distributed; Cloudflare Worker code/secrets are globally
deployed; Regional Services covers eligible HTTPS handling but not Workflow/
Queue/Cron triggers or outgoing subrequests. Logs, support access, backups,
subprocessors, Auth email delivery, Workflow state, and global route metadata
have separate paths. See [Available regions](https://supabase.com/docs/guides/platform/regions),
[Realtime architecture](https://supabase.com/docs/guides/realtime/architecture),
and [Cloudflare Data Localization for Workers](https://developers.cloudflare.com/data-localization/how-to/workers/).

For an EU workspace:

- create Database, Storage, Queues, Cron, Auth bridge, and pgvector in the
  contracted EU shard;
- do not create a read replica outside the allowed boundary;
- route every content-bearing action through an EU Regional Services Worker
  HTTPS hostname; use only opaque Workflow/trigger payloads;
- keep connector raw bodies, Realtime topics, embeddings, logs exported by Avalon, and backups within the approved path;
- send only globally required identity/billing/invitation facts and opaque
  shard/route/control metadata to the global database;
- do not enable agent/derived compute until Workflow state/logs and the
  Regional Services Worker/provider path are approved; there is no Edge fallback;
- include deletion/export/support procedures and every relevant subprocessor in the data map.

The current [Supabase DPA](https://supabase.com/downloads/docs/Supabase%2BDPA%2B260601.pdf)
and executed Cloudflare terms are contractual sources, not this research.
Legal/security must obtain written answers for Supabase Realtime, logs, backups/
PITR, Auth, support, AI/vector services plus Cloudflare Workflow/Worker state,
logs, triggers, Regional Services, and subrequests. A project/hostname selector
alone must not be represented as GDPR or residency compliance.

## Schema deployment, fleet migration, and backfill

### Schema migrations

Supabase CLI migration files should be the only production schema source. Apply them through CI with one coordinated pusher per regional environment; avoid dashboard drift. Supabase recommends migration files and `supabase db push`, and documents lock-timeout considerations for production changes. See [Database migrations](https://supabase.com/docs/guides/deployment/database-migrations).

The database topology removes the need to wake and migrate millions of per-work-stream or per-workspace Durable Objects. An additive column/table is one regional schema operation whose rows become visible under the new schema. This simplifies fleet coordination but increases blast radius: a blocking DDL operation can affect every tenant in that regional project.

Use expand/backfill/contract:

1. add compatible nullable columns/tables/functions and indexes, using non-blocking/concurrent forms where supported;
2. deploy readers/writers that tolerate both old and new representations, with explicit dual-write or change-capture logic if required;
3. start a durable migration campaign that partitions work by stable primary-key ranges;
4. claim small chunks with `FOR UPDATE SKIP LOCKED`, transform idempotently, and record counts/hashes/errors;
5. validate old/new invariants and observe a soak period;
6. switch reads and stop old writes;
7. remove old schema only in a later release.

Never hold a transaction while transforming an entire workspace fleet. Keep DDL/DML timeouts deliberate, monitor locks and replica/WAL impact, and throttle migration concurrency below interactive workloads.

### Data migration campaign control plane

Sophisticated transforms still require an application migration control plane, but it is relational rather than one control object per entity. Recommended private tables are:

- `migration_campaigns`: kind/version/region, lifecycle, rollout bounds, code version, pause/cancel state, totals, invariants;
- `migration_jobs`: campaign, tenant/entity/range, expected source revision, lease, attempts, next wake, state, result counts/hashes, error;
- `migration_receipts`: unique semantic target and committed version/result;
- `migration_exceptions`: quarantined row/entity plus remediation audit.

A regional Queue/Cron wake invokes a bounded Cloudflare Worker/Workflow job.
Operators can pause claims, cap concurrency, isolate poison records, replay safe
failures, and compare totals. External content uses the same pending/finalized
Storage references and orphan reconciliation.

For a move from another database, export immutable, hashed chunks to the destination region's Storage staging bucket; load to staging tables; compare counts/hashes; and backfill live tables with idempotent receipts. Cutover uses a documented write hold/outbox and one atomic source-database authority-gate closure as the linearization point. Destination activation and the global route are verified, retryable copies of that immutable closure receipt; a crash between them may reduce availability but cannot create two writers. At no time should two systems independently accept canonical writes for the same workspace.

### Branching

Supabase branches are separate instances with their own credentials and product services. Preview branches are data-less by default and should be seeded with synthetic fixtures covering high-fanout sidebar state, compaction/steering races, long runs, and migration exceptions—not production customer content. See [Branching](https://supabase.com/docs/guides/deployment/branching) and [branching through the dashboard](https://supabase.com/docs/guides/deployment/branching/dashboard).

Deploy in an explicit dependency order: global/shard projects and extensions,
schema migrations, route/gate/seed compatibility, Cloudflare Worker/Workflow
code and shard-scoped secrets, Regional Services/placement, then traffic. CI
tests final state against migration/config source rather than dashboard history.

### Extension compatibility

Supabase projects expose extensions including `pgmq`, `pg_cron`, `pg_net`, `vector`, `pg_stat_statements`, and others, but the platform controls supported versions/upgrades. See [Postgres extensions](https://supabase.com/docs/guides/database/extensions). Each production migration should record and test required extension behaviors rather than assume an exact version can remain pinned indefinitely.

## Backup, restore, deletion, and export

Paid Supabase plans include daily logical/physical backup retention depending on plan; the current documentation lists seven days for Pro, 14 for Team, and 30 for Enterprise. PITR is an add-on that requires at least Small compute. Restores take the database offline, apply to the project/database rather than one tenant/table, and do not cover Storage objects. See [Database backups](https://supabase.com/docs/guides/platform/backups).

PITR is disaster recovery, not a schema-migration rollback and not a substitute for application undo. Restoring a regional database can resurrect run state whose external model, connector, or Terminal-provider effects already happened. After restore, all nonterminal effects and queue jobs must reconcile by idempotency/provider reference before resuming.

Project cloning copies database contents in the same region but leaves several services/settings—including Storage objects and some Auth, Realtime, function, extension, and replica configuration—to be recreated. See [Clone a project](https://supabase.com/docs/guides/platform/clone-project). A disaster-recovery exercise must therefore cover the whole regional product stack, not only SQL.

### Export

A workspace export is an asynchronous regional job with a frozen export fence and manifest. It reads authorized canonical rows and Storage objects, writes hashed chunks to a private export path, produces a manifest of parts/substreams/activity/suggestions/audit/content references, and exposes a short-lived signed download after a live permission check. The manifest records omissions and source revisions. Large exports resume by chunk receipt and expire/delete on schedule.

### Deletion

Deletion is a state machine rather than one SQL cascade:

1. mark the workspace deleting and increment authorization/routing epochs;
2. prevent new user, connector, agent, queue, and Workflow admission;
3. revoke/close regional channels and connector credentials;
4. tombstone/cancel runs, jobs, suggestions, and queued work;
5. delete canonical relational rows in bounded, receipt-tracked chunks according to retention/legal holds;
6. delete Storage objects through the Storage API and verify absence;
7. delete/rebuild derived full-text/vector data and exported artifacts;
8. write a minimal non-content deletion receipt and acknowledge the global plane.

Database row deletion does not prove object deletion, and backup expiry has its own contractual retention. The deletion SLO and legal-hold behavior must distinguish active data, Storage, diagnostics/log drains, and disaster-recovery copies.

## Observability and audit

Supabase Logs Explorer provides logs across Database, Auth, Storage, Realtime, and Edge products; Supabase moved its default log infrastructure to ClickHouse in June 2026. Log retention depends on plan. A beta Prometheus-compatible Metrics API exposes roughly 200 Postgres metrics. See [Logs](https://supabase.com/docs/guides/telemetry/logs) and [Metrics](https://supabase.com/docs/guides/telemetry/metrics).

Log Drains can send logs to supported external destinations. Current billing lists $60/month per drain plus event/egress usage, outside Spend Cap; batch behavior and destination support should be verified on the selected plan. See [Log Drain usage](https://supabase.com/docs/guides/platform/manage-your-usage/log-drains) and [Log Drains](https://supabase.com/features/log-drains).

Logs are diagnostic, not product authority. Store the following durable product evidence in regional Postgres:

- command/idempotency receipts and authorization decision version;
- run/step/control transitions and effect reconciliation;
- connector receipt/normalization/dead-letter state;
- compaction source fence/result lineage;
- suggestion provenance/decision;
- migration campaign/job receipts;
- deletion/export manifests.

Never send full prompts, message bodies, tokens, connector bodies, Storage signed URLs, or secrets to routine logs. Use opaque IDs, counts, hashes, durations, status/error classes, and sampled redacted diagnostics.

Alert at minimum on database CPU/memory/IOPS/disk/WAL, connection/pool
saturation, long locks/statements, active-output checkpoint transactions/second,
bytes and WAL bytes/checkpoint, chunk updates/inserts, TOAST/vacuum pressure,
incremental RLS-read latency, Realtime hint sends/receivers/messages per second,
client animation backlog/lag, queue oldest age/read count/DLQ, Cron failure,
Worker/Workflow failure/rate, Realtime join/RLS/disconnect/sequence gaps, run
stuck/lease churn, unknown effects, compaction invalidation rate, ingress lag,
Storage orphan backlog, migration mismatch, and deletion/export SLO.
`pg_stat_statements` is enabled in Supabase projects and tracks recent query
statistics; use it with database inspection tools. See [Database
inspection](https://supabase.com/docs/guides/database/inspect) and [Query
optimization](https://supabase.com/docs/guides/database/query-optimization).

## Cost model

Supabase's base cost includes always-on dedicated compute for every project;
the global database, Global/US/EU shards, staging, and persistent branches each
create a floor. Usage then includes database disk/IO, egress, MAU, Storage,
Realtime messages/connections, replicas, PITR, and observability add-ons.
Cloudflare adds Worker request/CPU and Workflow step/state usage. Current public
prices must be verified on both contracted plans. See [Billing on
Supabase](https://supabase.com/docs/guides/platform/billing-on-supabase),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
and [Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/).

Spend Cap covers a subset of usage products but not fixed compute, read replicas, PITR, Log Drains, or some disk/IO charges. See [Cost control](https://supabase.com/docs/guides/platform/cost-control).

Avalon's important cost multipliers are:

- each regional/staging project and compute tier;
- token checkpoint transactions, mutable-tail bytes, WAL/TOAST/vacuum, and
  primary-database IOPS;
- Realtime transport rate times receivers; local 10/20/30 fps animation does
  not multiply this usage;
- idle/background peak WebSocket connections and protocol egress;
- cross-service/cross-region egress—data moving Supabase to a Worker and then to
  a user/provider must be measured by path;
- raw connector/Terminal artifact retention;
- embedding rows/index memory and re-embedding campaigns;
- high-frequency Worker polling/Workflow steps;
- read replicas, PITR, and log drains.

Supabase documents egress across Data API, Storage, Realtime, Auth, direct
database/Supavisor, and other product paths. Worker-to-Supabase/provider traffic
must be included in the path model. See [Supabase egress](https://supabase.com/docs/guides/troubleshooting/all-about-supabase-egress-a_Sg_e).

Cost controls that align with correctness are: checkpoint only delta bytes into
16 KiB mutable-tail chunks at a 500 ms observed default, send body-free REST
hints rather than token rows or database Broadcasts, animate received batches
locally at 10/20/30 fps, cap any future revocable body-frame network path at 30
fps, subscribe only to active topics, close truly idle background sockets and
catch up by cursor, store large immutable bodies in Storage, batch connector
normalization/embedding, use due-state instead of hot polling, prune transient
event/control rows after durable retention, and size one regional database from
measured interactive/ingest load.

## Verified limit ledger and plan caveats

These are design inputs, not contractual guarantees. Recheck the linked page and account configuration before implementation and capacity review.

| Primitive | Current documented constraint relevant to Avalon | Design consequence |
| --- | --- | --- |
| Cloudflare Worker, paid | 5 m active CPU/request (30 s default), 128 MB, 10,000 default subrequests, HTTP wall time unlimited while caller remains connected | Configure conservative CPU/subrequest budgets; one action only, never the full loop |
| Realtime channels | 100 channels per connection | Multiplex one regional socket and join active workspace/work-stream topics only |
| Realtime Broadcast payload, paid | 3 MB | Frames/envelopes remain small; content loaded from database/Storage |
| Realtime replay | private database Broadcast only, 72 h minimum, 25 messages/request | Durable event tables/cursors are mandatory |
| Realtime base Pro concurrency | 500 connections before overage/default adjustment | Model active/background Electron connections and request limit increases |
| Cron | schedules down to one second; recommended ≤8 concurrent jobs and ≤10 m each | A few dispatchers, not one job per work stream/run |
| Storage upload, paid | configurable to 500 GB | Product-specific lower caps; resumable/multipart and quota checks |
| pgvector index dimensions | `vector` 2,000; `halfvec` 4,000 | Select model/dimension and migration path before index creation |
| Vector Buckets | public alpha; 10 buckets/project, 10 indexes/bucket, up to 4,096 dimensions | Not launch-critical authority/search path |
| Data API timeouts | common role defaults measured in seconds; dashboard/client max 60 s | Long maintenance/backfills use workers/direct pool, not client RPC |
| Database backups | Pro/Team/Enterprise daily retention 7/14/30 days; Storage excluded | Separate Storage backup/deletion and whole-project restore plan |
| Read replicas | Pro+, Small+, PostgreSQL 15+, async/read-only; Auth/Storage/Realtime remain primary | Historical/analytics reads only; no correctness/offload assumption for realtime |

Supabase account limits can be raised or differ by plan. A benchmark page is not an SLA. The following remain explicitly unverified at the public-documentation level and require load testing or vendor confirmation:

- hosted Queue throughput, delivery latency, autoscaling, retention maximum, and availability SLA;
- exact `pgmq` version and `set_vt` availability during upgrades;
- private Realtime authorization re-evaluation for an already joined channel;
- Supabase-to-Supabase OIDC federation behavior and regional logout/revocation propagation;
- full EU handling for Supabase Realtime/Auth/backups/support plus Cloudflare
  Workflow state/logs, Regional Services Worker execution, and subrequests;
- Vector Bucket RLS, backup, deletion, residency, and production stability;
- effective connection/IO/Realtime limits after the selected compute and enterprise contract;
- actual latency and database load of one-second Cron plus queue polling;
- effective Worker placement/Regional Services behavior and contracted
  Workflow/Worker limits in every deployed region.

## Recommended primitive map

| Avalon responsibility | Recommended primitive | Authority / failure rule |
| --- | --- | --- |
| Global identity and tenant routing | Required global Supabase Auth/control database | Global identity/invitation/billing plus opaque shard route/epoch only; product data stays regional |
| Global-to-shard control | Global route/outbox/receipt tables + Cloudflare Workflow/Worker dispatcher + regional route gate/receipt | Source shard closure is move linearization; retries cannot create two writers |
| Workspace/work-stream metadata | Regional Postgres | Same transaction as originating command and event |
| Ordered parts and substreams | Regional Postgres private tables/RPCs | Work-stream row lock allocates sequence; sealed parts immutable |
| User queue/steer input | Postgres command RPC + durable event + Queue + Broadcast hint | Committed revision is authority; Broadcast accelerates only |
| Unread/mention/interest/sidebar | Common projection plus sparse per-user tables | Updated transactionally; seen is monotonic |
| Client realtime | Private Realtime Broadcast over one multiplexed regional socket | Durable cursor catch-up after every gap/reconnect |
| Token stream | 500 ms delta checkpoints into 16 KiB mutable-tail chunks + body-free REST Broadcast hints + offset RLS fetch + local 10/20/30 fps animation + sealed part | Launch-safe revocation without row-per-token, growing-prefix, or per-checkpoint database-Broadcast amplification; any later leased body network path capped at 30 fps |
| Presence/typing | Realtime Presence | Ephemeral hint only |
| Durable asynchronous work | Logged Supabase Queues (`pgmq`) | At-least-once end-to-end; receipt and DLQ required |
| Timed dispatch | Supabase Cron | Wake-up only; due-state in Postgres |
| HTTP/provider/bounded step code | Shard-configured Cloudflare Worker fetch handler | One fenced action; EU content enters Regional Services hostname; progress durable in Supabase |
| Full agent loop | Supabase authoritative run/effect ledger + exactly one Cloudflare Workflow | One logical run lasts hours; never one long Worker request/step |
| Daytona Terminal | Existing Daytona provider via durable effect adapter | Provider unchanged; start/reconcile by provider reference |
| Connector raw/large bodies | Private regional Storage + `content_refs` | Pending/finalized state and orphan cleanup |
| Connector activity/digest/suggestions | Regional Postgres + Queues/Cron + Cloudflare Worker/Workflow | Source watermark/provenance/authz epoch retained |
| Exact search | Postgres FTS/GIN | Authorization joined in database |
| Semantic search | Regional pgvector/HNSW | Derived/rebuildable, versioned, never authorization |
| DB-side secrets | Vault | Per-project, least privilege |
| Runtime provider secrets | Shard-scoped Cloudflare Worker secrets | Never sent to client/queue/realtime/workflow |
| Schema migration | CLI migrations, expand/backfill/contract | One pusher; no dashboard drift |
| Large data backfill | Campaign/job tables + Queue/Cron + Worker/Workflow | Bounded idempotent chunks and invariant receipts |
| Backup/DR | Supabase backups/PITR plus separate Storage plan | Whole-project restore and effect reconciliation |
| Product audit | Regional Postgres receipts/events | Logs are diagnostics only |
| Operational telemetry | Logs Explorer, Metrics, optional redacted Log Drain | No product content/secrets in logs |

## Rejected or constrained alternatives

- **One Supabase project per workspace or work stream:** expensive always-on compute/control overhead, poor relational querying, awkward identity/operations, and unnecessary physical isolation.
- **A synthetic “Workspace actor” process inside Supabase:** Postgres already makes child/sidebar updates transactional; another serialized process adds failure modes without authority value.
- **Postgres Changes for every sidebar/part update:** simpler initially but authorization-per-subscriber and single-threaded ordered change delivery scale poorly; use private Broadcast plus durable events.
- **Realtime/Broadcast replay as the event log:** short timestamp window and 25-message replay cap cannot satisfy offline/reconnect/audit semantics.
- **Presence for seen, membership, or run ownership:** Presence is ephemeral and reconciliation-prone.
- **One Realtime socket per work stream:** wastes peak connections/heartbeats and conflicts with 100-channel connection limits; multiplex one regional socket.
- **Keeping background application sockets alive indefinitely:** consumes peak connection and egress resources; close based on product lifecycle and recover by cursor.
- **Row-per-token or growing-prefix storage:** consumes shared DB WAL/IO or
  repeatedly copies the accumulated response; checkpoint only deltas into
  bounded mutable-tail chunks and seal one immutable part.
- **Supabase Edge Functions or a second Queue/Cron loop engine:** duplicates the
  chosen Cloudflare compute/orchestration plane and its failure tests.
- **One full agent loop in a direct Cloudflare Worker:** still runtime/network/deploy-coupled; use Workflow if Cloudflare is selected.
- **One Workflow per model turn:** fragments full-loop lifecycle and duplicates orchestration; one instance should represent one admitted full loop.
- **Queue as exactly-once execution:** visibility prevents concurrent normal reads but cannot atomically cover external effects or worker delete; receipts/reconciliation remain mandatory.
- **Database Webhooks as the durable outbox:** asynchronous delivery lacks the application's durable redrive/provenance contract; enqueue in the committing database transaction.
- **Read replicas for current sidebar/authorization/run reads:** asynchronous lag and primary-only Realtime/Auth/Storage violate correctness needs.
- **JWT workspace lists as authorization:** stale until refresh, large, and hard to revoke; use live regional membership/epoch checks.
- **Service key in the client:** bypasses RLS and compromises all data in the project.
- **Substream as shard/tab/tool-turn/security boundary:** destroys explicit context semantics; substreams are logical model-context lanes.
- **Compaction by rewriting/deleting messages:** creates lost-tail and audit races; compact a frozen complete-turn range into a versioned derived artifact.
- **Vector Buckets as launch authority/search store:** alpha, nontransactional with source rows, and insufficiently verified for tenant authorization/residency.
- **A global product database or global vector index:** crosses residency boundaries and recreates a sensitive global plane.
- **Cross-region failover for EU workspaces:** availability cannot silently override the selected data boundary.
- **PITR as migration rollback:** restores the whole database with downtime and cannot undo external effects or restore Storage objects.
- **Moving Terminal away from Daytona:** outside this architecture. Daytona remains the provider.

## Decisions the PRD must force before implementation

1. What contract/test proves the opaque Workflow plus Regional Services Worker
   path for EU; which features fail closed until it does?
2. What exact Supabase project/Auth federation contract gives one Avalon identity regional sessions without shared signing-key risk?
3. Do 16 KiB chunks and 500 ms observed/one-second unobserved checkpoints pass
   WAL/TOAST/vacuum/IO, incremental RLS-read, and Realtime fan-out tests at 100
   and 1,000 simultaneous streams, and which 10/20/30 fps local render target
   best balances perceived flow, CPU, and accessibility?
4. What workspace/member/work-stream scale, connector burst, token fan-out, and queue-latency targets drive the initial compute tier?
5. What is the formal substream context materialization function, including fork/document/none inheritance and promotion?
6. Which tool effects are cancellable, idempotent, queryable, or inherently `unknown` after a crash?
7. What background notification contract determines when an idle Electron app retains or closes Realtime?
8. What legal/contractual residency guarantees are required for EU Supabase
   Realtime/Auth/logs/backups/support and Cloudflare Workflow/Worker/Regional
   Services/subrequest processing?
9. What customer retention/backup/deletion promises apply separately to Database, Storage, vectors, logs, provider artifacts, and DR copies?
10. What load-test thresholds trigger partitioning, compute resize, read replicas, or a later multi-project shard inside a region?

## Bottom line

Supabase changes the best architecture from millions of isolated actors to a regional relational authority. It handles Avalon's hardest cross-object metadata problem elegantly: conversation append, work-stream lifecycle, workspace collections, unread/mention overlays, durable events, and a Realtime hint can commit together. It also gives a coherent native stack for queues, scheduled dispatch, files, vectors, Auth, and observability.

Supabase remains the canonical product and realtime authority, while Cloudflare
Workers and one data-minimal Workflow per full loop are the sole application
compute/orchestration plane. Queued/steering input commits before control
signaling, compaction is fenced immutable derived data, the global Supabase
database routes opaque workspace control to shard-local gates, and Daytona
remains the Terminal provider.
