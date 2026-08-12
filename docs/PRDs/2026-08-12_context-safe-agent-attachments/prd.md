# Context-safe agent attachments

> Created 2026-08-12.
>
> An Avalon agent can reliably inspect text, Office, PDF, and image attachments
> without copying whole files into the conversation or losing access to an image
> after context compaction. Companion plan: [`plan.md`](./plan.md). Standing
> contract: [the Avalon implementation
> brief](../2026-08-05_avalon-implementation-brief/prd.md). Governing runtime
> documents: [`../../agent-harness.md`](../../agent-harness.md) and
> [`../../context-compaction.md`](../../context-compaction.md).

## Summary

Attachments become durable, addressable resources that the agent discovers in
the message that carried them and hydrates only when the task needs their
contents. Every attachment reaches the model first as a compact manifest entry
with a stable resource ID, filename, MIME type, size, readiness, and the action
the agent can take. Text and document bytes are not copied into the triggering
message. The agent reads or searches bounded portions of a reusable regional
model derivative instead.

Images have two simultaneous representations. A bounded visual derivative is
included in the current model turn so the agent can see it immediately, and the
same image appears in the manifest as a durable resource. The original and its
model derivative remain regional and can be loaded again by resource ID after a
retry, replay, or context compaction. Inline visual bytes are an optimization for
the current turn; the resource is the source of truth.

## Motivation

Avalon currently has two incompatible attachment contracts. The harness
documentation says attached resources are indexed and hydrated lazily, but a
triggering human message calls `buildAttachmentModelParts`, which eagerly places
up to 60,000 extracted characters into the model transcript. Anything after that
limit is replaced by an in-band truncation marker. The work-stream resource tool
is available, but a model that already sees a plausible beginning has no reliable
reason to call it or to know which missing portion matters.

Inference request `019ff769-f7a4-70c8-87a7-16722ff2ce43` demonstrates the
failure. A 106,460-byte Markdown transcript was projected as its first 60,000
characters. The model never called `workstream_read_resource`, inspected other
sources, and answered without seeing the transcript's second half. Increasing
the inline limit would move the cutoff while making every later turn more
expensive; it would not make attachment coverage correct.

The opposite failure appears after compaction. Image bytes must not be persisted
in a checkpoint, but an anonymous `[image]` marker or a filename does not give a
later turn enough information to load the image again. An image that was visible
before compaction therefore needs a durable attachment identity at the same time
it is admitted as visual content.

Prior art in Monad validates the direction: trigger messages carry lightweight
attachment metadata, images are downscaled into multimodal parts, attachment
bytes are re-fetched through authorized tools, and non-text formats have reusable
extraction paths. Its production history includes a fix for a trigger attachment
that was invisible to the agent (`637c67252`), range-based attachment reads
(`b8d4d3270`), and bounded multimodal images (`7bf400a99`). Avalon should adopt
the reference-first contract, but not Monad's 1 MiB default text result, 2 MiB
converter output, or base64 binary tool results: those bounds protect process
memory rather than model context.

## Goals

1. Every file attached to a message is discoverable by the agent through a
   stable resource ID, including when the message contains no text.
2. A request that depends on an attachment is answered only after the agent has
   inspected the relevant file, with explicit coverage when a read is partial.
3. Text, Markdown, JSON, DOCX, PPTX, XLSX, and PDF attachments remain readable
   beyond the first model-visible page without placing the whole file in the
   conversation.
4. Every image admitted as visual model content is simultaneously represented
   as a durable attachment that can be viewed again after retry, replay, or
   compaction.
5. Model-visible attachment content is bounded per turn and cannot consume an
   unbounded share of the selected model's context window.
6. The same derivative and hydration behavior serves work-stream runs and the
   automation architect, while each surface keeps its existing authorization
   scope.
7. Original files, derivatives, indexes, and retrieval receipts remain in the
   workspace's selected region and follow the original resource's lifecycle.
8. Failed, unsupported, incomplete, or still-processing attachments are stated
   explicitly; the agent never treats missing content as an empty file or a
   successful read.

