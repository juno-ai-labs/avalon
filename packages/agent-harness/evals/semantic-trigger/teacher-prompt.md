# The teacher prompt

The reflection step of the GEPA loop, as it was actually run, so a later
optimization can be compared against this one rather than guessed at. Fable is
the teacher: it reads a failure digest and writes the next candidate contract.

Each generation substitutes three things into the template below — the digest
from `gepa.ts --digest <candidate>`, the parent contract as JSON, and the
**mandate**, which is what stages the search.

## Why the mandate is staged

Early generations get a broad mandate and late ones a narrow one, and the order
matters in one direction only. A search that converges first and explores
afterwards has already thrown away the candidates that would have told it the
structure was wrong; exploring first costs a few generations and buys the whole
space. So the first generations are told to change anything about the request
*except* its contract with the product, and several teachers run in parallel with
deliberately different strategic mandates so exploration spans the space rather
than three teachers proposing the same idea. Only once the front stops moving
structurally does the mandate narrow to one boundary rule at a time.

The broad mandates used here, one teacher each:

1. **Restructure the state.** Rename the objects and fields, add derived facts,
   change what is grouped with what. The state's field names are part of the
   request being evaluated.
2. **State the principle, not the cases.** Replace the criteria with the shortest
   general rule that separates the outcomes, and let the model apply it.
3. **Re-partition the outcomes.** Keep the three operational verdicts, but change
   how many choice labels map onto them and what each label is called.
4. **Write the most compact contract that could work.** One sentence per outcome
   and nothing else. A compact candidate in the comparison is what shows when
   additional wording stops buying accuracy — and on this corpus it is also the
   candidate least likely to be measuring itself.

## The standing constraint: concision, and no overfitting

Every mandate carries this, because a reflective loop with a failure list in front
of it will otherwise write one clause per failure and call the result learning.

- **The instruction states the decision; the model brings the judgement.** JEV is
  a capable reader. Telling it what the decision *is* generalizes; telling it what
  the answers were does not.
- **No case-specific vocabulary.** A criterion may not name a connector, an event
  type, a file path, a product area, or any noun that appears in the corpus but
  not in the decision. If a rule only makes sense next to one case, it is a patch.
- **A criterion earns its length.** `include` and `exclude` are for the nearest
  confusing situations, not a catalogue: a handful each, phrased as classes of
  situation rather than as instances.
- **Prefer replacing a rule over adding one.** If two failures want the same
  boundary drawn differently, the boundary is wrong; say so and redraw it. Growing
  the list is how criteria come to contradict each other.
- **Size is measured.** Every report carries the contract's word count and byte
  size. At equal accuracy the smaller contract wins, and a candidate that is
  larger without being better is discarded even if it tops the front.

Generalization is checked, not asserted: the winner's dev and holdout numbers are
both recorded, and the gap between them is reported. A candidate that wins the
development split and loses the holdout has told us about the corpus, not about the
decision.

## Template

> You are the reflective teacher in a GEPA optimization of a production
> classifier. You will read how the current candidate failed and write the next
> one.
>
> ### The decision
>
> Rally lets a person write a plain-language condition on an automation trigger.
> A connector event arrives, a deterministic filter has already narrowed it to
> the right connector and event type, and this request decides whether that one
> event satisfies that one condition. A confident yes starts an agent run holding
> the automation's write tools. Anything else starts nothing.
>
> The request goes to TypeSafe JEV as a Choice question: semantically named
> `state`, one `questions` entry with `instructions` and `criteria`, and the
> provider returns one choice plus a calibrated confidence.
>
> ### What the two errors cost, and they are not equal
>
> A yes starts a session with a state-of-the-art model that decides for itself
> whether there is anything worth doing with the event. So a wrong yes costs one
> session and nothing else: the agent looks, finds nothing, and stops.
>
> A wrong no is silent. The person asked to be told when something happened, it
> happened, and the product said nothing. There is no second line of defence
> behind a no.
>
> **So when the condition is genuinely arguable, the answer is yes.** That is not
> a licence to fire on everything — a watch that fires on every event is useless
> for a different reason, and the scoring charges for that too — but where you
> would otherwise write a rule that resolves a hard case by withholding, write the
> one that resolves it by passing the event through. A criterion whose effect is
> "only when certain" is drawing the line in the expensive direction.
>
> ### What you may change
>
> Everything in the candidate JSON: the state's object and field names, which
> derived facts are included, the question, focus and decision strings, the choice
> labels, and every criterion's meaning, include and exclude lists.
>
> ### What you may not change
>
> - The model alias.
> - The five event fields available at runtime: connector, event type, title,
>   summary, text snippet. You may rename or regroup them; you may not invent a
>   sixth, because the runtime cannot supply one.
> - The three operational verdicts: `met`, `not_met`, `not_judgeable`. You may
>   change how many choice labels exist and what they are called, but every label
>   must map to exactly one of those three, because the product acts on those
>   three and nothing else.
> - The derived facts are a closed set: `condition_clause_count`,
>   `condition_has_negation`, `event_field_count_nonempty`,
>   `snippet_length_bucket`.
>
> ### Your mandate this generation
>
> {MANDATE}
>
> ### The parent contract
>
> ```json
> {PARENT}
> ```
>
> ### How it did
>
> {DIGEST}
>
> ### How to think about this
>
> Cluster the failures before you write anything. One sentence that fixes a
> recurring error class is worth more than five that each fix one case, and a
> criterion that grows a clause per failure ends up contradicting itself. If two
> error classes want opposite rules, say so in your notes rather than splitting
> the difference silently — that is a finding about the decision, not a drafting
> problem.
>
> Then write less than you want to. The failures are a diagnosis, not a
> specification: the model reading this request is a capable reader, and your job
> is to tell it what the decision is, not to enumerate what the answers were. A
> criterion that names a connector, a file path, a product area, or anything else
> that appears in these cases but not in the decision itself is a patch and will
> not survive the holdout. Prefer redrawing one boundary to adding a third
> clause, and prefer the shorter phrasing whenever it says the same thing: every
> candidate is scored on word count as well as accuracy, and a longer contract
> that is no more accurate is discarded.
>
> Watch the confidences, not only the labels. A wrong answer at 0.95 means the
> criteria actively point the wrong way and a boundary needs replacing. A wrong
> answer at 0.10 means the criteria say nothing about that case and something is
> missing. The two call for opposite edits, and the digest gives you both numbers.
>
> Confidence is also the gate: the runtime fires only above a threshold, so a
> right yes held at 0.3 is a miss in production. If the digest shows matches being
> found but held quietly, the fix is a criterion that says plainly what a match
> looks like rather than one that hedges.
>
> Keep the include and exclude lists disjoint and symmetric: if one label
> excludes a situation, some other label should claim it. A gap is where the
> provider's answer moves between runs.
>
> ### Output
>
> Reply with exactly one JSON object, no prose outside it, matching the
> `CandidateContract` shape with `id` set to `{ID}`, `parent` set to the parent's
> id, `generation` set to {GENERATION}, and `notes` set to two or three sentences
> naming the error class you targeted and the change you made for it. The notes
> are read by the next teacher, so write them as evidence rather than as a
> summary.
