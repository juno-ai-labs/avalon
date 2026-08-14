# Fireflies connector

> Created 2026-08-14.
>
> A workspace or a member connects Fireflies.ai, the meeting notetaker, so
> Avalon's agent can search and read Fireflies meeting transcripts and
> summaries, and so finished Fireflies recaps arrive as connector activity.
> Companion documents: [research](research.md), [state](state.md).
> Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [`connectors.md`](../../connectors.md),
> [`hosted-mcp-connectors.md`](../../hosted-mcp-connectors.md), and
> [`agent-tools.md`](../../agent-tools.md).

## Summary

Avalon gains a `fireflies` connector with the same two-scope shape as Granola.
A workspace admin pastes a Fireflies API key to create a **workspace
connection**: every work stream in the workspace can then search meetings and
read transcripts and summaries through fixed, reviewed, read-only tools, and
finished Fireflies recaps flow in as activity — over signed webhooks when the
admin configures them, and over checkpointed polling either way. A member
separately connects **their own** Fireflies account over the hosted MCP OAuth
flow at `https://api.fireflies.ai/mcp`, which surfaces Fireflies' live
provider-authored tools in that member's work streams only.

Teams that run Fireflies in their meetings today get their meeting record into
the same place their work already happens: an automation can digest the week's
customer calls, a work stream about a deal can pull the exact transcript
passage, and nobody re-pastes summaries by hand.

## Motivation

Fireflies is one of the most widely deployed meeting notetakers, and prospects
who already pay for it will not switch their meeting capture to Avalon's own
recorder ([`meeting-notes.md`](../../meeting-notes.md)) as a precondition for
adopting Avalon. Today their meeting record is invisible to Avalon: the agent
cannot answer "what did the customer object to on Tuesday's call", automations
cannot digest call activity, and users copy summaries into work streams by
hand — the exact gap the Granola connector closed for Granola customers, now
requested for the larger Fireflies install base.

The repository already carries every pattern this needs — the
`connector_connections` scope model, the admin-API-key flow
(`createGranolaWorkspace`), the hosted MCP pass-through
(`createHostedMcpPassthrough`), signed webhook ingestion, and checkpointed
polling — so the cost is one adapter plus its registration, not new
infrastructure.

## Goals

1. A workspace admin creates a workspace-scoped Fireflies connection by pasting
   an API key, and sees it listed, testable, and deletable in Settings →
   Connections like any other connection.
2. Any work stream in a workspace with an active workspace connection can, via
   progressive disclosure, load a `fireflies` plugin and search meetings, read
   a meeting's summary, and read its transcript — read-only, executing as the
   workspace principal.
3. A member creates a personal-scoped Fireflies connection over OAuth against
   Fireflies' hosted MCP server, and their work streams gain Fireflies' live
   provider-authored tools under the existing hosted-MCP pass-through rules.
4. A finished Fireflies meeting summary becomes a digestible connector activity
   in the owning workspace within minutes when webhooks are configured, and
   within one poll interval otherwise — automations can subscribe to and digest
   it.
5. Connection health is honest: an invalid or revoked API key flips the
   connection to `needs_reconnect` on the next use, `POST /connections/:id/test`
   reports it, and the desktop shows the reconnect affordance.

## Non-goals

1. **Writing to Fireflies.** No sharing meetings, retitling, moving channels,
   creating soundbites, or deleting transcripts, although the Fireflies API
   offers all of these. Deferred: a later PRD can add reviewed write tools once
   read value is proven; starting read-only keeps the authority surface and the
   review burden small.
2. **Controlling the Fireflies bot.** No `Add to Live`, no inviting Fred to
   meetings, no Realtime API. Rejected: Avalon has its own meeting capture
   ([`meeting-notes.md`](../../meeting-notes.md)); driving a competitor's bot
   from Avalon is not a product direction.
3. **Uploading audio to Fireflies for transcription.** Rejected for the same
   reason as 2.
4. **AskFred pass-through.** Fireflies' own meeting-QA agent is not exposed as
   a tool. Rejected: Avalon's agent reads the transcript and reasons itself;
   nesting a second vendor agent inside the harness confuses authority and
   attribution.
