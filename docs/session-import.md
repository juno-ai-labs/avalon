# Prepared conversations and session import

A prepared conversation is ordered user/assistant content with resolved file
references and trusted provenance. The same conversation authority materializes
it into a root work stream or private child. Starting an execution is a separate
choice. Importing a prior assistant answer never claims Rally executed it.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/substream-content.ts` | Source content/files, resolved prepared conversations, initialization modes and import provenance. |
| `apps/api/src/services/session-import.ts` | Which conversation a source URL names and which provider owns it (`browserConversationSource`, `sessionSourceUrlProvider`). |
| `apps/api/src/services/session-import-run-service.ts` | An import run: reserve the Channel (or a Breakout of an existing thread), launch the agent's hidden child, complete, discard. |
| `apps/api/src/services/session-import-reclaim.ts` | Archive a new import's Channel its run ended without opening (the `session_import` profile's `ended` hook), and `retireUnopenedImportKey`, the D1 retire it shares with the reservation watch. |
| `apps/api/src/durable-objects/import-reservation-reclaim.ts` | The Organization's watch on every import reservation (WorkspaceDO migration 119 and alarm lane): archive a thread still unopened `IMPORT_RESERVATION_RECLAIM_AFTER_MS` after its reservation. |
| `apps/api/src/services/session-import-files.ts` | Upload reconciliation of the files an import carries, unavailable outcomes, and trusted attribution. |
| `apps/api/src/services/workstream-object-creation-service.ts` | `reserveImport` / `openReservedImport`: the Channel is placed first and initialized when the import completes. |
| `apps/api/src/durable-objects/hosted-parent.ts` | `reserveHiddenChild` (the agent's conversation), `ownsHiddenChild` / `hiddenChildren` (which import children are the caller's), and `discardReservedMain` (archive a Channel that never opened). |
| `packages/agent-harness/src/prompts/session-import.ts` | The import agent's system prompt and opening message. |
| `apps/api/src/services/desktop-actions/session-import-plugin.ts` | `import_finish` and `import_fail`. The browser tools are [desktop actions](desktop-actions.md). |
| `apps/api/src/services/resource-service.ts` | Existing verified upload, staged R2 cleanup and resource creation. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Shared materialization, preparation receipts, file reservations, root/child publication. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Source-message checkpoint and update receipts owned by the Channel authority. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | Canonical fact preparation for ordered conversations. |
| `apps/desktop/src/renderer/lib/browser-conversation.ts` | Which tab shows an importable conversation, and loading a cross-site file through the tab. |
| `apps/desktop/src/renderer/lib/session-import-run.ts` | The desktop half of a run: start it, answer its actions, assemble and hand over what the agent stored. |
| `apps/desktop/src/renderer/screens/browser-import.tsx` | The import window: Import, the name-and-Space sheet, the run's progress modal and Cancel. |
| `apps/desktop/src/renderer/lib/browser-import-progress.tsx` | The main window's half: lists the Channel as pending, shows "Importing conversation…", and settles or discards it. |
| `packages/agent-harness/src/evaluation.ts` | Scenario/checkpoint evaluation using the production Rally runtime. |
| `apps/desktop/src/renderer/screens/channel.tsx`, `components/channel-composer.tsx`, `screens/conversation-surface.tsx`, `components/session-import-update-dialog.tsx` | The **Import from Claude or ChatGPT** entry points that open the import window (the Channel header's button and the Channel composer's plus menu for a new thread; a thread composer's plus menu for a new Breakout), and the explicit update control. |

## How it works

Every import goes through Rally's own browser, read by an agent. The
**Import from Claude or ChatGPT** button on the right of a Channel's header
opens the [import window](embedded-browser.md) locked to that Channel, since an
import starts a new thread there. The same item sits in the plus menu of the
Channel's composer, beside **Attach files**. Only the desktop host has that
browser: the header button appears only there, and in the browser the plus-menu
item shows disabled with a tooltip saying it needs the Mac app. Both appear only
to someone who may start a thread in that Channel; a guest never sees them.
A thread's own composer has the same plus-menu item, which imports the
conversation as a new Breakout of that thread instead
([below](#importing-as-a-breakout)); the thread's header has no import button.
The person opens a conversation in the window — their own, signed in, or a
shared link — and clicks Import. A sheet asks for a thread
name, prefilled with the tab's title, and shows the Channel without letting it
change. Names stop at the server's 180-character limit. The entered name is
the settled thread title. Once the thread opens, a background pass picks its
icon from the imported history; its colour comes from its id, as for any thread
([naming](workstream-naming.md#prepared-history)).
The main window lists the Channel as a pending row the moment the import
starts and opens it on an "Importing conversation…" screen. That screen opens
no socket: the Channel is listed before its history is written, and its room
refuses connections until the import completes. Completion confirms the row
and the import window closes; a failure or Cancel takes the row away and
returns the main window to where it was. The pending-row rule is in
[Channel creation](workstream-creation.md#the-channel-is-listed-before-it-exists).

### An import run

1. **Reserve.** `POST /workstreams/import/runs` reserves the Channel in its Space
   (`reserveImport`): it is listed from here on, its route is active, and its
   main conversation stays uninitialized, so opening it answers as unavailable
   until the import completes. The create key's history hash is
   `session-import:<clientMessageId>:<source URL>`, so the reservation and the
   later open are one request to the create receipt, and `complete` can open
   the reservation only with the conversation it was reserved for. Replaying
   the same create key is idempotent: the agent's child id is derived from the
   reservation and key, so a replayed start finds the child it already launched
   and starts nothing new.
2. **Launch.** The service reserves a hidden child of the Channel
   (`reserveHiddenChild`: status `reserved`, in no listing, admitting only the
   importer), provisions it with the `session_import` [agent
   profile](agent-harness.md), seats the importer as its one member, writes the
   opening message (the URL, and in an update the source message ids to keep),
   and starts its run. The profile's run has the import prompt, the
   `session_import` model role, and exactly the browser plugin plus
   `import_finish` / `import_fail` — no other Rally tool. A launch that fails
   retires the reservation it made, so no listed Channel is left that nothing
   fills. A retire that fails as well is logged as
   `session_import_retire_failed` with its reason, and the window takes the
   key back itself (step 5). An update (`POST /workstreams/:id/import/runs`) first stops the
   caller's earlier import agents on that Channel, so one runs at a time.
3. **Read.** The import window opens the child's socket and answers every
   [desktop action](desktop-actions.md) the agent asks for on the tab it was
   started from: page script, the page's accessibility outline, screenshots,
   input, navigation and cross-site file loads, to any site. The prompt points the agent at the JSON the page itself loads, because
   long conversations render lazily and a DOM read drops messages silently. Page
   script keeps bytes and the assembled messages with the desktop through
   `await rally.store`; the model and the API see only handles. The prompt
   supplies an awaited file-loop/JSON-store contract and directs the model to
   `rally.normalizeText` for citations and Markdown-safe control removal,
   returning compact summaries rather than entire source records.

   The agent loads two [skills](agent-harness.md#skills) first: the generic
   `reading-an-ai-chat` procedure and its site's companion
   (`reading-chatgpt-conversations` or `reading-claude-conversations`). They say
   where the conversation's data is, what counts as shown, how files and
   documents become files, and how to check the result against the page before
   finishing. Accepted URLs — `chatgpt.com/c|share/<uuid>`, ChatGPT task shares
   `chatgpt.com/s/<id>`, `claude.ai/chat|share/<uuid>` and Claude Code sessions
   `claude.ai/code/session_<id>` — are one table, `conversationSourceAt` in
   `@rally/contracts`, shared by the window and the API.

   While the agent works, the window holds a non-dismissible modal over a
   blurred capture of the page, refreshed as each step ends. The modal lists
   each step in the harness's words (`activityName`) and then the tool's own
   summary of what it did; past three, the oldest fold into one "N previous
   actions" line, and between tools a "Deciding the next step…" row shows the
   model is still working. The description reads: “Rally is using a large language
   model and computer use to read the page. This can take between 20 and 60 seconds.”
   The page itself is parked out of the window at full
   size ([embedded browser](embedded-browser.md)), so the person cannot click,
   type or navigate into what the agent is reading, and the window's browser
   shortcuts are off. Cancel is the only way out. The modal's ⋯ menu has
   **Copy import id**, which copies
   `/app/<region>/<organization>/i/<agent conversation>/c/<Channel>`
   (`sessionImportCanonicalUrl`) for a bug report once the API has answered.
Import admission requires client contract 3, which supports persistent browser
scripting, concurrent page downloads, and explicit verification check outcomes. Older desktops receive an update-required error before either a new
Channel or an update run is reserved; ordinary Channel access still accepts
contract 1.

4. **Finish.** `import_finish` names the stored messages array and a compact
   `verification` report: selected-branch completeness and its basis, page-accounted
   message count, first/last source ids, assistant ids actually compared with the
   page, the observation basis, file count including unavailable files, and `checks`
   with each observed probe's name, actual pass/fail result and basis.
   The shared `SessionImportVerificationSchema` requires evidence; the desktop's
   `verifySessionImport` refuses every failed check, then checks counts, endpoints and assistant sample membership
   against the assembled history before any import write. A mismatch returns a
   field-named repair reason. This is model-reported evidence, not independent
   proof that the page was checked. Rendered turns may group several messages;
   observations explain the correspondence without assuming a DOM layout.
   The desktop
   checks it against `BrowserImportMessagesSchema`, turns each file handle into
   inline bytes, and posts the ordinary import request: `POST
   /workstreams/:id/import/complete` initializes the reserved Channel with the
   history (`openReservedImport`), and an update posts to `POST
   /workstreams/:id/import/update` as before. `complete` checks that the create
   key's receipt names this Channel before it prepares or opens anything
   (`session_import_channel_mismatch`). A refusal goes back to the agent with the
   field or API code named, so it can fix the messages and finish again. Once the
   Channel has opened, that ending is final: a later `import_fail` or repeated
   finish cannot unlist it. The main window then opens the Channel and the import
   window closes; if that hand-off fails, the window releases the modal and says
   the conversation was imported.
5. **Fail or cancel.** `import_fail` names one of three reasons, and the window
   shows Rally's own words for it. Cancel, or a failure, calls `POST
   /workstreams/:id/import/discard`. Discard reaches only a hidden import child
   the caller reserved — never a Channel's main conversation (`0`), a Breakout,
   or another person's import; anything else answers 404
   `session_import_not_found` before any agent is stopped. The agent stops, and
   a Channel that never opened has its create receipt retired (`failed`, code
   `session_import_discarded`) and is archived out of every listing
   (`discardReservedMain`). A Cancel pressed before the reservation comes back
   discards it when it does, without ever reporting it to the main window.
   A start that fails returns no ids to discard with, yet may have reserved
   the Channel: its launch failed and so did the retire behind it, or the
   invocation was cut off mid-launch. So the window then calls `POST
   /workstreams/import/abandon` with the create key alone (`abandon`), which
   stops the caller's import agents on the key's Channel and retires it the
   way discard does. A key that reserved nothing is a no-op, and a key
   `complete` has claimed is refused before any agent is stopped.
   A terminal harness status releases the progress modal immediately even if a
   browser command remains blocked; queued actions do not execute and late
   answers are not sent after the run closes. The exception is an import commit
   already in flight: the window waits for that request to decide whether the
   Channel opened, preserving the imported ending when it did.
6. **Reclaim.** The window's discard is not the only way out: a window that
   closes or crashes mid-run sends none. So the `session_import` [agent
   profile](agent-harness.md#agent-profiles)'s `ended` hook runs once the run's
   outcome is durable, however it ended, and archives the Channel if its
   receipt is still `reserved` (retired with `session_import_unfinished`), or
   `failed` by an abandon that landed before the reservation published and so
   found nothing to archive. The
   desktop opens the Channel inside the finish tool, before the run's final
   turn, so a reservation still unopened at the end never will be; an update's
   Channel has a completed receipt and is untouched.

   A start that never admits a run, from a window that dies before it can
   abandon the key, has no run to end. So the reservation is also watched by
   the Organization itself: `reserveChannelInSpaces` arms a row in the same
   transaction as the thread (`reclaimUnopened`, set only by the import's
   reserve stage), due `IMPORT_RESERVATION_RECLAIM_AFTER_MS` (one hour) later.
   When it is due, WorkspaceDO's `import_reservation_reclaim` alarm lane runs
   the same D1 retire as the run-end reclaim (`retireUnopenedImportKey`) and,
   when it matches, archives the thread through `discardReservedMain`. A key
   `complete` has claimed or finished is refused, so an import that opened is
   never touched; its row is simply dropped. Each row is claimed, its gate
   advanced, before the D1 call, so a reclaim that throws or a pass cut off
   part way keeps its row and retries at that gate.

### Importing as a Breakout

The plus menu of a thread's main composer opens the import window aimed at that
thread (`BrowserImportContext.breakout`). The name sheet shows the thread,
locked, and asks only for the Breakout's name. The run is the one above with a
different reservation and opening:

- **Reserve.** `POST /workstreams/:id/import/breakouts/runs` calls the ordinary
  Breakout `prepare` (`SubstreamCreationService`) with the create key as its
  operation id and no source turn, so the Breakout captures the thread's
  context like any other. A prepared Breakout is in no listing. The agent is
  launched alongside `prepare`, not after it: the context summary is a model
  round trip the agent does not need, and it is done long before the agent
  finishes reading. A failed `prepare` stops the agent. The agent's
  hidden child and run are named from the thread, the key and the canonical
  source URL, so a replayed start finds the agent it launched, and a replay on
  another conversation names a different one.
- **Finish.** `POST /workstreams/:id/import/breakouts/complete` first checks,
  before any upload, that the caller started an import of this conversation
  under this key (its hidden child, `session_import_source_mismatch`) and,
  when the import carries files, that the preparation is still theirs and live
  (`assertConfirmable`); `confirm` checks the preparation itself otherwise. It then runs
  the same `prepareSessionImport` as a new thread, with the thread in the
  operation id so file ids are scoped as the preparation is, and hands the
  result to `confirm` as
  prepared history, with no opening message: the Breakout starts idle, under
  the name from the sheet, and records its source checkpoint as a thread does.
  Readiness is confirmation's last step, so it appears holding the history.
  The import window hands the Breakout's id to the main window, which opens
  `rally://workstreams/<thread>/substreams/<breakout>`. The thread was never a
  pending row, so nothing is reported as importing.
