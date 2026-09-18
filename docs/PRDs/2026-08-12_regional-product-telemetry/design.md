# Design: regional product telemetry and crash reporting

> Created 2026-08-12.
>
> Related: [research](research.md), [implementation plan](plan.md)

## Design principles

1. Rally's authenticated identity and regional APIs are the collection boundary; vendors are destinations.
2. The event contract is an allowlist. Unknown data is rejected, not forwarded and scrubbed later.
3. Main owns Electron telemetry. Renderer code can express semantics but cannot own policy or transport.
4. A native dump is potentially customer content, even if most dumps do not contain readable content.
5. Client intent and server truth are distinct events joined by an operation identifier.
6. Accepted telemetry is durable before acknowledgement; telemetry never blocks the product action it describes.
7. Region, consent, identity, retention, and deletion are end-to-end properties.
8. PostHog-specific concepts stop at the destination adapter.

## Canonical event envelope

The illustrative TypeScript shape below is a design contract, not a request to commit this exact implementation before the tracking-plan spike:

The server adds, in a separate trusted record:

- `received_at` and normalized `timestamp`;
- clock-skew magnitude and normalization status;
- analytics person/workspace/installation/anonymous-epoch identifiers where permitted;
- authenticated entitlement and workspace context from server state;
- ingress policy version, schema-registry version, and redaction version;
- payload hash, delivery state, destination adapter version, and attempt metadata.

The client cannot choose its trusted region, authenticated identity, entitlement, or server outcome.

### Event ID and duplicate semantics

The producer creates a UUIDv7 `event_id` once and persists it with the local envelope. Retries, regional outbox processing, destination retry, and operator replay preserve it. The ingest database has a unique regional event key. A duplicate with an identical payload is acknowledged as duplicate; a reused ID with a different payload is rejected and alerted as an integrity violation.

This provides deterministic deduplication inside Rally. The Global PostHog adapter also passes a stable destination UUID where supported. Because provider deduplication windows and behavior can change, the public guarantee remains at-least-once.

### Time semantics

The producer records `original_timestamp` when the action occurred and `sent_at` immediately before each batch leaves the desktop. The regional API records `received_at` and computes a normalized timestamp using the Segment-style offset between original, sent, and received times. It clamps events outside the allowed replay horizon and records a clock-skew flag. Server-native events use server time for all applicable fields.

Product queries use normalized time. Delivery dashboards use received and delivered time. A client cannot backdate an event to escape retention or overwrite a server outcome.

## Tracking plan registry and typed interfaces

The repository contains one checked-in TypeScript tracking registry built from discriminated unions and runtime schemas. Each event entry has:

- stable name and schema version;
- plain-language definition and product question it answers;
- owner and review group;
- allowed sources and one authoritative source;
- category and legal purpose;
- property names, primitive types, enums, bounds, optionality, and classification;
- allowed identity scopes;
- sampling policy and priority;
- local, regional, internal crash, and destination retention classes;
- destination mappings;
- compatibility and deprecation status.

The narrow renderer facade, main/API constructors, and PostHog mapping are handwritten against registry-derived TypeScript types. Compile-time exhaustiveness requires every registered event to have an explicit source and destination treatment. Runtime schemas, redaction rules, and golden valid/invalid/privacy fixtures live beside the relevant registry entry. V1 does not add a code generator or generated documentation pipeline; the registry is the data dictionary, and automation can be added later only if manual drift becomes measurable.

CI fails on unregistered event names, arbitrary properties, incompatible changes without a version bump, missing owners, prohibited property classifications, or a destination transform that emits a field absent from its allowed mapping. An additive diagnostic or breadcrumb field may remain in the same schema version only when it is optional, bounded, classified, and covered by privacy fixtures. A required field, removal, type change, broadened meaning, or changed privacy classification requires a version bump and migration/deprecation note; a semantic meaning change requires a new event or schema version.

### Main-process authority

`TelemetryReporter` starts before normal windows, after the installation identity and current routing state can be read. It owns:

- compiled policy defaults, the durable local user choice, the last acknowledged canonical preference version, and effective remote restrictions;
- installation, anonymous-epoch, launch, and session identifiers;
- authenticated identity state supplied after session validation;
- the server-bound onboarding journey and provisional/explicit routing state;
- typed breadcrumb ring;
- local event validation;
- bounded persistent spool and batch scheduler;
- explicit flush on background/shutdown where time allows;
- crash reporter configuration and pending-upload policy;
- safe diagnostic logging and development inspector state.

