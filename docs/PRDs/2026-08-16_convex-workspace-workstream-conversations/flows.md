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

### S21 — Unclaimed connector activity becomes one suggested work stream

**Mode:** Showcase

**Scenario:** A cluster of related connector events shares an authorized
opportunity key with no existing work stream. Maya accepts the resulting
proposal, and her client retries the click.

**Mechanism:**

- Detection is a mutation that freezes the source watermark and inserts one
  `suggestions` document under a unique index on the opportunity key, so two
  detectors racing produce one suggestion.
- Suggestions live in their own table and are never returned by the real
  collection queries, so a proposal cannot appear as work before acceptance.
- Acceptance is one mutation: it re-validates source access, creates the work
  stream head, root substream, initial parts and card fields, records the
  acceptance receipt keyed by the client's operation key, and schedules the first
  run — atomically.
- The retried click presents the same operation key, hits the receipt, and gets
  the same work-stream ID back.

**Outcome:** One real work stream at acceptance, carrying its source context,
with no duplicate and no window in which a card exists without a run queued.

**Delta:** Better on the handoff: the scheduler call is inside the acceptance
transaction, so the sibling's "acceptance committed but the run enqueue failed"
branch does not exist (see B31).

### S22 — Suggested context becomes a targeted action in an existing stream

**Mode:** Showcase

**Scenario:** Mateo is shown a private suggested action derived from activity he
can see but other participants cannot; he accepts a redacted, authorized target
action inside an existing shared work stream.

**Mechanism:**

- The suggestion document carries a personal `audienceId`. Other members'
  suggestion queries filter on audience, so nothing about it is computed, cached,
  or pushed to them — the suggestion is not merely hidden in the UI, it never
  enters another member's query result.
- Acceptance is a mutation that re-checks Mateo's access to every source, writes
  the disclosure-bearing part (the redacted representation only), and records the
  effect intent in the target work stream under an idempotency key.
- Execution follows the generic effect receipts; the private source text is
  never copied into the shared part, the card preview, or the model context for
  the shared lane.

**Outcome:** Other users see nothing until the accepted action produces
authorized shared history, and a double-click produces one effect.

**Delta:** Even. Audience is a first-class filter on both substrates; here it is
a predicate inside the query function rather than an RLS policy.

### S23 — An additive schema change remains online

**Mode:** Showcase

**Scenario:** Ren adds a nullable work-stream card field while old and new client
versions coexist.

**Mechanism:**

- The field is added to `convex/schema.ts` as an optional property and shipped in
  the same push as the functions that write it. The push validates the new schema
  against existing data before activating, and rejects the deploy if any existing
  document would violate it.
- There is no DDL, no table rewrite, no lock, and no backfill requirement:
  documents without the field simply lack it, and readers treat absence as the
  default.
- Rollback is redeploying the previous artifact. The deploy is online and its
  blast radius is the one deployment.

**Outcome:** No maintenance screen, no per-work-stream wake-up, and cards stay
readable throughout.

**Delta:** Better, and this is a documented structural claim rather than an
operational practice: because schema and functions ship as one push, **today's
window in which old code writes into a new schema does not exist**. The sibling
must manage that window with expand-contract discipline and lock timeouts; here
there is no separate migration step to order wrongly. What replaces the risk is
a deploy that fails validation (blocked push) and index backfill time on large
tables (B43).

### S24 — A regional sweep backfills online and pauses safely

**Mode:** Showcase

**Scenario:** Ren backfills a new content hash across 50 million documents and
pauses partway when interactive latency rises.

**Mechanism:**

- The migrations component drives the sweep: a batched, resumable migration whose
  cursor and state live in a document, processing a bounded indexed range per
  mutation so each batch stays inside the per-transaction read and write limits.
- Pause is a state change on that document, checked at the start of every batch;
  an in-flight batch finishes and commits, and no new batch claims work. Resume
  continues from the stored cursor, and re-running a batch is idempotent because
  the write is a deterministic function of the source document.
- Throttling is Workpool parallelism plus batch size. There are no locks to
  contend, no connection pool to exhaust, and no `SKIP LOCKED` claim protocol —
  the cursor is the claim.

**Outcome:** Interactive use stays responsive, no content changes inconsistently,
and pause has an explainable bounded edge.

**Delta:** Better on mechanism, worse on observability: what to watch is function
calls, read-document counts, and OCC conflict rate on the dashboard and in
`npx convex insights`, not query plans and lock waits. The pause signal must be
chosen from those metrics (P1).

### S25 — D1 and R2 data copy while held writes remain durable

**Mode:** Showcase

**Scenario:** Maya's active workspace is cut over from D1/R2 to Convex after its
shadow copy validates.

**Mechanism:**

- The design is inherited from the sibling deliberately: **the D1-side gate row
  remains the linearization point.** The source Worker establishes a bounded
  write hold, accepting commands into an outbox and returning explicit
  saving/backpressure status rather than false success.
- Remaining D1 rows and R2 objects are copied and hashed: bulk via
  `npx convex import`, the final delta via idempotent mutations keyed by source
  row identity. Blobs are re-uploaded into Convex file storage and their
  documents record the hash.
- One source-D1-local transaction closes the authority gate at a new epoch and
  records the final and held cursors. Only then does a Convex mutation that
  *verifies that closure receipt* flip the `sourceAuthority` document to
  `convex`; every Convex write mutation reads that document, so before the flip
  the destination refuses writes outright.
- Held outbox commands replay into Convex through mutations keyed by their
  original operation keys, so replay is exactly-once at the semantic level.
- Cutover happens at approximately zero users, which shortens the hold; it does
  not replace the gate.

**Outcome:** A short explicit saving delay is possible, and every acknowledged
write appears exactly once afterwards.

**Delta:** Even by construction — the cross-system half of this problem is not a
Convex property, so the sibling's design is adopted rather than improved. The one
gain is on the destination side: import, delta, and activation are transactions
in a single logical database, so there is no destination-internal partial state
to reconcile.

### S26 — Clients and drivers learn a new protocol before it is required

**Mode:** Showcase

**Scenario:** Ren ships a new event and step representation while runs and
desktop clients from the previous release remain active for hours.

**Mechanism:**

- Backend-internal skew is structurally reduced: schema, functions, crons, HTTP
  routes, and component configuration ship in one push, so there is no window in
  which a new writer and an old reader are both live inside the deployment.
- The remaining skew surfaces are real and handled explicitly: Electron clients
  hold the previous function contracts, and Workflow steps persisted by the old
  artifact are resumed by the new one. Document shapes expand with optional
  fields; argument validators accept both versions during the expand phase;
  `steps.version` is stored and the step mutation refuses a version it does not
  implement, parking the run in `waiting_upgrade` instead of misinterpreting it.
- Contract happens in a later release after active-version drain, verified by a
  query over nonterminal runs and connected client versions.

**Outcome:** Active runs and sockets survive the deploy; an incompatible client
gets an explicit upgrade prompt rather than a corrupt view.

**Delta:** Better on the server side (one push, no ordering to get wrong), and
the client protocol is now the vendor's rather than ours, so there is one fewer
bespoke wire format to version. Our document and step versions still need the
same discipline.

### S27 — An EU migration wakes only regional data workers

**Mode:** Showcase

**Scenario:** Priya watches an EU-only backfill and asks what touched it.

**Mechanism:**

- The EU deployment owns its own crons, Workpool, migrations-component state,
  file storage, search and vector indexes, env vars, and log stream sink. A
  scheduled function in one deployment cannot enqueue into another.
- Job payloads carry only local document IDs; content is loaded from EU tables
  inside the EU functions, so no body ever transits a shared queue.
- Metrics and logs follow the deployment's configured log stream, which is
  itself part of the regional review.

**Outcome:** The backfill completes with no Global content copy and no always-on
external control server.

**Delta:** Mechanically better (regional isolation is the deployment boundary,
not a per-function region flag to set correctly), and gated exactly as S15: the
EU build is deferred behind the DPA and subprocessor review, and dashboard and
support-plane locality is an open contractual question, not a design question.

### S28 — One multiplexed socket covers a foreground workspace

**Mode:** Showcase

**Scenario:** Mateo can see 2,000 work streams but has two open. He backgrounds
the app and returns.

**Mechanism:**

- The renderer holds one `ConvexClient` and therefore one WebSocket, multiplexing
  every subscription. The menu-bar process uses the HTTP client and holds no
  socket.
- The subscription set is small and explicit: the workspace interest query (one,
  paginated), the two open streams' tail queries, and the personal overlay query.
  Closing a stream unsubscribes; there is no per-stream channel, no channel
  budget, and no topic-join arithmetic.
- Backgrounding drops the foreground subscriptions and may close the socket
  entirely; returning re-subscribes and each query recomputes from current state,
  costing one execution per subscription regardless of how long the app slept.

**Outcome:** The sidebar stays current, open streams are live, and focus recovery
is smooth without reconnect churn or catch-up fetches.

**Delta:** Better on the connection model (no 100-channel-per-connection budget
to design against), but the discipline moves rather than disappears: **idle
subscriptions cost function calls**, because every commit re-runs each subscribed
query. Subscription hygiene is now a cost control, not just a memory control, and
it is one of the pilot's measurements.

### S29 — UI frames and durable checkpoints keep independent time

**Mode:** Showcase

**Scenario:** A fast model emits 80 token fragments per second with two
foreground viewers; one disconnects between checkpoints.

**Mechanism:**

- Cadence is ours, not the model's: the action buffers tokens and commits one
  `delta_chunks` document every 250–500 ms. Tokens never become documents, and
  the commit rate is fixed by configuration rather than by load.
- Each commit re-runs the subscribed tail queries and pushes results. There is no
  separate hint frame and no client fetch, because content rides the socket
  already authorization-checked per delivered frame — which also means the
  sibling's "faster body frames need a proven revocable stream lease" design
  problem does not arise.
