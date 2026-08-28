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
| `apps/api/src/services/attachment-derivative-service.ts` | Converts authorized originals into complete, versioned text/Office/PDF derivatives, then atomically selects their regional objects. |
| `apps/api/src/services/attachment-summary-service.ts` | Runs one isolated bounded reader over server-identified source ranges and reports honest complete or sampled coverage. |
| `apps/api/src/services/resource-object-cleanup.ts` | Retries regional object deletion without logging object keys or provider bodies. |
| `apps/api/src/services/workstream-resource-visibility.ts` | Defines the shared principal-visibility SQL and provides full sidebar, bounded point lookup, keyset page, and aggregate inventory queries. |
| `apps/api/src/services/workstream-resource-inventory.ts` | Renders the bounded current-principal inventory appended to live and replayed compaction checkpoints. |
| `apps/api/src/services/workstream-attachment-tools.ts` | Implements pageable discovery plus bounded, versioned text reads and local search. |
| `apps/api/src/services/automation-draft-attachment-tools.ts` | Reuses those operations behind a frozen compiler-request ID set and fresh draft ownership checks. |
| `apps/api/src/services/attachment-model-content.ts` | Renders manifest-only non-image projection and bounded same-ID current-turn image derivatives. |
| `apps/api/src/services/attachment-tool-receipts.ts` | Atomically binds completed attachment results to current derivative hashes and revalidates replay dependencies. |
| `apps/api/src/services/integrations.ts` | Current message projection, work-stream resource-tool registration, and authorization-aware receipt replay. |
| `apps/api/src/durable-objects/substream-agent.ts` | Loads the resource set displayed in the right sidebar under note-visibility rules. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | Hydrates attachment descriptors from durable participant-turn parts into ordered transcript snapshots. |
| `apps/api/src/services/resource-service.ts` | Creates, hydrates, and deletes original resource objects, and serves authorized person-facing previews from the original image/text or the reusable document derivative. |
| `packages/contracts/src/workstream-transcript.ts` | Defines the attachment descriptor carried by a participant transcript text block. |
| `apps/desktop/src/renderer/lib/transcript.ts` | Maps canonical transcript descriptors back into the existing attachment-tile view model. |
| `apps/desktop/src/renderer/components/inspector-rail.tsx` | Consumes the person-facing preview route in the rail's resource detail, and holds the client half of the `resource_processing` retry contract below. |
| `packages/db/migrations/0073_attachment_derivative_lifecycle.sql` | Adds source identity, derivative lifecycle, tenant-scoped receipts/object cleanup, principal-scoped checkpoints, and the monotonic work-stream inventory revision. |
| `packages/agent-harness/src/tool-activity.ts` | Human-facing transcript prose for attachment tool wire names. |

## How it works

### Kind and schema selection

Rally classifies an attachment into exactly one of `image`, `markdown`, `pdf`,
`document`, `spreadsheet`, `presentation`, `text`, or `other`. A verified MIME
type wins. A sanitized final filename extension participates only when MIME is
missing or a generic binary type. The model selects a natural-language kind in
a list request; it never supplies or guesses a MIME filter.

The same registry renders the complete model-facing explanation and the Zod
enum. Strict schemas cover list, read, search, view, and summarize arguments and
their exact success results. Work streams expose all five operations; the
automation architect receives the four content operations because its complete
set of at most ten resources is already present in the current-turn manifest.
JSON Schema guides the provider, while the executor must parse the same strict
Zod schema because the harness does not enforce provider-facing JSON Schema.

### Continuations and recovery

An attachment cursor contains a version, purpose, expiry, principal identity,
owning scope, and operation-specific state. Rally signs it using a key derived
for the attachment-cursor purpose from the regional Worker's configured session
signing secret. A cursor presented to another operation, principal, or scope is
the same bounded `invalid_cursor` failure as a malformed or tampered value;
expiry is separately recoverable as `cursor_expired`.

The common failed-tool sanitizer passes only fixed, bounded recovery fields. It
understands attachment kind and one strict suggested read or view call, while
discarding arbitrary provider, converter, credential, and file-authored objects.
The presence of a suggestion never executes it automatically.

### Durable projection boundary

Every human message attachment now carries one Rally-generated JSON manifest
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
prompt requires the active agent—work-stream agent or automation architect—to
inspect a referenced attachment before answering and to use `charactersBefore`
and `charactersAfter` rather than treating one page as the whole resource.
The host also enforces that promise: if a read, search, view, or summary call
fails or a completed multi-image view skips a requested resource, and no later
successful content access resolves the same resource, the model receives one
corrective turn and cannot publish attachment facts. Cursor reads attach their

The person-facing ordered transcript uses the same durable relationship. The
snapshot storage layer joins each participant text part to its ordered
`workstream_message_attachments`, emits metadata only, and the desktop
reconstructs attachment tiles from that descriptor. An optimistic tile may
disappear only when a canonical turn with the same message identity has arrived;
reconnect must not depend on the optimistic row or the resource rail to
reconstruct ownership.
resolved resource identity to structured failures so a successful restart by
resource ID clears the same guard entry instead of leaving a tool-call-only
false positive. A run
that still ends replaces its prose with a deterministic, content-free
`Attachment content unverified` boundary carrying only resource/tool/error
provenance. `attachment_grounding_guard_triggered` records the same bounded
identities without content.

