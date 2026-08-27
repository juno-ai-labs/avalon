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
| `apps/api/src/durable-objects/scheduled-alarm-report.ts` | How a gated entry is reported, whichever object holds it: the attempt that warns, the one that logs an error, the one that notifies an operator, and what of a thrown error may leave. |
| `apps/api/src/durable-objects/scheduled-alarms.ts` | The whole capability: the `_internal_durable_alarms` schema statements, `ScheduledAlarmStore`, and the `ScheduledDurableObject` base every scheduling object extends. |
| `apps/api/src/durable-objects/migratable-durable-object.ts` | The base `ScheduledDurableObject` itself extends. It owns the schema half — the migration pass, its report, and `migrationsReady()`, which every method here awaits before touching `_internal_durable_alarms`. See [`durable-object-migration-tracking.md`](durable-object-migration-tracking.md). |
| `apps/api/src/durable-objects/workspace-do.ts` | Adopts it for a workspace: due schedules, resource watches, maintenance passes, Terminal deadlines, and the opportunity/ranking product pass. Owns `refreshSchedule`. |
| `apps/api/src/durable-objects/workspace-alarm-instrumentation.ts` | Content-free WorkspaceDO alarm phase spans and structured rows: fixed phase/kind enums, elapsed times, and the slowest-phase summary. |
| `apps/api/src/services/workspace-schedule-execution.ts` | What a workspace target actually *does* when it fires — automations, connector polls, digests, watch polls, maintenance, Terminal lifecycle — as plain functions over a context. |
| `apps/api/src/durable-objects/substream-agent.ts` | Adopts it for a work stream's agent: `agent_timer` entries index `workstream_wakeups`, so a wake-up a run scheduled fires from the object that owns it. |
| `apps/api/src/durable-objects/workstream-do.ts` | Adopts it for regional-effect and block-dashboard outboxes, all of which stay derived. |

## How it works

### Two kinds of wake reason

An object declares what it wants woken for in one of two ways, and the base
takes the earliest of both:

- **A stored entry** — a row in `_internal_durable_alarms`, keyed by `(kind, alarm_key)`,
  with a due instant, an optional repeat interval, and its own retry gate. Use
  this when the thing being scheduled has an identity that can succeed or fail
  on its own: one automation, one resource watch, one agent timer.
- **Derived instants** — `nextDerivedAlarmCandidates(now)`, computed from the
  object's own tables. Use these when due times already live in tables with
  their own writers and no separate identity is needed: each outbox's
  `MIN(not_before)`, the oldest activity event plus its retention, an in-memory
  keep-alive lease. Every independent lane is returned so an overdue one cannot
  hide a real future deadline during the pre-work recovery arm.

The rule of thumb: if it can fail in a way that should hold *it* back without
holding anything else back, it is an entry. If it is "the earliest row in this
table", it is derived.

### Arming

`armNextAlarm()` computes the minimum across the store and every derived
candidate, floors an overdue answer at `now + 1`, and sets the alarm to exactly
that — deleting the alarm outright when neither source has anything. It is
*exact*, not lowering-only:
a helper that only ever pulls an alarm in cannot take one back when the row that
justified it is cancelled, and cannot push one out when a target is deferred.
It writes only when the value actually changes, so a re-arm that concludes
nothing moved costs one `getAlarm`.

The pre-work durability arm supplies one exception to that floor: a reason that
is already due is parked at `now + SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS`
(two seconds), while any genuinely future reason keeps its exact earlier
instant. The source rows are not changed, so the parked alarm can rediscover
work if the current continuation is cancelled; a normal completion replaces it
with the exact post-work answer. Two seconds mirrors Cloudflare's documented
first retry for a thrown Durable Object alarm rather than inventing an
Avalon-owned wait for the cancellation case the runtime cannot observe.

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

1. Wait for the object's migrations (`migrationsReady()`, from the base below
   `ScheduledDurableObject`).
