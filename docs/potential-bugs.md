# Potential bugs and coverage gaps

Things found while reading the code that look wrong, or that nothing proves are
right. Each entry says what was observed, why it is suspicious, and — the part
that matters — **what would settle it**.

Nothing here is a confirmed defect. A confirmed defect gets fixed in the change
that finds it, or filed as work; this file is for the ones where the evidence
stops short of proof and the next person should not have to rediscover the
question. An entry is deleted when it is resolved, with the resolution recorded
in the owning module document's changelog.

**Read this before assuming a suspicious-looking path is fine because tests
pass.** Several entries below exist precisely because the tests that covered
them were covering unreachable code.

## How entries are written

- **Observed** — what the code does, with `file:line`.
- **Why it is suspicious** — the invariant it appears to break, or the claim
  nothing checks.
- **What would settle it** — the specific evidence that turns this into either
  a fix or a deletion. An entry without this is an opinion, not a finding.
- **Severity** — `data-loss`, `wrong-answer`, `waste`, or `coverage-gap`.

---

## Resolved, and kept briefly as a warning about this file's own method

Two entries lived here and were deleted within the hour, both because a closer
read turned "live bug" into "dead code".

`loadSource` in `work-opportunity-service.ts` appeared to query the dropped
`activity_events` table on its live arm, for the `'message'` batch events that
`enqueueMentionOpportunitySnapshot` really does produce. It does not: the
`if (workspace)` block above it returns first, and `workspace` is non-null
exactly when the authority is open. Both halves of the ternary below it were
unreachable, and are deleted. Slack's `assignWorkspaceSessions` was the same
shape and is deleted too.

**The method that produced both false alarms was tracing a table to a query and
stopping.** What settled them was tracing the *control flow* to the query — the
early return, and the guard that makes it unconditional. That is the same
mistake, in the same file, that this repository's own PRD made about five
statements at once. Assume a suspicious query is reachable only after reading
everything above it that can return.

---

## A Sidekick triggered only on `resource_watch` may never start

**Severity:** wrong-answer

**Observed** — `resource_watch` is a submittable trigger: it is in the
`submit_draft` type enum with its own `resourceId`
(`packages/agent-harness/src/index.ts:2444`), defined in the trigger union
(`packages/contracts/src/index.ts:1205`) and mapped through
(`index.ts:2992`). But `HostedSidekick`'s accept path builds it nothing. The
schedule loop handles `interval` and returns early on anything that is not
`calendar` (`apps/api/src/durable-objects/sidekick-do.ts:1913-1933`), and
`isExternalEventTrigger` covers only `connector_activity`,
`semantic_activity` and `webhook` (`contracts/src/index.ts:1238`), so no
evaluator is built either.

**Why it is suspicious** — a draft whose only trigger is `resource_watch`
appears to be accepted and activated with nothing armed to start it: the
silent inertness the `eventTypes` schema description warns about elsewhere,
but reached through a trigger kind rather than a mistyped event name. The
`resource_watches` table and its polling in
`apps/api/src/services/workspace-schedule-execution.ts` are a different
mechanism with its own writers, and nothing found so far connects a
Sidekick's trigger to it.

**What would settle it** — accept a Sidekick whose only trigger is
`resource_watch`, change the watched resource, and see whether a run starts.
If none does, either wire the trigger or refuse it at submission, because a
trigger the draft tool offers and the accept path drops is worse than one
that does not exist. If one does start, find the writer that arms it and
record it here before deleting this entry.

**Noticed while** adding the `polling-for-events` skill, which is the one
place that talks a model through "tell me when this thing changes" — the
request most likely to reach for this trigger. The skill steers off it in
the meantime, which is a workaround, not the fix.

---

## The work-stream composer's own length refusal is unexercised

**Severity:** coverage-gap

**Observed.** `sendMessage` in
`apps/desktop/src/renderer/screens/workstream.tsx` refuses a message over
`MESSAGE_MAX_CHARACTERS` before the optimistic turn is inserted, setting
`sendError` to `MESSAGE_TOO_LONG_MESSAGE`. Nothing tests it. `WorkstreamScreen`
is mocked out in every suite that references it — `App.session-gate.test.tsx`
replaces it with a `<div>` — and `workstream.test.tsx` renders only the header
and the notice components, never the screen.

**Why it is suspicious.** It has already been wrong once. The guard shipped into
review returning rather than throwing, and `WorkstreamComposer.send` clears the
draft *before* awaiting `onSend` and restores it only if `onSend` rejects — so
the refusal deleted the message it was asking the person to shorten. A review bot
caught it on the pull request that introduced it; nothing in the suite did, and
the composer's own reject-restores-the-draft tests passed throughout, because
they exercise the composer against a mock rather than against this screen.

