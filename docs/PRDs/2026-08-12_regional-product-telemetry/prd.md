# Regional product telemetry and crash reporting

> Created 2026-08-12.
>
> Scope: Rally desktop, regional APIs, product analytics, and error reporting
>
> Companion documents: [research](research.md), [design](design.md), [implementation plan](plan.md), [state](state.md)
>
> Standing brief: [Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md)

## Summary

The default collection model is intentionally hybrid. Rally automatically captures a narrow set of content-free lifecycle and reliability signals. Product teams add explicit semantic events for meaningful actions and outcomes. Rally does not enable DOM autocapture, generic click or key capture, session replay, console capture, arbitrary network breadcrumbs, or an unrestricted `capture(name, properties)` API.

Essential content-free reliability telemetry, low-data product analytics, and detailed crash reporting are enabled by default. Each user has a Product analytics setting that defaults on. Turning it off stops that user's semantic product analytics and every detailed diagnostic payload, including JavaScript exception stacks, diagnostic breadcrumbs, and native crash dumps. Essential content-free reliability counters continue so Rally can operate and secure the service, but they contain no message, stack, fingerprint, or breadcrumb. Native upload is disabled immediately; preventing new local Crashpad dumps and safely purging its database takes effect on restart because Electron Crashpad cannot be stopped once started. The settings UI has no narrower crash-only switch: Product analytics is the single user-facing control for nonessential telemetry.

## Motivation

This is a product-directed measurement and reliability capability, not a response to a quantified incident or support trend. The 2026-08-12 product request explicitly requires PostHog integration, regional behavior, deep Electron crash reporting, privacy-aware automatic capture, and client/server signal correlation. No support-frequency or production-crash baseline was supplied, so this PRD does not invent one. The verifiable source baseline explains why the work must precede any trustworthy measurement:

- The [desktop main process](../../../apps/desktop/src/main/index.ts) has two production failure observers—renderer termination and unresponsiveness—and both end in local logging. The [renderer error boundary](../../../apps/desktop/src/renderer/App.tsx) also ends in local logging. The repository contains zero production remote desktop crash-report transports, so 100% of failures observed by these hooks are unavailable for remote grouping, affected-session counts, or release comparison unless a user separately supplies local evidence.
- The [desktop build configuration](../../../apps/desktop/electron.vite.config.ts) generates source maps for all three JavaScript bundles—main, preload, and renderer—but the repository has zero private artifact-upload or production symbolication paths. All three production bundle classes therefore lack a remote symbolication lifecycle.
- The regional APIs have structured logs and deliberately content-free root-run Analytics Engine rows, but the repository has zero product-analytics destination adapters and zero shared client-intent/server-outcome analytics contracts. Activation-funnel coverage and crash-free release baselines are consequently both zero today; continuing without this work cannot establish the frequency it is meant to measure.
- At the time of this V1 decision, the public Cookie & Tracking Notice promised
  zero behavioral analytics and no nonessential consent banner. The later,
  separately approved [public-site telemetry PRD](../2026-08-13_public-site-telemetry/prd.md)
  owns the disclosure and regional identity change; site measurement was not
  introduced incidentally with desktop telemetry.

Leaving this unchanged means every future desktop crash still requires reproduction or user-supplied local evidence, every release still lacks a crash-free comparison, and product changes still lack an authoritative activation funnel. The initial rollout therefore establishes the measurement baseline itself; later investment decisions must use observed volume, loss, support value, and funnel coverage rather than retroactively treating this PRD as evidence of customer demand.

The design is informed by current official documentation for PostHog, Twilio Segment, Sentry, Electron Crashpad, OpenTelemetry, Amplitude, RudderStack, Snowplow, Bugsnag, and Honeycomb. The detailed comparison and links live in [research.md](research.md).

## Goals

1. Every reviewed activation or adoption funnel can pair a typed client intent with its authoritative regional server outcome by `operation_id`, without storing customer content or placing direct identity in semantic event or crash payloads.
2. A packaged forced fixture for each supported desktop OS and architecture produces the expected JavaScript or native diagnostic signal, and an eligible native crash becomes a Rally-ingested, privately symbolicated structured report after the next successful launch.
4. Every accepted event has stable event, launch, session, operation, request, and trace correlation where applicable; duplicate delivery and clock-skew fixtures produce deterministic query results.
5. CI rejects an unregistered event, prohibited or unclassified property, incompatible unversioned schema change, and destination field outside the approved mapping.
7. A destination adapter can be disabled or replaced without changing renderer APIs, the canonical event schema, consent authority, regional identity allocation, raw crash storage, or internal deletion workflows.
8. The first release leaves the public site at zero behavioral analytics; any future site measurement starts with a separate PRD.

