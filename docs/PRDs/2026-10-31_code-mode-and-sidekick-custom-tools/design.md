# Code Mode and custom tools design

> Companion to [`prd.md`](prd.md). The plugin contracts, the tools' wire
> shapes, the program environment, the rendered API, the stub gateway, nested
> receipts and replay, the failure contracts, the custom tool schema and its
> publication checks, and the limits. Written against
> [`agent-tools.md`](../../agent-tools.md) and
> [`agent-harness.md`](../../agent-harness.md).

## Plugin contract: `rally:code`

| Field | Value |
| --- | --- |
| `canonicalId` | `rally:code` |
| `modelId` | `rally_code` |
| `shortWireName` | `code` |
| `displayName` | Code |
| Activity group | Rally (folded with the other first-party plugins per [`plugin-activity-rows.md`](../../plugin-activity-rows.md)) |
| Availability | Every run whose `Env` has `CODE_LOADER`. Absent otherwise, with no catalog line. |
| Preload | Never. Loadable through `load_plugin`, like `rally_web`. |
| Authority | None of its own. A program acts under the run's execution principal through the tools the run already holds. |
| Tool order | `execute` |

Catalog line, as the model sees it before loading:

> Compose several tool calls, or compute over their results, in one JavaScript
> program: dependent calls, loops, math, filtering and shaping, when the answer
> the conversation needs is smaller than the data it takes to compute. A single
> call is made directly.

System message added on load (high salience, exact):

```
# Code
code_execute runs one JavaScript program you write against the typed API in
# Code API. Use it when several calls depend on each other, when you would loop
over results, when you need arithmetic or date math done exactly, or when you
would read more than you need and discard most of it. Make a single call
directly.

The program is the body of an async function. `tools` holds the API, grouped by
plugin; every tool you hold is there, reads and writes alike. Plain JavaScript
is available: Math, Date, JSON, Intl, strings, arrays, regular expressions. A
program with no tool call is fine when the work is computation. `return` the
smallest value that answers the question; the value, not the data, enters your
context. Throw an Error for a condition you cannot handle; its message reaches
you. console.log output is returned, bounded.

Each tool call inside the program is a real call with its own record. A write
made from a program is made for real; compute first and write last, so a
failure before the write leaves nothing half done. A program re-run after an
interruption replays calls that already completed, so keep it deterministic: no
Date.now() or Math.random() in a value that reaches a tool. A failed program
says which call failed, which writes stand, and what to do; correct the program
rather than re-sending it.
```

