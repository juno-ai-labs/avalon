# Slack Agent connector

Avalon lives inside Slack as one public Marketplace app carrying two independent
credentials: an administrator's **workspace installation**, which is the bot
identity and the whole Agent surface, and an optional **personal connection**,
which gives Avalon's MCP client that member's own Slack visibility and
attribution. Neither substitutes for the other.

Read this before changing the ingress, the identity-linking flow, what a
Slack-originated run may read, or how a result is delivered. Every configured bot
and personal OAuth scope, with its concrete provider-feature justification, is
listed in [`slack-permissions.md`](slack-permissions.md) rather than here.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/connectors/src/slack.ts` | The adapter: capabilities, scope health, tools, activity types. |
| `packages/contracts/src/index.ts` | The shared contracts both ends parse. |
| `packages/db/migrations/0039_slack_connector.sql` | The regional schema. |
| `apps/api/src/services/connection-service.ts` | OAuth and connection lifecycle. |
| `apps/api/src/services/slack-routing-service.ts` | The Global team-to-region route, and nothing else Global holds. |
| `apps/api/src/services/slack-agent-service.ts` | Agent sessions, App Home, interactions, unfurls, delivery. |
| `apps/api/src/services/slack-mention-service.ts` | Workspace-bot mention delivery. |
| `apps/api/src/routes/slack.ts` | The three signed ingress routes. |
| `apps/api/src/workflows/workstream-loop.ts` | The workflow output sink that reaches Slack. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx`, `screens/new-automation.tsx` | Installation administration and the automation destination. |
| `config/provider-apps/slack.json` | The manifest. |

## How it works

### Product boundary

Avalon uses one public Slack Marketplace app for two related but separate connections:

1. A **workspace installation** gives Avalon a bot identity and the Slack Agent surfaces. It receives Events API deliveries and powers Agent DMs, mentions, App Home, shortcuts, `/avalon`, modals, unfurls, streaming replies, and proactive automation results.
2. An optional **personal connection** gives Avalon's MCP client a Slack user token. It preserves that user's broader private-channel, DM, MPIM, canvas, visibility, and user attribution.

The workspace installation is required for the in-Slack Agent experience. Personal MCP authorization is not required to chat with Avalon in Slack. Every Slack-originated run receives bounded source provenance (team, channel, thread, invocation and channel types, and any matched Avalon member), plus up to eight nearby messages and attachment metadata when the bot can read them. Nearby Slack content is model-visible as explicitly labelled untrusted evidence rather than system instructions. The workspace installation also exposes bounded message search, channel/thread/message/file/user/member reads, and bot-authored message/reaction/conversation writes. Slack's Real-time Search API requires the short-lived `action_token` from a user-initiated message or app mention; Avalon carries that token as hidden run authorization and never adds it to prompts or model tool arguments. Bot search covers public channels only. Other workspace reads cover conversations and files visible to the installed bot. The message shortcut can explicitly prefill a task with its selected message.

This split follows Slack's July 2026 Agent model. New apps use `features.agent_view`, the normal Messages tab, and threaded replies. The older `assistant_view` is not configured.

### Connection cardinality

The invariant is asymmetric:

- One Slack team ID maps to at most one Avalon workspace and one data region.
- One Avalon workspace can contain any number of Slack team installations.
- A member can add a personal Slack MCP connection for each Slack identity they use.
- A workspace bot installation and a personal MCP connection are independent credentials, even when they refer to the same Slack team.

Global D1 stores only `team_id -> region/workspace/connection` routing metadata. Signed payload processing, encrypted tokens, user links, Agent sessions, workstreams, and results stay in the owning Avalon region. The database and desktop UI deliberately allow **Connect another workspace** for Slack.

### API versus MCP

Raw Slack APIs are the workspace Agent and workspace-tool plane:

- OAuth installation and token rotation
- public-channel discovery and bot membership
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

Slack's hosted MCP server is the user tool plane. Avalon initializes a JSON-RPC 2.0 Streamable HTTP session at `https://mcp.slack.com/mcp`, sends `notifications/initialized`, follows all `tools/list` cursors, validates the discovered surface, invokes the exact live name through `tools/call`, and closes the session when Slack assigns one. The server's current names, descriptions, and JSON Schemas are passed through at plugin activation rather than copied into the connector. Provider annotations remain untrusted hints: every live tool keeps Avalon's confirmed-write and record-before-execute policy. Avalon's `slack.personal.mcp` grant and personal owner check constrain the surface without pretending to own its catalog. MCP calls are never used to host the Agent surface or to bypass a frozen automation delivery target. The reusable mechanism is in [`hosted-mcp-connectors.md`](hosted-mcp-connectors.md).