5. **Ingesting media.** Audio/video URLs returned by Fireflies are not
   downloaded, stored, or re-served. Deferred: text transcripts and summaries
   carry the product value; media handling is a storage and residency project
   of its own.
6. **Backfilling history as activity.** Connecting does not replay past
   meetings into the activity stream; the agent reads history on demand through
   the tools. Deferred until digest demand proves otherwise — the Granola
   connector made the same call.
7. **Per-member identity mapping for the workspace connection.** Workspace
   tools execute as the connected Fireflies account; no attempt to act as the
   requesting member. Rejected: Fireflies has no delegated actor model —
   [`connector-actor-identity`](../../connectors.md) mapping would promise an
   identity the provider cannot honor.

## Product behavior

### Connecting — workspace scope

In Settings → Connections, the Fireflies card (icon, name, "Meeting
transcripts and summaries from Fireflies.ai") offers **Workspace** and **You**
scopes, mirroring Granola's card in
`apps/desktop/src/renderer/screens/workspace-settings.tsx`. Choosing Workspace
opens the API-key modal (the Granola workspace modal pattern): the admin pastes
the key from Fireflies → Integrations → Fireflies API, the desktop calls
`POST /connections/fireflies/workspace { apiKey, capabilities }`, the API
verifies the key with a `user` query, stores it encrypted, and the card flips
to connected. The plaintext key is never returned to the desktop afterwards.

The modal states plainly what the connection sees: **the meetings visible to
the Fireflies account that owns the key**. On Fireflies Enterprise with Super
Admin enabled that is the whole team; on other plans it is that account's own
meetings. The connection row's display name records the connected account's
email so the limitation stays visible.

The modal also shows the workspace's webhook endpoint URL and a
generated signing secret, with instructions to paste both into Fireflies →
Settings → Developer settings. Configuring the webhook is optional; activity
falls back to polling.

- **Empty**: card shows Connect for each scope. **Loading**: modal disables
  submit while verifying. **Error**: a rejected key shows the provider's
  failure inline; nothing is stored. **Populated**: connected card shows
  account email, scope, Test, and Remove. A `needs_reconnect` connection shows
  the reconnect affordance. **Offline**: Settings shows the cached list;
  mutations fail with the standard retry affordance.

### Connecting — personal scope

Choosing **You** starts the hosted MCP OAuth flow:
`POST /connections/fireflies/start { scope: "personal" }` begins
protected-resource discovery, dynamic client registration, and the
authorization-code + PKCE dance against `https://api.fireflies.ai/mcp`, exactly
as the pass-through already does for Granola personal connections. The browser
returns through `GET /connections/fireflies/callback`; a durable
`connector_oauth_attempts` row carries the attempt. One active personal
connection per member per workspace.

### Using it — agent tools

The workspace connection surfaces a `plugin_fireflies` plugin (one per
connection) discoverable through `search_plugins` with work-vocabulary aliases
("meeting", "transcript", "call recording", "recap", "notetaker") and three
static read tools: search meetings, read a meeting's summary, read its
transcript. The personal connection surfaces the provider's live MCP tools
through `loadTools`, under the hosted-MCP invariants (every provider-authored
tool treated as a confirmed write, response and schema caps per
[`hosted-mcp-connectors.md`](../../hosted-mcp-connectors.md)). Full contract in
**Agent behavior**.

### Activity

`meeting.summarized` webhook events (and poll-discovered completed meetings)
become `fireflies.meeting.summarized` activities in the owning workspace,
digestible per [`connector-digestibility.md`](../../connector-digestibility.md):
title, date, attendees, and the summary overview and action items.
`meeting.transcribed` becomes an operational `fireflies.meeting.transcribed`
activity (not digestible — the summarized event supersedes it minutes later;
double-digesting one meeting is worse than a short delay). `bot_joined` is not
subscribed. Polling uses the checkpointed runner
(`apps/api/src/workflows/connector-poll.ts`) over the `transcripts` GraphQL
query with a `fromDate` cursor in `cursor_json`; webhook receipt advances the
same checkpoint so the two paths never double-ingest.

### Failure states

Provider `429` or daily-quota exhaustion (free-plan keys allow 50
requests/day) surfaces to the model as a retryable rate-limit error and pauses
polling until the window resets. An `auth_failed` from Fireflies marks the
connection `needs_reconnect` (a belief, not a gate — per
[`connectors.md`](../../connectors.md) the row keeps answering queries with
`status <> 'disabled'`). Webhook posts failing signature verification are
rejected and logged to `webhook_receipts` without touching the connection.

## Impact on the product contract

None — this adds a connector inside the existing connector contract. Meetings
enter Avalon as connector activity and on-demand reads, not as a new surface;
the agent's authority grows only by the reviewed read tools and the
already-governed hosted-MCP pass-through.

## Decision log

None yet.

## Key design decisions

1. **Mirror Granola's two-scope split exactly.** Workspace = admin API key +
   fixed reviewed tools + signed webhooks + polling; personal = hosted MCP
   OAuth pass-through. Rejected: a single OAuth-only connector — Fireflies has
   no team-level OAuth app; the API key is the only workspace-grade credential
   it offers, and the MCP OAuth flow authenticates one member, not an
   organization.
2. **Workspace tools are static code-authored GraphQL reads, not the hosted MCP
   server driven by the API key.** The MCP server accepts Bearer API keys, so
   pointing the pass-through at it was possible. Rejected because pass-through
   tools are all treated as confirmed writes (unusable for automation-time
   reads), several are marked experimental by Fireflies and can change shape
   under us, and a fixed GraphQL document keeps the read authority reviewable
   field by field.
3. **The model never writes GraphQL.** Each tool executes a fixed, checked-in
   GraphQL document with validated variables. Rejected: a raw GraphQL
   pass-through tool — unbounded read authority, introspection exposure, and
   un-reviewable field access.
4. **Only `meeting.summarized` is digestible.** `meeting.transcribed` is
   operational. Rejected: making both digestible — one meeting would digest
   twice minutes apart.
5. **Accept degraded visibility on non-Enterprise keys.** The connection
   honestly reads whatever the key's account can see, and the UI says so.
   Rejected: requiring Fireflies Enterprise + Super Admin — it would exclude
   most Fireflies customers for a purity the product does not need.
6. **Webhooks are optional; polling is the guarantee.** Fireflies webhook
   registration is dashboard-only (no API), and its retry behavior is
   undocumented, so activity correctness cannot depend on it. The checkpointed
   poll is authoritative; webhooks reduce latency.
7. **A signing secret is mandatory for Avalon's endpoint even though Fireflies
   treats it as optional.** Unsigned posts to `/webhooks/fireflies/:id` are
   rejected. Rejected: accepting unsigned webhooks — the endpoint would ingest
   attacker-authored activity.

## Data model

A new migration (next free number, following the
`0048_granola_connector.sql` full-rebuild pattern for `connector_connections`
and its ~20 child tables):

- Add `'fireflies'` to the `connector_type` CHECK constraint.
- Partial unique indexes:
  `connector_connections_fireflies_workspace_active_uq` on
  `(workspace_id, connector_type) WHERE connector_type = 'fireflies' AND scope
  = 'workspace' AND status <> 'disabled'`, and
  `connector_connections_fireflies_personal_active_user_uq` on
  `(workspace_id, connector_type, owner_user_id)` with the personal
  predicate — one active connection per scope per owner, as Granola.
- Add `'fireflies'` to the `connector_oauth_attempts.provider` CHECK and to
  `ConnectorOAuthProviders` in
  `packages/contracts/src/connector-oauth-providers.ts` (personal OAuth).
- `encrypted_credentials` holds, AES-GCM-sealed as today: the API key and the
  webhook signing secret (workspace), or the MCP OAuth token set (personal).
- `cursor_json` holds `{ "lastMeetingDate": "<ISO 8601>" }` for the workspace
  poll checkpoint. No new tables. No backfill.

`ConnectionSchema.connectorType` in `packages/contracts/src/index.ts` gains
`fireflies`; the manifest declares `supportedScopes: ["personal",
"workspace"]` with `capabilityConnectionScopes` narrowing
`fireflies.workspace.read` to `["workspace"]` and `fireflies.personal.read` to
`["personal"]`, mirroring `GranolaCapabilities`.

## Regional impact

Connections, credentials, cursors, and activities live in the regional D1 of
the owning workspace, encrypted with that region's
`CONNECTOR_CREDENTIALS_KEY_*`; the webhook endpoint is served by each regional
Worker, so an EU workspace's webhook traffic terminates in the EU Worker.
Nothing new crosses the regional boundary. Fireflies itself is a US-based
processor and its data residency is its own; connecting is a customer's
processor decision, as with Granola and Notion. No Global-registry or ingress
changes.

## Security and trust model

- The API key is admin-entered once, verified, sealed with `CredentialCipher`
  (AES-GCM, connection ID as AAD), and never returned to the desktop or
  written to `config_json`, display names, or audit data.
- Every provider call takes the branded `AuthorizedConnectorConnection` minted
  only by `withAuthorizedConnection`; personal OAuth tokens refresh behind the
  existing D1 lease.
- Webhook posts are verified with HMAC-SHA256 over the raw body against the
  stored secret, compared timing-safe with the `X-Hub-Signature`
  (`sha256=<hex>`) header, before any parsing; failures land in
  `webhook_receipts` and are dropped.
- Webhook payloads carry only event name and meeting ID; ingestion re-reads
  the meeting through the authenticated GraphQL API, so untrusted payload
  content never becomes activity text directly.
- Personal MCP tools run inside the pass-through's existing containment:
  confirmed-write treatment, schema/response caps, and origin-pinned OAuth.
- No new Worker secrets: the workspace credential is customer-supplied and the
  personal flow uses dynamic client registration.

## Agent behavior

### Plugin contract

One plugin per eligible connection, built in
`apps/api/src/services/integrations.ts` as today:

- Canonical ID `connection:<uuid>`; model-visible ID from `model_plugin_id`,
  `plugin_fireflies` (`plugin_fireflies_2` for a coexisting personal
  connection, per the existing uniqueness index).
- Wire prefix `fireflies_` (`fireflies_2_` for the second connection) via
  `stableWireToolName`.
- Availability: workspace plugin in every ad-hoc work stream of the workspace,
  workspace automations only when explicitly bound; personal plugin only for
  its owner principal. Authority is capability ∩ grant, refused via
  `connectorCapabilityRefused` with `reason: "capability_not_granted"`.
- Lazy-loaded through discovery (`list_plugins` / `search_plugins` /
  `load_plugin`), never preloaded. Search aliases: "meeting", "meetings",
  "transcript", "call", "recording", "recap", "notetaker", "action items" —
  the host adds the brand.
- System message (exact): "Fireflies holds this team's meeting recordings.
  Search meetings first to get a meetingId, then read the summary before the
  full transcript — transcripts are long. All tools are read-only; you cannot
  change or share anything in Fireflies."
- Loading the plugin activates the connection surface and persists the
  activation acknowledgement; it starts no jobs and grants nothing beyond the
  recorded capabilities. Tool order is as listed below.

### Tool catalog (workspace static tools)

All three: capability `fireflies.workspace.read`, mode `read`, idempotency
`safe`, timeout 30 s, parallel execution allowed.

| Canonical | Wire name | Description (model-facing) |
| --- | --- | --- |
| `meetings.search` | `fireflies_meetings_search` | Search the team's Fireflies meetings by keyword, date range, or participant. Returns meeting metadata and IDs; use an ID with the summary or transcript tool. |
| `meeting.summary` | `fireflies_meeting_summary` | Read one meeting's AI summary: overview, action items, keywords, outline, plus attendees and timing. Requires a meetingId from search. |
| `transcript.read` | `fireflies_transcript_read` | Read one meeting's transcript sentences with speakers and timestamps, paged. Requires a meetingId from search. |

The personal connection has no static catalog; its tools are the provider's
live MCP surface loaded at activation (`fireflies_search`,
`fireflies_get_transcript`, … as Fireflies publishes them), governed by
[`hosted-mcp-connectors.md`](../../hosted-mcp-connectors.md).

### Wire shapes

All inputs are strict objects (`additionalProperties: false`); unknown fields
are rejected at runtime by the schema the manifest advertises.

**`fireflies_meetings_search`** — input: `keyword` (string ≤ 255, optional),
`fromDate` / `toDate` (ISO 8601 strings, optional), `participantEmail` (email
string, optional), `hostEmail` (email string, optional), `limit` (integer
1–25, optional, default 10), `skip` (integer ≥ 0, optional, default 0). At
least one of `keyword`, `fromDate`, `participantEmail`, `hostEmail` is
required. Success output:

```json
{
  "meetings": [{
    "meetingId": "…", "title": "…", "date": "2026-08-12T15:00:00.000Z",
    "durationMinutes": 42, "hostEmail": "…",
    "participants": ["…"], "hasSummary": true, "meetingUrl": "https://…"
  }],
  "nextSkip": 10
}
```

`nextSkip` is `null` when the page is not full. Provider paging is
`limit`/`skip` (provider max 50 per call); Avalon caps `limit` at 25 to bound
response size.

**`fireflies_meeting_summary`** — input: `meetingId` (string, required).
Success output: `meetingId`, `title`, `date`, `durationMinutes`, `hostEmail`,
`attendees` (array of `{ name, email }`), `summary` object with `overview`
(string), `actionItems` (string array), `keywords` (string array), `outline`
(string), and `transcriptAvailable` (boolean).

**`fireflies_transcript_read`** — input: `meetingId` (string, required),
`offset` (integer ≥ 0, optional, default 0), `maxSentences` (integer 1–500,
optional, default 200). Success output: `meetingId`, `title`, `sentences`
(array of `{ index, speakerName, startSeconds, text }`), `nextOffset`
(integer, or `null` at the end). Long transcripts are read by repeating the
call with the returned `nextOffset`.

### Discovery and sequencing

`meetingId` comes only from `fireflies_meetings_search` (or from a
`fireflies.meeting.summarized` activity, which embeds it). Common sequences:
search → summary; search → summary → transcript pages. There are no
revisions, mutations, or `expectedRevision` semantics — every tool is a safe
read — and no shell path reaches the provider.

### Failure and self-healing contract

Stable codes, with the exact model-visible sentence in `output`:

- `fireflies_auth_failed` — "Fireflies rejected this connection's credentials.
  Stop using Fireflies tools and tell the participant the connection needs to
  be reconnected in Settings → Connections." (Connection is marked
  `needs_reconnect`; do not retry.)
