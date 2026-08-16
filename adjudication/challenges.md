# Challenges — operator-run adversarial verification

Produced 2026-08-16 by two clean-context cross-examination agents (one on
mechanisms, one rebuilding all cost figures), replacing the advocate rebuttal
round per the README's protocol. Role for judges: wherever the protocol says a
"rebuttal" challenges a claim, this file plays that role — a claim
successfully challenged here and lacking a citation scores as unknown.

## Operator rulings on two packet ambiguities the briefs read differently

- **P1 — loop count at S=300.** The demand model §2 (211,200 loops/mo,
  derived) governs over §8's illustrative growth workload (100k). Judges
  score all executor lines at 211,200; the cost audit provides the
  adjustment for the one brief (GCP, declared) that used 100k (+$111).
- **P2 — fan-out formula.** `3 × (1+V) × S` means 1 send + V=2 receiver
  deliveries. The cost audit's normalized table corrects the one brief
  (Convex, declared assumptions, misread against its own interest) that
  billed 3 receiver re-runs. Score cost from the normalized table.

---

# Part A — Mechanism challenges

**Coverage:** Verified semantics on Convex (query-functions, realtime, OCC, limits pages), AWS (AppSync invalidation doc, AppSync service-quotas table, Lambda durable-invoking), Supabase (third-party WorkOS doc, third-party overview) against the four briefs; checked cross-brief consistency on the Hono/dictation Worker, EU data at cutover, migration units, and turn-abort ceilings against `docs/architecture.md`.
**Not reached:** GCP Memorystore/Cloud Run/Workflows pages beyond the gate's checks, cost arithmetic (Part B), Cognito/Identity Platform pricing pages, Aurora/Cloud SQL sizing plausibility.

## STRONG

### C1 — Convex §3 ("The revocation claim, precisely"): the immediate-revocation guarantee is assembled from three properties its own citations do not contain
**Claims:** (a) "identical queries are shared only per identical auth"; (b) the server records each subscribed query's read set — "the same bookkeeping that powers OCC"; (c) "after that commit, no result computed at a pre-revocation snapshot is newly delivered"; (d) "cached results are invalidated by the same read-set overlap."
**Evidence (fetched 2026-08-16):** `docs.convex.dev/functions/query-functions` says only that identical query+args share a cached response — **nothing about auth scoping the cache** (no other docs page states it; searched). `docs.convex.dev/database/advanced/occ` defines read sets **for write transactions at commit time only** — no statement that subscription re-execution is driven by per-subscription read-set bookkeeping. `docs.convex.dev/realtime` documents same-snapshot delivery but **no statement about when a removed user's subscription stops receiving, no snapshot-monotonicity guarantee across reconnect, no latency bound.** The precise guarantee the brief needs — no pre-revocation-snapshot result is *newly delivered* after the revoking commit, including from caches and across reconnects — is advocate-constructed, presented with citations that don't say it. This claim decides the brief's headline differentiator ("both stances $0"), its hazard-#3 inapplicability ruling, and its §3.3 "window of disagreement: zero" claim. Plausible engineering inference; unsupported as cited.

### C2 — AWS §2 row 3 + §3.1: the ≤60 s bounded-push epoch mechanism requires every viewer to re-subscribe every ≤60 s, which the brief never mentions — or the bound doesn't exist
**Claim:** content carries a random `delivery_epoch` rotated at least every 60 s; only a currently authorized REST read returns the next epoch, and old subscription filters no longer match.
**Evidence:** AppSync's invalidation doc — subscription filters are "defined in the GraphQL resolver's response handler of the subscriptions," i.e., **evaluated once, at subscribe time**. A REST read returning a new epoch changes nothing server-side. Either (a) subscribers pin the epoch, and every authorized viewer must tear down and re-establish its subscription each rotation — a per-minute re-subscribe + fetch cycle for all viewers (60 at S=20 / 900 at S=300), a delivery seam per rotation for the §3.4/§3.6 machinery, none of it mentioned or priced ("connection/subscription/invalidation operations round to <$1"); or (b) subscribers don't filter on epoch, old filters keep matching, and the 60 s bound reduces to invalidation — for which the brief concedes AWS documents no latency. The preferred launch mode's central mechanism is materially incomplete as described.

