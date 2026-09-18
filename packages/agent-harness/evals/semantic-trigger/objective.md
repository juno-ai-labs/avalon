# What a candidate is scored on

Accuracy alone was the wrong objective and this file replaces it. The runtime
does not act on a label; it fires when the choice is `condition_met` **and** the
confidence clears a threshold. So a candidate is judged on the decision the
product actually makes, and on whether the confidence it attached to that
decision was usable.

## The operating band: 0.5 to 0.7

The threshold is set in this band. The evidence behind that: pooling six runs of
the previous leader, accuracy below 0.5 confidence was 42.7% and above it was
flat — 91.9%, 86.0%, 91.3%, 92.1% across the four bins above the cliff. There is
a cliff at 0.5 and no useful gradient above it, so a threshold below 0.5 admits
coin flips and one above 0.7 throws away recall to buy precision that is not
there. Every score below is computed at 0.5, 0.6 and 0.7 and averaged, so a
candidate cannot win by being tuned to one point inside the band.

The band is an input, not a finding: it is where the threshold is allowed to
sit. Where inside it to land is reported from the sweep rather than chosen here,
and **which direction is "safer" depends on which way the question points.**

Under a `match` question the threshold guards the fire, so raising it buys
precision and spends recall — and since recall is the expensive axis, the
objective pulls towards the band's low end. Under an `ignore` question the
threshold guards the *refusal*: raising it means refusing less readily, so it
spends precision and buys recall, and the pull is the other way. Both polarities
meet at zero, where the label decides alone and the confidence is unused. A
candidate declares its polarity and is swept the same way regardless;
`CandidatePolarity` in `contract.ts` carries the argument for why the choice
matters.

## The three numbers, in priority order

### 1. Band utility — what ships

Per case, at each threshold in the band: the product either fires or does not,
and the truth either wanted a fire or did not.

| | Wanted a run | Did not |
| --- | ---: | ---: |
| **Fired** | +1 | 0 |
| **Did not fire** | **−2** | +1 |

**A miss costs double a false fire**, and that asymmetry is the whole product
argument rather than a tuning knob. What sits behind this gate is a
state-of-the-art model that decides for itself whether the event it was handed
is worth acting on, not a destructive action: an unwanted fire buys a session
that concludes there is nothing to do, and the Sidekick's own judgement is the
second line of defence. A miss has no second line. The user asked to be told
when something happened, the thing happened, and the product silently said
nothing — and "the next matching event gets another chance" is no comfort on a
watch whose whole point was this occurrence.

So the cheap error is the one we take. A false fire scores 0 rather than −1,
because the case still counted in the denominator; the cost of firing wrongly
shows up as forgone +1, which is the price of one session.

This is reported as the mean per case, so 1.0 is perfect and a candidate that
answers `not_met` to everything scores well below zero on a watch that had
anything to catch.

**The direction is the product's; the magnitude is the team's.** The three
weights are `UTILITY_CORRECT`, `UTILITY_FALSE_FIRE` and `UTILITY_MISSED_FIRE` in
`run.ts`, in one place, and the ranking is worth re-deriving if the cost of a
session ever stops being small relative to the cost of dropping a request.

### 2. Multiclass Brier score — did the confidence mean anything

The provider returns a probability for every choice, not just a confidence in the
one it picked. Collapsing those onto the three verdicts and scoring them against
the truth gives one number that rewards being right *confidently* and punishes
being wrong *confidently*, quadratically, with no threshold involved:

```
brier = mean over cases of  Σ_verdict ( P(verdict) − 1[verdict is true] )²
```

Zero is perfect and 0.667 is a uniform guess over three classes. This is the part
that answers "at what confidence was the answer given" continuously rather than
at a cut point.

**Across primitives, the binary score decides.** A pure Noul cannot express "no
event of this kind could settle this" — it has one scalar — so the three-class
score charges it for mass it had no way to place, which on this tuning split is
worth about 0.126, larger than the differences being measured. That is a penalty
for the primitive's shape rather than for being wrong, and the product does not
care either way, because both non-firing answers take the same action. So a
cross-primitive comparison is settled on

```
fireBrier = mean over cases of ( P(match) − 1[the event should have fired] )²
```

which asks exactly what the gate asks. The three-class score stays reported,
because it is what distinguishes a candidate that understands the third class
from one that has quietly dropped it — and that difference is a product signal
even when it is not a scoring one.

Two candidates can share an accuracy and differ here by a lot, and the difference
is exactly what a threshold can and cannot fix. Errors that arrive at 0.5 are
recoverable by moving the threshold; errors that arrive at 0.97 are not. The
error that matters most here is a *confident* miss — a candidate that says
`not_met` at 0.95 about an event that should have fired has put the decision
somewhere no threshold can reach.

### 3. Words — the tiebreaker

At equal utility and equal Brier, the shorter contract wins. Not a preference: a
contract that needs a clause per case has learned the corpus, and the corpus is
274 synthetic cases rather than production.

## Three-class accuracy is still reported

It is no longer the objective, but it stays in every report because it is what
diagnoses *why* a candidate loses. A candidate can hold its band utility while
collapsing the unjudgeable class into `not_met`, and only the confusion matrix
shows that. Accuracy explains; it does not decide.

## What a result has to clear

The noise floor, measured over three repeats of six candidates: 1.4 points median
and 4.1 at worst on three-class accuracy. Band utility and Brier are pooled across
runs for the same reason. **A difference smaller than the spread across a
candidate's own repeats is not a result**, and a candidate that wins on one run
has told us about that run.

## Every band-utility number published before 2026-09-18 is superseded

The matrix above was inverted on that date. Earlier reports in `reports/` and the
tables in `digests/` scored a false fire at −2 and a miss at 0, which is the
opposite ranking: they favour the quiet candidate and penalise the one that
passes events through. The accuracy, Brier, precision, recall and word counts in
those reports stand; the band utility, the `score` the Pareto front was built
from, and therefore the *ordering* of every population run before that date do
not. Re-run rather than reading the old table.
