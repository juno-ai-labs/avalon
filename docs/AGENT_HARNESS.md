# Agent harness

Avalon runs one bounded, server-side, tool-using loop. It is inherent to each work stream but is not a participant, separate persona, terminal, or general code-execution environment.

## Addressing

Before starting a loop, a lightweight classifier returns `agent_action`, `human_only`, `both`, or `uncertain` with confidence and a terse rationale code. Explicit Avalon/connector mentions and clear work requests invoke the harness. Social acknowledgement and human-only coordination can remain unanswered. Uncertain messages invoke only when an active task or explicit tool context exists.

The label is never exposed in the UI.

## Context

Context is assembled for the current execution principal from automation instructions/overrides, workspace instructions, objective, recent messages plus compact summaries, attached resources, accepted activities, relevant tool results, connector and human mentions, elicitation answers, and any planned-run pre-context.

Full workspace history, unrelated resources, and another participant’s private connector data are excluded. Long resources are lazily hydrated and bounded.

Every healthy workspace-scoped connector contributes all of its granted tools to every ad-hoc work stream in that workspace. Those calls execute as the workspace principal while retaining the initiating user in the audit trail. Personal connectors remain available only to their owner. Automation runs continue to receive only the connections and capabilities explicitly bound to the subscription.

## Loop

1. Start a generic Workflow with region and opaque domain IDs.
2. Load and authorize canonical context.
3. Request a streaming OpenRouter response with configured primary/fallback models and typed tools.
4. Buffer text deltas to the work-stream Durable Object; ignore reasoning fields.
5. If tools are proposed, validate schemas and authorization. Run independent reads concurrently; run writes sequentially, then append every result in the model's original call order.
6. Persist tool lifecycle and idempotency state under a stable Avalon invocation ID derived from run, turn, and tool position; keep the provider call ID only in the model protocol.
7. Persist the complete assistant message after streaming.
8. Stop on completion, structured elicitation, user cancellation, configured limits, or failure.

Web discovery and page reading are ordinary bounded harness tools backed by Firecrawl. Search returns ranked links only; the agent fetches selected pages as clean markdown. Both tools are omitted when `FIRECRAWL_API_KEY` is not configured, and Avalon does not expose product search UI.

## Limits

Environment configuration bounds model iterations, total tool calls, wall-clock duration, per-tool time, total context bytes, search results, fetched bytes, and attachment size. A wall-clock deadline is recorded as `harness_deadline_exceeded`; an external/user cancellation remains stopped. Limits fail visibly and safely rather than silently truncating an external write.

## Elicitation

The `request_elicitation` tool creates a typed text/radio/single/multi-select block. The work stream becomes `needs_input` and the current workflow ends. A valid answer adds the responder as a participant if needed, persists a visible response, clears attention when no blockers remain, and starts a new generic workflow linked to the previous harness run.

## Side-effect idempotency

Each tool call records stable invocation and harness IDs, canonical input hash, provider operation ID, status, timestamps, output reference, and error. Completed outputs up to the configured replay bound are stored exactly in regional R2 and reused on retry; larger values use an explicitly marked bounded preview. A non-idempotent write is recorded as started before execution; an uncertain outcome becomes `ambiguous` and requires human resolution. Pre-execution validation failures are ordinary failures and never become ambiguous writes.

## Model routing

OpenRouter routing is deterministic. Network failures and HTTP 408, 429, or 5xx responses receive a bounded retry on the same model before the next configured model is considered. Authentication, authorization, and payment failures are terminal. Once any text or tool-call bytes have streamed, Avalon does not replay the request against another route. Per-run model time, tool time, token totals, turns, tool counts, and per-tool timing are persisted with the harness run.

## Streaming stability

OpenRouter SSE comments are ignored. Function-call argument fragments are combined by index. Text deltas are buffered before socket broadcast; D1 stores complete messages rather than one row per token. On reconnect the client loads the canonical transcript and applies only events newer than its last sequence.