### C3 — AWS §1/§5: "retire both Workers" strands the Azure dictation WebSocket bridge — no component in the named stack can host it
**Evidence:** `docs/architecture.md` (~187–194, 561–563): the regional Worker today terminates a client WebSocket and bridges to an authenticated Azure WebSocket — a stateful third-party socket proxy. Lambda Function URLs do not serve WebSockets; AppSync subscriptions cannot proxy an arbitrary upstream socket. The Convex brief independently confirms the constraint and keeps a Worker precisely for this. AWS's migration either silently deletes a shipped feature or needs an unnamed extra product (e.g., API Gateway WebSocket APIs + state), unpriced and outside its "nine AWS products" count. Direct cross-brief contradiction: Convex §1 vs AWS §5.

### C4 — All four §5s: "product-weeks" is not the same unit across briefs; Supabase's smallest headline number is the largest actual freeze
**Evidence:** AWS: "12 product-weeks; with two engineers, about 6 calendar weeks" (product-week = engineer-week). GCP: 14 product-weeks / 2 engineers / ~7 calendar weeks (same convention). Convex: ~10 product-weeks / 2 engineers (same). Supabase: "8–10 product-weeks … assumes three backend and one desktop engineer" with a calendar-week schedule — i.e., **32–40 engineer-weeks**, ~3× AWS and ~4× Convex, under the same label; it also silently assumes four engineers exist to freeze. Additional incomparability: Convex's count contains the largest client rewrite of the four (renderer REST+WS → ConvexClient); Supabase's the smallest (client keeps the REST contract). The Migration criterion (weight 15) cannot be scored from headline numbers as written.

## MODERATE

### C5 — Supabase §11 vs the decision frame's standing decision: the bounded-staleness stance is neither priced nor shown feasible
The frame requires pricing both stances where costs differ — they do (the pull tier disappears), and no figure is given. Worse: the packet's verified fact (auth cached per connection; no documented bound for an already-joined channel) means Supabase has **no documented mechanism** for a ≤60 s push bound at all — the org's open product decision has only one exercisable side on this candidate, stated only obliquely.

### C6 — Convex §3.5: the "≤500 ms, no lost-notification case" steering bound assumes the checkpoint loop keeps ticking, which its own streaming mechanism doesn't guarantee
Checkpoints are token-driven ("commits an append-only delta chunk every 250–500 ms" while tokens flow). When the provider stream stalls or the turn sits inside a long tool effect, no checkpoint mutation runs, nothing reads the steering doc, and the abort waits unbounded by anything stated. Hazard #5 asks for the worst case with the fast path lost; the brief defines the case away instead of naming a timer-driven no-op checkpoint. The epoch CAS (stale attempt cannot commit) holds; the visible-halt number does not, as written.

