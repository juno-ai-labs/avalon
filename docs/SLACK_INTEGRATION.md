# Slack Agent connector

## Product boundary

Every configured bot and personal OAuth scope, including its concrete Avalon
use and model-tool mapping, is listed in
[Slack permissions](SLACK_PERMISSIONS.md).

Avalon uses one public Slack Marketplace app for two related but separate connections:

1. A **workspace installation** gives Avalon a bot identity and the Slack Agent surfaces. It receives Events API deliveries and powers Agent DMs, mentions, App Home, shortcuts, `/avalon`, modals, unfurls, streaming replies, and proactive automation results.
2. An optional **personal connection** gives Avalon's MCP client a Slack user token. It preserves that user's broader private-channel, DM, MPIM, canvas, visibility, and user attribution.

The workspace installation is required for the in-Slack Agent experience. Personal MCP authorization is not required to chat with Avalon in Slack. Every Slack-originated run receives bounded source provenance (team, channel, thread, invocation and channel types, and any matched Avalon member), plus up to eight nearby messages and attachment metadata when the bot can read them. Nearby Slack content is model-visible as explicitly labelled untrusted evidence rather than system instructions. The workspace installation also exposes bounded message search, channel/thread/message/file/user/member reads, and bot-authored message/reaction/conversation writes. Slack's Real-time Search API requires the short-lived `action_token` from a user-initiated message or app mention; Avalon carries that token as hidden run authorization and never adds it to prompts or model tool arguments. Bot search covers public channels only. Other workspace reads cover conversations and files visible to the installed bot. The message shortcut can explicitly prefill a task with its selected message.

This split follows Slack's July 2026 Agent model. New apps use `features.agent_view`, the normal Messages tab, and threaded replies. The older `assistant_view` is not configured.

## Connection cardinality

The invariant is asymmetric:

- One Slack team ID maps to at most one Avalon workspace and one data region.
- One Avalon workspace can contain any number of Slack team installations.
- A member can add a personal Slack MCP connection for each Slack identity they use.
- A workspace bot installation and a personal MCP connection are independent credentials, even when they refer to the same Slack team.

Global D1 stores only `team_id -> region/workspace/connection` routing metadata. Signed payload processing, encrypted tokens, user links, Agent sessions, workstreams, and results stay in the owning Avalon region. The database and desktop UI deliberately allow **Connect another workspace** for Slack.

## API versus MCP

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

Slack's hosted MCP server is the user tool plane. Avalon initializes a JSON-RPC 2.0 Streamable HTTP session at `https://mcp.slack.com/mcp`, sends `notifications/initialized`, follows all `tools/list` cursors, validates the discovered tool and its input contract, invokes `tools/call`, and closes the session when Slack assigns one. SSE responses are rejected because Slack does not support them. The static connector capabilities constrain which discovered tools can be offered to the model. MCP calls are never used to host the Agent surface or to bypass a frozen automation delivery target.

Personal authorization is incremental. **Slack knowledge** requests the read/search capabilities; **Slack actions** requests user-attributed writes. Adding the second preset expands the existing personal Slack connection instead of replacing its earlier grants. Workspace Agent scopes remain a separate administrator-controlled installation with one reviewed capability bundle, including `reactions:read` for activity triggers and `reactions:write` for the deterministic activation acknowledgement and workspace reaction tool. Existing workspace installations must reconnect after the workspace-tool scope expansion before health checks and tool calls succeed.

## Data behavior

The canonical definition is in `docs/PROVIDER_APPS.md`: zero-copy means Avalon does not recreate Slack inside Avalon. It is a product and architecture boundary, not a claim that no Slack data crosses the connector or is ever persisted. Avalon must not become a parallel Slack inbox, channel browser, history store, or generally searchable Slack replica.

Within that boundary, Avalon may subscribe to Slack activity, retain bounded normalized trigger evidence and provenance for configured automations, fetch authorized task-specific context on demand, and preserve Slack-derived content in the Avalon work that uses it. The workspace bot joins every current public channel after installation or reconnection and joins new public channels from `channel_created` events so `@Avalon` is consistently available. To support natural follow-ups, Slack delivers `message.channels` and `message.groups` events for conversations the bot has joined because Slack offers no thread-only event filter. The regional ingress accepts human replies in an existing Avalon thread, a recent denied Avalon thread, or a message event matched by an explicitly configured Slack automation source; unrelated messages are discarded before durable queueing. Normalized automation activity retains bounded trigger evidence and identifiers, not a general-purpose copy of the source conversation or file content.

