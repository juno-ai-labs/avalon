# Data-plane adjudication bus

Working-branch coordination folder for the substrate decision — **not intended
to merge to main**. It exists so multiple independent sessions can exchange
standardized arguments through git.

## Layout

```
adjudication/
  packet/            The fixed inputs every participant reads first:
                       decision-frame.md          rules, rubric, weights
                       avalon-data-plane-cost-brief.md   demand model
                       advocate-template.md       required brief format
                       judge-prompt.md            how briefs are scored
  candidates/        One folder per candidate substrate:
                       <candidate>/brief.md       the standardized argument
  rebuttals/           <candidate>-rebuttal.md    ≤1 page vs the other briefs
  verdicts/            judge-pass-<n>.md          independent judge outputs
```

## Protocol

1. **Standardize.** Each advocate session reads `packet/` and commits exactly
   one `candidates/<candidate>/brief.md` per the template. Compress your
   existing PRD/argument; introduce no new uncited claims; UNKNOWN beats
   confident vagueness. Candidates expected: `supabase`, `cloudflare-do`,
   `aws`, `gcp`, `managed-postgres`, and `current-stack` (the null
   hypothesis — required).
2. **Compliance gate.** The operator checks each brief against the template
   (sections present, caps respected, citations resolvable, scope rule
   honored) and kicks back noncompliant briefs before anyone sees them.
3. **Rebuttal round.** Once all briefs are in, each advocate session receives
   the full `candidates/` set and commits one rebuttal.
4. **Judging.** Fresh-context judges (no involvement in authoring any brief,
   the review, or this packet) each run `packet/judge-prompt.md` over the
   packet + briefs + rebuttals, with candidate order shuffled per pass.
   Verdicts land in `verdicts/`; the aggregate matrix and vote split are the
   result — a 3–2 split is a finding, not a failure.

Background context judges may read (read-only, not candidates): the two
architecture PRDs under `docs/PRDs/2026-08-15_*`, the review at
`docs/PRDs/2026-08-15_supabase-workspace-workstream-conversations/review.md`.
