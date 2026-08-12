# Context-safe agent attachments implementation plan

> Companion to [`prd.md`](./prd.md). Each phase ends with an acceptance gate;
> `state.md` advances to **in progress** only when the first implementation
> change lands.

## Phase 1 — Freeze the contracts and fixtures

- Add trigger-projection fixtures for text, DOCX, PDF, supported images,
  unsupported files, multiple attachments, and an attachment-only message.
- Capture the 106,460-byte Markdown regression corresponding to inference request
  `019ff769-f7a4-70c8-87a7-16722ff2ce43`.
- Define the typed manifest, derivative-state, coverage, cursor, and structured
  failure contracts shared by the API and harness.
- Add a pure manifest renderer with unit tests proving stable ordering, resource
  identity, untrusted-content separation, and the invariant that every proposed
  inline image has a matching manifest entry.
- Add reusable test helpers for bounded model content and opaque cursor fixtures;
  each later phase adds its integration assertions alongside the production path
  that makes them pass.

Acceptance gate: the shared contracts, renderer, fixtures, and tests are green;
the legacy projection remains active until the resource tools and both scoped
resolvers are ready. Tests may be written red during local development, but no
phase or commit lands with a failing quality gate.

## Phase 2 — Add durable derivative lifecycle

- Add the resource derivative lifecycle columns and regional chunk-index
  migration described in the PRD.
- Introduce one regional attachment-conversion service that verifies type and
  dispatches text, DOCX, PPTX, XLSX, PDF text extraction/OCR, and image
  normalization.
- Preserve the current image/GIF derivative behavior behind the new service
  instead of building a second image pipeline.
- Write derivatives and indexes under content-hash and extractor-version keys,
  then advance the resource row only after every required object is durable.
- Make first use lazily convert a legacy resource whose explicit status is
  absent.
- Extend deletion and orphan cleanup to active and superseded derivative objects
  and chunk indexes.
- Bound source bytes, expanded archive bytes, pages, pixels, execution time, and
  model-assisted OCR spend independently.

Acceptance gate: every supported fixture produces a reusable regional derivative
with stable metadata; corrupt and oversized fixtures fail safely; deletion leaves
no derivative objects or indexes behind.

## Phase 3 — Build bounded resource tools

- Make `workstream_read` paginate its authorized resource index and return the
  metadata required for attachment manifests.
- Replace the unbounded `workstream_read_resource` response with version-bound
  derivative pages, a 12,000-character default, a 24,000-character maximum,
  explicit coverage metadata, and opaque cursors.
- Add `workstream_search_resource` with five-passage and 20,000-character caps,
  stable range cursors, and surrounding-read compatibility.
- Add `workstream_view_resource` with bounded multimodal image parts, derivative
  reuse, batching limits, and a structured inclusion/skipping summary.
- Add `workstream_summarize_resource` using an isolated document-reader
  inference that returns an outline, bounded summary, citations, and coverage.
- Give the automation architect equivalent operations backed by the same
  conversion/page service and a separate frozen draft-owner resolver.
- Keep every tool result durable before Bind observes it, but store only the
  bounded page, passage, visual summary, or synopsis in the receipt.

Acceptance gate: a model can read, search, view, and summarize supported
attachments without any tool result exceeding its contract, and authorization
tests reject cross-workspace, detached, revoked, private-note, and wrong-owner
resources.

## Phase 4 — Switch model projection

- Replace `buildAttachmentModelParts` with a manifest builder plus the bounded
  visual projection; remove eager text/Office extraction and native PDF bytes
  from triggering messages.
- Include resource ID, verified MIME, size, derivative state, action, and inline
  state for every trigger attachment.
- Preserve compact stable attachment identities in historical projected
  messages instead of filename-only markers.
- Ensure a supported image always produces its durable manifest and, when
  normalization succeeds, its visual content part in the same projection.
- Add prompt guidance requiring inspection for attachment-dependent and
  attachment-only requests and forbidding whole-file claims after a partial
  read.
- Switch the automation architect to the same manifest behavior only after its
  draft-scoped tools are available.

Acceptance gate: the 106,460-byte Markdown regression contains no eager document
text in its initial inference, reaches the second half through tools, and every
supported inline image has a rehydratable resource identity.

## Phase 5 — Preserve attachment work through compaction

- Extend the compaction handoff prompt to retain relevant resource IDs,
  derivative versions, consulted ranges, conclusions, and unresolved reads while
  explicitly excluding attachment bytes.
- Prove terminal-turn and mid-run compaction both leave a resource reference the
  next turn can dereference.
- Prove an older attachment not named in the checkpoint remains discoverable
  through the pageable work-stream index.
- Exercise repeated compaction so resource IDs remain exact and untrusted file
  content never becomes a human instruction in the checkpoint.
- Add a guard ensuring model-visible attachment results respect their absolute
  cap even when the selected model has little measured headroom left.

Acceptance gate: forced compaction after viewing an image and after reading a
document page allows exact rehydration, stores no data URI or binary content, and
does not promote resource text into higher-authority instructions.

## Phase 6 — Roll out and remove the legacy path

- Deploy additive migrations and conversion services to both regions.
- Deploy tools before changing trigger projection.
- Verify an internal Global workspace and an internal EU workspace across every
  routed model using opt-in inference logging.
- Walk composer, transcript, image, processing, conversion-failure, unsupported,
  retry, and offline states in the Electron client and inspect screenshots.
- Switch trigger and automation projection to manifest-first behavior.
- Remove the 60,000-character attachment truncation path, raw PDF trigger parts,
  unused Office XML flattening, and tests that enshrine eager content.
- Update `docs/agent-harness.md`, `docs/context-compaction.md`,
  `docs/data-model.md`, `docs/security.md`, and any new attachment subsystem
  document in the implementing changes, including their running changelogs where
  required.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, both
  Wrangler dry-run builds, and any affected desktop release suite, capturing full
  output as required by the repository instructions.
- Advance [`state.md`](./state.md) to completed only after the final behavior and
  durable documentation ship.

Acceptance gate: all PRD acceptance criteria are demonstrated in both regions,
all quality gates are green, the visible product has been inspected, legacy eager
projection is unreachable, and rollback remains a code deploy rather than a data
restore.