### Authorized work-stream discovery and text hydration

The right sidebar and attachment tools compose one visibility SQL boundary. It
binds the work stream to its workspace and applies current note scope, ownership,
and archive state for the execution principal. The sidebar loads its displayed
set, while model tools use bounded point, batch, aggregate, and keyset-page
queries. A workspace principal never inherits a user's private-note view.
Knowledge of a resource ID or cursor does not bypass this query.

`workstream_list_resources` returns 25 rows by default and at most 50, optionally
filtered by one of the eight natural-language kinds. Continuations bind the
principal, work stream, filters, size, ordering key, and a monotonic work-stream
inventory revision. SubstreamAgent advances that revision for relationship, message-
attachment, classification/content identity, and note-visibility mutations, but
not hydration timestamps or derivative processing bookkeeping. A continuation
compares it before and after its bounded queries, so a relevant change
invalidates the scan rather than mixing old and new pages.

`workstream_read_resource` targets 12,000 and never exceeds 24,000 UTF-16
characters. Every result reports exact range, total, and character counts on
both sides, with independently usable previous and next cursors.
`workstream_search_resource` scans deterministic in-memory ranges from the
already bounded derivative, centers passages on actual phrase or term matches,
returns no more than five passages or 20,000 passage characters, and gives every
passage a read cursor against the same derivative version.

`workstream_view_resource` accepts up to eight unique image IDs, keeps valid
members in request order, and returns a JSON inclusion summary followed by
ephemeral image parts. The JSON is the only durable receipt. A replay
reauthorizes every dependency, verifies the exact derivative hashes, and
rebuilds those parts from the selected regional derivative. Missing visual bytes
invalidate the receipt and re-execute the safe read; they never degrade to stale
JSON without pixels. `workstream_summarize_resource` makes one isolated inference
over at most 80,000 characters sampled across the derivative. The model selects
Rally-generated source IDs, which the server maps to exact ranges rather than
trusting model-authored offsets. All model-authored strings are capped, and a
derivative beyond the reader budget explicitly returns `partial` coverage.

### Compaction rediscovery

After the LLM produces its continuation summary, Rally appends current visible
resource and message-attachment totals plus non-empty groups for the same eight
natural-language kinds used by the list tool. The aggregate comes from a grouped
query using the shared sidebar visibility predicate, not the summary. It contains no name, ID, MIME
type, or content, so its size is constant in the number of resources. Exact
entries remain discoverable by paging `workstream_list_resources` until
`nextCursor` is null.

The stored checkpoint contains the raw LLM summary plus the execution-principal
key and authorized resource-inventory revision captured by an O(1) read before
summarization. Rally runs the grouped inventory query once when rendering the
appendix, verifies the revision there, and includes it in the conditional
SubstreamAgent SQL statement that persists the checkpoint. Replay uses
the summary only for an exact scope match; attachment, detachment, deletion,
revocation, private-note visibility, or principal changes invalidate it and fall
back to durable transcript replay. Relevant resource IDs and consulted
derivative ranges still belong in the summary when unfinished work needs them;
the aggregate supplements that working set rather than replacing it.

### Automation-draft hydration

When a compiler request includes attachments, Rally freezes the unique resource
IDs after verifying that every row is a draft upload owned by the requesting
user in the current workspace. The preloaded automation architect receives the
complete manifest plus read, search, view, and summarize definitions under
`automation_*` wire names. It has no paginated list tool because the frozen set
is already visible and cannot exceed ten resources.

The frozen set is only an upper bound, never cached authority. Every operation
queries those IDs again and requires the same workspace, owner, upload provider,
and `attachment_status = 'draft'`. One bounded query reloads the entire frozen
set. Deletion, ownership change, or promotion to
an attached resource therefore returns the same `resource_not_found` result as a
guessed ID. Automation cursors use a separate purpose namespace, so a work-stream
continuation cannot be replayed into the compiler. Conversion, paging, image
normalization, isolated summaries, and result bounds remain shared.

### Terminal resource exchange

The Terminal plugin reuses the same authorized resource and lifecycle boundary
without projecting original bytes into the model. `terminal_import_resource`
resolves one resource through current work-stream/principal visibility, streams
its regional R2 original through the Worker, verifies its stored hash, and writes
it into the current authority-fenced sandbox generation. Daytona receives no R2
credential or signed URL. An omitted destination is deterministic beneath
`.rally/resources/`; an explicit destination is create-only unless the model
states `overwrite: true`.

`terminal_publish_resource` reads one stable nonempty regular file from the
host-provided output directory, classifies it with the attachment MIME/kind
registry, pre-registers the regional object in the cleanup outbox, writes R2,
then creates and attaches a normal generated `resources` row. The work stream
and the normalized published path derive `provider_resource_id`, so publishing
that path again updates the document rather than duplicating it; a settled
call's replay returns the same resource by content hash, and one recorded under
the earlier receipt-derived identity is still found by it. Detachment and deletion therefore follow the existing
inventory revision, derivative, replay-dependency, and cleanup rules. Command
logs and expiry diffs use the same generated-resource shape. The sandbox bridge
itself is documented in [`terminal-workspaces.md`](terminal-workspaces.md).
Generated Terminal publications attach with relationship `generated`, so the
work-stream contract exposes them as `direction: artifact`. A subsequent
semantic update to an existing resource advances its WorkspaceDO version rather
than replacing the only readable state.

