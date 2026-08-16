# Judge pass 3 — Avalon data-plane adjudication

**Judge:** Claude (clean-context pass 3)
**Read order:** packet (judge-prompt, decision-frame, cost brief, known-hazards), owner-notes.md (handling rules obeyed; [PRIOR] lines not cited as evidence; GCP judged normally per the [OPERATOR] annotation), then candidate briefs + gate reports in the order **convex, supabase, aws, gcp**, then challenges.md in full. Background consulted only to resolve specific disputes: `docs/architecture.md` (dictation bridge, C3/C15; EU deployment reality, C10).
**Date:** 2026-08-16

**Preliminary rulings this pass makes (from evidence, not priors):**

- **Dictation bridge (C3/C15):** `docs/architecture.md` (~ll. 187–194) confirms a real, shipped, stateful WebSocket proxy in the regional Worker (Azure key server-side, socket tickets, 5-minute capped sessions). C3 stands against AWS (no named component can host it; "retire both Workers" strands a shipped feature). C15 stands against GCP as unbudgeted scope (Cloud Run *can* host it). Convex keeps a vestigial Worker for it (honest); Supabase keeps the whole Worker (non-issue).
- **EU at cutover (C10):** `docs/architecture.md` confirms the product deploys twice today (Global + EU, live EU D1/R2/telemetry). At ~zero users the EU dataset is presumably near-empty, but only AWS states an executable rule ("assert EU is empty or stop"). Convex's §5 (singular D1 export, EU unmentioned) and GCP's §5 (EU data "follows the same procedure" into a US-only launch plane) are defective as written. Small migration-score deductions applied; not disqualifying at ~zero users.
- **Supabase's Global D1 route store (C14):** ruled *allowed* — opaque workspace routes are data-minimal control plane, analogous to the frame's Workflows carve-out; the product data plane moves. It still counts as a retained technology under Simplicity, and the brief should have argued the carve-out itself.
- **P1/P2 operator rulings applied:** costs scored from the challenges Part B normalized table (Convex ≈$540/$8.4k at V=2; GCP +$111 at 211,200 loops).

---

## 1. Disqualifier table

Nine hard constraints (cost brief §6), with the frame's stage adjustments (EU = future-path credibility; migration = honest code-rewrite estimate). No candidate is disqualified.

| Constraint | convex | supabase | aws | gcp |
|---|---|---|---|---|
| 1 Ordering + atomicity | PASS — serializable mutations, OCC-serialized seq | PASS — `FOR UPDATE` head row, single txn | PASS — same Postgres shape | PASS — same Postgres shape |
| 2 Durable cursors | PASS — counter-doc in txn; catch-up via snapshot recompute | PASS — locked head allocator, partitions day one | PASS — locked allocator + `min_retained_sequence` | PASS — entity-row allocator, monthly partitions |
| 3 Revocation semantic stated | PASS with caveat — mechanism real; the *precise* immediate bound is advocate-constructed (C1), scored unknown; bounded stance trivially satisfied | PASS — immediate-only; bounded stance has **no documented mechanism** (C5): one exercisable side | PASS with caveat — preferred ≤60 s epoch mechanism incomplete (C2); priced immediate-pull fallback keeps it alive | PASS with caveat — 5 s bound not mechanized fail-closed (C7); one-sentence fix |
| 4 Durable exec ≥2 h, action ≥10 min | PASS — Workflow component; 30-min Convex-runtime cap (10-min if Node runtime needed — C9 risk) | PASS — CF Workflows, unlimited step wall time | PASS — durable invocations ≤1 yr; 14 m 30 s turn ceiling (worst in field, C12) | PASS — 1-yr execution, 1,800 s HTTP step hosts turn whole (cite-verified) |
| 5 At-least-once queue, enqueue-atomic | PASS — transactional scheduler | PASS — pgmq in command txn | PASS — outbox + SQS FIFO + 60 s sweep (convergent, not atomic — stated) | PASS — outbox + `SKIP LOCKED` + Pub/Sub (C8 ambiguity on what actually transits it) |
| 6 Regions / EU fail-closed (future-path) | CREDIBLE — real EU region (2026-02), +30% no allowances; DPA/subprocessors UNKNOWN (declared) | CREDIBLE — separate EU project; fail-closed; contracts UNKNOWN (declared) | CREDIBLE — eu-west-1 stamp, separate account; DPA review UNKNOWN (declared) | CREDIBLE with named hole — Identity Platform absent from Google's data-residency list (declared, 40%) |
| 7 Per-row authz + FTS/vector under it | PASS — function layer is the app tier | PASS — RLS + invoker views, service-key bypass named | PASS — default-deny policies, no table rights | PASS — RLS, non-BYPASSRLS role, session-mode pooling caveat cited |
| 8 Blob backup honesty | PASS — blobs can ride backups (better than today) | PASS — Avalon-built locked R2 copy, honestly not PITR | PASS — S3 outside PITR, stated; CRR + snapshot copy | PASS — dual-region GCS, 99.9%/1 h stated, not zero-RPO |
| 9 D1/R2 migration, single writer | PASS (EU §5 gap noted above) | PASS — epoch-switch cutover, cleanest | PASS — explicit, incl. EU assertion | PASS (EU §5 contradiction noted above) |

