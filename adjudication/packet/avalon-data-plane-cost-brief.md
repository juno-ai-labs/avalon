# Avalon data-plane cost brief — workload, drivers, and candidate interrogation

Purpose: a provider-neutral packet for evaluating any cloud/DB/realtime stack as
Avalon's product data plane, so competing proposals can be priced against the
same demand. Compiled 2026-08-16 from the Supabase PRD review
(`docs/PRDs/2026-08-15_supabase-workspace-workstream-conversations/review.md`),
its cost companion (`comparison.md`), and vendor pricing verified against
official Supabase and Cloudflare pages on 2026-08-16. Sections 1–3 are
demand-side facts and stated assumptions — reuse them verbatim for every
candidate. Sections 4–7 are what to price and what to ask.

## 1. Product invariants that create the load

- A **work stream** is a multiplayer transcript: several humans plus an AI agent,
  watched live. Token streaming is a core UX, not a nicety (time-to-first-token
  target 1–5 s; text should feel continuous).
- One mutation fans out to many views: the message itself, a per-work-stream
  "card" every member's sidebar shows, and per-person overlays (unread, mentions,
  needs-input). These must be atomic or convergent-with-repair.
- Agent loops run 2–30 minutes typically, 2+ hours at the tail — they outlive any
  request-scoped compute and must survive deploys/crashes (durable execution).
- Strict multi-tenancy (per-row authorization), two pinned regions (Global, EU),
  EU fails closed rather than over.
- Ordering: one total order per work stream; clients recover from disconnects via
  monotonic cursors over a durable event log. Live delivery may be lossy;
  durable truth may not.
- **The authorization stance that drives everything:** if a user is removed
  mid-stream, how fast must generated text stop reaching their already-open
  connection? The current Supabase proposal answers "immediately" and therefore
  pushes *no content* over sockets — only tiny invalidation hints — with every
  content read passing a live per-row authorization check. That one decision
  creates most of the cost profile below. A candidate that offers push-with-
  fast-revocation (or the org accepts bounded staleness for stream text) has a
  categorically cheaper shape.

## 2. Demand model at three scale points

Unit: **S = concurrently observed streaming work streams** (agent actively
generating, at least one human watching). Stated assumptions (challenge them):
3 visible updates/sec per observed stream (250–500 ms checkpoint cadence);
V = 2 average viewers per observed stream; observed ~176 h/month (business
hours); average agent loop 15 min; average mid-stream text buffer 30 KB;
sidebar fan-out excluded from per-stream math and listed separately.

| Demand metric (per region) | S = 50 | S = 300 | S = 2,000 |
| --- | ---: | ---: | ---: |
| Live fan-out, counted send + per-receiver: `3 × (1+V) × S` | ~450 msg/s | ~2,700 msg/s | ~18,000 msg/s |
| Monthly fan-out volume (176 h/mo) | ~285 M msgs | ~1.7 B msgs | ~11.4 B msgs |
| Durable streaming checkpoints (2–4 Hz × S) | 100–200 writes/s | 600–1,200 writes/s | 4,000–8,000 writes/s |
| WAL/write volume if each checkpoint rewrites the full buffer (30 KB avg) | 3–6 MB/s | 18–36 MB/s | 120–240 MB/s |
| Pull-based text fetches, if content can't ride sockets (3 QPS × viewers) | ~300 QPS | ~1,800 QPS | ~12,000 QPS |

Additional load, all scale points: command transactions (message append =
one atomic multi-row write: part + card + N overlays + 2 event-log rows + queue
enqueue); agent step commits (2 DB round trips per model/tool action); connector
webhook bursts; FTS + vector search with per-row authorization; blob storage for
attachments/large payloads.

**Sidebar fan-out** (separate axis): every commit in a workspace notifies every
online member — demand ≈ commits/s × online members, per workspace. A workspace
with 500 people online and 2 commits/s is 1,000 msg/s on its own. Scales with
customer size, not with S.

Background (unobserved) runs: checkpoints drop to ~1 Hz and need no live
fan-out — thousands of background runs are a write problem, not a fan-out
problem.

## 3. Two write-amplification hazards to price into any design

1. **Whole-buffer rewrite (O(n²)).** If streaming durability is "re-save the
   accumulated text every tick," a 100 KB output written at 2–4 Hz for minutes
   re-writes the whole buffer hundreds of times (log-structured storage/WAL
   carries all of it; replicas and PITR carry it again). Fix: append-only delta
   chunks compacted at seal. Ask every candidate what a growing-document update
   costs in their storage engine.
2. **Per-receiver message metering.** If the realtime layer bills send + each
   delivery (Supabase does), fan-out cost = frequency × receivers, and a
   per-stream cap must be derived from a *project-wide* throughput quota.

## 4. Cost drivers, ranked by observed impact

1. **Live fan-out pricing model** — per-message × receivers vs. free/flat
   sockets. Dominant at every scale point above S≈50.
2. **Streaming durability writes** — hazard 1 above; determines DB compute tier
   and replication/backup bandwidth.
3. **Read amplification** — if the revocation stance forces pull-per-frame,
   every viewer is 2–4 authorized queries/sec against the primary.
4. **Vertical ceiling vs. horizontal scaling** — a single-primary relational
   design tops out at one big box (Supabase: 16XL, 64 vCPU/256 GB,
   ~$3,730/mo/region) with no shard path inside the design; per-entity actor
   designs scale horizontally by construction but push projection/consistency
   work into application code.
5. **Always-on floors** — per-region × per-environment fixed compute (prod,
   staging, branches) vs. scale-to-zero serverless.
6. **Durable execution** — per-step pricing for 100 k+ loops × ~40 steps/mo;
   whether a 2-hour loop needs an external orchestrator at all.
