# Retiring the runtime compatibility layer

> Created 2026-08-22.
>
> Remove the D1→Durable Object cutover compatibility layer — the two routed
> `D1Database` wrappers and the 25 `_runtime_*` views behind one of them — by
> converting each subsystem to a typed object port, in seven slices.
> Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Subsystem references: [`agent-harness.md`](../../agent-harness.md),
> [`terminal-workspaces.md`](../../terminal-workspaces.md),
> [`workstream-durable-object.md`](../../workstream-durable-object.md),
> [`data-model.md`](../../data-model.md).

## Summary

Avalon's product data moved from D1 into Durable Object SQLite during the
regional cutover. The service code did not move with it. Instead, two wrappers
intercept `env.DB`, inspect each SQL string, and forward statements naming a
migrated table to the owning object — and on the work-stream side, rewrite the
table names onto compatibility views whose `INSTEAD OF` triggers translate
between the old D1 shapes and the object's real ones.

This PRD removes both. Each subsystem gains a typed storage class on the object
and a typed Worker-side port, its statements are converted or deleted, and the
views it used are dropped by a new object migration. When the last slice lands,
`withWorkspaceRuntimeDatabase`, `withWorkstreamRuntimeDatabase`,
`rewriteWorkstreamRuntimeSql`, and both `/internal/runtime-sql` endpoints are
deleted, and no service file names a legacy product table in SQL.

Nothing a user does changes, with one deliberate exception: two surfaces
currently render a UUID where a person's name belongs, because they read a
fabricated column. Fixing that is in scope.

## Motivation

The layer was correct while it was load-bearing. One body of code had to run
against both D1 and the object during the cutover, and a translating router is
the cheapest way to get that. The cutover is over:
`0090_drop_legacy_product_tables.sql` refuses to apply to a populated region
unless `workstream_authority_control.phase = 'durable_object_open'`, and it
drops the D1 source tables. Every region that has 0090 is permanently past the
point the layer was built for.

What it costs now is not hypothetical. All four of these have already happened:

**It answers wrong instead of failing.** `_runtime_resources` is a view over
`workstream_resource_links` that fabricates the columns the real table does not
have — `NULL AS content_sha256`, `'ready' AS model_content_status`. A caller
reading `model_content_sha256` gets `NULL` and no error. `_runtime_users`
fabricates `'' AS email` and returns `participant.user_id` as `name`, so
`work-opportunity-service.ts` and `workstream-description-service.ts` both
select `u.name AS author_name` and get a UUID.

**It splits transactions across the Worker boundary.** A load-then-decide
sequence written as two prepared statements crosses an RPC boundary between
them. PR #212 found a Terminal operation lease being granted on state that had
already moved; the fix was making the whole sequence one synchronous call inside
the object.

**It enforces invariants nobody wrote down.** Two of the three defects review
caught in #212 were of this kind. A generation fence was structural, because an
`INSTEAD OF DELETE` trigger fired only per matched row — collapsing two
statements into one typed call silently dropped it. And Terminal writes
published the workspace directory deadline *by accident*, because a regex
matching the table name `workstream_sandboxes` happened to mark the mutation as
directory-affecting; naming the operations properly stopped the publication and
no test noticed, because no test asserted it.

**It freezes the schema, and in one place it has already bent it.** Terminal
could not promote `lifecycle_json` to real columns — with a typed
`archive_due_at` the scheduler could index and sort — until its readers stopped
naming the compat view. Every subsystem still behind the layer has the same
constraint. Worse, the pressure runs backwards too: `runs.legacy_attempt_id` is
a column in the object's own schema that exists *only* so three compat views can
project a text attempt id — `_runtime_harness_runs` and
`_runtime_tool_invocations` as `attempt_id`, `_runtime_messages` as
`harness_attempt_id` — with two `_runtime_harness_runs` triggers writing it. The
object's real attempt identity is the integer `attempt_epoch`. Nothing outside
the compat schema reads or writes `legacy_attempt_id`: it is a second identity
the translation layer put into the authoritative table, and because its three
readers sit in three different slices, it cannot be dropped until slices 1, 4,
and 6 have all landed.

