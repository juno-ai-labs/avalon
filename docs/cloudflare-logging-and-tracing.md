# Cloudflare logging and tracing

What the Workers platform does for observability on its own, what it gives us an
API for, and what it does not do — so that a change to Rally's diagnostics is
made against the platform's actual behavior rather than against an assumption
about it. [`performance-tracing.md`](performance-tracing.md) is the Rally
subsystem built on top of this; [`runbook.md`](runbook.md#observability-views-and-retention)
is where the operational views and log conventions live. This document is the
reference for the platform underneath both.

**Everything here was read from Cloudflare's documentation on 20 August 2026,
and Workers Tracing is in open beta.** Cloudflare states plainly that span and
attribute names are not final and may be renamed to align with OpenTelemetry
conventions, and that pricing changes on 1 October 2026. Each section carries
the date on the upstream page it was read from, which is the better staleness
signal: a page Cloudflare last updated in June says less about today than one
updated in August. Re-read the linked page before relying on a specific name,
limit, or price.

Read [What automatic tracing captures that we would never
log](#what-automatic-tracing-captures-that-we-would-never-log) before enabling
an OTLP export to a third party. It is the one thing here with a consequence
beyond a dashboard.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/observability/logger.ts` | Every `console` call either Worker makes. `no-console` is an ESLint error everywhere else. |
| `apps/api/src/observability/tracing.ts` | Every custom span, over `tracing` from `cloudflare:workers`. |
| `apps/api/test/helpers/cloudflare-workers.ts` | The Node suite's stand-in for `cloudflare:workers`, including `tracing`. |
| `apps/release-retention/src/logger.ts` | The retention Worker's equivalent logger. |

### Tracing is automatic, and it is already on

*Read 20 August 2026;
[Traces](https://developers.cloudflare.com/workers/observability/traces/)
last updated 11 August 2026,
[Spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)
last updated 10 June 2026.*

With `observability.traces.enabled`, the platform instruments the Worker without
any code or SDK: handler invocations (`fetch`, `scheduled`, `queue`, `email`,
RPC), outbound `fetch`, the Cache API, and binding calls — D1, KV, R2, Durable
Objects, Queues, service bindings. A trace is the life of one request; each of
those operations is a span inside it.

Automatic spans already carry a great deal. Every span has `cloud.provider`,
`cloud.platform`, `faas.name`, `faas.version`, `faas.invocation_id`,
`faas.invoked_region`, `service.name`, `cloudflare.colo`,
`cloudflare.script_name`, `cloudflare.script_version.id`,
`cloudflare.invocation.sequence.number` — a counter that orders spans sharing a
timestamp — and `telemetry.sdk.*`. A root span adds `faas.trigger`,
`cloudflare.ray_id`, `cloudflare.handler_type`, `cloudflare.entrypoint` (for a
Durable Object, its class name), `cloudflare.execution_model` (`stateless`, or
`stateful` for a Durable Object), `cloudflare.outcome` (`ok`, `exception`,
`exceededCpu`, `exceededMemory`), `cloudflare.cpu_time_ms`, and
`cloudflare.wall_time_ms`.

The binding spans matter most here. A D1 span carries `db.system.name`,
`db.operation.name`, **`db.query.text`**, and
`cloudflare.d1.response.{rows_read,rows_written,changes,last_row_id,sql_duration_ms,served_by_region,served_by_primary,total_attempts}`.
A Durable Object emits `durable_object_subrequest` for the call and
`durable_object_storage_exec` for embedded SQL, the latter carrying
`db.query.text`, **`cloudflare.durable_object.query.bindings`**, and rows read
and written; there are separate spans for the legacy KV storage API and for
`getAlarm`/`setAlarm`/`deleteAlarm`. Naming follows OpenTelemetry conventions
with Cloudflare's extensions under `cloudflare.*`, and binding data is
hierarchical: `cloudflare.[binding].query.*`, `cloudflare.[binding].response.*`.

**This is the reason Rally installs no OpenTelemetry package.** An SDK would
add an exporter and an async-context shim to reproduce what is already running,
and its spans would form a second graph that the platform's D1 and Durable
Object spans do not appear in.

### What automatic tracing captures that we would never log

*Read 20 August 2026;
[Spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)
last updated 10 June 2026.*

Two automatic attributes carry query payloads, and Rally's do contain member
content:

- **`db.query.text`** on every D1 span, and on `durable_object_storage_exec`.
  Our SQL text is static and parameterized, so this is structure rather than
  content — but it is the full statement, and a future inlined literal would
  appear here with no code review flagging it as a logging change.
- **`cloudflare.durable_object.query.bindings`** on `durable_object_storage_exec`
  — **the bound parameter values**. WorkspaceDO and `AgentLoopDO` write
  message text, titles, objectives, and tool payloads into embedded SQLite
  through exactly this API, so message content is in these spans.

[`runbook.md`](runbook.md#log-shape) says logs must never include prompts, email
bodies, connector content, credentials, file contents, or model context, and
`apps/api/src/observability/logger.ts` enforces it with `redact`. **Neither
applies here.** These attributes are produced by the runtime, below anything
this repository controls: there is no hook to redact them, and turning them off
means turning off `observability.traces` for the Worker.

The practical consequence is about *destination*, not about instrumentation.
Traces held in Cloudflare's dashboard sit inside the same regional trust
boundary as the D1 database the content already lives in. An OTLP export sends
them somewhere else, and the two halves of that live in different places: the
**destination** is account configuration, shared by everything in the account,
while the **attachment** is per Worker — `observability.<signal>.destinations` in
one `wrangler.*.jsonc`. Creating a destination sends nothing on its own. A
Worker exports when, and only when, its own config names one.

The identity half of the same decision is in
[`performance-tracing.md`](performance-tracing.md#operations) — PostHog is keyed
on random surrogates, not on `users.id`, so a default identity mapping at the
exporter splits one person in two.

### Custom spans

*Read 20 August 2026;
[Custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)
last updated 29 July 2026.*

```ts
import { tracing } from "cloudflare:workers";
// or ctx.tracing, on the ExecutionContext passed to a handler

tracing.enterSpan(name, (span, ...args) => { … }, ...args);
tracing.startActiveSpan(name, (span, ...args) => { … }, ...args);
```

- **`enterSpan`** ends the span when the callback returns or its promise
  settles, including on a throw. It is the right one for almost everything.
- **`startActiveSpan`** does not end the span; the caller must call `span.end()`.
  It exists for work that outlives a single callback, such as stream processing.
  The span is *active* only for the duration of the callback.
- **Nesting is by async context.** A span opened inside a callback — custom or
  platform — is a child of whichever span is active. There is no way to wire a
  parent by hand, and no need for one.
- **`console` output is attributed to the active span**, so a structured log
  written inside a span is exported as an OTLP log record under that span's
  trace id. Log-to-trace correlation therefore costs nothing.

The span object is deliberately small:

- **`setAttribute(key, value)`** where the value is
  `string | number | boolean | undefined`. Passing `undefined` is a documented
  no-op; `null` is not in the accepted types at all, which is why
  `tracing.ts` filters both rather than only the one.
- **`isTraced`** — `false` when the invocation was not sampled, and also `false`
  after `end()`. `enterSpan` still runs the callback when it is false; it simply
  records nothing. Use it to skip attribute computation expensive enough to
  matter.
- **`end()`** — idempotent, and after it any further `setAttribute` is silently
  ignored, including from in-flight async work. `enterSpan` calls it for you.

Cloudflare lists four things as not yet supported, all "planned for a future
release": manual parent/child wiring, a bulk `setAttributes()`, **any access to
the trace or span id**, and `setOutcome()` for span status. The last two shape
Rally's code directly — a status travels as `otel.status_code` and `error.type`
attributes instead, and nothing here can read or forge a trace id.

### Known limitations that change how code is written

*Read 20 August 2026 —
[Known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).*

- **A span can report `0 ms` for work that took longer.** Timing comes from a
  clock the runtime pins during synchronous execution as a Spectre mitigation,
  so a span that performs no I/O measures zero. This applies to the platform's
  own spans as much as to ours. Read a duration as *time spent waiting on I/O*,
  never as elapsed wall time.
- **Trace ids do not propagate outside Cloudflare.** Inside — across bindings,
  Durable Objects, service bindings — the platform links spans itself; across
  the boundary to the Electron client or a provider, it does not, and there is
  no id to hand over even if it did. Anything that has to join across such a
  boundary joins on an attribute both sides record.
- **Span and attribute names are not final.** They may be renamed during beta to
  align with OpenTelemetry conventions. A dashboard built on a
  `cloudflare.*`-prefixed name is a dashboard that can break without a
  deployment on our side.
- **`service.name` and `faas.name` are not reliably on every span.** The
  attribute reference lists both under "all spans" and the limitations page says
  they apply only to some; where two pages disagree, trust the limitations page,
  and filter by `$metadata.service` to select a Worker consistently.
- **Attributes are incomplete and being added to**, so an attribute's absence
  today is not evidence it will not exist tomorrow.
- A root span reads **"Trace in Progress"** while the request is still running;
  the complete trace appears shortly after it finishes.

### Workers Logs

*Read 20 August 2026;
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
last updated 11 August 2026.*

With `observability.enabled`, the platform collects invocation logs, `console`
output, errors, and uncaught exceptions. **A log written as a structured JSON
object has its fields extracted and indexed**, which is what makes filtering on
a field work at unlimited cardinality — and it is why
`apps/api/src/observability/logger.ts` logs one object per `console` call and
never a serialized string. Anything stated only inside a message string cannot
be filtered on.

An **invocation log** is emitted per request in addition to anything the code
logs — identifiable by `$cloudflare.$metadata.type = "cf-worker-event"`, and
disableable with `observability.logs.invocation_logs = false`. Rally leaves it
on; it is what carries the request and response metadata the `http_request` row
does not.

*Observed 8 September 2026, on the Global Worker's invocation logs.* The
investigation behind #607 found long, low-CPU Durable Object invocations ending
around initialization, including `jsrpc` sessions with
`$workers.event.rpcCallCount: 0`. This supported a cold-activation hypothesis
for those opens; it is not a documented guarantee that zero-call RPC sessions
always mean activation. A caller's wait can also include constructor/readiness
and queueing. Correlate the phases using
[the investigation procedure](production-error-investigation.md#a-slow-call-into-a-durable-object)
and [socket timing](performance-tracing.md#what-room_upgrade-contains).

Limits worth knowing: **7 days retention** (3 on the Free plan); **256 KB per
log**, with anything larger truncated and `$cloudflare.truncated` set — which is
what a very large redacted payload would hit; and **5 billion logs per account
per day**, after which Cloudflare applies a 1% head sample for the rest of the
day, so an unrelated Worker's log storm degrades ours. Head sampling is
`head_sampling_rate` between 0 and 1, defaulting to 1, and **logs and traces can
be sampled independently** — `observability.head_sampling_rate` and
`observability.traces.head_sampling_rate`. Rally sets 1 for both in both
regions.

### Exporting to a third party

*Read 20 August 2026;
[Traces](https://developers.cloudflare.com/workers/observability/traces/)
last updated 11 August 2026.*

Traces follow OpenTelemetry standards and export to any OTLP endpoint —
Honeycomb, Grafana Cloud, Axiom, Sentry are the ones Cloudflare names. Logs
export the same way and share the trace id, so a destination correlates them
without configuration. `persist: false` exports without also storing the trace in
Cloudflare's dashboard.

## Invariants

- **No OpenTelemetry package is installed, and no trace id is minted here.** The
  platform owns trace identity and propagation; the runtime does not even expose
  the id. Anything hand-made forks the trace graph, and the failure is silent —
  every span still looks correct on its own.
- **Every diagnostic goes through a logger, as one structured object.** A
  serialized entry cannot be filtered and a bare object lists as a blank row.
  `no-console` enforces this outside the two logger modules.
- **A duration of `0 ms` is not a bug report.** See the Spectre note above.
- **Custom spans depend on `observability.traces` being enabled.** With it off
  the callbacks still run and nothing is exported, so the symptom is missing
  traces rather than an error.

## Boundary

This document describes the platform. It does not decide what Rally traces —
that is [`performance-tracing.md`](performance-tracing.md) — nor what it logs
and how those rows are queried, which is
[`runbook.md`](runbook.md#observability-views-and-retention). It does not cover
product analytics: [`telemetry.md`](telemetry.md) owns the regional PostHog-bound
pipeline — the collector, the outbox, and the adapter — which is a different
system with different privacy rules and is not built on any of this.

Since #207 there are **two** paths to PostHog and only one of them is that one.
The Global Worker also exports its Workers Logs and traces to PostHog over OTLP,
and that path *is* built on everything described here: it carries whatever the
platform puts on a span, under the platform's rules rather than the telemetry
pipeline's. "PostHog" alone is no longer enough to say which path is meant.

## Failure modes and limits

- **Pricing changes on 1 October 2026, and spans and logs share one quota.**
  Cloudflare counts **each span as one observability event, on the same monthly
  allowance as each log event**: 20 million a month included on Workers Paid,
  $0.60 per additional million, 200,000 a day on Free. A custom span is
  therefore exactly as expensive as a log row, which is worth knowing before
  reaching for either. Rally runs at `head_sampling_rate: 1` for both in both
  regions and adds roughly a dozen custom spans to a conversation create on top
  of the platform's own, so lowering the sampling rate — separately for logs and
  traces, which the config allows — is the lever if the bill becomes the
  constraint, not deleting spans.
- **Beta naming.** A rename by Cloudflare breaks a saved query, not a
  deployment. Prefer filtering on Rally's own `avalon.*` attributes, which we
  control, over `cloudflare.*` ones, which we do not.
- **Logs are truncated at 256 KB** and retained 7 days, and the account-wide
  5-billion-a-day ceiling drops everything to a 1% sample for the rest of that
  day — a limit another Worker on the account can spend on our behalf.
- **`tracing` does not exist off workerd.** A Node test importing a module that
  imports it needs the alias in `apps/api/test/helpers/cloudflare-workers.ts`.

## Testing

There is nothing to test here — this document describes a platform, not code.
What the repository tests is its own layer: `apps/api/test/tracing.test.ts` for
the custom spans and `apps/api/test/structured-logging.test.ts` for the log
shape. The Node suite's stand-in for `cloudflare:workers` keeps the contract a
call site depends on but nests nothing and exports nothing, so anything
depending on real nesting or export belongs in `apps/api/test-workers/` — see
[`testing.md`](testing.md).

### 2026-09-08 — A Durable Object invocation's wall time includes its activation

**What changed:** Recorded, dated, that a Durable Object invocation log's
`wallTimeMs` covers the platform's activation of a cold object before the
constructor runs, at near-zero CPU, and that an RPC session opened during that
wait is logged with `rpcCallCount: 0`.

**Why:** Three slow conversation opens read as a slow room for as long as the
only numbers were the edge's step and the room's own phases; the invocation
logs were what separated the platform's seconds from Rally's milliseconds, and
nothing here said how to read them. The zero-call session in particular reads
as "the caller called nothing" until it is known to mean "the caller waited".

**Consequences:** A slow binding span or `room_upgrade` step on a cold object
is not attributable to the object's code until the invocation log's CPU and
the constructor's timing rows have been read beside it.

Shipped in #607.

### 2026-08-20 — The per-Worker opt-in is what makes a one-region export possible

**What changed:** Recorded that an OTLP destination is account configuration but
the opt-in is per Worker, through `observability.<signal>.destinations` in each
`wrangler.*.jsonc`. The page previously said "nothing in this repository decides
where telemetry is sent", which was wrong in the way that mattered — and, in a
first pass at this entry, said so in a new section while two earlier passages
here and in [`performance-tracing.md`](performance-tracing.md) still claimed a
destination "covers configured regional Workers at once". Review caught the
contradiction; both passages now describe the split.

Shipped in #207.

### 2026-08-20 — Document created

**What changed:** Nothing in the code. This document records what Cloudflare's
Workers observability platform does, as read from its documentation on this
date.

**Why:** Rally's first custom-span instrumentation was written three times
before it was written correctly. The first attempt added a hand-rolled OpenTelemetry
layer — W3C trace ids, `traceparent` propagation, a span record per phase — all
of which the platform already does, and none of which would have joined the
platform's own spans. The second attempt kept a hand-made trace id for the two
seams the platform cannot cross. Both were reasonable from the code alone;
neither survived contact with the documentation. The reasoning that corrects
them — the runtime does not expose a trace id, propagation stops at the
Cloudflare boundary, a `0 ms` span is a Spectre mitigation rather than a
measurement error — is not discoverable from our source, so it is written down
here rather than left to be rediscovered.

**Considered and rejected:** Folding this into
[`performance-tracing.md`](performance-tracing.md). That document is about three
Rally flows and is edited whenever they change; this one is about a third
party's platform and is edited when that platform changes, which is a different
cadence and a different reason. Keeping them together would have meant a beta
rename by Cloudflare editing a document about conversation creation.

**Consequences:** Every claim here carries the date it was read *and* the date
Cloudflare last updated the page, because the platform is in open beta and
Cloudflare says the names are not final and the prices change on 1 October 2026.
Treat an undated claim added later as a defect. This document is the place to
check before adding an observability dependency; the standing answer to "should
we install an OpenTelemetry SDK" is no, and the reason is in **How it works**.

It also records one thing nobody had looked for: automatic tracing puts
`cloudflare.durable_object.query.bindings` on every embedded-SQL span, which
means member message content is in the traces of configured regional Workers today,
below the level `redact` operates at. That is tolerable while the traces stay in
Cloudflare's own storage and intolerable to assume through an OTLP export
without deciding it deliberately, so
[the section on it](#what-automatic-tracing-captures-that-we-would-never-log) is
the gate on configuring an export destination.

Shipped in #203.
