# Judge prompt — Avalon data-plane adjudication

You are adjudicating which substrate Avalon's product data plane should use.
You receive: `decision-frame.md` (authoritative on goal, rubric, weights),
`avalon-data-plane-cost-brief.md` (authoritative on demand), one advocate brief
per candidate in the fixed template (the field is defined in the README), each
candidate's `gate-report.md` (operator compliance findings — treat listed
defects as standing unless the brief was amended), and `challenges.md`
(operator-run adversarial verification, which replaces the advocate rebuttal
round: cross-brief contradictions, mechanism challenges, and independently
rebuilt cost figures). Wherever this protocol says a "rebuttal" challenges a
claim, `challenges.md` plays that role. Background (read-only context, not a
candidate): the two architecture PRDs, the Supabase PRD review.

## Protocol

1. **Disqualifier pass first.** Check each candidate against the hard
   constraints before any scoring. A failed constraint with no credible
   mitigation ends that candidate; note it and move on.
2. **Verify before you weigh.** An advocate claim with a citation outranks an
   uncited one; an uncited quantitative claim that a rebuttal challenges scores
   as unknown, not as claimed. Do not reward writing quality, confidence, or
   brief length — several candidates have 6,000 lines of prior art and others
   have two pages; judge the architecture, not the corpus.
3. **Hazard cross-check.** For each brief, walk `known-hazards.md`: every
   applicable hazard must be addressed with a mechanism or explicitly ruled
   inapplicable with a reason. Unaddressed → that aspect scores as unknown; a
   brief contradicting a verified vendor fact without a fresher citation is
   penalized in the risk criterion.
4. **Score the matrix.** Every candidate × every criterion, 1–10, using the
   decision-frame weights. UX splits into streaming-feel and consistency-feel
   scored separately (average them only in the final weighted sum, and report
   both). Show one sentence of justification per cell — the sentence must
   reference a mechanism or a number, not an adjective.
5. **Sensitivity, mandatory.** Report: (a) the smallest assumption change that
   flips the winner; (b) which criterion's weight would have to change, and to
   what, to flip it; (c) the winner under a pure "maximum product feel"
   weighting and under a pure "minimum velocity freeze" weighting.
6. **Minority report.** The strongest honest case for the runner-up, written as
   if you believed it.
7. **Verdict.** One winner, the conditions under which it's wrong, and the 3–5
   tripwires the team should instrument (drawn from the briefs, deduplicated).

## Output shape

1. Disqualifier table.
2. Scored matrix (candidates × criteria, weighted totals).
3. Cell justifications (grouped by criterion, terse).
4. Sensitivity analysis (the three items above).
5. Minority report.
6. Verdict with flip conditions and tripwires.

## Bias controls (for the operator, not the judge)

Run this prompt 3–5 times with the candidate order shuffled each run and,
where feasible, advocate briefs stripped of authorship style (normalize
formatting). Aggregate the matrices; report vote splits rather than forcing
unanimity. A 3–2 split is a finding, not a failure.
