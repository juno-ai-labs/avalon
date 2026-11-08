# Production error investigation handbook

Production debugging in Rally is an exercise in joining partial evidence. A
Cloudflare error chart, a Workers Log row, a PostHog event, and an analytical
lakehouse row can describe the same user-visible incident, but none is a
complete account on its own. This handbook explains what each surface can
establish, where it can mislead, and how to move between them without turning
one useful investigation path into a mandatory checklist.

Use the smallest set of surfaces that can answer the question. A count that is
already explained by invocation type and status does not require raw inference;
a model-behaviour question cannot be answered from a redacted error log. The
recipes below are starting points, not a required order of operations.

Exact credentials, commands, resource names, and retention procedures live in
the [`runbook`](runbook.md). Cloudflare's field names and observability limits
can change; verify them against
[`cloudflare-logging-and-tracing.md`](cloudflare-logging-and-tracing.md) and the
current [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
documentation before relying on them.

## Begin with a claim, not a dashboard

Write down the claim being tested in one sentence. Include the population,
time window, region, and observable outcome when they are known:

> Global WorkspaceDO alarms on the deployed scheduler build still finish as
> `clientDisconnected` after entering application work.

That is more useful than “there are 3,000 errors.” It identifies several facts
that must be separated:

- **Population:** one Durable Object class and alarm invocations, rather than
  HTTP requests or WebSocket messages in the same Worker.
- **Window:** completed UTC boundaries, rather than a dashboard's rolling
  “past day” while its newest bucket is still filling.
- **Deployment:** the version actually serving production, not merely a merged
  pull request or a successful build.
- **Outcome:** a runtime classification, which is not yet an application cause.
- **Application entry:** whether any Rally phase began before the runtime ended
  the invocation.

Keep the claim provisional. A good investigation changes the question when the
evidence disproves its premise.

## Evidence map

| Surface | Best at answering | It cannot establish by itself |
| --- | --- | --- |
| Cloudflare Worker and Durable Object analytics | Request and invocation volume, handler type, runtime outcome, CPU/wall time, class or entrypoint, and version-level changes | Which application phase ran, whether a user saw a failure, or whether an outcome labelled `clientDisconnected` involved a WebSocket |
| Cloudflare Workers Logs | One invocation's platform record, uncaught errors, and Rally's structured, content-free diagnostic events | Long-term completeness after retention, unsampled history, or content deliberately excluded from logs |
| Cloudflare Workers Traces | Ordering and latency across handlers, bindings, Durable Objects, and Rally custom spans | A complete cross-system trace where the runtime does not propagate identity; safe-to-export content without reviewing automatic span attributes |
| PostHog OTLP logs and traces | The Global Worker's exported Cloudflare logs and traces, queried beside other operational evidence | Governed product-event semantics; the privacy guarantees or routing rules of Rally's typed telemetry pipeline |
| Regional D1 and owning Durable Object state | Current and historical facts owned by that authority, outbox state, receipts, and durable scheduling state | A cross-authority timeline or events that were never persisted there |
| GitHub Actions and Cloudflare deployment state | Which commit passed which checks, what deployed, and when the active version changed | Whether propagation was complete at the start of an arbitrary metric bucket unless timestamps are compared |

Some deployed resource names still contain `avalon` as compatibility
identifiers. The presence of that legacy name is not evidence that an old
product build is serving traffic. Treat configuration and the active binding as
authoritative; renaming a resource during an investigation can point at a
different or nonexistent dataset.

## A flexible investigation loop

Most investigations benefit from the following shape, but may enter at any
point:

1. **Bound the observation.** Prefer a completed hour or explicit UTC range.
   Record the region, service, entrypoint, invocation type, and denominator as
   well as the error count.
2. **Establish deployment state.** Follow the merge commit through the deploy
   workflow and confirm the active Cloudflare version. Split the window at the
   activation timestamp; do not attribute pre-deploy rows to the new build.
3. **Partition before sampling details.** Break the aggregate down by runtime
   status, invocation type, class/entrypoint, version, and region. A total that
   mixes alarms, HTTP, queues, and WebSockets is usually not actionable.
4. **Correlate representative invocations.** Open one or more invocations using
   platform invocation/request/trace and Durable Object IDs. Look for the first
   and last Rally phase, not just the terminal platform label.
5. **Cross-check the user's reality.** When the issue is user-visible, compare
   server evidence with registered client/product events, release/build, and
   authoritative state. A server success can still produce a broken experience;
   a client network error can occur after the server committed successfully.
6. **Challenge both presence and absence.** Ask which false-positive mechanism
   could create the observation and which false-negative mechanism could hide
   the failure. Expand to another surface only when it can discriminate between
   the remaining explanations.
7. **Classify and preserve uncertainty.** State what is proven, what is
   supported, what was ruled out, and what remains unobserved. A small
   reproducible unknown is better than an overconfident root cause.

For before/after comparisons, use identically sized completed windows when
possible and report both counts and rates. Changes in traffic, scheduled-work
volume, or client release adoption can make a raw-count improvement look larger
or smaller than it is.

### Cloudflare invocation analytics

Start here when the symptom is a Worker or Durable Object error count. Query or
group by the dimensions that distinguish the runtime paths in the claim:

- service and script version;
- Durable Object namespace/class or entrypoint;
- invocation type or origin (`fetch`, alarm, queue, scheduled, WebSocket);
- outcome/status (`ok`, exception, CPU, memory, internal, disconnect);
- completed time bucket and region where available.

Use Cloudflare's GraphQL Analytics API when exact, repeatable buckets or
multi-dimensional breakdowns matter. Use the dashboard for exploration, but
record the actual filters and UTC boundaries before reporting a result. The
dashboard's headline “Errors” is an entry point, not an error taxonomy.

The denominator should match the mechanism. Compare failed alarms with all
alarm invocations, not with all requests to the namespace. Compare socket
disconnects with socket sessions or connection attempts, not with alarm
deliveries that happen to use the same runtime status label.

### Workers Logs and observability queries

Workers Logs contains two related records that are easy to conflate:

- the **invocation log**, produced by Cloudflare once for the invocation; and
- Rally's **structured application rows**, produced only after Rally code
  reaches the corresponding logger.

Cloudflare identifies invocation logs as `cf-worker-event`. Rally rows carry a
stable `event` and indexed fields. Filter on fields rather than rendered message
text; a stringified log is opaque and a prose search is both slower and less
reliable.

For an unfamiliar event, first inspect available keys and values, then issue a
narrow query. The observability API and Query Builder evolve, so discovering
keys is safer than guessing a field name from an old screenshot. For API-driven
exploration, short windows, bounded result limits, and query-only/dry modes make
iterations cheaper and reduce accidental broad retrieval. Avoid requesting a
time series when the question only needs rows.

Useful correlation fields include the platform invocation and trace IDs,
`request_id`, region, build/version, entrypoint, and
`$workers.durableObjectId`. Use platform-owned object identity rather than
adding workspace names, alarm keys, or other product content to diagnostics.

Absence is meaningful only after checking that logs were enabled and retained,
the version emitted the event, the time window and region are correct, and the
invocation reached application code. An invocation row with no matching
application event can be the most important evidence in the investigation.

### Workers Traces

Open a trace when ordering, binding calls, or latency between phases matters.
Cloudflare automatically traces handler and binding activity; Rally adds custom
spans only where an application boundary needs a name. Do not create a second
trace identity to join them.

Two caveats matter during interpretation:

- a displayed `0 ms` span is not proof that no time passed; Workers' clock
  behaviour can pin time during CPU-only work, so use wall time and Rally's
  explicit elapsed fields where available;
- automatic Durable Object SQLite spans can include SQL binding values. Those
  values may contain member content even though Rally's own logs are redacted.
  Keep traces inside their approved regional destination and never paste raw
  span payloads into tickets, commits, or chat.

Global Workers Logs and traces are also exported to PostHog over OTLP. Always
say **PostHog product telemetry** or **PostHog OTLP logs/traces**; the two paths
have different schemas, privacy boundaries, and failure modes.

### PostHog product telemetry

Use product telemetry when the question is about what the client or product
observed: connection attempts, timeout decisions, releases, journeys, or
registered exceptions. Start from the canonical Rally event name and its
registry, not from a similarly named PostHog-reserved event. Verify source,
release/build, region eligibility, identity scope, and sampling/preference
rules before treating a count as a population.

Product telemetry is advisory. It is emitted around a product action but does
not own that action, and delivery failure never changes product behaviour. Join
an event to a server request, operation, trace, or authoritative record when the
question requires proof that the action committed.

### Analytics events lakehouse

Use the analytics lakehouse when a Global typed event must be checked outside
PostHog or when stable event-level metadata and deduplication matter. Query R2
SQL through the authenticated HTTP API as described in
[`Querying analytics events in production`](runbook.md#querying-analytics-events-in-production),
starting with promoted, content-free columns and a bounded time range.

The table is an at-least-once projection: deduplicate on `event_id`. A row can
take roughly one Pipeline roll interval to become queryable. If it is missing,
inspect the regional acceptance/outbox state and Queue/DLQ before concluding
capture failed. `delivered` means the Worker handed the row to Pipeline, not
that the latest Parquet roll is already queryable.

### Inference lakehouse

Use the inference lakehouse only when the question requires what Rally sent to
or received from a model provider. Begin with typed dimensions for one Global
conversation (`workstream_id`), substream, request, and bounded time range; retrieve raw request or
response JSON only after the typed rows identify the exact inference pair. The
full procedure is in
[`Inspecting a run's raw inference`](runbook.md#inspecting-a-runs-raw-inference).

### Authoritative state and delivery machinery

When an event says an action was requested or a log says a handler ran, inspect
the store that owns the resulting fact. WorkspaceDO (which also hosts every
Canvas and Sidekick parent), `AgentLoopDO`, D1 control tables, Queue receipts, and outboxes answer different
questions. Do not create a cross-store “truth” by choosing whichever copy is
easiest to query.

Outboxes and DLQs are particularly useful for distinguishing accepted work from
exported work. A pending or queued analytical record can explain missing
analytics without explaining a product failure. Conversely, an empty DLQ does
not prove a downstream provider accepted every request if terminal rejections
are deliberately acknowledged and recorded elsewhere.

## Common false positives

A false positive is real evidence interpreted as the wrong kind of failure.
Common examples include:

- **`clientDisconnected` is treated as a WebSocket disconnect.** It is a
  runtime outcome. On an alarm invocation it can mean a queued alarm delivery
  was superseded before Rally work began; it says nothing about a member's
  socket unless the invocation type and correlated socket evidence say so.
- **A client cancellation is counted as a server defect.** Navigation, app
  shutdown, a replacement request, or a response consumer going away may end a
  successful or no-longer-needed invocation.
- **A merged fix is assumed deployed.** Metrics from before the active version
  timestamp, or during propagation, are attributed to the new code.
- **A rolling window is compared with a completed window.** A partial newest
  bucket or different day length changes the apparent rate.
- **An invocation outcome is treated as a product outcome.** A server can
  commit before the response disconnects; a server `ok` can still carry the
  wrong state or an unusable response.
- **At-least-once rows are counted physically.** Queue/Pipeline duplicates in a
  lakehouse are one logical event when their `event_id` matches.
- **A PostHog destination name is treated as the source event.** Reserved event
  mappings and historical aliases can hide or duplicate the semantic question
  if the canonical Rally event name is not checked.
- **A trace duration is read literally.** `0 ms`, an incomplete trace, or a
  long root span does not identify the slow application phase on its own.
- **A compatibility resource name is read as deployment age.** A name that
  still contains `avalon` may be an intentionally retained identifier.
- **A slow step that wraps a Durable Object call is read as the object's
  work.** The caller's step and the platform's binding span both include the
  object's activation — placement, storage, and the constructor — before the handler. Constructor spans cover initialization but not the
  preceding platform wait.
  The object's own flow row, the constructor's `durable_object_initialization`
  row on the same invocation, and the invocation log's `cpuTimeMs` say whether
  the object was slow or was being woken; on a feed upgrade
  `rally.socket.room_outside_accept_ms` carries the time outside acceptance,
  including constructor/readiness and queueing.

The recent WorkspaceDO alarm investigation is the canonical example. The
pre-work recovery arm once created an immediately due second alarm. Cloudflare
counted the redundant queued delivery as an alarm `clientDisconnected`, nearly
one for every successful alarm. After the scheduler change, investigators first
confirmed that the active version emitted phase events, the sampled objects had
already migrated and were hot, and the relevant logs were retained and
unsampled. A remaining disconnect with no
`workspace_scheduled_alarm_phase_started` row then established the bounded
finding that the observed delivery never entered instrumented Rally work.
Correlated successful alarm invocations and authoritative scheduling state
ruled out lost scheduled work; the alarm invocation type ruled out a WebSocket
failure. The phase instrumentation and interpretation live in
[`durable-object-alarms.md`](durable-object-alarms.md#workspace-phase-instrumentation).

## Common false negatives

An empty result is not automatically evidence that nothing failed. Check for:

- log or trace sampling, truncation, retention expiry, disabled invocation
  logs, or an account-level volume event that changed effective sampling;

- a handled application failure that returned `ok` to the runtime and recorded
  a warning, typed outcome, state transition, or audit row instead of throwing;

- client product telemetry suppressed by preference, sampling, launch state,
  offline delivery, or an unsupported region;

- a disconnect or runtime cancellation before the first application log or
  phase event could be emitted;

- a just-deployed version that had not become active for the whole query window;

- PostHog delivery lag or failure, or querying product telemetry when the event
  arrived through the separate OTLP path;

- Pipeline roll delay, outbox backlog, Queue retry, DLQ delivery, or a terminal
  integrity rejection before a lakehouse row became queryable;

- a successful low-level call followed by a later failure at the product,
  client-rendering, replay/resync, or authorization boundary;

- an aggregate that hides one hot Durable Object, release cohort, provider, or
  minority status behind a healthy overall rate.

When application evidence is absent, look at the nearest earlier durable or
platform boundary. “The invocation existed but the first Rally phase did not”
is a bounded finding. “Nothing happened” is not.

## Correlation patterns

These patterns are intentionally small. Add a surface only when it tests a live
hypothesis.

### A Durable Object error spike

1. Split the namespace total by invocation type and runtime status.
2. Split the relevant type by active script version and completed time bucket.
3. Inspect representative invocation logs and traces by Durable Object ID.
4. Find the first and last Rally structured phase. For WorkspaceDO alarms, use
   the content-free phase events documented in
   [`durable-object-alarms.md`](durable-object-alarms.md#operations).
5. Compare failures with the matching successful-invocation denominator and,
   when relevant, group slow successes by phase/kind before changing scheduling
   behaviour.

### A slow call into a Durable Object

1. Compare the object's own flow duration with the caller's step. A large
   difference means time outside that handler, including constructor/storage
   readiness and input-gate queueing; it does not establish a platform fault.
2. Inspect constructor phases and overlapping handlers first. Workerd's clock
   does not advance during synchronous work, so also read invocation CPU time.
3. Filter invocation logs by `$workers.durableObjectId` for the window. Long,
   low-CPU invocations ending together around initialization are evidence
   consistent with activation waits, to correlate with the constructor phases.
4. Check the preceding socket close, alarm, RPC, and idle interval to understand
   why the object might have been cold. On feed upgrades, use
   `rally.socket.room_outside_accept_ms` and instance age as supporting context;
   neither proves which concurrent call woke the object.

### “The socket disconnected”

1. Establish which socket: workspace, conversation, or another
   realtime surface.
2. Separate WebSocket handler/session evidence from alarm, HTTP, queue, and
   scheduled invocations in the same Worker or Durable Object namespace.
3. Correlate client connection/reconnect/heartbeat events with server upgrade,
   message, close/error, and hibernation/resync evidence.
4. Ask whether the user lost state or merely reconnected. For a hibernated
   `AgentLoopDO`, an empty in-memory replay buffer requires the canonical
   snapshot/resync path; it does not prove the socket transport failed.
5. Treat ping/pong timeout telemetry as the client's reason for reconnecting,
   not proof of where packets were lost. Network transition, app suspension,
   intermediary idle handling, server eviction, and application close policy
   remain different hypotheses.

1. Use structured logs and authoritative run state to determine the run and
   terminal classification.

3. For Global, query typed inference rows for the exact conversation (`workstream_id`), substream,
   request, and time range.

4. Retrieve the raw pair only if the typed evidence cannot answer the question;
   keep it in an ignored scratch directory and out of logs and reports.

### “The analytics event is missing”

1. Confirm the canonical event exists in the registry and that the source,
   preference, sample rule, and region were eligible.
2. Check regional acceptance and receipt/outbox state before the destination.
3. In Global, query PostHog product telemetry and the analytics lakehouse as
   separate projections. Allow for Pipeline roll delay and deduplicate by event
   ID.
4. Inspect the Queue/DLQ or terminal rejection state if accepted evidence did
   not reach the lakehouse. Do not infer a product failure from an analytics
   delivery failure.

## Privacy and regional boundaries

Production evidence is still production data, even when it is called
“telemetry.”

The collection, redaction, sampling, and destination contracts remain owned by
[`telemetry.md`](telemetry.md) and
[`cloudflare-logging-and-tracing.md`](cloudflare-logging-and-tracing.md); use
their current rules when this summary and an owning document differ.

- Begin with aggregate and promoted content-free fields. Retrieve event
  properties, trace attributes, or raw model records only when the narrower
  evidence cannot answer the question.

- Keep query responses in an ignored temporary directory. Do not print raw
  inference, trace binding values, identifiers, prompts, messages, connector
  content, or crash material into terminal transcripts, tickets, commits, PRs,
  or agent responses.

- Use responder credentials for read paths, not deployment credentials. Keep
  tokens out of Worker/client variables and command output.

- Prefer platform-owned correlation identifiers over copying product names or
  content into new logs. New diagnostics should use fixed enums, booleans,
  counts, and durations where those answer the question.

- Remember that Cloudflare automatic traces sit below Rally's redaction layer.
  Review destination and regional attachment before assuming exported spans are
  content-free.

## Reporting a finding

A durable investigation note is compact but reproducible. Include:

- the claim and exact UTC window;
- region, service/class, invocation type, and active deployment version;
- numerator, matching denominator, and rate;
- the source of each fact—Cloudflare analytics, invocation log, Rally event,
  product telemetry, lakehouse row, or authoritative state;
- correlation identifiers retained privately, without customer content;
- false-positive and false-negative explanations checked;
- confidence language and the next observation that would change the result.

Use precise verbs:

- **Proves:** the evidence directly establishes the fact at the named boundary.
- **Supports:** multiple observations fit the explanation, but another cause
  remains possible.
- **Inconsistent with:** the expected evidence for a hypothesis is present in a
  contradictory form.
- **Unknown:** the required surface is absent, expired, regionally unavailable,
  or never instrumented.

“Transient network error” is a conclusion only when the evidence rules out the
application and deployment explanations available to us. Otherwise say that
the observed disconnect is *consistent with* a transient network event and name
what remains unobserved.

## Maintenance and related documents

This handbook owns the investigation method and evidence boundaries. Keep exact
commands and operator credentials in the runbook, platform field/limit claims
in the Cloudflare reference, and subsystem-specific diagnostics with their
owning module. Useful companions are:

- [`runbook.md`](runbook.md) for production access and exact query procedures;
- [`cloudflare-logging-and-tracing.md`](cloudflare-logging-and-tracing.md) for
  current Workers observability behaviour and privacy caveats;
- [`telemetry.md`](telemetry.md) for product-event admission, PostHog delivery,
  sampling, identity, and regional rules;
- [`analytics-lakehouse.md`](analytics-lakehouse.md) and
  [`inference-lakehouse.md`](inference-lakehouse.md) for the two Global
  analytical projections;
- [`durable-object-alarms.md`](durable-object-alarms.md) for alarm phase
  instrumentation and runtime-cancellation interpretation;
- [`performance-tracing.md`](performance-tracing.md) for Rally's custom spans
  and cross-boundary correlation attributes;
- [`ops-alerting.md`](ops-alerting.md) for the small set of failures that become
  proactive operator notifications.

When a future incident teaches a reusable ambiguity—especially a new false
positive or a blind spot—add the principle here and keep the incident-specific
numbers with the incident or owning module. The handbook should grow by
clarifying judgement, not by accumulating a mandatory sequence for every
failure.