Loading the plugin also adds `# Code API`, rendered as described under
[Rendered API](#rendered-api). Nothing is activated, authorized or persisted by
loading beyond Bind's ordinary plugin activation hint.

## Tool catalog: `code_execute`

| Canonical | Wire | Capability | Mode | Idempotency | Timeout | Serial |
| --- | --- | --- | --- | --- | --- | --- |
| `execute` | `code_execute` | `code.program.execute` | `write` | `record_before_execute` | `CODE_PROGRAM_DEADLINE_MS` plus a fixed load allowance | yes |

`mode` is `write` because a program may call any write the run holds. The
program's own receipt is `record_before_execute`: if the host loses the result
after nested calls executed, the program is `ambiguous_external_write` and the
run stops with the receipt naming the calls that completed, exactly as a
direct write does today.

### Input

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["code", "description"],
  "properties": {
    "code": {
      "type": "string",
      "minLength": 1,
      "maxLength": "<CODE_PROGRAM_MAX_BYTES>",
      "description": "The body of an async JavaScript function. `tools` is in scope; `return` the answer. ES2023, no imports, no fetch, no timers longer than the deadline."
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 240,
      "description": "One participant-facing line saying what the program does. Shown on the activity row; it does not affect execution."
    }
  }
}
```

The executor's first statement parses the same shape with a strict zod object,
and `validateInput` points at that parser, per checklist item 12 in
[`agent-tools.md`](../../agent-tools.md#checklist-for-a-new-tool).

### Output

```json
{
  "value": "<the program's return value, JSON>",
  "logs": [{ "level": "log" | "warn" | "error", "text": "..." }],
  "calls": [
    { "index": 0, "tool": "plugin_linear.list_issues", "mode": "read", "ms": 412, "outcome": "completed" | "failed" | "replayed" }
  ],
  "truncated": { "logs": false }
}
```

`value` is serialized with `JSON.stringify`; `undefined` becomes `null`. When
the serialized value exceeds `CODE_RESULT_MAX_BYTES` the tool fails with
`code_result_too_large` rather than cutting it, since a cut JSON value is not a
value. Logs are truncated with the marker from `truncateTextWithMarker` and
`truncated.logs` is set.

`calls` is the next-step material: a model that sees `failed` at index 3 knows
which call to look at, `mode: "write"` with `completed` tells it which effects
stand, and `replayed` tells it a re-run reused a record.

### Program environment

The host wraps the model's code as the body of
`export default async function run(tools, console)` in a `program.js` module.
The isolate's main module is a host-authored entry that imports `program.js`,
builds `tools` from the gateway stub, captures console output, enforces the
deadline with an `AbortSignal`, serializes the return value and reports back.
The program sees:

- `tools`: the typed namespaces below. Each function returns
  `Promise<unknown>`, the tool's `output` parsed from JSON.
- Plain JavaScript for computation: `Math`, `Date`, `Intl`, `JSON`, `String`,
  `Array`, `Map`, `Set`, `RegExp`, `BigInt`, `structuredClone`, `TextEncoder`,
  `TextDecoder`, `URL`, `URLSearchParams`, `crypto.subtle` for hashing. A
  program with zero tool calls is valid and is how a model gets a sum, a rate, a
  date difference or a sort done exactly rather than estimated.
- `console.log`, `console.warn`, `console.error`: captured, bounded by
  `CODE_LOG_MAX_BYTES`.
- Not available: `fetch`, `connect`, `caches`, `env`, `import()`, timers
  beyond the deadline, WebAssembly.

The Dynamic Worker is loaded with:

```ts
const worker = env.CODE_LOADER.get(`code:${sha256(code)}`, () => ({
  compatibilityDate: "2026-08-01",
  mainModule: "entry.js",
  modules: { "entry.js": ENTRY_SOURCE, "program.js": wrap(code) },
  env: { GATEWAY: ctx.exports.CodeToolGateway({ props: { harnessRunId, programEffectIntentId, callBudget, allowedPluginIds } }) },
  globalOutbound: null,
}));
```

`props` are readable only by the loader side. The program receives the stub and
nothing about the run. `allowedPluginIds` is `null` for `code_execute` (the
run's active set applies) and the saved `requiredPlugins` for a custom tool.

## Rendered API

`# Code API` is a TypeScript declaration block rendered from the run's active
plugins at prompt-build time, in Bind's plugin order (canonical id) and then by
canonical tool name. It is re-rendered on every model call from the current
active set, like the tool list, so a `load_plugin` mid-run adds its namespace
on the next turn. The rendering is a pure function of the corrected
`ToolDefinition`s (after `repairRootSchemaForProviders`), so a resumed attempt
produces the same bytes as a fresh one.

Namespace is the plugin's `modelId`; function is the canonical tool name; the
parameter type is the tool's `inputSchema` rendered to TypeScript; the
description becomes a doc comment carrying the tool's mode; required properties
are non-optional.

```ts
declare const tools: {
  /** Linear: issues, projects, comments. */
  plugin_linear: {
    /** read. List issues in a project or team. Returns a page; pass the pageId from the result to list_issues_next for more. */
    list_issues(input: { project?: string; team?: string; state?: "open" | "closed" | "all"; limit?: number }): Promise<unknown>;
    list_issues_next(input: { pageId: string }): Promise<unknown>;
    /** write. Create one issue. */
    create_issue(input: { team: string; title: string; description?: string | null }): Promise<unknown>;
  };
  /** PostHog analytics, as a CLI-style exec. */
  plugin_mcp_posthog_4: {
    /** write. Pass CLI-style commands: `info <tool>`, `call <tool> <json>`, `learn ...`. */
    exec(input: { command: string; context?: string }): Promise<unknown>;
  };
};
```

Rendering rules:

- `type: [T, "null"]` and `anyOf` with a null branch render as `T | null`.
- `enum` renders as a union of literals.
- Nested objects render inline; arrays as `T[]`.
- A property with no description renders with none; the schema rule that every
  parameter has one is enforced upstream.
- The four loop controls are not rendered. The model cannot see a function it
  cannot call.
- Authored `_next` tools are rendered beside their source so a program can
  page; the cursor-stripping rule of
  [`tool-pagination.md`](../../tool-pagination.md) is unchanged.
