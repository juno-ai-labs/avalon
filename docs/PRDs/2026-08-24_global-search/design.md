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
| Automation | template name and overview | `automation_templates`, `automation_template_versions` | Yes — same object |
| Meeting note | `title`, `manual_notes_markdown`, `live_notes_markdown` | `notes` | Yes — same object |
| Meeting transcript | `text_content` per segment | `note_transcript_segments` | Yes — same object |
| Document name | `title` | `resources` | Yes — same object |
| Document contents | extracted text | R2, via `resources.model_content_ref` | No — object bytes |
| Message | `parts.content`, or R2 via `content_ref_id` | each `SubstreamAgent`'s own SQLite | No — a different object |

**Five** of the seven rows are local reads inside one Durable Object. That is
phase 1, and it needs no new cross-object transport. Only document *contents*
and message bodies live elsewhere.

One correction to a natural assumption, because it changes the phase-1 write
path: a work stream's title and description reach WorkspaceDO *over the
directory outbox* already, through `applyDirectoryEnvelope` (`workspace-do.ts`).
That envelope updates canonical directory state; it does **not** update search
in the same transaction. After the directory transaction commits, the handler
marks the work-stream result dirty in the coalescing search outbox. The indexer
later re-reads the directory row. Locality removes a transport hop, not the
failure boundary between authority and derived index.

## Where the tables go

**Not by appending to `WORKSPACE_DOMAIN_SCHEMA_STATEMENTS`.** That array is
spread into **version 1** of `WORKSPACE_DO_SCHEMA_MIGRATIONS`
(`workspace-do.ts`), and version 1's statements are hashed into every deployed
object's `_sql_schema_migrations` receipt. `sqlite-migrations.ts` re-hashes on
wake and throws `workspace_do_schema_hash_mismatch:1`; the file says so in its
own words beside the array. Appending the search table statements there takes
every existing workspace's Durable Object down on its next wake, in both
regions — a total outage, not a degraded search.

The derived tables land as a **new version entry** in
`WORKSPACE_DO_SCHEMA_MIGRATIONS` (the object is at version 9, so version 10),
which is the same route `SLACK_REACTION_COLUMN_STATEMENTS` took. They must also
be added to `WORKSPACE_LOCAL_TABLES` in `workspace-runtime-database.ts`, though
**not** for the reason it is tempting to give: the routing port does not fail
closed on an unregistered table. `if (localTables.length === 0) return false;`
sends such a statement to regional D1, where it dies as `no such table`; only an
unregistered *write target* throws. The join query names `notes` and `resources`
and so routes locally either way, but search-only statements — fragment
replacement, outbox drain, checkpoint advance, repair, and deletion — would
silently go to D1. That is the reason to register them.

## Schema

```sql
CREATE TABLE workspace_search_documents (
  source_type TEXT NOT NULL CHECK (source_type IN (
    'workstream', 'automation', 'note', 'note_segment', 'document', 'message'
  )),
  source_id TEXT NOT NULL,
  -- The thing the palette opens. Many physical fragments may share it.
  result_type TEXT NOT NULL CHECK (result_type IN (
    'workstream', 'automation', 'note', 'document'
  )),
  result_id TEXT NOT NULL,
  -- The row the authorization join runs against, named by source_type:
  -- workstream/message -> workstream_id, note/note_segment -> note_id,
  -- document -> resource_id, automation -> automation_subscription_id.
  --
  -- One column rather than four nullable ones. Four columns cannot express
  -- "exactly one is set" in a CHECK without asserting the other three NULL in
  -- every arm, and a row that slipped through with two set would be routed by
  -- whichever arm the WHERE tested first — silently hiding a row from someone
  -- who may read it, or worse. NOT NULL because a row with no scope key has no
  -- authorization join, and there is no safe default to invent for it.
  scope_id TEXT NOT NULL,
  -- Search accepts every title the canonical model accepts. There is no
  -- search-specific title CHECK. If a derived-copy bound is later required,
  -- normalize/truncate before this write and leave the authority untouched.
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Recency ranking, and the ordering the sidebar already sorts by.
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  -- Assigned by the source authority's coalescing outbox after the canonical
  -- commit. All fragments in one replacement carry the same compound version.
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (source_type, source_id)
) STRICT;

CREATE INDEX workspace_search_documents_scope_idx
  ON workspace_search_documents(source_type, scope_id);

CREATE INDEX workspace_search_documents_result_idx
  ON workspace_search_documents(result_type, result_id);

-- Version fences survive deletion even though searchable text does not.
CREATE TABLE workspace_search_versions (
  version_kind TEXT NOT NULL CHECK (version_kind IN ('source', 'result')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  version INTEGER NOT NULL CHECK (version > 0),
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  payload_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (version_kind, entity_type, entity_id)
) STRICT;

CREATE VIRTUAL TABLE workspace_search_fts USING fts5(
  title,
  body,
  content = 'workspace_search_documents',
  content_rowid = 'rowid',
  tokenize = 'unicode61',
  -- NO prefix index. Every request prefix-matches its trailing token, so one
  -- looks obviously right. The decisive reason is structural rather than
  -- measured, and anyone can check it: FTS5 consults a prefix index only for
  -- prefixes of *exactly* a configured length. `prefix='2 3'` therefore serves
  -- a 2- or 3-character trailing token and does nothing whatever from the
  -- fourth character on — while its cost is paid on every projection write, for
  -- every message ever indexed, against the 10 GB ceiling this design already
  -- worries about. Since the product floor for a remote request is 2
  -- characters, it buys the first two keystrokes of a query's life.
  --
  -- Timings that agree with that, offered as corroboration rather than as the
  -- argument, and reproducible in ~30 lines of `node:sqlite`: build two
  -- in-memory indexes of 20,000 documents (~40 words each) over this DDL, one
  -- with `prefix='2 3'` and one without, then time `MATCH '"xx"*'` and
  -- `MATCH '"xxxx"*'` over 40 iterations and read shadow-table sizes from
  -- `dbstat`. Observed: 2.75ms -> 0.79ms at two characters, 2.65ms -> 2.83ms at
  -- four (i.e. no help), 2.6x the FTS index on disk, ~87% more write time.
  --
  -- If profiling later shows short queries dominate, the sizes to add are a
  -- decision with arithmetic behind it, not a default.
);

-- Logical shape; the source-object implementation uses the same columns and a
-- source-appropriate table name. One row per canonical source entity is the
-- coalescing contract: autosaves overwrite this row rather than append work.
CREATE TABLE workspace_search_outbox (
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  result_type TEXT NOT NULL,
  result_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  target_generation INTEGER NOT NULL CHECK (target_generation > 0),
  target_version INTEGER NOT NULL CHECK (target_version > 0),
  result_generation INTEGER NOT NULL CHECK (result_generation > 0),
  result_version INTEGER NOT NULL CHECK (result_version > 0),
  not_before INTEGER NOT NULL CHECK (not_before >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased')),
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (source_type, source_id)
) STRICT;

CREATE INDEX workspace_search_outbox_due_idx
  ON workspace_search_outbox(status, not_before);

CREATE TABLE workspace_search_index_state (
  source_type TEXT PRIMARY KEY,
  index_generation INTEGER NOT NULL CHECK (index_generation > 0),
  status TEXT NOT NULL CHECK (status IN (
    'ready', 'backfilling', 'repairing', 'failed'
  )),
  checkpoint TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  last_error TEXT
) STRICT;
```

