# Context-safe agent attachments implementation plan

This plan implements the adjacent [PRD](prd.md) in dependency order. Each phase
starts by adding or changing an automated test that fails for the missing
behavior, implements the smallest complete behavior that makes the test pass,
then refactors while the focused suite remains green. A phase is not complete
until its negative authorization, limit, retry, and lifecycle cases are covered;
a happy-path-only test is not an acceptance gate.

The implementation keeps the original uploads and sidebar relationship model
authoritative. It adds one reusable model-derivative subsystem and wraps it with
separately authorized work-stream and automation-draft operations. Non-image
file contents stop entering the main transcript only after those operations are
deployed and tested, so an intermediate commit cannot make attachments
invisible to the agent.

## Working rules

- Before each phase, reread `docs/README.md` and the owner documents named by
  that phase. Read `docs/module-documents.md` before creating the attachment
  module document in Phase 0.
- Run the focused tests named in each phase after the red assertion is added,
  after the implementation, and after refactoring. Before every semantic commit,
  also run `pnpm lint`, `pnpm typecheck`, and `pnpm test`; capture non-trivial
  output in `/tmp` as required by `AGENTS.md` and delete the logs after use.
- Commit only green, coherent slices. The commit boundaries below are the
  default; split one only when the split still leaves a deployable behavior and
  combine none of them merely to reduce commit count.
- Mark `state.md` as `in progress` in the first implementation commit (Phase 0),
  not in the plan-only commit. Mark it `completed` only after the full acceptance
  suite, visible verification, and documentation pass.
- Treat resource IDs and cursors as names, never authority. Every operation
  reloads the current principal, owning workspace, work stream or frozen
  automation draft, relationship, visibility, and revocation state.
- Keep source bytes, derivatives, indexes, prompts derived from attachment
  contents, and multimodal data URIs out of structured logs and persisted
  compaction messages.
- Do not add a model-routing or Flagship role. Reuse the existing work-stream and
  automation compiler routes for isolated extraction and summarization calls.
- Keep all new storage in the owning regional D1/R2 bindings. Queues and
  Workflows carry opaque identifiers and bounded metadata, never file bodies.
- Generate attachment-kind enums, classifier behavior, tool-schema enums, and
  model-facing descriptions from one shared registry. The tool description must
  literally name and explain every kind: `image`, `markdown`, `pdf`,
  `document`, `spreadsheet`, `presentation`, `text`, and `other`.
- Create `docs/agent-attachments.md` in the first implementation commit and keep
  its current-behavior body and newest-first changelog synchronized in every
  later phase. Update each existing owner document in the same commit that
  changes its behavior; the final phase audits consistency rather than deferring
  documentation until the end.

## Phase 0 — Lock the contracts in executable fixtures

Establish the vocabulary and protocol shapes before adding storage or tool
behavior, so later phases cannot drift into independently named kinds, errors,
or cursors.

### Red tests

- Add contract tests that require all eight attachment kinds to occur in the
  `workstream_list_resources` JSON schema enum and in its model-facing
  description, including a plain-language explanation of each value.
- Add strict schema tests for the five work-stream tools and their draft-scoped
  automation equivalents. Unknown properties, unsupported argument
  combinations, duplicate image IDs, out-of-range counts, and raw MIME filter
  arguments must fail validation.
- Add structured-failure tests proving that only the bounded attachment recovery
  fields survive sanitization and that arbitrary nested provider data is not
  forwarded to the model.
- Add cursor codec tests for tampering, wrong purpose, wrong principal, wrong
  resource/work stream/draft, expired or changed versions, excessive length,
  and valid round trips.

### Implementation

- Add a shared attachment-kind registry and classifier based on verified MIME
  type, with sanitized extension fallback only for generic stored MIME values.
  Store the kind keys and their exact model-facing explanations in that one
  registry.
- Define strict argument and output types for:
  `workstream_list_resources`, `workstream_read_resource`,
  `workstream_search_resource`, `workstream_view_resource`, and
  `workstream_summarize_resource`, plus draft-scoped equivalents.
