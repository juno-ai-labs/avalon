# Durable Object alarms

Cloudflare gives a Durable Object exactly one alarm. `setAlarm` overwrites
whatever was armed before, so an object with more than one reason to wake — an
outbox retry, a keep-alive, a due schedule, a wake-up a run asked for — has to
decide which reason owns the slot, every time any of them changes. This document
covers the shared capability that makes that decision once: a SQLite-backed list
of scheduled alarms per object, and a base class that keeps the object's single
alarm pointed at the earliest thing on it.

Read this before adding a wake reason to `WorkspaceDO` or `AgentLoopDO`
(a hosted Sidekick's entries are `WorkspaceDO`'s), before changing when any of
them fires, and before giving another object its own alarm. The objects themselves — their
hierarchy, schemas, sockets, and effects — belong to
[`workstream-durable-object.md`](workstream-durable-object.md) and, for
automations, [`automation-lifecycle.md`](automation-lifecycle.md).

## Sidekick publication recovery

Sidekick publication commits its accepted revision, stored `loadable`, and a
`sidekick_publication` alarm before running external effects. The alarm retries
unapplied effects at the durable boundary. Registration replacements carry the
owner generation; an equal-generation replay returns the original event cutoff
and a stale generation cannot replace current registrations. Lifecycle checks
remain separate from this effect-ordering fence.

## Where the code lives

