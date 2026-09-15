# Agent communication

Agent communication reuses conversation identities, workspace-local teams,
message references, and separate delegation ownership. A Sidekick can join
several teams without becoming a child of any of them. The complete execution
and UI work is tracked in the [implementation plan](PRDs/2026-09-14_uninterrupted-workstreams/plan.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/agent-communication.ts` | Conversation addresses and strict message schemas with attachments. |
| `apps/api/src/durable-objects/agent-team-storage.ts` | Teams, additive membership, ownership, and immutable message routes. |
| `apps/api/src/durable-objects/workspace-do.ts` | Migration 57 and internal host RPCs. |
| `apps/api/src/services/agent-communication-service.ts` | Creation, contact authorization, attachment forwarding, delivery, discovery and owned stops. |
| `apps/api/src/services/agent-communication-plugin.ts` | Model tools and coordination guidance. |
| `apps/api/src/services/agent-message-content.ts` | Durable sender/reply content, rendered consistently on admission and context rebuild. |
| `apps/api/src/durable-objects/substream-agent.ts` | Independent execution, durable message admission and background stop gate. |
| `apps/api/src/durable-objects/workstream-do.ts` | Owned archive stops and aggregate background count from child projections. |
| `apps/desktop/src/renderer/lib/use-workstream-control-socket.ts` | Ephemeral count updates and clearing unavailable state. |
| `apps/desktop/src/renderer/components/workstream-composer.tsx` | Ordinary message entry and a noninteractive background count. |
| `apps/api/test-workers/agent-teams.test.ts` | Real workerd migration and RPC coverage. |
| `apps/api/test-workers/automation-post-result.test.ts` | Real creation, admission, continuation, reply and Sidekick contact coverage. |

## How it works

An agent ID encodes `parentKind/parentId/substreamId` within the host's workspace.
Creation and discovery supply it; no independent agent identity is allocated.
Different Sidekick authoring conversations can each have substream `0`.

The originating conversation supplies its implicit team's stable identity.
Ensuring a team adds its origin. A host-authorized Sidekick contact adds the
Sidekick. Recording delegation adds the worker to the owner's team and records
ownership independently. Repeating those operations preserves existing records.
Membership has no removal operation.

Discovery reads a team's roster after checking the requester belongs to it.
Send requires a shared team. The host prefers the incoming exchange's scope;
otherwise the stable first common team supplies the scope. Reply uses the
received message's original sender and team, and only its recipient can reply.

`agent_message_routes` stores addresses, not bodies or delivery receipts.
Recording a route does not prove a recipient accepted a message: recipient
input admission owns delivery. Replays cannot change the original route.
Recursive ownership queries return descendants, not teammates; reparenting and
cycles are refused.

The host derives a stable UUID from the durable tool effect identity for creation
and delivery replay. Start reserves an ordinary child under the same conversation
parent, bootstraps the existing harness, and provisions its name, description and
inherited model override. It grants no private-child viewer memberships. The
child retains its inherited execution principal; messages do not replace it with
a teammate's credentials.

Agent messages reuse the durable non-human input preparation path (whose stored
preparation kind remains `automation_activation`). Their own structured content
is tagged `agent_message`, preserving sender, reply reference and explicit resource
IDs when context is rebuilt. Admission puts messages at safe execution boundaries
and wakes an idle loop without waiting for completion. The live conversation
parent refuses archived destinations even before the child projection catches up.
Attachments must already be attached to the sender. The host normalizes repeated
IDs and validates the whole list before creating a worker or linking any resource to the recipient
through existing runtime resource attachment operations. Admission retains their
ordered canonical attachment descriptors, and context rebuilding uses normal
attachment manifests and current-turn image projection. Resource IDs alone are
not a substitute for those durable message attachments. Model-facing tools keep
composed-input limits; internal admission carries generated final responses and
all their attachments in full, without applying the composer ceilings to output.

Conversation migration 57 stores the background principal and a stop timestamp.
Stopping also requests the existing active-execution stop. The timestamp holds
pending work when the loop is idle; a newly accepted continuation clears it in
the same transaction that admits the message.
Replaying an old message does not clear a later stop. Recursive stops fence each owner before reading its descendants, so a
concurrent start is either included or observes its stopped owner. Start checks
the owner again after opening admission, including when confirmation is lost,
and preserves the child stop before returning. Foreground
stop remains local. Archive delivers the same
stop request to owned conversations; independently owned Sidekicks continue.
Liveness renewals allow Bind to finish the in-flight step and settle its stop,
while authority checks still precede every new model and tool call.

Textless `needs_input` outcomes send their recorded reason to the coordinator
through an ordinary reply; non-inspectable workers must not need input silently.
Completed responses use existing external settlement to send an ordinary reply
to the originating exchange. The reply identity is stable for that execution,
so settlement recovery uses normal message replay. Stopped work does not publish
partial text as success. An archived destination ends delivery with the existing
refusal instead of retrying a permanently closed conversation. The proposed
`end_turn` tool uses Bind's native tool-ended completion to suppress an automatic
reply. The host records this explicit outcome in its existing durable receipt
and verifies it before terminalization and after recovery. Empty-completion
checks remain enabled; no response text is fabricated.

Background identity travels in the existing child common-state projection.
The conversation parent counts running background substreams, including nested
workers under that parent, and sends the count with control metadata. The
desktop holds it only while that connection is available and renders a singular
or plural line above the composer. It exposes no worker inspection or direct
chat. Participant messages use the ordinary safe-boundary admission path.

Sidekick discovery uses the existing authorized directory and ranks the current
workstream's Sidekicks first. Minimal creation defaults to workstream ownership;
setup travels through messages. First authorized contact joins the authoring
conversation to the team. Drafting tools are available only on a Sidekick's main
authoring conversation, not ordinary workstreams, workers or scheduled runs.
Authoring guidance identifies its own Sidekick, reads the current definition,
and preserves the scope already selected under existing publication rules.
Questions from agent exchanges use replies instead of participant forms.


## Invariants

- Membership and ownership are separate, so a shared Sidekick is not stopped
  just because one team stops its workers.
- Sharing a member never merges rosters, preventing accidental transitive
  discovery and message authorization.
- Reply uses immutable received-message references, so concurrent Sidekick
  exchanges return to their original conversations.
- Related checks and writes commit synchronously in SQLite; interruption cannot
  record an ownership edge without its membership.
- WorkspaceDO is the sole team authority; a D1 fallback would create divergent
  membership decisions.

## Boundary

These are internal host RPCs, not model-callable team-management tools. Callers
check execution and Sidekick domain authority before adding contacts. Membership
grants no credentials, transcript access, resource access, or control over peers.
SubstreamAgent owns content and execution. Conversation parents retain archive
and viewer authority; SidekickDO owns setup, definitions, and schedules.

Bind remains the core owner of the model/tool loop inside every conversation.
SubstreamAgent supplies durable admission, leases, and persistence through the
existing harness ports. The background stop timestamp only holds future
execution admission: an active lease still recovers and settles through Bind's
existing fenced stop path. Messaging and responsiveness must preserve protocol
ordering, tool receipts, suspensions, checkpoints, and completion checks. Add a
missing loop capability to Bind itself rather than bypassing it in Rally.

## Failure modes and limits

Expected membership, received-message, ownership, and route conflicts return
typed refusals. Storage and transport errors remain failures. Tool integration
must translate domain codes into actionable model-facing explanations.
No new membership or descendant-depth caps are introduced. Message contracts
reuse existing name, description, message and attachment bounds. Unknown input
fields are rejected, including model-selected authority and team selectors.

## Testing

`pnpm --filter @rally/contracts exec vitest run src/agent-communication.test.ts`
checks address round trips, explicit context, attachments, and distinct send/reply
parameters. `pnpm --filter @rally/api test:workers test-workers/agent-teams.test.ts`
exercises real WorkspaceDO migrations and RPCs for multi-team Sidekicks, scoped
rosters, reply routes, replay, and descendant ownership. The latter clears only
its own dedicated workspace's new tables between tests. The execution suite also covers hidden idempotent creation, inherited principal,
stop/replay/continuation, a worker reply to the foreground, and independently
owned Sidekick contact. Complete desktop behavior remains an implementation gate.

## Changelog

### 2026-09-14 — Separate communication membership from execution ownership

Long work must leave Rally's foreground loop without introducing a parallel task
system. Teams provide one communication scope for parents, workers, and Sidekicks;
separate ownership supports descendant stops. Conversation IDs and message
references replace new agent identities, friendship records, and return-routing
machinery. Multi-team membership stays additive, with models managing context.
The same substream harness and durable non-human mailbox now carry execution
and messages; a second scheduler or task lifecycle would duplicate their recovery.
Sender/reply content must survive both admission and context rebuilding.