- Extend the structured tool-failure sanitizer with bounded
  `actualMimeType`, `attachmentKind`, and a discriminated `suggestedCall` for
  read or view. Reject every other nested recovery shape.
- Add a purpose-tagged, versioned and authenticated opaque cursor codec using a
  purpose-separated server signing key. The payload binds the operation scope
  and continuation state; parsing never skips the operation's ordinary
  authorization query.
- Add tool-activity labels for all new model wire names. Remove the legacy
  `workstream_read` label only when the replacement list tool is registered.
- Create and register `docs/agent-attachments.md` in the required module-document
  shape, describing only behavior that exists after this phase. Start its
  changelog with the contract boundary, update `docs/agent-tools.md`, and mark
  `state.md` as `in progress` in this commit.

### Acceptance gate

- The focused contract, structured-failure, cursor, and tool-activity tests are
  green.
- A snapshot or assertion proves that the list tool description presented to a
  model contains all eight natural-language kinds and no MIME-filter advice.
- No API handler or schema has started depending on an unverified filename
  extension as the primary classifier.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green for the phase commit,
  and the attachment module document describes the phase's shipped boundary.

Default commit: `agent: define context-safe attachment contracts`.

## Phase 1 — Add regional derivative lifecycle state

Make derivative creation, replacement, and deletion explicit before any tool
depends on it.

### Red tests

- Add migration tests for original content identity, derivative status,
  extractor version, readable-character count, extraction time, bounded error
  code, fenced processing claim, and compaction checkpoint-template version and
  authorization-scope fields.
- Add resource lifecycle tests proving that deleting, expiring, orphaning, or
  replacing an original removes the active derivative and chunk index, and
  schedules bounded retry state if R2 cleanup fails. Separate detachment tests
  prove immediate loss of authorization and listing visibility without deleting
  an object that another valid relationship still owns.
- Add concurrency tests proving that two first reads of one pending resource
  produce one winning current derivative and never expose a half-written object
  or index.
- Add compatibility tests proving that an existing row with legacy image
  derivative columns and no lifecycle status is classified lazily rather than
  requiring an eager backfill.
- Add ingestion tests proving uploads and connector hydration calculate the
  immutable original-content hash from the exact stored bytes, including lazy
  calculation for legacy rows whose content predates the column.

### Implementation

- Add an additive regional migration for the lifecycle fields specified by the
  PRD and `checkpoint_template_version`. Keep deployed migrations immutable.
- Define versioned R2 keys for model derivatives and their bounded indexes using
  resource ID, original content hash, and extractor version. Write objects
  before atomically advancing the resource row.
- Calculate and persist `content_sha256` during upload and connector hydration.
  A legacy row calculates it during the first authorized derivative request;
  the hash must describe the exact R2 object selected for extraction.
- Add a regional derivative-deletion outbox or extend the existing resource
  deletion mechanism so active and superseded model objects receive the same
  retry guarantees as originals. Outbox rows contain references and error
  metadata, never attachment contents.
- Centralize original, derivative, index, and superseded-object cleanup in the
  resource lifecycle service and call it from draft deletion, note/resource
  deletion, expiry, and orphan cleanup paths.
- Make that cleanup extensible to bounded attachment-tool receipts. When Phases
  3 and 4 begin writing receipts, register them with the same resource lifecycle
  and cover replacement, failed cleanup retry, and final deletion.
- Interpret legacy rows on first authorized use: reuse a valid existing image
  derivative, or move the row through pending extraction without a workspace
  backfill.
- Update `docs/data-model.md`, `docs/security.md`, and the attachment module body
  and changelog in this commit.

### Acceptance gate

- Migration, concurrency, failure-retry, legacy-row, and deletion tests are
  green for both regional database bindings.
- A failed conversion is distinguishable from an empty readable file, and a
  pending conversion cannot be mistaken for ready content.
- No database row, queue payload, or log field contains extracted content or
  multimodal bytes.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green for the phase commit.

