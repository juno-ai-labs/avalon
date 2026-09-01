# Regionalization

Rally runs the same Worker source twice — as `avalon-api-global` and
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
| `apps/api/src/telemetry-regional-bridge.ts`, `telemetry-control-bridge.ts` | Validated Global-to-EU onboarding/outcome projections and narrow EU-to-Global capability/preference control commands. They are not general event-forwarding bridges. |
| `apps/api/src/routes/telemetry.ts`, `apps/api/src/telemetry/` | Immediate route bootstrap, regional acceptance, EU internal sink, and Global PostHog delivery. |
| `apps/site/src/telemetry.ts` | Uses the content-free Cloudflare route before choosing a persistent Global or page-scoped EU anonymous identity. |
| `apps/api/src/lib/rpc-contracts.ts` | The schema every bridge argument is parsed against at the hop. |
| `apps/api/src/lib/durable-object-namespace.ts` | The sole product-object resolver: US/EU namespace restriction, persisted workspace affinity, explicit non-workspace fallback, and in-object jurisdiction assertion. |
| `scripts/eslint-rules/durable-object-region-routing.mjs` | Rejects direct or aliased Durable Object namespace routing outside that resolver. |
| `apps/api/src/lib/region-routed-state.ts` | Region-prefixed provider state, so a callback knows where it started. |
| `apps/api/src/env.ts` | `assertEnvContract` — region-scoped, not just environment-scoped. |
| `apps/api/src/services/terminal/contract.ts`, `daytona-provider.ts` | Independent regional Terminal capability gate and Daytona target/credential boundary. |
| `apps/api/wrangler.global.jsonc`, `apps/api/wrangler.eu.jsonc` | The two deployments and their bindings. |

## How it works

### The V1 boundary

Every user signs in once through the Global Rally identity endpoint. After
authentication, the Global control plane uses an authenticated named Worker RPC
binding to discover workspace memberships and email-bound pending invitations in
Global and EU. An existing member activates a workspace immediately. A user
with invitations may accept or decline them. Only a user with no workspace and no
invitations sees workspace setup, where they choose `Global` or
`European Union`. A workspace persists that selection and it is immutable in V1.

The initial identity-only Global bootstrap session cannot access workspace data.
Activation, creation, or invitation acceptance mints a fresh session in the
workspace's owning region and commits an opaque Global workspace binding. The
desktop retains the bootstrap session for future discovery beside one credential
per activated workspace. Each regional credential addresses only its own API;
ordinary workspace requests never query another region. Invitation acceptance
remains email-bound, expiring, single-use, idempotent, and server-authorized; no
second regional Google OAuth flow exists.

After the regional authority commits an invitation creation, revocation,
acceptance, or decline, it emits one idempotent `workspace_invitation_terminal`
observation in that invitation's region. The event keeps only the opaque
invitation ID, role, terminal action, delivery-result class, and bounded elapsed
time; it never contains the invited address, workspace name, link, or token.
Acceptance is attributed to the accepting member after the regional membership
write, while administrator actions are attributed to that administrator.

### Deployments

The same Worker source is deployed twice:

| Binding | Global | European Union |
| --- | --- | --- |
| Worker | `avalon-api-global` | `avalon-api-eu` |
| API | `api.rallywith.ai` | `eu.api.rallywith.ai` |
| D1 | global database | EU-jurisdiction database |
| Agent memory vectors | `avalon-global-memory` Vectorize index | `avalon-eu-memory` Vectorize index |
| R2 | global bucket | EU-jurisdiction bucket |
| Inference lakehouse | Global payload archive, Queue, Pipeline stream/sink, and default-jurisdiction R2 Data Catalog | Intentionally disabled; EU inference is not archived or exported for analytics |
| Telemetry R2 | dedicated `avalon-global-telemetry` bucket | dedicated `avalon-eu-telemetry` bucket with EU jurisdiction |
| Durable Objects | `jurisdiction("us")`, workspace affinity `wnam` or `enam` | `jurisdiction("eu")`, workspace affinity `weur` or `eeur` |
| Secrets | global key set | independent EU key set |
| Identity onboarding | canonical platform identity and opaque workspace binding | regional membership/invitation operations exposed only by named Worker RPC |
| GitHub App ingress | signature verification and installation-to-region directory | exact signed delivery forwarded through named Worker RPC only when connected in EU |
| Notion connection ingress | one redirect URI and one webhook subscription, plus the Notion-workspace-to-region directory | authorization code and exact signed delivery forwarded through named Worker RPC; token exchange, credentials, and payloads stay in EU |
| Work-stream email registry | one authoritative, case-insensitive reservation table for every region | no local allocator; reservations and status changes use the Global named RPC binding |
| Terminal workspaces | independently gated; Daytona `us` target; regional D1/R2/GitHub App services | independently gated on the same Daytona `us` environment; Rally records stay in EU |
| Product-flag delivery | Ace reads Global D1 and sends opaque workspace IDs to the Global product-flag Queue | Ace reads EU D1 and sends opaque workspace IDs to the EU product-flag Queue; the EU Worker alone addresses EU WorkspaceDOs |

