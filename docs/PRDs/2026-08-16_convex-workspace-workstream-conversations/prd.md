# Convex workspace and work-stream conversations

> Created 2026-08-16.
>
> Avalon stores workspace, work-stream, conversation, activity, suggestion, and
> agent-run state in one Convex deployment per region. Serializable mutations
> are the only write path, reactive query subscriptions are the entire realtime
> layer, and the Workflow component drives every full agent loop. Standing
> contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Companions: [`state.md`](state.md), the deep
> [`design.md`](design.md), [`flows.md`](flows.md), and the underlying
> [`research.md`](research.md).

## Summary

Avalon's product data plane becomes one Convex deployment per residency region.
Every workspace, work stream, substream, conversation part, activity fact,
suggestion, and agent run is a document in that deployment, and every canonical
write is one serializable mutation that commits the message, the sidebar card,
the affected personal overlays, the durable audit rows, and the scheduling of
follow-up work together or not at all. What a user notices is that the product
stops having a seam: the sidebar can never disagree with the transcript, a
reconnecting client never re-derives its own view from a cursor arithmetic it
can get wrong, and a person removed from a work stream stops receiving its
frames because the removal itself is what re-evaluates every subscriber's
authorization.

The change is a substrate change, not a product change. Sidebar collections,
the exact-state-to-family mapping, substream kinds and their inheritance rules,
queue-versus-steer semantics, compaction fences, suggestion and digest
lifecycle, and the Terminal-on-Daytona boundary are preserved exactly as the
sibling [Supabase
PRD](../2026-08-15_supabase-workspace-workstream-conversations/prd.md) defines
them. What changes is which machinery Avalon owns. Live consistency and
per-frame revocation become platform properties rather than Avalon-built
projection, hint, cursor, replay, resync, and eviction protocols;
`WorkstreamRoom` and its checkpoint/replay/resync machinery are deleted rather
than ported. In exchange Avalon accepts a smaller vendor, no SQL surface at
launch, no Terraform provider, a 30-minute ceiling on a single model turn, and
three load-bearing assumptions that a pre-registered one-week pilot and one
vendor letter must settle before any migration work begins.

The launch topology is one Global (US East) deployment. EU (Ireland) is a real,
priced region and an explicitly deferred, fail-closed future path, gated on a
signed DPA and subprocessor review rather than on this document. The provenance
of the four-candidate comparison behind this proposal — advocate briefs,
adversarial challenges, cost audit, and three independent judge passes — is
summarized in [`research.md`](research.md) under **Provenance**.

## Motivation

The move off the current stack is settled, not proposed here. Canonical product
state lives in per-region D1 with Durable Objects coordinating ordering,
presence, sockets, and alarms (see [`architecture.md`](../../architecture.md)),
and that shape has already been judged unsustainable for the product Avalon is
building: lazy per-object migrations with no rollback story, a conversation
authority that must be woken to be queried, and a client protocol in which
every consistency guarantee is code Avalon wrote and must keep correct. Three
PRDs now describe candidate destinations — the [Durable
Objects](../2026-08-15_durable-workspace-workstream-conversations/prd.md)
elaboration of the current shape, the [Supabase regional
Postgres](../2026-08-15_supabase-workspace-workstream-conversations/prd.md)
design, and this one. The question is which substrate, and the cost of leaving
it open is that every week of build lands on a data plane someone intends to
replace.

The concrete problem the current stack keeps producing is the seam between an
entity's own state and everything that must agree with it. A work-stream update
has to reach the workspace projection, the per-person overlay, the sidebar card,
the durable event log, and the socket, and each of those hops is an Avalon-built
delivery with its own failure mode: a lost hint, a cursor that skipped, a
resync flash, a replayed frame, a card that says "running" for a stream that
finished ninety seconds ago. Roughly 200 lines of checkpoint, replay, resync,
and eviction protocol exist in `WorkstreamRoom` for no product reason — they
exist because delivery is unreliable and Avalon has to repair it. Every such
repair path is a place a future incident comes from, and none of them is
something a user would pay for.

Convex removes the category rather than improving the odds. A mutation is a
serializable transaction across every document it touches, so the sidebar card
and the message it describes cannot be written apart. A subscribed query is
re-executed server-side whenever a commit overlaps its read set, and the result
that is pushed is a recomputed snapshot rather than a replayed delta — so
reconnect is one query execution, not a cursor negotiation, and Avalon's
visibility rule, which runs *inside* that query, is re-evaluated on every
delivered frame. That is the mechanism the panel scored highest, and it is the
reason this proposal exists.

Three independent judge passes over identical inputs voted 2–1 for Convex
(means 67.5 / 61.3 / 57.6 / 51.2 against GCP, Supabase, and AWS), and — more
usefully than the vote — all three converged on the same decision function:
*Convex if its one-week S≈5 pilot passes; GCP if it fails*. The same passes are
unanimous about where Convex is weakest: last on maintainability (no SQL, no
Terraform provider, dashboard-only backup scheduling) and lowest on risk (a
startup vendor and three unverified assumptions — the metering model, the push
latency bound, and the revocation semantics). This PRD is written to that
verdict: the architecture below is the Convex design, and its Phase 0 is the
pilot and the vendor letter, with reversion to GCP as the pre-registered
outcome if either fails.

## Goals

1. Make one regional Convex deployment the only product-data authority for a
   workspace's metadata, work streams, conversations, sidebar projections,
   activity, suggestions, files, search, and run state.
2. Serialize every canonical work-stream mutation inside one Convex transaction
   that allocates the work stream's conversation sequence, updates common
   sidebar fields and sparse per-person attention state, appends durable audit
   rows, and schedules required follow-up work atomically.
3. Store conversation content as ordered, typed, provider-neutral parts inside
   explicit substreams that deterministically materialize into valid model
   message arrays at an authorization and context fence.
4. Support shared main conversations, private contextual chats, human forks,
   and bounded sub-agent investigations without turning them into separate work
   streams or leaking their audiences through compaction, search, or previews.
