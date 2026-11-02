# Slack Agent connector

Rally lives inside Slack as one public Marketplace app carrying two independent
credentials: an administrator's **workspace installation**, which is the bot
identity and the whole Agent surface, and an optional **personal connection**,
which gives Rally's MCP client that member's own Slack visibility and
attribution. Neither substitutes for the other.

Read this before changing the ingress, the identity-linking flow, what a
Slack-originated run may read, or how a result is delivered. Every configured bot
and personal OAuth scope, with its concrete provider-feature justification, is
listed in [`slack-permissions.md`](slack-permissions.md) rather than here.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/connectors/src/slack.ts` | The adapter: capabilities, scope health, tools, activity types. |
| `packages/connectors/src/slack-reactions.ts` | The reaction vocabulary and how an override resolves against it. |
| `packages/connectors/src/slack-markdown.ts` | Agent markdown rendered as Slack blocks, and split at Slack's limit. |
| `packages/contracts/src/index.ts` | The shared contracts both ends parse. |
| `packages/db/migrations/0039_slack_connector.sql` | The regional schema. |
| `apps/api/src/services/connection-service.ts` | OAuth and connection lifecycle. |
| `apps/api/src/services/slack-routing-service.ts` | The Global team-to-region route, and nothing else Global holds. |
| `apps/api/src/services/slack-agent-service.ts` | Agent sessions, App Home, interactions, unfurls, delivery. |
| `apps/api/src/durable-objects/workspace-slack-protocol.ts` | The typed request/result contracts for the ingress spine: jobs, thread claims, pending prompts, the maintenance sweep. |
| `apps/api/src/durable-objects/workspace-slack-storage.ts` | The SQL behind those methods, inside WorkspaceDO's own storage. |
| `apps/api/src/services/slack-notification-service.ts` | Workspace-bot delivery of the two things Rally tells one person about a work stream: a mention, and being added to it. |
| `apps/api/src/routes/slack.ts` | The three signed ingress routes. |
| `apps/api/src/durable-objects/substream-agent.ts` | The run-settlement output sink that reaches Slack. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | Installation administration. |
| `config/provider-apps/slack.json` | The manifest. |
| `apps/api/src/durable-objects/workspace-external-binding-storage.ts` | Room and thread bindings, which decide where every Slack message routes. Owned by [`external-conversation-bindings.md`](external-conversation-bindings.md). |

### Product boundary

Rally uses one public Slack Marketplace app for two related but separate connections:

1. A **workspace installation** gives Rally a bot identity and the Slack Agent surfaces. It receives Events API deliveries and powers Agent DMs, mentions, App Home, shortcuts, `/rally`, modals, unfurls, streaming replies, and proactive automation results.
2. An optional **personal connection** gives Rally's MCP client a Slack user token. It preserves that user's broader private-channel, DM, MPIM, canvas, visibility, and user attribution.

The workspace installation is required for the in-Slack Agent experience. Personal MCP authorization is not required to chat with Rally in Slack. Every Slack-originated run receives bounded source provenance (team, channel, thread, invocation and channel types, and any matched Rally member), plus up to eight nearby messages and attachment metadata when the bot can read them. Nearby Slack content is model-visible as explicitly labelled untrusted evidence rather than system instructions. The workspace installation also exposes bounded message search, channel/thread/message/file/user/member reads, and bot-authored message/reaction/conversation writes. Slack's Real-time Search API requires the short-lived `action_token` from a user-initiated message or app mention; Rally carries that token as hidden run authorization and never adds it to prompts or model tool arguments. Bot search covers public channels only. Other workspace reads cover conversations and files visible to the installed bot. The message shortcut can explicitly prefill a task with its selected message.

This split follows Slack's July 2026 Agent model. New apps use `features.agent_view`, the normal Messages tab, and threaded replies. The older `assistant_view` is not configured.

### Connection cardinality

The invariant is asymmetric:

- One Slack team ID maps to at most one Rally workspace and one data region.
- One Rally workspace can contain any number of Slack team installations.
- A member can add a personal Slack MCP connection for each Slack identity they use.
- A workspace bot installation and a personal MCP connection are independent credentials, even when they refer to the same Slack team.

Global D1 stores only `team_id -> region/workspace/connection` routing metadata. Signed payload processing, encrypted tokens, user links, Agent sessions, workstreams, and results stay in the owning Rally region. The database and desktop UI deliberately allow **Connect another workspace** for Slack.

### API versus MCP

Raw Slack APIs are the workspace Agent and workspace-tool plane:

- OAuth installation and token rotation
- conversation classification and bot membership
- Events API and request signing
- Agent messages, status, title, suggested prompts, and streaming
- App Home (`views.publish`)
- global and message shortcuts
- slash commands
- modals
- link unfurls
- deterministic scheduled-result delivery
- Real-time Search API message discovery for a triggering Slack user
- bounded conversation, thread, message-context, file, user, and member reads
- bot-authored message, reaction, and conversation writes

Slack's hosted MCP server is the user tool plane. Rally initializes a JSON-RPC 2.0 Streamable HTTP session at `https://mcp.slack.com/mcp`, sends `notifications/initialized`, follows all `tools/list` cursors, validates the discovered surface, invokes the exact live name through `tools/call`, and closes the session when Slack assigns one. The server's current names, descriptions, and JSON Schemas are passed through at plugin activation rather than copied into the connector. Provider annotations remain untrusted hints: every live tool keeps Rally's conservative-write and record-before-execute policy. Rally's `slack.personal.mcp` grant and personal owner check constrain the surface without pretending to own its catalog. MCP calls are never used to host the Agent surface or to bypass a frozen automation delivery target. The reusable mechanism is in [`hosted-mcp-connectors.md`](hosted-mcp-connectors.md).

Personal authorization requests one `slack.personal.mcp` Rally capability whose
provider scope set covers Slack's hosted user-tool plane. Existing personal rows
that carry the older per-tool capability grants remain on Rally's reviewed
static Web API tools as a migration bridge; they never authorize the live MCP
catalog. Reconnecting replaces them with the umbrella grant. Workspace Agent scopes remain a separate
administrator-controlled installation with one reviewed capability bundle,
including `reactions:read` for activity triggers and `reactions:write` for the
deterministic activation acknowledgement and workspace reaction tool. Existing
workspace installations must reconnect after the workspace-tool scope expansion
before health checks and tool calls succeed.

### Data behavior

The canonical definition is in `docs/provider-apps.md`: zero-copy means Rally does not recreate Slack inside Rally. It is a product and architecture boundary, not a claim that no Slack data crosses the connector or is ever persisted. Rally must not become a parallel Slack inbox, channel browser, history store, or generally searchable Slack replica.

Within that boundary, Rally may subscribe to Slack activity, retain bounded normalized trigger evidence and provenance for configured automations, fetch authorized task-specific context on demand, and preserve Slack-derived content in the Rally work that uses it. The workspace bot is in a conversation only because somebody invited it, or because a Sidekick's Slack source names that conversation and Rally joined it for that source. Rally does not join public channels on its own, and does not join a channel because Slack reports its creation. An invitation links the room to a Space; a Sidekick-source join links nothing. See [external conversation bindings](external-conversation-bindings.md). To support natural follow-ups, Slack delivers `message.channels`, `message.groups` and `message.mpim` events for conversations the bot has joined because Slack offers no thread-only event filter. The regional ingress accepts human replies in a bound thread, a recent denied Rally thread, or a message event matched by an explicitly configured Slack automation source; unrelated messages are discarded before durable queueing. Normalized automation activity retains bounded trigger evidence and identifiers, not a general-purpose copy of the source conversation or file content.

When a prompt is denied because the channel classification or Agent policy needs attention, Rally retains that prompt regionally for at most 24 hours. This lets the same Slack member reply `try again` after the problem is fixed without retyping the request. The prompt is deleted when a session starts and expired rows are removed by scheduled maintenance. A narrowly matched, explicitly mentioned retry of a denial created before this mechanism may read at most the first 15 messages in that single thread to recover the prompting mention; unmentioned messages in other threads are ignored.

Natural public- and private-channel follow-ups require the workspace bot's `channels:history` and `groups:history` scopes. Existing workspace installations must complete the Rally OAuth flow again after this feature is released. The scopes apply only to conversations the bot can access; Rally's routing and retention restrictions above remain narrower than the provider grant.

Real-time Search API responses are transient context for the active model turn. Rally stores only the generic tool-completion summary for replay, not the retrieved search payload, and suppresses the later raw inference-request capture after a Slack search result enters the model context. Terminal attempt metadata still reaches the lakehouse. The event `action_token` remains hidden runtime authorization and is not copied into the work-stream transcript, Slack session context, tool input, tool output, or inference record.

Normal product use can persist information in the resources that use it. A user prompt, bounded trigger record, Slack context used for the task, model-authored summary, workstream message, tool receipt, or automation result may remain in Rally. That is purpose-bound Rally work, not a cloned Slack corpus. By default these task and automation resources do not expire automatically; they remain until an authorized user deletes the resource or the workspace is deleted. Workspace disconnect revokes the credentials Rally holds and disables routing; a Slack administrator separately removes the app from Slack App Management to uninstall it from the workspace. Personal disconnect revokes that user's credential. Disconnecting does not delete existing Rally resources.

### Ingress and routing

The shared ingress is `https://slack.rallywith.ai`:

- `POST /slack/events`
- `POST /slack/interactivity`
- `POST /slack/commands`

Ingress verifies `v0:{timestamp}:{exact raw body}` using HMAC-SHA256, requires a timestamp inside five minutes, compares in constant time, checks `api_app_id`, and deduplicates Events API `event_id` values. URL verification is answered synchronously. Before acknowledging an event, text command, or valid modal submission, the owning regional service writes an ingress job and publishes its opaque job ID to the regional queue. Modal validation errors are returned synchronously to Slack. Shortcuts that need a trigger ID open their modal synchronously. The Global router looks up only the team route and invokes the owning regional service binding.

Queue workers atomically lease jobs, retry failed or abandoned work, and clear the stored ingress payload after successful processing. A job that failed on authorization is classified non-retryable and pinned at the attempt ceiling, which is right while a grant is dead and wrong the moment it is not: `redriveReauthorizedIngress` re-queues such a job once its connection has been written again, which a reauthorization always does. It is self-limiting, because a re-driven job that fails again stamps itself newer than the connection. Without it, events that arrived during an outage stayed failed forever with their payload still on the row — and a `link_shared` Slack reports exactly once is never redelivered, so the message keeps its bare URL permanently. Retries with the same `event_id` and body are acknowledged once. Reuse of an event ID with different content is a conflict. Provider payloads are not written to Global object storage during routing. Ordinary channel messages that do not match an existing or retryable Rally thread are acknowledged without creating a regional ingress job.

After a queued DM or mention passes connection, policy, and actor checks, the worker adds the acknowledgement reaction to the exact triggering message before it gathers context, creates/resumes a workstream, or starts model/tool processing. Slack's `already_reacted` response is a successful idempotent retry. A Slack-side reaction failure is logged and, when appropriate, marks the installation for reconnect, but does not discard the already-admitted user request. Commands and modal submissions have no unambiguous source message and retain their existing ephemeral/modal acknowledgement instead.

The acknowledgement command is built and executed as two explicit adapter steps rather than through `acknowledgeConnectorAgentActivation`. The shared hook takes only the invocation, so it cannot see the workspace's configured reaction set; both steps are still the adapter's own, so the acknowledgement goes through the same control plane the shared helper would have used.

### Identity linking

Slack users are never matched to Rally accounts by mutable profile fields or email alone.

