# External conversation bindings

> Created 2026-09-23.
>
> A shared connector conversation can become a Rally Space, a thread in it can
> become a Rally Channel, and a reply to a message Rally sent can return to the
> Sidekick run that sent it, without making Rally a copy of the provider.
> Companion architecture: [`design.md`](design.md). Discussion record:
> [`discussion-brief.md`](discussion-brief.md). State: [`state.md`](state.md).
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

A message a Sidekick run sends through a connector binds its reply thread to
that run. A reply continues the run with the Sidekick's own instructions,
tools, and authority, rather than opening an unrelated Agent Channel. A
Sidekick has a home conversation, the Channel or Breakout it belongs to, and
can list, read, and post to the conversations it is attached to. A
multi-step Sidekick, such as one that collects answers at 1 PM and writes an
agenda at 2 PM, uses its home conversation as the shared record between runs.

All of this uses one connector-neutral binding record. A provider adapter
describes its conversation hierarchy, identity, membership, and message
events; Rally owns the Space and Channel identity, access, binding lifecycle,
and routing. Slack is the first adapter, not a special case in Rally's Space
model.

## Motivation

Today a Slack thread begun with Rally maps to a Rally Channel, but Slack-born
Channels are placed in General and Rally joins public Slack channels without
an invitation. A Sidekick's outbound DM for Mucker weekly call prep exposed a
second gap: when Adam replied "Nothing from me" in the DM thread, Rally started
a separate Agent Channel. The Sidekick that asked never saw the answer, so it
could not combine it with the other founders' answers into the agenda.

Three things are missing. No record says where a reply to Rally's message
should go; an origin attachment links back to a Slack thread but does not
route future messages. A message written into a finished Sidekick run starts a
generic chat loop that runs as the sender, without the Sidekick's instructions
or tools, and the Sidekick never learns of it. And a Sidekick run has no tool to
read or post to the Breakout it was created from, so one run cannot leave work
for the next.

## Goals

1. An invited shared provider conversation has one stable linked Rally Space,
   even when its display name changes or provider events are retried.
2. A thread addressed to Rally has one Rally Channel in its linked Space;
   ordinary replies in that thread continue the same Channel.
3. Public Slack channels, private Slack channels, and group DMs containing Rally
   follow the same routing contract while retaining the correct audience.
4. Rally does not proactively join Slack channels. A Slack membership event or
   an invitation carried by a mention activates the Space binding.
5. A message a Sidekick run sends through a connector binds its exact reply
   thread to that run. A reply reaches the run, not a new Agent Channel.
6. Input to a Sidekick run, from a Rally user or a bound external thread,
   continues that run with the Sidekick's instructions, tools, and run-as
   authority, even after the run has completed.
7. A Sidekick has one home conversation (a Channel or a Breakout) and can list,
   read, and post to the conversations it is attached to.
8. The binding mechanism is usable by another connector with any depth of
   rooms and threads without copying Slack-specific routing code.

## Non-goals

1. **A Slack replica: rejected.** Linking does not import all messages,
   mirror edits or deletions, or make Rally a general Slack channel browser.
2. **Joining or creating provider conversations: rejected for this flow.** The
   workspace bot responds where invited; existing explicit connector tools for
   provider writes retain their own contracts.
3. **Automatically merging Rally conversations: rejected.** A Slack group DM
   whose participant change produces a new conversation ID does not silently
   merge old Rally content into a new Space.
4. **A one-to-one DM Space: deferred.** Rally/user DMs need their own rule.
   The shared-room hierarchy does not create a Space merely because a personal
   DM is opened. Outbound Sidekick DMs still bind their reply threads.
5. **Provider-wide access mirroring: deferred.** A binding does not claim that
   a Slack membership change immediately grants or revokes Rally access. The
   specific access contract must be settled before private shared rooms ship.
6. **A Sidekick "collection" object: rejected.** The run that sent a request
   receives its replies, and the home conversation holds what later runs need.
   Both already exist.
7. **Routing replies somewhere other than the sending run: rejected for now.**
   A tool that sends from one place and routes replies to another is possible
   with the binding record, but no workflow needs it, and it makes the reply
   path harder to follow.
