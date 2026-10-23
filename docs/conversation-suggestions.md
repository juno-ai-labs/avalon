# Conversation suggestions

After a run settles in a Thread's Main or in a Breakout, or a Breakout result
lands in its Thread, a cheap classifier judges the result against the conversation's purpose and, rarely,
offers one quiet suggestion under that turn: merge this result up to the
parent, start a Breakout on the side question, or mark the purpose resolved. The suggestion is
conversation state keyed to the judged turn, never a transcript row; a person
acts on it or dismisses it, and the feed's recency retires it. Rally never
merges or starts a Breakout on its own. The product requirements are
[`PRDs/2026-10-17_merge-and-breakout-suggestions/prd.md`](PRDs/2026-10-17_merge-and-breakout-suggestions/prd.md);
the design and the evidence behind the classifier's question, its threshold and
its context are in that folder's `design.md`. Related:
[`conversation-merge.md`](conversation-merge.md) (the response card every merge
now uses, and the marker that resolves a suggestion),
[`substream-creation.md`](substream-creation.md) (the launch pane a Breakout
suggestion opens), [`agent-harness.md`](agent-harness.md) (the JEV primitives
and the settlement lane), [`jev-best-practices.md`](jev-best-practices.md).

JEV also offers **Mark resolved** for completed work; `turn-disposition.ts` owns
its completion criteria and priority rules. A person clicks to set the existing
shared `parent_children.resolved` bit, independently of archive state. The row
starts ready because resolution needs no drafted words.

## Where the code lives

