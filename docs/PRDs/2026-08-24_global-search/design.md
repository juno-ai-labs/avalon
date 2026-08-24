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
path: a work stream's title and description reach WorkspaceDO *over the outbox*
already, through `applyDirectoryEnvelope` (`workspace-do.ts`). Phase 1 does not
re-fetch them from the work stream — it writes the search row in the same
transaction that applies the directory envelope, from the payload already in
hand.

## Where the tables go

**Not by appending to `WORKSPACE_DOMAIN_SCHEMA_STATEMENTS`.** That array is
spread into **version 1** of `WORKSPACE_DO_SCHEMA_MIGRATIONS`
(`workspace-do.ts`), and version 1's statements are hashed into every deployed
object's `_sql_schema_migrations` receipt. `sqlite-migrations.ts` re-hashes on
wake and throws `workspace_do_schema_hash_mismatch:1`; the file says so in its
own words beside the array. Appending two `CREATE TABLE`s there takes every
existing workspace's Durable Object down on its next wake, in both regions —
a total outage, not a degraded search.

The tables land as a **new version entry** in `WORKSPACE_DO_SCHEMA_MIGRATIONS`
(the object is at version 9, so version 10), which is the same route
`SLACK_REACTION_COLUMN_STATEMENTS` took. They must also be added to
`WORKSPACE_LOCAL_TABLES` in `workspace-runtime-database.ts`, though **not** for
the reason it is tempting to give: the routing port does not fail closed on an
unregistered table. `if (localTables.length === 0) return false;` sends such a
statement to regional D1, where it dies as `no such table`; only an unregistered
*write target* throws. The join query names `notes` and `resources` and so routes
locally either way, but a search-only statement — the cascade `DELETE`, the
backfill `INSERT … SELECT` — would silently go to D1. That is the reason to
register them.

## Schema

```sql
CREATE TABLE workspace_search_documents (
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'workstream', 'automation', 'note', 'note_segment', 'document', 'message'
  )),
  source_id TEXT NOT NULL,
  -- The row the authorization join runs against, named by source_kind:
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
  title TEXT NOT NULL CHECK (length(CAST(title AS BLOB)) <= 500),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= /* see Byte bounds */),
  -- Recency ranking, and the ordering the sidebar already sorts by.
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  -- Idempotent re-delivery, for the kinds that arrive over the outbox and can
  -- therefore be re-delivered. NULLABLE, because the other kinds have no such
  -- value: notes, note segments, resources and automation subscriptions carry
  -- no generation, no version and no envelope hash anywhere in their schemas,
  -- so a NOT NULL column here would make every phase-1 write except the work
  -- stream's fail its CHECK, and an invented sentinel would defeat the compare
  -- these columns exist for. A locally-written row is idempotent by being an
  -- upsert of current state; there is nothing to order.
  --
  -- Compared as a compound where they are present, because sourceVersion
  -- restarts when a work stream's authority generation is bumped: a
  -- waterline-only test rejects every post-bump republish as "not higher" and
  -- freezes that work stream's index forever, silently.
  authority_generation INTEGER CHECK (authority_generation IS NULL OR authority_generation > 0),
  waterline INTEGER CHECK (waterline IS NULL OR waterline > 0),
  payload_hash TEXT,
  CHECK ((authority_generation IS NULL) = (waterline IS NULL)),
  PRIMARY KEY (source_kind, source_id)
) STRICT;

CREATE INDEX workspace_search_documents_scope_idx
  ON workspace_search_documents(source_kind, scope_id);

CREATE VIRTUAL TABLE workspace_search_fts USING fts5(
  title,
  body,
  content = 'workspace_search_documents',
  content_rowid = 'rowid',
  tokenize = 'unicode61',
  -- NO prefix index. Every request prefix-matches its trailing token, so one
  -- looks obviously right — but FTS5 consults a prefix index only for prefixes
  -- of exactly a configured length. Measured over a 20,000-document index:
  -- `prefix='2 3'` takes a 2-character prefix from 2.75ms to 0.79ms and does
  -- nothing at all for 4+ characters (2.83ms vs 2.65ms unindexed), while
  -- costing 2.6x the FTS index on disk and ~87% more write time on every
  -- projection. Since the product floor for a remote request is 2 characters,
  -- that buys two keystrokes of the query's life and is paid for on every
  -- message ever indexed, against the 10 GB ceiling this design already worries
  -- about. If profiling later shows short queries dominate, the sizes to add
  -- are a decision with an arithmetic behind it, not a default.
);
```