Default commit: `db: add attachment derivative lifecycle`.

## Phase 2 — Build reusable, bounded model derivatives

Replace trigger-specific extraction with a reusable service that every surface
can call after authorization.

### Red tests

- Convert the existing eager attachment tests into derivative fixtures for
  UTF-8 text, Markdown, source, CSV, JSON, XML, YAML, DOCX, PPTX, XLSX,
  text-layer PDF, scanned PDF, PNG, JPEG, WebP, HEIF, TIFF, and animated GIF.
- Add fixtures that require DOCX headings, lists, tables, links, headers,
  footnotes and endnotes; slide ordering, tables and speaker notes; sheet names,
  values and formulas/display values; and PDF page boundaries and OCR method.
- Add adversarial fixtures for invalid UTF-8, corrupt archives, path traversal,
  XML expansion, excessive archive expansion, excessive page/pixel/frame count,
  encrypted PDFs, converter timeouts, and unsupported audio/video/binary data.
- Add deterministic-version tests proving unchanged original hash and extractor
  version reuse the ready derivative, while a new extractor version creates and
  atomically selects a new derivative.
- Add index tests proving section labels and character ranges refer to the exact
  stored derivative version and contain no unbounded duplicate of the file.

### Implementation

- Split `attachment-model-content.ts` into a manifest/image projection layer and
  a regional derivative service. Reuse the existing verified image sniffing,
  normalization, HEIF/TIFF conversion, pixel limits, and GIF storyboard code.
- Extract text and supported Office documents into semantic Markdown or
  structured text as specified by the PRD. Preserve deterministic ordering and
  identify extraction method and omissions in bounded metadata.
- Extract text-layer PDFs page by page. When a PDF is materially empty or
  scanned, use an isolated bounded provider/OCR path on the existing work-stream
  or automation route, record the OCR method, and fail explicitly when coverage
  cannot be established.
- Build a bounded section/chunk index beside the derivative. Store offsets in
  zero-based UTF-16 characters, matching JavaScript slicing and the tool
  contracts.
- Enforce independent source-byte, expanded-byte, XML, page, pixel, frame,
  converter-time, derivative-size, and metadata limits. Never fall back to raw
  binary model input after normalization or conversion fails.
- Expose one service entry point that accepts a server-authorized resource and
  returns ready, processing, failed, or unsupported state. It must not perform
  work-stream or automation authorization itself.
- Update the attachment module's mechanism, limits, regional/security sections,
  tests, and changelog in this commit.

### Acceptance gate

- Every declared fixture takes the expected path and records its derivative
  format, source hash, extractor version, total readable characters, and bounded
  type-specific metadata.
- Corrupt, encrypted, oversized, timed-out, unsupported, and still-processing
  files return distinct typed states; none returns empty text as success.
- Repeated reads reuse the same ready derivative and concurrent creation leaves
  no observable partial state.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green for the phase commit.

Default commit: `api: build reusable attachment derivatives`.

## Phase 3 — Replace the resource index and add bounded text tools

Deploy complete discovery and text hydration before removing eager transcript
contents.

### Red tests

- Add parity tests that compare the resource IDs returned by the right-sidebar
  visibility loader and `workstream_list_resources` for a user principal and a
  workspace principal, including personal notes, workspace notes, detached
  resources, revocation, and wrong-workspace data.
- Add pagination tests across more than fifty visible resources, every
  attachment-kind filter, stable ordering, no duplicates or omissions, null
  final cursor, tampered cursor, and membership/visibility changes between
  pages.
- Add read tests for first-page default, explicit `startCharacter`, previous and
  next continuation, context-headroom reduction, version change, and the exact
  `charactersBefore`, `charactersReturned`, and `charactersAfter` arithmetic.
- Add search tests for query and passage bounds, deterministic ranking,
  section labels, total/truncated accounting, and read cursors that open the
  matching derivative range.
- Add authorization-equivalence tests: nonexistent, guessed, revoked, detached,
  private-note, and wrong-workspace IDs all expose the same not-found behavior.
