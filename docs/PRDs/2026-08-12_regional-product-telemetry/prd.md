# Regional product telemetry and crash reporting

> Created: 2026-08-12
>
> Scope: Avalon desktop, regional APIs, product analytics, error reporting, and a future public-site source
>
> Companion documents: [research](research.md), [design](design.md), [implementation plan](plan.md), [state](state.md)
>
> Standing brief: [Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md)

## Summary

Avalon needs a privacy-bounded telemetry system that explains how people use the product, connects desktop activity to regional API outcomes, and makes Electron failures diagnosable. The product cannot obtain those capabilities by placing a general-purpose analytics SDK in the renderer: Avalon handles unusually sensitive work content, the renderer is deliberately isolated, and every authenticated workspace is pinned to either the Global or EU service architecture.

Avalon therefore owns a small, vendor-neutral event and crash-reporting layer. The Electron main process is the desktop telemetry authority. It accepts only typed, allowlisted signals from the renderer and preload, adds safe application context, stores a bounded local delivery spool, and sends batches to the same regional API the user is connected to. Regional API code emits server-side signals through the same contract. A durable regional pipeline validates, redacts, enriches, and routes accepted events to the destination allowed for that region. The Global deployment uses the current US PostHog project; the EU deployment keeps telemetry inside Avalon's isolated Cloudflare-backed platform and does not forward it to PostHog.

Native crashes use a separate path. Electron Crashpad uploads minidumps to a regional Avalon endpoint; the regional crash pipeline stores them separately with short retention and symbolicates them using private release artifacts. In Global, only a sanitized crash summary and opaque crash identifier are sent to PostHog. In EU, both the dump and derived report stay within the isolated regional platform. PostHog is not the raw crash archive or the source of truth for consent, residency, event schemas, or delivery state.

The default collection model is intentionally hybrid. Avalon automatically captures a narrow set of content-free lifecycle and reliability signals. Product teams add explicit semantic events for meaningful actions and outcomes. Avalon does not enable DOM autocapture, generic click or key capture, session replay, console capture, arbitrary network breadcrumbs, or an unrestricted `capture(name, properties)` API.

Essential content-free reliability telemetry, low-data product analytics, and native crash reporting are enabled by default. Each user has a Product analytics setting that defaults on. Turning it off stops that user's semantic product analytics and native crash-dump reporting: upload stops immediately, pending dumps are removed, and local dump generation is disabled after restart because Electron Crashpad cannot be stopped once started. Essential content-free reliability telemetry continues so Avalon can operate and secure the service. Whether the settings UI also offers a narrower crash-dumps-only switch remains an open product decision.

## Motivation

Avalon currently has operational fragments, not a product telemetry system:

- The desktop main process observes renderer termination and unresponsiveness, but those conditions are logged locally rather than reported remotely.
- The renderer error boundary logs failures in the client. Production support cannot group them by release, measure affected sessions, or retrieve symbolicated context.
- Main, preload, and renderer source maps are generated, but no private artifact upload and symbolication lifecycle connects them to production errors.
- Regional APIs have structured logs and deliberately content-free root-run Analytics Engine rows. That aggregate, account-level dataset is useful for operating a service, but it is not a workspace-pinned product analytics or crash-diagnosis system.
- Client actions and API results do not share an analytics operation identifier, so a funnel can record an attempted action without knowing whether the regional service accepted, completed, rejected, or timed it out.
- The public website explicitly says it does not use behavioral analytics. Adding site analytics without a planned consent and notice change would violate the product's current external representation.

The absence of evidence is itself the product problem. Avalon cannot reliably answer which experiences lead to activation, where users abandon a flow, whether a release reduced crash-free sessions, or whether a client-reported success corresponds to a server-confirmed outcome. This PRD originates from the 2026-08-12 product request for PostHog integration, regional behavior, deep Electron crash reporting, privacy-aware automatic capture, and client/server signal correlation. It does not claim a history of customer incidents that has not been recorded.

