# Convex — advocate brief

## 1. The stack, named exactly

One product replaces six services. **Convex Professional**, $25/developer/mo plus usage
([pricing](https://www.convex.dev/pricing)):

- **Database**: Convex document store with serializable transactions
  ([OCC docs](https://docs.convex.dev/database/advanced/occ)).
- **Realtime fan-out**: reactive query subscriptions over the Convex client
  WebSocket ([realtime](https://docs.convex.dev/realtime)) — not a separate service.
- **Job queue**: transactional [scheduled
  functions](https://docs.convex.dev/scheduling/scheduled-functions) +
  [Workpool component](https://www.convex.dev/components/workpool).
- **Loop driver**: [Workflow component](https://www.convex.dev/components/workflow)
  (durable execution, native — no external orchestrator).
- **Blob storage**: [Convex file storage](https://docs.convex.dev/file-storage).
- **Search/vector**: native [text search](https://docs.convex.dev/search/text-search)
  and [vector search](https://docs.convex.dev/search/vector-search).
- **Auth**: Avalon's existing Google OAuth flow minting our own JWTs, validated via
  [Custom JWT provider](https://docs.convex.dev/auth/advanced/custom-jwt) — no
  auth vendor, no MAU meter.
- **API tier**: Convex queries/mutations/actions replace the Hono REST surface;
  [HTTP actions](https://docs.convex.dev/functions/http-actions) take webhooks.
  **We keep one vestigial Cloudflare Worker** for the Azure dictation WebSocket
  proxy (Convex terminates its own client sockets but does not proxy arbitrary
  ones) — "we build it" honesty: it already exists and stays.

## 2. Hard constraints

| # | Constraint | Mechanism | Citation |
|---|---|---|---|
| 1 | Per-stream total order + multi-row atomicity | Mutations are fully serializable transactions with automatic conflict retry; one mutation writes message + sidebar card + N overlays + activity-log row and schedules the agent turn, atomically. Per-stream `seq` is allocated by read-modify-write on the work-stream doc; OCC serializes contenders, so order = commit order. No repair machinery exists because nothing can diverge. | [OCC](https://docs.convex.dev/database/advanced/occ) |
| 2 | Durable monotonic cursors | `seq`/`logSequence` counters allocated inside the writing transaction; a later-committing mutation cannot hold a lower number (both write the counter doc, so OCC forces serial order). Client catch-up does not consume cursors at all: a re-subscribed query returns a consistent snapshot recomputed server-side, so lossy delivery cannot lose truth. | [OCC](https://docs.convex.dev/database/advanced/occ), [queries](https://docs.convex.dev/functions/query-functions) |
| 3 | Revocation semantic for live channels | Push-with-revocation, native: every delivered frame is the output of a fresh server-side execution of the authorization code at a post-commit snapshot (§3.5 below). No join-time grant is cached for the connection's life. | [realtime](https://docs.convex.dev/realtime), [queries](https://docs.convex.dev/functions/query-functions) |
| 4 | Durable execution ≥2 h, per-action ≥10 min | Workflow component: steps persist to the database, "can run for months, and survive server restarts", per-step retry policies. A single streaming model turn runs in one Convex-runtime action: 30-minute cap ≥ the 10-minute requirement. Turns >30 min abort and retry — see §9. | [workflow](https://www.convex.dev/components/workflow), [limits](https://docs.convex.dev/production/state/limits) |
| 5 | At-least-once queue, enqueue-atomic | `ctx.scheduler` from a mutation is transactional: "if the mutation succeeds, the scheduled function is guaranteed to be scheduled." Scheduled mutations are exactly-once; actions are at-most-once and the Workflow/Workpool retry layer makes the composite at-least-once with our idempotency keys. | [scheduling](https://docs.convex.dev/scheduling/scheduled-functions) |
| 6 | Two regions, pinned, EU fail-closed | US East (N. Virginia) + EU West (Ireland, launched 2026-02); "all infrastructure powering your deployment will be hosted in the selected region"; a deployment's region is immutable. Two separate deployments = fail-closed by construction. Contractual processing commitments: UNKNOWN — resolved by DPA/subprocessor review before EU build (§8). | [regions](https://docs.convex.dev/production/regions), [EU launch](https://news.convex.dev/we-finally-got-our-eu-visa/) |
| 7 | Per-row multi-tenant authz; FTS+vector under same authz | Clients can only invoke exported functions — the function layer *is* the app tier, so every read path (including search) runs the same visibility code before returning rows. Vector search runs in actions with `filterFields` + post-filter through the identical check. | [text search](https://docs.convex.dev/search/text-search), [vector search](https://docs.convex.dev/search/vector-search) |
| 8 | Blob storage with honest backup story | Convex file storage; backups are "a consistent snapshot of your table data" and **optionally include file storage** — blobs can ride along, unlike today's R2. | [file storage](https://docs.convex.dev/file-storage), [backups](https://docs.convex.dev/database/backup-restore) |
| 9 | Migration from D1/R2 | `npx convex import` from exported D1 rows; R2 objects re-uploaded to file storage; single-writer cutover at ~zero users (§5). | [CLI](https://docs.convex.dev/cli) |

## 3. UX proxies

Numbers assume the **immediate-revocation stance**. The bounded-staleness
stance's delta is **$0 and zero design change** — both stances ride the same
mechanism, because content on the socket is already authorization-checked per
frame. This is the one candidate where the open product decision costs nothing
either way.

**1. Streaming cadence.** The turn action buffers model tokens and commits an
append-only delta chunk every 250–500 ms (2–4 Hz, our choice — the same shape as
the vendor's [persistent text
streaming](https://www.convex.dev/components/persistent-text-streaming)
component, which "queues chunks in memory and persists them efficiently").
Each commit re-runs viewers' subscribed tail queries and pushes results. Floor:
one mutation commit + push propagation per tick; no documented latency SLA
(UNKNOWN — measure in pilot; sub-second is the working assumption, §11).
Degradation: cadence is fixed by us, not load; growing S grows spend linearly
(§4) and eventually queues function executions at the deployment concurrency
class — slowdown, not drops ([limits](https://docs.convex.dev/production/state/limits)).

**2. Time-to-first-token.** Send → one mutation (message + projections, ~1 commit)
which transactionally schedules the turn action (`runAfter(0)`); the action opens
the OpenRouter stream; first checkpoint lands one tick later. Driver overhead is
two hops (commit → scheduler → action start) with no per-frame polling; scheduler
dispatch latency has no documented bound (assumption: sub-second, §11). Total
admission → first visible byte ≈ model TTFT + ~0.5–1.5 s, inside the 1–5 s target.

**3. Interaction latency & coherence.** Send → visibly committed = one round trip:
the mutation is the atomic multi-row write, and the client's own optimistic
update renders immediately. The sidebar can *never* disagree with the
transcript: card and message are written in one serializable transaction, and
all client subscriptions "receive simultaneous updates reflecting the same
database snapshot" ([realtime](https://docs.convex.dev/realtime)) — cross-query
consistency is a documented platform property, not something we build. Window of
disagreement: zero, by mechanism.

**4. Visible consistency artifacts.** None of the classic ones exist, because
subscriptions deliver recomputed snapshots, not replayed events: no duplicate or
missing chunks at reconnect (there is no client cursor arithmetic to get wrong),
no resync flash (the client swaps in a consistent result). Provisional-text
retraction on a crashed attempt: chunks are keyed by `(turnId, epoch)`; the
head-doc epoch is bumped by compare-and-set and every tail query filters by
current epoch, so one commit retracts a dead epoch's text everywhere at once.

**5. Steering responsiveness.** Stop/redirect writes a steering doc. There is no
"lost notification" case because there is no separate notification path: every
2–4 Hz checkpoint mutation reads the steering doc and returns it to the turn
action, which aborts the provider fetch. Worst-case bound = one checkpoint
interval: **≤500 ms** to stop appending, plus one commit for viewers to see the
`stopped` state. That is a number, not "next fence, possibly minutes"
(hazards #4/#5: the single CAS authority is the stream head doc's epoch —
a stale attempt's checkpoint mutation fails its epoch guard and cannot commit).

**6. Reconnect/wake.** Re-subscribe; the server recomputes each query and pushes
current results — catch-up cost is one query execution per subscription,
independent of gap length. A mid-stream joiner's first tail-query result carries
the accumulated text (chunk scan, O(buffer) once), then deltas. Today's ~200
lines of checkpoint/resync/cursor protocol in `WorkstreamRoom` become a query.

**7. Behavior at the limit.** Quotas are billing meters, not rate limits — spend
grows, sockets stay up. Saturation point is the deployment class's concurrent
function executions and 10k concurrent sessions on Pro
([limits](https://docs.convex.dev/production/state/limits),
[pricing](https://www.convex.dev/pricing)): behavior is queued execution
(graceful slowdown); past it, the published path is dedicated deployment classes
(D1024/D2048) via Business tier. Hazard #8: metering is per function call, not
per receiver-message; there is no project-wide msg/s quota to negotiate.

Hazard #3 (pull-read amplification): **inapplicable** — content rides the socket
because revocation is native; there is no pull-per-frame tier. Hazard #6: a
missing per-user overlay row means "never opened"; the Unread query is an
indexed join over the member's read-state docs and the sidebar page, bounded by
page size, within the 4,096-index-range / 32k-doc read limits. Hazard #7:
retention deletes old activity rows by indexed range in scheduled mutations;
cursors are counter-doc-allocated, so deletion never disturbs monotonicity —
no partition rewrite exists to retrofit.

### The revocation claim, precisely

What triggers re-execution: the server records each subscribed query's **read
set** — the exact record versions it read, the same bookkeeping that powers OCC
([docs](https://docs.convex.dev/database/advanced/occ)); when a committed write
overlaps a subscription's read set, that query re-executes and the new result is
pushed ("whenever any data on which a query depends changes, the query is rerun,
and client subscriptions are updated" —
[queries](https://docs.convex.dev/functions/query-functions)). Avalon's
visibility rule executes *inside* every subscribed query, so the viewer's
membership row is in every read set, and **the commit that removes the user is
itself the trigger**. The bound: after that commit, no result computed at a
pre-revocation snapshot is newly delivered — every subsequent frame any client
receives is the output of a fresh execution of the authorization code against
post-revocation state. Residual exposure is delivery latency of the final,
excluding update plus text already rendered; there is no documented numeric
delivery SLA (UNKNOWN — pilot measurement; assumption sub-second). Token
streaming flows through this same mechanism — checkpoint commits re-run tail
queries — so **streamed content is authorization-checked per delivered frame by
construction**. Caching does not reintroduce staleness: cached results are
invalidated by the same read-set overlap, and identical queries are shared only
per identical auth ([queries](https://docs.convex.dev/functions/query-functions)).

## 4. Cost

**~$675/mo at S≈20; ~$8–10k/mo at S=300** (per-region; launch is one Global
deployment). All rates are Pro list prices from
[convex.dev/pricing](https://www.convex.dev/pricing); nothing below is
contact-sales. Cost drivers are function calls and action compute — reactive
re-runs are billed calls (assumption A5, §11: one mutation with one subscriber
bills the mutation plus one query re-run).

Demand per the cost brief: 3 Hz checkpoints, 3 subscribed clients/stream (1+V),
176 h/mo = 633,600 s.

| Line | Rate (Pro, US) | Included | S≈20 | S=300 |
|---|---|---|---:|---:|
| Checkpoint mutations (3 Hz × S) | $2/M calls | 25M calls total | 38M | 570M |
| Viewer tail-query re-runs (×3) | $2/M | ″ | 114M | 1,710M |
| Product traffic (messages, sidebar re-runs, presence, crons) | $2/M | ″ | ~15M | ~100M |
| **Function calls subtotal** | | | 167M → **$284** | 2.38B → **$4,710** |
| Database I/O (writes 0.5 KB/checkpoint; reads ~2 KB/re-run) | $0.20/GB | 50 GB | ~267 GB → **$43** | ~4 TB → **$790** |
| Data egress (pushed results ~2 KB/update) | $0.12/GB | 50 GB | ~250 GB → **$24** | ~3.4 TB → **$400** |
| Action compute (turn actions ≈ observed stream-hours × 0.25 GB) | $0.30/GB-hr | 250 GB-hr | ~1,000 GB-hr → **$225** | ~14,000 GB-hr → **$4,125** |
| DB + file + search storage | $0.20/$0.03/$0.50 per GB | 50/100/1 GB | **$0** | ~**$50** |
| Seats (4 developers) | $25/dev | — | **$100** | **$100** |
| Daily backups (Pro) | usage-based | — | ~$5 | ~$20 |
| **Total** | | | **≈$675/mo** | **≈$10.2k/mo** |

Range: $450–900 at S≈20 and ~$7–10k at S=300 across the 2–4 Hz cadence choice —
the dominant lines scale linearly with cadence (halving cadence roughly halves
calls/I/O/egress). S=300 is money, not architecture (§9). Future-EU note: EU
deployments price resources +30% and **the Pro included allowances do not apply**
(billed on demand exclusively) — [EU
launch](https://news.convex.dev/we-finally-got-our-eu-visa/); count ~+35–40% on
the EU region's usage lines when that build starts. Auth MAU line: **$0 at every
scale** (we validate our own JWTs; no MAU meter exists —
[custom JWT](https://docs.convex.dev/auth/advanced/custom-jwt)).

## 5. Migration plan

**Rewritten.** `packages/db` (D1 migrations + repositories) becomes
`convex/schema.ts` plus functions; the ~460 hand-written tenancy predicates
collapse into visibility helpers called inside every query. Service-layer
business logic ports as TypeScript with light edits (it is already
transaction-shaped). The Hono route surface is replaced by Convex
queries/mutations/actions; webhook ingress (GitHub, Linear, Notion, Resend)
moves to HTTP actions on the deployment's `convex.site` domain with the same
signature verification. Cloudflare Workflows → Workflow component; Queues →
transactional scheduler + Workpool; `WorkspaceScheduler` DO → crons + scheduled
functions; `WorkstreamRoom` DO and its checkpoint/replay/resync/eviction
machinery are **deleted, not ported** — reactive queries subsume them. Vectorize
→ vector indexes; D1 FTS5 → search indexes; R2 → Convex file storage (uploads,
snapshots, connector payloads). OpenRouter streaming runs inside Convex-runtime
actions via `fetch`.

**Kept.** The Electron app and its main-process security model; `packages/
contracts` Zod parsing at the client edge (Convex validators serve server-side);
the agent-harness/Bind adapter logic; the Google OAuth flow (now minting our
JWTs, validated by Convex's custom-JWT provider); the Daytona adapter (plain
HTTP from actions).

**The Hono Worker's fate, explicitly:** retired as the API tier. One vestigial
Worker remains for the Azure dictation WebSocket proxy (five-minute capped
sessions; Convex does not proxy third-party sockets). Telemetry: PostHog egress
moves into actions; the EU telemetry sink is deferred with the EU region.

**Electron connection model:** the renderer's REST client + bespoke
WebSocket/cursor protocol is replaced by `ConvexClient` — one multiplexed
WebSocket per renderer, auth via our JWT, subscriptions replacing both the
socket layer and the cache-invalidation choreography in
`docs/architecture.md`. The menu-bar process uses the HTTP client.

**Cutover at ~zero users:** stand up prod deployment; `npx convex import` from
exported D1; re-upload R2 objects; freeze writes; ship the client build; DNS
stays (API domain retired gradually). Single-writer throughout.

**Velocity freeze: ~10 product-weeks** (range 8–12), assuming 2 engineers,
port-not-redesign of services, connectors validated against recorded fixtures,
dictation Worker untouched, EU deferred per the decision frame. The
compensating deletion: no more DO/Workflow/Queue/D1 local-dev matrix — `npx
convex dev` is the whole backend loop.

## 6. Operations at team-size-small

What pages: function exception rate (Pro exception reporting → existing sink via
[log streams](https://docs.convex.dev/production/integrations/log-streams)),
stalled workflow instances (reactive status query → alert), OCC conflict
hotspots (`npx convex insights`), and vendor status — one platform's status
page instead of five products'. Distinct technologies to debug end-to-end:
**two** (TypeScript-on-Convex, Electron) plus OpenRouter as a provider; today's
stack requires six (Worker, D1, DO, Workflows, Queues, R2). Inspection: the
dashboard data browser plus `npx convex data` / `npx convex run` for ad-hoc
reads — **not SQL**. Honest mitigation, not hand-waving: Pro streaming export
via the Convex-maintained Fivetran connector feeds a warehouse for real SQL
analytics ([integrations](https://docs.convex.dev/production/integrations/streaming-import-export),
beta); for one-off production questions, an inline query is TypeScript against
typed documents, which the team writes daily anyway. Backup drill: daily
backups (Pro) with file storage included; `npx convex export` ZIP; restore is a
**destructive wipe**, so drills run against a scratch deployment
([backups](https://docs.convex.dev/database/backup-restore)) — half a day per
quarter.

## 7. Infrastructure as code & deployment

| Component (§1) | Managed by | Dashboard/ticket-only remainder |
|---|---|---|
| Schema, functions, crons, HTTP routes, auth config, components | Repo code; `npx convex deploy` with `CONVEX_DEPLOY_KEY` in CI ([CLI](https://docs.convex.dev/cli)) | — |
| Env vars / secrets | `npx convex env set/list` (scriptable, not declarative-file) | Initial deploy-key mint: dashboard |
| Project/deployment creation, region choice | Management API; dashboard | CLI `--region` "coming soon" ([regions](https://docs.convex.dev/production/regions)) |
| Backups schedule | — | **Dashboard-only** ([backups](https://docs.convex.dev/database/backup-restore)) |
| Custom domains | — | **Dashboard** (Pro) |
| Deployment class (S256→D1024), bursty-limit raises | — | **Support/sales** ([limits](https://docs.convex.dev/production/state/limits)) |
| Terraform provider | **None exists** — named, not hidden | — |
| Vestigial dictation Worker | Wrangler config (unchanged) | — |

Environments: each developer gets a free dev deployment; preview deployments
stamp per-branch (Pro); staging is a second project whose cost is usage only —
**no per-environment compute floor**, unlike today's two-region × N-env Worker
estate. Migration ordering (hazard #12): a deploy is **one push carrying schema
and functions together**, schema-validated against existing data before
activation — today's window where old Worker code writes into a new D1 schema
does not exist, because there is no separate migration step; staged backfills
use the [migrations component](https://www.convex.dev/components/migrations)
with both-shape-tolerant code. Rollback: redeploy the previous artifact;
data rollback via backup restore. Drift: deployment state is the last push; env
vars are the drift surface (CI asserts `env list`). Deploys are online;
end-to-end deploy is minutes with single-deployment blast radius. Downtime
operations: region migration (backup/restore) and restore itself; no
compute-resize downtime is documented (UNKNOWN — ask before dedicated tier).

## 8. Top three risks

**1. The metering assumption might be false (the "assumption might be false"
risk).** My cost model bills one function call per reactive re-run, per-user
cache partitioning under auth, and 0.25 GB-hr per action-hour (A5–A7, §11). The
pricing page defines the meters but not re-run granularity at this precision;
vendor materials support the model but I could be wrong in either direction.
Probability materially wrong: ~30%; blast radius: ±2× on the dominant lines —
worst case ≈$1.4k/mo at S≈20, which does not flip the decision, and ≈$20k at
S=300, which would. Resolution: a one-week S≈5 load test read directly off the
usage dashboard before commitment — cheap, decisive, and I commit to it.

**2. Vendor size and maturity.** Convex Inc. is a venture-backed startup, far
smaller than Cloudflare; components (Workflow, Workpool) are newer than the
core; the platform lists authorization frameworks and observability as still
"in development" ([status](https://docs.convex.dev/production/state/)).
Is the open-source backend a real mitigation? Partially real: it is "the same
fully up-to-date code the cloud service uses," FSL-licensed converting to
Apache 2.0 after two years ([self-hosting](https://docs.convex.dev/self-hosting)),
so vendor death leaves us a running exit at our scale (single region, S≤300) —
but it is an **exit ramp, not a hot spare**: we would inherit ops, lose the
managed dashboard/scaling, and multi-node self-host guarantees are UNKNOWN.
Probability we need it in 3 years: low-moderate (~15%); blast radius: weeks of
ops adoption, not data loss (weekly export drill, A11). This risk is the price
of the §3 mechanism — no other candidate sells it, so no bigger vendor removes
the risk without removing the benefit.

**3. EU is a region, not yet a contract.** The Ireland region is six months old;
docs state infrastructure runs in-region but I found **no published DPA,
subprocessor list, or contractual processing commitment** on docs.convex.dev
(UNKNOWN — resolved only by a signed DPA + subprocessor review before the EU
build), and whether the team/dashboard control plane processes any content
outside the region is likewise UNKNOWN. Scored as the decision frame directs —
future-path credibility: the path exists and is priced (+30%, no included
usage), its contractual floor is unverified. Probability the contractual story
blocks an enterprise-grade EU launch as offered today: moderate (~35%);
blast radius: EU launch timing, not the Global launch; fallback: self-hosted EU
deployment on EU infrastructure (risk 2's machinery, deliberately).

## 9. What breaks first

Money breaks first, then a sales ticket, then architecture. First binding:
the function-call line, linear in S × viewers (~$4.7k/mo at S=300) — fix is
money plus the cadence lever (configuration). Second: the Pro deployment class
(S256, 10k concurrent sessions); fix is the dedicated D1024/D2048 tier —
a contact-sales dependency, named
([limits](https://docs.convex.dev/production/state/limits)). Third, the honest
dead end at S≈2,000: a deployment is one logical database with **no published
horizontal shard story inside it**; the fix is architecture — per-workspace
sharding across projects in application code, the same shape the DO design
pays for on day one. Separately, the 30-minute Convex-runtime action cap kills
the extreme-tail single model turn; consequence: that turn aborts and retries
from the last durable step, re-spending the provider call — a real regression
versus Cloudflare Workflows' unbounded step, at tail frequency.

## 10. Tripwires

- Reactive re-run spend >$1,000/mo while S<50, or the pilot load test misses
  the §4 model by >50% → re-price against pull-based candidates.
- p95 commit→client update latency >1 s sustained for a week at peak → the
  sub-second push assumption failed; reopen.
- ≥3 model turns/week aborted by the 30-minute action ceiling → external turn
  host or reopen.
- No signable DPA with in-region processing commitments by EU-build kickoff →
  self-host EU or reopen.
- FSL license change, >25% pricing change, or vendor-distress signal → run the
  export + self-host drill within 30 days.

## 11. Assumptions register

- A1: 3 Hz checkpoint cadence (2–4 Hz product range); A2: 3 subscribed clients
  per observed stream (1+V); A3: 176 observed h/mo (633,600 s) — all from the
  cost brief's register.
- A4: ~0.5 KB written per checkpoint (delta batch + head doc + index); ~2 KB
  read and ~2 KB pushed per tail-query re-run.
- A5: every reactive re-run bills one function call (vendor materials state a
  mutation with one subscriber bills two calls); cached identical
  subscriptions share only within identical auth.
- A6: turn actions alive 1:1 with observed stream-hours.
- A7: 0.25 GB billed memory per action-hour (allocation granularity not
  published).
- A8: scheduler dispatch and subscription push latencies sub-second (no
  documented bounds).
- A9: product traffic ≈15M calls/mo at S≈20 (messages, sidebar, presence,
  crons); sidebar re-runs scale with online members × commit rate and become
  their own budget line at single-workspace scales ≈500 online.
- A10: 4 developer seats; 10-week freeze with 2 engineers, port-not-redesign.
- A11: weekly `npx convex export` drill as the vendor-exit hedge.
- A12: S≈20 as the 10k-user primary sizing point, per the decision frame.