- Add receipt tests proving list metadata and bounded read/search results are
  regional, deterministic for retry, excluded from structured logs, and removed
  or invalidated with the owning resource/version.

### Implementation

- Extract one authorized work-stream resource visibility query/predicate used by
  sidebar loading, attachment tools, and compaction inventory, preventing those
  three consumers from drifting.
- Replace the legacy hard-capped `workstream_read` model tool with
  `workstream_list_resources`. Support optional `attachmentKind` and `limit` on
  the first page and cursor-only continuation. Compute and bind a deterministic
  authorized inventory boundary/fingerprint so changed membership invalidates a
  scan rather than mixing snapshots.
- Implement `workstream_read_resource` over the ready derivative. First calls
  accept `resourceId` plus optional `startCharacter`; continuations accept only
  a server-issued cursor. The server targets 12,000 and caps 24,000 model-visible
  characters, reducing the result when remaining model context requires it.
- Return range, total, exact characters on either side, and previous and next
  cursors. Whole-file coverage exists only when both `charactersBefore` and
  `charactersAfter` are zero. Cursor continuation binds the resource, derivative
  hash, extractor version, offset, page budget, scope, and principal.
- Implement resource-local lexical `workstream_search_resource` over the bounded
  index. Return at most five passages and 20,000 passage characters total, with
  read cursors for surrounding context.
- Return `resource_processing` with a retry interval while lazy extraction is in
  progress. Return explicit conversion, unsupported, cursor, version, budget,
  and not-found failures for all other states.
- Persist only bounded deterministic list/read/search receipts and register them
  with the derivative lifecycle; never persist an unbounded passage or a second
  full derivative copy.
- Update `docs/agent-tools.md`, `docs/workstream-origin-attachments.md`, and the
  attachment module body and changelog in this commit.

### Acceptance gate

- The list tool and right sidebar contain the same authorized resource set for
  every tested principal, and filtered pagination can exhaust it without drift.
- Reads cannot exceed 24,000 visible characters; searches cannot exceed five
  passages or 20,000 characters; all partial results expose coverage
  structurally.
- The old fifty-resource `workstream_read` model tool is gone and all tool
  activity labels and documentation use `workstream_list_resources`.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green for the phase commit.

Default commit: `api: add pageable attachment discovery and reads`.

## Phase 4 — Add image recovery, isolated summaries, and self-healing errors

Complete the work-stream content operations, including multimodal results that
can be reissued after compaction.

### Red tests

- Add image batch tests for one through eight unique IDs, mixed valid and wrong
  kinds, normalization failure, dimension bounds, order-preserving visual-part
  indexes, all-wrong-kind failure, and no binary bytes inside the JSON summary.
- Add harness/provider protocol tests proving a view result reaches the next
  model turn as one bounded JSON text part followed by ordered image content
  parts, while the persisted tool receipt contains only the JSON summary.
- Add summarize tests for optional `prompt`, output bounds, outline/citation
  caps, complete versus partial coverage, range verification, provider failure,
  and large derivatives that require hierarchical isolated processing.
- Add a wrong-tool matrix test for every attachment kind. An authorized image
  sent to read/search/summarize must suggest an exact view call; readable text or
  document data sent to view must suggest an exact read call; unsupported and
  unauthorized data must not reveal a suggestion.
- Add retry/replay tests proving tool receipts are deterministic without
  repeating conversion and never persist a data URI.
- Add receipt lifecycle tests for view and summary results after derivative
  replacement, failed cleanup retry, and final resource deletion.

### Implementation

- Extend the harness tool-result adapter to support ephemeral multimodal content
  parts while persisting a bounded deterministic JSON receipt. Keep generic
  connector tool behavior unchanged.
- Implement `workstream_view_resource` using persisted model image derivatives.
  Return the structured inclusion summary and append image parts in item order;
  skip an invalid member without losing valid batch members.
