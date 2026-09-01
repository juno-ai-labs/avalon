# Meeting notes and Control Tower

A meeting note is a recording, its transcript, the attendee's own writing, and a
model-written briefing that is rewritten while the meeting is still happening.
The briefing is **Control Tower**: a complete replacement summary of the
conversation so far, regenerated on a served cadence — once a minute by default —
so someone who was multitasking, stepped away, or was just asked a question can
re-enter the conversation in about thirty seconds of reading. When recording
ends, a second, different pass replaces the live briefing with a durable
whole-meeting summary.

Read this before changing the recording cadence, either prompt, the transcript
segment protocol, or the note resource that the rest of Rally reads. The
realtime dictation transport that feeds it belongs to
[`security.md`](security.md) and [`runbook.md`](runbook.md); this document starts
at the transcript text the client already holds.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/screens/meeting-notes.tsx` | The recording screen and the only clock in the system. Reads the served cadence when it opens, commits each segment, requests each refresh, and drives finalization. `DEFAULT_MEETING_NOTES_INTERVAL_MS` is the fallback for a device that could not ask. |
| `apps/desktop/src/renderer/lib/use-realtime-dictation.ts` | Audio capture and the provider socket. `commit()` closes a segment without ending the session; `stop()` ends it and returns the last buffered text. |
| `apps/api/src/routes/notes.ts` | `POST /notes/:id/segments` appends a segment; `POST /notes/:id/generate` runs a `live` or `final` pass. |
| `apps/api/src/services/note-service.ts` | The transcript windows handed to the model, generation orchestration and its final-pass retry, and materialization of the note resource. Reaches the note rows as typed WorkspaceDO methods; its one remaining facade write is the create batch that spans `notes` and `resources`. |
| `apps/api/src/durable-objects/workspace-notes-protocol.ts` | The Zod request and result schemas for the note methods on WorkspaceDO, including the row contracts that used to be asserted in the service. |
| `apps/api/src/durable-objects/workspace-notes-storage.ts` | The note SQL, against the object's own storage: segment sequencing, the archive classification, the briefing compare-and-set, the privacy-transition outbox write, and the sidebar read shared with the workspace socket. |
| `apps/api/src/services/meeting-notes-service.ts` | Both system prompts, both example sets, and the harness configuration each pass runs under. `CONTROL_TOWER_SYSTEM_PROMPT` is the live briefing; `FINAL_MEETING_SUMMARY_SYSTEM_PROMPT` is the end-of-meeting one. |
| `apps/api/src/services/control-tower-flags.ts` | The one resolver for the refresh cadence, read by both the client's `GET /feature-flags` answer and the live prompt. Clamps and logs what Flagship serves. |
| `packages/contracts/src/index.ts` | `CONTROL_TOWER_REFRESH_SECONDS` — the cadence default and its bounds, defined once for every reader — plus `GenerateNoteNotesRequest`, `NoteDetail`, `NoteTranscriptSegment`, and the `recentTranscript` bound. |

## How it works

### The refresh loop

While dictation is listening, the recording screen sets a single timer for the
cadence it was served. When it fires it commits the audio buffer, appends the
finalized text as a transcript segment, and only then asks for a `live` refresh.
One timer rather than two: the commit is what makes the last minute of speech
visible to the refresh that follows it, so a refresh scheduled independently of a
commit would summarize a transcript that stops a full cadence short. The timer
re-arms because the commit takes dictation out of `listening` and back.

A refresh raised while one is still running is **coalesced, not queued** — the
caller gets the pass already in flight. The commit still happens, so no speech is
lost, but a second inference for it is not: a live briefing replaces the last one
rather than adding to it, so the next pass summarizes those segments anyway.
Queueing them instead would let a pass slower than the cadence — always possible
at 60 seconds, and the normal case at the 15-second floor — build a backlog that
costs an inference per tick and has to drain before finalization can even start.

### Where the cadence comes from

The cadence is the `control-tower-refresh-seconds` flag, served from Flagship and
resolved by `control-tower-flags.ts` ([`feature-flags.md`](feature-flags.md)).
**One meeting keeps one cadence**, and the client is what keeps it:

1. The meeting screen asks `GET /feature-flags` once when it opens, and the
   answer is never replaced — a cadence arriving later would re-arm the segment
   timer mid-recording and move a transcript boundary with it.
2. Capture does not wait for that answer; the **segment timer** does, and only
   for `MEETING_CADENCE_REQUEST_TIMEOUT_MS`. Recording starts as soon as the note
   loads, and a request that has not answered by then settles the meeting on the
   default. Arming on the default and re-arming on the served value would produce
   exactly the moved boundary the snapshot exists to prevent.
3. Every live generate request carries that snapshot, so the prompt's cadence is
   the schedule being kept rather than whatever the flag says at the moment the
   server reads it. The server resolves the flag itself only when a request does
   not carry one, which is what an older client looks like.

The bounds in the request schema are what make a client-sent cadence safe to
repeat back to the model: it can only name a cadence the flag itself could serve,
and it phrases one sentence rather than authorizing anything. What a meeting
spends is bounded by how often the client asks, which it already controls — see
[Open questions](#should-generation-move-to-the-server).

Every reader agrees on the fallback because the default and its bounds are
declared once as `CONTROL_TOWER_REFRESH_SECONDS` in `@rally/contracts`: the
desktop's fallback, both request schemas, and the clamp the resolver applies. A
device that cannot reach the service, an older service that does not know the
field, and an unreachable Flagship all land on the same sixty seconds.

Segments are sequenced by the server. `appendSegment` allocates
`next_segment_sequence` with a single `UPDATE … RETURNING`, so two windows
recording the same note cannot collide, and a retried append carrying the same
`clientSegmentId` returns the row that already exists rather than duplicating it.

### What the model is given

A `live` pass receives four things, all as user-role content: the previous
briefing as an explicitly labelled continuity hint, the attendee's own notes, the
complete ordered transcript, and the most recent ten minutes of it again as a
focus window. The complete transcript is the source of truth; the window is only
where the emphasis goes. A `final` pass receives the complete transcript, the
attendee's notes, and meeting metadata — and deliberately **not** the live
briefing, so an error that survived several refreshes cannot launder itself into
the durable summary.

Both passes run through the agent harness with no tools, no plugins, and no web
search, capped at a single iteration. The live pass runs at low reasoning effort
and the final pass at medium; the model is chosen by the
`agent-model-meeting-notes` flag ([`feature-flags.md`](feature-flags.md)).

### Why the live prompt reads the way it does

`CONTROL_TOWER_SYSTEM_PROMPT` is written for latency as much as for content. It
gives the model an explicit ten-second target, tells it to write in one pass
without planning or revising, tells it to reuse still-true lines from the
previous briefing nearly verbatim, and tells it that dropping a marginal bullet
is the safer error. Those are instructions, not limits — nothing in the code
enforces a deadline shorter than the harness wall clock, and the model is trusted
to trade completeness for currency because a briefing that lands after the
conversation moved on has no value to trade away.

The cadence itself is *not* in the system prompt. It is served by a flag, so it
goes in the request beside the transcript: run data stays out of the cached
prefix, and prose naming a fixed interval would have gone quietly wrong the first
time the flag moved.

### Ending a meeting

**End** stops capture, commits whatever the provider finalizes, runs the `final`
pass, and marks the note complete — in that order, because a summary written
before the last segment lands is a summary missing the end of the meeting. Then
the window closes and the main window is taken to the note, raised, through the
same deep-link channel every other navigation uses (`avalon://notes/<id>`, sent
by the main process only to the main window). The meeting window exists for the
recording; once there is no recording, the note is what the person wants to be
looking at.

