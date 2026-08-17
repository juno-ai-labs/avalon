# Convex user-flow architecture stress studies

> Companion to [`prd.md`](prd.md), [`design.md`](design.md), and
> [`research.md`](research.md). These studies carry the same 75 IDs and the same
> study titles as the Supabase sibling PRD's
> [`flows.md`](../2026-08-15_supabase-workspace-workstream-conversations/flows.md)
> so a single acceptance suite can be mapped 1:1 across both proposals. The
> product contract is identical; only the substrate changes. Each study answers
> one question: is this flow possible on Convex, and where is it better or worse
> than on the sibling substrate?

## How to read these studies

- **Showcase** studies describe behavior the architecture should make clear,
  safe, or economical. **Break attempt** studies attack an invariant or an
  operational boundary; a correct explicit refusal can pass.
- Every study has a user-visible or operator-verifiable failure oracle. The
  oracles are unchanged from the sibling — the product contract is the same —
  so only the mechanism walk is restated here.
- Each study is written as **Scenario** (what happens), **Mechanism** (which
  Convex functions, tables, and components carry it, and which orders, fences,
  and retries protect it), **Outcome** (what the user or operator sees), and,
  where the two substrates differ materially, **Delta** — better, worse, or
  inapplicable, with the reason.
- Times are realistic design inputs: model time to first token is normally 1–5
  seconds; ordinary tools take seconds; Daytona Terminal p95 is under one minute
  and its tail may take 3–5 minutes or longer. A full loop is normally 2–30
  minutes and can rarely exceed two hours during coding or research.
- Scale values are stress fixtures, not launch commitments. Launch is one
  Global (US East) deployment; EU is deferred and fail-closed.
- Where a study depends on a claim that is not documented verbatim by the
  vendor, it says so and names the gate that closes it. Three gates recur: the
  **C1 vendor letter** (per-frame authorization freshness including caches and
  reconnects), the **C9 runtime question** (the agent harness must run in the
  default Convex runtime or the 30-minute action ceiling becomes 10 minutes),
  and the **pilot** (p95 commit→client push ≤1 s and metered spend within +50 %
  of the cost model, resolving assumption A5).

## Personas

| Persona | Context |
| --- | --- |
| Maya | Workspace owner responsible for access, retention, and a large team's sidebar |
| Priya | EU administrator responsible for residency and audit commitments |
| Mateo | Engineer using a laptop and an intermittently connected second device |
| Samantha | Project lead using shared conversations, private chats, and forks |
| Ren | Operator debugging failures and migrations without routine content access |
| Elena | Automation owner connecting Slack, Google, Linear, Notion, and email |
| Avalon | The inherent work-stream agent and its bounded sub-agents |

## Mechanism vocabulary

Restated once so the studies can stay short. All of it is fixed by the design
skeleton and the winning brief.

- **Mutations** are fully serializable transactions with automatic conflict
  retry. One mutation writes the message part, the work-stream card fields, the
  sparse per-member overlays, the activity row, and the idempotency receipt, and
  transactionally schedules the agent turn.
- **Queries** are the entire realtime layer. A subscribed query re-executes when
  a committed write overlaps its read set, and the new result is pushed. There
  is no hint layer, no cursor protocol, and no client-side patch application.
  Avalon's visibility helper runs inside every query, so the viewer's membership
  document is in every read set.
- **Head-doc ordering.** `workstreams` is the head document: `seq` allocator,
  `revision`, `controlEpoch`, `authEpoch`, and the card fields. Per-stream `seq`
  is a read-modify-write on that document under OCC, so commit order *is* `seq`
  order and the late-commit gap problem is structurally absent.
- **Streaming.** A turn action buffers provider tokens and commits an
  append-only `delta_chunks` document every 250–500 ms, keyed
  `(turnId, epoch, chunkNo)`. Seal copies the chunks into one immutable part and
  tombstones them. Retraction is a head-doc epoch bump under CAS; tail queries
  filter by the current epoch. An accumulated buffer is never rewritten.
- **Steering.** The steering document is the single CAS authority. The turn
  action reads it at every checkpoint commit, **and** a timer-driven watchdog
  fires a no-op checkpoint every 500 ms even when no tokens arrive, so the
  visible-halt bound holds during provider stalls and long tool waits. A stale
  epoch cannot commit.
