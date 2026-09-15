# Meeting notes retirement

Rally's built-in meeting recording, Notes, and Control Tower are retired.
Composer dictation, its microphone permissions and transcription transport remain.
Granola and Fireflies integrations remain independent features.

## Removal and cleanup

The note API and generation services have been removed. WorkspaceDO migration 57
clears note content and linked resources, retaining only IDs and object references
in `retired_meeting_resources`. Inserts and updates cannot recreate built-in note
resources. Existing migration definitions remain unchanged.

`retiredMeetingInventory`, `purgeMeetingSearchAuthorization`, and
`purgeMeetingNoteObjects` are internal RPCs, with no
public route. All are permitted on retired workspaces so an inactive or closed
workspace cannot escape the purge. One purge call deletes one resource's page of
R2 objects; failures retain the address and another call resumes. Resource IDs
remain until downstream attachments and archives have been checked.

Search cleanup drains an already admitted KV publication, deletes the external
key, then removes its SQLite decision and dependencies. A failure retains the
key for retry. Registration and publication both reject retired resource IDs.
The search index is independently inventoried by exact source ID before deleting
its revision metadata; queued indexing revalidates canonical authority.

Some adopted schemas lack the obsolete `automation_resources` table. Migration
57 had already shipped when this was discovered, so its hash stays unchanged.
An outer transaction supplies an empty temporary relation for that migration's
DELETE and removes it before committing. The real workerd upgrade test covers
this historical shape as well as a complete populated schema.

Conversation schema migration 58 removes identifiable note attachment snapshots
and receipts while preserving conversation turns. Unknown copied prose is not
classified by text matching. Terminal imports and model-history copies require
separate provenance-based inventory before claiming complete deletion.

## Rollout and verification

Deploy retirement behavior before running cleanup. Enumerate every workspace and
conversation object, including retired objects. Drain the R2 cleanup, remove
attributable search documents and raw inference records, and delete analytical
copies through the Iceberg catalog. Never delete shared Parquet objects directly.
Workspace migration 58 drops the five empty feature tables after a guard verifies
that R2 deletion is complete and attributable search authorization keys are gone.
It also removes the note sidebar state and search revision rows. Content-free
resource IDs remain as provenance and stale-writer fences; they contain no notes.
Historical provider retention is tracked separately from current serving storage.

The inference consumer writes a content-free tombstone before deleting a queued
meeting inference record. Replays acknowledge that tombstone instead of restoring
the record to the analytical store.

Local verification is separate from production completion. The workerd retirement
test covers populated archived notes, resource preservation, historical R2 files,
recreation refusal and repeat execution. Dictation must additionally be exercised
in a real desktop window. Cloudflare point-in-time recovery and Iceberg historical
snapshots must be reported separately from deletion of currently served records.

## Production checkpoint — 2026-09-15 UTC

The deployed API version `a7b1266b-1283-4343-bc58-725c0dc7fec7` completed
workspace schema 58. All 16 stored workspace objects, including closed workspaces,
were explicitly read back: zero feature tables, zero attributable resource
references, and zero pending R2 deletions. The content-free manifest records 26
retired resources. All 52 current and historical note files were removed; a full
159,351-object workspace-prefix scan found no note files afterward.

All 6,693 stored conversation objects were inspected after conversation migration
58: no remaining note attachments, attributable terminal imports, or tool-input
copies. All 28 production search namespaces had zero matching source IDs. The
74 attributable authorization KV keys and their SQLite decisions were deleted.
No attributable meeting inference records were found in the current catalog or
among 348 raw records not yet cataloged. Unrelated conversations and external
meeting integrations were preserved, and no content backup was created.

The current analytics catalog's two meeting lifecycle rows and D1's 13 accepted
events plus 13 receipts were deleted. Thirteen PostHog lifecycle events remain:
the available deletion mechanisms would also remove unrelated person/project
data. Historical Iceberg snapshots retain earlier rows and snapshot expiration
is disabled. Durable Object point-in-time recovery can retain pre-deletion data
for 30 days. These retention copies are not a completed physical erasure. Offline
desktop caches are cleared by the client cache upgrade when the updated app runs.