| Path | Holds |
| --- | --- |
| `packages/agent-harness/src/turn-disposition.ts` | The classifier: the state schema and its bounds, the Choice question as data, `judgeTurnDisposition` (never throws), `TURN_DISPOSITION_CONFIDENCE_THRESHOLD` (0.6, `>`), `suggestionForTurnDisposition`. |
| `packages/agent-harness/src/prompts/turn-disposition.ts` | The prose mirror of the question for a generative target in the eval; not sent to JEV. |
| `packages/agent-harness/src/prompts/suggestion-draft.ts` | The two drafter prompts (merge note; Breakout prompt and subject) and their JSON schemas, golden-hashed. |
| `packages/agent-harness/evals/turn-disposition/` | The corpus eval and the GEPA optimizer; see its README. |
| `packages/contracts/src/conversation-suggestions.ts` | `ConversationSuggestionSchema`, the kinds and statuses, `SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS` (3), `suggestionTurnIsVisible`, the dismiss result. |
| `packages/contracts/src/index.ts` | The snapshot's optional `suggestions` and the `conversation_suggestion_changed` socket event; the `suggestion_draft` model role and its flag key. |
| `packages/contracts/src/usage.ts` | The metered activities `turn_disposition_classifier` and `suggestion_draft`. |
| `apps/api/src/durable-objects/conversation-suggestions.ts` | `ConversationSuggestionStorage` over the two tables (`newestSettledTurn`, the backfill's pick), `observeTurnDisposition` (the gates, the state, the decision, the row), `buildTurnDispositionState`, `resourceEmbeds`. |
| `apps/api/src/durable-objects/substream-agent.ts` | `judgeSettledTurn`, one settled turn through the observer and the drafter, called by `observeTurnDispositionStep`, the last step of `settleAgentRun`, and by the `backfillTurnDisposition` RPC; `draftSuggestionWords`; `readSuggestionParent`; `expireSuggestionsBestEffort`; the `dismiss_suggestion` product operation; the resolutions in `messageOperationOutcome` and `resolveBreakoutSuggestion` (called by the creation service once the Breakout is ready); the snapshot's `suggestions`. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Migration v75: `conversation_suggestions`, `turn_disposition_judgements`. |
| `apps/api/src/durable-objects/workspace-space-storage.ts`, `workspace-do.ts` | `threadMergePlacement`, the viewer-less read of the Organization-wide Channel a Thread's merge would land in; a private Channel is never named, since the answer reaches every reader of the Thread. |
| `apps/api/src/services/suggestion-draft-service.ts` | `draftSuggestion`: the `suggestion_draft` structured-inference role. |
| `apps/api/src/services/suggestion-backfill-service.ts`, `apps/api/src/durable-objects/thread-backfill.ts` | `backfillSuggestion`, the `suggestion_backfill` thread-backfill job, and WorkspaceDO migration 115 that lists every open thread for it. |
| `apps/api/src/services/classifier-diagnostics.ts` | The sink the observer records every provider call through, under the `turn_disposition_classifier` role. |
| `apps/api/src/routes/conversations.ts`, `apps/api/src/services/workstream-object-client.ts` | `POST /conversations/:parentId/substreams/:substreamId/suggestions/:suggestionId/dismiss`. |
| `packages/ui/src/components/conversation-suggestion.tsx` | `SuggestionChip`, `suggestionExcerpt`, `SUGGESTION_EXCERPT_CHARACTERS`. |
| `packages/ui/src/components/merge-response-card.tsx` | `MergeResponseCard`, the editable merge block. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | `suggestions` on the connection, from the snapshot and the event. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | Which suggestions are visible and to whom, the chip under the turn, the response card, dismiss, the Breakout accept path. |
| `apps/desktop/src/renderer/components/message-feed.tsx` | `afterTurn`: host content under the last row of a turn. |
| `apps/desktop/src/renderer/components/substream-launch.tsx` | `initialDraft`: the launch composer seeded once from a drafted prompt. |

## How it works

### The observer, in the settlement lane

`settleAgentRun` already runs after every terminal run: observation, result
delivery, naming, the description loop, a Breakout's first description. The
observer is the last step, so it reads the freshest purpose and delays nothing
in front of it, and it is one call that never throws: a failure is logged as
`turn_disposition_step_failed` and settlement completes as before.

It first writes down the newest-three rule (below), then runs the gates
cheapest first, each the reason not to pay for the next:

| # | Gate | Skipped as |
| --- | --- | --- |
| 1 | A completed run's final Rally text, or an admitted `conversation_merge` result | `run_not_completed`, `final_turn_not_text` |
| 2 | A conversation people read: not a background agent, not archived, not a system conversation such as a digest | `background_agent`, `archived`, `system_conversation` |
| 3 | This run or incoming merged turn was not judged before (`turn_disposition_judgements` by `run_id`), checked again inside the write; a judgement recording a classifier failure does not count, and a row left `pending` by an interrupted settlement resumes at the draft instead, unless this object is drafting it right now | `already_judged`, `draft_in_flight`, or `resumed` |
| 4 | Only a confident resolution offer reads the shared bit, once after inference. An existing resolution suppresses that offer, while merge and Breakout remain offerable | recorded as `already_resolved` |

Resolution remains offerable without an eligible merge parent and after a
result was carried up. Merge markers now suppress only another merge offer;
they still feed the classifier's carried-up history. An incoming merged result
can offer merge or resolution, but never a new Breakout.

Past the gates it builds the state the design specifies, reading only this
object's tables and one parent context read over RPC (the Thread's identity for a
Breakout; `threadMergePlacement` on WorkspaceDO for a Thread), asks JEV once
through `judgeTurnDisposition`, reads shared resolution only for a resolution offer, and records the decision in
`turn_disposition_judgements` whatever it was. A positive above the threshold
of an offerable kind becomes an `open` row in `conversation_suggestions` with
its draft `pending` (or immediately `ready` for resolution), written in the same transaction as the judgement, unless
gate 3b (the turn already has three newer messages: `late`) or gate 6 (pacing:
`paced`) stops it. A positive the threshold rejects is recorded as
`confidence_below_threshold`; a merge positive in a Thread with no Channel to
merge into as `not_offerable`; a run without a `TYPESAFE_API_KEY` as
`classifier_unavailable`, which is what local development records.