2. **Re-arm for recovery** through `armAlarmBeforeDueWork()`, before anything
   awaited. A cancelled invocation neither throws nor runs a `finally`, so an
   object that re-arms only at the end of its handler can be left with no
   wake-up at all. Already-due work is parked one recovery horizon out instead
   of at the next millisecond, avoiding a second immediately due alarm while
   this invocation is still running; a real future deadline earlier than that
   wins.
3. Ask `scheduledAlarmDeferral(now)` whether the whole alarm should be held —
   the regional-authority gate. A deferral sets the alarm *outright* to the
   recheck instant, because the recovery wake from step 2 can be earlier and
   only moving the alarm out prevents re-entry while the region stays closed.
4. Drain every entry whose effective instant had come **as of the instant this
   alarm started**, up to `SCHEDULED_ALARM_DRAIN_LIMIT` (100), each through
   `runScheduledAlarm(entry)`. The instant is snapshotted rather than re-read
   per entry, so a slow handler cannot extend its own pass indefinitely; what
   comes due during it is caught by step 7.
5. Run `runDueAlarmWork(now)` — whatever the object derives rather than stores,
   **including re-deriving the whole index**. A handler that just ran has
   usually advanced its own canonical row, and it writes that row through the
   object's local executor, which does not pass the auto-refresh in
   `executeRuntimeSql`. Without a reconcile here, the drain settles the entry it
   just ran and nothing arms the occurrence that replaced it: a recurring
   automation fires exactly once.
6. Gate whatever ran and **came back due at the same instant** — the stall
   check described below the settle rules.
7. Re-arm through `armAlarmAfterDueWork()`.

The first arm defaults to the bounded recovery re-derivation and the second to
the exact post-work answer. Both are hooks for one case: an object whose alarm
*is* the worker for a reason it derives. `SubstreamAgent` is the one — an agent
run is claimed from a dispatch row whose due time is a wake reason, so
re-deriving off that row while the run is still in flight hands the same run
straight back. Its
`armAlarmDuringRunDrain` leaves the run lane out and floors the alarm at one
keep-alive heartbeat instead, which bounds recovery from a cancelled
continuation without looping. It takes the first arm always, and the second only
when the drain reported the run still owned elsewhere.

An entry that returns is settled: a one-shot is deleted, a repeating one
advances to the first occurrence strictly *after* now (an object that hibernated
through six hours of a five-minute repeat fires once, not seventy-two times).
Both are guarded on the instant that ran, so a handler that rescheduled its own
entry keeps the wake-up it asked for.

An entry that throws is deferred: its attempt count goes up and its `retry_at`
moves out by an equal-jitter exponential backoff, from one minute to a
thirty-minute ceiling. Its siblings in the same drain are unaffected.

An entry that returns but is found, after the re-derive, under the same key at
the identical `dueAt` with that instant already past has made no progress: its
handler ran and whatever the index is derived from did not move. It is deferred
exactly as a throw is, and the attempt it arrived with is carried forward — the
settle deleted the row and the reconcile re-inserted it at zero, so without the
carry the backoff would restart at its first step on every wake and never reach
the ceiling. The object's `onScheduledAlarmStalled` hook reports it. The test is
narrow on purpose: an entry that advanced its row re-derives a later instant,
one that rescheduled itself wrote a different one, and an entry the drain never
reached, or that came due during it, is not in the drained set and keeps its
immediate wake.

A handler can also answer for itself, through what `runScheduledAlarm` returns
(`ScheduledAlarmOutcome`). `{ progressed: true }` says the source moved and the
identical instant is transient — a bounded reap that cleared a hundred rows of
one second and has more behind them — and the entry keeps its immediate wake.
`{ waitMs }` says the work is legitimately not possible yet — a sandbox a live
run holds, a directory row the Queue has not caught up to — and the entry is
held that long through `hold`, which writes `retry_at` and leaves `attempt`
alone: a wait is not an attempt. Returning nothing leaves the decision to the
base. A handler must not claim progress against a source it does not move: the
Slack sweeps say nothing for exactly that reason, because the unfurl pass
advances every unchanged card and the ingress pass re-enqueues without touching
the row, and either would claim progress forever.

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

### Workspace phase instrumentation

