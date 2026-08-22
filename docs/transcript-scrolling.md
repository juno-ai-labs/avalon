# Transcript scrolling

The work-stream transcript keeps itself at the newest message while a turn
streams in, so a reply written a token at a time stays visible without anyone
touching a scroll wheel. That service ends the instant the reader scrolls: from
then until they come back to the end, the viewport is theirs, and nothing the
screen does may move it.

Read this before changing the transcript viewport, the follow, the **Jump to
latest** control, or anything that writes `scrollTop` on
`.transcript-scroll` — including code that only means to restore a position.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| [`apps/desktop/src/renderer/lib/use-transcript-follow.ts`](../apps/desktop/src/renderer/lib/use-transcript-follow.ts) | The whole mechanism: the follow itself, the reader-intent rules, and the ownership flag. The single place a following scroll is performed. |
| [`apps/desktop/src/renderer/screens/workstream.tsx`](../apps/desktop/src/renderer/screens/workstream.tsx) | The only caller. Owns the scroll container, decides when following is permitted at all, and drives the transcript's other scrolls — the opening position, an older page being prepended, and **Jump to latest**. |
| [`apps/desktop/src/renderer/styles/app.css`](../apps/desktop/src/renderer/styles/app.css) | `.transcript-scroll` and `.transcript-column`, whose bottom padding is what keeps the newest message clear of the composer when the viewport is at the end. |

`@tanstack/react-virtual` measures and positions the rows. It is not part of the
follow — see [Boundary](#boundary).

## How it works

### Following

`useTranscriptFollow` holds one piece of truth: whether the transcript is
following. While it is, a layout effect runs **on every commit** and writes
`element.scrollTop = element.scrollHeight - element.clientHeight` whenever those
have drifted apart by a pixel or more.

Every commit, because a streaming turn grows the last row without changing
anything an effect could depend on: the row re-measures, the virtualizer
publishes a new total size, and *that commit* is the only moment at which the end
of the transcript has moved. A layout effect, because it runs before paint — the
correction lands in the same frame as the text that caused it, so the bottom edge
of the reply never appears to lag and then snap.

### Handing the viewport over

Two signals stop the follow, and they exist for different halves of the same
race:

- **A scroll that moves away from the end.** Any distance greater than the last
  one recorded means the reader has pulled back, and following stops — checked
  *before* the slack, so a single wheel tick that lands 60px from the end counts
  even though 60px is still "at the end" for the purpose of the jump control.
- **An upward wheel.** A wheel event reaches the main thread on the input itself,
  while the scroll it causes is applied by the compositor and its event can
  arrive a frame later. Reading the intent off the input settles it on the first
  tick rather than the third.

A scroll that comes to rest within `TRANSCRIPT_END_SLACK` (80px) of the end hands
the viewport back and following resumes.

### Whose scroll it was

The screen's own scrolls are announced before they happen — the follow sets the
flag itself, and `claimNextScroll` is there for the other one, the position
`workstream.tsx` restores after prepending an older page. The scroll event that
follows updates the recorded position and nothing else.

This is the part that is easy to leave out and impossible to notice in a test
that never streams. Without it the follow's own correction is delivered as an
ordinary scroll event reporting the end, which reads as *take me to the newest
message* — so the follow re-arms itself one frame after the reader stopped it,
and the reply cannot be read from the top until the turn finishes.

### Where the screen puts the viewport

`workstream.tsx` positions the transcript when a work stream opens and calls
`release()` or `resume()` to say which of the two it did: `release()` when it
opened at the reader's first unread message, so a run already streaming into that
work stream cannot pull them off it, and `resume()` when it opened at the end.
**Jump to latest** pages in everything newer and calls `resume()`.

## Invariants

- **Only the reader's own scrolling decides where the viewport sits.** Every
  scroll the screen performs is announced first, or it will be read back as the
  reader asking for the end and the follow will re-arm behind them. Any new code
  that writes `scrollTop` on the transcript container must call
  `claimNextScroll()` immediately before a write that will actually move it —
  and only then, because a claim that no scroll event redeems is spent silencing
  the reader's next one instead.
- **Following is decided in refs, not state.** A scroll event has to be able to
  stop the follow before the next commit runs it. A `setState` scheduled from the
  scroll handler is not guaranteed to have been applied by then, and one more
  follow has already taken the viewport back. `atEnd` is state because it only
  draws a button.
- **Nothing follows the end through the virtualizer.** `scrollToIndex` installs a
  reconciling animation-frame loop that re-aims at its target for up to five
  seconds; aimed at a row that grows with every token, it competes with the
  reader for the viewport for as long as the turn lasts. It is correct for the
  one-shot positioning done when a work stream opens, where the rows have not
  been measured yet, and it is wrong for the follow.
- **Moving away from the end is read before the slack.** Reversing those two
  makes a one-tick pull-back invisible, which is the whole failure.

## Boundary

`useTranscriptFollow` owns *where the viewport sits* and nothing else. It does
not know what a message is, when a turn is streaming, or how tall a row is; it
reads three numbers off a DOM element and writes one back.

It depends on the screen for permission — `canFollow` is false until
`workstream.tsx` has positioned this work stream, while the transcript is empty,
and whenever the end of the transcript is a page away rather than loaded, because
following an end that is not the real end would strand the reader at a boundary.

Row measurement, virtual positioning, and the scroll corrections applied when a
row's measured height replaces its estimate belong to `@tanstack/react-virtual`
and are deliberately left alone: correcting for a row above the fold that turned
out taller than estimated is what keeps the text under the reader's eye still,
and it is not the follow. The socket events that grow a streaming message are
owned by
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md); how a message body
is rendered by [`markdown-rendering.md`](markdown-rendering.md).

