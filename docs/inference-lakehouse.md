# Inference lakehouse

The inference lakehouse records every Global streaming and structured model
request and terminal attempt as an analytical event. It keeps the exact JSON
record in Global's payload bucket and delivers a typed projection through a
Global Cloudflare Queue and Pipeline into an Apache Iceberg table in R2 Data
Catalog.

EU inference analytics are intentionally deferred. The EU Worker has no
inference Queue producer, consumer, or Pipeline binding and returns before raw
archive staging, so EU prompts and responses are not written to analytical R2.
This avoids exporting EU workspace content to Global while Cloudflare Data
Catalog [does not support non-default jurisdictions](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/#jurisdiction-restrictions).

This is an operational data system containing prompts, conversations, tool
schemas and calls, model output, identifiers, and provider errors. It is not
product authority, and a capture failure does not change the inference outcome.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/agent-harness/src/index.ts`, `bind-runtime.ts` | Emit one exact request event and one terminal attempt event for each structured or streaming provider call. |
| `apps/api/src/services/inference-lakehouse.ts` | Build the common record, explicitly skip EU, archive Global in `PAYLOADS`, hash it, and enqueue the pointer without failing the inference. |
| `apps/api/src/queues/inference-lakehouse-consumer.ts` | Validate the pointer and archived bytes, enforce the regional boundary, fit the row to Pipeline's request limit, and send it through `INFERENCE_LAKEHOUSE`. |
| `config/inference-lakehouse.json` | Source of truth for the Global bucket, stream, pinned stream ID, sink, pipeline, namespace, table, and binding name. |
| `config/inference-lakehouse-stream-schema.json` | Immutable structured-stream schema and analytical column contract. |
| `scripts/ensure-cloudflare-inference-lakehouse.mjs` | Locally materializes pinned bindings for application deploys; explicit modes check or reconcile both Global lakehouses. |
| `apps/api/wrangler.global.jsonc`, `wrangler.eu.jsonc` | Global declares the inference Queue producer/consumer; EU contains the explicit deferral comment and no inference transport. |
| `.github/workflows/deploy-api.yml` | Materializes pinned Wrangler configs locally and deploys them without a Pipelines management-plane preflight. |

## How it works

### Capture and archive

The harness assigns one `inference_request_id` to a provider call. It emits a
`request` event before the call and an `attempt` event when that call succeeds or
fails. Streaming requests carry the exact OpenRouter body; streaming attempts
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

The exact outbound body includes the same provider-side correlation Rally gives
OpenRouter Broadcast: `user`, `session_id`, and `trace`. One agent loop retains
one `trace_id` across all model turns. Each turn has its own `span_name`, with
the OpenRouter call represented as the generation inside that span;
`turn_id`, `inference_request_id`, and the route cursor separate retries and
generations within it. Work-stream sessions use
`<workstream_id>-<substream_id>`. This duplication is deliberate: Broadcast
supports provider-side observability when it is enabled in the OpenRouter
account, while the Global lakehouse remains Rally's lossless regional evidence
and EU continues to skip analytical capture.

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
accepts `user` but not the custom Broadcast `trace` object. Durable-memory
embeddings therefore send `user = workspace_id` and the work-stream session as
`X-Session-ID`. Work-stream-scoped document indexing recovers that session from
the memory scope; inference with no work-stream identity omits the session
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

In Global, before enqueueing, the Worker serializes and validates the complete record,
computes its byte length and SHA-256, and writes it to
`inference-lakehouse/records/<date>/<event-id>.json` in the regional `PAYLOADS`
bucket. EU returns before this step. The Global Queue message contains only schema version, region, event ID, object
key, hash, byte count, and capture time. This extra R2 hand-off is intentional:
Queue messages cannot hold a large multimodal inference record, while an opaque
pointer is small, region-safe, and independently verifiable.

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

1. `ensure-cloudflare-queues.mjs` creates the Global inference queue; its
   Wrangler consumer declaration causes the Global dead-letter queue to be
   created on first deployment. EU declares neither.
2. Both lakehouse manifests record the existing production stream's generated
   ID. `ensure-cloudflare-inference-lakehouse.mjs --materialize-bindings` reads
   those manifests and writes ignored `.wrangler.lakehouses.<region>.json`
   configs without credentials or network access. Global receives both
   analytical bindings; EU receives neither.
3. The workflow deploys EU without analytical bindings and then Global with the
   pinned Queue and Pipeline bindings. Health requires them only in Global; EU
   reports the export as intentionally disabled.

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

## Invariants

- **Raw inference never crosses the regional boundary.** The archived object,
  queue, consumer, stream, sink, and analytical bucket are all regional;
  sharing any one of them would make a regional name cosmetic and expose EU
  prompt or output content to Global infrastructure.
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

## Failure modes and limits

- A capture archive or Queue-send failure emits `inference_lakehouse_stage_failed`
  and does not fail the inference. The object is removed when Queue acceptance
  itself fails. The harness does await the Global archive and Queue acceptance,
  so their latency is added before or after the provider call; Pipeline and sink
  work is fully off the inference path.
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
`apps/api/test-workers/queue-dispatch.test.ts` proves the real Worker dispatches
the queue before product maintenance fencing. Harness tests prove exact request
and response events. `scripts/ensure-cloudflare-inference-lakehouse.test.mjs`
uses a stateful Cloudflare API double to prove the two-pass empty-account
bootstrap, idempotent reconciliation, pinned-ID drift fences, zero-network
binding materialization, check-mode non-mutation, immutable drift checks, and
workflow ordering. `ensure-cloudflare-queues.test.mjs` pins each producer,
consumer, and DLQ name.

Run the focused suites with:

```text
pnpm --filter @rally/api exec vitest run test/inference-lakehouse.test.ts
pnpm --filter @rally/api test:workers -- queue-dispatch.test.ts
node --test scripts/ensure-cloudflare-inference-lakehouse.test.mjs
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

## Regional impact

Global uses `avalon-global-inference-lakehouse`, default R2 jurisdiction, and a
Data Catalog sink. EU inference is served normally but produces no lakehouse
archive, Queue message, Pipeline row, or cross-region fallback. The already
created empty EU lakehouse bucket and stream are not product bindings and may be
removed in a separately reviewed infrastructure cleanup.

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

`pnpm cloudflare:resources:check` verifies the Global lakehouse and
all other declared hosted resources without creating anything. Run
`pnpm cloudflare:lakehouses:ensure` only for explicit infrastructure
reconciliation; ordinary deploys invoke `--materialize-bindings` themselves and
need no operator step. Query Global's `rally.llm_inference` Iceberg table by
`event_id`, `inference_request_id`, workspace/work-stream/substream/request IDs,
model, source, time, success/failure, or usage. Follow `payload_object_key` into
the Global payload bucket when the exact JSON is needed. There is no EU query
procedure because EU inference is not captured.

For production debugging, follow the API-first, region-selection, bounded query,
inference-pair interpretation, raw-object verification, and missing-row
procedure in [`runbook.md`](runbook.md#inspecting-a-runs-raw-inference). Do not
improvise a D1 query or use the provisioning credential as a general-purpose
reader. Cloudflare's R2 SQL surface is beta; its invocation syntax may move. The
runbook links the current upstream query guide while keeping Rally's table,
bucket, event, privacy, and authority rules local and stable. If the workspace
is EU, stop: absence is expected and the lakehouse cannot diagnose that run.

## Performance and cost

Each Global provider call normally creates two payload objects, two Queue
messages, and two Pipeline/Parquet records. EU creates none. The Queue isolates these analytical writes
from Pipeline and sink latency; the producer still waits for Global R2 archive
and Queue acceptance. Pipeline ingestion is free; transformation and sink writes
are usage-priced, and R2 stores both the raw archive and analytical Parquet files.
This duplication is the explicit price of keeping exact large records
while retaining queryable columns. Revisit it only with real storage cost or a
decided retention policy, not a speculative cache or aggregation layer.

## Changelog

### 2026-09-03 — A failed attempt archives what the provider actually said

**What changed:** nothing in this module, which is the point. The harness's
`providerError` gained a `detail` field carrying the provider's rejection body,
and because the `error` column persists that object rather than a hand-picked
projection of it, the body arrives here on its own. The projection helper that
used to copy `code` and `providerName` out field by field is deleted. `error` is
one of the lossless JSON columns, so there is no stream-schema change and no
replacement design.

**Why:** the archive was the surface most likely to answer "which tool schema
did the provider reject", and on 2 September it could not, because the sentence
naming the tool was dropped at the transport before any consumer saw it. The
same change puts the body in Workers Logs as `provider_error_detail`, so this
archive is no longer the only place to look for it — which also means an EU
rejection, archived nowhere, is now diagnosable from its log row.
[`agent-harness.md`](agent-harness.md) holds the reasoning and the alternatives
rejected.

Shipped in #541.

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

### 2026-09-01 — Pipeline list responses replace redundant detail reads

**What changed:** Existing streams, sinks, and pipelines are now verified
directly from their list responses. The provisioner no longer repeats each
successful lookup through the resource's detail endpoint, removing six
Cloudflare Pipelines reads from a two-lakehouse deploy preflight.

**Why:** The list contracts include every stream, sink, and pipeline field used
by the immutable-resource assertions. During the Pipelines control-plane
incident, each unnecessary request was another independent opportunity for an
HTTP 500 and added no evidence to the drift check.

**Considered and rejected:** Removing the list requests too, because they are
still required to discover Cloudflare-generated stream IDs, reject duplicate
names, find the deployment-credential-bound sink, and compare existing
resources with the checked-in manifests; and retaining the detail reads as a
second confirmation, because they query the same control plane without checking
any additional field.

**Consequences:** A healthy existing two-lakehouse deployment now needs six
Pipeline control-plane reads instead of twelve. A failed list read still retries
and ultimately fails closed, and immutable stream, sink, and SQL drift remains
deployment-blocking.

### 2026-09-01 — The incident retry budget rises to ten attempts

**What changed:** The merge-time provisioner's GET retry budget increased from
Cloudflare's default three total attempts to ten. The existing provider-aligned
status rules, `Retry-After` handling, jittered backoff, final Ray ID, and
single-attempt POST behavior are unchanged.

**Why:** Live probes during the Pipelines incident showed a failure rate high
enough that three attempts across a multi-read preflight still made otherwise
valid deployments unlikely to complete. The operator explicitly selected ten
attempts after the smaller budget failed to restore reliable deploys.

**Considered and rejected:** Retrying until success, which could hide a lasting
control-plane outage; and changing mutation semantics, because repeating a POST
after a lost response can create duplicate immutable resources.

**Consequences:** Without a provider-directed `Retry-After`, nine waits add at
most 47.5 seconds per persistently failing GET before downward jitter. A
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

### 2026-08-27 — Embedding calls join the observable OpenRouter boundary

**What changed:** Durable-memory embeddings now travel through OpenRouter and
carry workspace `user` plus `X-Session-ID`. Content-free regional diagnostics
record the feature key, trace/session IDs, intended/requested/resolved model,
fallback attempt, outcome, and latency without retaining memory text or vectors.
The query session uses the active substream rather than collapsing every
conversation into main substream `"0"`.

**Why:** The previous Workers AI call was invisible to the OpenRouter routing
and provider-observability path, including when a configured fallback differed
from the intended model.

**Considered and rejected:** Adding chat-only `trace` fields to the embeddings
body and archiving embedding inputs in the Global inference lakehouse. The
current SDK schema rejects the former, while the latter would widen retained
user content without being necessary to diagnose routing.

**Consequences:** OpenRouter/PostHog receive workspace and session correlation
for embeddings but not custom trace metadata until the embeddings API supports
it. Rally's regional logs retain the missing content-free routing dimensions;
the exact embedding content remains deliberately absent. The fixed requested
model defines the Vectorize namespace, and a differing provider-reported model
fails closed to FTS instead of silently querying another semantic space.

### 2026-08-27 — Provider traces join Rally's exact inference evidence

**What changed:** Exact request records now include OpenRouter Broadcast
identity and trace fields, and successful streaming attempt responses may
include returned router metadata. Provider `user` and trace `user_id` now use
the workspace ID consistently, with any relevant person in `context_user_id`.
`feature` records the exact Flagship model
category/key while `source` records the inference surface. The provider trace
groups a full harness loop, not an individual model turn; work-stream
`session_id` values are `<workstream_id>-<substream_id>`. `intended_model`
records the primary Rally route while `model` records the attempted candidate,
so fallback requests remain explicit in provider-side analytics. Structured
fallback and repair attempts retain one call-scoped trace ID, while each
provider request keeps its own `inference_request_id`.

**Why:** Operators need to join OpenRouter's routing, timing, and pipeline view
to Rally's workspace, work stream, substream, relevant person, request,
deployment, and turn evidence without reconstructing that ownership from
prompt content. A workspace-stable identity also keeps system-initiated and
person-initiated inference for one tenant together.

**Considered and rejected:** Replacing the lakehouse with Broadcast, exporting
EU inference into Global observability, and making each turn a separate trace.
Those lose exact Rally-owned evidence, violate the existing residency boundary,
or hide the topology of a tool-using loop.

**Consequences:** Broadcast remains separately enabled and governed in the
OpenRouter account. The Global lakehouse records `user_id = workspace_id` and
keeps the relevant person in `context_user_id`; it archives provider error
classifications without provider-controlled prose. EU still performs the
provider request but creates no Rally analytical archive.

### 2026-08-24 — EU inference analytics are deferred

**What changed:** The manifest, Worker bindings, Queue inventory, health
contract, capture path, and production runbook now provision and use only the
Global inference lakehouse. The EU Worker has no inference Queue or Pipeline
bindings and explicitly skips archive staging.

**Why:** Cloudflare Data Catalog cannot use an EU-jurisdiction bucket. The direct
R2 Pipeline alternative requires a separate service credential created through
an interactive OAuth flow in Wrangler; attempts to substitute the deployment
token failed sink creation before any migration or Worker deployment. Product
direction is to defer EU analytical inference storage rather than add a second
credential lifecycle or export EU content to Global.

**Considered and rejected:** Continuing to automate a dedicated EU R2 token,
which would add token creation, rotation, orphan cleanup, and another immutable
sink lifecycle; and routing EU records into the Global Catalog, which would
violate the regional content boundary.

**Consequences:** Global inference remains lossless and queryable through the
API-only runbook. EU inference remains available to the product but has no raw
lakehouse evidence for later analysis. The empty EU bucket and stream created by
failed preflights are inert and are not deleted by this release.

### 2026-08-24 — Account-owned deployment tokens use their owning verifier

**What changed:** Merge provisioning now resolves the deployment token's S3
access-key ID through the account-owned token verification endpoint selected by
the checked-in lakehouse manifest. User-owned credentials remain supported only
when that ownership is declared explicitly in the manifest.
The production credential contract also names EU bucket-item Object Read &
Write separately from account-level R2 administration.

**Why:** Production uses an account-owned R2 API token. The user-token verifier
can accept that bearer credential without being the authoritative owner lookup;
using its returned identity produced an invalid R2 access key and made Pipeline
sink creation fail with `422 / 1012: invalid account id` even after the required
bucket-item permission was present.

**Considered and rejected:** Copying a second long-lived R2 secret into GitHub.
That would add a manual bootstrap and a second rotation path even though the
existing account-owned deployment credential is already registered for R2 and
can be scoped to the EU lakehouse bucket.

**Consequences:** First-merge provisioning remains non-interactive, account and
user deployment tokens both retain explicit coverage, verifier failures cannot
silently switch credential identity, and rotating the existing credential still
triggers the immutable sink identity guard.

### 2026-08-24 — Sink creation leaves account ownership to the API path

**What changed:** Sink-create payloads no longer repeat the Cloudflare account ID
inside `config`. The account-scoped API path remains authoritative. Existing
sink reads accept Cloudflare's public config with that field either present or
redacted, but still reject a different returned account ID.

**Why:** The first recovery deployment created the EU bucket and stream, then
Cloudflare rejected the direct-R2 sink with `422 / 1012: invalid account id`.
Wrangler's current sink-create implementation sends bucket and destination
configuration without `config.account_id`; the generated API schema incorrectly
suggested repeating this output field in the request.

**Considered and rejected:** Retrying the same documented body or weakening all
account checks. The live API had already disproved the former, while the latter
would discard useful drift evidence when Cloudflare does return its public
account field.

**Consequences:** Merge provisioning now matches Cloudflare's own client input
shape for both direct-R2 and Data Catalog sinks. Bucket ownership is still fixed
by the account-scoped endpoint, and a contradictory read-back fails closed.

### 2026-08-24 — EU preserves residency with a direct R2 Parquet sink

**What changed:** Global retains its Data Catalog/Iceberg sink. EU now uses a
Pipeline R2 sink that writes the same typed zstd Parquet under fixed hourly UTC
partitions in the existing EU-jurisdiction bucket. The merge deployment derives
the sink's S3 credentials from its existing Cloudflare API token and creates the
entire chain without an interactive authorization step. Credential-bound sink
names preserve the identity Cloudflare redacts from later sink reads and make a
deployment-token change fail closed before conflicting resources are created.
The production runbook uses the R2 Object API plus a local Parquet query across
every incident-overlapping hour for EU incidents.

**Why:** The first production deployment proved that Cloudflare R2 Data Catalog
cannot be enabled on a non-default-jurisdiction bucket. A Data Catalog sink also
cannot write across jurisdictions, so the intended EU Catalog design was not a
deployable regional boundary.

**Considered and rejected:** Moving EU inference into a default-jurisdiction
Catalog bucket would violate the workspace's selected data region. Blocking all
inference capture until Cloudflare adds jurisdictional Catalog support would
leave production model calls without the requested diagnostic evidence.

**Consequences:** EU keeps its exact archive and typed analytical Parquet in EU
and remains fully auto-provisioned, but it does not have server-side R2 SQL or
Iceberg table maintenance. Incident queries branch by region. If Cloudflare
later supports EU Data Catalog, replacing the EU sink requires a deliberate
immutable-resource migration rather than mutating this sink in place.

### 2026-08-24 — Product substream identity becomes a typed query dimension

**What changed:** Schema version 1 now includes optional typed column
`substream_id`. Work-stream inference defaults to the canonical main substream
`"0"`; streaming root and inline-child calls propagate the workflow's actual
substream ID, while inference outside a work stream leaves the field null. The
production query recipe filters and displays the dimension.

**Why:** `workstream_id` alone is unambiguous only while every run belongs to
the main substream. Once one work stream contains multiple real product
substreams, it cannot identify which conversation produced a request.

**Considered and rejected:** Treating each inline child as a substream. Inline
children are execution lineage within the same product conversation, already
represented by `request_id` and `parent_request_id`; assigning synthetic
substreams would conflate two different boundaries and make future product
substreams harder to query correctly.

**Consequences:** Current rows linked to work streams are explicitly queryable
as substream `"0"`, future substreams remain distinct without a second storage
path, and incident responders must include `substream_id` when narrowing a
work-stream query. The field was added before the first deployment of this new
immutable stream schema, so no stream replacement is needed.

### 2026-08-24 — Production inference debugging gets a safe retrieval path

**What changed:** The production runbook now turns a work-stream URL into the
correct regional R2 SQL API request, a bounded identifier query, the matching
request/attempt pair, and an R2 Object API retrieval of the exact regional
archive. It also covers
at-least-once duplicates, five-minute sink visibility, delivery failures,
separately scoped responder credentials, and scratch-file handling; `AGENTS.md`
points agents to that procedure.

**Why:** Naming the table and correlation keys was not enough for an incident
responder to retrieve evidence safely. The missing steps encouraged broad scans,
cross-region guessing, deployment-token reuse, or a return to the retired D1
ledger.

**Considered and rejected:** A custom query proxy in the product API. Production
debugging does not justify a new raw-content endpoint or another authorization
surface while Cloudflare already provides authenticated R2 SQL and R2 Object
APIs.

**Consequences:** Responders use the R2 SQL and R2 Object HTTP APIs, query only
the owning region and incident window, and move raw JSON to a temporary local
file only when the typed row is insufficient. The lakehouse remains analytical
evidence and never becomes product-state repair authority.

### 2026-08-24 — Hosted inference capture becomes lakehouse-only

**What changed:** Migration 0094 and the same Worker release remove the old
workspace-opt-in D1 index, preference, API/UI contract, and request-only
`agent-inference/` writer. The lakehouse is now the sole hosted raw-inference
capture path. Existing legacy R2 objects are left intact rather than erased by
an infrastructure deployment.

**Why:** Parallel diagnostic stores made completeness depend on an old
workspace switch and duplicated sensitive request bodies without retaining the
matching terminal provider envelope.

**Considered and rejected:** Retaining the D1 index as a lookup cache. It would
keep a second analytical schema and deletion lifecycle in the product database
for fields the Iceberg table already indexes.

**Consequences:** New inference analytics do not write D1. The operational
`inference_attempts` rows remain object-local because run recovery depends on
them, and a separate explicit decision is required before deleting historical
legacy R2 objects.

### 2026-08-24 — Every model call gains a lossless regional lakehouse trail

**What changed:** Streaming and structured inference now emit exact request and
terminal attempt records. Each region archives the record in R2, queues a hashed
pointer, and delivers a typed row through its own Pipeline to its own R2 Data
Catalog Iceberg table. The main-branch deployment creates and verifies every
queue, bucket, catalog, stream, sink, pipeline, table path, and generated Worker
binding without an operator step.

**Why:** The opt-in D1/R2 inference ledger was built for individual debugging,
not complete analytical coverage, and a Queue message cannot carry the largest
valid multimodal request. Staging the exact bytes in the existing regional
payload store keeps the queue small, makes integrity checkable, and lets the
Iceberg table retain broad query columns without truncating source evidence.

**Considered and rejected:** Sending the full record directly through Queue,
which fails above 128 KB; sending directly from the inference path to Pipeline,
which couples user success to the analytical sink and still fails above 5 MB;
and dropping or truncating prompt/response fields, which contradicts the
requirement to keep maximal metadata and makes the pathological calls the least
diagnosable ones.

**Consequences:** Inference storage is intentionally duplicated between raw R2
and Iceberg, delivery is at-least-once and must be deduplicated by `event_id` for
exact counts, raw records have no automatic retention yet, and the deployment
token needs R2 Data Catalog and Pipelines permissions in addition to the
existing Worker/Queue permissions.
