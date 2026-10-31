# Code Mode and Sidekick custom tools

> Created 2026-10-31.
>
> Two things, one on top of the other. First, an agent run gains
> `code_execute`: it writes a short JavaScript program against a typed API of
> every tool it holds, the program runs in a network-less Dynamic Worker, each
> tool call inside it is a real authorized call with its own receipt, and only
> the program's return value reaches the model. Second, a Sidekick's wizard can
> save a tested program as a named tool with its own input schema, and every
> run of that Sidekick receives it as an ordinary tool.
> Companions: [`design.md`](design.md) (plugin contracts, wire shapes, the stub
> gateway, nested receipts and replay, the TypeScript rendering, limits),
> [`research.md`](research.md) (production evidence and platform facts).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Harness: [`agent-harness.md`](../../agent-harness.md); tool design rules:
> [`agent-tools.md`](../../agent-tools.md); Sidekicks:
> [`automation-lifecycle.md`](../../automation-lifecycle.md).

## Summary

A run that needs several dependent tool calls, a loop over results, arithmetic,
or a filter over a large result today pays one model round trip per call and
carries every intermediate result in its context for the rest of the run. With
this change the model can call one tool, `code_execute`, with a program. The
program sees every tool the run holds as a typed async function, has plain
JavaScript for math, dates, JSON and text, runs in a sandbox with no network
and no credentials, and returns a compact value. The host executes each tool
call the program makes through the same authorized path a direct call takes,
reads and writes alike, so authorization, receipts, idempotency and Slack reply
binding are unchanged. The plugin is loadable like `rally_web`; a run that
never loads it behaves as today.

On top of that, a Sidekick's wizard can save a program as a tool. It declares a
name, a model-facing description, an input schema and the program; tests it
against live data from the setup conversation; and submits it with the
definition. Every run of that Sidekick then sees `custom_<name>` beside its
other tools and calls it like any of them. The method moves from prose the
run's model interprets into code the run's model calls.

For the person watching, a program or a custom tool shows as one activity row
with the calls it made in its detail. For the PostHog daily report, the wizard
on the primary model writes and tests `posthog_daily_signup_report` once; a run
on the fallback model makes four calls: the time, the tool, the formatting, the
post.

## Motivation

