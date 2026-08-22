# Durable Object alarms

Cloudflare gives a Durable Object exactly one alarm. `setAlarm` overwrites
whatever was armed before, so an object with more than one reason to wake — an
outbox retry, a keep-alive, a due schedule, a wake-up a run asked for — has to
decide which reason owns the slot, every time any of them changes. This document
covers the shared capability that makes that decision once: a SQLite-backed list
of scheduled alarms per object, and a base class that keeps the object's single
alarm pointed at the earliest thing on it.

Read this before adding a wake reason to `WorkspaceDO`, `WorkstreamDO`, or
`SubstreamAgent`, before changing when any of them fires, and before giving a
fourth object its own alarm. The objects themselves — their hierarchy, schemas,
sockets, and effects — belong to
[`workstream-durable-object.md`](workstream-durable-object.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/scheduled-alarms.ts` | The whole capability: the `_internal_durable_alarms` schema statements, `ScheduledAlarmStore`, and the `ScheduledDurableObject` base every scheduling object extends. |
| `apps/api/src/durable-objects/workspace-do.ts` | Adopts it for a workspace: due schedules, resource watches, maintenance passes, Terminal deadlines, and the opportunity/ranking product pass. Owns `refreshSchedule`. |
| `apps/api/src/services/workspace-schedule-execution.ts` | What a workspace target actually *does* when it fires — automations, connector polls, digests, watch polls, maintenance, Terminal lifecycle — as plain functions over a context. |
| `apps/api/src/durable-objects/substream-agent.ts` | Adopts it for a work stream's agent: `agent_timer` entries index `workstream_wakeups`, so a wake-up a run scheduled fires from the object that owns it. |
| `apps/api/src/durable-objects/workstream-do.ts` | Adopts it for regional-effect and block-dashboard outboxes, all of which stay derived. |
| `apps/api/src/durable-objects/workspace-scheduler.ts` | The retired per-workspace scheduler object, kept only to hand its surviving alarms to WorkspaceDO. |

## How it works

### Two kinds of wake reason

An object declares what it wants woken for in one of two ways, and the base
takes the earliest of both:

- **A stored entry** — a row in `_internal_durable_alarms`, keyed by `(kind, alarm_key)`,
  with a due instant, an optional repeat interval, and its own retry gate. Use
  this when the thing being scheduled has an identity that can succeed or fail
  on its own: one automation, one resource watch, one agent timer.
- **A derived instant** — `nextDerivedAlarmAt(now)`, computed from the object's
  own tables. Use this when the due time already lives in a table with its own
  writers and no separate identity is needed: an outbox's `MIN(not_before)`, the
  oldest activity event plus its retention, an in-memory keep-alive lease.

The rule of thumb: if it can fail in a way that should hold *it* back without
holding anything else back, it is an entry. If it is "the earliest row in this
table", it is derived.

### Arming

`armNextAlarm()` computes `min(store.nextDueAt(), nextDerivedAlarmAt(now))`,
floors it at `now + 1`, and sets the alarm to exactly that — deleting the alarm
outright when neither source has anything. It is *exact*, not lowering-only:
a helper that only ever pulls an alarm in cannot take one back when the row that
justified it is cancelled, and cannot push one out when a target is deferred.
It writes only when the value actually changes, so a re-arm that concludes
nothing moved costs one `getAlarm`.

**Every path that changes the list re-arms.** `scheduleAlarm`,
`cancelScheduledAlarm`, `cancelScheduledAlarmKind`, and
`reconcileScheduledAlarms` all end in `armNextAlarm()`, so an entry scheduled
before the armed instant pulls the alarm in and the last entry cancelled takes
the alarm with it. Callers schedule and return; nothing waits for the next alarm
to notice.

`ensureAlarmNoLaterThan(dueAt)` is the one lowering-only helper, for a caller
that has just committed durable work and must not lose it if the invocation dies
before a full re-arm.

### Firing

`alarm()` is implemented once, in the base:

1. Wait for the object's migrations (`scheduleReady()`).
2. **Re-arm immediately**, before anything awaited. A cancelled invocation
   neither throws nor runs a `finally`, so an object that re-arms only at the
   end of its handler can be left with no wake-up at all.
3. Ask `scheduledAlarmDeferral(now)` whether the whole alarm should be held —
   the regional-authority gate. A deferral sets the alarm *outright* to the
   recheck instant, because the re-arm in step 2 usually points at an instant
   already past.
4. Drain every entry whose effective instant has come, up to
   `SCHEDULED_ALARM_DRAIN_LIMIT` (100), each through `runScheduledAlarm(entry)`.
5. Run `runDueAlarmWork(now)` — whatever the object derives rather than stores,
   **including re-deriving the whole index**. A handler that just ran has
   usually advanced its own canonical row, and it writes that row through the
   object's local executor, which does not pass the auto-refresh in
   `executeRuntimeSql`. Without a reconcile here, the drain settles the entry it
   just ran and nothing arms the occurrence that replaced it: a recurring
   automation fires exactly once.
6. Re-arm.

An entry that returns is settled: a one-shot is deleted, a repeating one
advances to the first occurrence strictly *after* now (an object that hibernated
through six hours of a five-minute repeat fires once, not seventy-two times).
Both are guarded on the instant that ran, so a handler that rescheduled its own
entry keeps the wake-up it asked for.

An entry that throws is deferred: its attempt count goes up and its `retry_at`
moves out by an equal-jitter exponential backoff, from one minute to a
thirty-minute ceiling. Its siblings in the same drain are unaffected.

### Reconciling an index

Some due times are canonical somewhere else — `schedules.next_run_at`,
`resource_watches.next_poll_at`, `workstream_wakeups.due_at` — and their writers
reach those tables through routed SQL, with no idea an alarm index exists.
`reconcile(kind, targets)` makes one kind's entries exactly the given set:
survivors keep their retry gates, vanished keys are deleted, and new ones are
added. The surviving keys are bound as one JSON value and matched with
`json_each`, not as one bound parameter each — workerd's bound-variable ceiling
is well below the number of targets a real workspace has, and exceeding it threw
`too many SQL variables` and rolled back the whole index. Reconciling is what
lets a wake-up scheduled *before* the armed alarm pull the alarm in, and a
cancelled schedule push it back out, without every writer knowing about
`_internal_durable_alarms`.

Two objects do this: `WorkspaceDO.refreshSchedule` (from
`workspaceScheduleTargets`) and `SubstreamAgent.syncAgentTimerAlarms` (from its
own pending wake-ups).

### The workspace's schedule

`WorkspaceDO.refreshSchedule(workspaceId)` is called after any mutation that can
move a due time — including automatically from `executeRuntimeSql` when a
statement touches one of the alarm-source tables. It reconciles four kinds:

| Kind | Key | Source |
| --- | --- | --- |
| `schedule` | schedule id | `schedules`, enabled with a `next_run_at` |
| `watch` | watch id | `resource_watches`, enabled with a `next_poll_at` |
| `maintenance` | task name | the oldest row of whichever tables that task reaps |
| `terminal` | work-stream id | `workspace_workstream_directory.next_terminal_action_at` |

A fifth kind, `product`, is scheduled directly rather than reconciled: the
opportunity and ranking pass wants its instant computed differently depending on
the caller (an enqueue wants a past-due instant honoured; the alarm that
launched nothing wants past-due rows left parked behind a dormant member), and a
derived source has no way to carry that distinction.

## Invariants

- **An object never derives its alarm outside this base.** A second derivation
  of "the earliest thing" will disagree with the base's, and the disagreement
  shows up as work that silently never runs. Two call sites do still arm
  directly, and both are deliberate: `enqueueAgentRun` and
  `WorkstreamObjectStore.enqueueRegionalEffect` each set an *immediate* alarm
  the instant they commit durable work, so an isolate that dies before the full
  re-arm cannot strand it. Both can only pull the alarm in, never push it out,
  and the next `armNextAlarm` corrects the instant. Anything that would arm for
  a *future* time belongs in the base.
- **Whatever ran, re-derive before the alarm ends.** A handler that advances its
  own source row has invalidated the index, and the settle that follows it
  deletes the only entry pointing at that row. `WorkspaceDO.runDueAlarmWork`
  reconciles for exactly this reason; an object that grows stored entries whose
  handlers write their own next occurrence has to do the same.
- **Every mutation of the entry list re-arms before returning.** A caller that
  schedules an entry and returns without arming has written a row nothing will
  ever read.
- **The alarm is exact, and floored at `now + 1`.** An alarm set to a past
  instant fires immediately and re-derives the same past instant: that is the
  shape every hot-alarm loop in this codebase has had.
- **Entries sharing an instant are totally ordered.** The due query and
  `nextDueAt` order by `MAX(due_at, retry_at)` and then by the primary key, so a
  tie larger than `SCHEDULED_ALARM_DRAIN_LIMIT` is sliced into consecutive wakes
  that partition it. Ordering on the instant alone would leave the tie-break to
  SQLite, and the same rows could come back on every wake while others never
  ran.
- **A failing entry is gated before its failure is reported.** The gate is
  persisted first precisely because the reporting path can throw; reversed, an
  exception in a log or audit write leaves the entry due again a millisecond
  later.
- **An entry is an index, never a record.** `workstream_wakeups` still owns a
  wake-up's status, principal, and prompt; `schedules` still owns a schedule.
  Every handler reloads its row and treats a row that is gone or no longer
  pending as a no-op — that is what makes a cancellation racing an alarm safe.
- **A stored entry with no handler throws.** Silently settling an unknown kind
  would turn a caller's mistake into work that vanishes; the retry gate makes it
  visible in `_internal_durable_alarms` instead.
- **`_internal_durable_alarms` arrives through each object's own migration ledger.** The
  statements are shared from one constant, but each object applies them as a new
  version of its own append-only history; editing an existing version's SQL
  strands every deployed object on a hash mismatch.

## Boundary

The capability owns *when* an object wakes and *which* entry runs. It owns
nothing about what a handler does: `runScheduledAlarm` is the subclass's, and
for a workspace that dispatch lands in
`apps/api/src/services/workspace-schedule-execution.ts`.

It is not a job queue. There is no cross-object fan-out, no priority, no
ordering guarantee beyond "earliest effective instant first", and no delivery
outside the object that stored the entry. Work that has to cross an object
boundary goes on a Queue — [`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md)
has the reasoning.

