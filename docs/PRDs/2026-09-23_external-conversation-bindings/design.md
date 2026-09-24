# Design: external conversation bindings

> Companion architecture for [`prd.md`](prd.md). This is a proposal, not a
> description of shipped behavior. Current behavior is documented in
> [Slack integration](../../slack-integration.md), [Spaces](../../spaces.md),
> and [connectors](../../connectors.md).

## Current seams

| Existing mechanism | Current role | Proposed treatment |
| --- | --- | --- |
| `slack_agent_sessions` in WorkspaceDO | Slack installation + channel ID + root timestamp to one Rally `workstream_id` | Preserve existing rows; move future lookup through a connector-neutral thread binding contract. Do not mistake the workstream ID for a Breakout address. |
| Slack `slack_thread` origin resource | Link from a Rally Channel to the source thread, with watching off | Keep as provenance. It is not the routing authority. |
| Space membership in WorkspaceDO | Many-to-many placement and its audience effects | Place a newly bound Channel in the bound Space through canonical Space creation/access ordering, before publishing it. |
| Slack Agent ingress | Verifies event, resolves installation, creates or resumes Channel, writes human message | Normalize room/thread identity and resolve an explicit binding before creating a Channel. |
| Connector activity/watch registrations | Notify Sidekicks or post resource updates to a Channel's Main conversation | Do not use a broad channel watch as a per-thread routing substitute. |

## Connector-neutral contract

The adapter reports an **external room** and, where the provider supports it,
an **external thread** within that room. Slack public/private channels and
MPIMs are shared rooms; a Slack one-to-one IM is a direct conversation. A
provider without native threads may identify an addressed root message as a
single-request conversation but cannot infer an unaddressed follow-up.

The host receives typed facts, not Slack field names:

```text
ExternalRoom {
  connectionId, providerRoomId, kind: shared | direct,
  visibility: public | private | unknown,
  displayName?, membershipState: joined | left | unknown,
  threadSupport: supported | unsupported | unknown
}
ExternalMessage {
  roomId, messageId, rootThreadId?, actor, text,
  addressedToRally, providerEventId, occurredAt
}
```

The adapter alone derives these facts from Slack's `channel`, `thread_ts`,
`channel_type`, and `conversations.info`. In particular, it checks `is_mpim`
rather than assuming a `G` prefix means a private channel. The host must not
assume all connectors have invitation events, stable names, native thread
replies, or the same message edit/delete semantics. A connector declares which
facts it can produce; a shared-room binding is available only when the needed
facts are verified. This is one host mechanism with provider-specific adapters,
not a mandate that every connector manufacture Slack-shaped events.

## Binding authority and identity

WorkspaceDO is the regional authority for bindings because it already owns
connector connection identity, the Space directory, Channel placement, and
Slack Agent sessions. The sketch below is a logical contract, not a migration:

| Binding | Unique source key | Rally target | State |
| --- | --- | --- | --- |
| Shared room | Organization + connection + provider room ID | Space ID | initializing, active, suspended |
| Thread | Organization + connection + provider room ID + provider root thread ID | Channel Main conversation, or an explicit Rally conversation address for outbound delivery, including a Sidekick run child | initializing, active, suspended |

Every active source key has one target. Display name and participant list are
attributes, never keys. A provider ID change requires an explicit alias/move
operation that preserves the Rally target; it does not create a second binding.
The target address contains the parent kind and ID plus child substream ID.
For an ordinary Channel Breakout the parent is the Channel; for Mucker weekly
call prep the parent is the Sidekick and the child ID is its 1 PM run ID. No
client-supplied URL, Slack message text, or model-proposed target can override
the recorded binding. An origin resource remains an independent backlink.

There is no general parent-child container table to add in Rally: the room
binding selects a Space, while ordinary Space membership places a Channel in
it. A Rally Channel can remain in several Spaces. The provider binding is one
source of placement, not the definition of Channel identity.

## Activation and routing

1. A verified installation event says the bot joined a shared provider room.
   The host resolves the connector connection and fetches the room's current
   kind, membership, visibility, and display label. It claims the room source
   key and creates or reuses its Space. A first mention can run the same ensure
   path before its thread event if the invitation event arrives later.
2. A verified human message addressed to Rally resolves the room binding. If
   the thread key has no binding, one claim creates a Rally Channel with the
   provider conversation's authorized audience, places it in that Space, and
   records its thread binding. The existing creation/outbox ordering must
   publish the Channel only after placement settles.
3. A later human reply resolves the exact thread binding and enters its stored
   Rally conversation. An ordinary Channel target uses ordinary message
   admission and its agent loop. A Sidekick run child uses a typed external
   append that records the attributed turn without activating a new inference
   loop. Unrelated provider messages have no binding and create no Rally work.
4. A Rally-originated provider message with a deliberate reply destination
   records a pending outbound binding before the send and completes it with the
   provider's returned room/root IDs. An uncertain send remains unresolved and
   is not retried blindly or guessed from message text. When the provider root
   ID is unknown, an incoming reply cannot be matched safely to that intent.
   The one-to-one DM policy must report collection as unconfirmed and decide
   separately whether that reply starts ordinary Agent work. It must not claim
   delivery to the intended run child without an exact binding.

### Mucker weekly call prep

