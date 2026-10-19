# Inference lakehouse

The inference lakehouse records every Global streaming and structured model
request and terminal attempt as an analytical event. It keeps the exact JSON
record in Global's payload bucket and delivers a typed projection through a
Global Cloudflare Queue and Pipeline into an Apache Iceberg table in R2 Data
Catalog.

This is an operational data system containing prompts, conversations, tool
schemas and calls, model output, identifiers, and provider errors. It is not
product authority, and a capture failure does not change the inference outcome.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/agent-harness/src/index.ts`, `bind-runtime.ts` | Emit one exact request event and one terminal attempt event for each structured or streaming provider call. |
| `apps/api/src/queues/inference-lakehouse-consumer.ts` | Validate the pointer and archived bytes, enforce the regional boundary, fit the row to Pipeline's request limit, and send it through `INFERENCE_LAKEHOUSE`. |
| `config/inference-lakehouse.json` | Source of truth for the Global bucket, stream, pinned stream ID, sink, pipeline, namespace, table, and binding name. |
| `config/inference-lakehouse-stream-schema.json` | Immutable structured-stream schema and analytical column contract. |
| `scripts/ensure-cloudflare-inference-lakehouse.mjs` | Locally materializes pinned bindings for application deploys; explicit modes check or reconcile every Global lakehouse (inference, analytics events and usage). |
| `.github/workflows/deploy-api.yml` | Materializes pinned Wrangler configs locally and deploys them without a Pipelines management-plane preflight. |

### Capture and archive

The harness assigns one `inference_request_id` to a provider call. It emits a
`request` event before the call and an `attempt` event when that call succeeds or
fails. Streaming requests carry the exact provider body: a Responses body
(`input` items, flat `tools`) for OpenRouter, a Chat Completions body
(`messages`) for Azure. The request row's `metadata.api` says which
(`responses` or `chat_completions`), and `metadata.messageCount` counts `input`
items for a Responses body, where a tool call and its output are each an item,
so it is not comparable across the two. Streaming attempts
carry the complete normalized content, tool calls, usage, finish reason, and
generation ID, including OpenRouter's opt-in routing metadata when returned.
Structured calls carry the exact request body and the provider's
complete successful JSON response envelope. Failed calls retain the provider
classification (`code` and provider name) and `detail`, the refusal body as the
provider sent it. The body is kept because a classification routinely cannot say
what was refused; it may echo the rejected request back, which is accepted here
for the same reason the request itself is archived.

The API turns each event into schema version 1. Core dimensions are columns:
region, environment, build, source, invocation type, workspace/Broadcast-user/
context-user/work-stream/substream and host request IDs, inference/turn/schema IDs,
provider/routed/provider model, success/disposition/failure, latency/TTFT, token
classes, cost, and response bytes. The full request, response, error, routing
cursor, retry/repair positions, validation issues, and counts remain JSON
columns. The `request` and `attempt` rows join on `inference_request_id`;
`event_id` adds the event type and is the stable deduplication key.
For user-started work-stream creation, substream creation, and ordinary message
sends, the request row's `metadata` also carries `operationId`, `journey`,
`requestReceivedAt`, `providerRequestIssuedAt`, and
`requestToInferenceStartMs`. Keeping the additive boundary fields in the
existing JSON column avoids an immutable Pipeline stream replacement. The
attempt row's `ttft_ms` is the independent provider-dispatch-to-first-token
clock; both rows join on `inference_request_id`.

For PostHog destinations, OpenRouter maps `user` to `distinct_id`, `session_id`
to `$ai_session_id`, `trace_id` to `$ai_trace_id`, and `generation_name` to
`$ai_span_name`. Rally sets both `user` and trace `user_id` to `workspace_id`;
a relevant person remains separate as `context_user_id`. Rally also sends
`feature` as the authoritative Flagship model
category/key, keeps the execution surface in `source`, and sends `product`,
invocation type, deployment, ownership, model, and route fields. `intended_model`
retains Rally's primary model before traversal while `model` records the current
candidate, so their mismatch (or a nonzero `route_stage_index`) identifies
application-level fallback. OpenRouter forwards those custom keys as
`metadata_*` event properties.

OpenRouter's current embeddings request schema is narrower than chat: it
accepts `user` but not the custom Broadcast `trace` object. Search embeddings
therefore send `user = workspace_id` and the work-stream session as
`X-Session-ID`; inference with no work-stream identity omits the session
rather than substituting an unrelated request ID.
Rally emits a content-free regional `embedding_inference` diagnostic containing
the same feature, trace/session identity, intended/requested/resolved model,
fallback attempt, outcome, and latency. Embedding inputs and vectors are not
copied into that log or the inference lakehouse. This is a documented provider
contract gap, not a synthetic trace field sent to an endpoint that would ignore
it.

`substream_id` is the canonical product substream inside a work stream. Rally
currently runs the main substream, so work-stream-linked inference that has no
more specific identity is recorded as `"0"`; inference unrelated to a work
stream leaves the column null. A root run and any inline children inherit the
same product substream. Inline-child execution is a run-lineage distinction,
not a new product substream, and remains queryable through `request_id` and
`parent_request_id`. When additional product substreams are exposed, their
canonical IDs flow through the existing workflow input instead of collapsing
all rows under `workstream_id`.

### Queue and Pipeline delivery

`avalon-global-inference-lakehouse` is consumed only by the Global Worker. The
consumer rejects a pointer for another region, loads Global's `PAYLOADS` binding, verifies
the exact byte count and SHA-256, parses the schema again, and sends a one-row
array through the Global `INFERENCE_LAKEHOUSE` Pipeline binding.

Pipeline ingestion requests have a 5,000,000-byte ceiling. When the array-wrapped
record would exceed it, the consumer removes only the full `request` and
`response` JSON from the analytical row and adds `payload_object_key`,
`payload_sha256`, and `payload_bytes`. Every queryable dimension, failure, usage,
and metadata field still lands in the analytical projection, while the exact
record stays at the verified Global R2 pointer. Records below the ceiling also
remain in R2; the archive is the lossless source and makes redelivery independent of a prior Queue
acknowledgement.

The Pipeline is a direct `INSERT INTO <sink> SELECT * FROM <stream>`. Its sink
writes zstd-compressed Parquet with a 300-second rolling interval to Data Catalog
namespace `avalon`, table `llm_inference`; Cloudflare creates the namespace and
table when the first records arrive.

### Deployment bindings and explicit reconciliation

The API deployment keeps application delivery independent from the Pipelines
management API:

Normal merges do not list, create, or verify Pipelines resources. The streams,
sinks, and pipelines are immutable infrastructure, and a transient outage in
their management plane must not prevent an unrelated Worker release. A missing
or malformed pin fails local manifest validation, as does reusing one stream ID
for both bindings. Cloudflare may still accept a syntactically valid ID whose
stream no longer exists; regional health proves that the Worker exposes each
binding, not that its remote stream accepts rows. That is why creation and
replacement require explicit reconciliation, while failed ingestion remains
visible through Queue retries and the dead-letter queues.

Infrastructure work uses an explicit mode. `--check` reads every resource and
fails on absence or drift without mutation. `--reconcile` may create missing
buckets, catalogs, streams, sinks, and pipelines, then applies the same schema,
destination, SQL, credential, duplicate-name, and pinned-stream-ID assertions.
Run one of those modes before changing a lakehouse manifest, stream schema, sink
credential, or pinned ID; they are not application-deploy steps. If one or more
named streams are absent, reconciliation creates every missing stream, verifies
its immutable shape, collects all generated IDs that differ from the manifests,
and then fails before creating downstream resources for those streams. Review
the complete set, update the pins together, and run reconciliation again to
create or verify the downstream resources. Each named stream is reused on the
second pass; none is silently replaced or left as an unrelated orphan. `--check`
never creates a missing stream.

`config/inference-lakehouse.json` declares the deployment credential as
account-owned, so reconciliation uses the account token verifier directly and
does not guess ownership from an API failure. Read-only reconciliation calls get
up to ten total attempts for connection failures and HTTP 408, 409, 429, and 5xx
responses. They respect a returned `Retry-After` value and otherwise use the
official TypeScript client's jittered exponential backoff: a nominal 500
milliseconds, doubling to an 8-second ceiling before downward jitter. Mutating
requests are never retried, so a lost create response cannot duplicate an
immutable resource. The final failure includes Cloudflare's Ray ID when one was
returned. The existing account-owned deployment token must have
Workers R2 Storage Admin Read & Write, R2 Data Catalog, Pipelines, Queues, and
Worker deployment permissions. Its token value is installed in the Global Data
Catalog sink but is never logged or persisted in a generated Wrangler file.
Replacing that deployment token changes the desired credential-bound sink name,
so reconciliation fails before creating a conflicting sink. Rotating the
credential therefore remains an explicit immutable sink/pipeline migration.

- **The Queue carries a pointer, never the inference body.** Breaking this both
  exceeds the Queue message ceiling for valid multimodal calls and puts sensitive
  content into a second transport surface.

- **R2 is written before Queue acceptance.** Reversing the order creates a
  message whose consumer can never load its record. If Queue acceptance fails,
  the just-written object is deleted so an unreferenced capture does not appear
  complete.

- **The archived bytes are retained after delivery.** Deleting on apparent
  success makes an at-least-once redelivery ambiguous and loses the exact form of
  oversized rows; the hash-addressed archive is the recovery copy.

- **`event_id` is stable and every Queue delivery may repeat.** Queue and Pipeline
  are at-least-once. Queries that require logical event counts deduplicate on
  `event_id`; duplicate analytical rows are preferable to an inference outcome
  that disappears.

- **The stream schema changes only by a deliberate replacement design.** A
  structured Pipeline stream cannot be edited. Explicit reconciliation refuses
  drift, so a field cannot be removed or retyped under an existing table by
  accident.

- **Capture is best effort with respect to the model call.** A Queue, R2, or
  Pipeline outage must not turn a successful user inference into a failure. The
  structured failure log and DLQ are the operator-visible consequences.

## Boundary

The harness owns faithful request/attempt events. The lakehouse owns archival,
transport, analytical shape, and provisioning. Global's `PAYLOADS` bucket
remains a general object store; this module owns only the
`inference-lakehouse/records/` prefix. Global R2 Data Catalog owns Iceberg
commits, compaction, namespace/table creation, and query-engine interoperability.

The analytical projection is not the work-stream transcript, billing authority,
model-routing control, or the owning execution object's operational
`inference_attempts` ledger. Those systems may correlate with `request_id`, `workstream_id`,
`substream_id`, and `inference_request_id`, but none may use lakehouse arrival
as proof that a model call committed product state.

Usage quotas and overage read the separate D1 usage ledger, which the same call
sites feed through `emitInferenceUsage`, not this projection. The usage ledger
has its own lakehouse, `avalon.usage_events`, provisioned by the same script
from `config/usage-lakehouse.json`. See [usage metering](usage-metering.md).

## Failure modes and limits

- A capture archive or Queue-send failure emits `inference_lakehouse_stage_failed`
  and does not fail the inference. The object is removed when Queue acceptance
  itself fails. Exact provider request, terminal attempt, and structured
  diagnostic capture is registered with the owning runtime lifecycle. Worker
  invocations register it through `waitUntil`; Durable Objects already remain
  active while asynchronous I/O is pending, and their `waitUntil` compatibility
  method adds no lifetime. Hashing and the R2 / Queue hand-off therefore cannot
  delay provider dispatch, the next tool/model step, or run settlement. Capture
  remains best effort until that hand-off is accepted; it is not a durable retry
  fence.
- Invalid or cross-region pointers are poison: the consumer logs and acknowledges
  them so they cannot retry forever. Missing, corrupt, or schema-invalid archived
  bytes and Pipeline failures retry and eventually reach the Global DLQ.
- A Pipeline record above 5,000,000 bytes becomes a pointer-backed analytical row;
  its exact record remains in Global R2. Queue messages remain far below the
  Queue's 128 KB message limit because they contain no inference JSON.
- The consumer uses Cloudflare's defaults of 10 messages, a 5-second batch
  window, and three retries. There is no user-visible dependency that justifies
  a lower latency or a guessed custom retry number; the Global DLQ is the
  failure signal.
- The Global sink rolls files every 300 seconds. Data Catalog requires at least
  60 seconds to avoid compaction conflicts, and faster analytical visibility is
  not on the inference request path.
- No retention or lifecycle deletion is configured for the raw archive. That is
  intentional for maximal metadata, but it is also sensitive and billable; a
  future retention policy must be a product/security decision applied equally to
  the raw object and analytical projection, not an unreviewed storage optimization.

## Testing

`apps/api/test/inference-lakehouse.test.ts` proves exact archive/pointer/delivery,
hash verification, oversized fallback, and poison-message acknowledgement.
`apps/api/test/agent-inference-logging.test.ts`,
`structured-inference-deferral.test.ts`, and
`addressing-classifier-logging.test.ts` hold the real R2 stage open and prove it
does not block provider dispatch or results. `apps/api/test-workers/runtime-deferral.test.ts`
smoke-tests the shared primitive against real workerd.
`apps/api/test-workers/queue-dispatch.test.ts` proves the real Worker dispatches
the queue before product maintenance fencing. Harness tests prove exact request
and response events.

Run the focused suites with:

```text
pnpm --filter @rally/api exec vitest run test/inference-lakehouse.test.ts
pnpm --filter @rally/api test:workers -- queue-dispatch.test.ts
```

## Data model

`config/inference-lakehouse-stream-schema.json` is authoritative for the
analytical shape in the Global sink. It uses typed scalar columns for filters and
aggregates, JSON columns for lossless nested inference data, and three optional
payload-pointer columns for a record whose exact JSON cannot fit one Pipeline
ingestion request. Version 1 has two rows per successful provider call and normally two per failed call: the
request and terminal attempt. A failed attempt's `error` column holds one
`providerError` object: the classification (`code`, `providerName`) and
`detail`, the body the provider answered with. A refusal nothing could classify
— a gateway's HTML, a proxy's plain text — records `detail` alone, which is the
case where the body is the only account of the failure there is.

`cost_microusd` is what the provider billed, not an estimate Rally computed,
and it is **absent rather than zero** when the provider reported nothing —
`providerCostCents` in `@rally/agent-harness` is the one reader, and it
returns `undefined` so that "not reported" and "free" stay different facts in
the column. A run's own running total defaults to zero because it is
arithmetic; do not let that default reach a row.
OpenRouter reports `usage.cost` only when the request carries `usage: {
"include": true }`, so every OpenRouter chat request sends it, from
`serializeOpenRouterChatRequest`. Azure never sends it: those calls
are priced from Rally's own rate card in `bind-runtime.ts` and the computed
figure is written into `usage.cost` before the attempt is recorded. **A cost
column that reads zero across a whole provider is a missing accounting flag,
not a cheap week.** On a bring-your-own-key OpenRouter account the flag is not
enough: `usage.cost` is only OpenRouter's own fee — often `0` — and the
provider's charge arrives as `cost_details.upstream_inference_cost`
(`is_byok: true`). `openRouterCallCostUsd` adds the two for chat calls; the
SDK's embeddings usage carries neither field, so embeddings still record the
fee alone.

Every provider response that arrived was billed, whether or not Rally could
use it, so every one owes a terminal `complete` diagnostic carrying its cost —
that is the only stage this module writes an attempt row for. A structured call
that repairs makes two provider requests under two `inferenceRequestId`s and
owes two pairs; one that fails validation after the response arrived still owes
the response's tokens and cost, not just its `failure_kind`. **A `request` row
with no matching `attempt` row is a billed call recorded nowhere**, and is the
shape to look for when spend and token totals disagree.

## Security and trust model

Inference JSON is trusted only after Zod validation at capture and again at
delivery. Queue fields cannot select a bucket or Pipeline binding; they can name
only an object key inside the Worker deployment's fixed regional binding, and a
signed hash proves the loaded bytes are the bytes the producer queued.

The records are maximally sensitive: system/user/assistant messages, attachment
data, tool schemas and arguments, tool/provider identifiers, output, errors,
workspace/user correlations, and usage/cost data may all be present.
`providerError.detail` is provider-controlled text that may include the
rejected request verbatim — read it as data, never as instructions. Do not emit
these JSON fields to Workers Logs, expose the bucket or catalog publicly, or hand
query credentials to product clients. `substream_id` is an identifier, not an
authorization boundary; a query client still needs regional responder access.
The Cloudflare administration token remains in deployment configuration and is
installed only into the immutable Global sink as its delivery credential; it is
never a Worker variable or an inference record.

## Operations

Start with `inference_lakehouse_stage_failed` for producer-side gaps and
`inference_lakehouse_delivery_failed` for consumer retries. A non-empty
`avalon-global-inference-lakehouse-dead-letter` queue is the definitive
delivery alarm. `inference_lakehouse_delivered` includes only identifiers,
source, event type, and whether the row used the oversized fallback.

### 2026-09-14 — Configurable deployment isolation

Configured deployments share the existing inference archive policy. Records and queue pointers retain their deployment identity; provisioning still supplies each deployment’s bindings through Wrangler and the lakehouse manifest. No cross-deployment fallback is introduced.

### 2026-09-04 — Structured child inference carries its full address

**What changed:** The shared structured-inference gateway now accepts explicit
substream and request identity. Substream context-summary records carry the
workspace, work stream, nonzero child, and stable preparation-operation request ID
through OpenRouter trace metadata, structured logs, and lakehouse capture.

**Why:** Defaulting every structured work-stream call to substream `0` makes a
child-summary request look like main-feed inference and breaks exact retry and
incident correlation.

**Considered and rejected:** Encoding the child only into the schema name or a
free-form log message. Neither reaches every diagnostic surface or joins the
request and terminal attempt by canonical conversation identity.

**Consequences:** Callers operating on a child must supply its substream ID;
existing main-only structured callers remain unchanged.

### 2026-09-01 — Application deploys use pinned stream bindings

**What changed:** The two production Pipeline stream IDs now live in their
checked-in lakehouse manifests. Normal API deploys materialize the regional
Wrangler configs from those IDs without credentials or Cloudflare requests;
Pipelines creation and immutable drift verification moved behind explicit
`--check` and `--reconcile` modes.

**Why:** Removing redundant detail reads and raising GET retries did not restore
deployments. In the first post-change deployment, the inference pipeline list
recovered only on attempt seven and the analytics pipeline list returned HTTP
500 on all ten attempts, even though both live streams and the currently
deployed Worker bindings remained healthy. An application release had no reason
to depend on that failing infrastructure-management surface.

**Considered and rejected:** More retries or pagination, because live probes
showed neither changed the provider failure; silently ignoring a failed
reconciliation while still deriving bindings from it, because that could write
an incomplete config; and copying IDs from the previously deployed Worker on
every release, because the checked-in manifests are a deterministic authority
and already play that role for other generated Cloudflare resource IDs.

**Consequences:** Ordinary Worker releases make no Pipelines API call and cannot
be blocked by this control-plane incident. They no longer re-verify downstream
sink or SQL drift on every code change; infrastructure changes and deployment
credential rotation must run explicit reconciliation. Creating or recreating
streams is a two-pass migration: the first pass creates every missing stream and
reports the complete generated-ID set without creating their downstream
resources, and the second pass resumes after an operator commits the reviewed
pins together.

### 2026-09-01 — Pipeline list responses replace redundant detail reads, and the incident retry budget rises to ten attempts

**What changed:** Existing streams, sinks, and pipelines are now verified
directly from their list responses. The provisioner no longer repeats each
successful lookup through the resource's detail endpoint, removing six
Cloudflare Pipelines reads from a two-lakehouse deploy preflight.

The merge-time provisioner's GET retry budget increased from Cloudflare's
default three total attempts to ten. The existing provider-aligned status
rules, `Retry-After` handling, jittered backoff, final Ray ID, and
single-attempt POST behavior are unchanged.

**Why:** The list contracts include every stream, sink, and pipeline field used
by the immutable-resource assertions. During the Pipelines control-plane
incident, each unnecessary request was another independent opportunity for an
HTTP 500 and added no evidence to the drift check. Live probes during the same
incident showed a failure rate high enough that three attempts across a
multi-read preflight still made otherwise valid deployments unlikely to
complete. The operator explicitly selected ten attempts after the smaller
budget failed to restore reliable deploys.

**Considered and rejected:** Removing the list requests too, because they are
still required to discover Cloudflare-generated stream IDs, reject duplicate
names, find the deployment-credential-bound sink, and compare existing
resources with the checked-in manifests; and retaining the detail reads as a
second confirmation, because they query the same control plane without checking
any additional field. Retrying until success, which could hide a lasting
control-plane outage; and changing mutation semantics, because repeating a POST
after a lost response can create duplicate immutable resources.

**Consequences:** A healthy existing two-lakehouse deployment now needs six
Pipeline control-plane reads instead of twelve. A failed list read still retries
and ultimately fails closed, and immutable stream, sink, and SQL drift remains
deployment-blocking. Without a provider-directed `Retry-After`, nine waits add
at most 47.5 seconds per persistently failing GET before downward jitter. A
persistent fault still blocks deployment with a support-traceable final error.

### 2026-09-01 — Transient Cloudflare control-plane reads retry safely

**What changed:** The merge-time lakehouse provisioner now retries GET requests
for the same connection failures, HTTP 408 timeouts, HTTP 409 conflicts, rate
limits, and server errors as Cloudflare's official TypeScript client. It uses
that client's published default of two retries, honors `Retry-After`, mirrors
its short jittered exponential backoff, and includes the final `cf-ray` value in
an error. POST requests still execute exactly once.

**Why:** Three consecutive API deploys failed before migrations or Worker upload
while Cloudflare's Pipelines control plane intermittently returned HTTP 500.
Authenticated probes proved identical Pipeline and sink reads alternating
between 200 and 500 while the account, token, R2 buckets, Data Catalogs, Queues,
streams, and running Pipeline records remained healthy. The dashboard reproduced
the same v1 list failure and incorrectly rendered the legacy API's empty result
as a create-first Pipeline screen.

**Considered and rejected:** Lowering `per_page` from 100 to 20, because
interleaved production probes failed 13/20 and 14/20 times respectively;
retrying POST requests, which could duplicate a resource after a lost response;
skipping immutable-resource verification, which could deploy stale generated
bindings; and an unbounded custom retry policy. The selected count and backoff
come from Cloudflare's official client rather than a Rally-specific guess.

**Consequences:** A short transient control-plane fault no longer blocks an
otherwise valid deployment on its first response. A persistent fault still
fails closed after the provider-standard retry budget with a support-traceable
Ray ID, and resource creation retains its existing single-attempt semantics.

### 2026-08-27 — Provider traces and embedding calls join Rally's observable OpenRouter boundary

**What changed:** Exact request records now include OpenRouter Broadcast
identity and trace fields, and successful streaming attempt responses may
include returned router metadata. Provider `user` and trace `user_id` now use
the workspace ID consistently, with any relevant person in `context_user_id`.
`feature` records the exact Flagship model category/key while `source` records
the inference surface. The provider trace groups a full harness loop, not an
individual model turn; work-stream `session_id` values are
`<workstream_id>-<substream_id>`. `intended_model` records the primary Rally
route while `model` records the attempted candidate, so fallback requests
remain explicit in provider-side analytics. Structured fallback and repair
attempts retain one call-scoped trace ID, while each provider request keeps its
own `inference_request_id`.

Durable-memory embeddings now travel through OpenRouter and carry workspace
`user` plus `X-Session-ID`. Content-free regional diagnostics record the
feature key, trace/session IDs, intended/requested/resolved model, fallback
attempt, outcome, and latency without retaining memory text or vectors. The
query session uses the active substream rather than collapsing every
conversation into main substream `"0"`.

**Why:** Operators need to join OpenRouter's routing, timing, and pipeline view
to Rally's workspace, work stream, substream, relevant person, request,
deployment, and turn evidence without reconstructing that ownership from
prompt content. A workspace-stable identity also keeps system-initiated and
person-initiated inference for one tenant together. The previous Workers AI
embedding call was invisible to that routing and provider-observability path,
including when a configured fallback differed from the intended model.

### 2026-08-24 — Account-owned deployment tokens use their owning verifier

**Why:** Production uses an account-owned R2 API token. The user-token verifier
can accept that bearer credential without being the authoritative owner lookup;
using its returned identity produced an invalid R2 access key and made Pipeline
sink creation fail with `422 / 1012: invalid account id` even after the required
bucket-item permission was present.

**Consequences:** First-merge provisioning remains non-interactive, account and
user deployment tokens both retain explicit coverage, verifier failures cannot
silently switch credential identity, and rotating the existing credential still
triggers the immutable sink identity guard.

### 2026-08-24 — Sink creation leaves account ownership to the API path

**What changed:** Sink-create payloads no longer repeat the Cloudflare account ID
inside `config`. The account-scoped API path remains authoritative. Existing
sink reads accept Cloudflare's public config with that field either present or
redacted, but still reject a different returned account ID.

**Considered and rejected:** Retrying the same documented body or weakening all
account checks. The live API had already disproved the former, while the latter
would discard useful drift evidence when Cloudflare does return its public
account field.

**Consequences:** Merge provisioning now matches Cloudflare's own client input
shape for both direct-R2 and Data Catalog sinks. Bucket ownership is still fixed
by the account-scoped endpoint, and a contradictory read-back fails closed.

### 2026-08-24 — Every model call gains a lossless regional lakehouse trail, replacing the D1 ledger, with substream identity and a safe retrieval path

**What changed:** Streaming and structured inference now emit exact request and
terminal attempt records. Each region archives the record in R2, queues a hashed
pointer, and delivers a typed row through its own Pipeline to its own R2 Data
Catalog Iceberg table. The main-branch deployment creates and verifies every
queue, bucket, catalog, stream, sink, pipeline, table path, and generated Worker
binding without an operator step.

Migration 0094 and the same Worker release remove the old workspace-opt-in D1
index, preference, API/UI contract, and request-only `agent-inference/` writer.
The lakehouse is now the sole hosted raw-inference capture path. Existing
legacy R2 objects are left intact rather than erased by an infrastructure
deployment.

Schema version 1 includes optional typed column `substream_id`. Work-stream
inference defaults to the canonical main substream `"0"`; streaming root and
inline-child calls propagate the workflow's actual substream ID, while
inference outside a work stream leaves the field null. The production query
recipe filters and displays the dimension.

The production runbook turns a work-stream URL into the correct regional R2 SQL
API request, a bounded identifier query, the matching request/attempt pair, and
an R2 Object API retrieval of the exact regional archive. It also covers
at-least-once duplicates, five-minute sink visibility, delivery failures,
separately scoped responder credentials, and scratch-file handling;
`AGENTS.md` points agents to that procedure.

**Why:** The opt-in D1/R2 inference ledger was built for individual debugging,
not complete analytical coverage, and a Queue message cannot carry the largest
valid multimodal request. Staging the exact bytes in the existing regional
payload store keeps the queue small, makes integrity checkable, and lets the
Iceberg table retain broad query columns without truncating source evidence.
Parallel diagnostic stores made completeness depend on an old workspace switch
and duplicated sensitive request bodies without retaining the matching terminal
provider envelope.

`workstream_id` alone is unambiguous only while every run belongs to the main
substream. Once one work stream contains multiple real product substreams, it
cannot identify which conversation produced a request.

Naming the table and correlation keys was not enough for an incident responder
to retrieve evidence safely. The missing steps encouraged broad scans,
cross-region guessing, deployment-token reuse, or a return to the retired D1
ledger.

**Considered and rejected:** Sending the full record directly through Queue,
which fails above 128 KB; sending directly from the inference path to Pipeline,
which couples user success to the analytical sink and still fails above 5 MB;
and dropping or truncating prompt/response fields, which contradicts the
requirement to keep maximal metadata and makes the pathological calls the least
diagnosable ones.

Retaining the D1 index as a lookup cache. It would keep a second analytical
schema and deletion lifecycle in the product database for fields the Iceberg
table already indexes.

Treating each inline child as a substream. Inline children are execution
lineage within the same product conversation, already represented by
`request_id` and `parent_request_id`; assigning synthetic substreams would
conflate two different boundaries and make future product substreams harder to
query correctly.

A custom query proxy in the product API. Production debugging does not justify
a new raw-content endpoint or another authorization surface while Cloudflare
already provides authenticated R2 SQL and R2 Object APIs.

**Consequences:** Inference storage is intentionally duplicated between raw R2
and Iceberg, delivery is at-least-once and must be deduplicated by `event_id`
for exact counts, raw records have no automatic retention yet, and the
deployment token needs R2 Data Catalog and Pipelines permissions in addition to
the existing Worker/Queue permissions.

New inference analytics do not write D1. The operational `inference_attempts`
rows remain object-local because run recovery depends on them, and a separate
explicit decision is required before deleting historical legacy R2 objects.

Current rows linked to work streams are explicitly queryable as substream
`"0"`, future substreams remain distinct without a second storage path, and
incident responders must include `substream_id` when narrowing a work-stream
query. The field was added before the first deployment of this new immutable
stream schema, so no stream replacement is needed.

Responders use the R2 SQL and R2 Object HTTP APIs, query only the owning region
and incident window, and move raw JSON to a temporary local file only when the
typed row is insufficient. The lakehouse remains analytical evidence and never
becomes product-state repair authority.


## Changelog

### 2026-10-09 — A streaming request row carries one of two body shapes

**What changed:** A streaming request row's `request` is a Responses body for
OpenRouter and a Chat Completions body for Azure, and `metadata.api` says which.
For a Responses body, `metadata.messageCount` counts `input` items.

**Why:** OpenRouter agent turns moved to the Responses API; the archived body is
the body sent, so its shape changed with it. The reasoning is in
[`agent-harness.md`](agent-harness.md#changelog), 2026-10-09.

**Considered and rejected:** Translating the Responses body back into a Chat
body for the archive. It would archive a request nobody sent.

**Consequences:** `messageCount` is not comparable across `api` values: a tool
round trip is one assistant message plus one tool message in Chat, and a
`function_call` plus a `function_call_output` item in Responses. A query over
request bodies reads `request.input` or `request.messages` by `metadata.api`.

Shipped in #1182.

### 2026-10-01 — Count the provider's charge on a bring-your-own-key account

**What changed:** Chat usage on OpenRouter records `usage.cost` plus
`cost_details.upstream_inference_cost` (`openRouterCallCostUsd`).

**Why:** Every model call made with a bring-your-own-key OpenRouter key
recorded a cost of 0: OpenRouter reports its own fee, which is zero, in
`usage.cost`, and the provider's charge in `upstream_inference_cost`, which the
usage record dropped. Local development runs on such a key, so the column read
zero for every model — the failure the paragraph above warns about, reached
from a different direction.

**Considered and rejected:** Reading `upstream_inference_cost` alone, which a
key that is not bring-your-own also reports and would count twice.

**Consequences:** Embeddings still record OpenRouter's fee alone, because the
SDK's embeddings usage carries neither field; a bring-your-own-key account
under-reports them.

Shipped in #1058.

### 2026-09-19 — Ask OpenRouter what a call cost, and record it for structured calls too

**What changed:** Every OpenRouter chat request now carries `usage: { include:
true }`, added in `serializeOpenRouterChatRequest` so both the streamed turn
and the structured call get it, and mirrored into the recorded request payload
in `bind-runtime.ts` for OpenRouter candidates only. `StructuredModelDiagnostic`
gains `costCents`, read from the response usage the same way the token counts
already were, and `captureStructuredInferenceDiagnostic` maps it to
`cost_microusd`. A response that triggers repair, and one whose validation
fails after it arrived, now emit a terminal diagnostic carrying those metrics
as well.

**Why:** `cost_microusd` was `0` on every OpenRouter row, which is most of
Rally's spend, so the lakehouse could report load in tokens and not in money.
Two independent causes. The request never opted into usage accounting, so
`usage.cost` was absent and `costCents()` in `bind-runtime.ts` returned its `0`
default — a structurally valid number that no schema, log, or query could tell
from a genuinely free call. And structured calls carried no cost field at all
from the harness onward, so every classifier, extraction, summary, and repair
call was invisible to spend reporting however the request was formed. The
Azure path was correct throughout and hid the gap: it computes cost from the
rate card and writes it into `usage.cost` itself, so the column worked for the
one provider that never asks the provider.

**Considered and rejected:** Pricing OpenRouter calls from the endpoint-average
KV the pricing Worker already maintains. It is the right input for *choosing* a
route and the wrong one for billing a call: the average is hourly and the
provider a route actually landed on is decided per request, so the number would
disagree with the invoice and there would be no way to tell which was wrong.
Asking OpenRouter costs one request field.

**Also:** the streamed path read cost through a second implementation whose
default was `0`, so an attempt the provider did not price wrote a structural
zero next to real measurements — the same ambiguity, on the column this change
exists to make trustworthy. The two readers are now one.

**Consequences:** `cost_microusd` becomes comparable across providers and
across streamed and structured calls, and any series spanning this change has
a floor of zero before it that is an artifact, not a cost. A repaired
structured call now writes two request/attempt pairs where it wrote one pair
and one orphaned request, so structured attempt counts rise without the
underlying call volume changing. A future provider adapter owes the same
field: a `0` here is now a defect to fix rather than a value to read.

### 2026-09-17 — Measure inference start without making observation part of it

Streaming request rows now record the user journey's receipt and provider
first-dispatch boundaries in `metadata`, while the regional logger emits the
same content-free duration only for the first durable attempt. Later provider
requests and recovered attempts omit the SLO duration. Streaming requests and
attempts, standalone structured
requests and responses, addressing diagnostics, and tool/run analytics register
their observation through the shared Cloudflare lifecycle deferral instead of
awaiting R2 and Queue staging on a product critical path. A production addressing
trace showed archive staging consuming about 1.8 seconds before a roughly
400-millisecond JEV call, which made observational persistence the dominant
controlled latency. The operational log and durable inference ledger remain
synchronous where they are authoritative. Dropping exact archives was rejected
because they are the evidence used for evals and incident diagnosis; bare
floating promises were rejected because Workers may end an invocation after its
response. The shared deferral guards synchronous registration failure and
observes promise rejection; it does not promise completion across deployment or
runtime reset. Future inference callers must use that primitive rather than
recreating either failure mode. The existing JSON column was used instead of
changing the immutable Pipeline schema; `ttft_ms` remains the provider-side half
of the latency.

### 2026-09-14 — Fence retired meeting data before erasure

The meeting-note retirement consumer recognizes the historical `meeting_notes` source, writes a content-free tombstone, and erases its raw payload before acknowledging a replay. It repeats deletion when the tombstone already exists so interruption between receipt and erasure cannot preserve the bytes. This fence prevents queued retired feature records from restoring catalog copies; ordinary inference remains unchanged. Catalog snapshots and provider-held copies require separate verification. See [meeting retirement](meeting-notes.md).