`WorkspaceDO` wraps the recovery re-arm, authority check, each stored target,
its two derived phases — activity retention and schedule reconciliation — and
the final exact re-arm in
`rally.workspace.scheduled_alarm.phase`. The matching structured rows are
`workspace_scheduled_alarm_phase_started`, `_completed`, and `_failed`; a final
`workspace_scheduled_alarm_work_completed` row names the slowest phase and,
for a stored target, its bounded kind. Durations are compared with the same
two-second cancellation-recovery horizon used by the pre-work arm.

The fields intentionally contain only fixed enums, counters, booleans, and
durations. They do not contain a workspace id, alarm key, due time, payload,
connector value, or error message. Cloudflare already puts the invocation id
and Durable Object id on the enclosing row and trace, which is enough to find
the hot instance without copying product identity or content into the custom
diagnostic. A target error is marked with the fixed
`workspace_scheduled_alarm_phase_failed` code inside the custom span and the
original error is rethrown only after that span settles. This matters because
Cloudflare automatically records errors thrown from span callbacks, including
details the target supplied.

A started phase with neither a matching completion nor failure means the
continuation ended while that phase was active. On an already-migrated hot
object, a `clientDisconnected` alarm invocation with no phase start did not
enter Rally's alarm work at all; it is a queued runtime delivery, not evidence
that a particular target was interrupted.

## Invariants

- **An object never derives its alarm outside this base.** A second derivation
  of "the earliest thing" will disagree with the base's, and the disagreement
  shows up as work that silently never runs. `SubstreamAgent.armAlarmDuringRunDrain`
  uses the base with an explicit candidate override described under *Firing*:
  the run lane is the one derived reason whose worker is this alarm. Two call
  sites do still arm directly, and both are deliberate. `enqueueAgentRun` and
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
- **The post-work alarm is exact, and normally floored at `now + 1`.** An alarm
  set to a past instant fires immediately and re-derives the same past instant:
  that is the shape every hot-alarm loop in this codebase has had. The floor is
  not a backoff and must not become one — the overflow and slow-handler cases
  under *Failure modes* depend on the immediate re-wake. The pre-work arm is
  deliberately different: it maps only already-due reasons to the recovery
  horizon and leaves earlier future deadlines untouched. What stops a source
  loop after work runs is the stall gate: **an entry that ran and is due again
  at the identical instant is a failed attempt**, held behind the same gate a
  throw earns, unless its handler reported progress or asked to wait. A handler
  that wants to run again at once reschedules its entry to a *different*
  instant.
- **A due-time expression counts only rows its pass will act on, at the instant
  it will act on them.** The `slack_ingress` arm counts a spent link challenge
  a day after it was spent, which is when the reap removes it; the
  `expired_drafts` arm excludes the linked drafts the reap keeps; every derived
  instant is rounded up to the next whole second, because `strftime` drops the
  milliseconds the pass's own cutoff keeps and an alarm that fires early finds
  nothing due; the `slack_unfurls` arm counts only links on a connection the
  sweep would load. An arm that counts what its pass leaves behind is the stall
  gate's steady customer — a drip and a report rather than a loop, but a
  defect all the same.
- **A bounded pass reports the rows it retired.** Every maintenance reap
  answers the stall check with its count, because a backlog sharing one second
  re-derives the same instant until it is gone; the two Slack sweeps answer
  nothing, because neither moves the rows its query counts and either would
  claim progress forever. A wait that is not a positive finite number is not a
  wait; the entry takes the stall rule.
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
`refreshWorkspaceSchedule` and `refreshAgentTimerAlarm` in
`apps/api/src/services/workstream-wakeup-service.ts`, which are the two "a due
time moved, go reconcile" entry points.

## Failure modes and limits

- **A handler throws.** That entry alone is held behind an equal-jitter
  exponential gate: 1 minute, doubling to a 30-minute ceiling, with half of each
  delay randomized so a whole region does not retry a shared dependency in the
  same millisecond. It keeps its due time, so a target that recovers runs at the
  next drain rather than being rescheduled from scratch.