Personal authorization requests one `slack.personal.mcp` Avalon capability whose
provider scope set covers Slack's hosted user-tool plane. Existing personal rows
that carry the older per-tool capability grants remain on Avalon's reviewed
static Web API tools as a migration bridge; they never authorize the live MCP
catalog. Reconnecting replaces them with the umbrella grant. Workspace Agent scopes remain a separate
administrator-controlled installation with one reviewed capability bundle,
including `reactions:read` for activity triggers and `reactions:write` for the
deterministic activation acknowledgement and workspace reaction tool. Existing
workspace installations must reconnect after the workspace-tool scope expansion
before health checks and tool calls succeed.

### Data behavior

The canonical definition is in `docs/provider-apps.md`: zero-copy means Avalon does not recreate Slack inside Avalon. It is a product and architecture boundary, not a claim that no Slack data crosses the connector or is ever persisted. Avalon must not become a parallel Slack inbox, channel browser, history store, or generally searchable Slack replica.

Within that boundary, Avalon may subscribe to Slack activity, retain bounded normalized trigger evidence and provenance for configured automations, fetch authorized task-specific context on demand, and preserve Slack-derived content in the Avalon work that uses it. The workspace bot joins every current public channel after installation or reconnection and joins new public channels from `channel_created` events so `@Avalon` is consistently available. To support natural follow-ups, Slack delivers `message.channels` and `message.groups` events for conversations the bot has joined because Slack offers no thread-only event filter. The regional ingress accepts human replies in an existing Avalon thread, a recent denied Avalon thread, or a message event matched by an explicitly configured Slack automation source; unrelated messages are discarded before durable queueing. Normalized automation activity retains bounded trigger evidence and identifiers, not a general-purpose copy of the source conversation or file content.

When a prompt is denied because the channel classification or Agent policy needs attention, Avalon retains that prompt regionally for at most 24 hours. This lets the same Slack member reply `try again` after the problem is fixed without retyping the request. The prompt is deleted when a session starts and expired rows are removed by scheduled maintenance. A narrowly matched, explicitly mentioned retry of a denial created before this mechanism may read at most the first 15 messages in that single thread to recover the prompting mention; unmentioned messages in other threads are ignored.

Natural public- and private-channel follow-ups require the workspace bot's `channels:history` and `groups:history` scopes. Existing workspace installations must complete the Avalon OAuth flow again after this feature is released. The scopes apply only to conversations the bot can access; Avalon's routing and retention restrictions above remain narrower than the provider grant.

Real-time Search API responses are transient context for the active model turn. Avalon stores only the generic tool-completion summary for replay, not the retrieved search payload, and disables optional inference-payload logging after a Slack search result enters the model context. The event `action_token` remains hidden runtime authorization and is not copied into the work-stream transcript, Slack session context, tool input, tool output, or inference payload log.

Normal product use can persist information in the resources that use it. A user prompt, bounded trigger record, Slack context used for the task, model-authored summary, workstream message, tool receipt, or automation result may remain in Avalon. That is purpose-bound Avalon work, not a cloned Slack corpus. By default these task and automation resources do not expire automatically; they remain until an authorized user deletes the resource or the workspace is deleted. Workspace disconnect revokes the credentials Avalon holds and disables routing; a Slack administrator separately removes the app from Slack App Management to uninstall it from the workspace. Personal disconnect revokes that user's credential. Disconnecting does not delete existing Avalon resources.

### Ingress and routing

The shared ingress is `https://slack.with-avalon.com`:

- `POST /slack/events`
- `POST /slack/interactivity`
- `POST /slack/commands`

Ingress verifies `v0:{timestamp}:{exact raw body}` using HMAC-SHA256, requires a timestamp inside five minutes, compares in constant time, checks `api_app_id`, and deduplicates Events API `event_id` values. URL verification is answered synchronously. Before acknowledging an event, text command, or valid modal submission, the owning regional service writes an ingress job and publishes its opaque job ID to the regional queue. Modal validation errors are returned synchronously to Slack. Shortcuts that need a trigger ID open their modal synchronously. The Global router looks up only the team route and invokes the owning regional service binding.

