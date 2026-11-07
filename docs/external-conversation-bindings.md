# External conversation bindings

An external conversation binding says where a place in a connected tool routes
inside Rally. A **room binding** links a Slack channel, private channel or group
DM to a Space, so an addressed thread in that room opens a Channel in the Space.
A **thread binding** links one Slack thread to one Rally conversation: an Agent
Channel (substream `"0"`), or a Sidekick run child (`parentKind: "automation"`,
substream = the run id). Every Slack reply is routed by resolving its path
against these rows before any Channel is looked up or created.

Read this before changing how a Slack message finds its Channel, how the bot's
membership in a room is interpreted, or how a Sidekick run's Slack send becomes
something a reply can answer. The product decision is
[`docs/PRDs/2026-09-23_external-conversation-bindings/prd.md`](PRDs/2026-09-23_external-conversation-bindings/prd.md);
this document is what exists.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/workspace-external-binding-protocol.ts` | Every typed request and result: paths, targets, suspension reasons, the resolution outcomes, claims, room links, outbound records, moves. |
| `apps/api/src/durable-objects/workspace-external-binding-storage.ts` | `ExternalConversationBindingStorage`, the only code that reads or writes `external_conversation_bindings`, and migration 85 (`EXTERNAL_CONVERSATION_BINDINGS_MIGRATION`). `externalPathKey` builds every stored key. |
| `apps/api/src/durable-objects/workspace-do.ts` | The binding RPCs (`resolveExternalConversation`, `linkExternalRoom`, `recordOutboundExternalConversationBinding`, `suspend…`, `reactivate…`, `move…`, `latestOutboundExternalConversation`), the thread claim inside `reserveChannelInSpaces`, Sidekick deletion suspending its bindings, and bound events claimed in `matchExternalEventDestinations`. |
| `apps/api/src/durable-objects/workspace-slack-storage.ts` | `enqueueSlackSourceJoins`: the join jobs a saved Sidekick's Slack sources need, which WorkspaceDO dispatches from `applyExternalEventRegistrations`. |
| `apps/api/src/durable-objects/external-binding-outbox.ts` | The SubstreamAgent `durable_outbox` channel `external_conversation_binding_v1` that carries a run's outbound binding from its tool receipt to WorkspaceDO. |
| `apps/api/src/durable-objects/workstream-tool-receipt-storage.ts` | `complete` enqueues the outbound binding in the receipt's own transaction. |
| `apps/api/src/services/external-binding-claims.ts` | The one settlement of a Channel's thread claim: the `binding_refused` mapping, release on failure, activation after. |
| `apps/api/src/services/slack-agent-service.ts` | Slack ingress: `resolveBinding`, the lifecycle events, `linkRoom`, delivery to a run child, the one-to-one DM thread prompt, and the Sidekick-source join. |
| `packages/connectors/src/slack.ts` | `slackInstallationId`, `slackMessagePath`, `slackExternalRoom`, `send_message` returning `externalConversation`, and the binding key written into activity metadata. |
| `config/provider-apps/slack.json` | The lifecycle and `message.mpim` event subscriptions. |

## How it works

### Keys

A binding is keyed by **installation** and **path**. The installation is the
provider installation (`slack:<teamId>`, from `slackInstallationId`), not the
`connector_connections` row: a reconnect may mint a new connection row, and the
binding has to survive it. A path is an array of provider identifiers, root
first: `[channel]` for a room, `[channel, threadTs]` for a thread.
`slackMessagePath` computes a message's path; a top-level message is its own
thread root, so a room Slack marks non-threadable still produces
`[channel, ts]`. The stored key is `JSON.stringify(path)`, so an ancestor is a
prefix and a descendant range is a text range. The Slack adapter writes a
message's key into its activity metadata (`externalConversationInstallationId`
and `externalConversationPath`), so WorkspaceDO resolves any connector's key
without knowing its installation scheme.

### Resolution

`resolve` reads the path and every ancestor in one query, then decides, in
order:

1. Any **suspended** row on the chain: `suspended`. Nothing is created; the
   ingress logs `binding_suspended` and stops.
2. An **active conversation** binding on the exact path: `deliver` to it.
3. A **pending** exact path that is not this attempt's own claim and is younger
   than the claim lease: `hold`. The ingress answers 503 and the queue retries.
4. An **addressed** message (an `app_mention`) whose nearest active ancestor
   is a **Space** binding, with no exact row or a reclaimable one: `spawn` in
   that Space.
5. Otherwise `none`, reporting whether any ancestor row exists.

`none` falls through to the Agent path that predates bindings; a DM with no
binding is today's one-to-one Agent conversation.

A `connection_disconnected` suspension found while Slack is delivering the
installation's events is stale: the ingress lifts what the disconnect suspended
and resolves again. The reconnect's own reactivation is one best-effort call,
and a revocation job that runs after a reinstall suspends the new installation,
so the next message is where either is repaired.

### Rooms

The bot being added to a room is the invitation. `member_joined_channel` for
the bot's own user calls `linkRoom`, which resolves the room with
`conversations.info`, asks `admitSpaceCreation` before claiming a parent anchor,
and calls `linkExternalRoom`. That one WorkspaceDO transaction writes the Space
and the active room binding together. Every room's Space is Organization-wide,
because every Space starts that way (see [`spaces.md`](spaces.md#a-space-starts-organization-wide-and-grants-no-reader)),
and it seats nobody. A room's privacy belongs to the Channels its threads open:
a public room's thread is Organization-wide, and a private channel's or group
DM's is private to the room's members Rally can map, until the room passes the
member-count promotion (`SLACK_CONVERSATION_WORKSPACE_SCOPE_THRESHOLD`, 50),
past which it is Organization-wide, as for an unlinked room.

A public room whose name matches a live Organization-wide Space links to that
Space instead of making one. Names compare ignoring case, spaces, dashes and
underscores, so `#general` lands in "General" and `#product-launch`,
`#product_launch` or `#productlaunch` in "Product Launch". A name made only of
separators matches nothing. The oldest match wins when several share a name.
`linkExternalRoom` decides the match. The ingress asks `externalRoomSpaceMatch`
first only to learn whether to claim a D1 anchor, since a matched room needs
none, and passes `spaceMatch`: `matched` with the matched id, or `unmatched`
with the room's own, anchored id. The link looks again: a Space that matches
now is joined either way, a `matched` id that no longer matches is refused
(`space_not_found`) because it has no anchor to be created under, and the
transaction refuses if the match, or whether its creator is still an active
member, changed during the link's own awaits. The schema accepts
`spaceMatch` only for an Organization-wide room that seats nobody. A match
whose creator is no longer an active member is not offered, because a thread
from a sender with no Rally identity opens its Channel acting as that creator;
the room gets its own Space instead. A private room never matches; that rule
predates every Space being Organization-wide, and its old reason (a private
room's Space seated the room's members) no longer holds. Neither does a Slack
Connect room (`is_ext_shared` or `is_pending_ext_shared`), which Slack reports
as public but whose members include another organization. A matched room shared
through Slack Connect after it linked is refused at spawn: the room binding
records `space_matched` when it links, resolution returns it as `spaceMatched`,
and a thread under a matched room first asks `conversations.info`; an
externally shared room gets a `room_shared_externally` notice instead. A
room's own Space skips that call. Only the record can say which a Space is:
Slack renumbers a private room it shares (`channel_id_changed`), so the
room-derived id stops matching.
An `unmatched` link that finds a match leaves the room's anchor unused, which
costs nothing.