The 1 PM schedule creates a child SubstreamAgent DO with `substreamId = runId`
under the Sidekick parent. The child sends the founder requests. Each provider
send returns a DM room ID and root message ID; the host settles a binding from
that exact external thread to the same child, alongside an outbound receipt.
The binding also records the intended founder so another participant or an
unthreaded DM cannot be counted as that founder's answer. The initiating Rally
Breakout is where the Sidekick was authored, not automatically the destination
for these replies.

The 1 PM run can reach `completed` before founders reply. Its child transcript
still exists, but existing provider-write authority ends with run completion
and ordinary `createMessage` may activate a new loop. External reply ingress
therefore needs a narrow, parent-authorized, non-activating append operation
on that child. It deduplicates by connector message identity and records the
founder, source thread, arrival time, and answer as an external turn. It does
not seat founders as Rally participants or permit the completed 1 PM model run
to call tools again. This is a new ingress path over existing Sidekick and
Breakout primitives, not a new collection object.

At 2 PM another scheduled run creates another child. The Sidekick parent uses
the schedule occurrence to locate the corresponding 1 PM run and gives the
2 PM execution its address. `createMessageObjectPort` can already target a
named child substream, and its `messagesAfter`/`messagesBefore` operations can
page that child's messages. The model does not have a tool to discover or read
prior Sidekick run transcripts today. For this fixed collection workflow, the
host should resolve the matching 1 PM run, take a cutoff-fenced snapshot of
its external answer turns, and append one idempotent opening message to the
2 PM child with the attributed answers, source references, missing founders,
and an explicit instruction to draft the agenda from them. The existing
mail-started run already uses a system opening message before activation.
The 2 PM model then needs no run ID or new transcript tool. The new work is the
parent-authorized run correlation, snapshot handoff, and retry-stable cutoff;
sibling history does not appear automatically. Multiple founder DMs converge
on the 1 PM child; the 2 PM child synthesizes Updates and Asks from that
attributed snapshot.
Late replies remain visible in the 1 PM child and do not silently edit an
already-posted agenda. The current `sidekick_post_result` destination remains
the owning Channel's Main conversation; posting to the original authoring
Breakout requires an explicit output destination.

Claim/settlement and provider-event deduplication reuse the existing ingress
and WorkspaceDO authority patterns. The design requires a single durable
creation result under concurrent invite/mention or duplicated events; it does
not require a cache, separate routing service, or copied provider history.

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
grant. The unresolved policy is whether a person who leaves the provider room
keeps their prior Rally participation. That answer belongs in the product
contract before private-room rollout, because current connector admission
retains membership after departure.

## Slack adapter and lifecycle cases

| Event or condition | Required adapter/host response |
| --- | --- |
| `member_joined_channel` for the bot | Verify `conversations.info` and ensure the shared-room binding when `is_channel`, `is_group`, or `is_mpim`; ignore `is_im` for this policy. |
| Invite and `app_mention` delivered in either order | Both reach the same idempotent ensure operation, then one thread claim. |
| `message.channels`, `message.groups`, `message.mpim` | Normalize the same shared-room/message shape; accept a tagged new thread or an exact bound-thread reply. |
| `message.im` | Use the separate one-to-one DM policy and any explicit outbound reply binding. |
| Channel or group DM rename | Preserve source identity; present a label update only under the decided naming policy. |
| Bot leaves, channel archives, connection disconnects | Suspend inbound routing; retain Rally work and binding identity for reactivation. |
| Slack Connect `channel_id_changed` | Atomically move the room key and child thread keys to the new ID while preserving Space and Channel targets. |
| Slack group DM adds people and Slack creates a new DM | Treat the new provider room ID as a separate source. Never copy or merge Rally history on the strength of a similar member list. |
| `is_non_threadable` group DM | Only an explicit addressed message starts a Channel; no implicit reply routing without a provider thread identity. |
| Provider retry or reordered delivery | Unique source key and event receipt prevent duplicate Space, Channel, message, or run. |

Slack's app manifest currently lacks `message.mpim` despite carrying the
`mpim:history` scope, so the group-DM path needs a subscription change. The
public-channel join sweep and `channel_created` join path must stop. Existing
subscriptions to `member_joined_channel` and `member_left_channel` remain useful
for source membership/lifecycle observation. Slack's provider semantics are
documented in [message.mpim](https://docs.slack.dev/reference/events/message.mpim/),
[member_joined_channel](https://docs.slack.dev/reference/events/member_joined_channel/),
[conversation object](https://docs.slack.dev/reference/objects/conversation-object/),
and [channel_id_changed](https://docs.slack.dev/reference/events/channel_id_changed/).

## Migration and verification

Existing `slack_agent_sessions` already have exact thread keys and Rally Channel
targets. They are compatible inputs to an explicit migration; none should be
rebound by title or Slack thread text. Already-joined public channels are not
evidence of a new invitation after the proactive join policy stops. A migration
must select their room bindings explicitly, and must not bulk-create Spaces for
every historical bot membership. An old session whose parent Space is not yet
selected remains reachable at its existing Rally URL.

The implementation's acceptance tests should exercise the actual ingress and
WorkspaceDO/Space/Channel authorities: duplicate and out-of-order invite plus
mention; public/private/MPIM classification; two threads in one room; bound
reply versus unrelated message; one-to-one DM exception; Sidekick run child
reply before and after run completion, multi-founder convergence and 2 PM
sibling read; uncertain outbound receipt; bot removal and re-invitation;
Slack Connect ID change; and blocked private placement. Provider event parsing
alone does not prove the persisted destination or audience. Slack app changes
also need a live invitation and MPIM message smoke check before rollout.
