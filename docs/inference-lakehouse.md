# Inference lakehouse

The inference lakehouse records every streaming and structured model request and
terminal attempt as a regional analytical event. It keeps the exact JSON record
in the workspace region's payload bucket and delivers a typed projection through
a regional Cloudflare Queue and Pipeline. Global lands in an Apache Iceberg
table in R2 Data Catalog. EU lands as the same typed, zstd-compressed Parquet in
an EU-jurisdiction R2 bucket because Cloudflare Data Catalog
[does not support non-default jurisdictions](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/#jurisdiction-restrictions).

This is an operational data system containing prompts, conversations, tool
schemas and calls, model output, identifiers, and provider errors. It is not
product authority, and a capture failure does not change the inference outcome.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/agent-harness/src/index.ts`, `bind-runtime.ts` | Emit one exact request event and one terminal attempt event for each structured or streaming provider call. |
| `apps/api/src/services/inference-lakehouse.ts` | Build the common record, archive it in regional `PAYLOADS`, hash it, and enqueue the pointer without failing the inference. |
| `apps/api/src/queues/inference-lakehouse-consumer.ts` | Validate the pointer and archived bytes, enforce the regional boundary, fit the row to Pipeline's request limit, and send it through `INFERENCE_LAKEHOUSE`. |
| `config/inference-lakehouse.json` | Source of truth for the regional bucket, stream, sink, pipeline, namespace, table, and binding names. |
| `config/inference-lakehouse-stream-schema.json` | Immutable structured-stream schema and analytical column contract. |
| `scripts/ensure-cloudflare-inference-lakehouse.mjs` | Idempotent bucket, region-appropriate sink, stream, and pipeline provisioning plus generated-ID binding materialization. |
| `apps/api/wrangler.global.jsonc`, `wrangler.eu.jsonc` | Regional Queue producer/consumer and dead-letter declarations. |
| `.github/workflows/deploy-api.yml` | Runs both resource preflights and deploys the generated Wrangler configs before any inference can target the resources. |

## How it works

### Capture and archive

The harness assigns one `inference_request_id` to a provider call. It emits a
`request` event before the call and an `attempt` event when that call succeeds or
fails. Streaming requests carry the exact OpenRouter body; streaming attempts
carry the complete normalized content, tool calls, usage, finish reason, and
generation ID. Structured calls carry the exact request body and the provider's
complete successful JSON response envelope. Failed calls retain the bounded
provider classification and message, not arbitrary provider metadata that may
echo the rejected prompt under an unrecognized key.

The API turns each event into schema version 1. Core dimensions are columns:
region, environment, build, source, invocation type, workspace/user/work-stream/
substream and host request IDs, inference/turn/schema IDs,
provider/routed/provider model, success/disposition/failure, latency/TTFT, token
classes, cost, and response bytes. The full request, response, error, routing
cursor, retry/repair positions, validation issues, and counts remain JSON
columns. The `request` and `attempt` rows join on `inference_request_id`;
`event_id` adds the event type and is the stable deduplication key.

`substream_id` is the canonical product substream inside a work stream. Avalon
currently runs the main substream, so work-stream-linked inference that has no
more specific identity is recorded as `"0"`; inference unrelated to a work
stream leaves the column null. A root run and any inline children inherit the
same product substream. Inline-child execution is a run-lineage distinction,
not a new product substream, and remains queryable through `request_id` and
`parent_request_id`. When additional product substreams are exposed, their
canonical IDs flow through the existing workflow input instead of collapsing
all rows under `workstream_id`.

Before enqueueing, the Worker serializes and validates the complete record,
computes its byte length and SHA-256, and writes it to
`inference-lakehouse/records/<date>/<event-id>.json` in the regional `PAYLOADS`
bucket. The Queue message contains only schema version, region, event ID, object
key, hash, byte count, and capture time. This extra R2 hand-off is intentional:
Queue messages cannot hold a large multimodal inference record, while an opaque
pointer is small, region-safe, and independently verifiable.

### Queue and Pipeline delivery

`avalon-global-inference-lakehouse` is consumed only by the Global Worker and
`avalon-eu-inference-lakehouse` only by the EU Worker. The consumer rejects a
pointer for the other region, loads only its own `PAYLOADS` binding, verifies
the exact byte count and SHA-256, parses the schema again, and sends a one-row
array through the region's `INFERENCE_LAKEHOUSE` Pipeline binding.

Pipeline ingestion requests have a 5,000,000-byte ceiling. When the array-wrapped
record would exceed it, the consumer removes only the full `request` and
`response` JSON from the analytical row and adds `payload_object_key`,
`payload_sha256`, and `payload_bytes`. Every queryable dimension, failure, usage,
and metadata field still lands in the analytical projection, while the exact
record stays at the verified regional R2 pointer. Records below the ceiling also
remain in R2; the archive is the lossless source and makes redelivery independent of a prior Queue
acknowledgement.

The Pipeline is a direct `INSERT INTO <sink> SELECT * FROM <stream>`. Both sinks
write zstd-compressed Parquet with a 300-second rolling interval. Global writes
to Data Catalog namespace `avalon`, table `llm_inference`; Cloudflare creates the
namespace and table when the first records arrive. EU writes ordinary Parquet
under `avalon/llm_inference/year=<UTC year>/month=<month>/day=<day>/hour=<hour>`
in `avalon-eu-inference-lakehouse`. The schema and row contents are identical;
only the regional storage/query surface differs.

### Provisioning on merge

The API deployment does all resource work before migrations or Worker upload:

1. `ensure-cloudflare-queues.mjs` creates both regional queues; each Wrangler
   consumer declaration causes its regional dead-letter queue to be created on
   first deployment.
2. `ensure-cloudflare-inference-lakehouse.mjs` creates each regional R2 bucket,
   enables Global's Data Catalog, and creates the structured stream, immutable
   region-appropriate sink, and pipeline if they are absent. It derives the EU
   R2 sink's S3 credentials from the existing deployment API token; it never
   opens an OAuth flow or requires a separately copied secret. Both immutable
   sink names include the verified token ID's SHA-256 fingerprint so their
   credential identity remains observable without exposing the ID, even though
   Cloudflare redacts credentials from sink reads.
3. The preflight discovers Cloudflare's generated stream IDs and writes ignored
   `.wrangler.inference.<region>.json` files containing the Pipeline bindings.
4. The workflow deploys EU and then Global with those generated configs. Health
   requires both the Queue and Pipeline binding in staging and production.

Later merges run the same path. Existing resources are read back and compared to
the manifest; immutable schema, sink, or SQL drift fails the deployment rather
than creating a parallel table or silently dropping fields. No resource requires
a dashboard or laptop step. The existing deployment token must have Workers R2
Storage Admin Read & Write, Pipelines, Queues, and Worker deployment permissions.
Its token value is installed in a newly created Global Data Catalog sink. For the
EU R2 sink, the token ID becomes the S3 access key and the SHA-256 of the token
value becomes its secret access key, as Cloudflare's R2 API-token contract
specifies; neither derived value is logged or persisted in a generated Wrangler
file. Replacing that deployment token changes the desired credential-bound sink
names, so provisioning fails before creating conflicting sinks. Rotating the
credential therefore requires an explicit immutable sink/pipeline migration,
not an ordinary secret replacement that silently strands delivery.

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
  structured Pipeline stream cannot be edited. The deploy refuses drift, so a
  field cannot be removed or retyped under an existing table by accident.
- **Capture is best effort with respect to the model call.** A Queue, R2, or
  Pipeline outage must not turn a successful user inference into a failure. The
  structured failure log and DLQ are the operator-visible consequences.

## Boundary

The harness owns faithful request/attempt events. The lakehouse owns archival,
transport, analytical shape, and provisioning. The regional `PAYLOADS` bucket
remains a general object store; this module owns only the
`inference-lakehouse/records/` prefix. Global R2 Data Catalog owns Iceberg
commits, compaction, namespace/table creation, and query-engine interoperability.
Cloudflare Pipelines owns the EU Parquet file layout under the manifest's fixed
prefix and UTC partitions.

The analytical projection is not the work-stream transcript, billing authority,
model-routing control, or the owning execution object's operational
`inference_attempts` ledger. Those systems may correlate with `request_id`, `workstream_id`,
`substream_id`, and `inference_request_id`, but none may use lakehouse arrival
as proof that a model call committed product state.

## Failure modes and limits

- A capture archive or Queue-send failure emits `inference_lakehouse_stage_failed`
  and does not fail the inference. The object is removed when Queue acceptance
  itself fails. The harness does await the regional archive and Queue acceptance,
  so their latency is added before or after the provider call; Pipeline and sink
  work is fully off the inference path.
- Invalid or cross-region pointers are poison: the consumer logs and acknowledges
  them so they cannot retry forever. Missing, corrupt, or schema-invalid archived
  bytes and Pipeline failures retry and eventually reach the regional DLQ.
- A Pipeline record above 5,000,000 bytes becomes a pointer-backed analytical row;
  its exact record remains in regional R2. Queue messages remain far below the
  Queue's 128 KB message limit because they contain no inference JSON.
- The consumer uses Cloudflare's defaults of 10 messages, a 5-second batch
  window, and three retries. There is no user-visible dependency that justifies
  a lower latency or a guessed custom retry number; the regional DLQ is the
  failure signal.
- Both sinks roll files every 300 seconds. Global Data Catalog requires at least
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
uses a stateful Cloudflare API double to prove a blank account is fully created,
a second run creates nothing, generated IDs reach both Wrangler files, check mode
does not mutate, immutable drift refuses deployment, and provisioning precedes
migrations and upload. `ensure-cloudflare-queues.test.mjs` pins each producer,
consumer, and DLQ name.

Run the focused suites with:

```text
pnpm --filter @avalon/api exec vitest run test/inference-lakehouse.test.ts
pnpm --filter @avalon/api test:workers -- queue-dispatch.test.ts
node --test scripts/ensure-cloudflare-inference-lakehouse.test.mjs
```

## Data model

`config/inference-lakehouse-stream-schema.json` is authoritative for the
analytical shape in both sinks. It uses typed scalar columns for filters and
aggregates, JSON columns for lossless nested inference data, and three optional
payload-pointer columns for a record whose exact JSON cannot fit one Pipeline
ingestion request. Version 1 has two rows per successful provider call and normally two per failed call: the
request and terminal attempt.

## Regional impact

Global uses `avalon-global-inference-lakehouse` resources, default R2
jurisdiction, and a Data Catalog sink. EU uses
`avalon-eu-inference-lakehouse`, an ordinary R2 sink, and the `eu` jurisdiction
for both bucket access and sink configuration. Both use the same binding names
and immutable stream schema, but querying necessarily branches: Global uses R2
SQL over `avalon.llm_inference`; EU lists and downloads the incident's UTC
Parquet partition through the R2 Object API and queries it locally. There is no
combined account-wide inference table or cross-region fallback.

## Security and trust model

Inference JSON is trusted only after Zod validation at capture and again at
delivery. Queue fields cannot select a bucket or Pipeline binding; they can name
only an object key inside the Worker deployment's fixed regional binding, and a
signed hash proves the loaded bytes are the bytes the producer queued.

The records are maximally sensitive: system/user/assistant messages, attachment
data, tool schemas and arguments, tool/provider identifiers, output, errors,
workspace/user correlations, and usage/cost data may all be present. Do not emit
these JSON fields to Workers Logs, expose the bucket or catalog publicly, or hand
query credentials to product clients. `substream_id` is an identifier, not an
authorization boundary; a query client still needs regional responder access.
The Cloudflare administration token remains in deployment configuration and is
installed only into the immutable sinks as their delivery credential; it is
never a Worker variable or an inference record.

## Operations

Start with `inference_lakehouse_stage_failed` for producer-side gaps and
`inference_lakehouse_delivery_failed` for consumer retries. A non-empty
`avalon-<region>-inference-lakehouse-dead-letter` queue is the definitive
delivery alarm. `inference_lakehouse_delivered` includes only identifiers,
source, event type, and whether the row used the oversized fallback.

`pnpm cloudflare:resources:check` verifies both existing regional lakehouses and
all other declared hosted resources without creating anything.
`pnpm cloudflare:inference-lakehouse:ensure -- --materialize-bindings` is the
same idempotent path the deployment uses and is break-glass tooling, not a
required release step. Query Global's `avalon.llm_inference` Iceberg table or
EU's bounded UTC Parquet files by `event_id`, `inference_request_id`, workspace/
work-stream/substream/request IDs, model, source, time, success/failure, or usage.
Follow `payload_object_key` into the same region's payload bucket when the exact
JSON is needed.

For production debugging, follow the API-first, region-selection, bounded query,
inference-pair interpretation, raw-object verification, and missing-row
procedure in [`runbook.md`](runbook.md#inspecting-a-runs-raw-inference). Do not
improvise a D1 query or use the provisioning credential as a general-purpose
reader. Cloudflare's R2 SQL surface is beta and applies only to Global; its
invocation syntax may move. The runbook links the current upstream query guide
and uses the stable R2 Object API for EU while keeping Avalon's table, bucket,
event, privacy, and authority rules local and stable.

## Performance and cost

Each provider call normally creates two payload objects, two Queue messages,
and two Pipeline/Parquet records. The Queue isolates these analytical writes
from Pipeline and sink latency; the producer still waits for regional R2 archive
and Queue acceptance. Pipeline ingestion is free; transformation and sink writes
are usage-priced, and R2 stores both the raw archive and analytical Parquet files.
This duplication is the explicit price of keeping exact large records
while retaining queryable columns. Revisit it only with real storage cost or a
decided retention policy, not a speculative cache or aggregation layer.

## Changelog

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
