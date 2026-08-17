# Work-stream Durable Object storage

Avalon has one regional SQLite-backed `WorkstreamRoom` Durable Object for each
work stream. The object name is
`<region>:<workspace-id>:<workstream-id>` in the existing `WORKSTREAM_ROOMS`
namespace. The class and object identities do not change during this migration.

The migration has two distinct inputs:

- the room's old hidden key/value records are moved locally into named SQL on
  first activation; and
- regional D1 work-stream product rows are copied during an announced
  maintenance window, verified, and activated as one authority generation.

Before the regional authority switch, D1 remains the serving authority. Each
WorkstreamDO becomes the local authority when its verified generation is
activated, but it remains unavailable behind the regional maintenance fence.
After the guarded `durable_object_open` switch, the named tables serve the
product and the legacy D1 product tables reject every insert, update, and
delete. Those product tables are already write-fenced when import begins so the
multi-page snapshot cannot drift. D1 then retains workspace authorization and
routing, schedules and connector delivery state, user pins, and rebuildable
common/user directory projections for the sidebar.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Object-local DDL, immutable schema fingerprints, and lazy additive schema application. |
| `apps/api/src/durable-objects/workstream-object-storage.ts` | Existing KV-to-SQL migration plus current room operations for cursors, active output, due work, and ticket receipts. |
| `apps/api/src/durable-objects/workstream-authority-import.ts` | Fixed import-stage contract, reset order, page receipts, verification, and activation. It accepts no arbitrary SQL. |
| `apps/api/src/services/workstream-authority.ts` | Regional authority phase reader and HTTP/queue maintenance fence. |
| `apps/api/src/services/workstream-authority-migration.ts` | Bounded D1 source paging, normalization, DO delivery, fleet progress, quarantine, and initial directory projection creation. |
| `packages/db/migrations/0077_workstream_do_authority_cutover.sql` | Regional control/route ledgers, legal phase transitions, drain/open guards, D1 directory projections, and legacy writer fences. |
| `apps/api/src/durable-objects/workstream-room.ts` | Existing sockets plus the internal authority-import endpoint. |

## Storage ownership

### WorkstreamDO authority

The WorkstreamDO schema stores the product state that is intrinsically owned by
one work stream:

- root metadata, lifecycle, origin, model choice, and sequence allocators;
- participants, viewer attention/read waterlines, and HyperSight preferences;
- substreams, ordered parts, attachments, mentions, and content references;
- runs, immutable run scopes and memory context, lifecycle and inference events,
  plugin activations, tool effects, and checkpoints;
- active output chunks and durable run/event replay receipts;
- compaction jobs/checkpoints and resource-inventory revisions;
- linked resource descriptors, activity-delivery receipts, and suggested actions;
- one-shot wakeups and description-refresh state; and
- the Daytona Terminal workspace, tasks, imported resources, selected repository,
  publication grants, and publication receipts.

The main conversation is substream `0`. Importing the D1 transcript does not
invent substreams: every existing message becomes one `parts` row in substream
`0`, preserving its ID and sequence. New chat/agent substreams may be created
only for an actual isolated model context or child interaction. They are not
folders, UI grouping, participants, runs, or a workaround for large history.

### Regional D1 after cutover

D1 remains authoritative for workspace membership and roles, global/regional
routing, connector identities and credentials, schedules/resource watches,
automation definitions and deliveries, email/Slack ingress receipts, audit and
telemetry, user pins, and workspace-owned resources. A WorkstreamDO stores a
resource link and descriptor snapshot, not a second connector credential or
workspace resource catalog.

`workstream_directory_projections` stores common sidebar fields such as title,
description, preview, last activity, lifecycle state, completion, scope, and
system kind. `workstream_directory_user_projections` stores only the viewer
overlay: participation, unread count, `you_are_mentioned`, and listability.
Both rows carry authority generation and monotonic version. They are
rebuildable; they are never a fallback product authority.

The first maintenance import seeds these projections from the frozen D1 source.
After cutover, a WorkstreamDO update must commit locally before it emits a
versioned projection update. Delivery is at least once and D1 applies only a
newer `(generation, version)`, so an older user patch cannot overwrite a newer
common or viewer state.

## Schema evolution

The constructor runs only local bounded work inside
`DurableObjectState.blockConcurrencyWhile()`:

1. create `_sql_schema_migrations` if needed;
2. compare every applied implementation fingerprint;
3. apply missing additive DDL with `storage.sql`;
4. update `object_versions` only when a code/contract/schema value changed; and
5. run the small legacy KV import or resume its cleanup.

A schema version is immutable after deployment. Changing its SQL without a new
version fails with `workstream_schema_hash_mismatch:<version>`. A data rewrite
does not run in the constructor; it is a bounded `_data_migrations` campaign.

### Existing hidden KV import

| Old key | Named SQL owner |
| --- | --- |
| `roomIdentity` | `workstream` plus main `substreams` row |
| `eventSequence` | transitional `realtime_state` |
| `activeStreamCheckpoints` and numbered text chunks | `runs`, `active_output_turns`, `active_output_chunks` |
| `pendingHyperSightRefresh` | `due_work` |
| `socket-ticket:<jti>` | `durable_inbox_receipts` |