Sidekick source reconciliation uses stored `sidekick_delegation_sources`
entries. Grant mutations write the wake atomically with consent; connection
authority triggers and existing membership/reach invalidations also queue it.
One `<sidekickId>:sources` entry coalesces pending changes. Each enqueue advances
its due instant to at least the previous instant plus one millisecond; this is
the existing scheduler's settlement fence, not a debounce delay. A wake queued
while an older handler awaits eligibility cannot be erased by its settlement.
Migration 130 queues existing active configured Sidekicks. Connection RPCs and
membership/reach paths re-arm the native alarm after writing work. The handler
uses normal alarm retries and current definition checks; it performs no provider
access probe. [Sidekick lifecycle](automation-lifecycle.md) owns registration
selection and the event cutoffs that unchanged rows preserve.

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/scheduled-alarm-report.ts` | How a gated entry is reported, whichever object holds it: the attempt that warns, the one that logs an error, the one that notifies an operator, and what of a thrown error may leave. |
| `apps/api/src/durable-objects/scheduled-alarms.ts` | The whole capability: the `_internal_durable_alarms` schema statements, `ScheduledAlarmStore`, and the `ScheduledDurableObject` base every scheduling object extends. |
| `apps/api/src/durable-objects/migratable-durable-object.ts` | The base `ScheduledDurableObject` itself extends. It owns the schema half — the migration pass, its report, and `migrationsReady()`, which every method here awaits before touching `_internal_durable_alarms`. See [`durable-object-migration-tracking.md`](durable-object-migration-tracking.md). |
| `apps/api/src/durable-objects/workspace-do.ts` | Adopts it for a workspace: due schedules, resource watches, maintenance passes, Terminal deadlines, the opportunity/ranking product pass, and the three Space phases. Owns `refreshSchedule`. |
| `apps/api/src/durable-objects/workspace-alarm-instrumentation.ts` | Content-free WorkspaceDO alarm phase spans and structured rows: fixed phase/kind enums, elapsed times, and the slowest-phase summary. |
| `apps/api/src/services/workspace-schedule-execution.ts` | What a workspace target actually *does* when it fires — connector polls, digests, watch polls, maintenance, Terminal lifecycle — as plain functions over a context. Automations are no longer among them; each has its own alarm. |
| `apps/api/src/durable-objects/agent-loop-do.ts` | Adopts it for a conversation's agent: `agent_timer` entries index `workstream_wakeups`; one `terminal_observation` entry indexes its Terminal sandbox's `next_observe_at`; the retired `merge_suggestion` kind is named only so a leftover entry can be recognised. Execution, external settlement, projection, realtime, and keep-alive deadlines remain derived from their owning rows or lease. |
| `apps/api/src/durable-objects/hosted-sidekick.ts` | A hosted Sidekick's entries in `WorkspaceDO`'s store, each keyed `<sidekickId>:<key>`: `automation_schedule`, `automation_run`, `sidekick_review` (one per Sidekick, armed by run finishes; [`automation-lifecycle.md`](automation-lifecycle.md#scheduled-self-review)), `sidekick_run_row` (`<sidekickId>:<runId>`, armed by migration 135's triggers on `sidekick_runs`, handled by `projectRunRow`), `sidekick_memory_tables`, and the delegation kinds. |

### Two kinds of wake reason

An object declares what it wants woken for in one of two ways, and the base
takes the earliest of both:

- **A stored entry** — a row in `_internal_durable_alarms`, keyed by `(kind, alarm_key)`,
  with a due instant, an optional repeat interval, and its own retry gate. Use
  this when the thing being scheduled has an identity that can succeed or fail
  on its own: one resource watch, one agent timer, one automation schedule.
- **Derived instants** — `nextDerivedAlarmCandidates(now)`, computed from the
  object's own tables. Use these when due times already live in tables with
  their own writers and no separate identity is needed: each outbox's
  `MIN(not_before)`, the oldest activity event plus its retention, an in-memory
  keep-alive lease. WorkspaceDO's socket first-frame watch is one too: the
  earliest instant a socket this instance accepted should have spoken by,
  leaving out sockets already judged and held below the reset threshold
  ([`realtime-sockets.md`](realtime-sockets.md) owns it). `AgentLoopDO` includes both
  regional-effect delivery and semantic-realtime publication outboxes
  independently, plus separate candidates
  for executable loop work and the oldest externally unsettled terminal run.
  Its Terminal sandbox's next provider observation is a stored
  `terminal_observation` entry instead, so a failing check backs off behind
  its own gate ([`terminal-workspaces.md`](terminal-workspaces.md) owns it).
  Every independent lane is returned so an overdue one cannot
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
   workspace schedule fires exactly once.
   `WorkspaceDO` runs each of its derived lanes here **only when that lane is
   due**: `derivedAlarmLanes()` is the one list of lane due-time reads, the
   candidates arm from all of it, and `runDueAlarmWork` reads a lane just
   before it would run and runs it when that answer is at or before `now`.
   A lane skipped on this wake is still a candidate in step 7, so skipping can
   only leave work for the instant it was already armed for. The schedule
   reconcile is the one phase with no due time and runs on every wake.
6. Gate whatever ran and **came back due at the same instant** — the stall
   check described below the settle rules.
7. Re-arm through `armAlarmAfterDueWork()`.
8. **Hold an idle pass.** If steps 4 to 6 wrote nothing (SQLite's
   `total_changes()` moved only by the object's own re-arms) and step 7 still
   armed the next millisecond, a derived lane is reporting work that its pass
   declines. The alarm is moved out by the backoff a thrown entry earns, never
   past the next future candidate, and `onIdleAlarmHeld` reports it. Work that
   came due after step 4's instant was never offered to the pass, so it keeps
   its immediate wake and the pass is not counted. The attempt is kept in the
   object's KV storage under `_internal_idle_alarm_attempt`, written after the
   sample so it survives eviction. A pass that wrote but still asked to run at
   once is not held and keeps the attempt, since the looping lane is still
   due; the first pass that arms later, or arms nothing, clears it.

The first arm defaults to the bounded recovery re-derivation and the second to
the exact post-work answer. Both are hooks for one case: an object whose alarm
*is* the worker for a reason it derives. `AgentLoopDO` is the one — its
execution lane is derived from the persistent-loop singleton, the pending input
the loop can actually take (`nextActivationInput`, not merely the oldest one:
a room parked on an open question has input it may not hand Bind, and waking on
that re-arms at `now` for as long as the question stays open, and a stopped
background agent's queued input is not offered at all, because the claim holds
every new execution while `stopped_at` is set), and subordinate
execution receipts, while its external-settlement lane
is derived independently from the oldest terminal receipt whose
`external_settled_at` is null. While the alarm is servicing either lane,
immediately re-deriving the same due row would hand the work straight back.
`armAlarmDuringRunDrain` floors recovery at one keep-alive heartbeat instead,
which bounds recovery from a cancelled continuation without looping. It takes
the first arm always, and the second while either a run remains owned elsewhere
or the eager settlement drain is active.

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
statement touches one of the alarm-source tables. Automatic refreshes reconcile
only the affected kinds, preserving unrelated entries; explicit repair and the
post-drain refresh reconcile all four kinds:

| Kind | Key | Source |
| --- | --- | --- |
| `schedule` | schedule id | `schedules`, enabled with a `next_run_at` |
| `watch` | watch id | `resource_watches`, enabled with a `next_poll_at` |
| `maintenance` | task name | the oldest row of whichever tables that task still owes work on |
| `terminal` | conversation id | `channels.next_terminal_action_at` |

Runtime writes map `schedules` to `schedule`, `resource_watches` to `watch`,
and `resources` to both `maintenance` and `watch` (deletion cascades).
Resource versions and cleanup, note, and Slack outboxes map to
`maintenance`. Digest RPCs select `schedule`; directory effects repair
`terminal` on first application and replay. The source map next to schedule
derivation is the registry for compatibility-port writes.

A fifth kind, `product`, is scheduled directly rather than reconciled: the
opportunity and ranking pass wants its instant computed differently depending on
the caller (an enqueue wants a past-due instant honoured; the alarm that
launched nothing wants past-due rows left parked behind a dormant member), and a
derived source has no way to carry that distinction.

### An automation's wake reasons

A Sidekick's entries are `WorkspaceDO`'s, keyed `<sidekickId>:<key>` so each
Sidekick can cancel its own by prefix. `cancelByKeyPrefix(kinds, prefix)` does
that in one statement, only in the kinds named, and compares the prefix as text
rather than as a `LIKE` pattern, so an id containing `%` or `_` matches only
itself:

| Reason | Kind | Source |
| --- | --- | --- |
| Fire one calendar or interval occurrence | `automation_schedule` (stored) | the schedule id |
| Hand one admitted occurrence to provisioning, which opens its child conversation and starts its loop | `automation_run` (stored) | the run id |
| Materialize the memory tables an accepted revision declares | `sidekick_memory_tables` (stored) | the revision |
| Ask the wizard for a scheduled self-review, and send the request again until the wizard reports it admitted | `sidekick_review` (stored) | the one `review` key; armed by the tenth run finish, cancelled by pause, archive, an accepted revision and the delivery report ([`automation-lifecycle.md`](automation-lifecycle.md#scheduled-self-review)) |
| Write one run, as it stands, into its row in the Sidekick's shared conversation | `sidekick_run_row` (stored) | the run id; armed in SQL by WorkspaceDO migration 135's triggers on every insert into `sidekick_runs` and every change to its state, summary or step count, each at `MAX(updated_at, due_at + 1)` so a change during a delivery survives the drain's delete; re-armed by `replayRunRows` with a `{"replay":true}` payload that forces the write; handled by `projectRunRow`, which reads the run at delivery ([`automation-lifecycle.md`](automation-lifecycle.md#runs-in-the-shared-conversation)) |

**A handler that wants to run again later moves its own entry.** The drain
deletes an entry at the instant that ran whatever its handler returned, and
`{ waitMs }` only holds an entry that the object re-derives from its own rows.
A Sidekick's run entry is not re-derived, so after each provisioning send it
schedules itself at a later instant, which the delete does not match; returning
`waitMs` instead dropped the entry and left the run pending for good.

The stored kinds are entries rather than derived instants because each can
fail on its own: a run whose provisioning has not reported must be asked again
without holding a due schedule, and a broken schedule must not hold a run.
Neither is reconciled from a canonical table the way
`WorkspaceDO.refreshSchedule` works: apply, pause, resume, and delete schedule
and cancel a Sidekick's entries explicitly, by its key prefix, every admitted
occurrence arms its own run entry for now, and `executeSchedule` writes its own
next occurrence and re-arms before it returns. A run's provisioning leaves on
the activity Queue, so a slow conversation does not hold the Organization's
other entries.

## Invariants

- A scoped reconcile receives the complete authoritative target set for every
  selected kind; it must not delete or reset another kind's entries.
- Compatibility-port writers declare every affected kind in
  `WORKSPACE_ALARM_SOURCE_KINDS`, including foreign-key cascades. There is no
  default kind. Typed writers explicitly select their own kinds.
- An exact directory replay repairs Terminal arming after a post-commit failure,
  even when applying the directory row reports no change.

- **An object never derives its alarm outside this base.** A second derivation
  of "the earliest thing" will disagree with the base's, and the disagreement
  shows up as work that silently never runs. `SubstreamAgent.armAlarmDuringRunDrain`
  uses the base with an explicit candidate override described under *Firing*:
  the execution and external-settlement lanes are derived reasons whose worker
  is this alarm. Two kinds
  of call site still arm directly, and both are deliberate. An `AgentLoopDO`
  arms immediately after committing a pending loop input, an unlinked execution
  receipt, or the mailbox reservation that precedes a prepared input, and
  `WorkstreamObjectStore.enqueueRegionalEffect` does the same after committing
  an effect. An isolate that dies before the full re-arm
  therefore cannot strand either durable row. Both paths can only pull the alarm
  in, never push it out, and the next `armNextAlarm` corrects the instant.
  Anything that would arm for a *future* time belongs in the base.
- **Whatever ran, re-derive before the alarm ends.** A handler that advances its
  own source row has invalidated the index, and the settle that follows it
  deletes the only entry pointing at that row. `WorkspaceDO.runDueAlarmWork`
  reconciles for exactly this reason; an object that grows stored entries whose
  handlers write their own next occurrence has to do the same. Its phases are
  isolated: one that throws is logged (`workspace_alarm_phase_failed`) and the
  rest, the reconcile included, still run, and the first throw is rethrown at
  the end so the alarm retries rather than re-arming at once for rows the
  failed phase left due.
- **Every mutation of the entry list re-arms before returning.** A caller that
  schedules an entry and returns without arming has written a row nothing will
  ever read.
- **The post-work alarm is exact, and normally floored at `now + 1`.** An alarm
  set to a past instant fires immediately and re-derives the same past instant:
  that is the shape every hot-alarm loop in this codebase has had. The floor is
  not a backoff and must not become one — the overflow and slow-handler cases
  under *Failure modes* depend on the immediate re-wake. The idle hold in step
  8 of *Firing* does not touch them: a drain settles what it ran and a bounded
  pass writes the rows it took, so neither pass is idle. The pre-work arm is
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
  nothing due; the `resource_objects` arm excludes inactive publication staging
  while including eligible and current/historical referenced rows; the
  `slack_unfurls` arm counts only links on a connection the sweep would load,
  using the same millisecond ISO format as the sweep for its 30-day cutoff. An
  arm that counts what its pass leaves behind is the stall gate's steady
  customer — a drip and a report rather than a loop, but a defect all the same.
- **A bounded pass reports the rows it took off its own due query.** Every
  maintenance pass that moves those rows answers the stall check with its
  count — whether it retires them, as the reaps do, or writes the column whose
  absence made them due, as the alias backfill does — because a backlog sharing
  one second re-derives the same instant until it is gone; the two Slack sweeps
  answer nothing, because neither moves the rows its query counts and either
  would claim progress forever. A wait that is not a positive finite number is not a
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
- **Every invariant here is suspended on a *retired* object.** Retirement makes
  the coordinator's mutators — `scheduleAlarm`, `armNextAlarm`, the two cancels,
  `reconcileScheduledAlarms`, and the pre/post-work arms — inert rather than
  throwing, so on such an object a mutation returns without arming and
  `armNextAlarm` answers `null` whatever the schedule says. That is the
  requirement stated exactly: a retired object must never wake again, and
  clearing an alarm does not stop the code that re-derives it. Code that assumes
  a mutation always leaves something armed is wrong there, and a caller reading
  the return value of an arm must tolerate `null`. Retirement itself deletes
  every row and the platform alarm in one transaction; see
  [`workspace-retirement.md`](workspace-retirement.md).
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
- **A derived lane reports work its pass declines.** There is no entry to gate,
  so before 2026-11-03 nothing stopped it: a `AgentLoopDO` whose background
  agent was stopped with a message queued reported loop work at `now`, the
  claim refused it, and the alarm fired about five times a second for at least
  a week, with nothing logged. The idle hold catches the shape for every lane:
  a pass that wrote nothing and re-armed for the next millisecond is held
  behind the same backoff, and `onIdleAlarmHeld` reports it through
  `reportScheduledAlarmAttempt` with the same warn, error and notify policy.
  The attempt is stored, so a hold long enough to be evicted through still
  climbs to the ceiling and the alert. Anything that schedules or admits work
  re-arms past the hold through its own path. As with a stall, the fix is in the lane: a due-time read must
  count only work its pass will take.
- **A handler legitimately cannot act yet.** It answers `{ waitMs }` and the
  entry is held that long with no attempt counted; the first reconcile after
  its source moves clears the hold. A Terminal deadline does this while a live
  run holds the sandbox or another pass's lifecycle claim is still live (one
  minute), and after a transition whose directory effect is still on the Queue
  (thirty seconds).
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

`_internal_durable_alarms`, identical in every adopting object:

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
  itself, reported progress, or asked to wait is not. A Breakout's due timer
  is claimed from the Breakout's own object, never read through Main. For
  `WorkspaceDO` it also
  pins the phase order with every derived lane due, proves a wake runs only the
  lane that is due and arms for the one it skipped, that
  `registerAuthorizationChildren` re-arms only when it queued a delivery, and
  that an idle pass is held through the workspace's real due work, grows its
  delay across a lost instance, never passes a future candidate, keeps its
  immediate wake once a pass writes, and is not held for a derived or stored
  deadline that came due while the pass awaited.
- `apps/api/test-workers/workspace-authorization-delivery-index-migration.test.ts`
  upgrades a populated v82 object through migration 83 and counts the
  `authorization_delivery` due read's `rowsRead`.
- `apps/api/test/workspace-alarm-stall-alert.test.ts` drives `WorkspaceDO`'s
  failure and stall hooks in the Node suite: which attempt warns, which logs at
  `error`, that exactly one operator notification is posted, and that an
  episode mixing throws and stalls posts once.
- `apps/api/test/workspace-alarm-instrumentation.test.ts` proves the phase
  fields stay content-free, unknown stored kinds collapse to `unknown`, and the
  summary identifies work that crosses the recovery horizon.
- `apps/api/test/workspace-schedule-targets.test.ts` runs the due-time queries
  against the object's own ledger, for the arms the Node snapshots cannot
  exercise: the draft arm's exclusion of linked drafts, the resource-object
  arm's exclusion of inactive staging, and the rounding of a derived instant up
  to the next second.
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
  directly, or park the alarm first. The overlap is not always only a test
  artefact, though: the extra Sidekick schedule run it produced also exposed a
  production race, an entry whose schedule had moved its next occurrence into
  the future while an earlier entry in the same pass was awaited, and
  `executeSchedule` now refuses an occurrence that has not arrived. When a
  forced pass changes an outcome, ask whether one real pass interleaved with an
  RPC could change it the same way.
- Trap: an alarm armed for `now + 1` after pending-input or execution-receipt
  admission can fire while the test is still setting up, and the loop it drains
  can settle the very rows the next assertion reads. Park it in the *same*
  invocation that admits the work (`runInDurableObject`, call `fetch`, then
  `setAlarm` before the callback returns); two separate calls leave a window
  the drain can win, which is how the old dispatch-lifecycle test became
  intermittent.

## Operations

In Workers Logs, select the `WorkspaceDO` namespace and filter
`event = workspace_scheduled_alarm_work_completed` with
`crossed_recovery_horizon = true`. Group by `slowest_phase` and then
`slowest_alarm_kind`; the latter is present only when the slowest phase is a
stored target. A stored target's kind is named when `runScheduledAlarm`
dispatches it (`WORKSPACE_DISPATCHED_ALARM_KINDS`, built from the
dispatcher's own constants) and is `unknown` otherwise; a hand-kept copy of
that list once fell behind and logged every Sidekick run notice as
`unknown`. Open the enclosing invocation or trace to see the ordered phase
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

An `AgentLoopDO`'s `substream_scheduled_alarm_failed` and `_stalled` rows
name the conversation in `substream_id` beside `workstream_id`.
`substream_alarm_idle_held` and `workspace_alarm_idle_held` name the object
and the instant it was held to; they cannot name the lane, so read each
derived due-time query in that object and find the one at or before now. Read an
`agent_timer` entry's row in that conversation: a Breakout or a Sidekick run
child holds its own `workstream_wakeups`, and Main's table says nothing about
it.

### Scoped invitation email delivery

`WorkspaceDO` schedules `parent_invitation_delivery` keyed by
`<parentId>:<invitationId>` in the same transaction as the parent's invitation
receipt. The handler decrypts the frozen mail
payload, sends through the existing transactional sender with a stable provider
key, and records delivery. Revoked, expired or already accepted invitations stop
pending sends; revocation during a provider await can still deliver an unusable
link. The ordinary alarm retry handles transport failures. See
[scoped invitations](scope-invitations.md).

### Scope grant discovery delivery

A Channel's grant write adds a `scope_grant_directory` row to `parent_outbox` in
the grant transaction; there is no separate alarm kind. `WorkspaceDO` applies the
row to its own grant directory right after the write, and the outbox lane of the
alarm retries a failed apply. See [scope grant directory](scope-grant-directory.md).

## Changelog

### 2026-11-08 — A conversation's Terminal provider check is a stored kind

**What changed:** `AgentLoopDO` stores a `terminal_observation` entry (key
`sandbox`) reconciled from `terminal_provider_observation.next_observe_at` in
every Terminal write's transaction and on each alarm pass; its handler observes
the sandbox and re-arms the entry.

**Why:** The owner asked for the periodic check removed with the Thread host to
come back "as it was"; the brief put it on the store `reply_batch` and
`sidekick_run_notice` use rather than on the deleted derived candidate, so a
provider that keeps failing is held behind the entry's own backoff instead of
being retried on every wake.

**Consequences:** The entry's handler must re-derive the entry after the check
(the base settles it guarded on the instant that ran, so the re-arm survives).

### 2026-11-07 — A Sidekick's run rows are a stored kind armed by triggers

**What changed:** `sidekick_run_row` joins a Sidekick's stored kinds. It is the
one kind armed in SQL: WorkspaceDO migration 135's triggers on `sidekick_runs`
write the entry in the statement that changes the run, at one past any due
instant already held. A replay arms the same entry with a payload that forces
the conversation to apply the projection whatever version it holds.

**Why:** A run's row in the Sidekick's shared conversation must follow every
change to the run, and seven code paths write runs; arming at each would let a
writer added later leave its row behind. The +1 fence is the drain's rule: it
deletes the entry it ran by its instant, so a change during the delivery must
land at another instant to survive. The forced replay exists because an
ordinary delivery drops a projection older than the row, which would never
repair a row whose version ran ahead.

**Consequences:** A change to how this kind is armed is a migration, not an
edit to `HostedSidekick`. A trigger that re-arms the entry before a replay's
entry runs replaces it with an ordinary one; the handler reads the run either
way, so only a row whose version is ahead needs the replay run again.

### 2026-11-03 — A stopped agent's queue is not a wake reason, and an idle pass is held

**What changed:** `SubstreamAgent.nextLoopWorkAt` no longer reports a stopped
background agent's queued activation input as work; messages that start no run
still wake it. The base now holds any alarm whose pass wrote nothing and that
re-armed for the next millisecond, behind the backoff a thrown entry earns,
reported through the new `onIdleAlarmHeld` hook.

**Why:** One stopped agent with a failure notice queued ran its alarm about
five times a second from at least 2026-10-27 (the start of log retention) to
2026-11-03: 97.5% of the account's alarms and about 1.7M of its 1.9M log and
trace events an hour, every pass a read-only no-op. The stall gate covers only
stored entries, so a derived lane had no guard.

**Considered and rejected:** Comparing the overdue derived instants before and
after a pass would also hold a bounded drain whose rows share one instant,
which is progress. `total_changes()` tells the two apart. `setAlarm` counts as
a change, so the sample sits inside the two re-arms and subtracts the object's
own arming inside it. Keeping the attempt in memory would restart it at the
first step after every eviction, so it would never reach the alert; it is
written after the sample instead. A threshold of idle
passes before holding would add a defensive number; the hold starts at the
first idle pass, as the stall gate does, and reuses the existing delay steps.

**Consequences:** No new limit. A lane whose state moves without a local write
and without re-arming waits up to the current hold before it is read again.

### 2026-10-22 — Reconcile Sidekick source accounts through the existing alarm

**What changed:** Consent, connection authority and membership/reach changes
queue source reconciliation in WorkspaceDO's stored alarm lane. Migration 130
wakes existing active configured Sidekicks. Consent and its refresh wake commit
together, and connection writes re-arm the native alarm.

**Why:** A grant can make a configured resource readable through another
account, while withdrawal can remove that source. Without a durable wake,
scheduled reads and event subscriptions would use different account sets.

**Considered and rejected:** Synchronous provider checks or a separate
authorization sequencer would add latency beyond the agreed eventual-consistency
contract. A separate row per originating action repeats the same latest-state
read; one key with a strictly advancing instant preserves newer work through
the scheduler's existing conditional settlement.

**Consequences:** Each Sidekick retains at most one pending refresh;
only changed registrations move their event cutoff. This introduces no new
retry policy or historical-event replay.

### 2026-09-28 — A WorkspaceDO wake runs only the lanes that are due

**What changed:** `runDueAlarmWork` no longer runs every derived phase on every
wake. Each lane — parent outbox, parent breakouts, directory follow-ups,
authorization deliveries, resource search, Space default publication, Space
bootstrap, activity and connector-event retention, Space intent resume — runs
only when its own due time is at or before the wake's `now`, read from the same
`derivedAlarmLanes()` list the alarm is armed from. Migration 83 indexes
`authorization_delivery(not_before)`, the one lane whose due read scanned its
table. `registerAuthorizationChildren` and `beginAuthorizationBackfill` re-arm
only when a delivery row came back from the write, and
`registerSearchAuthorization` no longer re-arms at all.

**Why:** Juno Labs' WorkspaceDO woke about 1,500 times an hour, and each wake
ran every lane's full query — the parent-outbox drain's sort, the directory
follow-up page, the resource-search page, both retention sweeps, both Space
claims — whether or not anything in it was due. A wake is almost always for one
lane. The re-arm on every register call is the likely source of most of those
wakes (#1007); after #1007 nothing `registerSearchAuthorization` writes is a
lane, and a child registration that skips every known child queues nothing.

**Considered and rejected:** Computing every due time once at the top of the
pass. A lane that runs early in the pass can write work for a later one, which
the old code drained in the same wake; reading each lane just before it runs
keeps that, at the same one indexed read per lane. Giving the schedule
reconcile a due time: what it repairs is a stored entry the drain just
settled, which no table dates, so it still runs every wake. Indexing
`parent_outbox`, `resource_search_versions`, `workspace_directory_followups` or
`space_intents` as well: on workerd their due reads already touch one to four
rows from an existing index, and an index nothing needs is write cost on every
row.

**Consequences:** A new derived lane goes in `derivedAlarmLanes()` and is gated
in `runDueAlarmWork` by the same entry, never by a read of its own. A lane's due read runs on every
wake and every re-arm, so it must be answered from an index. A write path that
arms must arm on a returned witness of the row it queued, not unconditionally.

### 2026-09-17 — Persist invitation delivery beside its grant operation

WorkstreamDO invitation creation now schedules its email in the same local
transaction as the receipt. Sending only from the HTTP handler would strand a
committed invitation after a failed response. The existing per-object alarm
queue retries the frozen body with a stable provider key; a separate email
scheduler would duplicate that durable mechanism. Acceptance and revocation
remain owner decisions independent of whether a mail was delivered. Grant
discovery uses the same alarm mechanism to hand committed changes to the parent
outbox, avoiding request-lifetime delivery that could lose accepted shares.

### 2026-09-11 — Unfurl expiry uses the sweep's timestamp format

**What changed:** The unfurl due query formats its 30-day cutoff as a UTC ISO
timestamp with milliseconds, matching the stored links and refresh pass.

**Why:** Production reached 45 stalled attempts because SQLite's space-separated
`datetime` cutoff sorted before every ISO timestamp on the cutoff day. Three
expired links remained scheduled while the refresh pass excluded them; the
oldest pinned the due instant and delayed eligible cards behind retry backoff.

**Considered and rejected:** Resetting the retry counter or advancing expired
links would hide the disagreement without making the due predicate accurate.

**Consequences:** Expiry must agree in precision, format, and inclusive boundary
between selection and scheduling. The existing retry gate and retention window
remain unchanged; this fix does not establish a connection to runtime spikes.

Pull request: [#709](https://github.com/juno-ai-labs/avalon/pull/709).

### 2026-09-08 — Index pending resources and reconcile only affected alarm kinds

WorkspaceDO migration 39 adds partial indexes for expired upload drafts and
resources without slugs. The maintenance queries retain their link/reservation
exclusions and deadlines, but no longer visit every completed resource when no
work remains. Runtime SQL writes now derive and reconcile only their source
kinds, including watch removal when a resource deletion cascades; typed note,
Slack, and digest writes do the same. The public
repair operation and post-drain recovery still reconcile all kinds.

The billing investigation found each empty resource maintenance query reading
about 71,000 rows, repeatedly behind unrelated writes. Caching due times or
skipping no-op replays was rejected: durable source rows must remain authoritative,
and a replay must repair a previous failed post-commit refresh. A scoped reconcile
must preserve other kinds and surviving retry gates. New alarm-source tables must
be assigned the kind their writes can change.

### 2026-09-05 — A retired object arms nothing, and says so quietly

**What changed:** The coordinator's mutators became no-ops on an object holding
a retirement tombstone, and retirement clears `_internal_durable_alarms` and the
platform alarm in one transaction. Nothing in this file's own code changed; the
gate that does it lives in
[`workspace-retirement.md`](workspace-retirement.md).

**Why:** The spike behind workspace retirement cleared a retired object's
alarm and watched it come back after the next traffic, because clearing an alarm
does not stop the code that re-derives one. Refusing the mutators instead would
have been worse in both directions: retirement's own pass calls through them to
clear what is armed, and a continuation admitted a moment before the tombstone
would turn its re-arm into an error rather than into the nothing it should
become.

**Considered and rejected:** Deleting the rows and leaving the derivation alone —
that is exactly what the spike did, and the alarm returned. Throwing from the
mutators — turns a late continuation's harmless re-arm into a stack trace, and
breaks retirement's own clearing pass.

**Consequences:** Two invariants above now hold only for a live object: a
mutation no longer implies something is armed, and `armNextAlarm` can answer
`null` with entries still in the table. A migration that seeds
`_internal_durable_alarms` rows runs inside the construction window, where the
gate is deliberately open, so a retired object taking such a migration re-arms a
real platform alarm; the wake is then dropped, so it is inert residue rather
than a live schedule.

### 2026-09-03 — The automation object stores a run entry per occurrence

**What changed:** `AutomationDO` replaces `AutomationAgent` as the fourth
adopter. Its stored kinds are `automation_schedule` and `automation_run`; the
`compiler_dispatch` kind is gone with the compiler, and the "next run awaiting
provisioning" derived lane became one stored entry per admitted occurrence.
Its derived lane is the shared parent-outbox drain.

**Why:** [`automation-lifecycle.md`](automation-lifecycle.md) records the
rebuild. For this document: a stored entry per run gives each occurrence its
own backoff gate, which the derived "oldest pending row" lane could not, and
the outbox lane no longer needs a failure-collecting `runDueAlarmWork` of its
own because provisioning is not in it.

**Consequences:** A pause or delete cancels every `automation_run` entry with
`cancelScheduledAlarmKind`; a new trigger kind arms its entry through
`admitOccurrence` and nothing else.

### 2026-09-01 — Substream external settlement becomes an independent derived lane

**What changed:** `SubstreamAgent` now derives the oldest externally unsettled
terminal receipt separately from executable loop work. An eager `waitUntil`
drain handles it without blocking inference; the shared alarm retains the
durable recovery candidate and parks it at the run-drain recovery horizon while
that continuation is active.

**Why:** `nextLoopWorkAt` previously combined terminal delivery/maintenance
with executable receipts, and the persistent loop always selected settlement
first. A connector or metadata refresh could therefore delay the next provider
call despite having no effect on its transcript or Bind fence.

**Considered and rejected:** A stored alarm entry per terminal run duplicates
the due and retry fields on `runs`, while omitting settlement from alarm
derivation makes an eviction capable of losing it. Leaving active settlement at
an immediately due instant recreates the overlapping hot-alarm shape the
recovery horizon exists to prevent.

**Consequences:** The object alarm has two independent run-related candidates.
External settlement failure holds external ordering but never loop execution;
every terminalization and settlement retry must re-arm from the persisted head.

### 2026-09-01 — An unsettled message admission is a SubstreamAgent wake reason

**What changed:** `SubstreamAgent`'s run lane derives the expiry of the
in-memory claim over an unresolved `pending_loop_input_mailbox` row, and the
product service arms directly at the cancellation-recovery horizon *before* it
commits that row — a third deliberate direct-arm call site alongside the pending
loop input and the unlinked execution receipt, and, like both of those, one that
can only pull the alarm in.

**Why:** A message is admitted in two durable steps, and only the second made it
visible to the run lane: `pendingInputs` deliberately hides a `preparing` row
and everything queued behind it, and `nextRecoverableInputPreparationAt`
returned `null` while the isolate held the in-memory claim. So between the two
steps the object derived no wake reason at all, and an admission the runtime
cancelled — no throw, no `finally` — left a durable reservation with nothing to
rediscover it. The message and every message queued after it then waited for an
unrelated request, which for a work stream nobody reopens never comes. This is
the same hazard the pre-work arm exists for, reaching the one durable row that
was not yet a wake reason. Arming *before* the commit rather than after is what
makes it unconditional — an arm written second leaves a window, however narrow,
where the row is durable and the wake-up is not.

**Considered and rejected:** A stored `_internal_durable_alarms` kind per
reservation would have survived the same way, with retry gating and a stall
report for free, but it makes an admission write and cancel an index entry on a
path whose whole point is to commit fast, and the entry would outlive nothing
the derived instant does not already cover. A fixed heartbeat while the claim is
held was rejected in favour of the claim's own expiry instant: a live claim
cannot change its answer before then, so waking earlier spends the object's one
alarm on a question nothing can have answered.

### 2026-08-28 — AutomationAgent adopts the base, with two stored kinds and two derived lanes

**What changed:** `AutomationAgent` is the fourth object to extend
`ScheduledDurableObject`. It stores `compiler_dispatch` per compiler run and
`automation_schedule` per schedule, and derives two lanes — the effect outbox and
the next occurrence awaiting provisioning. `runDueAlarmWork` runs those two lanes
independently and rethrows the first failure only after both have had a pass. The
workspace alarm no longer has an automation target at all: the cutover rebuilt
`schedules` without `automation_subscription_id`, so `refreshSchedule` reconciles
connector polls and digests and nothing else.

**Why:** A Durable Object has one native alarm, and an automation has several
reasons to wake that must fail independently — a provider refusing a compiler run
must not hold a due schedule. Running the two derived lanes in sequence turned out
to be the same mistake one level down: a run that could not be provisioned threw
before the outbox lane ran, so workspace projections and the child-archive effects
a deletion depends on stopped behind it.

**Considered and rejected:** A stored entry per lane, including provisioning and
the outbox. Both are "the earliest row in this table" with their own writers and
no identity that can fail on its own, which is exactly the derived case; giving
them keys would have added a reconcile with nothing to reconcile.

**Consequences:** WorkspaceDO no longer schedules automation occurrences; timer
arithmetic, daylight-saving behavior, and missed-occurrence policy are local to
`AutomationAgent`, and a resumed automation recomputes each schedule's next
occurrence from now rather than firing what it slept through. A new automation
wake reason that can fail on its own is a stored kind; one that is the earliest
row of one of its tables goes in `nextDerivedAlarmCandidates` — and if it is a
third lane in `runDueAlarmWork`, it collects its failure like the other two rather
than throwing past them.

### 2026-08-28 — Resource cleanup schedules only actionable ownership

**What changed:** The `resource_objects` due query now matches its maintenance
pass: eligible deletion rows and staged rows already named by a current or
historical pointer are due; inactive staging still owned by a publisher is not.

**Why:** Publication staging deliberately makes an inactive row unsafe to
delete. Counting that row anyway would keep one immutable due instant behind
the stall gate forever, producing retries and operator alerts for a pass that
could not make progress.

**Considered and rejected:** Using the scheduler stall as implicit operator
reconciliation. The alarm contract treats a source it cannot move as a defect,
and a repeated wake supplies no new fact about whether an ambiguous writer can
still commit.

**Consequences:** Inactive staging remains durable for explicit reconciliation
without blocking newly actionable cleanup. Any future cleanup state must update
both the pass and its due predicate together.

Shipped in [#395](https://github.com/juno-ai-labs/avalon/pull/395).

### 2026-08-28 — A maintenance pass names the resources that have no alias yet

**What changed:** A `resource_slugs` maintenance task joins the workspace
alarm's reconciled entries, due at the oldest `resources` row whose `slug` is
null and reporting the rows it named as progress.

**Why:** A resource's alias is minted by an HMAC over its coordinates, so no
migration can write one — every row that existed before the column, and every
row whose creation path could not finish its own allocation, needs a pass. The
resource row is its own durable record of the work, which is why the arm counts
exactly what the pass writes and the entry disappears once none are left.

**Considered and rejected:** Allocating lazily on a read. That puts a write on
a read path, and leaves a resource unnamed for as long as nobody looks at it —
which is exactly the resource a model is about to be handed.

**Consequences:** The pass shares the reap batch bound of its neighbours in the
same module, and an allocation failure at creation costs a delay rather than
the row.

### 2026-08-28 — Alarm lanes follow persistent-loop authority

**What changed:** The persistent substream loop cutover moved alarm-driven
work onto loop and receipt state: semantic transcript publication became a
derived alarm lane and the run alarm re-derives from loop authority. The
facets below are the decisions this change is made of — each carries its own
rejected alternative and its own invariant.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).

#### Semantic transcript publication is a derived alarm lane

**What changed:** `SubstreamAgent` includes the earliest object-local semantic
realtime outbox row in normal derivation, during-run recovery arms, due-work
checks, and alarm draining.

**Why:** A transcript mutation and its realtime reference now commit together,
but the isolate can still disappear before its best-effort post-commit drain or
alarm arm. Constructor derivation and the shared alarm make that durable row
discoverable without a second scheduling ledger.

**Considered and rejected:** A stored `_internal_durable_alarms` entry per room
event duplicates identity and retry state already carried by `durable_outbox`.

**Consequences:** A failed publication stays in sequence and is retried by the
same object; later ephemeral frames do not overtake it.

#### The run alarm follows persistent-loop authority

**What changed:** SubstreamAgent derives its run lane from the
`substream_loops` singleton, pending inputs, and unlinked or terminal-unsettled
execution receipts. The retired SubstreamAgent `agent_run_dispatches` table is no
longer an alarm source. The during-drain override still excludes that one lane
while preserving regional effects, HyperSight refresh, stored timers, and the
keep-alive recovery horizon.

**Why:** Dispatch was a second activation ledger that could disagree with the
persistent loop and its receipt. Removing the table without changing the alarm
explanation made the old architecture look required and invited a future writer
to recreate it.

**Considered and rejected:** Keeping a dispatch row solely as an alarm index.
The singleton and receipt already contain every due/recovery instant, so an
index with its own lifecycle would restore split authority without reducing a
query or wake.

**Consequences:** Immediate post-admission arming protects pending inputs and
unlinked receipts from isolate loss; later exact derivation comes only from
their owning rows. In-memory drain state remains deduplication, never scheduling
authority.
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
every other maintenance pass every time it retries.