## Non-goals

1. Recreate Segment's full customer data platform, identity graph, audience builder, or catalog of hundreds of destinations. **Deferred:** one external destination does not justify another processor or a general CDP; the adapter boundary keeps that option open if destination count grows.
3. Record prompts, model responses, transcripts, files, connector content, email bodies, note bodies, terminal output, arbitrary logs, or other customer content for analytics or crash context. **Rejected:** these categories are unnecessary for the stated product questions and would defeat the privacy boundary. The narrowly allowlisted account and workspace profile fields below are contact metadata, not customer content or crash context.
4. Enable Electron renderer DOM autocapture, generic click or keyboard capture, session replay, automatic console breadcrumbs, or automatic request/response capture. **Rejected:** these mechanisms can collect customer content before a semantic allowlist can distinguish it.
5. Replace Cloudflare logs, traces, or the existing content-free Analytics Engine dataset used for service operations. **Rejected:** operational observability and product telemetry have different identity, residency, retention, and query contracts and must remain separate.
6. Use PostHog feature flags as Rally's runtime flag system. **Rejected for this scope:** Flagship remains authoritative so telemetry delivery cannot change runtime behavior; experiments may export exposure metadata to PostHog.
7. Guarantee exactly-once analytics delivery. **Rejected:** distributed offline delivery cannot make that promise reliably; the product provides at-least-once delivery with deterministic event identifiers and destination deduplication where supported.
8. Add public-site behavioral analytics, attribution, identifiers, advertising pixels, or a consent banner in the first release. **Deferred:** a later PRD must decide the entire site measurement contract rather than inheriting speculative V1 architecture.
9. Expose raw native crash dumps, raw stack frames, or sensitive diagnostic attachments in PostHog. **Rejected:** PostHog receives only the approved structured report; raw artifacts remain in restricted regional Rally storage because they can contain customer content.
10. Treat telemetry as a prerequisite for completing a user action. **Rejected:** collection and forwarding failures must never change the action result, because analytics availability is not part of the product transaction.

### Collection model

Every signal belongs to one of three policy classes:

| Class | Examples | Approved default | Data ceiling |
| --- | --- | --- | --- |
| Essential reliability | launch/session counters, app version, update result, process-gone reason, API outcome class, dropped-event counts | On | Content-free enums, booleans, bounded durations, opaque IDs |
| Product analytics | named screen views, explicit feature actions, funnel steps, coarse configuration choices, server-confirmed outcomes | On, with a per-user setting to disable | Allowlisted semantic properties; no customer content |
| Detailed diagnostics | native minidump, sanitized exception stack, typed breadcrumb ring | On only while Product analytics is enabled; every detailed payload stops when it is disabled | Minimum diagnostic payload, separate retention and access |

The Product analytics preference is account-scoped rather than installation-scoped. The Global identity control plane stores the canonical boolean and monotonic version as minimal account metadata, not telemetry. The active regional API receives and stores a local projection through a narrow named RPC so API-native and asynchronous events can enforce the same choice without querying another region on an event path. Region activation includes the current preference version. This control RPC carries a Global-issued opaque `preference_subject_handle`, the preference, and the version. The handle is random, region-bound control-plane metadata mapped to the regional user during activation; it is never an analytics identity, event property, destination field, or general account credential. The RPC never carries an event, dump, stack, raw platform identifier, or workspace content. Existing users' stored choices apply as soon as the identity bootstrap session is established. New users use the approved default-on value. The control remains in the normal authenticated Settings experience; Rally does not add a Product analytics toggle or consent interruption to onboarding.

The desktop applies an opt-out locally before making a network request, stores it durably, stops product events and detailed diagnostics, stops and purges the separate crash-upload spool, invalidates the active Crashpad generation, and queues the preference mutation separately from telemetry. Nonessential collection cannot resume until the regional API acknowledges the canonical version. The API commits the canonical preference and its regional projection before acknowledging the change. Other installations refresh the setting at session bootstrap and on a version notification; a stale write must refetch rather than overwrite a newer choice. An offline opt-out remains locally effective and is sent before any nonessential delivery after reconnect. Opt-in requires a server acknowledgement before collection resumes.