The index on `(source_type, scope_id)` supports authorization-parent cleanup;
the result index replaces or removes all fragments for one visible destination
and is the key the query de-duplicates on. `workspace_search_versions` is not an
index of product data: it is the small fence that lets an apply reject an older
source replay after its text row was deleted, and lets a parent result tombstone
reject a late child fragment.
There is deliberately no `(scope_id, updated_at DESC)` index: the query enters
`workspace_search_documents` by rowid from the FTS match and never looks a
document up by scope, and `ORDER BY` runs over a computed `bm25()` that no index
can satisfy — such an index would be write amplification on every projection for
zero reads.

### The FTS sync triggers

External-content FTS5 keeps one copy of the text and cannot drift from the row
it describes. It needs three triggers, and **they are not copyable from
`memory_items_fts`**: that index has one column, so its update trigger is
`AFTER UPDATE OF text`. This one has two.

```sql
CREATE TRIGGER workspace_search_fts_insert
AFTER INSERT ON workspace_search_documents BEGIN
  INSERT INTO workspace_search_fts(rowid, title, body)
  VALUES (NEW.rowid, NEW.title, NEW.body);
END;

CREATE TRIGGER workspace_search_fts_delete
AFTER DELETE ON workspace_search_documents BEGIN
  INSERT INTO workspace_search_fts(workspace_search_fts, rowid, title, body)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.body);
END;

CREATE TRIGGER workspace_search_fts_update
AFTER UPDATE OF title, body ON workspace_search_documents BEGIN
  INSERT INTO workspace_search_fts(workspace_search_fts, rowid, title, body)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.body);
  INSERT INTO workspace_search_fts(rowid, title, body)
  VALUES (NEW.rowid, NEW.title, NEW.body);
END;
```

`AFTER UPDATE OF title, body` — not `AFTER UPDATE OF body`, which leaves a
renamed work stream findable only by its old name, and not a bare `AFTER UPDATE`,
which re-tokenizes the whole body every time a bookkeeping column moves. The
`'delete'` command must be handed the values that were actually indexed; handing
it anything else raises `SQLITE_CORRUPT` on an ordinary write.

The live precedent is `workspace-domain-schema.ts`, **not**
`0036_scoped_agent_memory.sql` — migration `0090_drop_legacy_product_tables.sql`
drops both memory FTS tables and their six triggers from D1, so that migration
is dead code for this purpose.

### Writes are UPDATE-then-INSERT, never `INSERT OR REPLACE`

`PRAGMA recursive_triggers` is off by default, and SQLite fires `AFTER DELETE`
triggers on `INSERT OR REPLACE` only when it is on. So the natural idempotent
upsert against a composite primary key **skips the FTS delete**, orphaning the
old index entry under a rowid the row no longer occupies. SQLite's own
`integrity-check` passes; nothing reports it. Once that rowid is reused by an
unrelated row, the orphaned terms resolve to a row the searcher *can* see — a
content-existence disclosure that the visibility join cannot catch, because the
join runs against the innocent row.

Every projection therefore writes `UPDATE … WHERE source_type = ? AND source_id = ?`
and falls back to `INSERT` when no row was changed, or uses
`INSERT … ON CONFLICT(source_type, source_id) DO UPDATE SET …`, both of which
fire the update trigger.

### Derived-text bounds, not canonical title limits

The search schema has **no title-length `CHECK`**. Avalon currently accepts
work-stream titles through several write paths with different character bounds,
and this PRD is not authority to choose a new system-wide invariant. A search
projection must accept whatever the canonical path accepted. If FTS storage
later needs a bound, `normalizeSearchText` truncates only the derived index value
and leaves the canonical title untouched; UI ellipsis is presentation, not
validation.

