# Workspace retirement

Retiring a workspace closes it permanently: every room, automation and socket in
it stops, nothing reopens, and nothing in it ever writes again — including after
eviction, when the platform recovers an alarm or a Queue redelivers an effect.
This document covers the machinery that makes that true: the tombstone every
gated Durable Object consults, the object graph recorded before the workspace
closes, the resumable walk that closes children before parents, and the
operator door in Ace behind which all of it sits.

Read it before changing retirement, adding a method to any of the five gated
object classes, or adding an effect receiver to one of them.

The product decision behind it is in
[the demo workspace PRD](PRDs/2026-09-04_demo-workspace/prd.md): a demo is a
new workspace every time, and the old one is retired rather than cleared. The
mechanism is not demo-specific — it takes any workspace — and the demo feature
that first needed it ships separately, calling what is here.

## Where the code lives

| Path | Role |
| --- | --- |
| `apps/api/src/durable-objects/object-retirement.ts` | The tombstone, the gate that wraps every callable method of a retired object, and the three dispositions. |
| `apps/api/src/durable-objects/scheduled-alarms.ts` | `retireObject` and `objectRetirementState` on the base every gated class extends, plus the alarm clearing retirement performs. |
| `apps/api/src/durable-objects/workspace-do.ts` | `beginWorkspaceRetirement`, `recordRetiredNode`, `workspaceRetirementProgress`, and the `workspace_retirement_graph` table behind them. |
| `apps/api/src/services/workspace-retirement-service.ts` | The pass that walks the recorded graph, closing children before parents, and the operator door in front of it. |
| `apps/api/src/routes/workspace-operations.ts` | `/internal/workspaces/:id/retire`, behind the operator credential in the `demos` role. |
| `apps/api/src/telemetry/operator-auth.ts` | The operator credential (`TELEMETRY_OPERATORS_JSON`), which now carries the `demos` role beside the telemetry roles, and `requireOperatorRole`, which every operator router narrows with. |
| `packages/contracts/src/workspace-retirement.ts` | The receipt a retirement answers with. |
| `packages/contracts/src/conversation-parent.ts` | `childrenForRetirement`'s three-way answer. |
| `apps/ace/src/regional-api.ts`, `apps/ace/src/client/workspaces.tsx` | Ace's relay to the regional route and the workspaces tab that calls it ([`ace.md`](ace.md)). |

## How it works

### The gate

A Durable Object has more doors than a helper each method remembers to call can
cover: native RPC, `fetch`, hibernated socket callbacks, and an `alarm` the
platform recovers after eviction all reach it without passing anything that
could say no. WorkspaceDO alone has roughly 229 methods and no shared dispatch
boundary.

So `applyRetirementGate` replaces every callable method on the prototype chain,
once, at module load. Prototype replacement rather than a proxy around the
instance is what survives real workerd, which dispatches to ordinary own
properties of a prototype. All five classes that can belong to a workspace —
`WorkspaceDO`, `ConversationParentDurableObject`, `WorkstreamDO`, `SidekickDO`
(deployed under the Cloudflare class name `AutomationDO`)
and `SubstreamAgent` — extend `ScheduledDurableObject`, so the tombstone and its
two entry points live there and each class declares only its exceptions.

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

1. **Enumerate, then close, in one call.** `beginWorkspaceRetirement` reads both
   directories while they still answer, writes each parent into
   `workspace_retirement_graph`, and writes the tombstone. Doing this in one call
   is what leaves no window in which a caller writes into a half-closed
   workspace.
2. **Clear every wake reason.** The same transaction deletes
   `_internal_durable_alarms`, and the platform alarm is deleted immediately
   after. Nothing re-derives it: the alarm coordinator's mutators are inert on a
   retired object.
3. **Walk children before parents.** `retireWorkspaceGraph` asks each parent for
   its children *before* retiring it — after, that read refuses — retires each
   child, retires the parent, and only then writes the node's receipt. It asks
   through `childrenForRetirement` rather than `listChildren`, because two of the
   three outcomes it has to act on differently arrive there as exceptions, and
   deciding between them by comparing an error message across an RPC boundary is
   one rename away from tombstoning a parent without walking its children.
4. **Finish when nothing is left unreceipted.** Completion is the workspace's own
   tombstone plus the absence of NULLs in the graph table, rather than a flag
   somebody sets. The tombstone is what says the enumeration happened: reading
   completeness from the row count alone confused "nothing recorded yet" with
   "nothing to record", so an empty workspace reported unfinished forever.

### The operator door

