# Implementation plan: regional product telemetry and crash reporting

> Created 2026-08-12.
>
> Requirements: [PRD](prd.md)
>
> Architecture: [design](design.md)
>
> Research: [research](research.md)

## Delivery method

This feature will be built from two deliberately small foundations—the executable tracking contract and the regional persistence/policy primitives—and then as tested vertical slices. The first slice carries one anonymous onboarding event and one authenticated server outcome all the way from their source through durable regional acceptance to the EU sink or a fake PostHog endpoint. Each later slice expands that proven path rather than building every producer before any destination works.

Every checklist item follows red-green-refactor: add the smallest test that expresses the next observable contract, run it and retain the expected failure, implement only enough production code to pass it, then refactor under the green test. A phase is not complete merely because its unit tests pass; its acceptance gate names the integration, packaged, configuration, or operational evidence that must also exist.

The implementation remains dark until the region, preference, identity, durability, and negative-privacy fixtures all pass. Telemetry must never become part of a product transaction: each integration test that observes a signal also runs the same action with the reporter, regional queue, or destination disabled and proves that the product result is unchanged.

### Test layers

| Layer | Purpose | Primary location |
| --- | --- | --- |
| Contract and golden fixtures | Prove the event registry, exact property allowlists, compatibility, PostHog mappings, RPC projections, and prohibited negative space | `packages/contracts/src/telemetry*.test.ts`, `apps/api/src/telemetry/*.test.ts` |
| Pure policy and storage tests | Prove consent state machines, identity epochs, clock handling, retry/deadline rules, redaction, fingerprinting, local spool eviction, and crash-generation transitions with fake clocks and deterministic I/O | desktop/API module tests beside production code |
| Worker integration tests | Exercise authenticated/bootstrap HTTP routes, D1 migrations and transactions, named RPCs, R2 object handling, scheduled retention, queue recovery, and regional configuration in the Workers pool | `apps/api/src/**/*.workers.test.ts` |
| Desktop integration tests | Exercise the preload/main IPC boundary, settings synchronization, lifecycle observers, renderer semantic calls, error candidates, and action non-interference | `apps/desktop/src/**/*.test.ts(x)` |
| Packaged fixtures | Prove real Electron/Crashpad behavior, inactive-database rotation, two-launch crashes, forced main/preload/renderer errors, and private artifact matching on every release target | `apps/desktop/scripts/telemetry-*.mjs` plus release workflow jobs |
| Deployment invariants | Prove Global-only PostHog configuration, EU egress denial, distinct regional queues/R2/bindings, no telemetry Analytics Engine binding, artifact publication order, and immutable migration/config expectations | repository script tests and Wrangler dry runs |
| Manual acceptance | Inspect the real Settings control and disclosures, exercise opt-out/restart behavior, and inspect only synthetic golden telemetry in regional stores/PostHog | `docs/e2e.md` procedure and captured evidence |

Every non-trivial test or build command writes its complete output to `/tmp`. A focused test must first fail for the intended assertion, not because of a syntax, import, environment, or fixture error.

The PRD [state](state.md) advances to `in progress` with the first implementation change. `docs/telemetry.md` is created and registered with the first production slice, and every phase updates the owning architecture, data-model, regionalization, security, runbook, E2E, or module-document sections and newest-first changelogs in the same change that alters those contracts. Phase 9 verifies and completes that documentation; it does not defer it.

## Phase 0 — Prove the hard platform boundaries