The design is informed by current official documentation for PostHog, Twilio Segment, Sentry, Electron Crashpad, OpenTelemetry, Amplitude, RudderStack, Snowplow, Bugsnag, and Honeycomb. The detailed comparison and links live in [research.md](research.md).

## Goals

1. Give product and engineering a trustworthy view of activation, adoption, retention, funnel completion, and release health without collecting customer content.
2. Detect and diagnose handled JavaScript errors, unhandled exceptions and rejections, renderer failures, hangs, unclean exits, and native Electron crashes across supported desktop releases.
3. Preserve Avalon's Global/EU boundary from collection through temporary storage, durable delivery, crash storage, symbolication, destination selection, deletion, and support access.
4. Join client intent to server truth with stable event, session, operation, request, and trace identifiers while making duplicate delivery and clock skew explicit.
5. Make event collection governed and testable through versioned schemas, a tracking plan in source control, field-level privacy classifications, and destination-specific transforms.
6. Keep collection resilient and non-blocking through bounded local buffering, regional durable outboxes, retry with backoff, idempotent delivery, and observable dead-letter handling.
7. Keep PostHog replaceable. Avalon owns consent, identity derivation, the accepted event contract, delivery state, raw native dumps, deletion workflows, and destination routing.
8. Establish a safe extension point for future public-site analytics without changing the site's current tracking posture in the first release.

## Non-goals

1. Recreate Segment's full customer data platform, identity graph, audience builder, or catalog of hundreds of destinations.
2. Recreate Sentry's full issue-management UI, source-control integration, performance tracing product, or support workflow inside Avalon.
3. Record prompts, model responses, transcripts, files, connector content, emails, note bodies, terminal output, arbitrary logs, or other customer content for analytics or crash context.
4. Enable Electron renderer DOM autocapture, generic click or keyboard capture, session replay, automatic console breadcrumbs, or automatic request/response capture.
5. Replace Cloudflare logs, traces, or the existing content-free Analytics Engine dataset used for service operations.
6. Use PostHog feature flags as Avalon's runtime flag system. Flagship remains authoritative; experiments may export exposure metadata to PostHog.
7. Guarantee exactly-once analytics delivery. The product provides at-least-once delivery with deterministic event identifiers and destination deduplication where supported.
8. Add public-site behavioral analytics, cross-site attribution, advertising pixels, or a consent banner in the first release.
9. Expose raw native crash dumps, raw stack frames, or sensitive diagnostic attachments in PostHog.
10. Treat telemetry as a prerequisite for completing a user action. Collection and forwarding failures never change the action result.

## Product behavior

### Collection model

Every signal belongs to one of three policy classes:

| Class | Examples | Approved default | Data ceiling |
| --- | --- | --- | --- |
| Essential reliability | launch/session counters, app version, update result, process-gone reason, API outcome class, dropped-event counts | On | Content-free enums, booleans, bounded durations, opaque IDs |
| Product analytics | named screen views, explicit feature actions, funnel steps, coarse configuration choices, server-confirmed outcomes | On, with a per-user setting to disable | Allowlisted semantic properties; no customer content |
| Detailed diagnostics | native minidump, sanitized exception stack, typed breadcrumb ring, optional user reproduction note | Automated crash reporting on; native dump upload forced off immediately and generation disabled after restart when Product analytics is off | Minimum diagnostic payload, separate retention and access |

The API enforces the effective policy. A local desktop preference provides immediate behavior, while an authenticated workspace policy may further restrict collection. A server response may reduce collection at any time; it cannot silently override a user's choice to disable product analytics. The compiled and local default is enabled. Turning Product analytics off immediately stops new product events, disables Crashpad upload, and removes pending native dumps and queued product events according to the approved deletion behavior. Essential content-free reliability signals continue.

Automatic collection is limited to events whose shape is stable and whose fields are content-free:

- application launch, ready, foreground/background, graceful exit, and inferred unclean exit;
- desktop session start and end;
- update check, download, apply, and rollback outcomes;
- renderer process gone, renderer unresponsive/responsive, preload initialization failure, main-process unhandled exception, and renderer error-boundary failure;
- API request duration and outcome class for an allowlisted operation name, without URL, query, headers, or body;
- spool pressure, rejected event counts, destination delay, and crash-upload state;
- explicit named screen views from the router, not URL or DOM inspection.

