# Durable Object SQLite guide

This is Rally's cross-cutting guide to using SQLite-backed Cloudflare Durable
Objects. It covers the platform semantics that are easy to mistake for D1 or
ordinary application SQLite, and the repository practices that keep state
transitions correct as schemas and indexes change.

Read the owning module document as well. For the work-stream hierarchy that is
[`workstream-durable-object.md`](workstream-durable-object.md); for shared alarm
coordination it is [`durable-object-alarms.md`](durable-object-alarms.md).

## Start with the authority boundary

A Durable Object is an authority, not a cache in front of D1. Its object ID
defines which ordered state machine owns the data, and its SQLite database is
private to that object instance.

- Choose an object key that matches the consistency domain. In Rally, a
  WorkspaceDO owns workspace-wide product state, a WorkstreamDO owns one work
  stream, and each agent object owns its own execution state.
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
- Store time consistently with the owning schema. Work-stream-down native
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

The migration runner and fleet visibility are documented in
[`durable-object-migration-tracking.md`](durable-object-migration-tracking.md).

## Transactions and object events

Durable Object event ordering gives one object a natural serialization point,
but each state transition still needs an explicit atomic boundary.

- Keep all SQL that establishes one invariant in a synchronous
  `storage.transactionSync` callback, or in one statement when SQLite can
  express it.
- Do not put `await`, provider calls, Queue sends, or cross-object RPC inside a
  SQLite transaction. Persist an outbox row atomically with the product change,
  commit, and perform the external effect afterward.
- Fence every late writer with the lease, attempt, generation, or expected
  version it acquired. Object serialization does not stop work resumed after an
  `await` from becoming stale relative to a newer event.
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
  code-owned allowlist.
- Keep pagination deterministic with a stable tie-breaker, normally the primary
  key. A `LIMIT` without a complete order can skip or repeat rows between alarm
  passes.
- Prefer bounded reads and batches, but do not invent a defensive limit. Follow
  [`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)
  when a new cap, timeout, or ceiling is needed.
- Treat `rowsRead` and `rowsWritten` as operational measurements. They are useful
  for diagnostics and cost reasoning, not as a domain API.

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
   observing the named domain failure.

Use `runInDurableObject` only for inspection or runtime setup that cannot be
expressed through the public object contract. Product behavior should enter
through the same binding or RPC that production uses. The complete suite map is
in [`testing.md`](testing.md).

## Review checklist

Before merging Durable Object SQLite work:

1. Is this the correct object authority and object key?
2. Does every table and migration belong to that one authority?
3. Is the invariant committed in one synchronous transaction or one statement?
4. Does work after an `await` carry and verify a lease, attempt, generation, or
   expected version?
5. Does every externally visible side effect have a durable intent and a
   terminal outcome?
6. Do claims, compare-and-swaps, and exact counts use returned identities and
   tokens instead of `rowsWritten` or adapter `meta.changes`?
7. Are values bound and dynamic identifiers closed over code-owned choices?
8. Are pagination and alarm passes deterministic, bounded, and resumable?
9. Does a real-workerd test cover the platform behavior, and was that test
   proved capable of failing?
10. Are the owning module document and its running changelog updated with the
    reason for the change?

As an audit aid, search affected paths for `meta.changes`, `rowsWritten`,
`changes()`, `transactionSync`, raw SQL interpolation, `setAlarm`, and calls that
leave the object. Classify each occurrence by authority and domain purpose; do
not replace counters mechanically without understanding the transition they
were trying to represent.

## Changelog

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