- [ ] **Red:** add a packaged Crashpad probe that fails until a packaged Electron process can start Crashpad without a `submitURL`, place its database under a generation directory selected by Rally, crash a renderer, and leave a completed report that a later process can enumerate only after the first process exits.
- [ ] **Green:** implement the minimum test-only launch modes and database inspection helper needed by the probe; do not add production upload yet.
- [ ] **Red:** extend the fixture to fail until the entire inactive database can be atomically rotated before a new Crashpad handler starts, the fresh handler writes to a distinct generation, and two consecutive crashing launches preserve two independently processable generations.
- [ ] **Green:** establish the generation directory/manifest format and startup ordering that production will reuse. Verify locked, incomplete, corrupt, expired, and invalidated generations fail closed without reading or mutating a live database.
- [ ] **Red:** add artifact fixtures that fail until main, preload, and renderer JavaScript frames map through the exact packaged bundle/source map without source excerpts, and until a native macOS arm64 minidump can be parsed against the matching private symbols to an owned frame in the actual deployable Rally-operated processor environment.
- [ ] **Decision gate:** select and document the production Global native-compute surface before the local symbolication fixture can pass. Provision its service identity, queue/work handoff, regional raw-dump and private-symbol access, network egress policy, CPU/memory/time limits, concurrency/backpressure, and result callback/persistence boundary. A local CLI is test tooling only and cannot satisfy this gate. If no approved custom surface is viable, stop the native path and record the Sentry/Bugsnag or other architecture fallback decision before dependent production work continues; do not ship an outbox with no processor.
- [ ] **Green:** prove the symbolication toolchain and its release/debug-identifier contract end to end through that production-shaped compute surface: opaque work item to authenticated processor, region-bound R2 reads, resource-limit enforcement, sanitized result persistence, retry/idempotency, and denial of cross-region artifact access. If EU native tooling cannot execute in the isolated Cloudflare environment, prove the explicit `unsymbolicated` result and no-egress path instead, as the PRD permits; Global must still prove the supported owned-frame path.
- [ ] Record measured startup-gate latency and packaged fixture resource usage so later work is constrained by evidence rather than an assumed Crashpad API.

**Acceptance gate:** the real packaged macOS arm64 target (the only currently released target) proves start-before-renderer ordering, no credential-bearing URL, inactive database rotation, two-launch durability, expiry/invalidation purge, and JavaScript artifact matching. The deployable Global processor—not only a developer machine—accepts the synthetic work item, reads only its regional dump/symbols, persists a sanitized owned-frame result, and survives retry/resource-limit fixtures. The fixture is runnable locally and is wired into desktop release CI before the production reporter depends on it. Any newly supported OS/architecture must add the same fixture before release.

## Phase 1 — Freeze the tracking and privacy contract

- [ ] **Red:** add registry tests for unique names and versions, required owner/question/authoritative source, allowed source and identity-scope exhaustiveness, category, priority, sampling, retention, compatibility note, and explicit destination treatment.
- [ ] **Green:** add `packages/contracts/src/telemetry.ts` with the checked-in TypeScript registry, discriminated event schemas, canonical envelope schemas, typed semantic inputs, breadcrumb/exception/crash report schemas, batch limits, and UUIDv7/time/context validation. Handwrite facades and mappings; add no generator and expose no generic `capture` API.
- [ ] **Red:** add golden invalid fixtures for unknown event names/properties, arbitrary strings, oversize arrays/nesting, schema bombs, incompatible unversioned changes, forbidden property classifications, direct identifiers, IP/location, URL/query/header/body data, secrets in every rejection field, and direct profile fields outside identify/group jobs.
- [ ] **Green:** add prohibited-key/value classification and fixed rejection codes whose logs/storage never include rejected values. Server-derived release and trusted fields must be separate from the untrusted envelope.
- [ ] Define the initial activation and reliability registry: content-free launch/session/process/update/spool/API outcomes; explicit onboarding, screen, workspace, work-stream, run, and connector intents/outcomes; JavaScript diagnostic occurrences; and native crash upload state. Each state-changing funnel step gets a client intent and authoritative server outcome joined by `operation_id`.
- [ ] **Red/green:** add exact PostHog golden mappings for ordinary captures, anonymous `$process_person_profile: false`, `$identify`, later person updates, workspace group identify, JavaScript exception, and full structured native crash. Negative fixtures prove the adapter cannot see a raw request, dump, artifact, absolute path, unsanitized field, or extra person/group property.
- [ ] With the first production contract, advance [state](state.md) to `in progress`, create/register `docs/telemetry.md` in the required module-document shape, and record the contract/privacy invariants plus initial changelog entry. Update it phase-by-phase thereafter.

