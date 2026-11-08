# Semantic activity triggers

A `semantic_activity` Sidekick trigger is the only trigger in the product whose
gate is a sentence: "the message asks for a design review", "the changed file is
a customer contract". Everything else starts a run on a field comparison, a
clock, or a person pressing a button. This document owns the sentence: where it
is stored, when it is tested, what tests it, and what happens to the run when the
answer is no or when nobody can answer.

The promise it makes to the rest of the system is narrow and worth stating,
because for its first year the product made it and did not keep it: **an event
that reaches a Sidekick gated by a written condition starts a run only when that
condition has been judged to hold.** [`automation-lifecycle.md`](automation-lifecycle.md)
owns the trigger's authoring, storage and occurrence keys;
[`jev-best-practices.md`](jev-best-practices.md) owns how the JEV request behind
the judgement is designed and evaluated.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/agent-harness/src/jev/client.ts` | One TypeSafe SystemOne request: the endpoint, the envelope, the owned deadline, the failure vocabulary. Knows no decision. |
| `packages/agent-harness/src/jev/questions.ts` | The Choice question and answer shapes, so a criterion cannot ship without its include/exclude boundaries. |
| `packages/agent-harness/src/jev/cascade.ts` | Primary, fallback, terminal floor, and the rule that a cancelled caller is not a failed provider. |
| `packages/agent-harness/src/semantic-trigger-gate.ts` | This decision: the state, the question, the criteria, the threshold, and the mapping to a verdict. |
| `packages/contracts/src/index.ts` | `semanticConditionsForEventType` — the single join from an arriving event type to the conditions that gate it. |
| `apps/api/src/durable-objects/automation-do-protocol.ts` | The verdict and plan shapes that cross the RPC boundary. |
| `apps/api/src/durable-objects/hosted-sidekick.ts` | The Sidekick parent hosted in WorkspaceDO: the private `externalEventPlan` decides whether a delivery is gated; `admitExternalEvent` (reached as WorkspaceDO's `sidekickAdmitExternalEvent`) reads it and enforces the verdict. |
| `apps/api/src/services/semantic-trigger-admission.ts` | The delivery's three steps: ask, judge, admit again with the verdict. |
| `apps/api/src/services/classifier-diagnostics.ts` | Where every classifier's provider diagnostics go, shared with addressing. |
| `apps/api/src/queues/activity-consumer.ts` | The external-event delivery branch that calls it. |

## How it works

A `semantic_activity` trigger reaches production the same way a
`connector_activity` one does. The authoring agent writes it into a draft, the
draft schema requires a non-empty `condition` and a `deterministicPrefilter`
naming exactly one declared event type, the accepted revision stores both, and
the evaluator rules the author wrote alongside it become the registrations that
`WorkspaceDO.matchExternalEventDestinations` selects on. Nothing about matching
changed: the predicate is still deterministic and still takes no semantic test.

What changed is what happens between the match and the run.

1. **The match becomes a delivery.** One Queue message per matched registration,
   carrying the registration, the destination and the event.
2. **The delivery asks to admit, and a gated event is sent back to be judged.**
   `admitExternalEvent` builds its plan with `externalEventPlan`, which applies
   every admission check — lifecycle, trigger membership, the activation
   boundary — and then looks for `semantic_activity` triggers in the accepted
   definition whose `deterministicPrefilter.eventType` matches the event's. A
   refusal or an ungated admission answers at once; a gated event without a
   verdict is refused as `sidekick_semantic_condition_unjudged`, carrying a
   `judge` with the conditions to test and the connector they watch, so no
   separate planning call is needed.
3. **A gated delivery judges the conditions.** `judgeSemanticTriggerConditions`
   asks JEV one Choice question per condition, stopping at the first met, and
   maps the answer to a verdict: `condition_met` above the confidence threshold
   admits; `condition_not_met`, `condition_not_judgeable`, a confidence at or
   below the threshold, and any failure to get an answer do not.
4. **The object admits or refuses.** The delivery calls `admitExternalEvent`
   again with the verdict; it recomputes the same plan, and for a gated event
   requires a verdict that admits. The occurrence key
   is unchanged, so a redelivery still answers from the run it already made.

The question itself is three named outcomes over two named pieces of state, and
the state carries the trust boundary in its shape: `authorized_condition` is the
criterion, `candidate_event` is untrusted third-party text. There is no
concatenation for an event title to escape from, which is the part a rendered
chat turn could not offer.

### Why the model call is not inside the object

Every other model call in this tree runs in a Worker. A Durable Object that
blocked on a provider would serialize every other request to that Sidekick behind
a network round trip it does not control, and a Sidekick's object is also
answering its runs, its authoring conversation and its detail reads. So the
classifier runs in the delivery, in the queue consumer, where the addressing
cascade's sibling calls already run.

That splits the decision from its enforcement, and the split is deliberate rather
than incidental: the object keeps the authority. It knows which of its triggers
are gated, so a delivery that arrives without a verdict for a gated event is
refused. A caller cannot skip the gate by not asking.

### Why JEV rather than a generative call

The answer is one member of a closed set, which is the shape
[`jev-best-practices.md`](jev-best-practices.md#choose-the-right-primitive) says
Choice is for. The deciding reason is the confidence: the threshold that decides
whether to start somebody's automation is applied to a number the provider
computed, not to one the model wrote about its own answer.
[The Suggested context retirement record](connectors.md#2026-11-08--retirement-record-suggested-context)
records what the second kind cost the retired router — "a constant compared against a number the model made up
about its own answer" — and rejected raising that constant for exactly this
reason.

The optimization qualified that argument rather than overturning it. On this
question the label carries almost the whole decision and the threshold is a
nearly flat lever between `0` and `0.5`, because the provider's confidence on a
Choice turns out to be a cliff at 0.5 rather than a gradient above it. The same
question asked as a Noul — a single scalar, no label — makes the threshold the
whole decision and scores no better, while turning a flat curve into one with a
cliff at 0.7. A provider-computed confidence is still the right thing to threshold
on; it is just not where this decision is made.

## Invariants

- **A gated event without an admitting verdict does not start a run.** Breaking
  this restores the original defect: Rally displays a filter to the person who
  wrote it and applies nothing, and their Sidekick runs on every event of its
  type. The enforcement is in `admitExternalEvent`, not in the caller, so a new
  delivery path cannot reintroduce it by forgetting.
- **Both admission calls apply the same checks.** Each calls
  `externalEventPlan`. A second copy of the lifecycle or boundary logic is how a
  caller comes to learn one answer and admission to apply another.
- **A failure to judge refuses.** HTTP, schema, deadline and a missing credential
  all reach `classifier_unavailable`, which does not admit. The costs are not
  symmetric: a refusal loses this occurrence and the next matching event gets
  another chance, while an admission starts work the condition said not to start,
  holding the Sidekick's write tools.
- **The condition is the criterion and the event is evidence.** They stay
  separate named fields of the JEV state. Merging them, or interpolating event
  text into the question, hands a third party the ability to restate the rule
  they are being judged against.
- **A caller's cancellation is not a provider failure.** It propagates rather
  than advancing a cascade or being recorded as unavailable. Confusing the two
  spends a second provider call on work nobody is waiting for.
- **Outcome codes are a closed enum at the boundary.** The verdict's `code`
  reaches an outcome code a runbook greps for, so a caller must not be able to
  write arbitrary strings into one.

## Boundary

**Owns:** whether a written condition holds for one event, the verdict vocabulary
that crosses the RPC boundary, the threshold and the deadline this decision
carries, and the enforcement point in `admitExternalEvent`.

**Exposes:** `judgeSemanticTriggerCondition` and `judgeSemanticTriggerConditions`
from the harness package, `admitExternalEvent` on the Sidekick parent, and
`admitExternalEventWithSemanticGate` for a delivery path. The JEV primitives under
`packages/agent-harness/src/jev/` are exposed for the next classifier and are
documented in [`agent-harness.md`](agent-harness.md); they are not specific to this
one.

**Depends on:** the accepted definition's triggers, the registration the match
selected, and TypeSafe.

**Deliberately does not:**

- decide which events reach a Sidekick at all. That is the deterministic
  evaluator predicate, in [`automation-lifecycle.md`](automation-lifecycle.md),
  and the semantic gate sits strictly after it so the population it judges is
  already small.
- carry the condition in the Queue message. The criterion stays in the object
  that owns it; a delivery learns it by asking.
- gate anything but an automation destination. A watched conversation resource
  update has no written condition.
- retry a judgement. The delivery retries as a whole, and the object is
  idempotent on the occurrence key.

## Failure modes and limits

| Situation | What happens |
| --- | --- |
| JEV answers `condition_not_met` | Refused, `sidekick_semantic_condition_not_met`. No run, no retry: the answer is the product's. |
| JEV answers `condition_not_judgeable` | Refused, `sidekick_semantic_condition_not_judgeable`. This is an authoring defect — a condition no event of that kind can settle — and it is kept distinct from a failed test so it can be found. |
| Confidence at or below the threshold | Refused, `sidekick_semantic_confidence_below_threshold`. |
| The condition changed while the model call was in flight | Refused, `sidekick_event_before_activation_boundary` — not by the gate. See [What closes the stale-verdict window](#what-closes-the-stale-verdict-window). |
| JEV unavailable: HTTP error, malformed response, deadline | Refused, `sidekick_semantic_classifier_unavailable`, with the provider's own failure kind on the log line. The delivery is **not** retried for this: a retry would ask the same question of the same outage. |
| No `TYPESAFE_API_KEY` | Refused as unavailable. Hosted regions always have one (`assertEnvContract` requires it), so this is local development, where refusing is honest and admitting would reproduce the defect. |
| A gated delivery with no verdict | Refused, `sidekick_semantic_condition_unjudged`, carrying the conditions; the gated path judges them and asks again, and a caller that never judges never admits. During a rolling deploy the reverse is also possible — a new consumer calling an object that does not know the field — and there the RPC throws, the delivery retries, and the retry succeeds once the deploy completes. |
| Several conditions on one Sidekick | Judged in order, stopping at the first met. One condition costs one call. |

Two numbers, and only one of them is chosen:

- **`SEMANTIC_TRIGGER_CONFIDENCE_THRESHOLD` is `0.5`**, which is measured rather
  than chosen. Pooled over the whole 274-case corpus the utility of this question
  is flat from `0` to `0.5` — 0.844, 0.843, 0.834 — and falls above it, 0.822 at
  `0.6` and 0.787 at `0.7`, while recall on cases nothing was tuned against goes
  96.8% with no gate, 87.1% at `0.5` and 75.8% at `0.7`. So the lever is nearly
  dead at the bottom of the band and buys precision at the cost of recall above
  it, and `0.5` is the bottom of the band the team set. The comparison is `>`,
  matching the addressing cascade, so a confidence exactly equal to the threshold
  refuses.

  The earlier note here floated `0.8` as a starting point on the argument that a
  false run costs more than a quiet automation. That argument was backwards, and
  it is worth keeping the correction visible: the run opens with a
  state-of-the-art model that decides for itself whether the event is worth acting
  on, so an unwanted fire costs one session that finds nothing to do, while a
  refusal is silent and the member asked to be told. At `0.8` this question would
  have dropped a third of the runs somebody asked for.
  The price list the optimization scored against was a correct decision at +1, a
  false fire at 0 and a miss at −2, which makes firing the better bet whenever a
  calibrated probability of a match exceeds 1/4;
  [`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)
  is why the number waited for a measurement instead of a guess.
