# Durable Object self-referencing RPC audit — 2026-08-22

## Executive summary

Two Durable Object classes addressed themselves through their own namespace:
**`SubstreamAgent`** and **`WorkspaceDO`**. `WorkstreamDO`,
`BlockDashboardAgent`, and the tracker's `MigrationRegistry` did not.

Not one of the twelve paths was written as a self-call. Each one is a shared
Worker-side helper — the runtime-SQL ports, `publishWorkstreamEvent`,
`launchWorkstreamHarness`, `refreshAgentTimerAlarm`, `refreshWorkspaceSchedule`,
digest settlement — that addresses an object by *role*: "the agent that owns this
work stream", "the WorkspaceDO for this workspace". That is exactly right for the
Worker, queue consumer, or Workflow that is almost always calling it. It became a
self-call as the objects grew inward: a work stream's whole agent loop now runs
inside its `SubstreamAgent`, and since #226 deleted the workspace scheduler, a
workspace's schedule runs inside its `WorkspaceDO`. The same helpers now run
*inside* the object they are addressing, and each call left it over RPC and came
straight back in.

The repository had been closing these one at a time — an in-object runtime-SQL
executor, then an in-object Terminal port — and each round left the rest. The fix
in this change is the general one: an object registers itself, and the resolver
recognizes its own name. **All twelve are fixed.** The findings below are kept as
the record of what was wrong and why, with the resolution at the end.

