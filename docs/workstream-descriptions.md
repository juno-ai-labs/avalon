# Work-stream descriptions

A work stream's description is its Channel parent's `description`, read from
its `channels` row in `WorkspaceDO` (the desktop directory model still
exposes the value through its `objective` field):
searchable directory context, the text the routing classifier reads when it decides
whether a connector activity belongs here, and the standing context every run
starts from. It is the shortest answer to "what is this work stream for".

It is also, historically, written once and never again. This document owns the loop
that keeps it true, and — the larger half — the rules that stop that loop from
making things worse: from generalizing a description into a catch-all, from
overwriting what a person deliberately wrote, and from billing an active work
stream forever.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/workstream-description-service.ts` | The whole loop: the window, every gate, the claim, the guards, and every exported constant. |
| `packages/agent-harness/src/prompts/workstream-description.ts` | The prompt and its judgment. Byte-stable and golden-hashed. |
| `apps/api/src/durable-objects/substream-agent.ts` — run settlement | Where an evaluation is triggered from. |
| `apps/api/src/durable-objects/workstream-object-product.ts` — `update` | The authored-edit path that marks a person's description `authored`. |
| `apps/desktop/src/renderer/lib/api.ts` (`mapWorkstreamSummary`) | Maps every workspace-socket Channel row onto the directory model's `objective` alias. |
| `apps/desktop/src/renderer/screens/channel.tsx` (`ThreadCard`) | Shows the description as a thread's one-to-two-line summary in its Channel's feed. Sidebar rows and hover cards do not display descriptions. |
| `packages/db/migrations/0058_workstream_description_refresh.sql` | The refresh table and the one-time `description_source` backfill. |
| `apps/api/test/workstream-description-refresh.test.ts` | Asserts against the exported constants. |

### Why the description goes stale

Almost no description is authored. Creating a work stream from the composer derives
one from the opening message; a work stream expanded from suggested work gets the
suggestion's display prompt; one opened from Slack gets the message that mentioned
Rally. Each is a reasonable guess at what the work is *about to be*, made before
any of it happened.

Derived means derived, not copied: `provisionalWorkstreamDescription` takes the
opening *line* and bounds it at `WORKSTREAM_DESCRIPTION_MAX_CHARACTERS`. A
message may run to `MESSAGE_MAX_CHARACTERS`, and a description is not a place to
put one — it is stored in every workspace directory row, pushed to every client
on connect, read by the routing classifier, and held in a column that CHECKs
4,000. The message itself is not shortened anywhere; it is the work stream's
first message, stored whole.

### The first summary

That first line is a stand-in, and for a long request a poor one: it is how the
work was asked for, not what it is, and a Channel's feed shows it under the
thread's name. So the first naming pass
([`workstream-naming.md`](workstream-naming.md)) asks for a summary in the same
model call as the name and icon, and puts it in place of the derived line:
one or two plain sentences, at most `MAXIMUM_DESCRIPTION_CHARACTERS`, keeping
the people, documents and constraints the request names. A request that is
already that short comes back as written, and nothing is stored.

- **Only a derived description is summarized.** The creation service passes
  `provisionalDescription` to `nameWorkstream` only when the description's
  source is `derived`; one a person wrote is theirs.
- **The write is `redescribe`, the loop's own compare-and-swap,** guarded on the
  derived line. A person, or the loop, who replaced it while the model was
  answering wins. It commits the directory projection, so the feed moves to the
  summary without an event of its own.
- **A summary that fails is no summary.** Missing, empty, or over the limit,
  it is dropped and the derived line stands; the name and icon do not depend
  on it. Over the limit is dropped rather than cut, because a summary cut
  mid-sentence reads worse than the request.
- **Composer threads, Slack-opened threads and every new Breakout ask.**
- **Every Breakout keeps a description, even though no surface shows one
  yet.** One opened without a message is provisioned with an empty one, and
  the loop below only reads Main, so a Breakout's run settlement writes one
  from its first message while it is still empty.
- **Existing threads and Breakouts are backfilled** by the
  `description_summary` job; see `thread-backfill.md` (retired).

Then the work stream is used, and two things drift apart:

- **The purpose actually changed.** A work stream opened to chase one bug becomes
  where a team runs the whole migration that bug exposed. Nobody renames it, because
  renaming it is nobody's job.

Both leave the same artifact: a list of work streams whose descriptions describe
work that finished.

### The loop

The service runs after every terminal run in a work stream, as the last step of
the SubstreamAgent's run settlement. It is not on an alarm of its own: a work stream's purpose
only moves when something happens in it, and a finished run is the moment after
something did. The step never throws — a description that could not be re-evaluated
is the description the work stream already had.

Each evaluation reads a window, asks a model one question, and applies the answer
only if every guard agrees.

### The window

**The last 72 hours or the last 200 messages, whichever is bigger**, capped at 600.
Both halves matter: a busy work stream that turns over 200 messages in an afternoon
should be judged on all of them, and a quiet one that sees three a day should be
judged on three days rather than on this morning. The risk being managed is
deciding a work stream's purpose from too little of it, so the larger window always
wins.

The cap exists because a single Worker request has to render and send the window.
When it binds, the newest messages are kept and the prompt says so — a window
silently missing its older half reads as a work stream that only ever discussed
today. Tool rows and empty messages are excluded: they are how the work was done,
not what the work stream is for.

### The trigger

The loop runs behind every terminal run, but a run is an *opportunity* to evaluate,
not a reason to. **A timer alone is the wrong trigger** — it spends inference on
work streams where nothing happened, and on active ones it spends it every few
hours forever, because an active work stream always has new messages. So admission
is a conjunction: the work stream has to have **rested** *and* to have **changed**,
and the change has to be in substance.

The gates run cheapest-first, and each is a reason not to read what the next one
needs. Two single-row lookups decide most terminal runs; only a work stream that
has rested and changed pays for the window, and only one that has changed in
substance pays for inference.

**Gate 1 — it has rested.** `rest_until` is a stored instant, so the test is one
comparison. The rest is not a constant: it starts at 6 hours and **doubles with
each consecutive `kept`**, to a ceiling of 48 hours. A description confirmed three
times running is not one a fourth look is likely to change, so the loop stops
paying to hear the same answer — but never stops entirely, because those
confirmations were about a work stream that has since kept moving. A rewrite
returns the rest to the floor and restarts the count: the description was wrong
once, so the work stream is one that moves. A rejection or a model failure decided
nothing and buys no quiet beyond the floor.

**Gate 2 — it has changed, in substance.** Three conditions, all of which must
hold:

| Condition | Floor | Why |
| --- | --- | --- |
| New messages a **person** wrote | 10 | An agent's own turns restate the ask it was given and a system notice is the host talking to itself. Counting them would let one request that provoked a long agent transcript buy a fresh evaluation. |
| — *and a person means an external one too* | | A work stream run from Slack has **no** messages authored by a Rally account: `createExternalMessage` stores every participant as `author_type = 'system'` carrying an `external_actor_json`. Reading the column alone would file a whole Slack conversation as host notices and exclude all of its people, so the descriptions most in need of this loop would be the only ones it could never reach. The loop classifies a row with an external actor as `external`, counts it as a person, and gives the model the actor's display name. |
| Characters of that new human text | 600 | The difference between a conversation and a row of acknowledgements. |
| Novel subject terms | 5 | The one that matters — see below. |

**The novelty gate is what stops the loop billing an active work stream forever.**
Ten more messages elaborating the subject already named are not drift, and paying a
model to confirm that is the waste this design is most likely to fall into. Drift,
by contrast, is definitionally vocabulary the description lacks:
`countNovelSubjectTerms` counts terms in the new human messages that appear at
least twice, are not ordinary sentence words, and are absent from both the
description and the title. One mention is an aside; a work stream whose purpose has
moved returns to the new subject. Below five such terms, nothing was discussed that
the description does not already cover, and no model is called.

The gate delays rather than suppresses: as more is said, the novel-term count
grows, so genuine drift clears it on a later run.

The same floors apply to the first evaluation, with the last one treated as "never,
through sequence 0". A work stream that has not yet held a real conversation keeps
whatever description it was created with.

### A person's edit resets the clock

They have just answered, first-hand, the only question an evaluation asks;
re-deciding it hours later spends inference to second-guess the most authoritative
statement of intent the work stream has, and risks reverting it.
`WorkstreamService.update` writes a full rest and records the transcript as read
through its current end.

That rest lands **in the same object-local transaction as the `description`
write itself**, and the
ordering matters. As two separate statements there is a window between them in
which an evaluation can read the newly edited description, find no rest recorded
yet, claim, and go on to overwrite the text the person just wrote — and its own
guard would not catch that, because the description it read *is* the one in force.
Batching closes the window: an evaluation sees both writes or neither. An
evaluation that claimed *before* the edit is still caught by the guard, and records
`description_changed_during_evaluation`.

### Keeping the description specific

The prompt's judgment is in `packages/agent-harness/src/prompts/workstream-description.ts`.
Two failure modes are worse than a stale description, and neither is left to prose
alone.

**Generalization.** A model asked repeatedly to describe a varied transcript drifts
toward "general discussion", which is true of every work stream and therefore
useless in the one place descriptions are read — a list of them. The prompt bans
widening into a category, and `isTooGenericDescription` refuses the attractors
outright. A transcript with no single purpose visible in it is a *keep*, never a
reason to reach for a catch-all.

**Churn.** Past the admission gates above, a rewrite still has to clear three
independent bars — the model choosing `rewrite`, a confidence of at least 0.8, and
a proposal that survives the guards. The prompt asks for the smallest edit that
makes the description true, reusing the saved wording wherever it is still
accurate, so a rewrite reads as a correction rather than a replacement. Where both
decisions could apply, the prompt says keep.

### Who wrote the description

`workstreams.description_source` records whether a person wrote the description in
force (`authored`) or it was derived (`derived`).

**It is the caller's explicit assertion, never inferred from whether an objective
was supplied.** Those are different claims: a supplied objective means the caller
had one, which is true of every machine-derived path — a Slack mention slices its
own prompt into the field. Inferring authorship from presence would mark a
copied-in first message as authored and tell the loop to protect exactly the
descriptions it exists to fix, and it would do so inconsistently: the same Slack
message creates an `authored` work stream through the linked identity path and a
`derived` one through the unlinked path beside it.

So `authored` is set in exactly two places — the API handler for a person creating
a work stream with an objective they typed, and a work-stream update that changes
the description — and every other path takes the `derived` default. The loop sets
it back to `derived` whenever it rewrites.

A resubmitted, byte-identical description is not an authorship event and is
ignored, so a no-op `PATCH` cannot flip the provenance or disturb the rest.

The model is told which it is looking at, and told to prefer keeping an authored
description unless the transcript contradicts it outright. Without the column both
look identical by the time the loop reads them, and a line someone wrote
deliberately would be as easy to overwrite as a first message that got copied into
the field.

Migration `0058` backfills `authored` for the ad-hoc work streams that can still be
shown to have been authored: those whose description is not simply their opening
message. It runs once and cannot be re-run, so it also excludes the two shapes
where "differs from the opening message" is not evidence of a person — an
attachment-only work stream carrying the literal `Review the attached files`
fallback, and a Slack mention past the objective's 4,000-character limit, whose
description is that message truncated rather than a different text.

### What is recorded

Every evaluation closes its claim with what it decided, including the common case.
A `kept` row is deliberately stored: knowing the loop looked and left the
description alone is what separates a description that still fits from one nothing
has examined. Rows carry the decision, the rejection code where there is one, the
model, the confidence, the description before and after, and the model's reasoning,
so an automatic rewrite can be explained to whoever notices it.

A person's own edit is recorded as `authored`, **not** as `kept` — the loop did not
look, and this row is the only place that distinction survives. It clears every
field an evaluation would have filled, including `rejection_code`, which the table's
`CHECK` requires to be null for any decision but `rejected` or `failed`; a decision
written over a failed evaluation without clearing it would fail the constraint and
take the person's edit down with it.

`description` always means *what is in force after this row was written*. On a
`description_changed_during_evaluation` refusal that is the other writer's text, so
it is re-read rather than recorded as the superseded value the evaluation happened
to have in hand.

## Invariants

- **`rest_until` is pushed forward before the model call, not after.** That is what
  stops two runs terminalizing together from both spending a window, and what stops
  a model that is failing from being retried by every run behind it. It is both the
  admission clock and the single-writer claim.
- **A person's edit and the rest it buys land in one local transaction.** Split them and an
  evaluation can read the new description, find no rest, claim, and overwrite it —
  with its own guard blind to the problem, because the description it read is the
  one in force.
- **A rewrite is guarded on the exact description the evaluation read.** A person
  who retitled the work stream mid-evaluation wins: theirs is the more recent
  statement of intent, and silently overwriting it is the one outcome that would
  make this loop untrustworthy.
- **`description_source` is asserted by the caller, never inferred from whether an
  objective was supplied.** Inference marks copied-in first messages as authored and
  protects exactly the descriptions this loop exists to fix.
- **A transcript with no single purpose visible in it is a `keep`.** It is never a
  reason to reach for a catch-all; the generic attractors are refused outright.
- **A person counts as a person even when they are external.** A Slack-driven work
  stream has no Rally-authored rows at all, so reading `author_type` alone excludes
  every person in it.
- **The step never throws.** A description that could not be re-evaluated is the
  description the work stream already had.
- **An evaluation closes its claim with a row, including when it kept.** A decision
  written over a failed evaluation clears `rejection_code`, or the table's `CHECK`
  rejects it and takes the write down with it.

## Boundary

This module owns one question — is `workstreams.objective` still true — and the
loop that asks it. It does not own the title — `title_status` and the naming agent
are a separate pass, and [`workstream-naming.md`](workstream-naming.md) owns
them — it does not own automation-generated descriptions, and it does not own the
run it rides behind.

| For | Read |
| --- | --- |
| `workstreams` and `workstream_description_refreshes` | [`data-model.md`](data-model.md) |
| The run this loop is the last step of | [`agent-harness.md`](agent-harness.md) |
| How the classifier prompt is written and tested | [`writing-prompts.md`](writing-prompts.md) |
| The model this loop runs on — a flag, not a deploy | [`feature-flags.md`](feature-flags.md) |
| Where a derived description comes from at creation | [`workstream-creation.md`](workstream-creation.md) |

Out of scope, deliberately:

- **Automation work streams.** Their description belongs to the saved automation
  configuration that generated them; rewriting it here would put this loop in an
  argument with the automation that owns it.
- **Archived work streams.** Nothing is reading them.

## Failure modes and limits

The guards, all deterministic, so a refusal is explainable without re-reading the
transcript:

| Code | Refuses |
| --- | --- |
| `description_too_generic` | A catch-all that would fit any work stream |
| `description_too_short` | Under 16 characters or 3 words — too little to name a subject |
| `description_too_long` | Over 280 characters; that is a summary, and it belongs in the transcript |
| `empty_description` | A `rewrite` decision carrying nothing |
| `description_changed_during_evaluation` | A description a person edited while the model was thinking |

- **A failed evaluation costs one window and waits for the next.** The claim was
  taken before the call, so nothing behind it retries immediately.
- **The window is capped at 600 messages.** Past that the oldest are dropped and the
  prompt says so.
- **A skipped evaluation writes nothing.** That is deliberate — most terminal runs
  skip, and recording each would cost a write to say a work stream was quiet — but
  it means the reason a description has not been re-read is derived rather than
  stored: `rest_until` says whether the clock allowed it, and the transcript past
  `evaluated_through_sequence` says whether anything had changed.
- **The rest ceiling is 48 hours**, from a 6-hour floor, doubling per consecutive
  `kept`. A quiet-but-moving work stream is still re-read every two days.

## Testing

`apps/api/test/workstream-description-refresh.test.ts` is the suite. The constants —
window, cap, throttle, floors, confidence — are **exported from the service and
asserted against**. Change the constant, not the assertion's literal; a test
carrying its own copy of a threshold stops testing the loop and starts testing
itself.

Run it with
`pnpm --filter @rally/api exec vitest run test/workstream-description-refresh.test.ts`
— the path is package-relative.

Two traps. The prompt is byte-stable and golden-hashed, so an edit fails the hash
assertion by design; read [`writing-prompts.md`](writing-prompts.md) and update the
hash deliberately rather than regenerating it. And every gate here is a comparison
against a stored instant or a sequence number — stub the clock and assert on the
stored `rest_until` and `evaluated_through_sequence`, not on elapsed time.

## Operations

Five log events are emitted:

| Event | Means |
| --- | --- |
| `workstream_description_rewritten` | A description was replaced. |
| `workstream_description_rewrite_rejected` | A proposal was refused by a guard. A run of these on one `rejection_code` is the signal that either the guard or the model's routing needs attention. |
| `workstream_description_change_below_threshold` | Every gate cleared except novelty. Carries the novel-term count, which is the only source of data for tuning that threshold: a rewrite the loop is deferring shows up as a run of these on one work stream, with the count sitting just below the floor. |
| `workstream_description_summarized` | The first naming pass offered a summary. `outcome` is `applied`, or `superseded` when the derived line had already been replaced. |
| `workstream_description_outcome_superseded` | An evaluation finished after a person had edited the description, so its decision was discarded. Carries the decision it would have written. |

### 2026-10-12 — The first naming pass summarizes the request

**What changed:** A thread started from the composer gets its description
replaced by a one-to-two-sentence summary of the request, written by the
first naming pass in the call it already makes. See
[The first summary](#the-first-summary).

**Why:** The Channel feed now shows the description under each thread's name,
and the product owner asked whether it was a summary. It was not: the
derived first line was the only description most threads ever had, because
the loop below only rewrites after ten messages and real drift, which a
typical thread never reaches.

**Considered and rejected:** Letting this loop make its first pass without
its volume gates. That is a second model call per thread, after the first
run rather than a moment after creation, and it asks a judgment model
built to say "keep" to write from scratch.

**Consequences:** The description every run starts from is now a model's
summary rather than the person's first line. The opening message is still
the first message, stored whole, so no run loses the request. The summary is
`derived`, so this loop may still rewrite it later.

### 2026-09-04 — Keep descriptions as context, not navigation copy

Global navigation now shows titles only, with a timestamp only when unread.
Descriptions remain searchable and retain their routing/context role. Removing
their display is not permission to delete the authoritative description loop.

### 2026-08-26 — Socket hand-offs do not erase the sidebar description

**What changed:** Both control-socket snapshot readers now map the authoritative
WorkstreamDO `description` into the desktop directory model's `objective` alias.
The sidebar also refuses to replace a known description with an empty legacy
projection while workspace and direct sockets are handing authority over.

**Why:** The ordered-transcript migration moved work-stream reads to the direct
socket, but only the workspace-feed reader populated `objective`. Opening a work
stream could therefore replace the sidebar row with a structurally newer row
whose description was missing, leaving the selected item title-only.

**Consequences:** Every new snapshot source must preserve description identity
even if its wire name differs from the desktop alias. Empty compatibility data
may not erase a description already supplied by an authoritative source.

### 2026-08-24 — The provisional description is the opening line

**What changed:** `provisionalWorkstreamDescription` lives here and is what the
composer create and both Slack create paths derive a description with: the first
non-empty line of the opening message, bounded at
`WORKSTREAM_DESCRIPTION_MAX_CHARACTERS`. The composer path previously used the
whole trimmed message; the Slack paths used `prompt.slice(0, 4_000)`, which was
right in size and wrong at a surrogate pair.

**Why:** Raising the message ceiling to `MESSAGE_MAX_CHARACTERS` (100,000) forced
the question this module had never had to answer, because at 4,000 the message
*was* a plausible description. It is not one at 100,000. Three choices existed
and only one of them keeps both fields honest:

- Let the description inherit the message's ceiling. Rejected: it widens the
  `workspace_workstream_directory` column CHECK, the producer bound in
  `workstream-regional-effect.ts`, and every directory push and classifier input
  along with it — a cost paid on reads that have nothing to do with the work
  stream being described.
- Truncate the whole message to 4,000. Rejected: it is the same copy, cut
  mid-sentence, and it makes the description longer and less useful than the loop
  below will ever write.
- Take the opening line. Chosen: it is what the person is asking for, the
  paragraphs under it are how, and this value is replaced by the loop below after
  the first run anyway.

**Consequences:** A multi-line create now opens with a shorter description than
it used to — its first line rather than its whole message. That is a visible
change to every work stream started from a multi-paragraph message, and it is
the intended one. The bound stays the storage ceiling rather than
`MAXIMUM_DESCRIPTION_CHARACTERS`: this value is the fallback that stands when
naming and this loop both fail, and cutting a person's own first line to 280
would be inventing a summary rather than deriving one.

### 2026-08-23 — A proposed description is repaired before it is judged

**What changed:** `judgeDescriptionProposal` runs the proposal through
`normalizeModelText` before the length, genericness and divergence rules see it.

**Why:** A description is shown as plain text in the sidebar and the header, so a
model writing `$\rightarrow$` in one puts TeX where nothing will ever render it.
Repairing before the rules rather than after means every bound is measured
against the sentence a reader gets: the delimiters and command name would
otherwise count toward the character ceiling, and the normalized comparison used
to detect a restyling would differ from the stored text for no real reason.

**Consequences:** The plain-text entry point is the correct one here and the
Markdown one would be a bug — it escapes what it unwraps, which on this surface
is a backslash a reader sees. [`model-text-normalization.md`](model-text-normalization.md)
states that rule.

### 2026-08-17 — Description refresh shares the WorkstreamDO transaction

**What changed:** The description and `description_refresh_state` are now
mutated in one transaction in the owning object.

**Why:** The refresh lease and the product field it protects must have one
linearization point after the work-stream authority cutover.

**Considered and rejected:** Leaving the refresh row in D1 and coordinating it
with the local description through retries; that permits an automatic rewrite
to race and overwrite a person's edit.

**Consequences:** Existing refresh logic keeps its guards and rest windows, but
all reads and conditional writes use object-local SQL.