Queue workers atomically lease jobs, retry failed or abandoned work, and clear the stored ingress payload after successful processing. A job that failed on authorization is classified non-retryable and pinned at the attempt ceiling, which is right while a grant is dead and wrong the moment it is not: `redriveReauthorizedIngress` re-queues such a job once its connection has been written again, which a reauthorization always does. It is self-limiting, because a re-driven job that fails again stamps itself newer than the connection. Without it, events that arrived during an outage stayed failed forever with their payload still on the row — and a `link_shared` Slack reports exactly once is never redelivered, so the message keeps its bare URL permanently. Retries with the same `event_id` and body are acknowledged once. Reuse of an event ID with different content is a conflict. Provider payloads are not written to Global object storage during routing. Ordinary channel messages that do not match an existing or retryable Avalon thread are acknowledged without creating a regional ingress job.

After a queued DM or mention passes connection, policy, and actor checks, the worker uses the shared connector activation flow to add the `eyes` reaction to the exact triggering message before it gathers context, creates/resumes a workstream, or starts model/tool processing. Slack's `already_reacted` response is a successful idempotent retry. A Slack-side reaction failure is logged and, when appropriate, marks the installation for reconnect, but does not discard the already-admitted user request. Commands and modal submissions have no unambiguous source message and retain their existing ephemeral/modal acknowledgement instead.

### Identity linking

Slack users are never matched to Avalon accounts by mutable profile fields or email alone.

