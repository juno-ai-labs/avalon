# Supabase Postgres product authority

Avalon's Supabase architecture is a feature-gated replacement authority for the
regional D1/R2 product plane. It combines one small global routing database,
one or more regional product databases, content-bearing Supabase Realtime
Broadcast, PGMQ queues, private Storage, Postgres search, and Cloudflare
Workflows for inference. The checked-in production configuration still selects
`PRODUCT_DATA_AUTHORITY=d1`; this module supplies the schema, command boundary,
durable execution protocol, tests, and source-closure gates needed before a
workspace can be canaried.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `infrastructure/supabase/global/supabase/` | Rebuildable global identity/routing-control database and pgTAP contract tests. |
| `infrastructure/supabase/regional/supabase/` | Rebuildable regional product shard, RLS, Realtime, Queues, Storage metadata, search, execution receipts, and pgTAP tests. |
| `packages/postgres/src/index.ts` | The only Worker-side Postgres client. It enforces transaction-pooler URLs, one connection per invocation, role-specific methods, and typed RPC results. |
| `apps/api/src/postgres/runtime.ts` | Selects the feature-gated authority and maps each least-privilege database role to its secret connection URL. |
| `apps/api/src/postgres/workflow-control.ts` | Starts deterministic Workflows, delivers opaque signal IDs, and drains durable PGMQ start/signal fallbacks. |
| `apps/api/src/workflows/postgres-agent-loop.ts` | Runs one complete semantic agent loop as a Cloudflare Workflow and checkpoints model output into the regional database. |
| `packages/db/migrations/0077_postgres_authority_gates.sql` | Adds D1 source gates and export/shadow evidence without changing D1's default writable authority. |
| `docs/PRDs/2026-08-15_supabase-workspace-workstream-conversations/` | Product requirements, platform research, stress studies, comparison, rollout plan, and state. |

## How it works

### Global routing and regional authority

The global database contains only account, organization, entitlement, shard,
workspace-route, and routing-command data. A regional database contains all
workspace content and is the sole transactional authority for a workspace. A
global routing command carries a workspace ID, route epoch, target shard, typed
operation, and payload hash. The target applies it through
`apply_global_workspace_command`; the global dispatcher acknowledges the
regional receipt. A stale route epoch or conflicting payload cannot overwrite a
newer route.

The regional schema keeps relational features rather than flattening data for a
hypothetical Durable Object move. Every workspace child nevertheless has a
stable UUIDv7 identity and workspace/work-stream ownership, which makes a later
bounded export mechanically straightforward.

### User commands and realtime delivery

Authenticated clients see only the `api` schema. Security-definer command
functions acquire locks in workspace/work-stream/substream order and atomically
commit canonical rows, idempotency receipts, durable cursor events, sidebar
projections, and a best-effort private Database Broadcast. Tables in
`avalon_private` have RLS enabled and are not exposed by the Data API.

Broadcast carries actual bounded card patches, conversation text, streaming
text, tool calls, and tool results; it is not merely an invalidation. Each
stream checkpoint contains its byte range, prefix hash, current text delta, and
up to the preceding two verified batches. A client can therefore repair one or
two missed deliveries immediately. It still treats the Postgres cursor and
active-output rows as authoritative and fetches them whenever offsets or hashes
do not join. Realtime failure never rolls back the product transaction.

Generated text is grouped into nonempty checkpoints at approximately 2 Hz. The
desktop can animate each batch at its own 10, 20, or 30 fps presentation cadence
without turning 100 tokens/second into 100 database writes/second. A 10,000-token
answer lasting 100 seconds normally produces about 200 active-row mutations and
200 Broadcast sends, then one immutable conversation part.

### Full agent loops, queued input, and steering

One deterministic Cloudflare Workflow instance represents one full semantic
loop, including multiple bounded model/tool/Terminal actions and waits. Workflow
inputs, events, and returned state contain identifiers, revisions, and hashes,
not prompts or generated content. Model steps load authorized context from
Postgres at execution time. The foundation currently invokes Bind as one
retryable Workflow step with no application wall-time timeout, which supports
ordinary 2–30 minute and rare multi-hour loops because paid Workflow step wall
time is unlimited. Before canary, the host still has to split model, tool,
Daytona, and settlement actions into independently durable semantic steps;
Daytona remains the Terminal execution provider.

