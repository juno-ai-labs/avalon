# Judge pass 1 — Avalon data-plane adjudication

- **Judge:** Claude (clean-context pass 1)
- **Read order used:** packet (judge-prompt, decision-frame, cost brief, known-hazards, advocate template, README, owner-notes) → supabase (brief, gate) → gcp (brief, gate) → convex (brief, gate) → aws (brief, gate) → challenges.md in full. Background consulted narrowly: `docs/architecture.md` lines ~183–196 and ~555–563 to resolve C3/C15 (dictation bridge) and the region topology behind C10 — nothing else.
- **Date:** 2026-08-16
- **Handling compliance:** no [PRIOR] line from owner-notes.md is cited anywhere below; [INPUT] lines (SG third region, notification/email-slug workloads, AWS credits as first-year offset, self-host interest) are used under existing criteria only; per the [OPERATOR] annotation, GCP is judged normally.

Two judge rulings on flagged ambiguities, made before scoring:

- **C14 ruling (Supabase's retained Global D1 route store):** permitted. The settled constraint removes per-region D1 *as the product data plane*; an opaque-route lookup table is data-minimal in the same sense as the frame's Workflows carve-out. It still counts as a retained technology under Simplicity.
- **C8 ruling (GCP's Pub/Sub role):** resolved as coherent-but-underdocumented. Reading §1 ("queue/outbox workers" inside the priced Cloud Run instances) with §2 row 5 and §3.2 together: outbox→Pub/Sub is the general job queue; direct Workflow start is the loop fast path; §11 prices only loop-repair traffic. General job traffic at S≈20 is far below Pub/Sub's 10 GiB free tier, so the $0 line survives; the defect is clarity, and it is dinged in Risk, not treated as a missing queue.

---

## 1. Disqualifier table

Checked against cost brief §6 as adjusted by the decision frame (constraint 6 = future-path credibility; constraint 9 = code-migration honesty). **No candidate is disqualified.**

| # Constraint | supabase | gcp | convex | aws |
|---|---|---|---|---|
| 1 Ordering + atomicity | PASS — `FOR UPDATE` head row, single transaction | PASS — same shape | PASS — serializable OCC mutation | PASS — same row-lock shape |
| 2 Durable cursors | PASS — locked allocator, monthly partitions | PASS — locked allocator, partitions | PASS — counter-doc under OCC; snapshot recompute | PASS — locked allocator, `pg_partman` |
| 3 Revocation semantic stated | PASS — immediate only; bounded stance has **no documented mechanism** (C5, verified fact: auth cached per connection) | PASS — bounded 5 s (bound asserted, not mechanized — C7) + priced immediate | PASS with caveat — native per-frame recheck; the precise guarantee is advocate-constructed (C1) | PASS with caveat — ≤60 s epoch mechanism materially incomplete as described (C2); priced immediate fallback exists |
| 4 Durable 2 h+ loops, ≥10-min action | PASS — CF Workflows, unlimited step wall | PASS — 1,800 s HTTP step, 1-yr execution (cited) | PASS with caveat — 30-min Convex-runtime cap; **10-min if Node runtime forced** (C9) | PASS — 900 s invocation, 1-yr async; 14.5-min turn ceiling is the field's lowest (C12) |
| 5 At-least-once queue | PASS — pgmq in-transaction | PASS — outbox + Pub/Sub (per C8 ruling) | PASS — transactional scheduler + Workpool | PASS — outbox + SQS FIFO, 60 s repair |
| 6 Residency (future-path credibility) | CREDIBLE — EU project + fail-closed; contracts UNKNOWN | CREDIBLE — full regional stamp; identity-residency UNKNOWN (named) | PARTIAL — real EU region, **no published DPA/subprocessor list** (named); no SG region exists (owner [INPUT] three-region target) | CREDIBLE — Ireland services verified; DPA review UNKNOWN (named) |
| 7 Tenant authz + FTS/vector | PASS — RLS + invoker views | PASS — RLS, session-mode pooling caveat cited | PASS — function layer is the authz tier; gate patch 1: per-principal rate limiting silently skipped (standing) | PASS — policy functions, no table rights |
| 8 Blob backup honesty | PASS — Avalon-built locked R2 copy, explicitly not PITR | PASS — dual-region GCS + PITR, RPO named | PASS — backups can include file storage (cited) | PASS — S3 versioning+CRR, explicitly outside PITR |
| 9 Migration honesty | PASS — concedes "backend re-platform"; but headline unit ~4× understates (C4) | PASS with hole — EU-data step unexecutable as written (C10); dictation bridge unbudgeted (C15) | PASS with holes — EU data silently dropped (C10); client rewrite is the field's largest inside the smallest estimate | PASS with hole — "retire both Workers" strands the dictation bridge with **no host in the named stack** (C3) |

---

## 2. Scored matrix

Scores 1–10. UX = mean of streaming-feel and consistency-feel, both reported. Weighted total = Σ(weight × score)/10, max 100.

| Criterion (weight) | supabase | gcp | convex | aws |
|---|---:|---:|---:|---:|
| Simplicity (20) | 5 | 4 | 8 | 3 |
| UX — streaming-feel | 6 | 7 | 7 | 5 |
| UX — consistency-feel | 8 | 8 | 9 | 6 |
| UX averaged (20) | 7.0 | 7.5 | 8.0 | 5.5 |
| Maintainability (15) | 7 | 8 | 5 | 7 |
| Migration / velocity freeze (15) | 4 | 6 | 6 | 5 |
| Unproven-assumption risk (15) | 6 | 7 | 4 | 5 |
| Scalability (8) | 5 | 6 | 4 | 6 |
| Cost (7) | 6 | 7 | 8 | 7 |
| **Weighted total** | **57.7** | **64.2** | **63.3** | **52.2** |

**Winner on the frame's weights: GCP, by 0.9 over Convex — inside judgment noise; treat as a photo finish (see §4).** Supabase third, AWS fourth, both by clear margins.

---

## 3. Cell justifications (grouped by criterion)

### Simplicity (counts technologies + bespoke distributed-systems code)

- **supabase 5:** ~6 products across three vendors (Workers/D1/Workflows/R2 + Supabase + WorkOS), but realtime fan-out and the loop driver are managed; bespoke code is repair loops, hint/poll fallback, epoch fencing, and R2 manifest reconciliation.
- **gcp 4:** 7 runtime products + LB/obs/KMS on one cloud, and the field's most bespoke distributed-systems code — a hand-rolled WebSocket gateway over Redis, outbox relays, and lease fencing are exactly what the rubric counts against.
- **convex 8:** one platform replaces DB/realtime/queue/executor/storage/search with near-zero bespoke distributed code (today's ~200-line cursor/resync protocol becomes a query); dinged one point because the honest tech count is ~4–5, not the claimed two (C13: vestigial Worker, Fivetran+warehouse, three newer components).
- **aws 3:** nine products plus five protocols by its own count, and C2 shows the preferred mode needs *additional* unmentioned epoch/re-subscribe machinery on top of the outbox, coalescer, and fencing code.

### UX — streaming-feel (proxies 1, 2, 5, 6)

- **supabase 6:** every visible update is hint + one authorized pull (floor 333 ms + RTT + fetch), degrading to 1–2 s polling past the published 2,500 msg/s ceiling (crossed at S≈278); offsetting credit: retained CF Workflows gives the field's only unlimited turn wall-time (C12), so no tail abort-and-reset artifact.
- **gcp 7:** content pushes at 250 ms batch / 500 ms normal worst with an explicit 500 ms→1 s→2 s degradation ladder and a 2 s worst-case steering stop via 1 s DB poll; driver dispatch p95 <1 s is a gated UNKNOWN (30% self-assessed failure), which caps the score.
- **convex 7:** push of recomputed snapshots at 250–500 ms with no per-frame pull and a two-hop TTFT (~0.5–1.5 s claimed), but the ≤500 ms steering bound collapses to unbounded when the provider stream stalls (C6 — no timer-driven checkpoint named), and push/scheduler latency are undocumented assumptions (A8), so proxies 5 and 1's floors score as unknown, not as claimed.
- **aws 5:** 333 ms cadence, but the ≤60 s epoch mechanism as described either forces every viewer through a per-minute re-subscribe cycle or reduces to invalidation-with-no-latency-SLA (C2), the lost-fast-path TTFT worst case is the 60 s outbox sweep, and the 14.5-min turn ceiling is half the next-worst (C12).

### UX — consistency-feel (proxies 3, 4)

- **supabase 8:** one transaction commits transcript+card+overlays+cursor, so canonical surfaces cannot disagree; a swallowed `realtime.send` leaves both jointly stale only until the 1 s poll; epoch fencing retracts only the crashed attempt's text.
- **gcp 8:** same single-transaction shape with the 202 carrying the committed cursor and `(workstream,seq)` dedup; the 30-min turn abort produces a visible provisional-text reset at the tail.
- **convex 9:** cross-query same-snapshot delivery is a **cited, gate-verified platform property**, so sidebar/transcript disagreement is zero by mechanism and reconnect swaps a consistent snapshot with no client cursor arithmetic to get wrong (C1 attacks the revocation bound, not this).
- **aws 6:** the Aurora transaction is equally atomic, but AppSync "may reach views at different times," and C2's epoch rotations add a periodic delivery seam per minute for every viewer — a recurring reconnect-class artifact none of the other designs has.

### Maintainability (15)

- **supabase 7:** full SQL inspection with `pg_locks`, big Postgres hiring pool, CLI-managed migrations; dinged for the alpha Terraform provider (project/branch/settings only), dashboard-managed compute resize and WorkOS setup, support-ticket-only Realtime quota raises (gate fix: omitted from the §7 table), and two-cloud deploy coordination.
- **gcp 8:** full SQL + pgAudit, and the field's best IaC story — every §1 component has a named `hashicorp/google` resource with residue limited to quota consoles, Memorystore tier replacement, and OAuth consent; expand/backfill/contract closes the old-code/new-schema window.
- **convex 5:** no SQL — inspection is the dashboard browser, TS queries, and a *beta* Fivetran export to a warehouse the team must also run; **no Terraform provider exists** (named), backups schedule and custom domains are dashboard-only, deployment-class raises are support-only; offsetting credit: schema+functions deploy as one validated push, the cleanest hazard-#12 closure in the field.
- **aws 7:** full SQL via Data API and mature terraform-provider coverage including `durable_config`; dinged for nine products on the debug path and Service-Quotas approval residue (AppSync raises, invalidation fixed at 100/s).

### Migration / velocity freeze (15) — scored from C4-normalized engineer-weeks, not headlines

- **supabase 4:** the "8–10 product-weeks" headline is 32–40 engineer-weeks with four engineers frozen (C4) — ~3–4× the rest of the field — even though the kept surface (client REST contract, Hono, Workflows) is the largest.
- **gcp 6:** 14 engineer-weeks (range 12–18) with a coherent shim/cutover story, plus two unbudgeted items: rebuilding the dictation socket proxy on Cloud Run (C15 — capability exists, scope doesn't) and an EU-data step that is unexecutable as written (C10).
- **convex 6:** 10 engineer-weeks is the field's smallest number but contains its largest client rewrite (renderer REST+WS → ConvexClient), a silent runtime-compatibility bet on the kept harness (C9: Node runtime cap is 10 min), and no EU-data answer (C10) — credible mid-teens after padding, same band as GCP.
- **aws 5:** 12 engineer-weeks, but "retire both Workers" deletes the shipped dictation feature or requires an unnamed extra product (C3 — no WebSocket-proxy host exists in the named stack), and the C2 client epoch-renewal machinery is unscoped.

### Unproven-assumption risk (15)

- **supabase 6:** no contact-sales dependency at launch and gate-verified consistency with every vendor fact, but Workflow dispatch latency is UNKNOWN, the alpha-IaC/schedule risk is self-assessed at 40%, and the S=300 path hangs on an **unpublished, unpriced quota negotiation** — the field's largest contact-support dependency; the bounded stance is unpriced and undocumented (C5), leaving the open product decision one-sided on this candidate.
- **gcp 7:** no contact-sales or private-beta dependency at launch or through S=300; risks are honestly quantified (driver 30% launch-delay, Redis 20% at S=300, identity residency 40% EU-only); dinged for C7 (the 5 s revocation bound lacks its fail-closed sentence) and C8's documentation ambiguity.
- **convex 4:** the largest stack of load-bearing unverified claims — C1 (the headline revocation guarantee is assembled from properties its citations don't state; scores as unknown), A5 metering ±2× on the dominant cost line (30% self-assessed), C6, C9, sub-second latency assumptions (A8), two standing gate patches (hazard #9 skipped; auth-scoped cache is an assumption presented as cited), plus startup-vendor concentration; partially redeemed because nearly all of it resolves in a committed one-week pilot with bounded blast radius.
- **aws 5:** the preferred launch mode's central mechanism is materially incomplete per vendor docs (C2), revocation-receipt semantics 25%, DB sizing 35% (every Data API read hits the writer), Durable Functions 15% and young, and the 100/s invalidation quota is non-adjustable (C11); redeemed by a fully priced immediate-pull fallback and published Service-Quotas raise paths.

### Scalability (8) — credible path to ~S=300; owner [INPUT]s (SG third region, self-host) scored here

- **supabase 5:** S=300 is money **only if** an unpublished negotiation grants >2,500 msg/s; single primary, vertical-only to 16XL ($3,730/mo), thinnest resilience posture (no replica priced); SG region exists; self-host is credible (open-source Postgres/Realtime) if the team operates the fan-out cluster.
- **gcp 6:** the single writer is named honestly with a money/config path to S≈300–700 and sharding after; Redis's unpublished msg/s ceiling is a pre-committed 2× load-test gate; SG region trivially exists; self-host/on-prem is the field's weakest (no open-source equivalent of Cloud SQL/Workflows/Identity).
- **convex 4:** money first, then a contact-sales deployment class, then an honest dead end at S≈2,000 (no published shard story inside a deployment); **no SG region exists** against the owner-[INPUT] three-region target, with self-hosting as the stated fallback; the same open-source backend is the field's best vendor-death exit ramp — an exit, not a region.
- **aws 6:** first pressure (AppSync tokens) has a published Service-Quotas raise path; Aurora's 256-ACU ceiling and cross-cluster sharding are named as the architectural break; SG and Ireland regions verified; per-region floors are low (serverless Aurora, ~$72 staging).

### Cost (7) — normalized table (challenges Part B), S≈20 primary

- **supabase 6:** $1,300 immediate / ≈$1,275 bounded-unverified at S≈20; the S=300 column is flagged contingent on the unpriced uplift (dead-end signal, not a launch cost).
- **gcp 7:** $968 bounded / $1,627 immediate at S≈20, and it is the only brief pricing HA×2 + cross-region DR (~$1.67k of its S=300 line) — its sticker overstates like-for-like cost.
- **convex 8:** $540 at S≈20, stance-invariant by construction, $0 auth line at every scale; ±2× A5 uncertainty worst-cases to ~$1.4k, still field-competitive.
- **aws 7:** $943 bounded at S≈20 with the $16k S=300 outlier decomposing almost entirely into removable choices (Cognito $3,600, immediate delta, whole-loop-active Lambda); the $25k credits are a real first-year offset per the owner [INPUT], never a rate change.

---

## 4. Sensitivity analysis (mandatory)

**(a) Smallest assumption change that flips the winner.** The GCP–Convex gap is 0.9 weighted points — one point in one cell. Two single-cell moves flip it: (i) reading C8 as a genuine architecture ambiguity rather than a documentation defect (GCP Risk 7→6) makes Convex the winner 63.3 : 62.7; (ii) the cheapest *evidence-based* flip is Convex's own committed one-week S≈5 pilot — if it confirms the A5 metering model and measures sub-second revocation delivery (resolving C1), Convex Risk 4→6 and Convex wins ≈66.3 : 64.2. Conversely, GCP's launch-gate benchmark failing (driver dispatch p95 ≥1 s, 30% self-assessed) drops GCP's streaming-feel and Risk scores and flips the same way. The verdict is genuinely two-horse; Supabase and AWS are not within reach of any single-cell change.

**(b) Which weight change flips it.** Shifting ≈1.5 points of weight from Unproven-assumption risk (15→13.5) to Simplicity (20→21.5) flips the winner to Convex (per point shifted, the GCP−Convex gap moves −0.7). Equivalently, moving ~2.6 points from Maintainability to UX does it. No plausible reweighting rescues AWS or Supabase: AWS needs Maintainability+Risk weights roughly doubled at Simplicity's expense; Supabase needs Migration's weight zeroed *and* Simplicity cut.

**(c) Extreme weightings.**
- **Pure "maximum product feel" (UX only): Convex** — best consistency-feel in the field (9: same-snapshot delivery is cited platform behavior, zero sidebar/transcript divergence by mechanism) and tied-best streaming-feel; GCP second at 7.5.
- **Pure "minimum velocity freeze" (Migration only): Convex, narrowly and with the least-verified number** — 10 engineer-weeks vs GCP's 14 and AWS's 12 (C4-normalized), but Convex's figure carries the largest client rewrite and the C9 runtime bet, and AWS's carries the C3 hole; if C9 fires, GCP's 14 becomes the honest minimum. Supabase is last (32–40) under any reading.

That the frame's own rhetoric ("velocity and product feel dominate") favors the runner-up under both pure weightings, while the frame's actual numbers favor GCP, is the finding this pass hands the aggregate: the weights as pinned put ~45 points on stewardship criteria, and that is precisely GCP's margin.

---

## 5. Minority report — the case for Convex, written as if I believed it

The decision frame says velocity and product feel dominate, and one candidate is simply built for the point on the curve where Avalon actually lives. At S≈20, Convex deletes the problems the other three briefs spend their pages mitigating: there is no cursor-arithmetic protocol to get wrong because reconnect is a snapshot recompute; there is no outbox, no repair sweep, no hint-then-pull round trip; the sidebar cannot disagree with the transcript because cross-query snapshot consistency is the platform's documented contract, not Avalon's code. The ~200 lines of checkpoint/resync machinery in `WorkstreamRoom` become a query. Every other candidate asks a four-person team to hold five to nine products and write the distributed-systems glue between them; Convex asks them to write TypeScript in one deploy loop, which is why its 10-week estimate — even padded for the renderer port — is credible where Supabase's 32–40 engineer-weeks is disqualifying at this stage.

The scoring holds Convex's revocation claim to "unknown as cited" — correctly — but look at the shape of the uncertainty: C1 concedes the mechanism is a *plausible engineering inference* about the vendor's core product behavior, and the brief commits to a one-week pilot that resolves it, the A5 metering question, and the latency assumptions simultaneously, for roughly the cost of one sprint. Compare that to what the alternatives ask you to bet on before the same evidence exists: GCP's product feel rests on an unbenchmarked Workflows dispatch path (30% self-assessed failure) and an unpublished Redis ceiling behind a hand-rolled gateway the team must build and then own; Supabase's whole S=300 story rests on a quota negotiation with no rate card. Convex's risks are measurable in a week; the field's risks are discovered in production.

The stewardship objections are real but priced. No SQL — mitigated by streaming export, and the team writes typed TypeScript queries daily anyway. Vendor size — hedged by the only same-code open-source backend in the field, with a weekly export drill; the SG gap resolves the same way. The S≈2,000 dead end is the *honest* version of the sharding cliff every single-writer Postgres candidate also hits; Convex just names it. At $540/month, stance-invariant on the one product decision still open, with zero auth tax and no per-region floor, the rational move is: run the one-week pilot, and if the meters and the revocation bound read as modeled, take the substrate that makes the product feel best and ships soonest.

---

## 6. Verdict

**Winner: GCP** (Cloud SQL Postgres + Cloud Run + Memorystore + Pub/Sub + Workflows + GCS + Identity Platform), 64.2 weighted, over Convex 63.3, Supabase 57.7, AWS 52.2.

The margin is 0.9 points — a photo finish, and this pass reports it as such for the aggregate. GCP wins because it is the only candidate that pairs a credible product-feel story (content push, 250–500 ms cadence, single-transaction coherence) with the field's best stewardship posture: everything is SQL-inspectable, everything is in mature Terraform, no launch or S=300 step depends on an unpublished negotiation or a private beta, the single writer's failure point is named with a money-then-architecture path, and it is the only brief that priced HA and cross-region DR at all. Its two real weaknesses — a seven-product surface with a hand-rolled gateway, and unbenchmarked driver latency — are respectively a staffing tax and a gated, measurable unknown. Convex loses this pass on verify-before-weigh, not on architecture: its three headline differentiators (per-frame revocation, zero-cost stance invariance, "two technologies") were each successfully challenged (C1, C6/C9, C13), and the protocol requires scoring challenged, uncited claims as unknown.

**Conditions under which this verdict is wrong:**

1. **The Convex pilot reads as modeled.** A one-week S≈5 load test confirming A5 metering (±50%) and sub-second measured revocation delivery converts Convex's Risk 4 to ≥6 and flips the decision — this is the single cheapest decisive experiment available and should be run *before* committing migration weeks to GCP.
2. **GCP's driver-latency gate fails.** If commit→Workflow start→first byte p95 ≥1 s in the 10k-sample regional benchmark, GCP's streaming-feel and risk scores were overstated and the verdict flips toward Convex (or Supabase if Convex's pilot also failed).
3. **The Redis fan-out gate fails at M3.** No published msg/s ceiling exists; failure at 2× S=300 reopens architecture, not just sizing.
4. **The team cannot staff the surface.** If the seven-product estate plus the bespoke gateway measurably drags velocity in the first quarter post-migration, Simplicity was mis-weighted in this pass and Convex's one-platform bet was the right one.
5. **Enterprise self-host/on-prem becomes a near-term commercial requirement** (owner [INPUT]): GCP is the field's weakest self-host story; sustained prospect demand reopens the decision in favor of the open-backend candidates (Convex, Supabase).

**Tripwires to instrument (deduplicated from the briefs):**

1. **Driver dispatch:** Workflow dispatch overhead p95 >1 s, or end-to-end TTFT p95 >5 s — reopen (GCP §10; same gate appears in Supabase §3.2 and AWS §3.2).
2. **Fan-out layer:** Redis publish p99 >50 ms, failover gaps in >0.1% of watched sessions, or failure of the 2× S=300 (5,400 deliveries/s) load test at tier M3 — reopen architecture (GCP §10).
3. **Single writer:** commit p95 >100 ms, per-stream lock-wait p95 >50 ms, or primary CPU >65% sustained at S<300 — start the sharding design before it is an emergency (GCP §10; the same writer tripwire appears in AWS §10 and Supabase §10).
4. **Cost envelope:** platform spend >$2,000/month at S≈20, or identity spend >$500/month before material enterprise revenue — re-price against the normalized table (GCP §10; AWS §10's $1,500 analogue deduplicated into this).
5. **Region/residency clock:** 90 days before EU (or SG) build kickoff, identity-residency and DPA commitments unresolved, or a quarterly restore drill missing its RPO/RTO — fail the launch closed and reopen the auth/residency choice (GCP §10, Supabase §10, Convex §10 deduplicated).
