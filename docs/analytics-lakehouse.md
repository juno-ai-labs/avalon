# Analytics events lakehouse

The analytics events lakehouse is the lossless typed analytical projection of
Avalon's accepted Global telemetry. Backend producers, the desktop processes,
the renderer, preload, and the public site all use the existing telemetry
contract and regional collector; accepted Global events then travel through a
dedicated Cloudflare Queue and Pipeline into `avalon.analytics_events` in R2
Data Catalog.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/telemetry.ts` | Closed event, source, context, and property contracts shared by backend and clients. |
| `apps/api/src/telemetry/collector.ts` | Validates consent and route, commits the canonical `TELEMETRY_DB` row, then best-effort enqueues its pointer. |
| `apps/api/src/services/analytics-lakehouse.ts` | Builds pointers, recovers pending outbox rows, verifies the canonical row, and maps all accepted metadata to the analytical record. |
| `apps/api/src/queues/analytics-lakehouse-consumer.ts` | Applies queue poison/misroute policy and sends valid Global rows through `ANALYTICS_LAKEHOUSE`. |
| `packages/db/migrations/0095_analytics_events_lakehouse_outbox.sql` | Adds the Global lakehouse delivery state to the existing acceptance outbox; historical rows remain ineligible. |
| `config/analytics-events-lakehouse*.json` | Immutable Pipeline stream schema plus the pinned stream ID and names for the bucket, catalog, stream, sink, pipeline, namespace, table, and binding. |
| `scripts/ensure-cloudflare-inference-lakehouse.mjs` | Locally materializes both pinned bindings for deploys; explicit modes check or reconcile both Global lakehouses. |

## How it works

After the D1 commit, the collector sends only `{ eventId, payloadHash, region }`
to `avalon-global-analytics-events-lakehouse`. The pointer stays below Queue
payload limits even when the validated envelope is large. A failed send does not
change telemetry acceptance or any product response. The five-minute telemetry
maintenance pass retries both `pending` and still-undelivered `queued` rows in
the same 50-event quantum already used by telemetry ingestion and delivery. It
selects newest first so a live outage cannot put fresh debugging evidence behind
older recovery work. Migration `0095` deliberately does not backfill historical
acceptances.

The consumer reloads the D1 row, recomputes the acceptance hash from the stored
envelope and identity fields, verifies the route and pointer, reparses the
envelope against the live registry, and writes one record through Pipeline.
Permanent integrity or schema failures become `rejected` and are acknowledged;
only D1, Queue, and Pipeline availability failures retry. Promoted columns include event
and context schema versions; event/source/category/identity; routing and all four
timestamps; analytics person/workspace surrogates; release/build/platform;
launch, session, journey, operation, request, trace, span, device, and window
IDs. The complete validated `context` and `properties` objects also remain JSON
columns. Registry definition, product question, owner/review group,
authoritative source, priority, sample rate, retention, destination, property
classifications, integrity hash, acceptance deadline, and all native display/OS/
locale dimensions are promoted too. This preserves every currently admitted
metadata field and future optional fields without admitting unregistered content.

The direct pipeline SQL writes zstd-compressed Parquet to Data Catalog namespace
`avalon`, table `analytics_events`. Queue and Pipeline are at-least-once, so
physical duplicates are possible; `event_id` is the logical deduplication key.

- **Only accepted typed telemetry reaches the table.** Bypassing the collector
  would bypass source authority, preference, routing, and prohibited-content
  validation and create an ungoverned analytics channel.

- **D1 acceptance precedes Queue delivery.** The D1 row is the recoverable source
  for a small pointer; enqueueing first can create a message with no durable
  record to read.

- **Direct product identifiers stay out.** The table carries analytics
  surrogates, not `subject_user_id`; otherwise a broad analytical table becomes
  an identity authority and expands deletion and access risk.

- **The full context and properties remain schema-validated.** “Maximal
  metadata” means every admitted field, not arbitrary request bodies, prompts,
  messages, URLs, documents, console output, or DOM/network capture.

- **Capture failure never changes product behavior.** Analytics is a projection;
  making it part of an API or client success condition would couple availability
  to an analytical sink.

## Boundary

Only the API collector and scheduled recovery enqueue pointers. Only the Global
API queue consumer can call the Pipeline binding. Production responders query
through Cloudflare's authenticated HTTP APIs as documented in the
[`runbook`](runbook.md#querying-analytics-events-in-production).

- A collector Queue-send failure leaves the Global row `pending`; scheduled
  recovery retries it without failing the request.

- A consumer failure leaves the row `queued`; scheduled recovery re-enqueues it
  even if the original message exhausted retries into the DLQ. That can overlap
  an active Queue retry, which is safe under the `event_id` deduplication rule.

- A missing acceptance row means its 90-day D1 retention elapsed before an old
  message arrived; the consumer acknowledges it rather than filling the DLQ with
  unrecoverable work.

- A pointer mismatch is acknowledged without changing the canonical row so
  recovery can create a correct pointer. A modified stored payload or an
  envelope the live registry no longer accepts is marked `rejected` and
  acknowledged because retry cannot repair either one.

- A D1, Queue, or Pipeline failure is retried and can appear in
  `avalon-global-analytics-events-lakehouse-dead-letter`; the scheduled outbox
  pass remains able to redrive its canonical row.

- Pipeline files roll every 300 seconds, so a delivered event may take roughly
  one roll interval to become queryable.

- The D1 acceptance row and recovery source still expire after 90 days. Pipeline
  handoff is the lakehouse point of no return: a later opt-out, user cascade, or
  D1 deadline does not retract an already-projected Iceberg row, and
  `acceptance_delete_at` / `regional_retention` are analytical metadata rather
  than enforced catalog deletion deadlines. Cloudflare automatic snapshot
  expiration removes obsolete snapshots and unreferenced files; it does not
  delete current rows by predicate.

## Data model

The Iceberg table is `avalon.analytics_events` in bucket
`avalon-global-analytics-events-lakehouse`. Its schema is append-oriented and
immutable at the Cloudflare stream; incompatible changes require a new stream,
sink, and migration rather than editing a deployed schema.

## Security and trust model

Queue messages contain opaque IDs and a hash, not the envelope. The consumer
does not trust either: it reads the `TELEMETRY_DB` source, checks route/hash, and
revalidates the telemetry schema. Analytical rows carry random analytics
identities and content-free registered properties. Production queries require a
dedicated responder token and responses stay in an ignored scratch directory;
they are not printed into logs, tickets, commits, or agent responses.

## Operations

Health reports the Queue/Pipeline pair separately as `analyticsLakehouse`.
Inspect the primary queue and DLQ through the Cloudflare API/CLI and query the
table through the R2 SQL HTTP API, never the web dashboard. Exact commands and
safe query order are in the
[`runbook`](runbook.md#querying-analytics-events-in-production).

## Open questions

- Selective row expiry requires a transactional Iceberg writer. R2 SQL is a
  query surface, and Data Catalog's automatic snapshot expiration cleans up
  historical snapshots only after a row mutation has made files unreferenced.
  The current content-free semantic table therefore remains append-only until an
  automated engine can delete by `acceptance_delete_at`; direct R2 object
  deletion is forbidden because it corrupts the catalog. Expanding this table
  to arbitrary content or direct product identifiers is blocked on resolving
  that lifecycle.

### 2026-09-14 — Configurable deployment isolation

The event outbox, queue consumer, and recovery query use the configured deployment identifier. The existing Global export policy now applies throughout; delivery still verifies the pointer against its owning acceptance row.

### 2026-09-01 — Deploys materialize the pinned analytics stream locally

**What changed:** The analytics stream's existing production ID is pinned in
its schema-version-5 manifest. Application deploys materialize that binding
locally, while explicit check and reconciliation modes retain the bucket,
catalog, stream, credential-bound sink, and Pipeline assertions.

**Why:** The Pipelines management API was intermittently returning HTTP 500 for
healthy resources. An unrelated Worker release needs the stable binding ID but
does not need to re-list immutable analytics infrastructure.

**Considered and rejected:** Dropping infrastructure verification entirely, or
deriving the ID from a failed live preflight. The first loses drift detection;
the second keeps application delivery coupled to the failing control plane.

**Consequences:** Ordinary releases make no Pipelines management request for
analytics. Creating or recreating its stream is an explicit two-pass operation:
create and review the generated ID, commit the new pin, then reconcile the sink
and Pipeline.

### 2026-08-24 — Recovery distinguishes poison rows from unavailable dependencies

**What changed:** Delivery now recomputes the stored acceptance hash, terminally
rejects permanent pointer/schema failures, redrives both pending and queued rows
newest-first through the partial index, and omits the initial historical
backfill. The retention boundary now explicitly names Pipeline handoff as the
catalog point of no return.

**Why:** Review proved that retrying immutable corruption only fills the DLQ,
that a Queue message exhausting retries stranded its D1 row as `queued`, that
the original query could not use its partial index, and that months of backfill
could starve fresh failures. It also proved that D1 expiry and late opt-out do
not delete a current Iceberg row, so describing the table as inheriting source
retention was false.

**Considered and rejected:** Treating every delivery exception as transient,
re-enqueueing only `pending` rows, retaining the historical backfill, and
claiming automatic snapshot expiration implements row retention. Snapshot
expiration cleans up unreferenced files; it does not issue predicate deletes.

**Consequences:** Historical accepted events are not backfilled. Active Queue
retries can overlap scheduled recovery, so physical duplicates remain possible
and `event_id` remains the logical key. Projected rows persist until Avalon adds
an automated transactional Iceberg deletion engine; their retention fields are
metadata, not an enforced erasure promise.

Shipped in the pull request for this change.

### 2026-08-24 — Backend and client analytics gain one governed Global lakehouse

**Why:** Backend and client analytics already converge at one policy boundary,
but their durable analytical history existed only in destination-specific or
short-lived regional stores. Projecting after acceptance preserves one event
contract and makes rich metadata queryable without inventing a parallel client
transport or granting the renderer provider authority.

Shipped in the pull request for this change.


## Changelog

### 2026-09-14 — Fence retired meeting data before erasure

Built-in meeting telemetry is suppressed at acceptance and again before PostHog and lakehouse delivery. Historical event schemas remain readable so an old installed client or queued pointer cannot restore retired metadata. Previously delivered rows must be deleted separately through each destination; deleting shared Parquet files or whole people would also erase unrelated activity. See `meeting-notes.md` (retired).
