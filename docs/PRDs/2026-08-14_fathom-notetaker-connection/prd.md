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
key can see. On the workspace scope, Avalon registers a webhook endpoint with
Fathom at connect time, so a finished meeting arrives as a signed change-signal
activity minutes after it ends — triggering automations, enriching watched
resources, or surfacing as an in-stream routing suggestion, exactly as
Granola's `note.generated` does today. (Personal-scope ingestion is
conditional on a provider capability — Open question 5 — and does not gate
this scope.)

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
request's provenance). The cost of leaving it alone scales with every
workspace whose meetings live in Fathom: each one experiences Avalon's meeting
intelligence as missing rather than present, while the connector machinery
that would serve them — hosted-MCP passthrough, API-key workspace connections,
Standard-Webhooks ingestion — is already built and proven on Granola. Fathom's
provider surface matches that machinery unusually closely (the same webhook
signature scheme, the same personal-MCP-plus-API-key split), so the marginal
cost of the connector is low relative to what it unlocks.

## Goals

1. A member connects their personal Fathom account from workspace settings and
   the agent can read that member's meetings — summaries, transcripts, action
   items — through typed, capability-scoped tools.
2. A workspace admin connects Fathom at workspace scope with a Fathom API key,
   and the agent can read the meetings that key can see under a workspace
   capability, without any member connecting individually.
3. A meeting whose Fathom content becomes ready on a **workspace** connection
   arrives in Avalon as a verified, deduplicated change-signal activity that
   can trigger automations, enrich a watched resource, or appear as an
   in-stream routing suggestion. (Personal-scope ingestion is out of this
   goal; see Key design decision 6 and Open question 5.)
4. A Fathom meeting is a watchable resource that hydrates on demand with its
   summary, transcript, and attendees, and its attendees enrich
   `external_people` the way Granola's do.
5. The connection lifecycle — connect, test, replace or reconnect, disable —
   behaves consistently with existing connectors in the workspace settings
   Connections surface, including status reporting and audit events.

## Non-goals

1. **A Fireflies.ai connector.** Fireflies is a different notetaker with a
   different (GraphQL) API, and it has its own PRD, written in parallel:
   [`../2026-08-14_fireflies-connector/prd.md`](../2026-08-14_fireflies-connector/prd.md)
   (Key design decision 1). Out of scope here by definition, not deferred —
   the two connectors ship independently, with one migration-coordination
   obligation between them ([`design.md`](design.md) §Migration sketch).
2. **Writes to Fathom through Avalon-authored tools.** The static catalog
   creates or edits nothing — no highlights, action items, meeting types, or
   team settings; the connector manages only its own webhook endpoint. (The
   personal scope forwards whatever Fathom's MCP exposes; any provider-authored
   mutation there executes as a confirmed write requiring participant
   confirmation, per the hosted-MCP rules.) Rejected for this scope; nothing
   here precludes a later write-capable PRD.
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
   policy is undocumented; see Open questions). This non-goal is safe only
   because ingestion admits the change signal without any provider call — see
   Key design decision 2.
6. **Personal-scope webhook ingestion.** Webhook endpoints are registered for
   workspace connections only, matching the Granola precedent exactly
   (`normalize` refuses a non-workspace connection; the ingest query filters
   `scope = 'workspace'`). Personal connections read on demand. Deferred —
   promoting personal ingestion is its own decision with its own visibility
   rules (Key design decision 6, Open question 5).
7. **CRM-match ingestion.** Fathom can attach CRM matches to meetings; Avalon
   ignores those fields initially. Deferred — Avalon has no CRM object model
   for them to land in.

## Product behavior

All surfaces below are the existing ones; Fathom adds entries, not screens.

