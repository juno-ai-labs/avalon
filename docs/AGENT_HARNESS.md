# Agent harness

Avalon's production loop is an adapter over `@juno-ai/bind` 10.0.0. Bind owns turn/tool iteration, plugin activation, transcript healing, completion-defect detection, streaming resets, and route execution. Avalon's Cloudflare Workflow host and regional D1/R2 stores remain the durable authority for admission, authorization, side effects, accounting, and terminal state.

Each run is one bounded, server-side, tool-using loop inherent to a work stream. It is not a participant, separate persona, terminal, or general code-execution environment.

## Addressing

Before starting a loop, a lightweight classifier returns `agent_action`, `human_only`, `both`, or `uncertain` with confidence and a terse rationale code. Explicit Avalon/connector mentions and clear work requests invoke the harness. Social acknowledgement and human-only coordination can remain unanswered. Uncertain messages invoke only when an active task or explicit tool context exists. The label is not exposed in the UI.

## Admission and immutable run scope

The generic Workflow creates one replay-stable attempt identity, reaps expired attempts, and claims a time-bounded D1 lease. At most one unexpired harness lease may run in a work stream. The owner heartbeats while waiting on model output and tools; scope, activation, receipt-plan/completion, checkpoint, and terminal commits require the same attempt ID, lease owner, and expiry. An obsolete executor cannot publish a terminal result, and `completed` cannot commit until its final agent message is durable. Expired attempts are compare-and-swap reaped as failed.

After admission Avalon validates the execution principal and persists an immutable, canonically hashed run scope: principal, eligible connection IDs and capabilities, trigger policy, routing and prompt versions, tool-surface hash, and limits. A replay must reproduce that scope. Connections installed or expanded later cannot enter it; subsequent membership, ownership, grant, health, and policy checks may only remove authority.

## Context and stable prompts

Context is assembled for the execution principal from the work-stream title and objective, recent persisted messages, current and planned execution times, the run reason, and the selected trigger. Automation runs also receive the pinned template name/version, instructions, expected outputs, default behavior, and subscription overrides. A triggering activity or inbound email is added as explicitly untrusted user-role evidence, never promoted into the system prompt.

Attached resources are exposed as an authorized index and hydrated lazily through tools. Full workspace history, unrelated resources, and another participant's private connector data are excluded.

All base prompts are rendered by typed, dependency-free functions in `@avalon/agent-harness`, and the prompt version is frozen with the run. Per-run time, reason, IDs, and trigger evidence are user-role messages rather than mutations of the system prefix, so retries and route fallbacks see stable policy. Bind validates the transcript before inference and heals dangling or orphaned tool-protocol rows; Avalon records diagnostics without adding provider-controlled text to the system prompt.

Prompt authority is layered as platform policy, authorized work-stream and automation configuration, current human instructions, then explicitly untrusted provider/resource/tool data. Connector descriptions and active-plugin guidance are static code-authored strings rendered in stable plugin-ID order. Remote account labels, resources, and provider content never become trusted plugin prose. User-authored automation draft state remains user-role context.

## Behavior policy

The agent acts on clear scoped requests, infers safe defaults, batches independent reads, prefers authorized connectors over public substitutes, and verifies material writes when a read-back path exists. It requests structured input only when a required identifier, permission, connection, timezone, or irreversible choice has no safe default. It never treats a proposed, failed, or ambiguous call as success and never retries an ambiguous write.

Interactive multi-round work starts with a short plan and reports meaningful phase changes. Headless runs skip progress narration. Completions lead with the outcome, evidence, and blockers; private reasoning is never emitted.

## Automation compilation

Natural-language automation creation compiles to the validated draft schema. The compiler preserves established choices, defaults to personal scope and manual execution when omitted, and writes three to eight self-contained outcome-focused steps. Calendar recurrences require an IANA timezone; exact provider events use deterministic triggers and meaning-based conditions use semantic triggers. Required capabilities are the minimum external grants.