A mention
in a room that has no binding runs the same step first (`fall_through` mode), so
an app installed before this change still links rooms on first use. The Space
id is derived from the installation and room, so a redelivered or racing
invitation claims the same D1 anchor and reads back `existing`. A matched
room's racing invitations both name the matched Space, with the same effect.
A fresh link posts one line in the room saying what inviting Rally did.

A room suspended because the bot left or it was archived comes back when the
bot is invited again or mentioned there: Slack delivers either only from a room
the bot is in. The link step then lifts the room's suspension directly, keeping
its Space and resolving no actor.

A room Slack has made private since it linked opens private Channels from then
on: the room, not its Space, decides each new Channel's audience.

There is no pending state for a room: a Space no longer provisions anything
asynchronously, so the binding and the Space commit or fail together.

### Threads

A `spawn` resolution creates the Channel through `reserveChannelInSpaces` with
an `externalBinding` claim. The claim is written `pending` in the same
transaction that reserves the Channel, so a second message in the same thread
resolves to `hold` rather than creating a second Channel. After the creation
receipt completes, the binding is activated; if creation fails, it is
released (`external-binding-claims.ts`). A sender with no linked Rally account
creates the Channel acting as the Space's creator (`createdByUserId`), so it
lands in the Space without widening it; if the Space has no creator to act as,
the message is refused with `external_room_space_actor_missing`. That path names
the Channel from the claim, so a retry of the same event re-enters the Channel
its failed first attempt reserved; a linked sender's create is keyed by its
creation receipt for the same reason. An event that loses the thread to another
event's claim fails as a retryable `external_binding_raced`, and its retry
delivers to the winner. A message that could not be placed gets a notice naming
the reason, keyed by the event so a retried job posts it once.

