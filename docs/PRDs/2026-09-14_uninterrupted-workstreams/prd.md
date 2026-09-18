# Uninterrupted workstreams

> Created 2026-09-14.
>
> Rally remains conversational while background agents work in substreams, communicate as teammates, and configure Sidekicks through messages.
>
> Standing contract: [Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md). Companion: [state](state.md). Related: [agent harness](../../agent-harness.md), [substream creation](../../substream-creation.md), and [Sidekick lifecycle](../../automation-lifecycle.md).

## Summary

Participants keep talking with Rally while substantial work runs in background substreams. Rally delegates through ordinary instructions, coordinates through messages, and brings answers back into the conversation. Participants see only a basic indicator such as “2 background agents running”; they do not inspect or chat with individual workers.

Teams supply a simple communication scope. Sidekicks participate through their own authoring substreams, where their setup tools live. The design reuses persistent substreams, existing execution behavior, and normal tool authorization rather than adding a task-management system.

Bind remains the core owner of the agent loop in every message feed, including background substreams. Responsiveness comes from independent execution and supported input boundaries, while preserving Bind's ordering, checkpoint, tool-execution, suspension, and completion protections. If the design needs a new loop capability, change the Bind runtime library directly rather than bypassing it or building a competing loop in Rally.

## Motivation

In the workstream interaction reported during this PRD’s creation, three participants were having a fluid conversation until Rally began a long-running task. Messages accumulated behind the execution, exposing queue defects. Repeated steering also felt wrong for ordinary human conversation.

The underlying problem is that conversation availability depends on lengthy work finishing. Rally currently has zero users, so a coherent first experience matters more than preserving the existing implementation. Build the simple model, use it, and iterate on problems observed in actual use.

## Goals

1. Participants converse with Rally while substantial work proceeds independently.
2. Human messages enter the transcript without waiting for background execution.
3. Rally starts named agents, lists their descriptions and execution status, exchanges messages, stops execution, and continues agents with follow-up messages.
4. Background work survives the foreground response ending and uses existing durable execution recovery.
5. Agents collaborate through teams, including Sidekicks that participate in multiple teams.
6. Sidekicks perform their own setup and report the saved outcome to the requesting conversation.
7. Participants understand that work is running without managing or inspecting agents.

## Non-goals

1. **Participant worker inspection or direct worker chat.** Deferred. All interaction goes through Rally in the main conversation.
2. **Explicit team-management tools or UI.** Deferred. Product flows establish teams and add members internally.
3. **A task-management or orchestration system.** No task entities, requirements revisions, task-completion tools, dependency graphs, or additional execution state machines.
4. **Separate pause, resume, interrupt, and cancel controls.** Use stop execution and continue with a message.
5. **Semantic delivery tracking or coordination enforcement.** No read/applied receipts, instruction-conflict detector, sibling-message classifier, or rule limiting sibling prose to advice.
6. **Speculative collaboration infrastructure.** No membership removal, team roles, cross-team context partitioning, elaborate progress tracking, or external agent interoperability protocol.
7. **Transparent migration of in-flight work.** No machinery to convert every active execution, queued input, or pending question into the new design.

## Product behavior

### An available conversation

The transcript records participant messages independently of agent execution. The composer sends ordinary messages while background work runs, without a queue/steer choice.

Rally follows the shared conversation and responds when useful. It uses model judgment to distinguish requests to Rally, conversation between people, changed instructions, and conflicting requests. There is no separate conflict-detection or arbitration system.

Rally performs brief work directly and delegates substantial work when useful. Its foreground response can finish while background execution continues. Questions from workers do not block unrelated conversation or other workers.

### Starting and continuing agents

Starting an agent requires a name, a description, and an ordinary instruction message containing the objective and useful context. The name and description are stored on the substream and returned by `list_agents`. The returned substream ID identifies the agent; names are descriptive rather than addressing keys. There is no separate task ID or structured task specification.