### Renderer and preload

The preload exposes explicit methods such as `telemetry.screenViewed({ screen })` or `telemetry.runRequested({ operationId, entrypoint })`, typed against the registry. It does not expose `capture`, `track`, `identify`, a property dictionary, or a transport. The method validates again in main because the renderer is untrusted.

Router instrumentation emits screen enums rather than paths or page titles. Component instrumentation represents product semantics rather than clicks. Error boundaries send a normalized error candidate; main applies message/stack scrubbing and policy before spooling it.

### Local spool

The normal spool is an append-only or transactional queue under Rally's application-data directory. Requirements:

- validated serialized envelope only;
- no provider payload and no raw pre-redaction input;
- delivery eligibility ends 14 days after creation, with independent row-count and byte-size ceilings; the running process purges expired rows on schedule and startup purges them before any delivery attempt, so a dormant device cannot make an expired row eligible again;
- priority-aware eviction: product events before essential reliability;
- per-event attempt count and next-attempt time;
- single-writer main ownership and crash-safe commit;
- batch deletion only after regional acknowledgement;
- deletion only after the identity or regional API acknowledges durable receipt;
- logout purge for queued authenticated product events and rotation of the anonymous epoch before another account can authenticate;
- policy-change purge for product events and detailed diagnostics that become prohibited;
- corruption recovery that never uploads quarantined material; each independently replaceable spool generation has a main-owned creation time and absolute deletion deadline stored outside its payload, quarantine inherits that deadline and a separate byte ceiling, startup/maintenance purges it, and a missing or invalid deadline causes immediate deletion rather than inferred retention;
- safe file permissions and no secret material.

Encryption at rest can be added if the selected local database technology and OS key store provide a meaningful boundary. It is not used to justify storing sensitive payloads; data minimization remains primary.

### Desktop sessions

A `launch_id` begins when the process starts. A `session_id` begins when the application becomes interactive and renews after the approved background interval. The same definition supplies both total-usage denominators and crash-free session health. Each launch and session records whether detailed crash reporting was continuously eligible from its start. A preference change in either direction makes the current launch/session ineligible; only the next launch/session may establish the new state. Crash-free calculations use eligible denominators, while essential launch/session events measure total use and expose eligibility coverage. Launch and session events have high delivery priority because missing denominators bias stability scores.

An unclean-exit marker is fsynced before the app becomes ready and cleared only during graceful shutdown. The next launch emits the prior release/build, last known phase, and whether it was in the launch window. It does not claim “native crash” without a dump or OS signal.

## Identity onboarding ingest

Before Google authentication, main creates a random anonymous epoch and requests a short-lived bootstrap capability from the Global edge. The edge binds the capability to that epoch, the registered logged-out onboarding schema subset, the coarse provisional route, expiry, and abuse limits. It is not an account credential and cannot call normal product, identity, or workspace APIs; only the bounded anonymous telemetry routes can consume it, including Global crash ingest after a second route/journey check. Main owns it; the renderer receives only typed semantic methods.

The bootstrap session carries the canonical Product analytics boolean and preference version plus a server-created `onboarding_journey_id`. The journey ID is opaque, non-authorizing, and bound to that bootstrap session. An existing opt-out is effective before identity-scoped product events are accepted. A new account uses the approved default-on policy; the settings control is not shown during onboarding.

Each event uses this routing precedence:

1. an existing explicit platform workspace binding;
2. an explicit region selection already made during the journey;

The service persists only the coarse provisional route and `routing_basis`, never the source IP, country, city, continent, coordinates, postal code, timezone, ASN, or raw Cloudflare request metadata. Fixing the provisional route prevents a VPN or network change from splitting the pre-selection portion of one onboarding funnel. A later explicit choice applies prospectively; accepted history is not migrated, linked across regions, or duplicated.

The Global ingest has two disjoint modes. Logged-out mode accepts only registered anonymous-epoch schemas under the route-bound capability. Identity mode accepts only registered platform-user onboarding schemas while the authenticated session has no workspace; it resolves the platform subject from the session, validates the journey binding, and applies the canonical account preference. Both modes validate each event before routing:

- **Global route:** commit immediately to the Global accepted-event outbox and use the anonymous epoch or resolve the stored Global platform-user analytics ID there.

The renderer reports only presentation and intent: fixed screen enums, selected-region intent after the user acts, and requests to create, activate, accept, or decline. The coordinator and regional services report authoritative state and outcomes. A safe operation identifier correlates each intent with its result; it remains distinct from authentication credentials and from any domain idempotency key.

## Normal regional ingest

The normal endpoint accepts compressed batches with strict limits on compressed bytes, expanded bytes, item count, nesting, string length, and total properties. Authentication is the existing regional desktop session. The handler:

1. authenticates and binds the request to one region;
2. resolves the persisted regional projection of the canonical account preference;
3. parses with resource limits;
4. validates schema, source, category, timestamps, and properties;
5. rejects prohibited keys and values;
6. resolves or allocates scoped analytics identities;
7. adds trusted context;
8. stores accepted rows and deduplication state transactionally;
9. creates regional outbox work;
10. returns per-event accepted, duplicate, or rejected status.

At regional acceptance, every accepted row and its validated, sanitized replay projection receive an immutable deletion deadline 90 days later. Success, retry, terminal failure, and operator replay do not restart or extend that clock. The replay store never contains the raw client candidate, rejected payload fragments, raw minidumps, or private symbolication artifacts. A deletion request suppresses replay and removes an attributable row before the 90-day ceiling.

A terminal delivery failure enters a regional dead-letter state under the original acceptance deadline. Retry stops and the row is deleted when that deadline arrives, even if no attempt ever reached a terminal response. Operator replay preserves `event_id`, rechecks the current preference, and cannot resurrect an event suppressed by opt-out, deletion, or expiry.

The server rechecks the current preference version before destination delivery. A change to disabled suppresses already queued product events and detailed diagnostics for that person. API-native and asynchronous emitters perform the same check before creating an event. If the projection is unavailable or its version cannot be established, those emitters and the destination worker allow only the essential content-free schema set.

Rejection handling never persists or logs an unvalidated client string. It records a fixed violation code, a registered event/schema/source/field identifier or a fixed `unknown` sentinel, server-derived release identity, and an aggregate count. Unknown event names, schema strings, client release values, property keys, and path segments are neither echoed nor hashed for inspection because even a key can carry a secret. Development validation can point to a registered field identifier, but it also replaces unknown values with the sentinel. This content-free rejection metadata is stored as time-bucketed contributions. Each observation contribution expires 90 days after it was recorded, and aggregate counts are recomputed from surviving buckets, so a later rejection cannot renew earlier observations. It cannot be used to retain or reconstruct a rejected value.

For an API action already in progress, server telemetry is inserted through a best-effort service that cannot change the product transaction outcome. Where atomicity with a product state transition is required for an authoritative analytic, an outbox row may be committed in the same D1 transaction. Otherwise `waitUntil` can defer only the attempt to create the durable row; it cannot be treated as durable destination delivery.

## Identity design

Signals use five non-overlapping identity scopes:

| Scope | Server knowledge | Destination identity |
| --- | --- | --- |
| `installation` | Device-level reliability without an authenticated person | Random installation identifier; never linked to a person |
| `anonymous-epoch` | One bounded logged-out product journey | Random epoch identifier; automatically linked after authentication when its fixed route and account preference permit |
| `workspace-user` | Authenticated regional user and workspace | Immutable random regional person ID and workspace group ID |
| `workspace` | Unattended regional workspace execution with no responsible person | Immutable random workspace analytics ID as a personless distinct ID and workspace group ID |

## Client/server correlation pattern

For a state-changing workflow:

1. Renderer creates an `operation_id` and emits a client-intent event.
2. Main sends the operation ID in the product API request through the existing typed transport.
3. API validates the ID format and attaches it to operational trace context and semantic server events.
4. The state-changing service emits an authoritative completion or failure event after the outcome is known.

The server event never copies arbitrary client properties. It reconstructs its properties from trusted state. If retries repeat the product request, the domain's idempotency key and telemetry event IDs remain distinct: the first controls the product effect; the second controls analytics delivery.