- Reconnect is S03's mechanism, so there is no bounded-overlap reconciliation to
  tune; the seal mutation produces the one final text.

**Outcome:** Both viewers perceive fluid output, recovery loses nothing committed,
and the final text is one attempt's.

**Delta:** Better in design, and the cost currency changes: the meter is billed
function calls (one checkpoint mutation plus one query re-run per subscriber
under assumption A5) plus database bandwidth and egress, rather than Realtime
messages and WAL. That assumption is the largest single uncertainty in the cost
model (±2× on the dominant line) and is what the pilot measures. The per-frame
authorization property is the C1-gated claim.

### S30 — An exceptional transform uses bounded queue slices

**Mode:** Showcase

**Scenario:** Ren must parse a very large import that does not fit in one
function's budget.

**Mechanism:**

- Staging chunks are immutable objects in Convex file storage; a coordinator
  document records the chunk list, per-range status, counts, and hashes.
- Parsing runs in actions (Convex runtime, 30-minute ceiling, streaming reads
  from file storage so nothing unbounded is held in memory); committing runs in
  mutations over small ranges that stay inside the documented per-transaction
  read and write limits. Exceeding those limits fails the transaction loudly
  rather than degrading silently, which is a useful property for a batch-size
  search.
- Workpool parallelism bounds how much of the deployment's function concurrency
  the campaign may consume, keeping interactive traffic ahead of it.
- Progress lives in documents, never only in a coordinator process.

**Outcome:** The transform progresses without an always-on server and without
starving interactive work.

**Delta:** Even in shape; the constraint changes name from "Edge CPU budget" to
"action wall-clock ceiling plus per-transaction read/write limits". One
indivisible transform larger than a single action's ceiling would still force a
runtime-scope decision (P2).

### S31 — A thirty-minute agent loop spans durable actions

**Mode:** Showcase

**Scenario:** Avalon runs a 30-minute investigation with 12 model calls, ordinary
tools, and two Daytona commands. The client closes partway through.

**Mechanism:**

- Admission creates the run and the batch and starts one Workflow-component
  instance. Workflow steps persist to the database, survive server restarts, and
  carry per-step retry policies, so the loop's lifetime is not any process's
  lifetime.
- Each model turn is one Convex-runtime action within the 30-minute cap; each
  tool and effect settlement is a bounded step through a mutation. No step holds
  customer content as opaque orchestrator state — the documents are the state and
  the workflow holds identifiers.
- Client presence is irrelevant: no socket owns cancellation, and closing the app
  changes nothing about the run.
- Terminal completion is one mutation sealing the part, the card fields, and the
  activity row, guarded by the run's epoch so a superseded attempt cannot seal.

**Outcome:** Reopening shows exact progress and one final state; no action
repeats across deploy or retry.

**Delta:** Better than hand-building a driver — durable execution is a supported
component rather than our code. Two honest debits carry into B44: a single model
turn longer than 30 minutes aborts and retries from the last durable step,
re-spending the provider call; and that 30-minute figure holds only if the
harness runs in the default Convex runtime (**C9**) — a `"use node"` dependency
drops the ceiling to 10 minutes, which is a Phase-0 blocker with an external turn
host as the fallback design.

## Break-attempt studies

### B01 — The regional primary becomes the hottest object

**Mode:** Break attempt

**Scenario:** Maya's 100,000-member workspace generates constant card and
attention changes while connectors ingest bursts; thousands of work streams
update concurrently.

**Mechanism:**

- Conflict detection is per-document, not per-table. Each work stream's appends
  serialize on its own head document — which is the intended total order — and
  two different work streams never conflict, so there is no shared sequence
  object and no `workspaces` row that every append writes.
- The workspace document is deliberately kept out of the hot path: card fields
  live on the work-stream head, and workspace-level counts are computed by query
  from indexed ranges rather than maintained as counters.
- Derived work (connectors, embeddings, digests) runs through Workpool with
  bounded parallelism so it cannot consume the deployment's function concurrency
  ahead of interactive mutations.
- The real ceilings are named, not hidden: billed function calls grow linearly
  with commits × subscribers, and the deployment class caps concurrent function
  executions and concurrent sessions (10 k on Pro). Past the cap the documented
  behavior is queued execution — graceful slowdown — with dedicated D1024/D2048
  classes available through sales.

**Outcome:** Interactive mutations stay within SLO or degrade as queueing rather
than errors, and one workspace does not serialize all streams.

**Delta:** Better on the write-contention question (no shared primary, no locks,
no WAL, no vacuum), worse on diagnosis and on the far ceiling: there is no SQL,
so hotspot analysis is `npx convex insights` OCC-conflict reports plus log
streams, and a deployment is one logical database with no published shard story
inside it — see B18.

### B02 — Per-person sidebar state becomes a Cartesian product

**Mode:** Break attempt

**Scenario:** 100,000 members, one million historical work streams, and a
workspace-wide event on a popular stream. Most people interact with a small
subset.

**Mechanism:**

- The event writes **one** document — the work stream's card fields — plus sparse
  attention rows for the audience that actually needs them. No design path exists
  in which a common change upserts 100,000 overlay rows.
- Absence is defined: a missing per-member overlay means "never opened", and the
  unread query treats it as such rather than as ambiguous.
- The Unread and mention queries are indexed joins between the member's own
  overlay documents and the current sidebar page, bounded by page size and
  therefore bounded by the per-transaction read limits.
- Exact counts beyond the page are capped or computed lazily; the cap is a
  product decision, and the query fails loudly rather than scanning if a
  developer writes an unbounded one.

**Outcome:** Attention stays correct with no write spike and no storage
multiplication.

**Delta:** Better on writes, and the sibling's core worry — synchronous fan-out
writes — is inapplicable. But the cost does not vanish, it changes currency: each
online member's projection **re-runs** on the commit, so a popular stream in a
100,000-member workspace becomes a read-amplification and billing question rather
than a write-amplification question. Assumption A9 names this line and says it
becomes its own budget at roughly 500 online members per workspace; muting,
collection scoping, and page size are the levers.

### B03 — Membership is revoked while a private channel is joined

**Mode:** Break attempt

**Scenario:** Priya removes a contractor whose desktop is connected and
subscribed, holding a JWT minted minutes ago. New messages arrive immediately
after removal.

**Mechanism:**

- Revocation is native rather than layered. Avalon's visibility helper executes
  inside every subscribed query, so the contractor's membership document is in
  every one of those queries' read sets; the commit that removes it is itself the
  trigger that re-executes them, and the re-executed result is empty or denied.
- No join-time grant is cached for the connection's life: there is no channel
  authorization step separate from the query execution that produces the content.
- The stale JWT is irrelevant to authorization: it authenticates a principal;
  every function still reads the membership document. Token TTL remains short as
  defence in depth, not as the fence.
- Streamed tokens flow through the same mechanism, because a checkpoint commit
  delivers content only by re-running the tail query.

**Outcome:** New content and new commands are denied at the first execution after
the revoking commit; residual exposure is the delivery latency of the final
excluding update plus text already rendered on screen.

**Delta:** Better in mechanism than any cached-authorization design — and
explicitly **gated**. Per challenge C1, the precise composite guarantee this
study relies on (no result computed at a pre-revocation snapshot is newly
delivered, including from response caches and across reconnects) is not stated
verbatim in vendor documentation; the cited pages support it but do not say it.
Launch is therefore conditioned on a written vendor confirmation plus a pilot
measurement of the delivery bound. The fallback stance — bounded staleness ≤60 s
— costs $0 and requires no design change, because content on the socket is
authorization-checked per frame either way.

### B04 — Realtime hints arrive late, out of order, and after deletion

**Mode:** Break attempt

**Scenario:** A title change, run state change, mention, completion, and deletion
commit in rapid order; the sibling's clients receive duplicated, permuted, and
missing hints.

**Mechanism:**

- **Inapplicable: there is no hint layer to corrupt.** Nothing on the wire is a
  replacement instruction. Subscriptions carry recomputed query results at
  consistent database snapshots, so there is no ordering to permute, no envelope
  to drop a field from, and no cursor gap to detect.
- The deletion commit re-executes every affected query; the last thing any client
  can receive for that stream is its absence.
- The residual risk moves entirely into the client's optimistic-update layer:
  an optimistic mutation result must be rolled back when the authoritative query
  result arrives. That is `ConvexClient` behavior we configure, not a protocol we
  design, and it is what the client test suite asserts.

**Outcome:** Both surfaces converge to deleted or hidden; no private patch can
cross users because no patch exists.

**Delta:** Better, by deletion of the problem. This study and B05 are the two
places where the sibling's most intricate client machinery has no counterpart
here.

### B05 — Realtime is unavailable but Postgres is healthy

**Mode:** Break attempt

**Scenario:** The sibling's split-service partial outage: commands still commit,
but push delivery is down.

**Mechanism:**

- The premise does not decompose the same way. Query delivery and mutation commit
  are the same service over the same socket, so the sibling's asymmetric state
  cannot occur. There is no Broadcast that could fail while the write path is
  healthy, and delivery was never the outbox authority to begin with.
- What can happen instead: the client loses the socket. `ConvexClient` queues
  optimistic mutations, retries with backoff, and re-subscribes; on reconnect the
  queries recompute, so nothing committed is lost and nothing needs replay.
- What can also happen: the deployment itself degrades, in which case reads and
  writes degrade together and the app is honestly offline for that region.

**Outcome:** The sender never sees a false commit, and recovery is automatic
rather than a degraded polling mode to design.

**Delta:** Mixed, and this is one of the honest losses. Better: no
"committed-but-undelivered" state and no separate degraded-polling cadence to
build or pay for. Worse: **failure is correlated.** The sibling can serve durable
reads while its realtime layer is sick; here one deployment is one failure
domain, so there is no half-degraded mode to fall back into and no in-region
component we can fail past. This is a deliberate trade of decomposability for
the elimination of the divergence class, and it belongs in the weaker register.

