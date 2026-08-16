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
                       known-hazards.md           verified facts + design traps to address
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
   `aws`, `gcp`, `managed-postgres`, `convex`, and `current-stack` (the null
   hypothesis — required). This list is the authoritative field: barriers
   and judge preconditions count against it.
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

## Concurrency rules

Multiple sessions may work this branch simultaneously. The layout makes file
conflicts impossible if everyone stays in their lane:

- **Write only your own paths**: your `candidates/<candidate>/` folder, or your
  own `rebuttals/<candidate>-rebuttal.md`. Never edit `packet/`, another
  candidate's files, or anything outside `adjudication/`.
- **Push contention is normal**: if your push is rejected (non-fast-forward),
  run `git fetch origin && git rebase origin/claude/supabase-workspace-prd-review-k3iyfb`
  and push again. **Never force-push this branch** — it carries other
  sessions' work.
- **Re-read `packet/` at the moment you start writing** — it may have been
  updated since you were first prompted; the branch copy is authoritative over
  any pasted copy.
- Phases: brief-writing is fully parallel; rebuttals start only when every
  expected candidate has a brief; judging starts only when every rebuttal is
  in. The operator announces the barriers.

Background context judges may read (read-only, not candidates): the two
architecture PRDs under `docs/PRDs/2026-08-15_*`, the review at
`docs/PRDs/2026-08-15_supabase-workspace-workstream-conversations/review.md`.
