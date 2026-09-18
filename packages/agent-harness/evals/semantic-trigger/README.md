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

130 cases across ten connectors, three label classes and eleven case families.
Each case is one `(condition, event)` pair with a label, the family it belongs to,
a difficulty flag, and the author's argument for why that label beats the nearest
competing one.

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

**Ground truth is two-layered.** The author's `intendedLabel` is one judgement;
an independent adjudication pass that saw only the condition and the event
produced `adjudicatedLabel`. The overlay scores against the adjudicated label
where one exists and the authored label elsewhere, exactly as the addressing
corpus overlays an independent judge on a production label. The disagreement rate
between the two is the corpus's own uncertainty and is recorded in the baseline
file; a case both layers disagree on is a case whose label is an argument, not a
fact.

## The split

`split.ts` derives it from a SHA-256 of the case id: an even split, about 65 cases
tuning and 65 held out. Deterministic and content-free, so it cannot move, adding
a case never moves an existing one, and it was fixed before any candidate was
tuned.

Both halves are sized for what they have to do. The tuning half needs enough cases
that a recurring error class is visible as a class rather than as a coincidence of
two; the held-out half needs enough that a few points of difference is not one case
changing its mind. At 65 apiece one case is 1.5 points, which is the resolution
this corpus honestly has: it separates a large effect from nothing and cannot
adjudicate a two-point difference. Every number below is read with that in mind.

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