Two paths do not end that way. If anything went wrong — the transcript could not
be closed, the last segment could not be saved, the final summary failed, or the
note could not be marked complete — the window stays open, because it is the only
place any of those is reported and the note screen cannot ask for a summary
again. `finalizeRecording` resolves to whether the meeting finished cleanly for
exactly this decision; a failure that only sets a visible error, as the summary
does, would otherwise be indistinguishable from success. And a **native window
close** — the traffic-light button, Command-W, or app quit — finalizes and then
closes regardless, since a window that refuses to shut also blocks quit; it does
not navigate, because closing a window is not a request to be taken somewhere.

The main process says **who asked**, and the window is allowed to stop and ask
only for one of the two answers. A `user` close — that window's traffic light or
Command-W — while a recording is still running raises a confirmation, because
until finalization lands this window *is* the meeting: the transcript tail is
still buffered in it, the final summary has not been written, and the note is not
marked complete. **End and close** takes the native path from there; **Keep
recording** leaves the window and the capture exactly as they were. A `quit`
close is never asked, and this is the load-bearing half: a meeting window that
stopped to confirm would veto the quit and leave Rally running with a dialog
nobody went looking for. `before-quit` raises the flag and the last meeting
window to close lowers it, so it says *a quit was requested and has not
finished* rather than *a quit was requested just now* — the close it describes
can arrive later than the cascade, and a window mid-fullscreen-transition on
macOS is where it does. Anything the preload cannot read as `user` is treated as
a quit.

