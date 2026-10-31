# Code Mode design

> Companion to [`prd.md`](prd.md). The plugin contract, the one tool's wire
> shape, the rendered API, the stub gateway, nested receipts and replay, the
> failure contract, and the limits. Written against
> [`agent-tools.md`](../../agent-tools.md) and
> [`agent-harness.md`](../../agent-harness.md).

## Plugin contract

| Field | Value |
| --- | --- |
| `canonicalId` | `rally:code` |
| `modelId` | `rally_code` |
| `shortWireName` | `code` |
| `displayName` | Code |
| Activity group | Rally (folded with the other first-party plugins per [`plugin-activity-rows.md`](../../plugin-activity-rows.md)) |
| Availability | Every run whose `Env` has `CODE_LOADER` and whose eligible plugin set contains at least one stub-eligible tool. Absent otherwise, with no catalog line. |
| Preload | Never. Loadable through `load_plugin`, like `rally_web`. |
| Authority | None of its own. A program acts under the run's execution principal through the tools the run already holds. |
| Tool order | `execute` |

Catalog line, as the model sees it before loading:

> Compose several tool calls in one JavaScript program: dependent reads, loops,
> filtering and shaping, when the answer the conversation needs is smaller than
> the data it takes to compute. Load only for that; a single call or a write is
> made directly.

System message added on load (high salience, exact):

```
# Code
code_execute runs one JavaScript program you write against the typed API in
# Code API. Use it when several calls depend on each other, when you would loop
over results, or when you would read more than you need and discard most of it.
Call a tool directly for one call, and for any write: a program cannot send,
create, or update anything outside Rally and refuses the attempt by name.

The program is the body of an async function. `tools` holds the API, grouped by
plugin. `return` the smallest value that answers the question; the value, not
the data, enters your context. Throw an Error to report a condition you cannot
handle; its message reaches you. console.log output is returned, bounded.

Each tool call inside the program is a real call with its own record. A program
re-run after an interruption replays calls that already completed, so keep it
deterministic: no Date.now() or Math.random() in a value that reaches a tool.
A failed program says which call failed and what to do; correct the program
rather than re-sending it.
```

Loading the plugin also adds `# Code API`, rendered as described under
[Rendered API](#rendered-api). Nothing is activated, authorized or persisted by
loading beyond Bind's ordinary plugin activation hint.

## Tool catalog

One tool.

| Canonical | Wire | Capability | Mode | Idempotency | Timeout | Serial |
| --- | --- | --- | --- | --- | --- | --- |
| `execute` | `code_execute` | `code.program.execute` | `write` | `record_before_execute` | `CODE_PROGRAM_DEADLINE_MS` plus a fixed load allowance | yes |

`mode` is `write` because a program may call hosted or custom MCP tools, which
are `write` by policy ([`hosted-mcp-connectors.md`](../../hosted-mcp-connectors.md)).
The program's own receipt is `record_before_execute` for the same reason: if
the host loses the result after nested calls executed, the program is
`ambiguous_external_write` and the run stops with the receipt naming the calls
that completed, exactly as a direct MCP call does today.

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
      "description": "One participant-facing line saying what the program computes. Shown on the activity row; it does not affect execution."
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
    { "index": 0, "tool": "plugin_linear.list_issues", "ms": 412, "outcome": "completed" | "failed" | "replayed" }
  ],
  "truncated": { "value": false, "logs": false }
}
```

`value` is serialized with `JSON.stringify`; `undefined` becomes `null`. When
the serialized value exceeds `CODE_RESULT_MAX_BYTES` the tool does not truncate
it silently: it fails with `code_result_too_large` so the model shrinks the
return, since a cut JSON value is not a value. Logs are truncated with the
marker from `truncateTextWithMarker` and `truncated.logs` is set.

`calls` is the next-step material: a model that sees `failed` at index 3 knows
which call to look at; `replayed` tells it a re-run reused a record.

### Program environment

The host wraps the model's code as the body of `export default async function
run(tools, console)` in a `program.js` module. The isolate's main module is a
host-authored entry that imports `program.js`, builds `tools` from the gateway
stub, captures console output, enforces the deadline with an `AbortSignal`,
serializes the return value and reports back. The program sees:

- `tools`: the typed namespaces below. Each function returns
  `Promise<unknown>`, the tool's `output` parsed from JSON.
- `console.log`, `console.warn`, `console.error`: captured, bounded by
  `CODE_LOG_MAX_BYTES`.
- Standard ECMAScript globals. No `fetch`, no `connect`, no `crypto.subtle`
  beyond hashing, no `caches`, no `env`.

The Dynamic Worker is loaded with:

```ts
const worker = env.CODE_LOADER.get(`code:${sha256(code)}`, () => ({
  compatibilityDate: "2026-08-01",
  mainModule: "entry.js",
  modules: { "entry.js": ENTRY_SOURCE, "program.js": wrap(code) },
  env: { GATEWAY: ctx.exports.CodeToolGateway({ props: { harnessRunId, programEffectIntentId, callBudget } }) },
  globalOutbound: null,
}));
```

`props` are readable only by the loader side. The program receives the stub and
nothing about the run.

## Rendered API

`# Code API` is a TypeScript declaration block rendered from the run's active
plugins at prompt-build time, in Bind's plugin order (canonical id) and then by
canonical tool name. It is re-rendered on every model call from the current
active set, like the tool list, so a `load_plugin` mid-run adds its namespace
on the next turn. The rendering is a pure function of the corrected
`ToolDefinition`s (after `repairRootSchemaForProviders`), so a resumed attempt
produces the same bytes as a fresh one.