The PostHog report Sidekicks in the Juno Labs Organization are the clearest
case ([`research.md`](research.md#the-posthog-report-sidekicks) has the run
table). Each daily run makes 32 to 46 tool calls on gpt-5.6-terra, 13 to 17
model calls, 0.6 to 1.0 million input tokens, and takes 160 to 525 seconds. Of
those tool calls, two to seven are the queries the report needs; the rest
re-read schemas and property values the author verified at setup, and the
instructions say so. Two of the last five Signup report runs ended blocked
because two SQL forms of the same count disagreed, a timezone-literal
arithmetic error the model re-derives each run. The self-review answered with
more prose, in three revisions, against the 12,000-character instruction
ceiling. The next run still blocked.

The authoring guide already states the principle (`automation-lifecycle.md`,
2026-10-22): "Authoring and execution can have different reasoning
capabilities. A brief objective leaves each independent activation to
rediscover the method and resolve decisions the wizard could have settled
once." It answered by saving the method as prose. A prose method is interpreted
every run by whichever model runs; a program is executed. For a data report the
deterministic part is nearly all of it.

The pattern recurs wherever a run composes calls: Linear issues filtered by
state, Drive files matched against a ledger, Slack threads read and summarized,
a figure computed from two sources. The 14-day production average across all
streaming turns is 56k input tokens and 6.1 seconds per model call. The
Terminal PRD research named connector Code Mode "a credible second plugin" in
August and left it unbuilt.

Anthropic's programmatic tool calling does the same job but runs only on the
Claude API, AWS and Foundry. Rally routes Azure and OpenRouter, so the pattern
has to be ours, and it then works on every model we route.

## Goals

1. A run can compose several tool calls, and any computation over their
   results, in one `code_execute` call and receive only the program's return
   value in its context.
2. Every tool the run holds is callable from a program, writes included, and a
   call made from a program is authorized, recorded and replayed exactly as the
   same call made directly: same capability check, same `tool_effects` receipt,
   same idempotency class, same `externalConversation` binding.
3. A program cannot reach anything the run could not: no network, no
   credentials, no tool outside the run's active set.
4. A program interrupted by a loop relocation or a redeploy does not re-execute
   a call that already completed; it replays the recorded result. A write
   whose outcome is unknown stops the run with that call named, as a direct
   write does today.
5. The typed API the model writes against is rendered deterministically from
   the same corrected tool definitions the wire uses, so a resumed attempt
   renders the same bytes and the provider's cached prefix survives.
6. A program failure names what failed, at which call, with the shortest safe
   next action, through the structured failure path, never through a
   successful-looking output.
7. The wizard can declare a tool with a name, a description, an input schema
   and a program, and save it with the Sidekick's definition.
8. A tool is saved only after its program ran successfully with representative
   input in the setup conversation. Publication refuses an untested program by
   name.
9. Every run of the Sidekick, and the wizard's own conversation, receives each
   saved tool as an ordinary tool with the declared schema, reaching only the
   connections the Sidekick is bound to.
10. A custom tool failure in a run names the tool, the call inside it that
    failed, and the next action; the scheduled self-review can revise the
    program under the same test gate; the owner can read every tool's code.
11. The person watching sees a program or a custom tool as one activity row
    with its calls in the detail, not as a silent gap.

## Non-goals

1. **Python programs.** Dynamic Workers run Python, but every model we route
   writes JavaScript well and one runtime keeps the stub gateway and the type
   rendering single. Deferred; nothing in the design prevents it.
2. **A program calling `code_execute`, `load_plugin`, `load_skill` or
   `request_elicitation`.** These are loop controls, not work: they change what
   the run holds or pause it for a person, and their results are Bind control
   signals rather than data. The gateway refuses them with the instruction to
   call them directly. Everything else the run holds, Terminal and
   `start_agent` included, is callable. Rejected for the four named.
3. **A program as a persistent process or a scheduled job.** A program is one
   tool call with one deadline. Anything longer-lived is the Terminal's or a
   Sidekick's. Rejected.
4. **Replacing the Terminal.** Daytona is a computer with a filesystem and
   packages; this is a request-shaped function with tool handles. The Terminal
   PRD's rejection of "Dynamic Workers as the only execution substrate"
   stands. Rejected.
5. **Progressive discovery (`search`/`describe`) inside the program.** The
   active tool set is small enough to render in full; a run that needs a tool
   loads its plugin first, as today. Deferred until a run's rendered API is
   measured to cost more than the loads it saves.
6. **Adopting `@cloudflare/codemode`.** The package is experimental, targets
   the Vercel AI SDK, and does not own the parts that are hard for us:
   receipts, replay, authorization and transcript rows. Its executor and type
   renderer are read for their edge cases and not depended on. Rejected; see
   [`research.md`](research.md#the-sdk).
7. **People writing tool code in the app.** A person describes what they want
   in the setup conversation and the wizard writes the program. The profile
   shows the code read-only. A code editor is deferred until requested.
8. **Sharing tools across Sidekicks or an Organization tool library.** A tool
   belongs to the revision that declares it. A library is a scope and
   permissions question for later. Deferred.
9. **A tool that replaces the run.** A run still reasons, formats and decides;
   a tool returns data or performs the steps it was written for. A Sidekick
   whose whole run is one program with no model turn is a different product (a
   scheduled function) and is rejected here.
10. **Tools on instruction-only Sidekicks.** An instruction-only Sidekick is a
    Skill loaded into another conversation, and loading a skill grants no
    authority. A tool is authority. Rejected; publication refuses the
    combination.
11. **Automatic conversion of existing prose methods.** Existing Sidekicks keep
    working as they are. The self-review may propose a tool when the runs show
    repeated discovery, under the same gate as any revision. Deferred to the
    review's judgement, not a migration.

## Product behavior

### The run-time tool

Nothing new appears until a run loads the `rally_code` plugin, which it does
when the catalog line matches its task: "Compose several tool calls, or compute
over their results, in one JavaScript program: dependent calls, loops, math,
filtering and shaping, when the answer the conversation needs is smaller than
the data it takes to compute." Loading adds a `# Code API` section to the
system prompt, rendered from the run's active tools, and one tool.

The model calls `code_execute` with a program and a one-line description. The
program runs with a deadline. While it runs, the transcript shows one activity
row under the Rally group reading the description, with the pulsing mark every
tool row has. When it settles, the row reads as a completed tool row; expanding
it lists each call the program made, in order, with the tool name, duration
and outcome, the way an ordinary tool row shows its arguments, and shows the
program's source as a code block. A member whose preference hides tool calls
sees nothing, as for any tool.

The model receives the program's return value, the captured console output and
the list of calls it made. A thrown error, a timeout, a refused call or an
oversized result reaches the model as a failed tool result naming the call and
the next action. A program is never retried blind: a definitive failure says
what to change; a timeout says to split the work. A program that wrote
something before failing says which writes stand.

### Sidekick custom tools

**In the setup conversation.** The authoring guide gains a step between
testing the method and writing the instructions: when the tested method is work
the runs will repeat, save it as a tool. The wizard calls `sidekick_tool_test`
with the candidate tool and representative input, reads the result, iterates
until it is right, and includes the tool in `submit_draft`. The conversation
shows the test as an activity row like any tool call, with the program in its
detail. A test that performs writes performs them for real; the guide says so,
and says to test against a scratch destination or with the write step
parameterized off when a real delivery is not wanted during setup.

**On the Sidekick profile.** A **Tools** section lists each saved tool by name
and description. Expanding one shows its input schema, its program as a
read-only code block, and when it was last tested. Nothing here is editable;
changes go through the setup conversation.

**In a run.** The run's tool list carries `custom_<name>` with the saved
description. The run calls it with the declared input; the transcript shows one
activity row under the Sidekick's name reading the tool's description, with the
calls the program made in its detail. A failed tool shows a failed row and the
run does what its instructions say for a failed step, which the authoring guide
requires to be written down.

**In the scheduled self-review.** The review may change a tool's program when
the runs show it failing or returning the wrong shape. It tests the change with
`sidekick_tool_test` and submits, under the existing rules: never a new
connection, plugin, destination or trigger, so never a new `requiredPlugins`
entry.

**States.** A Sidekick with no tools shows no Tools section. A tool whose
required plugin's connection is disconnected is listed on the profile with that
plugin named as unavailable, and a run calling it fails with
`custom_tool_unavailable` naming the connection. A tool on a revision that
failed publication does not exist; the previous accepted revision's tools do.

## Impact on the product contract

None. The agent gains no capability it did not have: every call a program
makes is a call the run could make directly, under the same rules, and a saved
tool is added to a Sidekick's surface, not substituted for it. The policy that
Rally never asks a person to confirm a tool call is unchanged. The change
refines how the agent spends its context and where a Sidekick's method is
recorded, not what the agent is allowed to do.

## Decision log

### 2026-10-31 — The gateway is an RPC argument, not a loopback entrypoint

**Decided:** The program's capability is a `CodeToolGateway extends RpcTarget`
created inside the Durable Object and passed as an argument to the isolate's
`run` method. Nothing in the isolate's `env`.

**Why:** Design decision 3 modelled the gateway on the live artifacts'
`ctx.exports` loopback. A loopback entrypoint runs outside the object and would
have to call back into it per nested call, which the self-RPC audit shows
accumulates against the subrequest depth limit: fifteen self-calls ended a run.
A spike on real workerd confirmed a Dynamic Worker can call methods on an
`RpcTarget` passed as an argument, with the network still blocked.

**Changes:** Design decision 3's mechanism; the goals are unchanged.

### 2026-10-31 — A nested ambiguous write fails the program; the loop is not aborted

**Decided:** When a nested `record_before_execute` write is left unsettled by
an interruption, the child receipt is marked ambiguous and the program fails
with `ambiguous_external_write`, telling the model not to repeat it and to
stop. The run itself continues.

**Why:** Bind raises its `AmbiguousExternalWriteError` only from its own
dispatch path; a tool has no way to raise it. The honest alternative was to
let the model stop, with the receipt carrying the truth.

**Changes:** Goal 4 narrows: the write is never repeated, but the run stops only
because the model is told to. Revisit when the harness exposes a host path.

### 2026-10-31 — A saved tool may call Rally's own plugins

**Decided:** `requiredPlugins` accepts `rally_*` ids beside `plugin_*`. Only a
`plugin_*` entry must also be in `recommendedPlugins`.

**Why:** The plugin id schema admitted connector plugins only, which would have
refused a tool over `rally_tables` or `rally_core`. Rally's own plugins are in
every run, so they need no recommendation to be loaded.

**Changes:** The data model in [`design.md`](design.md#schema).

### 2026-10-31 — The wizard tests tools but does not yet hold them

**Decided:** Only runs receive `custom_<name>`; the wizard's own conversation
exercises a tool through `sidekick_tool_test`.

**Why:** Materializing a Sidekick's saved tools into its wizard conversation
needs the accepted definition read at the wizard's tool load, which no run
input carries today. The test tool covers the authoring loop.

**Changes:** Goal 9 is met for runs and deferred for the wizard conversation.

## Key design decisions

1. **The program's tool calls go through `HarnessTool.execute`, not around
   it.** A stub call is dispatched to the same `HarnessTool` object Bind would
   call for a direct invocation, under the same `HarnessToolContext`, so
   capability checks, connector authorization, `record_before_execute` receipts
   and `externalConversation` happen without a second implementation.
   *Rejected:* a program-level receipt with the calls recorded as a log. It
   would make a nested write invisible to replay and to the audit row.
2. **Nested receipts are child rows of the program's receipt, and writes are
   allowed because of it.** Each stub call writes a `tool_effects` row whose
   `occurrence_key` is the program effect's id plus the call index. On
   re-execution a call whose key and `request_hash` match a completed child
   returns the recorded output; a mismatch fails `code_replay_diverged`; a
   child left `executing` by an interruption is `ambiguous_external_write` and
   stops the run naming the call, which is the guarantee a direct write has
   today. *Rejected:* a read-only first version. It would have excluded the
   hosted and custom MCP tools, which are writes by policy, and so the PostHog
   case itself. *Rejected:* replaying the program's final output only; a
   program interrupted after three completed calls would re-run them.
3. **Stubs are capability handles, built per program.** The host loads the
   Dynamic Worker with one `WorkerEntrypoint` stub whose `props` carry the run
   id and program effect id, and the host-side gateway resolves the tool from
   the run's active set on every call. The program never holds a tool list or
   an id it could widen. *Rejected:* passing a tool list into `env` as data for
   the program to dispatch on.
4. **The typed API is rendered from `ToolDefinition` after
   `repairRootSchemaForProviders`.** One renderer, over the definitions the
   wire already uses, in Bind's plugin order. *Rejected:* rendering from the
   raw manifest schema, which can disagree with what the model was shown as a
   tool.
5. **Isolate identity is the program's hash.** `loader.get(sha256(code), …)`
   caches the compiled isolate, so a custom tool pays its load once a day and a
   one-off program once. *Rejected:* `load()` per call.
6. **Loop controls are refused by the gateway, not by prose.** The four tools
   in non-goal 2 are a host constant beside the plugin. *Rejected:* a
   system-prompt rule.
7. **Our own implementation.** The executor is a few hundred lines over the
   loader binding we already use for live artifacts; the renderer is a few
   hundred lines over `ToolDefinition`. The parts that matter are
   Bind-specific. See non-goal 6.
8. **A custom tool is a definition field, not a separate object.** `customTools`
   sits on `AutomationDraftSchema` beside `memoryTables`, is carried on the
   revision, and is read by a run through `readRunDefinition`. A run pinned to
   a revision keeps its tools. *Rejected:* a table with its own lifecycle; the
   memory tables needed one because a table is shared storage, and a tool is
   pure definition.
9. **The test gate is mechanical and local.** `sidekick_tool_test` runs the
   program through the executor in the wizard's conversation and buffers
   `{ name, codeHash, inputHash, testedAt }` in the authoring state the way
   `set_evaluator_rules` buffers until the next submit. `submit_draft` with
   `ready: true` refuses a tool whose `codeHash` has no buffered successful
   test. *Rejected:* checking the wizard conversation's receipts from
   WorkspaceDO at publication, a cross-object read on the publish path.
   *Rejected:* a `tested` flag the model sets.
10. **The run-time plugin is per Sidekick and preloaded.** `rally:custom-tools`
    is built in `loadHarnessTools` when the run definition carries tools, one
    `HarnessTool` per saved tool, always active for that run. Its surface hash
    includes each tool's `codeHash`, so a receipt replays only against the
    program that produced it. *Rejected:* having the run paste saved programs
    into `code_execute`; the point is that the run does not handle the code.
11. **Required plugins are declared and activated, never discovered.** A tool
    names the `requiredPlugins` its program calls; they must be bound to the
    Sidekick at publication, and the run activates them on the tool's first
    call. The gateway refuses a call to any other plugin. *Rejected:* letting
    the program call whatever the run has loaded, which makes the tool's reach
    depend on what the run did before calling it.
12. **The input schema is the tool's whole model-facing contract**, a plain
    object schema with a description per property, under the same root-object
    and nullable rules as every other tool, validated before the program runs.
    *Rejected:* a free-form `args: string`, which puts the contract back in
    prose.
13. **The program sees `input` and `tools`, nothing about the Sidekick.**
    Anything that varies per run comes through its input. *Rejected:* a
    `sidekick` context object; it is how a tool starts making decisions the
    run should make.

## Data model

No new table for the run-time tool. `tool_effects` gains no column: a nested
call is an ordinary row whose `occurrence_key` is
`${programEffectIntentId}:${callIndex}`. The program's own row is an ordinary
`write` receipt whose `input_json` is the program and whose `output_ref` is the
result. [`workstream-durable-object.md`](../../workstream-durable-object.md)
owns the receipt tables and records the nested shape when this ships.

For custom tools, `AutomationDraftSchema.customTools: SidekickCustomTool[]`,
default `[]`, carried into `AutomationRunDefinitionV1.definition.customTools`
and into the `SidekickDefinitionSchema` the profile reads. The shape and the
publication checks are in [`design.md`](design.md#sidekick-custom-tools). No
backfill: existing revisions have no tools and behave as today. The authoring
state gains the buffered test records beside the buffered evaluator rules; they
are consumed at submit.

## Regional impact

None beyond a new binding in each regional API Worker's Wrangler file. A program
runs in the region of the run that called it, against that region's connector
authority. No data crosses the boundary that did not already cross it for a
direct call.

## Security and trust model

- A program is model-authored and untrusted. It runs in a Dynamic Worker with
  `globalOutbound: null`, so `fetch` and `connect` fail, with no bindings other
  than the gateway stub, under a CPU and wall-clock limit.
- The gateway stub is a capability: it has no global name, cannot be forged,
  and resolves tools from the run's active set on every call. A program can
  call nothing the run has not loaded.
- Credentials never enter the isolate. Connector tokens are read by the
  connector executor in the API Worker, as for a direct call.
- A write from a program is a write the run could make directly, recorded the
  same way. Prompt injection reaching the model can make it write a program, as
  it can make it call a tool; the program has no more reach than the model.
- A saved tool is untrusted code that persists, written by the wizard under the
  influence of a conversation that may carry connector content. Its reach is
  bounded the same way, narrowed further to the Sidekick's bound connections,
  and its code is visible on the profile and in every run's receipts. A person
  can read what runs on their behalf. Delegation and consent are unchanged: a
  bound personal connection is usable only while its delegate's consent stands.
- A revision that changes a tool's code changes its hash, so old receipts do
  not replay against new code. The management permission that gates
  `submit_draft` gates tool changes.
- `security.md` owns the renderer boundary; nothing here touches it.

## Agent behavior

The plugin contracts, both tool catalogs with exact wire shapes, the typed API
rendering, the program environment, the failure contracts and the sequences are
in [`design.md`](design.md). In brief:

- **Plugin** `rally:code`, model id `rally_code`, wire prefix `code`, loadable
  in every run when `CODE_LOADER` is bound, never preloaded. Loading adds the
  `# Code API` prompt section and the one tool, and starts, authorizes and
  persists nothing.
- **Tool** `code_execute`, `mode: "write"`, `idempotency:
  "record_before_execute"`, serial. Input `{ code, description }`. Output
  `{ value, logs, calls, truncated }`.
- **Callable from a program:** every tool in the run's active set except
  `code_execute` itself, `load_plugin`, `load_skill` and `request_elicitation`.
- **Wizard tool** `sidekick_tool_test` in `rally:sidekicks`: runs a candidate
  tool once and buffers the successful test for `submit_draft`, which gains
  `customTools` and three refusals.
- **Run plugin** `rally:custom-tools`, model id `rally_custom_tools`, wire
  prefix `custom`, always active in the runs and wizard conversation of a
  Sidekick whose accepted revision carries tools; one `custom_<name>` tool per
  saved tool with the saved schema.
- **Failures** are typed throughout: `code_program_failed`,
  `code_program_timed_out`, `code_call_refused`, `code_call_failed`,
  `code_result_too_large`, `code_replay_diverged`, `code_budget_exhausted`,
  and the `custom_tool_*` codes, each with its sentence and allowlisted details
  in the design.

## Provider configuration

Each regional API Worker's Wrangler file and `wrangler.test.jsonc` gain a
`worker_loaders` binding named `CODE_LOADER`. The account is on Workers Paid,
which Dynamic Workers require. Dynamic Workers bill per unique Worker per day,
per request and per CPU millisecond beyond the included allowance;
[`research.md`](research.md#platform-facts) has the rates. Without the binding
neither plugin exists and runs behave as today.

## Rollout

Ships to everybody on merge, with no flag, in two phases that are each
complete on their own.

**Phase 1, the run-time tool:** the gateway and executor with nested receipts
and replay; the type renderer and prompt section; the activity row detail; the
acceptance evaluations 1 to 6. `rally_code` is loadable rather than preloaded,
so a run pays for it only when the model decides to compose. Turning it off is
removing the binding, which removes the plugin.

**Phase 2, custom tools:** the schema and publication validation;
`sidekick_tool_test` and the buffered test; the run-time plugin and surface
hash; the profile section; the guide text; evaluations 7 to 12. A Sidekick
without tools is unchanged. Turning it off is removing `sidekick_tool_test` and
the publication path; saved tools stop being materialized and runs fall back to
their instructions.

The limits this introduces (program deadline, program bytes, stub calls per
program, concurrent stub calls, result bytes, log bytes) are defensive and are
written open with the `LIMIT UNSET` marker and a handover row each, per
[`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).
The program deadline is the one that cannot ship open: an unbounded program
holds the Durable Object's I/O context, and the platform caps concurrent
Dynamic Workers per object at ten. [`design.md`](design.md#limits) gives the
arithmetic for the team to set it before merge.

## Acceptance

1. A work-stream run on the configured medium fallback model, given "list the
   Linear issues in project X updated this week and tell me which have no
   assignee", loads `rally_code`, makes one `code_execute` call, and answers
   with the filtered list. The transcript shows one Rally activity row whose
   detail lists the Linear calls.
2. A run asked for a figure that needs arithmetic over two tool results (a
   conversion rate from two counts, a sum over a page of rows) computes it in a
   program and returns the number, not the rows.
3. The same program re-run after the loop is relocated mid-program (the
   `test-workers/` suite kills the object between two nested calls) completes
   with the first calls replayed from their receipts and no duplicate provider
   request. A relocation between a nested Slack send's execution and its
   settle stops the run with `ambiguous_external_write` naming that call.
4. A program that calls `load_plugin` fails with `code_call_refused` and the
   model then calls it directly.
5. A program that loops without returning fails with `code_program_timed_out`
   inside the deadline and the run continues.
6. Schema snapshot and contract tests cover the input, the output, each failure
   shape, and the rendered API for a fixed plugin set, byte for byte.
7. In a fresh setup conversation on the primary model, asked for the PostHog
   daily signup report, the wizard saves a tool, tests it, and submits. The
   profile shows the tool with its code.
8. The Sidekick's next five scheduled runs on the configured medium fallback
   model each call the tool once, make at most eight tool calls and at most
   six model calls in total, and post the report. None blocks on a
   cross-source check, because the check is in the tool.
9. Submitting a tool whose code was changed after its last test is refused
   with `custom_tool_untested`, naming the tool.
10. A tool naming a plugin the Sidekick is not bound to is refused at test with
    `custom_tool_plugin_unbound`.
11. Disconnecting the PostHog connection makes the next run fail the tool with
    `custom_tool_unavailable` and post the unavailability where its
    instructions say; reconnecting restores it with no revision.
12. A prompt evaluation on the medium fallback model covers: a run choosing the
    custom tool over `code_execute` and over direct discovery; the failure step
    after `custom_tool_failed`; no hand reconstruction of the method.

## Open questions

1. **Concurrency inside a program.** `Promise.all` over stub calls is natural
   JavaScript. The gateway serializes tools flagged `serial` and runs others
   concurrently up to a cap written open. Whether connectors tolerate the
   concurrency a program can generate is a provider question the first
   production trip decides.
2. **Pagination inside a program.** `_next` tools are offered as stubs so a
   program can loop pages. Whether to add an async iterator helper depends on
   how often programs page; decide after the first ten programs.
3. **What the profile shows a member who may not manage the Sidekick.** Code is
   readable to everyone who can read the Sidekick; whether a guest in the
   owning Thread counts is a listing-rules question
   ([`listing-rules.md`](../../listing-rules.md)) to settle before the profile
   section is built. It does not block the run-time work.
4. **Whether the review may add a tool, not only change one.** The review's
   rules forbid adding a plugin or capability; a tool over already-bound
   plugins adds neither. Decide when the first review proposes one.