- A tool that returns `contentParts` (an image) renders with a note that only
  its JSON output reaches a program.

The renderer is a schema snapshot test subject: a fixed plugin set renders to a
checked-in string.

## What a program may call

Every tool in the run's active set, reads and writes, Terminal and
`start_agent` included, with four exceptions that are loop controls rather than
work: `code_execute` itself, `load_plugin`, `load_skill` and
`request_elicitation`. Their results are Bind control signals (`halt`,
`loadedPluginName`, `loadedSkillRef`), not data. The list is a host constant
beside the plugin, not prose. A call to one fails `code_call_refused` with the
instruction to call it directly. A custom tool narrows this further to its
`requiredPlugins`.

## The gateway

`CodeToolGateway` is a `WorkerEntrypoint` exported by the API Worker. The
program's entry module calls `GATEWAY.call(pluginModelId, toolName, input)`.
The gateway, on the host side:

1. Reads `harnessRunId`, `programEffectIntentId`, `callBudget` and
   `allowedPluginIds` from `ctx.props`. Nothing the program sends identifies
   the run.
2. Resolves the run's active plugin set and the named tool. Not found, a loop
   control, or outside `allowedPluginIds` fails `code_call_refused` with
   `available` listing that plugin's callable wire names, bounded.
3. Assigns the call index from a per-program counter and computes the
   `request_hash` over the canonicalized input.
4. Looks up a child receipt with `occurrence_key =
   ${programEffectIntentId}:${index}`. A completed child with the same
   `request_hash` returns its recorded output and marks the call `replayed`. A
   completed child with a different hash fails `code_replay_diverged`. A child
   left `executing` is the ambiguous case: the gateway fails the program with
   `ambiguous_external_write` naming the call, and the run stops, as a direct
   write in that state does.
5. Otherwise records the child receipt under the tool's own idempotency class
   (`record_before_execute` for a write, `safe` for a read), builds a
   `HarnessToolContext` from the run's, and calls the same `HarnessTool.execute`
   Bind would call. Settles the receipt with the result.
6. Returns `output` to the program. `summary`, `contentParts`,
   `externalConversation` and `pagination` stay host-side: `externalConversation`
   is recorded on the child receipt and forwarded to the run's completion event
   so a Slack send from a program binds replies as a direct send does;
   `contentParts` are dropped for the program, which receives the JSON output
   only.

`serial` tools are dispatched one at a time per program; others run
concurrently up to `CODE_CONCURRENT_CALLS_MAX`. Each call's duration and mode
are recorded for the `calls` output and the activity row.

Receipt replay at the top level is unchanged: when Bind replays the program's
own completed receipt it returns the recorded output and never re-enters the
isolate.

## Execution sequence

1. Model calls `code_execute({ code, description })`.
2. Bind records the program receipt (`record_before_execute`).
3. The executor loads or reuses the isolate keyed by the program hash, with a
   fresh gateway stub carrying this program's effect id.
4. The program runs under the deadline. Each `tools.*` call travels to the
   gateway, which records, executes or replays, and answers.
5. On return, the executor serializes the value, bounds the logs, assembles
   `calls`, and settles the program receipt with the output.
6. On throw, timeout or refusal, the executor throws the typed failure; Bind
   projects `{ success: false }` with the sentence and allowlisted details. The
   details name the writes that completed before the failure.
7. If the object is relocated between 3 and 5, the resumed attempt finds the
   program receipt `executing`, re-enters from step 3, and the gateway replays
   completed children. An interruption after a nested write executed but
   before its child receipt settled yields `ambiguous_external_write`, which
   stops the run with that call named.

## Failure contract: `code_execute`

Every failure is a typed error with a stable code, a model-visible sentence
carrying the shortest safe next action, and only allowlisted `details`
(`reason`, `field`, `expected`, `available`, `retryAfterMs`). Where writes
completed before the failure, `reason` ends with "Completed writes: `<tool>`
at `<index>`, …" so the model never repeats them.

