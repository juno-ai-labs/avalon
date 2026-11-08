# Durable Object SQLite guide

This is Rally's cross-cutting guide to using SQLite-backed Cloudflare Durable
Objects. It covers the platform semantics that are easy to mistake for D1 or
ordinary application SQLite, and the repository practices that keep state
transitions correct as schemas and indexes change.

Read the owning module document as well. For the conversation hierarchy that is
[`workstream-durable-object.md`](workstream-durable-object.md); for shared alarm
coordination it is [`durable-object-alarms.md`](durable-object-alarms.md).

## Start with the authority boundary

A Durable Object is an authority, not a cache in front of D1. Its object ID
defines which ordered state machine owns the data, and its SQLite database is
private to that object instance.

- Choose an object key that matches the consistency domain. In Rally, a
  WorkspaceDO owns workspace-wide product state, including every Canvas and
  Sidekick parent keyed by `parent_id`, an `AgentLoopDO` owns one conversation,
  and each agent object owns its own execution state.
- Do not make cross-object SQL joins or foreign keys. Cross-authority
  relationships travel as IDs through typed RPC, Queue messages, projections,
  receipts, and version fences.
- Do not add a D1 fallback for product state. An empty or stale second copy is a
  silent split brain, not availability.
- Route before querying. A service typed against `D1Database` may receive
  `WorkspaceRuntimeDatabase`, Rally's D1-shaped adapter over WorkspaceDO SQL.
  The TypeScript interface alone does not establish where a query runs.
- Prefer a typed domain RPC over a generic SQL adapter once a table has a
  lifecycle of its own. Keep raw SQL and clocks inside the object, parse both
  sides of the RPC, and return discriminated outcomes plus identities or lease
  tokens. If the generic adapter must continue serving adjacent tables,
  explicitly refuse the typed-only table there so a future raw query fails at
  the boundary rather than quietly reopening the old path.
