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
| `apps/api/src/durable-objects/workspace-do.ts` | Migration 59 and internal host RPCs. |
| `apps/api/src/services/agent-communication-service.ts` | Creation, contact authorization, attachment forwarding, delivery, discovery and owned stops. |
| `apps/api/src/services/agent-communication-plugin.ts` | Model tools and coordination guidance. |
| `apps/api/src/services/agent-message-content.ts` | Durable sender/reply content, rendered consistently on admission and context rebuild. |
| `apps/api/src/durable-objects/substream-agent.ts` | Independent execution, durable message admission and background stop gate. |
| `apps/desktop/src/renderer/lib/channel-viewer-state.ts` | Takes the running background-agent counts from each Channel row on the workspace socket; a tombstoned Channel evicts them. |
| `apps/desktop/src/renderer/components/workstream-composer.tsx` | Ordinary message entry and a noninteractive background count. |
| `apps/desktop/src/renderer/components/background-agent-activity.tsx` | Retained count label, composer-edge reveal, shimmer and fading number wheel. |
| `apps/api/test-workers/agent-teams.test.ts` | Real workerd migration and RPC coverage. |
| `apps/api/test-workers/automation-post-result.test.ts` | Real creation, admission, continuation, reply and Sidekick contact coverage. |

## How it works

An agent ID encodes `parentKind/parentId/substreamId` within the host's workspace.
Creation and discovery supply it; no independent agent identity is allocated.
Different Sidekick authoring conversations can each have substream `0`. A
Sidekick's conversations are stored under `automation`, but the agents plugin
shows the model `sidekick/…` (`modelAgentId`) and accepts either spelling back
(`ModelAgentIdSchema`); message envelopes and host notices use the same
spelling.

The originating conversation supplies its implicit team's stable identity.
Ensuring a team adds its origin. A host-authorized Sidekick contact adds the
Sidekick. Recording delegation adds the worker to the owner's team and records
ownership independently. Repeating those operations preserves existing records.
Membership has no removal operation.

Discovery reads a team's roster after checking the requester belongs to it.
Send requires a shared team. Delivery refuses `agent_self_message` when the
resolved recipient is the sender, before admitting input or waking a loop. The
host prefers the incoming exchange's scope;
otherwise the stable first common team supplies the scope. Reply uses the
received message's original sender and team, and only its recipient can reply.
Replies to Sidekick authoring conversations and their inclusion in teammate
listings recheck current Sidekick access; permanent team membership does not
preserve revoked domain access or reveal inaccessible names and descriptions.

`agent_message_routes` stores addresses, not bodies or delivery receipts.
Recording a route does not prove a recipient accepted a message: recipient
input admission owns delivery. Replays cannot change the original route.
Recursive ownership queries return descendants, not teammates; reparenting and
cycles are refused.

The host derives a stable UUID from the durable tool effect identity for creation
and delivery replay. Start reserves an ordinary child under the same conversation
parent, bootstraps the existing harness, and provisions its name, description and
inherited model override. It grants no private-child viewer memberships. The
child retains its inherited execution principal; admission resolves it locally,
and messages do not replace it with a teammate's credentials. A worker's
Terminal is its owner's: it uses the sandbox and checkout of the conversation
or Sidekick it works for, through further delegation, under a mutation lease
held per tool call, so a worker's write waits with `sandbox_busy` only while a
sibling or its owner is mid-call, and its reads take no lease, waiting only
for a sandbox that is not yet running or whose checkout is still being
prepared ([`terminal-workspaces.md`](terminal-workspaces.md)).

Creation reserves the child and obtains the current generation in one parent RPC.
Child reservation refuses archived parents. Bootstrap, identity provisioning and
background initialization use one child RPC while retaining their existing
validation, projection and replay paths. Initialization refusals retain the
underlying authority error code, including provisioning failures. Team setup starts concurrently with child reservation and initialization.
A shared promise reuses the same team within this execution; ownership registration
still waits for both team setup and the child's background state. The initial assignment reuses the resolved
team. Delivery checks parent authority and generation at the recipient, without
a sender preflight or a preliminary read of the recipient's runtime. Teammate
status reads run concurrently after workspace roster authorization; Sidekick
access is still checked before reading each Sidekick.

