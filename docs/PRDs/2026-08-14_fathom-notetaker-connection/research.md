# Fathom connection — research

> Created 2026-08-14.
>
> Provider facts behind [`prd.md`](prd.md) and [`design.md`](design.md), with
> sources, plus the provenance of the request. Investigation, not proposal.

## Provenance: Fathom, not Fireflies

The request that produced this PRD asked for "a connection in avalon to
fireflies.ai notetaker" — but the text linked `https://www.fathom.ai` and
asked that *Fathom's* technical documentation be referenced. Fireflies.ai and
Fathom are different products: Fireflies exposes a GraphQL API
(`api.fireflies.ai/graphql`, per-user API keys), while Fathom exposes the
REST/MCP surface documented below. This PRD follows the link and the
documentation instruction and targets **Fathom**. The ambiguity resolved to
*both*: the requester renamed this working branch to `fathom-connection-prd`,
and a parallel Fireflies PRD was written
([#167](https://github.com/juno-ai-labs/avalon/pull/167), since withdrawn in
[#178](https://github.com/juno-ai-labs/avalon/pull/178)).
The resolution is recorded as [`prd.md`](prd.md) Key design decision 1.

## Fathom's developer surface

Primary source: the [Fathom developer hub](https://developers.fathom.ai),
which publishes an `llms.txt` index, Markdown mirrors of every page, and an
OpenAPI spec (`/api-reference/openapi.yaml`). Facts below were read from
those pages on 2026-08-14.

### REST API

- Base URL `https://api.fathom.ai/external/v1`, authenticated with an API key
  in `X-Api-Key` or an OAuth bearer token.
  ([API overview](https://developers.fathom.ai/api-overview.md))
- **API keys are per user — "not per org, and there are no org-level keys"** —
  generated in Fathom's settings, and **included on all plans**. A key sees
  meetings its owner recorded, meetings shared with the owner or their team,
  and, for admins, calls shared across teams they oversee. Private calls stay
  host-only, even from admins.
  ([FAQ](https://developers.fathom.ai/faq.md))
- Recording identifiers are **integers** (OpenAPI `type: integer`).
  `GET /recordings/{id}/summary` returns only the summary
  (`template_name`, `markdown_formatted`) — no title, no action items;
  action items ride `GET /meetings` behind `include_action_items`, and
  `/meetings` has no recording-ID filter.
  `GET /recordings/{id}/transcript` has **no range or pagination
  parameter**; entries are
  `{ speaker: { display_name, matched_calendar_invitee_email? }, text, timestamp ("HH:MM:SS") }`.
  Both endpoints also offer an async `destination_url` mode, unused here.
- Endpoints: list meetings, list meeting types, get recording summary, get
  recording transcript, request/poll a recording download, list teams, list
  team members, list users and permissions, create/delete webhook.
  ([index](https://developers.fathom.ai/llms.txt))
- `GET /meetings` filters: `created_after`/`created_before` (ISO 8601),
  `calendar_invitees_domains_type` (`all` / `only_internal` /
  `one_or_more_external`), `meeting_type`, `recorded_by[]` (emails),
  `teams[]`; content toggles `include_summary`, `include_transcript`,
  `include_action_items`, `include_highlights`, `include_crm_matches`.
  Cursor pagination: request `cursor`, response `next_cursor` (null at end),
  `items`, `limit`.
  ([List meetings](https://developers.fathom.ai/api-reference/meetings/list-meetings.md))
- Rate limits: 60 calls / 60 s standard; 30 / 60 s for heavy requests
  (summaries, transcripts — may drop to 5 during peak) and for downloads;
  429 with `Retry-After` when exceeded. Official TypeScript and Python SDKs
  retry rate limits automatically (Avalon does not use them; the Worker
  calls the REST surface directly, as with every other connector).
  ([API overview](https://developers.fathom.ai/api-overview.md))
- Meetings process asynchronously — transcripts are not available the
  instant a meeting ends; webhooks signal when content is ready.

### OAuth

- OAuth 2.0 authorization-code + refresh-token grants; token endpoint
  `https://api.fathom.ai/external/v1/oauth2/token`; single scope
  `public_api`; access tokens short-lived, refresh tokens single-use;
  token endpoint rate-limited at 60 req / 60 s per app.
  ([SDK OAuth](https://developers.fathom.ai/sdks/oauth.md))
- App registration: `https://fathom.video/marketplace_applications/new`,
  with registered redirect URIs.
  ([Building with OAuth](https://developers.fathom.ai/oauth.md))
- The docs do not state whether an OAuth token's visibility differs from the
  authorizing user's API-key visibility; assume user-equivalent until the
  OpenAPI spec or support says otherwise.

### MCP

- Official MCP server at `https://api.fathom.ai/mcp`, marketed for Claude,
  ChatGPT, and "any MCP-compatible tool"; Claude Code connects via
  `mcp-remote`, which implies the standard remote-MCP OAuth handshake.
  Whether the authorization server supports dynamic client registration is
  not documented — [`prd.md`](prd.md) Open question 1.
  ([MCP overview](https://developers.fathom.ai/mcp-docs/index.md),
  [Claude setup](https://developers.fathom.ai/mcp-docs/claude.md))
- The MCP can only reach meetings the authorizing user can already see in
  Fathom. ([Fathom help](https://help.fathom.video/en/articles/11497793))
- The tool catalog is not publicly enumerated — discovered at connect time,
  which is exactly what the hosted-MCP passthrough assumes.

### Webhooks

- Created in Fathom's settings UI or via `POST /webhooks`; deleted via API.
  One event: **new meeting content ready**. `triggered_for` is an array over
  `my_recordings`, `shared_external_recordings`,
  `my_shared_with_team_recordings`, and `shared_team_recordings` (the last
  two Team Plan only). **At least one of** `include_transcript`,
  `include_summary`, `include_action_items`, `include_crm_matches` **must be
  true** — a fully content-free endpoint is not accepted, so Avalon
  registers `include_summary` only and treats the delivery as a change
  signal regardless ([`design.md`](design.md)).
  ([Webhooks](https://developers.fathom.ai/webhooks.md),
  [Create a webhook](https://developers.fathom.ai/api-reference/webhooks/create-a-webhook.md))
- Signature scheme is Standard Webhooks: `webhook-id`,
  `webhook-timestamp`, `webhook-signature` headers; HMAC-SHA256 over
  `${id}.${timestamp}.${rawBody}`; base64 secret prefixed `whsec_`;
  space-delimited version-prefixed signatures; constant-time comparison.
  **Identical to Granola's scheme.** Fathom is therefore the second consumer
  of that verification procedure, which is the repository's stated trigger
  for extracting a shared helper rather than copying it —
  [`design.md`](design.md) specifies the shared `verifyStandardWebhook`.
- Retry behavior on failed delivery is not documented —
  [`prd.md`](prd.md) Open question 2.

### What the public docs did not record

Named here so nobody mistakes the design's placeholders for verified facts;
each is carried in [`prd.md`](prd.md)'s Open questions and resolved against
the OpenAPI spec (or a live call) before the implementing schemas freeze:

- The **API key format** — no prefix or length is documented (Open
  question 6).
- The **result ordering** of `GET /meetings` — the docs do not state
  newest-first (Open question 8).
- Whether the **webhook payload carries an event identifier** — the payload
  reference does not enumerate the body's fields, so the design treats the
  authenticated `webhook-id` header as the delivery identity either way
  (Open question 7).
- Whether **webhook endpoints can be created under an OAuth token** or only
  under an API key (Open question 5).

(Resolved during review, now recorded above: recording IDs are integers, the
transcript endpoint has no range parameter, the summary endpoint returns
only the summary, and a webhook endpoint requires at least one content
include.)

## Pattern fit against Avalon's existing connectors

| Dimension | Fathom | Closest precedent |
| --- | --- | --- |
| Personal connection | Official hosted MCP, OAuth | Granola personal (also Notion, Slack personal) |
| Workspace connection | Per-user API key held by an admin; no org keys | Granola workspace (admin API key) |
| Ingestion | One signed webhook event, Standard Webhooks scheme | Granola (same scheme, same "change signal" role) |
| Content model | Meetings with summaries/transcripts/action items, async processing | Granola notes with transcripts |
| People enrichment | Recorder, attendees, calendar invitees/organizer on each meeting | `granolaHydratedPeople` |
| Writes | None needed (webhook endpoint management only) | Granola (read-only + own endpoint) |

The fit with Granola is close enough that the Granola adapter is the
template for essentially every piece: the dual-scope adapter branch, the
workspace-connect compensation flow, webhook verification, digestibility (one
digestible event), and hydration-driven people enrichment. The differences
that matter:

1. **Fathom's workspace key is explicitly per-user.** Granola's workspace key
   is an admin/workspace API key; Fathom's is an individual admin's key with
   team-shared visibility. The bound-of-access wording in the UI has to be
   honest about this ([`prd.md`](prd.md) Key design decision 3).
2. **Fathom content is meeting-shaped, not note-shaped.** The resource type
   is `fathom_meeting` keyed by recording ID, and "content ready" — not
   "note generated" — is the digestible moment.
3. **Fathom documents its rate limits precisely**, including the peak-time
   tightening on transcript/summary endpoints, which the failure contract
   surfaces to the model rather than hiding behind blind retries.

## Fireflies.ai, for the record

Fireflies was proposed in its own PRD
([#167](https://github.com/juno-ai-labs/avalon/pull/167), withdrawn in
[#178](https://github.com/juno-ai-labs/avalon/pull/178)), whose `research.md`
is the authority on that provider. In brief, and
corrected against it (an earlier revision of this section wrongly said
Fireflies had no official MCP): Fireflies exposes a GraphQL API at
`https://api.fireflies.ai/graphql` with per-user API keys
(Business/Enterprise tiers for some capabilities), webhooks for
transcription-complete events, **and** a remote MCP server at
`https://api.fireflies.ai/mcp` with OAuth and a read-tool surface. The two
connectors are designed independently; the one obligation between them is
the migration coordination named in [`design.md`](design.md).
