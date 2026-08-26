# Regional telemetry

Rally's telemetry subsystem accepts a closed set of semantic product signals,
content-free reliability signals, sanitized JavaScript diagnostics, and native
Electron crash reports. Rally owns collection, policy, routing, identity,
durability, and internal retention; PostHog is the Global destination, not an SDK
embedded in the renderer or a source of product truth.

The single account-scoped **Product analytics** setting defaults on. Turning it
off stops product events, detailed JavaScript diagnostics, identity/profile jobs,
and native crash upload; essential bounded reliability signals continue. Global
may send approved data to the US PostHog project. EU product and crash telemetry
terminates in Rally's EU-isolated Cloudflare resources.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/telemetry.ts` | Closed event registry, envelope/batch schemas, breadcrumb and bootstrap contracts, size limits, and prohibited-field rules. |
| `apps/desktop/src/main/telemetry-*.ts` | Route, random identity epochs, local event spool, typed reporter, breadcrumbs, launch markers, and preference-independent reliability collection. |
| `apps/desktop/src/main/application-open-observer.ts` | Closed cold-start attribution and activation coalescing so explicit deep-link/menu sources outrank Electron's generic Dock/reopen callback. |
| `apps/desktop/src/main/native-crash-*.ts` | Route-final Crashpad generations and the bounded, authenticated next-launch uploader. |
| `apps/desktop/src/main/product-analytics-settings.ts` | Local-first disable, fail-closed enable/refresh, preference synchronization, crash invalidation, and spool purge. |
| `apps/desktop/src/main/index.ts` | Startup ordering, Crashpad start, process observers, IPC sender validation, upload scheduling, and product integration points. |
| `apps/desktop/src/main/telemetry-intent.ts` | The renderer-intent allowlist and validator every `telemetry:product-intent` call passes through, kept out of the entry point so it can be tested by running it. |
| `apps/desktop/src/renderer/lib/telemetry.ts` | Narrow renderer facade for registered screen, product-intent, and error-candidate calls. |
| `apps/desktop/src/renderer/lib/socket-telemetry.ts` | The one `realtime_socket_state` producer, instantiated per live socket loop by the workspace, WorkstreamDO-control, SubstreamAgent-feed, and per-block HyperSight hooks; it also reports every WorkstreamDO-control and SubstreamAgent-feed connection start. |
| `apps/api/src/routes/telemetry.ts` | Bounded bootstrap, anonymous/authenticated event, identity-link, preference, and crash-ingest routes. |
| `apps/api/src/routes/telemetry-operations.ts`, `apps/api/src/telemetry/operator-auth.ts` | Bearer-authenticated, role-restricted regional status, replay, raw-crash access, and EU analysis HTTP surface. |
| `apps/api/src/telemetry/` | Regional collector, identity/preference logic, PostHog adapter, EU sink, replay, crash processing, operations, and lifecycle jobs. |
| `apps/api/src/middleware/api-operation-telemetry.ts` | Content-free timing/outcome signals for an explicit API operation allowlist. |
| `apps/api/src/telemetry/tool-usage.ts` | Content-free, durably admitted agent-tool usage for user-owned and personless workspace-owned runs. |
| `apps/api/src/telemetry/workstream-creation.ts` | Server-authoritative, idempotent work-stream creation state and connector attribution across user, Slack, suggestion, and automation paths. |
| `apps/api/src/telemetry/product-usage.ts`, `apps/api/src/telemetry/run-outcome.ts` | Shared bounded dimensions, idempotent resource event IDs, and authoritative run/tool journey outcomes. |
| `apps/site/src/telemetry.ts`, `apps/site/src/site-entry.ts` | Region-before-identity public-site page, action, acquisition, and browser-to-desktop handoff reporting. |
| `apps/api/src/crash-symbolicator*.ts`, `apps/api/crash-symbolicator/` | Private Cloudflare Container boundary and pinned native stack-walking image. |
| `packages/db/migrations/0074_regional_telemetry.sql` | Telemetry identities, preferences, outboxes, internal EU projections, crash indexes, deadlines, rate buckets, circuits, and analysis dimensions. |
| `packages/db/migrations/0077_connector_oauth_telemetry_shape.sql` | The bounded event version, connector scope, capability count, and reconnect state admitted with an OAuth attempt for later terminal telemetry. |
| `apps/desktop/scripts/publish-telemetry-artifacts.mjs` | Private source-map and native-symbol publication to both isolated telemetry buckets. |
| `apps/desktop/scripts/telemetry-crashpad-fixture.mjs` | Real packaged Electron/Crashpad two-launch release gate. |

The approved product contract and rationale are frozen in the [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md); this document describes
the implementation that future changes must preserve.

For the implementation checklist, see
[`adding-new-instrumented-event.md`](adding-new-instrumented-event.md).

## How it works

### Contract and producers

`TELEMETRY_EVENTS` is the only event registry. Each entry fixes its sources,
authoritative producer, identity scopes, category, exact property schema,
classification, priority, sample rate, retention, and destination. Incompatible
changes require a new schema version. There is no generic `capture(name,
properties)` API outside the reporter internals.
The authenticated desktop `/telemetry/events` transport rejects every envelope
whose source is `api`; server producers call the internal emitter directly. The
shared envelope schema accepts API events so those internal producers remain
typed, not so a session-bearing client can claim server authority.

Legacy envelopes have the frozen context v1 shape. Native desktop enrichment
uses `contextSchemaVersion: 2`; the regional reader accepts both shapes, while
API-generated events remain on v1. The regional reader must reach both regions
before a desktop release emits v2, and a later API rollback must retain that v2
reader until every released desktop producer has aged out.

Automatic collection is limited to bounded application install/update,
lifecycle/session/process/update, application-open/settings state, spool,
API-operation, crash-upload, and public-site page-view/page-leave signals. The
site calls those two registered contracts from its shared entry; this is not DOM,
history, network, or arbitrary URL autocapture.
Main adds a closed native-desktop context: the random installation device ID,
app/build, OS/version, locale, timezone, display dimensions, and—when an event
comes from a live renderer—its random window ID and viewport dimensions. Router
calls emit registered screen enums. Product integrations emit semantic intent
before a state-changing request; the authoritative API emits the outcome with
the same `operation_id`. Rally does not capture DOM interactions, console
output, arbitrary network traffic, URLs, request bodies, prompts, messages,
documents, or session replay.

The macOS status surface emits `menu_bar_opened` once per visible open and
`menu_bar_action_selected` for enabled rows using closed structural properties
only. The sidebar emits one `command_shortcuts_revealed` per Command hold and
`command_shortcut_used` only for a valid Command+1–9 navigation. Suggested-work
clicks pass a bounded surface to the regional API; only a successful creation
emits the authoritative `suggested_work_started_v2` with exposure position,
version, audience, connector types, and prior-impression bucket. Impression and
dismissal are likewise server-owned and idempotent. Released clients that omit
the richer position fall back to the legacy successful-start event, but one
request never emits both versions. None of these events includes routes, titles,
or prompts.

Every realtime socket reports its own connection transitions. The renderer is the
authoritative source because it is the only party that can tell a first
connection from a reconnection, and how many attempts one took: the room sees an
admission either way. One `realtime_socket_state` names which socket
(`workspace`, `workstream_control`, `substream_feed`, `block_dashboard`), whether
it is connected, retrying, or stopped, the bounded cause, and the retry depth as
a count bucket. HyperSight opens one socket per configured block, so a dashboard
of six blocks reports six connections; the event names no block, so what it
measures is the drop rate of that socket kind rather than of any one block.
Dictation's audio socket is deliberately outside this contract: it is an Azure
transport with its own lifecycle, not one of the room sockets.
The cause is stated where it is known rather than derived from a close code,
which carries none of it — a heartbeat that went unanswered, a transport error, a
ticket that could not be issued, a room that could not replay, going offline, and
losing access are each their own value, and a close nobody asked for is the
server's. Offline is checked once more after the socket ticket resolves, because
a client that drops off the network while that request is in flight has no socket
for its offline handler to close: dialling anyway fails a moment later and would
be counted as a transport error, which is the one reading this event exists to
keep apart from losing the network. A close from the effect's own teardown is not a transition at all and
is not reported; counting it would put every ordinary navigation in the drop
rate. The event carries no work-stream ID, URL, close code, or ticket.

Resource telemetry uses successful semantic operations, not generic click
autocapture. A loaded work stream records open/switch/reopen, visibility, origin,
and pin state. The API records creation once the work-stream row commits; its
closed source distinguishes composer, suggested work, Slack Agent, manual,
scheduled, activity-triggered, and inbound-email automations. It derives
visibility, origin, participant count, opening-attachment count, and model
override from stored rows. Connector attribution is the canonical connector type
or a bounded unique list for a multi-source suggestion—never a connection or
provider-account ID. Successful resource
menus record work-stream pin/visibility/unread/rename/archive changes, note
visibility/archive changes, and automation run/archive/delete actions. Message
creation is server-owned across desktop, Slack, and email channels and records
counts but no text. Elicitation presentation and resolution carry a stable
question ID, bounded shape, resolution class, and latency but never the question
or response. Copy buttons record a closed content class and
the owning resource UUID only after the clipboard write succeeds. Notes record
create/open/reopen plus transcription start/pause/resume/complete with their
actual audio-source class. These events may carry opaque work-stream, message,
note, automation, and run UUIDs for pathing and joins, but never titles, bodies,
clipboard values, prompts, transcripts, or provider content.