**Catalog.** The Connections section of workspace settings shows a Fathom card
alongside Granola, Slack, Notion, Linear, GitHub, Google, and X, with the
existing **Connect for me** and **Connect workspace** actions (the workspace
action renders for admins only), matching the catalog card model in
`workspace-settings.tsx`. The card's one-line description names the product —
"Read meetings recorded by Fathom" — so an admin choosing between two
notetaker cards is choosing between named products, not paraphrases of each
other. The Connections nav entry's search terms gain `fathom` (`meetings` is
already present).

**Personal connect.** A member clicks **Connect for me**; Avalon begins the
hosted-MCP authorization (`POST /connections/fathom/start`), the browser opens
Fathom's authorization prompts, and the callback returns through the desktop
handoff. While the attempt is pending the card shows the in-flight state and
connect actions across the catalog are disabled, as with every connector; on
success it shows a healthy personal connection attributed to the member; on
denial, failure, or authorization expiry the attempt records its outcome and
the card returns to its connectable state with the error surfaced in the
pane's inline error area.

**Workspace connect.** An admin clicks **Connect workspace** and gets a
modal — the Granola workspace modal pattern — whose body copy states the bound
of access before the input: *"This key reads the meetings you recorded and
meetings shared with you or your teams. Private Fathom calls are never
readable, and meetings outside your visibility are not included — the
workspace sees what you can see."* The modal links Fathom's API-key guide,
explains where to generate the key (Fathom's settings, API Access), and gates
the submit button on a non-empty key of plausible shape, with a visible
validation line rather than a silently disabled button; the authoritative
shape check is the route's `zValidator` schema (Fathom's key format is Open
question 6 — until it is recorded, the client checks only non-empty plus a
length bound). The key field is a password input, submitted once in the POST
body and never returned. On success the card shows one healthy workspace
connection; while one is active the workspace action is disabled with a title
pointing at the installed connection (the partial unique index's 409 is the
server backstop a user normally never reaches). During connect, Avalon creates
the webhook endpoint on Fathom first and only then stores the encrypted
credentials; if the row cannot be written, the remote endpoint is deleted and
the original error is reported.

**Connected states.** The client renders three connection states: healthy,
reconnect-required (covering the server's `needs_reconnect` and `error`
statuses), and disabled. For a **personal** connection, reconnect-required
shows the Reconnect action, which re-runs the authorization. For a
**workspace** connection there is no OAuth flow to re-enter, so no Reconnect
action renders (the Granola workspace exclusion); the row's copy tells the
admin to disconnect and connect again with a fresh key, and the connect modal
serves as the replacement path. The test action runs the adapter health check
without writing; a degraded-but-usable connection reports its warning rather
than failing. Disabling stops tool access and webhook admission immediately;
deliveries to a disabled connection's ingress are rejected.

**Agent use.** With connections present, Fathom appears to the agent as one
plugin per connection. A workspace member who also holds a personal connection
therefore sees two Fathom plugins; their catalog presentation is
scope-conditioned (the Google precedent) so the descriptions read "meetings
visible to your personal Fathom account" versus "meetings visible to this
workspace's Fathom key". Personal tools are hosted-MCP tools and every call —
including reads — executes as a confirmed write requiring participant
confirmation, and is unavailable to read-only inline children; workspace tools
are static reads and run without confirmation. The user sees ordinary tool
activity in the transcript; there is no separate Fathom surface.

**Activities.** When Fathom finishes processing a meeting recorded under a
workspace connection, it delivers a signed `New meeting content ready` webhook
to the connection's ingress route. Avalon verifies it, admits one
`meeting.content_ready` change-signal activity (no provider call is made at
ingest time), and enqueues it; meeting content is hydrated through the
authenticated read path in the queue consumer, at opportunity admission, where
provider failures retry safely. Per the product contract, the activity either
triggers deterministic automation work, enriches an explicitly watched Fathom
meeting resource, or appears as an in-stream routing suggestion; there is no
global feed. A replayed delivery is acknowledged as a duplicate: it admits no
new activity or receipt row and re-enqueues the canonical activity, matching
the Granola semantics. A genuinely new content-ready event for the same
meeting (Fathom regenerating its output) admits a new activity.