- Use a Queue for a durable asynchronous handoff and typed RPC when the caller
  needs the object's answer before it can continue. The full decision is in
  [`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md).

All Rally Durable Objects are SQLite-backed. Durable Object key/value storage is
forbidden by repository lint because it creates a second, implicit data model
outside the checked-in schema and migrations.

## Schema and migrations

Treat each object's schema as production data, even when there are only a few
objects today.

- Keep schema creation and every subsequent change in the object's ordered,
  versioned migration list. Never patch a production object opportunistically
  from a request handler.
- Run migration work synchronously while initialization blocks concurrent
  events. Do not perform network I/O or await another authority from inside a
  SQLite transaction.
- Prefer `STRICT` tables, explicit `NOT NULL` and `CHECK` constraints, stable
  primary keys, and foreign keys only within the same object database.
- Store time consistently with the owning schema. Conversation-down native
  schemas use integer Unix milliseconds, while WorkspaceDO's imported
  workspace schema retains ISO strings; do not mix representations within one
  table or state machine.
- Add an index for a demonstrated access path or invariant, not as speculative
  tuning. An index is observable write work and can change `rowsWritten` even
  though no domain transition changed.
- A migration must preserve data and invariants for an object upgrading from
  every previously shipped version. A fresh-schema test is not enough.
- Never edit an already shipped migration. Add the next version so existing and
  newly created objects converge on the same schema.
- **Do not rely on `foreignKeys: "disabled_during_rebuild"` for a new
  migration.** `PRAGMA foreign_keys = OFF` is silently a no-op once anything in
  the same object event has touched SQLite, which by the time the runner reaches
  a group is always. A parent rebuild written against it therefore runs with
  enforcement *on*, and `DROP TABLE` then fires every `ON DELETE CASCADE`
  beneath it for real. To replace a referenced parent, copy each dependent into
  a scratch table, **empty every dependent**, replace the parent, re-insert the
  dependents from their copies, and drop the copies — all with enforcement on.
  Emptying them first is not tidiness: a dependent whose foreign key declares no
  `ON DELETE` action is not cascaded by the parent's `DROP TABLE`, it **aborts
  it**, so a rebuild written in the other order fails on the one class of
  dependent that does not announce itself in the parent's own DDL. WorkspaceDO
  migration 31 is the worked example for holding rows without restating a
  dependent's schema — which is the other way a rebuild loses something — and
  migration 55 is the one that had to add the delete pass.

The migration runner and fleet visibility are documented in
[`durable-object-migration-tracking.md`](durable-object-migration-tracking.md).

Rally's shared object runner applies pending migrations in execution groups.
Each group and every receipt for it commit in one `transactionSync`; a crash or
invalid statement cannot leave a half-applied migration with a successful
receipt. New table rebuilds remain valid with foreign-key enforcement enabled:
they create replacements, copy children and parents, remove the old graph
child-first, and then rename the replacements parent-first. The runner executes
`foreign_key_check` before commit. The released v32 transcript migration retains
its explicit legacy execution marker solely to preserve its shipped fingerprint;
new migrations may not copy that mode. Earlier complete groups remain
receipted if a later group fails, and the next construction resumes at the
first unreceipted version.

The ledger itself is created inside the first pending group. Migration hashes
include execution mode because mode changes semantics; the one pre-mode
published conversation-object migration carries an explicit legacy marker only because
its old wrapper already ran it under the identical mode. Tests cover rollback,
resume, invalid legacy declarations, and hash mismatch warnings. A recorded
implementation hash that differs from the current migration emits the structured
`durable_object_schema_hash_mismatch` console warning and construction continues.
The runner leaves the original receipt untouched so the diagnostic remains
truthful. This availability rule does not make edited migration history safe:
only an appended migration can converge old and new object schemas, and an
actual SQL failure still aborts the transaction. A populated-v27
fixture exercises the earlier enforcement-on groups and resource-table rebuild;
a separate populated-v32 fixture crosses the destructive transcript rebuild.
Both upgrade through the real workerd Durable Object storage pipeline and prove
retained rows plus `foreign_key_check`; the v32 case additionally proves
canonical content and child foreign keys after the compatibility tables are
removed. The historical fixture and its upgrade run in separate object events:
the old schema must commit before the new worker wakes, both because that is the
production lifecycle and because a forward migration must begin from the
committed graph a deployed object actually contains.

This behavior is shared by every Rally object with an implementation-hash
receipt: `AgentLoopDO`,
`WorkspaceDO`, and `ArtifactHostDO` all call
this runner. The migration tracker's `MigrationRegistry` uses a separate
version-only bootstrap, `MigrationProbeDO` is intentionally empty, and an
artifact facet's schema is model-owned data; none of those three has a
hash-mismatch error state to relax.

## Transactions and object events

Durable Object event ordering gives one object a natural serialization point,
but each state transition still needs an explicit atomic boundary.

- Keep all SQL that establishes one invariant in a synchronous
  `storage.transactionSync` callback, or in one statement when SQLite can
  express it.
- A synchronous transaction callback must not be declared `async` **or return a
  Promise indirectly**. Calling an async helper without `await` is still wrong:
  the callback returns before that helper's post-`await` SQL runs, so the
  transaction can commit only its earlier writes and the helper can later write
  outside the transaction. Rally's `commitRuntimeMutation` and
  `commitWithRegionalEffects` callbacks have the same restriction because they
  execute inside `transactionSync`.
- Split mixed work into **prepare asynchronously, commit synchronously**. Do
  hashing, provider work, serialization that can yield, and other asynchronous
  preparation before entering the callback. Pass the prepared value into a
  callback that performs only synchronous reads and writes, and re-check every
  authority fence or source version whose truth could have changed while
  preparation yielded.
- Do not put `await`, provider calls, Queue sends, or cross-object RPC inside a
  SQLite transaction. Persist an outbox row atomically with the product change,
  commit, and perform the external effect afterward.
- Fence every late writer with the lease, attempt, generation, or expected
  version it acquired. Object serialization does not stop work resumed after an
  `await` from becoming stale relative to a newer event.
- Persist the kind of claimant when takeover rules differ by orchestrator. Do
  not infer Workflow versus Queue ownership from an ID prefix, timeout, or
  caller-supplied template. A migration may deliberately assign semantic
  meaning to `NULL` for pre-migration rows when the set of possible historical
  writers proves that meaning; document and runtime-test that cutover fact.
- Return a typed domain outcome from object-owned lifecycle methods. Outcomes
  such as `claimed`, `busy`, `settled`, `superseded`, and `already_committed`
  are more stable than exposing SQL counters to callers.
- Let the object own lifecycle time and randomness when the caller has no
  domain reason to choose them. A claim RPC should generate its lease and
  expiry inside the authority and return the lease; transition RPCs should
  accept that lease as their fence. This removes caller-supplied timestamps and
  lease formats from the invariant.
- Make replay explicit. Unique constraints, immutable payload hashes, receipts,
  and idempotent terminal transitions should make the repeated request converge
  rather than repeat its side effect.

When an external effect cannot commit atomically with object state, use the
durable outbox pattern: commit intent with the product mutation, claim it with a
lease, deliver with a provider idempotency key, then record a terminal outcome.
Queue acknowledgement proves only that the Queue delivery ran; it does not
prove the outbox reached Slack, email, or another provider.

## Mutation outcomes: use returned witnesses

Do not derive a logical Durable Object transition from
`SqlStorageCursor.rowsWritten`, or from a D1-shaped `meta.changes` value backed
by that counter.

The similar-looking counters have different contracts:

| Surface | Counter | What it can establish |
| --- | --- | --- |
| Regional D1 | `D1Result.meta.changes` | D1's affected-row result for that statement. |
| Durable Object `SqlStorage` | `SqlStorageCursor.rowsWritten` | Physical database writes observed by workerd. Index maintenance can make one logical row report more than one write. |
| WorkspaceDO D1-shaped adapter | `D1Result.meta.changes` | The same physical `rowsWritten` value, preserved for diagnostics and compatibility. The D1 property name does not change its meaning. |
| SQLite `changes()` in a Node double | `changes()` | Logical rows changed by the statement. This can hide a production bug caused by the workerd counter. |

Mutation SQL must return a domain witness whenever later behavior depends on
which row changed or which transition won.

- A claim or compare-and-swap uses `UPDATE ... RETURNING` and returns the row's
  identity plus the new lease, revision, or ownership token. Verify both.
- A conditional delete uses `DELETE ... RETURNING <primary key>`. Exact progress
  is the number of returned identities, not `rowsWritten`.
- An insert whose duplicate branch matters uses `INSERT ... RETURNING`, a
  follow-up read under the same object event, or a typed method with a
  discriminated outcome.
- `rowsWritten === 0` versus `rowsWritten > 0` can answer only the narrow
  physical question "did this statement write anything?" Index writes preserve
  that distinction. It must not establish identity, lease ownership, an exact
  count, or which branch of a transition occurred. Prefer a returned witness
  for new code even in this case.

Changing `=== 1` to `> 0` is not the general repair. It survives index inflation
but still asks a storage side effect to stand in for the domain fact.

Wrong:

```ts
const claim = await database.prepare(
  `UPDATE jobs SET lease_id = ? WHERE id = ? AND state = 'pending'`,
).bind(leaseId, jobId).run();

if (claim.meta.changes !== 1) return "busy";
```

Right:

```ts
const claim = await database.prepare(
  `UPDATE jobs
      SET lease_id = ?
    WHERE id = ? AND state = 'pending'
    RETURNING id, lease_id`,
).bind(leaseId, jobId).first<{ id: string; lease_id: string }>();

if (claim?.id !== jobId || claim.lease_id !== leaseId) return "busy";
```

The production notification incident demonstrated the difference. A claim
updated one `workstream_notification_intents` row, including columns covered by
two indexes. The claim succeeded, but workerd reported multiple writes. Code
requiring `meta.changes === 1` treated its own lease as a competing lease,
returned `busy`, and never called a connector.

The durable repair is stronger than using `RETURNING` through the same generic
adapter. WorkspaceDO now owns claim, defer, failure, settlement, retention due
time, and reaping as typed notification RPCs. The Worker can observe only
domain outcomes and exact returned IDs; the generic WorkspaceDO SQL port
rejects `workstream_notification_intents` outright. That makes
`SqlStorageCursor.rowsWritten` unavailable to notification callers, so this
category cannot recur through a different branch of the same lifecycle.

## Queries, cursors, and SQL construction

- Consume a `SqlStorageCursor` deliberately with iteration, `.one()`, or
  `.toArray()`. Do not assume a statement that returns no rows made no change.
- Select only the columns the domain method returns. Parse stored JSON and
  validate untrusted or versioned values at the boundary rather than casting a
  row into correctness.
- Bind all values. SQL parameters cannot bind table names, column names, sort
  directions, or fragments; any dynamic identifier must come from a closed
  code-owned allowlist. Fixed predicate fragments may also be selected from
  code-owned literals; keep their positional bindings aligned and never
  interpolate request values.
- Optional predicates such as `(? IS NULL OR sequence > ?)` can prevent a
  primary-key range seek. Select a direct range predicate when the cursor exists
  and verify actual workerd `rowsRead` on populated history, including an empty
  page. An existing index alone does not prove the query uses its lower bound.
- Keep pagination deterministic with a stable tie-breaker, normally the primary
  key. A `LIMIT` without a complete order can skip or repeat rows between alarm
  passes.
- Prefer bounded reads and batches, but do not invent a defensive limit. Follow
  [`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)
  when a new cap, timeout, or ceiling is needed.