### B06 — Two clients reuse one idempotency key with different bodies

**Mode:** Break attempt

**Scenario:** Mateo's two offline clients share an operation key; one posts
"ship", the other "do not ship".

**Mechanism:**

- The send mutation writes a `receipts` document under a unique index on
  `(scope, operationKey)`, storing the request hash, in the same transaction as
  the message part. There is no window in which the message exists without the
  receipt.
- The second request's insert fails the unique index; the mutation reads the
  existing receipt, compares hashes, and — because they differ — returns a stable
  idempotency-conflict error rather than the first result.
- Serializable execution means the two mutations cannot interleave into a
  last-write-wins outcome, and the key is scoped, so unrelated actions sharing a
  hash are never conflated.

**Outcome:** The second body is never silently substituted or accepted as the
first; the client asks the user before minting a new key.

**Delta:** Even. The mechanism is the sibling's, expressed as a unique index
instead of a constraint.

### B07 — A crash leaves a tool call without a result

**Mode:** Break attempt

**Scenario:** The tool-call part and its effect are committed; the process dies
before the result settles.

**Mechanism:**

- The Workflow instance's retry policy re-enters the step. The step mutation
  reads the `effects` document keyed by `(runId, stepId)` — a causal key, not
  tool-plus-input — and finds it `started` with a provider reference.
- The step queries the provider where possible and appends exactly one result or
  error part; where the provider cannot be queried it records `unknown` and hands
  the decision to S10's path.
- The projector query excludes dangling tool pairs from model context, so a call
  without a settled result never enters provider input, and a user message
  arriving between the call and the late result is not projected between them.

**Outcome:** The transcript shows one honest settled result rather than a repeated
invisible tool action.

**Delta:** Even. Note the platform-specific reason the receipt is mandatory:
scheduled actions are at-most-once and the Workflow retry layer makes the
composite at-least-once, so idempotency is a design obligation the substrate
states plainly rather than one we discovered.

### B08 — Compaction launders private content across audiences

**Mode:** Break attempt

**Scenario:** A compactor that can read both a private chat and shared main
history produces a summary; afterwards, access changes.

**Mechanism:**

- The compaction artifact document carries `audienceId`, the exact source part
  IDs and content hashes, the workspace and work-stream `authEpoch`, and any
  resource revisions. The cache key is never content-only.
- The projection query validates all of it before using an artifact; a mismatch
  causes the artifact to be ignored and a safe recompaction to be scheduled from
  the same mutation.
- Derived indexes carry the same fields: embeddings documents include audience
  and epoch, vector search filters on them via `filterFields`, and the
  post-filter runs the same visibility helper, so a similarity hit cannot return
  what a query would refuse. Text search is a query and is therefore already
  inside the helper.
- Source deletion tombstones dependent artifacts and their embeddings by indexed
  sweep in the same scheduled deletion campaign.

**Outcome:** No private fact appears in another audience's projection, preview,
snippet, or vector result — not even as paraphrase.

**Delta:** Even on strength, with one structural advantage: there is no separate
search service holding its own copy under its own authorization, so "search under
the same authz" is not an integration to verify but the same function body.

### B09 — A live document changes beneath its chat

**Mode:** Break attempt

**Scenario:** A run materializes document version 7 while a connector ingests
version 8 and tombstones a referenced section; the run then tries to commit.

**Mechanism:**

- `substreams.resourceRevision` records what the lane is pinned to, and each step
  stores the revision it read. Ingest of version 8 writes a new resource document
  and bumps the revision.
- The commit mutation re-reads the resource document and CASes on the revision it
  started from. It either fails — and the step is retried against version 8 — or,
  under an explicitly frozen-version policy, commits with a visible
  "answered against version 7" provenance label.
- Tombstoned sections fail the visibility helper at materialization time, so a
  revoked section cannot be quoted even when the pin says version 7.

**Outcome:** The answer is honestly tied to version 7 or rerun; it never
masquerades as current.

**Delta:** Even. The retry semantics are cleaner in one respect: OCC already
expects and retries conflicting commits, so a losing commit is a normal path
rather than an exceptional one.

### B10 — Referenced content is huge, corrupt, or unavailable

**Mode:** Break attempt

**Scenario:** A transcript references an attachment that may be missing,
wrong-sized, hash-mismatched, or too large for the model or the runtime.

**Mechanism:**

- The `files` document is authority (state, size, content type, hash); Convex
  file storage supplies bytes. Materialization happens in an action, which
  streams and verifies within per-kind size and type policy — bytes never enter a
  mutation, whose argument and document limits would reject them anyway.
- Authorization is checked on the referencing document before any byte is read;
  storage IDs are opaque and unguessable, and no path is constructed from user
  input.
- Failure produces an explicit content-error part or an approved, authorized
  fallback; an orphan or hash mismatch schedules a repair job with its own
  receipt.

**Outcome:** The run asks for repair or labels a safe fallback; corrupt bytes
never reach the model and evidence is never silently dropped.

**Delta:** Even, with a small operational gain: backups can include file storage,
so a repair campaign has a consistent restore point for both the reference and
the bytes.

### B11 — A provider reuses a delivery ID with different bytes

**Mode:** Break attempt

**Scenario:** A second signed delivery arrives with an already-accepted
installation and event ID but a different body hash.

**Mechanism:**

- The ingress mutation attempts the insert under the unique index on
  `(installationId, eventId)`. The insert throws; the mutation catches, reads the
  canonical receipt, and compares hashes.
- Matching hash means retry: return the existing receipt, schedule nothing.
  Differing hash means collision: write an immutable `ingress_conflicts` document
  holding the second hash and body reference. The canonical receipt is never
  mutated and never overwritten.
- Conflicts are not scheduled for normalization, so they cannot loop through the
  Workpool; they surface to operators through a query and the log stream.

**Outcome:** Existing activity is stable, no duplicate or mutated suggestion
appears, and the second body is preserved as evidence.

**Delta:** Even. Serializable mutations make the "check then insert" pattern safe
without an explicit lock.

### B12 — Workspace export and deletion stress one shared database

**Mode:** Break attempt

**Scenario:** Maya exports and then deletes a workspace with 50 million events
and many stored objects while other tenants work.

**Mechanism:**

- Both campaigns are Workpool-driven sequences of bounded mutations over indexed
  ranges, each writing a receipt, each resumable. Export is fenced (S13);
  deletion closes admission first (S14).
- Cross-tenant isolation is favorable here: transactions conflict only when they
  touch the same documents, so a tenant-wide sweep cannot block another tenant's
  append. There is no table lock, no lock escalation, no WAL backlog, and no
  vacuum debt.
- The pressure that *is* real: the campaign consumes the deployment's function
  execution concurrency and bills per call. Workpool parallelism is the isolation
  knob, and the tripwire is queued-execution latency for interactive functions.
- Completion is asserted from receipts, including separate file-storage deletion
  receipts; backup expiry is tracked as its own timeline and never described as
  deletion.

**Outcome:** Progress is resumable, other workspaces stay responsive, and
deletion is not declared complete prematurely.

**Delta:** Better on contention, worse on measurement: there is no SQL to profile
the sweep and no per-tenant resource isolation to configure — the only lever is
concurrency and batch size, watched through dashboard metrics and insights.

### B13 — Cutover collides with every write path

**Mode:** Break attempt

**Scenario:** Ren cuts over while users, connectors, scheduled runs, and tool
callbacks all write, and both systems have code deployed.

**Mechanism:**

- A checked-in writer inventory enumerates every path: renderer commands, HTTP
  webhook ingress, cron wakes, Workflow steps, Daytona callbacks, dictation
  Worker. Each is fenced by the migration hold on the D1 source side or by the
  `sourceAuthority` document on the Convex side.
- Every Convex write mutation reads `sourceAuthority` as its first act. Before
  the flip it aborts with an explicit retriable status; after the flip the D1
  gate is closed, so there is no interval in which both accept.
- The flip mutation requires the source closure receipt (final and held cursors,
  signed) as an argument and validates it; it cannot be performed by hand or
  inferred from a copy finishing.
- Late Daytona and connector callbacks carry the old authority epoch; the
  receiving function compares and refuses, recording the attempt.

**Outcome:** Every acknowledged operation exists exactly once; rejected or
backpressured writes are explicit.

**Delta:** Even by design — this is the sibling's protocol adopted deliberately,
because the hard part is cross-system and no substrate makes it atomic. The
Convex side is simpler only in that its half of the state is one transaction.

### B14 — EU infrastructure fails and an operator wants Global fallback

**Mode:** Break attempt

**Scenario:** Priya faces an EU regional outage and an operator proposes routing
EU workspaces to Global/US.

**Mechanism:**

- The refusal is structural. Each deployment carries a region constant and the
  workspace-to-deployment route is authoritative; the Global deployment has no
  function that will accept an EU workspace ID, and it has no read path into EU
  tables. There is nothing to override with a config flag, so "convenience
  failover" would require shipping new code, not turning a knob.
- Clients show regional unavailability and recover when the region does. No
  vector index, file, or overlay is created outside the region in the meantime.

**Outcome:** Service degrades honestly without breaking residency.

**Delta:** Better at refusing, materially **worse at recovering**, and this study
is where Convex's EU story is thinnest.

- EU is not launched. It is deferred behind a signed DPA and subprocessor review
  that do not exist today; until then the fail-closed rule is trivially satisfied
  because there are no EU workspaces.
- A deployment's region is immutable and there is no in-region redundancy we
  control or can fail over to. Region migration is a backup-and-restore operation
  with downtime, and restore is destructive (B40).
- The named fallback for a sustained EU failure is not another Convex region but
  the self-hosted escape hatch — an exit ramp, not a hot spare.
