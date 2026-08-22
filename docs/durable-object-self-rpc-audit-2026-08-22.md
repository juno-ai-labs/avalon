# Durable Object self-referencing RPC audit — 2026-08-22

## Executive summary

Every self-referencing Durable Object RPC in this repository belongs to one
object class: **`SubstreamAgent`**. `WorkspaceDO`, `WorkstreamDO`,
`BlockDashboardAgent`, `WorkspaceScheduler`, and the tracker's
`MigrationRegistry` never resolve a stub in their own binding, directly or
through anything they call.

Not one of the twelve `SubstreamAgent` cases is written as a self-call. Each one
is a shared Worker-side helper — the runtime-SQL port, `publishWorkstreamEvent`,
the Terminal port, the agent-timer refresh — that resolves *the owning agent for
this work stream* by name. That is exactly right when a Worker, a queue
consumer, or the scheduler calls it. It becomes a self-call when the caller is
already inside that agent, which is now the normal case: the agent runs the
whole harness in-object, then calls the same helpers on the way out.

The object already has the seam that fixes this. `createTerminalObjectPort` takes
a `localStorage` override and `workstreamRuntimeDatabase` takes a `localExecutor`,
and `SubstreamAgent.localRuntimeEnvironment` uses the latter for the SQL it
issues itself. The gap is that the seam is applied at the agent's own top-level
entry points only; the moment control passes into a helper that re-derives an
execution environment or publishes an event, the local path is lost and the call
goes out over RPC and back into the same object.

**No code was changed.** This audit is a finding list only, as asked.

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
work stream, addresses the object it is already running in. On a hypothetical
non-main substream the same helper would address the main agent instead — a
sibling, not a self-call, and a second bug rather than a mitigation.

## Method

- Every stub in this codebase is resolved through
  `apps/api/src/lib/durable-object-namespace.ts`; `scripts/eslint-rules/durable-object-region-routing.mjs`
  rejects direct namespace construction, so enumerating the resolver's call sites
  enumerates all of them. There are 72, across 35 modules.
- Each site was tagged with the binding it resolves, then the module import graph
  under `apps/api/src` was walked from each Durable Object class to find sites
  reachable from it in its own binding.
- Every reachable site was then read to decide whether the object actually
  reaches it *at runtime* and with which name. Four candidates were rejected this
  way: `socket-service.ts:423` (edge upgrade only), `workstream-object-client.ts`
  and `workstream-object-creation-service.ts` (constructed only with a
  request-scoped `auth`, never inside the agent), and
  `workstream-wakeup-service.ts:629` for `WorkspaceScheduler` (module-reachable,
  but no function the scheduler calls reaches it — the scheduler's own refresh is
  the direct `this.refresh(workspaceId)` at `workspace-scheduler.ts:684`).

## Findings

All paths below start inside `SubstreamAgent` and end on `SubstreamAgent`, same
object. Line numbers are as of `7ab37d8`.

### 1. Runtime SQL: the agent asks itself to run its own SQL

**The general defect, and the source of findings 1a–1e.** `withWorkstreamRuntimeDatabase`,
`workstreamExecutionEnvironment`, and `bootstrapWorkstreamRuntimeEnvironment`
(`services/workstream-runtime-database.ts`) each build a D1-compatible port whose
`executeLocal` resolves the owning `SubstreamAgent` and calls `executeRuntimeSql`
(`:209–232`) or `bootstrapRuntime` (`:428–437`). The optional `localExecutor`
skips that, and `SubstreamAgent.localRuntimeEnvironment` (`substream-agent.ts:1934–1959`)
supplies one that runs the statements against `this.state.storage` directly.

The local executor is not inherited. Anything the agent calls that builds its own
execution environment gets the RPC path, even when handed an env that already had
a local one — `withWorkstreamRuntimeDatabase` constructs a fresh
`WorkstreamRuntimeDatabase` with `localExecutor` undefined and proxies `DB` to it.

