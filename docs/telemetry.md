# Regional telemetry

Rally's telemetry subsystem accepts a closed set of semantic product signals,
content-free reliability signals, sanitized JavaScript diagnostics, and native
Electron crash reports. Rally owns collection, policy, routing, identity,
durability, and internal retention; PostHog is the Global destination, not an SDK
embedded in the renderer or a source of product truth.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/telemetry.ts` | Closed event registry, envelope/batch schemas, breadcrumb and bootstrap contracts, size limits, and prohibited-field rules. |
| `apps/desktop/src/main/telemetry-*.ts` | Route, random identity epochs, local event spool, typed reporter, breadcrumbs, launch markers, and preference-independent reliability collection. |
| `apps/desktop/src/main/application-open-observer.ts` | Closed cold-start attribution and activation coalescing so explicit deep-link/menu sources outrank Electron's generic Dock/reopen callback. |
| `apps/desktop/src/main/native-crash-*.ts` | Route-final Crashpad generations and the bounded, authenticated next-launch uploader. |
| `apps/desktop/src/main/renderer-crash-recovery.ts`, `apps/desktop/src/main/renderer-window-availability.ts` | Native primary-window renderer-crash notice and application relaunch choice, plus the shared live-renderer filter for main-process broadcasts. |
| `apps/desktop/src/main/main-process-network-recovery.ts` | Exact Electron URL-loader reset admission, original-origin reporting for every other rejection, and next-turn fatal scheduling that preserves sibling rejection delivery. |
| `apps/desktop/src/main/native-performance-log.ts`, `apps/desktop/native/unified-log/UnifiedLog.mm` | Device-only macOS Unified Logging for the closed renderer performance projection; it is not an upload path. |
| `apps/desktop/src/main/product-analytics-settings.ts` | Local-first disable, fail-closed enable/refresh, preference synchronization, crash invalidation, and spool purge. |
| `apps/desktop/src/main/index.ts` | Startup ordering, Crashpad start, process observers, IPC sender validation, upload scheduling, and product integration points. |
| `apps/desktop/src/main/telemetry-intent.ts` | The renderer-intent allowlist and validator every `telemetry:product-intent` call passes through, kept out of the entry point so it can be tested by running it. |
| `apps/desktop/src/renderer/lib/telemetry.ts` | Narrow renderer facade for registered screen, product-intent, and error-candidate calls. |
| `apps/desktop/src/renderer/lib/socket-telemetry.ts` | The one `realtime_socket_state` producer, instantiated per live socket loop by the workspace, Channel-control, and SubstreamAgent-feed hooks; it also reports every Channel-control and SubstreamAgent-feed connection start. |
| `apps/api/src/routes/telemetry.ts` | Bounded bootstrap, anonymous/authenticated event, identity-link, preference, and crash-ingest routes. |
| `apps/api/src/telemetry-delivery-worker.ts` | Global-only private Worker that owns telemetry destination adapters; PostHog is the first adapter. |
| `apps/api/src/middleware/api-operation-telemetry.ts` | Content-free timing/outcome signals for an explicit API operation allowlist. |
| `apps/api/src/telemetry/tool-usage.ts` | Content-free, durably admitted agent-tool usage for user-owned and personless workspace-owned runs. |
| `apps/api/src/telemetry/workstream-creation.ts` | Server-authoritative, idempotent work-stream creation state and connector attribution across user, Slack, suggestion, and automation paths. |
| `apps/api/src/telemetry/message-sent.ts` | `message_sent` for a message or elicitation answer a person sent from any client, recorded where the Channel object admits it, including a composer-created Channel's opening message in `initialize`. |
| `apps/api/src/telemetry/product-usage.ts`, `apps/api/src/telemetry/run-outcome.ts` | Shared bounded dimensions, idempotent resource event IDs, and authoritative run/tool journey outcomes. |
| `apps/site/src/telemetry.ts`, `apps/site/src/site-entry.ts` | Region-before-identity public-site page, action, acquisition, and browser-to-desktop handoff reporting. |
| `apps/api/src/crash-symbolicator*.ts`, `apps/api/crash-symbolicator/` | Private Cloudflare Container boundary and pinned native stack-walking image. |
| `packages/db/migrations/0077_connector_oauth_telemetry_shape.sql` | The bounded event version, connector scope, capability count, and reconnect state admitted with an OAuth attempt for later terminal telemetry. |
| `apps/desktop/scripts/publish-telemetry-artifacts.mjs` | Private source-map and native-symbol publication to both isolated telemetry buckets. |
| `apps/desktop/scripts/telemetry-crashpad-fixture.mjs` | Real packaged Electron/Crashpad two-launch release gate. |

The approved product contract and rationale are frozen in the [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md); this document describes
the implementation that future changes must preserve.

For the implementation checklist, see
[`adding-new-instrumented-event.md`](adding-new-instrumented-event.md).

## Storage and background writes

`TELEMETRY_DB` owns accepted events, delivery receipts, and replay audit rows.
Its independent schema is in `packages/db/telemetry-migrations`. Receipts stay
with events so their existing acceptance transaction remains local. Identity,
preferences, and profile jobs remain in `DB`; background delivery and replay
read preferences there instead of joining across databases. These telemetry
IDs are historical references, without foreign keys to identity tables.
There is currently no user-deletion operation in the API. Removing an identity
row directly no longer cascades into these databases: pending attributable
nonessential telemetry is suppressed during delivery, retained events expire
at their existing deadlines, and audits remain historical records. A future
account-erasure operation must explicitly delete from these stores if required;
this split does not claim automatic erasure.

Product-derived telemetry uses the existing `runtimeDeferral`/`waitUntil`
mechanism. Audit writes likewise run in the background against `AUDIT_DB`.
Neither write is a condition of a successful user mutation or tool turn. A failed
background write may be lost; this split adds no outbox, dual writes, or retry
layer. Explicit telemetry ingestion still acknowledges its existing acceptance
boundary, and the existing accepted-event delivery machinery is unchanged.

Deployment applies both independent schemas before activating the API Worker.
The cutover starts fresh. Regional migration
`0113_drop_legacy_observability_tables.sql` discards the four inactive legacy
observability tables after the compatible Worker deploys and passes health
verification. The reaper uses only `TELEMETRY_DB` for accepted events, receipts,
and replay audit; other telemetry tables remain in `DB`. The dedicated databases
and their data are unaffected. No backfill or old-table compatibility path remains.
Applied migrations remain immutable. Opt-out purges pending events in the background through the
request-entry timestamp inclusively after rechecking the disabled preference
version. This is best-effort across databases, not an atomic cross-database
transaction. Delivery also checks the canonical user
preference and rechecks pending identity transitions after selecting events.

## How it works

Interactive search uses the existing `renderer_perf_flow` diagnostic event with
`flow=workspace_search`. Its duration runs from the last query-changing keystroke
through painted authorized results. The optional search timing fields separate
debounce, request, paint, scope resolution, retrieval, hydration, and server work.
Queries and result contents are never event properties. `text-search.md` owns the
pagination contract and p50/p90 acceptance targets.

### Contract and producers

The importer's `desktop_action_phase` diagnostic joins an opaque UUIDv7 action
ID to content-free renderer phases and elapsed milliseconds from receipt,
including queue admission, browser-state reads, browser-command round trips,
execution, answer send/defer, re-offers and terminal-run interruption. Window
visibility distinguishes a hidden renderer. The durable `desktop_actions` row
supplies server creation and answer times; a renderer send is not a server
acknowledgment. Collection uses the existing main-owned semantic intent and
diagnostic preference/retention policy. Scripts, provider URLs, titles, file
names, tool results and transcript contents are absent.

Deterministic importer runs are UUIDv8. Tool-start, tool-terminal and run-terminal
producers keep that original ID in `harnessRunId` and derive a stable UUIDv7
operation correlation through `runTelemetryOperationId`; native UUIDv7 runs
retain their existing operation ID. This satisfies the context contract without
rejecting the entire event or changing the actual run identity.

`TELEMETRY_EVENTS` is the only event registry. Each entry fixes its sources,
authoritative producer, identity scopes, category, exact property schema,
classification, priority, sample rate, retention, and destination. Incompatible
changes require a new schema version. There is no generic `capture(name,
properties)` API outside the reporter internals.
The authenticated desktop `/telemetry/events` transport rejects every envelope
whose source is `api`; server producers call the internal emitter directly. The
shared envelope schema accepts API events so those internal producers remain
typed, not so a session-bearing client can claim server authority.

Application icon ingestion retains every shipped identifier in
`TELEMETRY_APPLICATION_ICON_IDS`, including retired artwork, for configured regional
collectors and the desktop spool. `CURRENT_APPLICATION_ICON_IDS` is the smaller
selection/persistence allowlist. Replacing artwork adds a new identifier rather
than reusing a retired one; Ludicrous speed's supplied artwork uses `ludicrous`.

Legacy envelopes have the frozen context v1 shape. Native desktop enrichment
uses `contextSchemaVersion: 2`; the regional reader accepts both shapes, while
API-generated events remain on v1. The regional reader must reach configured deployments
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

The macOS status surface emits `menu_bar_opened` once per visible open (with
`attentionCount`, the unread Activity rows it lists; waiting threads before
2026-10-13, see [`menu-bar.md`](menu-bar.md)) and
`menu_bar_action_selected` for enabled rows using closed structural properties
only. `command_shortcuts_revealed` and `command_shortcut_used` are historical
schemas retained for older clients; the current sidebar emits neither. Suggested-work
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
(`workspace`, `workstream_control` from desktops released before the Channel
control socket was retired, `substream_feed`), whether it is connected,
retrying, or stopped, the bounded cause, and the retry depth as a count bucket.
Dictation's audio socket is deliberately outside this contract: it is an Azure
transport with its own lifecycle, not one of the room sockets.
The cause is stated where it is known rather than derived from a close code,
which carries none of it — a heartbeat that went unanswered, a transport error, a
ticket that could not be issued, a room that could not replay, going offline, a
socket that never opened (`open_timeout`), an Organization socket that opened
but never delivered its initial sidebar (`sync_timeout`), the machine going to sleep
(`suspended`), and losing access are each their own value, and a close nobody
asked for is the server's. Offline is checked once more after the socket ticket resolves, because
a client that drops off the network while that request is in flight has no socket
for its offline handler to close: dialling anyway fails a moment later and would
be counted as a transport error, which is the one reading this event exists to
keep apart from losing the network. A close from the effect's own teardown is not a transition at all and
is not reported; counting it would put every ordinary navigation in the drop
rate. The event carries no work-stream ID, URL, close code, or ticket.

The singleton organization socket also emits `workspace_socket_handshake` for
each connection attempt. Its UUIDv7 `attemptId` joins the content-free desktop
phases `ticket_requested`, `ticket_received`, `transport_open`,
`subscribe_sent`, `sync_received`, and `sync_applied`; `offline_blocked`,
`sync_rejected`, `open_timeout`, and `sync_timeout` distinguish offline admission,
invalid sync, stalled transport, and stalled initial application synchronization. The phases after
`ticket_requested` that report on the dial (`ticket_received`, `transport_open`,
`open_timeout`, and `sync_timeout`) also carry `sinceTicketRequested`, a duration bucket of wall
clock since the ticket was asked for, and `windowVisible`. A 10-second ticket
timeout that reports minutes later is a renderer that was not running, which is
how a sleeping Mac is told apart from a stuck server. This reliability event is
essential, so the local spool accepts it even when product analytics are disabled. It
contains no ticket, URL, organization name, or directory contents. The UUID is
also sent as the optional `diagnosticAttemptId` on `subscribe`, allowing the
regional WorkspaceDO's structured `workspace_socket_handshake` logs to join
the same attempt. Older clients omit it and remain valid. The server phase
sequence and the pre-subscription `connection_id` join are described in
[`websocket-architecture.md`](websocket-architecture.md).

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
state at click, the feed source (`feed_cache`, `socket_snapshot`,
`boot_payload`, or `local_cache`), and only a count bucket for messages. The normal cold path is
explicitly
`socket_snapshot`; `boot_payload` identifies manual REST recovery, while
`feed_cache` identifies an already-present transcript and `local_cache` a
transcript the renderer's on-device cache painted before the socket answered
([`local-cache.md`](local-cache.md)); the seed marker outranks the
already-present reading, since the pool seeds a conversation before its
surface mounts. Each
detail request keeps a unique
`x-request-id`, including React Query retries, and carries the click ID separately
as `x-rally-operation-id`; the Worker's `workstream.detail.read` span records both.
The independently timed `workstream_send_ready` event reuses the opening-attempt
operation ID and fires after the committed composer has crossed a paint with its
work-stream-specific send handler installed. It records the addressed substream
socket state at that point. `connecting` and `reconnecting` are ready states for
this client milestone because that socket queues idempotent message commands;
the event does not claim that transport delivery or server
acknowledgement has completed. A composer over a local-cache seed is not
ready, whatever its socket state: the milestone waits for the live snapshot
that lets the composer send ([`local-cache.md`](local-cache.md)).

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

`renderer_perf_flow` is exported for a socket only when that socket starts under
a pending click opening. Speculative hover, retention, and background reconnect
flows remain device-local, preventing connection lifetime from masquerading as
click latency. Direct Electron attempts may add PAC, DNS, TCP, TLS, and edge
upgrade durations; proxy attempts add one CONNECT/TLS/edge aggregate and a
failed-route count. These are closed diagnostic properties, not new product
outcomes.

Work-stream collaboration records authoritative participant changes, resource
attach/detach/watch/preview/open-source outcomes, stop/retry actions, and unread
attention consumption. Terminal
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

An automation is measured as its conversations and its runs. The desktop's
surface for `/automations/:id` is `automation_detail`, whether the automation
is a draft or applied, because one screen is behind the route; the
`automation_builder` surface stays in the closed union only because rows
recorded before the builder's retirement carry it, and no current client
reports it. The entry points `sidebar_automation` and `automation_run_list`
name how the page was reached. On the API, a run's outcome and its
`agent_tool_started` events carry the automation id, the run id, and the
trigger kind from the run's `automationRun` reference; the compiler-turn,
revision, template, and overview-reopen measurements went with the builder.
Dimensions stay closed and content-free.

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
These observational reads and regional analytics writes are registered on the
current Cloudflare invocation with the shared lifecycle deferral. Tool execution,
run settlement, and user actions therefore do not wait for receipt rereads,
analytics identity lookup, D1 acceptance, or lakehouse Queue staging. The
canonical tool/run receipts and the product mutations that precede emission stay
awaited; only the derived telemetry continuation moves off their critical path.
For Worker requests the primitive uses `waitUntil`. Durable Objects need no
extra lifetime extension while asynchronous I/O is pending, and Cloudflare's
Durable Object `waitUntil` method is a compatibility no-op. Neither mechanism is
a durable retry fence: telemetry can still be lost to deployment or runtime
reset before D1, R2, or Queue accepts its hand-off.
The established requested/completed pair remains a separately named admission
funnel for correlated desktop runs; it is not mapped to the same reserved event.

After main has initialized the operating-system login item, Lockdown controller,
and application icon, it emits one `application_settings_state_v2` with the actual
enabled and availability booleans, closed icon identifier, and menu-bar state. A
newly authenticated account receives the same snapshot after its Product
analytics preference has been verified; an existing authenticated launch uses
its durable preference immediately while refreshing the canonical value in the
background. Successful Settings
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

The main process also owns deliberately narrow last-resort recovery for
Electron's internal `SimpleURLLoaderWrapper`: an unhandled
`ERR_CONNECTION_RESET` or `ERR_NETWORK_CHANGED` whose stack names Electron's
built-in URL loader. Sleep/wake or a network change can interrupt an in-flight
request; treating that transport interruption as a fatal JavaScript defect
leaves Electron's generic error dialog over an otherwise recoverable app. Rally
keeps the existing payload-free `process_health` rejection signal, logs the
interruption and its code locally, and keeps running, allowing the socket,
polling, and telemetry owners to take their existing reconnect or retry paths. The exact code and a single real stack frame
containing both the loader and Electron `browser_init` markers are required.
Every other unhandled rejection is reported with its original rejection origin,
then thrown fatally on the next event-loop turn so sibling rejections already
pending in the same batch are not discarded.

### Route and identity

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

An existing authenticated startup uses the durable device preference to admit
nonessential events to the local spool before the first window, then reconciles
the canonical account preference in the background. It does not await that
regional read. Transmission remains closed until verification, so a canonical
disable purges the held rows instead of racing them to the service. A new
account/session transition also treats nonessential telemetry as off until the
regional API verifies that account, preventing one account's stored choice from
crossing into another. A disable is fsynced locally before
the network mutation, invalidates the live Crashpad generation without opening its
database, stops upload immediately, and purges queued nonessential rows. Enable
does not become effective until the compare-and-set regional/canonical update is
acknowledged. Session changes force a fresh fail-closed read. That read has a
15-second deadline: it remains bounded, but includes cold DNS, TLS, regional
Worker activation, and the canonical D1 lookup instead of treating a normal
cold request as an outage after one second. A successful background refresh
updates the durable value and releases held rows for upload; a canonical disable
purges them. A failed cold-launch refresh leaves the last durable same-account
choice as a local-admission gate, holds its rows for a future verification, and
is diagnostic rather than a launch gate.

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

### PostHog product compatibility

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

The primary window also has an immediate, main-process-owned recovery path. If
its renderer exits unexpectedly, Rally shows a native dialog with **Restart
Rally** and **Quit Rally** choices. The dialog does not depend on React, the
preload bridge, or the failed renderer. Restart schedules Electron's relaunch
before taking the ordinary quit path, so the existing telemetry quit barrier and
synchronous cleanup still run. A dialog is parented only when the main window is
already visible; an exit during startup uses an application-modal dialog so the
recovery choice cannot be hidden behind a window that never reached its first
paint. Clean exits and renderer exits observed after application shutdown begins
do not show the dialog. A renderer killed outside Rally's shutdown path is an
unexpected disappearance and receives the same recovery choice. Concurrent
unexpected-exit signals share the one dialog already open. Every shared-window
broadcast excludes destroyed or crashed renderer contents, so raising the native
dialog—or receiving a concurrent session, settings, theme, or icon change—cannot
turn the original crash into follow-on frame errors. Secondary Settings and
Sidekicks windows remain independently closable and reopenable; only the primary
window owns whole-application recovery.

This use of a native dialog is intentionally narrower than the rendered deep-link
failure window: deep-link errors still have a live renderer and need consistent
cross-platform layout, while renderer-crash recovery must work when no renderer
exists to draw that surface.

This live recovery complements Crashpad rather than replacing it: the native
report is still rotated and uploaded on a later launch, while the dialog only
gives the person a usable application again.

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
approval, advertising, consent-law determinations, or cross-site account identity.
Public-site acquisition reporting is owned by `public-site-telemetry.md`; its
opaque flow correlation joins signup observations without joining identities. Product analytics are
advisory and may be incomplete; regional product authority is canonical — D1
for workspace/control data and, after its guarded cutover, the Channel's parent
in `WorkspaceDO` and its conversations for work-stream product data.

- The authenticated Product analytics preference read times out after 15
  seconds. Existing same-account launches continue collecting into the durable
  local spool but do not transmit nonessential rows; new account/session
  transitions remain fully fail-closed until verification.

- Local event rows expire after 14 days, with a 2,000-row/8 MiB spool. Corrupt
  rows are quarantined only when their independent deadline is valid; otherwise
  they are deleted immediately.

- Native local material expires after 14 days and is bounded to 20 reports/100
  MiB. A dormant device physically purges it on its next launch before delivery
  or Crashpad restart.

- Normal event batches are at most 256 KiB and 50 events. Native dumps are at
  most 20 MiB; breadcrumb sidecars are at most 32 KiB; structured reports are at
  most 4 MiB; source maps are at most 16 MiB.

- Global analytics lakehouse handoff is unretractable in the current design. A
  late opt-out or D1 expiry does not delete a current Iceberg row;
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

## Complete signup measurement

A random UUIDv7 `flowId` follows the sign-in screen through OAuth state, email
challenges, desktop tickets, and the new account's first signup. Existing users
and old proofs are not backfilled; returning sign-ins cannot replace lineage.

The closed API stages are `signup_viewed`, `signup_started`,
`signup_email_submitted`, `signup_verification_requested`,
`signup_verification_completed`, `authentication_completed`,
`signup_account_created`, `signup_organization_requested`,
`signup_organization_ready`, `signup_onboarding_completed`, `signup_completed`,
and `signup_failed`. New-account events exclude returning sign-ins. Completion
requires first organization access and any required introduction, for either
`new_organization` or `existing_organization`. Automatically claimed shares enter
the organization setup funnel when the user selects their organization.

`clientPlatform` is the surface executing the stage; `entryPlatform` is where
signup began. Desktop-issued email links redeemed in a browser retain both.
`source: api` names the producer. Desktop offers Google; browser offers Google
and email. Native PostHog funnels count flow attempts, not unique people.
Public-site acquisition retains a separate anonymous subject. The landing
page's “Sign up now” and header sign-in links mint a fresh opaque UUIDv7
on each activation and carry it in `signupFlowId`; `site_action_selected.flowId` and all subsequent signup stages
share it. Browser entry validates and saves it in tab-scoped session storage before
removing it from the address bar. Reloads retain the attempt; a new incoming
CTA replaces it, and authentication or sign-out retires the stored lineage.
Unavailable storage never blocks sign-in. Funnels
that include the CTA must aggregate by `properties.flowId` across subjects.

The desktop flow starts at `desktop_install_opened`, emitted by main only when
installation data is first created and no account is saved. Its random
`firstSignupFlowId` persists in the installation identity file and is exposed by
the trusted runtime bridge while no account has been observed. Sign-in reads it
once and carries it into the existing API stages. Account changes retire it;
existing installations and repaired corrupt identity files are not backfilled.
The event respects Product analytics settings and uses the existing spool and
anonymous capability. A missing or failed telemetry bridge falls back to a
regular signup flow without blocking authentication. “Fresh install” means new
local installation data, not reinstalling the binary over existing app data.

The dashboard has two complete tracking flows: browser from the hero web CTA,
and desktop from the first installation opening. Both include first organization
access (new or existing) and required account introduction. Cross-subject SQL
joins by flow ID show ordered stage counts and previous-stage drop-off within
14 days, rather than merging site or installation subjects with account identity.

The unauthenticated view endpoint accepts only a UUIDv7, but callers can submit
fresh IDs to inflate view counts; it has no new issuance limit. Successful stages
remain server-owned. No mailbox, account ID, proof, invitation credential, or raw
error is captured. Known users respect the existing analytics preference gate;
pre-verification observations cannot resolve it. Delivery is deferred and best
effort, never an authentication gate or delivery outbox. Stable event IDs dedupe
stages and each organization intent path. Completion is claimed atomically from
current organization/introduction state; a late introduction observer still emits
its stage after completion. Observation timestamps precede deferred reads.

Deploy regional migration `0121_signup_telemetry.sql` first, then every configured
API deployment, then the browser and desktop producers. Google/email start
schemas are strict: a validation-only `400 invalid_request` retries start once
without `signupFlowId` for an older API. Authentication remains available during
client/API skew, with flow correlation unavailable until the API is upgraded.
Network failures and other errors are not retried. New funnels populate after rollout.

## Testing

Run focused suites from their package directories:

```bash
pnpm --filter @rally/contracts test
pnpm --filter @rally/db test
pnpm --filter @rally/api exec vitest run test/telemetry-collector.test.ts test/telemetry-delivery.test.ts test/posthog-adapter.test.ts test/product-usage-deferral.test.ts test/tool-usage-telemetry.test.ts test/run-outcome-telemetry.test.ts test/crash-processing.test.ts test/crash-operations.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/telemetry-delivery-rpc-boundary.test.ts test-workers/runtime-deferral.test.ts
pnpm --filter @rally/api build:telemetry
pnpm --filter @rally/api test:crash-symbolicator-container
pnpm --filter @rally/desktop exec vitest run src/renderer/lib/api.test.ts src/renderer/lib/telemetry.test.ts src/main/javascript-error-candidate.test.ts src/main/telemetry-reporter.test.ts src/main/product-analytics-settings.test.ts src/main/native-crash-generation.test.ts src/main/native-crash-uploader.test.ts src/main/main-process-network-recovery.test.ts src/main/renderer-crash-recovery.test.ts src/main/renderer-window-availability.test.ts
pnpm --filter @rally/desktop test:release
pnpm --filter @rally/desktop test:crashpad
pnpm --filter @rally/site test
pnpm --filter @rally/site build
```

Contract tests enforce registry exhaustiveness and prohibited negative space.
SQLite fixtures apply every migration and advance fake clocks across absolute
deadlines. API tests use fake telemetry-delivery Service Bindings and R2 bindings and inspect
exact destination payloads. A real-workerd test proves typed nested rows cross
the private telemetry-delivery RPC boundary by value. Desktop storage tests use real temporary directories. The Crashpad
fixture packages the pinned Electron version and creates two real renderer dumps;
it is macOS-arm64-only because that is the only released target. Configured Wrangler
dry-run builds are required to validate regional bindings and the Container image.
The Docker integration gate downloads checksum-pinned upstream minidump and
symbol fixtures, then exercises the built image as its non-root user with no
network, a read-only root, matching symbols, malformed input, and disclosure
checks.

## Data model

`telemetry_crash_reports` is the content-free raw-object index plus the sanitized
full occurrence, processing lease/retry state, and destination state.
Raw dumps,
source maps, and native symbols live only in the region's dedicated
`TELEMETRY_PAYLOADS` bucket.

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

A stored event the running contract no longer admits (accepted by a newer
contract, then the API rolled back) does not stop PostHog delivery. The pass logs
`telemetry_delivery_row_unparseable` with a `stored_envelope_invalid:…` code that
names the rejected field, writes that code to `terminal_code`, and puts the row
back on the ordinary retry backoff. It is delivered once a contract that admits it
is running again, or expires at its `delete_at`. A parked row still counts as
backlog, so it holds the oldest-backlog age up until then: an age that keeps
climbing while delivery still moves means search the logs for
`telemetry_delivery_row_unparseable`.

Use the [telemetry incident procedures](runbook.md#regional-telemetry) for provider
outage, backlog, rejection/abuse, missing artifacts, prohibited data,
cross-region routing, preference inconsistency, replay, or deletion failure. Never
inspect a raw payload or dump through logs. Replay is region- and role-restricted,
preserves the original event ID/hash/deadline, and records only fixed audit codes.
The operator HTTP surface authenticates against a per-region secret map, derives
the operator ID/role server-side, and never accepts either value from a request.
The same code verifies a second map, `DEMO_OPERATORS_JSON`, for the `demos`
role Ace presents to the workspace retirement route
([`workspace-retirement.md`](workspace-retirement.md#the-operator-door)); the
two secrets are set and rotated independently and neither surface reads the
other's. `requireOperatorFrom(secret)` only verifies the credential, and each
operator router narrows to the roles it admits with `requireOperatorRole` — the
telemetry router names `support` and `security` — so a route added here
inherits the refusal, and a `demos` principal that somehow lands in the
telemetry map still reaches nothing. Collapsing a router back to the verifier
alone would hand every token in its map every route.

## Performance and cost

The route gate is the only telemetry work allowed before the first renderer and is
bounded to two seconds. Normal desktop collection writes small validated files and
flushes in batches of 50 every 30 seconds. API telemetry ingest awaits validation
plus its durable D1 acceptance boundary. Telemetry derived from product actions
registers that whole acceptance flow on the current Worker invocation, while
destination calls and symbolication remain deferred as before.
Crash processing selects ten reports per pass and Global delivery selects five.

The engineering budgets remain: API ingest p95 under 25 ms, typical desktop
telemetry under 0.5% CPU/15 MiB/1 MiB per day, and 95% owned-frame symbolication
when matching artifacts exist. Operational snapshots and packaged fixtures provide
the dry-run evidence; change batching or sampling only after measuring those
signals, never by weakening policy or deadline tests.

### 2026-09-14 — Configurable deployment isolation

Configured deployments use the existing Global delivery policy. Public-site and pre-login telemetry use the Global identity endpoint, and workspace events keep their deployment identifier. Geographical routing and the separate internal telemetry sink are removed because deployment IDs now describe isolation, not a product residency promise. Existing preferences, schemas, receipts, and destination adapters remain responsible for delivery.

### 2026-09-11 — Menu-bar events follow the menu that shrank, and stop being refused

**What changed:** `menu_bar_opened` no longer carries `suggestionCount` and its
`recentCount` bound moved from 5 to 10. `menu_bar_action_selected` stops
emitting `new_workstream`, `new_automation`, `suggested_work`, and
`new_meeting_note`, and its enum
moved into an exported `TELEMETRY_MENU_BAR_ACTIONS` that
`TelemetryReporter.menuBarActionSelected` now types itself from —
with `open_rally` and `quit_rally` added to the admitted set.
[`menu-bar.md`](menu-bar.md) owns the product change behind it.

**Why:** two separate things. The menu dropped its Suggestions section and every
New row, so those properties and values describe a surface that no longer
exists. The `menu_bar` value in `surfaceEntrypoint` stays: a meeting window can
still be told it was opened from there, and older clients still say so. Separately, the producer's union and the registry's enum were hand-copied
and had drifted: the desktop sent `open_rally`/`quit_rally` against an enum
admitting only the `avalon` spelling, and every one of those envelopes was
refused at ingestion with nothing failing loudly on the client.

**Considered and rejected:** deleting `suggestionCount` and the three retired
action values outright, and versioning the event. The registry schema is what
admits an envelope, and a released client keeps sending what its build offers, so
a removal refuses a current install's events; a new version would add a second
shape without changing the measurement. Retiring a value here means it stops
arriving, not that it stops being accepted — the same treatment the retired
`command_shortcuts_revealed` and `command_shortcut_used` events got when the
sidebar dropped Command-number navigation.

**Consequences:** `suggestionCount` is optional and absent on new rows; its
absence means "the surface no longer has a Suggestions section", not "nothing
was suggested". `recentCount` is comparable across the cohort boundary because
the bound only widened. `open_avalon`/`quit_avalon` counts stop at the rename and
`open_rally`/`quit_rally` begin at this change: the gap between the two is
refused events, not a drop in use.

### 2026-09-10 — `settings_application` is reported when the window is shown

**What changed:** The settings surface no longer reports `surface_viewed` when
its renderer mounts. It waits for `settings:revealed`, which main sends the first
time that window is put on screen.

**Why:** The settings window is now built hidden ahead of being asked for, so its
renderer mounts once per signed-in session whether or not anybody opens Settings.
Mounting used to *be* opening it. Left alone, the prewarm would have fired the
only `surface_viewed` that window ever produces — spending
`consumeSurfaceEntrypoint()` on nobody and latching `lastSurfacePath`, so the
open a person actually performed would report nothing at all. The metric would
not merely have inflated; opens would have disappeared from it and been replaced
by one mis-attributed event per session.

**Considered and rejected:** Gating the report in the renderer on
`document.visibilityState`, which is the obvious fix and needs no IPC. It is not
reliable: a `show: false` window reported `visible` under Xvfb with no window
manager while this change was being verified, so the renderer cannot use it to
tell a hidden window from a shown one. Only main knows, so main says.

**Consequences:** One `surface_viewed` per settings window that is actually
revealed; raising a window already on screen does not report again, which matches
what the pre-prewarm code did (it did not remount). Any future surface built
before it is shown has the same problem and needs the same treatment — the
renderer cannot detect this condition for itself.
`settings-window.md` owns the reveal signal.

Shipped in #673.

### 2026-09-10 — Feed telemetry names a paint from the local cache

**What changed:** `workstream_feed_visible.feedSource` accepts `local_cache`,
reported when the transcript that painted came from the renderer's on-device
cache rather than a socket frame. The send-ready milestone is not reported
for that paint, since its composer cannot send until the live snapshot lands.

**Why:** A cached paint is a painted feed, and it is the whole point of the
cache that it happens before any socket work completes; reporting it as
`feed_cache` would make the already-resident and the remembered cases
indistinguishable, and reporting nothing would hide the wins the cache is
meant to produce.

**Consequences:** A `local_cache` open, like a `feed_cache` one, has no
detail request to join by design. Percentiles of click-to-painted-feed now
include paints the socket had no part in; read the source before comparing
them with earlier weeks. `workstream_open_outcome` reports `visible` for a
seeded paint as well, since the seed satisfies the route's payload check on
its own, so an open whose socket later fails is `visible` followed by the
feed's failure rather than a failed open; join on the feed source to tell
the two apart.

### 2026-09-10 — The desktop telemetry inspector is withdrawn

**What changed:** The staff-only **Telemetry inspector** pane in
**Settings → Application → Developer** is gone, and with it the
`telemetry:inspector` IPC channel, its preload method, the `getTelemetryInspector`
bridge call and the `DesktopTelemetryInspectorEntry` shape. `TelemetryReporter`
keeps its in-process decision record, renamed from `inspector()` to
`decisions()` returning `TelemetryDecision`.

**Why:** The pane was a developer read-out whose only readers were the people
who wrote it, and it was the sole reason a renderer could ask the main process
for telemetry decisions at all. Removing the surface removes that reach; the
regional operations HTTP surface remains the supported way to inspect what was
actually collected.

**Considered and rejected:** Deleting the reporter's record along with the pane.
It is the only place that separates *suppressed* — the opt-out held — from
*rejected* — the event failed its own schema — and the reporter's tests assert
on that distinction; the spool cannot, because both outcomes leave it empty. The
name moved instead, so nothing still points at a pane that is gone.

**Consequences:** Renderer-visible telemetry state is now the **Product
analytics** preference and its status lines, nothing else. A future debugging
surface for decisions is a new decision, not a restoration.

### 2026-09-08 — The `demos` credential leaves the telemetry map

**What changed:** `requireTelemetryOperator` is one instance of
`requireOperatorFrom(secret)`; the other, `requireDemoOperator`, reads
`DEMO_OPERATORS_JSON`. `TELEMETRY_OPERATORS_JSON` holds telemetry roles only
again. The context accessor is `getOperator`.

**Why:** The entry below rejected a separate secret on rotation cost. The
cost that actually arrived was the opposite one: a secret cannot be read back,
the telemetry map had been set by someone else, and adding Ace's token meant
overwriting tokens nobody could name. Owned by
[`workspace-retirement.md`](workspace-retirement.md#changelog).

**Consequences:** This surface's secret is touched only for this surface. The
role narrowing stays, so a misfiled token is refused either way.

### 2026-09-08 — The operator credential map carries a role this surface refuses

**What changed:** `OperatorPrincipalSchema` in `telemetry/operator-auth.ts`
gains the `demos` role, and `requireOperatorRole` narrows each router to the
roles it admits; `telemetry-operations.ts` names `support` and `security`.

**Why:** Workspace retirement ([`workspace-retirement.md`](workspace-retirement.md))
needed an operator credential that can retire and nothing else. A second
secret with the same shape is a second thing to rotate for no isolation gained;
the role is what isolates, and only if every surface names the roles it admits.

**Considered and rejected:** A separate `WORKSPACE_OPERATORS_JSON` — the
rotation cost above.

**Consequences:** Adding an operator router means naming its roles. A role added
to the map reaches no surface until a router names it.

### 2026-09-06 — Retain historical application icon identifiers

**What changed:** Separated current selectable icons from the append-only
telemetry icon enum, retaining both previous artwork generations in ingestion.

**Why:** Removing old values rejects legitimate events from installed clients
and queued events during an upgrade. A selection change must not shrink the
released event contract.

**Considered and rejected:** Versioning the same event solely for an artwork
replacement would add a second event shape without changing its meaning.

**Consequences:** Configured deployments and the desktop spool continue to accept retired
IDs. New artwork receives a fresh ID so historical observations stay distinct.

PR: #566.

### 2026-09-03 — Automation telemetry follows the run reference and one detail surface

**What changed:** The compiler-turn, create-ready revision, template creation,
and overview-reopen measurements are gone with the automation builder and
compiler. A run's outcome and tool events read `automation_id`,
`automation_run_id`, and `automation_trigger_type` from the run's
`automationRun` reference rather than a frozen run context, and the desktop
reports `automation_detail` for every `/automations/:id` visit.

**Why:** The automation was rebuilt as a conversation parent
([`automation-lifecycle.md`](automation-lifecycle.md)); drafting is a
conversation the work-stream telemetry already covers, and there is no builder
screen to attribute.

**Consequences:** `automation_builder` and `automation_builder_started` remain
in the closed unions for rows already recorded and have no current emitter.

### 2026-09-03 — Every substream mutation keeps a named server span

**What changed:** Answer, reorder, stop, and retry commands share the
`workstream.room.substream_command` span with content-free command, operation,
connection, transport, and object identity attributes. Failures set the span
error and response status even when the private receipt cannot be delivered.

**Why:** Moving these commands from HTTP to the substream socket removed their
route spans and otherwise left successful command latency invisible.

**Considered and rejected:** Logs only cover unexpected failures and cannot
describe successful latency. One span name with a command dimension preserves
the common operation without multiplying the registry.

**Consequences:** The socket cutover keeps request-equivalent server timing and
error evidence without recording command contents.

Shipped in #541.

### 2026-09-02 — Send readiness follows the addressed substream command socket

**What changed:** The send-ready description now names the addressed
SubstreamAgent socket, which owns message admission and the other child-local
commands. The obsolete WorkspaceDO message relay and its REST alternatives are
gone.

**Why:** Readiness telemetry must describe the transport the composer will
actually use; otherwise a healthy parent directory socket can make child input
look sendable when the owning substream is unavailable.

**Consequences:** `workstream_send_ready` still measures handler installation,
not server acknowledgement. Connecting and reconnecting remain ready because
the renderer retains and replays the exact idempotent child command.

### 2026-09-01 — Renderer socket diagnostics describe clicks, not retained lifetime

**What changed:** `renderer_perf_flow` accepts bounded native handshake phases
and uploads socket-opening flows only when a pending work-stream opening attempt
owns them. Background/speculative flows remain in local performance logging.

**Why:** A 72-hour analysis found retained and background traces with hours-long
effect-to-request gaps in the same distribution used to investigate 5–15 second
clicks. The event was valid transport logging but invalid evidence for the
product-open question.

**Considered and rejected:** Query-side duration cutoffs would silently choose a
new product definition and retain plausible background rows. Exporting every
local phase would recreate the open schema this registry forbids. Proxy
subphases remain aggregate because their boundaries are not observable.

**Consequences:** Pre-change and post-change socket-flow percentiles are
different cohorts. `workstream_feed_visible` and `workstream_send_ready` remain
the authoritative total; the click-scoped diagnostic event only locates its
transport contributors. All new properties remain diagnostic and optional for
rolling client versions.

### 2026-09-01 — Telemetry destinations gain one Global service boundary

**What changed:** Telemetry, JavaScript-exception, native-crash, and profile
delivery now call four explicit methods on the private Global
`TELEMETRY_DELIVERY` Worker. The regional API still admits and sanitizes rows,
owns every D1 outbox and circuit, and records destination outcomes. The Worker
statically owns the PostHog SDK and adapter, stores nothing, and returns an
outcome keyed by destination so later fan-out can remain independently durable.

**Considered and rejected:** Sending raw envelopes to a generic operation
endpoint would weaken the typed contract. A PostHog-named Worker would encourage
one service per later vendor rather than one reviewed destination boundary.
Moving outboxes or retry policy would split regional authority. A second stored
PostHog token was unnecessary because the existing Global secret can cross the
private binding for one call during the first deployment.

Shipped in #471.

### 2026-08-28 — Automation telemetry follows the parent run envelope

**What changed:** Compiler and generated-run signals carry content-free
automation, occurrence, trigger, run, and region attribution through a shared
run envelope. Tool usage and terminal outcomes use that envelope rather than
reading removed WorkspaceDO subscription or run rows. On the client,
`telemetrySurfaceForPath` now takes whether the automation at that path is still
a draft, and reports `automation_builder` or `automation_detail` accordingly.

**Why:** Telemetry must remain attributable after legacy tables are gone without
becoming a shadow authority or copying evaluator and transcript content. The
client half is a consequence of the same cutover: a draft and an accepted
automation share one durable route now, so the pathname alone cannot say which
screen is showing. Every draft after its first turn was reporting as
`automation_detail`, which made authoring an automation indistinguishable from
reading one — and authoring is the funnel this surface exists to measure.

### 2026-08-27 — Feed telemetry drops the retired compatibility source

**What changed:** `workstream_feed_visible.feedSource` now accepts only
`feed_cache`, `socket_snapshot`, and `boot_payload`. The `legacy_page` source
was removed with the message-page protocol.

**Why:** Retaining an unreachable source in a strict analytics schema implied a
runtime recovery path that no longer exists and allowed tests or dashboards to
keep treating compatibility pages as a valid transcript authority.

**Considered and rejected:** Keeping the enum for old Electron builds. Those
builds are deliberately incompatible with the ordered-turn protocol, and no
deployed user population requires a rollout window.

**Consequences:** Every emitted feed source names a current cache writer.
Historical events keep their stored value, but current code cannot emit
`legacy_page`.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).

### 2026-08-26 — Renderer performance phases are governed diagnostic events, and cold launch no longer awaits preference reconciliation

**What changed:** Added `renderer_perf_flow`, a workspace-user diagnostic event
for the three latency-critical renderer flows. The renderer emits a closed
projection with exact total, phase, blocked, and pre-request milliseconds;
bounded structural counts; closed outcomes; and opaque work-stream/ticket
correlation identifiers. It travels through typed renderer intent, strict main
IPC validation, and the existing regional spool. Local `[perf]` output remains
available, but console objects themselves are not collected. The strict parsed
`renderer_perf_flow` record is also written device-locally to macOS Unified
Logging before the upload gate; the regional event path itself is unchanged.

An existing authenticated launch now initializes Product analytics admission
from the durable device choice and starts the canonical regional read only
after telemetry initialization, without awaiting it. Nonessential transmission
remains closed until that read succeeds.

**Why:** The approved feed-visible and send-ready product totals showed whether
the two-second goal was missed, and backend traces located server work, but a
packaged client's local phase line was unavailable after the fact. That left
the observed delay between ticket completion and socket upgrade ambiguous
between renderer scheduling, dial, handshake, and service wait.

Version 1.171.0 reset remote verification on every authenticated cold launch.
If its regional read exceeded or failed beyond the two-second launch barrier,
every nonessential event in that process was suppressed before spool admission
even when the durable account preference was enabled. That explains an
observed window with no accepted open, feed-visible, send-ready, or renderer
phase events and made the local console evidence disappear on quit.

**Considered and rejected:** Direct renderer-to-PostHog capture bypasses
preference, regional routing, validation, and the spool. Forwarding the console
object would make every future annotation exportable by accident. Adding the
phase list to the product feed-visible event would mix a diagnostic breakdown
with the authoritative user-visible outcome and its longer retention.

For the launch path: waiting longer spends more of the two-second product
budget without making telemetry reliable. Treating a same-account cached
enable as untrusted for the whole process preserves fail-closed behavior but
recreates the loss. Session changes close both local spool admission and
delivery until the new account is verified, and explicit enable still requires
the canonical compare-and-set acknowledgement; only ordinary cold-launch
reconciliation moved off the critical path.

Early launch events can enter the durable regional spool immediately when the
stored same-account preference is enabled. Successful verification releases
them for upload; a canonical disable purges them before any nonessential
transmission and turns collection off. Local Unified Log records never leave
the Mac and therefore do not depend on telemetry consent. Historical
console-only lines from 1.171.0 cannot be reconstructed after their renderer
exits.

### 2026-08-26 — Socket lineage survives an overlapping recovery retry

**What changed:** A monotonic socket-snapshot generation now fences the
renderer-only recovery cache. If a reconnect snapshot arrives while REST Retry
is in flight, late HTTP detail or transcript results cannot replace the
snapshot's `socket_snapshot` lineage or its canonical feed. Recovery windows
are consumed by their paired transcript read and cleared whenever a snapshot
becomes canonical.

**Why:** The source label describes the cache writer whose data reached paint.
Without a generation fence, request completion order could relabel and replace
a newer socket feed as `boot_payload` or `legacy_page`, corrupting the cohorts
used to judge the two-second cold-open goal.

**Considered and rejected:** Request cancellation is transport-dependent and
does not prove that no post-await side effect runs. Timestamp comparison can
tie within a millisecond and does not directly name the authority transition.

**Consequences:** Recovery code must check the captured snapshot generation
after every network await and return the current socket caches when superseded.
The generation is renderer-only coordination state and is never emitted as
telemetry.

### 2026-08-25 — Cold-open telemetry names the socket snapshot

**What changed:** `workstream_feed_visible.feedSource` now accepts
`socket_snapshot`, and a cold reader populated by its first SubstreamAgent frame
reports that source. The renderer records that lineage when each cache writer
runs rather than inferring it from unlike payload shapes. `feed_cache` remains
the already-present path, while `boot_payload` and `legacy_page` distinguish
embedded-window recovery from an older Worker's page fallback.

**Why:** The normal reader no longer issues the detail request. Labeling a
socket-populated feed as an HTTP boot or rollout fallback would make the new
critical path indistinguishable from the recovery path when diagnosing its
P90.

**Considered and rejected:** Reusing `boot_payload` because both shapes contain
canonical boot state. That name would preserve schema compatibility by hiding
the transport distinction the performance question needs.

**Consequences:** Existing analytics consumers must include the new enum value.
Cold-open queries should select `socket_snapshot` and join through the opening
operation and socket lease; `legacy_page` remains reachable during regional
version skew and REST cohorts stay separately queryable. The event still
contains no message content, URL, or authorization value.

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

### 2026-08-25 — Sidebar-to-painted-feed latency, every work-stream socket start, and each opening attempt's socket lease are measurable

**What changed:** Added `workstream_feed_visible`, emitted after a sidebar click
has committed its initial transcript and crossed one browser paint, with exact
total and data-ready milliseconds plus cache, pool, feed-source, sidebar, and
message-count dimensions. The click-scoped operation ID is reused as the detail
request ID. Added `workstream_socket_started` at the two work-stream socket
loops before every ticket request; it records control/feed kind, initial or
reconnect reason, retry bucket, and a matching operation/request ID.

Added `workstream_open_started` and terminal `workstream_open_outcome` events
under one click-scoped operation ID. Rapid switches emit `superseded`; query
failures emit `load_failed`; painted feeds emit `visible`. Each retained socket
owner now has one socket-lease ID shared by its control and feed starts.
Socket-start events retain their per-attempt request ID and additionally carry
the lease plus the pending opening ID when one exists; opening events record
the lease that served them.

**Why:** `workstream_opened` proved only that detail eventually loaded, local
perf lines died with the renderer, and socket-connected events began after the
initial feed gate. None could calculate average or percentile click-to-feed
latency, split data wait from paint delay, distinguish a cold open from a
hover-warmed control socket or retained pair, or count starts whose ticket or
handshake never succeeded. The user explicitly required this production
measurement and required pooled sockets and every start reason to be visible.

Work-stream and launch IDs were too broad, while the earlier operation ID
survived only on successful feed paint and the detail request. Replacing a
pending A measurement with B prevented misattribution but erased A, and the
separate socket request IDs could not connect a click to socket work. Pooled
sockets made parent-only correlation incomplete because a hover-warmed or
retained connection can legitimately begin before the click that consumes it.

**Considered and rejected:** Duration buckets cannot produce averages or P50,
P75, P90, and P99. Joining `workstream_opened` to clicks by timestamp is
ambiguous during rapid navigation. Treating a warmed control socket as a warm
feed is false: hover opens no SubstreamAgent connection or presence. Reporting
only successful socket connections omits ticket and handshake failures, while
instrumenting each pool caller would miss reconnects and future admission paths.
Direct renderer-to-PostHog capture was rejected because it bypasses consent,
regional routing, validation, and the durable spool.

Treating rapid switches as duplicate delivery would confuse user cancellation
with ingestion retry; `eventId` already handles the latter. Reusing one
operation ID for socket attempts and the click would collapse distinct ticket
requests. Adding only the opening ID to socket starts would still strand
pre-click warmups. The lease-plus-attempt model preserves both the pooled
lifetime and each actual request.

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

### 2026-08-24 — Accepted events feed a governed Global analytics lakehouse

**Why:** Backend and client producers already share one typed, preference-aware,
region-aware acceptance point. Projecting there preserves those controls and
makes maximal admitted metadata durable without adding direct client-to-vendor
authority.

**Considered and rejected:** A second analytics ingestion endpoint, direct
renderer Pipeline access, arbitrary autocapture, and reusing raw inference
storage. Each weakens policy or mixes incompatible privacy contracts.

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
`apps/site/trust/subprocessors/index.html` promises customers 15 days' notice before a
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

### 2026-08-13 — Telemetry review closes overcount and misattribution paths across connectors, shutdown, automation, and surfaces

**What changed:** Current desktop connector starts emit only the rich V2 intent,
carry its operation ID plus an explicit query version marker, and persist a
closed setup shape on the OAuth attempt. The terminal API event uses that same
version and operation ID for success or failure. Marker-less released clients
continue to receive only the V1 outcome.

Desktop quit is held once while graceful lifecycle and session events enter the
spool and one bounded flush runs; a 750-ms deadline always resumes exit. Run
and tool events attach automation metadata only when the harness run has an
automation origin and the work stream points to that exact automation run.

Redirect-only `/` no longer reports a duplicate home surface; reused running
Terminal sandboxes no longer report starts; native navigation carries a proven
source; released suggestion clients retain a legacy home fallback; public
dynamic paths and invalid handoffs use bounded truthful classes; and digest
telemetry cannot interrupt settlement.

**Why:** Emitting V1 and V2 for the same connector setup action double-counted
one person journey, while emitting V2 only after success omitted the exact
failures the funnel is meant to explain.

Electron does not await promises started from `will-quit`, and a work stream
can contain later person-initiated runs after automation created it. Without
these boundaries, normal-exit events disappeared and manual activity was
mislabeled as automation activity.

Each of the remaining issues produced structurally plausible events, so schema
validation could not detect the corrupted count or attribution. The
authoritative producer already knew the missing transition, source,
compatibility, or canonicalization fact.

**Considered and rejected:** For connectors: emitting both versions during
migration, inferring missing failure dimensions after OAuth returns, and
dropping the legacy outcome immediately. Those corrupt counts, fabricate
context, or strand released-client funnels. A new header was also rejected
because API and desktop deployments can race: an older Worker safely ignores
the query marker, whereas Chromium would block an unknown header at CORS
preflight and prevent connector setup itself.

For shutdown and automation: fire-and-forget shutdown writes, an unbounded quit
delay, and inferring run ownership from any automation row on the work stream.
Those respectively lose events, harm shutdown, or corrupt attribution.

For the remaining paths: dashboard deduplication and downstream repair. Those
approaches encode product behavior in provider queries and cannot recover the
omitted source or distinguish a true later transition.

**Consequences:** A connector attempt owns one immutable telemetry contract
version. New connector versions must negotiate at request admission and persist
every terminal property needed later; PostHog queries never union V1 and V2 for
one attempt.

New shutdown telemetry belongs inside the bounded barrier, and new automation
dimensions must be proved from the specific run rather than the container that
happens to hold it.

Producers must emit only real transitions, redirect routes do not own
observations, optional old-client context has an explicit fallback, and privacy
canonicalization runs before the envelope is built.

### 2026-08-13 — Product journeys are instrumented end to end with authoritative outcomes and no duplicate events

**What changed:** Expanded the closed registry and producers across surfaces,
suggested work, collaboration, resources, messages and elicitations, HyperSight,
Terminal, automation authoring, recordings, root runs, tool outcomes, connectors,
digests, invitations, and the public acquisition path. Where a richer contract
replaces the same semantic observation, current producers choose it once and
legacy contracts stay readable for released clients. Distinct request/outcome,
admission/terminal, and resource/outcome observations keep separate event names.
Authenticated product surfaces no longer also emit the legacy screen event, so
one navigation becomes one PostHog `$screen`.

Work-stream creation: replaced the renderer-produced `workstream_created` event
with one idempotent API event emitted by every user-visible creation path. The
event records a closed creation source and derives current work-stream state
from D1. Slack and connector-activity paths supply their canonical connector
type; suggested work resolves every distinct connector type from its retained
provenance roots. User-owned creations retain the person and workspace group;
unmapped Slack and workspace-owned automations remain personless workspace
events.

Resource journeys and tool adoption: added typed successful-operation events
for work-stream creation/open/switch/menu actions, automation creation/menu
actions, message send, resource copy, note creation/open/actions, and
transcription state. The regional harness now records every durably admitted
canonical tool invocation with resource correlations and a personless workspace
scope for unattended execution.

Application opens: cold starts and explicit reopens now emit a closed
`application_opened` signal with entrypoint and phase. A short main-owned
coalescer lets an accepted deep link or menu action override Electron's generic
activation callback. The Global adapter maps this event—not the separate
reliability transition—to PostHog's canonical `Application Opened` with
`application_open_source` and `from_background`.

Applied desktop settings: the main process now emits one actual settings
snapshot after launch initialization and after a newly authenticated account's
preference is verified. Successful launch-at-login and Lockdown interactions
preserve previous, requested, and applied booleans; successful icon selection
preserves the closed previous and selected icon states. Identified Global
captures update matching PostHog person properties with `$set`.

Menu and keyboard adoption: registered menu opens, menu actions,
Command-shortcut reveals, valid numbered navigation, and successful
suggested-work starts. Client events describe the observed interaction with
booleans, counts, and closed enums; the regional API owns the successful
suggested-work event after creation commits.

**Why:** Coarse screens and operation outcomes showed traffic but not the steps
that explain whether people discover, configure, complete, reuse, or recover
from the product's core workflows. Emitting both old and richer signals for one
occurrence would make the new detail useful only by corrupting totals.

The renderer could observe only composer and suggested-work responses. It
missed Slack and background automations entirely and could not truthfully say
which connector caused creation. Adding a second connector-only event would have
made creation totals depend on which path fired and corrupted funnels.

Screen and API-operation signals could show entry and outcome totals but could
not reconstruct the core resource journey or tell which agent capabilities were
actually used. Product analysis also needs stable joins from a copied output,
note, or automation back to its work stream.

Lifecycle data answered whether the process opened, but not whether a system
login, ordinary user launch, Dock activation, deep link, menu action, or future
native push brought the person in. Mapping both signals to PostHog's canonical
name would double counts.

Toggle clicks alone cannot answer the current-state question, and macOS can
accept a login-item request without applying it while approval is pending. Icon
and Lockdown operations can also fail or roll back before persistence is
authoritative.

Screen views and suggestion impressions could not form a truthful menu-open →
selection → successful-work funnel, and navigation alone could not separate
shortcut discovery from use.

**Considered and rejected:** DOM/keyboard autocapture and generic click
autocapture, provider-content capture, client-reported server success,
event-per-connector multiplication, arbitrary properties, and deleting legacy
readers immediately. Those alternatives lose semantic authority, expose
content, break rolling clients, or expand collection without a product
question.

For work-stream creation: client-supplied connector labels, provider account or
connection IDs, one event per connector, and parallel client/server creation
events. Those alternatives trust the wrong boundary, create high-cardinality
identity data, multiply a single creation, or double-count desktop paths.

For resource journeys: click-before-result events, treating tool availability
as usage, inventing a user for workspace automations, and capturing messages,
clipboard values, tool arguments, outputs, or summaries. Those alternatives
respectively create ambiguous events, false completions, person-profile
corruption, or content exposure.

For application opens: labeling every cold manual launch as Dock, deriving
notification source from an unmarked URL, and emitting parallel custom and
canonical open events. Electron cannot prove the first two, and the third would
corrupt open counts.

For settings: renderer click capture, treating requested state as applied
state, arbitrary setting names, and icon labels or paths. Those options
respectively report before commit, corrupt login-item analysis, widen
collection, or create mutable/high-cardinality values.

For menu and keyboard adoption: raw labels/routes/IDs and client-only success
reporting. They would respectively create content-bearing high-cardinality
data or count a failed/interrupted request as adoption.

**Consequences:** Resource UUIDs and closed taxonomy values enable joins while
titles, messages, arguments, outputs, tokens, and provider account identifiers
remain prohibited; approved opaque resource UUIDs are product properties, while
account/user identity IDs and all resource content remain prohibited. New
journeys must declare their single authoritative producer and prove no parallel
legacy/reserved destination event is emitted. Public-site regional and identity
behavior is owned by [`public-site-telemetry.md`](public-site-telemetry.md).

The work-stream UUID is the stable event identity; legacy UUIDv4 work streams
receive a deterministic UUIDv7 insert-id projection without changing the
resource ID. A suggested-work start uses its opportunity UUID as its idempotent
event identity, so it cannot collide with the companion creation event. A new
creation path must choose one closed source, resolve connector types from
server-owned provenance, and emit only after the durable work-stream write.
API-authored events must use the internal emitter; the authenticated desktop
batch route rejects them.

Cold launches without a login-item flag or deep link are `user_launch`.
`push_notification` remains dormant until a native notification callback
exists. Product analytics opt-out suppresses attributed opens; bounded
essential lifecycle events continue under their Rally name.

### 2026-08-13 — PostHog receives native desktop context and app semantics without duplicate events

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

The Global adapter also translates registered screen views and the matching
desktop lifecycle transitions to PostHog's canonical `$screen`,
`Application Opened`, and `Application Backgrounded` events. Desktop captures
and exceptions carry standard app, desktop-device, and OS properties. A
main-owned focus observer establishes the launch focus as its baseline, ignores
window-to-window focus handoffs, and reports later application background and
foreground transitions. Only API-originated captures are marked as server
events. Every destination event retains its single Rally registry name in
`rally_event_name`, and the live PostHog tool catalog is recorded with the
exact products this contract can and cannot truthfully drive.

**Why:** Navigation events alone made PostHog paths work, but built-in
breakdowns and session/application views remained poorer than data captured by
PostHog's first-party app SDKs. The adapter boundary can reproduce those
truthful desktop signals while preserving regional delivery and without placing
a provider SDK or token in the renderer.

PostHog's built-in navigation and application views key off reserved event
names and properties. Sending only Rally's internal spelling hid screen and
lifecycle semantics, while treating every regional delivery as server-side
would erase the originating desktop context. The provider mapping can supply
the SDK's native semantics without weakening Rally's regional or typed
boundary.

**Considered and rejected:** Copying the browser SDK's URL, host, referrer,
campaign, user-agent, and embedded-Chromium fields; exporting a hostname as a
device model; guessing hardware manufacturers; and reporting every existing
installation as newly installed. Those choices would respectively classify
Electron as web acquisition traffic, create identifying high-cardinality data,
invent device facts, or corrupt installation counts.

Also rejected: emitting both the custom and reserved event for one occurrence,
renaming the regional registry, embedding the provider SDK in the renderer, and
fabricating pageviews, flag exposures, surveys, replay snapshots, traces, or AI
generations. Duplication corrupts counts; the other options either move
provider concerns into the regional contract or claim observations Rally did
not make.

Design: [regional telemetry PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

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

### 2026-08-13 — Telemetry seams preserve policy and metric correctness

**Considered and rejected:** Removing idempotency, treating capture time as send
time, extending retention by offline delay, linking while rows merely have a
future retry scheduled, and automatically overwriting the canonical preference
after a conflict. Each would trade correctness or user control for a simpler
happy path. Silently dropping corrupt profile work, counting joined rows, or
assuming one source map per process were also rejected because they make healthy
operations and dashboards depend on accidental input shape.

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

### 2026-08-13 — Regional telemetry becomes an end-to-end production subsystem, from native dumps to operator surfaces

Native dumps: added whole-directory inactive rotation, absolute 14-day local
deadlines, durable generation invalidation, and corrupt/expired startup purge.

Raw crash retention: added an R2-prefix deadline sweep that deletes expired raw
crash objects independently of the D1 crash index and fails closed on missing
or malformed deadline metadata.

Native processor: added a CI gate that builds the symbolicator image and runs a
checksum-pinned real minidump/symbol pair plus malformed input inside the same
non-root, read-only, no-network boundary used by production. Its host fixture
directory grants traversal and read access to the container UID while the
mount itself remains read-only.

Regional Container development: added the local-supervisor port declaration
required by Wrangler and serialized configured Worker startups until
Global reports ready.

**Why:** Product analysis needs client intent joined to authoritative server
outcomes, while Electron crashes require a deeper lifecycle than a browser SDK
can provide. Centralizing policy in Rally keeps route, opt-out, identity, and
internal retention enforceable without giving the renderer provider authority.

Electron cannot stop Crashpad after it starts or attach authenticated headers
to its uploader. Rotation after handler exit preserves its supported ownership
boundary while fixed route/deadline metadata prevents later expansion.

R2 can accept a minidump immediately before an isolate fails to commit its
index row. A D1-only reaper could never discover that orphan, violating the
absolute internal retention ceiling.

Unit fakes and Wrangler configuration assertions proved orchestration but could
not prove that the pinned stack walker, Python wrapper, symbol layout, and
sanitizer interoperate in the shipped image. Native Linux preserves bind-mount
permissions, so private host defaults made the valid fixture look absent to the
non-root parser; Docker Desktop's file-sharing layer had hidden that boundary.

Concurrent Wrangler builds of the shared symbolicator image race on transient
Docker tags, while an exec-only image without an exposed port is rejected by
the local Container supervisor. Together these made the documented dual-region
development command fail after adding native processing.

For native dumps: reading the live database, direct Crashpad upload, and a
local stack-walking CLI as the production processor.

For raw crash retention: relying on the ingest catch block or the D1 reaper.
Neither runs after abrupt termination between the two durable writes.

For the native processor: keeping only mocked executor tests, checking that
the Dockerfile contains security-related strings, or running the integration
container as root. The first two do not execute the parser or observe the
report; the last one stops testing the production security boundary.

For Container development: duplicating the processor image/classes per region.
That would obscure the intentionally identical toolchain without removing the
underlying concurrent Docker-build behavior.

**Consequences:** configured deployments deployments need distinct telemetry R2
resources, Container support, migrations, capability secrets, and five-minute
maintenance. Release automation must publish private artifacts before
distribution. Provider-side PostHog lifecycle remains an operational
configuration outside this module.

Main can only upload a native dump on a later launch, opt-out requires restart
to stop dump generation fully, and every released target needs a real packaged
Crashpad fixture plus matching private artifacts.

Every raw crash write must keep the immutable `deleteAfter` metadata, and the
scheduled processor must retain the dedicated regional prefix sweep.

CI requires Docker and network access only to fetch two commit- and
checksum-pinned rust-minidump fixtures before disabling container egress. Test
fixture permissions must remain readable by UID 10001 without widening the
production image or its mount. A parser, image, symbol-layout, or sanitizer
change must keep this gate green.

Operators need separate regional bearer tokens and must use the role-matched
reason for raw access. Replay remains Global/security-only. Future cross-region
telemetry control methods must preserve the payload-negative RPC contract and
keep the signing key in Global.

Cross-region provisional journeys remain aggregate until a same-region identity
link exists. Operation IDs still correlate intent and outcome where both
survive in the same regional analysis surface.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).


## Changelog

### 2026-10-20 — Recover Electron network changes at the main-process boundary

**What changed:** The narrow main-process recovery path now accepts Electron
URL-loader network changes as well as connection resets, preserving the rejection
health signal and local diagnostic while keeping Rally running.

**Why:** An observed `net::ERR_NETWORK_CHANGED` reached the unhandled-rejection
boundary and was deliberately rethrown because recovery recognized only
connection resets, leaving an uncaught-exception dialog over the app.

**Considered and rejected:** Swallowing all network errors would hide failures
outside the observed transient loader cases.

**Consequences:** The explicit code list and real Electron loader frame remain
required. Unknown rejections and direct exceptions keep their fatal behavior;
request owners still own reconnect and retry.

### 2026-10-11 — `message_sent` is recorded by the API for every client

**What changed:** `message_sent` moved from a desktop-renderer intent to an API
outcome. The Channel object records it when it admits a person's message or
elicitation answer, and in `initialize` for an opening message that arrived
with the composer's `workstream_create` journey. The desktop intent, its allowlist entry and reporter method are gone.
SubstreamAgent now keeps the caller's non-session principal on the identity it
admits a message or answer with.

**Why:** The event was registered and wired in main, but no renderer code ever
reported it, so PostHog never received one. The browser bridge discards every
product intent, so a renderer producer would still have missed the web app. The
server sees every send from both clients, and a retried send is one event
because the id derives from the message.

**Considered and rejected:** Adding the missing renderer call and a browser
telemetry path. That is two producers for one fact, and the client cannot know
the send was admitted. `human_message_created`, also registered and never
emitted, was left alone: it has no browser channel and excludes elicitation
answers.

**Consequences:** Only a member's own session counts. Connector, demo-seed,
resource-authorization and support writes are excluded by principal or by the
impersonator the object reads from its own session lookup. An opening message
counts only with the `workstream_create` journey, so another creator that
should count must carry it. Counts are taken from what the object admits, not
the request: deduplicated, and before parent-owned seating projects new people.
The workerd suite sets `APP_ENV` to `test`, which the envelope rejects, so a
test there must set a deployed environment name on the object.

Shipped in [PR #1190](https://github.com/juno-ai-labs/avalon/pull/1190).

### 2026-10-07 — Connect browser and fresh-install entry to signup

**What changed:** Web entry links propagate an opaque signup flow to browser
entry and report it on the existing site action event. A new main-owned first
installation opening carries a persisted flow into desktop signup.

**Why:** Separate anonymous site and signup subjects hid abandonment between
selecting the web CTA and completing organization setup. Desktop also needed a
cohort anchored at the first opening rather than every sign-in screen.

**Considered and rejected:** Replacing the direct Mac download with browser
registration would change the acquisition experience. A static DMG cannot
reliably carry the visitor's identity, so its clicks remain separate.

**Consequences:** Join cross-subject stages by flow ID, validate incoming IDs,
retire first-install lineage after account changes, and deploy the API readers
before site and desktop producers. Download
clicks do not prove an installation or a completed desktop signup. Each CTA
activation needs its own flow, and browser reloads must preserve the tab's
attribution until authentication.

Shipped in [PR #1161](https://github.com/juno-ai-labs/avalon/pull/1161).

### 2026-10-07 — Observe the complete first signup journey

**What changed:** An opaque first-account flow connects verification,
organization access, and required introduction across browser and desktop.
Completion is deduped independently of late stage observers.

**Why:** Authentication counts could not locate abandonment during email
verification, joining an existing organization, or completing a new organization.
Using the entry platform for browser redemption also hid actual surface changes.

**Considered and rejected:** Client SDK capture would expose destination
authority on proof-handling pages; the existing regional collector already owns
closed events and analytics preferences. A new delivery ledger was unnecessary
for best-effort product analytics.

**Consequences:** Preserve first-flow lineage, proof privacy, current versus
entry platform, and stage emission even when completion wins a race. Deploy
migrations and all APIs before producers for complete correlation; older strict
start schemas receive a narrow validation-only fallback. View counts
are observational and can be inflated by unauthenticated callers.

PR: [#1146](https://github.com/juno-ai-labs/avalon/pull/1146).

### 2026-10-02 — Locate desktop-action waits and admit deterministic import runs

**What changed:** A closed desktop action-phase diagnostic records the action
ID, phase, elapsed time and visibility through the existing semantic intent
path. Run and tool producers derive valid operation correlation for UUIDv8
imports while retaining the original run ID in their properties.

**Why:** Production import transcripts showed a successful desktop answer
arriving after the tool deadline without enough evidence to locate the delay.
The importer also used UUIDv8 run IDs where telemetry context required UUIDv7,
silently losing otherwise valid tool and terminal events.

**Considered and rejected:** Widening every context ID, sending raw tool content,
or building another transport. A stable correlation projection and the existing
governed event path fix the observed gap without changing product identity or
the telemetry privacy boundary.

**Consequences:** Deploy the event reader before a desktop producer. Action
timestamps join durable rows; a sent answer is not proof of server receipt.

### 2026-09-29 — An unreadable stored event no longer stalls PostHog delivery

**What changed:** The PostHog outbox parses each selected row once with
`safeParse`. A row the running contract rejects is parked on the retry backoff
with its diagnostic code in `terminal_code`, logged as
`telemetry_delivery_row_unparseable`, and counted as `unparseable`; the rest of
the page is delivered. `TelemetryEnvelopeSchema` now reports each nested
property failure at its own path (`properties.entrypoint`) rather than one issue
on `properties`, so that code names the field.

**Why:** The selection loop used `.parse`. After a rollback below a contract
change, such as a widened enum, one stored row threw on every pass and blocked
all delivery behind it. The lakehouse path already used `safeParse` and rejects
such rows. PostHog parks rather than rejects because the rollback case is the
common one: the row is valid under the contract it was accepted by, and a
roll-forward should deliver it.

**What to respect:** No row in the outbox may be able to throw out of the
selection loop. A parked row keeps retrying until `delete_at`, so a genuinely
corrupt row costs one read an hour, not a stall.

### 2026-09-23 — Correlate organization socket opening across desktop and room

An organization could accept an upgrade while its sidebar stayed on
`Opening channels`, and existing connection-state telemetry could not say
whether the desktop sent `subscribe` or the room completed its first sync.
Add content-free, per-attempt desktop phases and matching WorkspaceDO phases,
joined by an optional UUID on the subscription. Keep the desktop signal in the
essential reliability class because this incident also affected clients with
product analytics disabled. This deliberately narrows the earlier decision to
keep `realtime_socket_state` behind opt-out: that event measures aggregate socket
churn, while these phases locate a failure that prevents the Organization from
opening at all. They are attributable and add several rows per attempt, an
accepted cost for diagnosing an unavailable app. Future handshake changes must
preserve old-client subscriptions and keep tickets, URLs, and directory data out
of these signals.

### 2026-09-18 — Retire regional observability copies after successful cutover

PR #835 deployed the dedicated telemetry and audit databases successfully. Drop
the inactive regional copies to remove their residual data and identity-migration
coupling, and stop reaping them. The existing Worker-first migration sequence
ensures the reaper no longer queries the tables when they are dropped. Keeping
unused history and permanent dual-database cleanup would leave the original
coupling in place; the agreed fire-and-forget cutover needs neither. The large
pre-recovery telemetry and audit backlog was already deleted during deployment
recovery. The approved cleanup also deliberately discards any remaining legacy
`audit_events` (no expiry) and `telemetry_replay_audit` (normally a 90-day deadline),
even before those replay deadlines, without export. This is a one-time retirement
decision, not a change to retention in the new databases.

### 2026-09-18 — Isolate event and audit storage from identity

Large observational tables made an identity migration fail during table copying.
Accepted telemetry and its transaction companions now use `TELEMETRY_DB`, while
audit events use `AUDIT_DB`. Existing background deferral keeps these writes off
product response paths. Separate bindings and a fresh cutover were chosen over
cross-database replication or backfill machinery; future changes must preserve
canonical preferences in `DB` and keep observational failures out of mutations.

### 2026-09-17 — Product actions no longer await observational telemetry

Converted product, tool, and run emitters now use one shared Cloudflare
lifecycle deferral. Their callers no longer wait for authoritative receipt
rereads made only to derive telemetry, analytics identity lookup, D1 acceptance,
or lakehouse Queue staging; failures are named in structured operational logs.
The product mutation and canonical run/tool receipts remain awaited before an
observation is scheduled. Making every caller hand-roll `waitUntil` was rejected
because it had already produced both synchronous latency and untracked floating
promises, while a larger telemetry job abstraction would duplicate the existing
D1 outbox and Queue recovery design. Direct telemetry ingest still awaits its
durable acceptance result because that result is the endpoint's product.

### 2026-09-17 — Recover Electron connection resets across sleep and wake

The desktop main process now contains the exact unhandled rejection Electron's
URL loader can emit when macOS resets an established connection during sleep or
wake. Previously Node promoted that transient rejection to an uncaught exception
and Electron showed its generic fatal JavaScript dialog even though Rally's live
network owners subsequently reconnected. Retrying the lost request at a global
boundary was rejected because its method and side effects are no longer known;
the process instead survives so each owning subsystem's existing recovery path
can run while retaining a payload-free fleet signal. Future changes must keep
the exact `ERR_CONNECTION_RESET` code and one real frame carrying both the
`SimpleURLLoaderWrapper` and `node:electron/js2c/browser_init` markers as
admission conditions. Unknown rejections must retain their original telemetry
origin, allow sibling rejection delivery to finish, and remain fatal.

### 2026-09-16 — Keep renderer crashes from becoming blank windows

The primary window now answers an unexpected renderer exit with a native,
main-process-owned restart-or-quit dialog. Previously the process-health observer
recorded the crash and closed the window's realtime sockets but left the
surviving `BrowserWindow` as a blank background, as observed when Rally 1.376.0's
renderer exited with `SIGTRAP`. Reloading inside that renderer was rejected
because the renderer no longer exists; a native dialog remains available at
exactly that failure boundary and relaunches through Rally's normal quit cleanup.
Future changes must preserve startup visibility (the recovery choice cannot be
parented to a window that never painted), keep crashed renderer contents out of
all shared broadcasts, and invalidate renderer readiness before queuing deep
links.

### 2026-09-14 — Fence retired meeting data before erasure

Built-in meeting event producers are removed. The collector, destination delivery paths, and desktop spool discard their historical typed events, including recording lifecycle and note-summary events. Dictation capture and its microphone permissions remain independent. Keeping the historical registry shapes allows old queued envelopes to be identified and suppressed rather than replayed into analytics. See [meeting retirement](meeting-notes.md).