Callers outside the objects touch this only through
`refreshWorkspaceSchedulerAlarm` and `refreshAgentTimerAlarm` in
`apps/api/src/services/workstream-wakeup-service.ts`, which are the two "a due
time moved, go reconcile" entry points.

## Failure modes and limits

- **A handler throws.** That entry alone is held behind an equal-jitter
  exponential gate: 1 minute, doubling to a 30-minute ceiling, with half of each
  delay randomized so a whole region does not retry a shared dependency in the
  same millisecond. It keeps its due time, so a target that recovers runs at the
  next drain rather than being rescheduled from scratch.
- **A workspace target fails.** In addition to the gate, `schedule` and `watch`
  failures write a `schedule.failed` / `resource_watch.failed` audit event. That
  write is fire-and-forget: the gate is already durable, and losing the audit
  row to an eviction costs an operator one line.
- **More than 100 entries are due at once.** The first 100 run and the re-arm
  points at the next instant, which is already past, so the rest run in the
  following wake. Nothing is dropped; the cost is one extra alarm.
- **The region is closed for maintenance.** `scheduledAlarmDeferral` holds the
  whole drain and rechecks every 5 minutes. Entries keep their due times, so a
  workspace whose entire schedule is overdue resumes when the region reopens.
- **A repeating entry falls far behind.** It fires once and advances past every
  missed occurrence. Catch-up is deliberately not offered; a caller that needs
  every occurrence has to store them as separate entries.
