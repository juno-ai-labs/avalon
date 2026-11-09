# Streaming reveal

How streamed agent text reaches the reader's eye smoothly. The wire batches
model tokens into a frame roughly every 100ms, so text used to appear in
line-sized bursts at ~8Hz on a display painting at 60Hz — measured against the
running client, 85% of painted frames revealed nothing and the rest revealed a
~12-character burst. This module decouples the two clocks on the client:
everything the wire delivers is buffered per streaming message, and an
animation-frame loop reveals a prefix of it at a rate that tracks arriving text with backlog catch-up,
so the visible text grows a few characters per painted frame whatever the
wire's cadence. The wire itself is untouched: the batcher, the Durable Object
wake rate, the socket frame rate, and the replay window are exactly what they
were.

Read this before changing when streamed text becomes visible, the reveal rate,
or how the transcript renders a message that is still growing.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| [`apps/desktop/src/renderer/lib/streaming-reveal.ts`](../apps/desktop/src/renderer/lib/streaming-reveal.ts) | The reveal arithmetic and state transitions: `recordStreamArrival`, `revealBudget`, `advanceStreamReveal`, `flushStreamReveal`, `applyRevealedText`, and `STREAM_REVEAL_CADENCE_MS`. Pure over the cursor map; owns no timer. |
| [`apps/desktop/src/renderer/lib/use-workstream-socket.ts`](../apps/desktop/src/renderer/lib/use-workstream-socket.ts) | The loop: `applyStreamingSocketEvent` lands wire text in the cursors' `receivedText` (paced while the document is visible), and one `requestAnimationFrame` chain per hook instance advances and writes the revealed prefixes. |
| [`apps/desktop/src/renderer/lib/workstream-socket-resume.tsx`](../apps/desktop/src/renderer/lib/workstream-socket-resume.tsx) | `StreamCursor` carries `receivedText`, `revealed`, `lastRevealAt`, and mutable `pacing` beside the replay-ordering fields, so the reveal survives the foreground/background hook handoff the resume registry exists for. |
| [`apps/desktop/src/renderer/components/workstream-blocks.tsx`](../apps/desktop/src/renderer/components/workstream-blocks.tsx) | The rendering half: `MarkdownBody`'s `streaming` mode splits the source into memoised settled segments plus an open tail (`splitStreamingMarkdown`), which is what makes a commit per painted frame affordable. [`markdown-rendering.md`](markdown-rendering.md) owns that component. |

## How it works

A `stream_started` or `stream_delta` frame goes through the same ordering and
de-duplication it always did — room sequence, turn, epoch, stream sequence —
and then, instead of writing its text into the transcript cache, appends it to
the message cursor's `receivedText`. The transcript keeps the message's
*revealed prefix* as its `text`; a wire frame that changes nothing visible
returns the cache untouched, so the wire's cadence stops costing commits.

Accepted nonempty deltas record their arrival time and UTF-16 length in the
shared cursor. A time-weighted estimate tracks characters per millisecond and
packet cadence. The first packet uses the existing wire batcher's 100ms cadence;
observations while text remains buffered adapt it. The same 100ms constant is
also the weighting timescale, not a maximum rate. Same-timestamp packets
accumulate until the next measurable interval rather than dividing by zero.

Each arrival sets the draw rate to the greater of the measured incoming rate
and the rate needed to drain the backlog in one estimated packet interval.
The animation loop integrates that rate over elapsed time, carrying fractional
characters between frames. Catch-up stays linear between arrivals, so the tail
does not slow exponentially. Duplicate subscriber ticks at the same timestamp
reveal nothing extra. Surrogate pairs remain whole, with the extra unit charged
against the next frame's credit.

The loop arms itself only when a stream event leaves a backlog, re-arms only
while one remains, and one frame is in flight per hook instance at a time. An
idle transcript costs nothing. The frame that empties a cursor parks both its
drawing clock and its arrival clock and discards fractional credit. The next
packet uses the retained cadence in place of an idle interval; its size still
updates the rate. No timeout or guessed stall multiplier distinguishes pauses.
This favors prompt drawing over preserving motion across every delivery gap:
when a packet drains before the next arrives, the caret briefly parks.

Four paths deliberately do not pace:

- **A hidden document.** Animation frames stop, so frames arriving while
  hidden apply whole, and going hidden flushes whatever was held. Nobody is
  watching the animation.
- **An active-stream checkpoint.** Someone arriving at a conversation mid-turn
  gets the accumulated text at once; pacing begins with the first live delta.