- Consequently EU RPO/RTO cannot be stated today. It is a P0 question for the EU
  build, not a P1 tuning question.

### B15 — A generic target adapter violates the host contract

**Mode:** Break attempt

**Scenario:** A new meeting adapter attempts to write work-stream tables
directly, submitting an arbitrary owner kind or tenant ID.

**Mechanism:**

- Clients can only invoke exported functions, so an adapter running client-side
  has no table access at all — the function layer *is* the app tier, and there is
  no anonymous or service key that reaches the database.
- Server-side, the driver may call only `internalMutation`s that are not exported
  to any client, take validated arguments, and assert `ownerKind`, `ownerId`, and
  workspace membership before writing. A mismatch is a thrown error that fails
  the step and is recorded with the opaque target and revision.
- Every write path is code we own in one repository, so the conformance suite can
  enumerate the domain mutations and assert that the driver imports none but
  those.

**Outcome:** No cross-domain or cross-tenant corruption; the loop fails with an
internal error rather than writing.

**Delta:** **Worse than the sibling, honestly.** Postgres RLS gives a
database-level deny that survives a buggy trusted function; Convex has no
equivalent, and the vendor lists authorization frameworks as still in
development. Our enforcement is module visibility plus validators plus review
plus tests. The compensating properties are real but partial: there is no
service-role bypass to misuse and no direct table endpoint to expose. This is a
named residual risk, mitigated by a conformance suite, not eliminated.

### B16 — A sub-agent branch bomb stays within depth four

**Mode:** Break attempt

**Scenario:** Avalon's children recursively try to create deeper and cyclic
substreams concurrently, past the breadth and cost budget.

**Mechanism:**

- The creation mutation reads the parent's `lineage` array (bounded by depth 4),
  rejects any parent already at depth 4, and rejects a target already present in
  the lineage — so cycles are refused by containment rather than by trusting a
  stored `depth` integer.
- Breadth and cost budgets live on the run's budget document. Concurrent creators
  all read and write that document, so OCC serializes them: the loser retries,
  observes the updated count, and is denied. A limit race cannot oversubscribe.
- Denials are returned as settled tool results, so no tool call is left dangling
  and the projector stays consistent.

**Outcome:** The main loop explains the limit, existing children continue, the
sidebar gains nothing, and the run queue does not explode.

**Delta:** Better on the race: the sibling needs an explicit lock to make the
budget check safe; here the shared budget document makes it a conflict the
platform resolves.

### B17 — Tool authority changes during an active run

**Mode:** Break attempt

**Scenario:** Maya revokes connector write permission after the model has
proposed a write but before the effect starts.

**Mechanism:**

- `beginEffect` is the single linearization point: one mutation reads the grants
  and `authEpoch`, decides, and — only if allowed — records the effect intent and
  returns its ID. The action refuses to call the provider without that ID, so
  there is no TOCTOU window between check and record.
- Revocation is an ordinary document write, so a check performed before inference
  is simply stale and is not consulted; the only check that matters is the one
  inside the recording transaction.
- The denial is appended as an authorization result part, and the loop explains
  the change rather than silently skipping the step.

**Outcome:** No new external write starts, and the transcript says why.

**Delta:** Even on the decision, C1-gated on the *display*: the deny itself is
transactional and exact, but how quickly Maya's and Mateo's screens reflect the
changed permission is the same push-latency property the vendor letter and pilot
must confirm. Under the fallback stance that display can lag up to 60 s while the
enforcement remains immediate.

### B18 — One work stream outgrows ordinary table/query assumptions

**Mode:** Break attempt

**Scenario:** A long-lived coding stream accumulates millions of parts and
events plus large Terminal artifacts, and stays one product work stream.

**Mechanism:**

- Reads are bounded by construction: tail and history queries paginate over
  indexes and never scan from sequence zero, and the documented per-transaction
  read limits mean an accidentally unbounded query fails loudly instead of
  quietly consuming the deployment.
- Compaction bounds model context; audit history is bounded separately by a
  retention sweep that moves old events into file-storage archives by indexed
  range, leaving tombstone documents with the archive reference.
- Storage cost is per-GB with no per-object ceiling, so a huge stream is a
  billing line rather than an object that stops accepting writes.

**Outcome:** Recent reads and appends stay bounded, older content stays available
or archived per policy, and compaction is never mistaken for deletion.

**Delta:** **This is the substrate's honest structural ceiling and it must not be
softened.** A deployment is one logical database. There is no published
horizontal shard story inside it, no table partitioning, no read replicas to
offload history scans, and no per-tenant placement. One enormous stream does not
bloat a shared index the way it would in Postgres — there is no shared index to
bloat — but the aggregate ceiling is real: at approximately S≈2,000 the fix is
architecture, namely application-level per-workspace sharding across separate
Convex projects, with cross-project queries becoming our problem. That is the
dead end named in the brief's "what breaks first", and it arrives after money
(function-call spend) and after a sales ticket (dedicated deployment class).

### B19 — A user asks to move a work stream

**Mode:** Break attempt

**Scenario:** Maya asks to move one work stream from a US workspace to an EU
workspace.

**Mechanism:**

- The product detects a cross-workspace or cross-region move and refuses
  in-place identity transfer. The reason is stronger than policy: a deployment's
  region is immutable, and there is no transaction, join, or foreign key that
  spans two deployments, so "repoint the rows" is not expressible.
- The offered alternative is an explicit export/import copy producing new IDs,
  re-derived audiences, recorded provenance, and a separate deletion choice —
  built from S13's export and S25's import machinery.

**Outcome:** A clear unsupported message and no partial move.

**Delta:** Even in behavior, cleaner in justification: the refusal follows from
the substrate rather than from a rule we must remember to enforce.

### B20 — One person belongs to Global and EU workspaces

**Mode:** Break attempt

**Scenario:** Mateo switches repeatedly between a US and an EU workspace, then
logs out globally.

**Mechanism:**

- Identity is ours. Avalon's existing Google OAuth flow mints our own JWTs,
  validated by each deployment's custom-JWT provider. Both deployments trust the
  same issuer, so there is no vendor-to-vendor federation to prove and no MAU
  meter to pay.
- The renderer holds one `ConvexClient` per deployment, each with its own
  subscription set and its own socket, opened only for workspaces the user is
  actually using.
- Authorization is per-deployment membership documents. Removal in one region is
  a document write there; global logout is a revocation at our identity plane
  plus short token TTL, and every function re-reads membership regardless.

**Outcome:** Switching is seamless, revocation is correctly scoped, and logout
reaches both sessions.

**Delta:** Better: the sibling's Auth federation topology is a launch-gating
spike, whereas here first-party JWT issuance is a documented, supported provider
and costs $0 at every scale. Honest scope note — at launch there is one
deployment, so the two-region path is designed and not yet exercised.

### B21 — Sidebar pagination changes while the user is paging

**Mode:** Break attempt

**Scenario:** Maya scrolls 20,000 cards sorted by `(lastActivityAt desc, id)`
while activity reorders them and new work streams appear.

**Mechanism:**

- The sidebar uses Convex's paginated query with index cursors, not offsets. Each
  loaded page is itself a subscription: when data changes, the loaded pages are
  recomputed against a consistent snapshot and pushed, so the set the user has
  scrolled through stays internally coherent and items visibly move rather than
  silently vanishing between pages.
- The cursor is derived from the index key `(lastActivityAt, id)`, so a moved row
  is either in a recomputed page or above the user's scroll position; it cannot
  be permanently skipped.
- Personal filtering is applied inside the same query, so filtering never changes
  the cursor's ordering domain.

**Outcome:** No card is permanently skipped or duplicated, and counts never
disagree with the visible list for longer than one push.

**Delta:** Better: reactive pagination is a platform primitive rather than a
snapshot-token-versus-keyset decision we must make and then defend. The cost is
that a deeply scrolled list holds many live pages, each re-running on change —
another reason page count is a budget (A9).

### B22 — Human and connector causality disagree with arrival order

**Mode:** Break attempt

**Scenario:** A provider event whose occurrence precedes a human message arrives
after it.

**Mechanism:**

- `seq` is allocated by the head document at commit and is append order, full
  stop. The human message keeps 500; the connector fact is linked and promoted at
  501.
- `occurredAt` is a separate stored field, and `activity_links` documents express
  the causal relation explicitly. Nothing renumbers, and no cursor is ever
  derived from a provider timestamp.
- The projector renders "occurred earlier, received now" from the two fields;
  model context ordering follows `seq`, so it is identical across reloads and
  retries.

**Outcome:** Conversation order stays stable while causality is visible.

**Delta:** Even.

### B23 — Tiny streaming deltas amplify storage and sockets

**Mode:** Break attempt

**Scenario:** 5,000 active viewers watch fast agent output as the model yields
fragments above 30 fps.

**Mechanism:**

- Row-per-token is impossible by construction, not by discipline: the action
  buffers and commits one `delta_chunks` document per 250–500 ms window, so the
  commit rate is a constant we choose (2–4 Hz) rather than a function of model
  speed.
- Fan-out is query re-execution: each checkpoint commit re-runs each subscribed
  tail query and pushes its result. There is no per-recipient message meter and
  no WAL; the meters are function calls, database bandwidth, and egress.
- Only subscribers of that stream re-run. Workspace-wide subscribers are not
  woken by a stream's checkpoints, because their queries do not read the chunk
  documents.
- Overload behavior is documented as queued function execution — slowdown — with
  cadence reduction as the immediate lever (halving cadence roughly halves the
  three dominant cost lines) and the dedicated deployment class as the next.

**Outcome:** Text stays human-real-time without a write storm or an account-limit
collapse, and terminal state is never dropped by backpressure because sealing is
a mutation, not a delivery.

