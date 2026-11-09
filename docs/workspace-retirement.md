# Workspace retirement

Retiring a workspace closes it permanently: nobody can sign in to it, every
room, automation and socket in it stops, nothing reopens, and nothing in it
ever writes again — including after eviction, when the platform recovers an
alarm or a Queue redelivers an effect. This document covers the machinery that
makes that true: the D1 fence the door writes, the tombstone every gated
Durable Object consults, the object graph recorded before the workspace closes,
the resumable walk that closes children before parents, what a background
caller does when it meets a retired object, and the operator door in Ace behind
which all of it sits.

Read it before changing retirement, adding a method to either of the two gated
object classes, adding an effect receiver to one of them, or adding a Queue
consumer, Workflow or cron pass that reaches one.

The product decision behind it is in
[the demo workspace PRD](PRDs/2026-09-04_demo-workspace/prd.md): a demo was a
new workspace every time, and the old one was retired rather than cleared. The
mechanism was never demo-specific — it takes any workspace — and it outlived
the demo feature that first needed it, which was removed on 2026-11-08.

## Where the code lives

| Path | Role |
| --- | --- |
| `apps/api/src/durable-objects/object-retirement.ts` | The tombstone, the gate that wraps every callable method of a retired object, the three dispositions, `ALWAYS_PERMITTED_METHODS`, and `isRetirementRefusal`, which every background caller reads. |
| `apps/api/src/durable-objects/scheduled-alarms.ts` | `retireObject` and `objectRetirementState` on the base every gated class extends, plus the alarm clearing retirement performs. |
| `apps/api/src/durable-objects/workspace-do.ts` | `beginWorkspaceRetirement`, `recordRetiredNode`, `recordRetiredChild`, `workspaceRetirementProgress`, and the `workspace_retirement_graph` and `workspace_retirement_children` tables behind them. |
| `apps/api/src/services/workspace-retirement-service.ts` | The pass that walks the recorded graph, closing children before parents, and the operator door in front of it. |
| `apps/api/src/routes/workspace-operations.ts` | `/internal/workspaces/:id/retire`, behind Ace's operator credential (`requireAceOperator`, role `ACE_OPERATOR_ROLE`, stored as `demos`). |
| `apps/api/src/middleware/errors.ts` | Maps a refusal that reaches an HTTP route to `409 workspace_retired`. |
| `apps/api/src/queues/access-revocation-consumer.ts`, `product-feature-flag-consumer.ts`, `activity-consumer.ts`, `apps/api/src/workflows/connector-event.ts` | The background callers that can meet a retired object; each acknowledges a refusal as terminal. |
| `apps/api/src/telemetry/operator-auth.ts` | The operator credentials: `requireOperatorFrom` verifies a bearer token against one of two same-shaped secrets — `DEMO_OPERATORS_JSON` for the `demos` role Ace holds, `TELEMETRY_OPERATORS_JSON` for the telemetry roles — and `requireOperatorRole`, which every operator router narrows with. |
| `packages/contracts/src/workspace-retirement.ts` | The receipt a retirement answers with. |
| `packages/contracts/src/conversation-parent.ts` | `childrenForRetirement`'s three-way answer. |
| `apps/ace/src/regional-api.ts`, `apps/ace/src/client/workspaces.tsx` | Ace's relay to the regional route and the workspaces tab that calls it ([`ace.md`](ace.md)). |
| `apps/api/src/engineering-inspection-bridge.ts` | `retireOrg`, the engineering MCP's `retire_org`, which calls the same door ([`engineering-mcp.md`](engineering-mcp.md#retiring-an-organization)). |
| `apps/api/src/services/thread-retirement-service.ts` | Retiring one Organization's Threads, Breakouts and Channels while the Organization stays open: the transcript dump to R2 and the retirement it unlocks (see [Retiring Threads, Breakouts and Channels](#retiring-threads-breakouts-and-channels)). |
| `WorkspaceDO.threadRetirementInventory`, `WorkspaceDO.deleteRetiredThreadParent`, `AgentLoopDO.conversationTranscriptText` | What that walk visits, the rows it deletes once a parent's conversations are retired, and the whole transcript of one conversation as room-visible text. |
| `apps/api/src/services/thread-conversion-service.ts`, `WorkspaceDO.threadConversionInventory`, `WorkspaceDO.convertThreadToCanvas`, `HostedCanvas.createFromThread`, `AgentLoopDO.convertParentKind` | Converting a Thread that has artifacts into a Canvas in place, before the retirement (see [Converting Threads that have artifacts](#converting-threads-that-have-artifacts)). |

### The gate

A Durable Object has more doors than a helper each method remembers to call can
cover: native RPC, `fetch`, hibernated socket callbacks, and an `alarm` the
platform recovers after eviction all reach it without passing anything that
could say no. WorkspaceDO alone has roughly 229 methods and no shared dispatch
boundary.

So `applyRetirementGate` replaces every callable method on the prototype chain,
once, at module load. Prototype replacement rather than a proxy around the
instance is what survives real workerd, which dispatches to ordinary own
properties of a prototype. The two gated classes (`WorkspaceDO` and
`AgentLoopDO`) extend `ScheduledDurableObject`,
so the tombstone and its two entry points live there. One gate policy is
declared per class, and each declares only its exceptions.

Canvas and Sidekick parents have no object of their own: their state is rows in
`WorkspaceDO` ([`hosted-conversation-parents.md`](hosted-conversation-parents.md)),
so the Organization's tombstone closes them. The gate does not wrap
accessors — a getter is state, not a door — so a getter that does work is not
fenced; today every such getter delegates to a gated method.

**A permit names an entry point and carries the whole call beneath it.** That is
the part this design got wrong first and it is worth stating plainly, because the
wrong version looks reasonable: a permit was a method *name*, and every permitted
method promptly refused itself on the first private helper it touched. Five were
found one at a time. A permitted method now runs against a view of its own
instance whose lookups return the unwrapped originals, so `this` inside it — and
inside everything it calls — is that view. Nothing else can reach the view: the
wrapper creates it, passes it as the receiver, and stores it nowhere. That is
what distinguishes it from the re-entrancy flag this design rejected and should
still reject — a flag is visible to whatever the runtime admits while the
permitted method is awaiting, and a receiver is not. Inert methods stay inert
through the view, so retirement's own passes still arm no alarm.

The disposition is resolved per instance at call time rather than captured when
the method was wrapped, because most of these methods live on a shared base: a
baked answer meant whichever class loaded first decided it for its siblings, and
a class that permitted a base-owned method left it ungated for every class that
did not. A class-specific policy entry naming a method the class does not have
now throws at module load rather than reading as coverage that is not there.

### Retiring a workspace

Retirement runs in this order, and the order is the design:

1. **Close the D1 door.** The operator door writes `workspaces.abandoned_at`
   before any object is touched. The objects' gate stops what reaches an
   object; authentication, the member list, invitations and the connection
   list are D1 reads that reach none, and `abandoned_at` is the fence every
   one of them already applies — the same column the last member leaving
   writes. From this instant no session into the workspace authenticates
   (`401 session_revoked` on its next request) and the workspace leaves every
   member's discovery.
2. **Enumerate, then close, in one call.** `beginWorkspaceRetirement` reads the
   Canvas, Sidekick, work-stream and Space directories while they still
   answer, writes each parent into `workspace_retirement_graph` under its kind
   (`canvas` from migration 146; a Canvas's Chat is its child `0`),
   and writes the tombstone. The kinds are `RetirementParentKindSchema` in
   `@rally/contracts`, wider than the hosted `ConversationParentKindSchema`
   because the walk still closes Thread and Space objects. Doing this in one call is what leaves no window in
   which a caller writes into a half-closed workspace. Archived Spaces are
   enumerated too: what is being closed is an object, not a product surface, and
   a Space created before 2026-09-26 still has a hidden main conversation to
   close.
3. **Clear every wake reason, and close every socket.** The same transaction
   deletes `_internal_durable_alarms`, the platform alarm is deleted immediately
   after, and every socket the object holds is closed with `1008`, the code the
   desktop does not reconnect from. Nothing re-derives the alarm: the
   coordinator's mutators are inert on a retired object, and runtime recovery
   returns before its alarm sync. `retireObject` does all of this, on every
   object the walk visits.
4. **Walk children before parents.** `retireWorkspaceGraph` asks each parent for
   its children *before* retiring it, retires each child, retires the parent,
   and only then writes the node's receipt. It asks through
   `childrenForRetirement` rather than `listChildren`, because two of the three
   outcomes it has to act on differently arrive there as exceptions, and
   deciding between them by comparing an error message across an RPC boundary
   is one rename away from tombstoning a parent without walking its children.
   That read is permitted on a retired parent: a pass that dies between
   retiring the parent and writing its receipt has to be able to ask again, or
   the node stays unreceipted on every pass. Every node, a Canvas's or a
   Sidekick's (and a Thread's or a Space's recorded before they were deleted),
   asks `WorkspaceDO.childrenForRetirement`, which is
   permitted on the already retired Organization object, and has no parent
   object to retire after its children. Each child is receipted as it closes
   (`recordRetiredChild`, into `workspace_retirement_children`), and
   `childrenForRetirement` leaves receipted children out, so a pass cut off
   inside a large parent leaves the next pass only the children still open.
   The child receipt only saves work; the parent's receipt still decides
   completion. A parent's children are closed `RETIREMENT_CHILD_CONCURRENCY`
   at a time (10) through `settledBatches`: every call in a batch settles
   before the next batch starts, and the first failure stops that parent with
   no retire left in flight.
5. **Finish when nothing is left unreceipted.** Completion is the workspace's own
   tombstone plus the absence of NULLs in the graph table, rather than a flag
   somebody sets. The tombstone is what says the enumeration happened: reading
   completeness from the row count alone confused "nothing recorded yet" with
   "nothing to record", so an empty workspace reported unfinished forever.

### Background callers

Retirement leaves every D1 row in place, so the enumerators that drive the
Queue consumers and the connector Workflow keep naming a
retired workspace, and its objects refuse them the same way on every delivery.
A refusal is therefore **terminal for background work**: a Queue consumer
acknowledges the message and the connector Workflow ends its instance. Each of those callers reads
`isRetirementRefusal` — the refusal crosses an RPC boundary, so `instanceof`
is not available, and the predicate matches the `code` the runtime preserves.
A consumer that retried instead dead-lettered one message per retired object
forever, which spends the one signal this repository treats as monitoring on a
state somebody designed. Two enumerators skip a closed workspace at the source
as well: Ace's flag fan-out reads `workspaces` with `abandoned_at IS NULL`, and
the access-revocation walk finds nothing beneath an object whose sockets
retirement already closed.

The effect receiver a Queue redelivers to, `receiveChildEffects`, is the
exception and is **dropped** in the gate instead: its consumer parses a
`strictObject` acknowledgement and would treat a throw as a delivery failure,
so the object answers the shape it expects, naming no notification intent.
`fetch`, the hibernated socket callbacks and `alarm` are dropped too, each
answering in the form its caller reads.

### The operator door

The walk infers nothing from an id, which is right for the walk and wrong for a
door: an id no workspace in this region owns would be "retired" as a set of
brand-new empty objects holding tombstones, and the operator told it succeeded
while the real workspace, in the other region, stayed open. So
`retireWorkspaceForOperator` checks the region's `workspaces` row first and
answers `workspace_not_found` otherwise, then writes `abandoned_at`. The route
in front of it takes the confirmation the page collected — the operator typed
or pasted the id they are closing — and refuses
`workspace_retirement_unconfirmed` unless it names the workspace in the path.
That is a consistency check on the request, made in Ace and again here, not a
second confirmation: a caller that fills in both fields with the same id passes
it, and the typed ceremony itself is the page's. The route also carries the
operator's id from the credential into the pass, so the region's own log names
who closed the workspace.

The route sits behind the operator credential in a role of its own, stored as
`demos` (`ACE_OPERATOR_ROLE`; the name is the retired demo feature's, kept
because renaming it is a secret rotation), which Ace holds one token per region for, read from a secret of its own,
`DEMO_OPERATORS_JSON` — the same map shape as the telemetry surface's
`TELEMETRY_OPERATORS_JSON`, set and rotated independently of it, so adding or
rotating Ace's token never touches the telemetry tokens. Every operator router
names the roles it admits as well: the telemetry router refuses `demos`, and
this router refuses the telemetry roles, so a token filed in the wrong secret
is refused by role even when it verifies.

- **Unclassified is refused.** A method nobody classified refuses on a retired
  object. A new RPC is fenced the day it is written, not the day somebody
  remembers this file.

- **A background caller treats a refusal as terminal.** A Queue consumer,
  Workflow or cron pass that reaches a gated object acknowledges a
  `workspace_retired` refusal rather than retrying it, through
  `isRetirementRefusal`. A new background caller that does not is the
  dead-letter loop again; `test/retirement-background-callers.test.ts` names
  each one.

- **The D1 fence is written before any object is closed.** `abandoned_at` is
  what stops sign-in, the member list, invitations and discovery; the gate
  stops what reaches an object. Neither covers the other.

- **A retired object can still be rebuilt.** Eviction is the steady state for a
  retired workspace, not a corner case, so every promise below — operator
  inspection, a resumable walk, a dropped effect, a quiet alarm — is worth
  nothing unless the object survives being reconstructed from storage with its
  tombstone already in it.

- **A permit covers a call, not a name.** Adding a permitted entry point does not
  mean tracing its call graph and listing what it reaches.

- **A dropped effect is acknowledged, never thrown.** An effect already accepted
  by the Queue answers the shape its consumer parses. Throwing would leave the
  Queue redelivering work no object will ever apply.

- **A retired object arms nothing.** The alarm coordinator's mutators are inert
  rather than throwing, so a late continuation's re-arm becomes the nothing it
  should be instead of an error.

- **The first tombstone wins.** A resumed retirement converges on the original
  instant rather than recording when the retry happened.

- **Retirement is attributed to an internal actor**, never to the author of what
  is being closed. The tombstone records `reason: "operator_retirement"` and no
  user; the `workspace_retirement_pass` log line carries `operator_id`, and is
  the region's record of who asked (see **Operations**).

- **Retirement takes any workspace id, and infers nothing.** It is an operator
  action behind one of two Access policies, Ace's or the engineering MCP's, and
  the only protection between an operator and an irreversible close is that
  policy plus, in Ace, the confirmation the page asks for. A gate on a
  register of demo workspaces was built and then dropped, deliberately: the
  bookkeeping bought a second mechanism for a surface one Access policy already
  admits. The walk does not check a name, a register, or anything else.

- **Every operator router names the roles it admits.** A role added to the
  credential map reaches no surface until a router names it.

## Retiring Threads, Breakouts and Channels

The pivot to Canvases and Sidekicks
([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md), plan steps B-7a and B-7)
deletes every Thread, Breakout and Channel of every Organization, while the
Organization, its Canvases, its Sidekicks and its resources stay. That is the
walk above with a narrower graph and without the Organization's own tombstone,
so it does not reuse `workspace_retirement_graph`: that table's completeness is
defined by the Organization being retired, which here it never is. Each
operation is an operator call per Organization, through the engineering MCP
([`engineering-mcp.md`](engineering-mcp.md#retiring-threads)); nothing runs it
on a schedule or at deploy.

**What it visits.** `WorkspaceDO.threadRetirementInventory` names every Thread
(`channels`, plus any `workstream` parent state left without its row) and every
Channel (`spaces`, plus any `space` parent state), Threads first, and under each
Main `0` and every child the parent registry, its projections or the Breakout
directory knows. Main is always named, as `childrenForRetirement` names it,
because a Space created before 2026-09-26 has a hidden one. A Canvas is a
`canvas_directory` row and a Sidekick an `automation_directory` row; neither is
read, and an id that has a `canvas_directory` row is left out even while its
`channels` row stands: that is a Thread the conversion below made a Canvas of
and stopped before deleting its rows, and its Main is the Canvas's Chat.

**The dump comes first.** `dump_thread_transcripts` writes each conversation's
committed transcript to `PAYLOADS` as text, under
`retired-conversations/<workspaceId>/<parentId>/<substreamId>.txt`, through
`AgentLoopDO.conversationTranscriptText`: the same `conversationAsText` the
operator conversation reads format with, over every committed turn, so tool
payloads, thinking and internal agent messages are left out. It is the only
copy once the retirement runs, and it is for operators, not a product surface.
It is the one read that sees a retired parent kind: the object's product reads
refuse a stored `workstream` or `space` with `conversation_parent_kind_retired`,
and this one reads it through `identityForRetirement`.

- **The R2 object is the receipt.** A pass skips any key that is already
  there, so a rerun writes nothing new and an interrupted pass resumes where it
  stopped. A conversation that moved after its dump keeps the earlier dump; the
  dump and the retirement are meant to run back to back after the cutover,
  when no reader is left to post. To dump one again, delete its object first.
- **An object that never held a conversation is written empty**, with
  `materialized: "false"` in its metadata, so the retirement's coverage check
  finds a receipt for it too. The read brings that object into existence, as
  the retirement would.
- **A refused conversation is left unwritten** and reported by code:
  `thread_transcript_identity_mismatch` when the object holds another identity
  than the name it was reached by, `thread_transcript_parent_kind_refused` when
  it is a Canvas's or Sidekick's conversation, and otherwise the object's own
  code or `thread_transcript_dump_failed`. Unwritten means the retirement stays
  refused until an operator looks.
- **One invocation holds the whole Organization**, as the workspace walk does:
  a subrequest ceiling is the failure on a very large one, and the receipts
  written so far survive it.

**Then the retirement.** `retire_threads` is refused, before anything is
touched, with `thread_retirement_conversion_pending` while
`threadConversionInventory` below still names a Thread with an artifact, and
with `thread_retirement_dump_incomplete` unless every conversation in the
inventory has its dump. The first guard is what makes the order **dump,
convert, retire** a rule rather than advice: retired first, a Thread with
artifacts would lose the Chat its Canvas keeps, and its artifacts the
conversation their readers open them through. A Thread the conversion refuses
(`thread_conversion_no_creator`) keeps the retirement refused until an
operator repairs its rows with `run_workspace_sql` (a `channels.created_by_user_id`,
or a viewer row) and converts again; nothing meant to survive is retired by
default.
Then, parent by parent, children
before parents: each conversation object is tombstoned through `retireObject`
(reason `thread_retirement`, no user), which clears its alarms and closes its
sockets with `1008` exactly as the workspace walk does, and only once all of
them confirm does `WorkspaceDO.deleteRetiredThreadParent` delete the parent's
rows in one transaction:

- every `parent_*` table keyed by `parent_id`, from the code-owned list
  `HOSTED_PARENT_STATE_TABLES` (`hosted-parent-schema.ts`) intersected with the
  schema, so a table phase C drops first is skipped rather than failed on, and
  a new `parent_*` table has to join the list or it is left behind;
  `parent_participant_migrations` goes first, because while it stands a
  Breakout's member rows refuse deletion, and foreign keys are deferred to the
  commit so the order among the rest does not matter. That deferral is load
  bearing: `parent_invitations` references `parent_invitation_operations` with
  no ON DELETE, and the list deletes the operations first. Inside
  `transactionSync` a deferred violation is raised at the commit of the whole
  event, after the method returns, so it would fail the RPC rather than reach
  the service's per-parent catch;
- a Thread's `channels`, `channel_viewers`, `breakouts` and `breakout_viewers`
  rows, its `workspace_workstream_resource_links` rows and a Sidekick's
  attachment to any of its conversations, or a Channel's `spaces` and
  `space_viewers` rows. Nothing else references them since migration 147
  dropped the pin and access tables.

What it leaves: the Organization object, untombstoned,
Canvases, Sidekicks, resources, and memory. The other Thread- and
Channel-keyed tables are gone already: WorkspaceDO migration 147
(`THREAD_ERA_TABLES_DROP_MIGRATION` in `retired-workspace-schema.ts`) drops
every Thread-era table nothing reads, and the Thread rows of the shared tables
(memory digest holders, Thread and artifact pins, room bindings). It
deliberately keeps the tables this inventory reads — `channels`,
`channel_viewers`, `breakouts`, `breakout_viewers`, `spaces`, `space_viewers`
and the `parent_*` tables — so an Organization where these operations have not
run yet still names every conversation object to dump and close, and the two
the conversion below reads: `workspace_workstream_resource_links` and a
Sidekick's attachment to a Thread. Those go in a
later migration, once the operator has run both operations everywhere. Nothing is
published to the workspace socket: stopping its Thread topics is the other half
of plan step B-7 and is not done here.

- **Resumable without a receipt table.** A parent whose rows are gone is not in
  the next inventory; one interrupted between its conversations and its rows
  is, and its conversations keep their first tombstone. A finished
  Organization reruns as a pass over nothing.
- **A failed parent is left whole** and reported with the conversation it
  stopped at and its code (the object's own, or
  `thread_retirement_node_failed`); the rest of the pass goes on.
- **A retired conversation answers as a retired workspace's does**: a caller
  that still names one (a Sidekick's conversation attachment to a Thread, a
  queued effect) meets `workspace_retired`, which every background caller
  already treats as terminal.

### Converting Threads that have artifacts

A Thread whose conversations made or linked an artifact is not deleted: it
becomes a Canvas in place, keeping its id, so its Main becomes the Canvas's
Chat and its artifacts the Canvas's artifacts. The user decided this on
2026-11-08, after the pivot landed. `convert_threads_to_canvases` is the
operator call, per Organization, through the engineering MCP
([`engineering-mcp.md`](engineering-mcp.md#retiring-threads)); the order is
**dump, convert, retire**, so the retirement that follows finds only the
Threads with nothing to keep.

**Candidates.** `WorkspaceDO.threadConversionInventory` names every `channels`
row whose id appears in `artifact_registry.workstream_id`, or which links a
resource that is an artifact through `workspace_workstream_resource_links`.
A Channel (`spaces`) is never one. Each comes with its artifact, linked
artifact and viewer counts and its conversations, the same ones the
retirement inventory names. An artifact whose `workstream_id` names no
Thread, Canvas or Sidekick, and that no Canvas holds, is left alone and
counted (`artifactsWithoutThread`). A dry run, the default, answers that and writes
nothing; it also reports, per Thread, how many conversations have no dump.

**The guard** is the retirement's: an apply is refused with
`thread_retirement_dump_incomplete`, before anything is touched, unless every
conversation under every candidate (Main included) has its dump.

**Per Thread, in an order a crash resumes from:**

1. **The Canvas's rows** (`WorkspaceDO.convertThreadToCanvas`, through
   `canvasWrite`, so the Canvas list's waterline moves and every socket learns
   the Canvas). `HostedCanvas.createFromThread`, beside `create` and sharing
   its row insert, writes `canvas_directory` (`canvas_id` = the Thread's id;
   the title cut to 300; the creator from `channels`, else the earliest
   viewer, else the Thread fails with `thread_conversion_no_creator`;
   `created_at` = `source_created_at`; `updated_at` = `last_activity_at`;
   Organization visibility for a Workspace-scoped Thread and participants for
   a personal one; the Thread's authority generation, which its directory row
   projected from the conversation, so the two agree), as `added`
   participants every viewer but the creator of a personal Thread and only the
   viewers marked participants of a Workspace-scoped one, and both artifact
   sources in
   `canvas_artifacts`. An existing Canvas row is the resume marker and is left
   as it is. In the same call, idempotently on every pass, what other tables
   key on the Thread's Main is carried to the Canvas's names: memory facts
   learned there (source `<id>`, which opens to nobody) become `canvas:<id>`,
   with the sweep receipt the object's next sweep continues from, and every
   digest copy is marked; the Main's `authorization_locations` rows take kind
   `canvas`, so each location is recognised as a hosted conversation's
   rather than a retired Thread's; and a
   Sidekick's attachment to the Main becomes one to the Canvas's Chat.
2. **The Main's parent kind** (`AgentLoopDO.convertParentKind`): the stored
   `workstream` becomes `canvas`, and so does the envelope of every effect
   still in its outbox, which would otherwise be refused by kind until it
   dead-letters, and every run's stored workflow input
   (`runs.execution_context_json`), which `WorkstreamWorkflowInputSchema`
   refuses as `workstream`: left, Retry on a Thread-era failed or cancelled
   run would throw on the Canvas. The object then binds its loop as a hosted conversation does
   on construction and arms its alarm, which the retired kind had cleared on
   every firing. Already `canvas` is success; any other transition is refused
   with `conversation_parent_kind_conversion_unsupported:<from>:<to>`.
3. **Each Breakout's artifacts carried into the Chat, then each Breakout's
   object retired.** Every Breakout not yet retired is read
   (`AgentLoopDO.attachmentsForConversion`, through `identityForRetirement`),
   its attachments of the Canvas's artifacts (`canvas_artifacts`, which step 1
   answers) are attached to the Chat (`adoptAttachmentsForConversion`, which
   takes them only on a `canvas` conversation of that parent, keeps one
   already there, and moves the inventory revision when it adds one), and
   the Chat's authorization is projected at once (`projectAuthorization`), so
   `authorization_locations` places the artifact in the Chat before the
   Breakout closes. Without it an artifact published only in a Breakout is
   listed on the Canvas but opens for its uploader alone:
   `AuthorizationService.resource` needs a conversation the reader can open
   that holds the attachment. This widens access: a private Breakout's
   members chose a smaller audience, and its artifacts' content, not only
   their titles, opens to every reader of the Canvas, which for an
   Organization-wide Thread is the whole Organization. It is the
   implementer's reading, open to the owner, not the owner's call
   ([`canvases.md`](canvases.md#a-canvas-that-was-a-thread) has the rule);
   any other resource a Breakout attached stays with it. All are read before
   any is retired, so a retired Breakout was carried by an earlier pass and a
   resume skips it; the projection runs whenever anything was carried, so a
   pass that stopped between the adoption and the projection is finished by
   its resume. Then each Breakout is retired through
   `retireObject`, as `retire_threads` retires it (reason `thread_conversion`).
4. **The Thread's rows deleted** by `deleteRetiredThreadParent`.

A Thread whose rows are gone is no longer a candidate, so a finished
Organization reruns as a pass over nothing; one interrupted after its Canvas's
rows is a candidate again and is reported `alreadyConverted` when the pass
finishes it. A failed Thread is reported with the conversation it stopped at
and its code, and the rest go on.

**What needs nothing.** The D1 `workstreams` anchor and
`workstream_authority_routes` row stay, and `artifact_registry.workstream_id`
already names the Canvas. Search needs no reindex: a Thread's turns and links
were indexed under `conversation:<id>/0`, the group a Canvas's Chat carries,
which every person who can open the Canvas now holds; its Breakouts' groups
stay unheld. The unread state of the Canvas list starts empty (the hosted
parent has no reader rows until a reader's next read reports one), and its
recency is the Thread's last activity. No pin survives migration 147, and the
per-conversation `sidekick_attachments` table was dropped by the object's
migration 86.

**Shares are the one table set the Thread and its Canvas both key by the id.**
A Canvas's email share writes `parent_invitations`, `parent_grants` and their
operation, revision and participant tables (`CANVAS_SHARE_TABLES` in
`hosted-parent-schema.ts`) under the Canvas's id, which is the Thread's. So
step 1 deletes the Thread's rows from those tables in the transaction that
makes the Canvas's row, and only when it makes it; step 4 passes
`convertedToCanvas`, and `deleteRetiredThreadParent` then leaves those tables
alone. An invitation or grant made on the live Canvas between an interrupted
pass and its resume survives the resume. A Thread invitation still unclaimed
at conversion is deleted, so its emailed link stops working; the Canvas's
owner can share the Canvas again. Guests who had claimed one keep the Canvas:
their `channel_viewers` rows become `canvas_participants`.

## Boundary

This module owns closing a workspace and nothing else. It does not own how a
workspace is created (ordinary onboarding), how an object schedules itself
([`durable-object-alarms.md`](durable-object-alarms.md)), or how sockets are
closed when access ends ([`access-revocation.md`](access-revocation.md)).

The gate is a lifecycle policy, not an authorization system: it answers "is this
object still alive", never "may this caller do this". Every existing
authorization check still runs behind it.

Retirement is not deletion. Rows stay where they are; the tombstone is what stops
anything in an object reading or draining them, and `abandoned_at` is what
stops the D1 reads that never reach an object. The column is the one the
last-member-leaves path writes ([`multiple-workspaces.md`](multiple-workspaces.md));
this module writes it and does not own its other readers.

One workspace-scoped Durable Object class is **not** gated and not walked:
`ArtifactHostDO`, which serves a work stream's published artifacts to viewer
sessions admitted by the canonical authorization service, is never tombstoned,
and its own alarm and facet storage are untouched. Gating and walking artifact hosts is the
remaining piece of "nothing in it ever writes again", recorded under **Open
questions**.

One permitted door writes: `runInspectionSql`, the Access-gated operator SQL
surface ([`engineering-mcp.md`](engineering-mcp.md)), is the repair door and
the one way to inspect or correct what a retired object holds, the tombstone
included.

## Failure modes and limits

- **Construction is let through.** It runs inside `blockConcurrencyWhile`, which
  admits no other event, so the window cannot be taken by a product call. An
  object that could not build itself could not be read by an operator either. The
  window is a depth counter opened by `initializeDurableObject` itself rather
  than only by the constructor, because `run` is a closure the gate cannot supply
  a receiver to and `AgentLoopDO` opens two of them in sequence.
- **`AgentLoopDO` recovers its runtime lazily**, deliberately outside that
  window so a cold socket upgrade does not wait on a storage alarm round trip.
  `startRuntimeRecovery` is therefore permitted, and its attempt is a prototype
  method rather than a constructor-bound closure — a closure over the raw
  instance is invisible to the permit, which is what made a retired agent
  unreachable after its first eviction.
- **The walk holds one invocation open across the whole graph.** It is resumable
  in the sense that matters — the receipts survive, and a second call returns to
  exactly the unreceipted nodes — but nothing re-invokes it: there is no queue
  message, alarm or workflow behind it, so an interrupted pass waits for somebody
  to ask again. That is sized for the workspaces it was built for, which have a
  handful of parents; the receipt it answers with says what remains, and the
  operator asks again. A pass on a large workspace can be cut off before it
  answers; each child is receipted, so asking again still converges. Do not
  run passes that overlap: both walk the same unreceipted children. A pass has
  ended when its `EngineeringInspectionBridge.jsrpc` invocation log appears.
- **Stranded outbox rows are counted, not drained.** Draining means publishing
  out of a closed workspace; moving them means deciding whose they now are. The
  count is what distinguishes retained residue from work still in flight. It
  counts only the objects this pass woke: receipted parents and receipted
  children are skipped, so their stranded rows are not in a later pass's
  receipt.
- **A parent the directory names but holds no rows for** answers `missing`,
  has no children, and is receipted; the Organization's tombstone already
  fences its id.
- **A failed node leaves retirement incomplete.** The walk continues to the rest
  and reports incomplete, so the next pass returns to exactly that node. The
  receipt's `failed[].error` is a stable code (`conversation_parent_identity_mismatch`,
  `workspace_retired`, or the fallback `workspace_retirement_node_failed`),
  never raw runtime text.
- **What a caller sees.** A product call on a retired object over RPC throws
  `RetirementRefusedError`, whose `code` is `workspace_retired` and whose message
  is a sentence with the next action ("closed permanently … do not retry"),
  because the same text reaches a model when a tool meets a closed workspace.
  A route that reaches the object answers `409 workspace_retired` with that
  sentence (`middleware/errors.ts`), never a 500; the object's own HTTP door and
  socket upgrade answer the same 409. A session into a retired workspace fails
  earlier, at authentication, with `401 session_revoked`. An operator credential
  in the wrong role gets `403 operator_role_forbidden`.
- **The walk holds one invocation and can exceed the subrequest ceiling** on a
  workspace far larger than the ones it was built for. It then throws rather
  than answering a partial receipt, and the operator sees a relayed 502; the
  receipts written so far survive, and the next call resumes from them.
- **A native `#private` field on a gated class** would break the unfenced view,
  which is a `Proxy`; none exist today (the classes use TypeScript `private`,
  which is not a runtime fact).

## Testing

| Suite | Command | What it proves |
| --- | --- | --- |
| `apps/api/test-workers/object-retirement.test.ts` | `pnpm --filter @rally/api test:workers` | The gate on real workerd: refusal on every class, a refusal that crosses the RPC boundary with its code, `canReadWorkstream` answering `false`, sockets closed with `1008`, drop-and-acknowledge in the shapes the consumers parse, alarm clearing, a rebuilt retired agent not refilling its alarm index, that all three socket-holding object classes rebuild themselves after eviction and revoke access while retired, and that the gate's function is installed on every callable method. |
| `apps/api/test-workers/workspace-retirement-graph.test.ts` | `pnpm --filter @rally/api test:workers` | The graph is captured before the tombstone, is idempotent and resumable — including over a parent retired but never receipted — an empty workspace reports closed, an identity mismatch leaves a node failed with a stable code, the walk closes children before parents, and a pass cut off inside a parent leaves the next pass only the children still open. |
| `apps/api/test-workers/thread-retirement.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/thread-retirement.test.ts` | On real objects: the dump writes every Thread, Breakout and Channel conversation under its key with the room-visible text, never a Canvas's or Sidekick's, writes nothing on a rerun even after a conversation moved, refuses a confirmation that names another Organization, and reports a conversation holding another identity or parent kind by its code, unwritten, which keeps the retirement refused; the retirement is refused before the dump and touches nothing, then retires every Thread, Breakout and Channel conversation and deletes their rows, a pending invitation and its operation included, while the Canvas, the Sidekick and a resource survive, and reruns as a no-op. |
| `apps/api/test/workspace-retirement-children-migration.test.ts` | `pnpm --filter @rally/api exec vitest run test/workspace-retirement-children-migration.test.ts` | Against the real migrations: a retired v134 workspace with a partly receipted graph upgrades to 135 with its tombstone and receipts intact, and a replayed child receipt stays one row. |
| `apps/api/test/workspace-operations.test.ts` | `pnpm --filter @rally/api exec vitest run test/workspace-operations.test.ts` | Against the real migrations: the route admits only the `demos` role, refuses a confirmation naming another workspace, refuses an id this region does not own even when its row is present, writes `abandoned_at` before walking, and answers the contract's receipt. |
| `apps/api/test/retirement-background-callers.test.ts` | `pnpm --filter @rally/api exec vitest run test/retirement-background-callers.test.ts` | Each background caller acknowledges a refusal: the flag fan-out, the revocation hop, and the digest pass, which also proves the pass finishes and writes its cursor. |
| `apps/api/test/telemetry-operator-routes.test.ts` | `pnpm --filter @rally/api exec vitest run test/telemetry-operator-routes.test.ts` | The `demos` role is refused at the telemetry router, on every route. |
| `apps/api/test/workspace-runtime-database.test.ts`, `apps/api/test/workstream-object-schema.test.ts` | `pnpm --filter @rally/api exec vitest run test/<file>` | Retirement's tables are declared to the schema guards. |
| `apps/ace/test/workspaces.test.ts`, `apps/ace/test/workspaces-client.test.tsx`, `apps/ace/test/directory.test.ts` | `pnpm --filter @rally/ace test` | Ace's relay refuses an unconfirmed retirement before asking the region, carries the confirmation when it does, names a contract mismatch as such, and answers a directory outage with a sentence; the tab's typed confirmation, its receipt, an incomplete pass kept armed and scoped to its workspace, a failed search shown as a failure, and a partial outage named. |

The coverage test in `object-retirement.test.ts` proves the gate is *installed*
on every method; it cannot decide what retirement should do to a new one. An
unlisted method refuses, which is the safe direction, and the test pins by name
the handful of dispositions the design depends on. It once also asserted that no
method was "unclassified" — a check that could not fail, because the gate has no
such state.

Two of these were written wrong first and are worth knowing about. The gate's
original tests all passed with the gate disabled, because every assertion was
answered from an in-memory cache and none of them read the stored tombstone; the
test that replaced them writes the row underneath the object so the storage read
is the only path. And the walk's ordering test retired zero children for its
first few days, because nothing had registered one — the assertion it was named
for could not fail, and the parent-missing branch it was actually exercising is
the one that skips the children entirely.

The eviction test covers both object classes in one case on purpose. Both
failures it exists for were category failures found one class at a time, and
neither is visible from a single class: `WorkspaceDO` reaches a hosted
parent through its own lookup, and `AgentLoopDO` recovers after the construction window
closes, which is the case a construction-only fix does not reach.

## Operations

- **Who closed it.** The regional log line `workspace_retirement_pass` carries
  `workspace_id`, `operation_id` and `operator_id` — the operator UUID from the
  credential map for an Ace retirement, the engineering MCP's Access subject for
  `retire_org` — and is the region's record; Ace writes `ace_workspace_retired`
  with the Access subject in its own Worker's logs, and `retire_org` writes an
  `engineering.retire_org` audit pair in `AUDIT_DB`. The tombstone itself names
  an operator retirement and no person. `operation_id` is minted per pass, so a
  resumed retirement logs a second id; correlate by `workspace_id`.
- **What is left.** `WorkspaceDO.workspaceRetirementProgress` is permitted after
  retirement and lists every recorded parent with its receipt; the receipt Ace
  shows carries the same `remaining` and `failed` list, with a stable code per
  failed node. `objectRetirementState` on any gated object answers its
  tombstone and its retained outbox count.
- **Resuming.** Call the route again; the receipts survive, and a pass returns
  only to what is unreceipted.
- **Retiring the demo Organizations (deploy order for the 2026-11-08 demo
  removal).** Before the change that removes demo preparation ships, list
  every live demo Organization in Global —
  `SELECT operation_id, workspace_id, status FROM demo_operations WHERE workspace_id IS NOT NULL AND retired_at IS NULL`
  — and add the template, `demo-template`
  (`01a06d5d-4624-751e-8269-e7950b51a835`), which loses the discovery filter
  that hid it from its own members. Confirm no preparation is running
  (`status = 'running'`, or a running `avalon-global-demo-preparation`
  Workflow instance). Retire each from Ace's Workspaces tab through this door,
  while the old Worker still revokes the `demo:<operation>` impersonation
  edges as it closes the Organization. Then deploy the Worker. D1 migration
  0126, which drops `demo_operations`, `demo_operation_phases` and
  `demo_seed_receipts`, is not part of that change: it ships in a separate pull request that adds `0126_drop_demo_tables.sql` together with its name in the Worker-first list in `scripts/classify-pending-d1-migrations.mjs`, merged only once 0125 has shipped and no other migration is pending in any region's ledger. The
  deploy job applies pending migrations before it promotes the Worker unless
  a Worker-first migration is the sole pending entry, and fails closed when it
  has a companion ([`runbook.md`](runbook.md)); the old Worker's discovery
  reads `demo_operations` on every sign-in, so the drop must follow the
  Worker. An Organization missed here can
  still be retired the same way afterwards; it simply keeps its demo-written
  impersonation edges, which nothing reads.
- **Undoing.** There is no product path. `runInspectionSql` is the repair door
  on every object, the tombstone included, and `workspaces.abandoned_at` is a
  plain column; both are deliberate hand repairs, not a feature.

## Data model

| Where | Table | Holds |
| --- | --- | --- |
| Every gated object's SQLite | `object_retirement` | One row. The tombstone: instant, operation, actor, reason. |
| WorkspaceDO SQLite | `workspace_retirement_graph` | One row per parent, with a nullable `retired_at` receipt. |
| WorkspaceDO SQLite | `workspace_retirement_children` | One row per conversation the walk closed, keyed by `(parent_id, substream_id)`. |

The tombstone lives in the object rather than D1 because the gate answers during
constructor recovery, before anything cross-authority could be consulted. Both
tables arrive through each of the two gated classes' own append-only migration
ledger, from one shared constant, as `_internal_durable_alarms` does. There is
no D1 table for a retirement; the door sets `workspaces.abandoned_at`, the
column every D1 authority read already fences on, and a caller that needs more
than "closed" asks the object.

## Security and trust model

Retirement is irreversible and takes any workspace id. Nothing in this module
authorizes it. It has two callers, and each is admitted by its own Access
policy:

- **Ace**, whose page confirmation — one that makes the operator name the
  workspace rather than click beside it — is the rest of the protection, and
  which reaches the regional route with the `demos` credential described below.
- **The engineering MCP's `retire_org`**, which reaches the door through the
  regional `EngineeringInspectionBridge` over a private Service Binding. It
  holds no `demos` credential and asks for no typed confirmation: Access
  membership on the MCP is the whole of its authorization, and its audit pair in
  `AUDIT_DB` names the operator
  ([`engineering-mcp.md`](engineering-mcp.md#retiring-an-organization)).

Ace's confirmation travels with the
request, and Ace and the regional API each check that it names the workspace in
the path; that is a consistency check that catches a page or a script naming
one workspace and closing another, not a second confirmation, since a caller
that fills in both fields passes it. The regional door adds one check the walk
deliberately does not: the id must name a workspace this region's `workspaces`
table holds, so an id the other region owns is refused rather than "retired" as
a set of new empty objects. The region records the operator's id in its pass
log.

The operator credential's `demos` role, which only the Ace route uses, is one token per region, held by that
region's `DEMO_OPERATORS_JSON` and by Ace as that region's secret, and by
nobody else: an operator credential never crosses regions, so a leak of one is
destructive authority in one jurisdiction rather than both. Every operator
router names the roles it admits, which is the only thing that makes a role an
isolation: the telemetry router refuses `demos`, and this router refuses the
telemetry roles.

## Open questions

- **Sessions are fenced, not revoked.** A session into a retired workspace fails
  authentication on its next request (`abandoned_at`), and every socket was
  closed when its object was retired, so the session can reach nothing — but
  the session row itself is not revoked and the desktop is told
  `session_revoked` rather than "this workspace was closed". A per-member
  revocation fan-out with a retirement `reason` would let the desktop say so.
- **Artifact hosts are not walked.** See **Boundary**: `ArtifactHostDO`
  holds no tombstone. Walking `artifact_registry` and gating the class is the
  remaining step.
- **A Sidekick child's Terminal deadline never reaches the workspace
  schedule.** `workstreamScheduleTargets` enumerated only a Thread's `channels`
  row, and answers nothing now that Threads are retired;
  `HostedConversation.childTerminalDeadlines` is read only for a parent the
  schedule already named. Whether a Sidekick run's Terminal deadline should be
  scheduled here is unanswered, and was not changed by the Thread-era drop.
- **Nothing re-invokes an interrupted walk.** See **Failure modes and limits**;
  a schedule behind it is a decision about what retirement is for beyond the
  workspaces it was built for.

## Changelog

### 2026-11-09 — The walk closes a parent's children ten at a time

**What changed:** `retireWorkspaceGraph` closes one parent's conversations in
batches of `RETIREMENT_CHILD_CONCURRENCY` (10) through the existing
`settledBatches` helper, instead of one at a time. A batch settles in full
before the next starts; the first failure in a batch still leaves the parent
unreceipted and named in `failed`.

**Why:** Even with per-child receipts, each pass closed only 150 to 180
conversations before the ~240s cutoff, because each `retireObject` waits 0.1 to
1.7s on a cold object and the bridge spent only 68 to 82ms of CPU in a whole
pass. A demo parent with a few hundred conversations took several passes and
several MCP timeouts. The team set the number to 10, choosing between 6, 10 and
20; the reasoning is not recorded beyond that choice. At about 1.7s for the
slowest call in a batch, that is about 6 conversations a second.

**Considered and rejected:** A worker pool that starts the next child as soon
as one finishes. It is somewhat faster, but `settledBatches` already exists and
already guarantees no write is left in flight when the walk stops, which is
the property a retirement needs.

**Consequences:** Whether Cloudflare's 6 simultaneous open connections per
invocation counts Durable Object calls is not established; if it does, calls
beyond 6 queue rather than fail. The entry below rejected parallel retirement
because a concurrency figure is the team's to set; it now has one.

### 2026-11-09 — The walk receipts each conversation, so a cut-off pass keeps its progress

**What changed:** WorkspaceDO migration 135 adds `workspace_retirement_children`.
The walk calls `recordRetiredChild` after each conversation confirms its
tombstone, and `childrenForRetirement` leaves receipted children out. The
parent receipt and completion are unchanged.

**Why:** Retiring a production demo stalled. Its fifth parent held a few hundred
conversations, each `retireObject` took 100ms to 1.7s of wall time (almost all
of it waking the object), and the pass was cancelled at about 240s, twice, before
it reached that parent's receipt. Progress was saved per parent only, so each
pass started that parent's children over from the first: asking again could
never finish. The `workspace_retirement_pass` log never fired either, because it
is written at the end of a pass, so the stall showed up only in the invocation
logs (`outcome: canceled`).

**Considered and rejected:** Retiring children in parallel. It would make most
passes finish, but a concurrency figure is a limit the team sets, and it still
loses all of a parent's progress on a big enough parent. Bounding each pass by
time and answering a partial receipt: that is also a number to choose, and it is
worth doing on top of this, not instead of it. Recording children in
`workspace_retirement_graph`: it would make child rows count toward `remaining`,
and they are discovered only as the walk reaches each parent, so the count would
grow mid-walk.

**Consequences:** One extra WorkspaceDO RPC per child, small next to waking the
child. A child receipt is keyed by parent id and substream id, not parent kind,
because that pair alone names the conversation object. `retainedOutbox` now
skips receipted children as it already skipped receipted parents, so it counts
one pass, not the whole retirement. Anything that lists a
parent's children for retirement now sees only the open ones. Nothing re-invokes
an interrupted walk yet, and two overlapping passes still duplicate work.

### 2026-11-07 — Drop the Thread-era tables nothing reads, keeping what the Thread retirement reads

**What changed:** WorkspaceDO migration 147 drops 49 tables (Activity, digests
except `digest_schedules`, suggested work, a Channel's own ledgers, Thread pins
and order, Thread access and resource links, batch dispatches, the Thread
backfill, the import-reservation reclaim, `workstream_email_receipts`), the
Channel-rail and Channel-colour triggers on the tables that survive, and the
Thread rows of the shared tables. AgentLoopDO migration 86 drops the
per-conversation `sidekick_attachments`. The memory digest sync settles a
Thread's or a Channel's holder as dead, the workspace attention summary and
the Terminal schedule targets stop reading `channels`, and the dead
`isWorkstreamParticipant` is deleted.

**Why:** Plan step C-7. Each table had lost its last reader in phase C, and a
trigger left writing a dropped table would fail the write it fires on.
`digest_schedules` stays, emptied, because `schedules` names it in a foreign
key and SQLite refuses every insert into a child whose parent table is gone.
The attention summary counted frozen Thread state, so a retired Thread's
unread would have held the Organization and push badges up for good. The
alternative of dropping `channels` and `spaces` too was rejected: in an
Organization where `retire_threads` has not run, they are the only record of
which conversation objects to dump and close.

**Consequences:** The Thread directory tables, their viewers, the Breakout
directory and the `parent_*` tables are dropped by a later migration, after
the operator has run `dump_thread_transcripts` and `retire_threads` in every
Organization. The D1 tables `workstream_authority_control`,
`workstream_authority_routes` and `workstream_create_receipts` are not
dropped: Canvas and Sidekick creation still read the authority gate and the
create receipts. `workspace-thread-era-drop-migration.test.ts` checks that no
trigger or foreign key names a missing table after the drop, and failed with
the Channel rail's resource triggers left in place.

### 2026-11-07 — Retiring an Organization closes its Canvases' Chats

**What changed:** WorkspaceDO migration 146 copies
`workspace_retirement_graph` so its CHECK admits `canvas`, and
`beginWorkspaceRetirement` records every `canvas_directory` row. The walk asks
the Canvas for its children through the hosted-parent path it already uses for
a Sidekick, so each Canvas's Chat object is tombstoned with the Organization.
Ace's abandon confirmation says again that every Canvas and Sidekick in the
workspace closes.

**Why:** Plan step C-7. The graph's CHECK predated Canvases, so the recorder
never named one, and retiring an Organization left every Canvas Chat object
open and answering. `workspace-retirement-graph.test.ts` failed with the
recorder unchanged.

**Consequences:** `thread-retirement-service.ts` and the
`dump_thread_transcripts` and `retire_threads` operations stay until the
operator has run them in every Organization; only then can the Thread,
Channel and Space tables and this recorder's `channels` and `spaces` reads be
dropped.

### 2026-11-07 — Retire an Organization's Threads, Breakouts and Channels, after dumping their transcripts

### 2026-11-08 — The walk no longer writes the demo register

**What changed:** `retireWorkspaceGraph` no longer reads `demo_operations` to
revoke a demo's `demo:<operation>` impersonation edges, and no longer stamps
`retired_at` on that table once the graph is closed
(`markDemoWorkspaceRetired` is deleted). Operations gained the step that
retires every live demo Organization and the template before the removal
ships, and the deploy order around D1 migration 0126, which follows as a
Worker-first migration in its own pull request.

**Why:** The owner's instruction of 2026-11-08: "remove the demo
functionality completely". The walk was the demo feature's one write into
another module and its one demo-specific read; with the feature gone both had
no reader. Retiring the existing demo Organizations through this door, rather
than a bulk delete, is the existing path and closes their objects the way
every closed Organization is closed.

**What a future change must respect:** the walk still takes an optional
`impersonationRevocation`; a new producer of **can impersonate** edges passes
its own authority basis there rather than teaching the walk to look it up.

Shipped in juno-ai-labs/avalon#1490.

### 2026-11-08 — Convert a Thread that has artifacts into a Canvas in place

**What changed:** `convert_threads_to_canvases`, an engineering MCP operator
operation, makes every Thread of one Organization that made or linked an
artifact a Canvas with the same id: the Canvas's rows from the Thread's
(`HostedCanvas.createFromThread`), the Main's stored parent kind rewritten to
`canvas` (`AgentLoopDO.convertParentKind`), each Breakout's attachments of the
Canvas's artifacts carried into the Chat so every Canvas reader opens them,
the Breakouts retired and the Thread's rows deleted. It runs between the dump and the retirement, behind the
same dump guard. Migration 147, not yet shipped, now keeps
`workspace_workstream_resource_links` and Thread-kind Sidekick attachments for
it; `deleteRetiredThreadParent` deletes both with the Thread.

**Why:** The user decided on 2026-11-08 that Threads with artifacts become
Canvases rather than being deleted: production held 60 such Threads in 7
Organizations. Keeping the id means `artifact_registry`, the search index, the
D1 anchor and route need no rewrite. The alternative, creating new Canvases
and copying the conversation and artifacts into them, was rejected because
every id-keyed table would need a rewrite.

The order was advice only at first: `retire_threads` checked
only the dumps, so run before the conversion it orphaned every artifact, and
run after a partly failed one it tombstoned the Chat of a live Canvas, which
keeps the Thread's id. It is now refused while a candidate remains
(`thread_retirement_conversion_pending`), and its inventory leaves out any id
`canvas_directory` holds. Letting the retirement skip candidates instead was
rejected: a Thread it skipped would stay a Thread nothing can open. The
conversion's sweep also deleted every `parent_*` row of the
id, including invitations and grants made on the live Canvas between an
interrupted pass and its rerun; the Thread's shares now go when the Canvas is
made, and the sweep leaves `CANVAS_SHARE_TABLES` to the Canvas.

**What a future change must respect:** the order is dump, convert, retire, and
`retire_threads` enforces it. The
conversion is the only path that changes a conversation's stored parent kind,
and only from `workstream` to `canvas`; every stored copy of the kind in the
object (root row, outbox envelopes, run inputs) moves in the same
transaction. Anything new that keys on a Thread's
Main by its Thread-era name (a source string, a parent kind) has to be carried
in `convertThreadToCanvas`, or a converted Canvas loses it. A new table a Canvas writes under its
own id that `HOSTED_PARENT_STATE_TABLES` also sweeps joins
`CANVAS_SHARE_TABLES`, or a resumed conversion deletes it.

Shipped in juno-ai-labs/avalon#1490.

### 2026-11-07 — Retire an Organization's Threads after dumping them, close its Canvases with it, and drop the Thread-era tables nothing reads

**What changed:** Plan steps B-7a and B-7. `dump_thread_transcripts`, an
engineering MCP operator operation, walks one Organization's Threads, Breakouts
and Channels (`WorkspaceDO.threadRetirementInventory`) and writes each
conversation's transcript to R2 as text (`AgentLoopDO.conversationTranscriptText`,
formatted by `conversationAsText`), with the R2 object as its receipt.
`retire_threads`, refused until those receipts cover every conversation, retires
each conversation object through `retireObject` and then deletes the parent's
rows (`WorkspaceDO.deleteRetiredThreadParent`), leaving the Organization open.

Plan step C-7. WorkspaceDO migration 146 copies `workspace_retirement_graph`
so its CHECK admits `canvas`, and `beginWorkspaceRetirement` records every
`canvas_directory` row; the walk asks the Canvas for its children through the
hosted-parent path it already uses for a Sidekick, so each Canvas's Chat
object is tombstoned with the Organization, and Ace's abandon confirmation
says every Canvas and Sidekick closes. WorkspaceDO migration 147 drops 48
tables (Activity, digests except `digest_schedules`, suggested work, a
Channel's own ledgers, Thread pins and order, Thread access (the resource
links stay, for the conversion of 2026-11-08), batch dispatches, the Thread backfill, the import-reservation reclaim,
`workstream_email_receipts`), the Channel-rail and Channel-colour triggers on
the tables that survive, and the Thread rows of the shared tables. AgentLoopDO
migration 86 drops the per-conversation `sidekick_attachments`. The memory
digest sync settles a Thread's or a Channel's holder as dead, the workspace
attention summary and the Terminal schedule targets stop reading `channels`,
and the dead `isWorkstreamParticipant` is deleted.

**Why:** The PRD's decision log: existing Threads, Breakouts and Channels are
deleted at cutover, object by object, with no read-only mode, export or
conversion, because keeping the old product's data reachable means keeping its
readers deployed; and since that deletion is irreversible, each transcript is
first dumped to R2 for operators, in the pass the retirement walk already makes.
The graph's CHECK predated Canvases, so the recorder never named one, and
retiring an Organization left every Canvas Chat object open and answering
(`workspace-retirement-graph.test.ts` failed with the recorder unchanged).
Each dropped table had lost its last reader in phase C, and a trigger left
writing a dropped table would fail the write it fires on. `digest_schedules`
stays, emptied, because `schedules` names it in a foreign key and SQLite
refuses every insert into a child whose parent table is gone. The attention
summary counted frozen Thread state, so a retired Thread's unread would have
held the Organization and push badges up for good.

**Considered and rejected:** A receipt table in `WorkspaceDO` — a migration and
a second record of a fact the R2 object already is; a key that exists is a
dump that finished. Reusing the read-as-a-user transcript operation — it
authorizes a viewer, and an operator dump has none. Reusing
`workspace_retirement_graph` for the Thread walk — its completion is the
Organization's own tombstone, which this walk never writes. Deleting the parent
rows rather than only tombstoning, as the workspace walk does: the Organization
stays open and keeps serving its reads, so a Thread whose row survived would
still be listed, opened and refused. Reading the `parent_*` tables from the
schema alone: dynamic table names have to come from a closed code-owned list
([`durable-object-sqlite.md`](durable-object-sqlite.md)); intersecting the list
with the schema keeps the tolerance for tables a migration drops. Dropping
`channels` and `spaces` in 147 too: in an Organization where `retire_threads`
has not run, they are the only record of which conversation objects to dump
and close.

**Consequences:** A dump is a snapshot: what lands in a conversation after it is
not in it, and a rerun does not refresh it, so the two run back to back after
the cutover. Deletion is irreversible; the dump is the only copy.
`thread-retirement-service.ts` and the two operations stay until the operator
has run them in every Organization; only then can the Thread directory tables,
their viewers, the Breakout directory, the `parent_*` tables and this
recorder's `channels` and `spaces` reads be dropped. The D1 tables
`workstream_authority_control`, `workstream_authority_routes` and
`workstream_create_receipts` are not dropped: Canvas and Sidekick creation
still read the authority gate and the create receipts.
`workspace-thread-era-drop-migration.test.ts` checks that no trigger or
foreign key names a missing table after the drop, and failed with the Channel
rail's resource triggers left in place.

Shipped in juno-ai-labs/avalon#1490. Design: `docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`.

### 2026-09-19 — The graph admits a third parent kind, and the walk enumerates Spaces and knows which namespace to ask

**What changed:** `workspace_retirement_graph`'s `parent_kind` CHECK admits
`'space'` beside `'workstream'` and `'automation'`, rebuilt in WorkspaceDO
migration 61. The table is carried through a scratch table rather than
re-derived, and this heading now sits over the entries below it.

`beginWorkspaceRetirement` writes a `parent_kind = 'space'`
node for every Space in the Organization, archived ones included, and
`retireWorkspaceGraph` resolves a `space` node through `spaceDOName` against the
work-stream namespace. That closes the gap the entry below named as known.

**Why:** A Space is a conversation parent with a hidden main conversation and
children of its own, so Organization retirement has to reach it — and the
retirement graph is where a walk records what it has left to close. The CHECK
was written when there were two kinds and nothing could produce a third.

The widened CHECK admitted a kind nothing produced, so an Organization
with Spaces still reported complete with every `SpaceDO` open and answering — a
retirement that is not one. A Space is `WorkstreamDO` under a role and lives in
the same namespace, so the only thing the walk needed was the right object
*name*; the children-before-parents order already handles its hidden main
conversation, because a Space is the same class.

**Considered and rejected:** Re-deriving the graph from the directories during
the rebuild. It is fewer statements and it loses the only thing the table
actually holds: `retired_at` is the receipt that a node was already closed, and
the graph is captured *before* the workspace tombstone precisely because the
directories refuse afterwards. A rebuild that re-derived it would un-retire
whatever the last pass finished, and a walk resumed after an interruption would
close those children a second time.

Enumerating only active Spaces, on the reading that
an archived Space is already closed. It is not: archiving is a product state
that leaves the object and its conversation intact, and a graph that skipped
them would have moved the gap rather than closed it.

**Consequences:** The widened CHECK is all that lands here. Nothing enumerates
Spaces into the graph yet — `beginWorkspaceRetirement` still walks
`workspace_workstream_directory` and `automation_directory` — so an Organization
with Spaces reports complete without closing them. Phase 5 of
[the Spaces plan](PRDs/2026-09-18_spaces-and-product-hierarchy/plan.md) adds the
enumeration and the dispatcher hop; until it does, this is a known gap rather
than a supported state.

The entries below predate this heading and were filed, structurally, under
**Open questions**. They are the record of how retirement came to work the way
it does; what is *not* recorded anywhere is why the original CHECK named exactly
two kinds, and that reasoning has not been reconstructed here.

An Organization's node count now scales with its Spaces as
well as its Channels and Sidekicks. Nothing else changes — a Space node is
retired, receipted and resumed exactly like a Channel node.

### 2026-09-08 — The walk stamps the demo register

**What changed:** After the graph reports closed, `retireWorkspaceGraph`
calls `markDemoWorkspaceRetired`, which sets `retired_at` on the
`demo_operations` row whose workspace this was. The write is a no-op for any
other workspace. This arrives with the demo feature
([#594](https://github.com/juno-ai-labs/avalon/pull/594)), which the
2026-09-08 split entry below said would restore it.

**Why:** The Demos page has to say whether a demo is closed, and the only
other way to know is to wake the retired object and ask it, which is what
the gate exists to stop. The write is made by the walk rather than by the
Demos page reading `workspaces.abandoned_at` because the walk is the one
place that knows the graph is closed rather than merely fenced.

**Considered and rejected:** Having the demo feature observe retirement
through a Queue or a poll of `abandoned_at` — a second mechanism to carry one
timestamp, and `abandoned_at` is written before the walk, so it would have
said "closed" while objects were still open.

**Consequences:** Retirement writes one row it does not own, and never reads
it. A demo-side change to that row's meaning is the demo document's to make.

### 2026-09-08 — The `demos` credential has a secret of its own

**What changed:** The retirement route verifies its bearer token against
`DEMO_OPERATORS_JSON`, a new per-region Worker secret with the same shape as
`TELEMETRY_OPERATORS_JSON`, through `requireOperatorFrom(secret)` in
`operator-auth.ts`; `requireDemoOperator` and `requireTelemetryOperator` are
the two instances. The `demos` role no longer lives in the telemetry map.
The context key and accessor are `operator` and `getOperator`.

**Why:** The earlier decision to put the `demos` role in the telemetry map
("one thing to rotate") met its cost the first time anyone tried to add the
token: a Worker secret cannot be read back, the telemetry map had been set by
someone else with tokens nobody could name, and adding one role meant
overwriting all of them. Two secrets that different people set for different
reasons should not share a value. A leak of either now holds one surface
rather than both.

**Considered and rejected:** Keeping one map and asking for the current
telemetry tokens — they were not recorded anywhere reachable, and the coupling
would recur at every rotation.

**Consequences:** Operators set `DEMO_OPERATORS_JSON` in each region; the
telemetry map goes back to telemetry roles only. Both layers still apply: a
`demos` principal filed in the telemetry map reaches nothing, and a `support`
principal filed in the demo map is refused by role. A new operator surface
picks its secret with `requireOperatorFrom` and names its roles.

### 2026-09-08 — Review: the D1 door, the sockets, the background callers, and a resumable walk

**What changed:** The operator door writes `workspaces.abandoned_at` before
walking. `retireObject` closes every socket the object holds with `1008`.
`childrenForRetirement` is permitted on a retired parent. Runtime recovery on a
retired `SubstreamAgent` returns before touching leases or the alarm index.
`canReadWorkstream` answers `false` on a retired `WorkstreamDO` and
`WorkspaceDO`. Every background caller that reaches a gated object — the
revocation consumer, the flag fan-out, the activity consumer's three paths, the
connector Workflow and the digest reconciler — treats a refusal as terminal
through the new `isRetirementRefusal`, and Ace's flag fan-out skips closed
workspaces at the source. A refusal reaching an HTTP route is `409
workspace_retired` with a sentence, not a 500. The route carries the operator's
id into the pass log; log fields are `snake_case`; the receipt gains `parents`
and its `failed[].error` is a stable code. The coverage test's "unclassified"
assertion, which could not fail, is replaced by pinned dispositions and a test
per background caller. The Ace tab scopes its status to a workspace, keeps an
incomplete pass armed with its counts, holds the retired mark in the app, names
a directory that did not answer, searches by id, and reads a contract mismatch
as one; its `demo-*` classes became the shared `ace-form` family.

**Why:** A review swarm on the split PR. Four findings were P0-class. The D1
authority layer was untouched by retirement — sign-in, the member list and
invitations all still worked, and the page told the operator otherwise. A pass
that died between retiring a parent and receipting it could never be resumed,
because the walk's own read refused on the tombstoned parent. Roughly a dozen
methods that Queue consumers, the connector Workflow and the digest cron call
were unclassified and so refused: the first retired workspace would have
dead-lettered a revocation hop per automation, a flag message per flag change
forever, and wedged the region's digest reconciler at the first retired member.
And a permitted recovery re-derived wake reasons into the alarm index on every
rebuild of a retired agent — the exact re-arm the spike found — while an
unclosed socket sat "connected" with every frame discarded.

**Considered and rejected:** Dropping each background-called method in the
gate with a hand-written terminal shape — that is the by-name list the permit
design already found does not hold, and a Workflow has no drop shape to answer;
one predicate at each caller states the rule once and composes for the next
caller. Filtering the digest page on `abandoned_at` in SQL — the reconciler's
test fixture runs on a pre-`0098` schema snapshot that has no such column, and
the per-member skip alone unwedges the pass; the join is worth revisiting
with that fixture. Recording the operator in the tombstone's `actor_user_id` —
that column names a Rally user, and an operator is not one; the log line is
the record, and **Operations** says so. Renaming `retiredParents` to say "this
pass" — the total the page wants is the graph's, so the receipt now carries it.

**Consequences:** A new Queue consumer, Workflow or cron pass that reaches a
gated object must decide what a refusal means and, almost always, acknowledge
it; `test/retirement-background-callers.test.ts` lists the callers by file.
Retirement now writes one D1 column; the walk itself still writes no D1 row.
The Ace receipt contract carries `parents`. `retireWorkspaceForOperator` takes
the operator. The `ace-form` classes are the form primitive any Ace detail pane
uses.

### 2026-09-08 — A retired object refuses at every door, a permit is a call, any workspace can be retired, and retirement ships on its own

**What changed:** New module. A permanent tombstone in each object's own SQLite,
a class-level gate wrapping every callable method of the five classes that can
belong to a workspace, a recorded object graph captured before the tombstone,
and a resumable walk that closes children before parents.

A permitted method runs against a view of its own instance with the gate
lifted, so the whole call beneath it is unfenced. The construction window is a
depth counter opened by `initializeDurableObject` itself; `SubstreamAgent`'s
runtime recovery is a prototype method; dispositions resolve per instance at
call time; a policy entry naming a method its class does not have throws at
load; the negative tombstone answer is cached. Retirement takes its region from
the Worker rather than the caller, reports an empty workspace complete, and
asks each parent for its children through an RPC that answers "missing" and
"identity mismatch" instead of throwing them.

The module is split out of the demo-workspace branch and lands ahead of it,
with its own document. The route moved to `routes/workspace-operations.ts`, the
receipt's contract to `contracts/workspace-retirement.ts`, and Ace's relay to
`regional-api.ts`. The walk no longer writes a regional shadow of the
tombstone: the demo register that read it arrives with the demo feature, which
restores that write when it lands. The register mentioned above describes the
combined branch as it was written.

**Why:** The spike this was built on retired a workspace with a straight-line
best-effort walk and found two things it could not fix from outside. The
refusal it managed to observe came from `SubstreamAgent`, and the outbox it
stranded belonged to a `WorkstreamDO` — both objects that a product write
reaches without passing WorkspaceDO at all. And an alarm on one retired object
re-armed after traffic, because clearing an alarm does not stop the code that
re-derives it. A check at the edge, or a helper each method is expected to
call, addresses neither.

The first version of the gate could not express the one thing it needed to. A
permit was a method name, so every permitted entry point refused itself on the
first private helper it reached — `revokeSocketAccess` on all three classes
that have it, `syncAgentTimerAlarms` on every rebuilt `SubstreamAgent`, and
three found before those. In production that is the region-wide
access-revocation queue dead-lettering one message per retired object, and a
retired workspace becoming permanently unreachable within minutes of going
idle, taking operator inspection, the resumable walk, and every drop with it.
Five instances of one defect, discovered one at a time, is a mechanism that
cannot state its own requirement.

From review, the register-as-authorization was bookkeeping for a surface that
one Access policy already admits, and an operator tool that can retire *any*
workspace is what was actually wanted.

A review swarm on the finished feature found three more things. The walk
deliberately infers nothing from an id, which left the door in front of it
able to "retire" an id the other region owned as a set of brand-new empty
objects and report success. The `demos` role reached three telemetry routes
because only the new routers narrowed by role. A shared token was destructive
authority in both jurisdictions from one leak.

The gate wraps every method of every object class that can belong to a
workspace, and the demo feature that first needed it is ten thousand lines
that nothing runs until an operator starts a demo. Reviewed and observed
together, the one change with a production footprint would have been hidden
under the one without; apart, the gate merges with nothing calling it yet, so
its only effect is the negative tombstone check and the schema steps — which
is exactly what is worth watching on its own before anything closes a
workspace.

**Considered and rejected:**

- For the gate itself: a `Proxy` around the instance — workerd dispatches to
  prototype properties, so the proxy is not in the path. A per-method helper —
  229 methods on WorkspaceDO alone, and the failure mode is a method somebody
  forgot. A re-entrancy escape so permitted methods could call refused ones —
  that is a hole a product call could take, and the cost of not having it was
  that retirement's own helpers were listed explicitly, which is loud rather
  than silent. Gating on the workspace name ending in `-demo` — wrong in both
  directions, and the PRD rules it out. Draining stranded outbox rows —
  publishing out of a closed workspace. Deleting them — deciding whose they now
  are.
- For permits: naming the helpers — that is what failed, five times, and the
  list can only ever be as complete as the last person to trace a call graph by
  hand. A re-entrancy flag set on entry to a permitted method — the original
  objection stands: a flag is visible to whatever the runtime admits while that
  method is awaiting, and a product call could take it. Gating only the doors a
  caller can reach — TypeScript's `private` is not a runtime fact, so every
  helper is reachable over RPC and "door" is not a distinction the runtime can
  make.
- Keeping the register check as a soft warning — either it blocks or it is
  noise.
- Region-binding the operator principal instead of two tokens — a second
  secret is the smaller change and matches the per-region rule `security.md`
  already states.
- Landing the gate inside the demo PR after all — the reason above. Archiving
  instead of retiring, using the abandonment row the product already has — it
  closes every door through the API and the sockets but reaches nothing inside
  the objects, so a room's alarm still fires and a Queue still redelivers to
  it; acceptable for a demo, and still an option if "permanently quiet" turns
  out to matter less than the blast radius here.

**Consequences:** Adding a method to any of the five gated classes fences it by
default; an effect receiver added without a `drop` entry will refuse and strand
its Queue message, so new receivers must be classified. The alarm coordinator's
mutators are inert on a retired object, so code that assumes `armNextAlarm`
always arms is wrong there. Under the first design a permitted method that
called an unlisted private helper threw the first time retirement ran; with a
permit as a call, a new permitted entry point needs no call-graph audit, but a
permitted method runs its whole tree unfenced, so permitting something that
writes product state is a real mistake rather than a partial one. Anything that
opens `initializeDurableObject` is inside the construction window for its whole
duration. A closure the constructor binds cannot be reached by a permit, so
recovery-shaped work belongs on the prototype. Callers no longer pass a region.

The confirmation in Ace is the only thing between an operator and an
irreversible close of a customer workspace; build it to make the operator type
or paste the id. Adding an operator router means naming its roles. A wrong
region is a refusal, not a phantom retirement.

`retireWorkspaceGraph` takes no `completedAt` and writes no D1 row; a feature
that wants a regional record of a closed workspace writes it after the receipt
reports complete. The tombstone is conversation-object schema v48, WorkspaceDO
41 with the graph at 42, WorkstreamDO 8, and Sidekick 5 — renumbered three
times on rebase as `main` took the numbers before them, most recently v46 and
v47 (Sidekick skill names, shared appearance) and WorkspaceDO 40 (appearance).

Design: `docs/PRDs/2026-09-04_demo-workspace/prd.md`.
