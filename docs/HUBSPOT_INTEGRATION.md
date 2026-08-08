# HubSpot connector research

Research only. Nothing in this document is implemented. It records what a HubSpot
connector would have to be, which Avalon seams it lands on, and the provider
facts that decide the shape.

## Decision

Build HubSpot as a **workspace-only `resource` connector** over HubSpot's REST CRM
API, authorized by one **legacy public app per region**, with **app-level webhooks**
as the activity source and a bounded `hs_lastmodifieddate` catch-up poll for the
gaps webhooks cannot cover.

Three findings drive that shape:

1. A HubSpot OAuth install is portal-wide. The token belongs to the app, not to the
   installing user, and it reads every record in the portal that its scopes cover.
   A "personal" HubSpot connection would therefore be a false label: it would grant
   one Avalon member portal-wide CRM access under a name implying their own view.
   X is the existing precedent for a workspace-only connector.
2. HubSpot does not support PKCE on public-app authorization. Avalon's generic
   `beginProvider` path already tolerates this — it mints a verifier and challenge
   unconditionally and the adapter is free to ignore `codeChallenge`, exactly as
   `createNotionConnector` does. Sealed state plus the `connector_oauth_attempts`
   row carries the CSRF and principal binding.
3. Webhooks v3 subscriptions are configured **per app**, not per install, and apply
   to every portal that installs that app. That aligns cleanly with one app per
   region and a regional webhook URL, the Notion registration model, and avoids the
   smart-ingress fan-out that GitHub, Linear, and Slack need.