**Acceptance gate:** compile-time exhaustiveness and runtime fixtures reject every unregistered or privacy-expanding shape, while the initial client/server funnel and diagnostic fixtures parse successfully. A repository scan proves renderer code has no PostHog dependency/key, arbitrary capture API, or telemetry transport.

## Phase 2 — Add regional persistence, identity, preference, and lifecycle primitives

- [ ] **Red:** add migration tests that fail until the new schema provides immutable random per-environment/per-region analytics IDs on authoritative users/workspaces; canonical Global preferences and monotonic versions; EU mappings for random region-bound preference/telemetry handles; fixed onboarding journey routes; accepted events and payload hashes; ordered destination jobs; identity transition/profile/group jobs; delivery receipts; crash indexes/reports; EU semantic rows and flat fingerprint contributions; and absolute deletion deadlines.
- [ ] **Green:** add the next immutable D1 migration and focused repositories. Put sanitized replay projections in D1, raw regional dumps and private artifacts in separate R2 prefixes/buckets, and never create a region-pending table or materialized EU issue table.
- [ ] **Red/green:** prove random IDs allocate once, remain stable across retries/profile changes, never derive from raw IDs, differ by region/environment, cascade or participate in deletion correctly, and are never returned as provider authority to desktop.
- [ ] **Red/green:** implement compare-and-set preference operations and the regional projection state machine. Disable writes regional-off first and canonical state second; enable stays fail-closed until both acknowledge the new version; missing, stale, partial, or conflicting state permits essential events only.
- [ ] **Red/green:** implement immutable 90-day internal event/job/receipt deadlines, 90-day dump/full-report deadlines, and per-occurrence 13-month EU semantic/fingerprint deadlines. Retries, replay, recurrence, and acknowledgement cannot renew them. Scheduled deletion and reconciliation tests advance fake time beyond every ceiling and verify primary rows, indexes, correlations, and R2 objects disappear.
- [ ] Add regional, role-restricted, audited raw-crash lookup and a restricted EU query that groups surviving contribution rows at query time by fingerprint. It must not persist issue/regression/workflow state.

**Acceptance gate:** both local regional databases migrate from the current schema; integration fixtures prove stable identities, optimistic preference conflict handling, deadline non-renewal, complete deletion/reconciliation, and query-time EU grouping with no cross-region identifier reuse.

## Phase 3 — Build durable ingest and destination delivery

- [ ] **Red:** add normal authenticated batch-route tests for byte/count/depth bounds, strict parsing, trusted region/identity enrichment, clock-skew normalization, durable-before-ack semantics, identical duplicate acknowledgement, conflicting duplicate rejection, forged region rejection, and non-blocking behavior.
- [ ] **Red:** before broadening any producer set, add a walking-skeleton integration fixture for one anonymous onboarding event and one authenticated API outcome. It must fail until Global routing reaches a fake PostHog endpoint, EU routing reaches only the internal sink, both acknowledge only after durable acceptance, the shared `operation_id` survives, and destination failure leaves the product response unchanged.
- [ ] **Green:** add regional telemetry routes and a collector service that transactionally records accepted envelopes/outbox state before acknowledging; make the walking skeleton pass before adding other event types. Queue messages carry only trusted region plus opaque row ID; a scheduled repair closes the commit-before-send window.
- [ ] **Red/green:** implement creation-time and delivery-time preference checks. Opt-out deletes attributable undelivered product, diagnostic, transition, person-profile, and group-profile jobs; essential content-free rows continue. Unknown policy fails closed. Unlinked anonymous accepted rows remain unlinked until their original deadline.
- [ ] **Red:** add ordered identity job tests proving an unresolved epoch transition cannot be superseded or delivered after later person events; newer allowlisted name/email may coalesce only while preserving `$anon_distinct_id`; later profile/group jobs may supersede only after transition acknowledgement or terminal failure.
- [ ] **Green:** add the ordered identity/profile job processor and terminal alert state without blocking the product path.
- [ ] **Red/green:** implement a small fetch-based Global PostHog adapter against official batch/capture semantics: stable destination UUID, normalized timestamp, GeoIP disabled, correct person processing, workspace group, exact `$identify` direction, low batch ceiling, `Retry-After`, retryable 408/429/5xx/network handling, terminal other 4xx, deadline-aware backoff, and a circuit breaker. Store only content-free response class/latency/request ID.
- [ ] **Red/green:** implement the EU internal adapter in isolated regional D1/R2 with no PostHog hostname, key, code path, telemetry Analytics Engine dataset, or Global replay payload. Add deployment invariants that fail if EU gains any of those surfaces.
- [ ] **Red/green:** add a role-restricted regional replay command/service. It preserves the original event ID, identity resolution, payload hash, route, and immutable deadline; rechecks subject existence and current preference at delivery; and rejects expired, deleted, suppressed, payload-conflicting, unauthorized, or cross-region work. Replay audit rows contain only opaque IDs, fixed result codes, and the original deadline.
- [ ] **Red/green:** instrument content-free destination delay/backlog states from accepted row through acknowledgement, retry, terminal failure, suppression, and expiry without copying event properties into operational telemetry.
- [ ] Add destination-disabled and outage integration tests that preserve the product action, accepted row, measurable backlog/loss, and fixed deletion ceiling.

