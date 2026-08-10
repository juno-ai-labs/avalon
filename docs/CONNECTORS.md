# Connector architecture

Connectors are typed adapters behind a registry. A manifest declares OAuth needs, supported personal/workspace scopes, activity and resource types, tools, polling, webhooks, and watches. The adapter owns provider protocol details; Avalon owns tenancy, execution principals, persistence, retries, schedules, and audit.

## Authorization model

- A personal connection can be used only by its owner principal.
- A workspace connection is an organization capability: every ad-hoc work stream in that workspace receives all tools granted to the connection. Those tool calls execute as the workspace principal, even when the run was started by a member.
- Workspace automations remain explicitly bound to selected workspace connections so a published automation cannot silently change providers or accounts.
- A work-stream participant does not expose their personal connections by joining.
- Tools require both a manifest capability and a capability recorded on the connection.
- Credentials are decrypted only for the duration of a backend operation.

Each installed credential has two deliberately separate plugin identities. The opaque canonical ID, `connection:<uuid>`, is the only identity used for authorization, durable activation, receipts, and credential access. A database-backed workspace-local ID is the model-facing name: the first active credential of a provider receives `plugin_<provider>`, and simultaneous additional credentials receive the lowest numeric suffix (`plugin_google_2`, `plugin_google_3`, and so on). Disabled connections do not reserve names, so removing and later re-adding a provider reclaims the clean base instead of accumulating random characters. A partial unique database index enforces uniqueness across the active connection list.

The model sees only these stable IDs in plugin catalogs, active-plugin instructions, and `load_plugin` arguments. Avalon resolves them back to canonical IDs before scope checks or persistence. Model-facing IDs are presentation and routing aliases, never security principals. Connector tool definitions use prefix-free names local to their plugin; the runtime adds the connection's stable short name when rendering model-facing tools. For example, canonical `drive.search` becomes `google_drive_search`, or `google_2_drive_search` for a second Google credential.

## Agent activation acknowledgement

Messaging-agent and native-agent adapters share `ConnectorAgentAdapter`. An adapter may implement `activationAcknowledgement(invocation)` to produce a fixed provider command; `acknowledgeConnectorAgentActivation` executes that command through the adapter after durable admission and authorization, but before context gathering, model calls, or tools. This is host control-plane behavior and is never left to model output. A retry must converge on the same provider state.

The hook is deliberately optional. Slack uses an `eyes` reaction on the exact triggering message and treats Slack's `already_reacted` result as success. Its operational host logs provider-side reaction failures and continues the admitted request so a supplemental acknowledgement cannot discard user work. Linear uses a `👀` reaction only when the current activation includes a source comment. A future message-oriented Teams, Discord, or GitHub agent can opt in when it has an unambiguous source object and a lightweight reaction API. Email, file, calendar, database, and ordinary resource-webhook connectors should not acknowledge activation: they have no conversational source message, and manufacturing a reply or mutation would be noisy or misleading.

## Google

Google identity and connector authorization are separate. Connector authorization uses the web-server code flow, PKCE, offline access, and incremental scopes. Settings presents two product-facing presets, but both create ordinary `google` connections backed by the same adapter, credential lifecycle, OAuth callback, and tool registry. They are authorization bundles, not separate backend connector types, and a user may connect either or both.

| Settings preset | Requested Avalon capabilities |
| --- | --- |
| **Google Mail + Calendar** | `gmail.read`, `gmail.draft`, `gmail.send`, `calendar.read`, `calendar.write` |
| **Google Drive + Docs + Sheets** | `drive.read`, `docs.read`, `docs.write`, `sheets.read`, `sheets.write` |

The capability check is enforced for every tool invocation. The current Google tools are:

- Gmail: `google_gmail_search`, `google_gmail_read_thread`, `google_gmail_read_message`, `google_gmail_create_draft`, and `google_gmail_send`.
- Calendar: `google_calendar_list_calendars`, `google_calendar_list_events`, `google_calendar_read_event`, `google_calendar_create_event`, and `google_calendar_update_event`. Event tools accept an explicit calendar ID and otherwise use the primary calendar; scheduled activity polling currently follows the configured calendar, which defaults to primary.
- Drive: `google_drive_search`, `google_drive_get_metadata`, `google_drive_download`, and `google_drive_export`.
- Docs: `google_docs_read_document`, `google_docs_create_document`, `google_docs_append_text`, and `google_docs_replace_text`.
- Sheets: `google_sheets_read_spreadsheet`, `google_sheets_read_values`, `google_sheets_create_spreadsheet`, `google_sheets_update_values`, and `google_sheets_append_values`.

