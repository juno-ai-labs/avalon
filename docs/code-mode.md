# Code Mode

Code Mode is one tool, `code_execute`, that runs a JavaScript program the model
wrote against the tools its run already holds. The program runs in a Cloudflare
Dynamic Worker with no network and one capability stub; every tool call it
makes is a real call through the same authorization, receipt plan and
settlement a direct call takes, recorded as a child of the program's own
receipt; only the program's return value comes back to the model. On top of it,
a Sidekick's wizard can save a tested program as a named tool that every run of
that Sidekick receives as `custom_<name>`.

The promise to the rest of the system is narrow: a program has no more reach
than the model that wrote it, and nothing a program does is invisible to the
receipt ledger. The pressure that produced it is recorded in
[the PRD](PRDs/2026-10-31_code-mode-and-sidekick-custom-tools/prd.md): a
Sidekick run on a weaker model re-deriving a method from prose, 75 to 85
percent of its tool calls spent re-reading what the wizard had already
verified.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/code-mode/plugin.ts` | The `rally:code` plugin and its one tool; `runProgram` (load the isolate, race the deadline); `finishProgram` (the result or the typed failure, naming completed writes); `createCustomToolsPlugin` and `runProgramForTool` for a Sidekick's saved tools. |
| `apps/api/src/services/code-mode/gateway.ts` | `CodeToolGateway`, the `RpcTarget` a program holds: resolves a call against the run's active plugins, refuses loop controls, writes and settles the child receipt, replays a completed one. `callableTools` is the one rule for what a program may call. |
| `apps/api/src/services/code-mode/entry-module.ts` | The isolate's entry module as a string, and `wrapProgram`, which makes a module of the model's function body. |
| `apps/api/src/services/code-mode/limits.ts` | Every bound, with the deadline the one number set and the rest `LIMIT UNSET`. |
| `apps/api/src/services/code-mode/errors.ts` | `CodeModeToolError`: code, sentence, allowlisted details. |
| `packages/agent-harness/src/code-api.ts` | `renderCodeApi`: tool definitions to the TypeScript declarations in `# Code API`. |
| `packages/agent-harness/src/index.ts` | `HarnessRuntimeView`, and the two plugin hooks `renderSystemMessage` and `attachRuntimeView`. |
| `packages/agent-harness/src/bind-runtime.ts` | Builds the view in `createPluginRuntime` and renders a plugin's dynamic message in `renderStableSystemPrompt`. |
| `packages/agent-harness/src/automation-creator-tools.ts` | `sidekick_tool_test`, the buffered test by code hash, and `submit_draft`'s refusal of an untested tool. |
| `packages/contracts/src/index.ts` | `SidekickCustomToolSchema`, `ToolInputObjectSchema`, `customTools` on the draft and the run definition. |
| `apps/api/src/services/integrations.ts` | Registers the code plugin and a run's custom-tools plugin in `loadHarnessTools`; attaches the gateway's host seams (lease, `beforeToolCall`, receipt plan, settlement) in `runWorkstreamHarness`; the wizard's `testTool` port. |
| `apps/api/src/env.ts`, `apps/api/wrangler.global.jsonc` | The `CODE_LOADER` Worker Loader binding. Optional: absent, neither plugin exists. |

## How it works

### The run-time tool

`rally_code` is a loadable built-in. Its catalog line says when to load it:
several dependent calls, loops, exact arithmetic, or reading more than the
answer needs. Loading adds its system message and a `# Code API` block, a
TypeScript declaration of every callable tool grouped by plugin model id,
rendered on every model call from the run's active set through
`renderSystemMessage`. The block is a pure function of the corrected tool
definitions in Bind's order, so a resumed attempt renders the same bytes and
the provider's cached prefix survives.

The model calls `code_execute({ code, description })`. `code` is the body of an
async function; `wrapProgram` makes it a module (a model that already wrote
`export default` is taken as written). `runProgram` loads the isolate with
`CODE_LOADER.get("code:<sha256 of code>", …)`, so a program is compiled once
and a saved tool pays its load once a day, with `globalOutbound: null` and an
empty `env`. It then calls the entry module's `run(gateway, api, options)` over
RPC, passing the gateway as an argument: the stub lives for that call and
nothing else reaches the isolate.

Inside, the entry builds `tools.<plugin>.<tool>(input)` for every name in
`api`, each forwarding to `gateway.call`, captures `console` with a byte bound,
races the program against the deadline, and answers with the serialized return
value and the logs, or the error with its code, message and the index of the
call that threw. `finishProgram` turns that into the tool result (`value`,
`logs`, `calls`, `truncated`) or a `CodeModeToolError` whose sentence names
the writes that completed, so the model never repeats them.

### Nested calls

`CodeToolGateway.call(plugin, tool, input)` resolves the tool against the run's
active plugins through the runtime view. Refused by name: the code plugin
itself, the loop controls (`load_plugin`, `load_skill`, `request_elicitation`),
a plugin not loaded, a plugin outside a saved tool's `requiredPlugins`. For
the rest it does what Bind does for a direct call, in order: normalize the
arguments, hash them, look up the child receipt at
`<program toolCallId>:call:<index>`, run `beforeToolCall`, record the plan with
`persistToolExecutionPlan`, execute through `HarnessTool.execute` with the
run's principal and the child's own `effectIntentId`, and settle through
`settleRootHarnessToolCompletion` or `settleRootHarnessToolFailure`. Writes and
`serial` tools run one at a time per program; reads run as the program asks.