### Regional lifecycle

Uploads hash the exact bounded bytes before the resource row commits. Connector
hydration hashes a serialized result, writes a hash-versioned R2 object, then
atomically advances the resource and invalidates older model state. A legacy row
with a valid model-native image remains ready; another historical row with
original bytes becomes pending on first authorized use, while a missing original
is failed rather than an empty success.

Writers pre-register each generation-unique object in
`resource_object_deletion_outbox` before its R2 write. A successful pointer
compare-and-swap cancels the new object's pending deletion and enqueues the former
pointer. `resource_versions` retains the original and derivative refs selected by
every semantic version; cleanup treats those historical refs as active. Deleting
a resource—not merely detaching one relationship—enqueues every retained original
and derivative. Scheduled cleanup reaps at most 100 references per pass; a failed
R2 deletion increments bounded retry metadata and remains queued.

### Reusable derivatives

The derivative service accepts a resource that its caller has already
authorized. It reads the exact original R2 object, claims conversion through a
fenced, time-bounded conditional WorkspaceDO update, writes one generation-unique content
object, then advances the current resource pointer only when that object is
complete and the same claim still owns publication. A concurrent caller sees
`processing`; an abandoned claim becomes reclaimable after five minutes. An
unchanged source hash and extractor version reuses the selected objects without
reading or converting the original again.

UTF-8 text retains its full ordering and is rejected rather than replacement-
decoded when invalid. Extractor v2 recognizes CSV and TSV as plain UTF-8 even
when classification labels them as spreadsheets; a terminal failed or
unsupported v2 result is reused instead of rereading R2 on every tool retry.
DOCX becomes semantic Markdown with headings, lists,
tables, hyperlinks, headers, footers, footnotes, and endnotes. PPTX preserves
slide order, tables, and speaker-note text. XLSX identifies sheets, cell
references, display values, and formulas. PDFs are page-delimited; a bounded OCR
adapter is required when the text layer is materially empty, and incomplete OCR
is a failure rather than empty success.

Every uncached attempt emits one content-free
`attachment_derivative_phase_finished` event for `source_read`, `claim`,
`convert`, and `publish`, correlated by workspace, work stream, harness run,
tool call, and resource. Operators can therefore locate a slow retry phase
without logging the filename or extracted bytes.

The message-feed preview endpoint reuses this same current derivative after the
ordinary resource visibility query authorizes the signed-in person. Images,
Markdown, and readable text such as plain text or CSV come from their exact
original object; PDF and Office formats materialize or reuse the semantic derivative. The endpoint never treats
a resource ID as authority and never creates a second display-only conversion.
Presentation remains a desktop concern: Markdown derivatives go through the
shared renderer, while plain source text stays literal monospace text.

A preview is often asked for while its derivative is still being built — the
route materializes on demand, so the first person to open a document attached
moments ago routinely arrives mid-conversion. That answer is 409
`resource_processing`, carrying the delay the derivative service named: 250 ms
after a lost compare-and-set, one second while another caller holds a live
claim. It is a *not yet*, not a *no*, and every named path out of it is
terminal: the holder publishes, its conversion records `conversion_timeout` or a
failure — both cached against the extractor version, so the next caller is told
no rather than asked to wait — or its lease goes stale and the next caller
converts. A surface showing a preview therefore waits out the delay the response
carried and reads again, cancelling that wait when the reader moves on; it does
not invent an interval of its own, and it does not extend the same treatment to
a 404 or a 422, which are answers. What the client does own is when to stop,
which is the invariant below. The inspector rail's resource detail does this
today. The lightbox does not — it renders the processing message as terminal —
and it is reached from three places: the message feed, and the composer in both
creation flows, so a document previewed before it is ever sent hits the same
mid-conversion window as a cited one.

Search derives UTF-16-safe ranges and section labels directly from the bounded
versioned derivative, so it needs no second R2 object or lifecycle. Tool reads
and searches check offsets against the same hash and extractor version. At the
two-million-character derivative ceiling, read, search, and
summarize may hold one complete derivative while returning bounded model
content; that proved Worker-memory ceiling replaces the former twenty-million-
character envelope.

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
- A model derivative becomes current only after its content object is complete;
  losing a fenced claim cannot publish that object or
  overwrite the newer claim's terminal state.
- Every completed attachment receipt rechecks current resource visibility and
  derivative hashes before replay. List results and receipts without a complete
  dependency set re-execute instead of becoming stale authorization snapshots.
- Search and read offsets use JavaScript UTF-16 units and do not split surrogate
  pairs.
- The sidebar and agent inventory share one visibility predicate. Full sidebar,
  point, keyset-page, and grouped queries may differ only in result shape and
  bounds, never authorization semantics.
- `nextCursor: null` is the only evidence that a filtered listing is exhausted,
  while zero characters on both sides is the only whole-resource read.
- `resource_processing` is the only preview rejection that is a *not yet*: it
  names the delay to wait, and a client that renders it as permanent
  unavailability is wrong. Every other preview rejection is final, and re-asking
  cannot change it.
