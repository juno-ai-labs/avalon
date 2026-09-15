# Wire contract and implementation design

This document records the implementation contract for the PRD. Product scope stays in the PRD; remaining acceptance work is tracked in the plan.

## Model tools

The built-in `rally_agents` plugin supplies these tools. The workspace, sender, current team, execution principal and model are host context, never model arguments.

| Tool | Arguments | Result |
| --- | --- | --- |
| `start_agent` | Required `name`, `description`, `message`; optional `attachmentIds` | `{agentId}` after independent substream creation and opening-message acceptance |
| `list_agents` | `{}` | `{agents: [{agentId, name, description, status}]}` for the current team's other members |
| `send_message` | Required `agentId`, `message`; optional `attachmentIds` | `{messageId}` after durable recipient acceptance |
| `reply` | Required received `messageId`, `message`; optional `attachmentIds` | `{messageId}` identifying the accepted reply |
| `stop_agent` | Required `agentId` | `{stopped: true}` after requesting stops for the agent and its owned descendants |
| `sidekicks_list` | `{}` | `{sidekicks: [{sidekickId, agentId, name, description, scope, owningWorkstreamId}]}` with current-workstream results first |
| `create_sidekick` | Optional `scope`: `workstream` (default), `personal`, or `workspace` | `{sidekickId, agentId}` for a minimal Sidekick ready to receive setup instructions |

Message inputs require nonblank text or at least one attachment. They reuse existing message and attachment bounds; start metadata uses existing conversation name/description bounds. Unknown fields are rejected. Start does not accept a model selector, parent selector, task specification, or copied transcript. `list_agents` exposes existing loop status (`idle`, `executing`, or the existing stopped control state); it is not a task-completion ledger.

An agent ID encodes `parentKind/parentId/substreamId` inside one host workspace. This distinguishes every Sidekick's main substream `0`. Callers reuse IDs returned by tools. The encoding is validated by the shared contracts and is not an independent agent registry.

Read tools use normal read-safe receipts. Start, creation and messaging derive stable UUIDs from the host's durable tool effect, so retries address the same substream and message. Stop uses the existing record-before-execute receipt policy; an uncertain stop is not blindly replayed against later work.

## Host relationships and authority

WorkspaceDO owns teams, additive membership, delegation edges, and immutable message routes. A conversation supplies its implicit team's identity. Nested workers join that team; authorized Sidekick contact adds an independently owned teammate. Shared membership authorizes communication without transferring credentials, ownership, resource access, or transcript access. Sharing a member does not merge rosters.

Start provisions an ordinary child under the same conversation parent using the same harness and inherited model override. Only explicit opening text and resource references enter its context. The parent grants no private-child viewer membership, so participants cannot inspect it. The child retains its inherited execution principal. A teammate's later message does not pool or replace that principal's personal connector grants.

Reply resolves only a message received by the sender and retains that message's original team and sender. Send resolves a shared team, preferring the current exchange's scope. No model-selected team, friendship, directional channel, or separate return destination exists.

Sidekick contact uses existing parent viewer authorization before adding membership. Discovery uses the authorized Sidekick directory. Minimal workstream-scoped creation requires participation in its owning workstream. Only the Sidekick's main authoring conversation receives drafting tools; all other conversations message it. Existing domain save validation remains authoritative.

## Delivery and execution

The recipient's existing durable non-human input-preparation pipeline owns delivery and replay. The stored preparation discriminator remains `automation_activation`; agent content has its own `agent_message` tag. Its sender, received message ID, team reference, text and resource IDs survive both initial admission and later context rebuilding.

Send and reply return after persistence, without waiting for execution. Idle recipients wake independently. Running recipients see input at the existing safe boundary; their in-flight model/tool work is not interrupted. No read/applied receipt or semantic acknowledgment state is added. Models acknowledge or ask questions by replying.

Forwarded attachments must already be attached to the source conversation and are attached to the recipient through existing runtime resource operations. They are resource IDs, not a new payload or storage system. Media presentation remains an end-to-end validation requirement.

A stop requests existing active-execution cancellation and retains a background stop timestamp to hold not-yet-started work. A newly accepted continuation clears it; an old message replay does not. Continuing one agent does not clear its descendants' stops. The live parent archive check refuses new delivery even before child projections catch up. Active non-occurrence child executions also check parent authority before further tools.

## Remaining implementation decisions

Terminal-result delivery must use the existing durable external-settlement machinery and ordinary reply references. Its exact interaction with explicit replies and reply-loop avoidance remains to be completed and reviewed. Background count projection, archive traversal, attachment rendering, and removal of the participant queue/steer control remain acceptance work, not claims of shipped behavior.