That is the shape of the gap: the equivalent guard on the new-work-stream
composer is covered three ways, and the two were written together. This one
holds the same rule on the other composer, across a contract — resolve means
sent — that only the screen and the component together express, and rests on a
code read. Its failure is not silent at the server: the SubstreamAgent answers
the same refusal with the same sentence, which
`test-workers/message-to-output-pipeline.test.ts` proves. But everything between
the keystroke and that socket frame — the draft surviving, the optimistic turn
never appearing — nothing checks.

**What would settle it.** A harness that renders `WorkstreamScreen` for real —
session, query client, router, workspace and work-stream sockets — and asserts
that a message over the ceiling shows `MESSAGE_TOO_LONG_MESSAGE`, never calls
`createMessage` on the socket, and leaves the transcript untouched. That harness
does not exist and is worth more than this one assertion: it is the reason the
screen with the most behaviour in the renderer is the least covered.

---

## A digest follows the account timezone; an automation created from it does not

**Severity:** wrong-answer

**Observed.** `workspace-service.ts:363` re-derives every digest's `schedules`
rows when somebody changes their account timezone
(`rebuildDigestSchedulesForTimezone`), and the cron reconciler repairs any it
misses by comparing each derived row's zone against the account —
`digest-service.ts:284` scopes that comparison `WHERE digest_schedule_id = ?`,
so it never reaches an automation's rows. Nothing does either for automations:
`scheduleTimezone` resolves an unnamed calendar zone from the account when the
row is written and the resolved value is frozen there.

Three readers answer "what zone is this automation in", and they do not agree
once the account moves. The `schedules` row is frozen at derivation; the digest's
is re-derived; and `runLocalTimezones` (`integrations.ts:6539`) resolves the same
order *live* on every run, so `current_time` reports a local day the run's
own schedule contradicts. (A fourth, the result email's date, went with the
deterministic delivery path on 2026-09-03.) Whoever settles the question below
should settle all three, not the first one they find.

**Why it is suspicious.** Both rows are derived from the same column for the
same reason, and one follows it while the other does not. Somebody who moves
from New York to London and updates the setting gets their digest at nine in
London and their morning briefing at nine in New York, from one change they made
in one place.

**What would settle it.** Whether an automation's zone is part of its
*definition* or of its *owner's day*. The case for frozen: unlike a digest, an
automation displays its zone — the trigger summary is prose naming it, written
when the automation was created — so moving the occurrence silently contradicts
the sentence on the screen. The case for following: an unnamed zone was never
part of the definition, which is exactly what `timezone: null` now records. Note
that nothing regenerates a trigger summary after creation — the edit dialog takes
instructions and activity sources, and `update()` re-binds the stored trigger
definition unchanged — so the displayed sentence cannot be relied on to catch up
either way. If it
should follow, the mechanism is the digest's: re-derive the `schedules` rows of
every personal automation whose pinned version has a null-zoned calendar
trigger, in every workspace the person belongs to, and let the same comparison
repair what a failed pass missed. An automation whose trigger names a zone must
not move either way.

---

## `completeOpportunityStart` throws across an RPC boundary its caller does not catch

**Severity:** wrong-answer

**Observed.** `workspace-product-storage.ts:1206-1212` throws
`work_opportunity_start_fenced` when a completion arrives with a version or an
idempotency key the claim does not hold. `WorkspaceDO.completeOpportunityStart`
re-throws it across RPC, and `work-opportunity-service.ts`'s `startDurable`
awaits it in both the replay branch and the success branch with no `catch`.

**Why it is suspicious.** This is the shape the tool-receipt port was
deliberately built *away* from, one slice earlier in this same branch: "a lost
lease is a result, not an exception", because an exception crossing the RPC
boundary arrives as an opaque string and the caller cannot tell a lost race
from a broken object. Here the losing attempt is an ordinary outcome — two
clicks, or a retry after a timeout — and it reaches the route as a raw error
rather than a 409. The claim leg beside it already returns
`{ outcome: "busy" | "stale" | "replay" }`; only the completion leg throws.

**What would settle it.** Whether the losing attempt can reach this line at all
in production: `claimOpportunityStart` returns `busy` for a live claim, so a
completion carrying the wrong key means the caller held a claim that was
released and re-taken between its own two calls. If that window is real, the
fix is an outcome rather than a throw, matching the claim leg. If it is not,
the throw is an assertion and should say so.

---

## Three ordinary-run readers lost their only assertion when it stopped being one

**Severity:** coverage-gap

