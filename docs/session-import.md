# Prepared conversations and session import (retired)

**Session import is deleted.** An agent imported a person's ChatGPT or Claude
conversation into a reserved Channel, and a prepared conversation (ordered
user/assistant content with resolved files and provenance) was materialized
into a root work stream or a private child. Threads and Channels left the
product with the Canvases and Sidekicks pivot
([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)). The run service and
routes went in plan step C-1; step C-2 deleted the import desktop action
(`session-import-plugin.ts`), the reservation reclaim
(`session-import-reclaim.ts`, `import-reservation-reclaim.ts` and its
WorkspaceDO alarm lane), the share-URL and file helpers (`session-import.ts`,
`session-import-files.ts`), the `session_import` agent profile, and
`AgentLoopDO`'s prepared-conversation install.

`AgentLoopDO` migration 84 (plan step C-3) dropped the `imported_session_*`
tables. What survives: `prepared_conversation_receipts`, kept as a dead table
because `pending_attachment_reservation_recovery`'s foreign key names it, 
`PreparedConversationSchema` and `ImportedMessageProvenanceSchema` in
`packages/contracts/src/substream-content.ts` (harness evaluations and stored
transcripts read them; the import requests went in step B-8), and WorkspaceDO migration 119's statements, which moved byte for
byte to `retired-workspace-schema.ts`. This document is kept for its
changelog. Do not build on anything it describes.

## Changelog

### 2026-11-07 — Session import is deleted

**What changed:** The run service and routes went in plan step C-1; step C-2
deleted the import desktop action, the reservation reclaim and its WorkspaceDO
alarm lane, the share-URL and file helpers, the `session_import` agent profile
and `AgentLoopDO`'s prepared-conversation install. Step C-3 deleted the import
product operations and dropped the `imported_session_*` tables (migration 84);
`prepared_conversation_receipts` stays under a live foreign key, and migration
119's statements moved byte for byte to `retired-workspace-schema.ts`.

**Why:** An import landed in a reserved Channel, which the
[Canvases and Sidekicks PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)
removes; the PRD does not carry import onto Canvases, so nothing was left to
reserve into.

**Consequences:** No client offers import. Bringing it back means designing
it onto a Canvas's Chat, not restoring this code.

### 2026-10-19 — The Organization watches every import reservation

**What changed:** A new-thread import's reservation now arms a row in
WorkspaceDO (`import_reservation_reclaim`, migration 119) in the same
transaction that lists the thread. An hour later its alarm lane retires the
create key in D1 and archives the thread unless the import has opened it.
Migration 119 seeds a row for every reservation already waiting. The D1
retire is now one function, `retireUnopenedImportKey`, shared with the run-end
reclaim.

**Why:** The earlier exits each need someone to show up: the window for
discard and abandon, a run for the run-end reclaim. A start cut off before
admitting its run, from a window that then closed, had neither, which is how
a production thread stayed listed and unopenable from 2026-10-06. The team set the
timeout to one hour.

**Considered and rejected:** Arming in `reserveHiddenChild`, which is
import-only already but runs after the thread is listed, so a start that
died in between would go unwatched. Also rejected: asking the hidden child
whether a run exists before archiving. An admitted run that was never
activated never ends either, so the check would need its own timeout and
would still miss that case. Age alone, with D1 refusing any key `complete`
claimed, covers every case.

**Consequences:** An import still running an hour after its reservation is
archived and loses its result. Every import costs one row and one alarm wake
an hour on, and a D1 statement only when its thread has not visibly opened.
The migration reaches an Organization when it next wakes; force WorkspaceDO
from the migration tracker to reach all of them
([`durable-object-migration-tracking.md`](durable-object-migration-tracking.md)).

Shipped in #1310.

### 2026-10-19 — Take back a failed start by its create key

**What changed:** `POST /workstreams/import/abandon` ends a new import by its
create key alone, and the import window calls it whenever a new-thread start
fails. `start` now logs a retire that fails behind a failed launch
(`session_import_retire_failed`) instead of swallowing it.

