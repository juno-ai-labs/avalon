# Regional telemetry

Avalon's telemetry subsystem accepts a closed set of semantic product signals,
content-free reliability signals, sanitized JavaScript diagnostics, and native
Electron crash reports. Avalon owns collection, policy, routing, identity,
durability, and internal retention; PostHog is the Global destination, not an SDK
embedded in the renderer or a source of product truth.

The single account-scoped **Product analytics** setting defaults on. Turning it
off stops product events, detailed JavaScript diagnostics, identity/profile jobs,
and native crash upload; essential bounded reliability signals continue. Global
may send approved data to the US PostHog project. EU product and crash telemetry
terminates in Avalon's EU-isolated Cloudflare resources.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/telemetry.ts` | Closed event registry, envelope/batch schemas, breadcrumb and bootstrap contracts, size limits, and prohibited-field rules. |
| `apps/desktop/src/main/telemetry-*.ts` | Route, random identity epochs, local event spool, typed reporter, breadcrumbs, launch markers, and preference-independent reliability collection. |
| `apps/desktop/src/main/native-crash-*.ts` | Route-final Crashpad generations and the bounded, authenticated next-launch uploader. |
| `apps/desktop/src/main/product-analytics-settings.ts` | Local-first disable, fail-closed enable/refresh, preference synchronization, crash invalidation, and spool purge. |
| `apps/desktop/src/main/index.ts` | Startup ordering, Crashpad start, process observers, IPC sender validation, upload scheduling, and product integration points. |
| `apps/desktop/src/renderer/lib/telemetry.ts` | Narrow renderer facade for registered screen, product-intent, and error-candidate calls. |
| `apps/api/src/routes/telemetry.ts` | Bounded bootstrap, anonymous/authenticated event, identity-link, preference, and crash-ingest routes. |
| `apps/api/src/routes/telemetry-operations.ts`, `apps/api/src/telemetry/operator-auth.ts` | Bearer-authenticated, role-restricted regional status, replay, raw-crash access, and EU analysis HTTP surface. |
| `apps/api/src/telemetry/` | Regional collector, identity/preference logic, PostHog adapter, EU sink, replay, crash processing, operations, and lifecycle jobs. |
| `apps/api/src/middleware/api-operation-telemetry.ts` | Content-free timing/outcome signals for an explicit API operation allowlist. |
| `apps/api/src/crash-symbolicator*.ts`, `apps/api/crash-symbolicator/` | Private Cloudflare Container boundary and pinned native stack-walking image. |
| `packages/db/migrations/0074_regional_telemetry.sql` | Telemetry identities, preferences, outboxes, internal EU projections, crash indexes, deadlines, rate buckets, circuits, and analysis dimensions. |
| `apps/desktop/scripts/publish-telemetry-artifacts.mjs` | Private source-map and native-symbol publication to both isolated telemetry buckets. |
| `apps/desktop/scripts/telemetry-crashpad-fixture.mjs` | Real packaged Electron/Crashpad two-launch release gate. |

The approved product contract and rationale are frozen in the [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md); this document describes
the implementation that future changes must preserve.

## How it works

### Contract and producers

`TELEMETRY_EVENTS` is the only event registry. Each entry fixes its sources,
authoritative producer, identity scopes, category, exact property schema,
classification, priority, sample rate, retention, and destination. Incompatible
changes require a new schema version. There is no generic `capture(name,
properties)` API outside the reporter internals.

Automatic collection is limited to bounded application/session/process/update,
spool, API-operation, and crash-upload states. Router calls emit registered screen
enums. Product integrations emit semantic intent before a state-changing request;
the authoritative API emits the outcome with the same `operation_id`. Avalon does
not capture DOM interactions, console output, arbitrary network traffic, URLs,
request bodies, prompts, messages, documents, or session replay.

### Route and identity