| Code | Sentence (model-visible `error`) | `details` | Model should |
| --- | --- | --- | --- |
| `code_program_failed` | The program threw at call `<index>` (`<tool>`): `<message, bounded>`. Fix the program and run it again; do not repeat the completed writes it names. | `reason`, `field: "code"` | Correct and retry once. |
| `code_program_timed_out` | The program did not finish within `<deadline>` ms after `<n>` calls. Split the work into smaller programs or call the tools directly; do not repeat the completed writes it names. | `reason`, `retryAfterMs: 0` | Split; do not resend the same program. |
| `code_call_refused` | `<plugin>.<tool>` cannot be called from a program: `<why: loop control / not loaded / outside this tool's plugins>`. Call it directly. | `reason`, `field: "<plugin>.<tool>"`, `available` | Remove the call; make it directly. |
| `code_call_failed` | Call `<index>` (`<tool>`) failed: `<the tool's own error sentence>`. The program stopped there. | the tool's own forwarded details | Follow the inner tool's instruction; then rerun. |
| `code_result_too_large` | The return value is `<bytes>` bytes; the limit is `<max>`. Return the answer, not the data: aggregate or select fields. | `reason`, `field: "return"`, `expected: "<= <max> bytes"` | Shrink the return. |
| `code_replay_diverged` | Call `<index>` (`<tool>`) sent different arguments on re-run than the completed record. Remove nondeterminism (time, randomness) from arguments and run again. | `reason`, `field: "code"` | Make the program deterministic. |
| `code_budget_exhausted` | The program made `<max>` calls, the most one program may make. Do less per program or page less. | `reason`, `expected: "<= <max> calls"` | Reduce calls. |

`ambiguous_external_write` is the harness's existing outcome, not a new code; it
stops the run as it does for a direct write.

A program that returns normally with a value the model finds unhelpful is not a
failure; the model writes a better program. `summary` on success is the
description plus the call count, for the activity row only.

Validation of `{ code, description }` against the advertised schema produces
`kind: "validation"` through the harness's existing path.

## Sidekick custom tools

### Schema

```ts
const SidekickCustomToolSchema = z.strictObject({
  /** Lower snake case, unique within the Sidekick; the wire name is `custom_<name>`. */
  name: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  /** Model-facing: what it does, what it returns, and when to call it. */
  description: z.string().trim().min(1).max(800),
  /** A plain object JSON Schema with a described property per input. */
  inputSchema: ToolInputObjectSchema,
  /** The body of an async function with `input` and `tools` in scope. */
  code: z.string().min(1).max(CUSTOM_TOOL_CODE_MAX_BYTES),
  /** Model plugin ids the program calls; each must be bound to the Sidekick. */
  requiredPlugins: z.array(ModelPluginIdSchema).min(1).max(8),
});
```

`AutomationDraftSchema.customTools: z.array(SidekickCustomToolSchema).default([])`,
carried into `AutomationRunDefinitionV1.definition.customTools` and
`SidekickDefinitionSchema`.

Publication validates: unique names (case-insensitive, like memory tables);
every `requiredPlugins` entry present in `defaultPluginIds` or
`connectorBindings`; `inputSchema` passes the same root-object repair and
nullable rule as a connector tool, with a description on every property; a
buffered successful test exists for `sha256(code)`; `triggers` is non-empty. A
failure names the tool and the field through `describeZodIssues`.

### Wizard tool: `sidekick_tool_test`

Added to `rally:sidekicks` (wire prefix `sidekick_`), available wherever
`submit_draft` is: the wizard's Main and the background agents it starts. Tool
order: after `set_evaluator_rules`, before `sidekicks_list`.

| Field | Value |
| --- | --- |
| Canonical | `tool_test` |
| Wire | `sidekick_tool_test` |
| Capability | `sidekick.tools.test` |
| Mode | `write` |
| Idempotency | `record_before_execute` |
| Timeout | `CODE_PROGRAM_DEADLINE_MS` plus the load allowance |
| Serial | yes |

Description: "Run a candidate custom tool once, for real, and buffer the
successful test for the next submit_draft. Pass the whole tool and a
representative input. Writes it makes are made. A tool whose code has no
successful test is refused at submit."