5. Commit both queued and steering user messages before acknowledgement. Queue
   preserves the active attempt; steer invalidates stale work and prevents a
   later irreversible effect from starting against superseded context, with a
   worst-case visible-halt bound of one second that does not depend on model
   tokens still flowing.
6. Run generic full agent loops lasting 2–30 minutes and rarely more than two
   hours, across work-stream and non-work-stream owners, with durable retries,
   event waits, deployment survival, effect reconciliation, and explicit
   budgets.
7. Keep Daytona as the Terminal execution provider and reconcile long commands
   by provider reference rather than retrying them after an executor timeout.
8. Deliver human-realtime output and sidebar changes through native reactive
   subscriptions in which every delivered frame is a fresh execution of
   Avalon's visibility code, and recover any disconnect by query recomputation
   rather than by client cursor arithmetic.
9. Avoid a database document per generated token, per-work-stream sockets, idle
   background socket waste, high-frequency empty polling, and any client-side
   replay protocol.
10. Store connector ingress, activity, digests, suggested work streams, and
    suggested actions with durable provenance, deduplication, audience, expiry,
    feedback, and exactly-once promotion semantics.
11. Use Convex file storage behind authoritative content references, and native
    text and vector search that execute Avalon's visibility code on every read
    path so no index is authoritative on its own.
12. Keep a future EU deployment's product data and processing inside its
    approved regional path, fail closed rather than failing over across a
    residency boundary, and make the EU build conditional on contractual review
    rather than on region availability.
13. Migrate from D1/R2 in a bounded, single-writer cutover with a per-workspace
    authority gate, no period in which two systems accept canonical writes, and
    a reversible flag before that gate closes.
14. Make cost grow with active use — observed streams, subscribed viewers,
    committed work, and stored bytes — rather than with historical work-stream
    count, idle connections, or duplicated cross-service projections, and keep
    every scaling limit either a billing line or a named architectural task.

## Non-goals

1. This PRD does not create one Convex deployment, project, or component
   instance per workspace or per work stream. One deployment per region serves
   every workspace in it.
2. This PRD does not create a synthetic workspace or work-stream actor. The
   document aggregate and function API preserve logical ownership without a
   resident process.
3. This PRD does not expose Convex tables to arbitrary client reads or writes.
   Clients can only invoke exported functions; there is no client table access
   and no row-level-security substitute for the function layer.
4. This PRD does not ship a SQL surface at launch. Operational inspection is
   the Convex dashboard, `npx convex run`/`npx convex data`, and a Fivetran
   streaming export into a warehouse for real analytics. Deferred, not
   rejected: a warehouse is the SQL story, and it is named, not implied.
5. This PRD does not self-host Convex at launch. The open-source backend is an
   exit ramp exercised as a drill, not a hot spare, and multi-node self-host
   guarantees are explicitly unknown.
6. This PRD does not launch an EU deployment. EU (Ireland) is deferred behind a
   signed DPA and subprocessor review, and until then EU-bound workloads fail
   closed rather than routing to Global.
7. This PRD does not commit to a Singapore region. Convex publishes no SG
   region today; the owner's three-region target is a named risk, not a plan
   inside this document.
8. This PRD does not treat reactive subscription delivery, scheduler dispatch,
   or component state as canonical product state. Documents are the authority.
9. This PRD does not store a document per generated token or rendered frame,
   and it does not delay all output until the final assistant part.
10. This PRD does not make an entire full agent loop one action, one mutation,
    one workflow step, or one retryable unit.
11. This PRD does not make every agent loop a work stream. The run model is
    owner-neutral and domain state remains with its owner tables.
12. This PRD does not make an ambiguous external write safe to repeat. Unknown
    effects reconcile or request intervention.
13. Terminal remains on its existing Daytona provider under the separate
    Terminal subsystem contract. Convex actions do not run shell commands.
14. This PRD does not use substreams as storage shards, UI tabs, one-per-turn
    containers, security boundaries, or substitutes for work streams.
15. This PRD does not delete source parts merely because compaction produced a
    summary.
16. This PRD does not treat a suggested work stream as a real work stream
    before an authorized acceptance transaction succeeds.
17. This PRD does not retire the Cloudflare Worker estate entirely. One
    vestigial Worker keeps proxying the Azure dictation WebSocket, because
    Convex terminates its own client sockets but does not proxy third-party
    ones. The honest post-migration technology count is about five, not two.
18. This PRD does not build a client cursor, replay, or resync protocol. Those
    do not become simpler here; they cease to exist, and reintroducing one is a
    design regression rather than an optimization.
19. This PRD does not solve horizontal sharding of a single deployment. Past
    roughly S≈2,000 the fix is application-level per-workspace sharding across
    deployments, named here and deliberately unbuilt.

## Product behavior

### Workspace collections, sidebar, and work streams of interest

Opening a workspace subscribes to one paginated sidebar query. It returns
common work-stream cards joined with the current person's sparse overlays and
collection counts. It never wakes an entity fleet, and it carries no cursor: the
subscription is the live view, and every later commit that overlaps its read
set re-runs it and pushes the new page.

The common card fields live on the work-stream head document: work-stream ID,
title, short description or objective, origin, created time, last people-visible
activity time, latest conversation sequence, exact run state and blocker or
terminal reason, lifecycle family, preview, active-agent summary, needs-input
flag, completion and error timestamps, and the common revision. Every exact
state maps to one family:

| Exact state/reason | Sidebar family |
| --- | --- |
| `scheduled`, `preparing_context`, `running`, `interrupting`, `waiting_capacity` | `in_progress` |
| `needs_input` with an ordinary question or missing choice | `in_progress` |
| `completed`, `cancelled_cleanly`, `archived` | `completed` |
| `failed`, `budget_exhausted`, or `needs_input` with an ambiguous effect/intervention | `error` |
| `deleting`, `restoring` | hidden by the visibility gate |

**Work Streams** is every visible real work stream. **In Progress**,
**Completed**, and **Error** are indexed predicates over the head document's
denormalized card fields. Date groups use the same documented `lastActivityAt`
or `completedAt` field and the workspace timezone; they are not client guesses.