A new agent receives only its starting instructions and explicitly supplied task context; the parent’s conversation is not automatically copied or summarized into it. Normal platform instructions, authorized tool discovery, and host-provided execution metadata still apply. Further context arrives through ordinary messages or authorized tool reads. Continuing an existing agent retains that agent’s own conversation history.

Background agents use the same agent harness as workstream agents and inherit the parent workstream’s model selection, including an explicitly chosen model override. When the parent uses the default workstream model configuration, its children use that configuration too. Nested delegation carries the inherited selection forward. There is no separate background-agent model configuration or caller-supplied model parameter in `start_agent`.

Agents use the same start and message primitives recursively. A child can delegate when useful. Retain only the lineage needed for authorization, reporting, and stopping owned execution; do not introduce tree scheduling or aggregate task state.

Agents send results and questions through `send_message` or `reply`. Standard assistant responses remain in their own conversation and are never automatically forwarded to another agent; this applies equally to parents, siblings, and Sidekick authoring agents. A failed background agent posts one host-generated notice to its owning parent: `Agent failed due to <reason>. Id: <id>`. Settlement retries do not duplicate it. Completion and needs-input states do not synthesize messages. Follow-up instructions continue the same substream with its existing context. Reuse message references for returning answers rather than creating separate return-destination machinery.

### Minimal participant visibility

The workstream shows a non-interactive indicator such as “1 background agent running” or “2 background agents running”, derived from existing execution state. It includes active nested workers associated with the conversation without counting an agent twice, and disappears when none are running.

There are no worker rows, detail views, transcript inspection surfaces, or worker composers. Rally communicates relevant findings, questions, and results in the main conversation. Delivered artifacts use the normal resource surfaces.

For status questions, Rally uses `list_agents` and messages already delivered to it, or asks the agent directly. There is no `read_agent` tool or cross-agent transcript-reading capability in this tool surface. Do not add progress percentages, a progress ledger, freshness tracking, or a separate reporting subsystem. Loading, errors, and reconnects use existing conversation behavior; an unavailable count must not be presented as a verified current count.

### Stop and continue

All participants can ask Rally to stop or continue delegated work. Directions preserve their author’s identity and remain subject to existing execution authority.

Stop uses the host’s existing execution-stop behavior. A later continuation message starts execution again in the same substream. Do not introduce distinct pause, resume, interrupt, and cancellation semantics. Stopping does not undo completed external actions; existing execution receipts handle in-flight outcomes.

`stop_agent` stops the addressed agent and its owned descendants. It does not stop independently owned Sidekicks or other teammates merely because they share a team. Continuing an agent with a message does not automatically restart descendants; further work uses the same messaging and start primitives.

The workstream’s stop control targets the foreground response. Participants direct background agents through messages to Rally, not per-worker controls.

Archiving a workstream stops its active agents and their owned descendants through the same execution-stop behavior. Independently owned Sidekicks remain intact, and their scheduled runs are unaffected; team membership alone does not make an agent part of the archive’s stop scope.

Messages cannot restart agents in an archived workstream. Send and reply refuse the archived destination while retaining additive team membership.

### Send and reply

An agent sends an ordinary message to an authorized teammate. The recipient receives the sender identity and message ID. Reply references a received message; the host resolves the recipient and retains the exchange’s team scope. Neither agent opens a directional channel or establishes a friendship object.

Persist delivery and acknowledge it. Do not track whether a message was read or semantically applied. If confirmation is useful, the recipient acknowledges through an ordinary reply. Questions and answers use message references rather than task records.

A message to a running agent is delivered at the next existing safe execution boundary, without interrupting in-flight model or tool work. A message to an idle or stopped agent starts another execution in the same substream. This applies to both initial messages and replies; no separate continue tool is introduced.

Images and other context use existing resource references in messages rather than a new attachment format.

Agents freely exchange questions, instructions, findings, and suggestions. Trust the model to interpret messages and coordinate, including deciding when to involve the parent. Do not classify sibling messages as advisory or enforce a distinction between advice and direction. Concrete tool and execution permissions remain host-controlled.