**Acceptance gate:** Worker integration tests prove a regional acknowledgement is durable, queue recovery works, Global golden records alone reach a fake PostHog endpoint, EU records terminate internally, retries/deduplication are deterministic, and both Wrangler configurations build with the intended distinct bindings.

## Phase 4 — Route onboarding and synchronize the account preference

- [ ] **Red:** add Global bootstrap tests for short-lived anonymous capability creation, epoch/schema/rate binding, coarse Cloudflare `isEUCountry` reduction, existing binding and explicit-selection precedence, journey route fixation, and Global fallback for non-EU/unknown/timeout/network/malformed states. Assert that IP and detailed geolocation never enter arguments, storage, logs, events, or destinations.
- [ ] **Green:** add logged-out bootstrap and identity-session ingest modes. Route EU projections immediately through one named, schema-checked Global-to-EU RPC and Global projections to the local outbox. Persist no event holding area. Later workspace selection is prospective and never migrates or duplicates accepted history.
- [ ] **Red/green:** add a narrow named EU-to-Global control RPC with separate strictly parsed commands. Preference mutation carries only the random region-bound handle, boolean, expected version, and operation ID; journey authorization/closure carries only the Global-issued capability and expected EU route, and returns only route, anonymous epoch, and closed state. Keep the capability signing key Global-only. Extend activation/bootstrap responses with effective preference/version and the handle mapping without exposing analytics IDs.
- [ ] **Red/green:** test eligible Global login linking exactly one current anonymous epoch, exact PostHog `$identify` profile values, eligible explicit Global workspace group profile, abandoned-login/logout/account-switch epoch rotation, two accounts on one installation, EU pseudonymous linking, mismatched provisional/workspace routes, and no cross-region move.
- [ ] **Red:** add source-level integration tests for the initial onboarding/workspace API outcomes. They fail until the authoritative endpoint emits its registered result with the caller's operation ID, rejects client-chosen outcome fields, honors opt-out at creation and delivery, and returns the same product response when telemetry throws.
- [ ] **Green:** add API-native semantic emission for those onboarding/workspace outcomes through the same registry and collector. Do not add the production emission before the preceding tests demonstrate the intended red failure.

**Acceptance gate:** cross-region Worker fixtures prove immediate coarse routing, route fixation, exact RPC negative space, canonical preference propagation, one-time epoch linking, stable profile/group behavior, no pending store, no migration, and a queryable onboarding client-intent/server-outcome funnel in each route.

## Phase 5 — Add the Electron reporter, local policy, and settings control

