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
| Ashby ingress | `src/ashby-ingress-worker.ts`, `wrangler.ashby.global.jsonc` | Dedicated public connector domain; opaque regional lookup and exact signed-byte forwarding. |
| Telemetry delivery | `src/telemetry-delivery-worker.ts`, `wrangler.telemetry.global.jsonc` | Global-only destination adapters for already approved telemetry, crash, and profile rows; PostHog is the first adapter. |
| Inference metadata | `src/inference-pricing-worker.ts`, `wrangler.pricing.global.jsonc` | Hourly OpenRouter endpoint-price averages and a model-window snapshot seeded when missing and refreshed after 24 hours in shared regional KV. |
| Contracts | `src/services/document-processing-contract.ts`, `src/services/terminal/provider-rpc-contract.ts`, `src/telemetry/telemetry-delivery-contract.ts` | Typed RPC inputs and outputs imported by caller and callee. |
| Rollout | `.github/workflows/deploy-api.yml` | Profiles, version upload, migration ordering, promotion, health, and retained evidence. |

### Dedicated Ashby ingress

`ashby.rallywith.ai` belongs to `avalon-connector-ashby-global`, a separate static
entry point. `build:ashby` profiles its emitted artifact and rejects accidental
imports of the API application, connector registry, or agent runtime. The public
entry point forwards signed bytes to `AshbyRegionalBridge` in the owning region;
credentials, verification, and canonical Queue admission remain regional. This
isolates ingress startup, while shared provider/lifecycle code remains in the API
artifact and must not be described as removed from it.

The workflow deploys Ashby ingress only after the configured API pass health,
then probes `https://ashby.rallywith.ai/health` with the existing health checker's
URL override and retry policy. Its own `/health` calls its configured named targets,
checks their regions, and verifies the Global directory is readable; missing
bindings, a missing routing migration or misrouted bridges return 503. Partial regional
recovery leaves the shared ingress deployment unchanged. No new stored secret or
per-customer deployment is involved. Existing Granola webhook URLs stay on their
original regional receivers. Local UI work can use regional ingestion directly;
shared-host acceptance uses the dedicated Worker and its configured bindings.
The dedicated and regional configs set `PROVIDER_WEBHOOK_MAX_BYTES` to
2,000,000 bytes; the shared reader defaults to 1,000,000 when unset and rejects
oversized bodies before buffering or RPC forwarding. This reuses the existing
provider ingress policy.

### Search indexing and capture