- **A handler returns without moving its source.** The entry is back at the
  same past instant after the re-derive, and the base holds it behind the retry
  gate as if it had thrown, carrying the attempt forward so the delay grows to
  the thirty-minute ceiling. Every object reports it through
  `reportScheduledAlarmAttempt`, the same policy a throw gets: a warning on the
  first two attempts, an error from the third, and one operator notification
  at exactly the third ([`ops-alerting.md`](ops-alerting.md)). The counter is
  shared, so an episode that alternates throws and stalls is still reported
  once. This is the failure that used to be a hot loop. On 2026-08-22 the
  `slack_ingress` maintenance pass reaped expired link challenges at the 30-day
  retention cutoff while the schedule counted them due at their 15-minute
  expiry, and one workspace's alarm fired about 1.5 times a second for hours.
  The gate bounds the damage; the fix is always in the source — a reap must
  remove everything the due-time expression counts.
- **A handler legitimately cannot act yet.** It answers `{ waitMs }` and the
  entry is held that long with no attempt counted; the first reconcile after
  its source moves clears the hold. A Terminal deadline does this while a live
  run holds the sandbox (one minute) and after a transition whose directory
  effect is still on the Queue (thirty seconds).
- **A workspace target fails.** In addition to the gate, `schedule` and `watch`
  failures write a `schedule.failed` / `resource_watch.failed` audit event. That
  write is fire-and-forget: the gate is already durable, and losing the audit
  row to an eviction costs an operator one line.
- **More than 100 entries are due at once.** The first 100 run and the re-arm
  points at the next instant, which is already past, so the rest run in the
  following wake. Nothing is dropped; the cost is one extra alarm.
- **An entry comes due while the previous handler is still running.** It is not
  in that pass — the drain works from the instant the alarm started — and the
  re-arm at the end sees it overdue, so it is floored at `now + 1` and the
  runtime re-enters immediately. The entry runs late by however long the first
  handler took, which is inherent to one alarm and one thread, but it is never
  skipped. Nor is it run twice: Cloudflare guarantees that "only one instance of
  `alarm()` will ever run at a given time per Durable Object instance", so the
  second wake cannot overlap the first.
- **The region is closed for maintenance.** `scheduledAlarmDeferral` holds the
  whole drain and rechecks every 5 minutes. Entries keep their due times, so a
  workspace whose entire schedule is overdue resumes when the region reopens.
- **A repeating entry falls far behind.** It fires once and advances past every
  missed occurrence. Catch-up is deliberately not offered; a caller that needs
  every occurrence has to store them as separate entries.
- **The alarm handler itself throws or its continuation is cancelled.** The
  runtime retries a thrown handler six times with its own backoff. Independently,
  because step 2 re-arms before any awaited work, a throw or cancellation after
  that point still leaves a wake-up armed. Already-due work is rediscovered no
  later than Cloudflare's two-second first-retry horizon unless an earlier real
  deadline wakes the object first.

## Data model

`_internal_durable_alarms`, identical in all three objects:

| Column | Meaning |
| --- | --- |
| `kind`, `alarm_key` | Composite primary key. `kind` selects the handler; `alarm_key` is the target's own id. |
| `due_at` | When the entry is meant to run, owned by whoever scheduled it. |
| `repeat_every_ms` | `NULL` for a one-shot; otherwise the interval it re-arms on. |
| `retry_at` | Backoff gate owned by the drain, `0` until the entry first fails. |
| `attempt` | Consecutive attempts without progress — throws and stalls alike — reset when the entry moves: a settle that advanced it, or a reschedule. |
| `payload_json` | Opaque to the store; free for a handler that needs more than a key. |

The *effective* instant is `MAX(due_at, retry_at)`, which is what the index,
the due query, and `nextDueAt()` all order by. Keeping the schedule and the gate
in separate columns is what lets a reconcile rewrite due times without granting
a failing target a free immediate attempt.

## Testing