All business events are explicit. A feature emits a typed event such as `workspace_switch_completed` or `run_completed`; it does not pass an arbitrary string and property bag. The tracking plan defines the event owner, source of truth, allowed sources, property schema, privacy class, retention, sampling, and destination mappings.

### Identity and correlation

Avalon does not send names, email addresses, workspace names, raw database identifiers, authentication tokens, IP addresses, or device-advertising identifiers to PostHog.

The regional API derives scoped analytics identifiers using a versioned keyed hash. Separate namespaces exist for person, workspace, and installation so a leaked identifier cannot be joined to Avalon's database or reused across environments. The service records the key version needed for deletion and controlled rotation. Pre-auth desktop activity uses a random installation identifier. Login starts authenticated identity prospectively; Avalon does not automatically alias all historical anonymous activity until product and privacy owners approve that behavior.

Every envelope carries a unique `event_id`. Related activity may additionally carry:

- `launch_id` for one application launch;
- `session_id` for one foreground product session;
- `operation_id` for one user-intent flow across renderer, main, and API;
- `request_id` for a regional API request;
- W3C `trace_id` and `span_id` when operational tracing exists.

`operation_id` answers product questions such as intent-to-success. Trace context answers service-timing questions. Neither substitutes for the other. The API records client-original, client-sent, server-received, and normalized event times and flags excessive clock skew rather than silently trusting desktop time.

### Client and server signals

Client and server events share one versioned envelope and one tracking plan, but each named event declares its authoritative source:

- client-only events describe presentation state or intent, such as a screen becoming visible or a user invoking an action;
- server-only events describe authoritative effects, such as a workspace mutation committing or an asynchronous run finishing;
- paired events use the same `operation_id`, such as `run_requested` from the client and `run_completed` or `run_failed` from the API;
- an event is never emitted from both sides merely to increase confidence. If two sources are meaningful, they use different names and defined semantics.

The regional API adds trusted fields such as region, environment, server release, authenticated analytics identities, entitlement tier, and outcome classification. Client-supplied values never override trusted context.

### Electron reporter

The Electron main process owns reporter initialization, policy, identity state, the breadcrumb ring, the local spool, batching, network delivery, and shutdown flush. The renderer receives only narrow preload methods generated from the tracking plan. It cannot obtain provider keys, a PostHog client, a raw destination URL, or an arbitrary event method.

The local spool contains only already-sanitized envelopes. It is bounded by count, bytes, and age; evicts the oldest low-priority analytics before essential reliability events; uses jittered exponential backoff; and reports aggregate drop counts after recovery. Logout clears authenticated identity from future events and removes queued authenticated product analytics unless retention has been explicitly approved. Crash artifacts follow a separate local lifecycle.

Developer builds provide a telemetry inspector showing the event name, schema version, policy class, allowed properties, selected region, local queue state, and validation result. Values classified as diagnostic or identifying stay redacted. This is the primary way feature authors verify instrumentation without relying on the PostHog live-event view.

### Crash and error coverage

Avalon treats crash reporting as four complementary layers:

1. **JavaScript errors.** Main and renderer handlers report handled failures, uncaught exceptions, unhandled promise rejections, and React error-boundary failures through a sanitized exception schema. Stack frames are normalized; query strings, local usernames, workspace paths, source excerpts, request bodies, and dynamic messages are removed or tokenized before upload.
2. **Electron process health.** Main-process listeners report renderer termination reason, exit code class, sandbox or GPU process role, unresponsive/responsive transitions, and recovery action. Repeated events are rate-limited and grouped by launch.
3. **Unclean exits and launch crashes.** A launch marker is committed before UI initialization and cleared on graceful exit. The next launch reports an inferred unclean exit and whether the prior release was still in its launch window. This detects failures for which in-process JavaScript delivery never ran.
4. **Native crashes.** Electron Crashpad starts at the earliest region-safe point. Its out-of-process handler sends a minidump to a dedicated regional endpoint using an abuse-resistant, region-bound upload capability that does not depend on a live renderer or normal session completion. The endpoint validates size and format, rate-limits, stores the dump in regional object storage, and queues symbolication. A region change takes effect after a desktop restart because Crashpad cannot be stopped and reinitialized safely in place.

