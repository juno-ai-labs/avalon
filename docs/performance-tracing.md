# Performance tracing

Five things in Rally are slow enough that a person notices: starting a work
stream, preparing a substream, confirming that substream, opening an existing
conversation, and sending a message. Each
spans the Electron renderer, a regional Worker, and two or three Durable
Objects, and until this existed the only measurement of any of them was the
`http_request` log row's total duration — a single number that says a create
took four seconds and nothing about which of its eleven awaited round trips took
them.

The tracing here is **Cloudflare's**, not ours. Both regional Workers enable
Workers automatic tracing, which instruments handler invocations, outbound
`fetch`, and binding calls — D1, KV, R2, Durable Objects — and exports the result
over OTLP. That is already everything an OpenTelemetry SDK would be installed to
provide: trace and span ids, parent/child nesting, context propagation across a
subrequest, and the exporter. **Do not add an OpenTelemetry package to this
repository, and do not mint a trace id or write a `traceparent` header** — the
runtime does not even expose a trace id to forge one from.
[`cloudflare-logging-and-tracing.md`](cloudflare-logging-and-tracing.md) is the
reference for what the platform does, what its custom-span API supports, and the
limitations that shape the code below; read it before changing anything here.

What this document covers is the layer on top: the custom spans that name the
steps inside one invocation, the attributes that say which workspace and which
person a slow trace belongs to, and the ids that join the traces the platform
necessarily keeps apart.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/observability/tracing.ts` | The whole API-side surface: `inSpan`, `inFlowSpan`, `inDurableObjectPhase`, `requestFlowSpan`, `noFlowSpan`, and `identityAttributes` — the one place a Rally identifier becomes an attribute name. |
| `apps/api/src/routes/workstreams.ts`, `routes/conversations.ts` | Root spans for work-stream creation/open/message flows and substream preparation/confirmation. |
| `apps/api/src/services/socket-service.ts` | `SocketService.upgrade`: the edge half of a socket open. |
| `apps/api/src/durable-objects/substream-agent.ts` | The room: product operations, socket acceptance, subscription, snapshot assembly. |
| `apps/api/src/durable-objects/workspace-do.ts` | Workspace synchronization and the released-client compatibility handler for the former parent-routed `create_message`. |
| `apps/api/test/helpers/cloudflare-workers.ts` | The Node suite's stand-in for `tracing`, and `recordedSpans()`, which is how a Node test asserts on span names and attributes. |
| `apps/desktop/src/renderer/lib/perf-trace.ts` | The renderer tracer, its governed diagnostic projection, and `newRequestId`. Not OpenTelemetry — see [The desktop half](#the-desktop-half). |
| `apps/desktop/src/main/native-performance-log.ts`, `apps/desktop/native/unified-log/UnifiedLog.mm` | The main-owned, schema-closed bridge from a renderer performance event to macOS Unified Logging. |
| `apps/desktop/src/renderer/lib/api.ts` | Stamps `x-request-id` on every HTTP call and prints one line per call. |
| `apps/desktop/src/common/logger.ts` | `logDebug`, the trace level the renderer's lines print at. |

## How it works

Interactive search uses the existing `renderer_perf_flow` diagnostic event with
`flow=workspace_search`. Its duration runs from the last query-changing keystroke
through painted authorized results (or a terminal no-match response). Empty pages
with continuation leave the trace open, including the user's wait before loading
another page. They must not count as completed first-result samples. The optional search timing fields separate
debounce, request, paint, scope resolution, retrieval, hydration, and server work.
Queries and result contents are never event properties. `text-search.md` owns the
pagination contract and p50/p90 acceptance targets.

### A custom span is a callback

```ts
await span.step("workstream.create.receipt.reserve", () => this.env.DB.prepare(…).run());
```

`inSpan(name, attributes, run)` wraps `tracing.enterSpan` from
`cloudflare:workers`. The span ends when `run` settles — resolved or thrown —
and the runtime records the throw. Two platform behaviors do the rest, and they
are why there is so little code here:

- **Spans nest by async context.** Anything that runs inside the callback —
  another `inSpan`, a D1 query, a Durable Object call — becomes its child
  automatically. There is no manual parenting, and the runtime exposes no
  `spanContext()` to do it with even if there were.
- **`console` output is attributed to the active span.** Every
  `logStructuredEvent` call made inside one of these spans is exported as an
  OTLP log record carrying that span's trace id, so a destination correlates the
  logs to the trace with no work from us. This is the whole reason the logger
  stays as it is: a structured object per `console` call, indexed fields, one
  `message` summary.

`span.setAttributes` takes a record and skips anything `undefined` or `null` —
an attribute is set or absent, never present-and-empty, because
"present-and-empty" makes *unknown* indistinguishable from *known to be nothing*
in a dashboard. `span.setError(code, message)` writes `otel.status_code`,
`error.type`, and `otel.status_description`; the runtime has no `setOutcome`
yet, and those are the attribute names every OTLP backend already reads a status
from.

### A flow span also lands in Workers Logs

`inFlowSpan` is `inSpan` plus two things: it stamps the flow and identity
attributes on the root, and it accumulates each `step`'s duration so the flow
**also** emits one `perf_flow` log row carrying the whole breakdown, its
`slowest_step`, and the identity.

Two properties of `step` decide how a flow has to be written:

- **A step's duration is measured from the end of the previous step**, not from
  its own `inSpan`. Anything awaited *between* two steps is charged to the later
  one. Every awaited call inside a flow therefore belongs inside a step — an
  unstepped `await` does not go unmeasured, it silently inflates its neighbour
  and makes `slowest_step` name the wrong thing.
- **`rally.flow` and `rally.component` are repeated onto every step span.**
  OpenTelemetry does not inherit attributes from a parent, so a step span
  without them cannot be filtered or grouped by the flow it belongs to. The
  identity attributes are deliberately not repeated: they are many, the step
  already shares the root's trace, and `perf_flow` carries every step's duration
  beside the identity, which is the path built for aggregating across requests.

**One person opening a work stream produces about eight of these rows, not
one — and the rows are the small half of what an export ships.** A flow is per component invocation, and an open crosses the detail read,
the transcript read, the socket ticket, the socket upgrade, the room's accept,
its subscribe, and its `get` and `messages` calls. All unconditional, both
regions, at `LOG_LEVEL: "info"`. The one-row-per-flow decision below is still
the right one — per *step* would be roughly forty — but eight is the number to
budget against, and only for the rows.

What actually leaves at `head_sampling_rate: 1` is every *automatic* span in
those eight invocations: one `durable_object_storage_exec` per embedded query
and one D1 span per query, which is a different order of magnitude from the row
count and is the figure that matters for ingest volume. Sampling is the wrong
knob for the content question and the right one for this; nothing here has
measured it under load, and it should be before the export runs unattended.

That row is not a duplicate of the trace. A trace answers *what happened in this
one invocation* and is read in a trace UI or at the OTLP destination; the row
answers *which step is slow across ten thousand creates* from the Workers Logs
Query Builder, with no join and no trace sampling in the way. It is not free:
Cloudflare bills a span and a log event identically, out of one allowance, so
the row costs the same as adding a thirteenth span. One row per flow is the
budget it is worth.

### Inference-start SLO boundary

The user-facing target is measured from the regional Worker receiving the
request to the harness issuing the first provider request: p50 500 ms and p90
2 seconds. It is deliberately separate from provider time to first token.

For `workstream_create`, `substream_create`, and `message_send`, the server
captures `telemetryRequestReceivedAt` in the first Worker middleware (or at
socket invocation entry) and carries a stable journey name in the durable
execution receipt. Immediately before the first provider dispatch of the first
durable attempt, the inference logger emits `agent_inference_started` with
`request_to_inference_start_ms` and archives the same boundary in that request
row's `metadata` JSON. Later model calls and recovered attempts retain their
ordinary request archives but omit this SLO field, so percentile queries filter
for its presence rather than deduplicating a whole agentic run. A negative
cross-isolate wall-clock delta is marked `request_clock_skewed` and omitted from
the duration distribution instead of being clamped to zero. The terminal
attempt's existing `ttft_ms` measures provider request to first token. Join the
two rows on `inference_request_id`; use `operation_id` in the regional log or
`metadata.operationId` in the lakehouse to join the result back to the product
journey. Do not add these two durations together when reporting which side of
the boundary missed its target.

Immediately before the final liveness pulse and provider setup, the harness
also emits `agent_inference_prepared`. Its synchronous fields partition the
pre-provider wait into `initial_authority_ms`, `context_tools_ms`, and
`scope_activation_routing_ms`, plus harness-local `total_ms` and the full
`request_to_prepared_ms`. This is a Workers log only: it does not write PostHog
or the lakehouse, and it introduces no promise or await. The preparation blocks
intentionally overlap independent reads, so the fields name elapsed
critical-path regions rather than claiming that their individual operations
add up serially. Like the inference-start row, it emits only for the first
durable attempt. `request_clock_skewed` is true, and
`request_to_prepared_ms` is omitted, when the request timestamp is later than
the preparation timestamp.

The same row carries raw elapsed durations for the operations inside those
regions: `initial_identity_run_ms`, `persisted_outcome_ms`,
`initial_run_authority_ms`, `sidekick_authority_ms`,
`sidekick_recommendations_ms`, `lease_heartbeat_ms`,
`run_context_ms`,
`transcript_bootstrap_ms`, `tool_inventory_ms`, `tool_construction_ms`, and
`attachment_replay_ms`.
`transcript_bootstrap_required` distinguishes a fresh canonical projection from
a resident persistent-loop projection, and `sidekick_snapshot_reused`
distinguishes a pinned Sidekick snapshot from fresh discovery.
`sidekick_recommendations_read` distinguishes a
skipped conditional dependency from a real `0 ms` result. These durations also
overlap: recommendation discovery may be nested inside guest Sidekick authority,
tool inventory begins before the lease heartbeat, while tool construction begins
after it, and run context, tools, transcript, and attachment replay then proceed
concurrently. Use each field to identify the slow dependency, never add them
together.

`initial_run_authority_ms` names the membership, identity, parent, and optional
automation authority read that starts the run. Bind repeats run authority immediately before each provider request in its
`before_model` liveness callback; loaded Sidekick skills keep the run snapshot. That later fence occurs after `agent_inference_prepared`; its
wait remains in `request_to_inference_start_ms`, not this initial-authority
field or `total_ms`.

The first provider request also emits `agent_inference_start_breakdown`, joined
to `agent_inference_started` by `request_id` and `inference_request_id`. It
records `run_started_at`, `preparation_finished_at`, and
`provider_request_hook_at` for a local timeline, then `post_prepared_ms` plus the awaited scope persistence, activation-hint
wait and load, initial activation total and summed authorize/prepare/persist
durations, model-routing wait and load, first lease renewal, response-activity
write, and the `before_model` lease and authority checks. Activation requested
and persisted counts distinguish an empty hint set from serial plugin setup;
authorization-check, dynamic-tool-load, and activation-write counts expose
which operations were actually attempted. `initial_activation_details` retains
the authorization, preparation, and persistence durations for each requested
canonical plugin ID, including nested connector-health and durable-write
durations, so one slow item among the concurrent activation checks is identifiable. The
detail is an object with `plugin_0`, `plugin_1`, and later keys so the structured
logger retains every entry; `plugin_id` inside each entry names the plugin.
`initial_activation_auth_check_count` is numeric (the logger masks fields named
`authorization`). The catalog source is `provided` when the host's KV snapshot has windows,
`fallback` when it is empty, and `skipped` without compaction. Bind no longer
fetches the OpenRouter catalog on the inference path.
`tool_surface_hash_ms` precedes scope persistence; `scope_ownership_ms`,
`scope_hash_ms`, and `scope_write_ms` divide that persistence call.
`activation_run_write_ms` and `activation_hint_write_ms` divide its two durable
writes; for credential plugins, `activation_connection_context_ms`,
`activation_provider_health_ms`, and `activation_health_verdict_ms` divide
authorization. Initial authorization checks overlap across plugins; their
summed durations may exceed `initial_activations_ms`. Bind's
`bind_plugin_rehydration_ms` now excludes a second connector authorization
for IDs this host just checked and persisted, but still includes eligibility
and any dynamic tool loading. `before_model_principal_ms` and `before_model_identity_ms`
separate the D1 membership and Channel identity reads; conversation and
automation authority fields appear only when that path runs. The forced lease
renewals expose their attempt and persistent-loop parts as
`liveness_inference_start_*_ms` and `liveness_before_model_*_ms`.
When a stage joins an already running renewal, its `*_coalesced_ms` field
records that wait instead of attributing the underlying attempt to both stages.
`bind_*_ms` fields time plugin runtime creation, resident-context render,
skill setup and restored-plugin activation, projection setup and validation,
activation boundary, active-plugin reauthorization, provider resident-context
render and transcript validation, system projection and provider-input hash,
`before_model` callback, provider-boundary write, assistant reservation and Bind
transition, request-message conversion, route pricing and planning, and route
preparation. `bind_plugin_reauth_ms` uses a short key because the logger masks
keys containing `authorization`. `context_catalog_source` records the supplied
snapshot or fallback; catalog fetch subphase fields are no longer emitted. The row is emitted synchronously
at the first provider-request hook, with no telemetry await. It is diagnostic:
loader durations can overlap their waits, and any unaccounted portion of
`post_prepared_ms` is work between named awaited stages, not proof of one
particular dependency.

Durations come from `Date.now()`, which workerd pins for the duration of a
synchronous run and advances only across I/O — a Spectre mitigation, and the
same reason Cloudflare documents its own spans as sometimes reporting `0 ms` for
work that took longer. A step's number is therefore the time it spent waiting on
D1, a Durable Object, or a provider, and a step that is pure computation reads
`0ms` however long it took. Nothing on these paths is CPU-bound.

### Durable Object cold-wake phases

The automatic Durable Object binding span is the end-to-end clock from the
caller through binding transport, object wake, construction, and the invoked
method. Rally adds two nested custom spans and matching structured log rows to
make the previously opaque constructor portion queryable:

- `durable_object.initialize` / `durable_object_initialization` covers the
  complete `blockConcurrencyWhile` input gate for each migratable class.
- `durable_object.schema_migrate` / `durable_object_schema_migration` covers
  every migration pass, including a current-schema no-op. It does not change
  the migration tracker's deduped report policy.

Both carry the component, class, latest version, status, and observed
`duration_ms`; failures set the span error and rethrow unchanged. Read the
binding span as total, the initialize span as object initialization, the nested
schema span as migration wait, and the remainder as binding transport plus
platform wake. That remainder is a diagnostic residual, not a separately
measured platform phase. The pinned workerd clock caveat above applies: a
`0 ms` schema span means no observable clock advance, not proof that no
synchronous SQL or CPU work ran.

### Attribute names

Everything below is namespaced or conventional on purpose: Cloudflare's own
`cloudflare.*` span and attribute names are explicitly **not final** during the
tracing beta, so a dashboard should filter on the `avalon.*` names this
repository controls wherever it has the choice.

Semantic-convention names where OpenTelemetry defines one — `user.id`,
`session.id`, `http.request.method`, `http.route`, `http.response.status_code`,
`otel.status_code`, `error.type`. Everything this product owns is namespaced
under `avalon.`, so it can never collide with a convention added later:

| Attribute | Meaning |
| --- | --- |
| `rally.flow` | `workstream_create`, `substream_prepare`, `substream_create`, `workstream_open`, or `workstream_message_send`. |
| `rally.component` | Which participant emitted it: `api`, `api_socket`, `substream_do`, `workspace_do`. |
| `rally.workspace.id`, `rally.workstream.id`, `rally.substream.id` | The identifiers a slow trace has to be attributable to. |
| `rally.request.id` | The desktop's `x-request-id`. |
| `rally.analytics.person_id`, `rally.analytics.workspace_id` | What PostHog knows the same person and workspace as. See [Joining a system span to a product event](#joining-a-system-span-to-a-product-event). |
| `rally.auth.duration_ms` | What authentication cost, which the flow's own duration excludes. |
| `rally.socket.ticket_id`, `rally.socket.connection_id` | The two socket joins below. |
| `rally.socket.room_accept_ms`, `rally.socket.room_outside_accept_ms`, `rally.socket.room_instance_age_ms` | On the edge's upgrade: how long the room's own accept ran, the remainder of the `room_upgrade` wait (routing, activation, constructor/readiness, and queueing), and instance age at accept entry. See [What `room_upgrade` contains](#what-room_upgrade-contains). |
| `rally.room.instance_age_ms` | On the room's accept: milliseconds since this instance's constructor began. Near zero means this upgrade is the call that woke it. |
| `rally.message.client_id` | The composer's client message id. |
| `rally.snapshot.bytes`, `rally.snapshot.message_count`, `rally.snapshot.trims` | What a subscription had to assemble. |
| `rally.create.path`, `rally.create.receipt_state`, `rally.create.first_naming` | Which create this was. |

A message-send span ends when the immutable turn has been accepted as either
canonical or pending. It deliberately carries no agent-invocation or harness-run
attribute: admission may wake the persistent loop, but it does not prove that an
execution has started or identify which later execution receipt will deliver the
turn. `rally.harness_run.id` remains valid on work-stream creation and actual
execution spans, where a real subordinate receipt exists.

`identityAttributes` in `tracing.ts` is the only place a Rally identifier
becomes an attribute name. Add a name there rather than at a call site, so a
rename happens once and a dashboard filtering on `rally.workspace.id` never has
to know which component emitted the span.

### Joining a system span to a product event

A span carries both identities: `user.id` and `rally.workspace.id` are the
product keys, and `rally.analytics.person_id` and
`rally.analytics.workspace_id` are the surrogates PostHog is keyed on
(`users.analytics_person_id`, `workspaces.analytics_workspace_id`). Carrying
both is the whole point — one lets an operator go from a slow trace to the
person to talk to, the other lets them go from that trace to what the person was
doing in the product, without reconstructing a mapping by hand.

**They are read on the query that authenticates the request, and nowhere else.**
`authenticate` in `apps/api/src/middleware/auth.ts` already joined `workspaces`
and is one primary key from `users`, so both surrogates arrive on a round trip
the request was making anyway. There is no cache to invalidate and no second
store to keep in step. Both are LEFT joins: a column added for observability
must never be able to decide an authentication.

What "free" means here is precise, and worth being precise about, because that
session query is **not cached** — every authenticated request pays it, blocking,
before its handler runs. Adding the two columns adds no round trip and no scan:
against the checked-in migrations, `EXPLAIN QUERY PLAN` shows the new join as
`SEARCH u USING INDEX sqlite_autoindex_users_1 (id=?)` — a primary-key point
lookup, the same shape as the two joins already there — and the statement grows
from 57 to 71 VDBE operations, all on pages the query is already touching. The
network hop dominates both numbers by orders of magnitude.

That the query itself is uncached is a separate question from this change, and
[Failure modes and limits](#failure-modes-and-limits) says what is known about
it and what the levers are.

They are **absent until a product event mints them**, which is correct rather
than a gap — the pipeline creates them lazily, so before the first one there is
no PostHog person for a trace to point at. `setAttributes` drops nulls, so the
attribute is simply not there.

**Which spans carry which**, and why it is not uniform:

| Span | Person | Workspace |
| --- | --- | --- |
| Anything rooted in an HTTP request | yes | yes |
| A Durable Object reached over a binding call | inherited — the span is a child of the HTTP root above | inherited |
| `workstream.room.socket.accept` / `…subscribe` / `…create_message` on SubstreamAgent, `workstream.message.send` on the legacy WorkspaceDO path | no | yes |

The socket-rooted spans are their own traces, so they need identity of their
own. They get the workspace surrogate from the `workspaces` row their
authorization query already joins. They deliberately do **not** get the person
surrogate: that would mean a Durable Object joining `users` on every socket
frame, and no diagnostic is worth widening what a socket's authorization depends
on. A socket trace is one hop from an HTTP trace that has it — through
`rally.socket.ticket_id`, `rally.socket.connection_id`, or
`rally.message.client_id` — and it still carries the raw `user.id`, so the
"who do I talk to" question is answerable without the hop. Only the PostHog
person join needs it.

The objects set what they do have after their own session query answers, rather
than accepting it over RPC; `WorkstreamObjectClient` narrows the auth payload it
sends for exactly this reason. A correlation value arriving from outside is one
the object would have to decide whether to trust, for something it resolves
anyway.

Nothing authorizes on either attribute. They are correlation values, and the
authority for who a request belongs to remains `userId` and `workspaceId`.

### What the platform cannot join, and what does

Automatic tracing links a Worker to everything it calls. It cannot link two
separate client-initiated invocations, and each of these flows has at least one
seam of that kind. Each is bridged by an **attribute both traces carry** —
deliberately an attribute and never a stand-in trace id, because a hand-made
trace id would build a second trace graph beside the platform's and the two
would never meet.

| Seam | The attribute that crosses it |
| --- | --- |
| Renderer → Worker, over HTTP | `rally.request.id`, from the `x-request-id` the desktop mints per call and the Worker echoes. |
| Sidebar click → each retried `GET /workstreams/:id` | `rally.operation.id`, from the click-scoped `x-rally-operation-id`. Each HTTP call keeps its own `rally.request.id`. |
| `GET …/socket` → the WebSocket upgrade → the room | `rally.socket.ticket_id`. A browser can attach no header to a handshake — see [`realtime-sockets.md`](realtime-sockets.md) — so the ticket id, which the issuing route logs and the room consumes, is the only shared value. |
| The room's upgrade → the `subscribe` that follows | `rally.socket.connection_id`. `subscribe` arrives on a later invocation, possibly on a woken isolate. |
| Renderer → admitted SubstreamAgent socket | `rally.message.client_id`, which the renderer, the command, and the private command result all carry. |

### The five flows

**`workstream_create`** — `POST /workstreams` opens `workstream.create` and the
creation service adds a span per awaited call:
`workstream.create.authority.read_recheck` (named for the second read it is —
the route already resolved the same row), `…receipt.reserve`, `…receipt.read`,
`…email_address.reserve`, `…d1_rows.write`, `…parent.reserve`,
`…child.initialize`, `…directory.flush`, `…route.activate`, and
`…receipt.complete`. The child initialization and provisional directory flush
are distinct sibling steps that run concurrently, so either latency source can
be assigned without serializing them. Inside `child.initialize` the room adds
`workstream.room.initialize` and its children. A replayed create is labelled
`rally.create.path = replayed_receipt` so it does not sit in the same
distribution as a first one.

**`workstream_open`** — four traces, joined by the attributes above: the
socket-ticket route (`workstream.socket.ticket`), the edge upgrade
(`workstream.socket.upgrade`), the room's acceptance
(`workstream.room.socket.accept`), and the room's subscription
(`workstream.room.socket.subscribe`). A main-feed ticket also emits
`workstream_socket_ticket_warm_finished` after its deferred room preparation
settles; its `ticket_id`, `duration_ms`, `outcome`, and `preparation_outcome`
show whether ticket transit covered storage readiness, admission, and snapshot
assembly before the joined upgrade arrived. Upgrade records
`rally.socket.admission_source` as `ticket_preparation` or `regional_fallback`,
and snapshot delivery records `rally.snapshot.source` as `ticket_preparation`
or `room_assembly`; `ticket_preparation_incomplete` means admission was ready
but the snapshot was speculative, superseded, invalidated, or contained
pending-input spill and therefore assembled at upgrade. Both admission cohorts
retain `workstream.room.socket.authority_read` for the current maintenance
phase; only fallback has `workstream.room.socket.member_authorize`. When the
subscription's plan needs a fresh room snapshot,
`workstream.room.snapshot.detail`, `…transcript`, and `…encode` sit inside it;
the prepared path has no upgrade-time detail span. `rally.snapshot.trims` is
worth reading beside the byte size. A
subscription snapshot also records `rally.subscribe.snapshot_reason` as
`initial` or `history_unavailable`, so hibernation recovery can be separated
from a cold open. The trim loop re-serializes the whole frame per dropped
message, and that count is the only place its cost appears.

Normal navigation
issues neither detail nor transcript REST reads. Canonical history recovery
uses snapshot-fenced `load_transcript_range` requests on the admitted
SubstreamAgent socket. When replay is unavailable or the client cursor is
ahead, main and child conversations both abandon that connection, reset the
addressed cursor, and reconnect from zero for a new authoritative socket
snapshot. Retry restarts the same bounded socket opening sequence; it does not
race a metadata REST read.
Current feed tickets carry the signed resume cursor, so socket acceptance and
the first subscription normally share one Durable Object invocation. Older
client/server combinations retain the explicit subscribe frame as a rolling
deployment fallback. `durable_object.runtime_recovery` measures lease repair
and alarm re-arming separately from schema/repository readiness, so a cold wake
does not hide recovery work inside socket acceptance. The edge and room spans
both record `rally.socket.after_sequence`; speculative tickets additionally
record `rally.socket.speculative`. A failed accept-time bootstrap records
`rally.socket.subscription_bootstrap_outcome = failed` and closes the socket,
while a failed runtime-recovery attempt is logged and retried by the next
mutation rather than remaining a permanently rejected gate.

**`workstream_message_send`** — the desktop sends over the already-admitted
SubstreamAgent socket, so `workstream.room.create_message` is the trace to read:
`workstream.room.product.create_message`, optional `…loop.activate`, and
`…respond`. There is no WorkspaceDO span, second session query, or parent-to-child
binding call on the current desktop path. `POST /:id/messages` traces the same
flow for the HTTP path, distinguished by `rally.transport`; the old
`workstream.message.send` WorkspaceDO trace now identifies a released desktop
using the rollout-compatibility handler.
The renderer's `resolve_mentions` phase reads the already-owned
`['workspace-members']` roster when the outgoing text contains `@` or
`person://`, falling back to a workspace-roster request when that cache is
absent or cannot resolve any typed person. Ordinary text proceeds directly to
the socket command round trip.