- Treat `rowsRead` and `rowsWritten` as operational measurements. They are useful
  for diagnostics and cost reasoning, not as a domain API.

The one intentional raw-SQL exception is the Access-protected engineering MCP.
Inspectable objects inherit `runInspectionSql` from a shared internal base so an
admitted operator can reproduce Cloudflare's database console: every scheduling
authority picks it up beneath the scheduler, and `ArtifactHostDO` names that
base directly because it is not one. Product callers must never use that RPC;
routing, cross-region handling, logging exclusions, and destructive-tool
semantics live in [`engineering-mcp.md`](engineering-mcp.md).

## Alarms and background work

A Durable Object has one platform alarm. Rally multiplexes logical wake reasons
through `_internal_durable_alarms`; a feature must register with that coordinator
rather than overwrite `storage.setAlarm` independently.

Alarm work should be bounded, durable, and resumable:

- derive the next alarm from persisted work;
- claim rows with a fenced lease before leaving the object for external work;
- record progress or failure before scheduling the next attempt;
- re-arm from remaining persisted work, including after a partial pass; and
- make terminal rows distinguishable from retryable rows so a drained Queue or
  quiet alarm cannot be mistaken for delivery.

See [`durable-object-alarms.md`](durable-object-alarms.md) for the coordinator's
ordering and retry contract.