The compiler may retain an incomplete draft while asking one focused question. An omitted calendar timezone resolves from the personal user or workspace according to scope; an explicit trigger timezone wins. Missing resources, event sources, destinations, or unsupported schedules still require input. The compiler never invents credentials, access, resource IDs, or event types. Invalid structured output gets one sanitized repair attempt, then `502 model_output_invalid` with a request ID.

## Connection plugins and authority narrowing

Every connector adapter supplies a static agent-plugin descriptor whose provider type and tool order must match its manifest. At run start Avalon creates one Bind plugin per eligible installed connection, identified as `connection:<uuid>` with a stable hashed wire prefix. Its tools are narrowed to the connection's frozen grants and run policy:

- Ad-hoc runs may include healthy workspace connections and the initiating user's healthy personal connections.
- Automation runs include explicitly bound connection/capability pairs and eligible connections attached through work-stream resources. Attached connections remain limited to the immutable grants frozen for the run.
- Inbound-email runs remove external connector writes.

Bound connections, attached resources, and previously used plugins are activation hints, not extra authority. Hints are filtered through the frozen scope and reauthorized before restoration. Other eligible plugins appear only in a bounded catalog and must be loaded with Avalon's core plugin tool. Activation is durably recorded before the plugin's tools or trusted guidance become visible.

Loading never widens the frozen scope. At run start, before credential decryption, before every tool call, and between model turns, Avalon revalidates the execution principal, work-stream state, automation subscription and pinned template version, trigger evidence and status, connection identity/scope/owner, current grants, capability, and health. Revocation drops a plugin. Workspace calls use the workspace principal while preserving the initiating user in audit data; personal calls remain owner-only.

## Loop

1. Claim the lease, validate the principal, freeze the run scope, and load authorized context.
2. Build Avalon's core plugin plus the frozen connection catalog; restore only reauthorized hints.
3. Reauthorize active plugins, render the stable prompt/tool surface, and ask OpenRouter through Bind's deterministic route plan.
4. Stream text through the epoch-aware protocol; reasoning fields are ignored.
5. Validate tools and recheck authority. Bind runs writes sequentially and may overlap independent reads, while returning results in the model's original call order.
6. Persist each immutable execution plan before execution and make a successful bounded result durable before returning it to Bind.
7. Persist the complete assistant message, then let the lease-owning Workflow append the terminal lifecycle event.
8. Stop on completion, elicitation, durable cancellation, ambiguous write, limit, lease loss, or failure.

Web discovery and page reading are bounded Firecrawl tools. Search returns ranked links and page fetch returns clean markdown. Both are omitted without `FIRECRAWL_API_KEY` and from inbound-email runs.

## Limits

Environment configuration bounds model iterations, tool calls, wall-clock and per-tool time, complete-context bytes, run tokens and cost, plugin-catalog tokens, active plugins, active tool-schema bytes, and each model-visible tool result. Request establishment, time to first token, and inter-chunk idle time have separate watchdogs. Web results, fetched bytes, replay payloads, and attachments are independently bounded.

Image attachments retain their exact original object for display and download. Before model admission, the regional Worker validates the byte signature and writes a reusable bounded derivative to regional R2, referenced separately from D1. PNG, JPEG, and WebP are normalized through Cloudflare Images; TIFF and HEIF/HEIC also have bounded local conversion fallbacks. Animated GIFs become a single storyboard derivative with up to six representative timestamped frames plus bounded duration, frame-count, dimensions, and loop metadata. Only the derivative is placed in the model protocol transcript.

Oversized tool results are reduced only as valid JSON inside an explicit truncation envelope; an unsafe reduction fails. Context exhaustion uses `context_limit_exceeded`; an oversized active surface uses `tool_surface_too_large`; and wall-time, iteration, tool-call, token, and cost ceilings use `run_wall_time_limit_exceeded`, `run_iteration_limit_exceeded`, `run_tool_call_limit_exceeded`, `run_token_limit_exceeded`, and `run_cost_limit_exceeded`. Limits never silently reinterpret a write as successful.

## Elicitation

The `request_elicitation` tool creates a typed text/radio/single/multi-select block. The work stream becomes `needs_input` and the Workflow ends. A valid answer persists a visible response, clears attention when no blockers remain, and starts a new generic Workflow linked to the previous run.

