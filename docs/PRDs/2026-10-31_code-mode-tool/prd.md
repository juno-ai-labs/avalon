# Code Mode: one tool that runs a program against the run's tools

> Created 2026-10-31.
>
> An agent run gains `code_execute`: it writes a short JavaScript program against
> a typed API of the tools it already holds, the program runs in a network-less
> Dynamic Worker, each tool call inside it is a real authorized tool call with
> its own receipt, and only the program's return value reaches the model.
> Companions: [`design.md`](design.md) (wire shapes, the stub gateway, replay,
> the TypeScript rendering), [`research.md`](research.md) (production evidence
> and platform facts). Built on by
> [`2026-10-31_sidekick-custom-tools`](../2026-10-31_sidekick-custom-tools/prd.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Harness: [`agent-harness.md`](../../agent-harness.md); tool design rules:
> [`agent-tools.md`](../../agent-tools.md).

## Summary

A run that needs several dependent tool calls, a loop over results, or a filter
over a large result today pays one model round trip per call and carries every
intermediate result in its context for the rest of the run. With this change the
model can instead call one tool, `code_execute`, with a program. The program
sees the run's active tools as typed async functions, runs in a sandbox with no
network and no credentials, and returns a compact value. The host executes each
function call the program makes through the same authorized path an ordinary
tool call takes, so authorization, receipts, idempotency and Slack reply binding
are unchanged. Nothing about the run's tool surface changes: the plugin is
loadable like `rally_web`, and a run that never loads it behaves as today.

For the person watching, a program shows as one activity row under Rally, with
the calls it made listed in its detail. For the model, a twelve-call
read-and-filter becomes one call whose result is the few lines it needed.

## Motivation

The PostHog report Sidekicks in the Juno Labs Organization are the clearest case
([`research.md`](research.md) has the run table). Each daily run makes 32 to 46
tool calls on gpt-5.6-terra, 13 to 17 model calls, 0.6 to 1.0 million input
tokens, and takes 160 to 525 seconds. Of those tool calls, two to seven are the
queries the report needs; the rest re-read schemas and property values the
author verified at setup. Two of the last five Signup report runs ended blocked
because two SQL forms of the same count disagreed, a timezone-literal arithmetic
error the model re-derives each run. The 14-day production average across all
streaming turns is 56k input tokens and 6.1 seconds per model call.

The pattern recurs wherever a run composes reads: Linear issues filtered by
state, Drive files matched against a ledger, Slack threads read and summarized.
Every such composition is a chain of model round trips today, and every
intermediate result stays in context. The Terminal PRD research named connector
Code Mode "a credible second plugin" in August and left it unbuilt; the
Sidekick custom tools PRD cannot exist without it.

Anthropic's programmatic tool calling does the same job but runs only on the
Claude API, AWS and Foundry. Rally routes Azure and OpenRouter, so the pattern
has to be ours.

## Goals

1. A run can compose several tool calls in one `code_execute` call and receive
   only the program's return value in its context.
2. Every tool call a program makes is authorized, recorded and replayed exactly
   as the same call made directly would be: same capability check, same
   `tool_effects` receipt, same idempotency class, same `externalConversation`
   binding.
3. A program cannot reach anything the run could not: no network, no
   credentials, no tool outside the run's active set, no tool the run is
   forbidden.
4. A program interrupted by a loop relocation or a redeploy does not re-execute
   a tool call that already completed; it replays the recorded result.
5. The typed API the model writes against is rendered deterministically from the
   same corrected tool definitions the wire uses, so a resumed attempt renders
   the same bytes and the provider's cached prefix survives.
6. A program failure names what failed, at which call, with the shortest safe
   next action, through the structured failure path, never through a
   successful-looking output.
7. The person watching sees a program as one activity row with its calls in the
   detail, not as a silent gap in the transcript.

## Non-goals

1. **Native connector write tools inside a program.** A program may call read
   tools and hosted or custom MCP tools (which Rally classes as writes by policy
   but whose receipts replay). It may not call a native connector write such as
   `slack_send_message` or `linear_create_issue`; the stub refuses with the
   instruction to call the tool directly after the program returns. Deferred
   until program-level replay has run in production for a while; the design
   carries the receipt shape it needs.
2. **Python programs.** Dynamic Workers run Python, but every model we route
   writes JavaScript well and one runtime keeps the stub gateway and the type
   rendering single. Deferred; nothing in the design prevents it.
3. **Programs calling `code_execute`, Terminal, `start_agent`, `load_plugin`,
   `load_skill`, elicitation, or any `rally_core` control.** These change the
   run's shape; a program is a pure composition of data calls. Rejected.
4. **A program as a persistent process or a scheduled job.** A program is one
   tool call with one deadline. Anything longer-lived is the Terminal's or a
   Sidekick's. Rejected.
5. **Replacing the Terminal.** Daytona is a computer with a filesystem and
   packages; this is a request-shaped function with tool handles. The Terminal
   PRD's rejection of "Dynamic Workers as the only execution substrate" stands.
   Rejected.
6. **Progressive discovery (`search`/`describe`) inside the program.** The
   active tool set is small enough to render in full; a run that needs a tool
   loads its plugin with `load_plugin` first, as it does today. Deferred until a
   run's rendered API is measured to cost more than the loads it saves.
7. **Adopting `@cloudflare/codemode`.** The package is experimental, targets the
   Vercel AI SDK, and does not own the parts that are hard for us: receipts,
   replay, authorization and transcript rows. Its executor and type renderer are
   read for their edge cases and not depended on. Rejected; see
   [`research.md`](research.md#the-sdk).

## Product behavior

Nothing new appears until a run loads the `rally_code` plugin, which it does
when the catalog line matches its task: "Compose several tool calls in one
program: dependent reads, loops, filtering and shaping, when the result the
conversation needs is smaller than the data it takes to compute." Loading adds
a `# Code API` section to the system prompt, rendered from the run's active
tools, and one tool.

The model calls `code_execute` with a program and a one-line description. The
program runs with a deadline. While it runs, the transcript shows one activity
row under the Rally group reading the description, with the pulsing mark every
tool row has. When it settles, the row reads as a completed tool row; expanding
it lists each call the program made, in order, with the tool name, duration and
outcome, the way an ordinary tool row shows its arguments. The program's source
is in the row's detail as a code block. A member whose preference hides tool
calls sees nothing, as for any tool.

The model receives the program's return value, the captured console output, and
the list of calls it made. A thrown error, a timeout, a refused call or an
oversized result reaches the model as a failed tool result naming the call and
the next action. A program is never retried blind: a definitive failure says
what to change; a timeout says to split the work or call the tools directly.

In a Sidekick run the same tool is available and behaves the same. The Sidekick
custom tools PRD adds the ability to save a program as a named tool; this PRD
adds only the run-time tool.

## Impact on the product contract

None. The agent gains no capability it did not have: every call a program makes
is a call the run could make directly, and every rule that governs a direct
call governs the nested one. The tool-execution policy that Rally never asks a
person to confirm a tool call is unchanged. The change refines how the agent
spends its context, not what it is allowed to do.

## Decision log

None yet.

## Key design decisions

1. **The program's tool calls go through `HarnessTool.execute`, not around it.**
   A stub call is dispatched to the same `HarnessTool` object Bind would call
   for a direct invocation, under the same `HarnessToolContext`, so capability
   checks, connector authorization, `record_before_execute` receipts and
   `externalConversation` all happen without a second implementation.
   *Rejected:* a program-level receipt with the calls recorded as a log. It
   would make a nested write invisible to replay and to the audit row.
2. **Nested receipts are child rows of the program's receipt.** Each stub call
   writes a `tool_effects` row whose `occurrence_key` is the program effect's
   id plus the call index, in the same transaction shape as a top-level call.
   On program re-execution a stub call whose occurrence key and `request_hash`
   match a completed child returns the recorded output; a mismatch means the
   program is not deterministic and fails with `code_replay_diverged`.
   *Rejected:* making the program itself idempotent by hashing its code and
   replaying its final output only. A program interrupted after three
   completed reads would re-run them.
3. **Stubs are capability handles, built per program.** The host loads the
   Dynamic Worker with one `WorkerEntrypoint` stub whose `props` carry the run
   id and program effect id, and the host-side gateway resolves the tool from
   the run's active set on every call. The program never holds a tool list or
   an id it could widen. *Rejected:* passing a tool list into `env` as data for
   the program to dispatch on; the gateway would then trust a name the program
   chose.
4. **The typed API is rendered from `ToolDefinition` after
   `repairRootSchemaForProviders`.** One renderer, over the definitions the
   wire already uses, in the order Bind renders plugins (canonical id, then
   tool name). *Rejected:* rendering from the raw manifest schema, which can
   differ from what the model was shown as a tool and would let the two
   disagree on a nullable branch.
5. **Isolate identity is the program's hash.** `loader.get(sha256(code), …)`
   caches the compiled isolate so a Sidekick custom tool pays its load once a
   day; a one-off program pays once. *Rejected:* `load()` per call, which
   recompiles a stable program on every run.
6. **Writes inside a program are refused by the gateway, not by prose.** The
   gateway checks `mode` and plugin kind before dispatch and returns a typed
   refusal naming the tool to call directly. *Rejected:* a system-prompt rule.
   Non-goal 1 is enforced where it can be audited.
7. **Our own implementation.** The executor is a few hundred lines over the
   loader binding we already use for live artifacts; the renderer is a few
   hundred lines over `ToolDefinition`. The parts that matter are Bind-specific.
   See non-goal 7.

## Data model

No new table. `tool_effects` gains no column: a nested call is an ordinary row
whose `occurrence_key` is `${programEffectIntentId}:${callIndex}` and whose
`tool_position` continues the program's attempt sequence. The program's own row
is an ordinary `write` receipt whose `input_json` is the program and whose
`output_ref` is the result. [`workstream-durable-object.md`](../../workstream-durable-object.md)
owns the receipt tables and records the nested shape when this ships.

## Regional impact

None beyond a new binding in each regional API Worker's Wrangler file. A program
runs in the region of the run that called it, against that region's connector
authority. No data crosses the boundary that did not already cross it for a
direct call.

## Security and trust model

- The program is model-authored and untrusted. It runs in a Dynamic Worker with
  `globalOutbound: null`, so `fetch` and `connect` fail, with no bindings other
  than the gateway stub, and under a CPU and wall-clock limit.
- The gateway stub is a capability: it has no global name, cannot be forged, and
  resolves tools from the run's active set on every call. A program can call
  nothing the run has not loaded and nothing the run is forbidden.
- Credentials never enter the isolate. Connector tokens are read by the
  connector executor in the API Worker, as for a direct call.
- Tool outputs returned into the program are the same outputs the model would
  have seen; the program can combine them but not reach beyond them.
- The program source is recorded in the receipt and shown in the activity row.
  A person can read what ran.
- Prompt injection reaching the model can make it write a program, as it can
  make it call a tool. The program has strictly less reach than the model, so
  this opens no new path.
- `security.md` owns the renderer boundary; nothing here touches it.

## Agent behavior

The plugin contract, the tool catalog with exact wire shapes, the typed API
rendering, the failure contract and the sequences are in
[`design.md`](design.md). In brief:

- **Plugin** `rally:code`, model id `rally_code`, wire prefix `code`, loadable
  (deferred) in every run that has at least one stub-eligible tool, never
  preloaded. Loading adds the `# Code API` prompt section and the one tool. It
  starts, authorizes and persists nothing.
- **Tool** `code_execute` (canonical `execute`), `mode: "write"`,
  `idempotency: "record_before_execute"`, serial. Input `{ code, description }`.
  Output `{ value, logs, calls, truncated }`.
- **Stub-eligible tools:** every active tool with `mode: "read"`, and every
  hosted or custom MCP tool. Excluded: native connector writes, `rally_core`,
  `rally_discovery`, `rally_skills`, `rally_code`, Terminal, `start_agent` and
  the agent-communication tools, elicitation.
- **Failures** are typed: `code_program_failed`, `code_program_timed_out`,
  `code_call_refused`, `code_call_failed`, `code_result_too_large`,
  `code_replay_diverged`, each with the sentence and allowlisted `details` in
  the design.
- **Guidance** in the plugin's system message says when a program beats direct
  calls and when it does not, and that a program must return the small answer,
  not the data.

## Provider configuration

Each regional API Worker's Wrangler file and `wrangler.test.jsonc` gain a
`worker_loaders` binding named `CODE_LOADER`. The account is on Workers Paid,
which Dynamic Workers require. Dynamic Workers bill per unique Worker per day,
per request and per CPU millisecond beyond the included allowance;
[`research.md`](research.md#platform-facts) has the rates. Without the binding
the plugin is absent from the catalog and runs behave as today.

## Rollout

Ships to everybody on merge, with no flag. The plugin is loadable rather than
preloaded, so a run pays for it only when the model decides to compose. Turning
it off is removing the binding, which removes the plugin.

Order of work: the gateway and executor with nested receipts and replay; the
type renderer and prompt section; the activity row detail; the evaluations in
**Acceptance**. The Sidekick custom tools PRD starts after this one ships.

The limits this introduces (program deadline, program bytes, stub calls per
program, concurrent stub calls, result bytes, log bytes) are defensive and are
written open with the `LIMIT UNSET` marker and a handover row each, per
[`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).
The program deadline is the one that cannot ship open: an unbounded program
holds the Durable Object's I/O context, and the platform caps concurrent Dynamic
Workers per object at ten. [`design.md`](design.md#limits) gives the arithmetic
for the team to set it before merge.

## Acceptance

1. A work-stream run on the configured medium fallback model, given "list the
   Linear issues in project X updated this week and tell me which have no
   assignee", loads `rally_code`, makes one `code_execute` call, and answers
   with the filtered list. The transcript shows one Rally activity row whose
   detail lists the Linear calls.
2. The same program re-run after the loop is relocated mid-program (the
   `test-workers/` suite kills the object between two nested calls) completes
   with the first calls replayed from their receipts and no duplicate provider
   request.
3. A program that calls `slack_send_message` fails with `code_call_refused` and
   the model then calls the tool directly; no Slack message is sent by the
   program.
4. A program that loops without returning fails with `code_program_timed_out`
   inside the deadline and the run continues.
5. Schema snapshot and contract tests cover the input, the output, each failure
   shape, and the rendered API for a fixed plugin set, byte for byte.
6. The PostHog Signup report, with its instructions pointed at `code_execute`
   for the query step and nothing else changed, completes in under half the
   tool calls and model calls of its current runs over five consecutive days.

## Open questions

1. **Concurrency inside a program.** `Promise.all` over stub calls is natural
   JavaScript. The gateway can serialize tools flagged `serial` and run others
   concurrently up to a cap. Whether connectors tolerate the concurrency a
   program can generate is a provider question; the cap is written open and the
   first production trip decides it.
2. **Pagination inside a program.** `_next` tools are offered as stubs so a
   program can loop pages. Whether to also offer an async iterator helper in the
   program's environment depends on how often programs page; decide after the
   first ten programs.
