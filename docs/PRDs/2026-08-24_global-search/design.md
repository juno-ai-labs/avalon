# Global search — index and projection design

> Companion to [`prd.md`](prd.md). The product argument is there; this file
> carries the schema, the projection protocol, the query, and the backfill.
> Nothing here is authoritative once the change ships — at that point
> [`data-model.md`](../../data-model.md) owns the schema and a new
> `docs/global-search.md` owns the subsystem, per
> [`module-documents.md`](../../module-documents.md).

## Where the text is today

Search has to reach six kinds of text sitting in three different places, and the
split is what drives the phasing in the PRD's [Rollout](prd.md#rollout).

| Source | Text | Where it lives | Reachable from WorkspaceDO? |
| --- | --- | --- | --- |
| Work stream | `title`, `description`, `preview` | `workspace_workstream_directory` | Yes — same object |
| Automation | template name, version description, subscription label | `automation_templates`, `automation_template_versions`, `automation_subscriptions` | Yes — same object |
| Meeting note | `title`, `manual_notes_markdown`, `live_notes_markdown` | `notes` | Yes — same object |
| Meeting transcript | `text_content` per segment | `note_transcript_segments` | Yes — same object |
| Document name | `title` | `resources` | Yes — same object |
| Document contents | extracted text | R2, via `resources.model_content_ref` | No — object bytes |
| Message | `parts.content`, or R2 via `content_ref_id` | each `SubstreamAgent`'s own SQLite | No — a different object |

Four of the seven rows are local reads inside one Durable Object. That is phase
1, and it needs no new transport at all.

## Schema

Two tables in WorkspaceDO, added through the object schema registry
(`workspace-domain-schema.ts`), beside the directory they join against.

```sql
CREATE TABLE workspace_search_documents (
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'workstream', 'automation', 'note', 'note_segment', 'document', 'message'
  )),
  source_id TEXT NOT NULL,
  -- The row the visibility join runs against. Exactly one is non-NULL, and
  -- which one is a function of source_kind — see the CHECK below.
  workstream_id TEXT,
  note_id TEXT,
  resource_id TEXT,
  automation_subscription_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Recency ranking, and the ordering the sidebar already sorts by.
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  -- Idempotent re-delivery, exactly as workspace_workstream_directory does it:
  -- a replayed projection with a lower waterline or an identical hash is a
  -- no-op rather than a rewrite.
  waterline INTEGER NOT NULL CHECK (waterline > 0),
  payload_hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL CHECK (indexed_at >= 0),
  PRIMARY KEY (source_kind, source_id),
  CHECK (
    (source_kind IN ('workstream', 'message') AND workstream_id IS NOT NULL)
    OR (source_kind IN ('note', 'note_segment') AND note_id IS NOT NULL)
    OR (source_kind = 'document' AND resource_id IS NOT NULL)
    OR (source_kind = 'automation' AND automation_subscription_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX workspace_search_documents_workstream_idx
  ON workspace_search_documents(workstream_id, updated_at DESC)
  WHERE workstream_id IS NOT NULL;

CREATE VIRTUAL TABLE workspace_search_fts USING fts5(
  title,
  body,
  content = 'workspace_search_documents',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);
```

The FTS table is external-content over the documents table, with the same three
`AFTER INSERT` / `AFTER DELETE` / `AFTER UPDATE` triggers `memory_items_fts`
already uses in `0036_scoped_agent_memory.sql`. That pattern is chosen over a
contentless or standalone index because it keeps exactly one copy of the text
and cannot drift from the row it describes.