The importer commits the relational copy and `phase = copied`, deletes only
those known key families, then records `completed` and `data_version = 1`. A
restart during deletion resumes cleanup from SQL and never reparses a partial
chunk set. Invalid old values fail closed and remain untouched.

## Maintenance-window authority migration

The maintenance window intentionally removes live tailing, holding queues, and
dual-write reconciliation from the cutover.

```text
legacy_open
  -> maintenance_draining
  -> maintenance_importing
  -> maintenance_verified
  -> durable_object_open
```

`quarantined` is reachable from an importing, verified, or open generation. A
new attempt from quarantine must use a larger generation.

### 1. Compatibility deployment

Deploy the schema/import-capable Worker and apply D1 migration `0077` while the
control row is `legacy_open`. The application continues using D1. Missing
`workstream_authority_control` is tolerated only for this deployment ordering;
other read errors fail closed as quarantined.

### 2. Drain

An operator moves the singleton control row to `maintenance_draining` with a
new generation. Every non-health HTTP request receives 503 with `Retry-After`,
Queues retry rather than being acknowledged, named regional connector/email RPC
entrypoints return retryable maintenance failures, and workspace/room alarms
park for five minutes instead of admitting new work. Existing Workflows may
finish. The transition to import is rejected while any root or inline
`harness_runs` row is still scheduled/running and not terminalized.

The operator must also confirm the Cloudflare Queue has no in-flight consumer
and no external deployment is still running old code. That fact is not present
in D1 and must not be inferred from an empty run query.

### 3. Import

Moving to `maintenance_importing` atomically creates one route row for every
archived and unarchived work stream with its deterministic object name and
`next_sequence_number - 1` source fence. Cron processes at most 100 route
operations per invocation in waves of at most five. That stays below the
Worker invocation's six simultaneous outbound-connection limit and preserves
one slot for control-plane work. Migration and telemetry execute sequentially
during this phase so their connection demand cannot overlap. One object request
may bundle up to 40 consecutive allow-listed stages, while the whole request
still contains at most 200 source rows.

The same phase transition activates D1 triggers that reject every legacy
work-stream product mutation. This closes the scheduler/Workflow/RPC time-of-
check gap at the database linearization point; workspace/control rows that are
not part of the snapshot remain writable.

The first request to an object closes every hibernating WebSocket with 1012,
pins its workspace/work-stream identity, resets only product/transitional rows,
and records the generation. Each subsequent page names one allow-listed source
stage, its exact prior/source cursor, and exact target columns. A
`(generation, stage, source cursor)` receipt makes retries idempotent; the body
hash rejects a reused command ID with different data. Bundled pages commit
independently, so a retry safely resumes at the first uncommitted page.
Arbitrary SQL, table names, or columns never cross the endpoint.

The stage order satisfies dependencies: root and participants; runs/scopes and
run events; HyperSight; transcript parts/attachments/mentions/attention; tools
and elicitations; resource links/compaction/actions; wakeups/descriptions; then
Terminal and publication state.

### 4. Verify and activate

An object verifies all source/target counts, the chained page hash, SQLite
foreign keys, run-lineage references, and the root/message sequence fence.
Only then does its route become `verified`. Any parse, constraint, hash, count,
identity, or delivery failure quarantines the object and regional campaign.

When every route is verified the control row enters `maintenance_verified`.
Cron activates each object locally, changing `authority_mode` from `preparing`
to `authoritative`, and records the route as active. The region deliberately
stays in maintenance after the final activation. Import success is not
permission to expose a new owner: deploy and verify the DO-serving application
path before the operator performs the final one-row `durable_object_open`
transition. The Worker carries a compile-time serving-contract version and cron
attests it into D1 only after every route is active. This import deployment
carries version `0`; it cannot reopen the region. The complete serving
deployment must carry at least the control row's required version (initially
`1`). Both the Worker request gate and the D1 open trigger check that version,
and the trigger also rejects opening unless every route in the generation is
active.

Once open, all legacy D1 work-stream product tables have insert/update/delete
triggers that raise `workstream_do_authoritative`. There is no automatic
fallback to D1. Repair the owning object or quarantine the region; silently
reopening old writers would create two authorities.

## Realtime and streaming

Hibernating WebSockets, serialized socket attachments, auto-response
`ping`/`pong`, and the bounded in-memory replay window remain. The replay window
is an optimization, not a write per token.

Active inference is the durable exception. Batched model frames update the room
cursor, one `active_output_turns` row, and bounded `active_output_chunks` in one
synchronous local transaction. Chunks are at most 60 KiB UTF-8 and never split
a Unicode scalar. Clients may render at 10, 20, or 30 frames per second while
the durable checkpoint cadence remains coarser; they animate the delta within a
batch. At 100 tokens/second for 10,000 tokens this avoids 10,000 rows and avoids
30 durable writes/second. A reconnect receives the current accumulated prefix
before later deltas, so switching between two streaming work streams does not
lose or duplicate text.