- `apps/api/test-workers/scheduled-alarms.test.ts` runs on real workerd
  (`pnpm --filter @rally/api test:workers`) and is the authority for this
  module: only that runtime has real `setAlarm`/`getAlarm` semantics, alarm
  handler invocation, and SQLite. It covers arming exactly, pulling an alarm in
  when an earlier entry is scheduled, pushing it back out and deleting it when
  entries are cancelled, per-entry backoff isolation, repeat advancement,
  draining a tie wider than one wake allows, re-waking for an entry a slow
  handler overran, parking already-due pre-work at the recovery horizon without
  delaying an earlier future deadline, the agent-timer index, and the stall
  gate — an entry that ran and came back due at the same instant is deferred
  with its attempt carried across the settle-and-reinsert, while one that moved
  itself, reported progress, or asked to wait is not.
- `apps/api/test/workspace-alarm-stall-alert.test.ts` drives `WorkspaceDO`'s
  failure and stall hooks in the Node suite: which attempt warns, which logs at
  `error`, that exactly one operator notification is posted, and that an
  episode mixing throws and stalls posts once.
- `apps/api/test/workspace-alarm-instrumentation.test.ts` proves the phase
  fields stay content-free, unknown stored kinds collapse to `unknown`, and the
  summary identifies work that crosses the recovery horizon.
- `apps/api/test/workspace-schedule-targets.test.ts` runs the due-time queries
  against the object's own ledger, for the arms the Node snapshots cannot
  exercise: the draft arm's exclusion of linked drafts, and the rounding of a
  derived instant up to the next second.
- `apps/api/test/runtime-components.test.ts` covers the pure arithmetic —
  recurrence and backoff — in the Node suite.
- `apps/api/test/workspace-do-schema.test.ts` applies the WorkspaceDO ledger one
  version at a time against `node:sqlite`. A migration that inserts a row is a
  claim about SQL, and the version it lives in is the claim that matters: the
  bootstrap must appear when 5 runs against a carried-over object, must not
  appear for a new one, and must not appear in 4, which is released.
- Driving an alarm in a test: `runDurableObjectAlarm(stub)` from
  `cloudflare:test` invokes the handler and reports whether one was armed.
  Reading state afterwards needs `runInDurableObject`, because a stored entry is
  object-local SQL with no RPC surface.
- Trap: `getAlarm()` returns `null` inside a running alarm handler until
  `setAlarm` is called again. A test that asserts on the armed instant has to do
  it after the handler returns, not from inside one.
- Trap: a test that sleeps inside a live object must have nothing armed in the
  past while it sleeps. `instance.alarm()` is a plain method call, so the
  runtime does not know an alarm is in progress and will deliver a real one on
  top of it — which re-enters `alarm()` and drains entries the first pass had
  not settled yet, something that cannot happen in production. Drive the drain
  directly, or park the alarm first.
- Trap: an alarm armed for `now + 1` — which `enqueueAgentRun` does on purpose —
  fires while the test is still setting up, and the work it drains can settle
  the very rows the next assertion reads. Park it in the *same* invocation that
  arms it (`runInDurableObject`, call `fetch`, then `setAlarm` before the
  callback returns); two separate calls leave a window the drain can win, which
  is how `agent-run-lifecycle.test.ts` became intermittent.

## Operations

In Workers Logs, select the `WorkspaceDO` namespace and filter
`event = workspace_scheduled_alarm_work_completed` with
`crossed_recovery_horizon = true`. Group by `slowest_phase` and then
`slowest_alarm_kind`; the latter is present only when the slowest phase is a
stored target. Open the enclosing invocation or trace to see the ordered phase
rows and Cloudflare's automatic binding spans beneath the custom phase span. If
multiple phases tie at the maximum millisecond duration, the summary names the
first one that completed; inspect the completion rows to see every tied phase.

For an alarm reported as `clientDisconnected`, first filter the same invocation
for `workspace_scheduled_alarm_phase_started`. No start row means the queued
delivery never entered application work. A start without its corresponding
completion or failure names the phase active when the continuation ended. Do
not join on workspace ids or alarm keys within these phase rows: neither is
emitted, and `$workers.durableObjectId` is the platform-owned correlation
field.

## Changelog

### 2026-08-25 — Phase timing distinguishes slow work from a cancelled queued alarm