- **A failed observable attempt.** Provider retry and fallback are already
  closed once a delta is visible. The canonical failure status removes the
  ephemeral assistant overlay immediately rather than animating its text away;
  there is no replacement answer under the same turn.
- **Completion.** `stream_completed` is lifecycle-only and names the transient
  stream. The client flushes that stream's reveal backlog before marking it
  complete; the independently published canonical turn then replaces the
  overlay by explicit turn identity.

## Invariants

- **`receivedText` is the truth about what arrived; the cache's `text` is a
  derived prefix of it.** Turn boundaries, retries, and appends are all
  positioned in received space. Code that treats the cache's streaming text as
  the accumulated stream — appending to it, measuring it — reintroduces the
  bug where a reveal in progress loses the unrevealed suffix.
- **Only the reveal loop advances `revealed`; wire events only clamp or
  complete it.** Two writers racing on it is how text flickers backwards.
- **The reveal writes through `applyRevealedText`, which returns the array
  untouched when nothing visible changed.** The no-op is load-bearing: it is
  what keeps commits at the paint rate rather than the paint rate plus the
  wire rate.
- **The rate must integrate over `lastRevealAt`, never assume one tick per
  frame.** Two hook instances share the cursors during a foreground/background
  handoff; a per-tick constant would double the reveal rate exactly then.
- **The reveal never outruns what pacing has admitted**: `revealed` is clamped
  to `receivedText.length` everywhere it moves. Past the end, the slice is
  harmless but the loop never terminates.
- **The screen still re-renders for every visible change** — now once per
  reveal tick rather than once per wire frame — which is what
  [`transcript-scrolling.md`](transcript-scrolling.md) requires for the follow
  to hold the end of the transcript. Batching reveal writes outside React's
  commit, or moving them off the `['messages', …]` cache, silently stops the
  follow.

## Boundary