Queues and Workflows carry region plus opaque record IDs, never sensitive payload
bodies. Every service receives a fixed regional dependency container; repositories
cannot choose a region from user-controlled object IDs.

Global inference analytics follows that rule by archiving the sensitive record
in the Global payload bucket first and putting only its object key, byte count,
and SHA-256 on the Global Queue. The Global Worker validates and sends the
record through its generated Pipeline stream binding into R2 Data Catalog. EU
inference analytics are intentionally deferred because Cloudflare Data Catalog
cannot target an EU-jurisdiction bucket and the direct R2 Pipeline alternative
requires a separate interactive credential lifecycle. The EU Worker returns
before archive staging and has no inference Queue or Pipeline binding; it never
falls back to the Global table.
[`inference-lakehouse.md`](inference-lakehouse.md) owns the full record and
provisioning contract.

Ace is the one internal control plane that reads both regional workspace
directories. An Access-authorized directory search transiently brings matching
EU names, full email addresses, workspace names, slugs, and opaque IDs into the
shared Ace Worker and operator's browser; Ace neither persists those results nor
writes names or full addresses to Flagship. Its shared change Queue carries only
a product flag key. The Ace consumer reads workspace IDs directly from each D1
and emits the key plus opaque workspace ID to that region's Queue. From there
the regional API and WorkspaceDO evaluate against regional
identity/membership data. Effective values, memberships, product content, and
socket state never cross through Ace; the one global Flagship application sees
only the already-approved targeting attributes listed in
[`feature-flags.md`](feature-flags.md).

### The shared ingresses

Five providers cannot address a region, so a Global host answers for both and
routes:

- **GitHub** — the smart ingress is host-gated at `github.rallywith.ai`. It
  verifies GitHub's signature before parsing or routing, consults the
  installation-to-region directory, and forwards the exact signed bytes over RPC
  when the installation is connected in EU. It never exposes its EU bridge as
  HTTP. GitHub OAuth callbacks, connector credentials, raw payload persistence,
  resources, activities, and automation processing all stay in the connected
  workspace region.
- **Notion** — Notion issues one redirect URI and one webhook URL per public
  connection and cannot tell which region a Notion workspace belongs to, so
  `notion.rallywith.ai` answers both for Global and EU. The host is gated to
  the callback, the webhook, and health. OAuth state carries a `<region>.` routing
  prefix that authorizes nothing — the pending authorization, its verifier, and its
  capabilities never leave the region that started it.
  [`notion-ingress.md`](notion-ingress.md) owns this design.
- **Slack** — the shared ingress verifies signed bytes in Global, consults only the
  opaque team route, and hands the parsed delivery directly to the owning regional
  service, which persists and queues the ingress job before acknowledgement.
  Tokens, ingress jobs, user links, Agent sessions, work streams, and outputs stay
  regional.
- **Linear** — one public app registers both regional OAuth callbacks, so consent
  is never shared, but it has a single webhook. `linear.rallywith.ai` verifies
  the exact signed body and timestamp, reads only the organization routing key, and
  forwards the untouched bytes over `EU_LINEAR_BRIDGE` when the organization is
  connected in EU, where the signature is verified again before persistence. A
  delivery for an organization with no route is refused retryably rather than
  retained in Global. [`linear-integration.md`](linear-integration.md) owns the
  contract.
- **Inbound email** — Resend Receiving terminates at the Global ingress because a
  receiving domain has one catch-all webhook. Global retains only the
  friendly-address route and the delivery receipt. EU message bodies are retrieved
  with the EU Worker and persisted only in EU R2/D1.

Work-stream email *names* have one Global reservation registry for all regions:
Global reserves locally, and every non-Global Worker calls the named Global
router. See [`workstream-email-addresses.md`](workstream-email-addresses.md).

### Telemetry before and after workspace selection

Telemetry is routed immediately; there is no region-pending holding area. Once a
workspace exists, its immutable binding is authoritative. During onboarding,
before a user has selected a workspace region, the Global bootstrap endpoint uses
Cloudflare's country signal only to classify the anonymous login epoch as EU or
Global. An affirmative EU country routes EU-eligible semantic events through the
named `EU_TELEMETRY_BRIDGE` and prevents Crashpad from saving a pre-region dump.
Non-EU, missing, malformed, failed, and timed-out signals route to Global. Neither
the country nor IP address is retained.

The route is attached to an event when it is created. A later explicit selection
affects future events and crash generations only: nothing is moved, replayed, or
relabelled across regions. Global can retain and deliver its approved product and
diagnostic records to the US PostHog project. EU retains its semantic projection,
raw crashes, sanitized reports, symbols, and source maps in EU regional D1,
dedicated EU R2, and EU-pinned processing; it has no PostHog token or Analytics
Engine telemetry dataset. Accepted Global semantic events also project through a
Global Queue/Pipeline into `avalon.analytics_events`; EU has no equivalent
producer, binding, catalog, or Global fallback. The account preference crosses by an opaque handle so
Global can remain the canonical identity plane without receiving an EU database
identifier. Capability verification and journey closure also use that narrow
control RPC: the signing key stays in Global, and EU receives only the fixed
route/epoch control result. [`telemetry.md`](telemetry.md) owns the complete
mechanism.