**Why:** A production Channel stayed listed for nearly two
weeks with a main conversation that could never open. Its launch stopped after
bootstrapping the hidden child, before provisioning it. Nothing was left to
take it back. The retire in `start` failed silently or never ran, the window's
discard needs the ids a failed start never returns, and the run-end reclaim
needs a run that was never admitted.

**Considered and rejected:** Carrying the ids on the start's error. An
invocation cut off mid-launch returns no body at all, and the window already
holds the one name the reservation answers to. Also rejected: a watchdog
alarm that archives a reservation whose launch has not admitted a run after a
while. It would also cover a window that dies mid-start, but how long a
launch may take before it is presumed dead is a limit for the team to set,
and an open value would change nothing. That remaining path is named under
step 6.

**Consequences:** Abandon reaches any never-opened create key of the caller's,
which today is only an import's, because no other client calls it. A key
`complete` has claimed is refused before anything is stopped. A `failed`
receipt is retired again, so a retire that stopped after writing the receipt
is finished by the next one. Abandon retires before it stops any agent, so a
`complete` that claims the key in between keeps its agent, and the run-end
reclaim also matches a `failed` receipt, for an abandon that beat the
reservation's publication.

Shipped in #1306.

### 2026-10-17 — Import a conversation as a Breakout of an existing thread

**What changed:** A thread composer's plus menu offers **Import from Claude or ChatGPT**, which reads the conversation with the same agent and opens it as a new Breakout of that thread. The API gained `/import/breakouts/runs` and `/import/breakouts/complete`, and `discard` cancels a Breakout reservation. There is no button in the thread's header.

**Why:** Importing could only start a new thread, so a conversation that belonged to work already under way landed beside it rather than in it. Breakout confirmation already accepted prepared history and recorded the source checkpoint, so the destination needed wiring, not new storage.

**Considered and rejected:** Reserving the Breakout as a listed pending row, as a new thread is. A Breakout publishes only when it is ready, so there is nothing to list or take away. Also rejected: reclaiming an unfinished Breakout reservation from the `ended` hook; an unconfirmed preparation is invisible, exactly like an abandoned manual one, and nothing reclaims those either.

**Consequences:** An imported Breakout carries the thread's context and its own source checkpoint. Guests are not offered it: the import routes are member-only, and opening them to guests is a separate decision.

### 2026-10-16 — Import also offered from the Channel composer's plus menu

**What changed:** The Channel's composer lists **Import from Claude or ChatGPT** in its plus menu after **Attach files**, opening the same import window locked to that Channel. The header button stays. In the browser, which has no embedded browser to import through, the item shows disabled with a tooltip saying it needs the Mac app.

**Why:** The plus menu is where a person looks for ways to bring something into a new thread, and an import is one. The header button alone sat away from the place the thread is started.

**Considered and rejected:** Hiding the item in the browser, as the header button is. A menu entry that exists on one platform and silently not on another reads as missing; showing it disabled says why.

### 2026-10-13 — Import moves from the sidebar to the Channel header

**What changed:** The import button left the sidebar header for the right of a Channel's header, renamed **Import from Claude or ChatGPT**, and opens the import window locked to that Channel.

**Why:** The sidebar's import button sat beside search and new Channel, so it read as creating something at the organization level. An import creates a thread in one Channel; the button now sits on that Channel's header and opens the window with the Channel locked (`spaceLocked`), so where the thread lands is never a choice made in a second window.

**Considered and rejected:** Keeping the sidebar button with the Channel picker. It made the destination a separate step and hid that the result is a thread.

**Consequences:** Importing needs a Channel open first. The import window still accepts a list of Channels, so a future entry point with a picker needs no change there.

Shipped in #1209.

### 2026-10-03 — Parallel file preparation and explicit verification outcomes

**Why:** A production import copied 14 files, committed its ten messages just before the tool deadline, then received success after the timer had already failed its run. The model also ignored five false text comparisons while claiming complete verification.