- [ ] **Red:** add application-settings migration tests for a durable default-on `productAnalyticsEnabled`, last acknowledged preference version, pending local disable/enable state, and compatibility with old/corrupt files through the existing shared write queue.
- [ ] **Green:** extend the main-owned settings model, IPC validation, typed bridge, and authenticated Application settings UI. The single Product analytics switch explains semantic analytics, diagnostic stacks/breadcrumbs, native dumps, essential reliability, regional behavior, contact identity in eligible Global PostHog profiles, and restart-required dump cessation; onboarding gets no switch.
- [ ] **Red:** add pure policy tests for compiled ceiling AND local choice AND regional policy AND event rollout, including immediate offline opt-out, pending opt-in, bootstrap of an already-opted-out account, stale versions, logout persistence, multi-install refresh, and fail-closed resolution.
- [ ] **Green:** implement `TelemetryPolicy` and a high-priority preference mutation queue independent from telemetry. Disable applies and fsyncs locally before network; enable cannot collect until acknowledged.
- [ ] **Red:** add local spool tests for validated/sanitized rows only, single-writer crash-safe commits, count/byte/14-day bounds, startup and running expiry, essential-before-product eviction, backoff, acknowledgement deletion, corruption quarantine with external deadline metadata, logout/account switch, and opt-out purge.
- [ ] **Green:** implement the main-only spool and uploader under the application-data directory with restrictive permissions. It must not contain provider payloads, raw candidates, credentials, direct account/workspace IDs, or telemetry for two accounts in one epoch.
- [ ] **Red/green:** expose narrow preload methods for registered screen and product intents plus normalized error candidates. Main validates every IPC sender against a live Rally window and pinned origin. No method accepts an event name, arbitrary property dictionary, identity command, provider concept, or URL.
- [ ] **Red/green:** add lifecycle/session/unclean-exit instrumentation, typed router screen calls, and the first activation/action intent events. Define denominator eligibility once and prove preference changes mid-launch/session exclude that launch/session rather than reclassify it.
- [ ] **Red/green:** integrate the existing updater controller with registered check/download/apply/rollback result methods, and integrate local spool accepted/rejected/evicted/expired/quarantined/pressure transitions. Source-level tests prove bounded enums/durations only, rate limiting, correct policy class, and unchanged updater/product behavior if the reporter fails.
- [ ] **Red/green:** add a main-owned bounded developer telemetry inspector snapshot containing event name, schema version, policy class, allowed property names, effective route, validation result, and queue state. Expose it through a narrow read-only preload method only when Developer settings are available; redact diagnostic values and every identifying value. Add exact redaction/bounds/disabled-state tests and a Developer UI panel that cannot mutate, replay, or emit events.
- [ ] Exercise every instrumented product action with a throwing/no-op reporter and prove user-visible behavior is unchanged.

**Acceptance gate:** desktop tests prove the trust boundary, default/opt-out state machine, bounded spool, epoch isolation, essential-only behavior, update/spool signals, initial semantic signals, and a bounded read-only developer inspector whose values are redacted. A real Electron window is inspected for legibility and correct switch/inspector behavior, including the restart disclosure and absence of an onboarding control.

## Phase 6 — Cover JavaScript diagnostics, breadcrumbs, and process health

- [ ] **Red/green:** add a bounded typed breadcrumb ring containing only screen enum, lifecycle phase, and registered operation state. Test available/stale/unavailable sidecars and exclusion of console, arbitrary network, user text, paths, and payloads.
- [ ] **Red/green:** add main/preload/renderer/React error candidate handlers. Normalize error type to registered safe codes; reduce paths to bundle-relative identifiers; remove query/fragment, home/workspace paths, dynamic messages, source context, and arbitrary metadata before spooling. Opt-out emits only the corresponding content-free essential occurrence.
- [ ] **Red/green:** instrument renderer gone, unresponsive/responsive, main unhandled exception/rejection occurrence, preload initialization failure, inferred unclean exit, and recovery action with bounded roles/reasons/exit classes and per-launch rate limits.
- [ ] **Red/green:** add API middleware for duration/outcome-class emission on an explicit operation-name allowlist. It records no route template, URL, query, headers, body, raw status message, or unregistered operation, and telemetry failure cannot change or delay the response beyond the measured budget.
- [ ] Connect private JavaScript artifact publication and the regional symbolication processor. Golden tests verify all three packaged bundles and prove destination payloads contain mapped application frames but no source map, bundle, source excerpt, absolute path, or raw message.