- **The alarm handler itself throws.** The runtime retries it six times with its
  own backoff. Because step 2 re-arms before any awaited work, a throw after
  that point still leaves a wake-up armed.

## Data model

`_internal_durable_alarms`, identical in all three objects:

| Column | Meaning |
| --- | --- |
| `kind`, `alarm_key` | Composite primary key. `kind` selects the handler; `alarm_key` is the target's own id. |
| `due_at` | When the entry is meant to run, owned by whoever scheduled it. |
| `repeat_every_ms` | `NULL` for a one-shot; otherwise the interval it re-arms on. |
| `retry_at` | Backoff gate owned by the drain, `0` until the entry first fails. |
| `attempt` | Consecutive failures, reset on success and on a reschedule. |
| `payload_json` | Opaque to the store; free for a handler that needs more than a key. |

The *effective* instant is `MAX(due_at, retry_at)`, which is what the index,
the due query, and `nextDueAt()` all order by. Keeping the schedule and the gate
in separate columns is what lets a reconcile rewrite due times without granting
a failing target a free immediate attempt.

## Testing

- `apps/api/test-workers/scheduled-alarms.test.ts` runs on real workerd
  (`pnpm --filter @avalon/api test:workers`) and is the authority for this
  module: only that runtime has real `setAlarm`/`getAlarm` semantics, alarm
  handler invocation, and SQLite. It covers arming exactly, pulling an alarm in
  when an earlier entry is scheduled, pushing it back out and deleting it when
  entries are cancelled, per-entry backoff isolation, repeat advancement,
  draining a tie wider than one wake allows, and the agent-timer index.