Agent messages reuse the durable non-human input preparation path (whose stored
preparation kind remains `automation_activation`). Their own structured content
is tagged `agent_message`, preserving sender, reply reference and explicit resource
IDs when context is rebuilt. Admission puts messages at safe execution boundaries
and wakes an idle loop without waiting for completion. The live conversation
parent refuses archived destinations even before the child projection catches up.
Explicit forwarding to an authorized Sidekick may broaden the attachment audience;
this was approved on 2026-09-15. Forwarded resources must already be attached or inherited in the
sender's scope. Broader Sidekick read access alone does not permit forwarding
to another conversation. The host normalizes repeated
IDs and validates the whole list before creating a worker. The recipient prepares
canonical descriptors without linking resources, then stores them with the admitted
pending input. Ordinary transcript promotion commits the links with the message,
so refused admission leaves no attachments behind. Context rebuilding uses normal
attachment manifests and current-turn image projection. A textual resource ID
does not create an attachment or change permissions. Model-facing tools keep
the existing composed-message and attachment limits, also enforced at admission.

`sidekick_attach_resource({ sidekickId, resourceId })` shares one resource
without a message, team membership or activation. Use the Sidekick UUID from
creation or discovery and a Rally resource UUID visible to the calling
conversation. The service applies the same Sidekick access rule as contacting
its wizard, then uses the normal `attach_resources` product
operation on the wizard's conversation with its existing sharing rules.
It returns `{ sidekickId, resourceId, alreadyAttached }`; repeats keep one link.
The wizard and its runs use the
[shared resource scope](agent-attachments.md#authorized-work-stream-discovery-and-text-hydration).
This direct attachment remains until explicitly removed; it is independent of inherited home or conversation attachments.

Conversation migration 60 stores the background principal and a stop timestamp.
Migration 69 adds the root conversation: the first conversation up the
delegation chain that nobody delegated. `start_agent` sets it to the starter's
own conversation, or to the starter's root when the starter is itself a
background agent.
Under a Sidekick, a non-main root is the worker's run authority: activation and
model/tool boundaries retain that run's pause, principal and stop-generation
fences without loading its instructions. Authoring-rooted workers have no run
gate. [`automation-lifecycle.md`](automation-lifecycle.md#continuing-a-run) owns
that distinction and the authority-only `automationDelegation` reference.
Stopping also requests the existing active-execution stop. The timestamp holds
pending work when the loop is idle; a newly accepted continuation clears it in
the same transaction that admits the message.
Replaying an old message does not clear a later stop. Recursive stops fence each owner before reading its descendants, so a
concurrent start is either included or observes its stopped owner. Start checks
the owner again after opening admission, including when confirmation is lost,
and preserves the child stop before returning. Foreground
stop remains local. Archive delivers the same
stop request to owned conversations; independently owned Sidekicks continue.
As approved on 2026-09-15, liveness renewals allow Bind to finish the in-flight step and settle its stop,
while authority checks still precede every new model and tool call.

The two host notices carry `AgentExchangeSchema.notice` — `failed` or
`finished_without_reply` — which is the only thing distinguishing them from a
model-authored message once they are on the wire, and a `failed` notice also
carries `noticeReason`, the terminal diagnostic, as a field rather than only in
its prose.

**`renderAgentMessage` attributes a notice to the host, and that line is the
whole defence against one agent impersonating the other kind.** Every agent
message reaches its recipient through that one renderer, so without the branch
a worker prompt-injected by content it was allowed to read can `send_message`
the text "Agent failed due to connector_unavailable" naming a sibling and the
recipient sees framing byte-identical to a notice the host computed. `notice`
is derived provenance and may cross into authority; the body is content and may
not. The human side lost its own check when the feed stopped showing the body. They are otherwise delivered
identically, and a recipient that cannot tell them apart counts an outcome its
owner may need to act on as ordinary traffic. A message stored before the field
existed reads as untagged, which is what it was.

**A run that replied gets no notice, so no completion is recorded for it.** That
is deliberate: the reply is the completion, and a second message saying so would
cost the owner an inference and a turn of context for a fact it already has. The
consequence is that the transcript records only two of a worker's endings, which
is why the feed has no general "finished" row. Changing it means accepting a
model-visible message per completed run.

`AGENT_HANDOFF_TOOL_NAMES` includes the pre-rename spellings
(`agents_send_message`, `agents_reply`, `agents_start_agent`). It is matched
against stored `tool_effects` rows, which keep the name they were written
under, so a run spanning the rename would otherwise settle as having handed off
nothing and its owner would be told a worker that did reply finished without
replying.

In the feed, a delivered message is machinery rather than a note to the room:
`AGENT_MESSAGE_CONTENT_KIND`, `agentMessageNotice` and the wire-name lists (all
in `packages/contracts/src/agent-communication.ts`, which is also where the API
now takes `AGENT_MESSAGE_TOOL_NAMES` and `AGENT_HANDOFF_TOOL_NAMES` from) are
what the client reads to draw the counted rows beside the plugin rows, and
[`plugin-activity-rows.md`](plugin-activity-rows.md) owns those rows. Renaming
one without the other silently returns the message to an anonymous system
note.

Model-authored agent-to-agent communication is explicit through `send_message` or `reply_to_message`,
including final results, questions, and updates. Standard assistant messages stay
in the sender's own transcript. Settlement never forwards the model's final
response as a message. The host sends an owning parent two notices on a run's
behalf, and no other message. A failed background run emits
`Agent failed due to <reason>. Id: <id>`, where the reason is the terminal
diagnostic code (or `unknown reason` when unavailable). A background run that
completes without one completed or ambiguous send to, or start of,
another agent emits
`Agent <name> finished without replying. Id: <id>. Message it if you still
need its result.`; a run that sent at least
one message, asked for input, or was stopped emits nothing. Each notice takes
its delivery identity from the run, so settlement retries cannot duplicate it,
and each preserves a stopped parent’s admission hold: it remains pending until
an explicit continuation resumes the parent. An archived parent refuses
admission without blocking settlement.
The model sends any needed reply before finishing through Bind's ordinary final
response; no `end_turn` tool or completion receipt is required, and the
silent-completion notice is what a worker's owner gets when the reply was
skipped.
Explicit sends use durable tool effect identities and ordinary admission replay;
replaying a send after lost confirmation and a recipient crash must not duplicate input or inference.
An archived destination refuses the send through the normal tool result.
The `start_agent`, `send_message` and `reply_to_message` results each carry a
`next` sentence saying that the reply will arrive as a message whether the
model keeps working or finishes its turn, and that there is no tool to fetch
it; a result is read at the moment the model decides its next step, where a
description was skimmed, so the descriptions say only that the call returns
at once. `list_agents` returns each teammate's `agentId`, name, description
and execution status, plus `pendingWork` for admitted inputs or preparation
that has not yet started a loop. These fields let completion verification
distinguish an idle worker from one with queued work without resuming it;
its reply is still the thing to wait for. A stopped background agent reports
no pending work until an explicit continuation resumes it.

Background identity travels in the existing child common-state projection,
with the agent's root conversation beside the flag. No composer shows a running
background-agent count any longer: the count rode the Channel row's
`backgroundAgentCounts`, which went with Channels, and
[`websocket-architecture.md`](websocket-architecture.md#sidekick-library-synchronization)
records where one would come from.

Agent tools are preloaded through the existing persisted plugin-activation path,
so they are available on the first model call. Bind still validates live execution
authority before every tool invocation. The Sidekick directory tool reuses that
command's active-member authorization through an internal WorkspaceDO read; it
still filters personal ownership. Ordinary directory
callers perform their own active-member check. This is a host-selected execution
path, not a model argument, durable grant, or run-long authorization cache.

Sidekick setup discovery filters the existing authorized directory to the
Sidekick this conversation belongs to, the one it configures or executes, marked
`isCurrentSidekick: true` with `canEdit` true. A Thread owns no Sidekick, so
setup from a Thread lists nothing. Eligibility reuses the existing access
filter, not a new permission model or per-candidate RPC. Actual messages and
mutations retain their existing authorization checks. Other personal and
organization Sidekicks are not setup fallbacks; `find_sidekick` reaches one only
by the exact name the person asked to change. An empty list in ordinary setup
tells the agent to create one with `create_sidekick`, whose `scope` is
`personal` (the default) or `workspace` (the Organization, only when the person
asks), and send setup instructions to its authoring agent. An execution with no
listed candidates instead identifies the existing Sidekick and tells the agent to
complete that activation; it never treats an empty list as a missing
installation. The returned authoring
agent is the Sidekick wizard: the coordinator contacts it directly rather than
creating a relay worker. Shared role guidance applies before and after plugin
loading and limits exchanges to new results, blockers, questions and changed
requirements; acknowledgment-only messages end without another reply.

An explicitly named edit uses `find_sidekick`, an exact, case-insensitive name
lookup over the same authorized directory and contact ownership rule. It can
resolve personal and organization Sidekicks without adding them to setup
candidates; another thread's Sidekick remains excluded. Multiple matches ask
which target the person means, and no match reports the missing target rather
than creating a replacement. The lookup grants no new mutation authority.

Reusable procedures are discovered separately in the Skills catalog and loaded
with `load_skill`; loading their instructions does not message an authoring
agent. A Sidekick's own conversation acts for the thread that owns it. Setup
discovery also returns current `status`, `nextRunAt`, and `lastRunAt`, so an agent
can distinguish a saved draft, an active Sidekick, and a scheduled or previously
executed run. A sent setup message or an old memory fact establishes none of
these. Sending a setup or edit request is dispatch, not completion. The requesting
agent reports the change as saved only after confirmation that the requested
revision was accepted; an already-active Sidekick does not prove a later edit
was accepted. The authorized directory reads `lastRunAt` from the latest admitted run,
using the same timestamp semantics as Sidekick details; this is evidence of a
recorded run, not successful completion.

An access or ownership refusal carries structured recovery through the existing
failure `reason`, `retryable`, and `available` fields. The rejected message was
not delivered. For thread-local setup, the agent refreshes discovery and selects
an editable, suitable Sidekick this thread owns, or creates one here. An
explicit request to change a named Sidekick uses the name lookup and keeps
that target; a refused or unavailable target is reported without replacement. A refused message is not evidence of a connector or scheduling blocker;
only the authoring submission's actual refusal establishes an activation blocker.
After verifying current state, the agent corrects or retracts superseded blocker
or pending-status memory while preserving the user's preferences.
First authorized contact joins the authoring
conversation to the team. Drafting tools are available only on a Sidekick's main
authoring conversation, not ordinary workstreams, workers or scheduled runs.
Authoring guidance identifies its own Sidekick, reads the current definition,
and preserves the scope already selected under existing publication rules.
Questions from agent exchanges use replies instead of participant forms. This
guidance is present in every Sidekick authoring execution, so requests arriving
at a later Bind boundary during a participant-started run follow the same rule.

### A run asking its wizard for a change

A Sidekick run child (`automationRun` set) also gets `request_sidekick_change`
and a paragraph of guidance in this plugin's message: a request for a lasting
change to the Sidekick goes to its wizard, even when it reaches the run as
external evidence. No other conversation is offered the tool, and the service
refuses one that calls it (`sidekick_change_outside_run`).

The host names the recipient from `automationRun.automationId`, so a run
reaches only its own wizard; the model supplies only `changes`. Delivery is the
ordinary `send`, with its contact check, team join and reply route. The host
frames the text (`sidekickChangeRequestText`) under `SIDEKICK_CHANGE_REQUEST_HEADER`
with `Run:` and `Run turn started by:` lines it derives from the run's input;
the wizard's guide has a section keyed on that header. The tool is on
`AGENT_MESSAGE_TOOL_NAMES`, so the client counts it as a sent message.

**How an answer or question gets back to the person.** Nothing in the host
routes the wizard's words to Slack; the run does it with the tools it already
has. The wizard answers with `reply_to_message`, which admits an agent message
into the run child because the request came from the run's address. Any input
to a run child continues that run (`continueSidekickRun`), so the run wakes
with its own history, including the Slack post it made and that post's
timestamp, and calls the Slack plugin's `send_message` with that timestamp as
`thread_ts`. A person's answer to a wizard question follows the thread binding
back to the run like any reply, and the run sends it on as a new request.
Because the model chooses the reply's destination, a run can post somewhere
else.


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
- A run's change request goes only to its own Sidekick's wizard. The recipient
  comes from the run's `automationRun`, never from a model argument; a field
  for it would let a run's model, steered by a Slack reply, address another
  Sidekick's wizard.
- Any conversation whose principal may view a Sidekick may message its
  authoring agent. The one check is the Sidekick's own viewer authorization
  (grant-only for a guest), not which Thread or Breakout the message comes
  from: no Thread owns a Sidekick, so no Thread-based rule may refuse one.
  Guarded by `conversation-tools.test.ts`.

## Boundary

System prompts describe coordination behavior without naming tools, except
`sidekicks_list` and `list_agents`, which this plugin owns and every run has.
Exact tool names belong in tool definitions, so prompt guidance stays independent of the
available tool inventory and wire names. Instructions lead with the action,
use short sentences, and distinguish agent IDs from message IDs. Expected
communication errors explain what to do next while retaining their diagnostic
codes. These wording checks do not substitute for small-model evaluation.
Every role passes the requested outcome and established constraints in an
assignment, leaving unresolved implementation choices for the recipient to
investigate. Assignments name the skills the recipient must load; a skill loaded
by the sender is not evidence of a load by the recipient. Required execution
steps belong in durable run instructions as well as the handoff.
Background agents are explicitly told
to execute their assignment directly and delegate further only when splitting
work would materially help, and that a run ending without a message to their
coordinator is reported to it as finished without replying. Every role is told
how to wait for a delegate: keep working on what does not depend on the result
or end the turn, because the reply arrives as a message and wakes the
conversation, and schedule a single wake-up only as a deadline, never as a
poll. Participant-responsiveness guidance belongs only to
the foreground workstream role. The base prompt and loaded coordination plugin
share the same role selection, including workers spawned by Sidekicks.

These are internal host RPCs, not model-callable team-management tools. Callers
check execution and Sidekick domain authority before adding contacts. Membership
grants no credentials, transcript access, resource access, or control over peers.
SubstreamAgent owns content and execution. Conversation parents retain archive
and viewer authority; a hosted Sidekick owns setup, definitions, and schedules.

Bind remains the core owner of the model/tool loop inside every conversation.
SubstreamAgent supplies durable admission, leases, and persistence through the
existing harness ports. The background stop timestamp only holds future
execution admission: an active lease still recovers and settles through Bind's
existing fenced stop path. Messaging and responsiveness must preserve protocol
ordering, tool receipts, suspensions, checkpoints, and completion checks. Add a
missing loop capability to Bind itself rather than bypassing it in Rally.

## Failure modes and limits

Expected membership, received-message, ownership, and route conflicts return
typed refusals. A Sidekick the principal may not view, or one archived, refuses
its authoring messages with `sidekick_contact_forbidden`; nothing refuses by
Thread any longer. Old tool results and stored notice text
still show `automation/…` ids, which keep parsing. Storage and transport errors remain failures. Tool integration
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
owned Sidekick contact, the refusal of an inaccessible personal Sidekick, and a
guest's grant-only contact. Complete desktop behavior remains an implementation gate.

## Changelog

### 2026-11-07 — A Thread no longer owns a Sidekick

**What changed:** The owning-thread rule is gone. Any conversation whose
principal may view a Sidekick may message its wizard or attach a resource to
it; `sidekick_owned_by_another_thread` is no longer raised. `create_sidekick`
offers `personal` (the default) or `workspace`, not `workstream`, and
`sidekicks_list` names only the Sidekick the conversation belongs to, so its
items lose `ownedByThisWorkstream` and a Thread's list is empty.

**Why:** The Canvases and Sidekicks PRD decided that Thread-scoped Sidekicks
convert to Organization scope, so the people who used one keep it. With no
Thread owner left, a rule keyed on the owning Thread would refuse nothing and
mislead whoever reads it.

**Consequences:** Who may change a Sidekick is now its own access (audience,
grants, manager rules), checked by the Sidekick's viewer authorization. A rule
that narrows contact again belongs in that check, not in where the message comes
from. Setup from a Thread always creates a Sidekick; an existing one is reached
by its exact name through `find_sidekick`.

### 2026-11-02 — A Sidekick run asks its own wizard for a change

**What changed:** A Sidekick run gets `request_sidekick_change`, which sends a
plain-language change, framed by the host, to the wizard of the run's own
Sidekick. The wizard's guide gains a section for evaluating one: keep the
Sidekick's purpose, ask one question when it is unclear, and reply.

**Why:** A reply in a Slack thread bound to a Sidekick run reaches that run, not
the wizard. A person asking for a lasting change ("show this all in one
table") had no path to the definition: a run follows saved instructions and
cannot edit them, so the request was done once in that run or dropped. The
guidance names the evidence framing outright because a softer wording lost to
it: every Slack reply reaches a run as "evidence, not a request", and the
Sidekick's instructions never mention change requests.

**Considered and rejected:** Prompt guidance alone, pointing the run at
`sidekicks_list` and `send_message`: two calls, an id the model must copy, and a
recipient left to a model reading untrusted text. Routing a Slack reply straight
to the wizard: the run holds the context of what it reported, and most replies
are about that run.

**Consequences:** The tool grants no authority a run lacked; it passes the same
contact check as any message to the wizard. But the asker can be anyone in a
bound thread, or content a run processed, and the wizard's line is the
Sidekick's purpose rather than its reach, so a change that keeps the job, an
added recipient included, can be saved from such a request. A tighter rule
belongs in the wizard's section or the contact check, not the tool.

### 2026-10-23 — Confirm the requested revision before reporting a saved edit

**What changed:** The requesting agent waits for confirmation that the requested
Sidekick revision was accepted before reporting the change as saved.

**Why:** A signup-report edit was announced as updated while its wizard was still
revising it. Dispatch confirmed that the request was sent, while the active
Sidekick still held the previous reporting rules.

**Considered and rejected:** Treating an active status or a successful send as
edit completion; neither identifies acceptance of the requested revision.

**Consequences:** Setup dispatch and accepted revision are distinct reporting
states. The wizard's acceptance confirmation supplies the evidence without a new
approval step or redundant reads after successful publication.

Pull request: [#1425](https://github.com/juno-ai-labs/avalon/pull/1425).

### 2026-10-22 — Attach Sidekick context without waking its wizard

Agents previously had to send a message to forward a resource, coupling context
sharing to another model execution. `sidekick_attach_resource` now reuses the
ordinary authorized attachment operation and its unique resource link. A new
attachment store or message-based workaround was rejected: the wizard already
owns the attachments that its activations inherit. Preserve current source
visibility, Sidekick access and owning-thread checks, and keep this operation
independent of message delivery and activation.

### 2026-10-22 — Identify the current Sidekick in discovery

Discovery includes the Sidekick this conversation configures or executes and
marks it with `isCurrentSidekick`, while preserving the existing access filters.
Self-addressed sends and replies are refused before input admission so listing
itself cannot wake it with its own setup instructions.
A scheduled calendar run received an empty list because discovery excluded
itself, then followed the result’s create instruction and installed a duplicate.
Returning its identity prevents that misleading absence without hiding valid
Sidekick-management tools or deduplicating unrelated workflows by title.

### 2026-10-22 — Contact the wizard directly and end acknowledgment-only exchanges

**What changed:** Sidekick setup uses its discovered wizard directly. Shared
coordination guidance reports assignment results once and does not answer
acknowledgments or repeat waiting status.

**Why:** The calendar experiment added two relay helpers around one wizard,
then spent repeated model turns acknowledging that everyone was waiting. The
wizard already owns definition editing and normal messages deliver its result;
a relay chain adds latency and can strengthen constraints the user never set.


### 2026-10-21 — Assign outcomes and carry procedures across delegation

**What changed:** Shared role guidance asks every delegator to pass outcomes,
constraints and open decisions, name skills the recipient must load, and retain
required execution steps in durable instructions.

**Why:** The content-calendar coordinator assigned scheduled polling before the
helper investigated events, and procedures loaded by the coordinator did not
reach the agents that needed them. Preselecting an unverified mechanism and
assuming skill context transfers both turn delegation into a source of omissions.
The existing shared role function carries this rule before and after plugin
loading, without adding another prompt surface.

### 2026-10-21 — Setup discovery stays in its thread and recovers against current state

**What changed:** Setup discovery returns only authorized candidates owned by
this thread, with explicit creation guidance when empty. Named edits use a
separate exact-name lookup for accessible personal and organization Sidekicks.
Recovery detail lives in the result or refusal rather than repeating the full
procedure in the always-loaded prompt. Reusable instructions
stay in the separate Skills catalog, with skill terminology for names, loaded
instructions and recommendation tools. Sidekick contact refusals give structured
rediscovery and creation guidance. The directory returns lifecycle status and next/last run
times (with last-run admission read from actual run records), and the agents plugin requires those observations before claiming
activation or execution.

**Why:** The ownership guard stopped a later update to a previously misselected
Sidekick, but the coordinator kept describing that foreign draft as its own
pending monitor and repeated a saved Organization-connection blocker. Preventing
a write did not repair the agent's plan. A broad user directory also made a
foreign draft look like a setup candidate. Filtering by the existing ownership
rule was chosen over ranking foreign results or adding another permission
framework. The refusal now identifies the
undelivered operation and its recovery path, while discovery supplies the state
needed to verify the result. Automatically retargeting or creating a Sidekick
was rejected because a request to change one explicitly named must preserve
that target.

**Consequences:** Recovery remains within current ownership and user intent.
Refusals and remembered claims cannot stand in for submission or schedule state.


### 2026-10-15 — Only the owning thread changes a thread's Sidekick, and the model reads `sidekick/…`

**What changed:** Messaging a Sidekick's authoring agent, which is how a
Sidekick's setup changes, is refused with `sidekick_owned_by_another_thread`
when another thread owns that Sidekick. `sidekicks_list` returns
`ownedByThisWorkstream` and `canEdit` from the same rule
(`sidekickOwnership`) in place of `owningWorkstreamId`, and no longer sorts.
A Sidekick's own conversation no longer lists itself. A guest reaches a
Sidekick's authoring agent only through grants. The model reads and writes a
Sidekick's agent id as `sidekick/…` while storage keeps `automation/…`, and the
agents plugin's guidance now says what a Sidekick is.

**Why:** A thread asked to set up a monitor listed Sidekicks, got another
thread's blank `"New Sidekick"` draft first with scope `"workstream"`, took it
for its own, and rewrote it by message. The owner id was the only true signal,
the model is not given its own thread id to compare against, and nothing on the
server stopped the write. The draft-submission guard that did check ownership
("not one this thread owns") sat on a room path no room could reach. A model
also had no reason to connect an `automation/…` id to a Sidekick, which is
where "the monitor automation" in its replies came from.

**Considered and rejected:** Returning only this thread's Sidekicks, which
would make the flag unnecessary, but would also stop a thread from changing the
person's own personal Sidekick when asked. Ownership per Breakout, which would
stop one Breakout taking over another's draft, but would also stop Main
changing a Sidekick made in its own Breakout. Changing the stored id format,
which keys four team tables and seeds delivery ids, for no gain to the model.

**Consequences:** Ownership is answered by the host and enforced where a
message is admitted, so prompt wording is a hint, not the guard. A personal or
organization Sidekick stays changeable from any conversation that can reach it;
the management check on save still decides whether the person may. A
`sidekick/…` id a model writes must keep parsing, and so must the
`automation/…` ids already in old tool results.

Shipped in juno-ai-labs/avalon#1245.

### 2026-09-24 — Count background agents in the conversation that started them

**What changed:** Each background agent records its root conversation
(conversation migration 69) and carries it in its directory projection. The
Channel sends running counts per root conversation, limited to the ones the
viewer can see, and the composer reads the one for the conversation it belongs
to.

**Why:** The Channel sent one total, and every conversation's composer drew
it, so two agents started from a Breakout read as "2 background agents
running" in Main and in every other Breakout too. The root, not the direct
starter, is what gets counted: a worker's own conversation is never opened, so
a nested worker counted against it would show nowhere. This matches how
Terminal resolves which sandbox a worker uses. Resolving the root through the
Organization's `agent_delegations` on each metadata read was rejected: it adds
a cross-object call to every control frame, while the root never changes after
start and costs one column. Agents started before this change have no root and
count in Main until they end; backfilling them was not worth it for workers
that finish in minutes.

### 2026-09-19 — Ending the turn is the wait, the tools say so, and a silent completion is reported

**What changed:** The `start_agent`, `send_message` and `reply_to_message`
results carry a `next` sentence: the reply will arrive here as a message
whether you keep working or finish your turn, and there is no tool to fetch
it. Their descriptions say only that the call returns at once, where they said
"does not wait"; the delivery contract is stated once, in the result, where it
is read. Every role's guidance gained four short sentences: after delegating,
keep working on what does not need the result or end the turn with a short
status; the reply arrives as a message and wakes the conversation; do not poll
or resend; schedule one wake-up only as a deadline, not a repeating one. A
background agent is also told to send its findings, or the reason it has none,
before finishing. The host emits
`Agent <name> finished without replying. Id: <id>. Message it if you still
need its result.` to the owner of a background run that completes without one
completed send to any agent, with the same per-run delivery identity and
stopped-owner handling as the failure notice. `start_agent` counts as a
hand-off, because a worker that delegated and ended its turn is waiting, not
finished; an ambiguous send counts too, because reporting a message that most
likely landed as silence would invite a resend.

**Why:** In the "Avalon scroll gradients" substream of 2026-09-18 the
foreground agent delegated, then stayed in its run: four `list_agents` calls,
one `current_time`, three nudges, and a competing implementation, while the
reply it was waiting for landed at a safe boundary 14 seconds after it was
sent. The delegation contract, fire and forget with the reply admitted as an
input, was invisible where the model decides: the result said nothing about
delivery, the directory advertised execution status, and ending a turn reads
as "done" in every other tool ecosystem the model knows. The one case ending
the turn could not cover was a worker that finishes without sending anything,
which was silent; the notice closes it, so a deadline wake-up is a backstop
rather than the wait.

**Considered and rejected:** A loadable skill for the guidance: the model
loads a skill when it thinks to, and the moment that matters is the
delegation itself, where the always-active plugin's text is already in
context. A waiting run state that parks the run until a reply is admitted,
reusing the elicitation suspension: it would remove the false choice between
polling and finishing, but ending the turn already is that wait once the
result says so, and a parked run is one more state for stop, archive and
recovery to reason about. A repeating wake-up while a delegate works: each
firing is a full inference at the run's context, and the 12-minute delegation
above would have fired 24 times. Dropping `status` from `list_agents`: the
field read as something to poll, but the uninterrupted-workstreams PRD requires
it and it is the one way to ask whether a teammate is still running without
resuming it; the guidance carries the no-polling rule instead.

**Consequences:** A worker that completes without replying now wakes its
owner once, which costs the owner one inference; a worker that reports
"nothing to do" should say so with a reply rather than by finishing. The
Workers suite's delegation tests observe that notice after every silent child
completion. The `next` sentence is result text, not description text, so a
change to how replies are admitted has to change it too.

### 2026-09-18 — Agent tools lose their prefix, and `reply` gains an object

**What changed:** `avalon:agents` declares no wire prefix, so its tools reach
the model as `sidekicks_list`, `create_sidekick`, `start_agent`, `list_agents`,
`send_message`, `reply_to_message`, and `stop_agent`. The sixth of those was
`reply`; it is renamed here, which also moves its derived capability from
`agents.reply` to `agents.reply_to_message`. The mechanism and the rule for the
prefix are in [`agent-harness.md`](agent-harness.md) and
[`agent-tools.md`](agent-tools.md); what belongs here is what the prefix was
carrying for these tools.

**Why:** The plugin is always active, so `agents_` distinguished it from
nothing — the model can neither load it nor unload it, and no other plugin
offers a second `start_agent`. But the prefix was not only a namespace for two
of these names. `start_agent`, `list_agents` and `stop_agent` carry their own
subject; `agents_reply` and `agents_send_message` were leaving the object of the
verb to the prefix, and bare they say nothing about *who* they reach. A message
to a person, or into a connector's channel, is a plausible thing for a model to
want in the same turn, so that is a wrong reading it could actually take.
`reply` takes its object back in its own name. `send_message` does not, because
there is no equally natural name for it that does — `send_agent_message` reads
as a second kind of message rather than the only kind this tool sends.

**Considered and rejected:** Keeping `agents_` on the whole plugin for the sake
of those two. It would have paid a prefix on five names that did not need one to
fix two that did, and the fix for a name that does not say enough is a better
name.

**Consequences:** Three things stand in for what the prefix was doing for
`send_message`, and a change here should keep all three: the plugin's
instructions name the addressee in every sentence that reaches for it; the
transcript rows say "Messaged a teammate" rather than "Sent a message", so a
misfire is legible in the feed; and capability checks still bound what the call
can do. If a model is seen sending an agent message where a person was meant,
that tool is where to look, and renaming it the way `reply_to_message` was
renamed is the fix rather than restoring the prefix to all seven. The capability
rename is safe because nothing reads a frozen scope's `eligibleCapabilities`
back to authorize a call — it is recorded for forensics, and a scope hash
already drifts legitimately across a deploy (see `persistImmutableRunScope`).
A row written before this change stores the wire name `agents_reply`, which is
neither the current name nor `agents_` plus the current name, so
`AVALON_TOOL_PROSE` carries it as its own entry rather than through the derived
mapping the other agent tools use.

One transitional gap is accepted rather than closed. The rename moves both
`name` and `capability`, which `storedToolPolicyMatches` compares against a
receipt's stored execution plan. `legacyReceiptIdentity` — the existing
mechanism for exactly this — is populated only for connector plugins, and
`avalon:agents` resolves through the loadable-built-in branch, which sets it to
`null`. So a run resumed across this one deploy that had already completed a
`reply` call at a given turn replays as a policy mismatch rather than a
recognized completion: `findCompletedToolResult` returns null and the call lands
in recoverable-write reconciliation. That fails safe — no duplicate message is
sent — but reads as a stalled delegation until the run settles. It is bounded to
in-flight runs at deploy time. Populating `legacyReceiptIdentity` for built-ins
is the fix if this class of rename happens again; it was not worth building for
one tool.

### 2026-09-15 — Remove caller-orchestrated delegation round trips

A production image delegation spent seconds in discovery and creation before its
worker could start. Parent reservation now supplies the generation, child setup
uses one RPC, and a send leaves parent-authority validation and principal selection
to the receiving object. Team initialization is reused within a command and roster
status reads run concurrently. Agent tools preload through normal activation, and
Sidekick listing trusts Bind's fresh per-command member check instead of issuing
the same D1 check again. Non-harness directory callers retain that check. The removed sender checks duplicated decisions the
receiver already owns; no new asynchronous acceptance contract or scheduler was
needed. Admission still persists input before returning, initialization retains
its replay paths, and owner stop checks remain on both sides of delivery. Realtime
outbox settlement remains unchanged. These reductions do not establish the command
latency targets of p50 250 ms and p90 500 ms; production timing is still required.

### 2026-09-14 — Separate communication membership from execution ownership

Long work must leave Rally's foreground loop without introducing a parallel task
system. Teams provide one communication scope for parents, workers, and Sidekicks;
separate ownership supports descendant stops. Conversation IDs and message
references replace new agent identities, friendship records, and return-routing
machinery. Multi-team membership stays additive, with models managing context.
The same substream harness and durable non-human mailbox now carry execution
and messages; a second scheduler or task lifecycle would duplicate their recovery.
Sender/reply content must survive both admission and context rebuilding. Attachment
links follow the same pending-input promotion: linking before admission allowed
an archive race to retain resources from a refused message.

Communication is explicitly model-directed through send/reply tools. Automatically
forwarding final assistant responses introduced a second delivery path and an
acknowledgment loop, then required a completion-suppression tool. Removing that
path keeps ordinary completion in Bind and makes every inter-agent message an
intentional tool call. The sole host-generated exception is a concise parent
failure notice, because a failed agent may be unable to report its own failure.

The count uses restrained motion to make background activity visible without
turning it into a separate management surface. Its label stays mounted while
the composer-edge reveal closes; changed digits roll and fade, and reduced-motion
preferences disable movement and shimmer.
