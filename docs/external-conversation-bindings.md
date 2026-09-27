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
| `apps/api/src/durable-objects/workspace-external-binding-storage.ts` | `ExternalConversationBindingStorage`, the only code that reads or writes `external_conversation_bindings`, and migration 80 (`EXTERNAL_CONVERSATION_BINDINGS_MIGRATION`). `externalPathKey` builds every stored key. |
| `apps/api/src/durable-objects/workspace-do.ts` | The binding RPCs (`resolveExternalConversation`, `linkExternalRoom`, `recordOutboundExternalConversationBinding`, `suspend…`, `reactivate…`, `close…`, `move…`, `latestOutboundExternalConversation`), the thread claim inside `reserveChannelInSpaces`, Sidekick deletion suspending its bindings, bound events claimed in `matchExternalEventDestinations`, and the Sidekick-source join job in `applyExternalEventRegistrations`. |
| `apps/api/src/durable-objects/external-binding-outbox.ts` | The SubstreamAgent `durable_outbox` channel `external_conversation_binding_v1` that carries a run's outbound binding from its tool receipt to WorkspaceDO. |
| `apps/api/src/durable-objects/workstream-tool-receipt-storage.ts` | `complete` enqueues the outbound binding in the receipt's own transaction. |
| `apps/api/src/services/slack-agent-service.ts` | Slack ingress: `resolveBinding`, the lifecycle events, `linkRoom`, delivery to a run child, the one-to-one DM thread prompt, and the Sidekick-source join. |
| `apps/api/src/services/workstream-object-creation-service.ts`, `slack-workspace-workstream-service.ts` | Channel creation that carries a thread claim (`externalBinding`), activates it after the creation receipt, and releases it on failure. |
| `packages/connectors/src/slack.ts` | `slackInstallationId`, `slackMessagePath`, `slackExternalRoom`, and `send_message` returning `externalConversation`. |
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
prefix and a descendant range is a text range.

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

### Rooms

The bot being added to a room is the invitation. `member_joined_channel` for
the bot's own user calls `linkRoom`, which resolves the room with
`conversations.info`, asks `admitSpaceCreation` before claiming a parent anchor,
and calls `linkExternalRoom`. That one WorkspaceDO transaction writes the Space
and the active room binding together. A public room makes a public Space. A
private channel or group DM makes a private Space whose audience is the room's
members that Rally can map, seated through the existing roster rules. A mention
in a room that has no binding runs the same step first (`fall_through` mode), so
an app installed before this change still links rooms on first use. A
redelivered or racing invitation finds the existing binding and returns
`existing`; a re-invitation after removal returns `reactivated`.

There is no pending state for a room: a Space no longer provisions anything
asynchronously, so the binding and the Space commit or fail together.

### Threads

A `spawn` resolution creates the Channel through `reserveChannelInSpaces` with
an `externalBinding` claim. The claim is written `pending` in the same
transaction that reserves the Channel, so a second message in the same thread
resolves to `hold` rather than creating a second Channel. After the creation
receipt completes, the binding is activated; if creation fails, it is
released. A sender with no linked Rally account creates the Channel acting as
the Space's creator (`createdByUserId`), so it lands in the Space without
widening it; if the Space has no creator to act as, the message is refused
with `external_room_space_actor_missing`.

An Agent session started any other way (a DM, a mention that falls through)
writes its thread binding with `recordOutbound` inside
`createWorkspaceSlackSession`, and throws if the thread is already bound
elsewhere. `slackThreadRoutable`, which decides whether an unaddressed reply is
worth an ingress job, is answered by resolution plus pending prompts; the
session row is delivery state, not routing.

### Sidekick runs

When a Sidekick run posts with the workspace bot token, `send_message` returns
`externalConversation: {installationId, path}` on its tool result. The connector
seam carries it through `HarnessToolResult` to the host, which binds only when
the call belongs to a run child (`automationRun`, parent kind `automation`,
substream not `"0"`). The binding is enqueued on the run child's
`durable_outbox` inside the tool receipt's `complete` transaction, so a binding
exists if and only if the receipt says the send happened. The alarm drains it to
`recordOutboundExternalConversationBinding`, where the **first binding wins**: a
thread already bound to another conversation stays with it.

A reply in that thread resolves to `deliver` with the run child as target. The
ingress admits it through `externalBindingReplyAdmission` to the run child's
`admitExternalMessage` as an external message with the Slack actor. The run
child frames it as evidence from that sender, and a wake of a run child calls
`SidekickDO.continueRun`. The reply runs with the run's authority, not the
sender's.

### One-to-one DMs

A top-level message in a bot DM that holds at least one active outbound binding
is answered once, in a thread on that message, asking the person to reply in
the request's thread, with a permalink to the most recent one
(`latestOutboundExternalConversation`). It creates no Rally work. The prompt's
`client_msg_id` is derived from the ingress claim key, so a retried job posts
it once.

### Lifecycle