- **Execution.** One Workflow-component instance per full loop (steps persist,
  survive restarts, retry per policy); one model turn is one Convex-runtime
  action (30-minute cap); the transactional scheduler plus the Workpool
  component is the queue; the rate-limiter component enforces per-principal
  budgets; the migrations component drives staged backfills.
- **Everything else.** Convex file storage for blobs; native text-search and
  vector indexes; HTTP actions on `convex.site` for webhook ingress; custom-JWT
  auth minted by Avalon's existing identity plane; Fivetran streaming export to
  a warehouse for SQL analytics; one retained Cloudflare Worker for the Azure
  dictation socket proxy.
- **Deploys** are one push carrying schema and functions together, schema-
  validated against existing data before activation. There is no separate
  migration step, so the window in which old code writes into a new schema does
  not exist.

## Showcase studies

### S01 — A shared investigation remains one ordered conversation

**Mode:** Showcase

**Scenario:** Samantha posts a diagnosis with a PDF, Avalon starts streaming
within 1–5 seconds, Mateo queues a correction mid-answer, and a third member
watches without ever posting. Everyone later reloads.

**Mechanism:**

- `messages.send` is one mutation. It reads the `workstreams` head document,
  allocates `seq`, and writes the `parts` row, the `files` reference, the
  attention rows for the audience, the card fields on the head document, and the
  command receipt — then calls `ctx.scheduler.runAfter(0, turns.run)`, which is
  guaranteed to be scheduled if and only if the mutation commits.
- Concurrent senders both write the head document, so OCC serializes them and
  retries the loser; commit order is `seq` order, with no gap window to repair.
- Mateo's correction commits as a part with `admission: "queued"`. The active
  turn's admission batch was fixed at its start, so a queued part cannot
  interrupt; the next batch picks it up by `seq` range.
- The viewer's subscription writes nothing. Presence is a short-TTL document
  outside the membership graph, so viewing creates no participant state.
- The projector is a query helper over complete turns; it never joins on arrival
  time and excludes dangling tool pairs.

**Outcome:** One committed order for everyone, one assistant result, the PDF
reference invisible until its file document is `ready`, and no divergence to
repair on reload — the reload is a query re-execution, not a replay.

**Delta:** Better. The sidebar card and the transcript are written in the same
serializable transaction and all subscriptions observe the same snapshot, so the
window of disagreement is zero by mechanism rather than by materializer
discipline.

### S02 — Unread and mentions follow the main-feed waterline

**Mode:** Showcase

**Scenario:** Three visible messages arrive and the second mentions Mateo. His
backgrounded second device is disconnected throughout. He reads on the laptop
and marks through attention ordinal 43; the second device wakes much later.

**Mechanism:**

- The append mutation writes attention and mention rows and upserts only Mateo's
  sparse overlay document — one write per interested member, not per workspace
  member.
- `markSeen` is a mutation that sets `seenOrdinal = max(current, requested)` on
  the member's overlay under OCC, so two devices racing cannot move the waterline
  backward, and it refuses an ordinal above the member's authorized visible
  waterline.
- The second device does not catch up. It re-subscribes, and the **Unread** and
  **You Are Mentioned** queries recompute from `(attentionOrdinal, seenOrdinal)`
  against current state; the cost is one query execution, independent of how long
  the device was away.

**Outcome:** Both collections show the mention until the authorized waterline
advances, both devices converge on the next push, and seen never regresses.

**Delta:** Better, and one whole failure class is inapplicable: there is no
Broadcast hint to miss, so "a missed socket loses the mention" has no mechanism
to occur through. Only the durable overlay documents carry meaning.

### S03 — A disconnected client rejoins an active stream exactly once

**Mode:** Showcase

**Scenario:** Mateo's network drops for eight seconds while Avalon streams. The
turn keeps committing checkpoints. He reconnects, and the run then seals one
assistant part.

**Mechanism:**

- The turn action buffers tokens and commits `delta_chunks` documents keyed
  `(turnId, epoch, chunkNo)` every 250–500 ms. No client cursor, byte offset, or
  coordinate hint exists anywhere in the design.
- On reconnect the `ConvexClient` re-subscribes; the tail query recomputes from
  the sealed parts plus the current epoch's chunks in `chunkNo` order and pushes
  one consistent result. A mid-stream joiner pays one O(buffer) chunk scan and
  then rides the deltas.