`api.append_user_message` reserves the message sequence and returns an admitted
run or pending batch in the same transaction. `queue` leaves the current
control revision unchanged and creates or extends the next batch. `steer`
advances the control revision, records a durable `run_signals` row, and places
an identifier-only wake on `workflow_signals`. The API calls the Workflow
binding immediately; PGMQ is the durable fallback. `sendEvent` wakes a Workflow
that is waiting, while an actively executing model step notices steering at its
next 500 ms database checkpoint, loses the control compare-and-set, aborts the
provider request, and rematerializes under the new revision.

Finalizing an output seals its reserved transcript part but deliberately keeps
the current run as `workstreams.active_run_id`. Only `workflow_finish_run`
releases that owner, and it admits the oldest pending batch while holding the
same work-stream row lock in the same transaction. A message arriving after the
last output checkpoint therefore extends the pending batch instead of creating
a younger run that can overtake it.

Tool-call and tool-result parts commit together in one database transaction.
That preserves provider-valid adjacency: a user message can sort before the
exchange or after it, never between the call and result. External effects have
an Avalon operation ID and effect receipt before execution because database
atomicity cannot include a provider or Daytona.

### Compaction and connector activity

Compaction freezes a source boundary and authorization revisions. A run uses a
valid summary plus all parts after that boundary; messages committed while the
summary is being built remain in the tail and are never lost. Revoked or stale
compactions fail closed and the projector falls back to authorized raw parts.

Connector ingress first records provider delivery identity, raw-payload hash,
workspace ownership, and a content reference. Exact retries reuse the receipt;
a provider key reused with different bytes is quarantined. Normalization creates
regional `activity_events`, resource links, cursor state, digest jobs, and
suggestion source rows. PGMQ contains only identifiers and routing metadata;
payloads remain in regional Database or private Storage.

## Invariants

- Exactly one authority is writable for a workspace. Breaking this creates two
  histories that no timestamp merge can safely reconcile.
- Workspace route epoch, regional route gate, run control revision, access
  revisions, and migration pause epoch are compare-and-set fences. Ignoring any
  one can admit a stale write, leak newly revoked content, or commit work after a
  pause.
- A successful command returns only after canonical rows and its command receipt
  commit together. Otherwise a retry could either duplicate an intentional
  action or report success for data that does not exist.
- UUIDv7 is used for application identities. Replacing it with random UUIDv4
  removes temporal locality and breaks deterministic migration ordering.
- Conversation `seq` is a durable total order, while a tool call/result is one
  atomic exchange. If user input can interleave inside that pair, provider
  rematerialization becomes invalid.
- Broadcast is a content-bearing acceleration layer, never the only copy. If a
  client advances its durable cursor solely from an uncommitted or unverified
  frame, reconnect can lose or duplicate text.
- Workflow persisted state contains identifiers/revisions/hashes only. Prompt,
  message, tool, and generated content in Workflow history would create an
  uncontrolled second residency and retention surface.
- Queue messages contain IDs and versions, not customer bodies. Otherwise queue
  retention, debugging, and dead-letter handling become product-data stores.
- Content is released only when its workspace, work-stream/substream access,
  scope, and content-reference authorization revisions all still match. A
  summary or embedding cannot outlive the authority of its sources.

## Boundary

This module owns Supabase schemas, database commands, role grants, durable
execution receipts, PGMQ handoff, active-output persistence, and the Worker-side
Postgres adapter. Supabase Database is canonical when a route selects
`postgres`; Cloudflare Workers authenticate and route, and Cloudflare Workflows
coordinate inference. Supabase Realtime delivers already-authorized committed
content. Supabase Storage owns large regional objects. Daytona owns Terminal
sandbox execution but not Avalon state.

The checked-in deployment does not activate this authority and does not migrate
a workspace merely because the schema exists. The existing D1 service, Durable
Object room, desktop socket client, connector executors, and Terminal plugin
continue to serve production while `PRODUCT_DATA_AUTHORITY=d1`. A later canary
must finish the Supabase session exchange and desktop Realtime adapter, port the
approved tool/plugin surface to the Postgres receipt boundary, and obtain an
explicit verified source-closure/route-activation receipt. This separation is a
safety boundary, not an invitation to dual-write canonical histories.

