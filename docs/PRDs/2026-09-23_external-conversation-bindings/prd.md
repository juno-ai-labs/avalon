# External conversation bindings

> Created 2026-09-23.
>
> A shared connector conversation can become a Rally Space, a thread in it can
> become a Rally Channel, and a reply to a message Rally sent can return to the
> Sidekick run that sent it, without making Rally a copy of the provider.
> Companion architecture: [`design.md`](design.md). State: [`state.md`](state.md).
> Standing contract: [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [connectors](../../connectors.md), [Spaces](../../spaces.md),
> [Slack integration](../../slack-integration.md),
> [work-stream origin attachments](../../workstream-origin-attachments.md), and
> [hosted conversation parents](../../hosted-conversation-parents.md).

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
can list, read, and post to the conversations it is attached to. The same
conversation tools are a general Rally capability: an ordinary Channel or
Breakout agent can use them to read its own Channel and Breakout. A
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
an invitation. A Sidekick's outbound DM for Northstar weekly call prep exposed a
second gap: when Morgan replied "I have an update on the launch checklist." in the DM thread, Rally started
a separate Agent Channel (the ordinary Channel Rally opens for a new Slack
request). The Sidekick that asked never saw the answer, so it could not
combine it with the other founders' answers into the agenda.

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
8. The conversation tools are one general Rally capability, not Sidekick
   code. Any agent loop can be given them, with a scope that says which
   conversations it may reach.
9. The binding mechanism is usable by another connector with any depth of
   rooms and threads without copying Slack-specific routing code.

## Non-goals

1. **A Slack replica: rejected.** Linking does not import all messages,
   mirror edits or deletions, or make Rally a general Slack channel browser.
   The connector boundary in the implementation brief is zero-copy, and a
   mirror would make Rally a second, stale home for Slack's content.
2. **Joining or creating provider conversations: rejected for this flow.** The
   workspace bot responds where invited; existing explicit connector tools for
   provider writes retain their own contracts. Joining uninvited is the
   behavior this change removes, and creating rooms is a different feature.
3. **Automatically merging Rally conversations: rejected.** A Slack group DM
   whose participant change produces a new conversation ID does not silently
   merge old Rally content into a new Space. A similar member list is not
   evidence that the same people agreed to share the old history.
4. **A one-to-one DM Space: deferred.** Rally/user DMs need their own rule.
   The shared-room hierarchy does not create a Space merely because a personal
   DM is opened. Outbound Sidekick DMs still bind their reply threads.
5. **Provider-wide access mirroring: deferred.** A binding does not claim that
   a Slack membership change immediately grants or revokes Rally access. The
   specific access contract must be settled before private shared rooms ship.
6. **A Sidekick "collection" object: rejected.** The run that sent a request
   receives its replies, and the home conversation holds what later runs need.
   Both already exist.
7. **Routing replies somewhere other than the sending run: deferred.**
   A tool that sends from one place and routes replies to another is possible
   with the binding record, but no workflow needs it, and it makes the reply
   path harder to follow.
8. **Attaching conversations from inside a run: rejected.** Only the
   Sidekick's config conversation, where it is set up and edited, attaches a
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

Linking is one WorkspaceDO transaction: either the Space exists and is linked,
or nothing was written. If Slack membership or the Space authority cannot be
verified, Rally does not claim the link succeeded; the invitation can be
retried. A disconnected installation leaves existing
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

### Conversation tools

Rally agents get a general set of conversation tools: **list** the
conversations the agent may reach, **read** messages from one a page at a
time, and **post** to one. What an agent may reach is its **scope**, which
depends on where the agent runs:

| Agent | Scope | Tools |
| --- | --- | --- |
| Channel or Breakout agent | Its own conversation and its Channel's Main conversation | List, read |
| Sidekick config conversation (`"0"`) | The Sidekick's attached conversations | Attach, list, read, post |
| Sidekick run | The Sidekick's attached conversations | List, read, post |

A Channel or Breakout agent can therefore read its own conversation beyond
what fits in its context, and a Breakout agent can read the Channel it sits
in. It posts to its own conversation by replying, as today. Attach exists
only for Sidekicks.

Every read or post checks that the target is in scope and that the agent's
account can open it. A conversation archived or made unreachable refuses reads
and posts with a reason the agent can report.

### A Sidekick's home and attached conversations

Every Sidekick that belongs to a room has one **home conversation**: the
Channel Main conversation or the Breakout where it was set up. The home is
always attached. The Sidekick's config conversation, where it is set up and
edited, can attach further Channels or Breakouts.

A Sidekick's attached conversations are its scope for the conversation
tools, with the home listed first and used as the default post target. Only
the config conversation can attach. **Attaching is the consent to publish
there:** anything a run posts, a forwarded answer included, is seen by that
conversation's audience, the way a Sidekick's result is posted to its Channel
today. So the person attaching must be able to post in that conversation.

**`post_result` is removed.** The `rally:sidekick-result` plugin offers it
to the model as `post_result` (its error codes and activity keep the older
`sidekick_post_result` name). It could post only to the owning Channel's Main
conversation, and beside a general post tool a model would not know which to
use. `conversation_post` covers everything it did.

### Continuing a run

**Input to a Sidekick run continues that run.** A reply that arrives through a
bound thread and an answer to a question the run asked behave the same way. So
would a person typing into the run itself, but no screen shows a run today:
only the run-as user is seated in it, and the desktop client shows only a
Sidekick's config conversation. Whether to build that view is an open
question. The run reopens if it had completed,
wakes with the Sidekick's instructions and tools, acts with the Sidekick's
run-as authority, and completes again when it has nothing left to do. The run
keeps one identity and one history, so a run can complete more than once.

**Anyone who can reach a run may continue it.** That is any sender in a
thread bound to the run, and anyone who can post in the run itself. Each
message keeps its sender, so the run knows who said what. The run acts through
the run-as user's connectors whoever sent the input. This includes a Slack
guest, or a member of another company in a Slack Connect channel, when the run
posted into a shared channel with the workspace bot. That is the intended
consequence of this rule, not a gap, and it changes a rule documented today
(see Impact on the product contract).

A paused or deleted Sidekick does not continue. The input is recorded on the
run as refused, with the reason. What a Slack sender sees in that case is an
open question.

### Outbound reply threads: Northstar weekly call prep

The Northstar Sidekick has two schedule triggers and a home Breakout in the
investors Space.

1. **1 PM: send.** The Sidekick starts a run. The run DMs Morgan, Casey, and Jules
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

Two behaviors move:

1. A Sidekick run is no longer finished for good when it completes. Input
   reopens it.
2. **Authority follows the run, not the sender.** Today a message runs under
   the authority of whoever sent it, and an unlinked sender runs under the
   workspace principal, never as another member
   ([`connectors.md`](../../connectors.md) "only an account link grants it";
   [`slack-integration.md`](../../slack-integration.md) "Each message runs
   under the authority of whoever sent it"). Under this change, anyone who can
   reach a run continues it with the run-as user's personal connectors. Both
   documents change when this ships.

## Decision log

### 2026-09-27: A bot DM asks for the thread only while the latest request's run is open

**Decided:** A message in a DM with the workspace bot that has no binding of its
own is asked to use the request's thread only while the run behind the DM's most
recent outbound binding is still open: pending, running, or waiting for input.
Once that run has completed, failed or been stopped, such a message is ordinary
Agent work again. A reply inside a request's thread still reaches its run
whatever the run's state. A reply under the bot's own "please reply in the
thread" prompt has no binding either, so it is asked again in that prompt's
thread rather than starting Agent work.

**Why:** Asking for the thread forever after a Sidekick has once posted in a DM
would turn every later message to the bot into a redirect to a request nobody
is waiting on. A finished run has nothing left to collect, so the DM goes back
to what it was.

**Changes:** Narrows the 2026-09-26 decision on top-level DM replies, which
applied whenever the DM held any active outbound binding.

### 2026-09-26: A top-level reply in a bot DM with an open request is asked to use the thread

**Decided:** When someone writes at the top level of a DM with the workspace
bot, not in a thread, and that DM holds at least one active outbound binding,
the bot replies once asking them to answer in the request's thread, with a link
to the most recent one. The message creates no Rally work and reaches no run. A
DM with no active outbound binding keeps today's one-to-one Agent behavior.

**Why:** Most people answer a DM at the top level, and such a reply has no
binding. Guessing which request it answers would route it by timing, which the
design rules out; starting ordinary Agent work would repeat the bug this PRD
exists to fix. Asking costs the sender one more message and keeps every
collected answer tied to the request it answers.

**Changes:** Resolves open question 7 as agreed (top-level DM replies), which blocked
calling the Northstar flow solved. The one-to-one DM policy in the design is now
defined for DMs with an active outbound binding.

### 2026-09-26: Outbound bindings do not expire

**Decided:** A binding has no time limit. It stops routing only when it is
suspended: its Sidekick is deleted, its connection disconnects, the bot leaves
or the room is archived, or a person closes it.

**Why:** No workflow has asked for expiry, and choosing a duration now would be
a guess. A binding that outlives its use costs one row; the existing suspension
triggers cover the cases where routing must stop.

**Changes:** Resolves open question 6 as agreed, which blocked the build. What
a sender sees after suspension remains open, now open question 11. Revisit if
an old thread is used to drive a run through the run-as user's connectors long
after its request.

### 2026-09-26: The bot stays in conversations that Slack-triggered Sidekicks watch

**Decided:** Stopping proactive joins does not remove the bot from any
conversation a Slack automation source names, and saving a Sidekick with such a
source joins the bot to that conversation. A join made for a Sidekick source
is not an invitation, so it links no Space.

**Why:** Those Sidekicks receive message events only from conversations the bot
has joined. Letting them stop until someone invites the bot would silently
break working Sidekicks at rollout.

**Changes:** Resolves open question 10 as agreed. Narrows goal 4: Rally still does not
join conversations on its own, but it does join the ones a configured Sidekick
names.

### 2026-09-26: Leaving a private room does not remove Rally access

**Decided:** When someone leaves a private Slack channel or group DM, their
access to the linked Rally Space and its Channels stays as it is until someone
changes it in Rally. This is today's connector admission, which keeps
membership after a person leaves the provider room.

**Why:** Rally's own access checks are the authority for persisted Rally work,
and the existing behavior already works this way. Mirroring provider
departures would make Slack membership an unreviewed authority over Rally
content, which key design decision 4 already declines for bot removal.

**Changes:** Resolves open question 1 as agreed, which blocked private shared
rooms. Private channels and group DMs can ship. The private-room acceptance
criterion now applies without a precondition. Non-goal 5 (provider-wide
access mirroring) stays deferred.

### 2026-09-26: No view of a run

**Decided:** Rally does not build a screen for a Sidekick run. A run continues
from input that reaches it through a bound thread or an answer to a question
the run asked. Typing into a run is out of scope.

**Why:** The Northstar flow does not need it, and a run view is a new surface
(route, who is seated, composer, reopened state) with no request behind it.

**Changes:** Resolves open question 6 as agreed. Narrows goal 6: input from a
Rally user typing into a run is not built. A forward the model misses stays
invisible to people; the Breakout simply lacks that answer.

### 2026-09-27: The run authority check trusts a continuation's approval, not a reopened row

**Decided:** A continued run may act while its run row still reads
`completed` or `failed`. It may act through a `stopped` row only if that stop
came before `continueRun` approved the continuation. The run row reopens only
from an accepted, newer child projection.

**Why:** The design said the check passes "because the run is running", but
the row reopens through the child's projection on the Queue, which lands after
the continued execution checks its authority. `completed` and `failed` are only
ever the child's own report; `stopped` is what a pause writes, so it stays
fenced.

**Changes:** Supersedes design "Run continuation / Proposed" on how authority
passes. A pause still refuses a continuation. Known gap: an earlier activation
reporting `stopped` after the approval refuses the continuation's writes until
its own `running` projection lands.

### 2026-09-27: Room bindings are active at birth, and outbound bindings drain through the run's outbox

**Decided:** A room binding is written `active` in the same transaction as the
Space it links; it has no `pending` state. An outbound binding is queued on
the run child's own durable outbox inside the tool receipt's transaction and
drained to WorkspaceDO by the alarm, not through the Sidekick's regional-effect
outbox. A reply that arrives before that drain takes the ordinary Agent path.

**Why:** Space creation turned out to be one synchronous transaction, so there
is no intermediate state to fence. The Sidekick's effect outbox has a `CHECK`
on its effect kinds that would need a table rebuild.

**Changes:** Supersedes design "Creating bindings" for rooms and outbound
sends. Thread bindings still use `pending` while a Channel is created.

### 2026-09-27: Rooms where nobody is a Rally member

**Decided:** A tagged thread in a linked public room with no resolvable Rally
member falls back to General with a thread binding. In a private room it is
declined with a visible message in the thread. An unlinked sender in a linked
room creates the Channel acting as the Space's creator, and is refused with
`external_room_space_actor_missing` when the Space has none. Channels the old
join sweep already joined keep the bot but get no Space until someone invites
or mentions it there. Unarchiving a Slack room does not reactivate its binding;
re-inviting the bot does.

**Why:** A Channel needs a Rally actor to create it, and a private room must
never fall back to an Organization-wide audience.

**Changes:** Adds behavior the design left unstated. Closing a binding has an
RPC (`closeExternalConversationBinding`) but no screen yet.

### 2026-09-27: The conversation list pages, and posts reuse the activation row

**Decided:** `conversation_list` has a `conversation_list_next` page tool. Read
messages carry an `externalSource` field, and the read cursor keys on sequence
number. A post is stored as an `automation_activation` row through a new
non-waking `appendConversationPost`. A Sidekick's home also narrows its viewer
admission, not only the authorization owner.

**Why:** A list with `nextPageId` needs a next-page tool or it silently stops at
its limit. Reusing the activation row lets existing clients show posts under
the Sidekick's name with no client change.

**Changes:** Extends the design's tool catalog by one tool. `appendAutomationActivation`
has no production caller left.

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
5. **One binding record for rooms and threads.** What a match does follows
   from its target: a Space target creates Channels for addressed messages
   under it, and a conversation target receives messages. Separate types, or
   subclasses, would fix Slack's two levels into the schema, and the connector
   count is about to grow. Only the key is general; nothing else is built for
   adapters that do not exist yet.
6. **The home Breakout, not a run-to-run handoff, joins the two Northstar runs.**
   An earlier draft had Rally find the matching 1 PM run and hand a snapshot of
   its answers to the 2 PM run. That needed a key pairing the two runs, which
   nothing provides. The home Breakout needs no pairing, keeps the answers
   visible to people, and works for any multi-step Sidekick. Routing DM replies
   straight to the Breakout was also rejected: the run that sent a message
   should receive its replies.
7. **A reply wakes the run instead of being recorded silently.** An earlier
   draft appended replies to a finished run without waking its model. The
   forward in step 3 needs the model, so input continues the run.
8. **Add an owning substream beside `owning_workstream_id`, and remove
   `authoringOrigin`.** A new column defaulting to the Channel's Main
   conversation lets a home be a Breakout without rebuilding two tables whose
   `CHECK` constraints name the old column. The Slack-only `authoringOrigin`
   prompt field was never populated; a home Channel that began in Slack
   already carries that link as an origin resource.
9. **Attaching is the consent to publish.** A run child is personal to the
   run-as user, so any post from it widens who sees its content, just as
   `post_result` does today. Checking audiences on every call would refuse the
   flow this PRD exists for. Instead the person who attaches a conversation
   chooses its audience once, and must be able to post there.

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
including an external sender in a bound thread. Unlike a mail-started run,
which screens the sender against active members, a bound thread admits any
sender. Guests are admitted too: the run authority check skips guest admission
for a Sidekick run. A bound thread's text is untrusted: it is rendered to the
model as labelled evidence from its sender, never as a member request, and it
keeps that marking when forwarded. Only the Sidekick's config conversation can
attach a conversation, so a run cannot widen what it can read or post to.

## Agent behavior

Agents gain one built-in plugin, `rally:conversations`, with wire prefix
`conversation`. Its full contract (tool catalog, wire shapes, idempotency,
failures, sequences and evaluations) is in
[`design.md`](design.md#conversation-tools).

| Tool | What the agent may do | Offered to |
| --- | --- | --- |
| `conversation_list` | See the conversations it can reach, a Sidekick's home first | Every scope |
| `conversation_read`, `conversation_read_next` | Read one of them, newest first, a page at a time | Every scope |
| `conversation_post` | Post to one of them, a Sidekick's home by default | Sidekick config and runs |
| `conversation_attach` | Attach a Channel or Breakout to the Sidekick | Sidekick config only |

The agent is still forbidden to reach any conversation outside its scope, to
widen its own scope, or to attach from a run. It never supplies an
idempotency key; the host derives one so a retried post lands once. Messages it
reads are treated as other people's words, not instructions. The
`rally:sidekick-result` plugin and its `post_result` tool are removed.

While it works, people see ordinary tool activity in the transcript, and each
post appears in the target conversation as a message from the Sidekick or
agent. Following the tool execution policy, no call asks anyone to confirm it.

## Provider configuration

Slack's current app subscribes to `member_joined_channel` and has `mpim:read`
and `mpim:history`, but it does not subscribe to `message.mpim` or
`channel_id_changed`. The first is needed to receive group DM replies; the
second to keep a Slack Connect channel's bindings when Slack changes its ID.
Until `channel_id_changed` is subscribed on an installation, a changed ID
routes nothing rather than guessing. The public-channel join sweep and
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

Existing Sidekicks keep their Channel as home: the new home column defaults
to the Channel's Main conversation, so nothing is backfilled. A Sidekick whose
home should be a Breakout is changed explicitly.

Stopping proactive joins affects Sidekicks triggered by Slack activity: their
message events arrive only from conversations the bot has joined
([`slack-integration.md`](../../slack-integration.md)). The bot stays in every
conversation such a Sidekick names, and joins it when such a Sidekick is saved
(see the decision log).

This ships to everybody on merge, with no feature flag.

## Acceptance

- Inviting Rally to a public channel creates exactly one linked Space; event replay and a simultaneous first mention do
  not create duplicates.
- Two tagged threads in one shared room create two Rally Channels in the same
  Space. Replies to each stay in its Channel; an untagged unrelated thread
  creates nothing.
- A group DM message reaches ingress through `message.mpim` and uses the same
  binding path as channel messages. A one-to-one Rally/user DM does not create
  a Space.
- Inviting Rally to a private channel or group DM creates exactly one linked
  Space, and a private source never becomes Organization-readable solely
  because its member count exceeds the current Slack threshold. A person who
  leaves the private room keeps their Rally access until it is changed in
  Rally.
- Each DM the 1 PM Northstar run sends with the workspace bot binds its exact
  reply thread to that run. A founder's thread reply continues that run, even
  after it completed, with the Sidekick's instructions, tools, and run-as
  authority; it does not create a new Agent Channel or a new run.
- A post retried with the same receipt, or two concurrent replies to a
  completed run, produce one message per reply in the home Breakout. (That the
  model chooses to forward at all is covered by an evaluation, not this check.)
- The 2 PM run reads the home Breakout and posts the agenda there.
- Input to a paused or deleted Sidekick's run does not start a loop and is
  recorded on the run as refused with its reason, without blocking later input.
- The Sidekick's config conversation offers all four conversation tools. A
  run offers list, read, and post; it cannot attach a conversation, and
  cannot read or post to a conversation it is not attached to.
- A Breakout agent can list and read its own Breakout and its Channel's Main
  conversation, and cannot read any other conversation.
- No loop is offered `post_result`, and the `rally:sidekick-result` plugin
  no longer loads.
- In a Slack group DM that does not allow threads, two messages addressed to
  Rally create two Channels, and an unaddressed message creates nothing.
- A founder's answer is forwarded to a home Breakout that includes someone who
  was not in the founder's DM.
- A Slack Connect channel whose ID changes keeps routing to the same Space and
  Channels, starting from the `channel_id_changed` event.
- A reply to a binding suspended by Sidekick deletion, disconnect, or a
  person closing it creates no Rally work.
- Bot removal, room archive and disconnect each suspend the room binding and
  stop every thread under it; re-invitation reactivates the same binding and
  Space. A provider retry of the same event changes nothing.

## Open questions

1. **Existing bot memberships:** What explicit action selects already-joined
   channels and group DMs for linking after proactive joining stops?
2. **Rally-side placement:** Is the linked Space a required placement until
   unlinking, or may a user move its Channel away while the thread still routes
   there?
3. **Provider naming:** Should later provider renames update an untouched Rally
   Space title, or should the initial name always remain independent?
4. **Unconfirmed outbound delivery:** If the provider accepts an outbound root
   message but its response is lost, how can Rally recover that exact root ID
   before routing a reply? Without a provider receipt or a reliable correlation
   event, this is an uncollected state, not a reason to guess.
5. **Showing a reopened run:** How does the Sidekick's run history show a run
   that completed, reopened, and completed again?
6. **Detaching:** No tool or screen removes an attachment yet. Where does a
   person do that?
7. **Edited and deleted answers:** If a founder edits or deletes an answer
   after it was forwarded, does the forward change, and does a posted agenda?
8. **Posting for Channel and Breakout agents:** Should a Breakout agent be
   able to post to its Channel's Main conversation, and should a Channel agent
   reach its Breakouts? Both fit the same scope rule; neither is needed yet.
9. **What a sender sees after suspension:** A reply to a suspended binding
   creates no Rally work. Should the bot tell the sender, and what should it
   say?