Namespace is the plugin's `modelId`; function is the canonical tool name;
the parameter type is the tool's `inputSchema` rendered to TypeScript; the
description becomes a doc comment; required properties are non-optional.

```ts
declare const tools: {
  /** Linear: issues, projects, comments. */
  plugin_linear: {
    /** List issues in a project or team. Returns a page; pass the pageId from the result to list_issues_next for more. */
    list_issues(input: { project?: string; team?: string; state?: "open" | "closed" | "all"; limit?: number }): Promise<unknown>;
    list_issues_next(input: { pageId: string }): Promise<unknown>;
  };
  /** PostHog analytics, as a CLI-style exec. */
  plugin_mcp_posthog_4: {
    /** Pass CLI-style commands: `info <tool>`, `call <tool> <json>`, `learn ...`. */
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
- A tool excluded from stubs is not rendered. The model cannot see a function it
  cannot call.
- Authored `_next` tools are rendered beside their source so a program can
  page; the cursor-stripping rule of
  [`tool-pagination.md`](../../tool-pagination.md) is unchanged.

The renderer is a schema snapshot test subject: a fixed plugin set renders to a
checked-in string.

## Stub eligibility

A tool is stub-eligible when all of these hold:

1. Its plugin is in the run's active set at the time of the call.
2. Its `mode` is `read`, or its plugin is a hosted or custom MCP connection.
3. Its plugin is not one of `rally_core`, `rally_discovery`, `rally_skills`,
   `rally_code`, `rally_terminal`, the agent-communication plugin, or
   `rally_sidekicks`.
4. It is not `request_elicitation`, `start_agent`, `reply_to_message`, or any
   tool whose result carries `halt`.

The list is a host constant beside the plugin, not prose. A call to anything
else fails `code_call_refused`.

## The gateway

`CodeToolGateway` is a `WorkerEntrypoint` exported by the API Worker. The
program's entry module calls `GATEWAY.call(pluginModelId, toolName, input)`.
The gateway, on the host side:

1. Reads `harnessRunId`, `programEffectIntentId` and `callBudget` from
   `ctx.props`. Nothing the program sends identifies the run.
2. Resolves the run's active plugin set and the named tool. Not found or not
   eligible fails `code_call_refused` with `available` listing the eligible
   wire names of that plugin, bounded.
3. Assigns the call index from a per-program counter and computes the
   `request_hash` over the canonicalized input.
4. Looks up a child receipt with `occurrence_key =
   ${programEffectIntentId}:${index}`. A completed child with the same
   `request_hash` returns its recorded output and marks the call `replayed`. A
   completed child with a different hash fails `code_replay_diverged`.
5. Otherwise records the child receipt (`record_before_execute` for writes,
   `safe` for reads, per the tool's own idempotency), builds a
   `HarnessToolContext` from the run's, and calls the same `HarnessTool.execute`
   Bind would call. Settles the receipt with the result.
6. Returns `output` to the program. `summary`, `contentParts`,
   `externalConversation` and `pagination` stay host-side: `externalConversation`
   is recorded on the child receipt so the run's reply binding behaves as for a
   direct call; `contentParts` (images) are not deliverable into a program and
   the tool is therefore not stub-eligible when it declares them.

`serial` tools are dispatched one at a time per program; others run
concurrently up to `CODE_CONCURRENT_CALLS_MAX`. Each call's duration is
recorded for the `calls` output and the activity row.

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
   projects `{ success: false }` with the sentence and allowlisted details.
7. If the object is relocated between 3 and 5, the resumed attempt finds the
   program receipt `executing`, re-enters from step 3, and the gateway replays
   completed children. Only an interruption after a nested MCP write executed
   but before its child receipt settled yields `ambiguous_external_write`,
   which stops the run with that call named.

## Failure contract

Every failure is a typed error with a stable code, a model-visible sentence
carrying the shortest safe next action, and only allowlisted `details`
(`reason`, `field`, `expected`, `available`, `retryAfterMs`).

| Code | Sentence (model-visible `error`) | `details` | Model should |
| --- | --- | --- | --- |
| `code_program_failed` | The program threw at call `<index>` (`<tool>`): `<message, bounded>`. Fix the program and run it again. | `reason` (the bounded message), `field: "code"` | Correct and retry once. |
| `code_program_timed_out` | The program did not finish within `<deadline>` ms after `<n>` calls. Split the work into smaller programs or call the tools directly. | `reason`, `retryAfterMs: 0` | Split; do not resend the same program. |
| `code_call_refused` | `<plugin>.<tool>` cannot be called from a program: `<why: write tool / not loaded / control tool>`. Call it directly after the program returns. | `reason`, `field: "<plugin>.<tool>"`, `available` (eligible wire names, bounded) | Remove the call; make it directly. |
| `code_call_failed` | Call `<index>` (`<tool>`) failed: `<the tool's own error sentence>`. The program stopped there. | the tool's own forwarded details | Follow the inner tool's instruction; then rerun. |
| `code_result_too_large` | The return value is `<bytes>` bytes; the limit is `<max>`. Return the answer, not the data: aggregate or select fields. | `reason`, `field: "return"`, `expected: "<= <max> bytes"` | Shrink the return. |
| `code_replay_diverged` | Call `<index>` (`<tool>`) sent different arguments on re-run than the completed record. Remove nondeterminism (time, randomness) from arguments and run again. | `reason`, `field: "code"` | Make the program deterministic. |
| `code_budget_exhausted` | The program made `<max>` calls, the most one program may make. Do less per program or page less. | `reason`, `expected: "<= <max> calls"` | Reduce calls. |