The public site asks the same Global edge for a content-free route before it
chooses browser identity. A Global page may reuse one first-party random epoch
across page loads. An affirmative EU page uses a new in-memory epoch and never
reads or writes a persistent analytics identifier. The later capability exchange
still fixes the route and the event still crosses only the named EU bridge. A
route lookup creates no onboarding journey row and retains neither country nor IP.
See [`public-site-telemetry.md`](public-site-telemetry.md).

## Invariants

- **Product runtimes reach EU only through named Worker RPC service bindings.**
  Two Access-gated administrative surfaces are explicit exceptions. Ace has a
  direct EU D1 binding for transient user/workspace search and flag fan-out
  enumeration. The engineering MCP uses a named regional API entrypoint to run
  deliberate Durable Object SQLite inspection and can return EU product content
  transiently to an admitted operator; it never persists or logs query material.
  The EU
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
- **Session claims and workspace rows must agree on region**, and every
  target-region session is stored beside the Global bootstrap session after
  activation, creation, or invitation acceptance. A session whose claim
  disagrees with its row is a
  cross-region read with a valid signature on it.
- **An external workspace target is routing context, never regional authority.**
  The desktop may use `(region, workspace_id)` to select which stored credential
  should answer an explicit link, but the owning regional Worker must still mint
  or refresh that session and authorize every request. A missing or refused target
  never falls back across regions.
- **A platform identity may have one active binding per workspace, across both
  regions.** Placement affinity is per `(platform_user_id, region)` and adding
  an EU route never rewrites the Global route or vice versa.
- **Repositories never choose a region from a user-controlled object ID.** Every
  service receives a fixed regional dependency container; the region comes from the
  deployment and the session, never from the request body.
- **Every workspace-scoped Rally Durable Object stub is created by
  `durableObjectStubForWorkspace`.** Staging and production derive IDs from
  `jurisdiction("us")` for Global and `jurisdiction("eu")` for EU, then apply
  the affinity persisted by the workspace's Global binding and regional D1 row.
  Creation splits Global at 100°W and EU at 15°E to map request longitude to
  `wnam`/`enam` or `weur`/`eeur`; only
  migrations, background-created workspaces, and missing request metadata use
  the western fallback. Non-workspace regional singletons use a separate
  explicit fallback resolver. ESLint rejects direct/aliased namespace routing
  and the low-level region-only resolver. Each product object also checks
  `ctx.id.jurisdiction` at construction and fails closed on a mismatch.
- **Regional D1 is never an allocation fallback for a work-stream email name.**
  Every non-Global Worker calls the named Global router and fails closed without
  it; disabled and deleted names remain Global tombstones forever.
- **Connector and harness records remain in the workspace region** even when their
  providers process data elsewhere.
- **Logs include the region without copying content.**
- **Deployment configuration must fail when `AVALON_REGION` and the selected
  Wrangler environment disagree.**
- **Telemetry never changes an accepted row's region.** Login linking, workspace
  selection, retries, support access, and replay preserve the route fixed at event
  or crash-generation creation.
- **EU telemetry has no Global destination fallback.** An unavailable EU bridge,
  bucket, database, or processor fails the telemetry operation; it never moves the
  payload to Global or PostHog.
- **Telemetry has exactly two directional RPC surfaces.** Global-to-EU carries a
  validated event projection. EU-to-Global carries only opaque preference
  mutation or capability authorization/closure commands; it never carries an EU
  event, dump, regional analytics identity, or destination credential.