- **Fail or cancel.** `discard` with `breakout: true` stops the agent and
  cancels the preparation, so a late finish is refused
  (`substream_creation_cancelled`). A run that ends with no discard (the window
  crashed) leaves the preparation unconfirmed. That is the same state as a
  Breakout someone started and walked away from: invisible, and never
  reclaimed, so the `ended` hook has nothing to do for it.

Importing is a member's, as a new thread's import is: the routes sit behind
`requireAuth`, which refuses guests, so a guest's composer does not offer it.
Opening it to guests would mean moving the agent launch and uploads behind
guest authentication, a decision of its own. There is no update control for an imported Breakout yet, but
its checkpoint is recorded, so adding one needs routes, not storage.

The agent decides what to copy: visible user and assistant text, citations as
Markdown links, uploads and generated files, published artifacts; not
reasoning, tool calls, progress notes or superseded versions. What it found but
could not copy is recorded as an unavailable file, so the imported transcript
says it is missing. Its identity never comes from the model: `source.sessionId`
is the id in the conversation's URL (`browserConversationSource`), and an update
uses the recorded source.

An update opens the import window on the recorded conversation, where the
person can sign in again if the site asks, and runs the same agent with the
Channel's recorded message ids as its required prefix. Only the person who
imported the Channel sees the update action, and only for a source the browser
can open again. The Channel's creator identity is also the importer identity for
this creation path; its authority checks that identity before reading the source
checkpoint or accepting an update. Other Channel members can read the imported
transcript and add their own messages without gaining access to the import
control. Imports created before source checkpoints were introduced, and Channels
imported from local Claude Code files before importing moved to the browser,
remain readable but have no update control.