## Failure modes and limits

- A Realtime error is swallowed after the database commit. The client catches
  up by durable cursor/offset; it does not retry the product mutation merely to
  emit a socket frame.
- A missing or duplicated Workflow wake is safe. The deterministic Workflow ID,
  `workflow_starts`, `run_signals`, and PGMQ queues reconcile delivery.
- `sendEvent` cannot preempt a live Workflow step. Steering latency is bounded
  by the next nonempty checkpoint/liveness callback, normally 500 ms plus the
  database round trip.
- One checkpoint accepts at most 16 KiB of new UTF-8 text and two overlap
  batches; the Broadcast application envelope is capped below 192 KiB. Larger
  terminal parts use a ready private Storage reference.
- Workflow step wall time is unlimited on Workers Paid. The Worker-level
  `limits` block configures five active CPU minutes and 10,000,000 subrequests;
  the Postgres Workflow definition independently configures 25,000 steps, using
  the placements supported by Wrangler. Waiting-for-user is represented by a Workflow event with a 30-day
  timeout. The initial host still treats Bind's full loop as one retry unit and
  is not canary-ready until action-level step/checkpoint adapters land.
- The Worker client uses Supavisor transaction mode on port 6543 in hosted
  environments, disables prepared statements, and opens at most one connection
  per role/client instance. A pool outage delays execution; receipts make the
  retry deterministic.
- PGMQ leases expire and poison messages move to `dead_letters` after ten reads.
  Exact product limits and abuse controls remain production-measurement inputs,
  not hidden hard caps in this module.
- Source migration claims are 60-second leased slices. Pause epoch is rechecked
  at renewal and settlement; an in-flight external read may finish, but cannot
  commit after a pause or superseding epoch.

## Testing

Run the real local projects separately because both use Supabase's default local
ports:

```sh
pnpm postgres:regional:start
pnpm postgres:regional:reset
pnpm postgres:regional:test
pnpm postgres:stop
pnpm postgres:global:start
pnpm postgres:global:reset
pnpm postgres:global:test
```

`pnpm postgres:stop` uses the Supabase CLI's all-project stop so Global and
regional containers are both stopped even when one project was not running.

Regional pgTAP tests cover tenant isolation, command replay, conversation order,
queue versus steer, control-fenced checkpoints, tool adjacency, connector
ingress, activity, and suggestions. Global pgTAP tests cover UUIDv7, routing
claim/receipt idempotency, and route epochs. `packages/postgres/test` covers the
transaction-pooler and UUID contracts. API Worker tests cover identifier-only
Workflow state/signals and provider-valid message projection. The repository's
ordinary lint, typecheck, test, and Wrangler dry-run gates remain required.

## Data model

The migration files are authoritative. The schema is split into:

- global `avalon_global_router` tables for identity, organization, entitlement,
  regional shards, workspace routes, commands, attempts, receipts, and audit;
- regional `avalon_private` tables for authority, sidebar common/user overlays,
  work streams, substreams, turns/parts, active output, compaction, durable
  events, agent runs/actions/signals/effects, Terminal receipts, connectors,
  activity, digests, suggestions, content/search, and lifecycle jobs;
- regional `api` security-invoker views and security-definer command functions;
- Supabase-managed `auth`, `realtime`, `storage`, `pgmq`, and `cron` schemas.

Cross-object relationships are ordinary foreign keys and same-database
transactions within a shard. Cross-database routing is never a foreign key: the
global command and regional receipt protocol resolves it with route epochs and
payload/result hashes.

## Regional impact

Global and EU product content resides in separate regional Supabase projects
created from the same migrations. The global control project stores only the
enumerated routing and account metadata needed before a regional workspace can
be found. It must not acquire transcript, connector payload, activity, vector,
or generated content. Cloudflare Workflow/provider/Daytona and Supabase
Realtime processing are separate subprocessor questions; their transient
processing promises must match contracts and region policy rather than being
inferred from the database location.

## Security and trust model

