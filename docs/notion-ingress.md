# Notion shared ingress

A Notion public connection accepts exactly one OAuth redirect URI and delivers
its webhook subscription to exactly one URL, for every Notion workspace that
installs it. Avalon's personal connection to Notion's official hosted MCP server
also uses the connector's registered redirect. Avalon runs two regional Workers.
This module is how both authorization modes, and the workspace mode's webhook,
serve both: `notion.rallywith.ai` is bound to the Global Worker, answers the
callback and webhook, and hands each to the region that owns the Avalon
workspace involved. Read it before changing Notion authorization, Notion webhook
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
| `apps/api/src/notion-regional-bridge.ts` | EU-side `WorkerEntrypoint`: completes callbacks, ingests forwarded bytes, stores the replicated challenge. |
| `apps/api/src/notion-routing-bridge.ts` | Global-side `WorkerEntrypoint` the EU Worker calls to register and retire routes. |
| `apps/api/src/lib/connector-registry.ts` | Builds the connector's `redirectUri` from the shared host in **both** regions. |
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
MCP authorization server, dynamically registers Avalon, and uses authorization
code plus PKCE. An Avalon owner or administrator may start the workspace public
integration authorization. Notion's required `owner=user` parameter on that
public flow identifies the approver, while the installed bot and selected pages
are the shared grant; the provider parameter never changes Avalon's workspace
scope.

The callback route reads the region from the state prefix and calls
`ConnectionService.completeProvider` — locally when the prefix says `global`,
over `EU_NOTION_BRIDGE` when it says `eu`. The token exchange, the credential
encryption, and the connection row all happen in the owning region; Global holds
none of them. The workspace connection row has `scope = 'workspace'` and no user owner;
the approving Notion user's identity stays in encrypted credential metadata.
Denials and failures route the same way, so a user who cancels in EU still lands
on their own region's attempt record.

On a successful **workspace** connection the owning region registers `notion_workspace_routes` through
`NotionRoutingService.registerConnection`, which writes locally in Global and
calls `GLOBAL_NOTION_ROUTER` from EU. A registration failure marks the connection
`error` with `notion_route_registration_failed` rather than leaving a connection
whose events can never be delivered.

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

Notion sends the one-time `verification_token` to that URL. Global binds the
current nonce to the first token hash it sees, encrypts the plaintext token under
its own key, and conditionally stores it only while that setup generation remains
current. It then replicates the plaintext and the nonce row's monotonic setup
generation to EU over the bridge, where EU rejects an older generation, then
encrypts the accepted token under *its* key with region-bound AAD.
The operator then runs `pnpm notion:webhook:copy-token`: it reads the ciphertext
and the current nonce binding through the Cloudflare D1 API, decrypts on the
operator's machine, verifies the plaintext hash against that binding, and pipes it
straight to the clipboard for Notion's verification dialog. It refuses both the
previous subscription's token and the brief claim-before-storage window. No server
log or API response exposes it. Both regions end up able to verify signatures
independently.

A retry carrying the same current nonce and token is idempotent. A different token
cannot reuse a consumed nonce, and preparing a new generation immediately
supersedes the old one. The encrypted-token upsert checks current ownership again
in its own SQL statement, so an older request paused after its claim cannot resume
after a newer request and restore the superseded signing secret.
The same generation travels with regional replication: if two Global requests
reach EU out of order, EU's conditional upsert retains the larger generation.

