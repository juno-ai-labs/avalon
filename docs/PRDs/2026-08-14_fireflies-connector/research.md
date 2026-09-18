# Fireflies.ai platform research

> Created 2026-08-14. Provider facts behind
> [the Fireflies connector PRD](prd.md), gathered from the official
> documentation at <https://docs.fireflies.ai> (index:
> <https://docs.fireflies.ai/llms.txt>). Verify against the live docs before
> building — Fireflies notes it is "actively working to expose more
> functionality" and marks parts of the MCP surface experimental.

## API shape

One GraphQL endpoint (`https://api.fireflies.ai/graphql`), documented at
<https://docs.fireflies.ai/getting-started/introduction>. Queries cover
transcripts, users, channels, analytics, soundbites ("bites"), contacts, and
audit events; mutations cover sharing, meeting metadata, soundbites, AskFred
threads, audio upload, and transcript deletion. An OpenAPI spec is published
at <https://docs.fireflies.ai/api-reference/openapi.json>.

## Authentication

Per <https://docs.fireflies.ai/fundamentals/authorization>: a per-account API
key, copied from Fireflies → Integrations → Fireflies API, sent as
`Authorization: Bearer <key>`. There is no team-level OAuth app for the
GraphQL API, and no app model at all: the Developer Program
(<https://docs.fireflies.ai/getting-started/developer-program>) is a
three-month Business-tier trial plus a partner listing (SOC 2 report, help
article, support email, logo), not a client registration. A malformed header
yields `auth_failed`.

**Visibility follows the key's account.** By default a key reads the owning
account's meetings. Team-wide access — "query all data in your team's
account", bypassing member privacy settings — requires the **Super Admin**
feature, which is Enterprise-tier only and enabled by a company admin
(<https://docs.fireflies.ai/fundamentals/super-admin>). This is why the PRD's
workspace connection documents degraded visibility on non-Enterprise plans
rather than requiring Enterprise.

## Rate limits

Per <https://docs.fireflies.ai/fundamentals/limits>:

| Plan | Limit |
| --- | --- |
| Free | 50 requests/day |
| Pro | 500 requests/day |
| Business / Enterprise | 60 requests/min |

Specialized caps: Add to Live 3 requests/20 min; Share Meeting 10
requests/hour. Hydration and tool calls share this budget, which is one reason
the PRD hydrates a meeting once per admitted event and does not also poll
(non-goal 8): an hourly poll alone would spend 24 of a Free plan's 50 daily
requests.

## The `transcripts` query

Per <https://docs.fireflies.ai/graphql-api/query/transcripts>: filters include
`keyword` (≤255 chars, with `scope` title/sentences/all), `fromDate`/`toDate`
(ISO 8601), `host_email`, `organizers[]`, `participants[]`, `user_id`,
`mine`, `channel_id`; pagination is `limit` (max 50) and `skip`. A
`Transcript` exposes the summary (`keywords`, `action_items`, `outline`,
`shorthand_bullet`, `overview`, and more), sentences (speaker, text,
timestamps, AI filters), attendees with join/leave times, duration,
analytics, media URLs, and the meeting link — the source material for the
PRD's three static tools and for the post-admission hydration of a webhook
event.

Per <https://docs.fireflies.ai/schema/summary>, the `Summary` type's
`action_items` and `keywords` are scalar `String` fields; `topics_discussed`
and `transcript_chapters` are `[String]`. The PRD's summary tool passes the
scalars through as text rather than splitting them on a guessed delimiter.

The `transcripts` query paginates **transcripts** with `limit`/`skip`; there
is no server-side pagination of a single transcript's `sentences` array, and
no documented stable ordering or tie-breaker within a timestamp boundary —
which is why the PRD's transcript tool re-fetches the whole document per
page. `fromDate`/`toDate` filter on the transcript's creation date; there is
no modified-since filter and no summary-completion cursor, so a poll that
wanted to be complete would have to carry the ids of meetings whose summary
has not yet appeared and re-read them by id — the design non-goal 8 records
and defers.

## Webhooks

Two generations. **Webhooks V2**
(<https://docs.fireflies.ai/graphql-api/webhooks-v2>) is the one the PRD
targets:

- Registered **on Fireflies' dedicated Webhooks V2 configuration page in the
  dashboard only** (HTTPS URL + optional signing secret + per-event
  subscription); there is no registration API. The OpenAPI spec exposes no
  webhook create, inspect, update, or delete operation (checked 2026-09-12),
  and the only programmatic hook is a per-upload `webhook` argument on
  `uploadAudio`, which covers that upload alone. This page is distinct from
  the legacy Developer-settings webhook and from the Enterprise Super-Admin
  team-wide webhook. Hence the PRD's adoption of the connector installation
  lifecycle's manual completion path: every registration operation is
  manual, inspection is unsupported, and an installation is verified only by
  its first delivery.
- V2 events are emitted only for meetings the webhook's account organizes —
  the FAQ states it plainly: "Webhooks are only fired for meetings you own"
  — while a Super Admin key can *query* the wider team-visible set. On a
  plan without Super Admin, the activity feed is therefore one person's
  meetings, which the PRD's consent copy states.
- Events: `meeting.transcribed`, `meeting.summarized`, `meeting.bot_joined`,
  individually selectable.
- Payload: JSON `{ event, timestamp, meeting_id, client_reference_id? }` —
  identifiers only, so ingestion re-reads the meeting over GraphQL.
- Signature: `X-Hub-Signature: sha256=<hex HMAC-SHA256 of the raw body>`,
  timing-safe comparison recommended. Fireflies treats the secret as
  optional; the PRD makes it mandatory on Rally's side.
- Delivery: 2xx required within 10 s; retry behavior is not documented, and
  there is no test ping — the PRD makes a missed delivery visible rather than
  compensating for it (non-goal 8), and the meeting an admin records after
  setup is the verification. **Corrected 2026-09-13:** the configuration page
  has a **Send test event** button. It delivers `{ event: "test", timestamp,
  meeting_id: "test_00000000" }`, signed with the configured secret and with
  an `X-Webhook-Delivery-Id: test-…` header, none of it documented; the
  ingress accepts it as the verifying delivery.

The Super Admin tier additionally offers team-wide webhooks configured in
Developer settings.

## Hosted MCP server

Per <https://docs.fireflies.ai/getting-started/mcp-configuration> and
<https://docs.fireflies.ai/mcp-tools/overview>, and the announcement at
<https://fireflies.ai/blog/fireflies-mcp-server/>:

- Remote server at `https://api.fireflies.ai/mcp`, HTTP transport, supporting
  **OAuth against the Fireflies account** (the PRD's personal flow) or a
  Bearer API key.
- **Verified 2026-09-10 against the live server:**
  `https://api.fireflies.ai/.well-known/oauth-protected-resource` (and the
  `/mcp` path-suffixed form) returns RFC 9728 metadata naming
  `https://api.fireflies.ai/` as the authorization server; that server's
  metadata advertises `registration_endpoint` (`/register`), PKCE `S256`,
  the `authorization_code` and `refresh_token` grants, scopes `profile` and
  `email`, and token-endpoint auth `client_secret_post` or `none`; an
  unauthenticated `initialize` answers 401 with a `WWW-Authenticate` header
  pointing at that metadata. This is what `createHostedMcpPassthrough`'s
  `oauth` block needs, so no per-region client secrets are required. Whether
  a refresh token is issued without an `offline_access` scope is the PRD's
  open question 6.
- Read tools: `fireflies_search` (experimental), `fireflies_get_transcripts`,
  `fireflies_get_transcript`, `fireflies_fetch` (experimental),
  `fireflies_get_summary`, `fireflies_get_active_meetings`,
  `fireflies_get_analytics`, `fireflies_list_channels`,
  `fireflies_get_channel`, `fireflies_get_soundbites`, `fireflies_get_user`,
  `fireflies_get_usergroups`, `fireflies_get_user_contacts`,
  `fireflies_get_rule_executions` (Enterprise).
- Write tools: `fireflies_share_meeting`, `fireflies_revoke_meeting_access`,
  `fireflies_update_meeting_title`, `fireflies_move_meeting`,
  `fireflies_create_soundbite`.
- The write tools existing on the same surface is why the pass-through's
  treat-everything-as-a-confirmed-write invariant matters for the personal
  connection, and why the workspace connection does not reuse the MCP server
  with the API key (PRD key design decision 2).

## Other surfaces (out of scope, noted for the non-goals)

- **Realtime API** (<https://docs.fireflies.ai/realtime-api/overview>): live
  meeting event stream — non-goal 2.
- **Audio upload** (`uploadAudio` mutation) — non-goal 3.
- **AskFred** (<https://docs.fireflies.ai/askfred/overview>): Fireflies' own
  meeting-QA agent, also exposed via API — non-goal 4.
- **Zapier integration** exists; irrelevant to a native connector.

## Repository precedent

Granola is the structural template for the adapter: two scopes on one adapter
(`packages/connectors/src/granola.ts`), a workspace admin API key, personal
hosted MCP OAuth via `createHostedMcpPassthrough`, a signed-webhook facet
whose normalized activity is a change signal hydrated after admission, and
the digestibility split between generated and operational note events. Its
D1 migration, `0048_granola_connector.sql`, is history rather than precedent:
`0090_drop_legacy_product_tables.sql` retired the D1 connector tables, and
the schema change for a new connector type is a WorkspaceDO migration in the
shape of migration 53 in `workspace-do.ts`, which admitted Ashby (the PRD's
data model has the recipe). The setup, verification,
maintenance, and removal of the workspace webhook follow
[the connector installation lifecycle PRD](../2026-09-12_connector-installation-lifecycle/prd.md)
instead of Granola's connection-service path — shipped in
[`connector-installation-lifecycle.md`](../../connector-installation-lifecycle.md),
whose management facet (`packages/connectors/src/installation.ts`) states
each operation as automatic, manual, or unsupported. Ashby is the automatic
case, Granola the mostly-automatic one, and Fireflies the first provider
whose every operation is manual or unsupported. See
[`connectors.md`](../../connectors.md) and
[`hosted-mcp-connectors.md`](../../hosted-mcp-connectors.md).