Raw minidumps remain in a restricted regional crash store and expire on a short, configured schedule. Private source maps and native symbols are uploaded by the release pipeline to the matching regional symbol store, keyed by immutable release, build, bundle, platform, architecture, and debug identifiers. Symbolication produces a scrubbed issue fingerprint, exception type, owned frame, release context, process type, and opaque `crash_id`. The Global PostHog project receives that summary; EU summaries remain in Avalon's isolated EU telemetry store. Authorized support tooling retrieves the detailed report from Avalon's crash store only when policy permits.

The crash product measures, at minimum, crash-free launches, crash-free sessions, affected installations, launch-crash rate, unresponsive-session rate, issue recurrence, first-seen/last-seen release, and release adoption. A crash counts once against a session even if the same session produces multiple reports. Rate limiting must not make stability dashboards silently look healthier; discarded crash and session counts are exported as health metrics.

Typed breadcrumbs are a small in-memory ring of safe state transitions—for example `screen_changed`, `update_started`, `workspace_switch_started`, and coarse API operation outcomes. They use the same schema registry, never include display text or arbitrary metadata, and are attached only when detailed diagnostics permits them.

### Regional pipeline and destinations

Each regional API exposes authenticated batch ingestion for normal events and a separately protected Crashpad-compatible endpoint for native dumps. Normal ingestion validates the envelope, clamps timestamps and sizes, applies policy and redaction, derives analytics identities, and commits an accepted record to a regional D1 outbox before returning success. The Queue message contains only the region and opaque record identifier, preserving the repository's existing queue-content boundary. A regional consumer loads the record, runs destination transforms, sends it, and records attempt and terminal state.

Invalid events do not enter product analytics. Production stores a content-free rejection record—event name, schema version, source, violation codes, field paths, release, and count—not the rejected payload. Developers get local validation failures. Delivery failures retry with backoff and then enter an operator-visible dead-letter state. Backlog age, rejection rate, duplicate rate, destination latency, and drop counts have explicit alerts.

The US PostHog project is the first external destination adapter and is enabled only in the Global deployment:

- use the US ingestion host only from the Global destination worker;
- set deterministic event identifiers and preserve normalized original time;
- set person-profile processing only for approved authenticated product events;
- disable geolocation and do not forward the request IP;
- map JavaScript exceptions through the supported server SDK exception API after validating its output in a privacy fixture suite;
- map Global native crash summaries to an Avalon-owned event until PostHog provides a verified native-crash contract suitable for these fields;
- attach Flagship experiment exposure properties only to approved exposure and metric events;
- keep personal profiles minimal and do not send email, name, or raw Avalon IDs;
- opt Avalon data out of provider product/model development contractually or through the provider control before production data flows.

The EU deployment has no PostHog credentials, adapter route, or provider egress. Its accepted events and derived crash summaries terminate in an Avalon-owned internal telemetry sink built from isolated Cloudflare primitives. Avalon prefers primitives with documented EU domicile. If a required Cloudflare primitive does not offer that guarantee, EU telemetry uses a dedicated set of bindings and datasets that is not shared with Global, and the limitation is documented. The existing shared Analytics Engine dataset is not an EU product-telemetry destination because it does not provide the required jurisdiction guarantee. A future EU-specific PostHog instance requires an explicit architecture and privacy decision before forwarding begins.

Destination configuration and credentials exist only in the matching regional server environment. A destination can be paused, sampled, replayed from the allowed retention window, or replaced without shipping a new desktop release. Destination replay preserves `event_id` and records adapter version.

### Prohibited data