- **A client waits out `resource_processing` for one claim lease plus one
  converter timeout, and no longer.**
  `ATTACHMENT_PROCESSING_LEASE_MS + ATTACHMENT_CONVERTER_TIMEOUT_MS` is the
  longest a `processing` answer can still be followed by a *ready* one: another
  caller's claim runs out its whole lease without publishing, and only then does
  this caller take the stale claim and spend a full converter timeout doing the
  conversion itself. Both constants are shared rather than server-private for
  exactly this arithmetic — a client holding its own copy gives up early,
  silently, the day either is raised here.

## Boundary

This module owns model-facing attachment identity, classification, derivative
selection, hydration contracts, continuation, recovery, and compaction
rediscovery. It depends on WorkspaceDO `resources`/notes/R2 lifecycle state,
SubstreamAgent work-stream links/part attachments/inventory revision, the
regional R2 binding, and the harness tool loop. Cross-object reads are separate
and version-fenced; no SQL join spans the two object databases.

It does not own composer upload UX or the desktop lightbox presentation; those
remain with the composer and renderer modules. It does not turn an ID into
authority, search arbitrary workspace content, edit documents, or transcribe
audio/video.
Connector-origin relationships are owned by
[`workstream-origin-attachments.md`](workstream-origin-attachments.md), and the
generic tool execution/receipt loop is owned by
[`agent-harness.md`](agent-harness.md).

## Failure modes and limits

- Opaque cursors are at most 2,048 characters. Invalid scope, purpose, signature,
  encoding, or shape returns `invalid_cursor`; an elapsed expiry returns
  `cursor_expired`.
- List calls accept 1–50 items, defaulting to 25. View calls accept 1–8
  unique resource IDs and a long edge from 64–2,048 pixels.
- Search accepts a 1–1,000-character query, at most five matches, and passages
  from 500–4,000 characters. A complete result is capped at 20,000 passage
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
- Derivative conversion admits at most 8 MiB of source bytes, 12 MiB of selected
  expanded Office XML, 3 MiB per selected XML part, 200 PDF pages, two million
  UTF-16 output characters. Async PDF/OCR work has a
  30-second deadline. Local Office parsing is not timer-preemptible; its safety
  boundary is the smaller source, selected-entry, and expansion ceilings checked
  before rendering.
- Invalid UTF-8, XML entity declarations, corrupt/oversized Office archives,
  encrypted OOXML containers, encrypted/oversized PDFs, missing OCR, incomplete
  OCR, timeouts, unsupported formats, and missing source objects have distinct
  bounded failure codes.
- Image projection admits at most eight images, 20 MiB per source, 40 million
  source pixels, 8 MiB per derivative, 12 MiB across all delivered derivatives,
  and a 2,048-pixel native long edge. Cloudflare Images scale-down is bounded to
  that edge. HEIF is accepted only through that isolated service; TIFF
  dimensions are checked before pixels are decoded in the Worker.

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
  unsupported inputs, MIME precedence, fenced lease
  recovery, atomic selection, and ready-version reuse against `unpdf` 1.8.0.
- `apps/api/test/workstream-attachment-tools.test.ts` covers more-than-fifty
  pagination, natural-language filtering, exact two-sided read arithmetic,
  tampering/version invalidation, bounded search, ordered image batches,
  normalization failure, wrong-kind recovery, focused summaries, receipt
  reauthorization and visual rehydration, complete-range search, and
  workspace/private-note equivalence.
- `apps/api/test/attachment-tool-receipts.test.ts` proves dependency registration
  is conditional on the current hash and every replay rechecks visibility,
  version identity, and durable output cleanup.
- `apps/api/test/attachment-summary-service.test.ts` covers single-call complete
  and sampled-partial summaries, prompt trust placement, source-ID citation
  validation, output budgets, and provider failure. The harness suite proves
  ephemeral image parts reach only the next model request and never its durable
  completion event. `apps/api/test/workstream-read-state.test.ts` proves the
  sidebar uses the same visibility boundary.
- `apps/api/test/resource-upload.test.ts`,
  `apps/api/test/attachment-derivative-state.test.ts`, and
  `apps/api/test/resource-object-cleanup.test.ts` cover lifecycle schema,
  exact-byte hashing, legacy interpretation, derivative-change and deletion
  receipt invalidation, cleanup retry, and convergence.
- `apps/desktop/src/renderer/components/attachments.test.tsx` covers lazy
  message-feed opening plus image, Markdown, literal text, and converted-document
  presentation.
- `apps/desktop/src/renderer/components/inspector-rail.test.tsx` covers the
  rail's half of the processing contract: a `resource_processing` rejection is
  re-read only once the delay the response carried has elapsed, an answer that
  never stops saying `processing` is given up on once the budget would be
  overspent and not re-read afterwards, a processing answer naming no delay or a
  zero delay stays terminal, a rejection carrying any other code stays terminal
  *even when it names a `retryAfterMs`*, and a pending wait is dropped when the
  panel unmounts or its resource is revised. The delay is pinned to the exact
  millisecond the response named, under fake timers, so a rail waiting on any
  other cadence fails; and the budget is asserted against the two contract
  constants rather than a literal, so it fails the day either moves without the
  client following.