Every provider call is recorded through `createClassifierDiagnosticSink` under
`turn_disposition_classifier`, which logs it as `structured_inference`, meters
it, and archives it; the outcome of the step is one `turn_disposition_outcome`
log line naming the gate or the code.

An incoming Breakout merge starts no run. Publishing its canonical transcript
turn persists and arms a `merge_suggestion` entry in the shared durable alarm
store before attempting realtime publication, whether it landed immediately
or waited behind pending input. The alarm runs the same observer and is retired
only after a terminal judgement and draft state, and delivery of the latest
suggestion row when one exists. If canonical publication remains pending, the
alarm retries notification after it drains; it reuses the saved judgement and
draft. Repeated notifications replace the same suggestion id on the client.
Isolate loss leaves the intent
to replay; a pending draft resumes through the observer's existing gate.
Transient classifier failures and step failures reuse the backfill's retry
policy and the shared scheduler's backoff. Missing provider credentials settle
without a suggestion, as they do in the backfill. A merge with no eligible
Channel can still be judged for resolution. The classifier
receives the stored author's kind, so a person's merged result is `person`.
Separately, `judged_message.merged_from` identifies its Breakout origin by kind
and title, using the existing title bound. The JEV question and evaluation
prompt both explain that origin alone does not mean the parent needs the result.
The candidate picker includes these merged results among the same newest three
readable messages, and live alarms and backfill share `MERGE_JUDGEMENT_KEY_PREFIX` to use
`merge:<turnId>` as the stable key in the existing `run_id` slot. Replays resume
a pending draft or reuse the judgement. Merge and resolution are offerable for this
candidate: the incoming result can move onward to a Channel, while an ordinary
human message remains outside the classifier's candidates.

Each re-upsert can schedule the turn again; gate 3 reuses terminal judgements
and permits another classification after a recorded classifier failure.

### The two-phase write

The chip is up before the words are asked for. Merge and Breakout rows are inserted `pending`
and published as `conversation_suggestion_changed`; the client draws the chip
at once with a skeleton where the excerpt goes. Then `draftSuggestion` runs the
`suggestion_draft` role: a merge note for the parent's readers, or a Breakout's
opening prompt and subject, from the judged turn, the newest three messages,
the title, the purpose and the parent's name. The row is updated `ready` with
the text and published again, and the chip fills in place. A draft that is
empty, over `MESSAGE_MAX_CHARACTERS`, refused or unreachable marks the draft
`failed` and the row `withdrawn`, and the event removes the chip: a suggestion
without its words is not shown. A withdrawn row is not a dismissal and buys no
cooldown.

### Lifecycle

| Status | Written by | Resolution |
| --- | --- | --- |
| `open` | The observer, for a confident positive | |
| `accepted` | Manual resolution accepts all open `mark_resolved` rows after WorkspaceDO confirms the shared bit; a `conversation_merged_into` marker appended to this conversation resolves every open `merge_up` row on a turn at or before it, in the marker's own commit; `resolveBreakoutSuggestion`, called by `SubstreamCreationService` once the Breakout cut at that turn is ready, resolves the open `start_breakout` row on it | `accepted` |
| `dismissed` | The dismiss route, for everyone, with who did it | `dismissed` |
| `expired` | The newest-three rule, on each admitted message, each appended system row and each judgement | `ignored` |
| `withdrawn` | A failed draft | none |

The client learns each change through the event and the snapshot's open rows,
and keeps the newest state per suggestion id.

### The newest-three rule

A suggestion is visible only while its turn is one of the newest
`SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS` (3) messages, counting what people
and Rally said and not tool cards or system rows. Two places apply it and
agree: the client hides the line the moment the third newer message arrives,
by `suggestionTurnIsVisible` over the readable rows of the feed it holds; the
object closes the row as `expired`/`ignored` when it next sees the transcript
move, which is the record. The number is the product owner's, from the PRD,
held once in `packages/contracts`.

### The backfill