Every later delivery is verified at Global against the stored token and the
expected integration ID, then routed on the `workspace_id` the verified envelope
carries. Exact bytes go to each active region for that Notion workspace; the
regional `ProviderWebhookService` verifies the signature again before it
normalizes, matches the delivery against its own connections by bot ID, and
persists the payload in its own R2. Normalized activity retains the workspace
connection scope and has no target user; the OAuth approver is not an activity
audience.

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
- **The workspace OAuth approver is not the execution principal.** Notion's public flow is
  user-authorized, but the returned bot performs API actions and Avalon stores
  the grant as a workspace connection. Deriving Avalon scope from the provider's
  `owner=user` field would turn an approval record into an authorization rule.
  The personal MCP flow is deliberately different: its Avalon owner is the
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
| `EU_NOTION_BRIDGE` unbound or EU unavailable | `503 notion_region_unavailable`. The authorization fails closed; the user retries. |
| Delivery for a Notion workspace that has never been routed | `503 notion_route_pending`. Notion retries, by which time the OAuth callback has normally registered the route. |
| Delivery for a Notion workspace whose every route is disabled | `{accepted, activityCount: 0}`. Disabling an Avalon connection does not uninstall the integration at Notion, so a retired workspace keeps delivering forever; retrying it would spend the full retry budget on every delivery, against the subscription every customer shares. |
| Setup challenge posted to a regional host instead of the ingress | `400 notion_setup_wrong_host`, naming the right URL. Only the ingress replicates the token, so accepting it elsewhere would answer 200 and leave the other region unable to verify anything. |
| Setup nonce missing, expired, already bound to another token, or superseded | `unauthorized`; no challenge row is inserted or replaced. Preparing another URL invalidates any earlier unconsumed one. |
| Token copy attempted before the current challenge finishes storage | The command refuses to copy. It joins the challenge to the one current consumed nonce and verifies the decrypted token against that nonce's token hash, so neither the previous subscription secret nor a partially stored replacement reaches the clipboard. |
| Signature invalid, or signed for another integration | `invalid_signature` / `unauthorized`, before the route directory is consulted and before any payload is stored. Not before *all* D1 access: the stored verification token is read first, because verifying is what makes the delivery's workspace readable. |
| Challenge replication to EU fails | The whole setup request fails. Re-sending the verification from Notion's dashboard is idempotent: Global recognizes the same token and replicates again. |
| Webhook body over `PROVIDER_WEBHOOK_MAX_BYTES` (2 MB default) | `payload_too_large`, before parsing. |
| `GLOBAL_NOTION_ROUTER` unavailable from EU at connect time | Connection is marked `error` with `notion_route_registration_failed`; a connection test re-registers it. |
| Personal MCP connection succeeds while the route bridge is unavailable | The connection still succeeds; personal MCP has no webhook route to register. |

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
`packages/connectors/src/notion.test.ts`; this suite does not re-test them. The
former models nonce expiry, token binding, idempotent replay, rotation, and
supersession. `scripts/notion-webhook-setup.test.mjs` proves the D1 write contains
only a nonce hash and that encrypted rows decrypt to the clipboard value.

## Regional impact

Global owns `notion_workspace_routes`, the used rows in
`notion_webhook_setup_nonces`, and the encrypted Notion verification token, which
is also replicated and independently encrypted in EU. The nonce table exists in
both schemas because regional migrations remain identical, but EU never writes it
in production. Authorization codes and webhook bytes for EU workspaces transit
Global and are persisted only in EU. This is the same concession
`regionalization.md` already records for the shared GitHub, Linear, and Slack
ingresses, extended to the OAuth code because Notion allows only one redirect URI.

## Operations

`notion.rallywith.ai` must exist as a custom domain on `avalon-api-global`
before the connection is registered with Notion.

**The release that first ships this module needs the three-stage Worker rollout
in [`runbook.md`](runbook.md), by hand.** The two bridges are a circular pair —
Global binds `EU_NOTION_BRIDGE` to an entrypoint EU does not export yet, and EU
binds `GLOBAL_NOTION_ROUTER` to one Global does not export yet — so neither
region can be deployed with its full configuration first, and the automatic
EU-then-Global deployment cannot land this change. Both Workers need
`NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`, and
`NOTION_INTEGRATION_ID` — the *same* values, since there is one connection. Apply
migration `0071_notion_webhook_setup_nonces.sql`, then use
`pnpm notion:webhook:prepare` and `pnpm notion:webhook:copy-token` for the
subscription handshake. Registration steps are in
[`provider-apps.md`](provider-apps.md).

## Changelog

### 2026-08-19 — The shared ingress migration returns to its deployed filename

**What changed:** `0084_shared_notion_connection_routing.sql` is again
`0066_shared_notion_connection_routing.sql`, byte-identical to the copy on
`main`, restoring the documented duplicate-`0066` prefix.

**Why:** The 2026-08-18 rename below rested on a false premise — "this branch
has not shipped." The migration *had* shipped: `main` carried it and both
production databases had applied it under the `0066` filename. Wrangler tracks
applied migrations by full filename, so the rename made production treat the
same DDL as a new pending migration, and the first automated deploy failed on
EU with `table notion_workspace_routes already exists` before any Worker
deployed. Duplicate numeric prefixes are an accepted, documented condition in
this repository (`0039`, `0041`, `0046`); an edited deployed filename is not.

**Considered and rejected:** Hand-inserting a `0084` row into each region's
`d1_migrations` ledger. That repairs two databases while leaving the rename to
break the next fresh region, and it normalizes editing production migration
state to match a file instead of the file matching production.