Before capture starts, the meeting renderer registers its active workspace with
Electron main. Switching, creating, joining, or leaving a workspace is refused
while any meeting window is recording against the workspace being left. The
guard is released only after capture stops, and closing the meeting window
removes it as a backstop. A recording's note, transcript, and socket authority
therefore cannot move regions or workspaces underneath it.

### Product telemetry

A newly created recording note reports its opaque note UUID, private/public
state, and proved entrypoint (`sidebar`, `menu_bar`, or `unknown`). Successful
capture transitions report start, pause, resume, and complete with the same note
UUID and the microphone/system-audio availability established at start. The
audio-source class remains stable across the recording; pause and completion do
not discard it. A separate start outcome records only a bounded permission/result
class, and terminal settlement records duration, pause/segment buckets, summary
result, and complete/partial/failure class. The API records live/final summary
generation result and cadence after each authoritative attempt. Reopening a note
records entrypoint plus bounded duration/segments and whether durable transcript
or summary artifacts exist. Successful visibility and copy actions report only
closed action or content classes and the note UUID. Transcript, briefing, title,
manual notes, clipboard value, raw permission errors, and captured audio never
enter telemetry. These product events are best-effort and cannot alter recording,
summary generation, or persistence.

### Landing a briefing

`generateAttempt` reads `notes_through_sequence` before inference and writes the
result with a compare-and-set on both that cursor and `generated_at`. If another
pass landed while this one was running, the update matches no row and the stale
result is discarded rather than overwriting newer notes. A `final` pass that
loses this race re-reads the transcript and retries once, because a whole-meeting
summary must not be lost to a live refresh that happened to finish later.

Every write materializes the note resource: a human-readable `note.md` and a
`note-model.md` whose transcript carries segment timestamps, both in R2, plus the
`resources` row that agents and work streams read. That is the only view of a
note anything outside this module has. Each key is fixed per note and every write
overwrites it, so the objects are the current note rather than a history of
briefings.

The `notes`, `note_transcript_segments`, linked `resources`, privacy outbox and
R2 lifecycle refs are authoritative in WorkspaceDO. R2 owns the two byte
objects; D1 has no note/resource serving projection. Work-stream attachment
links remain in the selected SubstreamAgent and resolve the current WorkspaceDO
resource separately.

## Invariants

- **A refresh is preceded by a segment commit.** Decoupling them silently
  produces briefings that are one cadence stale — the failure looks like a slow
  model rather than a scheduling bug.
- **The complete transcript is the source of truth, and the previous briefing is
  a hint.** Both prompts say so. A change that promotes prior model output to
  evidence makes one bad refresh permanent.
- **The final summary never sees the live briefing.** `note-service.ts` passes an
  empty `previousNotes` for `final`, and a test asserts the live prose does not
  reach the request.
- **A briefing only lands if the segment cursor and `generated_at` are unchanged.**
  Anything that relaxes the compare-and-set reintroduces lost final summaries.
- **Transcript, notes, and metadata are untrusted meeting content.** They travel
  as user-role messages and both prompts refuse instructions found inside them.
- **A `live` pass with no new segments does no inference.** It materializes and
  returns, which is what keeps a silent minute from costing an inference.
- **At most one live refresh is in flight per window.** Removing the coalescing
  turns a slow pass into an unbounded queue of them, and the symptom is a bill
  and a stuck **End**, not a visibly broken briefing.
- **A meeting's cadence is decided once and never replaced.** Anything that
  re-reads it mid-recording moves a segment boundary, and the transcript moves
  with it — the damage is in the evidence, not just the schedule.
- **The prompt's cadence is the client's, not the flag's.** A server that
  re-resolves the flag per pass describes a schedule nobody is on for the rest
  of any meeting the flag moved under.