### Teams

A team is a stable identity within a workspace plus member-substream references. Shared authorized membership scopes teammate discovery and messaging. Every member is a sibling teammate for communication; team membership does not change ownership or parentage.

The host creates or reuses the requesting conversation’s implicit team when delegating and adds its agent and workers. Nested agents join through the same mechanism. Authorized Sidekick contact adds the Sidekick’s authoring substream before sending the setup message.

An agent can belong to multiple teams, including a Sidekick serving multiple workstreams. Membership is additive: agents can be added but are never removed from a team. There is no membership-removal API, expiry system, or membership lifecycle. Existing workspace and resource authorization still applies; membership does not bypass it.

Discovery and exchanges use their team scope, so sharing one member does not merge team rosters. Beyond that basic scoping, trust the model to manage multi-team conversational context. Do not add special audience-compatibility machinery, automated context splitting, cross-team content classifiers, or speculative isolation mechanisms for this feature.

### Sidekick setup

Prefer reusing a suitable Sidekick owned by the current workstream before creating another or choosing a personal or workspace Sidekick. Discovery presents current-workstream Sidekicks first and includes each result’s ownership scope, so Rally can make that choice explicitly. New Sidekicks default to ownership by the current workstream. Personal and workspace Sidekicks remain available when explicitly requested or clearly appropriate. These are model guidance and creation defaults, not a hard restriction or a change to access rights; contacting an existing Sidekick does not change its ownership.

Rally initializes a new Sidekick or resolves an existing authorized authoring substream, then sends a setup or modification request. The Sidekick’s agent owns the drafting and configuration tools, asks questions by replying, and reports the saved definition and outcome. Rally answers from context or asks participants.

Ordinary workstream and worker conversations do not receive Sidekick drafting tools. Membership does not turn a Sidekick into a child or transfer ownership. Stopping a setup execution does not stop the Sidekick’s scheduled runs or delete it.

Use the Sidekick’s existing save validation and revision checks. Do not add a new system to detect or arbitrate conflicting setup instructions; the model interprets requests and uses the existing domain tools.

### Long-running tool hints

Tool definitions may include the optional boolean `longRunning`. A true value supplies a light hint to consider background execution; false or omission supplies no hint. Image generation is an initial example.

Preserve the hint through tool discovery and activation. It is metadata, not an invocation argument, timeout, permission, or mandatory routing rule. Trust the model to choose when delegation is worthwhile, and refine the guidance from actual use. An already-asynchronous tool can be called directly when it preserves responsiveness. A background agent does not need to delegate again merely because the hint is present.

## Impact on the product contract

The workstream remains the durable multiplayer home for work, with Rally inherent in it. This change separates conversational availability from substantial execution without adding removable agent participants or a global task inbox.

The standing implementation brief should recognize independently executing substreams. Existing regional, tool-authorization, and execution-receipt contracts remain in place.

## Decision log

None yet.

## Key design decisions

1. **Substreams and messages are the primitives.** They already provide identity, context, and continuation. Separate tasks, requirement revisions, and return-routing records duplicate them.
2. **Teams are small and active internally.** Workspace-scoped membership replaces special messaging rules for parents, siblings, introductions, and Sidekicks. Additive membership and deferred management surfaces keep the mechanism small.
3. **Trust model judgment.** Use frontier-model reasoning for collaboration, changed instructions, multi-team context, and delegation choices. Add mechanisms in response to observed failures, not anticipated ones.
4. **Reuse execution behavior.** Stop and message-based continuation, local final responses, explicit messaging tools, existing status, and durable delivery replace bespoke lifecycle and progress machinery.
5. **Sidekicks own setup.** Their authoring agents use domain tools locally; other agents request outcomes through the common messaging interface.
6. **Cut over directly.** With zero users, a simple operational cutover is preferable to a parallel compatibility system or migration of live agent work.

## Data model