- `apps/api/test-workers/participant-notification.test.ts` proves a real object
  snapshot hydrates message-local attachment descriptors from the durable part
  relationship; `apps/desktop/src/renderer/lib/transcript.test.ts` proves those
  descriptors survive canonical flattening and become attachment tiles.

Run focused suites from their package directories through `pnpm --filter`, then
run the repository-wide lint, typecheck, and test gates before committing. Cursor
tests use an explicit clock value; do not replace it with sleeps or retries.

## Data model

WorkspaceDO `resources` owns original and current model refs plus original SHA-256,
derivative status, extractor version, readable-character count, extraction time,
bounded error code, fenced claim ID/time, and the current semantic version.
WorkspaceDO `resource_versions` owns numbered snapshots and every historical
original/model R2 ref. `GET /resources/:id/versions` lists them; the version and
its original or model content remain addressable through the corresponding
version endpoints after current content advances.
WorkspaceDO `resource_object_deletion_outbox` owns failed, superseded, and deleted regional
objects until bounded cleanup succeeds.
SubstreamAgent `attachment_tool_receipts` maps completed read, search, view, and summary
receipts to the exact derivative hashes they used. A replacement or deletion
invalidates the complete invocation and queues its JSON replay object. Receipt
registration itself is conditional on those hashes still being current, and
replay additionally rechecks current principal visibility; the map stores no
excerpts, prompts, image parts, or data URIs.
SubstreamAgent part attachments and work-stream resource links remain
relationship and visibility authorities; WorkspaceDO note scope and resource
metadata are rechecked separately. [`data-model.md`](data-model.md) and migrations are
authoritative.

## Regional impact

Contracts, lifecycle, and conversion execute identically in both regions. Cursor
signing happens inside the Worker that handles the owning regional run. Existing
originals and model derivatives remain in that region's R2 bucket;
WorkspaceDO owns lifecycle/outbox rows and SubstreamAgent owns work-stream
relationships. Scheduled cleanup
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
terms rather than duplicating attachment text. Future changes must preserve those
cheap discovery and continuation paths.

## Changelog

### 2026-08-28 — A preview still being prepared is a wait, not a dead panel

**What changed:** The desktop inspector rail's resource preview keeps the typed
`ApiError` its loader rejects with instead of collapsing every rejection into one
terminal state. A 409 `resource_processing` is re-read after the response's own
`retryAfterMs`, on the effect's existing `AbortController`, so an unmount or a
move to another resource — or another revision of the same one — cancels the
pending wait. Every other rejection, 404 and 422 and a network failure alike,
still ends on "This preview is not available." The read gives up once a
wall-clock budget would be overspent, and `ATTACHMENT_PROCESSING_LEASE_MS` and
`ATTACHMENT_CONVERTER_TIMEOUT_MS` moved out of
`attachment-derivative-service.ts` into `@rally/contracts` so that budget is the
server's own arithmetic rather than a copy of its numbers.

**Why:** Because the route materializes a PDF's or an Office file's text on
demand, `processing` is the ordinary first answer for a freshly attached
document, not an edge case. The rail mapped it to permanent unavailability and
never read again, and nothing reset that state, so it lasted the life of the
mount: the reader had to close and reopen the rail to discover the preview had
been there all along. A citation chip now opens this panel, which is how a
citation naming a document attached moments earlier came to land on a dead end —
the exact failure the preview was added to remove.

**Considered and rejected:** A client-side backoff schedule, and a maximum
attempt count. The delay is the server's to name — it is the only party that
knows whether it is waiting on a compare-and-set it just lost or on somebody
else's OCR — and an attempt count bounds nothing a reader feels, because the
route's two cadences differ fourfold. Also rejected: making the rail's `.catch`
retry on any rejection, which would turn a settled 404 into a request loop.

**On the ceiling, which two implementations disagreed about.** An earlier reading
had `processing` respawning forever, on the belief that a conversion which cannot
finish inside its request aborts and releases its claim. It does not: `withTimeout`
rejects with `conversion_timeout` after `ATTACHMENT_CONVERTER_TIMEOUT_MS` and that
is written as a terminal state and cached, so the next read is refused rather than
asked to wait. `conversion_aborted` — the one path that does release the claim and
answer `processing` again — fires only when the requesting client's own signal
aborts, which means nobody is waiting on it. So every *named* path is
self-terminating, and the budget is not what makes the loop end in any case anyone
has described. What it covers is the unnamed one: a conversion killed without
recording anything leaves the row claimed with nobody converting, and a panel left
open would re-ask until the reader closed the rail. That is why the number is the
largest one that still lets a converging wait finish, rather than the smallest one
that would end a doomed loop quickly.

**Consequences:** `retryAfterMs` is part of the preview endpoint's contract with
a client now, not diagnostic detail, and a `resource_processing` that arrives
without one — or with a zero, which is a request rate rather than a delay — is
treated as terminal rather than retried on an interval the client invented. A
second preview surface — the message-feed lightbox is the one that exists —
should read the same field rather than grow its own delay. Widening the retry to
another response code turns this into a general retry layer over answers that
are already final, which is what the narrow check in `processingRetryDelayMs`
exists to prevent. The rail's own half of this — how the wait is rendered and
where the loop lives — is in
[`markdown-rendering.md`](markdown-rendering.md).