Input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tool", "input"],
  "properties": {
    "tool": { "$ref": "SidekickCustomTool", "description": "The tool as it will be submitted: name, description, inputSchema, code, requiredPlugins." },
    "input": { "type": "object", "description": "Arguments a run would pass, matching tool.inputSchema. Validated before the program runs." }
  }
}
```

Output: the `code_execute` output plus `codeHash` and `testedAt`. The same
`codeHash` is what `submit_draft` checks. The program runs with
`allowedPluginIds = tool.requiredPlugins`, so a test exercises the same reach a
run will have.

Failures: the `code_execute` vocabulary for the program itself, plus:

| Code | Sentence | `details` |
| --- | --- | --- |
| `custom_tool_input_invalid` | `input` does not match `tool.inputSchema` at `<path>`: `<issue>`. Fix the input or the schema and test again. | `field`, `reason` |
| `custom_tool_plugin_unbound` | `<plugin>` is not bound to this Sidekick. Bind it through the connector steps or remove it from requiredPlugins. | `field: "requiredPlugins"`, `available` (bound plugin ids) |
| `custom_tool_schema_invalid` | `inputSchema` must be a plain object schema with a description on every property; `<path>` `<issue>`. | `field`, `reason` |

A failed test buffers nothing. A successful test replaces any earlier buffered
test for the same tool name.

### Wizard tool: `submit_draft`

`customTools` joins the draft. New refusals, each naming the tool:

| Code | Sentence |
| --- | --- |
| `custom_tool_untested` | Tool `<name>` has no successful sidekick_tool_test for its current code. Test it with representative input, then submit. |
| `custom_tool_on_instruction_only` | Tool `<name>` cannot be saved on an instruction-only Sidekick; add a trigger or remove the tool. |
| `custom_tool_name_conflict` | Tool name `<name>` is used twice. Names are unique within a Sidekick. |

The authoring guide's "Choose triggers and test the method" section gains:
"When the tested method is work every run repeats, save it as a custom tool:
declare its input, write the program against the tools you used, test it with
sidekick_tool_test, and in the instructions tell runs to call it and what to do
when it fails. A test performs its writes; parameterize the write step off, or
point it at a scratch destination, when a real delivery is not wanted during
setup. Keep judgement in the instructions; put the deterministic part in the
tool."

### Run plugin: `rally:custom-tools`

| Field | Value |
| --- | --- |
| `canonicalId` | `rally:custom-tools` |
| `modelId` | `rally_custom_tools` |
| `shortWireName` | `custom` |
| Activity group | the Sidekick's own name, as its other rows |
| Availability | Runs and the wizard conversation of a Sidekick whose accepted revision carries tools, when `CODE_LOADER` is bound. Absent otherwise. |
| Preload | Always active in those runs. |
| Tool order | the revision's `customTools` order |

System message (exact): "Custom tools were written and tested for this
Sidekick. Prefer one over rediscovering its method. A failed custom tool names
the call that failed and the writes that stand; follow the instructions'
failure step rather than reconstructing the method by hand."

Each saved tool becomes:

| Field | Value |
| --- | --- |
| Canonical | `<name>` |
| Wire | `custom_<name>` |
| Description | the saved description |
| Capability | `sidekick.tools.run` |
| Mode | `write` |
| Idempotency | `record_before_execute` |
| Timeout | `CODE_PROGRAM_DEADLINE_MS` plus the load allowance |
| Input | the saved `inputSchema`, after root repair, validated strictly |
| Output | the `code_execute` output |

Execution: validate input against the saved schema; activate `requiredPlugins`
if not yet active (the same path `load_plugin` takes, recorded as an activation
hint); run the program through the executor with `allowedPluginIds =
requiredPlugins`; settle. Nested calls are child receipts of the tool's
receipt, so `sidekick_runs_read` shows the wizard every call a tool made. The
plugin's surface hash includes each tool's `codeHash`.

Failures: the `code_execute` vocabulary, with `custom_tool_` codes where the
cause is the saved tool rather than the run:

| Code | Sentence | `details` |
| --- | --- | --- |
| `custom_tool_unavailable` | `custom_<name>` needs `<plugin>`, whose connection is not available to this run. Post that the tool is unavailable where your instructions say, and stop this step. | `reason`, `field` |
| `custom_tool_failed` | `custom_<name>` failed at call `<index>` (`<tool>`): `<message>`. Completed writes: `<list or none>`. Do not rebuild its method by hand; follow the failure step in your instructions. | `reason`, `field` |
| `custom_tool_timed_out` | `custom_<name>` did not finish within `<deadline>` ms. Completed writes: `<list or none>`. Follow the failure step in your instructions. | `reason` |
| `custom_tool_result_too_large` | `custom_<name>` returned more than `<max>` bytes. This is a tool defect; follow the failure step and say so, so the review can fix the tool. | `reason` |

The instruction to the run is "follow the failure step", not "retry": a saved
tool that fails is a defect for the review, and the research shows a run that
reconstructs a method by hand is the slow, blocking path.

### Sequences

Authoring: `plugins_list` → `load_plugin` (the data plugin) → investigate with
its tools → write the tool → `sidekick_tool_test` → read `value`, fix, repeat →
`submit_draft` with `customTools` and instructions that name the tool.

Run: `current_time` → `custom_posthog_daily_signup_report({ reportDate })` →
format → `conversation_post` or the Slack send, or the tool does the send
itself as its last call when the wizard wrote it that way.

Review: `sidekick_runs_read` (shows the tool's child calls) → change the
program → `sidekick_tool_test` → `submit_draft`.

## Limits

All defensive, all written open with `LIMIT UNSET` and one definition site, per
[`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).
The deadline is the one to set before merge because `Number.POSITIVE_INFINITY`
is not inert there: an unbounded program holds the object's I/O context.

