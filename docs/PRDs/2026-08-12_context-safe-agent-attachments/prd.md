# Context-safe agent attachments

> Created 2026-08-12.
>
> An Rally agent can reliably inspect text, Office, PDF, and image attachments
> without copying whole files into the conversation or losing access to an image
> after context compaction. Standing contract: [the Rally implementation
> brief](../2026-08-05_avalon-implementation-brief/prd.md). Governing runtime
> documents: [`../../agent-harness.md`](../../agent-harness.md) and
> [`../../context-compaction.md`](../../context-compaction.md).
> Implementation: [`plan.md`](plan.md).

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

Compaction adds a deterministic resource-inventory appendix after the LLM's
continuation summary. It states how many resources and message attachments the
current execution principal can see, groups them into stable attachment kinds
such as Markdown, images, PDFs, documents, spreadsheets, presentations, and
other text, and directs the agent to a filtered, cursor-paginated
`workstream_list_resources` resource index. The appendix is regenerated from
current authorized state rather than trusted to the summarizer or copied from an
older checkpoint.

## Motivation

Rally currently has two incompatible attachment contracts. The harness
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

The LLM summary is also the wrong authority for the complete current resource
inventory. It may omit an attachment that was not relevant to the turn being
summarized, and a snapshot it happens to describe becomes stale when a resource
is added or removed. Rally needs a small deterministic appendix that restores
awareness of the current inventory without spending context on every filename or
resource ID.

Prior art in Monad validates the direction: trigger messages carry lightweight
attachment metadata, images are downscaled into multimodal parts, attachment
bytes are re-fetched through authorized tools, and non-text formats have reusable
extraction paths. Its production history includes a fix for a trigger attachment
that was invisible to the agent (`637c67252`), range-based attachment reads
(`b8d4d3270`), and bounded multimodal images (`7bf400a99`). Rally should adopt
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
9. After compaction, the agent receives deterministic authorized totals and
   attachment-kind groups and can page through every matching current resource
   with a semantic attachment-kind filter.

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
6. Changing Rally's 80% compaction threshold or introducing general pruning for
   every connector tool is deferred. Attachment tools are bounded at their
   source; general tool-result pruning remains a harness-wide concern.
7. Re-extracting every historical resource before rollout is deferred. Existing
   resources are converted lazily on first authorized use, avoiding a regional
   backfill spike.
8. Making attachment IDs an authorization mechanism is rejected. An ID only
   names a resource; the current principal and owning message, work stream, or
   automation draft authorize every dereference.
9. Listing every resource name and ID in the compacted checkpoint is rejected.
   The appendix carries bounded totals and groups; the pageable resource index
   carries exact entries so a large work stream cannot refill its context during
   compaction.

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
version, range, total character count, the character counts before and after the
page, and opaque previous and next cursors. The cursor binds the resource ID and
derivative hash, so continuing a read cannot silently cross into a changed
derivative. A model can tell whether it saw the beginning, end, or whole file
without converting byte counts or doing subtraction. Whole-file coverage is
true for one page only when both `charactersBefore` and `charactersAfter` are
zero.

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

Rally creates or refreshes one reusable model derivative per original content
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

When the agent chooses a valid resource but calls a tool that cannot handle its
verified MIME kind, the call returns `resource_tool_mismatch`. The error names
the correct tool in its message and supplies a structured, ready-to-call
`suggestedCall` using the already-authorized resource ID. This remediation is
derived from the server's MIME classifier rather than authored by a converter or
the attachment. The harness does not execute it automatically; the model makes
the safe corrective call on its next turn.

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

### Compaction resource inventory

Compaction remains one LLM summarization call. After it returns, Rally passes
the summary and a freshly authorized inventory aggregate to a pure, versioned
checkpoint template. That template produces one synthetic user message in this
order:

1. the fixed checkpoint preamble;
2. the LLM continuation summary, unchanged; and
3. an `# Authoritative work-stream resource inventory` appendix.