The index on `(source_kind, scope_id)` is what the cascade deletes below use.
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

Every projection therefore writes `UPDATE … WHERE source_kind = ? AND source_id = ?`
and falls back to `INSERT` when no row was changed, or uses
`INSERT … ON CONFLICT(source_kind, source_id) DO UPDATE SET …`, both of which
fire the update trigger.

### Byte bounds

`body` and `title` carry a byte-counted bound —
`CHECK (length(CAST(body AS BLOB)) <= …)`, never `length()` alone.
`data-model.md`'s 2026-08-19 changelog entry records why: character-counted
`CHECK`s against a byte-counted platform limit was one of the defects that audit
found. **The producer's truncation is measured in the same unit.** Truncating to
N characters and checking N bytes rejects every Japanese or emoji-bearing body
at three or four bytes per character — the envelope is rejected, the retry
replays the identical payload, and non-Latin content is silently never indexed.
Truncation is by bytes, on a code-point boundary, so a surrogate pair is never
split.

**This bound cannot ship open, and not for the usual reason.** A `CHECK` is SQL
text inside a hashed migration, and the limits document is explicit that
placeholders live in TypeScript source only — a limit that has to cross into a
stored row is one you must have a value for before you write it. There is also
no inert value: a `CHECK` has no `+Infinity`. And because the migration is
content-hashed and versioned, "one edit away from being real" is false here —
changing the number later is a new migration version, not an edit. So the number
is settled before the migration is written, and it is the first row of the PRD's
[Limits](prd.md#limits) table for that reason.

## Writing the index

### Phase 1 — text the object already owns

Written inline, in the same transaction as the write it derives from. For work
streams that is `applyDirectoryEnvelope`, which already carries an
`authority_generation` and a `waterline` — the search row copies them, which is
where phase 1's values for those columns come from. For notes, note segments,
resources, and automations, the writes go through `note-service.ts`,
`resource-service.ts`, and `automation-service.ts` over the
`withWorkspaceRuntimeDatabase` facade, so "the same transaction" means an
explicit `batch()`.

Not triggers on the source tables: a trigger cannot apply the content filters
below, and a filter that lives in a trigger is one nobody reviewing the write
path will see.

- **Work stream** — one row. `title`, `description`, and `preview` concatenate
  into `body`; `scope_id` is the work-stream id.
- **Automation** — one row per *subscription*, with the text joined out from
  `automation_templates.name` and `automation_template_versions.overview`.
  Subscriptions carry no name of their own, which is why the sidebar's own read
  joins to the template. Two subscriptions of one template are two rows with the
  same text and different `scope_id`, because they have different audiences.
- **Meeting note** — one `note` row for the title and briefing markdown, plus
  one `note_segment` row per transcript segment, so a match can carry its own
  offset into the recording. A segment row's `title` is the empty string, not
  the note's title: copying the note title onto 720 segments would index it 720
  times at the 10× title weight and flood the group with one meeting.
- **Document** — one `document` row for the title, at upload or hydration.
  **`resource_type = 'note'` is excluded.** Every note is backed by a `resources`
  row (`note-service.ts` inserts one with `provider = 'avalon_note'` and
  `model_content_status = 'ready'` at INSERT), so without this exclusion a
  personal note's title and full markdown reappear as a `document` row under a
  different authorization rule — the leak acceptance test 6 exists to catch.

### Phase 2a — message text, over the existing outbox

`SubstreamAgent` publishes to WorkspaceDO through the durable regional-effect
outbox. `search_document` joins the existing effect kinds — but **it is not an
additive change**, and three specifics matter more than the general shape:

- **It is the seventh kind, not the fourth.** `durable_outbox.effect_kind`'s live
  `CHECK` in `workstream-do.ts` admits six: `directory_common`, `directory_user`,
  `suggestion_feedback`, `activity_event`, `mention_notification`,
  `participant_notification`. The three-kind list that is easy to reach for is
  the *RPC allowlist* in `workspace-directory-protocol.ts`, which is a different
  set for a different purpose. This matters because the change is a table
  rebuild whose entire content is a re-declared `CHECK` list: written from the
  three-kind list it silently drops three kinds that are in production, and the
  next `activity_event` insert fails inside its producing transaction.
- **The rebuild is over version 3's table, not version 1's.** Version 1's
  five-kind table was already dropped and replaced by the version-3
  new-table/copy/drop/rename that added `participant_notification`. The next one
  is version 4.
- **Two producers stamp `messageId` differently, and the obvious reading is
  backwards.** `directory_common` and `directory_user` go through
  `enqueueProjection` → `recordStateChange`, which returns `uuidV7(occurredAt)` —
  that is *why* they satisfy the UUIDv7 refinement
  `WorkspaceDirectoryApplyRequestSchema` imposes. The
  `substream:<id>:<messageId>` form belongs to `enqueueImmutable`, which serves
  exactly the three kinds that RPC rejects. So a `search_document` shaped as a
  projection effect needs no branch at all; one shaped as an immutable effect
  needs a fix in a different function than the surface reading suggests.
- **There is no monotonic `sourceVersion` on the non-projection arm.** It is
  caller-supplied and unvalidated, and the sole existing caller passes the
  literal `1`. A per-message `search_document` therefore needs either a
  `projection_keys` row per message — per-message bookkeeping at message-table
  scale in the child object — or another monotonic source. With neither, every
  republish carries `waterline = 1`, loses the compound compare, and edits never
  reach the index.
- Seven other sites enumerate the kinds and each needs the new one.

The producer filters before it publishes, and that is a security boundary rather
than an optimisation. The line is the one the transcript read itself applies:
`substream_id = '0' AND visibility IN ('people', 'both')`. **Both halves
matter.** Omitting the substream clause publishes people-visible parts from an
`audience = 'owner'` substream — a private side-conversation rendered to nobody
in the transcript — into an index every member of that work stream can search.
And `kind = 'text'` alone is *narrower* than the product's line: `attachment`
and `steer_request` parts with `people` visibility are shown to people, and
`structured_content_json` carries elicitation and suggestion content. The
projection matches the transcript's rule, then excludes the kinds the PRD's
non-goal 8 names.

A message whose `content` spilled to `content_ref_id` is projected from R2 at
publish time, truncated by bytes to the indexed bound. Editing republishes with
a higher waterline.

### Phase 2b — document contents

Extraction records completion by moving `resources.model_content_status` to
`ready`. Indexing hooks that write and updates the existing `document` row's
`body`.

**The `resource_type = 'note'` exclusion is restated here, and it is
load-bearing.** It is tempting to argue the hook cannot fire for a note-backed
resource because the row is born `ready` at INSERT — that is false.
`note-service.ts`'s `materialize()` runs `UPDATE resources SET …
model_content_status = 'ready'` and is called from seven sites: every note
update, every transcript-segment append, every briefing generation. So the hook
fires for notes routinely. Combined with the upsert rule above — update, and
`INSERT` when no row changed — a phase-2b hook without the exclusion *creates*
the `document` row phase 1 declined to write, carrying the note's full briefing
and transcript under the document rule instead of the note one. That is
acceptance test 8's leak, reintroduced by the half of the pipeline that was not
told about the exclusion.

Extraction is also **lazy and caller-triggered** — `materializeAttachmentDerivative`
runs when a person previews a resource or an agent tool reads it, and nothing
schedules it — so an uploaded file nobody has opened stays `pending` and is
findable by title only.

## Reading the index

One `GET /search?q=…` under the ordinary session auth, answered by the Worker
delegating to WorkspaceDO. REST rather than a socket topic, per
[`choosing-sockets-or-rest.md`](../../choosing-sockets-or-rest.md): a person
explicitly went looking for it, and nobody else's screen depends on the answer.

### Query construction

The caller's text goes through the token-and-quote sanitizer that
`memory-service.ts` and `memory-table-service.ts` each hold a **byte-identical
private copy** of — NFKC normalise, extract `[\p{L}\p{N}_-]+` runs, lowercase,
dedupe, quote with `"` doubled. Nothing is shared today, so extracting a module
and re-pointing both existing call sites is part of this change, not a parameter
addition. Note the existing copies also hard-cap at 96 tokens, which silently
pre-empts the query-length limit the PRD lists as unset.

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
statement as the `MATCH`. A `CASE` over `source_kind` rather than a chain of
`OR`s, because `CASE` is exhaustive and fails closed: a source kind added later
with no arm returns `NULL` and is excluded, where an `OR` chain of
`(scope_id IS NULL) OR (…)` guards admits it unconditionally.

```sql
SELECT source_kind, source_id, scope_id, title, body, updated_at, rank, total_matches
  FROM (
    SELECT m.*,
           COUNT(*) OVER () AS total_matches,
           ROW_NUMBER() OVER (
             PARTITION BY m.group_key ORDER BY m.rank, m.updated_at DESC
           ) AS rn
      FROM (
        SELECT d.source_kind, d.source_id, d.scope_id, d.title, d.body, d.updated_at,
               -- The panel's groups, not the storage kinds: note and
               -- note_segment render as one Meeting notes group.
               CASE WHEN d.source_kind IN ('note', 'note_segment')
                    THEN 'note' ELSE d.source_kind END AS group_key,
               bm25(workspace_search_fts, 10.0, 1.0) AS rank
          FROM workspace_search_fts f
          JOIN workspace_search_documents d ON d.rowid = f.rowid
          LEFT JOIN workspace_workstream_directory wd
                 ON d.source_kind IN ('workstream', 'message')
                AND wd.workstream_id = d.scope_id
          LEFT JOIN workspace_workstream_viewers wv
                 ON wv.workstream_id = wd.workstream_id
                AND wv.user_id = ?1
                AND wv.authority_generation = wd.authority_generation
          LEFT JOIN notes n
                 ON d.source_kind IN ('note', 'note_segment') AND n.id = d.scope_id
          LEFT JOIN resources r
                 ON d.source_kind = 'document' AND r.id = d.scope_id
          LEFT JOIN connector_connections cc ON cc.id = r.connection_id
          LEFT JOIN automation_subscriptions s
                 ON d.source_kind = 'automation' AND s.id = d.scope_id
          LEFT JOIN automation_templates t ON t.id = s.template_id
         WHERE workspace_search_fts MATCH ?2
           AND CASE d.source_kind
             WHEN 'workstream'   THEN <workstream_visible>
             WHEN 'message'      THEN <workstream_visible>
             WHEN 'note'         THEN <note_visible>
             WHEN 'note_segment' THEN <note_visible>
             WHEN 'document'     THEN <document_visible>
             WHEN 'automation'   THEN <automation_visible>
           END
      ) m
  )
 WHERE rn <= 5
 ORDER BY rank, updated_at DESC;
```

**Three levels, and the nesting is not stylistic.** SQLite refuses `bm25()` in
the select list of any query level that also carries a window function —
`unable to use function bm25 in the requested context`. A window query
materialises its source rows into an ephemeral sorter before the select-list
expressions are evaluated, by which point the FTS5 cursor is gone. Verified on
3.51.2: `bm25()` alone is fine, `bm25()` beside `COUNT(*) OVER ()` fails, and
`bm25()` beside `ROW_NUMBER()` fails. So `bm25()` is computed innermost, the two
windows run one level out, and the outer level truncates and orders. A two-level
version of this statement does not execute at all.

The consequence for [Counting and truncation](#counting-and-truncation) is worth
stating plainly rather than glossing: this shape materialises every authorized
matching row before it can emit one. That is what makes the candidate cap in the
PRD's [Limits](prd.md#limits) a prerequisite rather than a nicety, and it is why
that cap and an exact `N MORE RESULTS` are in tension — see that section.

with, as the four predicates:

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
  AND (r.provider != 'resend' OR r.resource_type != 'email' OR EXISTS (
        SELECT 1 FROM workspace_workstream_resource_links l
          JOIN workspace_workstream_viewers ev
            ON ev.workstream_id = l.workstream_id AND ev.user_id = ?1
         WHERE l.resource_id = r.id AND ev.is_participant = 1))
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
WorkspaceDO does not have. The arm above expresses the same rule over the
WorkspaceDO-local link and viewer tables that `resourceAccess` already uses, so
it is a join after all — just one that has to be written rather than reused.

**The draft-upload rule exists in two non-equivalent forms and this picks one.**
`UPLOAD_RESOURCE_VISIBILITY_SQL`, used by the single-resource read, ends
`OR r.uploaded_by_user_id = ?`; the list path inlines the same predicate
*without* that arm, so the picker hides a person's own unattached drafts from
them. The arm above takes the read-one form, because search's job is to find
what you can open and you can open your own draft. That is a divergence from the
picker, which non-goal 15 has to resolve deliberately rather than by whichever
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

### Counting and truncation

`ROW_NUMBER() OVER (PARTITION BY group_key …)` is what actually delivers five
rows per group. A single global `LIMIT` cannot: with 400 short transcript
segments matching, every slot goes to transcript rows and the Work streams,
Documents, and Automations groups render as *no matches* even though each holds a
title hit — indistinguishable, to the person, from the work stream not existing.

**It partitions on `group_key`, not `source_kind`.** `note` and `note_segment`
are two storage kinds and one rendered group, so partitioning on the storage kind
gives Meeting notes up to ten rows against a stated cap of five. It also needs
de-duplication the SQL alone does not provide: a note whose title *and* five of
whose transcript segments match is six rows that all open the same note. The
client collapses rows sharing a `scope_id` within a group, keeping the
best-ranked, which is why `scope_id` is projected.

`COUNT(*) OVER ()` gives the total in the same pass, so the count is not a second
execution of the whole ranked join per keystroke, and cannot drift from the rows
it describes. **`N MORE RESULTS` is `total_matches` minus what is actually on
screen.** Reporting `total_matches` directly says `3 MORE RESULTS` when all three
matches are already visible.

Two honest limits on that number, which the simpler phrasing hides:

- **The subtraction happens on the client, because the client is what knows what
  is on screen.** Local name matches, the People and Actions rows, and the
  start-a-work-stream row were never in the statement, and a work stream matched
  both locally and remotely renders once. So the server returns `total_matches`
  and the client subtracts what it painted. The guarantee that survives — the one
  the security rule actually needs — is that `total_matches` counts only rows
  that passed the `CASE`. It is not a promise that the arithmetic happens in SQL,
  and the PRD should not be read as making one.
- **A candidate cap and an exact total are mutually exclusive.** An inner `LIMIT`
  makes `COUNT(*) OVER ()` count the truncated set, so the footer would report
  the cap rather than the remainder. That is a product call — either the count
  becomes "N+ more" above the cap, or the cap is set high enough that the
  difference is theoretical and the per-keystroke cost is accepted. It sits on
  the PRD's [Limits](prd.md#limits) table for that reason, because the statement
  above materialises every authorized match before emitting one, and nothing else
  bounds it.

### Cascade deletes are explicit

WorkspaceDO does **not** set `PRAGMA foreign_keys = ON` — `workstream-do.ts`,
`workstream-object-schema.ts`, and `block-dashboard-agent.ts` each do, and
WorkspaceDO does not — so a declared `REFERENCES … ON DELETE CASCADE` cannot be
assumed to enforce there, whatever the sibling tables declare. Every parent deletion therefore issues an explicit
`DELETE FROM workspace_search_documents WHERE source_kind IN (…) AND scope_id = ?`,
served by the `(source_kind, scope_id)` index. Without it a deleted work stream's
20,000 message rows stay forever: invisible in results, since the predicate fails
closed, and accumulating against the 10 GB ceiling the PRD flags as an outage
condition.

Which parents actually hard-delete is worth being exact about, because the
obvious list is wrong in both directions. Work streams and notes are
*soft-archived* — there is no `DELETE FROM workspace_workstream_directory` or
`DELETE FROM notes` in the tree — so for those the archive predicate is what
hides the rows and the delete path is theoretical. `resources` is the one parent
with real hard deletes, and there are three: `deleteDraft`, the
`resource-object-cleanup` **scheduled sweep** over stale drafts, and the Terminal
resource bridge. The sweep is the awkward one: it runs on an alarm with no user
transaction to ride, so the search delete has to be part of that pass rather than
of a request. Automations were missed entirely in the first draft of this design:
an archived subscription's rows fail closed but accumulate.

A `BEFORE DELETE` trigger is the idiom this object already uses for exactly this
problem — `resources_enqueue_objects_before_delete` queues R2 objects that way,
and its consumer relies on the trigger rather than deleting at the call site. The
objection to triggers earlier in this document is about the projection *writes*,
which need content filters; it does not reach the deletes, which need none. The
trigger is the better mechanism here and the reason it was not chosen first was
an over-broad reading of that objection.

### Snippets

The SELECT above returns no snippet. FTS5's `snippet()` and `highlight()` insert
markers into text, which is markup — the thing the PRD's security rule 6
forbids, and there is no FTS5 function that returns character offsets. So the
snippet is produced by a second, non-FTS5 pass over the `body` the statement
already returns — in JavaScript, over the rows it handed back, never by a
follow-up query against the index. Projecting `body` is not free: it carries
every matched row's indexed text through the materialisation, which is a second
reason the candidate cap is a prerequisite.

Three pieces of this already exist and should be reused rather than rewritten:
`passageRange` and `matchStart` in `workstream-attachment-tools.ts` (the same
job, over extracted document text), `safeUtf16Start`/`safeUtf16End` beside them
for clamping an offset off a surrogate pair, and `CharacterRangeSchema` in
`packages/contracts`, which is already the wire shape for "text plus offsets"
and already travels with `totalMatches`/`returnedMatches`/`truncated`. The
renderer's `mention-highlight.ts` is the client half, and its choice of
`toLowerCase()` over `toLocaleLowerCase()` is deliberate and documented — a
Turkish locale must not make the highlight disagree with what was sent. The
extracted sanitizer has to make the same choice, and the two server copies
currently use the bare locale-sensitive form.

## Backfill

Nothing blocks on it. An unindexed work stream is still findable by name from the
client-side directory match, which makes a gradual backfill an acceptable
intermediate state rather than a broken surface.

**The resume shape is an outbox, and the object already has four of them to copy
from.** Every maintenance target in `workspace-schedule-execution.ts` derives its
due instant from pending rows in a queue table (`MIN(created_at)` with
`HAVING COUNT(*) > 0`), so a backfill that merely walks existing rows never
becomes due. The closest precedent is `note_privacy_change_outbox`, which marks
rows `processed_at` rather than deleting them — the exact shape a backfill needs
— and `memory_index_outbox` adds the rest: `status`, `attempt_count`,
`available_at`, `lease_token`, `lease_expires_at`, `last_error`, drained at a
hard-capped batch size on the workspace alarm. Phase 1's backfill is a migration
that seeds one of those, not a new mechanism.

Phase 2a's backfill is the expensive one and has a second cost the first draft of
this design did not name. The size cost is real: it decides the index's eventual
size in one go, which is why the retention horizon in the PRD's
[Open questions](prd.md#open-questions) needs an answer first. But so is
**contention**: at the 25-envelope RPC cap, 500 work streams × 2,000 visible
parts is 40,000 apply calls, each a transaction inside the workspace's *single*
WorkspaceDO — the same object serving the sidebar, routing, notes, and resource
access. A claim to strike rather than rely on: backfill envelopes do **not** sort last.
The outbox orders by `created_at` first and uses the priority `CASE` only to
break ties within one instant, and on the child outbox `created_at` is the
leading key outright. So a migration-seeded backfill stamped at time T queues
*ahead of* every live directory projection created afterwards — the sidebar's own
projection waits behind the entire backfill. Pacing therefore has to be explicit:
a per-wake bound on the drain, on the model of `processMemoryIndexOutbox`'s
capped batch, and it belongs on the PRD's Limits table where a team member would
find it.

The contention arithmetic also has a factor-of-25 error worth correcting. The
25-envelope batch belongs to `WorkstreamDO.deliverWorkspaceDirectoryEffects`;
`SubstreamAgent`'s effects go one envelope per RPC through
`workstream-regional-effect-service.ts`, which sends `envelopes: [message]`. For
the path this design actually uses, 500 work streams x 2,000 visible parts is
1,000,000 apply calls and 1,000,000 queue messages, not 40,000.

## Testing

Per [`testing.md`](../../testing.md), the default is the real pipeline:

- **`apps/api/test-workers/`** — the projection on real workerd: an effect
  envelope applied twice lands once; a lower waterline is ignored; a *higher
  generation with a lower waterline* is accepted; the explicit cascade removes a
  work stream's message rows; a `search_document` envelope carries a UUIDv7
  `messageId`.
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
  its test must fail *for that reason*, asserting on `total_matches` as well as
  the rows, since the count is where the first draft's leak actually surfaced.
- **A test that the statement executes at all.** Two earlier drafts of this
  design specified SQL that does not run — first a global `LIMIT` that cannot
  deliver per-group truncation, then `bm25()` beside a window function, which
  SQLite rejects outright. Running the real statement against the real schema
  catches that class in seconds.
- **A real window** for the glyph, the overlay, and the keyboard model, captured
  and read per
  [`dev-environment.md`](../../dev-environment.md#driving-and-screenshotting-it).

## Documents this change updates

- [`data-model.md`](../../data-model.md) — the two new WorkspaceDO tables, and a
  correction: its `personal`-visibility passage says "`WorkstreamDO.canRead` and
  the `listable` flag it projects test participation alone". That is right about
  `canRead` and wrong about `listable`, which is computed through
  `participantVisible` and therefore also admits `created_by_user_id`. Only the
  second half of the compound subject moves — rewriting the sentence whole would
  falsify the first.
- [`implementation-plan.md`](../../implementation-plan.md) — its release gate
  independently names global search as a completion blocker. See the PRD's
  [Impact on the product contract](prd.md#impact-on-the-product-contract).
- [`workstream-durable-object.md`](../../workstream-durable-object.md) — the
  fourth effect kind and the `durable_outbox` rebuild it requires.
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