### Crash classes

| Class | Detection | Payload | Delivery path |
| --- | --- | --- | --- |
| Handled JS error | Explicit catch/report | Sanitized exception + typed breadcrumbs | Normal spool |
| Unhandled JS error/rejection | Process/global handlers | Sanitized exception + typed breadcrumbs | Normal spool, urgent flush |
| Renderer gone | Electron main listener | Reason/exit class/process/release | Normal spool |
| Unresponsive renderer | Electron main listener/watchdog | Transition/duration/recovery | Normal spool |
| Unclean exit | Next-launch marker | Prior phase/release | Normal spool next launch |
| Native crash | Crashpad out-of-process handler | Local minidump + sparse static metadata + optional sanitized sidecar | Next-launch database rotation, then main uploader |

### Crashpad authentication and abuse control

Electron Crashpad's supported start surface does not provide Rally's required authenticated-header boundary. Rally therefore does not configure native network submission and never embeds a token or capability in `submitURL`, query parameters, form metadata, or another URL-bearing field. Crashpad writes completed reports to a route-final database generation created for that launch. A packaged prototype must verify database location, completion semantics, process coverage, generation rotation, and pre-start purge behavior on every supported Electron version.

Rally never opens or mutates the database while its Crashpad handler is active. At the next launch, before starting a new handler, main atomically rotates the entire inactive prior database plus its launch manifest and crash sidecar into Rally's route-final upload spool. It validates the capture route, generation eligibility, age, completion state, and integrity, deletes ineligible/incomplete material, and starts a fresh Crashpad database before rendering. Upload proceeds asynchronously from the separate spool and therefore never races Crashpad. Multipart requests use the normal regional session or a short-lived, route-bound, main-only bootstrap capability in an authorization header. The capability authorizes only one regional crash-ingest shape, is refreshed rather than persisted in a URL, and cannot call product APIs. A capture route can never be changed by a later network or workspace selection.

Local reports and sidecars become permanently ineligible for upload 14 days after creation. While Rally is running, the separate rotated upload spool is actively deleted at that deadline, and independent byte/count ceilings may evict it sooner with only a content-free aggregate loss counter. No process can delete either a rotated spool or an unrotated report while the device is dormant, and Rally cannot safely delete an active Crashpad database. At the next launch, before any upload attempt or Crashpad restart, main checks original creation time and deletes every expired rotated or unrotated report, manifest, invalidation record, and sidecar. A later launch, authentication, route change, or retry cannot restore eligibility. User-facing privacy material describes this next-launch physical-deletion limit rather than promising background deletion while Rally is not running.

Regardless of mechanism, the endpoint enforces:

- region encoded by the hostname/configuration, never a trusted form field;
- allowed release/build/channel/platform combinations;
- authenticated regional session or short capability lifetime and server-side revocation;
- per-capability, IP-edge, release, and global rate limits without persisting raw IP in product analytics;
- strict multipart parts, minidump magic/type, and byte limits;
- decompression and parser resource limits;
- malware-safe storage disposition and no executable handling;
- one opaque crash ID returned or recorded;
- no synchronous symbolication on the upload request.

At the next successful launch, prior-generation rotation and eligibility validation finish before the first renderer is created. The uploader schedules every eligible prior-generation native report ahead of normal telemetry and begins its first attempt as soon as route-appropriate authentication and network are available. Rally makes no wall-clock delivery promise while the app is closed or offline. If the new launch crashes before the prior report uploads, the independent rotated spool preserves that prior report for a later attempt and the new crash remains in the fresh active generation for the following launch; neither event can renew the other's absolute deadline.

Disabling Product analytics stops Rally's upload-spool worker immediately, marks any bootstrap capability for revocation, and fsyncs an invalidation record for the active Crashpad generation before acknowledging the local change. A telemetry-region change performs the same generation invalidation before changing product state. Rally does not open, mutate, or delete the active Crashpad database. On the next launch, the rotation step recognizes the invalidation and purges the entire generation and sidecars rather than uploading any report from it; Crashpad then remains stopped for opt-out or starts a fresh generation under the new effective route/policy. This deliberately discards even an earlier dump from an invalidated launch to avoid relying on racy per-report timing. Packaged tests cover database locks, crashes before and after invalidation, region changes, an upload already in flight from an older rotated generation, and a failed purge. An upload accepted before the server acknowledges the opt-out cannot be recalled synchronously and follows its normal regional retention or a separate account-deletion workflow; the UI does not claim otherwise.