**Changed:** Server upload preparation uses one queue across messages, preserving source order and stable per-file identities. A failed batch drains started writes and stops subsequent batches. Successful unattached drafts remain retryable under the existing draft expiry/reaper, rather than being compensated away after an ambiguous write. The upload width (`MAX_SESSION_IMPORT_PARALLEL_UPLOADS`) remains open pending a team-set value: full fan-out increases peak decoded-byte memory beside the parsed base64 request. Finish reports contain the latest actual result for each check; unresolved failures require repair, and a successful rerun explains the discrepancy and repair in its basis. Admission requires client contract 3; persisted contract-2 actions still replay without invented checks.

The save lifecycle is owned by [desktop actions](desktop-actions.md#changelog), and the file downloader by [browser script runtime](browser-script-runtime.md#changelog).

**Considered and rejected:** Selector-specific verification and deleting sibling drafts after infrastructure failures. Comparisons must survive page redesigns; a write may already have committed and retries need its stable identity. Reports remain model-authored evidence, not browser attestations.

**Consequences:** Model procedures must resolve independent download links concurrently and reuse successful original-byte checks. A changed page or failed comparison requires new evidence rather than a rewritten success claim.

### 2026-10-02 — Copy import id from the progress modal

**What changed:** The progress modal has a menu with **Copy import id**, which
copies an `/app/<region>/<organization>/i/<id>/c/<Channel>` address naming
the import agent's hidden conversation and its Channel. `Modal` gained a `headerActions` slot for it.

**Why:** People report imports that came out wrong, and there was no way to say
which run produced one. The hidden child is the id that names the run (its
transcript is the agent's reasoning and tool calls); the Channel id names only
the result. The address carries the Channel too because the hidden child's
object is named by both ids and nothing maps a hidden child back to its
Channel.

**Considered and rejected:** Routing `/i/` to a page now. Nobody has said what
a debugging view should show, so building one would be guessing.

**Consequences:** Until something routes `/i/`, opening the address lands on
the site's "This link did not lead to a Rally resource" page and records an
`invalid` desktop handoff, so those counts include import ids people clicked.
A future route must read the `/c/` segment rather than look the Channel up,
since no lookup from a hidden child to its Channel exists.

Shipped in juno-ai-labs/avalon#1065.

### 2026-10-02 — End failed imports independently of blocked browser work

**What changed:** The agent's storage and normalization protocol is explicit,
the browser protocol uses persistent handles with explicit page extraction and descriptive call titles,
a layout-independent verification report is required before import writes,
and a terminal run closes the desktop's progress state without waiting for a
pending browser command. Work queued behind it is skipped. Only an import
commit already in flight is awaited, so an opened Channel stays imported.

**Why:** A two-message Claude import timed out on the server while its desktop
answer arrived minutes later; the window queued its terminal handling behind
that same action. A live Terra import also wasted calls on unexecuted function strings and an incomplete flat ChatGPT response; callbacks now execute explicitly and the provider skill directs missing ancestors to the full mapping. The verification probe subsequently used prefix matches and pagination flags as proof; the generic guidance now explicitly distinguishes identifying a reply from verifying its entire content, and pagination from resolving ancestry. A separate ChatGPT import repeatedly prepared invalid file
handles and damaged text instead of finishing.

**Considered and rejected:** Extending the timeout or finishing every terminal
run immediately, including an in-flight commit. The former hides the stalled
boundary; the latter can report failure for a Channel that actually opened.

**Consequences:** Verification checks payload consistency but trusts the model to make the reported observations; it does not certify extraction independently. Missing ancestors or unfinished pagination must be resolved before visibility filtering, and page grouping must be accounted for rather than assuming array or DOM order. Late browser work cannot resume an ended import. Ending a run disposes its
isolated orchestration realm and stops further browser requests. The commit
result remains authoritative, and the UI does not claim that closing a run
aborted JavaScript already executing in the provider's page.

### 2026-10-01 — Read conversations with an agent instead of fixed readers

**What changed:** An import is now an agent that reads the conversation in the
person's own browser through generic [desktop actions](desktop-actions.md),
running under the `session_import` agent profile in a hidden child of the
Channel it imports into. The Channel is reserved first and opened by
`complete`; a reservation that never opens is archived by discard or, when no
discard arrives, by the profile's run-end hook. Provider knowledge lives in
loadable skills, and the importable-URL table is `conversationSourceAt` in
`@rally/contracts`. The window locks the page behind a progress modal while a
run drives it. The retired `POST /workstreams/import` and its fixed readers are
gone.

**Why:** The fixed readers — page script per provider route and a server
decoder per format — each depended on an unofficial web API or page shape, and
the entries below are largely a record of repairing them after a provider
changed one; they also could not reach private chats behind a page-held token,
Codex task shares or Claude Code sessions. An agent works the page out on each
run, so a provider change costs a slower import instead of a broken one.
Without skills the agent re-derived each page and lost messages to lazy
rendering (8 of 15 on one ChatGPT share; 47 of 48 on a claude.ai share where it
dropped lines it judged to be narration). A person who clicked or navigated
mid-run changed the page under the agent, so the page is locked rather than
recovered from. The window and the API had parsed source URLs separately and
already disagreed. Review of the first cut found that discard could stop any
conversation's agent, that a start replay or a failed launch left a listed
Channel nothing would fill, and that a closed window left its reservation
listed forever; the ownership check, the derived child id, launch compensation
and the run-end reclaim close those.

**Considered and rejected:** Keeping per-provider readers (the churn above).
Creating an empty Channel up front, which needs a no-message initialization
through the hottest creation path. Running the agent under a hidden system
Sidekick, which needs a Sidekick hidden from every Sidekick list. Having the
model emit the transcript as output, which is slow, costly and able to change
what it copies — page script stores text and bytes with the desktop and the
model hands over a handle. Putting provider knowledge in the system prompt,
which every run of every browser-bearing agent would pay for. Relying on the
window's discard alone, which a crash never sends.

**Consequences:** Imports are non-deterministic, slower and cost model tokens,
and correctness against a real provider page is proved only in a real window
against a real model. A future change must keep the agent's tool surface to its
profile's plugins, keep the import's identity (session id, kept message ids,
the source URL bound into the create key) out of the model's hands, keep the
desktop's 25 MB store cap equal to the upload limit, keep the page unreachable
to the person while a run drives it, and keep the Channel opening inside the
finish tool — the run-end reclaim assumes a reservation still unopened at the
end never will be. Codex task shares give messages no ids, so they are
identified by share id and turn; that is safe only because a share never
changes. Files a Claude Code session delivered were found on one run and not
the next; that remains open.

Shipped in #1058.

### 2026-10-01 — Read a shared ChatGPT conversation from the page that rendered it

**What changed:** Importing `chatgpt.com/share/<id>` recovers the conversation JSON ChatGPT already put in the share page's React Router loader stream, then falls back to `/backend-anon/share/<id>`. Files still come from the anonymous download routes.

**Why:** ChatGPT's share page stopped fetching `/backend-anon/share/<id>` from the client — the snapshot is SSR'd into the document — so Rally's reader got a non-OK response and showed "ChatGPT could not return this conversation" while the same page was displaying the chat. That is the failure that landed on 2026-10-01 for a share that had imported the day before. No Rally importer code had changed; the provider's unofficial route did.

**Considered and rejected:** Scraping the visible DOM, which is virtualized and would silently drop earlier turns. Teaching the reader ChatGPT's sentinel/proof-of-work handshake so the old route would accept a raw `fetch`, which chases an anti-bot surface the page itself no longer uses. Waiting for a signed-in `/c/<id>` tab instead of a share link, which abandons the public-link path the import window already offers. A third authenticated `/backend-api/share/<id>` hop, which nothing showed ChatGPT serving. Walking `window.__reactRouterContext` as well as the stream, which holds the same initial SSR payload.

**Consequences:** A share import now depends on ChatGPT still shipping `mapping` and `current_node` in that loader payload (or on `/backend-anon/share/<id>` still answering). Client-side navigation to a different share can leave a stale stream in the document; the reader matches the URL's conversation id and then hits the HTTP fallback. File copies on a share still fail closed when the anonymous download routes refuse.

Shipped in #1042.

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
offer every Space. Main reuses an open import window, so the window moves an
open sheet's Space into whatever the new context offers, and a locked context
never submits a Space it no longer holds.

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