Person-mention notification routing is deliberately narrower than account linking. When an
active Rally member is mentioned, Rally first uses that member's confirmed Slack link for
an installed team. If no link exists, every workspace installation a person has not disabled may resolve the
member's verified Rally login email with `users.lookupByEmail`; Rally sends a bot-authored
DM only when exactly one installed team returns a valid active human. This lookup is used only
as a delivery address: it does not create a `slack_user_links` row, authenticate the recipient,
or authorize personal Slack tools. Missing, ambiguous, invalid, or incompletely authorized
matches send nothing to Slack. Nothing falls back to email: a mention is emailed only when
the person chose email for that kind
([`push-notifications.md`](push-notifications.md#what-each-person-chooses)). Existing installations must complete the
Rally OAuth flow again to grant additive `users:read`, `users:read.email`, and
`reactions:read` and `reactions:write` bot scopes. Until the identity scopes arrive, lookup-based mentions are
not sent to Slack. If an already-admitted prompt discovers that `reactions:write` is missing, Rally
continues that task and marks the installation for reconnect. The mark is a diagnosis, not a
gate: later prompts still reach Slack and fail on Slack's answer if the scope is really gone —
see [Stored status is a belief, not a gate](connectors.md#stored-status-is-a-belief-not-a-gate).

Mention delivery logs each candidate lookup and its terminal routing decision.
`slack_notification_lookup_candidate` distinguishes a valid active human from
team mismatch, deleted user, bot, missing scope, and no match;
`slack_notification_destination_resolved`,
`slack_notification_conversation_opened`, and
`slack_notification_chunk_terminal` retain the connection, Slack team, user,
DM channel, client-message, and provider-message IDs. The final
`slack_notification_terminal` records either `sent` or the exact skip reason
(`no_active_workspace_installation`, `multiple_confirmed_links`,
`ambiguous_email_lookup`, or `no_email_lookup_match`). A provider exception or
partial multi-chunk send is `slack_notification_delivery_incomplete`. These
opaque IDs are deliberate correlation fields, not message content; email
addresses, notification text, tokens, and provider response bodies stay out of
logs.

1. An unlinked member clicks **Connect Rally** — on App Home, or on the private
   prompt Rally sends when a task it is running for them needs a Rally account
   of its own.
2. The regional service creates a random, hashed, 15-minute link challenge bound
   to the workspace installation and Slack user ID, and returns it in a modal
   opened against that same click.
3. The HTTPS handoff keeps the token and its `(region, workspace_id)` routing
   coordinates in a URL fragment, removes them from browser history, and opens
   the signed-in Rally desktop app.
4. The desktop activates and verifies that workspace, then calls authenticated
   `POST /connections/slack/link` against its regional session; the endpoint
   consumes the challenge and binds that Rally user to the Slack identity. A
   refused activation never tries the token against whichever workspace was open.
5. The desktop then starts the personal Slack authorization against that same account, so one
   click accomplishes both halves rather than leaving the second as an errand. A link that
   committed survives a failed authorization; only the half that did not finish is reported.
6. Every later invocation verifies active Rally membership, the active link, the installation, and the owning region.

**This is one of two routes to a link.** Completing a *personal* Slack connection establishes it
too, through `establishIdentityLinkFromPersonalConnection`: Slack ran the OAuth and named the
user, which is a stronger proof of who this is than a challenge Rally minted. Both routes are
idempotent, so whichever a member reaches first, both end up done. The insert is refused only
when the Slack identity already belongs to a different Rally member — the personal connection
still stands in that case, because resolving it is not that operation's business.

**A challenge is minted by the click that redeems it, and never earlier.** No
Slack surface holds a handoff URL: App Home and the connect DM carry a button
whose only job is to ask for one. This is a hard rule rather than a preference —
App Home is a published document with no expiry of its own and the connect DM is
read whenever the member gets to it, so a token rendered into either dies where
it is still visible, and a member clicking it has no way to tell. A new surface
that invites a member to connect uses the same button; it does not embed a link.

A member's earlier challenges are retired once a newer one has reached them, so
only the most recently requested link can be redeemed. That retirement happens
**after** the modal carrying the replacement opens, never as part of minting: a
`views.open` that fails would otherwise have invalidated the link the member is
still looking at, in exchange for one they never received. Retirement is bounded
by mint time, so clicks racing each other cannot retire one another and strand
the member with no live link at all. A challenge that cannot be redeemed
is refused with the reason rather than a single generic expiry:
`slack_link_unknown`, `slack_link_consumed` (already used, or superseded),
`slack_link_expired`, `slack_link_workspace_mismatch`, and
`slack_installation_disabled`. Only the first three are answered by clicking
**Connect Rally** again. A *disabled* installation needs a Rally workspace owner or admin
to re-enable it: disabling clears the credentials and drops the row from `connectionForTeam`,
so redeeming would commit the identity link and then fail publishing App Home. An installation
merely marked `needs_reconnect` is **not** refused — that is a belief about a past moment, and
the challenge is single-use, fifteen minutes old, and minted by a click Slack signed.

Suspended members and revoked links cannot start or continue tasks. A user may link separately in every connected Slack team.

#### Who a Slack work stream belongs to

A work stream started from Slack takes the audience of the conversation it was summoned from,
by the connector-wide rule in
[the connector document](connectors.md#a-work-streams-audience-is-the-conversation-it-started-in).
A mention in a public channel opens a **public** work stream. A private channel, a DM, a group
message, or a conversation the installation could not classify opens a **private** one, seated
with the members `conversations.members` returns — up to 200, resolved through one shared actor
mapping read. Only unresolved members need `users.info`, six at a time under one shared ten-second
deadline. Resolution remains best effort: a roster Slack refuses or cannot finish costs a smaller
starting room rather than the prompt. These are the existing work-stream scope states underneath:
public stores `workspace`, and private stores participant-only `personal`.

**Every member of that Slack conversation can continue the work stream.** A reply from somebody
the work stream has not seen seats them first and is then recorded, so a private work stream
answers the channel it belongs to rather than 404ing at it. A Slack member Rally cannot map to
an account at all still has their message recorded, under their Slack actor.

**Each message runs under the authority of whoever sent it**: a member with a confirmed account
link runs as themselves, and everybody else runs under the workspace principal. A reply in a
thread bound to a Sidekick run is the one exception, owned by
[`connectors.md`](connectors.md#invariants). Nothing weaker
than a link authorizes a run — a `users.lookupByEmail`-grade match seats and credits somebody
and cannot spend their credentials — so two replies in one thread can run under different
principals, exactly as they do when two members type into the same work stream in Rally.

How "runs as themselves" reaches the work-stream object is the **connector principal**: the
ingress verifies the active `slack_user_links` row and active membership on the very message
being delivered (`linkedAccount`), then marks the auth `principal: "connector"` and carries a
`slack:{team}:{user}` correlation id in place of a session id. The object re-checks current
membership itself and refuses a stale principal as `connector_member_revoked`; it does not look
the correlation id up in `sessions`, because a Slack message is not a login and no session row
exists for it. A login session, by contrast, is always re-verified against its `sessions` row (outside local development's dev-auth bypass).

The triggering Slack member travels with the workflow input through delivery. If a run needs
input that requires a connected account, Rally sends the connect prompt to that member rather
than to whoever opened the work stream. Result controls are shared Slack content, so the feedback
button is shown to everyone; the feedback submission still revalidates that the submitting member
has an active Rally link on the installation that owns this work stream. A link left on a retired
installation cannot suppress the current installation's connect prompt.

#### Work stream attribution

A work stream started from Slack records the Rally member the Slack author resolves to as its
creator, and adds them as a participant. Slack does not decide that mapping on its own: it
uses the shared connector actor identity described in
[the connector document](connectors.md#actor-identity-and-work-stream-attribution), which
every agent connector uses. Slack contributes the `users.info` profile — including the email
that feeds the `verified_email` step — and records the resolved mapping for later work.

When a mapping only arrives
later — the member links their account, or joins Rally after the task ran — the earlier
ownerless work streams of their Slack sessions are credited to them then. Account linking may
additionally correct a creator that the same session's earlier `users.lookupByEmail` match
produced, which is the only case where an existing creator is rewritten.

As everywhere else, attribution is not authorization: an unlinked author's task still runs
with the workspace principal, and the opening message keeps its external Slack actor.

### Agent sessions and delivery

Every Slack message is routed by its **binding** before a work stream is looked up or created: a thread bound to a work stream delivers there, a thread bound to a Sidekick run delivers to that run, an addressed thread in a room linked to a Space opens a work stream in that Space, and anything else takes the Agent path below. [`external-conversation-bindings.md`](external-conversation-bindings.md) owns resolution and the lifecycle events (`member_joined_channel`, `member_left_channel`, `channel_left`, `group_left`, `channel_archive`, `group_archive`, `channel_id_changed`) that link, suspend and move bindings.

A Slack root DM or root mention on the Agent path creates a stable `slack_agent_sessions` row keyed by installation, channel, and root timestamp, and writes the thread's binding in the same transaction. It maps to exactly one durable Rally workstream. The session row is delivery state (status, reaction, who started it); the binding is routing. Human replies in that Slack thread add messages to the same workstream without requiring another `@Rally` mention, whoever sends them. Rally ignores messages outside its bound threads and does not replay or import the rest of the Slack conversation.

A message in a DM with the bot that has no binding of its own, while the DM's most recent Sidekick request is still being worked on, is answered once asking the person to reply in the request's thread, with a link to it. It creates no work. Once that request's run has finished, or in a DM with no request, the DM keeps the one-to-one Agent behavior.

In a conversation Slack marks as not threadable, Rally never posts into a thread: the Agent status and title are skipped and results are posted at the top level.

The session row records who started the thread and where; it does not decide who may use it. The only reply Rally refuses is one answering a question addressed to a specific member — the same rule the Rally app applies to a targeted elicitation, per question rather than per thread.

The workstream also carries the thread it was summoned from as an attached `slack_thread` resource, so a member reading it in Rally can get back to the conversation. That attachment holds identifiers, the channel name, and Slack's own permalink — origin metadata, not message content, consistent with the retention boundary above. See [work-stream origin attachments](workstream-origin-attachments.md).

On a prompt Rally:

1. adds the acknowledgement reaction when the invocation has a source message;
2. sets the Slack Agent thread status;
3. creates or resumes the durable workstream;
4. executes the ordinary authorized Rally harness;
5. reloads the exact canonical final turn after terminal persistence;
6. posts that complete saved turn in Slack's required 12,000-character chunks;
7. swaps the reaction for the one naming the outcome;
8. links to the canonical Rally workstream and offers feedback.

The persisted Rally run is canonical. A Slack delivery failure never rewrites a completed run as failed.
Rally never streams model output to Slack. A fixed status or reaction may change
while work is running, but if terminalization has no saved turn there is no
Slack result message.

#### The status reaction

A reaction on the triggering message is the only status a member sees without
opening the thread, so it tracks the run rather than merely receipting it. **At
most one Rally reaction sits on a message at a time**, and each transition
removes the previous one:

| State | Default | When |
| --- | --- | --- |
| Acknowledged | `eyes` | The prompt is admitted and authorized, and stays while the run is live. |
| Outcome | `white_check_mark`, `question`, `warning`, `octagonal_sign` | The run reaches `completed`, `needs_input`, `failed`, or `stopped`. |

A transition removes only the emoji Rally itself last placed, recorded in
`slack_agent_sessions.reaction_current`, so a member's own reaction on the same
message survives. The outcome transition re-reads that column immediately before
acting and writes it back conditionally: removing a stale emoji answers
`no_reaction`, which is a successful retry, and would otherwise leave two Rally
reactions on the message — the one thing the single-slot rule exists to prevent.
The reaction sits on the *triggering* message rather than the thread root, and
each new prompt in a thread moves it.

A session holds one reaction slot, but a follow-up prompt is admitted while an
earlier run in the thread is still live, and moves the slot to its own message,
usually with the same emoji. So each run carries its own anchor (channel and
message) on `slackOrigin.reactionAnchor` from admission to delivery. The outcome
always lands on that message. When the slot still points there, the outcome is
written back conditionally on both the anchor and the emoji; when it has moved
on, the run swaps the configured acknowledgement for its outcome and records
nothing, leaving the slot to the newer anchor. A run admitted before the anchor
was carried falls back to whatever the slot holds.

A follow-up from a member Rally cannot map to an account is admitted as a
steer, and when it reaches a step boundary of the live run it merges into that
run instead of starting its own. The commit that promotes it records its
`slackOrigin` in the conversation's `run_absorbed_slack_origins`, and the run's
delivery settles every message it absorbed as well as its own. A linked
member's answer to an open question carries `slackOrigin` into the run the
answer starts, as an ordinary message does.

The anchor holds only what the Slack event fixes. `slackOrigin` is part of the
message's admission identity, so the emoji Slack accepted, which a retried
ingress job can see differently (a timeout, then `already_reacted`), would make
the retry an idempotency conflict.

Reaction sets resolve most-specific-wins: the built-in defaults, then a workspace
override on the installation's `config_json`, then a per-run override. An
override may name any subset and inherits the rest. Slack exposes no way to check
that an emoji name exists before using it, so a name it rejects with
`invalid_name` falls back to Rally's own default for that state, once.

#### Rendering agent output

Slack has two text dialects. The `text` field of `chat.postMessage` is **mrkdwn**
— `*bold*`, `_italic_`, no headings, no tables — while the `markdown` block
takes ordinary markdown, which is what the agent emits. Saved-turn delivery
therefore renders through the `markdown` block and carries `text` only as the
notification and screen-reader fallback. An
automation result's title is a `header` block above it rather than a line of body
text. Long output splits at Slack's 12,000-character limit, preferring a
paragraph seam, then a line, and closing and reopening a fenced code block rather
than severing one.

**The connector's `send_message` tool renders the same way.** A Sidekick or
agent posting through it writes ordinary markdown, so the tool sends the body
through `slackMarkdownMessages` rather than as `text`. A body past the limit posts
as consecutive messages in the same conversation or thread, each with its own
`client_msg_id` derived from the tool receipt, and the tool reports the first.

**Citations are reduced before the split.** An agent's answer may
carry `resource://` link and image targets and GFM footnotes
([`markdown-rendering.md`](markdown-rendering.md)); Slack renders neither, so an
unrewritten citation lands verbatim in front of a channel — a raw internal URL,
a broken image where an announcement belonged, and literal `[^1]` markers.
`slackDeliveryMarkdown` reduces them to label text and one trailing source list.

It is a named step rather than something folded into the chunker because the
reduction must run *before* splitting — running the footnote pass over a chunk
whose definitions landed in the next one would renumber against a body it could
not see. `slackMarkdownMessages` owns that ordering. It is idempotent, so a path
that reduces twice does not double-number.
The transcript copy of the same answer keeps its citations; only what leaves
Rally is reduced.

An automation's Agent-DM destination is one of the delivery targets described in
[work-stream and automation email addresses](workstream-email-addresses.md#outbound-automation-results);
Slack and email are delivered independently, so a failure in one is retried without holding back the other.

### App Home

App Home is a personalized control surface published per user. Rally publishes only for `app_home_opened` events whose tab is `home` and supplies Slack's current view hash to protect against stale updates.

#### Unlinked

- concise description of Rally and its data behavior
- **Connect Rally** call to action — an action button carrying no URL, so
  publishing Home mints nothing and nothing on the published view expires
- example prompts, including the morning Gmail briefing
- AI fallibility notice
- paid Slack and Rally plan disclosure
- privacy and help links

#### Linked member

- **Start a task**, **Create automation**, and **Notifications** actions
- needs-attention and running tasks
- recent personal automations and next-run state
- explanation of optional personal Slack tools
- privacy and support links

#### Workspace admin

App Home adds a workspace-administration card for Rally owners and admins with installation health and a secure desktop handoff to Connections. The desktop Connections page is the full administration surface: installation health, team labels, granted surfaces, token health, reconnect, and disconnect.

Home is updated on `app_home_opened`, after account linking, and after settings changes. Blocks contain user-specific data only after the Slack user has been linked and active membership is revalidated.
Recent/pinned work-stream summaries and link unfurls come from the authoritative
WorkspaceDO directory after cutover; installation, account-link, connection, and
Slack delivery coordinates remain in regional D1. A WorkspaceDO failure withholds
or delays that product summary rather than reading a frozen D1 work-stream row.

### Interactions

- Agent DM: start a durable task or continue its thread.
- `@Rally` in a channel: create/continue a task in the mention thread; later human replies in that Rally-owned thread do not need another mention, and responses always stay threaded.
- Global shortcut **Start a Rally task**: open a task modal.
- Message shortcut **Work on this with Rally**: prefill the task modal with the selected message.
- `/rally [request]`: start the request; an empty command opens the modal.
- **Connect Rally**: mint a link challenge and open it in a modal whose single
  button is the desktop handoff. Not refused on a stored status; a grant that is
  really gone fails on Slack's answer.
- Result buttons: open the canonical task or provide feedback. The shared message shows feedback
  to everyone; submission is accepted from any linked member of the installation, not only whoever
  started the thread.
- Rally person mention: notify the matched member in the Rally Agent DM, falling back to email.
- Rally links: unfurls that summarize the work stream — title, last activity, automation origin, and a status badge only while it is running, needs input, or failed — and require the viewer's normal Rally authorization for its contents.

Every work-stream link Rally posts is the canonical workspace-addressed
`https://rallywith.ai/app/workspaces/<region>/<workspace-uuid>/workstreams/<workstream-uuid>` — see
[`workstream-links.md`](workstream-links.md). Slack delivers `link_shared` only
for the registered unfurl domain, so a link must be on that domain, with the id
in its path, to be unfurled at all; `rallywithai://` links pasted by a member never
produce an event and cannot be previewed. The unfurl handler also still accepts
the legacy `/open#target=` handoff already sitting in channel history.

Every other web button uses an allowlisted HTTPS-to-desktop handoff carrying the
installation's region/workspace target. Workstream IDs may cross that boundary;
connector tokens and Slack link challenges stay in fragments and are removed
from browser history. The single button carrying a link challenge is the one
inside the connect modal, which exists only for as long as that modal is open.

Modal submissions are validated server-side. Modals never request Rally or provider passwords.

#### Delegate from Slack

As a linked member, I can DM Rally, mention it, invoke a shortcut on a message, or run `/rally`, and receive progress and the durable result in the same Agent thread.

#### Bring Slack context into Rally

From a user-initiated Slack DM or app mention, I can ask Rally to search public-channel messages using Slack's event-scoped authorization. With the workspace installation, I can also find visible users and conversations, read bounded channel/thread/message context, inspect bounded textual file content, and list conversation members. A personal Slack connection adds user-authorized private search, DMs, MPIMs, canvases, and the hosted MCP tool surface.

#### Act in Slack

With the workspace installation, I can ask Rally to send a bot-authored message, create or open a conversation, or add a bot reaction. A personal connection continues to support user-attributed actions and canvas writes. Existing authorization and external-write receipt policies still apply.

#### Connect several Slack workspaces

As a Rally admin, I can install the same Rally app into several Slack workspaces. Each installation has its own health, links, sessions, and automation destinations. No installation becomes the implicit default when more than one is available.

#### Notify a mentioned teammate

As a Rally member, when I mention an active teammate in a work stream, Rally sends that
teammate a bot-authored Slack DM when the workspace installation can resolve them. A confirmed
Slack link is preferred; otherwise Rally uses an exact verified-email lookup without silently
linking the accounts. The message identifies the author, workspace, work stream, complete
mention text, and a secure **Open in Rally** handoff. If Slack cannot resolve or deliver it,
Rally sends the existing mention email instead.

#### Morning Gmail briefing

As a member, I can request: **“Check my Gmail every morning and send me the stack-ranked top 3 emails in Slack.”**

The saved personal automation freezes:

- the personal Gmail connection used for reads;
- a 9:00 AM calendar schedule in the user's IANA timezone unless the user chooses another time;
- the selected Slack workspace installation;
- the linked Slack user as an `slack_agent_dm` destination.

At each run Rally ranks actionable inbox items, sends up to three (fewer if fewer qualify), and includes rank, sender, subject, why it matters, recommended action, and Gmail link in the Agent DM. Long results are sent without connector truncation using Slack-required message chunks. It posts a root Agent DM and sets the Agent thread title as a best-effort decoration after delivery succeeds. Empty results are suppressed by default. Revoked Gmail or Slack authorization marks the run or destination `needs_input`; transient Slack delivery errors remain retryable and do not disable the destination. Rally does not silently switch accounts or Slack workspaces. Saving the recurring automation is the user's approval for those scheduled reads and deliveries.

## Invariants

- **One Slack team ID maps to at most one Rally workspace and one data region**,
  while one Rally workspace may hold any number of installations. The asymmetry is
  the point: a team that resolved to two workspaces has no answer to "where does
  this event go".
- **A workspace installation and a personal connection are independent
  credentials**, even for the same Slack team. Workspace tools never borrow a
  member's personal authority, and personal tools never process Agent events or
  deliver workspace-bot messages.
- **Global holds only `team_id → region/workspace/connection`.** Signed payload
  processing, encrypted tokens, user links, Agent sessions, work streams, and
  results stay in the owning region, and provider payloads are never written to
  Global object storage during routing.
- **Ingress verifies `v0:{timestamp}:{exact raw body}` before anything parses**,
  requires a timestamp inside five minutes, compares in constant time, checks
  `api_app_id`, and deduplicates `event_id`.
- **The ingress job is written and its opaque id queued *before* Slack is
  acknowledged.** An acknowledgement without a durable job is an event Slack will
  never send again.
- **Slack users are never matched to Rally accounts by mutable profile fields or
  email alone.** `users.lookupByEmail` is a delivery address only: it does not
  create a `slack_user_links` row, authenticate the recipient, or authorize personal
  tools.
- **A link challenge is minted by the click that redeems it, and never earlier.**
  No Slack surface holds a handoff URL — App Home is a published document with no
  expiry of its own and a connect DM is read whenever the member gets to it, so a
  token rendered into either dies where it is still visible and the member has no
  way to tell. A new surface that invites a member to connect uses the same button;
  it does not embed a link.
- **Earlier challenges are retired only after the modal carrying the replacement
  opens**, and retirement is bounded by mint time. A `views.open` that failed would
  otherwise invalidate the link the member is still looking at in exchange for one
  they never received, and unbounded retirement lets racing clicks strand the member
  with no live link at all.
- **A stored status is a belief, not a gate.** An installation marked
  `needs_reconnect` still reaches Slack and fails on Slack's answer; only a
  *disabled* installation is refused, because disabling clears the credentials and
  drops the row from `connectionForTeam`.
- **The acknowledgement reaction is added by the host control plane after
  admission and authorization but before context gathering**, and
  `already_reacted` is a successful retry.
- **At most one Rally reaction sits on a source message**, and a transition
  removes only the emoji Rally itself last placed — never whatever it finds
  there, which would take a member's reaction with it.
- **The outcome reaction is applied by the delivery path, not by the rotation.**
  Delivery runs on every terminal status, so the message ends correct even when
  the ticker never started or was lost; that is what makes the rotation
  discardable.
- **Attribution is not authorization.** An unlinked author's task still runs with
  the workspace principal, and the opening message keeps its external Slack actor.
- **Only connector ingress sets `principal: "connector"`, and only after
  verifying the link and membership on the message being delivered.** The
  work-stream object re-checks membership alone, so the ingress's
  `linkedAccount` check is the link's one gate; a path that hands out the
  marker without it has nothing behind it. Sockets never carry a connector
  principal — every ticket issuer refuses one at the mint.
- **A thread belongs to its Slack conversation, not to one member.** Its work
  stream is public for a public channel and private for anything else, a private
  one's room is the conversation's members, and anybody in the conversation may
  continue it. Each message runs as whoever sent it, and only a confirmed account
  link authorizes running as a member, except a reply bound to a Sidekick run
  ([`connectors.md`](connectors.md#invariants)).
- **Routing is the binding, not the session row.** A path that decides where a
  message goes from `slack_agent_sessions` instead of
  `resolveExternalConversation` will miss every room link and every Sidekick
  run's thread, and send their replies to a new Agent work stream.
- **The bot is only where it was invited or where a Sidekick source needs it.**
  A join Rally makes on its own reads, to everyone in the room, as an
  invitation it never received.
- **The persisted Rally run is canonical.** A Slack delivery failure never
  rewrites a completed run as failed.
- **The `action_token` is hidden run authorization** and never enters a prompt,
  the transcript, Slack session context, tool input, tool output, or the
  inference-payload log — which is disabled outright once a Slack search result
  enters model context.
- **Nearby Slack content is model-visible as explicitly labelled untrusted
  evidence**, never as system instructions.
- **Unrelated channel messages are discarded before durable queueing.** Slack
  offers no thread-only event filter, so the filtering is Rally's job and it
  happens before anything is stored.
- **Rally never becomes a parallel Slack.** No inbox, channel browser, history
  store, or generally searchable replica — see
  [`provider-apps.md`](provider-apps.md#the-zero-copy-connector-boundary).
- **No installation becomes the implicit default when more than one is
  available**, and Rally never silently switches accounts or Slack workspaces.
- **Every work-stream link Rally posts is the canonical HTTPS form.** Slack
  delivers `link_shared` only for the registered unfurl domain, so an `rallywithai://`
  link pasted by a member produces no event and can never be previewed.
- **Modal submissions are validated server-side**, and modals never request Rally
  or provider passwords.

- **Every Slack result delivery reduces citations before splitting.** The one
  complete-message path calls `slackDeliveryMarkdown` before building its
  `chat.postMessage` chunks. Folding it into the chunker instead
  looks tidier and is wrong: the footnote pass would renumber a chunk against
  definitions it could not see.
- **The chunker's fence tracking is its own, and closes only on a bare run.**
  Every rewriter in the repository reads
  [`markdown-code.md`](markdown-code.md), whose close rule is deliberately
  looser — any run of the opener's character at least as long, info string or
  not. `nextFenceState` is not a reader of it, for two reasons: it keeps the
  whole opening *line* rather than the marker, because it has to replay it at
  the top of the next chunk; and a fence it wrongly believes closed severs a
  code block in a message that has already been delivered, where nothing heals
  it. The desktop's streaming splitter made the opposite trade because its
  equivalent artifact lasts only until the turn completes. Converging this one
  is a delivery change, not a tidy-up.

## Boundary

This document owns Rally's Slack product surface: the two connections, the
ingress, linking, Agent sessions, App Home, interactions, and delivery. It does
not own:

| For | Read |
| --- | --- |
| Every scope and its model-tool mapping | [`slack-permissions.md`](slack-permissions.md) |
| The registration and its secrets | [`provider-apps.md`](provider-apps.md) |
| The zero-copy definition this obeys | [`provider-apps.md`](provider-apps.md#the-zero-copy-connector-boundary) |
| Connector-wide adapter rules and health semantics | [`connectors.md`](connectors.md) |
| The shared actor-identity resolution behind attribution | [`connectors.md`](connectors.md#actor-identity-and-work-stream-attribution) |
| The unfurl card, its audience rules, and the refresh sweep | [`workstream-links.md`](workstream-links.md) |
| Frozen automation delivery targets | [`workstream-email-addresses.md`](workstream-email-addresses.md#outbound-automation-results) |
| The configured deployment boundary the shared ingress sits on | [`regionalization.md`](regionalization.md) |
| The run a Slack prompt starts | [`agent-harness.md`](agent-harness.md) |

## Failure modes and limits

- **A job that failed on authorization is classified non-retryable and pinned at
  the attempt ceiling**, which is right while a grant is dead and wrong the moment
  it is not. `redriveReauthorizedIngress` re-queues such a job once its connection
  has been written again, which a reauthorization always does; it is self-limiting,
  because a re-driven job that fails again stamps itself newer than the connection.
  Without it, events that arrived during an outage stayed failed forever with their
  payload still on the row — and a `link_shared` Slack reports exactly once is never
  redelivered, so the message keeps its bare URL permanently.
- **A personal connection's Slack identity comes from `auth.test`, not from the
  OAuth body.** Slack publishes no response shape for `oauth.v2.user.access`, so
  `authed_user.id` is present or absent at its discretion. Reading it and
  failing when it is missing is what made every personal connection fail after
  the member had already approved the grant. `auth.test` names the principal a
  token belongs to, needs no scope, and is consulted only when the body named
  nobody — where it also supplies the granted scopes, since a body that names no
  user often names no `scope` either and `refreshCredentials` carries a stored
  empty set forward on a personal connection rather than rediscovering it. What
  the authorization itself granted always wins; the recovery only fills a gap.
- **Every OAuth callback failure carries the phase that produced it.**
  `classifyConnectorOAuthCallbackFailure` relays `oauthStage` and drops provider
  messages, so an unreachable Slack, a non-JSON body, and a `{ok: true}` body
  with no usable identity used to log one indistinguishable
  `connector_code: "provider_error"`. `slackOAuthCallbackStage` fills that
  field; read `stage` with `provider_error`, `provider_status`,
  `response_invalid`, `response_issues` — the failing paths of a body that did
  not parse, never its values — and `timed_out` on
  `connector_oauth_callback_failed`.
- **Retries with the same `event_id` and body are acknowledged once; reuse of an
  event ID with different content is a conflict.**
- **A denied prompt is retained regionally for at most 24 hours** so the same
  member can reply `try again` after the problem is fixed. It is deleted when a
  session starts, and expired rows are removed by scheduled maintenance. A narrowly
  matched, explicitly mentioned retry of a denial created *before* this mechanism
  may read at most the first 15 messages in that single thread to recover the
  prompting mention; unmentioned messages in other threads are ignored.
- **A spent link challenge is kept for a day, then reaped.** Expired or
  consumed, the row stays 24 hours so a late click is refused with its reason
  rather than as a link Rally has never seen, and the `slack_ingress`
  maintenance pass removes it after that. The workspace alarm counts a
  challenge as due at exactly that horizon, and the reap has to remove what
  that expression counts, or the alarm comes straight back for the row it just
  failed to remove. Ingress jobs have a longer horizon by design: a completed
  job and an exhausted one are history, kept 30 days, and the schedule counts
  them at that horizon.
- **An ingress job that reaches the 20-attempt ceiling is reported, once.**
  Every failure is a `slack_ingress_queue_processing_failed` row already; the
  failure that pins the job — a non-retryable error, or the twentieth attempt —
  writes `slack_ingress_job_exhausted` at `error` and posts it to the operator
  channel when one is configured ([`ops-alerting.md`](ops-alerting.md)) — once
  per installation and error code within an hour, since a broken installation
  fails every event the same way. The claim refuses a job at the ceiling, so
  the Queue's redelivery of the message that threw is acknowledged without
  running it again. Nothing processes such a job again without a
  reauthorization re-drive. The maintenance pass logs the standing count as one
  `slack_ingress_exhausted_jobs` row, not one error row per job per pass.
- **A missing `reactions:write` discovered mid-prompt does not stop the task.**
  Rally continues and marks the installation for reconnect.
- **A challenge that cannot be redeemed is refused with the reason**, not a generic
  expiry: `slack_link_unknown`, `slack_link_consumed` (used or superseded),
  `slack_link_expired`, `slack_link_workspace_mismatch`, and
  `slack_installation_disabled`. Only the first three are answered by clicking
  **Connect Rally** again; a disabled installation needs a Rally workspace owner
  or admin to re-enable it.
- **An identity-link insert is refused only when the Slack identity already belongs
  to a different Rally member.** The personal connection still stands in that case,
  because resolving the conflict is not that operation's business.
- **Suspended members and revoked links cannot start or continue tasks.** A
  revoked link does not lock somebody out of a thread, though — it drops them to
  the workspace principal, the same as any unlinked member.
- **`connector_member_revoked` on an ingress job is a race, not a state.** A
  member already removed never presents a connector principal — `linkedAccount`
  resolves them to no link and the message runs under the workspace principal —
  so the object's refusal is reachable only when a membership or role change
  lands between the ingress's read and the object's re-check. The job stays
  retryable: the retry re-reads the link and either runs at the new role or
  answers under the workspace principal. The code is deliberately not in
  `SLACK_AUTHORIZATION_ERROR_CODES` (reauthorizing Slack does not restore
  Rally membership), and it does not mark the installation `needs_reconnect` —
  one member's refusal says nothing about the workspace's grant. The same
  retryable classification covers `invalid_product_request`, the one-deploy
  window where a new Worker names a principal an old object script refuses.
- **A private conversation's roster is read once and best effort.**
  `conversations.members` needs `groups:read`, which an installation that has not
  reconnected does not have, and it is bounded at 200 members. Known identities
  resolve in one D1 read; only unresolved members call `users.info`, six at a time
  under one shared ten-second deadline. A failure or a larger channel costs a
  smaller starting room, not the prompt: everybody else is seated when they first
  reply.
- **Existing workspace installations must reconnect after a scope expansion**
  before health checks and tool calls succeed. Until the identity scopes arrive,
  lookup-based mentions are not sent to Slack, and nothing is sent in their place.
- **Result content is never streamed to Slack.** After Rally reloads the saved
  canonical turn, the reply is posted in complete 12,000-character
  `chat.postMessage` chunks. A pending elicitation is rendered from its saved
  canonical elicitation turn, not from the live model or the request row alone.
- **A reaction failure never touches the run.** A missing `reactions:write`
  discovered mid-run leaves whatever is on the message; a rate-limited rotation
  step keeps the current emoji and tries again on the next tick; a configured
  emoji Slack rejects falls back to Rally's default for that state.
- **The rotation parks after 50 steps.** A backstop for a ticker whose run
  vanished without reaching delivery, not a policy — the liveness check ends the
  rotation as soon as the run does.
- **Message-context reads are bounded** — up to eight nearby messages on a prompt,
  and the per-tool bounds in [`slack-permissions.md`](slack-permissions.md).
- **SSE responses on Slack's Streamable HTTP MCP endpoint are parsed**, but
  Rally never falls back to a separate legacy SSE endpoint.
- **Revoked Gmail or Slack authorization marks the run or destination
  `needs_input`**; transient Slack delivery errors remain retryable and do not
  disable the destination.
- **Disconnecting does not delete existing Rally resources.** Workspace disconnect
  revokes the credentials Rally holds and disables routing; a Slack administrator
  separately removes the app from Slack App Management to uninstall it. Task and
  automation resources do not expire automatically and remain until an authorized
  user deletes the resource or the workspace is deleted.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test/slack-agent-ingress.test.ts` | Signature verification, the replay window, dedupe, the ingress job written before acknowledgement, and the manifest read from `config/provider-apps/slack.json`. |
| `packages/connectors/src/slack.test.ts` | The two authorization flows kept apart, the personal identity resolved from `auth.test` when the OAuth body names nobody, that a body which does name one spends no extra call, and the stage each callback failure is attributed to. |
| `packages/connectors/src/slack-reactions.test.ts` | Override resolution, partial inheritance, the malformed-override fallback, and the rotation's wrap. |
| `packages/connectors/src/slack-markdown.test.ts` | Block rendering, the notification fallback, and every split rule including the reopened fence. |
| `apps/api/test/slack-account-link.test.ts` | Both routes to a link, mint-on-click, retirement ordering and its mint-time bound, and each refusal reason. |
| `apps/api/test/slack-workstream-creator-attribution.test.ts` | Creator resolution and the one case where an existing creator is rewritten. |
| `apps/api/test/slack-thread-audience.test.ts` | The conversation's visibility and room, bounded roster enrichment, participant events, per-message delivery routing, shared feedback controls, a second linked member continuing a thread, and an unmapped Slack member's reply. |
| `apps/api/test/slack-connection-health.test.ts` | That a stored status diagnoses rather than gates. |
| `apps/api/test/slack-notification-service.test.ts` | The lookup-based DM path and the cases it skips. |
| `apps/api/test/slack-routing.test.ts` | The Global team route and the regional hand-off. |
| `apps/api/test/slack-unfurl-refresh.test.ts` | The unfurl card and its refresh sweep — owned by [`workstream-links.md`](workstream-links.md). |
| `apps/api/test/slack-workspace-assignment.test.ts` | The one-team-one-workspace invariant, the ingress re-drive, the link-challenge reap and the `slack_ingress` due time it clears, the operator notice an exhausted job posts, and the connector principal: a linked member's create and reply present exactly the marked auth to the object, and the object's refusal stays retryable without flipping the installation. |
| `apps/api/test-workers/workspace-slack-ingress.test.ts` | The ingress spine on real workerd: admission and its dedupe, the claim lease and both settlement fences, the one-notice exhaustion episode, the maintenance sweep, thread claims, pending prompts, and the workspace identity fence. |

Run one with
`pnpm --filter @rally/api exec vitest run test/slack-agent-ingress.test.ts` — the
path is package-relative.

The trap is signature fixtures: verification runs over the **untouched raw body**,
so a test that re-serializes a payload before signing it passes while the
production path fails on the same delivery.

### Developer test setup

Use a separate development Slack app and a paid Slack test workspace. Do not
point the Marketplace app at a temporary tunnel or install a CLI-issued bot
token directly into Rally; the Rally Settings OAuth flow must receive and
store the installation.

For a Global-only local acceptance pass:

1. Install dependencies, copy `.env.example` to `.env.local`, and set an
   `OPENROUTER_API_KEY`.
2. Run `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev`, and `pnpm dev:site`.
3. Expose `http://127.0.0.1:8787` through one stable public HTTPS tunnel. The
   tunnel must forward the OAuth callback and all three Slack ingress paths.
4. Create a development app in Slack, then copy its App ID, Client ID, Client
   Secret, and Signing Secret to `SLACK_APP_ID`, `SLACK_CLIENT_ID`,
   `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` in `.env.local`. Also set
   `PUBLIC_API_BASE_URL_GLOBAL` and `SLACK_INGRESS_BASE_URL` to the tunnel
   origin, run `pnpm env:sync`, and restart both local Workers.
5. Render a tunnel-specific manifest without changing the checked-in production
   manifest:

   ```text
   SLACK_MANIFEST_NAME="Rally Dev" \
   SLACK_MANIFEST_API_GLOBAL_BASE_URL="https://your-tunnel.example" \
   SLACK_MANIFEST_INGRESS_BASE_URL="https://your-tunnel.example" \
   node scripts/slack-manifest-hook.mjs > /tmp/rally-slack-dev.json
   ```

6. Paste `/tmp/rally-slack-dev.json` into the development app's **App
   Manifest** editor. Slack will verify the now-live Events request URL. Link
   the app to this project if CLI diff/sync is desired:

   ```text
   slack app link --team <TEAM_ID> --app <APP_ID> --environment local
   ```

   Always pass the same three `SLACK_MANIFEST_*` overrides when syncing that
   development app.
7. In the Rally desktop, sign in as a workspace owner/admin and open **Settings
   → Connections → Rally Agent for Slack → Connect for workspace**. Complete this OAuth flow even
   if Slack already shows the app in the test workspace; it creates Rally's
   encrypted connection and team route. Do not substitute `slack app install`.
8. Open the app's Home tab in Slack, choose **Connect Rally**, and let the local
   site hand off the one-time fragment token to the signed-in desktop. Reopen
   Home and confirm the linked member view.
9. Optionally choose **Slack → Connect only for me** in Rally Settings to authorize
   the personal hosted-MCP tool plane.

The local site is required for account-link handoff because development sets
`PUBLIC_WEB_BASE_URL=http://127.0.0.1:5174`. The browser and desktop must run on
the same Mac. Slack requires public HTTPS OAuth redirects, so a localhost-only
API is insufficient. A temporary tunnel URL also requires regenerating and
resaving the test manifest after every URL change.

Run the acceptance matrix in `docs/e2e.md`, beginning with App Home/linking,
Agent DM and thread continuation, mention, both shortcuts, `/rally`, signature
replay, workspace search/read/write tools, personal MCP authorization, multi-workspace routing, and the Gmail
briefing's three/one/zero-result cases.

### Deployment and Marketplace gates

1. Set `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` in configured regional Workers. Keep the public app identity identical.
2. Deploy migrations through `0046` and both Workers, including the configured deployment Slack service bindings and `slack.rallywith.ai` custom domain.
3. Run `slack manifest validate`; then create/update the Marketplace app from `config/provider-apps/slack.json`.
4. Reconnect existing Slack workspace installations so Slack grants the expanded bot scopes, then exercise the acceptance cases in `docs/e2e.md`.
5. Confirm paid-plan eligibility for Agent/automation features and document the `team.billing:read` use in review materials.
6. Provide working privacy, support, installation landing, pricing, AI disclosure, data-use, and deletion pages. Respond to support within two business days.
7. Before submission, meet Slack's active-workspace and weekly-active-user thresholds, complete preliminary review, and budget for functional review.
8. Submit the exact scopes and test credentials/instructions. Explain why broad user scopes are optional and user initiated, why public-channel membership does not ingest ordinary channel traffic, how account linking works, and how automation approval/delivery binding works.

The checked-in manifest passed Slack CLI 4.6.0 `slack manifest validate` on 2026-08-06. Slack later made PKCE immutable for this app. CLI 4.6.0 strips `pkce_enabled` from its validation request even when the generated manifest contains `"pkce_enabled": true`, so the API interprets the omission as an attempt to disable PKCE. Until the CLI preserves that field, validate and apply production changes through Slack's App Manifest editor instead. Validation does not replace deployment or Marketplace review.

## Changelog

### 2026-11-02 — The connector's send tool posts through the `markdown` block

**What changed:** `send_message` in `packages/connectors/src/slack.ts` builds its
payload with `slackMarkdownMessages`: a `markdown` block carrying the body, with
stripped `text` as the notification fallback. Its schema now asks the model for
standard markdown instead of mrkdwn, and refuses a whitespace-only body, which
would otherwise render to no message at all.

**Why:** The tool still sent the model's text as `chat.postMessage`'s `text`,
which Slack reads as mrkdwn. A daily signup report a Sidekick posted to a channel
showed every table row as literal pipes, because mrkdwn has no tables. The
2026-08-22 entry moved Rally's own reply and result paths to the `markdown`
block but left this path behind. Slack's markdown block reference now lists
tables as rendered.

**Considered and rejected:** Lowering the tool's 40,000-character cap to the
block's 12,000. That cap is a limit the team set, and splitting through the
existing helper keeps long posts working without changing it.

**Consequences:** A long post now arrives as several messages instead of one, and
a failure partway leaves the earlier chunks posted; the receipt-derived
`client_msg_id` on each chunk is what a retry has to dedupe on. Slack's markdown
block reference does not say whether `<@U…>` mentions and `<#C…>` channel links
render inside the block. The tool still tells the model to use them, and that is
unverified against a live workspace.

### 2026-10-06 — Each run's outcome follows its own message and member

**What changed:** Admission records the run's status-reaction anchor on
`slackOrigin.reactionAnchor`, and delivery passes it to the outcome transition.
`settleSlackSessionReaction` now also requires the expected `channelId` and
`messageTs`, and its `UPDATE` matches them alongside `reaction_current`.
SubstreamAgent migration 73 adds `run_absorbed_slack_origins`, written when a
steer is promoted into a live run, and delivery settles those messages too. A
linked member's elicitation answer now carries `slackOrigin` into the run it
starts. Delivery also passes `slackOrigin.actorSlackUserId` as the triggering
member, so a needs-input connect prompt reaches whoever sent the message.

**Why:** A follow-up admitted while an earlier run was live moved the session's
one slot to its own message with the same `eyes` emoji, and the settle compared
only the emoji. The earlier run's outcome could land on the follow-up's message,
or its own message kept `eyes` while the follow-up later gained a second Rally
reaction. Raised by Copilot on #1123. Separately, the 2026-08-15 entry routed
the connect prompt to the triggering member, but the settlement path in
`SubstreamAgent` no longer passed that member, so every prompt fell back to the
thread's opener. When the wiring was lost was not recorded. Review of this
change found two more paths where a message had no run of its own carrying its
origin: an unlinked member's follow-up steered into a live run, and a linked
member's elicitation answer.

**Considered and rejected:** An anchor generation column on
`slack_agent_sessions`, captured at admission and matched on settle. It needs a
migration and still has to travel with the run, and on its own it cannot say
which message the earlier run should swap once the slot has moved. The anchor
itself answers both. Carrying the emoji admission placed in the anchor was also
rejected: `slackOrigin` is hashed into the message's admission receipt, and a
retry can see a different acknowledgement result, which would turn it into
`substream_message_idempotency_conflict` (raised by Codex on this change).
For steers, making Slack follow-ups on a live run queue instead would give each
its own run, but steering is how an unlinked member's reply reaches the work in
progress, and that is a product behavior this change should not move.

**Consequences:** Once the slot has moved, the earlier run removes the
connection's configured acknowledgement, not the slot's emoji, and writes
nothing back. If the acknowledgement was changed between admission and
delivery, or fell back to Rally's default because Slack rejected its name, the
old emoji can stay beside the outcome. `run_absorbed_slack_origins` is never
pruned: one small row per steered Slack message, kept for the conversation's
life. Runs admitted before
this change carry no anchor and keep the old slot-only behavior until they
drain. A run that a follow-up supersedes (`superseded_by_follow_up`) still
delivers no outcome, so its message keeps the acknowledgement.

### 2026-10-06 — The rotating working reaction was removed

**What changed:** The working reaction that cycled `brain` → `mag` →
`writing_hand` → `gear` while a run was live is gone, along with the
`SlackReactionTicker` Durable Object that drove it. Wrangler migration `v14`
deletes the class and every object in its namespace. The acknowledgement now
stays on the message until delivery swaps in the outcome reaction.

**Why:** Removed at product request; the reasoning was not recorded.

**Considered and rejected:** Placing one fixed working emoji in place of the
rotation. It adds a transition and a Slack call per run for no information the
acknowledgement does not already give.

**Consequences:** `slack_agent_sessions.reaction_cursor`
still exists in WorkspaceDO's released SQLite migrations but nothing reads or
writes it. A reaction override saved with `working` or `workingIntervalMs` still
parses; those keys are accepted and ignored so the override's other states
survive. Bringing a rotation back needs a new class name, since `v14` retires
`SlackReactionTicker` for good.

Shipped in #1123.

### 2026-09-27 — Bindings route Slack messages, and the bot joins only where it is wanted

Routing moved from `slack_agent_sessions` to external conversation bindings, the
bot stopped joining public channels on its own, and a reply to a Sidekick's
request reaches its run. The why, the alternatives and the consequences are
recorded once, in [`external-conversation-bindings.md`](external-conversation-bindings.md#changelog);
the authority exception in [`connectors.md`](connectors.md#invariants).

Shipped in #1006. Design: `docs/PRDs/2026-09-23_external-conversation-bindings/`.

### 2026-09-01 — Slack handoffs retain their Rally workspace

**What changed:** Link challenges, App Home settings/automation buttons,
work-stream links, result controls, and refreshed unfurls all emit the Slack
installation's regional Rally workspace. The desktop activates that workspace
before redeeming or navigating, and an unfurl refuses a current URL addressed to
another workspace while retaining legacy ID-only history support.

**Why:** A member could open the Slack handoff after switching Rally workspaces.
The challenge itself was server-bound and therefore safe, but the desktop sent it
to the active workspace and produced a mismatch; static buttons and resource
links had the same active-relative ambiguity.

**Considered and rejected:** Letting the challenge error identify the correct
workspace, or searching every stored credential. Both discover tenancy only
after acting on a bearer or resource ID. Slack already names the installation
that minted the link, so carrying its target is direct and deterministic.

**Consequences:** Slack may switch Rally's foreground workspace when a member
follows an explicit button. The target is not authorization: challenge binding,
active membership, and the regional resource checks still decide access.

Shipped in #464.

### 2026-08-29 — Slack result delivery becomes saved-turn-only

**What changed:** Agent ingress no longer calls `chat.startStream`, and terminal
delivery never calls `chat.appendStream`. It reloads the exact persisted final
turn, or the canonical elicitation turn for `needs_input`, and posts it as
complete `chat.postMessage` chunks. A session carrying a
pre-deployment `slack_stream_ts` is closed without appending content, then the
saved turn is posted normally. The typed session API can clear that legacy
pointer but cannot set a new one, and current sessions do not incur a no-op
clear write. A terminal run with no saved turn clears status and reactions but
posts no result or controls.

**Why:** Opening a stream created an empty Slack shell before Rally had a result.
One completed run then failed terminal settlement because its structured
assistant turn ID was rejected as a UUID, so delivery never filled the shell.
The deeper fault is the authority split: partial provider writes can outlive or
disagree with Rally's durable transcript.

**Considered and rejected:** Appending only after persistence while retaining
the already-open stream. The empty shell is itself an external write, and an
ambiguous append still creates a partial second transcript. Also rejected:
special-casing only this Slack surface; [`connectors.md`](connectors.md) makes
saved-turn-only delivery the rule for every external conversation or comment
adapter.

**What a future change has to respect:** Working status may be live; response
content may not. Keep `chat.stopStream` only while old session rows can carry a
stream pointer, and do not restore start or append methods to the connector API.

### 2026-08-29 — The agent-session lifecycle became typed WorkspaceDO methods

**What changed:** Thirteen more typed methods on WorkspaceDO
(`workspace-slack-protocol.ts` / `workspace-slack-storage.ts`): reading a
session by id, by thread, or by work stream; the interaction preflight;
creating one; seating a member across every workspace-scoped session a Slack
user owns; the delivery key and the stream pointer; the status reaction's
compare-and-set and its re-anchor; the App Home context; and interaction
feedback. `SlackAgentService` calls them instead of sending nineteen statements
through the workspace runtime facade, and `slack_agent_sessions`,
`slack_agent_contexts`, and `slack_agent_feedback` join
`WORKSPACE_TYPED_RPC_ONLY_TABLES`, so a generic statement naming one of them is
now refused by name rather than executed. Still on the facade, deliberately:
delivery preferences, agent policies, user links, the link-challenge mint and
redeem flow, unfurls, and everything joining `connector_connections`.

**Why:** The routing hazard part 1 describes is unchanged — a typed method
cannot be routed to the wrong database — but two of this area's decisions were
also being made from `meta.changes`, the physical-write counter
[`docs/durable-object-sqlite.md`](durable-object-sqlite.md) forbids deciding a
logical outcome from. Both statements were otherwise correct, and their
predicates are carried forward unchanged; what moved is how each one's outcome
is decided.

Seating was the worse of the two. The service read the sessions an email match
could claim and then updated them, as two statements over the same predicate,
and took the count it reported from the update's `meta.changes`. A session
seated between the two reads was reconciled against a snapshot that no longer
described it, and one created between them was updated without being reconciled
at all. `assignSlackSessions` runs both inside one `transactionSync` and answers
with the previous holder and method each row actually moved *from* — which
`reconcileSlackWorkstreamIdentity` needs, and which `RETURNING` cannot give,
since it yields the new row.

The status reaction is a compare-and-set that spans a Slack API call, so it
cannot be one transaction; what it can be is honest about whether it won. The
predicate was already right — `reaction_current IS ?`, with `IS` rather than `=`
because NULL is a real state meaning Rally has placed nothing — and it is kept
verbatim. What was wrong is that `slack_outcome_reaction_raced` was logged when
`meta.changes` came back zero, and `meta.changes` is `rowsWritten`: index
maintenance inflates it, so it cannot establish which transition won even when
the predicate matches exactly the right row. `settleSlackSessionReaction`
returns the updated row as a witness and reports `raced` as that witness's
absence.

Feedback is the milder case, and it is worth being precise about: the insert
already carried `ON CONFLICT(ingress_job_id) DO NOTHING` and was right to. It
simply discarded the result, so a redelivered submission and a first rating were
indistinguishable to the caller. `recordSlackFeedback` returns which one
happened, and the service logs `slack_feedback_replayed` on the replay — the
only use that outcome has, and the reason for returning it rather than leaving
another value nobody reads.

**Considered and rejected:** Patching the Node fixtures row by row so that the
converted assertions kept passing. The unit of coherence is the fixture, not
the row: a test that seeds `slack_agent_sessions` in its regional fixture and
seats them through the object is asserting on a database the write never
reaches, and passes only while nothing reads the row back. The three tests that
covered this area moved wholesale onto a real `createTestWorkspaceDO`, with the
sessions — and the `connector_connections` row their foreign key requires — in
the object's own store.

**Consequences:** These three tables are refused by name now, so a new generic
statement naming one fails loudly at the object rather than executing against
storage nobody meant to reach generically; new session state belongs in the
protocol and storage files. Four Slack tables are deliberately *not* on that
list — `slack_ingress_jobs`, `slack_agent_thread_claims`,
`slack_agent_pending_prompts`, and `slack_link_challenges` — because the
schedule's alarm-target derivation in `workspace-schedule-execution.ts` still
reads their due times generically through this object's local executor,
alongside the other alarm sources.

None of the three tables is an alarm source, so unlike the ingress spine's
mutations these methods deliberately do not call `refreshScheduleAfterSlackWrite`
— there is no target whose due time they could stale. That stops being true the
moment a schedule target reads one of them.

The feedback modal's `private_metadata` is checked against
`z.string().uuid()` before it reaches a typed method
(`slackModalWorkstreamId`). The generic statement this replaced simply matched
no row for a malformed value and fell into the modal's "this task is no longer
available" branch; `IdSchema` would instead fail the parse inside the object and
surface as a 500 with no modal response. Rally writes that field itself, so this
is a guard on a case that should not arise — but it is a strictly worse failure
mode than the one it replaced, and the graceful branch is worth keeping
reachable.

`assignWorkspaceWorkstreamsForMember` seats each Slack connection inside its own
`try`, separate from the one around the Slack email lookup. The two must stay
separate in both directions. Sharing the lookup's `catch` reported a WorkspaceDO
write failure as `slack_member_assignment_lookup_failed` and returned a success
count for seating that never happened; sharing the loop's exit instead — letting
the write throw — abandons every remaining connection in a workspace over one
transient object error, where only the failing connection should be skipped. The
seating `catch` logs `slack_member_assignment_seating_failed` and continues, so
the diagnosis is separable and the blast radius is one connection. The count this
returns is discarded by its only caller, which already logs at `warn`, so the
value of the split is entirely in which event name fires and how much of the loop
survives — not in what the count says.

Shipped in the facade-to-RPC stack, 9/9 part 2.

### 2026-08-29 — The ingress spine became typed WorkspaceDO methods

**What changed:** Admitting an ingress job, claiming it for processing,
settling it as completed or failed, the recovery scan, the maintenance sweep,
thread-initialization claims, pending prompts, and the bare-reply routability
read are typed methods on WorkspaceDO
(`workspace-slack-protocol.ts` / `workspace-slack-storage.ts`), and
`SlackAgentService` calls them instead of sending those statements through the
workspace runtime facade. The facade still carries the rest of the Slack
domain — sessions, contexts, feedback, delivery preferences, user links, the
link-challenge mint/redeem flow, unfurls, and every statement that joins
`connector_connections` — and the Slack tables stay on
`WORKSPACE_LOCAL_TABLES` so a stray generic statement still reaches the object
rather than falling through to D1.

**Why:** The facade routes by the table names it finds in the SQL, and this
domain has already been burned by that twice: `slackUserIsLinked` joined
`slack_user_links` to `workspace_members` and executed inside an object with
no such table, failing every run-outcome delivery in production, and the
`automation_directory` gap in the router's list answered
`no such table` from D1 (#401). A typed method cannot be routed to the wrong
database. The spine was converted first because it is where the claim shapes
live: the enqueue decided "duplicate" from the adapter's `meta.changes` —
the physical-write counter `durable-object-sqlite.md` forbids — and the
exhaustion notice read for a sibling episode in a second statement, so two
jobs exhausting at once could both notify. Both are now single transactions
answering from returned witnesses, and the job and thread leases are minted
inside the object.

**Considered and rejected:** Converting the whole domain at once. Sixty-odd
statements at this quality bar (real-object Node fixtures, workerd coverage,
every test proven able to fail) is more than one reviewable change, and the
session, link, and unfurl areas lean on `connector_connections` joins whose
home is decided by that domain's own conversion. Also rejected: passing the
caller's lease ids and attempt ceiling over the RPC — the object owns
lifecycle time and randomness per `durable-object-sqlite.md`, so callers carry
only the lease they were handed.

**Consequences:** New ingress lifecycle states belong in the protocol and
storage files, not in service SQL — the object refuses nothing yet, so a raw
statement naming these tables still executes, and adding one reopens the path
this closed. The attempt ceiling is one exported constant,
`SLACK_INGRESS_ATTEMPT_LIMIT` in `workspace-slack-protocol.ts`, interpolated by
the claim and recovery SQL inside the object, by the reauthorization re-drive in
`slack-agent-service.ts`, and by the alarm's due-time arm in
`workspace-schedule-execution.ts` — it sits in the protocol rather than beside
the claim so a service can import it without dragging `DurableObjectStorage`
along. It was briefly three literals with a comment saying they must move
together; a comment is only as good as the next person reading all three files.

Typed *mutations* re-derive the workspace alarm the way `executeRuntimeSql` did,
so a mutating method added to this family must call
`refreshScheduleAfterSlackWrite` or its table's due time goes stale — but two
exceptions are load-bearing and must be preserved. Reads never call it. And
neither does `sweepSlackIngress`, whose only caller is the `slack_ingress`
maintenance target: that runs inside this object's own alarm drain, whose
statements go through the local executor and so never carried the auto-refresh,
and whose end-of-drain `schedule_reconcile` is the authoritative pass. A
`waitUntil` refresh started mid-drain reads the target list before later targets
advance their rows and can land after that reconcile, replacing a correct index
with a stale one — the failure the comment on the end-of-drain refresh exists to
prevent. Mutating methods additionally gate the refresh on an outcome that moved
a row: `executeRuntimeSql` could not, because it keys on table names in the SQL
text and cannot see whether the statement matched anything, so a losing claim
or a stale settlement paid for a full reconcile there.

`processQueuedIngress` and `maintainIngress` now require the workspace id as a
leading parameter — the legacy trailing-optional forms are gone, and with them a
runtime throw no caller could reach.

The recovery scan's predicate mirrors the claim's, and must keep doing so: it
re-enqueues what that claim will take. The facade statement applied the attempt
ceiling to every row including a `processing` one whose lease had expired, which
the claim reclaims regardless of attempt count. That stranded a job whose worker
died on its twentieth attempt — permanently `processing`, permanently due
because the alarm reads a processing row's due time as its `lease_expires_at`,
never re-enqueued, and taken by no reap — so the alarm woke, swept nothing, and
re-armed on the same instant. Fixed here by scoping the ceiling to
`queued`/`failed`.

Still on the facade, deliberately: everything listed under "what changed" as
remaining, for a later part of this stack.

Shipped in the facade-to-RPC stack, 9/9 part 1.

### 2026-08-28 — The shared code classifier landed, and the chunker deliberately stayed out of it

**What changed:** nothing in `slack-markdown.ts`. `rewriteCitationsAsPlainText`,
which `slackDeliveryMarkdown` calls on both delivery paths, now gets its answer
about which lines are code from `@rally/contracts/markdown-code` instead of the
classifier private to `citations.ts`. Its output is byte-identical over the
15,625-document differential recorded in
[`markdown-code.md`](markdown-code.md), and the block rendering, the split rules
and the reopened fence are untouched.

**Why:** five rewriters each had their own answer to that question, and
[`markdown-code.md`](markdown-code.md) records collapsing them. The chunker's
`nextFenceState` is the sixth and is deliberately not among them — recorded
here, and as an invariant above, so that the next person to find it knows it was
considered rather than missed.

Two things make it a different question from the one the shared module answers.
It stores the opening *line*, info string and all, because a chunk boundary
inside a block has to close the block and reopen it at the top of the next
chunk. And it closes only on a **bare** run, where the shared rule accepts
trailing text: the shared rule errs toward reading a line as code because its
readers' worst case is a line left un-rewritten, while this one's worst case is
a code block severed across two messages already posted to a channel, which no
later render repairs. The desktop's streaming splitter gave up the same strict
closer in this change, because its artifact lasts only until the turn completes;
this one's would not.

**Consequences:** one private copy of the fence machine still exists, on
purpose, and the cost is that a change to what closes a fence has to be made in
two places if it is meant to apply everywhere. That is the accepted price of the
two rules having genuinely different failure costs; the alternative was trading
a transient rendering artifact for a delivery defect.

### 2026-08-28 — A notification's source list is written in words, not in Markdown

**What changed:** `slack-notification-service.humanReadableMessage` reduces with
`sources: "plain"` — a bare `Sources` line over `1. The memo — https://…` — while
`slackMarkdownMessages` keeps the Markdown shape.

**Why:** The two Slack paths do not render the same thing. `slackMarkdownMessages`
builds a `markdown` block; a mention notification posts to `chat.postMessage`'s
`text` field, which is mrkdwn and has neither `**bold**` nor `[label](url)`. The
reduction added for that surface therefore replaced one leak with another — a
literal `**Sources**` over a literal bracketed link, in front of the channel. Its
test passed because the fixture's only source was internal, which reduces to a
bare title; the fixture now carries an external one.

**What a future change has to respect:** Anything posting agent text outside a
`markdown` block wants the plain shape. The rule is what the *consumer* renders,
not which service the call sits in.

### 2026-08-27 — Agent output reduces its citations before it reaches a channel

**What changed:** `slackDeliveryMarkdown` reduces `resource://` chips and
embeds to their label text and GFM footnotes to numbered markers over one
trailing source list. `slackMarkdownMessages` calls it for the batched path; the
streaming path calls it itself. Both call it before splitting.

**Why:** Model answers began carrying citations, and Slack renders neither the
scheme nor footnote syntax — so without this, a grounded answer arrives in a
channel as raw internal URLs and literal `[^1]` markers, and an announcement
arrives as a broken image. The rejected shape was folding the reduction into
`splitSlackMarkdown`, which is where a reader would look for it: the footnote
pass has to see the whole body to number it, and a chunk whose definitions
landed in the next one would renumber against nothing.

**Consequences:** A third delivery path owes the same call — the streaming one
already proved that, since it bypasses the payload builder entirely and would
otherwise have leaked what the batched path did not. The function is idempotent
so a path that reduces twice is safe. Shipped in
[#381](https://github.com/juno-ai-labs/avalon/pull/381). Design:
[`docs/PRDs/2026-08-27_inline-resource-citations/prd.md`](PRDs/2026-08-27_inline-resource-citations/prd.md).

This document predates the [module document](module-documents.md) convention and
had no changelog until the entries below; the reasoning behind everything above them
was not recorded and is not reconstructed here.

### 2026-08-25 — Slack notification routing is observable by destination

**What changed:** Person-notification delivery now logs every identity lookup,
resolved installation and Slack destination, opened DM, accepted message chunk,
terminal skip, complete send, and partial/provider failure. Correlation includes
Rally and Slack IDs but excludes notification content and email addresses.

**Why:** A drained activity Queue did not answer whether Slack was skipped for
an inactive or ambiguous recipient, accepted a message in an unexpected team or
DM, failed after a partial chunk, or was never reached. Those cases previously
collapsed into a return value consumed by the email fallback.

**Considered and rejected:** Logging only Slack API failures and logging the
recipient email or rendered message were rejected. The former leaves expected
terminal skips and successful-but-misdirected sends invisible; the latter adds
content that is unnecessary when stable provider IDs identify the destination.

**What a future change has to respect:** Every Slack notification branch needs
a stable, queryable outcome and destination IDs when known. Do not remove an ID
because it belongs to Slack; do not replace it with mutable profile fields or
message content.

### 2026-08-25 — The Slack app is Rally: `@Rally`, `/rally`

**What changed:** `config/provider-apps/slack.json` now registers the app and bot
as **Rally**, the slash command as `/rally`, and both shortcuts as "Start a Rally
task" and "Work on this with Rally". Every user-visible string the ingress emits
into Slack moved with them — modal titles, App Home copy, error and status
messages, and the retry prompt that names the mention.

**Why:** The manifest was the last place the product introduced itself to a user
as Avalon while every canonical public URL it pointed at was already `rallywith.ai`. It was left
until now because re-applying the manifest is a manual trip to Slack, and doing
it while the visible labels still said Avalon would have fixed the invisible half
and needed a second trip. The public app is already installed in the Juno Labs
Slack workspace, so the cut-over treats its channel history as durable external
state. The sharp edge is not the slash command: `SLACK_RETRYABLE_DENIAL_PREFIXES`
matches the text of the bot's *own earlier messages* to recover the prompt behind
a "try again". Renaming those prefixes outright would silently stop recovering a
denial posted before the deploy — the same durable-external-state shape as the
action ids, in prose rather than an identifier. The two denial prefixes emitted
by current Rally code are canonical for new messages, while the four historical
Avalon prefixes remain accepted inbound.

Deliberately unchanged: the two superseded OAuth redirect URLs and the
`with-avalon.com` entry in `unfurl_domains`, both of which keep links and
callbacks minted before the rename working. This historical entry originally
held `support_email` on `support@with-avalon.com` until a monitored Rally
alias was confirmed; the manifest has since moved to `help@rallywith.ai`.

The shortcut `callback_id`s moved in #294 and are inert: a Slack shortcut carries
no action id, so nothing in the ingress compares against them. The bot rename is
safe for the same structural reason mentions are matched by `<@bot_user_id>`
rather than by name, so `@Rally` resolves to the same identity Slack already has.

**Provider cut-over:** after the matching Worker build has reached configured deployments,
render the production JSON with `node scripts/slack-manifest-hook.mjs`, confirm it
still contains `"pkce_enabled": true`, and apply it through Slack's App Manifest
editor. CLI 4.6.0 currently strips that immutable field from validation and sync
requests, so `slack manifest validate` and `slack manifest sync --force` are not
safe for this app. Until the editor update is applied, the live app still presents
as Avalon and `/avalon` remains the registered command.

### 2026-08-24 — A personal connection stopped depending on a response shape Slack does not publish

**What changed:** The personal OAuth callback resolves the member's Slack user
id from `auth.test` when `oauth.v2.user.access` does not carry one, instead of
failing. `auth.test`'s response schema now types the `user_id` and `team_id` it
has always returned. Alongside it, `slackOAuthCallbackStage` attaches
`oauthStage` to every failure out of `handleAuthorizationCallback`
(`token_exchange`, `account_identity`, `workspace_eligibility`), and the two
throws that fire on an unusable-but-successful response carry
`responseInvalid`. The workspace flow is unchanged in behaviour; it only gained
the same attribution.

**Why:** Personal Slack could not be connected at all. Both
`connector_oauth_callback_failed` rows in the Workers Logs retention window —
2026-08-21T19:46:54Z and 2026-08-24T17:42:09Z, and three more before it, named
in `connector-oauth-error.ts` — are Slack, and every one of them logged
`connector_code: "provider_error"` and nothing else. That absence is what
located the fault: a Slack `{ok: false}` would have carried its error code, a
schema mismatch would have set `response_invalid`, and a non-2xx would have set
`provider_status`. None appeared, which leaves the throw sites that attach no
details at all — and of those, only `!accessToken || !userId` is deterministic
enough to fail five times across three weeks while the workspace flow, on the
same host through the same fetcher, kept succeeding.

The same absence says what the body *was*, and the narrower claim is the better
supported one. No `response_invalid` means the body satisfied
`SlackOAuthSuccessSchema`, which requires `team` — so Slack sent its own
envelope, `ok: true` with a team, and simply no user identity in it. Slack's
documentation does not publish what `oauth.v2.user.access` returns, describing
the method only as RFC 6749 compliant, which is a fair reason to expect an
identity to be optional; it is not evidence that what arrived was an RFC 6749
token response, and an earlier draft of this entry overreached by saying so.
Either way Rally was reading `authed_user.id` off a field Slack never promised,
and spending the member's grant to find out.

**Considered and rejected:** Guessing more keys — `user_id`, `user.id`, a
flattened `authed_user_id` — which is the same mistake at a wider aperture, and
whose failure mode is identical and equally silent. Relaxing
`SlackOAuthSuccessSchema` so a body without `team` still parses: the logs rule
that case out (it would have set `response_invalid`), so it would have been
untested code written against an imagined failure. Typing `team_id` on
`auth.test` alongside `user_id` falls to the same argument and was dropped in
review — the team is never the missing field, so a second source for it is one
more shape nothing reads, and it would have left `providerAccountId` assembled
from two authorities for no reason. Widening
`classifyConnectorOAuthCallbackFailure` to relay the provider's *message*: that
module's comment derives its safety from relaying only short identifier-shaped
codes from fields that hold codes by construction, and a message is where
providers quote the request back.

Left undone, and named here because it is the shared pattern rather than this
change: the stage wrapper's terminal branch relabels a Rally bug — a
`TypeError` inside a wrapped block — as `provider_error` with
`error_name: "ConnectorError"`, losing the one field that used to identify it as
ours. `granolaOAuthCallbackStage` has the same hole, and closing it means either
diverging from the shared pattern or adding a field to the classifier's relay
set, which this change deliberately avoided. It belongs in a change that fixes
both adapters.

**Consequences:** The identity lookup costs one extra Slack call, and only on
the path that was previously a dead end — a body carrying `authed_user.id`
short-circuits before it, which is asserted rather than left to inspection. Its
10-second timeout is the one the two sibling calls in the same function already
use, not a new number. The same response supplies the granted scopes when the
body carries none, so the connection is not stored with an empty grant that
`refreshCredentials` would then carry forward; a body that does carry `scope`
keeps it, and a test with a deliberately divergent `x-oauth-scopes` header pins
that precedence. If a personal connection still fails after this, the
failure now names its phase: `stage: "account_identity"` with
`response_invalid` means Slack returned a token and would not say whose,
`stage: "token_exchange"` with `provider_error` is Slack refusing the code, and
a bare `stage` with neither is the network. That is the diagnosis this incident
cost three weeks to reach by elimination.

### 2026-08-23 — A linked member's message stopped impersonating a login

**What changed:** The auth a linked member's ingress presents to the work-stream
object now carries `principal: "connector"`. The object verifies that principal
against current active membership in its region (`connectorPrincipalAuth`) and
refuses a stale one as `connector_member_revoked`; the synthesized
`slack:{team}:{user}` id stays on the context as a correlation label that
nothing looks up. Session-principal requests are unchanged, byte for byte.
Around the marker: `linkedAccount` now binds its link query to the routed
connection rather than scanning by team, the object's refusal (and the
one-deploy `invalid_product_request` skew) is classified retryable instead of
terminal, a 401 from the object no longer flips the installation to
`needs_reconnect`, and every socket-ticket issuer refuses a connector
principal at the mint.

**Why:** The Slack connector predates the object cutover of 2026-08-17. Before
it, nothing verified the synthesized session id; after it, every product
request was re-verified against `sessions`, where `slack:{team}:{user}` never
existed — so from the cutover on, every linked member's `@Rally` mention and
thread reply died on its first attempt as `session_revoked` (the incident of
2026-08-22; the unlinked path survived because the workspace principal writes
through the runtime port, which never consulted `sessions`). The retry and
reconnect reclassifications came out of review: the object's refusal is
reachable only as a read-to-recheck race, so treating it as terminal dropped
the one message that a retry would have delivered, and reading it as a grant
failure paged an operator to reauthorize a healthy installation.

**Considered and rejected:** Minting real `sessions` rows for Slack links — a
link is not a login: it would have needed its own lifecycle (mint, renew,
revoke with the link) to mirror facts the link row already owns, and an
expiring mirror row would reintroduce this same failure intermittently.

**Consequences:** The ingress's `linkedAccount` check *is* the link
verification — the object deliberately re-checks only membership, so a path
that hands out `principal: "connector"` without verifying the link first has
no second gate behind it. And `connector_member_revoked` must stay out of
`SLACK_AUTHORIZATION_ERROR_CODES`: reauthorizing Slack does not restore
Rally membership.

Shipped in #256.

### 2026-08-22 — The reaction became a status, and agent output started rendering

**What changed:** The `eyes` reaction gained a lifecycle. It is still added on
admission, but a Durable Object alarm now rotates a working reaction while the
run is live, and delivery swaps in one naming the outcome — `white_check_mark`,
`question`, `warning`, or `octagonal_sign`. At most one Rally reaction sits on a
message at a time, and a transition removes only what Rally placed. The sets are
configurable per installation. Separately, every delivery path now renders agent
output through Slack's `markdown` block instead of posting it as `text`, and
`slack_agent_sessions` — WorkspaceDO's, since the object cutover — gained four
columns recording where the reaction sits and which one it is.

**Why:** Two defects in the same surface, both visible to everyone in a channel
rather than only to the member who asked. The reaction was added once and removed
by nothing, so a run that died on a provider error and a run that completed
successfully were indistinguishable at the message that started them — the Agent
thread status *was* cleared, but that is only visible inside the thread pane. And
`postSlackTextChunks` passed the model's markdown into `chat.postMessage`'s
`text`, which Slack parses as mrkdwn: a dialect with no headings and no tables, so
`### Outcome` reached the channel as three literal hashes. The streaming path had
always used `markdown_text` and rendered correctly, which meant the same output
looked different depending only on which path carried it.

**Considered and rejected:** A delayed queue message for the rotation, reusing the
`schedulePublicChannelSync` pattern, which needs no new infrastructure. Every tick
would write a `slack_ingress_jobs` row — dozens per run for a decorative effect —
and a queued message cannot be cancelled, so a run that finished in ten seconds
would keep waking only to discover it was over. Also rejected: translating
markdown to mrkdwn so the `text` field could stay. `###` has no correct
translation into a dialect without headings, only a lossy one, and it would have
made the two delivery paths differ in a new way rather than the old one. Also
rejected: stacking each state as its own reaction. It ends with three pills and
makes the current state something the reader has to work out from a set.

**Consequences:** The outcome transition is applied by **delivery**, not by the
ticker, and that split is load-bearing: delivery runs on every terminal status, so
a ticker that never started or was lost costs a cycling emoji rather than a
member's ability to tell that their task finished. Anything that moves the outcome
reaction onto the ticker reintroduces the original defect in a subtler form.

The six-second cadence is Slack's arithmetic, not taste. `reactions.add` and
`reactions.remove` are Tier 3 — about 50 calls a minute per method per workspace
per app — and a rotation step spends one in each bucket, leaving room for roughly
five concurrent runs in a workspace. A future change tempted to speed it up should
know that the refusals land on whichever run happens to tick last, which is the
worst possible distribution of the failure.

The acknowledgement no longer goes through `acknowledgeConnectorAgentActivation`.
That helper takes only the invocation and cannot see a workspace's configured
reaction set, so the command is built and executed as two explicit adapter steps —
the same control plane, one less indirection that could not carry the argument.

`reaction_current` is deliberately nullable rather than defaulted: "Rally has
placed nothing" and "the reaction is `eyes`" are different states, and a default
would make every row written before this migration claim the second and then try
to remove an emoji that was never there.

### 2026-08-22 — One DM path for both things Rally tells a person, and a link check that reaches the right database

**What changed:** `slack-mention-service.ts` is `slack-notification-service.ts`.
Its connection resolution, email lookup, DM open, chunking, retry, and
reconnect marking are now one function behind two senders —
`sendWorkstreamMentionSlack` and `sendWorkstreamParticipantAddedSlack` — which
differ only in the text they render and the id their `client_msg_id` is seeded
from. Its incomplete-delivery log is `slack_notification_delivery_incomplete`
with `kind` and `source_id` fields, replacing
`slack_mention_delivery_incomplete` and its `message_id`. Separately,
`slackUserIsLinked` reads `slack_user_links` from the object and
`workspace_members` from regional D1 as two statements instead of joining them.

**Why:** the join was routed into WorkspaceDO — the workspace SQL router claims
any statement naming a local table — and that object has no `workspace_members`.
Every Slack run-outcome delivery therefore threw `no such table:
workspace_members`, was reported as a settlement failure, and was retried until
the ingress retry budget was exhausted; in one production workspace the same run
had been failing every five minutes for ninety minutes when it was found.
`publishHome` in the same file already split this exact pair across the two
authorities, so the fix is the shape the file already had.

The rename follows from the second sender: duplicating two hundred lines of
credential and retry handling would have given a Slack authorization failure two
places to be handled differently, and the file's name would have been wrong
either way once it carried both.

**Considered and rejected:** keeping `slack_mention_delivery_incomplete` for
mentions and adding a second event name for the other kind. The comment beside
that log already argues against exactly that: one event with the difference as a
field, because a name interpolated from the case splits one failure across two
values no saved view can filter as one.

### 2026-08-22 — A spent link challenge is kept a day, and an exhausted job is reported once

**What changed:** `maintainIngress` deletes a link challenge a day after it
expired or was consumed (`SLACK_LINK_CHALLENGE_GRACE_MS`), where it bound the
30-day retention cutoff, and the workspace alarm's `slack_ingress` arm counts a
challenge at that same horizon. `processQueuedIngress` writes
`slack_ingress_job_exhausted` at `error` and posts an operator notification
when the job it just failed reaches the attempt ceiling, and its claim refuses
a job already at the ceiling. The maintenance pass logs exhausted jobs as one
summary row per pass.

**Why:** The workspace alarm's `slack_ingress` due time is the earliest instant
among the rows that pass reaps, and for challenges it was `MIN(expires_at)` —
fifteen minutes after the click. Holding the row for 30 days left that instant
in the past for a month, and the alarm re-armed for it after every pass: on
2026-08-22 one workspace's alarm ran about 1.5 times a second for hours,
logging its eight exhausted ingress jobs on every wake. Two of those jobs were
`@Rally` mentions that had died on `session_revoked` at 18:20 UTC, and the
only record was an error row nobody was watching. The notification is what
would have said so within a minute; the agreeing horizons are what end the
loop. The claim bound exists because the Queue redelivers a message whose
processing threw, and without it every redelivery re-ran the dead job, pinned
it again, and would have posted again.

**Considered and rejected:** Deleting a challenge the moment it is spent — the
first draft. It ends the loop just as well, but it makes `slack_link_expired`
and `slack_link_consumed` unreachable in practice: the pass runs at the expiry
instant, so a member clicking a twenty-minute-old link would be told Rally has
never seen it. A day of grace keeps the reason and costs nothing; what matters
is that both sides name the same horizon. Keeping the 30-day retention and
narrowing the schedule's expression to live challenges was rejected for the
same reason in reverse: two sides that disagree about when a row is done is
what caused this.

**Consequences:** A link clicked within a day of expiry or redemption is still
refused with its specific reason; after that it is `slack_link_unknown`, and
the remedy is the same click either way. An exhausted job is one `error` row,
and an installation failing one way is one message an hour, never more; the
standing count is a `warn` row per pass. The exhaustion notice carries only the
job id, the workspace id, the job kind, the error code, and whether the failure
was retryable.

### 2026-08-18 — Slack work-stream discovery reads WorkspaceDO

**What changed:** App Home recent work, unfurl creation, and unfurl refresh now
batch their work-stream summary reads through WorkspaceDO. D1 continues to own
Slack installation/link/delivery state, not title/status/sidebar projections.

**Why:** Connector state and work-stream product state have different
authorities. Joining them in application code preserves each without cloning the
work-stream directory back into D1.

**Considered and rejected:** D1 summary projections retained only for Slack and
one WorkstreamDO call per result. The first recreates split authority; the second
needlessly multiplies object calls.

**Consequences:** Slack summary surfaces fail closed or retry when WorkspaceDO is
unavailable. Typed batched directory RPCs must stay bounded, while connector
authorization and credentials never enter the object.

### 2026-08-15 — Multi-member delivery follows the run, not the opener

**What changed:** Workflow input now carries the Slack member who triggered the run, and a
needs-input connect prompt goes to that member, with link status scoped to the exact installation
and workspace. Shared result blocks always show feedback while submission remains link-authorized.
Private rosters resolve known identities in bulk, enrich only unresolved profiles at six requests
at a time under one ten-second deadline, and later admissions publish `participant_added`. App Home
and manifest copy now describe per-message personal authority instead of task claiming.

**Why:** Once authority became per-message, session-opener state was no longer a safe proxy for
the person whose run needed input or for every viewer of a shared Slack message. Unbounded roster
lookups could also exhaust provider or Worker limits, while silent participant writes left live
clients stale.

**Considered and rejected:** Keeping the opener as a delivery approximation and rendering shared
controls according to one viewer's link state. Both make one member's state govern somebody else's
run or view.

**Consequences:** Old in-flight workflow payloads retain the opener fallback; new runs route to
their actual triggering member. A stale link on a retired installation cannot suppress the connect
prompt. An unlinked viewer may open the feedback modal but cannot submit it. Roster enrichment is
best effort within the shared deadline, and participant-event consumers must remain idempotent.
### 2026-08-12 — Slack MCP tools come from the active server

**What changed:** Personal Slack connections now request one
`slack.personal.mcp` Rally grant and expose the live `tools/list` response at
plugin activation through the shared hosted-MCP abstraction. Legacy personal
capability grants remain accepted for already-connected rows through the
reviewed static Web API surface, never as an umbrella for live tools. Workspace
bot and Agent tools stay code-authored Web API operations.

**Why:** Slack's MCP tool surface is provider-owned and can change without an
Rally release. The previous connector definitions were a snapshot, so they
could hide a new tool or continue advertising one Slack had removed.

**Considered and rejected:** Keeping the old capability-per-observed-tool model
as an allowlist. It did not authorize actual remote operations reliably because
the mapping itself was guessed, while principal checks, one MCP grant,
confirmation, and receipts already enforce the policy Rally owns.

**Consequences:** A personal plugin may show a different tool set on its next
activation when Slack changes the server. Marketplace scope review remains tied
to the requested OAuth scopes, not to a pasted tool catalog. Every live tool is
confirmed as a write even when Slack sends `readOnlyHint`; a lower-friction read
path requires an independent Rally policy source. The legacy grants are
compatibility-only static grants and should be removed with an explicit
reconnection migration rather than extended or mapped onto provider-owned tools.

Shipped in the pull request for this change.

### 2026-08-12 — A Slack thread stopped belonging to whoever was linked first

**What changed:** A work stream started from Slack takes its conversation's audience — public
channel to a public work stream, private channel or DM to a private one seated with that
conversation's members — and everybody in the conversation can continue it. The two refusals
that enforced the old pin are gone, as are the claim button, the claim DM, and
`claimWorkspaceSession`. Each message runs as whoever sent it: a linked member's own authority,
the workspace principal otherwise, and a Slack member Rally cannot map still has their message
recorded under their Slack actor. Feedback buttons are open to any linked member of the
installation.

**Why:** In a public channel, one member asked Rally for domain names and the thread became
theirs. The workspace owner replying "do deep research on all technology companies named Delta"
was answered with *"This thread is already running with another Rally member's personal
authority. Start a new Rally task to keep identities and connected accounts separate."* A third
member, an active Rally member Slack could resolve by email but who had not linked, got the
other half: *"an unlinked Slack member cannot continue it."* Both messages were posted in
channel, both were the correct behaviour as written, and both told a colleague that the
conversation they were standing in belonged to somebody else. The claim button existed for
exactly this and was never the answer: it moved the whole thread's authority rather than
answering the one message.

**Considered and rejected:** Keeping the pin and adding a "continue as me" button beside the
refusal — the claim flow again, still asking a conversation to have one owner. Also rejected:
letting Slack's verified email authorize a run as the matched member, which would have made
every refusal disappear and would have let a Slack profile address spend a Rally member's
personal connectors. That match seats and credits somebody; nothing weaker than a link
authorizes a run.

**Consequences:** A Slack thread in a *private* channel now produces a work stream nobody
outside that channel can read, where before it was workspace-visible; that is the point, but it
means the roster read is what makes the channel able to find its own work stream, and it is
bounded and best effort. Membership is admitted and never revoked, so leaving the Slack channel
does not remove somebody from the work stream. `slack_agent_sessions.linked_user_id` and
`execution_scope` survive as fixed compatibility values for one deployment — the previous Worker
names both in its insert and `execution_scope` is `NOT NULL`. A later migration may drop them
after this code has shipped everywhere. The targeted-elicitation refusal is deliberately still
there: it is per question and matches what the Rally app does, rather than saying who owns the
conversation.

### 2026-08-12 — Linking became one step, and a stored status stopped gating events

**What changed:** A member who redeems a link challenge is carried straight into the personal
Slack authorization, so one click in Slack both links the identity and connects personal Slack
tools. The status gates came off the inbound surface — events, interactions, `rally_connect`,
mentions, the unfurl refresh sweep, automation delivery, credential pre-warm — leaving only
`disabled`. `redriveReauthorizedIngress` re-queues ingress jobs that failed on authorization
once the installation returns to `healthy`. The `slack_installation_unhealthy` refusal and
`reconnectRequiredModal` are gone; `slack_installation_disabled` replaces them.

**Why:** A workspace installation missing a newly-required bot scope was marked
`needs_reconnect`, correctly — and from then on the mark, not the grant, failed every request.
The credential coordinator filtered on `status = 'healthy'`, so Slack events were refused
without a single call to Slack, and the refusal overwrote the accurate `missing_scopes:
reactions:read` diagnosis with a generic one. Every work-stream link shared in Slack during
those sixteen hours lost its unfurl permanently, because Slack reports `link_shared` once and
never redelivers it. Separately, members could not tell "Connect Rally" from "Connect for me":
both said Connect, and redeeming the first republished App Home as "Welcome, `<name>`" while
personal tools stayed unconnected below it.

**Considered and rejected:** Deriving the identity link from a *personal Slack connection*, which
reads like the stronger proof — Slack ran the OAuth and named the user. The connector OAuth
callback is mounted before the auth middleware and completes from its `state` alone, so a member
could start a personal flow, send the consent URL to a colleague, and have that colleague's
genuine click bind the colleague's Slack identity to the sender's Rally account. The link
challenge is the only artifact carrying a Slack-signed statement of who clicked, so it stays the
only thing that mints a link. Also rejected: waiving `disabled` for the challenge on the grounds
that the challenge is its own authority. Disabling clears the credentials and drops the row from
`connectionForTeam`, so redeeming would commit the link and then fail publishing App Home.

**Consequences:** The reverse direction — connect personal Slack, get linked — is deliberately
absent and needs the connector OAuth start bound to its initiating client before it can exist.
A future change must not reinstate it from the callback alone. `redriveReauthorizedIngress`
selects on `c.status = 'healthy'` rather than on `updated_at` alone; the earlier form did not
terminate, because every failure bumped the connection's timestamp through the marking write and
stranded jobs re-drove each other forever.

Shipped in #113.

### 2026-08-11 — A link challenge is minted by the click that redeems it

**What changed:** **Connect Rally** on App Home is an action button with no URL.
Clicking it mints the challenge and opens it in a modal, which is now the only
Slack surface that ever holds a handoff link. The claim DM Rally sends when a
workspace-owned task needs personal authority carries the same button instead of
a minted URL. A challenge that cannot be redeemed is refused with the specific
reason — unknown, consumed, expired, workspace mismatch, or unhealthy
installation — where every one of them previously read as expiry.

**Why:** A member clicked **Connect Rally** and Rally told them the link had
expired. App Home is published once and stays on screen until something
republishes it, while the challenge embedded in its button lived fifteen minutes,
so the visible button rotted in place with nothing to indicate it. Worse,
publishing Home minted a new challenge and consumed every outstanding one for
that member, so the *act of opening Home* killed the token in the copy already on
screen — and `views.publish` returns silently on `hash_conflict`, meaning two
near-simultaneous `app_home_opened` events left the displayed view holding a
consumed token and no replacement rendered, dead until the next successful
publish. Because every one of those states produced the same row-not-found, they
all reported "expired", including an installation needing reconnect, which sent
the member to fetch a new link that would fail identically.

**Considered and rejected:** Reusing a live challenge in `createLink` instead of
consuming it. It removes the rotation race but not the defect underneath — a
token published into a durable view still expires while the member is looking at
it. Also rejected: a stable, non-secret URL on the button, exchanged for a
challenge when followed. That URL is then a permanent bearer credential for
claiming a Slack identity, sitting in browser history, which is the exact
property the single-use fragment exists to avoid. Lengthening the TTL only
trades the failure for a longer-lived secret.

**Consequences:** Connecting costs one extra click — button, then **Open Rally**
in the modal — bought in exchange for a link that cannot be stale when it is
clicked. Any future surface inviting a member to connect must use
`connectPromptBlocks` and must not embed a handoff URL; the rule is stated under
[Identity linking](#identity-linking) because a surface that breaks it will not
fail any test. `createLink` now has exactly one caller, the `rally_connect`
interaction, which is also where an unhealthy installation is refused before a
challenge exists. `loadLinkChallenge` checks its conditions in a deliberate order
— workspace mismatch ahead of every state check, so a caller holding a token
minted for another Rally workspace learns nothing about it — and a new condition
has to be placed in that order rather than appended.

Two things in the interaction handler are load-bearing and look arbitrary.
**Every** one of Rally's buttons is matched on the Slack action id and none on
the payload's `callback_id`, whose fallback prefers a top-level value that a
block action raised from inside a view carries — matching the other way sends a
connect button placed in a modal down the shortcut path instead. The four
buttons this change did not otherwise touch were converted with it rather than
left as a rule that held for two of six, since the manifest's only shortcuts
carry no action at all and reach the task modal by falling past every branch.
And `supersedeLinksMintedBefore`
runs after `views.open` rather than inside the mint, so a modal that fails to
open cannot retire the link the member is still holding, and it is bounded by
mint time rather than retiring every token but its own — two clicks in flight
together would otherwise each retire the other's, leaving two modals on screen
and no redeemable link between them.

**The `rally_connect` action id was deliberately reused rather than renamed**,
which has a cost on deploy day worth knowing about. Every App Home view published
before this shipped still carries a button with that id *and* the old `url`, and
Slack both follows a `url` button's link and sends its interaction — so the first
click on a not-yet-republished view opens a long-dead handoff (an error in the
desktop app) and mints a working modal behind it. A new id would have made those
stale views inert on the interaction path instead, leaving the member the error
and nothing else; reusing it means the recovery is already on screen when the
error appears. The window closes for each member the moment they next open Home,
which republishes it, and any real click is preceded by exactly that. Claim DMs
already sitting in history keep their dead URLs either way — nothing republishes
a message — which is the cost of ever having put a link in one.

Slack's rendering of the new modal and buttons was verified structurally, against
the Block Kit payloads in `apps/api/test/slack-account-link.test.ts`; Slack
cannot be driven from the sandbox, so the first real render is worth a look
during the App Home/linking case of the `docs/e2e.md` matrix.
