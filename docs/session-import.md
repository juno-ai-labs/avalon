# Prepared conversations and session import

A prepared conversation is ordered user/assistant content with resolved file
references and trusted provenance. The same conversation authority materializes
it into a root work stream or private child. Starting an execution is a separate
choice. Importing a prior assistant answer never claims Rally executed it.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/substream-content.ts` | Source content/files, resolved prepared conversations, initialization modes and import provenance. |
| `apps/api/src/services/session-import.ts` | Provider envelope decoding and visible message/file extraction. |
| `apps/api/src/services/session-import-files.ts` | Constrained file retrieval, unavailable outcomes, upload reconciliation and trusted attribution. |
| `apps/api/src/services/resource-service.ts` | Existing verified upload, staged R2 cleanup and resource creation. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Shared materialization, preparation receipts, file reservations, root/child publication. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Source-message checkpoint and update receipts owned by the Channel authority. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | Canonical fact preparation for ordered conversations. |
| `apps/desktop/src/renderer/lib/browser-conversation-import.ts` | The readers that run inside a ChatGPT or claude.ai page: own and shared conversations, and their files. |
| `apps/desktop/src/renderer/screens/browser-import.tsx` | The import window: Import, and the name-and-Space sheet. |
| `packages/agent-harness/src/evaluation.ts` | Scenario/checkpoint evaluation using the production Rally runtime. |
| `apps/desktop/src/renderer/components/new-workstream-menu.tsx`, `session-import-update-dialog.tsx` | The menu item that opens the import window, and the explicit update control. |

## How it works

Every import goes through Rally's own browser. The sidebar's plus menu offers
**Start New Channel**, **Import Channel from Claude or ChatGPT**, and **Create
New Space**; the import item opens the [import window](embedded-browser.md),
and only the desktop host, which has that browser, offers it. Right-clicking
empty space in a Space's channel list opens the same menu without **Create New
Space**; from there both the channel form and the import sheet are locked to
that Space (`spaceLocked` in the import window's context). The Spaces rail does
the same with **Create New Space** alone. The person opens
a conversation in the window — their own, signed in, or a shared link — and
clicks Import. A sheet asks for the Space and a Channel name, prefilled with the
conversation's title; only Spaces the person may edit are offered, and names
stop at the server's 180-character limit. There is no transcript preview.
Available attachments and artifact files are copied automatically; missing file
references remain visible in the imported conversation. The source roles stay
intact in the visible transcript; the byline says who imported them. The model
receives imported source text as labeled, overheard context. The entered name
is the settled Channel title.

Rally does not read conversations from the Mac's files or fetch shared links
server-side. People are asked to open a shared link in the import window
instead, where it reads the same way as their own conversations.

`lib/browser-conversation-import.ts` owns the readers. Each runs inside the
visited page, in its own origin and session, and recognizes one route:

| Route | Read |
| --- | --- |
| `chatgpt.com/c/<id>` | ChatGPT's conversation endpoint, with the access token from the page's same-origin `/api/auth/session`. A cookie-only request can return a guest 404 even when the page is signed in. |
| `chatgpt.com/share/<id>` | The same conversation JSON from the anonymous share route, `/backend-anon/share/<id>`; its files come from the anonymous counterparts of the routes below, addressed by the share. Works signed out. |
| `claude.ai/chat/<id>` | The conversation from the organization named by the page's `lastActiveOrg` cookie, falling back to each organization the account lists. The response holds every edited branch, so the reader keeps only the path from `current_leaf_message_uuid` back through `parent_message_uuid` — the conversation the person sees. |
| `claude.ai/share/<id>` | The share's snapshot from claude.ai's `chat_snapshots` endpoint. |

A failure the reader recognizes returns its own message as a value, because
Electron replaces an error thrown by page script with a generic one. The readers
are page script held in template literals, so a backslash must be doubled to
reach the page; a test parses each generated script.

**Files are copied, not linked.** The conversation names its files; the reader
fetches their bytes while the page is signed in and hands them to the decoder
beside the reference they belong to:

- ChatGPT uploads and generated images come from ChatGPT's file download, only
  for messages the transcript shows — a code run's working files are skipped.
  A signed download link on another origin is fetched without cookies: it needs
  none, and the browser refuses a cross-origin read that sends them.
  A file ChatGPT wrote in its code sandbox, offered as a `sandbox:` link, comes
  from the same download ChatGPT's link uses; the dead link then reads as its
  label beside the attached file.
- A shared claude.ai conversation hides its attachments from viewers: the
  snapshot reports a file count and no files, and imports a notice saying so.
  Opening the person's own conversation instead imports them.
- claude.ai uploads come from the conversation's file sandbox, where claude.ai
  keeps each upload's original, accepted only when its size is the recorded one.
  A chat without a sandbox falls back to a PDF's original link, then an image's
  full-size preview, named for its real format.
- A published claude.ai Artifact is copied at its current version — claude.ai
  serves no other — once, where the conversation first shows it. Its own files
  are listed by claude.ai and served from the Artifact's host, which the page may
  not read, so they are loaded through the tab's DevTools network loader with the
  tab's session. That is the one place a credential leaves the page: the
  Artifact's short-lived, per-Artifact asset token passes through the import
  window's renderer to address those files. The Artifact type's shared runtime
  is not copied. Without its files, a card imports as the Artifact's link.
- Files Claude wrote with its file tool, visuals it drew, and a Research report
  import as files; a write the tool refused, and drafts written into an
  Artifact's publishing folder, do not.

Anything the reader cannot fetch, or declines as larger than the attachment
limit, stays an unavailable reference that the import reports on the message.

The decoders drop what the providers show only as process: thinking, reasoning
recaps, tool calls and results, ChatGPT agent progress notes (the `commentary`
channel, shown only in its collapsed work log), and claude.ai's `token_budget`
blocks. ChatGPT link and citation markers become the Markdown their
`content_references` give, and claude.ai web citations become an inline
`([host](url))` after the span they support. A ChatGPT Deep Research report,
which the page shows in an embedded frame, is a complete message in the tool
result's widget state and imports as an assistant message where it appears.
A titled file is named with the extension its type opens with.

The API accepts a private or shared route as the source URL, a private one only
when its id equals the decoded conversation's. The source URL and conversation
ID are recorded so source updates can reread them and preserve Rally messages
added to the Channel: the update dialog reads a tab already showing the
conversation, or opens one on the recorded URL in the main window's browser,
reads it, and closes it. Website sign-in lives in the account partition, so
that read works once the person has signed in anywhere in Rally's browser.
Only the person who imported the Channel sees the update action, and only for a
source the browser can open again. The Channel's creator identity is also the
importer identity for this creation path; its authority checks that identity
before reading the source checkpoint or accepting an update. Other Channel
members can read the imported transcript and add their own messages without
gaining access to the import control. Imports created before source checkpoints
were introduced, and Channels imported from local Claude Code files before
importing moved to the browser, remain readable but have no update control.

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
run. The Acme proposal opening exercises that path. Scripted tool/elicitation
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
- One unchanged import attempt retains its create identity after an uncertain
  response; reading the conversation again starts a new identity. Placement
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
from its canonical transcript cursor. Each provider supplies a conversation ID
and message IDs; a visible message without an ID uses its position within that
identified conversation.

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
overheard `protocol_user_appended` transition, so the next Rally run reads both
source roles as labeled context. Revisions identify the newer source version
without giving provider text instruction authority. Re-import does not reuse the creation-only
`createPrepared` operation or compare the source against the entire destination
transcript.

The source freezes during submission. Resolved content and request identity are retained
for retries after an uncertain response; reading the conversation again starts a new request.

Source files are inline UTF-8/base64, recognized HTTPS downloads, or explicitly
unavailable references. Known Claude image/document blocks (including plain-text
document sources), artifact documents and full-content `artifacts` tool payloads
preserve file content without importing the tool invocation. ChatGPT exports preserve attachment descriptors and image
references. Final tool-authored image outputs become assistant artifact turns;
hidden/intermediate copies, tool-directed calls, thoughts, reasoning recaps and
model-editable context are omitted. Unknown visible content still fails closed.
Claude snapshot file counts preserve a missing-file notice even when descriptors
are hidden; explicitly truncated messages are rejected. Source sandbox and sediment
references without bytes remain unavailable.

## Failure modes and limits

Each reader depends on its provider's unofficial web API and page format, and
fails with the provider's name when one changes; the decoders fail closed on
unknown visible content rather than omitting it. Sign-in, CAPTCHAs, and provider
policy can still prevent a read. Expired or refused file downloads and
unsupported origins remain unavailable and are recorded in the imported
transcript.

The reader downloads each file only up to `MAX_BROWSER_IMPORT_FILE_BYTES`, the
same 25,000,000 bytes as the upload limit (`MAX_ATTACHMENT_BYTES` in
`wrangler.global.jsonc`; keep them equal). It checks a size the provider reports
before downloading, a declared length before reading, and the body as it
arrives; a larger file imports as unavailable, saying so. The total across one
conversation's files is not separately bounded: each file is within the limit,
but a conversation with many large files is held in memory together. Prepared histories have
no additional guessed size ceiling, but HTTP, memory, SQLite and provider
context limits still apply. Full canonical replay is paged but assembled in
memory; an oversized first provider request can fail before automatic
compaction is available.

HTML/code artifacts remain stored files; importing does not launch a site.

## Testing

- `test/session-import.test.ts`: provider branches, private and shared source
  URLs, visible-format refusal, attachment-only messages, copied uploads and
  Artifacts, sandbox files, Deep Research reports, citations and extracted-text labeling.
- `apps/desktop/src/renderer/lib/browser-conversation-import.test.ts`: route
  recognition, reads through a tab, and that each generated page script parses.
- `test/session-import-files.test.ts`: constrained origins, redirect refusal,
  frozen download bytes and the existing file size policy.
- `test-workers/conversation-creation.test.ts`: real upload/R2 bytes, role-specific
  attachments, failed reservation cleanup, idempotent creation, explicit re-import
  after Rally turns, source revision, and provider continuation with history.
- `test-workers/space-routes.test.ts`: rejects a mismatched source before any
  attachment upload is created.
- `test-workers/substream-creation-runtime.test.ts`: private-child materialization,
  publication and conflicting replay.
- `test-workers/workspace-draft-attachment-reservation.test.ts`: existing draft holds
  and canonical projection release.
- `packages/agent-harness/src/evaluation.test.ts`: production runtime from an initial
  scenario and serialized tool-settled checkpoint, with no repeated write after fork.
- Desktop menu/launcher/transcript tests cover navigation and attribution.
  Readers are verified against real signed-in and shared conversations in a real
  Electron window: DOM tests cannot prove what a provider's page returns.

## Changelog

### 2026-09-24 — Create from a sidebar list's empty space

**What changed:** Right-clicking empty space in the channels sidebar opens the
creation menu's channel items at the pointer, and in the Spaces rail its
**Create New Space** item. `NewWorkstreamMenu` gained a context-menu trigger,
an `offer` filter and a locked Space; the import window's context gained an
optional `spaceLocked` flag that disables its Space picker.

**Why:** The list already belongs to one Space, so asking which Space again is a
question the reader has answered by where they clicked.

**Considered and rejected:** A second menu component for the list, which would
split one set of creation items into two that drift. Preselecting the Space but
leaving it changeable, which the product owner turned down.

**Consequences:** A right-click on a row still opens that row's menu, and one on
any other link or button opens nothing. The plus menus are unchanged and still
offer every Space.

### 2026-09-24 — Import only through Rally's browser, copying every file

**What changed:** Importing moved into a browser window. It reads the ChatGPT or
claude.ai conversation the person has open, signed in or shared, and copies its
files: uploads, generated images and sandbox files, drawn visuals, Research
reports, and published claude.ai Artifacts at their current version. The local
Claude, Claude Code, and Codex readers, the export-file picker, and the
server-side Firecrawl share fetch were removed, along with the `codex` and
link-preview request shapes. Updates reread the recorded URL through the browser.

**Why:** Local stores held only what each app happened to cache — titles
without messages, cloud sessions without files — and shared links fetched
server-side were blocked or challenged. The browser reads the same data the
provider's own page shows, with the person's own sign-in. Checking real
conversations against their pages found dropped Deep Research reports, agent
progress notes imported as turns, lost uploads and Artifacts, and a claude.ai
block type that failed whole imports; each is covered by a test.

**Considered and rejected:** Keeping the local pickers behind a second menu
item, which leaves two answers to one question. Linking Artifacts and uploads
instead of copying them, which leaves the Channel depending on the provider.
Copying an Artifact's files from the tool calls that wrote them, which imports
drafts the conversation later edited. Scraping the page's DOM, which is
virtualized and would silently omit earlier turns.

**Consequences:** Every reader depends on a provider's unofficial web API.
Artifact copies pass a short-lived asset token through the import window's
renderer. Channels imported from local Claude Code files keep their
`claude_code` provenance but cannot be updated. Each downloaded file is held to
the attachment upload limit; the total for one conversation is not.

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
and a labeled Bind context transition for imported source text. Review fixes
also keep local cache reads resilient to disappearing files, reject sources
without a stable conversation ID, validate update shape before file uploads,
and preserve Claude Code image and document blocks.

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
source updates. Existing imports without message identities cannot be safely
backfilled into a checkpoint. Imported provider text must remain labeled context
for the model, since Rally did not author it. Selecting one conversation and keeping a separate source
checkpoint makes both operations explicit and repeatable.

**Considered and rejected:** Automatic polling and the Claude account's
unpublished authenticated API. Local cache snapshots and JSONL files are
inspectable, user-selected sources; the Claude Code JSONL file picker remains a
fallback when discovery misses a session.

**Consequences:** Claude's undocumented cache remains an opportunistic source,
so a title alone never qualifies for the picker. Channels imported before the
source checkpoint was added remain readable but cannot use the update dialog;
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