| # | Entry point in the agent | Path to the self-call |
| --- | --- | --- |
| 1a | `alarm()` → `fireNextAgentTimer` (`substream-agent.ts:1961–1978`) | `fireWorkstreamWakeup` → `launchWorkstreamHarness` (`workstream-service.ts:173`) re-wraps the env, so every admission statement in that function — the supersede update, the `harness_runs` insert, `scheduledWorkstreamModelForExisting` — is a separate RPC into this object |
| 1b | post-run settlement → `refreshWorkstreamName` (`substream-agent.ts:1828`) | `runStructuredInference` → `resolveAgentModelRouting` (`agent-model-flags.ts:153`) → `loadFlagTargetingAttributes` → `workstreamFacts` (`flag-targeting-attributes.ts:272–277`) builds an execution env to read one `workstreams` row |
| 1c | post-run settlement → `refreshWorkstreamDescription` (`substream-agent.ts:1832`) | same chain as 1b; the description service passes `workstreamId` in its inference context (`workstream-description-service.ts:425–427`) |
| 1d | run admission and model selection inside the agent's own product layer | `workstream-object-product.ts:444` and `:1902` call `resolveAgentModelRouting` with a `workstreamId`, reaching the same `workstreamFacts` path |
| 1e | `deliverAgentRunResult` → `settleDigestRun` (`substream-agent.ts:1858`, passing raw `this.env`) | `digest-run-settlement.ts:235` builds an execution env for the same work stream |

**Effect.** Each statement becomes a full namespace resolution plus an RPC round
trip — including a D1 read for placement affinity on a cold isolate cache — to
reach SQLite the caller is already holding. It cannot join the caller's
`transactionSync`, so a read-then-write that reads locally and writes through the
port is no longer one critical section. A failure arrives as
`workstream_runtime_sql_failed` from a foreign object rather than as a local
exception.

**Note on 1b–1d.** These fire only when `env.FLAGS` is bound; without Flagship,
`resolveAgentModelRouting` returns the fallback before touching targeting
attributes. So this path is quiet in local development and live in staging and
production.

### 2. Realtime publishing: the agent asks itself to broadcast

`publishWorkstreamEvent` (`integrations.ts:1957–1978`) and
`publishPersonalWorkstreamEvent` (`:1981–1999`) resolve the owning agent and call
`publishEvent`. Inside the agent, `this.broadcast` / `publishAgentRuntimeEvent`
already does this locally.

| # | Entry point in the agent | Path to the self-call |
| --- | --- | --- |
| 2a | `alarm()` → `fireNextAgentTimer` | `fireWorkstreamWakeup` → `appendWakeupSystemMessage` → `publishWorkstreamEvent` (`workstream-service.ts:479`) |
| 2b | same | `launchWorkstreamHarness` publishes twice more (`workstream-service.ts:322`, `:335`) |
| 2c | post-run settlement → `refreshWorkstreamName` | `advanceTitle` → `publishWorkstreamEvent` (`workstream-naming-service.ts:333`) |
| 2d | harness tool call (`runWorkstreamHarness` at `substream-agent.ts:1634`) | the elicitation tool in `createAvalonTools` publishes `elicitation_created` (`integrations.ts:6663`) |

**Effect.** A local `broadcast` is replaced by a round trip whose result is then
discarded — both publish helpers swallow their own failures by contract. The
agent's own event ordering now depends on a second invocation of itself
interleaving with the one that produced the event.

**Deliberately not on this list:** the streaming-delta publisher at
`integrations.ts:2246–2248`. `SubstreamAgent` passes `publishRealtime: false`
(`substream-agent.ts:1638`) and hands its own local `publishAgentRuntimeEvent` as
the `onEvent` callback. That is the existing, correct guard — it just was not
extended to 2a–2d.

### 3. Terminal operations: the agent asks itself to touch its own tables

