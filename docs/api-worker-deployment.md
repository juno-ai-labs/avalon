# API Worker build and deployment

Rally's API is deployed as three statically imported Workers in each region:
the public API and two private capability services. Global also has one private
telemetry-delivery Worker and one scheduled inference-pricing Worker. The split
controls the module graph Cloudflare evaluates at startup and keeps
provider-catalog refreshes out of inference requests without moving product
authority or loading code during a request.

Read this before changing an API entrypoint, a Worker dependency, a Service
Binding, a Wrangler config, or `deploy-api.yml`. The repository-wide rule is
[`coding-practices-and-style.md`](coding-practices-and-style.md#imports-are-static):
JavaScript and TypeScript imports are static. Independent initialization needs
a typed process or deployment boundary.

Cloudflare's platform contracts are the [one-second startup
limit](https://developers.cloudflare.com/workers/platform/limits/#worker-limits),
[zero-overhead Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/),
the [WorkerEntrypoint RPC model](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/),
[RPC lifecycle and disposal](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/),
and [Versions and gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/).

## Where the code lives

| Surface | Entrypoint and config | Responsibility |
| --- | --- | --- |
| Regional API | `src/index.ts`, `wrangler.{eu,global}.jsonc` | HTTP, events, Durable Objects, Workflows, routing bridges, and product authority. |
| Document processor | `src/document-processing-worker.ts`, `wrangler.documents.{eu,global}.jsonc` | PDF.js text extraction, animated-GIF storyboards, and TIFF decoding. |
| Terminal provider | `src/terminal-provider-worker.ts`, `wrangler.terminal.{eu,global}.jsonc` | Daytona SDK calls behind the `TerminalSandboxProvider` contract. |
| Telemetry delivery | `src/telemetry-delivery-worker.ts`, `wrangler.telemetry.global.jsonc` | Global-only destination adapters for already approved telemetry, crash, and profile rows; PostHog is the first adapter. |
| Inference pricing | `src/inference-pricing-worker.ts`, `wrangler.pricing.global.jsonc` | Hourly OpenRouter endpoint-price averages written to the shared regional KV namespace. |
| Contracts | `src/services/document-processing-contract.ts`, `src/services/terminal/provider-rpc-contract.ts`, `src/telemetry/telemetry-delivery-contract.ts` | Typed RPC inputs and outputs imported by caller and callee. |
| Rollout | `.github/workflows/deploy-api.yml` | Profiles, version upload, migration ordering, promotion, health, and retained evidence. |

## How it works

Every Worker has one complete static dependency graph. Both regional APIs bind
to `DOCUMENT_PROCESSOR` and `TERMINAL_PROVIDER`; Global also binds to
`TELEMETRY_DELIVERY`. There is no public route to any capability Worker.
Cloudflare runs a bound service on the same thread and machine by default, with
no added service cost; each call still counts as one Worker invocation and one
subrequest.

Within the regional API graph, ordinary Rally-owned validation schemas use
Zod's v3-compatible runtime. Bind's v4 JSON-Schema compiler stays behind a
narrow compatibility edge, and shared helpers preserve v4's safe-integer,
strict-UUID, provider-schema, and error-classification behavior. This is still
one fully static graph; no schema or route is loaded on demand.

Cloudflare currently rejects a default RPC entrypoint that has no named event
handler. Each capability Worker therefore registers an inert `fetch()` handler
that always returns 404. `workers_dev` and preview URLs remain disabled and no
route points at the services; the handler satisfies deployment validation but
does not create a product or operator HTTP surface.

Document RPC transfers bounded `Uint8Array` values and typed results. Existing
source limits stay below Cloudflare RPC's serialized payload limit. Terminal RPC
passes the already parsed regional provider configuration, including the
caller's secret value, only across the private binding for the lifetime of one
harness run; the service stores nothing durably. The binding returns a typed
`RpcTarget` session that owns one Daytona client and its sandbox-object cache,
matching the provider lifetime the in-process implementation had. Cloudflare
automatically disposes the session when the calling execution context ends.
Instrumentation callbacks are duplicated into that session and released by its
disposer; authority and cancellation callbacks live only for one method call.
Cancellation is a typed long-lived callback: the
provider Worker creates its own `AbortController`, observes the caller's signal,
and closes the callback before returning. A pre-aborted input is carried
explicitly so the provider-side signal is aborted before Daytona I/O begins.

Telemetry-delivery RPC transfers only telemetry, crash, and profile rows that
the Global API has already admitted and sanitized. D1 outboxes, policy, circuit
state, delivery receipts, and retries remain API authority. The API passes its
existing PostHog token and host through the private call during the first
service bootstrap; the delivery Worker stores no secret or row. Each method
returns an outcome keyed by destination, so a future fan-out can persist one
sink's success while retrying another. EU has neither the binding nor a PostHog
secret.

RPC exceptions are not a product protocol: Cloudflare preserves standard error
names and messages but not custom own properties. Every Terminal method
therefore returns a discriminated success/error value. The provider Worker
classifies Daytona not-found failures before they cross the boundary, and
submission callbacks return typed `TerminalToolError` refusals by value. The API
reconstructs the local error types that existing cleanup, recovery, and tool
logic consumes.

Local development starts EU's three configs and Global's four configs in one
Wrangler multi-Worker session. Tests inject contract implementations where a
provider cannot run, while build checks compile and profile every real
entrypoint.
`pnpm --filter @rally/api dev:pricing` separately exposes the scheduled handler
locally through Wrangler's scheduled-event test route.

## Invariants and contracts

- Production code, tests, and scripts use static imports. A dynamic `import()`
  is not a startup strategy.
- Schema-heavy API, contract, and connector modules import `zod/v3`; bare Zod
  v4 imports are limited to the checked Bind/JSON-Schema compatibility edge.
- The capability Workers own compute only. D1, R2, Durable Object namespaces,
  schedules, claims, and product state remain in the regional API.
- Service methods are explicit and typed. Do not replace them with an untyped
  operation string or generic JSON endpoint.
- New Global telemetry destination adapters extend `TELEMETRY_DELIVERY` and
  return their own outcome. Do not create one private Worker per vendor; that
  would recreate deployment and startup fragmentation at the destination layer.
- The document, Terminal, and Global telemetry-delivery services must deploy before the API
  version that binds to or calls them. A service change remains compatible with
  the previous API until the regional API promotion is healthy.
- EU services are separate from Global services. Payloads and provider calls do
  not cross regions through these bindings.
- The Global pricing Worker is the only OpenRouter pricing-cache writer. API
  inference in both regions reads the shared public-metadata KV and never
  refreshes provider pricing inline.
- All selected versions are uploaded successfully before ordinary promotion.
  EU services and API promote and pass health before Global promotion.
- Every successful version is tagged with the immutable Git SHA that passed the
  workflow's complete verification matrix.
- Promotion uses the unique version IDs captured from that workflow attempt,
  never the non-unique Git SHA tag. A retry can safely upload another set.
- The engineering MCP is a consumer of named entrypoints in both regional API
  Workers. It deploys only after both selected regions are healthy; a partial
  regional recovery leaves the existing MCP version untouched.

## Boundaries and non-goals

The split follows heavyweight, stateless provider libraries. The shared
telemetry-delivery service is the convergence point for Global destination
adapters, while the regional API remains the durable acceptance and retry
authority. The analytics lakehouse still uses its existing independent
Queue/Pipeline consumer; moving that lifecycle is deferred until it can preserve
independent acknowledgement, replay, and EU non-export. This change does not
split Hono routes by fashion, duplicate secrets at rest, or move Durable Object
namespaces. A future Durable Object service split is a separate data migration
using Cloudflare's staged transfer protocol.

The public API remains one logical service per region. Capability Workers are
internal implementation boundaries, not user-facing APIs and not independently
selected product regions.

## Failure modes and limits

- Error 10021 during any upload means that Worker's static graph still exceeds
  Cloudflare's hard startup budget. Inspect its retained CPU profile and move a
  coherent stateless capability behind a typed service boundary; do not retry
  until timing happens to pass.
- A missing target Worker makes caller deployment fail. The workflow deploys or
  uploads target services first.
- If any ordinary version upload fails, no region is promoted.
- If EU promotion or EU health fails, Global remains unchanged.
- If Global fails after EU succeeds, leave the verified EU set live and roll
  Global forward or explicitly restore its prior tagged set.
- A failed pricing cron leaves every prior valid per-model KV record usable. A
  missing or malformed record makes Bind omit that Azure candidate rather than
  send an unpriced request.
- Cloudflare Versions cannot apply Durable Object migrations or update a
  Container image. A Wrangler-config or Crash Symbolicator change therefore
  uses direct service-first deployment. An untagged or divergent production
  baseline also fails safe to direct mode.
- No repository-authored millisecond ceiling is used. Local CPUs differ from
  Cloudflare's; the platform upload is authoritative and the structural service
  boundaries are machine-independent.

## Testing

- `pnpm --filter @rally/api build`, `build:eu`, `build:documents`,
  `build:documents:eu`, `build:terminal`, `build:terminal:eu`,
  `build:telemetry`, and `build:pricing` dry-run and profile all eight static
  artifacts.
- `pnpm --filter @rally/api check:telemetry-startup-boundary` reads Wrangler's
  emitted bundles and requires the PostHog SDK, core, and adapter modules to be
  absent from both regional APIs. The provider build and production-entrypoint
  tests prove the private Worker independently without freezing its SDK internals.
- `node --test scripts/check-api-startup-schema-runtime.test.mjs` proves the
  schema-heavy graph cannot regain a bare Zod v4 import or lose v4-compatible
  safe-integer and strict-UUID semantics.
- Attachment tests run the same statically imported codec implementation behind
  an injected document-processing contract.
- Terminal provider tests continue to prove Daytona behavior directly; RPC
  client tests prove session reuse, callback, cancellation, and argument
  delegation. A real-workerd auxiliary Service Binding proves `RpcTarget`
  state and retained callbacks survive the entrypoint call that created them.
- A real-workerd telemetry-delivery Service Binding test proves typed telemetry and nested
  crash rows cross the RPC boundary by value; adapter tests still inspect the
  exact destination payloads without a provider network call.
- `node --test scripts/deploy-api-workflow.test.mjs` proves service-first
  upload, the hourly Global cron and shared KV binding, EU-before-Global health,
  and migration placement.
- PR CI retains the new telemetry-delivery Worker profile for seven days; deployment
  retains all eight exact-artifact profiles on success or failure.

## Regional impact

Each region has two private Workers and two Service Bindings. Global additionally
has one private telemetry-delivery Worker and binding, plus one route-less scheduled Worker
bound to the same pricing KV both APIs read. The delivery service adds no stored
secret; its caller passes the existing Global PostHog token over RPC. These Workers add
no routes, databases, buckets, queues, or Durable Object namespaces.
Service calls execute at the caller's Cloudflare location. EU remains first
because Global also carries named bindings to EU API entrypoints, and EU data
retains its existing no-Global-fallback policy.

## Operations

Normal production rollout is `deploy-api.yml`. It builds and profiles all
selected service graphs, materializes Global lakehouse bindings, discovers the
active source tags, and selects one mode:

- **Versioned:** upload every selected document, Terminal, telemetry-delivery, pricing, and
  API version with no traffic and capture its immutable version ID; apply
  migration-first D1 changes; promote those exact EU IDs service-first; prove
  EU health; promote the exact Global IDs; apply Worker-first retirements; prove
  both.
- **Direct:** for first creation, Wrangler or Container state changes, or an
  unknown/divergent baseline, deploy each regional service before its API and
  retain the same health barriers.

The manual `deploy:eu` and `deploy:global` scripts use the same service-first
order but do not provide the cross-region pre-upload transaction. Use them only
for a deliberate operator recovery.

After a full two-region rollout, the workflow provisions and deploys the
Access-protected engineering MCP. This ordering is also the first-release
bootstrap for `EngineeringInspectionBridge`: the caller cannot go live before
both named entrypoints exist. See [`engineering-mcp.md`](engineering-mcp.md).

## Performance and cost

The failed monolith uploaded about 12.3 MiB and had no dependable startup
margin. With Wrangler 4.126.0, the static service split makes the API graph
about 7.3 MiB, the document graph about 2.8 MiB, and the Terminal graph about
2.3 MiB. A later 7.16 MiB API graph again failed production upload with error
10021; moving its Global-only PostHog graph reduced both API artifacts to about
7.16 MiB and produced a 248 KiB telemetry-delivery Worker with a 6 ms local active-startup
sample. Repeated local active-startup samples varied from 93–290 ms for the
API, 7–14 ms for documents, and 18–28 ms for Terminal; these values diagnose
graph shape and are not predictions of Cloudflare CPU time.

The failed 7.16 MiB release's exact-artifact profile reported 205.4 ms of local
active startup, including 109.9 ms of garbage collection. Moving Rally-owned
schema construction to the compatible runtime produces a 7.34 MiB artifact—the
v4 compiler remains present—but five repeated profiles report 72.5–76.7 ms
active, including 23.7–28.7 ms of GC. The larger source bundle and lower active
time are intentional: Cloudflare rejected initialization CPU, and the retained
profile identifies schema-object construction rather than upload bytes as the
dominant cost.

Service Bindings add no monetary charge or network hop by default. A document,
Terminal, or Global telemetry-destination operation adds a Worker invocation and subrequest,
while ordinary API requests no longer initialize those provider libraries. That
cost is bounded to the capability that uses it and is visible as a platform
invocation.
The pricing graph runs once per hour in Global and performs fourteen OpenRouter
catalog reads plus fourteen small KV writes; inference performs only the KV reads
for Azure-bound models in its route plan.

## Changelog

### 2026-09-01 — Regional schemas stop paying Zod v4 construction cost

**What changed:** Rally-owned schemas in the regional API graph now use
`zod/v3`; Bind and JSON-Schema compilation retain Zod v4 through explicit
compatibility files. Shared conversion and error helpers preserve provider
schema output and recognize failures from both versions. A repository check
blocks bare-v4 regressions and the two known semantic widenings in v3.

**Why:** The telemetry service split removed PostHog but the next fully verified
Global artifact still failed Cloudflare upload with error 10021. The retained
CPU profile showed eager Zod v4 constructor installation and garbage collection
dominating startup. Five repeated exact-artifact profiles fell from the failed
artifact's 205.4 ms active sample to 72.5–76.7 ms after this change.

**Considered and rejected:** A blind retry, minification alone, or an arbitrary
millisecond gate would preserve machine-dependent success. Dynamic imports
would move the same initialization into customer traffic. Splitting regional
routes or Durable Object protocols would duplicate authority or require data
movement without following a coherent stateless capability.

**Consequences:** The API artifact contains both Zod runtimes and is about 7.34
MiB uncompressed, but constructs the large Rally schema graph on the cheaper
runtime. Integers and UUIDs retain v4 validation semantics, provider schemas
retain required defaults and UUID formats, and error diagnostics work across
both versions. No route, binding, resource, or data migration changes.

### 2026-09-01 — Global telemetry delivery gets one shared startup graph

**What changed:** The Global API now sends already approved telemetry, crash,
JavaScript-exception, and profile batches through the explicit typed
`TELEMETRY_DELIVERY` binding. The PostHog SDK and destination mapping are
statically imported only by a new Global-only Worker whose identity is shared
across telemetry destinations. RPC results are keyed by destination so future
fan-out can keep acknowledgement and retry independent. Deployment builds,
profiles, uploads, and promotes that service before the Global API, bringing the
release to eight static artifacts.

**Why:** The API artifact from the workspace-handoff release passed every local
gate but Cloudflare rejected its production upload with error 10021. The same
provider graph was also initialized in EU even though EU policy forbids PostHog
delivery. Isolating that coherent stateless graph gives both regional APIs
structural startup margin and makes the residency boundary visible in Wrangler.

**Considered and rejected:** Retrying the unchanged upload leaves the one-second
platform race intact. Request-time imports violate Rally's static-import rule
and move initialization into customer traffic. Shaving individual adapter
imports would leave the provider SDK in both API graphs. Naming the service for
PostHog was rejected because each later destination would invite another Worker
and rollout edge. Moving the token on first creation was rejected because the
deploy workflow cannot provision a secret onto a Worker that does not exist yet;
the existing secret can cross the private call without creating another stored
secret.

**Consequences:** Global destination delivery now adds one private invocation
and subrequest per attempted batch. Policy, D1 outboxes, retries, circuits, and
receipts remain in the API; the delivery Worker is stateless. New Global
destination adapters extend this Worker and add an independent result instead
of creating a destination-specific service. The analytics lakehouse retains its
current Queue/Pipeline lifecycle until that move can preserve failure
independence. The RPC contract must stay backward-compatible through
service-first rollout. EU has no delivery binding, PostHog SDK graph, or secret,
and this change requires no data migration.

Shipped in #471.

### 2026-08-30 — Disambiguate the engineering MCP deployment script

**What changed:** The API workflow now invokes the engineering MCP package's
deployment script with pnpm's explicit `run deploy` form, and its workflow test
requires that exact command.

**Why:** Pnpm 11 treated the prior filtered `deploy` invocation as pnpm's own
package-deployment command and stopped after both regional APIs were healthy,
before the MCP provisioner or OAuth probe could run.

**Considered and rejected:** Renaming the package script would avoid the command
collision but would needlessly change the established operator command. An
unprotected textual replacement was rejected because the original workflow test
proved ordering while allowing an invocation that could not execute.

**Consequences:** Filtered invocations of a package script whose name collides
with a pnpm command must use `pnpm --filter <package> run <script>`. The
deployment workflow test prevents this command from regressing while retaining
the regional health barrier.

### 2026-08-30 — Deploy the engineering MCP after the regional API barrier

**What changed:** The verified build now dry-runs the engineering MCP, and a
full release deploys it only after EU and Global API health. The post-deploy
probe requires Cloudflare Access's non-browser OAuth challenge.

**Why:** The MCP binds a named inspection entrypoint in both regional API
Workers. Deploying the caller in parallel would make the first release race a
target that does not exist and could expose a mixed pair during later changes.

**Considered and rejected:** A separate independent workflow cannot prove which
regional API versions are live. Deploying after only one region would turn the
other binding into an availability failure.

**Consequences:** MCP-only changes intentionally run the API deployment
workflow, and one-region manual recovery does not update the MCP. Both regional
entrypoints must remain compatible with the previously deployed MCP until the
full barrier completes.

### 2026-08-30 — Pricing refresh leaves the inference path

**What changed:** Global gained a dedicated hourly scheduled Worker that
refreshes OpenRouter endpoint-average pricing for the union of the developer
model selector and Azure deployments carried by OpenRouter. It writes one KV record keyed by
canonical OpenRouter model ID, with base and prompt-threshold override decimal
costs stored as strings. Regional
API Workers are read-only consumers of the same namespace. Token-priced records
carry per-million input/cache/output values and any catalog long-context tiers;
image records preserve OpenRouter's native billable/unit lines.

**Why:** A request-triggered refresh made an arbitrary inference request own
provider-catalog availability and shared-cache mutation. Pricing is public
fleet metadata with one refresh cadence, not workspace or regional product
state, so it has one explicit producer.

**Considered and rejected:** A Cloudflare Workflow was rejected because the job
is fourteen independent GETs followed by fourteen small KV writes and has no
multi-step durable business transaction to resume. Per-region crons were
rejected because they would race to publish identical public metadata.

**Consequences:** Stale valid records remain usable during OpenRouter outages;
missing or legacy numeric records fail closed for Azure routing. Adding a model
to the developer selector automatically adds it to the refresh inventory, while
a new Azure-only deployment must be added to the checked-in Azure inventory.
The realtime-transcription deployment has no OpenRouter model ID and therefore
no key in this cache.

### 2026-08-30 — Heavy providers become typed regional services

**What changed:** PDF/image codecs and the Daytona SDK moved into two private,
statically imported Workers per region. The API calls them through typed RPC,
Terminal keeps one disposable `RpcTarget` provider session per harness run, all
six artifacts receive startup profiles, and deployment uploads or deploys
services before each regional API with an EU health barrier before Global.

**Why:** An unchanged, fully verified API bundle alternated between successful
uploads and Cloudflare error 10021 because the monolithic startup graph crossed
the platform's one-second ceiling. The correct controllable unit is the Worker
startup graph.

**Considered and rejected:** Request-time dynamic imports were rejected because
the repository requires a complete static dependency graph. Retrying, minifying,
or trimming one dependency leaves a timing race. Moving Durable Objects was
rejected because the heavyweight libraries are stateless and a namespace
transfer would turn a compute boundary into a data migration. Duplicating
write-only secrets into new Workers was rejected; Terminal configuration crosses
only the private call boundary.

**Consequences:** The API now has two internal regional deployment dependencies.
Their contracts must remain backward-compatible through service-first rollout,
local development starts three Workers per region, and each service has its own
startup evidence. Terminal's provider-side object cache is session-local rather
than global or reconstructed per operation. Product storage and authority remain
unchanged. Until Cloudflare supports handlerless default RPC entrypoints, each
private service must retain its inert 404 `fetch()` handler.