## Non-goals

1. Editing an attached Word document, spreadsheet, presentation, or PDF is
   deferred. This PRD makes files readable by the agent; it does not create a
   document-authoring surface.
2. Audio and video transcription is deferred. The manifest identifies these
   files and reports them as unsupported until a media-processing PRD defines
   cost, duration, and consent behavior.
3. Workspace-wide attachment search is deferred. Search in this PRD is confined
   to one explicitly identified, already-authorized resource.
4. Persisting image, PDF, or other binary bytes in the model transcript or a
   compaction checkpoint is rejected. Durable resource references replace
   durable prompt bytes.
5. Raising the 60,000-character inline limit, copying Monad's megabyte-scale
   tool results, or sending arbitrary binary files as base64 JSON is rejected.
   Each preserves the current context failure in a larger form.
6. Changing Avalon's 80% compaction threshold or introducing general pruning for
   every connector tool is deferred. Attachment tools are bounded at their
   source; general tool-result pruning remains a harness-wide concern.
7. Re-extracting every historical resource before rollout is deferred. Existing
   resources are converted lazily on first authorized use, avoiding a regional
   backfill spike.
8. Making attachment IDs an authorization mechanism is rejected. An ID only
   names a resource; the current principal and owning message, work stream, or
   automation draft authorize every dereference.

## Product behavior

### Sending and displaying an attachment

The composer continues uploading a file as a draft resource before a message is
sent. Sending the message commits both `message_attachments` and
`workstream_resources` before an agent run may begin. The transcript renders the
original attachment for download or display exactly as it does today; model
conversion never replaces or mutates the original.

The model projection of the message contains a compact manifest entry for every
attachment. An entry includes `resourceId`, `fileName`, verified `mimeType`,
`sizeBytes`, `contentMode` (`read`, `search`, `view`, or `unsupported`),
`derivativeStatus`, and `inlined`. A historical message retains the same stable
identity in projected history rather than becoming a filename-only marker.

An attachment whose original bytes are unavailable remains in the manifest with
`derivativeStatus: "failed"` and a recoverable error code. The agent says it
could not inspect the file and does not infer its contents.

### Images

A supported image on the triggering message is normalized under the existing
source-byte, pixel-count, derivative-byte, image-count, and long-edge limits. The
model turn contains both the manifest entry and an `image_url` content part. The
manifest sets `contentMode: "view"` and `inlined: true`, making it explicit that
the visual is already present and preventing an unnecessary first tool call.

If normalization fails or the image exceeds an admission limit, the manifest
still exists with `inlined: false`. One bad image does not hide the message or
the other attachments. A later `workstream_view_resource` call either returns a
bounded model-supported derivative or a structured reason it cannot.

After compaction, the checkpoint contains no data URI. It retains the exact
resource IDs and conclusions for images that were examined or remain relevant.
The complete work-stream resource index remains pageable, so a later request can
rediscover an older image even when it was not relevant at the time of the
compaction. Viewing it again produces a fresh authorized model content part from
the persisted derivative.

### Text and document reads

Plain text and structured document attachments are not inlined in the trigger.
When the request names, points to, or consists only of attachments, the agent
must inspect the relevant resources before answering. It may:

- read the next bounded portion of a model derivative;
- search one derivative for bounded matching passages; or
- request a bounded whole-document synopsis when reading every portion in the
  main conversation would consume too much context.

`workstream_read_resource` returns model-ready text plus the derivative format,
version, range, total character count, `complete`, and an opaque `nextCursor`.
The cursor binds the resource ID and derivative hash, so continuing a read cannot
silently cross into a changed derivative. A partial result says
`complete: false` in structured metadata; completeness is never communicated
only by prose appended to the file.

`workstream_search_resource` accepts one resource ID and query. It returns a
small number of passages with section labels and stable range cursors that can be
passed to `workstream_read_resource` for surrounding context. It is lexical and
resource-local; it does not search other resources or workspace content.

