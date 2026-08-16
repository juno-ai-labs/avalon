# Review: Supabase workspace and work-stream conversations PRD

> Written 2026-08-16, against
> [`prd.md` at `c938ec8`](https://github.com/juno-ai-labs/avalon/blob/c938ec8354693931ae8c8bc9bab50b5ef3fb8827/docs/PRDs/2026-08-15_supabase-workspace-workstream-conversations/prd.md)
> and its companions (`research.md`, `comparison.md`, `flows.md`, `state.md`) in
> the same commit. Line references are to that revision. Every vendor claim
> below was re-verified against the official Supabase and Cloudflare
> documentation on 2026-08-16; findings from that pass are marked as such.

The PRD is unusually rigorous for a design at this stage: the vendor limits it
cites are almost all accurate, the hazards it flags (already-joined Realtime
channel reauthorization, Edge Function ceilings, Storage outside PITR, Vector
Buckets alpha, the Cloudflare concurrency-limit discrepancy) are real and
correctly characterized, and the effect/receipt/fence discipline is coherent.
The findings below are therefore mostly about what the PRD understates, leaves
unspecified, or contradicts internally — plus a small number of claims that do
not survive checking. Severity: **Blocker** (must resolve before this PRD is
approved as direction), **High** (must resolve before implementation of the
affected area), **Medium** (resolve during design/implementation), **Low**
(editorial or hygiene).

## 1. Vendor assumptions — validation results

Checked against the official pages on 2026-08-16.

| PRD claim | Verdict |
| --- | --- |
| Edge Functions paid: 400 s wall, 150 s idle, 2 s CPU, 256 MB (prd.md:57–59, 697–698) | **Confirmed** verbatim. |
| Broadcast Replay exists, "72-hour/25-message bound" (prd.md:484) | **Confirmed with an inversion** — see 1.1. |
| Already-joined private channels are not proven to reauthorize promptly (prd.md:75, 788–794) | **Confirmed.** Docs state client access policies are "cached for the duration of the connection" and refresh only on subscribe or on a new JWT; there is no revocation promise. The PRD's caution is well founded. |
| `realtime.send` commits with the transaction (prd.md:635–637) | **Confirmed with a caveat the PRD omits** — see 1.2. |
| Queues: pgmq, logged Basic queues, at-least-once, visibility renewal needs verification (prd.md:666–693) | **Confirmed.** `pgmq.set_vt` exists upstream but is absent from Supabase's own Queues API reference, so the PRD's "verify the deployed API" hedge is exactly right. |
| Cron: sub-minute to 1 s, ≤8 concurrent jobs, ≤10 min per job (prd.md:690–693) | **Confirmed** verbatim. |
| Storage bytes are outside database backups/PITR; no object versioning (prd.md:814–817) | **Confirmed.** |
| Supabase Auth is project-local; global→regional federation is an unproven spike (prd.md:592–596) | **Confirmed, and worse than stated** — see 2.1. |
| Cloudflare Workflows paid limits table (prd.md:2026–2047) | **Confirmed on every row except one** — see 1.3. The 50,000-vs-10,000 concurrency contradiction the PRD flags is still live on the page; its "plan for 10,000" stance is correct. |
| Vector Buckets are public alpha (prd.md:92–94) | **Confirmed.** Docs banner says alpha; limits are 10 buckets/project, 10 indexes/bucket, 4096 dims. Deferral is right. |
| Supavisor transaction mode: no prepared statements/session state (prd.md:841–843) | **Confirmed.** |

### 1.1 (Low) Broadcast Replay's 72 hours is a minimum, not a bound

The docs state daily partitions dropped after 72 hours, so a message is
retained "at least 72 hours and at most 4 days". `research.md:177` records this
correctly as a minimum; `prd.md:484` inverts it into a "bound". The design
conclusion (Replay is never the recovery contract) survives either way, but the
stated fact should match the source.

### 1.2 (Medium) `realtime.send` swallows its own errors — a hint can silently fail inside a committed transaction

Supabase documents that `realtime.send` "captures errors to prevent the trigger
from breaking". So the command-transaction protocol (prd.md:635–637) gets the
property it needs in one direction — a rolled-back transaction broadcasts
nothing — but not the other: a failed broadcast does **not** abort or even
signal the transaction. The architecture tolerates this (durable cursors are
the recovery path), but the PRD says "transactionally call `realtime.send`",
which reads as a stronger guarantee than the platform gives. State the
documented failure mode explicitly, and note two adjacent facts the capacity
model should carry: every database-sent hint is itself a row inserted into
`realtime.messages` on the same primary (write amplification per hint), and
that table is cleaned up after ~3 days.

### 1.3 (Low) The "authored step timeout guidance: at most 30 m" row has no source

Neither the Workflows limits page nor the rules-of-workflows page states a
30-minute authored-step guidance; wall time per step is explicitly unlimited
(the rules page uses a 15-minute timeout in an example, which is not guidance).
Re-source this row or mark it as Avalon's own policy. Every other row in the
table matches the published limits, including steps per instance (10,000
default, configurable to 25,000).

## 2. Launch-gating risks the PRD understates

### 2.1 (Blocker) The identity topology has no documented implementation path and no named fallback

The PRD's topology — thin global Supabase Auth federating into per-region
product projects (prd.md:28–34, 592–596) — depends on "global Auth acts as
OIDC provider to each regional product project". Verified against current
docs: Supabase third-party auth supports exactly five external providers
(Clerk, Firebase, Auth0, Cognito, WorkOS). There is **no documented support
for generic OIDC, nor for one Supabase project consuming another's Auth**. So
the spike is not "prove a supported flow" — no supported flow is documented to
exist. The PRD correctly gates launch on this (Phase 0 item 1, open question
2), but a Blocker-level gate on the load-bearing topology needs a stated plan
B in the decision, e.g.: adopt one of the five supported third-party IdPs as
the global identity authority; keep Avalon's existing Global identity plane
and mint regional Supabase sessions through a reviewed custom exchange; or
accept per-region sign-in. Each fallback changes the global-plane schema and
the migration story, so deferring the choice until after the spike fails is
the expensive order.

### 2.2 (High) The Supabase-native driver cannot host a long model turn, which quietly degrades the EU product

The fallback driver bounds every action inside one Edge invocation under the
400-second wall (prd.md:419–423, 2049–2053). For Daytona the PRD has a real
answer (park by provider reference and reconcile). For a **model call** the
stated answer is "needs a shorter timeout" — i.e., abort. A single streaming
model turn in a long coding/research loop can legitimately exceed ~6 minutes
with extended reasoning, and interactive streaming calls are generally not
resumable by provider reference the way Daytona commands are. Since the
Cloudflare Workflow driver is disabled for EU until contractually approved
(prd.md:723–724, 1925–1927), the EU region ships the fallback driver — meaning
EU workspaces get a materially lower ceiling on model-turn length than
Global/US, or the design needs a provider background/async-mode requirement it
never states. This deserves to be an explicit open question and an EU product
decision, not a sentence inside the fallback description. (Open question 11
gestures at provider capabilities but does not connect them to the 400-second
consequence.)

### 2.3 (High) Realtime's project-wide message-per-second quota is the real streaming constraint, and the PRD never mentions it

The PRD treats 30 frames/second as the cap on the optional fast path
(prd.md:74–77, 455–459) and otherwise reasons about per-frame cost. Verified
limits: Realtime messages per second are a **project-wide** quota — 500 on
Pro, 2,500 on Team/Enterprise (higher by arrangement) — and there is no
documented per-channel rate from which 30 fps derives; it is an arbitrary
self-imposed number. Consequences the capacity section (prd.md:833–859) should
carry explicitly:

- The optional 50–75 ms body path at 30 msg/s per active stream exhausts an
  entire Team-tier project budget at ~84 concurrently observed streams —
  before counting sidebar hints. The gate for that path is framed purely as an
  authorization-lease problem; it is also a quota problem.
- The launch-safe path's 2–4 hints/s per observed stream plus a workspace-topic
  hint on *every* command commit is multiplied by online membership. A busy
  workspace with hundreds of online members consumes the quota on ordinary
  sidebar traffic alone.
- Concurrent Realtime connections are similarly plan-capped (10,000 on
  Team-tier); one socket per active regional session makes this the active-user
  ceiling per region.

None of this is fatal — it is exactly the kind of number Phase 0 item 10 is
for — but "Realtime cost is frame rate multiplied by receivers" (prd.md:857)
is a pricing statement, and the quota is an availability statement. The PRD
should name the quota, budget against it, and derive the fps caps from it.

## 3. Design concerns

### 3.1 (High) `active_outputs.text_buffer` checkpointing rewrites the whole accumulated buffer 2–4×/second

The checkpoint transaction "updates text, offset, hash, and durable event
together" on a row holding "one attempt's accumulated current text"
(prd.md:462–479, 1249–1268). Under Postgres MVCC every checkpoint writes a new
row version; once `text_buffer` exceeds the TOAST threshold, each 250–500 ms
tick re-TOASTs the entire buffer. A 100 KB output checkpointed at 2–4 Hz
writes the full buffer hundreds of times before sealing — O(n²) bytes over the
life of a stream — as WAL that PITR and any replica must also carry, plus an
event-table insert and a `realtime.messages` insert per tick, plus dead-tuple
churn on a hot table. "Subject to measured database load" (prd.md:464) hedges
the cadence but not the shape. Consider append-only delta chunks (keyed by
byte range, compacted at seal) or an adaptive cadence that scales with buffer
size; either preserves the recovery contract while making write volume linear.

### 3.2 (Medium) The coordinates-only streaming path doubles latency and turns every observer into a 2–4 Hz RLS query

Because hints carry no bodies, each frame costs every observer a hint delivery
*plus* an authorized RPC fetch (prd.md:446–452). That is a read-amplification
and connection-pool workload — observers × streams × 2–4 QPS of multi-join
RLS-checked reads through PostgREST/Supavisor — and a two-round-trip token
latency floor. The DO design this replaces pushes bytes with zero reads. The
tradeoff is justified by the revocation gap, but the PRD should budget this
workload explicitly (it is absent from prd.md:833–859) and consider batching
fetches across frames server-side. Acceptance #57 should name it.

### 3.3 (Medium) The `workstream_events` sequence allocator is unspecified — and it sits on the hot path

`workspaces` gets an explicit note that at high write rates the workspace event
sequence comes from a regional database sequence with committed gaps rather
than the row lock (prd.md:970–973). `workstream_events` has no equivalent
statement (prd.md:1332–1337): if `workstream_seq` is allocated under the
`workstreams` row lock, then every 250–500 ms streaming checkpoint contends
with every user append on the same row; if it is a sequence, the
gaps-allowed/monotonic contract needs stating as it was for workspaces, and the
relationship to `next_seq`/`latest_seq` (conversation order) needs to be
explicit so events and parts don't share an allocator by accident.

### 3.4 (Medium) Three copies of the steering revision with no named authority

`workstreams.control_revision` (prd.md:1046), `run_control.control_revision`
(prd.md:1449–1455), and `agent_runs.control_revision` (prd.md:1396) all exist,
all incremented by the steering transaction. Divergence between them is
exactly the class of bug the fences exist to prevent. Name one row as the
authority, define the others as denormalizations updated in the same
transaction, and say which one executors compare against at output-commit and
effect-begin.

### 3.5 (Medium) Fallback-driver dispatch latency is never budgeted

The Supabase-native driver advances one bounded action per queue message +
Cron wake + Edge invocation (prd.md:417–423, 690–693). Each continuation pays
up to the 1-second Cron tick plus queue read plus Edge cold start — call it
0.5–2 s — and a 2–30 minute loop has many continuations. Meanwhile Cron's
own recommended ceiling is 8 concurrent executions, capping dispatcher
parallelism, and a 1 s dispatcher is 86,400 executions/day of mostly-empty
polls, in tension with goal 9's "no high-frequency empty polling". The PRD
asserts 1–5 s time-to-first-token (prd.md:446) without showing the fallback
driver meets it, and never states an inter-step latency budget for either
driver. Phase 0 item 6 load-tests the queue; add an explicit end-to-end
admission→first-token and step→step latency target to the acceptance list.

### 3.6 (Medium) Interrupt latency for acceptance #34 depends on a socket the design calls optional

The run-control Realtime subscription is "an optimization, not a lease or
authority" (prd.md:437–441), and correctness comes from fences at output
commit and effect begin. But acceptance #34 requires "steering during a safe
read cancels promptly". In the fallback driver an Edge invocation streaming a
model response must be simultaneously subscribed to `run-control:<run_id>` for
prompt cancellation to exist at all; nothing specifies that, and if the socket
is absent the interrupt waits for the next database fence — potentially
minutes into a long tool call. Either specify the executor-side subscription
as required behavior (with its failure mode), or weaken #34 to what the fences
actually guarantee.

### 3.7 (Medium) Sparse-overlay default semantics are undefined exactly where they are hardest

The overlay table is sparse by design (prd.md:248–253, 1085–1106), so
**Unread** and **Of Interest** for a member with *no* row are computed against
an undefined default: is everything before first-open unread? From which
ordinal does a newly added member start? What is the indexed query shape for
"cards with activity and no overlay row" (an anti-join, not an "indexed
overlay predicate" as prd.md:242–243 claims)? Likewise `interest_reason_bits`
is "documented derived union bits" (prd.md:1099) with no document. These are
the queries the sidebar lives on; specify the default-row semantics and the
intended plans.

### 3.8 (Medium) Deferring partitioning on the event tables conflicts with their unique keys

Partitioning `workspace_events`/`workstream_events`/`activity_events` "only
after measured pressure" (prd.md:851–853) sounds incremental, but each table
carries a global unique key — e.g. `(workspace_id, workspace_seq)`
(prd.md:1325) — and Postgres requires a partition key inside every unique
constraint, so retrofitting time-partitioning onto these tables is a
full-table migration, not a maintenance action. Given the PRD already knows
retention interacts with cursor semantics (prd.md:1328–1330, open question
18), decide the partitioning scheme for the append-only event tables up front
and let the campaign machinery do the later *re*-partitioning, not the first.

### 3.9 (Medium) No abuse or rate-limiting story for the direct-to-database client surface

Today every client request passes through the Hono Worker, which can throttle.
This design hands authenticated clients PostgREST RPCs and views (prd.md:184,
599–616) with bounded statement timeouts as the only stated backpressure
(prd.md:845). A hostile or buggy client hammering the snapshot RPC, search, or
active-output fetches spends shared-primary capacity for the whole region.
Supabase's built-in rate limits cover Auth, not the Data API. The security
section should own request-rate abuse the way it owns authorization.

### 3.10 (Low) Schema nits

- `terminal_commands.command_key unique` (prd.md:1496) is scoped globally;
  it should be unique per session or per effect.
- `suggestions`' "unique within the defined active window" (prd.md:1654) is
  not implementable as a plain unique constraint; the partial-index-on-state
  implementation should be stated, since the PRD is otherwise explicit about
  index shapes.
- `workstream_user_state` has no `state`/tombstone column, yet "a removal can
  leave an audited tombstone" (prd.md:1105–1106).

## 4. Internal contradictions and schema defects

These are places the PRD (or a companion it declares normative) contradicts
itself; all are cheap to fix now and expensive after migration files exist.

### 4.1 (High) `waiting_capacity` cannot be represented in `agent_runs.state`

`waiting_capacity` is an exact state feeding the `in_progress` family
(prd.md:229), runs that fail driver creation "remain visibly
queued/capacity-limited" (prd.md:736), acceptance #30 requires "durable queued
or capacity state" (prd.md:2357), and flows.md B44 pauses a run in "durable
`waiting_capacity`" (flows.md:2123). But the `agent_runs.state` enum
(prd.md:1393) contains no such value —
`admitted/ready/running/waiting_user/waiting_event/waiting_provider/interrupting/…`.
As written, capacity-limited is only a work-stream state, and non-work-stream
owners (which have no work stream) cannot express it at all.

### 4.2 (High) The effect idempotency key is defined two different ways

prd.md:651 scopes run effects by `(run_id, step_no, effect_kind, effect_key)`;
the `tool_effects` table declares unique `(run_id, **step_id**, effect_kind,
effect_key)` (prd.md:1484), which `research.md:128` matches. These differ
precisely in the retry case the mechanism exists for: `step_no` is stable
across attempts, `step_id`… is glossed as the logical step but see 4.3. Pick
one and state the retry semantics it produces.

### 4.3 (High) `agent_steps` declares a uniqueness that makes its own retry model impossible

prd.md:1419 declares `(run_id, step_no)` a "unique pair"; prd.md:1430 declares
unique `(run_id, step_no, attempt_no)` with `attempt_no` meaning retry attempts
within the logical step. Both cannot hold — if the pair is unique there is
never a second attempt row. Presumably the pair-uniqueness should go (or move
to a partial unique on the winning row, which prd.md:1430 also mentions), and
`id`'s gloss "stable logical step" (prd.md:1417) should become "one attempt".

### 4.4 (Medium) The topic model contradicts its own enumeration

prd.md:481–482 has the client join "foreground work-stream common/**personal**
topics", but the normative list (prd.md:753–757) defines exactly four topics
with personal topics only at workspace level — and flows.md S28
(flows.md:803–804) follows the four-topic list. Relatedly, `workstream_events`
carries `target_user_id` (prd.md:1334) with no defined topic that delivers a
work-stream-scoped personal event. Fix the prose or add the topic.

### 4.5 (Medium) The compaction validity key omits columns its own security section requires

prd.md:1960–1961: "A summary's key includes source hashes, audience/
authorization **and resource revisions**." flows.md B08 (flows.md:1122)
agrees. But `compaction_jobs` (prd.md:1274–1285) records only
`authorization_epoch`, `scope_revision`, and the merkle hash — no audience
identity and no resource revision. If coverage is intended to be indirect
(substream audience + epoch bumps), say so and show it is sufficient;
otherwise add the columns.

### 4.6 (Medium) A scheduled work stream's due state has no home

flows.md S12 (flows.md:348–376) requires durable pre-admission due state
("Cron wakes the durable due state once"; the loop admits at due time). The
only due-state carriers in the data model are `digest_schedules.next_due_at`
(prd.md:1614) and `agent_runs.next_wake_at` (prd.md:1401) — and the latter
exists only after admission creates the run (prd.md:727). The
"automation-domain record" (prd.md:2070) is named but never modeled. Either
model the schedule table or state explicitly that it is deferred to the
automation domain's own PRD.

## 5. Companion-document inconsistencies

- **(Medium) `research.md`'s flow-ID map is misnumbered.** research.md:53 maps
  S04–S06 to queue/steer/interruption; in flows.md those are the private
  chat/fork/sub-agent studies (flows.md:126, 155, 182) and queue/steer is
  S07–S09, S18 (flows.md:2148). Also S30 (research.md:51 "sidebar" vs
  flows.md:850 migration transform) and S19 (research.md:55 "regional
  placement" vs flows.md:547 compaction). Since both documents claim the 75-ID
  mirror is what a later acceptance suite will be built from, the numbering
  must be reconciled.
- **(Low) `comparison.md` invents an `Assigned` sidebar collection**
  (comparison.md:161–162) that neither prd.md (236–247) nor research.md:495
  defines.
- **(Low) Unnoted renames between research and PRD**: `active_chunks` →
  `active_outputs` (research.md:416 vs prd.md:1249), `workstream_attention` →
  `workstream_attention_events` (research.md:489 vs prd.md:1108). Harmless
  evolution, but a reader moving between the documents deserves a note.
- **(Low) One cost row does not reproduce**: comparison.md:604's Vectorize
  example ($22.92) computes to roughly $15 from the rates listed beside it.
  Worth re-deriving, since the comparison's conclusion leans on cost tables
  that are otherwise arithmetically consistent.

## 6. Scope and process

### 6.1 (High) This is a backend re-platforming, and the PRD never says what happens to `apps/api`

The PRD frames itself as moving state authority. But the client talks to
RLS-protected views and RPCs (prd.md:184), connector ingress moves to Edge
Functions (prd.md:266), the run loop moves to Workflow/Edge drivers — which is
to say the Hono Worker's product surface (hundreds of routes, the harness, the
sockets layer, ~460 tenancy-scoped queries) is being replaced, not re-pointed.
Nowhere does the PRD state the fate of the existing regional Worker, which
standing documents (`architecture.md`, `realtime-sockets.md`,
`data-model.md`…) it supersedes, or the rough size of the application rewrite
relative to the schema work — Phase 1's "deploy application writers/readers
that understand both representations" (prd.md:2159–2161) is likely the
majority of the engineering cost of this PRD and gets one sentence. The
comparison with the Durable Object design cannot be honest about cost unless
both sides count this.

### 6.2 (Medium) Product-contract changes are larger than "infrastructure ownership"

prd.md:528–535 says the user-facing model is unchanged while also listing new
contract items (queue/steer semantics, substream rules, socket lifecycle,
suggestion provenance). The sidebar collections this PRD's product behavior
assumes (**You Are Mentioned**, **Needs Your Input**, **Of Interest**,
**Suggested**…) exist today in neither the shipped sidebar (recency sections +
Pinned + Automations) nor [the implementation
brief](../2026-08-05_avalon-implementation-brief/prd.md); they are defined by
the sibling Durable Object PRD. Per `docs/prds.md`, a contract move names the
clause and edits the brief when it lands. At minimum, the Impact section
should say plainly that the product surface is inherited from the DO PRD and
is itself new.

### 6.3 (Medium) Three overlapping architecture PRDs, no supersession chain, stale base

`2026-08-12_per-workspace-databases` (merged, `planned`) proposes per-workspace
DO SQLite; `2026-08-15_durable-workspace-workstream-conversations` proposes
the DO hierarchy; this PRD proposes Supabase. No `state.md` in any of the
three references the others, and the branch carrying this PRD predates several
PRDs now on `main` (its tree lacks `per-workspace-databases` entirely).
Whichever direction is chosen, `docs/prds.md`'s supersession rule requires the
losers' `state.md` to say so — and the decision covers three documents, not
two. Rebase the branch before merging so the record is coherent.

### 6.4 (Low) PRD-form deviations

- The **Decision log** (prd.md:554–570) is used as a table of design decisions
  made while writing. Per `docs/prds.md` that content belongs under **Key
  design decisions** (which this PRD also has), and the Decision log of a
  `planned` PRD reads `None yet.` — it is reserved for post-agreement changes
  in the dated Decided/Why/Changes form.
- The header blockquote omits the standing-contract link to the
  implementation brief that the house header carries.
- `docs/prds.md` routes "schemas, protocols, migration strategy" to a
  companion `design.md`; roughly half of this 2,490-line `prd.md` (the data
  model and transaction protocols, prd.md:861–1892) is that material.
- The rollout's per-workspace authority flag (prd.md:2161) is unnamed;
  `docs/feature-flags.md` asks rollouts to name the flag.

## 7. What holds up

For balance, the things this review actively confirmed: the Edge/Cron/Queues/
Storage/Workflows numbers are accurate (including the deliberately conservative
10,000-instance planning stance); the already-joined-channel revocation hazard
is real and the coordinates-only default is a sound response to it; the
subscribe–buffer–snapshot handshake with an authorized `scanned_through`
watermark is a correct catch-up design; the effect state machine
(`planned → started → succeeded|failed|unknown` with provider-reference
reconciliation) and the receipt discipline are consistent throughout the
document; the D1 cutover's single source-local authority gate is a defensible
linearization design that avoids claiming a cross-system atomic switch; and
the decision to keep Vector Buckets out of the launch path matches its actual
alpha status. The two companion documents agree with the PRD on every
load-bearing number checked (checkpoint cadences, depth limits, queue names,
cutover gate tables) except where §4–5 say otherwise.