Reuse substream messages, names/descriptions, execution state, receipts, and artifact references. Add only workspace-scoped team identities and additive membership, message team/reply references, and the minimal delegation lineage needed by the existing host.

Agent discovery reads durable substreams and membership, so model compaction does not erase the ability to find workers. Objectives and updates live in messages. No task, progress, semantic acknowledgement, friendship, or directional-channel tables are introduced.

## Regional impact

Teams, messages, execution, and artifacts remain in the owning workspace’s region. This feature adds no cross-region communication or Global fallback for EU work.

## Security and trust model

Reuse existing host-derived execution principals, connector grants, resource access, and revocation checks. Background agents inherit the delegation’s authority and can execute authorized reads and writes. They discover and load eligible plugins themselves; the parent need not activate those plugins first. Further delegation cannot increase authority, and credentials stay with the host.

Shared participant control does not pool personal connector access. A request needing different authority uses the existing authorized execution path. Team membership permits messaging, not transcript access, credentials, Sidekick management rights, or lifecycle control over peers.

Retain existing resource-level write controls and safe handling of uncertain external writes. No per-tool confirmation flow or new semantic security classifier is introduced.

## Agent behavior

| Capability | Behavior |
| --- | --- |
| Start agent | Create a substream with the supplied name, description, and instructions; admit it to the implicit team and return its identity after acceptance. The same operation supports nested delegation. |
| List agents | Return eligible teammates’ IDs, names, descriptions, and existing execution status. |
| Send message | Address an authorized teammate and persist the message with sender identity and team scope. A follow-up can continue existing execution context. |
| Reply | Reference a received message; the host resolves the recipient and exchange scope. |
| Stop agent | Stop the addressed agent and its owned descendants using existing host controls. Continue later with a message. |
| Initialize or locate Sidekick | Discover accessible Sidekicks with ownership scope, presenting current-workstream entries first. Prefer suitable existing workstream Sidekicks; default new Sidekicks to current-workstream ownership. Establish the authorized authoring destination and implicit team membership; setup itself happens through messages. |

Final responses settle locally through the existing execution host. Failed background runs additionally notify their owning parent. Model-authored inter-agent messages require explicit send_message or reply calls; there is no completion tool. Discovery supplies identifiers; models do not invent recipients. Existing replay and authorization behavior applies to mutating calls.

### Agreed wire shapes

Use these canonical tools, before the plugin wire prefix. Shapes below describe successful payloads within the existing tool-result envelope:

```text
start_agent({ name: string, description: string, message: string, attachmentIds?: string[] })
  → { agentId: string }

list_agents({})
  → { agents: [{ agentId: string, name: string, description: string, status: existingExecutionStatus }] }

send_message({ agentId: string, message: string, attachmentIds?: string[] })
  → { messageId: string }

reply({ messageId: string, message: string, attachmentIds?: string[] })
  → { messageId: string }

stop_agent({ agentId: string })
  → existing host stop-result semantics
```

All shown input fields except `attachmentIds` are required. Attachments default to an empty array and reuse existing attachment identifiers and validation. `agentId` addresses an existing substream within its parent, not a new agent entity; it must distinguish different parents' main substreams, all locally named `0`. The input `messageId` for `reply` identifies a received message; the returned `messageId` identifies the newly accepted reply. Start returns after durable creation/admission, and send/reply return after durable acceptance, not after the recipient finishes processing.

The host supplies sender identity, team scope, permissions, inherited model selection, and reply routing. `send_message` has no reply-to field, and `reply` has no recipient field. `list_agents` takes no model-selected team parameter. There is no `read_agent` or transcript cursor contract. Exact validation, failure envelopes, and the mapping of existing status/stop results remain to be specified using repository conventions.

Standing guidance remains short:

> Stay available to the participants. Delegate substantial work when useful. Treat long-running annotations as hints, not rules. Coordinate through messages and replies, and continue prior agents when useful. Use existing status or ask an agent when someone wants an update. Bring useful answers back to the conversation.

