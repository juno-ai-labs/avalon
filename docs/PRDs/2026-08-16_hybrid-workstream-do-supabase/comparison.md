# Avalon work-stream architecture comparison

> Created 2026-08-16. This is a decision companion to three independently
> implementable PRDs: the
> [Cloudflare Durable Object hierarchy](../2026-08-15_durable-workspace-workstream-conversations/prd.md),
> the [Supabase authority design](../2026-08-15_supabase-workspace-workstream-conversations/prd.md),
> and the [hybrid WorkstreamDO and Supabase design](prd.md).
>
> The document is intentionally a glide path. Round 1 makes the decision at
> 30,000 feet. Each later round adds mechanism and failure detail without
> changing the decision criteria. Prices and limits are planning inputs, not
> vendor commitments; revalidate them before procurement and launch.

## How to read this comparison

The three designs implement the same Avalon product contract. They all support
workspace collections, common and user-specific sidebar state, connector
activity, suggestions, ordered LLM messages, substreams, compaction, queued and
steering input, 2–30 minute agent loops, rare 2+ hour coding sessions, Daytona
Terminal execution, regional isolation, and lossless switching between two
streaming work streams. They differ in where correctness lives and what must be
coordinated to provide that contract.

The options are abbreviated throughout:

- **CF hierarchy:** one regional <code>WorkspaceDO</code> per workspace and one
  regional <code>WorkstreamDO</code> per work stream. Cloudflare holds product
  authority.
- **Supabase authority:** one global Supabase control database and regional
  Supabase product shards. Regional Postgres holds product authority; no
  product Durable Objects exist.
- **Hybrid:** one <code>WorkstreamDO</code> per work stream, no
  <code>WorkspaceDO</code>, and global plus regional Supabase databases.
  WorkstreamDO owns the work-stream aggregate; Postgres owns everything else
  and receives an ordered work-stream projection.

The comparison distinguishes four kinds of statement:

- **Contract:** required product behavior shared by all three PRDs.
- **Platform fact:** a documented vendor property, price, or limit.
- **Model:** arithmetic under explicit workload assumptions.
- **Hypothesis:** a result that must be established by a production-shaped
  spike, load test, or vendor commitment.

## Round 1 — 30,000 feet: executive decision

### Executive summary

**Start with Supabase authority, but preserve a clean WorkstreamDO extraction
boundary.** At Avalon's stated near-term scale—tens to low hundreds of
simultaneously streaming work streams with small audiences—the Supabase design
has the lowest correctness and implementation risk. Conversation, sidebar,
membership, activity, and suggestions can change in one regional Postgres
transaction. Its expected token-checkpoint and Realtime load is material enough
to test, but not yet large enough to justify building a second authority,
projection protocol, cross-system revocation protocol, and dual restore plane.

Move to the hybrid only when measured evidence shows that direct work-stream
streaming, per-work-stream fault isolation, shared-primary contention, or
Realtime fanout is a binding product or operating constraint. The hybrid is the
best *specialized* fit: it gives the actor-like aggregate to the workload that
needs it and keeps relational workspace data relational. It is not the lowest
risk starting point.

Choose the CF hierarchy instead when Cloudflare-only operation, near-zero cost
for a very large dormant fleet, and per-object isolation are more important
than relational workspace queries and simple cross-aggregate transactions. It
has the fewest vendors but makes the workspace parent and its child projections
a permanent product-level protocol.

### One-line characterization

| Option | What it optimizes | What it makes expensive |
| --- | --- | --- |
| CF hierarchy | Isolation, dormant-fleet economics, direct sockets, one platform | Workspace-wide joins, parent projections, fleet migrations, support queries |
| Supabase authority | Relational correctness, queryability, familiar operations, fastest delivery | Shared-primary load, Realtime fanout, shard capacity, regional database floor |
| Hybrid | Direct streaming and per-stream serialization plus relational workspace data | Cross-system projection, revocation, restore, duplicate storage, two control planes |

### Recommendation by decision horizon

| Horizon | Recommendation | Reason |
| --- | --- | --- |
| Initial production | Supabase authority | One canonical regional transaction spans the product domains users see together |
| Architecture boundary | Keep work-stream command/materialization interfaces store-neutral | Makes later extraction measured rather than a rewrite of product semantics |
| Scale escalation | Hybrid, if its gates pass | Removes token transport from Supabase and isolates active work-stream authorities |
| Cloudflare-only mandate | CF hierarchy | Meets the mandate without pretending Postgres is present |

This is not a recommendation to build Supabase and a shadow DO system at the
same time. The initial implementation should have one authority. The extraction
boundary is an application interface, event vocabulary, invariant suite, and
load-test harness—not dual writes.

### Why Realtime price does not decide this

