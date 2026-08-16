# Supabase user-flow architecture stress studies

> Companion to [`prd.md`](prd.md) and [`research.md`](research.md). These studies
> mirror the 75 IDs in the Durable Object proposal so the two implementations
> can be compared against the same product pressures. They test the Supabase-
> first architecture rather than mechanically translating actor behavior.

## How to read these studies

- **Showcase** studies describe behavior the architecture should make clear,
  safe, or economical.
- **Break attempt** studies attack an invariant or operational boundary. A
  correct explicit refusal can pass.
- Every study has a user-visible or operator-verifiable failure oracle.
- Times are realistic design inputs: model time to first token is normally 1–5
  seconds; ordinary tools take seconds; Daytona Terminal p95 is under one minute
  and its tail may take 3–5 minutes or longer. A full loop is normally 2–30
  minutes and can rarely exceed two hours during coding/research.
- Scale values are stress fixtures, not launch commitments.

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

## Showcase studies

### S01 — A shared investigation remains one ordered conversation

**Mode:** Showcase

**Persona:** Samantha and Mateo investigate an incident with Avalon.

**Preconditions:** They can contribute to one work stream; a third member may
view it but has never posted.

**Flow:**

1. Samantha posts a diagnosis and PDF attachment.
2. Avalon begins streaming after 1–5 seconds.
3. Mateo queues a correction while the answer is active.
4. The viewer opens and closes the stream; all clients later reload.

**Expected user-visible behavior:** Everyone sees one stable order and one
assistant result. Mateo's committed message waits for the next admission. The
viewer does not become a participant merely by being present.

**Architecture stress:** One short `workstreams` row lock allocates sequence;
the part, attachment reference, attention/card rows, durable events, and queued
run wake commit together. The materializer uses complete turns, not arrival-time
joins. Presence remains ephemeral.

**Failure oracle:** Fail if clients see different committed order, duplicate an
assistant/message, queued input interrupts, the PDF reference is visible before
ready, or viewing creates participant state.

**Unresolved pressure:** Finalize edit/redaction replacement semantics and their
effect on model fences.

### S02 — Unread and mentions follow the main-feed waterline

**Mode:** Showcase

**Persona:** Mateo reads on a laptop and later opens a second device.

**Preconditions:** His sparse state is at attention ordinal 40.

**Flow:**

1. Three visible messages arrive; the second mentions Mateo.
2. His background device misses every Broadcast.
3. He opens the stream on the laptop and marks through ordinal 43 seen.
4. The second device reconnects from its older workspace cursor.

**Expected user-visible behavior:** **Unread** and **You Are Mentioned** appear
until the authorized waterline advances. Both devices converge; seen never
moves backward.

**Architecture stress:** Append transactions create attention/mention rows and
upsert only Mateo's sparse overlay. `mark_workstream_seen` uses `GREATEST` and
durable personal events. Broadcast is only a hint.

**Failure oracle:** Fail if a missed socket loses the mention, one device
recreates unread after the other marks seen, or a waterline acknowledges hidden
or future content.

**Unresolved pressure:** Decide when exact unread count becomes a capped or
lazy count for very busy streams.

### S03 — A disconnected client rejoins an active stream exactly once

**Mode:** Showcase

**Persona:** Mateo's network drops while Avalon is streaming.

**Preconditions:** The run has an active output checkpoint at byte 2,400 and the
client has fetched through byte 2,400 from coordinate hints.

**Flow:**

1. The socket disconnects for eight seconds.
2. The executor continues database checkpoints and body-free coordinate hints.
3. Mateo reconnects by subscribe-buffer-snapshot.
4. The run seals one assistant part.

**Expected user-visible behavior:** Text resumes from the committed offset,
provisional overlap reconciles in place, and completion appears once.

**Architecture stress:** `active_outputs` commits bytes and offset together;
Realtime carries attempt/revision/sequence coordinates and the client fetches
text through live RLS. Durable work-stream events fill gaps.

**Failure oracle:** Fail if text disappears, repeats visibly, an old attempt
overwrites the winner, or the client depends on Broadcast Replay for recovery.

**Unresolved pressure:** Tune observed/unobserved checkpoint intervals against
database WAL and regeneration cost.

### S04 — A private evidence chat cannot become shared history

**Mode:** Showcase

**Persona:** Samantha privately asks Avalon about sensitive evidence.

**Preconditions:** She can read the main stream and creates a `private_chat`
with a frozen main-feed fence and owner-only audience.

**Flow:**

1. The chat inherits only content Samantha could see at its base sequence.
2. Avalon responds privately.
3. A shared compaction, search, digest, and sidebar preview run later.
4. Samantha promotes a deliberately redacted summary to main.

**Expected user-visible behavior:** Only the approved promoted summary becomes
shared; private source and response remain absent everywhere else.

**Architecture stress:** Part audience, source fence, compaction/search/vector
epochs, and promotion authorization are enforced inside regional queries. A
substream ID is never authority.

**Failure oracle:** Fail if private text enters a common preview, event payload,
embedding result, digest, export for another person, log, or shared model array.

**Unresolved pressure:** Define the product review UI and audit for redacted
promotion.

### S05 — A fork preserves the exact completed past

**Mode:** Showcase

**Persona:** Samantha explores two responses to the same decision.

**Preconditions:** Main history is complete through sequence 120.

**Flow:**

1. She creates two human forks at base sequence 120.
2. Main receives sequences 121–125 while both forks run.
3. One fork is promoted; the other is abandoned.

**Expected user-visible behavior:** Both forks see the same frozen past, never
the new main tail. Main gains one provenance-bearing promoted part.

**Architecture stress:** `substreams.base_seq`, explicit lineage, one global
work-stream sequence, and `substream_promotions` preserve causality without
copying the transcript.

**Failure oracle:** Fail if fork context drifts, promotion widens private source,
or abandoning the other fork removes canonical history.

**Unresolved pressure:** Decide whether a promoted result also completes or
keeps the source fork queryable.

### S06 — Sub-agents branch without becoming sidebar conversations

**Mode:** Showcase

**Persona:** Avalon starts three bounded investigations.

**Preconditions:** The parent loop has breadth/depth/tool budgets.

**Flow:**

1. One child is fresh, one forks an exact context, and one focuses on a document.
2. Each runs through the generic driver and records tool effects.
3. Results settle one parent tool call each.

**Expected user-visible behavior:** The sidebar still shows one work stream;
users can inspect child provenance without three unrelated cards.

**Architecture stress:** Child substreams and owner-neutral `agent_runs` reuse
the run engine. Causal effect keys make retry return the same child/result.

**Failure oracle:** Fail if a retry spawns duplicate children, a fresh child gets
ambient history/credentials, or a child appears as a top-level work stream.

**Unresolved pressure:** Choose inspection/retention UX for high-volume child
tool chatter.

### S07 — Steering during time to first token interrupts cleanly

**Mode:** Showcase

**Persona:** Mateo corrects a premise two seconds after sending.

**Preconditions:** The model request has started but emitted no token; normal
TTFT is 1–5 seconds.

**Flow:**

1. Mateo sends a steering message.
2. The append RPC commits it and advances `control_revision`.
3. Run-control Broadcast aborts the provider request when supported.
4. The stale attempt fails its commit fence; the new batch runs.

**Expected user-visible behavior:** The correction is immediately shown as
committed/steering and the final response uses it once.

**Architecture stress:** Low-latency Realtime is cooperative; database revision
CAS is authoritative when abort arrives late or not at all.

**Failure oracle:** Fail if success is acknowledged before the message commit,
the old answer seals, or two full responses appear.

**Unresolved pressure:** Define visible wording when provider cancellation is
unsupported but stale output is safely discarded.

### S08 — Steering during an ordinary tool waits only as needed

**Mode:** Showcase

**Persona:** Samantha steers while a read-only tool is several seconds into use.

**Preconditions:** The effect is recorded as cooperatively cancellable and
read-only.

**Flow:**

1. Steering commits and invalidates the attempt.
2. The adapter cancels the tool or lets its short read finish.
3. Its stale result is settled but not admitted to the next model context.
4. The run resumes from the new input batch.

**Expected user-visible behavior:** The UI says interrupting briefly, then uses
the correction without pretending the tool never ran.

**Architecture stress:** Effect receipt, cancellability, control revision, and
completion CAS separate physical completion from semantic admission.

**Failure oracle:** Fail if a new tool begins under the old revision, the stale
result changes canonical output, or the loop remains stuck after a settled read.

**Unresolved pressure:** Establish per-tool cancellation UX and telemetry SLOs.

### S09 — A Terminal tail does not make steering disappear

**Mode:** Showcase

**Persona:** Mateo steers during a Daytona command that lasts four minutes.

**Preconditions:** The command has a durable effect and provider command ID; it
may have filesystem effects and cannot be assumed cancellable.

**Flow:**

1. Steering commits while the Edge/Workflow adapter is attached.
2. The active adapter requests cancellation if supported and parks before its
   runtime limit.
3. A callback or reconciler records partial output and final provider status.
4. No next effect begins under the old revision; the loop resumes or asks.

**Expected user-visible behavior:** The message stays visible and the UI reports
that it is waiting for/reconciling Terminal rather than losing the correction.

**Architecture stress:** Daytona remains external and addressable. `tool_effects`
and `terminal_commands` survive adapter/driver/client lifetimes.

**Failure oracle:** Fail if timeout blindly starts a duplicate command, steering
vanishes, a late command result resumes stale reasoning, or prior filesystem
effects are described as rolled back.

**Unresolved pressure:** Validate Daytona callback/status/cancel/idempotency and
output checkpoint APIs.

### S10 — An uncertain external write asks instead of guessing