- `apps/api/test/runtime-components.test.ts` covers the pure arithmetic —
  recurrence and backoff — in the Node suite.
- Driving an alarm in a test: `runDurableObjectAlarm(stub)` from
  `cloudflare:test` invokes the handler and reports whether one was armed.
  Reading state afterwards needs `runInDurableObject`, because a stored entry is
  object-local SQL with no RPC surface.
- Trap: `getAlarm()` returns `null` inside a running alarm handler until
  `setAlarm` is called again. A test that asserts on the armed instant has to do
  it after the handler returns, not from inside one.
- Trap: an alarm armed for `now + 1` — which `enqueueAgentRun` does on purpose —
  fires while the test is still setting up, and the work it drains can settle
  the very rows the next assertion reads. Park it in the *same* invocation that
  arms it (`runInDurableObject`, call `fetch`, then `setAlarm` before the
  callback returns); two separate calls leave a window the drain can win, which
  is how `agent-run-lifecycle.test.ts` became intermittent.

## Changelog

### 2026-08-21 — One alarm list per object, and the workspace scheduler retires into WorkspaceDO

**What changed:** New `ScheduledDurableObject` base and `_internal_durable_alarms` table,
adopted by `WorkspaceDO`, `WorkstreamDO`, and `SubstreamAgent` (schema versions
4, 2, and 14 respectively). The `WorkspaceScheduler` Durable Object's work —
due schedules, resource watches, maintenance passes, and Terminal deadlines —
moved into WorkspaceDO as reconciled entries, with its execution code extracted
to `services/workspace-schedule-execution.ts`; the class survives only to hand
its already-armed alarms over and then clear itself. The SubstreamAgent's agent
timers moved from "derive `MIN(due_at)` and fire the single earliest wake-up"
to one entry per pending wake-up.

**Why:** Three objects had each grown their own copy of the same arithmetic and
the copies had drifted. Two of them lowered the alarm but never raised it, so a
cancelled row left the object waking for nothing and — worse — a target deferred
behind a retry gate could leave the alarm pointing at an instant nothing was
behind. The SubstreamAgent fired one timer per alarm, so ten wake-ups due at the
same instant took ten alarms to drain, each a full cold start. And the workspace
scheduler was a second object holding an alarm for tables it did not own: every
tick meant routed SQL back into WorkspaceDO plus an RPC to its directory, and
every writer had to remember to poke a *different* object or watch its row go
dark. Putting the alarm in the object that owns the rows removes that whole
class of bug, and doing it once in a base class is what stops the copies from
diverging again.

The rejected alternative was to keep the scheduler object and give it the
multi-alarm store. It would have been a smaller diff, and it would have kept the
property that made the drift possible: two objects with two derivations of one
workspace's next instant.

Per-target retry gates were kept rather than simplified into a single object-wide
backoff. `scheduler_retry_states` existed because one broken automation used to
be able to hot-loop a workspace's alarm; that hazard is unchanged, and the gate
now lives in the same row as the schedule it guards, which is why a reconcile
can rewrite due times without resetting it.

Two dead pre-cutover paths went with the move: the legacy-phase wake-up drain,
which read a regional `workstream_wakeups` table that migration `0090` dropped
and which was unreachable in the `durable_object_open` phase, and
`runIsolatedSchedulerMaintenance`, whose whole job — one failing sweep must not
take its siblings down — is now a property of the drain itself. Maintenance is
also no longer all-or-nothing per alarm: each pass is its own entry with its own
due time, so a Slack reap that has been failing for an hour no longer re-runs
the memory-index outbox every time it retries.

### 2026-08-22 — Same-instant entries are an ordering guarantee, not an accident

**What changed:** No behaviour. The total order the due query already had —
effective instant, then `kind`, then `alarm_key` — is now written down as an
invariant, and `scheduled-alarms.test.ts` drains a tie of
`SCHEDULED_ALARM_DRAIN_LIMIT * 2 + 5` entries sharing one millisecond, asserting
each runs exactly once across the three wakes it takes.

**Why:** The drain limit and the tie-break were two independent decisions, and
nothing tied them together: the limit is only safe because the ordering makes
consecutive slices partition the tie. Ordered on the instant alone the query is
still correct for a tie that fits in one wake, so the defect would only appear on
the workspace whose whole digest fan-out lands on the hour — the case with the
least tolerance for a wake-up that never comes. A future change may widen the
`ORDER BY`, but it may not drop the primary key from it.
