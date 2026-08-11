# Work-stream descriptions

A work stream's description is `workstreams.objective`: the one line the sidebar
shows under the title, the text the routing classifier reads when it decides
whether a connector activity belongs here, and the standing context every run
starts from. It is the shortest answer to "what is this work stream for".

It is also, historically, written once and never again. This document owns the
loop that keeps it true, and the rules that stop that loop from making things
worse.

## Why the description goes stale

Almost no description is authored. Creating a work stream from the composer
derives one from the opening message; a work stream expanded from suggested work
gets the suggestion's display prompt; one opened from Slack gets the message
that mentioned Avalon. Each is a reasonable guess at what the work is *about to
be*, made before any of it happened.

Then the work stream is used, and two things drift apart:

- **The description was never good.** It restates a first message —
  "EU cards are failing again" — which describes a moment, not a purpose.
- **The purpose actually changed.** A work stream opened to chase one bug
  becomes where a team runs the whole migration that bug exposed. Nobody renames
  it, because renaming it is nobody's job.

Both leave the same artifact: a list of work streams whose descriptions describe
work that finished.

## The loop

`apps/api/src/services/workstream-description-service.ts` runs after every
terminal run in a work stream, as the last step of `WorkstreamLoopWorkflow`. It
is not on an alarm of its own: a work stream's purpose only moves when something
happens in it, and a finished run is the moment after something did. The step
never throws — a description that could not be re-evaluated is the description
the work stream already had.

Each evaluation reads a window, asks a model one question, and applies the
answer only if every guard agrees.

### The window

**The last 72 hours or the last 200 messages, whichever is bigger**, capped at
600. Both halves matter: a busy work stream that turns over 200 messages in an
afternoon should be judged on all of them, and a quiet one that sees three a day
should be judged on three days rather than on this morning. The risk being
managed is deciding a work stream's purpose from too little of it, so the larger
window always wins.

The cap exists because a single Worker request has to render and send the
window. When it binds, the newest messages are kept and the prompt says so — a
window silently missing its older half reads as a work stream that only ever
discussed today. Tool rows and empty messages are excluded: they are how the
work was done, not what the work stream is for.

### The trigger

The loop runs behind every terminal run, but a run is an *opportunity* to
evaluate, not a reason to. **A timer alone is the wrong trigger** — it spends
inference on work streams where nothing happened, and on active ones it spends
it every few hours forever, because an active work stream always has new
messages. So admission is a conjunction: the work stream has to have **rested**
*and* to have **changed**, and the change has to be in substance.

The gates run cheapest-first, and each is a reason not to read what the next one
needs. Two single-row lookups decide most terminal runs; only a work stream that
has rested and changed pays for the window, and only one that has changed in
substance pays for inference.

**Gate 1 — it has rested.** `rest_until` is a stored instant, so the test is one
comparison. The rest is not a constant: it starts at 6 hours and **doubles with
each consecutive `kept`**, to a ceiling of 48 hours. A description confirmed
three times running is not one a fourth look is likely to change, so the loop
stops paying to hear the same answer — but never stops entirely, because those
confirmations were about a work stream that has since kept moving. A rewrite
returns the rest to the floor and restarts the count: the description was wrong
once, so the work stream is one that moves. A rejection or a model failure
decided nothing and buys no quiet beyond the floor.

**Gate 2 — it has changed, in substance.** Three conditions, all of which must
hold:

| Condition | Floor | Why |
| --- | --- | --- |
| New messages a **person** wrote | 10 | An agent's own turns restate the ask it was given and a system notice is the host talking to itself. Counting them would let one request that provoked a long agent transcript buy a fresh evaluation. |
| — *and a person means an external one too* | | A work stream run from Slack has **no** messages authored by an Avalon account: `createExternalMessage` stores every participant as `author_type = 'system'` carrying an `external_actor_json`. Reading the column alone would file a whole Slack conversation as host notices and exclude all of its people, so the descriptions most in need of this loop would be the only ones it could never reach. The loop classifies a row with an external actor as `external`, counts it as a person, and gives the model the actor's display name. |
| Characters of that new human text | 600 | The difference between a conversation and a row of acknowledgements. |
| Novel subject terms | 5 | The one that matters — see below. |