There are three separate boundaries:

1. **Read source content.** The import agent reads the conversation in the
   person's browser and hands over visible messages and copied files. Tools,
   thinking and compaction remain absent from the transcript.
2. **Resolve content.** The request carries file bytes inline or an unavailable
   reference; a remote reference is never fetched and imports as unavailable.
   Import stores bytes through `ResourceService.upload`,
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
- The model never sets an import's identity: the session id comes from the
  conversation's URL, and message ids an update must keep come from the
  checkpoint. Otherwise page content could attach an import to another source.
  Guard: `session-import-run.test.ts` (Workers) and the update route's checks.
- The import agent's run has no Rally tool but its browser and finish tools.
  Otherwise instructions planted in a page could reach the person's workspace.
  Guard: the Workers test asserts the run's exact tool names.
- A Channel reserved for an import is either opened by `complete` or archived by
  `discard` or the run-end reclaim, never both. `complete` first claims the
  receipt (`reserved` → `initialized`, one statement) before anything opens;
  discard and reclaim retire only a `reserved` receipt, and opening refuses a
  retired one (`workstream_create_discarded`). Whichever claims first wins, so
  no Channel is left open with a failed receipt. Guard: the discard, claimed
  and run-end tests.
- A replayed or concurrent start of one import admits one run: the child and
  its run ids are both named from the reservation, and a second admission finds
  the run. A start whose launch fails retires the reservation only when no run
  was admitted. Guard: the Workers concurrent-start test.