8. **Attaching conversations from inside a scheduled run: rejected.** Only
   authoring (a person, or the Sidekick's authoring conversation) attaches a
   conversation, so a run cannot widen its own reach.

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

### A Sidekick's home and attached conversations

Every Sidekick that belongs to a room has one **home conversation**: the
Channel Main conversation or the Breakout where it was set up. The home is
always attached. People, or the Sidekick's authoring conversation, can attach
further Channels or Breakouts.

A Sidekick run has four conversation tools:

- **List** the conversations it is attached to, home first.
- **Read** messages from an attached conversation, a page at a time.
- **Post** to an attached conversation, defaulting to the home. This replaces
  today's `sidekick_post_result`, which could post only to the owning Channel's
  Main conversation.
- **Attach** a conversation, offered only to authoring, never to a scheduled
  run.

Reading and posting move content between audiences. A Sidekick may attach
only to a conversation where that move cannot widen who sees the content, and
each read or post rechecks it. A conversation archived or made unreachable
refuses reads and posts with a reason the run can report.

### Continuing a run

**Input to a Sidekick run continues that run.** A person typing in a run's
feed, a reply that arrives through a bound thread, and an answer to a question
the run asked all behave the same way. The run reopens if it had completed,
wakes with the Sidekick's instructions and tools, acts with the Sidekick's
run-as authority, and completes again when it has nothing left to do. The run
keeps one identity and one history, so a run can complete more than once.

**Anyone who can reach a run may continue it.** That is any Rally user who can
post in the run's feed and any sender in a thread bound to the run. Each
message keeps its sender, so the run knows who said what. A person with only
view-and-post access to a run can therefore make it act through the run-as
user's connectors; that is the intended consequence of this rule, not a gap.

A paused or deleted Sidekick does not continue. The input stays in the feed,
and the sender sees why the run did not respond.

### Outbound reply threads: Mucker weekly call prep

The Mucker Sidekick has two schedule triggers and a home Breakout in the
investors Space.

1. **1 PM: send.** The Sidekick starts a run. The run DMs Adam, Alex, and KB
   for their Updates and Asks. It may also tag them in the home Breakout; the
   DM is a proxy for that request. Each successful send binds its exact Slack
   reply thread to this run.
2. **Reply.** A founder replies in their DM thread. The reply enters the 1 PM
   run as that founder's message, and the run continues.
3. **Forward.** Following its instructions, the continued run posts the
   founder's answer, with the founder's name and a link to the Slack thread, to
   the home Breakout. Each reply is forwarded once, even if delivery retries.
4. **2 PM: read.** The Sidekick starts a second run. It reads the home
   Breakout, which now holds each founder's answers alongside anything posted
   there directly.
5. **2 PM: post.** The run writes the agenda and posts it to the home Breakout,
   tagging people as its instructions say.

The two runs never need to find each other; both work through the home
Breakout. A founder who never answers is simply absent from the Breakout when
the 2 PM run reads it. A reply that arrives after 2 PM still continues the 1 PM
run and appears in the Breakout, but does not change an agenda already posted.
A reply outside the bound thread, or to a send whose provider receipt was
lost, does not reach the run.

The forward in step 3 depends on the model following its instructions. That
failure is visible: the founder's answer is missing from the Breakout while
present in the run's feed.

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

One behavior moves: a Sidekick run is no longer finished for good when it
completes. Input reopens it, and anyone who can reach it may do so.

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
5. **One binding record for rooms and threads.** A room binding and a thread
   binding differ only in policy: whether a match delivers a message, and
   whether an unbound child creates a Rally conversation. Separate types, or
   subclasses, would fix Slack's two levels into the schema; Discord, Teams,
   GitHub, and email nest to other depths.
6. **The home Breakout, not a run-to-run handoff, joins the two Mucker runs.**
   An earlier draft had Rally find the matching 1 PM run and hand a snapshot of
   its answers to the 2 PM run. That needed a key pairing the two runs, which
   nothing provides. The home Breakout needs no pairing, keeps the answers
   visible to people, and works for any multi-step Sidekick. Routing DM replies
   straight to the Breakout was also rejected: the run that sent a message
   should receive its replies.
7. **A reply wakes the run instead of being recorded silently.** An earlier
   draft appended replies to a finished run without waking its model. The
   forward in step 3 needs the model, so input continues the run.
8. **Replace `owning_workstream_id` with an owning substream, and remove
   `authoringOrigin`.** A full conversation address covers Channels and
   Breakouts with one field. The Slack-only `authoringOrigin` prompt field was
   never populated; a home Channel that began in Slack already carries that
   link as an origin resource.

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

A continued run acts with its run-as user's connectors whoever sent the input,
including an external sender in a bound thread. A bound thread's reply text is
untrusted input to that run in the same way an inbound email is. Attached
conversations are fixed at authoring, so a run cannot widen what it can read
or post to.

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

Existing Sidekicks move from `owning_workstream_id` to an owning substream of
(Channel, `"0"`), which keeps today's posting behavior. A Sidekick whose home
should be a Breakout is changed explicitly.

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
- Each DM the 1 PM Mucker run sends binds its exact reply thread to that run. A
  founder's reply continues that run, even after it completed, with the
  Sidekick's instructions, tools, and run-as authority; it does not create a
  new Agent Channel or a new run. The continued run posts the attributed answer
  to the home Breakout once.
- The 2 PM run reads the home Breakout and posts the agenda there.
- A message typed into a completed run's feed by any user who can post there
  continues the run the same way. Input to a paused or deleted Sidekick's run
  does not start a loop and tells the sender why.
- A scheduled run cannot attach a conversation, and cannot read or post to a
  conversation it is not attached to.
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
4. **Provider naming:** Should later provider renames update an untouched Rally
   Space title, or should the initial name always remain independent?
5. **Unconfirmed outbound delivery:** If the provider accepts an outbound root
   message but its response is lost, how can Rally recover that exact root ID
   before routing a reply? Without a provider receipt or a reliable correlation
   event, this is an uncollected state, not a reason to guess.
6. **When a bound thread stops routing:** A run's state no longer decides this,
   since input reopens a finished run. What closes an outbound binding, and what
   does a sender see afterward?
7. **Audience rule for attaching:** Reading and posting both move content, so
   the rule may amount to "same audience or narrower in both directions". Is
   that too strict for a Sidekick whose home is a Breakout inside a wider
   Channel?
8. **One-to-one DM fallback:** For a reply outside a bound thread, should Rally
   start ordinary Agent work, decline it, or ask the person to reply in the
   original thread?
9. **Showing a reopened run:** How does the Sidekick's run history show a run
   that completed, reopened, and completed again?

## Decision log

None yet.