`createTerminalObjectPort` (`services/terminal/object-port.ts:72–109`) resolves
the owning agent and calls `executeTerminalOperation` for every operation. The
Terminal plugin builds the port with no local override
(`services/terminal/plugin.ts:53`, reached from `loadHarnessTools` at
`integrations.ts:4749`), and the harness runs inside the agent — which holds
`this.terminal = new WorkstreamTerminalStorage(state.storage)`
(`substream-agent.ts:488`) and services the RPC by calling the very same object
(`:869`, `:897`).

The port's own documentation names the seam: `localStorage` exists "for the same
reason" as the runtime database's local executor. It is used by the Node tests
and not by the agent.

**Effect.** Every Terminal tool call in a run — and Terminal work is multi-step by
nature — is an RPC from the object into itself, each one re-deriving the stub and
re-checking identity. It also puts a network boundary inside the operation's
commit path, which is the seam that [`terminal-production-qa-2026-08-21.md`](terminal-production-qa-2026-08-21.md)
already found hard to reason about.

### 4. Agent timers: the agent asks itself to re-arm its own alarm

`refreshAgentTimerAlarm` (`workstream-wakeup-service.ts:645–668`) resolves the
owning agent and calls `refreshTimerAlarm`, whose handler validates identity and
then calls `this.scheduleNextAlarm()`. The agent's timer tools call it three
times inside `createAvalonTools` (`integrations.ts:6399`, `:6447`, `:6559`),
which runs inside the harness, which runs inside the agent.

**Effect.** A round trip to reach a private method on the object making the call.
The identity check in the handler (`substream-agent.ts:756–767`) is checking the
object against itself.

### 5. Run dispatch: the agent asks itself to queue a run

`launchWorkstreamHarness` calls `dispatchRun` on the owning agent
(`workstream-service.ts:272–283`), and `startWorkstreamWorkflow` does the same
(`integrations.ts:1826–1837`). Reached from `alarm()` → `fireNextAgentTimer` →
`fireWorkstreamWakeup` (`substream-agent.ts:1978`), the target is this object:
the alarm handler RPCs into itself to insert a row in `agent_run_dispatches` and
arm an alarm, then returns to `alarm()` which drains that row at `:2393`.

**Effect.** The round trip is short — `acceptRunDispatch` inserts and returns
`202` without awaiting the run — but it is a network hop to write one row of the
caller's own SQLite, and the wake-up claim it settles is held across it.

## How dangerous is this today

Honestly: it is a correctness *hazard* and a real cost, not an active outage.

**Not currently a deadlock.** A Durable Object's input gate stays open while an
invocation awaits non-storage I/O, so these self-calls are delivered as a second
concurrent invocation and complete. The one place that is not true is
`blockConcurrencyWhile`, and `SubstreamAgent`'s only use of it is the constructor
(`substream-agent.ts:467–509`), which reaches none of these paths. That is the
invariant holding the whole list up, and nothing in the code states it or tests
it. Any future self-call added inside a `blockConcurrencyWhile`, or any handler
that comes to wait on work the outer invocation owns, hangs the object until the
duration limit — which is precisely the shape of the alarm-joins-drain fault this
repository already hit once, recorded in
[`terminal-production-qa-2026-08-21.md`](terminal-production-qa-2026-08-21.md).

What is being paid for right now:

