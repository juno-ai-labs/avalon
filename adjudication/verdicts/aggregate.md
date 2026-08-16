# Aggregate verdict — Avalon data-plane adjudication

Operator aggregation of three independent clean-context judge passes
(different candidate read orders; identical inputs: packet, four briefs, gate
reports, challenges.md, owner-notes.md). Compiled 2026-08-16.

## The vote

| | Pass 1 | Pass 2 | Pass 3 | Mean (/100) |
|---|---:|---:|---:|---:|
| **convex** | 63.3 | 69.3 | 69.9 | **67.5** |
| **gcp** | **64.2** | 61.0 | 58.7 | **61.3** |
| **supabase** | 57.7 | 60.2 | 55.0 | **57.6** |
| **aws** | 52.2 | 53.6 | 47.8 | **51.2** |

**2–1 for Convex** — and the split is narrower than it looks: pass 1's GCP
win is by 0.9 points, which that judge itself labels "inside judgment noise;
treat as a photo finish." More important than the vote: **all three judges
independently converge on the same decision function** —

> **Convex if its one-week S≈5 pilot passes; GCP if it fails.**

Passes 2–3 put the prior on Convex and name the pilot as the flip-to-GCP;
pass 1 puts the prior on GCP and names the same pilot as the flip-to-Convex.
Three shuffled, isolated judges arriving at the same hinge is the strongest
signal this process can produce: the decision is not "which candidate" but
"run the test that decides between the top two."

## Where the matrices unanimously agree

- **Convex** is first on Simplicity (8–9), UX (8.0 in all three passes;
  consistency-feel 9/10 in all three — the mechanically-zero
  sidebar/transcript window), Migration (~10 engineer-weeks, field's
  smallest), and Cost ($540/mo at S≈20; stance-invariant across the open
  revocation decision) — and last on Maintainability (5: no SQL, no
  Terraform, dashboard-only backups) with the weakest Risk scores (4–5:
  startup vendor; three load-bearing unverified assumptions — A5 metering,
  push-latency bound, C1 revocation semantics).
- **GCP** is the runner-up in every pass: boring, verified, Terraformed,
  SQL-inspectable; the only structurally unmetered fan-out (~$3.5k/mo real
  platform edge at S=300); the only brief that priced HA + cross-region DR.
  Every challenge landed against it is shallow (one-sentence/one-paragraph
  fixes); every challenge against Convex goes to whether its central
  mechanism exists as claimed.
- **Supabase is third in all three passes** — despite being the founders'
  leaning. The judges' quarantined-prior reasons: its real migration is the
  field's largest freeze (32–40 engineer-weeks behind an "8–10 product-week"
  headline — challenge C4); its fan-out is metered *and* its S=300 column
  hangs on an unpriced support negotiation past the 2,500 msg/s cap; it
  priced no HA/replica; and the org's open revocation decision has only one
  exercisable side on this candidate (no documented bounded-push mechanism).
- **AWS is fourth in all three passes**: most technologies, priciest
  normalized total (mostly removable choices), the field's lowest turn
  ceiling (14.5 min), a bounded-push mechanism materially incomplete as
  described (C2), and a migration that strands the dictation bridge (C3).

## The consolidated recommendation

1. **Do not commit a substrate tonight. Commit the pilot** — one engineer,
   one week, S≈5, before any migration work: measure (a) p95 commit→client
   push latency (pass: ≤1 s sustained), (b) metered spend vs the brief's §4
   model (pass: within +50%), (c) whether the kept agent-harness/Bind code
   runs in the restricted Convex runtime (pass: no `"use node"`, keeping the
   30-min action ceiling — C9). Pre-register these thresholds now so the
   pilot is a measurement, not a debate.
2. **In parallel, one vendor letter:** written confirmation that
   subscription re-delivery after a revoking commit is auth-fresh per frame,
   including caches and reconnects (resolves C1 — the claim the brief's own
   citations do not contain).
3. **Pilot passes + letter lands → Convex.** Pilot fails either axis, or the
   letter can't be had and immediate revocation is required → **GCP**, with
   its two named pre-launch gates (Redis throughput benchmark, driver
   dispatch ≤1.5 s) and the C7 fail-closed sentence added.
4. **Standing overrides** (from all three verdicts): enterprise self-hosting
   becoming a near-term contractual requirement, or the SG region arriving
   before Convex's region catalog grows, both shift the answer toward the
   runner-up regardless of the pilot.

## Consolidated tripwires (instrument under either winner)

1. p95 commit→client update >1 s sustained for a week at peak.
2. Realtime/reactive spend >$1,000/mo while S<50, or any month >50% over the
   winning brief's cost model.
3. ≥3 model turns/week aborted at the executor's action ceiling.
4. No signable in-region DPA by EU-build kickoff → self-host EU or reopen.
5. Vendor-health signal (license/pricing/distress) → execute the rehearsed
   export/self-host drill within 30 days.

## Caveats on this result

- Single-model panel: all three judges are Claude; a cross-model (Codex)
  pass was prepared and remains runnable for diversity.
- The judged UX scores rate *mechanisms*, not rendered pixels; the pilot's
  latency measurement is the empirical check on the highest-weighted score.
- Pass-level matrices, cell justifications, minority reports, and full flip
  conditions: `judge-pass-{1,2,3}.md` beside this file. The two minority
  reports for GCP are worth reading in full before tonight's decision —
  they are the strongest honest counter-case in the record.
