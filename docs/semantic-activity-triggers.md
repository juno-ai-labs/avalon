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
| `apps/api/src/durable-objects/sidekick-do.ts` | `externalEventPlan` decides whether a delivery is gated; `admitExternalEvent` enforces the verdict. Both read one private method. |
| `apps/api/src/services/semantic-trigger-admission.ts` | The delivery's three steps: plan, judge, admit. |
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
2. **The delivery asks the object for a plan.** `externalEventAdmissionPlan`
   applies every check admission applies — lifecycle, trigger membership, the
   activation boundary — and then looks for `semantic_activity` triggers in the
   accepted definition whose `deterministicPrefilter.eventType` matches the
   event's. It answers `refuse` with an outcome code, `admit`, or `judge` with the
   conditions to test and the connector they watch.
3. **A gated delivery judges the conditions.** `judgeSemanticTriggerConditions`
   asks JEV one Choice question per condition, stopping at the first met, and
   maps the answer to a verdict: `condition_met` above the confidence threshold
   admits; `condition_not_met`, `condition_not_judgeable`, a confidence at or
   below the threshold, and any failure to get an answer do not.
4. **The object admits or refuses.** `admitExternalEvent` recomputes the same
   plan, and for a gated event requires a verdict that admits. The occurrence key
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
[`contextual-routing.md`](contextual-routing.md) records what the second kind cost
the retired router — "a constant compared against a number the model made up
about its own answer" — and rejected raising that constant for exactly this
reason.

## Invariants

- **A gated event without an admitting verdict does not start a run.** Breaking
  this restores the original defect: Rally displays a filter to the person who
  wrote it and applies nothing, and their Sidekick runs on every event of its
  type. The enforcement is in `admitExternalEvent`, not in the caller, so a new
  delivery path cannot reintroduce it by forgetting.
- **The plan and the admission apply the same checks.** Both call
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
from the harness package, `externalEventAdmissionPlan` on the Sidekick object, and
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
- gate anything but an automation destination. A watched work-stream resource
  update has no written condition.
- retry a judgement. The delivery retries as a whole, and the object is
  idempotent on the occurrence key.

## Failure modes and limits

| Situation | What happens |
| --- | --- |
| JEV answers `condition_not_met` | Refused, `sidekick_semantic_condition_not_met`. No run, no retry: the answer is the product's. |
| JEV answers `condition_not_judgeable` | Refused, `sidekick_semantic_condition_not_judgeable`. This is an authoring defect — a condition no event of that kind can settle — and it is kept distinct from a failed test so it can be found. |
| Confidence at or below the threshold | Refused, `sidekick_semantic_confidence_below_threshold`. |
| JEV unavailable: HTTP error, malformed response, deadline | Refused, `sidekick_semantic_classifier_unavailable`, with the provider's own failure kind on the log line. The delivery is **not** retried for this: a retry would ask the same question of the same outage. |
| No `TYPESAFE_API_KEY` | Refused as unavailable. Hosted regions always have one (`assertEnvContract` requires it), so this is local development, where refusing is honest and admitting would reproduce the defect. |
| A gated delivery from an older isolate, with no verdict | Refused, `sidekick_semantic_condition_unjudged`. During a rolling deploy the reverse is also possible — a new consumer calling an object that does not know the field — and there the RPC throws, the delivery retries, and the retry succeeds once the deploy completes. |
| Several conditions on one Sidekick | Judged in order, stopping at the first met. One condition costs one call. |

Two numbers, and only one of them is chosen:

- **`SEMANTIC_TRIGGER_CONFIDENCE_THRESHOLD` is an open placeholder at `0`**, per
  [`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md).
  The mechanism is named, wired, enforced and tested; the number that decides
  which real automation gets cut off on a bad day is the team's. The comparison
  is `>`, matching the addressing cascade, so a confidence exactly equal to the
  threshold refuses. An earlier, never-shipped prompt for this decision proposed
  `0.8`; nothing measured it.
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

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test-workers/semantic-trigger-gate.test.ts` | The object, against real workerd: a gated event refused with no verdict and with a refusing one, admitted with a met one, and a deterministic trigger left ungated. Its D1 starts with no schema, so the three tables creating a Sidekick writes through are declared in `beforeEach`, and the Sidekick's email address is reserved up front because minting one needs a signing key this Worker does not configure. It uses Ashby because the test Worker's connector registry has it and applying an event trigger validates against the registry. |
| `apps/api/test/semantic-trigger-admission.test.ts` | The delivery's order: a refusing plan costs no model call, an ungated one carries no verdict, a gated one reaches the object with the verdict the classifier produced. |
| `packages/agent-harness/src/jev/jev.test.ts` | The primitives and the classifier over a stubbed provider: the request bytes, the failure vocabulary, deadline versus cancellation, every cascade transition, the threshold's equality semantics, and that event text cannot reach the question. It also pins the key order of the addressing request, because the bytes an ablation compared are part of what the recorded baseline means. |

Both integration tests were checked against the break they exist to catch: the
object's by removing the verdict enforcement from `admitExternalEvent`, which
fails the two refusal cases, and the delivery's by treating a `judge` plan as an
`admit`, which fails the three gated cases.

## Open questions

- **The confidence threshold has no number.** It is open at `0`, so today the
  choice alone gates and a low-confidence `condition_met` still admits. Setting it
  needs the team to weigh a false run against a quiet automation; the arithmetic
  is in [Failure modes and limits](#failure-modes-and-limits).
- **There is no evaluation of this request.**
  [`jev-best-practices.md`](jev-best-practices.md#optimize-by-ablation-not-prompt-accumulation)
  asks for a production-shaped corpus, a development and holdout split made before
  tuning, and an independent adjudication layer, and none exists: the feature has
  never run, so there is no production behavior to replay. What can be built
  without an authorized export is a corpus of (event, condition, adjudicated
  verdict) triples assembled from retained connector events — bodies are kept for
  396 days — and conditions of the shape the authoring agent writes. The class
  that decides the question is near-miss negatives: the right connector, the right
  event type, the wrong subject. A corpus of obvious matches and obvious
  non-matches will score in the nineties and prove nothing. Until that exists, the
  three criteria here are reasoned from the guide rather than measured, and the
  first evaluation may well move them.
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

**Why:** the condition was required by the draft schema, stored on the accepted
revision, and returned verbatim by the desktop client as the trigger's one-line
description of what starts the run, and nothing evaluated it. The only runtime
matcher is the deterministic evaluator predicate, which takes no semantic test, so
a Sidekick that asked for "only when the message asks for a design review" ran on
every message of its event type. The product displayed a filter and applied
nothing.

JEV rather than a generative call because the decision is one member of a closed
set and the threshold has to be applied to a provider-computed confidence:
[`contextual-routing.md`](contextual-routing.md)'s 2026-08-12 entry records the
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

**What a future change has to respect:** the object is the authority. A delivery
path may compute a verdict, but `admitExternalEvent` decides, and a gated event
without an admitting verdict must never start a run — that is the whole defect,
and it is reachable again by moving the enforcement into the caller. The
condition and the event stay separate named fields of the JEV state. And the
confidence threshold is still an open placeholder: the first change to set it owes
the arithmetic, not a guess.