**Observed.** `test/ordinary-harness-run-selection.test.ts` asserted the SQL
*text* of four queries that exclude inline children. It is
deleted; the rule is now asserted behaviourally, against a real object, in
`test-workers/ordinary-harness-run-selection.test.ts` — but only for the reader
that suite can reach, which is the work stream's own detail projection.

**Why it is suspicious.** The other three readers issue the same predicate and
have no assertion at all now: `automation-service.ts`'s idempotency reader,
`activity-consumer.ts`'s automation recovery, and
`workspace-schedule-execution.ts`'s run reuse. The text assertions were not
coverage — a passing string proves only that a string is present, and when the
query moved into the object the assertion was retargeted at its new spelling
without anyone re-checking the rule — but deleting them still leaves three
call sites where dropping `parent_tool_call_id IS NULL` goes unnoticed. The
scheduler one is the worst of the three: reusing an inline child as an
automation's run attaches a scheduled automation to a tool's private run.

**What would settle it.** One Node spec per reader, over a work-stream object
store seeded with all three run shapes and the ordinary one *oldest*:
`AutomationService.runNow` twice under one idempotency key returns the ordinary
run's harness id; `runAutomationSchedule` against a work stream whose only live
row is an inline child creates a new run rather than reusing it; and the
activity consumer's recovery resolves the ordinary run. The fixtures are the
expensive part — `automation-lifecycle.test.ts` already has most of what the
first two need.

---

## A work stream's targeting facts can be cached from before it was written

**Severity:** wrong-answer

**Observed.** `flag-targeting-attributes.ts:272-300` reads a work stream's
origin, scope, creator and system flag through `workstreamExecutionEnvironment`,
and `cached(...)` stores whatever that read *resolves* for a TTL. Post-cutover
the read resolves the moment the object exists: `bootstrapWorkstreamRuntimeEnvironment`
writes the identity root, and the compatibility view derives a `workstreams` row
from that root alone — `origin_type` `'ad_hoc'`, `scope` `'workspace'`, no
creator — before any product row lands.

**Why it is suspicious.** The automation paths resolve a model for a work stream
id one statement before they write its row. Before the cutover that read missed,
and a miss is deliberately not remembered — `test/flag-targeting-attributes.test.ts`
asserted exactly that, and the assertion is deleted with the window it covered.
Now the same read *succeeds*, with the root's defaults, and the cache keeps them.
An automation's work stream could evaluate every targeting rule as an ad-hoc one
created by nobody for as long as the entry holds.

**What would settle it.** Two things, in order. First, whether the derived row
really is visible between `bootstrapRuntime` and the product insert — a
`test-workers/` case that bootstraps an object and selects from `workstreams`
before writing one answers it. If it is, whether any resolver actually reads in
that window: `scheduledWorkstreamModel` is called inside
`AutomationService.createRun`'s batch construction, which is the suspect. If both
hold, the fix is to not cache a row whose object has no product state, rather
than to widen the window.

---

## WorkspaceDO activity coverage still needs a full visibility matrix

**Severity:** coverage-gap

**2026-10-15 update:** The log's read RPC, `listActivityEvents`, was deleted
with its last caller when the digest became a list of unread Activity, and the
#628 cursor test went with it. Nothing reads the log through a per-user cursor
now, so the cursor half of this entry has no subject; whether anything still
needs the audience filtering below is unsettled.

**2026-09-09 update:** #628 adds RPC coverage for cursor boundaries, physical
read cost, digestibility, a time floor, and exclusion of another user's event.
`durable-object-runtime.test.ts` also covers target marking and dedupe. The
historical gap below is therefore partially closed; workstream audience and
system-workstream suppression still need a complete visibility matrix.


**Observed.** Two suites appeared to cover this and did not.
`test/activity-event-projection.test.ts` (deleted in plan step C-2) and the "activity event visibility"
suite in `test/digest-schedule.test.ts` both wrote and read through
`recordActivityEventOrThrow` / `listActivityEventsForUser` — but through their
**D1 arms**, a parallel implementation selected only when the authority was not
open. Production has always taken the other arm, which delegates to
WorkspaceDO. The D1 implementation is now deleted; the projection tests were
retargeted at the input `projectActivityEvent` computes, and the visibility
suite was removed.

**Why it is suspicious.** This is not a gap the deletion opened — it is one the
deletion *revealed*. Audience filtering, `is_target` marking, the cursor's
half-open window, system-work-stream suppression, membership-status filtering
and the `ON CONFLICT` dedupe are all WorkspaceDO's, and none of them has ever
been exercised. Two implementations existed and the tests only ever ran the one
nothing uses.

**What would settle it.** A `test-workers/` suite against a real WorkspaceDO,
porting the assertions the deleted suite made: two records with one `dedupeKey`
yield one row; a `{kind: "user"}` audience is withheld from everyone else; a
work-stream event is withheld from non-participants; a named target comes back
with `is_target`; a system work stream's events are withheld from everyone
including its participants; a membership that stops being active stops the log;
and a cursor excludes what it has already covered, including within one
millisecond.