**Mode:** Showcase

**Persona:** Avalon posts to an external service whose response is lost.

**Preconditions:** The provider lacks both idempotency and a reliable lookup.

**Flow:**

1. Avalon commits planned/started effect intent.
2. The remote request may have succeeded, but the adapter crashes.
3. Reconciliation cannot prove outcome.
4. The run becomes `waiting_user` with `ambiguous_external_effect`.

**Expected user-visible behavior:** The user sees the uncertain action and can
choose how to proceed; it is grouped as error/intervention, not ordinary active.

**Architecture stress:** External effects are not made atomic by Postgres,
Queues, Edge, or Workflow retries. The effect state is honest.

**Failure oracle:** Fail if the system silently retries, marks success/failure
without evidence, or hides the ambiguity in a generic spinner.

**Unresolved pressure:** Define operator/user resolution actions per provider.

### S11 — Shared provider ingress reaches one regional owner once

**Mode:** Showcase

**Persona:** Elena connects a provider whose global webhook serves EU and US
workspaces.

**Preconditions:** The callback can resolve an installation to an opaque regional
route without storing its body globally.

**Flow:**

1. The provider retries one signed event three times.
2. The ingress routes to the workspace's project and writes one raw receipt.
3. A logged queue normalizes it once into activity.
4. Reconciliation observes the same provider ID later.

**Expected user-visible behavior:** One activity appears with correct provenance
and latency; no cross-region copy or duplicate suggestion is visible.

**Architecture stress:** Unique installation/event ID plus body hash,
transactional enqueue, inbox receipt, and regional Storage resolve retries.

**Failure oracle:** Fail if EU content is stored/processed in Global, duplicate
activity appears, or a differing body overwrites the first receipt.

**Unresolved pressure:** Verify every provider's route metadata and maximum
acknowledgement deadline.

### S12 — A planned automation work stream accepts pre-run collaboration

**Mode:** Showcase

**Persona:** Elena schedules an automation and teammates add context before it
runs.

**Preconditions:** A real scheduled work stream already exists and is listed as
In Progress.

**Flow:**

1. The scheduled objective creates root substream and initial part.
2. Two users add queued context before due time.
3. Cron wakes the durable due state once.
4. The full loop admits the exact pending range.

**Expected user-visible behavior:** The work stream is collaborative before its
run and executes once with all committed context in order.

**Architecture stress:** Work-stream transaction/order and owner-neutral run
admission unify scheduled and interactive work; Cron is only a wake-up.

**Failure oracle:** Fail if each context message creates another schedule/run,
the Cron overlap duplicates admission, or planned work is confused with a
suggestion.

**Unresolved pressure:** Define editing/cancellation semantics before scheduled
admission.

### S13 — A scoped export reflects the conversation model

**Mode:** Showcase

**Persona:** Maya exports one work stream for audit.

**Preconditions:** It has main/private substreams, attachments, compactions,
active/terminal runs, activity links, and suggestions with different audiences.

**Flow:**

1. Maya requests an export and an authorization/source fence is frozen.
2. Bounded jobs write hashed Storage chunks and a manifest.
3. Content arriving above the fence is omitted explicitly.
4. Maya receives a short-lived download after a live permission check.

**Expected user-visible behavior:** The manifest explains included/omitted
content, lineage, and revisions; private content follows export authority.

**Architecture stress:** Relational traversal and `content_refs` manifest replace
object-fleet traversal; export chunks resume by receipt.

**Failure oracle:** Fail if signed URLs are persisted, Storage bytes are omitted
silently, post-fence rows leak in, or another audience's private chat appears.

**Unresolved pressure:** Finalize product/legal export formats and whether owner
admins may export other people's private lanes.

### S14 — Work-stream deletion cannot be undone by a late event

**Mode:** Showcase

**Persona:** Maya deletes a work stream while a run and connector event are in
flight.

**Preconditions:** The stream has queued derived jobs and Storage objects.

**Flow:**

1. The deletion transaction marks it deleting and advances auth/control epochs.
2. New commands, run steps, and suggestion promotion are denied.
3. Late completions fail their fences.
4. Bounded deletion jobs remove rows/bytes/derived indexes and verify receipts.

**Expected user-visible behavior:** The card disappears immediately and never
reappears from a late Broadcast, queue retry, or connector link.

**Architecture stress:** One regional authority and revisioned events prevent a
late projection from recreating state; Storage deletion is separately verified.

**Failure oracle:** Fail if a late task reopens the stream, content remains
accessible, or database cascade is treated as proof of Storage deletion.

**Unresolved pressure:** Define undo/legal-hold windows before physical phases.

### S15 — An EU work stream never needs a Global content path

**Mode:** Showcase

**Persona:** Priya audits an EU workspace using messages, files, connectors,
vectors, realtime, and a long loop.

**Preconditions:** The contracted EU Supabase/provider path is approved; the
Workflow driver is enabled only if separately approved.

**Flow:**

1. The global plane resolves only the opaque regional route.
2. The client gets a regional session and connects to the EU project.
3. All data, jobs, files, search, and events stay regional.
4. The audit traces subprocessors and approved opaque driver fields.

**Expected user-visible behavior:** Features work without copying product
metadata/content into the Global project; unapproved features fail closed.

**Architecture stress:** Project boundary, explicit Edge invocation region,
regional secrets/storage, and data-minimal optional Workflow are reviewed as a
whole rather than inferred from database location.

**Failure oracle:** Fail if Global contains a title/body/user overlay/vector, an
unapproved processor handles content, or outage silently fails over regions.

**Unresolved pressure:** Contractually confirm Realtime, Edge, logs, backups,
support, and Workflow locality.

### S16 — Dormant work streams migrate without waking an entity fleet

**Mode:** Showcase

**Persona:** Ren migrates millions of mostly dormant D1 work streams.

**Preconditions:** Supabase schema is additive and imports are chunked by stable
regional ranges.

**Flow:**

1. Immutable D1/R2 export chunks land in destination regional Storage.
2. Queue workers load/transform bounded ranges with receipts.
3. Active workspaces are prioritized; dormant rows require no process creation.
4. Validation decides eligibility for later route cutover.

**Expected user-visible behavior:** Active use remains responsive; a dormant
stream behaves normally when eventually opened/cut over.

**Architecture stress:** Shared Postgres migration is row/range based, not lazy
object instantiation. Campaign concurrency and database I/O are the pressure.

**Failure oracle:** Fail if migration needs one runtime per stream, blocks the
regional primary, or treats imported shadow rows as authority before the
source-local gate closes and destination verifies that closure.

**Unresolved pressure:** Establish initial cohort order and cutover SLO for a
long-dormant workspace.

### S17 — Non-work-stream loops share execution without sharing domain state

**Mode:** Showcase

**Persona:** Elena uses automation drafting while a meeting summary runs.

**Preconditions:** Both domain owners implement the generic run adapter.

**Flow:**

1. Automation starts an iterative elicitation loop.
2. Meeting domain starts its final-summary loop.
3. Both use the same driver/step/effect/wait machinery.
4. Each commits output only through its domain RPC.

**Expected user-visible behavior:** Both survive retry/deploy consistently;
neither creates a fake work stream or leaks state to the other.

**Architecture stress:** `agent_runs.owner_kind/id` and narrow domain adapters
share orchestration while domain tables remain authority.

**Failure oracle:** Fail if the driver writes arbitrary domain rows, work-stream
assumptions break another loop, or an owner loses idempotent terminal state.

**Unresolved pressure:** Inventory which bounded inference jobs need full-loop
orchestration versus one Edge call.

### S18 — Teammates queue follow-ups and then steer one active loop

**Mode:** Showcase

**Persona:** Samantha and Mateo collaborate during a 12-minute investigation.

**Preconditions:** The loop has several model/tool iterations.

**Flow:**

1. Samantha queues two follow-ups; Mateo queues one.
2. The active iteration continues.
3. Mateo sends an urgent steering correction.
4. The old attempt stops at a safe boundary; the next admission orders the
   steering input and eligible queued inputs by policy.

**Expected user-visible behavior:** Every committed message shows its status,
none disappears, and users see one coherent resumed answer.

**Architecture stress:** One work-stream sequence, admission batches, and a
separate control revision distinguish arrival from semantic admission.

**Failure oracle:** Fail if queue messages cancel early work, steering drops a
queued message, messages are admitted twice, or order varies across retry.

**Unresolved pressure:** Decide the exact product order between an urgent steer
and older queued follow-ups when both are relevant.

### S19 — Messages remain safe while compaction summarizes an older prefix

**Mode:** Showcase

**Persona:** Mateo continues a long thread while context compaction runs.

**Preconditions:** The job freezes complete turns through sequence 900.

**Flow:**

1. Compaction reads the exact source rows/hashes.
2. Users append sequences 901–920 and one steering message.
3. The worker commits its summary only against the frozen epochs.
4. The next projection uses summary through 900 plus the visible tail.

**Expected user-visible behavior:** Sending remains available; no new message is
lost, duplicated, or absorbed into the old summary.

**Architecture stress:** Frozen `compaction_sources`, row-level append ordering,
and completion CAS separate derived prefix work from live tail writes.

**Failure oracle:** Fail if the job observes later rows opportunistically,
deletes its source, blocks sends, or omits any tail part from projection.

**Unresolved pressure:** Tune source-range size and when invalid jobs are retried.

### S20 — Sidebar and home share one work-stream-of-interest projection

**Mode:** Showcase

**Persona:** Maya checks sidebar and main workspace screen.

**Preconditions:** She has pins, unread streams, mentions, input requests,
accepted suggestions, and recently opened streams.

**Flow:**