In a room Slack marks `is_non_threadable`, every message is its own thread root
and nothing is posted into a thread: the Agent status and title are skipped, and
the result is posted top-level, chunks included. The session records this in
its source context.

An Agent session started any other way (a DM, a mention that falls through)
writes its thread binding with `recordOutbound` inside
`createWorkspaceSlackSession`, and throws if the thread is already bound
elsewhere. `slackThreadRoutable`, which decides whether an unaddressed reply is
worth an ingress job, is answered by resolution plus pending prompts; the
session row is delivery state, not routing.

### Sidekick runs

When a Sidekick run posts with the workspace bot token, `send_message` returns
`externalConversation: {installationId, path}` on its tool result. The connector
seam carries it through `HarnessToolResult` to the host, which passes it on only
when the call belongs to a run child (`automationRun`, parent kind `automation`,
substream not `"0"`). The key is enqueued on the run child's `durable_outbox`
inside the tool receipt's `complete` transaction, so a binding exists if and
only if the receipt says the send happened. The alarm drains it to
`recordOutboundExternalConversationBinding`, naming the run child itself as the
target, where the **first binding wins**: a thread already bound to another
conversation stays with it. A row that no longer parses is parked `dead` with
its reason, and a failed delivery waits out the retry interval without holding
up the rows behind it.

A reply in that thread resolves to `deliver` with the run child as target. The
ingress admits it through `externalBindingReplyAdmission` to the run child's
`admitExternalMessage` as an external message with the Slack actor. The run
child frames it as evidence from that sender, and a wake of a run child calls
`WorkspaceDO.sidekickContinueRun`. The reply runs with the run's authority, not the
sender's: [`connectors.md`](connectors.md#invariants) owns that rule. The reply
gets the installation's acknowledgement reaction, or its stopped reaction when
the Sidekick is not active and the run will not act on it yet.

