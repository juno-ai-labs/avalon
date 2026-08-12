# Slack permissions

This document explains every Slack OAuth scope configured for Avalon and the
product behavior and model tools that use it. Slack's current definitions are
available in the [OAuth scope reference](https://docs.slack.dev/reference/scopes/),
with the installation model described in
[Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)
and the granular search scopes described in the
[Real-time Search API documentation](https://docs.slack.dev/apis/web-api/real-time-search-api/).
The thread-follow-up behavior follows Slack's current
[`message.channels`](https://docs.slack.dev/reference/events/message.channels),
[`message.groups`](https://docs.slack.dev/reference/events/message.groups),
[`thread_broadcast`](https://docs.slack.dev/reference/events/message/thread_broadcast/),
and
[`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/)
contracts. Activation acknowledgement follows Slack's
[`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add/)
contract.

## Permission model

Avalon has two independent Slack authorization paths:

- **Workspace bot installation:** a Slack administrator installs the Avalon app.
  All workspace bot scopes below are required for the in-Slack Agent experience
  and the fixed workspace model-tool bundle. Avalon checks that the installation
  still has the complete set.
- **Personal Slack connection:** an individual connects Slack to Avalon for
  user-attributed tools. These scopes are optional. The **Connect for me** button
  and the Slack account link both request the full personal set, so a member who
  connects from either place grants the same capabilities; only a connection made
  before that convergence carries a narrower grant. A personal token does not necessarily
  contain every supported scope below.

Workspace tools never inherit a member's personal Slack authority. Personal
tools never substitute for a workspace installation when processing Slack
Agent events or delivering workspace-bot messages. An OAuth scope is only the
outer boundary: Avalon also applies workspace membership, identity-linking,
surface-policy, conversation-membership, session, confirmation, and audit
checks.

## Workspace model tools

Model-facing names add the `slack_` prefix to the connector tool names below.
For example, `search_messages` is exposed as `slack_search_messages`.

### Read tools

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

The workspace bot joins current and newly created public channels so mentions
and bounded reads work there. Avalon does not poll channel history or mirror
Slack content. Private channels, DMs, MPIMs, and files remain limited by the
bot's actual Slack membership and visibility.

### Write tools

| Tool | Slack API | Required bot scopes | Behavior |
| --- | --- | --- | --- |
| `send_message` | `chat.postMessage` | `chat:write` | Sends a bot-authored channel or thread message. Avalon supplies a stable `client_msg_id` for retry idempotency. |
| `add_reaction` | `reactions.add` | `reactions:write` | Adds a bot reaction. Slack's `already_reacted` response is treated as a successful retry. |
| `create_conversation` | `conversations.create` or `conversations.open` | `channels:manage`, `groups:write`, `im:write`, `mpim:write` | Creates a public/private channel by name or opens a DM/MPIM for one to eight user IDs. |

These tools use Avalon's normal external-write confirmation, authorization,
audit, and durable-receipt policies. A workspace Slack task can use them without
the initiating member creating a personal Slack connection, but only through
the installation belonging to the same Slack team and Avalon workspace.

## Workspace bot scopes

The production manifest requests these scopes as one administrator-approved
bundle.

| Permission | What Avalon uses it for |
| --- | --- |
| `app_mentions:read` | Receive `app_mention` events when someone invokes `@Avalon` in a channel. |
| `assistant:write` | Update Agent thread status and title and stream Agent output. |
| `channels:history` | Receive public-channel follow-ups in existing Avalon threads, perform bounded explicit-retry recovery, and run authorized channel/thread/context reads. Unrelated public messages are discarded before durable queueing. |
| `channels:join` | Join current and newly created public channels so `@Avalon` is consistently available. |
| `channels:manage` | Create a public channel with workspace `slack_create_conversation`. |
| `channels:read` | Discover public channels, read conversation metadata, maintain bot membership, classify the Slack surface, list visible members, and detect a Slack Connect channel before an unfurl names a work stream. |
| `chat:write` | Post and stream Agent replies, errors, controls, proactive notifications, automation results, and workspace `slack_send_message` output. |
| `commands` | Receive `/avalon` slash commands and Slack global or message shortcuts. |
| `files:read` | Read metadata and bounded textual content for files visible to the bot. |
| `groups:history` | Receive private-channel follow-ups in existing Avalon threads, perform bounded explicit-retry recovery, and run authorized private-channel/thread/context reads. Unrelated private messages are discarded before durable queueing. |
| `groups:read` | Read invited private-channel metadata, list visible members, and detect an externally shared private channel before an unfurl names a work stream. It does not grant access to private channels the bot has not joined. |
| `groups:write` | Create a private channel with workspace `slack_create_conversation`. |
| `im:history` | Receive Agent DM prompts and read accessible DM history. |
| `im:read` | Discover bot-visible direct-message conversations and membership, and read a DM's conversation metadata to tell an ordinary DM from a Slack Connect DM before an unfurl names a work stream. |
| `im:write` | Open an Agent DM for account linking, notifications, automation delivery, or workspace `slack_create_conversation`. |
| `links:read` | Receive `link_shared` events for supported Avalon URLs. |
| `links:write` | Attach a work-stream preview — title, status, last activity, origin — to an eligible Avalon URL with `chat.unfurl`, or an anonymous card where the audience is not known to be internal. |
| `mpim:history` | Read accessible multi-person-DM history and threads. |
| `mpim:read` | Discover accessible multi-person DMs and membership, and read their conversation metadata for the same unfurl audience check. Avalon does not subscribe to ordinary `message.mpim` traffic. |
| `mpim:write` | Open a group DM with workspace `slack_create_conversation`. |
| `reactions:read` | Receive bounded reaction-added and reaction-removed activity for explicitly configured automations. |
| `reactions:write` | Add an emoji reaction with workspace `slack_add_reaction`, and add the host-owned `eyes` reaction to the exact triggering DM or mention after durable admission and authorization but before context gathering or workstream processing. Slack's `already_reacted` response makes retries idempotent; a provider-side acknowledgement failure is logged and does not discard the admitted request. |
| `search:read.files` | Include matching accessible file results in event-scoped workspace search. Direct file content still requires `files:read`. |
| `search:read.public` | Search public-channel context for a user-initiated Slack request. |
| `search:read.users` | Include matching Slack users in event-scoped workspace search. |
| `team.billing:read` | Verify during installation that the Slack workspace is on an eligible paid plan. |
| `users:read` | Resolve Slack users, reject bots or deactivated accounts, read display names and avatars, and resolve notification recipients. |
| `users:read.email` | Search or match user email data. Notification lookup never silently links or authenticates an account. |

The corresponding workspace capability grant stored by Avalon is:

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

Existing workspace installations must reconnect after this expanded permission
set is deployed. Until Slack returns all expected bot scopes, Avalon reports the
installation as reconnect-required. It still offers the tools: the report is a
diagnosis, not a gate, and a call that needs a missing scope fails on Slack's
answer rather than on Avalon's record of it — see [Stored status is a belief, not
a gate](CONNECTORS.md#stored-status-is-a-belief-not-a-gate).

## Personal user scopes

Personal scopes preserve the connected user's own Slack visibility and
attribution. Slack's hosted MCP server or the Slack Web API remains the
enforcement point for what that user can see or do.

| Permission | What Avalon uses it for |
| --- | --- |
| `canvases:read` | Read a Slack canvas with personal `read_canvas`. |
| `canvases:write` | Create or update a canvas with `create_canvas` or `update_canvas`; canvas writes also require `canvases:read`. |
| `channels:history` | Read messages and threads in visible public channels. |
| `channels:read` | Resolve public-channel metadata and list channel members. |
| `channels:write` | Create a public channel as the connected user. |
| `files:read` | Read visible Slack file metadata and content. |
| `groups:history` | Read messages and threads in visible private channels. |
| `groups:read` | Resolve visible private-channel metadata and membership. |
| `groups:write` | Create a private channel as the connected user. |
| `im:history` | Read visible direct-message history. |
| `im:read` | Discover visible direct-message conversations. |
| `im:write` | Open a direct message as the connected user. |
| `mpim:history` | Read visible group-DM history. |
| `mpim:read` | Resolve visible group-DM metadata and membership. |
| `mpim:write` | Open a group DM as the connected user. |
| `reactions:write` | Add an emoji reaction as the connected user. |
| `search:read.files` | Include visible files in search results; file content still requires `files:read`. |
| `search:read.im` | Search visible direct messages. |
| `search:read.mpim` | Search visible group DMs. |
| `search:read.private` | Search visible private channels. |
| `search:read.public` | Search visible public channels. |
| `search:read.users` | Search for visible Slack users. |
| `users:read` | Read user profiles and support channel-member lookup. |
| `users:read.email` | Include email in user-profile data when Slack exposes it. |
| `chat:write` | Send a message or thread reply as the connected user. |

Unlike workspace search, personal search does not use the Slack event
`action_token`; Slack evaluates it against the connected user's granted scopes
and current visibility.

## Related event subscriptions

Event subscriptions are not additional OAuth scopes. The manifest subscribes
to:

| Event | What Avalon uses it for |
| --- | --- |
| `app_context_changed` | Store the user's bounded active-view entity metadata so the next Agent prompt can understand the channel, thread, canvas, or list the user is viewing. |
| `app_home_opened` | Publish the linked, unlinked, or administrator App Home view. |
| `app_mention` | Start or continue a channel task when a user explicitly mentions Avalon. |
| `app_uninstalled` | Mark the workspace installation disconnected and stop routing work to it. |
| `channel_created` | Join a newly created public channel. |
| `link_shared` | Produce authorized previews for supported Avalon links. |
| `file_shared` | Offer bounded file-share activity to explicitly configured automations. |
| `member_joined_channel` | Trigger explicitly configured channel-membership automations. |
| `member_left_channel` | Trigger explicitly configured channel-membership automations. |
| `message.channels` | Continue an Avalon-owned public thread or offer bounded message activity to an explicitly configured automation; unmatched messages are discarded before durable queueing. |
| `message.groups` | Continue an Avalon-owned invited-private-channel thread or offer bounded activity to an authorized personal automation; unmatched messages are discarded before durable queueing. |
| `message.im` | Receive Agent prompts and follow-ups, or offer bounded DM activity to an authorized personal automation. |
| `reaction_added` | Offer bounded emoji-reaction activity to explicitly configured automations. |
| `reaction_removed` | Offer bounded emoji-reaction removal activity to explicitly configured automations. |
| `tokens_revoked` | Mark affected credentials unhealthy and require reconnection. |

Avalon intentionally does not subscribe to `message.mpim` or broad file lifecycle events. `file_shared` carries only bounded trigger evidence; it does not import file content.

## Event data and model context

A Slack-originated task receives this source provenance in its system prompt:

- Slack team/workspace ID;
- channel ID and, when Slack provides it, channel name;
- thread timestamp;
- invocation type and channel type;
- the matched Avalon member ID when a confirmed link exists;
- bounded active-view entity metadata supplied by Slack; and
- attachment metadata from the triggering interaction.

Avalon does not durably copy surrounding Slack messages. Active-view and
attachment metadata are labeled as untrusted evidence, not system instructions.
The short-lived search `action_token` is hidden runtime
authorization: it is never placed in the system prompt, workstream transcript,
model tool arguments, tool output, or inference-payload logs. Search results are
transient model context and are excluded from durable tool-result replay.

## Source of truth and maintenance

The checked-in manifest is
[`config/provider-apps/slack.json`](../config/provider-apps/slack.json). Runtime
bot-scope health checks and capability mappings are in
[`packages/connectors/src/slack.ts`](../packages/connectors/src/slack.ts).
Lifecycle and data handling are described in
[`docs/SLACK_INTEGRATION.md`](SLACK_INTEGRATION.md).

When adding, removing, or repurposing a Slack scope:

1. update the manifest and runtime scope/capability declarations together;
2. update this document and the integration data-flow description;
3. add or update tests that keep the manifest and runtime declarations aligned;
4. determine whether existing workspace installations or personal connections
   must complete OAuth again for the changed grant.