- Seal is a mutation that concatenates the chunks into one immutable part and
  tombstones them, so the completion is a single committed state, not an event
  that can be delivered twice.

**Outcome:** Text resumes at exactly the committed content with no visible
overlap, no duplication, and one completion.

**Delta:** Better, and the strongest single simplification in the proposal.
Reconnect is a query recompute rather than a cursor protocol, so the sibling's
subscribe-buffer-snapshot reconciliation, the provisional-overlap rules, and the
~200 lines of `WorkstreamRoom` checkpoint/replay/resync/eviction machinery are
deleted rather than ported. The arithmetic that could get reconnect wrong does
not exist.

### S04 — A private evidence chat cannot become shared history

**Mode:** Showcase

**Scenario:** Samantha opens a `private_chat` substream with an owner-only
audience and a frozen main-feed fence, asks Avalon about sensitive evidence, and
later promotes a deliberately redacted summary to main. Compaction, search,
digests, and sidebar previews run in between.

**Mechanism:**

- `substreams` carries `kind`, `audienceId`, and `baseSeq`. Clients cannot touch
  tables — they may only invoke exported functions — so every read path runs
  `visibleParts(ctx, viewer, …)`, the one helper the ~460 hand-written tenancy
  predicates collapse into.
- Text search is a query, so it runs the identical helper before returning rows.
  Vector search runs in an action with `filterFields` on audience plus a
  post-filter through the same helper, so a similarity hit cannot bypass it.
- Compaction artifacts, embeddings, digests, and previews are documents carrying
  `audienceId`, source part IDs, content hashes, and the `authEpoch` they were
  computed under; the projection query rejects any artifact whose audience does
  not match the reader.
- Promotion is a mutation that writes a new part into main containing the
  approved redacted text and a provenance link — it never widens the source
  part's audience.

**Outcome:** Only the promoted summary is shared. The substream ID is never
authority; audience is.

**Delta:** Neutral in strength, different in kind. There is no RLS backstop —
the enforcement is that the function layer is the only door. That is stronger
than a service-role bypass and weaker than a database-level deny; see B15.

### S05 — A fork preserves the exact completed past

**Mode:** Showcase

**Scenario:** Samantha creates two human forks at base sequence 120. Main
advances to 125 while both run. One fork is promoted; the other is abandoned.

**Mechanism:**

- Each fork is a `substreams` document with `baseSeq: 120` and an explicit
  `lineage` array. Context assembly reads parts with `seq <= baseSeq` on the
  parent lane plus the fork's own parts, so the frozen past is a query predicate,
  not a copy.
- Main's sequences 121–125 are ordinary appends on the same head document; they
  are invisible to the forks because they fail the `baseSeq` predicate, and no
  transcript is duplicated.
- Promotion is one mutation writing the promoted part, a `substream_promotions`
  record, and the card update; abandonment sets a status field and deletes
  nothing.

**Outcome:** Both forks see the identical frozen past, promotion carries
provenance, and abandoning one fork removes no canonical history.

**Delta:** Even. The sibling's design maps across unchanged; document references
replace foreign keys.

### S06 — Sub-agents branch without becoming sidebar conversations

**Mode:** Showcase

**Scenario:** Avalon starts three bounded investigations — one fresh, one forking
an exact context, one focused on a document — each settling one parent tool call.

**Mechanism:**

- Children are `substreams` of kind `subagent_fresh`, `subagent_fork`, and
  `document_chat` under the same work stream, at depth ≤4. Each child run is a
  Workflow-component instance whose `runs` document carries `ownerKind` and
  `ownerId`, so the generic driver is reused rather than re-implemented.
- The sidebar query selects root work streams only, so three children produce
  zero new cards.
- The parent's tool-call step writes an `effects` document with a causal
  idempotency key `(runId, stepId)`. A retry of that step finds the receipt and
  returns the existing child and its result instead of spawning a second one.
- A `subagent_fresh` child's context builder starts from an empty array and is
  handed no ambient credentials; credentials are resolved per effect from grants,
  not inherited from the parent action's closure.

**Outcome:** One sidebar card, three inspectable child lanes, and retry-stable
provenance.