- `fireflies_rate_limited` — "Fireflies rate-limited this request. Retry once
  after the delay in retryAfterMs; if it fails again, continue without
  Fireflies data and say so." (`data.details.retryAfterMs` populated; one
  retry.)
- `fireflies_not_found` — "No Fireflies meeting has that ID. Call
  fireflies_meetings_search again and use a meetingId from its results."
  (Correct and retry.)
- `fireflies_forbidden` — "The connected Fireflies account cannot see that
  meeting. Only meetings visible to the connected account can be read; search
  again or tell the participant." (Do not retry the same ID.)
- `fireflies_unavailable` — "Fireflies did not respond. Retry once; if it
  still fails, continue without Fireflies data and say so." (Transport
  failure; distinct from the domain outcomes above.)

An empty search result is a normal domain outcome (empty `meetings` array),
not an error. Recovery instructions live in model-visible `output` /
`data.details`, never only in `summary`.

### Authority, safety, and lifecycle

Which connection backs a call is host-derived from the plugin's canonical ID;
the model chooses tools, never credentials. Reauthorization runs at run start,
before decryption, before every call, and between turns, with the standard
`authorized` / `denied` / `indeterminate` verdicts. Cancellation aborts the
in-flight fetch via the signal already threaded through adapters; truncated
transcript reads return `nextOffset` as the bounded recovery path; replays of
a `safe` read simply re-execute.