### 2026-08-27 — Message attachments use the canonical transcript relationship

**What changed:** Participant transcript hydration now reads
`workstream_message_attachments`, whose parent is the canonical message record;
the retired `part_attachments` table is no longer a runtime or payload owner.

**Why:** After historical ownership transfer, retaining a second attachment
relationship would leave two plausible answers for which resource belongs to a
message.

**Considered and rejected:** Keeping the old relationship as a fallback. That
would hide incomplete migration and permit the copies to diverge.

**Consequences:** Schema retirement fails closed unless the two relationships
match exactly before deletion. Attachment hydration and optimistic replacement
continue to use the same stable message and resource identities.

### 2026-08-27 — A published document keeps one identity across its revisions

**What changed:** A Terminal publication's `provider_resource_id` is the work
stream plus the normalized published path rather than the publishing call's
receipt. Republishing the path updates that resource in place; the receipt
identity is still consulted when the path lookup misses.

**Why:** Standing policy now steers document-shaped requests through the publish
path, so revising a draft is the ordinary case. Under the receipt-derived
identity each revision was a new resource, and a rail showing four entries for
one document is not a document.

**Considered and rejected:** Reconciling siblings after the fact by source path,
which is the same key applied later and with a window in which participants see
duplicates.

**Consequences:** The in-place update is an ordinary semantic write, so the
version triggers capture the superseded original and derivative and the reaper
keeps both — history beneath a republished document comes from the existing
versioning layer with nothing added here. Resources published before the change
keep their receipt-derived identities and are never rewritten in place.

### 2026-08-27 — Resource versions retain prior originals and model derivatives

**What changed:** WorkspaceDO snapshots every semantic resource state, exposes
the complete ordered history and both content representations, and protects all
historical refs from the R2 reaper. Work-stream resource discovery now reports a
derived `source` or `artifact` direction.

**Why:** Terminal publication, provider refresh, notes, and other resource
writers need monotonic history rather than an overwritten pointer, while
direction belongs to the relationship that introduced the resource.

**Considered and rejected:** Versioning derivative claim transitions would make
processing noise look like content history. Keeping fixed note object keys would
silently overwrite bytes still named by an older version.

**Consequences:** Semantic writes increment `current_version`; derivative
materialization enriches that version. Note R2 keys include their content hash,
and cleanup must authorize deletion against both current and historical refs.

### 2026-08-26 — Ordered transcript snapshots retain message attachments

**What changed:** A participant text block now carries the message-local
attachment descriptors hydrated in one read from `part_attachments` and the
work stream's frozen resource links. The desktop maps those descriptors back to
the existing attachment-tile shape when it flattens ordered turns.

**Why:** The ordered-transcript migration preserved the original R2 object,
regional resource, object-local link, and part attachment, but returned only the
part's text. The optimistic message therefore displayed an image until the
canonical snapshot replaced it, at which point the attachment appeared lost
despite a successful upload and message commit.

**Considered and rejected:** Recovering attachments from the resource rail or
retaining the optimistic row indefinitely. The rail cannot recover which message
owned a resource or its position, and an optimistic row is not durable reload
state. The canonical part relationship is already the correct authority.

**Consequences:** Participant transcript hydration must keep attachment identity,
order, filename, MIME type, byte count, content availability, and attached time
aligned with the message projection. The original resource remains the preview
and retention authority; the transcript carries no bytes and creates no second
object lifecycle.

### 2026-08-22 — Tool receipts leave the compatibility layer

**What changed:** Every read and write of a durable tool receipt now goes through
`WorkstreamToolReceiptStorage` and its typed port, not D1-shaped SQL rewritten
onto `_runtime_tool_invocations`. Object schema migration 17 drops that view,
`_runtime_tool_checkpoints`, and their four triggers, and adopts two things the
compatibility schema owned that were never compatibility objects: the
`attachment_tool_receipts` table and the `tool_effects_run_call_uq` index.

**Why:** the layer existed so one body of code could run against D1 and the
object during the cutover, and every region past migration 0090 is permanently
past that point. Concretely it cost three round trips per receipt operation —
fence, batch, reconcile — with the run's lease restated in SQL each time because
it could not be trusted in between. Each operation is now one `transactionSync`
on the owning object.

**Considered and rejected:** converting the two telemetry statements and the
stale-run sweep into port operations as well. The telemetry statements are
run-shaped rather than receipt-shaped and their primary table is `harness_runs`,
so they are retargeted at `tool_effects` in place and the harness-runs slice
converts them whole. The sweep did become an operation, but not a variant of an
existing one: every other method is fenced on a live lease, and an expired lease
is the sweep's entire premise.

**Consequences:** the compat vocabulary does not disappear, it relocates.
`ToolInvocationSchema` still publishes `pending`/`started` and ISO-8601, so
`loadToolInvocation` translates at the wire boundary. Two behaviors that lived
inside compatibility objects are now explicit: migration 14's projection of a
settled receipt into its tool part, which is the only thing stopping a reaped
run's card spinning forever, and the replay dedup the unique index carries. And
a statement moved off a view reports `rowsWritten` rather than a trigger's
counter, which counts index writes — an `=== 1` check that survives such a move
will be wrong.


