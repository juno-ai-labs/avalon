# Design: the post-generation overlay

> Companion to [the PRD](prd.md). This file holds what is too detailed for the
> PRD body: the four pieces and their contracts, the JEV decision in full, the
> gates, the shadow corpus and how the threshold is read from it, the failure
> table, the testing plan, the documents a build has to touch, and the limits
> handed back. A phased `plan.md` is written after the PRD is approved, per
> [`prds.md`](../../prds.md); the [build sequence](#build-sequence) below is
> the order it would take.

## What JEV is good at, and what that decides here

[`jev-best-practices.md`](../../jev-best-practices.md) is the evidence; this is
the reading of it that shapes the design.

- **One bounded question over named state.** JEV answers a Choice over a
  closed set, with a confidence the provider computed, in about 220 ms p50
  and 350 ms p95 on `jev-1.13.0`. It does not write prose. So the judgement
  "what does this turn call for" is JEV's, and the Breakout prompt is not.
- **The label carries the decision; the threshold is a nearly flat lever
  below 0.5.** Both shipped classifiers found the Choice's confidence is a
  cliff at 0.5 rather than a gradient above it. So the work goes into the
  outcomes and their boundaries, and the threshold is read off a sweep rather
  than argued about.
- **Decomposing a coupled decision loses the shared boundary.** Addressing's
  two-question split scored 25.93% four-class against 81.48% for one question.
  Merge and breakout are both judged against the same purpose, so they are
  one question with three outcomes, not two questions.
- **A classifier with no corpus is a guess, and the guess must be reversible.**
  This one has a corpus waiting in retained data, which is why phase 1 is a
  shadow run rather than a surface.
- **State fields are the trust boundary.** The purpose, the turn and the
  context are separate named objects; nothing is concatenated into the
  question.
- **Price the errors before the threshold.** The formula is below with
  proposed weights; the direction is the team's.

## The pieces

Four blocks. Each has one job, none knows the others' product meaning, and the
overlay is their composition.

| Piece | Where | Owns | Knows nothing about |
| --- | --- | --- | --- |
| Settlement observer | `apps/api/src/durable-objects/substream-agent.ts`, a step in `settleAgentRun` | Running the gates cheapest-first and calling the classifier; never throws | Which classifier or what a suggestion is for |
| Turn disposition classifier | `packages/agent-harness/src/turn-disposition.ts`, beside `semantic-trigger-gate.ts` | The state shape, the question, the criteria, the threshold's comparison, the mapping to a decision | Where a decision is stored or shown |
| Conversation suggestion slot | `SubstreamAgent` table `conversation_suggestions`, a socket event, a dismiss route | One suggestion per judged turn, its lifecycle, its resolution record, and the newest-three rule that retires it | Who produced it or why |
| Suggestion drafter | `apps/api/src/services/suggestion-draft-service.ts`, a `runStructuredInference` role | Writing the words a person edits: a merge note for the parent's readers, or an opening prompt and its subject | Whether the words are ever shown |

The client adds two blocks: the line, which reads the slot, and the
response card, which replaces the composer's merge mode for every merge and
calls the merge route merge mode called. The breakout action opens the launch
pane that exists.

### The settlement observer

`settleAgentRun` already runs, after every terminal run and in this order:
observation and telemetry, result delivery, work-stream naming, the
description loop, a Breakout's first description. Each step is awaited, never
throws, and does its own cheap admission before any model call. The overlay is
the last step, after the description loop, so it reads the freshest purpose
and delays nothing in front of it.

Its input is what the lane already has: `WorkstreamWorkflowInput`
(`parentKind`, `parentId`, `substreamId`, `backgroundAgent`) and
`AgentTerminalOutcome` (`status`, `finalTurnId`). It reads the final turn
through `product.messageForRuntime`, as result delivery does, and recent
messages through `readableMessagesBefore`, which already excludes tool rows
and the retired suggestion type. The purpose is the object's own
`workstream.description` and `title`.

The step records every decision through `createClassifierDiagnosticSink` under
a new role, `turn_disposition_classifier`, which also meters it. In shadow that
record is the whole output.

Once the surface exists the step writes in two phases, so the chip is up
before the draft is asked for: on a confident positive it inserts the row
with `draft_status = 'pending'` and publishes it, then calls the drafter and
updates the row to `ready` with the text (and subject), or to `failed`, and
publishes again. Each phase is its own `commitRuntimeMutation`. A settlement
retry that finds a `pending` row for its run resumes at the draft rather
than judging again.

### The turn disposition classifier

Written to the shape of `semantic-trigger-gate.ts`: constants, the question as
data through `jevChoiceQuestion`, the answer schema through
`jevSingleChoiceAnswers`, one exported `judgeTurnDisposition` that never
throws and returns a decision with a code.

**The decision contract**, written before the question:

| | |
| --- | --- |
| Entity | One message in one conversation: a Rally turn once its run settles, or a person's message once it is admitted. A Breakout's parent is its Thread; a Thread's parent is its Channel |
| Outcomes | `worth_carrying_up` → offer `merge_up`; `side_question_worth_a_breakout` → offer `start_breakout`; `continue_here` → nothing |
| Evidence between adjacent outcomes | Whether the message holds something new for the parent's readers, or is a step of the work here; whether the message opened work beside the purpose or about it |
| Insufficient confidence | Nothing, recorded as `confidence_below_threshold` |
| Cannot answer | Nothing, recorded as `classifier_unavailable` with the provider's failure kind |

The first draft of this contract judged only a Rally turn, the last of a
completed run, inside a Breakout. The corpus evaluation widened it twice. A
Thread merges up into a Channel and breaks out into a Breakout, so the same
decision applies one level up. And a side question is usually opened by a
person, not by Rally's answer to it: the message that says "separate thing,
can you also…" is the one a Breakout suggestion should sit under, before Rally
has spent a run answering in the wrong room.

#### What the classifier is shown, and why

The state is what a person who owns the parent conversation would want in
front of them before deciding, and nothing a person would not read. Picture
the Thread's owner skimming a Breakout under it. They ask three things: *is
there something here I need?*, *did this wander into something that deserves
its own room?*, and *have I already pulled this up?* They answer them from a
few things, in this order, and the state carries exactly those:

| Field | What a person reads it for | Where it comes from |
| --- | --- | --- |
| `parent.kind`, `parent.title`, `parent.purpose` | Whether a result is **new to the readers who would receive it**. "Worth carrying up" cannot be judged without knowing what the parent is doing; the first state had no parent at all and judged from inside the child | The Thread's title and description for a Breakout; the Channel titles a Thread belongs to |
| `conversation.opening_request` | **The charter**, in the person's own words. The description loop's paraphrase drifts (one corpus Breakout's purpose named a candidate its first turn never mentioned); the first request does not | The first person-authored message of the conversation, kept whole up to 1,200 code points around a middle ellipsis |
| `conversation.purpose`, `conversation.title` | The purpose **as it evolved**, which the opening request cannot show | `workstream.description` and `workstream.title` |
| `conversation.messages_before` | How far in this is: a first reply and a fortieth are read differently | Count of judged messages before this one |
| `so_far.summary` | **Where the work stands** when the conversation is long. A person catching up on a long thread reads the handoff, not the transcript; the compaction checkpoint is exactly that handoff: request, decisions, done, facts, open | The newest `transcript_compaction_checkpoints` row before the message, the `summary` of its payload, bounded to 2,500 code points; absent when the conversation never compacted |
| `so_far.earlier_outputs` | **What has already been produced here**, so a reader can tell the first deliverable from the fifth revision of it. This one field answers the largest error family the first corpus pass had: revisions, additions and restyles of an existing output flagged as new deliverables | The `resource://` references in earlier messages, unique by resource, newest eight, each with how many messages ago |
| `so_far.carried_up_before` | **What the parent already received** from here, so a second suggestion is not a repeat | Merge markers before this message: `conversation_merged_into` in a Breakout, `space_messages.source_workstream_id` for a Thread |
| `recent_messages` | Whether the **loop is still turning** (feedback → tweak) and whether a side question is new rather than the purpose. Weak evidence, and the focus says so | The six judged messages before this one, each bounded to 700 code points around a middle ellipsis |
| `judged_message.author` | A person's message and Rally's call for different things: a person opens side questions and states decisions; Rally delivers | `author_type` |
| `judged_message.text` | The subject of the decision | The message, bounded to 6,000 code points around a middle ellipsis |
| `judged_message.outputs[].first_time_here` | Whether each output the message names is **new or a revision** | Resource references in the message, matched against the conversation's earlier ones |

What is deliberately not in it: the transcript (the summary and the output
history carry what it would), the message's position in time, the pacing
signals (how many suggestions were shown lately; those are gates, not
evidence), the parent's own recent messages (a parent's reader decides on
what the child produced, not on what the parent is saying today), and the
model's own earlier verdicts. Every extra field is one JEV can over-weight.
The order of the fields is the order a person would read them, and the focus
sentence tells the model to read as the parent's owner, because that framing,
not any single criterion, is what the first state lacked.

**The state:**

```json
{
  "parent": { "kind": "channel | thread", "title": "...", "purpose": "a Thread's description; a Channel has none" },
  "conversation": {
    "kind": "thread | breakout",
    "title": "workstream.title",
    "purpose": "workstream.description",
    "opening_request": "the first person-authored message, when there is one",
    "messages_before": 12
  },
  "so_far": {
    "summary": "the newest compaction handoff before this message, when one exists",
    "earlier_outputs": [{ "title": "...", "messages_ago": 3 }],
    "carried_up_before": 0
  },
  "recent_messages": [{ "author": "person | rally", "text": "..." }],
  "judged_message": {
    "author": "person | rally",
    "text": "...",
    "outputs": [{ "title": "...", "first_time_here": true }]
  }
}
```

The bounds are constants in `turn-disposition.ts` and `boundTurnDispositionState`
applies them, so the request bytes an evaluation measures are the bytes
production sends.

**The question:**

```json
{
  "question": "Read as the owner of `parent`: what does `judged_message` call for?",
  "focus": "`parent` is the conversation that would receive a merge and who reads it. `conversation.opening_request` and `conversation.purpose` are what this conversation exists to do. `so_far.summary`, when present, is where the work stood before the recent messages; `so_far.earlier_outputs` are the things already produced here, and `so_far.carried_up_before` how many times something was already carried to the parent. Use `recent_messages` only to tell whether the purpose is still in motion and whether a side question is new. `judged_message.outputs[].first_time_here` says whether an output is new or a revision.",
  "decision": "Choose exactly one."
}
```

**The criteria**, as the first corpus pass left them (the evaluation section
below records what each exclusion earned):

| Outcome | Meaning | Include | Exclude |
| --- | --- | --- | --- |
| `worth_carrying_up` | The message holds something new for the parent's readers, in words they could use without this transcript: a deliverable, a finding, a decision, an answer to what they asked, a recommendation, a milestone, or a question only they can settle | The first complete deliverable or draft for the purpose; a finding, diagnosis or assessment the people here asked for; a decision or recommendation the people here reached; the answer to the purpose; a correction that changes a result already carried; a question this conversation cannot settle and the parent can; a milestone the parent is waiting on, or a notice that a purpose the parent cares about is complete; a person's message that states a decision or result the parent's readers need | A revision, addition, restyle, fix or expansion of a deliverable this conversation already produced; a variation offered for taste, or a draft the message itself calls preliminary; general knowledge, or an opinion the parent's work does not need; a summary or explanation of material the parent already has; the answer to a narrow follow-up question, inside or beside the purpose; routine progress, a blocked attempt, an acknowledgement, or a report to a coordinating agent; a question to the people here about the purpose, or a person's request to Rally |
| `side_question_worth_a_breakout` | The message, or the exchange that led to it, opened a distinct piece of work beside the purpose: large enough to need its own conversation, likely to crowd this one | A sub-problem the message proposes to work separately; a second deliverable the people asked for that the purpose does not cover; a person's request or proposal that starts a different piece of work from the purpose, whoever it is addressed to; a line of questions on another subject that has run for several messages | A clarification or follow-up about the purpose itself; a one-line aside, or a general-knowledge question answered in one message; the next step of the purpose |
| `continue_here` | The message is a step of the work here, and nothing in it is new for the parent's readers | Partial work, a question to a person here about the purpose, a status update, a person's request to Rally about the purpose; a revision, addition, restyle or fix of a deliverable already produced here; a variation offered for taste; a narrow follow-up answer, general knowledge, or a summary of material the parent already has; a result that answers a small part of the purpose | Something new that the parent's readers need now; a distinct piece of work beside the purpose |

The exclusions are symmetric on purpose: what one outcome excludes, its
neighbour includes, so no case falls between them for the model to settle
differently from run to run. `continue_here` is defined positively rather
than as a catch-all; ordinary uncertainty belongs in the confidence. The live
probe's line "a deliverable revised the way the people here asked, now done"
under `worth_carrying_up` was reversed by the corpus: on real Breakouts a
revision is almost always one step of an iteration loop, and the owner of the
parent wants the result once, not every version of it.

**Two constants, one measured and one transcribed:**

- `TURN_DISPOSITION_CONFIDENCE_THRESHOLD`: the comparison is `>`, matching
  the other two classifiers, so a confidence equal to it stays quiet. The value
  is read from the shadow sweep (below). While the surface does not exist the
  constant is not applied; every answer is recorded with its confidence.
- `TURN_DISPOSITION_JEV_TIMEOUT_MS = 1_000`: three times the measured JEV p95
  of about 350 ms, the same budget addressing and the semantic trigger carry
  against the same provider, transcribed with that source.

**Mapping to a suggestion kind** is the host's, in the observer, by
conversation kind:

| Choice | In a Breakout | In a Thread's Main |
| --- | --- | --- |
| `worth_carrying_up` | `merge_up` into the Thread | `merge_up` into the default Channel |
| `side_question_worth_a_breakout` | nothing (no nested Breakouts) | `start_breakout` from this message |
| `continue_here` | nothing | nothing |

Three kinds of conversation never reach the classifier, by origin rather than
by judgement, because nothing in them is for people: a coordinator's sub-agent
Breakout (its result goes to the coordinator), an import, and a digest or
other system-kind Thread. The corpus holds them labeled `continue_here` so a
model that is shown one anyway is measured on it.

**A second question, for the words and not the decision.** What a merge
carries is not always a result: a decision, an answer, a draft, a milestone
or a question for the parent are all things people merge. The action is the
same for all of them, so they are one outcome above, as the contract rule
requires. The line's sentence may still want the noun. A second Choice in the
same request, `carried_item_kind` over `deliverable`, `decision`, `answer`,
`update`, `question`, answers in the same round trip at no extra latency and
feeds nothing but the wording. It is asked and recorded from the first shadow
run; whether it is shown depends on its measured accuracy, since a wrong noun
in front of a whole Thread costs more than no noun. Until then the line uses
the neutral template below.

The question is the same in both kinds; the mapping discards what the host
cannot offer. The alternative, two question documents, is two candidates to
keep measured. If the shadow corpus shows the breakout outcome drawing
probability mass away from the merge boundary inside Breakouts, a Breakout
variant of the question is the ablation to run.

### The price list, and what it says about the threshold

With `p` the probability a positive answer is right, and `c`, `f`, `m` the
weights of a correct suggestion, a false one and a missed one, suggesting beats
staying quiet when `p > (c − f) / (2c − f − m)`. Three price lists frame the
choice:

| Price list | `c` | `f` | `m` | Suggest when `p >` | Reads as |
| --- | ---: | ---: | ---: | ---: | --- |
| Semantic trigger's | 1 | 0 | −2 | 0.25 | A miss costs the request; a false fire costs one session that finds nothing |
| Symmetric | 1 | −1 | −1 | 0.50 | Both errors cost one unit of attention |
| Noise-averse (proposed) | 1 | −1 | −0.5 | 0.57 | A false line erodes trust in the line; a miss leaves the Merge button where it was |

The proposed direction is the third, for two reasons that are the product's
and not a tuning knob: the manual path exists and is one hover away, so a miss
costs little; and the predecessor was retired for noise, so a false suggestion
spends the trust the whole feature depends on. The team confirms the
direction; the number then comes from the sweep, because a Choice's reported
confidence is not `p` and is not calibrated.

### The gates

Deterministic, cheapest first, each a reason not to pay for the next. Most
settled turns stop at one of them.

| # | Gate | Reads | Why |
| --- | --- | --- | --- |
| 1 | The run completed with a final text turn | the outcome | A failed or stopped run, or a tool-only ending, has no result to judge |
| 2 | `parentKind` is `workstream`, not a background agent, not archived | the input and the `workstream` row | Sidekick runs and background agents are out of scope; nothing reads an archived conversation |
| 3 | This run has not already been judged | `conversation_suggestions` by `run_id`, and the diagnostics record | Settlement retries; the judgement is idempotent on the run. A row left `pending` by an interrupted settlement resumes at the draft |
| 3b | The judged turn is still among the newest three | the transcript's newest sequences | A settlement that lands late, behind three newer messages, has nothing to show; the decision is still recorded |
| 4 | At least one kind is offerable | the `workstream` row's scope; the conversation kind | A private Thread cannot merge into a Channel; a Breakout offers only `merge_up`. A Thread with no placement is left to the client's check |
| 5 | The turn has not already been carried up | the newest `conversation_merged_into` marker, if its sequence is after the turn | A merged result is not suggested again |
| 6 | Pacing: no dismissal of the same kind within `SUGGESTION_DISMISS_COOLDOWN_MS`; no more than `SUGGESTION_MAXIMUM_PER_CONVERSATION_DAY` shown per conversation per day | `conversation_suggestions` | Both open; see [limits handed back](#limits-handed-back) |

No minimum turn length. A one-line "Done." is for the classifier to call
`continue_here`; a length floor would be a number nobody can justify saving one
unpriced call.

### The suggestion slot

One table in the conversation object, migration v75:

```sql
CREATE TABLE conversation_suggestions (
  suggestion_id      TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('merge_up', 'start_breakout')),
  judged_turn_id     TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'dismissed', 'expired', 'withdrawn')),
  draft_status       TEXT NOT NULL CHECK (draft_status IN ('pending', 'ready', 'failed')),
  draft_text         TEXT,
  draft_subject      TEXT,
  decision_choice    TEXT NOT NULL,
  decision_confidence REAL NOT NULL,
  decision_model     TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  resolved_at        INTEGER,
  resolved_by_user_id TEXT,
  resolution         TEXT CHECK (resolution IN ('accepted', 'dismissed', 'ignored'))
);
CREATE UNIQUE INDEX conversation_suggestions_one_per_turn
  ON conversation_suggestions (judged_turn_id);
CREATE INDEX conversation_suggestions_pacing ON conversation_suggestions (kind, status, resolved_at);
```

**Lifecycle, all server-side facts:**

- **Open.** The observer inserts a row for the judged turn with the draft
  `pending`, and the client learns through a new canonical socket event,
  `conversation_suggestion_changed`, and the snapshot's new `suggestions`
  field, which lists the open rows on the newest three turns. The chip is
  drawn at once with skeletons for the draft. A second event carries the row
  `ready` or `failed`, and the chip fills or settles. An earlier turn's open
  row is left alone: the newest-three rule, not a new judgement, retires it.
- **Accepted, merge.** `ConversationMergeService.markSource` already appends
  the `conversation_merged_into` marker to the source conversation's object.
  The same mutation resolves an open `merge_up` row whose judged turn is at or
  before the merge: `status = 'accepted'`. No client call.
- **Accepted, breakout.** `captureInitialSubstreamContext` runs in the parent
  conversation's object with the cutoff turn. The same mutation resolves an
  open `start_breakout` row whose judged turn is the cutoff.
- **Dismissed.** `POST /conversations/:parentId/suggestions/:suggestionId/dismiss`
  (with the substream in the query, as the conversation routes carry it),
  admitted as a read of the conversation, resolving the row with who did it.
- **Expired.** Visibility is the newest-three rule, applied in two places
  that agree: the client draws an open row only while its turn is among the
  newest three messages it holds (people's messages and Rally's replies; tool
  cards and system rows do not count), and the object, on each admitted
  message and each judgement, closes any open row whose turn now has three
  newer messages as `status = 'expired'`, `resolution = 'ignored'`. The
  client's rule is what makes the line disappear the moment the third message
  arrives; the object's write is what records the outcome. The number is
  `SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS = 3`, a product limit set by the
  product owner in the PRD, held once in `packages/contracts` so both sides
  read the same value.

Both acceptances are also the labels the corpus wants: a merge or a Breakout
from a judged turn with a suggestion standing is a hit; one with none standing
is a miss; a dismissal or an expired row is a false positive or an unwanted
one. A merge or Breakout made from a turn after its row expired is still
read as a hit for the classifier and a miss for the surface, which is the
one number that says whether three is the right window. Nothing is inferred
from client behaviour.

**What the client gets** is an optional list on the conversation snapshot,
and one object per event: `{ suggestionId, kind, judgedTurnId, draft:
{ status, text, subject }, target: { kind, id, title } | null }`. The server computes `target` for `merge_up` the way the
Merge label does (the Thread, or the Channel `channelMergeTarget` would pick);
the client still applies `mergeTargetFor` for this viewer before drawing the
action. The snapshot field is optional and the event type is new, so both go
only to builds at a new client contract, 8, the mechanism merge-back used for
7. `safeParseSocketEvent` strips unknown keys but an unknown event type fails
the union, which is why the event is contract-gated rather than sent to all.

### The suggestion drafter

A `runStructuredInference` role, `suggestion_draft`, declared in
`AGENT_MODEL_ROLES` with flag `agent-model-suggestion-draft`, default
`OPENROUTER_STRUCTURED_MODEL`, registered in Ace's `ManagedModelRoleSchema`, and
metered as `suggestion_draft` with the Organization paying, like
`breakout_summary`. Two prompts, one per kind, in
`packages/agent-harness/src/prompts/suggestion-draft.ts`, byte-stable and
golden-hashed per `writing-prompts.md`. Both receive the same bounded window
the classifier saw plus the purpose and the judged turn whole.

- **A merge note** (`{ text }`): a short note for the parent's readers, the
  way merge-back describes a merge (a squash commit message, not the
  history), leading with what was decided or made, keeping every
  `resource://` embed the judged turn carries so the artifacts travel, and
  restating nothing the parent's readers should not see. It is what the
  response card opens with, and the chip's excerpt is its first line.
- **An opening prompt** (`{ subject, prompt }`): two to five sentences,
  written as the first instruction of a Breakout a person is about to start,
  naming the sub-problem and what done looks like, plus a subject of a few
  words for the chip's title.

A reply that is empty or over `MESSAGE_MAX_CHARACTERS`, a refusal, a
deadline or an unreachable route is a failed draft: `draft_status` goes to
`failed`, the row to `withdrawn`, and the event removes the chip. A
suggestion without its words is not shown; the turn keeps its hover row.
A withdrawn row is not a dismissal, so it buys no cooldown, and in the
corpus it counts as a drafter failure, neither a hit nor a miss of the
surface. The drafter runs only after a confident positive, after
the row is inserted and shown, so its cost scales with positives and its
latency never delays the chip. It does not run in shadow. The same role is
what a Summarize button on the response card would call for a merge nobody
suggested; that button stays merge-back's phase 2.

### The client

- **The chip.** Drawn under the judged turn by `MessageBlock` in
  `workstream-blocks.tsx`, in the `cardsAfter` row of `message-feed.tsx` where
  "Breakouts from this message" chips already sit, after the turn's
  attachments and its hover action row: a dashed outline, the title, the
  sentence, one cut line of the note or the prompt, the action pill (the
  merge target pill's style for `merge_up`, the breakout tint for
  `start_breakout`), and a dismiss. No avatar or mark: the dashed outline
  and the sentence are what say it is a suggestion. Drawn
  only while the turn is among the newest three messages the feed holds, and
  only when the viewer passes `mergeTargetFor` (for `merge_up`) or can post
  (for `start_breakout`). Never in the composer: `ComposerInput`'s notice slot
  stays merge mode's.
- **The words** are fixed strings chosen by the kind, with one slot for a
  name, pinned by a test. JEV returns a label, never prose, so nothing is
  generated for the merge chip. `merge_up`: title "Merge to {target}", the
  target being the Thread for a Breakout and the default Channel for a
  Thread; sentence "This might be a good time to merge this back into
  {target}." Once `carried_item_kind` has earned it, the typed sentence
  "This might be a good time to merge this {kind} back into {target}."
  replaces it.
  `start_breakout`: title "Breakout: {subject}", the subject being a short
  label the drafter returns beside the prompt, and "Breakout" alone when
  there is no draft; sentence "Want to break this out?" Neither sentence
  promises that nothing happens on its own; the card and the launch pane
  that open on the action are what make that true, and the excerpt shows
  what they will open with.
- **The excerpt** is the last line of every chip: the words the action would
  post or start with, in quotation marks, cut by the client to one line,
  never stored cut. The cut is by characters, not by CSS `text-overflow`:
  the client takes the first `SUGGESTION_EXCERPT_CHARACTERS` of the words,
  drops a trailing space, and appends an ellipsis, so the closing quote
  follows the ellipsis directly. CSS truncation leaves up to a glyph of
  blank between the ellipsis and whatever comes after it, which is why it is
  not used here. The quotes are typographic marks that share the text's
  baseline with no added gap, and the line keeps `white-space: nowrap` with
  `overflow: hidden` as a guard for a narrow pane. The budget is a product
  number: it is what fits one line of the chip at the narrowest pane the
  desktop lays out, and it is set when the chip is built, cited to this
  design. The response card's quote line of a thread's first words is drawn
  the same way. For `merge_up` it is the note the response
  card opens with, which is the judged turn's text until merge-back's
  Summarize ships and the drafted summary after; for `start_breakout` it is
  the drafted opening prompt, and the line is left out when there is no
  draft. The excerpt is the one part of the chip that is content rather than
  template, and it is content the viewer can already read in this
  conversation or is about to be shown to edit.
- **Accept merge** opens the response card in the chip's place, prefilled
  with the drafted note and the suggestion's target.
- **The response card** is `MergeResponseCard` in `packages/ui`, beside
  `MergeMessage` and built from its layout, so the editable preview and the
  landed merge are one block in two states. Its state lives on
  `ConversationSurface` as one open merge draft: the anchor turn (or none,
  from the title menu), the target, the words, and the embeds parsed from
  them with `mergeResourceIds`. `MergeButton`, the title menu's Merge row and
  the suggestion pill all open it; `mergeTargetFor` still decides who may.
  It is drawn in the `cardsAfter` row under the anchor turn, or after the
  newest turn when there is none. Merge calls `POST
  /conversations/:parentId/merge` exactly as merge mode did, keeping one
  `clientMessageId` for the same words and target so a lost response is
  retried as a replay, and `onMerged` reveals the landed merge as today. The
  draft persists under the existing `…:merge` draft key until merged or
  cancelled. The composer's merge mode is removed: the `notice`,
  `toolsAccessory` and `submitContent` slots stay on `ComposerInput` for
  other modes, and `mergeDraftKey`, the audience line and the target pill
  move into the card.
- **The skeleton.** While `draft.status` is `pending` the chip draws a
  shimmer where the excerpt goes and, for a Breakout, where the subject goes
  in the title; the action is disabled and Dismiss is not. `ready` fills
  both in place; a `withdrawn` row removes the chip. The shimmer respects `prefers-reduced-motion`.
- **Accept breakout** calls `onStartSubstream(judgedTurnId)` and seeds the
  launch composer's draft with the drafted prompt. `ConversationSubstreamLaunch` gains
  an optional `initialDraft`, written to the launch composer's draft key once
  when the pane opens, so a person who already typed there is not overwritten.
- **Dismiss** calls the route and hides the line at once; the event confirms.
- **Verification** per the rule for visible changes: the desktop under Xvfb,
  Playwright over DevTools, screenshots of the line in a Breakout, in a Thread,
  on the third newest turn and gone on the fourth, the response card under a
  turn and at the end of the feed, a Channel card with its quote line, and the
  launch pane after accepting.

## Shadow mode and the corpus

### What shadow records

For every settled turn that passes gates 1 to 5, one `structured_inference`
log row and one lakehouse record: the full application request (state and
questions), the answer, its confidence, the model that answered, latency and
tokens, and the mapped kind. Gate 6 is not applied in shadow, so pacing does
not hide what the classifier would have said.

### Where the labels come from

Rally retains the outcomes this decision predicts, which is what makes this
classifier measurable rather than a guess:

| Label | Source | How it joins |
| --- | --- | --- |
| A Breakout was started from this turn | `originTurnId` on each Breakout (`visiblePrivateChildren`, `parent_breakout_preparations.request_json`) | The judged turn is the cutoff |
| A Breakout's result was merged | `conversation_merge` messages in the Thread (`mergedFrom.breakoutId`), and the `conversation_merged_into` marker in the Breakout | The judged turn is the newest Rally turn before the marker whose text the merge body starts from |
| A Thread's result was merged | `space_messages.source_workstream_id` in the WorkspaceDO, and the marker in the Thread | As above |
| Neither | Every other judged turn | A regression label, not ground truth |

A Breakout is an older product than merge-back, so `start_breakout` positives
exist from day one; `merge_up` positives accrue from 2026-10-16. Both are
production labels: a merge that did not happen is not proof that a suggestion
would have been wrong, so the "neither" class needs the independent
adjudication layer addressing used, a sampled subset judged by Sol at medium
reasoning against the same rubric, with the production label and the judgement
kept distinguishable.

### How the threshold is read

The eval lives in `packages/agent-harness/evals/turn-disposition/`, shaped like
`evals/addressing/`: a caller-supplied corpus that is never committed, a
content-safe synthetic fixture for the runner, a content-free aggregate
baseline, reports bound to the corpus hash and written to a protected scratch
directory with mode 0600. The corpus is an authorized export of lakehouse
records joined to the labels above through the engineering MCP, handled under
the production-data runbook and deleted after the run.

1. Freeze the label mapping and split development from holdout before tuning.
2. Repeat the baseline request three times to measure the floor; a difference
   smaller than a candidate's own spread is not a difference.
3. Ablate one representational idea at a time: with and without `artifacts`;
   the fourth outcome; a Breakout-specific question; shorter context.
4. Sweep the threshold through one implementation of the gate's rule, scored
   against the confirmed price list, and read the suggestion rate per settled
   turn at each point: that rate is the number the product owner is asked to
   accept, and it is what "not too noisy" means in a figure.
5. Run the winner once on untouched holdout, repeat it, and commit the
   aggregate as the baseline. Pin the shipped request to the measured bytes.

### A first live probe, 2026-10-18

The question above, with the second `carried_item_kind` question in the
same request, was run against the live endpoint on fourteen authored cases,
twice each, from a scratch harness outside the tree. The numbers are a
smoke test of the contract, not a measurement: the cases were written by
the author of the question, there is no split and no adjudication, and the
harness is not committed. They are recorded so the first real evaluation
has something to be compared against.

| | |
| --- | --- |
| Model | `jev-1.13.0` through `jev-latest` |
| Disposition | 25 of 28 answers as expected; 13 of 14 cases gave the same answer twice |
| Kind | 16 of 20 answers within the expected set |
| Confidence | mean 0.75 on correct answers, 0.40 on wrong ones |
| Latency | p50 120 ms, p90 181 ms, one 580 ms outlier on the first call; no failures |

Three things the probe showed, each a candidate for the real corpus rather
than a conclusion:

- **A revised deliverable read as an update.** The Breakout case whose turn
  ends "nothing else changed" came back `worth_carrying_up` at 0.48 and 0.52,
  on the threshold, with the kind `update`. Adding one include to
  `worth_carrying_up` ("a deliverable revised the way the people here asked,
  now done") and its mirror exclude to `continue_here` moved it to 0.82 on
  both runs and moved nothing else. That line is in the criteria above.
- **A turn that both settles the purpose and opens a side question splits
  the vote.** The "annual at $96 holds, Starter is a separate question" case
  came back `worth_carrying_up` at about 0.5 both times, never the breakout.
  A tie-break sentence in the focus ("if the turn does both, it is worth
  carrying up") did not change the label and lowered confidence on every
  carry-up case, so it was dropped. Whether such a turn should get both
  suggestions, or the breakout on the following turn when the side question
  is picked up, is the first question for the real corpus.
- **A question to the people here that names a side piece of work** was
  called a breakout once at 0.16 and `continue_here` once at 0.23: the one
  unstable case, and one no threshold in the measured band would act on.

Everything else, including the small answer inside a bigger purpose, the
acknowledgement, the preliminary draft asking for review, the milestone and
the recommendation, came back as expected on both runs. The second question
named `decision`, `answer` and `question` reliably and confused
`deliverable` with `update` on the revised deliverable, which is consistent
with the rule above that the kind is recorded before it is shown.

### The first corpus evaluation, 2026-10-18

The eval in `packages/agent-harness/evals/turn-disposition/` was run over
every message, a person's or Rally's, in every exported Thread and Breakout,
with the widened state above. This is the benchmark the production model is
chosen from; the same corpus and labels are the dataset for the prompt
optimization that follows.

**Corpus.** 526 conversations from 27 Organizations: all 169 Breakouts and
357 of the 480 Threads. That gave 3,931 cases: 1,474 a person's message,
2,457 Rally's, 1,149 of those the final turn of a completed run. Two gaps,
both named rather than hidden: 123 Threads (most of them in Juno Labs' own
Organization) were not exported, because the export path, sub-agents
re-keying transcripts out of the engineering MCP, was stopped by a safety
classifier partway through each partition and no second path was taken; and
65 Breakouts came from an earlier export whose bodies were cut at 2,000
characters and carried no compaction rows. Only 2 conversations in the whole
corpus had a compaction checkpoint, so `so_far.summary` was present in 7
cases: the long-conversation path is designed, not yet measured.

**Labels.** Two layers, kept distinguishable by `source`:

- 1,301 cases labeled by hand by the author of this design, against the
  criteria above, before any model answered: 176 `worth_carrying_up`, 21
  `side_question_worth_a_breakout`, 1,104 `continue_here`. Every Breakout
  person's message and every Breakout final turn is in this set, as are 370
  Thread final turns and spread samples of the Thread strata.
- Every case judged by `anthropic/claude-sonnet-5.5` at low reasoning
  through the same request, a different model family from either target.
  Against the hand labels the judge agrees on 91.1% of cases, with carry-up
  precision 70% and recall 85%; the side-question class is where it is weak
  (F1 0.34 on 21 positives). The hand label overlays the judge's wherever
  both exist, so every case is scored and the hand-labeled slice is still
  readable on its own.

The production outcomes the design planned to read as labels were too thin
to carry the eval: 24 cases sit before a later merge and 73 before a
Breakout started, in a corpus whose merge-back shipped two days before.
They are kept beside each case and reported, not used as truth.

**Split.** Development and holdout halves are fixed by the conversation
id's last hex digit, 1,756 and 2,175 cases. The v2 criteria were written
from the v1 criteria's errors on the development half of the earlier
216-case Breakout final-turn run; nothing was tuned on the holdout.

**Targets.** JEV (`jev-latest`, resolving to `jev-1.13.0`, two runs over
everything) and `openai/gpt-5.6-terra` over OpenRouter at reasoning `none`,
through the same bounded state bytes. Coverage runs used concurrency;
latency is from a separate sequential run over a fixed random sample of 300
cases, end to end from the harness, request build to parsed answer.

Over all 3,931 cases, against the merged labels:

| | JEV, confidence > 0.6 | JEV, no threshold | Terra |
| --- | --- | --- | --- |
| Three-way agreement | 85.1% | 85.1% | 90.2% |
| Carry-up precision / recall / F1 | 73.9% / 73.3% / 0.736 | 54.7% / 88.3% / 0.675 | 65.2% / 90.9% / 0.759 |
| Side question TP / FP / FN | 35 / 48 / 62 | 68 / 176 / 29 | 58 / 90 / 39 |
| Suggestions per Rally final turn | 24.8% | 39.9% | 33.7% |
| Suggestions per person's message | 5.2% | 13.7% | 12.2% |
| Same answer on both runs | 98.5% | 98.5% | not run |
| Confidence, mean on correct / wrong | 0.79 / 0.51 | | 0.98 / 0.93 |
| Latency, sequential, p50 / p90 / p99 | 83 / 123 / 165 ms | | 985 / 1,134 / 1,688 ms |

On the 1,301 hand-labeled cases alone, the honest column, since the judge
shares more of its reading with a generative target than with JEV:

| | JEV, confidence > 0.6 | Terra |
| --- | --- | --- |
| Three-way agreement | 80.2% | 86.2% |
| Carry-up TP / FP / FN | 120 / 62 / 56 | 157 / 118 / 19 |
| Carry-up precision / recall / F1 | 65.9% / 68.2% / 0.670 | 57.1% / 89.2% / 0.696 |
| Holdout half only: agreement, F1 | 83.0%, 0.667 | 88.0%, 0.681 |
| Kind, where both say carry up | 75.8% | 80.9% |
| Breakout final turns (the v1 run's slice, 323 cases): agreement | 75.9% (v1: 54.4%) | 83.3% (v1: 73.6%) |

What the numbers say:

- **The two are close on the hand labels and differ in how they miss.**
  Terra finds nine in ten carry-ups and pays with twice JEV's false
  positives; JEV at 0.6 is the quiet one, flagging one person's message in
  twenty against Terra's one in eight, and misses a third of the
  deliverables. Thresholded JEV and unthresholded Terra land within three
  points of F1 on every slice, including the holdout.
- **Only JEV has a threshold to turn.** Its confidence separates right from
  wrong (0.79 against 0.51); Terra's is 0.98 and 0.93, so the gate's rule has
  nothing to read and Terra's precision can only be moved by rewriting the
  prompt. The threshold sweep puts JEV's F1 flat between 0.5 and 0.7
  (0.729, 0.731, 0.729), with precision rising from 68% to 80% and recall
  falling from 78% to 67% across it: the product owner's choice, as the
  limits document asks.
- **The false positives are the same kind for both.** By the hand labels'
  notes, JEV's 62 at 0.6 are 14 Sidekick or system outputs, 5 test and QA
  threads, 7 general-knowledge answers and 4 progress notes; Terra's 118 are
  23, 21, 6 and 7. The first two are the origin gate's job, before the
  classifier runs, and remove a third of JEV's and a third of Terra's.
  52 of JEV's 62 are also Terra's.
- **A conversation with earlier outputs is the hard case for both.** On the
  775 cases where the conversation had already produced something, JEV's
  carry-up F1 is 0.52 and Terra's 0.65: telling a rebuild that changes what
  the parent would receive from a revision that does not is where the
  criteria need the optimization run most.
- **The side question is not ready for a surface.** 21 hand-labeled
  positives; JEV calls 176 side questions without a threshold and 48 with,
  Terra 90, against 58 and 35 right. Until the prompt work lifts it, the
  Breakout suggestion should stay in shadow while the merge suggestion ships.
- **JEV is twelve times faster, with no tail.** 83 ms at p50 and 165 ms at
  p99 fits inside the settlement step as designed; Terra's second at p50
  would move the step to the Queue path of key design decision 6 on day one.

The choice is JEV, at the 0.6 threshold for shadow, with the Breakout
suggestion held back. Terra's extra accuracy on the hand labels is six
points of three-way agreement bought with twice the false positives, no
threshold lever and a second of latency. The merged labels, the hand labels
and the cases are the dataset for the prompt optimization that follows; the
hand labels without their notes are committed beside the eval as
`golden-labels-2026-10-18.jsonl`, and the rest stays in the protected
directory and is deleted when that work is done.

### What "not too noisy on either end" means in numbers

Read from shadow before any surface, and from the slot afterwards:

- **Suggestion rate**: positives above the candidate threshold per settled
  turn, per kind, per conversation kind. The loud end.
- **Miss rate**: merges and Breakouts people made whose judged turn had no
  positive. The quiet end.
- **Acceptance and dismissal rates** once visible: accepted, dismissed and
  ignored per shown suggestion, read from the slot's resolutions.
- **Settlement cost**: the step's added latency at p50 and p95 against the
  description loop's, from the settlement observation that is already
  recorded. If it grows past the description loop's, the step moves to a Queue
  per key design decision 6.

## Noise controls, and which are open

| Control | Mechanism | Value |
| --- | --- | --- |
| One suggestion per judged turn | The unique index on the turn | Structural |
| Hidden after three newer messages, for good | `SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS`, read by the client and written by the object | Product, 3, set in the PRD |
| Never in the composer | The line is drawn by the message block, not the composer | Structural |
| Removed on dismiss, for everyone | The dismiss route | Structural |
| Never unread, Activity, push or digest | The slot is not a transcript row and emits no activity effect | Structural |
| Shown only to who can act | `mergeTargetFor` and the post check on the client | Structural |
| Threshold | `TURN_DISPOSITION_CONFIDENCE_THRESHOLD`, `>` | Measured in shadow |
| Cooldown after a dismissal of the same kind | `SUGGESTION_DISMISS_COOLDOWN_MS` | Open, `0` |
| Suggestions shown per conversation per day | `SUGGESTION_MAXIMUM_PER_CONVERSATION_DAY` | Open, `+Infinity` |

The retired router's workspace-wide suppression (an event type turned off
after four resolutions and no acceptance) is deliberately not rebuilt. Its
no-way-back problem was the argument against it then, and the slot's per
conversation record gives the threshold the same feedback without a switch
that a quiet afternoon can flip for everybody.

## Failure modes

| Situation | What happens |
| --- | --- |
| JEV answers `continue_here` | Nothing shown; recorded |
| Confidence at or below the threshold | Nothing shown; `confidence_below_threshold` recorded with the confidence |
| JEV unavailable: HTTP, schema, deadline, no `TYPESAFE_API_KEY` | Nothing shown; `classifier_unavailable` with the provider's failure kind; settlement continues. Local development has no key and records unavailable, which is honest |
| The drafter fails or over-runs | `draft_status` goes to `failed`, the row to `withdrawn`, and the chip is removed; the decision is still recorded |
| The object is evicted between the decision and the draft | The row is `pending`; the alarm-recovered settlement retry finds it and resumes at the draft without judging again |
| Settlement retries after a crash | Gate 3 finds the run already judged; no second call, no second row |
| The description is empty or provisional | The question still runs; `purpose` is the first line of the request, which is what the loop would otherwise use. Breakout descriptions are summarized at their first settlement, before this step |
| A merge lands with no suggestion standing | The marker is written as today; the corpus records a miss |
| Two people act at once | The merge or Breakout goes through its own admission; the first resolution wins and the second finds the row resolved |
| The conversation is archived between judgement and action | The merge route and `prepare` refuse as they do today; the row is left open and superseded by the next event |
| An older desktop build | Receives neither the event nor the snapshot field; shows nothing |

## Latency and cost

Nothing is added to a request path. The judgement runs after the final turn,
`stream_completed` and the run's terminal commit, in the settlement lane,
behind steps that already make slower model calls. The person sees the
suggestion arrive a moment after the answer, over the socket.

Cost is one JEV call per settled turn that passes the gates. Addressing already
makes one per human message, so this roughly doubles JEV volume; the JEV leg
is unpriced in metering today (`usage-metering.md`), and that stays true here
until the team prices it. The drafter costs one generative call per confident
positive of either kind, metered to the Organization, and runs after the chip
is up so it never delays it. Writes: two per positive (the pending row, then
its draft), none otherwise. The chip is visible within about a second of the
turn settling; its words follow a few seconds later.

## Testing

Per [`testing.md`](../../testing.md): the runtime decides where a test goes,
each integration test is proved able to fail by breaking the behaviour it
covers once, and the limits' open values get both an enforcement test and an
open-value test.

| Suite | Covers | Proved by breaking |
| --- | --- | --- |
| `packages/agent-harness/src/turn-disposition.test.ts` (Node, stubbed provider) | The request bytes and key order; every outcome's mapping per conversation kind; the threshold's equality semantics; one case per way of not getting an answer; cancellation propagating | Unit-level; the literal is the only break available |
| `apps/api/test-workers/turn-disposition-settlement.test.ts` (workerd) | A completed Breakout run with a fetch double answering `worth_carrying_up` leaves one open `merge_up` row and one event; a Thread run answering the breakout outcome leaves `start_breakout`; `continue_here` leaves nothing; a failed run and an unreachable provider leave settlement, naming and description untouched; a replayed settlement writes once; a merge marker resolves the row `accepted`; a capture at the judged turn resolves it; the third newer message expires it as `ignored` and the second does not; the row is published `pending` before the drafter is called and `ready` after, and `withdrawn` when the drafting route refuses; a retry that finds a `pending` row drafts without judging again; unread and the directory are unchanged | Skip the expiry write (the open row survives a fourth message); skip the idempotency gate (two rows); move the step before the terminal commit (the turn is not yet final); publish only after the draft (no `pending` event) |
| `apps/api/test/conversation-suggestions-route.test.ts` (Node, typed double) | The dismiss route's admission and refusal codes; the snapshot field under contract 8 and its absence under 7 | Return the field to a contract-7 build |
| `apps/api/test/agent-model-flags.test.ts` | The new role is routed, flagged and metered; the exhaustiveness checks on `AGENT_MODEL_FLAG_KEYS` and `ORGANIZATION_PAYS` compile | Type-level |
| Renderer (`screens/workstream.test.tsx`, `components/workstream-blocks.test.tsx`, a new `merge-response-card.test.tsx` in `packages/ui`) | The line draws under the judged turn for a viewer who can act and not for one who cannot; it draws on the third newest turn and not on the fourth; a `pending` draft draws the skeleton with the action disabled and Dismiss enabled, `ready` fills it, `withdrawn` removes it; the composer carries nothing and never enters merge mode; accept opens the card in the chip's place with the drafted note and embeds; the hover action and the title menu open the same card, under the turn and at the end of the feed; Merge calls the route with the kept `clientMessageId`; Esc restores the line; accept opens the launch pane with the draft; dismiss hides at once | Component-level |
| `packages/agent-harness/evals/turn-disposition/` | The runner on the synthetic fixture; the corpus is never committed | Not a test; the eval |

The prompt's golden hash and the pinned question bytes are the regression
guard on the measured request: an edit fails until the baseline is re-run and
moved, as `semantic-trigger-gate.ts` records.

## Documents a build has to touch

- **New:** `docs/conversation-suggestions.md`, the module document for the
  slot and the overlay step, to the shape in `module-documents.md`, registered
  in `docs/README.md`.
- `docs/agent-harness.md`: the settlement step and the third JEV caller, with
  a changelog entry carrying the why.
- `docs/jev-classifier-opportunities.md`: the candidate entry this PRD adds is
  deleted when the classifier ships, per that file's rule.
- `docs/workstream-durable-object.md`: migration v75, the socket event, the
  snapshot field, contract 8.
- `docs/conversation-merge.md`: the response card replaces the composer's
  merge mode for every merge (the drift from the frozen merge-back PRD is
  recorded there, per `prds.md`); `markSource` resolving a row.
- `docs/substream-creation.md`: the launch pane's `initialDraft`; the capture
  resolving a row.
- `docs/feature-flags.md`: the `breakout_suggestion` role and flag, and
  `conversationSuggestionsEnabled` if the flag is asked for.
- `docs/usage-metering.md` and `docs/data-model.md`: the new metered
  activities and the table.
- `docs/writing-prompts.md` is followed, not changed.

## Build sequence

Each phase is a pull request or two with its own acceptance gate. The
`plan.md` that formalizes this is written after approval.

1. **Shadow.** The classifier module and its Node tests; the settlement step
   with gates 1 to 5; the `turn_disposition_classifier` diagnostics role and
   metered activity; the eval scaffold with the synthetic fixture. Gate:
   decisions appear in `structured_inference` logs and the lakehouse for a
   Breakout and a Thread in staging; a run with TypeSafe unreachable settles as
   before; settlement p95 is read before and after.
2. **Measure.** Authorized export, labels joined, split made, floor measured,
   ablations run, sweep scored against the confirmed price list, holdout
   repeated, baseline committed, request pinned. Gate: a threshold and a
   suggestion rate the product owner has seen and accepted, and a decision on
   Thread to Channel in the first visible version.
3. **Surface.** Migration v75 and the slot; the socket event and snapshot field
   under contract 8; the dismiss route; resolution from `markSource` and from
   the capture; expiry by recency; gate 6 with its open constants and both tests;
   the line under the turn with the newest-three rule; the response card for
   every merge, with the composer's merge mode removed; the breakout accept
   path and `initialDraft` on the launch pane;
   the drafter role, flag and both prompts, with the two-phase write and the
   skeleton; the product flag if asked for, registered
   in Ace in this phase. Gate: the workerd suite above; the four screenshots;
   the acceptance flows in the PRD walked on staging.
4. **Calibrate.** Read accepted, dismissed and ignored from the slot after the
   first weeks; re-score the stored shadow answers under any corrected price
   list without re-calling the provider; the team sets the two open numbers or
   deletes the guards; the fourth outcome and the Breakout question variant
   are ablated if the data asks for them.

## Limits handed back

Per [`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md):
defined, enforced through a parameter, tested at a finite value and at the open
value, and shipped open. Neither introduces an unbounded path: without them the
slot shows one line per positive judgement, which is the behaviour the
threshold already bounds.

| Constant | File | Bounds | Open value | On trip | Derive from |
| --- | --- | --- | --- | --- | --- |
| `SUGGESTION_DISMISS_COOLDOWN_MS` | `substream-agent.ts` (the observer step) | Time after a dismissal of one kind before the same kind is offered again in that conversation | `0` | Gate 6 skips the judgement; recorded as `paced` | The shadow data's distribution of time between a dismissal and the next positive in one conversation; the retired router used 30 days for a different rule |
| `SUGGESTION_MAXIMUM_PER_CONVERSATION_DAY` | same | Suggestions shown in one conversation per rolling day | `Number.POSITIVE_INFINITY` | Gate 6 skips; recorded as `paced` | The measured suggestion rate per settled turn times settled turns per conversation per day, from shadow |

The threshold is not on this table: it is a measured value with its own
procedure above, not a guard to be opened.

## What this deliberately does not do

- Change what the agent sees or can do. No tool, no prompt line, no history.
- Write into a parent conversation or a Channel on its own.
- Add an Activity kind, a notification kind or a digest line.
- Replace the description loop's judgement of purpose. It reads that loop's
  output and adds nothing to its inputs.
- Decide for a person whether a result is worth the parent's attention. It
  asks, once, quietly, under the turn, for as long as that turn is among the
  newest three, and records the answer.
- Touch the composer. What a person is writing is theirs; the suggestion
  stays with the message it is about.
