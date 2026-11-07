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

Read it before changing retirement, adding a method to any of the three gated
object classes, adding an effect receiver to one of them, or adding a Queue
consumer, Workflow or cron pass that reaches one.

The product decision behind it is in
[the demo workspace PRD](PRDs/2026-09-04_demo-workspace/prd.md): a demo is a
new workspace every time, and the old one is retired rather than cleared. The
mechanism is not demo-specific — it takes any workspace — and the demo feature
that first needed it ships separately, calling what is here.

## Where the code lives

| Path | Role |
| --- | --- |
| `apps/api/src/durable-objects/object-retirement.ts` | The tombstone, the gate that wraps every callable method of a retired object, the three dispositions, `ALWAYS_PERMITTED_METHODS`, and `isRetirementRefusal`, which every background caller reads. |
| `apps/api/src/durable-objects/scheduled-alarms.ts` | `retireObject` and `objectRetirementState` on the base every gated class extends, plus the alarm clearing retirement performs. |
| `apps/api/src/durable-objects/workspace-do.ts` | `beginWorkspaceRetirement`, `recordRetiredNode`, `workspaceRetirementProgress`, and the `workspace_retirement_graph` table behind them. |
| `apps/api/src/services/workspace-retirement-service.ts` | The pass that walks the recorded graph, closing children before parents, and the operator door in front of it. |
| `apps/api/src/routes/workspace-operations.ts` | `/internal/workspaces/:id/retire`, behind the operator credential in the `demos` role. |
| `apps/api/src/middleware/errors.ts` | Maps a refusal that reaches an HTTP route to `409 workspace_retired`. |
| `apps/api/src/queues/access-revocation-consumer.ts`, `product-feature-flag-consumer.ts`, `activity-consumer.ts`, `apps/api/src/workflows/connector-event.ts` | The background callers that can meet a retired object; each acknowledges a refusal as terminal. |
| `apps/api/src/telemetry/operator-auth.ts` | The operator credentials: `requireOperatorFrom` verifies a bearer token against one of two same-shaped secrets — `DEMO_OPERATORS_JSON` for the `demos` role Ace holds, `TELEMETRY_OPERATORS_JSON` for the telemetry roles — and `requireOperatorRole`, which every operator router narrows with. |
| `packages/contracts/src/workspace-retirement.ts` | The receipt a retirement answers with. |
| `packages/contracts/src/conversation-parent.ts` | `childrenForRetirement`'s three-way answer. |
| `apps/ace/src/regional-api.ts`, `apps/ace/src/client/workspaces.tsx` | Ace's relay to the regional route and the workspaces tab that calls it ([`ace.md`](ace.md)). |
| `apps/api/src/services/thread-retirement-service.ts` | Retiring one Organization's Threads, Breakouts and Channels while the Organization stays open: the transcript dump to R2 and the retirement it unlocks (see [Retiring Threads, Breakouts and Channels](#retiring-threads-breakouts-and-channels)). |
| `WorkspaceDO.threadRetirementInventory`, `WorkspaceDO.deleteRetiredThreadParent`, `AgentLoopDO.conversationTranscriptText` | What that walk visits, the rows it deletes once a parent's conversations are retired, and the whole transcript of one conversation as room-visible text. |

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
`SubstreamAgent`) extend `ScheduledDurableObject`,
so the tombstone and its two entry points live there. One gate policy is
declared per class, and each declares only its exceptions.

Channel, Space and Sidekick parents have no object of their own: their state is rows in
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
   the node stays unreceipted on every pass. Every node, a Channel's, a
   Space's or a Sidekick's, asks `WorkspaceDO.childrenForRetirement`, which is
   permitted on the already retired Organization object, and has no parent
   object to retire after its children.
5. **Finish when nothing is left unreceipted.** Completion is the workspace's own
   tombstone plus the absence of NULLs in the graph table, rather than a flag
   somebody sets. The tombstone is what says the enumeration happened: reading
   completeness from the row count alone confused "nothing recorded yet" with
   "nothing to record", so an empty workspace reported unfinished forever.