Docs and Sheets operations use their native provider APIs. Docs reads return bounded document structure and text; writes create a document, append plain text, or replace exact text. Sheets reads return bounded spreadsheet metadata or formatted values from an explicit A1 range; writes create a spreadsheet or update/append bounded row values. Drive download/export remains available for file-oriented retrieval, but it does not replace the native Docs and Sheets operations.

Google activity ingestion is polling-only. Gmail, Calendar, and Drive are independent named activity streams under one connection. Each commits its own provider-native high-watermark—Gmail history IDs, Calendar sync/completion tokens, or Drive change page tokens—only after its canonical activities are persisted. A transient failure in one stream preserves that stream's checkpoint without forcing successful sibling streams to replay; the scheduler uses the earliest backlog or retry deadline. Drive change polling classifies Google Workspace MIME types into `docs.document_changed` and `sheets.spreadsheet_changed`; other files produce `drive.file_changed`. Consequently `drive.read` is included in the Drive + Docs + Sheets preset and is the event source for Docs and Sheets changes. Avalon does not currently register Gmail Pub/Sub watches, Calendar notification channels, Drive push notifications, or any other Google webhook. Avalon resource watches route the normalized polled activity and must not be confused with provider push delivery.

A revoked refresh grant marks the connection `needs_reconnect`. Production smoke tests should create a Gmail draft rather than send unsolicited mail. A personal Gmail send tool is available only to its owner; if an administrator creates a workspace-scoped Gmail connection through the backend, its granted send capability rolls down to every work stream like every other workspace capability.

The two records are isolated by Avalon capability checks, not by separate Google OAuth principals. Because both presets use one OAuth client with incremental authorization, Google may return a token containing scopes previously granted to that account; Avalon still exposes only the capabilities recorded on the particular connection. Disconnect is local when another Google connection for that account remains. Operators must not describe the presets as provider-level credential isolation.

## GitHub App

GitHub uses one public App with a signature-verifying smart ingress. One installation may be connected to Global workspaces, EU workspaces, or both; an indexed installation directory fans exact signed deliveries only to the applicable regional Workers. OAuth callbacks, credentials, raw payload storage, normalization, and activity processing remain regional. Workspace connections execute with short-lived installation tokens. Personal connections require an expiring user token and prove that the user can access the selected installation and repository.

The agent can list repositories and commits, read files, inspect and create/update issues and comments, inspect and create/review pull requests, and read Actions and check runs. GitHub delivery signatures are verified against the exact raw body before installation-aware normalization and queueing. Webhooks also discover durable repository, commit, file, issue, pull-request, release, workflow-run, and check-run resources so people and agents can attach provider objects directly to work streams without copying their content into Avalon. Issue-dependency and sub-issue deliveries add both sides of the relationship, including cross-repository issues, while retaining one normalized activity per delivery.

## Linear

Linear is a composable connector with both `resource` and `native_agent` surfaces. One public OAuth app supports two identities through PKCE: personal connections use `actor=user` and remain private to their Avalon owner; workspace connections use `actor=app` and roll their tools down to every member. The native surface is bound explicitly to the workspace-only, non-tool `linear.agent` capability. It grants `app:assignable` and `app:mentionable` for activation plus `write` for the deterministic source-comment acknowledgement; resource tools independently grant `read`, `issues:create`, `comments:create`, and `write`. The resource agent can search/read issues and projects, list teams, create/update issues, and create comments.

Linear's one public webhook is timestamp/signature verified at a dedicated smart ingress, routed by organization to the owning Global/EU connections, verified again, normalized, deduplicated by `Linear-Delivery`, and queued regionally. Workspace app connections receive matching resource events directly. A personal connection receives a delivery only after its own token proves access to the signed resource or a signed parent in one bounded GraphQL probe; its normalized activity remains personal and targets only its Avalon owner. Authorization loss marks that connection `needs_reconnect`, and lifecycle/native-agent events never fan out to personal connections. Agent-session events are represented explicitly rather than being flattened into ordinary resource updates.

The native-agent surface is a control-plane protocol, not a model-callable tool. `ConnectorAdapter.nativeAgent` supplies the typed invocation and outbound protocol facet; the manifest separately records `runtimeStatus`. Linear is currently `protocol_only`: the provider schemas and GraphQL operations exist, but the coordinating session-to-workstream runtime is deliberately not advertised as operational. Its descriptor records preview maturity, delegation/mention/follow-up invocation, authored activity kinds, cancellation, links, plans, proactive sessions, Linear's five-second webhook response deadline, and the ten-second first-activity deadline.

