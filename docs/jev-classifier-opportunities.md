# Where else JEV belongs

A register of decisions in this tree that a JEV request could make, or makes
badly today. [`jev-best-practices.md`](jev-best-practices.md) owns how to design
and evaluate such a request; [`agent-harness.md`](agent-harness.md) owns the one
that ships. This file is neither: it is the list of the next ones, with the
contract each would need and the evidence it would have to produce first.

An entry is deleted when its classifier ships, and the reasoning that made it
worth shipping is recorded in the changelog of the document that owns the
mechanism, not here. An entry is also deleted when the team decides against it,
with the argument moved into the "Considered and rejected" section below so the
next reader does not re-propose it.

## The test each entry answered

A decision belongs here when all five are true. The first two come straight from
[the decision contract](jev-best-practices.md#start-with-the-decision-contract);
the last three are what makes a *replacement* worth its cost rather than just a
plausible fit.

1. **One bounded question.** The answer is a member of a closed set, or one
   genuine scalar. Not a paragraph, not a plan, not a list of objects.
2. **Operationally distinct outcomes.** Each answer leads to a different action,
   and the cost of confusing two of them is writable in a sentence.
3. **The state is nameable.** The evidence fits in a small object of stable
   semantic fields the application already has, without an unbounded graph walk.
4. **Something is wrong with the current path.** It spends a large generative
   call on a coarse gate, it has no confidence signal at all, it reads a
   self-reported one, or the decision is not being made at all.
5. **There is a way to be wrong that we would notice.** A corpus exists, or can
   be built from data we already retain, that could disagree with the shipped
   behavior.

A decision that fails (3) is not a JEV decision. A decision that fails (4) is
working; leave it alone. A decision that fails (5) can still be built, but the
first version is a guess and must be reversible, and the entry has to say so.

## What the tree has today

One JEV call, and it is the only one: message addressing, at
`packages/agent-harness/src/index.ts:2174`, reached from
`apps/api/src/services/integrations.ts:1618`. Every other model-backed decision
in production runs through `runStructuredInference`. Six declared roles use it
(`AGENT_MODEL_ROLES`: the harness loop, its inline children, work-stream naming,
work-opportunity admission, work-opportunity ranking, work-stream description),
plus two callers riding them: substream context summary and attachment summary.
Of those eight, one contains two bounded decisions wrapped inside a generative
answer, and the rest are writing tasks with nothing closed-set about them.

The more interesting population is not in that list at all: decisions that were
*declined* rather than implemented, because the only tool available was a
generative call whose self-reported confidence nobody trusted. Two are recorded
in this tree in close to those words. One is entry 4 below. The other is the
retired contextual-routing gate, whose post-mortem says its only quality control
was "a constant compared against a number the model made up about its own
answer" ([`contextual-routing.md`](contextual-routing.md), 2026-08-12); that
feature is gone, but the criticism is the distinction JEV exists to make, and it
is quoted again in the rejected section below.

## The primitive that has to exist first

Everything TypeSafe-shaped is currently inside one function written for one
question. `TYPESAFE_SYSTEMONE_URL` (`index.ts:1979`), the response schema
(`:1993`), the question document (`:2014`), the owned deadline, the failure-kind
classifier (`:2305`), the diagnostic envelope and the confidence comparison all
sit in or beside `classifyAddressingWithTypeSafe`. A second classifier written
the way the first one was is roughly 130 lines of copied transport, and the
copies diverge in exactly the way
[`jev-best-practices.md`](jev-best-practices.md#calibrate-confidence-as-an-operational-signal)
warns about: "Avoid `>=` in one service and `>` in another."

So the first change is not a classifier. It is two primitives, and neither has a
product decision inside it:

- **A JEV request.** Takes a `state` object, a questions document, a model
  alias, an owned deadline and a diagnostic sink; returns the typed answers with
  their confidences and probabilities, or throws a named failure. It owns the
  URL, the transport, the envelope schema, the field-named schema rejection
  (per [`naming-a-schema-failure.md`](naming-a-schema-failure.md)) and the
  distinction between caller cancellation and its own deadline. It knows nothing
  about addressing. Choice and Noul are both answer shapes it can return; the
  shipped response schema only models Choice because that is all addressing
  asked for.
- **A confidence cascade.** Takes a primary stage, a threshold, a fallback stage
  and a terminal local floor, and returns which stage answered along with the
  answer. Addressing's cascade is the shape: accept above the threshold, fall
  back on low confidence *and* on failure, and never let remote availability
  decide whether the product keeps the user's input. Today that control flow is
  inlined in `classifyAddressing` and would be copied verbatim by the second
  caller.

Both are the Lego-block shape [`AGENTS.md`](../AGENTS.md#how-we-build) asks
for: addressing
becomes a state shape plus a questions document plus a mapping, and so does
every entry below. Extracting them with addressing as the only caller is a
refactor with a behavior-preserving test, and it is the cheapest possible first
step in this whole file. Do it before the second classifier, not after the
third.

## Candidates

### 1. A Sidekick's semantic trigger condition, which is not evaluated at all

**Severity: this one is a defect, not an improvement.**

**Observed.** `semantic_activity` is a first-class trigger type. Its schema
(`packages/contracts/src/index.ts:1081`) requires a non-empty plain-language
`condition`, and two of the draft's six readiness refinements exist to make a
ready one well-formed (a concrete connector type, exactly one declared event
type in the prefilter); the harness tool description
tells the authoring model to "write it so it can be judged from the event alone"
(`packages/agent-harness/src/index.ts:2470`); the compiler carries it into the
stored definition (`:2982`); the desktop client's `triggerSummary`
returns it verbatim as the trigger's one-line description on the card a person
approves (`apps/desktop/src/renderer/lib/api.ts:454`); and a prompt for
judging it exists, complete with an untrusted-evidence rule and a 0.8 confidence
floor, at `packages/agent-harness/src/prompts/semantic-trigger.ts`.

Nothing evaluates it. The prompt renderer has no caller outside
`prompts.test.ts`. The runtime match is
`evaluateExternalEventPredicate` (`apps/api/src/services/external-event-evaluator.ts:26`,
called once, at `apps/api/src/durable-objects/workspace-do.ts:5306`), whose own
docstring says it "never calls a provider or model", and the registration row it
reads carries a single `when` predicate
(`packages/contracts/src/automation-evaluators.ts:205`) with nowhere for a
condition to live.

**What that means for a member.** A Sidekick whose trigger reads "the changed
file is a customer contract" (the phrasing used in
`packages/agent-harness/src/index.test.ts:6591`) fires on *every* Drive change
event the deterministic prefilter admits. The condition is the sentence the
approval card shows in the place where a trigger says what starts a run. Rally is
promising a semantic filter, storing it, displaying it, and ignoring it. Whether
any member has one today is not knowable from the repository; the authoring
agent will produce one whenever a person describes a trigger in those terms,
because that is what the tool description tells it to do.

**Why JEV.** This is the closest decision in the tree to the one JEV already
does well, and it is closer to JEV's strengths than addressing is:

- The state is already compact and already assembled. The
  `workspaceEvent` built at `workspace-do.ts:5276` carries exactly the fields
  the existing prompt uses: event type, title, summary, text snippet. No graph
  walk, no extra read.
- The question is a two-outcome policy with a written asymmetry: a false match
  starts an unrequested run with connector write tools bound
  ([`automation-lifecycle.md`](automation-lifecycle.md) 2026-09-03 records that
  a trigger-started run holds the same tools as any other), and a false
  non-match silently does nothing, which the member experiences as a broken
  automation.
- The decision sits behind a deterministic prefilter that has already narrowed
  the population, which is the ordering
  [`jev-best-practices.md`](jev-best-practices.md#model-the-state-explicitly)
  asks for: derive upstream what the application knows reliably, and ask the
  model only what is left.
- Latency is nearly free here. A JEV call at about 220 ms p50 sits inside a
  queue delivery that is about to start a harness run measured in seconds.

**Contract.** Entity: one connector event, against one authored condition.
Outcomes: `condition_met` and `condition_not_met`, with a third,
`condition_not_judgeable`, if and only if the team wants an unjudgeable condition
to be visibly broken rather than silently closed; a condition the model cannot
test from the event alone is an authoring defect the author should be told about,
and folding it into `condition_not_met` hides it. Evidence separating them: the
prompt's existing rule, that only affirmative evidence in the supplied fields
counts and topical similarity does not. Insufficient confidence: fail closed, no
run, and log it, because the fallback for a missed trigger is the next event and
the fallback for a wrong one is a run nobody asked for.

The condition is authorized criterion; the event is untrusted evidence. That
separation must be structural in the state object rather than a sentence in the
question, which is one thing the existing prompt gets right and which a JEV
`state` expresses better than a rendered user turn does.

**What has to be measured first.** There is no production corpus, because the
feature has never run. That is a real gap in test (5) and the entry should not
pretend otherwise. What can be built without any authorized export: stored
connector events are already retained per workspace, and conditions are
synthesizable from the ones the authoring agent writes, so a corpus of
(event, condition, adjudicated verdict) pairs can be assembled and judged
independently, in the shape
[`jev-best-practices.md`](jev-best-practices.md#build-ground-truth-that-can-disagree-with-production)
describes, with no production label to overlay because there is no production
behavior to regress against. Class support is the thing to watch: near-miss
negatives (right channel, right event type, wrong subject) are the whole
decision, and a corpus of obvious yeses and obvious noes will measure 98% and
prove nothing.

**Also worth deciding separately from the classifier.** Whether shipping the
evaluator is even the right fix, or whether `semantic_activity` should be
refused at authoring time until one exists. The second is smaller, reversible,
honest, and available now; it costs the members who would have wanted the
feature. That is a product call, not an engineering one.

### 2. Work-opportunity admission, which is a coarse gate paying generative prices

**Observed.** `processModelBatch`
(`apps/api/src/services/work-opportunity-service.ts:1084`) sends a batch of
connector activity, the workspace member list, existing work streams and
existing opportunities to a generative call that returns up to four decisions,
each one an `action` of `add`, `ignore` or `update_existing` plus a display
prompt, an execution prompt of up to 20,000 characters, a decision memo of up to
20,000 characters and a set of person links. The code's own comment at `:1113`
says what it is: "Admission is a coarse gate biased toward `ignore`, asked tens
of thousands of times a day", and reasoning was dropped to `low` because at
`high` it "was a quarter of every admission call's output tokens."

There is no confidence anywhere in the schema (`:110`). Every decision the model
returns is persisted.

**Why JEV.** Not as a replacement: the generative half is genuinely generative
and JEV cannot write an execution brief. As a **pre-gate**, which is the highest
leverage available in this file. The expensive call is being asked two questions
at once, and the first one throws most of the work away:

- `is_there_work_here` is a closed-set decision, asked tens of thousands of
  times a day, and answered `ignore` most of the time. Admitting only what
  passes means the generative call runs on the minority, and its reasoning
  budget could go back up for the cases that reach it. The gate's own latency
  and token count are not predictable from addressing's numbers: its state is a
  batch of activity plus the member list, which is larger than a message and ten
  context turns, and a gate whose state grows with the batch has to be measured
  before it is believed. Whether the state can be reduced to one activity item
  at a time is part of the design, not a detail: duplicate detection is the
  reason the batch is a batch.
- The expensive call keeps exactly the work it is good at: writing the two
  prompts and the memo for activity already judged worth proposing.
- The criteria are already written. The admission system prompt's "prefer ignore
  when evidence is merely informational, has already been handled, lacks a
  concrete outcome, or would not benefit from an agent"
  (`packages/agent-harness/src/prompts/work-opportunity.ts`) is four exclusions
  in search of a Choice criterion.

**Contract.** Entity: one activity item, or one batch item. Outcomes, at least:
`actionable_work`, `informational_only`, `already_handled`,
`duplicate_of_existing`. Those four are operationally distinct only if the
downstream treats them differently, and today three of them collapse to
`ignore`; the separation is worth keeping anyway, because
`duplicate_of_existing` is the one that should route to the generative call as
an `update_existing` candidate rather than being dropped, and
`already_handled` is the one whose false positives are a silent product failure
rather than noise. Insufficient confidence: pass through to the generative call,
which is today's behavior, so the gate can only ever *save* work and a bad
threshold degrades to the current cost rather than to a wrong answer. That
property is what makes this the cheapest candidate to try.

**What has to be measured first.** This one has the best corpus in the tree,
and all of it is already retained. The inputs: connector event bodies for 396
days and activity events for 90
(`CONNECTOR_EVENT_BODY_RETENTION_MS`, `ACTIVITY_EVENT_RETENTION_MS` in
`workspace-do.ts`). The decisions: every admitted opportunity with its
`admission_reasoning` and `source_fingerprint` in `work_opportunities`. The
outcome: `work_opportunity_user_states` records per member and per opportunity
whether it was impressed, dismissed or started, with an impression count. An
`ignore` leaves no row, so the negative class has to be reconstructed from
activity that produced no opportunity, which is the join to get right before any
number from this corpus is worth quoting.

What is needed beyond that is an independently adjudicated subset, because a
retained decision is a regression label and a gate tuned to reproduce it
reproduces whatever noise the home screen currently shows. A dismissal is the
strongest correctness signal available, and it is not the same thing as "should
not have been admitted": a member dismisses things that were reasonable to
offer. Measure the cascade, not the gate: the number that matters is total cost
and total latency per admitted opportunity, including the JEV calls spent on
everything it rejected.

**The threshold is the team's.** A gate biased toward `ignore` and a gate biased
toward passing through are different products, and the loss function has a
number in it nobody here has yet:
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)
applies.

### 3. Identity resolution inside admission, which decides who can be targeted

**Observed.** The same admission call returns, per person reference, a
`resolution` of `verified`, `inferred`, `ambiguous` or `unresolved`
(`work-opportunity-service.ts:133`) with free-text reasoning and source offsets.
That field is load-bearing for who a suggestion reaches: `eagerUserIds` is built
from `verified`, plus `inferred` when the audience is workspace-scoped
(`:1043`). The code does not trust the model's word on `verified`: it downgrades
one lacking verified evidence (`:1002`) and re-derives the allowed target.

**Why JEV.** This is a four-way Choice with authorization consequences,
currently decided as one field inside a large generative answer, with no
confidence attached to it. The code compensates with a deterministic downgrade;
why it was written that way is not recorded, but what it demonstrates is that
the model's own claim on this field was not treated as sufficient. It is the
textbook case from
[`jev-best-practices.md`](jev-best-practices.md#choose-the-right-primitive):
four operationally distinct outcomes, each with a nearest-confusing-neighbor
that the existing prompt already spells out ("Exact tenant-scoped verified
identities are strongest. Then verified email/known alias. Infer a free-form
reference only when exactly one plausible active member is strongly
supported."). A calibrated confidence would give the existing downgrade a number
instead of a boolean, and `ambiguous` would stop competing with low confidence,
which is the overloaded-uncertain-class failure that document names.

**Contract.** Entity: one person reference in one source. Outcomes: the four
that exist. Insufficient confidence: demote to `ambiguous`, which already means
"do not target", so the failure mode is a suggestion that reaches nobody rather
than one that reaches the wrong person.

**What has to be respected.** Identity inference never expands source access.
The admission and ranking prompts each say so in their own words, and the code
enforces it (`:1005`-`:1012`), and a JEV answer is evidence for a targeting decision, never
the decision itself. The deterministic downgrade stays no matter how good the
confidence gets: the classifier is one input to an authorization check, and
[`authorization.md`](authorization.md) owns the check.

**Sequencing.** This is the same call as entry 2 and the same corpus. Do not
change both at once: that is the "changing primary and fallback together"
failure with different names. Entry 2 first, because it is reversible and
touches no authorization path.

### 4. Digest settlement, a decision this tree already declined for want of JEV

**Observed.** `digest-run-settlement.ts` mails a digest run's final message and
"has no way to tell a digest from a sign-off" (`:36`-`:57`). A run that ended
"Outcome: digest written (id ...)" settled as `delivered` and advanced
`cursor_through` past events nobody was ever told about, and because only settled
deliveries move the cursor, "that loss is silent and permanent". The guard is a
200-character floor, and the comment is explicit that it is deliberately *not* a
check that the text looks like a digest, "that is the send-time heuristic this
subsystem already rejected once; it only refuses text that cannot be one."

**Why JEV.** The asymmetry is already written down, in the same comment, in the
form a JEV threshold wants: "Rejecting a real digest costs one delayed
occurrence, and the events return in the next one because a failed delivery does
not move the cursor. Accepting a receipt costs the window forever." That is a
loss function. What was missing was a classifier whose confidence could be
calibrated against it rather than a keyword heuristic, and that is the
difference between what was rejected and what JEV offers.

**Contract.** Entity: one run's final message, plus the window's event count.
Outcomes: `digest_for_a_reader`, `run_receipt_or_signoff`,
`failure_or_refusal_notice`. The third matters separately because a run that
refused should neither be mailed nor move the cursor, and today the length floor
cannot tell it from a short digest. Insufficient confidence: do not settle, so
the window returns, which is the cheap error the comment already identifies.

**What has to be measured first.** The corpus is one query away:
`digest_deliveries` keeps `summary_markdown` beside the `status` it settled to
and the `event_count` the window held, so every text this decision has ever seen
is stored next to the verdict it produced. The positive class is abundant. The
negative class is the problem: receipts are rare by construction, and the one
that caused the incident is a single row. This needs deliberately constructed
near-misses, a genuine digest with one section, a receipt that quotes a
headline, before any threshold means anything. The 200-character floor stays
underneath as the terminal floor whatever the classifier says.

**Scope note.** The length floor is not what JEV replaces. It is cheap, total,
and protects against exactly the failure that is unrecoverable; keep it and put
the classifier above it, the same shape as addressing's deterministic terminal
floor.

### 5. A Noul to shrink the suggested-work ranking tournament, with a caveat

**Observed.** Ranking runs a tournament: candidates are grouped by byte budget,
each group is ranked down to four by a generative call at `low` reasoning, and
the survivors go around again, up to `MAX_RANK_ROUNDS` of 10, three groups
concurrent (`work-opportunity-service.ts:46`, `:50`, `:1399`-`:1442`). The
comment at `:1277` is the relevant one: elimination rounds answer "which four of
these twelve survive", which is coarser than the final ordering, "and it is
asked several times per tournament. Spending the deep reasoning budget on every
one of them is most of why a ranking could not finish."

**Why a Noul, and why only partly.** "How strongly does this deserve the
member's attention now" is a genuine single scalar axis, which is the one thing
[`jev-best-practices.md`](jev-best-practices.md#choose-the-right-primitive)
sanctions Noul for: "Noul is useful for ranking or thresholding a single
semantic axis." A per-candidate Noul could cut a twelve-candidate pool to the
handful that a single generative call can order in one round, replacing several
elimination rounds with one scoring pass.

The caveat is the reason this is entry 5 and not entry 2. A per-candidate score
is not a comparative judgment, and the current prompt explicitly forbids the
model from simulating a weighted formula. Ranking's final order must stay
comparative. So the honest scope is: Noul as a *pool reducer* before the
tournament, never as the order itself, and the thing to measure is not
"agreement with the ranking" but "does the final ordered four change". If it
does, the reducer is eliminating candidates the tournament would have kept, and
the whole idea fails on that number rather than on a latency win.

**What has to be measured first.** Every round is recorded:
`suggested_work_ranking_rounds` stores each round's `candidate_ids_json`,
`selected_ids_json` and `round_number`. So every historical tournament's
candidate set and survivors are available, which makes this the one candidate
that can be measured offline against real decisions with no adjudication at all:
score the recorded candidates, then check whether the four the tournament
produced survive the cut. That measurement needs no new corpus and no judge, and
it settles the idea either way, which is a good reason to run it early even
though shipping it ranks last.

## Considered and rejected

Kept because each is more attractive than it deserves to be, and the next reader
will otherwise propose it.

- **Per-instance digestibility.** "Would a person who was away for a day want
  this read back to them?" is a JEV question in the abstract, and it is answered
  today by a static per-event-type declaration in each connector manifest
  ([`connector-digestibility.md`](connector-digestibility.md)). Rejected because
  the declaration is a *contract*, not a cached judgment: it is reviewable in one
  place, `digestibility-doc.test.ts` fails when a new type skips it, and it is
  the reason a connector author has to think about volume before shipping an
  event type. [`contextual-routing.md`](contextual-routing.md) also records, from
  the retired feature that tried to read it as a verdict, that `digestible`
  "encodes three different noes and only one of them is about relevance"; a
  per-instance classifier would be answering a different question from the field
  it replaced, which is how that gate broke a PRD acceptance flow while every
  unit test passed.
- **Adding a confidence field to a generative call instead.** The cheap version
  of every entry above: ask the existing `runStructuredInference` call for a
  number alongside its answer and threshold on that. Rejected because this tree
  has already run the experiment. Contextual routing's only quality control was
  "a constant compared against a number the model made up about its own answer",
  nothing ever read the resolution back, and the post-mortem rejected "raising
  the constant to 0.9 for everyone" on the grounds that it "still compares
  against a self-reported score"
  ([`contextual-routing.md`](contextual-routing.md), 2026-08-12). It also
  rejected requiring a non-empty `matchedEntities` for the same reason: "the
  field is produced by the same model whose judgement is in question". A
  provider-computed confidence over a closed choice set is a different object
  from a self-report, and it is most of why these entries are worth writing at
  all. A self-reported number is not a cheap first version of one; it is the
  thing that failed.
- **Replacing the external-event predicate.** The deterministic matcher is
  intentionally total, fails closed on missing values, and its strict schemas
  make illegal operator/value pairs unrepresentable. A semantic classifier
  belongs *after* it (entry 1), never instead of it: the prefilter is what keeps
  the classifier's population small enough to afford and its state small enough
  to name.
- **The correctable-argument classifier.** `classifyAttemptError` and the
  tool-argument path decide whether a rejected tool call is the model's fault or
  a provider's, and they do it by reading whether the arguments fail the
  declared schema or a code-authored refinement
  ([`agent-harness.md`](agent-harness.md), 2026-08-25). That is structural
  knowledge the code has for certain. Asking a model to guess at it would
  replace a fact with an opinion.
- **Attachment kind.** `classifyAttachmentKind` reads MIME type and filename.
  Deterministic, cheap, and its failures are wrong icons.
- **The work-stream icon.** A closed catalog, chosen from a rendered list, which
  is Choice-shaped and tempting. Rejected because the naming service chose
  deliberately to ask for the name and the icon in one call: "the icon has to
  stand for whatever the name leads with, and a second call would be a second
  model reading the same request and agreeing with the first only by luck"
  (`workstream-naming-service.ts:302`-`:305`). A JEV icon call is that second
  model.
- **Addressing's heuristic floor.** Keep it local and deterministic. It exists
  so that two remote providers being down cannot decide whether Rally retains a
  member's message, and every entry above that gains a JEV stage needs to ask
  the same question about its own terminal floor.
- **Compaction, wake-ups, digest scheduling, inbound mail admission.** Token
  arithmetic, clocks, and sender authorization. Nothing semantic is being
  decided.

## Adding the second one

In order, and none of these steps is optional because the first classifier
already paid for the lesson in each:

1. Extract the two primitives above, with addressing as the only caller and a
   behavior-preserving test.
2. Write the downstream action and the cost of each error before the question
   ([the contract](jev-best-practices.md#start-with-the-decision-contract)).
3. Build the corpus, split development from holdout *before* tuning, and keep the
   production label and any independent adjudication distinguishable.
4. Ablate one representational idea at a time, preserving each candidate's whole
   request, and keep a compact candidate in the comparison.
5. Choose the confidence policy and the fallback only after the request is
   frozen, and state the threshold's equality semantics in a test.
6. Give the new classifier its own directory under
   `packages/agent-harness/evals/`, shaped like `evals/addressing/`: a
   caller-supplied corpus that is never committed, a content-safe synthetic
   fixture for smoke-testing the runner, a committed content-free aggregate
   baseline, and reports bound to the corpus hash.
7. Log one outcome row per cascade with the stage that answered, and capture the
   request and response through the same access-controlled inference path as
   every other model call.
8. Record the *why* in the changelog of the document that owns the mechanism,
   and delete the entry from this file.