**Acceptance gate:** focused and packaged forced-error fixtures cover main, preload, renderer, process health, and unclean exit both enabled and opted out, with stable fingerprints and exact privacy-negative output.

## Phase 7 — Ship native crash generation, ingest, and reporting

- [ ] **Red/green:** implement the bounded pre-window route gate before the first renderer: explicit workspace region first; otherwise affirmative EU means no Crashpad start or sidecar, while non-EU/unknown/timeout/failure/unusable response means a Global-designated generation. Failure after the bounded gate becomes a no-op and cannot delay later product actions.
- [ ] **Red/green:** turn the Phase 0 generation prototype into the production startup controller. Before starting Crashpad, purge expired/ineligible/corrupt material, rotate the entire inactive database plus manifest/sidecar, then start a fresh route-final database. Never open or mutate a live database and never configure a submit URL.
- [ ] **Red/green:** add the separately bounded upload spool and prioritized main uploader. Use normal regional session auth or a short-lived route-bound main-only bootstrap capability in headers, never URLs. Stop immediately on opt-out, fsync active-generation invalidation before applying opt-out/region change, purge it next launch, and define already-in-flight behavior accurately.
- [ ] **Red/green:** emit registered content-free crash-upload states for awaiting-restart, rotated, queued, uploading, accepted, rejected, retrying, expired, invalidated, evicted, corrupt, and lost. Source-level tests prove transitions are rate-limited, contain no file name/path/dump/profile value, and never affect upload control flow.
- [ ] **Red:** add multipart crash-ingest abuse tests for auth/capability scope, size/count/type, malformed minidumps, replay, forged route, floods, expiry, archive/compression bombs, and log/rejection privacy.
- [ ] **Green:** add regional crash ingest, R2 raw-dump write with server-derived 90-day deadline, content-free D1 index, and opaque queue/work item. Product response occurs only after durable raw/index acceptance, while parsing/symbolication remains asynchronous.
- [ ] Connect the proven release manifest, private per-region artifact publication, JavaScript/native processors, scrubbed structured report, stable fingerprint, Global PostHog crash mapping, EU full occurrence plus flat contribution, and authorized audited raw lookup. Missing/mismatched artifacts become a bounded parser state and alert; EU uses `unsymbolicated` when its approved compute path is unavailable.
- [ ] Add crash-free launch/session aggregation based only on continuously eligible denominators, with release/platform/architecture/region/channel and awaiting-restart/dropped/sampled/rejected/rate-limited/lost coverage.

**Acceptance gate:** packaged forced-crash fixtures demonstrate route gating, no EU pre-region artifact, Global fallback, two-launch rotation, invalidation/expiry, authenticated upload, raw regional isolation, matching private symbols, a complete sanitized Global PostHog report, EU internal occurrence/query behavior, and honest crash-free denominators.

## Phase 8 — Expand to the remaining complete product journeys

- [ ] Review the walking-skeleton onboarding/workspace signals, then cover the remaining state-changing invitation, workspace switching, work-stream creation, run execution, connector setup, and selected adoption flows. Add only registered semantic calls with clear product questions; do not instrument every click.
- [ ] For each reviewed funnel, first add a failing integration test for shared `operation_id`, stable client intent, authoritative API outcome, normalized ordering under clock skew, duplicate stability, opt-out suppression, and unchanged product result during telemetry failure; then add the two emission points.
- [ ] Add approved experiment/exposure properties only on events whose registry entry declares them. Flagship remains authoritative for product behavior.
- [ ] Add saved query fixtures or deterministic test queries for activation, client/server conversion, delivery quality, and crash-free eligibility. Queries must use analytics identities/correlation IDs, never raw platform IDs or content.
- [ ] Confirm the public site has no new SDK, identifier, endpoint call, behavioral event, or disclosure change.