### Next-step outputs

Every search row returns `meetingId` (the key for both other tools) plus
`nextSkip`; transcript pages return `nextOffset`; summary returns
`transcriptAvailable` so the model knows whether the transcript call can
succeed.

### Model-usability acceptance

Schema snapshot and contract tests cover required/optional/forbidden inputs
and success and failure shapes for all three tools; the registry
cross-validation and `connector-credential-freshness` suites enroll the
adapter automatically. Prompt evaluations on the configured medium fallback
model cover: discovering the plugin from "what happened in Tuesday's customer
call", the search → summary → transcript sequence, a wrong-ID first call
recovering via search, stopping on `fireflies_auth_failed`, and absence of
blind retry loops on `fireflies_rate_limited`.

## Provider configuration

All configuration is the customer's, in the Fireflies dashboard — Avalon
registers nothing with Fireflies and adds no Worker secrets:

- **API key** (workspace scope): Fireflies → Integrations → Fireflies API.
  Team-wide visibility additionally requires Fireflies Enterprise with Super
  Admin enabled; otherwise the key reads its owner's meetings only.
- **Webhook** (optional, workspace scope): Fireflies → Settings → Developer
  settings — paste the endpoint URL and signing secret shown in Avalon's
  connect modal. Without it, activity arrives on the poll interval only.