The reply reaches the run, never the Sidekick's wizard. A reply that asks to
change the Sidekick itself is passed on by the run with
`request_sidekick_change`;
[`agent-communication.md`](agent-communication.md#a-run-asking-its-wizard-for-a-change)
owns that path.

### One-to-one DMs

A message in a bot DM with no binding of its own (a top-level message, or a
reply under the prompt below) is answered once, in its thread, asking the person
to reply in the request's thread with a permalink to the most recent request
(`latestOutboundExternalConversation`), but only while that request's run is
still open (pending, running or waiting for input, read from the Sidekick's run
state). It creates no Rally work. Once the run has finished, such a message is
ordinary Agent work again. The prompt's `client_msg_id` is derived from the
ingress claim key, so a retried job posts it once.

### Lifecycle

| Event | Effect |
| --- | --- |
| Bot `member_joined_channel` | Link the room, or lift its provider suspension. |
| `@Rally` in a room suspended because the bot left or it was archived | Lift the room's suspension, then route the mention. |
| Bot `member_left_channel`, `channel_left`, `group_left` | Suspend the room: `provider_membership_ended`. |
| `channel_archive`, `group_archive` | Suspend the room: `provider_room_archived`. Unarchive does not reactivate; a re-invitation does. |
| `channel_id_changed` | Move the room's binding and every descendant to the new id, or refuse on a conflict. |
| Workspace disconnect, uninstall, token revocation | Suspend the installation's active bindings: `connection_disconnected`. Reconnecting, or the installation's next delivered event, reactivates exactly those. |
| Sidekick deleted | Suspend every binding targeting its runs: `sidekick_deleted`. |

A suspended room suspends its threads through resolution rather than by
rewriting them. A lasting suspension (the bot leaving, an archive, a deletion)
replaces a disconnect's on the same row, so a reconnect cannot bring back what
has since ended. `closed` is a reason the table accepts; no surface sets it.

### Sidekick Slack sources

Saving a Sidekick whose Slack source names channels queues a
`rally_sidekick_source_join` ingress job from
`applyExternalEventRegistrations`. The job joins the bot to those conversations
so their events arrive. It links no Space: a join a Sidekick needs is not an
invitation. The public-channel join sweep and the `channel_created` join are
gone; the bot is in a room because somebody put it there or a Sidekick needs it.

### Claimed events

`matchExternalEventDestinations` counts an event whose metadata binding key
resolves to a binding as claimed, even with
no automation delivery, so a bound reply never also becomes Suggested Work.

When the binding delivers to a Sidekick's run, **the binding wins for that
Sidekick**: the event is not also a trigger delivery to the same Sidekick, so an
answer continues the run it answers instead of starting a second one beside it.
Other Sidekicks whose sources match the message still receive it as a trigger.

## Invariants

- **One path, one target.** The primary key is (installation, path). Two
  writers racing on a thread both go through an upsert whose RETURNING row is
  the witness; the loser reads `held` or `bound`. Deciding from a write count
  instead would let two Channels claim one thread.
- **A thread claim commits with its Channel.** The claim lives inside
  `reserveChannelInSpaces`. Moved outside it, a crash between the two leaves a
  Channel no reply can find or a binding that points nowhere.
- **An outbound binding commits with its tool receipt.** If it were written
  after the receipt, a lost write would leave a posted question whose answer
  opens an unrelated Agent Channel; if before, a failed send would bind a
  thread that does not exist.
- **The first binding wins.** `recordOutbound` never rebinds a thread. A run
  that posts into an Agent thread must not steal the thread's replies from it.
- **A binding survives a reconnect.** It is keyed by installation, not
  connection row, and has no foreign key to `connector_connections`. Keying by
  the row would orphan every binding on the first reconnect.
- **Suspension is a state, not a delete.** The row keeps its target so a
  reconnect or re-invitation restores the same routing. A reconnect lifts only
  `connection_disconnected`, and a room's return lifts only that room's provider
  suspension; a deletion or `closed` stays. A lasting reason overwrites a
  disconnect's, or the reconnect would undo it.
- **Several rooms can share one Space.** A matched room links into a Space
  another room, another installation, or no room at all may already hold.
  Every lifecycle operation keys on the room's path, never on the Space, so
  suspending, moving or reactivating one room leaves the others alone.
- **A Sidekick-source join links nothing.** Treating it as an invitation would
  create Spaces nobody asked for.
- **Only WorkspaceDO's typed RPCs touch the table.** It is in the typed-RPC-only
  set and `WORKSPACE_LOCAL_TABLES`.

## Boundary

This module owns the binding table, resolution, room linking, claims, and the
lifecycle transitions. It depends on Spaces
([`spaces.md`](spaces.md)) for the Space and its audience, on Channel creation
([`workstream-creation.md`](workstream-creation.md)) for the reservation it
claims inside, and on the tool receipt
in the SubstreamAgent
([`workstream-durable-object.md`](workstream-durable-object.md)) for outbound
atomicity.

It does not deliver Rally output to Slack (the session and delivery path in
[`slack-integration.md`](slack-integration.md) does), does not decide who may
continue a run (the run authority check does), and does not continue a run
(`WorkspaceDO.sidekickContinueRun` does). The `slack_thread` origin resource on a Channel
is provenance only and is never read for routing
([`workstream-origin-attachments.md`](workstream-origin-attachments.md)).

## Failure modes and limits

- **Pending claim abandoned.** A claim whose creation died is reclaimable after
  `SLACK_THREAD_CLAIM_LEASE_MS` (5 minutes), the existing Slack thread-claim
  lease. Until then replies `hold` and the queue retries them.
- **Private room with no Rally member.** The link is declined and the person
  who mentioned Rally is told so in the thread. A public room with no
  resolvable member falls back to General with a thread binding.
- **Space creation refused** (maintenance, an unresolvable anchor): the mention
  falls through to the Agent path; a public room keeps working.
- **Outbound drain failure.** The outbox retries every 5 seconds until
  WorkspaceDO accepts, without holding up the rows behind it; a row that does
  not parse is parked `dead` and logged `external_binding_delivery_dead`. A
  reply that arrives before the drain resolves `none` and takes the Agent path,
  and in a shared room an `@Rally` there opens a Channel that then keeps the
  thread (first binding wins). The alarm drains right after the receipt
  commits, so the window is short; closing it would take a Slack read of the
  thread's root on every addressed message.
- **Activation lost.** A Channel whose claim was taken over past the lease is
  created but unrouted; `external_binding_activation_lost` names it, and the
  message is retried into the winner.
- **`channel_id_changed` onto an occupied id.** The move is refused and logged
  `slack_room_id_changed` with `outcome: conflict`; the old bindings stay.
- **Large private rooms.** A private room past
  `SLACK_CONVERSATION_WORKSPACE_SCOPE_THRESHOLD` members opens Organization-wide
  Channels, as an unlinked room does.

No new numeric limit is introduced.

## Testing

| Suite | What it proves |
| --- | --- |
| `apps/api/test-workers/external-conversation-bindings.test.ts` | On real workerd: link races and redelivery, private vs public Space, removal and re-invitation, two threads in one room, pending hold and resume, failed creation releasing its claim, claim refused on a bound thread, non-threadable rooms, blocked private placement, Sidekick deletion, disconnect/reconnect against a closed binding, `channel_id_changed` move and conflict, outbound first-wins, the latest outbound in a DM, a run send bound only after its receipt commits and the alarm drains, a lost receipt and a personal send writing nothing, a bound reply landing in the run child with its external actor, a bound event claimed and not also triggering the Sidekick it answers, the Sidekick-source join (again on every accepted save, never on a stale one), a lasting suspension surviving a reconnect, a retried spawn re-entering its own Channel, a bad outbox row parked without holding up the rest, and name matching: what counts as the same name, private, archived and separator-only names never matching, a Space whose creator left not offered, a matched room linked into General, and a match renamed, made private or archived before the link refused. |
| `apps/api/test-workers/external-bindings-mucker-flow.test.ts` | The whole flow on real workerd, with only OpenRouter and the Slack Web API doubled: a Sidekick run homed in a Breakout sends a Slack DM through the workspace bot and its thread binds once the outbox drains; the founder's reply arrives through `SlackAgentService` ingress and continues the finished run with its run context; the continued run's `conversation_post` with no conversation lands once in the home Breakout, marked as from Slack, without waking it, and neither a redelivered event nor a replayed receipt posts twice; a later top-level DM, after the run has finished, is not redirected and reaches no run; a later run reads the answer with `conversation_read`. |
| `apps/api/test/external-conversation-binding-migration.test.ts` | Migration 85 carries each session's exact thread key and nothing else. |
| `apps/api/test-workers/workspace-slack-ingress.test.ts` | `slackThreadRoutable` answered from bindings, and a thread's session moved to the connection a reconnect wrote. |
| `packages/connectors/src/slack.test.ts` | Path and room classification (Slack Connect included), and `send_message` returning a binding only for the workspace installation. |

The workers suite clears `external_conversation_bindings` in `beforeEach`; a
test that seeds a Slack connection must seed `connector_connections` itself,
because that D1 starts empty. The migration test seeds `workspace_identity`, or
the object refuses the database as another workspace's.

## Data model

`external_conversation_bindings` (WorkspaceDO, migration 85): `installation_id`,
`path_json`, `target_kind` (`space` | `conversation`), `space_id` or
(`parent_kind`, `parent_id`, `substream_id`), `state` (`pending` | `active` |
`suspended`), `suspended_reason`, `claim_key`, timestamps, and `space_matched`
(migration 90: 1 when a room joined its Space by name, 0 for its own Space, a
conversation, and every row from before matching existed). CHECKs tie a target
kind to its columns, a suspended state to a reason, and a pending state to a
claim key. A partial index on the conversation target serves suspending one
Sidekick's bindings.

## Security and trust model

Room names, member lists, message text and actor profiles are untrusted. A
Slack member is not a Rally member: a private room's Channel is seated only
with members Rally maps, and a Channel is never widened to make placement
succeed. A reply
delivered to a run child is framed to the model as evidence from its sender,
not as a member request. Only a Sidekick's config conversation can add a Slack
source, so a run cannot widen what the bot joins.

## Changelog

### 2026-10-06 — A room's privacy belongs to its Channels, not its Space

**What changed:** `linkExternalRoom` takes no scope or participants: every
room's Space is Organization-wide and seats nobody. A thread's Channel takes the
room's own audience through `connectorWorkstreamScope`, the same rule an
unlinked room uses, including the 50-member promotion. The
`room_narrower_than_space` refusal is gone.

**Why:** Every Space is Organization-wide and grants no reader
([`spaces.md`](spaces.md)), so a private room could no longer be private
through its Space. Its Channels carry the privacy instead.

**Considered and rejected:** Keeping private Spaces for private rooms as the
one exception. It would have left two kinds of Space and a Channel whose
privacy depended on which one it was born in.

**Consequences:** The room decides each new Channel's audience at spawn; a
change that reads it from the Space again would open private rooms to the
Organization.

Pull request: [#1119](https://github.com/juno-ai-labs/avalon/pull/1119).

### 2026-10-05 — A public room joins the existing Space it is named for

**What changed:** Linking a public room first looks for a live
Organization-wide Space with the same name, ignoring case, spaces, dashes and
underscores (`WorkspaceSpaceStorage.organizationSpaceNamed`, exposed as
`WorkspaceDO.externalRoomSpaceMatch`), and links the room into it rather than
creating a second Space. `linkExternalRoom` decides the match itself, so a
Space that starts matching after the ingress asked is joined rather than
duplicated, and one renamed, made private or archived in between is refused
rather than bound. A Space whose creator has left is
never matched, since that creator is who an unlinked sender's Channel is placed
as. Slack Connect rooms never match, and a matched room later shared through
Slack Connect opens no new Channel there; migration 90 adds `space_matched` to
the binding so that check knows a matched room after a renumbering or a
narrowed Space.

**Why:** Inviting Rally to `#general` made a Space named "general" beside the
Organization's "General", so the team's threads split across two Spaces with
the same name. Slack channel names hold no capitals or spaces, and teams write
the gap as a dash, an underscore or nothing, so a match has to ignore all three
for `#product-launch`, `#product_launch` and `#productlaunch` to find "Product
Launch".

**Considered and rejected:** Matching only in the ingress. Its answer is a
separate event from the link, so a Space created or edited in between would be
duplicated or wrongly bound. Matching only in `linkExternalRoom`: the ingress
would have to claim an anchor for every room, matched or not.
Matching private rooms: an existing private Space's audience is not the room's,
and adopting one would either widen it or hide the room's threads from members.
Matching Slack Connect rooms: an outside organization could name its shared
channel `general` and land in the Organization's General. SQLite
`COLLATE NOCASE`: it folds ASCII only. Recording the inviter on the binding as
the placement actor, so a matched Space's creator leaving later does not stop
its threads: a second column the binding would need for one rare case, left
until a room actually hits it. Telling a matched Space apart by the room-derived id
or by the Space's scope: Slack renumbering a room breaks the first, and
narrowing the Space breaks the second.

**What a future change must respect:** a change that widens the match (other
punctuation, accents) keeps the private-room and Slack Connect rules and asks
for the match before the anchor is claimed.

### 2026-09-27 — Slack routing moves from session rows to bindings

**What changed:** Added `external_conversation_bindings` (migration 85), which
carries every existing session's thread key. A bot invitation links a room to a
Space; an addressed thread in a linked room opens a Channel there with its
binding claimed in the reservation transaction. A Sidekick run's bot-token send
binds its thread through the tool receipt, and a reply is delivered to the run
child. Lifecycle events suspend, move and reactivate bindings. The public
channel join sweep and the `channel_created` join were removed.

**Why:** A reply to a question a Sidekick asked in Slack opened an unrelated
Agent Channel, because the only routing key was the Agent session row. Rooms had
no place in Rally, so every thread in a team's channel landed in General. The
join sweep put the bot in rooms nobody invited it to, which made "the bot is
here" mean nothing.

**Considered and rejected:** Carrying the outbound binding on SidekickDO's
regional-effect outbox. Its effect-kind CHECK would need a table rebuild; the
run child's own `durable_outbox` already commits with the receipt and drains to
WorkspaceDO directly. A `pending` state for rooms: nothing about Space creation
is asynchronous any more. Keying by connection row: a reconnect would orphan
every binding.

A binding's key and a spawned Channel's id are derived from the thing they
name (the room, the claim) because retried and racing events were the normal
case on a queue-driven ingress: fresh ids left an orphaned Space anchor or a
second Channel per retry. A disconnect's suspension is lifted by the next
delivered event because the reconnect's own reactivation is one best-effort
call and a late revocation job can suspend a reinstalled installation.

**Consequences:** Authority follows the run, not the sender, for a bound reply
to a Sidekick run; [`connectors.md`](connectors.md#invariants) owns that rule.
Unarchiving a room does not reactivate it; a re-invitation or a mention does.
Nothing closes a binding yet; `closed` is kept in the table's CHECK for the
surface that will. A reply that beats the outbound drain takes the Agent path.
A bot DM asks for the request's thread only while that request's run is open.

Shipped in #1006. Design: `docs/PRDs/2026-09-23_external-conversation-bindings/`.