The walk infers nothing from an id, which is right for the walk and wrong for a
door: an id no workspace in this region owns would be "retired" as a set of
brand-new empty objects holding tombstones, and the operator told it succeeded
while the real workspace, in the other region, stayed open. So
`retireWorkspaceForOperator` checks the region's `workspaces` row first and
answers `workspace_not_found` otherwise. The route in front of it takes the
confirmation the page collected — the operator typed or pasted the id they are
closing — and refuses `workspace_retirement_unconfirmed` unless it names the
workspace in the path, rather than trusting the page to have asked.

The route sits behind the operator credential in a role of its own, `demos`,
which Ace holds one token per region for. Every operator router names the roles
it admits: the telemetry router refuses `demos`, and this router refuses the
telemetry roles, which is the only thing that makes a role an isolation.

## Invariants

- **Unclassified is refused.** A method nobody classified refuses on a retired
  object. A new RPC is fenced the day it is written, not the day somebody
  remembers this file.
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
  is being closed.
- **Retirement takes any workspace id, and infers nothing.** It is an operator
  action behind Ace's Access policy, and the only protection between an operator
  and an irreversible close is the confirmation the page asks for. A gate on a
  register of demo workspaces was built and then dropped, deliberately: the
  bookkeeping bought a second mechanism for a surface one Access policy already
  admits. The walk does not check a name, a register, or anything else.
- **The region is the running Worker's, never the caller's.** A region taken as a
  parameter does not cross a region — it builds an EU-shaped *name* and resolves
  it in the Global jurisdiction, creating brand-new empty objects, tombstoning
  them, and reporting success while the real workspace stays open and serving.
  The door adds the one check the walk does not: the id must be a workspace this
  region's table holds.
- **Every operator router names the roles it admits.** A role added to the
  credential map reaches no surface until a router names it.

## Boundary

This module owns closing a workspace and nothing else. It does not own how a
workspace is created (ordinary onboarding), how an object schedules itself
([`durable-object-alarms.md`](durable-object-alarms.md)), or how sockets are
closed when access ends ([`access-revocation.md`](access-revocation.md)).

The gate is a lifecycle policy, not an authorization system: it answers "is this
object still alive", never "may this caller do this". Every existing
authorization check still runs behind it.

Retirement is not deletion. Rows stay where they are; the tombstone is what stops
anything reading or draining them.

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
- **A parent the directory names whose object never materialized** is retired
  anyway. The call brings the object into existence holding only a tombstone,
  which fences an id a late create would otherwise take.
- **A failed node leaves retirement incomplete.** The walk continues to the rest
  and reports incomplete, so the next pass returns to exactly that node.

## Testing

| Suite | What it proves |
| --- | --- |
| `apps/api/test-workers/object-retirement.test.ts` | The gate on real workerd: refusal, permitted retirement, drop-and-acknowledge, alarm clearing, that all four object classes rebuild themselves after eviction and revoke access while retired, and a mechanical enumeration of each class's callable surface. |
| `apps/api/test-workers/workspace-retirement-graph.test.ts` | The graph is captured before the tombstone, is idempotent and resumable, an empty workspace reports closed, and the walk closes children before parents. |
| `apps/api/test/workspace-operations.test.ts` | Against the real migrations: the route admits only the `demos` role, and refuses a retirement whose confirmation names another workspace or whose id this region does not own. |
| `apps/api/test/telemetry-operator-routes.test.ts` | The `demos` role is refused at the telemetry router, on every route. |
| `apps/api/test/durable-object-initialization-wiring.test.ts` | `SubstreamAgent`'s recovery attempt stays a prototype method. |
| `apps/api/test/workspace-runtime-database.test.ts`, `apps/api/test/workstream-object-schema.test.ts` | Retirement's tables are declared to the schema guards. |
| `apps/ace/test/workspaces.test.ts`, `apps/ace/test/workspaces-client.test.tsx` | Ace's relay refuses an unconfirmed retirement before asking the region and carries the confirmation when it does; the tab's typed confirmation, its receipt, and a failed search shown as a failure. |

Two of these were written wrong first and are worth knowing about. The gate's
original tests all passed with the gate disabled, because every assertion was
answered from an in-memory cache and none of them read the stored tombstone; the
test that replaced them writes the row underneath the object so the storage read
is the only path. And the walk's ordering test retired zero children for its
first few days, because nothing had registered one — the assertion it was named
for could not fail, and the parent-missing branch it was actually exercising is
the one that skips the children entirely.

The eviction test covers all four object classes in one case on purpose. Both
failures it exists for were category failures found one class at a time, and
neither is visible from a single class: `WorkstreamDO` reaches its own helpers
from its constructor, and `SubstreamAgent` recovers after the construction window
closes, which is the case a construction-only fix does not reach.

## Data model