---

## 2. Scored matrix

Weights: Simplicity 20, UX 20 (streaming-feel and consistency-feel scored separately, averaged only here), Maintainability 15, Migration 15, Risk 15, Scalability 8, Cost 7.

| Criterion (weight) | convex | supabase | aws | gcp |
|---|---:|---:|---:|---:|
| Simplicity (20) | **9** → 18.0 | 5 → 10.0 | 3 → 6.0 | 4 → 8.0 |
| UX: streaming-feel | **7** | 5 | 5 | **7** |
| UX: consistency-feel | **9** | 7 | 6 | 7 |
| UX combined (20) | 8.0 → 16.0 | 6.0 → 12.0 | 5.5 → 11.0 | 7.0 → 14.0 |
| Maintainability (15) | 5 → 7.5 | **7** → 10.5 | 6 → 9.0 | **7** → 10.5 |
| Migration / freeze (15) | **7** → 10.5 | 3 → 4.5 | 4 → 6.0 | 5 → 7.5 |
| Unproven-assumption risk (15) | 5 → 7.5 | **7** → 10.5 | 4 → 6.0 | 6 → 9.0 |
| Scalability (8) | 6 → 4.8 | 5 → 4.0 | **7** → 5.6 | 6 → 4.8 |
| Cost (7) | **8** → 5.6 | 5 → 3.5 | 6 → 4.2 | 7 → 4.9 |
| **Weighted total (100)** | **69.9** | **55.0** | **47.8** | **58.7** |

**Ranking: Convex 69.9 > GCP 58.7 > Supabase 55.0 > AWS 47.8.**

---

## 3. Cell justifications (by criterion)

### Simplicity
- **convex 9:** even at C13's honest count (Convex platform + Electron + vestigial dictation Worker + Fivetran/warehouse mitigation, not "two"), it deletes the six-service matrix and ~200 lines of bespoke checkpoint/resync protocol, and its ordering/consistency come from platform serializable transactions rather than code the team writes.
- **supabase 5:** five operational concepts by its own §6 count spanning two clouds (Hono/Workers + D1 route store + Postgres/Realtime/pgmq + CF Workflows + R2 + WorkOS), plus bespoke hint-then-fetch, polling fallback, and epoch machinery.
- **aws 3:** nine products and five protocols by its own §6 admission, plus bespoke outbox/sweep, epoch rotation, and subscribe-buffer-fetch-merge — the largest concept count in the field.
- **gcp 4:** one cloud and one DB/queue/executor each, but the team hand-writes its own WebSocket gateway fleet + Redis fan-out + outbox relays — the most bespoke distributed-systems code of the four, which this criterion counts by name.

### UX — streaming-feel (proxies 1, 2, 5, 6)
- **convex 7:** push at self-chosen 2–4 Hz with no per-frame polling and reconnect = one query recompute; docked because scheduler-dispatch and push latency have no documented bound (A8, UNKNOWN) and C6 shows the "≤500 ms, no lost-notification" steering bound fails during provider stalls/tool effects (no timer-driven checkpoint named).
- **supabase 5:** content structurally cannot ride sockets (C5 — auth cached per connection, no documented revocation bound), so every visible update is hint + authorized fetch (floor 333 ms + RTT + fetch), degrading to 1–2 s polling at the project-wide 2,500 msg/s ceiling crossed at S≈278; steering 3 s is at least a real mechanized number.
- **aws 5:** with C2 breaking the ≤60 s epoch push mode (subscription filters evaluate at subscribe time — either an unpriced per-minute re-subscribe cycle for every viewer or the bound collapses to undocumented invalidation latency), the *verified* mode is immediate-pull per frame; 2.5 s steering bound is engineered, but worst-case TTFT on a lost enqueue is the 60 s outbox sweep.
- **gcp 7:** 250 ms cadence with a 500 ms normal worst case over unmetered sockets (no cadence-vs-cost tension), 2 s steering worst case mechanized against the DB row; docked because Workflow dispatch latency (30% risk, declared) and Redis msg/s ceiling (20%) are unbenchmarked.