**Delta:** Even, with a modest gain: the Workflow component supplies durable
child execution, so the child driver is configuration rather than code.

### S07 — Steering during time to first token interrupts cleanly

**Mode:** Showcase

**Scenario:** Mateo corrects a premise two seconds after sending. The provider
request has started but emitted no token, so nothing is streaming yet.

**Mechanism:**

- The steering mutation appends the correction part, allocates its `seq`, and
  bumps `controlEpoch` on the head document under compare-and-set — one
  transaction, so the message is committed before any acknowledgement.
- This is precisely the case the C6 fix exists for: no tokens have arrived, so a
  token-driven checkpoint would never run. The watchdog timer inside the turn
  action fires a no-op checkpoint mutation every 500 ms regardless of token flow;
  that mutation reads the steering document and returns the new epoch, and the
  action aborts the provider fetch.
- The stale attempt cannot seal: its seal mutation guards on `controlEpoch` and
  fails the CAS. Its `delta_chunks` (if any) belong to the retired epoch and are
  filtered out of every tail query by the same commit that bumped the epoch.
- The next admission batch includes the correction by `seq`, and the new turn is
  scheduled from the same mutation that opened the batch.

**Outcome:** The correction shows as committed and steering immediately; the
answer uses it once; the visible halt is bounded by one watchdog interval plus
one commit push, ≤1 s.

**Delta:** Better, conditionally. There is no cooperative low-latency path that
can be lost and no separate authoritative fence to fall back to — the same
mechanism is both. The ≤1 s number depends on the push latency the pilot must
measure; the vendor documents no delivery bound.

### S08 — Steering during an ordinary tool waits only as needed

**Mode:** Showcase

**Scenario:** Samantha steers while a read-only tool is several seconds into its
call. The effect is recorded as cooperatively cancellable.

**Mechanism:**

- The steering mutation bumps `controlEpoch`. The turn action is parked awaiting
  the tool, so again no token-driven checkpoint would fire; the 500 ms watchdog
  checkpoint is what observes the new epoch. This is the second case C6 named
  explicitly (long tool wait).
- The adapter cancels the tool where supported, or lets a short read finish. The
  settlement mutation writes the `effects` result with `admitted: false` — the
  physical result is recorded so the transcript is honest, but the projector
  excludes it from the next model context.
- No subsequent effect may start: `beginEffect` is a mutation that re-reads
  `controlEpoch` in the same transaction that records the intent, so a step
  planned under the old epoch cannot begin.

**Outcome:** A brief "interrupting" state, then a resumed answer that uses the
correction without pretending the tool never ran.

**Delta:** Better. The sibling needs Realtime run-control plus a database
revision CAS to cover the case where the fast path is lost; here the watchdog
checkpoint and the CAS are one mechanism, so there is no lost-notification case
to design around.

### S09 — A Terminal tail does not make steering disappear

**Mode:** Showcase

**Scenario:** Mateo steers during a Daytona command that runs four minutes and
may have filesystem effects; it cannot be assumed cancellable.

**Mechanism:**

- The command starts through `beginEffect` (mutation: intent + auth check +
  idempotency key) followed by an action that calls Daytona and records the
  provider command reference in the `effects` document.
- The Workflow step does not hold an action open for the command's duration. It
  parks on a `wait_events` document; a Daytona callback arrives at an HTTP action
  which writes that document, and a reconciler cron sweeps effects with no
  callback by querying provider status. Neither path depends on the client, the
  socket, or an action staying alive.
- The watchdog checkpoint keeps the steering document observed while the loop
  waits, so the correction is visibly acknowledged within the same ≤1 s bound
  even though nothing is streaming.
- No next effect begins under the retired epoch. Partial output and the final
  provider status are recorded; nothing claims the filesystem was rolled back.

**Outcome:** The message stays visible and the UI reports waiting on or
reconciling Terminal rather than losing the correction.

**Delta:** Even on semantics, better on shape: the sibling must fit the wait
inside an Edge or Workflow adapter lifetime and park before a runtime limit;
here the wait lives in the database as a document and no runtime holds it.

### S10 — An uncertain external write asks instead of guessing

**Mode:** Showcase

**Scenario:** Avalon posts to an external service that offers neither
idempotency nor a reliable lookup. The adapter crashes after sending; the
response is lost.

**Mechanism:**