For a whole-document summary that cannot fit safely in the main run, a bounded
document-reader inference runs with the derivative rather than the work-stream
conversation. It returns an outline, requested summary, citations to derivative
ranges, and a coverage statement. The work-stream agent sees only that bounded
result and may read cited ranges to verify material claims.

### Model derivatives

Avalon creates or refreshes one reusable model derivative per original content
hash and extractor version:

| Original | Model derivative |
| --- | --- |
| UTF-8 text, Markdown, source, CSV, JSON, XML, YAML | Validated UTF-8 text with original ordering |
| DOCX | Semantic Markdown preserving headings, lists, tables, links, headers, footnotes, and endnotes where present |
| PPTX | Slide-ordered Markdown with slide numbers, text hierarchy, tables, and speaker notes where present |
| XLSX | Sheet-ordered structured text with sheet names, cell values, and formulas or display values identified consistently |
| PDF with a text layer | Page-ordered text with page boundaries |
| Scanned or materially empty PDF | Page-ordered OCR text with extraction method recorded |
| Supported image | Bounded visual derivative; storyboard plus timing metadata for animated GIFs |

Extraction starts after upload and may complete lazily during the first read. A
ready derivative is reused across runs. A changed extractor version does not
invalidate the original; it creates a new derivative and atomically advances the
resource only after the new object and index are complete.

### Loading, error, and offline states

The transcript always shows the original attachment independently of derivative
state. While extraction is pending, the resource tools return a typed
`resource_processing` result with a retry interval rather than empty content. A
terminal conversion failure returns `resource_conversion_failed` with a safe
reason and leaves download/display intact. Unsupported formats return
`resource_format_unsupported` and name the supported action, if any.

Offline composer behavior does not change: unsent drafts and their bytes remain
local under the existing expiry and sign-out rules. No agent sees the attachment
until reconnect completes the regional upload and the message-resource
relationships commit. A disconnected client can continue displaying already
downloaded transcript state, but it does not claim that a new derivative was
created or read.

### Automation creation

The automation architect receives the same manifest instead of eager attachment
text. Its attachment tools resolve only the draft attachment IDs frozen into the
compile request and recheck workspace and draft ownership on every call.
Work-stream tools continue resolving only resources attached to that work
stream. The two surfaces share extraction and paging code but not an
authorization shortcut.

## Impact on the product contract

None — this refines behavior within the existing contract. Attachments remain
work-stream resources, and the agent continues using typed, authorized tools
without shell or arbitrary code execution. The change makes the existing
resource and audit guarantees true at the model boundary; it does not add a new
global surface or participation rule.

## Decision log

None yet.

## Key design decisions

1. **An attachment is a reference before it is content.** The trigger always
   carries a stable manifest and never relies on eager document text. A larger
   inline allowance was rejected because it preserves silent partial coverage
   and repeatedly spends context on irrelevant files.
2. **Every inline image also remains a durable attachment.** The manifest and
   visual part are produced together from one authorized resource. An anonymous
   image part was rejected because it cannot be rehydrated after compaction.
3. **Only model-ready derivatives are paged.** Byte ranges over DOCX, PDF, or
   arbitrary UTF-8 boundaries are not meaningful to a model. Original-byte
   reads and base64 tool results were rejected in favor of typed extraction.
4. **Tool results use a context budget, not a file-size budget.** A normal text
   page defaults to approximately 12,000 characters and cannot exceed 24,000;
   search returns at most five passages and no more than 20,000 characters total.
   The executor may lower these limits when the last provider-reported usage
   leaves less headroom. Megabyte-scale defaults were rejected.
5. **Whole-document understanding is isolated when necessary.** A focused
   document-reader inference protects the work-stream conversation and returns
   citations and coverage. Injecting every page and compacting the entire
   conversation afterwards was rejected because compaction is lossy and occurs
   only after a provider turn completes.
6. **Large content stays in resource storage, not tool receipts.** R2 holds the
   derivative and its index. A receipt durably records only the bounded result,
   resource/version identity, and requested range so retry remains deterministic
   without creating a second full-file copy.
