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
- **A retired route is answered, not retried.** `activeRegions` filtering would
  make "disabled" and "never registered" the same fact, and only one of them
  should ask Notion to come back. The route directory therefore reads status
  rather than filtering on it.
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
- **The ingress is a different host from the regional API, and a request to the
  region's own `PUBLIC_API_BASE_URL` is never the shared ingress.** The route gate
  is the reason the ingress gets its own name; applied to the regional API it
  would 404 everything except the three ingress routes — which is precisely what
  happens in development, where the ingress must name a locally reachable address.
  `/health` stays reachable either way, so a health-only smoke check will not
  notice. Configuring the two to the same host in production would instead
  silently disable cross-region callbacks.

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
| Delivery for a Notion workspace that has never been routed | `503 notion_route_pending`. Notion retries, by which time the OAuth callback has normally registered the route. |
| Delivery for a Notion workspace whose every route is disabled | `{accepted, activityCount: 0}`. Disabling an Avalon connection does not uninstall the integration at Notion, so a retired workspace keeps delivering forever; retrying it would spend the full retry budget on every delivery, against the subscription every customer shares. |
| Setup challenge posted to a regional host instead of the ingress | `400 notion_setup_wrong_host`, naming the right URL. Only the ingress replicates the token, so accepting it elsewhere would answer 200 and leave the other region unable to verify anything. |
| Signature invalid, or signed for another integration | `invalid_signature` / `unauthorized`, before the route directory is consulted and before any payload is stored. Not before *all* D1 access: the stored verification token is read first, because verifying is what makes the delivery's workspace readable. |
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

The traps, both from the same root — development has to point the ingress at a
locally reachable address, so the ingress and the regional API stop being
obviously different hosts:

- `isSharedNotionIngress` compares `host`, not `hostname`, because both local
  Workers are `127.0.0.1` and differ only by port. A test asserting on hostname
  alone passes while the EU Worker mistakenly claims to be the ingress.
- It also declines the region's own `PUBLIC_API_BASE_URL`. The case worth keeping
  covered is the app-level one: drive `createApp()` with the ingress and the API
  set to the same host and assert an ordinary route still answers. Asserting only
  on `/health` proves nothing, because `/health` is on the ingress allowlist.

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
before the connection is registered with Notion.

**The release that first ships this module needs the three-stage Worker rollout
in [`RUNBOOK.md`](RUNBOOK.md), by hand.** The two bridges are a circular pair —
Global binds `EU_NOTION_BRIDGE` to an entrypoint EU does not export yet, and EU
binds `GLOBAL_NOTION_ROUTER` to one Global does not export yet — so neither
region can be deployed with its full configuration first, and the automatic
EU-then-Global deployment cannot land this change. Both Workers need
`NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`, and
`NOTION_INTEGRATION_ID` — the *same* values, since there is one connection — plus
`NOTION_WEBHOOK_SETUP_TOKEN`. Registration steps are in
[`PROVIDER_APPS.md`](PROVIDER_APPS.md).

## Changelog

### 2026-08-12 — A retired workspace is answered, and the challenge has one door

**What changed:** A delivery whose every route is disabled now returns
`{accepted, activityCount: 0}` instead of the retry-me 503, so the directory
reads route status rather than filtering on it. A `setup=` challenge posted to a
regional host is refused with `notion_setup_wrong_host` instead of being stored
there. The four `default*InRegion` helpers regained the
`AVALON_REGION === "global"` check the Linear equivalents carry.

**Why:** Both are consequences of one subscription serving every customer, which
is what makes this module different from the per-tenant webhooks it was modelled
on. Disabling an Avalon connection does not uninstall the integration at Notion,
so a retired workspace keeps delivering with nothing that will ever make its
route active again; answering those with a 503 spends the full retry budget on
each one and risks Notion disabling the subscription that every other customer
depends on. And the challenge arrives exactly once: the regional handler would
have stored it and answered 200 without replicating, which surfaces later as a
total delivery failure for the region that never got a copy — the failure the
replication exists to prevent, reached through the other door.

### 2026-08-12 — The bridges ship as a staged rollout, not on the automatic deploy

**What changed:** `RUNBOOK.md` gained a three-stage bootstrap for the release
that first ships this module, and `Operations` above points at it. No code
changed.

**Why:** The two bridges are a circular pair: Global's config binds
`EU_NOTION_BRIDGE` to an entrypoint EU does not export yet, and EU's binds
`GLOBAL_NOTION_ROUTER` to one Global does not export yet. The automatic
merge-triggered deployment runs EU then Global, and neither order can succeed —
whichever goes first references an entrypoint that does not exist. The repository
had already met this with work-stream inbound email and written the rule down;
what it had not done was make the rule findable from the module that trips it.
A future module that adds a cross-region entrypoint in only one direction does
**not** need this, and should not copy the staging by reflex — the cost is a
release that cannot be landed by merging.

### 2026-08-12 — The ingress never claims the Worker's own regional API

**What changed:** `isSharedNotionIngress` returns false for a request to the
region's own `PUBLIC_API_BASE_URL`, and `sync-dev-env.mjs` points each region's
development ingress at that region's own Worker instead of at the Global one.

**Why:** The first cut defaulted development to `http://127.0.0.1:8787`, the
local Global Worker's own address. That made every local request match the shared
ingress, so the three-route gate applied to the entire API and 404'd everything
but `/health`, `GET /connections/notion/callback`, and `POST /ingest/notion` —
and `/health` being on the allowlist meant the documented smoke check still
passed while local development was broken. GitHub, Linear, and Slack never hit
this because nothing derives a URL from their ingress values, so they are simply
left at production names locally; Notion's redirect URI is built from this one,
so it has to name something reachable. Guarding on the regional host keeps that
possible without letting the gate escape the host it was written for.

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
