# Owner notes — cofounder call, 2026-08-15

Provided by the owner for the judgment round. **Judges: read the handling
rules before the notes.**

## Handling rules (operator)

- Lines tagged **[PRIOR]** are the founders' working opinions and leanings.
  The adjudication exists to test them. Do not cite a [PRIOR] as evidence for
  or against any candidate; if your verdict agrees with a prior, it must
  agree for reasons independently established in the briefs and challenges.
- Lines tagged **[INPUT]** are owner-provided facts, requirements, or context.
  Treat them as judgeable inputs alongside the decision frame. Where an
  [INPUT] extends the decision frame (a third region, self-hosting interest),
  score it under the existing criteria (scalability-as-credible-path, risk,
  cost) rather than inventing new criteria.
- Lines tagged **[OPERATOR]** are verification annotations added by the
  operator; where a note conflicts with a verified vendor fact, the
  annotation governs.

## The notes

### Architecture overview: Durable Objects model [context — describes the withdrawn cloudflare-do candidate]

- Each workspace and workstream is its own durable object (separate compute + storage)
- Workspace durable object holds metadata and handles fan-out notifications
  - Workstream detects mentions, sends RPC to workspace to save notifications
  - Workspace then routes to Slack, email, push, etc. per user settings
- External events (e.g. email webhooks) route via a global worker
  - Global worker queries D1 control plane for workstream ID mapping
  - Workstreams get unique email slugs (adjective-adjective-adjective-scientist format) registered at D1 level
- **[INPUT]** The notification fan-out path (mentions → per-user routing to
  Slack/email/push) and inbound email-slug routing are real product
  workloads any candidate inherits; briefs that did not model them may be
  asked about them in sensitivity.

### Key concerns with Durable Objects [PRIOR — the candidate is withdrawn; retained as context for why]

- Lazy migration risk: hibernated workstreams (e.g. 60 days dormant) may wake up needing 100+ migrations; no rollback; no documented failed-migration guidance at scale
- Performance: running 100 migrations on wake could mean minutes of latency
- Monitoring complexity across a large fleet
- D1 hard limit: 10 GB per database with no increase option; current shared D1 caps the platform
- No cross-object joins: continuous denormalization of workstream status to workspace
- Enterprise self-hosting: Cloudflare has no on-prem equivalent
- **[INPUT]** The last point generalizes: *enterprise self-hosting/on-prem is
  a live commercial interest.* Judges: score each fielded candidate's
  self-host/on-prem path under scalability-as-credible-path and risk
  (Supabase and Convex have open-source backends; AWS/GCP have
  outposts/on-prem stories of varying credibility — use the briefs and
  challenges, not this note, for specifics).

### Key concerns with Postgres (Supabase / Neon) [PRIOR unless tagged]

- Write volume: token streaming at 50–300+ tokens/sec per workstream creates extreme bursty write load; even batched at 30 writes/sec, significant at scale
  - **[INPUT]** The 50–300 tokens/sec provider rate is a real demand figure;
    note all fielded briefs batch to 2–4 visible updates/sec per the demand
    model, not 30 writes/sec.
- Real-time streaming: need a CDC mechanism (e.g. Supabase Realtime) to push tokens; needs validation at token-level throughput
- Agent loop runtime: deep research sessions can run 20–30 min; Supabase edge functions cap at ~5 min wall clock; may require a persistent server (Railway, EC2, etc.) regardless of DB choice
  - **[OPERATOR]** Verified figure is 400 s (~6.7 min) wall on paid Edge
    Functions. The fielded Supabase brief does not run loops on Edge
    Functions — it uses Cloudflare Workflows as the driver and fails EU
    closed; no fielded brief proposes a hand-rolled persistent server.
- Tenant isolation: column-based vs logical vs physical split; logical DB per workspace reduces migration fleet vs Durable Objects (10 customers = 10 migrations vs ~1,001)
  - **[OPERATOR]** No fielded brief proposes logical-DB-per-workspace; the
    Supabase brief proposes shared schema + RLS (one migration per region).
    The 10-vs-1,001 comparison describes options not in the field.
- Multi-region: need a migration strategy across US, EU, and SG instances (manageable, well-trodden path)
  - **[INPUT]** **SG (Singapore) is a planned third region.** The decision
    frame's demand model assumed two regions with EU deferred; judges should
    treat three-region topology as the credible-path target and weigh each
    candidate's per-region fixed floor accordingly.

### Four platform primitives to solve for [INPUT — matches the packet's constraints; use as a cross-check]

1. Streaming real-time websockets for token inference delivery
2. High-volume, bursty write traffic to the database during inference
3. Long-running agent loops (2 min to 30 min wall clock, low CPU)
4. Tenant and region isolation strategy

### Decision direction and next steps [PRIOR — all of it]

- Consensus: Durable Objects architecturally elegant but premature for a fast-iterating product; migration management service would consume engineering time with no customer value; Supabase ecosystem a strong all-in-one alternative; RLS handles tenancy without query discipline
- GCP ruled out: no equivalent primitive to Durable Objects
  - **[OPERATOR]** Recorded as a prior, not a field change: the owner
    explicitly seated GCP in today's field cut, which post-dates this call.
    The stated reason also predates the fielded GCP brief, which does not
    imitate Durable Objects. If the owner confirms the ruling stands, the
    seat will be withdrawn; until then GCP is judged normally.
- AWS: $25k in credits available; Lambda edge functions ruled out due to websocket and runtime constraints
  - **[INPUT]** The credits are a real, time-limited cost offset — judges may
    note them under cost as a first-year offset, never as a rate change.
  - **[OPERATOR]** The fielded AWS brief serves websockets via AppSync and
    loops via Lambda durable invocations (up to 1 year, citation-verified) —
    the "Lambda ruled out" concern targeted a shape the brief does not use;
    judge the brief's actual mechanisms.
- Zero / sync engines noted as potential Postgres streaming layer; needs deeper evaluation
  - **[INPUT]** Belongs on the verdict's future-watch list; not in this field.

Source: cofounder call 2026-08-15 (Granola transcript link held by owner).