Telemetry schemas and runtime redaction reject these fields regardless of consent tier unless a later PRD explicitly changes the product contract:

- prompt, response, transcript, note, document, file, email, connector, calendar, issue, chat, or terminal content;
- filenames, absolute or home-relative paths, repository remotes, branch names, window titles, URLs with path/query/fragment, DOM text, and clipboard data;
- authentication headers, cookies, tokens, OAuth material, credentials, and local secrets;
- raw request or response bodies, arbitrary console output, SQL text, and arbitrary exception metadata;
- names, emails, IP addresses, precise location, advertising IDs, raw user/workspace/database IDs, and third-party account identifiers;
- source-code excerpts and memory attachments beyond the approved minidump path.

Property names matching sensitive-key patterns are rejected. String fields have enum or strict length/character constraints. Unknown properties fail validation rather than being forwarded. Free-form user crash descriptions, if introduced later, are stored as support content under a distinct consent and retention flow and never forwarded to a product analytics destination.

### Public website

The first release does not alter the website. This is required because the current Cookie & Tracking Notice states that Avalon does not use behavioral analytics or non-essential tracking and therefore does not display a consent banner.

A later site phase may use the same public ingestion contract with a separate `site` source, separate project or dataset, cookieless anonymous identifiers, Global Privacy Control handling, and region selection appropriate to the visitor and legal basis. It starts with explicit landing-view and conversion events, not DOM autocapture or session replay. Before it launches, legal text, subprocessor disclosures, consent behavior, bot filtering, and website-to-desktop attribution must receive their own approval. Site identity is not joined to a desktop user merely because an IP, email, or link makes that technically possible.

### Retention, deletion, and access

Every schema declares a retention class. Proposed ceilings, pending privacy approval, are:

- local normal-event spool: 7 days;
- regional accepted-event outbox and replay payload: 7 days after successful delivery, 30 days after terminal failure;
- rejection metadata: 30 days;
- raw native dumps: 14 days;
- symbolicated internal crash reports: 90 days;
- Global PostHog product events: 13 months;
- Global PostHog exception events: 90 days;
- EU internal product events and derived exception reports: retention pending approval, with the PostHog ceilings as maximums.

Avalon documents provider retention separately and configures shorter periods where supported. User/workspace deletion resolves current and historical analytics identifier key versions, suppresses future delivery, deletes queued and stored regional records, calls provider deletion APIs, and records completion without retaining the deleted identifier. Raw dumps are addressable by regional subject/install index where consented identity exists; truly anonymous pre-auth dumps expire by retention rather than pretending they are attributable.

Access follows least privilege. Product analysts see approved Global events in PostHog and approved EU events only through Avalon's internal regional analytics access. Engineering sees sanitized issue summaries. Only a small audited support/security role can retrieve a raw or fully symbolicated crash report, and only from the matching regional store. Global provider access, export, deletion, and session-recording settings are periodically reviewed.

### Rollout

1. **Contract and dry-run.** Land the schema registry, generated clients, privacy fixture suite, local inspector, server validator, destination adapter contract, and event inventory. Produce validation and volume metrics without sending product data to PostHog.
2. **Server and desktop reliability.** Enable content-free launch/session/process-health events and explicit server outcomes for internal builds. Establish the regional outbox, the Global PostHog project, the EU internal sink, dashboards, deletion paths, and alerting.
3. **JavaScript error reporting.** Add sanitized errors, private source-map upload, issue fingerprints, release health, and internal dogfooding. Prove that privacy fixtures cannot reach PostHog or the EU internal sink.
4. **Native crash reporting.** Ship Crashpad ingestion, dump retention, private symbols, symbolication, support access, launch-crash detection, and a forced-crash release test. This phase cannot graduate until every supported OS/architecture is exercised in a packaged build.
5. **Product analytics.** Add a reviewed activation and adoption tracking plan feature by feature. Expose user/workspace controls approved by product and legal. Avoid measuring everything merely because the path exists.
6. **Public site, separately approved.** Revisit cookieless site events and notice/consent requirements after desktop and API data quality is established.