- `beginEffect` committed `planned` and then `started` with the request hash
  before the call, so the intent is durable independent of the action.
- Actions are at-most-once and the Workflow retry layer makes the composite
  at-least-once, which is exactly why the receipt discipline is mandatory rather
  than defensive. The retried step reads the `effects` document, finds `started`
  with no settlement and no queryable provider reference, and refuses to re-send.
- It writes `outcome: "unknown"` and moves the run to `waiting_user` with reason
  `ambiguous_external_effect`; the sidebar family mapping puts the card in the
  intervention collection, not in ordinary active.

**Outcome:** The user sees the uncertain action and chooses. Nothing is silently
retried and no outcome is asserted without evidence.

**Delta:** Even. Serializable mutations make internal state atomic; they do not
make the outside world atomic, and the design says so.

### S11 — Shared provider ingress reaches one regional owner once

**Mode:** Showcase

**Scenario:** Elena connects a provider whose global webhook serves both EU and
US workspaces. It retries one signed event three times, and reconciliation later
observes the same provider ID again.

**Mechanism:**

- Webhooks land on an HTTP action at the owning deployment's `convex.site`
  domain. Because the installation's callback URL is minted per installation and
  points at its own region's deployment, no other region's ingress ever holds
  the body — routing is a URL property, not a forwarding hop.
- The handler verifies the signature, then runs one mutation that inserts into
  `ingress` under a unique index on `(installationId, eventId)` together with the
  body hash, and schedules normalization from inside the same transaction.
  Retries two and three hit the unique index and return the existing receipt
  without scheduling again.
- Normalization writes exactly one `activities` document keyed by the ingress
  receipt; reconciliation later finds that key and reuses the row.

**Outcome:** One activity with correct provenance and honest latency, no
cross-region copy, no duplicate suggestion.

**Delta:** Better on the enqueue seam — the scheduler is transactional with the
insert, so the classic "receipt committed but job never enqueued" gap is absent.
At launch this is single-region; the multi-region claim is a design claim gated
with S15.

### S12 — A planned automation work stream accepts pre-run collaboration

**Mode:** Showcase

**Scenario:** Elena schedules an automation. Two teammates add context before it
is due. The cron wake then admits everything in order, once.

**Mechanism:**

- The scheduled objective creates the work stream, root substream, and initial
  part in one mutation, and the card is listed as In Progress immediately.
- Teammate context arrives as ordinary queued parts with `seq` values from the
  head document; each one leaves the schedule untouched.
- A cron function calls a wake mutation that CASes the schedule document from
  `pending` to `admitting`. An overlapping cron tick loses the CAS and does
  nothing, so overlap cannot double-admit.
- The winning mutation snapshots the pending `seq` range into an
  `admission_batches` document and schedules the Workflow instance; the loop
  admits exactly that range.

**Outcome:** The work stream is collaborative before it runs and executes once
with all committed context in order; a planned work stream is never confused
with a suggestion, because a suggestion is a different table and never appears
in real collections.

**Delta:** Even. Cron is only a wake-up on both substrates; the CAS document is
the authority.

### S13 — A scoped export reflects the conversation model

**Mode:** Showcase

**Scenario:** Maya exports one work stream containing main and private
substreams, attachments, compactions, active and terminal runs, activity links,
and suggestions with different audiences.

**Mechanism:**

- The export mutation freezes a fence document holding `seq`, `authEpoch`, and
  the exporting principal's authority. Everything above the fence is omitted by
  predicate and named in the manifest as omitted.
- A Workpool of bounded mutations walks each family by indexed range, writing
  chunks into Convex file storage and a `receipts` row per chunk, so the job is
  resumable and can never double-append a chunk.
- Private lanes are included only where the export authority covers them; the
  same `visibleParts` helper decides, so an export cannot see more than a query
  could.
- Delivery is an action that re-checks live membership and then returns a
  short-lived storage URL. No URL is persisted in any document.

**Outcome:** A manifest that explains included, omitted, and lineage content,
with private material following export authority rather than workspace
membership.

**Delta:** Better on one operational detail: Convex backups are a consistent
snapshot of table data and can optionally include file storage, so exported
blobs and their references are covered by one mechanism instead of today's
separate R2 story.

### S14 — Work-stream deletion cannot be undone by a late event