### UX — consistency-feel (proxies 3, 4)
- **convex 9:** sidebar-vs-transcript disagreement is impossible by a gate-verified platform property (all subscriptions deliver the same database snapshot), there is no client cursor arithmetic to get wrong, and epoch-CAS retraction is one commit; the *revocation-precision* part of §3.5 is scored unknown (C1) but does not touch these two proxies.
- **supabase 7:** one transaction writes all projections so canonical surfaces cannot diverge, but a swallowed `realtime.send` (documented) leaves both jointly stale until the 1 s poll.
- **aws 6:** single Aurora transaction is sound, but AppSync frames "may reach views at different times" and coherence rests on client-side dedup/cursor-gap machinery the team must write correctly.
- **gcp 7:** cursor-carrying bundles off one transaction; a lost Redis hint leaves stale UI only until cursor catch-up; client dedup by `(workstream, seq)` is bespoke but simple.

### Maintainability
- **convex 5:** no SQL (dashboard browser + TS queries; the real-SQL answer is a beta Fivetran export to a warehouse), **no Terraform provider**, backups and custom domains dashboard-only, deployment-class raises support-only — all named (so no double penalty), but this is the field's weakest IaC/inspection story despite an excellent one-push schema+code deploy model.
- **supabase 7:** full SQL joinability across every table is the field's best inspection story and Postgres hiring is deep; docked for the alpha Terraform provider, dashboard-only compute resize, support-ticket-only Realtime quota raises, and WorkOS dashboard residue.
- **aws 6:** best-in-field Terraform coverage and SQL via Data API, but nine products to debug end-to-end and Service-Quotas approval gates make the operational surface the widest.
- **gcp 7:** full Terraform coverage, ordinary SQL + pgAudit, one cloud, 10–20-minute deploys; docked for owning a bespoke gateway fleet's operational burden and the Memorystore tier-upgrade-is-replacement wart.

### Migration / velocity freeze (normalized per C4 to engineer-weeks)
- **convex 7:** smallest freeze (~10 engineer-weeks, 2 engineers) even risk-adjusted upward for the field's largest client rewrite, the C9 runtime-compatibility unknown, and the silent EU-data omission — and it deletes the most legacy machinery in return.
- **supabase 3:** the smallest *headline* is the largest actual freeze — 32–40 engineer-weeks (3 backend + 1 desktop × 8–10 weeks), 3–4× the field, and it silently assumes four freezable engineers exist.
- **aws 4:** 12 engineer-weeks claimed, but C3 adds an unnamed, unpriced product to host the stranded dictation bridge, C2 forces rework of the launch realtime mechanism, and the full Cognito + AppSync client rewrite is the second-largest client change.
- **gcp 5:** 14 engineer-weeks claimed with the gateway build included; add unbudgeted dictation-proxy scope (C15) and the contradictory EU §5 line.

### Unproven-assumption risk
- **convex 5:** the headline differentiator ("both stances $0, window zero") is assembled beyond its citations (C1 → unknown), metering assumption A5 is ±2× on the dominant cost line (30%, self-declared), push/dispatch latencies are unbounded assumptions, hazard #9 was skipped (gate patch), the vendor is a startup (~15% 3-yr exit-ramp probability, self-declared), and the deployment-class raise is contact-sales — mitigated by the fact that one cheap one-week pilot resolves the three biggest unknowns before commitment.
- **supabase 7:** fewest launch-gate unknowns at S≈20–30 (the 2,500 msg/s ceiling and negotiation live at S≈278, not launch; auth federation resolved via documented WorkOS path); the material risk is product-flexibility — the revocation decision has only one exercisable side (C5) — plus Workflow dispatch latency UNKNOWN shared with the field.
- **aws 4:** the preferred launch mode's central mechanism is materially incomplete as described (C2), the DB-sizing assumption is self-rated 35% wrong, Durable Functions is young (15%), the 100/s invalidation quota is non-adjustable with no bulk-revocation analysis (C11), and the dictation strand is a certainty, not a probability.
- **gcp 6:** three declared risks (driver latency 30%, Redis 20%, identity residency 40% — the latter EU-future), C7's unstated fail-closed rule and C8's Pub/Sub ambiguity are real but one-sentence/one-ruling fixes; uniquely, no contact-sales or unpublished-quota dependency at launch.

