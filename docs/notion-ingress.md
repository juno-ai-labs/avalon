# Notion shared ingress

A Notion public connection accepts exactly one OAuth redirect URI and delivers
its webhook subscription to exactly one URL, for every Notion workspace that
installs it. Rally's personal connection to Notion's official hosted MCP server
also uses the connector's registered redirect. Rally's deployments are regional
(Global is the only one configured today, per
[`regionalization.md`](regionalization.md)). This module is how both
authorization modes, and the workspace mode's webhook, serve every one of them:
`notion.rallywith.ai` is bound to the Global Worker, answers the callback and
webhook, and hands each to the region that owns the Rally Organization
involved. Read it before changing Notion authorization, Notion webhook
ingestion, or anything that assumes a connector's callback is regional —
Notion's is not.

Everything else about the Notion connector — its tools, capabilities, and page
authorization model — is in [`connectors.md`](connectors.md). The regional
boundary this module bends is defined in
[`regionalization.md`](regionalization.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/lib/notion-ingress.ts` | The one definition of the shared host, its callback URL, and the routes it may serve. |
| `apps/api/src/lib/region-routed-state.ts` | Builds and reads the `<region>.<entropy>` OAuth state shared with the GitHub App's setup URL. |
| `apps/api/src/services/notion-routing-service.ts` | The Global control plane: callback dispatch, route directory writes, webhook verification and fan-out. |
| `apps/api/src/lib/connector-registry.ts` | Builds the connector's `redirectUri` from the shared host in **every** region. |
| `packages/db/migrations/0066_shared_notion_connection_routing.sql` | The `notion_workspace_routes` directory, Global only. |
| `packages/db/migrations/0071_notion_webhook_setup_nonces.sql` | Short-lived setup nonces and their link to the active encrypted verification token. |
| `packages/db/migrations/0072_notion_connection_scope_split.sql` | Converts historical public-integration bot grants from personal to workspace scope without touching hosted-MCP rows. |
| `scripts/notion-webhook-setup.mjs` | Prepares a one-time subscription URL and copies the captured token without server-side plaintext output. |

## How it works

### Authorization

`ConnectionService.beginProvider` mints the OAuth state as
`<region>.<32 bytes of entropy>` for Notion alone, and stores the row in the
region that started the attempt. The authorize URL carries the shared redirect
URI, so Notion returns the user to `notion.rallywith.ai` whichever region they
belong to.

The connection scope chooses the provider protocol after that shared routing.
Any member may start a personal authorization: the adapter discovers the hosted
MCP authorization server, dynamically registers Rally, and uses authorization
code plus PKCE. A Rally owner or administrator may start the workspace public
integration authorization. Notion's required `owner=user` parameter on that
public flow identifies the approver, while the installed bot and selected pages
are the shared grant; the provider parameter never changes Rally's workspace
scope.

A successful personal MCP connection stores its DCR client and rotating tokens
only in the owning region and creates no webhook route. The official MCP server
is an on-demand user tool plane, not the public integration's bot subscription.

### Webhooks

The operator runs `pnpm notion:webhook:prepare`. It generates a 32-byte nonce,
stores only its SHA-256 hash and a 30-minute expiry in Global D1, and copies the
subscription URL to the local clipboard. The permanent URL still carries
`setup=`, because Notion cannot attach an operator header, but Cloudflare's URL
capture sees only a short-lived value that becomes useless on first use. The
command retires the previous current generation and inserts its replacement in
one D1 transaction; a partial unique index makes two current generations
impossible even when operators prepare concurrently.

Every later delivery is verified at Global against the stored token and the
expected integration ID, then routed on the `workspace_id` the verified envelope
carries. Exact bytes go to each active region for that Notion workspace; the
regional `ProviderWebhookService` verifies the signature again before it
normalizes, matches the delivery against its own connections by bot ID, and
persists the payload in its own R2. Normalized activity retains the workspace
connection scope and has no target user; the OAuth approver is not an activity
audience.

## Invariants

- **The redirect URI is identical in configured deployments.** Notion replays
  `redirect_uri` at the token exchange and rejects a mismatch, so a region that
  computed its own would fail every exchange. `notionCallbackUrl` is the only
  place it is built.

- **The region prefix selects a bridge and authorizes nothing.** The state row
  still lives in one region and is still consumed there. An attacker who rewrites
  the prefix reaches a region with no such row and gets `invalid_oauth_state`;
  treating the prefix as evidence of anything else would make a public redirect
  parameter into an authorization decision.

- **A retired route is answered, not retried.** `activeRegions` filtering would
  make "disabled" and "never registered" the same fact, and only one of them
  should ask Notion to come back. The route directory therefore reads status
  rather than filtering on it.

- **Configured deployments verify every delivery.** Global verifies to learn where a
  delivery goes; the owning region verifies again because a service binding is
  not a trust boundary. Removing the second check would make the bridge the only
  thing standing between a forged payload and a workspace's activity feed.

- **Routes are keyed on the Notion workspace, not on `provider_account_id`.**
  That column holds the installed bot, and a delivery names the workspace it
  happened in. The bot ID is what the *regional* service matches connections on,
  through `accessible_by`.

- **The workspace OAuth approver is not the execution principal.** Notion's public flow is
  user-authorized, but the returned bot performs API actions and Rally stores
  the grant as a workspace connection. Deriving Rally scope from the provider's
  `owner=user` field would turn an approval record into an authorization rule.
  The personal MCP flow is deliberately different: its Rally owner is the
  member who completed that personal authorization.

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

- **No reusable setup credential or verification token enters observability.**
  Cloudflare captures the full URL before application redaction, so the URL may
  carry only a short-lived nonce that is harmless after first use. The HMAC
  verification token is encrypted at rest and reaches plaintext only in Worker
  memory, the regional service binding, and the operator's clipboard.

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
| Delivery for a Notion workspace that has never been routed | `503 notion_route_pending`. Notion retries, by which time the OAuth callback has normally registered the route. |
| Delivery for a Notion workspace whose every route is disabled | `{accepted, activityCount: 0}`. Disabling a Rally connection does not uninstall the integration at Notion, so a retired workspace keeps delivering forever; retrying it would spend the full retry budget on every delivery, against the subscription every customer shares. |
| Setup challenge posted to a regional host instead of the ingress | `400 notion_setup_wrong_host`, naming the right URL. Only the ingress replicates the token, so accepting it elsewhere would answer 200 and leave every other region unable to verify anything. |
| Setup nonce missing, expired, already bound to another token, or superseded | `unauthorized`; no challenge row is inserted or replaced. Preparing another URL invalidates any earlier unconsumed one. |
| Token copy attempted before the current challenge finishes storage | The command refuses to copy. It joins the challenge to the one current consumed nonce and verifies the decrypted token against that nonce's token hash, so neither the previous subscription secret nor a partially stored replacement reaches the clipboard. |
| Signature invalid, or signed for another integration | `invalid_signature` / `unauthorized`, before the route directory is consulted and before any payload is stored. Not before *all* D1 access: the stored verification token is read first, because verifying is what makes the delivery's workspace readable. |
| Webhook body over `PROVIDER_WEBHOOK_MAX_BYTES` (2 MB default) | `payload_too_large`, before parsing. |
| Personal MCP connection succeeds while the route bridge is unavailable | The connection still succeeds; personal MCP has no webhook route to register. |

## Testing

`apps/api/test/notion-routing.test.ts` is the suite for this module —
`pnpm --filter @rally/api exec vitest run test/notion-routing.test.ts`. It uses
a hand-written D1 fake holding only `notion_workspace_routes`, and the service's
constructor seams (`completeInRegion`, `ingestInRegion`, `storeChallengeInRegion`,
`captureChallenge`, `verificationToken`) to keep credential decryption out of the
routing assertions. Two cases drive the real `createApp()` to prove the host gate
and the callback wiring, not just the helpers.

The traps, both from the same root — development has to point the ingress at a
locally reachable address, so the ingress and the regional API stop being
obviously different hosts:

- It also declines the region's own `PUBLIC_API_BASE_URL`. The case worth keeping
  covered is the app-level one: drive `createApp()` with the ingress and the API
  set to the same host and assert an ordinary route still answers. Asserting only
  on `/health` proves nothing, because `/health` is on the ingress allowlist.

Provider-side Notion webhook verification and normalization are covered by
`apps/api/test/provider-webhooks.test.ts` and
`packages/connectors/src/notion.test.ts`; this suite does not re-test them. The
former models nonce expiry, token binding, idempotent replay, rotation, and
supersession. `scripts/notion-webhook-setup.test.mjs` proves the D1 write contains
only a nonce hash and that encrypted rows decrypt to the clipboard value.

## Operations

`notion.rallywith.ai` must exist as a custom domain on `avalon-api-global`
before the connection is registered with Notion.

## Changelog

### 2026-08-19 — The shared ingress migration returns to its deployed filename

**What changed:** `0084_shared_notion_connection_routing.sql` is again
`0066_shared_notion_connection_routing.sql`, byte-identical to the copy on
`main`, restoring the documented duplicate-`0066` prefix.

**Considered and rejected:** Hand-inserting a `0084` row into each region's
`d1_migrations` ledger. That repairs two databases while leaving the rename to
break the next fresh region, and it normalizes editing production migration
state to match a file instead of the file matching production.

**Consequences:** Remote databases see nothing new for `0066`; only the truly
new migrations remain pending. A filename under `packages/db/migrations/` that
exists on `main` is deployed state and must never be renamed, renumbered, or
edited — the duplicate-prefix warning in
[`pull-requests.md`](pull-requests.md) exists precisely for this.

### 2026-08-12 — The shared callback admits personal hosted MCP OAuth, a user-approved install is one workspace bot grant, and existing bot routes keep their connection

**What changed:** Notion's region-routed callback now completes either a
personal official-MCP authorization or a workspace public-integration install.
Only the workspace branch creates, tests, or retires a webhook route.

The regional connection created after a routed Notion callback is now
workspace-scoped with no Rally user owner. The approving Notion identity
remains encrypted credential metadata, webhook activity has no personal target,
and only a Rally owner or administrator may start or complete the flow.

Historical Notion public-integration rows are migrated from personal to
workspace scope when they do not carry `notion.personal.mcp`.

**Why:** The two connections need different provider identities but Notion is
still one Rally connector with one registered callback. Treating every Notion
success as a bot install would put a personal MCP workspace ID into the Global
webhook directory and make route health part of a connection that receives no
webhooks.

Notion requires a user to approve public OAuth but returns an installed bot
that authors later API mutations. The ingress previously carried that grant
into a personal row and therefore routed shared workspace events to the
approver.

The historical bot grants already registered their Notion workspace route under
the earlier connection flow. Treating them as the new personal MCP credential
dialect broke refresh without creating a replacement route or authorization.

**Considered and rejected:** A second regional callback dedicated to MCP. It
would duplicate the routing and state-consumption path without changing where
the encrypted DCR client and tokens must land.

Making `owner=user` a Rally scope decision: it is provider protocol metadata,
while Rally's workspace principal is the authority boundary.

**Consequences:** Authorization routing is shared, while webhook routing remains
workspace-only. Any future Notion connection mode must declare explicitly
whether it creates provider ingress rather than inheriting that behavior from
the provider name.

For migrated rows the connection ID and existing Global route remain stable
while their regional authorization semantics become workspace-scoped. New
personal MCP connections create no route and are excluded by capability.

Shipped in the pull request for this change.

### 2026-08-12 — Subscription setup becomes one-time and locally retrievable

**Why:** Notion requires a manual paste of the token it posts to the endpoint,
while Rally's handler correctly refused to log or return that signing secret.
That left no way to finish verification. Logging it was rejected because the
token authenticates every future event and the repository retains Cloudflare
logs for 90 days. The old query guard was also reusable and therefore leaked as
a credential through Cloudflare's platform-level full-URL capture. A public
reveal endpoint would trade the missing workflow for a permanent remote secret
reader. Encrypted D1 storage plus local decryption solves the operator handoff;
token-bound, superseding nonces make the unavoidable query parameter safe after
its first request and preserve retry after a mid-capture failure.

### 2026-08-12 — A retired workspace is answered, the challenge has one door, and the bridges ship as a staged rollout

**What changed:** A delivery whose every route is disabled now returns
`{accepted, activityCount: 0}` instead of the retry-me 503, so the directory
reads route status rather than filtering on it. A `setup=` challenge posted to a
regional host is refused with `notion_setup_wrong_host` instead of being stored
there. The four `default*InRegion` helpers regained the
`AVALON_REGION === "global"` check the Linear equivalents carry.

`runbook.md` gained a three-stage bootstrap for the release that first ships
this module, and `Operations` above points at it. No code changed for that.

**Why:** The first two are consequences of one subscription serving every
customer, which is what makes this module different from the per-tenant
webhooks it was modelled on. Disabling a Rally connection does not uninstall
the integration at Notion, so a retired workspace keeps delivering with nothing
that will ever make its route active again; answering those with a 503 spends
the full retry budget on each one and risks Notion disabling the subscription
that every other customer depends on. And the challenge arrives exactly once:
the regional handler would have stored it and answered 200 without
replicating, which surfaces later as a total delivery failure for the region
that never got a copy — the failure the replication exists to prevent, reached
through the other door.

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