**Mode:** Showcase

**Scenario:** Maya deletes a work stream while a run is executing and a connector
event is in flight. Derived jobs are queued and file-storage objects exist.

**Mechanism:**

- The deletion mutation sets `lifecycle: "deleting"` on the head document and
  bumps `authEpoch` and `controlEpoch` in the same transaction.
- Because the head document and the membership document are in the read set of
  every sidebar, card, and tail query for that stream, that one commit
  re-executes all of them and the card leaves every collection at a single
  consistent snapshot.
- Late work fails closed: run steps, completion mutations, suggestion promotion,
  and connector normalization all re-read `lifecycle` and `authEpoch` in their
  own transaction and abort. A scheduled job that wakes after deletion is not
  authority; the document it re-reads is.
- Physical deletion runs as scheduled mutations over indexed ranges, with
  file-storage deletion verified by its own receipts rather than inferred from
  document deletion.

**Outcome:** The card disappears immediately and cannot reappear, and deletion
is only declared complete when the storage receipts say so.

**Delta:** Better. There is no late hint that could resurrect a card, because a
card is a query result rather than a locally patched cache entry; the sibling's
"stale Broadcast recreates state" failure mode has no carrier here.

### S15 — An EU work stream never needs a Global content path

**Mode:** Showcase

**Scenario:** Priya audits an EU workspace end to end — messages, files,
connectors, vectors, realtime, and a long loop — and asks what leaves the
region.

**Mechanism:**

- Each region is a separate Convex deployment. A deployment's region is
  immutable and the vendor states that all infrastructure powering it is hosted
  in the selected region, so residency is a deployment boundary rather than a
  per-service configuration to audit one product at a time.
- The Global identity plane resolves only an opaque workspace-to-deployment
  route; it holds no title, body, overlay, or vector. The client obtains a
  region-scoped JWT and opens its `ConvexClient` socket directly to the EU
  deployment. Crons, Workpool jobs, file storage, search indexes, vector
  indexes, and env vars are all deployment-local.
- There is no cross-region content path to disable, because there is no
  mechanism by which one deployment reads another's tables.

**Outcome:** Every feature works inside one region, and an unapproved feature
fails closed because it has no deployment to run in.

**Delta:** Mechanically better (one boundary instead of per-product locality
review), contractually worse and explicitly gated. **EU is deferred at launch.**
No published DPA, subprocessor list, or contractual processing commitment was
found on the vendor's documentation, and whether the team and dashboard control
plane process any content outside the region is unknown. The EU build does not
start before a signed DPA and subprocessor review; EU pricing also carries +30 %
and no included allowances. Separately, Singapore has no Convex region today,
which is a named gap against the three-region ambition.

### S16 — Dormant work streams migrate without waking an entity fleet

**Mode:** Showcase

**Scenario:** Ren migrates millions of mostly dormant D1 work streams into
Convex, prioritizing active workspaces.

**Mechanism:**

- `npx convex import` loads exported D1 rows as documents in bounded chunks. A
  dormant work stream is a document; nothing is instantiated, leased, or woken,
  and no per-stream runtime exists to create.
- Shape changes ride the migrations component: a batched, resumable, idempotent
  migration function with both-shape-tolerant read code, so imported and native
  rows can coexist while the campaign runs.
- Throughput is governed by Workpool parallelism and watched as function calls
  and database bandwidth on the usage dashboard — the campaign's cost currency
  is spend and function concurrency, not primary CPU, locks, or WAL.
- Imported rows are shadow data: the `sourceAuthority` document still names D1,
  and every write mutation reads it, so nothing treats imported rows as
  authority before the source-side gate closes.

**Outcome:** Active use stays responsive while dormant data lands, and a dormant
stream behaves normally the first time it is opened after cutover.

**Delta:** Better than the Durable Object baseline for the same reason the
sibling is, and slightly better than the sibling: there is no shared primary to
protect from a bulk load, only a spend line and a concurrency class. Honest
limit: a deployment is one logical database, so the campaign has no shard to
spread across (B18).

### S17 — Non-work-stream loops share execution without sharing domain state

**Mode:** Showcase

**Scenario:** Elena's automation drafting loop and a meeting-summary loop run
concurrently through the same driver, each committing output only through its
own domain.

**Mechanism:**