- **The meeting window closes only when the meeting finished cleanly.** Anything
  that closes it on a failure discards the only report of that failure.
- **Only a `user` close may stop to ask.** A quit that a window can answer with a
  dialog is a quit that can be vetoed by one, and the veto is silent — Rally
  stays up with no window in front of anyone. A close whose reason cannot be read
  is a quit.
- **Only the owner may record, append, or generate.** Every statement binds
  `workspace_id` and `owner_user_id`; the screen is read-only for anyone else.

## Boundary

This module owns the recording screen, the transcript segment protocol, both
prompts, and the note resource it materializes. It exposes notes to the rest of
Rally only as that resource — nothing else reads `note_transcript_segments`.
Its one outward gesture is the `avalon://notes/<id>` deep link it asks the main
process to deliver when a meeting ends; the main window's router owns what
happens next.

It does not own audio capture, the realtime bridge, or the provider credentials
behind it; it does not own model selection, which is a flag; and it does not own
what happens when a note's scope changes, which is
`note-privacy-notification-service.ts` publishing to affected work streams.

## Failure modes and limits

| Limit | Value | Where |
| --- | --- | --- |
| Segment commit and refresh cadence | 60s by default, 15–600s as served | `control-tower-refresh-seconds`, bounded by `CONTROL_TOWER_REFRESH_SECONDS` |
| Cadence request before the timer arms on the default | 5s | `MEETING_CADENCE_REQUEST_TIMEOUT_MS` |
| Recent focus window | 10 min | `RECENT_TRANSCRIPT_WINDOW_MS` |
| Complete transcript context | 400,000 chars, middle elided | `MAX_TRANSCRIPT_CONTEXT_CHARACTERS` |
| Recent window context | 100,000 chars | `MAX_RECENT_TRANSCRIPT_CHARACTERS` |
| Previous briefing context | 50,000 chars | `MAX_NOTES_CONTEXT_CHARACTERS` |
| Harness wall clock | 60s live, 120s final | `meeting-notes-service.ts` |
| Cost ceiling | 100¢ live, 200¢ final | `meeting-notes-service.ts` |
| Transport retries | 0 live; `HARNESS_TRANSPORT_RETRIES` (default 1) final | `meeting-notes-service.ts` |

- **Inference fails or times out.** The screen shows "Rally could not update
  Control Tower" and keeps the previous briefing. The live pass does not wait
  and re-ask even when the harness would otherwise retry a provider fault: it
  has a successor a minute away that reads the same transcript window, so a
  briefing that lands late is worth less than the next one landing on time. The
  final pass has no successor and takes the deployment's budget — shared with
  its 120s wall clock, so the harness declines the retry outright when what
  remains cannot hold another attempt, and the failure then reads as the
  provider's rather than as a time limit.
- **The cadence cannot be fetched, or Flagship is unreachable.** Recording starts
  regardless; the segment timer waits out
  `MEETING_CADENCE_REQUEST_TIMEOUT_MS` and the meeting settles on
  `CONTROL_TOWER_REFRESH_SECONDS.default`, which is also what the request then
  carries. A served cadence outside the bounds is clamped and logged rather than
  passed on.
- **A segment save fails during a refresh.** That minute's commit rejects and its
  refresh is skipped, leaving the segment's audio unrepresented until the next
  one; the next cadence tick starts a fresh segment from the boundary that failed.
  On **finalization** the rule is the opposite and deliberate: a failed final
  commit marks the transcript partial and the summary still runs over whatever
  reached the server, because there is no next tick to recover in.
- **The transcript outgrows the context bound.** Its middle is elided with a
  visible marker and `transcriptStatus` becomes `partial`. Only the final pass is
  told that — a live briefing is a working note that is replaced in seconds and
  says nothing about coverage, while the durable summary carries the caveat.
- **A refresh overruns its own cadence.** The tick that lands on top of it is
  coalesced into the pass in flight, so the loop skips rather than accumulates;
  refreshes are serialized on `generationTailRef`, and the compare-and-set
  catches anything that still overlaps across windows.

## Security and trust model

Meeting audio never reaches this module — only text the client already holds.
Everything a meeting produced is untrusted: transcript, attendee notes, meeting
title, and the previous briefing all enter as user-role messages under headings
that deny them authority, and neither system prompt is composed from note
content. Notes are per-owner within a workspace, and a personal note becoming a
workspace note is an explicit, notified transition rather than a silent widening.