| Event | Effect |
| --- | --- |
| Bot `member_joined_channel` | Link or reactivate the room. |
| Bot `member_left_channel`, `channel_left`, `group_left` | Suspend the room: `provider_membership_ended`. |
| `channel_archive`, `group_archive` | Suspend the room: `provider_room_archived`. Unarchive does not reactivate; a re-invitation does. |
| `channel_id_changed` | Move the room's binding and every descendant to the new id, or refuse on a conflict. |
| Workspace disconnect, uninstall, token revocation | Suspend the installation: `connection_disconnected`. Reconnecting reactivates exactly those. |
| Sidekick deleted | Suspend every binding targeting its runs: `sidekick_deleted`. |
| `closeExternalConversationBinding` | Suspend one binding: `closed`. |

A suspended room suspends its threads through resolution rather than by
rewriting them.

### Sidekick Slack sources

Saving a Sidekick whose Slack source names channels queues a
`rally_sidekick_source_join` ingress job from
`applyExternalEventRegistrations`. The job joins the bot to those conversations
so their events arrive. It links no Space: a join a Sidekick needs is not an
invitation. The public-channel join sweep and the `channel_created` join are
gone; the bot is in a room because somebody put it there or a Sidekick needs it.

### Claimed events

`matchExternalEventDestinations` counts an event whose
`metadata.externalConversationPath` resolves to a binding as claimed, even with
no automation delivery, so a bound reply never also becomes Suggested Work.

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
  reconnect or re-invitation restores the same routing. `reactivate` touches
  only `connection_disconnected`; a person's `closed` or a deletion stays.
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
(`SidekickDO.continueRun` does). The `slack_thread` origin resource on a Channel
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
  WorkspaceDO accepts. A reply that arrives before the drain resolves `none`
  and takes the Agent path.
- **`channel_id_changed` onto an occupied id.** The move is refused and logged
  `slack_room_id_changed` with `outcome: conflict`; the old bindings stay.
- **Large private rooms.** Participants past the existing roster threshold are
  not seated in the Space; they are seated by their own message.

No new numeric limit is introduced.

## Testing

| Suite | What it proves |
| --- | --- |
| `apps/api/test-workers/external-conversation-bindings.test.ts` | On real workerd: link races and redelivery, private vs public Space, removal and re-invitation, two threads in one room, pending hold and resume, failed creation releasing its claim, claim refused on a bound thread, non-threadable rooms, blocked private placement, Sidekick deletion, disconnect/reconnect against a closed binding, `channel_id_changed` move and conflict, outbound first-wins, the latest outbound in a DM, a run send bound only after its receipt commits and the alarm drains, a lost receipt and a personal send writing nothing, a bound reply landing in the run child with its external actor, a bound event claimed, and the Sidekick-source join. |
| `apps/api/test/external-conversation-binding-migration.test.ts` | Migration 80 carries each session's exact thread key and nothing else. |
| `apps/api/test/slack-workspace-assignment.test.ts` ("routed by external conversation bindings") | The ingress: delivery to a run child, the DM prompt and its retry, a plain DM keeping Agent behavior, the source join, a suspended reply creating nothing. |
| `apps/api/test-workers/workspace-slack-ingress.test.ts` | `slackThreadRoutable` answered from bindings. |
| `packages/connectors/src/slack.test.ts` | Path and room classification, and `send_message` returning a binding only for the workspace installation. |

The workers suite clears `external_conversation_bindings` in `beforeEach`; a
test that seeds a Slack connection must seed `connector_connections` itself,
because that D1 starts empty. The migration test seeds `workspace_identity`, or
the object refuses the database as another workspace's.

## Data model

`external_conversation_bindings` (WorkspaceDO, migration 80): `installation_id`,
`path_json`, `target_kind` (`space` | `conversation`), `space_id` or
(`parent_kind`, `parent_id`, `substream_id`), `state` (`pending` | `active` |
`suspended`), `suspended_reason`, `claim_key`, timestamps. CHECKs tie a target
kind to its columns, a suspended state to a reason, and a pending state to a
claim key. A partial index on the conversation target serves suspending one
Sidekick's bindings.

## Security and trust model

Room names, member lists, message text and actor profiles are untrusted. A
Slack member is not a Rally member: a private Space is seated only with members
Rally maps, and a Space is never widened to make placement succeed. A reply
delivered to a run child is framed to the model as evidence from its sender,
not as a member request. Only a Sidekick's config conversation can add a Slack
source, so a run cannot widen what the bot joins.

## Changelog

### 2026-09-27: Slack routing moves from session rows to bindings

**What changed:** Added `external_conversation_bindings` (migration 80), which
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

**Consequences:** Authority follows the run, not the sender, for a bound reply
to a Sidekick run. Unarchiving a room does not reactivate it; a re-invitation
does. There is no UI to close a binding, only the RPC. A reply that beats the
outbound drain takes the Agent path.

Design: `docs/PRDs/2026-09-23_external-conversation-bindings/`.