- A start that failed leaves nothing the window cannot take back: it abandons
  the create key, which needs no id from the start's answer. Otherwise a
  launch and its retire failing together (a deploy resets both) leaves a
  listed Channel whose conversation never opens, which no run-end reaches
  because no run was admitted. Guard: the Workers abandon tests, and the
  desktop test of a failed start.
- Every new-thread import reservation is watched from the transaction that
  makes it. Otherwise a start cut off before its run, from a window that is
  gone, leaves a thread that nothing archives. Guard: the Workers
  reservation-watch tests and
  `test/workspace-import-reservation-reclaim-migration.test.ts`.
- Discard stops only the caller's own hidden import child. Otherwise one member
  could stop another's agent, or a Channel's own run, by naming it. Guard: the
  Workers ownership test.
- Bind owns settled execution state; Rally owns conversation facts and host restoration.

## Boundary

Public APIs are `POST /workstreams/import/runs`, `POST
/workstreams/import/abandon`, `POST /workstreams/:id/import/runs`, `POST /workstreams/:id/import/complete`, `POST
/workstreams/:id/import/discard`, `GET /workstreams/:id/import/source`, and
`POST /workstreams/:id/import/update`. How the agent reaches the desktop is
[desktop actions](desktop-actions.md); which tools and prompt it runs with is
its agent profile in [the harness](agent-harness.md).
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