## Invariants

- One object is permanently pinned to one region/workspace/work-stream tuple.
- A schema version and an import command ID are immutable once observed.
- Legacy KV is deleted only after its SQL copy commits.
- D1 product rows are writable only in `legacy_open` and during drain; import
  freezes them permanently. Directory projections remain writable after open.
- No import begins until every agent/tool run has terminalized.
- No region opens until every object in the same generation is active.
- No region opens until the deployed Worker attests the required DO serving
  contract; an operator cannot substitute a phase edit for code support.
- The room cursor and active text checkpoint commit together.
- Constructor initialization never waits on D1, R2, a provider, or another DO.
- A quarantine never falls back to the old product rows.

## Failure and recovery

- `copied/running` for the KV campaign means cleanup can resume from SQL.
- A D1 import route in `pending` or `importing` is safe to retry; its page
  receipts prevent duplicate inserts.
- `quarantined` requires repair and a new generation. Do not edit target product
  rows merely to make counts match.
- D1 PITR is the source rollback while still in maintenance and before open.
  After open, object PITR/repair is the product recovery path; D1 is only a
  projection/control recovery source.
- Objects activated before the regional open remain unavailable behind the
  maintenance fence. This is safe and intentional.

## Cloudflare limit and cost validation

The schema and importer are kept inside the paid-plan Durable Object limits by
executable tests and explicit batch bounds:

| Platform constraint | Design response |
| --- | --- |
| 10 GB SQLite storage per object | One object owns one work stream; telemetry must alert before an individual object approaches the limit. A later archival/export design is required rather than silently splitting one authority. |
| 100 columns per table | The schema test inspects every table and rejects a wider table. |
| 2 MB per row, string, or BLOB | Active output chunks are capped at 60 KiB UTF-8. Imported product rows preserve the already-limited D1 row boundary instead of combining many source rows. |
| 100 bound parameters and 100 KB per SQL statement | Import tests reject a stage with more than 100 target columns; schema tests measure every DDL statement. The current widest import stage has 47 columns. |
| Six simultaneous outbound connections per invocation | Import waves use at most five routes and run separately from telemetry. |
| Billed SQL rows and active object duration | Token deltas mutate bounded chunks at a coarser durable cadence rather than writing per token. WebSockets use hibernation, so an idle background client does not keep object duration billing active. |

Schema installation runs `PRAGMA optimize` only after applying new DDL. The
constructor does no remote work, and each authority import request is capped at
200 source rows so it remains bounded under the normal request CPU budget.

## Testing

| Suite | Covers |
| --- | --- |
| `test/workstream-object-schema.test.ts` | Complete table manifest, schema hash drift, KV migration/recovery, identity fencing, output chunking, and an import/verify/activate generation. |
| `test/workstream-authority-migration.test.ts` | Every source query against the fully migrated D1 schema and exact normalized target column sets. |
| `packages/db/test/migrations.test.ts` | Phase/drain/open guards, route population, legacy writer rejection, and projection writability. |
| `test/workstream-room-authorization.test.ts` | Socket authorization/revocation on the SQL-backed room. |
| `test/runtime-components.test.ts` | Cursor/checkpoint folding, chunk bounds, ticket receipts, and replay behavior. |

Both regional Wrangler dry runs remain required because Node SQLite does not
prove D1 or workerd behavior.

## Changelog

### 2026-08-17 — Maintenance-fenced D1 to WorkstreamDO authority migration

**What changed:** The existing one-workstream-per-object namespace gains the
complete work-stream-down schema, a fixed staged D1 importer, regional route and
phase ledgers, hard drain/open guards, initial sidebar projections, and
post-cutover D1 writer fences. PRDs used during the architecture exploration
were removed; this module document is the maintained implementation contract.

**Why:** Copying data without changing every authority path would leave D1 as a
silent second writer. The accepted maintenance window makes one frozen snapshot
and one verified fleet generation cheaper and safer than dual writes plus a
live tail across many independently activated objects.

**Considered and rejected:** A new DO namespace would copy object identities for
no storage benefit. Lazy per-object D1 imports in constructors would hold input
gates across network I/O. A live migration would require holding queues, route
CAS, tail reconciliation, and conflict policy. Automatic opening immediately
after import was rejected because data verification does not verify the serving
Worker.

**Consequences:** The regional maintenance window lasts through drain, import,
verification, activation, and the serving deploy. The import deployment's
serving-contract version is intentionally zero, so it cannot be opened by
mistake. One bad object quarantines the campaign. After open, D1 product writes
fail loudly and recovery never silently changes authority.

### 2026-08-16 — Existing room KV moves into named local SQL

**What changed:** Identity, room sequence, active output, HyperSight due work,
and socket receipts migrate from hidden KV into explicit local tables.

**Why:** The namespace was already SQLite-backed, but unstructured values had no
inspectable constraints or independently evolvable data migration ledger.

**Considered and rejected:** Continuing free-form KV and allocating a new class.

**Consequences:** Old objects pay one bounded lazy migration and all current room
operations use the named SQL owners immediately afterward.