## Durable receipts and terminal state

Each tool call receives a stable Avalon receipt ID derived from the run, model turn, and original tool position; the provider call ID remains only in the model protocol. Before execution, D1 stores the canonical input and immutable plan hashes, plugin/connection, mode, idempotency policy, and optional provider key. Append-only checkpoints record progress, and completed receipts retain provider operation IDs. Successful bounded output is written to regional R2 and then committed to D1 before Bind can observe it.

Completed receipts replay without another provider call. Incomplete safe reads may resume. A reused or mismatched plan, incomplete prior write, or timed-out `record_before_execute` write becomes `ambiguous_external_write` and is never blindly repeated. Lifecycle events are append-only, and terminalization is idempotent and lease-fenced.

## Model routing and inference ledger

OpenRouter routing is deterministic and versioned. Empty completions and truncated tool calls receive a bounded same-endpoint defect retry. Other fallback-eligible failures traverse configured model stages under Bind's classified failure policy and a workspace-scoped circuit breaker; cancellation and host failures do not route onward. Because Avalon's stream is retractable, a later attempt explicitly resets partial text instead of concatenating two answers.

Every classified provider attempt appends an immutable inference-ledger row with its turn/route cursor, provider and model, routing decision, outcome, latency, available token/cache/cost counters, and hashed credential/workspace identities. Harness-run usage also stores turn/tool timings and counts. Provider error bodies and credentials are not retained in the ledger.

## Streaming stability

OpenRouter SSE comments are ignored and function-call fragments are combined by index. Each model turn has a stable `turnId`. A route restart increments `epoch`; `streamSeq` orders frames within the turn epoch; `reset: true` replaces text from the abandoned attempt. These fields are independent of the WorkstreamRoom event `sequence` used for socket replay.

Text deltas are buffered before broadcast, but a reset is sent alone and batches never cross turn or epoch boundaries. The desktop retains per-message stream cursors across reconnects, rejects duplicate or stale frames, and replaces only the active turn's abandoned partial text on reset while preserving completed text from earlier tool turns. D1 stores the complete final assistant message; REST resynchronization remains canonical.

## Durable inline subagents

The root harness exposes `avalon.run_subagent` for several independent, substantial read-only investigations. Avalon follows Monad's useful delegation shape while preserving Avalon-specific durable authority:

- A child is an inline Bind run, not an autonomous participant. It receives one self-contained objective and a narrowed subset of plugins already authorized and active in the parent run.
- Child admission is atomically keyed by the parent's stable tool-call receipt. Duplicate calls replay the same durable result, and a child can never widen the parent's frozen scope.
- The database records parent/chain lineage, depth, delegated-task and inherited-scope hashes, leases, activations, inference attempts, tool receipts, checkpoints, result hashes, and terminal state.
- Children are read-only. Connector writes, Firecrawl tools for inbound-email parents, elicitation, recursion, and human-facing progress are unavailable.
- Child and chain depth, concurrency, plugin surface, model iterations, tool calls, tokens, cost, and wall time are independently bounded. Capacity refusal is deterministic rather than an untracked background task.
- Parent and child ownership are revalidated during inference and around tool execution. A lost parent or child lease aborts the child, and a successful result becomes visible to Bind only after it is durable.

This deliberately adopts Monad's focused parallel-investigation strategy without copying in-memory interrupt queues, fire-and-forget persistence, autonomous agents, personas, memory, or nested delegation.

## Cancellation and deferred systems

Stopping a run persists `cancellation_requested_at`; it does not terminate the Workflow out of band. Admission observes pre-start cancellation, and a live owner observes it through heartbeats and event checks. The same leased Workflow then commits one fenced `stopped` lifecycle event and returns the work stream to `idle`, preventing a stop/complete race.

Avalon has no separate durable semantic-memory service. The work-stream transcript, attached resources, activation hints, run scope, inference ledger, tool receipts, and inline child results are context and audit state, not autonomous memory. Nested child delegation, long-term memory, personas, roles, autonomous heartbeats, and general child participants remain deferred product work.