**Empty, loading, error, and offline.** The catalog card with no connection
shows the connect actions (empty). Before the catalog query resolves the card
heading reads "Checking availability"; a region where Fathom is not available
shows "Unavailable" with both actions disabled. When the connections query
fails — including offline — both connect actions disable with an explanatory
title and the pane shows its inline error; installed connections render from
the last successful load. A hydration failure on a watched Fathom meeting
surfaces as the resource's watch status ("Needs attention") — there is no
retry affordance on that surface today, and this PRD does not add one. A
revoked key flips the connection to reconnect-required rather than surfacing
per-tool errors indefinitely.

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

1. **This PRD targets Fathom; Fireflies gets its own.** The originating
   request wrote "fireflies.ai" but linked fathom.ai and asked for Fathom's
   technical documentation. The answer to the ambiguity turned out to be
   *both*: the requester renamed this branch to `fathom-connection-prd` and a
   parallel Fireflies PRD exists at
   [`../2026-08-14_fireflies-connector/prd.md`](../2026-08-14_fireflies-connector/prd.md).
   [`research.md`](research.md) records the provenance. *Rejected:* folding
   both providers into one PRD — different APIs (REST/MCP vs GraphQL),
   different designs, one folder per PRD.
2. **Ingestion admits a change signal; content is hydrated later, in the
   queue consumer.** `ingestFathomWebhook` mirrors what `ingestGranolaWebhook`
   actually does: size check, verify, persist the raw body to R2, normalize a
   content-free activity from the verified envelope, insert with dedupe,
   enqueue — **no provider call in the ingress**. Meeting content enters
   through `hydrateConnectorActivitySource` at opportunity admission, where
   transient provider failures (408/429/5xx) are retried by the queue and
   `Retry-After` is honored. Fathom requires at least one content include on
   a webhook endpoint, so Avalon registers the smallest permitted payload —
   `include_summary` only, transcript/action-items/CRM excluded — and treats
   the delivery as a change signal regardless: embedded content is never
   admitted into activity fields, and payloads stay small against
   `PROVIDER_WEBHOOK_MAX_BYTES`. *Rejected:* fetching the meeting inside the
   webhook ACK — Fathom's summary/transcript endpoints are limited to 30
   requests/min (5 at peak), deliveries burst on the hour, and a 429 in the
   ingress would lose the delivery permanently given non-goal 5 and Fathom's
   undocumented retry policy; it would also double-fetch, since the consumer
   hydrates anyway.
3. **A workspace connection is one admin's personal visibility made
   workspace-readable, and the product says so at the moment of decision.**
   Fathom has no org-level keys; a key sees what its owner can see. Connecting
   it at workspace scope makes everything that admin can see — their 1:1s,
   calls shared with them, cross-team calls they oversee — readable by every
   work stream in the workspace, executing as the workspace principal. The
   modal copy in Product behavior states this bound. The connecting admin is
   recorded on the connection (`connectedByUserId` in `config_json`, not a
   secret) so the workspace knows whose visibility it is riding; when that
   member leaves the Avalon workspace or loses the admin role, the connection
   is surfaced in Settings for re-attestation, and disabling it is the
   default recommendation. *Rejected:* presenting the connection as
   organization-complete, and Granola's anonymous workspace shape — correct
   for Granola's genuine workspace key, wrong for a credential Fathom
   documents as one person's.
4. **The webhook endpoint is created on Fathom at connect time and deleted on
   revoke, create-first with compensation.** Matches `createGranolaWorkspace`:
   create the remote endpoint, encrypt `{apiKey, webhookEndpointId,
   webhookSigningSecret}` into the credential envelope, insert the connection
   row and audit event in one batch, and on failure delete the remote
   endpoint while keeping the original error authoritative. A swallowed
   compensation delete can orphan an endpoint on Fathom's side; the health
   check's endpoint-existence probe (reported as `{ ok: true, warning }`) is
   the detection, and the operator recovery path is Fathom's own settings —
   so Provider configuration promises "no manual Fathom-side webhook
   configuration" for the happy path only.
