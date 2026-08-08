# Slack permissions

This document explains every Slack OAuth scope configured for Avalon and the
product behavior that uses it. Slack's current definitions are available in the
[OAuth scope reference](https://docs.slack.dev/reference/scopes/), with the
installation model described in
[Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)
and the granular search scopes described in the
[Real-time Search API documentation](https://docs.slack.dev/apis/web-api/real-time-search-api/).
The thread-follow-up behavior specifically follows Slack's current
[`message.channels`](https://docs.slack.dev/reference/events/message.channels),
[`message.groups`](https://docs.slack.dev/reference/events/message.groups),
[`thread_broadcast`](https://docs.slack.dev/reference/events/message/thread_broadcast/),
and
[`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/)
contracts.

## Permission model

Avalon has two independent Slack authorization paths:

- **Workspace bot installation:** a Slack administrator installs the Avalon app.
  All workspace bot scopes below are required for the in-Slack Agent experience,
  and Avalon checks that the installation still has the complete set.
- **Personal Slack connection:** an individual connects Slack to Avalon for
  user-attributed MCP tools. These scopes are optional and requested
  incrementally for the capabilities the user enables. The table lists the
  app's complete supported scope set; a personal token does not necessarily
  contain every scope in the table.

An OAuth scope sets the outer boundary of what Slack permits. Avalon still
applies its own workspace membership, identity-linking, surface-policy,
conversation-membership, session, and write-confirmation checks.

## Workspace bot scopes

| Permission | What Avalon uses it for |
| --- | --- |
| `app_mentions:read` | Receive `app_mention` events when someone invokes `@Avalon` in a channel. |
| `assistant:write` | Operate as a Slack Agent and update Agent thread status and title with `assistant.threads.setStatus` and `assistant.threads.setTitle`. |
| `channels:join` | Join current and newly created public channels so `@Avalon` is consistently available. |
| `channels:history` | Receive public-channel thread replies, including broadcast replies, through `message.channels` and, for a recent denied thread, make one bounded `conversations.replies` lookup to recover the original request after the user explicitly retries. Unrelated public-channel messages are discarded before durable queueing. |
| `channels:read` | Discover public channels, read conversation metadata, maintain bot membership, and classify the Slack surface before applying policy. |
| `chat:write` | Post and stream Agent replies, errors, controls, proactive notifications, and automation results as Avalon. |
| `commands` | Receive `/avalon` slash commands and Slack global or message shortcuts. |
| `groups:history` | Receive private-channel replies in existing Avalon-owned threads through `message.groups` and support the same bounded explicit-retry recovery used for public channels. Unrelated private-channel messages are discarded before durable queueing. |
| `groups:read` | Read private-channel metadata needed to classify the surface and enforce the workspace's private-channel policy. This does not give the bot access to private channels it has not been invited to. |
| `im:history` | Receive messages and thread replies sent to Avalon in its Agent DM through `message.im`. |
| `im:write` | Open an App Agent DM with `conversations.open` for account linking, person-mention notifications, and automation delivery. |
| `links:read` | Receive `link_shared` events for supported Avalon URLs. |
| `links:write` | Attach a privacy-safe preview to an eligible Avalon URL with `chat.unfurl`. |
| `mpim:read` | Read multi-person-DM metadata needed for shortcut context and surface-policy classification. Avalon does not subscribe to ordinary `message.mpim` traffic. |
| `search:read.files` | Let a Slack-originated Agent request include matching file results in its immediate `assistant.search.context` lookup. The lookup uses Slack's short-lived action token; it is not a background index. |
| `search:read.public` | Search public-channel context for the current Slack-originated Agent request with `assistant.search.context`. |
| `search:read.users` | Include matching Slack users in the current request's `assistant.search.context` results. |
| `team.billing:read` | Call `team.billing.info` during installation to verify that the Slack workspace is on an eligible paid plan. |
| `users:read` | Resolve Slack users with `users.info` and `users.lookupByEmail`, reject bots or deactivated accounts, display names and avatars, and resolve notification recipients. |
| `users:read.email` | Match an active Avalon member's verified login email to exactly one Slack user for notification routing. This lookup never silently links or authenticates an account. |

## Personal user scopes

Personal scopes preserve the connected user's own Slack visibility and
attribution. Slack's hosted MCP server remains the enforcement point for what
that user can see or do in Slack.

| Permission | What Avalon uses it for |
| --- | --- |
| `canvases:read` | Read a Slack canvas with the personal `read_canvas` tool. |
| `canvases:write` | Create or update a Slack canvas with `create_canvas` or `update_canvas`. Canvas writes also require `canvases:read`. |
| `channels:history` | Read messages and threads in public channels visible to the connected user with `read_channel` and `read_thread`. |
| `channels:read` | Resolve public-channel metadata and list channel members for personal Slack tools. |
| `channels:write` | Create a public channel as the connected user with `create_conversation`. |
| `files:read` | Read Slack file metadata and content with `read_file`. Search result metadata alone does not grant file-content access. |
| `groups:history` | Read messages and threads in private channels visible to the connected user. |
| `groups:read` | Resolve private-channel metadata and membership visible to the connected user. |
| `groups:write` | Create a private channel as the connected user with `create_conversation`. |
| `im:history` | Read direct-message history visible to the connected user. |
| `im:write` | Open a direct message as the connected user with `create_conversation`. |
| `mpim:history` | Read group-DM history visible to the connected user. |
| `mpim:read` | Resolve group-DM metadata and membership visible to the connected user. |
| `mpim:write` | Open a group DM as the connected user with `create_conversation`. |
| `reactions:write` | Add an emoji reaction as the connected user with `add_reaction`. |
| `search:read.files` | Include files in personal Slack search results. Directly opening file content still requires `files:read`. |
| `search:read.im` | Search direct messages visible to the connected user. |
| `search:read.mpim` | Search group DMs visible to the connected user. |
| `search:read.private` | Search private channels visible to the connected user. |
| `search:read.public` | Search public channels visible to the connected user. |
| `search:read.users` | Search for Slack users visible to the connected user. |
| `users:read` | Read user profiles and support channel-member lookup for personal Slack tools. |
| `users:read.email` | Include email in user-profile data when Slack exposes it to the connected user. |
| `chat:write` | Send a message or thread reply as the connected user with `send_message`. |

## Related event subscriptions

Event subscriptions are not additional OAuth scopes, but they determine which
Slack events are delivered to Avalon. The manifest subscribes to:

| Event | What Avalon uses it for |
| --- | --- |
| `app_context_changed` | Refresh the Agent surface when Slack reports a relevant context change. |
| `app_home_opened` | Publish the correct linked, unlinked, or administrator App Home view. |
| `app_mention` | Start or continue a channel task when a user explicitly mentions Avalon. |
| `app_uninstalled` | Mark the workspace installation disconnected and stop routing work to it. |
| `channel_created` | Join a newly created public channel. |
| `link_shared` | Produce authorized previews for supported Avalon links. |
| `message.channels` | Continue an existing Avalon-owned thread in a public channel without requiring another mention, including when the human broadcasts the reply to the channel. Other public-channel messages are ignored before durable queueing. |
| `message.groups` | Continue an existing Avalon-owned thread in an invited private channel without requiring another mention, including when the human broadcasts the reply. Other private-channel messages are ignored before durable queueing. |
| `message.im` | Receive prompts and follow-ups in Avalon's Agent DM. |
| `tokens_revoked` | Mark affected credentials unhealthy and require reconnection. |

Avalon intentionally does not subscribe to `message.mpim` or broad file events.

## Source of truth and maintenance

The checked-in Slack manifest is
[`config/provider-apps/slack.json`](../config/provider-apps/slack.json). The
runtime bot-scope health check and personal capability mapping are in
[`packages/connectors/src/slack.ts`](../packages/connectors/src/slack.ts).
Behavior and data handling are described in
[`docs/SLACK_INTEGRATION.md`](SLACK_INTEGRATION.md).

When adding, removing, or repurposing a Slack scope:

1. update the manifest and runtime scope/capability declarations together;
2. update this document and the integration data-flow description;
3. add or update tests that keep the manifest and runtime declarations aligned;
4. determine whether existing workspace installations or personal connections
   must complete OAuth again for the additive grant.
