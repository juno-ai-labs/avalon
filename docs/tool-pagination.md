# Authored tool pagination

Rally-authored tools keep opaque continuation tokens on the server. Models start
with a normal list, search, or read call, then use its `_next` companion with
only `{ pageId }`. A result's `nextPageId: null` is the end of the sequence.
Hosted MCP and other pass-through tools retain their provider-defined contracts.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/tool-pagination.ts` | Private executor continuation contract. |
| `packages/connectors/src/tool-pagination.ts` | Explicit provider-field extraction, before content bounding. |
| `apps/api/src/services/tool-pagination.ts` | First/next schemas, result projection, and continuation redemption. |
| `apps/api/src/durable-objects/tool-page-storage.ts` | Durable aliases, claims, and chain checks. |
| `apps/api/src/durable-objects/workstream-tool-receipt-storage.ts` | Current attempt and executing-receipt fence around page operations. |
| `apps/api/src/services/integrations.ts` | Authored-only registration, connection prefixes, and attachment grounding. |

## How it works

An authored definition declares its private cursor argument. Its executor returns
public output separately from a `pagination.continuations` array. Each entry
names the canonical operation, validated continuation arguments, and an explicit
output slot. There is no traversal looking for fields named `cursor`, and no
replacement of matching strings in arbitrary provider content.

The wrapper strips the cursor argument from the first-call schema and adds an
`_next` tool accepting only `pageId`. It replaces the declared slots with
server-issued aliases such as `google_2_quiet_amber_rapid_otter`. The prefix is
the connection's stable plugin wire name, or `workstream` / `table` for built-ins.
The four words reuse Rally's frozen word lists. A unique constraint detects
collisions and allocation retries; a slug is a lookup key, not a credential.

The owning SubstreamAgent stores the opaque arguments beside its tool receipts,
not in D1, a connector instance, model context, or an in-memory map. Issuance is
unique per producing receipt and output slot. A page becomes usable only when
that receipt completes. Claims are fenced synchronous transactions. An executing
consumer excludes other receipts; a completed consumer permanently consumes the
page; a failed or deleted consumer permits retry. Deleting a consumer clears
its claim rather than deleting another receipt's page. Resuming the same receipt is idempotent.
Existing receipt replay supplies completed results without another provider call.

Resource reads also expose `previousPageId` through `read_resource_previous`.
Search passages and summary citations expose `readPageId`, accepted by
`read_resource_next`. Resource version and expiry validation stays in the existing
attachment executor. New attachment continuation state is private JSON, without
HMAC signing or an artificial expiry; the old signed-token decoder remains only
for pre-cutover receipts. Table queries retain their data-revision validation.

## Invariants

- Page IDs match the run, principal, connection and operation. Copying an ID to
  another scope cannot select that scope's credentials or arguments.
- Redemption invokes the original authorized executor, so possession of a slug
  never replaces current authorization.
- Raw cursors are extracted before response truncation. Otherwise a valid
  provider continuation would be silently damaged before being stored.
- A result's slots are explicitly authored. User content containing a field
  named `cursor` remains content.
- A forward continuation cannot repeat an ancestor's operation and arguments.
  Otherwise freshly generated IDs could conceal a provider pagination cycle.
  Backwards navigation and independent searches are not treated as cycles.
- Page ownership follows receipt state, rather than a second completion flag
  that could disagree after a crash. Run/producer deletion cascades to its pages.
- Issued pages and consumer claims are receipt dependencies: a completed read
  with either cannot be rebound to different arguments at the same call coordinate.
  Otherwise published aliases could silently refer to a repurposed receipt.

## Boundary

This covers Google, native Slack, Linear, workspace Notion, workspace Granola,
X, resource list/read/search/summary, and table query. Dynamic hosted MCP routes
are excluded even when they share a connector name with a native adapter.
Numeric offsets and bounded non-pageable reads are unchanged. Linear's bounded
embedded comments/teams retain `hasNextPage` without advertising an unusable token.

Provider argument schemas remain internal execution contracts. Public first/next
schemas are materialized during tool loading, including the Sidekick authoring
catalog. Stored old attachment receipts remain readable by grounding and version
dependency checks. Old model-authored cursor calls are not silently translated:
the new schema rejects them, and the model must start a new first-page call.
Unchanged operations recognize the plugin's pre-expansion surface hash so a
pagination-only change does not invalidate unrelated write receipts. Changed
pagination operations deliberately retain their execution-plan fence: old raw
cursor results are not declared interchangeable with page-ID results.
Because input-schema descriptions participate in that digest, the private
compatibility recipe restores the old prose for each changed connector field.
Frozen hashes from pre-cutover definitions test this independently of the recipe;
model-facing schemas retain only the new pagination instructions.

## Failure modes and limits

Before accessing storage, companion tools require only a string `pageId` with
their exact plugin/connection prefix and exactly four lowercase words separated
by underscores. The execution validator and harness validation hook share the
same check. Errors name `pageId` and explain which result field to copy, that
IDs must not be invented or repaired, that null means stop, and which first-page
tool to call when no ID is available. They never echo rejected values. Matching
the format does not prove issuance or scope; the receipt authority checks those.

Unknown, wrong-scope, or uncommitted IDs fail with `page_id_invalid`; completed
and concurrent consumers produce `page_already_consumed` and `page_in_progress`.
These failures tell the caller to restart or use the completed page's next ID.
A repeated forward continuation instead returns the fetched content with
`nextPageId: null` and a `paginationWarning` that coverage may be incomplete.
It neither discards the fetched page nor presents a provider loop as proof of
exhaustive coverage. Issuance permits a cancellation request that arrived during
the provider call, like receipt completion; claims still refuse new cancelled work.
Known page failures cross RPC as named object-port errors; provider schema
failures identify declared fields without exposing rejected data. Existing provider,
attachment version and table expiry/version failures are preserved. Failed reads do not
consume their incoming page, so transient failures can be retried.

There is no new arbitrary page count, timeout, or general repeated-failure breaker.
IDs last with the producing receipt/run; underlying provider cursors can expire
sooner. Missing or changed durable producer results fail rather than silently
rebinding a published ID to different arguments.

## Testing

`pnpm --filter @rally/api test:workers test-workers/tool-receipt-authority.test.ts`
drives the wrapper and receipt endpoint through real workerd, including eviction,
producer completion, scopes, competing claims, retries, and forward cycles. It
does not invoke inference. Eviction expires the former isolate's lease; the test
explicitly models acquiring it again before redeeming a persisted page.

`packages/connectors/src/tool-pagination.test.ts` proves exact extraction before
bounding and preservation of cursor-named document content.
`pagination-adapters.test.ts` enumerates all authored pagination declarations and
executes both first and continuation calls against provider HTTP doubles.
Existing connector, attachment, table, tool-selection, grounding and receipt suites cover the original
authorized executors. `workstream-object-schema.test.ts` covers migration shape.

## Changelog

### 2026-09-16 — Move cursor handling out of model-authored arguments

Opaque provider tokens and attachment cursors repeatedly caused invented values,
mixed filters, and non-progressing reads. First/next tools now store continuations
in the receipt-owning SubstreamAgent and expose plugin-prefixed word aliases.
Longer prompting was rejected because it leaves the same error-prone contract;
generic JSON replacement was rejected because field names do not establish
ownership. Future adapters must explicitly declare continuation extraction and
must leave pass-through tool schemas and results unchanged.
Exact-prefix validation and plain-language recovery instructions prevent malformed
aliases from reaching storage without leaving smaller models to interpret regex
errors or guess replacement IDs.
Returning fetched content with an explicit coverage warning was chosen over
throwing on repeated provider cursors, which made a safe retry repeat the loop.
Continuation ownership also replaces new attachment cursor signing/expiry;
legacy decoding is retained for stored receipts, not for new model arguments.
