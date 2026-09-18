# Asking the question the other way round

Every candidate so far asks **"does this event satisfy the condition?"** and fires
on a confident yes. This brief is for candidates that ask **"should this Sidekick
ignore this event?"** and refuse only on a confident yes.

## Why, in one paragraph

[`objective.md`](../objective.md) prices a miss at three times a false fire,
because the run this gate guards opens with a model that decides for itself
whether there is anything to do. But the gate's *uncertainty* has been falling the
other way the whole time: under the positive question, an answer of "probably a
match, 0.4" stops the run, so a hesitant match is scored as the expensive error.
No threshold fixes that, because the threshold is the thing doing it — recall falls
monotonically as it rises, so every setting trades away the error we care about to
buy the one we do not. Turn the question around and the threshold guards the cheap
error instead: the run stops only when the model is *confident* the event should be
ignored, and hesitation buys a session that finds nothing.

## What the stored runs already answered, and what they cannot

Polarity touches only the gate rule, so re-gating six Choice candidates' stored
answers as `ignore` cost nothing (`rescore.ts --polarity ignore`). Band utility on
the tuning split, own polarity against re-gated:

| Candidate | As asked (`match`) | Re-gated (`ignore`) | Change |
| --- | ---: | ---: | ---: |
| `w3-state` | 0.703 | **0.835** | +0.132 |
| `w2-grounded` | 0.640 | 0.820 | +0.180 |
| `w1-quiet` | 0.458 | 0.730 | +0.272 |
| `gen0-baseline` | 0.715 | 0.673 | −0.042 |
| `gen3-trimmed` | 0.796 | 0.679 | −0.117 |
| `gen4-merged` | 0.817 | 0.735 | −0.082 |

The pattern is clean: re-gating rescues a candidate that was **over-refusing** and
punishes one that was already firing readily. That is not a free win, it is a
different operating point on the same frontier — and at the limit both polarities
are the same rule, because a threshold of zero on either side means the label
decides alone. The best re-gated number, 0.857 at 0.5, ties the best label-only
number (0.839) inside the noise floor.

So **the gate rule alone is a wash**, and the interesting half is the one a stored
run cannot answer: does *asking* the negative question change what the model
attends to? A positive question asks for affirmative evidence for every clause,
which is exactly what produced the misses in every digest so far — an event that
is plainly the thing the condition names, described rather than labelled, scored
0.36 to 0.59. A negative question asks for a **reason to disqualify**, which is a
different search over the same text. That may make the same errors, or fewer, or a
new kind. Nothing on disk says which.

## What a negative-polarity candidate is

Set `polarity` to `"ignore"`. Then:

- **The question asks about ignoring.** "Should this Sidekick ignore this event?",
  or whatever wording carries that. It is not a positive question with the labels
  renamed: if the prose still argues about whether the condition is satisfied, the
  confidence still attaches to that, and nothing has changed.
- **`mapping` still targets the product's three verdicts.** The label that means
  "ignore it" maps to `not_met`; the label that means "do not ignore it" maps to
  `met`; a label for "no event of this kind could settle this condition" maps to
  `not_judgeable`. That keeps accuracy, the confusion matrix and both Brier scores
  comparable across polarities with no special case.
- **The gate refuses only on a confident refusal.** `not_met` or `not_judgeable`
  above the threshold stops the run; anything else fires. So a criterion that
  claims a case weakly is a criterion that fires on it.
- **For a Noul, the scalar is P(ignore this event).** High means ignore. The
  threshold applies to it directly, and a low scalar fires.

## What to be careful about

**The cheap error is cheap, not free.** A watch sees eleven to thirteen events and
matches on about one. If the negative question hedges on ordinary non-matches, it
fires on all of them, and the reports will show it as false fires and noisy
watches. The re-gated `gen4-merged` above is exactly that failure: 99% recall and
36.7 unwanted sessions per run, which the price list still scores below a
candidate that gets both roughly right.

**`not_judgeable` is not hesitation.** "No event of this kind could ever settle
this condition" is a categorical statement, and a watch whose condition is
untestable would otherwise fire on every single event. It refuses under either
polarity, and that is deliberate.

**Do not argue both sides at once.** The temptation is to write "ignore it unless
it matches", which smuggles the positive question back in and leaves the model
deciding which frame to answer in. Say what a reason to ignore looks like.