The appendix is data rendered by Rally, not prose generated by the model. It
contains:

- the inventory `asOf` time;
- `totalVisibleResources` for all resources represented in the right sidebar for
  the current execution principal;
- `totalVisibleMessageAttachments` for the distinct resource subset introduced
  by message attachments; and
- one row for every non-empty server-defined attachment kind, with its count.

The stable kinds are `image`, `markdown`, `pdf`, `document`, `spreadsheet`,
`presentation`, `text`, and `other`. Classification uses the verified MIME type
first and a sanitized filename extension only when the stored MIME type is
generic. Groups appear in that fixed order and zero-count groups are omitted.
The renderer escapes all database strings and presents them as untrusted
metadata. It does not include file contents, filenames, MIME values, or every
resource ID.

The rendered shape is fixed:

```text
# Authoritative work-stream resource inventory
As of: <timestamp>
Visible resources: <totalVisibleResources>
Message attachments: <totalVisibleMessageAttachments>
Groups:
- image: <count>
- markdown: <count>

Use workstream_list_resources with attachmentKind, limit, and cursor to list exact resources.
Follow nextCursor until it is null when complete coverage is required.
```

The appendix ends with the exact `workstream_list_resources` call shape for
retrieving items from a group and says to follow `nextCursor` until it is null
when the task requires complete coverage. Resource IDs that were consulted or
remain relevant to unfinished work still belong in the LLM summary; the appendix
supplements that working set with deterministic discovery rather than replacing
it.

The stored compaction record retains the raw LLM summary, checkpoint template
version, execution-principal key, and authorized resource-inventory revision.
Rally captures that scope before summarization, verifies it after the model
returns, and makes the final D1 insert conditional on the revision still being
current. The inventory appendix is never persisted. Replay loads only the active
principal's row and uses the raw summary only when the resource revision exactly
matches; otherwise it discards the checkpoint and rebuilds from bounded durable
history. This prevents IDs or conclusions preserved in the raw summary from
crossing a note-privacy or revocation boundary.

## Impact on the product contract

None — this refines behavior within the existing contract. Attachments remain
work-stream resources, and the agent continues using typed, authorized tools
without shell or arbitrary code execution. The change makes the existing
resource and audit guarantees true at the model boundary; it does not add a new
global surface or participation rule.

## Decision log

### 2026-08-12 — Scope the raw compaction summary, not just its inventory

**Decided:** Store one raw summary per execution principal and bind it to the
monotonic authorized resource-inventory revision captured before the summary
call. A mismatch invalidates the checkpoint, and persistence is conditional on
the revision remaining current through the final write.

**Why:** The summary may retain exact attachment IDs and conclusions. Post-hoc
redaction cannot identify every private conclusion, and a compare followed by an
unconditional insert leaves a final revocation race.