7. **Egress** — per-GB (Supabase $0.09 uncached) vs. free (Cloudflare R2).
8. **Auth MAU pricing** — sleeper line item ($0.00325/MAU past 100 k on
   Supabase ⇒ ~$488/mo at 250 k MAU).
9. **Fixed add-ons** — PITR (~$100–400/mo/region), log drains (~$60/drain),
   compliance-tier uplifts ($599/mo Team on Supabase buys SOC2/support, not
   capacity).

## 5. Baselines already priced (the two incumbent proposals)

**A. Cloudflare Durable Object hierarchy** (one actor per workspace + per work
stream; SQLite-in-DO storage; Workflows for loops). Illustrative subtotal at the
comparison doc's growth workload (250 k MAU, 1 M stored streams, 100 k loops/mo):
**~$412/mo total** across both regions. Why it's cheap: outgoing WebSocket
frames are unbilled, hibernating idle objects cost nothing, no per-region
compute floor, R2 egress free. Its costs are elsewhere: engineering (child→
parent projection delivery + repair, a fleet migration control plane, weaker
ad-hoc SQL/inspection) and per-active-object duration billing if sockets/calls
prevent hibernation.

**B. Supabase hybrid** (regional Postgres authority + Realtime hints + CF
Workflow driver). Same workload: **~$1,730/mo** as published — but its Realtime
input (50 M msgs/mo) is ~8× understated against its own 100 k loops/mo
assumption; corrected ≈ **$2,600/mo**, before enterprise uplift. At the scale
points in §2 (per region, my assumptions): S=50 ≈ **$1.5–2 k/mo**; S=300 ≈
**$6–8 k/mo** + negotiated rate-limit uplift; S=2,000 ≈ **$35 k+/mo** and the
single primary (not money) becomes the binding constraint. Supabase-specific
facts: 2,500 msg/s project-wide default at Team/Pro-uncapped, raisable only by
unpublished negotiation ("all limits are configurable per project — contact
support"); messages $2.50/M counted send + per receiver; connections cheap
($10/1,000); Realtime server is Apache-2.0 self-hostable if you'll operate the
fan-out cluster yourself.

## 6. Hard constraints — disqualifiers before price

A candidate must credibly provide all of the following, or it's out regardless
of cost:

1. Per-work-stream total ordering (serialized writes: actor, row lock, or
   equivalent) with multi-row atomicity or a convergent repair story for the
   sidebar projections.
2. Durable, monotonic event cursors for client catch-up after disconnect —
   realtime delivery is never the source of truth.
3. A stated revocation semantic for live channels (push-with-revocation bound,
   or feasible pull-with-live-check at the QPS in §2).
4. Durable execution for 2 h+ agent loops surviving deploys (native primitive
   or a credible build), with bounded per-action limits ≥ a long streaming
   model turn (~10 min) — this is where Supabase Edge Functions (400 s wall)
   failed for EU.
5. At-least-once job queue, ideally enqueue-atomic with the state mutation.
6. Two-region topology with pinned residency, EU fail-closed, and contractual
   (not just region-selector) processing guarantees.
7. Per-row multi-tenant authorization enforceable server-side; FTS + vector
   search filterable by the same authorization.
8. Blob storage with an honest backup/DR story (is it inside DB backups?).
9. Migration path from today's per-region SQLite (D1) + R2 with a single-writer
   cutover.

## 7. Interrogation list — ask every candidate provider/agent

Pricing model:
1. How is realtime fan-out priced and metered — per message sent, per delivery,
   per connection-minute, or flat? What does 3 updates/s to 3 parties, 176 h/mo,
   cost at S = 50 / 300 / 2,000?
2. What is the published throughput ceiling (msg/s, project- or channel-scoped),
   and what is the *published* path past it? Distinguish billing meters from
   rate limits.
3. What does a growing 100 KB document updated 3×/s cost in write amplification
   (WAL/LSM/replication/backup bandwidth)? Is there a native append/delta shape?
4. Where does vertical scaling end, and what is the horizontal story *within
   one region* without breaking constraint 6.1?
5. What are the always-on floors: per region, per environment, per tenant?
6. Durable execution: native primitive? Per-step/per-transition price at 100 k
   loops × 40 steps/mo? Max single-action duration? Survives your deploys?
7. Egress per GB, and what's exempt.
8. Auth: per-MAU price at 250 k–1 M MAU, and can we bring our own identity
   without per-MAU tax?
9. Live-channel revocation: when access is revoked, what is the guaranteed
   bound on an already-connected client receiving further content? (Cite docs,
   not vibes — this decides push vs. pull and therefore half the cost model.)
10. Residency: which subprocessors/regions touch data and logs; what's
    contractually committable for EU; does any control plane leak content?
11. Backup/PITR scope (do blobs ride along?), restore drill cost, and the price
    of 7/14/28-day retention per region.
12. What breaks first in this design at S = 2,000, and what does the fix cost —
    money, or architecture?

## 8. Assumptions register (challenge these first)

Mine, not vendor facts: 3 hints/s per observed stream (from the PRD's 250–500 ms
cadence); V = 2 average viewers; 176 observed h/mo; 30 KB average mid-stream
buffer; 15-min average loop; ~40 driver steps/loop; the comparison doc's growth
workload (250 k MAU, 1 M streams, 100 k loops/mo, 5 k peak connections).
Known unknowns: whether Supabase's msg/s *rate limit* counts deliveries or only
sends (billing counts both; the limits page doesn't say — plan pessimistically);
enterprise pricing on every platform; observation rate (what fraction of runs
are watched, by how many); real buffer-size distribution. Sensitivity: fan-out
cost scales linearly in each of cadence, viewers, and observed hours — halving
the cadence halves the dominant line at every scale point.