| Where | Table | Holds |
| --- | --- | --- |
| Every gated object's SQLite | `object_retirement` | One row. The tombstone: instant, operation, actor, reason. |
| WorkspaceDO SQLite | `workspace_retirement_graph` | One row per parent, with a nullable `retired_at` receipt. |

The tombstone lives in the object rather than D1 because the gate answers during
constructor recovery, before anything cross-authority could be consulted. Both
tables arrive through each object's own append-only migration ledger, from one
shared constant, as `_internal_durable_alarms` does. There is no D1 row for a
retirement: a caller that needs to know a workspace is closed asks the object,
and a feature that needs a regional shadow of that fact writes its own.

## Regional impact

Retirement resolves every object through the running Worker's own region,
refuses to take one from a caller, and refuses an id the region's `workspaces`
table does not hold, so there is no path by which a Global invocation reaches an
EU workspace or the reverse. Ace reaches each region's public API over HTTPS
with that region's own operator token; the regional relay is recorded as an
exception in [`regionalization.md`](regionalization.md).

## Security and trust model

Retirement is irreversible and takes any workspace id. Nothing in this module
authorizes it: the Ace Access policy admits the operator, and the page's
confirmation — one that makes the operator name the workspace rather than click
beside it — is the whole of the protection, enforced by Ace and again by the
regional API. The regional door adds one check the walk deliberately does not:
the id must name a workspace this region's `workspaces` table holds, so an id
the other region owns is refused rather than "retired" as a set of new empty
objects.

The operator credential's `demos` role is one token per region, held by that
region's `TELEMETRY_OPERATORS_JSON` and by Ace as that region's secret, and by
nobody else: an operator credential never crosses regions, so a leak of one is
destructive authority in one jurisdiction rather than both. Every operator
router names the roles it admits, which is the only thing that makes a role an
isolation: the telemetry router refuses `demos`, and this router refuses the
telemetry roles.

## Open questions

- **Access revocation on retirement.** Sessions into a retired workspace are not
  revoked; retirement closes every socket through the objects instead, so a
  session that survives it can open nothing. Revoking them needs a retirement
  `reason` value the revocation mechanism accepts and a per-member fan-out it
  does not have today.
- **Nothing re-invokes an interrupted walk.** See **Failure modes and limits**;
  a schedule behind it is a decision about what retirement is for beyond the
  workspaces it was built for.

## Changelog

### 2026-09-08 — Retirement ships on its own

**What changed:** This module is split out of the demo-workspace branch and
lands ahead of it, with its own document. The route moved to
`routes/workspace-operations.ts`, the receipt's contract to
`contracts/workspace-retirement.ts`, and Ace's relay to `regional-api.ts`.
The walk no longer writes a regional shadow of the tombstone: the demo
register that read it arrives with the demo feature, which restores that
write when it lands. Entries below that mention a register describe the
combined branch as it was written.

**Why:** The gate wraps every method of every object class that can belong to
a workspace, and the demo feature that first needed it is ten thousand lines
that nothing runs until an operator starts a demo. Reviewed and observed
together, the one change with a production footprint would have been hidden
under the one without; apart, the gate merges with nothing calling it yet, so
its only effect is the negative tombstone check and the schema steps — which
is exactly what is worth watching on its own before anything closes a
workspace.

**Considered and rejected:** Landing the gate inside the demo PR after all —
the reason above. Archiving instead of retiring, using the abandonment row the
product already has — it closes every door through the API and the sockets
but reaches nothing inside the objects, so a room's alarm still fires and a
Queue still redelivers to it; acceptable for a demo, and still an option if
"permanently quiet" turns out to matter less than the blast radius here.