- **`SEMANTIC_TRIGGER_JEV_TIMEOUT_MS` is one second**, three times the measured
  JEV p95 of about 350 ms recorded in
  [`jev-best-practices.md`](jev-best-practices.md#measure-latency-end-to-end),
  and the same budget the addressing cascade carries against the same provider.
  Here it bounds a queue delivery about to start a run measured in seconds.

There is no fallback stage. The cascade primitive exists and addressing uses it,
so adding one is a small change, but
[`jev-best-practices.md`](jev-best-practices.md#design-the-fallback-as-part-of-the-classifier)
asks for a fallback to be chosen after the primary is frozen and evaluated on the
subset it will actually receive, and neither has happened for this decision yet.

### The gate is joined to the event type, not to the matched trigger

`semanticConditionsForEventType` selects every semantic trigger whose
`deterministicPrefilter.eventType` matches the delivered event type, and discards
the `registrationId` the delivery was matched through. Two consequences, both
reachable: a Sidekick carrying a deterministic `connector_activity` trigger *and* a
`semantic_activity` trigger on one event type has its deterministic deliveries
gated by the semantic condition, which can suppress runs that used to fire; and two
semantic triggers sharing an event type are judged as an OR across both conditions,
so the condition belonging to the other trigger can admit. Nothing in
`AutomationDraftSchema` forbids either shape. The fix is a trigger identity carried
through publication into `ExternalEventEvaluatorV1` and the delivery, which does not
exist today — triggers have no ids, and the only link from a trigger to its
evaluator is `sourceBindingKey`, which the draft validation explicitly allows two
triggers to share. Until that exists, a Sidekick whose triggers overlap on one event
type is gated more broadly than its author wrote.

### What closes the stale-verdict window

The model call runs between the plan read and the admission, so an `apply` can
land in that window and change the condition while keeping the same registration
identity — every check the gate itself applies still passes. The verdict carries
no proof of what it judged, so read on its own that is a window where the object
sees the new condition and admits on a verdict for the old one.

It is closed one clause earlier, and for an unrelated reason. `apply` is the only
path that can move an accepted condition; it re-establishes
`effective_after_event_sequence` at the sequence current when its registration
tail lands; and the activation-boundary check is ordered **before** the semantic
one. An event ingested before the apply is at or below that boundary, so it is
refused there and never reaches the gate.

That is worth writing down because it is invisible from the gate's own clause,
and because it was checked rather than assumed. Removing the `= NULL` that apply
writes does not open the hole — the registration tail moves the boundary forward
regardless. Moving the semantic check above the boundary check does: the delivery
then admits on the superseded verdict.
`apps/api/test-workers/semantic-trigger-gate.test.ts` pins it, and that is the
break it was proved against.

**So the verdict deliberately carries no plan token.** Binding one would mean a
new required field on a strict schema that crosses the object's RPC boundary,
guarding a window that is already closed — a mechanism whose only justification
is a scenario nobody can produce. If the ordering above ever changes, the token
is the fix, and the test named above is what will say so.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test-workers/semantic-trigger-gate.test.ts` | The object, against real workerd: a gated event refused with no verdict, with a refusing one and with an incoherent one, admitted with a met one, refused when a gated Sidekick's condition cannot be resolved for the event, refused when its condition was replaced after the plan was read, and a deterministic trigger left ungated. Its D1 starts with no schema, so the three tables creating a Sidekick writes through are declared in `beforeEach`, and the Sidekick's email address is reserved up front because minting one needs a signing key this Worker does not configure. It uses Ashby because the test Worker's connector registry has it and applying an event trigger validates against the registry. |
| `apps/api/test/semantic-trigger-admission.test.ts` | The delivery's order: a refusing plan costs no model call, an ungated one carries no verdict, a gated one reaches the object with the verdict the classifier produced. |
| `packages/agent-harness/src/jev/jev.test.ts` | The primitives and the classifier over a stubbed provider: the request bytes, the failure vocabulary including one case per way of not getting an answer, deadline versus cancellation, every cascade transition, the threshold's equality semantics, that an outage on one OR branch outranks a later branch's clean refusal, and that event text cannot reach the question. It also pins the key order of the addressing request, because the bytes an ablation compared are part of what the recorded baseline means. |

Each was checked against the break it exists to catch: the object's by removing
the verdict enforcement from `admitExternalEvent`, which fails the refusal cases;
the delivery's by treating a `judge` plan as an `admit`, which fails the three
gated cases; the stale-condition case by moving the semantic check above the
activation-boundary check, which admits on the superseded verdict; and the OR
aggregation by taking the last refusal rather than the first outage.

## Open questions

- **The gate is joined to the event type rather than to the matched trigger**, per
  the known gap above. The fix needs trigger identity through publication and
  delivery, which is a field on a strict schema an older isolate would reject
  mid-deploy, so it is its own change rather than a late addition to this one.
- **The corpus is synthetic.**
  The request that ships was selected by an optimization over 274 cases with a
  split made before tuning and an independent adjudication layer, which is what
  [`jev-best-practices.md`](jev-best-practices.md#optimize-by-ablation-not-prompt-accumulation)
  asks for — but the cases were authored rather than replayed, because the feature
  had never run. So the criteria are measured against a distribution somebody
  imagined. What replaces it is a corpus of (event, condition, adjudicated
  verdict) triples assembled from retained connector events — processed bodies are
  kept for 90 days — and conditions of the shape the authoring agent writes.
  The first authorized export may well move the criteria.
- **The optimization is not reproducible from this repository.** The harness, the
  corpus, the candidate contracts and the per-run reports are not committed, so
  the numbers below are a record of a measurement that was made rather than one a
  later change can re-run and compare against. A change that rewrites the question
  or moves the threshold is therefore working without the comparison this one had,
  and rebuilding the harness is the first thing such a change should cost.
- **Whether `condition_not_judgeable` should reach its author.** It means the
  condition cannot be settled by an event of that kind, which is an authoring
  defect rather than a run that should not start. Today it is a refusal and a log
  line. Telling the Sidekick's author would need a surface that does not exist.

## Changelog

### 2026-09-18 — A written condition is tested before it starts a run

**What changed:** `semantic_activity` conditions are evaluated. A JEV Choice
question (`condition_met`, `condition_not_met`, `condition_not_judgeable`) is
asked of TypeSafe in the external-event delivery, between a new
`externalEventAdmissionPlan` read and `admitExternalEvent`, which now refuses a
gated event whose verdict does not admit or is absent.
`semanticConditionsForEventType` joins an arriving event type to the conditions
that gate it through `deterministicPrefilter.eventType`, which had no runtime
reader either. Three primitives were extracted from the addressing classifier
first — the JEV request, the confidence cascade, the Choice question shape — plus
a shared classifier diagnostic sink in the API; addressing runs on all four and
its behavior is unchanged. The unused `prompts/semantic-trigger.ts` renderer and
its three prompt tests are gone.

The question and the threshold are the optimization's output rather than its
starting point. A GEPA search over 274 cases, split before tuning and
independently adjudicated, selected a request that is 133 words against the 227 it
started with and scores 0.813 in band utility on the held-out split against 0.701
— 87.1% recall where the first request managed 71.0%. Almost all of the difference
is subtraction: an empty `decision` string, no include list on `condition_met`,
one include on `condition_not_met` instead of three, and an assertive
`condition_not_judgeable` that every other compact candidate had quietly dropped.
`SEMANTIC_TRIGGER_CONFIDENCE_THRESHOLD` is `0.5`, from the swept curve. Nothing in
the tree pins either of them to what was measured: the harness that produced the
comparison is not committed, so the question and the number are now ordinary code
that a future edit can change without a test objecting.

**Why:** the condition was required by the draft schema, stored on the accepted
revision, and returned verbatim by the desktop client as the trigger's one-line
description of what starts the run, and nothing evaluated it. The only runtime
matcher is the deterministic evaluator predicate, which takes no semantic test, so
a Sidekick that asked for "only when the message asks for a design review" ran on
every message of its event type. The product displayed a filter and applied
nothing.

JEV rather than a generative call because the decision is one member of a closed
set and the threshold has to be applied to a provider-computed confidence:
[The Suggested context retirement record](connectors.md#2026-11-08--retirement-record-suggested-context)'s summary of its 2026-08-12 entry records the
retired router's only quality control as "a constant compared against a number
the model made up about its own answer", and rejected raising that constant
because it "still compares against a self-reported score".

**Considered and rejected:** *Carrying the condition in the delivery's Queue
message*, by adding it to the registration projection. It is the nicer end state
— no second RPC, and the gate travels with the delivery — and it was rejected for
now because it needs a field on a strict schema that an older isolate would
reject mid-deploy, and because it puts authored criterion text into a queue
payload that has travelled. *Running the model call inside the Sidekick object*,
which removes the split between decision and enforcement and was rejected because
it blocks the object on a provider for up to a second, and no Durable Object in
this tree makes a model call today. *Refusing the trigger type at authoring time
until an evaluator existed*, which is smaller and honest, and remains the right
answer if this judgement turns out not to work. There was little install base to
protect either way: every `automation_created_v2` and `automation_draft_ready`
event in production names `calendar` or `connector_activity` and none names
`semantic_activity`, though both events stopped being emitted on 2026-08-26, so
that evidence does not cover the weeks before this change. *An OpenRouter fallback stage*, using the prompt that already
existed, rejected because a fallback is chosen after the primary is frozen and
measured on the subset it will receive, and neither has happened.

**Considered and rejected, on the classifier itself:** *asking the question as a
Noul*, a single scalar with no label, which is the primitive the decision's
boolean shape suggests. It ties on the objective and loses on calibration, on
three-class accuracy — one scalar cannot say "no event of this kind could settle
this" — and, decisively, on the shape of its threshold curve: the Choice's is flat
between `0` and `0.5` while the Noul's has a cliff at `0.7`, so a later
well-meaning edit towards safety costs a third of the recall on one and nothing on
the other. *A hybrid* that adds a second question settling judgeability in the same
round trip, rejected because its three-class accuracy went down, not up: the second
question claimed events that could in fact settle their condition. *A further
generation aimed at recall*, rejected on evidence — three teachers were given that
mandate on three different parents, all three raised recall, and all three paid for
it almost exactly proportionally in false fires. The prose is not the lever that
trades those two; the threshold is.

*Asking the negative question* — "should this Sidekick ignore this event?", refusing
only on a confident yes so that hesitation falls through to firing. This is the one
alternative that addresses a real defect in the shipped shape rather than a
preference: under the positive question the gate's uncertainty falls towards the
expensive error, and no threshold setting changes that, because the threshold is
what does it. Measured on three candidates, the mechanism worked exactly as
intended and lost anyway. Misses fell to almost nothing and recall reached 99%,
against 32 to 75 unwanted sessions per 151 cases and all twelve standing watches
gone noisy. Two reasons, both worth respecting before anyone tries it again. The
negation **damaged the label rather than only its calibration**: compared at a
threshold of zero, where the fall-through is inactive and only the question
differs, three-class accuracy fell 10 to 16 points and the fire-decision Brier
roughly doubled. And the fall-through has a floor that the price list computes —
with a correct decision at 1, a false fire at 0 and a miss at −2, firing beats not
firing exactly when a calibrated P(match) exceeds **1/4**, so "err towards firing"
is true and stops being true at one in four. The negative question fires at roughly
P(match) > 0.05. The shipped threshold of `0.5` on the positive question sits in
the flat region that both the sweep and that arithmetic point at.

**Found in review and not fixed here:** the gate joins a delivery to its
conditions by event type rather than by the trigger the delivery was matched
through, which over-gates a Sidekick whose triggers overlap on one event type.
[The gate is joined to the event type, not to the matched trigger](#the-gate-is-joined-to-the-event-type-not-to-the-matched-trigger)
has the two reachable shapes and why the fix is its own change. A second review
finding — that a verdict could be stale by the time it is admitted — turned out
not to be reachable, and
[What closes the stale-verdict window](#what-closes-the-stale-verdict-window)
records the ordering that closes it and the break that proves it.

**What a future change has to respect:** the object is the authority. A delivery
path may compute a verdict, but `admitExternalEvent` decides, and a gated event
without an admitting verdict must never start a run — that is the whole defect,
and it is reachable again by moving the enforcement into the caller. The
condition and the event stay separate named fields of the JEV state. And the
shipped question is now evidence rather than prose: it is pinned byte-for-byte to
the candidate that was measured, so a clarification or a typo fix to a criterion
has to come with a rerun that moves the winner file, or it does not happen.

**Which error is expensive, because this was written down backwards first.** The
original note on the threshold argued that a false `condition_met` costs more than
a false refusal, "which argues for a floor well above zero". That reads the agent
run as the cost. It is not: the run opens with a state-of-the-art model that
decides for itself whether the event is worth acting on, so an unwanted fire buys
one session that concludes there is nothing to do, while a refusal is silent and
the member asked to be told. The optimization's objective prices a miss at three
times a false fire for that reason, and every ranking produced before that
correction favoured the quiet candidate and has been re-derived.