---

## `changes` means something different either side of a compatibility view

**Severity:** wrong-answer (latent)

**Observed.** `durable-objects/workstream-runtime-sql.ts:178-180` reports
`counted` (a trigger's own counter) for a statement targeting a compatibility
view, and `Math.max(cursor.rowsWritten, counted)` for one targeting a real
table. `rowsWritten` counts index writes: a one-row update of an indexed column
reports 2, which `test-workers/terminal-authority.test.ts` now pins.

**Why it is suspicious.** Every remaining slice of the compatibility-layer
retirement moves statements from views onto real tables. A caller that checks
`changes === 1` — rather than `> 0` — silently changes meaning when its
statement moves, and nothing flags it.

**What would settle it.** A sweep of `d1Changes(...) === ` comparisons against
routed statements. `> 0` is safe; `=== n` is not. Worth doing once, before the
next slice, rather than per slice.

---

## Who gets ranked, and the empty-ranking standoff, moved to the alarm untested

**Severity:** coverage-gap

**Observed.** `processDueSuggestedWork` was a cron pass that claimed due
suggested-work sets, preferred recently-seen members, treated a long-waiting
request as urgent so the less-active tier could not starve, and settled each
member's ranking. It returned immediately once the authority was open, so it did
nothing in any supported deployment. WorkspaceDO's product alarm does this now
(`workspace-do.ts:1420-1441`) with the same dormant cutoff, active cutoff and
starvation preference. The cron pass, its constants and its tests are deleted.

**Why it is suspicious.** Two things the deleted suite proved are now unasserted
anywhere:

1. **Who gets ranked.** A member seen minutes ago is ranked; a member last seen
   weeks ago keeps their request but is skipped until they return. The object
   reimplements that ordering, and nothing checks it.
2. **The empty-ranking standoff.** A set stored empty against a *real* candidate
   fingerprint is a trap with no exit: the read path calls it unranked and asks
   for a ranking, the scheduler cache-hits on the fingerprint and clears the
   request without ranking, and the two do that to each other forever — a
   candidate load and a ranking slot per pass. The read-path half is asserted
   against a real WorkspaceDO in `test-workers/durable-object-runtime.test.ts`
   ("treats an empty ranking with no candidates as a steady state"), and the
   settle half — that a request arriving mid-pass survives the pass that did not
   answer it — in `test-workers/opportunity-ranking.test.ts`. What is still
   unasserted is the alarm that puts the two together: which member it claims,
   and in what order.

**What would settle it.** A `test-workers/` suite over WorkspaceDO's product
alarm: one active and one dormant member both due, assert only the active one's
ranking workflow is launched and the dormant one's `due_at` survives; a member
whose `due_at` is older than the starvation window is treated as urgent; and a
set stored empty against a live fingerprint does not clear its own request.

## A Breakout's settlement may refresh its own description, not Main's

**Observed.** `settleAgentRun` in `apps/api/src/durable-objects/substream-agent.ts`
(around lines 5545–5565) calls `refreshWorkstreamDescription` with
`workstreamId: input.parentId` and no `substreamId`, under a comment saying the
description "stays addressed at the main conversation". `localWorkstreamAuthority`
in `apps/api/src/runtime/local-authorities.ts` (around lines 140–160) resolves a
port with no `substreamId` to the executing object: "a loop-side port means
where it runs". So when the settling run is a Breakout's, the description loop's
identity, scheduling and message ports resolve to the Breakout, and the window
it reads and the row it rewrites appear to be the Breakout's own.

**Why it is suspicious.** The comment and the resolution rule disagree, and
[`workstream-descriptions.md`](workstream-descriptions.md) says both that "the
loop below only reads Main" and that "a Breakout's run settlement writes one
from its first message while it is still empty". Either Main's description is
never re-evaluated from Breakout activity (a gap the loop's `rest_until` would
hide), or the Breakout's is, and the comment is stale. Found while mapping the
settlement lane for the memory research
([`PRDs/2026-10-18_agent-memory/research.md`](PRDs/2026-10-18_agent-memory/research.md));
not verified beyond reading the code.

**What would settle it.** A `test-workers/` case that settles a terminal run in
a Breakout whose Main has a stale derived description and enough new human
messages to clear the gates, then asserts which conversation's
`description_refresh_state` row advanced and which `description` changed.

**Severity.** `waste` if the Breakout is evaluated on purpose and only the
comment is wrong; `wrong-answer` if Main's description was meant to follow its
Breakouts and never does.
