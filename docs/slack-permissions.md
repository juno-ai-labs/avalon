# Slack permissions

Every Slack OAuth scope Rally configures, and the product behavior and model tool
that uses it. Rally has two independent authorization paths — an
administrator-approved workspace bot installation and an optional per-person
connection — and **neither ever stands in for the other**. This document is the
inventory that keeps those two grants honest against the checked-in manifest.

Read it before adding, removing, or repurposing a scope. Slack's own definitions
are in the [OAuth scope reference](https://docs.slack.dev/reference/scopes/), with
the installation model in
[Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)
and the granular search scopes in the
[Real-time Search API documentation](https://docs.slack.dev/apis/web-api/real-time-search-api/).
Following up in a Sidekick run's Slack thread follows Slack's
[`message.channels`](https://docs.slack.dev/reference/events/message.channels),
[`message.groups`](https://docs.slack.dev/reference/events/message.groups),
[`thread_broadcast`](https://docs.slack.dev/reference/events/message/thread_broadcast/),
and
[`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/)
contracts; activation acknowledgement follows
[`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add/).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| [`config/provider-apps/slack.json`](../config/provider-apps/slack.json) | The checked-in manifest — the scopes and event subscriptions that are actually registered. |
| [`packages/connectors/src/slack.ts`](../packages/connectors/src/slack.ts) | Runtime bot-scope health checks, the capability mapping, and every tool's required scopes. |
| `apps/api/src/services/slack-agent-service.ts` | The Agent surface, tool execution, and the event-scoped search token. |
| `apps/api/src/routes/slack.ts` | The ingress the subscribed events arrive at. |

### The permission model

- **Workspace bot installation** — a Slack administrator installs the Rally app.
  All workspace bot scopes below are required for the in-Slack Agent experience and
  the fixed workspace model-tool bundle, and Rally checks that the installation
  still has the complete set.
- **Personal Slack connection** — an individual connects Slack to Rally for
  user-attributed tools. These scopes are optional. The **Connect only for me** button
  and the Slack account link both request the full personal set, so a member who
  connects from either place grants the same capabilities; only a connection made
  before that convergence carries a narrower grant. A personal token does not
  necessarily contain every supported scope below.

An OAuth scope is only the outer boundary. Rally also applies workspace
membership, identity-linking, surface-policy, conversation-membership, session,
confirmation, and audit checks.

### Workspace model tools

Model-facing names add the `slack_` prefix to the connector tool names below. For
example, `search_messages` is exposed as `slack_search_messages`.

**Read tools**

| Tool | Slack API | Required bot scopes | Workspace boundary |
| --- | --- | --- | --- |
| `search` | `assistant.search.context` | `search:read.public`, `search:read.files`, `search:read.users` | Requires the hidden `action_token` from a user-initiated Slack message or app mention and searches public channels only. |
| `search_messages` | `assistant.search.context` | `search:read.public` | Has the same event-scoped token and public-channel restriction; supports bounded channel, author, time, and sort filters. |
| `find_users` | `users.list` | `users:read`, `users:read.email` | Searches the Slack directory visible to the app, reads at most five pages, and returns at most 200 matches. |
| `read_user_profile` | `users.info` | `users:read`, `users:read.email` | Reads one visible Slack user profile. |
| `find_channels` | `conversations.list` | `channels:read`, `groups:read`, `im:read`, `mpim:read` | Returns only conversations visible to the bot. |
| `list_channel_members` | `conversations.members` | `channels:read`, `groups:read`, `im:read`, `mpim:read` | Lists a bounded page of members for a visible conversation. |
| `read_channel` | `conversations.history` | `channels:history`, `groups:history`, `im:history`, `mpim:history` | Reads at most 100 messages per call from a conversation the bot can access. |
| `read_thread` | `conversations.replies` | `channels:history`, `groups:history`, `im:history`, `mpim:history` | Reads at most 100 messages per call from an accessible thread. |
| `read_message_context` | `conversations.history` or `conversations.replies` | `channels:history`, `groups:history`, `im:history`, `mpim:history` | Reads only a bounded window: at most 50 messages before and 50 after the requested timestamp. |
| `read_file` | `files.info` plus an authenticated private-file download | `files:read` | Returns metadata for an accessible file. Text files are downloaded only from trusted Slack HTTPS hosts and only up to 512 KiB; binary or larger content is omitted. |

The workspace bot is in a conversation because somebody invited it (which links
the room to nothing since Spaces and Threads were retired) or because a Sidekick's Slack source names that public
channel and Rally joined it for the source. It does not join public channels on
its own. Rally does not poll channel history or mirror Slack content. See
[`external-conversation-bindings.md`](external-conversation-bindings.md). Private channels, DMs, MPIMs, and files remain limited by the bot's actual
Slack membership and visibility.

**Write tools**

| Tool | Slack API | Required bot scopes | Behavior |
| --- | --- | --- | --- |
| `send_message` | `chat.postMessage` | `chat:write` | Sends a bot-authored channel or thread message. Rally supplies a stable `client_msg_id` for retry idempotency. |
| `add_reaction` | `reactions.add` | `reactions:write` | Adds a bot reaction. Slack's `already_reacted` response is treated as a successful retry. |
| `create_conversation` | `conversations.create` or `conversations.open` | `channels:manage`, `groups:write`, `im:write`, `mpim:write` | Accepts exactly one of a channel name or one to eight user IDs, then creates a public/private channel or opens a DM/MPIM. |

These tools use Rally's normal external-write execution, authorization, audit,
and durable-receipt policies. A workspace Slack task can use them without the
initiating member creating a personal Slack connection, but only through the
installation belonging to the same Slack team and Rally workspace.

### Workspace bot scopes

The production manifest requests these scopes as one administrator-approved bundle.

| Permission | What Rally uses it for |
| --- | --- |
| `app_mentions:read` | Receive `app_mention` events when someone invokes `@Rally` in a channel. |
| `assistant:write` | Update Agent thread status and title and stream Agent output. |
| `channels:history` | Receive public-channel replies in Sidekick runs' bound threads, and run authorized channel/thread/context reads. Unrelated public messages are discarded before durable queueing. |
| `channels:join` | Join the public channels a saved Sidekick's Slack source names, so the Sidekick receives their events. Such a join links nothing. |
| `channels:manage` | Create a public channel with workspace `slack_create_conversation`. |
| `channels:read` | Discover public channels, read conversation metadata, maintain bot membership, classify the Slack surface, list visible members, and detect a Slack Connect channel before an unfurl names a Canvas or Sidekick. |
| `chat:write` | Post and stream Agent replies, errors, controls, proactive notifications, automation results, and workspace `slack_send_message` output. |
| `commands` | Receive `/rally` slash commands and Slack global or message shortcuts. |
| `files:read` | Read metadata and bounded textual content for files visible to the bot. |
| `groups:history` | Receive private-channel replies in Sidekick runs' bound threads, and run authorized private-channel/thread/context reads. Unrelated private messages are discarded before durable queueing. |
| `groups:read` | Read invited private-channel metadata, list visible members, and detect an externally shared private channel before an unfurl names a Canvas or Sidekick. It does not grant access to private channels the bot has not joined. |
| `groups:write` | Create a private channel with workspace `slack_create_conversation`. |
| `im:history` | Receive Agent DM prompts and read accessible DM history. |
| `im:read` | Discover bot-visible direct-message conversations and membership, and read a DM's conversation metadata to tell an ordinary DM from a Slack Connect DM before an unfurl names a Canvas or Sidekick. |
| `im:write` | Open an Agent DM for account linking, notifications, automation delivery, or workspace `slack_create_conversation`. |
| `links:read` | Receive `link_shared` events for supported Rally URLs. Slack's own permalink for a thread Rally was summoned in is read with `chat.getPermalink`, which needs no scope of its own beyond the bot's access to that conversation. |
| `links:write` | Attach a Canvas or Sidekick preview naming it to an eligible Rally URL with `chat.unfurl`, or an anonymous card where the audience is not known to be internal. |
| `mpim:history` | Read accessible multi-person-DM history and threads. |
| `mpim:read` | Discover accessible multi-person DMs and membership, and read their conversation metadata for the same unfurl audience check. Replies in group DMs arrive through `message.mpim`, routed like any other message by their binding. |
| `mpim:write` | Open a group DM with workspace `slack_create_conversation`. |
| `reactions:read` | Receive bounded reaction-added and reaction-removed activity for explicitly configured automations. |
| `reactions:write` | Add an emoji reaction with workspace `slack_add_reaction`, and add the host-owned `eyes` reaction to the exact triggering DM or mention after durable admission and authorization but before context gathering or workstream processing. Slack's `already_reacted` response makes retries idempotent; a provider-side acknowledgement failure is logged and does not discard the admitted request. |
| `search:read.files` | Include matching accessible file results in event-scoped workspace search. Direct file content still requires `files:read`. |
| `search:read.public` | Search public-channel context for a user-initiated Slack request. |
| `search:read.users` | Include matching Slack users in event-scoped workspace search. |
| `team.billing:read` | Verify during installation that the Slack workspace is on an eligible paid plan. |
| `users:read` | Resolve Slack users, reject bots or deactivated accounts, read display names and avatars, and resolve notification recipients. |
| `users:read.email` | Search or match user email data. Notification lookup never silently links or authenticates an account. |

The corresponding workspace capability grant stored by Rally is:

```text
slack.search
slack.messages.read
slack.files.read
slack.users.read
slack.messages.write
slack.conversations.write
slack.reactions.write
slack.agent
slack.notifications.write
```

### Personal user scopes

Personal scopes preserve the connected user's own Slack visibility and attribution.
Rally requests them as the provider scope set behind one
`slack.personal.mcp` capability. Slack's hosted MCP server remains authoritative
for which live tools exist and which of these scopes each operation needs;
Rally does not maintain a tool-to-scope snapshot for that server.

| Permission | What Rally uses it for |
| --- | --- |
| `canvases:read` | Permit the hosted user-tool plane to read visible canvases. |
| `canvases:write` | Permit the hosted user-tool plane to create or update canvases. |
| `channels:history` | Read messages and threads in visible public channels. |
| `channels:read` | Resolve public-channel metadata and list channel members. |
| `channels:write` | Permit public-channel actions as the connected user. |
| `files:read` | Read visible Slack file metadata and content. |
| `groups:history` | Read messages and threads in visible private channels. |
| `groups:read` | Resolve visible private-channel metadata and membership. |
| `groups:write` | Permit private-channel actions as the connected user. |
| `im:history` | Read visible direct-message history. |
| `im:read` | Discover visible direct-message conversations. |
| `im:write` | Permit direct-message actions as the connected user. |
| `mpim:history` | Read visible group-DM history. |
| `mpim:read` | Resolve visible group-DM metadata and membership. |
| `mpim:write` | Permit group-DM actions as the connected user. |
| `reactions:write` | Add an emoji reaction as the connected user. |
| `search:read.files` | Include visible files in search results; file content still requires `files:read`. |
| `search:read.im` | Search visible direct messages. |
| `search:read.mpim` | Search visible group DMs. |
| `search:read.private` | Search visible private channels. |
| `search:read.public` | Search visible public channels. |
| `search:read.users` | Search for visible Slack users. |
| `users:read` | Read user profiles and support channel-member lookup. |
| `users:read.email` | Include email in user-profile data when Slack exposes it. |
| `chat:write` | Permit message actions as the connected user. |

Unlike workspace search, personal search does not use the Slack event
`action_token`; Slack evaluates it against the connected user's granted scopes and
current visibility.

### Related event subscriptions

Event subscriptions are not additional OAuth scopes. The manifest subscribes to:

| Event | What Rally uses it for |
| --- | --- |
| `app_context_changed` | Store the user's bounded active-view entity metadata so the next Agent prompt can understand the channel, thread, canvas, or list the user is viewing. |
| `app_home_opened` | Publish the linked, unlinked, or administrator App Home view. |
| `app_mention` | Start or continue a channel task when a user explicitly mentions Rally. |
| `app_uninstalled` | Mark the workspace installation disconnected and stop routing work to it. |
| `channel_archive` | Suspend the archived room's binding (`provider_room_archived`); a re-invitation or a mention brings it back. |
| `channel_created` | Offer bounded channel-creation activity to explicitly configured automations. Rally does not join the channel. |
| `channel_id_changed` | Move a Slack Connect room's bindings to its new id. |
| `channel_left` | Suspend the room's binding when the bot is removed (`provider_membership_ended`). |
| `link_shared` | Produce authorized previews for supported Rally links. |
| `file_shared` | Offer bounded file-share activity to explicitly configured automations. |
| `group_archive` | As `channel_archive`, for a private channel. |
| `group_left` | As `channel_left`, for a private channel. |
| `member_joined_channel` | The bot's own join is an invitation, logged `slack_room_invitation` and linking nothing; anyone else's triggers explicitly configured channel-membership automations. |
| `member_left_channel` | The bot's own leave suspends the room's binding; anyone else's triggers explicitly configured channel-membership automations. |
| `message.channels` | Continue a Sidekick run's bound public thread or offer bounded message activity to an explicitly configured automation; unmatched messages are discarded before durable queueing. |
| `message.groups` | Continue a Sidekick run's bound private-channel thread or offer bounded activity to an authorized personal automation; unmatched messages are discarded before durable queueing. |
| `message.im` | Receive replies in a Sidekick run's bound DM thread (an unbound DM is answered that Slack starts no work), or offer bounded DM activity to an authorized personal automation. |
| `message.mpim` | Continue a bound group-DM thread, or offer bounded activity to an explicitly configured automation; unmatched messages are discarded before durable queueing. |
| `reaction_added` | Offer bounded emoji-reaction activity to explicitly configured automations. |
| `reaction_removed` | Offer bounded emoji-reaction removal activity to explicitly configured automations. |
| `tokens_revoked` | Mark affected credentials unhealthy and require reconnection. |

Rally intentionally does not subscribe to broad file lifecycle events. `file_shared` carries only bounded trigger evidence; it does not import file
content.

### Event data and model context

A Slack-originated task receives this source provenance in its system prompt:

- Slack team/workspace ID;
- channel ID and, when Slack provides it, channel name;
- thread timestamp;
- invocation type and channel type;
- the matched Rally member ID when a confirmed link exists;
- bounded active-view entity metadata supplied by Slack; and
- attachment metadata from the triggering interaction.

## Invariants

- **Workspace tools never inherit a member's personal Slack authority**, and
  personal tools never substitute for a workspace installation when processing Slack
  Agent events or delivering workspace-bot messages. These are two grants, not one
  with two sources.
- **A workspace write goes only through the installation belonging to the same
  Slack team and Rally workspace.**
- **A scope is the outer boundary, never the authorization.** Membership,
  identity-linking, surface policy, conversation membership, session, confirmation,
  and audit checks all still apply.
- **The manifest and the runtime scope and capability declarations change
  together.** A scope requested but not declared is a permission nobody can explain;
  a scope declared but not requested is a tool that fails at Slack.
- **Rally does not durably copy surrounding Slack messages.** Reads are bounded and
  transient; there is no mirror.
- **Active-view and attachment metadata are labeled as untrusted evidence, not
  system instructions.**
- **Notification lookup never silently links or authenticates an account**, even
  though `users:read.email` makes the match possible.
- **`groups:read` does not grant access to private channels the bot has not
  joined.** Membership is Slack's to enforce and Rally does not work around it.

## Boundary

This document owns the scope inventory and what each scope buys. It does not own
the Slack product surface, the ingress, or the registration:

| For | Read |
| --- | --- |
| Lifecycle, data handling, App Home, user linking, acceptance | [`slack-integration.md`](slack-integration.md) |
| The registration itself and its regional routing | [`provider-apps.md`](provider-apps.md) |
| The unfurl card and its audience rules | [`links.md`](links.md) |
| Connector scope kinds, capabilities, and health semantics | [`connectors.md`](connectors.md) |
| Why a stored status is not a gate | [`connectors.md`](connectors.md#stored-status-is-a-belief-not-a-gate) |

### Changing a scope

1. Update the manifest and the runtime scope and capability declarations together.
2. Update this document and the integration data-flow description in
   [`slack-integration.md`](slack-integration.md).
3. Add or update tests that keep the manifest and runtime declarations aligned.
4. Determine whether existing workspace installations or personal connections must
   complete OAuth again for the changed grant.

## Failure modes and limits

- **Existing workspace installations must reconnect after an expanded permission
  set is deployed.** Until Slack returns all expected bot scopes, Rally reports the
  installation as reconnect-required. **It still offers the tools**: the report is a
  diagnosis, not a gate, and a call that needs a missing scope fails on Slack's
  answer rather than on Rally's record of it.
- **A personal token may be missing scopes this document lists.** Connections made
  before **Connect only for me** and the account link converged on the full set carry a
  narrower grant, and the tool fails at Slack rather than being hidden.
- **A provider-side acknowledgement failure does not discard an admitted request.**
  The `eyes` reaction is logged when it fails; the work still runs.
- **Read bounds are hard**: 100 messages per `read_channel` or `read_thread` call,
  a 50-before/50-after window for `read_message_context`, five pages and 200 matches
  for `find_users`, one to eight user IDs for a DM or MPIM, and 512 KiB of text for
  `read_file` — binary or larger content is omitted rather than truncated.
- **Workspace search needs the event-scoped `action_token`** and is therefore only
  available on a user-initiated message or app mention, and only over public
  channels.

## Testing

`apps/api/test/slack-agent-ingress.test.ts` reads
`config/provider-apps/slack.json` directly and is the suite that keeps the manifest
and the runtime declarations from drifting. `packages/connectors/src/slack.test.ts`
covers the capability mapping and each tool's declared scopes, and
`apps/api/test/slack-connection-health.test.ts` covers the reconnect-required
diagnosis and that it does not gate.

Run one with
`pnpm --filter @rally/api exec vitest run test/slack-agent-ingress.test.ts` — the
path is package-relative.

`slack manifest validate` reads the same manifest through the checked-in `.slack`
hook, and is what catches a scope Slack itself rejects. Nothing in Vitest can tell
you that a scope was actually granted; only the acceptance flows in
[`e2e.md`](e2e.md) can.

## Security and trust model

The short-lived search `action_token` is **hidden runtime authorization**: it is
never placed in the system prompt, the conversation transcript, model tool arguments,
tool output, or inference-payload logs. Search results are transient model context
and are excluded from durable tool-result replay.

Everything Slack supplies — active-view metadata, attachment metadata, message
content — is untrusted evidence. [`security.md`](security.md) owns the boundary this
sits inside.

## Changelog

This document predates the changelog rule in
[`module-documents.md`](module-documents.md#starting-one), and the reasoning behind
the scope selection — beyond the per-scope justifications above, which are the point
of the document — was not recorded as dated entries and was not reconstructed.

### 2026-08-12 — Personal scopes authorize a live MCP plane, not guessed tools

**What changed:** The full personal Slack scope set now maps to one
`slack.personal.mcp` Rally capability. The inventory describes the provider
features each scope permits without claiming a fixed MCP tool name.

**Why:** Slack owns and can change its hosted MCP tools independently. Mapping
scopes to a snapshot of observed tool names made this document and the runtime
look authoritative when neither was.

**Considered and rejected:** Removing the scope inventory together with the
tool mapping. OAuth and Marketplace review still need an exact justification
for every requested permission even though the remote tool catalog is dynamic.

**Consequences:** A scope addition still requires review here, in code, and at
Slack. A tool addition on Slack's server does not require a Rally change unless
it needs a provider OAuth scope Rally has not requested. Remote annotations do
not relax confirmation or receipt policy; every live MCP operation is treated as
a write until Rally has an independent trusted classifier.

Shipped in the pull request for this change.
