# Design: external conversation bindings

> Companion architecture for [`prd.md`](prd.md). This is a proposal, not a
> description of shipped behavior. Current behavior is documented in
> [Slack integration](../../slack-integration.md), [Spaces](../../spaces.md),
> and [connectors](../../connectors.md).

The design adds three primitives and changes one:

1. **Binding:** one record that maps an external conversation path to a Rally
   address, for rooms and threads alike.
2. **Run continuation:** input to a Sidekick run child restores that run's
   context instead of starting a generic loop.
3. **Conversation tools:** a general plugin to list, read, and post to Rally
   conversations, with a scope per agent. Sidekicks scope it to their
   attached conversations; Channel and Breakout agents to their own Channel
   and Breakout.
4. **Home conversation (changed):** a Sidekick's `owning_workstream_id` becomes
   an owning substream address.

The Mucker flow is these four combined, with no Mucker-specific code.

## Current seams

| Existing mechanism | Current role | Proposed treatment |
| --- | --- | --- |
| `slack_agent_sessions` in WorkspaceDO | Slack installation + channel ID + root timestamp to one Rally `workstream_id` | Preserve existing rows; migrate them into bindings. Do not mistake the workstream ID for a Breakout address. |
| Slack `slack_thread` origin resource | Link from a Rally Channel to the source thread, with watching off | Keep as provenance. It is not the routing authority. |
| Channel and Space parents, hosted in WorkspaceDO ([hosted conversation parents](../../hosted-conversation-parents.md)) | Space membership, Channel audience, viewer rows and Channel birth (`reserveChannelInSpaces`) in one database | A spawned Channel's birth, its Space placement and its thread binding commit in one WorkspaceDO transaction. |
| Slack Agent ingress | Verifies event, resolves installation, creates or resumes Channel, writes human message | Normalize the external path and resolve a binding before creating a Channel. |
| Connector watch registrations (`matchExternalEventDestinations`) | Fan an external event out to Sidekicks and watched resources; a claimed event skips Suggested Work | Candidate home for bindings; see [Reusing watch registrations](#reusing-watch-registrations). |
| `automation.owning_workstream_id` (`sidekick-do.ts:266`) | The Channel whose Main conversation `sidekick_post_result` posts to | Replace with an owning substream address. |
| `sidekick_post_result` (`integrations.ts:6431`) | A run's only way to post into a room | Remove; `post_to_conversation` covers it. |
| `authoringOrigin` (`packages/agent-harness/src/prompts/workstream.ts:32`) | Slack-only prompt section; nothing sets it | Remove. |
| `sidekick_attachments` per SubstreamAgent, `parent_sidekicks` in WorkspaceDO | This conversation may load this Sidekick as a skill | Leave as is. Conversation attachments get their own WorkspaceDO table. |
| `claimPersistentLoopExecution` (`substream-agent.ts:3895`) | Starts a loop for pending input with no `automationRun` | Restore the run's context when the child belongs to a Sidekick run. |

## Connector-neutral contract

The adapter reports an **external path**: an ordered list of segments from the
outermost provider container to the conversation a message belongs to. Slack
gives `[channel]` for a room and `[channel, thread_ts]` for a thread. Discord
could give `[guild, channel, thread]`; email could give `[thread]`. Each
segment carries the facts the adapter can verify about it:

```text
ExternalNode {
  connectionId, path: string[],
  kind: shared | direct,
  visibility: public | private | unknown,
  displayName?, membershipState: joined | left | unknown,
  childSupport: supported | unsupported | unknown
}
ExternalMessage {
  connectionId, path: string[], messageId,
  actor, text, addressedToRally, providerEventId, occurredAt
}
```

The adapter alone derives these facts from Slack's `channel`, `thread_ts`,
`channel_type`, and `conversations.info`. In particular, it checks `is_mpim`
rather than assuming a `G` prefix means a private channel. The host must not
assume all connectors have invitation events, stable names, native thread
replies, or the same message edit/delete semantics. A connector declares which
facts it can produce; a binding that needs a fact is available only when the
fact is verified.

## The binding record

One record type for every level:

```text
Binding {
  source:  connectionId + external path
  target:  Rally address { parentKind, parentId, substreamId }
           or a Space ID
  deliver: none | converse
  spawn?:  { on: addressed_to_rally, create: channel_in_space }
  state:   pending | active | suspended
}
```

| Use | Source path | Target | deliver | spawn |
| --- | --- | --- | --- | --- |
| Shared Slack room | `[C123]` | Space | none | Channel in this Space |
| Tagged Slack thread | `[C123, 1727.001]` | Channel Main conversation | converse | none |
| Mucker founder DM | `[D456, 1727.002]` | 1 PM run child (`automation`, Sidekick ID, run ID) | converse | none |

`WorkspaceDO` holds bindings, because it already owns connector connection
identity, Slack Agent sessions, and, since Channel and Space parents moved into
it, the Space directory, Channel birth and placement, and Channel and Breakout
audiences.
The unique key is Organization + connection + path. Every active key has one
target. Display name and participant list are attributes, never keys. A
provider ID change is an explicit move of the key (and every key beneath it)
that preserves the target. No client-supplied URL, message text, or
model-proposed target can override a recorded binding.

There is no per-sender admission field. Anyone who can post in a bound thread
reaches its target; the message keeps its sender.

### Resolution

For a verified `ExternalMessage`:

1. Look up the exact path. If it is `active` and its `deliver` is `converse`,
   deliver the message to the target through ordinary message admission.
2. Otherwise walk up the path. The nearest ancestor that is `suspended` stops
   resolution. The nearest `active` ancestor with a `spawn` rule that the
   message satisfies creates the Rally conversation it names and records an
   `active` binding for the exact path, in one claim.
3. Otherwise nothing happens. An unrelated provider message creates no Rally
   work.

Suspending a room therefore stops every thread beneath it without touching
their rows.

### Creating bindings

- **Invitation.** A verified event says the bot joined a shared room. The host
  fetches the room's facts, claims the room path, and creates or reuses its
  Space. A first mention runs the same ensure step if it arrives before the
  invitation event.
- **Spawn.** As in resolution step 2. The binding claim runs in the same
  WorkspaceDO transaction as `reserveChannelInSpaces`, which writes the
  Channel's Organization-side birth with its Space membership already active.
  A duplicate or reordered event therefore finds either nothing or a Channel
  that is fully placed and bound; there is no intermediate state to fence.
- **Outbound send.** When a connector tool that sends a message succeeds during
  a Sidekick run, the host writes a binding from the returned path to that run
  child. The model does not write bindings. Slack's `send_message` already
  returns `channel_id` and `timestamp` (`packages/connectors/src/slack.ts:1747`).
  A send whose result is lost has no binding, and a reply to it is not matched
  by text or timing.

### Reusing watch registrations

`WorkspaceDO.matchExternalEventDestinations` already matches external events
to registered destinations and marks a matched event claimed so it skips
Suggested Work, and `SubstreamAgent.appendWatchedResourceEvent` already
delivers into a named child substream idempotently. That is most of a binding.
The differences: a binding has one owner rather than fanning out, delivers an
attributed human turn rather than a system resource update, can spawn a
Channel, and Slack Agent messages arrive through their own ingress. Before
building a binding table, decide whether bindings become an exact-key,
single-owner registration kind in that matcher. The aim is one routing step,
not three.

## Home conversation and attachments

`automation.owning_workstream_id` becomes an owning substream address:
(`workstream`, Channel ID, substream ID). A Channel's Main conversation is
substream `"0"`, so one field covers Channels and Breakouts. Migration maps
each existing value to (`workstream`, id, `"0"`).

The field's existing duties move with it:

- Only a Sidekick with a home gets a posting tool
  (`apps/api/src/services/integrations.ts:5367`), so a personal or workspace
  Sidekick still cannot post into a room.
- Archiving the home still tells the Sidekick. Today WorkspaceDO's
  `notifyOwningRoomArchival` joins `automation_directory` to the `channels`
  directory on `owning_workstream_id` and calls `setOwningRoomArchived`
  (`workspace-do.ts:10468`). The projection carries the substream too. The
  `breakouts` directory is in the same database, so a home Breakout's archive
  is the same local join.

The Slack-only `authoringOrigin` type, its prompt section, and its test are
removed. The prompt names the home conversation instead; if that Channel began
in Slack, its origin resource already carries the link.

Conversation attachments are a WorkspaceDO table keyed by Sidekick and
conversation address. The home is always attached. They do not reuse the two
existing Sidekick attachment tables, `sidekick_attachments` in each
SubstreamAgent and `parent_sidekicks` in WorkspaceDO (formerly
`workstream_sidekick_attachments`). Those mean "this conversation may load
this Sidekick as a skill", and loading a skill writes them automatically
(`substream-agent.ts:5018`). Reusing them would give a Sidekick read and post
access to every conversation that ever used it.

WorkspaceDO is the right home for the new table now that it holds the
`channels`, `breakouts`, `channel_viewers` and `breakout_viewers` directories
and each person's relationship (`workspace_member_status`). Listing a
Sidekick's attachments and checking an audience at attach time are local reads,
with no call to a Channel object and no D1 read.

## Conversation tools

The conversation tools are one built-in plugin, not part of the Sidekick
plugin. The plugin takes a **scope**: a function from the loop's input to the
set of Rally addresses it may reach and the tools it offers. Adding a new kind
of agent means adding a scope, not new tools.

| Tool | Behavior |
| --- | --- |
| `list_conversations` | The conversations in scope, with titles and addresses; a Sidekick's home first |
| `read_conversation(address, after?, before?, limit?)` | A page of messages, through `createMessageObjectPort` `messagesAfter`/`messagesBefore` |
| `post_to_conversation(address?, text)` | Post to a conversation in scope, a Sidekick's home by default; idempotent on a caller key, plus the run ID in a run |
| `attach_conversation(address)` | Add a Sidekick attachment; offered only in a Sidekick's config conversation |

| Loop | Scope | Tools | Acts as |
| --- | --- | --- | --- |
| Channel Main or Breakout (`parentKind: workstream`) | Its own conversation and its Channel's Main conversation | list, read | The person it is working for, as today |
| Sidekick config (`parentKind: automation`, substream `"0"`) | The Sidekick's attachments | attach, list, read, post | The person talking to it |
| Sidekick run (`parentKind: automation`, `automationRun` present) | The Sidekick's attachments | list, read, post | The Sidekick's run-as user |

In a Sidekick config conversation the tools load where the drafting plugin
already loads (`integrations.ts:5348`), and a post has no run ID, so its
idempotency key is the caller key alone. In a run they load only when
`automationRun` is present, which run continuation guarantees for every wake
of a run child. A Channel or Breakout loop does not get post, because it posts
to its own conversation by replying.

`sidekick_post_result` is removed, not kept beside the new tool. It is
hard-wired to the owning Channel's Main conversation and deduplicated on run
ID alone (`integrations.ts:6431-6518`), and a model offered both would not know
which to use. A continued run posts more than once, so the replacement's
idempotency key includes a caller key such as the reply's event ID.

A read or post first admits the acting principal to the target conversation.
For a Channel or Breakout that is the conversation-parent contract WorkspaceDO
now serves, one call with no namespace probe. Every read and post also checks
that the address is in scope and that the move does
not widen an audience: reading moves a conversation's content into the
reading loop's conversation, and posting moves content the other way. A
Breakout reading its Channel's Main conversation narrows, since a Breakout's
audience sits inside its Channel's. Connector watches
already apply "content may only move into an audience no broader than the one
it came from" (`docs/connectors.md`); both directions use that rule, at attach
time and on each call.

Several `SubstreamAgent` methods refuse a parent that is not a Channel
(`substream-agent.ts:1374`, `1535`, `2310`, `2430`, `5001` and others). Each that the tools
touch must accept a run child as an ordinary conversation.

## Run continuation

A Sidekick run child is an ordinary `SubstreamAgent` with parent kind
`automation`, parent ID the Sidekick, and substream ID the run ID. Unlike
Channel and Space parents, Sidekick parents still live in `SidekickDO`; moving
them into WorkspaceDO is a named follow-up of the hosted-parent change. The
design below targets `SidekickDO` and keeps the same shape if they move:
`continueRun` becomes a local call instead of an RPC.

### Today

A message admitted to a run child after the run completed:

1. `admitMessage` requests an activation (`substream-agent.ts:6212`).
2. `claimPersistentLoopExecution` builds a loop input from the message's stored
   authorization with a new harness run ID and no `automationRun`
   (`substream-agent.ts:3895`, with the input built at `3970`). Only the SidekickDO alarm sets
   `automationRun` (`sidekick-do.ts:1711-1728`).
3. The loop runs as the message's author, so connectors are chosen for that
   person (`integrations.ts:5415`).
4. The loop has no posting tool, no Sidekick definition or instructions, and
   takes the non-run authority check (`integrations.ts:6346`).
5. The run row stays completed; `onChildCommonAggregate` ignores finished runs
   (`sidekick-do.ts:1435`).

Answering an elicitation resumes through the same path, so a Sidekick run that
asks a question likely loses its run context on resume too. This needs a test.

### Proposed

When `claimPersistentLoopExecution` wakes a child whose parent kind is
`automation` and whose substream is not `"0"`, it calls
`SidekickDO.continueRun(runId)` before building the loop input. That method:

1. Refuses, with a named code, when the Sidekick is paused or deleted, or the
   run does not exist. The input stays in the feed and the sender sees the
   reason.
2. Moves the run row to `running`, including from `completed`.
3. Returns the same `automationRun` block and run-as `executionPrincipal` the
   alarm path builds.

The loop then has the Sidekick's instructions, tools, and authority, and the
run authority check (`integrations.ts:6385`) passes because the run is running.
The sender is only the author of the message. `continueRun` does not check who
sent it: anyone who can reach the run may continue it.

`onChildCommonAggregate` must accept `completed → running`, and the run row
must allow more than one completion. Input that arrives while the run is still
active is queued by the existing loop and needs no change. Elicitation answers
take the same path and are fixed by the same change.

## Mucker weekly call prep

The Sidekick's home is the Breakout in the investors Space where it was set up.

| Step | Mechanism |
| --- | --- |
| 1 PM run DMs Adam, Alex, KB | Existing Slack tools; each successful `send_message` writes a binding from `[D…, ts]` to the 1 PM run child. |
| A founder replies | Resolution finds the exact thread binding and delivers the reply to the 1 PM run child. |
| The run continues and forwards | Run continuation; `post_to_conversation` to the home, keyed on the reply's event ID, naming the founder and linking the thread. |
| 2 PM run reads | `read_conversation` on the home. |
| 2 PM run posts the agenda | `post_to_conversation` to the home. |

No step pairs the two runs. A late reply continues the 1 PM run and lands in
the home without changing a posted agenda. A founder with no answer is absent
from the home. The forward depends on the model following its instructions;
a missing forward shows as an answer in the run feed that is absent from the
Breakout.

## Audience and authorization

The source conversation says who could speak there. Rally decides who may read
persisted Rally work. Public shared rooms can use an Organization-wide Space;
private rooms and MPIMs cannot be widened merely because many people are
present. Creation and placement must use existing Space and Channel access
preflights, including retained-content containment. If they refuse, ingress
reports a routing failure rather than placing the Channel in General or
silently opening the audience.

Provider actors without Rally accounts remain external actors on their own
turns; receiving a Slack event does not create a Rally member or personal tool
grant. A continued Sidekick run acts as its run-as user regardless of who sent
the input. The unresolved policy is whether a person who leaves the provider
room keeps their prior Rally participation. That answer belongs in the product
contract before private-room rollout, because current connector admission
retains membership after departure.

## Slack adapter and lifecycle cases

| Event or condition | Required adapter/host response |
| --- | --- |
| `member_joined_channel` for the bot | Verify `conversations.info` and ensure the room binding when `is_channel`, `is_group`, or `is_mpim`; ignore `is_im` for this policy. |
| Invite and `app_mention` delivered in either order | Both reach the same idempotent ensure operation, then one spawn claim. |
| `message.channels`, `message.groups`, `message.mpim` | Normalize to the same path and message shape; resolve. |
| `message.im` | Resolve exact outbound bindings; otherwise apply the one-to-one DM policy. |
| Channel or group DM rename | Preserve source identity; present a label update only under the decided naming policy. |
| Bot leaves, channel archives, connection disconnects | Suspend the room binding; its threads stop resolving; retain Rally work and binding identity for reactivation. |
| Slack Connect `channel_id_changed` | Atomically move the room path and every path beneath it to the new ID while preserving targets. |
| Slack group DM adds people and Slack creates a new DM | Treat the new provider room ID as a separate source. Never copy or merge Rally history on the strength of a similar member list. |
| `is_non_threadable` group DM | Only an explicit addressed message starts a Channel; no implicit reply routing without a provider thread identity. |
| Provider retry or reordered delivery | Unique path key and event receipt prevent duplicate Space, Channel, message, or run continuation. |

Slack's app manifest (`config/provider-apps/slack.json`) lacks `message.mpim`
despite carrying `mpim:history`, so the group-DM path needs a subscription
change. The public-channel join sweep and the `channel_created` join path
(`apps/api/src/services/slack-agent-service.ts:1451`) must stop. Existing
subscriptions to `member_joined_channel` and `member_left_channel` remain useful
for source membership and lifecycle. Slack's provider semantics are documented
in [message.mpim](https://docs.slack.dev/reference/events/message.mpim/),
[member_joined_channel](https://docs.slack.dev/reference/events/member_joined_channel/),
[conversation object](https://docs.slack.dev/reference/objects/conversation-object/),
and [channel_id_changed](https://docs.slack.dev/reference/events/channel_id_changed/).

## Migration and verification

Existing `slack_agent_sessions` already have exact thread keys and Rally Channel
targets. They migrate into thread bindings; none is rebound by title or Slack
thread text. Already-joined public channels are not evidence of a new
invitation after the proactive join policy stops. A migration must select their
room bindings explicitly, and must not bulk-create Spaces for every historical
bot membership. An old session whose parent Space is not yet selected remains
reachable at its existing Rally URL. Existing Sidekicks map
`owning_workstream_id` to (`workstream`, id, `"0"`).

Acceptance tests should exercise the real ingress and WorkspaceDO, Space,
Channel, SidekickDO, and SubstreamAgent authorities:

- duplicate and out-of-order invite plus mention;
- public, private, and MPIM classification;
- two threads in one room; a bound reply versus an unrelated message;
- a suspended room stopping its threads;
- the one-to-one DM exception;
- an outbound send writing a binding, and a lost receipt writing none;
- input to a completed run child continuing it with `automationRun` and the
  run-as principal, from a Rally user and from a bound thread;
- input to a paused Sidekick's run refused with its code;
- an elicitation answer keeping run context;
- read and post refused for an unattached conversation or a widening audience;
- the Mucker flow end to end: three replies forwarded once each, 2 PM read and
  post;
- bot removal and re-invitation; Slack Connect ID change; blocked private
  placement.

Provider event parsing alone does not prove the persisted destination or
audience. Slack app changes also need a live invitation and MPIM message smoke
check before rollout.