**Delta:** Better in kind, and the failure currency is different: this scenario
does not end in a message-quota ceiling to negotiate — there is no project-wide
messages-per-second quota — it ends in **a bill**. That is a real advantage
(money scales continuously; a hard cap does not) and a real exposure, because
assumption A5 (one billed call per reactive re-run) is uncertain by ±2× on the
dominant line. 5,000 viewers on one stream is exactly the shape that makes A5
decisive, which is why the pilot measures spend against the model before
commitment.

### B24 — Workspace deletion races a scheduled and running loop

**Mode:** Break attempt

**Scenario:** Maya deletes while one cron wake is queued and another loop is
inside a model or tool action.

**Mechanism:**

- The deletion mutation bumps `authEpoch` and `controlEpoch` and marks runs
  cancelling. `ctx.scheduler.cancel` is used opportunistically for pending jobs
  but is never the authority.
- Every wake — cron, Workpool item, Workflow step — begins by re-reading the
  workspace and run lifecycle documents in its own mutation and aborts if the
  epoch moved. A stale wake therefore cannot create a run or append a part.
- A running action's next checkpoint commit fails its epoch guard, so its text
  cannot seal; its in-flight external effect is cancelled where supported and
  otherwise reconciled to `unknown`, with the receipt retained as required
  evidence even though the product rows are deleted.

**Outcome:** Deleted data does not reappear or keep running invisibly, and
ambiguous external effects leave an auditable receipt rather than an untracked
process.

**Delta:** Even in semantics, simpler in surface: there is no queue whose message
could carry authority independently of the database, because the queue *is* the
database.

### B25 — Operations needs to debug without crossing audience boundaries

**Mode:** Break attempt

**Scenario:** Ren investigates a stuck private substream in an EU workspace using
run, step, effect, and receipt evidence, without reading customer content.

**Mechanism:**

- Purpose-built internal query functions are the diagnostic surface: they return
  run and step IDs, epochs, durations, hashes, retry counts, and redacted error
  classes, and are written to exclude body fields by construction. `npx convex
  run` invokes them; the results are the same typed documents the team writes
  against daily.
- Function logs go to the existing sink through log streams, with content fields
  excluded at the emit site. Exception reporting covers the paging signal.
- Real SQL analytics come from the Fivetran streaming export into the warehouse,
  where the exported column set is chosen to omit bodies — so the analytical
  surface is redacted at the boundary rather than by operator restraint.
- Content access, when genuinely required, remains a separate audited grant.

**Outcome:** Most incidents are resolved from receipts, without routine
disclosure and without leaving the region.

**Delta:** **Worse, and it is the clearest day-to-day operational loss.** There is
no SQL against production and no role/column-grant model. The dashboard data
browser shows raw documents to anyone with deployment access, so the separation
between "operator can debug" and "operator can read customer content" is
enforced by access control on the deployment and by discipline, not by a
privilege the database itself withholds. The mitigations above are real and
purpose-built, but they must be built ahead of the incident: an ad-hoc question
whose redacted query does not exist yet is answered either by writing and
deploying one or by looking at raw data. There is also no Terraform provider, so
access configuration is dashboard state.

### B26 — A steering storm collides with an unsafe Terminal write

**Mode:** Break attempt

**Scenario:** Three teammates send ten steering messages while a deployment
command that may have partially changed remote state is active.

**Mechanism:**

- Each steer is one mutation: it appends a distinct part with its own `seq` and
  advances `controlEpoch` monotonically under CAS. Ten steers produce ten
  committed parts and ten epoch advances; OCC serializes the contenders on the
  head document, so none is lost and none interleaves.
- The rate-limiter component bounds steers per principal per interval, returning
  an explicit retriable status rather than dropping a committed message — this is
  the per-principal budget the design adopted to close the abuse hazard.
- No subsequent effect begins until the Terminal command reconciles: `beginEffect`
  guards on both the current epoch and the outstanding effect's settlement, so
  steer volume cannot start ten retries.
- The next admission batch deterministically selects the eligible corrections by
  policy, and the batch document makes that selection replayable.

**Outcome:** All ten messages stay visible, the UI explains the unsafe boundary,
and one resumed attempt follows. Nothing claims an already-executed remote write
was cancelled.

**Delta:** Even, with the rate limiter as a named component rather than
hand-rolled counters.

### B27 — Substreams become a universal bucket for unrelated features

**Mode:** Break attempt

**Scenario:** Teams propose substreams for tabs, labels, channels, every tool
call, and every user.

**Mechanism:**

- `convex/schema.ts` types `substreams.kind` as a closed union of the six
  supported kinds. An unknown kind is not merely rejected by a check — it fails
  schema validation at write time and would fail the deploy's validation against
  existing data, so it cannot be introduced by accident.
- The creation mutation additionally enforces depth, audience derivation, and
  lineage rules, and there is no client path that inserts a substream directly.
- Features needing independent lifecycle, card, audience, or retention are
  directed to work streams or their own tables; per-turn and per-tool concerns
  stay parts and query-side views.

**Outcome:** Conversation context stays predictable, and navigation never exposes
an arbitrary hierarchy.

**Delta:** Better on enforcement: the ontology is expressed in the schema the
platform validates, so the bounded product vocabulary is checked by the
substrate rather than only by review.

### B28 — Compaction completes after authorization and context change

**Mode:** Break attempt

**Scenario:** Priya removes resource access and a parent fork is redacted while a
compaction model call is running; the worker returns a plausible summary.

**Mechanism:**

- The model call is an action and holds no transaction. The completion mutation
  re-reads every source document, re-verifies content hashes, and compares the
  `authEpoch` and resource revisions against the frozen values.
- Any mismatch marks the job invalid and appends nothing. Because the summary
  document and its embedding would have been written in that same transaction,
  an invalidated job leaves no queryable residue anywhere — there is no window in
  which the artifact exists but is not yet indexed, or vice versa.
- A safe recompaction is scheduled from the same mutation, subject to a bounded
  retry budget.

**Outcome:** Later prompts, previews, and search never use the stale artifact.

**Delta:** Better on the residue question: artifact and derived index share one
transaction, so "the summary was rejected but its embedding remains searchable"
is not reachable.

### B29 — Activity replay crosses every asynchronous boundary

**Mode:** Break attempt

**Scenario:** Elena replays a connector month; ingress, normalization, embedding,
opportunity, suggestion, and acceptance stages all redeliver in arbitrary order.

**Mechanism:**

- Each stage has its own semantic receipt with a unique index — ingress by
  `(installationId, eventId)`, normalization by ingress receipt, embedding by
  `(sourceId, contentHash, modelVersion)`, opportunity by opportunity key,
  acceptance by operation key. Redelivery finds the receipt and reuses the
  derived document instead of creating a second one.
- Enqueue is transactional with each stage's write, so at-least-once delivery
  never produces a stage that ran without its predecessor having committed.
- Vector similarity is never dedup truth; it only proposes candidates that a
  keyed receipt then resolves.
- Tombstones are documents, so a replay cannot resurrect deleted derived state:
  the stage re-reads the tombstone and stops.

**Outcome:** Activity and accepted work do not multiply, and updated source
versions stay explicit.

**Delta:** Better on one seam only — the transactional scheduler removes the
"committed but not enqueued" gap that a separate queue product has to handle with
an outbox. Everything else is the sibling's discipline, unchanged.

### B30 — Personal activity is accidentally admitted as workspace work

**Mode:** Break attempt

**Scenario:** Mateo connects a personal mailbox inside a shared workspace; some
normalized events are owner-only.

**Mechanism:**

- `activities.audienceId` is set at normalization from the installation's
  ownership, and opportunity detection runs as a query under the owner's
  visibility helper, so a personal event can only ever produce a personal
  suggestion.
- Workspace-wide proposal or admission requires an explicit disclosure mutation
  that Mateo performs, which writes the approved representation as a new document
  rather than re-labelling the private one.
- Shared ranking, digests, and search never see the private events: text search
  runs inside the visibility helper, and vector search filters on audience via
  `filterFields` before the post-filter re-check.

**Outcome:** Private mailbox facts stay personal until Mateo shares an approved
representation, and nothing auto-creates a workspace stream from them.

**Delta:** Even.

### B31 — Suggested-work promotion crashes at every handoff

**Mode:** Break attempt

**Scenario:** Maya accepts one suggestion while the response, the network, and
the driver start each fail in turn; her client retries the same operation key.

**Mechanism:**

- Crash before the mutation commits: nothing exists — mutations are atomic — and
  the retry proceeds normally.
- Crash after commit, before the response reaches the client: the retry hits the
  acceptance receipt under its unique index and returns the created work stream's
  ID.
- **The "queue or workflow start failed" branch does not exist.** `ctx.scheduler`
  called inside the acceptance mutation is transactional: if the mutation
  succeeds, the scheduled function is guaranteed to be scheduled. There is no
  separate enqueue that can fail after the work stream is created, and no
  compensating cleanup to write.
- Driver double-start: the Workflow instance ID is derived from the run ID, and
  step receipts are keyed `(runId, stepId)`, so two starts converge on one
  history.

**Outcome:** Exactly one work stream, card, and run appear, with recoverable
queued and running states.

**Delta:** Better, and specifically at the seam the sibling flags: one of the four
crash points in this study is removed by the substrate rather than handled by our
code.

### B32 — Common and personal collection replacements race an access change

**Mode:** Break attempt

**Scenario:** Mateo loses a restricted work-stream grant while old snapshots and
personal updates are in flight.

**Mechanism:**

- There is nothing in flight to race. The grant removal writes the grant
  document, which is in the read set of Mateo's sidebar query, his personal
  overlay query, the card query, and any tail query he holds. That single commit
  re-executes all of them, and each returns results computed without the stream.
- Because all of a client's subscriptions reflect the same database snapshot, the
  common and personal collections cannot be updated out of step — a personal
  result cannot reintroduce a card that the common result has dropped.