The layer also has no owner and no end date. It is 2,188 lines across five
files, it is invisible in a stack trace until a statement fails inside an
object, and every new query written against the old vocabulary makes it larger.

## Goals

1. No service file names a legacy product table in SQL. Every read and write of
   object-local state goes through a typed port whose operations name what the
   caller wants.
2. Both routed `D1Database` wrappers and the SQL-over-RPC endpoints behind them
   are deleted, so `env.DB` means D1 and nothing else.
3. No `_runtime_*` view or trigger exists in a live object.
4. Every operation that moves a deadline the `WorkspaceScheduler` reads declares
   that it does, and a test proves it — the failure mode #212 shipped is not
   available to a later slice.
5. Each converted subsystem's module document gains a changelog entry saying why
   its port is shaped the way it is.
6. The two surfaces that render a fabricated `author_name` render a real one.
7. The work lands as seven independently reviewable, independently revertable
   changes, not one.

## Non-goals

1. **Reshaping the object schema beyond what a slice needs.** Terminal's
   migration 13 promoted a JSON blob to real columns because the blob was
   actively costing the scheduler an index. A slice that only needs to stop
   naming a view does not also get a table redesign. Deferred per subsystem, not
   rejected — but it is a separate migration with its own justification.
2. **Retiring `workstream_authority_control` and the `authority.phase` checks.**
   Every slice deletes its own dead legacy branches, but the phase check itself
   and the boot path in `index.ts` that reads it stay. Deferred; it is a
   distinct change with a different blast radius.
3. **Changing the RPC transport.** Ports keep dispatching over the existing
   `DurableObjectStub` RPC surface with `rpcResultBody`. Rejected as a
   combination — swapping the transport while converting callers makes both
   un-bisectable.
4. **Touching D1's own control plane.** Routing, identity, migration control,
   sessions, workspaces, and workspace members stay in D1 and are not routed
   today. Out of scope permanently.
5. **A generic query builder or ORM over the object.** Rejected outright. The
   typed port exists so operations name intent; a builder would rebuild the
   layer being removed with better types.
6. **Converting `packages/db/src/index.ts`.** It holds shared query helpers that
   several routed call sites use. Deferred to whichever slice's conversion first
   needs the helper changed, rather than done as its own pass.
