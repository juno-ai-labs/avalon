# Implementation plan

Implement the full PRD on `codex/uninterrupted-workstreams`, rebased onto the merged PRD and current main. This is an implementation change after PR #764; the feature is complete only when the full acceptance flow works.

## Work sequence

1. Carry advisory `longRunning` tool metadata through discovery and activation, initially for image generation/editing. Verify the provider-visible hint without changing dispatch, timeouts, or authorization.
2. Complete the wire contract and runtime schemas, including the approved optional attachments and refusal to restart archived work. Agent addresses must identify the whole conversation, including Sidekick authoring substream `0`.
3. Add durable implicit teams, additive membership, minimal ownership lineage, and accepted message/reply references using the existing regional object authorities. Reuse existing durable delivery and recovery; do not introduce task entities or semantic acknowledgements.
4. Create hidden background substreams and start their ordinary harness independently. Inherit the parent model and delegated authority, pass only explicit opening context, retain independent plugin discovery, and support recursive delegation.
5. Install start/list/send/reply/stop tools. Deliver messages at safe execution boundaries, wake idle agents, return results through their originating exchange, and cascade stops only through owned descendants. Archive must stop owned work and prevent message-triggered resurrection.
6. Add Sidekick discovery and minimal creation, preferring reuse in the current workstream and defaulting new ownership to that workstream. First authorized contact adds the independently owned authoring agent to the team; drafting tools live only there.
7. Keep participant messages available during background work. Render only a pluralized running-agent count, including nested workers, without inspection or direct chat. Preserve foreground-only stop and remove the participant queue/steer choice from ordinary conversation.
8. Remove the replaced inline subagent/task paths, document direct operational cutover, update subsystem owners and acceptance documentation, and verify the feature end to end.

## Verification

- Contract and harness tests cover discovery, activation, strict inputs, returned identifiers, errors, attachment context, model inheritance, and normal write/plugin access.
- Real workerd tests cover durable creation, delivery/reply, safe-boundary continuation, recovery/replay, concurrent conversations, recursive stops, archive refusal, and independent Sidekick ownership. Demonstrate each new integration behavior fails under a representative production-code mutation.
- Real desktop validation covers a three-participant conversation during long work, an unrelated prompt answered before the worker completes, the count and unavailable state, foreground stop, background stop via Rally, and Sidekick setup/reuse.
- Run model-tool evaluations, repository lint/typecheck, scoped tests and appropriate broader CI. Review findings against the approved design; obtain approval before material product changes.

## Current evidence

- PR #764 is merged; implementation branch starts at `84c3e67619ed5212987447a55c57b840945a6028`.
- Existing `workstream_run_subagent` executes inline and is absent from production discovery (`docs/agent-harness.md`, Child agents). Enabling it alone would not implement independent background execution.
- Existing Sidekick identity owns a main authoring substream `0`; a bare local substream ID is insufficient as a cross-parent agent address.
- Existing tool policy lives in `ToolDefinitionSchema`; Bind tool construction is the common point for model-visible descriptions during activation.
- Shared schemas now cover start/send/reply/stop inputs, optional attachments, and reversible conversation-address encoding (`parentKind/parentId/substreamId`). Names and descriptions use existing conversation metadata bounds. Tool installation and durable execution wiring remain outstanding.
- The advisory hint passed deferred-load/provider/direct-execution tests for true, false, and omission. Removing its propagation caused the intended test failure; restoration passed. The existing multimodal suite passed 11 tests and the new message contract suite passed 3 tests.
- WorkspaceDO migration 57 and internal RPCs now implement additive teams, memberships, separate descendant ownership, and immutable send/reply routes. Three real-workerd tests pass. Mutating roster scoping, reply recipient resolution, and recursive descendant lookup caused all three corresponding tests to fail; restoring the code passed. Expected RPC refusals return typed data after the initial test exposed unhandled remote exceptions for thrown domain errors.
- The model now receives `rally_agents` tools for start/list/send/reply/stop and Sidekick discovery/minimal creation. Start uses a deterministic durable-effect identity, the existing hidden child registration and provisioning path, and inherited model/principal. Tools return after acceptance rather than completion.
- Agent input admission reuses durable non-human preparation, with explicit sender/reply/resource references and safe-boundary delivery. The first real test exposed context rebuilding dropping system rows; the dedicated agent-message projection fixes that actual failure. Parent archive is checked live before admission.
- Six tests in the real automation-post-result suite pass, including hidden idempotent worker creation, named discovery, inherited principal, stop/replay/continuation, a worker reply that wakes Rally, and authorized Sidekick contact without ownership transfer. Removing the durable stop write and live parent archive check caused the two intended failures; restoration passed. The earlier dropped-context failure also demonstrated the model-input assertion catches a real defect.
- Sidekick drafting eligibility is now authoring-main-only; authorized directory results are scoped and sorted with current-workstream ownership first. Minimal creation defaults there. Domain validation and save tooling remain existing mechanisms.
- Remaining work includes guaranteed terminal-result delivery/recovery, complete stop/archive race coverage, model/tool evaluations and regressions from removed drafting, background count and responsive participant UI, attachment/media end-to-end tests, real desktop verification, complete design contract, cutover cleanup, reviews and CI.

## Decisions for the final review

The user asked that decisions be collected until the end of implementation rather than interrupting work while they are away. Preserve the approved product behavior and make reversible implementation choices. Record any material departures here before final review; none have been introduced so far.