The person-specific overlay is a separate sparse document holding a monotonic
seen waterline, unread and mention ordinals, latest mention time,
`needsYourInput`, pin, mute, dismiss, last opened, and a per-person revision.
**You Are Mentioned**, **Unread**, **Needs Your Input**, and **Pinned** are
indexed overlay predicates. **Of Interest** on the main screen is the documented
union of pin, mention, unread, assignment or input need, accepted suggestion,
and recently opened or active signals. No opaque recommender silently changes
this collection.

The system does not eagerly create one overlay document for every member and
work stream. It creates one when the person opens, is mentioned or assigned,
needs input, pins, mutes, dismisses, accepts a suggestion, or otherwise differs
from the default. A missing overlay means "never opened". Large workspace-wide
attention events use an audience ordinal and lazy evaluation rather than a
Cartesian write.

Marking seen is a monotonic mutation. It advances only to a sequence or
attention ordinal the caller is authorized to see, and never moves backward or
into the future. Rendering, presence, and an open socket do not mark content
seen.

The same mutation that changes a work-stream title, state, last activity,
message attention, mention, or assignment updates the head document's card
fields and the affected overlays, appends the durable audit rows, and schedules
follow-up work. There is no cross-object delivery to repair, no projector to
lag, and no hint to lose: the commit is what re-runs every affected
subscription, and the sidebar and the transcript are two reads of one snapshot.

### Activity ingestion, digests, and suggestions

A connector delivery enters an HTTP action on the deployment's `convex.site`
domain. The action verifies the provider signature, timestamp, replay window,
installation, and size before accepting content, then calls one mutation that
records a receipt keyed by installation and provider event ID — or by a
documented semantic hash and window when the provider has no stable ID. A
repeated ID with the same body returns the prior receipt; the same ID with
different bytes is quarantined as immutable conflict evidence and audited.

Large raw bodies go to Convex file storage through a pending-then-ready content
reference lifecycle. The receipt and the scheduled normalization work commit
together, because scheduling from inside a mutation is transactional: if the
mutation commits, the job is scheduled. A bounded worker creates immutable
normalized activity facts, version and tombstone records, resource links,
audiences, and reconciliation cursors. Raw receipts are evidence and replay
input; normalized activity is the product-facing authority; vectors and
subscriptions are neither.

Digests freeze an authorized activity watermark, timezone, audience, source
revision, and model and prompt version. Late events enter the next digest or an
explicit revision. Model generation and delivery are separate idempotent
effects. Revocation between selection and commit invalidates the artifact.

Opportunity workers create suggestions and their source links. A suggested work
stream is a proposal with provenance, score, explanation, target audience,
expiry, and lifecycle. It appears in **Suggested** or the appropriate personal
surface, never in real work-stream collections. Accepting it runs one mutation
that revalidates source access, creates the work stream and its initial parts,
updates the sidebar, records the accepted ID, and appends audit rows. A retry
returns the same work stream.

A suggested action targets an existing work stream or external object but does
not execute until a person approves it or a separately defined policy permits
autonomy. Acceptance records a generic run and effect intent under the same
revision and idempotency rules as any other agent action. Dismissal, expiry,
feedback, source deletion, and access revocation are durable and scoped to the
user or audience.

### Main conversation and LLM message arrays

The main feed is the root substream of a work stream. Every accepted user,
assistant, tool, attachment, terminal, compaction, or control part receives one
monotonic `seq` allocated by read-modify-write on the work-stream head document
inside the appending mutation. Two concurrent appenders conflict on that
document and are serialized by the platform's optimistic concurrency control, so
commit order *is* sequence order and no part can commit with a sequence lower
than one already visible. A logical turn has a turn ID; provider-valid tool
call and result adjacency is captured by explicit relations and materialized
correctly even when a human message arrives while the tool is running.

Specifically, a human part that arrives after a tool call but before its result
keeps its physical `seq` and is shown as queued while the tool exchange is open.
The tool turn receives the next admission ordinal only when its result or error
is sealed; the queued human turn receives the following ordinal. Provider
context therefore orders assistant tool call, tool result or error, then user
input. The UI may show the user's wall-clock arrival between live tool statuses,
but the provider array never places a user role inside a required call/result
pair. This is an explicit projection rule, not a claim that physical and
provider order are always identical.

The projector is a versioned function over: the requested work stream and
substream lineage; an inclusive work-stream sequence fence; a current
authorization and context-scope epoch; complete, visible turns and tool
call/result pairs; applicable, still-valid compaction summaries; promoted child
summaries and referenced content versions; and a provider adapter that maps
neutral roles and typed parts into its wire format. It produces the same logical
array on retry and records the projection version, source fence, hashes, and
audience epoch on the run step. Provider wire payloads are not canonical
history. Small text is inline in the part document; large bodies resolve from
ready content references. Missing, corrupt, unauthorized, or revised content
fails materialization explicitly rather than silently changing the prompt.

### Queued and steering messages

Every user input command supplies an idempotency key, the expected work-stream
revision, and mode `queue` or `steer`. One mutation authenticates live
membership, allocates the sequence, commits the user part and its attention and
sidebar effects, appends the durable audit rows, advances run-control state, and
returns — before the client treats the message as sent. The client's optimistic
update renders the message immediately; the commit is what makes it true, and a
failed mutation rolls the optimistic state back rather than leaving a phantom.

A queued message does not increment the interrupting control revision. The
active attempt may finish, and the next admission boundary batches every
eligible queued input exactly once in canonical order. A sender can see that the
message is committed and waiting.

A steering message increments the control revision on the steering document,
sets the interrupt-requested time, and records the requested boundary. There is
no separate notification path to lose: the turn action reads the steering
document at every checkpoint commit, and a watchdog timer inside the action
forces a no-op checkpoint every 500 ms even when no tokens are arriving, so the
worst case for visibly stopping is one checkpoint interval regardless of whether
the provider has stalled or the turn is sitting inside a long tool wait. A
cooperative model request is aborted when possible. An ordinary read-only tool
may finish if stopping it is unsafe or unsupported, but its result cannot be
admitted against the stale revision, because the committing mutation checks the
epoch it was started under. No new irreversible effect may begin after the
steering revision commits: the effect-begin mutation checks the current
revision in the same transaction that records intent.