- Implement `workstream_summarize_resource` as an isolated inference on the
  ready derivative. Use the caller's optional `prompt` as untrusted focus text,
  provide range-grounded chunks, and return outline, bounded summary, citations,
  and explicit coverage. Verify every cited range before returning it.
- Centralize attachment operation routing. After authorization and safe kind
  classification, emit deterministic `resource_tool_mismatch` failures with the
  ready-to-call `suggestedCall`; do not automatically execute the correction.
- Preserve failure precedence: not-found/authorization, processing, conversion,
  unsupported, version, and cursor failures cannot leak kind or remediation
  across a boundary.
- Update `docs/agent-harness.md`, `docs/agent-tools.md`, and the attachment
  module body and changelog in this commit.

### Acceptance gate

- A model can inspect a current or older image by resource ID, and neither the
  tool receipt nor a retry/replay checkpoint contains binary or data-URI bytes.
- All mismatch loops can self-correct from the structured result without the
  model inventing a tool name or resource ID.
- Summaries are bounded, range-cited, and honest about partial coverage; focused
  prompts cannot become system instructions.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green for the phase commit.

Default commit: `agent: add attachment view and summary recovery`.

## Phase 5 — Deploy automation-draft tools and manifest projection additively

Give automation compilation the same lazy hydration ability and introduce
manifests while the legacy eager projection remains available. This is a
separately deployable compatibility phase; it does not remove document text or
native PDF parts.

### Red tests

- Add additive projection tests for a text attachment, supported image, failed
  image, mixed attachments, attachment-only message, and historical messages.
  Every case must expose stable manifest IDs and verified metadata while the
  legacy content path remains present until the next phase.
- Add image identity tests proving every admitted current-turn visual part has a
  same-ID manifest entry and a stored regional derivative, and that a failed
  image remains discoverable with `inlined: false`.
- Add automation compiler tests proving the frozen draft attachment set receives
  equivalent list/read/search/view/summarize operations and cannot use
  work-stream cursors or dereference another draft or owner.
- Add explicit automation tests for guessed IDs and attachments removed,
  revoked, or hidden after compilation freezes its ID set. Wrong workspace,
  wrong owner, and cross-namespace cursors must return the same not-found shape.
- Add prompt-injection tests proving attachment names, extracted text, OCR text,
  and optional summary focus remain user/tool data and cannot close or replace
  harness instructions.

### Implementation

- Build compact structured manifest entries from server-loaded attachment rows:
  resource ID, filename, verified MIME type, size, content mode, derivative
  status, bounded nullable `errorCode`, and `inlined`. Historical messages retain
  the same addressable shape. Test exact kind-to-content-mode routing, including
  readable and unsupported `other` resources.
- For a supported image on the triggering message, emit the manifest and bounded
  visual part together. A normalization failure still emits the manifest and
  does not suppress other attachments or message text.
- Add a draft-scoped attachment plugin to automation compilation. Freeze its
  allowed resource IDs from the compile request and recheck workspace, draft,
  ownership, visibility, and revocation on every operation. Share derivative
  and paging implementations, not authorization shortcuts or cursor namespaces.
- Keep legacy eager document/PDF projection active during this phase. Update
  `docs/agent-harness.md`, `docs/agent-tools.md`, and the attachment module body
  and changelog with the additive compatibility behavior.

### Acceptance gate

- All trigger and historical attachments have durable manifest references, and
  every automation attachment can be hydrated through draft-scoped operations
  without relying on eager content.
- Work-stream and automation suites prove cross-scope, post-freeze revoked, and
  guessed IDs/cursors reveal nothing.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green for the phase commit.

Default commit: `agent: add durable attachment manifests and draft tools`.

## Phase 6 — Cut over to manifest-only projection

Remove eager contents only after both work-stream and automation tools are
deployed, tested, and observed reaching every routed model.

### Red tests and rollout evidence

- Reproduce inference request `019ff769-f7a4-70c8-87a7-16722ff2ce43`: assert the
  initial Markdown projection contains no 60,000-character prefix and that a
  read/search reaches evidence after character 60,000 and changes the answer.
