# Streaming reveal

How streamed agent text reaches the reader's eye smoothly. The wire batches
model tokens into a frame roughly every 100ms, so text used to appear in
line-sized bursts at ~8Hz on a display painting at 60Hz — measured against the
running client, 85% of painted frames revealed nothing and the rest revealed a
~12-character burst. This module decouples the two clocks on the client:
everything the wire delivers is buffered per streaming message, and an
animation-frame loop reveals a prefix of it at a rate that tracks the backlog,
so the visible text grows a few characters per painted frame whatever the
wire's cadence. The wire itself is untouched: the batcher, the Durable Object
wake rate, the socket frame rate, and the replay window are exactly what they
were.

Read this before changing when streamed text becomes visible, the reveal rate,
or how the transcript renders a message that is still growing.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| [`apps/desktop/src/renderer/lib/streaming-reveal.ts`](../apps/desktop/src/renderer/lib/streaming-reveal.ts) | The reveal arithmetic and state transitions: `revealBudget`, `advanceStreamReveal`, `flushStreamReveal`, `applyRevealedText`, and `STREAM_REVEAL_DRAIN_MS`. Pure over the cursor map; owns no timer. |
| [`apps/desktop/src/renderer/lib/use-workstream-socket.ts`](../apps/desktop/src/renderer/lib/use-workstream-socket.ts) | The loop: `applyStreamingSocketEvent` lands wire text in the cursors' `receivedText` (paced while the document is visible), and one `requestAnimationFrame` chain per hook instance advances and writes the revealed prefixes. |
| [`apps/desktop/src/renderer/lib/workstream-socket-resume.tsx`](../apps/desktop/src/renderer/lib/workstream-socket-resume.tsx) | `StreamCursor` carries `receivedText`, `revealed`, and `lastRevealAt` beside the replay-ordering fields, so the reveal survives the foreground/background hook handoff the resume registry exists for. |
| [`apps/desktop/src/renderer/components/workstream-blocks.tsx`](../apps/desktop/src/renderer/components/workstream-blocks.tsx) | The rendering half: `MarkdownBody`'s `streaming` mode splits the source into memoised settled segments plus an open tail (`splitStreamingMarkdown`), which is what makes a commit per painted frame affordable. [`markdown-rendering.md`](markdown-rendering.md) owns that component. |

## How it works

A `stream_started` or `stream_delta` frame goes through the same ordering and
de-duplication it always did — room sequence, turn, epoch, stream sequence —
and then, instead of writing its text into the transcript cache, appends it to
the message cursor's `receivedText`. The transcript keeps the message's
*revealed prefix* as its `text`; a wire frame that changes nothing visible
returns the cache untouched, so the wire's cadence stops costing commits.

Each frame the loop runs, every uncompleted cursor with a backlog reveals
`revealBudget(backlog, elapsed)` more characters:
`backlog × elapsed / STREAM_REVEAL_DRAIN_MS`, floored at one character, capped
at the backlog, and nudged past a surrogate pair rather than ever splitting
one (`alignRevealBoundary` — an emoji streams in whole, not as a
replacement-glyph frame). Because each frame's budget is a share of the
*remaining* backlog, the backlog decays exponentially — about 6% per 60Hz
frame, halving every ~190ms — which is the governor: a steady stream settles
into a near-constant few characters per frame, an outsized burst (a
2,048-character frame, a stalled tab catching up) is substantially caught up
within half a second and within a few characters inside ~1.5s, and an empty
buffer simply stops the loop (the caret sits, exactly as it did during a tool
call before pacing). Proportionality to elapsed time is what makes sharing
safe: the foreground screen and the shell's background subscriber for the
same work stream share one cursor map, and a second loop ticking in the same
frame sees near-zero elapsed time and reveals almost nothing extra.

The loop arms itself only when a stream event leaves a backlog, re-arms only
while one remains, and one frame is in flight per hook instance at a time. An
idle transcript costs nothing.

Four paths deliberately do not pace:

- **A hidden document.** Animation frames stop, so frames arriving while
  hidden apply whole, and going hidden flushes whatever was held. Nobody is
  watching the animation.
- **An active-stream checkpoint.** Someone arriving at a work stream mid-turn
  gets the accumulated text at once; pacing begins with the first live delta.
