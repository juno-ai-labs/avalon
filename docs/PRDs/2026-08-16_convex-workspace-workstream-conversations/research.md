# Convex platform research for Avalon workspace and work-stream conversations

**Research date:** 2026-08-16. Every vendor page cited below was fetched or
re-fetched on 2026-08-16; quoted figures are the wording as retrieved on that
date.

**Purpose:** platform-research companion to the Convex PRD in this folder. It
records where each product requirement lands on a documented Convex mechanism,
which of today's Cloudflare primitives that mechanism retires, what the vendor
does *not* document, and which of those gaps the PRD's Phase-0 gates have to
close. This is research, not the PRD, and not a recommendation: the
recommendation was produced by the adjudication summarized in §1 and is
conditional on a pilot that has not been run.

Only official Convex sources (`docs.convex.dev`, `convex.dev`, `news.convex.dev`)
are used for vendor claims. Where a claim in the winning advocate brief is not
supported by an official page, it is marked UNKNOWN here rather than restated.

---

## 1. Provenance

### 1.1 The two sibling PRDs

This PRD is the third implementation of one unchanged product contract.

- [`../2026-08-15_durable-workspace-workstream-conversations/prd.md`](../2026-08-15_durable-workspace-workstream-conversations/prd.md)
  is the source contract: workspace collections and sidebar state, work-stream
  ordered parts and substreams, queue-versus-steer semantics, compaction
  fences, connector ingress and digests, and the 75 showcase/break flows in its
  `flows.md`. It implements that contract on Cloudflare Durable Objects.
- [`../2026-08-15_supabase-workspace-workstream-conversations/prd.md`](../2026-08-15_supabase-workspace-workstream-conversations/prd.md)
  re-implements the same contract on regional Postgres, and its
  [`research.md`](../2026-08-15_supabase-workspace-workstream-conversations/research.md)
  is the document this one mirrors in role. Its `comparison.md` is the
  first head-to-head between the two.
- The standing product contract both defer to is
  [`../2026-08-05_avalon-implementation-brief/prd.md`](../2026-08-05_avalon-implementation-brief/prd.md).

The product semantics are identical across all three. Only the substrate
changes; nothing in this document proposes a product change, and any statement
here that appears to imply one should be read as an error against the sibling
PRD.

### 1.2 The adjudication that produced this PRD

The choice of substrate was not made by argument in a room. The operator ran a
four-candidate structured adjudication on 2026-08-16:

1. **Four advocate briefs**, one per candidate — AWS, GCP, Supabase, Convex —
   each written to an identical eleven-section packet with a word cap, required
   specifics (two cost points, migration units, IaC disclosures, hazard
   coverage) and a mandatory assumptions register.
2. **An operator compliance gate per brief.** The Convex gate returned PASS
   with two patches required before judging: hazard #9 (what rate-limits an
   authenticated-but-hostile client per principal) was silently skipped, and
   the auth-scoped-cache sentence in its revocation section "reads as cited
   fact but is an assumption." Both patches are carried into the PRD stack —
   the first as the rate-limiter component in the named stack, the second as
   the honest caveat in §3.1 below.
3. **Two clean-context adversarial cross-examination agents** replacing the
   advocate rebuttal round — one on mechanisms, one rebuilding every cost
   figure from the briefs' own cited rates. A claim successfully challenged
   there and lacking a citation scores as unknown. Four challenges land on
   Convex: C1 (revocation semantics), C6 (steering bound), C9 (Node-runtime
   action ceiling), C13 (technology count). The cost rebuild found no
   arithmetic errors in the Convex brief and one misread *against its own
   interest* (see §4.3).
4. **Three independent clean-context judge passes**, different candidate read
   orders, identical inputs. Means out of 100: Convex 67.5, GCP 61.3,
   Supabase 57.6, AWS 51.2 — **2–1 for Convex**, with pass 1's GCP win by 0.9
   points self-labelled "inside judgment noise."
5. **A converged decision function.** All three judges, independently,
   arrived at the same hinge: *Convex if its one-week S≈5 pilot passes; GCP if
   it fails.* Two passes put the prior on Convex and named the pilot as the
   flip-to-GCP; one put the prior on GCP and named the same pilot as the
   flip-to-Convex. The recorded runner-up is therefore GCP, and it is a real
   runner-up, not a formality.

The full record — packet, four briefs, gate reports, challenges, owner notes,
three judge passes with minority reports, and the aggregate verdict — lives on
its review branch and does not merge to `main`:
<https://github.com/juno-ai-labs/avalon/tree/claude/supabase-workspace-prd-review-k3iyfb/adjudication>

Two standing overrides from the verdicts survive the pilot: enterprise
self-hosting becoming a near-term contractual requirement, or the Singapore
region arriving before Convex's region catalog grows, each shift the answer
toward the runner-up regardless of what the pilot measures.

### 1.3 What this document is not