| Constant | Bounds | Open value | On trip | Derive from |
| --- | --- | --- | --- | --- |
| `CODE_PROGRAM_DEADLINE_MS` | wall clock of one program | not safe open | `code_program_timed_out`, run continues | Observed PostHog SQL calls take 2 to 9 s each and a report needs 4 to 7, so 60 s covers it; Cloudflare's default is 30 s; the harness tool timeout cap is 1,050,000 ms; ten concurrent Dynamic Workers per object. A program that calls Terminal `run_command` inherits that tool's own deadline inside this one. |
| `CODE_PROGRAM_MAX_BYTES` and `CUSTOM_TOOL_CODE_MAX_BYTES` | bytes of `code` | `+Infinity` | validation failure | Terminal `run_command` accepts 32 KiB; a program is shorter. |
| `CODE_CALLS_MAX` | stub calls per program | `+Infinity` | `code_budget_exhausted` | The largest observed run makes 46 calls total. |
| `CODE_CONCURRENT_CALLS_MAX` | in-flight stub calls per program | `+Infinity` (serial tools excepted) | queued, not failed | Provider rate limits; start with the connector that trips first. |
| `CODE_RESULT_MAX_BYTES` | serialized return value | `+Infinity` | `code_result_too_large` | A tool result the model would otherwise read; 80,000 chars is the hosted MCP string bound. |
| `CODE_LOG_MAX_BYTES` | captured console output | `+Infinity` | truncated with marker | Same as result. |

## Receipts, activity rows and the wizard

- The program's receipt and its child receipts are ordinary `tool_effects`
  rows, so `sidekick_runs_read` shows a Sidekick's wizard each nested call with
  its arguments and outcome, which is what a review needs to fix a program.
- The activity row is one row for `rally:code` (or for the Sidekick's custom
  tool), titled by `description`. Its detail lists `calls` with each call's
  mode and shows `code`. The plugin-activity rule that a row covers one plugin
  per stretch holds because the nested calls belong to the program's row.
  [`plugin-activity-rows.md`](../../plugin-activity-rows.md) records this when
  it ships.
- `pluginSurfaceHashes` for `rally:code` cover the callable-tool rule and the
  renderer version; for `rally:custom-tools` they include each tool's
  `codeHash`. A changed rendering or program invalidates replay of old receipts
  the way a changed connector surface does.

## Testing

- `test-workers/`: the gateway against a real Durable Object, including the
  relocation case (kill the object between two nested calls; the re-run replays
  the first) and the ambiguous case (kill between a nested write's execution
  and its settle; the run stops with the call named).
- Node: the renderer snapshot for a fixed plugin set; the callable-tool
  constant against every built-in plugin; the failure shapes; the custom tool
  schema and every publication refusal; the materialized `custom_<name>`
  definition for a fixed saved tool.
- Prompt evaluation on the configured medium fallback model: discovery (loads
  the plugin for a compose task, does not for a single call), a zero-call
  arithmetic program, one successful two-plugin program with a write last, a
  refused loop control followed by the direct call, a timeout followed by a
  split, no blind resend of a failed program, a run choosing a custom tool over
  rediscovery, and the failure step after `custom_tool_failed`.
- Each integration test is broken once in production code (drop the child
  receipt write; skip the loop-control check; skip the test gate) to prove it
  fails for the reason its name claims, per
  [`testing.md`](../../testing.md#prove-the-test-can-fail).