- **Throughput against a soft limit.** One Durable Object is single-threaded and
  tops out near 1,000 requests/second ([`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md#the-limits-that-decide-the-argument)).
  A busy run makes the object compete with itself for its own thread: a Terminal-
  heavy run generates one self-invocation per operation, and finding 1a turns a
  single wake-up into several.
- **Subrequests.** Each self-call counts toward the per-invocation subrequest
  budget for work that needs no subrequest at all.
- **Lost transactional locality.** Statements routed out and back cannot join a
  `transactionSync` in the calling invocation.
- **Re-entrancy the code does not model.** The second invocation observes and
  mutates the same SQLite while the first is mid-flight. Nothing here is known to
  be racing today, but the interleaving is unmodelled and untested.
- **Worse diagnostics.** Local invariant violations surface as foreign-object
  failures — `workstream_runtime_sql_failed`, `substream_agent_unavailable`,
  `terminal_operation_not_committed` — which is what makes a fault like the one
  above expensive to localize.
- **A routing dependency on D1.** `durableObjectStubForWorkspace` reads the
  workspace's placement affinity, and fails closed in staging and production. An
  object can therefore fail to reach *itself* because a D1 read failed.

## Adjacent: cross-object re-entrancy

Not self-referencing, so not counted above, but the same shape one hop out and
worth recording while the map is fresh: `WorkspaceDO` calls into `SubstreamAgent`
(`workspace-do.ts:2433`, `WorkstreamObjectClient`), and `SubstreamAgent`'s product
layer calls back into `WorkspaceDO` through `withWorkspaceRuntimeDatabase`
(`workstream-object-product.ts:323–324`, used from `initialize` at `:390` and from
the message and pin paths at `:664`, `:1185`, `:1995`). A message write can therefore be `WorkspaceDO` →
`SubstreamAgent` → `WorkspaceDO`, with the first invocation still open. It relies
on the same open-input-gate property as the findings above.

## Suggested direction, if these are to be fixed

Not applied. Recorded so the next change has a starting point.

1. **Thread the local seam instead of adding more of them.** Both escapes already
   exist (`localExecutor`, `localStorage`). The cheapest correct fix for findings
   1 and 3 is to make the agent's execution environment carry its local executor
   through the helpers it calls, rather than letting each helper re-derive an env
   from `this.env`. Finding 1a is the sharpest case: `launchWorkstreamHarness`
   re-wraps an env that already had a local executor.
2. **Give the object local variants of the four thin helpers.** `publishEvent`,
   `refreshTimerAlarm`, and `dispatchRun` all have a private method behind them
   that the agent could call directly. Findings 2, 4, and 5 are one indirection
   each.
3. **Make it impossible to reintroduce.** The repository already lints Durable
   Object storage and routing (`scripts/eslint-rules/durable-object-*.mjs`). A
   runtime guard is also available and cheaper to trust than a lint: the resolver
   could compare the derived id against `state.id` when called from inside an
   object and refuse, which turns every case above into a loud local failure
   rather than a silent round trip.
4. **Order the work by blast radius, not by count.** Finding 3 (Terminal) is
   per-tool-call and sits on a commit path that has already produced one
   production incident; finding 1 is per-SQL-statement and the largest volume;
   findings 2, 4, and 5 are per-event and mostly cost.

Whatever is done, [`workstream-durable-object.md`](workstream-durable-object.md)
needs the invariant written down — that a helper resolving "the owning agent" is
addressing *this* object when it runs inside it — because the code reads as
correct at every individual call site and only goes wrong in composition.

## Scope checked

| Class | Binding | Self-referencing RPC |
| --- | --- | --- |
| `SubstreamAgent` (`apps/api/src/durable-objects/substream-agent.ts`) | `SUBSTREAM_AGENTS` | **Yes — 5 groups, 12 paths** |
| `WorkspaceDO` (`workspace-do.ts`) | `WORKSPACE_DOS` | No |
| `WorkstreamDO` (`workstream-do.ts`) | `WORKSTREAM_DOS` | No |
| `BlockDashboardAgent` (`block-dashboard-agent.ts`) | `BLOCK_DASHBOARD_AGENTS` | No |
| `WorkspaceScheduler` (`workspace-scheduler.ts`) | `WORKSPACE_SCHEDULERS` | No — refreshes via `this.refresh()` |
| `MigrationRegistry` (`apps/migration-tracker/src/registry.ts`) | `MIGRATION_REGISTRY` | No — only the Worker resolves it |
