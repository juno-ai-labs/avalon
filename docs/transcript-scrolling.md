# Transcript scrolling

A conversation's transcript keeps itself at the newest message while a turn
streams in, so a reply written a token at a time stays visible without anyone
touching a scroll wheel. That service ends the instant the reader scrolls: from
then until they ask to go back, the viewport is theirs, and the only thing that
may move it is a reposition they asked for.

Read this before changing the transcript viewport, the follow, the **Jump to
latest** control, or anything that writes `scrollTop` on `.transcript-scroll` —
including code that only means to restore a position.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| [`apps/desktop/src/renderer/lib/use-transcript-follow.ts`](../apps/desktop/src/renderer/lib/use-transcript-follow.ts) | The whole mechanism, and **the only code that writes `scrollTop` on the transcript**: the follow, the reader-intent rules, and the recorded position that tells the two apart. |
| [`apps/desktop/src/renderer/screens/conversation-surface.tsx`](../apps/desktop/src/renderer/screens/conversation-surface.tsx) | The only caller. Owns the scroll container, decides when following is permitted at all, and asks the hook to move the viewport when the screen needs it somewhere — on open, on **Jump to latest**, and on send. |
| [`apps/desktop/src/renderer/lib/use-virtual-scroll-anchor.ts`](../apps/desktop/src/renderer/lib/use-virtual-scroll-anchor.ts) | Holds the row on screen still when rows are inserted above it, such as an older range being prepended. It writes through the follow hook's `scrollTo`, so it is not a second writer. |
| `apps/desktop/src/renderer/lib/use-transcript-history.ts` | Observes viewport position, schedules edge checks, and reports whether reconnection blocks visible history. The surface owns request deduplication and errors. |
| [`packages/ui/src/styles/app.css`](../packages/ui/src/styles/app.css) | `.transcript-scroll` and `.transcript-column`, whose bottom padding is what keeps the newest message clear of the composer when the viewport is at the end. |

