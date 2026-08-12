# Research: regional product telemetry and crash reporting

> Researched: 2026-08-12
>
> Method: official product documentation, standards, and vendor-controlled repositories; secondary comparison articles were not used as architectural evidence
>
> Related PRD: [Regional product telemetry and crash reporting](prd.md)

## Executive conclusion

No single benchmark product fits Avalon's boundary.

- PostHog is a strong first product-analysis destination for Global and can accept server-routed product and exception events, but it should not own collection policy, regional routing, native dumps, or Avalon's event contract. The current US-only instance cannot receive EU telemetry under the approved product policy.
- Segment provides the clearest model for a canonical event envelope, source/destination separation, message identity, timestamp normalization, and protocol governance. Avalon needs a narrow internal version of those ideas, not a general CDP.
- Sentry and Bugsnag establish the minimum viable bar for crash reporting: very-early initialization, main and renderer coverage, native minidumps, private symbols/source maps, issue grouping, safe breadcrumbs, launch-crash detection, release adoption, crash-free sessions/users, and explicit accounting for rate-limited data.
- Snowplow and RudderStack show why schemas and tracking plans belong in source control, why invalid events need an observable failure path, and why destination transforms should be policy-aware.
- OpenTelemetry supplies the right vendor-neutral mental model—receivers, processors, exporters, semantic conventions, and trace context—but product events still need Avalon's own semantic operation identifiers and privacy contract.
- Amplitude demonstrates the power and danger of autocapture. Its own privacy guidance supports Avalon's conclusion that a content-rich desktop should prefer explicit semantic instrumentation and a tiny automatic reliability baseline.
- Honeycomb reinforces high-cardinality structured correlation and the separation between manual business context and automatic technical instrumentation.

The recommended architecture is an Avalon-owned regional collector and crash pipeline with PostHog behind a Global-only destination adapter and an isolated internal sink for EU. This is “Segment-like” in contract and routing, not in product breadth.

## Capability comparison

| Product | Strongest relevant capabilities | Risk or mismatch for Avalon | What Avalon adopts |
| --- | --- | --- | --- |
| PostHog | Product analytics, funnels, retention, cohorts, exceptions, experiments, EU Cloud, data controls | Renderer SDK can load optional bundles; autocapture/replay can collect UI content; native crash workflow is not its core contract; provider privacy terms need explicit configuration | Global product destination, server-side capture, exception summaries, experiment exposure convention; no EU forwarding until Avalon has an approved EU-specific instance |
| Segment | Canonical envelope, source/destination routing, message IDs, four timestamps, Protocols tracking plans, validation, transformations, regional offering | Full CDP and identity/audience product are unnecessary; direct client source would weaken Avalon's regional and privacy enforcement | Envelope, timestamp normalization, source authority, adapters, deterministic IDs, validation |
| Sentry | Electron SDK, native minidumps, issue grouping, breadcrumbs, source maps/debug IDs, releases, crash-free sessions/users, scrubbing | A second vendor and potentially a second crash data store; rich automatic breadcrumbs can over-collect; detailed native residency needs diligence | Crash coverage bar, fingerprints, releases, safe breadcrumbs, symbol pipeline, crash-free measures |
| Bugsnag | Electron main/renderer coverage, launch crashes, explicit session semantics, stability targets, release adoption, configurable minidump endpoint | Similar second-vendor and privacy diligence; automatic breadcrumbs need restriction | Launch-window semantics, session stability denominator, rate-limit transparency, feature/release correlation |
| OpenTelemetry | Vendor-neutral receiver/processor/exporter pipelines, batching/retry, semantic conventions, trace context | Generic tracing does not define product event meaning, consent, identity, or crash artifacts | Processor/exporter pattern and W3C trace IDs where operational traces already exist |
| Snowplow | Self-describing versioned events, JSON Schema/Iglu registry, validate/enrich stages, failed-event recovery | Full event pipeline and schema registry product are more than V1 needs | Versioned schemas, accepted/rejected separation, recoverable governance |
| RudderStack | Tracking plans as code, typed event contracts, CI workflow, destination allow/deny/mask transforms | Full warehouse/CDP deployment is unnecessary for one initial destination | Git-owned tracking plan, generated interfaces, per-destination transformations |
| Amplitude | Hybrid autocapture plus precision tracking, schema governance, privacy levels, fail-closed replay behavior | Click autocapture includes displayed element text; replay/URL capture is high risk for Avalon content | Explicit business events; fail-closed detailed diagnostics; no DOM autocapture |
| Honeycomb | High-cardinality structured events, trace/log correlation, manual business attributes, OTel collection | An observability product does not replace product analytics or crash management | Rich opaque correlation IDs and manual semantic context without content |