### What `room_upgrade` contains

`workstream.socket.room_upgrade` measures the edge's entire wait for the room.
The accepted 101 reports two internal headers, stripped before the client
handshake. The edge records:

- `rally.socket.room_accept_ms`: elapsed time inside the accept handler.
- `rally.socket.room_outside_accept_ms`: `max(0, room_upgrade - room_accept_ms)`.
  This includes routing, cold activation, constructor/schema readiness, input
  gate queueing, and other work outside the accept handler. It is not a direct
  measurement of platform activation.
- `rally.socket.room_instance_age_ms`: age since construction at accept entry.
  A small age suggests a recent activation; another concurrent call may have
  woken the object. A large age can include idle lifetime, so do not subtract it
  from the remainder to estimate platform time.

Read the remainder beside constructor phases and invocation logs before
assigning a cause. Workerd's clock advances across I/O, so zero-duration
synchronous phases do not prove zero CPU work. The investigation procedure is
in [production error investigation](production-error-investigation.md#a-slow-call-into-a-durable-object).
The motivating observations are recorded in this document's changelog.

### The desktop half

The renderer is not a Worker, so automatic tracing does not reach it and there
is no span to attach to. It is deliberately **not** an OpenTelemetry client:
shipping a browser SDK and an exporter out of the Electron renderer would move
telemetry off the main-owned regional path [`telemetry.md`](telemetry.md)
requires everything to travel on.

Instead `RallyApi` stamps a distinct `x-request-id` on every call and prints one
`[perf] http <method> <path> <status> <ms>` line, and each flow prints one
`[perf] <flow> <ms>` line carrying its phases and the correlation ids above.
The work-stream detail call additionally sends the pending sidebar attempt as
`x-rally-operation-id`, so React Query retries remain separate requests under
one product opening attempt.
Both go through `logDebug`, which is `console.debug`: filtered out of DevTools
and of a terminal until a reader opens the Verbose level. That is what lets it
stay on in every build rather than behind a preference nobody had enabled when
the slow open happened.

Creation flows use that same projection but finish at the existing two-frame
painted send-ready boundary. An ordinary `workstream_create` carries its
operation ID from the POST across navigation instead of ending at
`navigation_requested`. `substream_prepare` emits preparation-to-preview and
`substream_create` emits confirmation-to-ready under one operation ID. The ready sample's
`systemWaitMs` adds those two measured intervals and excludes the person's
unbounded review time between them. It includes summary preparation and every
post-confirm socket/context wait. The acceptance targets remain P50 below one
second and P90 below two seconds; instrumentation does not establish that they
are met.

`dictation_start` is the one flow that stays device-local: it is opened with
`report: false` because the `renderer_perf_flow` event's schema enumerates its
flows and phases and carries neither, and adding them is what would make it a
reported flow.
[`conversation-surfaces.md`](conversation-surfaces.md#dictation-capture-and-connection-startup)
owns the flow and names its phases.

On macOS, main also writes that same closed projection to Unified Logging under
subsystem `ai.rallywith.desktop` and category `performance`. The local write
happens before the telemetry preference gate, is device-only, and cannot change
or delay the measured operation. It makes completed traces available across app
sessions in Console.app even when Product analytics is disabled or upload is
offline. It still does not forward arbitrary console objects: only the event
that passed the strict renderer-intent parser is written. macOS owns retention.

#### Telling a slow renderer apart from a slow service

A renderer phase is wall clock, and wall clock cannot say whether the client
was waiting or was simply not running. A promise continuation does not execute
while a long task holds the main thread, so a phase reading three seconds is
the same number whether a socket was connecting or the transcript was
rendering — and those have opposite fixes. Two things separate them.

Every flow line carries **`blockedMs` and `longTasks`**: the `longtask` entries
overlapping that flow's window, from one process-wide `PerformanceObserver`
rather than one per trace, since several work streams hold open traces at once.
Entries are counted by their overlap with the window, not whole, so a flow that
ends mid-task is not charged for work that outlives it. A slow flow with
`blockedMs` near zero was genuinely waiting on something else; a slow flow with
`blockedMs` near its duration was never in a position to ask. The entry type is
absent in jsdom and on some Chromium builds — the numbers then read zero, which
is a gap in the diagnosis and never a broken flow.

`workstream_open` also splits the wait for its socket in two.
**`dial`** closes when the renderer has created its socket adapter and admitted
the open to main, and **`handshake`** closes on the open event relayed from the
Node broker. Nothing is awaited between the ticket resolving and `dial`, so a
large `dial` can only mean the renderer was not running; main-process IPC,
network setup, TLS, the Worker upgrade, and the Durable Object acceptance are
all inside `handshake`. One number across both read as a slow server either way.
And **`sinceEffectMs`** reports how long
the work stream was on screen before the attempt's first request left: on
attempt zero that is dead time no trace can otherwise see, because the trace
does not exist until `connect` runs. On a reconnect it is the age of the effect
and the backoff explains it.

## Invariants

- **No OpenTelemetry package, no hand-made trace id, no `traceparent`.** The
  platform owns trace identity and propagation. Anything minted here becomes a
  second trace graph that never joins the first, and the failure is silent:
  every row still looks right on its own.
- **A step is named, or it is not traced.** `noFlowSpan` opens no spans and
  emits no rows, so a background path costs nothing. What it must not do is open
  spans under a flow it is not part of.
- **An attribute is set or absent.** `setAttributes` drops `undefined` and
  `null` rather than writing an empty value.
- **`identityAttributes` is the only place an id becomes an attribute name.**
- **`x-request-id` is not authoritative for anything.** It is a client-supplied
  correlation label; `requestContext` validates its shape and mints one when it
  is absent or malformed, and nothing authorizes, routes, or bills on it.
- **Observation never changes the operation.** `noFlowSpan` is a working
  `FlowSpan`, `step` returns exactly what its callback returns, and a step that
  throws rethrows unchanged.
- **No content is recorded *by this module*.** Counts, ids, sizes, and status
  codes only. The logger's `redact` still applies to the `perf_flow` row, but it
  is a backstop rather than the rule, and it does not apply to span attributes
  at all. Note that this invariant is about what we add: the platform's own
  Durable Object SQL spans carry bound parameter values, and therefore message
  content, whatever this module does — see
  [`cloudflare-logging-and-tracing.md`](cloudflare-logging-and-tracing.md#what-automatic-tracing-captures-that-we-would-never-log).

## Boundary

This module owns latency diagnosis for the named product flows, including
workspace search and the work-stream flows described here.

- **Its exported projection is diagnostic telemetry, not a product outcome.**
  [`telemetry.md`](telemetry.md) owns its regional routing, closed schema,
  retention, and preference gate. `renderer_perf_flow` exports the approved
  phase timings and long-task overlap; `workstream_feed_visible` and
  `workstream_send_ready` remain the authoritative product measurements for
  click-to-painted-feed and click-to-sendable-composer. The local line may carry
  additional debugging fields that the event deliberately rejects. Worker
  spans and API-side `perf_flow` rows remain outside the telemetry destination
  adapters and under Workers Traces and Workers Logs retention.
- **It is not the run ledger.** A harness run's duration, tokens, and cost are
  `harness_run_finished` and the `RUN_ANALYTICS` dataset, described in
  [`runbook.md`](runbook.md#root-run-analytics). Tracing stops at the run
  dispatch: the run is asynchronous by design and is not part of what the caller
  waits for.
- **It does not configure the exporter.** Where traces and logs are sent is
  `observability` in the Wrangler configs plus the account's OTLP destination,
  and neither is decided here.
- Callers are the routes, services, and Durable Objects listed above. New spans
  are welcome inside the documented flows; another flow means adding a name to
  `PerfFlow` and a section here.

## Failure modes and limits

- **Custom spans require `observability.traces`.** With it disabled the
  callbacks still run and the `perf_flow` rows are still written, but nothing is
  exported — the failure looks like missing traces, not like an error.
- **A flow's step list is capped at 64**, after which steps are dropped from the
  summary row and a `steps_truncated` marker is appended. The clock is not
  reset, so the total and every earlier step stay truthful. Spans themselves are
  not capped here; the platform's own limits apply.
- **`0ms` means "no I/O", not "instant"** — see the clock note above.
- **Spans and log rows are billed identically from 1 October 2026** — one
  observability event each, 20 million a month included on the paid plan, $0.60
  per million beyond it — and head sampling is 1 in both regional configs. A
  create emits roughly a dozen custom spans plus one `perf_flow` row on top of
  the platform's own spans, so lowering `head_sampling_rate` — which can be set
  separately for logs and traces — is the lever if volume becomes the problem,
  not deleting spans.
- **Span and attribute names are not final upstream.** Cloudflare may rename
  `cloudflare.*` attributes during the beta; a saved query built on one can break
  without a deployment here.
- **`perf_flow` does not include authentication.** `requireAuth` is middleware
  and finishes before a route opens its span, so its cost sits inside
  `http_request` and outside the flow. The difference is carried explicitly as
  `rally.auth.duration_ms`, on the span and in the row, so the gap between the
  two durations reads as a number rather than as a mystery.
- **The session lookup is one uncached, blocking D1 round trip per
  authenticated request**, and there is no read replication on the `DB` binding.
  Root-mounted identity and workspace middleware share that request-local result,
  removing one lookup from a protected request's critical path. Before that
  reuse, the second call overwrote `rally.auth.duration_ms`; the metric now
  represents the single identity pass and must not be compared as a sum of both
  old calls.
  Whether that is a problem is now measurable rather than arguable: read
  `rally.auth.duration_ms`, and the platform's own `d1_first` span for the same
  query carries `cloudflare.d1.response.sql_duration_ms` beside it, which
  separates the database's own time from the round trip to reach it. If it does
  turn out to matter, the lever is
  [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
  with the Sessions API — **but not naively for this query**: a session read
  served by a stale replica can admit a session that was just revoked, so it
  would need `first-primary` or bookmark-based consistency, which gives back
  much of what replication buys. Treat it as a decision with a security
  argument in it, not a configuration change.
- **Canonical reconciliation is not traced.** A viewer that asks the room to
  re-send canonical state (`request_snapshot`, see
  [`architecture.md`](architecture.md)) runs the same snapshot assembly a
  subscribe does, but under `noFlowSpan` — it is a background repair, not one of
  the five flows a person waits on, and `PerfFlow` is deliberately limited to
  those. The consequence is that a slow reconciliation is invisible here; it
  appears only as room time nobody attributed. Adding another flow is the lever
  if that becomes the question, and it costs a `perf_flow` row per repair.
- **A `workstream_open` trace is not always a completed open.** The renderer
  closes the trace on the first valid server frame and records which one it was
  as `outcome`. A `snapshot` means the screen filled, whether it was an initial
  open or a replay-history repair; use `rally.subscribe.snapshot_reason` to
  separate them. A `resync_required` means the client's cursor was ahead or the
  canonical repair could not be completed safely, so the server sent it to HTTP instead, closing the socket and deferring
  reconciliation to the next connect, which this trace does not cover. The
  durations are therefore only comparable within one outcome — **filter
  `outcome = snapshot` before reading a percentile.** Making the trace span the
  reconnect would mean a renderer trace that outlives its socket, which is a
  larger change than this one.
- **Retention is the platform's.** Cloudflare owns Worker trace/log retention,
  the telemetry subsystem owns uploaded-event retention, and macOS owns local
  Unified Log retention. None is a permanent application ledger.
- **The desktop's raw lines are lost on quit.** The registered
  `renderer_perf_flow` projection is durably spooled and retained regionally for
  90 days when diagnostics are enabled and is also written to macOS Unified
  Logging. The HTTP line and any fields outside that closed schema still live
  only in the renderer console.

## Testing

| Suite | What it proves |
| --- | --- |
| `apps/api/test/tracing.test.ts` (`pnpm --filter @rally/api test`) | That a step opens a runtime span and ends it, that the step which threw is still ended and the rejection propagates, the `perf_flow` row's step map and `slowest_step`, `setError`'s status attributes, that an absent identifier sets no attribute, that `noFlowSpan` opens nothing, and that a request's span carries the `x-request-id` the desktop sent. |
| `apps/desktop/src/renderer/lib/perf-trace.test.ts` | The renderer tracer's phase order, its throwing phase, `end` idempotence, the exact governed projection and rejection of arbitrary console fields, and that `newRequestId` produces something `requestContext` will accept rather than replace. |
| `apps/desktop/src/main/native-performance-log.test.ts`, desktop release tests | The exact public structured record, observational failure behavior, development/packaged addon paths, and that the native bridge is packaged, signed, and release-verified. |
| `apps/desktop/src/renderer/lib/api.test.ts` (`request correlation`) | That every call carries a distinct `x-request-id`, explicit per-request socket IDs remain unchanged, and a work-stream detail retry carries its longer-lived opening attempt separately as `x-rally-operation-id`. |
| `apps/api/test/security-and-config.test.ts` | That `x-request-id` survives the CORS preflight in configured deployments and is exposed on the response. |

Three traps:

- **`cloudflare:workers` does not exist under Node.** The Node suite aliases it
  to `test/helpers/cloudflare-workers.ts`, whose `tracing` stand-in keeps the
  contract a call site depends on — the callback runs, the result is returned, a
  throw propagates, attributes are recorded — and records what was opened for
  `recordedSpans()`. It does **not** nest by async context and it exports
  nothing. Anything that depends on real nesting or on export belongs in
  `apps/api/test-workers/`, per [`testing.md`](testing.md).
- **`resetRecordedSpans()` in `afterEach`.** The recorder is module state; a
  test that does not clear it sees the previous test's spans and passes for the
  wrong reason.
- **The clock has to be stubbed one step per `Date.now()` call** — one for
  opening the flow, one per step closed, and one for the summary. A miscount
  shifts every duration by one step and the assertion fails somewhere other than
  where the mistake is.

## Operations

Traces go wherever the account's OTLP destination points; the `perf_flow` rows
go to Workers Logs. To investigate one slow interaction a person reported:

1. Get an id from their client — the request id from a `[perf] http …` line, or
   the `traceId` / `ticketId` / `clientMessageId` from a `[perf] <flow>` line.
2. In the trace destination, filter on the matching attribute:
   `rally.request.id`, `rally.socket.ticket_id`, or
   `rally.message.client_id`. For a socket open, follow
   `rally.socket.ticket_id` into the room's acceptance, then
   `rally.socket.connection_id` into the subscription.
3. In Workers Logs, `event = perf_flow` with the same `request_id` gives the
   same breakdown as one row, including `slowest_step`.

For a local macOS investigation, open Console.app and filter subsystem
`ai.rallywith.desktop` plus category `performance`, or run:

```bash
log show --style compact \
  --predicate 'subsystem == "ai.rallywith.desktop" AND category == "performance"'
```

A reproducible no-production-write acceptance lane is: run the local API and
Electron app using `dev-environment.md`, create representative empty, sliced,
and summary-backed substreams, then export the closed native records with
`log show --style json --predicate 'subsystem == "ai.rallywith.desktop" AND category == "performance"'`.
Select `renderer_perf_flow` records whose `flow` is `workstream_create` or
`substream_create` with outcome `send_ready`, group the latter by `operationId`, and compute percentiles
from `systemWaitMs`. Record sample count, build SHA, cold/warm status, payload
shape, and whether summary inference used the configured real local-development
provider. Do not mix failures, cancelled attempts, or replayed receipts into
the successful distribution, and do not describe a small local sample as a
production percentile.

For a cold Durable Object tail, find the automatic binding span and inspect its
`durable_object.initialize` child, then the
`durable_object.schema_migrate` child. Workers Logs can aggregate the matching
`durable_object_initialization` and `durable_object_schema_migration` rows by
`class_name`, `status`, and `duration_ms` even when a sampled trace is absent.
Inspect `durable_object.runtime_recovery` independently: it is intentionally
off the socket's storage-readiness gate even though it begins during the same
activation.

When the binding span is seconds longer than acceptance, inspect
`rally.socket.room_outside_accept_ms` with constructor phases and invocation
logs using [the correlation procedure](production-error-investigation.md#a-slow-call-into-a-durable-object).
Instance age helps distinguish recently created instances from older ones; it
cannot assign the remainder to the platform or a particular invocation.

To find the pattern rather than the instance, filter `event = perf_flow` with
`flow = <name>` and `duration_ms >` a threshold, and group by `slowest_step`.
Worth adding to the saved views in [`runbook.md`](runbook.md#log-shape) once
there are enough production rows to pick thresholds that are not guesses; they
are deliberately not guessed here.

The two things below had to be decided rather than inherited before that
happened. They are kept here in full because they are what a future reader needs
in order to understand what was accepted, and because the first of them is not
closed — it is a standing property of the export.

The first is not about this module at all and is the larger of the two, and it
was **accepted, not solved**: the platform's automatic Durable Object SQL spans
carry `cloudflare.durable_object.query.bindings`, which for Rally means message
content, with no hook to redact it —
[`cloudflare-logging-and-tracing.md`](cloudflare-logging-and-tracing.md#what-automatic-tracing-captures-that-we-would-never-log)
has the detail. An OTLP export moves that content out of the region's own trust
boundary.

The second is identity, and it has two halves. Spans now carry the analytics
surrogates deliberately, so a system trace can be matched to a product event —
which means **a trace holds both identities at once, and whatever stores traces
holds the mapping that keeping them apart was protecting**. That is a reasonable
trade for an internal observability destination and a poor one for a destination
chosen casually.

The other half is a correctness problem before it is a privacy one.

Spans carry raw `user.id` and `rally.workspace.id` — the same ids every other
diagnostic in Workers Logs already carries. PostHog is keyed on neither.
`users.analytics_person_id` and `workspaces.analytics_workspace_id` are random
UUIDv7 surrogates, minted lazily by `ensurePersonAnalyticsId` and
`ensureWorkspaceAnalyticsId` in `apps/api/src/telemetry/authenticated.ts`, and
they are what the adapter sends as `distinct_id` and `$groups.workspace`. The
mapping between a product id and its analytics id exists only in that region's
D1; nothing derives one from the other.

So an exporter that promoted `user.id` to `distinct_id` would not merely widen
what PostHog holds — **it would make one human two people there**, one under
`analytics_person_id` from the product pipeline and one under `users.id` from
traces, and one workspace two groups. Un-merging that afterwards means
reconstructing the D1 mapping.

Two ways out, and either is fine: map through the analytics ids at the exporter,
or keep the attributes as opaque correlation values and never promote them to
identity. What is not fine is letting a destination's default identity mapping
decide.

Note also how an export is scoped, because it is easy to get backwards. The
destination is account configuration; the **attachment is per Worker**, through
`observability.<signal>.destinations`. Creating a destination exports nothing —
a Worker exports when its own config names one.

## Changelog

### 2026-09-23 — Keep first-dispatch timing accurate after removing repeated checks

**What changed:** Bind still reports first-dispatch timing while using the host's
KV context-window snapshot. The provider-turn heartbeat and run-authority reads
now overlap, and their individual durations remain visible. Loaded Sidekick
skills no longer produce a per-turn authority duration. Initial plugin checks
now overlap, and Bind's rehydration timer excludes duplicate connector checks
when Rally passes its current-attempt authorization result.

**Why:** The latency work removed the catalog fetch and redundant cross-object
checks that the previous breakdown had named. Keeping their old timing labels
would misdescribe the remaining wait and obscure the benefit of the change.
The earlier `bind_plugin_rehydration_ms` included a second serial provider
health walk immediately after Rally's own initial activation checks, so
its new value must not be compared as though it measures the same work.

**Considered and rejected:** Dropping the diagnostic row would leave no way to
compare the revised path with the prior one. Retaining catalog fetch subphase
fields would imply network work that no longer occurs.

**Consequences:** The parent authority duration can overlap the heartbeat and
its child read durations; these values should not be summed. Per-plugin initial
authorization durations can also overlap and should not be added to infer the
critical path. Catalog source is now `provided`, `fallback`, or `skipped` on this path.

### 2026-09-23 — Measure the remaining first-dispatch waits

**What changed:** The first provider request now emits one correlated breakdown
of scope, activation, routing, liveness, authority, catalog, and Bind boundary
timings, with activation counts and catalog source.

**Why:** A production time-question run spent 3,031 ms after context/tools were
ready and another 3,749 ms after preparation was logged. The existing aggregate
milestones could not identify which waits owned either interval, so a 200 ms
target for each phase could not be tested against individual dependencies.

**Considered and rejected:** A log or remote telemetry call around every await
would add work to the path being measured and require many records to diagnose
one run. The synchronous first-dispatch row keeps the run joinable by its
existing IDs and leaves authorization and durable ordering unchanged.

**Consequences:** The row applies to the first provider request of the first
durable attempt. Its durations are observational wall-clock deltas; workerd's
clock behavior and overlapping loaders prevent treating their sum as an exact
partition of the user-visible request. Per-plugin detail uses an object rather
than an array because the structured logger truncates arrays after 50 entries;
optional timing callbacks cannot change authority or activation outcomes.

### 2026-09-18 — Resolve aggregate inference preparation tails into dependency timings

**What changed:** The synchronous `agent_inference_prepared` row now records the
elapsed time of authority, recovery, heartbeat, prompt and memory, transcript,
tool, and attachment-replay dependencies, plus whether the run reused its
Sidekick snapshot and resident transcript projection.

**Why:** Production measurements isolated authoritative-state and context/tool
loading as the two remaining pre-provider bottlenecks, including one 6.9-second
authority outlier, but the three aggregate regions could not identify which
Durable Object, D1, memory, transcript, or tool path owned the tail.

**Considered and rejected:** Emitting a log row around every awaited operation.
That would multiply ingest volume and make one run require a log join. The
existing one-row diagnostic can carry overlapping dependency durations without
changing execution order or adding a telemetry promise.

**Consequences:** The detailed durations are diagnostic dependency clocks, not
a serial partition, and may exceed their enclosing region when work starts in
one region and is consumed in another. Dashboards must group them independently,
use the conditional-execution booleans when comparing warm and fresh runs, and
must not treat the initial authority field as the later provider-boundary fence.

Shipped in #833.

### 2026-09-18 — Attribute and overlap pre-provider preparation

The harness now starts independent identity, run, Sidekick, terminal-outcome,
model-routing, attachment-replay, and activation-hint reads through the
rejection-observing `Preparation` primitive, and loads independent transcript
inputs together. It awaits each only at its existing authority boundary. A
synchronous `agent_inference_prepared` row
records three critical-path regions. This was forced by production evidence of
roughly 2.7 seconds between a completed substream confirmation flow and provider
dispatch; the earlier inference-start row measured the gap but could not divide
it. Removing the reads or moving the authority fences was rejected because
they protect replay, access, and immutable run scope; only their independent
wait time moved.

### 2026-09-17 — Name substream stages and split inference-start from provider TTFT

Substream preparation and confirmation now have their own flow roots and named
steps instead of appearing as opaque request totals. User-started executions
carry the Worker receipt time to the provider boundary, where a structured log
and lakehouse request record measure admission-to-dispatch independently from
the attempt row's TTFT. This split was chosen because a slow provider and a slow
Rally activation path have different owners; one combined number made the
largest latency source impossible to assign.

### 2026-09-17 — Mention resolution reuses the workspace roster

**What changed:** The socket send path passes React Query's existing
`['workspace-members']` value into `messageMentionPayload`. Mention-bearing text
uses that roster without another HTTP request and retains the API fetch as a
fallback when the shared roster has not loaded or cannot resolve a typed person.

**Why:** The application root already owns a stable workspace-member roster for
the composer and conversation surfaces. Fetching the same authority again at
send time put independent network latency in front of an otherwise ready room
socket.

**Considered and rejected:** Adding another mention-specific cache would create
a second invalidation contract for the same roster. Resolving from selected
chips alone would still miss typed names and pasted durable mention Markdown.

**Consequences:** `resolve_mentions` is local on the normal loaded-workspace
path. A cold, isolated, or observably stale caller remains correct through one
refresh from the existing roster endpoint, and plain text still performs
neither lookup nor fetch.

Shipped in [#815](https://github.com/juno-ai-labs/avalon/pull/815).

### 2026-09-09 — Keep socket timing attribution explicit

Renamed the proposed `room_activation_ms` to `room_outside_accept_ms`: the
subtraction also includes constructor/readiness and queueing. Subtracting instance
age was rejected because an older instance or a racing warm-up makes it unrelated
to this call's wait. Inspect initialization phases and invocation logs to assign
the cause. Malformed diagnostic headers are stripped independently of parsing,
and real-workerd tests cover both handshake transports. This corrects the
activation-only interpretation in the preceding proposal entry.

PR #607.

### 2026-09-08 — `room_upgrade` names what the room saw of it

**What changed:** The room answers an accepted feed upgrade with two internal
headers — its own accept duration and its instance's age — and the edge turns
them into `rally.socket.room_accept_ms`, `rally.socket.room_activation_ms`
(the `room_upgrade` wait less the accept), and
`rally.socket.room_instance_age_ms` on the upgrade span and its `perf_flow`
row, stripping both headers before the 101 reaches a client. The room's own
accept row carries `rally.room.instance_age_ms`.

**Why:** Three opens of one Global work stream on 2026-09-08 took 2.9, 11.6,
and 12.6 s with `slowest_step = workstream.socket.room_upgrade` at 2,864,
11,508, and 12,542 ms, and matching ticket warm-ups of 4.1, 12.5, and 13.6 s.
The same flow took 212–327 ms half an hour earlier. The room's accept in each
was 119–214 ms — an authority read of 101–138 ms and a fallback member
authorization of 73–87 ms — with no snapshot assembly, a 0 ms replay plan, 0 ms
constructor phases, and no overlapping alarm. Every Rally step was accounted
for and small; the seconds were the platform activating a cold object, which
`room_upgrade` charged to the room and no span in the room could see, because
the room did not exist yet. The invocation logs carried the proof — zero CPU
on every invocation that waited, `rpcCallCount: 0` on the RPC sessions, and
the constructor's row written at the instant the wait ended — but only after
a join across three invocations. The row now says it.

**Considered and rejected:** Awaiting the ticket-transit warm-up before
returning the ticket, or holding the socket open longer on the client, neither
of which shortens an activation and the first of which puts it on the ticket
path. Splitting `room_upgrade` into two clock-measured steps, which the edge
cannot do: it has one clock and one call. Keeping the object warm after a run
ends — an alarm costs nothing while the object sleeps, and would not reach the
case where the object was rebuilt three seconds after its last event.

**Consequences:** `slowest_step = room_upgrade` on an `api_socket` row is not
evidence about the room until `rally.socket.room_activation_ms` is read beside
it; a dashboard that groups slow opens by step should split that step on
`rally.socket.room_instance_age_ms`. The two headers are object-to-Worker only:
a change that stops stripping them puts a diagnostic on the client handshake.
What shortens a cold activation is not decided here — whether the object's
SQLite size, the runtime's placement, or the shutdown that preceded it decides
the seconds is the next observation, and `room_activation_ms` against
`databaseBytes` from the object's inspection route is the pair to read.

Shipped in #607.

### 2026-09-08 — Keep search traces open across candidate-only pages

Explicit pagination can paint an empty intermediate page. Closing the trace there
would report a fast success before a result existed. Search now keeps the trace
open through continuation and user wait time until results or a terminal response.
The latency target remains about useful results rather than candidate-page speed.

### 2026-09-07 — Measure search from typing through painted results

**What changed:** The existing `renderer_perf_flow` contract accepts
`workspace_search` with debounce, request, paint, scope-resolution, retrieval,
canonical-hydration, and server timing fields. Search uses the same regional
main-owned delivery path and records no query or result contents.

**Why:** Search appeared empty while serial source authorization was still running.
The p50 500ms / p90 1000ms target includes client delay and rendering, which server
logs alone cannot measure. Reusing the governed flow avoids a separate exporter.

**Consequences:** Percentiles should use completed first-result search flows;
failed and superseded searches remain separately visible. Backend timing fields
are optional and do not change legacy search responses. See `text-search.md` for
the retrieval and pagination contracts.

### 2026-09-05 — Keep preview timings out of creation percentiles

Preparation uses `substream_prepare`, leaving one successful `substream_create`
sample at send readiness. Sharing the flow name counted preview completion as
another creation and biased latency distributions downward. Correlation still
uses one operation ID, and the ready sample includes preparation system wait.

### 2026-09-04 — Creation clocks reach authoritative painted send readiness

**What changed:** Ordinary creation now retains its renderer trace across
navigation. Private-child preparation and confirmation publish separate
intervals under one durable operation ID, with their sum reported as system
wait after the child context and send handler cross the existing paint fence.
The desktop POST passes its already-validated authority snapshot into creation,
removing the service's duplicate D1 read only for that route.

**Why:** Navigation request and preview response are intermediate milestones;
neither proves the created conversation can accept a send. The duplicate
authority read repeated the same request-scoped fact and had no distinct
failure semantics, while non-route callers still need their own check.

**Consequences:** User review time is excluded, summary preparation is not.
Keep P50 below one second and P90 below two seconds as unverified acceptance
targets until a representative trace set exists. Do not merge replay or failure
cohorts into those percentiles.

### 2026-09-02 — Preload admits native handshake phases

**What changed:** The dependency-free preload validator now accepts the complete
closed `handshake_phase` shape emitted by the main-process socket broker. It
admits only the seven declared phase names, a finite nonnegative duration, a
nonnegative integer route index, the generated socket ID, and the proxy flag.
The IPC regression carries a real phase through main's sender and the same parser
preload uses.

**Why:** The first packaged 1.249 cohort contained 39 click-scoped
`workstream_open` records and none carried proxy-resolution, DNS, TCP, TLS,
edge-upgrade, proxy-connect, or failed-route timing, even though the main-process
broker emitted that vocabulary. The Zod schema declared `handshake_phase`, but
preload deliberately carries a dependency-free closed parser and that parser had
branches only for open, message, error, and close. It therefore discarded every
valid timing before the renderer could annotate the flow. The validator test
claimed to cover every broker event shape while omitting the same variant.

The same cohort joined by trace ID to Worker `http_request` and `api_socket`
records put the first application-observable Worker millisecond at the start of
`api_socket` for all 39 requests. The mean 607 ms residual therefore precedes
request-scoped authentication and Worker-to-object forwarding. Ten independent
upgrades from the same Mac completed DNS, TCP, and TLS in 37–61 ms while first
response arrived in 465–917 ms. A temporary 0.41 KiB Worker on a unique route
under the same API hostname returned upgrades in 88–176 ms while fall-through
requests to the 7.4 MiB API Worker took 541–562 ms. That indicates roughly
350–450 ms of potential ingress savings, but does not verify the net reduction
of a permanent ingress Worker that must also authorize and forward the upgrade.

**Considered and rejected:** Treating the missing properties as a query or
regional-upload defect was contradicted by the same omission in macOS Unified
Logging. Adding another Worker header or timing system would duplicate the
existing native boundaries without recovering the dropped events. Renderer
buffering was also rejected: construction and listener attachment remain one
uninterrupted renderer turn, and it would not repair a phase preload already
discarded. Moving Durable Object classes is unnecessary; a future ingress Worker
can cross-script bind the existing namespaces. Copying the ticket-signing secret
and adding regional route promotion are nevertheless a separate security and
deployment change, not something to hide inside this parser correction.

**Consequences:** Historical native phase absence does not mean DNS, TLS, or
proxy resolution took zero time. A packaged build containing this change will
provide the first usable phase cohort. A dedicated regional socket-ingress Worker
may save roughly 350–450 ms, but its permanent implementation remains unmeasured
and requires explicit ticket-secret provisioning and service-first rollout work.
Cloudflare's pinned synchronous clock can still report zero inside Worker startup,
so client-native phases and the trace-ID join remain complementary rather than
interchangeable. Per-phase duration annotations are last-write-wins across route
attempts; read `failedRouteCount` beside them rather than treating them as an
attributed history of every failed route.

### 2026-09-02 — Prepared admission separates hidden work from upgrade fallback

**What changed:** The ticket-correlated warm completion now reports whether it
prepared a snapshot, admission alone, or neither. Room acceptance labels the
admission source, and snapshot delivery labels whether detail was assembled
during ticket transit or inside the upgrade.

**Why:** A warm RPC finishing before upgrade did not establish that it removed
any critical-path work; storage readiness could be warm while repeated regional
authorization and snapshot detail still occupied the room block. The new labels
make the optimized and fallback cohorts directly queryable.

**Considered and rejected:** Inferring preparation from a short room duration
would confound replay-only subscriptions and already-warm objects. Reusing the
old binary warm outcome would call an admission-only preparation equivalent to
a fully prepared first frame.

**Consequences:** Compare exact ticket IDs across the warm event and room span.
A prepared-snapshot cohort should omit the regional member-authorization and
upgrade-time snapshot-detail spans but retain the regional authority read; a
fallback retains the old shape and remains the correctness baseline.

### 2026-09-01 — Opening samples are click-scoped and cold wake recovery is named

**What changed:** Background and speculative socket flows remain local while
only a pending opening attempt exports `renderer_perf_flow`. Direct Node
handshakes now expose PAC, DNS, TCP, TLS, and edge-upgrade phases; proxy attempts
use one aggregate. Substream activation records runtime lease/alarm recovery in
its own Durable Object phase, and signed-ticket bootstrap joins accept with the
initial subscription.

**Why:** The prior 72-hour distribution contained multi-minute retained-socket
lifetimes under the same event used to diagnose 5–15 second clicks. It was not a
product-open distribution. The remaining large handshake and object-wake blocks
also needed boundaries that correspond to work the implementation can change.

**Considered and rejected:** Filtering implausible totals at query time leaves
unknown background samples in lower percentiles. Guessing proxy subphases makes
false attribution. Moving runtime recovery after all requests would risk agent
lease correctness; it remains scheduled immediately but no longer blocks socket
storage readiness.

**Consequences:** Historical `renderer_perf_flow` data before this change must
not be compared directly with the new click-only cohort. Feed-visible and
send-ready remain the authoritative total. Operators should compare direct and
proxied routes separately and join ticket/connection IDs into server phases.
Speculative hover spans can be separated from committed opens without inferring
intent from timing.
### 2026-09-01 — Message-send tracing starts at the admitted room, and plain sends skip the roster fetch

**What changed:** Current desktop sends produce a socket-rooted
`workstream.room.create_message` trace in SubstreamAgent. Its child spans cover
the local product write, loop activation when needed, and the private receipt.
The former `workstream.message.send` WorkspaceDO trace remains only for old
desktop compatibility traffic. The existing `workstream_send_ready` event keeps
its `workspaceSocketState` field for telemetry-schema continuity, but the value
now describes the message-carrying SubstreamAgent socket.

On the client, `messageMentionPayload` returns an empty mention payload without
calling `/workspace/members` unless the outgoing text contains `@` or the
durable `person://` mention scheme. The existing resolution path is unchanged
once either marker is present.

**Why:** The selected substream socket already carries the exact route and
admitted identity. The parent trace described work the product no longer needs:
a WorkspaceDO invocation, D1 session/membership recheck, and a child binding
call before the owner could write.

Production send traces showed every plain message paying 100–118 ms for a
roster it could not use before the workspace socket command began. Mention
resolution needs that roster; a message with no mention syntax does not.

**Considered and rejected:** Keeping an empty parent correlation span would
misrepresent the runtime path. Reusing the old span name in the child would hide
the authority change and make old/new production samples indistinguishable.

Caching the roster on the send path would still add cache ownership and
invalidation semantics to messages that need no roster at all. Inferring from
`selected` alone would miss hand-typed `@Name` mentions and pasted durable
mention Markdown.

**Consequences:** Diagnose current send latency from
`workstream.room.create_message`; seeing `workstream.message.send` means the
client has not yet upgraded. Both still join the renderer by
`rally.message.client_id`. `resolve_mentions` remains a measured phase, but it
is local and effectively immediate for plain text. New mention syntaxes must be
added to this gate when they are added to resolution.

### 2026-08-26 — Work-stream open includes both transcript islands and usable composer

**What changed:** The existing renderer `workstream_open` clock now treats the
ordered transcript snapshot as part of the socket snapshot boundary. That one
frame contains the unread-centered range, the prefetched five-turn tail, active
turn/activity baselines, and the room event fence; success still waits for the
renderer commit and usable composer. Release evidence reports combined and
cohort p50/p90, with goals of p50 at or below 1,000 ms and p90 at or below
2,000 ms.

**Why:** Ending the clock at authorization, Durable Object response, or one
painted island would report a fast partial open while the reader could neither
jump to the live tail nor send. The product goal is the complete visible open.

**Considered and rejected:** A new transcript-only microbenchmark cannot prove
the Electron renderer is visible or usable. A second trace would also split one
member action into competing totals. The existing client-monotonic flow is the
authoritative boundary and its backend spans remain diagnostic components.

**Consequences:** Slow successful opens remain in percentiles. Failed and
cancelled opens record their outcome but never enter successful percentiles.
Warm/cold, unread/latest overlap, disjoint islands, large history, and
mid-stream cohorts remain separable without transcript content.

### 2026-08-26 — Work-stream handshake timing follows the Electron Node broker

**What changed:** Electron's control/feed transport moved from Chromium to a
main-process Node broker without moving the renderer's `workstream_open` flow.
`dial` now ends at renderer admission to the broker and `handshake` ends when
the broker relays its open event. The existing durable `renderer_perf_flow`
record therefore measures the complete IPC plus network handshake without a
new trace graph.

**Why:** Concurrent cold work-stream sockets were queuing behind Chromium's
same-endpoint handshake lock. Moving transport fixes the queue, but moving the
flow clock would split the click-to-snapshot measurement across processes and
lose the renderer's painted/send-ready boundaries.

**Considered and rejected:** A separate main-process performance flow would
measure the broker precisely but would no longer be the person's full wait and
would need another correlation graph. The existing phase boundary already
separates renderer scheduling from everything after admission.

**Consequences:** A slow `handshake` may now include main-process IPC delay as
well as network, Worker, and Durable Object time; backend ticket and upgrade
correlation still separates the service portion. Chromium NetLog no longer
contains these two socket types, while the renderer flow remains in Unified Log
and regional telemetry.

Shipped in #341.

### 2026-08-26 — Renderer phase timings reach regional telemetry and local Unified Logging, and cold wakes expose initialization

**What changed:** Every completed renderer `workstream_create`,
`workstream_open`, and `workstream_message_send` trace now emits one closed
`renderer_perf_flow` diagnostic event in addition to its local Verbose console
line. Exact phase and blocked milliseconds, bounded counts, closed outcomes,
and join identifiers travel through validated main-process IPC and the existing
regional spool. The operation remains fire-and-forget and never waits for a
preference read or telemetry delivery. macOS builds also package a native
Unified Logging bridge that writes the same governed `renderer_perf_flow`
record under Rally's performance subsystem before the upload preference gate.
Each migrated Durable Object also opens `initialize` and `schema_migrate` spans
and emits one structured duration row per wake.

**Why:** Packaged builds do not expose DevTools, so the only evidence capable of
splitting the observed multi-second ticket-to-upgrade gap into renderer `dial`,
network handshake, service wait, or main-thread blocking disappeared with the
process. Backend timings could locate the gap but could not classify it, which
made the two-second P90 goal unactionable from production evidence. Process
exit discarded the renderer lines as well, and a slow automatic binding span
combined platform wake, constructor work, schema migration, and transport into
one number. None of these gaps could be repaired after a user supplied a
session time window.

**Considered and rejected:** Forwarding `[perf]` console objects wholesale
would create an open telemetry vocabulary and could silently export future
annotations. A renderer OpenTelemetry exporter would bypass regional routing,
consent, validation, and the durable spool. Keeping only the existing total
paint metric preserves percentiles but cannot identify which phase to change.
For the local record, a text log with application-owned rotation adds a second
retention and file-security subsystem; Unified Logging is the idiomatic macOS
durable store and Console.app already reads it. Reporting every migration pass
to the fleet tracker would turn a timing question into cross-region queue
traffic and defeat its deploy/heartbeat dedupe; structured Worker logs provide
the per-wake record without changing tracker semantics.

### 2026-08-25 — The socket snapshot is the cold-open clock

**What changed:** A selected work stream starts its feed subscription before
detail or transcript data exists, and the first valid socket `snapshot` now
ends the normal renderer open. Detail and transcript HTTP spans under
`workstream_open` represent recovery only. The WorkstreamDO control socket is
started independently and its HyperSight preference does not end or delay the
feed trace. Product telemetry names this path `socket_snapshot` so it remains
separate from cache and HTTP recovery cohorts.

**Why:** The previous renderer serialized `GET /workstreams/:id` and socket
admission even though both caused the same SubstreamAgent to assemble canonical
detail and transcript state. That made the request trace useful for diagnosis
but guaranteed its latency was paid before the already-instrumented socket
phases could begin.

**Considered and rejected:** Racing REST against the socket would make the
measured winner depend on duplicate object work and would retain two normal
open shapes. Extending the flow until optional control metadata arrives would
measure HyperSight readiness rather than the stated message-feed-and-send goal.

**Consequences:** For cold-open percentiles, filter renderer outcomes to
`socket_snapshot` and join ticket, upgrade, accept, and subscribe traces. A
failed first socket attempt exposes the manual HTTP recovery while reconnecting,
without adding a fallback timeout. HTTP rows are a recovery cohort and must not
be mixed into the normal-open distribution.

### 2026-08-25 — Detail retries separate request identity from opening identity

**What changed:** Each `GET /workstreams/:id` call now keeps the fresh
`x-request-id` that names that specific HTTP request and carries the sidebar
click as `x-rally-operation-id`. The API open span records the latter as
`rally.operation.id` beside `rally.request.id`.

**Why:** React Query may retry a failing open twice. Reusing the opening ID as
all three request IDs made distinct calls indistinguishable and fanned a join
whose documentation promised one request. The tail is exactly where both the
individual calls and their shared click must remain visible.

**Considered and rejected:** Minting a new opening ID per retry would destroy
the product attempt denominator. Keeping the repeated request ID and documenting
the fan-out would preserve ambiguity in Workers traces. The existing operation
header already expresses a lifecycle longer than one request and is CORS-safe in
configured deployments.

**Consequences:** Join on `rally.operation.id` to collect every detail retry for
one click, then use `rally.request.id` to inspect one call. Authentication replay
inside one `RallyApi` call deliberately retains its request ID because it is one
caller-level request under a renewed credential.

### 2026-08-25 — The feed-paint metric exports click-scoped totals, and opening, lease, and request IDs keep separate scopes

**What changed:** A click-scoped operation ID now labels the desktop's
`workstream_feed_visible` product event and, when the open needs it,
`GET /workstreams/:id`. The event exports exact click-to-data-ready and
click-to-painted-feed milliseconds. The local renderer tracer remains local,
and its phase list and long-task overlap are not copied into the product
envelope.

A sidebar attempt emits start and terminal outcome events under that one
opening operation ID, and the detail request reuses it. Socket starts use their
own operation ID for the ticket request, carry the pending opening ID when
applicable, and carry the socket owner's stable lease ID. The feed and opening
outcome record the lease that served the painted transcript.

**Why:** The earlier decision below rejected regional renderer latency because
no concrete product question required raw values. The requested average and
P50/P75/P90/P99 click-to-feed distribution cannot be reconstructed from local
lines, socket-open timing, or duration buckets. Reusing the request ID makes
backend phase attribution possible without inventing a second trace graph.

One identifier cannot simultaneously name a user interaction, several ticket
requests, and a pooled connection that may predate that interaction. Rapid
navigation also needs a durable superseded outcome rather than a missing
completion row.

**Considered and rejected:** Exporting `[perf]` lines wholesale would move a
diagnostic vocabulary into the product contract and retain substantially more
state. Minting `traceparent` still forks Cloudflare's trace graph. Keeping only
buckets makes the requested percentiles mathematically unavailable.

Timestamp joins are ambiguous for A to B to A switches. Making the click ID the
request ID for both control and feed would merge independent requests. Treating
the work-stream ID as a session would merge every open and reconnect for that
resource.

**Consequences:** Exact totals are governed Product analytics and follow its
consent and regional destinations; detailed phases remain diagnostic. A reader
joins an uncached open on the opening operation/request ID and must not treat it
as authorization or as a Cloudflare trace ID. A `feed_cache` open has no detail
request to join by design.

`operation_id` means the event's own attempt: opening attempt on opening/feed
events, socket attempt on socket-start events. `openAttemptId` is the explicit
parent on a socket start; `socketLeaseId` joins control/feed attempts to the
retained owner. None is a Cloudflare trace ID, ticket, or authorization value.

### 2026-08-25 — Subscription snapshots name replay-loss recovery

**What changed:** `workstream.room.socket.subscribe` records
`rally.subscribe.snapshot_reason` as `initial` or `history_unavailable` whenever
its replay plan is a snapshot.

**Why:** Replay-cache loss now repairs the existing socket with canonical state
instead of emitting `resync_required`. Without a reason attribute those expected
post-hibernation snapshots would be indistinguishable from first opens in the
same trace distribution.

**Considered and rejected:** Inferring recovery from the prior client cursor
would require joining application payloads that traces deliberately do not
store. A dedicated outcome value would duplicate `replay_plan = snapshot`.

**Consequences:** Snapshot latency can be compared by cause. HTTP reads under
`workstream_open` now represent `sequence_ahead` plus failed or overflowed
`history_unavailable` snapshot fallbacks, not ordinary replay-cache loss.

### 2026-08-21 — The renderer half can say whether it was waiting or busy

**What changed:** Every `[perf] <flow>` line now carries `blockedMs` and
`longTasks`, the `longtask` time overlapping that flow, collected by one
process-wide `PerformanceObserver`. `workstream_open` gained a `dial` phase
between `socket_ticket` and `handshake`, closing on the line that constructs
the `WebSocket`, and a `sinceEffectMs` annotation giving the delay between the
socket effect starting and that attempt's first request.

**Why:** A production open measured 7.62 s, and 5.1 s of it fell in two windows
with no request in flight — 1.65 s before the first request, and 3.48 s between
the socket ticket resolving and the handshake reaching the Worker. Neither was
attributable. The second sat inside the existing `handshake` phase, which spans
ticket-resolution to open-event and so reports the same number whether the
renderer never reached `new WebSocket` or the connection itself was slow. The
first was outside every trace, because a trace opens inside `connect` and
everything that delays `connect` happens before there is one. The server side
was already well instrumented and showed nothing wrong — no traced flow in that
window exceeded 925 ms — so the missing measurement was the whole diagnosis.

`blockedMs` is the general form of the question. Splitting a phase says *where*
the time went; long-task overlap says whether the thread was available at all,
and that is the fact deciding between a networking fix and a rendering one.

**Considered and rejected:** *A phase per long task, or per-phase blocking
attribution.* The entries are coarse — 50 ms granularity, and no useful
attribution in a packaged Electron build — so this would multiply the line's
width for precision the entry type cannot support; whether the flow was blocked
at all is the question worth answering first. *One observer per trace.*
Background subscribers mean several traces are open at once, and every one of
them would receive identical entries. *Shipping these lines to the regional
telemetry pipeline*, so a slow open is diagnosable without a person at the
machine. Same rejection as 2026-08-20: latency diagnosis is not a product
signal, it would have to clear the regional, identity, and preference machinery
in [`telemetry.md`](telemetry.md), and it would arrive bucketed. The cost stays
recorded under **Failure modes and limits** — these lines still die with the
renderer. *An explicit `typeof PerformanceObserver` guard*, which a mutation
test proved dead: the `try/catch` around construction already covers both an
absent constructor and a rejected entry type.

**Consequences:** The tracer now holds process-wide mutable state, so a test
needing the observer attached must `vi.resetModules()` and re-import — the
attach happens once per module load, on the first `startPerfTrace`. The
long-task buffer is bounded at 256 entries and holds only start and duration;
adding the browser's attribution fields would put frame and script URLs into a
diagnostic that deliberately carries no such thing. `blockedMs: 0` is ambiguous
between "not blocked" and "this runtime reports no long tasks", and a reader
comparing builds has to know which. And anything that introduces an `await`
between the socket ticket resolving and `new WebSocket` destroys what `dial`
means: the phase is evidence about the renderer only because nothing else can
currently intervene there.

### 2026-08-20 — Review pass: the step accounting, and four things it hid

**What changed:** `step` now closes the gap since the previous step as an
explicit `unattributed` entry before starting its own measurement. It used to
measure from the previous step's end, so anything awaited *between* two steps
was billed to the later one — a fast step could be named `slowest_step` at the
cost of its slow neighbour, while its own span recorded the truth. `mark` keeps
the old accounting on purpose: it exists to name work that has already happened.

Three call sites were mismeasuring because of it, and are fixed independently
so they read correctly rather than as a named gap:
`SubstreamAgent.acceptSocketInSpan` no longer reads the workstream authority
control twice; `sendSnapshot` gives `socketAuth` its own step; and the create
service's `durableObjectStubForWorkspace` calls now surface as `unattributed`
rather than inflating the step after them.

Also in this pass: `rally.snapshot.bytes` reports UTF-8 bytes rather than
`String.length`, carried in a variable so the trim loop encodes once per
iteration instead of twice; `step` repeats `rally.flow` and `rally.component`
onto each child span, because OpenTelemetry does not inherit attributes and a
step that lacks them cannot be grouped by its flow; the renderer's create trace
reports `navigation_requested` rather than `navigated` and ends a superseded
trace instead of orphaning it; the renderer no longer logs query-string values;
and `test-workers/tracing-runtime.test.ts` pins `tracing.enterSpan` against the
real runtime.

**Why:** Review found them, and most were the instrumentation lying about the
thing it exists to measure — the PR's own framing is "the create took four
seconds and 3.1 of them were the authority read", which the step accounting
could not actually support. `encoded.length` counts UTF-16 code units against a
cap measured in UTF-8, so any non-ASCII transcript under-reported exactly the
frames most likely to trip it. And every tracing test ran against the
`cloudflare:workers` stub, which `AGENTS.md` reserves for what cannot run on
workerd — custom spans can, so the whole feature rested on an import no test
resolved for real, on an API in open beta.

The duplicated authority read was not only a measurement defect: it is an
uncached D1 round trip, so every socket accept paid two to save header parsing
on the maintenance path.

**Considered and rejected:** *Repeating the identity attributes onto every step
span too*, which review also asked for. The root of the same trace carries them
and `perf_flow` carries them beside every step duration, so the cost would be
paid per span for something already available twice. *Keeping the renderer's
create trace open until the destination screen commits.* The surface is
optimistic — the work stream appears on the keystroke — so the person's wait
ended long before `navigate`, and holding a renderer trace across a route commit
to measure a screen they already have buys nothing; the label was the part that
was wrong. *Making `workstream_open` span a reconnect* after a
`resync_required`, which would mean a renderer trace outliving its socket; the
`outcome` attribute names which frame arrived instead, and the limitation is
recorded under **Failure modes and limits**.

**Consequences:** A step's number is now its own, so `slowest_step` can be
trusted — but a flow with unstepped awaits will show an `unattributed` entry,
and that entry is a bug report about the instrumentation rather than a finding
about the code. `rally.snapshot.bytes` is not comparable across this change for
non-ASCII transcripts; earlier values read low.

Shipped in #203.

### 2026-08-20 — Spans carry the analytics surrogates, read on the auth query

**What changed:** Traced requests now set `rally.analytics.person_id` and
`rally.analytics.workspace_id` alongside the raw `user.id` and
`rally.workspace.id`. Both are read from the session query that already
authenticates an HTTP request; the two Durable Objects add only the workspace
surrogate, from the `workspaces` row they already join.
`IdentityAuthContext` carries both as optional fields.

**Why:** A system span could identify the person to us and a PostHog event could
identify the same person to PostHog, and nothing connected the two — the
surrogates are random UUIDv7s whose mapping to `users.id` exists only in
regional D1. Answering "this trace was slow, what was that person doing, and who
do I email" meant a manual join through the database. Carrying both identities on
the span removes the step.

**Also measured here:** authentication now records `rally.auth.duration_ms`.
The session lookup is uncached and blocks every authenticated request, and it
runs before any flow span opens — so it was both invisible in `perf_flow` and
the reason `perf_flow` and `http_request` disagree. Whether it is expensive is
now a query.

**Consequences:** The `users` join added to `authenticate` must stay a LEFT join
and never become a condition — a session whose surrogates are half-minted is
normal, and filtering on them would turn a telemetry detail into a sign-out.
A Durable Object must not grow a `users` join for this: the workerd suite
declares only the tables it needs and most of it has no `users` table at all,
which is the shape of the coupling being avoided rather than an accident of the
tests. Both suites' `workspaces` declarations now need `analytics_workspace_id`. The attributes
are absent, not empty, until the telemetry pipeline mints them; a dashboard has
to tolerate that. Anything that changes how the surrogates are minted in
`apps/api/src/telemetry/authenticated.ts` now has a second consumer. And a trace
now holds both identities at once, so the destination holding traces holds the
mapping the pseudonymity was protecting — which raises the bar on where traces
are exported, described in **Operations** below.

Shipped in #203.

### 2026-08-20 — Three work-stream flows get custom spans on Cloudflare's tracing

**What changed:** Starting a work stream, opening one, and sending it a message
are each traced end to end with custom spans over Cloudflare's automatic
tracing, using `tracing.enterSpan` from `cloudflare:workers`. Every step is a
named span; workspace, work-stream, user, request, ticket, connection, and
client-message ids travel as OpenTelemetry-style attributes. Each flow also
emits one `perf_flow` Workers Log row carrying its step breakdown. The desktop
stamps `x-request-id` on every HTTP call and prints its own phase lines at the
trace level.

**Why:** These three flows were reported slow with no way to say which part was
slow. The only measurement was `http_request`'s total duration, and a create
alone is eleven awaited round trips — a receipt, an email-address reservation, a
D1 batch, a Durable Object initialize, two effect flushes, a directory probe, a
route activation — behind one number. Diagnosis meant adding a temporary log,
deploying, and waiting for it to happen again. The socket path was worse: an
upgrade opens a new connection carrying no request id, so nothing tied a slow
room back to the client that asked for the ticket, and the subscription that
actually fills the screen was invisible.

**Considered and rejected:** *An OpenTelemetry SDK — `@microlabs/otel-cf-workers`
or the Node SDK.* The platform already emits OTLP traces and logs from these
Workers with `observability.traces` enabled; an SDK would add an exporter, an
async-context shim, and a second trace graph that the platform's own spans for
D1 and Durable Object calls would not appear in. *Minting W3C trace ids and
propagating `traceparent` by hand.* This was built first and removed: the
runtime already owns trace identity, exposes no `spanContext()` to read it, and
propagates across subrequests itself — hand-made ids would have produced traces
that looked correct in isolation and joined nothing. *Using an id that survives
a seam as the trace id* — the socket ticket id and the client message id are
both UUIDs, and a UUID without its dashes is a valid trace id. Same objection:
it forks the trace graph. They are correlation *attributes* instead. *A new
product telemetry event.* Latency diagnosis is not a product signal: it would
have to clear the regional, identity, and preference machinery in
`telemetry.md`, and it would arrive bucketed, because that pipeline is
deliberately coarse. *A new `x-avalon-trace-id` header between client and
Worker.* `x-request-id` was already accepted, validated, CORS-allowed, and
echoed; a second header would have been the same value under another name and a
full pass of [`when-adding-a-new-http-header.md`](when-adding-a-new-http-header.md).

**Consequences:** The platform owns trace identity — anything that reintroduces
a hand-made id or a `traceparent` here re-creates the fork this entry removed,
and it fails silently. `PerfFlow` is the registry: a flow not in it opens no
spans, by design. The socket-ticket routes now return `ticketId` and
`WorkstreamService.socketTicket` mints it rather than letting the issuer
generate one, so anything that changes how ticket ids are made must keep the
route and the room recording the same value, or the socket seam stops joining.
Custom spans depend on `observability.traces` staying enabled in both regional
Wrangler configs, and on the Node suite's `cloudflare:workers` alias — a new
module that imports `tracing` is unimportable from a Node test until that shim
covers what it uses. `Date.now()` under workerd means a step's number is I/O
time and a CPU-only step reads zero. The desktop suite now buffers console
output for passing tests, so a test that was reading a log line from a passing
run's output will not find it. No saved Workers Logs view was added: the
thresholds would have been guesses. And the identity note in **Operations** is
unresolved on purpose — raw ids on spans are fine for Workers Logs and are *not*
fine to forward into PostHog identity unchanged.

Shipped in #203.