1. One snapshot RPC returns common cards and her overlays.
2. A message mention, completion, and pin change commit.
3. Workspace Broadcast hints identify affected cards/collections.
4. Both surfaces patch from the same durable events.

**Expected user-visible behavior:** Collection counts and cards agree everywhere
and remain stable under reload/pagination.

**Architecture stress:** Relational projection and documented interest bits
replace two materializers. Common and personal revisions prevent stale patches.

**Failure oracle:** Fail if home/sidebar disagree, private state leaks to another
member, or a lost Broadcast causes permanent count drift.

**Unresolved pressure:** Decide recency duration and whether muted unread remains
in the broader interest union.

### S21 — Unclaimed connector activity becomes one suggested work stream

**Mode:** Showcase

**Persona:** Elena receives a cluster of related activity with no existing work
stream.

**Preconditions:** Normalized events share an authorized opportunity key.

**Flow:**

1. Detection freezes source watermark and creates one suggestion.
2. Maya sees provenance/explanation and accepts it.
3. One transaction creates the work stream, root substream, initial parts/card,
   records acceptance, and enqueues the first run.
4. A retried click returns the same work stream.

**Expected user-visible behavior:** The proposal becomes one real work stream at
acceptance, with source context and no duplicate.

**Architecture stress:** Relational source links and suggestion lock/receipt
make promotion atomic with workspace projections.

**Failure oracle:** Fail if suggestion appears in real collections beforehand,
acceptance creates two streams, or source access is not revalidated.

**Unresolved pressure:** Define when multiple similar opportunities merge versus
remain separate proposals.

### S22 — Suggested context becomes a targeted action in an existing stream

**Mode:** Showcase

**Persona:** Mateo is shown a private suggested action related to his work.

**Preconditions:** Source activity is visible to Mateo but not every participant.

**Flow:**

1. The suggestion appears only in Mateo's personal surface.
2. He reviews its provenance and accepts a redacted/authorized target action.
3. The transaction creates a run/effect intent in the existing work stream.
4. Execution and result follow generic receipts.

**Expected user-visible behavior:** Other users see nothing before the accepted
action produces authorized shared history.

**Architecture stress:** Suggestion audience is separate from target work-stream
audience; acceptance is a disclosure and effect boundary.

**Failure oracle:** Fail if private source text leaks through card/Realtime/model
context, or acceptance executes twice.

**Unresolved pressure:** Specify when accepting an action requires an explicit
redaction/composition review.

### S23 — An additive schema change remains online

**Mode:** Showcase

**Persona:** Ren adds a nullable work-stream card field.

**Preconditions:** Old and new app versions coexist.

**Flow:**

1. CI applies the additive regional migration with bounded lock timeout.
2. New code writes the field; old readers ignore it.
3. Existing rows use null/default semantics until a backfill is justified.
4. Metrics confirm no interactive regression.

**Expected user-visible behavior:** No maintenance screen or per-work-stream
wake-up; cards remain readable throughout.

**Architecture stress:** One regional DDL operation replaces millions of object
constructors, but its shared blast radius requires online Postgres practice.

**Failure oracle:** Fail if migration rewrites/locks the hot table unexpectedly,
requires full backfill before deploy, or exposes a table/function accidentally.

**Unresolved pressure:** Define production lock-duration budgets per table tier.

### S24 — A regional sweep backfills online and pauses safely

**Mode:** Showcase

**Persona:** Ren backfills a new content hash across 50 million rows.

**Preconditions:** Readers tolerate null and jobs are key-range partitioned.

**Flow:**

1. Campaign creates bounded jobs and throttled queue wakes.
2. Workers claim with `SKIP LOCKED`, update small batches, and write receipts.
3. Ren pauses when interactive p95 rises.
4. Running transactions finish; no new jobs claim; resume continues idempotently.

**Expected user-visible behavior:** Interactive use remains responsive and no
visible content changes inconsistently.

**Architecture stress:** Pause epoch, small transactions, due-state, and receipts
bound a shared-primary transform.

**Failure oracle:** Fail if pause claims atomic recall of external work, replay
duplicates/corrupts hashes, or jobs monopolize connections/WAL.

**Unresolved pressure:** Set automatic throttles from DB/queue SLO signals.

### S25 — D1 and R2 data copy while held writes remain durable

**Mode:** Showcase

**Persona:** Maya's active workspace is cut over.

**Preconditions:** Shadow copy is validated and source writer can hold/outbox
accepted commands briefly.

**Flow:**

1. Migration establishes a bounded write hold and final source cursor.
2. Remaining D1 rows/R2 objects and outbox commands are copied and hashed.
3. Source/destination invariants pass.
4. One source-D1-local gate closes at the new epoch; destination verifies the
   closure, activates, and global routing converges afterward.

**Expected user-visible behavior:** A short explicit saving delay is possible,
but every acknowledged write appears exactly once after cutover.

**Architecture stress:** Immutable chunks, row receipts, Storage manifests,
source outbox, and one source-local authority linearization replace dual writes.

**Failure oracle:** Fail if both sides accept writes, destination activates
without the source closure receipt, a crash between derived route updates creates
another writer, held queue overflows silently, or a hash mismatch is ignored.

**Unresolved pressure:** Define the maximum hold duration/backpressure UI for a
very hot workspace.

### S26 — Clients and drivers learn a new protocol before it is required

**Mode:** Showcase

**Persona:** Ren deploys a new event/step version across desktop, Edge, and
Workflow.

**Preconditions:** Runs and old clients may remain active for hours.

**Flow:**

1. Additive tables/functions emit old and new compatible envelopes.
2. Consumers advertise/read supported versions.
3. New driver steps start only after adapters are compatible.
4. Old representation is removed after active-version drain and soak.

**Expected user-visible behavior:** Active runs and sockets continue across
deploy; incompatible clients get explicit upgrade rather than corrupt patches.

**Architecture stress:** Row/API/driver version fields and expand-contract
replace implicit in-process protocol upgrade.

**Failure oracle:** Fail if a new writer emits an unreadable event/step before
consumers exist or old runs are reinterpreted by incompatible code.

**Unresolved pressure:** Decide maximum supported desktop/driver skew.

### S27 — An EU migration wakes only regional data workers

**Mode:** Showcase

**Persona:** Priya watches an EU-only backfill.

**Preconditions:** The EU project owns campaign, jobs, queue, Storage staging,
and Edge secrets.

**Flow:**

1. Regional Cron wakes the EU dispatcher.
2. Queue messages contain only local IDs and load content from EU Postgres.
3. Workers process bounded jobs in the forced EU execution region.
4. Metrics/logs follow the approved regional path.

**Expected user-visible behavior:** Migration completes without a Global content
copy or an external always-on control server.

**Architecture stress:** Regional Supabase primitives remove cross-region shard
wakes; legal review still covers globally deployed Edge/Realtime internals.

**Failure oracle:** Fail if a global queue/worker receives bodies, an EU job
runs in an unapproved region, or failure redirects to US.

**Unresolved pressure:** Confirm Supabase job/function/log contractual locality.

### S28 — One multiplexed socket covers a foreground workspace

**Mode:** Showcase

**Persona:** Mateo has 2,000 visible work streams but opens two.

**Preconditions:** The main process owns the regional Realtime client.

**Flow:**

1. It joins common/personal active-workspace topics.
2. It joins two foreground work-stream topics on the same physical socket.
3. It leaves one after a grace period and opens another.
4. Backgrounding closes the connection when no live contract remains.

**Expected user-visible behavior:** Sidebar stays current; opened streams are
live; background/focus recovery is smooth without reconnect churn.

**Architecture stress:** Supabase's 100-channel-per-connection model is used as
intended; database cursors cover closed channels.

**Failure oracle:** Fail if there is a socket per stream, idle background usage
grows with historical count, or reconnect requires Broadcast history.

**Unresolved pressure:** Set grace/background rules and completion-notification
contract.

### S29 — UI frames and durable checkpoints keep independent time

**Mode:** Showcase

**Persona:** Samantha watches a fast model produce 80 token fragments per
second.

**Preconditions:** Two viewers are foreground; database load is normal.

**Flow:**

1. Executor coalesces tokens into `active_outputs` every 250–500 ms.
2. It sends body-free coordinate hints; clients fetch text through live RLS.
3. One viewer disconnects between checkpoints and reconnects.
4. Completion seals one part.

**Expected user-visible behavior:** Both viewers perceive fluid output; recovery
has bounded overlap and no missing committed text.

**Architecture stress:** Realtime messages scale with receivers, while database
WAL scales with checkpoints—not tokens. Faster body frames remain gated on a
proven revocable stream lease and a 30-fps ceiling.

**Failure oracle:** Fail if tokens cause rows, hints contain generated bodies
without a revocable lease, durable cursor advances without bytes, fan-out is
workspace wide, or final text differs from one winning attempt.

**Unresolved pressure:** Tune frame/checkpoint cadence by model rate, observers,
cost, and primary load.

### S30 — An exceptional transform uses bounded queue slices

**Mode:** Showcase

**Persona:** Ren needs to parse a very large import beyond one Edge CPU budget.

**Preconditions:** The transform can split by immutable chunks and row ranges.

**Flow:**

1. A coordinator validates/stages Storage chunks.
2. Queue jobs process small CPU-bounded ranges in Edge/database functions.
3. Each range records counts/hashes and can retry.
4. A validator combines only references and commits campaign success.

**Expected user-visible behavior:** The migration progresses without holding an
always-on server or blocking interactive traffic.

**Architecture stress:** The Supabase-only constraint forbids hiding the work in
a Cloudflare Container; chunking must fit Edge CPU/memory or use provider-native
bulk/database operations.

