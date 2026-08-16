# Supabase: regional Postgres authority with Realtime and Cloudflare Workflows

## 1. The stack, named exactly (≤150 words)

The client-facing API remains Avalon's **Hono API on Cloudflare Workers** ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)); it authenticates **WorkOS AuthKit** ([pricing](https://workos.com/pricing)), rate-limits principals ([binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)), and calls narrow SQL RPCs. Global **Cloudflare D1** ([pricing](https://developers.cloudflare.com/d1/platform/pricing/)) stores only opaque workspace routes. Each product region is one **Supabase Team project** ([pricing](https://supabase.com/pricing)): **Postgres** owns workspace membership, streams, messages/events, credential ciphertext, jobs, audit, and vector metadata; **Realtime Broadcast** carries lossy hints; **Queues (pgmq)** and **Cron** run logged work/repairs; [FTS](https://www.postgresql.org/docs/current/textsearch.html) plus **pgvector** serves search. WorkOS owns identity, not product roles. One **Cloudflare Workflow** drives each agent run ([pricing](https://developers.cloudflare.com/workflows/reference/pricing/)); it holds IDs/revisions, never content. Regional **Cloudflare R2 Standard** stores immutable files and locked backup copies ([pricing](https://developers.cloudflare.com/r2/pricing/)). The regional Worker holds the credential KEK. Edge Functions are not in the long-loop path.

## 2. Hard constraints (table, one row each)

