# Conversation suggestions (retired)

**Conversation suggestions are deleted.** After a Thread's or a Breakout's
run settled, a turn-disposition observer asked a classifier whether the turn
called for carrying its result up to a parent (`merge_up`), breaking a side
question out into a Breakout (`start_breakout`) or marking the conversation
resolved (`mark_resolved`), stored one suggestion row per judged turn in
`AgentLoopDO`, and had the `suggestion_draft` role write the words. Merges,
Breakouts and resolution all belonged to Threads, which the
[Canvases and Sidekicks PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)
removes; a Canvas's Chat and a Sidekick's conversation have nowhere to carry a
result up to and nothing to break out of.

Plan step C-3 deleted the observer and drafter (`conversation-suggestions.ts`,
`suggestion-draft-service.ts`, `suggestion-backfill-service.ts`), the harness
`turn-disposition.ts` and `prompts/suggestion-draft.ts`, the `dismiss_suggestion`
and `resolve_suggestion` product operations, the merge-result alarm and the
socket filtering by client contract. `AgentLoopDO` migration 84 drops
`conversation_suggestions` and `turn_disposition_judgements`. A stored
`merge_suggestion` alarm is acknowledged and dropped.

What survives until a later step: `ConversationSuggestionSchema`, the socket
event and the snapshot's optional `suggestions` field in `@rally/contracts`,
which the client contract reshape removes (the server sends none); the
`suggestion_draft` model role and its Flagship key; WorkspaceDO's
`suggestion_backfill` lane rows in `retired-workspace-schema.ts`. This document
is kept for its changelog. Do not build on anything it describes.

## Changelog

### 2026-11-07 — Conversation suggestions are deleted

**What changed:** The turn-disposition observer, the drafter, the backfill's
per-conversation call, the suggestion product operations and the merge-result
alarm are deleted; migration 84 drops their two tables; the feed socket sends
every event to every client unfiltered, because none carries a suggestion.

**Why:** Every suggestion kind acted on a Thread (carry up to its Channel,
break out a Breakout, resolve it), and Threads left the product with the
Canvases and Sidekicks pivot. The observer still ran after a Thread's runs
only; with no Thread parent left it had no caller.

**Consequences:** Nothing after a run suggests anything. Offering a next step
on a Canvas would be a new design on the Canvas's Chat, not a restoration of
this one.

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