**Failure oracle:** Fail if one Edge call exceeds limits, unbounded JSON is held
in memory, or a coordinator becomes the only copy of progress.

**Unresolved pressure:** Identify any indivisible transforms that would force a
future runtime-scope decision.

### S31 — A thirty-minute agent loop spans durable actions

**Mode:** Showcase

**Persona:** Avalon performs a 30-minute investigation with 12 model calls,
ordinary tools, and two Daytona commands.

**Preconditions:** The region allows the default Workflow driver; Supabase is
authoritative.

**Flow:**

1. Admission creates run/batch and one Workflow instance.
2. Each model/tool/effect settlement is a bounded step through regional RPCs.
3. The client closes; the Workflow waits or continues independent of it.
4. Terminal completion atomically seals output/sidebar/events in Supabase.

**Expected user-visible behavior:** Reopening shows exact progress and final
state; no action repeats across deploy/retry.

**Architecture stress:** One Workflow matches the full-loop lifetime but holds
only opaque state. Supabase revisions/receipts decide every action.

**Failure oracle:** Fail if the full loop is one Edge/Workflow retry unit, state
history exists only in Workflow, or client/socket loss owns cancellation.

**Unresolved pressure:** Compare failure/cost data with the Supabase-native
driver before final regional rollout.

## Break-attempt studies

### B01 — The regional primary becomes the hottest object

**Mode:** Break attempt

**Persona:** Maya's 100,000-member workspace generates many card and attention
changes while connectors ingest bursts.

**Preconditions:** All product tables and queues share one regional Postgres
primary.

**Flow:**

1. Thousands of work streams update concurrently.
2. Workspace event allocation/card indexes and Realtime database sends contend.
3. Connector and embedding jobs add WAL/IO.
4. Operators throttle derived work and inspect locks/query plans.

**Expected user-visible behavior:** Interactive mutations remain within SLO or
return honest capacity state; one workspace does not serialize all streams.

**Architecture stress:** Work-stream row locks distribute write serialization,
but shared sequences/indexes/primary resources can reintroduce a hot point.

**Failure oracle:** Fail if every append locks `workspaces`, derived jobs starve
users, or no capacity control can isolate a tenant/workload.

**Unresolved pressure:** Benchmark sequence allocation and decide when a region
needs intra-region project sharding.

### B02 — Per-person sidebar state becomes a Cartesian product

**Mode:** Break attempt

**Persona:** Maya has 100,000 members and one million historical work streams.

**Preconditions:** Most people interact with a small subset.

**Flow:**

1. A workspace-wide event occurs on a popular stream.
2. A naive design writes 100,000 overlay rows/counts.
3. More global events arrive.
4. Users later open only a few streams.

**Expected user-visible behavior:** Attention stays correct without a massive
write spike or storage multiplication.

**Architecture stress:** Sparse rows plus audience attention ordinals/lazy
evaluation must cover the default state.

**Failure oracle:** Fail if common changes upsert every user, exact counts demand
unbounded synchronous fan-out, or absent row semantics become ambiguous.

**Unresolved pressure:** Specify the lazy exact-count query/cache threshold.

### B03 — Membership is revoked while a private channel is joined

**Mode:** Break attempt

**Persona:** Priya removes a contractor whose desktop is still connected.

**Preconditions:** The contractor joined workspace/work-stream topics with a JWT
issued minutes ago.

**Flow:**

1. Removal commits and advances membership/authorization epochs.
2. The old channel remains physically connected until Realtime reauthorization
   or explicit eviction.
3. New messages/events occur; any old channel receives at most body-free,
   non-subject coordinate/eviction traffic permitted by policy.
4. The client tries catch-up/content fetch and a command.

**Expected user-visible behavior:** New content/actions and active-output text
fetches are denied immediately; the socket is evicted within the tested maximum
window.

**Architecture stress:** Supabase RLS for fetch/command is live, while already-
joined Broadcast authorization is cached. Launch Realtime payloads contain no
generated body and restricted subject hints are audience/personal scoped.

**Failure oracle:** Fail if an old channel receives generated/private bodies,
old JWT authorizes new RPCs, signed URLs remain usable beyond policy, or no
eviction bound exists.

**Unresolved pressure:** Vendor-test topic reauthorization/forced disconnect and
whether a rotatable stream-key lease can safely enable faster body frames later.

### B04 — Realtime hints arrive late, out of order, and after deletion

**Mode:** Break attempt

**Persona:** Mateo's devices receive delayed Broadcasts.

**Preconditions:** A title, run state, mention, completion, and deletion commit
in rapid order.

**Flow:**

1. Broadcasts are duplicated and permuted.
2. One personal event is missing.
3. A pre-deletion card hint arrives last.
4. Clients fetch durable events/snapshot by cursor and revision.

**Expected user-visible behavior:** Both surfaces converge to deleted/hidden;
private patches never cross users.

**Architecture stress:** Common/user revisions and durable cursor are authority;
no single Realtime message is a replacement instruction.

**Failure oracle:** Fail if stale hints resurrect a card, one child revision
drops an unrelated field patch, or reconnect cannot detect the gap.

**Unresolved pressure:** Decide field-level versus whole-card revision envelopes.

### B05 — Realtime is unavailable but Postgres is healthy

**Mode:** Break attempt

**Persona:** Samantha works during a regional Realtime incident.

**Preconditions:** Database/API and Queues still accept commands.

**Flow:**

1. Message append succeeds but Broadcast fails.
2. Another client sees no push.
3. Poll-on-focus/manual refresh queries durable cursor.
4. Active output remains in durable checkpoints but loses immediate coordinate
   hints until refresh/poll.

**Expected user-visible behavior:** The sender gets committed status; other users
recover durable messages/state, with degraded live streaming clearly indicated.

**Architecture stress:** Database transaction must not roll back merely because
Realtime delivery failed; Broadcast is never the outbox authority.

**Failure oracle:** Fail if committed state is lost, command latency waits on a
fragile external send, or clients cannot recover terminal text.

**Unresolved pressure:** Define degraded polling cadence that avoids creating a
new idle-cost problem.

### B06 — Two clients reuse one idempotency key with different bodies

**Mode:** Break attempt

**Persona:** Mateo's offline clients accidentally share an operation key.

**Preconditions:** One posts “ship,” the other “do not ship.”

**Flow:**

1. The first request claims receipt and commits.
2. The second arrives with the same scoped key and another request hash.
3. The server returns a stable idempotency conflict.
4. The client generates a new key only after user resolution.

**Expected user-visible behavior:** The second body is never silently replaced
or treated as the first.

**Architecture stress:** `command_receipts` bind operation key to request hash
inside the command transaction.

**Failure oracle:** Fail if last-write-wins changes the committed message,
hash-only global dedup conflates unrelated actions, or both append.

**Unresolved pressure:** Define offline client UX for key conflicts.

### B07 — A crash leaves a tool call without a result

**Mode:** Break attempt

**Persona:** Avalon crashes after starting a provider tool.

**Preconditions:** Tool-call part/effect is committed; result settlement is not.

**Flow:**

1. Driver retries or reconciler claims the run.
2. It finds the existing effect/provider reference.
3. It queries provider or classifies unknown.
4. It appends one result/error and continues or asks.

**Expected user-visible behavior:** Transcript shows an honest settled result,
not a repeated invisible tool action.

**Architecture stress:** Complete-turn projector excludes dangling tool pairs;
effect receipt is scoped to causal step, not just tool/input.

**Failure oracle:** Fail if the next user message is projected between a call and
missing result, retry repeats a write, or a dangling call enters provider input.

**Unresolved pressure:** Define timeout-to-reconciliation policies per tool.

### B08 — Compaction launders private content across audiences

**Mode:** Break attempt

**Persona:** A compactor can read a private chat and shared main history.

**Preconditions:** A cache key omits audience or resource authorization revision.

**Flow:**

1. It creates a summary with both sources.
2. Membership/resource access changes.
3. Another person's main projection considers the summary.
4. The validity checks reject it and schedule a safe compaction.

**Expected user-visible behavior:** No private fact appears, even as paraphrase
or vector/snippet.

**Architecture stress:** Source rows, content hashes, audience, workspace/work-
stream auth epochs, and resource revisions are all part of validity.

**Failure oracle:** Fail if a content-only compaction key reuses the artifact,
fallback summary bypasses current auth, or source deletion leaves it searchable.

**Unresolved pressure:** Define how to prove semantic removal in derived caches
and model-provider retention.

### B09 — A live document changes beneath its chat

**Mode:** Break attempt

**Persona:** Samantha discusses a document while Elena replaces it.

**Preconditions:** The document chat declares a frozen version policy.

**Flow:**

1. A run materializes version 7.
2. The connector ingests version 8 and tombstones access to a referenced section.
3. The run attempts to commit a version-7-derived response.
4. Scope/resource revision check rejects or labels the frozen evidence explicitly.

**Expected user-visible behavior:** The answer is either honestly tied to version
7 or rerun; it never masquerades as current version 8.

**Architecture stress:** `resource_revision` and scope epoch flow through
substream, parts, compaction, embeddings, and run step.

**Failure oracle:** Fail if “live” inheritance changes between retries, revoked
content is used, or the UI loses version provenance.

**Unresolved pressure:** Decide which document chats permit frozen versus
explicitly refreshed context.

### B10 — Referenced content is huge, corrupt, or unavailable

**Mode:** Break attempt

**Persona:** Avalon projects a transcript with a large attachment.

**Preconditions:** The Storage object may be missing, wrong-sized, hash-mismatched,
or too large for model/Edge limits.

**Flow:**

