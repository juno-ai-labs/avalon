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

### The throttle

Two conditions gate an evaluation, and both must hold:

| Gate | Value | Why |
| --- | --- | --- |
| Time since the last evaluation | 6 hours | A description that moves faster than a person checks in is one nobody can rely on. |
| New messages since the last evaluation | 15 | Below this the window is substantially the one that produced the current description, so the model would re-decide the same question at the same cost. |

The same floors apply to the first evaluation, with the last evaluation treated
as "never, through sequence 0". A work stream that has not yet seen 15 messages
keeps whatever description it was created with.

`workstream_description_refreshes` holds one row per work stream. Its
`evaluated_at` is stamped **before** the model call, not after: that is what
stops two runs terminalizing together from both spending a window, and what
stops a model that is failing from being retried by every run behind it. A
failed evaluation therefore costs one window and waits for the next.

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

**Churn.** A rewrite has to clear three independent bars — the model choosing
`rewrite`, a confidence of at least 0.8, and a proposal that survives the
guards. The prompt asks for the smallest edit that makes the description true,
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
in force (`authored`) or it was derived (`derived`). It is set to `authored`
only where a person supplied the text — an explicit objective at creation, or an
objective in a work-stream update — and back to `derived` whenever this loop
rewrites it. Every other creation path derives.

The model is told which it is looking at, and told to prefer keeping an authored
description unless the transcript contradicts it outright. Without the column
both look identical by the time the loop reads them, and a line someone wrote
deliberately would be as easy to overwrite as a first message that got copied
into the field.

Migration `0057` backfills `authored` for the ad-hoc work streams that can still
be shown to have been authored: those whose description is not simply their
opening message.

## What is recorded

Every evaluation closes its claim with what it decided, including the common
case. A `kept` row is deliberately stored: knowing the loop looked and left the
description alone is what separates a description that still fits from one
nothing has examined. Rows carry the decision, the rejection code where there is
one, the model, the confidence, the description before and after, and the
model's reasoning, so an automatic rewrite can be explained to whoever notices
it.

Two log events are emitted: `workstream_description_rewritten` and
`workstream_description_rejected`. A run of the second on one rejection code is
the signal that either a guard or the model's routing needs attention.

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