Native sessions are additionally matched by organization, granted `linear.agent` capability, and the signed event's `appUserId`; a resource-only connection never receives a delegation. Desktop authorization requests `linear.agent` only when `VITE_LINEAR_NATIVE_AGENT_ENABLED=true`, and the API independently requires both `LINEAR_NATIVE_AGENT_ENABLED=true` and an `operational` connector runtime. Keep the flags off and the runtime `protocol_only` until the fast durable inbox, unique native-session ownership, session/run mapping, cancellation coordinator, durable activity outbox, and timing acceptance suite are complete.

## Notion

Notion uses public connections with an `Any workspace` installation scope and the provider's page picker. The agent can search and retrieve pages/data sources, query data sources, create pages, update or append Markdown, and read/create comments. Only pages explicitly shared during installation are visible.

Notion's one-time webhook verification token is accepted through a guarded regional setup URL, encrypted in D1, and then used to verify every later webhook signature before normalization and queueing.

## Granola

Granola has two intentionally separate connection modes. A personal connection uses Granola's hosted Streamable HTTP MCP server and browser OAuth with PKCE and dynamic client registration. It follows the member's currently active Granola workspace and exposes Granola's six read tools for querying meetings, listing folders and meetings, reading meeting details and transcripts, and inspecting the connected account. A personal connection remains available only to its Avalon owner.

A workspace connection uses one administrator-created Granola Workspace API key. It exposes bounded read operations for listing notes, reading a note with an optional transcript, and listing folders. Avalon creates the Granola webhook endpoint during installation with Granola's required `workspace` scope and note access/edit/generation events. This admits notes visible through that Workspace API key. Deliveries are verified against their untouched raw body using the endpoint's Standard Webhooks signing secret before storage, deduplication, normalization, and queueing. Granola's delivery is a change signal, so Avalon hydrates the current note through `GET /v1/notes/{note_id}` before opportunity admission. Disconnecting the connection removes the remote endpoint when Granola accepts the request.

The workspace key and the webhook signing secret are encrypted in the workspace's regional D1 database with AES-GCM and connection-ID additional authenticated data. The plaintext key is accepted only by the admin-only setup request, is never stored in connection configuration, provider identifiers, or audit data, and is never returned to the desktop. One active Granola workspace connection is allowed per Avalon workspace; one active personal Granola connection is allowed per member and workspace.

## X

X is a workspace-only, read-only public-data connector backed by Avalon's regional TwitterAPI.io account; it is not an X OAuth connection and does not represent an authorized X user. It provides public user timelines, thread context, replies, and List timelines. All four tools return one provider page at a time and expose the returned cursor for explicit pagination. Thread reads include the original post even when it is absent from the initial thread page.

## Web discovery

The loadable `avalon:web` plugin exposes `web_search` and `web_fetch` through Firecrawl. Search returns bounded ranked links; fetch accepts only safe public HTTP(S) URLs and returns bounded clean Markdown. The plugin is omitted entirely when the regional `FIRECRAWL_API_KEY` secret is absent.

## Generic webhook

Each connection receives a unique secret and URL. Send compact JSON with a Unix timestamp and signature header:

```text
X-Avalon-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<seconds>.<raw body>">
```

Avalon validates time, signature, replay receipt, body schema, scope, and dedupe key before normalizing an activity. Transcript providers can use this connector, but the product must not label it a native Granola integration.

Settings exposes personal and administrator-only workspace webhook creation. Creation accepts an idempotency key so a retried response returns the same endpoint and still-current one-time secret. Owners can rotate a webhook secret later; rotation keeps the endpoint stable and invalidates the old secret immediately.

The request body must be a JSON object no larger than the regional provider-webhook limit. The supported fields are:

- `provider_event_id` or `id`: stable source delivery identity, up to 500 characters. If both are absent, Avalon derives an identity from the normalized signature.
- `event_type`: source event name, up to 500 characters. Omission becomes `webhook.received`; a connection configured with allowed event types rejects names outside that allowlist.
- `resource_type` and `provider_resource_id`: optional stable source resource identity.
- `occurred_at`: optional ISO 8601 timestamp with an explicit offset.
- `title`, `summary`, and `text` or `text_snippet`: bounded human-readable evidence. Only the compact normalized snippet enters activity metadata; the exact signed body remains in regional payload storage.
- `actor` and `subject`: optional JSON objects describing the source actor and object.
- `entity_keys`: up to 100 stable correlation keys; `dedupe_key`: an optional stable idempotency key.
- `target_user_ids`: for workspace connections only, up to 100 active members of that same Avalon workspace. Personal connections always target their owner and ignore supplied targets.
- `external_people`: up to 100 bounded external-person references. Generic-webhook claims remain unverified source evidence and can never create a reusable verified identity mapping.
- `metadata`: optional provider-specific JSON metadata.

Avalon verifies the HMAC over the exact received bytes before UTF-8 decoding or JSON parsing. Invalid signatures return `401`, malformed or schema-invalid bodies return `400`, disallowed events or non-member targets return `422`, identity/dedupe collisions return `409`, oversized bodies return `413`, and new deliveries return `202` (`200` when the same delivery is already known). Senders should retry network failures and `5xx` responses with exponential backoff using the same identity and exact body; they must not reuse an identity or dedupe key with changed content.

## Activity ingestion

Connectors expose one of two provider-facing activity facets while sharing the same normalized activity, persistence, queue, identity, and opportunity pipeline:

- `webhookActivity.verify` verifies exact raw bytes and returns a provider-neutral delivery envelope; `normalize` applies connection scope and provider-specific semantics. GitHub, Granola, Linear, Notion, and generic webhook use this facet.
- `pollingActivity` declares named streams and polls each from an opaque provider-native high-watermark. Its required `normalizeHighWatermark` hook canonicalizes sequences, dates, cursors, legacy values, or composite provider state both when checkpoints are loaded and before they are committed. The shared checkpoint runner bounds retries and backlog scheduling while leaving provider hooks in control of checkpoint semantics, pagination, reset/reconciliation rules, and activity normalization. Google currently supplies Gmail, Calendar, and Drive streams.

Manifests and facets are cross-validated at registry construction: a connector that declares provider activity cannot claim webhook or polling support without the corresponding implementation. Slack keeps its dedicated signature-verified Agent ingress, but that ingress may normalize a bounded event into the shared activity pipeline when an exact active automation source is listening; it does not create a general Slack feed. X remains an on-demand read connector because a connection does not yet select a monitored user, list, or stream rule from which a safe feed could be constructed.

1. Verify or poll the provider.
2. Normalize compact metadata and store any large raw body in R2.
3. Insert with provider/dedupe uniqueness.
4. Enqueue only region, workspace ID, and activity ID.
5. Evaluate explicit resource watches and deterministic automation triggers.
6. Run semantic trigger matching only after deterministic prefilters.
7. Create automation work idempotently or produce an in-stream contextual suggestion.
8. Persist accepted/dismissed routing feedback.

Native GitHub, Linear, and Notion deliveries use the same compact queue envelope and routing pipeline. Their exact signed raw payload is retained regionally in R2, while D1 stores an idempotent delivery receipt and normalized metadata.

A connector's normalized `title`/`summary` is not independently bounded to the API contract's suggestion and resource limits (`ActivitySuggestionSchema`/`ResourceSchema` in `packages/contracts`, 300 characters for `title`). Each connector truncates to its own cap before writing `activities` — GitHub's webhook titles cap at 500 — which is wider than what the response schema accepts. `WorkstreamService`/`WorkstreamRoom` defensively truncate at every read and write site that surfaces this data, but a new connector should not rely on that alone: keep any new title/summary truncation at or under 300/2,000 characters at the connector layer too, so a work stream never depends solely on a downstream guard to stay openable.

Slack is a composable `resource` and `messaging_agent` connector. Workspace installations host the Agent, App Home, interactive surfaces, activity triggers, and deterministic automation delivery; the bot joins existing public channels after install/reconnect and new public channels when Slack reports their creation. Accepted DM and mention prompts receive an immediate `eyes` reaction through the shared activation hook before processing. Optional personal authorizations use Slack's hosted MCP server for user-scoped tools. Slack delivers bounded message, reaction, file-share, channel, and membership events. Agent-thread events follow the existing conversational path; events matching an exact active automation source are normalized into the shared regional activity pipeline. Unmatched activity is discarded before durable queueing and is never turned into a general Slack feed or mirrored corpus. See `docs/SLACK_INTEGRATION.md` for the product and data flow and `docs/SLACK_PERMISSIONS.md` for the complete OAuth scope inventory.
