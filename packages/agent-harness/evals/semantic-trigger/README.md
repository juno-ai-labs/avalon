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
re-running the population.

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
