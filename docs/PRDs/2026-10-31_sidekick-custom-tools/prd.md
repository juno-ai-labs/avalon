# Sidekick custom tools: the wizard writes a tool once, every run calls it

> Created 2026-10-31.
>
> A Sidekick's wizard can save a tested JavaScript program as a named tool with
> its own input schema. Every run of that Sidekick receives it as an ordinary
> tool, so the activation model calls one function the authoring model wrote
> and verified instead of re-deriving the method from prose. Built on
> [`2026-10-31_code-mode-tool`](../2026-10-31_code-mode-tool/prd.md), whose
> [`design.md`](../2026-10-31_code-mode-tool/design.md) owns the executor, the
> stub gateway, nested receipts and the failure vocabulary this PRD reuses.
> Evidence: [`research.md`](../2026-10-31_code-mode-tool/research.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Sidekicks: [`automation-lifecycle.md`](../../automation-lifecycle.md).

## Summary

Setting up a Sidekick already follows a guide that ends in a tested method
saved as prose: the queries that worked, the facts verified, the checks each
run makes. This change lets the wizard save that method as a tool instead. It
declares a name, a model-facing description, an input schema and a program;
tests the program against live data from the setup conversation; and submits it
with the definition. From then on each run of the Sidekick sees
`custom_<name>` in its tool list beside everything it has today, and calls it
the way it calls any tool. The program runs through the Code Mode executor with
access only to the connections the Sidekick is bound to.

For the PostHog daily report, the wizard on the primary model writes and tests
`posthog_daily_signup_report({ reportDate })` once. A run on the fallback model
makes four calls: the time, the tool, the formatting, the post.

## Motivation

The authoring guide (`automation-lifecycle.md`, 2026-10-22) already states the
principle: "Authoring and execution can have different reasoning capabilities.
A brief objective leaves each independent activation to rediscover the method
and resolve decisions the wizard could have settled once." It answered that by
saving the method as prose. The production runs in
[`research.md`](../2026-10-31_code-mode-tool/research.md#the-posthog-report-sidekicks)
show what prose costs when the run's model is weaker than the author's:

- 75 to 85 percent of each run's 32 to 46 tool calls re-verify facts the
  instructions say were verified at setup.
- Two of five recent Signup report runs blocked on a count the run computed two
  ways with different timezone literals.
- The self-review's response was more prose, in three revisions, against a
  12,000-character ceiling the instructions are near. The next run still
  blocked.

A prose method is interpreted every run by whichever model runs. A program is
executed. The parts of a Sidekick's method that are deterministic, which for a
data report is nearly all of it, belong in the second form. The wizard is the
right author: it is on the stronger model, it has already done the discovery,
and the guide already requires it to test the method before saving.

## Goals

1. The wizard can declare a tool with a name, a description, an input schema and
   a program, and save it with the Sidekick's definition.
2. A tool is saved only after the program it carries ran successfully, with
   representative input, in the setup conversation. Publication refuses an
   untested program by name.
3. Every run of the Sidekick, and the wizard's own conversation, receives each
   saved tool as an ordinary tool with the declared schema, and the activation
   model can choose it from its description alone.
4. A saved tool reaches only the connections the Sidekick is bound to and only
   stub-eligible tools on them; nothing a run could not already do.
5. A tool failure in a run names the tool, the call inside it that failed, and
   the next action, so the run can post a block that the review can act on.
6. The scheduled self-review can revise a tool's program under the same test
   gate, and the person who owns the Sidekick can read every tool's code.

## Non-goals

1. **People writing tool code in the app.** A person describes what they want
   in the setup conversation and the wizard writes the program. A code editor
   on the Sidekick profile is deferred until there is a request for one; the
   profile shows the code read-only.
2. **Tools that write to connected systems.** Non-goal 1 of the Code Mode PRD
   applies inside a saved tool: a program may read and may call MCP tools; it
   may not call a native connector write. Delivery stays a separate direct call
   by the run, through `conversation_post` or `slack_send_message`, or through
   the typed destination the delivery-reliability PRD proposes. Deferred with
   the parent non-goal.
3. **Sharing tools across Sidekicks or an Organization tool library.** A tool
   belongs to the revision that declares it. A library is a scope and
   permissions question for later. Deferred.
4. **A tool that replaces the run.** A run still reasons, formats and
   delivers; the tool returns data. A Sidekick whose whole run is one program
   with no model turn is a different product (a scheduled function) and is
   rejected here.
5. **Tools on instruction-only Sidekicks.** An instruction-only Sidekick is a
   Skill loaded into another conversation, and loading a skill grants no
   authority. A tool is authority. Rejected; the publication refuses the
   combination.
6. **Automatic conversion of existing prose methods.** Existing Sidekicks keep
   working as they are. The self-review may propose a tool when the runs show
   repeated discovery, under the same gate as any revision. Deferred to the
   review's judgement, not a migration.

## Product behavior

**In the setup conversation.** The authoring guide gains a step between testing
the method and writing the instructions: when the tested method is a data
retrieval and transformation the runs will repeat, save it as a tool. The
wizard calls `sidekick_tool_test` with the candidate tool and representative
input, reads the result, iterates until it is right, and includes the tool in
`submit_draft`. The conversation shows the test as an activity row like any
tool call, with the program in its detail. A person reading along sees the
wizard say what the tool does and that it ran.

**On the Sidekick profile.** A **Tools** section lists each saved tool by name
and description. Expanding one shows its input schema and its program as a
read-only code block, and when it was last tested. Nothing here is editable;
changes go through the setup conversation.

**In a run.** The run's tool list carries `custom_<name>` with the saved
description. The run calls it with the declared input; the transcript shows one
activity row under the Sidekick's name reading the tool's description, with the
calls the program made in its detail. The result enters the run's context as
the tool's return value. A failed tool shows a failed row and the run does what
its instructions say for a failed step, which the authoring guide requires to be
written down.

**In the scheduled self-review.** The review may change a tool's program when
the runs show the tool failing or returning the wrong shape. It tests the
change with `sidekick_tool_test` and submits, under the existing rules: never a
new connection, plugin, destination or trigger, so never a new `requiredPlugins`
entry.

**States.** A Sidekick with no tools shows no Tools section. A tool whose
required plugin's connection is disconnected is listed on the profile with that
plugin named as unavailable, and a run calling it fails with
`custom_tool_unavailable` naming the connection. A tool on a revision that
failed publication does not exist; the previous accepted revision's tools do.

## Impact on the product contract

None. A Sidekick could already be given any procedure in prose and execute it
with its tools; this records the deterministic part of that procedure as a
program the same tools serve. The agent gains no reach. The rule that Rally
never asks a person to confirm a tool call is unchanged; so is the rule that a
Sidekick's runs are not narrowed by trigger, since a saved tool is added to the
surface, not substituted for it.

## Decision log

None yet.

## Key design decisions

1. **A tool is a definition field, not a separate object.** `customTools` sits
   on `AutomationDraftSchema` beside `memoryTables`, is carried on the revision,
   and is read by a run through `readRunDefinition` like everything else. A run
   pinned to a revision keeps its tools when a later revision changes them.
   *Rejected:* a `sidekick_tools` table with its own lifecycle. The memory
   tables needed one because the table is shared storage; a tool is pure
   definition.
2. **The test gate is mechanical and local.** `sidekick_tool_test` runs the
   program through the Code Mode executor in the wizard's conversation and
   buffers `{ name, codeHash, inputHash, testedAt }` in the authoring state the
   same way `set_evaluator_rules` buffers until the next submit. `submit_draft`
   with `ready: true` refuses a tool whose `codeHash` has no buffered successful
   test, with `custom_tool_untested`. *Rejected:* checking the wizard
   conversation's receipts at publication from WorkspaceDO, which is a
   cross-object read on the publish path. *Rejected:* trusting a `tested` flag
   the model sets.
3. **The run-time plugin is per Sidekick and preloaded.** `rally:custom-tools`
   is built in `loadHarnessTools` when the run definition carries tools, with
   one `HarnessTool` per saved tool, and is always active for that run. Its
   surface hash includes each tool's `codeHash`, so a receipt replays only
   against the program that produced it. *Rejected:* exposing saved tools as
   `code_execute` programs the run pastes in. The point is that the run does
   not handle the code.
4. **Required plugins are declared and activated, never discovered.** A tool
   names the `requiredPlugins` its program calls. They must be in the
   Sidekick's `defaultPluginIds` or bound connections at publication, and the
   run activates them on the tool's first call the way `onActivate` does. The
   gateway refuses a call to any other plugin. *Rejected:* letting the program
   call whatever the run has loaded; the tool's reach would then depend on what
   the run happened to do before calling it.
5. **The input schema is the tool's whole model-facing contract.** The wizard
   writes it as a plain object schema with a description per property, subject
   to the same root-object and nullable rules as every other tool. The runtime
   validates the model's input against it before the program runs, and the
   program receives it as `input`. *Rejected:* a free-form `args: string`
   parameter, which would put the contract back in prose.
6. **The program sees `input` and `tools`, nothing about the Sidekick.** No run
   id, no definition, no home conversation. Anything a tool needs that varies
   per run comes through its input. *Rejected:* a `sidekick` context object;
   it is how a tool would start making decisions the run should make.

## Data model

`AutomationDraftSchema.customTools: SidekickCustomTool[]`, default `[]`, carried
into `AutomationRunDefinitionV1.definition.customTools` and into the
`SidekickDefinitionSchema` the profile reads.

```ts
const SidekickCustomToolSchema = z.strictObject({
  /** Lower snake case, unique within the Sidekick; the wire name is `custom_<name>`. */
  name: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  /** Model-facing: what it returns and when to call it. */
  description: z.string().trim().min(1).max(800),
  /** A plain object JSON Schema with a described property per input. */
  inputSchema: ToolInputObjectSchema,
  /** The body of an async function with `input` and `tools` in scope. */
  code: z.string().min(1).max(CUSTOM_TOOL_CODE_MAX_BYTES),
  /** Model plugin ids the program calls; each must be bound to the Sidekick. */
  requiredPlugins: z.array(ModelPluginIdSchema).min(1).max(8),
});
```

Publication validates: unique names; every `requiredPlugins` entry present in
`defaultPluginIds` or `connectorBindings`; `inputSchema` passes the same
root-object repair and the nullable rule as a connector tool; a buffered
successful test exists for `sha256(code)`; `triggers` is non-empty (non-goal 5).
A failure names the tool and the field through `describeZodIssues`. No new
table; no backfill. The authoring state gains the buffered test records beside
the buffered evaluator rules; they are consumed at submit.

## Security and trust model

- The program is written by the wizard model under the influence of the setup
  conversation, which may include content from connected systems. It is
  therefore untrusted code that persists, which is the one way this differs
  from a run-time program. Its reach is bounded the same way: no network, no
  credentials, stubs only for the Sidekick's bound connections, read and MCP
  tools only, and every call recorded.
- A program runs under the run's execution principal, as every tool in that
  run does. Delegation and consent are unchanged: a bound personal connection
  is usable only while its delegate's consent stands, and the gateway reads the
  same delegation the connector executor reads.
- The code is visible on the profile to everyone who can read the Sidekick,
  and in every run's receipts. A person can read what runs on their behalf.
- A revision that changes a tool's code changes its hash, so old receipts do
  not replay against new code.
- The management permission that gates `submit_draft` gates tool changes.

## Agent behavior

### Wizard: `sidekick_tool_test`

Added to the `rally:sidekicks` plugin (wire prefix `sidekick_`), available
wherever `submit_draft` is: the wizard's Main and the background agents it
starts. Tool order: after `set_evaluator_rules`, before `sidekicks_list`.

| Field | Value |
| --- | --- |
| Canonical | `tool_test` |
| Wire | `sidekick_tool_test` |
| Capability | `sidekick.tools.test` |
| Mode | `write` (the program may call MCP tools) |
| Idempotency | `record_before_execute` |
| Timeout | the Code Mode program deadline plus load allowance |
| Serial | yes |

Description: "Run a candidate custom tool once against live data and buffer the
successful test for the next submit_draft. Pass the whole tool and a
representative input. A tool whose code has no successful test is refused at
submit."

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

Output: the Code Mode `execute` output (`value`, `logs`, `calls`, `truncated`)
plus `codeHash` and `testedAt`. The same `codeHash` is what `submit_draft`
checks.

Failures: the Code Mode failure vocabulary for the program itself
(`code_program_failed`, `code_program_timed_out`, `code_call_refused`,
`code_call_failed`, `code_result_too_large`, `code_budget_exhausted`), plus:

| Code | Sentence | `details` |
| --- | --- | --- |
| `custom_tool_input_invalid` | `input` does not match `tool.inputSchema` at `<path>`: `<issue>`. Fix the input or the schema and test again. | `field`, `reason` |
| `custom_tool_plugin_unbound` | `<plugin>` is not bound to this Sidekick. Bind it through the connector steps or remove it from requiredPlugins. | `field: "requiredPlugins"`, `available` (bound plugin ids) |
| `custom_tool_schema_invalid` | `inputSchema` must be a plain object schema with a description on every property; `<path>` `<issue>`. | `field`, `reason` |

A failed test buffers nothing. A successful test replaces any earlier buffered
test for the same tool name.

### Wizard: `submit_draft`

`customTools` joins the draft. New refusals, each naming the tool:

| Code | Sentence |
| --- | --- |
| `custom_tool_untested` | Tool `<name>` has no successful sidekick_tool_test for its current code. Test it with representative input, then submit. |
| `custom_tool_on_instruction_only` | Tool `<name>` cannot be saved on an instruction-only Sidekick; add a trigger or remove the tool. |
| `custom_tool_name_conflict` | Tool name `<name>` is used twice. Names are unique within a Sidekick. |

The authoring guide's "Choose triggers and test the method" section gains:
"When the tested method is a retrieval and transformation every run repeats,
save it as a custom tool: declare its input, write the program against the
tools you used, test it with sidekick_tool_test, and in the instructions tell
runs to call it and what to do when it fails. Keep judgement, formatting and
delivery in the instructions; put the deterministic part in the tool."

### Run: `rally:custom-tools`

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
the call that failed; follow the instructions' failure step rather than
reconstructing the method by hand."

Each saved tool becomes:

| Field | Value |
| --- | --- |
| Canonical | `<name>` |
| Wire | `custom_<name>` |
| Description | the saved description |
| Capability | `sidekick.tools.run` |
| Mode | `write` |
| Idempotency | `record_before_execute` |
| Timeout | the Code Mode program deadline plus load allowance |
| Input | the saved `inputSchema`, after root repair, validated strictly |
| Output | the Code Mode `execute` output |

Execution: validate input against the saved schema; activate `requiredPlugins`
if not yet active (the same path `load_plugin` takes, recorded as an activation
hint); run the program through the Code Mode executor with a gateway whose
eligibility is the intersection of the parent PRD's rule and `requiredPlugins`;
settle. Nested calls are child receipts of the tool's receipt, so
`sidekick_runs_read` shows the wizard every call a tool made.

Failures: the Code Mode vocabulary, with `custom_tool_` prefixed codes where the
cause is the saved tool rather than the run:

| Code | Sentence | `details` |
| --- | --- | --- |
| `custom_tool_unavailable` | `custom_<name>` needs `<plugin>`, whose connection is not available to this run. Post that the tool is unavailable where your instructions say, and stop this step. | `reason`, `field` |
| `custom_tool_failed` | `custom_<name>` failed at call `<index>` (`<tool>`): `<message>`. Do not rebuild its method by hand; follow the failure step in your instructions. | `reason`, `field` |
| `custom_tool_timed_out` | `custom_<name>` did not finish within `<deadline>` ms. Follow the failure step in your instructions. | `reason` |
| `custom_tool_result_too_large` | `custom_<name>` returned more than `<max>` bytes. This is a tool defect; follow the failure step and say so, so the review can fix the tool. | `reason` |

The instruction to the run is deliberately "follow the failure step", not
"retry": a saved tool that fails is a defect for the review, and the research
shows a run that reconstructs a method by hand is the slow, blocking path.

### Sequences

Authoring: `plugins_list` → `load_plugin` (the data plugin) → investigate with
its tools → write the tool → `sidekick_tool_test` → read `value`, fix, repeat →
`submit_draft` with `customTools` and instructions that name the tool.

Run: `current_time` → `custom_posthog_daily_signup_report({ reportDate })` →
format → `conversation_post` or the Slack send.

Review: `sidekick_runs_read` (shows the tool's child calls) → change the program
→ `sidekick_tool_test` → `submit_draft`.

## Rollout

Ships to everybody on merge, after the Code Mode PRD has shipped, with no flag.
A Sidekick without tools is unchanged. The wizard guide change is the only thing
every Sidekick author sees. Turning it off is removing `sidekick_tool_test` and
the publication path; saved tools on existing revisions then stop being
materialized and runs fall back to their instructions.

Order of work: the schema and publication validation; `sidekick_tool_test` and
the buffered test; the run-time plugin and surface hash; the profile section;
the guide text; the evaluations below.

## Acceptance

1. In a fresh setup conversation on the primary model, asked for the PostHog
   daily signup report, the wizard saves a tool, tests it, and submits. The
   profile shows the tool with its code.
2. The Sidekick's next five scheduled runs on the configured medium fallback
   model each call the tool once, make at most eight tool calls and at most six
   model calls in total, and post the report. None blocks on a cross-source
   check, because the check is in the tool.
3. Submitting a tool whose code was changed after its last test is refused
   with `custom_tool_untested`, naming the tool.
4. A tool naming a plugin the Sidekick is not bound to is refused at test with
   `custom_tool_plugin_unbound`.
5. Disconnecting the PostHog connection makes the next run fail the tool with
   `custom_tool_unavailable` and post the unavailability where its instructions
   say; reconnecting restores it with no revision.
6. Schema snapshot and contract tests cover `SidekickCustomTool`, both new tool
   inputs and outputs, every refusal, and the materialized `custom_<name>`
   definition for a fixed saved tool.
7. A prompt evaluation on the medium fallback model covers: a run choosing the
   custom tool over `code_execute` and over direct discovery; the failure step
   after `custom_tool_failed`; no hand reconstruction of the method.

## Open questions

1. **What the profile shows a member who may not manage the Sidekick.** Code is
   readable to everyone who can read the Sidekick; whether a guest in the
   owning Thread counts is a listing-rules question
   ([`listing-rules.md`](../../listing-rules.md)) to settle before the profile
   section is built. It does not block the run-time work.
2. **Whether the review may add a tool, not only change one.** The review's
   rules forbid adding a plugin or capability; a tool over already-bound plugins
   adds neither. Decide when the first review proposes one.
