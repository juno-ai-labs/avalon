# Implementation plan

Implement the full PRD on `codex/uninterrupted-workstreams`, rebased onto the merged PRD and current main. This is an implementation change after PR #764; the feature is complete only when the full acceptance flow works.

## Work sequence

1. Carry advisory `longRunning` tool metadata through discovery and activation, initially for image generation/editing. Verify the provider-visible hint without changing dispatch, timeouts, or authorization.
2. Complete the wire contract and runtime schemas, including the approved optional attachments and refusal to restart archived work. Agent addresses must identify the whole conversation, including Sidekick authoring substream `0`.
3. Add durable implicit teams, additive membership, minimal ownership lineage, and accepted message/reply references using the existing regional object authorities. Reuse existing durable delivery and recovery; do not introduce task entities or semantic acknowledgements.
4. Create hidden background substreams and start their ordinary harness independently. Inherit the parent model and delegated authority, pass only explicit opening context, retain independent plugin discovery, and support recursive delegation.
5. Install start/list/send/reply/stop tools. Deliver messages at safe execution boundaries, wake idle agents, send results explicitly with reply references, and cascade stops only through owned descendants. Archive must stop owned work and prevent message-triggered resurrection.
6. Add Sidekick discovery and minimal creation, preferring reuse in the current workstream and defaulting new ownership to that workstream. First authorized contact adds the independently owned authoring agent to the team; drafting tools live only there.
7. Keep participant messages available during background work. Render only a pluralized running-agent count, including nested workers, without inspection or direct chat. Preserve foreground-only stop and remove the participant queue/steer choice from ordinary conversation.
8. Remove the replaced inline subagent/task paths, document direct operational cutover, update subsystem owners and acceptance documentation, and verify the feature end to end.

## Verification

- Preserve Bind as the core loop owner. Audit message admission, stop/continue, terminal replies, and recovery against its existing protections; implement any missing loop capability in Bind rather than bypassing it in Rally.
- Contract and harness tests cover discovery, activation, strict inputs, returned identifiers, errors, attachment context, model inheritance, and normal write/plugin access.
- Real workerd tests cover durable creation, delivery/reply, safe-boundary continuation, recovery/replay, concurrent conversations, recursive stops, archive refusal, and independent Sidekick ownership. Demonstrate each new integration behavior fails under a representative production-code mutation.
- Real desktop validation covers a three-participant conversation during long work, an unrelated prompt answered before the worker completes, the count and unavailable state, foreground stop, background stop via Rally, and Sidekick setup/reuse.
- Run model-tool evaluations, repository lint/typecheck, scoped tests and appropriate broader CI. Review findings against the approved design; obtain approval before material product changes.

## Current evidence

- Independent substreams, additive teams, recursive ownership, named discovery, inherited principal/model, and explicit message delivery are implemented through the ordinary harness and durable admission paths.
- Attachments preserve canonical descriptors and image projection. Admission and transcript promotion own attachment linking; refused admission leaves no recipient links.
- Stop, continuation, archive, idempotent creation, and Sidekick authoring have real-workerd coverage with representative mutation failures. Hidden workers expose only a running count; Electron inspection used explicit count fixtures.
- The inline-child runtime and participant queue UI are removed. Bind remains the owner of every loop; no timing barrier or alternate mailbox was added.
- The branch was rebased onto 4927e9306 to resolve actual conflicts. Shipped migrations remain unchanged; team and background migrations are each 59 in their separate authorities; socket teardown retains both main's query-data release and background-count cleanup.
- User clarification on 2026-09-15 removes automatic forwarding. Every message to another agent uses send_message or reply; ordinary final responses remain local. No end_turn tool, special completion receipt, or new Bind dependency is needed. The previous native-completion proposal and generated-result admission exception are withdrawn.
- The updated workerd suite exercises actual reply tool calls, local-only worker and Sidekick final responses, one parent failure notice and no synthesized needs-input messages, and replay after lost admission confirmation. Current validation is recorded in [acceptance.md](acceptance.md).

## Decisions for the final review

The user asked that material decisions be collected at the end. Archive settlement remains pending; attachment forwarding is approved:

- **Archive settlement:** Liveness renewal continues for an already-started step so Bind can settle an archived run as cancelled. Authority checks remain before every new model and tool call. The previous liveness authorization check instead turned the stop into a persistence failure.
- **Approved attachment audience (2026-09-15):** An agent may explicitly forward an accessible attachment to an authorized Sidekick whose authoring conversation has a broader audience. Source attachment access and destination contact authority are enforced; no audience-comparison gate is added, following the model-trust team design.

Live-model and three-participant acceptance still require a configured development provider. These are acceptance gaps, not reasons to change Bind protections or replace model evaluation with scripted-provider evidence.