A program that returns normally with a value the model finds unhelpful is not a
failure; the model writes a better program. `summary` on success is the
description plus the call count, for the activity row only.

Validation of `{ code, description }` against the advertised schema produces
`kind: "validation"` through the harness's existing path.

## Limits

All defensive, all written open with `LIMIT UNSET` and one definition site, per
[`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).
The deadline is the one to set before merge because `Number.POSITIVE_INFINITY`
is not inert there: an unbounded program holds the object's I/O context.

| Constant | Bounds | Open value | On trip | Derive from |
| --- | --- | --- | --- | --- |
| `CODE_PROGRAM_DEADLINE_MS` | wall clock of one program | not safe open | `code_program_timed_out`, run continues | Observed PostHog SQL calls take 2 to 9 s each and a report needs 4 to 7, so 60 s covers it; Cloudflare's default is 30 s; the harness tool timeout cap is 1,050,000 ms; ten concurrent Dynamic Workers per object. |
| `CODE_PROGRAM_MAX_BYTES` | bytes of `code` | `+Infinity` | validation failure | Terminal `run_command` accepts 32 KiB; a program is shorter. |
| `CODE_CALLS_MAX` | stub calls per program | `+Infinity` | `code_budget_exhausted` | The largest observed run makes 46 calls total. |
| `CODE_CONCURRENT_CALLS_MAX` | in-flight stub calls per program | `+Infinity` (serial tools excepted) | queued, not failed | Provider rate limits; start with the connector that trips first. |
| `CODE_RESULT_MAX_BYTES` | serialized return value | `+Infinity` | `code_result_too_large` | A tool result the model would otherwise read; 80,000 chars is the hosted MCP string bound. |
| `CODE_LOG_MAX_BYTES` | captured console output | `+Infinity` | truncated with marker | Same as result. |

## Receipts, activity rows and the wizard

- The program's receipt and its child receipts are ordinary `tool_effects`
  rows, so `sidekick_runs_read` shows a Sidekick's wizard each nested call with
  its arguments and outcome, which is what a review needs to fix a program.
- The activity row is one row for `rally:code`, in the Rally group, titled by
  `description`. Its detail lists `calls` and shows `code`. The plugin-activity
  rule that a row covers one plugin per stretch holds because the nested calls
  belong to the program's row, not to their own plugins' rows.
  [`plugin-activity-rows.md`](../../plugin-activity-rows.md) records this when
  it ships.
- `pluginSurfaceHashes` for `rally:code` cover the eligibility list and the
  renderer version, so a changed rendering invalidates replay of old program
  receipts the way a changed connector surface does.

## Testing

- `test-workers/`: the gateway against a real Durable Object, including the
  relocation case (kill the object between two nested calls; the re-run replays
  the first) and the ambiguous case (kill between an MCP execute and its
  settle; the run stops with the call named).
- Node: the renderer snapshot for a fixed plugin set; the eligibility constant
  against every built-in plugin; the failure shapes.
- Prompt evaluation on the configured medium fallback model: discovery (loads
  the plugin for a compose task, does not for a single call), one successful
  two-plugin program, a refused write followed by the direct call, a timeout
  followed by a split, and no blind resend of a failed program.
- Each integration test is broken once in production code (drop the child
  receipt write; skip the mode check) to prove it fails for the reason its name
  claims, per [`testing.md`](../../testing.md#prove-the-test-can-fail).
