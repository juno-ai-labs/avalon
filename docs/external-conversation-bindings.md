# External conversation bindings

An external conversation binding says where a place in a connected tool routes
inside Rally. A **thread binding** links one Slack thread to one Sidekick run
child (`parentKind: "automation"`, substream = the run id), so a reply there
continues the run. Every Slack message is resolved against these rows before
anything else is decided. The **room binding** that linked a Slack channel to
a Space, so an addressed thread there opened a Channel, is retired with Spaces
and Channels: nothing writes one, and WorkspaceDO migration 147 deleted every
row that held one (`target_kind = 'space'`) along with every binding to a
Thread (`parent_kind = 'workstream'`). The table's CHECK still admits those
values; no row holds them.

Read this before changing how a Slack message finds its run, or how a Sidekick
run's Slack send becomes something a reply can answer. The product decision is
[`docs/PRDs/2026-09-23_external-conversation-bindings/prd.md`](PRDs/2026-09-23_external-conversation-bindings/prd.md);
this document is what exists.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/workspace-external-binding-protocol.ts` | Every typed request and result: paths, targets, suspension reasons, the resolution outcomes, outbound records, moves. |
| `apps/api/src/durable-objects/workspace-external-binding-storage.ts` | `ExternalConversationBindingStorage`, the only code that reads or writes `external_conversation_bindings`, and migration 85 (`EXTERNAL_CONVERSATION_BINDINGS_MIGRATION`). `externalPathKey` builds every stored key. |
| `apps/api/src/durable-objects/workspace-do.ts` | The binding RPCs (`resolveExternalConversation`, `recordOutboundExternalConversationBinding`, `suspend…`, `reactivate…`, `move…`, `latestOutboundExternalConversation`), Sidekick deletion suspending its bindings, and bound events claimed in `matchExternalEventDestinations`. |
| `apps/api/src/durable-objects/workspace-slack-storage.ts` | `enqueueSlackSourceJoins`: the join jobs a saved Sidekick's Slack sources need. |
| `apps/api/src/durable-objects/external-binding-outbox.ts` | The AgentLoopDO `durable_outbox` channel `external_conversation_binding_v1` that carries a run's outbound binding from its tool receipt to WorkspaceDO. |
| `apps/api/src/durable-objects/workstream-tool-receipt-storage.ts` | `complete` enqueues the outbound binding in the receipt's own transaction. |
| `apps/api/src/services/slack-agent-service.ts` | Slack ingress: `resolveBinding`, the lifecycle events, delivery to a run child, the one-to-one DM thread prompt, and the Sidekick-source join. |
| `packages/connectors/src/slack.ts` | `slackInstallationId`, `slackMessagePath`, `send_message` returning `externalConversation`, and the binding key written into activity metadata. |
| `config/provider-apps/slack.json` | The lifecycle and `message.mpim` event subscriptions. |

## How it works

### Keys

A binding is keyed by **installation** and **path**. The installation is the
provider installation (`slack:<teamId>`, from `slackInstallationId`), not the
`connector_connections` row: a reconnect may mint a new connection row, and the
binding has to survive it. A path is an array of provider identifiers, root
first: `[channel, threadTs]` for a thread. `slackMessagePath` computes a
message's path; a top-level message is its own thread root, so a room Slack
marks non-threadable still produces `[channel, ts]`. The stored key is
`JSON.stringify(path)`, so an ancestor is a prefix and a descendant range is a
text range. The Slack adapter writes a message's key into its activity
metadata (`externalConversationInstallationId` and `externalConversationPath`),
so WorkspaceDO resolves any connector's key without knowing its installation
scheme.

### Resolution

`resolve` reads the path and every ancestor in one query, then decides, in
order:

1. Any **suspended** row on the chain: `suspended`. Nothing is created; the
   ingress logs `binding_suspended` and stops.
2. An **active conversation** binding on the exact path: `deliver` to it.
3. A **pending** exact path younger than the claim lease: `hold`. The ingress
   answers 503 and the queue retries. (Only the retired Thread claim wrote
   `pending`.)
4. Otherwise `none`, which Slack answers with the retired-ingress copy
   ([`slack-integration.md`](slack-integration.md#agent-sessions-and-delivery)).

A `connection_disconnected` suspension found while Slack is delivering the
installation's events is stale: the ingress lifts what the disconnect suspended
and resolves again. The reconnect's own reactivation is one best-effort call,
and a revocation job that runs after a reinstall suspends the new installation,
so the next message is where either is repaired.

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

In a room Slack marks `is_non_threadable`, every message is its own thread root
and nothing is posted into a thread: the result is posted top-level, chunks
included.

### One-to-one DMs

A message in a bot DM with no binding of its own (a top-level message, or a
reply under the prompt below) is answered once, in its thread, asking the person
to reply in the request's thread with a permalink to the most recent request
(`latestOutboundExternalConversation`), but only while that request's run is
still open (pending, running or waiting for input, read from the Sidekick's run
state). It creates no Rally work. Once the run has finished, such a message is
answered with the retired-ingress copy. The prompt's `client_msg_id` is derived
from the ingress claim key, so a retried job posts it once.

### Lifecycle

| Event | Effect |
| --- | --- |
| Bot `member_joined_channel` | Links and reactivates nothing (logged `slack_room_invitation`, `room_bindings_retired`). |
| Bot `member_left_channel`, `channel_left`, `group_left` | Retired in effect: suspends the room's own row (`[channel]`) as `provider_membership_ended`, and no such row exists since migration 147, so nothing changes. |
| `channel_archive`, `group_archive` | Retired in effect: the same suspension as `provider_room_archived`, touching no row. |
| `channel_id_changed` | Move every run-thread binding under the room to the new id, or refuse on a conflict. |
| Workspace disconnect, uninstall, token revocation | Suspend the installation's active bindings: `connection_disconnected`. Reconnecting, or the installation's next delivered event, reactivates exactly those. |
| Sidekick deleted | Suspend every binding targeting its runs: `sidekick_deleted`. |

A suspended room row used to suspend its threads through resolution; with no
room rows left, a thread binding is suspended only on its own row. A lasting
suspension (a Sidekick deletion) replaces a disconnect's on the same row, so a
reconnect cannot bring back what has since ended. `closed` is a reason the table accepts; no surface sets it.

### Sidekick Slack sources

Saving a Sidekick whose Slack source names channels queues a
`rally_sidekick_source_join` ingress job. The job joins the bot to those
conversations so their events arrive, and links nothing: a join a Sidekick
needs is not an invitation. The bot is in a room because somebody put it there
or a Sidekick needs it.

### Claimed events

`matchExternalEventDestinations` counts an event whose metadata binding key
resolves to a binding as claimed, even with no automation delivery.

When the binding delivers to a Sidekick's run, **the binding wins for that
Sidekick**: the event is not also a trigger delivery to the same Sidekick, so an
answer continues the run it answers instead of starting a second one beside it.
Other Sidekicks whose sources match the message still receive it as a trigger.

## Invariants

- **One path, one target.** The primary key is (installation, path). Two
  writers racing on a thread both go through an upsert whose RETURNING row is
  the witness; the loser reads `held` or `bound`.
- **An outbound binding commits with its tool receipt.** If it were written
  after the receipt, a lost write would leave a posted question whose answer
  reaches no run; if before, a failed send would bind a thread that does not
  exist.
- **The first binding wins.** `recordOutbound` never rebinds a thread.
- **A binding survives a reconnect.** It is keyed by installation, not
  connection row, and has no foreign key to `connector_connections`. Keying by
  the row would orphan every binding on the first reconnect.
- **Suspension is a state, not a delete.** The row keeps its target so a
  reconnect restores the same routing. A reconnect lifts only
  `connection_disconnected`; a deletion or `closed` stays. A lasting reason
  overwrites a disconnect's, or the reconnect would undo it.
- **A join links nothing.** Treating a bot join as an invitation would start
  routing a room nobody asked Rally into.
- **Only WorkspaceDO's typed RPCs touch the table.** It is in the typed-RPC-only
  set and `WORKSPACE_LOCAL_TABLES`.

## Boundary

This module owns the binding table, resolution, and the lifecycle transitions.
It depends on the tool receipt in the AgentLoopDO
([`workstream-durable-object.md`](workstream-durable-object.md)) for outbound
atomicity. It does not deliver Rally output to Slack
([`slack-integration.md`](slack-integration.md)), does not decide who may
continue a run (the run authority check does), and does not continue a run
(`WorkspaceDO.sidekickContinueRun` does).

## Failure modes and limits

- **Outbound drain failure.** The outbox retries every 5 seconds until
  WorkspaceDO accepts, without holding up the rows behind it; a row that does
  not parse is parked `dead` and logged `external_binding_delivery_dead`. A
  reply that arrives before the drain resolves `none` and gets the
  retired-ingress answer. The alarm drains right after the receipt commits, so
  the window is short; closing it would take a Slack read of the thread's root
  on every addressed message.
- **`channel_id_changed` onto an occupied id.** The move is refused and logged
  `slack_room_id_changed` with `outcome: conflict`; the old bindings stay.

No numeric limit beyond the retry interval is introduced.

## Testing

| Suite | What it proves |
| --- | --- |
| `apps/api/test-workers/external-conversation-bindings.test.ts` | On real workerd: Sidekick deletion suspending its run bindings, first binding wins and a redelivery is a no-op, the latest open request in a DM, a run send bound only after its receipt commits and the alarm drains, a bad outbox row parked without holding up the rest, a lost receipt and a personal send writing nothing, a bound reply landing in the run child as the sender's external message, a bound event claimed and not also triggering the Sidekick it answers while still triggering others, and the Sidekick-source join (again on every accepted save, never on a stale one). |
| `apps/api/test-workers/external-bindings-mucker-flow.test.ts` | The whole flow on real workerd, with only OpenRouter and the Slack Web API doubled: a Sidekick run's DM through the workspace bot binds its thread once the outbox drains; the reply arrives through `SlackAgentService` ingress and continues the finished run, and neither a redelivered event nor a replayed receipt posts twice; a later top-level DM after the run has finished reaches no run. |
| `apps/api/test/external-conversation-binding-migration.test.ts` | Migration 85 carries each session's exact thread key and nothing else. |
| `packages/connectors/src/slack.test.ts` | Path and room classification (Slack Connect included), and `send_message` returning a binding only for the workspace installation. |

The workers suite clears `external_conversation_bindings` in `beforeEach`; a
test that seeds a Slack connection must seed `connector_connections` itself,
because that D1 starts empty. The migration test seeds `workspace_identity`, or
the object refuses the database as another workspace's.

## Data model

`external_conversation_bindings` (WorkspaceDO, migration 85): `installation_id`,
`path_json`, `target_kind`, `space_id` or (`parent_kind`, `parent_id`,
`substream_id`), `state` (`pending` | `active` | `suspended`),
`suspended_reason`, `claim_key`, timestamps, and `space_matched` (migration
90). Every live row is a `conversation` target with `parent_kind =
'automation'`: a run child. The CHECK still admits `target_kind = 'space'`
and a `workstream` parent, and `space_id` and `space_matched` remain as
columns, but WorkspaceDO migration 147 deleted every row that used them, and
nothing writes one. `pending` was written only by the retired Thread claim. CHECKs tie a target kind to
its columns, a suspended state to a reason, and a pending state to a claim
key. A partial index on the conversation target serves suspending one
Sidekick's bindings.

## Security and trust model

Message text and actor profiles are untrusted. A reply delivered to a run
child is framed to the model as evidence from its sender, not as a member
request. Only a Sidekick's config conversation can add a Slack source, so a run
cannot widen what the bot joins.

## Changelog

### 2026-11-07 — A room binding opens nothing, and rooms are no longer linked

**What changed:** `resolve` no longer answers `spawn` (an addressed message
under a room bound to a Space created a Channel there) and its `none` no
longer carries `roomBound`. `linkRoom`, `ExternalRoomLinkRequestSchema` and
`ExternalRoomSpaceMatchRequestSchema` are deleted. WorkspaceDO migration 147
(plan step C-7) deleted every room row (`target_kind = 'space'`) and every
binding to a Thread (`parent_kind = 'workstream'`); the CHECK still admits
both, and no row holds either. A bot joining, leaving or archiving a room now
changes no row.

**Why:** Plan step C-4 of the [Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md):
Spaces and Channels are retired, the Slack ingress already answered every
addressed message with where work starts now, and nothing called the link.
Run-child bindings, the binding that lets a Slack reply continue a Sidekick
run, are unchanged.

**Consequences:** The only bindings are run threads. The room lifecycle events
still arrive and are logged; only `channel_id_changed` still moves rows,
because a run's thread lives under the renumbered room.

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
