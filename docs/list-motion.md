# List motion

How a row that changes place in a list travels there instead of reappearing.
The sidebar's rows move for reasons the reader did not cause — someone else's
change lifts a Canvas to the top of **All Canvases**, a pin moves a row into
**Pinned**, a Sidekick waiting on input moves into **Needs input** — and a row
that simply vanishes from one slot and materialises in another reads as two
events rather than one move. This module makes it one: the row
slides out of frame to the left, the rows between its two slots close the gap,
and it slides back in from the left at its new slot. A row whose arrival or
departure is itself the change, which a list may mark `data-motion-insert`, plays
the same two halves on their own: in from the left when it appears, and out to the
left, through a stand-in, when it is removed. The Canvases list marks a
row that arrives after the list first did (a Canvas just made), so it slides in
rather than overprinting the row it displaces.

Nothing in it knows what a Canvas is: the sidebar's Canvases and Sidekicks
lists are its callers, and it is written against a small contract — keyed rows under a
scroll box — so another list could take it without a second implementation. The
transcript's own arrival motion in `message-feed.tsx` (`data-arrival-id`) is a
different thing, an entrance for a new message rather than a move, and stays
where it is. The sidebar no longer collapses
([`desktop-shell.md`](desktop-shell.md)), so the compact layout this module
used to keep out of the way of is gone; the `layoutKey` and `layoutSettling`
inputs below remain wired and tested but no longer change in the app.

Read this before changing when a sidebar row animates, how long any part of the
choreography takes, or before adding motion to another list.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| [`apps/desktop/src/renderer/lib/list-motion.ts`](../apps/desktop/src/renderer/lib/list-motion.ts) | The arithmetic, pure over measured positions: `planListMotion` decides which rows moved and which were displaced, `exitKeyframes` and `enterKeyframes` are the two halves a removed and an inserted row play, `moverKeyframes` composes them for a row that did both, `shifterKeyframes` is what a displaced row plays, `LIST_MOTION` holds every duration, stagger, and easing, and `layoutRowAt` answers which row is laid out under a pointer while rows are in motion. Owns no timer. |
| [`apps/desktop/src/renderer/components/navigation-rows.tsx`](../apps/desktop/src/renderer/components/navigation-rows.tsx), `canvas-sidebar-section.tsx`, `sidekick-sidebar-section.tsx` | Each list attaches the hook to the sidebar's shared scroll box through `useSectionMotion`, so a list's first render plays nothing and switching sections is never read as a move. Rows are keyed `canvas:` and `sidekick:` with their id; a pinned row and its list row are never drawn together, so a pin is one row moving between sections without a scope. Every section heading (`SectionHeading`) is a held row. |
| [`apps/desktop/src/renderer/lib/use-list-motion.ts`](../apps/desktop/src/renderer/lib/use-list-motion.ts) | `useListMotion(containerRef, layoutKey?, layoutSettling?)`: measures the rows after every commit, plans against the positions it last saw, and plays the plan through the Web Animations API; plays a marked row's entrance, its exit on a stand-in, and honors `data-motion-move` when the product action identifies a mover whose old and new boxes coincide. Owns the interruption handling. `useListMotionPass` is the same pass handed back instead of run, for a list drawn by several components that each re-render alone: each runs it from a layout effect, and a second run in one commit plays nothing. |

### The contract a list makes

A row is any element under the container that carries `data-motion-key`. The
key is what makes a row *the same row* across renders: a Canvas keeps its
key while it moves from **All Canvases** to the **Pinned** section, even
though each of those is a separate subtree and React unmounts one element and mounts another; that
is what lets the hook follow it. Any container under the scroll box is the same
to the hook — a section, a group, a nested member list — so a row moving
between two of them is one row moving. Two rows that would share a key are told apart by
`data-motion-scope` on any ancestor — an item listed under a group and again in
a flat list is two rows, and each moves within its own list. A scope is also
the list its rows are ranked within: two groups trading places carry their
expanded members past each other, and the members, whose order among
themselves is unchanged, shift with their group rather than leaving the frame
as if each had been moved on its own. A group's own row is a held row for the
same reason, on the row rather than the item that contains the members,
because the members animate themselves and a moving container would carry them
a second time. No list in the app uses a scope today; the retired Projects
sidebar was its caller. A row is
*held* — placed rather than moved: shifted into its slot like a neighbour
instead of leaving and re-entering, and taking no part in deciding which rows
moved — in two cases. One is `data-motion-hold`: the sidebar holds every
section heading (**Needs input**, **Pinned**, **All Canvases**, **All
Sidekicks**), so a heading travels with the rows under it and the whole column
glides, and so a row leaving the pinned section for the top of the list below
passes that list's heading without the heading being the thing seen to leave. The other is focus: a row that kept its element
and has focus inside it is one the reader is acting on, such as the click that
opened it, and it stays under them rather than flying off through the slot
they are looking at. A remounted
row with focus is not the reader's doing, and it travels.