**The novelty gate is what stops the loop billing an active work stream
forever.** Ten more messages elaborating the subject already named are not
drift, and paying a model to confirm that is the waste this design is most
likely to fall into. Drift, by contrast, is definitionally vocabulary the
description lacks: `countNovelSubjectTerms` counts terms in the new human
messages that appear at least twice, are not ordinary sentence words, and are
absent from both the description and the title. One mention is an aside; a work
stream whose purpose has moved returns to the new subject. Below five such
terms, nothing was discussed that the description does not already cover, and no
model is called.

The gate delays rather than suppresses: as more is said, the novel-term count
grows, so genuine drift clears it on a later run.

The same floors apply to the first evaluation, with the last one treated as
"never, through sequence 0". A work stream that has not yet held a real
conversation keeps whatever description it was created with.

**A person editing the description resets the clock.** They have just answered,
first-hand, the only question an evaluation asks; re-deciding it hours later
spends inference to second-guess the most authoritative statement of intent the
work stream has, and risks reverting it. `WorkstreamService.update` writes a
full rest and records the transcript as read through its current end.

That rest lands **in the same D1 batch as the `objective` write itself**, and
the ordering matters. As two separate statements there is a window between them
in which an evaluation can read the newly edited description, find no rest
recorded yet, claim, and go on to overwrite the text the person just wrote —
and its own guard would not catch that, because the description it read *is*
the one in force. Batching closes the window: an evaluation sees both writes or
neither. An evaluation that claimed *before* the edit is still caught by the
guard, and records `description_changed_during_evaluation`.

`workstream_description_refreshes` holds one row per work stream. `rest_until`
is pushed forward **before** the model call, not after: that is what stops two
runs terminalizing together from both spending a window, and what stops a model
that is failing from being retried by every run behind it. A failed evaluation
therefore costs one window and waits for the next.

### What is out of scope

- **Automation work streams.** Their description belongs to the saved
  automation configuration that generated them; rewriting it here would put this
  loop in an argument with the automation that owns it.
- **Archived work streams.** Nothing is reading them.

## Keeping the description specific

The prompt's judgment is in
`packages/agent-harness/src/prompts/workstream-description.ts`. Two failure
modes are worse than a stale description, and neither is left to prose alone.

**Generalization.** A model asked repeatedly to describe a varied transcript
drifts toward "general discussion", which is true of every work stream and
therefore useless in the one place descriptions are read — a list of them. The
prompt bans widening into a category, and `isTooGenericDescription` refuses the
attractors outright. A transcript with no single purpose visible in it is a
*keep*, never a reason to reach for a catch-all.

**Churn.** Past the admission gates above, a rewrite still has to clear three
independent bars — the model choosing `rewrite`, a confidence of at least 0.8,
and a proposal that survives the guards. The prompt asks for the smallest edit that makes the description true,
reusing the saved wording wherever it is still accurate, so a rewrite reads as a
correction rather than a replacement. Where both decisions could apply, the
prompt says keep.

The guards, all deterministic, so a refusal is explainable without re-reading
the transcript:

| Code | Refuses |
| --- | --- |
| `description_too_generic` | A catch-all that would fit any work stream |
| `description_too_short` | Under 16 characters or 3 words — too little to name a subject |
| `description_too_long` | Over 280 characters; that is a summary, and it belongs in the transcript |
| `empty_description` | A `rewrite` decision carrying nothing |
| `description_changed_during_evaluation` | A description a person edited while the model was thinking |

That last one is the important one. The update is guarded on the exact
description the evaluation read, so a person who retitled the work stream mid-
evaluation wins: theirs is the more recent statement of intent, and silently
overwriting it is the one outcome that would make this loop untrustworthy.

## Who wrote the description

`workstreams.description_source` records whether a person wrote the description
in force (`authored`) or it was derived (`derived`).