Source files are inline UTF-8/base64 or explicitly unavailable references.

## Failure modes and limits

The agent works out each provider's page on every run, so a provider changing
its web API or page costs latency, not a broken release; it is also
non-deterministic, slower and more expensive than a fixed reader, and a run can
end without finishing — the window then says so and offers to try again or
cancel. Sign-in, CAPTCHAs, and provider policy can still prevent a read; the
agent reports those as `sign_in_required` or `page_unavailable`, and a
conversation it can see but not read with its own message ids — or a finish
Rally keeps refusing for a reason the stored messages cannot fix — as
`unreadable`. A run that ends after Rally refused its finish shows Rally's last
reason. A run whose tab closes fails each action with `tab_closed`.

The desktop keeps each stored file only up to `MAX_STORED_FILE_BYTES`, the same
25,000,000 bytes as the upload limit (`MAX_ATTACHMENT_BYTES` in
`wrangler.global.jsonc`; keep them equal), checked against a declared length
before reading and the body after; the agent records a larger file as
unavailable. The total across one conversation's files is not separately
bounded: a conversation with many large files is held in the window's memory
together. The text one browser tool result carries is capped by
`BROWSER_TOOL_TEXT_MAX_CHARS`, written open (unbounded) for the team to set. A
browser step that runs past `TOOL_DEFAULT_TIMEOUT_MS` fails as any slow tool
does; a large file loaded in one step can reach it. Prepared histories have no
additional guessed size ceiling, but HTTP, memory, SQLite and provider context
limits still apply. Full canonical replay is paged but assembled in memory; an
oversized first provider request can fail before automatic compaction is
available.

A Channel reserved for an import is listed while the agent works, and the main
window shows it on its "Importing conversation…" screen, which opens no socket
because the conversation is not initialized yet. The row is marked pending only
once `start` answers, so before then the main window's background sockets can
dial the new Channel; admission refuses it, and the Channel's main object is
left as an empty `preparing` placeholder until `complete` initializes it. That
placeholder is expected on every import, discarded or not. A context the main window
sends to the import window during a run (another Space, another update) waits
until the run ends: a run drives the tab, and nothing else may navigate it.

