# Fathom notetaker connection

> Created 2026-08-14.
>
> A workspace connects [Fathom](https://fathom.ai) — the AI meeting notetaker —
> as a connector, at personal or workspace scope, so meetings Fathom recorded
> become readable agent context, watchable resources, and routed activities.
> Companions: [`design.md`](design.md) (tool catalog, wire shapes, webhook
> verification, migration sketch) and [`research.md`](research.md) (Fathom API
> facts and provenance). Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [`../../connectors.md`](../../connectors.md) and
> [`../../hosted-mcp-connectors.md`](../../hosted-mcp-connectors.md).

## Summary

Avalon gains a Fathom connector following the shape Granola established: a
member connects their own Fathom account through Fathom's hosted MCP server
(`https://api.fathom.ai/mcp`) and the agent reads their meetings, transcripts,
summaries, and action items through dynamically discovered tools; an admin
connects Fathom for the whole workspace by entering a Fathom API key, which
gives the agent a reviewed static catalog of read tools over the meetings that
key can see. On either scope, Avalon registers a webhook endpoint with Fathom
at connect time, so a finished meeting arrives as a signed activity minutes
after it ends — triggering automations, enriching watched resources, or
surfacing as an in-stream routing suggestion, exactly as Granola's
`note.generated` does today.

For a team that runs its calls through Fathom rather than Granola, the effect
is that meeting content stops being something a participant pastes into a work
stream and becomes something the work stream already has.

## Motivation

Avalon already treats a third-party notetaker as first-class context: the
Granola connector feeds meeting notes into resources, work-opportunity
enrichment, and activity routing, and that path is one of the most direct ways
external reality reaches a work stream. But that path exists only for Granola.
A team whose notetaker is Fathom — a widely deployed alternative with a public
API on every plan — gets none of it: the agent cannot answer "what did we agree
on yesterday's call", automations cannot fire when a meeting ends, and the
transcript enters Avalon only when someone copies it in by hand.

This PRD was requested directly (see [`research.md`](research.md) for the
request's provenance, including a naming ambiguity worth confirming). The cost
of leaving it alone scales with every workspace whose meetings live in Fathom:
each one experiences Avalon's meeting intelligence as missing rather than
present, while the connector machinery that would serve them — hosted-MCP
passthrough, API-key workspace connections, Standard-Webhooks ingestion — is
already built and proven on Granola. Fathom's provider surface matches that
machinery unusually closely (the same webhook signature scheme, the same
personal-MCP-plus-API-key split), so the marginal cost of the connector is low
relative to what it unlocks.

## Goals

1. A member connects their personal Fathom account from workspace settings and
   the agent can read that member's meetings — summaries, transcripts, action
   items — through typed, capability-scoped tools.
2. A workspace admin connects Fathom at workspace scope with a Fathom API key,
   and the agent can read the meetings that key can see under a workspace
   capability, without any member connecting individually.
3. A meeting whose Fathom content becomes ready arrives in Avalon as a
   verified, deduplicated activity that can trigger automations, enrich a
   watched resource, or appear as an in-stream routing suggestion.
4. A Fathom meeting is a watchable resource that hydrates on demand with its
   summary, transcript, and attendees, and its attendees enrich
   `external_people` the way Granola's do.
5. The connection lifecycle — connect, test, reconnect, disable — behaves
   identically to existing connectors in the workspace settings Connections
   surface, including status reporting and audit events.

## Non-goals

1. **A Fireflies.ai connector.** Fireflies is a different notetaker with a
   different (GraphQL) API. The request that produced this PRD named both
   products; this PRD targets Fathom per its link and documentation reference
   (see [`research.md`](research.md)). Deferred — a Fireflies connector would
   be its own PRD against its own API.
2. **Writes to Fathom.** No creating or editing highlights, action items,
   meeting types, or team settings. The connector manages only its own webhook
   endpoint. Fathom's external API is read-oriented and Avalon's need is
   context, not control. Rejected for this scope; nothing here precludes a
   later write-capable PRD.
3. **Recording media download or storage.** Fathom's download endpoints
   (request-a-download, download-status) are out of scope: video/audio storage
   carries cost and residency weight that text does not, and no current surface
   plays media. Deferred until a surface needs it.
4. **Merging Fathom content into first-party meeting notes.** Fathom meetings
   do not enter the `notes` / `note_transcript_segments` tables or the meeting
   notes screen; they remain connector resources, as Granola notes do. The
   first-party recorder and third-party notetakers stay separate systems.
   Rejected — collapsing them would blur ownership and editability semantics.
5. **A polling fallback for missed webhooks.** Ingestion is webhook-driven
   plus on-demand reads; no `connector-poll` stream ships in this scope.
   Deferred until there is evidence of missed deliveries (Fathom's retry
   policy is undocumented; see Open questions).
6. **CRM-match ingestion.** Fathom can attach CRM matches to meetings; Avalon
   ignores those fields initially. Deferred — Avalon has no CRM object model
   for them to land in.

## Product behavior

All surfaces below are the existing ones; Fathom adds entries, not screens.

**Catalog.** The Connections section of workspace settings shows a Fathom card
alongside Granola, Slack, Notion, Linear, GitHub, Google, and X, with both
`You` and `Workspace` connect actions, matching the catalog card model in
`workspace-settings.tsx`. The Connections nav entry's search terms gain
`fathom` and `meetings`.

**Personal connect.** A member clicks the personal connect action; Avalon
begins the hosted-MCP authorization (`POST /connections/fathom/start`), the
browser opens Fathom's authorization prompts, and the callback returns through
the desktop handoff. While the attempt is pending the card shows the in-flight
state; on success it shows a healthy personal connection attributed to the
member; on denial or failure the attempt records `denied`/`failed` and the
card returns to its connectable state with the error surfaced.

**Workspace connect.** An admin clicks the workspace connect action and gets a
modal — the Granola workspace modal pattern — that explains where to generate
a Fathom API key (Fathom → Settings → API Access), validates the key's shape
client-side before enabling the button, and submits to
`POST /connections/fathom/workspace`. On success the card shows one healthy
workspace connection; a second attempt while one is active is refused with a
conflict. During connect, Avalon creates the webhook endpoint on Fathom first
and only then stores the encrypted credentials; if the row cannot be written,
the remote endpoint is deleted and the original error is reported.

**Connected states.** A connection is `healthy`, `needs_reconnect` (credential
rejected — reconnect action shown), `error`, or `disabled`. The test action
runs the adapter health check without writing; a degraded-but-usable
connection reports its warning rather than failing. Disabling stops tool
access and webhook admission immediately; deliveries to a disabled
connection's ingress are rejected.

**Agent use.** With a personal connection, the Fathom plugin is available to
the agent as a deferred plugin: the model loads it on demand, tools are
discovered live from Fathom's MCP server, and they appear on the next turn.
With a workspace connection, the static read tools are available under the
workspace capability. In both cases the user sees ordinary tool activity in
the transcript; there is no separate Fathom surface.

**Activities.** When Fathom finishes processing a meeting, it delivers a
signed `New meeting content ready` webhook to the connection's ingress route.
Avalon verifies it, re-fetches the meeting from the REST API, and admits one
activity of type `meeting.content_ready`. Per the product contract, it either
triggers deterministic automation work, enriches an explicitly watched Fathom
meeting resource, or appears as an in-stream routing suggestion; there is no
global feed. A replayed delivery is acknowledged as a duplicate and admits
nothing. If the connection is offline from Fathom's point of view (Avalon
unreachable), no catch-up sweep runs in this scope — see non-goal 5.

**Empty/loading/error.** The catalog card with no connection shows the connect
actions (empty). Hydrating a Fathom meeting resource shows the standard
resource loading state; a hydration failure surfaces the standard resource
error with retry. A revoked key flips the connection to `needs_reconnect`
rather than surfacing per-tool errors indefinitely.

## Impact on the product contract

None — this refines behavior within the existing contract. Fathom activities
follow the connected-activities clause exactly (trigger automation, enrich a
watched resource, or route in-stream; no global feed), tools are typed and
authorized, and the connector adds a provider path of a kind the brief already
names (signed-webhook ingestion, scoped connector authorization). No clause of
[the implementation brief](../2026-08-05_avalon-implementation-brief/prd.md)
moves.

## Decision log

None yet.

## Key design decisions

1. **Mirror Granola's dual-shape adapter: personal = hosted MCP, workspace =
   admin API key + static REST.** Fathom ships an official MCP server and
   per-user API keys, the same split Granola has. Personal connections use
   `createHostedMcpPassthrough` against `https://api.fathom.ai/mcp` (dynamic
   tool discovery, frozen grants, deferred plugin); workspace connections use
   a reviewed static catalog over `https://api.fathom.ai/external/v1`.
   *Rejected:* personal OAuth-REST with static tools (Fathom's OAuth exists —
   authorization-code + refresh, single `public_api` scope — but the MCP path
   matches the Granola/Notion/Slack personal precedent and inherits its
   authorization and tool-governance machinery); personal API-key entry
   (pastes a per-user secret through the UI when an authorization flow
   exists).
2. **Webhook payloads are change signals only.** The webhook endpoint is
   registered without transcript/summary/action-item inclusion; on delivery,
   Avalon verifies the signature and then re-fetches the meeting via REST
   before admitting the activity. This is the Granola invariant: content
   enters through the authenticated read path, payloads stay small against
   `PROVIDER_WEBHOOK_MAX_BYTES`, and a forged-content class of problem never
   arises. *Rejected:* trusting embedded content from the payload — larger
   payloads, and admission would depend on delivery-time options rather than
   on one read path.
3. **A workspace connection is an admin's key acting for the workspace, and
   says so.** Fathom has no org-level keys; a key sees the meetings its owner
   recorded, meetings shared with them or their team, and — for admins —
   calls shared across the teams they oversee. Private calls stay host-only.
   The workspace modal and the connector docs state this bound plainly.
   *Rejected:* presenting the workspace connection as organization-complete —
   it is not, and pretending otherwise misleads automations built on it.
4. **The webhook endpoint is created on Fathom at connect time and deleted on
   revoke, create-first with compensation.** Matches `createGranolaWorkspace`:
   create the remote endpoint, encrypt `{apiKey|tokens, webhookEndpointId,
   webhookSigningSecret}` into the credential envelope, insert the connection
   row and audit event in one batch, and on failure delete the remote
   endpoint while keeping the original error authoritative.
5. **One digestible activity type.** Fathom's external webhook surface has one
   event — meeting content ready — normalized as `meeting.content_ready`,
   digestible ("the meeting happened"). The digestibility manifest and
   [`../../connector-digestibility.md`](../../connector-digestibility.md) gain
   exactly that row; the doc test enforces the pairing.

## Data model

Sketch level; the migration and [`../../data-model.md`](../../data-model.md)
are authoritative when the build lands.

- `connector_connections.connector_type` gains `'fathom'`. SQLite cannot alter
  a `CHECK`, so this is a full rebuild of `connector_connections` *and*
  `connector_oauth_attempts` (its `provider` check), mirroring migration
  `0048_granola_connector.sql` including child-table preservation.
- Two partial unique indexes, the Granola pair verbatim with `'fathom'`: at
  most one active workspace connection per workspace, and one active personal
  connection per (workspace, user).
- Credential envelope (AES-GCM, key-versioned, connection-ID AAD): personal
  connections store the MCP token set the passthrough maintains; workspace
  connections store `{apiKey, webhookEndpointId, webhookSigningSecret}`.
- New resource type `fathom_meeting`, keyed by Fathom's recording identifier;
  hydration reads the meeting with transcript included and walks recorder,
  attendees, and calendar invitees into `external_people`
  (roles `owner`/`attendee`/`invitee`/`organizer`, existing caps), alongside a
  `fathomHydratedPeople` next to `granolaHydratedPeople` in
  `work-opportunity-service.ts`, whose hydration allowlist gains `"fathom"`.
- No backfill; existing rows are untouched by the rebuild beyond the copy.

## Regional impact

Fathom is a single-region US SaaS; nothing about this connector moves data
across Avalon's Global/EU boundary beyond the established connector pattern.
The ingress route (`POST /ingest/fathom/:id`) is served in the workspace's
region — the connection ID in the path pins the destination the same way
Granola's does — raw webhook bodies land in the workspace region's R2 under
`${region}/${workspaceId}/activities/`, and meeting content fetched on demand
comes to rest in workspace-region storage only. The webhook URL registered
with Fathom is therefore region-specific at creation time. Read
[`../../regionalization.md`](../../regionalization.md) before building the
ingress route.

## Security and trust model

- **Webhook verification.** Fathom uses the Standard Webhooks scheme —
  `webhook-id` / `webhook-timestamp` / `webhook-signature` headers,
  HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with the `whsec_`-prefixed
  secret — identical to Granola's. Verification runs over the exact raw bytes
  before any UTF-8 decode or JSON parse, enforces the replay window, compares
  in constant time, and cross-checks the payload's event identifier against
  `webhook-id`. Details in [`design.md`](design.md).
- **Credentials.** API keys, signing secrets, and MCP tokens live only in the
  versioned AES-GCM envelope (`CONNECTOR_CREDENTIALS_KEY*`); nothing
  Fathom-related is a Worker variable beyond optional app credentials named in
  Provider configuration. Refresh is serialized under the existing D1 lease;
  mid-call recovery goes through `withProviderReauthorization` with a
  Fathom-specific rejection predicate (HTTP 401 marks the credential rejected;
  403 is an authorization outcome, not a dead credential).
- **Untrusted provider content.** Transcripts, summaries, action items,
  attendee names, and every MCP response are attacker-influenced text. The
  plugin's system message marks them as data, never instructions, matching
  Granola's wording; bounded-output rules cap what a tool can return.
- **MCP tool governance.** Personal tools are discovered live, validated
  against the frozen grant, and every hosted-MCP tool executes as a confirmed
  write regardless of `readOnlyHint`, per
  [`../../hosted-mcp-connectors.md`](../../hosted-mcp-connectors.md).
- **Blast radius.** A workspace connection exposes exactly what its admin's
  key can see (decision 3); disabling the connection stops tool access and
  webhook admission in the same request. Private Fathom calls are never
  reachable through any Avalon path because Fathom itself withholds them.

## Agent behavior

Concise contract here; the complete tool catalog, wire shapes, discovery
sequences, and failure contract required by
[`../../prds.md`](../../prds.md#required-documentation-for-agent-tools-and-plugins)
are in [`design.md`](design.md).

- **Plugin contract.** One connector plugin defined via
  `defineConnectorAgentPlugin`: `providerType: "fathom"`, wire prefix
  `fathom`, search aliases covering meetings/calls/transcripts/recaps. It is
  available when the workspace holds an authorized Fathom connection whose
  grant covers the requesting principal, and it is a deferred plugin for
  personal connections: loading it triggers reauthorization and live MCP
  `tools/list` discovery, persists the activation, and exposes tools on the
  next turn. Loading authorizes nothing new and starts nothing persistent.
- **Capabilities.** `fathom.personal.read` (personal connections, dynamic MCP
  tools) and `fathom.workspace.read` (workspace connections, static tools),
  with capability→connection-scope mapping exactly as Granola's.
- **Static workspace tools** (all `read`, idempotency `safe`, serial not
  required): `list_meetings`, `get_meeting_summary`, `get_meeting_transcript`,
  `list_teams`, `list_team_members`. Cursor pagination is surfaced to the
  model; the system message forbids claiming complete coverage while a cursor
  remains. Results are bounded before return (size, array length, and depth
  caps mirroring `boundGranolaValue`).
- **Forbidden.** No write reaches Fathom through any tool in this scope; a
  call outside the connection's granted capability is refused with
  `connectorCapabilityRefused`, naming the grant.
- **Failure contract.** Stable codes with model-visible sentences that contain
  the next action — e.g. rate limiting returns "Fathom rate-limited this call.
  Retry once after the indicated delay." with `retryAfterMs` in the forwarded
  details; a rejected credential returns "This Fathom connection needs to be
  reconnected. Stop using Fathom tools and tell the user." Full table in
  [`design.md`](design.md).
- **Model-usability acceptance.** Schema snapshot and contract tests for every
  static tool's required/optional/forbidden/success/failure shapes, plus
  prompt evaluations on the configured medium fallback model covering
  discovery, a list→transcript sequence, a wrong-first-call recovery, and the
  rate-limit stop condition.

## Provider configuration

Settings that live outside this repository, and what breaks without them:

1. **Fathom MCP authorization (personal).** The hosted-MCP passthrough
   assumes OAuth protected-resource discovery and dynamic client registration
   at `https://api.fathom.ai/mcp`. Whether Fathom's authorization server
   supports DCR is unconfirmed (Open question 2). If it does — as with
   Granola — no external registration and no new secrets are needed. If it
   does not, an application is registered at
   `fathom.video/marketplace_applications/new` with Avalon's region-specific
   redirect URIs, and its client credentials become Worker secrets
   (`FATHOM_CLIENT_ID` / `FATHOM_CLIENT_SECRET`, both regions). Without
   whichever of these applies, personal connect fails at `start`; workspace
   connect is unaffected.
2. **Fathom API key (workspace).** Generated by the connecting admin in
   Fathom → Settings → API Access; entered in the workspace connect modal,
   never configured server-side. Available on all Fathom plans.
3. **Webhook reachability.** Fathom must be able to reach the regional ingress
   URL Avalon registers. No Fathom-side manual webhook configuration is
   required — Avalon creates and deletes the endpoint via the API.

## Rollout

- **Flag.** Catalog visibility is gated by a client feature flag
  `fathom-connector` in `client-feature-flags.ts` — closed to off, per
  [`../../feature-flags.md`](../../feature-flags.md). With the flag off the
  card does not render; existing connections (from staff testing) keep
  working, which is the desired trap-door for a staged rollout.
- **Order.** The migration (table rebuilds plus indexes) ships first and is
  flag-independent; registry wiring, routes, and ingress land behind the
  flag; the flag opens last.
- **Off switch.** Turning the flag off hides the catalog card; disabling a
  connection (or deleting the Fathom-side endpoint on revoke) stops
  ingestion. No data cleanup is required to roll back — admitted activities
  and resources are inert without the connector.

## Acceptance

1. Personal connect end-to-end: start → Fathom authorization → callback →
   desktop handoff → healthy personal connection; the agent loads the Fathom
   plugin and reads a real meeting summary.
2. Workspace connect: valid key succeeds and creates a Fathom webhook
   endpoint; malformed key is refused client-side; valid-shape-but-revoked
   key fails with the provider error; a second workspace connect returns the
   conflict; a failed row insert deletes the remote endpoint.
3. Webhook delivery: a signed delivery admits exactly one
   `meeting.content_ready` activity with content fetched via REST; a replay
   of the same delivery is acknowledged as a duplicate and admits nothing; a
   bad signature, stale timestamp, or oversized body is rejected; a delivery
   to a disabled connection is rejected.
4. Lifecycle: test reports health without writing; a 401 from Fathom flips
   the connection to `needs_reconnect`; reconnect restores it; disable stops
   tools and ingestion immediately.
5. Enrichment: hydrating a `fathom_meeting` resource populates
   `external_people` with recorder, attendees, and invitees under the
   existing caps.
6. Conformance: the new adapter passes the registry-enumerated credential
   freshness suite and the digestibility doc test without exemptions.

## Open questions

1. **Was Fathom the intended product?** The request that produced this PRD
   wrote "fireflies.ai" but linked fathom.ai and asked for Fathom's technical
   documentation; this PRD follows the link. If Fireflies was intended, this
   PRD is abandoned per [`../../prds.md`](../../prds.md) and a new one is
   written against Fireflies' GraphQL API. Blocks approval, not drafting.
2. **Does Fathom's MCP authorization server support dynamic client
   registration?** Determines whether personal connect needs a registered
   marketplace application and Worker secrets (Provider configuration 1).
   Blocks the personal build; the workspace build proceeds either way.
3. **What are Fathom's webhook retry semantics?** Undocumented. If deliveries
   are not retried on failure, non-goal 5 (no polling fallback) may need
   revisiting; the dedupe key makes any answer safe, but coverage depends on
   it.
4. **Does a workspace admin key's webhook fire for meetings across the teams
   the admin oversees, or only for the admin's own and directly shared
   meetings?** Fathom's `triggered_for` options name "your own" and "shared
   with you". The answer sets how complete workspace-scope ingestion is and
   what the workspace modal's bound-of-access wording promises.
5. **What does Fathom's MCP tool catalog contain, and how stable is it?**
   Affects grant-validation UX for personal connections (a tool that vanishes
   from the catalog invalidates part of a frozen grant). Not blocking — the
   passthrough already handles catalog drift — but worth knowing before the
   flag opens.
