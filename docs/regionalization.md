# Regionalization

Avalon runs the same Worker source twice — as `avalon-api-global` and
`avalon-api-eu` — with separate D1, R2, Durable Object namespaces, keys, and
secrets. A workspace picks one region when it is created and never moves. This
document owns that boundary: which single endpoint every user still shares, what
is allowed to cross, how it crosses, and what the isolation is and is not a claim
about.

Read it before touching anything cross-region — identity and onboarding, a
provider ingress that has one callback URL for both regions, the Worker RPC
bridges, or any code that selects a Durable Object namespace.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/regional-identity-bridge.ts` | Minimal onboarding operations: membership and invitation discovery, activation, acceptance. |
| `apps/api/src/github-regional-bridge.ts`, `github-routing-bridge.ts` | Verified GitHub setup operations and exact signed webhook bytes; the installation-to-region directory. |
| `apps/api/src/notion-regional-bridge.ts`, `notion-routing-bridge.ts` | The Notion authorization code and signed deliveries; the Notion-workspace-to-region directory. |
| `apps/api/src/slack-regional-bridge.ts`, `slack-routing-bridge.ts` | Parsed Slack deliveries; the opaque team-to-region directory. |
| `apps/api/src/linear-regional-bridge.ts`, `linear-routing-bridge.ts` | The same pair for Linear. |
| `apps/api/src/workstream-email-routing-bridge.ts` | The one Global reservation registry for friendly work-stream addresses. |
| `apps/api/src/inbound-email-regional-bridge.ts` | One verified Resend event handed to the owning data plane. |
| `apps/api/src/lib/rpc-contracts.ts` | The schema every bridge argument is parsed against at the hop. |
| `apps/api/src/lib/durable-object-namespace.ts` | The shared helper that selects a namespace, pinning EU with `jurisdiction("eu")`. |
| `apps/api/src/lib/region-routed-state.ts` | Region-prefixed provider state, so a callback knows where it started. |
| `apps/api/src/env.ts` | `assertEnvContract` — region-scoped, not just environment-scoped. |
| `apps/api/wrangler.global.jsonc`, `apps/api/wrangler.eu.jsonc` | The two deployments and their bindings. |

## How it works

### The V1 boundary

Every user signs in once through the Global Avalon identity endpoint. After
authentication, the Global control plane uses an authenticated named Worker RPC
binding to discover workspace memberships and email-bound pending invitations in
Global and EU. An existing member activates that workspace immediately. A user
with invitations may accept or decline them. Only a user with no workspace and no
invitations sees organization setup, where they choose `Global` or
`European Union`. A workspace persists that selection and it is immutable in V1.

The initial identity-only Global bootstrap session cannot access workspace data.
Activation, creation, or invitation acceptance mints a fresh session in the
workspace's owning region, commits an opaque Global workspace binding, and revokes
the bootstrap session. The desktop then stores that regional API base URL and does
not query the other region for ordinary workspace requests. Invitation acceptance
remains email-bound, expiring, single-use, idempotent, and server-authorized; no
second regional Google OAuth flow exists.

### Deployments

The same Worker source is deployed twice:

| Binding | Global | European Union |
| --- | --- | --- |
| Worker | `avalon-api-global` | `avalon-api-eu` |
| API | `api.with-avalon.com` | `eu.api.with-avalon.com` |
| D1 | global database | EU-jurisdiction database |
| Agent memory vectors | `avalon-global-memory` Vectorize index | `avalon-eu-memory` Vectorize index |
| R2 | global bucket | EU-jurisdiction bucket |
| Durable Objects | global namespace calls | namespace calls pinned with `jurisdiction("eu")` |
| Secrets | global key set | independent EU key set |
| Identity onboarding | canonical platform identity and opaque workspace binding | regional membership/invitation operations exposed only by named Worker RPC |
| GitHub App ingress | signature verification and installation-to-region directory | exact signed delivery forwarded through named Worker RPC only when connected in EU |
| Notion connection ingress | one redirect URI and one webhook subscription, plus the Notion-workspace-to-region directory | authorization code and exact signed delivery forwarded through named Worker RPC; token exchange, credentials, and payloads stay in EU |
| Work-stream email registry | one authoritative, case-insensitive reservation table for every region | no local allocator; reservations and status changes use the Global named RPC binding |

Queues and Workflows carry region plus opaque record IDs, never sensitive payload
bodies. Every service receives a fixed regional dependency container; repositories
cannot choose a region from user-controlled object IDs.

### The shared ingresses

Four providers cannot address a region, so a Global host answers for both and
routes:

- **GitHub** — the smart ingress is host-gated at `github.with-avalon.com`. It
  verifies GitHub's signature before parsing or routing, consults the
  installation-to-region directory, and forwards the exact signed bytes over RPC
  when the installation is connected in EU. It never exposes its EU bridge as
  HTTP. GitHub OAuth callbacks, connector credentials, raw payload persistence,
  resources, activities, and automation processing all stay in the connected
  workspace region.
- **Notion** — Notion issues one redirect URI and one webhook URL per public
  connection and cannot tell which region a Notion workspace belongs to, so
  `notion.with-avalon.com` answers both for Global and EU. The host is gated to
  the callback, the webhook, and health. OAuth state carries a `<region>.` routing
  prefix that authorizes nothing — the pending authorization, its verifier, and its
  capabilities never leave the region that started it.
  [`notion-ingress.md`](notion-ingress.md) owns this design.
- **Slack** — the shared ingress verifies signed bytes in Global, consults only the
  opaque team route, and hands the parsed delivery directly to the owning regional
  service, which persists and queues the ingress job before acknowledgement.
  Tokens, ingress jobs, user links, Agent sessions, work streams, and outputs stay
  regional.
- **Inbound email** — Resend Receiving terminates at the Global ingress because a
  receiving domain has one catch-all webhook. Global retains only the
  friendly-address route and the delivery receipt. EU message bodies are retrieved
  with the EU Worker and persisted only in EU R2/D1.

Work-stream email *names* have one Global reservation registry for all regions:
Global reserves locally, and every non-Global Worker calls the named Global
router. See [`workstream-email-addresses.md`](workstream-email-addresses.md).

## Invariants

- **Global reaches EU only through named Worker RPC service bindings.** The EU
  regional identity bridge is a named service entrypoint, not a public HTTP route,
  and no bridge is ever exposed as one. An HTTP internal bridge would put the
  region boundary on the open internet with nothing but a shared secret on it.
- **Every bridge parses its argument at the hop**, against a schema in
  `apps/api/src/lib/rpc-contracts.ts`. A service binding is not an HTTP boundary,
  so nothing else checked what arrived: the interfaces the bridges declared are
  erased at build time, and `region` and `workspaceId` are exactly the fields that
  decide which side of this boundary a record lands on. Batch methods are bounded
  by one constant shared with the service's own bulk limit, so a batch cannot
  behave differently depending on which region it started in.
- **A rejection carries the offending field paths and never the values.** On this
  surface those values include OAuth state and provider identifiers, and the bridge
  serializers drop the details rather than let them cross back to a client.
- **Identity OAuth and desktop-ticket redemption occur only through the Global
  endpoint**, and yield an identity-only bootstrap session. A bootstrap session has
  no workspace ID and cannot authorize workspace data access.
- **Session claims and workspace rows must agree on region**, and a target-region
  session replaces the Global bootstrap session after activation, creation, or
  invitation acceptance. A session whose claim disagrees with its row is a
  cross-region read with a valid signature on it.
- **At most one active platform workspace binding may exist for an identity.**
  Simultaneous memberships in both regions fail closed for operator
  reconciliation.
- **Repositories never choose a region from a user-controlled object ID.** Every
  service receives a fixed regional dependency container; the region comes from the
  deployment and the session, never from the request body.
- **All WorkstreamRoom and WorkspaceScheduler call sites select the namespace
  through the shared region helper**, and EU IDs are created and resolved with
  `jurisdiction("eu")`. A namespace selected by hand in one call site is an EU
  object created outside the EU jurisdiction.
- **Regional D1 is never an allocation fallback for a work-stream email name.**
  Every non-Global Worker calls the named Global router and fails closed without
  it; disabled and deleted names remain Global tombstones forever.
- **Connector and harness records remain in the workspace region** even when their
  providers process data elsewhere.
- **Logs include the region without copying content.**
- **Deployment configuration must fail when `AVALON_REGION` and the selected
  Wrangler environment disagree.**

## Boundary

This document owns the region boundary itself: what is Global, what is regional,
what crosses, and by which mechanism. It does not own the subsystems that happen
to cross it.

| For | Read |
| --- | --- |
| The whole system's shape, of which this is one axis | [`architecture.md`](architecture.md) |
| Which tables hold what, per region | [`data-model.md`](data-model.md) |
| Trust boundaries and credential handling | [`security.md`](security.md) |
| The Notion single-ingress design in full | [`notion-ingress.md`](notion-ingress.md) |
| The Global address registry and its tombstones | [`workstream-email-addresses.md`](workstream-email-addresses.md) |
| Provider app registrations and their callbacks | [`provider-apps.md`](provider-apps.md) |
| Deploying and verifying both regions | [`runbook.md`](runbook.md) |

A module document that touches identity, the Global registry, a cross-region
bridge, provider ingress routing, or residency carries its own **Regional impact**
section per [`module-documents.md`](module-documents.md) rather than adding a case
here.

## Failure modes and limits

- **`/health` asserts the environment contract itself and blocks on it**, so a
  Worker that cannot serve a request cannot report healthy. The route stays exempt
  from the entrypoint's own assertion — it catches the failure and describes it,
  naming the offending keys that the `service_misconfigured` body deliberately
  withholds.
- **Secrets required at the entrypoint are scoped by region, not only by
  environment.** Google identity OAuth is required in Global and must not be
  required in EU, which by design never carries it. A contract that demanded it
  there failed the EU Worker's own env check on every request, queue batch, and
  cron tick, while `/health` — exempt precisely so it can report such a fault —
  kept answering `ok`. An unrecognized region is held to every rule rather than
  none.
- **A Notion delivery for a workspace with no active route is refused with a 503**
  rather than retained in Global.
- **Pending cross-region operations are idempotent and fail closed after ambiguous
  RPC outcomes.** Their diagnostic deadline never authorizes automatic reuse: later
  discovery reconciles a committed regional membership, while a genuinely orphaned
  reservation requires operator verification and cleanup.
- **Cross-region workspace-content access is not implemented.** A caller that needs
  it has no degraded path; it has no path at all.
- **The shared ingresses necessarily receive webhook bytes transiently** before
  regional routing. That is inherent to a provider that offers one callback URL,
  not a gap to be closed in code.
- **Enterprise-dedicated Workers, databases, buckets, keys, retention, and
  observability** remain an extension point in the repository and service
  interfaces, not a V1 feature.

## Testing

Under `apps/api`, run with `pnpm --filter @avalon/api exec vitest run <path>`
(paths are package-relative):

| Suite | Covers |
| --- | --- |
| `test/rpc-contracts.test.ts` | Every bridge argument schema, including that a rejection names paths and not values. |
| `test/env-contract.test.ts` | The region-scoped entrypoint contract — that Global requires what EU must not. |
| `test/health-env-contract.test.ts` | That `/health` blocks on the contract and reports the offending keys. |
| `test/organization-region-bindings.test.ts` | Activation, creation, acceptance, and the single-active-binding rule. |
| `test/platform-onboarding.test.ts` | Bootstrap-session limits and cross-region discovery. |
| `test/notion-routing.test.ts` | The region-prefixed OAuth state and the unrouted-delivery refusal. |
| `test/workstream-email-address.test.ts` | The Global reservation registry and its fail-closed behavior. |

Both Wrangler dry-run builds run in CI and are what catch a binding that exists in
one deployment's configuration and not the other — no Vitest suite reads
`wrangler.global.jsonc` or `wrangler.eu.jsonc`. Locally, `pnpm dev:api:local` starts both regions and
`pnpm health:regions` checks the hosted ones; see
[`dev-environment.md`](dev-environment.md) and [`runbook.md`](runbook.md).

## Security and trust model

This prototype provides logical routing and storage isolation. **It is not
marketed as a guarantee that every byte is processed exclusively in the EU.** The
Global identity control plane retains the platform identity and profile needed for
login and an opaque EU workspace locator, and transiently receives minimal EU
membership and invitation summaries during onboarding; it does not receive EU
workspace content. The shared provider ingresses transiently receive webhook bytes
before regional routing, and — for Notion alone, whose provider allows one redirect
URI — a short-lived, single-use OAuth authorization code.

Complete regional assurance requires verifying Cloudflare Queue, Workflow, and
observability behavior — including where Workers Logs and Workers Traces store EU
request metadata, which is pinned to no jurisdiction the way the region's D1, R2,
Durable Objects, and its Logpush destination bucket are — applying applicable
Regional Services and metadata controls, confirming LLM and connector provider
commitments, and establishing contractual processing terms.

## Changelog

No entries yet. This document predates the changelog rule in
[`module-documents.md`](module-documents.md#starting-one), and the reasoning behind
the boundary described above — beyond the reasons already written inline — was not
recorded here and was not reconstructed. `git log` and the PRDs under `docs/PRDs/`
are what exist. The next substantial change to the region boundary starts the
record, and that entry is that change, written in full.