## PostHog

### Integration surface

PostHog accepts individual and batch events over its public capture API. A project token is intended to be public; secrecy is not the reason to proxy it. Avalon's reason to proxy is stronger: regional selection, server-derived identity, consent enforcement, schema validation, durable delivery, centralized redaction, and destination replaceability. The [capture API](https://posthog.com/docs/api/capture) requires an API key, distinct ID, and event name, supports batches below its documented size limit, and exposes different US and EU hosts.

The [JavaScript SDK](https://posthog.com/docs/libraries/js) specifically notes Electron's restriction on remote-code loading. Its no-external builds either disable or prebundle optional features such as replay, surveys, and exception capture. That makes a direct Electron integration technically possible, but still undesirable in Avalon's renderer: it duplicates policy and delivery logic, increases bundle and CSP complexity, and creates an easy path to turn on content-rich collection.

The [Node SDK](https://posthog.com/docs/libraries/node) supports server capture and disables GeoIP by default in current guidance. The package also publishes a Workers-oriented export in its [official repository package metadata](https://github.com/PostHog/posthog-js/blob/main/packages/node/package.json). Before implementation, Avalon still needs a compatibility spike against the exact Cloudflare Workers runtime and the chosen exception API; a plain HTTP adapter remains the fallback.

### Identity

PostHog recommends calling `identify` with a stable authentication identifier and explicitly warns against email addresses or display names as distinct IDs. It also supports anonymous events without creating person profiles through `$process_person_profile: false`. Avalon should go further: derive unlinkable analytics IDs on the regional server and minimize PostHog person properties. Reset-on-logout behavior is necessary but not sufficient because queued events and historical aliasing are Avalon responsibilities.

### Error tracking

PostHog's [exception capture contract](https://posthog.com/docs/error-tracking/capture) uses the `$exception` event with structured exception type, value, stack, fingerprint, and optional exception-step context. Its SDK guidance says to use `captureException` rather than hand-constructing `$exception`. Browser integrations can automatically capture unhandled errors and rejections; console error capture is separately configurable. Avalon should map sanitized JavaScript exceptions through the supported server-side API only after golden-payload tests prove the adapter does not reconstruct prohibited fields. Native minidumps remain outside this path.

Readable production stacks require build-time source-map handling. PostHog's [source-map upload documentation](https://posthog.com/docs/error-tracking/upload-source-maps) confirms that maps must be uploaded for compiled/minified code. Avalon already builds maps for its Electron processes, but must add private upload, release matching, retention, and access controls. Public source-map publication is not an acceptable substitute.

### Privacy and residency

PostHog documents an [EU Cloud deployment in Frankfurt and project IP controls](https://posthog.com/docs/privacy/data-storage). Its [product analytics privacy controls](https://posthog.com/docs/product-analytics/privacy) include IP disabling, `before_send`, cookieless modes, and opt-out. Those controls help, but provider-side settings are defense in depth; Avalon's regional API must discard IP and prohibited properties before forwarding.

Session replay deserves a separate warning. PostHog says inputs are masked by default while general text is not necessarily masked unless maximum-privacy options such as full text masking are configured. Its [replay privacy documentation](https://posthog.com/docs/session-replay/privacy) also highlights the risk of network bodies and headers. Avalon does not enable replay in this PRD.

PostHog's [privacy policy](https://posthog.com/privacy) currently describes use of Customer Content for provider product and model development unless the customer opts out or has contrary contract terms. Avalon must exercise and document that opt-out before production data flows. The [PostHog Trust Center](https://trust.posthog.com) is the starting point for the DPA, security, and compliance review, not a substitute for reviewing the executed terms.

### Experiments and feature flags

Avalon does not need to move runtime flags from Flagship. PostHog documents [experiments with an external feature-flag system](https://posthog.com/docs/experiments/running-experiments-without-feature-flags): emit a custom exposure event and attach the corresponding feature property to exposure and metric events. That lets PostHog analyze experiments while Flagship remains the decision system.

### PostHog decision

Use the current US PostHog project as the first product-analysis destination for Global only. Keep EU product and crash telemetry in Avalon's isolated Cloudflare-backed internal path until an EU-specific PostHog instance receives a new approval. Do not embed PostHog in the renderer, store native dumps in it, make it the consent authority, or design the canonical event schema around PostHog property names.

## Twilio Segment

Segment's strongest contribution is not a vendor feature but an event discipline.

The [Segment common specification](https://www.twilio.com/docs/segment/connections/spec/common) defines a consistent envelope around events: anonymous or authenticated identity, context, integrations, unique message ID, type, version, and multiple timestamps. It distinguishes client-original time, client send time, server receipt time, and a normalized timestamp corrected for clock skew. That is directly relevant to an intermittently connected desktop whose clock may be wrong.

The [Track specification](https://www.twilio.com/docs/segment/connections/spec/track) keeps business actions human-readable and carries structured properties. Its broader [Connections guidance](https://www.twilio.com/docs/segment/guides) separates Sources from Destinations through a common event structure. Avalon adopts that separation but constrains event names and properties with generated types.

Segment uses `messageId` for cross-system debugging and documents [deduplication within a bounded window](https://help.twilio.com/articles/43240224731547). The lesson is to make deduplication scope explicit. Avalon uses a deterministic `event_id`, preserves it through destination retries and replay, and promises at-least-once—not exactly-once—delivery.

Segment Protocols introduced a versioned tracking plan, validation, enforcement, and quarantine for nonconforming data. Segment's [data validation product](https://segment.com/data-hub/data-validation/) can block unexpected events and properties and transform data. Avalon brings the tracking plan into its repository and CI. Unlike a general quarantine, Avalon does not store raw rejected payloads in production because a malformed payload is especially likely to contain prohibited content.

Segment also offers a [regional European architecture](https://segment.com/data-hub/big-data/management/) and privacy deletion/suppression workflows. This reinforces that region applies to ingest, processing, deduplication, archives, replay, and deletion—not just the hostname on the first request.

### Segment decision

Do not buy or clone a full CDP for V1. Adopt the canonical envelope, source/destination adapters, timestamp correction, deterministic IDs, tracking plan, validation, and observable rejection model.

## Sentry

Sentry is the primary quality bar for a serious Electron crash product.

The official [`@sentry/electron` package](https://www.npmjs.com/package/@sentry/electron) captures JavaScript errors and native minidumps from Electron main and renderer processes and must initialize early in main and each renderer/subprocess. Sentry's [JavaScript SDK repository](https://github.com/getsentry/sentry-javascript) identifies the Electron SDK as the native-crash integration. This confirms that a React error boundary or `render-process-gone` listener alone is not crash reporting.

Sentry's error product contributes several behaviors Avalon needs even if Sentry is not the vendor:

- deterministic issue grouping and optional custom fingerprints;
- release and environment association;
- source-map/debug-symbol processing tied to immutable build identity;
- crash-free session and user release health;
- handled versus unhandled severity;
- breadcrumbs preceding an issue;
- scrubbing before and after ingestion;
- alerting, regression detection, and affected-user counts.

Sentry's [breadcrumb documentation](https://docs.sentry.io/platforms/javascript/guides/svelte/enriching-events/breadcrumbs/) shows that browser SDKs can automatically record clicks, keypresses, fetch/XHR, console, and navigation, with filtering hooks. That is valuable for conventional apps and too broad for Avalon. Avalon uses typed state-transition breadcrumbs only.

Sentry exposes organizational [PII and data-scrubbing controls](https://docs.sentry.io/api/organizations/update-an-organization/), including IP scrubbing and advanced rules. Avalon similarly needs both client-side minimization and server-side enforcement. Client scrubbing alone cannot protect against a compromised or outdated desktop; provider scrubbing alone sends prohibited data across the boundary before removal.

Sentry's API uses region-specific domains including US and Germany in its [API reference](https://docs.sentry.io/api/). A production vendor evaluation would still need to establish where attachments, relay processing, source artifacts, backups, support access, and derived issue data reside.

### Sentry decision

Do not add Sentry as a production destination in this PRD. Use it as the acceptance benchmark and retain it as a Global fallback if building symbolication, issue operations, and regional support access proves disproportionately expensive. The current EU policy prohibits sending EU crash data to an external US service. Choosing the custom path means the implementation cannot declare victory at “dump uploaded”; it must deliver grouping, release health, symbols, privacy, access, retention, and support workflow.

## Electron Crashpad

Electron's official [`crashReporter` API](https://www.electronjs.org/docs/latest/api/crash-reporter) uses Crashpad. It starts a separate process that can upload a crash even after Electron terminates, must start before renderer processes are created, and cannot simply be disabled after it starts. It submits multipart minidump data plus configured extra fields to a fixed endpoint.

These properties drive several requirements:

- the crash region must be known before Crashpad starts;
- changing regions requires an application restart;
- the crash endpoint cannot depend on graceful JavaScript execution or a live session-refresh flow;
- configured extra fields must be sparse because they can accompany the most sensitive diagnostic payload;
- custom headers/authentication and upload behavior must be verified in a packaged spike rather than assumed;
- native upload is separate from the normal JSON event batch and local spool;
- a forced native crash on every supported packaged target is a release invariant.

Electron also documents a local Crashpad database and upload controls. Disabling detailed diagnostics must stop future uploads and remove or expire pending dumps according to the approved policy; merely changing a UI toggle is insufficient.

## Bugsnag

Bugsnag independently confirms the crash-product bar. Its [Electron integration](https://docs.bugsnag.com/platforms/electron/) initializes in both main and renderer, automatically captures errors, supports breadcrumbs, associates feature flags, measures sessions, and identifies launch crashes. Its configuration supports separate notification, session, and minidump endpoints and disables native reporting if the minidump endpoint is not configured, reducing accidental leakage.

Bugsnag's [stability model](https://docs.bugsnag.com/product/stability/) calculates error-free users and sessions and allows target and critical thresholds. It explicitly warns that rate-limited errors are absent while sessions continue, which can make stability appear artificially high. Avalon therefore reports dropped, sampled, and rate-limited denominators next to crash-free measures.

Its [Electron session definition](https://docs.bugsnag.com/platforms/electron/capturing-sessions/) starts on launch or foreground after a defined background interval and supports manual lifecycle control. Avalon should define its own desktop session once and use it consistently across product and crash analytics. Bugsnag's [release dashboard](https://docs.bugsnag.com/product/releases/releases-dashboard/) combines stability with release adoption; Avalon needs the same view to separate a bad release from a widely adopted release.

## OpenTelemetry and Honeycomb

The [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) is a vendor-neutral agent that receives, processes, and exports telemetry while handling retries, batching, encryption, and sensitive-data filtering. Its [architecture](https://opentelemetry.io/docs/collector/architecture/) formalizes receiver/processor/exporter pipelines and fan-out; its [semantic conventions](https://opentelemetry.io/docs/specs/semconv/) keep attribute meanings stable across systems.

Avalon's regional collector should resemble that pipeline conceptually:

1. receive from typed desktop and API sources;
2. validate policy and schema;
3. redact, normalize, enrich, and sample;
4. persist durably;
5. export through one or more versioned destination adapters.

Avalon does not need to expose OTLP in V1. Product events have consent, identity, retention, and semantic requirements that generic traces do not solve. W3C trace context remains useful for tying a product operation to technical spans.

Honeycomb's [structured log guidance](https://docs.honeycomb.io/send-data/logs/structured) and [trace/log correlation](https://docs.honeycomb.io/send-data/logs/opentelemetry/sdk) show the value of consistent high-cardinality fields. Its [custom instrumentation guidance](https://docs.honeycomb.io/send-data/standardize/add-custom-instrumentation) makes the complementary point: automatic instrumentation reveals system shape, while application owners must add the meaningful business context. Avalon therefore keeps opaque high-cardinality operation, request, launch, and trace IDs, but derives business events explicitly.

## Snowplow and RudderStack

Snowplow's [event fundamentals](https://docs.snowplow.io/docs/fundamentals/events/) use self-describing events tied to a named and versioned schema. Its [custom event](https://docs.snowplow.io/docs/events/custom-events/) and [Iglu schema registry](https://docs.snowplow.io/docs/api-reference/iglu/) documentation demonstrate schema validation and evolution. The [pipeline](https://docs.snowplow.io/docs/pipeline/) separates collection, validation, and enrichment into good and failed streams; [failed-event documentation](https://docs.snowplow.io/docs/api-reference/failed-events/) supports diagnosis and recovery.

Avalon adopts schema identity and version, validated enrichment, and a visible rejection path. It intentionally does not retain a malformed raw event: storing it would create a shadow content lake outside the approved tracking plan.

RudderStack's [tracking-plans-as-code guidance](https://www.rudderstack.com/learn/data-strategy/tracking-plans-as-code/) puts event names, required and optional properties, types, enums, and identity rules under version control and CI. Its [transformations product](https://www.rudderstack.com/product/transformations/) supports destination-specific allow, deny, mask, and transformation logic. Avalon adopts both practices: generated client/server interfaces from the plan and a separately tested PostHog mapping that cannot expand the source schema.

## Amplitude and automatic capture

Amplitude's [autocapture documentation](https://www.amplitude.com/docs/data/autocapture) captures page views, clicks, form interactions, downloads, attribution, and URL context. It also recommends precision tracking where business logic matters. Critically for Avalon, click capture can include displayed text from the interacted element; pattern-based masking cannot understand whether arbitrary work text is confidential.

Amplitude's [session replay privacy settings](https://amplitude.com/docs/session-replay/manage-privacy-settings-for-session-replay) offer several masking levels but warn that element attributes can remain visible. Remote privacy configuration fails closed if it cannot load, which is a good pattern for optional diagnostics. Its [privacy and consent guidance](https://amplitude.com/docs/data/privacy-and-consent-implementation) recommends choosing the consent model before implementation and treating replay separately.

The conclusion is not that all automatic capture is unsafe. Automatic, content-free lifecycle and reliability events are low maintenance and necessary for denominators. Automatic capture derived from arbitrary UI structure or network activity is unsafe for Avalon and produces weaker product semantics than explicit events.

## What best-in-class products would make easy—and the custom cost

Building a regional ingress that forwards JSON to PostHog is small. Building a dependable telemetry and crash product is not. The custom scope includes:

- SDK lifecycle across main, preload, renderer, offline use, logout, update, and shutdown;
- schema generation, validation, evolution, sampling, and destination compatibility;
- consent and admin policy resolution;
- regional outbox, retry, deduplication, replay, rejection, and dead-letter operations;
- identity derivation, rotation, aliasing policy, and deletion;
- native unauthenticated-but-abuse-resistant upload;
- dump retention, private artifacts, release matching, symbolication compute, grouping, regression, and support access;
- crash-free session denominators and lost-data accounting;
- provider configuration drift and privacy fixture monitoring;
- operational dashboards, alerts, and on-call runbooks.

The PRD keeps the architecture custom because Avalon already has a strong regional API boundary and unusually sensitive content. The decision should be revisited after the native-crash spike. If symbols, grouping, or the private viewer threaten the roadmap, using Sentry or Bugsnag behind the same regional policy and destination abstraction is a valid alternative—not an architectural failure.

## Research-driven requirements checklist

- [ ] Canonical envelope includes unique ID and four timestamps.
- [ ] Tracking plan is versioned, generated, reviewed, and CI-enforced.
- [ ] Invalid-event metadata is visible without retaining invalid raw payloads.
- [ ] Direct and derived identities are minimized, scoped, rotatable, and deletable.
- [ ] Automatic capture is limited by mechanism, not merely convention.
- [ ] Detailed diagnostics fail closed when policy is unknown.
- [ ] Native dumps never rely on graceful in-process delivery.
- [ ] Release artifacts are private, immutable, matched by debug/build identity, and uploaded before release.
- [ ] Crash-free measures disclose loss, sampling, and rate limiting.
- [ ] Provider-side privacy controls supplement server-side enforcement.
- [ ] EU/Global applies to the full lifecycle, not just the ingest URL.
- [ ] Destination mappings and replays preserve event identity and adapter version.
- [ ] PostHog model/product-development opt-out and GeoIP configuration are verified.
- [ ] Public-site collection remains separately gated from desktop/API collection.