Flags may reduce sampling or disable a schema or destination, but no remote feature flag is a privacy boundary. Collection code must enforce the compiled allowlist and effective consent even when configuration is stale or incorrect.

### Acceptance criteria

The PRD is implemented when all of the following are true:

1. A typed tracking plan lists every production event, allowed source, property, classification, owner, retention, sampling, and authoritative outcome; CI rejects unregistered events and incompatible schema changes.
2. Renderer code has no PostHog or general analytics SDK, provider key, generic capture API, or direct telemetry network path. Tests prove that only the narrow preload contract reaches main.
3. Normal events from Global and EU desktop sessions reach only their configured regional ingestion and durable storage. Global may forward approved summaries to the US PostHog project. EU has no PostHog credential or egress path. Cross-region integration tests fail if an event, dump, symbol, or credential crosses the boundary.
4. Client intent and server outcome can be queried by `operation_id` without using raw user, workspace, or content fields. Clock-skew and duplicate tests produce deterministic results.
5. A regional API acknowledgement means the event is durably recorded or explicitly rejected; provider downtime does not lose accepted events within the documented retention and capacity limits.
6. The Global PostHog project receives only fields in golden privacy fixtures. GeoIP is disabled, request IP is not forwarded, profiles contain no direct identity, and provider product/model-training opt-out is verified before production. The same fixtures prove that EU events never leave Avalon's Cloudflare-backed platform.
7. Packaged forced-crash tests on every supported OS and architecture produce a regional dump, match private symbols/source maps to the correct release, and create a stable issue fingerprint. Global exposes a sanitized PostHog summary with an opaque Avalon crash ID; EU exposes the summary only through the internal regional path.
8. JavaScript main, preload, and renderer errors; renderer gone; unresponsive/recovered; unclean exit; launch crash; and native crash each have a tested signal and do not require a graceful shutdown.
9. Crash-free launch/session calculations count sessions consistently, disclose dropped or rate-limited reports, and segment by release, platform, architecture, region, and channel.
10. The per-user Product analytics setting defaults on and takes effect locally without waiting for a destination call. Turning it off stops new product events and native dump upload, clears affected queued events and pending dumps, and prevents local dump generation after the required desktop restart. Any interim dump is not uploaded and is removed on the next safe startup. The UI does not retroactively claim provider deletion until deletion completes. Essential reliability signals continue.
11. Deletion tests cover current and rotated analytics IDs, regional outbox rows, crash indexes, Global PostHog deletion, and the EU internal sink. Access to raw crash artifacts is regional, role-restricted, and audited.
12. The public site remains free of behavioral analytics until its separate rollout gate updates the Cookie & Tracking Notice and any required consent controls.
13. Telemetry endpoint abuse tests cover payload size, schema bombs, compression bombs, malformed minidumps, replay, forged regions, event floods, and expired upload capabilities.
14. Product actions continue normally when the spool is full, the API is offline, the regional queue is delayed, the EU internal sink is unavailable, or PostHog is unavailable; aggregate loss is measurable.

### Success measures

Within the first two stable releases after full desktop rollout:

- at least 99.5% of valid, accepted normal events reach the configured destination within 15 minutes, excluding declared provider incidents;
- p95 telemetry ingestion adds less than 25 ms to API handler wall time because delivery is deferred after durable regional acceptance;
- desktop collection consumes less than 0.5% average CPU, 15 MB memory, and 1 MB/day network at the default sampling policy for a typical active user;
- 100% of sampled production event schemas pass the automated prohibited-data scan, with zero confirmed customer-content events in PostHog or the EU internal telemetry sink;
- at least 95% of forced and dogfood native crashes are symbolicated to an owned frame for releases whose symbols were published;
- release dashboards report crash-free launches and sessions with known delivery/drop denominators;
- the initial activation funnel has both client intent and server-confirmed completion for every state-changing step.

Volume, performance, and symbolication targets are engineering budgets rather than promises to customers. They are revisited after dry-run data establishes realistic baselines.

### Open product decisions

