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
| `apps/api/src/services/code-mode/plugin.ts` | The `rally:code` plugin and its one tool; `runProgram` (a fresh isolate per program, the deadline race, the parsed answer); `finishProgram` (the result, or the typed failure read from the gateway's own records); `createCustomToolsPlugin`, `runProgramForTool` and `customToolFailure` for a Sidekick's saved tools; the three prompts. |
| `apps/api/src/services/code-mode/gateway.ts` | `GatewaySession`, one program's calls: the refusal rules, Bind's dispatch order and failure classification, the per-call timer, the closed and stopped states. `CodeToolGateway`, the `RpcTarget` a program holds, forwards its one method to the session. `callableTools` is the one rule for what a program may call. |
| `apps/api/src/services/code-mode/entry-module.ts` | The isolate's entry module as a string (the `tools` proxy, the console capture, the deadline timer); `wrapProgram`, which always wraps the model's function body. |
| `apps/api/src/services/code-mode/limits.ts` | The deadline and the load allowance, both set and provisional; the result bound, `LIMIT UNSET`. |
| `apps/api/src/services/code-mode/errors.ts` | `CodeModeToolError`: code, sentence, allowlisted details. |
| `packages/agent-harness/src/code-api.ts` | `renderCodeApi`: tool definitions to the TypeScript declarations in `# Code API`, one per name, in code-unit order. |
| `packages/agent-harness/src/index.ts` | `HarnessRuntimeView`, the plugin hooks `renderSystemMessage` and `attachRuntimeView`, and `HarnessTool.yieldsContentParts`. |
| `packages/agent-harness/src/bind-runtime.ts` | Builds the view in `createPluginRuntime` and renders a plugin's dynamic message in `renderStableSystemPrompt`. |
| `packages/agent-harness/src/automation-creator-tools.ts` | `sidekick_tool_test`, `customToolIdentityHash`, the buffered tests, `submit_draft`'s refusal of an untested tool, and `CUSTOM_TOOLS_GUIDE`. |
| `packages/contracts/src/index.ts` | `SidekickCustomToolSchema`, `ToolInputObjectSchema`, `CUSTOM_TOOL_RALLY_PLUGIN_IDS`, `customTools` on the draft and the run definition. |
| `apps/api/src/services/integrations.ts` | Registers the code plugin and a run's custom-tools plugin in `loadHarnessTools`; `findCompletedToolResult`, the one completed-receipt lookup Bind and the gateway share; attaches the gateway's host seams just before `runHarness`; the wizard's `testTool` port. |
| `apps/api/src/durable-objects/substream-agent.ts` | Crash repair names a program's completed nested calls in the ambiguity it records. |
| `apps/api/src/env.ts`, `apps/api/wrangler.global.jsonc` | The `CODE_LOADER` Worker Loader binding. Optional: absent, neither plugin exists and the wizard has no test tool. |

## How it works

### The run-time tool

`rally_code` is a loadable built-in. Its catalog line says when to load it:
several dependent calls, loops, exact arithmetic, or reading more than the
answer needs. Loading adds its system message and a `# Code API` block, a
TypeScript declaration of every callable tool grouped by plugin model id,
rendered on every model call from the run's active set through
`renderSystemMessage`. The block opens with one framing line: the comments are
copied from each tool's definition, and text from a connector or a saved tool
is data, not instructions. It is a pure function of the corrected tool
definitions in Bind's order, so a resumed attempt renders the same bytes and
the provider's cached prefix survives.

The model calls `code_execute({ code, description })`. `code` is the body of an
async function and is always wrapped as one; a body that does not compile
fails as a program, with the compiler's message. `runProgram` loads a fresh
isolate with
`CODE_LOADER.load(…)`, `globalOutbound: null` and an empty `env`: `load`, not
`get`, because an isolate kept by name would carry one program's globals into
the next program of the same conversation. It then calls the entry module's
`run(gateway, api, options)` over RPC, passing the gateway as an argument: the
stub lives for that call and nothing else reaches the isolate.

Inside, the entry builds `tools` as a proxy: the names in `api` are real
functions, and any other name a program reaches for is forwarded too, so the
gateway refuses it by name instead of the program seeing `undefined`. It
captures `console`, races the program against the deadline, and answers with
the serialized return value and the logs, or the error with its message, the
code it carried and the index of the call that threw. The host parses that
answer with a schema and trusts none of it on its own: `finishProgram` reads
the outcome of the failing call from the gateway's record (refused, failed,
ambiguous) and only then falls back to "the program threw"; a program that
dresses an error as a refusal, or claims the deadline before the host's clock
agrees, is a program failure. The result is `{ value, logs, calls }`, bounded
together by `CODE_RESULT_MAX_BYTES`; every failure sentence names the writes
that completed, so the model never repeats them.