A primary sidebar work-stream click emits `workstream_open_started` with one
opening-attempt operation ID. Its terminal `workstream_open_outcome` is
`visible`, `superseded`, `abandoned`, or `load_failed`; a rapid A to B to A sequence therefore
has three attempt IDs and two explicit superseded outcomes instead of silently
dropping the abandoned work. A duplicate click on the same still-pending row
retains its first attempt ID and first-click dimensions, and the already-active
row starts nothing. Leaving for another surface or ending the owning session
emits `abandoned`, so returning to the same row starts a fresh clock rather than
inheriting time spent elsewhere. The
visible outcome accompanies `workstream_feed_visible`, which records exact
click-to-data-ready and click-to-first-painted-feed milliseconds, the
pinned/recent section, the detail/transcript cache state, the pooled-socket
state at click, the feed source (`feed_cache`, `socket_snapshot`, `boot_payload`,
or `legacy_page`), and only a count bucket for messages. The normal cold path is
explicitly
`socket_snapshot`; `boot_payload` and `legacy_page` identify manual REST
recovery, while `feed_cache` identifies an already-present transcript. Each
detail request keeps a unique
`x-request-id`, including React Query retries, and carries the click ID separately
as `x-rally-operation-id`; the Worker's `workstream.detail.read` span records both.
The independently timed `workstream_send_ready` event reuses the opening-attempt
operation ID and fires after the committed composer has crossed a paint with its
work-stream-specific send handler installed. It records the workspace command
socket state at that point. `connecting` and `reconnecting` are ready states for
this client milestone because the workspace socket queues idempotent message
commands; the event does not claim that transport delivery or server
acknowledgement has completed.

Every mounted pooled socket owner has a UUIDv7 socket-lease ID shared by its
control and feed connections for the owner's full retained lifetime.
`workstream_socket_started` records that lease plus a distinct socket-attempt
operation ID before every ticket request; the latter remains the ticket request
ID. A socket attempt that begins while an opening is pending also records that
opening-attempt ID. A hover-warmed or retained socket may predate the click, so
the opening start/outcome and feed event record the serving lease ID instead of
falsely claiming the click started it. Global lakehouse/PostHog rows can thus
join one click to its requests, socket attempts, and pre-existing pooled lease
without putting a route or title in an event.

Work-stream collaboration records authoritative participant changes, resource
attach/detach/watch/preview/open-source outcomes, stop/retry actions, unread
attention consumption, and HyperSight open/configuration/run outcomes. Terminal
workspace lifecycle and policy events preserve only bounded result,
repository-present, connector-class, local-file-retention, policy-mode, and
active-sandbox dimensions. Connector telemetry covers setup, user actions,
health transitions, and admitted activity; digests cover schedule and delivery;
invitations cover creation through terminal response. Provider payloads,
connection/account IDs, invite email addresses, digest contents, and Terminal
commands or paths remain prohibited. OAuth connector attempts persist their
closed telemetry shape and the renderer's explicit event-contract version. A
current client emits only `connector_setup_requested_v2`; a benign query marker
selects V2 while the already-deployed operation header retains correlation. The
API answers it with only `connector_setup_completed_v2` under the same operation
ID, including terminal failures. An older client without the version marker
retains the V1 outcome, so one attempt never emits both destination versions.

Automation measurement starts when the builder becomes actionable. The API
records each durable compiler turn, first create-ready revision, authoritative
custom/template creation, overview reopen, and lifecycle or execution outcome.
Trigger, connector, plugin, delivery-target, input-mode, turn-count, and duration
dimensions are closed and content-free. Current clients emit only the richer
contracts; legacy creation/action contracts remain accepted for released clients
and are not duplicated.

The regional agent runtime emits `agent_tool_started` only after the canonical
execution plan has been durably admitted and replay/ambiguity checks have passed.
It includes work-stream, run, optional automation, canonical tool/plugin/
capability, read/write mode, run kind, and execution scope. Tool arguments,
outputs, summaries, provider payloads, and errors never enter the telemetry
envelope. User-owned runs use `workspace-user`; unattended workspace-owned runs
use a personless `workspace` scope and cannot be submitted through desktop
telemetry ingest.
Each durable invocation also produces one terminal result with latency and replay
state, while each root run produces an authoritative terminal event with trigger,
time-to-first-output, turns, tool/write counts, model route, and fallback state.
The established requested/completed pair remains a separately named admission
funnel for correlated desktop runs; it is not mapped to the same reserved event.

After main has initialized the operating-system login item, Lockdown controller,
and application icon, it emits one `application_settings_state_v2` with the actual
enabled and availability booleans, closed icon identifier, and menu-bar state. A
newly authenticated account receives the same snapshot
after its Product analytics preference has been verified. Successful Settings
interactions emit `application_setting_change_completed_v2` for launch-at-login,
Lockdown mode, and menu-bar visibility with previous, requested, applied, and
result fields, or
`application_icon_changed` with the previous and applied icon states. This
distinguishes a macOS login-item request awaiting approval from a state that was
actually enabled. A rejected or rolled-back mutation emits no completion event.

Main emits `application_opened` once for the cold process start and again only
when an attributable action explicitly raises the running app. Its closed
`entrypoint` is `system_start`, `user_launch`, `dock`, `deep_link`, `menu_bar`,
or `push_notification`, and `phase` distinguishes `cold_start` from
`activation`. The login-item flag proves `system_start`; an accepted OS deep
link proves `deep_link`; menu actions prove `menu_bar`; and Electron's coalesced
`activate` callback supplies `dock` only when no neighboring explicit source
claims the activation. For a cold ordinary GUI launch, Electron exposes no
reliable Dock-versus-Finder-versus-Spotlight fact, so Rally records the honest
`user_launch` class. There is no native push-notification producer today; the
closed value is reserved for a future native click handler, which must report it
before raising a window. Ordinary email, Slack, and browser handoffs remain
`deep_link` because their identical URL cannot prove which external surface sent
it.

The renderer's shared API adapter explicitly reports non-abort `fetch` failures
and upload-XHR network failures as `network_error` because product UI handles
those rejections and the global `error` and `unhandledrejection` listeners will
not observe them. The report still crosses the same narrow error-candidate IPC as
other JavaScript diagnostics: only bounded bundle-relative generated frames and
the stable error code survive. The failing URL, request headers and body, error
message, and underlying transport detail do not. Repeating the same classification
for an `Error` object is suppressed. A later crash classification for an object
first seen as `network_error` is still reported so it can produce the essential
process-health signal; a coalesced network report does not mark that object as
reported. Fresh network errors with the same sanitized frame signature are
coalesced to one report per five minutes through a 100-entry in-memory table. A
handled network failure is diagnostic only: unlike a real JavaScript exception or
rejection, it does not emit an essential `process_health` transition.

The public site uses the same anonymous capability boundary but has its own
identity rule. It first obtains a content-free Cloudflare `eu`/`global` route and
a five-minute signed decision token. Global then reads or creates one random
first-party `localStorage` epoch for multi-page acquisition paths. EU uses an
in-memory epoch for that page and does not read or write a persistent analytics
identifier. Bootstrap consumes the signed first decision instead of
independently routing its second request. Registered events cover
safe page/path/referrer/campaign fields, bounded actions and placements, and
handoff type/method/validity. URL query strings/fragments, tickets, provider
state, resource IDs, forms, and page content are never sent. See
[`public-site-telemetry.md`](public-site-telemetry.md).

### Route and identity

Before the first renderer exists, main resolves telemetry routing. An existing
workspace binding is authoritative. Otherwise the Global bootstrap endpoint
reduces Cloudflare's country signal to `eu` or `global`, stores only the route and
basis, and returns a short-lived capability bound to the current anonymous login
epoch. An affirmative EU result prevents pre-region Crashpad startup. Non-EU,
unknown, malformed, failed, or two-second timed-out bootstrap uses Global. No
region-pending payload store exists.

Every event receives one immutable route. Identity has five scopes: installation,
anonymous epoch, platform user, workspace user, and personless workspace
execution. A later workspace choice changes future events only. Global can hand
an already validated EU onboarding projection to the
named EU telemetry RPC; no EU event, identity, crash, or replay moves to Global.
If login succeeds before a workspace exists and the Global login session does
not match the coarse EU route, registered pre-workspace intents continue under
the route-fixed anonymous epoch and its capability. They are accepted
immediately rather than becoming authenticated rows that wait for region
selection. A later workspace selection is prospective and does not migrate them.

The desktop persists one random installation ID and one rotating anonymous login
epoch. Only the epoch is used for the explicit anonymous-history-to-person
transition. Global desktop events also send the random installation ID as
PostHog `$device_id`, matching first-party app SDK attribution, so identified
events can associate a device with a person. This is not a raw platform ID and
does not create a Rally identity link or a cross-region mapping. Logout,
account switch, or abandoned authentication rotates the epoch. In Global, the
ordered transition is PostHog `$identify` with the stable person as
`distinct_id`, the epoch as `$anon_distinct_id`, and the verified email/name
profile. A later profile job cannot supersede an unresolved transition. Eligible
Global workspaces use a stable random `workspace` group ID and only the current
workspace name.

### Preference and local delivery