Suggestions shipped for turns settled from 2026-10-18 on. Existing
conversations get theirs through the [thread backfill](thread-backfill.md)
lane: migration 115 lists every open thread under `suggestion_backfill`, and
the handler, `backfillSuggestion`, asks each conversation's object (Main and
each open Breakout) for `backfillTurnDisposition`. The object picks
`newestSettledTurn`, the newest completed final Rally turn or incoming merged
result among the newest three readable messages, and runs it through
`judgeSettledTurn` exactly as its settlement would have: gates, judgement,
row, event and drafter. A conversation whose newest three messages hold no
such turn answers `nothing_to_judge`, since a chip under an older turn would
never be seen. The observer's run gate makes a second run free, and a
transient classifier failure, or a step that threw before judging, is thrown
back to the lane so the row retries rather than settling with nothing judged;
a classifier failure no retry would fix settles with the kind recorded. After the release, force `WorkspaceDO`
from the migration tracker so every Organization fills its list
([thread-backfill.md](thread-backfill.md#reaching-every-organization)).

### What the client shows

The chip is drawn by the conversation surface in the feed's `afterTurn` slot
under the last row of the judged turn, for a viewer who can take the action:
`mark_resolved` for a reader of an open Thread or Breakout, `merge_up` when `mergeTargetFor` gives this viewer a target, `start_breakout`
when the viewer can start a Breakout here (a Thread's Main). The title and
sentence are fixed strings with one slot: "Merge to **{target}**" and "This
might be a good time to merge this back into **{target}**."; "Breakout:
**{subject}**" and "Want to break this out?". The excerpt is the drafted words
cut by `suggestionExcerpt` to `SUGGESTION_EXCERPT_CHARACTERS` with the ellipsis
inside the closing quote. Merge excerpts wrap across the card's full content
width; other excerpts stay on one line and clip in a narrower pane. The chip lays the title, the
sentence and the excerpt in a column. Breakout and resolution suggestions keep
the action pill and Dismiss beside them. The merge pill uses the merge target
pill's green, the breakout pill neutral like the breakout chips, so the two
never read as the same action. While the draft is pending the excerpt is a
skeleton and the action is disabled; Dismiss works from the first frame.
Merge suggestions put **Merge** and **Resolve without merge** below the text.
Desktop widths add **Discard**; mobile keeps the top-right X. The sentence and
excerpt use the full card width, and merge excerpts wrap in narrow panes.
Resolution uses the host's existing lifecycle, pending state, failure notice
and navigation. It needs no drafted words, so it stays available while the
merge draft is pending; archived conversations omit it. Once the conversation
is resolved, its merge suggestion is hidden so it cannot offer a contradictory
Merge action. Resolution does not dismiss the underlying suggestion: the shared
conversation state decides visibility, while Discard records an explicit dismissal.

**Accept merge** opens the response card in the chip's place, prefilled with
the drafted note and the suggestion's target; merging goes through the merge
route exactly as before, and the marker it writes resolves the row. **Accept
breakout** calls `onStartSubstream(judgedTurnId, draftedPrompt)`: the launch
pane opens at that turn with the prompt written once into its draft, over an
empty draft only. **Dismiss** hides the line at once and calls the route.

## Invariants

- One suggestion per judged turn (`conversation_suggestions_one_per_turn`),
  one judgement per run or incoming merged turn (`turn_disposition_judgements.run_id`), and the row
  and its judgement are one transaction.
- A suggestion is never a transcript row, never enters the model's history,
  never lights unread, Activity, push or a digest. The slot is conversation
  state served over the conversation socket under the transcript's own
  authorization.
- Nothing posts or starts on a suggestion's behalf. Accepting opens an editor;
  the merge route and `prepare`/`confirm` apply every check they apply today.
- The observer never fails settlement, and the run's final turn,
  `stream_completed` and terminal state land before it runs.
- The threshold is compared with `>`, so a confidence equal to it stays quiet.
- The client and the object apply the same newest-three count to the same
  definition of a readable message: text and Sidekick results by people, Rally
  and external authors; not tool cards, not system rows.

## Boundary

The classifier knows the state shape, the question and the mapping to a
decision, and nothing about where a decision is stored or shown. The storage
and observer module knows the tables and the gates, and reaches the parent
only through the two callbacks the agent passes (`readParent`, `commit`). The
agent owns publishing and the drafter call. The drafter knows the words and
nothing about whether they are shown. The client reads the snapshot and the
event and decides visibility and who may act; it never infers a resolution.

## Failure modes and limits

| Situation | What happens |
| --- | --- |
| JEV answers `continue_here`, or below the threshold | Nothing shown; the judgement is recorded with the code |
| TypeSafe unreachable, no key, schema failure | `classifier_unavailable` with the provider's failure kind; settlement unchanged; a later attempt asks again |
| The drafter fails or over-runs | Draft `failed`, row `withdrawn`, chip removed; the decision stands |
| Settlement retries after a crash | Gate 3: no second call, no second row; a `pending` row resumes at the draft |
| The backfill and a settlement judge the same run at once | Gate 3 again inside the write: the second to finish records nothing and skips as `already_judged`; a row the object is already drafting is not resumed (`draft_in_flight`), so one drafter writes it |
| Settlement lands behind three newer messages | Recorded as `late`; nothing shown |
| The parent cannot be read (RPC failure) | At settlement, a Breakout skips as `nothing_offerable` and a Thread judges with only `start_breakout` offerable; the next run judges again. In the backfill the read failure is thrown, so the row retries rather than settling a conversation that was never offered `merge_up` |
| A merge lands with no suggestion standing | The marker is written as today; the corpus records a miss |
| Two people act at once | The first resolution wins; the dismiss route answers the second as replayed |
| An older desktop build | Its socket parser strips the snapshot's `suggestions` and ignores the event; it shows nothing |

Two pacing limits are defined open per
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md),
enforced through `observeTurnDisposition`'s parameters and tested at a finite
value and at the open one: `SUGGESTION_DISMISS_COOLDOWN_MS` (`0`: a dismissal
of a kind buys no quiet period) and `SUGGESTION_MAXIMUM_PER_CONVERSATION_DAY`
(`Infinity`). Both skip the row and record `paced`. The numbers are the team's,
to be read from the slot's own record of dismissals and expiries.

What this version deliberately leaves out, and why:

- **A person's message is not judged at admission.** The corpus evaluation
  widened the classifier's contract to a person's message, because a side
  question is usually opened by a person. The settlement observer judges
  Rally's turn only; a person's message would need a second hook on admission
  and a JEV call per human message, and the one kind it mostly produces, the
  Breakout suggestion, is the weak class in the evaluation. Add the hook when
  that class has earned a surface.
- **No `conversationSuggestionsEnabled` flag.** The PRD recommends one and
  records that an engineer has to ask for it; nobody has. The surface ships to
  every Organization with the judgement.
- **No client-contract gate.** The design planned one; the conversation socket
  carries no contract claim, and the client's `safeParseSocketEvent` strips the
  unknown snapshot key and ignores the unknown event type, which a contracts
  test pins.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test-workers/channel-viewer-state.test.ts` | Manual resolution, in-flight dismissal and expiry, recovery after parent commit and eviction, legacy/current socket snapshots and updates, live sidebar updates, and named admission refusals. No agent run or inference is admitted. |
| `apps/api/test-workers/merge-suggestion-candidate.test.ts` (real workerd) | Canonical admission and queued delivery reach the observer without starting an agent run; classification and drafting finish during publication failure, and recovery broadcasts the ready suggestion after the turn without repeating provider calls; eviction with a pending draft resumes the draft and retires its durable intent. Removing the publication hook, moving it after publication, or dropping the required notification makes the corresponding assertion fail. |
| `apps/api/test/conversation-suggestions.test.ts` (Node, real object schema, TypeSafe fetch double) | Ready resolution suggestions without drafting, acceptance in place, resolution without a merge parent, and resolution during classification; merge and Breakout offers after shared resolution; every gate in order; one row and one judgement per confident positive; the recorded codes; a replayed settlement asking nothing and a pending row resumed; `late`; pacing at a finite and at the open value; the expiry at the third newer readable message and not the second; the resolutions; a draft filled and a draft withdrawn; a recorded classifier failure asked again; a run judged by another caller during the call written nothing; a draft in flight not resumed; `newestSettledTurn` picking the newest completed final turn within three and nothing behind them or for a run still running. Proved by breaking: the expiry count, the idempotency gate, the failure re-ask and the completed-run join each made their test fail. |
| `apps/api/test/suggestion-backfill-service.test.ts`, `apps/api/test/workspace-suggestion-backfill-migration.test.ts` | The backfill's answer to the lane (thrown on a classifier failure, settled on a missing key); migration 115 listing open threads and not archived ones. |
| `apps/api/test/conversation-suggestions-route.test.ts` (Node, typed double) | The dismiss route's addressing (the Breakout's object, Main for `0`), read admission, and refusals. |
| `apps/api/test/workstream-object-schema.test.ts` | Migration v75 and the table list; v79 preserves existing suggestion rows and their uniqueness constraint. |
| `packages/contracts/src/conversation-suggestions.test.ts` | The visibility rule; the event and snapshot shapes; an older parser stripping the key. |
| `packages/agent-harness/src/prompts.test.ts` | The two drafter prompts' golden hashes. |
| `packages/agent-harness/src/turn-disposition.test.ts` | A `mark_resolved` provider answer survives parsing with confidence and model intact, maps to a resolve suggestion in both conversation kinds, and stays quiet at the confidence threshold. |
| `packages/agent-harness/src/turn-disposition-provenance.test.ts` | An overlong Breakout title is bounded by code point without splitting an emoji. The API observer test checks that stored merge metadata reaches the classifier request. |
| `apps/desktop/src/renderer/screens/workstream-suggestions.test.tsx` | The chip under the judged turn with the drafted excerpt; visible with two newer messages, hidden at the third; the pending skeleton with the action disabled; accept opening the response card in the chip's place and the composer staying ordinary; the card merging through the route; the hover action opening the same card under its turn; dismiss hiding at once and calling the route; no merge chip for a viewer with no target; the Breakout chip opening the launch pane seeded with the prompt. |
| `apps/desktop/src/renderer/components/conversation-suggestion.test.tsx` | The excerpt cut, the chip's controls and pending state, the card's keys and controls. |

The 2026-10-19 provenance change was evaluated against the generative mirror
(`openai/gpt-5.6-terra`): all 12 synthetic cases matched their labels, including
four new relevant/irrelevant merged-result cases across person/Rally authors.
This checks fixtures, not production accuracy. The original October 18 corpus
was deleted, and the available environment has no TypeSafe credential, so a JEV
regression run remains required before shipping. `build-cases.ts` currently
does not populate merge provenance; the new cases supply it explicitly.

## Data model

Migrations v75, v79 and v80, in the conversation object:

- `conversation_suggestions`: `suggestion_id`, `kind`, `judged_turn_id`,
  `judged_turn_sequence`, `run_id`, `status`, `draft_status`, `draft_text`,
  `draft_subject`, `target_kind`, `target_id`, `target_title`,
  `decision_choice`, `decision_confidence`, `decision_model`, `created_at`,
  `resolved_at`, `resolved_by_user_id`, `resolution`, `accepting_by_user_id`. One row per judged turn.
  The sequence is stored beside the id so expiry and the merge marker compare
  integers; the target so the snapshot needs no parent read.
- `turn_disposition_judgements`: `run_id`, `judged_turn_id`, `code`, `choice`,
  `confidence`, `carried_item_kind`, `model`, `suggestion_id`, `created_at`.
  Every decision, shown or not: gate 3's record, and what a later calibration
  re-scores without calling the provider again.

### Resolution delivery and acceptance

Client contract 10 opts into the new kind when requesting a socket ticket. The
server signs that capability into the ticket and persists it in the hibernating
socket attachment. Snapshot delivery filters resolution rows for older clients,
including prepared snapshots. Broadcasts and replay replace their resolution
events with a known withdrawn merge tombstone at the same sequence, so old
clients keep their authoritative snapshot and contiguous cursor. Missing claims
and pre-existing attachments default to legacy delivery.

Before the parent RPC, `beginResolution` saves `accepting_by_user_id` on the open
row. Dismissal and recency expiry cannot overwrite a click in progress. Parent
success accepts the row; an explicit refusal clears the intent, while an
uncertain transport failure keeps it for a retry. The intent survives eviction
and retains the first clicker's identity. Merge markers also retire open
resolution chips. Archived conversations show a disabled action with Dismiss
still available.

The shared resolved bit is also written by merges and is not cleared by later
messages. It therefore suppresses only redundant resolution offers, never all
classification. Settlement treats a failed resolution read as unresolved and
logs the reason; backfill propagates the read failure for retry.

## Security and trust model

A suggestion carries no authority. Who can read one is who can read the
conversation; the dismiss route is admitted as a read of the conversation and
the object refuses a suggestion it does not hold. The classifier's state names
its fields: the parent, the charter, the earlier outputs, the recent messages
and the judged message are separate objects in the JEV `state`, never
interpolated into the question. The drafter puts the transcript in a bounded
user-role JSON message and its output is for a person to edit. Content leaves
the Organization only to TypeSafe for the judgement and to the drafting route
for the words, on the access-controlled inference path.

## Changelog

### 2026-10-23 — Complete a conversation from its merge suggestion

The merge card now offers resolution without publishing a result to the parent,
using the same lifecycle and availability rules as the title menu. A finished
conversation previously required leaving the card to resolve it; dismissal only
hid the suggestion. Resolution stays independent of draft generation and hides
merge suggestions when confirmed, keeping all merge entry points consistent.
The desktop footer has Discard while mobile retains the X, following the
requested layouts; both record the existing suggestion dismissal.

### 2026-10-20 — Suggest marking completed conversations resolved

The new choice and explicit action distinguish completion from continued work.
The action reuses the parent registry's resolution bit; it does not archive or
post. Resolution remains offerable without a merge destination. Prior merge
markers fence only another merge, because later work can still need a Breakout.
Since merges also set the shared bit, it suppresses redundant resolution offers
without suppressing subsequent merge or Breakout classification.

The suggestion starts ready, and v79 widens its kind constraint while preserving
existing rows and indexes. V80 records an acceptance intent before crossing the
parent RPC so dismissal, expiry and a lost confirmation cannot contradict a
committed click. Contract 10 negotiates the new enum kind: older suggestion-aware
clients reject unknown enum values inside snapshots, so delivery must filter
those rows and preserve event sequences with compatible tombstones. The existing
confidence threshold is unchanged.

### 2026-10-19 — Preserve merge provenance and schedule before publication

The classifier now receives the merged result's Breakout kind and title separately
from its author. Previously the incoming result looked like an ordinary message,
so the classifier lacked the source context needed to judge its next hop. The
question keeps the same criteria: origin does not itself justify carrying it up.
The existing durable alarm is now armed before realtime publication is attempted,
because a publication failure otherwise deferred classification of committed
content. Live observation and backfill share the judgement-key prefix. The
alarm also retains the latest suggestion notification until canonical delivery
recovers: retiring after drafting alone lost the notification for connected
clients because runtime events defer behind canonical publication.

### 2026-10-19 — Incoming Breakout results can be suggested for onward merge

The candidate picker and observer now admit an incoming merged result as well
as a completed Rally output. Canonical transcript publication persists a
`merge_suggestion` alarm before acknowledging realtime delivery, using
`merge:<turnId>` for replay identity. The alarm retains the intent through
classification and drafting, including isolate loss while a draft is pending.
Previously a
merge started no run and therefore never reached the settlement-only observer,
so it could not be suggested for its next hop into a Channel. Starting an agent
run for this would change the meaning of merge; duplicating the classifier
would split its recency, resolution and draft rules. Ordinary human messages
remain excluded, incoming merges offer only merge suggestions, and a missing
eligible Channel skips the classifier entirely. Judged authors retain the same
person/Rally attribution as the recent context.

### 2026-10-19 — Existing conversations judged once, through the thread backfill

**What changed:** `suggestion_backfill`, a thread-backfill job, judges the
newest settled Rally turn of every open conversation through the same
`judgeSettledTurn` a settlement runs. Gate 3 no longer treats a judgement that
recorded a classifier failure as final.

**Why:** The product owner asked for the conversations that existed before the
chip shipped to get theirs. Only a turn among the newest three can show a
chip, so one judgement per conversation, of that turn, is the whole visible
result. The gate change is what lets the backfill retry a conversation the
classifier failed on; before it, a fleet-wide run during an outage would have
recorded `classifier_unavailable` everywhere with no way back.

**Considered and rejected:** Judging every settled turn in a conversation's
history, which would record `late` for all but the newest and show nothing
for the cost; and leaving gate 3 as it was and having the backfill delete the
failed judgement, which would have two places deciding what a judgement means.

**Consequences:** A replayed settlement after a classifier failure asks again
and overwrites the judgement. Anything that reads `turn_disposition_judgements`
must treat a row with a `failure_kind` as a failure record, not a decision.
Two callers can now judge one run at once, so gate 3 is checked again inside
the write and the second to finish records nothing, and a `pending` row is
resumed only when the object is not already drafting it.

### 2026-10-18 — Suggestions ship: a judged turn, one quiet line, a response card for every merge

**What changed:** the settlement lane judges every settled Rally turn in a
Thread's Main or a Breakout with the turn-disposition classifier and, for a
confident positive, writes one suggestion row per turn into the conversation
object, published over the socket and drawn as a dashed chip under the turn
for the people who can act. Accepting a merge opens the response card, which
now makes every merge; accepting a Breakout opens the launch pane seeded with
a drafted prompt; the feed's recency retires the line after three newer
messages. Migration v75, the `suggestion_draft` role and two metered
activities came with it. No product flag: the product owner's call is that
the line ships to everybody on merge, with the judgement record as the way
its noise is read. A Breakout
suggestion resolves when the Breakout is ready, not when its context is
captured, so a failed or abandoned preparation leaves the chip standing; the
observer re-reads the merge markers inside its write, since the classifier
call yields; and a judgement that could not be made records why
(`failure_kind`).

**Why:** merge-back made a result's way up depend on a person remembering to
press Merge after Rally wrote it, and Rally's own description loop already
knows what a conversation is for, so the moment a result lands is knowable
without a person noticing it. The predecessor, Suggested context cards, was
retired for noise, and each of its defects has a structural answer here: the
confidence is the provider's over a closed choice set, with the threshold
read off a corpus sweep rather than argued about; the suggestion is
conversation state, one per turn, resolved in place rather than accumulating
in the feed; and every accept, dismiss and ignore is recorded against the
decision that produced it, so the threshold is tuned against outcomes.

**Considered and rejected:** a system row in the transcript (rows accumulate,
take an attention ordinal and light unread, and an older client would draw
fallback text); the composer's notice slot (the product owner ruled the
composer is for what the person is writing); a Queue hop for the judgement
(the settlement lane already makes slower model calls); judging a person's
message at admission in this version (a second hook and a call per human
message for the class the evaluation found weakest); a client-contract gate
for the socket (the socket carries no claim, and the parser already strips
the unknown key).

**What a future change has to respect:** the row and the judgement are one
transaction; the marker's resolution runs in the marker's own commit; a
Breakout's resolution waits for the child to be ready; the
client and the object count the same readable messages; the threshold stays
pinned to the measured request in `design.md`, and a change to the question or
the context re-runs the eval before it ships.