## Testing

- `pnpm --filter @rally/api exec vitest run test/meeting-notes-service.test.ts`
  — prompt selection, the shape of each request, and the safe error on failure.
- `pnpm --filter @rally/api exec vitest run test/note-service.test.ts` — segment
  sequencing, the recent-window slice, and the final-summary race retry, driven
  through a real `WorkspaceDO` over its own schema via
  `test/helpers/workspace-object-rpcs.ts`.
- `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts
  test-workers/workspace-notes.test.ts` — what the object itself decides, on
  workerd: concurrent segment appends, replay idempotency, the archive
  classification, the privacy-transition outbox, the briefing compare-and-set,
  and the per-viewer read fences.
- `pnpm --filter @rally/api exec vitest run test/client-feature-flags.test.ts` —
  the served cadence, its clamp, and the fallback shared with every other reader.
- `pnpm --filter @rally/desktop exec vitest run src/renderer/screens/meeting-notes.test.tsx`
  — that a served cadence actually drives the timer, elapsed-time accounting
  across segment boundaries, and the finalization order (append, then generate,
  then mark complete).

Two traps in the desktop suite. The dictation hook is mocked, so the segment
timer only arms when the mocked `state` transitions into `listening` — a test
that renders with it already `listening` arms nothing, which is why the cadence
test rerenders to make the transition happen. And the fallback is asserted
against `CONTROL_TOWER_REFRESH_SECONDS` rather than a literal, so a default
changed in the contract cannot leave the client on the old one.

## Open questions

### Should generation move to the server?

Today the client is the whole schedule. The recording screen decides when a
transcript segment is committed and when a briefing is requested, and the Worker
only answers `POST /notes/:id/generate` when it is asked. That is the cheapest
thing that works, and at a five-minute cadence it was defensible. At sixty
seconds it is the design's weakest point, for three reasons:

- **Cadence is *served* but not *enforced*.** The number now comes from a flag
  the server owns, so the fleet's schedule is a console change rather than a
  release — but the client is still what keeps it. Every `live` request carrying
  a new segment is an inference, and the only brake is the
  `notes_through_sequence` check, which a client can defeat simply by committing
  a segment before each request. An old build, a modified build, or a bug in the
  timer can refresh far faster than the served cadence, and nothing on the server
  says no. Serving the number is the smaller half of this; the larger half is
  below.
- **The server cannot tell a finished meeting from a quiet client.** A note stays
  `recording` until a client says otherwise, and no briefing is ever produced for
  a meeting whose client crashed, slept, or lost the network mid-recording.
- **The transcript is client-asserted.** Segment text, offsets, and boundaries
  all arrive from the renderer, so the evidence the summary is built on is only
  as trustworthy as the process that sent it.

**The proposal, in three parts.** Each is useful alone, but the third is only
sound once the first two exist.

1. **Track the transcript on the server, from the transcription stream itself.**
   The regional Worker already terminates the provider socket and relays every
   provider frame to the desktop
   (`realtime-transcription-service.ts`) — including the finalized transcript
   items. It forwards them and persists nothing. Have the relay instead append
   each finalized item to the note as a transcript segment, and the server holds
   the authoritative transcript mid-meeting rather than a copy the client chose
   to send. `POST /notes/:id/segments` stays for text that did not come through
   the bridge, but stops being the primary path.

2. **Give an active recording a server-side owner.** The relay cannot hold the
   rolling transcript itself: a dictation connection is capped at five minutes,
   and the request scope dies with it, while a meeting is not so bounded. A
   Durable Object per active note — the same shape as WorkspaceDO's alarm half,
   which already owns alarms and idempotent run creation — accumulates finalized items
   across successive connections and owns one alarm at the cadence this document
   names. It also gives the server an answer to "is this meeting still going":
   an alarm that fires with no new audio for long enough finalizes the note
   itself.

3. **Make the refresh the server's decision.** The alarm generates only when new
   segments landed since `notes_through_sequence` — the check that already
   exists, moved to where it cannot be gamed — and a per-note inference budget
   plus a minimum interval floor bound what one meeting can spend regardless of
   what any client asks for. `POST /notes/:id/generate` with `mode: "live"` then
   becomes a rate-limited *refresh now* for a person who pressed a button, not
   the mechanism.

