# Agent harness

Avalon runs one bounded, server-side, tool-using loop. It is inherent to each work stream but is not a participant, separate persona, terminal, or general code-execution environment.

## Addressing

Before starting a loop, a lightweight classifier returns `agent_action`, `human_only`, `both`, or `uncertain` with confidence and a terse rationale code. Explicit Avalon/connector mentions and clear work requests invoke the harness. Social acknowledgement and human-only coordination can remain unanswered. Uncertain messages invoke only when an active task or explicit tool context exists.

The label is never exposed in the UI.

## Context

Context is assembled for the current execution principal from the work-stream title and objective, recent persisted messages, current and planned execution times, the run reason, and any selected trigger. Automation runs also receive the immutable template name/version, instructions, expected outputs, default behavior, and subscription overrides. An activity that started a run is appended as an explicitly untrusted user-role evidence message rather than being promoted into the system prompt. Inbound email selected as the trigger is handled the same way.

Attached resources are exposed as an authorized index and hydrated lazily through tools. Connector tools and their results remain scoped to the execution principal. Full workspace history, unrelated resources, and another participant's private connector data are excluded.

## Prompt policy

All model prompts are rendered by typed, dependency-free functions in `@avalon/agent-harness`. The fixed platform policy is kept separate from dynamic context and has byte-stable golden coverage. Prompt authority is layered as platform policy, authorized work-stream and automation configuration, current human instructions, then explicitly untrusted provider/resource/tool data. User-authored draft state used by the automation compiler is passed as user-role context and cannot become an extra system instruction.

The work-stream agent is outcome-oriented and maximally autonomous within the runtime's authorization boundary. It acts on clear scoped requests, infers reasonable defaults, batches independent reads, prefers authorized connectors over public web substitutes, produces the requested write or artifact, and verifies material writes when a read-back path exists. It requests structured input only when a required identifier, permission, connection, timezone, or irreversible choice has no safe default. It never treats a proposed, failed, or ambiguous call as success and never retries an ambiguous write.

Interactive multi-round work starts with a short plan and reports only meaningful phase changes. Automation and other headless runs skip progress narration. Every completion leads with the outcome, useful evidence, and any unresolved blocker; private reasoning is never emitted.

## Automation compilation

Natural-language automation creation compiles to the existing validated draft schema. The compiler preserves established draft choices, defaults to personal scope and manual execution when scope or trigger is omitted, and writes three to eight self-contained outcome-focused steps. Calendar recurrences require an IANA timezone and use 09:00 in that timezone when a time is reasonably inferable but omitted. Exact provider events use deterministic triggers; meaning-based conditions use semantic triggers rather than invented event names or metadata. Required capabilities are the minimum external connector grants, while scheduling, reasoning, summarization, artifacts, and work-stream replies require none.

The compiler asks one focused follow-up only when a missing timezone, resource identifier, event source, destination, or unsupported scheduling shape prevents an executable draft. It never invents credentials, access, resource IDs, or provider event types, and marks a draft ready only when it can execute as represented.

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
