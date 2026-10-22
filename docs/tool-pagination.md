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

Sidekick connector continuations privately retain the actual serving account,
which may differ from the requested plugin's original owner. Their stored input
uses an envelope containing provider arguments and host account metadata; the
wrapper still accepts older unwrapped argument rows. Redemption carries the
saved account into execution and refreshes its current delegation. It cannot
reinterpret a provider cursor through another person's connection after a
fallback. The public schema remains `{ pageId }`.

## Invariants

- Page IDs match the conversation, principal, connection and operation, not
  the run: a later message's run can redeem a page an earlier run issued.
  Copying an ID to another scope cannot select that scope's credentials or
  arguments. Consume-once holds across runs, because the claim is recorded on
  the page's own row; forward-cycle detection follows one run's chain.
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
X, resource list/read/search/summary, table query, and the conversation tools'
list and read (prefix `conversation`, [`conversation-tools.md`](conversation-tools.md)). Dynamic hosted MCP routes
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
model-facing schemas retain only the new pagination instructions. Operations introduced after
the cutover are excluded from that historical surface; adding a tool must not
invalidate receipts for unchanged operations.

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
These failures tell the caller to restart or use the completed page's next ID,
naming the first-page tool; storage cannot, so the wrapper writes that text.
For a page another receipt holds (consumed or in progress), storage returns the
refusal and the page's stored arguments without writing, and the tool's optional
`continuationDetails` names what it reads (`resourceId`
for a resource read) in the failure details. The attachment grounding guard
needs that identity: a later run has no memory of the page, and an anonymous
failure is never cleared by a later successful read.

A claim tries the current run by primary key, then earlier runs. The second
lookup is a deliberately unindexed scan of the conversation's pages, run only
when the first misses; an index on `page_id` would add a write to every issue.
IDs are unique per run only (about 1.07 billion per prefix), so an ID two
earlier runs share is refused as `page_id_invalid` rather than guessed.

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
IDs last as long as the producing receipt and run rows; underlying provider
cursors can expire sooner, and the executor reports that as its own failure.
Missing or changed durable producer results fail rather than silently
rebinding a published ID to different arguments.

## Testing

`pnpm --filter @rally/api test:workers test-workers/tool-receipt-authority.test.ts`
drives the wrapper and receipt endpoint through real workerd, including eviction,
producer completion, scopes, competing claims, retries, and forward cycles. It
does not invoke inference. Eviction expires the former isolate's lease; the test
explicitly models acquiring it again before redeeming a persisted page. It also
checks that a Sidekick's serving account survives eviction and is carried into
the next provider operation, independently of the coordinator's principal.

`packages/connectors/src/tool-pagination.test.ts` proves exact extraction before
bounding and preservation of cursor-named document content.
`pagination-adapters.test.ts` enumerates all authored pagination declarations and
executes both first and continuation calls against provider HTTP doubles.
Existing connector, attachment, table, tool-selection, grounding and receipt suites cover the original
authorized executors. `workstream-object-schema.test.ts` covers migration shape.

## Changelog

### 2026-10-22 — Retain the serving Sidekick account with each continuation

**What changed:** Private continuation arguments carry the host-selected
account. Redemption restores it into tool context; older argument-only rows
remain readable. Existing receipt ownership, consume-once and cycle rules stay.

**Why:** After a known resource succeeds through another delegate, sending its
cursor back to the requested plugin's original account changes what the cursor
means. A model page ID must continue the same account's result.

**Considered and rejected:** Asking the model to copy account IDs with every
page, replacing the public page-ID protocol, or mounting multiple credentials.
The existing durable private arguments can retain the serving identity.

**Consequences:** Delegation is checked again at execution; withdrawal can block
a continuation, and never redirects it to another account. Account metadata
contains no credentials or provider cursors.

### 2026-10-19 — Exclude new operations from the historical surface

Adding Google's availability query changed the reconstructed pre-pagination hash
and would invalidate existing receipts for unchanged Google operations. The
reconstruction now excludes that post-cutover operation before hashing, while
current tool registration still exposes it. Replacing the frozen expected hash
was rejected because it would conceal the compatibility break rather than fix
it; future post-cutover additions must extend the exclusion recipe and preserve
the independently frozen hashes.

### 2026-10-18 — Scope page IDs to the conversation, not the run

The earlier fix below explained an earlier run's page instead of refusing it,
but each reuse still cost a failed call and another model turn, because the
model sees every earlier `nextPageId` in its history and copying one is its
natural move. Use-once and cycle detection, the reasons pages were run-scoped,
protect one run's chain and did not need the ID to die with the run, and
redemption re-runs the authorized executor, so scope beyond principal,
connection and operation added no safety. Claims now fall back to earlier runs
and record the consumer on the page's own row, which keeps use-once and the
receipt dependency across runs; `explainEarlierRunPage` was removed as dead.
Use-once across runs makes a consumed earlier page the new stale case, so its
refusal carries the resource identity through `continuationDetails`; without it
the grounding guard reproduced the original false boundary one page later.
Copying earlier pages into the current run was rejected: `UNIQUE(producer_id,
slot)` forbids a second row, and a copy would split use-once across rows.
Making IDs unique per conversation was rejected as a scan on every issue; a
shared ID is refused instead. A future change that prunes runs must expect a
later run to hold a claim on the pruned run's pages.

### 2026-10-18 — Say when a page ID came from an earlier message

A thread's reply was replaced by "Attachment content unverified" although the
agent had read the attachment. On a new message the model copied the previous
run's `nextPageId`; the claim refused it as `page_id_invalid` ("not available for
this operation and run"), which reads as a mistyped ID and named no tool. The
model guessed `startCharacter` offsets and read the resource, but the failure
carried no resource, so the grounding guard never cleared it. Storage now tells
an earlier run's page apart from an unknown one and the tool explains it from the
stored continuation, so the model gets the exact resuming call and the guard gets
the resource. Redeeming earlier-run pages was rejected: it breaks the run-scoped
consume-once and cycle checks this document's invariants rest on. Clearing
anonymous failures after any later read was rejected for the reason in
[`agent-attachments.md`](agent-attachments.md). A future paginated tool whose
continuation names a position should implement `explainEarlierRunPage`, and
must re-check whatever fenced the original continuation (for reads, the
derivative version) before offering an unfenced position.

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