Before the first renderer exists, main resolves telemetry routing. An existing
workspace binding is authoritative. Otherwise the Global bootstrap endpoint
reduces Cloudflare's country signal to `eu` or `global`, stores only the route and
basis, and returns a short-lived capability bound to the current anonymous login
epoch. An affirmative EU result prevents pre-region Crashpad startup. Non-EU,
unknown, malformed, failed, or two-second timed-out bootstrap uses Global. No
region-pending payload store exists.

Every event receives one immutable route. A later workspace choice changes future
events only. Global can hand an already validated EU onboarding projection to the
named EU telemetry RPC; no EU event, identity, crash, or replay moves to Global.
If login succeeds before a workspace exists and the Global login session does
not match the coarse EU route, registered pre-workspace intents continue under
the route-fixed anonymous epoch and its capability. They are accepted
immediately rather than becoming authenticated rows that wait for region
selection. A later workspace selection is prospective and does not migrate them.

The desktop persists one random installation ID and one rotating anonymous login
epoch. Only the epoch may link to a random, server-owned regional person ID after
authentication; the installation ID never links. Logout, account switch, or
abandoned authentication rotates the epoch. In Global, the ordered transition is
PostHog `$identify` with the stable person as `distinct_id`, the epoch as
`$anon_distinct_id`, and the verified email/name profile. A later profile job
cannot supersede an unresolved transition. Eligible Global workspaces use a
stable random `workspace` group ID and only the current workspace name.

### Preference and local delivery

Authenticated startup treats nonessential telemetry as off until the regional API
confirms the canonical account preference. A disable is fsynced locally before
the network mutation, invalidates the live Crashpad generation without opening its
database, stops upload immediately, and purges queued nonessential rows. Enable
does not become effective until the compare-and-set regional/canonical update is
acknowledged. Session changes force a fresh fail-closed read.

Main validates and writes complete envelopes to an owner-only file spool. Each row
has a separate deadline file, so corrupt JSON still has an enforceable ceiling.
Rows are serialized, atomically replaced, retried with bounded backoff, and removed
only after regional acknowledgement. Product/diagnostic rows are evicted before
essential rows. `originalTimestamp` remains the capture time; immediately before
the first transmission, main atomically fixes `sentAt`, and every retry preserves
that value so server clock-skew normalization cannot turn offline delay into a
later occurrence. An anonymous epoch is linked only after its local rows have all
been acknowledged, and the periodic flush retries the link after transient
delivery failures. The renderer sees only named IPC methods; main validates the
sender against a live Avalon window and the pinned application origin.

### Regional acceptance and destinations

The API validates the batch again, resolves or allocates immutable random
analytics identities, derives trusted route/release context, normalizes excessive
clock skew, and commits the accepted row plus receipt before returning `202`.
Identical event-ID retries acknowledge as duplicates; a different payload under
the same ID conflicts. EU acceptance also writes the independently expiring
internal semantic projection. Global acceptance leaves a destination row for the
five-minute scheduled processor.

Global delivery uses stable `$insert_id`, `$session_id`, `distinct_id`, PostHog
workspace groups, `$process_person_profile`, `$geoip_disable`, normalized
timestamps, and the official exception capture path. JavaScript source maps are
loaded privately and only mapped application frames leave Avalon. Malformed
profile jobs are terminalized individually so one corrupt row cannot block later
profiles, event delivery, or operational snapshots. PostHog 408,
429, 5xx, and network failures on ordinary event/profile batches retry with
`Retry-After` or exponential backoff; other 4xx responses become terminal. The
PostHog exception SDK exposes only flush success/failure for JavaScript/native
exceptions, so a failed flush retries without status-specific classification.
Five consecutive transient failures open a per-stream five-minute circuit. EU
has no PostHog token, host, adapter call, or telemetry Analytics Engine dataset.

### Native crashes

Crashpad writes only to `active/<generation>/crashpad`, without a submit URL. The
sibling manifest fixes the route, creation time, absolute 14-day local deadline,
and invalidation state. Main never opens or mutates a live Crashpad database. At
the next launch, before starting a fresh handler, it atomically rotates eligible
inactive generations to `upload/<route>/<generation>` and deletes expired,
invalidated, or corrupt generations.

