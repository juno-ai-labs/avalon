# Performance tracing

Three things in Avalon are slow enough that a person notices: starting a work
stream, opening one that already exists, and sending a message to one. Each
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
| `apps/api/src/observability/tracing.ts` | The whole API-side surface: `inSpan`, `inFlowSpan`, `requestFlowSpan`, `noFlowSpan`, and `identityAttributes` — the one place an Avalon identifier becomes an attribute name. |
| `apps/api/wrangler.global.jsonc`, `apps/api/wrangler.eu.jsonc` | `observability.traces`, which is what makes any of this reach a trace. Custom spans require it; see [`cloudflare-logging-and-tracing.md`](cloudflare-logging-and-tracing.md). |
| `apps/api/src/routes/workstreams.ts` | The root span for `POST /workstreams`, `GET /:id`, `GET /:id/messages`, `POST /:id/messages`, and both socket-ticket routes. |
| `apps/api/src/services/workstream-object-creation-service.ts` | The create path's steps — every awaited call between the receipt and the activated route. |
| `apps/api/src/services/socket-service.ts` | `SocketService.upgrade`: the edge half of a socket open. |
| `apps/api/src/durable-objects/substream-agent.ts` | The room: product operations, socket acceptance, subscription, snapshot assembly. |
| `apps/api/src/durable-objects/workspace-do.ts` | The workspace command socket's `create_message`, which is how the desktop actually sends a message. |
| `apps/api/test/helpers/cloudflare-workers.ts` | The Node suite's stand-in for `tracing`, and `recordedSpans()`, which is how a Node test asserts on span names and attributes. |
| `apps/desktop/src/renderer/lib/perf-trace.ts` | The renderer's local tracer and `newRequestId`. Not OpenTelemetry — see [The desktop half](#the-desktop-half). |
| `apps/desktop/src/renderer/lib/api.ts` | Stamps `x-request-id` on every HTTP call and prints one line per call. |
| `apps/desktop/src/common/logger.ts` | `logDebug`, the trace level the renderer's lines print at. |

## How it works

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
attributes that every nested span then sits beneath, and it accumulates each
`step`'s duration so the flow **also** emits one `perf_flow` log row carrying
the whole breakdown, its `slowest_step`, and the identity.

That row is not a duplicate of the trace. A trace answers *what happened in this
one invocation* and is read in a trace UI or at the OTLP destination; the row
answers *which step is slow across ten thousand creates* from the Workers Logs
Query Builder, with no join and no trace sampling in the way. It is not free:
Cloudflare bills a span and a log event identically, out of one allowance, so
the row costs the same as adding a thirteenth span. One row per flow is the
budget it is worth.

Durations come from `Date.now()`, which workerd pins for the duration of a
synchronous run and advances only across I/O — a Spectre mitigation, and the
same reason Cloudflare documents its own spans as sometimes reporting `0 ms` for
work that took longer. A step's number is therefore the time it spent waiting on
D1, a Durable Object, or a provider, and a step that is pure computation reads
`0ms` however long it took. Nothing on these paths is CPU-bound.

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
| `avalon.flow` | `workstream_create`, `workstream_open`, or `workstream_message_send`. |
| `avalon.component` | Which participant emitted it: `api`, `api_socket`, `substream_do`, `workspace_do`. |
| `avalon.workspace.id`, `avalon.workstream.id`, `avalon.substream.id` | The identifiers a slow trace has to be attributable to. |
| `avalon.request.id` | The desktop's `x-request-id`. |
| `avalon.socket.ticket_id`, `avalon.socket.connection_id` | The two socket joins below. |
| `avalon.message.client_id` | The composer's client message id. |
| `avalon.harness_run.id`, `avalon.agent.invoked` | What the write started. |
| `avalon.snapshot.bytes`, `avalon.snapshot.message_count`, `avalon.snapshot.trims` | What a subscription had to assemble. |
| `avalon.create.path`, `avalon.create.receipt_state`, `avalon.create.first_naming` | Which create this was. |

