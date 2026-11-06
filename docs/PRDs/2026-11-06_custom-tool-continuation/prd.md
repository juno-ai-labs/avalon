# Custom tool continuation

> Created 2026-11-06.
>
> A Sidekick's saved tool keeps working across several two-minute programs inside
> one tool call, so a run does a large repeated job in one model turn. Builds on
> [Code Mode and Sidekick custom tools](../2026-10-31_code-mode-and-sidekick-custom-tools/prd.md);
> the runtime is described in [`code-mode.md`](../../code-mode.md). Standing
> contract: [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

A saved custom tool can ask to be continued. When its program returns a
`continueWith` input, the run starts the same tool again with that input as a
fresh program, without returning to the model, and keeps going until the tool
stops asking, a segment fails, or the call reaches its segment cap. The model
makes one call and gets one result.

A Sidekick whose routine work outgrows one program, such as scanning hundreds of
conversations, then costs one model turn for that work instead of one per
program. The model still decides everything that needs judgement: the tool
returns its findings and exceptions at the end, exactly as it does today.

## Motivation

Every model turn re-sends the whole run conversation, so a run's cost grows
with the square of its turns. On 2026-11-05 Daily Active Rally Organizations
made 966 model calls in one run, re-sending 250k to 840k tokens each time, for
$197.

[#1481](https://github.com/juno-ai-labs/avalon/pull/1481),
[#1482](https://github.com/juno-ai-labs/avalon/pull/1482) and
[#1483](https://github.com/juno-ai-labs/avalon/pull/1483) moved routine work
into one saved tool that runs in time-sized shares, which removes most of
those turns. One limit remains: a program has two minutes
(`CODE_PROGRAM_DEADLINE_MS`), a program cannot call a program, and nothing but
the model calls a tool again. A tool that needs ten shares therefore costs ten
model turns, each re-sending the conversation, though the model has nothing to
decide between them.

How many shares a real run needs is not yet measured: the Sidekick's revision
with time-sized shares runs for the first time on 2026-11-07. This PRD is
written ahead of that measurement so it can be built at once if the run still
needs more than a few calls; the decision to build is recorded in the decision
log against the measured numbers.

## Goals

1. A saved tool whose work outgrows one program finishes it in one model turn.
2. Each segment is still a separate program within today's deadline, memory and
   worker limits, so no Code Mode limit is raised.
3. A failure, timeout or stop in any segment leaves every earlier segment's
   writes in place and tells the model which segment failed and what to do
   next, in the same vocabulary as a single-program failure.
4. A run re-entered mid-call replays completed segments from their receipts and
   resumes, as a single program does today.
5. A tool that never asks to continue behaves exactly as it does today.

## Non-goals

1. **A longer program deadline.** Rejected: a running program holds the object's
   I/O context, and the platform allows ten Dynamic Workers per object.
   Continuation keeps each program inside the existing deadline.
2. **Continuation for `code_execute`.** Deferred: an ad hoc program has no tested
   contract for its own continuation input. Saved tools have one, tested by
   `sidekick_tool_test`.
3. **Parallel segments.** Rejected: segments run one at a time, so writes stay
   ordered and only one Dynamic Worker is held per call.
4. **Merging segment results in the runtime.** Rejected: the tool already
   records its findings in the Sidekick's own table and returns everything not
   yet delivered (see the custom-tools guide), so the last segment's result is
   complete. The runtime merging results would need a merge rule per tool.
5. **Running the job outside the run** (a background job that wakes the run
   when done). Deferred: it needs its own lifecycle, cancellation and delivery
   path, and continuation reaches the same turn count with none of that.

## Product behavior

### What a run sees

A run calls `custom_<name>` once. The call's activity shows in the transcript
as one tool call, labelled with the tool's name, while it works. When it ends,
the model receives one result:

- **Finished:** the last segment's return value, minus its `continueWith`, as
  the tool's `data`.
- **Segment cap reached:** the last segment's return value, with
  `continueWith` kept, and a sentence telling the model to call the tool again
  with `continueWith` as its input. This is a normal outcome, not an error.
- **A segment failed or timed out:** the same failure codes a single program
  raises today (`custom_tool_failed`, `custom_tool_timed_out`,
  `custom_tool_result_too_large`, `custom_tool_unavailable`), with the segment
  number in the message and details. Writes from earlier segments stand.

### What the setup agent writes

The custom-tools guide tells the setup agent that a tool whose work can
outgrow one program returns `continueWith`: the input for its next segment,
usually a cursor into the Sidekick's own table. The tool returns no
`continueWith` when nothing remains or when it has exceptions the run must
judge before going on. The run instructions call the tool once, not in a loop.

`sidekick_tool_test` runs continuation exactly as a run does, so the setup
agent's timing test covers several segments.

### States

- **Empty:** a tool with no work returns at once with no `continueWith`; one
  segment, one result.
- **Running:** the transcript shows one active tool call; the activity line
  counts segments ("segment 3").
- **Stopped:** a pause, stop or archive of the Sidekick ends the call between
  segments and stops the run, as for any other tool call.

## Impact on the product contract

None — this refines how a Sidekick's saved tools execute within the existing
contract. No new authority: every segment runs under the same plugin allowance,
principal and receipts as the tool's single program does today.

## Decision log

None yet.

## Key design decisions

1. **The tool asks for continuation; the runtime never decides it.** The tool
   knows whether work remains and whether its exceptions need judgement first.
   Rejected: the runtime continuing while a result reports "remaining", which
   would need a field every tool reports the same way.
2. **One tool call, many programs.** Continuation lives inside the
   `custom_<name>` call's `execute`, not as synthetic tool calls the harness
   inserts. The transcript, receipts and the model's view stay one call.
   Rejected: synthetic calls, which would add transcript rows and a new Bind
   path for calls no model made.
3. **The call's timeout follows its cap.** `timeoutMs` on a continuing tool is
   the segment cap times `CODE_PROGRAM_TOOL_TIMEOUT_MS`, so Bind's clock never
   fires before the last segment's own deadline.
4. **Results accumulate in the tool's table, not the runtime.** See non-goal 4.

## Agent behavior

### Plugin contract

`rally:custom-tools` is unchanged: canonical ID `rally:custom-tools`, wire
prefix `custom_`, preloaded and always active on a run whose definition carries
tools, one `custom_<name>` per saved tool. Its system message gains one
sentence: "A custom tool may run several programs in one call; call it once and
use its result. If it returns continueWith, call it again with that as its
input."

### Tool catalog

| Model-visible name | Capability | Mode | Idempotency | Timeout | Serial |
| --- | --- | --- | --- | --- | --- |
| `custom_<name>` | `sidekick.tools.run` | write | `record_before_execute` | segment cap × `CODE_PROGRAM_TOOL_TIMEOUT_MS` | yes |

The description is the saved tool's own, unchanged.

### Wire shapes

**Input:** the saved tool's `inputSchema`, closed with
`additionalProperties: false`, unchanged. A segment's `continueWith` must match
the same schema; the runtime validates it before starting the next segment.

**Program result:** any JSON value the tool returns today. A top-level
`continueWith` key, when present and not `null`, asks for another segment;
`continueWith` is reserved and is never a field of the tool's own result.

**Successful output (Bind envelope `data`):**

- Finished: the last segment's value with `continueWith` removed.
- Cap reached: the last segment's value with `continueWith` kept.

The envelope's `summary` names the segment count. The output contract adds no
other field.

### Discovery and sequencing

The first segment's input comes from the model's call. Each later segment's
input is the previous segment's `continueWith`. When the cap is reached, the
model's next call passes `data.continueWith` as its input. The common sequence
is one call; the cap case is a second call with `continueWith`.

### Failure and self-healing

Failures keep today's codes and sentences, with the segment named:

| Code | Model-visible sentence (shape) | Next step |
| --- | --- | --- |
| `custom_tool_failed` | "`custom_<name>` failed in segment N: <reason>. Writes from segments 1 to N-1 stand. Do not rebuild its method by hand; do the failure step your instructions give." | Follow the instructions' failure step. |
| `custom_tool_timed_out` | "`custom_<name>` timed out in segment N: <reason>. Writes from earlier segments stand. …" | Call again; recorded work is skipped. |
| `custom_tool_failed` (bad `continueWith`) | "`custom_<name>` returned a continueWith that does not match its input schema at <field>. This is a defect in the tool; report it where your instructions send failures." | Report; do not retry. |
| `custom_tool_result_too_large`, `custom_tool_unavailable` | As today, with the segment named. | As today. |

Details carry `segment` and the failing field where one applies, per
[`naming-a-schema-failure.md`](../../naming-a-schema-failure.md).

### Authority, safety and lifecycle

Every segment runs with the tool's `requiredPlugins`, the run's principal and
the run's receipt store, as a single program does. Nested-call receipts keep
the `:call:<index>` suffix with the index counting across segments, so keys
stay unique within the call. A re-entered call replays completed segments'
calls from receipts and resumes at the first unfinished segment. A Sidekick
pause or stop is checked between segments and ends the call with the run's
existing stopped outcome.

### Model-usability acceptance

- Schema and contract tests: finished, cap-reached, failed-in-segment and
  invalid-`continueWith` shapes.
- A workerd test of a three-segment tool, with a re-entry between segments 2
  and 3 replaying from receipts.
- `scripts/code-mode-evals.mjs`: a prod scenario whose job needs at least three
  segments, graded on one `custom_<name>` call per run, plus a run on the
  scheduled-run fallback model.

## Rollout

Ships to everybody on merge, with no flag. Existing tools never return
`continueWith`, so they behave as today; tools gain continuation as setup and
self-reviews rewrite them under the updated guide. Turning it off is reverting
the change; a tool that returned `continueWith` then gets its first segment's
result and the cap-reached sentence, which the run already handles.

## Acceptance

1. A Daily Active Rally Organizations run scans every conversation for its day
   with one `custom_scan…` call.
2. A tool that never returns `continueWith` produces byte-identical receipts to
   today's.
3. A segment failure leaves earlier segments' rows recorded and the model's next
   step named in the error.

## Open questions

1. **The segment cap.** A defensive limit, so its number is the team's to set
   per [`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md);
   it ships open, marked `LIMIT UNSET`. It also bounds the call's timeout
   (design decision 3) and so how long one run turn can hold the object.
2. **Whether to build at all.** Depends on the 2026-11-07 run of Daily Active
   Rally Organizations. If time-sized shares already finish its scan in two or
   three calls, the turn savings may not justify the runtime change.