The counter-option — HubSpot's remote MCP server — is deliberately deferred. See
[API versus MCP](#api-versus-mcp).

## Product boundary

The connector exists so a work stream can answer and act on CRM questions without a
human pasting records in: look up an account before a call, read a deal's history,
log a note or task against the right contact, and react when a deal stage moves.

It is not a CRM sync. Avalon does not mirror the portal, build a second index of
contacts, or bulk export objects. Reads are bounded, cursored, and on demand.
Normalized activities carry compact metadata and object references, not record
bodies; the raw signed delivery goes to regional R2 like every other native
provider payload.

## Connection cardinality

- One HubSpot portal (`hub_id`) maps to at most one active connection per Avalon
  workspace.
- An Avalon workspace may connect several portals — agencies and multi-brand
  companies routinely run more than one.
- Re-running the flow for a portal that is already connected must **repair** that
  connection, not create a second one. HubSpot issues an additional refresh token
  on reinstall and leaves existing refresh tokens working, so nothing on the
  provider side prevents duplicate connections; Avalon has to.

That is the Linear/Slack `provider_account_id` reconciliation branch in
`ConnectionService.completeProvider`, plus a partial unique index. Both are called
out in the [implementation map](#implementation-map).

## App registration

Register two legacy public apps in the HubSpot developer account, mirroring
`docs/PROVIDER_APPS.md`'s Notion section:

| Setting | Global | EU |
| --- | --- | --- |
| Name | Avalon Global | Avalon EU |
| Redirect URI | `https://api.with-avalon.com/connections/hubspot/callback` | `https://eu.api.with-avalon.com/connections/hubspot/callback` |
| Webhook target | `https://api.with-avalon.com/ingest/hubspot` | `https://eu.api.with-avalon.com/ingest/hubspot` |

Each app carries its own client ID, client secret, and app ID; the client secret is
also the webhook signing secret. Store them as regional Worker secrets.

Two consequences to accept up front:

- **Legacy public app, not a projects app.** Webhooks v3 supports legacy public apps
  only. Projects-platform apps configure webhooks differently and would change this
  design.
- **Marketplace listing conflicts with the two-app model.** A public listing wants
  one app, and a customer should not have to choose between "Avalon Global" and
  "Avalon EU" in the marketplace. If listing is pursued, collapse to one app and add
  a `hubspot.with-avalon.com` smart ingress that verifies the v3 signature, reads
  `portalId` from the batch, and fans the exact signed bytes to the owning regions —
  the GitHub and Linear pattern. Note that marketplace-distributed OAuth apps also
  drop to a lower per-account burst limit (see [Rate limits](#rate-limits)). Until
  listing is a real requirement, two unlisted regional apps are simpler and keep EU
  payloads out of Global entirely.

## OAuth

Authorization is a plain authorization-code flow with a client secret.

- Authorize: `https://app.hubspot.com/oauth/authorize` with `client_id`,
  `redirect_uri`, `scope` (space separated), optional `optional_scope`, and `state`.
  `https://app.hubspot.com/oauth/{portalId}/authorize` targets a specific portal.
- Token exchange and refresh: `POST https://api.hubapi.com/oauth/2026-03/token`,
  form encoded, all parameters in the body. The v1 equivalent is
  `POST /oauth/v1/token` and is deprecated on 16 February 2027.
- Introspection: `POST https://api.hubapi.com/oauth/2026-03/token/introspect`
  returns `hub_id`, `app_id`, `user`, `user_id`, `scopes`, `expires_in`. The v1
  equivalent is `GET /oauth/v1/access-tokens/{token}`.
- Revocation: `DELETE https://api.hubapi.com/oauth/v1/refresh-tokens/{token}`.
  No dated-version replacement is documented yet, so `revoke()` targets v1.

Access tokens expire in 30 minutes (`expires_in: 1800`). Refresh tokens do not
rotate and stay valid until deleted. That is a materially different lifecycle from
Notion and Linear, and it means `refreshCredentials` will run on nearly every
non-trivial task rather than occasionally — `ensureFreshConnectorCredentials` and
the credential refresh lease matter more here than for any existing connector.

`handleAuthorizationCallback` returns:

- `providerAccountId` = `hub_id` as a string. This is the routing key for webhooks
  and the dedupe key for reconnects. The token response carries `hub_id` directly;
  introspect is still worth one call to capture `hub_domain` for a human-readable
  `providerAccountName`.
- `accessToken`, `refreshToken`, `expiresAt`, and the granted `scopes`.

**No PKCE.** The adapter accepts and discards `codeChallenge` (Notion's
`beginAuthorization` already does exactly this). Do not describe the HubSpot flow as
PKCE-protected anywhere in the product or runbook.

### Capability to scope mapping

Avalon capabilities stay coarse and product-shaped; HubSpot scopes are granular and
per object type. The mapping belongs in `providerCapabilityScopes.hubspot` in
`apps/api/src/services/connection-service.ts`, alongside `LinearCapabilityScopes`
and `SlackCapabilityScopes`.

| Avalon capability | HubSpot scopes (verify against the scopes table at registration) |
| --- | --- |
| `hubspot.crm.read` | `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read`, `crm.objects.owners.read`, `crm.schemas.contacts.read`, `crm.schemas.companies.read`, `crm.schemas.deals.read` |
| `hubspot.crm.write` | `crm.objects.contacts.write`, `crm.objects.companies.write`, `crm.objects.deals.write` |
| `hubspot.tickets.read` | `tickets` read equivalent |
| `hubspot.engagements.write` | note/task object write scopes |

Two rules for the final table:

- **Never request sensitive-data scopes** (`crm.objects.*.sensitive.*`). HubSpot
  gates them separately and Avalon has no product reason to hold them.
- Put anything a portal tier might not have into `optional_scope`. HubSpot drops
  optional scopes silently when the selected account lacks the tool, whereas a
  missing required scope fails the whole authorization. Because they can be dropped,
  the callback must record the **returned** `scopes` and reconcile them against the
  requested capabilities before marking the connection healthy — the same shape as
  `assertGoogleCapabilitiesGranted` and `assertLinearCapabilitiesGranted`.

## Tool surface

Prefix-free definitions, `hubspot` wire prefix, so the model sees
`hubspot_search_objects` and so on. HubSpot's object APIs are uniform across object
types, so a small generic set covers far more than one tool per object would.

| Tool | Mode | Capability | Notes |
| --- | --- | --- | --- |
| `search_objects` | read | `hubspot.crm.read` | Bounded `filterGroups`, explicit `properties`, `limit` ≤ 25, `after` cursor returned verbatim |
| `get_object` | read | `hubspot.crm.read` | `objectType`, `objectId`, explicit `properties`, optional association fetch |
| `list_associations` | read | `hubspot.crm.read` | Deal → contacts, contact → companies, and so on |
| `list_properties` | read | `hubspot.crm.read` | Required: the model cannot write filters or updates without the portal's real property names |
| `list_owners` | read | `hubspot.crm.read` | Resolves owner IDs to people |
| `list_pipelines` | read | `hubspot.crm.read` | Deal and ticket stage vocabularies |
| `create_object` | write | `hubspot.crm.write` | `record_before_execute` idempotency |
| `update_object` | write | `hubspot.crm.write` | `record_before_execute` idempotency |
| `create_note` / `create_task` | write | `hubspot.engagements.write` | Engagement plus association in one tool call |

`list_properties`, `list_owners`, and `list_pipelines` look like overhead and are
not. Every HubSpot portal has custom properties and custom pipeline stages; without
discovery the model guesses internal names and every filter and update fails.

Bound results the way `x.ts` does with `boundXValue` — depth, array length, key
count, and string truncation — because CRM records with all properties requested are
large and unbounded property sets are attacker-influenced text.

## API version and bounds

HubSpot has moved to dated API versions: `/crm/objects/2026-03/{objectTypeId}` with
`/batch/*` and `/search` under the same prefix. The `/crm/v3/objects/...` paths still
work. Pin one version in a module constant, as `notion.ts` does with
`DEFAULT_NOTION_VERSION`, and treat a version bump as a reviewed change.

Search constraints that the input schemas must encode rather than discover at
runtime:

- 200 objects per page maximum; Avalon should cap at 25 for model consumption.
- 10,000 results total per query — paging past it returns 400.
- At most 5 `filterGroups`, 6 filters each, 18 filters total.

## Rate limits

- OAuth app burst: 190 requests per 10 seconds. **Marketplace-distributed** OAuth
  apps: 110 requests per 10 seconds per account. Listing changes this number.
- CRM Search API: 5 requests per second per token, shared across the whole portal.
  This is the binding constraint, since search is the primary read path.
- Daily limits vary by portal subscription tier and purchased capacity packs.
- Over the limit returns 429 with `X-HubSpot-RateLimit-*` headers. The `-Secondly`
  headers are deprecated and no longer enforced.

Map 429 to `ConnectorError("provider_error", …, { retryAfterMs })` so
`connectorRetryAfterMs` carries the delay across the queue and Workflow boundary,
as the existing connectors do.

## Webhook contract

Subscriptions are configured on the app and apply to every portal that installs it:
object creation, deletion, merge, restore, property change, and association change
across contacts, companies, deals, tickets, products, and line items, plus
conversation events. Property-change subscriptions name a specific property.

Verification (`X-HubSpot-Signature-v3` with `X-HubSpot-Request-Timestamp`):

1. Reject if the timestamp is older than five minutes.
2. Build `requestMethod + requestUri + requestBody + timestamp` as UTF-8, with
   URL-encoded characters in the URI decoded but the `?` left alone.
3. HMAC-SHA256 with the **app secret**, base64 encode, constant-time compare.

Delivery semantics:

- Up to 100 events per JSON array batch.
- Five-second response deadline. Verify, dedupe, persist a receipt, enqueue the
  compact envelope, acknowledge. No downstream processing inline.
- Retries up to 10 times over 24 hours on connection failure, timeout, or any
  4xx/5xx.
- Concurrency 10 by default, configurable down to a minimum of 5.

Each event carries `portalId`, `appId`, `eventId`, `subscriptionType`, `objectId`,
`occurredAt`, and `attemptNumber`; property changes add `propertyName` and
`propertyValue`. `eventId` is the dedupe key, matching the `Linear-Delivery` and
GitHub delivery-ID handling in `ProviderWebhookService`. Route on `portalId` to the
connection whose `provider_account_id` matches.

One thing to design around explicitly: a webhook event gives an object ID and a
changed property, not a record. Normalization either stores that thin reference or
hydrates the object through `hydrateResource`. Hydration costs a rate-limited call
per event and a 100-event batch would blow the five-second budget, so **normalize
thin and hydrate lazily** when a work stream actually opens the resource.

## Activity ingestion and polling

Webhooks are the primary source. Polling is the catch-up path for the window
between a connection going unhealthy and being repaired, and for subscription types
not enabled on the app.

The incremental cursor is `hs_lastmodifieddate`: search sorted ascending on it,
filtered `> cursor`, page through, commit the cursor only after activities are
persisted — the same commit-after-persist discipline the Google poller uses. The
10,000-result cap means the window has to stay small; a portal that has just been
reconnected after a long outage needs the poll to walk forward in bounded time
slices rather than issue one unbounded query.

Given the 5 requests/second search limit, poll cadence should be conservative and
`nextPollAt` should back off hard on 429.

## API versus MCP

HubSpot ships a remote MCP server at `mcp.hubspot.com`, GA since April 2026. It
covers most CRM objects read/write, engagements, and read-only marketing content,
authenticates with OAuth 2.1 + PKCE, and — the genuinely interesting part — enforces
the authenticating **user's** HubSpot permissions rather than app-wide scopes.

Avalon already has the pattern: Slack's hosted MCP server is the personal tool plane
behind a workspace app that owns the control plane. HubSpot could work the same way,
and it is the only path to a HubSpot connection that is honestly personal.

It is still deferred for v1:

- MCP is a separate OAuth client and flow (PKCE, its own registration) from the
  public-app credentials this connector needs for webhooks. Shipping both at once
  doubles the authorization surface.
- An account administrator must authorize the connection before other users can
  connect, so it is not a self-service personal add-on.
- It cannot deliver webhooks, so the public app is required regardless.
- It excludes custom sensitive-data properties, which is fine, but it also means the
  two paths do not see identical data — a support and explainability cost.

Revisit once the workspace connector is stable. The split would then read: public
app owns install, webhooks, and workspace tools; MCP owns per-user attributed tools.

## Implementation map

Adding a provider to the generic OAuth path is mostly declarative. Every file below
already has a Notion, Linear, or Slack line to copy.

**New**

- `packages/connectors/src/hubspot.ts` — manifest, `HubSpotCapabilities`,
  `hubspotTools`, `HubSpotAgentPluginDescriptor`, `beginAuthorization`,
  `handleAuthorizationCallback`, `refreshCredentials`, `revoke`, `executeTool`,
  `poll`, `hydrateResource`, `healthCheck`, plus `verifyHubSpotWebhook` and
  `normalizeHubSpotWebhook`.
- `packages/connectors/src/hubspot.test.ts`.
- `packages/db/migrations/0047_hubspot_connector.sql` — the `connector_connections`
  table rebuild that extends the `connector_type` CHECK constraint, following
  `0041_x_connector.sql` exactly, including every child-row snapshot and restore.
  Add a partial unique index on
  `(workspace_id, connector_type, provider_account_id)` for
  `connector_type = 'hubspot' AND scope = 'workspace' AND status <> 'disabled'`.
- `docs/PROVIDER_APPS.md` — a HubSpot section with the regional table above.

**Modified**

| File | Change |
| --- | --- |
| `packages/connectors/src/index.ts` | Re-export the HubSpot surface; add `hubspot?: HubSpotConnectorConfig` to `createConnectorRegistry` |
| `packages/contracts/src/index.ts` | `ConnectionSchema.connectorType` and `ConnectorOAuthProviderSchema` gain `"hubspot"`; `AutomationPluginIconSchema` gains `"brand-hubspot"` or HubSpot falls back to `"plug"` |
| `apps/api/src/env.ts` | `HUBSPOT_OAUTH_CLIENT_ID`, `HUBSPOT_OAUTH_CLIENT_SECRET`, `HUBSPOT_APP_ID` |
| `apps/api/src/lib/connector-registry.ts` | `hubspotConnectorConfig(env)` and its registry entry |
| `apps/api/src/services/connection-service.ts` | `providerCapabilityScopes.hubspot`; a `provider === "hubspot"` reconcile-by-`hub_id` branch in `completeProvider`; granted-scope assertion |
| `apps/api/src/routes/connections.ts` | `POST /hubspot/start`, `GET /hubspot/callback`, `POST /ingest/hubspot` |
| `apps/api/src/services/provider-webhook-service.ts` | `Provider` union gains `"hubspot"`; `ingestHubSpot`; portal-ID routing |
| `apps/api/src/services/integrations.ts` | Provider list and `connectorAutomationPluginIcon` |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | `connectorProviderName`, `reconnectableConnectorTypes`, `installedConnectorTypes`, the `connectorProviders` card, the `connectProvider` provider union, connections search terms |
| `apps/desktop/src/renderer/lib/api.ts` | `startProviderConnection` provider union |
| `apps/desktop/src/main/index.ts` | Deep-link provider allowlist |
| `apps/site/src/auth-handoff.ts` | `CONNECTOR_PROVIDERS` and the display-name map |
| `.env.example`, `docs/CONNECTORS.md`, `docs/RUNBOOK.md` | Secrets and connector documentation |

`OAuthConnectorProvider` is `Exclude<ConnectorOAuthProvider, "google" | "github">`,
so adding `"hubspot"` to `ConnectorOAuthProviderSchema` automatically routes it
through `beginProvider` and `completeProvider` with no new OAuth machinery.

## Security notes

- A workspace connection's tools roll down to **every** ad-hoc work stream in the
  workspace and execute as the workspace principal. For a CRM that means any member
  can read every contact record the scopes cover. Ship `hubspot.crm.read` first and
  keep write capabilities separately selectable so a workspace can decline them.
- CRM records are dense PII. The bounding helpers are not just a context-budget
  measure here; they limit what lands in receipts and R2.
- Property values, note bodies, company descriptions, and contact fields are
  attacker-writable through public forms. The plugin system message must say so
  explicitly, in the style of the existing descriptors.
- Avalon's region is not HubSpot's region. An EU Avalon workspace can connect a
  US-hosted portal. That is the customer's choice, but the connection UI should not
  imply that connecting through the EU app keeps HubSpot-side data in the EU.

## Facts to re-verify at implementation time

Read against the live docs before writing code; these are the items most likely to
have moved or that this research did not pin down exactly.

- The exact scope strings for tickets and engagement objects, and which of them a
  given portal tier lacks (drives the required/optional split).
- Whether `/oauth/2026-03/token` is the current dated version, and whether a dated
  replacement for `DELETE /oauth/v1/refresh-tokens/{token}` has shipped.
- Whether refresh tokens still avoid rotation on the dated endpoints — the 2026-03
  page does not state it either way, and single-use rotation would change the
  credential-refresh lease design.
- The current `/crm/objects/{version}` dated version and whether `/crm/v3/objects`
  has a sunset date.
- Whether the projects developer platform has gained webhook support that would
  make a legacy public app the wrong choice.
- The exact webhook subscription types available for association changes, which
  determine whether relationship edits produce usable activities.

## Sources

- [Working with OAuth](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth)
- [Manage OAuth tokens with the 2026-03 API](https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens)
- [Manage OAuth access tokens using the v1 APIs](https://developers.hubspot.com/docs/api-reference/legacy/authentication/oauth-tokens/v1/guide)
- [Scopes](https://developers.hubspot.com/docs/apps/legacy-apps/authentication/scopes)
- [Webhooks v3 API guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide)
- [Validating webhook requests](https://developers.hubspot.com/docs/api/webhooks/validating-requests)
- [Using object APIs](https://developers.hubspot.com/docs/api-reference/latest/crm/using-object-apis)
- [Search the CRM](https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm)
- [API usage guidelines and limits](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines)
- [CRM Search API rate limit increase](https://developers.hubspot.com/changelog/crm-search-api-rate-limit-increase)
- [Remote HubSpot MCP server is now generally available](https://developers.hubspot.com/changelog/remote-hubspot-mcp-server-is-now-generally-available)
- [HubSpot MCP server](https://developers.hubspot.com/ai-tools/mcp)
- [New permission requirements for installing public apps](https://developers.hubspot.com/changelog/new-permission-requirements-for-installing-public-apps)
