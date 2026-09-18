# The wide restart

The search is starting again from nothing. Not because the earlier generations
failed, but because they optimized the wrong number and the corpus they optimized
against was half the corpus that now exists.

## Why restart rather than continue

Three things changed under the previous lineage, and together they invalidate its
ranking rather than adjusting it.

**The objective changed.** See [`objective.md`](../objective.md). The old
objective was three-class accuracy. The new one is what the product pays: band
utility over thresholds 0.5, 0.6 and 0.7, with a false fire costing double a
miss, plus a multiclass Brier score over the provider's own probabilities. The
label is no longer the thing being scored; the decision is, and so is the
confidence attached to it.

**The corpus doubled, and the new half is the realistic one.** 144 standing-watch
cases across twelve watches, one condition each over eleven to thirteen events,
where the match rate is 10.4% and three watches correctly never fire. The old
corpus was 129 distinct conditions across 130 cases at a 39% match rate — that is
how you teach a boundary, not how a Sidekick is used.

**The ranking reversed.** On 151 tuning cases under the new objective:

| Candidate | Words | Band utility | Brier | 3-class | Fire precision | Watches made noisy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `gen4-merged` | 133 | **0.841** | **0.208** | 85.4% | 71.4% | 5 of 12 |
| `gen3-trimmed` | 117 | 0.828 | 0.237 | 84.1% | 71.4% | 5 of 12 |
| `gen3-judgeable` | 236 | 0.786 | 0.222 | 83.4% | **65.1%** | **8 of 12** |
| `gen0-baseline` | 227 | 0.779 | 0.251 | 83.4% | 71.8% | 6 of 12 |

`gen3-judgeable` was the accuracy winner and is third here. It gets more labels
right and fires wrongly more often — fifteen unwanted runs against the compact
candidate's twelve, and it breaks the silence on four of the three watches that
should never fire. Accuracy was selecting the worse product.

So a lineage bred for accuracy is not a good starting population for this
objective, and every candidate in it inherits one ancestor's state shape and
label set. Starting blank is cheaper than unpicking that.

## What the numbers to beat are

**Band utility 0.841. Brier 0.208.** Anything inside the noise floor of those is
a tie, and a tie goes to the shorter contract.

The gap worth attacking is not accuracy. It is that **every candidate so far
would make five to eight of twelve watches noisy**, and two to four of them fire
on a watch whose correct behavior is never to fire at all. A Sidekick that
interrupts somebody twice a week when they asked for once a month is a product
failure at any accuracy.

## What the corpus looks like now

274 cases, 151 tuning and 123 held out, fixed before any of this.

| | Balanced half | Standing watches |
| --- | ---: | ---: |
| Cases | 130 | 144 |
| Distinct conditions | 129 | 12 |
| `condition_met` | 51 | 15 |
| `condition_not_met` | 61 | 129 |
| `condition_not_judgeable` | 18 | **0** |

## The one unresolved question in the ground truth

The watch half has **no** `condition_not_judgeable` cases, and that is a
disagreement rather than an absence.

The authors labelled seven watch cases unjudgeable: a message reaction, a
note-access grant, a permission change that omits the recipient, a reply whose
"it" refers to an earlier message. Their argument: an event of that *kind* cannot
carry what the condition asks for, so the watch is subscribed to the wrong thing
and that is an authoring defect worth surfacing.

The independent adjudicator labelled all seven `condition_not_met`, and gave zero
unjudgeable labels across all 144. Its argument: an event of that kind *can*
settle the condition, and settles it as false — a reaction is somebody
acknowledging rather than reporting, so the condition is unmet, not untestable.

Both readings are coherent and the corpus keeps both labels. The overlay scores
against the adjudicator, so **as scored, the third label appears only in the
balanced half**. Treat that as a live ambiguity in the decision rather than as a
settled fact about it: a candidate that produces unjudgeable freely will be
punished on the watch half under the current overlay, and a candidate that never
produces it will lose the eighteen balanced cases. If your contract takes a view
on where that line sits, say so in your notes — that is a finding about the
product, and it may be worth more than a point of utility.