> **2026-08-24.** A thirteenth path — the tool-receipt port, written the same day
> as this audit and never walked by it — took a work stream down in production,
> and in doing so disproved this report's judgement that a self-call is a hazard
> rather than an outage. [The follow-up](#follow-up-2026-08-24-the-thirteenth-path-and-what-it-disproved)
> at the end has the evidence and what changed.

## What counts as a finding

A self-referencing RPC is a call, made while executing inside a Durable Object,
that resolves a stub in **that object's own binding** with **that object's own
name** and invokes a method on it. Jurisdiction, binding, and name together
determine identity ([`workstream-durable-object.md`](workstream-durable-object.md#object-hierarchy-and-identity)),
so a call to a *sibling* of the same class — a different work stream, a different
workspace — is a normal cross-object hop and is not listed here.

For `SubstreamAgent`, `substreamAgentName()` defaults `substreamId` to `"0"`, and
the main conversation is external substream `0`, whose object name is the work
stream's own name. So every helper below, called from the main agent for its own
work stream, addressed the object it was already running in. On a hypothetical
non-main substream the same helper would address the main agent instead — a
sibling, not a self-call, and a second bug rather than a mitigation.

## Method

- Every stub in this codebase is resolved through
  `apps/api/src/lib/durable-object-namespace.ts`; `scripts/eslint-rules/durable-object-region-routing.mjs`
  rejects direct namespace construction, so enumerating the resolver's call sites
  enumerates all of them.
- Each site was tagged with the binding it resolves, then the module import graph
  under `apps/api/src` was walked from each Durable Object class to find sites
  reachable from it in its own binding.
- Every reachable site was then read to decide whether the object actually
  reaches it *at runtime* and with which name. Several candidates were rejected
  this way: `socket-service.ts` (the edge upgrade path only), and
  `workstream-object-client.ts` / `workstream-object-creation-service.ts`, which
  are only ever constructed with a request-scoped `auth` and never inside the
  agent.

## Findings

Line numbers are as of `ae7e504`, the commit this was verified against.

### 1. Runtime SQL: an object asked itself to run its own SQL

**The general defect, and the source of 1a–1f.** `withWorkstreamRuntimeDatabase`,
`workstreamExecutionEnvironment`, and `bootstrapWorkstreamRuntimeEnvironment`
(`services/workstream-runtime-database.ts`) each build a D1-compatible port whose
`executeLocal` resolves the owning `SubstreamAgent` and calls `executeRuntimeSql`
or `bootstrapRuntime`; `withWorkspaceRuntimeDatabase` does the same against
`WorkspaceDO`. Both take an optional local executor that skips the hop, and both
objects supply one — `SubstreamAgent.localRuntimeEnvironment`
(`substream-agent.ts:2074`) and `WorkspaceDO.localWorkspaceEnv`
(`workspace-do.ts:1293`), the latter with a comment saying in as many words that
routing back through the namespace "would have the object call itself".

**The executor was not inherited.** Anything that built its own execution
environment got the RPC path, even when handed an environment that already
carried a local one, because `withWorkstreamRuntimeDatabase` constructed a fresh
port with `localExecutor` undefined.

| # | Entry point | Path to the self-call |
| --- | --- | --- |
| 1a | `SubstreamAgent` alarm → `fireWorkstreamWakeup` (`substream-agent.ts:2541`) | `launchWorkstreamHarness` re-wraps the environment (`workstream-service.ts:173`), so every admission statement — the supersede update, the `harness_runs` insert, `scheduledWorkstreamModelForExisting` — became a separate RPC into this object |
| 1b | `SubstreamAgent` post-run → `refreshWorkstreamName` (`:1968`) | `runStructuredInference` → `resolveAgentModelRouting` → `loadFlagTargetingAttributes` → `workstreamFacts` (`flag-targeting-attributes.ts:277`) builds an execution environment to read one `workstreams` row |
| 1c | `SubstreamAgent` post-run → `refreshWorkstreamDescription` (`:1972`) | same chain as 1b; the description service passes `workstreamId` in its inference context |
| 1d | `SubstreamAgent` run admission, in its own product layer | `workstream-object-product.ts` calls `resolveAgentModelRouting` with a `workstreamId`, reaching the same `workstreamFacts` path |
| 1e | `SubstreamAgent.deliverAgentRunResult` → `settleDigestRun` (`:1998`, passing raw `this.env`) | `digest-run-settlement.ts:235` builds an execution environment for the same work stream |
| 1f | `WorkspaceDO` alarm → any maintenance task (`workspace-schedule-execution.ts:208–217`) | each is handed `ctx.workspaceEnv`, which *had* a local executor, and several then call `withWorkspaceRuntimeDatabase(env, workspaceId)` themselves — `reapSettledWorkspaceNotificationIntents` is the plainest — which discarded it and went back out through the namespace |

**Effect.** Each statement became a namespace resolution plus an RPC round trip —
including a D1 read for placement affinity on a cold isolate cache — to reach
SQLite the caller was already holding. It could not join the caller's
`transactionSync`, so a read-then-write that read locally and wrote through the
port was no longer one critical section. A failure arrived as
`workstream_runtime_sql_failed` from a foreign object rather than as a local
exception.

**Note on 1b–1d.** These fire only when `env.FLAGS` is bound; without Flagship,
`resolveAgentModelRouting` returns the fallback before touching targeting
attributes. So that path was quiet in local development and live in staging and
production.

### 2. Realtime publishing: the agent asked itself to broadcast

`publishWorkstreamEvent` and `publishPersonalWorkstreamEvent`
(`integrations.ts:1957–1999`) resolve the owning agent and call `publishEvent`.
Inside the agent, `this.broadcast` / `publishAgentRuntimeEvent` already does this
locally.

| # | Entry point | Path to the self-call |
| --- | --- | --- |
| 2a | alarm → `fireWorkstreamWakeup` | `appendWakeupSystemMessage` → `publishWorkstreamEvent` (`workstream-service.ts:479`) |
| 2b | same | `launchWorkstreamHarness` publishes twice more (`workstream-service.ts:322`, `:335`) |
| 2c | post-run → `refreshWorkstreamName` | `advanceTitle` → `publishWorkstreamEvent` (`workstream-naming-service.ts:333`) |
| 2d | a harness tool call (`substream-agent.ts:1761`) | the elicitation tool publishes `elicitation_created` (`integrations.ts:6683`) |

**Effect.** A local broadcast replaced by a round trip whose result was then
discarded — both publish helpers swallow their own failures by contract. The
agent's own event ordering depended on a second invocation of itself interleaving
with the one that produced the event.

**Deliberately not on this list:** the streaming-delta publisher
(`integrations.ts:2246`). `SubstreamAgent` passes `publishRealtime: false` and
hands its own local `publishAgentRuntimeEvent` as the `onEvent` callback. That was
the existing, correct guard — it just was not extended to 2a–2d.

### 3. Agent timers: the agent asked itself to re-arm its own alarm

`refreshAgentTimerAlarm` (`workstream-wakeup-service.ts:645`) resolves the owning
agent and calls `refreshTimerAlarm`, whose handler validates identity and then
calls `this.scheduleNextAlarm()`. The agent's timer tools call it three times
inside `createRallyTools` (`integrations.ts:6419`, `:6467`, `:6579`), which runs
inside the harness, which runs inside the agent.

**Effect.** A round trip to reach a private method on the object making the call.
The identity check in the handler was checking the object against itself.

### 4. Run dispatch: the agent asked itself to queue a run

`launchWorkstreamHarness` calls `dispatchRun` on the owning agent
(`workstream-service.ts:282`), as does `startWorkstreamWorkflow`
(`integrations.ts:1837`). Reached from the alarm through `fireWorkstreamWakeup`,
the target was this object: the alarm handler RPC'd into itself to insert a row in
`agent_run_dispatches` and arm an alarm, then returned to `alarm()`, which drained
that row.

### 5. Workspace scheduling: the workspace asked itself to re-arm

`refreshWorkspaceSchedule` (`workstream-wakeup-service.ts:625`) resolves the
workspace object and calls `refreshSchedule`. It is reached from inside
`WorkspaceDO`'s own alarm through the Terminal sandbox coordinator
(`terminal/plugin.ts:62`) and through the notification-intent settlement in
`workstream-regional-effect-service.ts`.

Everything else the moved schedule code reaches — `recordActivityEvent`,
`connectorEvent`, `applyWorkstreamDirectoryEffects`, `lookupWorkstreamDirectory`,
`publishSync`, `enqueueOpportunitySource`, `resourceAccess`,
`notificationDirectoryState`, `opportunityOriginEvents` — is the same shape: a
service resolving `WORKSPACE_DOS` for the workspace whose object is calling it.

## How dangerous was this

Honestly: a correctness *hazard* and a real cost, not an active outage.

**This assessment was wrong, and the follow-up below says how.** It is left as
written because the reasoning is where the error is: it asked whether one
self-call completes, and every one of them does. It never asked what a hundred of
them in a single invocation do to the platform's own limits.

**Not a deadlock as it stood.** A Durable Object's input gate stays open while an
invocation awaits non-storage I/O, so these self-calls were delivered as a second
concurrent invocation and completed. The one place that is not true is
`blockConcurrencyWhile`, and both classes use it only in their constructors,
which reach none of these paths. That is the invariant the whole list rested on,
and nothing in the code stated or tested it. Any future self-call added inside a
`blockConcurrencyWhile`, or any handler that came to wait on work the outer
invocation owned, would hang the object until the duration limit — which is
precisely the shape of the alarm-joins-drain fault recorded in
[`terminal-production-qa-2026-08-21.md`](terminal-production-qa-2026-08-21.md).

What was being paid for:

- **Throughput against a soft limit.** One Durable Object is single-threaded and
  tops out near 1,000 requests/second ([`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md#the-limits-that-decide-the-argument)).
  A busy object competed with itself for its own thread.
- **Subrequests**, spent on work that needs no subrequest at all.
- **Lost transactional locality.** A statement routed out and back cannot join a
  `transactionSync` in the calling invocation.
- **Re-entrancy the code does not model.** The second invocation observed and
  mutated the same SQLite while the first was mid-flight.
- **Worse diagnostics.** Local invariant violations surfaced as foreign-object
  failures, which is what made the fault above expensive to localize.
- **A routing dependency on D1.** `durableObjectStubForWorkspace` reads the
  workspace's placement affinity and fails closed in staging and production, so
  an object could fail to reach *itself* because a D1 read failed.

## Resolution

Fixed in the same change as this report, in two parts.

**An object recognizes its own name.** Every Durable Object class registers
itself in its constructor with `apps/api/src/lib/durable-object-self.ts` — the
binding it answers on, a thunk for its own deterministic name, its id, and the
instance — and both stub resolvers consult that registration first. When the name
being resolved is the caller's own, the resolver returns a stand-in stub over the
object itself: the same method, the same arguments, no request leaving the
isolate, and no placement-affinity read. Any other name still resolves through
the namespace, and so does every name until the object has an identity to compare
against. The registration rides on `env`, which is how it reaches helpers several
layers below the object that never hear about it, and `env` cannot leave the
isolate — a Queue message and a Workflow parameter are both serialized — so a
registration cannot outlive the object that made it.

**The local SQL executors are inherited.** `withWorkspaceRuntimeDatabase` and
`withWorkstreamRuntimeDatabase` now carry the executor they are given on the
environment they return, and reuse it when a later caller derives an execution
environment for the same workspace, work stream, and substream without supplying
one. A different work stream or workspace never borrows it. This keeps the hot
path — per-SQL-statement — a direct function call rather than a direct call
through the object's own RPC envelope.

Between them: finding 1 is fixed by both (inheritance where an environment is
threaded, the resolver everywhere else); findings 2 through 5 by the resolver.
All four Durable Object classes are registered, including the two that had no
self-call, so the next path added is covered before it is written.

The tests come in two halves, because the mechanism does.

`apps/api/test/durable-object-self-reference.test.ts` proves the routing
decision, which is plain JavaScript: the object's own name resolves locally,
while a sibling's name, the same name under another binding, an absent binding,
and any name before the object has an identity all still resolve through the
namespace. It also proves the inherited executor is never lent to a different
work stream or workspace, and that a name is withheld until *both* of an agent's
durable facts — its work stream and its external substream id — are recorded.

`apps/api/test-workers/durable-object-self-registration.test.ts` proves the other
half on real workerd: that each of the four classes actually registers in its
constructor, and that its name thunk derives the name a shared helper would
resolve from identity written to its own storage. That half was covered only
incidentally before, and incidental coverage is what let the product service keep
an unregistered environment through the first draft of this change — so the last
case there asserts that the collaborators an object builds and keeps hold a
registered environment too, not just the object itself.

**What a future change has to respect.** A new Durable Object class registers
itself in its constructor, or it is silently exempt. A name thunk must return
`null` until the object's identity is durably its own, because a name derived too
early is a name for a different object. The comparison is binding identity plus
name equality, which is what keeps a genuine sibling call a genuine hop. And the
registration line rebinds the constructor's `env` parameter, not just the field:
the first draft of this fix handed the raw parameter to
`WorkstreamObjectProductService`, which kept it for the object's whole life and
left finding 1d in place.

## Scope checked

| Class | Binding | Self-referencing RPC found | Registered |
| --- | --- | --- | --- |
| `SubstreamAgent` (`apps/api/src/durable-objects/substream-agent.ts`) | `SUBSTREAM_AGENTS` | Yes — findings 1–4 | Yes |
| `WorkspaceDO` (`workspace-do.ts`) | `WORKSPACE_DOS` | Yes — findings 1f and 5 | Yes |
| `WorkstreamDO` (`workstream-do.ts`) | `WORKSTREAM_DOS` | No | Yes |
| `BlockDashboardAgent` (`block-dashboard-agent.ts`) | `BLOCK_DASHBOARD_AGENTS` | No | Yes |
| `MigrationRegistry` (`apps/migration-tracker/src/registry.ts`) | `MIGRATION_REGISTRY` | No — only the Worker resolves it | Not applicable |

`WorkspaceScheduler` was a sixth class when this audit began and had no
self-referencing RPC; #226 deleted it and moved its work into `WorkspaceDO`,
which is how findings 1f and 5 came to exist.

## Follow-up 2026-08-24: the thirteenth path, and what it disproved

Two days after this report, work stream `01a031cd-2145` failed mid-run with
`tool_receipt_persistence_failed`, and underneath it
`D1_ERROR: Subrequest depth limit exceeded`.

The run's trace is one `SubstreamAgent` alarm invocation, 19.7 s long, holding
93 D1 calls, 27 `executeRuntimeSql` RPCs to `WorkspaceDO` — and **fifteen
`executeToolReceiptOperation` RPCs to its own object id**, sequential, each
beginning as the previous returned. From the fifteenth on, every outbound
subrequest from that invocation was refused: the membership read, the analytics
writes, the connector reauthorization the run needed to continue. The run ended
with only the model's preamble in the transcript and no answer. The next run in
the same work stream, on the same deployed script version, made no self-calls at
all and completed in 48 s.

**What the audit missed.** `runtime/tool-receipt-port.ts` was written on
2026-08-22, hours from this report, and is a fourteenth method reachable as a
self-call — the exact shape the report's own "Considered and rejected" section
predicted when it argued against threading a local port per method: *the next
method added would silently reintroduce the defect*. It was, in the same day.

**What the audit got wrong.** The resolution rests on name recognition, and the
report states plainly that resolution falls back to the namespace "until the
object has an identity to compare against", treating that window as a routing
detail. It is not: in that window an object's own name resolves through the
namespace to the object itself, so every call is a self-call, and self-calls do
not unwind. The section above judged the cost as throughput and diagnostics. The
missing cost is that they *accumulate against a platform limit that ends the
invocation* — and the run that hits it is not slow, it is dead.

**What changed.** Two things, in one change, recorded with their reasoning in
[`workstream-durable-object.md`](workstream-durable-object.md):

- **Receipts are held, not resolved.** The object carries its own
  `WorkstreamToolReceiptStorage` on the execution environment a run is handed,
  keyed by workspace and work stream and installed only where the wire endpoint
  would also have answered. Every port built below it — including the ones built
  five layers down — reaches storage directly. This is the same seam the two SQL
  routers and the Terminal port already use; receipts are the fourth authority to
  take it. *(The next day this became one registry for every authority, in
  `runtime/local-authorities.ts`; see the follow-up below.)*
- **A self-addressed stub is an error in the log.** The three resolvers compare
  the id they are about to reach against the caller's own registration and log
  `durable_object_self_addressed_over_rpc` when they match, naming the resolver,
  the requested name, and the name the object could not answer to. That last
  field is the diagnosis: `null` there means a registration existed and the name
  was withheld, which is the only way a resolution reaches its own id at all.

**What this leaves open.** Which of the two durable facts was missing during the
failing run is not established — it needs a read of that object's storage at that
moment, which no longer exists. It stopped mattering the next day.

## Follow-up 2026-08-25: the resolution's own premise, replaced

The fix above closed the thirteenth path. This closes the reason there could be
a fourteenth.

**Recognition no longer reads a name.** This report's resolution compares the
name being resolved with a thunk for the object's own, and states plainly that
resolution falls back to the namespace "until the object has an identity to
compare against". That fallback is the incident: inside that window an object's
own name resolves through the namespace to the object itself, and self-calls
accumulate against a platform limit. It is gone. A resolver now derives the id
the name resolves to — a hash, no I/O — and compares it with `state.id`, which
every object has had since its constructor with its jurisdiction already
asserted. There is no window, because there is nothing to be missing. The rule
this report added — *a name thunk must return `null` until the object's identity
is durably its own* — still holds for names, and no longer decides any routing.

**The registration is a backstop, not the mechanism.** `local-authorities.ts`
now installs everything an object owns about a work stream — its SQL, its
receipts, its Terminal — on the environment a run is handed, so a run reaches
them by holding them. Three of the twelve paths in this report were closed by
inheritance rather than by the resolver; that is now the general answer, and
recognition is what catches the rest.

**A self-address the routing cannot see is refused.** Every stub comes from
`durableObjectStubForRegion`, and it throws in development and test when the id
it is about to reach belongs to the caller, logging
`durable_object_self_addressed_over_rpc` at error in staging and production
instead. This report could not have found the receipt path, because the path did
not exist when it was written; that is exactly the case a standing check exists
for.

The reasoning, the alternatives, and what a future change has to respect are
recorded with the code in
[`workstream-durable-object.md`](workstream-durable-object.md).
