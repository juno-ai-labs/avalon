# Fleet migration control plane and realtime lifecycle

> Created 2026-08-15.
>
> Companion to [`prd.md`](prd.md). This document is normative for fleet
> inventory, schema and data migration, Durable Object deployment, hibernating
> WebSockets, and streaming-output persistence. The complete SQLite table and
> cross-object receipt contract for every Durable Object class is normative in
> [`prd.md`](prd.md#durable-object-sqlite-conventions); this companion explains
> how the migration objects operate those tables.

## Decision

Avalon will implement the workspace/work-stream fleet migration, realtime, and
data paths in this design entirely with Cloudflare primitives. They use Workers,
Durable Objects, Workflows, Queues, D1, R2, Regional Services, Workers
observability, and, only if a bounded data transform cannot run in a Worker, a
scale-to-zero Cloudflare Container. Railway, EC2, an external job scheduler, an
external WebSocket hub, and an always-on migration service are not part of the
architecture. Avalon's `avalon:terminal` coding plugin continues to use Daytona
under its separate subsystem contract; replacing that backend is outside this
document.

The product hierarchy remains one regional `WorkspaceDO` per workspace and one
regional `WorkstreamDO` per work stream. The migration control plane is
orthogonal to that hierarchy:

- one thin `FleetMigrationDO` serializes infrequent fleet-level operator
  commands and stores only release facts and aggregate regional state;
- one campaign Workflow durably orchestrates each migration release;
- one `RegionalMigrationDO` per campaign and region serializes regional
  desired phase and rollout policy;
- a fixed, manifest-declared set of jurisdictional `MigrationShardDO`s admits
  bounded work and resolves regional object jobs inside the data boundary;
- regional D1 is the queryable fleet directory and per-object job ledger;
- Queues carry coarse, at-least-once shard wake-ups containing no product or
  object identifier;
- each `MigrationShardDO` loads its next jobs and invokes target objects through
  bounded, idempotent RPC; and
- the target object's SQLite migration journal is authoritative for what has
  actually happened to that object.

The fleet and regional control objects never relay product traffic. Their
single-threaded coordination is appropriate for rare state transitions, while
the sharded admission and one-object RPC paths scale horizontally. Cloudflare explicitly
warns against one global Durable Object for a normal application data path; the
control objects avoid that anti-pattern because they serve commands and
aggregates, not workspace requests or token traffic
([Durable Object design rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)).

## Why a control plane is necessary

Deploying a Durable Object class changes code and namespace configuration; it
does not synchronously visit every existing object. A dormant object runs new
constructor code only when an event next instantiates it. That lazy behavior is
the inexpensive default for additive schema work, but it cannot answer these
fleet questions by itself:

- Which workspace and work-stream objects exist in each jurisdiction?
- Which code, protocol, schema, projection, and data versions has each object
  actually observed?
- Which objects must be transformed now rather than lazily on next access?
- Can a campaign pause before an error or cost spike reaches the whole fleet?
- Which source snapshot, cursor, checksum, and authority epoch made a complex
  import complete?
- Can old and new parents, children, clients, and executors communicate while a
  rollout is mixed?

Cloudflare's account API can list objects in a namespace, but returns only the
opaque Durable Object ID and whether it has stored data. It does not return the
Avalon resource identity or parent/child relationship
([Durable Objects API](https://developers.cloudflare.com/api/resources/durable_objects/)).
The regional application directory is therefore primary. Account-level
enumeration is a deployment-time or operator reconciliation aid, never a
request-path dependency or the source of migration truth.

## Platform primitive map

| Need | Cloudflare primitive | Contract |
| --- | --- | --- |
| Serialize fleet commands | `FleetMigrationDO` | One active desired campaign state, approvals, pause/abort, region aggregates; no product metadata. |
| Durable campaign steps and waits | Workflows | One per campaign; never one per object. Inputs contain only the globally allowed campaign manifest and aggregate regional receipts. |
| Regional command gate | `RegionalMigrationDO` | Serial desired phase, rollout ceiling, error budget, and pause-drain epoch for one campaign/region. |
| Regional admission and resolution | `MigrationShardDO` | One of a bounded, manifest-fixed set per campaign/region; the only migration component that claims object jobs and resolves target IDs. |
| Queryable inventory and work claims | Regional D1 | Opaque object directory, current/target versions, jobs, leases, cursors, errors, and aggregate status. |
| Scale-to-zero wake-up | Queues and DLQ | At-least-once `{region, campaign_id, shard_id, wake_nonce}` hints only; never product IDs, object IDs, cursors, payloads, or authority. |
| Per-object execution | Durable Object RPC | A bounded, idempotent inspect/apply/verify command serialized with that object's ordinary events. |
| Large immutable migration input | Regional R2 | Hashed manifests and chunks; product content never enters Workflow state or Queue messages. |
| Reconciliation | Workflow sleeps plus one regional scheduled backstop | Reopen missing dispatches and expired leases without one alarm per product object. |
| Object-local continuation | Existing unified DO alarm scheduler | Only when that object already owns a due retry; migration must not overwrite compaction or outbox alarms. |
| Metrics and traces | Workers Logs/traces and Analytics Engine | Sampled operational evidence only; never migration truth. |
| Unsliceable CPU/runtime work | Scale-to-zero Cloudflare Container | Optional bounded worker behind the same regional job contract; never authority or a browser socket endpoint. |

Workflows are appropriate at campaign scope because sleeping, retrying, and
event-waiting instances do not consume active concurrency, while their durable
step history has finite retention and cost. Permanent history therefore lives
in D1, not Workflow state. Current paid limits permit high concurrency but cap
creation rate and steps, which is another reason not to create a Workflow per
object ([Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/),
[Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/)).

Queues are appropriate only for waking bounded migration shards because they
are push-driven, do not invoke an empty consumer, batch up to 100 messages,
retry, and support a DLQ. They are at-least-once and do not guarantee one
delivery. A wake-up is therefore a hint: shard admission tokens, `command_id`,
and object-local receipts provide correctness
([Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
[Queue batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/),
[Queue limits](https://developers.cloudflare.com/queues/platform/limits/)).

## Control-plane boundaries

### Thin fleet plane

The non-regional fleet plane may store only:

- `campaign_id`, manifest hash, object class, target code/schema/data/protocol
  versions, state, creation time, and named approvals;
- allowed regions, rollout cohorts, maximum concurrency, error/cost ceilings,
  and contract/cleanup gates;
- opaque regional campaign IDs and aggregate pending/running/succeeded/failed
  counts; and
- Cloudflare deployment/version IDs and artifact hashes.

It must not store a workspace or work-stream ID, Durable Object ID, title,
description, member ID, activity, transcript, mention, unread fact, suggestion,
source database row, or error text copied from customer content. Regional error
codes are enumerated; sensitive diagnostics remain in-region.

### Regional plane

Each regional plane has its own D1 directory, R2 bucket, control object,
migration-shard namespace, product-object namespaces, Queue/DLQ wake source,
and regionalized user ingress. The EU plane uses an EU-jurisdictional D1
database, R2 bucket, and Durable Object namespaces. Durable Object
jurisdiction is a guarantee; a location hint is only a best effort
([Durable Object data location](https://developers.cloudflare.com/durable-objects/reference/data-location/),
[D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/),
[R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)).

Jurisdiction is not a promise that every Cloudflare operational datum stays in
that region. Cloudflare documents that a `DurableObjectId` can be logged outside
the specified jurisdiction for billing and debugging. Avalon treats this as a
disclosed pseudonymous platform-metadata transfer, never puts a customer or
resource name into an object name/ID, and includes it in the data inventory,
DPA/SCC, retention, support-access, and legal review. It is not permission for
Avalon application logs or the Global plane to store object mappings. If the
enterprise contract and applicable EU/EEA rules do not permit that documented
operational transfer, jurisdictional Durable Objects alone do not meet the
promise and EU launch fails closed
([Durable Object jurisdiction logging](https://developers.cloudflare.com/durable-objects/reference/data-location/)).

Cloudflare documents that Regional Services applies to requests arriving at a
regionalized custom hostname, but not to Queue, Cron, **or Worker
subrequests**. A global Queue consumer POST to an EU hostname would therefore
not prove that the receiving Worker executed in the EU and is forbidden for
content-bearing migration work
([Data Localization limitations](https://developers.cloudflare.com/data-localization/limitations/)).

Workflow, Queue, and any scheduled global dispatcher have no D1, R2,
`WorkspaceDO`, or `WorkstreamDO` binding and must not receive a workspace,
work-stream, object, source-row, or content identifier. Their maximum envelope
is:

```text
{ region, campaign_id, shard_id, wake_nonce }
```

The wake consumer may call only the named, jurisdictional `MigrationShardDO`.
That DO is the first component allowed to resolve regional D1 jobs, read a
regional R2 manifest, learn a product-object ID, or call a target DO. It claims
a bounded page, schedules its own unified alarm when more work remains, and
returns aggregate enumerated status. The Queue never fans out per object. A
scheduled backstop can wake the same shard but cannot resolve product data.
Regional Services remains the browser/user-ingress primitive; it is not used to
regionalize internal subrequests
([Workers data localization](https://developers.cloudflare.com/data-localization/how-to/workers/)).

The wake Worker is configured with only the shard namespace. The shard
namespace, regional D1/R2, and target namespaces must share the promised
jurisdiction. If Cloudflare cannot contractually guarantee any leg, that
region's background migration is disabled. There is no Global product binding
or fallback route.

This design still requires contractual confirmation that the complete
Cloudflare configuration satisfies Avalon's EU promise. If it does not, EU
migration is disabled rather than moved to an external or Global runner. The
residency claim is intentionally about sensitive processing and data: the exact
allowlisted campaign/shard wake fields above may execute outside the EU because
they identify no customer or product resource.

## Fleet inventory

Regional D1 remains justified here because fleet pagination, version queries,
cohort selection, error aggregation, leases, and parent/child reconciliation
are cross-object SQL workloads. It is an operational directory, not product
authority.

### Workspace inventory

One row per allocated `WorkspaceDO` contains:

- opaque regional `workspace_key` and deterministic/opaque object ID;
- class, jurisdiction, allocation and retirement epochs;
- observed Worker version ID, protocol version, schema version, data version,
  and projection version;
- child count and a coarse, asynchronously reported storage/row-size bucket;
- last object report time and last product-touch time;
- coarse busy flags such as active connections, active runs, or deletion in
  progress, without member identities;
- target campaign/version, current job phase, lease expiry, cursor, attempts,
  verification result, and enumerated error code; and
- the last child-directory reconciliation generation.

### Work-stream inventory

One row per allocated `WorkstreamDO` contains:

- opaque regional `workspace_key`, `workstream_key`, and object ID;
- class, jurisdiction, origin authority epoch, and retirement epoch;
- observed Worker/protocol/schema/data/projection versions;
- coarse part, substream, content-byte, and object-storage buckets;
- last object report time and last product-touch time;
- coarse active-run, active-socket, compaction, deletion, or migration-fence
  flags;
- campaign, phase, lease, cursor, attempts, verification hashes, and enumerated
  error code; and
- parent-registration generation and last acknowledged parent contract version.

The inventory deliberately excludes product titles, descriptions, lifecycle
state, last-people-activity timestamps, users, mentions, seen waterlines,
unread counts, suggested work, and suggested actions. Those remain in the
`WorkspaceDO`/`WorkstreamDO` authorities described by the PRD. An operator can
select a cohort by hash, version, size bucket, age, region, class, or coarse busy
state without acquiring sidebar or transcript content.

### Inventory maintenance

Allocation, registration, retirement, successful schema migration, and
meaningful size-bucket changes append a product-free regional inventory outbox
item. The fleet-inventory Queue delivers that idempotent update to D1; the
connector-activity Queue instead resolves one `WorkspaceDO` and never writes a
D1 product row.
The `WorkspaceDO` directory is the authoritative parent-to-child relationship;
the D1 row is its fleet projection.

Objects also report their observed versions when they are touched by a normal
request or migration command. This makes lazy schema convergence visible
without periodic wakes. A regional reconciler compares:

1. D1 workspace rows with existing workspace allocation receipts;
2. D1 work-stream rows with paged `WorkspaceDO` directory generations; and
3. in a privileged deployment/operator job only, regional directory object IDs
   with the Cloudflare namespace-list API.

The namespace audit tolerates creation/deletion during pagination and converges
over later passes; it does not assume a fleet-wide snapshot. Administrative
Cloudflare credentials stay in the deployment environment and are never stored
as Worker variables.

## Migration manifest and state machine

Every campaign has an immutable, signed manifest containing:

- campaign ID, object class, compatible source range, and target code,
  protocol, schema, data, and projection versions;
- hash of each migration implementation and R2 input manifest;
- migration kind: `class_lifecycle`, `schema_lazy`, `schema_sweep`,
  `online_backfill`, `authority_copy`, or `cleanup`;
- compatibility window for parents, children, clients, executors, and source
  stores;
- region allowlist, stable-hash cohort definitions, concurrency, batch size,
  CPU/wall-time budget, and retry policy;
- preflight, per-object verification, cohort verification, and completion
  predicates;
- error-rate, latency, Queue-depth, cost, and data-mismatch pause thresholds;
- whether a PITR bookmark is required and the point after which recovery is
  forward-only; and
- approver, retention, and cleanup requirements.

The fleet campaign moves through:

```text
draft -> preflight -> expand_deployed -> canary -> ramping -> verifying
      -> committed -> cleanup_eligible -> complete
```

`pausing`, `paused`, `aborting`, and `needs_intervention` are side states. The
manifest fixes a finite regional shard set before a cohort starts. Each
`MigrationShardDO` is the sole admission authority for its shard and issues a
bounded, expiring, single-use permit before target RPC. A permit records shard,
campaign, epoch, target, command, budget, admission time, and deadline. Issuance
and the shard's in-flight count change in one shard transaction. A target may
start only with a current, unexpired permit and records its idempotent command
receipt before reporting settlement to the shard.

Pause first changes regional state to `pausing` and advances the desired epoch.
`RegionalMigrationDO` then sends that epoch to every manifest shard. Each shard
atomically stops issuing permits, records the epoch, and reports the permits
already admitted. Those bounded slices may settle or expire. The regional state
becomes `paused` only after every shard acknowledges the epoch and has no live
permit. This is the pause linearization point: nothing starts after the
**paused acknowledgement**, although work admitted before the pause request may
start and settle while state is visibly `pausing`. Stale Queue wakes cannot do
work because the shard itself is fenced. Resume advances the epoch again and
waits for shard acknowledgement before admission.

Abort is permitted only while the manifest still defines a safe old authority.
After an authority-copy cutover or destructive transform, recovery is forward
repair or quarantined object-local PITR, never silent routing back to a stale
writer.

The campaign Workflow performs phase-level orchestration and sleeps between
aggregate checks. A Queue wake calls a migration shard, which uses regional D1
transactions to claim a bounded page of eligible jobs and issues permits under
its local ceiling. An object-level retry is delayed without repeating another
object's work. Object journals and shard permits, not Queue acknowledgement or
delivery order, determine progress.

One scheduled backstop emits only manifest-shard wake hints for campaigns whose
aggregate heartbeat is stale. Only the jurisdictional shard may inspect D1,
reconcile expired permits, or claim product jobs. The backstop does not
enumerate product objects or wake dormant objects when no campaign is active.

## Durable Object class lifecycle versus object data

Cloudflare class declarations provision, rename, transfer, or delete a
namespace. They are not row or data migrations. Cloudflare's current
declarative `exports` mechanism is the preferred lifecycle interface; it
replaces legacy Wrangler migration arrays, cannot be mixed with them, and a
Worker cannot switch back after adopting it. Storage backends are immutable
([Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)).

Avalon separates the frequently deployed stateless regional router from the
more stable stateful Worker that exports `WorkspaceDO` and `WorkstreamDO`. This
lets router releases use Workers deployment primitives without needlessly
restarting every stateful socket. The stateful Worker uses explicit class
lifecycle releases and a versioned N/N-1 RPC and WebSocket protocol.

Before adopting `exports`, the existing legacy declaration is converted in a
dedicated no-product-change release and verified in both regions. New classes,
renames, transfers, and especially deletions then occur in isolated lifecycle
releases. A namespace deletion permanently destroys its data. No lifecycle
release is combined with a data transform, authority cutover, or cleanup.

Worker versions do not version DO, D1, or R2 data, and a Worker rollback does
not restore storage. Rollback cannot cross a class-lifecycle change
([Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/),
[Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)).
All migrations therefore use expand/contract and keep old code capable of
reading the expanded representation throughout its rollback window.

## Per-object schema and data migration

Every `WorkspaceDO`, `WorkstreamDO`, `FleetMigrationDO`,
`RegionalMigrationDO`, and `MigrationShardDO` owns the common
`object_versions`, `durable_outbox`, `durable_inbox_receipts`, `due_work`,
`_sql_schema_migrations`, `_data_migrations`, and
`_migration_command_receipts` tables specified in the PRD. Product objects add
their workspace/work-stream domain tables; control objects add their fleet,
regional, or shard state tables. A target object's `_data_migrations` and
`_migration_command_receipts` remain authoritative for its own transformation;
an upper control object, regional D1 row, Workflow step, or Queue message cannot
substitute for them.

Cloudflare does not support `PRAGMA user_version` in Durable Object SQLite.
Small schema changes run in the constructor under `blockConcurrencyWhile` and
are tracked in `_sql_schema_migrations`. The implementation may use the
Cloudflare Actors package's storage migration utility without adopting the
Actor base class, routing layer, persistence decorators, or lifecycle framework.
That narrow utility is accepted only behind Avalon's migration interface and
conformance tests; the current Actors repository describes itself as under
active development ([Cloudflare Actors](https://github.com/cloudflare/actors),
[Durable Object schema guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)).

Constructor migration is limited to fast, local, idempotent DDL such as creating
a table, adding a nullable/default-safe column, or creating a proven-small
index. It must not scan a transcript, fetch another service, wait for a run, or
perform a fleet backfill. `blockConcurrencyWhile` blocks the object and has a
finite timeout, so constructor performance is a canary and load-test gate.

For heavier work, every object exposes internal, authenticated RPC methods:

```text
inspectMigration(campaign_id, target_version)
applyMigrationSlice(command_id, target_version, expected_phase, budget)
verifyMigration(command_id, target_version, expected_hashes)
commitMigration(command_id, target_version)
```

Each call validates the shard-issued, expiring admission permit and the object's
local journal, returns the recorded result for a duplicate command, and rejects
a different body under the same command ID. A slice is bounded by rows, bytes,
and CPU, stores its next cursor and checksum in the same object transaction, and
returns `done`, `continue`, `defer_busy`, or an enumerated terminal error. The
shard schedules a later wake for `continue` or `defer_busy`; the product object
never schedules a permanent self-wake merely to satisfy a fleet campaign.

### Add a column or table

An easy change uses this sequence:

1. Deploy code that tolerates the old schema and contains an idempotent
   constructor migration.
2. Mark the campaign `schema_lazy`. Each object migrates before serving its
   first event under the new code and reports the version asynchronously.
3. Do not wake the whole fleet merely to create an empty table or nullable
   column. The code invariant is "migration before request," not "all dormant
   objects were billed during deploy."
4. If an operational, compliance, or contract gate requires full convergence,
   explicitly change the campaign to `schema_sweep` and visit objects in
   bounded cohorts.

### Transform or backfill local data

A nontrivial transform uses expand/contract:

1. Expand schema and deploy code that reads old and new shapes and dual-writes
   the fields whose meaning changes.
2. Run restartable slices, storing a stable primary-key cursor and rolling
   checksum in `_data_migrations`.
3. Defer a hot object with an active run or sensitive tool boundary rather than
   holding its event loop for a large slice. Ordinary user messages and socket
   delivery continue between slices.
4. Verify counts, hashes, foreign-key/turn invariants, parent projection parity,
   and a sample model projection.
5. Atomically advance the object's committed data/projection version.
6. Stop old writes only after the fleet compatibility gate passes.
7. Remove old columns/tables in a later cleanup campaign after the code rollback
   and PITR windows.

SQLite operations are strongly consistent and private to one object. A paid
SQLite-backed object currently has a 10 GB limit, while one row/string/BLOB is
limited to 2 MB; product high-water marks remain materially lower
([SQLite-backed DO storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).

### Move data from D1, R2, or another database

There is no platform bulk loader into every object's private SQLite database;
the object applies its own import. D1 is the old product authority and also the
single cutover gate; route, hold state, and source writes are never independent
systems. Every legacy writer named in the enforced writer registry must use one
regional D1 transaction that reads the applicable
`workstream_authority(resource_key, epoch, state, target, final_hold_seq,
prepared_hash)` or same-shaped `workspace_authority` row and then either mutates
the old tables plus outbox or inserts a stable command in
`migration_ingress_hold`. Connector migration never reuses either row: it has a
separate D1 `connector_authority` domain gate because `workspace_authority` may
already route membership/sidebar traffic to the parent. There is no unchecked
legacy write path.

The regional D1 connector-cutover tables are deliberately narrow:

| Table | Fields and constraints | Contract |
| --- | --- | --- |
| `connector_authority` | `workspace_key TEXT PRIMARY KEY`, `epoch INTEGER`, `generation INTEGER`, `state TEXT CHECK IN ('legacy','holding','closing_hold','do','quarantined')`, nullable `target_workspace_do_id TEXT`, nullable `final_hold_seq INTEGER`, nullable `prepared_hash TEXT`, nullable `route_receipt_hash TEXT`, `updated_at TEXT`; unique `(workspace_key,epoch,generation)`. | Sole legacy connector-domain writer/route gate. It is independent of `workspace_authority`; state `do` requires target, final sequence, prepared hash, and route receipt. Product fields, credentials, activity, and member data are forbidden. |
| `connector_migration_holds` | Composite primary key `(workspace_key,epoch,hold_seq)` with `workspace_key TEXT`, `epoch INTEGER`, `generation INTEGER`, `hold_seq INTEGER`, `command_id TEXT UNIQUE`, `command_kind TEXT`, `request_hash TEXT`, exactly one bounded `payload_json TEXT` or regional `payload_ref TEXT`, `payload_hash TEXT`, `status TEXT CHECK IN ('held','imported','settled','returned_to_legacy')`, nullable `target_receipt_hash TEXT`, `created_at TEXT`, `updated_at TEXT`; unique `(workspace_key,epoch,request_hash)`. | Finite connector journal while `holding`. Insert and legacy authority check occur in the same D1 transaction. `closing_hold` forbids insertion; every sequence through `final_hold_seq` must have a target receipt before route CAS. |
| `connector_route_receipts` | Composite primary key `(workspace_key,epoch,generation)`; `target_workspace_do_id TEXT`, `final_hold_seq INTEGER`, `prepared_hash TEXT`, `route_receipt_hash TEXT UNIQUE`, `committed_at TEXT`. | Immutable result of the one `connector_authority` compare-and-set. Regional routing carries this opaque receipt to the target; it contains no connector or workspace product metadata beyond opaque routing keys. |

The same protocol moves the newly parent-owned connector domain. For that
campaign, the fenced resource is the workspace and the source snapshot/tail
includes connector sources, encrypted credential envelopes and rotation
versions/leases, normalized selector/principal ACL snapshots, poll cursors,
ingress receipts, normalized
activities/effects, ordered activity events/targets, digest state,
opportunity/provenance/user state, suggestion rankings, promotion receipts, and
child-feedback receipts. Existing workspace-prefixed R2 bodies remain in place
and their references/hashes are verified; they are never re-keyed into or
deduplicated with another workspace. Provider ingress, polling, activity reads,
digest claims, ranking, and promotion all pass through the one
`connector_authority` row so they cut over together rather than leaving D1 and
`WorkspaceDO` as continuing co-authorities.

Because membership/sidebar may already be live in this same object, connector
cutover does **not** rely on the whole target being hidden. The target's
singleton `connector_domain_authority` is an independent product-domain gate.
During import it is `legacy_shadow`: ordinary parent APIs remain live, but every
connector ingress/read, credential refresh, poll, digest, rank, notification,
replay, and background effect rejects that generation. `prepared` preserves
the verified final hold sequence/hash with the same prohibition. The external
D1 `connector_authority` CAS produces the route receipt; a request carrying that
receipt atomically changes only this singleton to `open`. Every imported
connector row, due job, outbox command, Queue envelope, and Workflow claim is
generation-stamped and must equal the open singleton. Thus the live parent can
hold old membership authority and a shadow connector domain without exposing or
executing shadow activity.

An authority-copy campaign uses this crash-safe protocol:

1. While state is `legacy`, take an immutable or revision-stamped source
   snapshot, store hashed large chunks in regional R2, and continue normal
   source mutations plus an old-writer outbox in the same D1 transactions.
2. Import the snapshot and tail through a recorded outbox high-water mark into
   a hidden, side-effect-free target generation. For connector-domain migration,
   “hidden” means the live parent's `connector_domain_authority=legacy_shadow`,
   not an unreachable workspace object. Verify counts, hashes,
   message-array projection, sidebar projection, activity-log sequence/cursors,
   suggestion-set fingerprints, source epochs, and authorization floors as
   applicable to the target class.
3. In one D1 transaction, compare the old epoch and change `legacy -> holding`
   while advancing the authority epoch. From that point a current writer
   inserts its complete command into the authority's hold journal—
   `connector_migration_holds` for the connector domain, otherwise
   `migration_ingress_hold`—instead of the old product tables and returns an
   explicit `accepted_pending_migration` receipt.
   A writer that observed the prior epoch fails and retries through the gate.
4. Replay the remaining old outbox and held commands, in stable ID/sequence
   order, into the target generation. Duplicate import returns the existing
   receipt and never repeats an effect.
5. Change `holding -> closing_hold` in D1 and record the final hold sequence.
   New ingress receives bounded backpressure and is **not acknowledged**; its
   client/provider retains the stable request ID and retries. Import and verify
   every held command through the final sequence, producing a target
   `prepared_hash`.
6. Call idempotent `prepareAuthority(epoch, final_hold_seq, prepared_hash)`.
   The whole-object target records `prepared`; a live workspace parent records
   those values in `connector_domain_authority.state='prepared'`. In both cases
   the prepared domain still cannot use credentials, poll, run tools, digest,
   rank, notify, publish/read activity, accept external ingress, or deliver an
   effect.
7. In one D1 compare-and-set, require the matching epoch, `closing_hold` state,
   final sequence, and prepared hash, then publish state `do` plus the target
   route and insert its immutable route receipt. Connector campaigns mutate
   `connector_authority` plus `connector_route_receipts`; they do not touch the
   already-live `workspace_authority` route. This CAS is the sole external
   authority cutover. There is no
   post-route held-item release: every acknowledged held item was already
   imported and verified.
8. The router's first direct request carries the committed route epoch/receipt;
   the target atomically opens that prepared epoch before applying the request.
   For an already-live parent this changes only `connector_domain_authority` and
   requires the exact generation, final hold sequence, prepared hash, and D1
   route-receipt hash. A first routed retry with the same receipt returns the
   open result; another receipt is corruption.
   A lost post-CAS notification is therefore repaired by normal ingress or a
   regional reconciliation command. Background effects remain paused until the
   same route receipt opens the epoch.
9. Retain the source, outbox, hold, route receipt, and target import receipts
   through the rollback/audit window. Cleanup is a later campaign.

If the campaign aborts before route CAS, it replays held commands back through
the legacy writer transaction using their stable IDs, verifies the last hold
sequence, and changes the D1 row back to `legacy`; clients then receive their
settled results. A crash before route CAS leaves the target unreachable and
side-effect-free. A crash after route CAS finds every acknowledged pre-cutover
write already in the target, and retrying a backpressured write goes directly to
the target. The protocol never asks two databases to atomically commit and
never describes `release after route` as correctness.

The imported generation stays side-effect-free until the route receipt opens
its prepared epoch. If the source is D1, application-level paging and an outbox
are the live protocol. Wrangler D1 export is an operator backup/bootstrap tool, not CDC;
Cloudflare documents that export blocks other database requests
([D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)).

If a source database cannot be queried within Workers limits, it must first
produce immutable exports into the regional R2 ingest boundary. Avalon does not
introduce a permanent external migration runner. A bounded Cloudflare Container
may transform a chunk when the runtime truly requires it; it receives an opaque
job and R2 references, checkpoints in regional D1, scales to zero, and never
owns routing or product truth. Cloudflare Containers stop accruing runtime
charges after sleeping ([Containers pricing](https://developers.cloudflare.com/containers/pricing/)).

### Workspace-before-work-stream compatibility

Parent and child schema convergence is not enough; their wire contract is also
versioned. Every projection, authorization, directory, revocation, and migration
RPC envelope carries `contract_version`, `sender_schema_version`, a complete
replacement key, and an idempotency ID.

Expand the `WorkspaceDO` receiver first so it accepts the old and new child
projection forms. Then migrate parents, then children. A child publishes only a
form the parent has acknowledged it supports. Contract removes the old form
only after regional inventory proves every parent and child has crossed the
minimum version. A delayed old outbox remains parseable or is rejected into a
typed reconciliation path; it is never partially applied.

## Recovery and rollback

Before a destructive per-object phase, the regional controller records the
object's current SQLite PITR bookmark in its regional recovery ledger; the
bookmark must not exist only inside the database that it identifies. SQLite-
backed Durable Objects can restore the whole embedded database to a bookmark
from the preceding 30 days. Restore is an explicit, object-local emergency
operation; Cloudflare documents no atomic fleet restore or fleet restore-rate guarantee
([SQLite PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).

PITR restores the **whole** object database, including cached grants, authority
and scope epochs, deletion/listing floors, receipts, and migration journals. It
is therefore never invoked merely after pausing a campaign. The regional route
controller first installs a higher `restore_generation` and `quarantined`
state outside the target in regional D1. All public routers, run-host adapters,
parent-to-child calls, migration shards, provider ingress, and repair paths must
honor that route state. `WorkspaceDO` also removes a child from grant issuance,
advances its child authority/listing/deletion floors, marks its card `restoring`,
and closes the child's sockets before restore. A `WorkspaceDO` restore similarly
quarantines the whole workspace route and every child grant path.

After restore, only a least-privilege recovery RPC may reach the object. It
reinstalls the external `restore_generation`, current authority, membership,
scope, listing, and deletion deny floors; replays and verifies every accepted
post-bookmark command from a manifest-named complete recovery source; reconciles
parent/child projections; rotates grants; and invalidates every pre-restore run
epoch and socket attachment. A fenced regional CAS reopens the route only after
all checks pass. Until then product ingress is rejected without acknowledgement
and retained/retried by its caller.

The unified Durable Object alarm is a separate ingress path: it wakes the object
directly and does not traverse the regional route or parent grant. Therefore the
first action in every `alarm()` handler is a fail-closed lookup of that opaque
object ID in the regional recovery ledger. If the external row is quarantined,
or its `restore_generation` is newer than local storage, the handler executes no
tool, run, notification, projection, outbox, compaction, deletion, or retry. It
transactionally marks the restored local due schedule suppressed for that
generation and returns without rescheduling stale work; the recovery RPC later
rebuilds the safe unified schedule from reconciled state. An unavailable fence
lookup throws/retries without product side effects. Compatible recovery code
performs the same check under `blockConcurrencyWhile` before accepting any
direct recovery event, so an alarm racing the first post-PITR constructor cannot
observe pre-quarantine authority. This external alarm check is a deliberate
low-frequency D1 dependency; ordinary user and token traffic still do not read
D1.

PITR is unavailable if Avalon cannot prove a complete post-bookmark replay
source. During authority migration that source is the retained old source,
outbox, hold, and target receipts. For low-frequency workspace membership,
role, deletion, and other security mutations, acknowledgement requires a stable
command receipt in the regional recovery ledger so a parent restore cannot
resurrect revoked authority. This ledger is replay evidence, not a read-path
membership authority. Ordinary post-migration transcript traffic is not
duplicated indefinitely merely to make PITR convenient; after its retained
recovery source expires, repair-forward is the supported recovery unless a
separate complete regional archive has been deliberately enabled.

Recovery rules are:

- before cutover, discard or repair the shadow generation and leave the old
  authority active;
- during compatible expand/dual-write, roll code back only to a version that
  understands the expanded schema;
- after data-version or authority commit, repair forward by default;
- use object PITR only with an externally recorded, operator-approved bookmark,
  installed route quarantine, current export, and a proven complete source for
  post-bookmark accepted writes;
- never restore or reopen an object's pre-revocation authority, listing, scope,
  deletion, socket, or run epoch;
- never execute a restored alarm or local due-work item until the external
  restore generation is reconciled and the recovery RPC rebuilds its schedule;
  and
- never use a Worker rollback as evidence that storage rolled back.

Deleting or renaming a Durable Object class is a separate lifecycle campaign.
Deleting a class never serves as object cleanup.

## Realtime topology

### One workspace socket and one foreground child socket

The desktop holds at most:

- one hibernatable `WorkspaceDO` WebSocket for the currently selected workspace;
  and
- one hibernatable `WorkstreamDO` WebSocket for the foreground-open work stream.

It does not keep a child socket for every running, unread, mentioned, or pinned
work stream. Background run state, completion, errors, unread/mention facts, and
needs-input changes reach the workspace parent through the durable child
projection protocol and then the one parent socket. Tokens never route through
the parent. When a foreground work stream closes or the app enters background,
the child socket closes after a short grace. Reopening uses the durable cursor
and active-output snapshot.

The workspace socket sends one item dictionary plus named collection references
for both the sidebar and main-screen work-streams-of-interest view. Common child
facts include title, description, last people activity, lifecycle state, and
attention ordinal. Sparse personal facts include seen/unread, latest valid
targeted mention, needs-input assignment, and other principal-scoped interest.
Pins and collection ordering remain parent-owned. A child sends complete
per-key common or affected-person replacements; the parent derives **Work
Streams**, date/recency, **In Progress**, **Completed**, **Error**, **You Are
Mentioned**, unread, and interest collections.

Child-to-parent delivery uses persisted outbox plus RPC, not a DO-to-DO
WebSocket. The child commits the source fact, `projection_keys` version, and
immutable `durable_outbox` row together, then calls the parent after commit. An
unsent older complete replacement may be marked superseded; sent/ambiguous rows
retain their message identity. The parent commits `durable_inbox_receipts`,
`child_projection_keys`, the `workstream_cards` or
`member_workstream_state` replacement, and `workspace_events` together. Only
after that receipt returns does the child mark its outbox row acknowledged. A
failed call uses `due_work` and the object's one native alarm. This wakes the
parent only for semantic sidebar changes, not token deltas.

### Hibernation and background cost

Both objects use `ctx.acceptWebSocket`, serialized attachments,
`ctx.getWebSockets`, and a static `setWebSocketAutoResponse` pair. Hibernation
keeps clients connected while removing the object from memory; idle hibernatable
connections do not accrue Duration charges. Incoming application messages are
billed at a 20:1 request ratio, outgoing messages are not request-billed, and
auto-responses avoid duration but do not justify high-frequency application
heartbeats ([WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
[Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).

Foreground liveness uses one static application ping handled by auto-response
at an interval established by NAT, desktop, and mobile tests. It is measured in
minutes, not a 45-second default unless tests prove that necessary. In the
background, the app stops application-level heartbeat traffic. It may retain
the one hibernating workspace connection for push-like interest changes; if the
network drops it, reconnect waits until an OS close signal, relevant
notification need, or foreground resume. Reconnect backoff pauses while the
device is offline or asleep. There is no two-to-three-minute token rotation or
intentional reconnect timer.

The short-lived socket ticket authenticates only the handshake. Its expiry does
not expire an established socket. Authorization epochs and material-event
rechecks revoke a socket when required.

Socket attachments carry only a versioned connection ID, principal/session
reference, authorization epochs, subscription kind, and last acknowledged
cursor, within the platform attachment bound. Constructor code accepts N and
N-1 attachment/envelope versions. A truly incompatible protocol sends one
`reconnect_required` control message after durable state is safe; it never
creates a periodic reconnect loop.

Cloudflare may restart objects during code updates and does not provide a socket
drain guarantee. Stateful Worker deployments are deliberately less frequent
than router deployments. Every disconnect uses jittered retry and
`resume_after`; the object replays retained events or sends a snapshot/reset at
one new cursor. Deploy-induced reconnect storms are a canary and load-test gate.

## Inference, frames, and durable output

The `WorkstreamDO` is active while it handles provider/executor batches,
persists checkpoints, or broadcasts frames. Hibernation saves cost during quiet
tool intervals and after the run; it does not make active generation free. The
generic run host remains a Cloudflare Workflow. When Bind selects Terminal, it
calls Avalon's existing Daytona-backed plugin and sends only bounded output and
settlement events through the same owner protocol; neither Daytona nor the run
host receives browser WebSockets or conversation authority.

For each active run, the Workflow step executing Bind opens an authenticated
internal `run-control` WebSocket to that run's `WorkstreamDO` and retains the
client half beside the provider/tool `AbortController`. The DO accepts the
server half with hibernation and attaches only run, attempt, revision, and
protocol identifiers. A committed steering request wakes the owner if needed;
the owner sends `interrupt(run_id, attempt_epoch, new_revision)` over that
socket, and the executor invokes provider or tool cancellation only when the
adapter declares it safe. This is a best-effort latency path, not the safety
authority. Loss of the socket may delay cancellation until the next durable
boundary, while stale-output rejection and atomic owner-side tool admission
still prevent superseded work from beginning. A Workflow event coordinates
durable phase changes but cannot abort a currently running step.

The executor half is an outbound WebSocket and does not hibernate. It exists
only while a Workflow step already has a live provider/tool operation that can
be cancelled, and closes at termination or before entering a passive
`waitForEvent`; it never stays open for an idle user or a dormant run. The
`WorkstreamDO` server half can hibernate. If no operation is running, there is
nothing to abort: the durable steering event controls the next Workflow step.
If a detached tool runs in a Container, its adapter must expose the same
addressable cancel/settle contract or declare cancellation unavailable.

### Full loop duration and durable step boundaries

A full agent loop—not one model turn—normally lasts two to thirty minutes and
can rarely exceed two hours for coding/research. One generic Workflow instance
spans that lifetime. It is a durable state-machine driver, not a single long
`step.do`: provider request, model-result commit, each admitted tool occurrence,
tool settlement, compaction, reconciliation, and terminalization are
deterministically named boundaries backed by owner receipts.

Cloudflare currently documents unlimited wall time per Workflow step and says
an instance can run indefinitely while it remains within CPU and step limits.
The full verified Workers Paid table is normative in `prd.md`. In particular,
the defaults are 30 seconds of active CPU, 10,000 steps, and 10,000 subrequests;
the configurable maxima are five minutes, 25,000, and 10,000,000 respectively.
Each instance is limited to 1 GB of persisted state including streamed output,
and each event and non-stream step result is limited to one MiB. `step.sleep`
does not consume the step count and may last up to 365 days. Creation and
restart share limits of 300 per second per account and 100 per second per
Workflow; overflow returns HTTP 429, and at most 2,000,000 instances may be
queued. Completed Workflow state and logs last 30 days, so they are not product
history. Cloudflare's authoring guidance nevertheless requires configured step
timeouts no greater than 30 minutes and recommends `waitForEvent` for longer
waits
([Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/),
[Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)).

Waiting instances do not consume running concurrency. Cloudflare's Paid table
currently publishes 50,000 running instances per account while prose on the
same page still says 10,000. Release configuration records the account-confirmed
value, uses 10,000 as the conservative planning ceiling until Cloudflare
clarifies the discrepancy, and sets a lower product admission cap. A platform
queue is a pressure valve, not a user-facing start SLO.

Provider and attached-tool steps therefore have explicit timeouts of at most 30
minutes. Bind invokes the existing Daytona-backed Terminal plugin; it never runs
a shell in the Workflow or `WorkstreamDO`. The complete two-hour coding case is
many model iterations and bounded tool calls, not one two-hour command. Terminal
commands default to two minutes and cap at fifteen minutes, leaving room inside
the Workflow step for sandbox acquisition and receipt reconciliation. Stable
tool occurrence/effect identity lets a retry observe the existing Daytona
command and settlement rather than blindly starting another.

A Terminal timeout, cancellation, or output limit is itself a settled tool
result with partial output and possible filesystem effects. The resumed loop
inspects filesystem/Git/provider state before another command. This design adds
no detached daemon, background process, PTY, or longer per-command limit to
Terminal. Daytona workspace lifecycle, persistence, active-command keep-warm,
idle retention, egress, credentials, EU availability, and cost remain governed
by the separate Terminal subsystem. Whether the app is foreground, background,
or closed does not extend a Workflow step or Daytona lease.

For non-Terminal operations that legitimately exceed a 30-minute attached step,
event delivery remains a wake-up rather than authority: an event sent before the
wait, delivered twice, or lost to retry cannot lose the owner settlement. While
waiting there is no outbound run-control WebSocket; while an operation is
actively attached, that socket carries best-effort cancellation.

Workflow step state contains only operation IDs, hashes, counters, cursors, and
owner/R2 references. Transcript text, streamed Terminal output, artifacts, and
permanent audit remain in the domain owner or regional R2. Loop admission
budgets elapsed/idle time, model iterations, tools, tokens, cost, bytes,
children, Workflow steps, subrequests, and retries below their configured
limits with a terminalization/recovery reserve. Capacity planning uses measured
arrival rate multiplied by active duration, including the rare two-hour tail;
passive waits release their running-instance slot. Regional admission also
stays below account/per-Workflow creation and restart rates and imposes a much
smaller product queue count and age than the platform maximum.

This is a required refactor from the current repository: today
`WorkstreamLoopWorkflow` puts `runWorkstreamHarness` inside one
`run-authorized-bind-loop` step and configures a one-year timeout. Before
cutover, Bind must expose checkpoint/resume or next-action boundaries. The
monolithic step is technically allowed by unlimited wall time, but is rejected
because a runtime failure can replay too much work, a two-hour loop occupies one
running slot continuously, and its timeout contradicts Cloudflare's authoring
guidance.

Three cadences are deliberately independent:

1. **Provider tokens.** Bind may yield tokens as fast as the model produces
   them.
2. **Executor and UI batches.** Flush the first token immediately so ordinary
   one-to-five-second time to first token is not extended. Then coalesce deltas
   for 50-75 ms by default, never exceeding 30 frames per second, and flush
   immediately at tool, status, steering, reset, and turn boundaries. Ordinary
   tools still surface in seconds; a Terminal operation may last three to five
   minutes with expected p95 below one minute.
3. **Durable checkpoints.** Update a mutable active tail every 250-500 ms while
   observed, more slowly up to a measured one-second target without a foreground
   observer, or at 4-16 KiB and every semantic boundary, whichever comes first.
   UI frame rate never dictates SQLite write rate.

The exact intervals are load-test outputs, but 33 ms is a hard minimum frame
interval and one streamed token is never one database row. Cloudflare likewise
recommends batching logical WebSocket messages rather than sending many tiny
frames ([WebSocket batching guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).

### Mutable active tail, immutable final parts

Streaming output is operational state until the assistant content segment is
sealed:

```text
active_output_turns(
  run_id,
  attempt_epoch,
  turn_id,
  substream_id,
  durable_event_seq,
  durable_through_frame_seq,
  durable_character_count,
  revision,
  updated_at
)

active_output_chunks(
  turn_id,
  chunk_index,
  text,
  sealed,
  content_hash,
  updated_at,
  primary key (turn_id, chunk_index)
)
```

The executor and owner use two different ordered lanes:

- a provisional frame `(run_id, attempt_epoch, frame_seq,
  base_durable_event_seq)` may be forwarded to the UI but is neither a durable
  receipt nor permission for the executor to discard its text; and
- a durable checkpoint/semantic event `(run_id, attempt_epoch, event_seq,
  through_frame_seq)` contains the complete text delta through that frame plus
  any semantic fact at that boundary.

In one object transaction, the owner applies all text through
`through_frame_seq`, applies the semantic fact if present, and advances both
`durable_event_seq` and `durable_through_frame_seq`. It acknowledges only after
that transaction. A gap or stale attempt is rejected/buffered; a durable cursor
can never get ahead of durable text. Tool calls, tool results, steering cuts,
reset, and terminal events first force a text checkpoint through the preceding
frame and then commit at the same semantic boundary.

The object mutates only the current tail chunk. It seals a chunk around 64 KiB
before opening the next, keeping well below the 2 MB SQLite row/string limit and
avoiding one ever-growing row. The exact chunk size is benchmarked for page
rewrite amplification, row-write billing, PITR growth, and prompt projection.
Tool calls, tool results, steering cuts, and terminal facts commit immediately;
they do not wait for the text checkpoint timer.

The executor retains all frames after `durable_through_frame_seq` and all
semantic events after `durable_event_seq`; a UI-delivery cursor is never used as
a durable acknowledgement. If an object restarts, the client may rewind at
most one configured checkpoint interval, receives the durable active snapshot,
and the executor replays missing sequences. The owner compares frame boundaries
and content hashes, so replay does not append duplicate text. A product
requirement for zero provisional rewind can instead persist before every frame,
but that stronger and more expensive mode is not the default.

That bounded replay contract requires the same executor/provider stream to
survive. If the executor or model request is lost, the provider cannot be assumed
to reproduce a nondeterministic partial stream. The owner transactionally
deletes the incomplete attempt's active chunks, emits `output_reset`, advances
the attempt epoch, and restarts from the last committed provider-valid fence.
Previously committed user input and semantic tool boundaries remain. The user
may lose the entire incomplete assistant attempt from view, but never committed
history, and the old attempt can never finalize later.

On normal completion, one object transaction:

1. flushes and seals the active tail;
2. writes the final immutable `parts` text chunks in provider order;
3. writes the terminal part and durable executor cursor; and
4. deletes the operational active-output rows.

Projection joins adjacent final text parts into the one assistant content
segment expected by the model. There is no mutable final message and no second
duplicate final row. Reset or steering discards only the superseded operational
tail after recording the interrupt boundary; already committed semantic parts
remain immutable.

At 30 storage writes per second, one minute of output would cause 1,800 base-row
writes before index effects. Four checkpoints per second cause 240, so decoupling
display frames from persistence has a material cost effect. Cloudflare's current
SQLite DO billing includes row reads/writes and stored data, making the
checkpoint load test a release requirement rather than premature optimization
([Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).

## Observability and operations

Authoritative status comes from the fleet/regional control objects, regional
D1, and each object's migration journal. Workers observability adds:

- Worker and Durable Object version IDs on every command and receipt;
- structured campaign/region/class/phase/error-code logs without customer
  content;
- traces through opaque Queue wake, jurisdictional shard admission, regional D1
  claim, and object RPC;
- Analytics Engine measurements for slice latency, bytes/rows, Queue delay,
  deferral rate, error ratio, checkpoint size/cadence, socket reconnects,
  hibernation wakes, and projection lag; and
- billing alerts and campaign cost ceilings that pause new admissions.

Analytics and sampled logs are never used to decide that an object migrated.
Cloudflare provides native Worker logs, traces, binding instrumentation, and
metrics for requests, errors, CPU, wall time, and duration
([Workers observability](https://developers.cloudflare.com/workers/observability/)).

The operator surface can start, pause, resume, reduce a rollout ceiling, abort
when safe, retry a bounded failed cohort, verify, and authorize cleanup. It
cannot edit an object's migration cursor or mark an object successful by hand.
Repairs are new idempotent commands with immutable receipts.

## Release sequence

1. Split the stable stateful DO service from the frequently deployed regional
   router, retaining versioned service-binding and WebSocket envelopes.
2. Install regional fleet directories and allocation/retirement/version outbox
   reporting for existing and new objects.
3. Deploy fleet/regional control objects, jurisdictional migration shards,
   campaign Workflow, opaque shard-wake Queue/DLQ, regional R2 manifest format,
   and scheduled stale-campaign backstop. The wake Worker has no product
   binding.
4. Convert legacy class declarations to declarative `exports` in an isolated
   parity release, then add the SQLite-backed `WorkspaceDO` and `WorkstreamDO`
   namespaces in a separate lifecycle release.
5. Canary constructor DDL on synthetic and large fixture objects; prove it stays
   within the constructor gate and does not break hibernated socket wake.
6. Run one additive lazy campaign, one explicit sweep, one restartable local
   backfill, and one D1-to-shadow-object authority copy in staging.
7. Verify workspace-before-child contract skew, deploy-induced reconnect/replay,
   `pausing` drain under Queue backlog, DLQ repair, regional failure, and
   quarantined PITR rehearsal.
8. Canary stable-hash production cohorts by region and object class. Global and
   EU campaigns have independent admission and error budgets.
9. Ramp only from recorded verification. Contract old formats and remove old
   storage in later campaigns after rollback, retention, and PITR gates.

## Acceptance criteria

1. A class deployment creates namespaces without instantiating every object.
   An additive schema release migrates a dormant object on first wake, while an
   explicitly requested sweep converges a bounded fleet without an unbounded
   deploy or request spike.
2. Regional D1 can list every known workspace and work-stream object by opaque
   key and versions, and a directory/API reconciliation can identify missing,
   duplicate, retired, and orphaned registrations without product metadata in
   the fleet plane.
3. Duplicate, reordered, delayed, and DLQ-replayed Queue commands produce one
   local migration outcome. Reusing a command ID with different input is
   rejected.
4. Constructor DDL stays below its measured safety threshold on the largest
   supported object. Large transforms never run in the constructor and make
   progress through restartable, checksummed slices.
5. A campaign automatically enters `pausing` when its error, latency,
   Queue-depth, or cost ceiling is crossed. Every fixed shard stops admission
   and reports its admitted permits; state becomes `paused` only after those
   bounded permits settle or expire. No target begins after the paused
   acknowledgement. Stale wakes cannot issue a new permit, and resume neither
   skips nor duplicates a slice.
6. Parent N/N-1 contract support lands before child changes. A delayed old child
   replacement either applies completely under its key/version or reaches typed
   reconciliation; it never corrupts shared or personal sidebar collections.
7. A D1-to-DO authority-copy fixture accepts writes throughout snapshot/import,
   returns explicit pending receipts during `holding`, backpressures without
   acknowledgement during `closing_hold`, imports every final-sequence item,
   prepares the target side-effect-free, and publishes one D1 route CAS. No
   acknowledged item needs release after cutover. Crashes before and after the
   CAS, pre-cutover abort, and post-cutover forward repair are exercised.
8. An EU Queue/Workflow message contains only region, campaign, shard, and wake
   nonce. Its Worker can bind only the EU-jurisdictional migration-shard
   namespace. Only that shard resolves regional D1/R2/object IDs and calls
   jurisdictional product objects; Regional Services is not claimed to localize
   Worker subrequests. Unsupported residency fails closed. Cloudflare's
   documented out-of-jurisdiction logging of opaque DO IDs is separately
   inventoried and contractually/legal reviewed; Avalon-controlled Global data
   and application logs contain no object mapping or product fact.
9. An idle foreground workspace socket hibernates without Duration billing. A
   background client generates no application heartbeat loop, and neither
   workspace nor work-stream sockets are intentionally replaced every two to
   three minutes.
10. Only the selected workspace and foreground work stream have live sockets.
    Background completion, error, mention, unread, and needs-input changes reach
    sidebar and interest views through the parent projection without child
    token fan-out.
11. A stateful deployment may disconnect sockets, but jittered reconnect plus
    cursor replay/snapshot reset produces no lost acknowledged message,
    duplicated final response, regressed waterline, or reconnect storm above the
    published envelope.
12. First token is flushed immediately after the normal one-to-five-second model
    wait; later output never exceeds 30 UI frames per second. Ordinary tool
    seconds and a three-to-five-minute Terminal tail remain interruptible under
    the PRD's safe-boundary rules.
13. Streaming storage tests hold UI delivery at no more than 30 fps while
    independently comparing 250-ms, 500-ms, and one-second mutable-tail
    checkpoints. The selected policy publishes billed
    rows, index writes, latency, fragmentation, PITR growth, failure rewind, and
    upstream replay results at representative concurrency.
14. A durable acknowledgement advances only in the transaction that stores all
    text through its `through_frame_seq`. A crash between checkpoints rewinds
    only the configured provisional window when the executor survives; executor
    or provider loss instead emits one reset and discards the whole incomplete
    attempt before starting a new epoch. Finalization leaves immutable `parts`
    and no duplicate active or final message.
15. A PITR rehearsal records its command/bookmark outside the target, installs
    route and parent-grant quarantine before restore, proves a complete
    post-bookmark replay source, reinstalls current authorization/deletion/run
    floors, and reopens through a fenced CAS. A restored alarm is forced to fire
    before the recovery RPC and produces no tool, notification, projection,
    outbox, compaction, deletion, or run effect. Without that proof it fails
    closed and repairs forward.
16. Representative two-minute and thirty-minute loops plus a fault-injected
    two-hour coding loop use one Workflow instance and multiple deterministic
    model/tool/reconcile/wait steps. Restarts and duplicate/lost wake events
    recover from owner and Daytona Terminal receipts without repeating an
    external write, losing accepted input, or creating a duplicate final answer.
    An interrupted model stream resets its incomplete attempt rather than
    claiming exact replay. No configured step timeout exceeds 30 minutes; every
    Terminal command stays within its fifteen-minute product cap.
17. Load tests publish full-loop active/waiting duration, step/action counts,
    subrequests, retries, state/event/result bytes, CPU, concurrent running
    instances, create/restart rate, queue count/age, admission delay, and cost.
    Worst-case permitted actions retain terminalization/recovery reserves below
    the configured step and subrequest limits; every event/non-stream result is
    below one MiB, per-instance state is below 1 GB, and passive waits hold
    neither running concurrency nor an outbound run-control socket. The release
    records the account-confirmed running-instance limit, exercises HTTP 429 as
    non-admission at the published creation ceilings, and proves product state
    survives expiry of the 30-day completed-Workflow history.
18. The workspace/work-stream fleet control and realtime paths require no
    Railway, EC2, external scheduler, external WebSocket hub, or always-on
    migration process in normal operation or documented recovery. Daytona
    remains the separately governed Terminal plugin backend and is never a fleet
    migration authority or browser WebSocket hub.
19. Schema conformance covers the PRD's common tables plus every
    `WorkspaceDO`, `WorkstreamDO`, `FleetMigrationDO`, `RegionalMigrationDO`,
    and `MigrationShardDO` domain table, index, foreign key, shape constraint,
    and migration path. `WorkstreamRoom` and `WorkspaceScheduler` retire only
    after socket/alarm/retry reconciliation; crash symbolication is unchanged.
20. Fault injection across child source/outbox, parent inbox/card-or-overlay/
    event apply, response, and child acknowledgement converges status, recency,
    unread, mention, and needs-input independently. The same receipt rule is
    exercised across fleet-to-regional-to-shard-to-target migration commands;
    no test treats cross-object RPC as one transaction.

## Measurements and contract questions

These values are release gates, not reasons to weaken the ownership model:

1. What constructor DDL/index sizes stay safely below the platform timeout at
   p99, including the largest supported workspace and work stream?
2. What fixed migration-shard count, wake batch, permit ceiling, RPC slice, and
   regional resource limits preserve user-traffic latency and remain below the
   per-object soft request ceiling?
3. What error, mismatch, lag, and cost thresholds pause each cohort, and who may
   resume it?
4. What object-size buckets, last-touch ages, and active-run conditions defer a
   transform?
5. What fleet convergence proof is required before each old protocol, column,
   table, source database, or route can be removed?
6. What restore throughput, external alarm-fence latency/availability, replay
   retention, and reconciliation protocol make object-local PITR a credible
   emergency procedure?
7. What NAT/desktop/mobile interval keeps a foreground socket useful without
   needless billed incoming messages, and should the background workspace
   socket remain open for product notifications on every supported OS?
8. Does the Cloudflare enterprise contract cover jurisdictional migration
   shards, their D1/R2/target bindings, Queue/Workflow wake metadata, logs,
   Analytics Engine, and the optional Container path to Avalon's exact EU
   promise? Regional Services does not cover Worker subrequests; any unsupported
   content-bearing path is disabled.
9. What mutable tail size and 250-1000 ms checkpoint policy minimize row writes,
   SQLite page amplification, prompt-read cost, and user-visible rewind?
10. What reconnect cohort and replay limits protect a region when a stateful
    deployment resets many sockets at once?
11. What two-to-thirty-minute distribution, rare two-hour tail, per-action step
    and subrequest multipliers, retry rate, state/event/result sizes, passive-
    wait ratio, account-confirmed running limit, create/restart rate, queue
    count/age, and regional arrival rate determine Workflow configuration,
    capacity admission, reserves, and loop-wide elapsed, idle, model, tool,
    token, cost, output, and child budgets?
