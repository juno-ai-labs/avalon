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

The shared constants in `semantic-chunks.ts` set a 512-token maximum and
128-token sliding-window overlap for every source and region. These are code
policy, with no environment or source overrides. Missing provider credentials
pause producers while retaining intents; an already queued job retries failed
vector writes rather than silently disabling semantic indexing. Lexical text is
written first and remains available.

The shared integration loads the Qwen3-Embedding-8B tokenizer's public assets at
immutable revision `1d8ad4ca9b3dd8059ad90a75d4983776a23d44af` and runs them locally
with `@huggingface/tokenizers`. The compressed tokenizer definition and config
ship in the Worker bundle and inflate within each Queue batch. Runtime indexing
never downloads assets from Hugging Face. Refresh the pinned assets with
`node scripts/vendor-search-tokenizer.mjs`; their source hashes and Apache 2.0
license ship beside the bundled data. Updating the model revision requires
regenerating these assets and changing the embedding namespace together.
Counts include tokenizer special tokens. Document embeddings use OpenRouter's
`search_document` task through the existing inference client. The binary boundary
search checks every accepted span; nonmonotonic BPE counts may leave budget unused,
but cannot admit an oversized span. No character-count approximation is used.

Whitespace-only semantic passages are omitted because embedding providers reject
blank inputs. Lexical text stays lossless, and meaningful chunks keep their
original text and exact UTF-16 offsets, canonical source ID, scope, and revision.
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

Production deployment and backfill remain to be completed and verified; the
512/128-token policy requires no environment configuration. Memory,
notes/table text, agent tools, and external provider ranking still need migration.
Conversation discovery queries the workspace namespace and authorizes each hit;
archived parents and automation runs still require navigation/coverage verification.
BM25/semantic canonical filtering can shorten a page; their refill and client
pagination are not implemented. Substring requests refill rejected candidates.

## Regional impact

Global projects content into Turbopuffer gcp-us-west1; EU uses gcp-europe-west1.
Namespace identity includes workspace, environment and region. Browser Run is a
Cloudflare hosted dependency in each regional Worker. The Qwen embedding provider
receives the source passages through the existing inference integration; the
Turbopuffer region alone does not establish residency for that separate processor.
No cross-region fallback is permitted.

## Security and trust model

Index content is never an access grant. Member routes reauthenticate after awaits,
and source loaders recheck canonical parent/private-child or connector ownership
before returning text. Connector resources retain their existing connection scope
and owner rules. Attachment access checks the exact owning child, including when
the main-feed directory has no attachment hint. The workspace namespace permits
candidate discovery without enumerating the directory; every candidate still
passes canonical authorization.

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