`identityAttributes` in `tracing.ts` is the only place an Avalon identifier
becomes an attribute name. Add a name there rather than at a call site, so a
rename happens once and a dashboard filtering on `avalon.workspace.id` never has
to know which component emitted the span.

### What the platform cannot join, and what does

Automatic tracing links a Worker to everything it calls. It cannot link two
separate client-initiated invocations, and each of these flows has at least one
seam of that kind. Each is bridged by an **attribute both traces carry** —
deliberately an attribute and never a stand-in trace id, because a hand-made
trace id would build a second trace graph beside the platform's and the two
would never meet.

| Seam | The attribute that crosses it |
| --- | --- |
| Renderer → Worker, over HTTP | `avalon.request.id`, from the `x-request-id` the desktop mints per call and the Worker echoes. |
| `GET …/socket` → the WebSocket upgrade → the room | `avalon.socket.ticket_id`. A browser can attach no header to a handshake — see [`realtime-sockets.md`](realtime-sockets.md) — so the ticket id, which the issuing route logs and the room consumes, is the only shared value. |
| The room's upgrade → the `subscribe` that follows | `avalon.socket.connection_id`. `subscribe` arrives on a later invocation, possibly on a woken isolate. |
| Renderer → workspace command socket → WorkspaceDO | `avalon.message.client_id`, which the renderer, the command, and the command result all carry. |

### The three flows

**`workstream_create`** — `POST /workstreams` opens `workstream.create` and the
creation service adds a span per awaited call:
`workstream.create.authority.read_recheck` (named for the second read it is —
the route already resolved the same row), `…receipt.reserve`, `…receipt.read`,
`…email_address.reserve`, `…d1_rows.write`, `…object.initialize`,
`…substream.flush_effects`, `…workstream.flush_directory`,
`…workspace.directory_probe`, `…route.activate`, `…email_route.activate`,
`…receipt.complete`. Inside `object.initialize` the room adds
`workstream.room.initialize` and its children. A replayed create is labelled
`avalon.create.path = replayed_receipt` so it does not sit in the same
distribution as a first one.

**`workstream_open`** — four traces, joined by the attributes above: the
socket-ticket route (`workstream.socket.ticket`), the edge upgrade
(`workstream.socket.upgrade`), the room's acceptance
(`workstream.room.socket.accept`), and the room's subscription
(`workstream.room.socket.subscribe`). When the subscription's plan is a
snapshot, `workstream.room.snapshot.detail`, `…transcript`, and `…encode` sit
inside it. `avalon.snapshot.trims` is worth reading beside the byte size: the
trim loop re-serializes the whole frame per dropped message, and that count is
the only place its cost appears. `GET /:id` and `GET /:id/messages` carry the
same flow, because a resync fetches canonical state over HTTP and is part of the
same wait.

**`workstream_message_send`** — the desktop sends over the workspace command
socket, so `workstream.message.send` on WorkspaceDO is the trace to read:
`…authority_read`, `…session_auth`, `…object_write`, `…respond`, with the room's
`workstream.room.create_message` nested under the write. `POST /:id/messages`
traces the same flow for the HTTP path, distinguished by `avalon.transport`.

### The desktop half

The renderer is not a Worker, so automatic tracing does not reach it and there
is no span to attach to. It is deliberately **not** an OpenTelemetry client:
shipping a browser SDK and an exporter out of the Electron renderer would move
telemetry off the main-owned regional path [`telemetry.md`](telemetry.md)
requires everything to travel on.

Instead `AvalonApi` stamps `x-request-id` on every call and prints one
`[perf] http <method> <path> <status> <ms>` line, and each flow prints one
`[perf] <flow> <ms>` line carrying its phases and the correlation ids above.
Both go through `logDebug`, which is `console.debug`: filtered out of DevTools
and of a terminal until a reader opens the Verbose level. That is what lets it
stay on in every build rather than behind a preference nobody had enabled when
the slow open happened.

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

This module owns latency diagnosis for the three named flows and nothing else.

