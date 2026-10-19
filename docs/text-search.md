# Text search

Rally's shared Turbopuffer boundary provides full-text, literal substring, and semantic
retrieval as separate modes. Product callers choose data sources; each source resolves
its own grants and reloads canonical results. The index does not grant access.

The member search modal uses this boundary for messages, links, uploaded files,
and generated artifacts. The broader migration is still incomplete: memory and
agent/provider search callers retain their existing paths. Provisioning credentials
does not deploy this code or backfill dormant objects.

The core [authorization primitive](authorization.md) owns the optional migrated
member read path and exact attachment discovery. Deployment enables this path
for every workspace; incomplete attachment evidence initiates queued discovery.
Search returns verified matches only. A candidate whose authority the projection
does not hold is omitted and filled after the response; the page carries no
completeness flag, because the projection is registered from the mutation side
before a search needs it.

## Where the code lives

- `apps/api/src/services/text-search.ts`: namespace selection, writes, revision
  tombstones, retrieval, and canonical result loading.
- `apps/api/src/services/search-indexing-pipeline.ts`: shared chunk planning and independently retriable batch indexing.
- `apps/api/src/services/search-indexing-jobs.ts`: reference-only batch contracts and Queue publication.
- `apps/api/src/services/search-document.ts`: canonical document, display and deletion contracts.
- `apps/api/src/services/search-audience.ts`: the groups a row's `audience` names and the one place a group becomes its stored UUID.
- `apps/api/src/services/search-embedding.ts`: pinned Qwen tokenizer and embedding integration.
- `apps/api/src/services/semantic-chunks.ts`: recursive and sliding-window semantic chunks.
- `apps/api/test/semantic-chunks.test.ts`: coverage, Unicode, overlap, and token budgets.
- `apps/api/src/env.ts`: server-only development and production credentials.
- `apps/api/src/services/workspace-search-service.ts` and `routes/search.ts`: member
  source selection, current authorization, canonical excerpts, and the protected API.
- `apps/api/src/durable-objects/search-projection-outbox.ts`,
  `resource-search-projection.ts`, `channel-message-search-projection.ts` and
  `conversation-link-search.ts`: transactional indexing intent, Queue dispatch,
  and asynchronous Browser Run capture.
- `apps/desktop/src/renderer/components/search-modal.tsx`: the member UI: five content tabs, plus Channels and Spaces tabs it answers itself.
- `apps/api/test/text-search.test.ts`: source grant and canonical loading tests.

## How it works