5. **One digestible activity type, deduplicated per delivery.** Fathom's
   external webhook surface has one event — meeting content ready —
   normalized as `meeting.content_ready`, digestible ("the meeting
   happened"). `dedupeKey` is Fathom's per-delivery event identifier, exactly
   as Granola's is, so the duplicate re-read keys on the same tuple as the
   unique index and a replay resolves to the canonical activity; replay
   protection is the `webhook_receipts` signature hash plus
   `provider_event_id`, never the dedupe key. *Rejected:* a recording-scoped
   dedupe key — it is not replay protection but a permanent lock that would
   suppress legitimate re-deliveries and 500-loop the duplicate re-read.
6. **Webhooks are workspace-scope only in this scope.** The Granola precedent
   is explicit: `normalize` throws for a non-workspace connection and the
   ingest query filters `scope = 'workspace'`. Personal-scope ingestion would
   be new work with its own visibility and authority rules (a member's
   private calls must not trigger workspace automations), and whether Fathom
   even supports per-user endpoint creation under OAuth is unconfirmed (Open
   question 5). Fathom mirrors the precedent; promoting personal ingestion is
   a later decision, not a build-time detail.

## Data model

Sketch level; the migration and [`../../data-model.md`](../../data-model.md)
are authoritative when the build lands.

- `connector_connections.connector_type` gains `'fathom'`. SQLite cannot alter
  a `CHECK`, so this is a full rebuild of `connector_connections` *and*
  `connector_oauth_attempts` (its `provider` check). **The rebuild's child
  set and column definitions are derived from the schema at head, not copied
  from `0048_granola_connector.sql`** — three children with foreign keys to
  `connector_connections` postdate 0048 (`slack_unfurled_links`,
  `digest_delivery_targets`, and `workstream_terminal_repositories`, the last
  with `ON DELETE RESTRICT`, which is not deferrable and must be staged
  explicitly or the rebuild aborts), and `connector_oauth_attempts` gained
  `telemetry_operation_id` and its index in 0074. The full derivation
  procedure and test obligations are in [`design.md`](design.md).
- Two partial unique indexes, the Granola pair verbatim with `'fathom'`: at
  most one active workspace connection per workspace, and one active personal
  connection per (workspace, user).
- Credential envelope (AES-GCM, key-versioned, connection-ID AAD): personal
  connections store the MCP token set the passthrough maintains; workspace
  connections store `{apiKey, webhookEndpointId, webhookSigningSecret}`. The
  connection's `provider_account_id` is a hash-derived identifier, never the
  key or an email; the connecting admin is recorded as `connectedByUserId` in
  `config_json` (decision 3).
- New resource type `fathom_meeting`, keyed by Fathom's recording identifier
  and declared in the manifest's `resourceTypes`; hydration reads the meeting
  with transcript included and walks recorder, attendees, and calendar
  invitees into `external_people` (roles `owner`/`attendee`/`invitee`/
  `organizer`, existing caps), via a `fathomHydratedPeople` next to
  `granolaHydratedPeople` in `work-opportunity-service.ts`, whose hydration
  allowlist gains `"fathom"`. Activities carry `actor: {}` — no identity
  resolution from provider-supplied emails (see Security and trust model).
- No backfill; existing rows are preserved through the rebuild.

## Regional impact

Fathom is a single-region US SaaS; nothing about this connector moves data
across Avalon's Global/EU boundary beyond the established connector pattern.
The ingress route (`POST /ingest/fathom/:id`) is served in the workspace's
region: the webhook URL registered with Fathom is built from the regional
`PUBLIC_API_BASE_URL` at creation time, so the host pins the region and the
connection ID selects the row within it — no shared Global ingress and no
Global↔EU bridge is involved. Raw webhook bodies land in the workspace
region's R2 under `${region}/${workspaceId}/activities/`, and meeting content
fetched on demand comes to rest in workspace-region storage only. Read
[`../../regionalization.md`](../../regionalization.md) before building the
ingress route.

## Security and trust model

- **Webhook verification.** Fathom uses the Standard Webhooks scheme —
  `webhook-id` / `webhook-timestamp` / `webhook-signature` headers,
  HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with the `whsec_`-prefixed
  secret — the same scheme Granola verifies, so the verifier is extracted and
  shared rather than copied (a second implementation of a signature check is
  where a dropped guard hides). Verification is computed over the exact
  received bytes — a fatal UTF-8 decode rejects non-UTF-8 bodies before
  verification, and nothing is parsed or persisted until the signature, size
  bound, and replay window pass. The per-delivery identity is the
  authenticated `webhook-id` header, never a payload field; a payload event
  identifier, if Fathom's payload carries one (Open question 7), is
  cross-checked against it as an extra guard, not relied on. The
  subscription handshake is classified per
  [`../../security.md`](../../security.md): the signing secret is returned by
  an authenticated `POST /webhooks` call, so no unsigned-handshake pattern
  applies.
- **Credentials.** API keys, signing secrets, and MCP tokens live only in the
  versioned AES-GCM envelope (`CONNECTOR_CREDENTIALS_KEY*`); plaintext keys
  and signing secrets are excluded from connection configuration, API
  responses, provider identifiers, audit metadata, and logs — the
  `provider_account_id` is a hash derivation, as Granola's is. Refresh is
  serialized under the existing D1 lease; mid-call recovery goes through
  `withProviderReauthorization` with a Fathom-specific rejection predicate
  (a 401 carrying provider response details marks the credential rejected;
  403 is an authorization outcome, not a dead credential; errors that never
  reached the provider never mark). On the OAuth token endpoint, failures are
  classified by the provider's error code, not HTTP status: a revoked grant
  (`invalid_grant` and kin, per `isRevokedGrantError`) states
  `reconnectRequired: true`; a 429 or malformed-request 400 does not mark the
  connection. This matters doubly for Fathom: refresh tokens are single-use,
  and the token endpoint has a **per-app** budget of 60 requests/min shared
  by every personal connection in a region.
- **Untrusted provider content.** Transcripts, summaries, action items,
  attendee data, links, and every MCP response are attacker-influenced text —
  an external attendee can *speak* a prompt injection and it arrives
  identically through the authenticated read path. The plugin's system message
  marks all of it as data, never instructions; bounded-output rules cap what a
  tool can return. No identity authority derives from provider content:
  activities carry `actor: {}`, and calendar-supplied emails never reach
  `resolveConnectorActorIdentity` — recorder, attendees, and invitees enter
  only as unverified `external_people` evidence with `providerUserId: null`,
  matching Granola.
- **MCP tool governance.** Personal tools are discovered live, validated
  against the frozen grant, and every hosted-MCP tool executes as a confirmed
  write regardless of `readOnlyHint`, per
  [`../../hosted-mcp-connectors.md`](../../hosted-mcp-connectors.md).
- **Resource visibility at hydration.** Hydration enters through
  `withAuthorizedConnection` on the owning connection: a `fathom_meeting`
  attached from a personal connection hydrates only for its owner principal,
  so joining a shared work stream never exposes another member's meetings —
  the execution-principal → connection-scope → capability → resource-visibility
  chain applies at execution, not only at admission.
- **Blast radius.** A workspace connection exposes everything its connecting
  admin's key can see, to every work stream in the workspace (decision 3
  states this as the design's honest framing, with the attestation and
  lifecycle answer); disabling the connection stops tool access and webhook
  admission in the same request. Private Fathom calls are never reachable
  through any Avalon path because Fathom itself withholds them.