Logged-out anonymous collection uses the durable local setting; logout never resets an opt-out to the default. A fresh installation has no account preference and uses the approved default-on value. If subsequent authentication reveals that the account is already opted out, the identity boundary closes the epoch, issues no identity transition or profile job, suppresses further nonessential events, and deletes its unsent local nonessential rows. Anonymous records already accepted by a regional API remain unlinked in their original route and expire under their immutable retention deadlines; V1 does not add a cross-store retrospective purge for activity accepted before the account was knowable.

The regional API checks the persisted projection when a user-attributable server event is created and again before it is forwarded. An opt-out suppresses queued product events, detailed diagnostics, and identify/group-identify jobs for that user, including asynchronous outcomes created by earlier actions. If the current preference version cannot be established, the API permits only essential reliability events. The account-scoped user setting is the sole V1 control for nonessential telemetry; there is no workspace-admin setting or separate crash toggle. Essential content-free reliability signals continue after opt-out.

Automatic collection is limited to events whose shape is stable and whose fields are content-free:

- application launch, ready, foreground/background, graceful exit, and inferred unclean exit;
- desktop session start and end;
- update check, download, apply, and rollback outcomes;
- renderer process gone, renderer unresponsive/responsive, preload initialization failure, main-process unhandled-exception occurrence, and renderer error-boundary occurrence, expressed only as bounded content-free classes;
- API request duration and outcome class for an allowlisted operation name, without URL, query, headers, or body;
- spool pressure, rejected event counts, destination delay, and crash-upload state.

All business events are explicit. A feature emits a typed event such as `workspace_switch_completed` or `run_completed`; it does not pass an arbitrary string and property bag. Router instrumentation deliberately calls a named `screen_viewed` method with a registered screen enum when a planned route becomes visible. That is Product analytics subject to opt-out, not automatic DOM/URL capture. The tracking plan defines the event owner, source of truth, allowed sources, property schema, privacy class, retention, sampling, and destination mappings.

### Identity and correlation

Rally still does not send raw user, workspace-identity, or account identifiers, authentication tokens, IP addresses, device-advertising identifiers, third-party account identifiers, or any unregistered profile field to PostHog. Closed product events may include opaque resource UUIDs for work streams, messages, notes, automations, runs, and invocations when required for paths, joins, or deduplication; no title, body, clipboard value, tool argument, output, or provider content accompanies them. Provider-native identify and group-identify jobs live in the existing ordered Global outbox and contain only the immutable destination analytics ID, the applicable anonymous epoch for an unresolved transition, the two approved person values or one approved workspace value, command/version metadata, and the normal immutable 90-day deadline. The initial epoch-transition job cannot be superseded while unresolved; a newer person-profile value may coalesce into it only while preserving `$anon_distinct_id`. Later profile and group updates may supersede older updates after the transition acknowledges or terminally fails. Jobs are deleted sooner after acknowledgement, opt-out, subject deletion, or eligible supersession. V1 adds no profile lookup handle, restricted mapping service, or separate profile replay/retention subsystem. Provider-side handling after PostHog acknowledges the mutation remains governed separately.

The authoritative account and workspace records hold cryptographically random, immutable analytics IDs scoped by environment and region. configured deployments IDs are independently minted, never exported across regions, never rotated, and deleted with the subject; recreating a deleted subject produces a new ID. Installation and logged-out epoch IDs are independently random. This keeps PostHog people, groups, and funnels stable without exposing raw platform or identity-record IDs or creating a key-rotation migration problem. The lifetime installation identity is reserved for device-level reliability and never links to a person. Once authentication resolves the canonical preference, Rally links the current anonymous epoch—and only that epoch—to the stable regional person inside its already fixed route. A later explicit workspace route applies prospectively and never migrates the link, profile, or events.