`@tanstack/react-virtual` measures and positions the rows, and corrects the
viewport itself when a measurement replaces an estimate. It is not part of the
follow — see [Boundary](#boundary).

### Opening a search result

A search result supplies a canonical turn ID and transcript sequence. `conversation-surface.tsx` hydrates that sequence through the existing range protocol when necessary, releases following, and asks the virtualizer to position the matching row. This is an explicit reader-requested reposition, alongside initial unread positioning. Invalid sequence parameters do not suppress normal initial positioning. It does not yet highlight the matching range inside the full message.

### Following

`useTranscriptFollow` holds one piece of truth: whether the transcript is
following. While it is, a layout effect runs **on every commit of the screen**
and writes `element.scrollTop = element.scrollHeight - element.clientHeight`
whenever those have drifted apart by a pixel or more.

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
  one recorded means the reader has pulled back, and following stops. This is
  read *before* the slack, so a single wheel tick that lands 60px from the end
  counts even though 60px is inside it.
- **An upward wheel, when the transcript can act on one.** A wheel event reaches
  the main thread on the input itself, while the scroll it causes is applied by
  the compositor and its event can arrive a frame later. Reading the intent off
  the input settles it on the first tick rather than the third. It is ignored
  when the container is already at its top or cannot scroll, because `wheel`
  bubbles: a reader scrolling a code block, a wide table, or an expanded tool
  output inside a message sends one here too, and no scroll event would follow to
  correct a wrong guess.

A scroll that comes to rest inside `TRANSCRIPT_END_SLACK` (80px) of the end
*without having moved away to get there* hands the viewport back, and following
resumes. Both halves matter: pulling back 60px lands inside the slack and stops
the follow, because moving away is read first.

### Whose scroll it was

Every write to the container goes through the hook — the follow itself,
`scrollTo`, or `scrollToEnd` — and each records the position it left behind,
read back from the element rather than taken from the value written. A scroll
event that reports that position, within 1.5px, is the transcript's own and may
only update the recorded distance. Anything else is the reader's.

Ownership is decided by the value and not by a flag. A flag has to be spent
exactly once, and two things routinely stop that from happening: a write the
browser clamps away emits no scroll event at all, so the flag is spent on the
reader's next scroll instead; and a reader scroll landing in the same frame as a
correction is delivered as a single coalesced event, which a flag discards
wholesale. A recorded position survives both — the coalesced event does not
report where the transcript put the viewport, so it is read as the reader's,
which is what it is. This matters most for a keyboard or scrollbar scroll, which
produces no wheel event and has nothing else to fall back on.

Getting this wrong is the failure the module exists to prevent: read the follow's
own correction back as the reader asking for the end and the follow re-arms one
frame after they stopped it, and the reply cannot be read from the top until the
turn finishes.

### Where the screen puts the viewport

`conversation-surface.tsx` never writes `scrollTop`. It calls:

- `scrollToEnd()` when a conversation opens at the end, when it opens with no
  transcript at all — a Canvas created moments ago, whose first reply is
  what the person is waiting for — and when the reader sends a message, which is
  the strongest statement anyone can make that they mean to be at the end.
- `scrollToEnd({ smooth: true })` for **Jump to latest**. The animation is
  smooth only while the reader has not asked for reduced motion: the hook reads
  `matchMedia('(prefers-reduced-motion: reduce)')` at the call, because an
  explicit `behavior` option beats the stylesheet's
  `scroll-behavior: auto !important` kill switch per spec, so CSS alone cannot
  reach this call. Under the preference the request takes the instant path — a
  recorded `scrollTop` write that re-arms the follow synchronously — rather
  than an unanimated pass through the smooth branch, whose settle-on-arrival
  machinery exists only for an animation's in-flight frames: each frame of a
  smooth jump reports a position further from the end than the last, which is
  exactly what a reader pulling away looks like, so following is armed only
  when the animation *arrives*.
- `release()` when it opens at the reader's first unread message, so a run
  already streaming into that conversation cannot pull them off it. Only when
  the transcript overflows its viewport: one that fits shows the first unread
  message and the end together, so it opens at the end and follows, and
  **Jump to latest** is not offered with nothing to jump to.
- `scrollTo(top)`, through `useVirtualScrollAnchor`, to hold the reading
  position when rows are inserted above it. See
  [Holding the row on screen](#holding-the-row-on-screen).

### Holding the row on screen

Rows are positioned from offsets, so the browser's own scroll anchoring cannot
see a row inserted above the viewport. `useVirtualScrollAnchor` does it instead,
on any commit that changes the list's count or first key, or what is drawn above
the list:

- **In render**, while the old DOM is still on screen, it takes the first row
  whose bottom is below the viewport's top edge, finds that row's new index,
  and moves the virtualizer's `scrollOffset` to the predicted position. Without
  that the commit renders the rows at the old offset, which after a prepend are
  the new ones, and the reader's row is unmounted for a frame.
- **In a layout effect**, after this commit's rows are measured, it computes the
  exact position from the row's measured start, its live height, and the list's
  offset in the scroller, and writes it with `scrollTo`.

So the prepend is never painted at the old position. It holds the row's
*bottom* edge, because the row being read is usually the old first row, and
gaining a predecessor gives it a top gap (`feedRowGap`). Content between the
scroller's top and the list, such as the origin card that appears with the
first message, is covered because the list's offset is read after the commit,
and the screen passes a `layoutKey` so a commit that changes only that content
(a final page with no visible rows) is anchored too. If the row's key does not
survive the commit, which happens when grouping re-keys a plugin group or work
accordion spanning the page seam, the next row down is used.

Holding a row and following the end are exclusive. While the follow holds the
end, the anchor does nothing, so a commit that both prepends and appends during
a streaming turn still lands at the end.

The render half writes the virtualizer's `scrollOffset`, a public but
undocumented field, as are `elementsCache`, `measurementsCache` and
`indexFromElement`. A double render reads the same DOM and writes the same
value; a render React discards would leave the prediction in place until the
next scroll event, which nothing in this subtree risks today. The lockfile
holds `@tanstack/react-virtual` at 3.14.10 (virtual-core 3.17.8), but its
specifier is `latest`, so a lockfile refresh can change these fields.

The **Loading earlier messages…** row keeps its space for as long as an older
range exists, so the status coming and going does not move the feed either.

### Disjoint transcript ranges

An opening snapshot may contain two islands: the first-unread turn with five
conversation turns on each side, and the latest five conversation turns. They
share one server snapshot fence but do not imply that the middle was loaded.
The desktop unions each response's explicit half-open `covered` interval and
treats its complement as known gaps. An empty covered response still closes the
gap; overlapping responses are de-duplicated by stable turn revision. Each lazy
range also carries the bounded lifecycle activities referenced by those turns;
the reducer merges them by stable activity identity and revision so historical
“worked for” timing appears when its owning turn enters memory.

`use-transcript-history.ts` starts only after the opening-position callback has
placed the viewport at unread context, a search result, or the latest message.
It then checks scroll position after layout, on scroll,
on resize, and when a hidden window becomes visible. While the viewport is
within 160 px of the loaded top edge, it requests adjacent older ranges one
at a time. It does not require a wheel, keyboard, or pointer gesture: opening
and programmatic positioning can trigger the same infinite scrolling.
A short viewport fills through this same path. Loading shows a status indicator;
there is no normal history button. An error stops automatic requests and offers
**Retry loading earlier messages**. The retry uses the shared button primitive
with a retry icon, including its hover, focus, and disabled styles. The centered
history row uses control typography and spacing in both appearances; its label
can wrap in narrow feeds without shrinking the icon. Hidden windows do not load
automatically. A disconnected feed at the loaded edge shows **Waiting to
reconnect…** and resumes automatic loading on reconnect. Newer-gap, latest,
and search errors never expose the older-range retry control.

Observers and listeners persist across streaming commits; each commit schedules
a check without cancelling a frame already pending. The content element has an
explicit ref, so child measurements are observed without relying on DOM order.
The surface tracks pending older requests per conversation and deduplicates
return visits. A separate visit generation fences scroll restoration and errors,
so A → B → A cannot apply A's original reading position to its new visit.
Pages containing no visible rows still advance canonical coverage. A response
that does not advance coverage stops with an error rather than repeating forever.

Approaching a loaded edge requests only the adjacent 20-sequence interval over
the already-open SubstreamAgent socket, and `useVirtualScrollAnchor` holds the
row the reader was looking at. **Jump to latest** never downloads the middle: the latest island is
already rendered, so the button scrolls to it immediately. The middle is filled
lazily as its edges are approached. Range membership remains fenced to the
opening snapshot even if live events append newer turns.

## Invariants

- **Only the reader's own scrolling decides where the viewport sits.** The one
  exception is a reposition the reader asked for — opening a conversation,
  **Jump to latest**, sending a message — and each of those goes through the hook.
- **The transcript's `scrollTop` is written in exactly one file.** Any new
  reposition calls `scrollTo`, `scrollToEnd`, or `release`; none of them writes
  the element directly. This is not a style rule: a write from anywhere else is
  not recorded, so its own scroll event is read as the reader's and re-arms the
  follow behind them. The protocol used to be a "claim the next event" flag the
  caller had to remember; it was replaced precisely because remembering is not a
  property a codebase has. One tolerated exception: when the virtualizer first
  measures a row above the fold, it shifts `scrollTop` by the difference from
  its estimate. Those writes are small, relative, and keep the visible text
  still, and the prepend anchor overrides them in the commit where they matter.
- **Nothing follows the end through the virtualizer.** `scrollToIndex` aimed at
  the last row with `align: 'end'` does not target a fixed offset — it targets
  `getMaxScrollOffset()`, which the virtualizer recomputes every frame for up to
  five seconds. Against a row growing with every token that is a second follow,
  competing with this one and with the reader, and its writes are not recorded so
  they re-arm this one too. The single sanctioned use is the unread-anchor open,
  where the rows above have never been measured, only the virtualizer can find
  the offset, and the row it aims at is not moving — so it settles instead of
  following.
- **Following is decided in refs, not state.** A scroll event has to be able to
  stop the follow before the next commit runs it, and a `setState` scheduled from
  the scroll handler is not guaranteed to have been applied by then. One late
  follow has already taken the viewport back off the reader. `atEnd` is state
  because it only draws a button.
- **`atEnd` is false whenever the transcript is not following.** It is recomputed
  only from scroll events, and content growing below the fold fires none — so an
  `atEnd` that tracked distance alone would freeze at `true` the moment the
  follow stopped and stay there for the rest of the turn, hiding the only control
  that leads back to the newest message while it ran away below the fold.
- **The screen that hosts this hook must re-render for every commit that grows
  the streaming row**, or the follow does not run. Since the paced reveal
  ([`streaming-reveal.md`](streaming-reveal.md)), that is once per animation
  frame while text is being revealed rather than once per wire frame — but the
  premise is the same: every write that makes the transcript taller goes
  through `queryClient.setQueryData(['messages', …])`, which re-renders this
  screen, whose layout effect corrects the viewport before that frame paints.
  It does today because `transcript` comes from the react-query cache on that
  component; memoising the row list, moving deltas into a selector, or
  revealing text from state held inside the row component would silently stop
  it, and no test would fail.

## Boundary

`useTranscriptFollow` owns *where the viewport sits* and nothing else. It does
not know what a message is, when a turn is streaming, or how tall a row is; it
reads three numbers off a DOM element and writes one back.

It depends on the screen for permission — `canFollow` is false until
`conversation-surface.tsx` has positioned this conversation, while the transcript is empty,
and whenever the end of the transcript is a page away rather than loaded, because
following an end that is not the real end would strand the reader at a boundary.
It also takes the full parent-and-substream conversation address. The shared
screen survives navigation, so both switching parents and switching children
reset follow state rather than inheriting the previous conversation's decision.

Row measurement, virtual positioning, and the scroll corrections applied when a
row's measured height replaces its estimate belong to `@tanstack/react-virtual`
and are deliberately left alone: correcting for a row above the fold that turned
out taller than estimated is what keeps the text under the reader's eye still,
and it is not the follow. This hook is called *after* `useVirtualizer` in the
same component, and that order is load-bearing — the virtualizer registers a
layout effect of its own that can write `scrollTop`, and the follow's correction
wins only by running second.

The socket events that grow a streaming message are owned by
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md), and the prepend
whose position `scrollTo` restores is described from the wire side in
[`realtime-sockets.md`](realtime-sockets.md); how a message body is rendered
belongs to [`markdown-rendering.md`](markdown-rendering.md).

This document covers the conversation transcript, which a Canvas's Chat and a
Sidekick's conversation both render through the same surface; the
automation-drafts screen that carried a second, older streaming follow is
gone.

## Failure modes and limits

- **`TRANSCRIPT_END_SLACK` is 80px**, and it also decides when the screen pages
  in newer messages. Inside it, a scroll that did not move away counts as showing
  the newest message.
- **A scroll is treated as the transcript's own within 1.5px** of the position it
  recorded. The tolerance exists because `scrollHeight - clientHeight` is computed
  from two integers while the reachable maximum is fractional.
- **A wheel over a nested scroller is ignored** only when the transcript itself
  cannot scroll up. One that arrives while the transcript *can* scroll — a code
  block scrolled mid-transcript — still stops the follow. That is the safe
  direction to be wrong in: the reader gets the viewport, and **Jump to latest**
  appears.
- **A conversation opened at an unread anchor does not follow**, even if a turn is
  streaming into it, until the reader returns to the end. This is deliberate.
- The follow reads `scrollHeight` on every commit while it is active, which
  forces layout. It is gated on the follow being on precisely so that a screen
  that is not following pays nothing.

## Testing

`use-transcript-history.test.tsx` exercises position-based paging, resize,
visibility, in-flight requests, and conversation changes. Run it with
`pnpm --filter @rally/desktop exec vitest run src/renderer/lib/use-transcript-history.test.tsx`.
The screen-level opening tests that covered request deduplication and
coverage-based termination were deleted with the Thread screens and have no
successor.

[`apps/desktop/src/renderer/lib/use-transcript-follow.test.tsx`](../apps/desktop/src/renderer/lib/use-transcript-follow.test.tsx),
in the desktop suite (`pnpm --filter @rally/desktop test`).

jsdom performs no layout, so a scroll container reports a height of zero and an
assignment to `scrollTop` is discarded. The test backs `scrollHeight`,
`clientHeight`, `scrollTop`, and `scrollTo` with a plain object on
`HTMLElement.prototype`, and the setter recording what the follow writes is the
assertion surface. It captures and restores the original descriptors rather than
deleting its own: the three geometry properties live on `Element.prototype`
today, so deleting the shadow happens to work, but a jsdom that moved them would
leave the suite with no accessor and a failure nowhere near this file.

jsdom also ships no `matchMedia` at all, so by default every test in the file
takes the optional-call path and the jump stays smooth — that default is itself
pinned by an assertion in the smooth-jump test. The two reduced-motion tests
stub `matchMedia` globally with `vi.stubGlobal`, matching the exact query
string, and the `afterEach` keeps calling `vi.unstubAllGlobals()` so the stub
cannot leak into a file that lacks the suite-wide `unstubGlobals` config.

The trap that hid a real defect here: a browser dispatches a scroll event for a
programmatic write **only when the viewport actually moved**. A helper that fires
one on every simulated token models a browser that does not exist, and it hides
every bug in which the follow declines to write — which is most of them, because
declining is what it does once the reader has taken over. `stream()` in that file
fires the event only when `scrollTop` changed.

The surface tests render `WorkstreamScreen` with socket and follow doubles,
so the complete interaction between real row measurements, unread positioning,
follow, and paging still needs Electron verification. A passing DOM assertion
does not prove that prepend restoration leaves the same message visible.

`use-virtual-scroll-anchor.test.tsx` runs the hook's decisions against rows
whose rectangles come from a layout swapped in at commit: the bottom edge held
across a prepend that adds a top gap, nothing done for an append, a vanished
key, or while following, the fall-through past a re-keyed row, and a change
above the list alone. Whether the window it predicts renders the right rows is
an integration question: verify it in Electron by reopening a long Canvas with
a fresh window (the query cache keeps loaded history across Canvas switches),
sampling every visible row's position each animation frame while scrolling up,
and checking that no row moves further than the scroll step in any frame.

## Changelog

### 2026-11-08 — A transcript that fits opens following

**What changed:** Opening at the first unread message releases the follow
only when the transcript overflows its viewport; one that fits opens at the
end and follows.

**Why:** A Sidekick run's own view, short and with an unread anchor, drew
**Jump to latest** over a transcript with nothing below it (round-2 review,
R2-15): `release()` reports `atEnd` false whatever the distance, by design, so
the button cannot be hidden from a stale measurement.

**Considered and rejected:** Hiding the button whenever the transcript cannot
scroll: content growing later fires no scroll event, so a hidden button would
stay hidden over a reply that had grown past the fold.

Shipped in juno-ai-labs/avalon#1490.

### 2026-10-08 — Hold the reading row in the commit that prepends

**What changed:** Loading an older range no longer restores the scroll position
one animation frame after the rows land. `useVirtualScrollAnchor` holds the
first visible row in the same commit, and the loading status row keeps its space
while older history exists.

**Why:** Loading earlier messages jerked and could reset the reader's position.
The old restore painted one frame of the new rows at the old offset before
correcting it, and added the height difference to a `scrollTop` captured when
the request *started*, so any scrolling during the request was undone. The
status row appearing and disappearing moved the feed twice more per load. In
Electron, the old code swapped every visible row for a frame on each prepend;
the new code moved no row more than the wheel step.

**Considered and rejected:** TanStack's `anchorTo: 'end'`, which anchors inside
the virtualizer on the row's `start`. A prepend gives the old first row a top
gap, so a start anchor moves its text down by that gap. It also follows the end
on resize when within a pixel of it, a second follow beside this module's.
Restoring from `scrollHeight` in a layout effect instead of a frame
later still misses the virtualizer's own corrections for rows measured in that
commit and renders the wrong window for a frame.

**Consequences:** A row inserted above the reader for any reason now holds
still, and the hook depends on undocumented virtualizer fields (see
[Holding the row on screen](#holding-the-row-on-screen)).

Shipped in [#1172](https://github.com/juno-ai-labs/avalon/pull/1172).

### 2026-09-06 — Load history from viewport position

**What changed:** The shared conversation surface requests older ranges whenever
its visible viewport is within 160 px of the loaded top, including after layout
or resizing. A loading status replaces the normal history button; errors expose
a manual retry and suspend automatic requests. Both states use centered control
typography and spacing; the shared retry button carries a retry icon and wraps
its label when space is constrained.

**Why:** Opening snapshots can leave most of the viewport empty, and readers
should receive earlier messages by scrolling rather than operating pagination.

**Considered and rejected:** Gating paging on upward input misses programmatic
positioning and short content that cannot scroll. Increasing the server page
size guesses at rendered height and charges every opening for extra content.

**Consequences:** Snapshot coverage and sequential requests bound the work to
the visible edge. Hidden windows stay idle. Prepend restoration remains with
the follow controller and is fenced to the conversation visit that requested it.
Observer wiring is stable across commits, and non-advancing canonical coverage
stops with a retryable error. Review regressions cover opening readiness,
return visits, wrong-direction errors, and disconnected history.

Shipped through [PR #565](https://github.com/juno-ai-labs/avalon/pull/565).

### 2026-09-05 — Opening a search result

**What changed:** Message search targets hydrate the matching range and consume navigation parameters after positioning.

**Why:** Reopening the same result must scroll again, and changing children must not inherit an unresolved target.

**Considered and rejected:** A lifetime marker keyed only by turn ID suppressed valid repeated navigation.

**Consequences:** Search positioning releases follow and must clear stale parameters before normal unread positioning resumes.


### 2026-08-28 — Automation authoring adopts the shared follow controller

**What changed:** The Automation Draft Wizard uses the same 80-pixel follow
threshold, programmatic-scroll ownership, range behavior, and **Jump to latest**
component as WorkstreamScreen.

**Why:** A second wizard-only scrolling loop had already diverged on streaming,
reconnect, and reader ownership.

**Consequences:** Changes to shared follow behavior are verified against both
screen adapters; automation-only controls do not enter the shared feed.

### 2026-08-27 — The smooth jump reads reduced motion in script, because CSS cannot

**What changed:** `scrollToEnd({ smooth: true })` — the **Jump to latest**
path — now reads `matchMedia('(prefers-reduced-motion: reduce)')` at the call
and, when it matches, falls through to the hook's existing instant path
instead of entering the smooth branch. `sidebar.tsx` makes the same read for
its own jump.

**Why:** The stylesheet's global reduced-motion kill switch sets
`scroll-behavior: auto !important`, but per the CSSOM View specification an
explicit `behavior` option passed to `scrollTo` wins over the element's
computed `scroll-behavior` — so this was the one animation in the module the
kill switch provably could not reach, and the preference had to be read in
script.

**Considered and rejected:** Keeping the smooth branch and swapping its
`behavior` for `'auto'` (or `'instant'`). It works — the instant jump's single
scroll event reports the end, which is what the settle path waits for — but it
runs an unanimated scroll through machinery that exists only for an
animation's in-flight frames, leaves the one write in the hook that records no
ownership, and keeps the follow disarmed until that event is delivered, which
is a frame of un-followed streaming for nothing. `'auto'` specifically was
also only instant by a coupling to the stylesheet (`.transcript-scroll`
declares `scroll-behavior: auto`, and the kill switch forces it besides),
where the instant path depends on nothing. The fall-through reuses a path the
module already trusts.

**Consequences:** Under the preference the jump is a recorded write: the
follow re-arms synchronously and the resulting scroll event is recognized as
the hook's own, per the invariant that every write records the position it
left behind. The smooth branch no longer contains a reduced-motion case at
all, so its settle-on-arrival rationale holds unconditionally again. Anything
else that drives motion from script — an explicit `behavior` option, a
`setTimeout` hold — must make this same choice itself; the CSS kill switch
will not save it.

Shipped in [#376](https://github.com/juno-ai-labs/avalon/pull/376).

### 2026-08-26 — Opening carries unread context and an immediately usable tail

**What changed:** The transcript reducer now tracks explicit covered intervals,
unions overlap, retains gaps, requests one adjacent block at a time, and uses the
preloaded latest-five island for **Jump to latest**.

**Why:** One cursor implied that everything between downloaded pages existed in
memory. Opening near unread history either delayed first paint on the full tail
or made jumping to the running end wait for every intervening page.

**Considered and rejected:** Treating returned rows as coverage and loading the
entire middle before jumping. Empty ranges and status-only spans make row-based
coverage loop forever; the latest island makes the eager download unnecessary.

**Consequences:** New range transports must preserve half-open coverage and the
snapshot fence. Scroll restoration still goes through `useTranscriptFollow`;
range loading does not gain a second `scrollTop` writer. Range activity payloads
remain proportional to loaded turns and their ancestry, not total work-stream
history. The existing run-metadata timer remains the live fallback until a
canonical response activity has a loaded assistant-turn anchor; after that
point the ordered timing row is the only renderer, avoiding both a reconnect
gap before the first committed assistant turn and a duplicate historical row.

### 2026-08-22 — The reader's scrolling, not the screen's, decides where the transcript sits

**What changed:** Following the newest message moved out of the work-stream
screen into `useTranscriptFollow`, which is now the only code that writes
`scrollTop` on the transcript. It holds the end with a single write in a layout
effect instead of calling the virtualizer's `scrollToIndex` once per token; it
stops on the first upward wheel tick as well as on any scroll away from the end;
it tells its own scrolling from the reader's by the position it recorded rather
than by a flag; and `atEnd`, which draws **Jump to latest**, now tracks whether
the transcript is following rather than distance alone.

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

Two things were wrong with the first attempt at the fix, and both are why the
mechanism here is not the obvious one. A boolean "the next scroll is mine" flag
has to be spent exactly once, and it is not: a write the browser clamps away
emits no scroll event, and a reader scroll in the same frame as a correction
arrives coalesced into one. Either way the flag is spent on the reader and the
follow drags them back — for a keyboard or scrollbar scroll, which produces no
wheel event, with nothing to catch it. And `atBottom`'s replacement, `atEnd`,
was computed from distance alone; because content growing below the fold fires no
scroll event, it froze at `true` the moment the follow stopped and stayed there,
hiding the jump control while the reply ran hundreds of pixels below the fold.

**Considered and rejected:**

- *The virtualizer's own `anchorTo: 'end'` and `followOnAppend`.* These exist for
  this exact case — `virtual-core` carries a comment about "a streaming chat
  message growing at its bottom" — and would have deleted this module outright,
  so they were tried rather than argued about. They disengage more cleanly than
  this hook does (a ten-tick gesture escaped with zero direction reversals
  against one) but they do not hold the end: measured over 400 tokens with
  `scrollMargin` set correctly, the gap below the fold oscillated between 130 and
  179px instead of staying at 0. `anchorTo` engages on
  `getVirtualDistanceFromEnd()`, which is computed in the virtualizer's
  coordinates and clamps to zero across the transcript column's bottom padding,
  so it holds *approximately* the end and wanders inside that band. Approximately
  is what the reader was complaining about.
- *Keeping `atBottom` as the single source of truth and only fixing the
  threshold.* Any threshold is out-scrolled by the correction, because the
  correction always lands exactly at the end. The signal has to be that the
  reader moved *away*, not how far they got.
- *Keeping the follow on `scrollToIndex` and cancelling its reconcile loop when
  the reader takes over.* The cancel is a scroll write of its own, issued in the
  middle of a gesture. Not calling `scrollToIndex` to follow anything is both
  smaller and stronger.
- *A `setState` rather than refs for the follow decision.* Rejected on ordering:
  the scroll handler's update is not guaranteed to be applied before the commit
  the next token schedules, and one late follow is the entire bug.

**Consequences:** The transcript container has exactly one writer, and a
reposition added later must go through it — `scrollTo`, `scrollToEnd`, or
`release` — or its scroll event will be read as the reader's. `scrollToIndex` is
sanctioned only for the unread-anchor open, where it aims at a row that is not
moving; aimed at the last row with `align: 'end'` it follows the growing end for
five seconds and re-arms this follow through the scroll events it produces.
`atEnd` must keep tracking the follow and not distance, or the jump control
disappears exactly when it is needed. The hook must be called after
`useVirtualizer` in the same component, and that component must re-render per
streamed token.

Shipped in #237.
