# Thread backfill

A one-off job over every thread of an Organization and each of its open
Breakouts: a work list in `WorkspaceDO`, an alarm lane that sends it to the
activity Queue one batch at a time, and a consumer that runs the job over each
conversation through its own object. Its first job summarizes the description
of every thread and Breakout created before the first naming pass asked for a
summary ([`workstream-descriptions.md`](workstream-descriptions.md#the-first-summary)).
Its second judges the newest settled Rally turn of every conversation for a
merge or Breakout suggestion
([`conversation-suggestions.md`](conversation-suggestions.md#the-backfill)).

It is [Channel colour sync](workstream-appearance.md)'s lane with the triggers
and revisions taken out. Colour sync is a standing job whose rows keep being
re-marked by writes; a backfill is filled once by a migration and done when the
consumer says so.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/thread-backfill.ts` | The `thread_backfill` table and its migration, the job list, the alarm lane (`nextThreadBackfillAt`, `publishThreadBackfill`), and the settle, release and work halves. |
| `apps/api/src/durable-objects/workspace-do.ts` | Migrations 100 and 115, the `thread_backfill` alarm lane, and the `threadBackfillWork`, `completeThreadBackfill` and `releaseThreadBackfill` RPCs. |
| `apps/api/src/queues/activity-consumer.ts` | `THREAD_BACKFILL_HANDLERS`, the one place a job's per-conversation work is named, and the branch that runs it over Main and each open Breakout. |
| `apps/api/src/services/workstream-naming-service.ts` | `summarizeExistingDescription`, the `description_summary` job. |
| `apps/api/src/services/suggestion-backfill-service.ts` | `backfillSuggestion`, the `suggestion_backfill` job: one RPC to the conversation object, and `settledBackfillOutcome`, which throws on a classifier failure. |

## How it works

1. **A migration fills the list.** Migration 100 creates `thread_backfill`
   (`job`, `workstream_id`, `attempts`, `not_before`, `in_flight`) and inserts
   one `description_summary` row for every thread that is not archived.
   Migration 115 lists every open thread again, for `suggestion_backfill`.
2. **The alarm sends one batch.** The `thread_backfill` lane sends up to 100
   due rows to `ACTIVITY_QUEUE`, marking each `in_flight` with a retry gate
   first. While any in-flight row's gate is ahead it sends nothing, so the next
   batch waits on the consumer rather than on a chosen interval.
3. **The consumer runs the job.** It asks `threadBackfillWork` for the thread's
   conversations: Main (`"0"`) and each open Breakout from WorkspaceDO's own
   `breakouts` table. It runs the job's handler over each in turn, logs
   `thread_backfill_conversation` with the handler's outcome, and settles the
   row with `completeThreadBackfill`.
4. **A pass is bounded and resumes.** The first `threadBackfillWork` call for
   a row records the last conversation in id order as `through_child`, and
   every later pass stops there: a conversation created after the backfill
   started runs the job's own live path, so it is not the backfill's work. A
   pass that stops at a conversation still delivering records it with
   `deferThreadBackfill` as `resume_from`, and the next pass starts there
   instead of at Main. Both columns are WorkspaceDO migration 133.
5. **A failure releases the row.** The consumer logs `thread_backfill_failed`,
   releases the row so it holds no successor back, and acks the message. The
   row's own gate sends it again.

A thread that is archived, or that WorkspaceDO has no projection of, is
settled by `threadBackfillWork` without running anything.

The `conversation_view` job is the exception to the open-thread universe:
WorkspaceDO migration 124 lists every parent in `parent_children` and
`sidekick_children` and the hosted-parent directories, including legacy parents
with no stored Main child. Its work lookup adds that implicit Main and returns
all ready children, including archived conversations. Each child is woken to deliver its compact display
projection. The parent stays claimed while that child has pending deliveries;
the next child and completion wait for WorkspaceDO to receive the projection. [Conversation view cache](conversation-view-cache.md) owns
the payload, delivery, and rollout details; this lane owns scheduling the pass.

### Adding a job

Add the name to `THREAD_BACKFILL_JOBS`, a handler to
`THREAD_BACKFILL_HANDLERS`, and a WorkspaceDO migration that inserts its rows.
Ship the code before or with the migration, never after: the lane parses each
row's job, and one it does not know fails the batch's publication.

### Reaching every Organization

A migration runs when its object next wakes, and an Organization nobody opens
does not wake on its own. After the release that carries the migration, force
`WorkspaceDO` from the migration tracker
([`durable-object-migration-tracking.md`](durable-object-migration-tracking.md)),
which wakes every Organization in every region. Each then fills its list and
arms its own alarm.

## Invariants

- **One batch in flight per Organization.** Sending batches back to back
  repeats the resource-search backfill's overload (`docs/text-search.md`,
  2026-09-26), and each conversation here costs a model call. Guard: the
  pacing case in `test-workers/thread-backfill.test.ts`.
- **A job is safe to run twice over the same conversation.** A row whose
  consumer failed part way is sent again whole, including the conversations
  it already did. `description_summary` writes nothing over a description
  that is no longer empty or the opening message's first line, so a second
  run can repeat a model call but never a write.
  Guard: `workstream-naming.test.ts`, "backfilling an existing thread's
  summary". `suggestion_backfill` is gated by the observer's one judgement
  per run: a second run over a judged conversation skips as `already_judged`
  and calls nothing. Guard: `conversation-suggestions.test.ts`, "judges a run
  once".
- **Only the latest claim releases a row.** Each message carries the
  `attempt` it was claimed under, and a release from an older delivery is
  refused. A delivery can outlive its gate, and the alarm then claims the row
  again; letting the older one's late failure clear that claim would send the
  next batch while this one still runs. Guard: the release case in
  `test-workers/thread-backfill.test.ts`.
- **A pass only shrinks.** It covers the ids from `resume_from` to
  `through_child`; the first never moves back (`deferThreadBackfill` refuses an
  earlier id, and a claim the alarm has replaced), and the second is fixed
  once recorded. A thread that gains conversations faster than one pass takes
  still finishes. This relies on the consumer running the list in id order,
  which `threadBackfillWork` returns. Guard: the resume case in
  `test-workers/thread-backfill.test.ts`.
- **A row is settled only after every conversation ran.** Settling first
  would lose the rest of the thread on a failure. Guard: the Queue case in
  `test-workers/thread-backfill.test.ts`.
- **A model failure is a failure, not an outcome.** `summarizeExistingDescription`
  throws `description_summary_model_failed` so the row is retried; reporting
  it as `unchanged` would settle the row with the model down. A conversation
  whose object is not authoritative is the opposite case: it refuses every
  read until initialization or an import makes it authoritative, which no
  retry does, so the job reports `not_authoritative` and the row settles.
  Guard: `workstream-naming.test.ts`. `backfillSuggestion` throws the same way on a
  transient classifier failure (`suggestion_backfill_classifier_unavailable_<kind>`
  for a 5xx, 408 or 429, a deadline or an unreachable provider; the observer
  keeps no answer for a failed judgement, so the retry asks again) and on a
  step that threw before judging (`suggestion_backfill_<reason>`), which the
  settlement lane only logs; a failed parent read is one such step here,
  where settlement reads the parent best-effort. A classifier failure no retry would fix (a
  missing or refused key, a rejected request, an answer that failed the
  schema) settles, with the kind in the judgement as the record: the lane caps
  nothing, so retrying it would pay for a call every gate for good. Guard:
  `suggestion-backfill-service.test.ts`.

## Boundary

This module owns the work list, its pacing, and the dispatch to a job's
handler. It does not own what a job writes: `description_summary` writes
through the identity port's `redescribe`, whose compare-and-swap is
[`workstream-descriptions.md`](workstream-descriptions.md)'s. It does not wake
Organizations; the migration tracker does. It is not for standing work whose
rows writes keep re-marking: that is colour sync's shape, with triggers and
revisions.

## Failure modes and limits

- **Model down.** Each failing conversation throws, the row is released, and it
  retries at its gate (`scheduledAlarmRetryDelay`). Nothing is settled while the
  model is down.
- **No model key** (`OPENROUTER_API_KEY` unset, as locally). Naming returns
  nothing without failing, so rows settle as `unchanged`. A backfill run where
  the key is missing does nothing and finishes. Without `TYPESAFE_API_KEY`,
  `suggestion_backfill` records each conversation as `classifier_unavailable`
  with `typesafe_key_missing` and settles it the same way.
- **A conversation object that never became authoritative.** The directory can
  list a thread whose object is still the `preparing` placeholder every
  object is born with (seen in production: projected with a title and a
  creator, the object empty and in `awaiting_authoritative_import`). Opening
  it fails, and `description_summary` settles it as `not_authoritative`.
  Repairing the thread is outside this lane.
- **A retired Organization** refuses the write; the consumer acks without
  releasing the row or logging a failure.
- **Batch size** is 100, Cloudflare Queues' `sendBatch` ceiling.
- **One batch in flight holds only while consumers keep up.** A claimed row
  stops counting as in flight when its first retry gate passes
  (`scheduledAlarmRetryDelay(1)`, 30 to 60 seconds). During a fleet-wide wake,
  every Organization's batch shares the activity Queue, and a row still
  waiting there is sent again with the next batch. Both copies call the model;
  the compare-and-swap keeps one write, and a settled row's late copy does
  nothing. The cost is duplicate model calls and a longer activity backlog
  while the backfill runs.

## Testing

- `apps/api/test-workers/thread-backfill.test.ts` (real workerd): the work
  RPC's answer and settling, pacing, and a Queue delivery against a real Main
  conversation. Run with `pnpm --filter @rally/api test:workers`.
- `apps/api/test/workspace-thread-backfill-migration.test.ts`: migration 100
  lists open threads and skips archived ones;
  `workspace-suggestion-backfill-migration.test.ts`: the same for 115.
- `apps/api/test/suggestion-backfill-service.test.ts`: the `suggestion_backfill`
  answer, thrown on a classifier failure and settled on a missing key.
- `apps/api/test/workstream-naming.test.ts`: the `description_summary` step,
  thrown on a model failure and settled on an object that is not
  authoritative.

## Operations

| Event | Means |
| --- | --- |
| `thread_backfill_conversation` | One conversation ran. `outcome` is the handler's; for `description_summary`, a `DescriptionSummaryOutcome`; for `suggestion_backfill`, `nothing_to_judge` or the observer's `skipped:<gate>`, `judged:<code>`, `resumed` or `failed:<reason>`. |
| `thread_backfill_failed` | A thread's job threw; its row retries at its gate. `reason` is the thrown code; a conversation object's refusal arrives as the object's own code. |
| `thread_backfill_publication_failed` | The alarm could not send a batch; its rows retry at their gates. |

The list drains to empty when the job is done. A row that keeps coming back
shows as repeated `thread_backfill_failed` for one `workstream_id`.

## Changelog

### 2026-11-02 — A stopped pass resumes, and a pass ends at the conversations it started with

**What changed:** `thread_backfill` gains `resume_from` and `through_child`
(WorkspaceDO migration 133). A `conversation_view` pass that stops at a
conversation still delivering records it, and the next pass starts there.
The first pass records the last conversation it covers, and later passes stop
there.

**Why:** A pass that stopped started over at Main. In production one
thread had about 800 children and gained about two an hour; one pass over
them took about 23 minutes, and every stop logged on 11-02 was at the newest
child of the time. Its pass never finished: 224,310 deliveries from
2026-10-27 to 11-01 and 47,493 on 11-02, all for that one thread. The activity
Queue takes one message per invocation, and Slack thread replies waited
behind that loop for about 15 minutes before reaching their Sidekick run.

**Rejected:** Recording progress after every conversation, which adds an RPC
per conversation to every pass for no gain over recording only where a pass
stopped, since a pass runs in order. Leaving later conversations in the pass
and relying on the resume point alone, which still re-runs the loop whenever
a new conversation is mid-delivery as the pass reaches it.

**What a future change has to respect:** the consumer runs the list in the
order `threadBackfillWork` returns it, which is id order. A job whose
conversations do not run its live path on creation cannot use the
`through_child` bound.

### 2026-10-19 — A conversation that cannot serve settles

**What changed:** `summarizeExistingDescription` answers `not_authoritative`
when the conversation object refuses its identity read as
`workstream_runtime_authority_fenced`, so the row settles instead of
throwing.

**Why:** One `description_summary` row in the KB QA Organization reached
attempts 383, retried at the 30-minute gate since the backfill began. Its
thread's Main object is the `preparing` placeholder at authority generation
zero, with no title, transcript or participants, though WorkspaceDO lists the
thread with all three. Every port operation refuses such an object, so the
first read threw on every attempt. `suggestion_backfill` settled the same
thread because it reads the object's storage directly and found no turn to
judge. The log said only `thread_backfill_failed`; `diagnosticErrorCode` now
names the object's refusal
([`naming-a-schema-failure.md`](naming-a-schema-failure.md)).

**Considered and rejected:** Settling every error a handler throws once it
repeats: a model outage would then settle rows with nothing written, which
the model-failure invariant exists to stop. Checking authority in
`threadBackfillWork`: WorkspaceDO does not know the object's authority, and
asking would be one more RPC per conversation for every job. Skipping the
fence for this read: the fence is what keeps a placeholder from answering as
a real conversation.

**Consequences:** A thread whose object later becomes authoritative is not
summarized by this backfill; its initialization or import writes its own
description. How the KB QA thread's object lost its initialization on
2026-10-06 was not traced; that is a repair for the thread, not for this lane.

### 2026-10-19 — A second job: the suggestion backfill

**What changed:** WorkspaceDO migration 115 lists every open thread for
`suggestion_backfill`, whose handler asks each conversation's object to judge
its newest settled Rally turn for a merge or Breakout suggestion, through the
same observer a settlement runs.

**Why:** Suggestions shipped on 2026-10-18 for turns settled from then on, and
the product owner asked for existing conversations to get theirs. The lane
existed for exactly this, so the backfill is a migration, a handler and one
RPC.

**Considered and rejected:** Judging every turn of every conversation. The
chip shows only under one of the newest three messages, so an older judgement
would be recorded as `late` and shown to nobody: one call per conversation,
for its newest settled turn, is the whole visible result at a fraction of the
cost.

**Consequences:** The observer's gate 3 no longer counts a recorded classifier
failure as a judgement, so this job can throw on one and have the retry ask
again; a replayed settlement after such a failure asks again too. Running the
job twice is one skipped RPC per conversation.

### 2026-10-13 — A work list for one-off jobs over every thread

**What changed:** WorkspaceDO migration 100 adds `thread_backfill` and lists
every open thread to have its description, and each Breakout's, summarized.

**Why:** The first naming pass now summarizes a new thread's request, and the
product owner asked for existing threads and Breakouts to match. Colour sync
already solved pacing a per-thread job across an Organization; this lane is
that solution, kept generic so the next backfill is a migration and a
handler rather than another copy.

**Considered and rejected:** An operator route that walks every thread from
one consumer, as connector maintenance does. One invocation looping over
every thread with a model call each is the long loop
[`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md) rules out. Reusing
`channel_color_sync` itself was rejected because its rows carry revisions
that its triggers advance; a second meaning in the same table would need
both to agree on every row.

**Consequences:** Every job must be safe to run twice over a conversation. A
job's name may not be inserted by a migration before the code that runs it
ships.
