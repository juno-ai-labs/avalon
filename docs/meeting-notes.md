# Meeting notes and Control Tower

A meeting note is a recording, its transcript, the attendee's own writing, and a
model-written briefing that is rewritten while the meeting is still happening.
The briefing is **Control Tower**: a complete replacement summary of the
conversation so far, regenerated once a minute so someone who was multitasking,
stepped away, or was just asked a question can re-enter the conversation in about
thirty seconds of reading. When recording ends, a second, different pass replaces
the live briefing with a durable whole-meeting summary.

Read this before changing the recording cadence, either prompt, the transcript
segment protocol, or the note resource that the rest of Avalon reads. The
realtime dictation transport that feeds it belongs to
[`SECURITY.md`](SECURITY.md) and [`RUNBOOK.md`](RUNBOOK.md); this document starts
at the transcript text the client already holds.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/screens/meeting-notes.tsx` | The recording screen and the only clock in the system: `MEETING_TRANSCRIPTION_SEGMENT_MS` and `MEETING_NOTES_INTERVAL_MS` are the one place the cadence is set. Commits each segment, requests each refresh, and drives finalization. |
| `apps/desktop/src/renderer/lib/use-realtime-dictation.ts` | Audio capture and the provider socket. `commit()` closes a segment without ending the session; `stop()` ends it and returns the last buffered text. |
| `apps/api/src/routes/notes.ts` | `POST /notes/:id/segments` appends a segment; `POST /notes/:id/generate` runs a `live` or `final` pass. |
| `apps/api/src/services/note-service.ts` | Segment sequencing, the transcript windows handed to the model, the compare-and-set that lands a briefing, and materialization of the note resource. |
| `apps/api/src/services/meeting-notes-service.ts` | Both system prompts, both example sets, and the harness configuration each pass runs under. `CONTROL_TOWER_SYSTEM_PROMPT` is the live briefing; `FINAL_MEETING_SUMMARY_SYSTEM_PROMPT` is the end-of-meeting one. |
| `packages/contracts/src/index.ts` | `GenerateNoteNotesRequest`, `NoteDetail`, `NoteTranscriptSegment`, and the `recentTranscript` bound. |

## How it works

### The one-minute loop

While dictation is listening, the recording screen sets a single timer for
`MEETING_TRANSCRIPTION_SEGMENT_MS`. When it fires it commits the audio buffer,
appends the finalized text as a transcript segment, and only then asks for a
`live` refresh. The two constants are one cadence rather than two knobs: the
commit is what makes the last minute of speech visible to the refresh that
follows it, so a refresh scheduled independently of a commit would summarize a
transcript that stops a full cadence short.

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
tells the model its refresh cadence, gives it an explicit ten-second target,
tells it to write in one pass without planning or revising, tells it to reuse
still-true lines from the previous briefing nearly verbatim, and tells it that
dropping a marginal bullet is the safer error. Those are instructions, not
limits — nothing in the code enforces a deadline shorter than the harness wall
clock, and the model is trusted to trade completeness for currency because a
briefing that lands after the conversation moved on has no value to trade away.

### Landing a briefing

`generateAttempt` reads `notes_through_sequence` before inference and writes the
result with a compare-and-set on both that cursor and `generated_at`. If another
pass landed while this one was running, the update matches no row and the stale
result is discarded rather than overwriting newer notes. A `final` pass that
loses this race re-reads the transcript and retries once, because a whole-meeting
summary must not be lost to a live refresh that happened to finish later.

Every write materializes the note resource: a human-readable `note.md` and a
timestamped `note-model.md` in R2, plus the `resources` row that agents and work
streams read. That is the only view of a note anything outside this module has.

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
- **Only the owner may record, append, or generate.** Every statement binds
  `workspace_id` and `owner_user_id`; the screen is read-only for anyone else.

## Boundary

This module owns the recording screen, the transcript segment protocol, both
prompts, and the note resource it materializes. It exposes notes to the rest of
Avalon only as that resource — nothing else reads `note_transcript_segments`.

It does not own audio capture, the realtime bridge, or the provider credentials
behind it; it does not own model selection, which is a flag; and it does not own
what happens when a note's scope changes, which is
`note-privacy-notification-service.ts` publishing to affected work streams.

## Failure modes and limits

| Limit | Value | Where |
| --- | --- | --- |
| Segment commit and refresh cadence | 60s | `meeting-notes.tsx` |
| Recent focus window | 10 min | `RECENT_TRANSCRIPT_WINDOW_MS` |
| Complete transcript context | 400,000 chars, middle elided | `MAX_TRANSCRIPT_CONTEXT_CHARACTERS` |
| Recent window context | 100,000 chars | `MAX_RECENT_TRANSCRIPT_CHARACTERS` |
| Previous briefing context | 50,000 chars | `MAX_NOTES_CONTEXT_CHARACTERS` |
| Harness wall clock | 60s live, 120s final | `meeting-notes-service.ts` |
| Cost ceiling | 100¢ live, 200¢ final | `meeting-notes-service.ts` |

- **Inference fails or times out.** The screen shows "Avalon could not update
  Control Tower" and keeps the previous briefing. Nothing is retried at the same
  model; the next minute's refresh is the retry.
- **A segment save fails.** The transcript is marked partial, the save error stays
  visible, and generation still proceeds over the segments that did reach the
  server — a lost minute must not cost the whole summary.
- **The transcript outgrows the context bound.** Its middle is elided with a
  visible marker and `transcriptStatus` becomes `partial`, which both prompts
  treat as a reason to caveat rather than to guess.
- **A refresh overruns its own cadence.** Refreshes are serialized on
  `generationTailRef`, so a slow pass delays the next one rather than racing it;
  the compare-and-set catches anything that still overlaps across windows.

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
- `pnpm --filter @avalon/desktop exec vitest run src/renderer/screens/meeting-notes.test.tsx`
  — the cadence constants, elapsed-time accounting across segment boundaries, and
  the finalization order (append, then generate, then mark complete).

The desktop suite asserts the cadence constants by value, so changing the cadence
is a deliberate two-file edit rather than a silent one. No test drives the
one-minute timer itself; a change to the timer's effect needs fake timers added.

## Open questions

### Should generation move to the server?

Today the client is the whole schedule. The recording screen decides when a
transcript segment is committed and when a briefing is requested, and the Worker
only answers `POST /notes/:id/generate` when it is asked. That is the cheapest
thing that works, and at a five-minute cadence it was defensible. At sixty
seconds it is the design's weakest point, for three reasons:

- **Cadence is client-controlled, so spend is client-controlled.** Every `live`
  request that carries a new segment is an inference. The only brake is the
  `notes_through_sequence` check, which a client can defeat simply by committing
  a segment before each request. An old build, a modified build, or a bug in the
  timer can refresh far faster than once a minute, and nothing on the server says
  no.
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

Until then, the client-owned cadence is a known and accepted gap, and the
compare-and-set in `generateAttempt` is the only thing standing between two
enthusiastic clients and a corrupted briefing.

## Changelog

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