**Acceptance gate:** the initial activation funnel has tested client intent and server-confirmed completion for every state-changing step, and failure/opt-out/cross-region fixtures remain green. Scope review confirms no mechanism-based capture or incidental public-site telemetry was introduced.

## Phase 9 — Operations, documentation completion, release, and final verification

- [ ] Audit the already-created `docs/telemetry.md` for its final code map, state machines, invariants, trust/region boundaries, data model, failure modes, testing, operations, performance budgets, and newest-first running changelog; verify it remains registered in `docs/README.md`.
- [ ] Audit the architecture, data model, regionalization, security, runbook, E2E, privacy/support disclosure sources, and deployment/environment documentation updated alongside earlier phases. Fill only genuine final verification/release gaps; do not postpone phase-owned documentation to this step.
- [ ] Add content-free operational counters and alerts for acceptance/deduplication/rejection/eviction/delivery, oldest outbox age, retry/dead-letter state, spool loss, crash upload/symbolication/artifact state, crash-free eligibility, and retention reconciliation. Logs contain fixed codes/counts only.
- [ ] Add runbooks for destination outage, backlog, schema-rejection spike, abuse, missing symbols, prohibited-data incident, cross-region failure, preference incident, and deletion failure.
- [ ] Measure startup gate, ingest p95, desktop CPU/memory/network, and forced-crash symbolication against the PRD budgets. Optimize only from captured profiles; preserve correctness/privacy tests while changing batching or sampling.
- [ ] Run focused tests after each slice, then `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, both Wrangler dry-run builds, `pnpm --filter @rally/desktop test:release`, packaged telemetry fixtures, local regional smoke, and the documented manual Electron acceptance. Treat any one-time test failure as a defect and reproduce/fix it per repository policy.
- [ ] Advance [state](state.md) from its implementation-time `in progress` value to completed only after every acceptance criterion below has evidence and no required work remains.

**Acceptance gate:** all repository and release gates are green from a clean checkout, the visible control was inspected in a real window, packaged synthetic reports reached their correct test destinations, retention reconciliation found no survivors, and documentation/disclosures match shipped behavior.

## Acceptance traceability

| PRD acceptance criterion | Owning phase(s) |
| --- | --- |
| 1. Typed tracking plan and schema governance | 1 |
| 2. Renderer/provider isolation and narrow preload | 1, 5 |
| 3. Regional routing, RPCs, EU isolation, no holding/Analytics Engine sink | 3, 4, 7 |
| 4. Correlation, duplicate, and clock semantics | 1, 3, 8 |
| 5. Durable acknowledgement and immutable internal deadlines | 2, 3 |
| 6. Exact PostHog privacy/profile/crash mappings | 1, 3, 4, 6, 7 |
| 7. Packaged JavaScript/native crash lifecycle and EU query | 0, 6, 7 |
| 8. Complete enabled/opted-out failure coverage | 5, 6, 7 |
| 9. Honest crash-free denominators | 5, 7 |
| 10. Account preference synchronization and fail-closed policy | 2, 4, 5 |
| 11. Anonymous onboarding, identity epoch linking, and profile behavior | 3, 4, 5 |
| 12. One nonessential user control | 4, 5 |
| 13. Coarse pre-region native route gate | 0, 4, 7 |
| 14. Crashpad invalidation and restart purge | 0, 5, 7 |
| 15. Complete internal deletion and restricted raw access | 2, 3, 5, 7, 9 |
| 16. Privacy-safe rejection paths | 1, 3, 7 |
| 17. Endpoint abuse resistance | 1, 3, 7 |
| 18. Telemetry failure never changes product behavior | all implementation phases; full proof in 8 and 9 |

## Definition of done

The feature is done only when the production paths, configuration, private artifact lifecycle, regional storage, PostHog adapter, EU internal query, Settings control, documented disclosures, and operational deletion/reconciliation all exist and are enabled through the approved rollout. A mock-only crash path, an accepted-but-never-processed outbox, an untested release artifact, or a passing unit suite without packaged Crashpad evidence is incomplete.