- **It is not product telemetry.** [`telemetry.md`](telemetry.md) owns product
  signals, their regional routing, and the preferences that gate them; the
  `api_operation_outcome` event's coarse duration bucket is a product metric and
  stays where it is. A span and a `perf_flow` row are diagnostics, subject to
  Workers Traces and Workers Logs retention, and reach no destination adapter.
- **It is not the run ledger.** A harness run's duration, tokens, and cost are
  `harness_run_finished` and the `RUN_ANALYTICS` dataset, described in
  [`runbook.md`](runbook.md#root-run-analytics). Tracing stops at the run
  dispatch: the run is asynchronous by design and is not part of what the caller
  waits for.
- **It does not configure the exporter.** Where traces and logs are sent is
  `observability` in the Wrangler configs plus the account's OTLP destination,
  and neither is decided here.
- Callers are the routes, services, and Durable Objects listed above. New spans
  are welcome inside the three flows; a fourth flow means adding a name to
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
- **Retention is the platform's.** Nothing here is durable, and a flow
  investigated a month later has no trace and no rows.
- **The desktop's lines are lost on quit.** They live in the renderer's console
  and are written nowhere.

## Testing

| Suite | What it proves |
| --- | --- |
| `apps/api/test/tracing.test.ts` (`pnpm --filter @avalon/api test`) | That a step opens a runtime span and ends it, that the step which threw is still ended and the rejection propagates, the `perf_flow` row's step map and `slowest_step`, `setError`'s status attributes, that an absent identifier sets no attribute, that `noFlowSpan` opens nothing, and that a request's span carries the `x-request-id` the desktop sent. |
| `apps/desktop/src/renderer/lib/perf-trace.test.ts` | The renderer tracer's phase order, its throwing phase, `end` idempotence — every socket path calls it defensively — and that `newRequestId` produces something `requestContext` will accept rather than replace. |
| `apps/desktop/src/renderer/lib/api.test.ts` (`request correlation`) | That every call carries a distinct `x-request-id`, and that a caller's own id is used when it has one. |
| `apps/api/test/security-and-config.test.ts` | That `x-request-id` survives the CORS preflight in both regions and is exposed on the response. |

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
   `avalon.request.id`, `avalon.socket.ticket_id`, or
   `avalon.message.client_id`. For a socket open, follow
   `avalon.socket.ticket_id` into the room's acceptance, then
   `avalon.socket.connection_id` into the subscription.
3. In Workers Logs, `event = perf_flow` with the same `request_id` gives the
   same breakdown as one row, including `slowest_step`.

To find the pattern rather than the instance, filter `event = perf_flow` with
`flow = <name>` and `duration_ms >` a threshold, and group by `slowest_step`.
Worth adding to the saved views in [`runbook.md`](runbook.md#log-shape) once
there are enough production rows to pick thresholds that are not guesses; they
are deliberately not guessed here.

**Before any of this is pointed at a third-party destination**, two things have
to be decided rather than inherited.

The first is not about this module at all and is the larger of the two: the
platform's automatic Durable Object SQL spans carry
`cloudflare.durable_object.query.bindings`, which for Avalon means message
content, with no hook to redact it —
[`cloudflare-logging-and-tracing.md`](cloudflare-logging-and-tracing.md#what-automatic-tracing-captures-that-we-would-never-log)
has the detail. An OTLP export moves that content out of the region's own trust
boundary.

The second is identity. Spans carry raw `avalon.workspace.id` and `user.id`, which is
what every other diagnostic in Workers Logs already carries. PostHog identity in
this repository is deliberately *pseudonymous*: the product pipeline sends
`analyticsSubjectId` and `workspaceAnalyticsId`, never the raw ids — see
[`telemetry.md`](telemetry.md). An exporter that forwarded these attributes into
`distinct_id` or `$groups` unchanged would not merely widen what PostHog holds;
it would make the same human two different people there, one under each id.
Either map through the analytics identities at the exporter, or keep the
attributes as opaque correlation values and do not promote them to identity.

## Changelog

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

Shipped in #TBD.
