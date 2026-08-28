# Global search — Turbopuffer projection design

> Companion to [`prd.md`](prd.md). This is an implementation sketch, not a
> durable subsystem document. When search ships, the accepted architecture moves
> into a registered `docs/global-search.md` with a running changelog.

## Boundary

Canonical content remains where Avalon already owns it:

| Source | Canonical authority |
| --- | --- |
| Work-stream metadata and viewer projection | WorkspaceDO |
| Messages and visible parts | SubstreamAgent, aggregated through WorkstreamDO |
| Notes and transcript segments | WorkspaceDO |
| Resources and extraction state | WorkspaceDO; extracted bytes in regional R2 |
| Automations | WorkspaceDO |
| Members | regional control plane/client cache |

Turbopuffer stores a derived, region-local retrieval projection. A result from
Turbopuffer is only a candidate. WorkspaceDO owns the active namespace
generation, authorization, current destination state, and response shaping.

The design deliberately does not create a generic `SearchProvider` interface.
The Turbopuffer client is isolated in one module so transport code does not leak
through the product, but its query capabilities are part of this design. A
provider change rebuilds the disposable corpus from canonical sources.

## Why Turbopuffer

Turbopuffer directly supplies the V1 primitives:

- BM25 over `string` and `[]string` fields, including `last_as_prefix` for
  type-ahead ([full-text guide](https://turbopuffer.com/docs/fts),
  [query reference](https://turbopuffer.com/docs/query));
- exact and array filters, including `Contains`/`ContainsAny`, for candidate ACL
  reduction;
- `limit.per`, which diversifies ranked fragments by destination identity;
- multi-query, so every result group can receive its own bounded candidate set
  from one consistent namespace snapshot;
- strong consistency by default, with committed but not-yet-indexed writes still
  searched ([architecture](https://turbopuffer.com/docs/architecture)); and
- a vector/hybrid path if lexical-search evidence later justifies it.

The service recommends a namespace per isolated document space. Avalon maps that
to one namespace per workspace, which is also the product's authorization,
regionalization, rebuild, and deletion boundary.

Cloudflare AI Search is not selected for V1. Its Workers binding, BM25, hybrid
search, and pre-retrieval metadata filters are attractive, but the current
metadata contract permits five custom fields and does not filter values inside
stored arrays ([metadata limits](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/),
[filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/)).
That makes participant ACLs and Avalon's typed destination model an awkward fit.
This is a current-product constraint, not a claim that AI Search is incapable of
serving Avalon later.

Typesense remains credible prior art, not a second implementation. Its stronger
turnkey faceting/grouping does not outweigh Turbopuffer's public proof on
multi-tenant workspace corpora or justify maintaining two vendors.

## Namespace and schema

### Namespace identity

WorkspaceDO stores:

```text
search_namespace_generation: integer
search_namespace_state: absent | building | ready | deleting | failed
search_backlog_present: boolean
```

The namespace name is deterministic from the opaque workspace id and generation,
for example `ws_<workspace-id>_g1`. The selected Turbopuffer API endpoint—not a
string in the namespace name—determines the storage region.

Global and EU deployments use different Turbopuffer organizations, API keys, and
approved regional endpoints. Turbopuffer documents public regions in North
America and Europe and states that data remains in the selected region
([regions](https://turbopuffer.com/docs/regions),
[security](https://turbopuffer.com/docs/security)); production use still depends
on Avalon's contractual review.

### Search document

One physical document is one independently replaceable fragment:

```ts
type SearchDocument = {
  id: string;                 // deterministic: <source-kind>:<source-id>[:<chunk>]
  source_type: string;        // message, note_segment, resource_chunk, ...
  source_id: string;
  source_version: number;

  result_type: "workstream" | "automation" | "note" | "document";
  result_id: string;
  destination_version: number;

  scope: "workspace" | "personal";
  viewer_ids: string[];       // ACL hint for personal destinations only
  archived: boolean;

  title: string;
  body: string;
  updated_at: string;

  anchor_kind: "none" | "message" | "note_segment" | "resource_chunk";
  anchor_id: string | null;
  anchor_order: number | null;
};
```

Schema behavior:

| Attribute | Turbopuffer behavior |
| --- | --- |
| `title`, `body` | `full_text_search: true`, not otherwise filterable |
| `result_type`, `result_id` | filterable; together form the `limit.per` key |
| `scope`, `viewer_ids`, `archived` | filterable candidate-authorization hints |
| versions | filterable for conditional/idempotent writes |
| `updated_at` | indexed for a bounded recency contribution |
| source and anchor fields | returned; filter only where repair/delete needs it |

Turbopuffer infers schemas by default, but Avalon sends the complete explicit
schema with the first write so a missing first value cannot infer an incompatible
type. The provider documents that attribute types cannot be changed in place;
an incompatible change therefore creates a new namespace generation
([write/schema reference](https://turbopuffer.com/docs/write)).

### Fragment mapping

| Source | Fragment and destination |
| --- | --- |
| Work-stream directory row | one fragment → work stream |
| Visible message | one fragment → containing work stream |
| Automation subscription/template projection | one fragment → automation |
| Note metadata/briefing | one fragment → note |
| Note transcript segment | one fragment → note |
| Resource title | one fragment → document |
| Extracted resource content | bounded chunks → document |

A fragment body is bounded before it enters an outbox or provider request.
Document extraction is chunked on stable text boundaries with deterministic
chunk ordinals; changing the extractor version replaces the source's prior
chunk set. The implementation change sets the byte and chunk bounds from Queue,
Worker-memory, response-size, and useful-snippet arithmetic.

Titles are copied from canonical state without adding a new product title limit.
If the derived copy needs truncation, truncation occurs on a code-point boundary
and never rejects the canonical write.

## Live indexing

### Commit, outbox, wake-up

The invariant is:

```text
canonical commit
  -> durable latest-wins search intent
  -> opaque Queue wake-up
  -> hydrate current canonical source
  -> batched conditional Turbopuffer write
  -> acknowledge intent
```

The canonical transaction never calls Turbopuffer. It records or advances a
durable outbox row keyed by source identity. Repeated edits coalesce to the
latest requested version instead of appending provider writes.

The Queue message contains a regional workspace/source identity and version, not
text. A consumer hydrates the latest canonical value after delivery. If the
source changed again, the consumer indexes the newer value; if it was deleted,
the consumer deletes its deterministic fragment ids. Queue ordering is therefore
irrelevant to correctness.

For message text, SubstreamAgent records the local intent and WorkstreamDO uses
the established regional-effect path to deliver it into the workspace's search
outbox. The Queue wake remains an opaque identifier, matching the existing rule
that durable payloads stay in object storage rather than becoming Queue state.

### Consumer

Each regional API deployment receives a dedicated search-index Queue and DLQ.
The dedicated queue prevents a Turbopuffer outage from stalling activity or
notification effects. Cloudflare Queues provides at-least-once delivery,
consumer batching, retries, and dead-letter routing
([delivery](https://developers.cloudflare.com/queues/reference/how-queues-works/),
[batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/),
[DLQs](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)).

The consumer:

1. groups delivered wake-ups by workspace and active namespace generation;
2. asks the owning objects for the latest bounded snapshots;
3. collapses duplicate source identities to their newest version;
4. batches full-document upserts and deterministic deletes per namespace;
5. uses a source-version condition so a late batch cannot replace a newer row;
6. acknowledges each outbox intent only after Turbopuffer accepts the write; and
7. acknowledges Queue messages individually, retrying only failed work.

Provider `429`, `5xx`, timeout, and connection failures are retryable. Schema,
authentication, invalid-region, and same-version/different-payload failures are
stable failures: they retain the outbox intent, enter the DLQ after Queue
retries, and notify operations without logging indexed content. The DLQ is the
failure Avalon can notice without inventing a metrics stack.

Turbopuffer's documented write backpressure remains enabled. Initial loading
does not use `disable_backpressure`; the Workflow and Queue naturally slow down
when the provider asks them to.

### Deletes and access changes

A source deletion is a deterministic delete-by-id. Deleting a destination emits
a delete-by-filter on `(result_type, result_id)` so every child fragment is
removed, followed by the destination tombstone/version fence in Avalon's durable
outbox state. A late source update cannot pass that fence.

When access changes, the canonical rule takes effect immediately because every
query is re-authorized. An asynchronous patch-by-filter updates `scope` and
`viewer_ids` on every fragment for the destination, improving future candidate
selection. Stale ACLs may temporarily omit a new grant; they may not expose a
revocation.

## Query path

### Request flow

```text
desktop
  -> authenticated regional Worker
  -> WorkspaceDO.search(user, query, optional group)
  -> Turbopuffer namespace multi-query
  -> WorkspaceDO canonical authorization and destination hydration
  -> grouped response
```

Only the regional server holds the Turbopuffer key. WorkspaceDO rejects a query
unless the caller is a current workspace member, selects only its stored active
namespace generation, and never accepts a namespace from request input.

Each query uses Turbopuffer's strong consistency. This ensures the result includes
all writes the provider has accepted before the query starts; it does not claim
the Cloudflare projection queue is synchronous.

### Ranking and grouping

The unscoped request sends one Turbopuffer multi-query subquery for each remote
group. Each subquery:

1. filters `archived = false` and the desired `result_type`;
2. filters `scope = workspace OR viewer_ids Contains <caller>` as an ACL hint;
3. ranks a weighted title BM25 clause plus body BM25, both with
   `last_as_prefix: true`;
4. applies a bounded recency tie-break; and
5. requests one fragment per `(result_type, result_id)` through `limit.per`.

The preview asks for six canonically authorized destinations per group: five to
render and one sentinel. A scoped query asks for 51. Because indexed ACLs can be
stale, the server may fetch another bounded page excluding identities already
examined. The implementation sets a maximum candidate-scan budget. Reaching it
under-reports `hasMore`; it never forwards a provider total or relaxes auth.

The user-facing groups are not implemented with Turbopuffer's `group_by`.
`group_by` is for aggregations; `limit.per` is the retrieval primitive that
keeps only the best evidence fragment per destination. Multi-query supplies the
independent per-kind caps.

Title/body weights and recency parameters are not constants guessed from another
product. The implementing change records a small reviewed query set, the chosen
ranking expression, and why its results satisfy the product ordering. No
personal data or production queries enter that fixture.

### Canonical authorization

WorkspaceDO treats every provider attribute as untrusted projection data. It
loads each candidate destination and applies an exhaustive predicate by result
kind:

- work streams/messages: current workspace scope or the settled personal
  work-stream read rule;
- automations: current subscription scope and archive state;
- notes/transcripts: current note scope and owner rule;
- documents: the complete resource rule, including connector, draft upload,
  note-backed, and inbound-email arms.

Any missing destination, unknown type, deleted/archive state, version fence, or
failed predicate excludes the candidate. Returned titles and destination
metadata come from canonical state when available; the provider contributes the
rank only until its source is checked.

The matching source is then validated at its owning authority, batched by work
stream where necessary. The authority confirms that the source id still exists,
its version matches the indexed `source_version`, and the exact fragment remains
person-visible. For resources, the current extraction generation must also match.
Only then may the bounded provider body and typed anchor become evidence in the
response. A deleted message or a part changed from `people` to `model` therefore
cannot leak stale text merely because its containing work stream is still
readable. A stale metadata fragment may still produce its canonically current
destination title, but never its stale text.

Authorization happens before the visible rows, selection, or `hasMore` state are
computed. Access loss therefore applies on the next request without waiting for
an index sweep.

### Snippets and anchors

V1 does not depend on Turbopuffer's beta Highlight API. Each indexed body is
already a bounded message, transcript segment, or document chunk. The server
returns only the best authorized fragment; the renderer extracts a single line
of context and highlights matched tokens as plain text.

The response includes a typed anchor only after authorization. A message anchor
causes an anchored transcript read around the canonical sequence number, rather
than loading the tail and attempting to scroll to an element that is absent.
Note and document anchors follow their existing navigation semantics. If a stale
anchor no longer exists, the destination opens normally without reconstructing
deleted text from the provider.

## Backfill, rebuild, and repair

A Cloudflare Workflow owns each workspace backfill or rebuild. Workflows provide
durable, retryable steps and persisted state without holding one Worker request
open ([Cloudflare Workflows](https://developers.cloudflare.com/workflows/)).

The Workflow:

1. creates the target namespace generation with the explicit schema;
2. enumerates WorkspaceDO-owned sources by stable cursor and enqueues them;
3. enumerates directory work streams, then asks each owner for visible message
   identities by stable cursor;
4. waits for the generation's durable outbox to drain;
5. runs a bounded verification set against canonical counts and fixtures;
6. marks the generation ready and atomically flips WorkspaceDO's pointer; and
7. schedules deletion of the replaced namespace after the rollback window set
   by the team.

Live writes begin immediately. During a rebuild they are projected to the active
generation and recorded for the building generation, so the new namespace does
not become stale while history catches up. Backfill cannot block or roll back a
canonical write.

Repair has three scopes: re-enqueue one source, re-enqueue one destination and
its fragments, or rebuild the workspace namespace. There is no repair that edits
Turbopuffer manually and leaves canonical state unchanged.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| Turbopuffer query timeout/error | Return local client matches plus the remote-search unavailable state |
| Turbopuffer write outage | Canonical write succeeds; outbox and Queue retry; permanent attempts reach the DLQ |
| Queue duplicate or reordering | Deterministic id plus source-version condition makes it a no-op |
| Stale ACL includes revoked caller | WorkspaceDO removes the candidate before response |
| Stale ACL omits newly granted caller | Result is temporarily absent; catch-up state may be shown |
| Schema/index build returns not ready | Keep prior generation active; Workflow retries/blocks the flip |
| Backfill interruption | Workflow resumes from its durable cursor; live projection continues |
| Namespace loss/corruption | Flag off remote search for that workspace and rebuild from canonical sources |
| DLQ non-empty | Notify operations with workspace/source identifiers only; retain repair intent |

The product has no automatic fallback to FTS5, Typesense, or AI Search. Such a
fallback would double write paths and create inconsistent authorization and
ranking precisely during an incident.

## Testing

### Pure tests

- fragment id construction, chunk stability, and source-version comparison;
- Turbopuffer request construction for BM25, prefix, filters, multi-query, and
  `limit.per`;
- response parsing, destination de-duplication, candidate refill, and snippet
  extraction;
- stable versus retryable provider error classification; and
- telemetry redaction: no query or indexed content in events/errors.

### Workers tests

Use real workerd Durable Objects and Queues for:

- canonical commit before outbox publication;
- at-least-once redelivery and old-version rejection;
- current-state authorization with deliberately stale projected ACLs;
- source-version and part-visibility validation with a deliberately stale body
  fragment;
- every result-kind predicate, including inbound email and note-backed resources;
- deletion/tombstone ordering;
- queue failure reaching the DLQ while canonical writes keep succeeding; and
- Global/EU binding selection.

Turbopuffer itself is the external boundary and may be doubled in the regular
suite. A separate provider acceptance job uses isolated test organizations and
random namespaces, then deletes them, following Turbopuffer's own testing
guidance ([testing](https://turbopuffer.com/docs/testing)). It proves schema,
conditional writes, BM25/prefix behavior, `limit.per`, strong reads, and
namespace deletion against the real service.

Every new test is broken once to prove it can fail, per
[`testing.md`](../../testing.md).

## Documents the implementing change updates

- [`data-model.md`](../../data-model.md) — search outbox/generation state and the
  settled personal work-stream authorization rule.
- [`workstream-durable-object.md`](../../workstream-durable-object.md) — source
  projection, Queue, Workflow, and repair invariants.
- [`regionalization.md`](../../regionalization.md) — Turbopuffer organizations,
  credentials, endpoints, and subprocessor boundary.
- [`choosing-sockets-or-rest.md`](../../choosing-sockets-or-rest.md) — the
  point-in-time search `GET`.
- [`telemetry.md`](../../telemetry.md) and
  [`adding-new-instrumented-event.md`](../../adding-new-instrumented-event.md) —
  content-free events.
- [`feature-flags.md`](../../feature-flags.md) — `global-search`.
- [`e2e.md`](../../e2e.md) — visible and regional acceptance.
- [`implementation-plan.md`](../../implementation-plan.md) and the
  [implementation brief](../2026-08-05_avalon-implementation-brief/prd.md) —
  contract wording when search ships.
- a new registered `docs/global-search.md` — the durable architecture and
  running changelog.