The uploader accepts at most 20 reports and 100 MiB locally, schedules up to five
reports per pass, and sends at most 20 MiB per report using a normal regional
session or route-bound Global bootstrap capability in headers. Launch ID and
release channel travel independently of breadcrumbs so fatal-context loss cannot
inflate crash-free results. The regional API deduplicates before applying the
limit of ten new crash uploads per opaque subject per hour, writes the raw dump to
`TELEMETRY_PAYLOADS`, and commits its D1 index before acknowledging.
Each raw object carries its immutable deletion deadline as R2 metadata. The
scheduled prefix sweep removes expired objects even if the R2 write succeeded
but the D1 index transaction never did; missing or malformed deadlines fail
closed.

The five-minute processor claims stale/retryable work, loads the matching private
symbol archive, invokes the region's no-egress Cloudflare Container, sanitizes and
fingerprints the result, and retries transient processing failures without
renewing the deadline. Missing symbols produce `unsymbolicated`; invalid output is
`malformed`. Global sends the complete approved structured report through
PostHog's exception path. Raw dumps, symbols, memory fragments, source excerpts,
absolute paths, and unsanitized values remain in Avalon. EU keeps the full
occurrence for 90 days and a flat fingerprint/release contribution for 13 months;
issue and crash-free views are computed from surviving rows at query time.
The exec-only processor image exposes an unused local-supervisor port because
Wrangler requires one during development; production has no listener and all
work still crosses the authenticated Durable Object RPC/exec boundary.

## Invariants

- **Route, event ID, payload hash, and deletion deadline are immutable.** A retry,
  replay, recurrence, login, or destination acknowledgement cannot move or renew
  data; doing so would merge residency histories or defeat the published ceiling.
- **The renderer has no provider or identity authority.** It cannot name an event,
  send an arbitrary property dictionary, read a telemetry credential, or call
  PostHog; otherwise an XSS becomes a data-exfiltration and schema-expansion path.
- **Only the per-login epoch links.** Linking installation identity would join
  different people who share a machine and corrupt both funnels and profiles.
- **An anonymous-to-person transition is ordered and never superseded.** Losing
  `$anon_distinct_id` during an outage permanently splits the onboarding funnel.
- **Opt-out is enforced at creation, regional acceptance, and delivery.** Any one
  check alone leaves an offline device or queued row able to cross the choice.
- **Crashpad owns its live database.** Main may invalidate the sibling manifest,
  but opening, rewriting, or deleting the live database races Electron's handler.
- **Global and EU use separate D1, telemetry R2 buckets, processors, artifacts,
  credentials, and queries.** The named EU projection and Global control RPCs
  are narrow exceptions, not a general telemetry bridge.
- **Rejected values never enter storage or logs.** Rejections retain only fixed
  violation codes, registered names or the `unregistered` sentinel, and counts.
- **Telemetry failure never changes product behavior.** Reporters, middleware,
  processors, and operational callbacks fail independently of the action observed.

## Boundary

The subsystem owns telemetry contracts, collection, random analytics identities,
preference enforcement, regional routing, internal durability/lifecycle,
destination formatting, crash artifact processing, and content-free operations.
It exposes typed desktop calls, HTTP/RPC acceptance results, a bearer-authenticated
regional `/internal/telemetry` operator surface, and aggregate operations
snapshots.

It does not own product state, authorization for the product action being
observed, provider content, PostHog-side retention/access/configuration, legal
approval, or public-site analytics. The public site remains unchanged. Product
analytics are advisory and may be incomplete; D1 product records remain canonical.

## Failure modes and limits

- The pre-renderer route request times out after two seconds and falls back to
  Global; an affirmative EU result creates no pre-region dump.
- Local event rows expire after 14 days, with a 2,000-row/8 MiB spool. Corrupt
  rows are quarantined only when their independent deadline is valid; otherwise
  they are deleted immediately.