Deployment and current-storage deletion therefore have separate evidence from
provider-retained copies. Do not describe this checkpoint as erasure from every
historical storage layer.

## Changelog

### 2026-09-14 — Retire built-in meeting notes, preserve dictation

The product decision is to remove meeting notes and erase feature-owned data.
Hiding its entry point was rejected because it leaves stored content and backend
writers available. Cleanup retains content-free addresses so an interrupted R2
operation can resume. Shared dictation and external meeting integrations remain;
removing either would exceed the requested feature boundary. Empty legacy wire
fields remain temporarily for already-installed clients, and final schema removal
follows verified current-storage cleanup. Search authorization cleanup also fences
delayed publications before removing cache metadata.

### 2026-09-01 — The note list pages instead of stopping at 250

**What changed:** The sidebar's note list is cursor-paged and its scroll loads
the next page, so a workspace with more notes than `SIDEBAR_LIST_LIMIT` can
reach all of them. The mechanism is in
[`workstream-durable-object.md`](workstream-durable-object.md#changelog).

**Why:** The cap was a ceiling rather than a page — no cursor, no load-more —
so note 251 was unreachable. Harmless while the list was only read; not
harmless once a grouping's **Archive all** could select notes the reader had no
way to see and no way to restore.

**Considered and rejected:** Fencing the archive to the visible window and
leaving the list capped. That was the interim fix, and it makes 250 part of the
archive's semantics while still leaving the notes beyond it unmanageable.

**Consequences, and what a future change has to respect:** A note push carries
a page rather than the list, so anything reading one has to merge when it is
only the head — replacing unconditionally truncates a reader who has scrolled.

### 2026-09-01 — A note leaves with the sidebar grouping it sits in

**What changed:** Notes are now archived by a recency heading's **Archive all**,
alongside the work streams under it. The selection is one statement in
WorkspaceDO — `archiveWorkspaceNotesInRange` — fenced on the viewer owning the
note and the note not recording, which are the two refusals `archiveNote`
already makes one row at a time. The mechanism, the receipt that makes a retry
converge, and why notes do not travel by Queue are in
[`workstream-durable-object.md`](workstream-durable-object.md#changelog).

**Why:** A heading is one group to the person reading it, and clearing it left
the notes behind. Nothing here excluded them deliberately; the batch was built
over the work-stream directory, which notes are not in.

The set is frozen when the dispatch is, so what the
archive takes is what the confirmation counted rather than whatever matches by
the time it runs.

**Considered and rejected:** Looping the existing single-note archive over the
selection. That turns one group into N transactions with N chances to half
apply, and it would have to translate a 404 or a 409 per note into something
the confirmation dialog never promised — the fences belong in the selection, so
that a refused note is one that was never counted.

**Consequences, and what a future change has to respect:** The bulk selection
and `archiveNote` must keep refusing the same notes. If a new reason to refuse
an archive appears, it has to reach both, or **Archive all** becomes the way to
get past it.

### 2026-08-31 — Live capture blocks active-workspace changes

**What changed:** A meeting window registers capture with main before dictation
starts and releases it after capture stops. Main refuses workspace activation,
creation, invitation acceptance, and leave while that registration names the
active workspace. The inverse is fenced too: recording cannot start while any of
those workspace transitions is pending. Window teardown clears a stranded
registration or transition claim.

**Why:** Settings, the meeting window, and the main shell follow one active
workspace. Switching mid-recording would leave one live capture writing through
credentials and storage authority that the rest of the application had replaced.

**Considered and rejected:** Letting the meeting window keep its original
session independently. That creates a second active-workspace model and leaves
menu, Settings, sign-out, and note navigation disagreeing about which workspace
owns the window.

**Consequences:** A person must finish or stop recording before changing
workspaces. The guard is privileged state, but the renderer still owns capture
and finalization; main records only a window id and workspace id.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-29 — Note statements become typed WorkspaceDO methods, and the privacy outbox is written by the update itself

**What changed:** The note reads and writes `NoteService`, the privacy
notifier, the cleanup pass, and the Terminal revoked-import check sent as SQL
through the workspace runtime facade are now typed methods on `WorkspaceDO`
(`workspace-notes-protocol.ts`, `workspace-notes-storage.ts`). Appending a
segment — fence, duplicate check, sequence allocation, insert, recorded-time
bump — is one `transactionSync` instead of five round trips; archiving decides
`not_found` versus `recording` in the same transaction as the write instead of
classifying from a follow-up read; and the briefing compare-and-set returns a
`committed`/`stale` outcome witnessed by `RETURNING`. A note going
workspace-to-personal now writes its `note_privacy_change_outbox` row inside
the update's own transaction.

**Why:** The facade routes by table name, and a table missing from its list is
answered by the regional database as `no such table` — the defect class that
took automation run work streams down in production. A typed method cannot be
misrouted. The outbox write moved because the D1 trigger that used to produce
it (`notes_enqueue_public_to_private_change`, migration 0045) never travelled
to the object's schema at cutover, so since notes became WorkspaceDO-owned the
transition was recorded nowhere and the "now private" work-stream notices had
silently stopped; the Node fixture carried the legacy trigger and hid it.

**Considered and rejected:** Converting the create path too. It inserts the
`resources` row and the `notes` row as one atomic batch, and `resources`
belongs to another domain in this conversion; splitting the batch across a
typed method and a facade statement would open a partial-failure window the
batch does not have, so it stays on the facade until the resources domain
converts. Adding the missing trigger as a schema migration was also rejected:
the explicit write in the same transaction is equally atomic and keeps the
decision readable in the storage function rather than in DDL.

**Consequences:** The note tables stay on `WORKSPACE_LOCAL_TABLES` so an
accidental generic statement still routes to the object rather than failing as
a misleading regional `no such table`. Typed note mutations must do what
`executeRuntimeSql` did for facade writes: advance the `notes` sidebar
waterline inside the transaction, publish the list after it, and re-derive the
alarm after touching either note outbox. One finding to know:
`note_resource_deletion_outbox` has no writer left — its D1 trigger fed it,
0090 dropped the D1 source, and the object's schema routes deleted resource
refs through the generic `resource_object_deletion_outbox` — so the
`note_objects` maintenance pass only drains whatever the cutover imported.

### 2026-08-23 — Both meeting prompts state what a written answer is made of

**What changed:** `RESPONSE_FORMATTING_POLICY` is interpolated into the Control
Tower system prompt and the final-summary prompt, as its own block before the
OUTPUT section rather than appended to a sentence.

**Why:** Both briefings render through `MarkdownBody`, which renders no TeX, and
several routed models write `$\rightarrow$` when they mean an arrow. The
renderer repairs it either way — [`model-text-normalization.md`](model-text-normalization.md)
owns that — but the prompt is the half that keeps it out of the note resource the
rest of Rally reads back.

**Consequences:** The live prompt is written for latency, and this adds under
800 bytes to a system prompt whose cost is dominated by the transcript windows
beside it, so the per-pass price is noise. It is placed before OUTPUT so the
section list stays the last thing the model reads.

### 2026-08-18 — Note and resource authority moves into WorkspaceDO

**What changed:** Note rows, transcript segments, linked resource metadata,
privacy delivery and R2 lifecycle state now share WorkspaceDO SQLite. R2 remains
the note byte store; child agents retain only their work-stream links.

**Why:** A note is reusable workspace product data and its generated resource is
updated in the same lifecycle. D1 was a second authority with no ownership
advantage.

**Considered and rejected:** Copying note metadata into every work stream and a
D1 resource projection. Both create stale visibility/lifecycle state.

**Consequences:** Briefing compare-and-set and resource pointer updates execute
against one workspace authority. Cross-work-stream consumers authorize through
WorkspaceDO rather than joining through D1.

### 2026-08-14 — The live pass declines the harness's transport retry

**What changed:** `transportRetries` is `0` for the live pass and the
deployment's `HARNESS_TRANSPORT_RETRIES` (default `1`) for the final one. The
harness now waits out a clamped backoff and re-requests when a provider fails a
turn; the live pass opts out of that.

**Why:** the recovery for a live pass is the *next* pass, not this one. Refreshes
are a minute apart and each reads the same transcript window, so a briefing that
lands late is worth less than the next one landing on time — and the wait is not
free against a 60s wall clock, since the backoff honours `Retry-After` up to 30
seconds. The final pass has no successor, so a lost summary is lost.

**Considered and rejected:** letting both passes take the default. That spends up
to half the live wall clock waiting to deliver a briefing the next tick
supersedes, and on a stalled provider it turns a skipped refresh into a refresh
that misses its slot. Also rejected: hardcoding `1` for the final pass, which
read the same but silently outranked an operator setting the variable to `0` to
damp load during an incident.

**Consequences:** anyone raising the live budget is trading the cadence for a
single briefing, which is the wrong trade at 60 seconds; if the cadence ever
becomes long enough that a missed pass matters, revisit this together with
`CONTROL_TOWER_REFRESH_SECONDS` rather than on its own. The retry also shares the
final pass's 120s wall clock, and the harness declines it outright when what
remains cannot hold another attempt.

### 2026-08-13 — Recording adoption is measurable without meeting content

**What changed:** Note creation, start permission/capture outcome,
transcription pause/resume, terminal completeness, summary-generation outcome,
reopen, visibility changes, and summary/transcript copy now emit typed telemetry
with the note UUID and bounded state/performance metadata.

**Why:** A note existing after a meeting does not show which entrypoint started
it, where capture failed, whether it paused or finalized partially, whether
summary generation succeeded, or whether the resulting artifacts were reopened
and useful enough to copy.

**Considered and rejected:** Capturing button clicks before the operation,
permission error strings, transcript/summary text, clipboard values, and a fresh
unknown audio source on every transition. Those options produce false success,
expose content, or erase the stable capture configuration.

**Consequences:** Events follow Product analytics and regional routing. The
meeting path remains authoritative; failed state changes emit nothing, and
telemetry failure cannot affect recording or finalization.
### 2026-08-12 — Closing a recording window asks first, and Command-W can now do the closing

**What changed:** `meeting:close-requested` carries a reason — `user` or `quit`.
A `user` close arriving while the recording is still running opens a
confirmation instead of finalizing immediately; **End and close** runs the path
that was already there, **Keep recording** does nothing at all. A `quit` close
behaves exactly as before. The same change added `File → Close Window` to the
macOS application menu, which is what made this urgent: Command-W was unbound in
every Rally window, so the only ways to close a meeting were the traffic light
and **End**.

**Why:** Command-W is the gesture macOS names first for closing a window, and it
was missing because Electron's `windowMenu` role carries `close` on every
platform except darwin, where Apple keeps it in File. Adding it put a
one-keystroke, no-aim close on a window that can be holding an unfinalized
meeting — a transcript tail still buffered in the renderer, no final summary, and
a note not yet marked complete. Finalization does run on that path, but it takes
seconds and a network round trip, and a person who hit the wrong key has no way
to say so. The traffic light had the same exposure and simply had not been worth
a dialog when it took a deliberate mouse trip to reach.

**Considered and rejected:** Prompting on every native close, which is the
smaller diff and the wrong behavior — during a quit, a window waiting on an
answer is a window that vetoes the quit, and Rally would be left running with
its status item alive and a dialog nobody went looking for. That is the same
hazard the `will-quit` comment in `main/index.ts` already guards, from the other
direction. So the reason is decided in the main process, where the quit cascade
is visible, rather than inferred in the renderer, which cannot see one. Also
rejected: keeping the window open when finalization fails after a confirmation,
by analogy with **End**. **End** is a request to finish the meeting and stay;
this is a request to close, already confirmed once, and asking twice about the
same intent is how a window becomes impossible to shut.

**What a future change has to respect:** the quit path stays unprompted, and the
`quitting` flag is a state rather than a moment. It cannot be cleared at
`will-quit`, because a meeting window finalizes asynchronously and therefore
vetoes the very quit that set it — `will-quit` never fires, and a flag left
standing would silence the confirmation for the rest of the session. It also
cannot be cleared on a timer keyed to the cascade, which review caught before
this landed: `NativeWindowMac::Close` defers a close while the window is
mid-fullscreen-transition, so the `close` event can arrive after any such reset
and be answered with a dialog — vetoing the quit silently, the exact outcome the
reason exists to prevent. The last meeting window to close is what lowers it,
because a meeting window is the only thing that vetoes a quit in the first
place. An unreadable reason must keep resolving to `quit`: failing to ask closes
a window, failing to close hangs a quit.

### 2026-08-11 — One meeting keeps one cadence, and the client is what keeps it

**What changed:** The meeting screen settles its cadence once and never replaces
it: the segment timer does not arm until the served value lands or
`MEETING_CADENCE_REQUEST_TIMEOUT_MS` passes, and capture is not made to wait for
either. That snapshot now travels with every live generate request as
`refreshSeconds`, bounded by the same range the flag is clamped to, and the
server resolves the flag itself only when a request does not carry one.

This supersedes two things said below. The entry beneath it has the generator
resolving the flag per pass, which is what this replaces; and the entry below
that says the two cadence constants must stay equal, which stopped being true
when they became one. Both entries stand as written — they are the record of
what was believed when each shipped.

**Why:** Two reviewers found the same drift from opposite ends. The client
snapshots at window open and the server re-resolved per pass, so any flag change
mid-meeting left the prompt telling the model it runs again in five minutes while
the client kept ticking every sixty seconds — and the prompt's reuse and latency
instructions are calibrated on exactly that number, so they were being calibrated
against a schedule nobody was on. The second half was worse and nearly invisible:
the cadence fetch raced auto-start, so a slow answer re-armed a timer that was
already running and moved the first segment boundary — the transcript's own
structure, not just the schedule.

**Considered and rejected:** Blocking `startRecording` on the cadence, which is
what a naive reading of "snapshot before you start" produces. It makes a feature
flag a precondition for capturing audio in a meeting that is already happening,
which is the one thing this loop must never wait for. Holding only the *timer*,
with a bounded request behind it, gets one interval per meeting at no cost to
capture. Also rejected: snapshotting the cadence server-side per note, which
needs per-meeting state the server does not have — that is the Durable Object in
[Open questions](#should-generation-move-to-the-server), not a fix for this.

Two smaller review findings landed with it. `revealNoteInMainWindow` raised
nothing when the main window existed but was still loading, so pressing **End**
during a reload closed the meeting window onto whatever was behind it — every
path now ends with a window in front of the person. And the attribute loader
now shares an in-flight read between evaluations describing the same subject:
this service resolves two flags for one person at once, and the cache is only
written when a read resolves, so a cold isolate was paying for the same rows
twice on the path that now runs once a minute per recording meeting.

**Consequences:** The prompt's cadence is now client-asserted. That is safe
because the schema bounds it to what the flag itself could serve and it phrases
one sentence — but it means a future reader must not mistake it for an
authorization: nothing about spend or scheduling follows from it. A flag change
now reaches a meeting only at its next recording, which is the intended
granularity and worth remembering when staging a rollout: meetings in progress
finish on the cadence they started with. And a client that sends no
`refreshSeconds` still works, so the field cannot be made required without
breaking older desktops.

### 2026-08-11 — A live refresh coalesces instead of queueing, and End only closes on a clean finish

**What changed:** A `live` refresh raised while one is still running now returns
the pass in flight rather than queueing another behind it. `finalizeRecording`
resolves to whether the meeting finished cleanly, and **End** closes the window
only when it did — previously a failed final summary or segment save closed the
window anyway, because both report through visible state rather than by
rejecting, and only a failed `updateNote` reached the caller. The empty state
also describes the cadence it was served instead of naming one minute.

**Why:** All three are consequences of the two entries below, found in review of
the same change. A one-minute cadence is short enough that a pass can overrun it
and a fifteen-second floor makes that routine: each tick was adding an inference
for segments the next pass would summarize anyway, and finalization had to drain
the whole backlog before it could start. The close behavior was documented as
"only on a clean finalization" and was not that — the summary is the failure most
worth staying open for, since nothing in the note screen can ask for it again.
And a served cadence makes any number in the copy a promise the app may not keep.

**Considered and rejected:** Skipping the *commit* as well when a refresh is
already running. The commit is the durable half and the only thing that makes
that minute of speech recoverable; dropping it to save an inference loses
transcript. Also rejected: closing the window on any finalization and surfacing
the error on the note screen instead, which would mean building a regenerate
affordance there — worth doing, but a larger change than this review finding.

**Consequences:** `generateNotes` and `finalizeRecording` now report success as a
resolved `boolean` rather than by rejecting, so a caller that ignores the value
silently ignores a failure — the two tests that hold this both fail vacuously if
written to assert only on the happy path, which is how the queueing bug survived
its first test. A meeting that repeatedly fails to summarize now leaves its
window open, which is deliberate but means a person can accumulate meeting
windows if the service is down; if that becomes the common failure, the answer is
a regenerate control on the note screen, not closing over the error.

### 2026-08-11 — The refresh cadence is served from Flagship rather than compiled in, and ending a meeting closes its window and opens the note

**What changed:** `control-tower-refresh-seconds` is now a Flagship flag,
resolved by `control-tower-flags.ts` and read by both ends: the meeting screen
asks `GET /feature-flags` when it opens and sets its timer from the answer, and
the meeting-notes generator resolves the same flag for the same person and states
the number in the live request. The prompt no longer names a fixed interval. The
desktop's two cadence constants became one fallback,
`DEFAULT_MEETING_NOTES_INTERVAL_MS`, whose value comes from the same
`CONTROL_TOWER_REFRESH_SECONDS` declaration the server clamps against.

In the same change, **End** now closes the meeting window once finalization
succeeds and takes the main window to that note, raised, via an
`avalon://notes/<id>` deep link the main process sends only to the main window.
`closeMeetingNotes` carries an optional note id for it, validated as a uuid in
the main process like every other IPC argument. A failed finalization leaves the
window open; the native close path is unchanged.

**Why:** The cadence set by the entry below is the single most consequential
number in this module — it multiplies inference spend, transcript row count, and
how current the product feels — and it was reachable only by shipping a desktop
build. That is the wrong instrument for a number that wants tuning against real
meetings and real cost, and worse, the client is what keeps the schedule, so a
number in the client is a number the server cannot revise for a fleet that has
already installed it. The prompt made it sharper still: it tells the model to
reuse what it wrote last time *because* it runs again shortly, so a cadence the
prompt describes differently from the one the client keeps is a briefing written
for a schedule nobody is on.

The window used to sit there after End showing a finished summary, which left
the person to close it and find the note themselves — two steps to reach the
thing they had just made, in a window that no longer had a job. The note is where
the summary lives permanently, and it is the surface with the sharing, archiving,
and transcript controls the meeting window deliberately lacks.

**Considered and rejected:** For the cadence: reading it through the
main-process poll that serves Application → Developer. That poll exists so both
windows read one answer and so `application-settings.json` has an owner; a
cadence is neither, and re-reading it every minute would move a recording's own
segment boundaries mid-meeting. Asking once, in the renderer that acts on it,
gives a meeting one cadence for its whole length. Also rejected: interpolating
the cadence into the system prompt, which is a module constant the harness
re-renders every turn — run data belongs in the request, and a prefix that
varies per call is a cache that stops working.

For End: having the meeting window navigate itself and stay open. It is a
separate 1120×820 window opened for a recording; keeping it around as a second
note viewer means two windows can show one note and disagree. Also rejected:
adding an IPC channel for "navigate the main window". The deep-link channel
already carries exactly this and the renderer already has a dispatcher for it —
a second mechanism would be a second place to keep in step. It is sent only to
the main window rather than through `sendDeepLink`, because the settings
renderer has no business navigating because a meeting ended.

**Consequences:** Three readers now have to agree on one number, and they do only
because the default and its bounds are declared once in `@rally/contracts`;
adding a fourth reader means reading that declaration, not copying 60. The
resolver clamps to 15–600 seconds before serving, so a flag typed in
milliseconds costs a warning rather than a meeting's worth of inference — but
nothing enforces the served cadence at the point of spend, because the client
still keeps the clock. That is now the whole remaining gap, and
[Open questions](#should-generation-move-to-the-server) is where the rest of it
lives. Provisioning is one flag with no rules, seeded at the default: until it
exists in the `avalon-api` app, every reader falls through to sixty seconds,
which is exactly the behavior this entry replaced.

The note link is internal: `emitDeepLink` does not accept `avalon://notes/...`
from the operating system, so a note cannot be opened by anything outside the
app, and widening that is a deliberate decision about an unauthenticated entry
point rather than a formality. Any future caller of `closeMeetingNotes` has to
decide whether it is handing the person onward or just closing a window; passing
the id always would make every close a navigation, including the ones that are
really an app quit.

### 2026-08-11 — Control Tower refreshes every minute, and its prompt is written for a ten-second run

**What changed:** The segment commit and Control Tower refresh moved from five
minutes to sixty seconds, and the live prompt was rewritten around latency: it
now states the refresh cadence, sets an explicit ten-second target, tells the
model to write in one pass without planning or revising, tells it to reuse
still-true lines from the previous briefing, and lowers the length target from
180–350 words to 150 with a 250-word ceiling. This document was created in the
same change; the module had none before.

**Why:** At a five-minute cadence the briefing was systematically behind the room.
The attendee who most needs it — someone just asked a question after
multitasking — is the one for whom a briefing describing the conversation as it
stood up to five minutes ago is worthless, and the product promise is that they
can re-enter the conversation, not that they can read about the part they already
missed. Once refreshes are a minute apart, generation latency becomes the whole
problem: a pass that deliberates for thirty seconds is a briefing that is stale
before it renders. The prompt is where that is fixed, because the cost of a
briefing is dominated by how much the model decides to write and how much it
reconsiders before writing it.

**Considered and rejected:** Enforcing the deadline mechanically — a shorter
harness wall clock, a hard output cap, or cutting reasoning effort further. A
truncated briefing is worse than a slightly slow one, and a wall clock that fires
produces no briefing at all rather than a shorter one; the model can trade
completeness for speed gracefully and a timeout cannot. Also rejected: refreshing
every minute while keeping five-minute transcript commits. That decouples the
refresh from the evidence it summarizes and buys nothing — four of every five
refreshes would re-summarize a transcript that had not changed.

**Consequences:** Inference volume for a recording rises roughly fivefold, and
the cost ceilings in `meeting-notes-service.ts` are per-pass, so a long meeting's
total is now bounded only by its length. Transcript segments are five times as
numerous for the same meeting, which makes `note_transcript_segments` the row
count to watch first if note storage grows unexpectedly. The two cadence
constants must stay equal and must stay a commit-then-refresh pair. Anyone
editing the live prompt is editing a latency budget as much as a content spec:
adding a section, a rule, or length back is a direct cost to how current the
briefing is. It also makes the client-owned cadence the design's weakest point,
since spend now scales with a schedule the server does not control — the way out
is sketched under [Open questions](#should-generation-move-to-the-server). The
reasoning behind the module's design before this date is not recorded and was not
reconstructed.