Worker database URLs are secrets and bind to distinct
`avalon_global_router`, `avalon_regional_router`, `avalon_workflow_runner`, and
`avalon_queue_runner` roles. None is exposed through `VITE_`, returned to the
renderer, or logged. Desktop access is intended to use short-lived
project-specific Supabase sessions mapped through `platform_identities`; it does
not receive a database-role credential. Access-revision topic names prevent an
already joined old topic from receiving content committed after revocation, and
RLS still protects catch-up reads.

## Operations

Health reports Postgres only when `shadow` or `postgres` is selected. It probes
the regional router, Workflow runner, and queue runner independently, plus the
Global router on the Global Worker; any missing connection or unexpected
database role fails the aggregate authority check. Operators
must compare route/gate epochs, queue age/read count, Workflow starts/signals,
active output age, checkpoint write/byte rates, Realtime sends/deliveries/egress,
RLS denials, connector conflicts, and migration receipts before widening a
canary. A migration is not complete until source closure, destination counts and
hashes, activation receipt, and global route convergence all agree.

## Performance and cost

The write model scales with active inference, not token count or viewers:
approximately two checkpoint mutations and two Broadcast messages per active
run per second, plus delivered-message fan-out. Viewer count changes Realtime
delivery/egress cost but not database checkpoint count. The two-batch overlap
intentionally trades roughly three-times unique streaming bytes for immediate
repair without a body fetch. Production admission is governed by measured
database CPU/WAL/IOPS, transaction-pooler wait, queue age, Realtime joins and
messages, and cost per active run; it is not inferred from a raw workspace or
work-stream count.

## Changelog

### 2026-08-17 — Terminal settlement preserves queue order and probes every database role

**What changed:** Output finalization now leaves the active run attached until
`workflow_finish_run` atomically releases it and admits the oldest queued batch.
Health checks every configured Postgres role, local shutdown stops both Supabase
projects, and Workflow CPU/subrequest limits moved to Wrangler's supported
Worker-level block while the per-Workflow block retains only its step limit.

**Why:** Releasing ownership when the last output sealed created a transaction
gap in which newer input could start a run ahead of an older pending batch. A
single-role health probe and ignored Wrangler fields could also report a canary
healthy when routing, queue draining, or resource safeguards were unavailable.

**Considered and rejected:** Starting the successor from the output-finalization
command would couple a conversation-part commit to full-loop settlement and
would still leave failure outcomes on a separate path. Terminal settlement is
the one boundary shared by every outcome and already owns successor admission.

**Consequences:** `p_terminal_run` marks the final output frame, not ownership
release. Callers must always settle the run. Canary health now opens one bounded
connection per required role, and CPU/subrequest limits apply to the Worker
script while only the step limit is scoped to the Postgres Workflow definition.

### 2026-08-17 — A feature-gated Supabase authority and Workflow protocol are executable

**What changed:** Added rebuildable global and regional Supabase projects,
least-privilege/RLS schemas, content-bearing Broadcast, PGMQ queues, active
output and agent-loop commands, a transaction-pooled typed Worker client, a
full-loop Cloudflare Workflow, durable start/signal handoff, D1 source gates,
and real Postgres contract tests. Production remains explicitly on D1.

**Why:** The architecture decision needed more than table sketches: ordering,
steering, reconnect, compaction, migration, and cross-region claims have to be
expressed as atomic commands and executable fences before Supabase can be
compared with Durable Objects safely. Keeping D1 selected prevents the schema
landing from becoming an accidental authority migration.

**Considered and rejected:** Direct per-token rows, Realtime as canonical
history, one Edge Function per full loop, queue payloads containing customer
content, and an immediate dual-write cutover. They respectively create write
amplification, unrecoverable gaps, exceed the required loop duration, widen data
surfaces, or create two writable truths.

**Consequences:** The foundation can be rebuilt and canaried independently, but
a later change must not flip `PRODUCT_DATA_AUTHORITY` until desktop Supabase
session/Realtime delivery and the Postgres-native approved plugin/Daytona
surface pass the rollout gates. Future schema changes remain forward-only and
must preserve source closure, revision fences, bounded Broadcast content, and
identifier-only Workflow/Queue state. Design:
`docs/PRDs/2026-08-15_supabase-workspace-workstream-conversations/prd.md`.