It is not an independent re-derivation of the cost model; §4.3 records the
audited figures and their stated uncertainty. It is not a verdict on the open
revocation product decision; it records that on this candidate the two stances
cost the same and share one mechanism, which is why the decision is cheap here
and expensive elsewhere. And it does not treat the advocate brief as a source:
every load-bearing number below was re-fetched from the vendor page.

---

## 2. Platform capability map

One column that matters for reading this table: Convex is a single product with
one deployment per region, so "what it replaces" is mostly a deletion, not a
swap. Today's regional estate is a Hono Worker terminating REST and WebSocket
upgrades, D1 (with FTS5), R2, two Durable Object classes (`WorkstreamRoom`,
`WorkspaceScheduler`), Cloudflare Workflows, Cloudflare Queues, and Vectorize —
see `docs/architecture.md`.

| Avalon platform need | Convex mechanism (documented) | Source | Replaces today |
| --- | --- | --- | --- |
| Serialized multi-row writes | Mutations are serializable transactions with automatic retry on conflict; message + sidebar card + overlays + activity row + schedule commit together | [OCC](https://docs.convex.dev/database/advanced/occ) | `WorkstreamRoom` DO serialization + D1 writes + cross-object projection repair |
| Per-stream total order | Read-modify-write of a counter on the work-stream head document inside the same transaction; OCC forces serial commit order | [OCC](https://docs.convex.dev/database/advanced/occ) | DO single-threaded sequence allocation |
| Live fan-out | Reactive query subscriptions over the Convex client WebSocket; "Every client subscription gets updated simultaneously to the same snapshot of the database" | [realtime](https://docs.convex.dev/realtime) | DO hibernating WebSockets + the bespoke hint/cursor client protocol |
| Revocation on live channels | Visibility code runs inside every subscribed query; a write that overlaps a query's dependencies re-runs it — the mechanism, not a documented revocation bound (§3.1) | [realtime](https://docs.convex.dev/realtime), [queries](https://docs.convex.dev/functions/query-functions) | Join-time DO authorization plus per-frame re-check machinery |
| Durable cursors and audit | Counter documents allocated inside the writing transaction; durable event/receipt rows kept for history and export. Clients do not run cursor catch-up — a re-subscribed query recomputes a snapshot | [queries](https://docs.convex.dev/functions/query-functions) | DO checkpoint/replay/resync/eviction machinery (deleted, not ported) |
| Streaming token persistence | Turn action buffers provider tokens and commits an append-only delta chunk every 250–500 ms; same shape as the vendor's component, which "queues chunks in memory and persists them efficiently" | [persistent text streaming](https://www.convex.dev/components/persistent-text-streaming) | DO accumulated active-stream buffer + checkpoint rows in D1 |
| Long agent loops | Workflow component: steps persist to the database, "can run for months, and survive server restarts", per-step retry policies | [workflow](https://www.convex.dev/components/workflow) | Cloudflare Workflows |
| One model turn | One action in the default Convex runtime — **30 minutes**; Node.js-runtime actions are capped at **10 minutes** | [limits](https://docs.convex.dev/production/state/limits) | Workflow step (unbounded) — a named regression, §4.1 |
| At-least-once jobs | `ctx.scheduler` from a mutation: "If the mutation succeeds, the scheduled function is guaranteed to be scheduled." Scheduled mutations "guaranteed to be executed exactly once"; scheduled actions "executed at most once" — the Workflow/Workpool retry layer plus idempotency receipts make the composite at-least-once | [scheduling](https://docs.convex.dev/scheduling/scheduled-functions), [workpool](https://www.convex.dev/components/workpool) | Cloudflare Queues + `WorkspaceScheduler` DO alarms |
| Per-principal budgets | Rate limiter component: "Transactional evaluation: all rate limit changes will roll back if your mutation fails"; fixed-window or token-bucket; sharded counters; "Fails closed, not open" | [rate limiter](https://www.convex.dev/components/rate-limiter) | Worker-tier limiting (gate patch 1) |
| Blobs | Convex file storage; `storage.getUrl()` is a bearer-token URL — "anyone with the URL can access the file", and "the only way to revoke a file URL is by deleting the file"; permission-checked serving goes through an HTTP action capped at 20 MB | [file storage](https://docs.convex.dev/file-storage) | R2 |
| Full-text search | `searchIndex` read inside a normal query, so app visibility code applies; "automatically reactive, consistent, transactional" | [text search](https://docs.convex.dev/search/text-search) | D1 FTS5 |
| Vector search | Vector indexes; "Vector searches can only be performed in a Convex action", results are `_id`+`_score` and are re-loaded through a query — **not** transactionally consistent with that action | [vector search](https://docs.convex.dev/search/vector-search) | Vectorize |
| Auth | Custom JWT provider in `convex/auth.config.ts` (`type: "customJwt"`): issuer, JWKS URL, `applicationID`, RS256/ES256; claims `iss`/`sub`/`aud`/`exp`, with `iat` "expected by Convex clients to implement token refreshing" | [custom JWT](https://docs.convex.dev/auth/advanced/custom-jwt) | Existing Google OAuth flow retained; Avalon's Global identity plane mints the JWT. No auth vendor, no MAU meter |
| Webhook ingress | HTTP actions on `https://<deployment>.convex.site`, standard Fetch `Request` (raw body available for signature verification), 20 MB request/response, Convex runtime | [HTTP actions](https://docs.convex.dev/functions/http-actions) | Hono webhook routes on the Worker |
| Regions | "The current available regions are in US East (N. Virginia) and EU West (Ireland)"; "All infrastructure powering your deployment will be hosted in the selected region"; "An existing deployment's region cannot be changed" | [regions](https://docs.convex.dev/production/regions) | Two Cloudflare deployments with regional D1/R2/DO namespaces |
| IaC and deploys | Schema, functions, crons, HTTP routes, auth config and components deploy as one push (`npx convex deploy` with `CONVEX_DEPLOY_KEY`); env vars via `npx convex env set/list` | [CLI](https://docs.convex.dev/cli) | Wrangler config + D1 migration step (the separate-migration window disappears) |
| Backups | "A backup is a consistent snapshot of your table data made at the time of your request"; backups "can be configured to include file storage"; periodic daily/weekly requires Pro | [backups](https://docs.convex.dev/database/backup-restore) | D1 time-travel + a separate, unsolved R2 story |
| Analytics / SQL | No SQL. Dashboard data browser, `npx convex data` / `npx convex run`, and Pro streaming export via the Convex-maintained Fivetran connector into a warehouse — "currently a beta feature" | [streaming export](https://docs.convex.dev/production/integrations/streaming-import-export) | D1 SQL |
| Self-host exit | Open-source backend under an FSL licence: "All code is automatically converted to full Apache-2.0 two years after its creation"; "Self-hosted Convex runs the open-source backend, and contains the same fully up-to-date code the cloud service uses" | [self-hosting](https://docs.convex.dev/self-hosting) | No equivalent exists today |
| Dictation socket proxy | **Not replaced.** Convex terminates its own client sockets but does not proxy an arbitrary authenticated third-party WebSocket | — | One vestigial Cloudflare Worker stays, unchanged |

### 2.1 The seven load-bearing pages, re-verified

Everything above that the design leans on numerically was re-fetched on
2026-08-16 and is quoted verbatim in §4. The seven that would change the design
if they were wrong:

- **Action ceilings.** Convex-runtime actions **30 minutes**, Node.js-runtime
  actions **10 minutes**; Convex runtime **64 MiB RAM**, Node **512 MiB**
  ([limits](https://docs.convex.dev/production/state/limits)). The 20 MiB gap
  between those two ceilings is challenge C9 and a Phase-0 blocker.
- **Regions.** US East (N. Virginia) and EU West (Ireland) only; region
  immutable; "CLI support for selecting a region for new deployments is coming
  soon" ([regions](https://docs.convex.dev/production/regions)). There is no
  Singapore region, which the owner's three-region target eventually needs.
- **Pricing meters and Pro allowances.** $25 per developer/month; deployment
  class S256; 10,000 concurrent sessions; 25M function calls included then $2
  per additional 1M; 250 GB-hours action compute then $0.30/GB-hour; 50 GB
  database storage then $0.20/GB; 50 GB database I/O then $0.20/GB; 100 GB file
  storage then $0.03/GB; 50 GB data egress then $0.12/GB; 1 GB search storage
  then $0.50/GB ([pricing](https://www.convex.dev/pricing)). These are meters,
  not rate limits — there is no msg/s quota to negotiate, which is the
  structural difference from the Supabase sibling's 2,500 msg/s cap.
- **Scheduling transactionality.** "If the mutation succeeds, the scheduled
  function is guaranteed to be scheduled. On the other hand, if the mutation
  fails, no function will be scheduled."
  ([scheduling](https://docs.convex.dev/scheduling/scheduled-functions)). This
  is what removes the outbox pattern the sibling PRDs need.
- **Backups.** Snapshot of table data; file storage optionally included;
  **"Restoring is a destructive operation that wipes your existing data and
  replaces it with that from the backup."** Restores work across deployments on
  the same team but not into dedicated hardware deployments
  ([backups](https://docs.convex.dev/database/backup-restore)).
- **Custom JWT auth.** Verified as above; the `$0` auth line in the cost model
  is a consequence of this page existing, and it is the only candidate that
  priced bring-your-own-identity.
- **Self-hosting licence.** FSL converting to Apache-2.0 two years after
  creation, same code as cloud
  ([self-hosting](https://docs.convex.dev/self-hosting)). This is an exit ramp,
  not a hot spare: see §3.8.

### 2.2 Where the mapping is a deletion rather than a port

Three subsystems disappear instead of moving, and they are the reason the
migration estimate is the smallest in the field (~10 engineer-weeks, range
8–12, two engineers):

- `WorkstreamRoom`'s checkpoint/replay/resync/eviction protocol — roughly 200
  lines of client-and-server cursor choreography — becomes one subscribed
  query. There is no client cursor arithmetic left to get wrong, so the
  reconnect artifacts it exists to prevent cannot occur.
- The separate schema-migration step disappears: a deploy is one push carrying
  schema and functions together, schema-validated against existing data before
  activation. Today's window in which old Worker code writes into a new D1
  schema has no analogue. Staged backfills use the
  [migrations component](https://www.convex.dev/components/migrations) with
  both-shape-tolerant code.
- The per-environment compute floor disappears: each developer gets a free dev
  deployment, preview deployments stamp per branch on Pro, and a staging
  project costs usage only.

Against that, the client rewrite is the largest of the four candidates: the
renderer's REST client and bespoke WebSocket protocol are replaced by
`ConvexClient` — one multiplexed socket per renderer, our JWT, optimistic
updates. Challenge C4 is the reminder that "product-weeks" is not a comparable
unit across briefs; the ~10 engineer-weeks here is two engineers for roughly
five calendar weeks and includes that rewrite.

---

## 3. What is NOT documented

This is the honest register. Each item is something the design leans on, or has
been claimed to lean on, that no official Convex page states. Nothing here is
presented as a defect in the product — several are simply things vendors do not
usually publish — but each one is a place where the PRD is running on inference,
and each has a named resolution path.

### 3.1 Per-frame auth freshness and auth-scoped caching (challenge C1)

**Claimed, and the load-bearing claim of the whole design:** after a commit that
removes a user's membership, no result computed at a pre-revocation snapshot is
newly delivered to that user — including from caches and across reconnects — so
streamed content is authorization-checked per delivered frame.

**What the pages actually say, re-fetched 2026-08-16:**

- [queries](https://docs.convex.dev/functions/query-functions): "Convex caches
  query results automatically. If many clients request the same query, with the
  same arguments, they will receive a cached response." **Nothing about
  authentication or identity scoping that cache.** The page also states "All
  database reads inside a single query call are performed at the same logical
  timestamp" and that handlers must be deterministic "given the same arguments
  (including the query context)."
- [realtime](https://docs.convex.dev/realtime): "Convex tracks the dependencies
  to your query functions, including database changes, and triggers the
  subscription in the client libraries" and "Every client subscription gets
  updated simultaneously to the same snapshot of the database." **No statement
  about when a removed user's subscription stops receiving, no
  snapshot-monotonicity guarantee across reconnect, no latency bound.**
- [OCC](https://docs.convex.dev/database/advanced/occ): read sets are described
  for **write transactions at commit time** — "the writes all commit if every
  version in the read set is still the latest version." The page says nothing
  about subscription re-execution being driven by per-subscription read-set
  bookkeeping.

**Status:** the guarantee is a plausible engineering inference assembled from
three properties the cited pages do not contain. It is UNKNOWN as documented.

**Resolution path:** a written vendor confirmation — in docs or in contract —
that subscription re-delivery after a revoking commit is auth-fresh per frame,
including caches and reconnects (Phase-0 gate (b)), plus pilot measurement of
the delivery bound. The design's insurance is that the fallback stance
(bounded staleness ≤60 s) costs **$0 and requires no design change**, because
both stances ride the same mechanism. That is the one place where this
candidate's open product decision is free; on the Supabase sibling only one
stance is exercisable at all (challenge C5).

### 3.2 Scheduler-dispatch and subscription-push latency (assumption A8)

No Convex page states a dispatch-latency bound for scheduled functions, and no
page states a push-latency bound for subscription updates. The design assumes
sub-second for both: admission → first visible byte is model TTFT plus roughly
0.5–1.5 s, and the p95 commit→client push target is ≤1 s.

**Resolution path:** Phase-0 gate (a) measures it — p95 commit→client push
≤1 s sustained over a one-week S≈5 pilot. This is the highest-weighted number
in the judged UX score and the one the judges explicitly said was rated as a
mechanism, not as measured pixels. Tripwire 1 in the aggregate verdict watches
it after launch.

### 3.3 Re-run metering granularity (assumption A5, ±2×)

The pricing page defines the meters but not at the granularity the cost model
needs: whether every reactive re-run bills one function call, and whether
identical subscriptions share a cached result only within identical auth (the
same sentence as C1, arriving through the billing door). The cost audit put the
blast radius at **±2× on the dominant lines** — worst case around $1.4k/mo at
S≈20, which does not flip the decision, and around $20k/mo at S=300, which
would.

**Resolution path:** Phase-0 gate (a) reads metered spend off the usage
dashboard directly and passes if it is within +50 % of the model. Tripwire 2
watches it thereafter.

### 3.4 Action memory billing granularity (assumption A7)

The cost model bills 0.25 GB of memory per action-hour. Allocation and billing
granularity are unpublished. Worth noting in the design's favour: the
documented Convex-runtime memory limit is **64 MiB**
([limits](https://docs.convex.dev/production/state/limits)), one quarter of the
assumed 0.25 GB, so if billing tracks the runtime cap the action-compute line
— 40 % of the S=300 total — is over-estimated rather than under. The direction
is favourable; the number is still UNKNOWN.

**Resolution path:** same pilot meter read as §3.3.

### 3.5 No Terraform provider

There is none, and this is stated plainly rather than worked around.
Schema, functions, crons, HTTP routes, auth config and components are repo code
deployed by `npx convex deploy`; env vars are scriptable via `npx convex env
set/list` but are not a declarative file, and are therefore the drift surface
(CI asserts `env list`). Dashboard- or ticket-only remainders: backup schedule,
custom domains, initial deploy-key mint, project/deployment creation and region
choice, and deployment-class changes. This is the single largest contributor to
Convex scoring last on Maintainability (5/10) in all three judge passes.

**Resolution path:** none available from the vendor. Accepted as a cost, named
in the PRD's Rollout section, and mitigated only by the fact that the
non-declarative surface is small and asserted in CI.

### 3.6 No published DPA, subprocessor list, or in-region processing commitment

The EU region is real and verified: "The current available regions are in US
East (N. Virginia) and EU West (Ireland)"
([regions](https://docs.convex.dev/production/regions)), launched 6 Feb 2026 as
`aws-eu-west-1`, with "resource-based pricing … 30% higher" and "the included
usage for Starter and Pro plans (such as the 25M function calls a month) on US
deployments does not apply to EU deployments, which are exclusively billed on
demand as of now"
([EU launch](https://news.convex.dev/we-finally-got-our-eu-visa/)).

What is UNKNOWN is the contractual layer: no published DPA, no subprocessor
list, no contractual processing commitment on docs.convex.dev, and no statement
about whether the team/dashboard control plane processes content outside the
selected region.

**Resolution path:** Phase-0 gate (c) — DPA and subprocessor review before any
EU build starts. Launch is Global (US East) only and EU is deferred and
fail-closed, so this does not gate the Global launch. Tripwire 4: no signable
in-region DPA by EU-build kickoff → self-host EU or reopen. Note the ordering
consequence: EU is deferred, so the migration's D1 export must have an explicit
answer to "what is in EU D1 today" (challenge C10 flags that all three
migration plans dodged it).

### 3.7 No published in-deployment shard story

A deployment is one logical database. There is no published horizontal shard
story inside it, and the documented path past the Pro deployment class is a
different class, not more shards: concurrency limits scale from S16 to S256 to
D1024/D2048, and "Limits can be increased for Business and Enterprise plan
customers on a case-by-case basis. Send us a support message through the
dashboard to discuss your needs."
([limits](https://docs.convex.dev/production/state/limits)). Business and
Enterprise carry a "$2,500 monthly minimum"
([pricing](https://www.convex.dev/pricing)).

The honest consequence: money breaks first (the function-call line, linear in
S × viewers), then a sales ticket (S256 → D1024), then architecture at S≈2,000,
where the fix is application-level per-workspace sharding across projects. That
is the same shape the Durable Object design pays for on day one, arriving later.

**Resolution path:** none needed pre-launch; it is a named dead end with a known
architectural fix, recorded so that a later change does not discover it.

### 3.8 Self-hosting is an exit ramp, not a hot spare

The licence and code-parity statements are verified (§2.1). What is not
documented on the self-hosting page: multi-node deployment guarantees, scaling
characteristics, or which managed features are absent. The page says only that
"Self hosting is not for everyone" and recommends the cloud product as "a more
hands-off solution." Multi-node self-host behaviour is UNKNOWN.

**Resolution path:** treat it as what it is — a hedge against vendor
disappearance at our scale (single region, S≤300), rehearsed by a weekly
`npx convex export` drill (assumption A11), not as an availability strategy.
Tripwire 5: a licence change, >25 % pricing change, or vendor-distress signal
triggers the export/self-host drill within 30 days.

### 3.9 Vendor-stated maturity gaps

The vendor's own status page says an authorization framework is future work,
telemetry offers "only basic metrics", and OLAP/analytics capability is limited
because the platform prioritizes real-time OLTP
([status](https://docs.convex.dev/production/state/)). It targets "an
availability of 99.99% (4 9's) for Convex deployments" while noting deployments
"may experience downtime for maintenance without notice", and claims
"99.999999999% (11 9's) durability" for backups. Streaming export is "currently
a beta feature". The Workflow and Workpool component pages carry no beta
labelling, but both are newer than the core.

**Consequence for the technology count (challenge C13):** the brief's claim of
"two distinct technologies to debug end-to-end" is not honest. The count the
PRD uses is **≈5**: TypeScript-on-Convex, the Electron client, the retained
Cloudflare dictation Worker, Fivetran plus a warehouse (the stated SQL-analytics
mitigation), and the three vendor components (Workflow, Workpool, rate limiter)
that the platform itself describes as newer than the core. That is still fewer
than today's six Cloudflare products, which is the real claim.

### 3.10 Steering under a stalled provider stream (challenge C6)

Not a documentation gap but a design gap the challenge exposed, recorded here
because the fix is mandatory and easy to lose. The ≤500 ms visible-halt bound
was derived from checkpoint cadence, and checkpoints are token-driven: when the
provider stalls or the turn sits inside a long tool effect, no checkpoint runs,
nothing reads the steering document, and the abort is unbounded by anything
stated. The design therefore requires a **timer-driven watchdog that fires a
no-op checkpoint every 500 ms even when no tokens arrive**, so the bound holds
independent of token flow. The epoch compare-and-set (a stale attempt's
checkpoint cannot commit) was never in question and holds as written.

---

## 4. Verified limits and prices

Every row was retrieved 2026-08-16 from the linked page and is quoted as
printed. These are design inputs, not contractual guarantees; recheck before
capacity review.

### 4.1 Execution and transaction limits

| Limit | Value as documented | Design consequence |
| --- | --- | --- |
| Action, Convex runtime | 30 minutes | One model turn = one action. Turns past 30 min abort and retry from the last durable step, re-spending the provider call — a named tail regression versus Cloudflare Workflows' unbounded step |
| Action, Node.js runtime | 10 minutes | **C9 blocker.** Zero headroom over the ~10-minute long-turn requirement. Anything in the kept harness/Bind port that forces `"use node"` fails Phase-0 gate (a) and triggers the external-turn-host fallback design |
| Memory, Convex runtime / Node | 64 MiB / 512 MiB | Turn actions stream, they do not accumulate; also bears on the A7 billing assumption (§3.4) |
| Function argument / return size | 16 MiB (Node action arguments 5 MiB) | Content moves by reference, not by argument |
| HTTP action request/response | 20 MiB | Permission-checked blob serving is capped; large files use `storage.getUrl()` bearer URLs |
| Data read / written per transaction | 16 MiB / 16 MiB | Tail queries page; seal copies chunks in bounded batches |
| Documents scanned per transaction | 32,000 | Unread/sidebar joins stay indexed and page-bounded |
| Index ranges read per transaction | 4,096 | Sidebar page size is a hard design input, not a preference |
| Documents written per transaction | 16,000 | Chunk-tombstoning at seal is batched |
| Document size | 1 MiB | Delta chunks are small by construction; parts spill to file storage |
| Indexes per table | 32 | Search indexes count against this budget |
| Tables per deployment | 10,000 | Not binding |
| Outstanding scheduled functions | 1,000,000 | Not binding at S=300 |
| Scheduled functions per mutation | 1,000 | Fan-out scheduling must batch |
| Scheduled function argument size | 4 MiB | Pass identifiers, not payloads |
| Concurrency by deployment class | queries 16→2,048; mutations 16→1,024; actions 64→2,048; scheduled jobs 8→1,024; concurrent sessions 1,000→200,000 (S16 … D2048) | Saturation is queued execution — graceful slowdown, not dropped sockets |
| Limit increases | "Limits can be increased for Business and Enterprise plan customers on a case-by-case basis. Send us a support message through the dashboard to discuss your needs." | The S256 → D1024 path is a sales dependency, named |

Source for all rows:
[limits](https://docs.convex.dev/production/state/limits), retrieved 2026-08-16.

### 4.2 Search, storage and scheduling semantics

| Item | Value as documented | Source (retrieved 2026-08-16) |
| --- | --- | --- |
| Search index shape | one search field, "up to 16 filter fields"; max 32 indexes per table | [text search](https://docs.convex.dev/search/text-search) |
| Search query bounds | "Search queries can scan up to 1024 results from the search index"; up to 16 terms per expression, 8 filter expressions, terms lowercased and limited to 32 characters | [text search](https://docs.convex.dev/search/text-search) |
| Search consistency | "automatically reactive, consistent, transactional"; runs as a normal database read, so visibility code applies | [text search](https://docs.convex.dev/search/text-search) |
| Vector search placement | "Vector searches can only be performed in a Convex action" | [vector search](https://docs.convex.dev/search/vector-search) |
| Vector index shape | exactly 1 dimension field, value between 2 and 4096; up to 16 filter fields; up to 64 filter expressions | [vector search](https://docs.convex.dev/search/vector-search) |
| Vector result bounds | "Up to 256 results (defaulting to 10)"; results carry only `_id` and `_score` and are re-loaded via a query — **not** transactionally consistent | [vector search](https://docs.convex.dev/search/vector-search) |
| File URL semantics | `storage.getUrl()` is a bearer token: "anyone with the URL can access the file"; "the only way to revoke a file URL is by deleting the file" | [file storage](https://docs.convex.dev/file-storage) |
| Scheduling atomicity | "If the mutation succeeds, the scheduled function is guaranteed to be scheduled. On the other hand, if the mutation fails, no function will be scheduled." | [scheduling](https://docs.convex.dev/scheduling/scheduled-functions) |
| Scheduled execution semantics | scheduled mutations "guaranteed to be executed exactly once"; scheduled actions "executed at most once"; actions get no automatic retry | [scheduling](https://docs.convex.dev/scheduling/scheduled-functions) |
| Scheduler dispatch latency | **not documented** | [scheduling](https://docs.convex.dev/scheduling/scheduled-functions) |
| Backup contents | "A backup is a consistent snapshot of your table data made at the time of your request"; "can be configured to include file storage" | [backups](https://docs.convex.dev/database/backup-restore) |
| Backup scheduling and retention | periodic daily/weekly requires Pro, configured on the dashboard; manual 7 days, daily 7 days, weekly 14 days | [backups](https://docs.convex.dev/database/backup-restore) |
| Restore semantics | "Restoring is a destructive operation that wipes your existing data and replaces it with that from the backup." Cross-deployment restore allowed on the same team, not into dedicated hardware deployments | [backups](https://docs.convex.dev/database/backup-restore) |
| Region catalog | "The current available regions are in US East (N. Virginia) and EU West (Ireland)"; "An existing deployment's region cannot be changed"; "CLI support for selecting a region for new deployments is coming soon" | [regions](https://docs.convex.dev/production/regions) |
| EU pricing | "resource-based pricing is 30% higher"; "the included usage for Starter and Pro plans … does not apply to EU deployments, which are exclusively billed on demand as of now" | [EU launch](https://news.convex.dev/we-finally-got-our-eu-visa/) |
| Custom JWT | `type: "customJwt"` in `convex/auth.config.ts`; issuer, JWKS URL, `applicationID`, RS256/ES256; `iss`/`sub`/`aud`/`exp` required, `iat` "expected by Convex clients to implement token refreshing" | [custom JWT](https://docs.convex.dev/auth/advanced/custom-jwt) |
| Self-host licence | "All code is automatically converted to full Apache-2.0 two years after its creation"; self-hosted "contains the same fully up-to-date code the cloud service uses" | [self-hosting](https://docs.convex.dev/self-hosting) |
| Streaming export | "Streaming export requires a Convex Pro plan"; Convex-maintained Fivetran connector; "currently a beta feature" | [streaming export](https://docs.convex.dev/production/integrations/streaming-import-export) |
| Platform targets | "an availability of 99.99% (4 9's)"; deployments "may experience downtime for maintenance without notice"; "99.999999999% (11 9's) durability" for backups | [status](https://docs.convex.dev/production/state/) |

### 4.3 Prices and the cost anchors

Pro plan, US region, from [pricing](https://www.convex.dev/pricing) retrieved
2026-08-16. Nothing here is contact-sales.

| Meter | Pro included | Overage |
| --- | --- | --- |
| Seats | — | "$25 per developer/month" |
| Function calls | "25M included" | "$2 per additional 1M" |
| Action compute | "250 GB-hours included" | "$0.30 per additional GB-hour" |
| Database storage | "50 GB included" | "$0.20 per additional GB" |
| Database I/O | "50 GB included" | "$0.20 per additional GB" |
| File storage | "100 GB included" | "$0.03 per additional GB" |
| Data egress | "50 GB included" | "$0.12 per additional GB" |
| Search storage | "1 GB included" | "$0.50 per additional GB" |
| Search queries | "50,000 query-GBs included" | "$0.10 per additional 1000 query-GBs" |
| Deployment class / sessions | S256; "10,000" concurrent sessions; "256" concurrent queries | Higher classes via Business/Enterprise ("$2,500 monthly minimum") |

**The anchors the PRD carries:** ~$675/mo at S≈20 and ~$8–10k/mo at S=300,
per-region, with the A5 caveat of ±2× on the dominant lines. Two honest notes
on those figures:

1. The cost audit rebuilt all eight headline totals across the four briefs from
   each brief's own cited rates and found **zero arithmetic errors**; all Convex
   Pro rates verified live. It also found that the Convex brief billed three
   receiver re-runs where the demand model specifies one send plus V=2 receiver
   deliveries — a misread *against its own interest*, inflating its three
   dominant lines by roughly 50 %. Normalized to the demand model, the same
   model yields **≈$540 at S≈20 and ≈$8,400 at S=300**. The PRD keeps the
   higher briefed anchors as the planning figure; the normalized numbers are the
   audit's downward correction, not a contradiction.
2. The auth line is **$0 at every scale** because Avalon validates its own JWTs.
   The audit found that this is largely an architecture choice rather than
   platform fate — every candidate platform can validate first-party JWTs — but
   Convex was the only brief that priced it that way. Read the field's cost
   spread with that in mind: roughly two-thirds of the spread across candidates
   was assumption divergence, one-third genuine platform difference (fan-out
   metering and executor billing model).

Future-EU note: count roughly +35–40 % on the EU region's usage lines when that
build starts, combining the documented +30 % resource uplift with the loss of
the Pro included allowances.

---

## 5. Open questions feeding the PRD

Numbered for cross-reference. Gates (a), (b) and (c) are the PRD's Phase-0
gates; tripwires are the five consolidated in the adjudication's aggregate
verdict and restated in the PRD's Rollout section.

1. **Does subscription re-delivery after a revoking commit re-run the
   authorization code per frame, including cached results and reconnects?**
   (§3.1, challenge C1.) Resolution: **gate (b)** — a written vendor
   confirmation, in docs or contract. If it cannot be had and immediate
   revocation is required, the adjudication's decision function says GCP. If it
   cannot be had and bounded staleness ≤60 s is acceptable, the fallback stance
   costs $0 and changes no design.
2. **What is p95 commit→client push latency under our own load?** (§3.2.)
   Resolution: **gate (a)** — one week, S≈5, pass at ≤1 s sustained. Post-launch
   watch: tripwire 1.
3. **Does metered spend match the cost model?** (§3.3.) Resolution: **gate (a)**
   — read directly off the usage dashboard, pass within +50 % of the model.
   Post-launch watch: tripwire 2. A5's ±2× is resolved by this measurement or
   not at all.
4. **Does the kept agent-harness/Bind port run in the default Convex runtime?**
   (§2.1, §4.1, challenge C9.) Resolution: **gate (a)** — pass means no
   `"use node"`, keeping the 30-minute ceiling. Failing it is a Phase-0 blocker
   whose fallback is an external turn host, which changes the migration
   estimate and the technology count. Post-launch watch: tripwire 3 (≥3 model
   turns/week aborted at the ceiling).
5. **Is there a signable DPA with in-region processing commitments, and does
   the control plane process content outside the selected region?** (§3.6.)
   Resolution: **gate (c)** — DPA and subprocessor review before EU build
   kickoff. Post-launch watch: tripwire 4. Does not gate the Global launch.
6. **What happens to EU D1 content at cutover?** (§3.6, challenge C10.) The
   migration plan imports exported D1 in the singular and the EU region is
   deferred; the PRD must state explicitly whether EU rows exist today, and if
   so whether they are frozen, exported and held, or migrated later into an EU
   deployment. No answer is recorded anywhere in the adjudication record.
7. **What is the Singapore answer?** (§2.1.) Convex has no APAC region. The
   owner's three-region target therefore has no documented path on this
   platform today, and this is one of the two standing overrides that shift the
   answer to the runner-up regardless of the pilot. The PRD must record it as a
   named risk, not a footnote.
8. **What is the compaction and retention story for delta chunks at scale?**
   Seal copies chunks into one immutable part and tombstones the chunks; the
   16,000-documents-written and 16 MiB transaction limits bound how large a
   single seal batch can be. The PRD's design document must state the batch
   size and the retention window for tombstoned chunks.
9. **What per-principal budgets does the rate limiter enforce, and at what
   values?** (Gate patch 1.) The component is transactional and fails closed;
   the values — per user, per workspace, per connector — are a product decision
   the PRD must set, because at $2 per 1M function calls a hostile authenticated
   client is a cost exposure, not only an abuse one.
10. **Is any downtime involved in a deployment-class change?** Convex documents
    downtime for region migration (export/restore) and for restore itself; no
    compute-resize downtime is documented either way. UNKNOWN — ask before
    moving to a dedicated class.
11. **What is the warehouse on the other side of the Fivetran export, and who
    owns it?** SQL analytics is the stated mitigation for having no SQL, the
    export is beta and Pro-only, and the warehouse is one of the ≈5 honest
    technologies. The PRD should either name it or defer it explicitly.
12. **What is the backup drill cadence, and against which scratch deployment?**
    Restore is a destructive wipe, so drills cannot run against production. The
    working assumption is half a day per quarter against a scratch deployment
    plus a weekly `npx convex export` (assumption A11); the PRD's Rollout
    section should commit to numbers.

---

## 6. Bottom line

Convex maps every Avalon platform need onto a documented mechanism, and the two
mappings that matter most — one serializable transaction for the multi-row
write, one reactive subscription for the entire realtime layer — delete more
Avalon code than they add. That is why it won Simplicity, UX, Migration and
Cost across all three judge passes.

It also carries the field's weakest verification posture: last on
Maintainability (no SQL, no Terraform, dashboard-only backups), lowest on Risk,
and its three load-bearing assumptions — A5 metering, the push-latency bound,
the C1 revocation semantics — are exactly the ones no official page states.
Every challenge landed against the runner-up was a one-sentence fix; the
challenges landed here go to whether the central mechanism behaves as claimed.
That asymmetry is why the decision is a pilot rather than a commitment, and why
this document ends in twelve open questions rather than a recommendation.
