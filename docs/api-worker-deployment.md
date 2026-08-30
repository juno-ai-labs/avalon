# API Worker build and deployment

Rally's API is deployed as three statically imported Workers in each region:
the public API and two private capability services. The split controls the
module graph Cloudflare evaluates at startup without moving product authority
or loading code during a request.

Read this before changing an API entrypoint, a Worker dependency, a Service
Binding, a Wrangler config, or `deploy-api.yml`. The repository-wide rule is
[`coding-practices-and-style.md`](coding-practices-and-style.md#imports-are-static):
JavaScript and TypeScript imports are static. Independent initialization needs
a typed process or deployment boundary.

Cloudflare's platform contracts are the [one-second startup
limit](https://developers.cloudflare.com/workers/platform/limits/#worker-limits),
[zero-overhead Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/),
the [WorkerEntrypoint RPC model](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/),
and [Versions and gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/).

## Where the code lives

| Surface | Entrypoint and config | Responsibility |
| --- | --- | --- |
| Regional API | `src/index.ts`, `wrangler.{eu,global}.jsonc` | HTTP, events, Durable Objects, Workflows, routing bridges, and product authority. |
| Document processor | `src/document-processing-worker.ts`, `wrangler.documents.{eu,global}.jsonc` | PDF.js text extraction, animated-GIF storyboards, and TIFF decoding. |
| Terminal provider | `src/terminal-provider-worker.ts`, `wrangler.terminal.{eu,global}.jsonc` | Daytona SDK calls behind the `TerminalSandboxProvider` contract. |
| Contracts | `src/services/document-processing-contract.ts`, `src/services/terminal/provider-rpc-contract.ts` | Typed RPC inputs and outputs imported by caller and callee. |
| Rollout | `.github/workflows/deploy-api.yml` | Profiles, version upload, migration ordering, promotion, health, and retained evidence. |

## How it works

Every Worker has one complete static dependency graph. The regional API binds
to `DOCUMENT_PROCESSOR` and `TERMINAL_PROVIDER` with private Service Bindings.
There is no public route to either capability Worker. Cloudflare runs a bound
service on the same thread and machine by default, with no added service cost;
each call still counts as one Worker invocation and one subrequest.

Document RPC transfers bounded `Uint8Array` values and typed results. Existing
source limits stay below Cloudflare RPC's serialized payload limit. Terminal RPC
passes the already parsed regional provider configuration, including the
caller's secret value, only across the private binding for the duration of the
call; the service stores nothing. Instrumentation and authority callbacks use
Workers RPC callbacks. Cancellation is a typed long-lived callback: the
provider Worker creates its own `AbortController`, observes the caller's signal,
and closes the callback before returning. A pre-aborted input is carried
explicitly so the provider-side signal is aborted before Daytona I/O begins.

RPC exceptions are not a product protocol: Cloudflare preserves standard error
names and messages but not custom own properties. Every Terminal method
therefore returns a discriminated success/error value. The provider Worker
classifies Daytona not-found failures before they cross the boundary, and
submission callbacks return typed `TerminalToolError` refusals by value. The API
reconstructs the local error types that existing cleanup, recovery, and tool
logic consumes.

Local development starts each region's three configs in one Wrangler
multi-Worker session. Tests inject contract implementations where a provider
cannot run, while build checks compile and profile every real entrypoint.

## Invariants and contracts

- Production code, tests, and scripts use static imports. A dynamic `import()`
  is not a startup strategy.
- The capability Workers own compute only. D1, R2, Durable Object namespaces,
  schedules, claims, and product state remain in the regional API.
- Service methods are explicit and typed. Do not replace them with an untyped
  operation string or generic JSON endpoint.
- The document and Terminal services must deploy before the API version that
  binds to or calls them. A service change remains compatible with the previous
  API until the regional API promotion is healthy.
- EU services are separate from Global services. Payloads and provider calls do
  not cross regions through these bindings.
- All selected versions are uploaded successfully before ordinary promotion.
  EU services and API promote and pass health before Global promotion.
- Every successful version is tagged with the immutable Git SHA that passed the
  workflow's complete verification matrix.
- Promotion uses the unique version IDs captured from that workflow attempt,
  never the non-unique Git SHA tag. A retry can safely upload another set.

## Boundaries and non-goals

The split follows heavyweight, stateless provider libraries. It does not split
Hono routes by fashion, create a second product authority, duplicate secrets at
rest, or move Durable Object namespaces. A future Durable Object service split
is a separate data migration using Cloudflare's staged transfer protocol.

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
- Cloudflare Versions cannot apply Durable Object migrations or update a
  Container image. A Wrangler-config or Crash Symbolicator change therefore
  uses direct service-first deployment. An untagged or divergent production
  baseline also fails safe to direct mode.
- No repository-authored millisecond ceiling is used. Local CPUs differ from
  Cloudflare's; the platform upload is authoritative and the structural service
  boundaries are machine-independent.

## Testing

- `pnpm --filter @rally/api build`, `build:eu`, `build:documents`,
  `build:documents:eu`, `build:terminal`, and `build:terminal:eu` dry-run and
  profile all six static artifacts.
- Attachment tests run the same statically imported codec implementation behind
  an injected document-processing contract.
- Terminal provider tests continue to prove Daytona behavior directly; RPC
  client tests prove callback, cancellation, and argument delegation.
- `node --test scripts/deploy-api-workflow.test.mjs` proves service-first
  upload, EU-before-Global health, and migration placement.
- CI retains every startup profile on success or failure.

## Regional impact

Each region gains two private Workers and two Service Bindings. They add no
routes, databases, buckets, queues, secrets, or Durable Object namespaces.
Service calls execute at the caller's Cloudflare location. EU remains first
because Global also carries named bindings to EU API entrypoints, and EU data
retains its existing no-Global-fallback policy.

## Operations

Normal production rollout is `deploy-api.yml`. It builds and profiles all
selected service graphs, materializes Global lakehouse bindings, discovers the
active source tags, and selects one mode:

- **Versioned:** upload every selected document, Terminal, and API version with
  no traffic and capture its immutable version ID; apply migration-first D1
  changes; promote those exact EU IDs service-first; prove EU health; promote
  the exact Global IDs; apply Worker-first retirements; prove both.
- **Direct:** for first creation, Wrangler or Container state changes, or an
  unknown/divergent baseline, deploy each regional service before its API and
  retain the same health barriers.

The manual `deploy:eu` and `deploy:global` scripts use the same service-first
order but do not provide the cross-region pre-upload transaction. Use them only
for a deliberate operator recovery.

## Performance and cost

The failed monolith uploaded about 12.3 MiB and had no dependable startup
margin. With Wrangler 4.126.0, the static service split makes the API graph
about 7.3 MiB, the document graph about 2.8 MiB, and the Terminal graph about
2.3 MiB. Repeated local active-startup samples varied from 93–190 ms for the
API, 8–14 ms for documents, and 19–28 ms for Terminal; these values diagnose
graph shape and are not predictions of Cloudflare CPU time.

Service Bindings add no monetary charge or network hop by default. A document
or Terminal operation adds a Worker invocation and subrequest, while ordinary
API requests no longer initialize either provider library. That cost is bounded
to the capability that uses it and is visible as a platform invocation.

## Changelog

### 2026-08-30 — Heavy providers become typed regional services

**What changed:** PDF/image codecs and the Daytona SDK moved into two private,
statically imported Workers per region. The API calls them through typed RPC,
all six artifacts receive startup profiles, and deployment uploads or deploys
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
startup evidence. Product storage and authority remain unchanged.