If a provider cannot cancel, its late output is recorded as superseded
diagnostic state or discarded, and never seals the winning assistant part. If an
external write already began, the system reconciles its idempotency key or
provider reference and tells the user what happened; steering does not rewrite
reality. Multiple steering messages coalesce by revision into one deterministic
next admission batch. Queue and steer commands remain ordinary transcript
history; a control flag cannot exist without its durable user part.

### Chats, forks, sub-agents, and substreams

Supported substream kinds are deliberately finite:

| Kind | Purpose | Inheritance | Default audience |
| --- | --- | --- | --- |
| `main` | Shared work-stream history | none; it is the root | work-stream audience |
| `private_chat` | Private contextual exchange | frozen visible parent fence | explicit people/agent audience |
| `human_fork` | Explore from an exact completed past | frozen parent fence | creator-selected audience |
| `subagent_fresh` | Bounded independent investigation | explicit task packet only | owning agent and permitted viewers |
| `subagent_fork` | Investigation inheriting an exact parent context | frozen parent fence | owning agent and permitted viewers |
| `document_chat` | Focus on a versioned resource | frozen or explicit live version policy | resource-authorized audience |

Substreams should be used when content has a coherent model-context boundary
inside one work stream and its result may be summarized or promoted. They keep
private chat or tool chatter out of unrelated future prompts while preserving
one audit order.

Substreams should not be used for pagination, storage distribution, one model
turn, one tool call, one user, one UI tab, one socket, arbitrary tags, or access
control by identifier alone. A body of work needing its own title, sidebar card,
participants, lifecycle, retention, completion, or independent objective is a
work stream. A depth limit of four, an explicit parent, a base sequence, an
inheritance mode, a scope revision, a lifecycle, and a promotion relation
prevent branch bombs and ambiguous ancestry.

Every part retains the one work-stream-wide `seq`; substream-local order is
derived. Visibility checks the work stream and the part's audience, not mere
possession of a substream ID. Promotion appends a provenance-bearing summary or
reference into the target substream; it does not retroactively widen the child
audience.

### Active runs, streaming, and steering

A full loop starts when committed input is admitted and ends only at
`completed`, `waiting_user`, `failed`, `interrupted`, `cancelled`, or another
product terminal state. It can contain many model turns, tool calls, Daytona
commands, retries, compactions, and waits. It is not one inference request and
not one user/assistant turn.

Each full loop is one Workflow component instance. Its steps are individually
durable, persist to the same deployment as the product data, and survive
restarts and deploys. One model turn is one Convex-runtime action that opens the
provider stream, buffers tokens, and commits delta chunks; one tool call, one
settlement, and one reconciliation are likewise separate steps. Nothing about
the loop lives outside the deployment, so there is no external orchestrator
state to keep data-minimal, no binding to reconcile, and no second system that
can believe a run exists when the database says it does not.

Time to first token is normally 1–5 seconds: send commits one mutation which
transactionally schedules the turn action, the action opens the provider stream,
and the first delta chunk lands one checkpoint interval later.

While a turn runs, the action commits an append-only delta chunk every 250–500
ms — visible output updates at two to four times a second, which is the product
cadence, not a platform artifact. Each commit re-runs the tail queries of every
subscribed viewer and pushes the recomputed result. Avalon does not store a
document per token: chunks are batched, and sealing copies the accumulated text
into one immutable assistant part and tombstones the chunks it replaces.

Retraction of a dead attempt is one commit. Chunks are keyed by turn and epoch;
the head document's epoch is advanced by compare-and-set, and every tail query
filters on the current epoch, so bumping it retracts a crashed attempt's
provisional text for every viewer simultaneously. A superseded attempt's
checkpoint mutation fails its epoch guard and cannot commit, so two attempts can
never interleave and only one can seal.

Because content rides the same authorized subscription as everything else, there
is no separate "coordinates only" delivery tier and no client fetch per frame.
Every delivered frame — sidebar, transcript, or streamed token batch — is the
output of a fresh server-side execution of Avalon's visibility code at a
post-commit snapshot, with the viewer's membership document in the query's read
set. The commit that removes a person is therefore the commit that re-runs their
subscriptions and returns nothing.

The Electron main process owns one client socket per regional session, and it is
the platform's own multiplexed socket rather than an Avalon protocol: components
subscribe and unsubscribe as surfaces mount, and the client library reconciles.
There is no subscribe-buffer-snapshot handshake, no gap detection, and no
replay window to stay inside. A backgrounded app with no visible active run and
no promised live completion closes the socket after a grace period; on focus it
resubscribes and each query is recomputed once, at a cost that is independent of
how long it was away.

### Compaction while messages continue

Compaction never rewrites the mutable conversation head. One mutation freezes a
complete-turn source range, content hashes, substream lineage, authorization
epoch, context-scope revision, and compactor and model version into a unique
job. Messages sent during compaction allocate higher work-stream sequences
normally and are not observed by the job.

The worker reads exactly the fence, performs one bounded compaction action, and
commits a derived summary only if every source, scope, and authorization input
still matches. The materializer then uses that summary for the fenced prefix and
ordinary parts above it. A retry returns the same summary by compaction key. A
permission, document-version, redaction, or lineage change invalidates the
result and schedules a new fence. Old parts remain under the retention and audit
policy; compaction alone is not deletion.

### Completion, errors, and offline recovery

Exactly one attempt wins each admitted input range. Uniqueness constraints
enforced inside mutations and compare-and-set terminal transitions reject late
completions. A terminal mutation seals the output part, updates the run and
work-stream state, updates the common card fields and personal overlays, appends
the audit rows, and schedules any derived work. Every viewer's affected queries
re-run on that one commit, so a coherent terminal card and transcript appear
together or not at all.

An error is classified as retryable, user-actionable, ambiguous external effect,
budget exhaustion, authorization invalidation, or permanent failure. The sidebar
maps it deterministically. Operators can inspect opaque IDs, revisions, timings,
hashes, and error classes without routine content access.

