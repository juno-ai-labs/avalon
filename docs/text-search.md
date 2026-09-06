# Text search

Rally's shared Turbopuffer boundary provides full-text, literal substring, and semantic
retrieval as separate modes. Product callers choose data sources; each source resolves
its own grants and reloads canonical results. The index does not grant access.

The member search modal uses this boundary for messages, links, uploaded files,
and generated artifacts. The broader migration is still incomplete: memory and
agent/provider search callers retain their existing paths. Provisioning credentials
does not deploy this code or backfill dormant objects.

## Where the code lives

- `apps/api/src/services/text-search.ts`: namespace selection, writes, revision
  tombstones, retrieval, and canonical result loading.
- `apps/api/src/services/search-indexing-pipeline.ts`: the shared Queue indexing pipeline for every source.
- `apps/api/src/services/search-document.ts`: canonical document and deletion contracts.
- `apps/api/src/services/search-embedding.ts`: pinned Qwen tokenizer and embedding integration.
- `apps/api/src/services/semantic-chunks.ts`: recursive and sliding-window semantic chunks.
- `apps/api/test/semantic-chunks.test.ts`: coverage, Unicode, overlap, and token budgets.
- `apps/api/src/env.ts`: server-only development and production credentials.
- `apps/api/src/services/workspace-search-service.ts` and `routes/search.ts`: member
  source selection, current authorization, canonical excerpts, and the protected API.
- `apps/api/src/durable-objects/search-projection-outbox.ts`,
  `resource-search-projection.ts`, and `conversation-link-search.ts`: transactional
  indexing intent, Queue dispatch, and asynchronous Browser Run capture.
- `apps/desktop/src/renderer/components/search-modal.tsx`: the five-tab member UI.
- `apps/api/test/text-search.test.ts`: source grant and canonical loading tests.

## How it works

A namespace belongs to one deployment, region, workspace, and embedding space.
Its name hashes those values. Global uses `gcp-us-west1`; EU uses
`gcp-europe-west1`. Production reads `TURBO_PUFFER_PROD_API_KEY`; other environments
read `TURBO_PUFFER_DEV_API_KEY`. There is no credential or region fallback.