**What this costs and what has to be true first.** The dictation bridge
deliberately persists neither audio nor transcripts today
([`architecture.md`](architecture.md), [`runbook.md`](runbook.md)), so part 1 is
a change to what that boundary stores and where it comes to rest — it needs
[`security.md`](security.md) and [`regionalization.md`](regionalization.md) read
first, and it is the reason to do this deliberately rather than opportunistically.
Part 2 adds a Durable Object class to the runtime, which is a migration and an
[`architecture.md`](architecture.md) entry. Both parts have to land before part 3
is anything but a second scheduler racing the client's.

Until then, the client-*kept* cadence is a known and accepted gap, and the
compare-and-set in `generateAttempt` is the only thing standing between two
enthusiastic clients and a corrupted briefing. Note that part 3 is what turns the
served cadence into an enforced one: the flag already exists and the server
already reads it, so that step is a scheduler and a budget rather than a new
knob.

## Changelog

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

### 2026-08-11 — Ending a meeting closes its window and opens the note

**What changed:** **End** now closes the meeting window once finalization
succeeds and takes the main window to that note, raised, via an
`avalon://notes/<id>` deep link the main process sends only to the main window.
`closeMeetingNotes` carries an optional note id for it, validated as a uuid in
the main process like every other IPC argument. A failed finalization leaves the
window open; the native close path is unchanged.

**Why:** The window used to sit there after End showing a finished summary, which
left the person to close it and find the note themselves — two steps to reach the
thing they had just made, in a window that no longer had a job. The note is where
the summary lives permanently, and it is the surface with the sharing, archiving,
and transcript controls the meeting window deliberately lacks.

**Considered and rejected:** Having the meeting window navigate itself and stay
open. It is a separate 1120×820 window opened for a recording; keeping it around
as a second note viewer means two windows can show one note and disagree. Also
rejected: adding an IPC channel for "navigate the main window". The deep-link
channel already carries exactly this and the renderer already has a dispatcher
for it — a second mechanism would be a second place to keep in step. It is sent
only to the main window rather than through `sendDeepLink`, because the settings
renderer has no business navigating because a meeting ended.

**Consequences:** The link is internal: `emitDeepLink` does not accept
`avalon://notes/...` from the operating system, so a note cannot be opened by
anything outside the app, and widening that is a deliberate decision about an
unauthenticated entry point rather than a formality. Any future caller of
`closeMeetingNotes` has to decide whether it is handing the person onward or just
closing a window; passing the id always would make every close a navigation,
including the ones that are really an app quit.

### 2026-08-11 — The refresh cadence is served from Flagship rather than compiled in

**What changed:** `control-tower-refresh-seconds` is now a Flagship flag,
resolved by `control-tower-flags.ts` and read by both ends: the meeting screen
asks `GET /feature-flags` when it opens and sets its timer from the answer, and
the meeting-notes generator resolves the same flag for the same person and states
the number in the live request. The prompt no longer names a fixed interval. The
desktop's two cadence constants became one fallback,
`DEFAULT_MEETING_NOTES_INTERVAL_MS`, whose value comes from the same
`CONTROL_TOWER_REFRESH_SECONDS` declaration the server clamps against.

**Why:** The cadence set by the entry above is the single most consequential
number in this module — it multiplies inference spend, transcript row count, and
how current the product feels — and it was reachable only by shipping a desktop
build. That is the wrong instrument for a number that wants tuning against real
meetings and real cost, and worse, the client is what keeps the schedule, so a
number in the client is a number the server cannot revise for a fleet that has
already installed it. The prompt made it sharper still: it tells the model to
reuse what it wrote last time *because* it runs again shortly, so a cadence the
prompt describes differently from the one the client keeps is a briefing written
for a schedule nobody is on.

**Considered and rejected:** Reading it through the main-process poll that serves
Application → Developer. That poll exists so both windows read one answer and so
`application-settings.json` has an owner; a cadence is neither, and re-reading it
every minute would move a recording's own segment boundaries mid-meeting. Asking
once, in the renderer that acts on it, gives a meeting one cadence for its whole
length. Also rejected: interpolating the cadence into the system prompt, which is
a module constant the harness re-renders every turn — run data belongs in the
request, and a prefix that varies per call is a cache that stops working.

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