### Scalability (credible path; incl. owner [INPUT]s: SG third region, self-host interest)
- **convex 6:** S=300 is money ($8.4k ±2×) plus a named contact-sales dedicated tier; honest dead end at S≈2,000 (no published shard story); best per-region floor in the field (usage-only, no fixed compute — SG cheap, EU +30% with no included allowances); self-host is a real but single-node-uncertain FSL exit ramp.
- **supabase 5:** S=300 sits behind an unpublished support negotiation (2,700 msg/s > 2,500 published cap) with no rate card, on a single vertical-only primary (16XL, ~$3,730) with the thinnest priced resilience (no replica); offset by the field's best self-host story (Apache-2.0 full stack) — but ~$1k/region fixed floor × 3 regions.
- **aws 7:** the only candidate whose first ceiling has a *published* raise path (Service Quotas), Aurora to 256 ACU then sharding, all services in SG/Ireland; Outposts is a weak-but-existent on-prem answer.
- **gcp 6:** single writer with a money path to S≈300–700 then workspace sharding; Redis ceiling unpublished (gated, declared); all services in asia-southeast1; weakest self-host story (Cloud SQL/Memorystore/Workflows have no on-prem equivalents).

### Cost (10k-user point primary; S=300 dead-end check; challenges Part B normalized)
- **convex 8:** cheapest at the sizing point ($540, stance-invariant) with $0 auth line at every scale (BYO JWT); ±2× A5 uncertainty is priced into risk, not here; S=300 ≈ $8.4k is money.
- **supabase 5:** $1,300 at S≈20 (mid-field) but the *entire* S=300 column is contingent on an unpriced negotiation, which is what this criterion's dead-end check exists to catch.
- **aws 6:** $943–1,183 at S≈20, and the owner's $25k credits (an [INPUT] fact) offset roughly two years at that rate; the $16k S=300 outlier decomposes mostly into removable choices (Cognito at list, immediate-pull delta, per-loop dedicated compute) rather than AppSync itself.
- **gcp 7:** $968 bounded at S≈20 and the best S=300 number in the field ($4.9k) — the only brief pricing HA×2 + cross-region DR — contingent on its two least-verified inputs (Redis ceiling, 10-instance Cloud Run sizing).

---

## 4. Sensitivity analysis (mandatory)

**(a) Smallest assumption change that flips the winner.** No *single* assumption flip is sufficient — Convex's 11.2-point lead survives each one alone (A5 metering wrong at ±2×: −1.4; C9 forcing the 10-min Node ceiling: ≈−6; honest-count simplicity re-score: ≈−5.5). The smallest *real-world event* that flips it is **the committed one-week S≈5 pilot failing on both of its axes at once** — p95 commit→client-update latency >1 s *and* metered spend >50% over model. Those two share one test, so this is effectively one assumption: "Convex's reactive-subscription mechanism performs as the brief models at Avalon's write rates." If it fails: streaming-feel 7→4, consistency confidence 9→7, cost 8→6, risk 5→3 ⇒ ≈58.4, below GCP's 58.7. This is the load-bearing assumption of the adjudication, and it is cheaply testable before commitment.

**(b) Which weight change flips it.** Between winner and runner-up, the sensitive axis is Simplicity-vs-Maintainability (Convex 9/5, GCP 4/7). Transferring weight w from Simplicity to Maintainability swings the gap by 0.7w; the gap closes at **w ≈ 16 — i.e., Simplicity 20→4 and Maintainability 15→31**. No plausible re-weighting flips the winner; a flip requires new evidence (per (a)), not new weights. Notably, raising Risk's weight does *not* flip it toward Supabase either: Supabase gains 0.2/point over Convex on Risk but loses more on UX+Simplicity than any defensible transfer recovers.