A row with no layout — one under `display: none` — is neither measured nor
remembered. It is closer to not being there than to being at the top of the
container, which is what its empty rect would say, and when it comes back it
is a row never seen before and is left alone.

A row that carries `data-motion-insert` is one whose arrival and departure are
themselves the change, and it is seen making them. When it first appears it
plays the entrance — the second half of a mover's choreography, on its own.
When it is removed it plays the exit, the first half, on a **stand-in**: React
has already taken the row's element out of the document by the time the hook
runs, so the hook clones the element it last measured, places the copy
absolutely over the slot the row left — the container is the copy's
positioning context, and has to be positioned — and removes the copy when the
exit finishes or is cancelled. The copy is a picture of the row and nothing
else: it is `inert`, hidden from assistive technology, and stripped of its
`id`s and of every `data-motion-` attribute, so the document keeps one of each
id and the next render does not measure the copy as a row. Every other
attribute stays, because the copy has to still look like the row, which also
means a caller that finds rows by some other attribute can find the copy for
the length of its exit. Every other row still appears and disappears in place —
a page of rows arriving at once is not a move — and nothing at all plays on
the hook's first commit, whatever the rows carry, so a list that mounts with a
marked row already in it does not open with that row sliding in from nowhere.

The container is the scroll box the rows live in. Positions are measured
relative to its content, not the viewport, so scrolling between two renders is
not mistaken for every row having moved.

### Measuring and planning

After every commit — a layout effect with no dependency list, because which
rows changed place is precisely what a dependency list would have to know in
advance — the hook reads each row's position with `getBoundingClientRect` and
compares it with the positions it recorded the last time. Rows it has never
seen are left alone: a page of rows arriving at once is not a move, and there is
no old slot to leave from. Rows that are gone cannot be animated.

The hook takes a `layoutKey` naming the layout the rows are in. When it
changes, every row is measured afresh and nothing plays, because a relayout
moves every row's position for a reason that is not a reorder. No caller
passes one now; the collapsing sidebar passed `compact`.

It also takes `layoutSettling`, which says the rows are still travelling to
that layout. The sidebar's rows change shape under CSS transitions for as long
as its box's width does, and a move planned against positions still in flight
would fight that travel: every render while the flag holds measures afresh and
plays nothing, and so does the first render after it clears, so that the last
positions measured mid-flight are not the ones the next change is planned
from. The collapsing sidebar raised the flag in the render that changed the
layout, and then followed the platform's own transition events for
`--sidebar-compact` on the aside, which is how a caller should drive it: `transitionrun` keeps it raised, `transitionend` and
`transitioncancel` clear it — counted rather than last-event-wins, because a
toggle reversed mid-flight cancels one transition and starts another in the
same style change and nothing pins which event arrives first — and a frame
after the change — once those events
have had their chance — the caller clears it itself if no transition started,
as under a drag, which turns them off. The toggle raises it first because
`transitionrun` is dispatched with the first frame after the change, and a
render landing before it would plan against rows a frame into their travel. A
timer was not used: it would have to know a stylesheet's duration and would
still be wrong under a drag. The one thing a relayout leaves playing is an entrance: it
travels horizontally only, so the slots it was measured between do not stale
it.

