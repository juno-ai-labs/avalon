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

Imported user attachments and assistant artifact files use the verified upload
pipeline and per-turn canonical attachment relationships. Import retry reconciliation
checks operation identity, bytes and the intended descriptor. Prepared conversation
receipts own reservations separately from live input mailboxes; definite failures
release holds, while canonical resource projection releases committed holds. Both
historical roles retain model manifests. Unavailable originals remain references,
and extracted text is labeled separately. See [session import](session-import.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/attachment-contracts.ts` | Single registry for attachment kinds, MIME/extension classification, strict tool argument schemas, exact success-output schemas, and the complete list-tool description. |
| `packages/contracts/src/index.ts` | Sanitizes bounded structured recovery data before Bind puts it in a model-visible failed tool result. |
| `apps/api/src/lib/attachment-cursor.ts` | Legacy signed-cursor decoding for pre-pagination receipts. New continuations use receipt-owned private state. |
| `apps/api/src/services/attachment-derivative-state.ts` | Interprets explicit lifecycle state and lazily maps pre-migration resources. |
| `apps/api/src/services/attachment-derivative-service.ts` | Converts authorized originals into complete, versioned text/Office/PDF derivatives, then atomically selects their regional objects. |
| `apps/api/src/lib/office-document-text.ts` | The DOCX/PPTX/XLSX parser the derivative service calls. |
| `apps/api/src/services/connector-document-reader.ts` | The derivative converter as the `ConnectorDocumentReader` the connector registry hands adapters, so a file found through Drive, Slack or another connector reads the same as an upload. See [`connectors.md`](connectors.md#reading-provider-files). |
| `apps/api/src/services/attachment-summary-service.ts` | Runs one isolated bounded reader over server-identified source ranges and reports honest complete or sampled coverage. |
| `apps/api/src/services/resource-object-cleanup.ts` | Retries regional object deletion without logging object keys or provider bodies. |
| `apps/api/src/durable-objects/workspace-resources-protocol.ts` | The typed request/result contracts for every resource-domain WorkspaceDO method, with refusals as outcomes rather than throws. |
| `apps/api/src/durable-objects/workspace-resources-storage.ts` | The resource domain's SQL against the object's own storage: upload commit, draft delete, connector resolve, hydration swaps, watches, version reads, cleanup claims, alias claims, inbound-email receipts, webhook resource upserts, and the maintenance bounds beside them. |
| `apps/api/src/services/resource-listing.ts` | The listing flag that separates a resource being *reachable* from its being *advertised*, the SQL predicate every enumerating statement applies, and the metadata helper its one producer writes. |
| `apps/api/src/services/workstream-resource-visibility.ts` | Defines the shared principal-visibility SQL and provides full sidebar, bounded point lookup, keyset page, and aggregate inventory queries, all over `ConversationResourceLinks`: a conversation's own links, and for a Breakout its Channel's Main links as well. |
| `apps/api/src/runtime/resource-port.ts` | `createConversationResourceLinks`, the one way a reader builds those links from a conversation's address. |
| `apps/api/src/services/workstream-resource-inventory.ts` | Renders the bounded current-principal inventory appended to live and replayed compaction checkpoints. |
| `apps/api/src/services/workstream-attachment-tools.ts` | Implements pageable discovery plus bounded, versioned text reads and local search. |
| `apps/api/src/services/automation-draft-attachment-tools.ts` | Reuses those operations behind a frozen compiler-request ID set and fresh draft ownership checks. |
| `apps/api/src/services/attachment-model-content.ts` | Renders manifest-only non-image projection and bounded same-ID current-turn image derivatives; `normalizeModelImageBytes` applies the same format, pixel, edge and byte limits to bytes that are not a resource, for Terminal's `view_image`. |
| `apps/api/src/services/attachment-tool-receipts.ts` | Atomically binds completed attachment results to current derivative hashes and revalidates replay dependencies. |
| `apps/api/src/services/integrations.ts` | Current message projection, work-stream resource-tool registration, and authorization-aware receipt replay. |
| `apps/api/src/durable-objects/substream-agent.ts` | Loads the resource set displayed in the right sidebar under note-visibility rules. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | Hydrates attachment descriptors from durable participant-turn parts into ordered transcript snapshots. |
| `apps/api/src/services/resource-service.ts` | Creates, hydrates, and deletes original resource objects, and serves authorized person-facing previews from the original image/text or the reusable document derivative. |
| `packages/contracts/src/workstream-transcript.ts` | Defines the attachment descriptor carried by a participant transcript text block. |
| `apps/desktop/src/renderer/lib/transcript.ts` | Maps canonical transcript descriptors back into the existing attachment-tile view model. |
| `packages/db/migrations/0073_attachment_derivative_lifecycle.sql` | Adds source identity, derivative lifecycle, tenant-scoped receipts/object cleanup, principal-scoped checkpoints, and the monotonic work-stream inventory revision. |
| `packages/agent-harness/src/tool-activity.ts` | Human-facing transcript prose for attachment tool wire names. |

### Member search projection

The member Files and Artifacts tabs search resource names, descriptions, and full available text derivatives through Turbopuffer. `resource-search-text.ts` defines the canonical field order for both indexing and match offsets. The source adapter returns this text to the shared Queue Worker pipeline; attachments have no separate chunking or embedding policy. Resource triggers enqueue reindexing when extraction or metadata changes; missing derivatives do not silently become truncated bodies. Search admits each resource batch through current resource and attachment authority before loading canonical excerpts. See [text search](text-search.md).

### Kind and schema selection

Rally classifies an attachment into exactly one of `image`, `audio`, `markdown`,
`pdf`, `document`, `spreadsheet`, `presentation`, `text`, or `other`. A verified MIME
type wins. A sanitized final filename extension participates only when MIME is
missing or a generic binary type. The model selects a natural-language kind in
a list request; it never supplies or guesses a MIME filter.

The same registry renders the complete model-facing explanation and the Zod
enum. Strict schemas cover list, read, search, view, and summarize arguments and
their exact success results. Every conversation, a work stream's and an
automation's alike, exposes all five operations; the compiler-only variant
that received four is gone with the compiler.
JSON Schema guides the provider, while the executor must parse the same strict
Zod schema because the harness does not enforce provider-facing JSON Schema.

### Continuations and recovery

The model sees [friendly page IDs](tool-pagination.md), not opaque cursors.
First/next tools store private continuation state with the producing receipt;
reads expose both directions, and search passages and summary citations expose
`readPageId`. Grounding tracks these IDs and still understands older receipts.

New attachment continuation state contains purpose, principal identity, owning
scope, and operation-specific state. It is not model input and needs neither
HMAC signing nor a second expiry. The receipt authority fences redemption;
the executor still checks resource visibility and derivative/inventory version.
Historical signed tokens are still decoded for stored receipts and retain their
original expiry behavior; new results never mint them.

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
prompt requires the active agent to
inspect a referenced attachment before answering and to use `charactersBefore`
and `charactersAfter` rather than treating one page as the whole resource.
The host also enforces that promise: if a read, search, view, or summary call
fails or a completed multi-image view skips a requested resource, and no later
successful content access resolves the same resource, the model receives one
corrective turn and cannot publish attachment facts. Cursor reads attach their
resolved resource identity to structured failures. If the cursor itself cannot
be verified, the guard uses the resource behind the one unambiguous active
server-issued read continuation; read results register both directions, while
search passages and summary citations register their read cursors in the same
provenance set. Completed receipt outputs rebuild that set after run resumption.
The guard does not decode or approximate-match the bad cursor. A successful
restart by resource ID can then clear the same guard entry instead of leaving a
tool-call-only false positive. More than one active resource
remains anonymous and fail-closed. A `resource_not_found` failure, or a view
item skipped for that reason, does not enter the guard when the run never
delivered that resource: it is not visible to this conversation, so nothing
attached here went unread. Once any of its content was delivered, the same
failure means a partial read and still enters the guard. While
the guard holds, a tool-bearing turn's prose is withheld. A run
that still ends replaces its final prose with a deterministic, content-free
`Attachment content unverified` boundary carrying only resource/tool/error
provenance, stated once. `attachment_grounding_guard_triggered` records the same bounded
identities without content.

The person-facing ordered transcript uses the same durable relationship. The
snapshot storage layer joins each participant text turn to its ordered
`participant_transcript_attachments`, emits metadata only, and the desktop
reconstructs attachment tiles from that descriptor. An optimistic tile may
disappear only when a canonical turn with the same message identity has arrived;
reconnect must not depend on the optimistic row or the resource rail to
reconstruct ownership.

An upload draft named by a human message is reserved in WorkspaceDO before
Product acknowledges that input as prepared or ready. The reservation RPC both
freezes the workspace/user-owned draft descriptors and writes
`pending_attachment_reservations`; explicit deletion and expiry cleanup exclude
those rows. Product records the cross-object recovery obligation before the RPC,
so an ambiguous response is replayed rather than guessed. A failed or genuinely
discarded preparation releases the reservation idempotently. A delivered input
deletes its local mailbox and recovery obligation in the same SubstreamAgent
transaction that queues canonical projection; a direct canonical message has no
pending recovery row. Neither path releases the workspace hold early: its
durable common effect names the exact
input/resource reservation, and WorkspaceDO releases only that hold in the same
transaction that marks the upload `attached`. The Queue consumer delivers this
publication after parent admission for every conversation, including private
children, whose common projection the Channel's parent keeps in
`parent_child_projections`. Publication
checks the exact workspace, parent, input and resource reservation and its
canonical link in the effect. Queue acknowledgement follows publication; a
replay after response loss leaves the already published resource unchanged.
Main directory projection remains compatible with older queued effects.
Historical resource versions and R2 references are retained throughout.

### Authorized work-stream discovery and text hydration

The right sidebar and attachment tools compose one visibility SQL boundary. It
binds the work stream to its workspace and applies current note scope, ownership,
and archive state for the execution principal. The sidebar loads its displayed
set, while model tools use bounded point, batch, aggregate, and keyset-page
queries. A workspace principal never inherits a user's private-note view.
Knowledge of a resource ID or cursor does not bypass this query.

**A conversation sees its own resources, and a Sidekick's also its Canvases'.**
`ConversationResourceLinks` combines the conversation's own links with those of
the conversations its Sidekick reaches. The object's `inheritanceContext`
identifies a Sidekick without trusting a model-supplied relationship; every
other conversation answers `none`. An ordinary background agent still sees only
resources explicitly passed to it. (A Breakout once inherited its Thread's
Main links; that arm went with Threads.)

**A Sidekick sees its home and explicitly attached conversations' resources.**
Its wizard, activations and background agents share this default. Each read
uses the execution user's current conversation admission through
`conversationToolScope`; private siblings and unrelated conversations are
excluded. A Breakout home or attachment includes its Thread's Main resources,
following the same rule as an ordinary Breakout. Activations and workers also
see the Sidekick wizard's own attachments. Resources are resolved live, not
copied to each run: later attachments appear, and detaching a conversation,
archiving it or losing access removes its inherited resources on subsequent
reads. Connector execution permissions remain separate.

**A Sidekick can also read a known resource ID without an attachment.** For an
explicit ID absent from its inherited links, the shared lookup asks
`AuthorizationService.readResources` whether the current execution user can read
that resource anywhere in the Organization. The wizard, activations and their
background agents use the same rule. Denied, missing and foreign resources stay
unreadable; an unavailable authority returns a retryable failure. Each lookup
checks current permissions and returns admitted resource and artifact metadata
with the decision, avoiding another metadata routing hop. Supplying an ID
never creates permission.

These direct reads create no attachment and do not expand `list_resources`,
inventory fingerprints, or the sidebar. Attachment forwarding remains the preferred handoff
even when a resource is already readable: it makes the intended resource
explicit and preserves shared context. Forwarding still requires an actual
attachment in the sender's own or inherited scope; direct read permission does
not widen that sharing gate. Terminal import and subsequent
revocation checks use the same resolution, and artifact data tools resolve a
supplied ID or alias before applying it. Ordinary Thread and Breakout agents
retain their existing attachment scope.

Own links take precedence over inherited links. Every model-facing reader
uses this composition: resource list/read/search/view/summary, Terminal import
and import revocation, image edits, artifact data, agent handoffs and receipt
replay. The sidebar continues to show its conversation's own attachments.

`list_resources` returns 25 rows by default and at most 50, optionally
filtered by one of the eight natural-language kinds. Continuations bind the
principal, work stream, filters, size, ordering key, and an inventory
fingerprint: `inventory:<revision>` for a Channel, `inventory:<own>/<channel>`
for a Breakout. A Sidekick appends a SHA-256 digest of its admitted source
conversation addresses and inventory fingerprints, keeping the cursor bounded
while a scope change still invalidates it even when the old and new sources
have equal revision numbers. Each revision is
monotonic. SubstreamAgent advances that revision for relationship, message-
attachment, classification/content identity, and note-visibility mutations, but
not hydration timestamps or derivative processing bookkeeping. A continuation
compares it before and after its bounded queries, so a relevant change
invalidates the scan rather than mixing old and new pages.

`read_resource` targets 12,000 and never exceeds 24,000 UTF-16
characters. Every result reports exact range, total, and character counts on
both sides, with independently usable previous and next cursors.
`search_resource` scans deterministic in-memory ranges from the
already bounded derivative, centers passages on actual phrase or term matches,
returns no more than five passages or 20,000 passage characters, and gives every
passage a read cursor against the same derivative version.

`view_resource` accepts up to eight unique image IDs, keeps valid
members in request order, and returns a JSON inclusion summary followed by
ephemeral image parts. The JSON is the only durable receipt. A replay
reauthorizes every dependency, verifies the exact derivative hashes, and
rebuilds those parts from the selected regional derivative. Missing visual bytes
invalidate the receipt and re-execute the safe read; they never degrade to stale
JSON without pixels. `summarize_resource` makes one isolated inference
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
entries remain discoverable through `list_resources`, followed by
`list_resources_next`, until `nextPageId` is null.

The stored checkpoint contains the raw LLM summary plus the execution-principal
key and authorized resource-inventory revision captured by an O(1) read before
summarization. Rally runs the grouped inventory query once when rendering the
appendix, verifies the revision there, and includes it in the conditional
SubstreamAgent SQL statement that persists the checkpoint; for a Breakout that
statement can fence only the Breakout's own revision (`ownInventoryRevision`),
and a Channel change after it lands is caught by the fingerprint comparison on
the next replay instead. Replay uses
the summary only for an exact scope match; attachment, detachment, deletion,
revocation, private-note visibility, or principal changes invalidate it and fall
back to durable transcript replay. Relevant resource IDs and consulted
derivative ranges still belong in the summary when unfinished work needs them;
the aggregate supplements that working set rather than replacing it.

### Automation-draft hydration

There is no separate hydration path for an automation any more. An automation
is drafted in a conversation of its own, a `SubstreamAgent` under its
Sidekick, and attachments there are ordinary conversation attachments
admitted, frozen, and read exactly as in a work stream. The compiler request
that once carried up to ten draft uploads under `automation_*` wire names is
gone with the compiler ([`automation-lifecycle.md`](automation-lifecycle.md)).

### Connector draft attachments

Gmail draft `attachmentResourceIds` resolves original PDFs through
`connector-resource-attachments.ts`, using the same current conversation links
and visibility predicate as resource tools. The execution host reads the
original R2 object and verifies its recorded hash and PDF signature before the
connector serializes MIME. Models see resource IDs and draft results, never
storage keys or binary content. Inaccessible or unavailable resources fail
before the draft write; the adapter cannot resolve arbitrary URLs.

### Terminal resource exchange

The Terminal plugin reuses the same authorized resource and lifecycle boundary
without projecting original bytes into the model. `import_resource`
resolves one resource through current work-stream/principal visibility, streams
its regional R2 original through the Worker, verifies its stored hash, and writes
it into the current authority-fenced sandbox generation. Daytona receives no R2
credential or signed URL. An omitted destination is deterministic beneath
`.rally/resources/`; an explicit destination is create-only unless the model
states `overwrite: true`.

`publish_resource` reads one stable nonempty regular file from the
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
than replacing the only readable state, attributed to the run that published it.

### Regional lifecycle

Uploads hash the exact bounded bytes before the resource row commits. Connector
hydration hashes a serialized result, writes a hash-versioned R2 object, then
atomically advances the resource and invalidates older model state. A legacy row
with a valid model-native image remains ready; another historical row with
original bytes becomes pending on first authorized use, while a missing original
is failed rather than an empty success.

Writers pre-register each generation-unique object in
`resource_object_deletion_outbox` before its R2 write, with cleanup fenced while
publication is staged. A successful pointer compare-and-swap removes that staging
row and enqueues the former pointer; a known failed publication releases its row
to cleanup. An ambiguous pointer response stays staged because preserving an
orphan is recoverable while deleting bytes a committed pointer may name is not.
Maintenance clears a staged row once it observes an active pointer and never
deletes an inactive staged object. Inactive staging is durable reconciliation
state, not an actionable cleanup row, so it does not arm a maintenance alarm
that cannot make progress; an explicit retry or operator decision must release
it. Publisher cleanup removes only a row that is still staged; it cannot erase
a deletion trigger's later handoff, and maintenance rechecks the active pointer
inside the statement that retires staging. A staging-insert response lost before
R2 is attempted is safe to release because no bytes were written. `resource_versions`
retains the original and derivative refs selected by
every semantic version; cleanup treats those historical refs as active. When a
resource or version is superseded or deleted before maintenance clears its
staging row, object-local triggers promote the row to cleanup ownership.
Deleting a resource—not merely detaching one relationship—therefore enqueues
every retained original and derivative. Scheduled cleanup reaps at most 100
eligible references per pass; a failed R2 deletion increments bounded retry
metadata and remains queued.

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
unsupported result is reused instead of rereading R2 on every tool retry.
Extractor v3 reads XLSX shared strings one per `<si>`, as described below.
DOCX becomes semantic Markdown with headings, lists,
tables, hyperlinks, headers, footers, footnotes, and endnotes. PPTX preserves
slide order, tables, and speaker-note text. XLSX identifies sheets, cell
references, display values, and formulas; a shared string is one `<si>`, with
its rich-text runs joined and its phonetic guide (`<rPh>`) left out. PDFs are page-delimited; a bounded OCR
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

Search derives UTF-16-safe ranges and section labels directly from the bounded
versioned derivative, so it needs no second R2 object or lifecycle. Tool reads
and searches check offsets against the same hash and extractor version. At the
two-million-character derivative ceiling, read, search, and
summarize may hold one complete derivative while returning bounded model
content; that proved Worker-memory ceiling replaces the former twenty-million-
character envelope.

## Invariants

- **Build every link reader with `createConversationResourceLinks`** (or
  `conversationResourceLinksFrom` over an injected factory), never a bare
  resource port, or it will disagree with the rest about what a Breakout can
  reach.

- **`ResourceService.list`'s `resourceTypes` distinguishes absent from empty.**
  Omitted means every type, which is what the product's own listing wants; `[]`
  means *nothing matches* and short-circuits before SQL. The caller that needs
  the empty case is the Sidekick drafting search, whose set of admissible types
  is itself empty in a workspace whose connectors declare no resource
  relationship ([`automation-lifecycle.md`](automation-lifecycle.md)) — handing
  it the workspace's resources would be offering precisely what it cannot use.
  Collapsing the two into "falsy means no filter" reads as a tidy-up and
  silently restores a defect.
- A verified MIME type outranks a filename extension, so renamed hostile bytes
  cannot choose their converter or model tool.
- All eight kinds and their descriptions come from one registry, so a smaller
  routed model never receives an enum whose meaning exists only in unrelated
  prose.
- Provider-facing schemas and executor parsing remain strict, so an invented
  MIME filter, old field, or mixed cursor/first-call shape fails instead of being
  silently ignored.
- A page ID is receipt-owned and bound to purpose, principal, and scope, but every
  dereference still reauthorizes current state; stealing or guessing a cursor
  cannot preserve revoked access.
- Structured failure data is allowlisted and bounded before it enters the model
  transcript, so a converter or provider cannot smuggle a response body,
  credential, or attachment instruction through an error.
- Runtime eager projection is removed only after replacement tools exist on both
  work-stream and automation-draft surfaces, so an intermediate deployment
  cannot strand a file behind a manifest the model cannot hydrate.
- Relationship detachment removes that discovery and access path but does not
  delete shared objects. A Sidekick's direct ID read may still use an independent
  grant held by its execution user. Resource deletion, expiry, or orphan
  ownership ends the object lifecycle.
- Listing is presentation, never authorization. An unlisted resource is absent
  from every surface that *advertises* it — the artifacts rail, the workspace
  resource list, `list_resources`, the compaction inventory, the search
  projection, and the `resource_attached` socket event — and unchanged
  everywhere something resolves it by id, so a reachable resource never becomes
  unreachable by being unlisted, and an unreachable one never becomes readable
  by being listed.
- **Advertising is about what the caller does with the answer, not the shape of
  the read.** A statement that enumerates applies
  `listedResourceVisibilitySql` and a point lookup does not, but
  `attachRuntimeResource` is a point lookup whose result is *broadcast*, so it
  applies the rule too — a by-id read feeding a socket event puts the row on
  every open client's rail exactly as an enumeration would. Any new caller that
  turns a resolved resource into something a member sees without asking for it
  decides the same way.
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
- `nextPageId: null` is the only evidence that a filtered listing is exhausted,
  while zero characters on both sides is the only whole-resource read.
- A version row's author identity matches its author kind, or the write that
  would have created it aborts. A wrong attribution is worse than none, because
  the rail renders it as fact.
- Provenance is staged on the resource row and consumed by the capture trigger,
  so the pointer swap and the account of who made it are one statement. A swap
  that stages nothing captures an unattributed version rather than inheriting
  the previous swap's author.
- A resource's alias is allocated once and never rewritten, is unique within a
  workspace, and is never an identifier anything resolves by internally. The
  UUID remains the primary key in every storage key, receipt, tool argument, and
  cross-object reference.
- A resource may have no alias. `slug IS NULL` is the durable record that one is
  owed, and every model-facing listing carries the field as nullable rather than
  waiting for one.
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

The image limits here are not attachments' alone. Terminal's `view_image`
([`terminal-workspaces.md`](terminal-workspaces.md#files-and-commands)) sends a
sandbox file through `normalizeModelImageBytes`, so a change to the pixel,
edge or byte limit changes what that tool accepts too.

## Failure modes and limits

- Legacy opaque cursors are at most 2,048 characters. Invalid scope, purpose, signature,
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
- Object cleanup reads at most 100 outbox rows per pass, and the alias backfill
  shares that same bound rather than declaring a second one. Failures keep their
  row and store only a bounded machine error code.
- Alias allocation retries a colliding candidate at most 1,024 times before
  giving up and leaving the row unaliased; a failure at creation costs the alias
  and a delay, never the resource. A backfill row that fails is skipped rather
  than stopping its batch.
- Version rows and the objects they retain grow without bound by design. No
  retention ceiling, version cap, or re-fetch cooldown ships here — those are
  numbers for the team to set, not for this layer to guess.
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
  dimensions are checked before pixels are decoded in the Worker. The final
  OpenRouter serializer admits base64 image parts only as PNG, JPEG, WebP, or
  GIF and rejects every other data-URL MIME before issuing the provider request.

## Testing

- `apps/api/test-workers/conversation-tools.test.ts` ("a Breakout's access to
  its Channel") proves on real objects that a Breakout's links include its
  Channel Main's, that a point lookup finds one, that the fingerprint moves when
  the Channel attaches, and that a Channel inherits nothing from a Breakout.
  `apps/api/test/resource-listing-visibility.test.ts` covers the Breakout's own
  link winning a duplicate and `ownInventoryRevision`.
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
  completion event or the persisted loop state. `apps/api/test/workstream-read-state.test.ts` proves the
sidebar uses the same visibility boundary.
- `apps/api/test/resource-upload.test.ts`,
  `apps/api/test/attachment-derivative-state.test.ts`, and
  `apps/api/test/resource-object-cleanup.test.ts` cover lifecycle schema,
  exact-byte hashing, legacy interpretation, derivative-change and deletion
  receipt invalidation, cleanup retry, and convergence.
- `apps/api/test-workers/resource-object-cleanup.test.ts` runs the publication
  fence against real WorkspaceDO SQLite and R2: cleanup during the upload-to-
  pointer gap preserves bytes, a committed pointer retires staging without an
  object delete, resource writes refresh the cleanup alarm, a known failure
  becomes reapable, and deleting a staged resource promotes its object to
  cleanup ownership.
- `apps/api/test-workers/workspace-draft-attachment-reservation.test.ts` uses a
  real WorkspaceDO to prove owner-fenced idempotent reservation, exact
  input/resource projection release, concurrent holds, explicit-deletion
  exclusion, failure release, and retained resource history.
- `apps/desktop/src/renderer/components/attachments.test.tsx` covers lazy
  message-feed opening plus image, Markdown, literal text, and converted-document
  presentation, and the paired superseded notice a prior version is previewed
  behind.
- `apps/api/test/resource-version-provenance.test.ts` covers the author and
  cause staged by every swap path and captured from it, the released staging,
  the unattributed projection of a pre-provenance row, and the fence that aborts
  a swap whose identity its kind cannot have.
  `apps/api/test-workers/resource-version-capture.test.ts` proves the same
  capture on real workerd, where the triggers actually run.
- `apps/api/test/resource-slug.test.ts` covers allocate-once, collision retry,
  the backfill's progress count and its per-row isolation, and the creation path
  that survives a failed allocation.
  `apps/api/test/workspace-schedule-targets.test.ts` proves the maintenance arm
  is scheduled for a table the alarm does not otherwise watch.
- `apps/api/test/activity-watch-routing.test.ts` proves a watch-routed
  notification names the stale resource in both the text a participant reads and
  the structured content a surface could read.
- `apps/desktop/src/renderer/components/inspector-rail.test.tsx` covers the
  version list's author labels, the current badge, which rows are openable, and
  the error the list renders rather than hides. It also covers the rail's half
  of the processing contract: a `resource_processing` rejection is re-read only
  once the delay the response carried has elapsed, an answer that never stops
  saying `processing` is given up on once the budget would be overspent and not
  re-read afterwards, a processing answer naming no delay or a zero delay stays
  terminal, a rejection carrying any other code stays terminal *even when it
  names a `retryAfterMs`*, and a pending wait is dropped when the panel unmounts
  or its resource is revised. The delay is pinned to the exact millisecond the
  response named, under fake timers, and the budget is asserted against the two
  contract constants rather than a literal;
  `apps/desktop/src/renderer/lib/use-citations.test.tsx` proves a citation
  resolves by alias as well as by id.
- `apps/api/test-workers/participant-notification.test.ts` (deleted in plan step C-2) proves a real object
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
version endpoints after current content advances. Each snapshot also carries
provenance — an author kind (`agent`, `member`, `connector`, `system`) with the
one identity that kind can have, and a cause (`created`, `published`,
`refetched`, `replaced`) — plus a `storage_kind` naming what its refs point at.
Provenance is staged on the resource row (`revision_author_*`, `revision_cause`)
and copied into the version by the capture trigger, so a swap and the
attribution of that swap are one statement. History captured before provenance
existed reports no author rather than an invented one, and an insert whose
identity does not match its kind is refused outright.

Each resource also carries a `slug`: a short alias minted by the work-stream
address generator over the resource's own coordinates, unique per workspace
under a partial index, with a regenerate-on-conflict allocator. It appears in
model-facing listings beside the UUID, which remains the primary key in every
internal reference, storage key, receipt, and tool argument. A resource that
predates the column, or whose creation path could not finish its allocation,
has `slug IS NULL` — the durable record that the `resource_slugs` maintenance
pass reads.

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

Contracts, lifecycle, and conversion execute identically in configured deployments. Cursor
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

The alias allocator derives its key the same way and for the same reason: a
fixed `resource-slug:` prefix over the shared session secret, hashed once per
call rather than per candidate. The separation is what keeps a resource's alias
independent of the work-stream email address the same generator would mint from
the same coordinates — neither reveals the other. It is not secrecy for the
alias itself, which is shown to participants and handed to the model by design;
an alias is a label, and nothing resolves a resource by one.

## Operations

An unexpected raw tool name in a transcript points first to
`packages/agent-harness/src/tool-activity.ts`. Repeated `invalid_cursor` failures
should be split into schema/length, signature, expiry, and authorization metrics
without logging the cursor itself. The scheduled Worker drains
`resource_object_deletion_outbox`; a growing oldest `created_at` or
`attempt_count` among eligible rows means R2 cleanup is unhealthy. An inactive
staged row is deliberately absent from the due queue because cleanup cannot
distinguish a crashed writer from an in-flight one without an invented lease;
inspect and release it only after proving no current or historical pointer can
commit. Inspect bounded events by resource ID and object kind, never object key.

## Performance and cost

Kind classification is constant-time over bounded metadata. Cursor verification
performs two HMAC operations and parses at most 2,048 characters. Conversion is
lazy and reused by exact original hash plus extractor version; only scanned PDFs
need the injected provider OCR path. Index storage grows with bounded chunks and
terms rather than duplicating attachment text. Future changes must preserve those
cheap discovery and continuation paths.

### Pointed resource content

[Artifact annotations](artifact-annotations.md) add a versioned quote to an
ordinary user turn. Exact source, converted text and rendered HTML receive
different editing guidance; truncated content requires `read_resource` first.
Crops and screenshots use ordinary owned draft admission and count toward the
existing ten-file cap. Target read/version authorization is independent from
attachment reservation, since a pin usually names an already-sent resource.

## Changelog

### 2026-11-07 — `publish_resource` lands in a Canvas, and no conversation inherits a Thread's links

**What changed:** A publish from a Canvas's Chat is one of the Canvas's
artifacts: the bridge tells the Canvas after each publish
(`canvasArtifactNoter`). A Sidekick run's publish goes to a Canvas
(`resolveTerminalPublicationHome`): the one its first publish made, or one it
names with the new optional `canvas` argument, which must be a Canvas the
Sidekick writes. The run's own conversation is still attached, so it reads
back what it published. `inheritanceContext` loses its `breakout` answer, and
`conversationResourceLinks` its Channel-Main port and the fingerprint arm that
folded a Thread's revision into a Breakout's.

**Why:** A Sidekick's output is a Canvas (the Canvases and Sidekicks PRD), and
a Canvas holds every artifact its conversation generates; the publish identity
`(conversation, path)` did not need to change for either. The inheritance arm
answered only for a `workstream` parent, which the conversation object refuses
to host after plan step C-2, so it was unreachable.

**Considered and rejected:** A separate Canvas publish tool: it would have been
the same tool with a second identity rule.

**Consequences:** One run makes at most one Canvas of its own. A publish
outside a Sidekick run that names a `canvas` is refused rather than ignored.

Design: `docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`.

### 2026-11-06 — Out-of-scope resources no longer trip the grounding guard

**What changed:** The attachment grounding guard ignores `resource_not_found`,
live and on receipt replay, for a resource the run never delivered, and a tool-bearing turn accepted while the guard
holds now carries no text instead of the boundary. The boundary appears once:
on the final tool-less turn, or as the participant notice when the run ends on a
withheld turn.

**Why:** A coordinator asked to compare a competitor with "our live artifact"
found the artifact's resource ID in another Thread through admin SQL and passed
it to `read_resource`, which correctly refused it as not in scope. The guard
latched on that refusal. Nothing later could clear it, so every turn's prose,
including the finished comparison built from a successful web fetch, became the
same boundary, published four times.

**Considered and rejected:** Clearing the guard on any later successful tool
call, which would let unrelated reads launder an attachment that truly failed.
Treating every refusal as out of scope, which would drop the guard for a
resource that is attached here but unreadable, the case it exists for. Ignoring
every `resource_not_found`, which would let an answer built on page one of a
document detached before page two go out with no notice.

**Consequences:** A new code that means "not visible to this conversation" must
be added to `isOutOfScopeAttachmentCode`; a code for an attached resource that
could not be read must not be. The exemption depends on the guard knowing which
resources it delivered, so a new content tool must report its resource IDs on
success as the existing ones do.

Shipped in [#1479](https://github.com/juno-ai-labs/avalon/pull/1479).

### 2026-10-22 — Resolve known Sidekick resources through the execution user's access

Sidekick point reads now use canonical resource authorization for IDs outside
their attachment inventory. Importing an existing site should not depend on
whether the coordinator remembered to forward its attachment. Parsing IDs out
of message text or silently attaching every referenced resource was rejected:
the tool already receives a typed ID, and read permission does not imply a
request to share or advertise it. Keep listing scoped to related conversations,
recheck direct access for imports and later sandbox use, and preserve canonical
denial, workspace boundaries and retryable authorization failures. Receipt
replay treats unavailable authorization as an invalid old read, while a new
explicit read keeps its retryable failure. Read access alone must not widen
attachment forwarding to another audience.

### 2026-10-22 — Resolve Sidekick resources from its live conversation scope

A site handed to a wizard by ID was attached only to the requesting Thread;
import failed and the coordinator commissioned a replacement site. Sidekick
resource readers now reuse the home and explicit-conversation scope already
used by conversation tools, admitted as the execution user on each read.
Copying all links at setup was rejected because later attachments and access
removal would diverge. Keep every model reader and inventory fingerprint on
this shared composition; knowing an ID or sharing a Channel adds no grant.

### 2026-10-19 — Gmail draft attachments use authorized original resources

**What changed:** A connector host reader resolves visible conversation resources
and passes verified original PDF bytes directly to Gmail draft MIME serialization.

**Why:** Candidate follow-up drafts need the attached dossier PDF, whereas model
text derivatives cannot reconstruct the original file.

**Considered and rejected:** Model-supplied base64 or arbitrary download URLs
would bypass the resource visibility boundary and unnecessarily expose binary
content to the model.

**Consequences:** Original bytes must exist and current run visibility must
permit access. File hashes and PDF signatures are checked before a draft writes.
The text hydration and resource-discovery contracts remain the source of IDs.

### 2026-10-19 — Project quoted annotations with their source fidelity

**What changed:** Models receive versioned quotes with explicit exact, converted and rendered source policy; image originals retain version identity and reusable model metadata.

**Why:** A selected HTML element or spreadsheet table is not an exact source replacement, and two revisions of one image must remain distinguishable.

**Considered and rejected:** Crops reuse ordinary draft admission rather than adding storage or permission mechanisms.

**Consequences:** Preserve source fidelity through live, replayed, inherited and overheard turns; resource sharing remains authoritative. See [artifact annotations](artifact-annotations.md).

PR #1322; design: `docs/PRDs/2026-10-19_artifact-annotations/prd.md`.


### 2026-10-10 — Connectors read files through this converter, and XLSX shared strings stay aligned

**What changed:** The DOCX, PPTX and XLSX parsing moved out of
`attachment-derivative-service.ts` into `apps/api/src/lib/office-document-text.ts`,
unchanged except for XLSX shared strings, which are now read one per `<si>`
instead of one per `<t>`. Format detection is the exported
`attachmentTextFormat`, which `convertAttachment` and the new
`connectorDocumentReader` both use, so connectors hand files they find to
`buildAttachmentDerivative` itself. `ATTACHMENT_TEXT_EXTRACTOR_VERSION` is
`attachment-text-v3`, so existing spreadsheet derivatives are rebuilt on their
next read.

**Why:** Drive and Slack needed to read the same files, and a second converter
would drift from this one. Reading one entry per `<t>` split any rich-text
string (mixed bold, a coloured word) into several entries, so every later
`t="s"` cell showed the text of a different cell. A cap table with one
formatted header showed the wrong holder against each ownership figure, with
nothing in the output to say so.

**Considered and rejected:** Moving the converter into `@rally/connectors`. That package does
not depend on `fflate`, and adding it rewrote about 11,000 lockfile lines,
because the catalog resolves `vitest` and `zod` as `latest`.

**Consequences:** Any change to conversion output needs a
new extractor version, or stale derivatives keep being served. Connector reads
are live and unversioned, so they pick up such a change at once. A format added
to `attachmentTextFormat` becomes readable by every connector too. The two-million-character
ceiling guards stored derivatives only: connector reads pass
`maxTextCharacters: null` and cut the text to their own budget.

Shipped in #1185.

### 2026-10-08 — A Breakout sees every resource its Channel attached

**What changed:** Visibility reads take `ConversationResourceLinks` instead of a
bare resource port. For a Breakout it merges the Channel Main's links into the
Breakout's own, and its fingerprint becomes `inventory:<own>/<channel>`. The
conversation object answers whether to inherit (`inheritsChannelLinks`), so the
readers that hold only "the conversation this run executes in" needed no new
argument.

**Why:** In production a Breakout opened on a summary that cited the Channel's
"Setup Plan" document as `resource://…`. Its run called `read_resource` on it,
the lookup read only the Breakout's link table, and the answer was
`resource_not_found`; the reply the person got was the "Attachment content
unverified" notice. The product rule is now that a Breakout has full access to
what its parent has attached.

**Considered and rejected:** Copying the summary's cited links into the Breakout
when it is created. It covers only what the summary happened to name, freezes at
creation, and leaves out what the Channel attaches later. Threading a substream
id through every reader: six of them hold only the port for the conversation
they run in, and the object already knows what it is.

**Consequences:** A Breakout member who cannot open the Channel still reaches
its resources through the agent. That was an explicit product decision, not an
oversight. Breakout compaction checkpoints written before this change carry
`inventory:<n>` and stop matching once, which replays the transcript and
compacts again. Workers and Sidekick run children still see only their own
links. The sidebar and the human-facing resource routes still answer per
conversation.

Shipped in #1179.

### 2026-09-26 — Index the stored object a resource or version points at

**What changed:** WorkspaceDO migration 78 adds partial indexes on
`content_ref` and `model_content_ref` of `resources` and `resource_versions`.
The maintenance schedule's `resource_objects` query and
`listWorkspaceReapableResourceObjects` check each column with its own lookup.

**Why:** For each row in `resource_object_deletion_outbox`, both queries asked
whether any resource or version still points at the object, and nothing
indexed those columns. At Juno Labs one staged row (waiting since 2026-09-19)
made every maintenance refresh read 460,000 rows. A Channel directory effect
with links runs that refresh, so it was most of the 700 ms of CPU each
`receiveChildEffects` call cost, about half of that object's time. Only a few
hundred rows store an object; connector resources store none, so the partial
indexes are small.

**Considered and rejected:** Keeping the `OR` form with the indexes; workerd's
planner then chose `resource_versions_workspace_idx` and still read every
version.

**What a future change has to respect:** keep each lookup on a single column
and do not add `workspace_id` to it; every row here is this workspace's, and
naming it lets the planner scan.

### 2026-09-16 — Publish scoped conversation uploads independently

Guest uploads reuse ordinary draft ownership, message reservations and file
storage. Existing-resource attachment requires source read access as well as
target conversation mutation authority; unpublished uploads enter through message
admission so attachment cannot leave a shared file deletable as an unsent draft.

Private-child common projections intentionally stay at the parent. Publishing
uploads only in the workspace directory path therefore left child files as
drafts indefinitely. The existing Queue consumer now publishes exact committed
reservations after parent admission, before acknowledgement. Forwarding private
child directory content was rejected because publication needs resource state,
not broader directory visibility.

### 2026-09-15 — Share prepared conversation file ownership

Imported user attachments and assistant artifact files use the verified upload
pipeline and per-turn canonical attachment relationships. Import retry reconciliation
checks operation identity, bytes and the intended descriptor. Prepared conversation
receipts own reservations separately from live input mailboxes; definite failures
release holds, while canonical resource projection releases committed holds. Both
historical roles retain model manifests. Unavailable originals remain references,
and extracted text is labeled separately. See [session import](session-import.md).

The separate durable preparation owner prevents file holds from depending on a
live-message mailbox that imported history never creates. Fake pending messages
and generation receipts were rejected because they conflate storage with execution.

### 2026-09-11 — An attachment is reachable and advertised, separately

**What changed:** `resource-listing.ts` adds one flag in a resource's
`metadata_json`. An unlisted resource keeps its work-stream link and every
by-id path — opened from a link, resolved by `loadVisibleWorkstreamResourcesByIds`,
imported by `terminal_import_resource`, authorized exactly as before — and
leaves every surface that advertises it: the artifacts rail, `GET /resources`,
`list_resources`, the inventory appendix compaction leaves behind, the
`resource_attached` socket event, and the search projection, where a null
category also withdraws a row indexed earlier. Terminal's
repository-replacement backup is the first and only producer, and WorkspaceDO
migration 52 marks the ones already written.

**Why:** Attaching a resource had been one fact, and for anything a person or a
model produced on purpose that was right — you want to find what you made. It is
wrong for a capture Rally takes *for* someone: repository checkout cannot replace
a workspace in place, so it archives the old one first, and that archive has to
stay reachable while being nobody's deliverable. Listed, a 21 MiB
`application/gzip` sat in the artifacts rail next to real output and consumed a
row of the model's inventory despite `model_content_status = 'unsupported'`
making it unreadable.

**Considered and rejected:** *Not attaching the backup at all* — `importResource`
resolves only attached resources, so that trades a rail entry for an
unrecoverable backup, which is the whole point of making it. *A new
`relationship_type`* — direction is a two-value enum feeding both rails, the
vocabulary is CHECK-constrained in a shipped migration whose hash a new value
would move, and "is this a deliverable" is not the same question as "which way
does it flow". *Filtering by title or provider in the renderer* — leaves the
model's inventory and search untouched and matches on a repository name. *A
distinct `provider`* — `provider` drives `requiresAttachment` in
`authorizationResourceFacts`, so a listing decision would have moved an
authorization one. *A column on `workstream_resource_links`* — the right shape if
this recurs, but a WorkstreamDO migration, a protocol change and a mirror write
for a single producer, against a JSON key that costs one `UPDATE` to withdraw.

**What a future change has to respect:** There are **three** places the rule
lands, and the first two are easy to mistake for one. `loadVisibleRows` here
and `WorkstreamObjectProductService.resources` both read attached links and join
`resources`; the first feeds the model's tools and the inventory, the second is
what `GET /workstreams/:id` and the socket's first frame assemble the member's
rails from, so fixing only one leaves the other advertising. Each takes an
optional id list and adds the clause on exactly the branch that has none, while
`RESOURCE_WITH_WATCH_STATE_SQL` omits it entirely as a point lookup. The third
is `attachRuntimeResource`, which is a point lookup whose answer is broadcast as
a `resource_attached` event — SQL shape says nothing there, so it tests the
metadata directly and withholds the event. Its `unlisted` outcome is
deliberately not `readback_failed`: the link committed, so asking for a
canonical resync would re-derive a rail that is already right.

Nothing may read listing as an access decision. And a stored `listing` change
does **not** invalidate search on its own — migration 43 narrowed the
`resources` update trigger to the columns search reads plus `metadata_json`'s
`description`, so any future write that flips `listing` on an indexed row
enqueues `resource_search_versions` itself, the way migration 52 does. Promote
the flag to a column when a second producer wants something a boolean cannot
say; one producer does not justify the schema.

Two things the rule deliberately does not reach, both worth knowing before
someone reports them as bugs:

- **Text already written stays written.** A compaction checkpoint's stored
  summary is the model's own prose, replayed verbatim, and it may name a
  resource that has since been unlisted. Only the inventory *appendix* beside it
  is re-rendered from a filtered read. Unlisting is not redaction, and no
  fingerprint can make it so: the visibility fence is
  `inventory:<resource_inventory_revision>`, which belongs to the WorkstreamDO,
  while a listing change is a WorkspaceDO write — and a migration in one object
  may not reach into another's tables. A checkpoint written under an older
  template version replays its frozen messages wholesale for the same reason.
  Both clear on the next compaction.
- **`workstream-attachment-tools.ts` has an unwired `loadVisibleResources`
  option.** It is a `VisibleWorkstreamResourceSet` supplied by a caller, and the
  page path prefers it over `loadVisibleWorkstreamResourcePage`. Nothing passes
  it today. Whoever wires it up owns applying the listing rule to whatever
  produces that set, because routing an enumeration through a caller-supplied
  read is exactly how the predicate gets bypassed without anyone editing SQL.

### 2026-09-11 — `list` can be confined to a set of resource types

**What changed:** `ResourceService.list` takes an optional `resourceTypes`, and
the invariant above records the one thing about it that is not obvious: absent
and `[]` mean opposite things.

**Why:** The Sidekick drafting search needs a page confined to the resource
types an evaluator rule can actually bind, and that set is legitimately empty in
some workspaces. `docs/automation-lifecycle.md`'s entry of the same date has the
failure that forced it. It is recorded here because this document owns the
listing path, and the empty-array branch is exactly the kind a later reader
removes as dead weight.

### 2026-09-05 — Member search projection

**What changed:** Search now reads canonical attachment originals or extracted text and rechecks access after loading bytes.

**Why:** Uploaded files and generated artifacts need content matches without opening a separate ingestion path.

**Considered and rejected:** Source-specific chunking was rejected; the shared Queue owns it.

**Consequences:** Binary originals stay binary and private child access must be checked at the owning child.

### 2026-09-03 — The compiler's attachment path is gone

**What changed:** The `automation_*` attachment tools, the frozen ten-resource
manifest, and the four-operation variant the preloaded automation architect
received are removed. An automation's conversation is a `SubstreamAgent` and
takes the work-stream attachment path unchanged.

**Why:** The automation was rebuilt as a conversation parent and the standalone
compiler deleted ([`automation-lifecycle.md`](automation-lifecycle.md)); the
compiler was this path's only caller.

**Consequences:** One attachment path, with the five operations, for every
conversation. A future headless caller that needs a frozen set would add its
own freeze at admission rather than reviving the compiler's.

### 2026-09-02 — A corrupted continuation can recover through its one unambiguous read

**What changed:** The attachment grounding guard remembers every server-issued
cursor accepted by the read tool and its resource: both cursors returned by a
read, plus search-passage and summary-citation cursors. Completed durable receipt
outputs rebuild the provenance after run resumption. When an `invalid_cursor`
call has no structured resource identity, the guard attributes it only when the
cursor provenance names exactly one resource. A later verified read of that
resource then clears the same safety entry.

**Why:** A model changed one character in an opaque cursor, so signature
verification correctly rejected it. The model recovered by restarting from the
resource ID, but the cursor-only failure remained keyed by tool call and replaced
every later assistant turn with the same unverified-attachment boundary.

**Considered and rejected:** Decoding identity from the invalid cursor, accepting
near-matching cursors, or clearing every anonymous cursor failure after any
successful attachment read. The first two would make unverified input influence
identity, while the last could let a read of one resource clear an unrelated
failure. More than one active continuation therefore remains unresolved by tool
call until a trusted result identifies it.

**What a future change has to respect:** Cursor verification remains strict; the
guard's continuation memory is recovery provenance, not authorization. Every
tool that issues a cursor accepted by `workstream_read_resource` must register
it live and through durable restoration. Never guess between multiple resource
identities or execute a corrupted cursor.

### 2026-08-30 — Generated audio is a playable, non-model-readable kind

**What changed:** The shared attachment registry now classifies verified audio
MIME types and common audio extensions as `audio`. MP3 signatures are verified
server-side. Current and historical audio resources flow directly from regional
R2 to native desktop players, while manifests and resource listings advertise
`contentMode: "unsupported"` to the agent.

**Why:** Treating generated speech as `other` hid a format the product can
present, while treating it as readable text invited the model to call document
tools that cannot transcribe it. A distinct natural kind states both truths.

**Considered and rejected:** Classifying audio as `text` or building implicit
transcription into preview. Both would couple a media-generation feature to a
second inference operation and change what a resource means without an explicit
transcription request.

**Consequences:** Attachment-kind consumers must handle `audio` explicitly.
Audio preview routes serve stored bytes directly, derivative builders do not
attempt text extraction, and adding agent-readable audio later requires a
separate transcription contract rather than changing this kind silently.

### 2026-08-30 — Resource versions move behind a header control

**What changed:** The inspector rail's resource detail no longer lists versions
under the document. **Versions** in the header opens them, grouped by sparse
relative dates. **Archive** replaces **Remove** and confirms before unlinking.

**Why:** Once the body became the document, an inline history under it was a
second pane competing with the file. A header control keeps the document the
default, and an unconfirmed unlink next to that document was the wrong weight.

**What a future change has to respect:** the version list is still newest-first
and still marks current by list position, not by the detail's cached number.
Sparse dates are calendar buckets, not `formatRelative`'s "3 hours ago".

### 2026-08-29 — Resource statements become typed WorkspaceDO methods

**What changed:** Every statement that named only resource-owned tables —
`resources`, `resource_versions`, `resource_watches`,
`pending_attachment_reservations`, `resource_object_deletion_outbox`,
`workstream_email_receipts` — moved out of the workspace runtime facade and
into typed methods on `WorkspaceDO`, declared in
`workspace-resources-protocol.ts` and implemented in
`workspace-resources-storage.ts`. The upload commit adopts its staged cleanup
row in the same transaction and answers a duplicate draft id as an outcome; the
connector resolve is one critical section instead of read, insert-or-ignore and
re-read; both hydration writes return a fence witness via `RETURNING`; the
reaper's reference check and staging retirement are one transaction; the alias
claim answers exactly why it refused; and the expired-draft reap is a single
statement. The draft TTL and the maintenance batch bound moved beside the
statements that enforce them. `putStagedResourceObject` and
`releaseStagedResourceObject` stay on the facade, deliberately — see below.

**Why:** The facade classifies SQL by the table names in it and sends anything
it does not recognise to the regional database, which is how a missing entry
turned into `no such table` in production (#401) — and, from the other
direction, how a service handed an unrouted environment sent object-owned
writes to a regional database that dropped those tables in migration `0090`. A
typed method cannot be routed to the wrong database, because its tables are
named inside the object that has them. Two latent read-then-write defects fell
out of making each decision one critical section: two concurrent uploads of
the same draft id both passed the separate existence check and the loser
surfaced as a bare primary-key 500 rather than the 409 the check existed to
produce, and the interleaving in which a draft deletion landed between the
upload's insert and its staged-row adoption can no longer occur at all.

**Considered and rejected:** Converting the staged put/release helpers too.
They are the shared staging primitive of the attachment-derivative,
model-content and Terminal publication writers, whose own `resources`
statements are later parts of this same facade-to-RPC stack; converting the
helpers alone would force an environment parameter through modules this change
does not own, so they follow when those domains convert. Also rejected:
splitting the statements that join `resources` to `connector_connections`,
`notes` or `workspace_connector_events` — a join across two of this stack's
domains stays on the facade until its other side has an owner to talk to.

**Consequences:** The listing and visibility joins (`ResourceService.list`,
`loadResource`, the work-stream object's attach/inventory joins) still ride
the facade, so the six table names stay on `WORKSPACE_LOCAL_TABLES`; do not
remove them when those joins convert — an accidental generic statement must
reach the object's refusal rather than D1's misleading `no such table`. The
inbound-email resource upsert writes only when something changed: the old
unconditional refresh re-assigned versioned columns — which fires the
semantic-version trigger even when their values are unchanged — so a first
ingestion recorded a phantom second version, and a lease-takeover replay,
whose values re-derive byte-identical from the same retrieved message,
recorded another. A fresh insert skips the refresh and an identical replay
writes nothing at all. Node
suites reach these tables through `createTestWorkspaceDO` — a real object over
its real schema — rather than hand-written fixture tables, and
`test-workers/workspace-resources-inventory.test.ts` proves the object's
decisions on workerd.

### 2026-08-28 — Publication staging closes the R2 cleanup race

**What changed:** Resource-object cleanup rows now distinguish an in-flight
publication from an object eligible for deletion. Draft uploads, Terminal
publications, connector refreshes, and derivative writers stage their generation
before the R2 put. A committed pointer clears the row; a known failed or losing write
releases it. The reaper clears staged rows only after finding an active current
or historical pointer and never deletes an inactive staged object. Cleanup
retirement and publisher cancellation preserve a deletion handoff that races
them, and ambiguous Terminal pointer writes remain staged for reconciliation.

**Why:** The WorkspaceDO cleanup alarm could run after R2 accepted a generated
file but before the following resource-pointer commit. It saw no pointer yet,
deleted the new object, and then the publisher committed metadata that claimed
content was available. That produced a working citation and version rail whose
preview and download both returned 404.

**Considered and rejected:** Delaying cleanup by an invented grace period, and
deleting new bytes whenever a WorkspaceDO response failed. A timer makes safety
depend on a number the system cannot derive; a failed response cannot prove the
transaction failed and can therefore delete a successfully committed document.

**Consequences:** A crash before pointer publication can leave a staged object
requiring explicit reconciliation, which is the recoverable failure. It does
not keep an unactionable maintenance alarm due. Writers must release staging
only when they know no pointer committed; supersession and deletion triggers
must promote any staging row they make unreachable. Future cleanup paths must
preserve both distinctions.

Shipped in [#395](https://github.com/juno-ai-labs/avalon/pull/395).

### 2026-08-28 — Message attachments ride the persistent-loop cutover

**What changed:** The persistent substream loop and canonical-transcript
cutover reshaped how a pending message's attachments survive the trip to a
canonical turn. The facets below are the decisions this change is made of —
they landed together in one revision and are recorded per facet because each
carries its own rejected alternative and its own invariant.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).

#### Pending message attachments are deletion-fenced until canonical delivery

**What changed:** WorkspaceDO reserves upload drafts for preparing and ready
human inputs through a typed RPC, and Product persists a replayable recovery
record before that RPC; explicit deletion and expiry cleanup skip held drafts.
Delivery then deletes the mailbox and recovery rows in the same local
transaction that writes the canonical turn and enqueues the common resource
effect, so the hold lives exactly as long as the pending envelope it protects.

**Why:** Input preparation crosses the WorkspaceDO boundary. Without a durable
hold, a person or the TTL alarm could delete the resource after validation but
before the pending message became canonical; and a hold that outlived canonical
projection would duplicate lifecycle state the durable outbox already owns.

**Considered and rejected:** Rechecking existence immediately before delivery,
which still leaves an async race; releasing every mailbox row called
`discarded`, which ends a directly-canonicalized preparation while its common
projection is still in flight; and keeping a delivered mailbox state until
WorkspaceDO acknowledges the effect, which adds a second local lifecycle
needing reconciliation without protecting any additional failure window.

**Consequences:** New draft-removal paths must honor the WorkspaceDO
reservation table. Failure rollback restores the mailbox and recovery row with
the pending input; preparation recovery releases only failure-owned holds.
After commit, WorkspaceDO's idempotent common effect is the only owner of
attachment/link projection and hold release.

#### Late grounding boundaries retain explicit host provenance

**What changed:** A grounding boundary accepted by Bind remains the exact
assistant turn Bind projected. A boundary discovered only after an earlier turn
was accepted is appended as a deterministic system notice; an unaccepted stream
preview is discarded rather than relabelled as host text. The notice, optional
accepted final turn, and recoverable host outcome commit atomically.

**Why:** Failing closed on assistant-content mismatch is what prevents a
host-generated boundary from masquerading as model output — but withholding
the boundary entirely would leave a participant seeing neither the raw preview
nor the reason it was withheld, and a crash before terminalization would have
no durable host outcome when there is no final assistant turn.

**Considered and rejected:** Reusing the current stream ID for the boundary and
loosening final-turn equality. Stream identity proves which provider turn a
delta belongs to; it does not prove the provider authored later host text.

**Consequences:** Attachment safety text is always visible with truthful
authorship. Recovery validates every identity named by the host-outcome
checkpoint, while model projection continues to exclude system notices.

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
that would end a doomed loop quickly. That value was put to the team with the
arithmetic and the alternatives — 60 seconds, the lease alone, and no ceiling —
and confirmed on 2026-08-28. It is a decision rather than only a derivation,
which is what
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md#when-to-ask-before-you-finish)
asks of a change that introduces the loop it bounds. What was priced is the
trip: an unchanging "Loading preview…" for up to five and a half minutes,
against never ending a wait that could still have produced the document.

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

### 2026-08-28 — Versions say who moved the pointers, and the rail shows them

**What changed:** Version rows gained provenance (author kind, its matching
identity, a cause) and a `storage_kind`, staged on the resource row so capture
carries them; resources gained a short `slug` alias for model-facing listings;
the right rail's resource detail lists a resource's versions and opens a prior
one read-only; re-fetch is offered only when the server reports that the
resource's deployed connector implements hydration; and a watch-routed change
notification names the resources it matched — in the text a participant reads
and in the message's structured content — so the re-fetch it invites can be
asked for.

**Why:** History that cannot say who wrote a state is half a record — "what did
we read last Tuesday" has an answer, "who changed it" did not. The alias is the
other half of the same argument from the model's side: a UUID costs about
thirteen tokens every time one is mentioned and is easy to copy wrong, which
the citations work does constantly. And history had been accumulating
invisibly since capture landed, which was harmless only for as long as nobody
needed to read it.

**Considered and rejected:** Passing provenance to capture rather than staging
it on the row — capture is a trigger, so the alternative is a second statement
that a crash can separate from the swap it describes. A `CHECK` on
`storage_kind` — SQLite cannot alter one on a STRICT table, so the constraint
would charge a table rebuild for the future editor snapshot the column exists
to admit. Replacing the primary key with the alias — a cross-cutting identity
migration for a benefit the alias delivers beside the UUID. Re-fetching
automatically when a watch fires — synchronization by another name, spending
provider quota on changes nobody asked about. Inferring manual re-fetch support
from watch state — watching for changes and retrieving content are independent
adapter capabilities.

**Consequences:** Every swap site sets provenance in the same statement as its
swap, and a mismatched identity aborts the swap rather than storing a wrong
attribution the rail would render as fact. A resource with one version shows no
history section. Agent-decided re-fetch still has no path: `hydrate` is
reachable only from its endpoint and a tool for it is a separate decision, so
the loop closes today through the participant.
### 2026-08-27 — OpenRouter image admission is enforced at the provider boundary

**What changed:** The final OpenRouter serializer now rejects image data URLs
unless they declare PNG, JPEG, WebP, or GIF. Persisted model derivatives are
also signature-checked against their recorded supported MIME before reuse.

**Why:** The normalization pipeline already emitted only OpenRouter-supported
formats, but its TypeScript union was not a runtime fence at the final provider
boundary. A malformed replay or future producer could otherwise bypass the
attachment converter with an unsupported image MIME.

**Considered and rejected:** Relying only on the provider to reject unsupported
content. That turns a deterministic local contract violation into a billable,
less-diagnosable inference failure after the complete prompt has left Rally.

**Consequences:** Private Rally attachments remain base64 data URLs produced by
the existing normalization path. Rally deliberately rejects public HTTP(S)
image URLs at this boundary because their response MIME cannot be established
from the provider request body; every image payload is locally allowlisted
before transmission.

### 2026-08-27 — Message attachments use the canonical transcript relationship

**What changed:** Participant transcript hydration now reads
`participant_transcript_attachments`, whose parent is the canonical turn;
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

### 2026-08-12 — Encrypted OOXML fails as encryption, and message-attachment state is scoped and cursor-visible

**What changed:** A compound-file encrypted DOCX, XLSX, or PPTX container now
returns `office_encryption_unsupported` before ZIP extraction rather than the
generic `invalid_office_archive` failure. Separately, the shared visibility
query now counts a resource as a message attachment only when its owning message
belongs to the work stream being listed. That bit also participates in the
inventory fingerprint, so adding or removing a message relationship invalidates
an outstanding list cursor.

**Why:** Encrypted OOXML uses the Compound File Binary envelope instead of an
ordinary ZIP. Treating that known signature as corruption gives the agent and
person the wrong recovery path and makes a valid but unreadable document look
damaged.

A reusable resource can be attached to more than one work stream. The unscoped
existence check made one work stream report another's message relationship,
inflating the compaction subset total and changing later list pages without
invalidating their snapshot.

**Considered and rejected:** Passing the encrypted container to the ZIP reader
and keeping one error for every archive failure. It is safe but not diagnosable;
the eight-byte signature is sufficient to distinguish the unsupported-encryption
class without attempting to decrypt or exposing content.

Treating `message_attachment` as a workspace-wide property. It describes how a
resource entered this work stream, not the resource itself; sharing that
property across work streams loses the relationship boundary.

**Consequences:** Rally still does not request or handle document passwords.
Adding decryption would require a separate consent and secret-handling contract;
it must not weaken archive expansion limits or log the password.

Sidebar rows, agent list items, and compaction totals now agree on the current
work stream's message subset. Future output fields derived from a relationship
must join through that work stream and participate in the cursor fingerprint
when they can change between pages.

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
