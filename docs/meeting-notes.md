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
segment protocol, or the note resource that the rest of Avalon reads. The
realtime dictation transport that feeds it belongs to
[`SECURITY.md`](SECURITY.md) and [`RUNBOOK.md`](RUNBOOK.md); this document starts
at the transcript text the client already holds.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/screens/meeting-notes.tsx` | The recording screen and the only clock in the system. Reads the served cadence when it opens, commits each segment, requests each refresh, and drives finalization. `DEFAULT_MEETING_NOTES_INTERVAL_MS` is the fallback for a device that could not ask. |
| `apps/desktop/src/renderer/lib/use-realtime-dictation.ts` | Audio capture and the provider socket. `commit()` closes a segment without ending the session; `stop()` ends it and returns the last buffered text. |
| `apps/api/src/routes/notes.ts` | `POST /notes/:id/segments` appends a segment; `POST /notes/:id/generate` runs a `live` or `final` pass. |
| `apps/api/src/services/note-service.ts` | Segment sequencing, the transcript windows handed to the model, the compare-and-set that lands a briefing, and materialization of the note resource. |
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
resolved by `control-tower-flags.ts` ([`FEATURE_FLAGS.md`](FEATURE_FLAGS.md)).
The meeting screen asks `GET /feature-flags` once when it opens — a meeting
window exists for one meeting, and a cadence that moved underneath a recording
would move the transcript's own segment boundaries mid-conversation. The
meeting-notes generator resolves the same flag for the same person and states the
number in the live request, so the prompt's instruction to reuse what it wrote
last time is calibrated to the gap the client is actually keeping.

Three readers therefore have to agree, and they do because the default and its
bounds are declared once as `CONTROL_TOWER_REFRESH_SECONDS` in
`@avalon/contracts`: the desktop's fallback, the response schema, and the clamp
the resolver applies. A device that cannot reach the service, an older service
that does not know the field, and an unreachable Flagship all land on the same
sixty seconds.

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
`agent-model-meeting-notes` flag ([`FEATURE_FLAGS.md`](FEATURE_FLAGS.md)).

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
close** — the traffic-light button, or app quit — finalizes and then closes
regardless, since a window that refuses to shut also blocks quit; it does not
navigate, because closing a window is not a request to be taken somewhere.

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
- **The meeting window closes only when the meeting finished cleanly.** Anything
  that closes it on a failure discards the only report of that failure.
- **Only the owner may record, append, or generate.** Every statement binds
  `workspace_id` and `owner_user_id`; the screen is read-only for anyone else.

## Boundary

This module owns the recording screen, the transcript segment protocol, both
prompts, and the note resource it materializes. It exposes notes to the rest of
Avalon only as that resource — nothing else reads `note_transcript_segments`.
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
| Recent focus window | 10 min | `RECENT_TRANSCRIPT_WINDOW_MS` |
| Complete transcript context | 400,000 chars, middle elided | `MAX_TRANSCRIPT_CONTEXT_CHARACTERS` |
| Recent window context | 100,000 chars | `MAX_RECENT_TRANSCRIPT_CHARACTERS` |
| Previous briefing context | 50,000 chars | `MAX_NOTES_CONTEXT_CHARACTERS` |
| Harness wall clock | 60s live, 120s final | `meeting-notes-service.ts` |
| Cost ceiling | 100¢ live, 200¢ final | `meeting-notes-service.ts` |

- **Inference fails or times out.** The screen shows "Avalon could not update
  Control Tower" and keeps the previous briefing. Nothing is retried at the same
  model; the next refresh is the retry.
- **The cadence cannot be fetched, or Flagship is unreachable.** Both ends fall
  back to `CONTROL_TOWER_REFRESH_SECONDS.default`, so the loop runs unchanged; a
  cadence outside the bounds is clamped and logged rather than served.
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

- `pnpm --filter @avalon/api exec vitest run test/meeting-notes-service.test.ts`
  — prompt selection, the shape of each request, and the safe error on failure.
- `pnpm --filter @avalon/api exec vitest run test/note-service.test.ts` — segment
  sequencing, the recent-window slice, and the final-summary race retry.
- `pnpm --filter @avalon/api exec vitest run test/client-feature-flags.test.ts` —
  the served cadence, its clamp, and the fallback shared with every other reader.
- `pnpm --filter @avalon/desktop exec vitest run src/renderer/screens/meeting-notes.test.tsx`
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
   Durable Object per active note — the same shape as `WorkspaceScheduler`, which
   already owns alarms and idempotent run creation — accumulates finalized items
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
([`ARCHITECTURE.md`](ARCHITECTURE.md), [`RUNBOOK.md`](RUNBOOK.md)), so part 1 is
a change to what that boundary stores and where it comes to rest — it needs
[`SECURITY.md`](SECURITY.md) and [`REGIONALIZATION.md`](REGIONALIZATION.md) read
first, and it is the reason to do this deliberately rather than opportunistically.
Part 2 adds a Durable Object class to the runtime, which is a migration and an
[`ARCHITECTURE.md`](ARCHITECTURE.md) entry. Both parts have to land before part 3
is anything but a second scheduler racing the client's.

Until then, the client-*kept* cadence is a known and accepted gap, and the
compare-and-set in `generateAttempt` is the only thing standing between two
enthusiastic clients and a corrupted briefing. Note that part 3 is what turns the
served cadence into an enforced one: the flag already exists and the server
already reads it, so that step is a scheduler and a budget rather than a new
knob.

## Changelog

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
because the default and its bounds are declared once in `@avalon/contracts`;
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
