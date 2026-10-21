# Premature-stop evaluation

Evaluate whether JEV can recognize a final reply that promises to do requested
work instead of delivering it. This is **not** a completeness, quality, or
truthfulness judge. The eval itself never executes a recovery. The production
integration now uses the baseline question with `uncertainty_fallback` at 0.70;
see [completion verification](../../../../docs/agent-harness.md#completion-verification-before-stopping).

The implemented policy favors missed-work recall: **one verification reprompt
when JEV is uncertain, unavailable, or indicates unfinished work**. Only an
answer/result or blocker with confidence strictly above 0.70 accepts a stop.
The model should finish outstanding work or briefly identify the delivered result.
The always-verify policy remains a recall-first comparison control.

The question is one four-way Choice: `announces_unfinished_work`,
`answer_or_result`, `blocker_or_question`, or `unclear`. The original simulated
`strict` policy continues only on `announces_unfinished_work` with confidence **> 0.5**,
resolved context, and lifecycle `ready`. Pending background work, cancellation,
required input, ambiguous writes, an already-used recovery, and unknown state
suppress continuation. The original policy lets the turn end on provider failure. The agreed evaluation
deadline is one second, with no retries or fallback model.

## Corpora and provenance

- **Real:** 120 cases from Juno Labs (84) and Forward Search (36), covering
  78 thread responses and 42 breakout responses across 61 conversations and
  40 parent-thread families. Run dates span September 10–October 21, 2026.
- **Synthetic:** 60 authored cases, including setup-only promises, delivered
  results, genuine blockers, requested plans, optional offers, nonadjacent
  references, corrections, delegation, ambiguous writes, cancellation,
  exhausted recovery, misleading tool content, and missing context.

The private inventory contains the exact sampling decisions and source IDs.
We selected recently active October threads, excluded digest titles and
background-agent conversations, and exported up to six recent completed runs
per conversation. The 65 exported conversation aliases yielded 190 unique runs.
The real suite selects 114 cases for coverage, plus six older cases found by a
targeted promise/failure search. This is a purposeful diagnostic sample, not a
measurement of production failure prevalence.

Only `runs.final_turn_id` is a candidate final; intermediate progress messages
are not negative examples. Alias runs are deduplicated. A shared run joins its
alias thread IDs into a family, and the family hash determines development or
holdout. Synthetic variants share their scenario family. The split is 58/62 for
real and 27/33 for synthetic.

Reference labels and rationales were authored by Codex before JEV predictions;
they are **not human-adjudicated gold labels**. The first real run exposed four
fixture errors. The protected correction ledger preserves before/after labels
and lifecycle state. The baseline retains both runs. The corrected run uses
the same already-inspected holdout, so it is not a new blind evaluation. The
JEV question and confidence threshold were not tuned for those original runs.
The subsequent confidence sweep below replays the saved answers without new
inference or relabeling.

## Decision-time context

Each case includes the exact triggering turn, proposed final reply, explicitly
linked antecedents, and non-assistant messages delivered during execution.
Structured elicitation answers are decoded rather than treated as blank text.
The builder carries current-run tool operation, target, status, summary or
failure reason, and available output references. These are tool-effect receipts,
not full provider outputs or proof that every task requirement was satisfied.

There is no fixed "last N messages" cutoff. An annotation links the older turns
that resolve the current reference, even when nonadjacent; unrelated intervening
history is omitted. Missing trigger/context is marked unresolved. The builder
rejects future antecedents, excludes calls started after the final, and masks
outcomes that settled later. Parent-thread context is not automatically merged
into a breakout. The current suite's links are curated offline; production
context differs: it uses all surviving conversation text in the current Bind
projection, including compaction checkpoints, plus authoritative lifecycle and
current-execution receipts. It does not perform a separate history search.

## Revised policy: prioritize reprompt coverage

The user's October 21 preference is explicit: an unnecessary verification turn
costs less than failing to deliver. The original automatic-recovery recommendation
used the wrong tradeoff. Replaying the **same saved JEV judgments** gives:

| Policy | Caught / needed reprompts | Missed reprompts | Extra verification turns |
|---|---:|---:|---:|
| Original strict gate | 17/19 | 2 | 1 |
| Reprompt on uncertainty, missing context, or provider failure | 18/19 | 1 | 8 |
| One verification pass at every eligible stop | 19/19 | 0 | 106 |

The uncertainty fallback recovers the real publication stop, but misses the
synthetic calendar case because JEV confidently mislabels it as a result.
The initial `verify_once` recommendation therefore did not give JEV a veto over that
first verification turn. The later 0.70 sweep and prompt comparison below led
to implementing the uncertainty fallback at that threshold. Further optimization
to skip checks should still be evaluated primarily on missed reprompts.

The intended production scope is action requests. This corpus does not label
action admission separately, so the broad replay also checks eligible answers
and acknowledgements: 125 total checks across 180 cases. Its 106 extra checks
are an overhead measurement, not 106 demonstrated harmful executions. Zero
misses is true by construction for eligible stops; it does not establish that
the main model will successfully finish the work after being reprompted.

Use the verification prompt in `policies.ts` with the main model's existing
conversation and tool context. It asks the model to finish outstanding work,
inspect receipts before repeating actions, and briefly identify the delivered
result when already done. It is a check, not an instruction to blindly retry.
Keep one durable recovery marker per logical activation, and preserve actual
cancellation, pending-background, required-input, ambiguous-write, and spent-
recovery exclusions. Unknown lifecycle needs authoritative resolution; an
unavailable judge alone does not prevent a verification turn.

`policy-comparison-2026-10-21.json` preserves the replay, source-report hashes,
and exact verification prompt. No new JEV calls or task executions were made
for this comparison. Next evaluate the verification turn itself: whether it
delivers missing work, correctly confirms completion, or duplicates an action.

## Confidence sweep

`confidence-sweep-2026-10-21.json` records 21 thresholds from 0.00 to 1.00 in
0.05 increments, using the same 120 corrected real and 60 synthetic judgments.
Each threshold reports both policies, the always-verify control, and separate
suite and development/holdout counts. Lifecycle exclusions stay fixed.

For `uncertainty_fallback`, the threshold is the confidence required to **accept
a stop**: unfinished/unclear judgments always reprompt, and answer/result or
blocker judgments only allow stopping when their confidence is strictly above
the threshold. Missing judge context or a provider failure also reprompts.
Higher thresholds therefore increase verification coverage.

| Stop-acceptance threshold | Needed reprompts caught | Missed | Extra checks | Total checks |
|---|---:|---:|---:|---:|
| 0.30 | 18/19 | 1 | 4 | 22 |
| 0.50 | 18/19 | 1 | 8 | 26 |
| 0.60 | 18/19 | 1 | 13 | 31 |
| 0.65 | 19/19 | 0 | 13 | 32 |
| 0.70 | 19/19 | 0 | 13 | 32 |
| 0.80 | 19/19 | 0 | 15 | 34 |
| 0.90 | 19/19 | 0 | 22 | 41 |
| 0.95 | 19/19 | 0 | 35 | 54 |
| 1.00 / verify every eligible stop | 19/19 | 0 | 106 | 125 |

**0.70 is a useful next experimental candidate:** it has the same measured
overhead as 0.65 while allowing a wider uncertainty fallback. It catches the
calendar false-result judgment at confidence 0.63. At 0.70, the real suite
catches its one positive with nine extra checks; synthetic catches 18/18 with
four extra checks. The already-inspected holdout catches 11/11 with eight extra
checks, and development catches 8/8 with five extra checks.

The original `strict` policy has the opposite direction: raising its threshold
suppresses reprompts. Lowering it to 0.30 catches the real publication stop but
still misses the calendar case because its predicted label is answer/result.
It cannot catch all 19 at any tested threshold. Changing the fallback behavior
is essential; changing only that original confidence floor is insufficient.

This is exploratory tuning on observed cases, not a fresh generalization test.
There is still only one eligible real positive, and JEV confidence is not a
calibrated probability of completion. The sweep changes no production default;
validate the 0.70 candidate on new thread families and actual verification-turn
outcomes before treating the reduced overhead as established.

The `eval:premature-stop:policies` command below now includes this sweep in its
output. Original baseline and policy-comparison files remain unchanged.

## Prompt optimization at 0.70

**Keep the baseline prompt for the 0.70 experiment.** Three frozen variants were
compared with baseline using fresh JEV 1.14.0 calls, unchanged cases, a one-second
deadline and `uncertainty_fallback`. Each ran twice on 85 development cases.
Selection prioritized worst-repeat missed reprompts, then mean extra checks,
unavailable responses and label errors; baseline won exact ties.

| Development variant | Missed / 8 needed, runs 1 / 2 | Extra checks, runs 1 / 2 |
|---|---:|---:|
| Baseline | 0 / 0 | 5 / 5 |
| Clearer in-progress versus completed wording (`temporal`) | 0 / 0 | 5 / 5 |
| Resolve active request through follow-ups (`active_request`) | 0 / 0 | 4 / 4 |
| Shorter rubric (`compact`) | 0 / 0 | 6 / 4 |

The selected development winner, `active_request`, and baseline then each ran
twice on the same 95 holdout cases, without further prompt changes:

| Holdout variant | Missed / 11 needed, runs 1 / 2 | Extra checks, runs 1 / 2 |
|---|---:|---:|
| Baseline | 0 / 0 | 8 / 8 |
| Active request | 1 / 1 | 9 / 8 |

The regression was the synthetic calendar promise: “I found the event. I'm
moving it to Thursday at 2 PM.” Both prompts labeled it `answer_or_result`, but
the candidate's higher confidence bypassed verification. The baseline stayed
below 0.70 and correctly reprompted. That missed recovery outweighs saving one
development check. Across development and holdout, baseline caught all 19 needed
reprompts with 13 extra checks in each repeat; the candidate caught 18 with
13 and 12 extras. These are two runs of 180 cases, not 360 independent cases.

Baseline reprompt decisions were identical across repeats. The candidate changed
one holdout reprompt decision, and compact changed two development decisions.
There were no unavailable responses in 1,060 calls. Run-level p95 latency ranged
from 180 to 253 ms. The content-free
[`prompt-optimization-2026-10-21.json`](prompt-optimization-2026-10-21.json)
preserves the frozen plan, hashes, selection, per-suite scores and repeat
stability; exact requests and responses remain private.

This holdout was already inspected in earlier evaluations and threshold tuning.
It is a regression comparison, not fresh evidence of generalization. There is
only one eligible real positive, and actual verification-turn outcomes remain
untested. This experiment changed no production prompt or threshold; the later
implementation adopts baseline at 0.70. Keep the variants as
reproducible experiments; collect new families before another selection round.

## Original results: JEV 1.14.0

| Suite | Label matches | False continuations | Missed continuations | p95 latency | Unavailable |
|---|---:|---:|---:|---:|---:|
| Synthetic | 58/60 | 0/42 negatives | 1/18 positives | 202 ms | 0 |
| Real, initial fixtures | 112/120 | 4/119 negatives | 1/1 positive | 247 ms | 0 |
| Real, corrected fixtures | 114/120 | 1/119 negatives | 1/1 positive | 183 ms | 0 |

The corrected real holdout has 59/62 label matches and one false continuation;
it contains **no continuation-positive case**, so its recall is undefined.
Synthetic holdout has 31/33 label matches, zero false continuations, and one
miss out of 11 continuation-positive cases.

The real publication stop remained below the confidence threshold (0.35).
A blocked Terminal task was confidently called unfinished work (0.81), creating
an unwanted recovery. Lowering the threshold alone cannot separate these two.
The synthetic miss describes moving a calendar event after finding it, without
an update receipt. The other synthetic label error is an unresolved reference;
the context gate correctly prevents continuation.

Real request sizes were roughly 1,953 input tokens at p50 and 6,840 at p95,
including the question; synthetic requests were 1,125 and 1,152. These runs do
not show a latency overload, but neither do they prove that context length has
no effect on quality. No context-length ablation or production Worker latency
measurement was performed.

These results describe the original strict gate. Under the revised preference,
they motivate a default verification turn, not suppression of recovery because
of extra checks. Independently adjudicate more real premature stops and measure
actual task completion after the verification turn on new thread families.

## Reproduce

Real content, annotations, source IDs, and exact provider exchanges stay outside
Git in `/workspace/jev-completion-private` (directory 0700; files 0600). They are
retained for the requested reusable suite. `baseline-2026-10-21.json` contains
only aggregate results, hashes, and opaque case IDs; synthetic cases are checked
in. Treat the private artifacts according to the organization's retention rules.

From the repository root, with `TYPESAFE_API_KEY` available:

```bash
corepack pnpm --filter @rally/agent-harness eval:premature-stop:build \
  /workspace/jev-completion-private/combined-raw.jsonl \
  /workspace/jev-completion-private/real-annotations-v2.jsonl \
  /workspace/jev-completion-private/real-cases-v2.jsonl

NODE_USE_ENV_PROXY=1 corepack pnpm --filter @rally/agent-harness eval:premature-stop \
  /workspace/jev-completion-private/real-cases-v2.jsonl \
  /workspace/jev-completion-private/real-rerun.json jev-1.14.0 1000

cp packages/agent-harness/evals/premature-stop/synthetic-cases.jsonl \
  /workspace/jev-completion-private/synthetic-cases.jsonl
chmod 600 /workspace/jev-completion-private/synthetic-cases.jsonl
NODE_USE_ENV_PROXY=1 corepack pnpm --filter @rally/agent-harness eval:premature-stop \
  /workspace/jev-completion-private/synthetic-cases.jsonl \
  /workspace/jev-completion-private/synthetic-rerun.json jev-1.14.0 1000

corepack pnpm --filter @rally/agent-harness exec vitest run \
  evals/premature-stop/evaluation.test.ts evals/premature-stop/policies.test.ts

corepack pnpm --filter @rally/agent-harness eval:premature-stop:policies \
  /workspace/jev-completion-private/policy-rerun.json \
  /workspace/jev-completion-private/real-report-v2.json \
  /workspace/jev-completion-private/synthetic-report.json
```

The live runner also accepts `[threshold] [variant]` after `[timeoutMs]`;
defaults remain `0.5 baseline`. For example, replay the frozen holdout with:

```bash
NODE_USE_ENV_PROXY=1 corepack pnpm --filter @rally/agent-harness eval:premature-stop \
  /workspace/jev-completion-private/optimization-holdout.jsonl \
  /workspace/jev-completion-private/holdout-baseline-rerun.json \
  jev-1.14.0 1000 0.70 baseline
```

`prompt-variants.ts` defines `baseline`, `temporal`, `active_request`, and
`compact`. Baseline imports the exact production question from
`src/completion-verification-question.ts`, and `policies.ts` shares the production
fallback mapping and verification prompt. Moving the question into production
preserved its serialized hash from the frozen baseline report. The protected `optimization-development.jsonl` and
`optimization-holdout.jsonl` concatenate the real-v2 and synthetic cases, then
filter on their existing `split`; the experiment changes no fixtures.

`NODE_USE_ENV_PROXY=1` is required in the managed cloud environment. Inputs and
outputs must share a protected directory. The sequential runner writes full
private reports and content-free `.summary.json` files with corpus/question
hashes, resolved model, errors, confusion matrices, operational precision/recall,
latency, tokens, and split/org/kind/lifecycle/tag slices. Current runner reports
also hash its implementation files. Provider errors stay in the operational
denominator and are excluded from available-response label accuracy. Top-level
`nudge`/`gate` fields retain the original strict baseline for comparison; current
reports also include all three `policyComparisons` at the requested threshold
and mark `uncertainty_fallback` as the policy under optimization. This report
metadata does not change the production policy or the always-verify control.
The separate policy replay requires no API key.

`export.sql` is the read-only per-conversation export. For a fresh collection,
use authoritative org/thread/breakout inventories and check `background_agent`;
for targeted older cases replace only the selected-runs filter with explicit
run IDs. Keep those IDs and raw exports private. Freeze annotations before
calling JEV and preserve later corrections as a new dataset revision.