7. **The extraction service is shared; authorization is not.** Work-stream and
   automation-draft wrappers call one conversion and paging implementation after
   applying their own scope checks. A globally readable attachment-by-ID tool
   was rejected.
8. **The manifest is structured model data.** File contents remain explicitly
   untrusted tool/resource data and cannot close a prose or XML delimiter to
   impersonate harness policy.

## Data model

The existing `resources`, `message_attachments`, and `workstream_resources`
relationships remain authoritative. The existing `model_content_ref`,
`model_mime_type`, `model_content_sha256`, and `model_metadata_json` columns
continue identifying the current derivative.

`resources` gains explicit derivative lifecycle and version fields rather than
encoding operational state only inside metadata JSON:

- `content_sha256` — immutable original-content identity used by cursors and
  invalidation;
- `model_content_status` — `pending`, `processing`, `ready`, `failed`, or
  `unsupported`;
- `model_content_extractor_version` — the converter contract that produced the
  current derivative;
- `model_content_character_count` — total readable characters where applicable;
- `model_content_extracted_at` — completion time; and
- `model_content_error_code` — a bounded machine-readable terminal reason, with
  no file content or provider body.

`model_metadata_json` remains type-specific: page count and OCR method, sheet or
slide names, image dimensions, GIF storyboard timing, and a bounded section
index. A regional chunk index keyed by resource ID, derivative hash, and ordinal
supports lexical search and stable character ranges. It is derived data and is
deleted or replaced with the derivative; it is not a new public resource.

Existing resources receive no eager backfill. Their status is treated as
`pending` until first authorized use creates the derivative or establishes that
the format is unsupported.

## Regional impact

Original uploads already reside in the workspace's regional R2 bucket and their
resource rows in regional D1. Model derivatives, chunk indexes, extraction state,
and attachment-tool receipts stay in those same regional bindings. Queues and
Workflows carry opaque resource IDs, never attachment bodies. No attachment data
is copied through the Global identity plane or a cross-region bridge.

Provider-assisted PDF OCR and document-reader inference follow Avalon's existing
OpenRouter processing posture: the request originates from the owning regional
Worker and inference metadata remains regional, but this PRD does not claim that
the model provider processes every byte exclusively in that region.

## Security and trust model

- Every manifest is built from server-loaded resource rows; a client cannot
  supply the model-facing resource ID, readiness, or verified MIME type.
- Every read, search, view, and synopsis rechecks the execution principal,
  workspace, owning work stream or automation draft, current visibility, and
  revocation state. Knowledge of a UUID grants nothing.
- File contents, extracted text, OCR, filenames, and document metadata are
  untrusted data. They remain in user/tool content and never become system or
  plugin instructions.
- Signature sniffing supplements declared MIME and extension. Archive expansion,
  source bytes, expanded bytes, XML entities, PDF pages, image pixels, image
  count, and converter time each have independent limits. A failed normalization
  never falls back to raw binary model input.
- Raw attachment bodies, extracted content, model data URIs, OCR provider bodies,
  and search passages are excluded from structured logs. Opt-in inference logging
  retains its existing explicit behavior and regional storage.
- Derivatives and chunk indexes share the original resource's retention and
  deletion path. A resource deletion that removes `content_ref` also removes all
  current and superseded model objects and derived indexes.
- Opaque cursors carry or authenticate resource ID, derivative hash, range, and
  version. They are parsed and authorized again; they are not bearer access
  tokens.

## Agent behavior

The trigger manifest tells the agent which files exist, which images it already
sees, and which typed action reads each one. Platform guidance adds two rules:

1. If the human request refers to an attachment, asks about “this file/image,”
   or contains no text besides attachments, inspect the relevant attachment
   before answering.
2. If a result says `complete: false`, do not describe it as the whole file.
   Continue, search, or request a synopsis according to the task.

The work-stream surface provides:

- `workstream_read` — a pageable resource index rather than a hard, unpageable
  fifty-resource ceiling;
- `workstream_read_resource` — bounded text/structured derivative pages;
- `workstream_search_resource` — bounded passages within one resource;
- `workstream_view_resource` — one or more bounded image content parts plus a
  structured inclusion summary; and