1. Materializer authorizes the reference and checks ready metadata.
2. Trusted code streams/verifies within size/type policy.
3. Failure produces an explicit content error or approved authorized fallback.
4. Orphan/corruption reconciliation opens a repair job.

**Expected user-visible behavior:** The run asks for repair/reupload or uses a
clearly labelled safe fallback; it never silently drops evidence.

**Architecture stress:** `content_refs` is authority while Storage supplies
bytes; Edge CPU/memory and signed URL boundaries are enforced.

**Failure oracle:** Fail if corrupt bytes reach the model, a fallback bypasses
authorization, the function buffers an unbounded object, or path guesses grant
access.

**Unresolved pressure:** Set per-kind inline/upload/model-context limits.

### B11 — A provider reuses a delivery ID with different bytes

**Mode:** Break attempt

**Persona:** Elena receives a buggy or malicious webhook replay.

**Preconditions:** The installation/event ID already has an accepted body hash.

**Flow:**

1. A second signed delivery has the same ID and another hash.
2. Ingress finds the existing receipt before normalization.
3. It records a quarantined conflict without replacing evidence.
4. Operators inspect redacted metadata and provider logs.

**Expected user-visible behavior:** Existing activity is stable; no duplicate or
mutated suggestion appears.

**Architecture stress:** The scoped unique canonical receipt distinguishes retry
from collision, while a separate immutable `ingress_receipt_conflicts` row owns
the second hash/body evidence without violating or mutating that key.

**Failure oracle:** Fail if upsert overwrites the first body, hash is ignored, or
the conflict loops indefinitely in the normal queue.

**Unresolved pressure:** Decide provider-specific escalation and raw conflict
retention.

### B12 — Workspace export and deletion stress one shared database

**Mode:** Break attempt

**Persona:** Maya exports then deletes a workspace with 50 million events and
many Storage objects.

**Preconditions:** Interactive work for other tenants shares the primary.

**Flow:**

1. Export freezes a fence and processes keyset chunks.
2. Deletion closes admission and processes relational/Storage phases.
3. Jobs pause/throttle on primary pressure.
4. Receipts verify completion separately from backup expiry.

**Expected user-visible behavior:** Progress is resumable and other workspaces
stay responsive; deletion is not declared complete prematurely.

**Architecture stress:** Shared SQL simplifies traversal but large scans/deletes
can cause locks/WAL/bloat; bounded jobs and partitions/retention must cope.

**Failure oracle:** Fail if one transaction cascades the tenant, export changes
underfoot, Storage is forgotten, or PITR retention is called active deletion.

**Unresolved pressure:** Establish tenant-size thresholds for dedicated project
placement or specialized archival tooling.

### B13 — Cutover collides with every write path

**Mode:** Break attempt

**Persona:** Ren cuts over while users, connectors, scheduled runs, and tool
callbacks write.

**Preconditions:** Old and new systems both have code deployed.

**Flow:**

1. The migration hold fences each source writer/outbox.
2. Late callbacks carry old route/authority epochs.
3. One source-D1 transaction closes the authority gate and records final/held
   cursors; destination activates only after verifying that receipt.
4. Global route converges later; held commands replay and stale callbacks cannot
   append.

**Expected user-visible behavior:** Every acknowledged operation exists once;
temporarily rejected/backpressured writes are explicit.

**Architecture stress:** Writer inventory, source-local authority gate, route
epochs, semantic receipts, and source outbox matter more than copy speed.

**Failure oracle:** Fail if any writer bypasses hold, destination opens without
the closure receipt, route/source/destination are assumed atomic, both
authorities accept, or no invariant covers a data family.

**Unresolved pressure:** Keep a checked-in writer inventory and prove it in CI.

### B14 — EU infrastructure fails and an operator wants Global fallback

**Mode:** Break attempt

**Persona:** Priya faces an EU regional outage.

**Preconditions:** Product contracts prohibit unapproved region movement.

**Flow:**

1. EU Database/Realtime or provider path is unavailable.
2. An operator proposes routing to Global/US.
3. The route/control plane refuses content processing there.
4. Clients show regional unavailability and recover in EU later.

**Expected user-visible behavior:** Service degrades honestly without breaking
residency.

**Architecture stress:** Regional project is a hard write authority; read
replicas/global control are not failover authorities.

**Failure oracle:** Fail if convenience override copies content/credentials,
creates a US vector index, or later has conflicting authorities.

**Unresolved pressure:** Define contracted EU DR regions and recovery objectives.

### B15 — A generic target adapter violates the host contract

**Mode:** Break attempt

**Persona:** A new meeting adapter tries to write work-stream tables directly.

**Preconditions:** The trusted runner has a narrow service capability.

**Flow:**

1. Adapter submits an arbitrary owner kind or tenant ID.
2. Regional RPC checks the driver's registered binding/capability.
3. The domain-specific function rejects unauthorized mutation.
4. Audit records opaque target/revision/error.

**Expected user-visible behavior:** No cross-domain/cross-tenant corruption; the
loop fails with an internal error.

**Architecture stress:** A service role would bypass RLS, so trusted adapters
must still use narrowly granted functions and explicit tenant assertions.

**Failure oracle:** Fail if generic runner can update arbitrary canonical tables,
the model chooses owner IDs, or a target mismatch is merely logged.

**Unresolved pressure:** Define runner database roles/capability rotation.

### B16 — A sub-agent branch bomb stays within depth four

**Mode:** Break attempt

**Persona:** Avalon recursively spawns many children.

**Preconditions:** Launch max depth is four with breadth/step/cost budgets.

**Flow:**

1. Children try to create deeper and cyclic substreams concurrently.
2. Creation function locks/checks lineage and budget.
3. Excess requests settle as denied tool results.
4. Existing children continue normally.

**Expected user-visible behavior:** The main loop explains the limit and remains
inspectable rather than exploding the sidebar or run queue.

**Architecture stress:** Recursive integrity must be transactionally checked;
a simple stored `depth` field alone is not cycle proof under malicious input.

**Failure oracle:** Fail if cycles form, limit races oversubscribe, denial leaves
dangling tool calls, or children gain separate cards.

**Unresolved pressure:** Tune breadth/cost reserve for useful parallel research.

### B17 — Tool authority changes during an active run

**Mode:** Break attempt

**Persona:** Maya revokes connector write permission after model inference but
before effect start.

**Preconditions:** The model has proposed a write under an old auth epoch.

**Flow:**

1. Revocation advances workspace/resource/run epochs.
2. Driver receives late model output proposing the tool.
3. `begin_effect` checks current policy in its recording transaction.
4. It denies the write and appends/returns an authorization result.

**Expected user-visible behavior:** No new external write starts; Avalon explains
that permission changed.

**Architecture stress:** Checking before inference is insufficient; effect intent
and live auth check must share one linearization point.

**Failure oracle:** Fail if a TOCTOU lets the provider call begin, or stale JWT/
cached policy grants the tool.

**Unresolved pressure:** Decide which read-only cached tool results remain usable
after authority changes.

### B18 — One work stream outgrows ordinary table/query assumptions

**Mode:** Break attempt

**Persona:** A long-lived coding stream has millions of parts/events and large
Terminal artifacts.

**Preconditions:** It remains one product work stream.

**Flow:**

1. Users open recent history and search old content.
2. Compaction covers model context but not audit storage.
3. Retention/partition/index maintenance runs.
4. Export/deletion later traverse the full lineage.

**Expected user-visible behavior:** Recent reads and appends stay bounded; older
content remains explicitly available or archived per policy.

**Architecture stress:** Postgres has no per-object storage ceiling like a DO,
but unbounded indexes/vacuum/rows still hurt the regional primary.

**Failure oracle:** Fail if queries scan from sequence zero, compaction is
mistaken for deletion, one stream bloats all hot indexes, or Storage links break.

**Unresolved pressure:** Set measured archival/partition thresholds and product
history pagination.

### B19 — A user asks to move a work stream

**Mode:** Break attempt

**Persona:** Maya asks to move one stream from a US workspace to an EU workspace.

**Preconditions:** Region is workspace-scoped and immutable in this PRD.

**Flow:**

1. Product detects cross-workspace/region move request.
2. It refuses in-place identity/authority transfer.
3. It may offer a future explicit export/import-copy workflow with new IDs,
   audiences, provenance, and deletion choice.

**Expected user-visible behavior:** A clear unsupported message; no partial move.

**Architecture stress:** Cross-project transactions, Auth/audience IDs, Storage,
vectors, connector links, run/effect history, and residency make “move” a new
product migration, not a row update.

**Failure oracle:** Fail if foreign keys are repointed across projects, history
is copied without disclosure/re-authorization, or old/new both accept writes.

**Unresolved pressure:** Decide whether to design a separate copy/export product.

### B20 — One person belongs to Global and EU workspaces

**Mode:** Break attempt

**Persona:** Mateo switches repeatedly between a US and EU workspace.

**Preconditions:** Auth sessions are project-local and Realtime connections are
regional.

**Flow:**

1. Global identity routes both opaque workspace IDs.
2. The client establishes/refreshes separate regional sessions.
3. It closes/multiplexes connections according to active workspaces.
4. Logout/removal occurs in only one region, then globally.

**Expected user-visible behavior:** Switching is seamless enough, but revocation
is correctly scoped and global logout reaches both sessions.

**Architecture stress:** Supabase-to-Supabase federation is not assumed; identity
mapping/session lifecycle must be proven.

**Failure oracle:** Fail if one JWT is trusted everywhere without support,
service keys bridge clients, EU data uses a US session, or logout leaves an
unbounded live regional session.

**Unresolved pressure:** Complete the Auth spike and decide refresh/connection UX.

### B21 — Sidebar pagination changes while the user is paging