**Consequences:** `retireWorkspaceGraph` takes no `completedAt` and writes no
D1 row; a feature that wants a regional record of a closed workspace writes
it after the receipt reports complete. The tombstone is conversation-object
schema v46 (the loop's mark, v45, lands first), WorkspaceDO 39 with the graph
at 40, WorkstreamDO 8, and Sidekick 5 — renumbered once on rebase after `main`
took the earlier numbers.

### 2026-09-07 — Review: the door checks the region, and every router names its roles

**What changed:** `retireWorkspaceForOperator` refuses an id the region's
`workspaces` table does not hold. `requireOperatorRole` takes every role a
router admits, and the telemetry router names `support` and `security`, so
`demos` is refused there. Ace holds one operator token per region,
`RALLY_OPERATOR_TOKEN` and `RALLY_EU_OPERATOR_TOKEN`.

**Why:** A review swarm on the finished feature. The walk deliberately infers
nothing from an id, which left the door in front of it able to "retire" an id
the other region owned as a set of brand-new empty objects and report
success. The `demos` role reached three telemetry routes because only the new
routers narrowed by role. A shared token was destructive authority in both
jurisdictions from one leak.

**Considered and rejected:** Region-binding the operator principal instead of
two tokens — a second secret is the smaller change and matches the per-region
rule `security.md` already states.

**Consequences:** Adding an operator router means naming its roles. A wrong
region is a refusal, not a phantom retirement.

### 2026-09-05 — Any workspace can be retired

**What changed:** `retireWorkspaceGraph` no longer consults a register of
demo workspaces; `isRetirableDemoWorkspace` and its refusal are gone.

**Why:** From review. The register-as-authorization was bookkeeping for a
surface that one Access policy already admits, and an operator tool that can
retire *any* workspace is what was actually wanted.

**Considered and rejected:** Keeping the register check as a soft warning —
either it blocks or it is noise.

**Consequences:** The confirmation in Ace is the only thing between an operator
and an irreversible close of a customer workspace; build it to make the operator
type or paste the id.

### 2026-09-05 — A permit is a call, not a method name

**What changed:** A permitted method now runs against a view of its own instance
with the gate lifted, so the whole call beneath it is unfenced. The construction
window became a depth counter opened by `initializeDurableObject` itself;
`SubstreamAgent`'s runtime recovery became a prototype method; dispositions
resolve per instance at call time; a policy entry naming a method its class does
not have throws at load; the negative tombstone answer is cached. Retirement now
takes its region from the Worker rather than the caller, reports an empty
workspace complete, and asks each parent for its children through an RPC that
answers "missing" and "identity mismatch" instead of throwing them.

**Why:** The first version could not express the one thing it needed to. A permit
was a method name, so every permitted entry point refused itself on the first
private helper it reached — `revokeSocketAccess` on all three classes that have
it, `syncAgentTimerAlarms` on every rebuilt `SubstreamAgent`, and three found
before those. In production that is the region-wide access-revocation queue
dead-lettering one message per retired object, and a retired workspace becoming
permanently unreachable within minutes of going idle, taking operator inspection,
the resumable walk, and every drop with it. Five instances of one defect,
discovered one at a time, is a mechanism that cannot state its own requirement.

**Considered and rejected:** Naming the helpers — that is what failed, five
times, and the list can only ever be as complete as the last person to trace a
call graph by hand. A re-entrancy flag set on entry to a permitted method — the
original objection stands: a flag is visible to whatever the runtime admits while
that method is awaiting, and a product call could take it. Gating only the doors
a caller can reach — TypeScript's `private` is not a runtime fact, so every
helper is reachable over RPC and "door" is not a distinction the runtime can
make.

**Consequences:** A new permitted entry point needs no call-graph audit, but a
permitted method now runs its whole tree unfenced, so permitting something that
writes product state is a real mistake rather than a partial one. Anything that
opens `initializeDurableObject` is inside the construction window for its whole
duration. A closure the constructor binds cannot be reached by a permit, so
recovery-shaped work belongs on the prototype. Callers no longer pass a region.

### 2026-09-05 — A retired object refuses at every door, not at the edge

**What changed:** New module. A permanent tombstone in each object's own SQLite,
a class-level gate wrapping every callable method of the five classes that can
belong to a workspace, a recorded object graph captured before the tombstone,
and a resumable walk that closes children before parents.

**Why:** The spike this was built on retired a workspace with a straight-line
best-effort walk and found two things it could not fix from outside. The
refusal it managed to observe came from `SubstreamAgent`, and the outbox it
stranded belonged to a `WorkstreamDO` — both objects that a product write
reaches without passing WorkspaceDO at all. And an alarm on one retired object
re-armed after traffic, because clearing an alarm does not stop the code that
re-derives it. A check at the edge, or a helper each method is expected to
call, addresses neither.

**Considered and rejected:** A `Proxy` around the instance — workerd dispatches
to prototype properties, so the proxy is not in the path. A per-method helper —
229 methods on WorkspaceDO alone, and the failure mode is a method somebody
forgot. A re-entrancy escape so permitted methods could call refused ones — that
is a hole a product call could take, and the cost of not having it is that
retirement's own helpers are listed explicitly, which is loud rather than silent.
Gating on the workspace name ending in `-demo` — wrong in both directions, and
the PRD rules it out. Draining stranded outbox rows — publishing out of a closed
workspace. Deleting them — deciding whose they now are.

**Consequences:** Adding a method to any of the five gated classes fences it by
default; an effect receiver added without a `drop` entry will refuse and strand
its Queue message, so new receivers must be classified. A permitted method that
calls an unlisted private helper throws the first time retirement runs. The
alarm coordinator's mutators are inert on a retired object, so code that assumes
`armNextAlarm` always arms is wrong there.

Design: `docs/PRDs/2026-09-04_demo-workspace/prd.md`.