### Crash-surviving breadcrumbs

The typed breadcrumb ring is bounded, already sanitized, and mirrored by main to an atomic per-launch sidecar with restrictive permissions. Each checkpoint records launch/process identity, sequence, and freshness time; it contains no arbitrary strings. The uploader attaches the matching sidecar to the multipart request and deletes it with the local dump. A renderer crash may use the latest main-owned checkpoint. A fatal main crash can lose recent in-memory transitions, so the structured report includes `breadcrumb_status: "available" | "stale" | "unavailable"` and never treats breadcrumbs as mandatory. Sidecars obey the dump's opt-out, route, local age, and deletion rules and are never uploaded independently.

### Artifact and symbol lifecycle

The release pipeline generates an immutable telemetry release manifest containing application version, build ID, Electron/Chromium version, process bundle IDs, platform, architecture, JavaScript debug IDs, native module debug identifiers, commit, channel, and artifact checksums.

Before a release is published, CI uploads:

- main/preload/renderer source maps and matching bundles needed for mapping;
- macOS dSYM, Windows PDB, Linux breakpad/debug symbols as applicable;
- native-module symbols;
- the signed release manifest.

JavaScript and native symbolication are separate regional processors:

Neither processor places source excerpts, absolute paths, dumps, maps, bundles, or unsanitized stack text into destination payloads. Forced-error release tests prove artifact matching for all JavaScript bundles and native targets before publication.

Each raw minidump has a server-derived deletion deadline 90 days after receipt. configured deployments object stores enforce the same lifecycle independently, while an audited reconciliation job proves that expired objects and their raw-artifact indexes are gone. Extending the deadline is a product/privacy decision rather than an operator override.

### Fingerprinting and issue state

Default fingerprints include exception/crash type, process, owned top frames, and stable normalized frame tokens. Dynamic messages, addresses, offsets, local paths, line numbers in generated bundles, and user content are excluded. The schema permits a reviewed explicit fingerprint for known wrapper errors.

### Source and stack privacy

JavaScript stacks are parsed before destination delivery. Paths are reduced to application-relative module identifiers, user home directories are tokenized, query strings/fragments are removed, messages are mapped to a stable safe code where possible, and source context lines are not sent to either product analytics destination. Native frames expose module and symbol names only after a denylist/allowlist pass. Raw dumps and full internal frames retain the stricter diagnostic policy.

### Global PostHog adapter

The PostHog adapter is deployed and configured only in Global. It has no access to the inbound HTTP request and therefore cannot forward IP accidentally. It receives an accepted internal event plus destination policy. It:

- maps names and properties from a compile-time table;
- uses the US PostHog base URL from Global-only server configuration;
- sets normalized timestamp and stable event UUID;
- sets `distinct_id` and `workspace` group only from immutable regional analytics identities;
- disables GeoIP on every capture, permits normal person processing for authenticated Global events, and sets `$process_person_profile: false` only for scopes that must remain anonymous or device-only;
- sends anonymous-epoch and installation-only events with `$process_person_profile: false`;
- performs an epoch claim through an ordered `$identify` transition with `distinct_id` equal to the stable person ID, `$anon_distinct_id` equal to the existing anonymous epoch, and `$set` containing exactly verified primary `email` and current display `name` for an eligible Global route;
- processes later identify jobs for an eligible authenticated Global subject through the same exact property allowlist;
- processes a group-profile job only for an eligible explicit Global workspace, setting exactly current `name` on the stable `workspace` group;
- rechecks fixed route, account preference, subject existence, job version, and immutable deadline and deletes or suppresses an ineligible or stale job;
- adds `$lib: "avalon-regional-telemetry"`, adapter version, release, and environment;
- emits external-flag experiment properties only on planned events;
- maps already-symbolicated, sanitized JavaScript exceptions via the verified SDK/API path;
- maps the complete allowlisted native crash report, including sanitized symbolicated frames, typed breadcrumbs when recovered, breadcrumb availability/freshness status, issue fingerprint, release/build/process context, parser state, and affected launch/session correlation;
- records provider response class, latency, retryability, and request ID without logging payloads;
- never copies profile values into semantic event, exception, or crash fields and never includes a PostHog person or group property that is not explicitly declared.