This module owns *when received text becomes visible* on the conversation
transcript, and nothing else. It does not decide what arrives —
`createSequencedStreamDeltaBatcher` in
`apps/api/src/services/integrations.ts` is the one batcher on the conversation
socket path and owns the wire cadence
([`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md) says why frames
are batched at all; `createTextDeltaBatcher` in `packages/agent-harness`
batches the automation compiler's narration on a different surface, with
defaults deliberately kept in step) — does not order or de-duplicate frames
(that stays in `applyStreamingSocketEvent`'s cursor logic), does not scroll
(the follow in [`transcript-scrolling.md`](transcript-scrolling.md) reacts to
the commits this produces), and does not render (the streaming markdown path
in [`markdown-rendering.md`](markdown-rendering.md) is a separate mechanism
this one makes necessary). The automation-drafts builder streams its own
narration through a different surface and is deliberately not paced by this.

## Failure modes and limits

- **The initial cadence is 100ms**, matching the wire batcher's existing delay.
  It seeds the cadence estimate and remains the weighting timescale. It is not
  a speed ceiling or timeout; there is no backend dependency or tokenizer assumption.
- **A provider pause** drains the received text at the last draw rate, then parks
  the caret. A resumed packet updates the rate using the retained cadence,
  excluding the period when the buffer was empty. Hidden arrivals do not train
  the estimate.
- **Hidden windows and completion** flush immediately. Checkpoints show their
  accumulated text immediately and begin estimating with fresh live deltas.
- **Fractional credit** avoids refresh-rate-dependent rounding and is discarded
  on the draining tick. Slow producers can have zero-character frames, rather
  than being forced to one character per frame. Retry resets discard the prior
  arrival estimate.

## Testing

- `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/streaming-reveal.test.ts`
  — the arithmetic and state transitions, pure.
- `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/use-workstream-socket.test.tsx`
  — the loop against the hook: text held back then revealed across frames,
  instant reveal while hidden, the retry clamp, and the pre-pacing suites now
  driven through `stubAnimationFrames()`, whose `flush` pumps queued frames
  until the reveal stops re-arming. jsdom's own `requestAnimationFrame` is a
  real 16ms timer — useless under fake timers and slow under real ones — so
  the stub is what every reveal-dependent assertion goes through.
- The end-to-end cadence — wire, commits, painted frames, characters per
  frame — cannot be asserted in jsdom, which paints nothing. It is measured
  against the running client with
  `scripts/measure-stream-smoothness.mjs`, which plays a synthetic turn into
  the live renderer over CDP (per
  [`dev-environment.md`](dev-environment.md#what-cannot-be-verified-in-a-sandbox))
  through an exact emulation of the conversation wire batcher, and reports the
  distributions this module is judged by.

## Performance and cost

The budget: a reveal tick's commit must fit a 60Hz frame at every reply
length, because pacing multiplies the commit rate by roughly five (8Hz wire →
up to 60Hz reveal). The tick itself is a string slice and one cache write. The
screen memoizes canonical turn flattening independently from transient overlays,
then linearly merges the already ordered canonical rows with the small sorted
overlay set, so a reveal does not re-dedupe and re-sort loaded history. The other
cost that had to be engineered away was rendering, where the whole growing body
used to be re-parsed per commit — that work is
[`markdown-rendering.md`](markdown-rendering.md)'s streaming mode, and the
numbers live in the pull request that introduced both. What to watch: anything
that makes a per-tick commit O(reply length) again — an unmemoised markdown
body, canonical projection depending on overlay identity, a global transcript
sort, a segment key that churns, a `mentions` default that mints a new array per
render — multiplies at 60 commits a second, not 8.

## Changelog

### 2026-09-08 — Park pacing on the frame that drains the buffer

**What changed:** Draining and hidden flushes park both timing clocks and clear
fractional credit. Resumption retains the last cadence rather than training on
an empty-buffer gap. Socket regressions cover 250ms, 2s, and 10s gaps; unit tests
cover fractional debt and the measured-rate branch. The cadence constant's name
now describes its seed and weighting role.

**Why:** Review reproduced a gap the initial regular-cadence check missed: the
last scheduled tick left its clock live, so the next packet banked idle time
and burst on screen. The estimator separately learned pauses as slow production,
causing resumed text to crawl once the clock bug was fixed.

**Considered and rejected:** A guessed stall multiplier or draw-speed ceiling.
The drained state already tells us there is no incoming text to pace. Keeping
the measured-rate estimate matters when a smaller packet follows a faster one.

**Consequences:** The loop must park before it stops scheduling itself. This PR
replaces the deliberate 270ms smoothing trade-off recorded in the 2026-08-23
entry with lower latency and linear catch-up, accepting brief empty-buffer gaps.
That entry's original smoothness measurements remain historical evidence, not
measurements of this implementation. The original PR check covered a component
in Electron; review follow-up validation is recorded in the PR.


### 2026-09-07 — Drawing follows frontend text arrival speed

**What changed:** Accepted deltas now estimate text rate and packet cadence on the
frontend. Frames integrate that rate with fractional credit and linear backlog
catch-up; replay ordering, completion, checkpoints, and hidden flushes remain.

**Why:** The previous 270ms backlog governor intentionally delayed steady output
and slowed the last part of each burst. The drawing felt behind generation.

**Considered and rejected:** Merely shortening the exponential window retains
its slowing tail. Backend token telemetry adds protocol work and still needs a
text-length conversion; received characters measure what must actually be drawn.

**Consequences:** Timing state belongs to the shared cursor and must survive
subscriber handoffs. Only accepted nonempty deltas train it; attempts reset it.
The existing 100ms batching cadence seeds the estimate without a new speed cap.


### 2026-08-28 — The reveal layer follows the persistent-loop cutover

**What changed:** The paced-reveal layer was re-anchored to the canonical
ordered transcript that the persistent substream loop cutover made the only
display authority. The facets below are the decisions this change is made
of — each carries its own rejected alternative and its own invariant.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).

#### Failed previews disappear instead of becoming a retried answer

**What changed:** Once assistant text is observable, provider failure removes
the transient preview immediately and the canonical failure status takes its
reserved transcript position. Retry and fallback remain possible only before a
byte is published or a tool effect begins, when there is no visible text to
reveal or retract.

**Why:** Treating a streamed prefix as retractable retry input allowed another
provider to produce a second semantic answer for the same turn. The animation
layer then made a model-execution policy look like harmless presentation state.

**Considered and rejected:** Resetting the visible prefix and pacing a fallback
answer under the same identity. That preserves smooth motion but loses truthful
authorship and makes observable work retryable.

**Consequences:** Failure rollback is immediate, not paced. The reveal cursor
still rejects stale epochs and reset frames defensively, but production does not
use those mechanics to retry a turn after output became visible.

#### Reveal ticks no longer rebuild canonical history

**What changed:** The work-stream screen memoizes canonical transcript
projection separately from overlay composition. Composition treats canonical
rows as an ordered contract, sorts only the small live-overlay set, and merges
the two inputs in one pass.

**Why:** Each paced prefix changes the overlay cache at up to the display rate.
Including that cache in the canonical projection memo rebuilt maps, flattened
blocks, and globally sorted every loaded message for each visible character
step, turning smooth reveal into work proportional to all loaded history.

**Considered and rejected:** Lowering the reveal cadence, preserving the global
sort, and enforcing sorted overlay arrays across every producer. The first
undoes the visible behavior this module owns; the second retains the expensive
path; the third spreads a new invariant across optimistic commands, snapshots,
and stream events when sorting the small overlay copy is sufficient.

**Consequences:** Canonical input to composition must already be in durable
sequence/block order and malformed decreasing input fails immediately. A reveal
tick performs overlay reconciliation, a small overlay sort, one linear merge,
and the final display renumbering; canonical projection runs only when canonical
state or posting-time author data changes.

### 2026-08-26 — Reveal cursors are model-turn scoped

**What changed:** Streaming rows and reveal cursors are keyed by Bind turn ID,
not the run's aggregate final-message ID. Starting a post-tool model turn makes
the prior turn's complete received prefix visible and terminal, while the new
turn reveals independently. Late frames for the prior turn are ignored.

**Why:** One aggregate cursor necessarily concatenated narration from both
sides of tool calls into one text row, moving the later text above tools. It
also let a reset or delayed frame for one model turn mutate another.

**Considered and rejected:** Sorting tool cards around one aggregate text row.
There is no sort key that can place one indivisible text row both before and
after the tools without inventing text boundaries the model already supplied.

**Consequences:** Pacing, replay de-duplication, retry resets, hidden-window
flushes, and completion remain unchanged, but operate per model turn. Any
checkpoint must carry the turn ID and aggregate run-message ID so reconnect can
close superseded turns without losing unrevealed bytes.

### 2026-08-23 — Text reveals at the display's cadence, not the batcher's

**What changed:** Streamed text stopped being written to the transcript as it
arrives. Wire frames accumulate in the stream cursor's `receivedText`, and an
animation-frame loop reveals a prefix at `backlog × elapsed / 270ms` (floor
one character, never splitting a surrogate pair) per frame. Hidden documents —
a mount in an already-hidden window included — checkpoints, retries, and
completion reveal instantly. The wire protocol, the batcher, and its defaults
are unchanged.

**Why:** The transcript revealed text in line-sized bursts. Measured on the
running client with a synthetic 25 tokens/second turn (the harness in
`scripts/measure-stream-smoothness.mjs`): the batched wire delivered ~12
characters every ~120ms, one commit per frame, and 84.5% of painted frames
revealed nothing while the rest revealed a burst — coefficient of variation
2.36 on characters-per-painted-frame. After pacing, 7.7% of frames reveal zero
and the variation drops to 0.48 at a steady ~1.6 characters per frame, with
frame-duration p95 at 16.8ms and zero long tasks at every measured reply
length up to 20,000 characters.

**Considered and rejected:**

- *Lowering the batcher's `maxDelayMs`.* Measured: at 16ms the wire runs at
  25 frames/second and zero-reveal frames only fall to 58% — a faster bursty
  wire is still bursty against a 60Hz display — while socket frames, Durable
  Object wakes, and replay rows all triple, and long replies get worse because
  each extra frame was a whole-body markdown re-parse. Pacing costs none of
  that and smooths all of it.
- *Pacing inside the message row component instead of the cache.* The follow
  in `transcript-scrolling.md` runs in the screen's layout effect and requires
  the screen to re-render for every visible change; a row-local reveal would
  grow the row without a screen commit, and the viewport would correct a frame
  late — the lag-then-snap that document exists to prevent.
- *A fixed reveal rate.* Tracks neither a fast model (buffer grows without
  bound) nor a slow one (the reveal crawls behind text that has already
  arrived). The backlog-proportional rate is self-tuning and costs one
  multiply.

**Consequences:** Visible text lags the wire by up to the drain window
(~270ms steady-state) — deliberate, and the cost of smoothness. Commits run at
up to the display rate during a stream, which is only affordable because the
markdown pipeline stopped re-parsing the whole body per commit; the two
changes ship together and must stay together. Anything that reads a streaming
message's `text` from the cache is reading the revealed prefix, not everything
received — code that needs the whole stream reads the cursor.

Shipped in #258.