## Agent behavior

Concise contract here; the complete tool catalog, wire shapes, discovery
sequences, and failure contract required by
[`../../prds.md`](../../prds.md#required-documentation-for-agent-tools-and-plugins)
are in [`design.md`](design.md).

- **Plugin contract.** One connector plugin per Fathom connection, defined via
  `defineConnectorAgentPlugin`: `providerType: "fathom"`, wire prefix
  `fathom` (a second connection renders as `fathom_2`, and tool names in
  descriptions and error sentences render with the connection's wire prefix —
  the Google precedent). It is available when the workspace holds an
  authorized Fathom connection whose grant covers the requesting principal,
  and it is a deferred plugin for personal connections: loading it triggers
  reauthorization and live MCP `tools/list` discovery and exposes tools on
  the next turn. Loading persists only the activation record; it starts no
  ingestion, creates no webhook, and grants no capability the connection did
  not already hold.
- **Selection.** Scope is host-derived, never model choice. Where a member
  sees two Fathom plugins (personal + workspace), their catalog presentation
  is scope-conditioned so the model can tell them apart (Product behavior,
  Agent use). For the two-notetaker case, the system message carries one
  decidable rule: when a request does not name a product, do not report a
  meeting as missing until every available notetaker plugin has been checked,
  and say which source answered.
- **Capabilities.** `fathom.personal.read` (personal connections, dynamic MCP
  tools) and `fathom.workspace.read` (workspace connections, static tools),
  with capability→connection-scope mapping exactly as Granola's.
- **Static workspace tools** (all `read`, idempotency `safe`, serial not
  required, host-default timeout): `list_meetings`, `list_meeting_types`,
  `get_meeting_summary`, `get_meeting_transcript`, `list_teams`,
  `list_team_members`. Cursor pagination is surfaced to the model; the system
  message forbids claiming complete coverage while a cursor remains. Results
  are bounded by a `boundFathomValue` that — unlike Granola's silent bound —
  sets an explicit truncation flag with counts when a cap fires
  ([`design.md`](design.md)).
- **Forbidden.** No Avalon-authored tool writes to Fathom; a call outside the
  connection's granted capability is refused with
  `connectorCapabilityRefused`, naming the grant. Provider-authored MCP tools
  on the personal scope execute only as confirmed writes.
- **Failure contract.** Failures use the repository's closed `ConnectorError`
  vocabulary with authored model-visible sentences (the adapter re-authors
  provider messages rather than forwarding Fathom's own text) and per-row
  forwarded detail keys; each sentence contains the next action and every
  retry instruction is self-limiting. Full table, including the
  token-endpoint classification row and the delegation of personal-scope
  failures to the hosted-MCP contract, in [`design.md`](design.md).
- **Model-usability acceptance.** Schema snapshot and contract tests for every
  static tool's required/optional/forbidden/success/failure shapes, plus
  prompt evaluations on the configured medium fallback model covering
  discovery, a list→summary→transcript sequence, a wrong-first-call recovery,
  the rate-limit stop condition, a **no-loop** case on a truncated transcript
  and a repeated 429, and a plugin-selection case with both notetakers
  connected. Conflict recovery: N/A — the catalog has no writes and no
  revisions. The repository has no standing prompt-eval harness; these
  evaluations are named as in-scope new work in the implementing plan, not an
  existing gate.

## Provider configuration

Settings that live outside this repository, and what breaks without them:

1. **Fathom MCP authorization (personal).** The hosted-MCP passthrough
   assumes OAuth protected-resource discovery and dynamic client registration
   at `https://api.fathom.ai/mcp`. Whether Fathom's authorization server
   supports DCR is unconfirmed (Open question 2). If it does — as with
   Granola — no external registration and no new secrets are needed. If it
   does not, an application is registered at
   `fathom.video/marketplace_applications/new` with Avalon's region-specific
   redirect URIs, and its client credentials become per-region Worker secrets
   (`FATHOM_CLIENT_ID` / `FATHOM_CLIENT_SECRET`), declared optional in
   `env.ts` and recorded in [`../../provider-apps.md`](../../provider-apps.md)
   and the runbook's per-region secret list — **and** the hosted-MCP
   machinery gains a static-client mode, because
   `beginHostedMcpAuthorization` today always registers a client dynamically
   and its OAuth config has no configured-client fields; that mode is
   in-scope new work named in the touch list, not a config toggle. Until
   Open question 1 is resolved, the personal build is blocked either way.
   **The registry entry does not
   depend on them**: `fathomConnectorConfig(env)` always returns a config
   with the credentials as optional fields (the Notion pattern), and only
   `POST /connections/fathom/start` refuses when they are absent — workspace
   connect, ingestion, and digestibility are unaffected in a region missing
   the secrets. Note the token endpoint's per-app 60 req/min budget is shared
   across all personal connections in a region.
2. **Flagship provisioning.** The `fathom-connector` client flag must be
   provisioned in Flagship for both regional apps before the flag can open —
   a Cloudflare setting outside the repository.
3. **Fathom API key (workspace).** Generated by the connecting admin in
   Fathom's settings (API Access); entered in the workspace connect modal,
   never configured server-side. Available on all Fathom plans.
4. **Webhook reachability.** Fathom must be able to reach the regional ingress
   URL Avalon registers. No Fathom-side manual webhook configuration is
   required in the happy path — Avalon creates and deletes the endpoint via
   the API; a failed compensation can leave an orphan endpoint that the admin
   removes in Fathom's settings (Key design decision 4).

## Rollout

- **Flag.** Catalog visibility is gated by a client feature flag
  `fathom-connector` — closed to off, per
  [`../../feature-flags.md`](../../feature-flags.md). This is real plumbing,
  not one file: a field on `ClientFeatureFlagsSchema` in `@avalon/contracts`,
  a resolver in `apps/api/src/services/client-feature-flags.ts`, and a
  renderer read path (the desktop currently reads client flags through the
  main-process poll). While the flag is unresolved or off the card does not
  render; an installed connection remains visible and working in the
  Installed section even when its catalog card is hidden. The flag hides the
  card only — server routes stay reachable, which is harmless while no
  connection exists to address.
- **Order.** The migration (table rebuilds plus indexes) ships first and is
  flag-independent; registry wiring, routes, and ingress land next,
  **unflagged** — the flag gates catalog visibility only, and everything an
  existing connection depends on (callbacks, tools, refresh, revoke,
  ingress) operates regardless of the flag; the flag opens last.
- **Off switch.** Turning the flag off hides the catalog card; disabling a
  connection (or deleting the Fathom-side endpoint on revoke) stops
  ingestion. No data cleanup is required to roll back — admitted activities
  and resources are inert without the connector.

## Acceptance

1. Personal connect end-to-end: start → Fathom authorization → callback →
   desktop handoff → healthy personal connection; the agent loads the Fathom
   plugin and reads a real meeting summary. (A manual desktop flow — lands in
   [`../../e2e.md`](../../e2e.md) as a durable check.)
2. Workspace connect: a valid key succeeds and creates a Fathom webhook
   endpoint; the service refuses a second workspace connect **before
   contacting Fathom** (the Granola `not.toHaveBeenCalled()` assertion); both
   partial unique indexes refuse their duplicate shape at the database; a
   failed row insert (injected `batch` rejection) issues the compensating
   `DELETE` to Fathom and propagates the **original** error.
3. Webhook delivery: a signed delivery admits exactly one content-free
   `meeting.content_ready` activity and enqueues it, with no provider call in
   the ingress; a replay of the same delivery admits no new activity or
   receipt row and re-enqueues the canonical activity; a bad signature, stale
   timestamp, or oversized body is rejected; a delivery to a disabled
   connection is rejected; hydration at opportunity admission retries on a
   transient provider failure.
4. Migration: applied to a database **populated at the prior migration**, the
   rebuild preserves a seeded row in every table with a foreign key to
   `connector_connections` — including `slack_unfurled_links`,
   `digest_delivery_targets`, and `workstream_terminal_repositories` — keeps
   `connector_oauth_attempts.telemetry_operation_id` and its index, and
   leaves `PRAGMA foreign_key_check` empty; the fresh-database scope-
   uniqueness case passes alongside.
5. Lifecycle: test reports health without writing; a 401 carrying provider
   details flips the connection to reconnect-required; a personal reconnect
   restores it; a workspace connection recovers by key replacement; disable
   stops tools and ingestion immediately; a 429 carrying `Retry-After: 2`
   retries exactly once after 2000 ms and returns the rate-limit failure
   without a third call.
6. Enrichment and bounds: hydrating a `fathom_meeting` populates
   `external_people` with recorder, attendees, and invitees; a meeting with
   more than 100 people does not evict explicitly recorded people from the
   capped merge; an over-bound transcript returns leading segments plus the
   truncation flag and counts; a personal-scope `fathom_meeting` hydrates
   only for its owner principal.
7. Conformance, by artifact rather than by suite name: `fathom` entries added
   to the hand-maintained registry literals and rosters in
   `connector-credential-freshness.test.ts` (with a credential fixture — or,
   if the adapter ships workspace-only with no `refreshCredentials`, a named
   test that a key 401 flips the row to reconnect-required),
   `digestibility-doc.test.ts`, `connector-tool-prose.test.ts`, and
   `connector-catalog-discovery.test.ts` (including a Fathom-distinct
   `REQUEST_VOCABULARY` phrase); an authorization server outside the
   passthrough's origin allowlist is refused.

## Open questions

1. **Does Fathom's MCP authorization server support dynamic client
   registration?** Determines whether personal connect needs a registered
   marketplace application and Worker secrets (Provider configuration 1).
   Blocks the personal build; the workspace build proceeds either way.
2. **What are Fathom's webhook retry semantics?** Undocumented. If deliveries
   are not retried on failure, non-goal 5 (no polling fallback) may need
   revisiting; the receipt-based dedupe makes any answer safe, but coverage
   depends on it.
3. **Which `triggered_for` set does the workspace endpoint subscribe to, and
   what does it cover?** Fathom's enum is `my_recordings`,
   `shared_external_recordings`, `my_shared_with_team_recordings`, and
   `shared_team_recordings` (the last two Team Plan only). The chosen set
   determines how complete workspace-scope ingestion is relative to what the
   admin's key can *read*, and how far the modal's bound-of-access copy can
   promise.
4. **What does Fathom's MCP tool catalog contain, and how stable is it?**
   Affects grant-validation UX for personal connections and the accuracy of
   the plugin's system message on that scope. Not blocking — the passthrough
   already handles catalog drift.
5. **Does Fathom's API permit creating a webhook endpoint under an OAuth
   (personal) token, or only under an API key?** If only the latter, personal
   ingestion is off the table entirely; either way it stays out of this scope
   (non-goal 6), and this question gates only whether a future PRD can
   propose it.
6. **What is the format of a Fathom API key?** [`research.md`](research.md)
   records no prefix or length. Blocks the route's `zValidator` regex and the
   modal's validation affordance; until answered, both check only non-empty
   plus a length bound.
7. **Does Fathom's webhook payload carry an event identifier?** The
   per-delivery identity is the authenticated `webhook-id` header either
   way; if the payload also carries one, it is cross-checked as an extra
   guard, and if not the cross-check is dropped rather than invented. The
   public payload documentation does not enumerate the body's fields, so
   this resolves against a live delivery.
8. **`list_meetings` result ordering.** Unrecorded in the public docs; the
   tool description states ordering only once verified against the OpenAPI
   spec, and the low-level answer lands in
   [`../../assumptions.md`](../../assumptions.md). (The other wire details
   flagged during review — recording IDs are integers, the transcript
   endpoint has no range parameter, the summary endpoint returns only the
   summary — were verified against the API reference and are reflected in
   [`design.md`](design.md).)