- Add harness/model-routing tests proving attachment-only and “this file/image”
  requests inspect the relevant attachment before answering. A partial page must
  not be treated as whole-file coverage; the agent continues through contiguous
  cursors, search, or an honest bounded summary as the task requires.
- Add image projection tests at and one over the source-byte, pixel-count,
  derivative-byte, image-count, and long-edge limits. Mixed good/bad batches
  preserve message text and other attachments, and every emitted visual part has
  a same-ID persisted derivative.
- Verify through the regional inference lakehouse in an internal workspace that
  manifests and tool continuations reach every routed work-stream and automation
  model. This evidence is a mandatory pre-cutover gate and must not copy file
  contents into ordinary logs or tickets.

### Implementation

- Remove eager text/Office extraction, native PDF file parts, and the 60,000
  character truncation path from work-stream and automation transcript
  projection. Keep all non-image extraction behind authorized tools.
- Emit a supported triggering image's manifest and bounded visual part together.
  On any admission or normalization failure, keep the manifest with
  `inlined: false` and `errorCode`, and preserve all other message parts.
- Add platform guidance requiring inspection when a request points to an
  attachment and continued hydration when character counts prove coverage is
  partial.
- Update `docs/agent-harness.md`, `docs/workstream-origin-attachments.md`, and the
  attachment module body and changelog in this commit.

### Acceptance gate

- No non-image bytes or eager extracted contents enter the main conversation;
  every inline image has a durable identity, and failed files stay discoverable.
- The recorded Markdown regression and attachment-only integration cases prove
  the model uses tool evidence rather than merely having tools available.
- Internal routed-model evidence is complete, and `pnpm lint`, `pnpm typecheck`,
  and `pnpm test` are green for the cutover commit.

Default commit: `agent: cut over to manifest-only attachments`.

## Phase 7 — Regenerate deterministic resource inventory through compaction

Make current authorized discovery survive compaction without asking the LLM to
remember an unbounded or stale inventory.

### Red tests

- Add pure renderer snapshot tests for zero resources, all eight non-empty kinds,
  fixed kind order, totals, message-attachment subset totals, escaping of
  untrusted metadata, bounded output, and the exact natural-language list-tool
  call guidance.
- Add compaction tests proving the LLM continuation summary is unchanged and the
  authoritative appendix follows it, with no filenames, resource IDs, MIME
  values, contents, or binary parts.
- Add persistence/replay tests proving the raw summary, template version,
  execution-principal key, and visibility fingerprint are stored while the
  appendix is not. Replay rebuilds the appendix only when the scope matches.
- Add fail-closed tests for a resource added, removed, detached, revoked, or
  hidden by note visibility during summarization, before persistence, or before
  replay. No mismatched principal may receive the raw summary.
- Add compaction prompt tests requiring exact IDs, derivative versions, material
  ranges, conclusions, and unresolved needs only for attachments relevant to
  ongoing work, never the complete catalog.

### Implementation

- Add a pure, versioned resource-inventory renderer. Its input is a freshly
  authorized aggregate from the same visibility boundary as the sidebar and
  list tool; its output contains timestamp, total visible resources, total
  visible message attachments, and fixed-order non-empty kind counts.
- Extend the harness compaction host contract with a before-summary scope
  preparation callback and deterministic appendix callback. Capture the
  principal and resource fingerprint before the summary, verify it after the
  model returns and before persistence, and append the inventory only to the
  live checkpoint.
- Store and validate `checkpoint_template_version`, `execution_principal_key`,
  and `resource_visibility_fingerprint`. Rebuild one synthetic message from the
  stored raw summary plus a new authorized inventory only for an exact scope
  match; otherwise replay durable messages without the checkpoint.
- Update the summary prompt to preserve only the durable working set: relevant
  IDs, derivative versions, consulted ranges, material conclusions, and
  unresolved needs. It must not copy file contents, image bytes, or the entire
  inventory.