- **Terminal capability is declared independently per Rally region against one
  Daytona environment.** Both checked-in Workers use `DAYTONA_TARGET=us`. Rally
  Terminal rows, resource bytes, and GitHub tokens still do not cross regions;
  sandbox files run on that shared Daytona fleet.

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
| Telemetry routing, opt-out, identities, and lifecycle | [`telemetry.md`](telemetry.md) |
| What a Durable Object's migration report may carry out of its region | [`durable-object-migration-tracking.md`](durable-object-migration-tracking.md) |
| The operator-only cross-region SQLite inspection exception | [`engineering-mcp.md`](engineering-mcp.md) |
| Whether a queue or binding is split per region or shared, and why | [`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md#splitting-per-region) |
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
- **A region whose Daytona target, snapshot, egress, or lifecycle acceptance
  has not passed remains `unsupported`.** Settings reports that state and Bind
  omits Terminal; another region's passing probe changes nothing. The
  checked-in Global and EU Workers are both `supported` on the same Daytona
  `us` environment. Sandbox files therefore share that fleet; Rally Terminal
  records do not cross regions.

## Testing

Under `apps/api`, run with `pnpm --filter @rally/api exec vitest run <path>`
(paths are package-relative):

| Suite | Covers |
| --- | --- |
| `test/rpc-contracts.test.ts` | Every bridge argument schema, including that a rejection names paths and not values. |
| `test/env-contract.test.ts` | The region-scoped entrypoint contract — that Global requires what EU must not. |
| `test/health-env-contract.test.ts` | That `/health` blocks on the contract and reports the offending keys. |
| `test/multiple-workspaces-schema.test.ts` | Plural Global/EU routes, per-region placement affinity, abandonment, and setup-operation replay schema. |
| `test/sqlite-d1-snapshot.test.ts` | Migration 0098 preserves existing workspace routes, memberships, invitations, sessions, and product rows while adding plural control state. |
| `test/platform-onboarding.test.ts` | Bootstrap-session limits, plural cross-region discovery, activation, create/accept replay against the real migrated D1 schema, and route reconciliation. |
| `test-workers/durable-object-runtime.test.ts` | Real-workerd admission rejects WorkspaceDO, WorkstreamDO, SubstreamAgent, and AutomationAgent after regional abandonment. |
| `test-workers/automation-agent.test.ts` | Real-workerd background execution fences compiler, schedule, provisioning, and outbox work after abandonment. |
| `test/telemetry-bootstrap.test.ts` | Cloudflare-country classification, immediate routing, capability binding, and the EU crash-saving decision. |
| `test/telemetry-preference.test.ts`, `test/telemetry-identity-link.test.ts` | Opaque cross-region preference projection and same-region anonymous linking. |
| `test/crash-symbolicator-config.test.ts`, `test/env-contract.test.ts` | Dedicated per-region telemetry buckets, EU jurisdiction, Container bindings, and Global-only PostHog configuration. |
| `test/runtime-components.test.ts` | US/EU namespace restriction, first-placement hints, local-runtime behavior, and fail-closed object jurisdiction checks. |
| `test/notion-routing.test.ts` | The region-prefixed OAuth state and the unrouted-delivery refusal. |
| `test/workstream-email-address.test.ts` | The Global reservation registry and its fail-closed behavior. |

`pnpm test:scripts` also exercises the custom region-routing rule against
direct, computed, optional, aliased, destructured, and typed namespace access.

Both Wrangler dry-run builds run in CI and are what catch whether Cloudflare can
build each complete deployment. Focused config tests also read both regional files
to enforce the security-sensitive telemetry differences, but they do not replace a
Wrangler build. Locally, `pnpm dev:api:local` starts both regions and
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

Workers Analytics Engine is also an account-level observability service for
which this repository configures no regional jurisdiction. Both API Workers
write root-run summaries to `avalon_agent_runs` and content-free Daytona phase
measurements to `avalon_terminal_operations`. To keep that additional boundary
operational-only, datapoints contain operational enums, region, configured
snapshot/model/release metadata, and numeric totals but no workspace,
work-stream, run, user, provider-sandbox, prompt, transcript, tool payload,
command, path, repository, resource, connector content, or credential
identifier. Exact correlated records remain in the existing D1, Workers
Logs/Traces, and region-specific R2 Logpush paths. A future requirement for
jurisdiction-pinned custom analytics must replace or contractually validate
these shared datasets rather than assuming the EU Worker binding makes them EU
resident.

## Changelog

### 2026-09-01 — External routing names the region without authorizing it

**What changed:** Current workspace-scoped handoffs carry region and workspace
coordinates, and the desktop activates the exact regional session before using
them.

**Why:** Region-only connector callbacks and ID-only resource links were
ambiguous once one account retained Global and EU workspaces. Using whichever
session was active either rejected a legitimate callback or opened the route in
the wrong authority.

**Considered and rejected:** Discovering the region from a resource ID or trying
stored credentials until one answers. Both violate the rule that object IDs do
not select regions and turn a link open into cross-region enumeration.

**Consequences:** Public link coordinates remain non-secret. Only ordinary
regional activation and middleware can convert them into an authorized session;
a failure leaves the existing region selected.

Shipped in #464.

### 2026-08-31 — Global discovery retains plural regional workspace routes

**What changed:** Platform identities now retain one opaque binding per regional
workspace, and the desktop keeps the identity bootstrap credential beside the
regional sessions it activates. Placement affinity is scoped by identity and
region rather than by identity alone.

**Why:** A regional session cannot call the Global onboarding coordinator, so
revoking the bootstrap credential made switching out of an EU workspace require
a new sign-in. One active binding per identity also made legitimate Global and
EU membership look like a placement conflict.

**Considered and rejected:** Rebinding a single session and storing one server-side
default workspace. The first crosses endpoint authority; the second introduces
a server preference that can disagree with the device-local selection.

**Consequences:** Global stores only opaque route metadata and setup replay;
workspace content and authorization stay regional. Discovery may reconcile
several memberships, but no request reads workspace content cross-region.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-30 — Admit an explicit operator SQLite inspection exception

**What changed:** An Access-protected engineering MCP can call a private named
entrypoint in either regional API Worker and return requested Durable Object
SQLite rows to an operator. Query text, bindings, results, and errors are not
persisted or logged by the shared Worker.

**Why:** Engineering needs the database-console capability for both regions,
while Durable Object authority and routing must remain inside the region that
owns them.

**Considered and rejected:** A Global product-state mirror, Global fallback,
and public regional SQL endpoints each create a second authority or a broader
cross-region path. Separate region-specific MCP hostnames would make clients
guess jurisdiction before identity routing has resolved it.

**Consequences:** The ordinary no-cross-region-workspace-content rule now has
one deliberate operator exception. Access admission is equivalent to console
authority across both regions, and no product request may reuse this bridge.

### 2026-08-28 — Automation state and event delivery remain regional

**What changed:** AutomationAgent names, SQLite, compiler turns, memory, timers,
and generated children live in the workspace's immutable region. WorkspaceDO
evaluates regional connector events and Queue messages expose only opaque IDs,
generations, versions, and hashes. The cutover enumerates and verifies EU and
Global independently while preserving EU-first deployment order.

**Why:** Moving automation authority must not turn the Global control plane or
cross-region service bindings into a product-state fallback.

**Consequences:** EU event contents, transcript, memory, and run payloads never
cross into Global telemetry or queues; only existing control-plane identities
retain their documented global path.

### 2026-08-27 — Project state stays with its regional WorkspaceDO

**What changed:** Project identity, participants, ordering, and revisions are
stored in the WorkspaceDO selected by the workspace's immutable placement; the
regional Worker checks same-region D1 membership before calling it.

**Why:** Projects are workspace product state and must inherit the workspace's
residency boundary without adding a Global registry copy.

**Considered and rejected:** A Global project directory, which would export EU
product metadata and create a second project authority.

**Consequences:** Project routes, Queues, and future recovery stay regional and
carry IDs rather than project content across execution boundaries.

Design: `docs/PRDs/2026-08-26_projects/prd.md`.

### 2026-08-24 — The analytics-events lakehouse is Global-only

**What changed:** Global accepted backend/client telemetry now projects into a
separate Global Data Catalog table. EU keeps its existing internal D1/R2
telemetry path and has no analytics-events Queue, Pipeline, catalog, or bridge.

**Why:** Product analysis benefits from durable typed history, but a Global
catalog is not an EU-resident destination. The existing regional collector is
the correct common policy boundary; routing EU through it and then exporting the
result would still cross the boundary.

**Considered and rejected:** A shared cross-region queue, region-labelled rows
in one Global table, and a second EU-named bucket without a documented EU Data
Catalog jurisdiction. Names do not establish residency.

**Consequences:** Global backend and client sources are jointly queryable. EU
production debugging continues through the restricted regional telemetry API,
and responders stop rather than querying Global as a substitute.

Shipped in the pull request for this change. See
[`analytics-lakehouse.md`](analytics-lakehouse.md).

### 2026-08-24 — Ace's operator directory is named as a regional exception

**What changed:** The boundary now explicitly records that Ace directly reads
EU D1 and transiently exposes matching directory fields to an authorized
operator, while its queue fan-out continues to carry only opaque IDs and a flag
key.

**Why:** The earlier text claimed names and full email addresses never crossed
regions even though Ace's configured EU D1 binding and directory route did
exactly that. A regional guarantee must describe the deployed read path, not
only the notification payload.

**Considered and rejected:** Describing Ace as an RPC-only product runtime. Ace
is a shared internal administrative plane with an explicit direct-directory
requirement; hiding that distinction would preserve the contradiction.

**Consequences:** Product/API regional access remains RPC-only. Any expansion of
Ace beyond transient directory lookup and opaque fan-out is a new residency
decision and must update this exception rather than inherit it silently.

### 2026-08-24 — Ace fans product-flag keys into regional ownership

**What changed:** The shared Ace consumer reads each D1 workspace directory and
splits key-only messages onto Global and EU queues. Each regional API addresses
only its own WorkspaceDO namespace and evaluates each user's value locally.

**Why:** One Flagship application controls both regions, but workspace identity,
membership, objects, and sockets remain regional. A single consumer cannot bind
both regional namespaces, and sending effective values would cross a
user-specific answer out of its authority.

**Considered and rejected:** A Global Worker bridge into EU would make an
internal rollout depend on a cross-region RPC and expose EU workspace delivery
to the Global runtime. Duplicating Flagship per region would require two
configurations that are intended to be identical.

**Consequences:** Ace may read both D1 directories for internal lookup and
fan-out, but regional queue bodies remain opaque and each regional Worker is the
only caller of its objects. Earlier reasoning in this document predates the
running changelog and was not reconstructed.

### 2026-08-24 — EU inference analytics are deferred

**What changed:** Only the Global Worker archives inference into R2, Queue,
Pipeline, and Data Catalog. EU continues to serve model calls but has no
inference producer, consumer, Pipeline binding, archive staging, or cross-region
fallback.

**Why:** Cloudflare cannot place Data Catalog in the EU jurisdiction, and its
direct R2 Pipeline setup requires a separate service credential obtained through
Wrangler's interactive OAuth flow. Product direction is to accept the EU
debugging gap instead of adding that manual credential lifecycle.

**Considered and rejected:** Sending EU content to the Global catalog, which
would cross the workspace boundary; and provisioning a second long-lived R2
credential, which would make first deployment and rotation a separate manual
system.

**Consequences:** Global retains maximal lossless inference evidence. The
absence of an EU row is expected, and responders must not query D1, Workers
Logs, the empty EU preflight resources, or Global as a substitute.

### 2026-08-24 — EU inference analytics stays in EU without Data Catalog

**What changed:** The EU inference Pipeline now writes typed Parquet directly
to its EU-jurisdiction R2 bucket; Global retains its default-jurisdiction Data
Catalog/Iceberg sink. Main-branch deployment creates both region-specific chains
without an approval, copied sink credential, or dashboard step.

**Why:** Production provisioning established that Cloudflare R2 Data Catalog is
unavailable for non-default-jurisdiction buckets and that its sink cannot cross
jurisdictions. The original two-Catalog design therefore could not preserve the
declared EU storage boundary.

**Considered and rejected:** A default-jurisdiction EU analytics bucket was
rejected because it would make the regional name cosmetic while storing prompt
and response content outside the chosen jurisdiction. A shared Global table was
rejected for the same reason.

**Consequences:** Both regions retain complete typed analytical rows, but only
Global supports R2 SQL/Iceberg operations. EU incident response uses the R2
Object API against bounded UTC Parquet partitions. No code may silently route an
EU query or failed EU delivery to Global.

### 2026-08-24 — Inference analytics leaves regional D1

**What changed:** Migration 0094 removes the workspace inference preference and
`agent_inference_payload_logs` from both regional D1 databases. The old
request-only payload writer is gone; all new hosted raw-inference capture uses
the already-split regional lakehouse.

**Why:** Region splitting did not justify keeping two analytical systems inside
each region. The D1 index duplicated fields already queryable in the regional
Iceberg table and made completeness depend on a workspace opt-in.

**Considered and rejected:** Keeping D1 as a regional lookup cache. That would
preserve a second sensitive-data lifecycle and product-database dependency for
an operator-only query path.

**Consequences:** D1 remains identity, membership, routing, migration/control,
and operational storage; inference analytics no longer expands that role.
Historical `agent-inference/` R2 objects are retained pending a separate
deletion decision.

### 2026-08-24 — Inference analytics comes to rest in two regional lakehouses

**What changed:** Global and EU each gained an inference payload prefix, Queue,
Pipeline stream/sink, and R2 Data Catalog Iceberg table. Queue bodies carry only
a verified pointer; prompt, tool, response, error, identity, and usage content
stays in the producer's region from capture through query.

**Why:** A shared analytical destination would undo the existing workspace
boundary, while putting full inference bodies on Queue would create another
sensitive surface and exceed its message ceiling for valid requests. The
regional payload archive is already the fixed storage dependency and is the only
place large exact records can be staged without crossing or truncating them.

**Considered and rejected:** One account-wide inference table with a `region`
column. A column labels data after it has crossed; it does not constrain which
Worker, Queue consumer, bucket jurisdiction, sink credential, or query principal
can access it.

**Consequences:** Operators query two catalogs, the deployment creates and
validates both resource chains, and the Pipeline stream IDs are materialized
into ignored per-deploy Wrangler configs rather than committed as cross-account
identifiers.

### 2026-08-17 — Workspace routing persists west/east Durable Object affinity

**What changed:** The initiating Cloudflare request selects one region-compatible
west/east affinity during workspace creation. The Global binding, regional D1
workspace row, and WorkspaceDO SQL persist it, and every descendant lookup uses
it with the existing hard US/EU jurisdiction.

**Why:** Residency and latency are different controls. A fixed western hint kept
the residency boundary but imposed avoidable latency on eastern users; choosing
again for each child would split a hierarchy across locations.

**Considered and rejected:** Treating current requester location as child
placement and putting WorkspaceDO on every data-plane lookup. The first is
unstable and the second recreates a shared control-plane bottleneck.

**Consequences:** Selecting `wnam`/`weur` solely from jurisdiction remains a
migration, background, and missing-metadata fallback only. A western request
still legitimately selects those values. Affinity is immutable, cached from the
regional routing projection, and never substitutes for the jurisdiction guarantee.

### 2026-08-17 — Product Durable Objects are jurisdiction-locked in both regions

**What changed:** One resolver now derives every staging/production object ID
from a US- or EU-restricted namespace, supplies a regional location hint on
every possible first `get()`, and validates `ctx.id.jurisdiction` inside product
objects. A custom ESLint rule prevents direct or aliased namespace routing.

**Why:** EU-only restriction left the Global graph in Cloudflare's unrestricted
namespace, and several child-to-parent/queue paths bypassed the shared helper.
Because the same name maps to a different ID in each jurisdiction and a location
hint is honored only on the first `get()`, one bypass can defeat either the
residency boundary or intended initial placement.

**Considered and rejected:** Relying on region text embedded in object names,
applying a hint only on nominal creation, and reviewing direct binding calls by
convention. Names do not constrain placement, and a workflow, alarm, queue, or
health path may win the first lookup.

**Consequences:** Global product objects use the US jurisdiction and `wnam`
default; EU uses the EU jurisdiction and `weur` default. Hints remain best effort
and do not move existing objects. The maintenance authority import targets the
jurisdictional ID graph; an unrestricted predecessor is never reopened as a
fallback. Local workerd skips jurisdictions and hints because it does not
implement them.

### 2026-08-13 — Invitation conversion is measured by the regional authority

**What changed:** The service that commits each invitation lifecycle transition
now emits one idempotent regional terminal event for created, revoked, accepted,
and declined outcomes, including bounded role, delivery, and elapsed-time
dimensions.

**Why:** Client clicks and email-provider acceptance could not establish whether
an invitation actually became a member, was declined, or was revoked. The
regional mutation is the only boundary that can report that journey without
guessing or crossing regions.

**Considered and rejected:** Renderer-only events, email addresses, workspace
names, invite URLs/tokens, and Global aggregation of EU invitation outcomes.
Those alternatives count intent as success, expose identity or bearer material,
or violate the invitation's owning-region boundary.

**Consequences:** Product funnels can join invitation terminal states by the
opaque invitation ID inside one region. New invitation terminal states must be
added at the committing service, remain idempotent, and keep recipient identity
out of semantic event properties.

### 2026-08-13 — Public-site identity is selected after the Cloudflare route

**What changed:** Added a no-store, content-free Global telemetry route lookup.
The public site uses it before reading browser analytics storage: Global may
reuse a first-party anonymous epoch, while an affirmative EU route uses only an
in-memory page epoch and the existing named EU telemetry bridge.

**Why:** The desktop's capability bootstrap assumes an epoch already exists.
Applying that order to a website would read or mint a persistent identifier
before Rally knew whether the visitor belonged to the EU internal path.

**Considered and rejected:** One Global browser identity for all locations,
persisting an EU identity in `localStorage`, and using a disposable bootstrap as
the route probe. Those choices merge residency histories, persist more EU data,
or create a 90-day control row for a request that only needed a two-value route.

**Consequences:** EU public-site funnels are aggregate across page loads; Global
can form anonymous acquisition paths. The route endpoint grants no event or
account authority and remains Global-only.
### 2026-08-13 — Terminal activation stays within the Global US target

**What changed:** The Global Worker now declares Terminal supported with the
verified Daytona `us` target and `daytona-small` snapshot. Its API credential
remains a regional Worker secret. EU has the same provider values staged as
regional bindings but remains explicitly unsupported.

**Why:** The operator supplied an enabled Global configuration after validating
the Daytona bootstrap and corrected stop-before-archive lifecycle, and requested
that EU be preconfigured without activation. Leaving Global capability
unsupported would make that integration unavailable; enabling EU against the
staged US target would cross the regional data boundary.

**Considered and rejected:** Inferring EU capability from the staged values, or
storing the Daytona API key in Wrangler configuration. The former could route EU
content to a US target; the latter would commit a provider credential.

**Consequences:** Normal deployments preserve each region's non-secret Terminal
bindings while Cloudflare retains `DAYTONA_API_KEY` as a regional secret. EU
requires its own target-specific acceptance record and an explicit capability
change before activation.

### 2026-08-13 — EU telemetry control is narrow and keyless

**What changed:** The EU Worker uses `GLOBAL_TELEMETRY_CONTROL` for three strict
commands: opaque preference mutation, onboarding-journey authorization, and
journey closure. The capability-signing key remains Global-only, while the
separate Global-to-EU bridge carries validated event projections.

**Why:** EU must link its locally minted analytics person to a journey routed by
Global without copying a Global signing key or exporting the EU person identity.
Preference also remains canonical in the one identity control plane.

**Considered and rejected:** Sharing the key, reading Global journey rows from EU,
or extending the event projection bridge into a bidirectional payload channel.
Those alternatives collapse independent regional authority or widen the one
allowed event crossing.

**Consequences:** Cross-region telemetry has two directional bindings with
different negative-space contracts. New control commands must remain payload-free,
and new event projections may move only Global-to-EU after route validation.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-12 — Onboarding telemetry resolves a region immediately

**What changed:** Global classifies a pre-workspace anonymous epoch from
Cloudflare's coarse country signal, sends affirmative-EU onboarding projections
through a narrow named RPC, and otherwise routes to Global. Explicit workspace
bindings take over for future events. Global and EU now have separate telemetry
D1 state, R2 buckets, processing, and destination configuration.

**Why:** Onboarding funnels begin before workspace selection, while an EU user
must not have a crash dump saved or an event sent to the US PostHog project merely
because the region is not known yet. The user chose immediate coarse routing and
explicitly rejected a pending holding area.

**Considered and rejected:** Queueing unresolved records in Global, later moving
them when a workspace is selected, recording the detected country, or falling EU
telemetry back to Global during an outage. Each weakens residency or makes one
event's region mutable.

**Consequences:** A failed or unavailable geolocation signal takes the documented
Global fallback, but an affirmative EU result is sticky for that event. Future
workspace selection never migrates historical telemetry, and both deployments
must provision their dedicated telemetry resources before rollout.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-13 — Daytona fleet timing stays aggregate and account-level

**What changed:** Both regional Workers now write provider create, managed-image
bootstrap, verification, and lifecycle-start phase measurements to the shared
`avalon_terminal_operations` Analytics Engine dataset. The sampling cohort is
the fixed Terminal source plus region, while configured snapshot remains a
groupable blob; no tenant or operation identifier is stored.

**Why:** Deciding whether to replace Daytona's common managed image requires a
cross-sandbox latency distribution, while exact regional identifiers add no
value to that fleet-level question and Analytics Engine has no configured EU
jurisdiction guarantee.

**Considered and rejected:** Adding Daytona timings to the root-run dataset,
indexing by workspace/sandbox, and naming a separate EU table as if its name
established residency. They respectively mix incompatible event grains, expose
unneeded correlation in a sampled store, or claim a boundary Cloudflare does
not document.

**Consequences:** EU and Global phase data can be filtered by the explicit
region blob but shares the same account-level Analytics Engine boundary and
three-month retention. Regional D1 and R2 Logpush remain the exact sources; a
future jurisdiction requirement must replace or contractually validate this
aggregate path.

### 2026-08-30 — EU Terminal uses the same Daytona environment as Global

**What changed:** The EU Worker is now `TERMINAL_REGION_CAPABILITY=supported`
with `DAYTONA_TARGET=us`, matching Global. Onboarding no longer lists Terminal
as unavailable for an EU workspace.

**Why:** EU workspaces needed the sandbox, and Rally operates Daytona as one
environment rather than a second regional fleet. Keeping EU `unsupported` was
the honest state only while Terminal itself was withheld; once it is on, the
target has to be the environment that actually exists.

**Considered and rejected:** Declaring `DAYTONA_TARGET=eu` from Daytona's
published region list. That would have advertised a Daytona region Rally does
not run. Also rejected was a Rally-side cross-region sandbox control plane:
EU Terminal records, resource bytes, and GitHub tokens still stay in the EU
Worker.

**Consequences:** EU sandbox files run on the same Daytona `us` fleet as
Global. That is a subprocessor exception, not a Rally data bridge. EU reuses
the Global Daytona project key as its own Worker secret; Cloudflare cannot
copy it across Workers. Runtime still degrades to `unsupported` if that EU
secret (or another required Daytona value) is missing.

### 2026-08-13 — Terminal availability is a regional provider gate

**What changed:** Each Worker deployment has an independent
`TERMINAL_REGION_CAPABILITY` and, only when supported, independent Daytona API,
target, snapshot, and emergency-disable configuration. Terminal D1/R2 records,
GitHub App operations, and generated resources stay in the workspace region;
both checked-in regions currently default to `unsupported`.

**Why:** Daytona becomes a subprocessor for repository and resource content.
Treating its availability as one global product flag would either advertise a
target whose residency/isolation had not been verified or silently route EU
workspace data through Global.

**Considered and rejected:** Global fallback, a shared cross-region sandbox
control plane, and enabling a region from configuration alone without the real
provider probe. All make availability outrun the regional data boundary.

**Consequences:** Operations must pass and record the snapshot, egress,
lifecycle, and residency gates for Global and EU separately. Unsupported is a
valid shipped state; code must not infer capability from the presence of
Daytona credentials.

Shipped in the pull request for this change. Design:
[`docs/PRDs/2026-08-12_daytona-terminal-git-github/prd.md`](PRDs/2026-08-12_daytona-terminal-git-github/prd.md).

### 2026-08-12 — Root-run aggregate telemetry excludes regional identifiers

**What changed:** Both regional API Workers now bind the account-level
`avalon_agent_runs` Workers Analytics Engine dataset. The fixed datapoint schema
contains only operational dimensions and numeric run totals; correlation IDs
and all member content are excluded.

**Why:** Operators need aggregate latency, tool-use, token, cost, and outcome
distributions before setting unattended run ceilings. Cloudflare documents
Analytics Engine as a sampled account-level analytics product and exposes no
dataset-jurisdiction option equivalent to the EU R2 bucket configuration.

**Considered and rejected:** Indexing Analytics Engine by workspace or run ID
was rejected because those identifiers are unnecessary for policy tuning,
unique row indexes are an Analytics Engine anti-pattern, and the shared dataset
is not the canonical regional ledger. Separate region-named datasets were also
rejected for now: a different name does not establish a documented storage
jurisdiction and would make account-wide product analysis harder.

**Consequences:** Analytics Engine may be used only for content-free aggregate
telemetry unless Cloudflare's regional guarantees are separately established.
Regional D1 remains canonical, the two R2 Logpush buckets retain their existing
jurisdictions, and exact per-run investigation uses those records rather than
Analytics Engine.

This document predates the changelog rule in
[`module-documents.md`](module-documents.md#starting-one), and the reasoning behind
the older boundary described above — beyond the reasons already written inline — was not
recorded here and was not reconstructed. `git log` and the PRDs under `docs/PRDs/`
are what exist. The entry above begins the running record.