**Consequences:** Remote databases see nothing new for `0066`; only the truly
new migrations remain pending. A filename under `packages/db/migrations/` that
exists on `main` is deployed state and must never be renamed, renumbered, or
edited — the duplicate-prefix warning in
[`pull-requests.md`](pull-requests.md) exists precisely for this.

### 2026-08-18 — Shared ingress migration receives a unique sequence

**What changed:** The unshipped shared Notion routing migration moved from the
duplicate `0066` prefix to `0084`.

**Why:** Duplicate numeric prefixes make deployment ordering and operator
reporting ambiguous even when filename sorting is deterministic.

**Considered and rejected:** Leaving the collision documented. This branch has
not shipped, so preserving that historical number has no compatibility value.

**Consequences:** Apply `0084_shared_notion_connection_routing.sql`; no data
transform or compatibility alias is required.

### 2026-08-12 — Existing bot routes retain their migrated connection

**What changed:** Historical Notion public-integration rows are migrated from
personal to workspace scope when they do not carry `notion.personal.mcp`.

**Why:** Those bot grants already registered their Notion workspace route under
the earlier connection flow. Treating them as the new personal MCP credential
dialect broke refresh without creating a replacement route or authorization.

**Considered and rejected:** Re-registering every route in the migration. EU D1
cannot write the Global route directory from SQL, and the routes already exist
from original authorization; connection tests remain the repair path for a
missing route.

**Consequences:** The connection ID and existing Global route remain stable
while its regional authorization semantics become workspace-scoped. New
personal MCP connections create no route and are excluded by capability.

Shipped in the pull request for this change.

### 2026-08-12 — The shared callback also admits personal hosted MCP OAuth

**What changed:** Notion's region-routed callback now completes either a
personal official-MCP authorization or a workspace public-integration install.
Only the workspace branch creates, tests, or retires a webhook route.

**Why:** The two connections need different provider identities but Notion is
still one Avalon connector with one registered callback. Treating every Notion
success as a bot install would put a personal MCP workspace ID into the Global
webhook directory and make route health part of a connection that receives no
webhooks.

**Considered and rejected:** A second regional callback dedicated to MCP. It
would duplicate the routing and state-consumption path without changing where
the encrypted DCR client and tokens must land.

**Consequences:** Authorization routing is shared, while webhook routing remains
workspace-only. Any future Notion connection mode must declare explicitly
whether it creates provider ingress rather than inheriting that behavior from
the provider name.

Shipped in the pull request for this change.

### 2026-08-12 — User-approved OAuth installs one workspace bot grant

**What changed:** The regional connection created after a routed Notion callback
is now workspace-scoped with no Avalon user owner. The approving Notion identity
remains encrypted credential metadata, webhook activity has no personal target,
and only an Avalon owner or administrator may start or complete the flow.

**Why:** Notion requires a user to approve public OAuth but returns an installed
bot that authors later API mutations. The ingress previously carried that grant
into a personal row and therefore routed shared workspace events to the approver.
Making `owner=user` an Avalon scope decision was rejected: it is provider
protocol metadata, while Avalon's workspace principal is the authority boundary.

### 2026-08-12 — Subscription setup becomes one-time and locally retrievable

**What changed:** The reusable Worker setup secret was replaced by a 30-minute
nonce stored only as a hash. Its first challenge atomically binds the nonce to
the verification token; retries must carry that pair, and consuming a newer
nonce supersedes older pairs. Operator commands now copy the prepared URL and
decrypt the captured token directly to the local clipboard. Preparation is one
transaction with a unique current-generation constraint, challenge storage is
conditional on that generation still being current, and token copying proves its
ciphertext belongs to the current consumed nonce. The generation is replicated to
EU so an older cross-region call cannot arrive last and restore the old token there.

**Why:** Notion requires a manual paste of the token it posts to the endpoint,
while Avalon's handler correctly refused to log or return that signing secret.
That left no way to finish verification. Logging it was rejected because the
token authenticates every future event and the repository retains Cloudflare
logs for 90 days. The old query guard was also reusable and therefore leaked as
a credential through Cloudflare's platform-level full-URL capture. A public
reveal endpoint would trade the missing workflow for a permanent remote secret
reader. Encrypted D1 storage plus local decryption solves the operator handoff;
token-bound, superseding nonces make the unavoidable query parameter safe after
its first request and preserve retry after a mid-capture failure.

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

**What changed:** `runbook.md` gained a three-stage bootstrap for the release
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