“Complete” means every approved structured field needed to investigate the issue, not every byte collected by Crashpad. The adapter cannot access or emit minidumps, memory fragments, private source maps or symbols, source excerpts, absolute paths, unsanitized messages or frames, authentication material, or arbitrary metadata. Golden fixtures define both the required full-report fields and prohibited negative space.

Batching respects PostHog's documented payload limit with a substantially lower Rally cap. 4xx schema/config failures become terminal and alert; 408/429/5xx/network failures retry with exponential backoff and `Retry-After`. A circuit breaker protects the regional consumer during a provider incident.

PostHog project retention, deletion, access, profile, and issue-workflow configuration are owned through a separate provider-administration process. This adapter design ends at privacy-transform validation, successful destination acknowledgement, and internal delivery-receipt handling; it does not mirror PostHog lifecycle state back into Rally's retention engine.

3. record the locality limitation in regional and customer-facing documentation rather than claiming a stronger guarantee.

## Public website

V1 leaves the public website unchanged and adds no behavioral analytics source, identifier, endpoint, SDK, or destination configuration. Any future site measurement requires a separate PRD that re-evaluates notice, consent, regional routing, identity, events, and destinations at that time.

## Consent and policy resolution

The effective setting for a category is the intersection of:

```text
compiled product ceiling
AND local user preference
AND regional/legal policy
AND event-specific rollout
```

No feature flag can widen the compiled ceiling. A remote response is signed/authenticated through the normal API session and cached with version and expiry. The compiled and local default enables product analytics and crash reporting. The account-scoped user setting is the only V1 nonessential telemetry control. Essential reliability continues within the compiled content-free allowlist.

During an identity-only bootstrap session, the effective policy is the compiled ceiling, canonical account preference, identity-onboarding legal policy for the provisional route, and event rollout. The same account preference continues after workspace activation.

Logged-out mode uses the compiled ceiling, durable local Product analytics choice, provisional-route legal policy, and event rollout. Logout does not reset a known local opt-out. A fresh installation uses the approved default-on value because no account is known. When authentication resolves an existing canonical opt-out, main closes the epoch, deletes unsent local nonessential rows for it, emits no identity/profile job, and keeps further nonessential collection off. Already accepted records remain unlinked and anonymous in their original route until their immutable retention deadline; V1 does not build a cross-store retrospective purge for data collected before the account was knowable. An explicit account-deletion request remains a separate deletion workflow for attributable internal records.

The per-user `productAnalyticsEnabled` setting defaults to `true` and has a monotonic `preferenceVersion`. The Global identity control plane is canonical because the choice is account-scoped and a person signs in once there. This is minimal identity/account metadata, not product telemetry. During regional activation, Global creates or resolves a random, region-bound `preference_subject_handle` and the regional service maps it to that regional user. Preference read/write RPCs carry only this handle, the boolean, expected/current version, and authenticated operation metadata. The handle has no meaning to analytics adapters, never appears in an event, and cannot authorize another account operation. Workspace activation includes the current canonical version so a move or future activation cannot silently reset the choice.

Preference writes use privacy-safe ordering and optimistic concurrency:

1. Main persists a local opt-out and applies it before making a request. It sends preference mutations through a control queue that is independent of and higher priority than telemetry delivery.
2. For disable, the regional API first writes a disabled local projection selected by its mapped preference handle, then compares-and-sets the canonical control-plane value through the same handle, and finally records the acknowledged version. For enable, collection remains disabled until both canonical and regional state contain the new enabled version. Any missing handle, mapping failure, partial write, or conflicting state resolves to disabled.
3. The API returns the acknowledged version. Main cannot resume nonessential collection without it. A stale write refetches instead of overwriting a newer version.
4. Other installations receive the current version at session bootstrap and refresh when the API reports a newer version. API-native and asynchronous emitters read the regional projection at creation; the destination worker rechecks it before delivery. Queued product, diagnostic, identify, and group-identify rows for a disabled person are suppressed and deleted according to policy.