When a prompt is denied because the workspace connection, channel classification, or Agent policy needs attention, Avalon retains that prompt regionally for at most 24 hours. This lets the same Slack member reply `try again` after the problem is fixed without retyping the request. The prompt is deleted when a session starts and expired rows are removed by scheduled maintenance. A narrowly matched, explicitly mentioned retry of a denial created before this mechanism may read at most the first 15 messages in that single thread to recover the prompting mention; unmentioned messages in other threads are ignored.

Natural public- and private-channel follow-ups require the workspace bot's `channels:history` and `groups:history` scopes. Existing workspace installations must complete the Avalon OAuth flow again after this feature is released. The scopes apply only to conversations the bot can access; Avalon's routing and retention restrictions above remain narrower than the provider grant.

Real-time Search API responses are transient context for the active model turn. Avalon stores only the generic tool-completion summary for replay, not the retrieved search payload, and disables optional inference-payload logging after a Slack search result enters the model context. The event `action_token` remains hidden runtime authorization and is not copied into the work-stream transcript, Slack session context, tool input, tool output, or inference payload log.

Normal product use can persist information in the resources that use it. A user prompt, bounded trigger record, Slack context used for the task, model-authored summary, workstream message, tool receipt, artifact, or automation result may remain in Avalon. That is purpose-bound Avalon work, not a cloned Slack corpus. By default these task and automation resources do not expire automatically; they remain until an authorized user deletes the resource or the workspace is deleted. Workspace disconnect revokes the credentials Avalon holds and disables routing; a Slack administrator separately removes the app from Slack App Management to uninstall it from the workspace. Personal disconnect revokes that user's credential. Disconnecting does not delete existing Avalon resources.

## Ingress and routing

The shared ingress is `https://slack.with-avalon.com`:

- `POST /slack/events`
- `POST /slack/interactivity`
- `POST /slack/commands`

Ingress verifies `v0:{timestamp}:{exact raw body}` using HMAC-SHA256, requires a timestamp inside five minutes, compares in constant time, checks `api_app_id`, and deduplicates Events API `event_id` values. URL verification is answered synchronously. Before acknowledging an event, text command, or valid modal submission, the owning regional service writes an ingress job and publishes its opaque job ID to the regional queue. Modal validation errors are returned synchronously to Slack. Shortcuts that need a trigger ID open their modal synchronously. The Global router looks up only the team route and invokes the owning regional service binding.

Queue workers atomically lease jobs, retry failed or abandoned work, and clear the stored ingress payload after successful processing. Retries with the same `event_id` and body are acknowledged once. Reuse of an event ID with different content is a conflict. Provider payloads are not written to Global object storage during routing. Ordinary channel messages that do not match an existing or retryable Avalon thread are acknowledged without creating a regional ingress job.

After a queued DM or mention passes connection, policy, and actor checks, the worker uses the shared connector activation flow to add the `eyes` reaction to the exact triggering message before it gathers context, creates/resumes a workstream, or starts model/tool processing. Slack's `already_reacted` response is a successful idempotent retry. A Slack-side reaction failure is logged and, when appropriate, marks the installation for reconnect, but does not discard the already-admitted user request. Commands and modal submissions have no unambiguous source message and retain their existing ephemeral/modal acknowledgement instead.

## Identity linking

Slack users are never matched to Avalon accounts by mutable profile fields or email alone.

Person-mention notification routing is deliberately narrower than account linking. When an
active Avalon member is mentioned, Avalon first uses that member's confirmed Slack link for
an installed team. If no link exists, every healthy workspace installation may resolve the
member's verified Avalon login email with `users.lookupByEmail`; Avalon sends a bot-authored
DM only when exactly one installed team returns a valid active human. This lookup is used only
as a delivery address: it does not create a `slack_user_links` row, authenticate the recipient,
or authorize personal Slack tools. Missing, ambiguous, invalid, or incompletely authorized
matches fall back to the ordinary mention email. Existing installations must complete the
Avalon OAuth flow again to grant additive `users:read`, `users:read.email`, and
`reactions:read` and `reactions:write` bot scopes. Until the identity scopes arrive, lookup-based mentions use
email. If an already-admitted prompt discovers that `reactions:write` is missing, Avalon
continues that task but marks the installation for reconnect before accepting later prompts.

1. An unlinked user opens Avalon Home or sends a prompt.
2. The regional service creates a random, hashed, 15-minute link challenge bound to the workspace installation and Slack user ID.
3. The HTTPS handoff keeps the token in a URL fragment, removes it from browser history, and opens the signed-in Avalon desktop app.
4. The desktop app calls authenticated `POST /connections/slack/link` against its active regional session; the endpoint consumes the challenge and binds that Avalon user to the Slack identity.
5. Every later invocation verifies active Avalon membership, the active link, the installation, and the owning region.