- Native local material expires after 14 days and is bounded to 20 reports/100
  MiB. A dormant device physically purges it on its next launch before delivery
  or Crashpad restart.
- Normal event batches are at most 256 KiB and 50 events. Native dumps are at
  most 20 MiB; breadcrumb sidecars are at most 32 KiB; structured reports are at
  most 4 MiB; source maps are at most 16 MiB.
- Regional accepted/outbox/receipt/profile/replay/rejection and full crash rows
  expire no later than 90 days. EU product contributions and minimized crash
  contributions expire independently after 13 months.
- A destination outage backs off to the immutable deadline and opens a five-minute
  circuit after five consecutive transient failures. The product action is not
  retried or failed because telemetry is unavailable.
- Opt-out cannot synchronously stop Electron's already-running Crashpad handler.
  It stops upload and invalidates the generation immediately; restart purges that
  generation before a new handler can start.
- Raw crash access is by opaque crash ID, region-restricted, reason-coded, and
  audited. A missing raw object returns a fixed result and never exposes its key.

## Testing

Run focused suites from their package directories:

```bash
pnpm --filter @avalon/contracts test
pnpm --filter @avalon/db test
pnpm --filter @avalon/api exec vitest run test/telemetry-collector.test.ts test/telemetry-delivery.test.ts test/posthog-adapter.test.ts test/crash-processing.test.ts test/crash-operations.test.ts
pnpm --filter @avalon/api test:crash-symbolicator-container
pnpm --filter @avalon/desktop exec vitest run src/main/telemetry-reporter.test.ts src/main/product-analytics-settings.test.ts src/main/native-crash-generation.test.ts src/main/native-crash-uploader.test.ts
pnpm --filter @avalon/desktop test:release
pnpm --filter @avalon/desktop test:crashpad
```

Contract tests enforce registry exhaustiveness and prohibited negative space.
SQLite fixtures apply every migration and advance fake clocks across absolute
deadlines. API tests use fake PostHog and R2 bindings and inspect exact destination
payloads. Desktop storage tests use real temporary directories. The Crashpad
fixture packages the pinned Electron version and creates two real renderer dumps;
it is macOS-arm64-only because that is the only released target. Both Wrangler
dry-run builds are required to validate regional bindings and the Container image.
The Docker integration gate downloads checksum-pinned upstream minidump and
symbol fixtures, then exercises the built image as its non-root user with no
network, a read-only root, matching symbols, malformed input, and disclosure
checks.

## Data model

`users` and `workspaces` hold immutable random regional analytics IDs; `users`
also owns the canonical preference/version and opaque projection handle.
`telemetry_onboarding_journeys` fixes provisional routes. Accepted envelopes,
receipts, profile jobs, identity links, replay audits, rejection/rate buckets, and
destination circuit state live in regional D1. `telemetry_eu_events` is the EU
query projection with release/platform/channel/correlation dimensions.

`telemetry_crash_reports` is the content-free raw-object index plus the sanitized
full occurrence, processing lease/retry state, and destination state.
`telemetry_eu_crash_contributions` is one independently expiring flat row per
occurrence; no issue aggregate or regression workflow is persisted. Raw dumps,
source maps, and native symbols live only in the region's dedicated
`TELEMETRY_PAYLOADS` bucket.

## Regional impact

Global owns identity sign-in, coarse onboarding routing, canonical preference,
and the US PostHog adapter. It can send a validated EU onboarding projection over
`EU_TELEMETRY_BRIDGE`. EU can send only opaque preference commands and
route-bound capability verification/closure commands over
`GLOBAL_TELEMETRY_CONTROL`; Global returns no destination identity, key, or event
payload. EU owns its D1 rows, `avalon-eu-telemetry` R2 bucket with EU
jurisdiction, EU-constrained no-egress symbolicator, support audit, and internal
queries. EU configuration contains no PostHog secret or telemetry Analytics
Engine destination.

