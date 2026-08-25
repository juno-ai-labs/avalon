# Analytics events lakehouse

The analytics events lakehouse is the lossless typed analytical projection of
Avalon's accepted Global telemetry. Backend producers, the desktop processes,
the renderer, preload, and the public site all use the existing telemetry
contract and regional collector; accepted Global events then travel through a
dedicated Cloudflare Queue and Pipeline into `avalon.analytics_events` in R2
Data Catalog.

This is analysis storage, never product authority. EU events remain in the
existing EU telemetry D1/R2 boundary and are intentionally not copied to this
Global lakehouse.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/telemetry.ts` | Closed event, source, context, and property contracts shared by backend and clients. |
| `apps/api/src/telemetry/collector.ts` | Validates consent and route, commits the canonical regional D1 row, then best-effort enqueues its pointer. |
| `apps/api/src/services/analytics-lakehouse.ts` | Builds pointers, recovers pending outbox rows, verifies the canonical row, and maps all accepted metadata to the analytical record. |
| `apps/api/src/queues/analytics-lakehouse-consumer.ts` | Applies queue poison/misroute policy and sends valid Global rows through `ANALYTICS_LAKEHOUSE`. |
| `packages/db/migrations/0095_analytics_events_lakehouse_outbox.sql` | Adds the Global lakehouse delivery state to the existing acceptance outbox; historical rows remain ineligible. |
| `config/analytics-events-lakehouse*.json` | Immutable Pipeline stream schema and names for the bucket, catalog, stream, sink, pipeline, namespace, table, and binding. |
| `scripts/ensure-cloudflare-inference-lakehouse.mjs` | Idempotently provisions both Global lakehouses and materializes their generated stream IDs into deploy configs. |
| `apps/api/wrangler.global.jsonc`, `apps/api/wrangler.eu.jsonc` | Global declares the queue pair; EU declares the intentional absence. |

## How it works

Every producer first passes the telemetry registry and regional collector. This
keeps client and backend analysis on the same source, identity, preference,
route, validation, and retention metadata instead of adding a second client API.
The collector commits the canonical envelope, acceptance timestamps, routing
basis, and analytics surrogates to `telemetry_accepted_events`. Global rows
begin with `analytics_lakehouse_state = 'pending'`; EU rows keep it null.

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

On each merge to `main`, the API deployment first creates every declared queue,
then idempotently creates both lakehouse buckets, catalogs, streams, immutable
sinks, and pipelines. It discovers the generated stream IDs and writes ignored
`.wrangler.lakehouses.<region>.json` configs before migrations or deployment.
The Global config holds both Pipeline bindings; EU holds neither. There is no
dashboard or other manual creation step.

## Invariants

- **Only accepted typed telemetry reaches the table.** Bypassing the collector
  would bypass source authority, preference, routing, and prohibited-content
  validation and create an ungoverned analytics channel.
- **D1 acceptance precedes Queue delivery.** The D1 row is the recoverable source
  for a small pointer; enqueueing first can create a message with no durable
  record to read.
- **EU never enters this transport.** Adding an EU producer, consumer, Pipeline
  binding, or Global fallback would cross the recorded regional boundary.
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

This module owns the Global lakehouse projection and delivery lifecycle. The
telemetry registry, user preference, regional identity, event production, local
spools, PostHog delivery, EU internal analysis, and crash processing remain
owned by [`telemetry.md`](telemetry.md). Raw LLM request/response content remains
owned by [`inference-lakehouse.md`](inference-lakehouse.md) and never enters this
table.

Only the API collector and scheduled recovery enqueue pointers. Only the Global
API queue consumer can call the Pipeline binding. Production responders query
through Cloudflare's authenticated HTTP APIs as documented in the
[`runbook`](runbook.md#querying-analytics-events-in-production).

## Failure modes and limits

- A collector Queue-send failure leaves the Global row `pending`; scheduled
  recovery retries it without failing the request.
- A consumer failure leaves the row `queued`; scheduled recovery re-enqueues it
  even if the original message exhausted retries into the DLQ. That can overlap
  an active Queue retry, which is safe under the `event_id` deduplication rule.
- A malformed pointer or a pointer received by EU is acknowledged after a
  content-free error log because retry cannot make it valid.
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

## Testing

`pnpm --filter @avalon/api exec vitest run test/analytics-lakehouse.test.ts`
covers client-shaped capture, complete record mapping, direct-ID exclusion,
queue failure recovery, delivery state, and EU non-export against the checked-in
D1 migrations. `node --test scripts/ensure-cloudflare-inference-lakehouse.test.mjs
scripts/ensure-cloudflare-queues.test.mjs` covers empty-account provisioning,
idempotency, immutable drift, combined binding materialization, queue pairing,
and workflow order. Environment-contract and health tests cover the Global-only
binding requirement.

## Data model

`telemetry_accepted_events.analytics_lakehouse_state` is nullable and is one of
`pending`, `queued`, `delivered`, `suppressed`, or `rejected`; null means the row
is not eligible, which is the permanent EU state and the state of acceptances
that predate this feature. `analytics_lakehouse_delivered_at` records successful
Pipeline handoff. Migration `0095` seeds only new Global inserts so deployment
does not put live recovery behind a historical backfill.

The Iceberg table is `avalon.analytics_events` in bucket
`avalon-global-analytics-events-lakehouse`. Its schema is append-oriented and
immutable at the Cloudflare stream; incompatible changes require a new stream,
sink, and migration rather than editing a deployed schema.

## Regional impact

Global receives typed events from Global backend and client/site producers and
projects them into the Global Data Catalog bucket. EU accepts the same governed
contracts into EU D1 and its existing internal telemetry projection but has no
analytics-events queue, Pipeline, catalog bucket, or Global bridge. A future
EU-resident lakehouse is a separate recorded residency decision, not a binding
added to the current table.

## Security and trust model

Queue messages contain opaque IDs and a hash, not the envelope. The consumer
does not trust either: it reads the regional D1 source, checks route/hash, and
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

## Changelog

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

**What changed:** Added a second Global Queue/Pipeline/Data Catalog path for all
accepted typed analytics events, including a D1 pointer outbox, scheduled
recovery, full validated metadata projection, automatic resource provisioning,
health checks, API-only production queries, and explicit EU non-export.

**Why:** Backend and client analytics already converge at one policy boundary,
but their durable analytical history existed only in destination-specific or
short-lived regional stores. Projecting after acceptance preserves one event
contract and makes rich metadata queryable without inventing a parallel client
transport or granting the renderer provider authority.

**Considered and rejected:** Sending clients directly to Pipeline, putting full
envelopes in Queue messages, reusing the raw-inference table, and exporting EU
events to the Global catalog. Those choices respectively bypass policy, exceed
valid transport size, mix content-sensitive and semantic records, or violate the
regional boundary.

**Consequences:** Global deployment credentials must retain R2 Data Catalog,
Pipelines, Queues, and R2 permissions; operators deduplicate by `event_id`; EU
analytics remains on its existing regional path until an EU-resident analytical
sink is separately approved.

Shipped in the pull request for this change.