**What changed:** Workspace alarms now emit content-free start, completion, and
failure rows around both re-arms, the authority check, each stored target, the
activity-retention pass, and the schedule reconcile. A final summary records
total work time, the slowest phase, the bounded alarm kind when applicable, and
whether the two-second recovery horizon was crossed. Each phase is also a child
span of the platform's alarm invocation trace; target errors cross that span
only as a fixed error code and are rethrown after it settles.

**Why:** After the recovery-arm fix, alarm `clientDisconnected` outcomes fell by
about 95% but did not reach zero. Production invocation traces showed the
remaining rows were short queued alarms being superseded while a successful
alarm was still running, concentrated in two objects. The platform outcome says
which waiter was cancelled but not which application phase kept the successful
invocation active past the recovery horizon; target-specific timing is needed
before moving or changing any scheduled work.

**Considered and rejected:** Logging alarm keys or workspace ids would make a
query easier to copy between systems, but Cloudflare already indexes the Durable
Object id and invocation id and those product identifiers add no diagnostic
power. Logging only a final duration would miss an invocation whose continuation
ends before the summary. Moving slow work out of the alarm before measuring it
would choose an architecture from an aggregate symptom rather than from the
target actually responsible.

**Consequences:** Each WorkspaceDO alarm produces bounded phase rows and spans;
the extra observability volume is the cost of distinguishing a queued runtime
cancellation from interrupted application work. Operators must use the
platform's Durable Object id for correlation. An unknown stored kind is reported
as `unknown`, never copied from storage, and no future field may add a target
key, due time, payload, connector value, or error message.

### 2026-08-24 — The durability re-arm is a recovery wake, not an immediate duplicate

**What changed:** The base pre-work arm now maps only already-due stored or
derived reasons to Cloudflare's documented two-second first alarm-retry
horizon. A genuinely future reason keeps its exact earlier deadline, and the
post-work arm still replaces the recovery wake with the exact next answer.
Derived reasons are exposed as separate candidates so an overdue lane cannot
hide a future one. `SubstreamAgent` routes its run-drain-specific candidate set
through the same arming logic, including stored timers after the overdue head.

**Why:** During an alarm handler Cloudflare reports no armed alarm until the
handler calls `setAlarm` again. The old exact pre-arm therefore saw the row the
current invocation was already servicing, floored its past instant at
`now + 1`, and created a second immediately due invocation. The final exact arm
then replaced or deleted that second alarm after successful work. In the
Global `WorkspaceDO` namespace this appeared as 2,948 alarm
`clientDisconnected` results beside 2,942 successful alarms in 24 hours: the
error counter was almost entirely the scheduler cancelling its own redundant
wake.

**Considered and rejected:** Removing the pre-work arm. A cancelled continuation
does not throw or reach a `finally`, so an object that arms only after work can
lose its sole wake while its source rows still say work is due. Applying a
minimum delay to every `armNextAlarm` call was also rejected because overflow
and work that becomes due during a slow handler need the exact immediate
post-work wake. Reusing the scheduler's one-minute handler-failure backoff was
also rejected: cancellation recovery is a separate wait, and this repository
does not choose such bounds by analogy. Cloudflare's published first alarm
retry supplies the platform value instead.

**Consequences:** Cancellation recovery is bounded by Cloudflare's two-second
first-retry horizon rather than one millisecond, unless a real future deadline
wakes the object sooner. Recovery does not increment an entry's failure attempt
or mutate its retry gate. Future changes must preserve both halves: arm before
the first await, but do not re-arm already-serviced work immediately, and do
not collapse independent derived lanes before classifying them as overdue or
future.

### 2026-08-24 — Scheduler idempotency is not a member-facing directory read

**What changed:** The automation firing path now uses
`plannedAutomationWorkstream`, an exact internal WorkspaceDO lookup keyed by
subscription and planned instant. The member-facing `plannedWorkstream` remains
filtered to work streams that member may read.

**Why:** Reusing a viewer-filtered lookup for idempotency meant an ownership or
participation change could hide the already-created planned row from the
scheduler. It would bootstrap a second work-stream object, lose the unique
`automation_runs` insert, and leave the new object orphaned.