A completed child with the same request hash replays its stored output and is
marked `replayed`. One with a different hash fails `code_replay_diverged`. A
`record_before_execute` write left unsettled by an interruption is marked
ambiguous and the program fails `ambiguous_external_write`, telling the model
not to repeat it. The program's own tool is `reenterable`: an attempt
interrupted mid-program re-enters, and the children that completed replay.

### A Sidekick's saved tools

`customTools` on the definition carries `{ name, description, inputSchema,
code, requiredPlugins }`. The wizard tests a candidate with
`sidekick_tool_test`, which runs the program through the same executor
narrowed to `requiredPlugins`, with the validated input in scope as `input`,
and records `sha256(code)` under the tool's name in the drafting state (and in
the receipt output, from which a resumed conversation restores it).
`submit_draft` refuses a ready draft whose tool has no recorded test for its
current code. The schema refuses, by field, a tool on an instruction-only
Sidekick and a `plugin_*` entry missing from `recommendedPlugins`; `rally_*`
plugins need no recommendation.

A run whose definition carries tools registers `rally:custom-tools`, always
active, with one `custom_<name>` tool per saved tool: the saved schema as its
input, `mode: write`, `record_before_execute`, and the program hash in
`providerOperationName` so the surface hash, and so receipt replay, follows the
code. Calling one validates the input, runs the program with the tool's plugin
allowance, and maps failures into the run's vocabulary (`custom_tool_failed`,
`custom_tool_timed_out`, `custom_tool_result_too_large`,
`custom_tool_unavailable`), each telling the run to follow its instructions'
failure step rather than rebuild the method.

### Tool catalog

| Plugin | Wire name | Capability | Mode | Idempotency | Where |
| --- | --- | --- | --- | --- | --- |
| `rally:code` (`rally_code`) | `code_execute` | `code.program.execute` | write | record_before_execute | loadable, every run with `CODE_LOADER` |
| `rally:sidekicks` | `sidekick_tool_test` | `rally.sidekick.tools.test` | write | record_before_execute | the wizard conversation |
| `rally:custom-tools` (`rally_custom_tools`) | `custom_<name>` | `sidekick.tools.run` | write | record_before_execute | runs of a Sidekick with saved tools |