- Treat legacy rows without authorization scope as invalid checkpoints while all
  new compactions use the current scoped version.
- Update `docs/agent-harness.md`, `docs/context-compaction.md`, and the attachment
  module body and changelog in this commit.

### Acceptance gate

- Forced compaction and an exact-scope replay both show an inventory that matches
  the right sidebar. A principal or visibility change invalidates the checkpoint
  without exposing its summary.
- Stored checkpoints contain no principal-specific inventory, data URI,
  attachment contents, or unbounded ID/name list.
- A post-compaction model can exhaust any kind through
  `workstream_list_resources`, following `nextCursor` until null.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green for the phase commit.

Default commit: `agent: preserve attachment inventory through compaction`.

## Phase 8 — Close lifecycle, security, documentation, and regression gaps

Run the product contract as a system rather than treating the focused tests as
proof that adjacent behavior remained intact.

### Red tests and audits

- Add any missing end-to-end regression that emerges from running the full
  suites: resource upload/display/download, personal-note visibility, workspace
  principals, automation retries, compaction retries, regional cleanup, and
  connector tools that return ordinary text-only results.
- Run a repository search asserting legacy eager projection limits and the old
  model wire name do not remain in active runtime code or model guidance.
- Inspect logs/receipts in tests for source bytes, extracted snippets, OCR bodies,
  prompts derived from attachment contents, search passages, and data URIs.
- Exercise deletion after derivative replacement and after a failed cleanup to
  prove original, active, superseded, index, and receipt lifecycle converge.

### Implementation and durable documentation audit

- Audit `docs/agent-attachments.md` for the required code map, mechanism,
  invariants, boundary, failure modes and limits, testing, data model, regional
  impact, security/trust model, operations, performance/cost, and newest-first
  changelog. It and its index registration already exist from Phase 0.
- Reconcile `docs/agent-harness.md`, `docs/agent-tools.md`,
  `docs/context-compaction.md`, `docs/data-model.md`, `docs/security.md`, and
  `docs/workstream-origin-attachments.md` so each owner describes the shipped
  behavior and points to the attachment module rather than duplicating it.
- Record a PRD decision only if implementation had to change the product scope
  or contract; record low-level assumptions in `docs/assumptions.md` only when
  they meet that document's threshold.
- Mark `state.md` completed after every gate below succeeds. At that point the
  PRD and state become frozen except for the allowed pull-request trailer.

### Final acceptance gate

Run once, with full output captured, and require all to pass without warnings or
retries:

Also run the desktop release invariants if a desktop release file or script was
touched. Independently of whether the DOM changed, inspect the composer,
transcript attachment, current image, loading, processing, conversion-failure,
and unsupported-format states in a real Electron window using the documented
Xvfb/Playwright procedure, then read the captured screenshots before completion.
Require CI's full-history Gitleaks scan before declaring the implementation
shippable; never weaken or bypass it locally.

The final review must verify all sixteen PRD acceptance criteria, no changed test
was made less strict, no retry/skip was introduced, every new limit has both an
at-boundary and over-boundary test, and both regional builds use only regional
bindings for attachment state.

Default commit: `docs: complete context-safe attachment rollout`.

## Semantic commit sequence

The expected history is:

1. `docs: add context-safe attachment implementation plan`
2. `agent: define context-safe attachment contracts`
3. `db: add attachment derivative lifecycle`
4. `api: build reusable attachment derivatives`
5. `api: add pageable attachment discovery and reads`
6. `agent: add attachment view and summary recovery`
7. `agent: add durable attachment manifests and draft tools`
8. `agent: cut over to manifest-only attachments`
9. `agent: preserve attachment inventory through compaction`
10. `docs: complete context-safe attachment rollout`

If a focused phase uncovers a pre-existing flaky test, reproduce and fix it as a
separate semantic commit when it is in the touched code; if it is unrelated,
record the exact test and evidence in the final report and pull-request
description. Never hide it with retries, altered timing, weaker assertions, or a
skip.