### C7 — GCP §2 row 3 / §3: the 5-second revocation bound is conditioned on the health of the very path the hazard says to assume degraded
The backstop recheck runs in the same gateway that relays content: if its Postgres path fails while Redis stays healthy, content keeps flowing and the recheck silently stops. The brief never states the fail-closed rule (close sockets when a recheck cycle can't complete) that would make "at most 5 seconds" a real bound. One sentence fixes it; as written the bound is asserted, not mechanized.

### C8 — GCP §2 row 5 vs §3.2 vs §11: three descriptions of what transits Pub/Sub, and they don't agree
Constraint 5's queue is described as the outbox/Pub/Sub path; §3.2 calls it "repair, not the fast path"; §11 assumes "at most one sub-1-KiB repair message per loop." Under the narrowest reading the $0 Pub/Sub line holds but the actual queue for command-triggered jobs, connector bursts, and notifications is unnamed; under the broad reading the relay tier is a real fleet and the line isn't $0. The judge cannot tell which architecture is proposed.

### C9 — Convex §2 row 4 / §5: the 30-minute turn ceiling silently requires the kept agent harness to run in the restricted Convex runtime; the Node runtime cap is 10 minutes
Fetched: Convex-runtime actions 30 min; **Node.js runtime actions 10 min.** If any kept harness/Bind dependency forces `"use node"`, the ceiling drops to 10 minutes — equal to the ~10-minute long-turn requirement, zero headroom, probable fail. The brief nowhere states the compatibility assumption or a fallback, and the 10-week estimate assumes the port is "light edits."

### C10 — Cross-brief: three incompatible accounts of the EU deployment at cutover
The product today deploys twice (Global and EU) with live EU D1/R2. AWS §5: "assert EU is empty or stop." GCP §5: EU data "follows the same isolated procedure" — but GCP launches us-central1 only; unexecutable as written. Convex §5 imports "exported D1" (singular) and never mentions EU — dropping or relocating any EU rows. Judges should force one answer to "what is in EU D1 today" and re-read all three §5s against it.

## NOTE

### C11 — AWS: subscription-invalidation quota is 100/s and **non-adjustable**; bulk revocation (workspace offboarding, mass session kill) queues behind it with the per-minute epoch as the only backstop. Disclosed as a number in §7; unanalyzed as a scenario in §2.3/§8.

### C12 — Cross-brief: turn-abort ceilings line up 14.5 min (AWS) < 30 min (GCP, Convex) < unlimited (Supabase's retained CF Workflows). Only Convex presents its ceiling as a cost; Supabase doesn't claim its credit; AWS doesn't flag that its ceiling is half the next-worst. Score hazard #10 with this table in view.

### C13 — Convex §6: "distinct technologies to debug end-to-end: two" undercounts its own stack — a retained Cloudflare Worker (dictation), Fivetran + a warehouse (its stated SQL-analytics mitigation), and three vendor components it elsewhere calls "newer than the core." Feeds the 20-weight Simplicity criterion; the honest count is not two.

### C14 — Supabase §1: retaining Global D1 as the route store sits against the settled "moving off per-region D1" constraint; the frame's carve-out names Workflows, not D1. Arguably data-minimal by analogy; the brief doesn't argue it. Judge should rule rather than let it pass silently.

### C15 — GCP §5: "avoids a renderer rewrite" and deletes the Worker after two shim windows — but the dictation bridge lives in that Worker and no §5 line covers rebuilding it. Cloud Run *can* host a socket proxy, so this is unbudgeted scope, not missing capability.

---

# Part B — Cost audit

Audited 2026-08-16 against the demand model (3 updates/s, V=2, 176 observed
h/mo, 15-min loops, 40 steps/loop, 250k MAU at growth). Derived quantities:
checkpoints 38.016M (S≈20) / 570.24M (S=300) per month; fan-out
send+per-receiver 114.048M / 1.7107B; demand-derived loops 14,080 / 211,200;
immediate-mode pull reads 76.03M / 1.1405B.

## Per-brief reconciliation (summary)

**All eight headline totals rebuilt from each brief's own cited rates
reproduce within rounding — zero arithmetic errors.** 24 rates spot-checked:
20 verified live; UNVERIFIED-live: Cloud SQL E+ unit rates, Memorystore
rates, Identity Platform band rates (Google pricing pages truncate on fetch;
figures consistent with published tables).

- **AWS** $943 / $13,339 bounded-push (+$240 / +$2,810 immediate): no errors.
  High because of (i) Cognito at list ($3,600 = 27% of total; the
  bring-your-own-identity alternative is never priced though AppSync
  supports OIDC/Lambda authorizers), (ii) whole-loop-active Lambda billing
  (declared conservative), (iii) declared-not-benchmarked 26-ACU average,
  (iv) bounded-push headline with immediate as a delta.
- **GCP** $961 / $4,793 bounded (+strict-immediate $1,620 / $7,536): no
  errors; used P1's 100k loops (adjustment +$111 at demand's 211,200). The
  cheap fan-out is a real platform property (no per-message meter on
  Redis/Cloud Run) but rests on the brief's own 20%-probability Redis
  capacity risk and an unverified 10-instance Cloud Run sizing. Only brief
  to price HA×2 + cross-region DR (~$1.67k of its SQL line).
