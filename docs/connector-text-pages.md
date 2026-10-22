# Connector text pages

Connector text pages separate the source file from the amount of text placed in
one model result. A successful read can continue to the end of the stored text
without refetching a mutable provider export or treating a prefix as the file.

## Where the code lives

- `packages/connectors/src/text-pages.ts`: UTF-8 page boundaries and private snapshot positions.
- `packages/connectors/src/types.ts`: the host-owned `ConnectorTextPages` capability.
- `packages/connectors/src/index.ts`: Google's type-aware readers, export validation, and refusal reasons.
- `apps/api/src/services/connector-text-pages.ts`: regional R2 snapshots scoped to Organization, conversation, Breakout, and connection.
- `apps/api/src/services/integrations.ts`: authorized store injection and historical tool-receipt surface reconstruction.

## How it works

Google's `drive.download`, `drive.export`, and `docs.read_document` return the
first text page directly. Only a multi-page result creates an immutable UTF-8
snapshot in `PAYLOADS`. Private continuation input holds its UUID and byte
position; the existing receipt authority exposes only `nextPageId` and `_next`
tools. Each page ends on a complete character, including multi-byte characters.

Before reading another page, the Google executor checks that the current
connection can still read the source file. It then reads an R2 byte range from
the original snapshot. Editing the provider file does not mix revisions within
one read. Starting a new first-page call selects fresh content.

Drive downloads use the native Docs reader for Google Docs and plain-text export
for native Slides. A Google Sheet
needs a tab and cell range, so the download refusal names
`sheets.read_spreadsheet` and `sheets.read_values`. Uploaded Word, Excel,
PowerPoint and PDF files use the existing document converter. Explicit exports
validate source type and requested format: plain text for Docs/Slides, CSV for
the first spreadsheet tab, or the existing metadata-only PDF response. CSV
results state their first-tab coverage. PDF responses do not fetch or return
binary content and do not prove a Google PDF export succeeded.

Known Google export reasons map to fixed messages naming `fileId` or `mimeType`
and a recovery action. Unrecognized reasons and provider messages stay out of
these diagnostics. Generic refusals retain their HTTP status when no known
reason or rejected argument is available.

## Invariants

- A page ID is receipt-owned and scoped to the conversation, principal,
  connection and operation by the existing pagination authority.
- Snapshot IDs never appear in model-visible tool results or first-page schemas.
- Reading a snapshot requires current connector authorization and provider file access.
- The snapshot is immutable; a continuation never re-exports the source.
- Source truncation by an existing converter or traversal bound remains explicit,
  separately from `hasMore`, which describes the stored text's remaining pages.
- Changed reads retain their execution-plan fence. Historical surfaces are
  reconstructed only for unchanged operations, preserving unrelated write receipts.

## Boundary

This is shared backend behavior for desktop, browser, and iOS agent execution.
There is no new renderer flow or per-call approval. The store is a trusted host
capability, not a public endpoint. Other connectors can adopt the text-page
primitive without acquiring Google-specific MIME or authorization logic.

## Failure modes and limits

Source ingestion and snapshot writes reuse `ATTACHMENT_MAX_SOURCE_BYTES` (8 MiB).
The existing Google text budget remains 128,000 bytes per page. No new numeric
limit or expiry is introduced. A source exceeding the source allowance still
fails; pagination does not make ingestion unbounded. Google's separate export
ceiling can still refuse a source before Rally reads it.

Snapshots are regional payload objects under the owning conversation's
`connector-text` prefix, with its Breakout and connection in the key. They have
no independent expiry. Payload retention/retirement must include this prefix;
an interrupted write can leave an unreferenced object, like tool replay output.
The store does not add a separate cleanup scheduler.

## Testing

- `pnpm --filter @rally/connectors exec vitest run src/google-file-text.test.ts src/pagination-adapters.test.ts src/index.test.ts`
  checks routing, format refusals, CSV coverage, Unicode boundaries, snapshot
  continuation, current Google access, and redacted provider reasons.
- `pnpm --filter @rally/api test:workers test-workers/connector-text-pages.test.ts`
  checks persistence and byte ranges against real R2, connection/Breakout
  isolation, and authority loss. The persistence test must fail if the snapshot
  write is dropped.
- `pnpm --filter @rally/api exec vitest run test/connector-tool-selection.test.ts test/tool-pagination.test.ts test/tool-schema-descriptions.test.ts test/connector-documents.test.ts`
  checks model-facing tool selection, first/next schemas, parameter descriptions,
  frozen receipt compatibility, and real Office conversion through the last text page.

## Changelog

### 2026-10-22 — Read exported files in pages and reject incompatible formats explicitly

**What changed:** Google file reads use receipt-owned text continuations and
regional immutable snapshots. Export validates file family and format, supports
first-sheet CSV, and reports known provider refusals with a field and remedy.

**Why:** Production contained spreadsheet exports requested as plain text,
opaque Google 400 errors, and successful exports rejected entirely by Rally's
128,000-byte model-result limit. The same budget was being asked to govern both
source ingestion and one model page, preventing the agent from reading later text.

**Considered and rejected:** Raising the model-result limit moves the same
failure and increases every result's context cost. Refetching on each page can
mix edits and repeats provider work. Returning a truncated prefix loses the
unread text. A new pagination store would duplicate receipt ownership that
already exists.

**Consequences:** Source reads reuse the established 8 MiB attachment allowance;
model pages retain 128,000 bytes. Later pages must recheck current Google access
and remain tied to their original snapshot. Snapshots inherit regional payload
retention and must be included in future payload-retirement changes.
