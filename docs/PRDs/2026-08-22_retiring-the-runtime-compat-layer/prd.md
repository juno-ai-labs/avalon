# Retiring the runtime compatibility layer

> Created 2026-08-22.
>
> Remove the D1→Durable Object cutover compatibility layer in full — both routed
> `D1Database` wrappers and the 25 `_runtime_*` views behind one of them — by
> converting each subsystem to a typed object port, in fifteen slices.
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Subsystem references: [`agent-harness.md`](../../agent-harness.md),
> [`terminal-workspaces.md`](../../terminal-workspaces.md),
> [`workstream-durable-object.md`](../../workstream-durable-object.md),
> [`data-model.md`](../../data-model.md).

## Summary

Rally's product data moved from D1 into Durable Object SQLite during the
regional cutover. The service code did not move with it. Instead, two wrappers
intercept `env.DB`, inspect each SQL string, and forward statements naming a
migrated table to the owning object — and on the work-stream side, rewrite the
table names onto compatibility views whose `INSTEAD OF` triggers translate
between the old D1 shapes and the object's real ones.

This PRD removes both, end to end: all 81 routed tables and roughly 1,300
statements, as fifteen slices — seven on the work-stream side, eight on the
workspace side. Each subsystem gains a typed storage class on the object and a
typed Worker-side port, its statements are converted or deleted, and the views
it used are dropped by a new object migration. When the last slice lands,
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
fabricates `'' AS email` and returns `participant.user_id` as `name`, so a
caller selecting `u.name AS author_name` gets a UUID.

