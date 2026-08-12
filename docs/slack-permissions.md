# Slack permissions

Every Slack OAuth scope Avalon configures, and the current product behavior,
model tool, or planned optional boundary associated with it. Avalon has two
independent authorization paths — an
administrator-approved workspace bot installation and an optional per-person
connection — and **neither ever stands in for the other**. This document is the
inventory that keeps those two grants honest against the checked-in manifest.

Read it before adding, removing, or repurposing a scope. Slack's own definitions
are in the [OAuth scope reference](https://docs.slack.dev/reference/scopes/), with
the installation model in
[Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)
and the granular search scopes in the
[Real-time Search API documentation](https://docs.slack.dev/apis/web-api/real-time-search-api/).
Thread follow-up follows Slack's
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
| [`packages/connectors/src/slack.ts`](../packages/connectors/src/slack.ts) | Required and optional scope declarations, runtime bot-scope health checks, the capability mapping, and every tool's required scopes. |
| `apps/api/src/services/slack-agent-service.ts` | The Agent surface, tool execution, and the event-scoped search token. |
| `apps/api/src/routes/slack.ts` | The ingress the subscribed events arrive at. |

## How it works

### The permission model

- **Workspace bot installation** — a Slack administrator installs the Avalon app.
  The required workspace bot scopes below power the in-Slack Agent experience and
  fixed workspace model-tool bundle, and Avalon checks that the installation still
  has the complete required set. The manifest separately offers future-facing
  optional scopes; declining them does not make an installation unhealthy or
  expose an unimplemented capability.
- **Personal Slack connection** — an individual connects Slack to Avalon for
  user-attributed tools. The connection itself is optional. The **Connect for me**
  button and the Slack account link both request the full current personal set, so
  a member who connects from either place grants the same current capabilities;
  only a connection made before that convergence carries a narrower grant. The app
  registration separately lists future-facing optional scopes that the current
  personal capability set does not request.

An OAuth scope is only the outer boundary. Avalon also applies workspace
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

The workspace bot joins current and newly created public channels so mentions and
bounded reads work there. Avalon does not poll channel history or mirror Slack
content. Private channels, DMs, MPIMs, and files remain limited by the bot's actual
Slack membership and visibility.

**Write tools**

| Tool | Slack API | Required bot scopes | Behavior |
| --- | --- | --- | --- |
| `send_message` | `chat.postMessage` | `chat:write` | Sends a bot-authored channel or thread message. Avalon supplies a stable `client_msg_id` for retry idempotency. |
| `add_reaction` | `reactions.add` | `reactions:write` | Adds a bot reaction. Slack's `already_reacted` response is treated as a successful retry. |
| `create_conversation` | `conversations.create` or `conversations.open` | `channels:manage`, `groups:write`, `im:write`, `mpim:write` | Creates a public/private channel by name or opens a DM/MPIM for one to eight user IDs. |

These tools use Avalon's normal external-write confirmation, authorization, audit,
and durable-receipt policies. A workspace Slack task can use them without the
initiating member creating a personal Slack connection, but only through the
installation belonging to the same Slack team and Avalon workspace.

### Workspace bot scopes

The production manifest requires these scopes as one administrator-approved
bundle. Avalon checks every workspace token for the complete set.

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
| `links:read` | Receive `link_shared` events for supported Avalon URLs. Slack's own permalink for a thread Avalon was summoned in is read with `chat.getPermalink`, which needs no scope of its own beyond the bot's access to that conversation. |
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

### Optional future bot scopes

The production manifest also requests the scopes below and marks every one in
`bot_optional`. Slack presents them separately during installation, and Avalon
continues when an installer declines any or all of them. They reserve likely
Slack-native extensions for a new customer who grants them up front; they do
not expose a model tool, subscribe to another event, or broaden current data
collection by themselves. A future implementation must check the token's
reported OAuth scopes before exposing the behavior.

| Permission | Planned boundary |
| --- | --- |
| `bookmarks:read` | Treat bookmarks in an authorized channel as high-signal task context. |
| `bookmarks:write` | Add an authorized Avalon work stream, brief, or generated resource to a channel's bookmarks. |
| `channels:write.invites` | Invite explicitly selected members to an authorized public channel. |
| `channels:write.topic` | Set an authorized public channel's generated purpose or project summary. |
| `dnd:read` | Make proactive notification timing aware of a recipient's Do Not Disturb state. |
| `emoji:read` | Resolve and validate workspace custom emoji for reaction-aware tools and automations. |
| `files:write` | Deliver an explicitly requested generated artifact into Slack. |
| `groups:write.invites` | Invite explicitly selected members to an authorized private channel. |
| `groups:write.topic` | Set an authorized private channel's generated purpose or project summary. |
| `lists:read` | Read a task-specific Slack List as structured context. |
| `lists:write` | Create or update an explicitly authorized Slack List for plans and action items. |
| `metadata.message:read` | Read structured message metadata needed to route an authorized automation or interoperate with another Slack app. |
| `pins:read` | Treat pinned messages and files in an authorized conversation as high-signal context. |
| `pins:write` | Pin an explicitly selected plan, decision, or generated deliverable. |
| `team:read` | Display and disambiguate connected workspaces with Slack's name, domain, and icon. |
| `usergroups:read` | Resolve a Slack user group into an authorized notification or collaboration audience. |
| `users.profile:read` | Read task-relevant profile details such as role, department, and timezone. |

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

Until Slack returns every required bot scope, Avalon reports the installation as
reconnect-required instead of offering partially authorized tools. Missing
optional scopes never cause that state. Existing installations therefore remain
healthy after the optional set is deployed, but they do not gain scopes Slack
did not previously grant unless an administrator authorizes them later.

### Personal user scopes

Personal scopes preserve the connected user's own Slack visibility and attribution.
Slack's hosted MCP server or the Slack Web API remains the enforcement point for
what that user can see or do.

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

### Optional future user scopes

The app registration marks the scopes below as `user_optional`. They are the
user-attributed equivalents of the planned workspace behaviors above, except
that `metadata.message:read` is bot-only. Avalon's current personal capability
set does not request them, so merely registering them does not expand an
existing personal token. A future personal tool must add its scope to the
corresponding capability and initiate OAuth expansion when the token did not
already receive it.

| Permission | Planned boundary |
| --- | --- |
| `bookmarks:read` | Read bookmarks visible to the connected user. |
| `bookmarks:write` | Manage bookmarks as the connected user. |
| `channels:write.invites` | Invite members to public channels as the connected user. |
| `channels:write.topic` | Set public-channel descriptions as the connected user. |
| `dnd:read` | Read Do Not Disturb state visible to the connected user. |
| `emoji:read` | Read custom emoji visible to the connected user. |
| `files:write` | Deliver requested artifacts as the connected user. |
| `groups:write.invites` | Invite members to private channels as the connected user. |
| `groups:write.topic` | Set private-channel descriptions as the connected user. |
| `lists:read` | Read Slack Lists visible to the connected user. |
| `lists:write` | Create or update Slack Lists as the connected user. |
| `pins:read` | Read pins visible to the connected user. |
| `pins:write` | Manage pins as the connected user. |
| `team:read` | Read identifying metadata for the connected workspace. |
| `usergroups:read` | Read workspace user groups visible to the connected user. |
| `users.profile:read` | Read detailed profiles visible to the connected user. |

Unlike workspace search, personal search does not use the Slack event
`action_token`; Slack evaluates it against the connected user's granted scopes and
current visibility.

### Related event subscriptions

Event subscriptions are not additional OAuth scopes. The manifest subscribes to:

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

Avalon intentionally does not subscribe to `message.mpim` or broad file lifecycle
events. `file_shared` carries only bounded trigger evidence; it does not import file
content.

### Event data and model context

A Slack-originated task receives this source provenance in its system prompt:

- Slack team/workspace ID;
- channel ID and, when Slack provides it, channel name;
- thread timestamp;
- invocation type and channel type;
- the matched Avalon member ID when a confirmed link exists;
- bounded active-view entity metadata supplied by Slack; and
- attachment metadata from the triggering interaction.

## Invariants

- **Workspace tools never inherit a member's personal Slack authority**, and
  personal tools never substitute for a workspace installation when processing Slack
  Agent events or delivering workspace-bot messages. These are two grants, not one
  with two sources.
- **A workspace write goes only through the installation belonging to the same
  Slack team and Avalon workspace.**
- **A scope is the outer boundary, never the authorization.** Membership,
  identity-linking, surface policy, conversation membership, session, confirmation,
  and audit checks all still apply.
- **The manifest and the runtime scope and capability declarations change
  together.** Required and optional scopes remain distinct: a required scope
  requested but not declared is a permission nobody can explain, while an optional
  scope must not silently become a current capability or health requirement.
- **Optional authority is dormant.** Avalon does not call another API, subscribe to
  another event, or expose a model capability merely because Slack returned an
  optional future scope. Its eventual consumer must check the token's actual grant.
- **Avalon does not durably copy surrounding Slack messages.** Reads are bounded and
  transient; there is no mirror.
- **Active-view and attachment metadata are labeled as untrusted evidence, not
  system instructions.**
- **Notification lookup never silently links or authenticates an account**, even
  though `users:read.email` makes the match possible.
- **`groups:read` does not grant access to private channels the bot has not
  joined.** Membership is Slack's to enforce and Avalon does not work around it.

## Boundary

This document owns the scope inventory and what each scope buys. It does not own
the Slack product surface, the ingress, or the registration:

| For | Read |
| --- | --- |
| Lifecycle, data handling, App Home, user linking, acceptance | [`slack-integration.md`](slack-integration.md) |
| The registration itself and its regional routing | [`provider-apps.md`](provider-apps.md) |
| The unfurl card and its audience rules | [`workstream-links.md`](workstream-links.md) |
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

- **Existing workspace installations must reconnect after the required permission
  set expands.** Adding only optional future scopes leaves them healthy. Until Slack
  returns all required bot scopes, Avalon reports an installation as
  reconnect-required. **It still offers the tools**: the report is a diagnosis, not
  a gate, and a call that needs a missing scope fails on Slack's answer rather than
  on Avalon's record of it.
- **A personal token may be missing scopes this document lists.** Connections made
  before **Connect for me** and the account link converged on the full set carry a
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
`pnpm --filter @avalon/api exec vitest run test/slack-agent-ingress.test.ts` — the
path is package-relative.

`slack manifest validate` reads the same manifest through the checked-in `.slack`
hook, and is what catches a scope Slack itself rejects. Nothing in Vitest can tell
you that a scope was actually granted; only the acceptance flows in
[`e2e.md`](e2e.md) can.

## Security and trust model

The short-lived search `action_token` is **hidden runtime authorization**: it is
never placed in the system prompt, the work-stream transcript, model tool arguments,
tool output, or inference-payload logs. Search results are transient model context
and are excluded from durable tool-result replay.

Everything Slack supplies — active-view metadata, attachment metadata, message
content — is untrusted evidence. [`security.md`](security.md) owns the boundary this
sits inside.

## Changelog

This document predates the [module document](module-documents.md) convention and
had no changelog until the entry below; earlier reasoning was not reconstructed.

### 2026-08-12 — Future Slack-native scopes became optional grants

**What changed:** The manifest and runtime now distinguish the unchanged required
workspace bot bundle from seventeen optional bot scopes and sixteen corresponding
optional user scopes. `metadata.message:read` is bot-only. Workspace OAuth offers
the required-plus-optional union, while callback, refresh, and health checks still
require only `SlackWorkspaceBotScopes`. No existing permission was removed.

**Why:** A future required scope would force every installed customer through
administrator authorization again. The likely next Slack-native behaviors are
close enough to Avalon's current product boundary to offer at first install, but
they are not current capabilities and therefore must remain optional.

**Considered and rejected:** Making the future scopes required would make current
Agent health depend on speculative access. Waiting for each tool to ship would
preserve the narrowest first-install screen but guarantee another consent round.

**Consequences:** The manifest bot set must equal the required-plus-optional union.
Optional denials never affect installation health, and every future consumer must
check the token's actual grant before exposing its behavior.
