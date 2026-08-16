# Judge pass 2 — Avalon data-plane adjudication

**Judge:** Claude (clean-context pass 2, no involvement in any brief, review, or packet)
**Read order:** packet (judge-prompt, decision-frame, cost brief, known-hazards, owner-notes) → candidate briefs aws, convex, supabase, gcp (each brief.md then gate-report.md) → challenges.md in full. Background consulted only twice, both targeted: `docs/architecture.md` lines ~184–194 (dictation bridge, for C3/C15) and its region-boundary sections (EU deployment, for C10).
**Date:** 2026-08-16

Handling-rule compliance: no [PRIOR] line from owner-notes.md is cited anywhere below; [INPUT] lines (SG third region, self-host interest, notification fan-out workload, AWS credits as first-year offset only) are scored under existing criteria; per the [OPERATOR] annotation, GCP is judged normally.

---

## 1. Disqualifier table

Nine hard constraints (cost brief §6), with the frame's two adjustments (EU = future-path credibility; migration = code-rewrite honesty at ~zero users).

| Candidate | C1 order/atomic | C2 cursors | C3 revocation | C4 durable exec ≥10-min action | C5 queue | C6 EU future-path | C7 tenant authz+search | C8 blob DR | C9 D1/R2 migration | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| aws | PASS (row lock + single txn) | PASS (locked allocator, partitions) | **WEAKENED** — preferred ≤60 s epoch mode is mechanically incomplete (C2 STRONG: filters evaluate at subscribe time; either an unpriced per-minute re-subscribe cycle for every viewer or the bound collapses to un-SLA'd invalidation). Credible mitigation exists: the immediate-pull mode is fully specified and priced (+$240/+$2,810) | PASS (durable invocations 1 yr; 900 s step; **14 m 30 s turn ceiling, lowest in field — C12**) | PASS (outbox + SQS FIFO + sweep) | PASS-as-path (Ireland verified; DPA review UNKNOWN, named) | PASS | PASS (S3 CRR + snapshot copies) | PASS with defect — "retire both Workers" strands the dictation bridge (C3 STRONG); gate stated but unpriced product missing | **Not disqualified** (fallback mode saves C3-the-constraint) |
| convex | PASS (serializable OCC txn) | PASS (counter-doc in txn; snapshot catch-up) | **UNKNOWN, not as-claimed** — per-frame auth-fresh delivery is assembled from three properties its citations do not contain (C1 STRONG); mechanism shape (server-side query re-execution) is credible, precise bound uncited | PASS with caveat — 30-min Convex-runtime action ≥ 10-min turn, **but Node-runtime cap is 10 min and harness-runtime compatibility is an unstated assumption (C9)** | PASS (transactional scheduler; documented guarantee) | PASS-as-path (Ireland region verified live; DPA UNKNOWN, honestly declared) | PASS (function layer is the app tier) | PASS (backups optionally include file storage) | PASS with defect — EU D1 never mentioned (C10) | **Not disqualified** |
| supabase | PASS (head-row lock) | PASS (locked head, partitions from day one) | PASS — immediate-pull with arithmetic shown (120 reads/s at S=20); **bounded-push side has no documented mechanism at all** (C5; verified fact: Realtime caches auth per connection, no bound) — the org's open product decision has one exercisable side here | PASS (retained CF Workflows: unlimited step wall time — cited against the contradictory limits page correctly) | PASS (pgmq in-txn) | PASS-as-path (separate EU project; fail-closed; UNKNOWN contracts named) | PASS (RLS + invoker views; service-key bypass warned) | PASS (Avalon-built locked R2 copy; honestly not claiming PITR covers blobs) | PASS (epoch route switch; D1 retained read-only) | **Not disqualified** |
| gcp | PASS (row lock, lock covers no network I/O) | PASS (partitioned events, attested watermark) | PASS with fix required — 5 s bounded push, but the fail-closed rule when the recheck path dies is missing (C7 MODERATE; one-sentence fix); strict-immediate priced as alternative | PASS (Workflows 1 yr / 1,800 s HTTP step / Cloud Run 3,600 s hosts a 10-min turn whole — citation-verified) | PASS with ambiguity — three inconsistent accounts of what transits Pub/Sub (C8) | PASS-as-path (residency-list services; identity residency named as 40% risk) | PASS (RLS, session-mode pooling caveat cited) | PASS (dual-region GCS + PITR + DR replica — only brief pricing full HA/DR) | PASS with defect — "EU data follows the same isolated procedure" is unexecutable with no EU region at launch (C10); dictation rebuild unbudgeted (C15, hostable on Cloud Run) | **Not disqualified** |

**C10 ruling (from architecture.md):** the product deploys twice today with a live EU plane; at ~zero users EU rows are plausibly empty but unverified. Every cutover plan must gate on "EU D1 verified empty, or rows exported/relocated." Only AWS states this gate ("assert EU is empty or stop"); GCP's plan is unexecutable as written; Convex is silent. Scored as small migration/risk dings, not disqualifiers, per the frame's zero-users adjustment.

**C14 ruling:** Supabase's retained Global D1 route store (opaque workspace routes only) is data-minimal by the same logic as the frame's Workflows carve-out; I rule it permitted, but the brief should have argued it — a scope-discipline note, not a violation.

**Hazard cross-check summary (step 3):** AWS 12/12 addressed (but hazard-3 economics ride the broken preferred mode; hazard-10 ceiling is the field's lowest at 14.5 min). Convex 11/12 at gate (hazard 9 skipped — patch requested; hazard 5's "no lost-notification case" is defined away, not bounded — C6, scores unknown; hazard 3 inapplicability now rests on the C1-unknown claim). Supabase 12/12, consistent with every verified vendor fact. GCP 12/12 (hazard 8 answered in the honest no-published-ceiling form; hazard 6 substance misplaced in §11 but present). No brief contradicts a verified vendor fact without a fresher citation.

---

## 2. Scored matrix

Scores 1–10. UX reported as streaming-feel / consistency-feel, averaged only in the weighted sum. Weighted total out of 1,000.

| Criterion (weight) | aws | convex | supabase | gcp |
|---|---:|---:|---:|---:|
| Simplicity (20) | 3 | 8 | 6 | 4 |
| UX — streaming-feel (20, half) | 6 | 7 | 6 | 7 |
| UX — consistency-feel (20, half) | 7 | 9 | 7 | 7 |
| Maintainability (15) | 7 | 5 | 8 | 7 |
| Migration / velocity freeze (15) | 6 | 8 | 4 | 6 |
| Unproven-assumption risk (15) | 4 | 5 | 7 | 6 |
| Scalability (8) | 7 | 5 | 4 | 7 |
| Cost (7) | 5 | 9 | 5 | 7 |
| **Weighted total (/1000)** | **536** | **693** | **602** | **610** |

Rank: **Convex 693 > GCP 610 > Supabase 602 > AWS 536.** The 8-point GCP/Supabase separation is inside this judge's noise floor and should be read as a tie for runner-up.

---

## 3. Cell justifications (grouped by criterion, one mechanism-or-number each)

### Simplicity (20)
- **aws 3:** self-declared nine AWS products plus five protocols, plus the C3-stranded dictation bridge needing an unnamed tenth (API-Gateway-WebSocket-shaped), plus bespoke epoch-rotation/outbox/merge machinery.
- **convex 8:** one platform subsumes DB, realtime, queue, executor, blobs, search, and auth validation, and deletes ~200 lines of cursor/resync protocol; C13's honest count is ~5 technologies (platform, Electron, vestigial Worker, Fivetran+warehouse, third-party components), not the claimed 2 — hence 8, not 9–10.
- **supabase 6:** ~7 operational concepts (Hono/Workers, Postgres/Supabase, Realtime, pgmq/Cron, Workflows, R2, WorkOS) and retained bespoke cursor/epoch/hint-fallback code, but each is a mainstream primitive.
- **gcp 4:** seven runtime products plus LB/observability/KMS, and the field's largest bespoke distributed-systems item — a hand-built WebSocket gateway fleet with Redis fan-out and revision rechecks — plus C8's unresolved queue-architecture ambiguity.

### UX — streaming-feel (proxies 1, 2, 5, 6)
- **aws 6:** scored on the intact immediate-pull mode (C2 breaks the preferred mode): 333 ms cadence floor holds but every frame costs an authorized pull (120 QPS at S=20), TTFT dispatch is UNKNOWN behind a stated 1.5 s gate, steering 2.5 s engineered worst case.
- **convex 7:** two-hop dispatch with no polling (commit → scheduler → action) targets TTFT = model + 0.5–1.5 s, and reconnect is one recomputed query regardless of gap; capped at 7 because push latency has no documented bound and C6 voids the ≤500 ms steering worst case when the token stream stalls (no timer-driven checkpoint named).
- **supabase 6:** every visible update is hint + authorized fetch (adds an RTT to the 333 ms floor), steering bound is a real number (2 s poll → 3 s stop), and the 1 Hz polling fallback degrades gracefully; at S=20 the 180 msg/s load is 7% of the published 2,500 msg/s cap.
- **gcp 7:** content rides the socket at 250 ms cadence with a 500 ms normal worst case and a 2 s steering stop via 1 s row poll; capped by the UNKNOWN Workflow dispatch latency that is its own 30%-probability launch risk.

### UX — consistency-feel (proxies 3, 4)
- **aws 7:** one Aurora transaction commits transcript+card+overlays so durable views cannot diverge; AppSync delivery skew and the subscribe-buffer-fetch-merge seam leave transient windows.
- **convex 9:** cross-query same-snapshot delivery is a gate-verified documented platform property — sidebar and transcript literally cannot show different commits — and epoch-CAS retraction removes provisional-text ghosts; not 10 because reconnect snapshot-monotonicity is undocumented (C1 evidence).
- **supabase 7:** single-transaction authority, but `realtime.send` documentedly swallows its own errors, so both surfaces can sit jointly stale up to the 1 s poll.
- **gcp 7:** cursor-carrying socket bundles off one commit prevent cross-view disagreement; Redis loss shows as slower cadence, repaired by durable catch-up.

### Maintainability (15)
- **aws 7:** read-only SQL via Data API, the most mature Terraform story in the field (full resource coverage), large hiring pool — against nine products to operate and Service-Quotas ticket residue.
- **convex 5:** no SQL (dashboard browser + TypeScript queries + a beta Fivetran path to a warehouse), **no Terraform provider at all**, backups and custom domains dashboard-only, deployment-class raises via support — all named, so no hiding penalty, but the frame's IaC preference is triply unmet.
- **supabase 8:** one SQL session joins the entire regional truth (`pg_locks` included), Postgres hiring pool is the largest available, CLI migrations are enforced; alpha Terraform provider and dashboard compute-resize/quota residue keep it off 9.
- **gcp 7:** everything canonical is SQL-queryable and Terraform coverage is mature; Memorystore tier changes require replacement and the bespoke gateway is code only this team will ever have debugged.

### Migration / velocity freeze (15) — normalized per C4 to engineer-weeks
- **aws 6:** 12 engineer-weeks (2 eng × 6 cal) is second-best, but C3 adds silent unpriced scope (dictation needs a product outside the named stack) and the plan's EU gate is, to its credit, the only executable one.
- **convex 8:** ~10 engineer-weeks, lowest in field, with genuine deletion (DO/Workflows/Queues/D1 local-dev matrix); held below 9 because it contains the largest client rewrite (renderer REST+WS → ConvexClient), C9's unverified runtime-compatibility assumption, and C10 silence on EU rows.
- **supabase 4:** the smallest headline (8–10 "product-weeks") is the largest actual freeze — 32–40 engineer-weeks at the stated four engineers (C4) — even though its technical delta (client contract, Hono, Workflows, R2 all retained) is the smallest.
- **gcp 6:** 14 engineer-weeks plus C15's unbudgeted dictation rebuild (hostable on Cloud Run, so scope not capability) and an unexecutable EU line (C10).

### Unproven-assumption risk (15)
- **aws 4:** two STRONG challenges land here — the preferred revocation mode doesn't work as described (C2) and a shipped feature is stranded (C3) — on top of self-assessed 35% DB-sizing and 15% durable-runtime risks and a 14.5-min turn ceiling half the next-worst (C12).
- **convex 5:** headline differentiator scores unknown (C1), dominant cost line is ±2× (A5, ~30%), vendor is a startup whose exit ramp is self-hosting (~15%), and C9 could halve the action ceiling; mitigated by the cheapest decisive resolution in the field (one-week S≈5 pilot read off the usage dashboard) and zero launch-time contact-sales dependencies.
- **supabase 7:** lowest probability-weighted launch-gate failure — auth federation is a documented WorkOS integration (gate-verified), the loop driver is the one already in production, and S=20 sits at 7% of the published Realtime cap; deductions for the C5 one-sided product decision and the self-declared 40% IaC/schedule risk.
- **gcp 6:** three quantified risks (driver latency 30%, Redis ceiling 20%, identity residency 40% — the last EU-future) with load-test gates and no contact-sales at launch; C7 is a one-sentence fix, C8 an unresolved architecture ambiguity.

### Scalability (8) — credible path to ~S=300
- **aws 7:** first pressure (AppSync 10k request-tokens/s) has a published Service-Quotas path; single writer tops at 256 ACU with benchmark risk; S=2,000 honestly named architectural.
- **convex 5:** S=300 is money (~$8.4k) plus a **contact-sales** deployment-class raise (D1024), and S≈2,000 is an honestly-declared dead end (no published shard story inside a deployment) — the frame counts every contact-sales dependency.
- **supabase 4:** the published 2,500 msg/s project cap is crossed at S≈278 with **no published uplift path or price**, the single primary tops at 16XL, and it fields the thinnest resilience posture (single 4XL, no replica — cost audit).
- **gcp 7:** money/configuration to S≈300–700 (vertical SQL, retention, read isolation) before workspace sharding; fan-out has no per-message meter, so the scaling constraint is the unverified Redis ceiling, gated by a 2× load test.

### Cost (7) — normalized table (challenges Part B), S≈20 primary
- **aws 5:** $1,183 immediate (bounded $943 rides the broken mode); the $16.1k S=300 outlier decomposes into removable choices (Cognito $3,600, per-loop compute) — noted, and the $25k credits are a first-year offset only, per the owner-note handling rule.
- **convex 9:** $540 corrected — cheapest in field and stance-invariant by construction; even the A5 2× worst case (~$1.1k) stays at-or-below the others.
- **supabase 5:** $1,300 with the highest fixed floor ($599 Team + $210 compute + $100 PITR before any usage); the S=300 column is contingent on an unpriced negotiation.
- **gcp 7:** $968 bounded including the only full HA×2 + cross-region DR posture in the field (~$1.67k of its SQL line at S=300); contingent on its two least-verified inputs (Redis ceiling, 10-instance Cloud Run sizing).

---

## 4. Sensitivity analysis (mandatory)

**(a) Smallest assumption change that flips the winner.** No *single* assumption flip closes Convex's 83-point lead over GCP. The smallest *compound* change — and it is exactly what Convex's own committed one-week pilot tests — is: the S≈5 pilot resolves adversely on both metering and latency (A5 lands at its 2× worst case **and** p95 commit→client push exceeds 1 s). That takes cost 9→5 (−28), streaming-feel 7→5 (−20), risk 5→4 (−15): Convex ≈630 vs GCP 610 — margin gone; add C1 resolving against Convex (vendor confirms re-delivery is not auth-fresh per frame, so hazard 3 becomes applicable and the revocation stance needs redesign) and Convex drops below GCP. Flip condition, stated plainly: **if the pilot fails, GCP wins.** For completeness: re-scoring Supabase's migration by its headline instead of C4's engineer-weeks (4→7) lifts it to 647 — still short.

**(b) Which weight change flips it.** Convex's weakest criterion is Maintainability (5 vs Supabase 8, GCP 7). Shifting weight from Simplicity into Maintainability closes the Convex–GCP margin at ~6 pts per weight point moved: a flip needs Simplicity 20→~6 and Maintainability 15→~29 — far outside any plausible reading of the frame. Alternatively, Risk would have to grow from 15 to ≈50 (funded from Simplicity/UX) before Supabase passes Convex. **No defensible re-weighting flips the result;** the result is weight-robust and assumption-fragile (see (a)).

**(c) Extreme weightings.**
- *Pure product feel* (UX only): Convex 8.0 > GCP 7.0 > AWS 6.5 = Supabase 6.5 → **Convex**, on the gate-verified same-snapshot consistency mechanism.
- *Pure minimum velocity freeze* (migration only): Convex ~10 engineer-weeks > AWS 12 > GCP 14 (+unbudgeted scope) > Supabase 32–40 → **Convex**.
That the winner holds at both extremes, and under every plausible weight shift, is the strongest feature of this verdict; its fragility is concentrated entirely in unverified vendor behavior, not in the frame.

---

## 5. Minority report — the honest case for GCP

Believe this: Avalon is about to bet its data plane on uncited platform guarantees from a venture-backed startup. The three sentences doing the most work in the Convex brief — auth-scoped caching, read-set-driven subscription re-execution, no-stale-snapshot delivery after a revoking commit — are, per the operator's own verification, *not in the vendor's documentation* (C1). Its cost advantage sits on a ±2× metering assumption (A5); its steering bound dissolves the moment a provider stream stalls (C6); its action ceiling may silently halve to exactly the requirement with zero headroom (C9); and when something goes wrong at 2 a.m., there is no SQL, no Terraform, and a backup you restore by destructively wiping a deployment.

GCP, meanwhile, is the only candidate whose realtime cost does not scale per-message — the ~$3.5–3.8k/month platform difference at S=300 the cost audit calls "a real platform difference," not an assumption artifact. It is the only brief that priced HA×2 plus a cross-region DR replica rather than a single box. Every mechanism in it is boring, hireable, and inspectable: Postgres row locks, an outbox, RLS, Terraform. And every challenge landed against it is shallow: C7 is a one-sentence fail-closed rule, C8 is a paragraph naming which queue carries what, C15 is a budget line for a socket proxy Cloud Run demonstrably can host. The challenges against Convex go to whether its central mechanism exists as claimed; the challenges against GCP go to whether its author wrote three sentences carefully enough. A team that expects to be surprised should prefer the stack whose failure modes are already understood by a million other teams — and should note the owner-flagged interests (SG third region, enterprise self-hosting) both favor a substrate where a region is a Terraform module and self-hosting is ordinary Postgres, not an FSL escape hatch.

---

## 6. Verdict

**Winner: Convex** — 693/1000, on the field's fewest technologies, the only mechanically-zero window between sidebar and transcript, the shortest velocity freeze, the lowest cost at the primary sizing point (stance-invariant across the open revocation decision), and no launch-time contact-sales dependency. The verdict is conditional in an unusually crisp way: every major weakness (A5 metering, push latency, C1 revocation semantics, C9 runtime cap) is resolvable by one cheap committed pilot plus one vendor letter, before any migration week is spent.

**This verdict is wrong if:**
1. The one-week S≈5 pilot misses the §4 cost model by >50% *or* shows p95 commit→client push latency >1 s — the compound flip in §4(a); the decision reverts to **GCP**.
2. The vendor cannot confirm in writing (docs update or contract) that subscription re-delivery after a revoking commit is auth-fresh per frame including caches (C1) — and the org simultaneously requires immediate revocation; then Convex's differentiator collapses and GCP's bounded-push (with the C7 fail-closed fix) is the better-evidenced shape.
3. The kept agent harness cannot run in the restricted Convex runtime, forcing `"use node"` and a 10-minute action ceiling equal to the long-turn requirement with zero headroom (C9), and no external turn host is acceptable.
4. Enterprise self-hosting (owner [INPUT]) becomes a near-term contractual requirement rather than an interest — Convex's FSL self-host exit is real but is an exit ramp, not a product; GCP/Supabase's ordinary-Postgres story is stronger there.
5. The SG third region ([INPUT]) arrives early and Convex's region catalog hasn't grown past US/EU — a per-region availability dependency none of the hyperscalers has.

**Tripwires to instrument (deduplicated from the briefs):**
1. **Pilot fidelity (pre-commitment gate):** one-week S≈5 load test read off the usage dashboard; reactive-re-run spend >$1,000/mo while S<50, actuals missing the brief's §4 model by >50%, or p95 commit→client latency >1 s sustained a week → re-price against GCP and reopen. *(Convex §10; doubles as this verdict's flip test.)*
2. **Revocation semantics:** no vendor-confirmed per-frame auth-freshness statement by launch, or any removal/publish race test showing pre-revocation content newly delivered after the revoking commit → adopt the bounded-staleness stance explicitly or reopen. *(Derived from C1 + the AWS brief's race-trial tripwire.)*
3. **Turn ceiling:** ≥3 model turns/week aborted at the action ceiling, or harness found to require the Node runtime (10-min cap) → external turn host or reopen. *(Convex §10 + C9/C12.)*
4. **EU contractual floor:** no signable DPA with in-region processing commitments by EU-build kickoff → self-hosted EU deployment or reopen. *(Convex §10; same tripwire shape as Supabase §10 and GCP §10 — deduplicated.)*
5. **Vendor health:** FSL license change, >25% pricing change, or a distress signal → execute the export + self-host drill within 30 days; drill is rehearsed weekly (`npx convex export`) so the ramp is warm. *(Convex §10 + risk 2.)*