Authenticated startup treats nonessential telemetry as off until the regional API
confirms the canonical account preference. A disable is fsynced locally before
the network mutation, invalidates the live Crashpad generation without opening its
database, stops upload immediately, and purges queued nonessential rows. Enable
does not become effective until the compare-and-set regional/canonical update is
acknowledged. Session changes force a fresh fail-closed read. That read has a
15-second deadline: it remains bounded, but includes cold DNS, TLS, regional
Worker activation, and the canonical D1 lookup instead of treating a normal
cold request as an outage after one second. Authenticated launch waits at most
two seconds for that same request before continuing to the first window; the
caught request keeps running, and collection remains off until it validates the
canonical preference.

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
sender against a live Rally window and the pinned application origin.

### Regional acceptance and destinations

The API validates the batch again, resolves or allocates immutable random
analytics identities, derives trusted route/release context, normalizes excessive
clock skew, and commits the accepted row plus receipt before returning `202`.
Identical event-ID retries acknowledge as duplicates; a different payload under
the same ID conflicts. EU acceptance also writes the independently expiring
internal semantic projection. Global acceptance leaves a destination row for the
five-minute scheduled processor. It also leaves an independent lakehouse outbox
state and best-effort enqueues an event-ID/hash pointer. Scheduled recovery
retries pending and still-undelivered queued pointers newest-first; the Global
consumer reloads the canonical row, recomputes its acceptance hash, and
revalidates the envelope before projecting every admitted context/property
field to `avalon.analytics_events`. Permanent integrity/schema failures are
terminally rejected rather than retried. EU never enters that transport.

Global delivery uses stable `$insert_id`, `$session_id`, `$window_id`,
`$device_id`, `distinct_id`, PostHog workspace groups, `$is_identified`,
`$process_person_profile`, `$geoip_disable`, normalized
timestamps, and the official exception capture path. The adapter translates only
exact provider equivalents: legacy `screen_viewed` and current
`surface_viewed` become `$screen` without being produced for the same current
navigation; `site_page_viewed` and `site_page_left` become `$pageview` and
`$pageleave`; `application_opened` becomes `Application Opened`; and background becomes
`Application Backgrounded`. Other lifecycle reliability retains
`application_lifecycle`. The canonical open carries `application_open_source`,
`from_background`, and version/build on cold starts. This leaves one—not
parallel custom and reserved—PostHog open event for each attributed occurrence.
`application_version_changed` becomes `Application Installed` or
`Application Updated`; rollout onto an existing installation establishes a
durable baseline without emitting a false installation event. A pending
transition keeps one stable event ID until its local spool enqueue succeeds, so
an interrupted write retries without losing or double-counting the transition.
The adapter keeps
`rally_event_name` on every destination event and adds the applicable
first-party app context: `$app_*`, `$device_type`, `$os`/`$os_name`,
`$os_version`, `$locale`, `$timezone`, display/viewport dimensions, and
device/window identity. It marks only events
that originated in the API with `$is_server`. It never emits both the Rally and
provider spelling for one occurrence. JavaScript source maps are loaded privately
and only mapped application frames leave Rally. Malformed
profile jobs are terminalized individually so one corrupt row cannot block later
profiles, event delivery, or operational snapshots. PostHog 408,
429, 5xx, and network failures on ordinary event/profile batches retry with
`Retry-After` or exponential backoff; other 4xx responses become terminal. The
PostHog exception SDK exposes only flush success/failure for JavaScript/native
exceptions, so a failed flush retries without status-specific classification.
Five consecutive transient failures open a per-stream five-minute circuit. EU
has no PostHog token, host, adapter call, or telemetry Analytics Engine dataset.
For identified Global settings events, the adapter also uses PostHog's event
`$set` shape to maintain current `rally_launch_at_login_*`,
`rally_lockdown_mode_*`, `rally_application_icon_*`, and
`rally_menu_bar_*` person properties.
Anonymous settings snapshots remain personless; the semantic event itself is the
regional source of truth in both regions.
Workspace-owned API events use the stable workspace analytics ID as both their
personless distinct ID and `workspace` group key; they set
`$process_person_profile: false` and never create or update a PostHog person.

### PostHog product compatibility

This table was audited against the Tools catalog visible in the US PostHog
project on 2026-08-13. "Supported" means Rally's truthful data contract is
enough for the product; it does not mean the product has been pinned in the
sidebar or configured with a saved view. Reserved PostHog events are destination
formatting only. The regional registry and EU projection keep their Rally names.

| PostHog tool | Status | Rally contract |
| --- | --- | --- |
| Dashboards, Product analytics, SQL editor | Supported | Semantic events, `$screen`, stable identities, `$session_id`, workspace `$groups`, profiles, release/app context, and request/outcome correlation support trends, paths, funnels, retention, cohorts, and HogQL. |
| Endpoints, Inbox, Notebooks, Workflows | Supported after PostHog-side configuration | They consume the same truthful events and profiles; no new capture event should be invented merely to enable a destination, alert, notebook, or workflow. |
| Error tracking | Supported | JavaScript and native reports use the SDK's exception capture path with fingerprints, app frames, releases, sessions, groups, and app context. |
| Marketing analytics, Web analytics | Supported for the public site | Real site observations map once to `$pageview`/`$pageleave` with safe URL, pathname, host, referrer-domain, and UTM context. Electron `$screen` events remain separate and never impersonate web traffic. |
| Heatmaps, Replay vision, Session replay | Not enabled | They require browser/mobile interaction coordinates or `$snapshot` recording data. Semantic screen/action events cannot reconstruct a truthful replay or heatmap. |
| Surveys, Support | Not enabled | PostHog surveys require survey retrieval/display logic and exact `survey shown`, `survey sent`, and `survey dismissed` events with provider survey IDs and responses. Emitting those events without actually rendering a PostHog survey would corrupt response data. |
| Logs, Tracing | Not enabled | Logs and traces use their own OpenTelemetry/log ingestion protocols. `trace_id` and `span_id` correlation on a product event is useful but is not a substitute for exporting a trace or log record. |
| Feature flags, Experiments, Early access features | Not enabled | Cloudflare Flagship is Rally's flag authority. Do not forge `$feature_flag_called`, `$feature/<key>`, or experiment exposure properties for a flag PostHog did not evaluate. A future PostHog-owned or explicitly mirrored evaluator must emit the exact evaluated variant on exposure and attach it to downstream outcomes. |
| AI observability, MCP analytics, Clusters, Datasets, Evaluations, Playground, Prompts | Not enabled | These require a truthful `$ai_trace` tree with `$ai_generation`, `$ai_span`, and `$ai_embedding` records. `run_requested`/`run_completed` describe product outcomes and must not be renamed into incomplete AI traces. Prompt/output capture and provider trace export need a separate content and residency decision. |
| Toolbar, Web scripts | Partially applicable | The public site emits the required web events through Rally's first-party reporter; it does not install PostHog's generic browser script, Toolbar injection, autocapture, or replay. Electron remains inapplicable. |
| Skills | No capture dependency | This is a PostHog operator/agent capability and consumes the project's existing data model. |

The compatibility rule is strict: use a PostHog reserved event only when Rally
observed the same thing and can provide its required properties. Never duplicate
one occurrence under a custom and reserved name, and never manufacture a flag
exposure, survey response, replay, pageview, trace, log, or AI generation to make
a product appear configured.

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
absolute paths, and unsanitized values remain in Rally. EU keeps the full
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
- **Only the per-login epoch performs an anonymous history merge.** The random
  installation ID may appear as PostHog `$device_id` for SDK-compatible device
  attribution, but it is never used as `$anon_distinct_id`, entered in Rally's
  identity-link table, or exported across regions; conflating these roles would
  merge login journeys or residency histories.
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
approval, advertising, consent-law determinations, cross-site identity, or
public-site analytics. The public site remains unchanged. Product analytics are
advisory and may be incomplete; regional product authority is canonical — D1
for workspace/control data and, after its guarded cutover, the owning
WorkstreamDO for work-stream product data.

## Failure modes and limits

- The pre-renderer route request times out after two seconds and falls back to
  Global; an affirmative EU result creates no pre-region dump.
- The authenticated Product analytics preference read times out after 15
  seconds. Until it succeeds, nonessential collection remains disabled for the
  launch; the timeout never falls back to the device's cached opt-in.
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
- Global analytics lakehouse handoff is unretractable in the current design. A
  late opt-out, user cascade, or D1 expiry does not delete a current Iceberg row;
  the projected deadline and registry retention fields are metadata until an
  automated transactional Iceberg deletion engine exists.
- A destination outage backs off to the immutable deadline and opens a five-minute
  circuit after five consecutive transient failures. The product action is not
  retried or failed because telemetry is unavailable.
- A caught renderer transport failure keeps its normal user-facing `network_error`
  behavior even when the preload bridge or regional telemetry endpoint is
  unavailable. Diagnostic delivery never retries the product request. Repeated
  failures at the same sanitized frame emit at most once per five minutes per app
  launch, and Product analytics opt-out suppresses that report completely.
- Opt-out cannot synchronously stop Electron's already-running Crashpad handler.
  It stops upload and invalidates the generation immediately; restart purges that
  generation before a new handler can start.
- Raw crash access is by opaque crash ID, region-restricted, reason-coded, and
  audited. A missing raw object returns a fixed result and never exposes its key.

## Testing

Run focused suites from their package directories:

```bash
pnpm --filter @rally/contracts test
pnpm --filter @rally/db test
pnpm --filter @rally/api exec vitest run test/telemetry-collector.test.ts test/telemetry-delivery.test.ts test/posthog-adapter.test.ts test/tool-usage-telemetry.test.ts test/crash-processing.test.ts test/crash-operations.test.ts
pnpm --filter @rally/api test:crash-symbolicator-container
pnpm --filter @rally/desktop exec vitest run src/renderer/lib/api.test.ts src/renderer/lib/telemetry.test.ts src/main/javascript-error-candidate.test.ts src/main/telemetry-reporter.test.ts src/main/product-analytics-settings.test.ts src/main/native-crash-generation.test.ts src/main/native-crash-uploader.test.ts
pnpm --filter @rally/desktop test:release
pnpm --filter @rally/desktop test:crashpad
pnpm --filter @rally/site test
pnpm --filter @rally/site build
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
destination circuit state live in regional D1. Global accepted rows also carry
the independent analytics-lakehouse pointer state; no second envelope copy is
stored. `telemetry_eu_events` is the EU
query projection with release/platform/channel/correlation dimensions.
Public-site Global epochs reuse the journey table; the content-free, signed
route probe does not create a row. Its short-lived token is not persisted as
identity or authority. EU site epochs are page-scoped and therefore do not join
separate page loads.

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
schemas and fixed allowlists run at every hop. Direct account, user, and
workspace-identity database IDs never become destination identities or event
properties. Closed semantic events
may carry an opaque resource UUID for a work stream, message, note, automation,
run, or invocation when the registry requires it for analysis. Verified
email/name and workspace name
appear only in eligible Global profile/group jobs so approved staff can identify
and contact users; they are not copied onto events or crashes.

The batch installation ID is authoritative for desktop device attribution. If
an envelope supplies `context.deviceId`, both authenticated and capability ingest
require it to equal that batch value before persistence; the desktop includes the
installation ID on anonymous product batches as well as installation-health
batches. A client cannot attach one person's event to another device profile.

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

### 2026-08-25 — Cold-open telemetry names the socket snapshot

**What changed:** `workstream_feed_visible.feedSource` now accepts
`socket_snapshot`, and a cold reader populated by its first SubstreamAgent frame
reports that source. `feed_cache` remains the already-present path, while
`boot_payload` and `legacy_page` describe explicit REST recovery.

**Why:** The normal reader no longer issues the detail request. Labeling a
socket-populated feed as an HTTP boot or rollout fallback would make the new
critical path indistinguishable from the recovery path when diagnosing its
P90.

**Considered and rejected:** Reusing `boot_payload` because both shapes contain
canonical boot state. That name would preserve schema compatibility by hiding
the transport distinction the performance question needs.

**Consequences:** Existing analytics consumers must include the new enum value.
Cold-open queries should select `socket_snapshot` and join through the opening
operation and socket lease; REST cohorts remain separately queryable. The event
still contains no message content, URL, or authorization value.

### 2026-08-25 — Send readiness is measured independently from feed visibility

**What changed:** Added `workstream_send_ready` under the sidebar opening
operation ID. It measures click-to-painted-composer time once the active
work-stream handler can submit to the workspace command queue and records that
socket's connecting, connected, or reconnecting state.

**Why:** A painted feed is the requested opening milestone but cannot prove a
separately named ability to send. The composer usually commits beside the feed,
and the command socket accepts sends while reconnecting, yet an analytics query
should not have to infer that lifecycle boundary from two adjacent pieces of UI.

**Considered and rejected:** Reinterpreting `workstream_feed_visible` as send
readiness would turn a precise paint event into an undocumented proxy. Waiting
for the workspace socket to connect would be equally false: client readiness is
queue acceptance, while server acknowledgement belongs to the existing message
send flow.

**Consequences:** Feed paint and client send readiness can be compared under one
attempt ID without timestamp joins. `workstream_send_ready` is success-only and
does not replace the terminal opening outcome denominator; it contains no draft,
message, URL, or server response.

### 2026-08-25 — Route abandonment and retries cannot corrupt opening latency

**What changed:** A click attempt now terminates as `abandoned` when navigation
leaves its work stream for another surface, its owning workspace is replaced by
a service-error screen, or its owning session ends. Painted
feed reporting reschedules after an effect cleanup without re-latching data
readiness, which preserves the terminal event under React StrictMode and any
production dependency change inside the two-frame window. Detail retries now
mint distinct request IDs while carrying the click ID as the existing Rally
operation header. The event registry, rather than desktop IPC alone, enforces
that data-ready time cannot exceed painted time.

**Why:** An interrupted load could stay in the renderer singleton and make a
later 60 ms return look minutes long. Separately, cancelling the first scheduled
paint consumed a one-shot latch and left no second schedule, which lost both the
success event and terminal outcome. Reusing the click ID as every retry's
request ID also collapsed multiple HTTP attempts in the exact slow tail this
instrumentation needs to explain.

**Considered and rejected:** Treating non-sidebar navigation as `superseded`
would claim another work stream caused it; treating it as `load_failed` would
claim a service failure. WorkstreamScreen unmount cleanup was also rejected
because StrictMode deliberately simulates that cleanup without the reader
leaving. Route, workspace-error, and session observation represent the actual
abandonment. A
single repeated request ID was rejected because the tracing contract defines it
per call; the operation header already carries the longer click lifetime.

**Consequences:** Every accepted sidebar click has one terminal outcome, retries
remain individually diagnosable, and queries must treat `abandoned` separately
from rapid work-stream switching and load failure. UUID, consent, content, and
Global-versus-EU boundaries are unchanged.

### 2026-08-25 — Opening attempts and pooled socket leases have explicit lineage

**What changed:** Added `workstream_open_started` and terminal
`workstream_open_outcome` events under one click-scoped operation ID. Rapid
switches emit `superseded`; query failures emit `load_failed`; painted feeds emit
`visible`. Each retained socket owner now has one socket-lease ID shared by its
control and feed starts. Socket-start events retain their per-attempt request ID
and additionally carry the lease plus the pending opening ID when one exists;
opening events record the lease that served them.

**Why:** Work-stream and launch IDs were too broad, while the earlier operation
ID survived only on successful feed paint and the detail request. Replacing a
pending A measurement with B prevented misattribution but erased A, and the
separate socket request IDs could not connect a click to socket work. Pooled
sockets made parent-only correlation incomplete because a hover-warmed or
retained connection can legitimately begin before the click that consumes it.

**Considered and rejected:** Treating rapid switches as duplicate delivery
would confuse user cancellation with ingestion retry; `eventId` already handles
the latter. Reusing one operation ID for socket attempts and the click would
collapse distinct ticket requests. Adding only the opening ID to socket starts
would still strand pre-click warmups. The lease-plus-attempt model preserves
both the pooled lifetime and each actual request.

**Consequences:** One opening attempt has exactly one started event and at most
one terminal outcome; the feed metric remains success-only while the outcome
event supplies its denominator. Socket volume still counts every actual start.
The identifiers are opaque UUIDv7 values governed as operational Product
analytics, with the existing opt-out and Global-versus-EU routing unchanged.

### 2026-08-25 — Sidebar-to-painted-feed latency and every work-stream socket start are measurable

**What changed:** Added `workstream_feed_visible`, emitted after a sidebar click
has committed its initial transcript and crossed one browser paint, with exact
total and data-ready milliseconds plus cache, pool, feed-source, sidebar, and
message-count dimensions. The click-scoped operation ID is reused as the detail
request ID. Added `workstream_socket_started` at the two work-stream socket
loops before every ticket request; it records control/feed kind, initial or
reconnect reason, retry bucket, and a matching operation/request ID.

**Why:** `workstream_opened` proved only that detail eventually loaded, local
perf lines died with the renderer, and socket-connected events began after the
initial feed gate. None could calculate average or percentile click-to-feed
latency, split data wait from paint delay, distinguish a cold open from a
hover-warmed control socket or retained pair, or count starts whose ticket or
handshake never succeeded. The user explicitly required this production
measurement and required pooled sockets and every start reason to be visible.

**Considered and rejected:** Duration buckets cannot produce averages or P50,
P75, P90, and P99. Joining `workstream_opened` to clicks by timestamp is
ambiguous during rapid navigation. Treating a warmed control socket as a warm
feed is false: hover opens no SubstreamAgent connection or presence. Reporting
only successful socket connections omits ticket and handshake failures, while
instrumenting each pool caller would miss reconnects and future admission paths.
Direct renderer-to-PostHog capture was rejected because it bypasses consent,
regional routing, validation, and the durable spool.

**Consequences:** These remain Product analytics: opted-out accounts emit
neither; Global events can reach PostHog and the Global lakehouse, while EU
events remain on the regional internal path. Exact milliseconds are an explicit
exception to the usual coarse product-duration vocabulary because the approved
question is a percentile distribution; the schemas stay closed and retain no
content. Paint latency covers successful sidebar opens only; the newer
opening-outcome contract above supplies the attempt denominator. Socket-start volume counts
attempts, not unique sockets, and reconnect storms are intentionally visible.
`feed_cache` is authoritative whenever the transcript query already held data;
such an open correctly has no matching detail request even though its
interaction operation ID remains present. A `socket_snapshot` open likewise has
no detail request: join its opening ID and socket lease to the socket-start and
connection events instead.

### 2026-08-25 — The envelope schema identifier is ai.rallywith.telemetry.event

**What changed:** `TELEMETRY_ENVELOPE_SCHEMA` is `ai.rallywith.telemetry.event`.
`SUPERSEDED_TELEMETRY_ENVELOPE_SCHEMAS` now carries two entries —
`com.rally.telemetry.event` and `com.avalon.telemetry.event` — and the envelope
parser accepts all three.

**Why:** `com.rally` matched no domain the company owns; `ai.rallywith` matches
the desktop bundle id `ai.rallywith.desktop`, so the reverse-DNS identifier and
the bundle it ships in agree. The entry below it stays as written: `com.rally`
really was minted, a spool on disk can still hold it, and rewriting that entry
to name the current spelling would erase the reason the superseded list has two
entries rather than one.

Also repaired a regression from the same day's span-attribute rename, which
rewrote the superseded entry into a copy of the canonical one and would have
made the reader reject every envelope from an installed build. The test that
should have caught it looped over the constant, so it asserted only that the
current identifier parses — always true, however the constant is spelled. It
now names the superseded spellings as literals and asserts the canonical is
*not* among them.

### 2026-08-25 — Product event names and the app namespace are Rally

**What changed:** The `avalon_*` product event names are `rally_*`, and the
PostHog `$app_namespace` is `app.rally.desktop`.

**Why:** The rename. This one is not self-contained: PostHog dashboards, saved
insights, and cohorts still query the Avalon names, and nothing in this
repository can alias them — that is a destination-side change, recorded in
[`rally-rebrand-inventory.md`](rally-rebrand-inventory.md) as outstanding.
Rejected: emitting both names for a transition period, which doubles event
volume and leaves every count ambiguous while it runs. A future change that
renames an event has the same obligation to say what breaks at the
destination.

### 2026-08-25 — The envelope schema identifier is com.rally.telemetry.event

**What changed:** `TELEMETRY_ENVELOPE_SCHEMA` in
`packages/contracts/src/telemetry.ts` is `com.rally.telemetry.event`, and every
producer reads it rather than writing the literal. The envelope parser accepts
`com.rally.telemetry.event` alongside it. The anonymous crash capability header
became `x-rally-telemetry-capability`, read through `readRallyHeader` so the
superseded spelling still resolves.

**Why:** The identifier is validated with a literal, and the desktop spools
envelopes to disk before sending. A spool written by the previous build and
drained by the next one would have failed validation and been discarded — so a
straight rename would have silently eaten every queued event across every update,
which is indistinguishable from a quiet period. The same reasoning covers the
capability header: it is minted by an installed build.

**Considered and rejected:** Renaming the PostHog event and property names
(`avalon_*`) in the same change. They are one edit away, but every dashboard,
funnel, and saved insight keys on them, so the rename splits the history at its
date. That is a product-analytics decision about whether to backfill or accept
the seam, not an engineering one, and it is not blocking the rebrand.

**Consequences:** Nothing writes the schema literal any more; a future version
bump is one edit to the constant plus an entry in the superseded list. The
superseded identifier is removed only when no spool old enough to hold one can
still drain, which is a decision about shipped builds rather than about this
repository.

### 2026-08-24 — Lakehouse delivery fails terminally only when retry cannot help

**What changed:** The analytics projection now recomputes accepted-row integrity,
marks permanent poison rows rejected, recovers queued as well as pending work,
uses its partial index newest-first, and starts with new events instead of a
historical backfill. The catalog's unretractable retention boundary is explicit.

**Why:** Review found that schema evolution and stored-row corruption would burn
Queue retries, a DLQ transition could strand a queued outbox row forever, and
the backfill could put live failures behind months of history. Review also
proved that regional D1 deletion cannot retract an Iceberg projection.

**Considered and rejected:** Treating every throw as transient, guessing a stale
lease interval, and describing snapshot expiration as row retention. Replaying
both durable states is safe under at-least-once semantics, while snapshot
expiration only removes files made unreferenced by a separate row mutation.

**Consequences:** `event_id` remains the logical deduplication key, historical
accepted rows are not projected, and catalog retention fields remain metadata
until an automated transactional deletion path is selected.

Shipped in the pull request for this change. See
[`analytics-lakehouse.md`](analytics-lakehouse.md).

### 2026-08-24 — Accepted events feed a governed Global analytics lakehouse

**What changed:** The regional collector now seeds an independent Global
lakehouse outbox after acceptance. A Queue pointer consumer projects every
promoted dimension plus the complete validated context/properties into the
Global `avalon.analytics_events` table; EU remains on its existing internal
path.

**Why:** Backend and client producers already share one typed, preference-aware,
region-aware acceptance point. Projecting there preserves those controls and
makes maximal admitted metadata durable without adding direct client-to-vendor
authority.

**Considered and rejected:** A second analytics ingestion endpoint, direct
renderer Pipeline access, arbitrary autocapture, and reusing raw inference
storage. Each weakens policy or mixes incompatible privacy contracts.

**Consequences:** New event fields continue to be governed in
`TELEMETRY_EVENTS`; adding arbitrary content remains prohibited. Global delivery
failure is recovered asynchronously and never changes product behavior. EU
debugging never falls back to the Global table.

Shipped in the pull request for this change. See
[`analytics-lakehouse.md`](analytics-lakehouse.md).

### 2026-08-24 — One drop is one event, whichever listener sees it first

**What changed:** The substream feed's `resync_required` branch arms its cause
only when a close is still coming, and reports nothing itself. Every `error`
listener in the four loops now checks socket identity before arming a cause.

**Why:** Review on #271. `readyState` reaches CLOSED before the `close` event is
dispatched, so a resync frame delivered in the same task batch as an abrupt close
reached a branch that reported the drop *and* left the close listener to report
it again — one transition, two events, the second labelled `server_closed`
because the cause had already been consumed. The `error` listeners were the
mirror image: the pending cause belongs to the loop rather than to one socket, so
an error for a superseded socket armed `transport_error` on the live one and
mislabelled its next drop. Neither could be demonstrated from outside, and both
corrupt a measurement rather than costing a reconnect, which is the failure mode
worth paying a line to close.

**Consequences:** The rule for the producer is now uniform: a cause is armed only
by the site that is about to close a socket that will still report, and every
listener that writes one first proves the socket is the live one.

### 2026-08-24 — The intent allowlist is tested by running it, and offline is not a transport error

**What changed:** `parseTelemetryProductIntent` and the UUID pattern beside it
moved out of `main/index.ts` into `main/telemetry-intent.ts`, with a suite that
runs the parser. Every socket loop now re-checks `navigator.onLine` after its
ticket resolves and reports `offline` there.

**Why:** Both came out of review on #271. The allowlist decides whether any
renderer event reaches the reporter at all, and it was covered by a test that
matched the source text of `index.ts` — which passes on a build whose dispatch is
broken and fails on one that was merely reformatted. The entry point cannot be
imported by a test because importing it starts Electron, so the function moved to
where it can be called. Separately, a client that goes offline while its socket
ticket is in flight leaves the offline handler nothing to close; three of the four
loops then dialled anyway and recorded the failure as `transport_error`, which is
precisely the distinction this event was added to make.

**Considered and rejected:** Keeping the source assertion and noting the
limitation in the pull request, which is what the first version did. The
repository's own testing rule is that an assertion which survives breaking the
code is not coverage, and this one would have.

**Consequences:** `main/index.ts` no longer holds the validator, so a new
renderer event is admitted in `telemetry-intent.ts` and gets a case in its suite
rather than a string match. The offline re-check also changes product behaviour
very slightly: those three loops no longer dial a socket they know will fail, and
wait for the `online` event exactly as they already did when they started offline.

### 2026-08-24 — HyperSight's per-block sockets join the same contract

**What changed:** `block_dashboard` is a fourth value in
`TELEMETRY_REALTIME_SOCKETS`, and `use-block-dashboard-sockets.ts` reports
through the same producer, one instance per block connection.

**Why:** It was left out of the first pass because it is shaped differently —
one loop holds N sockets, one per configured block, rather than one per screen —
and that difference needed a decision rather than a copy. The decision is that
the socket kind is the unit, not the block: the event names no block, so a
dashboard's six connections aggregate into the drop rate for this kind. Leaving
it uninstrumented would have made the other three look like the whole picture
while the noisiest, shortest-lived sockets in the client went unmeasured.

**Considered and rejected:** Adding a block ID so a single flapping block could
be found. It is an opaque UUID the registry would permit, but it answers a
debugging question, not a product one, and every block on every dashboard would
carry one into the destination for the life of the retention window.

**Consequences:** Volume scales with configured blocks rather than with screens,
which is the one place this event could grow faster than the surfaces around it;
if that becomes a cost, the sample rate on this contract is the lever, not the
call sites. Dictation remains outside the contract, and adding it would need a
fifth registry value and a decision about an audio transport whose failures are
not the room's.

### 2026-08-24 — The three realtime sockets report their own connections

**What changed:** A `realtime_socket_state` contract, and one producer —
`renderer/lib/socket-telemetry.ts` — instantiated per live socket loop by the
workspace, WorkstreamDO-control, and SubstreamAgent-feed hooks. Each reports a
connection, a drop with its bounded cause, and whether anything is scheduled to
bring the socket back, with the retry depth as a count bucket.

**Why:** Nothing measured whether a client stayed connected. A work stream's
sidebar row went stale for a member who never opened it, and the first question —
did the push miss that client, or was there no push — could not be answered from
anything Rally collects: the perf trace covers one socket's open latency, and
the room's own admission logs cannot tell a first connection from the fourth
attempt of a reconnect. The renderer is the authoritative source for the same
reason: only it holds the retry counter, the heartbeat, and the offline
transition. Bucketing the count keeps a reconnect storm from becoming
high-cardinality, and rules out a client-supplied number entering the destination
at all.

**Considered and rejected:** Emitting it from the API at socket admission, which
needs no new renderer path — but a Durable Object sees an upgrade, not an
attempt, and cannot distinguish a client reconnecting for the fourth time from
four clients connecting once. Also rejected: registering it `essential` so it
survives an opt-out, the way the lifecycle and crash signals do. Those are the
signals needed to keep the application working at all; socket churn is a product
reliability question that aggregates fine over people who opted in, and an event
that fires whenever a work stream is opened is not something to place outside the
preference. The category can widen later; what was collected under an opt-out
cannot be taken back.

**Consequences:** Socket drop rates are visible per socket kind, and
`resync_required` — the room telling a client its cursor is beyond replay — is
now a first-class cause rather than an indistinguishable drop. Any further socket
must add its own value to `TELEMETRY_REALTIME_SOCKETS` before reporting rather
than borrowing one of these three — the entry above did exactly that for
HyperSight — and any new close path has to name its cause through `willClose` or
it will be counted as the server's.

### 2026-08-20 — Global Worker telemetry is exported to PostHog, traces included

**What changed:** `wrangler.global.jsonc` names two account-level OTLP
destinations — `posthog-logs` for Workers Logs and `posthog-traces` for
automatic tracing — both pointing at the US PostHog project's `/i/v1/logs` and
`/i/v1/traces` ingest. `persist` is left at its default, so Cloudflare keeps its
own copy and the export is an addition rather than a redirection. The EU
Worker's config names no destination and is unchanged; a comment there now says
that adding one *is* the decision this entry records, so it cannot be made by
accident.

**Why:** The traces shipped in #203 answer "which step was slow" only for
whoever is looking at Workers Logs at the time. Putting them where the product
events already are means one place to ask both halves of the question, and the
analytics surrogates on each span are what join them.

**The cost, stated plainly:** *PostHog now receives Customer Content.*
Cloudflare's automatic Durable Object SQL spans carry
`cloudflare.durable_object.query.bindings` — the bound parameter values — and
`WorkstreamDO` binds work stream titles, descriptions, and previews into
`workstream_metadata`, and a serialized effect envelope into `durable_outbox`,
through exactly that API.

Review narrowed this from the first draft, and the narrowing is worth keeping:
message *text* rows are written to D1, not to embedded SQLite, and a D1 span
carries `db.query.text` without its bindings. So the exposure runs through
titles, descriptions, previews, and outbox payloads rather than through the
`messages` table, and `SubstreamAgent` — named here originally — writes external
ids, run state, and error codes rather than content. Narrower than it first
read. Still Customer Content, and still the reason this entry exists. Cloudflare documents no attribute filtering or
redaction, so this is not a gap to be closed later by configuration; it is a
property of exporting these traces at all. PostHog is therefore a processor of
message content, which is a subprocessor and DPA question rather than an
observability one, and it is owed the treatment those get.

**Identity was settled explicitly, not left to the destination.**
[`performance-tracing.md`](performance-tracing.md) requires this to be decided
before an export: map through the analytics ids at the exporter, or keep the
attributes opaque and never promote them — but never let the destination's
default decide. Spans now set `posthog.distinct_id` to
`users.analytics_person_id`, which takes the first way out. Without it a
destination that read `user.id` as its person key would key the same human
differently from the product pipeline and split them into two people, which is
the failure `performance-tracing.md` describes and the surrogates exist to
prevent. The attribute is absent when the surrogate is.

*The residual risk is documentation, not design:* PostHog does not document what
its OTLP trace ingest does with `user.id` or `session.id`. Setting the key we
want explicitly makes that moot for persons, but `session.id` on our spans is
the **Rally auth session**, a different object from PostHog's `$session_id`,
and nothing has verified that PostHog ignores it. Re-check if session-stitched
figures ever look wrong.

**The 15-day sub-processor notice was considered and does not gate this.**
`apps/site/subprocessors/index.html` promises customers 15 days' notice before a
new sub-processor begins processing, and the DPA authorizes only the providers
on that page — where PostHog was missing, despite already receiving product
telemetry. That gap predates this change; what this change does is widen the
category to Customer Content. It is not gated because Rally has no customers
yet, so there is no party the notice period protects and no objection window to
run. PostHog is listed on that page as of this change, before the position
becomes load-bearing. **Once there are customers, this ordering stops being
free** and a comparable escalation needs the notice period served first.

**Considered and rejected:** *Lowering `head_sampling_rate` to reduce exposure.*
Sampling changes how many traces carry content, not what a sampled trace
carries, so it buys no privacy and costs diagnostic value; full sampling is kept
for that reason rather than by default. *Exporting logs only.* The structured
logger redacts, so logs alone would have been the conservative option, and the
`perf_flow` rows would still have carried the whole step breakdown — but that
gives up the span waterfall, which is the part a trace is for. *Redacting at the
destination.* There is no hook: the attribute is attached by the platform before
anything of ours runs.

**Consequences:** The boundary this document defends is now narrower than it
was: it holds for the EU region, and for Global it holds only up to the trace
destination. Anything that would widen what a Durable Object writes through
embedded SQL now also widens what PostHog receives, with no review step that
would flag it as a logging change. If Cloudflare ships attribute filtering, this
is the first thing that should use it.

Shipped in #207.

### 2026-08-20 — Account preference verification receives a cold-network deadline

**What changed:** The desktop's authenticated Product analytics preference GET
now uses the same 15-second bounded network budget as its preference mutation,
instead of aborting after one second. The launch still fails closed until the
canonical regional response is validated.

**Why:** Every tested production launch aborted the verification at exactly one
second. A signed-in cold request can include DNS, TLS, Worker activation, and a
regional D1 lookup; one second was shorter than that normal path, so a healthy
service looked unavailable and Product analytics remained unverified for the
entire launch.

**Considered and rejected:** Trusting the locally cached opt-in on timeout would
weaken the account-scoped privacy boundary. Removing the timeout would let a
hung connection remain live indefinitely. Fifteen seconds matches the
already-shipped PATCH path and keeps the request bounded. Awaiting that entire
budget before creating the first window was also rejected: launch gives the
verification two seconds, then lets the same caught promise finish in the
background while collection remains fail-closed.

**Consequences:** A slow or unavailable preference service can delay the first
window by at most two seconds. The network request still gets its full 15-second
cold-start budget after the window opens, and its eventual validated result is
broadcast normally. If it does not finish before telemetry initialization,
native crash collection stays off until the next launch; product analytics can
become effective when verification completes. New startup preference reads must
budget for cold network activation without falling back to cached enablement or
putting their entire request deadline in front of the first window.

### 2026-08-20 — The analytics surrogates gain a second reader

**What changed:** Nothing about how `users.analytics_person_id` and
`workspaces.analytics_workspace_id` are minted, stored, or delivered. They are
now also read on the session query that authenticates an HTTP request, and set
on system traces as `rally.analytics.person_id` and
`rally.analytics.workspace_id`. A Durable Object reads only the workspace
surrogate, from a table it already joins — see
[`performance-tracing.md`](performance-tracing.md#joining-a-system-span-to-a-product-event).

**Why:** A slow trace and the product events for the same session could not be
matched. The surrogates are random and their mapping to the product ids lives
only in this region's D1, so answering "what was this person doing when it was
slow" required a manual database join every time.

**Considered and rejected:** Sending the raw `users.id` to PostHog as a person
property and joining there instead. It is cheaper — one `$set` per person rather
than two attributes per span — but it reverses this document's standing
decision that product ids do not reach PostHog, in order to save work on a path
that is not hot. The linkage is carried on the trace side, where raw ids already
are.

**Consequences:** These two columns now have a consumer outside this subsystem,
so their lifecycle is no longer purely a telemetry concern: a change to how they
are minted, rotated, or cleared has to consider traces as well. Nothing about
their authority changed — nothing authorizes on them in either subsystem. Note
that a trace now carries both a product id and its surrogate together, so the
separation this document maintains holds only as far as the trace destination:
exporting traces to a third party hands that party the mapping.

Shipped in #203.

### 2026-08-20 — One warmed builder serves every symbolicator build

**What changed:** CI and the API deployment now warm a shared `docker-container`
BuildKit cache with `docker/build-push-action` before anything builds the
symbolicator image, and the builds that follow name no cache at all. The
integration script lost its `AVALON_CONTAINER_CACHE_FROM`/`_TO` plumbing and
passes `--load` unconditionally, and `deploy-api.yml`'s deploy job gained the
same warm-up so Wrangler's own container build stops recompiling
`minidump-stackwalk` from source on every release.

**Why:** The earlier arrangement handed the cache flags to the integration
script and never worked. The `type=gha` backend authenticates with
`ACTIONS_RUNTIME_TOKEN`, which the runner injects into JavaScript actions and
never into a `run:` step, so a cache driven from inside the script imported and
exported nothing — and `docker build --quiet`, whose output the script captures
and discards on success, hid every miss. Two consecutive `main` runs an hour
apart each spent about four minutes on the same pinned crate, which is what the
cache was added to stop. The deploy job had no cache at all, because Wrangler
drives that build itself with a fixed `docker build` line that accepts no cache
flags; the layer it rebuilt is the same one, and the whole cost of the image.

**Considered and rejected:** Exposing `ACTIONS_RUNTIME_TOKEN` to the `run:`
steps with a third-party runtime-export action — it would keep the cache flags
where they are, but adds another publisher to a workflow that holds the
Cloudflare deployment token, to solve a problem an action Docker already
publishes does not have. Also rejected: teaching Wrangler's build about the
cache. It builds with a fixed command and takes no such option, so the only
lever on it is which builder its `docker build` resolves to.

**Consequences:** `install: true` on `docker/setup-buildx-action` is now
load-bearing in both workflows — without it the plain `docker build` that
follows runs on a different builder and misses the warm cache entirely. So is
`load: true` on the warm-up: a remote cache import is lazy and scoped to the
solve that imported it, so only materializing the image leaves layers a later,
separate build can reuse. The first version of this change used
`type=cacheonly`, on the reasoning that the warm-up needs no image, and the
second CI run measured what that costs — every vertex `CACHED` in 2.4s,
followed by a full recompile in the lane that came next. The warm-up must stay
a JavaScript action for the token to reach the cache backend.
The `crash-symbolicator-container` lane owns the `crash-symbolicator` scope and
is the only step that exports to it; the deploy job imports from it and has
always run after that lane. A build that has to be observed still needs
`--quiet` dropped from the script, which captures and discards docker's output
on success.

Shipped in the pull request for this change.

### 2026-08-13 — Connector telemetry negotiates one correlated contract version

**What changed:** Current desktop connector starts emit only the rich V2 intent,
carry its operation ID plus an explicit query version marker, and persist a
closed setup shape on the OAuth attempt. The terminal API event uses that same
version and operation ID for success or failure. Marker-less released clients
continue to receive only the V1 outcome.

**Why:** Emitting V1 and V2 for the same setup action double-counted one person
journey, while emitting V2 only after success omitted the exact failures the
funnel is meant to explain.

**Considered and rejected:** Emitting both versions during migration, inferring
missing failure dimensions after OAuth returns, and dropping the legacy outcome
immediately. Those corrupt counts, fabricate context, or strand released-client
funnels. A new header was also rejected because API and desktop deployments can
race: an older Worker safely ignores the query marker, whereas Chromium would
block an unknown header at CORS preflight and prevent connector setup itself.

**Consequences:** A connector attempt owns one immutable telemetry contract
version. New connector versions must negotiate at request admission and persist
every terminal property needed later; PostHog queries never union V1 and V2 for
one attempt.

### 2026-08-13 — Shutdown and automation attribution use authoritative boundaries

**What changed:** Desktop quit is held once while graceful lifecycle and session
events enter the spool and one bounded flush runs; a 750-ms deadline always
resumes exit. Run and tool events attach automation metadata only when the
harness run has an automation origin and the work stream points to that exact
automation run.

**Why:** Electron does not await promises started from `will-quit`, and a work
stream can contain later person-initiated runs after automation created it.
Without these boundaries, normal-exit events disappeared and manual activity
was mislabeled as automation activity.

**Considered and rejected:** Fire-and-forget shutdown writes, an unbounded quit
delay, and inferring run ownership from any automation row on the work stream.
Those respectively lose events, harm shutdown, or corrupt attribution.

**Consequences:** New shutdown telemetry belongs inside the bounded barrier, and
new automation dimensions must be proved from the specific run rather than the
container that happens to hold it.

### 2026-08-13 — Review closes systematic overcount and misattribution paths

**What changed:** Redirect-only `/` no longer reports a duplicate home surface;
reused running Terminal sandboxes no longer report starts; native navigation
carries a proven source; released suggestion clients retain a legacy home
fallback; public dynamic paths and invalid handoffs use bounded truthful
classes; and digest telemetry cannot interrupt settlement.

**Why:** Each issue produced structurally plausible events, so schema validation
could not detect the corrupted count or attribution. The authoritative producer
already knew the missing transition, source, compatibility, or canonicalization
fact.

**Considered and rejected:** Dashboard deduplication and downstream repair.
Those approaches encode product behavior in provider queries and cannot recover
the omitted source or distinguish a true later transition.

**Consequences:** Producers must emit only real transitions, redirect routes do
not own observations, optional old-client context has an explicit fallback, and
privacy canonicalization runs before the envelope is built.

### 2026-08-13 — Public-site bootstrap is bound to its pre-identity route

**What changed:** Global now signs the coarse public-site route probe and
bootstrap consumes that exact short-lived decision. A different Cloudflare
country on the second request cannot re-route the selected anonymous epoch, and
an existing conflicting journey is rejected.

**Why:** Region-before-identity is only true when the decision that controls
browser storage is also authoritative at persistence. Two independent edge
classifications left a race during network changes.

**Considered and rejected:** Browser-only response comparison, which detects the
problem after persistence, and a persistent region cookie, which would create
another residency-bearing browser identifier.

**Consequences:** The public route response and site bootstrap request share a
strict signed-token contract. Desktop's one-request bootstrap remains unchanged,
and route-token failures stay isolated from page behavior.

### 2026-08-13 — Pico-level journeys use authoritative outcomes without duplicate events

**What changed:** Expanded the closed registry and producers across surfaces,
suggested work, collaboration, resources, messages and elicitations, HyperSight,
Terminal, automation authoring, recordings, root runs, tool outcomes, connectors,
digests, invitations, and the public acquisition path. Where a richer contract
replaces the same semantic observation, current producers choose it once and
legacy contracts stay readable for released clients. Distinct request/outcome,
admission/terminal, and resource/outcome observations keep separate event names.
Authenticated product surfaces no longer also emit the legacy screen event, so
one navigation becomes one PostHog `$screen`.

**Why:** Coarse screens and operation outcomes showed traffic but not the steps
that explain whether people discover, configure, complete, reuse, or recover
from the product's core workflows. Emitting both old and richer signals for one
occurrence would make the new detail useful only by corrupting totals.

**Considered and rejected:** DOM/keyboard autocapture, provider-content capture,
client-reported server success, event-per-connector multiplication, arbitrary
properties, and deleting legacy readers immediately. Those alternatives lose
semantic authority, expose content, or break rolling clients.

**Consequences:** Resource UUIDs and closed taxonomy values enable joins while
titles, messages, arguments, outputs, tokens, and provider account identifiers
remain prohibited. New journeys must declare their single authoritative producer
and prove no parallel legacy/reserved destination event is emitted. Public-site
regional and identity behavior is owned by
[`public-site-telemetry.md`](public-site-telemetry.md).

### 2026-08-13 — Work-stream creation moves to its authoritative server boundary

**What changed:** Replaced the renderer-produced `workstream_created` event with
one idempotent API event emitted by every user-visible creation path. The event
records a closed creation source and derives current work-stream state from D1.
Slack and connector-activity paths supply their canonical connector type;
suggested work resolves every distinct connector type from its retained
provenance roots. User-owned creations retain the person and workspace group;
unmapped Slack and workspace-owned automations remain personless workspace
events.

**Why:** The renderer could observe only composer and suggested-work responses.
It missed Slack and background automations entirely and could not truthfully say
which connector caused creation. Adding a second connector-only event would have
made creation totals depend on which path fired and corrupted funnels.

**Considered and rejected:** Client-supplied connector labels, provider account
or connection IDs, one event per connector, and parallel client/server creation
events. Those alternatives trust the wrong boundary, create high-cardinality
identity data, multiply a single creation, or double-count desktop paths.

**Consequences:** The work-stream UUID is the stable event identity; legacy
UUIDv4 work streams receive a deterministic UUIDv7 insert-id projection without
changing the resource ID. A suggested-work start uses its opportunity UUID as
its idempotent event identity, so it cannot collide with the companion creation
event. A new creation path must
choose one closed source, resolve connector types from server-owned provenance,
and emit only after the durable work-stream write. API-authored events must use
the internal emitter; the authenticated desktop batch route rejects them.

### 2026-08-13 — Resource journeys and tool adoption become semantic events

**What changed:** Added typed successful-operation events for work-stream
creation/open/switch/menu actions, automation creation/menu actions, message
send, resource copy, note creation/open/actions, and transcription state. The
regional harness now records every durably admitted canonical tool invocation
with resource correlations and a personless workspace scope for unattended
execution.

**Why:** Screen and API-operation signals could show entry and outcome totals but
could not reconstruct the core resource journey or tell which agent capabilities
were actually used. Product analysis also needs stable joins from a copied
output, note, or automation back to its work stream.

**Considered and rejected:** DOM autocapture, click-before-result events, treating
tool availability as usage, inventing a user for workspace automations, and
capturing messages, clipboard values, tool arguments, outputs, or summaries.
Those alternatives respectively create ambiguous events, false completions,
person-profile corruption, or content exposure.

**Consequences:** Approved opaque resource UUIDs are product properties, while
account/user identity IDs and all resource content remain prohibited. Completion
events fire only after the product operation succeeds. Workspace-owned tool
events group in PostHog without person processing, and EU keeps the equivalent
events internally.

### 2026-08-13 — Application opens carry a proved entrypoint

**What changed:** Cold starts and explicit reopens now emit a closed
`application_opened` signal with entrypoint and phase. A short main-owned
coalescer lets an accepted deep link or menu action override Electron's generic
activation callback. The Global adapter maps this event—not the separate
reliability transition—to PostHog's canonical `Application Opened` with
`application_open_source` and `from_background`.

**Why:** Lifecycle data answered whether the process opened, but not whether a
system login, ordinary user launch, Dock activation, deep link, menu action, or
future native push brought the person in. Mapping both signals to PostHog's
canonical name would double counts.

**Considered and rejected:** Labeling every cold manual launch as Dock, deriving
notification source from an unmarked URL, and emitting parallel custom and
canonical open events. Electron cannot prove the first two, and the third would
corrupt open counts.

**Consequences:** Cold launches without a login-item flag or deep link are
`user_launch`. `push_notification` remains dormant until a native notification
callback exists. Product analytics opt-out suppresses attributed opens; bounded
essential lifecycle events continue under their Rally name.

### 2026-08-13 — Applied desktop settings are stateful and cohortable

**What changed:** The main process now emits one actual settings snapshot after
launch initialization and after a newly authenticated account's preference is
verified. Successful launch-at-login and Lockdown interactions preserve previous,
requested, and applied booleans; successful icon selection preserves the closed
previous and selected icon states. Identified Global captures update matching
PostHog person properties with `$set`.

**Why:** Toggle clicks alone cannot answer the current-state question, and macOS
can accept a login-item request without applying it while approval is pending.
Icon and Lockdown operations can also fail or roll back before persistence is
authoritative.

**Considered and rejected:** Renderer click capture, treating requested state as
applied state, arbitrary setting names, and icon labels or paths. Those options
respectively report before commit, corrupt login-item analysis, widen collection,
or create mutable/high-cardinality values.

**Consequences:** The icon analytics taxonomy and picker share one identifier
allowlist. Product analytics opt-out suppresses snapshots, change events, and
Global person-property updates. EU keeps the closed semantic events internally
and makes no PostHog call.

### 2026-08-13 — Menu and keyboard adoption use bounded client signals plus a server outcome

**What changed:** Registered menu opens, menu actions, Command-shortcut reveals,
valid numbered navigation, and successful suggested-work starts. Client events
describe the observed interaction with booleans, counts, and closed enums; the
regional API owns the successful suggested-work event after creation commits.

**Why:** Screen views and suggestion impressions could not form a truthful
menu-open → selection → successful-work funnel, and navigation alone could not
separate shortcut discovery from use.

**Considered and rejected:** Generic click autocapture, raw labels/routes/IDs,
and client-only success reporting. They would respectively expand collection
without a product question, create content-bearing high-cardinality data, or
count a failed/interrupted request as adoption.

**Consequences:** These events follow the Product analytics preference and the
existing regional route. Global receives them through the ordinary PostHog
adapter; EU retains them internally. Suggested-work clients may omit `surface`
for backward compatibility, but an omitted surface produces no success event.

### 2026-08-13 — Native desktop events carry the applicable first-party SDK context

**What changed:** Electron main now adds the random installation device ID,
identified state, OS version, locale, timezone, display dimensions, and trusted
per-window viewport/window IDs to the typed event context. The Global adapter
uses PostHog's reserved native-app properties and emits canonical installation
and update lifecycle events. A durable local marker retains a stable pending
event ID until the spool enqueue succeeds, then acknowledges the current
version; it also treats an existing installation's first upgraded launch as a
baseline rather than a new install. Cold opens, installs, and updates include
the current unprefixed `version`/`build` fields used by PostHog's Android
lifecycle integration in addition to common `$app_*` context. Hidden login
launches seed the focus observer as backgrounded so opening the first window
emits the real foreground transition.

**Why:** Navigation events alone made PostHog paths work, but built-in breakdowns
and session/application views remained poorer than data captured by PostHog's
first-party app SDKs. The adapter boundary can reproduce those truthful desktop
signals while preserving regional delivery and without placing a provider SDK
or token in the renderer.

**Considered and rejected:** Copying the browser SDK's URL, host, referrer,
campaign, user-agent, and embedded-Chromium fields; exporting a hostname as a
device model; guessing hardware manufacturers; and reporting every existing
installation as newly installed. Those choices would respectively classify
Electron as web acquisition traffic, create identifying high-cardinality data,
invent device facts, or corrupt installation counts.

**Consequences:** In Global PostHog, `$device_id` can associate Rally's random
installation identity with an identified person, matching SDK device
attribution; the explicit anonymous merge still uses only the rotating login
epoch. EU keeps the same typed context internally and receives no PostHog
identity. New context fields must be main-derived and bounded, and browser-only
metadata remains outside the Electron contract. Context v1 remains readable for
old clients and stored replay, while new desktop producers declare context v2;
an API rollback may not remove the v2 reader while those producers are live.

Design: [regional telemetry PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-13 — PostHog receives native app semantics without duplicate events

**What changed:** The Global adapter now translates registered screen views and
the matching desktop lifecycle transitions to PostHog's canonical `$screen`,
`Application Opened`, and `Application Backgrounded` events. Desktop captures
and exceptions carry standard app, desktop-device, and OS properties. A
main-owned focus observer establishes the launch focus as its baseline, ignores
window-to-window focus handoffs, and reports later application background and
foreground transitions. Only API-originated captures are marked as server
events. Every destination event
retains its single Rally registry name in `rally_event_name`, and the live
PostHog tool catalog is recorded with the exact products this contract can and
cannot truthfully drive.

**Why:** PostHog's built-in navigation and application views key off reserved
event names and properties. Sending only Rally's internal spelling hid screen
and lifecycle semantics, while treating every regional delivery as server-side
would erase the originating desktop context. The provider mapping can supply the
SDK's native semantics without weakening Rally's regional or typed boundary.

**Considered and rejected:** Emitting both the custom and reserved event for one
occurrence, renaming the regional registry, embedding the provider SDK in the
renderer, and fabricating pageviews, flag exposures, surveys, replay snapshots,
traces, or AI generations. Duplication corrupts counts; the other options either
move provider concerns into the regional contract or claim observations Rally
did not make.

**Consequences:** PostHog queries for provider-standard navigation/lifecycle use
the reserved event name and can filter or recover Rally's semantic name through
`rally_event_name`. EU storage and queries remain unchanged. Every future
reserved-name mapping needs an exact semantic-equivalence test and must replace,
not duplicate, its custom destination spelling.

### 2026-08-13 — Caught renderer transport failures reach exception telemetry

**What changed:** The shared renderer HTTP boundary now sends caught, non-abort
transport failures through the existing sanitized JavaScript-exception route as
`network_error`, with classification-aware same-object suppression and five-minute
same-signature coalescing. A later crash classification supersedes a handled
network classification so essential process health is not lost. Handled network
failures do not themselves emit essential process health transitions, and upload
settlement prevents a late error event after abort from producing a false
diagnostic. The API CORS policy and its production-shaped preflight test now admit
the desktop's `X-Rally-Operation-Id` mutation header.

**Why:** Production desktop requests carried that header, but the Worker omitted
it from `Access-Control-Allow-Headers`. Chromium rejected new-work-stream and
message mutations before they reached the Worker. The UI converted and handled
the rejected `fetch`, so neither global renderer error listener ran and PostHog
contained no exception explaining the outage.

**Considered and rejected:** Relying on `unhandledrejection`, embedding PostHog in
the renderer, or reporting the request URL/message/body. The first misses handled
failures, the second violates the main-owned telemetry boundary, and the third
could copy workspace content or credentials into diagnostics.

**Consequences:** Eligible Global failures reach PostHog while EU failures remain
inside EU. Both contain only stable classification and sanitized generated
frames. An outage cannot turn handled request failures into renderer-process
health degradation or enqueue one event per polling attempt. Any new desktop
request header must be added to the explicit CORS allowlist and the preflight
regression before it ships.

### 2026-08-13 — Artifact verification uses authoritative upload metadata

**What changed:** Private artifact publication now verifies Cloudflare's
single-PUT response against the submitted byte count and MD5 ETag, requires a
new upload version and timestamp, then confirms that same key, size, ETag, and
timestamp through the exact-prefix object inventory. It accepts only an
inventory explicitly marked `DYNAMIC` and no longer verifies through the
object-body GET.

**Why:** The first release after moving off Wrangler proved that Cloudflare had
stored a new native-symbol object at 19:09:29 with a new ETag, while the REST
object GET still returned a 4,548-second-old `CF-Cache-Status: HIT` carrying the
previous ETag. `Cache-Control: no-cache` did not bypass that response, so a
correct upload failed the release checksum gate even though the authoritative
inventory showed the new object.

**Considered and rejected:** Removing integrity verification, accepting any
successful PUT, or adding a query nonce to the object GET. Those would
respectively lose the exact-byte check, fail to prove persistence, or change
the R2 object key and return 404. The upload result plus dynamic inventory keeps
both byte integrity and storage confirmation without trusting a cached body.

**Consequences:** Release artifacts remain bounded before upload and requests
remain timeout-limited. The publisher relies on R2's default MD5 checksum for a
non-multipart object and the upload endpoint's returned version; any ETag,
size, key, timestamp, non-dynamic cache status, or inventory mismatch fails
closed. Inventory time may trail the upload response by at most one second to
allow for provider timestamp-serialization precision.

### 2026-08-13 — Release artifacts use the regional object API directly

**What changed:** The initial REST migration uploaded and read back private
source maps and native symbols through Cloudflare's object API. It bounded the
uploaded and returned bytes, timed out stalled requests, and sent the explicit
`eu` jurisdiction header only for the EU telemetry bucket. API deployment also
derived a hosted-R2 inventory from both Wrangler files, logged every binding,
and proved each bucket existed before remote mutations. The cached-read failure
and replacement verification strategy are recorded in the newer entry above.

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

**Consequences:** The release token must retain `Workers R2 Storage Write` and
the publisher holds one preflight-bounded artifact in memory at a time.
Regional isolation is explicit in the request rather than inferred from CLI
state, and retries remain fail-closed on upload, timeout, size, or integrity
errors.

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
provide. Centralizing policy in Rally keeps route, opt-out, identity, and internal
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