**Mode:** Break attempt

**Persona:** Maya scrolls 20,000 cards while activity reorders them.

**Preconditions:** Sort is `(last_activity_at desc, id)` and new events arrive.

**Flow:**

1. Client fetches page one with a snapshot/cursor fence.
2. Earlier cards become active and new work streams appear.
3. Client fetches later pages using keyset/snapshot semantics.
4. Durable events patch items above the fence after pagination.

**Expected user-visible behavior:** No card is permanently skipped/duplicated;
new activity may visibly move cards once the snapshot applies.

**Architecture stress:** `OFFSET` and live unstable ordering are rejected; query
API needs a fence or explicit restart semantics plus durable deltas.

**Failure oracle:** Fail if a moved row disappears from all pages, counts/card
snapshot disagree indefinitely, or personal filtering changes the cursor order.

**Unresolved pressure:** Choose database snapshot token versus stable keyset plus
client dedup/restart.

### B22 — Human and connector causality disagree with arrival order

**Mode:** Break attempt

**Persona:** Elena's provider sends an event late after a human already discussed
its result.

**Preconditions:** Provider occurrence time precedes human message, ingestion
time follows it.

**Flow:**

1. Human message gets work-stream sequence 500.
2. Connector fact arrives with older provider timestamp.
3. It is linked/promoted at sequence 501 with both timestamps preserved.
4. The projector applies explicit causal relation without renumbering history.

**Expected user-visible behavior:** UI can show “occurred earlier, received now”;
conversation order remains stable.

**Architecture stress:** Total append order and external occurrence time are
separate fields; activity links express causality.

**Failure oracle:** Fail if old parts are reordered, provider timestamp becomes
the event cursor, or model order changes across reload.

**Unresolved pressure:** Define how late activity is summarized into future
context without rewriting past turns.

### B23 — Tiny streaming deltas amplify storage and sockets

**Mode:** Break attempt

**Persona:** 5,000 active viewers watch fast agent output.

**Preconditions:** Models yield token fragments above 30 fps.

**Flow:**

1. A naive implementation broadcasts/stores every token.
2. Realtime messages multiply by recipients; Postgres WAL grows.
3. Correct implementation coalesces foreground frames and checkpoints chunks.
4. Capacity control reduces cadence or subscriber set under pressure.

**Expected user-visible behavior:** Text remains human-real-time without account
limit collapse or database write storm.

**Architecture stress:** Realtime billing counts sends plus receivers; shared
primary makes row-per-token especially costly.

**Failure oracle:** Fail if each token is a DB row/Broadcast, inactive workspace
subscribers receive frames, or backpressure drops terminal state.

**Unresolved pressure:** Establish frame/checkpoint/fan-out quotas and observer
aggregation.

### B24 — Workspace deletion races a scheduled and running loop

**Mode:** Break attempt

**Persona:** Maya deletes while one Cron wake is queued and another loop is
inside a model/tool action.

**Preconditions:** Queue/Workflow events may arrive after deletion begins.

**Flow:**

1. Deletion increments epochs, cancels admission, and marks runs.
2. Queue consumer/Workflow wakes with stale revisions.
3. A current external effect is cancelled/reconciled.
4. Completion RPC refuses new product output and deletion continues.

**Expected user-visible behavior:** Deleted data does not reappear or keep
running invisibly; ambiguous effects are retained only as required receipts.

**Architecture stress:** Queue/driver wake is not authority; every step reloads
workspace/run lifecycle.

**Failure oracle:** Fail if a stale wake creates a new run, late result writes a
part/card, or deleting SQL rows strands active external work untracked.

**Unresolved pressure:** Define provider cleanup/receipt retention under legal
deletion.

### B25 — Operations needs to debug without crossing audience boundaries

**Mode:** Break attempt

**Persona:** Ren investigates a stuck private substream in an EU workspace.

**Preconditions:** Routine operator access must not expose customer content.

**Flow:**

1. Ren queries run/event/effect/queue IDs, revisions, durations, hashes, and
   redacted error classes.
2. Logs/metrics correlate adapter and database failures.
3. Content access, if ever needed, follows a separate audited support grant.
4. The case is resolved from receipts where possible.

**Expected user-visible behavior:** Reliable support without routine disclosure
or cross-region copying.

**Architecture stress:** Product audit and observability schema must be useful
without prompts/bodies; service-role convenience is constrained.

**Failure oracle:** Fail if logs contain content/signed URLs/secrets, operators
need broad SQL bypass for normal diagnosis, or EU diagnostics leave its boundary.

**Unresolved pressure:** Define just-in-time support access and customer audit.

### B26 — A steering storm collides with an unsafe Terminal write

**Mode:** Break attempt

**Persona:** Three teammates send ten steering messages while a deployment
command is active.

**Preconditions:** The command may have partially changed remote state.

**Flow:**

1. Each steer commits a unique part and monotonically advances control.
2. Driver coalesces wake hints but not transcript history.
3. No subsequent effect begins until command reconciliation settles.
4. One next admission deterministically batches eligible corrections.

**Expected user-visible behavior:** All messages remain visible; the UI explains
the current unsafe boundary and produces one resumed attempt.

**Architecture stress:** Postgres lock/CAS serializes revisions; Realtime/Workflow
events may duplicate or collapse safely; effect reality is separate.

**Failure oracle:** Fail if steer spam starts many retries, loses input, bypasses
the effect fence, or claims an already-made write was cancelled.

**Unresolved pressure:** Add product rate/coalescing rules without discarding
meaningful committed messages.

### B27 — Substreams become a universal bucket for unrelated features

**Mode:** Break attempt

**Persona:** Teams propose substreams for tabs, labels, channels, every tool call,
and every user.

**Preconditions:** The table is easy to create and query.

**Flow:**

1. A proposal is checked against supported semantic kinds.
2. Features needing independent lifecycle/card/audience/retention use work streams
   or their own tables.
3. Per-turn/tool/UI concerns remain parts/views.
4. Unsupported creation is rejected by function constraints.

**Expected user-visible behavior:** Conversation context remains predictable and
navigation does not expose an arbitrary hierarchy.

**Architecture stress:** A relational table's flexibility does not replace a
bounded product ontology/materializer.

**Failure oracle:** Fail if unknown kinds appear, substream ID becomes security,
one-per-turn growth harms projection, or top-level work is hidden from sidebar.

**Unresolved pressure:** Maintain a review checklist for future kinds.

### B28 — Compaction completes after authorization and context change

**Mode:** Break attempt

**Persona:** Priya removes resource access and a parent fork is redacted while a
compaction model call runs.

**Preconditions:** Source fence was valid at start.

**Flow:**

1. Auth and scope revisions advance during the external call.
2. Worker returns a plausible summary.
3. Completion transaction rechecks sources/hashes/revisions.
4. It marks the job invalid and appends no summary.

**Expected user-visible behavior:** Later prompts/previews/search never use the
stale artifact.

**Architecture stress:** Start-time validation does not authorize commit;
compaction key includes resource auth and lineage.

**Failure oracle:** Fail if late summary commits, fallback ignores revocation,
or invalidated embeddings/snippets remain queryable.

**Unresolved pressure:** Bound invalid-job storage/model cost and retry timing.

### B29 — Activity replay crosses every asynchronous boundary

**Mode:** Break attempt

**Persona:** Elena replays a connector month during incident recovery.

**Preconditions:** Ingress, normalization, embedding, opportunity, suggestion,
and acceptance workers can all redeliver.

**Flow:**

1. Receipts and queue messages replay in arbitrary order.
2. Each stage looks up its semantic receipt/source version.
3. Derived rows are reused/rebuilt, not duplicated.
4. A previously accepted suggestion remains linked to one work stream.

**Expected user-visible behavior:** Activity and suggested/accepted work do not
multiply; updated source versions remain explicit.

**Architecture stress:** At-least-once is end-to-end; `pgmq` visibility does not
replace per-stage semantic keys.

**Failure oracle:** Fail if replay reexecutes an accepted action, creates a
second work stream, loses tombstones, or uses vector similarity as dedup truth.

**Unresolved pressure:** Define replay window/version policies per connector.

### B30 — Personal activity is accidentally admitted as workspace work

**Mode:** Break attempt

**Persona:** Mateo connects a personal mailbox inside a shared workspace.

**Preconditions:** Some normalized events have owner-only audience.

**Flow:**

1. Opportunity detection considers the event in Mateo's audience.
2. It may propose a personal suggestion.
3. Workspace-wide proposal/admission requires an explicit authorized disclosure.
4. Other members query workspace suggestions/search/digest.

**Expected user-visible behavior:** Private mailbox facts remain personal until
Mateo intentionally shares an approved representation.

**Architecture stress:** Activity audience and suggestion target are first-class
relational filters; workspace membership alone is insufficient.

**Failure oracle:** Fail if private events influence shared ranking/text/vector,
appear in a shared digest, or auto-create a workspace stream.

**Unresolved pressure:** Define disclosure UX and whether some connectors are
forbidden in shared workspaces.

### B31 — Suggested-work promotion crashes at every handoff

**Mode:** Break attempt

**Persona:** Maya accepts one suggestion while database response/network/driver
start each fail in turn.

**Preconditions:** The client retries the same operation key.

**Flow:**

1. Crash before transaction: nothing exists and retry can proceed.
2. Crash after transaction before response: receipt returns the created stream.
3. Queue/Workflow start fails: run remains durably due and is retried.
4. Driver starts twice: stable run/instance IDs and step receipts converge.

**Expected user-visible behavior:** Exactly one work stream/card/run appears,
with recoverable queued/running state.

