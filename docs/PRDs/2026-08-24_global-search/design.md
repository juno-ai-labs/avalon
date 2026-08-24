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
`WORKSPACE_LOCAL_TABLES` in `workspace-runtime-database.ts` — the routing port
fails closed on a statement naming an unregistered table, so an unregistered
search table sends the query to regional D1 and throws.

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
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Recency ranking, and the ordering the sidebar already sorts by.
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  -- Idempotent re-delivery. Both columns, compared as a compound, because
  -- sourceVersion restarts when a work stream's authority generation is bumped:
  -- a waterline-only test rejects every post-bump republish as "not higher" and
  -- freezes that work stream's index forever, silently.
  authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
  waterline INTEGER NOT NULL CHECK (waterline > 0),
  payload_hash TEXT NOT NULL,
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
  -- Every request prefix-matches its trailing token (see Query construction).
  -- Without a prefix index FTS5 answers that by scanning the term list for
  -- every term sharing the prefix, on the hottest path in the feature, and it
  -- degrades with vocabulary size — i.e. with exactly the workspace age the PRD
  -- argues search is for. Cheaper to decide now than after the backfill has
  -- written the index once.
  prefix = '2 3'
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

The bound's number is not this change's to pick — see the PRD's
[Limits](prd.md#limits) — but the `CHECK` expression is written now, with the
`LIMIT UNSET` marker on its constant.

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
outbox. A fourth effect kind, `search_document`, joins `directory_common`,
`directory_user`, and `suggestion_feedback` — but **it is not an additive
change**, and the design that says otherwise underestimates it:

- `durable_outbox.effect_kind` is a closed `CHECK` inside a hashed version-1
  migration in `workstream-do.ts`. Adding `participant_notification` already
  required a full table rebuild as its own migration version — new table, copy,
  drop, rename. This needs the same.
- `WorkspaceDirectoryApplyRequestSchema` enumerates the admitted kinds and
  requires a **UUIDv7** `messageId` for each. The outbox stamps
  `substream:<id>:<messageId>` for every kind except `suggestion_feedback`,
  which alone gets a `uuidV7`. Without a matching branch, every
  `search_document` envelope fails schema validation at the RPC boundary — a
  permanently poisoned outbox row, not a retryable error.
- Six or so other sites enumerate the three kinds and each needs the fourth.

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

Two things this inherits and should not be read as more than it is. Extraction
is **lazy and caller-triggered** — `materializeAttachmentDerivative` runs when a
person previews a resource or an agent tool reads it, and nothing schedules it —
so an uploaded file nobody has opened stays `pending` and is findable by title
only. And the note-backed resources excluded above are already born `ready` at
INSERT, so a hook shaped as `AFTER UPDATE` would never fire for them anyway;
the exclusion is what makes that harmless rather than accidental.

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
SELECT source_kind, source_id, title, updated_at, rank, total_matches
  FROM (
    SELECT d.source_kind, d.source_id, d.title, d.updated_at,
           bm25(workspace_search_fts, 10.0, 1.0) AS rank,
           COUNT(*) OVER () AS total_matches,
           ROW_NUMBER() OVER (
             PARTITION BY d.source_kind
             ORDER BY bm25(workspace_search_fts, 10.0, 1.0), d.updated_at DESC
           ) AS rn
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
         WHEN 'workstream' THEN <workstream_visible>
         WHEN 'message'    THEN <workstream_visible>
         WHEN 'note'         THEN <note_visible>
         WHEN 'note_segment' THEN <note_visible>
         WHEN 'document'   THEN <document_visible>
         WHEN 'automation' THEN <automation_visible>
       END
  )
 WHERE rn <= 5;
```

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

<document_visible> = the three fragments resource-service.ts already applies —
  connector scope, the draft-upload rule, and the note-backed rule — lifted into
  shared SQL fragments so search and the resource read cannot drift.
```

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

`ROW_NUMBER() OVER (PARTITION BY source_kind …)` is what actually delivers five
rows per group. A single global `LIMIT` cannot: with 400 short transcript
segments matching, every slot goes to `note_segment` and the Work streams,
Documents, and Automations groups render as *no matches* even though each holds a
title hit — indistinguishable, to the person, from the work stream not existing.

`COUNT(*) OVER ()` gives the total in the same pass, so the count is not a second
execution of the whole ranked join per keystroke, and cannot drift from the rows
it describes. **`N MORE RESULTS` is `total_matches` minus the rows actually
returned** — the count of everything matching *but not shown*, per the PRD.
Reporting `total_matches` directly says `3 MORE RESULTS` when all three matches
are on screen.

### Cascade deletes are explicit

WorkspaceDO does **not** set `PRAGMA foreign_keys = ON` — `workstream-do.ts`,
`workstream-object-schema.ts`, and `block-dashboard-agent.ts` each do, and
WorkspaceDO does not — so a declared `REFERENCES … ON DELETE CASCADE` cannot be
assumed to enforce there, whatever the sibling tables declare. Deleting a work
stream, note, or resource therefore issues an explicit
`DELETE FROM workspace_search_documents WHERE source_kind IN (…) AND scope_id = ?`
in the same transaction, served by the `(source_kind, scope_id)` index. Without
it, a deleted work stream's 20,000 message rows stay forever: invisible in
results, since the predicate fails closed, and accumulating against the 10 GB
ceiling the PRD flags as an outage condition.

### Snippets

The SELECT above returns no snippet. FTS5's `snippet()` and `highlight()` insert
markers into text, which is markup — the thing the PRD's security rule 6
forbids, and there is no FTS5 function that returns character offsets. So the
snippet is produced by a second, non-FTS5 pass over the matched rows' `body`,
**inside the same filtered statement's result set** rather than by a follow-up
query against the index, and returned as text plus offsets for the renderer to
highlight. The repo has two existing matchers to reconcile with rather than add a
third to: `passageRange`/`matchStart` in `workstream-attachment-tools.ts`, and
the locale-safe splitter in the renderer's `mention-highlight.ts`. Which one is
lifted is an implementation decision this design does not make, but it must be
one of them.

## Backfill

Nothing blocks on it. An unindexed work stream is still findable by name from the
client-side directory match, which makes a gradual backfill an acceptable
intermediate state rather than a broken surface.

**The resume shape has to be built.** Every maintenance target in
`workspace-schedule-execution.ts` derives its due instant from *pending rows in a
queue table* (`MIN(created_at)` with `HAVING COUNT(*) > 0`) and reports progress
as the count of rows it retired. There is no cursor-resumable target anywhere in
that file. A backfill that walks rows which already exist retires nothing, so it
never becomes due and reports no progress — which the alarm's stall gate reads as
stalled. Phase 1's backfill therefore needs either its own outbox table seeded by
the migration, or a progress-cursor table plus a target query that derives a due
instant from it. The outbox is the shape the object already understands.

Phase 2a's backfill is the expensive one and has a second cost the first draft of
this design did not name. The size cost is real: it decides the index's eventual
size in one go, which is why the retention horizon in the PRD's
[Open questions](prd.md#open-questions) needs an answer first. But so is
**contention**: at the 25-envelope RPC cap, 500 work streams × 2,000 visible
parts is 40,000 apply calls, each a transaction inside the workspace's *single*
WorkspaceDO — the same object serving the sidebar, routing, notes, and resource
access. Backfill envelopes do sort last in the outbox's priority `CASE`, which is
load-bearing and should stay that way, but the design needs an explicit per-wake
bound and a pacing rule, not just a size answer.

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
  `workspaceObjectDatabase()` pattern that replays
  `WORKSPACE_DO_SCHEMA_MIGRATIONS` into `node:sqlite`, where FTS5 and `bm25()`
  are available. Its `createWorkspaceObjectTable` helper matches only
  `CREATE TABLE|INDEX`, so it silently skips `CREATE VIRTUAL TABLE` and the three
  triggers and needs widening first.
- **One test per authorization arm, each written to fail first.** Delete the
  `document` arm of the `CASE` and the inaccessible-document test must fail *for
  that reason* — and must assert on the `N MORE RESULTS` count as well as the
  rows, since the count is where the first draft's leak actually surfaced.
- **A real window** for the glyph, the overlay, and the keyboard model, captured
  and read per
  [`dev-environment.md`](../../dev-environment.md#driving-and-screenshotting-it).

## Documents this change updates

- [`data-model.md`](../../data-model.md) — the two new WorkspaceDO tables, and a
  correction: the `personal`-visibility passage states that the `listable` flag
  "tests participation alone", which `participantVisible` contradicts by also
  admitting `created_by_user_id`.
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