- Reopening is refused by the same helper inside the opening query, so a stale
  local route cannot render content.
- Client-side caches: `ConvexClient`'s in-memory store is replaced by the new
  results. Purging any encrypted on-disk cache remains our client-side
  obligation, unchanged from the sibling.

**Outcome:** The stream disappears from every collection at one snapshot and
cannot be reopened; counts do not reveal it.

**Delta:** Better in mechanism and **C1-gated in guarantee** — this study depends
on exactly the property the vendor letter must confirm, namely that cached query
results are invalidated by the same read-set overlap and that identical queries
are shared only within identical auth. Under the fallback bounded-staleness
stance the same code stands and the promise becomes ≤60 s.

### B33 — A private suggested action is revoked before acceptance

**Mode:** Break attempt

**Scenario:** Mateo clicks accept after losing permission on the source resource;
the stale suggestion is still rendered locally.

**Mechanism:**

- The acceptance mutation re-reads the suggestion document and every source
  reference, and re-runs the visibility helper against current grants inside its
  own transaction. Fetch-time authorization is irrelevant.
- On denial it writes nothing to the shared lane, starts no effect, and
  tombstones the suggestion in the same transaction — which re-runs Mateo's
  personal surface query and removes the card.
- Any score or embedding for the suggestion is written and removed with the
  suggestion document, so nothing keeps it visible after invalidation.

**Outcome:** Mateo sees that access changed; no shared message and no external
effect begin.

**Delta:** Even.

### B34 — Resource ACL filtering and digest scheduling overload the primary

**Mode:** Break attempt

**Scenario:** Millions of activity events with fine-grained audiences and
thousands of due digests, running alongside interactive writes.

**Mechanism:**

- A cron dispatcher queries due schedules by index in bounded pages and hands
  work to a Workpool whose parallelism is the isolation knob. There is no
  connection pool to exhaust and no query planner to mis-estimate.
- Authorized source ranges are indexed queries, not policy joins: visibility is
  ordinary TypeScript over indexed reads, and the per-transaction read limits
  force it to stay indexed — an accidental full scan fails rather than degrading
  the deployment.
- Digest workers cannot skip audience filtering by privilege escalation, because
  there is no elevated role to escalate to; they call the same helper.
- Under pressure the deployment queues function executions, so digests are late
  rather than interactive writes being slow — provided the Workpool cap is set
  below the class's concurrency.

**Outcome:** Digests may be honestly delayed while messages and the sidebar stay
responsive, with no unauthorized shortcut.

**Delta:** Better on the isolation knob (one explicit concurrency cap rather than
pool sizing, statement timeouts, and RLS plan tuning), worse on evidence: sizing
that cap is empirical from dashboard metrics and insights, since there is no
`EXPLAIN` and no per-query cost model.

### B35 — Queue replay escapes a paused migration campaign

**Mode:** Break attempt

**Scenario:** Ren pauses a campaign after seeing corrupt transformed rows, while
old work items are already in flight.

**Mechanism:**

- Authority is the campaign document's state and epoch, held in the same database
  as the data. Pausing is a mutation on that document.
- Every claim mutation re-reads campaign state and epoch before starting a slice
  and refuses when paused or when the epoch moved; a redelivered Workpool item
  therefore starts no new work regardless of what its payload says.
- An already-started slice may finish, but its commit mutation carries the epoch
  it started under and fails the guard, so no corrupted row lands after
  invalidation.
- Cancelling scheduled functions is available and used for tidiness, never as the
  pause mechanism.

**Outcome:** Progress stops at an explainable bounded edge and nothing corrupt
commits afterwards.

**Delta:** Even; the payload-is-not-authority rule is identical, and the queue
being inside the database removes the separate visibility-timeout reasoning.

### B36 — The final authority-copy hold overflows before source closure

**Mode:** Break attempt

**Scenario:** A hot workspace produces more writes during cutover than the hold
buffer can drain before validation completes.

**Mechanism:**

- The hold and its outbox live on the D1 source side, as in the sibling, because
  the source is still the authority until the gate closes. The buffer is durable
  storage with a declared capacity, never memory.
- On reaching the threshold the source returns explicit retriable
  saving/capacity status; clients show saving rather than success.
- Ren's choices are bounded: abort before closing the gate — the source releases
  held writes and resumes normally, and the Convex side never activated because
  the flip requires the closure receipt — or expand a reviewed bound and
  continue.
- Replaying held commands into Convex is idempotent by operation key, so an abort
  followed by a later successful cutover cannot double-apply.

**Outcome:** Users see saving or capacity status rather than false success or
missing writes.

**Delta:** Even by inheritance. Cutover at approximately zero users makes the hold
short in practice; the bound is still designed, because "we expect it to be
quiet" is not a mechanism.

### B37 — A writer gets ahead of the database/API contract

**Mode:** Break attempt

**Scenario:** A new step or event payload is emitted before the readers that
understand it exist.

**Mechanism:**

- Inside the deployment this is structurally reduced: schema, functions, crons,
  HTTP routes, and component configuration ship in a single push, and the push
  validates the schema against existing data before activating. There is no
  ordering between "migration applied" and "code deployed" to get wrong.
- The skew that remains is across the push boundary: persisted Workflow steps
  written by the previous artifact, and Electron clients on older function
  contracts. `steps.version` is stored; a step mutation that does not implement a
  version refuses it and parks the run in `waiting_upgrade` rather than
  misinterpreting it.
- Argument and schema validators reject unknown fields explicitly, so a payload
  shape mismatch is a loud error rather than a silently dropped `jsonb` key.
- Rollout can identify affected runs with an indexed query over nonterminal runs
  by step version.

**Outcome:** A temporary delay or explicit error, with no transcript or effect
corruption.

**Delta:** Better: the sibling's specific failure — schema deployed in one region
before the code that reads it, or vice versa — has no counterpart, because there
is no separate migration step. Documented, and claimed as such.

### B38 — A stateful deploy reconnects an entire region at once

**Mode:** Break attempt

**Scenario:** Ren deploys during peak usage and thousands of Electron clients
reconnect.

**Mechanism:**

- Deploys are online; the client reconnects transparently and re-subscribes. Each
  subscription costs one query execution to restore, independent of how long the
  client was disconnected, because there is no cursor catch-up and no durable
  event API to page through.
- The reconnect burst is therefore bounded by (clients × subscriptions per
  client), which S28's subscription hygiene keeps small — a sidebar page, an
  overlay query, and the open streams.
- The vendor client handles backoff and jitter; there is no connection pool to
  exhaust, and the failure mode at burst is queued function execution, i.e.
  slower restores rather than errors.

**Outcome:** A brief reconnect indication, no lost state, no thundering-herd
outage.

**Delta:** Better, and materially so: the sibling's catch-up path amplifies with
gap length and hits its database; here the restore cost is flat in gap length.
The honest residual is that the burst is billed — thousands of simultaneous query
re-executions are function calls — and that a deploy therefore has a small,
measurable cost signature.

### B39 — Mutable-tail replay crosses a checkpoint crash

**Mode:** Break attempt

**Scenario:** The turn crashes after tokens were generated but before the next
checkpoint (crash A), and separately during a checkpoint commit (crash B).

**Mechanism:**

- There is no mutable tail and no byte cursor. `delta_chunks` are append-only and
  keyed `(turnId, epoch, chunkNo)`; an accumulated buffer is never rewritten, so
  a partially written buffer cannot exist.
- Crash B is resolved by the substrate: a mutation either commits entirely or not
  at all, so a chunk is present or absent — there is no state in which the cursor
  advanced without bytes.
- Crash A: with a verified provider cursor the same attempt resumes and appends
  the next `chunkNo` in the same epoch. Without one, the head document's epoch is
  bumped by CAS; every tail query filters on the current epoch, so that one
  commit retracts the dead epoch's provisional text for every viewer
  simultaneously, and the new attempt starts at `chunkNo` 0 of the new epoch.
- Two attempts cannot both seal: the seal mutation guards on the epoch.

**Outcome:** A resumable attempt continues exactly; a non-resumable one visibly
restarts instead of splicing two generations; one complete answer seals.

**Delta:** Better. Retraction is a single compare-and-set that every reader
observes at one snapshot, rather than a client-side rewind protocol driven by
attempt epochs in delivered frames.

### B40 — PITR is mistaken for product or migration rollback

**Mode:** Break attempt

**Scenario:** Ren considers restoring yesterday's database after a bad backfill,
knowing that provider writes, Daytona commands, uploads, and user messages have
happened since.

**Mechanism:**

- The team inventories divergence across the database, file storage, and external
  reality, and prefers forward repair: an idempotent migration-component campaign
  that recomputes the damaged field from source documents, with receipts.
- If a restore is genuinely required, admission stays closed afterwards and every
  nonterminal run, effect, scheduled job, and connector cursor is reconciled
  before reopening.
- Granular recovery uses the export ZIP: read the affected documents out of an
  `npx convex export` and write them back through an internal mutation, scoped to
  the damaged set.

**Outcome:** No silent time travel, no repeated external effects, and an explicit
restoration status.

**Delta:** **Worse than the sibling, and this is the sharpest operational
regression.** There is no PITR and no point-in-time table or tenant rollback.
Backups are dashboard-scheduled snapshots, and **restore is a destructive wipe of
the deployment** (optionally including file storage). So "restore yesterday"
means discarding every write since that snapshot, for every tenant, at once —
which converts restore from a repair tool into a disaster-recovery instrument of
last resort and makes forward repair effectively mandatory. Consequences we
accept explicitly: backup scheduling is dashboard-only state (no Terraform),
restore drills run against scratch deployments (about half a day per quarter),
and the weekly export drill doubles as both the vendor-exit hedge and the
granular-recovery source. Selective document restore is our tooling to write, not
a platform feature.