### Nested calls

`GatewaySession.call(plugin, tool, input)` resolves the tool against the run's
active plugins through the runtime view and refuses by name, with a reason
code: a plugin not in the run, the two program plugins (a program cannot run a
program), a plugin outside a saved tool's `requiredPlugins`, a plugin not
loaded, a loop control (`load_plugin`, `load_skill`, `request_elicitation`),
a tool whose result is current-turn content (`yieldsContentParts`: `view_image`,
`view_resource`, `browser_js`, the image generators), a tool the plugin does
not have. Only "not loaded" is something the run can fix, and the sentence
says how.

For the rest it does what Bind does for a direct call, in Bind's order:
normalize and validate the arguments (a bad argument is a correctable error
with no receipt), hash them, run `beforeToolCall`, ask the host's
`findCompletedToolResult` for the child at `<program toolCallId>:call:<index>`
(a replay, a replay refusal, an ambiguous halt, or nothing), record the plan
with `persistToolExecutionPlan`, execute through `HarnessTool.execute` with the
run's principal, the child's own `effectIntentId` and a signal that aborts on
the run, on the program's end and on the tool's own timer, then settle through
the host's `complete` or `fail`, which also write the audit row and telemetry a
direct call gets. A failure is classified as Bind classifies it: a `ZodError`
after valid arguments on a record-before-execute write, an interrupted or timed
out such write, or Terminal's `command_outcome_unknown` is ambiguous;
everything else is a definitive failure with the tool's own code. Writes and
`serial` tools run one at a time per program; reads run as the program asks.

The session has a lifetime. When the program returns, the tool closes it:
calls still running are awaited, not aborted (a write the program did not
await is still a write, and cutting it off would make its receipt ambiguous),
and a call made after return is refused. A thrown authorization or settlement is fatal: the program is stopped,
every later call is refused, and the tool rethrows the host's error to Bind
once the isolate has answered, so the run sees the real failure rather than
the program's account of it. The program's own tool is `reenterable`: an
attempt interrupted mid-program re-enters, and the children that completed
replay through the same lookup a direct call uses.

### A Sidekick's saved tools

`customTools` on the definition carries `{ name, description, inputSchema,
code, requiredPlugins }`. `requiredPlugins` names connector plugins
(`plugin_*`, each of which must also be in `recommendedPlugins` so the run has
it loaded) or one of `CUSTOM_TOOL_RALLY_PLUGIN_IDS`: `rally_core`,
`rally_tables`, `rally_memory`, which every run holds, or `rally_web`, which a
run loads when the tool's refusal tells it to. The wizard tests a
candidate with `sidekick_tool_test`, which runs the program through the same
executor narrowed to `requiredPlugins`, with the validated input in scope as
`input`, and records the tool's identity hash (code, input schema and plugins
together) under its name in the drafting state and in the receipt output, from
which a resumed conversation restores it. `submit_draft` refuses a ready draft
whose tool has no recorded test for its current identity with
`custom_tool_untested`, naming `customTools.<i>.code`. The test tool and its
guide paragraph exist only where `CODE_LOADER` does. The schema refuses, by
field, a tool on an instruction-only Sidekick, a `plugin_*` entry missing from
`recommendedPlugins`, and a Rally plugin outside the allowlist.