The route signal stores neither IP nor country. A future EU PostHog project or
movement of historical EU data requires a new recorded decision; it is not a
configuration flip in this adapter.

## Security and trust model

Desktop envelopes, IPC arguments, capabilities, multipart fields, dumps,
breadcrumbs, processor output, and destination responses are untrusted. Strict
schemas and fixed allowlists run at every hop. Direct account/workspace database
IDs never become destination identities. Verified email/name and workspace name
appear only in eligible Global profile/group jobs so approved staff can identify
and contact users; they are not copied onto events or crashes.

A minidump may contain customer content. It receives owner-only local permissions,
header-authenticated upload, a dedicated regional bucket, a 90-day absolute
deadline, no-egress processing, and audited restricted lookup. The symbolicator
receives only the selected dump and symbol archive through Worker-owned streams;
it has neither R2 credentials nor internet access. Telemetry secrets have no
`VITE_` name and never reach preload or renderer bundles.

## Operations

Every five-minute scheduled pass reaps expired rows/objects, purges opted-out
crashes, processes event/profile/crash work, repairs stale crash claims, and emits
one `telemetry_operations_snapshot`. The snapshot contains only pending/terminal
counts, rejection count, open-circuit count, and oldest backlog ages. Alert on an
open circuit, any terminal count, oldest age approaching 15 minutes, persistent
processing failures, missing symbols, or deletion survivors.