Message/document bodies do need a finite derived-fragment byte bound before
implementation, for the reasons and decision handoff in the PRD's
[Limits](prd.md#limits). It is enforced in the indexer before batching and
storage, not in the canonical transaction. Truncation is measured in UTF-8 bytes
and lands on a code-point boundary. Truncating to N characters and then checking
N bytes would reject Japanese or emoji-bearing text at three or four bytes per
character. If normalization or indexing fails, the outbox remains repairable and
the canonical write remains successful.

## Writing the index

### Phase 1 — text the object already owns

Every source follows the same order, including sources already stored inside
WorkspaceDO:

1. The canonical service commits its transaction and determines success without
   touching a search table.
2. After that commit, `markSearchDirty` upserts a durable outbox row keyed by
   `(source_type, source_id)`. It records the newest source version, destination
   identity, operation, and `not_before`. A repeated write updates that row and
   moves `not_before`; it never appends one operation per autosave.
3. Failure to record the outbox row is logged and leaves the canonical response
   successful. The next repair scan compares canonical versions/hashes with the
   derived rows and re-enqueues the gap. There is deliberately a small
   post-commit crash window because making search atomic with the authority
   would reverse their importance.
4. Once eligible, the alarm leases a bounded batch, re-reads each entity's
   latest canonical value, derives fragments, and applies the batch in a search
   transaction. Only after that transaction commits is the leased work removed.

This outbox is not a second authority. It may be discarded and regenerated from
canonical rows. It exists to make debounce/coalescing durable and to survive an
object sleeping between a successful write and indexing.

- **Work stream** — one row. `title`, `description`, and `preview` concatenate
  into `body`; `scope_id`, `result_id`, and the source id are the work-stream id.
- **Automation** — one row per *subscription*, with the text joined out from
  `automation_templates.name` and `automation_template_versions.overview`.
  Subscriptions carry no name of their own, which is why the sidebar's own read
  joins to the template. Two subscriptions of one template are two rows with the
  same text and different `scope_id`, because they have different audiences.
- **Meeting note** — one `note` row for the title and briefing markdown, plus
  one `note_segment` row per transcript segment, so a match can carry its own
  offset into the recording. Every row carries the note id as `result_id`. A
  segment row's `title` is the empty string, not the note's title: copying the
  note title onto 720 segments would index it 720
  times at the 10× title weight and flood the group with one meeting.
- **Document** — one `document` row for the title, at upload or hydration.
  **`resource_type = 'note'` is excluded.** Every note is backed by a `resources`
  row (`note-service.ts` inserts one with `provider = 'avalon_note'` and
  `model_content_status = 'ready'` at INSERT), so without this exclusion a
  personal note's title and full markdown reappear as a `document` row under a
  different authorization rule — the leak acceptance test exists to catch.

### Phase 2a — message text, coalesced before batched transport

Message text is authoritative in `SubstreamAgent`, so that object owns the
message search outbox. The outbox is keyed by the canonical part/message id and
uses one monotonic projection key per source entity. A create, edit, or delete
first commits to the transcript tables; only afterward does it upsert
`target_version` and `not_before`. Ten edits to one message during the
debounce window therefore leave one pending row whose drain reads the tenth
version. A delete overwrites an earlier pending upsert with a tombstone. The
payload also carries the current compound work-stream result version so a
destination deletion or archive can fence late child deliveries.

The eligible drain reads multiple latest canonical entities at once, filters
them, and constructs **batches** under both the chosen entity-count bound and
the queue's published 128 KB message ceiling. It publishes a
`search_index_batch` message through the existing regional `ACTIVITY_QUEUE`;
search does not add a second regional-content queue. One queue message carries
many fragment upserts/tombstones, and the regional consumer groups messages for
the same workspace into one bounded WorkspaceDO apply call. Queue delivery is
at-least-once and unordered, so every fragment carries
`(source_generation, source_version, payload_hash)` plus
`(result_generation, result_version)`. The receiver compares
`workspace_search_versions` and applies these rules in one transaction per
batch:

- older compound version: ignore;
- equal version and equal hash: acknowledge as an idempotent replay;
- equal version and different hash: record divergence and enqueue repair;
- newer version: replace the fragment through `UPDATE`/`INSERT`;
- newer tombstone: delete the fragment; a parent work-stream tombstone deletes
  every row sharing its result identity and leaves a result-level version fence;
- child upsert at or below a result-level delete fence: ignore, even if the
  child itself had not arrived when the parent tombstone was applied.

The producer filters before it publishes, and that is a security boundary rather
than an optimization. The line is the one the transcript read itself applies:
`substream_id = '0' AND visibility IN ('people', 'both')`. **Both halves
matter.** Omitting the substream clause publishes people-visible parts from an
`audience = 'owner'` substream — a private side-conversation rendered to nobody
in the transcript — into an index every member of that work stream can search.
And `kind = 'text'` alone is *narrower* than the product's line: `attachment`
and `steer_request` parts with `people` visibility are shown to people, and
`structured_content_json` carries elicitation and suggestion content. The
projection matches the transcript's rule, then excludes the kinds the PRD's
non-goal 8 names.

Part visibility is immutable in the current product. If a later change makes it
narrowable, that change must give the search read a current canonical predicate;
an asynchronous cleanup alone would make authorization eventually consistent
and is therefore not acceptable.

A message whose `content` spilled to `content_ref_id` cannot be read from R2 in
the canonical transaction, which is another reason indexing is downstream.
Nothing writes that state today: `content_ref_id` and `content_refs` have no
writer, and `parts.content` is bounded at 256 KiB. Index what is in `content`
now; when a spill writer is introduced, its post-commit derivative step becomes
the canonical reader for this same outbox contract.

### Phase 2b — document contents

Extraction records completion by moving `resources.model_content_status` to
`ready`. After that canonical state commits, it upserts the resource's search
outbox row. The later drain reads the latest derivative, normalizes/truncates
only the derived index copy, and updates the existing `document` fragment.
Extraction failure and index failure are independent: neither changes the
successful resource write, and a later extraction or repair can enqueue the
resource again.

**The `resource_type = 'note'` exclusion is restated here, and it is
load-bearing.** It is tempting to argue the hook cannot fire for a note-backed
resource because the row is born `ready` at INSERT — that is false.
`note-service.ts`'s `materialize()` runs `UPDATE resources SET …
model_content_status = 'ready'` and is called from seven sites: every note
update, every transcript-segment append, every briefing generation. So the hook
fires for notes routinely. Combined with the derived upsert rule — update, and
`INSERT` when no row changed — a phase-2b drain without the exclusion *creates*
the `document` row phase 1 declined to write, carrying the note's full briefing
and transcript under the document rule instead of the note one. That is
the note-backed-resource leak, reintroduced by the half of the pipeline that was
not told about the exclusion.

Extraction is also **lazy and caller-triggered** — `materializeAttachmentDerivative`
runs when a person previews a resource or an agent tool reads it, and nothing
schedules it — so an uploaded file nobody has opened stays `pending` and is
findable by title only.

### The async contract, stated as invariants

1. Canonical workspace state commits first and is authoritative.
2. A post-commit outbox event is durable once recorded, but failure to record it
   cannot alter the canonical response; reconciliation repairs the crash window.
3. Index workers run later, after the debounce window, and consume bounded
   batches rather than one delivery per fragment.
4. Retry and queue redelivery are idempotent by compound source version and
   payload hash.
5. Creates, updates, archives, and deletes all enter the same path; deletes
   travel as versioned tombstones. A future source-level authorization mutation
   must also add a current query-time predicate rather than rely on index delay.
6. Search may be incomplete or briefly stale. The response exposes only
   `indexState: ready | catching_up`, never a guessed completion time. Current
   authorization is still evaluated at query time.
7. A targeted repair can re-enqueue a source entity or destination, and a full
   rebuild can discard every derived row and regenerate it from canonical
   sources using resumable checkpoints.

## Reading the index

One `GET /search?q=…` under the ordinary session auth, answered by the Worker
delegating to WorkspaceDO. REST rather than a socket topic, per
[`choosing-sockets-or-rest.md`](../../choosing-sockets-or-rest.md): a person
explicitly went looking for it, and nobody else's screen depends on the answer.
The response is point-in-time and carries `indexState: ready | catching_up`.
Each indexed group returns `items` and `hasMore`; there is no `totalMatches`
field anywhere in the contract.

### Query construction

The caller's text goes through the token-and-quote sanitizer that
`memory-service.ts` and `memory-table-service.ts` each hold a **byte-identical
private copy** of — NFKC normalise, extract `[\p{L}\p{N}_-]+` runs, lowercase,
dedupe, quote with `"` doubled. Nothing is shared today, so extracting a module
and re-pointing both existing call sites is part of this change, not a parameter
addition. Note the existing copies also hard-cap at 96 tokens; the shared helper
must make that interaction explicit against the PRD's 200-character request
boundary rather than retaining a second silent cap.

Three changes from the memory copies, each load-bearing:

1. **Terms join with `AND`, not `OR`.** Memory search wants recall — it feeds a
   model that will judge the results. A search box wants the opposite: a second
   word must narrow the list.
2. **Separator-only tokens are dropped.** The capture class includes `-` and
   `_`, but `unicode61` classifies both as separators, so a token of only those
   characters tokenizes to an **empty phrase** that matches nothing and raises no
   error. Harmless under `OR`, fatal under `AND`: a search for `Q3 - roadmap`
   emits `"q3" AND "-" AND "roadmap"*` and returns zero rows while the *Q3
   roadmap* work stream sits in the index.
3. **The trailing token is prefixed as `"token"*` — star outside the quotes.**
   Inside the quotes (`"token*"`) the `*` is fed to `unicode61`, which discards
   it, silently producing an exact-match query. That is not a style choice:
   `"launchpa*"` returns nothing while `"launchpa"*` returns `launchpad`, so the
   wrong form empties the result list mid-word.

### The visibility join

Every source kind gets a predicate, and the predicates are inside the same
statement as the `MATCH`. A `CASE` over `source_type` rather than a chain of
`OR`s, because `CASE` is exhaustive and fails closed: a source kind added later
with no arm returns `NULL` and is excluded, where an `OR` chain of
`(scope_id IS NULL) OR (…)` guards admits it unconditionally.

```sql
SELECT source_type, source_id, result_type, result_id, scope_id,
       result_title, updated_at, rank
  FROM (
    SELECT m.*,
           ROW_NUMBER() OVER (
             PARTITION BY m.result_type, m.result_id
             ORDER BY m.rank, m.updated_at DESC, m.source_id
           ) AS evidence_rank
      FROM (
        SELECT d.source_type, d.source_id, d.result_type, d.result_id,
               d.scope_id,
               CASE d.result_type
                 WHEN 'workstream' THEN wd.title
                 WHEN 'note' THEN n.title
                 WHEN 'document' THEN r.title
                 WHEN 'automation' THEN t.name
               END AS result_title,
               d.updated_at,
               bm25(workspace_search_fts, 10.0, 1.0) AS rank
          FROM workspace_search_fts f
          JOIN workspace_search_documents d ON d.rowid = f.rowid
          LEFT JOIN workspace_workstream_directory wd
                 ON d.source_type IN ('workstream', 'message')
                AND wd.workstream_id = d.scope_id
          LEFT JOIN workspace_workstream_viewers wv
                 ON wv.workstream_id = wd.workstream_id
                AND wv.user_id = ?1
                AND wv.authority_generation = wd.authority_generation
          LEFT JOIN notes n
                 ON d.source_type IN ('note', 'note_segment') AND n.id = d.scope_id
          LEFT JOIN resources r
                 ON d.source_type = 'document' AND r.id = d.scope_id
          LEFT JOIN connector_connections cc ON cc.id = r.connection_id
          LEFT JOIN automation_subscriptions s
                 ON d.source_type = 'automation' AND s.id = d.scope_id
          LEFT JOIN automation_templates t ON t.id = s.template_id
         WHERE workspace_search_fts MATCH ?2
           AND d.result_type = ?4
           AND CASE d.source_type
             WHEN 'workstream'   THEN <workstream_visible>
             WHEN 'message'      THEN <workstream_visible>
             WHEN 'note'         THEN <note_visible>
             WHEN 'note_segment' THEN <note_visible>
             WHEN 'document'     THEN <document_visible>
             WHEN 'automation'   THEN <automation_visible>
           END
      ) m
  )
 WHERE evidence_rank = 1
 ORDER BY rank, updated_at DESC, result_id
 LIMIT 51;
```

The statement is executed once for each requested indexed group; mixed mode
runs those statements in one database batch. Fifty rows are candidates and row
51 is only a sentinel. The server drops the sentinel and returns
`hasMore: true`; if it does not exist, `hasMore` is false. The statement never
counts beyond that boundary.

**Three levels, and the nesting is not stylistic.** SQLite refuses `bm25()` in
the select list of any query level that also carries a window function —
`unable to use function bm25 in the requested context`. A window query
materialises its source rows into an ephemeral sorter before the select-list
expressions are evaluated, by which point the FTS5 cursor is gone. `bm25()` is
therefore computed innermost, the window chooses the best evidence fragment per
destination one level out, and the outer query applies the product cap. The
full `body` is deliberately absent from this candidate pass, so matching a large
document does not carry every authorized body through the sorter. A second
bounded statement fetches up to three evidence fragments for only the returned
destination ids, reapplying the same visibility predicate in the same read
transaction.

The four predicates are:

```
<workstream_visible> =
      wd.workstream_id IS NOT NULL
  AND wd.archived_at IS NULL
  AND (?3 = 1 OR wd.system_kind IS NULL)
  AND (wd.scope = 'workspace' OR wv.is_participant = 1)

<note_visible> =
      n.id IS NOT NULL
  AND n.archived_at IS NULL
  AND (n.scope = 'workspace' OR n.owner_user_id = ?1)

<automation_visible> =
      s.id IS NOT NULL
  AND t.archived_at IS NULL
  AND s.lifecycle_state = 'visible'
  AND (s.scope = 'workspace' OR s.owner_user_id = ?1)

<document_visible> =
      r.id IS NOT NULL
  AND (cc.id IS NULL OR cc.scope = 'workspace' OR cc.owner_user_id = ?1)
  AND (r.provider != 'avalon_upload' OR r.attachment_status = 'attached'
       OR r.uploaded_by_user_id = ?1)
  AND (r.provider != 'avalon_note' OR EXISTS (
        SELECT 1 FROM notes note_visibility
         WHERE note_visibility.resource_id = r.id
           AND note_visibility.archived_at IS NULL
           AND (note_visibility.scope = 'workspace'
                OR note_visibility.owner_user_id = ?1)))
  -- The inbound-email rule below expresses all of the alternatives that
  -- canReadInboundEmailResource admits, not just the participant one.
  AND (r.provider != 'resend' OR r.resource_type != 'email' OR EXISTS (
        SELECT 1 FROM workspace_workstream_resource_links l
          JOIN workspace_workstream_directory ed
            ON ed.workstream_id = l.workstream_id
          LEFT JOIN workspace_workstream_viewers ev
            ON ev.workstream_id = l.workstream_id AND ev.user_id = ?1
           AND ev.authority_generation = ed.authority_generation
          LEFT JOIN automation_subscriptions es
            ON es.id = ed.automation_subscription_id
         WHERE l.resource_id = r.id
           AND ed.archived_at IS NULL
           AND (ed.automation_subscription_id IS NULL
                OR es.scope = 'workspace'
                OR es.owner_user_id = ?1
                OR ev.is_participant = 1)))
```

`<document_visible>` is **four** fragments, not three, and the fourth is the one
most easily lost. `resource-service.ts` applies connector scope, the
draft-upload rule, and the note-backed rule as SQL — and then applies
`canReadInboundEmailResource` separately, per row. That function's early
`return true` for anything that is not `provider = 'resend'` *and*
`resource_type = 'email'` is a guard clause, not evidence that it does nothing:
for an inbound email it runs the whole rule. Drop it and every one of the first
three fragments passes an email row vacuously — `cc.id IS NULL`,
`provider != 'avalon_upload'`, `provider != 'avalon_note'` — so an email sent to
a member's *personal* automation address becomes searchable, by subject and
body, for every member of the workspace.

Its SQL form in `resource-service.ts` cannot be lifted: it joins
`workstream_resources` and `workstreams`, which are WorkstreamDO tables that
WorkspaceDO does not have. The arm above is written over the WorkspaceDO-local
link and viewer tables that `resourceAccess` already uses, so it is a join after
all — just one that has to be written rather than reused.

**It is deliberately narrower than the rule it stands in for, and that is a
decision rather than an oversight.** `canReadInboundEmailResource` admits a row
if *any* link satisfies one of four alternatives: the link has no automation
subscription at all; the subscription is `workspace`-scoped; the caller owns it;
or the caller is a participant. The arm above keeps only the last. So an email
linked to a work stream with no subscription, or to a `workspace`-scoped one, is
readable through `GET /resources/:id` and **not** findable through search. It
also omits the `archived_at IS NULL` test `resourceAccess` applies.

Narrow fails closed, so this is false negatives rather than a leak — but PRD
security rule 1 says every result passes *the same* check as opening the thing,
and this quietly breaks it in the other direction. Two honest options, and the
PRD should carry whichever is taken the way non-goal 15 carries the draft-upload
divergence: express the full four-way rule over the same local tables, which is
more join but no new authority; or state plainly that search takes a narrower
form here and why. **This design takes the first**, because "same check" is
easier to keep true than "narrower in a documented way", and because the
participant-only reading is the one a future reader would most likely mistake for
the whole rule — exactly the mistake that lost this fragment once already.

**The draft-upload rule exists in two non-equivalent forms and this picks one.**
`UPLOAD_RESOURCE_VISIBILITY_SQL`, used by the single-resource read, ends
`OR r.uploaded_by_user_id = ?`; the list path inlines the same predicate
*without* that arm, so the picker hides a person's own unattached drafts from
them. The arm above takes the read-one form, because search's job is to find
what you can open and you can open your own draft. That is a divergence from the
picker, which non-goal 16 has to resolve deliberately rather than by whichever
fragment a shared helper happens to lift.

Four corrections this encodes, each of which was a defect in the first draft of
this design:

- **Documents and automations previously had no predicate at all.** With a
  `scope_id IS NULL` style guard they satisfied every arm and were returned to
  every member — every uploaded file and every personal automation in the
  workspace, by name. Deferring them to a post-query call could not fix it:
  `WorkspaceDirectoryResourceAccessRequest` takes one resource id per call, so
  it cannot be a join predicate, and it is not the document read rule anyway —
  its only caller returns `true` immediately for anything that is not an inbound
  email. The real rule is three SQL fragments in `resource-service.ts`, over
  tables in this same database.
- **`wv.listable` is the wrong flag.** It is not what the sidebar list applies —
  the list uses `(scope = 'workspace' OR is_participant = 1)` — and `listable`
  is computed through `participantVisible`, which also admits
  `created_by_user_id`. Using it would surface a `personal` work stream's
  messages to a creator who left, whom the socket and the sidebar both refuse.
  See the PRD's [open question 2](prd.md#open-questions), which this design no
  longer pre-empts: the predicate above is the sidebar's rule, and it is written
  in one fragment so that the answer, when the team gives it, changes one place.
- **The viewer join needs `authority_generation`.** Every sibling join in the
  object pins it. Without it a superseded viewer row — one the generation bump
  left behind and every other query treats as absent — is the row search trusts.
- **`system_kind` is a parameter, not a constant.** Every other work-stream read
  threads the client's Debug preference through as `includeSystem`. Hard-coding
  `IS NULL` makes search the only read that disagrees, visibly: with Debug on,
  digest rows appear in the palette's **Recent** group and vanish on the first
  keystroke.

The `notes` and `resources` joins are `LEFT` with an `IS NOT NULL` test in the
predicate rather than `INNER`, because one statement carries all six kinds; the
explicit test is what makes a missing parent fail closed instead of vacuously
true.

### Ranking

`bm25(workspace_search_fts, 10.0, 1.0)` weights `title` above `body`. **It does
not do what column weighting alone appears to promise**: FTS5's bm25 normalizes
by the whole row's token count, not per column, so a one-word message body
outranks a work stream whose `body` also carries its description and preview —
measured, not assumed. Delivering "a title match outranks a body match" needs an
explicit signal beside the weight: the ranking adds a boost term for rows whose
`title` matches the query, applied as a second bare-term (non-prefixed) clause.

For the same reason the PRD's "a whole-word match outranks a prefix" needs the
bare-term clause too: bm25 scores `"lau"*` and `"launch"*` identically against a
row containing `launch`, so without it the `updated_at` tiebreak — not
relevance — decides, and *Launchpad experiments* beats *Launch*.

A `message` row's `title` is the empty string, not the parent work stream's
title. Copying the work stream's title onto every message would give all 400
messages in a work stream called *Launch* a 10×-weighted title hit and bury the
work-stream row itself — the exact outcome the weighting is meant to prevent.
The work stream a message belongs to is rendered from `scope_id`, not from
`title`.

`ORDER BY rank` binds the SELECT alias, which carries the weights; `f.rank`
would silently use unweighted bm25.

### Destination de-duplication and candidate capping

`ROW_NUMBER() OVER (PARTITION BY result_type, result_id …)` selects the best
matching physical fragment for each thing the palette can open. A note whose
title and five transcript segments match is one result; a work stream with five
matching messages is one result. That collapse occurs on the server before the
candidate cap, so duplicate fragments cannot consume visible rows or make the
client infer a false remainder.

The cap is applied **per rendered group**, because one global `LIMIT` lets a
prolific kind hide groups that genuinely matched. Each group asks for 51
destination identities: the best 50 are its product window and the 51st sets
`hasMore`. There is no `COUNT(*) OVER ()`, no exact total query, and no exact
count in the response. Authorization is inside the candidate statement, so an
inaccessible 51st result cannot toggle the state.

The client merges local name matches and remote body matches by the same
`(result_type, result_id)` identity. A work stream already painted from its title
is enriched with remote snippets and rank evidence; it is not appended as a
second row. It then reapplies the 50-result window; `hasMore` is true when the
server found its sentinel or the merged authorized set exceeds 50. `People`,
`Actions`, and the start-work-stream action never enter the server's candidate
arithmetic.

### Scoping to one group

The PRD's group scope is the same statement with `result_type` bound to the
selected group, not a second matching or authorization rule to keep in step.

Three things follow, and each is the reason not to implement scoping on the
client by filtering what is already on screen:

- **The mixed five are a preview, not a sample.** Rows 6 through 50 were not
  returned, so a client-side filter of the current result set can only ever show
  the same five. Scoping has to re-ask.
- **`hasMore` is group-local.** The same 51st-destination sentinel is used in
  mixed and scoped modes, with no second count or authorization path.
- **Paging is keyset, not `OFFSET`.** The sort key is `(rank, updated_at DESC,
  result_id)`. Because SQLite does not permit a direction marker inside a row
  value, the cursor compares `(rank, -updated_at, result_id)` after projecting
  the negated integer timestamp. `OFFSET` over a re-ranked set double-counts and
  skips when the index moves under a person mid-scroll, which during the phase 2
  backfill is the normal case rather than the rare one.

`result_type = 'note'` reaches both `note` and `note_segment` physical rows;
binding `source_type` would silently lose one half. The first scoped page returns
25 of the bounded 50, and the second returns the remainder. If `hasMore` is true,
the end says `50+ results — refine your search`; no cursor walks beyond the
product window.

### Deletes are asynchronous tombstones

WorkspaceDO does **not** set `PRAGMA foreign_keys = ON` — `workstream-do.ts`,
`workstream-object-schema.ts`, and `block-dashboard-agent.ts` each do, and
WorkspaceDO does not — so a declared `REFERENCES … ON DELETE CASCADE` cannot be
assumed to enforce there, whatever the sibling tables declare. Search therefore
does not rely on a foreign-key cascade — and it does not put a derived delete in
the canonical transaction either.

Which parents actually hard-delete is worth being exact about, because the
obvious list is wrong in both directions. Work streams and notes are
*soft-archived* — there is no `DELETE FROM workspace_workstream_directory` or
`DELETE FROM notes` in the tree — so for those the archive predicate hides stale
fragments immediately and the later tombstone reclaims them. `resources` is the
one parent with real hard deletes, and there are three: `deleteDraft`, the
`resource-object-cleanup` **scheduled sweep** over stale drafts, and the Terminal
resource bridge. Each service captures the deleted source/result identity and
commits the canonical delete first, then upserts a versioned tombstone into the
search outbox. The scheduled sweep follows the same order per committed batch.
An archived automation similarly becomes invisible through the query predicate
at once and is later reclaimed through a tombstone.

Applying a source tombstone deletes its fragment and commits a source-level
version fence. Applying a parent destination tombstone deletes every row matching
`(result_type, result_id)`, served by the result index, and commits a result-level
fence. Those small `workspace_search_versions` rows survive deletion, so older
source replays and late child deliveries cannot resurrect text. If tombstone
recording fails in the post-commit window, targeted repair or the full
reconciliation scan finds the derived orphan and removes it.

### Snippets

The candidate SELECT above returns no body or snippet. FTS5's `snippet()` and
`highlight()` insert markers into text, which is markup — the thing the PRD's
security rule 6 forbids, and there is no FTS5 function that returns character
offsets. So the snippet is produced by a second bounded query for the at-most-50
returned destination identities, with up to three best fragments per identity.
JavaScript finds the passage and offsets over those bodies; the query repeats
the visibility predicate inside the same read transaction. No unreturned match
body crosses the SQLite/JavaScript boundary.

Three pieces of this already exist and should be reused rather than rewritten:
`passageRange` and `matchStart` in `workstream-attachment-tools.ts` (the same
job, over extracted document text), `safeUtf16Start`/`safeUtf16End` beside them
for clamping an offset off a surrogate pair, and `CharacterRangeSchema` in
`packages/contracts`, which is already the wire shape for "text plus offsets".
The renderer's `mention-highlight.ts` is the client half, and its choice of
`toLowerCase()` over `toLocaleLowerCase()` is deliberate and documented — a
Turkish locale must not make the highlight disagree with what was sent. The
extracted sanitizer has to make the same choice, and the two server copies
currently use the bare locale-sensitive form.

## Backfill

Nothing blocks on it. An unindexed work stream is still findable by name from the
client-side directory match, which makes a gradual backfill an acceptable
intermediate state rather than a broken surface.

Backfill is **only** historical-data migration. The moment the new outbox schema
deploys, new and changed entities enter the live path; no `backfill_complete`
gate sits in front of them. The scheduler always leases eligible live rows
before historical scan work, so a million old parts cannot make a new message
wait behind the migration.

`workspace_search_index_state` carries one checkpoint per canonical source. A
source scanner reads a stable keyset page — for example `(updated_at, id)` for
WorkspaceDO-local rows and `(sequence_number, id)` for transcript parts — and
upserts those source identities into the same coalescing outbox. It advances the
checkpoint only after that batch of identities is durable. On interruption, the
next wake resumes after the stored key; replaying the last page is safe because
the outbox key and index apply are idempotent. A live event for an identity wins
over an older backfill seed through the compound source version.
Pacing is still required even though every layer batches: WorkspaceDO is a
single-threaded authority that also serves the sidebar, routing, notes, and
resource access. Live outbox rows therefore sort ahead of migration-seeded
history, and each backfill wake is bounded so historical indexing yields between
batches instead of monopolizing the object.

The scanner, outbox drain, queue publisher, and WorkspaceDO apply all batch.
Batching is bounded in two dimensions — entity count and encoded bytes — with
the values handed back in the PRD's [Limits](prd.md#limits). For message history,
one child-object scan returns many canonical parts, one queue message carries
many projections, and one WorkspaceDO call applies many fragments. A workspace
with one million parts therefore produces roughly `parts / batch_size`
deliveries, never one million queue messages or RPC calls.

Message history still has the size consequence the PRD's retention question
names: it can make the WorkspaceDO index the object's dominant consumer. That
question blocks the phase-2 historical scan, not live indexing or phase 1.

### Repair and rebuild

- **Targeted repair** takes a source identity or destination identity, reads the
  current canonical rows, and upserts the same live outbox entries. It is the
  answer to a failed post-commit outbox write, a hash divergence, or one stale
  result reported by an operator.
- **Reconciliation** walks canonical identities and derived identities with
  checkpoints, enqueuing missing/stale sources and tombstoning derived orphans.
  It uses the same batch path and is safe to resume.
- **Full rebuild** increments `index_generation`, marks the state `repairing`,
  discards the derived document/FTS rows, resets all source checkpoints, and
  runs the historical scanners. Search remains available but incomplete and
  returns `indexState: catching_up` until every source is complete. Live events
  target the new generation immediately; an in-flight apply from the old
  generation is ignored. No canonical row, visibility row, or source outbox is
  rewritten.

## Testing

Per [`testing.md`](../../testing.md), the default is the real pipeline:

- **`apps/api/test-workers/`** — the async projection on real workerd: a
  canonical write still succeeds when `markSearchDirty`, queue publication, or
  index apply is forced to fail; a later repair indexes it. Ten writes to one
  source inside the debounce window leave one pending row and the drain reads
  the latest canonical value. A batch applied twice lands once; older versions
  are ignored; a higher generation with a lower version is accepted; and an
  equal-version/different-hash payload is surfaced as divergence.
- **Not the Node migration suite.** `test/helpers/migrated-schema.ts` replays
  only `packages/db/migrations/*.sql`, and `0090_drop_legacy_product_tables.sql`
  drops `notes` and `resources` from D1 while
  `workspace_workstream_directory`/`_viewers` never existed there — the
  visibility join has no schema to run against. The right fixture is the
  `workspaceObjectDatabase()` pattern in `test/workspace-schedule-targets.test.ts`,
  which replays every `WORKSPACE_DO_SCHEMA_MIGRATIONS` statement verbatim into
  `node:sqlite` — `CREATE VIRTUAL TABLE` and triggers included, with FTS5 and
  `bm25()` available. It needs no widening. (`createWorkspaceObjectTable` in
  `test/helpers/workspace-object-tables.ts` *is* regex-limited to
  `CREATE TABLE|INDEX`, but it is an unrelated helper for grafting one object
  table into a regional snapshot, and is not part of this fixture.)
- **One test per authorization arm, each written to fail first**, and one per
  *fragment* within the document arm — the inbound-email fragment especially,
  since it is the one that has already been argued away once. Delete an arm and
  its test must fail *for that reason*, asserting on `hasMore` as well as the
  rows, since bounded remainder state can leak existence even without a title.
- **Candidate-cap and result-unit tests against the real statement.** Fifty-one
  authorized destination identities return 50 plus `hasMore: true`; 50 return
  `hasMore: false`; no exact-total statement executes. Five matching messages in
  one work stream and several matching segments in one note each return one
  result identity with bounded highlighted evidence.
- **Update/delete lifecycle tests.** An update removes the old terms and adds
  the new ones; a source tombstone removes one fragment; a parent tombstone
  removes every fragment for the destination; an out-of-order older upsert
  cannot resurrect either.
- **Batching tests.** Both live and historical publishers pack multiple entities
  per queue message and per WorkspaceDO apply while respecting entity and byte
  bounds. A million-part fixture is unnecessary; arithmetic plus a fixture that
  crosses two batch boundaries proves the delivery count grows by batches rather
  than by entities.
- **Checkpoint/resumption tests.** Interrupt a backfill after one committed
  batch, restart it from `workspace_search_index_state`, and prove no identity is
  skipped or duplicated. Create and update entities during the pause and prove
  the live path indexes their latest versions before historical completion.
- **Repair/rebuild tests.** Targeted repair fixes a missing or divergent source;
  a rebuild clears derived rows, reports `catching_up`, resumes each source from
  its checkpoint, and returns to `ready` without changing canonical tables.
- **A test that the statement executes at all.** Two earlier drafts of this
  design specified SQL that does not run — first a global `LIMIT` that cannot
  deliver per-group truncation, then `bm25()` beside a window function, which
  SQLite rejects outright. Running the real statement against the real schema
  catches that class in seconds.
- **A real window** for the glyph, the overlay, and the keyboard model, captured
  and read per
  [`dev-environment.md`](../../dev-environment.md#driving-and-screenshotting-it).

## Documents this change updates

- [`data-model.md`](../../data-model.md) — the derived WorkspaceDO tables,
  source-authority outbox state, and a
  correction: its `personal`-visibility passage says "`WorkstreamDO.canRead` and
  the `listable` flag it projects test participation alone". That is right about
  `canRead` and wrong about `listable`, which is computed through
  `participantVisible` and therefore also admits `created_by_user_id`. Only the
  second half of the compound subject moves — rewriting the sentence whole would
  falsify the first.
- [`implementation-plan.md`](../../implementation-plan.md) — its release gate
  independently names global search as a completion blocker. See the PRD's
  [Impact on the product contract](prd.md#impact-on-the-product-contract).
- [`transcript-scrolling.md`](../../transcript-scrolling.md) — the anchored open
  a work-stream result can perform from message evidence, as a fifth reason the
  screen moves the viewport, and the rule that the match keeps it until the
  reader scrolls.
- [`workstream-durable-object.md`](../../workstream-durable-object.md) — the
  post-commit coalescing outbox, batched message projection, compound-version
  apply, tombstones, and repair/rebuild responsibilities.
- [`choosing-queues-or-rpc.md`](../../choosing-queues-or-rpc.md) — the batched
  regional search projection as a Queue: no caller waits for its result,
  at-least-once delivery is idempotent, and workspace content stays regional.
- [`choosing-sockets-or-rest.md`](../../choosing-sockets-or-rest.md) — `GET
  /search` as a worked example of a read that is deliberately not a push.
- [`telemetry.md`](../../telemetry.md) and the event registry — the three events.
- [`feature-flags.md`](../../feature-flags.md) — the `global-search` client flag.
- [`e2e.md`](../../e2e.md) — the acceptance flows that become durable checks.
- [`assumptions.md`](../../assumptions.md) — its line describing WorkstreamDO
  metadata as "searchable" predates this index and points at the wrong object.
- [the implementation brief](../2026-08-05_avalon-implementation-brief/prd.md) —
  the contract clause.
- A new `docs/global-search.md`, registered in
  [`docs/README.md`](../../README.md), once the subsystem exists.