`planListMotion` sorts the rest into two kinds. Within each scope, among the
rows that are not held, the largest set that kept their relative order is found
as the longest increasing run of old ranks read in the new order; everything outside that set
is a **mover**, everything inside it that nonetheless sits at a different
position is a **shifter**, and a held row is a shifter whatever moved past it. This
is the smallest set of moves that explains the change: one message lifting a
row to the top of its group yields one mover and a shift of one slot for each
row it passed, rather than "every row above it moved". It is more general than
any single trigger needs — every trigger the sidebar has today moves one row —
and it is used because the hook cannot see the trigger: a socket update that
moves two rows at once, two messages in one frame, gets the same treatment
without a special case, and the single-mover case falls out of it.

### Playing it

Everything starts on the same frame. A mover plays one animation with three
phases, each timed by a field of `LIST_MOTION` — the numbers live there and
are not repeated here:

1. **Exit** (`exitMs`, accelerating away): from its old slot — expressed as a
   vertical offset from the slot it now occupies — leftwards until it has
   cleared the container's left edge. The distance is measured per row, from
   the row's right edge to the container's left edge plus `exitClearancePx`,
   because a fraction of the row's own width would leave a narrow row's edge
   showing in a wider container.
2. **Stagger** (`enterStaggerMs`): off frame, and now at its new slot. The
   jump between the two slots happens here, where it cannot be seen. The pause
   is what reads as "left, and came back" rather than a bounce off the edge; it
   is short because the row cannot be in two places, so this is the only part
   of the choreography that has to wait for another.
3. **Enter** (`enterMs`, decelerating into place): from off frame at the new
   slot back to rest.

Shifters play a straight translation from their old position to rest over
`shiftMs`, starting on that same first frame — the shift outlasts the exit and
the stagger together, so the gap is closing while the mover is still on its way
out, and the mover is on its way back in while the gap is still closing.
Nothing is sequential except the stagger.

An inserted row plays the entrance alone: parked off frame for the length of
an exit and the stagger, then in — the wait is for the rows below it, which
shift down over `shiftMs`, to have opened the gap before it lands, as they
close it before a mover returns. A removed row's stand-in plays the exit
alone, held at its end until the finish handler takes the copy out. The rows
around either shift exactly as they would for a mover.

Each kind of motion takes the standard curve for what it is doing: a row
leaving the frame accelerates (`exitEasing`), a row arriving decelerates
(`enterEasing`), and a row moving from one place on screen to another starts
and ends at rest (`shiftEasing`).

Every animation is a `transform` run by the Web Animations API, so it is
composited and travels at the display's own refresh rate; nothing here runs per
frame, and the main thread being busy does not stutter it. The scroll box has
`overflow-x: hidden`, so a row translated past its left edge is clipped rather
than scrolled to.

### Renders that move nothing

The sidebar re-renders far more often than its rows move — for the pointer
nearing its edge, for the reveal clearing itself a tick after the row it
followed has landed — and that last one arrives about thirty milliseconds after
the render that moved the row, before its animation has drawn a frame. A hook
that cancelled and re-planned on every render would erase the motion there and
then: measured in the running client, a pin produced four generations of
animation in fifty milliseconds, each cancelling the last, and the row was seen
to shift rather than leave.

So a render touches only the rows whose *layout* changed since the last one. A
row still at the position it was last measured at keeps whatever it is playing,
and enters the plan at rest so the planner can still rank the whole list; a
render in which no row's layout changed measures, remembers, and does nothing
else.

### Interruption

A list can change again before the last change has finished playing — a drag
fires `dragover` on every row the pointer crosses, and a second message can
land inside half a second. For each row a render did move, the hook first
reads the translation the row's running animation is applying, through its
computed `transform`, then cancels it and plans from *that* position rather
than from the row's old slot, so a row half-way through a shift continues from
where it visibly is. An animation that has not drawn a frame yet applies
nothing to the computed style, so for one still pending the hook uses the
offset the animation was about to start from instead. There is one animation
per phase set rather than three chained ones for the same reason: an
interruption has one thing to cancel, and the phases cannot drift apart under
load.

### Rows in motion stay targets

