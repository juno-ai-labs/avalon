# Merge and Breakout suggestions

> Created 2026-10-17.
>
> After Rally finishes a turn in a Thread or a Breakout, a cheap classifier
> judges that turn against the conversation's purpose and, rarely, offers one
> quiet suggestion: merge this result up, or start a Breakout on the side
> question. Companion: [state](state.md), [design](design.md). Related:
> [the merge-back PRD](../2026-10-16_merge-back/prd.md) (which deferred "Rally
> suggesting a merge on its own"), [`conversation-merge.md`](../../conversation-merge.md),
> [`substream-creation.md`](../../substream-creation.md),
> [`workstream-descriptions.md`](../../workstream-descriptions.md),
> [`jev-best-practices.md`](../../jev-best-practices.md),
> [`jev-classifier-opportunities.md`](../../jev-classifier-opportunities.md),
> and [`contextual-routing.md`](../../contextual-routing.md), the retired
> in-conversation suggestion this PRD is written against.

## Summary

- **One judgement per settled Rally turn.** When a run completes in a Thread's
  Main or in a Breakout, the post-run overlay asks JEV one Choice question:
  measured against this conversation's purpose, does the turn call for merging
  the result up, branching a side question out, or nothing. Most answers are
  nothing, and nothing is the default the design protects.
- **A positive is one suggestion on that turn**, of kind `merge_up` or
  `start_breakout`, drawn as a dashed chip under Rally's message for the
  people who can act on it, never in the composer: Rally's mark, a title
  naming the action and its target, one sentence saying what happens next,
  the action, and a dismiss. The chip arrives the moment the classifier
  answers, with a skeleton where the words will be, and fills a few seconds
  later when Rally's draft lands: a recommended note for the parent, or an
  opening prompt and its subject. Accepting a merge opens a **response
  card** in the feed, in the chip's place: the merge as the parent will draw
  it, prefilled with the drafted note and editable. Accepting a Breakout
  opens the existing launch pane at that turn with a drafted opening prompt.
  The person edits and confirms. **Rally never merges or starts a Breakout on
  its own.**
- **Every merge moves to the response card.** The Merge hover action and the
  title menu open the same card, under the turn or at the end of the feed.
  The composer's merge mode from merge-back is retired; the composer is for
  messages.
- **Quiet by construction.** A suggestion is drawn only while its turn is one
  of the newest three messages in the conversation; after that it hides for
  good, acted on or not. A dismissal removes it for everyone, and it never
  lights unread, posts to Activity, pushes, or enters the model's history.
- **Shadow first.** Phase 1 runs the classifier and records every decision
  without showing anything. The threshold, the question wording and whether
  Thread to Channel suggestions are worth having are settled from that record
  before a person sees a suggestion.
- **Four generic pieces, each reusable on its own:** a post-run settlement
  observer, a JEV turn-disposition decision, a conversation suggestion slot,
  and a drafting role. The design file has each one's contract.

## Motivation

The merge-back PRD shipped on 2026-10-16 so that "when a thread is done, its
result goes back to the channel, where the next person finds it". Whether that
happens now depends on a person remembering to press Merge after Rally has
written the result. Rally wrote the result, and Rally's own description loop
already keeps a sentence saying what the conversation is for, so the moment a
result lands is knowable without a person noticing it. The same is true one
level down: Rally offers in prose to "draft each sequence in a breakout so this
thread stays readable" (the merge-back design's 5c·3 mock), and the only
mechanism behind that sentence is a person finding the New breakout button.

The merge-back PRD put "Rally suggesting a merge on its own" under **Not now**.
Its first design draft had the shape this PRD builds: "a quiet 'Ready to
merge?' chip with the draft prefilled. No unprompted posting into the parent."

The reason to be careful is in the tree. Suggested context cards were an
in-conversation suggestion too. They were paused on 2026-08-12 as "too noisy"
and removed on 2026-08-30 as "an unsolicited interruption". The post-mortem
names the three defects: the only quality control was "a constant compared
against a number the model made up about its own answer"; the card lived in
the message feed and dismissed cards accumulated there; and dismissals were
written to a column nothing read, so "a workspace could dismiss the same
suggestion every day and the next one arrived with identical odds". Each of
those has a direct answer here: the confidence is the provider's, computed over
a closed choice set; the suggestion is conversation state, not a feed row, and
only one stands; and every accept, dismiss and ignore is recorded against the
decision that produced it and read back when the threshold is set.

There is no usage evidence yet. Merge-back is a day old, and the number of
merges or Breakouts people make by hand is not known. That is why the first
phase measures before it shows.

## Goals

1. After a settled Rally turn that holds something the parent's readers need
   now (a deliverable, a decision, an answer, a milestone, or a question only
   they can settle), the people who can merge see one suggestion under that
   turn to merge it up, and accepting it opens a response card in the feed
   prefilled with a note Rally drafted for the parent's readers and the
   target.
2. After a settled Rally turn in a Thread that opened a distinct piece of work
   beside the purpose, the people who can post see one suggestion under that
   turn to start a Breakout from it, with a drafted opening prompt they edit
   before sending.
3. A suggestion stays on its turn and is visible only while that turn is one
   of the newest three messages. It is removed by a dismissal, hidden for good
   once three newer messages exist, and never produces a notification, an
   Activity row, or an unread mark. The composer is never touched.
4. Every decision the classifier makes, shown or not, is recorded with its
   answer, confidence and what the people did afterwards, so the threshold
   and the question are tuned against outcomes rather than impressions.
5. No suggestion is shown to anyone until a shadow run has produced a measured
   threshold and a measured suggestion rate.
6. The run itself is unchanged: the final turn, `stream_completed` and the
   run's terminal state land exactly as today, and the judgement runs after
   them.
7. Every merge, from a suggestion, the Merge hover action or the title menu,
   is made in the response card. The composer's merge mode is gone, and the
   merge route, its admission and what lands in the parent are unchanged.

## Non-goals

1. **Rally merging, or starting a Breakout, on its own judgement.** Rejected.
   The merge-back PRD's rule stands: "Rally merges only when someone asks."
   A suggestion is an affordance a person acts on.
2. **A suggestion that writes anything into the parent**, or a Rally message
   in the transcript announcing one. Rejected. The parent hears nothing until
   a person merges.
3. **A Breakout suggestion inside a Breakout.** Deferred. There are no nested
   Breakouts; inside a Breakout the only suggestion is `merge_up`.
4. **A Summarize button on the response card for a merge nobody suggested.**
   Deferred, and one button away: the drafter this PRD builds is what that
   button would call. A suggested merge gets its drafted note here; a merge
   from the hover action or the title menu still opens with the turn's text
   or empty.
5. **A thread status in the Channel feed** ("result ready", "open") derived
   from this decision. Deferred. The decision record makes it possible later;
   merge-back listed statuses under Not now.
6. **Sidekick runs, background agents, and Spaces as parents.** Deferred. The
   observer runs only for `parentKind: workstream` loops that are not
   background agents.
7. **Per-person suggestions.** Rejected for this version. The suggestion is
   about the conversation's result, which is shared; one dismissal clears it
   for the conversation. Who sees the action is still per viewer, from what
   they can do.
8. **An Activity row, a push, a digest line, or a Slack mirror.** Rejected.
   The retired predecessor died of exactly this.
9. **A generative fallback stage in the classifier cascade.** Deferred until
   the primary request is frozen and the fallback can be evaluated on the
   subset it would receive, per `jev-best-practices.md`.
10. **iOS.** Deferred. The slot is additive and invisible to a client that does
    not know it.

## Product behavior

**Where.** A Thread's Main conversation and a Breakout, on macOS and in the
browser.

**When.** After Rally's run completes with a text turn and the deterministic
gates in [design.md](design.md#the-gates) pass. The judgement runs in the run's
settlement lane, after the final turn is visible, so a person reading the
answer sees the suggestion arrive a moment later, never before.

**What they see.** A suggestion chip under Rally's turn, after its
attachments and its hover action row, in the row where "Breakouts from this
message" chips are drawn: a dashed outline, because the thing it names does
not exist yet, with Rally's mark, a title, one sentence of context for
someone who has never seen one, the action, and a dismiss:

- `merge_up` in a Breakout: title "Merge to **Cold Outreach**"; sentence
  "Rally thinks the thread should see this. You'll edit a short note before
  it posts there."; one cut line of the note the response card will open
  with; action **Merge**.
- `merge_up` in a Thread: title "Merge to **GTM**" with the Channel menu's
  caret; sentence "Rally thinks the Channel should see this. You'll edit a
  short note before it posts there."; the same cut line; action **Merge**.
- `start_breakout` in a Thread: title "Breakout: **Starter tier**"; sentence
  "Rally thinks this is its own piece of work. You'll edit the opening prompt
  before it starts."; one cut line of the drafted opening prompt; action
  **Start**.

Every chip ends with one line of the words it would post or start with, cut
with an ellipsis to the chip's width: for a merge, the note Rally drafted
for the parent's readers, which is what the response card opens with; for a
Breakout, the drafted opening prompt. A person can judge the suggestion from
the chip alone.

**Arriving.** The classifier answers about a quarter of a second after the
turn settles; the draft takes a few seconds more. The chip is drawn as soon
as the decision is made, with everything the template knows (whose idea,
what it is, where it goes, what pressing it does) and a skeleton where the
excerpt will be, and for a Breakout where the subject will be in the title.
The action waits with the skeleton, because the card or the launch pane
would open with words the person has not seen; Dismiss works from the first
frame. When the draft lands the chip fills in place. When the draft fails,
the chip stays: its sentence says Rally could not draft the words, the
excerpt is left out, and the action opens the card with the turn's own
words or the launch pane empty. A draft never blocks a suggestion. The title and the
sentence are fixed strings per kind with one slot for a name; nothing in
them is generated except a Breakout's subject, which the drafter returns
beside the prompt. The sentence exists for a new person: it
says whose idea this is, what pressing it does, and that nothing posts or
starts without them. What a merge carries is not always a result, so the
merge title names the target and claims nothing about the kind of thing. A
typed form ("Rally thinks this is a decision Cold Outreach should see") is
possible from a second classifier label the design records from the first
shadow run, and is shown only once that label has proved accurate. The
wording is a draft for design to settle. The shape is fixed: one line
under the turn, one action, one dismiss, nothing in the composer and no card
in the feed. The mockups are in [design-mockups.html](design-mockups.html).

**How long it shows.** Only while the turn is one of the newest three
messages in the conversation, counting people's messages and Rally's replies
and not tool cards or system rows. Once three newer messages exist the line
is hidden for good, whether or not anyone acted and whatever the classifier
would still say. The turn keeps its hover row, so Merge and New breakout are
where they always were. Three is a product number, set by the product owner,
and the constant that holds it cites this PRD. Two or three lines can be
visible at once when the newest three turns are all results; each stays on
its own turn.

**Accepting a merge** opens the response card in the feed, in the line's
place under the turn, prefilled with the judged turn's text, its embedded
artifacts and the default target. The person edits and merges, or cancels,
and the line comes back. When the merge lands in this conversation, the
suggestion resolves as `accepted`.

**The response card.** The merge as the parent will draw it, editable in
place: the same block the Thread or the Channel shows once a merge lands
(the source's mark and name, "merged by" and the person, the words, the
embeds, and in a Channel the thread's quote line), in a card where the words
can be edited and an embed taken out. Under it, the audience line merge mode
used to carry ("The 6 people in Cold Outreach will see this and can open
Sequence B."), the target pill with its Channel menu for a Thread, Cancel and
Merge. Enter merges, Shift+Enter breaks a line, Esc cancels. It opens where
the merge was asked for: under a turn from a suggestion or that turn's Merge
hover action, and at the end of the feed, empty, from the title menu. There
is one card open at a time, and the composer below it stays an ordinary
composer. The merge route, the admission, the retry on a kept
`clientMessageId` and the reveal of the landed merge are unchanged from
merge-back; only the editor moved. Summarize, merge-back's phase 2, becomes
a button on the card.

**Accepting a Breakout** opens the launch pane with the judged turn as the
cutoff, exactly as that turn's New breakout action does, with the drafted
prompt in the composer. The person edits and submits, or leaves. When a
Breakout is created from that turn, the suggestion resolves as `accepted`.

**Dismissing** removes the line for everyone in the conversation and records
who dismissed it. Nothing else happens.

**Aging out.** The third newer message hides the line. A suggestion nobody
acted on by then is recorded as `ignored`. A new judgement on a later turn
does not touch an earlier one; the newest-three rule is the only thing that
retires it.

**Who sees it.** Only a viewer who can perform the action: for `merge_up`, the
client's existing `mergeTargetFor` check (a Breakout member who can post in
Main; a member who can post in an Organization-wide Thread's Channel); for
`start_breakout`, a viewer who can post. Everyone else sees nothing.

**States.** Nothing on the turn: no line. Open: the line, while the turn is
among the newest three. Accepting: the response card is open in the line's
place, or the launch pane is open, until the merge or the Breakout lands or
the person cancels. Dismissed, accepted or aged out: no line. Offline: the
client shows what it last knew and the socket reconciles.

**Rally's own voice.** Rally does not mention the suggestion in the transcript,
and the suggestion does not enter the model's history. If a person asks Rally
to merge, `conversation_merge` works as it does today.

**Shadow phase.** Nothing above is visible. Decisions are recorded.

## Impact on the product contract

None to the brief. Rally proposes and a person acts, which is the
relationship the merge-back PRD set. This is not a tool confirmation: Rally's
own tool calls run without asking, as the tool execution product policy
requires; the suggestion is about what the person might do next, not about
letting Rally proceed.

One shipped behavior does change: merge-back's composer merge mode is
replaced by the response card for every merge. That PRD is complete and
frozen, so the change is recorded here and, when it ships, in
[`conversation-merge.md`](../../conversation-merge.md), per `prds.md`.

## Decision log

None yet.

## Key design decisions

1. **A JEV Choice question, not a generative judgement and not a confidence
   field on the run's own model.** The retired router's only quality control
   was a self-reported score, and `jev-classifier-opportunities.md` rejects
   "adding a confidence field to a generative call" on that record. JEV returns
   one member of a closed set with a provider-computed confidence in about a
   quarter of a second. Rejected: asking the run's model to end each turn with
   `{ readyToMerge, breakoutWorthy }`, which is the same self-report in a new
   place and costs output tokens on every turn.
2. **Three action-shaped outcomes in one question**: `worth_carrying_up`,
   `side_question_worth_a_breakout`, `continue_here`. Two outcomes that lead to
   the same action are one outcome, so a deliverable, a decision, an answer, a
   milestone and a question for the parent are all `worth_carrying_up` rather
   than five classes; and the merge and breakout boundaries both sit against
   the same purpose, so splitting them into two independent questions would
   lose the shared boundary the way addressing's two-question decomposition
   did. A second Choice in the same request names the kind of thing carried,
   for the sentence alone, and is recorded before it is shown. Rejected: a
   fourth outcome for "settled, nothing worth carrying up", which maps to the
   same no-op today; it is the first ablation to try if the shadow corpus
   shows `continue_here` absorbing settled turns and blurring the merge
   boundary.
3. **Shadow before surface.** A classifier with no corpus is a guess, and the
   corpus here can be built from what Rally retains: every merge names the turn
   it carried, and every Breakout names the turn it was cut from. Running the
   judgement for a few weeks without showing it gives real positives, real
   misses, and the suggestion rate a threshold would produce, before a person
   sees a line. Rejected: shipping a threshold copied from the other two
   classifiers; their 0.5 was measured on their own corpora.
4. **A suggestion is conversation state keyed to a turn, not a message.** One
   row per judged turn in the conversation object, with a status, resolved in
   place. Rejected: a system row in the transcript with structured content,
   the shape merge markers and proposed drafts use. Transcript turns are
   immutable, so a dismissal would be another row; rows accumulate, which is
   the 2026-08-12 failure; every row takes an attention ordinal and lights
   unread; and an older client would draw its fallback text as a system line
   in the feed. Also rejected: the composer's notice slot, which merge mode
   uses for its audience line. The product owner ruled it out: the suggestion
   belongs beside the message it is about, and the composer is for what the
   person is writing.
5. **Visible only on the newest three turns.** A suggestion stays on its turn
   and the feed's recency retires it: three newer messages and it is gone for
   good. That is what keeps a busy conversation from accumulating lines
   without a supersession write, and it matches how people read a thread: the
   newest few turns are what they are looking at. The number is the product
   owner's.
6. **The observer runs in the existing settlement lane**, as a step beside
   naming and the description loop in `settleAgentRun`. That lane is already
   the platform's "something finished, look at the conversation" hook: durable
   on the run row, retried with backoff, recovered by the alarm, and the two
   model calls it already makes are slower than this one. Rejected for now: a
   Queue hop to a Worker consumer that answers back over RPC, which is the
   semantic trigger's shape. It adds a queue, a dispatch branch and a return
   hop for a call the lane already has room for. If settlement latency grows
   past what the description loop costs, the step moves to a Queue and the
   object keeps the slot as the authority, which is the same split the
   semantic trigger made.
7. **The merge draft is the turn's text.** Prefilling the merge composer with
   the judged turn is what the Merge hover action already does, so an accepted
   suggestion costs no model call. Summarize stays phase 2 of merge-back.
8. **The words are drafted by one generative role, gated by the classifier,
   after the chip is already up, and never in shadow.** JEV cannot write
   prose. One `runStructuredInference` role with its own flag writes a merge
   note for the parent's readers or a Breakout's opening prompt and subject,
   and runs only on a confident positive, so its cost scales with positives
   rather than with turns. The chip is written and shown before the draft is
   asked for, and filled when it lands: a chip that appeared four seconds
   after the turn would read as an interruption, while one that appears as
   the turn settles reads as part of it. In shadow the drafter does not run;
   its quality is measured offline against the notes people merged and the
   opening prompts they wrote for the Breakouts they actually started.
   Rejected: opening the card with the turn's raw text and drafting nothing
   for a merge, which saves a call and hands the person a note written for
   this conversation rather than for the parent's readers.
9. **Dismissal is per conversation.** The suggestion is about a shared result.
   The retired router's rule against "workspace-wide suppression on a single
   person's dismissals" was about suppressing future suggestions across a
   workspace, and that is not done here: pacing is per conversation and its
   numbers are the team's.
10. **Merging happens in a response card in the feed, not in the composer.**
    The product owner's call, and it holds for every merge: the composer is
    for what a person is writing to the conversation, and a merge is written
    to the parent. The card is the parent's own merge block made editable,
    so what the person sees is what lands, which merge mode's plain text box
    could not promise. It opens where the merge was asked for, so a person
    merging a turn is looking at that turn while they write. Rejected:
    keeping merge mode for the hover action and the title menu and using the
    card only for suggestions, which is two editors for one write and the
    thing a person would have to learn twice.
11. **Every pacing number is defined open.** A cooldown after a dismissal is a
    limit under `adding-security-defensive-and-other-limits.md`: the mechanism
    is built and tested, the value is `0` until the team sets it from the
    shadow data, and the handover table in [design.md](design.md#limits-handed-back)
    lists each one.

## Data model

One table in the conversation object (`SubstreamAgent`), migration v75 after
`channel_color_revision`: `conversation_suggestions`, one row per judgement
that produced a suggestion, with `kind`, the judged turn and run, `status`
(`open`, `accepted`, `dismissed`, `expired`), a `draft_status`
(`pending`, `ready`, `failed`) with the drafted text and subject, the
decision's choice, confidence and model, and who resolved it. A
unique index allows one row per judged turn. Pacing reads the newest
`dismissed` row per kind. The sketch is in [design.md](design.md#the-suggestion-slot);
the authoritative record is the migration and `data-model.md`.

No D1 change. No WorkspaceDO change. Decisions that produced no suggestion are
recorded where every classifier's are: the `structured_inference` log row and
the inference lakehouse record, through `classifier-diagnostics.ts`.

## Security and trust model

- **A suggestion carries no authority.** Accepting opens a composer. The merge
  goes through the merge route's admission and the Breakout through
  `prepare`/`confirm`, so every check that applies today applies here. The
  client gates the action on what the viewer can do, and the server never
  writes to a parent on a suggestion's behalf.
- **The classifier's state names its fields.** The conversation's purpose,
  the settled turn and the recent messages are separate named fields of the
  JEV `state`, as the semantic trigger separates condition from event. The
  turn is Rally's own output and the messages are people's words; neither is
  interpolated into the question.
- **The drafter reads the transcript as data.** Its prompt is written to
  `writing-prompts.md`: the window goes in a bounded user-role JSON message,
  the draft is for the person to edit, and a draft over the send limit is
  dropped rather than cut.
- **Who can read a suggestion** is who can read the conversation. The slot is
  served by the conversation socket under the same authorization as the
  transcript. No new access source, no new audience.
- **Content leaves the Organization** only as it does for every other model
  call: to TypeSafe for the judgement and to the drafting route for a prompt,
  archived on the access-controlled inference path. Rejections name their
  field through `describeZodIssues` and never echo a turn.

## Agent behavior

No tool changes. Rally gains no tool and loses none; `conversation_merge` is
unchanged and still runs only when a person asks. The suggestion does not
enter the model's history, so the agent does not see it and cannot act on it.
The harness package gains a classifier module beside
`semantic-trigger-gate.ts`, and the API gains a drafting role on the
structured-inference gateway; neither is a tool.

## Rollout

- **Phase 1, shadow.** Ships to every Organization on merge, with nothing a
  person can see: the settlement step, the classifier, the diagnostics role,
  the eval scaffold. No flag, because there is no surface to flag.
- **Phase 2, the surface.** Ships the slot, the socket event under a new
  client contract, the line under the turn, the response card for every
  merge with the composer's merge mode removed, the breakout accept path,
  and the drafting role on its own model flag, `agent-model-breakout-suggestion`, defaulting to
  `OPENROUTER_STRUCTURED_MODEL`. The default for a visible feature is to ship
  to everybody on merge. **This PRD recommends a flag instead**, and records
  that an engineer has to ask for one: `conversationSuggestionsEnabled`,
  default **off**, registered in Ace, because the whole question this feature
  turns on is noise, the predecessor was retired for it, and a staged audience
  is how the first weeks of accept and dismiss rates are read without a
  product-wide retreat. The server-side judgement keeps running everywhere
  whatever the flag says; the flag hides the line.
- **Turning it off.** The flag off hides every suggestion at once; the
  classifier keeps recording. Removing the settlement step is one edit and
  leaves the table in place.
- **Older clients** never receive the socket event or the snapshot field, so
  they show nothing.

## Acceptance

- In a Breakout, Rally's final turn is a finished deliverable: within a few
  seconds the merge line appears under it; pressing it opens the response card
  in its place, prefilled with that turn; merging resolves the line and the
  Thread shows the merge as today.
- The Merge hover action and the title menu's Merge row open the same card,
  under the turn and at the end of the feed; the composer never enters merge
  mode.
- In a Thread, Rally's final turn proposes to work a sub-problem separately:
  the breakout line appears; pressing it opens the launch pane at that turn
  with a drafted prompt; submitting creates the Breakout and resolves the line.
- A turn that is a clarifying question, a partial result, or an
  acknowledgement shows nothing.
- Dismissing hides the line for a second viewer of the same conversation, and
  the next completed run in that conversation may show a new one.
- A viewer who cannot merge or cannot post sees no line.
- The Thread's unread state, Activity tab and notifications are unchanged by a
  suggestion appearing, being dismissed, or being superseded.
- A failing or unreachable TypeSafe leaves settlement, naming and the
  description loop exactly as they are, and the run's terminal state is
  unaffected.
- The chip appears with a skeleton within a second of the turn settling and
  fills a few seconds later; with the drafting route unreachable it stays,
  says so, and its action still works.

## Open questions

- **The wording of the chip.** The placement and shape are settled: a
  suggestion chip under the turn, never in the composer. The titles and
  sentences in the mockups are a draft.
- **Whether a Thread to Channel suggestion is wanted in the first visible
  version.** It is the sparser class and the one whose false positive is
  shown to more people. The recommendation is to run both kinds in shadow and
  decide from the measured rates. Non-goal 3 already rules out the breakout
  kind inside a Breakout.
- **The price list.** The design proposes weights and shows the arithmetic;
  the direction, whether a false suggestion costs more than a missed one, is
  the team's to confirm before the threshold is read off the sweep.
- **The flag.** Shipping phase 2 behind `conversationSuggestionsEnabled` is a
  recommendation that needs an engineer's explicit ask, per `prds.md`.