Suspended members and revoked links cannot start or continue tasks. A user may link separately in every connected Slack team.

### Work stream attribution

A work stream started from Slack records the Avalon member the Slack author resolves to as its
creator, and adds them as a participant. Slack does not decide that mapping on its own: it
uses the shared connector actor identity described in
[the connector document](CONNECTORS.md#actor-identity-and-work-stream-attribution), which
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

## Agent sessions and delivery

A Slack root DM or root mention creates a stable `slack_agent_sessions` row keyed by installation, channel, and root timestamp. It maps to exactly one durable Avalon workstream. Human replies in that Slack thread add messages to the same workstream without requiring another `@Avalon` mention. Avalon ignores messages outside its session threads and does not replay or import the rest of the Slack conversation.

On a prompt Avalon:

1. adds an `eyes` reaction when the invocation has a source message;
2. sets the Slack Agent thread status;
3. creates or resumes the durable workstream;
4. starts a `chat.startStream` reply when the surface supports it;
5. executes the ordinary authorized Avalon harness;
6. appends the complete persisted final message in Slack's required 12,000-character chunks and stops the stream;
7. falls back to complete 40,000-character Slack message chunks if streaming is unavailable;
8. links to the canonical Avalon workstream and offers feedback.

The persisted Avalon run is canonical. A Slack delivery failure never rewrites a completed run as failed.

An automation's Agent-DM destination is one of the frozen delivery targets described in
[work-stream and automation email addresses](WORKSTREAM_EMAIL_ADDRESSES.md#outbound-automation-results);
Slack and email are delivered independently, so a failure in one is retried without holding back the other.

## App Home

App Home is a personalized control surface published per user. Avalon publishes only for `app_home_opened` events whose tab is `home` and supplies Slack's current view hash to protect against stale updates.

### Unlinked

- concise description of Avalon and its data behavior
- **Connect Avalon** call to action
- example prompts, including the morning Gmail briefing
- AI fallibility notice
- paid Slack and Avalon plan disclosure
- privacy and help links

### Linked member

- **Start a task**, **Create automation**, and **Notifications** actions
- needs-attention and running tasks
- recent personal automations and next-run state
- explanation of optional personal Slack tools
- privacy and support links

### Workspace admin

App Home adds a workspace-administration card for Avalon owners and admins with installation health and a secure desktop handoff to Connections. The desktop Connections page is the full administration surface: installation health, team labels, granted surfaces, token health, reconnect, and disconnect.

Home is updated on `app_home_opened`, after account linking, and after settings changes. Blocks contain user-specific data only after the Slack user has been linked and active membership is revalidated.

## Interactions

- Agent DM: start a durable task or continue its thread.
- `@Avalon` in a channel: create/continue a task in the mention thread; later human replies in that Avalon-owned thread do not need another mention, and responses always stay threaded.
- Global shortcut **Start an Avalon task**: open a task modal.
- Message shortcut **Work on this with Avalon**: prefill the task modal with the selected message.
- `/avalon [request]`: start the request; an empty command opens the modal.
- Result buttons: open the canonical task or provide feedback.
- Avalon person mention: notify the matched member in the Avalon Agent DM, falling back to email.
- Avalon links: unfurls that summarize the work stream — title, status, last activity, and automation origin — and require the viewer's normal Avalon authorization for its contents.

Every work-stream link Avalon posts is the canonical
`https://with-avalon.com/app/workstreams/<uuid>` — see
[`WORKSTREAM_LINKS.md`](WORKSTREAM_LINKS.md). Slack delivers `link_shared` only
for the registered unfurl domain, so a link must be on that domain, with the id
in its path, to be unfurled at all; `avalon://` links pasted by a member never
produce an event and cannot be previewed. The unfurl handler also still accepts
the legacy `/open#target=` handoff already sitting in channel history.

Every other web button uses a static, allowlisted HTTPS-to-desktop handoff. Workstream IDs may cross that boundary; connector tokens and Slack link challenges stay in fragments and are removed from browser history.

Modal submissions are validated server-side. Modals never request Avalon or provider passwords.

## User stories

### Delegate from Slack

As a linked member, I can DM Avalon, mention it, invoke a shortcut on a message, or run `/avalon`, and receive progress and the durable result in the same Agent thread.

### Bring Slack context into Avalon

From a user-initiated Slack DM or app mention, I can ask Avalon to search public-channel messages using Slack's event-scoped authorization. With the workspace installation, I can also find visible users and conversations, read bounded channel/thread/message context, inspect bounded textual file content, and list conversation members. A personal Slack connection adds user-authorized private search, DMs, MPIMs, canvases, and the hosted MCP tool surface.

### Act in Slack

With the workspace installation, I can ask Avalon to send a bot-authored message, create or open a conversation, or add a bot reaction. A personal connection continues to support user-attributed actions and canvas writes. Existing confirmation and external-write receipt policies still apply.

### Connect several Slack workspaces

As an Avalon admin, I can install the same Avalon app into several Slack workspaces. Each installation has its own health, links, sessions, and automation destinations. No installation becomes the implicit default when more than one is available.

### Notify a mentioned teammate

As an Avalon member, when I mention an active teammate in a work stream, Avalon sends that
teammate a bot-authored Slack DM when the workspace installation can resolve them. A confirmed
Slack link is preferred; otherwise Avalon uses an exact verified-email lookup without silently
linking the accounts. The message identifies the author, workspace, work stream, complete
mention text, and a secure **Open in Avalon** handoff. If Slack cannot resolve or deliver it,
Avalon sends the existing mention email instead.

### Morning Gmail briefing

As a member, I can request: **“Check my Gmail every morning and send me the stack-ranked top 3 emails in Slack.”**

The saved personal automation freezes:

- the personal Gmail connection used for reads;
- a 9:00 AM calendar schedule in the user's IANA timezone unless the user chooses another time;
- the selected Slack workspace installation;
- the linked Slack user as an `slack_agent_dm` destination.

At each run Avalon ranks actionable inbox items, sends up to three (fewer if fewer qualify), and includes rank, sender, subject, why it matters, recommended action, and Gmail link in the Agent DM. Long results are sent without connector truncation using Slack-required message chunks. It posts a root Agent DM and sets the Agent thread title as a best-effort decoration after delivery succeeds. Empty results are suppressed by default. Revoked Gmail or Slack authorization marks the run or destination `needs_input`; transient Slack delivery errors remain retryable and do not disable the destination. Avalon does not silently switch accounts or Slack workspaces. Saving the recurring automation is the user's approval for those scheduled reads and deliveries.

## Implementation map

- Contract and connector: `packages/contracts/src/index.ts`, `packages/connectors/src/slack.ts`
- Regional schema: `packages/db/migrations/0039_slack_connector.sql`
- OAuth and connection lifecycle: `apps/api/src/services/connection-service.ts`
- Shared routing: `apps/api/src/services/slack-routing-service.ts`
- Agent/App Home/interactions/delivery: `apps/api/src/services/slack-agent-service.ts`
- Workspace-bot mention delivery: `apps/api/src/services/slack-mention-service.ts`
- Signed routes: `apps/api/src/routes/slack.ts`
- Workflow output sink: `apps/api/src/workflows/workstream-loop.ts`
- Desktop install and automation destination: `apps/desktop/src/renderer/screens/workspace-settings.tsx`, `apps/desktop/src/renderer/screens/new-automation.tsx`
- Slack manifest: `config/provider-apps/slack.json`

## Developer test setup

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
9. Optionally choose **Slack knowledge** and/or **Slack actions → Connect for
   me** in Avalon Settings to incrementally authorize the personal hosted-MCP
   tool plane.

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

Run the acceptance matrix in `docs/E2E.md`, beginning with App Home/linking,
Agent DM and thread continuation, mention, both shortcuts, `/avalon`, signature
replay, workspace search/read/write tools, personal MCP authorization, multi-workspace routing, and the Gmail
briefing's three/one/zero-result cases.

## Deployment and Marketplace gates

1. Set `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` in both regional Workers. Keep the public app identity identical.
2. Deploy migrations through `0046` and both Workers, including the Global/EU Slack service bindings and `slack.with-avalon.com` custom domain.
3. Run `slack manifest validate`; then create/update the Marketplace app from `config/provider-apps/slack.json`.
4. Reconnect existing Slack workspace installations so Slack grants the expanded bot scopes, then exercise the acceptance cases in `docs/E2E.md`.
5. Confirm paid-plan eligibility for Agent/automation features and document the `team.billing:read` use in review materials.
6. Provide working privacy, support, installation landing, pricing, AI disclosure, data-use, and deletion pages. Respond to support within two business days.
7. Before submission, meet Slack's active-workspace and weekly-active-user thresholds, complete preliminary review, and budget for functional review.
8. Submit the exact scopes and test credentials/instructions. Explain why broad user scopes are optional and user initiated, why public-channel membership does not ingest ordinary channel traffic, how account linking works, and how automation approval/delivery binding works.

The checked-in manifest passed Slack CLI 4.6.0 `slack manifest validate` on 2026-08-06. Validation does not replace deployment or Marketplace review.