Identity has five explicit scopes: `installation` for device-level reliability, `anonymous-epoch` for one logged-out product journey, `platform-user` after Global identity authentication but before workspace activation, `workspace-user` after a regional person/workspace session exists, and `workspace` for unattended regional execution with no responsible person. The workspace scope uses the immutable workspace analytics ID as a personless destination distinct ID and group key; it cannot enter through desktop telemetry ingest. The platform-user state is pseudonymous until an eligible Global `$identify` supplies the approved contact profile: Rally knows the canonical platform user, but the destination key remains the stable regional analytics ID rather than a raw platform ID. A server-created `onboarding_journey_id` joins the bootstrap session's client presentation and intent events to authoritative onboarding API outcomes. It is not an authentication credential and is bound server-side to the bootstrap session. The server also binds one coarse provisional route to the journey so VPN or network changes cannot split it across destinations. Logout, explicit account switching, and abandonment of a login attempt close the current anonymous epoch before another account can authenticate against it; the next logged-out journey receives a fresh identifier.

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

The initial onboarding plan follows the same division. The desktop owns screen presentation and explicit intent events such as `onboarding_screen_viewed`, `workspace_creation_requested`, and `invitation_acceptance_requested`. The Global coordinator owns `onboarding_state_resolved`; the regional service owns activation, creation, and invitation-acceptance completion. Events may contain fixed state and outcome enums, invitation-count buckets, and a selected-region enum after the user acts. They never contain an organization name, email, inviter name, raw invitation ID, raw workspace ID, or membership payload returned by regional discovery.

### Electron reporter

The Electron main process owns reporter initialization, policy, identity state, the breadcrumb ring, the local spool, batching, network delivery, and shutdown flush. The renderer receives only narrow preload methods typed against the tracking registry. It cannot obtain provider keys, a PostHog client, a raw destination URL, or an arbitrary event method.

The local spool contains only already-sanitized envelopes. It is bounded by count, bytes, and age; evicts the oldest low-priority analytics before essential reliability events; uses jittered exponential backoff; and reports aggregate drop counts after recovery. Logout clears authenticated identity from future events and removes queued authenticated product analytics unless retention has been explicitly approved. Crash artifacts follow a separate local lifecycle.

Developer builds provide a telemetry inspector showing the event name, schema version, policy class, allowed properties, selected region, local queue state, and validation result. Values classified as diagnostic or identifying stay redacted. This is the primary way feature authors verify instrumentation without relying on the PostHog live-event view.

### Crash and error coverage

Rally treats crash reporting as four complementary layers:

1. **JavaScript errors.** While Product analytics is enabled, main and renderer handlers report handled failures, uncaught exceptions, unhandled promise rejections, and React error-boundary failures through a sanitized exception schema. Stack frames are normalized; query strings, local usernames, workspace paths, source excerpts, request bodies, and dynamic messages are removed or tokenized before upload. When the setting is off, only the corresponding essential occurrence class is reported, without message, stack, fingerprint, breadcrumb, or arbitrary metadata.
2. **Electron process health.** Main-process listeners report renderer termination reason, exit code class, sandbox or GPU process role, unresponsive/responsive transitions, and recovery action. Repeated events are rate-limited and grouped by launch.
3. **Unclean exits and launch crashes.** A launch marker is committed before UI initialization and cleared on graceful exit. The next launch reports an inferred unclean exit and whether the prior release was still in its launch window. This detects failures for which in-process JavaScript delivery never ran.

The crash product measures, at minimum, crash-free launches, crash-free sessions, affected installations, launch-crash rate, unresponsive-session rate, issue recurrence, first-seen/last-seen release, and release adoption. Crash-free rates use only reporting-eligible launches and sessions: detailed crash reporting must be enabled continuously from their start through their end. A preference change in either direction makes the current launch/session ineligible; the next launch/session can establish the new eligibility. Essential launch/session counters still measure total usage, and dashboards show eligibility coverage alongside the crash-free rate. A crash counts once against an eligible session even if the same session produces multiple reports. Rate limiting, sampling, upload rejection, and missing consent state must not make stability dashboards silently look healthier; discarded, ineligible, and eligible denominators are exported separately.

Typed breadcrumbs are a small ring of safe state transitions—for example `screen_changed`, `update_started`, `workspace_switch_started`, and coarse API operation outcomes. They use the same schema registry, never include display text or arbitrary metadata, and are attached only when detailed diagnostics permits them. Main mirrors the bounded, already-sanitized ring to an atomic per-launch crash sidecar with restrictive permissions and a declared freshness budget. The uploader associates the sidecar by launch/process identity, deletes it with the local dump, and never uploads it separately. This makes recent context recoverable without claiming lossless capture after a fatal main-process crash.