Offline recovery has no protocol of its own. A client that was disconnected —
for a second or a week — resubscribes, and the server recomputes each query and
pushes current results; catch-up cost is one query execution per subscription,
independent of the gap. Offline *writes* still carry an idempotency key and an
expected revision: reconnect submits them to the same mutations, a duplicate
returns the original result, and a conflict surfaces when semantics cannot be
merged. Clients never infer success from an optimistic update; the optimistic
value is replaced by the authoritative query result on the next push.

## Impact on the product contract

This PRD changes infrastructure ownership, not the user-facing work-stream
model. Everything the standing contract says about what a work stream is, that
viewing does not create participation, that Avalon is inherent in every work
stream, and that there is no channel, global inbox, or global search is
unchanged.

The contract gains the same explicit clauses the sibling PRD adds, because they
are product semantics rather than platform artifacts: queue-versus-steer
message semantics, substream context and audience rules, sub-agent lifecycle,
suggestion and digest provenance, and full-loop execution boundaries. Existing
references to a per-work-stream realtime coordinator, to D1 as canonical
conversation state, or to a client cursor and replay contract must be replaced
by the regional Convex function contracts. The background socket lifecycle
remains a contract clause, but its content shrinks: the client may close its
socket when nothing requires it and resubscribe on focus, with no cursor
obligations on either side.

One user-visible cadence becomes a product fact rather than an implementation
detail: streamed assistant output updates every 250–500 ms — two to four visible
updates per second — and that number is Avalon's choice, tied directly to spend
and adjustable per region. It is stated here so that "the text appears in
small batches, several times a second" is a promise the product keeps rather
than an artifact a future change may silently break.

The product must not expose Convex implementation details such as function
names, component instances, scheduler behavior, OCC retries, or deployment
classes. It exposes committed, queued, steering, running, waiting, terminal, and
recovery states.

## Decision log

None yet.

## Key design decisions

1. **One Convex deployment per region is the entire product data plane.**
   Database, realtime fan-out, job queue, loop driver, blob storage, text and
   vector search, and the API tier are one product with one status page and one
   local development loop. *Rejected:* the Supabase hybrid, whose fan-out is
   metered *and* whose S=300 column depends on an unpriced negotiation past a
   published message-rate cap, which adds a pull-read tier for content it cannot
   safely push, and whose real migration is the field's largest freeze — 32–40
   engineer-weeks behind an "8–10 product-week" headline. *Rejected:* GCP, which
   scored as the runner-up on verified, boring, Terraformed infrastructure and
   the field's only structurally unmetered fan-out, but which requires the most
   bespoke distributed code — a relay tier, a Redis fan-out, and an
   Avalon-written revocation backstop — to reach what Convex gives as a platform
   property. GCP remains the named fallback if Phase 0 fails. *Rejected:* AWS,
   most technologies, highest normalized cost, the field's lowest turn ceiling,
   and a migration that strands the dictation bridge. *Rejected:* staying on
   D1 and Durable Objects, which the settled direction already excludes.
2. **Reactive query subscriptions are the whole realtime layer; the client
   cursor protocol is deleted, not ported.** Recovery is query recomputation,
   consistency across queries is a platform guarantee, and retraction is an
   epoch bump. *Rejected:* porting `WorkstreamRoom`'s checkpoint, replay,
   resync, and eviction protocol onto a new store, which keeps every failure
   mode Avalon currently owns while paying a migration for the privilege.
3. **Avalon mints its own JWTs; Convex validates them as a custom JWT
   provider.** The Global identity plane stays the one identity authority, the
   auth line is $0 at every scale, and no vendor sits between a person and their
   session. *Rejected:* an auth vendor (the field's comparable line is
   $488–$3,600/mo at 250k MAU), which would add a second identity authority, a
   MAU meter, and a federation spike to Phase 0 for no product gain.
4. **The Azure dictation Worker stays.** Convex terminates its own client
   sockets but does not proxy third-party ones, so one vestigial Cloudflare
   Worker keeps bridging dictation. *Rejected:* claiming a two-technology stack.
   The honest end-to-end count is about five — Convex core, its three newer
   components, the Electron client, the retained Worker, and Fivetran plus a
   warehouse — with OpenRouter and Daytona as external providers.
5. **SQL analytics come from a warehouse, not from the transactional store.**
   Convex's Pro streaming export through the vendor-maintained Fivetran
   connector feeds the warehouse; production questions in the meantime are typed
   TypeScript queries run through `npx convex run`. *Rejected:* scoring the
   substrate decision on ad-hoc SQL availability, and *rejected:* a read replica
   or SQL shim in front of a document store, which would create a second query
   surface with different authorization.
6. **Per-principal budgets use the rate-limiter component.** "Clients can only
   invoke exported functions" answers raw data-plane access, not what an
   authenticated-but-hostile client can spend at $2 per million calls. Every
   client-callable mutation and action is limited per principal and per
   workspace, and the limiter's counters are documents in the same transaction
   system. *Rejected:* treating the function boundary as sufficient, which the
   compliance gate identified as a silently skipped hazard and which is a cost
   exposure as much as an abuse one.
7. **A timer-driven watchdog, not token flow, bounds steering.** The turn action
   reads the steering document at every checkpoint commit, and a 500 ms timer
   forces a no-op checkpoint when no tokens arrive — provider stall, long tool
   wait, or slow first byte. The visible-halt bound is therefore one checkpoint
   interval in every case, not only while output is flowing. *Rejected:* the
   token-driven-only design, whose "≤500 ms, no lost notification" claim silently
   assumed a ticking checkpoint loop and left the stalled case unbounded.
8. **Streamed output is append-only delta chunks, sealed into one immutable
   part.** Each chunk is a small batched document keyed by turn and epoch; seal
   copies the accumulated text into the assistant part and tombstones the
   chunks. *Rejected:* a document per token, which multiplies write and index
   cost for no user benefit. *Rejected:* one mutable accumulating buffer
   rewritten every tick, which rewrites the whole buffer per checkpoint and
   makes retraction a rewrite rather than an epoch bump.
