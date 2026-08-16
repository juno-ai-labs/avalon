# Avalon data-plane decision frame

Read this before any advocate brief or judge pass. It pins the goal, the
demand, the rubric, and the rules. It overrides anything an advocate brief
implies about what matters.

## The goal

Pick the substrate for Avalon's product data plane that best serves the **first
10,000 users** — roughly 1–2k weekly active, 150–300 peak concurrently online,
5–30 concurrent agent runs, a handful observed at once — while leaving a
credible (not proven) path beyond. This is an early-stage product with a small
team and no time to do this perfectly. Velocity and product feel dominate;
projected scale does not.

## Scope: substrate only

The conversation-model upgrades in the candidate PRDs (substream/parts storage,
provider-valid turn projection, first-class queue-vs-steer) ship **regardless
of substrate** — they are schema/protocol design, largely substrate-independent.
Advocates argue only about where the data and realtime/execution planes live.
Claiming the conversation model as a benefit of your substrate is a scoring
penalty.

Moving off the current stack (per-region D1 + Durable Objects as the data
plane) is a **settled constraint**, decided outside this process — there is no
stay-put candidate, and judges must not re-litigate the migration decision or
score against a stay-put baseline. Candidates are compared with each other;
migration cost is still scored per template §5. (Cloudflare Workflows used
purely as a data-minimal loop driver is not "the current stack" for this
purpose.)

## Demand

Use the companion `avalon-data-plane-cost-brief.md` (§1–3) verbatim: product
invariants, the S = 50/300/2,000 scale-point table, write-amplification
hazards. For this decision, the **primary sizing point is S ≈ 10–30**
(the 10k-user reality); S = 300 is scored only under "credible path"; S = 2,000
is out of scope except as a dead-end check. Launch is Global-only; the EU
region is deferred and EU-specific machinery counts as future cost, not launch
cost.

## Rubric

| Criterion | Weight | Scored as |
| --- | --- | ---: |
| Simplicity | 20 | Count of distinct technologies, concepts, and protocols the team must hold; lines of bespoke distributed-systems code the design demands |
| UX / product feel | 20 | The seven proxies below, mechanism-level answers only |
| Maintainability | 15 | Debuggability, inspectability (can you SQL it?), hiring pool, migration/tooling ergonomics, and the IaC/deployment story (template §7) — how much of the stack is declarative, reviewable, and reproducible versus dashboard- or ticket-only |
| Migration time / velocity freeze | 15 | Product-weeks the team does not ship features, with the estimate's assumptions shown |
| Unproven-assumption risk | 15 | Launch gates that could fail (e.g. undocumented auth federation), probability-weighted; every "contact sales/support" dependency counts |
| Scalability | 8 | Credible-path-only: no dead ends before ~S=300; name what breaks first and whether the fix is money or architecture |
| Cost | 7 | $/month at the 10k-user point; S=300 reported for dead-end detection only |

### UX / product feel — the seven proxies

Answers must name the mechanism, not adjectives. Streaming-feel (1, 2, 5, 6)
and consistency-feel (3, 4) are scored separately and not averaged.

1. **Streaming cadence**: visible update interval, its floor, and its
   degradation curve as concurrent streams grow.
2. **Time-to-first-token**: admission → first visible byte, including
   dispatch/cold-start latency of the loop driver.
3. **Interaction latency & coherence**: send → visibly committed; can the
   sidebar ever disagree with the transcript, and for how long?
4. **Visible consistency artifacts**: duplicate/missing chunks at reconnect,
   resync flashes, provisional-text retraction on crashed attempts.
5. **Steering responsiveness**: stop/redirect → seconds until generation
   visibly halts, in the worst case (notification lost).
6. **Reconnect/wake**: catch-up time after sleep; does a mid-stream join show
   the full prefix?
7. **Behavior at the limit**: at quota/load saturation — graceful slowdown,
   silent staleness, or disconnect storms?

### Disqualifiers (checked before scoring)

The nine hard constraints in the cost brief §6, with two adjustments for this
stage: constraint 6 (EU) is scored as future-path credibility, not launch
requirement; constraint 9 (migration from D1/R2) is trivially satisfied at
zero users but the *code* migration (the backend rewrite surface) must still be
estimated honestly.

### Standing decisions all candidates inherit

- Streaming persistence is append-only deltas, never whole-buffer rewrites.
- The revocation stance for stream text is an open product decision; advocates
  must price BOTH stances (immediate revocation vs. bounded staleness ≤ 60 s)
  if their architecture's cost differs between them.
- Tripwires, not pre-optimization: each brief ends with the 3–5 measurable
  triggers that should reopen this decision.
- **Infrastructure is managed as code.** Declarative, version-controlled,
  reviewable configuration (Terraform/Pulumi/provider-native config files,
  CLI-driven migrations) is the strong preference. Any component that can only
  be provisioned or changed through a dashboard, or only resized/raised via a
  support ticket, must be named explicitly — it counts against maintainability
  rather than disqualifying, but hiding it counts double.