- `workstream_summarize_resource` — an isolated, bounded synopsis with citations
  and coverage for a document too large to stream through the main conversation.

The automation architect receives equivalently named draft-scoped operations.
Tool descriptions and recovery errors must be sufficient for the smallest routed
model to select the correct operation without memorizing MIME-specific plugin
conventions.

Compaction guidance explicitly preserves the exact resource ID, derivative
version, material ranges consulted, conclusions reached, and unresolved need for
every attachment still relevant to the request. It never asks the summarizer to
copy file contents or media parts. After compaction, a model rehydrates a visual
or passage by ID and reauthorization rather than relying on remembered pixels or
a stale excerpt.

## Rollout

This is a correctness and trust-boundary change, not a user-selectable feature.
It does not add a Flagship flag; Avalon's current Flagship contract covers model
routing and client-visible features rather than arbitrary server code paths.

The rollout is additive before it switches projection:

1. Deploy derivative lifecycle columns, deletion coverage, conversion services,
   and lazy compatibility for existing rows.
2. Deploy bounded read, search, view, synopsis, and pageable-index tools for work
   streams and automation drafts while the legacy projection still exists.
3. Add stable manifests to trigger and historical projections. Images begin
   carrying both manifest identity and visual parts.
4. Switch non-image trigger attachments from eager content to manifest-only and
   remove the 60,000-character attachment projection.
5. Update compaction guidance and replay tests, then remove legacy extraction
   paths that are no longer used.

Additive migrations remain safe if application code is rolled back. Before step
4, production inference logging for an internal test workspace verifies that
manifests and tool continuations reach every routed model. Rollback redeploys the
previous projection while leaving unused derivative columns and objects intact;
it never deletes originals or rewrites message relationships.

## Acceptance

1. Replaying the scenario from inference request
   `019ff769-f7a4-70c8-87a7-16722ff2ce43` sends only the Markdown resource
   manifest initially, reaches content after character 60,000 through bounded
   reads or search, and answers using evidence from the second half.
2. A message containing only a DOCX causes the agent to inspect a semantic
   Markdown derivative. A document longer than one page returns
   `complete: false` and a working continuation; tables, headings, links, and
   footnotes in the fixture remain identifiable.
3. A supported image message produces one durable message attachment, one
   work-stream resource, one manifest entry with the same resource ID, and one
   bounded visual content part. No model-visible image lacks a resource ID.
4. After a forced compaction, the model can call `workstream_view_resource` with
   the preserved ID and inspect the same image derivative again. The persisted
   checkpoint contains no data URI or binary part.
5. An older image omitted from a checkpoint remains discoverable through the
   pageable work-stream resource index and can be re-viewed after authorization.
6. Plain text, JSON, DOCX, PPTX, XLSX, text-layer PDF, scanned PDF, PNG/JPEG/WebP,
   HEIF/TIFF conversion, and GIF storyboard fixtures each take the declared path;
   corrupt, oversized, encrypted, and unsupported fixtures fail explicitly.
7. No single attachment read exceeds 24,000 model-visible characters, no search
   exceeds five passages or 20,000 characters, and no attachment tool returns
   binary content as base64 JSON.
8. A revoked, detached, private-note, wrong-workspace, wrong-draft-owner, or
   guessed resource ID returns the same bounded authorization/not-found behavior
   without disclosing content or existence across the boundary.
9. Extraction and deletion tests prove originals, active derivatives, superseded
   derivatives, chunk indexes, and receipts remain in the owning region and are
   removed according to resource lifecycle policy.
10. Work-stream and automation-architect regression suites prove that removing
    eager attachment text does not make draft attachments invisible and that a
    retry reuses a durable bounded result rather than repeating conversion.
11. `pnpm lint`, `pnpm typecheck`, `pnpm test`, both Wrangler dry-run builds, and
    the applicable desktop release invariants are green. The visible composer,
    transcript, image, loading, and failure states are inspected in the real
    Electron window before completion.