### Background callers

Retirement leaves every D1 row in place, so the enumerators that drive the
Queue consumers, the connector Workflow and the digest cron keep naming a
retired workspace, and its objects refuse them the same way on every delivery.
A refusal is therefore **terminal for background work**: a Queue consumer
acknowledges the message, the connector Workflow ends its instance, and the
digest pass skips the member and moves on. Each of those callers reads
`isRetirementRefusal` — the refusal crosses an RPC boundary, so `instanceof`
is not available, and the predicate matches the `code` the runtime preserves.
A consumer that retried instead dead-lettered one message per retired object
forever, which spends the one signal this repository treats as monitoring on a
state somebody designed. Two enumerators skip a closed workspace at the source
as well: Ace's flag fan-out reads `workspaces` with `abandoned_at IS NULL`, and
the access-revocation walk finds nothing beneath an object whose sockets
retirement already closed.

The effect receivers a Queue redelivers to (`receiveChildEffects` and
`applyWorkstreamDirectoryEffects`, which no production path calls any more but
the gate still lists) are the exception and are **dropped** in the gate
instead: their consumers parse a `strictObject` acknowledgement and would treat
a throw as a delivery failure, so the object answers the shape they expect. One
read is dropped for the same reason: `WorkspaceDO.canReadWorkstream` answers
`false` on a retired object, because nobody can read anything in a retired
workspace and a caller can act on `false` where it cannot act on a throw.

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

The route sits behind the operator credential in a role of its own, `demos`,
which Ace holds one token per region for, read from a secret of its own,
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
  action behind Ace's Access policy, and the only protection between an operator
  and an irreversible close is the confirmation the page asks for. A gate on a
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
read.

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

**Then the retirement.** `retire_threads` is refused with
`thread_retirement_dump_incomplete`, before anything is touched, unless every
conversation in the inventory has its dump. Then, parent by parent, children
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
  rows, or a Channel's `spaces` and `space_viewers` rows. Nothing else
  cascades from them since migration 147 dropped the pin, resource-link and
  access tables that referenced them.

What it leaves: the Organization object, untombstoned,
Canvases, Sidekicks, resources, and memory. The other Thread- and
Channel-keyed tables are gone already: WorkspaceDO migration 147
(`THREAD_ERA_TABLES_DROP_MIGRATION` in `retired-workspace-schema.ts`) drops
every Thread-era table nothing reads, and the Thread rows of the shared tables
(memory digest holders, Sidekick attachments, Thread and artifact pins, room
bindings). It deliberately keeps the tables this inventory reads — `channels`,
`channel_viewers`, `breakouts`, `breakout_viewers`, `spaces`, `space_viewers`
and the `parent_*` tables — so an Organization where these operations have not
run yet still names every conversation object to dump and close. Those go in a
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

The walk makes one write into another module's table. When the graph reports
closed it calls `markDemoWorkspaceRetired`, which sets `retired_at` on the
demo operation that made the workspace, so the Demos page can answer "is there
a demo" without waking a retired object to ask. It is a shadow written after
the fact, owned by [`demo-workspaces.md`](demo-workspaces.md); retirement never
reads it, and a workspace no demo made has no row for it to touch.

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
  a receiver to and `SubstreamAgent` opens two of them in sequence.
- **`SubstreamAgent` recovers its runtime lazily**, deliberately outside that
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
  operator asks again.
