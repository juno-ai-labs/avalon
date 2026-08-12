# Implementation plan: regional product telemetry and crash reporting

> Status: planning only
>
> Depends on: product decisions in [prd.md](prd.md#open-product-decisions)
>
> Architecture: [design.md](design.md)

## Gate 0: product, legal, and vendor decisions

- Approve the remaining crash-only control, workspace-policy precedence, pre-auth region behavior, retention, authenticated-history policy, and support-viewer choice. Product analytics and native dumps default on per user; turning Product analytics off also disables dump reporting.
- Execute the Global-only PostHog security/privacy review, DPA/subprocessor work, product/model-development opt-out, retention, RBAC, and deletion test.
- Select the EU internal telemetry primitives. Prefer documented EU domicile; otherwise provision a dedicated EU-only set that is not shared with Global. Confirm that the EU deployment has no PostHog credentials, provider route, or external telemetry egress.
- Compare the custom native-crash total cost against routing regionally to Sentry or Bugsnag. Record the decision; do not treat the custom path as free because ingestion is straightforward.
- Define supported desktop OS/architecture matrix and what “crash reporting supported” means on each target.
- Draft the required Privacy Policy, DPA annex, subprocessor, settings, and support copy. Do not publish behavioral site analytics.

Exit: decisions are recorded in the PRD Decision log and architecture-affecting choices are approved.

## Gate 1: technical spikes

### Crashpad transport spike

- Build packaged test apps for each supported OS/architecture.
- Verify earliest safe initialization, fixed region selection, restart behavior, multipart schema, custom auth options, pending upload database, retries, upload enable/disable, proxy behavior, and forced native crash.
- Decide direct out-of-process regional upload versus authenticated next-launch upload.
- Measure dump sizes and verify parsing limits without inspecting customer data.

### Symbolication spike

- Produce JS source maps/debug IDs and native symbols for one packaged build.
- Upload immutable artifacts privately to both regional test stores.
- Symbolicate forced main/renderer/native-module crashes to an owned frame.
- Select regional compute for Breakpad/Crashpad tooling and document isolation and cost.

### Destination adapter spike

- Verify `posthog-node` Workers compatibility and plain capture fallback in Global.
- Capture product, anonymous profile-free, authenticated derived-ID, exception, timestamped, duplicate, and experiment-exposure fixtures into a non-production US project.
- Inspect the exact wire payload and stored PostHog properties.
- Exercise deletion and validate provider configuration drift checks.
- Send the equivalent fixtures to the internal EU sink and prove through egress tests that no request reaches PostHog or another external analytics/crash service.

Exit: forced crash and destination fixture reports are attached to the implementation issue, and any architecture change updates this PRD/design before feature work.

## Gate 2: contract and regional foundation

- Add the tracking-plan schema, first event inventory, generator, generated TypeScript APIs, runtime validators, data dictionary, and golden privacy fixtures.
- Add regional D1 tables for accepted events, delivery attempts, deduplication, rejection metadata, deletion/suppression, and outbox state.
- Add authenticated batch ingest with strict resource limits and per-event status.
- Add the destination interface, non-production Global PostHog adapter, and isolated EU internal adapter.
- Add queue-by-opaque-ID processing, retries, dead-letter operations, and replay preserving event ID.
- Add scoped analytics ID derivation, rotation metadata, and deletion workflow.
- Add operational dashboards, alerts, and runbook sections before enabling a destination.

Exit: API contract/integration tests prove Global/EU separation, validation, deduplication, clock handling, durability, destination outage recovery, deletion, and prohibited-data rejection.

## Gate 3: Electron normal reporter

- Add main-owned policy resolution, identifiers, typed breadcrumb ring, spool, batching, retry, purge, and safe developer inspector.
- Generate the preload/renderer semantic interface; add IPC boundary tests and an import rule preventing provider SDKs in renderer/preload.
- Define launch and session lifecycle and add content-free automatic reliability events.
- Propagate `operation_id` through selected desktop/API flows and emit paired server outcomes.
- Add the per-user Product analytics setting defaulted on. Turning it off stops product events and native dump upload, purges affected queues/artifacts, and explains that fully stopping local Crashpad generation requires a restart. Add workspace restrictions only after Gate 0 approval.
- Measure CPU, memory, disk, network, startup, and shutdown impact under offline/backlog conditions.

Exit: internal packaged builds show correct regional events, no prohibited fields, safe policy changes, and no product-action failures during telemetry outages.

## Gate 4: JavaScript error reporting

- Add main and renderer exception/rejection handlers and connect the existing React error boundary and process-health listeners.
- Implement stack/message/path normalization, stable fingerprints, handled/unhandled classification, and typed breadcrumb attachment.
- Upload private source maps and matching bundles before release; fail release readiness when artifacts are absent.
- Map approved Global errors through the PostHog exception adapter, keep EU errors in the internal sink, and build release-health dashboards for both paths.
- Add forced errors for main, preload, renderer, and async rejections to packaged release verification.

Exit: every JS class creates one scrubbed, correctly symbolicated issue; no privacy fixture reaches regional storage or PostHog; and no EU fixture reaches an external service.

## Gate 5: native crashes

- Add region-bound crash upload capability and hardened Crashpad endpoint.
- Add regional dump storage/lifecycle, symbol queue, isolated symbolication processor, issue grouping, and support access audit.
- Add launch marker, unclean-exit inference, and launch-crash classification.
- Add release manifests and native artifact publication for every target.
- Add crash-free launch/session dashboards with lost/rate-limited denominators.
- Build the minimum audited regional crash viewer or approve a dedicated crash vendor for Global. EU remains internal until an EU-specific provider path receives a new decision.
- Add forced native crash tests to desktop release invariants.

Exit: every supported packaged target satisfies PRD acceptance criterion 7, retention jobs delete test artifacts, and a regional access test proves EU/Global isolation.

## Gate 6: semantic product analytics

- Choose the smallest activation/adoption questions worth answering.
- Review each event with product, engineering, privacy, and its feature owner.
- Instrument client intent and authoritative server outcomes rather than generic interactions.
- Establish dashboards with data-quality annotations, policy/sampling denominators, and event owners.
- Remove events that do not drive a decision after the first review cycle.

Exit: the initial activation funnel has an owner, query definitions, both intent and server outcomes, documented exclusions, and a scheduled review.

## Gate 7: public site decision

- Write a separate site tracking decision or PRD covering legal basis, cookie/local-storage use, GPC, notice/banner, bot filtering, identity, attribution, region, and retention.
- If approved, implement explicit cookieless view/conversion events through the public regional collector.
- Update the Cookie & Tracking Notice, Privacy Policy, and subprocessor disclosures before collection starts.
- Keep DOM autocapture, replay, advertising, and automatic desktop identity joins out of the default design.

Exit: external notice and product behavior agree in production.

## Test strategy

- **Schema tests:** valid, invalid, unknown, incompatible-version, size, enum, and prohibited-field fixtures.
- **Property tests/fuzzing:** nested JSON limits, Unicode/path/token patterns, compression bombs, timestamp extremes, duplicate/conflicting IDs.
- **Regional tests:** Global and EU hosts, bindings, queues, stores, symbols, credentials, deletion, and support roles cannot cross.
- **Desktop tests:** IPC allowlist, spool corruption/full disk/offline/logout/policy change/restart/update, clock skew, repeated crashes, shutdown budget.
- **Crash tests:** handled/unhandled JS, main/renderer/preload, renderer gone, hang/recovery, unclean exit, launch crash, native crash, malformed dump, missing/wrong symbols.
- **Destination tests:** exact golden payload, IP/identity absence, GeoIP/profile flags, retry classes, `Retry-After`, batch splitting, deterministic replay, provider outage.
- **Privacy tests:** canary secrets and synthetic customer content are rejected before persistence and never appear in provider project export.
- **Deletion tests:** current and rotated IDs, queued events, failed delivery, raw dumps, symbolicated reports, provider delete, anonymous retention expiry.
- **Performance tests:** launch overhead, steady-state CPU/memory, spool I/O, network/day, ingest p95, queue backlog recovery.

## Rollback

Every schema and destination has a server-side kill switch that can only reduce collection or forwarding. The desktop compiled policy can disable all nonessential collection in a patch release. Destination pause retains accepted events only within the approved regional replay window. Native upload can be revoked by capability/release and disabled in the next desktop policy response; pending local dumps follow the approved purge behavior. Rollback never redirects EU data to Global or expands retention to avoid data loss.

## Documentation required during implementation

This PRD creates a new subsystem. Before implementation is called complete:

- add a module document under `docs/` following `docs/module-documents.md` and register it in `docs/README.md`;
- update `docs/architecture.md`, `docs/regionalization.md`, `docs/security.md`, `docs/data-model.md`, the API runbook, and desktop release documentation;
- document the event data dictionary and settings behavior for users;
- update legal pages and subprocessor information before external collection;
- append the required running changelog entry to every substantially changed module document.