- `runs.ownerKind` / `ownerId` make the driver owner-neutral. Both loops are
  Workflow-component instances with the same step, effect, and wait machinery;
  the component supplies durability, retries, and restart survival.
- Each domain exposes a narrow `internalMutation` that the driver calls to commit
  output. The driver is given no general-purpose write path and no domain table
  knowledge; terminal state is idempotent because the commit mutation is keyed
  by `(runId, stepId)`.
- Deploys do not disturb either loop: steps are persisted documents, and a new
  artifact resumes from the last durable step.

**Outcome:** Both loops survive retry and deploy identically, neither fabricates
a work stream, and neither can observe the other's state.

**Delta:** Worse in one respect, and it is the same gap as B15: Convex has no
database-level role separation, so "the driver may only call narrow domain
functions" is enforced by module visibility, validators, and review rather than
by a grant the database itself denies. The compensating gain is that there is no
service-role key that bypasses everything either.

### S18 — Teammates queue follow-ups and then steer one active loop

**Mode:** Showcase

**Scenario:** During a 12-minute investigation Samantha queues two follow-ups and
Mateo queues one; Mateo then sends an urgent steering correction.

**Mechanism:**

- All four messages are ordinary appends taking `seq` from the head document, so
  arrival order is fixed and total regardless of what the loop is doing.
- Steering is the separate axis: only the steering message bumps `controlEpoch`.
  Queued follow-ups never touch it, so a queue message cannot cancel active work.
- The active attempt stops at the next watchdog or token checkpoint, and its seal
  fails the epoch CAS. The next admission mutation writes one
  `admission_batches` document naming the exact eligible `seq` range under the
  product's ordering policy, so retry of that mutation reproduces the same batch
  rather than re-deciding it.

**Outcome:** Every committed message keeps a visible status, nothing disappears,
and one coherent resumed answer follows.

**Delta:** Even. The sibling's separation of arrival order from semantic
admission ports directly; the batch document replaces the batch row.

### S19 — Messages remain safe while compaction summarizes an older prefix

**Mode:** Showcase

**Scenario:** A compaction job freezes complete turns through sequence 900 while
users append 901–920 plus one steering message.

**Mechanism:**

- The job document freezes source part IDs, their content hashes, the audience,
  and the `authEpoch` at start. The model call itself runs in an action, outside
  any transaction.
- The completion mutation deliberately reads only the frozen source documents and
  the job document — not the head document. Tail appends write the head document
  and the new parts, so they do not overlap the compaction's read set and cannot
  cause an OCC conflict in either direction. Sending is never blocked.
- Completion re-verifies every hash and epoch and CASes the job to `applied`. The
  projector then uses the summary through 900 plus the live visible tail; source
  parts are retained, never deleted.

**Outcome:** No message is lost, duplicated, or absorbed into the summary, and
sending stays available throughout.

**Delta:** Better in kind. Because conflict detection is per-document rather than
per-table, a long derived job and a hot append path can be made provably
non-conflicting by choosing what the job reads — there is no lock, no WAL
contention, and no vacuum debt to tune.

### S20 — Sidebar and home share one work-stream-of-interest projection

**Mode:** Showcase

**Scenario:** Maya has pins, unread streams, mentions, input requests, accepted
suggestions, and recently opened streams. A mention, a completion, and a pin
change commit while she watches both surfaces.

**Mechanism:**

- Both surfaces subscribe to the same exported query, `workspace.interest`, with
  different arguments. Common card fields live on the head document; personal
  bits live in the member's sparse overlay; the query joins them by index.
- Every writer updates the card fields in the same transaction as the underlying
  change, so a card cannot lag the transcript.
- All of a client's subscriptions receive updates reflecting the same database
  snapshot, so the two surfaces cannot be updated out of step with each other.

**Outcome:** Collection counts and cards agree everywhere and stay stable under
reload and pagination.

**Delta:** Better, and this is one of the clearest wins. The sibling needs common
and personal revision envelopes plus durable events precisely because a hint can
be lost and two materializers can disagree; here there are no hints, no
revisions to compare, and no second materializer — one query function is read by
both surfaces, and the platform's cross-query snapshot consistency does the rest.
The cost is moved rather than removed: every interested member's projection
re-runs on each commit, which is assumption A9's budget line and grows with
online members × commit rate.