- **Stranded outbox rows are counted, not drained.** Draining means publishing
  out of a closed workspace; moving them means deciding whose they now are. The
  count is what distinguishes retained residue from work still in flight.
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
| `apps/api/test-workers/workspace-retirement-graph.test.ts` | `pnpm --filter @rally/api test:workers` | The graph is captured before the tombstone, is idempotent and resumable — including over a parent retired but never receipted — an empty workspace reports closed, an identity mismatch leaves a node failed with a stable code, and the walk closes children before parents. |
| `apps/api/test-workers/thread-retirement.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/thread-retirement.test.ts` | On real objects: the dump writes every Thread, Breakout and Channel conversation under its key with the room-visible text, never a Canvas's or Sidekick's, writes nothing on a rerun even after a conversation moved, refuses a confirmation that names another Organization, and reports a conversation holding another identity or parent kind by its code, unwritten, which keeps the retirement refused; the retirement is refused before the dump and touches nothing, then retires every Thread, Breakout and Channel conversation and deletes their rows, a pending invitation and its operation included, while the Canvas, the Sidekick and a resource survive, and reruns as a no-op. |
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

The eviction test covers all three object classes in one case on purpose. Both
failures it exists for were category failures found one class at a time, and
neither is visible from a single class: `WorkspaceDO` reaches a hosted Channel
parent through its own lookup, and `SubstreamAgent` recovers after the construction window
closes, which is the case a construction-only fix does not reach.

## Operations

- **Who closed it.** The regional log line `workspace_retirement_pass` carries
  `workspace_id`, `operation_id` and `operator_id` — the operator UUID from the
  credential map — and is the region's record; Ace writes `ace_workspace_retired`
  with the Access subject in its own Worker's logs. The tombstone itself names
  an operator retirement and no person. `operation_id` is minted per pass, so a
  resumed retirement logs a second id; correlate by `workspace_id`.
- **What is left.** `WorkspaceDO.workspaceRetirementProgress` is permitted after
  retirement and lists every recorded parent with its receipt; the receipt Ace
  shows carries the same `remaining` and `failed` list, with a stable code per
  failed node. `objectRetirementState` on any gated object answers its
  tombstone and its retained outbox count.
- **Resuming.** Call the route again; the receipts survive, and a pass returns
  only to what is unreceipted.
- **Undoing.** There is no product path. `runInspectionSql` is the repair door
  on every object, the tombstone included, and `workspaces.abandoned_at` is a
  plain column; both are deliberate hand repairs, not a feature.

## Data model

| Where | Table | Holds |
| --- | --- | --- |
| Every gated object's SQLite | `object_retirement` | One row. The tombstone: instant, operation, actor, reason. |
| WorkspaceDO SQLite | `workspace_retirement_graph` | One row per parent, with a nullable `retired_at` receipt. |

The tombstone lives in the object rather than D1 because the gate answers during
constructor recovery, before anything cross-authority could be consulted. Both
tables arrive through each of the three gated classes' own append-only migration
ledger, from one shared constant, as `_internal_durable_alarms` does. There is
no D1 table for a retirement; the door sets `workspaces.abandoned_at`, the
column every D1 authority read already fences on, and a caller that needs more
than "closed" asks the object. The one regional shadow of the receipt is the demo
feature's: once the graph reports closed, the walk stamps `retired_at` on the
`demo_operations` row that made the workspace — a no-op for a workspace no demo
made — and nothing here reads it back
([`demo-workspaces.md`](demo-workspaces.md#data-model)).

## Security and trust model

Retirement is irreversible and takes any workspace id. Nothing in this module
authorizes it: the Ace Access policy admits the operator, and the page's
confirmation — one that makes the operator name the workspace rather than click
beside it — is the whole of the protection. The confirmation travels with the
request, and Ace and the regional API each check that it names the workspace in
the path; that is a consistency check that catches a page or a script naming
one workspace and closing another, not a second confirmation, since a caller
that fills in both fields passes it. The regional door adds one check the walk
deliberately does not: the id must name a workspace this region's `workspaces`
table holds, so an id the other region owns is refused rather than "retired" as
a set of new empty objects. The region records the operator's id in its pass
log.

The operator credential's `demos` role is one token per region, held by that
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
says every Canvas and Sidekick closes. WorkspaceDO migration 147 drops 49
tables (Activity, digests except `digest_schedules`, suggested work, a
Channel's own ledgers, Thread pins and order, Thread access and resource
links, batch dispatches, the Thread backfill, the import-reservation reclaim,
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

Design: `docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`.

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