9. **The work-stream sequence is allocated by read-modify-write on the head
   document under optimistic concurrency control.** Contenders conflict on that
   document and retry, so commit order is sequence order and the
   late-commit-with-a-lower-number problem is structurally absent. *Rejected:* a
   separate counter service or monotonic-clock ordering, both of which
   reintroduce a gap between allocation and commit that Avalon would then have
   to detect and repair.
10. **The Workflow component drives full loops; no external orchestrator.** Run
    state, steps, waits, and the product data they describe are in one
    transactional system, so a driver binding, a data-minimality rule for
    orchestrator state, and a second vendor in every residency review all cease
    to exist. *Rejected:* retaining Cloudflare Workflows as the driver, which
    keeps a cross-system binding whose failure modes — instance lost, recreated,
    or holding state the database disagrees with — are exactly what this design
    is trying to stop owning.
11. **One model turn is one Convex-runtime action, and the runtime is a Phase 0
    gate.** Convex-runtime actions cap at 30 minutes; Node-runtime actions cap
    at 10. The kept agent-harness and Bind adapter code must run without
    `"use node"`, and Phase 0 verifies it before any migration work. A turn that
    exceeds 30 minutes aborts and retries from the last durable step, re-spending
    that provider call — a named regression against the current unbounded step,
    at tail frequency. *Rejected:* assuming the harness ports as "light edits",
    which would put a 10-minute ceiling under a ~10-minute requirement with zero
    headroom. If the gate fails, an external turn host is designed before
    committing, or the decision reverts.
12. **Launch Global (US East) only; EU is deferred and fail-closed.** The
    Ireland region is real and priced (+30% on resources, with Pro included
    allowances not applying), but no published DPA, subprocessor list, or
    contractual processing commitment was found. *Rejected:* treating region
    availability as residency compliance, which is the mistake this project
    cannot afford to make twice.
13. **Cutover is single-writer at approximately zero users, gated on the D1
    side.** The source-local authority gate remains the sole linearization
    point, exactly as the sibling PRD designs it; Convex is activated at the
    same epoch only after the gate closes. *Rejected:* a dual-write or
    shadow-authority period, which is the one migration shape that can produce
    two systems accepting canonical writes.

## Data model

Sketch level; the full document shapes, fields, and indexes are in
[`design.md`](design.md), which is normative for the schema.

| Area | Tables (documents) |
| --- | --- |
| Identity and tenancy | `platformIdentities`, `workspaces`, `workspaceMembers`, `resourceGrants`, `audiences`, `audienceMembers`, `retentionPolicies` |
| Work streams and sidebar | `workstreams` (head doc, card fields inline), `workstreamUserState`, `attentionEvents`, `partMentions`, `participants`, `assignments` |
| Conversation | `substreams`, `turns`, `parts`, `admissionBatches`, `admissionBatchTurns`, `deltaChunks`, `compactionJobs`, `compactionSources`, `promotions` |
| Runs | `runs`, `runStepRecords`, `runControl`, `runWaits`, `runWaitEvents`, `toolEffects`, `terminalSessions`, `terminalCommands` |
| Connectors and activity | `connectorInstallations`, `ingressReceipts`, `ingressConflicts`, `connectorResources`, `activityEvents`, `activityLinks`, `activityCursors` |
| Digests and suggestions | `digestSchedules`, `digestJobs`, `digests`, `suggestions`, `suggestionSources`, `suggestionFeedback` |
| Content and search | `contentRefs`, `storageReconciliation`, `searchDocuments`, `embeddings` |
| Operations | `commandReceipts`, `auditEvents`, `exportJobs`, `deletionJobs`, `importReceipts` |

Three documents carry the design:

- **The work-stream head document (`workstreams`)** is the serialization
  anchor. It holds the sequence allocator and latest sequence, the common
  revision, the control epoch and the stream epoch used for retraction, the
  authorization and context-scope epochs, and the denormalized sidebar card
  fields. Every append conflicts on it, which is what makes commit order equal
  sequence order and lets one transaction update the transcript and the sidebar
  together.
- **Delta chunks (`deltaChunks`)** are the streaming tier: append-only batched
  text keyed `(turnId, epoch, chunkNo)`, read by tail queries filtered on the
  head document's current epoch, and tombstoned when the turn seals into one
  immutable `parts` document.
- **The steering document (`runControl`)** is the single compare-and-set
  authority for interruption: control revision, requested boundary, requester,
  and authorization epoch. The turn action reads it at every checkpoint; a
  stale-epoch checkpoint cannot commit.

Nothing in the model is backfilled in place: the migration imports D1 rows into
new documents once, and the D1 schema is retired rather than evolved.

## Regional impact

Launch is one Global deployment in US East. A future EU deployment is a second,
independent deployment in Ireland with its own documents, functions, file
storage, search indexes, scheduled work, secrets, backups, and telemetry. A
workspace never spans deployments, and a deployment's region is immutable, so
fail-closed is the construction rather than a policy that must be enforced.

The thin Global identity plane keeps only opaque workspace and organization
IDs, the selected region, route epoch and lifecycle, invitations that must be
discoverable before a regional session exists, and billing references. It stores
no title, description, message, activity, suggestion, embedding, or personal
sidebar state. Because Avalon mints the JWTs, a person with workspaces in two
regions holds two regional sessions derived from one identity, and neither token
is accepted by the other deployment.

Region availability is not the residency claim. The EU build starts only after a
signed DPA, a reviewed subprocessor list, and written answers about where the
team and dashboard control planes process data; the same review must cover
backups, logs, and support access. EU pricing is +30% on resources with Pro
included allowances not applying, which is roughly +35–40% on that region's
usage lines and is budgeted at kickoff, not discovered. No cross-region content
path exists in either direction, and an EU-bound workload with no approved EU
path is refused rather than served from Global.

Singapore is an open risk, not a plan. Convex publishes no SG region; if the
owner's three-region target becomes a commitment before the region catalog
grows, that is a standing override toward the runner-up rather than something
this design absorbs.

## Security and trust model