Generation v3 uses two namespaces: `rally-search-v3-<identity hash>-text` holds
complete lexical documents without vectors; `rally-search-v3-semantic-<hash>` holds
embedded chunks. The semantic hash combines the workspace identity with tokenizer revision, algorithm version, chunk size,
and overlap, so changing chunk policy requires a semantic backfill in a new space.
Hashing the complete semantic identity once keeps the name within Turbopuffer's
[published 128-character namespace limit](https://turbopuffer.com/docs/write).
A document records its source, canonical source ID, scope ID, substream, revision, text,
the display a result renders (title, source label, time, transcript position, link URL,
MIME type and archive state), the groups that may read it (`audience`), and, for semantic records, embedding. The producing object
writes the display and the audience beside the text from its own tables; a deletion watermark and a row
written before the display existed carry none. `searchDocumentId` hashes the source, scope, and source ID into a
stable ID within Turbopuffer's 64-byte string-ID limit. Updates use conditional
writes. Deletion replaces the document with a content-free revision watermark,
preventing delayed writes at the same or an older revision from restoring it.
The lexical watermark is excluded from retrieval. Semantic generations are
physically reclaimed by revision filters and canonical revalidation.

`text` uses BM25; `substring` uses literal case-insensitive matching;
`semantic` uses ANN over chunk records. Each request uses exactly one ranking
strategy. There is no hybrid mode, rank fusion, or specialist reranker.
Substrings escape glob operators rather than interpret user text as patterns.
Lexical queries search parent documents, so substring matches are not interrupted
by semantic chunk boundaries. Semantic queries search only chunk records.

### Interactive response latency

The desktop requests seven candidates initially: the 360px results body minus
16px padding shows six complete 52px two-line rows and part of the seventh,
with 2px gaps. That body is the modal's only variable region and its height is
fixed, so the modal is the same size in every state: the list and the pagination
footer divide the 360px between them, and the footer takes its room from the
list rather than from the box. Additional pages load on their own: a sentinel at
the end of the list is observed with `IntersectionObserver`, so the next page
is requested as the end scrolls into view, again whenever a page lands without
filling the viewport, and when the keyboard highlight reaches the last row.
Each request consumes one candidate page. An empty page with a continuation
keeps scanning until a page has a row or the cursor ends. Existing rows stay
visible while fetching another page, with a "Loading more" line pinned under the
list; a transient continuation failure stops the scan and offers a retry button
in that same place, so a broken cursor cannot loop, while a failed
reauthorization hides the rows. Either footer takes its room from the list, so
the highlighted row is scrolled back into view whenever one opens or closes.
Query and category changes discard old pages. A row shows its excerpt and source
only; ⌘1-9 still opens the nth row, unadvertised.

Older clients omit `pageSize` and retain the array response shape with up to 50
results from one candidate batch. They receive no pagination or timing fields and
do not trigger hidden refill scans. The 250ms typing debounce, REST, and final
workspace membership check remain unchanged. Search decisions are cached in regional KV/SQLite and updated by DO mutation pushes through the activity queue. A read never waits for a refresh: a miss is filled after the response. Decisions do not expire by age.

The server caches no search result. The desktop holds a settled query's pages
for 30 seconds (`SEARCH_RESULT_CACHE_MS` in `search-modal.tsx`), so a repeat of
the same workspace, member, category and words inside that window repaints
without a request. The window runs from the first page's admission, not from the
latest continuation, so paging does not extend it. A cache hit runs no
`queryFn`, so it opens no `renderer_perf_flow` flow: the measured population is
the requests, and the targets below describe those rather than every search a
reader performs.

The user-facing targets are p50 <= 500ms and p90 <= 1000ms from the last
keystroke to painted results, including debounce. An empty page with continuation
is not a completed first-result flow: its trace stays open until a result or
terminal response, including time the user spends before continuing. A terminal
empty search is a completed no-match response, not evidence of fast result delivery.
Empty intermediate pages do not satisfy the results latency target. `renderer_perf_flow` with
`flow=workspace_search` measures debounce, request, and paint through the existing
regional telemetry path. Optional paginated response timings expose scope,
Turbopuffer retrieval, canonical hydration, and server duration; the backend also
logs content-free `search_response_timing`. Request duration minus server duration
is an approximate transport/client overhead, not a pure network measurement.
Neither telemetry stream includes the query, result text, URLs, or resource names.
Evaluate completed first-result flows separately from failed/superseded flows and
continuation requests. Exercise cold and warm Workers, common/rare terms, and
private conversations before claiming the percentile targets are met.

### One Queue pipeline

A resource's source delivery indexes it in place: one `prepareResourceSearch`
call returns its three category documents (at most one live, the others
tombstones), and one more call confirms nothing changed. A Channel message
(`space_messages`: Rally's posts in a Channel and the results threads merge
into it) is indexed the same way from WorkspaceDO: migration 119's
`channel_message_search_versions` holds each message's revision and its
Channel, triggers on every writer and on a Channel's rename bump it, the
`channel_message_search` alarm lane publishes references on the resource
lane's shared pace, and `prepareChannelMessageSearch` returns one
`channel_messages` document or its deletion watermark. Its audience is the
Channel's `space:<id>` group, which every reader of the Channel already holds,
and its title is the Channel's name, never the merged thread's. Only the agent's
`conversation_search` reads that source today; the member search modal does
not offer it yet. A turn's source
delivery discovers canonical document IDs without loading bodies and publishes
document-phase jobs; turn discovery reconciles link metadata and selects only
IDs, including retained deletions. Each document delivery captures only its selected page (when needed), writes
its lexical record, plans its recursive/sliding chunks, and publishes embedding
batches. Turns with many links therefore do not accumulate all page-planning CPU
in one invocation. Document and embedding children load only their selected
canonical document; resource category tombstones remain separate documents.
The final freshness read never recaptures a failed page. Browser failures record
only numeric HTTP status and provider code, preserving the reference in the DLQ
when retries are exhausted. A failed page does not retry sibling documents.

All current message, upload, generated-artifact, and captured-page sources emit
reference-only jobs through their transactional outboxes to the existing regional
`ACTIVITY_QUEUE`. The regional API Worker consumes these jobs. Its source adapters
load the latest canonical text through trusted RPC and return `SearchDocumentBatch`:
source, source ID, scope, stable document ID, revision, and text (null for deletion).
Adapters extract text and preserve authority; they cannot choose chunk sizes,
embedding models, normalization, or indexing behavior. No adapter writes Turbopuffer.

The batch, document and display schemas strip keys they do not name rather
than reject them. A deploy runs the objects and the Queue consumer on different
builds for minutes (see [version skew](#version-skew-between-producers-and-the-consumer)),
so a consumer must index a document from a producer ahead of it with the fields
it understands, and it logs `search_document_keys_ignored` naming the source
(the resource, or the parent, substream and turn) and the stripped key paths
when that happens. A field is therefore added in one deploy and
back-filled by a re-projection migration in a later one: a re-projection that
ships beside the field it needs is partly consumed by the old build and leaves
rows without it, and the log is what says whether that happened.

Resource updates invalidate search only when category or text inputs change:
provider, title, canonical URL, original/derivative MIME types, content references
and hashes, or the string description in metadata. WorkspaceDO migration 43
replaces only the update trigger; insert/delete watermarks and pending retries
survive unchanged. Bookkeeping, hydration status, slug, and unrelated metadata
edits do not publish indexing work. Keep the trigger aligned with
`resourceSearchCategory` and `resourceSearchText` when extending extraction.

**An unlisted resource has no category, and so is not indexed.**
`metadata_json.listing` decides whether a resource is *advertised* — see
[agent attachments](agent-attachments.md) — and `prepareResourceSearch` reads it
before asking for a category. A null category drives every source to
`live = false`, which withdraws a row indexed before it was marked. The trap is
that `listing` is one of the "unrelated metadata edits" above: **the update
trigger does not watch it**, so a write that flips it on an already-indexed row
must enqueue `resource_search_versions` itself or the row stays searchable
forever while absent from every other surface. WorkspaceDO migration 52 is the
worked example.
WorkspaceDO migration 76 widens that trigger to the inputs of a resource's
`audience` (its uploader, attachment status, connection, and whether a Resend
resource is an email) and adds triggers on `authorization_locations`, so an
inventory that attaches or detaches a resource rewrites its rows. The inventory
writer changes only the location rows that differ, so an unchanged inventory
rewrites nothing.
Duplicate description keys use the final occurrence, matching `JSON.parse`.
Content hashes conservatively invalidate same-reference body replacements,
including the one-time hash backfill during extraction.

`createSearchIndexingPipeline` is the single processing path. It writes the full,
lossless canonical text for BM25/substring search, then runs the same chunker and
embedding integration for every live document. Preserving full lexical documents
allows substrings to span semantic boundaries and preserves exact UTF-16 offsets.
There is no lossy per-source normalization. Source-specific fields such as a file's
name and description are assembled before this shared boundary.

Search jobs run sequentially within a delivery. Overlapping deliveries share one
immutable tokenizer per Worker isolate. Unrelated
control-effect messages run concurrently. Source messages are acknowledged after
document-job publication. Document messages are acknowledged after lexical indexing, durable embedding-batch publication,
and canonical revalidation; embedding messages are acknowledged after their batch
and post-write freshness checks finish; individual failures request a
Queue retry and eventually use the existing regional dead-letter queue. Reusing the
existing Queue avoids a second transport and rollout configuration for the same
source references. configured deployments stay on their respective Workers and queues.

### Semantic chunks

`searchEmbeddingJobs` creates recursive passages and overlapping sliding windows
from the same canonical text used for lexical indexing. Recursive splitting tries
paragraphs, lines, sentence endings, and spaces before code-point boundaries.
Identical spans are deduplicated and carry both strategy labels.

The shared constants in `semantic-chunks.ts` set a 512-token maximum and
128-token sliding-window overlap for every source and region. These are code
policy, with no environment or source overrides. Missing provider credentials
pause producers while retaining intents; an already queued job retries failed
vector writes rather than silently disabling semantic indexing. Lexical text is
written first and remains available.

The shared integration loads the Qwen3-Embedding-8B tokenizer's public assets at
immutable revision `1d8ad4ca9b3dd8059ad90a75d4983776a23d44af` and runs them locally
with `@huggingface/tokenizers`. The compressed tokenizer definition and config
ship in the Worker bundle and inflate synchronously on first use in an isolate.
The completed policy is reused without sharing promises or request-owned I/O.
Every token count clears the BPE input cache in `finally`, so only public model
data survives between jobs. Runtime indexing
never downloads assets from Hugging Face. Refresh the pinned assets with
`node scripts/vendor-search-tokenizer.mjs`; their source hashes and Apache 2.0
license ship beside the bundled data. Updating the model revision requires
regenerating these assets and changing the embedding namespace together.
The locked Tokenizers.js implementation compiles its source vocabulary and merge
tables into lookup maps. After construction, the shared tokenizer releases the
unused source tables while retaining runtime maps, vocabulary, normalization,
and framing. Token counting uses `tokenize` with `add_special_tokens: true`,
matching `encode` without allocating token-ID and attention-mask arrays. This
lifecycle depends on the locked library implementation and must be rechecked
when upgrading it; differential tests compare against an unmodified tokenizer.

Each group of chunk ranges is a separate `search_embedding_batch_v1` message on
the same regional Queue. It carries the source reference, document identity and
revision, SHA-256 of the JSON-escaped canonical text, chunk-policy identity, and
up to 64 ranges. It contains no source text or vectors. Publication groups jobs
within Cloudflare's documented 100-message/256 KB limits, accounting for per-message
metadata and the 128 KB individual-message limit. A failed publication leaves
the source job unacknowledged; its retry can safely republish deterministic jobs.

Batch Workers reload the canonical text, verify identity, revision, and hash,
then reconstruct the already-planned ranges. They do not re-chunk the document
or launch Browser Run captures; source deliveries discover links and document deliveries own capture.
Jobs created under an older chunk policy are acknowledged without indexing.
Changing the policy already requires a canonical-source backfill for its new
semantic namespace; letting every old child schedule it would multiply the work.
Embedding inputs are sent as arrays through the existing OpenRouter client, in
chunk order. `SEARCH_EMBEDDING_BATCH_SIZE` in `search-embedding.ts` controls how
many chunks share a request: 64, approved by the team on 2026-09-06. This bounds
one response to 65,536 vector values without limiting total document content. Every chunk is still processed, including a final partial
batch. A missing or extra vector, model drift, wrong dimension, or nonfinite value
rejects that batch before its semantic rows are written. A child first asks the
index whether its batch is already written (below) and, if so, acknowledges
without touching the source. Otherwise it reads the source once before
embedding and checks freshness once after its write: a resource by its
`resourceSearchRevision` watermark, which every input of its text bumps, and a
turn by a second full read, because a link capture can change a page's text at
the same revision. Stale work removes only its exact content
generation. Batches do not change chunk boundaries, namespace identity, or
lexical indexing. Search jobs remain sequential within each Queue delivery.

Counts include tokenizer special tokens. Document embeddings use OpenRouter's
`search_document` task through the existing inference client. The binary boundary
search checks every accepted span; nonmonotonic BPE counts may leave budget unused,
but cannot admit an oversized span. No character-count approximation is used.

Whitespace-only semantic passages are omitted because embedding providers reject
blank inputs. Lexical text stays lossless, and meaningful chunks keep their
original text and exact UTF-16 offsets, canonical source ID, scope, and revision.
The Queue pipeline rejects nonempty optional chunker prefixes: supporting them
requires updating both the range-reconstruction and namespace contracts.
All vectors in a batch are checked before its write. Qwen3-Embedding-8B at 1,024
dimensions is the configured space; a changed model, wrong dimension, or nonfinite
vector fails the job. There is no Qwen/Gemini fallback. Changing model requires a
matching tokenizer, embedding integration, and new namespace.
See the [Qwen model card](https://huggingface.co/Qwen/Qwen3-Embedding-8B) and
[Tokenizers.js documentation](https://github.com/huggingface/tokenizers.js).

Fan-out chunk IDs also include the complete-text generation hash, so two
same-revision extraction results cannot overwrite each other's chunks. Hashing
JSON-escaped text preserves exact UTF-16, including lone surrogates that raw UTF-8
encoding would replace. A strongly
consistent count of the batch's rows lets redelivery skip embeddings already
stored successfully, and it runs before the source read, so a resource batch
already written costs one index query and one revision read, with no document
load. The count cannot use
the IDs, which hash the chunk text the child has not loaded; it counts rows
matching the document, revision, generation and each span's exact
`(chunk_start, chunk_end)` pair instead. That is the same set: a generation is
the hash of the whole text a span slices, so those attributes determine the
text and therefore the ID. Spans are paired rather than matched as two `In`
lists because a recursive passage and a sliding window can share a start. A
missing or partial batch, or rows of another revision or generation, count
short and the batch is embedded; so does a namespace not written since
generation fan-out, whose provider refuses a `generation` filter with a 400 the
count reads as zero. Skipping still runs the post-write freshness
check: a delivery cancelled between its upsert and that check leaves rows no one
validated, and a later revision's source job may already have reclaimed that
generation, so acknowledging unchecked would resurrect them. The source job removes older revisions and legacy
same-revision rows before publishing the new plan. Those rows cannot pass current
canonical validation, so retaining them until the last child succeeds would add
strong queries and stale candidates without preserving usable results. Cleanup
never removes a hashed current generation. Children only reclaim their own exact
generation when canonical validation fails. No completion count, coordinator,
counter, staging bucket, or new Durable Object table is needed.
The regional activity Queues deliver one message per invocation, approved by the
team on 2026-09-06. Each source plan gets a separate invocation CPU budget; this
also changes grouping for the other activity consumers. Each embedding message
performs at most one provider batch request, and acknowledgments remain individual.

Successful batches become searchable progressively; a failed later batch leaves
valid earlier batches in place and retries only its own work. This deliberately
replaces whole-document validation/publication: holding every vector until the
last provider request would recreate the document-sized execution and memory cost
that fan-out removes. Deletion still removes generations through its revision.
Canonical loaders reject obsolete revisions and support validating complete-text
hashes on semantic candidates. The desktop currently calls this loader through
substring retrieval, which returns lexical candidates without generation hashes;
these additional guards become active when a semantic product path uses it. The retained lexical tombstone prevents delayed resurrection.
Different same-revision hashed generations can coexist until a later source revision
reclaims them; current-text hash validation prevents serving stale ones.

Cleanup and upserts share the full schema. The live API evaluates delete filters
before applying the schema in that write, so a specific missing-generation filter
error on legacy namespaces triggers a separate schema write and exact-filter retry.
Other errors stay visible; absent namespaces remain empty until their first upsert. Semantic queries retry without that optional field only when Turbopuffer
specifically reports its absence from an old schema (verified against the live
API on 2026-09-06). Remove this compatibility path after all canonical sources
have been reindexed; legacy rows retain their
existing revision-based validation until replaced. No namespace reset or forced
full backfill is required. A disposable live-provider probe verifies strong counts,
missing-attribute behavior, and cleanup of legacy rows while retaining new chunks.

### Queue recovery

Source jobs (`search_projection_v1` and `resource_search_projection_v1`),
display jobs (`search_conversation_projection_v1`) and
embedding children (`search_embedding_batch_v1`) share the regional activity
Queue with unrelated jobs. Inspect and replay only the failed search messages;
never purge the whole Queue. A display job can be replayed unchanged at any
time: it carries only the conversation address and reads the current title and
archive state when it runs. Malformed embedding jobs retry and eventually
dead-letter rather than falling through to the legacy-message acknowledgment. Publish a replacement durably before acknowledging
or removing its failed predecessor.

A failed current child can be retried unchanged to reuse completed batch rows.
For stale-policy or stale-content children, publish the nested canonical source
reference instead, deduplicating references within the recovery pass. This plans
the current text under the current policy. Old policy children acknowledge without
replanning; stale content children remove only their generation and emit
`search_embedding_stale` with identifiers, never source text. An acknowledgment
therefore does not prove current-source coverage. Source mutations retain their
existing projection publication obligation; semantic policy/namespace changes
require a canonical-source backfill. Queue depth and chunk counts alone do not
establish that all canonical documents have migrated.

Member search first reads the searcher's audience groups from the WorkspaceDO
(`readSearchAudience`, one RPC over tables the object already holds) and adds
`audience ContainsAny <groups>` to the query, so the index returns only rows the
searcher may read. Sources provide server-resolved scope IDs and a loader; search
validates returned candidate metadata, then invokes each loader only for
candidates belonging to its source and scopes. The loader builds results from the
candidate's own attributes; nothing is admitted one by one and nothing is
reloaded from a canonical source.

## Invariants

- Search scope enumeration includes archived and system conversations and has its own complete-list contract. Sidebar visibility is not search readability.
- The searcher's audience groups decide which rows member search returns: a row is a candidate only when its `audience` shares one of them. This reverses the earlier rule that an index attribute never grants access, deliberately and only for search (see the 2026-09-28 changelog entry). The groups are computed live on every search by `readSearchAudience`, the only code that computes them. It decides each conversation through its parent's own `readableSubstreams`, and each Sidekick and connection through the predicates canonical authorization shares (`sidekickAdmitsMember`, `owningChannelAdmitsMember`, `connectionAdmits`). A Sidekick homed in a Breakout goes to whoever reads that Breakout, the audience its viewer admission uses. A Channel's `space:<id>` group goes to whoever reaches that Channel (`WorkspaceSpaceStorage.reach`), the rule the resource check applies to what a merge shared with it. Search adds two narrowings of its own (a guest never holds a workspace connection, and reaches a Channel-owned Sidekick only through management access) and skips archived Channels and Spaces, whose rows member search never returns. The attribute still grants nothing beyond the excerpt: opening a row keeps its own canonical check. Scope prefilters remain an optimization, and `connection_id` grants nothing.
- The response never reports what it omitted. A failed group read fails the search (the route's 503); it never returns an unfiltered page.
- A row without its display attributes, or with `archived` set, is never returned. Member retrieval filters on `archived Eq false`, which a null attribute does not match, so neither kind consumes a candidate page; the read path checks the same value again on every row it renders. Omission is the safe failure; nothing falls back to a canonical reload.
- Every writer of a conversation's display writes the current state it reads beside the text: the producer at upsert time, the patch job when it runs. A display job names the conversation and never carries a title, so a delayed or redelivered job cannot write an old one; the pipeline's post-write fence retries an upsert whose display changed underneath it, and the patch job re-reads the display after patching and retries when it changed, so two overlapping deliveries for one conversation converge on the newest state rather than the last to run.
- A resource result's time is the resource's `updated_at` as of its last search-input change. Bookkeeping writes (processing state, webhook provenance, hydration stamps) bump `updated_at` without requeueing the row, on purpose, so the index shows when the content last changed rather than when the row was last touched.
- Public cursors identify consumed candidate positions and never grant access. Fully rejected pages may expose continuation; index-existence concealment is not part of this member-only API.
- The search document contract changes additively across deploys. A field is added in one deploy and back-filled by a re-projection migration in a later one, never the same one: the consumer strips what it does not know, so a re-projection consumed during the skew window writes rows without the field. Stripping tolerates nothing else: a renamed or removed field leaves a required key missing on the old build, which is the 2026-09-10 failure again, so a field is removed only once no build that requires it can still consume, and a rename is an add followed by that removal. The Queue envelope schemas stay strict, so a new envelope field is a new message type rather than an added key.

- One tokenizer is retained per isolate (about 26 MiB after releasing construction
  tables in a local Node 22 heap measurement). Its model stays closure-private; only the policy wrapper is
  frozen. Input fragments must be cleared before every count returns or throws.
- Chunk offsets use the sorted code-point boundary array directly; do not add
  a per-character Map and its transient construction pairs.
- Each request reads the searcher's groups again, so a revocation takes effect on the next search; a request already past its group read may still finish with the old groups. A repeat served from the desktop's 30-second window is not a new request and readmits nothing, so that window is how long a revoked excerpt can stay on screen. The window runs from the first page's admission, not from the last continuation, because the pages of one query share a single freshness stamp and paging would otherwise renew a page nobody had readmitted. For two of the three row kinds what it exposes is the excerpt, because opening the row is its own authorized read: a message row hydrates its canonical transcript, a file row goes through `/search/resources/:id/preview`. A **link** row is the exception, and the exception is not only about the excerpt. Opening one hands `location.url` straight to the browser and asks nobody, and that URL is never rendered — the row shows the excerpt and the source label — so it is content behind the row rather than something the reader had already seen. The window therefore extends by up to 30 seconds the period in which a revoked link can be opened without a check. Re-deriving a link on click, the way the other two kinds are, is the fix if that is not acceptable; it needs an endpoint that does not exist, and would change link-opening on every path rather than only the cached one. Signing out, surrendering the active workspace, or losing the stored credential all clear the client (`queryClient.clear()`), and changing workspace or member is a different key, so none of those carry the window across.
- Namespace identity includes the embedding model and dimensions. Mixing spaces
  makes vector distances meaningless.
- A row's `audience` names where it lives (its conversation, Sidekick, connection, uploader and, for a resource, the conversations it is attached in and the Channels a merge shared it with, `space:<id>`), never the people who may read it. A person's access changes must never require rewriting rows; a row is rewritten only when its own location changes. An empty or absent audience admits nobody: organization-wide readability is the explicit `members` group. Every group becomes a UUID only through `searchAudienceGroupId`.
- Deleted revisions win against replayed upserts at the same revision. Removing
  a tombstone prematurely can allow an old write to resurrect a document.
- Keys remain server secrets; callers cannot select credentials or a namespace.
- A provider error is not an empty result. Callers must distinguish unavailable
  retrieval from a successful search with no matches.

## Boundary

The module owns the Turbopuffer protocol, source selection, member search API,
durable projection scheduling, matching excerpts, chunking, embeddings, and generation reclamation.
The protected `POST /search` endpoint accepts a query and category. The modal's
All, Messages, Links, Artifacts, and Files tabs use literal case-insensitive
substring retrieval. BM25 and ANN are available at the shared boundary but are
not yet exposed through this member endpoint.

The modal's Channels and Spaces tabs, and the places All lists above content,
never reach this endpoint: they match names in the lists the desktop already
holds. No tab searches until the query is three characters long
(`SEARCH_MIN_CHARACTERS`, a number the team set).

Admission is the `audience` clause (see Invariants); loaders only render and
never read an owner. The route revalidates the workspace session before
returning. The index returns candidate identifiers, the canonical text and the
display attributes the owning object wrote beside it. Excerpts
contain UTF-16 source ranges and excerpt-relative highlight ranges; React renders
matching spans as text. Selecting a message hydrates its canonical sequence and
positions the transcript. Selecting a file opens `/search/resources/:id/preview`, which repeats attachment
authority and session checks after loading, and refuses a changed source. That
preview does not yet scroll to the matching range.

The intended external-search boundary is provider discovery followed by shared
Turbopuffer ranking. Provider-discovered candidates need request/principal
isolation and cleanup; simply adding them to a workspace namespace would grant
an inappropriate shared lifetime to private provider results. This path is not
yet implemented.

## Failure modes and limits

Missing credentials throw `search_credentials_unavailable`. Semantic
retrieval without a query embedding throws `search_embedding_required`. Provider
write/query failures become content-free errors. The HTTP route returns a generic
503 rather than exposing provider payloads. A nonexistent namespace is empty
before its first write; other provider failures are not treated as empty results.

A search never waits for a canonical owner: an undecided candidate is omitted and
filled after the response. A `search_conversation_projection_v1` job that
dead-letters leaves a conversation's previous title, or an archived conversation's
rows, visible to admitted readers until it is redriven; a text rewrite that
dead-letters leaves its row omitted, because a row carries no display until it is
rewritten. The display rewrite itself is lazy: migration 52 requeues a
conversation's turns when its SubstreamAgent next wakes, and WorkspaceDO
migration 47 a workspace's resources when that object does, so a conversation
nobody opens and no alarm reaches keeps rows with no display, which search omits
with no error and no dead letter. The patch job cannot repair those rows either,
because its filter requires the `substream_id` they lack. The forcing function
is the migration tracker's **Force a migration** for both classes, under
Operations below; until it has run in a region, "not yet rewritten" and "never
rewritten" look the same from search. Edited or deleted text stays findable by admitted readers until its
rewrite or watermark lands, typically seconds. The team accepted this window,
with ten minutes as the bound the projection chain is expected to meet and a
non-empty dead-letter queue as the signal that it did not.

### Version skew between producers and the consumer

The objects pick up a new Worker version on their next request; a Queue
consumer isolate keeps running the previous version until it is recycled, which
on 2026-09-10 was about twenty-five minutes. In that window an old consumer
receives documents shaped by the new build. Until this change the schemas were
strict, so a document carrying a field the old build did not name failed to
parse; the job retried (five retries, no configured delay) onto whichever
isolate next took it, and 19 of 535 rejected deliveries exhausted their retries
into the dead-letter queue. Their publish intent was already gone: `publishResourceSearch`
clears `pending` and the outbox deletes a turn's row when the Queue accepts the
reference, not when the index write lands. A dead-lettered rewrite therefore
leaves its row exactly as it was (for that deploy, without `connection_id` and
the display attributes, so search omits it) until the source next mutates,
which for a connector resource can be never.

The batch, document and display schemas now strip unknown keys, so the window
produces rows written to the old contract instead of dead letters, and the
document phase names the source and the stripped keys in
`search_document_keys_ignored`, which is what the 2026-09-10 retry log lacked:
the rows a future window writes behind the contract can be listed from that
log and re-projected on their own. The embedding phase parses through the same
tolerant schemas but does not log. It does write the stripped fields: a chunk
row is built from the whole document, so it carries `substream_id`,
`connection_id` and every display column exactly as the lexical row does. What
makes that harmless is that nothing reads them off a chunk row: the display
columns are requested only in substring mode, which reads the lexical
namespace, and `connection_id` is not filterable, so it admits nothing. That is
also why a re-projection leaves chunk rows alone (`countSemanticChunks`
short-circuits the upsert when the chunk ids already exist) and why a future
change that starts reading an attribute off a chunk row has to add the
embedding phase to the log and to the re-projection. What the window does not
produce is a row with the new field: the deploy rule in
[One Queue pipeline](#one-queue-pipeline) exists because only a re-projection
that runs after the window rewrites those rows.

The tolerance is additive only. A renamed or removed document field leaves a
required key missing on the old build, which is a ZodError, five retries and a
dead letter with the publish intent already cleared: the incident again. The
invariant above says how a removal is sequenced. The Queue envelope schemas
(`SearchDocumentJobSchema`, `SearchEmbeddingBatchSchema`, the source and
display messages) stay strict, and a field added to one of them reproduces the
incident one level up, on the message rather than the document. That is a
deliberate boundary rather than an oversight: a document field is payload the
index stores and the same build's read path reads back, so an old consumer
that drops one writes a row the next re-projection repairs; an envelope field
is an instruction to the consumer, and an old build that drops one runs a job
it only half understands, which no re-projection notices. Strictness is not
what tells the job kinds apart (each fails the other's required fields), so a
new envelope field is a new message type, which the old build retries as
unrecognized rather than acknowledging. One transitive change to note: the
`document` inside `SearchEmbeddingBatchSchema` is derived from the document
schema and is therefore tolerant now, while the envelope around it is not.
Migration 53 re-queues only
turns still present in `participant_transcript_turns`; a deletion tombstone
whose job dead-lettered is not repaired by that pass, which no code path can
produce today because nothing deletes a turn. Clearing the intent on
successful indexing rather than on publish would make a dead letter
recoverable by the object itself; that is the open question below.

Turbopuffer requires a valid embedding for live documents in a vector-enabled
namespace. Callers must retain failed projection work for retry. The service does
not invent retry limits or result caps; the caller supplies its product limit.

Each request consumes one candidate page and may return fewer or zero canonical
matches. Substring pagination returns the last consumed candidate position when
the candidate page is full. Nonpaginated clients receive only the result array,
so they cannot continue and may miss matches beyond that first page. BM25 and
semantic retrieval have no continuation cursor. The desktop exposes substring continuation through
scroll and its pagination footer.
The cursor follows [Turbopuffer attribute pagination](https://turbopuffer.com/docs/query#pagination).

## Testing

`apps/api/test-workers/resource-update-cost.test.ts` exercises the populated v42
upgrade, each search input, duplicate description keys against canonical extraction,
no-op writes, and deletion watermarks using real workerd storage.

Run `pnpm --filter @rally/api exec vitest run test/text-search.test.ts test/semantic-chunks.test.ts test/search-embedding-policy.test.ts`.
The external SDK is doubled to prove source filtering and canonical result
loading. No database or Durable Object runtime is simulated by this suite.

Disposable live namespaces in both configured regions verified literal asterisk
substring matching, conditional upserts, deletion watermarks, and rejection of
same-revision resurrection. The namespaces were deleted after verification.
Generation deletion filters also preserved newer vectors in configured deployments. Production content was not used for these checks. Vector-free lexical writes
and tombstones were also checked in configured deployments. Workerd tests cover resource
revision watermarks, upgrading committed transcript history, transactional search
intent, and rejecting stale link labels. `test-workers/search-indexing-pipeline.test.ts`
drives the Queue consumer through real source RPC and R2 reads, verifies identical
chunks across messages/files/artifacts/pages, and proves concurrent deletion causes
generation cleanup and retry. Its only doubles are external APIs/model assets.
It also records the WorkspaceDO RPCs an embedding delivery makes, through
`helpers/counting-namespace.ts` over the real namespace, proving a written batch makes only a revision
read, and a new revision makes one document read and one revision read. A written
batch whose revision has since moved on is reclaimed rather than acknowledged. A resource's content
change is staged the way production makes it (a new `content_ref`, which bumps
the revision), not by overwriting R2 in place.
The pinned Qwen tokenizer was separately exercised in workerd with its actual
public model assets served from a temporary local mirror. The same pipeline suite
proves the display attributes each producer writes and the patch passes a renamed
or archived conversation runs; `test-workers/search-projection.test.ts`
covers the display trigger, its outbox channel, the migration-52 requeue and the
migration-51 and migration-53 re-projections against a cleared watermark and a
drained outbox row; `test/search-document.test.ts` covers the contract accepting
a document from a build ahead of it and naming the keys it dropped;
`test-workers/search-audience-person.test.ts` proves the person side against the
design's rule table; `test-workers/conversation-parent-contract.test.ts` proves
the index returns only what a reader's groups admit, including after revocation;
`test/search-route.test.ts` proves the HTTP boundary fails closed;
`test/scoped-memory.test.ts` proves the typed tables check each run canonically,
and ask the WorkspaceDO for each scope once per isolate while deciding
writability per call; `test-workers/workspace-memory-search-key-purge-migration.test.ts`
proves WorkspaceDO migration 84 removes memory search's keys and nothing else.
The executor's group is proved in `automation-directory.test.ts` and
`automation-do.test.ts`. The old store's suites remain until phase 4 deletes it.
A disposable live namespace in gcp-us-west1 verified on 2026-09-28 that
`ContainsAny` over a `[]uuid` attribute returns exactly the rows sharing a group,
that a row with an empty or absent audience never matches, and that the clause
composes with `IGlob` and the `id Gt` cursor. A disposable live namespace in gcp-us-west1 verified on
2026-09-10 that the display attributes can be added to an existing namespace,
that `text` returns with the row, that `patch_by_filter` reports `rows_patched`
and matches nothing on its second pass, that a tombstone is untouched, and that
a row without `archived` does not match `archived Eq false`. Component tests cover tabs, keyboard
selection, stale responses, and error presentation. The modal was inspected in a
real Electron window using synthetic results; this is not production end-to-end
search verification.

## Operations

WorkspaceDO migration 33 creates `resource_search_versions`, installs resource
write triggers, and queues existing resources. SubstreamAgent migration 42 adds
`conversation_search_links`, transcript write triggers, and backfills existing
participant turns into `durable_outbox` under `search_projection_v1`. Both use
existing regional `ACTIVITY_QUEUE` transport with reference-only messages. The
consumer reloads current source state and conditionally writes its revision.
Resource watermarks survive deletion; transcript deletes publish tombstones.
SubstreamAgent migration 52 installs the `workstream` title/archive trigger behind
the `search_conversation_v1` channel and requeues every committed turn once so its
lexical row is rewritten with the display attributes; WorkspaceDO migration 47
marks every resource pending for the same rewrite. A row is omitted from results
until its rewrite lands, so a workspace's search fills in as its objects wake and
the Queue drains. WorkspaceDO migration 51 and SubstreamAgent migration 53 run
those two passes a second time, to rewrite the rows whose jobs the 2026-09-10
version skew dead-lettered; the retry log carries no resource or turn id, so
the affected rows could not be listed and the whole fleet re-projects instead.
Both migrations are lazy in the same way as 47 and 52: use **Force a
migration** for both classes in each region to make the pass complete, then
watch the regional activity Queue drain and its dead-letter queue stay empty.
WorkspaceDO migration 77 and SubstreamAgent migration 70 run the same two
passes a third time, so every lexical row written before migration 76 is
rewritten with its `audience`. Existing semantic chunk rows keep no audience
(see the changelog). Force both classes in each region, then confirm with a
Turbopuffer count that no live lexical row lacks `audience` before search
filters on it. This pass does leave dead letters: every link whose capture
failed before is captured again, and one that still fails throws
`search_capture_retry_required` after its lexical row is written, so its job
exhausts the activity Queue's retries (six Browser Run calls) and dead-letters.
Those are expected and harmless; count them against the
`search_link_capture_failed` logs, and treat any other dead letter as real.
Since the 2026-09-28 change member search filters on `audience`, so a row still
missing it is invisible until its object migrates: force the migrations before
that deploy, and re-count afterwards. The old search-authorization store is no
longer pushed or read; its tables and triggers stay until phase 4 drops them, so
a Worker rollback finds the recorded targets and must be followed by a full push
(migration 48's pass). WorkspaceDO migration 84 has already deleted the keys
memory search registered per run; a rollback past it re-registers them on the
next memory search, as before. Their Global `AUTHORIZATION_CACHE` copies were
written without a TTL and stay, unread, until phase 4 retires the namespace.

A WorkspaceDO dispatches resource references 100 at a time. While more are due
after a batch, the next waits `RESOURCE_SEARCH_BACKLOG_INTERVAL_MS` (60
seconds), so a backlog drains at 100 resources a minute (Juno Labs' 152,000 in
about 25 hours); an edit arriving with no backlog goes at once. Batches go out
lowest `not_before` first, so a re-projection written at `not_before = 1` lets
edits (written at `0`) through ahead of it. To pause a workspace's backlog,
move its pending rows' `not_before` far ahead
(`UPDATE resource_search_versions SET not_before = 4102444800000 WHERE pending = 1 AND not_before <= 1`);
to resume, set those rows to `1`.

Object alarms dispatch pending references only when the regional Turbopuffer key
and `OPENROUTER_API_KEY` are present. Otherwise intents remain pending and search
due-times are excluded from alarms. Provision credentials and wake the objects to resume. Queue acceptance clears only the
revision dispatched, so a concurrent edit remains pending. Dispatch failures use
the existing regional outbox retry interval; projection failures remain Queue
failures and follow its configured retries and dead-letter handling. Once a job
reaches the DLQ its original dispatch intent has already been cleared. Recovery
requires redriving the dead-letter reference; a routine wake does not recreate a
completed migration's backfill INSERT. New source edits produce new intents. Do
not discard DLQ messages or assume a migration report repairs their contents.

Deploy both API Workers with their `BROWSER` binding and production Turbopuffer
secret before running backfill. The 512/128-token policy ships with the code.
`pnpm env:sync` forwards the development key from `.env.local`; it never copies the production key into
development Workers. Use the existing migration tracker's **Force a
migration** action for WorkspaceDO and SubstreamAgent in each region to wake
stored objects; an untouched object does not migrate just because code deployed.
See [Durable Object migration tracking](durable-object-migration-tracking.md).
Verify migration reports, regional activity Queue drain and dead letters, then
perform member searches and revocation checks. A current schema report proves
schema application, not successful indexing. For this change the forced wake is
what turns the display rewrite from lazy into complete: a SubstreamAgent that
never wakes never requeues its turns, and its conversation stays out of search.
These deployment and fleet-backfill steps have not been run for this change.

Browser Run captures Markdown asynchronously from links present in a canonical
participant turn, including completed web fetch records. Link text and URL are
indexed by the shared pipeline after the capture attempt, including failed attempts. Captures live in the originating substream's SQLite table and
retain that substream's audience. Removed links are rejected at read time before
their deletion job runs. Failed captures retry without recapturing successful
links in the same turn. Captured pages are snapshots, not a continuously refreshed
web index. File contents use existing R2 text derivatives or readable originals,
including JSON, JavaScript, and XML through the shared attachment classifier;
missing derivatives cannot produce body matches until extraction completes.

## Open questions

A source's publish intent is cleared when the Queue accepts the reference, so a
job that dead-letters leaves nothing behind to republish it and recovery is a
fleet-wide re-projection or a manual redrive. Clearing `pending` (and the outbox
row) on a successful index write instead would let the object republish on its
own: the pipeline already treats a redelivered job for an indexed revision as a
no-op. It needs a completion RPC from the consumer back to each object, a lease
so an unacknowledged reference is republished after a delay rather than on every
alarm, and that delay is a number for the team to set. It was left out of the
2026-09-11 change as too large for an incident fix.

Production deployment and backfill remain to be completed and verified; the
512/128-token policy requires no environment configuration. Agent memory's
facts (when semantic recall is wanted, per its PRD), notes/table text, agent
tools, and external provider ranking still need migration.
Conversation discovery queries the workspace namespace and authorizes each hit;
archived parents and automation runs still require navigation/coverage verification.
BM25/semantic canonical filtering can shorten a page; their refill and client
pagination are not implemented. Substring clients that supply pageSize can
explicitly continue; legacy clients receive only the first candidate page.

## Security and trust model

A row's `audience` decides whether member search returns it (see Invariants);
a bug on either side shows rows rather than hiding them, so each side has one
implementation and the person side is tested against the rule table. Opening a
row keeps its own canonical check, and attachment access checks the exact owning
child.

The public tokenizer commit is an identifier, not a secret. Production and
development keys must have appropriately separate provider permissions; namespace
names are not credential isolation. No key reaches the renderer. Browser capture
is unauthenticated public-page retrieval explicitly requested for posted links;
it sends no user browser cookies or connector credentials. The URL helper rejects
literal local/private hosts, including mapped and site-local IPv6, but is not a DNS
or redirect firewall. Browser Run executes remotely rather than on a user's or
Worker's private network. Captures are snapshots and are not refreshed just because
the same URL is mentioned again. Missing extraction/capture work remains observable
through Queue failure rather than silent truncation. Document-size and capture
budgets require team policy; no arbitrary new caps are introduced here.

## Changelog

### 2026-10-19 — A Channel's own messages are indexed

**What changed:** WorkspaceDO projects `space_messages` into the shared index
as source `channel_messages` (migration 119, `channel-message-search-projection.ts`),
following the resource projection: a version table kept by triggers, an alarm
lane that publishes references, and a Queue delivery that calls back for the
document. Every existing Channel message is queued once. The agent's
`conversation_search` queries it beside `messages`.

**Why:** A Thread's agent asked to use "the ICP above" had to find a result
merged into its Channel, and merges are Channel messages, which nothing
indexed. The first draft searched them with SQL inside WorkspaceDO; the product
owner asked for one search path instead of two.

**Considered and rejected:** A search in WorkspaceDO's SQL: a second matching
rule (SQLite's ASCII-only `lower`) and a second place that decides what a
merge tells a reader. A new audience group: `space:<id>` already admits exactly
the Channel's readers, for the artifacts a merge shared there. The merged
thread's title on the row: a reader of the Channel may not be allowed to see
it, and a row's display is the same for every reader.

**Consequences:** A Channel rename rewrites all of its messages' rows.
`removeChannelMessage` and a merge arm the alarm so their rows move at once;
a Channel's opening messages written at creation wait for the object's next
wake. The lane shares `resourceSearchPace`, so a resource backlog delays
Channel messages too. A reader holds a Channel's `space:` group by the same
listing rule (`spaceListing`) that decides which Channels the agent's tools
list, so a Channel the tools offer is one whose messages search can find.

### 2026-10-05 — Channels and Spaces tabs in the search modal

**What changed:** The modal gains Channels and Spaces tabs after Files. Each
matches names from the lists the desktop already holds and opens the chosen
place; neither calls `POST /search`. Breakouts are listed under Channels, each
row wears its place's own coloured mark, and All lists matching places above
the content results. Every tab waits for a three-character query.

**Why:** The modal found content but not places. The desktop holds every Space
and, through the Space walk, every Channel the reader can open, so matching
there answers on the keystroke with no index rows, no Worker round trip and no
debounce.

**Considered and rejected:** Indexing Channel and Space names in Turbopuffer,
which needs a new row kind with its own audience and re-projection on every
rename and membership change, for lists the client already has. A server name
filter on the WorkspaceDO directory, which adds a round trip for the same
answer.

**Consequences:** These tabs are only as complete as the desktop's Channel and
Breakout lists: the sidebar's walk of every Space, the member Breakout lists and
the shared navigation directory together make them complete, and without those
they need a server source. All has no cap on places, and a cap is the team's
number to set.

Shipped in #1103.

### 2026-09-28 — Embedding batches check the index first; memory search drops its per-run keys

**Embedding batches.** A delivery now counts its batch's rows in the index
before reading the source, matching document, revision, generation and each
span's exact `(chunk_start, chunk_end)` pair, since the chunk IDs hash text it
has not loaded. When the batch is already there it skips the load and the
embed but still runs the post-write freshness check — one
`resourceSearchRevision` read for a resource, one full load for a turn — because
rows alone do not prove their writer ran that check, and acknowledging unchecked
could resurrect a generation a later revision already reclaimed. A resource's
freshness check after a write is that same revision read rather than a second
load. *Why:* on 2026-09-27 about 10,000 `prepareResourceSearchDocument` calls an
hour came from embedding deliveries, and about 98% loaded the document twice and
embedded nothing, because re-projections (migrations 47, 48, 77) and
redeliveries re-send written batches; each load reads R2 inside the object the
backlog pacing protects. *Rejected:* a ledger of completed batches, which
duplicates the index rows; counting by generation alone or by two `In` lists,
which can count another batch's rows; a revision read for turns, whose captured
pages can change text at the same revision. *Respect:* the skip is exact only
while a chunk ID is a function of (document, revision, generation, range) and a
generation hashes the full text; the resource fence holds only while every input
of `resourceSearchText` and `resourceSearchCategory` bumps
`resource_search_versions`; and a namespace not written since fan-out has no
`generation`, which the count must read as zero rather than fail.

**Memory search.** WorkspaceDO migration 84 deletes every search-authorization
key whose delegation starts with `memory-search:v1:`, with its snapshot, its
dependency rows, and the push row of a scope no other key names; the rest of the
old store waits for phase 4. `ensureScope` caches each scope row per isolate, so
repeat searches make no `ensureMemoryScope` RPC; `writable` is still decided per
call. *Why:* each key named one run and none is read again, yet one scope held
628 that a rollback's full push would walk; `ensureScope` ran about 453 times an
hour for rows that never change. *Rejected:* waiting for phase 4; finding keys
by shape rather than delegation; a KV sweep of the unread Global copies, which a
migration cannot make; caching `writable`, which depends on the caller's role.
*Respect:* the cache invariant in
[agent harness](agent-harness.md#scoped-durable-memory).

### 2026-09-28 — Member search filters on the searcher's audience groups

**What changed:** Member search reads the searcher's audience groups once per
request from the WorkspaceDO (`readSearchAudience`) and adds
`audience ContainsAny <groups>` to its Turbopuffer query; loaders no longer
admit candidates through the projected search-authorization store. Memory
search checks each run with `resolveMemoryAccess` directly. The old store is no
longer pushed (the alarm stops flushing, and the Queue drops push jobs) or read.
`automation_directory` gains `run_as_user_id` (WorkspaceDO migration 81; each
Sidekick republishes its row once through SidekickDO migration 10) so a
Sidekick's executor holds its group.

**Why:** Phase 3 of docs/PRDs/2026-09-26_search-audience-filtering. The store
cost work proportional to people times documents on every change: at Juno Labs
about 3,000 register and write calls an hour (58 s of CPU), most from memory
search registering a new key per agent run that re-checked every earlier run's
keys, plus one alarm wake per registration. Admission after retrieval also left
pages empty and filled decisions after the response. Revocation now takes effect
on the next search instead of within a push delay.

**Considered and rejected:** Computing a person's groups from a cached list
(KV or a per-person table), which adds a write pipeline and staleness for a read
that is one object RPC over tables the object already holds. Recomputing access
rules in a new module: the person side calls the parent's own
`readableSubstreams`, and the Sidekick and connection predicates moved to
`authorization-policy.ts` where canonical authorization calls them too, so each
rule has one implementation. Batching that call into one query per table across every
Channel was also rejected for now: it would restate `canReadConversation` in
set form. Instead each parent reads its facts for the person once
(`conversationReadFacts`, about eight statements) and decides every
conversation from them, which took a local 320-Channel, 1,280-conversation
Organization from about 85 ms to about 23 ms per search; the per-conversation
reads had cost six to eight statements each. A Sidekick that changes hands
republishes its directory row in the same write, since the executor's group
comes only from that row.

**What a future change has to respect:** Search is only as correct as the
coverage of `audience`: a live row without it is invisible, so a new producer
must write it and a new row kind must have a group. Guests hold only their own
group, conversations they are admitted to through grants or a Breakout, and
Sidekicks reachable through management access on the owning Channel. The group
read runs inside the WorkspaceDO on every search and grows with the number of
Channels and conversations, so keep per-parent work to reading facts once;
anything that writes who runs a Sidekick must republish its directory row. Semantic
chunk rows still carry no audience, so any semantic read path must backfill it
first (2026-09-26 decision).

### 2026-09-27 — The resource backlog interval is 60 seconds

**What changed:** `RESOURCE_SEARCH_BACKLOG_INTERVAL_MS` is 60 seconds, so a
backlog drains at 100 resources a minute instead of 200.

**Why:** At 30 seconds, after the child-effect scan was fixed, Juno Labs'
WorkspaceDO ran the audience backfill for five hours with no failures at first,
then turned away a rising number of calls (360, 1,031, then 1,381 an hour) as
the old search-authorization store's pushes grew beside it, and one connector
event failed for good. The backfill was paused with 50,574 resources left.
Adam chose to halve the pace rather than accept rare lost connector events or
wait for phase 3 to retire the store.

**Considered and rejected:** Resuming at 30 seconds; the lost event is the
failure this pacing exists to prevent.

**What a future change has to respect:** a whole-workspace re-projection now
takes the workspace's resource count divided by 100 a minute. Revisit the
number once the search-authorization store is deleted (the audience-filtering
PRD's phase 4), since it was chosen with that store's load still present.

### 2026-09-26 — A resource is indexed in its source delivery

**What changed:** A `resource_search_projection_v1` delivery no longer fans out
one document job per category. It reads all three category documents from the
WorkspaceDO in one `prepareResourceSearch` call, writes or withdraws each, and
confirms with a second read. Embedding batches are unchanged.

**Why:** Each document job read the WorkspaceDO twice, so a resource cost six
calls into that object, two thirds of them only to learn the resource was not
in that category, and each batch of 100 resources arrived as 300 concurrent
jobs. At Juno Labs that burst queued behind 700 ms child-effect calls and
overloaded the object even when paced to 200 resources a minute. It is now two
calls per resource and 100 concurrent jobs per batch.

**Considered and rejected:** Keeping the fan-out and skipping the object read
for non-category documents; a category can change between reads, and the
tombstone must be written at the current revision, which only the object knows.

**What a future change has to respect:** turns still fan out, because a turn's
links each need their own capture. A resource source that grows a document
needing independent retries must fan out again.

### 2026-09-26 — A workspace's resource backlog is dispatched 100 every 30 seconds

**What changed:** After the WorkspaceDO dispatches a full batch of 100
resource references, its next batch waits
`RESOURCE_SEARCH_BACKLOG_INTERVAL_MS` (30 seconds) if anything due is still
pending, and its alarm is set for then. Once the backlog is gone no wait is
set. The wait is held on the object, not stored; an eviction or restart forgets
it, and the object dispatches one batch early if something wakes it inside the
wait.

**Why:** Migration 77 marked all 152,000 of Juno Labs' resources pending, and
the alarm dispatched batch after batch with nothing between them. Each
resource becomes three document jobs, and each job calls
`prepareResourceSearchDocument` back on the same object, which returned
`durable_object_overloaded` to 38,000 calls in 30 minutes and failed connector
events and search-authorization pushes beside them. The backfill was paused by
hand (`not_before` set to 2100-01-01 on the pending rows) until this shipped.
Adam set the interval: 200 resources a minute, about 10 calls a second into the
object, finishing Juno Labs in about ten hours.

**Considered and rejected:** Acknowledging completion from the consumer so the
object dispatches only when the previous batch is done (the open question
above); right, but too large for an incident fix. Pausing by pushing
`not_before` forward on every remaining row after each batch; it rewrites the
whole backlog on every batch.

**What a future change has to respect:** a whole-workspace re-projection is now
bounded by this interval, so its duration is the workspace's resource count
divided by 200 a minute. A change to the batch size or the jobs per resource
changes the load this number was chosen against. Batches go out in
`not_before, resource_id` order and every edit trigger writes `not_before = 0`,
so a backlog also written at `0` interleaves with live edits by id, and a new
resource (the newest UUIDv7) waits behind the whole backlog. A whole-workspace
re-projection must therefore mark its rows `not_before = MAX(not_before, 1)`,
so edits sort ahead of it.

### 2026-09-26 — Rows carry the groups that may read them

**What changed:** Every lexical and semantic row gains `audience`, a `[]uuid`
of the groups that may read it, written by its producer beside the text:
`conversation:<parent>/<substream>` or `sidekick:<automation>` for turns and
captured links; for a resource, its connection alone, or its uploader, the
`members` group where the provider is readable by every member, and every
conversation its canonical inventory places it in. WorkspaceDO migration 76
rewrites a resource when any of those inputs changes. Search does not read the
attribute yet.

**Why:** It is the first step of
[search audience filtering](PRDs/2026-09-26_search-audience-filtering/prd.md),
which moves the read decision into the Turbopuffer query and deletes the
per-(person, document) decision store in WorkspaceDO. That store re-derived
about 152,000 keys a day for a 6,738-key store at Juno Labs and leaked a key per
agent run through memory search. The field ships alone because of the version
skew rule above: a consumer on the old build strips it, and the next deploy's
re-projection fills the rows the window wrote without it.

**Considered and rejected:** Storing reader user IDs on rows, Turbopuffer's
simplest permissions example; every roster change would patch every row of a
Channel, and each patch is billed at least one query over the whole namespace.
A separate audience patch job for attachment changes; the resource
re-projection already rewrites the row, at the cost of re-embedding the
resource's chunks on each attach or detach, which is rare.

**What a future change has to respect:** a new way for a person to reach a row
belongs on the person's side, not in the row's audience, unless it is a
property of where the row lives. The re-projection that backfills `audience`
does not rewrite existing semantic chunk rows (their IDs already exist), so a
semantic read path must not filter on `audience` until those rows carry it.

### 2026-09-11 — An unlisted resource leaves the index

**What changed:** `prepareResourceSearch` gives an unlisted resource no
category, so its three source documents go out as `live = false` and a row
indexed before it was marked is withdrawn.

**Why:** Listing is the resource graph's new split between *reachable* and
*advertised* ([agent attachments](agent-attachments.md)), and search is an
advertising surface. Terminal's repository-replacement backup was the case that
forced it: a 21 MiB archive nobody asked for, answering a search for its own
title.

**Considered and rejected:** Widening the migration 43 trigger to watch
`$.listing`. That is the tidier-looking fix and it is a trap — the trigger's text
is frozen inside a receipted migration, so widening it costs a new version *and*
still leaves every already-indexed row unenqueued, because a trigger only fires
on writes that come after it.

**What a future change has to respect:** A write that changes `listing` on an
indexed resource carries its own `resource_search_versions` enqueue. The trigger
will not do it, and the failure is silent — the row simply stays in results.

### 2026-09-11 — Hold a settled search for 30 seconds on the desktop

Every settled query was a Turbopuffer page and a projection read, including the
ones a reader did not mean to ask for: backspacing over a term and typing it
back, crossing the tabs and returning to All, closing the modal and reopening it
on the same words. `staleTime: 0, gcTime: 0` made each of those a full round
trip for a list that had just been on screen. The modal now holds a settled
query's pages for 30 seconds, the team's number.

This reverses the "no search-result cache is introduced" line this document
carried, and the comment beside those options — "a search result must be
reauthorized when this modal opens again" — was the decision, not an oversight.
What it protected is narrower than it reads. A page is admitted per candidate
through the projected decision, and that projection is already eventually
consistent: a revocation reaches it within its push delay, so an admitted result
could already outlive the access behind it. The window adds 30 seconds to a
delay that exists, for an excerpt the reader is already looking at, and acting
on the row is authorized when it happens — a message hydrates its canonical
transcript, a file goes through `/search/resources/:id/preview`, both of which
re-check. Sign-out clears the client (`queryClient.clear()`) and the modal is
keyed by workspace and member, so neither a departure nor a switch carries the
window across. A future change that widens what a row shows, or that lets one be
acted on without its own read, has to revisit the number rather than inherit it.

Two corrections came out of review, and both are recorded here because the first
draft of this entry claimed more than the code did. **The deadline is absolute.**
Every page of one infinite query shares a single freshness stamp, so a plain
`staleTime` let each continuation renew every page before it — scroll for two
minutes and the first page, admitted at the start, still repainted unadmitted.
It is now anchored on the first page's admission and expressed relative to that
shared stamp, since `timeUntilStale` adds it to that rather than to now. Tracking
freshness per page was the alternative; the library has one stamp per query, and
an absolute deadline gets the guarantee the team agreed to without shadowing it.
**And "every row action re-checks" was false for links.** A message and a file
row do; a link row hands `location.url` to the browser and asks nobody. Two
reviews in, the honest statement is stronger than the first correction to this
entry: the URL is never rendered, so it is not an excerpt the reader was already
looking at but content behind the row, and the window extends by up to thirty
seconds the period in which a revoked one can be opened unchecked. It is called
out rather than closed because the fix — re-deriving a link on click the way the
other two kinds are — needs an endpoint that does not exist and changes
link-opening on every path, cached or not. That is a change worth making on its
own argument, not one to fold in here so that this entry's safety claim reads
tidily; whoever takes it up should start from the fact that clicking a rendered
row has never been re-checked, and that this window only lengthens the reach.

A server-side cache was rejected rather than deferred. Results are admitted per
subject, so one member's page is not another's; a per-subject cache would have to
live in KV or the Cache API for an isolate that probably will not serve that
member again, and it would move an authorization-shaped decision to the side of
the boundary where a mistake is shared. The client cache costs two options and
is deleted by reverting them.

The measurement changes with it, and the document now says so: a cache hit never
runs `queryFn`, so it opens no `renderer_perf_flow` flow. The p50/p90 targets
describe the searches that reach the Worker. Emitting a flow for cache hits was
considered and left out — it would report the trivially fast path into the same
percentiles the targets were written against, and flatter them.

### 2026-09-11 — Tolerate document fields from a newer build, and re-project the rows the skew lost

**What changed:** The search batch, document and display schemas are plain
objects that strip keys they do not name, where they were strict; the Queue
envelope schemas stay strict. The document phase logs
`search_document_keys_ignored` naming the source and the stripped key paths.
WorkspaceDO migration 51 marks every resource pending and SubstreamAgent
migration 53 re-queues every committed turn, the same passes migrations 47 and
52 ran. The rule that a new document field ships in one deploy and its
re-projection in a later one is an invariant above.

**Why:** The 2026-09-10 deploy that added `display`, `substreamId` and
`connectionId` produced 535 `search_indexing_retry` warnings in twenty-five
minutes: the objects were on the new build, the Queue consumer isolates were
still on the old one, and the old build's strict schema rejected every new
document with a ZodError. 19 jobs exhausted their five retries into the
dead-letter queue, and the dead-letter backlog rose from single digits to
about 150. Those rows are stale with nothing left to republish them, because
both sources clear their publish intent when the Queue accepts the reference,
and the retry log names neither the resource nor the turn. Every future deploy
that adds a field would do the same.

**Considered and rejected:** Keeping the schemas strict and lengthening the
retry schedule, so a rejected job outlives the window; a consumer isolate's
lifetime is not bounded by anything this repository controls, so no delay is
known to be enough. Rejecting on every attempt but the last and stripping only
then, which would keep the self-healing the strict schema had (most of the 535
rejected deliveries landed on a new isolate on a later attempt) without a new
number; the consumer does not know the queue's retry budget, so the budget
would be a second copy of a Wrangler setting kept in step by hand, and the
rows it still strips on the last attempt need the same follow-up re-projection
either way. Re-marking pending only for workspaces active in the
window; no source we have lists them (the log carries no id, the dead-letter
queue has no consumer and expires in 24 hours), and a list that misses one
leaves a stale row nobody will notice, where a full pass at the cost migration
47 already measured (about 55 minutes to drain some 160k messages; the
embedding provider is skipped for every batch whose chunk rows already exist,
and called only for a document that dead-lettered before its chunks were
written) cannot. Clearing
`pending` on successful indexing instead of on publish; it is the right design
and is recorded under Open questions, but it needs a completion RPC, a lease
and a number the team has to set, which is more than an incident fix.

**Consequences:** A consumer behind its producers now writes rows to the
contract it knows, silently except for the log, so a field that has to reach
existing rows must be back-filled by a migration in the deploy after the one
that adds it; because the log names the source, that back-fill can be targeted
next time where this one could not be. The tolerance is additive only: a
renamed or removed field still dead-letters on the old build, so removals are
sequenced behind the last build that requires the field. The Queue envelopes
stay strict on purpose, because an envelope field is an instruction and a
document field is payload; a field added to a job is a new message type.
Chunk rows carry the display and connection attributes the embedding phase
writes without logging; nothing reads them off a chunk row today, and a
change that starts to must extend the log and the re-projection to that phase. Both new migrations are lazy until the
fleet is force-migrated, like 47 and 52, and migration 53 does not repair a
dead-lettered deletion tombstone, which nothing produces today. Migration 53
carries its own copy of migration 52's statement rather than sharing a
constant: 52's text is hashed into a receipt on every migrated object, and an
edit to a shared constant would fail every SubstreamAgent constructor in both
regions. `pending` still clears on publish; a dead letter still needs a
redrive or a re-projection until the open question is taken up.

Shipped in #691.

### 2026-09-10 — Hold the search modal at one size, and unlabel row shortcuts

The modal grew and shrank under the reader: the "Loading more" line and the
failed-continuation retry button were flow children of the modal, so arriving at
the end of a list resized the box, moved its centred position and its shadow,
and shifted the retry button while the pointer was travelling toward it. The
list and that footer now divide one fixed 360px body, the list taking whatever
the footer does not, so the box is the same height in every state: the opening
prompt, loading, no results, a failure and a retry. Making the footer an
overlay over the last rows was rejected: it would cover the retry button's own
row and put a control under scrolling content. Sizing the modal to its contents
instead, so it grows with the footer, is the behaviour being removed. The footer
carries a top border because the list now scrolls under it and clipped text
against status text read as a glitch. Two tests hold the shape between them,
because neither can hold it alone: `app.css.node.test.ts` asserts the division,
since jsdom lays nothing out and no component test can tell a footer that
divides a fixed body from one that extends the modal, and the component test
asserts the containment the division depends on, which is the half that does
live in the DOM.

Taking the room out of the list moved a second problem rather than removing it.
The row the reader is on is the last one, since reaching it is what asks for the
next page, and it was left 12 of its 52px visible under the loading line and
none at all under the retry button (measured in the running client). The
highlight is therefore re-anchored whenever either footer opens or closes, not
only when it moves. That is also the honest difference from the rejected
overlay, which was turned down for covering the rows beneath it: this clips them
instead, and only the re-anchoring makes that the smaller cost rather than an
equal one.

Result rows also lost the ⌘1-9 badges on their right edge, as asked: the row is
now its excerpt and its source label. The key handler stays, so the shortcut
still works for anyone who knew it, but nothing advertises it. The next change
here should either restore an affordance or drop the handler rather than leave a
third state.

A fixed body is the reusable half of this: any modal whose contents change state
under the reader can hold its own size the same way, by giving the variable
region one height and letting its children divide it.

### 2026-09-10 — Continue pages by scroll position instead of a button

The team asked that a paginated result list never show a button: the next page
loads as the end of the list comes into view, infinite-scroll style. A sentinel
inside the scroll container is observed with `IntersectionObserver`, re-observed
whenever the row count changes so a page that lands without filling the viewport
loads the next, and the keyboard's last-row move requests a page too. The Load
more control and the "Continue searching" copy are gone; an empty page with a
continuation now keeps scanning. A failed continuation is the one case that
keeps a button, because scrolling past a broken cursor must not loop. The
time-to-results trace is unchanged: it stays open across the automatic
continuation exactly as it did across the explicit one.

### 2026-09-10 — Fence overlapping display deliveries

Review found that two `search_conversation_projection_v1` deliveries for one
conversation can overlap across queue invocations: the first reads the display
before an archive, the second archives and patches, and the first then patches
the rows back to unarchived and acknowledges. The `NotEq` filter cannot fence
that, because it makes the newer value eligible for the stale patch. The job now
re-reads the display after patching and throws when it changed, so the stale
delivery retries and re-patches the current state; the newest state always writes
last. A version carried in the job was rejected because the job deliberately
carries nothing but the address. The same review asked about a resource's
`occurredAt` going stale on bookkeeping writes; that is the documented intent of
the migration-43 trigger (the index shows the last content change), now written
into the invariants above rather than changed.

### 2026-09-10 — Register decisions before the first search and drop the completeness flag

The entry below accepted a shorter first page for a cold user. The team then
chose complete consistency as the design goal and asked for the incomplete flag
to go: the search response no longer carries `complete`, the route no longer
returns 503 to a client without partial-result support, and the desktop has no
partial footer. What makes that honest is on the write side, recorded in the
[authorization changelog](authorization.md#changelog): push jobs register every
pair their target reaches before reloading owners, membership changes push the
member they name, and migration 48 queues the existing directories. Connector
rows now carry `connection_id` and are admitted by one decision per connection,
read once per page, because 81,000 synced resources times the member list does
not fit a per-resource projection. Nothing on the read path changed shape: the
request field `supportsPartialResults` is still accepted and ignored for
desktop builds that send it. Resource lists keep their own `complete` field.

### 2026-09-09 — Remove directory discovery from paginated retrieval

Paginated search now uses the same unrestricted candidate retrieval as the first
page path, then admits candidates with projected decisions. Reading the workspace
directory before every query added a serial DO hop despite final admission already
being available. Pages can be sparse when candidates are inaccessible; continuation
still follows scanned candidates, not the number of returned results. KV negative
lookups reuse durable snapshots before resolving owners. Memory authorization now
uses the shared projected resolver without a post-retrieval authority check.

### 2026-09-08 — Remove canonical authorization from cache-hit hydration

Trust the search authorization projection across requests to avoid serial owner
round trips seen in production. Admitted conversation text uses a storage-only
RPC, without another product authorization or viewer seating. Permissions are
eventually consistent; missing decisions still resolve through canonical owners,
and source mutations push replacement decisions while cached decisions remain usable. Revision/hash checks
continue to reject stale indexed content.

### 2026-09-08 — Index resource content changes, not bookkeeping

**What changed:** A forward migration narrows the resource update trigger to
search inputs, including body hashes. Insert/delete and revision fencing remain.

**Why:** Every resource update previously queued indexing, including webhook
provenance and processing state, causing unnecessary storage and Queue/RPC work.

**Considered and rejected:** Filtering only webhook writers would leave other
canonical writers producing the same redundant indexing jobs.

**Consequences:** New extraction inputs must extend the trigger through another
forward migration. Existing pending work is retained, with no forced backfill.

PR: #611.

### 2026-09-08 — Seek pending resource projections by deadline

WorkspaceDO migration 39 adds a partial `(not_before, resource_id)` index for
pending resource-search revisions. The next-deadline read avoids scanning all
completed watermarks, and dispatch uses the same deadline/identity order. Queue
batch size, failure delay, revision fences, and retained deletion watermarks stay
unchanged. The billing investigation found roughly 71,000 reads even with zero
pending rows; disabling search or deleting completed watermarks would sacrifice
freshness or stale-write protection. New writes still reset the deadline, and
publication must clear only the revision it actually sent.

### 2026-09-08 — Admit search batches once and expose continuation

Search now authorizes each source batch once, loads resource metadata and revisions
in one owner RPC, and consumes one candidate page per request. Empty desktop pages
require explicit continuation. Repeated per-resource and post-read checks added
serial owner calls without improving the agreed operation-level admission contract.
Hidden refill scans also made response work unpredictable. We trust the platform's
canonical authorization and content stores; subsequent requests authorize again.
Source revision validation remains required, and this change makes no production
latency claim.

### 2026-09-08 — Remove age-triggered authorization stalls

Authorization freshness is now a five-minute design goal, not a hard read cutoff.
Search no longer expires permissions by age or synchronously refreshes the whole
workspace's attachment inventory. Canonical checks share owner observations within one batch only;
persistent grant caches are not reused without mutation invalidation. This avoids
permanent stale grants while keeping the existing Queue discovery and explicit
partial-results contract. Search latency targets still require production validation.

### 2026-09-07 — Add an owner-backed authorization cutover and remove its rollout gates

Member search uses the core authorization context and exact attachment
inventories populated by queued backfill. This replaces repeated work-stream
discovery with canonical checks along known child paths, retaining source text
validation and a five-minute bound on permission evidence. See
[authorization](authorization.md) for rollout controls and the distinction
between denial and unavailable authority.

Search uses the core authority path immediately on deployment. The shadow
comparison and activation reads were removed to make deployment sufficient, as
requested by the team. Missing attachment inventories queue discovery and remain
retryable; permission checks and the five-minute evidence deadline still apply.

### 2026-09-07 — Remove serial candidate hydration from interactive search

**What changed:** Paginated desktop searches filter readable conversation scopes,
batch conversation reads, hydrate independent groups concurrently, and return a
visible-sized first page. Content-free phase timing covers typing through paint.

**Why:** A real desktop query remained on Searching for more than five seconds
before returning results. Each candidate previously paid a serial chain of source
and authorization reads, and the UI waited for 50 results before showing any.

**Considered and rejected:** A socket or result cache would not remove those
serial reads and would add authorization invalidation work. Changing debounce
before measuring backend work would spend more requests without fixing the cause.

**Consequences:** Final canonical and membership checks remain mandatory. Scope
prefiltering follows the directory projection, so a newly granted scope can wait
for that projection; it never allows stale grants to bypass final authority.
Seven is a layout-derived page size, not a truncation of searchable content.
Latency targets still require production measurement after deployment.

### 2026-09-06 — Plan and capture each document independently

**What changed:** Source references fan out document jobs before capture and
chunk planning. Identity-only discovery avoids loading or serializing sibling bodies at all.
Targeted source RPC reads exclude sibling page bodies, and
freshness validation does not repeat capture. Capture failures include numeric
HTTP/provider codes without URLs, response bodies, or provider error text.

**Why:** Single-message Queue delivery still exceeded CPU and memory budgets:
failed production turn jobs included 20–41 captured pages. A Queue message was
not a single document. A direct failed-page probe also returned Browser Run 422,
code 5006 (connection closed), while a public control page succeeded; treating
that failure as a reason to replan every sibling amplified unrelated work.

**Considered and rejected:** Increasing CPU allowance or lowering embedding
batch size would retain the multi-document planning unit. Swallowing capture
failures would falsely imply page content had migrated. Provider failures remain
visible and independently retriable.

**Consequences:** The shared 512/128-token chunk algorithm, 64-input embeddings,
regional routing, canonical generation checks, and Queue settings are unchanged.
Existing source and embedding jobs remain accepted. Document-phase jobs use the
existing `search_embedding_batch_v1` envelope: old consumers reject the unfamiliar
strict shape and retry instead of acknowledging an unknown type. Targeted reads
use distinct RPC method names, so an old object cannot silently ignore a trailing
argument and return every sibling. New document jobs carry
references only and always reload current authority. Single unusually large
sources may still exceed runtime limits; deployment and selective recovery must
verify those cases rather than infer success from the new job boundary.

### 2026-09-06 — Give each activity message its own invocation

**What changed:** Both regional activity Queue consumers use `max_batch_size: 1`,
approved by the team on 2026-09-06. Embedding requests still contain up to 64
chunks. Retry settings, grouping timeout, regional routing, and Worker CPU limits
remain unchanged.

**Why:** After embedding fan-out deployed, production still reported invocation
CPU and memory failures. A synthetic 2.1-million-character source took about ten
seconds to plan locally in workerd; ten source messages in one delivery share
one CPU budget. One message per invocation removes that accumulation without
raising the Worker-wide CPU allowance.

**Considered and rejected:** Raising the Worker CPU limit would also affect
unrelated API requests. Reducing the embedding request size would not address
source planning. Neither change is part of this adjustment.

**Consequences:** This changes grouping for every consumer of the shared regional
activity Queue, including connector and control messages. It can increase Worker
invocations; it does not cap concurrent invocations or guarantee that a single
large source fits the runtime's memory or CPU limits. Verify deployment and replay
failed search references selectively before declaring migration complete.

### 2026-09-06 — Fan out chunk batches through the regional Queue

**What changed:** A source delivery writes lexical text, removes obsolete semantic
revisions, runs the shared chunker, and publishes reference-only jobs for groups
of 64 ranges. Each child validates current source text, embeds and writes its
batch, and checks freshness afterward. Persisted deterministic rows let redelivery
skip completed provider work. Generation hashes isolate equal-revision content
changes and canonical result loading validates them.

**Why:** The team requested Queue fan-out after approving provider batching.
Batching reduces round trips, but a large document still occupies one delivery
and retains all vectors until its final write. Separate Queue messages give each
batch independent retries and bound each embedding/vector write to 64 chunks.

**Considered and rejected:** A new coordinator table or staging bucket would add
another failure boundary. Completion counting and retaining obsolete revisions
until every child finishes were also removed during review: canonical validation
already rejects those revisions, so they preserve no usable results and a failed
child would strand them. Source-time cleanup needs no completion protocol.
Publishing all vectors at once would preserve the original memory bottleneck.

**Consequences:** This supersedes the whole-document publication contract below.
Valid chunks become searchable progressively. A malformed later batch cannot
write invalid vectors; successful earlier batches remain. Current authority and
content checks fence racing stale writes. Existing namespaces remain readable
during schema transition. Parent-side chunk planning still processes the full
document; fan-out does not remove that CPU and tokenizer-memory cost. Policy
changes require a source backfill; obsolete children do not multiply that work.

### 2026-09-06 — Batch semantic embedding inputs

**What changed:** The shared pipeline sends arrays of chunk inputs through the
existing inference client instead of making a request for each chunk. Responses
must contain exactly one valid vector per input, in input order. All batches are
validated before publishing a generation, and the source is reloaded afterward.

**Why:** Two production Queue invocations hit Cloudflare's 15-minute wall-time
limit after 196 and 207 successful serial embedding requests. Their cumulative
provider latency was about 898 and 884 seconds. Reducing tokenizer memory did not
remove that network round-trip bottleneck, so large documents continued to hold
up the shared Queue.

**Considered and rejected:** Increasing Queue concurrency does not make an
individual document finish within its invocation. Dropping chunks would make
search incomplete. Native array inputs reduce round trips while keeping the
same model, tokenizer, offsets, deterministic IDs, and complete source content.

**Consequences:** The team approved 64 chunks per request on 2026-09-06: at most
32,768 input tokens and 65,536 vector values per response. This reduces serial
round trips while bounding individual responses during memory recovery. This is a request-shaping change, so it requires no
namespace migration. A provider or late-batch validation failure still retries
the source without publishing a partially validated generation. Whole-document
chunking and accumulation of all validated vectors remain memory costs.

### 2026-09-06 — Release tokenizer construction tables and unused encoding arrays

**What changed:** After the pinned BPE constructor builds its runtime lookup maps,
search releases the original vocabulary object and merge arrays. Counting uses
the library's tokenization API with special tokens explicitly enabled, avoiding
unused ID and attention-mask arrays. The shared model remains closure-private,
and each count still clears input fragments in finally.

**Why:** Live replay after sharing the tokenizer still showed memory-limit
outcomes. Inspection found that the library retained both its constructor input
and compiled maps; a Node 22 heap check fell from about 50 MiB to 26 MiB after
releasing the construction tables, with identical token IDs in the comparison
inputs. Sharing alone had not removed that permanent per-isolate overhead.

**Considered and rejected:** Reimplementing BPE, normalization, or special-token
framing would create a second definition of token counts. We retain the library's
runtime and only release tables whose reads in the locked implementation occur
during construction. No source truncation, estimated counts, or Queue concurrency
limit is introduced.

**Consequences:** Exact counts and chunk namespaces remain unchanged. Upgrading
Tokenizers.js requires checking this construction/runtime boundary; the tests
compare the compact counter against a fresh unmodified tokenizer on Unicode,
normalization, special tokens, whitespace, URLs, and unbroken text. Cold
construction still has a transient peak and document work still allocates memory;
production runtime outcomes remain a rollout gate rather than an assumed result.

### 2026-09-06 — Share immutable tokenizer state across overlapping deliveries

**What changed:** The bundled tokenizer is initialized lazily and synchronously
once per Worker isolate using the existing `fflate` dependency. The chunker
finds positions by binary search in its existing sorted boundary array instead
of constructing a Map entry and a temporary pair for each code point. Only the completed,
frozen policy is shared. Encoding clears the BPE input cache on success or failure.
Source data, provider requests, and indexing state remain local to each delivery.

**Why:** Production replay after bundling the tokenizer exposed `exceededMemory`
Queue outcomes. Each independently constructed tokenizer retained about 46 MiB
in a local Node 22 heap measurement, so overlapping batches multiplied the model
under the Worker's shared 128 MiB isolate limit. Sequential work within a batch
could not prevent overlap between deliveries. Synchronous initialization avoids
both duplicate initialization and sharing an asynchronous stream across request
contexts; reducing Queue concurrency would hide the duplicate allocations and
slow unrelated activity work. This revises the per-batch lifecycle recorded in
“Remove tokenizer downloads and blank inputs from backfill” below. A separate
Node 22 allocation check for one million characters measured about 118 MiB of
additional peak heap from building the removed Map; the boundary array retained
about 11 MiB. This is shared compiled model state, not a source or result cache.

**Considered and rejected:** A shared promise around synchronous construction
does not move parsing off the event loop. Initialization remains synchronous
and lazy (about 401 ms in a local Node 22 cold measurement), so it is paid once
per isolate without duplicate model construction or request-owned streams.
Clearing only after a document would retain one workspace's input fragments
while chunking yields to another delivery; we retain cleanup after each count.
It forfeits cache reuse across overlapping probes: an 87,000-character synthetic
English document took roughly 1.03 s with cleanup versus 0.78–0.90 s without it
on Node 22, with identical 92 chunks. These are local examples, not production
latency guarantees. No arbitrary latency threshold or Queue concurrency cap is
introduced.

**Consequences:** The retained model reduces memory headroom for every later
request in that isolate, including non-search activity work. Cold initialization
also needs transient decompression/parsing/construction memory above that floor;
check runtime outcomes after rollout rather than equating shared allocation with
proof that every source fits. The model revision, exact token counts, chunk policy,
namespaces, and regional routing are unchanged. Tests cover overlapping real Queue deliveries,
policy reuse, and removal of input fragments even when encoding throws. Runtime
memory outcomes must be checked after rollout; local tests do not enforce the
production isolate's full memory accounting.

### 2026-09-06 — Remove tokenizer downloads and blank inputs from backfill

**What changed:** Queue batches load the exact pinned Qwen tokenizer from
compressed, licensed assets in the Worker bundle. The regeneration script records
the immutable source revision and SHA-256 hashes, and normalizes the gzip OS
header so regeneration does not encode the developer machine. Workerd tests use that real
tokenizer while the external asset host returns an error. Whitespace-only
semantic chunks are skipped without modifying lexical text or source offsets.

**Why:** After the model-name fix unblocked embeddings, production backfill
exposed repeated `search_tokenizer_unavailable` errors: each batch downloaded the
same two assets, coupling indexing throughput to an external asset host. Shipping
the already-pinned bytes removes that runtime dependency without a cache or a
second retrieval path. Provider HTTP 400 responses also exposed whitespace-only
semantic passages, which carry no semantic content and must not be embedded.
Gzip keeps the large vocabulary out of module-startup parsing; decompression and tokenizer creation stay local to a Queue batch.

**Consequences:** Model, tokenizer revision, token budgets, and namespaces remain
unchanged. Dead-lettered search references still need replay after deployment.

### 2026-09-06 — Accept the provider's Qwen model spelling

**What changed:** Semantic indexing compares the returned model identifier without
case sensitivity, while retaining dimension and finite-value validation.
Search and scoped memory share `isMemoryEmbeddingModel` in
`structured-inference.ts` for both document and query embeddings.

**Why:** Production OpenRouter responses identify the requested model as
`Qwen/Qwen3-Embedding-8B`. The previous comparison required the lowercase routing
slug and rejected valid 1,024-dimensional embeddings after the lexical write.

**Considered and rejected:** Ignoring the returned model entirely would admit
embeddings from an incompatible model. Only case differences are accepted.

**Consequences:** Namespace identity is unchanged. Failed search references need
redrive after deployment; a successful schema migration does not repair dead letters.
The real-workerd provider fixture now uses the observed response spelling.

### 2026-09-06 — Keep the shared chunk policy in code

**What changed:** The 512-token maximum and 128-token overlap are shared code
constants. Environment parsing, deployment variables, and development forwarding
for chunk settings are removed.

**Why:** The team selected 512 tokens with 25% overlap to preserve boundary
context, and requested one fixed code policy for all sources and regions to
eliminate configuration drift and an unnecessary indexing prerequisite.

**Considered and rejected:** Environment overrides could make identical content
use different chunking policies across deployments.

**Consequences:** Provider credentials still gate indexing. Namespace hashing
retains the string representation of the selected values, preserving identity for
512/128 indexes. Future policy changes require a code change and semantic backfill.

### 2026-09-06 — Member search and one regional text pipeline

**What changed:** Added the five-tab modal, canonical excerpts, repeatable message
navigation, authorized resource previews, and durable projection intents. The
regional Queue pipeline owns lexical text plus recursive/sliding-window chunks
and Qwen embeddings for messages, attachments, artifacts, and captured pages.
Review fixes pause unconfigured producers without losing intents, batch message
reads, and preserve equal-revision rewrites during extraction races.

**Why:** The requested product direction is one Turbopuffer search system and one
text-processing pipeline. Local sidebar filtering cannot search unloaded contents.
Semantic indexing ships now because all sources were explicitly requested to use
the same chunking/embedding pipeline; member ANN controls and the remaining
memory/agent/provider cutover are separate unfinished callers.

**Considered and rejected:** Keeping SQLite FTS plus Vectorize for some sources
would preserve the split the user asked to remove. Per-source chunk policies and
hybrid rank fusion were rejected by the requested architecture. Skipping failed
semantic work with an acknowledgement would lose indexing; unconfigured producers
instead retain their durable intents without hot alarms. Keeping old result pages
after a new request would weaken revocation freshness, so pending results remain
hidden and typing is debounced using the existing resource-picker delay.

**Consequences:** Set the team-selected chunk size and overlap, deploy and wake
objects to publish pending work, then verify Queue drain and access revocation.
Credentials were provisioned separately on both regional API Workers; code has not
yet been deployed. Memory, notes/table text, agent tools and provider ranking still
need migration. The old local sidebar filter for workstream/note/automation names
is removed as part of the requested modal replacement; those name-only searches
are not yet supported by the five indexed content categories. No reranker or
embedding-model fallback is introduced.