## Testing what production runs

Node SQLite tests are valuable for predicates, constraints, migrations, and
query result mapping. They are not evidence for Durable Object runtime
semantics: `changes()` in a Node double is exactly what hid the indexed-write
notification defect.

Put runtime-dependent coverage in `apps/api/test-workers/`:

1. Execute through the real Durable Object binding and workerd-backed storage.
2. Create the schema the test needs; the Workers suite starts without D1
   migrations.
3. For a mutation-outcome test, include an index on a changed column so physical
   writes differ from logical rows.
4. Assert the domain outcome and stored fence, not the test fixture's counter.
5. Prove the test can fail by temporarily restoring the incorrect decision and
   observing the named domain failure — this is a rung-1 test, so
   [the rule](testing.md#prove-the-test-can-fail) applies in full.

Use `runInDurableObject` only for inspection or runtime setup that cannot be
expressed through the public object contract. Product behavior should enter
through the same binding or RPC that production uses. The complete suite map is
in [`testing.md`](testing.md).

## Review checklist

Before merging Durable Object SQLite work:

1. Is this the correct object authority and object key?
2. Does every table and migration belong to that one authority?
3. Is the invariant committed in one synchronous transaction or one statement?
4. Can the transaction callback return a Promise, including through a helper,
   dynamic dispatch, `.call()`, or `.apply()`? If preparation can yield, is it
   complete before the callback begins?
5. Does work after an `await` carry and verify a lease, attempt, generation, or
   expected version?
6. Does every externally visible side effect have a durable intent and a
   terminal outcome?
7. Do claims, compare-and-swaps, and exact counts use returned identities and
   tokens instead of `rowsWritten` or adapter `meta.changes`?
8. Are values bound and dynamic identifiers closed over code-owned choices?
9. Are pagination and alarm passes deterministic, bounded, and resumable?
10. Does a real-workerd test cover the platform behavior, and was that test
   proved capable of failing?
11. Are the owning module document and its running changelog updated with the
    reason for the change?

As an audit aid, search affected paths for `meta.changes`, `rowsWritten`,
`changes()`, `transactionSync`, raw SQL interpolation, `setAlarm`, and calls that
leave the object. Classify each occurrence by authority and domain purpose; do
not replace counters mechanically without understanding the transition they
were trying to represent.

`rally/durable-object-sync-transaction` is a type-aware backstop for direct and
indirect Promise returns from `transactionSync`, `commitRuntimeMutation`, and
`commitWithRegionalEffects` callbacks. It cannot prove a callee is synchronous
after its return type has been erased to `unknown` or `any`; dynamically indexed
methods and `.call()`/`.apply()` inside these callbacks therefore remain a
mandatory review target. Do not silence the rule or cast a Promise-shaped result
to make it pass—make the prepare/commit split explicit instead.

`rally/durable-object-workspace-table-routing` fails lint when a Durable Object
names a `WORKSPACE_LOCAL_TABLES` table on its own `this.env.DB`, which is regional
D1 and answers `no such table` as a `500 internal_error`. It sees only literal
SQL, so a statement built elsewhere or an aliased binding is still a review
target. Route such a read through a typed WorkspaceDO method or
`withWorkspaceRuntimeDatabase`; inside WorkspaceDO itself use `runWorkspaceSql`
or `localWorkspaceEnv`, because `withWorkspaceRuntimeDatabase` without the local
executor calls the object back.

## Changelog

### 2026-09-21 — A migration fingerprint cannot take an object offline

**What changed:** A stored implementation hash that differs from the current
migration now emits a structured console warning containing the component,
version, recorded hash, and current hash, then lets initialization continue.
The exact-receipt compatibility escape hatch is removed because every mismatch
has the same non-blocking behavior.

**Why:** A comment-only edit to ArtifactHostDO migration 1 made every existing
live page unavailable even though its schema was usable. The fingerprint caught
the edit, but turning that evidence into a permanent constructor failure made a
diagnostic guard more destructive than the condition it diagnosed.

**Considered and rejected:** Maintaining an allowlist for each harmless edit.
That still makes an unanticipated mismatch an outage and requires recovery code
before users can reach otherwise valid state. Removing the fingerprint entirely
would lose the evidence needed to find migration-history mistakes.

**Consequences:** Hash drift remains visible in Workers Logs for every Rally
object that has a hashed migration receipt, and the persisted receipt remains
unchanged, but drift is no longer a migration failure reported to the fleet
tracker. Objects without hash receipts had no corresponding error path to
change. Append-only migrations remain mandatory: if schemas are actually
incompatible, the concrete SQL operation that cannot run still fails with its
real error instead of a checksum proxy.

### 2026-09-21 — Admit one proven schema-equivalent migration receipt

**What changed:** The shared runner can accept an exact, migration-local list of
historical implementation hashes while retaining the canonical published hash.
The owning migration test must pin both the canonical history and each accepted
receipt.

**Why:** One ArtifactHostDO deployment changed only a comment inside released
migration SQL. Existing objects retained the original receipt, while any object
first initialized during that window could retain the comment-only fingerprint.
Restoring the published bytes repairs the first cohort but, without an explicit
equivalence, strands the second.

**Considered and rejected:** Rewriting receipts, appending a schema-free
migration, or disabling hash enforcement. The first two obscure what executed;
the last allows unrelated edited history. An exact code-owned exception keeps
unknown hashes fail-closed.

**Consequences:** Compatibility hashes require evidence that the released SQL
is schema-equivalent and a negative-control integration test proving that only
the named receipt passes. They are recovery metadata, not a routine migration
mechanism; real schema changes still append a migration.

### 2026-09-09 — Preserve cursor range seeks

**What changed:** Added guidance for optional cursor predicates and fixed,
code-owned SQL fragments with aligned bindings.

**Why:** Workspace activity pagination read 108,665 rows for an empty window
because an optional-parameter OR prevented its primary-key lower-bound seek.

**Considered and rejected:** An additional index: the existing primary key
already supports the direct range, without adding index writes or a migration.

**Consequences:** Check physical rows read, not only returned rows. Avoid
reintroducing an optional OR that hides a range from SQLite's planner.

Shipped in [#628](https://github.com/juno-ai-labs/avalon/pull/628).


### 2026-09-03 — Disabling foreign keys for a rebuild does not work

**What changed:** The schema guidance above now tells a new migration not to
reach for `foreignKeys: "disabled_during_rebuild"`, and gives the hold-and-
restore recipe for replacing a referenced parent with enforcement left on.

**Why:** A first draft of WorkspaceDO migration 31 replaced
`connector_connections` under that mode and lost a workspace's webhook receipts.
`PRAGMA foreign_keys` is documented as a no-op inside a transaction, and a
Durable Object event holds one implicitly from its first statement onwards — so
the pragma the runner issues before the group flips nothing, and the parent's
drop cascades. Measured directly in workerd: the pragma reads back `0` as the
first statement of an event and `1` once any SQL has run.

**Considered and rejected:** Making the runner assert the pragma took effect and
fail loudly. That turns a silent data loss into a loud failure, which is better,
but it leaves no way to perform the rebuild at all — and there is one that does
not need the pragma. The released migrations that carry the mode are left alone:
their statements are hashed into every deployed object's receipt.

**Consequences:** The mode still exists for those released migrations and must
not be used again. Any rebuild of a referenced parent needs a populated workerd
upgrade test that asserts a dependent's rows *survive*, because a fresh-schema
test passes either way — which is exactly how this was found.



### 2026-08-30 — Document the operator-only raw-SQL exception

**What changed:** Scheduled Durable Objects now inherit one unrestricted
inspection RPC beneath the scheduler for the engineering MCP.

**Why:** Agents need the same production diagnosis and repair capability as the
Cloudflare dashboard without creating per-class SQL methods or copying object
state elsewhere.

**Considered and rejected:** Making generic SQL a product contract would bypass
each authority's domain invariants. A read-only restriction would not reproduce
the repair capability that motivated the console.

**Consequences:** The RPC is internal operator infrastructure only, remains
destructive by design, and requires real-workerd coverage for every exposed
authority class. Domain code continues to use typed RPC outcomes.

### 2026-08-27 — Migration execution mode is receipted and runtime-tested

**What changed:** The guide now specifies transactional migration groups,
foreign-key rebuild mode, ledger bootstrap, partial-failure resume, and the
real-workerd populated-schema test required for destructive object migrations.

**Why:** Node SQLite proved the SQL but not workerd's Durable Object transaction
and PRAGMA behavior. The ordered-transcript migration replaces referenced
parents and deletes its compatibility tables, so a fresh-schema unit test could
pass while an existing populated object lost relationships or failed during
activation.

**Considered and rejected:** One transaction for the entire history cannot
change foreign-key enforcement where SQLite requires it outside the transaction.
Running every migration independently creates more partial-upgrade boundaries
than the execution modes require.

**Consequences:** Migrations with the same mode are atomic as a group; completed
groups are the only resumable boundaries. A referenced-table rebuild must opt in,
must pass `foreign_key_check`, and must have a populated workerd upgrade test.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).

### 2026-08-27 — Promise-returning callbacks cannot cross synchronous transactions

**What changed:** The transaction guidance now requires asynchronous
preparation to finish before `transactionSync` or either Rally wrapper enters
SQLite, and the review checklist calls out indirect and dynamically dispatched
Promise returns. A type-aware ESLint rule rejects explicit async callbacks and
callbacks whose return type can be a Promise.

**Why:** Four transcript-producing operations performed asynchronous payload
preparation through a callback passed to `commitRuntimeMutation`. The enclosing
`transactionSync` committed the regional projection before those continuations
wrote the canonical payload, separating facts that were required to be one
SQLite commit.

**Considered and rejected:** Documenting only `await` inside the callback and
relying only on lint. An async helper returns a Promise even when no `await`
appears at the call site, while dynamic dispatch can erase the return type that
static analysis needs. The rule is a backstop; explicit prepare-then-commit
structure and review remain the invariant.

**Consequences:** Async hashing, provider work, and other yielding preparation
must happen before the transaction. The synchronous phase revalidates stale
inputs and commits the canonical fact, transcript/root state, and regional
projection together. Reviewers search dynamic calls manually when the type is
not statically knowable.

### 2026-08-26 — Persist claimant kind when lease semantics differ

**What changed:** The guide now requires an explicit stored orchestrator when
different claimant kinds have different safe takeover rules, and permits a
documented `NULL` compatibility meaning only when historical writers make it
unambiguous.

**Why:** A Queue handler has one bounded invocation, while a durable Workflow
can perform several independently timed retry attempts. Giving both the same
elapsed-time lease can let Queue processing overlap a still-live Workflow, and
guessing the claimant from an ID format repeats the external-identifier mistake
that typed protocols were meant to remove.

**Considered and rejected:** Extending every Workflow lease to a calculated
duration. Scheduling gaps are not bounded by the sum of configured attempt
timeouts, so a larger guessed number still cannot prove the old handler stopped.

**Consequences:** Takeover decisions read authoritative claimant kind alongside
the lease. Compatibility migrations and real-workerd tests must prove how rows
created before the discriminator are interpreted.

### 2026-08-26 — Domain RPCs close the notification SQL compatibility path

**What changed:** WorkspaceDO now exposes runtime-validated claim, transition,
maintenance-target, and reap RPCs for `workstream_notification_intents`. The
delivery service and workspace alarm use those outcomes, and the generic
WorkspaceDO SQL executor refuses the table.

**Why:** Returning a lease witness repaired the immediate indexed-write bug but
still left every notification branch able to reinterpret a D1-shaped storage
result later. The object already owned the state machine, so SQL was the wrong
cross-boundary contract.

**Considered and rejected:** Keeping generic SQL and relying on review to use
`RETURNING` correctly. That preserves the failure category and makes the next
branch or maintainer rediscover which counters are physical.

**Consequences:** Notification callers cannot observe SQLite counters or write
the table directly. New lifecycle states and transitions must be added to the
typed protocol and object storage together, and runtime tests must prove both
the public outcome and the generic-port refusal.