- **A retried attempt.** A `reset` or epoch bump clamps the reveal back to the
  turn's start, so retracted text vanishes instantly instead of being animated
  away, and the replacement paces in from there.
- **Completion.** `stream_completed` carries the run's aggregate final message,
  which replaces the row whole. The batcher flushes at turn end, so the backlog
  at that moment is ordinarily under the drain window's worth of text. That
  aggregate is not the feed's copy of the answer — the closing turn Bind
  accepted is — so it is inserted only for a reader holding no stream cursors,
  and `transientMessagesWithoutCanonicalMatch` drops it once the canonical
  snapshot shows the same text on one of that run's turns.

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

This module owns *when received text becomes visible* on the work-stream
transcript, and nothing else. It does not decide what arrives —
`createSequencedStreamDeltaBatcher` in
`apps/api/src/services/integrations.ts` is the one batcher on the work-stream
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

- **`STREAM_REVEAL_DRAIN_MS` is 270ms**, the smoothing window. It is derived,
  not guessed: the work-stream batcher holds text up to 100ms (`maxDelayMs`),
  the measured inter-arrival p95 at the renderer was 133ms, and a drain window
  that the gap between frames can outlast makes the reveal stall-then-burst —
  the exact cadence this exists to remove. Twice the measured p95, rounded,
  holds through ordinary jitter. Under a steady stream the visible text lags
  the wire by about one window's worth; after an outsized burst the lag is
  transiently larger, because the drain is exponential (each frame reveals a
  share of what *remains*), decaying to a few characters within ~1.5s of a
  2,048-character frame. Raising `maxDelayMs` on the wire without raising this
  proportionally brings the stall back.
- **A wire stall longer than the drain window** (a tool call, a provider
  pause) drains the buffer and parks the caret. That is the same visual as
  before pacing, and it is correct: inventing a slower crawl to bridge an
  unknown-length gap would misrepresent the stream.
- **A hidden window reveals everything at once** on the next frame, via the
  hidden-flush. The reader returning mid-turn sees the text already caught up,
  not an animation replaying what they missed.
- **The floor of one character per frame** means a near-empty buffer reveals
  at the display rate, ~60 characters a second, even when the model is slower.
  A model slower than that is revealed at its own rate, one wire frame per
  token, buffered briefly.

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
  through an exact emulation of the work-stream wire batcher, and reports the
  distributions this module is judged by.

## Performance and cost

The budget: a reveal tick's commit must fit a 60Hz frame at every reply
length, because pacing multiplies the commit rate by roughly five (8Hz wire →
up to 60Hz reveal). The tick itself is a string slice and one cache write; the
cost that had to be engineered away was rendering, where the whole growing
body used to be re-parsed per commit — that work is
[`markdown-rendering.md`](markdown-rendering.md)'s streaming mode, and the
numbers live in the pull request that introduced both. What to watch: anything
that makes a per-tick commit O(reply length) again — an unmemoised markdown
body, a segment key that churns, a `mentions` default that mints a new array
per render — multiplies at 60 commits a second, not 8.

## Changelog

### 2026-08-28 — The completion row is an aggregate, and reconciles as one

**What changed:** `transientMessagesWithoutCanonicalMatch` drops a routed
`harness:<runId>` message when a canonical turn of that run already shows the
same text. The row `stream_completed` delivers is described as the run
aggregate rather than as the canonical message.

**Why:** The backend stopped giving that aggregate a transcript turn, because
the closing accepted turn already held the answer and the aggregate's sequence —
allocated at terminalization — put a second copy after every tool block it had
been interleaved with. That left the client the only place the duplicate could
still appear: a reader who caught no stream frames inserts the aggregate on
`stream_completed`, and nothing tied it to the turn that arrived in the next
snapshot. Both records are wanted; only one of them is the feed's.

**Considered and rejected:** Not inserting the aggregate at all, which leaves a
reader who joined after the last frame with no answer until the snapshot lands.
Matching on the run alone, which hides the attachment-grounding guard's
substituted notice — the case where the aggregate's words are the host's and no
turn carries them.

**Consequences:** The match is on text, so a future change that rewrites the
aggregate's text on the way to the client — trimming, decorating, normalizing —
breaks the reconciliation and restores the duplicate. Anything that needs to
alter it must give the two records an explicit shared identity first.

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