A row in motion keeps its pointer events: a click on a row that is sliding
lands on that row, and nothing it needs is taken away for the length of an
animation. What that leaves to solve is a list that reorders on `dragover`,
which no sidebar list does today (neither Pinned group reorders; the retired
Threads Pinned list did). Such a list moves the dragged row to the slot of
whichever row the event reaches, and mid-motion the row drawn under the pointer is not the row that
belongs there — after one reorder, the row the dragged row displaced glides
out through the pointer's position, an event on it would move the dragged row
back, and the two would trade places until the pointer moved. It therefore
resolves a drag's target with `layoutRowAt`: the row whose *layout*
box, net of any translation it is playing, contains the pointer. A row gliding
through a slot resolves to the slot's layout owner, which after the reorder is
the dragged row itself, and a drag reversed mid-motion resolves to the rows'
final slots at once rather than waiting for them to settle. Where rows have no
layout at all, as under jsdom, nothing contains the pointer and the row the
event reached is the slot.

## Invariants

- **Rows are ranked within their scope, never across scopes.** A scope that
  moves as a block must shift as a block; ranking its rows against the rows
  outside it would read every member as having passed them and send each out
  of frame on its own, while the unkeyed container jumped.
- **A key names one row for as long as it is the same row to the reader.** A
  key that changes across a move — an index, say, or a key that includes the
  section — makes the hook see one row disappear and a stranger appear, and the
  move is not animated. A key that two rows share within one scope makes them
  one row that is in two places, and whichever the hook measures last wins.
- **Positions are remembered whether or not anything plays.** Reduced motion, a
  hidden window, and an environment without `element.animate` all skip the
  animation but still record where the rows are, so a change made while the
  window was hidden is not replayed when it is shown again, and the first
  visible change after that animates from the right place.
- **The exit clears the container, not the row.** The distance is measured
  against the container's left edge for every row, so the choreography does not
  depend on the row's width.
- **A render that did not move a row's layout does not touch that row.** The
  render that follows a move lands before the move has drawn a frame; a hook
  that re-planned every row on every render would cancel the motion before
  anyone saw it, and would have to read positions off animations that have not
  started. Anything that makes the hook cancel or restart an animation on an
  unchanged row brings that back.
- **A list that reorders on `dragover` resolves the target by layout, never
  by the row the event reached.** Hit-testing follows the drawn box, and a row
  in motion is drawn where it is no longer laid out; reordering against it
  moves the dragged row back and forth for as long as the two overlap.
  `layoutRowAt` is the one answer; a second caller must not hit-test.
- **A held row is the reader's, or a heading's.** Focus decides the first only
  for a row that kept its element: the sidebar moves focus onto a remounted
  row on purpose, and that row is still the one that travelled.
- **Anything that scrolls to a row does so before this hook's effect runs.**
  The motion's first frame puts a moved row back where it came from, and the
  platform scrolls to the transformed box. A scroll made after the effect, from
  a later-declared layout effect or a passive effect, reads the row as still on
  screen and does nothing. The retired Pinned reveal was a layout effect
  declared ahead of the hook for exactly this reason.
- **Nothing here runs per frame.** The hook does its work once per commit and
  hands the frames to the compositor. A change that animates `top`, `height`, or
  anything but `transform` and `opacity` would move the work back to the main
  thread, and would also change the rows' layout under the pointer mid-move.
- **Nothing plays on the hook's first commit.** A list that mounts with a
  marked row already in it would
  otherwise open with that row sliding in from nowhere.
- **A stand-in is a picture, and the container it is drawn in is positioned.**
  It is inert, hidden from assistive technology, without ids or motion
  attributes, and gone the moment its exit settles or the hook unmounts. Drawn
  in a container that is not positioned, it lands over the nearest positioned
  ancestor's origin instead of over its slot.
- **An entrance survives a relayout; a move does not.** A move is measured
  between slots the new layout has replaced; an entrance is horizontal, and is
  the change the relayout was made for.
- **A caller whose rows change shape under CSS reports the travel.** The hook
  measures on every commit and cannot see a transition; a render that lands
  mid-flight without `layoutSettling` plans against positions still moving,
  and the rows are seen to fight their own transition.

## Boundary

The module owns which rows move, how, and for how long. It exposes one hook,
the four data attributes, and `LIST_MOTION`.