### 2026-08-20 — Attachment failures cannot become model-authored facts

**What changed:** CSV/TSV extraction now reaches the UTF-8 converter under
extractor v2, terminal v2 derivative results are reused, each conversion phase
emits content-free correlated timing, and the host replaces an answer when its
attachment content access remained unresolved. Mixed image-view results remain
unverified per skipped resource, while cursor failures carry their resolved
resource identity so a later successful restart can clear them.

**Why:** End-to-end QA found a CSV labeled as a spreadsheet taking an early
unsupported branch. The failed tool result then remained advisory, allowing a
model to answer with plausible facts it had never read; retries also exposed no
phase boundary for distinguishing R2, claim, conversion, and publication delay.

**Considered and rejected:** Prompt-only grounding, retrying every terminal
conversion forever, and logging extracted text for diagnosis. None is a
correctness boundary, and the last would move workspace content into account
logs.

**Consequences:** New content-bearing attachment tools must participate in the
grounding guard, and a completed call counts only the content its output proves
was delivered. Changing converter coverage requires a new extractor version,
and new materialization stages must retain content-free run/tool/resource
correlation.

### 2026-08-18 — Resource authority moves into WorkspaceDO

**What changed:** WorkspaceDO now owns resource/note metadata, current original
and derivative refs, watches, automation relationships, and R2 deletion
outboxes. SubstreamAgent owns the work-stream link, part attachment, inventory
revision, tool receipt, and compaction fence. Terminal and attachment services
perform separate reads across that boundary.

**Why:** Resource bytes and metadata are workspace-reusable, while visibility in
one conversation is a child relationship. D1 and a cross-table join represented
neither authority correctly.

**Considered and rejected:** Copying resource metadata into each child, leaving
a D1 projection, or joining WorkspaceDO and SubstreamAgent through the SQL
compatibility port. Those approaches create stale copies or imply atomicity the
platform cannot provide.

**Consequences:** R2 remains the byte store only; every authoritative pointer and
cleanup intent is WorkspaceDO-local. Receipt replay first proves the child link
and then rechecks the current workspace resource/note row and hashes.

### 2026-08-13 — Terminal imports and publications reuse resource authority

**What changed:** A Terminal sandbox can import currently visible originals and
publish generated files, command logs, and final diffs through the regional R2,
resource attachment, inventory revision, and cleanup-outbox lifecycle.

**Why:** Copying attachments into code and returning generated graphs/reports is
the useful bridge between a transient sandbox and a durable work stream. Direct
Daytona access to R2 or a second artifact store would bypass current-principal
visibility and split deletion/replay ownership.

**Considered and rejected:** Signed R2 URLs in the sandbox, embedding file bytes
in model tool results, and a Terminal-specific artifact table. Each either
exports storage authority, spends unbounded context, or duplicates the resource
lifecycle merged in #144.

**Consequences:** Import always reauthorizes and verifies the original hash;
publication identity comes from the durable invocation receipt; and new
Terminal output formats must pass the shared attachment classifier and cleanup
contract.

Shipped in the pull request for this change. Design:
[`docs/PRDs/2026-08-12_daytona-terminal-git-github/prd.md`](PRDs/2026-08-12_daytona-terminal-git-github/prd.md).

### 2026-08-12 — Message previews reuse the authorized derivative boundary

**What changed:** A resource preview endpoint now returns exact originals for
images, Markdown, and plain text, and lazily materializes or reuses the current
semantic derivative for PDF and Office attachments. It applies the existing
resource visibility query before either R2 read. The desktop message feed opens
all available attachments in a window-sized lightbox: intrinsic-size or
viewport-scaled images, shared-renderer Markdown, and literal monospace text.

**Why:** Sent attachments were image-only thumbnails: non-images were disabled,
even though the attachment system already held complete bounded derivatives for
the model. A separate client converter would duplicate parsing, drift from the
model-visible document, and move untrusted Office/PDF processing into Electron.

**Considered and rejected:** Downloading every original into the renderer,
building a second display derivative, and eagerly fetching every transcript
attachment. They respectively expose formats the renderer cannot safely render,
split one document into two interpretations, or turn transcript loading into an
unbounded content fetch.

**Consequences:** Clicking is the hydration boundary for non-image previews;
unchanged derivatives are reused by source hash and extractor version. New
previewable document kinds must extend the shared classifier/converter rather
than add a desktop-only parser. Missing, unsupported, processing, or failed
derivatives remain explicit preview errors. Closing a preview while it owns a
conversion releases the fenced claim back to pending rather than persisting
ordinary viewer cancellation as a shared derivative failure.

### 2026-08-12 — Attachment hydration drops speculative indexes and fan-out summaries

**What changed:** Search now derives UTF-16-safe chunks directly from the bounded
derivative and centers results on actual matches. The persisted index object and
model-object catalog are removed. Summaries use one inference over deterministic
server-owned source ranges, automation drafts expose only content tools for their
already-visible ten-item manifest, and resource revisions ignore processing-only
updates. Compaction performs one grouped inventory aggregation.

**Why:** An adversarial complexity review found that the stored index was never
used to select candidates, the catalog duplicated current pointers while retaining
superseded rows, summary fan-out could not reliably fit the tool deadline, and
processing state could invalidate a model's unrelated list cursor.