**Architecture stress:** One acceptance transaction removes suggestion-to-card
handoffs; only external driver start remains receipt-reconciled.

**Failure oracle:** Fail if a proposal is accepted without result ID, duplicate
stream/run appears, or failed driver start rolls back the real work stream.

**Unresolved pressure:** Set user-visible queued/capacity timeout and retry SLO.

### B32 — Common and personal collection replacements race an access change

**Mode:** Break attempt

**Persona:** Mateo loses a restricted work-stream grant while old snapshot and
personal hints are buffered.

**Preconditions:** Common card and overlay revisions were valid before removal.

**Flow:**

1. Removal advances visibility/authorization epoch.
2. Old card/user hints arrive after an eviction hint.
3. Snapshot/catch-up RLS excludes the stream.
4. Client applies epoch/revision rules and removes local caches.

**Expected user-visible behavior:** The stream disappears from all common and
personal collections and cannot be reopened.

**Architecture stress:** Common/personal rows share a live visibility fence;
client cache invalidation cannot depend on receiving every event.

**Failure oracle:** Fail if a personal patch recreates a hidden common card,
cached preview remains accessible, or counts reveal the restricted stream.

**Unresolved pressure:** Define local encrypted cache purge guarantees.

### B33 — A private suggested action is revoked before acceptance

**Mode:** Break attempt

**Persona:** Mateo clicks accept after losing source-resource permission.

**Preconditions:** The old suggestion is still rendered locally.

**Flow:**

1. Resource revocation advances epochs and invalidates suggestion.
2. Client submits acceptance with old revision/key.
3. Transaction locks suggestion/sources and denies.
4. Personal durable event removes the card.

**Expected user-visible behavior:** Mateo sees that access changed; no shared
message or external effect begins.

**Architecture stress:** Acceptance revalidates current source authority inside
its transaction, not only RLS when the suggestion was fetched.

**Failure oracle:** Fail if the action executes, old explanation is copied into
shared history, or a score/embedding keeps it visible.

**Unresolved pressure:** Decide whether a safely redacted, independently
authorized action can survive source revocation.

### B34 — Resource ACL filtering and digest scheduling overload the primary

**Mode:** Break attempt

**Persona:** Elena has millions of activity events with fine-grained audiences
and thousands of due digests.

**Preconditions:** Cron and queues share the database with interactive writes.

**Flow:**

1. A dispatcher queries due schedules.
2. Workers materialize authorized source ranges and vectors.
3. Complex RLS joins and queue churn raise CPU/IO.
4. Concurrency throttles, indexes, batch sizes, and schedule spreading respond.

**Expected user-visible behavior:** Digests may be delayed honestly; messages and
sidebar remain responsive and no unauthorized shortcut is used.

**Architecture stress:** Relational authority solves correctness but can make
policy-heavy derived work compete with the product path.

**Failure oracle:** Fail if service-role workers skip audience filters, one Cron
query scans all events, connection pools exhaust, or digest work starves users.

**Unresolved pressure:** Benchmark RLS/materialization and decide whether
eligible-range tables or intra-region workload isolation are needed.

### B35 — Queue replay escapes a paused migration campaign

**Mode:** Break attempt

**Persona:** Ren pauses after observing corrupt transformed rows.

**Preconditions:** Old `maintenance` messages are invisible or in flight.

**Flow:**

1. Pause increments campaign epoch in Postgres.
2. Visibility expires and old messages redeliver.
3. Claim transaction checks campaign state/epoch and refuses new slice start.
4. Already-started slice may finish but commit must match job/campaign fence.

**Expected user-visible behavior:** Progress stops at an explainable bounded edge;
no new corrupted rows commit after invalidation.

**Architecture stress:** Deleting/purging queue messages is not the pause
mechanism; authoritative job state is.

**Failure oracle:** Fail if a replay starts fresh work based only on message body,
or result commit ignores the new epoch.

**Unresolved pressure:** Specify the strictest achievable pause semantics for
external transforms.

### B36 — The final authority-copy hold overflows before source closure

**Mode:** Break attempt

**Persona:** A hot workspace produces more writes than the cutover hold buffer
can drain.

**Preconditions:** All writers are registered but traffic is spiking.

**Flow:**

1. Hold begins and queue/backpressure threshold is reached before validation.
2. System refuses or delays new operations with retriable explicit status.
3. Ren aborts before closing the source authority gate or expands a reviewed
   bound.
4. Source authority releases held writes safely.

**Expected user-visible behavior:** Users see saving/capacity status rather than
false success or missing writes.

**Architecture stress:** Authority cutover cannot be magically atomic across
systems; bounded admission is part of correctness.

**Failure oracle:** Fail if memory-only buffers overflow, acknowledged writes are
dropped, the source gate closes without final/held cursors and validated
destination, or abort replays twice.

**Unresolved pressure:** Set per-workspace hold capacity and pre-cutover traffic
qualification.

### B37 — A writer gets ahead of the database/API contract

**Mode:** Break attempt

**Persona:** A new Edge adapter emits a step/event payload before regional schema
and old driver versions understand it.

**Preconditions:** Deploy order is wrong in one region.

**Flow:**

1. RPC rejects unsupported version or stores it in a compatible envelope.
2. Run enters explicit upgrade/capacity state.
3. Compatible deployment resumes by stored step version.

**Expected user-visible behavior:** Temporary delay/error without transcript or
effect corruption.

**Architecture stress:** Shared database reduces parent/child protocol skew but
still has schema/function/client/driver version skew.

**Failure oracle:** Fail if `jsonb` silently drops fields, old code settles a new
action incorrectly, or rollout cannot identify incompatible active runs.

**Unresolved pressure:** Define supported run version horizon and migration
mechanism for nonterminal state.

### B38 — A stateful deploy reconnects an entire region at once

**Mode:** Break attempt

**Persona:** Ren deploys Realtime/client/auth changes during peak usage.

**Preconditions:** Thousands of Electron clients have multiplexed connections.

**Flow:**

1. Connections drop or JWT refresh causes rejoin.
2. Clients back off/jitter and subscribe-buffer-snapshot.
3. Durable event APIs/DB pools see catch-up load.
4. Rate controls protect interactive commands and progressively reconnect.

**Expected user-visible behavior:** Temporary reconnect indication; no lost state
or thundering-herd outage.

**Architecture stress:** One socket per session reduces count but regional
fan-in and snapshot/RLS queries still amplify deploys.

**Failure oracle:** Fail if every client retries instantly, joins one topic per
historical stream, event catch-up exhausts DB connections, or relies on Presence.

**Unresolved pressure:** Define reconnection jitter, snapshot cache, and load-
shedding policy.

### B39 — Mutable-tail replay crosses a checkpoint crash

**Mode:** Break attempt

**Persona:** Avalon crashes after exposing provisional text but around a database
checkpoint.

**Preconditions:** Frame sequence and committed byte offset can differ.

**Flow:**

1. Crash A happens after token generation before the next checkpoint.
2. Crash B happens during the checkpoint transaction.
3. With a verified provider cursor, the same attempt resumes; without one, the
   whole incomplete attempt is superseded and another starts from its model
   fence.
4. Client reconciles by attempt epoch and may retract superseded provisional
   text.

**Expected user-visible behavior:** A resumable attempt continues exactly; a
non-resumable attempt visibly restarts instead of splicing two generations. One
complete assistant answer seals.

**Architecture stress:** Checkpoints guarantee client reconnect, not impossible
lossless model-executor recovery. Bytes/cursor share one transaction and stale
or superseded attempts cannot seal.

**Failure oracle:** Fail if cursor advances without text, a new generation
appends to an old partial buffer, two active rows win, or stale output overwrites
sealed content.

**Unresolved pressure:** Define client visual treatment for provisional rewind.

### B40 — PITR is mistaken for product or migration rollback

**Mode:** Break attempt

**Persona:** Ren considers restoring yesterday's regional database after a bad
backfill.

**Preconditions:** Since then, provider writes, Daytona commands, Storage uploads,
and new user messages occurred.

**Flow:**

1. Team inventories database/Storage/external divergence and downtime.
2. It chooses forward repair/receipts for migration errors when possible.
3. If disaster restore is required, admission remains closed afterward.
4. All nonterminal queues/runs/effects/connectors/Storage are reconciled.

**Expected user-visible behavior:** No silent time travel or repeated external
effects; restoration status is explicit.

**Architecture stress:** Supabase PITR covers the whole DB, not Storage or
external reality, and is not tenant/table rollback.

**Failure oracle:** Fail if restore reopens immediately, reruns stale queues, or
claims Storage was restored with SQL.

**Unresolved pressure:** Build forward-repair tools and regional DR runbooks.

### B41 — Global route and regional workspace row disagree

**Mode:** Break attempt

**Persona:** Mateo resolves a workspace to EU while a stale client/command points
to Global/US or an older route epoch.

**Preconditions:** Routing metadata and regional product row are separate
projects/systems.

**Flow:**

1. Client presents workspace ID, selected region, and epoch.
2. Regional endpoint proves the workspace exists locally and epoch matches.
3. Wrong-region request returns a non-content route correction or fails closed.
4. Repair begins from the source-D1 closure gate/receipt, then converges the
   destination activation and global route copies.

**Expected user-visible behavior:** Safe re-route/re-authentication without
creating product state in the wrong project.

**Architecture stress:** Thin global routing remains a cross-system contract even
though work-stream/sidebar relationships are local SQL. Only the source-local
gate linearizes authority; route and destination rows may lag safely.

**Failure oracle:** Fail if repair treats global+regional updates as atomic,
destination activates without the source closure receipt, a regional endpoint
creates a missing row on demand, content crosses Global, or both claim writes.