**Changes:** The goals and user-visible product behavior are unchanged. The
implementation uses principal-scoped compaction rows, a trigger-maintained
revision, and bounded fallback replay as delivered in
[#144](https://github.com/juno-ai-labs/avalon/pull/144).

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
4. **Tool results use a context budget, not a file-size budget.** The server
   targets approximately 12,000 characters for a normal text page and never
   returns more than 24,000; search returns at most five passages and no more
   than 20,000 characters total. The executor may lower these limits when the
   last provider-reported usage leaves less headroom. A model-selected end
   offset or page size and megabyte-scale defaults were rejected.
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
9. **The resource inventory is deterministic post-processing, not a second model
   turn.** Rally appends authorized totals and group counts after the LLM
   summary and regenerates them on replay. Asking the summarizer to maintain the
   list was rejected because omission is subjective and a summarized snapshot
   becomes stale.
10. **The checkpoint carries aggregates; the tool carries entries.** A complete
    list of names and IDs was rejected because its context cost grows with the
    work stream. Fixed-order groups tell the model what exists, while filtered
    pagination makes every authorized resource discoverable on demand.
11. **Safe-read receipts are caches, not authority.** Registering a receipt is
    conditional on every cited derivative hash still being current. Replay
    rechecks current principal visibility and hashes, while list results and
    missing visual parts re-execute. Treating a prior authorization decision as
    durable was rejected because revocation must survive retries.

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
- `model_content_claimed_at` and `model_content_claim_id` — a reclaimable
  processing lease and fencing token that prevent an abandoned or superseded
  converter from blocking or publishing; and
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

No second attachment catalog is persisted for compaction. The existing raw
`summary` in `workstream_context_compactions` remains the durable LLM output; the
row gains `checkpoint_template_version`, `execution_principal_key`, and
`resource_visibility_fingerprint`, whose shipped value is the monotonic
`inventory:<revision>` fence. The primary key includes the execution principal.
`messages_json` retains only the base checkpoint message without an inventory
appendix. Authorized totals and groups are derived from current visibility when
a matching checkpoint is rendered; a principal or inventory-revision mismatch
invalidates the checkpoint.

## Regional impact

Original uploads already reside in the workspace's regional R2 bucket and their
resource rows in regional D1. Model derivatives, chunk indexes, extraction state,
and attachment-tool receipts stay in those same regional bindings. Queues and
Workflows carry opaque resource IDs, never attachment bodies. No attachment data
is copied through the Global identity plane or a cross-region bridge.

Provider-assisted PDF OCR and document-reader inference follow Rally's existing
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
- Compaction inventory totals and groups are calculated after applying the same
  execution-principal visibility rules as the right sidebar. They are regenerated
  on replay and never persisted as principal-specific shared checkpoint prose.

## Agent behavior

The trigger manifest tells the agent which files exist, which images it already
sees, and which typed action reads each one. Platform guidance adds three rules:

1. If the human request refers to an attachment, asks about “this file/image,”
   or contains no text besides attachments, inspect the relevant attachment
   before answering.
2. Do not describe a page as the whole file unless `charactersBefore` and
   `charactersAfter` are both zero. For complete sequential coverage, follow
   contiguous cursors from a page with `charactersBefore: 0` through a page with
   `charactersAfter: 0`; otherwise continue, search, or request a synopsis.
3. If a failure or skipped batch item carries `resource_tool_mismatch`, call its
   structured `suggestedCall` unchanged instead of guessing another tool or
   rewriting the resource ID.

The work-stream surface provides:

- `workstream_list_resources` — a filtered, pageable resource index capable of
  iterating through every resource visible to the execution principal, rather
  than a hard, unpageable fifty-resource ceiling;
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
every attachment still relevant to the request. The deterministic checkpoint
template then appends current authorized totals, type groups, and filtered-list
instructions after that LLM summary. It never asks the summarizer to copy file
contents, media parts, or the entire inventory. After compaction, a model
rehydrates a visual or passage by ID and reauthorization rather than relying on
remembered pixels or a stale excerpt.

## Agent tool contracts

These are the complete model-facing attachment contracts for a work-stream run.
Every argument schema is strict: unknown properties fail validation. UUIDs are
canonical lowercase UUID strings, timestamps are RFC 3339 UTC strings, and
opaque cursors are strings no longer than 2,048 characters. A cursor names state
but grants no authority; every call reauthorizes the current execution
principal. `attachmentKind` is the only model-selected format filter. Verified
MIME remains server metadata used for classification, extraction, and routing;
the model never supplies a MIME filter.

The contracts share these exact types:

```ts
type AttachmentKind =
  | "image"
  | "markdown"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "text"
  | "other";

type ContentMode = "read" | "search" | "view" | "unsupported";

type DerivativeStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "unsupported"
  | null;

type ResourceVersion = {
  sha256: string;
  extractorVersion: string;
};

type CharacterRange = {
  start: number; // inclusive, zero-based UTF-16 offset
  end: number;   // exclusive, zero-based UTF-16 offset
};

type SuggestedAttachmentToolCall =
  | {
      tool: "workstream_read_resource";
      arguments: { resourceId: string };
    }
  | {
      tool: "workstream_view_resource";
      arguments: { resourceIds: [string] };
    };
```

Successful tools return exactly the output object in their subsection. A tool
failure uses the harness failure channel with this model-visible shape:

```ts
type AttachmentToolFailure = {
  code:
    | "resource_not_found"
    | "resource_processing"
    | "resource_conversion_failed"
    | "resource_format_unsupported"
    | "resource_tool_mismatch"
    | "invalid_cursor"
    | "cursor_expired"
    | "resource_version_changed"
    | "context_budget_exceeded";
  message: string;
  data?: {
    reason?: string;
    retryAfterMs?: number;
    expected?: string;
    available?: string[];
    actualMimeType?: string | null;
    attachmentKind?: AttachmentKind;
    suggestedCall?: SuggestedAttachmentToolCall;
  };
};
```

Missing and unauthorized resources both return `resource_not_found` so the tool
does not disclose existence. `resource_processing` is retryable and includes
`retryAfterMs`. An invalidated listing cursor tells the agent to restart the
first page with its filters; a changed content cursor tells it to restart from
the resource ID or search the new derivative. The entire failure object is
bounded to 8,000 characters, `message` and `reason` to 1,000 characters each,
and `available` to twenty values of at most 160 characters each.

`resource_tool_mismatch` is emitted only after resource authorization succeeds.
Its `message` uses the deterministic form “`<calledTool>` cannot handle
`<actualMimeType>` resources; call `<suggestedCall.tool>` with the supplied
arguments instead.” Its `data` always includes `actualMimeType`,
`attachmentKind`, and `suggestedCall`. The routing table is:

| Verified kind | Valid content tools | A mismatched content tool suggests |
| --- | --- | --- |
| `image` | `workstream_view_resource` | `workstream_view_resource` |
| `markdown`, `pdf`, `document`, `spreadsheet`, `presentation`, `text` | `workstream_read_resource`, `workstream_search_resource`, `workstream_summarize_resource` | `workstream_read_resource` |
| `other` with a ready text derivative | `workstream_read_resource`, `workstream_search_resource`, `workstream_summarize_resource` | `workstream_read_resource` |
| `other` without a readable derivative | none | `resource_format_unsupported`; no suggested call |

`workstream_list_resources` is valid for every kind and never produces a MIME
mismatch. Processing, conversion, version, cursor, and authorization failures
take precedence over tool mismatch when the tool cannot yet classify an
authorized, current derivative safely.

### `workstream_list_resources`

Lists every resource represented in the right sidebar for the current execution
principal. `attachmentKind` is optional, `limit` defaults to 25, and `limit`
ranges from 1 through 50. A continuation accepts only the cursor; its filter and
page size are already bound into that cursor.

The complete model-facing tool description must name and explain every allowed
kind rather than relying only on a JSON Schema enum. Its attachment-kind text is
fixed as:

```text
Filter with attachmentKind using exactly one of these values:
- image — an image the agent can view
- markdown — a Markdown file
- pdf — a PDF document
- document — a word-processing document such as DOCX
- spreadsheet — a spreadsheet or workbook such as XLSX
- presentation — a slide presentation such as PPTX
- text — another readable text, source-code, or structured-data file
- other — a resource outside the readable or viewable kinds above
Omit attachmentKind to list every kind. Do not use or guess MIME types.
```

The schema enum and this description are generated or validated from one shared
kind registry so adding or renaming a kind cannot make the tool schema and model
instructions disagree. The same complete description is provided to every
routed model size and to the automation architect's draft-scoped list tool.

Arguments:

```ts
type WorkstreamListResourcesArguments =
  | {
      cursor?: never;
      limit?: number;
      attachmentKind?: AttachmentKind;
    }
  | {
      cursor: string;
      limit?: never;
      attachmentKind?: never;
    };
```

Output:

```ts
type WorkstreamListResourcesOutput = {
  workstreamId: string;
  asOf: string;
  totalVisibleResources: number;
  totalMatchingResources: number;
  filters: {
    attachmentKind: AttachmentKind | null;
  };
  items: Array<{
    resourceId: string;
    title: string;
    fileName: string | null;
    resourceType: string;
    provider: string;
    mimeType: string | null;
    sizeBytes: number;
    relationshipType: string;
    attachedAt: string;
    messageAttachment: boolean;
    attachmentKind: AttachmentKind;
    contentMode: ContentMode;
    derivativeStatus: DerivativeStatus;
  }>;
  nextCursor: string | null;
};
```

Items use deterministic `(attached_at DESC, resource_id ASC)` order. The cursor
binds the work stream, execution principal, attachment-kind filter, page size,
authorization scope, inventory boundary, and last key. `nextCursor: null` is the
only proof that the filtered scan is complete. A resource-membership or
visibility change invalidates an outstanding cursor instead of mixing two
inventories.

### `workstream_read_resource`

Reads a bounded page from the current model-ready text derivative. A first call
starts at character zero unless `startCharacter` requests an explicit seek. A
`readCursor` returned by search starts at that passage, while `previousCursor`
and `nextCursor` move one server-sized page in either direction. The model does
not choose an end offset or page size: the executor targets 12,000 characters,
never exceeds 24,000, and may return fewer to preserve model-context headroom.
`startCharacter` is a zero-based UTF-16 offset and, when supplied, must be a
nonnegative integer no greater than `totalCharacters`.

Arguments:

```ts
type WorkstreamReadResourceArguments =
  | {
      resourceId: string;
      startCharacter?: number;
      cursor?: never;
    }
  | {
      cursor: string;
      resourceId?: never;
      startCharacter?: never;
    };
```

Output:

```ts
type WorkstreamReadResourceOutput = {
  resourceId: string;
  title: string;
  sourceMimeType: string | null;
  modelMimeType: string;
  version: ResourceVersion;
  range: CharacterRange;
  totalCharacters: number;
  charactersBefore: number;
  charactersReturned: number;
  charactersAfter: number;
  text: string;
  previousCursor: string | null;
  nextCursor: string | null;
};
```

`charactersBefore === range.start`, `charactersReturned === range.end -
range.start`, and `charactersAfter === totalCharacters - range.end`.
`previousCursor` is null exactly when `charactersBefore` is zero, and
`nextCursor` is null exactly when `charactersAfter` is zero. Character counts,
not source-byte counts, describe the model-ready derivative. Each cursor binds
the resource ID, derivative hash, extractor version, target character offset,
server-selected page budget, work stream, and execution principal.

### `workstream_search_resource`

Searches one text derivative without searching the workspace or other resources.
`query` ranges from 1 through 1,000 characters. `limit` defaults to five and
ranges from one through five. `maxPassageCharacters` defaults to 3,000 and ranges
from 500 through 4,000; the combined returned passage text never exceeds 20,000
characters.

Arguments:

```ts
type WorkstreamSearchResourceArguments = {
  resourceId: string;
  query: string;
  limit?: number;
  maxPassageCharacters?: number;
};
```

Output:

```ts
type WorkstreamSearchResourceOutput = {
  resourceId: string;
  title: string;
  sourceMimeType: string | null;
  modelMimeType: string;
  version: ResourceVersion;
  query: string;
  totalMatches: number;
  returnedMatches: number;
  passages: Array<{
    rank: number;
    sectionLabel: string | null;
    range: CharacterRange;
    text: string;
    readCursor: string;
  }>;
  truncated: boolean;
};
```

Passages sort by descending deterministic relevance score and then ascending
`range.start`; `rank` starts at one. `truncated` is true exactly when
`totalMatches > returnedMatches` or the 20,000-character result cap excludes a
match. Each `readCursor` opens `workstream_read_resource` at that passage against
the same derivative version.

### `workstream_view_resource`

Loads supported images as bounded visual model content. `resourceIds` contains
one through eight unique resource IDs. `maxDimension` defaults to 1,536 and
ranges from 64 through 2,048 pixels on the long edge. The tool never falls back
to original bytes when normalization fails.

Arguments:

```ts
type WorkstreamViewResourceArguments = {
  resourceIds: string[];
  maxDimension?: number;
};
```

Output JSON summary:

```ts
type WorkstreamViewResourceOutput = {
  requested: number;
  returned: number;
  items: Array<{
    resourceId: string;
    title: string;
    sourceMimeType: string | null;
    modelMimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null;
    version: ResourceVersion | null;
    sourceBytes: number;
    derivativeBytes: number | null;
    width: number | null;
    height: number | null;
    status: "included" | "skipped";
    reasonCode:
      | "resource_not_found"
      | "resource_processing"
      | "resource_conversion_failed"
      | "resource_format_unsupported"
      | "resource_tool_mismatch"
      | null;
    reason: string | null;
    suggestedCall: SuggestedAttachmentToolCall | null;
    visualPartIndex: number | null;
  }>;
};
```

The model-visible tool result contains this JSON summary first, followed by one
`image_url` content part for each `included` item in item order.
`visualPartIndex` is the zero-based index among those image parts and is null for
a skipped item. `returned` equals the number of appended image parts. Because
this is a batch tool, a non-image resource does not discard valid image results:
its item is `skipped`, uses `reasonCode: "resource_tool_mismatch"`, names
`workstream_read_resource` in `reason`, and carries that exact `suggestedCall`.
If every item is the wrong kind, the tool fails once with
`resource_tool_mismatch` for the first input resource instead of returning a
successful result with zero images.

### `workstream_summarize_resource`

Runs an isolated document-reader inference over one model derivative. `prompt`
is an optional 1- through 2,000-character prompt addition that can state the
questions to answer, audience, desired emphasis, or output focus.
`maxOutputCharacters` defaults to 12,000 and ranges from 2,000 through 20,000.
The user-authored prompt is placed below the fixed document-reader policy and
cannot change authorization, tool access, file-content trust, citation, or
coverage requirements. The output must cite the derivative ranges supporting
material claims and report whether the reader covered the complete derivative.

Arguments:

```ts
type WorkstreamSummarizeResourceArguments = {
  resourceId: string;
  prompt?: string;
  maxOutputCharacters?: number;
};
```

Output:

```ts
type WorkstreamSummarizeResourceOutput = {
  resourceId: string;
  title: string;
  sourceMimeType: string | null;
  modelMimeType: string;
  version: ResourceVersion;
  prompt: string | null;
  outline: Array<{
    heading: string;
    range: CharacterRange;
  }>;
  summary: string;
  citations: Array<{
    label: string;
    range: CharacterRange;
    readCursor: string;
  }>;
  coverage: {
    status: "complete" | "partial";
    totalCharacters: number;
    consideredCharacters: number;
    limitations: string[];
  };
};
```

`coverage.status` is `complete` only when the isolated reader processed the
entire version named in the output. Each citation cursor opens
`workstream_read_resource` at the cited range for verification. `outline` and
`citations` contain at most fifty items each, `limitations` contains at most
twenty items, and all model-authored strings in the output together obey
`maxOutputCharacters`.

The automation architect exposes the same argument and output contracts under
draft-scoped tool names. Its resolver substitutes the frozen draft attachment
set for the work-stream relationship and never accepts a work-stream cursor.

## Rollout

This is a correctness and trust-boundary change, not a user-selectable feature.
It does not add a Flagship flag; Rally's current Flagship contract covers model
routing and client-visible features rather than arbitrary server code paths.

The rollout is additive before it switches projection:

1. Deploy derivative lifecycle columns, deletion coverage, conversion services,
   and lazy compatibility for existing rows.
2. Deploy bounded read, search, view, synopsis, and attachment-kind-filtered
   pageable index tools for work streams and automation drafts while the legacy
   projection still exists.
3. Add stable manifests to trigger and historical projections. Images begin
   carrying both manifest identity and visual parts.
4. Switch non-image trigger attachments from eager content to manifest-only and
   remove the 60,000-character attachment projection.
5. Deploy the deterministic post-summary resource-inventory template, update
   compaction guidance and replay tests, then remove legacy extraction paths that
   are no longer used.

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
   Markdown derivative. A document longer than one page returns a positive
   `charactersAfter` count and a working `nextCursor`; tables, headings, links,
   and footnotes in the fixture remain identifiable.
3. A supported image message produces one durable message attachment, one
   work-stream resource, one manifest entry with the same resource ID, and one
   bounded visual content part. No model-visible image lacks a resource ID.
4. After a forced compaction, the model can call `workstream_view_resource` with
   the preserved ID and inspect the same image derivative again. The persisted
   checkpoint contains no data URI or binary part.
5. An older image omitted from a checkpoint remains discoverable through the
   pageable work-stream resource index and can be re-viewed after authorization.
6. A forced compaction appends deterministic totals for all currently visible
   resources and message attachments and fixed-order non-empty kind groups after
   the unchanged LLM summary. It includes no filenames, MIME values, content, or
   unbounded ID list.
7. Replaying that checkpoint with the same principal and inventory revision
   regenerates the appendix to match the right sidebar. Adding, removing, hiding,
   or revoking a resource, or changing the execution principal, invalidates the
   checkpoint and falls back to durable transcript replay without exposing its
   stored LLM summary.
8. `workstream_list_resources` can filter by every `attachmentKind`, returns
   visible and matching totals, and follows deterministic cursors until
   `nextCursor` is null across more than fifty authorized resources without a
   duplicate or omission. Its model-facing description names and explains all
   eight kinds and explicitly says to omit the filter to list every kind.
9. Contract tests cover the exact strict arguments, success outputs, common
   failure shape, defaults, bounds, all eight attachment-kind descriptions,
   explicit `startCharacter` seeks, character-count invariants, optional
   summarizer prompts, and cursor continuation for all five tools; unknown
   properties and invalid argument combinations fail validation.
10. Calling read, search, or summarize on an image returns
    `resource_tool_mismatch` with a ready `workstream_view_resource` call;
    calling view on readable text or a document returns or embeds the matching
    `workstream_read_resource` remediation. Unsupported and unauthorized
    resources do not leak a suggested call.
11. Plain text, JSON, DOCX, PPTX, XLSX, text-layer PDF, scanned PDF,
    PNG/JPEG/WebP, HEIF/TIFF conversion, and GIF storyboard fixtures each take
    the declared path; corrupt, oversized, encrypted, and unsupported fixtures
    fail explicitly.
12. No single attachment read exceeds 24,000 model-visible characters, no search
   exceeds five passages or 20,000 characters, and no attachment tool returns
   binary content as base64 JSON.
13. A revoked, detached, private-note, wrong-workspace, wrong-draft-owner, or
   guessed resource ID returns the same bounded authorization/not-found behavior
   without disclosing content or existence across the boundary.
14. Extraction and deletion tests prove originals, active derivatives, superseded
   derivatives, chunk indexes, and receipts remain in the owning region and are
   removed according to resource lifecycle policy.
15. Work-stream and automation-architect regression suites prove that removing
    eager attachment text does not make draft attachments invisible. A retry
    reuses a durable bounded result only after current visibility, derivative
    hashes, and required image parts pass again; otherwise the safe read
    re-executes without repeating an unchanged conversion.
16. `pnpm lint`, `pnpm typecheck`, `pnpm test`, both Wrangler dry-run builds, and
    the applicable desktop release invariants are green. The visible composer,
    transcript, image, loading, and failure states are inspected in the real
    Electron window before completion.
