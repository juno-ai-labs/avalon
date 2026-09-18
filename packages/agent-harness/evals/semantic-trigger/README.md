# Semantic trigger condition evaluation

A GEPA optimization of the JEV request behind
[`semantic-activity-triggers.md`](../../../../docs/semantic-activity-triggers.md):
does one connector event satisfy one Sidekick's written condition?

Unlike the addressing corpus next door, **this corpus is committed**. It is
synthetic — authored by Fable against the real declared event types, then
independently adjudicated — because the feature had never run and there was no
production behavior to replay. That is a real weakness and a real convenience:
nobody's content is in here, so the cases, the candidates and the per-case results
can all live in Git, and a later change can rerun the exact comparison. What it
cannot tell you is how the classifier behaves on the distribution production
actually produces. The first authorized export replaces this, and
[`jev-best-practices.md`](../../../../docs/jev-best-practices.md#build-ground-truth-that-can-disagree-with-production)
says how.

## The corpus

274 cases in two halves, and the second half is the one that matters.

| | Balanced half | Standing watches |
| --- | ---: | ---: |
| Cases | 130 | 144 |
| Distinct conditions | 129 | 12 |
| `condition_met` | 51 | 15 |
| `condition_not_met` | 61 | 129 |
| `condition_not_judgeable` | 18 | 0 |

The **balanced half** is one `(condition, event)` pair per case at a 39% match
rate. That teaches a boundary, and it is not how a Sidekick is used. The
**standing-watch half** is twelve watches, one condition each, over eleven to
thirteen events in sequence: a 10.4% match rate, and three watches whose correct
behaviour is never to fire at all. A request that answers `not_met` to everything
scores 85% there and is worthless, which is exactly the failure the balanced half
cannot see.

Each case carries a label, the family it belongs to, a difficulty flag, and the
author's argument for why that label beats the nearest competing one.

The families are the point. An accuracy number over easy cases measures nothing,
so a majority of the corpus is deliberately hard:

| Family | What it tests |
| --- | --- |
| `near_miss` | Right connector, right event type, wrong subject. |
| `topical_trap` | Shares the condition's keywords, carries no affirmative evidence. |
| `partial_clauses` | A conjunctive condition with only some clauses supported. |
| `wrong_field` | The evidence is there, for a different entity than the condition names. |
| `inference_needed` | The condition needs an inference the event does not state. |
| `unstated_but_true` | Satisfied, but only obliquely or only in the snippet. |
| `negated_condition` | The condition contains a negation. |
| `injection` | The event text tries to restate the criterion. Untrusted evidence must not win. |
| `untestable` | `condition_not_judgeable`: no event of this kind could settle it. |
| `easy_met` / `easy_not_met` | The straightforward remainder. |
| `loop_progression` | A watch's condition against the same work moving through its stages. |
| `loop_bot_actor` | The watch's own automation, or another bot, producing the event. |

**Ground truth is two-layered.** The author's `intendedLabel` is one judgement;
an independent adjudication pass that saw only the condition and the event
produced `adjudicatedLabel`. The overlay scores against the adjudicated label
where one exists and the authored label elsewhere, exactly as the addressing
corpus overlays an independent judge on a production label. The disagreement rate
between the two is the corpus's own uncertainty and is recorded in the baseline
file; a case both layers disagree on is a case whose label is an argument, not a
fact.

## The split

`split.ts` derives it from a SHA-256 of the case id: an even split, 151 cases
tuning and 123 held out. Deterministic and content-free, so it cannot move, adding
a case never moves an existing one, and it was fixed before any candidate was
tuned.

Both halves are sized for what they have to do. The tuning half needs enough cases
that a recurring error class is visible as a class rather than as a coincidence of
two; the held-out half needs enough that a few points of difference is not one case
changing its mind. At this size one case is well under a point, but the resolution
that actually binds is the noise floor below, not the arithmetic.

## What a candidate is scored on

[`objective.md`](objective.md), and it is not accuracy. The runtime does not act
on a label: it fires when the choice is `condition_met` **and** the confidence
clears a threshold. So a candidate is scored on the decision the product makes,
at three thresholds across the band the team set, with **a miss priced at three
times a false fire** — the gate guards a model that decides for itself whether
there is anything to do, so an unwanted session is cheap and a dropped request is
not. Accuracy is still reported, because it diagnoses *why* a candidate loses,
and it decides nothing.

`rescore.ts` re-derives that objective from stored runs without calling the
provider, which is what made the price list a thing that can change without
re-running the population. Nothing derived is *stored*: a report in `reports/`
holds the provider's answer for each case and nothing computed from it, because a
stored score is wrong the moment the price list or the gate rule moves — and both
have moved here. `scoreCase` in [`run.ts`](run.ts) is the one place the derivation
lives, and it runs at read time.

## Running it

```bash
# One or more candidates over the development split.
dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:semantic -- \
  --candidates evals/semantic-trigger/candidates/gen0.json \
  --split dev --output evals/semantic-trigger/reports/gen0-dev.json

# The Pareto front over every generation recorded so far.
pnpm --filter @rally/agent-harness eval:semantic:gepa

# The failure digest one candidate's next mutation is reflected from.
pnpm --filter @rally/agent-harness eval:semantic:gepa -- --digest gen1-state-split
```

```bash
# Re-rank stored runs under the current price list, pooling repeats. No requests.
pnpm --filter @rally/agent-harness eval:semantic:rescore -- \
  evals/semantic-trigger/reports/4?-gen5-dev.json --curve 0,0.3,0.5,0.6,0.7

# Where the threshold should sit: reliability, calibration and the swept gate.
pnpm --filter @rally/agent-harness eval:semantic:calibration -- --split dev
```

`--split holdout` is for the winner, once. Running a holdout measurement more
than once while candidates are still moving turns it into a second development
set, which is the one mistake this whole directory exists to avoid.

## How the optimization ran

GEPA, with Fable as the reflective teacher. Two ideas carry it, and `gepa.ts`
explains both in more depth:

- **Reflection, not a gradient.** Each generation's teacher is handed a failure
  digest — the failing cases grouped by error class, with the full state that
  produced each one and the corpus author's argument for the label — and proposes
  a new contract. Twelve failures spanning every class, not the twelve worst, so
  the teacher writes a boundary rule rather than a lookup table.
- **A Pareto front, not a single best.** A candidate survives if it is best so
  far on at least one case, and parents are sampled by how many cases they
  *uniquely* win. Ranking by mean accuracy alone collapses onto the majority
  class, and the classes that decide this decision are the small ones.

The search was staged deliberately: the first generations were told to explore
broadly — restructure the state, rename or re-partition the outcomes, rewrite the
criteria as decision procedures — and only the later ones were restricted to
single-boundary edits. Exploring after converging finds nothing; converging before
exploring finds a local maximum and calls it a result.

A candidate is the whole application request: the state's field names and shape,
the question, focus and decision, and every criterion's meaning, include and
exclude lists. What it may **not** change is the model alias, the five event
fields the runtime can supply, or the three operational outcomes — those are the
contract with the product rather than free parameters, and a candidate that
answered a different question would score well against a corpus nobody could act
on.

## What it found

Three things, and only the first is a number.

### The shipped request, and the threshold

`gen4-merged` ships, pinned byte-for-byte by `shipped.test.ts` and copied to
[`candidates/winner.json`](candidates/winner.json). Against the request that
shipped first (`gen0-baseline`), pooled over three tuning runs and two holdout
runs:

| | Band utility, dev | Band utility, holdout | Recall at 0.5, holdout | fireBrier, holdout |
| --- | ---: | ---: | ---: | ---: |
| `gen0-baseline` (shipped first) | 0.715 | 0.701 | 71.0% | 0.096 |
| `gen4-merged` (ships now) | 0.817 | 0.813 | 87.1% | 0.082 |

It is 133 words against 227, and the whole difference is subtraction: the
`decision` string is empty, `condition_met` has no include list at all, and
`condition_not_met` has one include instead of three. The one thing it *adds* is
an assertive `condition_not_judgeable` — "no event of this kind could ever settle
the condition, however this one leans" — which is the class every shorter
candidate was quietly dropping.

**The threshold is `0.5`**, and the sweep is why. Pooled over the whole corpus,
this question's utility is flat from `0` to `0.5` (0.844, 0.843, 0.834) and falls
above it (0.822 at 0.6, 0.787 at 0.7), while holdout recall goes 96.8% with no
gate, 87.1% at 0.5, 75.8% at 0.7. So the lever is nearly dead at the bottom and
expensive at the top, and the bottom of the band the team set is the only place in
it worth being. The `0.8` the original placeholder note floated as a starting
point would have dropped a third of the runs somebody asked for.

### A Noul is competitive, and it is not better

The decision is a boolean underneath, so the same question was asked as a Noul —
one scalar, P(the condition is satisfied), no label and no confidence field. Four
Noul candidates were written; the best of them, `w8-noul-reader`, ties the winner
on the objective and loses the tiebreakers:

| | Band utility, dev | Band utility, holdout | fireBrier, holdout | 3-class, holdout | Words |
| --- | ---: | ---: | ---: | ---: | ---: |
| `gen4-merged` (Choice) | 0.817 | 0.813 | **0.082** | **89.8%** | 133 |
| `w8-noul-reader` (Noul) | 0.836 | 0.836 | 0.111 | 81.7% | **115** |

Three findings sit in that table, and they are the useful part:

- **A Noul makes the threshold a live lever, which is a liability here.** For a
  Choice the label carries the decision and the threshold barely moves the
  outcome. For a Noul the scalar *is* the decision, so the curve has a peak and a
  cliff: `w8-noul-reader` scores 0.860 at 0.5, 0.787 at 0.7 and **0.613 at 0.8** on the
  tuning split.
  A later well-meaning "let us be a bit safer" edit is catastrophic on the Noul
  and nearly free on the Choice. Prefer the failure you will notice.
- **A pure Noul cannot express the third class**, so every `not_judgeable` case
  becomes an ordinary non-match. That costs nothing in the product, because both
  answers refuse — but it is why its three-class accuracy is eight points lower,
  and it means the request can no longer tell an author that their condition is
  untestable.
- **A hybrid does not fix that.** `gen5-third-class` adds a second question that
  settles judgeability in the same round trip, and its three-class accuracy went
  *down*, not up (78.5% on holdout). The second question claimed events that
  could in fact settle their condition.

### The recall frontier is flat, and three teachers found the same wall

Once a miss was priced at three times a false fire, three teachers were given the
same instruction — attack the misses — on different parents. All three raised
recall substantially (85.7% to 90.5–96.8% on holdout) and all three paid for it
almost exactly proportionally in false fires (12.5 to 20 per run). Band utility
moved by less than the spread across a candidate's own repeats:

| Candidate | Band utility, dev | Recall at 0.6 | False fires at 0.6 |
| --- | ---: | ---: | ---: |
| `gen5-third-class` | 0.837 | 90.5% | 12.7 |
| `w8-noul-reader` (parent) | 0.836 | 85.7% | 5.7 |
| `gen5-recall` | 0.829 | 91.4% | 15.0 |
| `gen5-choice-recall` | 0.826 | 85.7% | 10.3 |

They moved along the frontier rather than out of it. That is worth recording as a
result: on this corpus the remaining errors are **not** reachable by re-wording
the contract towards recall, and the threshold — not the prose — is the lever
that trades the two. A further generation aimed at recall is not the next thing to
try.

### Asking the negative question does not work, and the reason generalizes

The gate's uncertainty was falling the wrong way. Under the positive question an
answer of "probably a match, 0.4" stops the run, so a hesitant match is scored as
the expensive error — and no threshold fixes that, because the threshold is the
thing doing it. Turning the question around fixes it in principle: ask whether the
Sidekick should **ignore** this event, refuse only on a confident yes, and
hesitation falls through to firing. `polarity` in
[`contract.ts`](contract.ts) is that, and
[`digests/negative-polarity-brief.md`](digests/negative-polarity-brief.md) is the
brief three teachers were given.

**The mechanism works and the trade is bad.** Misses go to almost nothing — 0 to 1
per 453 case-runs, recall 99–100% — and the bill arrives as unwanted sessions:

| Candidate | Band utility | Recall @0.6 | False fires @0.6 | Noisy watches | 3-class |
| --- | ---: | ---: | ---: | ---: | ---: |
| `w8-noul-reader` (positive) | 0.837 | 85.7% | 5.7 | 3 of 12 | 86.1% |
| `gen4-merged` (positive) | 0.808 | 78.1% | 5.3 | 2 of 12 | 84.5% |
| `neg-noul` (negative) | 0.730 | 96.2% | 31.7 | 9 of 12 | 74.8% |
| `neg-state` (negative) | 0.580 | 99.0% | 59.3 | **12 of 12** | 74.0% |
| `neg-choice` (negative) | 0.494 | 99.0% | 74.7 | **12 of 12** | 68.7% |

Two separate things went wrong, and separating them is the useful part.

**The framing damaged the label, not just the calibration.** At a threshold of
zero the polarity's fall-through is inactive and the label decides alone, which is
an apples-to-apples comparison of the two questions: `gen4-merged` scores 0.812
there against `neg-choice`'s 0.667, and `w3-state` 0.830 against `neg-state`'s
0.713. Three-class accuracy drops 10 to 16 points, and the fire-decision Brier
roughly doubles (0.081 to 0.189). The model is simply worse at this discrimination
when it is asked to find a reason to ignore rather than a reason to act. That is
not a wording problem one more generation fixes; it is the negation.

**And the fall-through has a floor that the price list can compute.** From the
matrix in [`objective.md`](objective.md#what-the-price-list-implies-before-any-measurement),
the optimal gate fires when a calibrated P(match) exceeds **0.25** — above that a
fire is worth its risk, below it three cheap errors cost as much as the expensive
one they avoid. So "a miss is expensive, err towards firing" is true and stops
being true at one in four. The negative question drives the effective firing point
to roughly P(match) > 0.05, which is five times too permissive.

That was checked directly, on a third mechanism that needs no new requests:
`rescore.ts --probability-gate` thresholds the provider's own probability mass on
the match label instead of the chosen label's confidence, which is the richest
available reading of the same stored answers. Its curve is flat from 0.2 to 0.6
for every positive candidate — inside the noise floor, so the 0.25 is not
contradicted and not confirmed sharply either — and degrades below 0.2. All three
routes to "let uncertainty fire" agree with each other and with the arithmetic.

**Nothing shipped from this.** The production gate keeps the positive question and
its 0.5 threshold, which sits in the flat region the sweep and the arithmetic both
point at. What the exercise bought is the knowledge that the remaining utility is
**not** in the miss column: recall can be taken to 99% whenever we want it, and it
is not worth having.

### The third class is free to keep and free to drop; its prose is not

`condition_not_judgeable` earns nothing operationally — the product refuses on it
exactly as it refuses on `not_met` — so it was worth asking what it is for. Two
ablations of the winner, three runs each on the tuning split:

| | Words | Band utility | Spread | fireBrier | 3-class | Recall @0.6 | Noisy watches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `gen4-merged` (control) | 133 | 0.819 | 0.011 | 0.081 | 85.4% | 80.0% | 2 of 12 |
| `gen7-two-label` (label deleted) | **71** | 0.814 | 0.024 | 0.082 | 81.2% | 78.1% | 2 of 12 |
| `gen7-two-label-absorbed` | 106 | 0.755 | 0.035 | 0.078 | 83.2% | 70.5% | 1 of 12 |

**Deleting the label costs nothing measurable and halves the contract.** The
utility difference is well inside the spread, the fire-decision Brier is identical
and the watch behaviour is unchanged, at 71 words against 133. The 4.2 points of
three-class accuracy are the ten dev cases it can no longer get right by
construction, and those cost the product nothing because both answers refuse.

**Folding the class's prose into `not_met` is worse**, and legibly so: recall falls
to 70.5%. Telling the model that untestable conditions are non-matches made it
readier to call things non-matches generally. So the label was free and the prose
was a liability — the opposite of what the lineage suggested, since an assertive
third class is what separated this winner from the compact candidates.

**Nothing shipped, and the reason is not the score.** Two things sit outside what
this corpus can settle. The risk of deleting the class is a watch whose condition
can never be settled: with nowhere to put "untestable", its events may lean `met`
and fire on every event of their type — and there are **zero** untestable cases on
a standing watch here, because the adjudicator overrode all seven the authors
labelled that way. The evidence is entirely from the balanced half, which is the
wrong half to learn watch behaviour from. And
[`semantic-activity-triggers.md`](../../../../docs/semantic-activity-triggers.md)
carries "whether `condition_not_judgeable` should reach its author" as an open
question: it marks an authoring defect rather than a run that should not start, and
deleting the class means that surface can never be built without re-running this
optimization. No holdout run has been spent on the two-label variant.

### Evidentially loaded state field names bought nothing

`w3-state`'s thesis was that the state's field names *are* the instruction: it
sends the condition as `standing_rule.fires_only_when` and the event's fields as
`source_tool`, `headline`, `auto_generated_summary` and
`verbatim_excerpt_possibly_truncated`, so a machine paraphrase and a headline are
weighed below the real content without prose having to say so. Its author asked
for the ablation that isolates it, and
[`candidates/w3-flat-state.json`](candidates/w3-flat-state.json) is it: every
criterion string, both remaining instruction strings and all three labels are
byte-identical, and only the state's names change to the flat neutral set the gate
ships with.

| | Band utility | 3-class | fireBrier | u@0 | u@0.5 | u@0.7 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `w3-state` (loaded names) | 0.703 | 85.2% | 0.071 | 0.839 | 0.768 | 0.638 |
| `w3-flat-state` (flat names) | 0.744 | 84.1% | 0.075 | 0.815 | 0.755 | 0.731 |

Three runs each, spread 0.022 and 0.024. The names changed **no labels**:
three-class accuracy, the fire-decision Brier and the confusion matrix are the
same within noise, and at no threshold is the flat version worse by more than its
own spread. What they changed is where the confidences sit — the loaded names make
the reader *less* certain, so its utility falls away faster as the threshold rises
(0.768 to 0.638 against 0.755 to 0.731). Under this price list that is a small
cost rather than a benefit.

So the thesis is not supported here. Naming a field
`verbatim_excerpt_possibly_truncated` did not teach the reader anything it did not
already do with `text_snippet`; it only made it hedge. That is worth knowing before
the next candidate spends its budget on state vocabulary.

## The noise floor, and what is therefore not a result

Three repeats of eleven candidates: the spread between a candidate's own best and
worst band utility is 0.007 to 0.024. **A difference smaller than that is not a
difference**, which is why the tables above stop at three digits and why the
Choice-versus-Noul question resolves on the tiebreakers rather than on 0.02 of
utility.

Every band-utility number published before 2026-09-18 was computed under the
reversed price list — a false fire charged double a miss — and ranked the
population backwards. `objective.md` and
[`digests/restart-brief.md`](digests/restart-brief.md) both say so in place rather
than quietly carrying the old tables.
