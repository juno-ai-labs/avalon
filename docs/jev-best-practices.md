# JEV best practices

JEV is most useful when an application can state a small decision precisely:
give it semantically named state, ask one bounded question, and make every
answer mean something operational. Treat its confidence as a routing signal to
calibrate against real outcomes, not as correctness by definition.

This guide covers designing and optimizing JEV requests. Rally's addressing
classifier is the worked example because it has a 153-case production replay,
an independently adjudicated hard subset, prompt ablations, a held-out repeat,
and a measured fallback. [`agent-harness.md`](agent-harness.md) owns the shipped
runtime. The committed content-free
`packages/agent-harness/evals/addressing/baseline-2026-09-16.json` records the
aggregate baseline; case-level reports are ephemeral protected-scratch output.
[Deciding what should be a JEV request](#deciding-what-should-be-a-jev-request)
says which decisions in this tree are candidates and which are deliberately
not, and [Adding another classifier](#adding-another-classifier) is the order
of work for the next one.

## Optimize the whole application request

For JEV, “the prompt” is not one string. The application-controlled contract is
the complete `state`, `questions`, primitive types, choice criteria, and model
alias sent to TypeSafe. Preserve and compare that whole request. A report that
shows only the question text cannot explain whether an improvement came from
wording, better state, different choice names, or additional context.

During an authorized evaluation, the protected scratch artifacts contain the
full application-supplied JEV request and input state used for each case. They
do not contain or claim to reproduce any internal provider instructions
TypeSafe does not expose. Delete those artifacts with the raw corpus after
recording content-free aggregate evidence.

## Start with the decision contract

Write the downstream action before writing the JEV question. A useful contract
answers four things:

1. What entity is being judged?
2. Which outcomes are operationally distinct?
3. What evidence separates adjacent outcomes?
4. What happens when confidence is insufficient?

If two answers lead to the same action, combine them. If one answer can lead to
two incompatible actions, split it. Do not ask JEV to discover the product
policy: encode that policy in the question and criteria.

For Rally addressing, the operational decision is who should act now. The
four-way contract is therefore `rally_should_act`, `people_only`,
`rally_and_people_should_act`, or `no_clear_request`. Labels such as `yes`, `no`,
`positive`, and `other` would hide the meaning JEV needs to distinguish.

## Choose the right primitive

Use **Choice** when the application needs one member of a closed set and each
member has a distinct meaning. Choice is the default for routing, policy,
intent, ownership, and lifecycle decisions.

Use **Noul** when the product genuinely needs a scalar degree of one concept,
such as how strongly a message asks an AI agent to act. Noul is useful for
ranking or thresholding a single semantic axis. It is a poor substitute for a
multi-class policy when the negative side combines several different states.

Rally's data illustrates the distinction. The simple Noul question “Does this
ask or imply an AI Agent to do work?” reached 73.47% binary accuracy at a `0.5`
threshold and 78.91% at its best observed threshold of `0.65`. The baseline
Choice reached 82.99% on the comparable binary overlay, while the optimized
Choice reached 92.16% binary accuracy across the full 153 cases. Addressing is
not merely a degree of “agent work”: human coordination, social reactions,
genuine ambiguity, and independently assigned human-plus-agent work are
different policies.

**A boolean-looking decision is not automatically a Noul, and the threshold curve
is a reason on its own.** The semantic trigger gate asks whether one event
satisfies one written condition, which is a yes-or-no question underneath, so it
was measured both ways over 274 cases. The best Noul tied the winning Choice on
the product objective and lost on three counts: worse calibration on the fire
decision, eight points less three-class accuracy because one scalar cannot say "no
event of this kind could settle this", and the shape of its threshold curve. For a
Choice the label carries the decision and the curve is flat from `0` to `0.5`; for
a Noul the scalar *is* the decision, so the curve has a peak and then a cliff —
0.860 at `0.5`, 0.787 at `0.7`, 0.613 at `0.8`. A later well-meaning edit towards
safety costs a third of the recall on the Noul and nothing on the Choice. Prefer
the primitive whose failure you will notice. A **hybrid** that keeps the scalar and
adds a second Choice for judgeability is available and cost-free at runtime — both
questions answer in one round trip — but it did not recover the third class here:
its second question claimed events that could in fact settle their condition.

Do not decompose one mutually dependent decision into independent questions
without evidence. Rally's two-question decomposition — whether Rally should act
and whether people should act — scored 25.93% four-class accuracy on the
development split even though its binary accuracy looked much healthier. The
two answers lost the shared boundary that one Choice question expressed.

## Model the state explicitly

JEV performed best when the request named the state it was reasoning over.
Prefer a small object with stable semantic fields over a prose transcript or a
bag of hints.

The addressing request separates three roles:

```json
{
  "current_message": {
    "text": "input.message",
    "explicitly_addresses_rally": "input.addressesRally",
    "mentioned_people": "input.humanMentions",
    "mentioned_connectors": "input.connectorMentions"
  },
  "current_agent_state": {
    "task_active": "input.activeTask"
  },
  "conversation_context": {
    "recent_messages": "input.recentMessages"
  }
}
```

Apply these rules:

- Put the subject of the decision in its own field. Do not make JEV infer which
  message, record, or event is current.
- Separate current input, application state, and historical context. This lets
  the question say exactly how each may be used.
- Derive structural facts upstream when the application knows them more
  reliably than the model. Resolved mentions and an explicit product-address
  flag are better inputs than asking JEV to rediscover markup conventions.
- Use names that describe meaning, not storage. `mentioned_people` is useful;
  `mention_rows_v2` leaks implementation detail without improving the decision.
- Include only fields that can change the answer. Every extra field is another
  signal JEV can over-weight.
- Keep the shape and types stable across evaluation and production. A prompt
  comparison is invalid if one candidate also receives better state.

State should preserve the source content exactly when wording matters. Derived
fields augment the source; they do not replace it.

## Write Choice questions for boundaries

A strong Choice definition has three layers:

- **Question:** the single decision in plain language.
- **Focus:** what to judge and the limited role of context.
- **Decision:** an explicit instruction to choose one outcome.

Each criterion then carries:

- **Meaning:** the positive definition.
- **Include:** representative situations that belong.
- **Exclude:** the nearest confusing situations that do not.

Rally's winning instruction is:

```json
{
  "question": "Who is expected to act on `current_message.text` now?",
  "focus": "Judge the current message. Use `conversation_context.recent_messages` only to resolve references, implied addressee, or continuation.",
  "decision": "Choose exactly one actor pattern."
}
```

The most important prose lives at boundaries, not in long lists of easy
examples. For example, the distinction between `rally_should_act` and
`rally_and_people_should_act` is that mentioning, discussing, or doing work for
a person does not give that person an independent action. That exclusion
prevents a common false `both` classification.

Keep criteria symmetric. If one option describes acknowledgements and FYIs as
negative evidence, the competing option should claim those cases positively.
Do not leave a gap for the model to resolve differently from run to run.

Make catch-all outcomes narrow. `no_clear_request` means the actor genuinely
cannot be determined because the input is conflicting, gibberish, or an
unresolvable fragment. It does not mean “the model feels unsure.” Ordinary
uncertainty belongs in confidence; semantic ambiguity belongs in the choice.

## Optimize by ablation, not prompt accumulation

Change one representational idea at a time and preserve every candidate's exact
request. Rally used this sequence on a deterministic 27-case development split:

| Candidate | Change | Four-class accuracy | Binary accuracy | p75 latency |
| --- | --- | ---: | ---: | ---: |
| Semantic | One compact prose question and string criteria | 51.85% | 74.07% | 290 ms |
| Structured | Named question/focus/decision and meaning/use/not-for | 74.07% | 77.78% | 256 ms |
| State | Structured criteria plus named application state | 81.48% | 88.89% | 244 ms |
| Decomposed | Two independent Choice questions | 25.93% | 81.48% | 275 ms |

This does not prove that more structure always wins. It shows which change won
for this decision and corpus. Keep a compact candidate in the comparison so the
team can see when additional wording stops buying accuracy.

Use this loop:

1. Freeze the task definition and label mapping.
2. Preserve a production-shaped corpus, including repeated cases when
   production frequency matters.
3. Create a deterministic development/holdout split before tuning.
4. Establish the smallest reasonable baseline.
5. Make one change: state shape, choice names, boundary wording, context, or
   decomposition.
6. Inspect the confusion matrix and individual regressions, not only aggregate
   accuracy.
7. Keep changes that fix a recurring error class rather than one memorable row.
8. Run the winner once on untouched holdout data, then repeat the identical
   request to check stability.
9. Choose the confidence policy and fallback only after the primary request is
   frozen.

Do not tune on the full corpus and call the result generalization. Rally tuned
on 27 deterministically selected hard cases and evaluated on an untouched
126-case holdout. The winning request scored 91.27% on that holdout and produced
identical classifications on a second holdout run.

| Scope | Cases | Four-class accuracy | Binary accuracy |
| --- | ---: | ---: | ---: |
| Full optimized run | 153 | 89.54% | 92.16% |
| Untouched holdout | 126 | 91.27% | 92.86% |
| Identical holdout repeat | 126 | 91.27% | 92.86% |

**Do not assume that repeat is free.** Addressing's holdout repeat reproduced its
classifications exactly; the semantic trigger's did not. Repeating six candidates
three times there moved three-class accuracy by 1.4 points at the median and 4.1
at worst, which is larger than most of the differences a generation produces. So
measure the floor first, on repeats of the candidates you already have, and then
read every later comparison against it: **a difference smaller than a candidate's
own spread across its repeats is not a difference.** One run of eleven candidates
is a story about that run, and the cheapest way to find out which of the two
regimes a decision is in is to repeat the baseline before ranking anything
against it.

The [premature-stop prompt experiment](../packages/agent-harness/evals/premature-stop/README.md#prompt-optimization-at-070)
held its stop-acceptance threshold at 0.70 and repeated baseline plus three
variants on development. The development winner saved one extra check, but
missed a required reprompt in both holdout repeats; baseline missed none. The
candidate made an incorrect result judgment more confident, bypassing the
fallback. Keep baseline: optimize the operational decision, including confidence,
not label agreement alone. This reused holdout is a regression comparison,
not a fresh generalization test.

## Build ground truth that can disagree with production

The [premature-stop suite](../packages/agent-harness/evals/premature-stop/README.md)
compares 120 real thread/breakout cases with 60 synthetic cases using a dedicated
Choice question. Its October 21 baseline shows why classifier accuracy and the
downstream action need separate scores: 95% real label agreement still missed
the one eligible real recovery and triggered a continuation on a blocked task.
The labels are Codex-authored, and the corrected run reuses an inspected holdout.
The user's preferred tradeoff now favors a verification reprompt over missed
work: uncertainty fallback catches 18/19 needed reprompts, while checking once
at every eligible stop catches 19/19 by construction. This removes JEV's veto
over that first check, with extra verification turns measured as overhead. The
main-model verification turn still needs an outcome evaluation; replaying the
gate does not demonstrate completed tasks. Preserve source-linked context,
authoritative lifecycle state, the one-use recovery marker, fixture revisions,
and provider failures in future evaluations of this decision.

The subsequent 0.70 confidence sweep and repeated prompt comparison selected
baseline plus uncertainty fallback for the
[production completion check](agent-harness.md#completion-verification-before-stopping).
The host enforces lifecycle exclusions and persists one verification nudge per
execution. Production and evaluation share the same question and decision
mapping. Integration tests prove the loop continues and persists its marker;
they do not establish live-model recovery success.

Historical production output is a regression label, not automatically the
correct answer. Keep it because it tells whether behavior changed, but add an
independent adjudication layer for correctness.

Rally's corpus contains 153 retained calls, 152 production labels, and 54
independent GPT-Sol medium adjudications. The accuracy overlay uses the Sol
judgment where one exists and the production label elsewhere. This makes the
remaining uncertainty explicit instead of relabeling all historical behavior
as truth.

Record at least:

- the raw input and structured state;
- the exact question and criteria;
- requested and resolved JEV model versions;
- answer, confidence, and returned probabilities;
- latency and token usage;
- production label and independent label separately;
- whether a result was excluded and why.

Preserve duplicates when measuring expected production behavior. Deduplicate
only for a separate diagnostic view, otherwise a rare sentence can count as
much as a recurring user pattern.

Class support matters. Rally's overlay has 79 `agent_action`, 67 `human_only`,
one `both`, and six `uncertain` cases. The strong aggregate result does not
establish reliable performance for the two sparse classes. Add targeted cases
before changing those boundaries or interpreting their per-class metrics.

## Calibrate confidence as an operational signal

Confidence is useful when it separates correct from incorrect cases in the
actual distribution. It is not proof that the selected answer is correct.

The premature-stop eval's exploratory confidence sweep illustrates the direction
of the threshold. Requiring confidence above 0.70 before accepting an answer or
blocker as a reason to stop caught 19/19 needed reprompts with 13 extra checks,
compared with 18/19 and eight extras at 0.50. Always checking caused 106 extras.
Lowering the original unfinished-label acceptance threshold could not catch the
confidently wrong answer/result label. The sweep reuses inspected cases and has
only one real positive. Production now adopts the baseline at 0.70 under the
recall-first policy: uncertainty or judge failure triggers one verification
turn. This is an operational threshold, not a calibrated probability of
completion, and still needs validation on new thread families. See the suite's
[confidence sweep](../packages/agent-harness/evals/premature-stop/README.md#confidence-sweep).

For the optimized Rally Choice, mean confidence was 0.848 on correct cases and
0.586 on incorrect cases. That separation supports a fallback policy, but the
overlap means no threshold eliminates errors.

Evaluate confidence with:

- accuracy by confidence bin;
- coverage and accuracy at each candidate threshold;
- correct and incorrect mean confidence;
- Brier score or another calibration error for binary decisions;
- per-class behavior, because one global threshold can hide a weak class;
- cascade accuracy, latency, and cost after fallback, not the primary in
  isolation.

State threshold semantics exactly. Rally accepts JEV only when confidence is
strictly greater than `0.5`; a result equal to `0.5` falls back. That boundary is
covered by a regression test. Avoid `>=` in one service and `>` in another.

Choose a threshold against product loss, not the accuracy maximum alone. A
false invocation and a missed invocation have different costs, and fallback
coverage adds latency. The selected Rally threshold routes 20 of 153 measured
cases to fallback. Raising it may improve primary precision while making more
messages pay the fallback's multi-second latency.

**Score the decision, not the label, and write the price list down before
ranking anything.** A candidate that answers correctly at a confidence the gate
rejects is a miss in production, and accuracy cannot see that: on the semantic
trigger corpus the accuracy winner had fifteen unwanted fires and the accuracy
loser shipped. Two rules came out of getting this wrong twice.

- **The direction of the asymmetry is the product's, not a tuning knob.** That
  gate's first objective charged a false fire double a miss, reasoning that an
  unwanted fire starts an agent run. What it missed is what the run *does*: it
  opens with a capable model that decides for itself whether there is anything to
  act on, so the unwanted fire costs one session and the miss costs the request.
  The whole ranking was backwards. Ask what is behind the gate before pricing its
  errors, and keep the weights in one named place so the ranking can be
  re-derived rather than re-run.
- **Sweep the threshold through one implementation of the gate's own rule.** The
  same sweep read that rule twice, once for the fires and once for the misses, and
  the second copy applied the Choice rule to a Noul — which pinned its missed
  count to a fixed verdict and printed its recall as flat across the whole sweep.
  A threshold recommendation nearly came out of that table. The number a
  classifier's gate is set to is exactly as trustworthy as the code that drew the
  curve.

The per-case answers are worth keeping for the same reason: a stored run can be
re-scored under a new price list without calling the provider, which is what makes
"what would this have ranked under the corrected objective" a minute's work rather
than a re-run with fresh sampling noise on top.

**A price list fixes the decision rule, so derive it before arguing about the
threshold.** Writing `p` for the probability the classifier's positive answer is
right and `c`, `f`, `m` for the weights on a correct decision, a false positive and
a miss, acting beats not acting when `p > (c − f) / (2c − f − m)`. Rally's semantic
trigger gate prices those at 1, 0 and −2, so its optimal gate fires whenever a
calibrated P(match) exceeds **0.25** and never lower. That number settles an
argument that otherwise has no floor: "a miss is expensive, so err towards acting"
is true, and it stops being true at one in four, because below that the cases being
picked up are mostly negatives and three cheap errors cost as much as the expensive
one they avoid. The confidence a Choice reports is not `p` and is usually not
calibrated, so the operating point still comes from a sweep — but the derived
number tells you which direction a sweep result can be trusted in.

**Inverting the question to change which way uncertainty falls is worth trying and
did not work here.** A positive question fires on a confident yes, so every
hesitant right answer is scored as the expensive error. Asking the negative
question instead — "should this be ignored?", refusing only on a confident yes —
inverts that, and on the semantic trigger corpus it did exactly what it was
designed to do: misses fell to near zero and recall reached 99%. It lost anyway,
for two reasons worth knowing in advance. The bill was 60 to 75 unwanted
invocations per 151 cases, which is what firing at P(match) ≈ 0.05 costs against a
derived floor of 0.25. And the negation **damaged the label itself**: compared at a
threshold of zero, where the fall-through is inactive and only the question
differs, three-class accuracy fell 10 to 16 points and the fire-decision Brier
roughly doubled. The model is worse at the discrimination when asked to find a
reason to refuse than when asked to find a reason to act, and that is not a wording
problem another generation fixes.

## Measure latency end to end

JEV reports provider evaluation time, but the user pays end-to-end request
latency. Record both and do not substitute one for the other.

For the optimized 153-case run, JEV end-to-end latency was approximately 219 ms
p50, 262 ms p75, 322 ms p90, and 346 ms p95. The unchanged 126-case holdout
repeat was approximately 214 ms p50, 267 ms p75, and 306 ms p90. These are
observations from `jev-1.13.0`, not permanent service guarantees.

Report:

- p50 for the common path;
- p75 because it is sensitive to a fallback added to a meaningful minority;
- p90 and p95 for user-visible tail behavior;
- maximum as diagnostic evidence, not a planning percentile;
- first-attempt failures and recovered retries separately;
- total cascade latency for routed cases.

Run provider comparisons sequentially unless concurrency is itself the subject
of the experiment. Otherwise one candidate's throttling changes another's
latency. Keep the state and question bytes identical across repeated trials.

## Design the fallback as part of the classifier

A confidence fallback is not an exception handler bolted onto JEV. It is the
second stage of one decision system and must be evaluated on the exact cases it
will receive.

- Evaluate fallback accuracy on the low-confidence subset, not the full corpus.
- Measure cascade accuracy and end-to-end latency, including the JEV call that
  happened first.
- Pin model, provider, reasoning level, and provider fallback behavior when the
  benchmark compared an exact route.
- Treat malformed output, HTTP failure, and confidence below the threshold as
  distinct diagnostics even if all reach the same fallback.
- Bound the primary stage independently so a stuck connection cannot make the
  fallback unreachable. Keep caller cancellation distinct from that owned
  deadline: cancellation terminates work; the deadline permits failover.
- Define a terminal local floor for simultaneous provider failure when the
  classifier gates durable user input. Remote availability must not decide
  whether the product retains the user's message.
- Keep the JEV request fixed while selecting a fallback; otherwise the routed
  subset moves and the comparison is no longer like-for-like.

Rally uses `deepseek/deepseek-v4-flash-0731` at low reasoning through the exact
`wafer/fast` endpoint. For that selected route, OpenRouter model and provider
fallback are disabled, so it cannot silently use an unmeasured provider. A
deliberate model-routing override is a new candidate and needs its own
evaluation.

## Production integration

Validate the response before mapping it into product decisions. A schema error
must name the rejected field without logging the rejected value. Record the
requested alias (`jev-latest`) and resolved model (`jev-1.13.0` in the measured
run), because an alias can move even when application code does not.

For each request, capture:

- provider and model;
- stable trace and inference request IDs;
- request and terminal timestamps;
- success or a field-specific failure code;
- input/output token counts when returned;
- confidence, probabilities, and mapped product decision;
- whether and why fallback ran.

Never log the API key or turn a provider response body into an unrestricted
error message. The exact request and response may contain user content; archive
them only through the same access-controlled inference path used for other
model calls. Production replay corpora remain in access-controlled scratch
storage and are passed explicitly to the eval; Git contains only synthetic
fixtures and content-free aggregates.

Report provider success separately from conditional agreement. A candidate
that is perfect on 99 completed calls and fails the hundredth is not 100%
accurate end to end. Bind reports, judge output, and combined matrices to the
corpus SHA-256 (and the judge to its exact source-report SHA-256) so stale
artifacts cannot form a plausible result.

Decide retry ownership once. A retry inside the JEV client and a retry around
the entire cascade can multiply calls and latency. Record first-attempt success
separately from recovery so a healthy-looking final success rate cannot hide a
degrading primary.

## Common failure patterns

- **Vague labels:** `yes` and `no` make the question carry all semantics and
  make downstream traces hard to read. Use action-shaped names.
- **Context without a focus rule:** history starts competing with the current
  item. Say that context exists only to resolve references, addressee, or
  continuation.
- **Examples without exclusions:** the easy center of each class is clear while
  adjacent boundaries remain undefined.
- **An overloaded negative class:** a Noul score cannot preserve distinctions
  the product needs later.
- **An overloaded uncertain class:** low confidence is treated as a semantic
  outcome, hiding calibration problems.
- **Independent questions for coupled outcomes:** individually plausible
  answers combine into an invalid or poorly calibrated joint decision.
- **Prompt accumulation:** every failure adds another sentence until criteria
  contradict or dilute one another. Cluster errors and replace a boundary rule.
- **Tuning on production labels alone:** the new request is rewarded for
  reproducing old mistakes.
- **Reporting only average latency or accuracy:** class collapse and tail costs
  disappear.
- **Changing primary and fallback together:** the fallback is tested on a
  different routed population from the one it will serve.

## Review checklist

- [ ] The downstream action and cost of each error are written first.
- [ ] Choice is used for a closed policy decision; Noul is used only for one
      genuine scalar concept.
- [ ] State separates the current subject, application facts, and context.
- [ ] Field and choice names carry domain meaning rather than implementation
      names.
- [ ] Every Choice criterion has a meaning plus include/exclude boundaries.
- [ ] Context has an explicit, narrow role.
- [ ] Ambiguity is separated from low confidence.
- [ ] Development and holdout cases were split before tuning.
- [ ] Production labels and independent judgments remain distinguishable.
- [ ] Confusion matrices and sparse-class support accompany aggregate accuracy.
- [ ] Confidence is calibrated against correctness and cascade cost.
- [ ] Threshold equality semantics are explicit and tested.
- [ ] End-to-end latency and provider evaluation time are reported separately.
- [ ] The exact winning request is repeated on untouched holdout data.
- [ ] Requested and resolved JEV versions are recorded.
- [ ] Schema, HTTP, retry, and fallback outcomes are observable without leaking
      credentials or rejected values.

## Deciding what should be a JEV request

Today's JEV callers are message addressing, the semantic trigger gate
([`semantic-activity-triggers.md`](semantic-activity-triggers.md)), completion
verification and message continuation, all built on the two transport
primitives in `packages/agent-harness/src/jev/`: a JEV request (`client.ts`,
`questions.ts`), which owns the URL, the transport, the envelope schema, the
field-named schema rejection and the owned deadline and knows nothing about any
one decision, and a confidence cascade (`cascade.ts`), which returns which stage
answered. Every other model-backed decision runs through
`runStructuredInference`. A new caller adds a state shape and a question, not a
transport.

A decision is a candidate when all five are true. The first two are
[the decision contract](#start-with-the-decision-contract); the last three are
what makes a *replacement* worth its cost rather than just a plausible fit.

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
first version is a guess and must be reversible.

### Considered and rejected

Each is more attractive than it deserves to be.

- **Per-instance digestibility.** "Would a person who was away for a day want
  this read back to them?" is a JEV question in the abstract, and it is answered
  by a static per-event-type declaration in each connector manifest
  ([`connectors.md`](connectors.md#declaring-what-a-digest-may-read)). The declaration
  is a *contract*, not a cached judgment: it is reviewable in one place and is
  the reason a connector author has to think about volume before shipping an
  event type. The retired contextual-routing gate also showed that `digestible`
  encodes three different noes and only one of them is about relevance
  ([its retirement record](connectors.md#2026-11-08--retirement-records-suggested-context-connector-digestibility)), so a per-instance
  classifier would answer a different question from the field it replaced.
- **Adding a confidence field to a generative call instead.** Asking an existing
  `runStructuredInference` call for a number alongside its answer and
  thresholding on it. This tree already ran the experiment: contextual routing's
  only quality control was "a constant compared against a number the model made
  up about its own answer". A provider-computed confidence over a closed choice
  set is a different object from a self-report; a self-reported number is not a
  cheap first version of one, it is the thing that failed.
- **Replacing the external-event predicate.** The deterministic matcher is
  intentionally total, fails closed on missing values, and its strict schemas
  make illegal operator/value pairs unrepresentable. A semantic classifier
  belongs *after* it, never instead of it: the predicate is what keeps the
  classifier's population small enough to afford and its state small enough to
  name.
- **The correctable-argument classifier.** `classifyAttemptError` decides
  whether a rejected tool call is the model's fault or a provider's by reading
  whether the arguments fail the declared schema or a code-authored refinement.
  That is structural knowledge the code has for certain; asking a model would
  replace a fact with an opinion.
- **Attachment kind.** `classifyAttachmentKind` reads MIME type and filename.
  Deterministic, cheap, and its failures are wrong icons.
- **Addressing's heuristic floor.** Keep it local and deterministic. It exists
  so that two remote providers being down cannot decide whether Rally retains a
  member's message, and every new JEV stage needs to ask the same question about
  its own terminal floor.
- **Compaction, wake-ups, inbound mail admission.** Token arithmetic, clocks,
  and sender authorization. Nothing semantic is being decided.

## Adding another classifier

In order; the first classifier already paid for the lesson in each step.

1. Write the downstream action and the cost of each error before the question
   ([the contract](#start-with-the-decision-contract)).
2. Build the corpus, split development from holdout *before* tuning, and keep the
   production label and any independent adjudication distinguishable.
3. Ablate one representational idea at a time, preserving each candidate's whole
   request, and keep a compact candidate in the comparison.
4. Choose the confidence policy and the fallback only after the request is
   frozen, and state the threshold's equality semantics in a test.
5. Give the new classifier its own directory under
   `packages/agent-harness/evals/`, shaped like `evals/addressing/`: a
   caller-supplied corpus that is never committed, a content-safe synthetic
   fixture for smoke-testing the runner, a committed content-free aggregate
   baseline, and reports bound to the corpus hash.
6. Log one outcome row per cascade with the stage that answered, and capture the
   request and response through the same access-controlled inference path as
   every other model call.
7. Record the *why* in the changelog of the document that owns the mechanism.

## Rally evidence

The numbers in this guide were derived from ephemeral, owner-only evaluation
artifacts and summarized in the committed content-free baseline. Raw case-level
artifacts are deliberately not retained in the repository: they contain
customer inputs and production identifiers. A future comparison must rerun the
versioned evaluator against a fresh authorized export, inspect the protected
scratch reports, record only content-free aggregates, and delete the scratch
directory when finished.

## Changelog

### 2026-11-08 — The candidate register folded in

**What changed:** `jev-classifier-opportunities.md` is deleted. Its five-part
test, its considered-and-rejected list and its order of work for a new
classifier are the two sections above; its candidate register is gone.

**Why:** every candidate it listed — work-opportunity admission, identity
resolution inside admission, digest settlement and the suggested-work ranking
tournament — belonged to a mechanism the Canvases and Sidekicks pivot deleted,
and the two transport primitives it argued for shipped on 2026-09-18. What was
left was guidance about designing a JEV request, which is this document's
subject. The work-stream icon entry was dropped with it: conversation naming no
longer picks an icon.

Shipped in juno-ai-labs/avalon#1490.