Generation v3 uses two namespaces: `rally-search-v3-<identity hash>-text` holds
complete lexical documents without vectors; `rally-search-v3-semantic-<hash>` holds
embedded chunks. The semantic hash combines the workspace identity with tokenizer revision, algorithm version, chunk size,
and overlap, so changing chunk policy requires a semantic backfill in a new space.
Hashing the complete semantic identity once keeps the name within Turbopuffer's
[published 128-character namespace limit](https://turbopuffer.com/docs/write).
A document records its source, canonical source ID, scope ID, revision, text,
and, for semantic records, embedding. `searchDocumentId` hashes the source, scope, and source ID into a
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

### One Queue pipeline

All current message, upload, generated-artifact, and captured-page sources emit
reference-only jobs through their transactional outboxes to the existing regional
`ACTIVITY_QUEUE`. The regional API Worker consumes these jobs. Its source adapters
load the latest canonical text through trusted RPC and return `SearchDocumentBatch`:
source, source ID, scope, stable document ID, revision, and text (null for deletion).
Adapters extract text and preserve authority; they cannot choose chunk sizes,
embedding models, normalization, or indexing behavior. No adapter writes Turbopuffer.

`createSearchIndexingPipeline` is the single processing path. It writes the full,
lossless canonical text for BM25/substring search, then runs the same chunker and
embedding integration for every live document. Preserving full lexical documents
allows substrings to span semantic boundaries and preserves exact UTF-16 offsets.
There is no lossy per-source normalization. Source-specific fields such as a file's
name and description are assembled before this shared boundary.

Search jobs run sequentially within a delivery and share one tokenizer. Unrelated
control-effect messages run concurrently. Each search message is acknowledged only
after indexing and canonical revalidation finish; individual failures request a
Queue retry and eventually use the existing regional dead-letter queue. Reusing the
existing Queue avoids a second transport and rollout configuration for the same
source references. Global and EU stay on their respective Workers and queues.

### Semantic chunks

`indexSemanticDocument` creates recursive passages and overlapping sliding windows
from the same canonical text used for lexical indexing. Recursive splitting tries
paragraphs, lines, sentence endings, and spaces before code-point boundaries.
Identical spans are deduplicated and carry both strategy labels.

`SEARCH_CHUNK_MAX_TOKENS` and `SEARCH_CHUNK_OVERLAP_TOKENS` are global pipeline
settings, never source options. They have no guessed defaults. Missing or invalid
settings fail the vector step and retry the job; they do not silently disable
semantic indexing. Lexical text is written first and remains available.

The shared integration loads the Qwen3-Embedding-8B tokenizer's public assets at
immutable revision `1d8ad4ca9b3dd8059ad90a75d4983776a23d44af` and runs them locally
with `@huggingface/tokenizers`. User content is never sent to the asset host.
Counts include tokenizer special tokens. Document embeddings use OpenRouter's
`search_document` task through the existing inference client. The binary boundary
search checks every accepted span; nonmonotonic BPE counts may leave budget unused,
but cannot admit an oversized span. No character-count approximation is used.

Every chunk stores exact UTF-16 offsets, canonical source ID, scope, and revision.
All vectors are checked before the generation write. Qwen3-Embedding-8B at 1,024
dimensions is the configured space; a changed model, wrong dimension, or nonfinite
vector fails the job. There is no Qwen/Gemini fallback. Changing model requires a
matching tokenizer, embedding integration, and new namespace.
See the [Qwen model card](https://huggingface.co/Qwen/Qwen3-Embedding-8B) and
[Tokenizers.js documentation](https://github.com/huggingface/tokenizers.js).

Chunk IDs include parent revision, offsets, and embedding input, making retries
idempotent. Successful writes delete older semantic generations by source/scope/ID
and revision. Deletion removes generations through its revision. The Worker reloads
canonical source state after embeddings and removes its own obsolete generation
if a concurrent edit or deletion won, then retries. A crash before this check leaves
an unacknowledged job; its retry loads the current source and performs reclamation.
Canonical result loaders always reject obsolete revisions, including during that
recovery window. The retained lexical tombstone prevents delayed resurrection.

Sources provide server-resolved scope IDs and a canonical loader. Search filters
by those grants, validates returned candidate metadata, then invokes each loader
only for candidates belonging to its source and scopes. The returned text comes
from those loaders, never from the index.

## Invariants

- Source loaders must check current authority after retrieval and reject stale
  revisions. Otherwise revoked access or obsolete content could be returned.
- Namespace identity includes the embedding model and dimensions. Mixing spaces
  makes vector distances meaningless.
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

Conversation loaders authorize the parent and private child before and after
reading canonical turns. Resource loaders re-read current source revisions and
attachment access. The route revalidates the workspace session before returning.
The index returns candidate identifiers, never trusted display text. Excerpts
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

Turbopuffer requires a valid embedding for live documents in a vector-enabled
namespace. Callers must retain failed projection work for retry. The service does
not invent retry limits or result caps; the caller supplies its product limit.

Substring retrieval advances an ID cursor when canonical filtering removes
results, continuing until the requested page is filled or the index is exhausted.
BM25 and semantic retrieval currently return one candidate page and may return
fewer canonical matches. The desktop does not yet expose subsequent pages.
The cursor follows [Turbopuffer attribute pagination](https://turbopuffer.com/docs/query#pagination).

## Testing

Run `pnpm --filter @rally/api exec vitest run test/text-search.test.ts test/semantic-chunks.test.ts`.
The external SDK is doubled to prove source filtering and canonical result
loading. No database or Durable Object runtime is simulated by this suite.

Disposable live namespaces in both configured regions verified literal asterisk
substring matching, conditional upserts, deletion watermarks, and rejection of
same-revision resurrection. The namespaces were deleted after verification.
Generation deletion filters also preserved newer vectors in both regions. Production content was not used for these checks. Vector-free lexical writes
and tombstones were also checked in both regions. Workerd tests cover resource
revision watermarks, upgrading committed transcript history, transactional search
intent, and rejecting stale link labels. `test-workers/search-indexing-pipeline.test.ts`
drives the Queue consumer through real source RPC and R2 reads, verifies identical
chunks across messages/files/artifacts/pages, and proves concurrent deletion causes
generation cleanup and retry. Its only doubles are external APIs/model assets.
The pinned Qwen tokenizer was separately exercised in workerd with its actual
public model assets served from a temporary local mirror. Component tests cover tabs, keyboard
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

Object alarms dispatch pending references. Queue acceptance clears only the
revision dispatched, so a concurrent edit remains pending. Dispatch failures use
the existing regional outbox retry interval; projection failures remain Queue
failures and follow its configured retries and dead-letter handling.

Deploy both API Workers with their `BROWSER` binding and production Turbopuffer
secret and the shared `SEARCH_CHUNK_MAX_TOKENS` / `SEARCH_CHUNK_OVERLAP_TOKENS`
settings before running backfill. `pnpm env:sync` forwards the development key and
both chunk settings from `.env.local`; it never copies the production key into
development Workers. Use the existing migration tracker's **Force a
migration** action for WorkspaceDO and SubstreamAgent in each region to wake
stored objects; an untouched object does not migrate just because code deployed.
See [Durable Object migration tracking](durable-object-migration-tracking.md).
Verify migration reports, regional activity Queue drain and dead letters, then
perform member searches and revocation checks. A current schema report proves
schema application, not successful indexing. These deployment and fleet-backfill
steps have not been run for this change.

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

Production needs team-selected global chunk token size and overlap before enabling
indexing jobs, followed by deployment and backfill. Memory,
notes/table text, agent tools, and external provider ranking still need migration.
The member conversation source currently enumerates the work-stream directory;
archived parents and automation-run coverage need an explicit source inventory.
BM25/semantic canonical filtering can shorten a page; their refill and client
pagination are not implemented. Substring requests refill rejected candidates.

## Changelog

### 2026-09-05 — Centralize text processing in the Queue Worker

**What changed:** Source RPCs now return canonical documents instead of writing
indexes. One regional Queue pipeline owns lossless lexical indexing, recursive and
sliding-window chunking, Qwen tokenization and embedding, and generation cleanup.

**Why:** Messages, attachments, artifacts, and pages must receive identical text
processing. Letting individual source handlers select indexing policy would make
results and chunk sizes drift as new sources were added.

**Considered and rejected:** Per-source vectorization and chunk-size overrides
were removed. The existing regional Queue provides durable delivery, so a second
transport was unnecessary. Character token estimates were rejected in favor of
the pinned model tokenizer.

**Consequences:** Sources retain extraction and authorization. Global chunk size
and overlap must be configured before production delivery; missing settings retry
rather than silently acknowledging incomplete vector indexing. Legacy memory and
agent/provider callers still need to migrate into this shared boundary.

### 2026-09-05 — Member search and durable lexical projection

**What changed:** Added the tabbed member modal, authorized canonical excerpts,
message navigation, resource previews, transactional source indexing jobs, and
Browser Run capture of conversation links. Split complete lexical documents and
semantic chunks into generation-v3 namespaces. Reused attachment classification
for readable originals so JSON and code MIME types contribute their contents.

**Why:** People need to recognize the matching section and search uploaded or
generated content without knowing its storage system. Capturing page contents on
message admission would delay sending; durable background jobs keep that work
off the interaction path and survive retries.

**Considered and rejected:** Local sidebar filtering cannot search unloaded
messages. Workspace-wide capture rows would lose private-substream audience.
Putting lexical parents in a vector namespace would require synthetic embeddings.

**Consequences:** Source stores remain authority and stale index results are
rejected. Dormant objects require a migration wake. The broader memory and agent
migration remains outstanding; the UI addition does not constitute that cutover.

### 2026-09-04 — Separate retrieval modes and chunk semantic documents

**What changed:** Removed hybrid retrieval and rank fusion. Added recursive and
sliding-window semantic chunking, exact source offsets, duplicate-span elimination,
model-space checks, and chunk-only ANN queries.

**Why:** The requested product direction is explicit text or semantic retrieval.
Structure-preserving passages and overlapping windows offer different semantic
contexts without blending lexical scores into vector ranking.

**Considered and rejected:** A single fixed character budget would ignore the
selected embedding tokenizer and framing. Long model context windows do not by
themselves define useful retrieval passage sizes. Silent Qwen/Gemini fallback
would mix incompatible embedding spaces.

**Consequences:** Sources must supply tokenizer-backed chunk policies and persist
chunk generation IDs. Production cutover and existing memory search migration
remain outstanding. No source-specific chunk-size defaults are chosen here.


### 2026-09-04 — Shared retrieval boundary introduced

**What changed:** Added the Turbopuffer SDK boundary, source grants, canonical
loaders, four retrieval modes, and versioned deletion watermarks. Production
credentials were provisioned separately on both regional API Workers.

**Why:** Product and agent search need one retrieval system while retaining each
data source's actual authorization authority. Separate FTS and vector-specific
implementations would continue duplicating retrieval policy.

**Considered and rejected:** Treating index metadata as authorization was rejected
because revocation can happen while an external query is in flight. Physical
row deletion alone was rejected because a delayed upsert could restore it.

**Consequences:** This is not yet a product cutover. Source indexing, backfill,
canonical authorization adapters, member UI, memory migration, and agent/provider
search integration remain outstanding. No specialist reranker is introduced.