The following answers are required before the indicated rollout gate; implementation must not guess them:

1. **Crash-only control:** In addition to the Product analytics master setting, can a user disable native crash dumps while leaving semantic product analytics enabled? Required before settings UI design. Product analytics off always forces native dumps off.
2. **Pre-auth region:** Which region receives a crash before the user signs in or chooses a workspace? Options include installer channel, explicit first-run choice, system locale, or no upload until region is known. Required before starting Crashpad in production.
3. **Workspace policy:** Can an administrator force analytics or diagnostics off? A workspace policy cannot override an individual opt-out to turn collection back on. Required before settings UI design.
4. **Support access:** Does Avalon build a private regional crash viewer, or use a dedicated crash product for detailed issue workflows? The EU path cannot send crash data to an external US service. Required before Phase 4. The custom viewer is materially more work than ingestion and symbolication.
5. **Retention:** Do the proposed local, regional, dump, exception, Global PostHog, and EU internal retention ceilings meet support and legal needs? Required before migrations and lifecycle jobs.
6. **Authenticated history:** Should pre-auth installation activity ever be aliased to an authenticated analytics person? Recommended baseline: no automatic historical aliasing.
7. **Landing site:** Is the later goal aggregate conversion measurement only, or durable visitor-to-desktop attribution? The latter changes consent, identity, and disclosure requirements and needs a separate PRD.

## Impact on product contract

This PRD changes Avalon's external and internal product contract in material ways:

- Avalon begins collecting defined reliability and, when approved, product-usage telemetry from the desktop and API. The Privacy Policy, DPA annexes where applicable, subprocessor register, in-product settings, and support documentation must describe the categories, purposes, providers, retention, controls, and regional behavior before external rollout.
- The public site's existing no-behavioral-analytics statement remains true in the first release. A site rollout cannot occur as an implementation detail; it requires the notice and consent gate defined here.
- Workspace regional selection now governs product telemetry, crash artifacts, symbols, delivery credentials, deletion, and support access in addition to existing product data. Global may send approved telemetry to the US PostHog project. EU telemetry, dumps, and derived reports remain inside Avalon's isolated Cloudflare-backed platform; any future EU PostHog deployment requires a new recorded decision.
- Desktop users gain a Product analytics setting that defaults on. It describes what is collected in plain language and links to a field-category reference. Turning it off disables semantic product analytics and native crash reporting while essential content-free reliability telemetry continues. The UI explains that fully stopping local Crashpad dump generation requires a restart, although upload stops immediately.
- PostHog becomes a disclosed subprocessor or service provider only for the approved Global categories. Avalon remains responsible for purpose limitation, deletion, access, provider configuration, and contract terms, including the provider's product/model-development opt-out. EU disclosures describe the internal Cloudflare-backed path and any locality limitation of the selected primitives.
- A native minidump can contain memory fragments and therefore may contain customer content despite Avalon's minimization. It is never described as content-free; it receives separate consent, access, and retention treatment.
- Telemetry does not become customer workspace content, a collaboration surface, or a source of product truth. It is advisory and can be incomplete because of policy, offline use, sampling, rate limits, or provider failure.

## Decision log

- **2026-08-12 — EU telemetry remains inside Avalon's platform.** The current PostHog instance is US-only, so the EU deployment does not forward product events, exceptions, dumps, or derived crash reports to it. EU telemetry prefers Cloudflare primitives with documented EU domicile; when a required primitive lacks that guarantee, it uses a dedicated EU set that is not shared with Global. A future EU-specific PostHog instance requires a new decision.
- **2026-08-12 — Native crash dumps default on and follow the analytics master control.** Native crash reporting is enabled by default. Turning Product analytics off stops dump upload immediately, clears affected pending artifacts according to the deletion policy, and prevents new local dump generation after restart because an active Electron Crashpad handler cannot be stopped in place.
- **2026-08-12 — Per-user product analytics defaults on.** Every user has a Product analytics setting enabled by default and can disable semantic product analytics for their own activity. Essential content-free reliability telemetry remains enabled.