### B41 — Global route and regional workspace row disagree

**Mode:** Break attempt

**Scenario:** A stale client or command points at the wrong region or an older
route epoch.

**Mechanism:**

- Every request carries workspace ID, target region, and route epoch. The
  receiving deployment's function asserts that the workspace document exists
  locally and that the epoch matches; a wrong-region or stale-epoch request gets
  a non-content route correction or fails closed. No function creates a missing
  workspace document on demand.
- During migration only the source-local gate linearizes authority; the route
  copy and the destination's activation may lag it safely, and repair always
  starts from the closure receipt rather than from whichever row looks newest.
- At launch there is exactly one deployment, so the disagreement is not
  exercisable in production; the assertions ship anyway so the multi-region path
  is not retrofitted onto a permissive contract.

**Outcome:** Safe re-route or re-authentication, with no product state created in
the wrong deployment.

**Delta:** Even in protocol. One simplification: because there is no cross-
deployment read path at all, a mis-routed request cannot partially succeed.

### B42 — The Supabase-native driver becomes a hidden workflow engine

**Mode:** Break attempt

**Scenario:** The sibling's fear is that per-loop queue, cron, and function code
accretes into an unacknowledged, untested workflow engine. The Convex analog is
the opposite exposure: we depend on someone else's.

**Mechanism:**

- We do not build a `RunDriver` state machine. Durable execution is the Workflow
  component (steps persist, survive restarts, per-step retry policies) with the
  Workpool component for bounded queues, so the two-hour loop's leases, retries,
  waits, and resumption are supported behavior rather than our invention.
- One generic driver wraps the component for both work-stream and non-work-stream
  loops (S17), and every domain integrates through the same narrow interface.
- The conformance and failure-injection suite the sibling needs is still built
  and still run — against the component, exercising early events, deploy during a
  wait, duplicate step delivery, unknown effects, and steering — because a
  dependency's behavior must be characterized before it is trusted.

**Outcome:** Consistent progress and recovery across loop types, with the
complexity acknowledged and tested rather than accreted.

**Delta:** Better on volume of code, **worse on maturity and control.** Workflow
and Workpool are components, newer than the core, from a venture-backed startup
whose own status page lists related areas as in development; a two-hour loop with
retries, waits, deploys, and steering is precisely the workload that finds
component defects, and we cannot patch a managed component the way we can patch
our own driver. The named fallback is to drive the loop from our own `runs` and
`steps` documents plus the transactional scheduler — the same machinery, more of
our code — which is why the driver interface stays narrow enough to swap. Vendor
maturity is risk #2 in the brief, and the FSL-to-Apache open-source backend is an
exit ramp, not a hot spare.

### B43 — A supposedly additive migration blocks a hot table

**Mode:** Break attempt

**Scenario:** Ren adds an index or a constraint to the parts table at peak load.

**Mechanism:**

- There is no DDL, no `ACCESS EXCLUSIVE` lock, and no table rewrite to trigger.
  A new field is an optional schema property; a new constraint is expressed as a
  narrowed validator plus a migration-component backfill; a new index is declared
  in `convex/schema.ts`.
- The index is backfilled by the platform as part of the push, and the push
  activates when the deployment is consistent with the new definition. On a very
  large table the observable cost is **deploy duration**, not blocked appends —
  writes continue against the live artifact throughout.
- A validator narrowed ahead of the data fails schema validation and blocks the
  push, which is the replacement failure mode: a rejected deploy rather than a
  stuck production table. The expand phase (optional field, both-shape-tolerant
  readers) is therefore still required, and contract still happens in a later
  release.

**Outcome:** No outage; a slow deploy or a rejected deploy is preferable to
blocking appends, and dashboard drift cannot bypass review because schema and
indexes live in the repository.

**Delta:** Better — the sibling's specific hazard has no mechanism here. Two
honest caveats: index backfill duration on a production-scale table is not
something we have measured and belongs in P1; and the deploy is deployment-wide,
so a bad push's blast radius is the whole region rather than one table.

### B44 — A two-hour coding loop crosses retries, early events, and capacity

**Mode:** Break attempt

**Scenario:** Mateo asks Avalon to implement a complex change with Daytona. The
full loop lasts 2 h 15 m across many model iterations, seconds-long tools,
several 3–5 minute commands, one deploy of the driver, one callback that arrives
before its wait, a capacity spike, and a steering message during a long command.

**Mechanism:**

- **The loop.** One Workflow-component instance spans the whole 2 h 15 m. Steps
  persist to the database and survive server restarts and deploys, so elapsed
  loop time is not bounded by any runtime's lifetime, and the loop is never one
  retry unit — each model call, tool call, and settlement is its own fenced step
  with its own retry policy.
- **The turn ceiling — the honest confrontation.** One model turn is one
  Convex-runtime action, capped at **30 minutes**. A turn that exceeds it is
  aborted by the platform; the Workflow retries from the last durable step, which
  re-spends that provider call. That is a real regression against the sibling's
  retained Cloudflare Workflows step, which has no such ceiling, and it is a tail
  event rather than a normal one — the loop is fine at 2 h 15 m, only a single
  >30-minute generation is not. The tripwire is pre-registered: **≥3 turns per
  week aborted by the ceiling ⇒ external turn host or reopen the decision.**
- **The C9 gate on that number.** 30 minutes is the *default Convex runtime's*
  cap. Node-runtime actions cap at **10 minutes**, which equals the long-turn
  requirement with zero headroom and would probably fail. The kept agent-harness
  and Bind adapter port must therefore run without `"use node"`; verifying that
  is a **Phase-0 blocker**, and the fallback design is an external turn host
  (the model turn runs off-platform and checkpoints into Convex through
  mutations), which preserves every other mechanism in this study but adds a
  service to the count.
- **Early callback.** A Daytona callback that lands before the workflow reaches
  its wait is not lost: the HTTP action writes a `wait_events` document
  unconditionally, and the wait step reads that document. Storage precedes
  arrival order, so early delivery is the normal case, not a race.
- **Deploy mid-loop.** The new artifact resumes from persisted steps; step
  versions gate interpretation (B37). Provider effect receipts keyed
  `(runId, stepId)` mean a deploy cannot repeat a Terminal command.
- **Capacity.** There is no messages-per-second quota to exhaust. Saturation is
  the deployment class's concurrent function executions, and the documented
  behavior is queued execution. New actions are admitted through the Workpool,
  whose cap keeps the loop from starving interactive traffic, and a loop that
  cannot get capacity sits in durable `waiting_capacity` — a document, so closing
  the desktop and returning hours later shows the same state.
- **Steering during a long command.** The C6 watchdog checkpoint fires every
  500 ms regardless of token flow, so the steering document is observed during
  the Terminal wait; the command reconciles, no next effect starts under the
  retired epoch, and one resumed batch wins terminal state (S09, B26).
- **Content locality.** The Workflow holds identifiers and step results, not
  transcripts; the documents are the state.

**Outcome:** Progress and waits are honest, reopening shows one transcript, one
effect per causal action, and one terminal result.

**Delta:** Mixed, and this is the study where the substrate is most exposed.
Better: durable execution is a supported component rather than hand-built, early
events are stored rather than raced, and capacity degrades as queueing rather
than as a quota error. **Worse: the 30-minute per-turn ceiling is a named
regression with a re-spend cost, and its value is contingent on the C9 runtime
question, which is unresolved until the harness port is attempted.** Both belong
in the weaker register, and both have pre-registered exits.

## Coverage matrix

| Pressure | Showcase | Break attempts | Convex primitive or contract under test |
| --- | --- | --- | --- |
| Ordered conversation and message arrays | S01, S05, S19 | B06–B10, B22, B39 | Head-doc `seq` under OCC, turns/parts, file refs, epoch-keyed chunks |
| Unread, mentions, sidebar, home | S02, S20 | B01–B04, B21, B32 | Same-transaction card + sparse overlays; reactive paginated queries |
| Queue and steering | S07–S09, S18 | B07, B17, B26, B44 | Steering doc CAS, 500 ms watchdog checkpoint, `beginEffect` linearization |
| Substreams and sub-agents | S04–S06 | B08–B09, B16, B27–B28 | Schema-typed kinds, `baseSeq`/lineage, audience docs, budget-doc OCC |
| Compaction with live tail | S19 | B08, B28, B39 | Frozen source IDs/hashes/epochs; disjoint read sets; completion CAS |
| Token realtime/reconnect | S03, S28–S29 | B03–B05, B23, B38–B39 | Delta chunks + epoch filter; query recompute instead of cursor protocol |
| Background/idle sockets | S28, S31 | B05, B23, B38, B44 | One `ConvexClient` socket; subscription hygiene as a cost control |
| Full 2–30 m/2 h+ loops | S17, S31 | B24, B37, B42, B44 | Workflow component; 30-min action cap; C9 runtime gate |
| Daytona Terminal | S09, S31 | B17, B26, B40, B44 | `effects` receipts, `wait_events` docs, HTTP-action callbacks, reconciler cron |
| Connector ingress/activity | S11, S21–S22 | B11, B22, B29–B30, B34 | HTTP actions on `convex.site`, unique receipt indexes, transactional scheduler |
| Digests/suggestions | S20–S22 | B29–B34 | Audience-scoped docs, atomic acceptance + scheduled run, keyed receipts |
| Storage and large content | S01, S13, S25 | B10, B12, B39–B40 | Convex file storage, hashes in docs, backups that can include files |
| Text search/vectors | S21–S22 | B08, B28, B30, B33–B34 | Search index inside the query; vector `filterFields` + post-filter helper |
| Auth and revocation | S04, S15 | B03, B08–B10, B15, B17, B20, B25, B32–B33 | Custom-JWT provider; visibility helper in every read set; C1-gated bound |
| EU residency | S11, S15, S27 | B14, B20, B25, B41 | Per-region deployment, immutable region; DPA/subprocessor review pending |
| Additive schema/backfill | S23–S24 | B35, B37, B40, B43 | One push carrying schema + functions; migrations component; index backfill |
| D1/R2 cutover | S16, S25 | B13, B36, B40–B41 | `convex import`, `sourceAuthority` doc, D1-side closure gate, keyed replay |
| Scheduler/cron/action limits | S12, S24, S27, S30 | B24, B29, B34–B35, B42–B44 | Transactional scheduler, Workpool caps, per-transaction read/write limits |
| Export/deletion/DR | S13–S14 | B12, B24, B40 | Fenced chunked export, phased deletion receipts, destructive-restore reality |
| Scale/cost/operations | S28–S30 | B01–B02, B12, B18, B21, B23, B25, B34, B38, B43–B44 | Billed function calls (A5), deployment concurrency class, one logical DB |