For the representative run—100 tokens/second, 10,000 tokens, 100 seconds,
500 ms durable checkpoints, and one viewer—the Supabase design emits about 200
Broadcast sends. Supabase counts a send and each recipient delivery, so that is
about 400 Realtime messages per run. At 100,000 such runs per month, the token
path produces about 40 million messages. With the current 5 million Pro/Team
quota and $2.50 per million overage, the modeled token Realtime overage is
approximately **$87.50/month**. [Supabase documents both the quota and rate.](https://supabase.com/docs/guides/realtime/pricing)

That is not nothing, but it is usually much smaller than model inference,
Daytona, engineering, and the Supabase compute/storage floor. The hybrid should
not be selected to save $87.50 while adding a distributed projection and
authorization boundary. Realtime becomes decision-relevant when active duty
cycle, viewer fanout, or rate limits grow: 100 continuously active streams with
one viewer would produce roughly 1.037 billion messages in 30 days at this
cadence, or about $2,580 of message overage after the quota.

### The dominant trade

The decision is fundamentally this:

> Is it safer for every work stream to share one regional transactional system,
> or safer for each work stream to have an isolated authority even though
> workspace behavior then crosses an asynchronous boundary?

For the launch workload, the first answer wins. At very high concurrency,
large audiences, or strict per-stream blast-radius requirements, the second can
win.

### Executive scorecard

Scores are comparative judgments, not benchmarks: 5 is strongest or simplest.

| Dimension | CF hierarchy | Supabase authority | Hybrid |
| --- | ---: | ---: | ---: |
| Initial delivery speed | 2 | **5** | 2 |
| Local transaction simplicity | 3 | **5** | 2 |
| Work-stream fault isolation | **5** | 2 | **5** |
| Workspace queryability | 2 | **5** | **5** |
| Direct stream/steer path | **5** | 3 | **5** |
| Dormant-fleet economics | **5** | 2 | 3 |
| Vendor and control-plane simplicity | **5** | 3 | 1 |
| Migration/restore simplicity | 2 | **4** | 1 |
| Clear path to very high active concurrency | 4 | 2 | **5** |
| Lowest likely engineering cost | 2 | **5** | 1 |

### When to override the recommendation

Choose **CF hierarchy now** if all are true:

- a Cloudflare-only platform is an explicit business or regulatory constraint;
- most workspaces and work streams are dormant most of the time;
- flexible workspace-wide SQL, ad hoc support queries, and analytics can remain
  derived systems;
- the team accepts parent-child projection and fleet migration protocols as
  core product infrastructure.

Choose **hybrid now** if any one requirement is non-negotiable and validated:

- a shared regional database may not be in the live token/control path;
- one pathological work stream must not consume another work stream's
  serialization or storage budget;
- direct, cursor-based WebSocket reconnect and steering must remain available
  when workspace Realtime is impaired;
- measured Supabase load, Realtime rate, or fanout is already beyond an
  economically supported shard envelope;
- the projector, authorization-revocation, dual-restore, and authority-transfer
  prototypes have all passed their failure gates.

Otherwise, choose **Supabase authority first**.

## Round 2 — 10,000 feet: system shape and product fit

### The three topologies

~~~mermaid
flowchart TB
  subgraph A["CF hierarchy"]
    ADesk["Desktop"] <--> AWS["WorkspaceDO"]
    ADesk <--> AStream["WorkstreamDO"]
    AStream -->|"monotonic projection"| AWS
    AStream <--> AWF["Workflow + Workers"]
    AWF --> AExt["LLM + Daytona"]
  end

  subgraph B["Supabase authority"]
    BDesk["Desktop"] <--> BRT["Supabase Realtime + RLS reads"]
    BRT <--> BPG["Regional Postgres authority"]
    BPG <--> BWF["Workflow + Workers"]
    BWF --> BExt["LLM + Daytona"]
  end

  subgraph C["Hybrid"]
    CDesk["Desktop"] <--> CDO["WorkstreamDO authority"]
    CDesk <--> CPG["Regional Postgres workspace authority"]
    CDO -->|"ordered CQRS projection"| CPG
    CDO <--> CWF["Workflow + Workers"]
    CWF --> CExt["LLM + Daytona"]
  end
~~~

All three use one Cloudflare Workflow for one complete agent loop and bounded
Workers for actual inference and tool steps. None runs Daytona commands inside
a Durable Object or Workflow runtime. Daytona remains the external Terminal
plugin provider.

### Where authority lives

| Product domain | CF hierarchy | Supabase authority | Hybrid |
| --- | --- | --- | --- |
| Global identity/routing | Thin global plane | Global Supabase | Global Supabase |
| Workspace and membership | WorkspaceDO | Regional Postgres | Regional Postgres |
| Connector ingress/activity | WorkspaceDO | Regional Postgres | Regional Postgres |
| Digests/suggestions | WorkspaceDO | Regional Postgres | Regional Postgres |
| User attention overlays | WorkspaceDO | Regional Postgres | Regional Postgres |
| Work-stream common metadata | WorkstreamDO; projected to WorkspaceDO | Regional Postgres | WorkstreamDO; projected to Postgres |
| Conversation/substreams | WorkstreamDO | Regional Postgres | WorkstreamDO |
| Compaction/run/effect fences | WorkstreamDO | Regional Postgres | WorkstreamDO |
| Sidebar query | WorkspaceDO materialization | Regional Postgres query/materialization | Regional Postgres over relational state plus DO projection |
| Token recovery cursor | WorkstreamDO | Regional Postgres event/checkpoint rows | WorkstreamDO |
| Search/vector indexes | Derived regional services | Regional Postgres/pgvector | Regional Postgres/pgvector over projections/resources |

The important distinction is not SQL versus SQLite. It is the boundary of one
atomic decision:

- CF hierarchy atomically decides one workspace command or one work-stream
  command, then coordinates between objects.
- Supabase atomically decides the work-stream change, sidebar change, durable
  event, and queue effect in one regional transaction.
- Hybrid atomically decides the work-stream change in the DO and later applies
  its ordered relational consequences in Postgres.

### Sidebar and “work streams of interest”

The sidebar combines common facts—title, description, state, last activity,
In Progress, Completed, Error—with user facts—unread past a seen waterline,
You Are Mentioned, assigned, pinned, and needs input.

| Question | CF hierarchy | Supabase authority | Hybrid |
| --- | --- | --- | --- |
| Where is common metadata born? | WorkstreamDO | Postgres | WorkstreamDO |
| Where is personal state born? | WorkspaceDO | Postgres | Postgres |
| How are they joined? | WorkspaceDO projection | SQL transaction/query | SQL query after ordered DO projection |
| Freshness | Asynchronous child projection | Transactionally current | Asynchronous DO projection |
| Dormant stream read | No child wake | Ordinary query | Ordinary query; no DO wake |
| Repair | Child-parent replay/reconciliation | Recompute/materialized-view repair | DO outbox replay/reconciliation |

Supabase is strongest when a user expects the conversation action and sidebar
card to appear atomically. The two DO-based designs instead guarantee monotonic
eventual sidebar state. They must expose synchronization or staleness when the
projection is behind rather than fabricate current state.

### Connector events, digests, and suggested work

Every connector event belongs to exactly one workspace. That makes it a
workspace product domain, not global telemetry.

- CF hierarchy accepts and deduplicates ingress in the owning WorkspaceDO,
  normalizes activity there, and stores digest/suggestion provenance there.
- Supabase accepts the event into the owning regional shard and uses a database
  transaction plus Queues/outbox work for normalization, digests, and
  suggestions.
- Hybrid does the same as Supabase. Only a user-approved action that creates or
  changes a work stream crosses into the WorkstreamDO; the resulting canonical
  event projects back.

For connector-heavy products, both Postgres designs are more natural because
workspace activity, resources, feedback, suggestions, and retention queries
are relational. The CF hierarchy avoids the always-on database but forces
indexes and scans to be designed around one WorkspaceDO's finite database and
serialized execution.

### Realtime user experience

All three meet the same visible contract:

- typical time to first token is 1–5 seconds;
- generated output appears continuously at a chosen 10, 20, or 30 visual frames
  per second;
- transport may carry larger deltas at a lower cadence, and the desktop
  animates from a cursor without inventing content;
- switching from streaming work stream A to B and back reconciles from a
  durable cursor with no gap or duplicate text;
- an acknowledged queued or steering message survives disconnect;
- steering fences late model and tool results before they become canonical.

The path differs:

| Option | Token transport | Durable recovery | Workspace/card transport |
| --- | --- | --- | --- |
| CF hierarchy | WorkstreamDO hibernatable WebSocket | DO SQLite cursor | WorkspaceDO hibernatable WebSocket |
| Supabase authority | Realtime body-free hint; RLS read by offset | Postgres checkpoints/events | Supabase Realtime hint; RLS read |
| Hybrid | WorkstreamDO hibernatable WebSocket | DO SQLite cursor | Supabase Realtime hint; RLS read |

Supabase's path is safe, but has more hops for each durable token delta. It must
never rely on ephemeral Broadcast as the content log. The DO paths can send the
delta directly from the authority and use the same cursor for reconnect.

### Product-scale isolation

| Failure boundary | CF hierarchy | Supabase authority | Hybrid |
| --- | --- | --- | --- |
| One work stream loops or grows pathologically | Mostly one WorkstreamDO | Shared regional DB resources | Mostly one WorkstreamDO plus projector load |
| One workspace has huge activity/sidebar load | One WorkspaceDO | Shared regional DB, query-governed | Shared regional DB, query-governed |
| Regional primary is impaired | Fleet/control functions only; product objects remain object-scoped | All regional product reads/writes impaired | Workspace/sidebar impaired; a bounded DO-only window may continue |
| Object namespace is impaired | Product authority impaired | Not applicable | Work-stream mutation impaired; projected workspace reads remain |
| Projection system is impaired | Sidebar freshness impaired | Not applicable | Sidebar/search freshness impaired; DO remains canonical within backlog bound |

### Organizational fit

The CF hierarchy asks the team to become excellent at object lifecycle,
idempotent object-to-object messages, per-object schema migrations, fleet
enumeration, and derived querying. Supabase authority asks the team to become
excellent at Postgres locks, indexes, RLS, queues, WAL/vacuum, connection pools,
regional project operations, and Realtime capacity. Hybrid asks for both skill
sets plus distributed-systems ownership at their seam.

That organizational cost is real. Hybrid should not be called “best of both”
without also saying “operations of both.”

## Round 3 — 5,000 feet: correctness, scale, and economics

### Command consistency

#### CF hierarchy

A work-stream mutation commits in WorkstreamDO. Its common metadata event goes
to WorkspaceDO through a durable outbox. WorkspaceDO applies monotonic child
versions and computes common and user-specific collections. A late or duplicate
projection cannot move state backward, but the conversation and sidebar cannot
commit atomically because they are different objects.

#### Supabase authority

A command locks the work-stream aggregate row, checks membership and expected
revision, appends ordered parts/events, updates common and personal sidebar
facts, and enqueues durable work in one transaction. This is the smallest
correctness surface. It also means every active work stream contends for shared
regional Postgres resources even though different work streams do not contend
on the same row lock.

#### Hybrid

A command commits in WorkstreamDO with an outbox event. A projector applies the
next contiguous authority epoch and sequence to Postgres using an idempotent
RPC. Postgres records the receipt and derived changes atomically. This preserves
one work-stream authority but creates an explicit “canonical now, relational
later” interval.

### Queueing, steering, and interruption

The semantic distinction is shared:

- **queued message:** durable input for the next eligible turn; it does not
  invalidate current work;
- **steering message:** durable input that increments the run/control revision,
  requests cancellation, and invalidates uncommitted work from the old revision.

The active provider stream cannot be made safe merely by sending a cancel
signal. Cancellation is advisory; the commit fence is authoritative.

| Step | CF hierarchy | Supabase authority | Hybrid |
| --- | --- | --- | --- |
| Accept user message | WorkstreamDO transaction | Postgres transaction | WorkstreamDO transaction |
| Increment control revision | Same DO transaction | Same DB transaction | Same DO transaction |
| Notify active executor | DO executor socket + Workflow wake | DB event/queue + Worker/Workflow channel | DO executor socket + Workflow wake |
| Abort network/model call | Worker best effort | Worker best effort | Worker best effort |
| Prevent late result | DO revision/effect fence | DB revision/effect fence | DO revision/effect fence |

The DO variants have the shortest live steering path because the participant,
canonical revision, and executor rendezvous share one object. Supabase has the
simplest durable transaction but needs a low-latency notification path from the
database transaction to the active Worker. All three still need a final
revision check immediately before an external side effect and before committing
its result.

### Long-running agent loops

All three use the same execution abstraction:

1. One Cloudflare Workflow represents one full loop, not one model turn.
2. It stores opaque IDs, cursors, hashes, revisions, budgets, and timing—not the
   growing transcript or terminal output.
3. Bounded Workers perform model calls, compaction, connector work, and tools.
4. Daytona executes Terminal commands under a stable provider operation ID.
5. Long tool, retry, timer, or user waits become Workflow waits/sleeps; active
   sockets close when they are unnecessary.

This supports ordinary 2–30 minute loops and rare 2+ hour coding sessions.
Cloudflare's paid limits currently document unlimited wall time per Workflow
step subject to CPU limits, 10,000 steps by default, 50,000 concurrently running
instances, and exclusion of waiting instances from concurrency. A full-loop
Workflow is therefore valid, provided CPU-heavy code remains bounded and the
design does not persist large output in Workflow state.
[The current paid limits are documented here.](https://developers.cloudflare.com/workflows/reference/limits/)

The authority difference appears at every durable checkpoint: DO in CF/hybrid,
Postgres in Supabase. The Workflow is never the conversation authority.

### Substreams and compaction

All options intentionally store ordered typed parts close to the arrays LLM
providers consume. A substream expresses an intentional conversation lineage
or audience branch. It is not a storage shard, UI tab, background job, agent
run, authorization boundary, or arbitrary grouping mechanism.

Compaction freezes a complete-turn prefix at an input sequence and policy,
materializer, authorization, resource, and lineage revision. Messages arriving
during compaction append after the fence and remain a raw tail. Publication
rechecks every fence; stale summaries are discarded.

The algorithm is equivalent across options. The DO designs gain natural
single-writer ordering. Supabase gains queryable lineage and can enforce the
same order with a short aggregate row lock and unique sequence constraints.
Neither primitive excuses an invalid provider projection such as placing a user
message between a tool call and its required result.

### Authorization and revocation

| Concern | CF hierarchy | Supabase authority | Hybrid |
| --- | --- | --- | --- |
| Membership authority | WorkspaceDO | Postgres | Postgres |
| Work-stream command check | Parent-issued capability/epoch | Live RLS or trusted RPC check | Short-lived Postgres-issued DO ticket/lease |
| Remove member from new requests | Parent epoch update | Transaction + RLS | Postgres epoch update before new tickets |
| Close existing content sockets | WorkspaceDO tells child registry; lease fallback | Realtime/channel revocation plus application socket handling | Postgres tells active DO registry; lease fallback |
| Main risk | Parent bottleneck or stale child capability | Already-joined channel semantics and policy cost | Cross-vendor notification loss and lease window |

Supabase authority keeps data authorization closest to data and is easiest to
audit with RLS plus trusted functions. CF hierarchy keeps the system on one
platform but still needs a parent-to-child capability and revocation protocol;
checking WorkspaceDO synchronously for every event defeats child independence.
Hybrid has the hardest revocation path: Postgres owns membership while the DO
holds content-bearing sockets. It must deny new tickets first and prove a hard
maximum lease interval for existing sockets.

### Regional data and enterprise constraints

All three retain a thin product-free global routing/identity plane and put
workspace product data in the assigned region. None silently fails over product
content to another region.

- CF hierarchy must create WorkspaceDO and all WorkstreamDOs with the required
  regional placement controls. D1 is not used as a hidden cross-region product
  copy.
- Supabase uses a global control project and separate regional product projects.
  A project is a coarse regional/capacity shard, not one logical database per
  workspace.
- Hybrid must align both the Supabase regional shard and WorkstreamDO placement.
  Projector and recovery traffic remain in-region.

Data residency does not by itself answer all EU/EE questions. Support access,
logs, subprocessors, connector endpoints, model providers, backups, deletion,
and global metadata fields require an explicit data map and legal validation
for every option. Hybrid has the largest map because product data exists in two
managed storage systems.

### Migration and restore

| Operation | CF hierarchy | Supabase authority | Hybrid |
| --- | --- | --- | --- |
| Add nullable field/table | Fleet-aware DO schema migration | Ordinary regional SQL migration | Both if work-stream projection changes |
| Transform one workspace | WorkspaceDO-controlled slices | SQL/queue backfill by workspace | Postgres backfill; DO changes may need fleet slices |
| Transform all work streams | Fleet migration control plane | Set-based/batched regional SQL jobs | DO fleet migration plus projection compatibility |
| Point-in-time restore | Per-object snapshots/replay plus control-plane repair | Managed DB restore plus effect reconciliation | Coordinated DO and Postgres closure/watermarks |
| Move authority | Fenced object/region transfer | Fenced shard transfer | Fenced epoch transfer and verified projection closure |
| Roll back code | Mixed-schema object compatibility | Expand/contract DB compatibility | Compatibility in DO, projector, and Postgres |

Supabase has the most familiar migration machinery and the largest correlated
restore unit. CF has the smallest state units and the most fleet orchestration.
Hybrid has two independently timed recovery systems; reopening writes before
their epochs and watermarks reconcile can resurrect or duplicate effects.

### Scale model: one representative inference

Assumptions:

- generation rate: 100 tokens/second;
- total output: 10,000 tokens;
- duration: 100 seconds;
- approximate text size: 40 KiB at four bytes/token;
- observed durable checkpoint: 500 ms;
- one participant viewer;
- transport/presentation: no more than 10 Hz platform frames and local
  10/20/30 fps animation.

| Work during one run | CF hierarchy | Supabase authority | Hybrid |
| --- | ---: | ---: | ---: |
| Canonical output checkpoints | ≤200 DO transactions | ≤200 Postgres transactions | ≤200 DO transactions |
| Token transport messages | Direct DO outgoing frames | 200 Broadcast sends + 200 deliveries | Direct DO outgoing frames |
| Relational provisional writes | None | ≤200 | ≤100 at 1 Hz; 20–50 unobserved |
| Reconnect content reads | DO cursor/delta | RLS checkpoint/event reads | DO cursor/delta |
| Duplicate stored conversation | Derived indexes only | No | Yes: DO canonical + PG projection |

No option writes one row per token or one database transaction per visual frame.
The 10/20/30 fps requirement belongs in the desktop renderer. Platform deltas
include an offset and may contain multiple tokens; the renderer calculates the
new suffix and animates it without changing the canonical cursor.

### Concurrent-stream formulas

Let:

- <code>A</code> = concurrently observed streams;
- <code>V</code> = average token-channel recipients per stream;
- <code>C</code> = durable checkpoints per second, launch value 2;
- <code>P</code> = hybrid Postgres projections per second, launch value 1.

Then the planning model is:

- Supabase canonical checkpoint transactions/second ≈ <code>A × C</code>;
- Supabase token Realtime messages/second ≈ <code>A × C × (1 + V)</code>;
- hybrid DO checkpoint transactions/second ≈ <code>A × C</code>, distributed
  across objects;
- hybrid provisional Postgres row operations/second ≈ <code>A × P</code> before
  cross-stream projector batching;
- CF hierarchy has the same distributed DO checkpoint rate plus lower-rate
  child-to-parent semantic projections.

At <code>A=100</code>, <code>V=1</code>, <code>C=2</code>:

- Supabase: about 200 canonical checkpoint transactions/s and 400 Realtime
  messages/s;
- hybrid: about 200 distributed DO checkpoint transactions/s, up to 100
  provisional Postgres row operations/s, and zero Supabase token messages;
- CF hierarchy: about 200 distributed DO checkpoint transactions/s and no
  Supabase product path.

At <code>A=1,000</code>, the same Supabase path models 2,000 transactions/s and
4,000 Realtime messages/s. Supabase currently documents 2,500 messages/s for
Pro without a spend cap and Team, with higher configurable limits. That does not
prove the database can sustain the write/read path, and 4,000 exceeds the
default Realtime limit. [Current limits are listed by plan.](https://supabase.com/docs/guides/realtime/limits)

### Economic comparison

#### Cost shape

| Cost driver | CF hierarchy | Supabase authority | Hybrid |
| --- | --- | --- | --- |
| Dormant workspace/work stream | Minimal object storage; no duration | Allocated regional project/compute floor | Supabase floor plus DO storage |
| Active stream authority | DO active duration, requests, SQLite rows | Postgres compute/IO/WAL/vacuum | Both DO activity and PG projection |
| Token fanout | Outgoing DO WS messages not request-billed | Realtime send + every delivery | Outgoing DO WS messages not request-billed |
| Workspace query | Custom materialization/derived export | Native SQL/index cost | Native SQL/index cost over projections |
| Product storage | DO SQLite plus external large bytes | Postgres/Storage | Duplicate work-stream text + Postgres/Storage |
| Operations | CF fleet/control plane | Supabase projects + CF compute | Both plus cross-system seam |

Cloudflare currently includes 1 million DO requests and 400,000 GB-s monthly,
then lists $0.15/million requests and $12.50/million GB-s. Incoming WebSocket
messages use a 20:1 billing ratio; outgoing WebSocket messages are not charged
as requests. SQLite rows written are the more important storage meter: 50
million/month included and $1/million thereafter. Hibernation removes idle
duration but does not make active streaming free.
[Cloudflare's current table and accounting notes are here.](https://developers.cloudflare.com/durable-objects/platform/pricing/)

Supabase currently charges $2.50/million Realtime messages above 5 million on
Pro/Team and $10 per 1,000 peak connections above 500. Database compute,
storage, IOPS, egress, PITR, log drains, and Auth are separate dimensions.
[Supabase's current Realtime pricing is here.](https://supabase.com/docs/guides/realtime/pricing)

#### Directional monthly result

The existing workload model in the source PRDs is not precise enough to produce
a trustworthy single hybrid total. A normalized scenario is still useful as
long as it is kept illustrative rather than presented as an Avalon forecast.

The scenario assumes two XL regional Supabase shards plus one Micro global
project, 250,000 monthly active users, 5,000 peak Realtime connections, one
million stored work streams, 100,000 full loops, 500 GB of product data, 2 TB of
file/object storage and uncached egress, 50 million Realtime messages in the
Supabase design, PITR and one log drain in each product region, 100 million
Worker requests, four million Workflow steps, and the representative streaming
profile. The CF case uses 500 GB of DO SQLite product data plus R2/Vectorize and
product-free D1. These inputs deliberately stress the different meters.

| Illustrative monthly subtotal | Approximate amount | Important caveat |
| --- | ---: | --- |
| CF hierarchy | $414 | Excludes Avalon's existing identity-provider cost and enterprise/support terms |
| Supabase authority | $1,750 | Includes $487.50 of Auth MAU overage and $112.50 of Realtime message overage |
| Hybrid | $1,711–$1,895 | Keeps the Supabase floor and third-party MAU, removes about $100 of token Realtime overage, then adds an estimated 25–100% of the CF scenario's DO request/duration/write/storage lines |

The hybrid interval is deliberately broad. The lower end assumes only one
quarter of the CF scenario's DO data-plane meters belong to WorkstreamDO; the
upper end uses all of them. It assumes no reduction in Supabase compute size.
The actual fraction depends on how much of the 500 GB corpus is conversation,
how many writes in the CF hierarchy belonged to WorkspaceDO, observed active
duration, retention, and whether the remaining relational workload permits a
smaller regional primary.

The absolute comparison is not apples-to-apples on identity: CF excludes the
current Avalon identity-provider bill, Supabase authority uses Supabase Auth,
and hybrid pays Supabase third-party-auth usage while retaining Avalon's issuer.
At current public pricing, both Supabase MAU categories include 100,000 on
Pro/Team and charge $0.00325 for each additional MAU; 250,000 MAU therefore
models $487.50 before the external issuer's own hybrid cost.
[Supabase documents third-party MAU accounting here.](https://supabase.com/docs/guides/platform/manage-your-usage/monthly-active-users-third-party)

Directionally:

- CF hierarchy usually has the lowest infrastructure floor for a large dormant
  fleet, but can have the highest bespoke-platform engineering cost.
- Supabase authority usually has the lowest engineering cost and a higher fixed
  regional database floor. At the representative 100,000-run token workload,
  removing token Realtime saves only about $87.50/month.
- Hybrid retains the global and regional Supabase databases, adds canonical DO
  storage and activity, and duplicates work-stream content. It may permit a
  smaller Supabase compute tier, but that is a hypothesis until load tests prove
  the token path—not connectors, search, sidebar, or background agents—sets the
  tier. Hybrid is therefore expected to have the highest direct platform bill
  at modest scale and the best marginal isolation at high active scale.

Engineering and incident costs dominate the decision at launch. A two-store
authority boundary needs continuous reconciliation, on-call playbooks, and
dual-system restore tests. Those are not free merely because request rates are
cheap.

### Risk register

| Risk | CF hierarchy | Supabase authority | Hybrid |
| --- | ---: | ---: | ---: |
| Workspace parent hotspot/size | High | Low | Low |
| Shared regional primary saturation | Low | High | Medium |
| Child/projection lag affects sidebar | High | None | High |
| Cross-system authorization race | Low/medium | Low | High |
| Flexible product/support query gap | High | Low | Low |
| Realtime pricing/rate exposure | Low | High | Low for tokens; medium for workspace events |
| Fleet schema migration complexity | High | Low | High for DO-owned schema |
| Restore coordination | Medium | Medium | High |
| Duplicate authority/split-brain if misimplemented | Medium | Low | High |
| Vendor concentration | High | Medium | Low concentration, high integration complexity |

### Trigger metrics for Supabase-to-hybrid extraction

Do not trigger on intuition. Trigger an architecture review when any sustained
condition occurs:

- token-path Postgres CPU, WAL, disk, lock, vacuum, or pool use consumes more
  than 30% of the tested shard safety envelope;
- projected peak token Realtime rate exceeds 60% of the contracted per-project
  limit after viewer fanout;
- streaming requires a Supabase compute or Realtime tier whose incremental cost
  exceeds the measured hybrid DO plus projection cost by at least the annualized
  cost of building and operating the seam;
- one work stream can materially impair unrelated work streams despite quotas
  and workload isolation;
- p95 steering-to-fence latency or reconnect catch-up misses the product SLO;
- an enterprise contract requires work-stream isolation that the shared primary
  cannot demonstrate.

Extraction is allowed only after the Round 4 hybrid gates pass.

## Round 4 — 1,000 feet: technical details and decision gates

### Detailed command paths

#### Create a user message while idle

**CF hierarchy**

1. The regional gateway authenticates and resolves WorkspaceDO/WorkstreamDO.
2. WorkstreamDO validates a short-lived workspace capability and expected
   authority/control revision.
3. One SQLite transaction appends the user part, updates turn/control state,
   creates an idempotent run intent, and appends outbox/common-metadata events.
4. The object acknowledges only after commit and starts/wakes the full-loop
   Workflow by stable ID.
5. The outbox projects title/state/last-active changes to WorkspaceDO.
6. WorkspaceDO updates common and affected personal collections, advances its
   workspace event cursor, and wakes sidebar clients.

**Supabase authority**

1. The regional Worker authenticates; a trusted RPC or RLS-bound transaction
   resolves live membership.
2. The transaction locks the work-stream aggregate row.
3. It checks expected revision, allocates sequence, appends the user part,
   updates run and sidebar projections, appends durable workspace events, and
   sends/enqueues the run intent through the transactional outbox/Queue.
4. It commits and acknowledges.
5. Realtime emits body-free hints; clients fetch durable changes through RLS.
6. A Worker starts/wakes the full-loop Workflow by stable ID.

**Hybrid**

1. The regional Worker authenticates against Supabase membership and issues a
   short-lived content capability containing workspace/work-stream ID,
   authorization epoch, audience, and expiry.
2. WorkstreamDO verifies the capability, current cached epoch/lease, and
   expected authority/control revision.
3. One SQLite transaction appends the user part, updates run state, and appends
   canonical outbox events.
4. The object acknowledges and starts/wakes the Workflow.
5. The projector sends the next contiguous event batch to a regional Postgres
   RPC. Postgres records receipts and updates directory/sidebar rows atomically.
6. Supabase Realtime hints wake sidebar/query clients; the work-stream client is
   already current from the DO cursor.

#### Stream one model turn

Shared execution steps:

1. Workflow claims the next operation using expected run/control revision.
2. A Worker loads the provider-valid message projection from the canonical
   authority.
3. It starts the model request and measures time to first token.
4. It batches nonempty provider bytes. Transport batches are not semantic
   messages and not one database row per token.
5. The authority checks run/control revision before accepting each checkpoint.
6. A final transaction seals the immutable assistant part, effects, usage,
   finish reason, and next loop state.

Authority-specific streaming:

| Detail | CF hierarchy | Supabase authority | Hybrid |
| --- | --- | --- | --- |
| Worker-to-authority | Executor WS/RPC to WorkstreamDO | Regional RPC to Postgres | Executor WS/RPC to WorkstreamDO |
| Provisional text | Bounded mutable SQLite chunk | Bounded mutable Postgres chunk | Bounded mutable SQLite chunk |
| Durable cadence | 500 ms observed | 500 ms observed | 500 ms observed |
| Participant hint | DO pushes cursor/delta | Transactional outbox/Broadcast hint | DO pushes cursor/delta |
| Workspace projection | Semantic/final events to WorkspaceDO | Same transaction | 1 s observed or 2–5 s unobserved to PG |
| Final immutable part | DO SQLite | Postgres | DO SQLite, then prompt PG projection |

#### Switch A → B → A while both stream

Every transport message contains <code>stream_id</code>, authority epoch,
run/control revision, durable offset, and payload/hash information. The desktop
stores a per-work-stream durable and presented cursor.

1. On leaving A, the desktop records A's highest validated durable offset. It
   may keep A subscribed briefly or close it; hidden visual animation stops.
2. It opens/subscribes to B using B's cursor, fetches any durable gap, validates
   contiguous offsets, then presents live deltas.
3. A continues durably even without a foreground observer. Its checkpoint
   policy may relax after the observation lease expires.
4. On returning to A, the client supplies its last durable offset.
5. The authority returns a snapshot plus suffix or contiguous events after that
   offset. Live transport is not applied until the gap is closed.
6. Duplicate offsets are ignored; conflicting hashes fail closed; a missing
   event forces snapshot reconciliation.

For CF/hybrid, the cursor protocol terminates at WorkstreamDO. For Supabase,
Realtime is only a wake-up hint and the client closes the gap through an RLS
query. All three are lossless if and only if the durable log/checkpoint commits
before its visible cursor is advertised.

#### Steer during active inference or a tool

1. Commit the steering message and increment control revision.
2. Mark the current operation cancellation-requested.
3. Notify the executor/Workflow; do not wait for cancellation to declare the
   revision stale.
4. Before any tool side effect, the Worker reacquires a short effect lease and
   rechecks the control revision at the canonical authority.
5. External effects use a scoped operation ID derived from run, turn, tool-call
   position, and attempt semantics—not a global hash of tool and input.
6. A late model delta, tool result, or terminal result bearing the old revision
   is rejected from the canonical transcript.
7. If the external side effect may have happened but its receipt is unknown,
   the run enters a visible reconciliation state rather than retrying blindly.

### Storage ownership and schema burden

This table groups the fully specified tables in each PRD by responsibility; the
source PRDs remain normative for every column, index, bound, and invariant.

| Responsibility | CF hierarchy | Supabase authority | Hybrid |
| --- | --- | --- | --- |
| Workspace identity/membership | WorkspaceDO SQLite | Regional PG canonical | Regional PG canonical |
| Connector/activity/digest/suggestion | WorkspaceDO SQLite | Regional PG canonical | Regional PG canonical |
| Work-stream directory | WorkspaceDO common projection | Regional PG canonical | Regional PG directory + read model |
| Personal attention/sidebar | WorkspaceDO SQLite | Regional PG canonical | Regional PG canonical |
| Parts/substreams/compactions | WorkstreamDO SQLite | Regional PG canonical | WorkstreamDO SQLite + PG projection |
| Runs/turns/tool effects | WorkstreamDO SQLite | Regional PG canonical | WorkstreamDO SQLite + PG projection |
| Active output/checkpoints | WorkstreamDO SQLite | Regional PG canonical | WorkstreamDO SQLite + coalesced PG projection |
| Durable events/outbox | Both DOs | Regional PG | DO canonical outbox + PG event/receipt |
| Generic non-workstream loops | Appropriate control DO/Workflow records | Regional PG | Regional PG |
| Files/resources/vector/FTS | External bytes + derived indexes | Storage + PG/pgvector/FTS | Storage + PG/pgvector/FTS |
| Migration fleet state | Global/regional migration DOs + product-free D1 index | Global/regional PG migration tables/jobs | PG migrations plus DO fleet/authority-transfer state |

#### Cross-boundary invariants

**CF child → parent projection**

- Key: <code>(workspace_id, workstream_id, child_version)</code>.
- WorkspaceDO applies only versions after its stored child watermark.
- Events are patches with per-field or event-level order; a later partial patch
  cannot cause an earlier unrelated field update to be discarded.
- WorkstreamDO retains an outbox until parent receipt.
- WorkspaceDO can request replay/snapshot on a gap and marks the card
  synchronizing when its freshness SLO is exceeded.

**Hybrid DO → Postgres projection**

- Key: <code>(workstream_id, authority_epoch, sequence)</code>, plus operation ID
  and payload hash.
- The Postgres RPC applies only the next contiguous prefix.
- Event receipt, relational projection, sidebar consequence, and workspace
  event commit in one transaction.
- Duplicate key with the same hash returns the prior receipt; a different hash
  quarantines the stream.
- The DO deletes/compacts outbox rows only after a durable receipt and snapshot
  closure.
- Backpressure slows provisional projections before final or authorization
  events and eventually pauses new runs; it never silently drops canonical
  events.

**Supabase internal outbox**

- Domain row changes, durable event, and outbox/Queue intent share one Postgres
  transaction.
- Consumers claim with visibility timeout, use stable operation IDs, and record
  effect receipts.
- Realtime is not the outbox and not replay authority.

### Sidebar update protocols

#### Common metadata

Common fields include title, description, state, last-active time, completion,
error, and progress summary.

- In CF, WorkstreamDO emits an ordered metadata event to WorkspaceDO.
- In Supabase, the command transaction changes common metadata and the sidebar
  event together.
- In hybrid, WorkstreamDO emits an ordered event; Postgres applies it and emits
  a workspace invalidation.

State precedence and terminal transitions must be explicit. A delayed
<code>active</code> update cannot overwrite <code>completed</code> from a later
version. Last-active time is monotonic by canonical sequence, not wall-clock
arrival.

#### User-specific metadata

Unread, seen waterlines, mention acknowledgement, pinning, assignment, and needs
input are not copied blindly from WorkstreamDO. The canonical common event names
its audience/mentions; the workspace authority joins that fact with membership
and each user's personal waterlines.

- CF computes this inside WorkspaceDO.
- Supabase computes it in the same regional transaction or deterministic
  projector.
- Hybrid computes it in Postgres when the canonical DO event is projected.

Mark-seen is always canonical at the workspace authority and uses a maximum
waterline. A stale device cannot move the seen cursor backward.

### Connector and suggestion protocol

1. The regional ingress endpoint authenticates the connector, resolves exactly
   one owning workspace, enforces region, and derives an idempotency key.
2. It commits the immutable raw event, normalized activity intent, audit record,
   and outbox item in the workspace authority.
3. Bounded Workers normalize content, resolve resources, and append provenance.
4. Digest and suggestion jobs read only events through a durable watermark and
   record source event IDs, model/config version, audience, expiry, and feedback.
5. A suggested work stream is not canonical conversation until a user accepts
   it. Acceptance creates the work stream in its proper authority through a
   stable cross-boundary operation ID.
6. Retry returns the prior creation receipt. It cannot create two work streams.

In CF, steps 2–4 use WorkspaceDO and its outbox. In Supabase/hybrid, they use
regional Postgres and Supabase Queues consumed by Cloudflare Workers.

### Detailed token write model

For the representative 100-second run:

| Clock | Purpose | Must be durable? | Recommended launch value |
| --- | --- | --- | ---: |
| Provider token | Native source cadence | No, individually | Up to ~100 tokens/s |
| Worker transport batch | Bound calls/frames | No, until authority ack | Up to 10 Hz, nonempty only |
| Canonical checkpoint | Recover text and cursor | Yes | 2 Hz observed; adaptive lower unobserved |
| Hybrid relational projection | Sidebar/search/recovery read model | Eventually | 1 Hz observed; 0.2–0.5 Hz unobserved |
| Desktop animation | Human-smooth presentation | No | 10/20/30 fps |

The open chunk is bounded—for example 32–64 KiB—and updated by expected offset.
When full or finalized, it becomes immutable. Durable checkpoints include
<code>from_offset</code>, <code>to_offset</code>, delta bytes, rolling hash,
run/control revision, and commit sequence. A cursor is never announced before
the bytes it names are durable.

At 100 concurrent observed streams, Supabase authority produces roughly 200
small transactions/s and 400 token Realtime messages/s with one viewer. That is
plausible, not proven. The load test must include RLS, reads after hints, WAL,
indexes, vacuum, pool behavior, workspace semantic events, connector load,
search, and generic agent loops—not an isolated unindexed UPDATE benchmark.

Hybrid reduces the relational provisional rate to roughly 100 row operations/s
at a 1-second projection cadence but does not necessarily halve database cost:
the projector still writes WAL, indexes receipts, advances watermarks, and later
seals immutable rows. Its win is removal from the live token/fanout path and
distribution of canonical serialization, not elimination of work.

### Realtime authorization detail

#### Supabase authority

- The global Supabase project uses Supabase-managed <code>auth.users</code> as
  the credential identity store and maps it to Avalon's stable platform
  identity.
- Regional access uses a shard-local identity/session mapping; global identity
  alone never grants workspace content.
- RLS derives identity from verified claims and joins live regional membership;
  clients never hold a service role.
- Broadcast topics are private and body-free. The durable content is fetched
  through RLS by workspace/work-stream cursor.
- Revocation tests include already-joined channels, refreshed/expired JWTs,
  background clients, and pooled sessions.

#### CF hierarchy

- WorkspaceDO is membership authority and issues short-lived child capabilities
  with authorization epoch and audience.
- WorkstreamDO validates locally during the lease and registers active
  content-bearing sockets.
- Removal increments the parent epoch, denies new capabilities, and sends
  revocation to active children. Lease expiry is the hard fallback.

#### Hybrid

- Avalon remains the authentication issuer. Supabase accepts its qualifying
  asymmetric OIDC JWT through supported third-party authentication (or the
  reviewed imported-key path), then maps the stable subject to platform
  identity. The exact integration is a launch gate.
- Postgres is membership authority and issues short-lived WorkstreamDO tickets.
- A regional active-object registry routes revocation after the membership
  transaction denies new tickets.
- WorkstreamDO closes matching sockets and invalidates cached capabilities.
- The hard bound is ticket/lease expiry even when notification is lost.
- Launch is blocked until measured removal-to-close latency and the maximum
  stale-content window satisfy enterprise policy.

### Failure matrix

| Failure | CF hierarchy | Supabase authority | Hybrid |
| --- | --- | --- | --- |
| Client misses live token frames | Reconcile from DO cursor | Query durable PG gap | Reconcile from DO cursor |
| Authority commits, response lost | Retry command ID at DO | Retry idempotency key/RPC | Retry command ID at DO |
| Executor disconnects | DO fences old revision; Workflow reconciles | PG fences old revision; Workflow reconciles | DO fences old revision; Workflow reconciles |
| Sidebar notification lost | Workspace event cursor catch-up | Workspace event cursor catch-up | Workspace event cursor catch-up |
| Child/projector duplicate | Version/hash receipt | Same transaction/idempotency receipt | Sequence/hash receipt |
| Child/projector gap | Parent requests replay | Not applicable inside one transaction | PG rejects and requests missing sequence |
| Workspace store unavailable | Workspace features fail; child backlog bounded | Regional product fails closed | PG features fail; DO backlog bounded then new runs pause |
| Work-stream store unavailable | One/fleet objects fail closed | Regional product fails closed | Affected DO fails; projected read remains visibly stale |
| Compaction finishes late | Fence rejects stale summary | Fence rejects stale summary | Fence rejects stale summary |
| Membership revoke notice lost | Capability lease expires | RLS blocks durable reads; channel policy tested | Ticket lease expires |
| Postgres PITR restores backward | Product-free index reconciliation | External-effect and queue reconciliation | Projection/epoch reconciliation before DO admission |
| DO restore/snapshot behind | Authority-transfer closure decides | Not applicable | PG watermark cannot silently become authority |
| Unknown Daytona side effect | Visible reconcile state; operation lookup | Same | Same |

### Schema evolution and fleet control

#### CF hierarchy

Use platform class migrations for namespace/class changes and application-level
SQLite <code>schema_version</code> migrations for tables. A global and regional
migration control plane enumerates object directories, leases bounded slices,
records before/after versions and hashes, pauses safely, and supports lazy
migration on object activation. Easy additive changes remain compatible with
old code; transformations are resumable per object.

#### Supabase authority

Use checked-in expand/contract SQL migrations across global and regional
projects. Backfills run by workspace/range through Queues/Cron/Workers with
watermarks and idempotent receipts. Avoid long blocking DDL and validate RLS,
grants, indexes, replication/Realtime behavior, and rollback compatibility on a
production-shaped branch/staging project.

#### Hybrid

Both procedures exist. Event envelopes and projector readers must be N/N-1
compatible so DO and Postgres deploys do not require an atomic release. A
transformation that changes canonical work-stream meaning requires:

1. deploy tolerant projector and Postgres schema;
2. deploy tolerant DO code;
3. migrate DO fleet in bounded slices while projecting versioned events;
4. verify projection closure/hash by authority epoch;
5. backfill/rebuild relational derived data;
6. retire old readers only after fleet and projection coverage are complete.

### Restore and authority transfer

Hybrid and CF relocation require a fenced protocol, not “copy then switch”:

1. stop new mutations at a recorded authority/control revision;
2. let in-flight effects reach known receipt or visible unknown state;
3. close the canonical sequence and hash;
4. verify snapshot/projection through that exact closure;
5. increment authority epoch in the routing authority;
6. activate exactly one new authority from the verified state;
7. reject every command or event bearing the old epoch;
8. retain audit evidence until the rollback window closes.

For hybrid, a Postgres projection is not silently promoted because a DO is
unavailable. Promotion is an explicit authority transfer. For Supabase, shard
restore must likewise reconcile Queues, outboxes, Workflow cursors, and external
effect receipts before admission reopens.

### Performance and cost bake-off

All three prototypes must run the same trace and failure corpus. Required load
points are 10, 50, 100, 300, and 1,000 concurrent observed streams, with viewer
fanout 1, 3, and 10, plus connector and generic-agent background load.

Measure:

- p50/p95/p99 time to first token and token visible latency;
- steering commit, executor notification, cancellation, and stale-result fence;
- cursor reconnect and A→B→A switch catch-up time;
- canonical checkpoint latency and lost/duplicate/conflicting offset count;
- sidebar common/personal freshness and projection gap repair;
- CPU, duration, request, row-write, storage, WAL, IOPS, vacuum, connections,
  egress, Realtime messages/connections, Queue lag, and Workflow slots;
- failure blast radius when one work stream, one workspace, a regional primary,
  Realtime, projector, or DO namespace is impaired;
- restore point objective, restore time, and authority/effect reconciliation;
- on-call actions and time-to-diagnosis for every injected failure.

The benchmark corpus includes:

- 100 tokens/s for 10,000 tokens with 500 ms checkpoints;
- 1–5 second first-token delay;
- ordinary tools lasting seconds;
- Daytona commands with p95 below one minute and 3–5 minute/tail cases;
- 2–30 minute loops and a synthetic 2+ hour coding loop;
- messages during inference, tools, waits, compaction, reconnect, and migration;
- two simultaneous streams switched repeatedly under packet loss;
- membership removal during a live stream;
- projector/Realtime/queue duplicates, gaps, reordering, and ambiguous timeout;
- a connector burst that creates digest and suggestion work in the same
  workspace as active inference.

### Architecture-specific launch gates

#### CF hierarchy gates

- WorkspaceDO remains within CPU, storage, row, socket, and queue bounds for the
  largest modeled workspace.
- Child projection is gap-safe, field-safe, monotonic, and repairable.
- Membership removal reaches active child sockets within the policy bound.
- Fleet migration can pause/resume without beginning new slices after the pause
  linearization point.
- Workspace-wide support/search/export requirements have an owned query path.

#### Supabase authority gates

- The production-shaped shard sustains the target checkpoint, RLS-read,
  connector, search, and background-agent mix with at least 40% headroom.
- Realtime rate and connections remain below 60% of contracted limits at target
  fanout, or higher limits are contractually secured.
- An already-joined client loses content access within the policy bound after
  membership removal.
- Queues, outbox, Workflow, and external-effect reconciliation pass PITR tests.
- A→B→A switch and reconnect never rely on Realtime replay for authority.

#### Hybrid gates

- The projector proves contiguous application, idempotent duplicate receipt,
  gap repair, hash-conflict quarantine, and bounded backlog.
- Common and personal sidebar freshness meet SLO under projector loss/recovery.
- Postgres-issued ticket revocation closes active DO sockets within the hard
  bound even when notification is lost.
- Coordinated DO/Postgres restore and authority transfer pass destructive
  failure injection without split-brain.
- The measured isolation/latency/capacity improvement is large enough to pay for
  the duplicated storage, platform bill, engineering, and on-call burden.

### Final decision matrix

Use this matrix after the bake-off; do not average the rows. A single failed
non-negotiable gate rejects an option.

| If the measured result is… | Choose… |
| --- | --- |
| Supabase meets load, Realtime, revocation, and restore gates with ≥40% headroom | Supabase authority |
| Supabase misses only token-path/fanout/isolation gates, and hybrid passes every seam gate | Hybrid |
| Cloudflare-only is mandatory and CF parent/fleet/query gates pass | CF hierarchy |
| Hybrid improves cost but not correctness/latency/isolation enough to cover its seam | Supabase authority |
| Supabase requires aggressive sharding but hybrid projector still saturates the same primary | Neither as specified; redesign the relational workload/shard model |
| CF WorkspaceDO is a hotspot and hybrid revocation/projection pass | Hybrid |
| No design passes revocation or external-effect reconciliation | Do not launch; fix the shared contract first |

### Final recommendation

The current evidence favors **Supabase authority for the first production
implementation**. It expresses Avalon's workspace-visible invariants with the
fewest asynchronous boundaries, handles connector/activity/suggestion data in
its natural relational home, and is plausibly within the stated tens-to-low-
hundreds streaming envelope. The Realtime token bill in the representative
workload is too small to justify the hybrid by itself.

The **hybrid is the planned scale and isolation option**, not an automatic
second phase. Extract WorkstreamDO only after measurements show the shared
token/control path is a binding constraint and after projection, revocation,
and dual-restore gates pass. Its architectural value is direct authority-backed
streaming and per-work-stream isolation, not merely cheaper WebSockets.

The **CF hierarchy remains a coherent alternative** for a Cloudflare-only,
dormant-heavy product. It should be chosen deliberately with acceptance that
the WorkspaceDO projection, query, and fleet-migration systems become first-
class permanent infrastructure.

## Source and assumption ledger

### Normative product sources

- [Cloudflare Durable Object hierarchy PRD](../2026-08-15_durable-workspace-workstream-conversations/prd.md)
- [Supabase authority PRD](../2026-08-15_supabase-workspace-workstream-conversations/prd.md)
- [Hybrid WorkstreamDO and Supabase PRD](prd.md)

### Current platform facts used

- [Cloudflare Durable Object pricing and WebSocket accounting](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Workflow paid limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Cloudflare SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Durable Object data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Supabase Realtime pricing](https://supabase.com/docs/guides/realtime/pricing)
- [Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits)
- [Supabase Realtime message accounting](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase JWT integration](https://supabase.com/docs/guides/auth/jwts)
- [Supabase third-party authentication](https://supabase.com/docs/guides/auth/third-party/overview)
- [Supabase Queues](https://supabase.com/docs/guides/queues)
- [Supabase compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk)

### Explicit planning assumptions

- Supabase token durability and hints run at 2 Hz for an observed stream.
- Hybrid relational provisional projection runs at 1 Hz observed and 0.2–0.5
  Hz unobserved.
- WorkstreamDO checkpoint durability runs at 2 Hz while observed.
- The desktop may animate durable deltas at 10, 20, or 30 fps.
- A planning token averages four bytes; actual UTF-8 and provider output vary.
- A Realtime Broadcast send and each recipient delivery count as messages.
- All prices exclude negotiated enterprise discounts, taxes, support, egress
  not explicitly modeled, model inference, Daytona, and engineering labor.

These assumptions must be replaced with observed production distributions
before a procurement or irreversible architecture decision.