| # | Constraint | Mechanism |
|---:|---|---|
| 1 | Ordering + atomicity | A SQL command locks one `workstream_heads` row with `SELECT … FOR UPDATE`, allocates the next cursor, and commits message/delta, card, overlays, event, receipt, and queue insert together. Row locks block competing writers until transaction end ([Postgres](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)). Rare workspace-wide campaigns use transaction-scoped advisory locks. |
| 2 | Durable cursors | The locked head, not a free-running sequence, allocates cursors; therefore a lower cursor cannot commit late. Monthly event partitions exist from day one; a retained-floor cursor makes an old client resnapshot. No Realtime replay is authoritative. |
| 3 | Revocation | Launch uses **immediate revocation**: Broadcast contains coordinates only; Hono rechecks live regional membership/RLS for every delta read. Realtime authorization is cached for a connection, so it cannot safely carry bodies under this stance ([authorization](https://supabase.com/docs/guides/realtime/authorization#updating-rls-policies)). |
| 4 | 2 h+ execution | Cloudflare Workflows owns the loop; paid steps have unlimited wall time, 10,000 steps by default, 1 MiB non-stream results, and 1 GB instance state ([limits](https://developers.cloudflare.com/workflows/reference/limits/)). Plan against 10,000 active instances because that page's 50,000 table and 10,000 explanatory text conflict. |
| 5 | At-least-once queue | Logged Supabase Basic Queues are Postgres-native and persist until removed; delivery is exactly once only within the visibility window, so Avalon receipts make end-to-end handling at-least-once/idempotent ([Queues](https://supabase.com/docs/guides/queues)). Enqueue shares the command transaction. |
| 6 | Residency | Launch is Global-only. EU means a separate specific-region Supabase project—each project has one primary region—and EU-jurisdiction R2; region choice is not itself compliance ([Supabase regions](https://supabase.com/docs/guides/platform/regions), [R2 jurisdictions](https://developers.cloudflare.com/r2/reference/data-location/)). EU fails closed until DPAs and Workflow processing/locality are contractually approved. **UNKNOWN — executed vendor agreements must resolve this.** |
| 7 | Tenant authorization + search | Every tenant table carries `workspace_id`; exposed reads use indexed RLS and security-invoker views. Supabase warns service keys bypass RLS, so user traffic preserves the WorkOS JWT and background functions accept explicit tenant IDs ([RLS](https://supabase.com/docs/guides/database/postgres/row-level-security#bypassing-row-level-security)). FTS/pgvector queries build the authorized candidate set before ranking; pgvector supports HNSW ([indexes](https://supabase.com/docs/guides/ai/vector-indexes)). |
| 8 | Blobs + DR | Postgres owns hashes/manifests; existing R2 keeps bytes. Each immutable write is copied to a separately credentialed backup bucket with a retention lock, which prevents overwrite/deletion ([bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)); reconciliation compares manifests. This is Avalon-built backup, not a claim that DB PITR covers blobs. |
| 9 | Migration | At near-zero users: stop writes, export D1 in cursor order, bulk-load/validate Postgres, retain R2 keys, switch the route epoch once, and reopen. The source never reopens at that epoch; late callbacks carry the old epoch and are rejected. |

Sparse state is explicit: no overlay row means `last_seen_cursor = membership_join_cursor - 1`; Unread is an indexed visible-card scan with a left join to `(user_id, workstream_id)` state and `COALESCE`. `run_control.revision` is the sole steering CAS. Scheduled due state lives in Postgres `schedules`, not Cron memory. At seal, Postgres writes one immutable final message and marks its deltas for bounded cleanup; WAL carries each delta once, not an accumulating buffer.

## 3. UX proxies (the seven, one short paragraph each)

**1 — Streaming cadence.** Append-only deltas commit at 3 Hz; a hint then triggers one authorized delta fetch, so the floor is about 333 ms plus regional RTT. Billing counts one send plus each receiver ([meter](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages#what-you-are-charged-for)); at S=20/V=2 this is 180 messages/s and 120 reads/s, while S=300 is 2,700 and 1,800. Team's project-wide limit is 2,500 messages/s and excess can disconnect clients ([limits](https://supabase.com/docs/guides/realtime/limits)); fallback is jittered 1 Hz cursor polling, so visible cadence degrades to roughly 1–2 s, not missing history. Immediate revocation causes the reads. Bounded-staleness push removes them but not message metering.

**2 — Time-to-first-token.** Admission is one SQL round trip, followed by deterministic Workflow creation; a 5 s queue repair catches a lost post-commit dispatch. Launch gate: p95 admission-to-first-byte ≤3 s, p99 ≤5 s. **UNKNOWN — Cloudflare publishes creation-rate limits, not dispatch latency; the production-region bake-off resolves it.** Workflow continuation overhead is paid once per model/tool boundary, not per token.

**3 — Interaction latency and coherence.** Hono acknowledges only after the transaction that writes transcript, sidebar card/overlay, cursor, receipt, and queue entry. Its response applies both UI caches together. A swallowed `realtime.send` failure cannot roll back the command—Supabase documents that it captures errors ([concepts](https://supabase.com/docs/guides/realtime/concepts))—so both surfaces may remain jointly stale until the 1 s cursor poll, but canonical sidebar and transcript cannot disagree. Each hint also inserts a `realtime.messages` row, cleaned after three days, so its WAL/primary load is budgeted ([Broadcast](https://supabase.com/docs/guides/realtime/broadcast#broadcast-from-the-database)).

**4 — Visible consistency artifacts.** The cursor allocator is the work-stream row lock; retry epochs reject stale deltas and completion. Reconnect fetches events after cursor and composes the active prefix from ordered delta rows. A cursor below retention receives one resnapshot, not guessed gaps. A crashed attempt's provisional text is marked abandoned and replaced only for that attempt; sealed text is never retracted.

**5 — Steering responsiveness.** The steering transaction increments only `run_control.revision`. During generation the Workflow must poll that row every 2 s and abort/suppress the stale epoch; Realtime control is optional acceleration. Thus lost notification still halts visible generation within 3 s; an external effect already started may finish, but its stale result cannot commit. Revocation stance does not change this bound.

**6 — Reconnect/wake.** Subscribe, buffer hints, fetch snapshot plus server-attested cursor, discard older hints, then apply newer deltas. A mid-stream join reads the full durable prefix. Target is ≤1 s for a normal retained gap; **UNKNOWN — payload distribution and regional load test establish p95.**

**7 — Behavior at the limit.** Clients honor server backoff and move to bounded polling when Realtime returns limit errors; durable SQL remains the recovery path. At S≈300 the published Realtime ceiling is already exceeded, so that scale requires a negotiated project limit or reduced cadence; there is no silent promise of capacity ([limits](https://supabase.com/docs/guides/realtime/limits)).

## 4. Cost (two numbers + a table)

**S≈20: approximately $1,300/month. S=300: approximately $7,100/month plus UNKNOWN negotiated Realtime-limit uplift, provisioned IOPS, and enterprise terms.**

| Monthly line | S≈20 | S=300 | List-price basis |
|---|---:|---:|---|
| Supabase Team | $599 | $599 | $599/mo ([pricing](https://supabase.com/pricing)) |
| Primary compute | $210 XL | $960 4XL | Published compute sizes ([pricing](https://supabase.com/pricing#compute)) |
| Persistent staging branch | $10 | $10 | $0.01344/hour ([pricing](https://supabase.com/pricing)) |
| 7-day PITR | $100 | $100 | ~$100/project ([backups](https://supabase.com/docs/guides/platform/backups#pricing)) |
| One Log Drain | $60 | $60 | $60/drain plus usage ([pricing](https://supabase.com/pricing)) |
| Realtime messages | $275 | $4,265 | 114.0M/1.711B less 5M, rounded to 1M packages at $2.50 ([meter](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages)) |
| Peak connections | $0 | $50 | 500 included, then $10/1,000 ([pricing](https://supabase.com/docs/guides/realtime/pricing)) |
| Database disk | $12 | $62 | 8 GB included, then $0.125/GB ([pricing](https://supabase.com/pricing)) |
| WorkOS + Supabase third-party MAU | $0 | $488 | WorkOS first 1M free; Supabase $0.00325 above plan quota ([WorkOS](https://workos.com/pricing), [Supabase](https://supabase.com/docs/guides/auth/third-party/overview#pricing)) |
| Workers + D1 + Workflows | $28 | $453 | Worker request/CPU, D1, and Workflow rates; D1 stays inside allowance ([Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Workflows](https://developers.cloudflare.com/workflows/reference/pricing/)) |
| R2 primary + backup | $8 | $50 | $0.015/GB-mo + operations, egress free ([pricing](https://developers.cloudflare.com/r2/pricing/)) |
| Supabase egress | included | $20 | 250 GB included, then $0.09/GB ([pricing](https://supabase.com/pricing)) |

Queues/Cron/vector use primary compute; no Edge Function line. Model, embedding, connector, and Daytona spend is substrate-common and excluded.

## 5. Migration plan (≤400 words + a week count)

**Estimate: 8–10 product-weeks.**

Keep the Electron REST contract, Hono routes/services, Bind harness, provider adapters, Cloudflare Workflow driver, R2 objects, and regional routing shape. Replace `packages/db` D1 repositories and roughly 460 hand-written tenancy predicates with Postgres migrations, RLS, and narrow transactional functions; replace WorkstreamRoom delivery with one regional Supabase Realtime client; replace workspace alarms/Cloudflare Queue jobs with Postgres due rows/pgmq plus wake/repair; move sign-in to documented WorkOS→Supabase third-party JWTs ([integration](https://supabase.com/docs/guides/auth/third-party/workos)). Hono remains the only command/read surface and principal rate limiter; clients do not gain arbitrary PostgREST writes.

At near-zero users, do not build dual-write machinery: rehearse D1 export→Postgres load, validate counts/hashes/cursors/RLS, hold writes, run the final import, switch the immutable route epoch, and retain D1 read-only through rollback expiry. R2 keys do not move. Cut over internal workspaces first, then production.

Estimate assumes three backend and one desktop engineer, existing API contract tests, and no EU launch. Weeks 1–2 provision/auth/schema; 3–5 repository/RPC conversion; 6 realtime/queues; 7 import and failure injection; 8–10 hardening/contingency. This concedes a backend re-platform, not a database URL change. Conversation-model changes ship independently and are not substrate credit. The older PRD is source material, not an implementation schema; its state/retry/effect-key/topic/compaction/scheduling defects require a fresh design/ADR and formal supersession chain before coding.

## 6. Operations at team-size-small (≤200 words)

Pages: regional Postgres saturation/locks/WAL, Realtime disconnects/quota, pgmq oldest age, Workflow failure/queued age, R2 manifest mismatch, and route/auth failures. An engineer needs five operational concepts: Hono/Workers, Postgres/Supabase, Realtime, Workflows, and R2; WorkOS is usually only the authentication edge.

The payoff is inspection: one regional SQL session can join workspace, work stream, cursor, deltas, sidebar, queue, run/control, effect receipts, schedules, audit, and vector provenance; `pg_locks` exposes blocking ([Postgres](https://www.postgresql.org/docs/current/explicit-locking.html)). Realtime/Workflow remain disposable accelerators around that truth.

Supabase takes daily backups and offers PITR, but restore makes the project inaccessible and does not restore object bytes ([backups](https://supabase.com/docs/guides/platform/backups)). Quarterly drills restore Postgres to an isolated project, reconcile nonterminal effects/queues, restore an R2 manifest from the locked copy, rebuild vectors, and replay synthetic auth/realtime checks. Regional restore RTO is **UNKNOWN — measured drill plus vendor restore time resolves it.**

## 7. Infrastructure as code & deployment (≤250 words + coverage table)

| Component | Code-managed by | Dashboard/support residue |
|---|---|---|
| Supabase project/branch/settings | `supabase/supabase` Terraform provider | Provider is [public alpha](https://supabase.com/features/terraform-provider) and exposes only project, branch, settings ([reference](https://supabase.com/docs/guides/deployment/terraform/reference)); plan, compute resize/PITR and some auth integration settings remain dashboard/API. |
| Postgres, RLS, Realtime policies, pgmq/pg_cron/pgvector | Supabase CLI + checked-in SQL migrations | No production SQL-editor changes; Supabase requires remote changes through migrations ([docs](https://supabase.com/docs/guides/deployment/database-migrations)). |
| Hono Worker, Workflow, D1 route, R2 | Wrangler config + Cloudflare Terraform provider | Secret values use CI `wrangler secret put`; Workflow limit increases use a request form ([limits](https://developers.cloudflare.com/workflows/reference/limits/)). |
| WorkOS AuthKit | WorkOS CLI where covered | Production activation, JWT template, Supabase third-party integration are dashboard-managed ([Supabase setup](https://supabase.com/docs/guides/auth/third-party/workos)). |

Prod and a data-less persistent staging branch receive identical migrations; ephemeral branches use synthetic data. Always-on staging is ~$10/mo; WorkOS staging is free ([branches](https://supabase.com/docs/guides/deployment/branching), [WorkOS](https://workos.com/docs/authkit/environments)).

Deploy expand→compatible code→backfill→flip→later contract. Version SQL functions and Workflow RPCs; keep the old version until all bound runs drain. For a relaxed enum, readers widen before the constraint/writer. This closes the old-code/new-schema write window. App rollback is immediate while schema is additive; schema rollback is a forward repair. Terraform plan, `supabase migration list/db diff`, and Wrangler dry runs detect drift. Compute resize is dashboard-driven and usually incurs under two minutes downtime ([compute](https://supabase.com/docs/guides/platform/compute-and-disk#compute-upgrades)). **UNKNOWN — CI rehearsal establishes end-to-end deploy time.**

## 8. Top three risks (one paragraph each)

**Shared-primary and Realtime ceiling (35% chance of material S=300 work).** Immediate revocation creates 1,800 authorized reads/s at S=300 while streaming adds 600–1,200 writes/s. The published 2,500 msg/s project limit is crossed, and the only published increase path is support with no rate card ([limits](https://supabase.com/docs/guides/realtime/limits)). Blast radius is one region. Mitigation: benchmark 4XL/IOPS, cap cadence, shed to polling, and contract the quota before S reaches 150.

**EU approval/identity operations (25% chance EU needs a different driver).** WorkOS is a documented Supabase provider, but key changes can take up to 30 minutes to propagate ([third-party auth](https://supabase.com/docs/guides/auth/third-party/overview#limitations)); Cloudflare Workflow processing locality is not established here. EU remains unavailable rather than running a 400-second Edge fallback: Edge Functions cannot safely host a long model turn ([limits](https://supabase.com/docs/guides/functions/limits)). Blast radius is EU launch; mitigation is executed agreements or a separately evaluated EU durable driver.

**Implementation/IaC incompleteness (40% chance of schedule overrun).** The source PRD's contradictory capacity state, retry uniqueness, effect key, topic enumeration, compaction key, schedule ownership, schema nits, and companion numbering are conceded—not reasserted. The Terraform provider is alpha and Auth/JWT setup has dashboard residue. Blast radius is migration time and drift, not runtime correctness if the design, failure suite, and drift checks remain launch gates.

## 9. What breaks first (≤150 words)

Realtime binds first: `3 × (1+2) × S` reaches the published 2,500 msg/s ceiling at S≈278, so S=300 already needs support negotiation, reduced cadence, or the 1 Hz polling fallback. That is configuration/money only if Supabase grants the limit; **UNKNOWN — no published self-service tier or uplift price exists.**

Next is the shared primary: immediate revocation drives 1,800 RLS reads/s plus 600–1,200 delta writes/s at S=300. The fix is query/index/cadence work and vertical compute through 16XL (64 vCPU/256 GB, $3,730/mo); beyond that is contact-sales or regional sharding ([pricing](https://supabase.com/pricing#compute)). A single extremely hot stream can also serialize on its head row; that is an architectural boundary, accepted because launch cadence is only 3 locks/s per active stream.

## 10. Tripwires (3–5 bullets)

- Realtime exceeds 60% of 2,500 msg/s for 15 minutes, or limit disconnects exceed 0.1% of connections/day.
- Work-stream head-lock p95 exceeds 25 ms or command p95 exceeds 250 ms for a week.
- Authorized delta-fetch p95 exceeds 150 ms, or primary CPU exceeds 60% for 15 minutes at normal load.
- Any region cannot pass quarterly Postgres+R2 restore or has measured RPO above 5 minutes.
- A customer requires EU before Workflow locality/processing and WorkOS/Supabase contracts are approved.

## 11. Assumptions register

- Demand is exactly 3 updates/s, V=2, 176 observed hours/month, 15-minute average loops, and 40 Workflow steps/loop. S=20 therefore means 14,080 observed loops/month; S=300 means 211,200.
- S=20 means 10,000 MAU/300 peak connections/100 GB database/100 GB R2 primary plus backup; S=300 means 250,000 MAU/5,000 connections/500 GB database/1 TB R2 primary plus backup.
- Realtime hints average 200 bytes; S=300 Supabase egress overage is rounded to $20. R2 operation estimates are $5/$20 inside the combined rows. Worker CPU averages 2 ms per authorized pull.
- XL at S=20 and 4XL at S=300 are safety selections, not measured requirements. Provisioned IOPS/throughput and negotiated Realtime/enterprise charges are excluded as UNKNOWN.
- UX budgets (3 Hz, 1 Hz fallback, 2 s steering poll, 3 s stop, 3/5 s dispatch percentiles, ≤1 s reconnect), alert thresholds, 5 s repair interval, quarterly drills, 5-minute RPO, and the 8–10 week/four-engineer migration are Avalon targets to validate, not vendor SLAs.
- Event partitions are monthly; retention duration is a later policy. A client below the stored retention floor resnapshots.
- Immediate revocation is priced. Bounded-staleness ≤60 s would push bodies and remove pull-read/Worker costs only after an integration test proves JWT expiry/disconnect bounds; Realtime message cost is unchanged. **UNKNOWN — that test resolves feasibility.**