7. **Deleting the compat view definitions from migration v1.** Impossible, not
   deferred — see [Data model](#data-model).

## Product behavior

This is an internal refactor and the product is expected to be invariant across
it. Two exceptions are worth naming, because they are the parts a reviewer can
actually check against a running window.

**Author names stop being UUIDs.** `_runtime_users` returns
`participant.user_id AS name`. Two callers read it:
`work-opportunity-service.ts`, when projecting a work-stream message into a work
opportunity's `actor`, and `workstream-description-service.ts`, when building
the transcript excerpt a description refresh summarizes. Today the first shows a
UUID where the opportunity card names who spoke, and the second feeds a UUID to
the model as `author_name`. After the identity slice both read the real display
name from the object's `participants` projection, or omit the field when the
object does not hold one — an omitted name renders as the existing unattributed
state, which is a state both surfaces already have.

**Attachment derivative reconciliation stops comparing against `NULL`.**
`attachment-tool-receipts.ts` compares `receipt.derivative_sha256` against
`resource.model_content_sha256`, which `_runtime_resources` fabricates as `NULL`,
so the comparison is always false and the reconciliation always takes the
"changed" path. After the resources slice it compares against the real stored
digest. The user-visible consequence is that an attachment whose derivative has
not changed stops being re-projected on every pass.

Every other slice is expected to be behavior-identical, and the
[Acceptance](#acceptance) section says how that is demonstrated rather than
assumed.

## Impact on the product contract

None — this changes no clause of the implementation brief. What a work stream
is, whether viewing implies participation, what the agent may do, the absence of
channels, a global inbox, and global search are all untouched. The change is
entirely in how the Worker reaches state it already owns.

One clause is worth checking against rather than assuming: the brief's regional
data-residency commitment. This PRD moves no data between regions and adds no
cross-region call — see [Regional impact](#regional-impact).

## Decision log

None yet.

## Key design decisions

1. **Slices are ordered by blast radius, smallest first — not by value.** Tool
   receipts (27 statements, 5 files) goes first and identity (150 statements, 47
   files) goes last. Each slice is a chance to get the port pattern wrong, and
   the cheapest place to be wrong is the smallest one. *Rejected:* starting with
   identity to "get the hard part over with". Identity is also the only slice
   whose views stand in for tables the object does not own, so it is both the
   largest and the least mechanical — the worst possible first attempt at a
   pattern that is only proven by using it.

2. **One slice per subsystem, one PR per slice.** *Rejected:* one branch for the
   whole layer. Measured, the layer is 81 tables and ~1,300 table references
   across two routers; #212 converted three tables and was 44 files, six
   commits, and shipped a P1 that only human review caught. A single PR at that
   size cannot be reviewed, and cannot be held to the repository's bar of a
   typed port, a workerd suite, a proven-failing test per behavior, and a module
   document per subsystem.

3. **Cross-slice joins do not constrain the order.** All 25 work-stream tables
   live in one SQLite database inside one `SubstreamAgent`, so a typed operation
   may join across slice boundaries freely — the storage class can read any
   table in its own object. There are 60 statements naming tables from two or
   more slices, and none of them blocks a slice from moving. What they decide is
   *where the operation lives*: whichever slice moves second owns the method.

4. **The work-stream and workspace routers are two programs, not one.** The
   workspace object holds **zero** compat views: all 56 routed tables exist in
   the object under exactly their legacy names — 53 in
   `workspace-domain-schema.ts`, including the two FTS shadow tables, and three
   in `workspace-do.ts`. The absence of any translating view is itself the
   evidence that the shapes match, since a divergence would have needed one.
   Removing that router is a pure refactor with no migration. Carrying it under the same plan would imply a
   schema step that does not exist for it. *Rejected:* interleaving them to
   "finish the layer faster".

5. **Views are dropped by new migrations, never by editing v1.** Forced, not
   chosen — see [Data model](#data-model). The consequence worth stating up
   front is that `workstream-runtime-compat-schema.ts` keeps growing staler and
   that is correct: six `_runtime_terminal_*` definitions still sit in it after
   migration 13 dropped them.

6. **Each slice deletes its dead legacy branches before writing any port
   operation.** There are 85 `authority.phase === "durable_object_open"` checks
   across 27 files, 15 of them selecting between two SQL bodies. Because 0090
   pins the phase open, the legacy arm of each is unreachable — and it is
   usually the arm naming the old vocabulary. Deleting first means the slice
   converts only statements that run.

7. **A port operation's directory effect is declared, not inferred.** Goal 4
   exists because #212's regression came from inference. The Terminal protocol
   models this with an explicit `NON_DIRECTORY_OPERATIONS` set and a
   `terminalOperationAffectsDirectory()` default that falls the safe way —
   over-publishing costs an outbox row, under-publishing strands the scheduler.
   Later slices copy that shape rather than re-deciding it.

## Data model

### What exists today

Two wrappers, installed at 116 call sites across 40 files:

| | `workspace-runtime-database.ts` | `workstream-runtime-database.ts` |
| --- | --- | --- |
| Installer | `withWorkspaceRuntimeDatabase(env, workspaceId)` | `withWorkstreamRuntimeDatabase(env, workspaceId, workstreamId)` |
| Routed table list | `WORKSPACE_LOCAL_TABLES`, 56 entries | `LOCAL_TABLES`, 25 entries |
| Table references in `apps/api/src` | ~698 | ~610 |
| Name rewriting | none | `TABLE_REWRITES`, 25 entries |
| Compat views | **0** | 31 defined, 25 live |
| Shape translation | none | ISO-8601 ↔ unix ms, JSON blob ↔ columns, fabricated columns |
| Object-side executor | `executeWorkspaceRuntimeSql` | `executeWorkstreamRuntimeSql` |
| Migration needed to finish | **none** | one per slice |

Routing is by regex over the SQL string. `referencesWorkstreamAuthorityTable`
matches `FROM|JOIN|UPDATE|INTO <table>` against the local list; `mutationTarget`
extracts the write target separately. The pair enforces two invariants a
converting slice can break:

- `workstream_runtime_cross_authority_statement` — thrown at `prepare()` when a
  statement writes a non-local table while naming a local one.
- `workstream_runtime_cross_authority_transaction` — thrown at `batch()` when a
  batch mixes routed and unrouted statements. **Convert a batch as a unit**; a
  half-converted batch turns a working call into a throwing one.

Two further limits shape the ports: `workstream_runtime_bind_value_unsupported`
rejects any bind value that is not a string, number, or `null`, and the request
schema caps a call at 100 statements of 100,000 characters with 500 parameters.

`referencesWorkstreamAuthorityTable` is exported for the workspace router
specifically so that a statement touching work-stream authority reaches the
work-stream object *even when it also names workspace tables* — because only the
work-stream object holds `_runtime_users` and `_runtime_resources`, the views
standing in for tables it does not own. That export is the coupling that makes
identity the last slice.

### The 25 live views

Five are read-only; the rest carry `INSTEAD OF` triggers, listed here because a
trigger is where an undocumented invariant hides:

| View | Triggers | Slice |
| --- | --- | --- |
| `_runtime_tool_invocations` | insert, update, delete | tool receipts |
| `_runtime_tool_checkpoints` | insert | tool receipts |
| `_runtime_block_dashboard_configurations` | insert | block dashboard |
| `_runtime_block_dashboard_preferences` | insert | block dashboard |
| `_runtime_block_dashboard_runs` | insert, update | block dashboard |
| `_runtime_wakeups` | insert, update, delete | scheduling |
| `_runtime_elicitations` | insert, update | scheduling |
| `_runtime_compactions` | insert | scheduling |
| `_runtime_description_refreshes` | insert, update | scheduling |
| `_runtime_plugin_hints` | insert | scheduling |
| `_runtime_messages` | insert | messages |
| `_runtime_message_attachments` | *read-only* | messages |
| `_runtime_message_mentions` | *read-only* | messages |
| `_runtime_resources` | *read-only* | resources |
| `_runtime_workstream_resources` | update, delete | resources |
| `_runtime_resource_revisions` | *read-only* | resources |
| `_runtime_harness_runs` | insert, update | harness runs |
| `_runtime_run_scopes` | insert | harness runs |
| `_runtime_run_lifecycle_events` | insert | harness runs |
| `_runtime_run_memory_contexts` | insert | harness runs |
| `_runtime_run_plugin_activations` | insert | harness runs |
| `_runtime_inference_attempts` | insert | harness runs |
| `_runtime_workstreams` | insert, update | identity |
| `_runtime_workstream_participants` | insert, update, delete | identity |
| `_runtime_users` | *read-only* | identity |

`_runtime_workstream_resources` has update and delete triggers but no insert:
attaching a resource already goes through
`WorkstreamObjectProductService.attachRuntimeResource`, reached from the Worker
by `attachWorkstreamRuntimeResource`, and its regional effect.
That asymmetry is the shape the resources slice should extend, not undo.

### Why the view definitions can never be deleted

`WORKSTREAM_RUNTIME_COMPAT_SCHEMA` is 1,165 lines inside **version 1** of an
append-only, hash-verified migration ledger. Changing one byte changes
`durableObjectMigrationHash` for v1, and every existing object refuses to open
with `workstream_schema_hash_mismatch:1`.

So a slice adds a **new migration** that drops its views, deriving the `DROP`
statements by matching against the v1 source rather than restating their names.
`terminalAuthorityPromotion()` in `workstream-object-schema.ts` is the worked
example, and it throws when its match returns nothing — a rename cannot silently
produce a migration that drops zero objects. Its two ordering rules both come
from SQLite behavior and both carry forward:

- **Triggers before views.** Dropping a view out from under its own `INSTEAD OF`
  trigger is legal and leaves the trigger orphaned in `sqlite_schema`.
- **Drop before rebuilding a table.** SQLite does not validate a view body until
  the view is used, so `DROP TABLE` under a live view succeeds and leaves a view
  that fails on next read.

`WORKSTREAM_OBJECT_SCHEMA_VERSION` is 15. Each slice takes the next free number
**at the time it lands**: two branches that each claim the next version merge
cleanly in Git and collide in the ledger. This already happened once — #212 had
to renumber v11→v12 and v12→v13 after #206 landed, and move a test's
upgrade-path boundary with them.

### Fabricated columns

Three views answer with values the underlying tables do not hold:

| View | Column | Actually returns |
| --- | --- | --- |
| `_runtime_users` | `email` | `''` |
| `_runtime_users` | `name` | `participant.user_id` (a UUID) |
| `_runtime_users` | `avatar_url` | `NULL` |
| `_runtime_users` | `timezone` | `'UTC'` |
| `_runtime_resources` | `content_sha256`, `model_content_ref`, `model_mime_type`, `model_content_sha256`, `model_metadata_json`, `model_content_error_code` | `NULL` |
| `_runtime_resources` | `model_content_status` | `'ready'` |

Only 7 statements route to the work-stream object *and* read one of these
foreign views. Each needs a decision before the resources or identity slice can
finish:

| File | Foreign view | Note |
| --- | --- | --- |
| `services/work-opportunity-service.ts` | `users` | `u.name AS author_name` — a UUID today |
| `services/workstream-description-service.ts` | `users` | `u.name AS author_name` — a UUID today |
| `services/attachment-tool-receipts.ts` | `resources` | insert…select |
| `services/attachment-tool-receipts.ts` | `resources` | reads `model_content_sha256` — `NULL` today |
| `services/integrations.ts` | `resources` | joined to `workstream_resources` |
| `services/resource-service.ts` | `resources` | joined to `workstream_resources` |
| `queues/activity-consumer.ts` | `resources` | joined to `workstream_resources` and `workstreams` |

A slice that "preserves behavior" by returning the same fabricated constant has
preserved a bug. Establish what the caller does with the value first.

### Slices

Statement counts are distinct SQL literals in `apps/api/src` naming at least one
of the slice's tables, counted once per slice they touch, and they include dead
legacy arms — separating those reliably needs the per-file read that is the
slice's own first step, so the counts come down as the work starts.

| # | Slice | Tables | Statements | Files | Views |
| --- | --- | --- | --- | --- | --- |
| 1 | tool receipts | `tool_invocations`, `tool_invocation_checkpoints`, `attachment_tool_receipts` | 27 | 5 | 2 |
| 2 | block dashboard | `block_dashboard_block_runs`, `block_dashboard_configuration_versions`, `block_dashboard_user_preferences` | 25 | 4 | 3 |
| 3 | scheduling | `workstream_wakeups`, `elicitations`, `workstream_context_compactions`, `workstream_description_refreshes`, `workstream_plugin_activation_hints` | 28 | 8 | 5 |
| 4 | messages | `messages`, `message_attachments`, `message_mentions` | 42 | 16 | 3 |
| 5 | resources | `resources`, `workstream_resources`, `workstream_resource_inventory_revisions` | 73 | 22 | 3 |
| 6 | harness runs | `harness_runs`, `harness_run_scopes`, `harness_run_lifecycle_events`, `harness_run_memory_contexts`, `harness_run_plugin_activations`, `inference_attempts` | 102 | 13 | 6 |
| 7 | identity | `workstreams`, `workstream_participants`, `users` | 150 | 47 | 3 |

Cross-slice statements, which decide method ownership rather than order:
`identity + messages` 18, `harness-runs + tool-receipts` 12,
`harness-runs + identity` 6, `harness-runs + messages` 6,
`identity + resources` 4, `block-dashboard + harness-runs` 3, and a tail of 11
across eight more combinations.

The workspace side has no schema step and no ordering constraint: 56 tables,
513 statements, 55 files. It is unusually concentrated — four services hold
nearly forty per cent of it:

| Owner | Statements |
| --- | --- |
| `services/slack-agent-service.ts` | 58 |
| `services/automation-service.ts` | 54 |
| `services/connection-service.ts` | 52 |
| `services/memory-table-service.ts` | 37 |
| `durable-objects/workspace-do.ts` | 22 |
| `services/integrations.ts` | 21 |
| `services/memory-service.ts` | 20 |
| `services/workspace-schedule-execution.ts` | 19 |
| `services/resend-inbound-email-service.ts` | 19 |
| everything else (46 files) | 211 |

That concentration is the plan: the first four files are four changes, not
fifty-five, and each is a coherent subsystem with its own tables. The long tail
is single statements in files that mostly do something else, and those come out
with whichever slice owns the table. Because the names and shapes already match,
most conversions wrap the same SQL in a method — the value is the typing and the
single-round-trip transaction, not a reshape.

### Slice 1, specified

The first slice is written out here rather than left to whoever picks it up,
because the point of going first is to produce a template. Slices 2–7 differ in
their tables and their traps, not in their shape.

**Where the statements are.** 27 statements, five files, and it is not evenly
spread:

| File | Statements | Verbs |
| --- | --- | --- |
| `runtime/harness-run-runtime.ts` | 14 | 5 `INSERT`, 5 `UPDATE`, 4 `SELECT` |
| `services/attachment-tool-receipts.ts` | 7 | 3 `INSERT`, 4 `SELECT` |
| `services/integrations.ts` | 4 | 4 `SELECT` |
| `telemetry/tool-usage.ts` | 1 | `SELECT` |
| `telemetry/run-outcome.ts` | 1 | `SELECT` |

**The port's operation list already exists.** `harness-run-runtime.ts` holds
every write behind an exported function that already names an intent, not a
table: `persistToolExecutionPlan`, `checkpointToolInvocation`,
`completeToolInvocation`, `finalizeToolInvocationFailure`,
`markToolInvocationTimedOut`. Those five signatures *are* the storage class's
methods. The conversion is moving their bodies inside the object and leaving the
signatures where the callers already reach them — which is why this slice is
first: the hard design question, what the operations should be called, is
already answered by code that shipped.

**What the view is actually doing.** `_runtime_tool_invocations` reads
`tool_effects JOIN runs CROSS JOIN workstream`, and the translation is larger
than a rename. Every line of it is a decision the typed operations have to make
explicitly:

| Compat column | Real source | Translation |
| --- | --- | --- |
| `id` | `effect.effect_intent_id` | rename — and the reason `effectIntentId` is the vocabulary #230 introduced |
| `input_hash` | `effect.request_hash` | rename |
| `status` | `effect.status` | **value remap**: `admitted` → `pending`, `executing` → `started`; the other three pass through |
| `started_at`, `completed_at` | `effect.started_at`, `effect.settled_at` | unix ms → ISO-8601, `NULL`-guarded |
| `lease_expires_at` | `run.lease_expires_at` | unix ms → ISO-8601, and it comes from the **run**, not the effect |
| `attempt_id` | `run.legacy_attempt_id` | a column that exists only for this projection |
| `last_checkpoint_at` | `MAX(checkpoint.created_at)` | **a correlated subquery per row**, over `tool_effect_checkpoints` |
| `workspace_id`, `workstream_id` | `root.parent_workspace_key`, `root.workstream_key` | from the singleton root, not stored per effect |

The status remap is the trap. A caller comparing against `'started'` is asking
about `executing`, and a typed operation that returns the real value silently
changes what every such comparison means. Grep for the compat spellings before
converting, not after — `'pending'` and `'started'` are also perfectly ordinary
strings elsewhere.

`last_checkpoint_at` is the second one: it is computed, so nothing writes it,
and a typed `completeToolInvocation` that tries to *set* it has misread the
schema. It belongs on the read operation that projects a receipt.

**What the migration drops.** `_runtime_tool_invocations` with its insert,
update, and delete triggers, and `_runtime_tool_checkpoints` with its insert
trigger — six objects, triggers before views. `legacy_attempt_id` does not go
with them, and it is the clearest illustration of why slices are sequenced
rather than independent: `_runtime_messages` and `_runtime_harness_runs` project
it too, so the column survives until slices 4 and 6 have also landed. A slice
drops its own views; shared debris comes out last.

**Where it touches the neighbours.** Twelve statements name both this slice and
harness runs, which is expected — a receipt belongs to a run. They decide
ownership, not order: a statement joining `tool_invocations` to `harness_runs`
becomes one method on whichever storage class moves second, and until slice 6
lands that method reads `runs` directly, which it may, because both tables are
in the same object.

**Its foreign-view reader.** `attachment-tool-receipts.ts` joins `resources` —
one of the two lossy foreign views — and reads `model_content_sha256`, which
`_runtime_resources` fabricates as `NULL`. That comparison is always false
today, so the reconciliation always takes the changed path. Slice 1 can convert
around it or leave the join in place for slice 5; what it must not do is
reproduce the `NULL` and call it behavior-preserving.

### The shape of a slice

Steps 1–3 are mechanical after the first slice; step 4 is the work.

1. Delete the slice's dead `authority.phase` legacy arms.
2. A typed storage class on the object, operating on real tables with unix-ms
   timestamps. Model: `workstream-terminal-storage.ts`.
3. A protocol module deriving the operation set from that class, so an unlisted
   method is a compile error. Model: `workstream-terminal-protocol.ts` — note
   its `Exhaustive<T>` tuple guard, which exists because
   `satisfies readonly Operation[]` alone is one-way: it proves every listed
   name is real and says nothing about a method with no entry. The reflection
   test in `apps/api/test/terminal-object-protocol.test.ts` checks the same
   claim at run time, because the type is only as good as its own declaration.
4. A Worker-side port built from the operation list, not hand-written. Model:
   `services/terminal/object-port.ts`.
5. Every statement converted or deleted; every batch converted as a unit.
6. A new object migration dropping the slice's views and triggers.
7. `LOCAL_TABLES` and `TABLE_REWRITES` lose the slice's entries.
8. The subsystem's module document gains a changelog entry.

## Regional impact

None. Both routers resolve a stub in the caller's own region via
`durableObjectStubForWorkspace`, and every converted port does the same. No
statement crosses a regional boundary today and none will; the object migrations
are applied per region by the same ledger that applies every other one, so
Global and the European Union converge independently and identically.

The one thing to hold: `substreamAgentName` takes `env.AVALON_REGION`, so a port
built with the wrong `Env` reaches a name that does not exist rather than
another region's data. Each slice's workerd tests should include the identity
check that already guards the Terminal endpoint —
`workstream_terminal_identity_mismatch` re-verifies the object's own identity
against the request before anything executes, and a misrouted stub must fail
rather than write another work stream's state.

## Security and trust model

The layer's trust boundary is worth stating precisely, because a reader
encountering `/internal/runtime-sql` accepting arbitrary SQL should know why
that is not a hole, and because the ports narrow it.

**Today.** SQL never crosses a client or connector boundary. The only caller is
the Worker holding a stub for its own object, and the object re-checks its own
identity against the request before executing. Model- and user-supplied values
arrive as bound parameters, constrained to string, number, or `null`. The
executor wraps every statement in `transactionSync`, so a failure rolls the
whole request back.

**After.** The arbitrary-SQL endpoint is deleted. Each port exposes a fixed,
enumerable operation set with per-argument types checked at the call site by the
mapped port type, and identity re-checked per call. That is a strictly smaller
surface: the current arrangement is safe because of who may call it, and the
converted one is additionally safe because of what may be called.

No credential handling, session or ticket handling, webhook verification, or
renderer isolation changes. The one thing a slice can get wrong is the failure
contract: a port must distinguish *not committed* (safe to retry) from *unknown*
(stop and reconcile), or a caller will retry a write that may have landed.
`TerminalOperationFailureSchema` is the model — note that it refuses to
manufacture a retryable verdict from a malformed envelope, returning
`outcome: "unknown", retryable: false` instead.

## Rollout

No feature flag. A slice is a code change with a schema migration; there is no
intermediate state where both paths are live, and adding one would mean keeping
the layer working while removing it.

Ordering within a slice is forced by the ledger: the migration that drops a view
must land in the same change as the last statement that names it. Landing them
separately gives either an object whose views are gone while callers still name
them, or a `LOCAL_TABLES` entry routing to a view that no longer exists.
Both fail closed — `no such table` inside the object — but both are avoidable.

Reverting a slice means reverting the code; the migration stays applied, because
the ledger is append-only. A reverted slice therefore needs its statements
restored *and* a new migration recreating its views — which is expensive enough
that it argues for the small-first ordering in decision 1, and for each slice
proving itself on real workerd before it lands.

## Acceptance

The generic bar in [AGENTS.md](../../../AGENTS.md) applies to every slice: `pnpm
lint` at zero warnings, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, both
Wrangler dry-run builds, and every new test proven to fail against a broken
version of the code it covers.

Per slice, additionally:

1. **The views are gone from a real object.** A workerd test evicts and reopens
   the object, then asserts the slice's views and triggers are absent from
   `sqlite_schema` and that its operations still work. Eviction matters: it is
   what proves the migration ran rather than the isolate remembering.
2. **The migration is idempotent and ordered.** Applying the ledger twice leaves
   the same schema hash; the drop derivation throws if it matches nothing.
3. **Directory effects are asserted, not assumed** (goal 4). For every operation
   that moves a deadline the `WorkspaceScheduler` reads, a workerd test asserts
   the `directory_common` effect was enqueued and
   `workspace_workstream_directory.next_terminal_action_at` moved. This is the
   check whose absence let #212's regression through.
4. **The port covers the storage class exactly.** The `Exhaustive<T>` guard
   plus a reflection test over the prototype, per step 3 above.
5. **Behavior invariance is demonstrated where it is claimed.** For a slice
   asserting no user-visible change, the existing subsystem tests pass
   unmodified — a test that had to be edited to accommodate the port is a
   behavior change, and it gets named in the PR rather than absorbed.
6. **For slices 5 and 7, the fabricated-column decisions are recorded** in the
   decision log, one entry per affected statement in the table above.

For the two surfaces in [Product behavior](#product-behavior), acceptance is a
real window: the work-opportunity card and a description refresh's transcript
excerpt, captured per
[the development environment guide](../../dev-environment.md#driving-and-screenshotting-it),
showing a name rather than a UUID.

## Open questions

1. **Does `packages/db/src/index.ts` need to move before slice 4?** It builds
   message projections naming `message_mentions` in three places. If those
   helpers are called through a routed handle they are slice-4 work; if they are
   only called against real D1 they are untouched. Resolving this needs a
   caller-by-caller read and it blocks slice 4's scope, not its start.
2. **Do `_runtime_users`'s readers need a display name the object does not
   hold?** The object's `participants` table holds `user_id` and participation
   metadata. If no projection carries a display name, the identity slice either
   adds one — fed by the existing regional effect that already syncs
   participants — or the two surfaces render unattributed. This decides whether
   goal 6 is a projection change or a rendering change, and it should be settled
   before slice 7 starts, not during it.
3. **Should the workspace-side conversion be one PRD or seven more slices?**
   It is 56 tables with no migration and no view, so it may be tractable as a
   handful of larger PRs. Deferred until at least one work-stream slice has
   landed and the port pattern's real cost per table is known rather than
   estimated.