**It is the caller's explicit assertion, never inferred from whether an
objective was supplied.** Those are different claims: a supplied objective means
the caller had one, which is true of every machine-derived path — a Slack
mention slices its own prompt into the field. Inferring authorship from presence
would mark a copied-in first message as authored and tell the loop to protect
exactly the descriptions it exists to fix, and it would do so inconsistently:
the same Slack message creates an `authored` work stream through the linked
identity path and a `derived` one through the unlinked path beside it.

So `authored` is set in exactly two places — the API handler for a person
creating a work stream with an objective they typed, and a work-stream update
that changes the description — and every other path takes the `derived` default.
The loop sets it back to `derived` whenever it rewrites.

A resubmitted, byte-identical description is not an authorship event and is
ignored, so a no-op `PATCH` cannot flip the provenance or disturb the rest.

The model is told which it is looking at, and told to prefer keeping an authored
description unless the transcript contradicts it outright. Without the column
both look identical by the time the loop reads them, and a line someone wrote
deliberately would be as easy to overwrite as a first message that got copied
into the field.

Migration `0057` backfills `authored` for the ad-hoc work streams that can still
be shown to have been authored: those whose description is not simply their
opening message. It runs once and cannot be re-run, so it also excludes the two
shapes where "differs from the opening message" is not evidence of a person — an
attachment-only work stream carrying the literal `Review the attached files`
fallback, and a Slack mention past the objective's 4,000-character limit, whose
description is that message truncated rather than a different text.

## What is recorded

Every evaluation closes its claim with what it decided, including the common
case. A `kept` row is deliberately stored: knowing the loop looked and left the
description alone is what separates a description that still fits from one
nothing has examined. Rows carry the decision, the rejection code where there is
one, the model, the confidence, the description before and after, and the
model's reasoning, so an automatic rewrite can be explained to whoever notices
it.

A person's own edit is recorded as `authored`, **not** as `kept` — the loop did
not look, and this row is the only place that distinction survives. It clears
every field an evaluation would have filled, including `rejection_code`, which
the table's `CHECK` requires to be null for any decision but `rejected` or
`failed`; a decision written over a failed evaluation without clearing it would
fail the constraint and take the person's edit down with it.

`description` always means *what is in force after this row was written*. On a
`description_changed_during_evaluation` refusal that is the other writer's text,
so it is re-read rather than recorded as the superseded value the evaluation
happened to have in hand.

Four log events are emitted:

| Event | Means |
| --- | --- |
| `workstream_description_rewritten` | A description was replaced. |
| `workstream_description_rewrite_rejected` | A proposal was refused by a guard. A run of these on one `rejection_code` is the signal that either the guard or the model's routing needs attention. |
| `workstream_description_change_below_threshold` | Every gate cleared except novelty. Carries the novel-term count, which is the only source of data for tuning that threshold: a rewrite the loop is deferring shows up as a run of these on one work stream, with the count sitting just below the floor. |
| `workstream_description_outcome_superseded` | An evaluation finished after a person had edited the description, so its decision was discarded. Carries the decision it would have written. |

A skipped evaluation writes nothing. That is deliberate — most terminal runs
skip, and recording each would cost a write to say a work stream was quiet — but
it means the reason a description has not been re-read is derived rather than
stored: `rest_until` says whether the clock allowed it, and the transcript past
`evaluated_through_sequence` says whether anything had changed.

## Changing any of this

- The constants — window, cap, throttle, floors, confidence — are exported from
  the service and asserted against in
  `apps/api/test/workstream-description-refresh.test.ts`. Change the constant,
  not the assertion's literal.
- The prompt is byte-stable and golden-hashed; read
  [`writing-prompts.md`](writing-prompts.md) before editing it, and update the
  hash deliberately.
- The model this loop runs on is a flag, not a deploy. See
  [`FEATURE_FLAGS.md`](FEATURE_FLAGS.md).

## See also

- [`DATA_MODEL.md`](DATA_MODEL.md) — `workstreams` and
  `workstream_description_refreshes`.
- [`AGENT_HARNESS.md`](AGENT_HARNESS.md) — the run this loop rides behind.
- [`writing-prompts.md`](writing-prompts.md) — how the classifier prompt is
  written and tested.