**Unresolved pressure:** Define closure-receipt authentication, route-repair
tooling, and the accepted availability gap after irreversible source closure.

### B42 — The Supabase-native driver becomes a hidden workflow engine

**Mode:** Break attempt

**Persona:** Engineers add special queue/Cron/Edge code for each loop type.

**Preconditions:** EU cannot yet approve Cloudflare Workflow.

**Flow:**

1. A two-hour loop exercises leases, early events, retries, waits, deployments,
   steering, and unknown effects.
2. New domains request custom state transitions.
3. The architecture requires one generic `RunDriver` state machine and conformance
   suite rather than per-domain consumers.
4. Unsupported complexity is rejected or moves behind the same interface.

**Expected user-visible behavior:** Consistent progress/recovery across work-
stream and non-work-stream loops.

**Architecture stress:** Supabase supplies storage/queue/function primitives,
not a managed durable workflow. Complexity must be acknowledged, tested, and
costed.

**Failure oracle:** Fail if each loop invents leases/idempotency, Cron polls every
run, Edge invocations own waits, or behavior diverges from the Workflow driver.

**Unresolved pressure:** Decide whether failure-injection evidence justifies
approving the hybrid driver more broadly.

### B43 — A supposedly additive migration blocks a hot table

**Mode:** Break attempt

**Persona:** Ren adds an index/constraint to `conversation_parts` at peak load.

**Preconditions:** The table is large and writes are continuous.

**Flow:**

1. CI identifies lock/rewrite risk and sets lock/statement timeouts.
2. Index is built concurrently; constraint is added `NOT VALID` then validated.
3. Validation/backfill is throttled and observable.
4. Contract happens in a later release.

**Expected user-visible behavior:** No regional outage; delayed migration is
preferable to blocking appends.

**Architecture stress:** Shared Postgres makes DDL operational discipline a fleet
control plane even for a syntactically simple change.

**Failure oracle:** Fail if migration waits indefinitely for/holds an exclusive
lock, rewrites the table unexpectedly, or dashboard drift bypasses review.

**Unresolved pressure:** Automate migration linting/dry-run against production-
scale synthetic tables.

### B44 — A two-hour coding loop crosses retries, early events, and capacity

**Mode:** Break attempt

**Persona:** Mateo asks Avalon to implement a complex change using Daytona.

**Preconditions:** The full loop lasts 2h15m, with many model iterations,
seconds-long tools, Terminal p95 under a minute, several 3–5 minute commands, one
driver deployment, one early callback, and a capacity spike.

**Flow:**

1. Supabase admits one run and binds one approved Workflow or generic Supabase
   driver instance.
2. Every model/tool/action is a separate fenced step; output checkpoints continue
   independently of client presence.
3. A Daytona callback lands before the durable wait and is stored in
   `run_wait_events`; deploy/retry reuses provider effect receipts.
4. Capacity pauses new actions in durable `waiting_capacity`; the desktop closes
   and later recovers by cursors.
5. A user steers during a long command; the command is reconciled, no next stale
   effect begins, and one resumed batch wins terminal state.

**Expected user-visible behavior:** Progress and waits are honest; reopening
shows one transcript, one effect per causal action, and one terminal result.

**Architecture stress:** This combines Workflow/Edge limits, opaque driver
state, Supabase CAS, queue/event early delivery, Daytona reconciliation,
provisional checkpoints, budgets, and background socket policy.

**Failure oracle:** Fail if a full loop is one function/step, early event is lost,
deployment repeats a command, capacity loses admission, steering disappears,
Workflow holds customer content, or a second terminal answer seals.

**Unresolved pressure:** Establish release load/failure thresholds and the
maximum supported full-loop elapsed/step/cost budget.

## Coverage matrix

| Pressure | Showcase | Break attempts | Supabase primitive or contract under test |
| --- | --- | --- | --- |
| Ordered conversation and message arrays | S01, S05, S19 | B06–B10, B22, B39 | Row lock, turns/parts, content refs, immutable fences |
| Unread, mentions, sidebar, home | S02, S20 | B01–B04, B21, B32 | Same-transaction cards/overlays/events; keyset/cursor |
| Queue and steering | S07–S09, S18 | B07, B17, B26, B44 | Durable input, control revision, effect-begin CAS |
| Substreams and sub-agents | S04–S06 | B08–B09, B16, B27–B28 | Explicit lineage/audience/scope/promotion |
| Compaction with live tail | S19 | B08, B28, B39 | Frozen complete-turn source rows and epoch checks |
| Token realtime/reconnect | S03, S28–S29 | B03–B05, B23, B38–B39 | Private Broadcast hints, durable events/checkpoints |
| Background/idle sockets | S28, S31 | B05, B23, B38, B44 | One multiplexed connection, intentional close/catch-up |
| Full 2–30m/2h+ loops | S17, S31 | B24, B37, B42, B44 | Generic run schema; Workflow or Supabase driver |
| Daytona Terminal | S09, S31 | B17, B26, B40, B44 | Addressable effect start/park/reconcile; provider unchanged |
| Connector ingress/activity | S11, S21–S22 | B11, B22, B29–B30, B34 | Receipt/body hash, pgmq, normalized lineage/audience |
| Digests/suggestions | S20–S22 | B29–B34 | Frozen provenance, personal/common authority, atomic acceptance |
| Storage and large content | S01, S13, S25 | B10, B12, B39–B40 | Pending/ready refs, hashed chunks, independent backup/delete |
| FTS/vectors | S21–S22 | B08, B28, B30, B33–B34 | Authorized relational candidates; rebuildable pgvector |
| Auth/RLS and revocation | S04, S15 | B03, B08–B10, B15, B17, B20, B25, B32–B33 | Regional sessions, live membership/epochs, narrow runner RPCs |
| EU residency | S11, S15, S27 | B14, B20, B25, B41 | Regional project; contract-gated Edge/Realtime/Workflow |
| Additive schema/backfill | S23–S24 | B35, B37, B40, B43 | CLI expand/backfill/contract; bounded campaign jobs |
| D1/R2 cutover | S16, S25 | B13, B36, B40–B41 | Hashed import, write hold/outbox, source-local closure gate |
| Queue/Cron/Edge limits | S12, S24, S27, S30 | B24, B29, B34–B35, B42–B44 | Logged pgmq, due state, bounded functions, DLQ/receipts |
| Export/deletion/DR | S13–S14 | B12, B24, B40 | Fenced chunks, phased deletion, Storage-aware restore |
| Scale/cost/operations | S28–S30 | B01–B02, B12, B18, B21, B23, B25, B34, B38, B43–B44 | Shared-primary sizing, pooling, batching, throttling |

## Prioritized architecture questions

### P0 — Must close before implementation commitment

1. Which full-loop driver ships per region, and can the Cloudflare Workflow
   exception meet EU state/log/execution/subrequest requirements?
2. What supported Supabase Auth/OIDC topology provides global identity plus
   independent regional sessions, refresh, logout, and revocation?
3. What is the tested maximum stale-access window for an already joined private
   Realtime channel, and how is forced eviction implemented?
4. Can hosted Supabase Queues/Cron meet required dispatch latency/throughput and
   interactive-primary isolation at projected burst scale?
5. What is the exact transactional message/turn materializer, especially when a
   user message arrives between tool call and late tool result?
6. Which external effects are idempotent, cancellable, and queryable, and which
   must become `unknown` after a crash?
7. What writer inventory, hold/outbox, validation, source-local closure gate,
   and destination/global convergence protocol proves exactly one authority
   during D1/R2 migration?
8. What contractual EU guarantees cover Supabase Realtime, Edge, Auth, Storage,
   backups/logs/support and Daytona/model/connector providers?

### P1 — Must close before production canary

9. What database compute/disk/pool and Realtime account limits follow from the
   measured active users, card updates, token receivers, connector burst, and
   vector footprint?
10. What exact common/personal collection predicates, indexes, paging fence,
    and lazy attention/count algorithms support large workspaces?
11. What substream kind/inheritance/depth/promotion rules and projector version
    are normative across all provider adapters?
12. What inline-versus-Storage size limits and active-output checkpoint cadence
    balance latency, WAL/IO, reconnect, and cost?
13. What durable event retention/offline window and snapshot fallback are
    promised?
14. What Daytona start/status/callback/cancel/idempotency/output APIs make long
    commands safely addressable?
15. What full-loop budgets and conservative Workflow/Edge/queue capacity gates
    preserve recovery/terminalization reserve?
16. How do regional schema, Edge, desktop, and driver versions coexist with
    nonterminal runs during deploy?
17. How are Database and Storage backed up/restored/deleted independently, and
    how are external effects reconciled after PITR?
18. What load signals automatically throttle connectors, derived work,
    compaction, embeddings, and migration below interactive commands?

### P2 — Resolve before broad scale or policy expansion

19. At what measured thresholds should event/activity tables partition, history
    archive, compute resize, or a region shard across Supabase projects?
20. What exact background completion notification allows idle sockets to close
    while meeting user expectations?
21. When do bounded non-work-stream classifiers stay direct Edge jobs versus use
    the generic full-loop driver?
22. What support-access workflow permits rare content debugging without routine
    service-role exposure or cross-region logs?
23. What application-layer encryption or customer-managed-key policy is needed
    for connector bodies, files, and Terminal artifacts?
24. When, if ever, can Vector Buckets graduate from alpha experimentation to a
    cold rebuildable index, and how are RLS/residency/delete/backup proven?
25. What product export/import experience, if any, supports copying a work stream
    across workspaces/regions without pretending it is an in-place move?
26. What mention limits, suggestion merge rules, recency windows, and unread
    count approximations keep the UI useful at very large scale?