## Where Convex is weaker

Stated explicitly so no reader has to infer it. Everything below is a place where
this substrate handles a study worse than the Supabase sibling, or handles it
well only behind a gate that is not yet closed.

| Study | What is worse or gated | Exit or mitigation |
| --- | --- | --- |
| **B44, S31** — turn ceiling | One model turn is one action: **30 minutes** in the default runtime. A longer turn aborts and retries from the last durable step, re-spending the provider call. The sibling's retained Cloudflare Workflows step has no such ceiling. | Tail-frequency event. Tripwire: ≥3 aborted turns/week ⇒ external turn host or reopen. |
| **B44** — C9 runtime gate | That 30 minutes becomes **10 minutes** if any kept harness/Bind dependency forces `"use node"`, which is equal to the long-turn requirement with zero headroom. The 10-week migration estimate assumes a light port. | Phase-0 blocker: verify the harness runs in the default runtime before commitment; fallback is an external turn host. |
| **B03, B32, B17** — revocation bound | The mechanism is native and per-frame, but the precise composite guarantee (no pre-revocation-snapshot result newly delivered, including from caches and across reconnects) is **not documented verbatim** — challenge C1. | Launch-gated on a written vendor confirmation plus pilot measurement. Fallback stance (bounded staleness ≤60 s) costs $0 and needs no design change. |
| **B14, S15, S27** — EU | The region is real and immutable-by-deployment, but there is **no published DPA, subprocessor list, or processing commitment**, and control-plane locality is unknown. There is also no in-region failover: region migration is backup/restore with downtime, and the sustained-failure fallback is self-hosting. EU pricing is +30 % with no included allowances. Singapore has no Convex region at all. | EU deferred and fail-closed; DPA + subprocessor review before the EU build; EU RPO/RTO is a P0 for that build; SG is a named unresolved risk against the three-region target. |
| **B18** — no shard story | A deployment is one logical database: no partitioning, no read replicas, no per-tenant placement, and **no published horizontal shard story inside it**. The honest dead end is ≈S 2,000. | Fix is architecture, not money: application-level per-workspace sharding across projects. Money (function-call spend) and a sales ticket (D1024/D2048 class) bind first. |
| **B40** — restore | **No PITR.** Backups are dashboard-scheduled snapshots and **restore is a destructive deployment-wide wipe**; there is no table, tenant, or point-in-time rollback. | Forward repair via idempotent migration campaigns becomes mandatory; export ZIP is the granular recovery source; drills on scratch deployments; selective restore is our tooling. |
| **B25** — operator debugging | **No SQL against production** and no role/column-grant separation; the dashboard data browser shows raw documents to anyone with deployment access. No Terraform provider, so access and backup schedules are dashboard state. | Purpose-built redacted internal queries written ahead of incidents, content-free log streams, Fivetran export to a warehouse with bodies omitted, tight deployment-access control. |
| **B15, S17** — no RLS backstop | There is no database-level deny surviving a buggy trusted function; the vendor lists authorization frameworks as in development. Enforcement is module visibility, validators, review, and tests. | Partially offset (no service-role bypass, no direct table endpoint). Residual risk accepted and covered by a conformance suite. |
| **B05** — correlated failure | Delivery and commit are the same service, so the sibling's "database healthy, realtime degraded" half-mode does not exist. One deployment is one failure domain. | Deliberate trade: the divergence class disappears with it. Status-page monitoring plus the self-host export drill are the only hedges. |
| **B23, B02, S28, S29** — cost model | The failure currency is billed function calls rather than a quota, which scales continuously but rests on assumption **A5** (one billed call per reactive re-run), uncertain by ±2× on the dominant line. Idle subscriptions and large online-member counts are real budget lines (A9). | One-week S≈5 pilot read off the usage dashboard before commitment; cadence (2–4 Hz), page size, and subscription hygiene are the levers. |
| **B42** — component maturity | Workflow and Workpool are newer than the core, from a small vendor, and cannot be patched by us. | Narrow driver interface so the component is swappable for our own scheduler-driven driver; conformance and failure-injection suite run against it regardless. |

No study in S01–S31 or B01–B44 lacks a credible Convex mechanism. Every entry
above is a worse-but-workable or gated-but-designed outcome, not a gap.

## Prioritized architecture questions

### P0 — Must close before implementation commitment

These are the pre-registered Phase-0 gates. A failed gate sends the decision to
the recorded runner-up rather than into a redesign.

1. **Pilot, one week at S≈5.** Is p95 commit→client push ≤1 s sustained, and is
   metered spend within +50 % of the cost model? This resolves assumption A5
   (±2× on the dominant line) and the undocumented push-latency assumption A8 in
   one measurement, read directly off the usage dashboard.
2. **C1 vendor letter.** Written confirmation — in documentation or contract —
   that re-delivery is authorization-fresh, that cached query results are
   invalidated by the same read-set overlap, and that identical queries are
   shared only within identical auth, including across reconnects. Absent it, the
   product ships the bounded-staleness stance (≤60 s), which costs $0 and changes
   no code.
3. **C9 runtime.** Does the kept agent-harness and Bind adapter port run in the
   default Convex runtime? If any dependency forces `"use node"`, the per-turn
   ceiling drops from 30 to 10 minutes and the external-turn-host fallback design
   must be costed before commitment.
4. **DPA and subprocessor review** before any EU build, plus an answer on
   control-plane locality — and a decision on the Singapore gap, which no Convex
   region currently covers.
5. **Cutover protocol.** What writer inventory, hold and outbox, validation,
   D1-side closure gate, and destination activation check prove exactly one
   authority throughout the D1/R2 migration? (Unchanged in substance from the
   sibling; the D1 side is still the linearization point.)
6. **Turn-length distribution.** What fraction of today's model turns would
   exceed 30 minutes? This sizes the B44 regression before it is accepted, and
   sets the pre-registered ≥3-per-week tripwire against real data.
7. **The transactional message and turn materializer**, especially when a user
   message arrives between a tool call and a late tool result — substrate-
   independent, still unanswered.
8. **Effect taxonomy.** Which external effects are idempotent, cancellable, and
   queryable, and which must become `unknown` after a crash?

### P1 — Must close before production canary

9. What deployment class, Workpool caps, and cadence follow from measured active
   users, card updates, subscribed viewers, connector bursts, and vector
   footprint — and where is the queued-execution knee for this workload?
10. What exact interest-query predicates, indexes, page size, and lazy attention
    or count algorithms keep large workspaces inside the per-transaction read
    limits, and what is the per-client subscription budget (S28, B21)?
11. What substream kind, inheritance, depth, and promotion rules are normative
    across all adapters, and how is the closed union kept closed as features
    arrive?
12. What checkpoint cadence and inline-versus-file-storage thresholds balance
    perceived latency, function-call spend, database bandwidth, and reconnect
    cost?
13. What retention and archival policy governs activity, events, and delta-chunk
    tombstones, and what does the archived-history read path look like?
14. What Daytona start, status, callback, cancel, idempotency, and output APIs
    make long commands safely addressable from actions and HTTP actions?
15. What full-loop budgets, Workpool reserves, and rate-limiter settings preserve
    a recovery and terminalization reserve under capacity pressure?
16. How do function contracts, document shapes, and step versions coexist with
    nonterminal runs and older Electron clients across a push (S26, B37)?
17. What backup schedule, restore drill cadence, and **forward-repair tooling**
    exist given that restore is destructive and there is no PITR (B40)?
18. What dashboard and insights signals automatically throttle connectors,
    derived work, compaction, embeddings, and migrations below interactive
    traffic (B34, S24)?
19. What conformance and failure-injection suite characterizes the Workflow and
    Workpool components before the two-hour loop depends on them (B42)?
20. What redacted internal query surface, log-stream field policy, and warehouse
    export column set let operators debug without content access (B25)?
21. How long does index backfill take on a production-scale table, and what is
    the deploy-duration budget that follows (B43)?

### P2 — Resolve before broad scale or policy expansion

22. At what measured thresholds does application-level per-workspace sharding
    across Convex projects begin, and what does a cross-project query cost the
    product (B18)?
23. What exact background completion notification lets a client drop
    subscriptions while meeting user expectations (S28)?
24. When do bounded classifiers stay a single scheduled action versus taking a
    full Workflow instance (S17, S30)?
25. What support-access workflow permits rare content debugging without routine
    dashboard exposure, and what customer-visible audit accompanies it?
26. What application-layer encryption policy covers connector bodies, files, and
    Terminal artifacts, given that no customer-managed-key facility is offered?
27. What cadence of `npx convex export` and self-host rehearsal keeps the
    vendor-exit ramp real (assumption A11), and what would a self-hosted EU
    deployment actually cost to operate?
28. What product export/import experience supports copying a work stream across
    workspaces or regions without pretending it is an in-place move (B19)?
29. What mention limits, suggestion merge rules, recency windows, and unread
    approximations keep the UI useful — and the re-run budget bounded — at very
    large workspace scale?