### Regional pipeline and destinations

Each regional API exposes authenticated batch ingestion for normal events and a separately protected multipart endpoint used by Rally's main-process crash uploader. Crashpad never places a token or capability in a submission URL. Normal ingestion validates the envelope, clamps timestamps and sizes, applies policy and redaction, resolves stable regional analytics identities, and commits an accepted record to a regional D1 outbox before returning success. The Queue message contains only the region and opaque record identifier, preserving the repository's existing queue-content boundary. A regional consumer loads the record, runs destination transforms, sends it, and records attempt and terminal state.

Invalid events do not enter product analytics. Production rejection records contain only fixed violation codes, a registered event/schema identifier or the sentinel `unknown`, a registered source enum or `unknown`, server-derived release/build identity, registered field identifiers or `unknown`, and aggregate counts. Unknown event names, property keys, path segments, schema strings, client release strings, and payload fragments are never persisted, logged, hashed for later inspection, or reflected to another telemetry system. Developers get local validation failures from the checked-in runtime schema without echoing unsafe values. Delivery failures retry with backoff and then enter an operator-visible dead-letter state. Backlog age, rejection rate, duplicate rate, destination latency, and drop counts have explicit alerts.

The US PostHog project is the first external destination adapter and is enabled only in the Global deployment:

- use the US ingestion host only from the Global destination worker;
- set deterministic event identifiers and preserve normalized original time;
- set person-profile processing only for approved authenticated product events;
- disable geolocation and do not forward the request IP;
- map JavaScript exceptions through the supported server SDK exception API after validating its output in a privacy fixture suite;
- map complete sanitized Global native crash reports to the verified PostHog exception/error-tracking contract where supported, with a Rally-owned typed event for approved fields that contract cannot represent;
- attach Flagship experiment exposure properties only to approved exposure and metric events;
- keep profiles minimal: use ordered outbox identify/group-identify jobs to set only verified primary email and current display name on an eligible Global person and current workspace name on an eligible Global `workspace` group; never place those values in semantic event or diagnostic payloads or use them as destination identifiers;
- opt Rally data out of provider product/model development contractually or through the provider control before production data flows.

Destination configuration and credentials exist only in the matching regional server environment. A destination can be paused, sampled, replayed from the allowed retention window, or replaced without shipping a new desktop release. Destination replay preserves `event_id` and records adapter version.

### Prohibited data

Semantic event, exception, crash, breadcrumb, rejection, and log schemas reject these fields regardless of consent tier unless a later PRD explicitly changes the product contract. The only current exception is the dedicated Global identify/group-identify allowlist above:

- prompt, response, transcript, note, document, file, email body, connector, calendar, issue, chat, or terminal content;
- filenames, absolute or home-relative paths, repository remotes, branch names, window titles, URLs with path/query/fragment, DOM text, and clipboard data;
- authentication headers, cookies, tokens, OAuth material, credentials, and local secrets;
- raw request or response bodies, arbitrary console output, SQL text, and arbitrary exception metadata;
- names and email addresses outside the three allowlisted profile fields, plus IP addresses, precise location, advertising IDs, raw account/user/workspace-identity IDs, and third-party account identifiers; opaque resource UUIDs are permitted only in expressly registered product properties;
- source-code excerpts and memory attachments beyond the approved minidump path.

Property names matching sensitive-key patterns are rejected. String fields have enum or strict length/character constraints. Unknown properties fail validation rather than being forwarded. Free-form user crash descriptions, if introduced later, are stored as support content under a distinct consent and retention flow and never forwarded to a product analytics destination.

### Public website

The first release does not alter the website. This is required because the current Cookie & Tracking Notice states that Rally does not use behavioral analytics or non-essential tracking and therefore does not display a consent banner.
V1 adds no site event schema, identifier, endpoint, SDK, destination, consent behavior, or acceptance fixture. Any future site measurement requires a separate PRD based on the notice, legal requirements, regional architecture, and product questions that exist at that time.

### Retention, deletion, and access

Every schema declares a retention class. The approved product ceilings, subject to legal or privacy review requiring a shorter period, are:

- local normal-event spool: delivery eligibility ends 14 days after creation; a running app purges on deadline and a dormant app purges expired rows on the next launch before delivery;
- local Crashpad reports, manifests, invalidation records, and crash sidecars: upload eligibility ends 14 days after creation; a running app purges the rotated upload spool on deadline, and all expired rotated or unrotated material on a dormant device is physically purged on the next application launch before any upload attempt or Crashpad restart;
- regional accepted-event outbox, replay payload, identify/group-identify job, terminal-failure state, onboarding route, and delivery/deduplication receipt: 90 days from regional acceptance or metadata creation; delivery-state changes never restart the clock, and identity/profile jobs are removed sooner after acknowledgement, opt-out, deletion, or supersession;
- rejection metadata: rolling 90 days, stored in independently expiring time buckets so a new rejection cannot renew an earlier observation;
- raw native dumps: 90 days from receipt;

Flags may reduce sampling or disable a schema or destination, but no remote feature flag is a privacy boundary. Collection code must enforce the compiled allowlist and effective consent even when configuration is stale or incorrect.

### Acceptance criteria

The PRD is implemented when all of the following are true:

1. A typed tracking plan lists every production event, allowed source, property, classification, owner, retention, sampling, and authoritative outcome; CI rejects unregistered events and incompatible schema changes.
2. Renderer code has no PostHog or general analytics SDK, provider key, generic capture API, or direct telemetry network path. Tests prove that only the narrow preload contract reaches main.
4. Client intent and server outcome can be queried by `operation_id` without using raw user, workspace, or content fields. Clock-skew and duplicate tests produce deterministic results.
5. A regional API acknowledgement means the event is durably recorded or explicitly rejected; provider downtime does not lose accepted events within the documented retention and capacity limits. Every accepted row receives an immutable 90-day deletion deadline at acceptance, retry stops at that deadline, and success or terminal failure cannot extend it. Journey route and content-free delivery/deduplication metadata receive the same fixed ceiling at creation.
8. JavaScript main, preload, and renderer errors; renderer gone; unresponsive/recovered; unclean exit; launch crash; and native crash each have a tested detailed signal while Product analytics is enabled and a tested content-free essential occurrence where applicable when it is disabled. Neither fatal path requires a graceful shutdown.
9. Crash-free launch/session calculations include only continuously reporting-eligible launches and sessions, disclose eligibility coverage and dropped, sampled, rejected, or rate-limited reports, and segment by release, platform, architecture, region, and channel. Tests cover enabling and disabling mid-session without moving an ineligible session into the crash-free denominator.
10. The account-scoped Product analytics setting defaults on and takes effect locally without waiting for a destination call. Turning it off stops new product events, JavaScript diagnostic payloads, breadcrumbs, native dump upload, and identify/group-identify jobs; purges affected queued rows; and keeps nonessential collection off until the regional API acknowledges the canonical account version. Other installations and server-native/asynchronous events honor the same persisted preference. Multi-installation, offline opt-out, stale-write, regional activation, queued-event and identity/profile-job suppression, and failure-to-resolve-policy tests all fail closed to essential telemetry only.
12. The account-scoped Product analytics setting is the sole V1 nonessential telemetry control. Tests prove that user-off suppresses product events, detailed diagnostics, and identify/group-identify jobs at creation, regional acceptance, asynchronous emission, and destination delivery while essential reliability continues. No workspace-admin or crash-only telemetry setting is exposed or enforced.
14. Disabling Product analytics stops Rally's main-process dump uploader immediately and durably invalidates the active Crashpad generation without mutating its live database. After restart and before Crashpad can start again, Rally purges the invalidated generation and sidecars and verifies the purge in packaged tests. Tests cover database locks, a crash before or after invalidation, and an upload already in flight from an older rotated generation; the UI promises neither synchronous recall nor deletion of an upload the regional API already accepted.
16. Rejection-path tests place synthetic secrets in unknown event names, schema strings, property keys, field paths, release fields, and payload fragments and prove that only fixed sentinels, registered identifiers, server-derived release identity, violation codes, and counts reach storage or logs.
17. Telemetry endpoint abuse tests cover payload size, schema bombs, compression bombs, malformed minidumps, replay, forged regions, event floods, and expired upload capabilities.

### Success measures

Within the first two stable releases after full desktop rollout:

- at least 99.5% of valid, accepted normal events reach the configured destination within 15 minutes, excluding declared provider incidents;
- p95 telemetry ingestion adds less than 25 ms to API handler wall time because delivery is deferred after durable regional acceptance;
- desktop collection consumes less than 0.5% average CPU, 15 MB memory, and 1 MB/day network at the default sampling policy for a typical active user;
- at least 95% of forced and dogfood native crashes are symbolicated to an owned frame for releases whose symbols were published;
- release dashboards report crash-free launches and sessions with reporting-eligibility coverage and known delivery/drop denominators;
- the initial activation funnel has both client intent and server-confirmed completion for every state-changing step.

Volume, performance, and symbolication targets are engineering budgets rather than promises to customers. They are revisited after dry-run data establishes realistic baselines.

## Impact on the product contract

This PRD changes Rally's external and internal product contract in material ways:

- Rally begins collecting defined reliability and, when approved, product-usage telemetry from the desktop and API. The Privacy Policy, DPA annexes where applicable, subprocessor register, in-product settings, and support documentation must describe the categories, purposes, providers, retention, controls, and regional behavior before external rollout.
- The public site's existing no-behavioral-analytics statement remains true in the first release. A site rollout cannot occur as an implementation detail; it requires a separate PRD.
- Desktop users gain an account-scoped Product analytics setting in the normal authenticated Settings experience; onboarding does not gain another toggle or interruption. The setting defaults on and describes what is collected in plain language with a link to a field-category reference. Turning it off disables semantic product analytics, JavaScript diagnostic stacks and breadcrumbs, and native crash reporting on all installations once synchronized, while essential content-free reliability telemetry continues. The UI explains that fully stopping local Crashpad dump generation and purging its pending database requires a restart, although upload stops immediately.
- A native minidump can contain memory fragments and therefore may contain customer content despite Rally's minimization. It is never described as content-free; it is covered by the disclosed Product analytics master control and receives separate access and retention treatment.
- Telemetry does not become customer workspace content, a collaboration surface, or a source of product truth. It is advisory and can be incomplete because of policy, offline use, sampling, rate limits, or provider failure.

## Decision log

None yet.

## Key design decisions

1. **Rally owns the collection boundary and uses vendors as destinations.** The narrow Global bootstrap/identity ingest and regional workspace ingests are the only places that can consistently enforce routing, identity allocation, the tracking plan, user preference, durable delivery, redaction, and deletion across desktop and server signals. A direct renderer-to-PostHog integration and a thin reverse proxy are rejected because both leave policy and event semantics in an untrusted, independently released client. Buying a full Segment-like CDP is deferred because the first release has one external destination and Rally already operates the relevant API boundaries.
2. **Product analytics defaults on per user and is the only V1 control for nonessential telemetry.** A default-on setting preserves useful product and release evidence without requiring a first-run consent interruption. The control lives in authenticated Settings rather than onboarding. Turning it off disables semantic product events, identity/profile jobs, and every detailed diagnostic payload; only the compiled content-free essential allowlist remains. Workspace-admin and separate crash-only controls are deferred because they multiply policy state without a stated V1 requirement. A model where native dumps or JavaScript stacks continue after the user setting is off is rejected because the label would understate the choice.
4. **Automatic capture stops at content-free lifecycle and reliability signals.** Stable counters and bounded enums supply release denominators without depending on every feature author. DOM interaction, console, replay, and arbitrary network capture are rejected because Rally's interface displays customer work content and mechanism-based scrubbing cannot supply a reliable semantic or privacy boundary.
9. **Only a per-login anonymous epoch may link to a person.** Authentication claims the current epoch exactly once inside its already fixed telemetry route; the lifetime installation identifier never links. Logout, account switching, or login abandonment rotates the epoch. If the provisional and explicit workspace regions differ, the identity link and profile remain in the original route and no cross-region bridge or migration is created.
10. **Public-site telemetry is outside V1.** The site remains unchanged and sends no behavioral analytics. A future site initiative starts from a separate PRD rather than carrying speculative identity, event, routing, consent, and destination architecture here.
11. **Regional analytics IDs are immutable random identifiers.** Each authoritative person/workspace subject stores one random ID per environment and region for its lifetime. Rotating keyed hashes are rejected because rotation would fragment PostHog people, groups, and funnels or require a provider-side identity migration. Raw platform, account, user, and workspace-identity IDs remain internal; expressly registered opaque resource UUIDs may be product-event correlation properties.
