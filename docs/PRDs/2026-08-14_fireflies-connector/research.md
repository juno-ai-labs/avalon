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
GraphQL API. A malformed header yields `auth_failed`.

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
requests/hour. These bound the PRD's poll-interval question (open question 1).

## The `transcripts` query

Per <https://docs.fireflies.ai/graphql-api/query/transcripts>: filters include
`keyword` (≤255 chars, with `scope` title/sentences/all), `fromDate`/`toDate`
(ISO 8601), `host_email`, `organizers[]`, `participants[]`, `user_id`,
`mine`, `channel_id`; pagination is `limit` (max 50) and `skip`. A
`Transcript` exposes the summary (`keywords`, `action_items`, `outline`,
`shorthand_bullet`, `overview`), sentences (speaker, text, timestamps, AI
filters), attendees with join/leave times, duration, analytics, media URLs,
and the meeting link — the source material for the PRD's three static tools
and the poll checkpoint (`fromDate` cursor).

The `transcripts` query paginates **transcripts** with `limit`/`skip`; there
is no server-side pagination of a single transcript's `sentences` array, and
no documented stable ordering or tie-breaker within a timestamp boundary —
which is why the PRD's transcript tool re-fetches the whole document per page
and the poll uses an overlap window with insert-level dedupe rather than
trusting the ordering.

## Webhooks

Two generations. **Webhooks V2**
(<https://docs.fireflies.ai/graphql-api/webhooks-v2>) is the one the PRD
targets:

- Registered **on Fireflies' dedicated Webhooks V2 configuration page in the
  dashboard only** (HTTPS URL + optional signing secret + per-event
  subscription); there is no registration API. This page is distinct from the
  legacy Developer-settings webhook and from the Enterprise Super-Admin
  team-wide webhook. Hence the PRD's webhooks-optional,
  polling-authoritative design.
- V2 events are emitted for meetings owned by the webhook's account, while a
  Super Admin key can *query* the wider team-visible set — another reason the
  webhook cannot drive the poll checkpoint.
- Events: `meeting.transcribed`, `meeting.summarized`, `meeting.bot_joined`,
  individually selectable.
- Payload: JSON `{ event, timestamp, meeting_id, client_reference_id? }` —
  identifiers only, so ingestion re-reads the meeting over GraphQL.
- Signature: `X-Hub-Signature: sha256=<hex HMAC-SHA256 of the raw body>`,
  timing-safe comparison recommended. Fireflies treats the secret as
  optional; the PRD makes it mandatory on Avalon's side.
- Delivery: 2xx required within 10 s; retry behavior is not documented —
  another reason polling stays authoritative.

The Super Admin tier additionally offers team-wide webhooks configured in
Developer settings.

## Hosted MCP server

Per <https://docs.fireflies.ai/getting-started/mcp-configuration> and
<https://docs.fireflies.ai/mcp-tools/overview>, and the announcement at
<https://fireflies.ai/blog/fireflies-mcp-server/>:

- Remote server at `https://api.fireflies.ai/mcp`, HTTP transport, supporting
  **OAuth against the Fireflies account** (the PRD's personal flow) or a
  Bearer API key.
- **Build precondition, unverified:** the docs say "OAuth" but do not
  establish that the server publishes `/.well-known/oauth-protected-resource`
  metadata or accepts dynamic client registration, both of which
  `createHostedMcpPassthrough`'s `oauth` block requires. Verify before the
  personal scope is built; if Fireflies requires a pre-registered client, the
  flow instead needs per-region `FIREFLIES_OAUTH_CLIENT_ID/SECRET` Worker
  secrets, per-region redirect URIs, and a conditional registry entry.
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

Granola is the structural template: two scopes on one adapter
(`packages/connectors/src/granola.ts`), workspace admin API key via
`POST /connections/granola/workspace`, personal hosted MCP OAuth via
`createHostedMcpPassthrough`, signed webhooks, digestibility split between
generated and operational note events, and the
`0048_granola_connector.sql` migration shape. See
[`connectors.md`](../../connectors.md) and
[`hosted-mcp-connectors.md`](../../hosted-mcp-connectors.md).