Person-mention notification routing is deliberately narrower than account linking. When an
active Avalon member is mentioned, Avalon first uses that member's confirmed Slack link for
an installed team. If no link exists, every workspace installation a person has not disabled may resolve the
member's verified Avalon login email with `users.lookupByEmail`; Avalon sends a bot-authored
DM only when exactly one installed team returns a valid active human. This lookup is used only
as a delivery address: it does not create a `slack_user_links` row, authenticate the recipient,
or authorize personal Slack tools. Missing, ambiguous, invalid, or incompletely authorized
matches fall back to the ordinary mention email. Existing installations must complete the
Avalon OAuth flow again to grant additive `users:read`, `users:read.email`, and
`reactions:read` and `reactions:write` bot scopes. Until the identity scopes arrive, lookup-based mentions use
email. If an already-admitted prompt discovers that `reactions:write` is missing, Avalon
continues that task and marks the installation for reconnect. The mark is a diagnosis, not a
gate: later prompts still reach Slack and fail on Slack's answer if the scope is really gone —
see [Stored status is a belief, not a gate](connectors.md#stored-status-is-a-belief-not-a-gate).

1. An unlinked member clicks **Connect Avalon** — on App Home, or on the private
   prompt Avalon sends when a workspace-owned task needs personal authority.
2. The regional service creates a random, hashed, 15-minute link challenge bound
   to the workspace installation and Slack user ID, and returns it in a modal
   opened against that same click.
3. The HTTPS handoff keeps the token in a URL fragment, removes it from browser history, and opens the signed-in Avalon desktop app.
4. The desktop app calls authenticated `POST /connections/slack/link` against its active regional session; the endpoint consumes the challenge and binds that Avalon user to the Slack identity.
5. The desktop then starts the personal Slack authorization against that same account, so one
   click accomplishes both halves rather than leaving the second as an errand. A link that
   committed survives a failed authorization; only the half that did not finish is reported.
6. Every later invocation verifies active Avalon membership, the active link, the installation, and the owning region.

**This is one of two routes to a link.** Completing a *personal* Slack connection establishes it
too, through `establishIdentityLinkFromPersonalConnection`: Slack ran the OAuth and named the
user, which is a stronger proof of who this is than a challenge Avalon minted. Both routes are
idempotent, so whichever a member reaches first, both end up done. The insert is refused only
when the Slack identity already belongs to a different Avalon member — the personal connection
still stands in that case, because resolving it is not that operation's business.

**A challenge is minted by the click that redeems it, and never earlier.** No
Slack surface holds a handoff URL: App Home and the claim DM carry a button
whose only job is to ask for one. This is a hard rule rather than a preference —
App Home is a published document with no expiry of its own and the claim DM is
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
**Connect Avalon** again. A *disabled* installation needs an Avalon workspace owner or admin
to re-enable it: disabling clears the credentials and drops the row from `connectionForTeam`,
so redeeming would commit the identity link and then fail publishing App Home. An installation
merely marked `needs_reconnect` is **not** refused — that is a belief about a past moment, and
the challenge is single-use, fifteen minutes old, and minted by a click Slack signed.

Suspended members and revoked links cannot start or continue tasks. A user may link separately in every connected Slack team.

#### Work stream attribution

A work stream started from Slack records the Avalon member the Slack author resolves to as its
creator, and adds them as a participant. Slack does not decide that mapping on its own: it
uses the shared connector actor identity described in
[the connector document](connectors.md#actor-identity-and-work-stream-attribution), which
every agent connector uses. Slack contributes the `users.info` profile — including the email
that feeds the `verified_email` step — and records the resolved mapping for later work.

Slack adds one provider-specific mapping of its own: an explicit claim credits the claiming
member when they are the same Slack author who started the task. A claim by a different Slack
member makes that member a participant rather than the creator. When a mapping only arrives
later — the member links their account, or joins Avalon after the task ran — the earlier
ownerless work streams of their Slack sessions are credited to them then. Account linking may
additionally correct a creator that the same session's earlier `users.lookupByEmail` match
produced, which is the only case where an existing creator is rewritten.

As everywhere else, attribution is not authorization: an unlinked author's task still runs
with the workspace principal, and the opening message keeps its external Slack actor.

### Agent sessions and delivery

A Slack root DM or root mention creates a stable `slack_agent_sessions` row keyed by installation, channel, and root timestamp. It maps to exactly one durable Avalon workstream. Human replies in that Slack thread add messages to the same workstream without requiring another `@Avalon` mention. Avalon ignores messages outside its session threads and does not replay or import the rest of the Slack conversation.

The workstream also carries the thread it was summoned from as an attached `slack_thread` resource, so a member reading it in Avalon can get back to the conversation. That attachment holds identifiers, the channel name, and Slack's own permalink — origin metadata, not message content, consistent with the retention boundary above. See [work-stream origin attachments](workstream-origin-attachments.md).

On a prompt Avalon:

1. adds an `eyes` reaction when the invocation has a source message;
2. sets the Slack Agent thread status;
3. creates or resumes the durable workstream;
4. starts a `chat.startStream` reply when the surface supports it;
5. executes the ordinary authorized Avalon harness;
6. appends the complete persisted final message — the row the run ended on, not the narration it settled along the way, per [`agent-harness.md`](agent-harness.md#narration-segments) — in Slack's required 12,000-character chunks, and stops the stream;
7. falls back to complete 40,000-character Slack message chunks if streaming is unavailable;
8. links to the canonical Avalon workstream and offers feedback.

The persisted Avalon run is canonical. A Slack delivery failure never rewrites a completed run as failed.

An automation's Agent-DM destination is one of the frozen delivery targets described in
[work-stream and automation email addresses](workstream-email-addresses.md#outbound-automation-results);
Slack and email are delivered independently, so a failure in one is retried without holding back the other.

### App Home

App Home is a personalized control surface published per user. Avalon publishes only for `app_home_opened` events whose tab is `home` and supplies Slack's current view hash to protect against stale updates.

#### Unlinked

- concise description of Avalon and its data behavior
- **Connect Avalon** call to action — an action button carrying no URL, so
  publishing Home mints nothing and nothing on the published view expires
- example prompts, including the morning Gmail briefing
- AI fallibility notice
- paid Slack and Avalon plan disclosure
- privacy and help links

#### Linked member

- **Start a task**, **Create automation**, and **Notifications** actions
- needs-attention and running tasks
- recent personal automations and next-run state
- explanation of optional personal Slack tools
- privacy and support links

#### Workspace admin

App Home adds a workspace-administration card for Avalon owners and admins with installation health and a secure desktop handoff to Connections. The desktop Connections page is the full administration surface: installation health, team labels, granted surfaces, token health, reconnect, and disconnect.

Home is updated on `app_home_opened`, after account linking, and after settings changes. Blocks contain user-specific data only after the Slack user has been linked and active membership is revalidated.

### Interactions

- Agent DM: start a durable task or continue its thread.
- `@Avalon` in a channel: create/continue a task in the mention thread; later human replies in that Avalon-owned thread do not need another mention, and responses always stay threaded.
- Global shortcut **Start an Avalon task**: open a task modal.
- Message shortcut **Work on this with Avalon**: prefill the task modal with the selected message.
- `/avalon [request]`: start the request; an empty command opens the modal.
- **Connect Avalon**: mint a link challenge and open it in a modal whose single
  button is the desktop handoff. Not refused on a stored status; a grant that is
  really gone fails on Slack's answer.
- Result buttons: open the canonical task or provide feedback.
- Avalon person mention: notify the matched member in the Avalon Agent DM, falling back to email.
- Avalon links: unfurls that summarize the work stream — title, last activity, automation origin, and a status badge only while it is running, needs input, or failed — and require the viewer's normal Avalon authorization for its contents.

Every work-stream link Avalon posts is the canonical
`https://with-avalon.com/app/workstreams/<uuid>` — see
[`workstream-links.md`](workstream-links.md). Slack delivers `link_shared` only
for the registered unfurl domain, so a link must be on that domain, with the id
in its path, to be unfurled at all; `avalon://` links pasted by a member never
produce an event and cannot be previewed. The unfurl handler also still accepts
the legacy `/open#target=` handoff already sitting in channel history.

Every other web button uses a static, allowlisted HTTPS-to-desktop handoff. Workstream IDs may cross that boundary; connector tokens and Slack link challenges stay in fragments and are removed from browser history. The single button carrying a link challenge is the one inside the connect modal, which exists only for as long as that modal is open.

Modal submissions are validated server-side. Modals never request Avalon or provider passwords.

### User stories

#### Delegate from Slack

As a linked member, I can DM Avalon, mention it, invoke a shortcut on a message, or run `/avalon`, and receive progress and the durable result in the same Agent thread.

#### Bring Slack context into Avalon

From a user-initiated Slack DM or app mention, I can ask Avalon to search public-channel messages using Slack's event-scoped authorization. With the workspace installation, I can also find visible users and conversations, read bounded channel/thread/message context, inspect bounded textual file content, and list conversation members. A personal Slack connection adds user-authorized private search, DMs, MPIMs, canvases, and the hosted MCP tool surface.

#### Act in Slack

With the workspace installation, I can ask Avalon to send a bot-authored message, create or open a conversation, or add a bot reaction. A personal connection continues to support user-attributed actions and canvas writes. Existing confirmation and external-write receipt policies still apply.

#### Connect several Slack workspaces

As an Avalon admin, I can install the same Avalon app into several Slack workspaces. Each installation has its own health, links, sessions, and automation destinations. No installation becomes the implicit default when more than one is available.

#### Notify a mentioned teammate

As an Avalon member, when I mention an active teammate in a work stream, Avalon sends that
teammate a bot-authored Slack DM when the workspace installation can resolve them. A confirmed
Slack link is preferred; otherwise Avalon uses an exact verified-email lookup without silently
linking the accounts. The message identifies the author, workspace, work stream, complete
mention text, and a secure **Open in Avalon** handoff. If Slack cannot resolve or deliver it,
Avalon sends the existing mention email instead.

#### Morning Gmail briefing

As a member, I can request: **“Check my Gmail every morning and send me the stack-ranked top 3 emails in Slack.”**

The saved personal automation freezes:

- the personal Gmail connection used for reads;
- a 9:00 AM calendar schedule in the user's IANA timezone unless the user chooses another time;
- the selected Slack workspace installation;
- the linked Slack user as an `slack_agent_dm` destination.

At each run Avalon ranks actionable inbox items, sends up to three (fewer if fewer qualify), and includes rank, sender, subject, why it matters, recommended action, and Gmail link in the Agent DM. Long results are sent without connector truncation using Slack-required message chunks. It posts a root Agent DM and sets the Agent thread title as a best-effort decoration after delivery succeeds. Empty results are suppressed by default. Revoked Gmail or Slack authorization marks the run or destination `needs_input`; transient Slack delivery errors remain retryable and do not disable the destination. Avalon does not silently switch accounts or Slack workspaces. Saving the recurring automation is the user's approval for those scheduled reads and deliveries.

## Invariants

- **One Slack team ID maps to at most one Avalon workspace and one data region**,
  while one Avalon workspace may hold any number of installations. The asymmetry is
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
- **Slack users are never matched to Avalon accounts by mutable profile fields or
  email alone.** `users.lookupByEmail` is a delivery address only: it does not
  create a `slack_user_links` row, authenticate the recipient, or authorize personal
  tools.
- **A link challenge is minted by the click that redeems it, and never earlier.**
  No Slack surface holds a handoff URL — App Home is a published document with no
  expiry of its own and a claim DM is read whenever the member gets to it, so a
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
- **The `eyes` reaction is added by the host control plane after admission and
  authorization but before context gathering**, and `already_reacted` is a
  successful retry.
- **Attribution is not authorization.** An unlinked author's task still runs with
  the workspace principal, and the opening message keeps its external Slack actor.
- **The persisted Avalon run is canonical.** A Slack delivery failure never
  rewrites a completed run as failed.
- **The `action_token` is hidden run authorization** and never enters a prompt,
  the transcript, Slack session context, tool input, tool output, or the
  inference-payload log — which is disabled outright once a Slack search result
  enters model context.
- **Nearby Slack content is model-visible as explicitly labelled untrusted
  evidence**, never as system instructions.
- **Unrelated channel messages are discarded before durable queueing.** Slack
  offers no thread-only event filter, so the filtering is Avalon's job and it
  happens before anything is stored.
- **Avalon never becomes a parallel Slack.** No inbox, channel browser, history
  store, or generally searchable replica — see
  [`provider-apps.md`](provider-apps.md#the-zero-copy-connector-boundary).
- **No installation becomes the implicit default when more than one is
  available**, and Avalon never silently switches accounts or Slack workspaces.
- **Every work-stream link Avalon posts is the canonical HTTPS form.** Slack
  delivers `link_shared` only for the registered unfurl domain, so an `avalon://`
  link pasted by a member produces no event and can never be previewed.
- **Modal submissions are validated server-side**, and modals never request Avalon
  or provider passwords.

## Boundary

This document owns Avalon's Slack product surface: the two connections, the
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
| The Global/EU boundary the shared ingress sits on | [`regionalization.md`](regionalization.md) |
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
- **Retries with the same `event_id` and body are acknowledged once; reuse of an
  event ID with different content is a conflict.**
- **A denied prompt is retained regionally for at most 24 hours** so the same
  member can reply `try again` after the problem is fixed. It is deleted when a
  session starts, and expired rows are removed by scheduled maintenance. A narrowly
  matched, explicitly mentioned retry of a denial created *before* this mechanism
  may read at most the first 15 messages in that single thread to recover the
  prompting mention; unmentioned messages in other threads are ignored.
- **A missing `reactions:write` discovered mid-prompt does not stop the task.**
  Avalon continues and marks the installation for reconnect.
- **A challenge that cannot be redeemed is refused with the reason**, not a generic
  expiry: `slack_link_unknown`, `slack_link_consumed` (used or superseded),
  `slack_link_expired`, `slack_link_workspace_mismatch`, and
  `slack_installation_disabled`. Only the first three are answered by clicking
  **Connect Avalon** again; a disabled installation needs an Avalon workspace owner
  or admin to re-enable it.
- **An identity-link insert is refused only when the Slack identity already belongs
  to a different Avalon member.** The personal connection still stands in that case,
  because resolving the conflict is not that operation's business.
- **Suspended members and revoked links cannot start or continue tasks.**
- **Existing workspace installations must reconnect after a scope expansion**
  before health checks and tool calls succeed. Until the identity scopes arrive,
  lookup-based mentions fall back to email.
- **Streaming degrades rather than fails**: replies stream in Slack's required
  12,000-character chunks, falling back to complete 40,000-character message chunks
  when streaming is unavailable.
- **Message-context reads are bounded** — up to eight nearby messages on a prompt,
  and the per-tool bounds in [`slack-permissions.md`](slack-permissions.md).
- **SSE responses on Slack's Streamable HTTP MCP endpoint are parsed**, but
  Avalon never falls back to a separate legacy SSE endpoint.
- **Revoked Gmail or Slack authorization marks the run or destination
  `needs_input`**; transient Slack delivery errors remain retryable and do not
  disable the destination.
- **Disconnecting does not delete existing Avalon resources.** Workspace disconnect
  revokes the credentials Avalon holds and disables routing; a Slack administrator
  separately removes the app from Slack App Management to uninstall it. Task and
  automation resources do not expire automatically and remain until an authorized
  user deletes the resource or the workspace is deleted.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test/slack-agent-ingress.test.ts` | Signature verification, the replay window, dedupe, the ingress job written before acknowledgement, and the manifest read from `config/provider-apps/slack.json`. |
| `apps/api/test/slack-account-link.test.ts` | Both routes to a link, mint-on-click, retirement ordering and its mint-time bound, and each refusal reason. |
| `apps/api/test/slack-workstream-creator-attribution.test.ts` | Creator resolution, the claim rule, and the one case where an existing creator is rewritten. |
| `apps/api/test/slack-connection-health.test.ts` | That a stored status diagnoses rather than gates. |
| `apps/api/test/slack-mention-service.test.ts` | The lookup-based mention path and its email fallback. |
| `apps/api/test/slack-routing.test.ts` | The Global team route and the regional hand-off. |
| `apps/api/test/slack-unfurl-refresh.test.ts` | The unfurl card and its refresh sweep — owned by [`workstream-links.md`](workstream-links.md). |
| `apps/api/test/slack-workspace-assignment.test.ts` | The one-team-one-workspace invariant. |

Run one with
`pnpm --filter @avalon/api exec vitest run test/slack-agent-ingress.test.ts` — the
path is package-relative.

The trap is signature fixtures: verification runs over the **untouched raw body**,
so a test that re-serializes a payload before signing it passes while the
production path fails on the same delivery.

### Developer test setup

Use a separate development Slack app and a paid Slack test workspace. Do not
point the Marketplace app at a temporary tunnel or install a CLI-issued bot
token directly into Avalon; the Avalon Settings OAuth flow must receive and
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
   SLACK_MANIFEST_NAME="Avalon Dev" \
   SLACK_MANIFEST_API_GLOBAL_BASE_URL="https://your-tunnel.example" \
   SLACK_MANIFEST_INGRESS_BASE_URL="https://your-tunnel.example" \
   node scripts/slack-manifest-hook.mjs > /tmp/avalon-slack-dev.json
   ```

6. Paste `/tmp/avalon-slack-dev.json` into the development app's **App
   Manifest** editor. Slack will verify the now-live Events request URL. Link
   the app to this project if CLI diff/sync is desired:

   ```text
   slack app link --team <TEAM_ID> --app <APP_ID> --environment local
   ```

   Always pass the same three `SLACK_MANIFEST_*` overrides when syncing that
   development app.
7. In the Avalon desktop, sign in as a workspace owner/admin and open **Settings
   → Connections → Avalon Agent for Slack → Connect workspace**. Complete this OAuth flow even
   if Slack already shows the app in the test workspace; it creates Avalon's
   encrypted connection and team route. Do not substitute `slack app install`.
8. Open the app's Home tab in Slack, choose **Connect Avalon**, and let the local
   site hand off the one-time fragment token to the signed-in desktop. Reopen
   Home and confirm the linked member view.
9. Optionally choose **Slack → Connect for me** in Avalon Settings to authorize
   the personal hosted-MCP tool plane.

The local site is required for account-link handoff because development sets
`PUBLIC_WEB_BASE_URL=http://127.0.0.1:5174`. The browser and desktop must run on
the same Mac. Slack requires public HTTPS OAuth redirects, so a localhost-only
API is insufficient. A temporary tunnel URL also requires regenerating and
resaving the test manifest after every URL change.

For EU routing or repeatable team testing, prefer a dedicated hosted staging
deployment with stable Global ingress, Global API, EU API, and web origins.
Render the staging manifest with both `SLACK_MANIFEST_API_GLOBAL_BASE_URL` and
`SLACK_MANIFEST_API_EU_BASE_URL`, apply migration `0039` in both regional D1
databases, and configure the same four Slack secrets in both Workers.

Run the acceptance matrix in `docs/e2e.md`, beginning with App Home/linking,
Agent DM and thread continuation, mention, both shortcuts, `/avalon`, signature
replay, workspace search/read/write tools, personal MCP authorization, multi-workspace routing, and the Gmail
briefing's three/one/zero-result cases.

## Operations

### Deployment and Marketplace gates

1. Set `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` in both regional Workers. Keep the public app identity identical.
2. Deploy migrations through `0046` and both Workers, including the Global/EU Slack service bindings and `slack.with-avalon.com` custom domain.
3. Run `slack manifest validate`; then create/update the Marketplace app from `config/provider-apps/slack.json`.
4. Reconnect existing Slack workspace installations so Slack grants the expanded bot scopes, then exercise the acceptance cases in `docs/e2e.md`.
5. Confirm paid-plan eligibility for Agent/automation features and document the `team.billing:read` use in review materials.
6. Provide working privacy, support, installation landing, pricing, AI disclosure, data-use, and deletion pages. Respond to support within two business days.
7. Before submission, meet Slack's active-workspace and weekly-active-user thresholds, complete preliminary review, and budget for functional review.
8. Submit the exact scopes and test credentials/instructions. Explain why broad user scopes are optional and user initiated, why public-channel membership does not ingest ordinary channel traffic, how account linking works, and how automation approval/delivery binding works.

The checked-in manifest passed Slack CLI 4.6.0 `slack manifest validate` on 2026-08-06. Validation does not replace deployment or Marketplace review.

## Changelog

This document predates the [module document](module-documents.md) convention and
had no changelog until the entry below; the reasoning behind everything above it
was not recorded and is not reconstructed here.

### 2026-08-12 — Slack MCP tools come from the active server

**What changed:** Personal Slack connections now request one
`slack.personal.mcp` Avalon grant and expose the live `tools/list` response at
plugin activation through the shared hosted-MCP abstraction. Legacy personal
capability grants remain accepted for already-connected rows through the
reviewed static Web API surface, never as an umbrella for live tools. Workspace
bot and Agent tools stay code-authored Web API operations.

**Why:** Slack's MCP tool surface is provider-owned and can change without an
Avalon release. The previous connector definitions were a snapshot, so they
could hide a new tool or continue advertising one Slack had removed.

**Considered and rejected:** Keeping the old capability-per-observed-tool model
as an allowlist. It did not authorize actual remote operations reliably because
the mapping itself was guessed, while principal checks, one MCP grant,
confirmation, and receipts already enforce the policy Avalon owns.

**Consequences:** A personal plugin may show a different tool set on its next
activation when Slack changes the server. Marketplace scope review remains tied
to the requested OAuth scopes, not to a pasted tool catalog. Every live tool is
confirmed as a write even when Slack sends `readOnlyHint`; a lower-friction read
path requires an independent Avalon policy source. The legacy grants are
compatibility-only static grants and should be removed with an explicit
reconnection migration rather than extended or mapped onto provider-owned tools.

Shipped in the pull request for this change.

### 2026-08-12 — Linking became one step, and a stored status stopped gating events

**What changed:** A member who redeems a link challenge is carried straight into the personal
Slack authorization, so one click in Slack both links the identity and connects personal Slack
tools. The status gates came off the inbound surface — events, interactions, `avalon_connect`,
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
never redelivers it. Separately, members could not tell "Connect Avalon" from "Connect for me":
both said Connect, and redeeming the first republished App Home as "Welcome, `<name>`" while
personal tools stayed unconnected below it.

**Considered and rejected:** Deriving the identity link from a *personal Slack connection*, which
reads like the stronger proof — Slack ran the OAuth and named the user. The connector OAuth
callback is mounted before the auth middleware and completes from its `state` alone, so a member
could start a personal flow, send the consent URL to a colleague, and have that colleague's
genuine click bind the colleague's Slack identity to the sender's Avalon account. The link
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

**What changed:** **Connect Avalon** on App Home is an action button with no URL.
Clicking it mints the challenge and opens it in a modal, which is now the only
Slack surface that ever holds a handoff link. The claim DM Avalon sends when a
workspace-owned task needs personal authority carries the same button instead of
a minted URL. A challenge that cannot be redeemed is refused with the specific
reason — unknown, consumed, expired, workspace mismatch, or unhealthy
installation — where every one of them previously read as expiry.

**Why:** A member clicked **Connect Avalon** and Avalon told them the link had
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

**Consequences:** Connecting costs one extra click — button, then **Open Avalon**
in the modal — bought in exchange for a link that cannot be stale when it is
clicked. Any future surface inviting a member to connect must use
`connectPromptBlocks` and must not embed a handoff URL; the rule is stated under
[Identity linking](#identity-linking) because a surface that breaks it will not
fail any test. `createLink` now has exactly one caller, the `avalon_connect`
interaction, which is also where an unhealthy installation is refused before a
challenge exists. `loadLinkChallenge` checks its conditions in a deliberate order
— workspace mismatch ahead of every state check, so a caller holding a token
minted for another Avalon workspace learns nothing about it — and a new condition
has to be placed in that order rather than appended.

Two things in the interaction handler are load-bearing and look arbitrary.
**Every** one of Avalon's buttons is matched on the Slack action id and none on
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

**The `avalon_connect` action id was deliberately reused rather than renamed**,
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
