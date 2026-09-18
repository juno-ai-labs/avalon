# What generation 2 established

Three repeats of six candidates on the 73 tuning cases, against the adjudicated
ground truth. Read this before proposing another candidate: two of the four broad
mandates made things *worse* in an instructive way, and the noise floor bounds
what any single run can tell you.

## The noise floor

Identical requests, identical cases, three runs: the median candidate moved 1.4
points between its best and worst run, and the widest moved 4.1. **A difference
under about two points is not a result.** JEV is sampling, not a lookup.

## The ranking, by mean of three runs

| Candidate | Words | 3-class | not_judgeable | near_miss |
| --- | ---: | ---: | :--- | :--- |
| `gen0-baseline` | 227 | **79.0%** | 5,4,5 of 10 | 3,3,2 of 6 |
| `gen2-state` | 57 | 76.7% | 4,4,4 of 10 | 2,2,2 of 6 |
| `gen2-floor` | 14 | 75.8% | 3,3,3 of 10 | 2,2,2 of 6 |
| `gen2-principle` | 135 | 73.5% | **0,0,0** of 10 | 3,3,2 of 6 |
| `gen1-control-minimal` | 57 | 73.1% | 3,2,2 of 10 | 2,2,2 of 6 |
| `gen2-partition` | 110 | 72.6% | **0,0,0** of 10 | 2,2,2 of 6 |

## The three things this tells us

**Structure earns its keep here, and the earlier read was wrong.** A first pass
against provisional ground truth suggested the minimal control beat the verbose
baseline. It did not: with final labels and three repeats, the 227-word baseline
leads by 2.3 points over the next candidate and by 5.9 over the minimal control.
The include and exclude lists are doing real work, and they are doing it exactly
where it matters — the baseline is the only candidate reaching 4-5 of 10 on
`not_judgeable` and 3 of 6 on `near_miss`.

**Two candidates annihilated a class, both by rewording the same thing.**
`gen2-principle` replaced "settle" with "could any event of this kind make the
answer yes", and `gen2-partition` renamed the label `condition_not_judgeable` to
`condition_untestable`. Both went to **zero of ten**. Whatever else is true, the
label name and the word "settle" are load-bearing, and a rewrite of that criterion
is the single most dangerous edit available. Do not touch it without a reason and
a repeat.

**Compactness is cheap but not free.** 14 words scores 75.8% against 227 words at
79.0%: three points for sixteen times the instruction. That is the real trade to
argue about, and it is a product decision as much as an accuracy one — the token
cost is about a third lower and the latency is indistinguishable.

## What is still open

`not_judgeable` is the dominant error class in every candidate: the best result
anyone has achieved is 5 of 10, and three candidates scored 0. Ten cases on the
tuning split means each one is 1.4 points, so this class alone is most of the gap
between 79% and 90%. `near_miss` is second at 3 of 6.