`title` and `body` are separate FTS columns rather than one concatenated blob so
that ranking can weight a title match above a body match without a second query
— see [Ranking](#ranking).

### Byte bounds

`body` is a near-cap TEXT column and its bound must be written
`length(CAST(body AS BLOB)) <= …`, never `length(body)`. `data-model.md`'s
2026-08-19 changelog entry records why: character-counted `CHECK`s against a
byte-counted platform limit is one of the two defects that audit found across
the object schemas. The bound's *number* is a defensive limit and ships open —
see the PRD's [Limits](prd.md#limits).

## Writing the index

### Phase 1 — text the object already owns

Written inline, in the same transaction as the row it derives from, from the
existing repository writes in `workspace-product-storage.ts` and the domain
schema's tables. No trigger-based mirroring off those tables: a trigger cannot
apply the visibility and content filters (a `system_kind` work stream, a
draft automation, an archived note), and a filter that lives in a trigger is a
filter nobody reviewing the write path will see.

One work stream contributes one row, not several. Its `title`, `description`,
and `preview` concatenate into `body`, which keeps the directory's own
projection the single source of that text.

A meeting note contributes one `note` row for its title and briefing markdown,
plus one `note_segment` row per transcript segment. Segments are separate rows
rather than one concatenated transcript so that a match can carry its own
timestamp and offset into the recording, which is what a snippet needs to be
useful.

### Phase 2a — message text, over the existing outbox

`SubstreamAgent` already publishes facts up to WorkspaceDO through the durable
regional-effect outbox, and `WorkspaceDirectoryApplyRequestSchema` already
admits `directory_common`, `directory_user`, and `suggestion_feedback` in
batches of up to 25 envelopes with waterline ordering, UUIDv7 message identity,
and an accepted/rejected result. A fourth kind, `search_document`, joins them.

The producer filters before it publishes, and this is a security boundary rather
than an optimisation: only `parts` with `visibility IN ('people', 'both')` and
`kind = 'text'` are projected. Tool calls, tool results, terminal output,
reasoning, compaction markers, and admission records never leave the object as
search text, so text a person may not read is never written into a table a
person's query touches.

A message whose `content` is `NULL` because it spilled to `content_ref_id` is
projected from the R2 object at publish time, truncated to the indexed-character
bound. A message that is edited republishes with a higher waterline; a deleted
work stream cascades its rows through the directory row they hang off.

Why not a queue, an RPC, or a crawl:
[`choosing-queues-or-rpc.md`](../../choosing-queues-or-rpc.md) prefers a queue
for a hop like this, and this hop already *has* one — reusing it inherits
ordering, retry, backoff, and idempotency that are already proven by the
directory rows search joins against. Building a second path beside it would be
reinventing one mechanism inside the other, which that document forbids by name.

### Phase 2b — document contents

Extraction already produces model-ready text and records its completion:
`resources.model_content_status` moves to `ready`, with
`model_content_character_count`, `model_content_extractor_version`, and
`model_content_extracted_at` beside it. Indexing hooks that transition, reading
the derivative once and writing one `document` row.

This means the index inherits extraction's existing coverage exactly — a
`failed` or `unsupported` resource has no content row and is still findable by
name — and that a re-extraction at a new extractor version reindexes through the
same path with a higher waterline.

## Reading the index

One `GET /search?q=…` under the ordinary session auth, answered by the Worker
delegating to WorkspaceDO. REST rather than a socket topic, per
[`choosing-sockets-or-rest.md`](../../choosing-sockets-or-rest.md): a person
explicitly went looking for it, and nobody else's screen depends on the answer.

### Query construction

The caller's text goes through the token-and-quote sanitizer
`memory-service.ts` and `memory-table-service.ts` already share — NFKC
normalise, extract `[\p{L}\p{N}_-]+` runs, lowercase, dedupe, quote each token
with `"` doubled — so that FTS5 operators in a caller's string are data rather
than syntax.

**One deliberate difference from the memory sanitizer: terms join with `AND`,
not `OR`.** Memory search wants recall — it is feeding a model that will judge
the results. A search box wants the opposite: typing a second word must narrow
the list, or the surface behaves as though it is ignoring what the person types.
This is worth a shared helper with an explicit conjunction parameter rather than
a copied function, so the difference is visible at both call sites.

The trailing token is additionally matched as a prefix (`token*`), so results
converge while the person is still typing the last word rather than only after
they finish it.

### The visibility join

The filter is a `JOIN`, not a post-filter, and it is in the same statement as
the `MATCH` — the PRD's [Security and trust model](prd.md#security-and-trust-model)
rule 2 exists because a filter applied after ranking leaks through the result
count.

```sql
SELECT d.source_kind, d.source_id, d.title, d.updated_at,
       bm25(workspace_search_fts, 10.0, 1.0) AS rank
  FROM workspace_search_fts f
  JOIN workspace_search_documents d ON d.rowid = f.rowid
  LEFT JOIN workspace_workstream_directory wd
         ON wd.workstream_id = d.workstream_id
  LEFT JOIN workspace_workstream_viewers wv
         ON wv.workstream_id = d.workstream_id AND wv.user_id = ?1
  LEFT JOIN notes n ON n.id = d.note_id
 WHERE workspace_search_fts MATCH ?2
   AND (
     -- Work streams and their messages: the flag the sidebar list uses.
     (d.workstream_id IS NULL)
     OR (wv.listable = 1 AND wd.archived_at IS NULL AND wd.system_kind IS NULL)
   )
   AND (
     d.note_id IS NULL
     OR n.archived_at IS NULL
     AND (n.scope = 'workspace' OR n.owner_user_id = ?1)
   )
 ORDER BY rank, d.updated_at DESC
 LIMIT ?3;
```

Documents (`resource_id`) go through the existing resource access check rather
than an inline predicate, because that check already exists as
`WorkspaceDirectoryResourceAccessRequest` and duplicating its rule inline is how
the two drift apart. Automations filter on their subscription's owner-or-workspace
scope the same way.

`system_kind IS NOT NULL` rows — digest occurrences — are excluded outright: they
are machinery assembled from one person's activity, and they are already hidden
from the sidebar unless Debug is on.

### Ranking

`bm25(workspace_search_fts, 10.0, 1.0)` weights the `title` column ten times the
`body` column, which is what makes a work stream called *Launch* outrank a
message that mentions launching. Recency breaks ties through `updated_at DESC`,
matching how the sidebar already orders itself, so search and the sidebar do not
disagree about which of two equally-good matches is "the" one.

The top hit is the first row of the merged, ranked set across all groups — not
the first row of the first group — so that a strong message match can win over a
weak title match.

Per-group truncation to five happens after ranking, and the `N MORE RESULTS`
count is the count of the same filtered statement without the `LIMIT`. Counting
the unfiltered set would leak; counting a differently-filtered set would be a
second copy of the authorization rule.

## Backfill

Nothing blocks on it. An unindexed work stream is still findable by name from the
client-side directory match, which is what makes a gradual backfill an acceptable
intermediate state rather than a broken surface.

Phase 1's sources are backfilled inside WorkspaceDO's existing maintenance pass
on its own alarm, bounded per wake, resumable from the last `(source_kind,
source_id)` — the same shape the workspace's other maintenance targets use in
`workspace-schedule-execution.ts`. It is a local read and a local write in one
object, so it needs no coordination.

Phase 2a's backfill is the expensive one: every existing `SubstreamAgent` must
walk its `parts` and publish. It rides the same outbox as live projection, paced
by the object's own alarm, and it is the reason the retention horizon in the
PRD's [Open questions](prd.md#open-questions) needs an answer first — the
backfill is where the index's eventual size is decided in one go.

## Testing

Per [`testing.md`](../../testing.md), the default is the real pipeline and the
split follows what each suite can prove:

- **`apps/api/test-workers/`** — the projection: an effect envelope applied
  twice lands once; a lower waterline is ignored; a cascade removes a work
  stream's message rows; the outbox's ordering holds under a replayed batch.
  These are Durable Object storage and RPC semantics, so they run on real
  workerd.
- **Node suite, against the checked-in migrations** — the query: the visibility
  join, the FTS5 `MATCH` semantics, `AND` versus `OR` conjunction, prefix
  matching on the trailing token, `bm25` column weighting, and the count. A
  constraint and a query are proved against a real schema, not a stub.
- **A test per authorization rule, written to fail first.** The rule 1 tests in
  the PRD's [Acceptance](prd.md#acceptance) are the ones most worth breaking the
  code under: delete the `wv.listable = 1` predicate and the personal-work-stream
  test must fail *for that reason*. An authorization test that survives the
  removal of the check it names is asserting on a fixture.
- **A real window** for the glyph, the overlay, and the keyboard model, captured
  and read per
  [`dev-environment.md`](../../dev-environment.md#driving-and-screenshotting-it).
  A component test cannot say whether the glyph collides with the traffic lights.

## Documents this change updates

- [`data-model.md`](../../data-model.md) — the two new WorkspaceDO tables and
  what decides who may read a row.
- [`workstream-durable-object.md`](../../workstream-durable-object.md) — the
  fourth effect kind on the regional-effect outbox.
- [`choosing-sockets-or-rest.md`](../../choosing-sockets-or-rest.md) — `GET
  /search` as a worked example of a read that is deliberately not a push.
- [`telemetry.md`](../../telemetry.md) and the event registry — the three events.
- [`feature-flags.md`](../../feature-flags.md) — the `global-search` client flag.
- [`e2e.md`](../../e2e.md) — the acceptance flows that become durable checks.
- [the implementation brief](../2026-08-05_avalon-implementation-brief/prd.md) —
  the contract clause, per the PRD's
  [Impact on the product contract](prd.md#impact-on-the-product-contract).
- A new `docs/global-search.md`, registered in
  [`docs/README.md`](../../README.md), once the subsystem exists.