Knowing a workspace, work-stream, substream, part, file, run, suggestion, or
vector ID grants nothing. Clients cannot read or write tables at all: the only
client-reachable surface is the set of exported functions, so **the function
layer is the authorization tier**, and every read path — sidebar, transcript,
streamed frame, text search, vector search — executes the same visibility helper
before returning a document. The roughly 460 hand-written tenancy predicates in
today's repositories collapse into those helpers, which is a reduction in the
number of places the rule can be written wrong, not a reduction in the rule.

Authorization freshness is a delivery property here. A subscribed query's read
set includes the caller's membership document, so the commit that removes a
person is the commit that re-executes their subscriptions; no join-time grant is
cached for a connection's life, and streamed content is checked per delivered
frame because checkpoints re-run the same tail queries. **This is the design's
strongest claim and its least verified one.** The vendor's own documentation
states same-snapshot delivery and cache sharing per identical query and
arguments; it does not state that caches are auth-scoped, that subscription
re-execution is driven by per-subscription read-set bookkeeping, or any latency
bound on delivery. Launch is gated on a written vendor confirmation and on
pilot measurement of the delivery bound. If the letter cannot be had, Avalon
adopts the bounded-staleness stance (≤60 s) instead, which on this substrate
costs nothing and changes no code — the same mechanism serves both stances.

JWT claims are identity hints, not live workspace authorization. Every strict
operation reads current membership, grants, and epochs inside its transaction.
Membership or grant removal increments the relevant epochs and immediately
blocks commands, materialization, search, previews, file reads, and signed URL
issuance, and invalidates in-flight run steps, compactions, digests,
suggestions, and vectors.

Per-principal rate limits apply to every client-callable function, so an
authenticated client cannot convert a valid session into unbounded spend or
unbounded load. Deploy keys, provider credentials, connector secrets, Daytona
credentials, and the Fivetran export credential live only in deployment
environment variables and never reach the desktop. Private content is filtered
before materialization, compaction, indexing, digests, suggestions, previews,
export, or logging; audience recursion intersects permissions and can never
broaden them. Operational logs and durable audit documents carry opaque IDs,
revisions, counts, hashes, durations, states, and redacted error classes — never
prompts, generated text, connector bodies, Terminal output, signed URLs, or
secrets.

## Agent behavior

The model receives one ordered, authorized message array at an immutable fence.
It never reads documents directly, never selects its own audience, and never
sees parts arriving after the admitted range. Current system policy, provider
configuration, tool catalog, approvals, and budgets are constructed at
projection time rather than preserved as an untrusted old system message. This
PRD adds no tool and changes no tool contract; the harness, its plugins, and
their wire shapes are unchanged, which is why the runtime-compatibility gate in
Phase 0 matters more than any porting work.

Spawning a sub-agent is one recorded lifecycle: append or plan the parent tool
call with a run- and step-scoped effect key; create one bounded child substream
with explicit task, inheritance, audience, depth, scope revision, and tool
policy; create a child run owned by that substream; execute it through the same
run contract, recording every child step and effect; append a terminal child
part and an authorized promotion or result; then append exactly one parent tool
result and settle the effect. A retry finds the same child and effect by causal
occurrence; equal tool input in a later model iteration is a new occurrence. A
fresh child gets only its task packet; a forked child gets the explicit frozen
lineage. Depth and breadth budgets prevent branch bombs.

A full loop is one Workflow instance with individually durable steps: one model
action, one tool action, one settlement, one reconciliation, one bounded context
operation. Explicit token, tool, cost, elapsed, idle, step, and child budgets
are enforced on every step transition, and platform maxima are never a substitute
for a product budget. Steering commits before any wake-up reaches the executor,
and correctness comes from the epoch checks at commit time rather than from the
executor having noticed.

The 30-minute Convex-runtime action ceiling is the one honest regression against
today's unbounded Workflow step. A model turn that exceeds it aborts and the loop
retries from the last durable step, re-spending that provider call. Three or
more such aborts in a week is a tripwire, and the fallback is an external turn
host for that one step — not a change to where product state lives.

Daytona workspaces, command caps, filesystem persistence, egress, secrets,
regional availability, and cost remain governed by the Terminal subsystem. A
closed desktop does not stop an admitted loop or keep a Daytona workspace warm.
Steering during a Terminal write prevents the next effect and reconciles the
current command by provider reference; it cannot erase filesystem or network
effects already made.

## Provider configuration

Outside the repository, per region:

- **Convex project and deployment** created with the region chosen explicitly
  (CLI region selection is not yet available; creation is a management-API or
  dashboard step), plus production and preview deploy keys minted in the
  dashboard and stored in CI.
- **Deployment environment variables** for OpenRouter, connector credentials,
  Daytona, telemetry, and the JWT issuer configuration, set through
  `npx convex env` and asserted by CI. There is no Terraform provider; this is
  the drift surface and it is checked rather than hidden.
- **Backup schedule** — dashboard-only, daily, with file storage included. A
  restore is a destructive wipe of the target deployment, so drills run quarterly
  against a scratch deployment, never against production.
- **Custom domain** for HTTP actions (webhook ingress) on the Pro plan, plus
  provider-side webhook URL changes for GitHub, Linear, Notion, and Resend, and
  the matching signature secrets.
- **Fivetran streaming export** connected to the warehouse, with its credential
  scoped to export only.
- **Deployment class and burst limits** — Pro serves 10k concurrent sessions;
  the dedicated D1024/D2048 classes are a sales conversation, named now so it is
  not discovered under load.
- **Cloudflare** keeps only the dictation Worker and its Wrangler configuration;
  Flagship keeps serving flags, including the rollout flag below.

If a provider webhook URL is not changed before cutover, that connector's
ingress stops at the retired Worker and the workspace's activity silently
stalls — so webhook reconfiguration is part of the cutover checklist, not a
follow-up.

## Rollout

Rollout is per workspace and reversible at every boundary before the authority
gate closes. D1 and R2 remain canonical until a workspace's gate closes exactly
once; Convex documents are never silently treated as authority.

