# Notion shared ingress

A Notion public connection accepts exactly one OAuth redirect URI and delivers
its webhook subscription to exactly one URL, for every Notion workspace that
installs it. Avalon runs two regional Workers. This module is how one connection
serves both: `notion.with-avalon.com` is bound to the Global Worker, answers the
one callback and the one webhook, and hands each to the region that owns the
Avalon workspace involved. Read it before changing Notion authorization, Notion
webhook ingestion, or anything that assumes a connector's callback is regional —
Notion's is not.

Everything else about the Notion connector — its tools, capabilities, and page
authorization model — is in [`CONNECTORS.md`](CONNECTORS.md). The regional
boundary this module bends is defined in
[`REGIONALIZATION.md`](REGIONALIZATION.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/lib/notion-ingress.ts` | The one definition of the shared host, its callback URL, and the routes it may serve. |
| `apps/api/src/lib/region-routed-state.ts` | Builds and reads the `<region>.<entropy>` OAuth state shared with the GitHub App's setup URL. |
| `apps/api/src/services/notion-routing-service.ts` | The Global control plane: callback dispatch, route directory writes, webhook verification and fan-out. |
| `apps/api/src/notion-regional-bridge.ts` | EU-side `WorkerEntrypoint`: completes callbacks, ingests forwarded bytes, stores the replicated challenge. |
| `apps/api/src/notion-routing-bridge.ts` | Global-side `WorkerEntrypoint` the EU Worker calls to register and retire routes. |
| `apps/api/src/lib/connector-registry.ts` | Builds the connector's `redirectUri` from the shared host in **both** regions. |
| `packages/db/migrations/0066_shared_notion_connection_routing.sql` | The `notion_workspace_routes` directory, Global only. |

## How it works

### Authorization

`ConnectionService.beginProvider` mints the OAuth state as
`<region>.<32 bytes of entropy>` for Notion alone, and stores the row in the
region that started the attempt. The authorize URL carries the shared redirect
URI, so Notion returns the user to `notion.with-avalon.com` whichever region they
belong to.

The callback route reads the region from the state prefix and calls
`ConnectionService.completeProvider` — locally when the prefix says `global`,
over `EU_NOTION_BRIDGE` when it says `eu`. The token exchange, the credential
encryption, and the connection row all happen in the owning region; Global holds
none of them. Denials and failures route the same way, so a user who cancels in
EU still lands on their own region's attempt record.

On success the owning region registers `notion_workspace_routes` through
`NotionRoutingService.registerConnection`, which writes locally in Global and
calls `GLOBAL_NOTION_ROUTER` from EU. A registration failure marks the connection
`error` with `notion_route_registration_failed` rather than leaving a connection
whose events can never be delivered.

### Webhooks

Notion sends the one-time `verification_token` to the subscription URL, which is
the shared host. Global validates the operator `NOTION_WEBHOOK_SETUP_TOKEN`,
encrypts the token under its own key, and then replicates the plaintext to EU
over the bridge, where EU encrypts it under *its* key with its own region-bound
AAD. Both regions end up able to verify a signature independently.

Every later delivery is verified at Global against the stored token and the
expected integration ID, then routed on the `workspace_id` the verified envelope
carries. Exact bytes go to each active region for that Notion workspace; the
regional `ProviderWebhookService` verifies the signature again before it
normalizes, matches the delivery against its own connections by bot ID, and
persists the payload in its own R2.

## Invariants

- **The redirect URI is identical in both regions.** Notion replays
  `redirect_uri` at the token exchange and rejects a mismatch, so a region that
  computed its own would fail every exchange. `notionCallbackUrl` is the only
  place it is built.
- **The region prefix selects a bridge and authorizes nothing.** The state row
  still lives in one region and is still consumed there. An attacker who rewrites
  the prefix reaches a region with no such row and gets `invalid_oauth_state`;
  treating the prefix as evidence of anything else would make a public redirect
  parameter into an authorization decision.
- **Global never persists Notion workspace content.** It holds the route
  directory and the verification token, and passes codes and payload bytes
  through memory. A delivery with no active route is refused with a 503 rather
  than parked in Global — dropping it would lose an event, and storing it would
  put possibly EU-resident content in the wrong region.
- **Both regions verify every delivery.** Global verifies to learn where a
  delivery goes; the owning region verifies again because a service binding is
  not a trust boundary. Removing the second check would make the bridge the only
  thing standing between a forged payload and a workspace's activity feed.
- **Routes are keyed on the Notion workspace, not on `provider_account_id`.**
  That column holds the installed bot, and a delivery names the workspace it
  happened in. The bot ID is what the *regional* service matches connections on,
  through `accessible_by`.
- **The shared host serves only its three routes.** It is a public name that
  exists because a third party demanded a single URL; the rest of the Global API
  is not part of what Notion was given.

## Boundary

This module owns the shared host, the state prefix, the Global route directory,
and the two RPC surfaces. It does not own the Notion adapter (`packages/connectors/src/notion.ts`),
the connection lifecycle (`ConnectionService`), or webhook normalization and
persistence (`ProviderWebhookService`) — it calls all three and adds no
provider semantics of its own.

Its callers are the ingress routes in `apps/api/src/routes/connections.ts`,
`ConnectionService` at connect/test/disable time, and the two bridges. Nothing
outside the Global Worker may call the routing half: every entry point asserts
`AVALON_REGION === "global"` and answers `notion_ingress_misconfigured`
otherwise.

## Failure modes and limits

| Condition | Result |
| --- | --- |
| State carries no region prefix | `401 invalid_oauth_state`; the callback still redirects to the hosted desktop handoff with `status=failed`. |
| `EU_NOTION_BRIDGE` unbound or EU unavailable | `503 notion_region_unavailable`. The authorization fails closed; the user retries. |
| Delivery for a Notion workspace with no active route | `503 notion_route_pending`. Notion retries, by which time the OAuth callback has normally registered the route. |
| Signature invalid, or signed for another integration | Rejected before any D1 access — `invalid_signature` / `unauthorized`. |
| Challenge replication to EU fails | The whole setup request fails. Re-sending the verification from Notion's dashboard is idempotent: Global recognizes the same token and replicates again. |
| Webhook body over `PROVIDER_WEBHOOK_MAX_BYTES` (2 MB default) | `payload_too_large`, before parsing. |
| `GLOBAL_NOTION_ROUTER` unavailable from EU at connect time | Connection is marked `error` with `notion_route_registration_failed`; a connection test re-registers it. |

## Testing

`apps/api/test/notion-routing.test.ts` is the suite for this module —
`pnpm --filter @avalon/api exec vitest run test/notion-routing.test.ts`. It uses
a hand-written D1 fake holding only `notion_workspace_routes`, and the service's
constructor seams (`completeInRegion`, `ingestInRegion`, `storeChallengeInRegion`,
`captureChallenge`, `verificationToken`) to keep credential decryption out of the
routing assertions. Two cases drive the real `createApp()` to prove the host gate
and the callback wiring, not just the helpers.

The trap: `isSharedNotionIngress` compares `host`, not `hostname`, because
development points the ingress at `127.0.0.1:8787` where both regional Workers
share a hostname. A test that asserts on hostname alone will pass while the EU
Worker mistakenly claims to be the ingress.

Provider-side Notion webhook verification and normalization are covered by
`apps/api/test/provider-webhooks.test.ts` and
`packages/connectors/src/notion.test.ts`; this suite does not re-test them.

## Regional impact

Global gains one table (`notion_workspace_routes`) and one secret (the Notion
verification token, also replicated to EU). Authorization codes and webhook bytes
for EU workspaces transit Global and are persisted only in EU. This is the same
concession `REGIONALIZATION.md` already records for the shared GitHub, Linear,
and Slack ingresses, extended to the OAuth code because Notion allows only one
redirect URI.

## Operations

`notion.with-avalon.com` must exist as a custom domain on `avalon-api-global`
before the connection is registered with Notion. Both Workers need
`NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`, and
`NOTION_INTEGRATION_ID` — the *same* values, since there is one connection — plus
`NOTION_WEBHOOK_SETUP_TOKEN`. Registration steps are in
[`PROVIDER_APPS.md`](PROVIDER_APPS.md).

## Changelog

### 2026-08-12 — One public Notion connection, routed through a Global ingress

**What changed:** Notion moved from two region-specific public connections to a
single connection reached at `notion.with-avalon.com`. Both regions now build the
same redirect URI, Notion OAuth state carries a `<region>.` prefix, and a new
`NotionRoutingService` plus two bridges carry callbacks and verified webhook
bytes to the owning region. Global gained `notion_workspace_routes`, and the
one-time webhook verification token is replicated from Global to EU.

**Why:** The original design gave each region its own Notion connection so each
could own its own callback and webhook, matching how the regional Workers are
built. That is not available: a Notion public connection accepts one redirect
URI, and the provider-side registration this repository can actually obtain is a
single connection. Two connections were reconsidered and rejected — even with two
registrations, Notion has no way to know which region a Notion workspace belongs
to, so its deliveries could not be aimed correctly. The single URL is therefore a
property of the provider, not a configuration choice.

Routing on a state prefix, rather than a Global lookup table of pending
authorizations, keeps Global from holding any part of a pending authorization:
the verifier, the requested capabilities, and the workspace stay in the region
that started it. The prefix is deliberately not a secret, and nothing is
authorized by it.

Webhooks reuse the Linear route-directory shape rather than fanning out to both
regions on every delivery. Fan-out would have worked — a region with no matching
connection returns cleanly — but it would put every EU workspace's payload bytes
in front of the Global matcher, which is the specific thing the regional boundary
exists to prevent.

The challenge token is replicated to EU rather than having EU trust a
pre-verified envelope from Global, so the second signature check survives. A
future change that finds the replication awkward should replace it with something
that preserves independent verification in EU, not with trust in the hop.