An offline opt-out immediately stops semantic events and every detailed diagnostic payload locally. It stops the main-process crash uploader and queues the preference change ahead of telemetry for reconnect. Opt-in while offline remains pending and does not start collection. If the regional projection is unavailable, expired, or inconsistent with a known higher canonical version, only essential reliability is permitted.

When enabled changes to disabled, main purges queued product events, JavaScript exception stacks, breadcrumbs, and any separate route-final crash-upload spool; it also fsyncs invalidation of the active Crashpad generation. It follows the restart-safe Crashpad procedure above rather than modifying the live database. The API rejects stale client product/diagnostic events, suppresses and deletes attributable undelivered product, diagnostic, identify, and group-identify rows, and revokes any bootstrap crash-upload capability once it acknowledges the change. Already delivered records and accepted unlinked anonymous records are not synchronously recalled by this preference change; they follow normal internal retention or, where attributable, a separate account-deletion workflow. The UI distinguishes “stopped future collection” from “requested deletion.”

V1 has no workspace-admin telemetry setting and no independent crash-reporting toggle. Product analytics remains the only user-facing nonessential telemetry control.

## Security threats and controls

| Threat | Control |
| --- | --- |
| Compromised renderer sends secrets | Narrow typed IPC; main runtime schema; server schema and prohibited-key scan |
| Outdated client ignores policy | Canonical account preference, durable regional projection, checks at creation and delivery, and schema versions |
| Telemetry endpoint or rejection log becomes a data exfiltration path | Allowlisted enums/bounds, no arbitrary strings, fixed rejection sentinels/codes, strict sizes, authenticated normal ingest |
| Crash endpoint is abused for storage or parser attacks | Region-bound capability, rate limits, type/size validation, asynchronous sandboxed parsing |
| Cross-region routing | Separate hostnames, bindings, queues, stores, secrets, tests, and support roles |
| Duplicate/replayed events bias analysis | Unique event ID, payload-hash conflict detection, bounded replay, stable destination UUID |
| Stack/dump/source map leaks content | Regional symbolication, pre-forward stack scrub, user analytics control, separate artifact stores/access/retention, and no raw diagnostic artifact in PostHog |
| Schema drift expands collection | Tracking plan in CI; destination golden fixtures; unknown fields reject |
| Account deletion misses analytics identities | Immutable regional analytics IDs stored on the authoritative subject and included in internal deletion indexes |
| Telemetry failure harms product | Non-blocking reporter and server service; bounded resources; isolation/circuit breakers |

## Operational surfaces

At minimum operators need:

- accepted, duplicate, rejected, sampled, evicted, and delivered event counts by region/source/schema/release;
- oldest outbox age, retry counts, dead-letter rows, destination latency/error class;
- local spool drop reports by reason and release;
- crash upload accepted/rejected, dump age, symbolication backlog/failure class, missing artifacts;
- crash-free launches/sessions with eligible, ineligible, delivered, and lost denominators;
- internal retention reconciliation and deletion-job completion percentage, expected-versus-processed rows, and oldest surviving age by region and retention class;
- strict alerts without event property or crash content in log messages.

Runbooks cover provider outage, outbox backlog, schema rejection spike, crash-upload abuse, missing symbols, accidental prohibited-data detection, cross-region test failure, consent-policy incident, and deletion failure.

### Direct PostHog SDK in renderer

Rejected for the core product because it makes region, consent, schemas, identity, offline retry, and provider-specific features client concerns. The Electron-compatible build solves bundling, not Rally's trust boundary.

### Direct desktop-to-PostHog proxy

Rejected because a thin reverse proxy does not validate semantics, resolve identity, persist durably, join server outcomes, support multiple destinations, or own deletion. The regional API must be a collector, not only a URL mask.

### Segment or RudderStack as the collector

Deferred. They solve routing and governance well, but add another data processor and regional contract for a system with one initial destination. The adapter boundary keeps this option open if destination count grows.

### PostHog-only error tracking

Rejected as complete crash coverage. It covers JavaScript exceptions but is not the raw Crashpad dump, symbol, access, and native support system required here.

### Automatic DOM and network capture

Rejected. Rally displays customer work content, and generic UI/network mechanisms cannot reliably distinguish semantics from secrets. Explicit events are more private and more analytically stable.