Exact input and output shapes, the failure sentences and their details are in
[the PRD's design](PRDs/2026-10-31_code-mode-and-sidekick-custom-tools/design.md).

## Invariants

- **A program has no reach beyond its run.** The isolate holds one stub and
  nothing else, `globalOutbound` is null, and the gateway resolves every call
  against the live active set on the host side. Breaking it means a program
  reaching a tool the run never loaded. Guard: `code-mode.test.ts` proves a
  loop control is refused; the egress fence is the loader's.
- **Every nested call is a receipt of its own, settled as a direct call would
  be.** Breaking it means a write a program made that no ledger shows and no
  replay protects. Guard: `code-mode.test.ts` asserts the child rows, and fails
  when the settlement is dropped.
- **A completed child replays; a divergent one refuses.** Breaking it means a
  re-run repeating a provider write or silently sending different arguments
  under the same record. Guard: the gateway's hash comparison; the replay case
  is exercised through the `reenterable` path and is on the open list below.
- **The `# Code API` block is a pure function of the active set.** Breaking it
  costs the provider's cached prefix on every turn. Guard: `code-api.test.ts`
  renders a fixed set to a literal.
- **A saved tool was tested with its current code.** Breaking it means a run
  calling a program nobody ran. Guard: `automation-creator-tools.test.ts`
  refuses the untested draft and the changed program.
- **The gateway travels as an RPC argument, never as a stub back into the
  Durable Object.** A loopback entrypoint calling the object per nested call
  would accumulate against the subrequest depth limit the self-RPC audit
  records, and a run with thirty nested calls would die mid-program. Guard:
  verified by design review; no automated guard.

## Boundary

Owns: the two plugins, the gateway, the entry module, the renderer, the custom
tool schema and its publication gate. Exposes: `createCodePlugin`,
`createCustomToolsPlugin`, `CodeModeHost` (what `runWorkstreamHarness` attaches),
and the harness hooks `renderSystemMessage` and `attachRuntimeView`. Depends
on: the Worker Loader binding, the receipt port and settlement functions in
`integrations.ts`, Bind's `beforeToolCall`.

Deliberately not here: the receipt tables and their fences
([`workstream-durable-object.md`](workstream-durable-object.md)); the
Terminal, which is a computer with a filesystem and no callback into Rally
tools ([`terminal-workspaces.md`](terminal-workspaces.md)); the artifact
loader, which shares the binding type and nothing else
([`live-web-artifacts.md`](live-web-artifacts.md)); how a tool call row is
drawn ([`plugin-activity-rows.md`](plugin-activity-rows.md)): a program is one
row of its plugin, and its nested calls are receipts without rows of their
own.

## Failure modes and limits

- **No `CODE_LOADER` binding:** neither plugin is registered; runs behave as
  before. `sidekick_tool_test` is absent from the wizard's port and answers
  `sidekick_tool_test_host_unavailable`.
- **A program throws:** `code_program_failed`, naming the call index and tool
  when the throw came from a call, and the completed writes. The run continues.
- **A program outlives the deadline:** `code_program_timed_out` from the entry's
  own timer, or from the host-side race if the isolate is stuck in a busy loop.
  The Dynamic Worker's CPU limit is the plan default; no custom `limits` are
  set.
- **A nested call fails:** its child receipt is `failed` with the inner
  code; the program fails `code_call_failed` carrying the inner sentence.
- **A nested write is interrupted:** the child is `ambiguous`; the program
  fails `ambiguous_external_write`; the model is told to stop and report. The
  run is not aborted by the loop, which differs from a direct ambiguous write;
  the decision log records why.
- **Limits:** `CODE_PROGRAM_DEADLINE_MS` is 120 s, provisional and the team's
  to confirm; load allowance 15 s. Program bytes, calls per program, result
  bytes and log bytes are `LIMIT UNSET`. Concurrency of Dynamic Workers is the
  platform's: ten per Durable Object context.
- **A saved tool's plugin is not loaded in the run:** `custom_tool_unavailable`.
  A `plugin_*` entry reaches a run preloaded because the schema requires it in
  `recommendedPlugins`; a `rally_*` plugin is always active.

## Testing

- `apps/api/test-workers/code-mode.test.ts`: a room run on real workerd, the
  provider double scripting `load_plugin` then `code_execute`; asserts the
  program's receipt, its child rows, the value the model read, the `# Code API`
  block in the prompt, and a refused loop control. Run with
  `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/code-mode.test.ts`.
- `apps/api/test-workers/sidekick-custom-tools.test.ts`: a hosted Sidekick with
  a saved tool, run now, the run calling `custom_<name>`, its child receipt,
  and the publication refusal of a tool on an instruction-only draft.
- `packages/agent-harness/src/code-api.test.ts`: the renderer against a literal.
- `packages/agent-harness/src/automation-creator-tools.test.ts`: the test gate,
  the input and plugin refusals, and restoring a test from a receipt.
- `packages/contracts/src/index.test.ts`: the schema's field-naming refusals.
- Trap: the Node suite aliases `cloudflare:workers` to
  `apps/api/test/helpers/cloudflare-workers.ts`, which carries an `RpcTarget`
  stand-in so the gateway module loads off workerd. Anything that needs the
  real isolate belongs in `test-workers/`.
- Both integration tests were broken once in production code (the nested
  settlement dropped; the saved tools not materialized) and failed for the
  reason their names claim.

## Open questions

- **Aborting the run on a nested ambiguous write.** A direct write in that
  state throws Bind's `AmbiguousExternalWriteError` and the run stops; a nested
  one fails the program and relies on the model to stop. Bind exposes no host
  path to raise that error from inside a tool. Revisit when the harness grows
  one.
- **The replay path has no workerd test.** Re-entry after a relocation
  mid-program is implemented through `reenterable` and the gateway's
  receipt lookup; the test that kills the object between two nested calls is
  not written yet.
- **Saved tools in the wizard's own conversation.** The PRD wanted the wizard
  to hold its Sidekick's tools after publication; today only runs do, and the
  wizard tests through `sidekick_tool_test`.

## Changelog

### 2026-10-31 — Code Mode and Sidekick custom tools

**What changed:** The `rally:code` plugin with `code_execute`, the gateway and
nested receipts, the `# Code API` renderer and the two harness hooks it needs,
`customTools` on the Sidekick definition with `sidekick_tool_test` and the
submit gate, the per-run `rally:custom-tools` plugin, and the read-only Tools
section on the Sidekick profile.

**Why:** The PostHog report Sidekicks spent most of each run re-discovering
what their wizard had verified, and blocked on arithmetic the run re-derived.
A program the wizard writes once and the run calls is the method in a form the
run's model cannot misread.
[The PRD](PRDs/2026-10-31_code-mode-and-sidekick-custom-tools/prd.md) has the
evidence.

**Considered and rejected:** A loopback `WorkerEntrypoint` as the program's
capability, as the live artifacts use; its calls back into the Durable Object
would be self-RPC, which the self-RPC audit shows ends a run at the subrequest
depth limit. The gateway is an `RpcTarget` passed as an argument instead, and
the spike on real workerd confirmed the callback. `@cloudflare/codemode`, which
targets the Vercel AI SDK and owns none of the receipt or replay work. A
read-only first version of programs, which would have excluded hosted MCP
tools and so the PostHog case.

**Consequences:** A program's nested calls are receipts with a `:call:<index>`
suffix on the program's `toolCallId` and no transcript rows of their own. The
program deadline is provisional at 120 s. A saved tool's `requiredPlugins` must
be loaded in the run, which the schema guarantees for connector plugins through
`recommendedPlugins`.