It does not decide *where* rows go — the server's list order and `splitPinned`
do that, and [`pinning.md`](pinning.md) owns the Pinned
group. It does not scroll; no sidebar list scrolls a pinned row into view
today, and one that does composes with the hook on two conditions: the hook measures against the scroll box's content rather than the
viewport, so the scroll does not read as movement, and the scroll runs as a
layout effect declared *before* the hook, so the row is scrolled to before its
first frame translates it back to the slot it left — `scrollIntoView` scrolls
to the box as transformed, and `nearest` would otherwise find the row still on
screen where it used to be and scroll to nothing. It animates a row entering
or leaving the list only when the row is marked for it — see
[Failure modes and limits](#failure-modes-and-limits) — and it does not own
the shapes the rows take in each layout or the transitions between them,
which are the sidebar's stylesheet's and
[`conversation-surfaces.md`](conversation-surfaces.md)'s. And it does not touch
the drag itself: what a drag reorders and when it commits is the pinned
section's, and this module only asks, through `data-motion-hold`, that the row
under the pointer is placed rather than made to leave and re-enter on every
step.

## Failure modes and limits

- **Rows entering or leaving are animated only when marked.** An unmarked row
  appears in place and the rows it displaced shift; a removed one is simply
  gone and the rows below it shift up. The marking is opt-in because a page of
  rows arriving at once is not a move, and because an exit needs a stand-in
  kept in the document after React has removed the row — a clone of the
  subtree, which the reader cannot tell from the row for 160ms — which is
  worth paying for a row whose leaving *is* the event and not for every row a
  socket update drops.
- **A stand-in exits from the row's slot, not from where it was drawn.** The
  offset an animation was applying is read per connected element, and a removed
  element has no computed style; a marked row removed mid-shift restarts from
  its slot, and one removed mid-entrance appears at its arrived slot for a
  frame before leaving. Reading the offset off the entrance's own timing would
  need the easing curve evaluated by hand.
- **A row that loses its layout counts as gone.** `display: none` and
  unmounting look the same to the hook, so a marked row hidden by a stylesheet
  plays its exit through a stand-in while its own element stays in the
  document.
- **A row whose element is replaced mid-animation restarts its motion from its
  slot.** The in-flight offset is read per element, so a row that is unmounted
  and remounted while an earlier animation on it was still running loses that
  offset. It is a visible pop only when a pin and a message on the same row land
  within half a second of each other.
- **Two rows trading places can read as one mover and one shifter, or as two
  of either.** The planner keeps the longest run of unchanged order, and a swap
  has two equally long ones; whichever the run keeps shifts, and the other
  leaves and re-enters. Both readings are coherent, and the action that caused
  the swap is not something the hook can see.
- **Reduced motion plays nothing.** A reader who has asked the platform for less
  motion sees rows in their new places at once, as before this module existed.
- **The numbers in `LIST_MOTION` are the team's to tune.** They were chosen by
  eye against the running client so that the whole choreography is over inside
  about half a second — long enough to follow, short enough that a row moved
  by somebody else's message is not an interruption — and no measurement of
  reader behaviour informed them.
- **A focused row that moves is held.** A row the reader just clicked keeps
  focus and its element, so if the list re-sorts it at that moment it glides
  rather than leaving the frame under the cursor that clicked it. The retired
  Threads list, ordered by the reader's own visits, made this the common case;
  the Canvases list is ordered by the Canvas's activity, so it is rarer now.

## Testing

| Suite | What it covers |
| --- | --- |
| `apps/desktop/src/renderer/lib/list-motion.test.ts` | The planner's classification — one mover, two movers together, a held row, a heading never being the mover, scopes ranked apart so a block shifts as one, a row that moved between containers, an interrupted offset — and the exact keyframes and options each kind plays, the exit and the entrance on their own included. |
| `apps/desktop/src/renderer/lib/use-list-motion.test.tsx` | The hook under jsdom: the exit distance measured against the container, shifters starting on the first frame, a row followed across a remount, a held row shifted instead of moved, a render that moved nothing leaving every animation alone, interruption touching only the rows that moved and reading a pending animation's own start, a late cancel not clearing its successor's record, reduced motion and a hidden window both remembering positions while playing nothing, measurement through the container's scroll, a focused row held only while it keeps its element, a row with no layout neither measured nor remembered, a changed layout key measuring afresh, scopes keeping shared keys apart, nothing playing on the first commit, a marked row entering after the gap opens and leaving through a stand-in whose inherited grid placement is cleared and which is removed when its exit settles, reduced motion leaving no stand-in, a settling layout measuring afresh until the render after it settles, and an entrance surviving a relayout that cancels a move. |

jsdom lays nothing out and implements neither `Element.prototype.animate` nor
`getAnimations`. The hook tests install `getBoundingClientRect` and `animate`
on the prototype in `beforeEach` and delete them again afterwards — deleting
rather than restoring, so the gap stays visible to any later test that would
otherwise find a stub. Positions follow document order, one slot per row, which
is what a grid list gives. The `animate` stub returns a record whose `onfinish`
and `oncancel` the test calls by hand; nothing advances a clock.

Run them with:

```bash
pnpm --filter @rally/desktop exec vitest run src/renderer/lib/list-motion.test.ts src/renderer/lib/use-list-motion.test.tsx
```

The motion is judged in a real window, per
[`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it): move a
row (a pin from its right-click menu, say), then pause every animation with
`document.getAnimations()` and step `currentTime` through the phases to capture
each one.

## Changelog

### 2026-11-08 — A new Canvas's row slides in

**What changed:** The Canvases section marks a row that arrives after its
first list with `data-motion-insert`.

**Why:** This document promised a row that appears plays in from the left,
but no Canvas row was marked, so a new Canvas was drawn in place over the row
it displaced for the length of the shift (v1-F6). The first list and the
device cache's rows still play nothing.

### 2026-10-16 — One pass, run by every part of a list

**What changed:** `useListMotionPass` returns the pass `useListMotion` runs,
and `useListMotion` is now that pass run from its own layout effect. The
sidebar's Pinned tab owns one and both of its sections run it.

**Why:** The Pinned tab draws the Channels and Threads sections in one scroll
box. A hook in each would animate every row twice; one hook in the tab missed
every commit only a section made, such as a drag preview, so the rows jumped.

**Considered and rejected:** A per-commit guard so the pass runs once. A
layout effect that sets state commits again before any microtask, so the
guard skipped real commits; a second run in one commit already plays nothing,
since it finds every row where the first left it.

**Consequences:** The 2026-10-12 rule still holds for each part: state that
changes a part's rows must live in a component that runs the pass. A part's
first effects run before an ancestor's ref is attached, so a list mounted with
its scroll box measures from its second commit.

### 2026-10-12 — The new sidebar's tabs move their rows again

**What changed:** Each of the Threads, Channels and Activity tabs calls
`useListMotion` on the shared scroll box.

**Why:** The redesign shipped the lists without motion as a scope cut, so
rows jumped instead of moving.

**Considered and rejected:** One call in `NavigationSidebar` keyed on the
section. A relayout still plays entrances, so every pending request would have
slid in on each switch to Activity.

**Consequences:** The hook measures only when its caller renders. State that
changes a tab's rows must live in that tab or above it, and a row moving
between two lists must move in one render.

Shipped in [#1197](https://github.com/juno-ai-labs/avalon/pull/1197).

### 2026-09-21 — A named mover can travel between equal slots

**What changed:** A row may set `data-motion-move` for the commit caused by a
known product action. The planner excludes that row from the kept subsequence
and the hook runs its mover choreography even when its measured vertical offset
is zero.

**Why:** Pinning inside a selected Space moves a Channel from the ordinary list
to the Space's pinned list, but the two sections can place it at the same y
coordinate. Geometry alone then classified the remounted row as unchanged, so
the action looked like a disappearance and replacement despite the identity
being known.

**Considered and rejected:** Adding fake distance to the measurement or making
every remounted row a mover. The former corrupts layout truth; the latter turns
unrelated conditional rendering into motion. The marker is narrow and lasts
only for the pin response that names the row.

**Consequences:** A forced mover may have `translateY(0)` while still playing
the horizontal exit and entrance. Callers must set the marker only on the row
whose identity the action actually moved.

### 2026-09-21 — Command rows keep stable grid ownership through sidebar layout changes

**What changed:** The collapsed Channel and Space sidebars place New channel in
the command bar's first grid row and Search in its second in both layouts. The
first track grows from zero instead of reassigning Search to a different row,
and the Space sidebar supplies the shared layout-motion interval. An exiting
row's stand-in clears any inherited grid placement before using its measured
absolute coordinates.

**Why:** New channel belongs above Search in the compact rail. Merely reordering
the elements made Search switch rows discretely, so it jumped while the sidebar
edge travelled. The exit clone also retained the source button's grid row,
making its measured `top` relative to that area and visibly applying part of the
offset twice.

**Considered and rejected:** Translating Search independently, which would
duplicate the grid's layout arithmetic and could drift from future spacing
changes. Excluding only the current button class from stand-in placement, which
would leave the reusable motion primitive vulnerable to any future grid row.

**Consequences:** Command-bar callers preserve stable row ownership with numeric
tracks in every layout. A stand-in is never a participating grid item: its
inline `grid-area: auto` makes the container padding box the positioning frame,
and its measured `top` and `left` are the only placement authority.

Shipped in #893.

### 2026-09-10 — Marked rows are seen arriving and leaving, and the hook holds while a layout travels

**What changed:** A row marked `data-motion-insert` plays the mover's entrance
when it first appears and the mover's exit, through a stand-in, when it is
removed; the mover's keyframes are now composed from those two halves rather
than written out. Nothing plays on the hook's first commit. `useListMotion`
takes a third argument, `layoutSettling`, under which every render measures
afresh and plays nothing, as does the first render after it clears, and only an
entrance survives a relayout. The sidebar attaches a second instance to the
command bar above its scroll box, marks the rail's New chat row there, and
reports the flag: raised by the toggle itself, kept by the aside's own
`transitionrun` for `--sidebar-compact`, and released by its `transitionend`
or `transitioncancel`, or a frame later when nothing started.

**Why:** The compact toggle was reported as a cut — the box's width glided and
everything inside it snapped a frame ahead of the edge — and the search and
New chat controls, which changed shape and place with it, snapped hardest.
Making the rows' shapes CSS transitions on the box's own interval, in
[`conversation-surfaces.md`](conversation-surfaces.md), fixed the rows but put
this hook in the way of them: it measures on every commit, and a render landing
mid-flight — the reveal clearing, a socket update — would have planned shifters
against positions still moving and sent rows fighting their own transition.
The New chat row is the one control the toggle genuinely inserts and removes,
and the request was for it to use the row insert and remove motion; the
choreography already had the two halves, and the case that had been read
narrowly on 2026-09-08 now had a caller.

**Considered and rejected:** Detecting the travel inside the hook from running
`CSSTransition`s on the rows, which needs no caller wiring but cannot tell a
geometry transition from a hover fade without a list of properties that would
have to be kept. A timer matching the collapse duration, which would have to
know a number that lives in a stylesheet and would be wrong under a drag,
which turns the transition off. Animating exits for every removed row, which
would clone a subtree for each row a socket update drops. Keeping the New chat
row rendered in both layouts and hiding it by CSS, which is not an insertion
and would have needed a starting style that also fired on every mount.

**Consequences:** A list that marks rows for insertion must be a positioned
container, and any selector that finds its rows by an attribute other than the
motion ones can find a stand-in for 160ms. A caller whose rows change shape
under CSS reports the travel or gets rows fighting their transition. React's
synthetic `transitionrun` and `transitioncancel` carry no `propertyName`; the
sidebar reads it from the native event, and so must any second caller. The
entrance's wait is the mover's, so an inserted row lands about 180ms after a
240ms layout has; a different rhythm for insertions is a change to
`enterKeyframes`, not to the hook.

Shipped in #648.

### 2026-09-09 — Drags target the slot laid out under the pointer, and the reader's own row is held

**What changed:** Rows in motion keep their pointer events; the pinned list
resolves a drag's target with `layoutRowAt` instead of the row the event
reached. A row that kept its element and has focus inside it is held. A row
with no layout is neither measured nor remembered. `useListMotion` takes a
`layoutKey`, and the sidebar passes the compact toggle. The hook keeps one
animation per element rather than a list.

**Why:** Review found the earlier `pointer-events: none` guard landing on every
shifter, so a click on a row gliding one slot was lost — and on the mobile
drawer bubbled to the navigation's own close handler — and a drag reversed
mid-motion waited on each row to settle. The guard existed only to stop a
drag reordering against a row gliding through the pointer; resolving the
target by layout removes that cause instead of masking it. Review also found
the choreography firing on the click that opens a work stream, whose row is
lifted by the visit, and the `Alt`+`Arrow` move sending the focused row out of
the clipped container; the compact toggle sliding every row for a relayout;
and hidden headings measured at the top of the container. The per-element
list of animations modelled a case the interruption path made impossible.

**Considered and rejected:** Keeping the guard on movers only, which would
have left the drag oscillation possible against a mover. Reserving the full
choreography for section changes and shifting within a section, which would
have made a message lifting a row within its group a shift too, against the
request this module was built for; holding on focus draws the line at the
reader's own action instead.

**Consequences:** A second list that reorders on `dragover` must resolve its
target through `layoutRowAt`. A caller whose layout changes for a reason other
than a reorder names that layout, or every row slides on the change. A test of
the wiring can no longer assert on pointer-events; it asserts on what plays.

Shipped in #612.

### 2026-09-09 — The reveal scrolls before the motion starts

**What changed:** The sidebar's reveal became a layout effect declared before
`useListMotion`, and the ordering is an invariant above. Rows are also ranked
within their scope rather than across the whole list, and each project row is
held, so a project reordered past another glides with its expanded members.

**Why:** Review found the reveal scrolling to nothing: `scrollIntoView` reads
the transformed box, and the motion's first frame had already put the pinned
row back in the slot it left, so `nearest` saw it on screen. Reproduced in the
running client with a scroll box shrunk to two rows. The same review found two
expanded projects trading places sending every member out of frame on its own
while the unkeyed project row jumped, because members were ranked against the
whole sidebar.

**Considered and rejected:** Scrolling by hand from the row's layout position
net of its transform, which would have worked but replaced `scrollIntoView`
and every test on it with arithmetic the platform already does. Delaying the
reveal until the motion ends, which reads as the sidebar noticing late.

**Consequences:** Anything else that scrolls to a row on the render that moved
it has to run before the hook's effect. A block that should move as one needs
its own scope and a held row for its container's own row; the container element
itself must not carry a key, or its children are carried twice.

Shipped in #612.

### 2026-09-08 — Document created

**What changed:** The module was built. The sidebar's rows had jumped to their
new places; now a row that changes place slides out to the left, the rows
between its slots close the gap, and it slides in from the left at its new slot,
at the display's frame rate.

**Why:** A row moving on its own — because a message arrived, or because the
reader pinned it — read as a row vanishing and another appearing, and the
reader was left to find it. The reveal that scrolls a pinned row into view had
already been added for the same reason, and only covered the one case the
reader caused.

**Considered and rejected:** A CSS-transition FLIP keyed on React state was the
obvious shape, but the moving row's *exit* has to play from a slot the row no
longer occupies, which a transition cannot express; keyframes with a parked
phase can. Chaining three animations per row was rejected because an
interruption would then have three things to cancel and the phases could drift
apart under load. Animating from a dependency list of the sidebar's inputs was
rejected because which rows changed place is what the list would have to know
in advance; measuring after every commit costs one layout read per row and
finds out. A single mover keyed to the action the reader took was rejected in
favour of classifying every row by the longest kept order, because most moves
are not the reader's action and the sidebar cannot say which row a socket
update moved. The first cut ran the three phases in sequence — exit, then the
gap closing, then the entry — and re-planned every row on every render; the
sequence was replaced by everything starting together with a stagger before
the entry, because the sequential version read as three events, and the
re-plan was replaced by touching only rows whose layout changed, because the
sidebar's next render cancelled the motion before its first frame.

**Consequences:** A list that wants this motion marks its rows and attaches the
hook; it does not write its own. Anything that changes a row's key across a
move, or gives two rows one key in one scope, silently turns the motion off for
them. The durations live in `LIST_MOTION` and nowhere else, and the choreography
is one animation per row, so a change to the phases is a change to the
keyframes rather than to the hook.

Shipped in #612.