The rollout flag is **`convex-data-plane`** — a boolean, default `false`,
evaluated per workspace. Per [`feature-flags.md`](../../feature-flags.md) it
lives in its own module beside `client-feature-flags.ts` rather than inside it,
because a data-plane authority flag is not a client feature and must fail
**closed to D1 authority** when Flagship is unreachable — the behavior an outage
has to reproduce is "this workspace still writes where it wrote yesterday". Who
is in the cohort is a Flagship targeting rule on the workspace, never a
condition in code, so a rollback is a flag change rather than a deploy.

### Phase 0 — the pre-registered gates

No migration work starts until these are settled. The thresholds are recorded
here so the pilot is a measurement rather than a debate.

1. **A one-week pilot at S≈5**, one engineer, on a real deployment, measuring
   three numbers against thresholds fixed in advance:
   - **push latency** — p95 commit-to-client update ≤1 s sustained at peak;
   - **metered spend** — within +50% of the cost model below, read directly off
     the usage dashboard;
   - **runtime compatibility (C9)** — the kept agent-harness and Bind adapter
     code runs in the default Convex runtime with no `"use node"`, preserving
     the 30-minute action ceiling.
2. **One vendor letter**, in parallel: written confirmation that subscription
   re-delivery after a revoking commit is authorization-fresh per frame,
   including caches and reconnects. This is the claim the vendor's public
   citations do not contain, and it decides whether the immediate-revocation
   stance is the launch stance or the bounded-staleness fallback is.
3. **DPA and subprocessor review scheduled** — not completed, scheduled, with an
   owner and a date — so the EU build has a gate rather than an assumption.

**If the pilot misses either measured axis, or the letter cannot be had and
immediate revocation is required, the decision reverts to GCP** as the recorded
runner-up, with its own two pre-launch gates (Redis throughput benchmark,
driver dispatch ≤1.5 s) and its fail-closed revocation rule. Enterprise
self-hosting becoming a near-term contractual requirement, or Singapore arriving
before Convex's region catalog grows, are standing overrides that point the same
way regardless of the pilot.

The cost model Phase 0 measures against: ~$675/mo at S≈20 as briefed, ≈$540/mo
under the normalized demand model, and ~$8–10k/mo at S=300, with the metering
assumption (whether every reactive re-run bills one function call) carrying ±2×
on the dominant lines. Halving the checkpoint cadence roughly halves the three
dominant lines, and that lever is configuration.

### Phase 1 — schema, functions, and the flag

Stand up the Global deployment. Land `convex/schema.ts`, the visibility helpers,
the command mutations, the query surface, HTTP actions for webhook ingress,
scheduled and Workpool jobs, the Workflow-based run driver, file storage,
search and vector indexes, the rate limiter, log streaming to the existing sink,
and the Fivetran export. Add `convex-data-plane` with no workspace in its
cohort. Nothing reads Convex as authority.

### Phase 2 — shadow build and invariant harness

For internal workspaces, import immutable history in hashed chunks and tail
current writes through an idempotent source outbox while D1 stays
authoritative. Shadow runs never invoke model or tool side effects. Compare
continuously: work-stream counts, identities, states, titles, timestamps;
collection and date-group membership and personal overlays; ordered parts, tool
pairing, substream lineage, audience, content hashes, and model materializations
at stable fences; run and effect terminal status without re-execution; connector
receipt and activity counts; digest and suggestion provenance; file manifests;
search and vector eligibility; retention exclusions. A mismatch quarantines the
workspace; it never self-heals by picking an authority.

### Phase 3 — client and realtime canary

Ship the `ConvexClient` renderer path for eligible internal workspaces with
reads served from Convex while writes stay on D1. Validate subscription
lifecycle, optimistic update replacement, background socket close and resubscribe
on focus, streamed delta cadence and epoch retraction, revocation behavior
against the Phase 0 letter, collection pagination, and measured fan-out spend
against the model. A flag flip rolls reads back without touching write authority.

### Phase 4 — bounded write cutover

Per workspace, at approximately zero users: hold source writes; drain the source
outbox to a final cursor; validate counts, hashes, materializations, sidebar
state, and file readiness; then in one D1 transaction seal the final and held
cursors and move the source-local authority gate from `source_holding` to
`source_closed` at the next epoch. That closure receipt is the sole
linearization point. Transfer and verify it in Convex, activate the workspace at
the same epoch, converge the Global route as a derived retryable copy, release
held commands to the Convex mutations in accepted order, and keep read-only
source evidence for the rollback window. A crash before activation is an
availability gap, never two writers. Once the gate closes it does not reopen at
that epoch.

### Phase 5 — runs, derived work, and source retirement

Move bounded compaction, embeddings, connector normalization, digests, and
suggestions onto scheduled and Workpool jobs with shadow comparison; then enable
the generic run schema for bounded model-only tasks; then canary full
work-stream and non-work-stream loops on the Workflow driver, including a
failure-injected 2+ hour session across a deploy. Expand by workspace cohort
with per-region pause, concurrency, backlog-age, error, and mismatch controls.
After every workspace passes its retention window and export, deletion, and
audit requirements, remove the D1 and R2 canonical writers and the retired
Worker routes, keeping only what the backup and legal policy requires.

### Rollback and disaster recovery

Before a workspace's gate closes, rollback is the flag. After it closes,
rollback is forward: a code rollback is redeploying the previous artifact, and a
data rollback is a backup restore, which is a **destructive wipe** of the target
deployment and therefore an incident action rather than a routine one. After any
restore, non-terminal runs, effects, scheduled work, file references, and
connector cursors enter reconciliation before admission reopens. A quarterly
drill exercises `npx convex export`, restore into a scratch deployment, and the
self-host path as the vendor-exit hedge.

### Tripwires

Instrumented from Phase 1 and reviewed monthly:

1. p95 commit-to-client update above 1 s sustained for a week at peak.
2. Reactive spend above $1,000/mo while S<50, or any month more than 50% over
   the cost model.
3. Three or more model turns per week aborted at the action ceiling.
4. No signable in-region DPA by EU-build kickoff — self-host EU or reopen.
5. A vendor-health signal (license change, pricing move above 25%, distress) —
   execute the rehearsed export and self-host drill within 30 days.