- Fireflies rate limits are the customer's plan's: 60 req/min
  (Business/Enterprise), 500/day (Pro), 50/day (Free). Nothing breaks if
  webhook configuration is skipped.

## Rollout

Catalog exposure is gated by a client feature flag `fireflies-connector` in
`apps/api/src/services/client-feature-flags.ts` (closed to off): the desktop
hides the card and `GET /connections/catalog` omits `fireflies` until the flag
opens. The adapter registers unconditionally in
`apps/api/src/lib/connector-registry.ts` since it needs no Worker secrets.
Ship workspace scope first, personal MCP second if sequencing demands, both
behind the same flag. Turning the flag off hides new connections; existing
rows keep working, and hard rollback is `DELETE /connections/:id` per
connection. No migration rollback is needed — an unused `connector_type` value
is inert.

## Acceptance

1. Admin connects a workspace key in Settings → Connections; Test passes; the
   card shows the connected account's email.
2. In a work stream, asking about a recent meeting leads the agent to discover
   and load `plugin_fireflies`, search, and read the summary; the transcript
   pages through cleanly on a long meeting.
3. With the webhook configured, finishing a Fireflies meeting produces a
   `fireflies.meeting.summarized` activity; with the webhook absent, the same
   activity arrives after the next poll; it never arrives twice.
4. A digest automation subscribed to the connection digests the summary
   activity.
5. Revoking the key in Fireflies flips the connection to `needs_reconnect` on
   next use; reconnect with a fresh key restores it.
6. A member completes the personal OAuth flow; their work streams (and only
   theirs) can load the personal plugin's live tools.
7. An unsigned or mis-signed webhook post is rejected and recorded in
   `webhook_receipts`.

## Open questions

1. **Poll interval and quota budget.** A Free-plan key allows 50 requests/day,
   which a frequent poll alone could exhaust. Proposed: default the poll to
   hourly and back off on 429; decide whether to surface a plan-tier hint in
   the connect modal. Does not block the build.
2. **Personal MCP tool drift.** Fireflies marks several MCP tools
   experimental; the pass-through's surface hash already detects change, but
   we should decide whether a changed surface re-prompts activation
   acknowledgement. Follows the general hosted-MCP answer; does not block.
3. **`meeting.transcribed` promotion.** If real workspaces disable Fireflies
   AI summaries, `meeting.summarized` never fires and their meetings produce
   no digestible activity. If support requests show this, promote
   `fireflies.meeting.transcribed` to digestible for connections where no
   summary arrives — a decision-log entry when evidence exists.