**Considered and rejected:** Passing the automation owner as a privileged
viewer, or making the member API unfiltered. Idempotency is not permission, and
neither a historic owner nor an API caller should gain visibility from the
scheduler's need to find its own prior write.

**What a future change has to respect:** Scheduler recovery uses exact internal
identity reads. Product directory reads always retain a concrete viewer or a
workspace audience and never double as authorization bypasses.

### 2026-08-22 — The automation firing path reads only the object

**What changed:** `runAutomationSchedule` in
`services/workspace-schedule-execution.ts` no longer reads
`workstream_authority_control`. The planned work stream comes from the
directory's exact internal lookup unconditionally, and the losing-claim cleanup that
deleted a regional `workstreams` row is gone with the branch that reached it.

**Why:** Migration 0090 closed the phase permanently, so both arms had been
unreachable since — including that cleanup, whose whole subject was a regional
row the object no longer keeps. The read itself was one D1 round trip per firing
on a path that fires once per due schedule.

**What a future change has to respect:** a concurrent scheduler losing the
unique run claim is now settled entirely by the object — nothing regional is
left behind to compensate for, and re-adding a compensating delete here would
be deleting a row the authority does not own.

### 2026-08-22 — An entry that runs and comes back due at the same instant is a failed attempt

**What changed:** After the re-derive in `alarm()`, the base compares every
entry the drain ran against the index. One that is back under the same key at
the identical `dueAt`, with that instant already past, is deferred through the
existing retry gate with its attempt carried forward, and reported through a new
`onScheduledAlarmStalled` hook. A handler can answer for itself through
`ScheduledAlarmOutcome`: `{ progressed: true }` keeps the immediate wake,
`{ waitMs }` holds the entry without an attempt (`ScheduledAlarmStore.hold`).
`drainDueScheduledAlarms` returns the runs rather than a count. Every object's
failure and stall hooks report through `reportScheduledAlarmAttempt`
(`scheduled-alarm-report.ts`): a warning on attempts one and two, an error from
three, one operator notification at three ([`ops-alerting.md`](ops-alerting.md)).
Every bounded maintenance pass reports the rows it retired as progress; the two
Slack sweeps report nothing; a Terminal deadline waits while a run holds its
sandbox or its directory effect is on the Queue. Every derived due time is
rounded up to the next second; the `expired_drafts` arm excludes linked drafts,
the `slack_unfurls` arm excludes a disabled connection's links, and the
`slack_ingress` arm counts a link challenge at the same grace horizon the reap
binds, from one constant.

**Why:** The gate only ever caught a handler that threw. One that returned
without moving its source re-derived the same past instant, the re-arm floored
it at `now + 1`, and the object re-entered immediately — one wake per handler
duration, with nothing logged. On 2026-08-22 the `slack_ingress` maintenance
pass reaped link challenges at the 30-day retention cutoff while the schedule
counted them due at their 15-minute expiry; one workspace's alarm fired about
1.5 times a second from 17:41 UTC, writing some fifty thousand error rows an
hour, and was found by accident while chasing an unrelated Slack failure. Five
other sources could leave a past instant behind after a pass that returns — an
R2 failure in the resource and note reaps, a linked draft older than a day, an
archived work stream's unfurl, a Terminal deadline deferred behind a live run —
and each was the same loop waiting for its first row. The outcomes exist
because the identical-instant test alone misreads two honest cases: a bounded
reap clearing a burst that shares one second, and a source another actor moves
after the handler returns. Read as stalls, the first would page an operator
for a large delete and the second for every Terminal warm stop.

**Considered and rejected:** A minimum re-arm delay in `armNextAlarm`. It would
apply to every object and every arming path, delay the legitimate immediate
re-wakes the overflow and slow-handler cases depend on, be undone by
`SubstreamAgent`'s own `now + 1` arming, and still say nothing about *which*
entry was looping. Clamping `due_at` on reconcile was rejected because a moving
`due_at` resets the gate on every pass. Gating only in `WorkspaceDO` was
rejected because the shape belongs to the base. Letting every handler report
progress was rejected after tracing the Slack sweeps: the unfurl pass advances
every unchanged card and the ingress pass re-enqueues without touching its row,
so both would claim progress forever against a pinned row — the loop again,
with a clear conscience. Deleting a spent link challenge at once, the first
draft of the reap fix, was rejected because it made `slack_link_expired` and
`slack_link_consumed` unreachable in practice; a day of grace keeps the reason
and costs nothing.

