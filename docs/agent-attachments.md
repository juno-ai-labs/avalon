# Agent attachments

The agent-attachment subsystem turns a file related to a work stream or an
automation draft into model-visible data without making a filename, resource ID,
cursor, or extracted byte an authorization grant. It owns the vocabulary and
limits used at the model boundary; the original resource relationships remain
the source of truth for display, scope, retention, and deletion.

Shared contracts, lifecycle, derivatives, authorized work-stream and automation
tools, and durable message manifests now form the runtime attachment boundary.
Non-image bytes never enter transcript projection. A triggering image may be
visible immediately, but its durable manifest and derivative are still the
source of truth for retry, replay, and compaction recovery.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/attachment-contracts.ts` | Single registry for attachment kinds, MIME/extension classification, strict tool argument schemas, exact success-output schemas, and the complete list-tool description. |
| `packages/contracts/src/index.ts` | Sanitizes bounded structured recovery data before Bind puts it in a model-visible failed tool result. |
| `apps/api/src/lib/attachment-cursor.ts` | Signs, verifies, scopes, expires, and bounds opaque attachment continuations. |
| `apps/api/src/services/attachment-derivative-state.ts` | Interprets explicit lifecycle state and lazily maps pre-migration resources. |
| `apps/api/src/services/attachment-derivative-service.ts` | Converts authorized originals into complete, versioned text/Office/PDF derivatives and bounded range indexes, then atomically selects their regional objects. |
| `apps/api/src/services/attachment-summary-service.ts` | Runs the isolated, range-grounded hierarchical reader and reports honest complete or sampled coverage. |
| `apps/api/src/services/resource-object-cleanup.ts` | Retries regional object deletion without logging object keys or provider bodies. |
| `apps/api/src/services/workstream-resource-visibility.ts` | Applies the sidebar/list/read/search principal boundary and fingerprints the visible inventory. |
| `apps/api/src/services/workstream-resource-inventory.ts` | Renders the bounded current-principal inventory appended to live and replayed compaction checkpoints. |
| `apps/api/src/services/workstream-attachment-tools.ts` | Implements pageable discovery plus bounded, versioned text reads and local search. |
| `apps/api/src/services/automation-draft-attachment-tools.ts` | Reuses those operations behind a frozen compiler-request ID set and fresh draft ownership checks. |
| `apps/api/src/services/attachment-model-content.ts` | Renders manifest-only non-image projection and bounded same-ID current-turn image derivatives. |
| `apps/api/src/services/integrations.ts` | Current message projection and work-stream resource-tool registration. |
| `apps/api/src/durable-objects/workstream-room.ts` | Loads the resource set displayed in the right sidebar under note-visibility rules. |
| `apps/api/src/services/resource-service.ts` | Creates, hydrates, and deletes original resource objects and current model image derivatives. |
| `packages/db/migrations/0073_attachment_derivative_lifecycle.sql` | Adds source identity, derivative lifecycle, model-object catalog, deletion outbox, and checkpoint-template version. |
| `packages/agent-harness/src/tool-activity.ts` | Human-facing transcript prose for attachment tool wire names. |

## How it works

### Kind and schema selection

Avalon classifies an attachment into exactly one of `image`, `markdown`, `pdf`,
`document`, `spreadsheet`, `presentation`, `text`, or `other`. A verified MIME
type wins. A sanitized final filename extension participates only when MIME is
missing or a generic binary type. The model selects a natural-language kind in
a list request; it never supplies or guesses a MIME filter.

The same registry renders the complete model-facing explanation and the Zod
enum. Strict schemas cover list, read, search, view, and summarize arguments and
their exact success results for both work-stream and future draft-scoped tools.
JSON Schema guides the provider, while the executor must parse the same strict
Zod schema because the harness does not enforce provider-facing JSON Schema.

### Continuations and recovery

An attachment cursor contains a version, purpose, expiry, principal identity,
owning scope, and operation-specific state. Avalon signs it using a key derived
for the attachment-cursor purpose from the regional Worker's configured session
signing secret. A cursor presented to another operation, principal, or scope is
the same bounded `invalid_cursor` failure as a malformed or tampered value;
expiry is separately recoverable as `cursor_expired`.

The common failed-tool sanitizer passes only fixed, bounded recovery fields. It
understands attachment kind and one strict suggested read or view call, while
discarding arbitrary provider, converter, credential, and file-authored objects.
The presence of a suggestion never executes it automatically.

### Durable projection boundary

Every human message attachment now carries one Avalon-generated JSON manifest
entry with its stable resource ID, filename, verified MIME, byte count, natural
kind, content mode, derivative state, bounded error code, and inline state.
Historical turns keep the manifest but never replay attachment bytes. A current
image is delivered in the same projection as its manifest and is marked
`inlined: true` only after normalization succeeds; a missing or failed visual
keeps the same identity with `inlined: false` and an explicit error code.

Triggering messages call `buildAttachmentModelParts`, but that name now means a
manifest plus successfully normalized image parts only. Text, Office, PDF, and
other source objects are not fetched during projection; all extraction happens
after current authorization through read, search, or summarize. The platform
prompt requires both the work-stream agent and automation architect to inspect a
referenced attachment before answering and to use `charactersBefore` and
`charactersAfter` rather than treating one page as the whole resource.

### Authorized work-stream discovery and text hydration

The right sidebar, list tool, read tool, and search tool all call one visibility
loader. It binds the work stream to its workspace and applies current note scope,
ownership, and archive state for the execution principal. A workspace principal
never inherits a user's private-note view. Knowledge of a resource ID or cursor
does not bypass this query.

`workstream_list_resources` returns 25 rows by default and at most 50, optionally
filtered by one of the eight natural-language kinds. Continuations bind the
principal, work stream, filters, size, ordering position, and a fingerprint of
the complete visible inventory. Any membership or visibility change invalidates
the scan rather than mixing old and new pages.

`workstream_read_resource` targets 12,000 and never exceeds 24,000 UTF-16
characters. Every result reports exact range, total, and character counts on
both sides, with independently usable previous and next cursors.
`workstream_search_resource` ranks the bounded term index deterministically,
returns no more than five passages or 20,000 passage characters, and gives every
passage a read cursor against the same derivative version.

`workstream_view_resource` accepts up to eight unique image IDs, keeps valid
members in request order, and returns a JSON inclusion summary followed by
ephemeral image parts. The JSON is the only durable receipt. A replay
reauthorizes the resource and rebuilds those parts from the selected regional
derivative. `workstream_summarize_resource` sends bounded chunks to an isolated
reader, verifies every returned range, and caps all model-authored strings. A
derivative beyond the reader budget is sampled across its length and explicitly
returns `partial` coverage.

### Compaction rediscovery

After the LLM produces its continuation summary, Avalon appends current visible
resource and message-attachment totals plus non-empty groups for the same eight
natural-language kinds used by the list tool. The aggregate comes from the
shared sidebar visibility loader, not the summary. It contains no name, ID, MIME
type, or content, so its size is constant in the number of resources. Exact
entries remain discoverable by paging `workstream_list_resources` until
`nextCursor` is null.

The stored checkpoint contains the raw LLM summary and a principal-neutral base
message only. Replay rerenders its appendix for the active principal, so resource
attachment, detachment, deletion, revocation, and private-note visibility are
reflected without rewriting remembered conclusions. Relevant resource IDs and
consulted derivative ranges still belong in the summary when unfinished work
needs them; the aggregate supplements that working set rather than replacing it.

### Automation-draft hydration

When a compiler request includes attachments, Avalon freezes the unique resource
IDs after verifying that every row is a draft upload owned by the requesting
user in the current workspace. The preloaded automation architect receives the
same list, read, search, view, and summarize definitions under `automation_*`
wire names. Their natural-kind list description names all eight supported kinds.

The frozen set is only an upper bound, never cached authority. Every operation
queries those IDs again and requires the same workspace, owner, upload provider,
and `attachment_status = 'draft'`. Deletion, ownership change, or promotion to
an attached resource therefore returns the same `resource_not_found` result as a
guessed ID. Automation cursors use a separate purpose namespace, so a work-stream
continuation cannot be replayed into the compiler. Conversion, paging, image
normalization, isolated summaries, and result bounds remain shared.

### Regional lifecycle

Uploads hash the exact bounded bytes before the resource row commits. Connector
hydration hashes a serialized result, writes a hash-versioned R2 object, then
atomically advances the resource and invalidates older model state. A legacy row
with a valid model-native image remains ready; another historical row with
original bytes becomes pending on first authorized use, while a missing original
is failed rather than an empty success.

`resource_model_objects` records active and superseded derivatives and indexes.
Deleting a resource—not merely detaching one relationship—copies every known
object reference into `resource_object_deletion_outbox` before cascading the
catalog. Scheduled cleanup reaps at most 100 references per pass. A failed R2
deletion increments bounded retry metadata and remains queued.

### Reusable derivatives

The derivative service accepts a resource that its caller has already
authorized. It reads the exact original R2 object, claims conversion through a
conditional D1 update, writes versioned content and index objects, then advances
the current resource pointer only when both objects are complete. A concurrent
caller sees `processing`; an unchanged source hash and extractor version reuses
the selected objects without reading or converting the original again.

UTF-8 text retains its full ordering and is rejected rather than replacement-
decoded when invalid. DOCX becomes semantic Markdown with headings, lists,
tables, hyperlinks, headers, footers, footnotes, and endnotes. PPTX preserves
slide order, tables, and speaker-note text. XLSX identifies sheets, cell
references, display values, and formulas. PDFs are page-delimited; a bounded OCR
adapter is required when the text layer is materially empty, and incomplete OCR
is a failure rather than empty success.

The companion index stores only UTF-16 ranges, section labels, and bounded
normalized terms. It never duplicates the complete derivative. Tool reads and
searches can therefore load exact passages from the versioned derivative while
checking offsets against the same hash and extractor version.

## Invariants

- A verified MIME type outranks a filename extension, so renamed hostile bytes
  cannot choose their converter or model tool.
- All eight kinds and their descriptions come from one registry, so a smaller
  routed model never receives an enum whose meaning exists only in unrelated
  prose.
- Provider-facing schemas and executor parsing remain strict, so an invented
  MIME filter, old field, or mixed cursor/first-call shape fails instead of being
  silently ignored.
- A cursor is authenticated and bound to purpose, principal, and scope, but every
  dereference still reauthorizes current state; stealing or guessing a cursor
  cannot preserve revoked access.
- Structured failure data is allowlisted and bounded before it enters the model
  transcript, so a converter or provider cannot smuggle a response body,
  credential, or attachment instruction through an error.
- Runtime eager projection is removed only after replacement tools exist on both
  work-stream and automation-draft surfaces, so an intermediate deployment
  cannot strand a file behind a manifest the model cannot hydrate.
- Relationship detachment revokes discovery and access but does not delete shared
  objects; resource deletion, expiry, or orphan ownership ends the object
  lifecycle.
- Original content identity describes the exact selected R2 bytes, so a cursor or
  derivative version cannot silently cross into newly hydrated content.
- A model derivative becomes current only after its content and bounded index
  objects are complete; losing a concurrent claim cannot expose either object.
- Index offsets use JavaScript UTF-16 units and do not split surrogate pairs, so
  the later read contract and persisted index agree exactly.
- The sidebar and agent inventory share one visibility function; adding a second
  resource-visibility query is a contract change, not a local optimization.
- `nextCursor: null` is the only evidence that a filtered listing is exhausted,
  while zero characters on both sides is the only whole-resource read.

## Boundary

This module owns model-facing attachment identity, classification, derivative
selection, hydration contracts, continuation, recovery, and eventually
compaction rediscovery. It depends on `resources`, `workstream_resources`,
`message_attachments`, note visibility, regional D1/R2 bindings, and the harness
tool loop.

It does not own composer upload UX or transcript download/display; those remain
with the resource and composer modules. It does not turn an ID into authority,
search arbitrary workspace content, edit documents, or transcribe audio/video.
Connector-origin relationships are owned by
[`workstream-origin-attachments.md`](workstream-origin-attachments.md), and the
generic tool execution/receipt loop is owned by
[`agent-harness.md`](agent-harness.md).

## Failure modes and limits

- Opaque cursors are at most 2,048 characters. Invalid scope, purpose, signature,
  encoding, or shape returns `invalid_cursor`; an elapsed expiry returns
  `cursor_expired`.
- List calls accept 1–50 items, defaulting later to 25. View calls accept 1–8
  unique resource IDs and a long edge from 64–2,048 pixels.
- Search accepts a 1–1,000-character query, at most five matches, and passages
  from 500–4,000 characters. A complete result is later capped at 20,000 passage
  characters.
- Summarize accepts a 1–2,000-character prompt addition and a 2,000–20,000
  output-character budget.
- Structured recovery details are at most 8,000 serialized characters; reason
  text is at most 1,000, MIME/enum-like values at most 160, and `available` at
  most twenty bounded strings.
- Transcript projection fetches no non-image source or derivative bytes. One
  manifest entry is emitted even when the source is missing or conversion fails.
- Object cleanup reads at most 100 outbox rows per pass. Failures keep their row
  and store only a bounded machine error code.
- Derivative conversion admits at most 50 MiB of source bytes, 40 MiB of expanded
  Office data, 8 MiB per selected XML part, 500 PDF pages, 20 million output
  characters, 5,000 index chunks, and 30 seconds of converter time. Image pixel,
  source, derivative, and frame limits remain owned by the existing normalized
  image path until projection is split at cutover.
- Invalid UTF-8, XML entity declarations, corrupt/oversized Office archives,
  encrypted/oversized PDFs, missing OCR, incomplete OCR, timeouts, unsupported
  formats, and missing source objects have distinct bounded failure codes.
- Image projection admits at most eight images, 20 MiB of source bytes, 40
  million source pixels, 10 MiB of derivative bytes, and a 2,048-pixel native
  long edge. Cloudflare Images scale-down is bounded to that same edge.

## Testing

- `packages/contracts/src/attachment-contracts.test.ts` locks kind order,
  description coverage, MIME precedence, strict arguments, and exact outputs.
- `packages/contracts/src/index.test.ts` locks structured-failure allowlisting
  and rejects malformed remediation.
- `apps/api/test/attachment-cursor.test.ts` covers round trips, tampering,
  cross-purpose/principal/scope replay, expiry, and the length cap.
- `packages/agent-harness/src/tool-activity.test.ts` covers human prose for every
  attachment tool wire name.
- `apps/api/test/attachment-model-content.test.ts` proves non-image objects are
  never fetched, every failure keeps a manifest, same-ID image delivery, and the
  exact source-byte, pixel, derivative-byte, count, and edge boundaries.
- `apps/api/test/attachment-derivative-service.test.ts` covers complete long
  Markdown, semantic Office structures, page/OCR extraction, malformed and
  unsupported inputs, exact UTF-16 indexing, concurrent claims, atomic
  selection, and ready-version reuse.
- `apps/api/test/workstream-attachment-tools.test.ts` covers more-than-fifty
  pagination, natural-language filtering, exact two-sided read arithmetic,
  tampering/version invalidation, bounded search, ordered image batches,
  normalization failure, wrong-kind recovery, focused summaries, receipt
  rehydration, and workspace/private-note equivalence.
- `apps/api/test/attachment-summary-service.test.ts` covers complete
  hierarchical and sampled-partial summaries, prompt trust placement, citation
  validation, output budgets, and provider failure. The harness suite proves
  ephemeral image parts reach only the next model request and never its durable
  completion event. `apps/api/test/workstream-read-state.test.ts` proves the
  sidebar uses the same visibility boundary.
- `packages/db/test/migrations.test.ts`,
  `apps/api/test/resource-upload.test.ts`,
  `apps/api/test/attachment-derivative-state.test.ts`, and
  `apps/api/test/resource-object-cleanup.test.ts` cover lifecycle schema,
  exact-byte hashing, legacy interpretation, derivative-change and deletion
  receipt invalidation, cleanup retry, and convergence.

Run focused suites from their package directories through `pnpm --filter`, then
run the repository-wide lint, typecheck, and test gates before committing. Cursor
tests use an explicit clock value; do not replace it with sleeps or retries.

## Data model

`resources` owns original and current model refs plus original SHA-256,
derivative status, extractor version, readable-character count, extraction time,
bounded error code, and current index ref. `resource_model_objects` catalogs
active or superseded model objects, while `resource_object_deletion_outbox`
survives resource deletion long enough to remove R2 objects.
`attachment_tool_receipts` maps completed read, search, view, and summary
receipts to the exact derivative hashes they used. A replacement or deletion
invalidates the complete invocation and queues its JSON replay object; the map
stores no excerpts, prompts, image parts, or data URIs.
`message_attachments` and `workstream_resources` remain relationship and
visibility authorities. [`data-model.md`](data-model.md) and migrations are
authoritative.

## Regional impact

Contracts, lifecycle, and conversion execute identically in both regions. Cursor
signing happens inside the Worker that handles the owning regional run. Existing
originals and model derivatives remain in that region's R2 bucket and
relationship, lifecycle, and outbox rows in its D1 database. Scheduled cleanup
uses the same regional R2 binding. No new Global-plane storage or bridge payload
is introduced by this phase.

## Security and trust model

Filenames, declared MIME, extracted text, file metadata, and provider/converter
failures are untrusted. Classification consumes a server-verified MIME value;
the extension fallback is deliberately narrow and cannot override a specific
MIME type. Cursor signatures prevent state tampering but do not replace database
authorization. Unknown structured error keys are discarded before Bind builds a
tool result.

The shared session secret is not used directly as a cursor MAC key: a fixed
purpose-separation derivation produces the attachment-cursor signing key. Cursor
payloads contain identifiers and offsets, never credentials, file contents, or
resource bytes.

## Operations

An unexpected raw tool name in a transcript points first to
`packages/agent-harness/src/tool-activity.ts`. Repeated `invalid_cursor` failures
should be split into schema/length, signature, expiry, and authorization metrics
without logging the cursor itself. The scheduled Worker drains
`resource_object_deletion_outbox`; a growing oldest `created_at` or
`attempt_count` means R2 cleanup is unhealthy. Inspect bounded events by resource
ID and object kind, never object key.

## Performance and cost

Kind classification is constant-time over bounded metadata. Cursor verification
performs two HMAC operations and parses at most 2,048 characters. Conversion is
lazy and reused by exact original hash plus extractor version; only scanned PDFs
need the injected provider OCR path. Index storage grows with bounded chunks and
terms rather than duplicating attachment text. Later phases must preserve those
cheap discovery and continuation paths.

## Changelog

### 2026-08-12 — Compaction inventory stays synchronized with visible resources

**What changed:** Live and replayed checkpoints now include fixed-order totals
for visible resources, message attachments, and non-empty natural attachment
kinds. The appendix is rebuilt from the same current-principal visibility loader
as the sidebar; only the principal-neutral LLM summary is persisted.

**Why:** Images and documents remain durable resources after their prompt bytes
leave context, but a selective summary is not a complete or current catalog.
Regenerating a bounded aggregate restores discovery without copying every
attachment into the checkpoint or leaking one viewer's private notes to another.

**Considered and rejected:** MIME summaries, a stored filename/ID catalog, and
LLM-generated totals. Natural kinds are easier for routed models, a full catalog
grows without bound, and model prose cannot track current authorization.

**Consequences:** Changes to sidebar visibility must continue flowing through
`loadVisibleWorkstreamResources`; compaction, sidebar, and list must never grow
independent interpretations. Exact recovery always goes through the filtered,
paginated resource tool.

### 2026-08-12 — Projection becomes manifest-only for non-images

**What changed:** Work-stream and automation transcript projection no longer
reads or emits text, Office, PDF, or unsupported-file bytes. Platform guidance
requires attachment inspection and honest continuation from exact side counts.
Native image admission now validates dimensions and enforces source, pixel,
derivative, count, and long-edge limits before emitting a same-ID visual part.

**Why:** The legacy 60,000-character prefix looked complete enough for a model
to answer while hiding decisive evidence in the second half. Larger prompt caps
only move that silent cutoff and increase every later turn's context cost.

**Considered and rejected:** Raising the inline limit, keeping native PDF parts,
and allowing signature-only native images. They preserve partial coverage,
bypass the common derivative/read contract, or leave pixel and dimension bombs
unchecked.

**Consequences:** A task about an attachment must hydrate it through the scoped
tools unless its required visual is already inlined. A page with characters on
either side is explicitly partial. Projection remains cheap and deterministic;
complete content lives only in regional derivative storage and bounded results.

Pull request: pending. Design:
`docs/PRDs/2026-08-12_context-safe-agent-attachments/prd.md`.

### 2026-08-12 — Automation drafts gain revocable attachment tools

**What changed:** Compiler requests with attachments now preload draft-scoped
list, read, search, view, and summarize tools. The executor freezes the admitted
ID set, rechecks current workspace/owner/draft state on every call, uses a
separate cursor namespace, and emits automation-specific self-healing calls.

**Why:** Durable manifests cannot safely replace eager compiler prompt bytes
until the architect has a bounded way to hydrate every admitted format. A frozen
ID list alone is not enough because an upload can be deleted or cease to be the
caller's draft while the model is working.

**Considered and rejected:** A globally readable attachment-by-ID tool, copying
the work-stream visibility query into the compiler, and treating the frozen set
as permanent authorization. They respectively turn IDs into bearer tokens,
conflate unrelated ownership models, or preserve revoked access.

**Consequences:** Draft and work-stream wrappers share conversion and paging but
not cursor purposes or authorization. The eager non-image compiler projection
can now be removed together with the work-stream legacy projection in the next
cutover commit.

Pull request: pending. Design:
`docs/PRDs/2026-08-12_context-safe-agent-attachments/prd.md`.

### 2026-08-12 — Message history gains durable attachment identities

**What changed:** Trigger and historical human-message projection now render a
compact structured manifest for every attachment. Trigger images carry the same
resource ID as their visual part and record whether delivery succeeded;
historical turns retain identity and state without replaying bytes. Legacy
trigger text, Office, and PDF content remains temporarily additive.

**Why:** A filename-only historical marker cannot rehydrate an image after
compaction, while switching non-image attachments to references before the
automation compiler can read those references would make files inaccessible.

**Considered and rejected:** Anonymous image parts, copying historical bytes,
and an immediate manifest-only cutover. They respectively lose durable visual
identity, regrow context on every replay, or create an unsafe deployment gap.

**Consequences:** Every model-visible image must be produced alongside its
same-ID manifest entry, and manifest strings remain JSON-encoded untrusted data.
The next rollout step must add frozen, draft-scoped automation tools before the
remaining eager content can be deleted.

Pull request: pending. Design:
`docs/PRDs/2026-08-12_context-safe-agent-attachments/prd.md`.

### 2026-08-12 — Images and large-document understanding become recoverable

**What changed:** Work-stream agents can reload up to eight ordered image
derivatives and request a focused, isolated summary of a readable derivative.
Wrong content tools return exact read/view calls after authorization. Live image
parts are stripped from completion events and receipts, then rehydrated from
regional state on safe receipt replay.

**Why:** An image visible only on its trigger turn disappears after retry or
compaction, while copying it into durable JSON creates the opposite context and
storage failure. Streaming every page of a large document into the main run has
the same context cost in text form.

**Considered and rejected:** Binary JSON results, automatic execution of a
suggested correction, and unqualified whole-document summaries over sampled
input. The chosen contracts keep the model in control of correction while
making coverage and persistence boundaries explicit.

**Consequences:** The model-facing result may contain ephemeral parts that are
absent from its receipt by design. Every new view kind therefore needs a
reauthorizing rehydrator, and every summary provider must return ranges the host
can verify before exposing them.

Pull request: pending. Design:
`docs/PRDs/2026-08-12_context-safe-agent-attachments/prd.md`.

### 2026-08-12 — Sidebar-parity discovery and bounded text hydration ship

**What changed:** `workstream_list_resources` replaces the hard-capped
`workstream_read` index, and work-stream runs can page, filter, read exact
character ranges in either direction, and search one versioned derivative. One
principal-aware loader now supplies both agent inventory and sidebar resources.

**Why:** A model cannot inspect what it cannot completely discover, and a
separate fifty-row tool query could silently drift from the person's Resources
rail. Whole-file text results also recreate the context failure the derivative
was meant to solve.

**Considered and rejected:** Offset pagination without an inventory fingerprint,
MIME filters, and a read response with only `complete`. Those respectively mix
changed inventories, force smaller models to guess provider formats, and hide
how much context remains on either side of a passage.

**Consequences:** Every attachment dereference re-runs current visibility and
checks the selected derivative version. Models follow list cursors until null
for complete inventory coverage and use the explicit before/after counts for
complete document coverage. Later compaction aggregation must call the same
visibility loader.

Pull request: pending. Design:
`docs/PRDs/2026-08-12_context-safe-agent-attachments/prd.md`.

### 2026-08-12 — Complete derivatives replace trigger-specific conversion

**What changed:** Avalon can now lazily create complete, reusable UTF-8,
semantic Office, and page-delimited PDF derivatives with a bounded range/term
index. Regional D1 conditionally claims work and atomically selects finished R2
objects; unchanged source and extractor versions reuse the current result.

**Why:** The old trigger converter discarded everything after 60,000 characters
and could not support deterministic page/search continuation. Moving the same
helpers behind a reusable boundary also lets work-stream and automation tools
share conversion without sharing authorization.

**Considered and rejected:** Persisting chunk text in the index, accepting lossy
UTF-8 replacement, and treating an empty PDF text layer as a successful empty
file. Those choices respectively create a second unbounded content copy, hide
corrupt input, or let a scanned document masquerade as inspected.

**Consequences:** Callers authorize before invoking this service and supply the
bounded OCR adapter for scanned PDFs. Future text tools slice the versioned
derivative using UTF-16 ranges and must not read the source directly. A new
extractor version creates new versioned objects and lets lifecycle cleanup reap
the superseded pair.

Pull request: pending. Design:
`docs/PRDs/2026-08-12_context-safe-agent-attachments/prd.md`.

### 2026-08-12 — Derivative state and cleanup follow the resource lifecycle

**What changed:** Regional resources now identify exact original content and
carry explicit pending, processing, ready, failed, or unsupported model state.
Active and superseded model objects are cataloged, and resource deletion durably
enqueues every original, derivative, and index reference for bounded cleanup.
Historical resources are interpreted lazily without a backfill.

**Why:** Paging and compaction recovery need a stable derivative version, while
the old image-only columns could not distinguish “not converted yet” from
“conversion failed” or prove which original produced them. Deleting only current
columns also leaves superseded conversions behind in regional R2.

**Considered and rejected:** A workspace-wide eager conversion backfill and
object deletion on relationship detachment. The former creates unbounded regional
load before anyone asks to read the files; the latter mistakes a many-to-many
visibility edge for ownership and can destroy a resource still in use.

**Consequences:** Every ingestion path that stores bytes must maintain their
SHA-256 or let the first authorized derivative request calculate it. Derivative
writers register objects and advance rows atomically; resource owners delete the
row to end storage, while detachment only changes authorization.

Pull request: pending. Design:
`docs/PRDs/2026-08-12_context-safe-agent-attachments/prd.md`.

### 2026-08-12 — Attachment contracts are centralized before runtime cutover

**What changed:** Avalon now has one natural-language attachment-kind registry,
strict argument and success schemas for the complete attachment tool family,
bounded self-healing failure data, authenticated scoped cursors, and explicit
transcript prose for the future wire names. Runtime projection remains on the
legacy path until replacement tools are safe to activate.

**Why:** A large Markdown trigger was presented as a plausible 60,000-character
prefix and answered without its second half, while images lost their reloadable
identity at compaction. The replacement surface has to work for medium and small
models: free-form MIME guessing, ambiguous paging knobs, and vague wrong-tool
errors would move the same correctness failure into the tool loop.

**Considered and rejected:** Separate model tools per MIME type, a free-form MIME
filter, unauthenticated base64 continuations, and removing eager projection in
the contract commit. Each either makes the model memorize provider formats,
allows cursor state to be altered, or creates a deployment window in which a
manifest points to no usable hydration path.

**Consequences:** Every later attachment surface must reuse the registry and
strict schemas, retain cursor reauthorization, and update this document in the
same commit. The repository temporarily carries inert replacement contracts
beside legacy runtime behavior; that duplication is the deliberate price of an
additive rollout and must disappear at the manifest-only cutover.

Pull request: pending. Design:
`docs/PRDs/2026-08-12_context-safe-agent-attachments/prd.md`.