Both regional API configurations declare the `BROWSER` Browser Run binding for asynchronous conversation-link capture. The existing activity Queue consumer centralizes lexical indexing, Qwen tokenization, chunking, and embeddings in the regional API Worker. The tokenizer dependency is statically imported; the pinned public model assets ship in the bundle and are inflated synchronously on first use, once per isolate rather than once per Queue delivery. Parsing remains outside module startup. The BPE input cache is cleared after every token count. Configured deployments use the shared code policy of 512 tokens per chunk and 128 tokens of sliding-window overlap; there are no chunk-budget environment variables. Turbopuffer credentials are server secrets: production uses `TURBO_PUFFER_PROD_API_KEY`, development uses `TURBO_PUFFER_DEV_API_KEY`. Deploying these bindings does not backfill dormant objects; the [text-search operations procedure](text-search.md#operations) covers the separate migration wake and Queue verification.

Every Worker has one complete static dependency graph. Both regional APIs bind
to `DOCUMENT_PROCESSOR` and `TERMINAL_PROVIDER`; Global also binds to
`TELEMETRY_DELIVERY`. There is no public route to any capability Worker.
Cloudflare runs a bound service on the same thread and machine by default, with
no added service cost; each call still counts as one Worker invocation and one
subrequest.

Cloudflare currently rejects a default RPC entrypoint that has no named event
handler. Each capability Worker therefore registers an inert `fetch()` handler
that always returns 404. `workers_dev` and preview URLs remain disabled and no
route points at the services; the handler satisfies deployment validation but
does not create a product or operator HTTP surface.

The completed conversation authority cutover no longer puts a D1 phase lookup in
front of every HTTP request or ordinary conversation route. Conversation creation still
reads D1 because it needs the authority generation for its durable creation
receipt. Socket ticket admission, object bootstrap, and background work retain
the reads that use the current generation or phase.

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

RPC exceptions are not a product protocol: Cloudflare preserves standard error
names and messages but not custom own properties. Every Terminal method
therefore returns a discriminated success/error value. The provider Worker
classifies Daytona not-found failures before they cross the boundary, and
submission callbacks return typed `TerminalToolError` refusals by value. The API
reconstructs the local error types that existing cleanup, recovery, and tool
logic consumes.

## Invariants and contracts

- Production code, tests, and scripts use static imports. A dynamic `import()`
  is not a startup strategy.

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

- The Global metadata Worker is the only OpenRouter pricing and model-window
  cache writer. API inference reads the shared public-metadata KV and never
  refreshes either catalog inline. Each resident `AgentLoopDO` retains its
  model-window snapshot in memory after one KV read.

- Every successful version is tagged with the immutable Git SHA that passed the
  workflow's complete verification matrix.

- Promotion uses the unique version IDs captured from that workflow attempt,
  never the non-unique Git SHA tag. A retry can safely upload another set.

- The engineering MCP is a consumer of named entrypoints in both regional API
  Workers. It deploys only after both selected regions are healthy; a partial
  regional recovery leaves the existing MCP version untouched.

Global resource names, IDs, placement, and jurisdiction stay unchanged. Deploy a named service before its caller; apply destructive migrations only after the compatible API is serving.

## Boundaries and non-goals

The public API remains one logical service per region. Capability Workers are
internal implementation boundaries, not user-facing APIs and not independently
selected product regions.

## Failure modes and limits

- Cloudflare uses error 10021 for two different failures; read the message.
  - **Startup budget.** The Worker's static graph exceeds Cloudflare's hard
    startup budget. Inspect its retained CPU profile and move a coherent
    stateless capability behind a typed service boundary; do not retry until
    timing happens to pass.
  - **`Pipeline binding error. Please try again later`.** A Pipelines
    control-plane fault on a Worker with a Pipeline binding (the Global API),
    not anything in the graph. The versioned upload step retries it once after
    60 seconds; the direct deploy path does not retry. If it still fails, rerun
    the failed job of the newest API run on `main` once; if that fails too,
    check the pinned streams with `pnpm exec dotenv -e .env.local -- node
    scripts/ensure-cloudflare-inference-lakehouse.mjs --check` before retrying
    again.

- A missing target Worker makes caller deployment fail. The workflow deploys or
  uploads target services first.

- If any ordinary version upload fails, no region is promoted.

- A failed pricing cron leaves every prior valid per-model KV record usable. A
  missing or malformed record makes Bind omit that Azure candidate rather than
  send an unpriced request.

- A failed model-window refresh leaves the previous snapshot usable. Missing
  or malformed metadata uses the harness's 200,000-token compaction window.

- Cloudflare Versions cannot apply Durable Object migrations or update a
  Container image. A Wrangler-config or Crash Symbolicator change therefore
  uses direct service-first deployment. An untagged or divergent production
  baseline also fails safe to direct mode.

- No repository-authored millisecond ceiling is used. Local CPUs differ from
  Cloudflare's; the platform upload is authoritative and the structural service
  boundaries are machine-independent.

A missing binding or failed health check stops the release through the existing workflow gates. No provisioning generator or new policy layer is introduced.

## Testing

- `pnpm --filter @rally/api check:telemetry-startup-boundary` reads Wrangler's
  emitted bundles and requires the PostHog SDK, core, and adapter modules to be
  absent from configured regional APIs. The provider build and production-entrypoint
  tests prove the private Worker independently without freezing its SDK internals.

- Attachment tests run the same statically imported codec implementation behind
  an injected document-processing contract.

- Terminal provider tests continue to prove Daytona behavior directly; RPC
  client tests prove session reuse, callback, cancellation, and argument
  delegation. A real-workerd auxiliary Service Binding proves `RpcTarget`
  state and retained callbacks survive the entrypoint call that created them.

- A real-workerd telemetry-delivery Service Binding test proves typed telemetry and nested
  crash rows cross the RPC boundary by value; adapter tests still inspect the
  exact destination payloads without a provider network call.

- PR CI retains the new telemetry-delivery Worker profile for seven days; deployment
  retains all eight exact-artifact profiles on success or failure.

Run lint, typecheck, the affected script and runtime tests, and the repository suite when shared contracts change. Dry-run builds exercise each static graph.

## Regional impact

Global is the only configured deployment. Additional deployments need configuration and provisioned Wrangler bindings.

## Operations

- **Direct:** for first creation, Wrangler or Container state changes, or an
  unknown/divergent baseline, deploy each regional service before its API and
  retain the same health barriers.

Normal production rollout is `deploy-api.yml`. It builds and profiles all
selected service graphs, materializes Global lakehouse bindings, discovers the
active source tags, and selects versioned promotion or a service-first direct deployment when platform changes require it. The `0106_configurable_regions.sql` migration runs after the compatible Worker because it removes retired telemetry tables.

The rollout applies the dedicated `MESSAGE_ISSUES_DB` migration chain before
promoting the API Worker that accepts Oopsie reports; see [message issues](message-issues.md).

After the configured deployment is healthy, the workflow provisions and deploys the
Access-protected engineering MCP. This ordering is also the first-release
bootstrap for `EngineeringInspectionBridge`: the caller cannot go live before
all named entrypoints exist. See [`engineering-mcp.md`](engineering-mcp.md).

## Performance and cost

The failed monolith uploaded about 12.3 MiB and had no dependable startup
margin. With Wrangler 4.126.0, the static service split makes the API graph
about 7.3 MiB, the document graph about 2.8 MiB, and the Terminal graph about
2.3 MiB. A later 7.4 MiB API graph again failed production upload with error
10021; moving its Global-only PostHog graph reduced both API artifacts to about
7.16 MiB and produced a 248 KiB telemetry-delivery Worker with a 6 ms local active-startup
sample. Repeated local active-startup samples varied from 93–290 ms for the
API, 7–14 ms for documents, and 18–28 ms for Terminal; these values diagnose
graph shape and are not predictions of Cloudflare CPU time.

The API graph also constructs strict and loose Zod object schemas with their
mode-specific constructors. `z.object(shape).strict()` and
`z.object(shape).passthrough()` first build a default object schema and then
derive another schema at module scope; `z.strictObject(shape)` and
`z.looseObject(shape)` preserve the validation modes without that intermediate
startup allocation. A lint rule covers the API and its statically linked
contracts, agent-harness, and connector packages.

Six alternating local Wrangler 4.126.0 samples against unchanged baseline
`87b1a0c` and the direct-constructor working tree measured mean active startup
at 183.6 ms versus 162.7 ms, and mean garbage collection at 83.0 ms versus
61.6 ms. The paired result supports the allocation mechanism; like the broader
ranges above, it is diagnostic evidence rather than a platform-time promise.

The remaining cold, capability-specific schema graphs use regular Zod 4 lazy
shells backed by memoized factories. Static imports and exported schema
contracts stay intact, but telemetry property schemas, WorkspaceDO protocol
families, engineering inspection, object-port envelopes, and selected tool
catalog schemas no longer construct their inner graphs together at module
evaluation. Tool JSON Schema conversion follows the same first-use boundary.
Twelve sequential Wrangler 4.126.0 profiles of the exact API bundle before and
after this change measured median active startup at 154.2 ms and 131.5 ms,
respectively; median garbage collection was 60.8 ms and 59.6 ms. The new bundle
was 7,169.37 KiB uncompressed versus 7,155.96 KiB before. These local values
diagnose the trade: a small code-size increase and a first-use cost for each
capability in exchange for less startup evaluation. They are not Cloudflare CPU
limits or production latency predictions.

The single largest remaining source of that startup work was Zod itself, and
zod 4.5 removed most of it in the library rather than in our source. It moves a
schema's methods onto memoized prototype getters, so a schema that is never
narrowed or transformed never allocates the bound closures for the methods that
would do it. Six alternating local Wrangler 4.126.0 profiles of the exact Global
API bundle under zod 4.4.3 and 4.5.4 measured median active startup at 351.7 ms
versus 203.9 ms and median garbage collection at 62.4 ms versus 19.7 ms; the
bundle fell from 8,102.83 KiB to 7,544.76 KiB uncompressed and 1,624.29 KiB to
1,542.76 KiB gzipped. Importing `@rally/contracts` alone — 325 exported schemas —
retained 31.7 MiB of heap under 4.4.3 and 16.6 MiB under 4.5.4. As with every
figure above, these are local diagnostics of graph shape, not platform-time or
platform-memory promises.

**Compare only within a pair, never across the paragraphs above.** Each pair was
profiled in its own session, on its own machine, against its own tree, and only
the two numbers inside one pair share those conditions. The 4.4.3 side of the
pair immediately above is the same library the deferred-schema paragraph
measured, yet reads 351.7 ms against its 131.5 ms, and 8,102.83 KiB against its
7,169.37 KiB. Neither gap is a regression in what those paragraphs describe: the
timings come from different hardware, and the 933 KiB is roughly 180 commits of
product landing on `main` in between. It follows that every absolute figure here
ages out of date as soon as the tree moves, and that a later paragraph's baseline
is not a measurement of the earlier paragraph's result. Re-measure both sides
yourself before drawing a conclusion across them.

Service Bindings add no monetary charge or network hop by default. A document,
Terminal, or Global telemetry-destination operation adds a Worker invocation
and subrequest, while ordinary API requests no longer initialize those provider
libraries. That cost is bounded to the capability that uses it and is visible
as a platform invocation.
The metadata graph runs pricing once per hour in Global and performs sixteen
OpenRouter catalog reads plus sixteen small KV writes. The hourly tick reads one
context-window KV snapshot and fetches the model catalog only when that snapshot
is missing or at least 24 hours old. Inference performs the pricing KV reads
for Azure-bound models in its route plan; each
resident Channel agent reads the window snapshot once.

## Changelog

### 2026-10-06 — Retry the Pipeline binding form of error 10021 once

**What changed:** The Global version upload retries once, after 60 seconds,
when Wrangler's output contains `Pipeline binding error`. Every other upload
failure, including the startup-budget form of 10021, still fails the step at
once.

**Why:** The deploys for #1107, #1113 and #1115 each failed uploading
`avalon-api-global` with `Pipeline binding error. Please try again later
[code: 10021]`, and each time the next run succeeded with no change to the
Worker or the pinned streams. Every miss needed someone to rerun by hand. This
document also told readers that any 10021 was a startup-budget overrun that must
not be retried, which sends them looking for code to move out of a graph that
was never the problem.

**Considered and rejected:** Retrying every 10021, which would hide a real
startup-budget overrun behind a slower failure.

**Consequences:** A deploy that hits this error now takes up to 60 seconds
longer before it either recovers or fails. The retry keys on Wrangler's message
text, so a change to Cloudflare's wording silently turns the retry off; the
failure then looks exactly as it did before this change. The count and the wait
are the team's numbers, not derived from any Cloudflare limit; if the retry
starts failing too, raise them or take a ticket to Cloudflare.

Shipped in #1124.

### 2026-09-23 — Move stable metadata and obsolete cutover checks off request reads

**What changed:** The existing Global scheduled metadata Worker's hourly tick
seeds a missing OpenRouter context-window snapshot and refreshes it after 24
hours in shared KV. The Channel agent retains a successful read in object memory
for its lifetime and retries missing or failed reads on the next run. The
top-level HTTP handler and ordinary Channel service and route paths no longer read the
completed cutover row. Creation retains its generation read.

**Why:** The old cold catalog fetch delayed first inference and repeated work
after Worker isolate eviction. Reusing the existing scheduled Worker and KV
keeps a separate metadata service out of the request path. A stale window may
delay or advance advisory compaction until the object is evicted; the provider
still enforces its actual input limit. The one-time DO cutover has already
completed, so rereading its phase on every HTTP request and again within
Channel services charged the member for a completed migration check.

**Considered and rejected:** A new Worker and KV namespace would add deployment
and operations work for metadata the existing Global scheduler and namespace
already serve. An additional deployment switch for ordinary Channel routes
would recreate a maintenance control with no identified operation that needs it.

**Consequences:** One hourly trigger handles pricing and a due context-window
refresh. The metadata Worker remains the only writer; inference must tolerate a
missing snapshot until the next hourly tick or a failed refresh. Changing the
D1 phase alone no longer closes every HTTP route. Generation and phase consumers at creation,
socket admission, and background boundaries still read D1 where that value
drives the operation.

### 2026-09-14 — Configurable deployment isolation

The release deploys Global capability services and API, applies Worker-first migrations, verifies health, then updates shared ingress and administrative callers. The small deployment map drives application routing; Wrangler still owns hosted resources. The one-time geographical bootstrap ordering is removed because there is only one configured deployment.

### 2026-09-12 — Give Ashby public ingress its own startup graph

**Why:** The user requested connector Workers after API startup and bundle growth had already cost an engineering day. The public ingress graph must stay independent while credentials and product authority remain regional.

**Consequences:** Keep the ingress free of API, registry and agent imports. Apply the same configured provider body limit before buffering/RPC and in regional ingress. Both bridges must exist before ingress deployment; partial regional recovery leaves the shared deployment unchanged.

PR #737. Design: [connector installation lifecycle](PRDs/2026-09-12_connector-installation-lifecycle/prd.md).

### 2026-09-09 — Bound and recover early-access operations

**Why:** Public acquisition needs predictable failure and recoverable operator actions before launch, without imposing account approval or building a campaign system.

**Consequences:** [Private access](private-access.md) owns configuration, undecided numerical limits, and recovery procedures. PR #637.

### 2026-09-09 — Deploy the access API before its public form

**What changed:** Global binds the existing desktop-release bucket for streamed
bearer downloads. Migration `0101_private_access.sql` introduces the intake,
complete grant schema and configurable intake rate buckets.

**Why:** The site must reach a migrated, healthy request endpoint as soon as its
email form is published. Independent merge-triggered workflows do not enforce
that ordering themselves.

**Considered and rejected:** Merely documenting migration order while publishing
the site first would expose a broken form. For this first rollout, dispatch the
verified API revision through the existing deployment workflow and confirm its
health before merging the site/Ace change; later merge deployments are idempotent.

### 2026-09-06 — Bundle and share the search tokenizer

**What changed:** Corrected the deployment description for bundled Qwen assets
and lazy, synchronous tokenizer initialization once per isolate.

**Why:** Runtime asset downloads failed during backfill, and separate tokenizers
for overlapping Queue deliveries exceeded the isolate memory limit. The model
now ships with the Worker and is shared without retaining request I/O or input
fragments. This supersedes the fetching description in the search-capture entry.

**Considered and rejected:** A tokenizer per delivery duplicates the same public
vocabulary; module-startup parsing would spend the startup budget before search
is used. Both regional startup profiles still gate deployment.

**Consequences:** No new binding, secret, region, or chunk-policy configuration.
See [text search](text-search.md) for the lifecycle and memory trade-offs.

### 2026-09-05 — Search capture binding

**What changed:** Both regional Workers gained Browser Run and shared search configuration.

**Why:** Indexing must be deployable without flooding the control-effect dead-letter queue before settings exist.

**Considered and rejected:** Unconfigured jobs are retained at producers rather than published into guaranteed retries.

**Consequences:** Configure keys and token budgets, wake objects, and verify indexing separately from schema reports.

### 2026-09-02 — Take zod 4.5's prototype memoization for API startup headroom

**What changed:** The `zod` catalog entry resolves to 4.5.4 instead of 4.4.3. No
source changed. The lockfile edit is confined to zod's own resolution so that the
floating ranges elsewhere — `wrangler`, `workerd`, `miniflare`, `typescript-eslint`,
and others that a full `pnpm update` would have carried along — keep the versions
this deployment was profiled against.

**One validation contract narrowed with it, and it is not a memory change.**
zod 4.5 made seconds mandatory in `datetime()`. `TimestampSchema` in
`packages/contracts/src/index.ts` is `z.string().datetime({ offset: true })`, and
`.datetime(` appears at 113 non-test call sites across 42 files, so the narrowing
is repository-wide:

| Input | 4.4.3 | 4.5.4 |
| --- | --- | --- |
| `2026-09-02T12:30:00Z` | accept | accept |
| `2026-09-02T12:30Z` | accept | **reject** |
| `2026-09-02T12:30+01:00` | accept | **reject** |

It reaches the emitted JSON Schema too: the optional-seconds group
`(?::[0-5]\d(?:\.\d+)?)?` became mandatory `:[0-5]\d(?:\.\d+)?`. The same applies
to bare `datetime()`, `{ local: true }`, and `z.iso.datetime()`.

**The exposed surface is a string somebody else wrote, and mostly that somebody
is a model.** Anything Rally serializes goes through `Date.prototype.toISOString()`
— 440 non-test call sites — which always emits seconds, so persisted state,
cursors, and spool files round-trip unaffected. What does not is the fifteen
`datetime()` tool-argument schemas in `packages/connectors`: `calendar.list_events`
takes required `timeMin`/`timeMax` through a throwing `.parse(rawArgs)`, and
`github.commits.list`, `github.issues.list`, the Granola date filter, and Drive's
`modifiedAfter` take optional ones. A model writes those strings token by token
rather than through `toISOString()`, so a plausible `…T14:00Z` for "this
afternoon" is now a hard reject where it used to parse. The stricter `pattern` does
travel to the model in the tool's JSON Schema, which is the mitigation, but it is
a pattern a model can ignore. Inbound third-party timestamps — `created_at` on the
Resend webhook — are the smaller exposure: RFC 3339 has always required seconds,
so a conforming producer was never sending the form that now fails.

**A green suite does not clear this**, which is the part worth remembering. Every
gate passed on the first run of this bump because no test in the tree exercised a
second-less timestamp. `packages/contracts/src/index.test.ts` now pins the
boundary in both directions so the next movement in either is a test failure
rather than a discovery.

**Why:** Both entries below reduced startup work by restructuring our own schema
construction, and the profiles that justified them still attributed the bulk of
active startup to Zod. 4.5 attacks the same cost inside the library: methods now
live as memoized getters on the prototype and bind themselves on first access, so
an unused method costs nothing. Six alternating local profiles of the exact Global
API bundle put median active startup at 351.7 ms under 4.4.3 and 203.9 ms under
4.5.4, with median garbage collection falling 62.4 ms to 19.7 ms and the bundle
falling 558 KiB. That margin is the point: the API graph is the artifact that has
twice failed production upload with error 10021, and this is the largest single
reduction to it that costs us no code.

**Considered and rejected:** Running `pnpm update zod -r`, which is the ordinary
way to do this. pnpm re-resolves every floating range once anything in the graph
moves, so it also bumped `wrangler`, `workerd`, `miniflare`, `@cloudflare/workers-types`,
`typescript-eslint`, `react-router`, and six others — the Workers runtime included —
turning a dependency bump into an unbisectable one. Pinning the catalog to `^4.5.4`
was rejected separately: `latest` is the entry this repository deliberately keeps,
and a pin would have to be maintained by hand at every future bump.

**On repeating the narrow lockfile edit:** it is safe only because zod has no
dependencies of its own and every dependent's declared range accepts the new
version — but "dependent" is two populations, and `--frozen-lockfile` vouches for
neither. Five packages take zod as a **peer** (`@hono/zod-validator`, `openai`,
`@modelcontextprotocol/sdk`, `zod-to-json-schema`, `@juno-ai/bind`) and appear in
the lockfile with a `(zod@…)` suffix. Three take it as a plain **dependency** and
carry no suffix at all: `@openrouter/sdk` at `^3.25.0 || ^4.0.0`, and
`@modelcontextprotocol/core` and `@modelcontextprotocol/server` at `^4.2.0`.
`pnpm install --frozen-lockfile` validates each importer's `package.json` against
the lockfile; it does not validate transitive ranges, so those three are exactly
the edits it cannot check. Read them out of the published manifests by hand, as
was done here, or the check that looks like proof is not covering the part most
likely to be wrong.

**Consequences:** zod's memory and startup profile is now good enough that the
`deferredZodSchema()` lazy shells from the entry below buy considerably less than
the 22.7 ms they were measured to buy. That machinery is not removed here — this
change is a version bump and nothing else — but whoever next profiles API startup
should re-measure it before assuming it still earns its complexity. The lockfile
carries a hand-narrowed zod resolution; the next `pnpm update` anyone runs will
still produce the wider re-resolution described above, which is a decision to make
deliberately rather than as a side effect.

### 2026-09-01 — Defer cold schema graphs to capability use

**What changed:** The API startup graph now constructs large telemetry,
WorkspaceDO protocol, engineering inspection, GitHub, object-port, multimodal,
and harness schema families through memoized regular-Zod lazy shells. GitHub and
model-tool JSON Schema conversion is also deferred and cached. The schema
exports, inferred TypeScript types, validation rules, refinements, issue paths,
and regular Zod English messages remain unchanged.

**Why:** After direct object construction removed one intermediate allocation
per eligible schema, the retained profile still showed substantial Zod work at
module evaluation. The remaining largest families belonged to mutually
independent capabilities, so constructing all of them before any request paid
for work no individual startup needed.

**Considered and rejected:** Dynamic imports obscure the deployable graph and
remain prohibited. Zod Mini changes default error localization. Per-request
schema factories repeat the same work. A proxy pretending to be a Zod schema
would depend on private internals; the public `z.lazy()` surface preserves Zod
behavior instead.

**Consequences:** Each deferred inner graph is built on its first parse, unwrap,
or JSON Schema conversion and then reused within the isolate. The cache contains
only deterministic schema data, never request or environment state. Twelve
before-and-after local profiles reduced median active startup from 154.2 ms to
131.5 ms; this is diagnostic evidence, not a platform timing guarantee.

### 2026-09-01 — Remove intermediate Zod object schemas from API startup

**What changed:** The 1,132 direct strict and loose object constructions in the
API Worker's production source scope now use Zod's mode-specific constructors,
and an autofixable lint rule preserves the invariant.

**Why:** The retained startup profile for failing commit `87b1a0c` attributed
258 ms of 507 ms active time to Zod schema construction and another 177 ms to
garbage collection. Direct constructors remove one avoidable schema allocation
from each eligible construction; the top-level subset is paid during startup.
The validation contracts do not change.

**Considered and rejected:** Changing Zod import syntax and marking the package
side-effect-free did not make the statically reachable schemas disappear from
the bundle. Dynamic imports would move startup work into requests and violate
the static-dependency rule. A machine-specific timing assertion was rejected in
favor of Wrangler's profile of each deployable Worker artifact.

**Consequences:** Direct chained object-mode construction, including Zod 4's
`.loose()`, is a lint error in the API startup graph. Existing-schema and
further-derived mode changes remain explicit and untouched. Startup profiles
remain the evidence for whether the whole deployable graph has adequate
platform margin. Six alternating local samples reduced mean active startup by
20.9 ms and mean garbage collection by 21.4 ms on the implementing machine;
those values are not a deployment limit.

### 2026-09-01 — Global telemetry delivery gets one shared startup graph

**What changed:** The Global API now sends already approved telemetry, crash,
JavaScript-exception, and profile batches through the explicit typed
`TELEMETRY_DELIVERY` binding. The PostHog SDK and destination mapping are
statically imported only by a new Global-only Worker whose identity is shared
across telemetry destinations. RPC results are keyed by destination so future
fan-out can keep acknowledgement and retry independent. Deployment builds,
profiles, uploads, and promotes that service before the Global API, bringing the
release to eight static artifacts.

**Considered and rejected:** Retrying the unchanged upload leaves the one-second
platform race intact. Request-time imports violate Rally's static-import rule
and move initialization into customer traffic. Shaving individual adapter
imports would leave the provider SDK in both API graphs. Naming the service for
PostHog was rejected because each later destination would invite another Worker
and rollout edge. Moving the token on first creation was rejected because the
deploy workflow cannot provision a secret onto a Worker that does not exist yet;
the existing secret can cross the private call without creating another stored
secret.

Shipped in #471.

### 2026-08-30 — Disambiguate the engineering MCP deployment script

**What changed:** The API workflow now invokes the engineering MCP package's
deployment script with pnpm's explicit `run deploy` form, and its workflow test
requires that exact command.

**Why:** Pnpm 11 treated the prior filtered `deploy` invocation as pnpm's own
package-deployment command and stopped after the configured API were healthy,
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
full release deploys it only after configured deployments API health. The post-deploy
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