**(c) Extreme weightings.**
- *Pure "maximum product feel"* (UX only): **Convex** (avg 8.0) > GCP (7.0) > Supabase (6.0) > AWS (5.5).
- *Pure "minimum velocity freeze"* (migration only): **Convex** (~10 engineer-weeks) > GCP (14 + scope) > AWS (12 + stranded scope + C2 rework, risk-adjusted below GCP) > Supabase (32–40).
Convex wins both extremes — an unusual and robust result: the same candidate is simultaneously the fastest to ship and the best-feeling, and its weaknesses (maintainability, vendor risk) live in criteria neither extreme weighting touches.

---

## 5. Minority report — the honest case for GCP

Believe this and GCP wins: Avalon is about to bet its data plane on a venture-backed startup's proprietary reactive engine, on the strength of a revocation guarantee its own citations do not state (C1), a metering model its own advocate rates 30% likely to be ±2× wrong, dispatch latencies with no documented bound anywhere, a backup story that is dashboard-only, no Terraform provider, and no SQL. Every one of those sentences is a verified fact, not a prior. The GCP plane is the opposite bet: PostgreSQL row locks, an outbox, Redis fan-out, and Cloud Run — every component boring, hireable-for, Terraformed, and SQL-inspectable; the only two real unknowns (driver dispatch latency, Redis throughput) are pre-launch benchmark gates with money fixes, not negotiations. It is the only candidate with zero contact-sales dependencies at launch, the only one that priced HA plus cross-region DR and *still* posted the cheapest credible S=300 number ($4.9k vs Convex's $8.4k ±2×), and its fan-out is structurally unmetered — cadence can be tuned for feel, not for bill. Its streaming-feel scores within one point of Convex's using mechanisms a 2029 engineer will understand at a glance. The 14-week freeze buys an asset Convex never delivers: a data plane whose every behavior the team can read in `EXPLAIN` output and `terraform plan` rather than in a vendor's release notes. If the team weights "verified today" over "promised and pilot-testable," GCP is the rational choice — and it is four points of maintainability weight away from winning even under this frame.

---

## 6. Verdict

**Winner: Convex — conditional on its own committed pilot.** It wins on the two criteria the decision frame says dominate at this stage (velocity and product feel) *and* under both extreme weightings, at the lowest cost at the actual sizing point, with the smallest migration in the field. Its liabilities — weakest IaC/SQL story, a startup vendor, and three load-bearing unverified performance/metering assumptions — are real, priced into this matrix, and (uniquely) resolvable for about one engineer-week before any commitment is made.

**The decision is wrong if:**
1. The one-week S≈5 pilot misses the brief's model — p95 commit→client-update >1 s sustained, or metered spend >50% over §4's projection. This alone erases the margin over GCP; run the pilot before any migration work starts.
2. C9 resolves badly: the kept agent-harness/Bind code cannot run in the Convex (non-Node) runtime, dropping the action ceiling to 10 minutes — zero headroom against the ~10-minute long-turn requirement — and inflating the 10-week estimate.
3. The org's risk appetite hardens against a startup data-plane vendor (or FSL terms shift), making the open-source exit ramp the plan rather than the hedge — then GCP's verified-boring plane is the right answer.
4. Enterprise self-hosting ([INPUT]) becomes a near-term commercial requirement rather than an interest: Convex's multi-node self-host guarantees are UNKNOWN, and Supabase's Apache-2.0 stack becomes materially more attractive.
5. The immediate-revocation stance becomes a contractual customer requirement *with a demanded numeric bound*: Convex's precise bound is advocate-constructed (C1) and would need vendor confirmation or measurement; failing that, re-open against GCP's mechanized (post-C7-fix) 5 s bound.

**Tripwires to instrument (deduplicated, from the briefs):**
1. **Latency:** p95 commit→client-update >1 s sustained for a week at peak (covers the pilot's assumption in production; analog of GCP's 1 s driver gate).
2. **Metering/spend:** reactive re-run spend >$1,000/mo while S<50, or any month >50% over the §4 model (covers every candidate's "platform spend at S≈20" tripwire).
3. **Turn ceiling:** ≥3 model turns/week aborted by the 30-minute action cap (C12 table in view: the fallback executors range 14.5 min to unlimited) → external turn host or reopen.
4. **EU/residency:** no signable DPA with in-region processing commitments by EU-build kickoff → self-host EU or reopen (generalizes the field-wide residency unknowns, incl. GCP's identity-residency risk had it won).
5. **Vendor health:** FSL license change, >25% pricing change, or vendor-distress signal → run the weekly-export + self-host drill within 30 days and re-evaluate.