**Considered and rejected:** Keeping dormant index hints for future performance,
parallelizing nine summary calls, and retaining pagination solely for symmetry
with work streams. Each preserves lifecycle or model-facing complexity without a
current product need.

**Consequences:** A text derivative has one regional model object. Search spends
CPU proportional to the bounded derivative, summary coverage above 80,000
characters is explicitly partial, and future persisted indexing requires measured
need plus a candidate lookup that avoids the full scan.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Review closes replay, memory, and inventory race boundaries

**What changed:** Historical attachment results now reauthorize before transcript
projection; tenant-owned lifecycle tables carry workspace scope; MIME selection
is verified from bytes; source, derivative, image, and transcript replay budgets
are enforced before dangerous allocations. Resource tools use bounded point,
keyset-page, and grouped queries fenced by a monotonic revision. Production
scanned-PDF reads invoke the regional OCR binding, and compaction persistence is
conditionally fenced against the same revision.

**Why:** The implementation review found that a detached private result could
still enter a later model transcript, nominally paginated discovery first loaded
the entire inventory, synchronous converters and image decoders could cross
Worker memory limits before checking them, and a visibility change could race
between summary generation and checkpoint storage.

**Considered and rejected:** Redacting replayed text, computing cursors from a
full in-memory inventory, relying on best-effort R2 deletes, and treating a timer
around synchronous ZIP parsing as cancellation. None establishes the required
authorization, storage, or resource-consumption fence.

**Consequences:** Attachment history and receipts are caches over current
authority, never durable grants. A resource mutation invalidates outstanding
list/checkpoint revisions. Local Office work remains byte-bounded rather than
timer-preemptible, and readable derivatives deliberately stop at two million
UTF-16 characters to keep whole-derivative operations inside the Worker budget.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Attachment publication and replay are fenced end to end

**What changed:** Derivative claims now carry reclaimable lease times and unique
fencing IDs; every generated object key includes a unique generation, and D1
triggers catalog only a successful current-pointer update. Receipt registration
is conditional on current derivative hashes, and every replay rechecks current
visibility, hashes, and required image parts. Compaction summaries are scoped to
the principal and resource fingerprint captured before summarization.

**Why:** Review found four variants of the same stale-authority race: an
abandoned converter could block forever, an older converter could publish after
reclaim, cleanup could delete a reactivated key, and a completed receipt or raw
summary could outlive the authority that produced it.

**Considered and rejected:** Timestamp-only claims, deterministic generation
keys, replaying safe-read JSON without reauthorization, swallowing image
rehydration errors, and redacting summaries after the fact. None supplies a
fence across the relevant storage and authorization boundary.

**Consequences:** Safe attachment reads may re-execute when dependencies,
visibility, or visual bytes changed. Cleanup checks current pointers before R2
deletion. Future converters and receipt consumers must use the same claim,
publication-trigger, dependency, and replay-validation paths.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Encrypted OOXML fails as encryption, not corruption

**What changed:** A compound-file encrypted DOCX, XLSX, or PPTX container now
returns `office_encryption_unsupported` before ZIP extraction rather than the
generic `invalid_office_archive` failure.

**Why:** Encrypted OOXML uses the Compound File Binary envelope instead of an
ordinary ZIP. Treating that known signature as corruption gives the agent and
person the wrong recovery path and makes a valid but unreadable document look
damaged.

**Considered and rejected:** Passing the container to the ZIP reader and keeping
one error for every archive failure. It is safe but not diagnosable; the eight-
byte signature is sufficient to distinguish the unsupported-encryption class
without attempting to decrypt or exposing content.

**Consequences:** Rally still does not request or handle document passwords.
Adding decryption would require a separate consent and secret-handling contract;
it must not weaken archive expansion limits or log the password.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Message-attachment state is scoped and cursor-visible

**What changed:** The shared visibility query now counts a resource as a message
attachment only when its owning message belongs to the work stream being listed.
That bit also participates in the inventory fingerprint, so adding or removing a
message relationship invalidates an outstanding list cursor.

**Why:** A reusable resource can be attached to more than one work stream. The
unscoped existence check made one work stream report another's message
relationship, inflating the compaction subset total and changing later list pages
without invalidating their snapshot.

**Considered and rejected:** Treating `message_attachment` as a workspace-wide
property. It describes how a resource entered this work stream, not the resource
itself; sharing that property across work streams loses the relationship boundary.

**Consequences:** Sidebar rows, agent list items, and compaction totals now agree
on the current work stream's message subset. Future output fields derived from a
relationship must join through that work stream and participate in the cursor
fingerprint when they can change between pages.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Compaction inventory stays synchronized with visible resources

**What changed:** Live and replayed checkpoints now include fixed-order totals
for visible resources, message attachments, and non-empty natural attachment
kinds. The appendix is rebuilt from the same current-principal visibility loader
as the sidebar; the LLM summary is persisted only with its captured principal
and resource-visibility fingerprint.

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

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

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

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

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

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

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

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

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

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

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

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Complete derivatives replace trigger-specific conversion

**What changed:** Rally can now lazily create complete, reusable UTF-8,
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

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

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

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Attachment contracts are centralized before runtime cutover

**What changed:** Rally now has one natural-language attachment-kind registry,
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

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).