## Failure modes and limits

- **A claim that is never redeemed** silences one reader scroll. The screen
  therefore claims only when the write will actually change `scrollTop`, and the
  wheel signal recovers the case anyway.
- **A gesture that begins in the same frame as a follow** may be coalesced into
  one scroll event reporting the end. The wheel signal is what settles it; a
  keyboard or scrollbar scroll produces no wheel event, but neither is applied on
  the compositor, so its scroll event carries the reader's real position.
- **`TRANSCRIPT_END_SLACK` is 80px.** Below it the viewport counts as showing the
  newest message: the jump control hides, and a scroll coming to rest there
  resumes following.
- **A work stream opened at an unread anchor does not follow**, even if a turn is
  streaming into it, until the reader scrolls to the end. This is deliberate.
- The follow reads `scrollHeight` on every commit while it is active, which
  forces layout. It is gated on the follow being on precisely so that a screen
  that is not following pays nothing.

## Testing

[`apps/desktop/src/renderer/lib/use-transcript-follow.test.tsx`](../apps/desktop/src/renderer/lib/use-transcript-follow.test.tsx),
in the desktop suite (`pnpm --filter @avalon/desktop test`).

jsdom performs no layout, so a scroll container reports a height of zero and an
assignment to `scrollTop` is discarded. The test defines `scrollHeight`,
`clientHeight`, and `scrollTop` on `HTMLElement.prototype` over a plain object,
and the setter recording what the follow writes is the assertion surface. They
are defined on the prototype because the element is created by the component, and
`restoreMocks` cannot undo a bare `defineProperty` — each test restores them
itself.

The other trap is that a browser dispatches a scroll event for the follow's own
write. A test that grows the content and re-renders without firing that event is
testing a browser that does not exist, and the ownership flag it would leave set
makes the *next* assertion wrong instead. `stream()` in that file does both.

## Changelog

### 2026-08-22 — The reader's scrolling, not the screen's, decides where the transcript sits

**What changed:** Following the newest message moved out of the work-stream
screen into `useTranscriptFollow`. It now holds the end by writing `scrollTop` in
a layout effect instead of calling the virtualizer's `scrollToIndex` once per
token, it stops on the first upward wheel tick rather than only once the reader
has out-scrolled 80px, and the scrolls the screen performs itself are marked so
they are not read back as the reader's.

**Why:** The transcript could not be scrolled away from during a streaming turn.
The follow re-armed itself: it fired on every token while `atBottom` was true,
`atBottom` was recomputed from every scroll event, and the follow's own
correction arrived as a scroll event reporting the end — so a wheel tick that set
`atBottom` false was undone within a frame by the screen's own scrolling. Driving
a real ten-tick trackpad gesture into the running client during a streaming turn
moved the viewport a net **0px**, oscillating between two positions ten times and
ending pinned at the end; the same gesture after the change travels the full
600px and stays there. Reading a reply from its beginning meant waiting for the
turn to finish.

`scrollToIndex` made it worse in a second way: it installs a reconciling
animation-frame loop that re-aims at its target for up to five seconds, and its
target was a row growing with every token.

**Considered and rejected:**

- *Keeping `atBottom` as the single source of truth and only fixing the
  threshold.* Any threshold is out-scrolled by the correction, because the
  correction always lands exactly at the end. The signal has to be that the
  reader moved *away*, not how far they got.
- *Keeping the follow on `scrollToIndex` and cancelling its reconcile loop when
  the reader takes over.* The cancel is a scroll write of its own, issued in the
  middle of a gesture, and measurement showed the loop is harmless once nothing
  re-arms it — it stabilises within a frame or two. Not calling `scrollToIndex`
  at all is both smaller and stronger.
- *A `setState` rather than refs for the follow decision.* Rejected on ordering:
  the scroll handler's update is not guaranteed to be applied before the commit
  the next token schedules, and one late follow is the entire bug.

**Consequences:** The transcript container now has exactly two writers, the hook
and `workstream.tsx`, and a third one added later must announce itself with
`claimNextScroll()` or it will re-arm the follow. `scrollToIndex` is reserved for
the one-shot positioning done when a work stream opens; using it to follow a
growing row reintroduces the reconcile loop. The follow reads `scrollHeight` on
every commit while active, which is why it returns on the follow flag first.

Shipped in #237.