Use the [telemetry incident procedures](runbook.md#regional-telemetry) for provider
outage, backlog, rejection/abuse, missing artifacts, prohibited data,
cross-region routing, preference inconsistency, replay, or deletion failure. Never
inspect a raw payload or dump through logs. Replay is region- and role-restricted,
preserves the original event ID/hash/deadline, and records only fixed audit codes.
The operator HTTP surface authenticates against a per-region secret map, derives
the operator ID/role server-side, and never accepts either value from a request.

## Performance and cost

The route gate is the only telemetry work allowed before the first renderer and is
bounded to two seconds. Normal desktop collection writes small validated files and
flushes in batches of 50 every 30 seconds. Regional acceptance performs only
validation plus a D1 batch; destination calls and symbolication are deferred.
Crash processing selects ten reports per pass and Global delivery selects five.

The engineering budgets remain: API ingest p95 under 25 ms, typical desktop
telemetry under 0.5% CPU/15 MiB/1 MiB per day, and 95% owned-frame symbolication
when matching artifacts exist. Operational snapshots and packaged fixtures provide
the dry-run evidence; change batching or sampling only after measuring those
signals, never by weakening policy or deadline tests.

## Changelog

### 2026-08-13 — Release artifacts use the regional object API directly

**What changed:** The macOS release publisher now uploads and reads back private
source maps and native symbols through Cloudflare's object REST API. It hashes
the exact bounded bytes supplied to the upload, streams and bounds the returned
hash verification, times out stalled requests, and sends the explicit `eu`
jurisdiction header only for the EU telemetry bucket. API deployment also
derives a hosted-R2 inventory from both Wrangler files, logs every binding, and
proves each bucket exists before remote mutations.

**Why:** Wrangler's object read returned a deleted, earlier native-symbol object
on a release retry even though Cloudflare's authoritative object listing no
longer contained it. That made a valid regenerated archive fail the checksum
gate and prevented an otherwise signed and notarized release from publishing.
The first attempt also found that `avalon-eu-telemetry` did not actually exist:
Wrangler had accepted and deployed its binding without provisioning the bucket.
The previous artifact command also omitted Wrangler's EU-jurisdiction flag, so
even a provisioned EU bucket could not be addressed by that release path.

**Considered and rejected:** Disabling checksum verification, accepting the old
archive, or rotating both buckets. Those would respectively remove the
end-to-end integrity proof, risk publishing symbols for a different binary, or
replace regional infrastructure to work around a client-path inconsistency.

**Consequences:** The release token must retain `Workers R2 Storage Write`; the
publisher holds one preflight-bounded artifact in memory at a time and hashes
the verification response incrementally. Regional isolation is explicit in the
request rather than inferred from CLI state, and a retry remains fail-closed on
any upload, readback, timeout, size, or checksum error.

### 2026-08-13 — Telemetry dependencies can be staged safely

**What changed:** Production now accepts a healthy collector before PostHog
delivery, a dedicated capability signer, or internal operator access is
provisioned. The provider adapter remains idle without its token, onboarding
capabilities use the existing Global session signer when no dedicated signer is
present, and an absent operator map keeps only the restricted operator routes
unavailable.

**Why:** The first regional deployment had healthy D1, R2, RPC, queue, and
workflow bindings but the environment contract made all API routes return 503
because those three optional downstream controls had not been configured. This
also contradicted the implementation's deliberate no-op, fallback, and fail-
closed behavior and prevented collecting internal evidence before the PostHog
project exists.

**Considered and rejected:** Reusing a made-up PostHog token, granting an
operator credential just to satisfy health, or rolling back a Worker after its
migration. Those either corrupt provider data, create unnecessary access, or
violate the forward-only deployment rule.

**Consequences:** Health proves the regional collection plane, not that optional
delivery or operator access is active. Operations must verify those surfaces
separately when they are intentionally enabled.

Shipped in the pull request for this change.

### 2026-08-13 — The packaged Crashpad gate owns its bundler

**What changed:** The desktop package now declares the exact `esbuild` version
used by its packaged Crashpad lifecycle fixture, and the fixture resolves that
binary through the desktop workspace package.

**Why:** A developer install happened to expose another package's transitive
binary, but pnpm correctly withheld it from the clean macOS release runner. The
release therefore stopped before signing even though the fixture passed locally.

**Considered and rejected:** Relying on the root's transitive dependency or
removing the packaged gate. Neither makes the fixture reproducible on the runner
that must prove the released native crash path.

**Consequences:** Changes to the fixture's bundler version must update its direct
desktop dependency and lockfile; release invariants enforce both ownership and
package-scoped resolution. pnpm starts from the workspace root to resolve the
filter but runs `esbuild` from the desktop package, so the bundle entry and
output remain absolute paths. The fixture verifies the bundle immediately
because a pnpm filter that matches no package can still exit successfully.

Shipped in the pull request for this change.

### 2026-08-13 — Telemetry seams preserve policy and metric correctness

**What changed:** Server outcomes now use event-specific idempotency keys while
keeping the client operation ID only as correlation; valid onboarding failures
emit bounded authoritative outcomes; desktop rows fix `sentAt` at their first
transmission; EU semantic retention starts at normalized occurrence; anonymous
identity linking waits for local epoch rows to drain; and a regional preference
conflict projects and adopts the canonical winner instead of replaying a stale
device choice. API-operation middleware now mounts once above sibling routers;
expired onboarding journeys are replaced safely; invalid profile jobs terminate
per row; crash-free denominators count distinct launches; Product analytics owns
breadcrumb teardown; and release publication accepts every source-map chunk for
each approved Electron process.

**Why:** Reusing an operation ID across different outcome kinds caused the
accepted-event primary key to discard one funnel step. Capture-time `sentAt`
shifted delayed events forward during clock normalization, acceptance-time EU
deadlines exceeded the occurrence-based ceiling, and closing a journey after a
best-effort flush could strand backoff rows. Separately, compare-and-set retries
must preserve a newer account preference, especially an opt-out. Review also
proved duplicated operation events, retained-expired journey conflicts, delivery
poison pills, inflated crash-free denominators, an inverted settings callback,
and a source-map allowlist that became mutable discovery state.

**Considered and rejected:** Removing idempotency, treating capture time as send
time, extending retention by offline delay, linking while rows merely have a
future retry scheduled, and automatically overwriting the canonical preference
after a conflict. Each would trade correctness or user control for a simpler
happy path. Silently dropping corrupt profile work, counting joined rows, or
assuming one source map per process were also rejected because they make healthy
operations and dashboards depend on accidental input shape.

**Consequences:** New authoritative producers need a durable event-specific key
and a separate operation correlation. Spool schema changes must preserve the
first-send marker, EU lifecycle tests must anchor semantic deadlines to
occurrence, and identity-link or preference retry changes must retain the new
conflict/drain regressions. Middleware remains a single root concern, profile
validation remains row-isolated, crash-free queries deduplicate launch IDs, only
Product analytics changes may control breadcrumbs, and artifact discovery must
keep its allowlist immutable.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-13 — Parser limits do not depend on a shared host UID

**What changed:** Removed the processor's `RLIMIT_NPROC` setting while retaining
its address-space, CPU, output-size, file-descriptor, timeout, read-only
filesystem, and no-network controls.

**Why:** Linux accounts `RLIMIT_NPROC` across every process with the same host
UID. A sibling container using the symbolicator's non-root UID could therefore
consume the allowance and make a valid dump fail as malformed. The stack walker
does not execute dump content or launch child processes, so the shared-UID limit
added denial-of-service coupling without containing an available behavior.

**Considered and rejected:** Raising the process limit. Any fixed per-UID value
would preserve the same cross-container coupling and merely move the failure
threshold.

**Consequences:** Parser isolation continues to rely on the dedicated container,
fixed executable, and the remaining explicit resource limits. Future parser
changes that add child processes must introduce a container-scoped process bound
instead of restoring a host-UID `RLIMIT_NPROC`.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-13 — The native processor is tested at its deployment boundary

**What changed:** Added a CI gate that builds the symbolicator image and runs a
checksum-pinned real minidump/symbol pair plus malformed input inside the same
non-root, read-only, no-network boundary used by production. Its host fixture
directory grants traversal and read access to the container UID while the mount
itself remains read-only.

**Why:** Unit fakes and Wrangler configuration assertions proved orchestration but
could not prove that the pinned stack walker, Python wrapper, symbol layout, and
sanitizer interoperate in the shipped image. Native Linux preserves bind-mount
permissions, so private host defaults made the valid fixture look absent to the
non-root parser; Docker Desktop's file-sharing layer had hidden that boundary.

**Considered and rejected:** Keeping only mocked executor tests, checking that
the Dockerfile contains security-related strings, or running the integration
container as root. The first two do not execute the parser or observe the report;
the last one stops testing the production security boundary.

**Consequences:** CI requires Docker and network access only to fetch two
commit- and checksum-pinned rust-minidump fixtures before disabling container
egress. Test fixture permissions must remain readable by UID 10001 without
widening the production image or its mount. A parser, image, symbol-layout, or
sanitizer change must keep this gate green.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-13 — Operator and EU journey-control authority is explicit

**What changed:** Added the authenticated per-region `/internal/telemetry`
surface for status, Global replay, raw-crash access, and EU aggregate queries.
Operator identity and role now come only from a regional secret map. EU also
verifies and closes Global-issued onboarding journeys through a narrow control RPC
instead of holding the capability-signing key.

**Why:** Library functions with no deployed caller could not support an incident,
and accepting a caller-supplied role would not be authorization. Independently,
copying the Global capability key into EU would let either region mint authority
for the other and make rotation a cross-region secret-sharing operation.

**Considered and rejected:** A public debug route, desktop-session authorization,
operator ID/role fields in request bodies, and a shared regional capability key.
Each either exposes raw diagnostics to the product plane or lets an untrusted
caller/region manufacture authority.

**Consequences:** Operators need separate regional bearer tokens and must use the
role-matched reason for raw access. Replay remains Global/security-only. Future
cross-region telemetry control methods must preserve the payload-negative RPC
contract and keep the signing key in Global.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-13 — Pre-workspace EU intent remains immediate

**What changed:** Route-mismatched, logged-in onboarding intent now continues
under the fixed anonymous epoch until a workspace region exists; workspace
creation and activation intents are allowlisted for that narrow capability.

**Why:** A Global identity session can exist before workspace residency is
chosen. Treating it as an authenticated Global delivery left EU-routed intent
queued locally, contradicting the no-holding and immediate-coarse-route design.

**Considered and rejected:** Sending the intent to the login session's Global
region or waiting to re-route it after workspace creation. Both would move or
delay a route-fixed onboarding history and corrupt the regional funnel.

**Consequences:** Cross-region provisional journeys remain aggregate until a
same-region identity link exists. Operation IDs still correlate intent and
outcome where both survive in the same regional analysis surface.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-13 — Regional Container development starts deterministically

**What changed:** Added the local-supervisor port declaration required by
Wrangler and serialized the two regional Worker startups until Global reports
ready.

**Why:** Concurrent Wrangler builds of the shared symbolicator image race on
transient Docker tags, while an exec-only image without an exposed port is
rejected by the local Container supervisor. Together these made the documented
dual-region development command fail after adding native processing.

**Considered and rejected:** Duplicating the processor image/classes per region.
That would obscure the intentionally identical toolchain without removing the
underlying concurrent Docker-build behavior.

**Consequences:** `pnpm dev:api` and `pnpm dev:api:local` start EU only after
Global is accepting requests, then supervise both processes together. The
declared port must remain unused unless the trust model is redesigned.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-13 — Raw crash retention survives a missing index

**What changed:** Added an R2-prefix deadline sweep that deletes expired raw
crash objects independently of the D1 crash index and fails closed on missing or
malformed deadline metadata.

**Why:** R2 can accept a minidump immediately before an isolate fails to commit
its index row. A D1-only reaper could never discover that orphan, violating the
absolute internal retention ceiling.

**Considered and rejected:** Relying on the ingest catch block or the D1 reaper.
Neither runs after abrupt termination between the two durable writes.

**Consequences:** Every raw crash write must keep the immutable `deleteAfter`
metadata, and the scheduled processor must retain the dedicated regional prefix
sweep.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-12 — Regional telemetry becomes an end-to-end production subsystem

**What changed:** Added the typed registry, route and identity epochs, account
preference, bounded desktop spools, semantic and reliability producers, regional
collector and EU sink, idiomatic Global PostHog adapter, ordered profiles, replay,
operations, JavaScript diagnostics, native Crashpad upload/symbolication, internal
queries, dedicated telemetry buckets, release artifacts, and packaged gate.

**Why:** Product analysis needs client intent joined to authoritative server
outcomes, while Electron crashes require a deeper lifecycle than a browser SDK can
provide. Centralizing policy in Avalon keeps route, opt-out, identity, and internal
retention enforceable without giving the renderer provider authority.

**Considered and rejected:** Direct renderer PostHog, a thin reverse proxy,
mechanism-based autocapture, a Segment dependency for one destination, a
region-pending store, EU-to-US forwarding, and a shared Analytics Engine sink.
Each either weakened semantic quality, residency, policy enforcement, or exact
retention without solving the native crash boundary.

**Consequences:** Global and EU deployments need distinct telemetry R2 resources,
Container support, migrations, capability secrets, and five-minute maintenance.
Release automation must publish private artifacts before distribution. Provider-
side PostHog lifecycle remains an operational configuration outside this module.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-12 — Native dumps begin with a route-final generation boundary

**What changed:** Added whole-directory inactive rotation, absolute 14-day local
deadlines, durable generation invalidation, and corrupt/expired startup purge.

**Why:** Electron cannot stop Crashpad after it starts or attach authenticated
headers to its uploader. Rotation after handler exit preserves its supported
ownership boundary while fixed route/deadline metadata prevents later expansion.

**Considered and rejected:** Reading the live database, direct Crashpad upload,
and a local stack-walking CLI as the production processor.

**Consequences:** Main can only upload on a later launch, opt-out requires restart
to stop dump generation fully, and every released target needs a real packaged
Crashpad fixture plus matching private artifacts.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).
