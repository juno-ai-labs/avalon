# Prepared conversations and session import

A prepared conversation is ordered user/assistant content with resolved file
references and trusted provenance. The same conversation authority materializes
it into a root work stream or private child. Starting an execution is a separate
choice. Importing a prior assistant answer never claims Rally executed it.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/substream-content.ts` | Source content/files, resolved prepared conversations, initialization modes and import provenance. |
| `apps/api/src/lib/firecrawl.ts` | Shared Firecrawl client, including uncached source capture. |
| `apps/api/src/services/session-import.ts` | Provider envelope decoding and visible message/file extraction. |
| `apps/api/src/services/session-import-files.ts` | Constrained file retrieval, unavailable outcomes, upload reconciliation and trusted attribution. |
| `apps/api/src/services/resource-service.ts` | Existing verified upload, staged R2 cleanup and resource creation. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Shared materialization, preparation receipts, file reservations, root/child publication. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Source-message checkpoint and update receipts owned by the Channel authority. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | Canonical fact preparation for ordered conversations. |
| `apps/desktop/src/main/claude-code-sessions.ts` | Read-only local Claude Code session listing and exact selected-file read. |
| `apps/desktop/src/main/local-claude-sessions.ts` | Claude desktop chat catalog, selected cached chat snapshots, and Cowork metadata-to-JSONL discovery. |
| `packages/agent-harness/src/evaluation.ts` | Scenario/checkpoint evaluation using the production Rally runtime. |
| `apps/desktop/src/renderer/components/new-workstream-menu.tsx`, `session-import-update-dialog.tsx` | Separate session selection, import, and explicit update controls. |

## How it works

The sidebar's single plus menu offers **Start New Channel**, **Import Channel
from Claude or ChatGPT**, and **Create New Space**. The import dialog requires
a Space, a Channel name, and a source. Sources are a shared conversation URL,
Claude chats and Cowork tasks found on this Mac, or one local Claude Code session
JSONL file. **Create** imports one selected conversation in one action. Only Spaces
the person may edit are offered, and the launcher stays disabled until the Space
directory is ready. Channel names stop at the server's 180-character limit.
There is no transcript preview.
Available attachments and artifact files are resolved automatically; missing file
references remain visible in the imported conversation. The source roles stay
intact; the byline says who imported them. The entered name is the settled
Channel title; provider content does not override the name the person chose.

Public links are acquired through the existing Firecrawl client using uncached
`rawHtml` output, with main-content filtering and base64-image removal disabled.
ChatGPT share HTML carries a reference table; Claude's public snapshot endpoint
returns JSON through the same acquisition primitive. Markdown is not a transcript:
it can contain only navigation even when the embedded conversation is present.
The service requires a successful source status and the expected final URL before
decoding; a successful scraper envelope can still contain a block or login page.
`FIRECRAWL_API_KEY` must be configured in the API environment.

Claude chat, Cowork, and Claude Code use different storage. Claude Desktop's
Chromium IndexedDB contains a cached chat catalog and sometimes a complete
conversation snapshot; its HTTP cache can hold other complete chat responses.
These are opportunistic local copies, not a durable account export. The picker
lists only catalog chats with a complete local snapshot in IndexedDB or the HTTP
cache. Selecting one reads the newest observed copy. A title cached without its
messages is omitted; reopening the chat in Claude can make it available. The desktop cache is read-only and no
account credentials or cookies are copied. Cowork stores separate `local_*.json`
metadata and a nested `.claude/projects/<project>/<cliSessionId>.jsonl` transcript.
Its metadata supplies the familiar title only when its JSONL exists; the JSONL is read only for the
selected task. Cowork JSONL uses the Claude Code event adapter, with the CLI
session ID as the stable re-import identity. Imported attribution says Claude
for both Cowork and Claude Code because the shared event provider does not
record which desktop surface produced the transcript. Local Claude Code sessions write
JSONL under `~/.claude/projects/<project>/`. The Claude app also shows cloud
Code sessions; they may have no matching local JSONL file, and this picker does
not import them. The import and update dialogs use selected local Claude chats;
the backend decoder still accepts account exports from programmatic callers.
The desktop lists local Claude Code session files on demand under the configured
Claude Code data directory. The person chooses one conversation from a dropdown;
menu labels show recognizable titles, shortening long ones through the middle
and showing a readable update date only when titles repeat. The selected title
is shown only in the dropdown; no second title line appears below it. The Claude chat list refreshes when its source is selected and
when Rally regains focus after the person visits Claude. A selected conversation
is reread at that point before it can be imported. Internal
file paths and session IDs never appear in the picker.
The main process reads only that selected transcript for import. A JSONL file
picker remains available when Claude Code discovery misses a session. A public
share URL identifies one conversation.
The update dialog resolves the Channel's recorded source identity automatically
and shows its title as read-only text. It offers no conversation dropdown:
another conversation would fail the source-identity check. If the original
Claude Code transcript is missing from local discovery, the person can choose
its file; the same identity check applies.
Only the person who imported the Channel sees the update action. The Channel's
creator identity is also the importer identity for this creation path; its
authority checks that identity before reading the source checkpoint or accepting
an update. Other Channel members can read the imported transcript and add their
own messages without gaining access to the import control.
The Claude Code adapter
follows the active JSONL parent chain, keeps visible user and assistant text,
combines consecutive assistant fragments, and omits tool calls, tool results,
thinking, compaction and sidechain events. It uses the transcript's latest custom
title, then its latest generated title, when available.
It does not read session credentials, project files or tool-result sidecars.

There are three separate boundaries:

1. **Decode source content.** Provider adapters identify the selected conversation,
   visible text, embedded bytes and recognized file descriptors. Unknown visible
   content is an error, not permission to omit part of a conversation. Tools,
   thinking and compaction remain absent from the transcript.
2. **Resolve content.** Preview freezes successful remote downloads as bytes and
   records unavailable outcomes. Import stores bytes through `ResourceService.upload`,
   which checks existing size policy, verifies MIME, hashes bytes, stages R2 cleanup
   and creates workspace-owned resources. Stable operation/file identities make
   retries reconcile the same upload. Importer identity comes from authentication.
3. **Materialize a conversation.** The authority prepares canonical facts, reserves
   resource drafts and commits all turns and relationships with its publication
   fence. Root creation and private-child initialization use the same preparation
   and commit operations. The latter runs before the parent publishes readiness.

`ConversationInitialization` distinguishes `prompt` and `history`. Normal opening
messages retain their existing execution path. `createPrepared` accepts content
without an empty opening-message field at its caller boundary. The internal
compatibility adapter still carries legacy opening fields for existing creators.
A history stream starts idle and has no run. A caller can subsequently submit an
ordinary message to start execution, including after preparing a private child.

Demo pack creation has an explicit `execution: history` mode for prose. It uses
`createPrepared` and verifies canonical turns rather than waiting for an invented
run. The decision-memo opening exercises that path. Scripted tool/elicitation
scenarios continue through ordinary production executions.

First continuation reads the complete canonical transcript, including attachment
manifests for both source roles. Historical image bytes are not replayed into the
model. Existing authorized file tools retrieve stored resources when needed. The replay layer imposes no separate message-count or serialized-byte ceiling.
The first continuation must still fit the selected model: automatic compaction
starts only after a completed provider turn supplies usage, and cannot rescue an
oversized first request. Import never silently truncates the canonical history.

### Evaluations

`runRallyEvaluation` accepts either a prepared scenario or a settled Rally
checkpoint. The host restores executable configuration and an isolated environment;
Rally uses the same `runHarnessWithBind` assembly, plugins, authorization hooks,
provider routing and tool handling as production. There is no separate eval loop.

Bind owns checkpoint validation, boundary advancement, budgets, transcript state,
forking and reply/wake input. Rally captures its flat projection and capability
activation hints alongside each Bind checkpoint. Eval forks require a fresh host
loop identity and rebase Rally reservation identities, preserving settled provider
messages. A checkpoint after a tool result resumes after that result instead of
repeating the tool effect. Host bindings remain the host's responsibility: callers
must restore the corresponding tool environment and persistence, not merely messages.
This provides an executable eval seam, not a scheduler or scoring database.

## Invariants

- Imported history never creates fake runs, tool receipts or artifact deployments.
- Canonical turns, attachment relationships and preparation completion commit together.
- Draft holds have a durable owner: either a pending live input or a prepared
  conversation. Definite failed preparation releases holds; ambiguous responses
  remain recoverable under the same preparation identity.
- Source request identity is hashed separately from materialized importer snapshots.
  The preparation receipt freezes materialized content across retries.
- One unchanged form attempt retains its create identity after an uncertain
  response; changing its name, Space, or URL starts a new identity. Placement
  is creation semantics and stays out of the imported-content identity hash.
- Uploaded user files and assistant artifact bytes use the existing resource authority.
- Unavailable files remain readable references, never fake downloadable resources.
- Extracted document text is a separately named text file; the original reference remains.
- Source links do not authorize arbitrary downloads or credential forwarding.
- Bind owns settled execution state; Rally owns conversation facts and host restoration.

## Boundary

Public APIs are `POST /workstreams/import/preview`, `POST /workstreams/import`,
`GET /workstreams/:id/import/source`, and `POST /workstreams/:id/import/update`.
Clients can provide source content, not another importer's identity. Prepared
conversation installation is an internal coordinator operation; the private-child
receipt and conversation creator authorize it. An existing Channel accepts only
updates to its recorded source session, not a new bulk import.

### Re-importing a continuing source

Re-import is an explicit action on the Channel created from a source. It does
not require automatic polling. The Channel keeps a source identity and a
checkpoint of source message identities and their content revisions, separate
from its canonical transcript cursor. Claude Code supplies a session ID and
event UUIDs; its consecutive assistant fragments need one stable group identity
for the visible message. A Claude account export supplies a conversation ID and,
when present, message IDs; an adapter must derive stable identities for visible
messages without IDs. A local file path is a way to acquire bytes, not the
durable identity of a conversation. The person can select the source again when
asking for an update.

The importer compares the new source snapshot with that source checkpoint,
never with the Channel's last turn. An unchanged source message is a no-op; a
checkpoint read before file preparation skips uploads for unchanged messages,
and the authority rechecks that checkpoint in the commit transaction. A
new source message is appended at the Channel's current tail, after any Rally
messages already committed there. A changed source message, including a Claude
reply that was still growing at the first import, is appended as a clearly
attributed update that names the source message it supersedes. The reader should
see which version is current rather than two apparently independent replies.
Previously committed Rally turns and imported facts are not rewritten. Source
deletions or a changed visible-message order return a named branch-change
conflict; the person can import that branch into a new Channel. This allows a
Claude session to continue after somebody has also continued the Rally Channel.

One authority-owned transaction must commit the new canonical turns, source
checkpoint, and idempotency receipt together. Repeating the same snapshot then
adds no turns, including after an uncertain response. As with initial import,
these are historical user/assistant messages and do not start a Rally run or
claim that Rally authored a source reply. The Bind projection has a distinct
`protocol_history_appended` transition, so the next Rally run reads imported
assistant turns as source history. Re-import does not reuse the creation-only
`createPrepared` operation or compare the source against the entire destination
transcript.

The source freezes during submission. Resolved content and request identity are retained
for retries after an uncertain response; editing the URL, selecting another file or
conversation starts a new request. The decoding API continues to support JSON/JSONL
exports for programmatic callers.

Source files are inline UTF-8/base64, recognized HTTPS downloads, or explicitly
unavailable references. Known Claude image/document blocks (including plain-text
document sources), artifact documents and
full-content Write/artifacts tool payloads preserve file content without importing
the tool invocation. ChatGPT exports preserve attachment descriptors and image
references. Final tool-authored image outputs become assistant artifact turns;
hidden/intermediate copies, tool-directed calls, thoughts, reasoning recaps and
model-editable context are omitted. Unknown visible content still fails closed.
Claude snapshot file counts preserve a missing-file notice even when descriptors
are hidden; explicitly truncated messages are rejected. Source sandbox and sediment
references without bytes remain unavailable.

## Failure modes and limits

Provider share formats are not stable APIs. Firecrawl fetched the tested ChatGPT
share that Cloudflare Browser Run blocked, and fetched Claude snapshot JSON. This
is not a guarantee that every future share is accessible. Claude Code URLs require
login and remain unsupported by the URL-only dialog.
Expired/private file URLs, absent export bytes and unsupported download origins
remain unavailable and are recorded in the imported transcript.

Downloads refuse redirects and use the existing workspace `MAX_ATTACHMENT_BYTES`
policy while streaming. File uploads retain the same policy. Prepared histories
have no additional guessed size ceiling, but HTTP, memory, SQLite and provider
context limits still apply. Full canonical replay is paged but assembled in memory;
An oversized first provider request can fail before automatic compaction is available. A source export containing multiple
conversations must be split before import.

HTML/code artifacts remain stored files; importing does not launch a site. Exports
that contain only patches, inaccessible sandbox paths or proprietary artifact state
cannot reconstruct original files automatically.

## Testing

- `test/session-import.test.ts`: provider branches, one-record JSONL, visible-format
  refusal, attachment-only messages, embedded artifacts and extracted-text labeling.
- `test/session-import-files.test.ts`: constrained origins, redirect refusal,
  frozen download bytes and the existing file size policy.
- `test-workers/conversation-creation.test.ts`: real upload/R2 bytes, role-specific
  attachments, failed reservation cleanup, idempotent creation, explicit re-import
  after Rally turns, source revision, and provider continuation with history.
- `test-workers/substream-creation-runtime.test.ts`: private-child materialization,
  publication and conflicting replay.
- `test-workers/workspace-draft-attachment-reservation.test.ts`: existing draft holds
  and canonical projection release.
- `packages/agent-harness/src/evaluation.test.ts`: production runtime from an initial
  scenario and serialized tool-settled checkpoint, with no repeated write after fork.
- Desktop menu/launcher/transcript tests cover navigation and attribution. Real
  Electron visual QA covers session selection and update controls
  using a fixture API; backend lifecycle tests provide storage/execution evidence.

## Changelog

### 2026-09-23 — Import local Claude sessions and update their source history

**What changed:** The desktop lists local Claude chats, Cowork tasks, and Claude
Code sessions with recognizable titles, then reads only the selected transcript.
The Claude chat picker requires a complete IndexedDB or HTTP cache snapshot;
Cowork requires a local JSONL transcript. It refreshes when Rally regains focus,
shortens long menu labels, and omits internal IDs and duplicate title text. The
account-export choice was removed from creation and update. A Channel records source message
IDs and revisions in its own SQLite transaction and offers an explicit update.
The update dialog matches that recorded source automatically and displays its
title without a conversation selector. The import control and update authority
are limited to the original importer.
New or revised source turns append after any Rally turns, with replay receipts
and a Bind history transition for imported assistant replies.

**Why:** A file picker missed the chats and tasks people recognize in Claude,
while a cached title without messages led to a selection that could never import.
Showing an export file beside a selected local chat also made the update dialog
look as though both inputs were required.
Offering other conversations in the update dialog implied they could replace
the original source, even though the Channel rejects a different source.
Other Channel members may lack the original source on their Macs, so showing
them an unusable update control would be misleading.
Source sessions can also continue after a Rally Channel has received its own
messages; comparing against the Channel tail would duplicate or reject valid
source updates. Selecting one conversation and keeping a separate source
checkpoint makes both operations explicit and repeatable.

**Considered and rejected:** Automatic polling and the Claude account's
unpublished authenticated API. Local cache snapshots and JSONL files are
inspectable, user-selected sources; the Claude Code JSONL file picker remains a
fallback when discovery misses a session.

**Consequences:** Claude's undocumented cache remains an opportunistic source,
so a title alone never qualifies for the picker. An existing export-backed Channel
can update through the dialog when the same conversation is available locally;
the export decoder remains available to programmatic callers. The source's
historical branch is append-only in Rally: deleting or
reordering prior source messages requires a new Channel, and a revised message
is marked as superseding the earlier turn. Cloud Code sessions without a local
file cannot be selected from the local picker.

### 2026-09-22 — Import selected local Claude and Claude Code files

**What changed:** The sidebar import launcher accepts a Claude account export's
`conversations.json` with one selected conversation, or a single Claude Code
JSONL transcript. Claude Code has a distinct source label and text-only decoder.

**Why:** A share link is unavailable for private Claude chats and local Claude
Code sessions. Claude chat and Code use different storage, so one generic JSON
decoder would misread Code's tool and streaming events as conversation turns.

**Considered and rejected:** Reading Claude Desktop's Chromium profile or Claude
Code's complete project tree automatically. Those locations include app state,
credentials, tool output and unrelated files; choosing one source file makes the
import boundary and resulting Channel explicit.

**Consequences:** Claude account exports must be unpacked before selecting
`conversations.json`; this flow imports one conversation per Channel. Claude Code
transcripts omit execution artifacts and sidecars.

### 2026-09-20 — Put imports in the unified sidebar launcher

**What changed:** Import now collects its required Space, Channel name, and URL
from the sidebar's one creation menu, and sends the chosen Space and settled name
through the existing prepared-history creation path. The menu waits for a
writable Space directory, retains one request identity across an unchanged
retry, and surfaces the API's actionable import refusal.

**Why:** Space- and row-local plus buttons made creation depend on where somebody
happened to be looking, while an import created into General and renamed itself
from provider content. One launcher makes the destination and visible name
explicit without changing prepared-history authority or fabricating a run.

**Considered and rejected:** Keeping the query-parameter import dialog as a
second UI. It had no producer after consolidation and would preserve different
required fields and retry behavior for the same operation.

**Consequences:** Desktop imports begin only in the sidebar launcher and retain
one request identity while its Space, name and URL remain unchanged. Programmatic
export callers keep the same API boundary without acquiring a second desktop UI.

Shipped in #876.

### 2026-09-15 — Compose prepared content, resources and execution

**What changed:** Root/private creation and text-only demos share authority-owned
materialization. Imports preserve available files and explicit unavailable references.
Firecrawl source acquisition preserves structured payloads that Markdown loses;
provider adapters filter internal events and retain visible generated-image turns.
The URL-only dialog imports directly and reuses background naming from canonical
history, avoiding an additional preview or manual naming step.
Prepared receipts own content and draft reservations. Evals reuse Rally's production
Bind runtime and capture both Bind state and Rally projection/activation bindings.

**Why:** A text-to-model field rename did not share actual creation behavior.
Inferring execution from an optional import field, dropping files and wrapping Bind
checkpoint exports left each next consumer to invent lifecycle and restoration.
Live testing also showed Cloudflare Browser Run blocked by ChatGPT and Firecrawl
Markdown losing the transcript despite raw HTML containing it; raw acquisition
and explicit source decoding preserve both access and message fidelity.

**Consequences:** Publication remains with the destination authority, resources remain
with WorkspaceDO/R2, and execution remains with Bind. Source decoding and file
retrieval cannot grant identity or execution authority. Eval hosts must restore an
isolated environment and allocate fresh fork identities.

**Considered and rejected:** Replaying history as scripted model executions,
fabricating generated-resource receipts, separate eval loops and merely raising
canonical replay ceilings would misrepresent provenance or duplicate ownership.