That this has not yet *hurt* anyone is luck, not design, and establishing it took
tracing five separate statements to their runtime guards — four of which turned
out to be dead. A view that answers wrong is a defect whether or not the caller
that would have been misled still executes; the next caller written against it
will not be dead.

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
6. Every fabricated column is either deleted or documented as a placeholder
   nothing reads. (This goal originally read "the two surfaces that render a
   fabricated `author_name` render a real one" — neither surface renders it; see
   [Product behavior](#product-behavior).)
7. The work lands as fifteen independently reviewable, independently revertable
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

**Nothing user-visible changes, in any slice.** An earlier draft of this section
claimed two user-visible wins. Both were wrong, and how they were wrong is the
most useful thing this PRD can hand its implementer, so they are recorded rather
than quietly deleted.

**Claimed: author names stop being UUIDs.** `_runtime_users` does return
`participant.user_id AS name`, and `workstream-description-service.ts` does read
it. But that value's only consumer is a `JSON.stringify` into the
description-refresh *prompt*; it is not in `packages/contracts` and never
reaches the desktop client. The name a person actually sees comes from a
separate regional-D1 join inside the object — `messageUsers` in
`workstream-object-product.ts`, which reads the real `users` table and feeds
`Message.author.user`. The compat view never touches the rendered path. The
second caller, `work-opportunity-service.ts`, does not even read the view: it
runs against real D1, in a branch gated on `phase !== 'durable_object_open'`
that also queries `activity_events` — a table migration 0090 dropped. It is dead
twice over.

**Claimed: attachment reconciliation stops comparing against `NULL`.**
`attachment-tool-receipts.ts` has two arms, chosen by
`regionalDatabase(target) !== target.DB`. The arm that reads
`_runtime_resources.model_content_sha256` is the one taken when the environment
is *not* routed — and `withWorkstreamRuntimeDatabase` returns a proxy whose `DB`
is the routed port while `regionalDatabase` returns the raw binding, so the two
are never equal under a routed env. The routed path therefore always takes the
*other* arm, which reads `model_content_sha256` from the real `resources` table
in WorkspaceDO, because bare `resources` is absent from the work-stream router's
`LOCAL_TABLES` and is claimed by the workspace router instead. The comparison
already works. The unrouted arm is unreachable, and would fail with
`no such table` if it were reached, since 0090 dropped `resources`,
`attachment_tool_receipts` and `tool_invocations` from D1.

**The lesson both share, which is the one worth carrying into every slice.** Both
claims came from reading a statement's SQL and the view it *would* hit, without
tracing the runtime guard that decides whether the statement reaches that view at
all. This layer is full of paired arms where the dead one is the one that names
the compat view. Grep finds the dead arm first, because it is the one written in
compat vocabulary. **Establish which arm executes before writing down what a
statement does.**

So the product is invariant across all fifteen slices, and the value is
engineering: typed operations instead of rewritten SQL, one round trip instead of
three, and the deletion of a large volume of unreachable code. The
[Acceptance](#acceptance) section says how invariance is demonstrated rather than
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

`WORKSTREAM_OBJECT_SCHEMA_VERSION` is 16 (v16 landed the `tool_position`
high-water fix). Each slice takes the next free number
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

An earlier draft listed 7 statements as the readers of these views and said each
needed a decision. Traced to their runtime guards, **5 of the 7 are dead** and
the list missed the live ones entirely. The corrected inventory:

| File | Foreign view | Status |
| --- | --- | --- |
| `services/attachment-tool-receipts.ts` (insert…select) | `resources` | **dead** — the unrouted arm; see [Product behavior](#product-behavior) |
| `services/attachment-tool-receipts.ts` (`model_content_sha256`) | `resources` | **dead** — same arm |
| `services/integrations.ts` | `resources` | **dead** — legacy arm of a `phase` conditional |
| `services/resource-service.ts` | `resources` | **dead** — legacy arm |
| `queues/activity-consumer.ts` | `resources` | **dead** — legacy arm |
| `services/work-opportunity-service.ts` | `users` | **dead** — legacy arm, and queries `activity_events`, dropped by 0090 |
| `services/workstream-description-service.ts` | `users` | **live** — `author_name` into a prompt, not a rendered surface |
| `packages/db/src/index.ts` ×3 | `resources` | **live, and outside `apps/api/src`** — the transcript loaders, joining `message_attachments` → `resources` |

The last row is the one that matters and the one a repo-scoped search misses:
`getMessageByClientId`, `listMessages` and `listMessagesAfter` read `id`,
`title`, `mime_type`, `metadata_json`, `content_ref` and `created_at` through
`_runtime_resources`. Those six the view projects *for real*, out of
`workstream_resource_links.resource_json` — they are the reason schema migration
v4 exists. None of the six fabricated columns is among them.

So the resources slice does not have to decide what to do about a fabricated
constant. After deleting the dead arms, **no live statement reads any of the
seven fabricated columns**, and the view can be trimmed to the six real ones
rather than converted around. `_runtime_users.name` has one live reader, feeding
a prompt; the identity slice should record that it is a placeholder nothing
renders, so the next reader does not "fix" it by denormalizing display names into
`participants` — a second, staleable copy that the actual read path never
consults.

The original warning still stands in principle, restated to match what was
actually found: **a slice that "preserves behavior" by reproducing a fabricated
constant has preserved a bug — but first establish that the statement executes
at all.** Here, five of seven did not.

### Slices

**Slices 1 and 2 have landed. Slice 3 converted its callers and dropped four of
its five views; slice 4 converted its callers and dropped none; slice 5
converted its callers and dropped all three. Slice 6 is landing in parts.** The
other ten are plans. Fifteen in all, covering all 81 routed tables.

**Slice 6 does not fit in one change, and the reason is the count in the table
below.** Its 102 statements are not spread over 13 files evenly: 116 of the
table references are in `harness-run-runtime.ts` alone, and every one of them
is fenced on a lease that the routed spelling expressed as a join. Converting
the lease family — claim, heartbeat, both ownership asserts — moved ~140 call
sites on its own. So the slice lands as the lease family, then the scope and
activation writers, then the inline-child family, then terminalization and the
reaper; the views come down once nothing routes to them. A function keeps its
`D1Database` parameter exactly as long as it still has a statement that needs
one, which makes the remaining work visible in the signatures rather than in a
list.

**One of slice 6's statements cannot land in slice 6 at all.**
`persistHarnessFinalMessage` writes a message, its lifecycle event and the work
stream's attention counters in one batch — it is the second of the three
cross-slice batches named below, and it waits for slice 7 for the same reason
those do.

**Slice 5 came in at a tenth of its statement count, and the reason generalizes.**
Of the 73 statements counted for the resources slice, almost all name
`resources` alone — which routes to WorkspaceDO and belongs to slice 14. The
work-stream half was the *link* table plus a handful of statements that joined
the two, and `_runtime_resources` existed only to make that join expressible: it
projected the object's frozen `resource_json` copy as though it were the
workspace's live row. **A table that appears on both sides of the table split
inflates its slice's count by every statement that touches only the other
side.** `resources` is the one table the PRD already knew was double-counted;
what it did not predict is that the double-counting is where nearly all the
statements were.

**The work-stream side's slice order does not survive contact with its own
batches.** Slice 3 kept `_runtime_elicitations` and handed it to slice 4; slice
4 then found it could not take it, and could not drop its own three views
either. Three transcript writes are batches spanning three slices at once — an
elicitation and its message and the work stream's counters; a harness run's
final message, its lifecycle event and the work stream; a work stream's
creation, its opening message and its attachments — and each one's later
statements are guarded on its earlier ones having landed. Splitting any of them
across a port boundary puts a network hop inside a guarantee.

So `_runtime_messages`, `_runtime_message_attachments`,
`_runtime_message_mentions` and `_runtime_elicitations` retire together with
identity and harness runs, and slices 4, 6 and 7 are one ordering problem
rather than three. The conversions still land in slice order and each is
independently useful — slice 4 converts every transcript reader and deletes
five repository functions — but the *views* come down at the end.

**And the batches are more of the slice than the counts suggested.** Slice 4's
first pass named three; converting the rest of its readers found that *every*
statement still on `_runtime_messages` afterwards is cross-slice. Six of them
are in `harness-run-runtime.ts`, each joining `messages` to `harness_runs` or
`harness_run_lifecycle_events` inside one statement; Slack's elicitation answer
guards a counter update on `EXISTS (SELECT 1 FROM messages)`; inbound email's
sequence claim is fenced on `workstreams.email_address`, which makes it
identity's as much as messages'. What is left on the view is not a tail of
plain readers somebody skipped — it is the ordering problem itself.

This is what the cross-slice note below predicts, at a scale the statement
counts did not show: the statement decides the ownership, and the biggest
batches decide the order. Statement counts are distinct SQL
literals in `apps/api/src` naming at least one of the slice's tables, counted
once per slice they touch, and they include dead legacy arms — separating those
reliably needs the per-file read that is the slice's own first step, so the
counts come down as the work starts.

The two side totals below are 26 and 56, which is 82 rather than 81: `resources`
is routed by *both* wrappers, so it appears in slice 5 and again in slice 14 —
one table, converted twice — and 26 + 56 − 1 = 81. The statement columns, by
contrast, sum to their stated totals exactly (447 and 536), so read the table
counts as per-side and the statement counts as additive. The work-stream table
names all 26 of its tables; the workspace one uses prefixes (`digest_*`,
`slack_*`, `memory_*`, `automation_*`) whose expansion is the 56.

**Work-stream side.** Seven slices, 26 tables, 447 statements, 25 views to drop.
These carry the migrations and the translation traps, and they are ordered:

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

**Workspace side.** Eight slices, 56 tables, 536 statements. No views to drop,
no migration, and no ordering constraint from schema — so these may be worked in
any order, and in parallel with the work-stream side once the port pattern is
settled:

| # | Slice | Tables | Statements | Files |
| --- | --- | --- | --- | --- |
| 8 | sandbox policy | `workspace_sandbox_network_policies`, `_domains`, `_policy_mutations` | 14 | 3 |
| 9 | workspace misc | `workstream_notification_intents`, `workspace_workstream_pins`, `workstream_email_receipts`, `realtime_transcription_*` | 26 | 7 |
| 10 | digests | `digest_*`, `schedules` | 47 | 9 |
| 11 | Slack | `slack_*` | 55 | 7 |
| 12 | memory | `memory_*` | 63 | 4 |
| 13 | automations | `automation_*` | 92 | 19 |
| 14 | notes and resources | `notes`, `note_*`, `resources`, `resource_watches`, `resource_object_deletion_outbox` | 98 | 24 |
| 15 | connectors | `connector_connections`, `connector_oauth_attempts`, `webhook_receipts`, `external_user_identities`, `workspace_connector_event*` | 141 | 24 |

Same ordering rule as the work-stream side: smallest blast radius first. Memory
and Slack are unusually cheap for their statement counts — 63 statements across
four files, and 55 across seven — because each is one service that owns its own
tables. Connectors and notes-and-resources are the opposite: ~24 files each,
because their tables are read from everywhere.

Because the names and shapes already match, most conversions wrap the same SQL in
a method. The value there is the typing and the single-round-trip transaction,
not a reshape — which is why these slices are cheaper per statement than the
work-stream ones, and why they are also the less urgent half.

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
| `harness_run_id` | `effect.run_id` | rename |
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

That is 11 translated columns out of the view's 23; the rest pass through. Three
of the eleven turn out to have no reader at all — nothing reads `attempt_id`,
`lease_expires_at`, or `last_checkpoint_at`. `loadToolInvocation` pulls them only
because it says `SELECT *`. So the read operation need not project them, and the
correlated subquery goes away rather than being reimplemented.

**Where the translation goes instead of away.** `ToolInvocationSchema` in
`packages/contracts` pins `status` to the compat spellings and its timestamps to
ISO-8601. That is a published wire shape, not a reader's habit, so slice 1 moves
the translation from the SQL view into the Worker-side port at the
`loadToolInvocation` boundary. Changing the wire enum is a separate, deliberate
change; it must not be smuggled in here.

**What the write triggers fabricate, and the bug in it.** The read view
translates; the `INSTEAD OF INSERT` trigger *invents*. `tool_effects` has five
`NOT NULL` columns the compat vocabulary never carried, and the trigger fills
each with a literal or a derivation:

| Real column | What the trigger writes |
| --- | --- |
| `attempt_epoch` | `(SELECT attempt_epoch FROM runs WHERE run_id = NEW.harness_run_id)` |
| `tool_position` | `(SELECT COUNT(*) FROM tool_effects WHERE run_id = NEW.harness_run_id)` |
| `occurrence_key` | the literal `'runtime:' || NEW.id` |
| `authority_revision` | `COALESCE(NEW.execution_plan_hash, 'runtime')` |
| `mode` | `json_extract(NEW.execution_plan_json, '$.mode')`, defaulting to `read` |
| `result_hash` | `COALESCE(NEW.output_ref, NEW.output_summary)` — a ref or a human sentence, in a column named for a hash |

`tool_position` as a row count is a live bug, not merely an inelegance. The
trigger's `INSERT OR IGNORE` resolves against three constraints on
`tool_effects`: its primary key, `UNIQUE (run_id, attempt_epoch,
tool_position)`, and `tool_effects_run_call_uq ON tool_effects(run_id,
tool_call_id)` — an index the compat schema itself creates
(`workstream-runtime-compat-schema.ts`). That third one is deliberate and
load-bearing: the SQL router strips `ON CONFLICT` before forwarding, on the
stated ground that "each compatibility trigger applies the equivalent conflict
policy to its normalized table", and this index is how the equivalence holds for
`persistToolExecutionPlan`'s `ON CONFLICT(harness_run_id, tool_call_id) DO
NOTHING`. It is the replay dedup for every tool receipt. **See "What the
migration drops" below: it is a keep, not a drop.**

The position collision is a different constraint firing. The colliding admission
carries a *new* `tool_call_id`, so the call key is untouched and the triple is
what rejects the row.

A count is only a safe allocator while nothing is ever removed, and receipts
*are* removed: `attachment-tool-receipts.ts` runs
`DELETE FROM tool_invocations WHERE workspace_id = ? AND id = ?` from two paths,
and `_runtime_tool_invocations_delete` turns that into
`DELETE FROM tool_effects`. Deleting a receipt from the middle of a run leaves a
hole, `COUNT(*)` then under-counts by one, and the next admission in that run
computes a position another row already holds. `INSERT OR IGNORE` drops it
silently; the caller sees zero changes, reads that as "someone else already
wrote my receipt", falls through to the existing-row lookup keyed on
`(harness_run_id, tool_call_id)`, finds nothing — its row was never written —
and throws `RunOwnershipLostError`, ending the run with a lease failure that
never happened.

(An earlier draft of this section called it a concurrency bug — two admissions
racing to the same count. That is wrong: the routed statements arrive as
separate requests and the object serializes them, so each `COUNT(*)` sees the
previous insert. The deletion path is the real one, and it is worth the
correction because "two writers race" and "an allocator is not injective after a
delete" want different fixes.)

The fix is a high-water mark rather than a count —
`COALESCE(MAX(tool_position) + 1, 0)` over the run — which stays injective
across deletes. That does not need to wait for slice 1: migration 14 already
rebuilt this view's *update* trigger in place, so the same technique repairs the
insert trigger now, ahead of the slice that deletes it entirely. The typed
operation inherits the corrected allocation.

**The other three fabrications, now verified rather than assumed.** An earlier
draft said "nothing reads them" was a claim to check. Checked, across the whole
repository including migrations, tests, scripts and the desktop app:

| Column | Verdict |
| --- | --- |
| `occurrence_key` | **No reader.** No index, no constraint, not projected by the view. Its value is `'runtime:' \|\| effect_intent_id` — a restatement of the primary key. |
| `authority_revision` | **No reader.** `execution_plan_hash` with `'runtime'` substituted for `NULL`, and `execution_plan_hash` is a real column that *is* read. |
| `result_hash` | **One reader: itself.** The update trigger's `COALESCE(NEW.output_ref, NEW.output_summary, result_hash)` preserves the prior value. Nothing outside the column observes it. |

`result_hash` is therefore droppable *in the same change that drops
`_runtime_tool_invocations_update`*, and not before. The typed writers already
match its behavior without the self-read: `complete` always supplies a non-null
first arm, and `fail` and the rebind omit the column entirely, which preserves it
exactly as the third `COALESCE` arm did.

A caution on actually removing the two dead ones: both are `NOT NULL` with no
default on a `STRICT` table carrying a table-level `UNIQUE`, so this is a
create-copy-drop-rename rebuild, not `ALTER TABLE … DROP COLUMN`. That is a real
migration for two columns of dead text per row. Fold it into slice 1's own
migration rather than spending a version on it alone.

And one near-miss worth naming, because it is the same shape as the mistake this
PRD already made once: `occurrence_key` **does** carry a unique index — on the
`parts` table, not on `tool_effects`. Same column name, different table. Check
the table, not the name.

**What the migration drops, and the one thing it must not.**
`_runtime_tool_invocations` with its insert, update, and delete triggers, and
`_runtime_tool_checkpoints` with its insert trigger — six objects, triggers
before views.

Two things in that file are **kept**, and the second is worse to get wrong than
the first.

`attachment_tool_receipts` is **kept, and moved**. It is a real `STRICT` data
table holding live product data — the resource version each replayable
attachment read depends on — and it is created *only* by
`workstream-runtime-compat-schema.ts`, appearing nowhere in
`workstream-object-schema.ts`. It is not a view, it has no trigger, and nothing
about it is a compatibility shim except its address. Slice 1 moves its
`CREATE TABLE` and `attachment_tool_receipts_invocation_idx` into the object's
own schema.

The trap is that the compat file's header comment says, three lines above that
`CREATE TABLE`, that "these statements deliberately create no compatibility data
tables". Anyone deriving the drop set from that sentence deletes live data. It is
true of `_runtime_statement_changes` — a genuine compat mechanism that does go —
and false of this table. **The rule slice 1 establishes: derive the drop set
from what each object is, never from the file it lives in.**

`tool_effects_run_call_uq` is **kept**. It lives in the compat schema and it
looks like compat debris, but it is a unique index on real columns of a real
table, and it is the constraint that dedups a replayed tool call. Dropping it
with the views is the failure this whole PRD exists to prevent: nothing would
fail, no test would go red, and the object would quietly accept two receipts for
one `(run_id, tool_call_id)`. Slice 1 therefore moves the index into the
object's own schema — same name, same columns, created by the migration that
drops the views — and the typed `admit` additionally reads
`WHERE run_id = ? AND tool_call_id = ?` inside its transaction rather than
inferring the outcome from an ignored insert, so the invariant is enforced twice
and stated once.

This makes the index the compat layer's *second* mark on the real schema,
alongside `runs.legacy_attempt_id`. The two are opposites and the difference is
the point: the column exists only so three views can project a text attempt id
and nothing outside the compat schema reads it, so it is pure debris and is
dropped once its readers are gone. The index carries a real invariant the
product depends on, so it outlives the layer that created it. "It is in
`workstream-runtime-compat-schema.ts`" is not sufficient grounds to delete
anything; the file's own header — "these statements deliberately create no
compatibility data tables" — is true of tables and not of this index.

`legacy_attempt_id` does not go with them, and it is the clearest illustration of why slices are sequenced
rather than independent: `_runtime_messages` and `_runtime_harness_runs` project
it too, so the column survives until slices 4 and 6 have also landed. A slice
drops its own views; shared debris comes out last.

**Where it touches the neighbours.** Twelve statements name both this slice and
harness runs, which is expected — a receipt belongs to a run. They decide
ownership, not order: a statement joining `tool_invocations` to `harness_runs`
becomes one method on whichever storage class moves second, and until slice 6
lands that method reads `runs` directly, which it may, because both tables are
in the same object.

**Its foreign-view reader, corrected.** `attachment-tool-receipts.ts` has two
arms. The one that joins `_runtime_resources` and reads the fabricated
`model_content_sha256` is dead (see [Product behavior](#product-behavior)); the
live arm reads the real digest from WorkspaceDO's `resources` as its own
single-authority statement, correlating in TypeScript rather than joining. That
is already the pattern the resources slice would have had to invent, so slice 1
deletes the dead arm and leaves the live one alone.

Two things about the live arm must survive that deletion, because both are
load-bearing and neither is obvious:

- **The digest comparison is now the *only* receipt-invalidation mechanism.** D1
  migration 0073 had a trigger that eagerly deleted receipts when
  `model_content_sha256` changed. WorkspaceDO has no equivalent and cannot have
  one — receipts live in a different object now. Read-time comparison is the
  whole mechanism. Anyone "simplifying" that check removes the only thing between
  a stale derivative and a replayed model turn.
- **The only test of the register path covers the dead arm.**
  `attachment-tool-receipts.test.ts` calls the exported functions with a bare
  `D1Database`, so it exercises arm A exclusively, against a schema D1 has not
  had since 0090, seeded with a non-`NULL` digest. It is green over code that
  cannot execute. Deleting the dead arm without rebuilding that test on the
  harness-shaped fixture leaves the live register path with no coverage at all.

**Slice 1 is complete.** What follows is the inventory as it stood when the
readers had not yet moved, kept because the decomposition is the template for
the next six slices: read the remaining surface per *object*, not per file, and
the work shrinks.

Decomposed by trigger, the surface was:

| Object | Remaining users |
| --- | --- |
| `_runtime_tool_checkpoints` view + insert trigger | **none** — six test assertions only |
| `_runtime_tool_invocations` insert trigger | the dev seed route |
| `_runtime_tool_invocations` update trigger | the lease sweep in `harness-run-runtime.ts` |
| `_runtime_tool_invocations` delete trigger | one delete in `attachment-tool-receipts.ts` |
| `_runtime_tool_invocations` read view | nine live SELECTs |

Half the view surface is already free: rewriting six assertions onto
`tool_effect_checkpoints` retires the checkpoint view with no production change.

**The lease sweep needs its own guard, and that is why it was left behind.**
Every method on `WorkstreamToolReceiptStorage` opens with `#fence`, which
requires a live lease. `reapStaleHarnessRuns`'s entire premise is that no lease
exists — so `admit`, `checkpoint`, `complete` and `fail` would each return
`ownership_lost` by construction. It needs a method fenced on the run's
`terminalized_at` instead, which is a guard the existing four cannot express.
Two decisions that conversion must make deliberately rather than inherit:

- **Keep the `json_extract(execution_plan_json, '$.mode')` derivation, or change
  it on purpose.** It disagrees with the real `mode` column: for an absent or
  malformed plan the column says `read`, while the sweep treats the same plan as
  possibly-a-write and settles `ambiguous`. Switching to the column silently
  demotes those receipts to `failed` — turning "we could not confirm the write"
  into "it definitely failed", which is exactly the wrong direction for a
  receipt whose provider call may have landed.
- **Decide whether the sweep appends a checkpoint.** It does not today, while
  `#settle` makes checkpoint-then-move structural for every other terminal
  write. Matching that is probably right and is still a behavior change.

**No statement blocks slice 1.** The three that look like cross-slice blockers
are not: the `messages` join in the transcript projection is id-equality on data
the caller already holds, and the two telemetry statements join only tables
inside the same object. The telemetry pair should be retargeted at `tool_effects`
in place rather than given port methods — their primary table is `harness_runs`,
so slice 6 owns them; retargeting stops them naming a slice-1 table, which is all
the view drop requires.

**What slice 1 actually cost, and what the next six should expect.** Nine
commits, and the estimate that mattered least was the statement count. What the
work was really made of:

- **Dead arms outnumbered live ones.** Of the seven statements this PRD
  inventoried as compat-view readers, five were unreachable. Every one was
  written in compat vocabulary, which is why a static count finds them first.
  Step 1 of a slice is not a warm-up.
- **Two objects had to be rescued from the compat file**, and neither announced
  itself. Expect every slice to ask, per object rather than per file: is this a
  translation, or a real thing that happens to live here?
- **Two behaviors were hiding inside triggers.** Migration 14's transcript
  settlement and the replay-dedup index were both real product behavior added
  *after* the cutover, inside compatibility objects. A slice that reads its
  triggers as pure translation will drop working behavior.
- **Tests certified the dead arm.** `attachment-tool-receipts.test.ts` covered
  only the unreachable implementation, against a schema D1 has not had since
  0090. Deleting dead code without checking what covers it leaves the live path
  bare. Two other assertions turned out to be reading their own fixtures.
- **The vocabulary does not vanish, it relocates.** `ToolInvocationSchema` is a
  published wire contract in the compat spellings, so the translation moved into
  the Worker-side port rather than disappearing. Every slice with a contract
  behind it will pay this.

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

All three of this PRD's original open questions have been answered by tracing the
code rather than by deciding. They are kept, with their answers, because each was
resolved in a way that changes the plan.

1. **Does `packages/db/src/index.ts` need to move before slice 4?** ~~Unresolved.~~
   **Yes — it is routed.** `message_mentions` is in both `LOCAL_TABLES` and
   `TABLE_REWRITES`, and every live caller of the three projections reaches them
   through a work-stream-routed handle. Two specifics for whoever scopes slice 4:
   `workstream-service.ts`'s `appendWakeupSystemMessage` reads
   `createDatabase(env.DB)` on a plain parameter and looks unrouted — it is
   wrapped two frames up inside the object, and is the one path routed
   *unconditionally*, through a local executor rather than an RPC hop. And
   `listMessagesAfter` has zero callers repo-wide; slice 4 deletes it rather than
   converting it.

   The gate itself is slice 4's real work. `workstreamExecutionEnvironment` wraps
   only when `phase === 'durable_object_open'`, and the unrouted branch is
   unreachable-but-live: 0090 dropped both `messages` and `message_mentions` from
   D1, so that branch would fail with `no such table` rather than read stale
   rows. Retiring the layer means retiring the gate.

2. **Do `_runtime_users`'s readers need a display name the object does not
   hold?** ~~Unresolved; decides whether goal 6 is a projection change or a
   rendering change.~~ **Neither. Nothing renders it.** Only one of the two
   readers is live, and its `author_name` goes into an LLM prompt, not into
   `packages/contracts` and not to the client. The rendered author name comes
   from a separate regional-D1 join inside the object. The identity slice adds
   no projection and changes no rendering; it should instead record in the compat
   schema that `_runtime_users.name` is a placeholder nothing renders, so the
   next reader does not denormalize display names into `participants` and create
   a staleable second copy the read path never consults. Separately and
   cheaply: stop feeding a bare UUID to the description model as `authorName`,
   which is prompt noise that could be echoed into a user-visible description.

3. **Does the workspace side want a smaller port shape?** ~~Worth deciding once
   slice 1 has landed.~~ **No — keep all three modules.** The premise was right:
   `workspace-runtime-sql.ts` has no `TABLE_REWRITES` at all, against 25 on the
   work-stream side, so a workspace slice translates no vocabulary. But
   translation is only one of the protocol module's four jobs and the only one
   that lapses. The `Exhaustive<T>` guard is about the dispatch list covering the
   storage class; the identity re-check guards a misrouted stub; and the
   directory-effect record is *more* load-bearing there, not less — WorkspaceDO
   holds four outboxes of its own plus its own alarm schedule, so "does this
   write move a deadline something else reads?" has four more ways to be answered
   wrong.

   What shrinks is the storage class, not the module count. Measured rather than
   estimated: Terminal cost 1,256 + 207 + 169 lines for three tables and tool
   receipts cost 624 + 117 + 110 for three, both carrying translation. A
   workspace slice pays neither the timestamp conversion nor the status remap, so
   its storage class approaches a method-per-statement wrapper — while the
   protocol and port stay near-fixed at roughly 110–200 lines each regardless of
   table count.

### What is genuinely still open

- **How much of the 983 counted statements is dead.** There are 83
  `authority.phase` gates across `apps/api/src`, concentrated in
  `work-opportunity-service.ts` (20), `automation-service.ts` (9) and
  `resource-service.ts` (8). Every dead arm found so far — and this PRD's
  research found five in one pass — was written in compat vocabulary, which is
  why a static count picks them up. The statement figures are therefore inflated
  by an unknown but probably large factor, and step 1 of each slice ("delete the
  dead legacy arms") may be most of the work. This does not change the slice
  boundaries; it means the per-slice estimates should be read as ceilings.
- **Whether `occurrence_key` and `authority_revision` are worth a table
  rebuild.** They are provably dead, and removing them is a
  create-copy-drop-rename on a `STRICT` table. Recommendation: fold into slice
  1's migration, do not spend a version on it alone.
