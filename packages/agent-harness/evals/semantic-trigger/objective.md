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

## The three numbers, in priority order

### 1. Band utility — what ships

Per case, at each threshold in the band: the product either fires or does not,
and the truth either wanted a fire or did not.

| | Wanted a run | Did not |
| --- | ---: | ---: |
| **Fired** | +1 | **−2** |
| **Did not fire** | +1 | +1 |

A false fire costs double a miss, and that asymmetry is the whole product
argument rather than a tuning knob: an unwanted fire starts an agent run holding
the Sidekick's write tools and interrupts somebody, while a miss loses one
occurrence and the next matching event gets another chance. A missed fire scores
0 rather than −1, because the case still counted in the denominator; the cost of
missing shows up as forgone +1.

This is reported as the mean per case, so 1.0 is perfect and a candidate that
fires on everything scores well below zero on a standing watch.

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
recoverable by moving the threshold; errors that arrive at 0.97 are not.

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