A run whose definition carries tools registers `rally:custom-tools`, always
active, with one `custom_<name>` tool per saved tool: the saved schema closed
with `additionalProperties: false` as its input, `mode: write`,
`record_before_execute`, and the identity hash in `providerOperationName` so the
surface hash, and so receipt replay, follows the tool. Calling one validates
the input, runs the program with the tool's plugin allowance, and maps every
executor failure into the run's vocabulary with the next step in the sentence:
`custom_tool_failed`, `custom_tool_timed_out`, `custom_tool_result_too_large`
(a defect to report), `custom_tool_unavailable` (load the plugin and call
again, or a defect to report, by the refusal's reason), and
`ambiguous_external_write` carried through with the tool named.

### Shipped contracts

| Plugin | Wire name | Capability | Mode | Idempotency | Where |
| --- | --- | --- | --- | --- | --- |
| `rally:code` (`rally_code`) | `code_execute` | `code.program.execute` | write | record_before_execute | loadable, every run with `CODE_LOADER` |
| `rally:sidekicks` | `sidekick_tool_test` | `rally.sidekick.tools.test` | write | record_before_execute | the wizard conversation, with `CODE_LOADER` |
| `rally:custom-tools` (`rally_custom_tools`) | `custom_<name>` | `sidekick.tools.run` | write | record_before_execute | runs of a Sidekick with saved tools |

`code_execute` takes `{ code: string, description: string <= 240 }` and
returns `{ value, logs: [{ level, text }], calls: [{ index, tool, mode, ms,
outcome }] }`, where `outcome` is `completed`, `replayed`, `failed`, `refused`
or `ambiguous`. `sidekick_tool_test` takes `{ tool, input }` and returns the
program's output plus `{ name, identityHash, testedAt }`. A `custom_<name>`
takes the saved schema and returns what `code_execute` returns.

| Code | Raised when | Model-visible sentence says |
| --- | --- | --- |
| `code_call_refused` | A nested call was refused by name | which name, why, and to call it directly or load the plugin |
| `code_call_failed` | A nested call ran and failed, or rejected its arguments | the call index, the tool, the tool's own message, and the completed writes |
| `ambiguous_external_write` | A nested record-before-execute write has an unknown outcome | the call, "do not repeat it", and to stop |
| `code_program_failed` | The program threw, did not compile, or returned an unserializable value | the message and what to fix |
| `code_program_timed_out` | The program ran past `CODE_PROGRAM_DEADLINE_MS` | the deadline, the call count, and the completed writes |
| `code_result_too_large` | Value plus logs exceed `CODE_RESULT_MAX_BYTES` | the sizes and to return the answer, not the data |
| `code_unavailable` | No host is attached (no `CODE_LOADER`) | to call the tools directly |
| `custom_tool_untested` | `submit_draft` with a tool whose identity has no recorded test | the tool and to test it, with `field: customTools.<i>.code` |
| `custom_tool_input_invalid`, `custom_tool_plugin_unbound`, `custom_tool_runtime_unavailable` | `sidekick_tool_test` refusals | the field, the plugin, or that no runtime exists |

The details forwarded with a failure are the allowlisted keys
`readStructuredFailure` passes (`reason`, `field`, `available` bounded to
twenty values, `expected`, `retryAfterMs`); a tool's message text is bounded to
`CODE_ERROR_MESSAGE_MAX_CHARS`.

## Invariants

- **A program has no reach beyond its run.** The isolate holds one stub and
  nothing else, `globalOutbound` is null, `env` is empty, and the gateway
  resolves every call against the live active set on the host side. Breaking it
  means a program reaching a tool the run never loaded. Guard:
  `test/code-mode.test.ts` proves every refusal reason and
  `test-workers/code-mode.test.ts` proves a loop control is refused and `fetch`
  fails inside a real isolate.
- **Every nested call is a receipt of its own, settled as a direct call would
  be.** Breaking it means a write a program made that no ledger shows and no
  replay protects. Guard: `test/code-mode.test.ts` fails when the completion
  is dropped; `test-workers/code-mode.test.ts` asserts the child rows.
- **A completed child replays through the host's own lookup; an ambiguous one
  fails the program.** Breaking it means a re-run repeating a provider write.
  Guard: `test/code-mode.test.ts` replays and halts without executing; the
  kill-mid-program case is on the open list below.
- **The `# Code API` block is a pure function of the active set.** Breaking it
  costs the provider's cached prefix on every turn. Guard: `code-api.test.ts`
  renders a fixed set to a literal, including a duplicate name and a comment
  terminator in a description.
- **A saved tool was tested as it is saved.** Code, schema and plugins hash
  together; breaking it means a run calling a program nobody ran, or with an
  input nobody tried. Guard: `automation-creator-tools.test.ts` refuses the
  untested draft and the changed code and plugins;
  `connector-tool-selection.test.ts` fails when the restore from receipts is
  dropped.
- **The gateway travels as an RPC argument with one method, never as a stub
  back into the Durable Object.** A loopback entrypoint would accumulate
  against the subrequest depth limit the self-RPC audit records. The session
  is a `#private` field, so nothing but `call` is reachable over the stub.
  Guard: the type and the field; no automated guard.
- **A program never runs a program, and never holds a result the turn owns.**
  Breaking the first nests receipts without bound; breaking the second puts an
  image in a JSON value. Guard: `callableTools` in `test/code-mode.test.ts`.

## Security and trust model

A program is model-authored code, and the model is untrusted. The isolate it
runs in is the boundary: a Dynamic Worker with no network (`globalOutbound:
null`), no bindings (`env: {}`), and one capability, the gateway stub, which
lives for the call and answers one method. Everything a program can affect in
the world goes through that method, and the method does for each call exactly
what Bind does for a direct one: the same authorization hook, the same receipt,
the same settlement, under the run's execution principal. A program therefore
has the authority of the model that wrote it and no more, and a program's
writes are as visible in the ledger as the model's own.

The module shape is the host's: the body is always wrapped. A body that
escaped its braces could run at module top level, but the isolate holds
nothing for it to reach: no `env`, no network, and `cloudflare:workers`
imports yield classes with nothing to call. No textual refusal stands in front
of the loader for that reason; one did, and it guarded nothing while risking
a false match on a string that began a line with `export`. The isolate is
fresh per program, so no global state crosses programs or runs.

What the program returns is data. `finishProgram` parses the isolate's answer
with a schema, derives the failure code from the gateway's own records rather
than the thrown error's `code`, and bounds the message copied to the model. The
`# Code API` block carries connector and saved-tool descriptions inside
comments, framed by a line that names them as data; the Sidekick wizard's saved
tool is the one place a model writes an input schema other models read, and
`ToolInputObjectSchema` constrains it to a described plain object.

A saved tool runs under the run's principal with the run's connections, never
the wizard's: `requiredPlugins` narrows which of the run's plugins the program
may call, and a plugin the run has not loaded is a refusal. The wizard's test
runs the program for real, with the wizard's own authority, and the guide says
so. A tool is saved only after a test with its exact identity, and a changed
schema or plugin list is a new identity.

Nothing here asks a person to confirm a call: Code Mode follows the
[tool execution policy](hosted-mcp-connectors.md). The
Terminal remains the place for code that needs a filesystem or a network
([`security.md`](security.md#terminal-sandbox-boundary)).

## Boundary

Owns: the two plugins, the gateway, the entry module, the renderer, the custom
tool schema and its publication gate. Exposes: `createCodePlugin`,
`createCustomToolsPlugin`, `CodeModeHost` (what `runWorkstreamHarness` attaches),
`GatewaySession` for tests, and the harness hooks `renderSystemMessage`,
`attachRuntimeView` and `yieldsContentParts`. Depends on: the Worker Loader
binding, `findCompletedToolResult`, the receipt port and settlement functions in
`integrations.ts`, Bind's `beforeToolCall`.

Deliberately not here: the receipt tables and their fences
([`workstream-durable-object.md`](workstream-durable-object.md)); the
Terminal, which is a computer with a filesystem and no callback into Rally
tools ([`terminal-workspaces.md`](terminal-workspaces.md)); the artifact
loader, which shares the binding type and nothing else
([`live-web-artifacts.md`](live-web-artifacts.md)); how a tool call row is
drawn ([`plugin-activity-rows.md`](plugin-activity-rows.md)): a program is one
row of the Rally group, and its nested calls are receipts without rows of their
own.

## Failure modes and limits

- **No `CODE_LOADER` binding:** neither plugin is registered; runs behave as
  before. The wizard has no `sidekick_tool_test` and no custom-tool guide, and a
  submitted tool is refused as untested.
- **A program throws or does not compile:**
  `code_program_failed` with the message and the completed writes. The run
  continues.
- **A program outlives its runtime:** `code_program_timed_out`. Loops are
  allowed; the one bound is the clock, enforced twice because one clock cannot
  stop both kinds of program: the entry's own timer ends a program that waits,
  and the runtime's CPU limit (`limits.cpuMs`, the same number) kills one that
  is busy, where no timer can fire. The host-side race is the backstop behind
  both. Past the deadline every failure is the deadline, whatever the program
  caught and rethrew.
- **A nested call fails:** its child receipt is `failed` with the tool's own
  code, audited and counted as a direct failure is; the program fails
  `code_call_failed` carrying the inner sentence.
- **A nested write is ambiguous:** the child is `ambiguous`, the run's
  ambiguous flag is set as for a direct write, and the program fails
  `ambiguous_external_write`; the model is told to stop and report. The run is
  not aborted by the loop, which differs from a direct ambiguous write; the
  decision log records why. Crash repair of an interrupted program names the
  nested calls that completed in the ambiguity it records.
- **The host cannot authorize or settle a call:** the program is stopped and
  the host's own error (an authority loss, an ownership fence) reaches Bind as
  it would from a direct call.
- **A saved tool's plugin is not loaded in the run:** `custom_tool_unavailable`
  telling the run to load it. A `plugin_*` entry reaches a run preloaded
  because the schema requires it in `recommendedPlugins`; `rally_core`,
  `rally_tables` and `rally_memory` are always active, and `rally_web` is
  loaded on that refusal.

Limits, for the team to confirm or move
([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)):

| Constant | Value | Status | Without it |
| --- | --- | --- | --- |
| `CODE_PROGRAM_DEADLINE_MS` | 120,000 | provisional, set | an unbounded program holds the object's I/O context; the platform caps Dynamic Workers at ten per object |
| `CODE_PROGRAM_CPU_MS` | the deadline | follows the deadline | a program that loops without yielding runs until the plan's CPU limit, and the host cannot stop it |
| `CODE_PROGRAM_LOAD_ALLOWANCE_MS` | 15,000 | provisional, set | a stuck isolate holds the program's tool timer past the deadline |
| `CODE_RESULT_MAX_BYTES` | `+Infinity` | LIMIT UNSET | a program returns the data instead of the answer and fills the context |
| `CODE_ERROR_MESSAGE_MAX_CHARS` | 500 | set | a tool's message swamps the failure sentence |

Program bytes, calls per program and log bytes have no guard, written open or
otherwise: the loader compiles what it is given, the deadline ends a loop
(waiting or busy), and the result bound covers the logs.

## Testing

- `apps/api/test/code-mode.test.ts` (Node): `callableTools`; the gateway over a
  real receipt store with spied host seams (a settled nested call, replay and
  halt without executing, every refusal reason, argument rejection with no
  receipt, Bind's failure classification, the per-call timer, a fatal
  authorization, closing with a call in flight); `finishProgram` deriving codes
  from records; `customToolFailure`; `wrapProgram`;
  `EntryResultSchema`. Run with
  `pnpm --filter @rally/api exec vitest run test/code-mode.test.ts`.
- `apps/api/test-workers/code-mode.test.ts` (workerd): a room run with the
  provider double scripting `load_plugin` then `code_execute`; the program's
  receipt, its child rows, the value the model read, the framed `# Code API`
  block; a refused loop control, an unknown name through the proxy, a blocked
  `fetch`, a program that does not compile; `runProgram` directly for the
  deadline of a waiting program and for isolate freshness. Not covered: the
  CPU kill of a busy loop, which the platform enforces only when deployed; on
  local workerd such a program starves the host's timers and never ends. Run with
  `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/code-mode.test.ts`.
- `apps/api/test-workers/sidekick-custom-tools.test.ts`: a hosted Sidekick with
  a saved tool, run now, the run calling `custom_<name>`, its child receipt,
  and the publication refusal of a tool on an instruction-only draft.
- `apps/api/test/connector-tool-selection.test.ts`: a recorded `tool_test`
  receipt restores the test on a resumed wizard, and an unrecorded tool is
  refused `custom_tool_untested`.
- `packages/agent-harness/src/code-api.test.ts`: the renderer against a
  literal, including a duplicate name, code-unit order and a description that
  tries to close the comment.
- `packages/agent-harness/src/automation-creator-tools.test.ts`: the identity
  gate across code and plugin changes, the input and plugin refusals, the test
  tool and guide present only with a runtime, and restoring tests from receipts.
- `packages/contracts/src/index.test.ts`: the schema's field-naming refusals
  and the Rally plugin allowlist.
- `scripts/code-mode-evals.mjs`: prompt evaluations against the local API and
  the real models, run by hand when a prompt or a tool contract changes
  (`node scripts/code-mode-evals.mjs --suite final`). Three suites: fourteen
  work-stream scenarios from one arithmetic call to a deliberate failure after
  two writes, run on Sol and Terra; seven wizard scenarios with runs; and the
  final twenty wizard scenarios of rising complexity, from a Sidekick with no
  tool to one whose tool takes an input, dedupes by date and returns three
  results. The graders read transcripts and saved definitions, and the expected
  numbers are computed for 2026-10-31. Three rounds shaped the prompts: every
  failure was a program guessing a tool's output shape (`current_time` as an
  object, a direct result's `{success, data}` envelope inside a program), and
  the sentences that name those shapes took the Code Mode suite from 23 of 26
  to 26 of 26 and the wizard suite to 12 of 12. The final twenty passed, 38 of
  38 wizard and run checks in substance; one run landed on a Gemini Flash
  fallback and still passed. A fourth suite, `prod`, holds twelve scenarios
  shaped after Sidekicks running in production (daily activity and signup
  reports with checkpoints, a careers-page monitor with a baseline ledger, a
  note delta behind a cursor, weekly call prep, an hourly dashboard, a polling
  window, research dedup, a connector firehose the run cannot serve) rewritten
  over local plugins; it passed 22 of 22, with ten of its runs routed to the
  scheduled-run model, Gemini Flash, each calling its saved tool. Three
  `choice` scenarios in the code suite check that "run this Python" and
  "publish a CSV" load Terminal and exact arithmetic does not; they need a
  deployment where `TERMINAL_REGION_CAPABILITY` is `supported`.
- Trap: the Node suite aliases `cloudflare:workers` to
  `apps/api/test/helpers/cloudflare-workers.ts`, which carries an `RpcTarget`
  stand-in so the gateway module loads off workerd. Anything that needs the
  real isolate belongs in `test-workers/`.
- Each integration test was broken once in production code (the nested
  settlement dropped; the saved tools not materialized; the receipt restore
  dropped) and failed for the reason its name claims.

## Open questions

- **Aborting the run on a nested ambiguous write.** A direct write in that
  state throws Bind's `AmbiguousExternalWriteError` and the run stops; a nested
  one fails the program and relies on the model to stop. Bind exposes no host
  path to raise that error from inside a tool. Revisit when the harness grows
  one.
- **The replay path has no workerd test.** Re-entry after a relocation
  mid-program is implemented through `reenterable` and the host's lookup, and
  proved in Node over a real receipt store; the test that kills the object
  between two nested calls is not written yet.
- **Saved tools in the wizard's own conversation.** The PRD wanted the wizard
  to hold its Sidekick's tools after publication; today only runs do, and the
  wizard tests through `sidekick_tool_test`.
- **Who may read a saved tool's code on the profile.** Everyone who can read
  the Sidekick can read it today; whether a guest in the owning Thread counts
  is a listing-rules question still open.

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

**Consequences:** The prompts say what a call returns (the tool's data, with
no result envelope; `current_time` as text lines) because every eval failure
was a program guessing a shape. A program's nested calls are receipts with a `:call:<index>`
suffix on the program's `toolCallId` and no transcript rows of their own; they
share Bind's completed-receipt lookup, failure classification, audit row and
telemetry, and crash repair names the completed ones. The gateway exposes one
method and a program cannot run a program, call a loop control, or call a tool
whose result is current-turn content. A saved tool's identity is its code,
input schema and plugins together; `requiredPlugins` admits connector plugins
and `rally_core`, `rally_tables`, `rally_memory` and `rally_web`, and a connector plugin
must also be in `recommendedPlugins`. The program deadline is provisional at
120 s, enforced by the entry's timer for a waiting program and by the
runtime's CPU limit for a busy one; the result bound is the one open limit,
and no other bound exists.