**Consequences:** A source table whose due expression counts rows its reap does
not remove now costs one wake per backoff step, up to thirty minutes, with a log
row on each and one notice — a drip that is noticed rather than a loop that is
not. The identical-instant test is the invariant: a handler that wants an
immediate re-run reschedules to a different instant or reports progress, and
one that reports progress against a source it does not move has reopened the
loop. `attempt` on a surviving entry means consecutive attempts without
progress, throws and stalls alike; `retry_at` may now be set by a hold with
`attempt` at zero.

### 2026-08-21 — One alarm list per object, and the workspace scheduler is deleted

**What changed:** New `ScheduledDurableObject` base and `_internal_durable_alarms` table,
adopted by `WorkspaceDO`, `WorkstreamDO`, and `SubstreamAgent` (schema versions
4 — plus 5 for the bootstrap below — 2, and 15 respectively). The `WorkspaceScheduler` Durable Object's work —
due schedules, resource watches, maintenance passes, and Terminal deadlines —
moved into WorkspaceDO as reconciled entries, with its execution code extracted
to `services/workspace-schedule-execution.ts`, and the class itself was deleted:
its binding is gone and Wrangler migration tag `v4` names it in
`deleted_classes`. The SubstreamAgent's agent timers moved from "derive
`MIN(due_at)` and fire the single earliest wake-up" to one entry per pending
wake-up.

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

**Deleting the class rather than leaving it as a forwarder** is the part with a
real cost, and it was taken deliberately. `deleted_classes` releases the
objects and their storage — the alternative leaves a namespace of empty objects
alive forever — but it also **discards every alarm those objects had armed**, so
a workspace whose next automation was scheduled there loses that wake-up. A
forwarder that handed each surviving alarm to WorkspaceDO before clearing itself
would have avoided that, at the price of carrying a dead class through another
release and remembering to finish the job.

What replaces it is the `schedule_bootstrap` entry that WorkspaceDO migration
**5** writes into any object that already has an identity: the first time such an
object wakes it reconciles itself once, unprompted, and the entry is consumed.
It is its own version rather than an addition to 4 because 4 ships in the release
before this one — amending a released version's statements changes the hash every
deployed object recorded and throws `workspace_do_schema_hash_mismatch:4` in its
constructor, for good. That covers every workspace whose object is constructed after the
deploy, which is every workspace with any traffic at all. It does **not** cover
a workspace that is never touched again — nothing inside a Durable Object can
wake it — so if a schedule matters there, an operator reconciles it by calling
`refreshSchedule` for that workspace. A future change that adds a fleet sweep
should use it for exactly this and nothing else.

A residual note for whoever reads the Wrangler config: `v1` still names
`WorkspaceScheduler` in `new_sqlite_classes` and always will. Deployed migration
tags are immutable history; `v4` is what undoes it.

Per-target retry gates were kept rather than simplified into a single object-wide
backoff. `scheduler_retry_states` existed because one broken automation used to
be able to hot-loop a workspace's alarm; that hazard is unchanged, and the gate
now lives in the same row as the schedule it guards, which is why a reconcile
can rewrite due times without resetting it.

`armAlarmBeforeDueWork` / `armAlarmAfterDueWork` are hooks rather than a fixed
`armNextAlarm` at both ends of `alarm()` because `SubstreamAgent` had just
earned the exception: the run-drain arm deliberately leaves the dispatch row out
of the derivation, since the invocation doing the deriving is the one servicing
that row. Folding that into the base as a special case would have put the run
lane's vocabulary into a class that knows nothing about runs; making it a
subclass override keeps the base's rule — one derivation, no direct `setAlarm` —
intact for everyone else.

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