> For Sidekick setup, first look for a suitable Sidekick owned by this workstream and reuse it. Create new Sidekicks in this workstream by default. Use personal or workspace Sidekicks when explicitly requested or clearly appropriate.

The companion technical design specifies exact wire contracts and reuses the repository’s established tool conventions. It must not expand this product scope into a separate orchestration system.

## Rollout

Ship through direct cutover without a feature flag. Implicit teams are active; explicit team-management tools and UI remain deferred.

Use a simple operational stop or drain of old execution before cutover. Do not build transparent conversion of in-flight runs, queues, pending questions, or Sidekick drafts. Persisted conversation history and saved Sidekick definitions remain available. Use existing recovery behavior for new executions.

Update the owning subsystem documents when implementing. An implementation plan belongs in a later change.

## Acceptance

1. **Conversation:** Three participants keep conversing during long research, and Rally answers an unrelated question without waiting for the worker. Ordinary human messages do not automatically interrupt it.
2. **Delegation and continuation:** Rally starts a worker with required name, description, and message; listing returns those values with its ID and existing status. Start returns the agent ID after admission. Rally receives the final answer and follows up in the same substream. A child uses the same primitives to delegate further without task records or separate return-routing machinery.
3. **Stop and archive:** Stopping an agent stops its owned descendants, but not independent Sidekicks or teammates. A later message continues the addressed agent without automatically restarting descendants. Foreground stop does not unexpectedly stop other agents. Archiving a workstream stops its active agents and owned descendants while leaving independently owned Sidekicks and their scheduled runs unaffected.
4. **Messaging:** Send and reply return the accepted message’s ID. A running recipient receives the message at its next existing safe boundary without interrupting in-flight work; an idle or stopped recipient starts execution. Replies reach the correct conversation, including concurrent Sidekick exchanges. Understanding is acknowledged in ordinary prose, not a stored semantic state. Existing resource references carry image and other context.
5. **Teams:** Product flows create implicit teams and add members. A Sidekick participates in multiple teams, each with its own roster and exchange scope. There is no membership removal, team-management UI, or special multi-team context-management subsystem.
6. **Minimal UI and tool surface:** Only the correctly pluralized running-agent count is shown. Participants cannot inspect or chat with workers. The model has no `read_agent` tool; status questions use `list_agents` or ordinary messages. No progress tracking infrastructure is added.
7. **Sidekick setup:** Discovery includes ownership scope and presents current-workstream Sidekicks first. Given a suitable existing workstream Sidekick, Rally reuses it rather than creating a duplicate or choosing a personal or workspace Sidekick without a reason. New Sidekicks default to current-workstream ownership; explicit requests and appropriate uses of other scopes still work. Its authoring agent handles setup, questions, and saved results. Other agents lack drafting tools; existing validation governs configuration writes.
8. **Tool access:** Workers load eligible plugins independently and perform authorized writes. Existing principal, credential, resource, and peer lifecycle boundaries continue to hold.
9. **Hints and judgment:** Image generation exposes the optional long-running hint. Model evaluation covers useful delegation, direct use of already-asynchronous tools, and execution by a background worker without forced recursive delegation. There is no deterministic delegation gate or conflict/advisory classifier.
10. **Recovery and verification:** Existing durable execution and delivery recover after restart without duplicate effects. Exercise the main flow in a real desktop window and the configured medium fallback model. Runtime integration tests prove the relevant behavior can fail; do not add tests that merely mirror prose or fixtures.

## Open questions

1. **Responsiveness target:** Choose a concrete useful-response target within the proposed 10–60 second P50 range before performance acceptance; acknowledgement and actual conversational availability are different observations.
2. **Wire details:** Map existing execution status and stop results into the agreed tool payloads, and specify validation and failure envelopes using repository conventions. Start, list, send, reply, and stop inputs are agreed above; there is no inspection tool.
3. **Shared resources:** Resolve how existing resource controls apply to delegated execution without introducing new scheduling or lifecycle subsystems. Archive behavior is agreed under Stop and continue.