- **Convex** ~$675 / ~$10,195 as briefed: internally consistent; P2 viewer
  misread inflates its three dominant lines ~50% against itself. At demand's
  V=2: **≈$540 / ≈$8,400**. All Pro rates verified live. The brief's own A5
  uncertainty (whether every reactive re-run bills one call) is ±2× on the
  dominant line (stated worst case ≈$20k); 0.25 GB action-memory granularity
  unpublished.
- **Supabase** ~$1,300 / ~$7,100 immediate: no errors; all major rates
  verified. **The whole S=300 column is contingent on an unpriced negotiation
  (2,700 msg/s exceeds the published 2,500/s cap — declared).** Thinnest
  resilience posture in the field (single 4XL, no replica). The composite
  "Workers + D1 + Workflows $453" line reproduces within ~15% with a ~$45–60
  undecomposed residual.

## Normalized comparison (demand model's own assumptions; one region; monthly USD)

3 Hz, V=2 receivers, 176 h/mo, 211,200 loops at S=300 (14,080 at S≈20),
250k MAU where a vendor auth product is used, immediate revocation base case.

| Row | AWS | GCP | Convex | Supabase |
|---|---:|---:|---:|---:|
| Immediate, S≈20 | $1,183 | $1,627 | $540 | $1,300 |
| Immediate, S=300 | $16,149 | $7,647 | ≈$8,400 (±2× on A5) | $7,100 + UNKNOWN cap uplift |
| Bounded-staleness, S≈20 | $943 | $968 | $540 (stance-invariant) | ≈$1,275 UNVERIFIED |
| Bounded-staleness, S=300 | $13,339 | $4,904 | ≈$8,400 (stance-invariant) | ≈$6,700 UNVERIFIED (messages remain) |
| Memo: auth line inside S=300 | $3,600 Cognito | $965 IdP | $0 BYO JWT | $488 |
| Memo: DB posture priced | single serverless writer + PITR + DR snapshots | HA×2 + cross-region DR replica | bundled in meters | single 4XL, no replica |

Reading: three candidates cluster at ~$7.1–8.4k at S=300; **AWS is the $16k
outlier, and its gap decomposes almost entirely into removable choices**
(Cognito, immediate-pull delta, dedicated per-loop compute), not AppSync
itself (AppSync $4,562 ≈ Supabase messages $4,265 ≈ Convex corrected calls
$3,571). GCP's position depends on its two least-verified inputs.

## Swing factors (>25% movers)

1. **Revocation stance.** Bounded-staleness moves GCP −36% and AWS −17–20%;
   Supabase ~−6% (messages remain metered); Convex $0 by construction. A
   bounded base case favors GCP most; an immediate base case favors Convex
   and penalizes AWS most.
2. **Auth product at 250k MAU ($0–$3,600).** Largely an architecture choice,
   not platform fate — every platform can validate first-party JWTs; only
   Convex priced that. Equalizing collapses ~40% of AWS's gap to the field.
3. **Fan-out metering model.** Per-event meters land within 10% of each
   other (34–60% of totals) vs GCP's unmetered sockets (~$723) — a real
   ~$3.5–3.8k platform difference favoring GCP, contingent on its unverified
   Redis/instance sizing. Cadence is the shared lever: 3→1.5 Hz roughly
   halves this line for the three metered candidates; barely moves GCP.
4. **Executor billing model.** Dedicated-memory-per-active-loop (Convex
   $3,885–4,125 = 40% of total; AWS $1,340) vs step-priced/multiplexed (GCP
   $211 normalized; ≈$50 CF Workflows inside Supabase). Favors Supabase and
   GCP.
5. **Resilience posture + P1.** GCP alone prices HA+DR (~$1.67k = 22% of its
   normalized total); a matching Supabase replica adds ≈+$960 (+13%). P1 is
   2.1× on executor lines and cuts the other way. These two partially cancel.

## Coverage

Spread verdict: ~⅔ assumption divergence (revocation stance, auth product,
P2 misread, P1 loops, HA/DR posture), ~⅓ genuine platform difference
(fan-out metering; executor billing). Load-bearing non-rate assumptions
flagged UNVERIFIED: Aurora 26-ACU average, GCP 10 Cloud Run instances and
Redis msg/s ceiling, Convex A5 (±2×) and A7, Supabase >2,500 msg/s uplift.