An import whose thread has not opened `IMPORT_RESERVATION_RECLAIM_AFTER_MS`
(one hour, the team's number) after its reservation is archived; see step 6.

HTML/code artifacts remain stored files; importing does not launch a site.

## Testing

- `test-workers/session-import-run.test.ts`: an import end to end on real
  objects with the provider double as the model and the test as the desktop —
  reservation, the hidden child's profile and tools, actions answered over its
  socket, completion, an answer kept across a lost waiter, admission, discard
  and its ownership check, a Channel archived when its run ends unopened, and
  one taken back by its create key after a start whose launch and retire both
  failed, and the Organization's reservation watch: archiving a start cut off
  after its reservation, dropping the watch on one that opened, and gating a
  failed reclaim for a retry.
  Reservation-watch tests wait for the durable watch to be removed before
  checking the archive and receipt: the runtime may already be running a due
  alarm when `runDurableObjectAlarm` returns.
- `test/workspace-import-reservation-reclaim-migration.test.ts`: migration 119
  watches each listed, unopened import reservation and no other thread.
- `test/session-import.test.ts`: which conversation and provider a source URL names.
- `test/desktop-action-tools.test.ts`: the import tools' finish and fail, and
  the profile lookup.
- `packages/contracts/src/session-import-verification.test.ts`: layout-independent
  report validation, grouped replies, changed endpoints, and file accounting.
- `apps/desktop/src/renderer/lib/session-import-run.test.ts`: refusal before writes
  followed by repaired evidence, assembling stored
  messages and files into the import request, the errors that name what to fix,
  re-sent answers, Cancel before the reservation, a failed start abandoning its
  create key, and an opened Channel's ending staying final.
- `apps/desktop/src/renderer/screens/browser-import.test.tsx`: the sheet, the
  run it starts, and Rally's words for a failure.
- `test-workers/conversation-creation.test.ts`: real upload/R2 bytes, role-specific
  attachments, failed reservation cleanup, idempotent creation, explicit re-import
  after Rally turns, source revision, and provider continuation with history.
- `test-workers/space-routes.test.ts`: the start and complete routes, Space
  placement, and a mismatched source refused before any upload.
- `test-workers/workspace-draft-attachment-reservation.test.ts`: existing draft holds
  and canonical projection release.
- `packages/agent-harness/src/evaluation.test.ts`: production runtime from an initial
  scenario and serialized tool-settled checkpoint, with no repeated write after fork.
- Desktop menu/launcher/transcript tests cover navigation and attribution.
  Whether the agent reads a real provider page correctly is verified in a real
  Electron window against a real model: no test double can prove what a
  provider's page returns or what a model makes of it.

The browser tool surface is now `browser_js` / `browser_js_reset`, with a
persistent browser/tab handle session. The importer loads the supported API at
discovery and uses the explicit `rally.pageScript` extension for writable
extraction. See [browser script runtime](browser-script-runtime.md) for scope
and lifecycle; import finish/fail remain separate tools.

## Procedure evaluation

Evaluate the actual model calls and imported history, not just completion:

| Variation | Required observation |
| --- | --- |
| Edited prompt / regenerated reply | Selected branch only, root reached, old siblings absent |
| Partial response / long virtualized history | Missing ancestors or pages recovered; page coverage explained |
| Grouped replies / changed DOM structure | Source-message count reconciled with visible turns, representative replies compared |
| Attachments / generated documents / writing blocks | Original bytes or named unavailability; converted text and files appear once |
| Conversation changes during reading | Selection refreshed and affected verification repeated |

Use fresh page observations and source shapes for each run. Provider routes and
field names in companion skills are discovery hints, not fixed acceptance
fixtures. Record compact branch/page/file evidence, actual tool errors, and the
ordered imported ids/text/files. Contract tests cover inconsistent reports and
file accounting; desktop tests cover refusal before writes followed by repair.
These deterministic checks do not measure model compliance: live runs across
these variations are still required to establish it.

## Changelog

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
