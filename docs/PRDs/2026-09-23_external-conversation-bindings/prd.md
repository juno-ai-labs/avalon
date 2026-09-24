# External conversation bindings

> Created 2026-09-23.
>
> A shared connector conversation can become a Rally Space, and a thread in it
> can become a Rally Channel, without making Rally a copy of the provider.
> Companion architecture: [`design.md`](design.md). State: [`state.md`](state.md).
> Standing contract: [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [connectors](../../connectors.md), [Spaces](../../spaces.md),
> [Slack integration](../../slack-integration.md), and
> [work-stream origin attachments](../../workstream-origin-attachments.md).

## Summary

When Rally joins a shared Slack conversation by invitation, that conversation
gets one linked Rally Space. The first request addressed to Rally in a Slack
thread creates one Rally Channel in that Space. Later human replies in the
bound thread continue that Channel. Public channels, private channels, and
group DMs with Rally use this same product model. A one-to-one Rally/user DM
has a separate routing policy.

The implementation uses connector-neutral conversation bindings. A provider
adapter describes its conversation hierarchy, identity, membership, and message
events; Rally owns the Space and Channel identity, access, binding lifecycle,
and routing. Slack is the first adapter, not a special case in Rally's Space
model.

## Motivation

Today a Slack thread begun with Rally maps to a Rally Channel, but Slack-born
Channels are placed in General and Rally joins public Slack channels without
an invitation. A Sidekick's outbound DM for Northstar weekly call prep exposed a
second ambiguity: a human reply to that message started a separate Rally Agent
Channel rather than returning to the Sidekick's intended collection context.
An origin attachment links back to the Slack thread, but it does not route
future messages. The binding and its destination need to be explicit and
visible to the ingress before a reply arrives.

## Goals

1. An invited shared provider conversation has one stable linked Rally Space,
   even when its display name changes or provider events are retried.
2. A thread addressed to Rally has one Rally Channel in its linked Space;
   ordinary replies in that thread continue the same Channel.
3. Public Slack channels, private Slack channels, and group DMs containing Rally
   follow the same routing contract while retaining the correct audience.
4. Rally does not proactively join Slack channels. A Slack membership event or
   an invitation carried by a mention activates the Space binding.
5. Outbound Rally messages may bind their provider reply thread to a deliberate
   Rally conversation destination, including the Sidekick-owned run child
   that sent a request, without posing as an ordinary newly created Slack Agent
   Channel.
6. The binding mechanism is usable by another connector with shared rooms and
   threads without copying Slack-specific routing code.

## Non-goals

1. **A Slack replica — rejected.** Linking does not import all messages,
   mirror edits or deletions, or make Rally a general Slack channel browser.
2. **Joining or creating provider conversations — rejected for this flow.** The
   workspace bot responds where invited; existing explicit connector tools for
   provider writes retain their own contracts.
3. **Automatically merging Rally conversations — rejected.** A Slack group DM
   whose participant change produces a new conversation ID does not silently
   merge old Rally content into a new Space.
4. **A one-to-one DM Space — deferred.** Rally/user DMs need their own rule,
   particularly for Sidekick outreach. The shared-room hierarchy does not
   create a Space merely because a personal DM is opened.
5. **Provider-wide access mirroring — deferred.** A binding does not claim that
   a Slack membership change immediately grants or revokes Rally access. The
   specific access contract must be settled before private shared rooms ship.

## Product behavior

### Invitation and Space

Rally appears only in shared Slack conversations to which people have added it.
When it is added to a public channel, private channel, or group DM, Rally
creates or reuses one linked Space in the connected Organization. A named Slack
channel initially gives the Space that name. A named group DM uses its name;
an unnamed group DM uses a human-readable participant label, never Slack's
synthetic provider name as the product title. The Space remains a Rally object,
so subsequent provider renames do not silently overwrite a title someone has
chosen in Rally.

A pending creation can show as loading in Rally. If Slack membership or the
Space authority cannot be verified, Rally does not claim the link succeeded;
the invitation can be retried. A disconnected installation leaves existing
Rally work readable under Rally's access rules but stops provider routing.

### Request and Channel

The first human message addressing Rally in a thread creates a Channel in the
linked Space. A second tag in the same thread continues that Channel. Later
human replies in the bound thread enter it without another tag, as they do in
current Slack Agent sessions. An older thread can be activated by a later tag;
Rally may read bounded earlier context but does not import its history. A
provider conversation that disallows threads treats each explicitly addressed
message as an independent request; it does not guess which prior Channel should
receive an unthreaded follow-up.

The Channel opens at its ordinary Rally URL, shows the Slack thread as an origin
resource, and obeys ordinary Rally conversation and agent rules. A failure to
create or place the Channel is visible in Slack and does not leave a live
binding to an absent destination. Offline Rally clients can still open the
Channel after ingress completes; the provider event is not dependent on a
desktop session.

### Outbound reply threads

At 1 PM, the Northstar Sidekick already creates a child SubstreamAgent Durable
Object under its Sidekick parent. That run child is the collection
destination. The request sent to each founder establishes an exact provider
reply-thread binding to the same 1 PM child when delivery returns the DM room
and root message identities. A founder's thread reply is recorded there as an
externally attributed turn, without starting another Agent Channel or
reactivating the completed 1 PM inference. The child remains durable after the
run ends; this requires a typed, non-activating external append path rather
than ordinary human-message admission.

At 2 PM, the scheduler creates a different child under the same Sidekick. Its
parent supplies the matching 1 PM run address for that weekly occurrence; the
2 PM execution reads the earlier child's messages through Rally's existing
child-addressed message port and places the attributed answers in its new
child's opening context before drafting the agenda. The Sidekick parent must
identify the matching run; sibling history is not automatically in the 2 PM
child's context. No additional "Sidekick collection"
object is proposed. If the provider send has no confirmed root identity, Rally
cannot safely assert that replies were collected; the one-to-one DM policy
must handle that unconfirmed state explicitly.

### Access and lifecycle

Public shared rooms may use an Organization-wide audience. Private Slack
channels and group DMs require a private Rally audience; the current
member-count rule that promotes a large private conversation to
Organization-wide cannot be used for linked private rooms. Provider membership
is evidence about the source conversation, while Rally's canonical Space and
Channel access checks remain the authority for persisted content.

Removing Rally from the provider conversation, archiving it, or disconnecting
the installation stops new ingress and leaves the Rally Space and Channels
intact. A later re-invitation reactivates the existing binding rather than
creating a second Space. Archiving the Rally Space while the provider remains
active requires an explicit recovery decision; a provider message must not
silently restore it.

## Impact on the product contract

None to the hierarchy: Spaces still group Channels and Breakouts still belong
to Channels. The proposed binding chooses a destination in that hierarchy; it
does not turn a Space into a message transcript or import a provider room as
Rally content. The implementation brief's zero-copy connector boundary remains
in force.

## Key design decisions

1. **Bind by provider identity, not display name.** Duplicate or changed names
   cannot create duplicate Spaces or misroute a message.
2. **Keep origin attachments separate from routing bindings.** An attachment is
   provenance and can be read without subscribing to future messages; a
   binding has a destination and lifecycle that ingress must consult.
3. **Use the same shared-room model for group DMs.** Slack's MPIM is private but
   has multiple human participants and is not a one-to-one Agent DM.
4. **Retain Rally history when provider access ends.** Deleting or reassigning
   persisted work because the bot left Slack would make provider state an
   unreviewed authority over Rally content.

## Regional impact

The existing Slack team route selects the owning Rally Organization and region.
Conversation bindings and their destinations live with that Organization's
regional authority. Global routing stores no provider message body or binding
target. Another provider uses its existing regional ingress route and the same
regional binding contract.

## Security and trust model

Signed provider ingress and the connector installation identify the source.
Names, message bodies, URLs, actor profiles, and earlier thread context remain
untrusted data. A provider member is not automatically a Rally member. Binding
creation and message delivery still pass Rally's canonical audience and actor
admission checks. Private-room policy is an unresolved build gate, not a reason
to bypass content containment or widen a Space to make placement succeed.

## Provider configuration

Slack's current app subscribes to `member_joined_channel` and has `mpim:read`
and `mpim:history`, but it does not subscribe to `message.mpim`. The latter is
needed to receive group DM replies. The public-channel join sweep and
`channel_created` join path must be removed from the active behavior. Scope and
subscription changes must be checked against the installed app manifest and
existing installations before rollout.

## Rollout

Do not backfill a Space for every Slack channel the bot already joined under
the old policy. Existing thread sessions keep their Rally Channel destinations;
their exact binding and placement are migrated or retained explicitly, never
inferred from a Slack channel name. An existing installation needs an explicit
way to select which already-joined shared conversations become linked Spaces.
New invitations use the new path. A failed migration leaves the old Channel
reachable and does not create a duplicate session or widen its audience.

## Acceptance

- Inviting Rally to a public channel, private channel, or group DM creates
  exactly one linked Space; event replay and a simultaneous first mention do
  not create duplicates.
- Two tagged threads in one shared room create two Rally Channels in the same
  Space. Replies to each stay in its Channel; an untagged unrelated thread
  creates nothing.
- A group DM message reaches ingress through `message.mpim` and uses the same
  binding path as channel messages. A one-to-one Rally/user DM does not create
  a Space.
- A private source never becomes Organization-readable solely because its
  member count exceeds the current Slack threshold.
- The 1 PM Sidekick run's outbound DMs bind their exact reply threads to its
  child substream. Each founder's reply is appended there once with source and
  author identity, even after 1 PM inference completes; it does not create a
  new Agent Channel or run. The 2 PM child reads the matching earlier child.
  A Sidekick DM without an active binding does not claim to have collected it.
- Removal, archive, disconnect, provider ID change, and retry preserve the
  binding's identity or suspend it without moving messages to another target.

## Open questions

1. **Private-room access:** Should leaving a private Slack channel or group DM
   revoke future Rally access, or does Rally membership persist until changed
   in Rally? The answer changes the Space audience contract and the treatment
   of retained content. Private shared rooms must not ship without it.
2. **Existing bot memberships:** What explicit action selects already-joined
   channels and group DMs for linking after proactive joining stops?
3. **Rally-side placement:** Is the linked Space a required placement until
   unlinking, or may a user move its Channel away while the thread still routes
   there?
4. **Late replies and run history:** Should an answer arriving after the 2 PM
   snapshot remain in the 1 PM run history only, or prompt a revised agenda?
   The initial behavior records it as late and does not silently revise a
   posted agenda.
5. **Provider naming:** Should later provider renames update an untouched Rally
   Space title, or should the initial name always remain independent?
6. **Unconfirmed outbound delivery:** If the provider accepts an outbound root
   message but its response is lost, how can Rally recover that exact root ID
   before routing a reply? Without a provider receipt or a reliable correlation
   event, this is an uncollected state, not a reason to guess.

## Decision log

None yet.
