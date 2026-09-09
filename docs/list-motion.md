# List motion

How a row that changes place in a list travels there instead of reappearing.
The sidebar's work-stream rows move constantly and for reasons the reader did
not cause — a message arriving lifts a row to the top of its group, a pin moves
it into a different section, a drag or an `Alt`+`Arrow` rearranges the pinned
list — and a row that simply vanishes from one slot and materialises in another
reads as two events rather than one move. This module makes it one: the row
slides out of frame to the left, the rows between its two slots close the gap,
and it slides back in from the left at its new slot.

It is a primitive rather than a sidebar feature. Any list whose rows carry a
stable key can take it, and nothing in it knows what a work stream is.

Read this before changing when a sidebar row animates, how long any part of the
choreography takes, or before adding motion to another list.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| [`apps/desktop/src/renderer/lib/list-motion.ts`](../apps/desktop/src/renderer/lib/list-motion.ts) | The arithmetic, pure over measured positions: `planListMotion` decides which rows moved and which were displaced, `moverKeyframes` and `shifterKeyframes` say what each plays, and `LIST_MOTION` holds every duration, delay, and easing. Owns no DOM and no timer. |
| [`apps/desktop/src/renderer/lib/use-list-motion.ts`](../apps/desktop/src/renderer/lib/use-list-motion.ts) | `useListMotion(containerRef)`: measures the rows after every commit, plans against the positions it last saw, and plays the plan through the Web Animations API. Owns the interruption handling and the pointer-events guard. |
| [`apps/desktop/src/renderer/components/sidebar.tsx`](../apps/desktop/src/renderer/components/sidebar.tsx) | The one caller today. Marks each work-stream and note row with `data-motion-key`, marks every section and group heading as a held row so it travels with the column, holds the row being dragged, and attaches the hook to the scroll box. |
| [`apps/desktop/src/renderer/components/project-sidebar-section.tsx`](../apps/desktop/src/renderer/components/project-sidebar-section.tsx) | Gives each project's member list its own `data-motion-scope`, since a member is the same row the recent list shows, and marks each project row as held so a reordered project glides with its members. |

## How it works

### The contract a list makes

A row is any element under the container that carries `data-motion-key`. The
key is what makes a row *the same row* across renders: a work stream keeps its
key while it moves from the recent list to the **Pinned** section, or from the
**Yesterday** group to **Today** when it is touched, even though each of those
is a separate subtree and React unmounts one element and mounts another; that
is what lets the hook follow it. Any container under the scroll box is the same
to the hook — a section, a recency group, a project's member list — so a row
moving between two of them is one row moving. Two rows that would share a key are told apart by
`data-motion-scope` on any ancestor — a work stream listed under its project and
again in the recent list is two rows, and each moves within its own list. A
scope is also the list its rows are ranked within: two projects trading places
carry their expanded members past each other, and the members, whose order
among themselves is unchanged, shift with their project rather than leaving
the frame as if each had been moved on its own. The project row itself is a
held row for the same reason, on the row rather than the item that contains
the members, because the members animate themselves and a moving container
would carry them a second time. A row
with `data-motion-hold` is *placed* rather than moved: it is shifted into its
slot like a neighbour instead of leaving and re-entering, and it takes no part
in deciding which rows moved. The sidebar holds the row under the pointer
during a drag, and every section and group heading — a heading travels with
the rows under it, so the whole column glides rather than the rows gliding past
headings that have already jumped, and a row leaving the pinned section for the
top of the recent list passes that list's heading without the heading being the
thing seen to leave.

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

`planListMotion` sorts the rest into two kinds. Within each scope, among the
rows that are not held, the largest set that kept their relative order is found
as the longest increasing run of old ranks read in the new order; everything outside that set
is a **mover**, everything inside it that nonetheless sits at a different
position is a **shifter**, and a held row is a shifter whatever moved past it. This
is the smallest set of moves that explains the change: one message lifting a
row to the top of its group yields one mover and a shift of one slot for each
row it passed, rather than "every row above it moved".

### Playing it

Everything starts on the same frame. A mover plays one animation with three
phases, timed by `LIST_MOTION`:

1. **Exit** (0 to 160 ms, accelerating away): from its old slot — expressed as
   a vertical offset from the slot it now occupies — leftwards until it has
   cleared the container's left edge. The distance is measured per row, from
   the row's right edge to the container's left edge plus a clearance, because
   a fraction of the row's own width would leave a narrow row's edge showing
   in a wider container.
2. **Stagger** (160 to 200 ms): off frame, and now at its new slot. The jump
   between the two slots happens here, where it cannot be seen. The pause is
   what reads as "left, and came back" rather than a bounce off the edge; it is
   short because the row cannot be in two places, so this is the only part of
   the choreography that has to wait for another.
3. **Enter** (200 to 420 ms, decelerating into place): from off frame at the
   new slot back to rest.

Shifters play a straight translation from their old position to rest over
260 ms, starting on that same first frame — so the gap is closing while the
mover is still on its way out, and the mover is on its way back in while the
gap is still closing. Nothing is sequential except the stagger.

Each kind of motion takes the standard curve for what it is doing: a row
leaving the frame accelerates (`cubic-bezier(.4, 0, 1, 1)`), a row arriving
decelerates (`cubic-bezier(0, 0, .2, 1)`), and a row moving from one place on
screen to another starts and ends at rest (`cubic-bezier(.4, 0, .2, 1)`).

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

### Not a target while moving

A row that is on its way somewhere is given `pointer-events: none` until it
settles. The pointer resting where a row is about to pass would otherwise hover
it; and during a drag it would fire `dragover` against it, which the pinned list
answers by moving the dragged row *back* — the animation would then carry the
row through the pointer again, and the two would swap until the pointer moved.
The value the row had is restored when its last animation finishes or is
cancelled, and it is kept from the first animation to the last rather than per
animation, because a cancelled animation settles asynchronously, after its
replacement has already started, and must not undo it. A row interrupted and
given nothing new to play is released at once, in the same effect, rather than
whenever the cancelled animation's event arrives.

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
  depend on the row's width; the compact icon rail and the full sidebar play the
  same motion.
- **A render that did not move a row's layout does not touch that row.** The
  render that follows a move lands before the move has drawn a frame; a hook
  that re-planned every row on every render would cancel the motion before
  anyone saw it, and would have to read positions off animations that have not
  started. Anything that makes the hook cancel or restart an animation on an
  unchanged row brings that back.
- **Nothing here runs per frame.** The hook does its work once per commit and
  hands the frames to the compositor. A change that animates `top`, `height`, or
  anything but `transform` and `opacity` would move the work back to the main
  thread, and would also change the rows' layout under the pointer mid-move.

## Boundary

The module owns which rows move, how, and for how long. It exposes one hook,
the three data attributes, and `LIST_MOTION`.

It does not decide *where* rows go — the sidebar's ordering functions and
`orderPinnedWorkstreams` do that, and [`workstream-pinning.md`](workstream-pinning.md)
owns them. It does not scroll: the sidebar's own reveal, described in that same
document, still brings a pinned row into view, and the two compose because the
hook measures against the scroll box's content rather than the viewport. It
does not animate rows entering or leaving the list, deliberately — see
[Failure modes and limits](#failure-modes-and-limits). And it does not touch
the drag itself: what a drag reorders and when it commits is the pinned
section's, and this module only asks, through `data-motion-hold`, that the row
under the pointer is placed rather than made to leave and re-enter on every
step.

## Failure modes and limits

- **Rows entering or leaving are not animated.** A new row appears in place and
  the rows it displaced shift; a removed row is simply gone and the rows below
  it shift up. Animating an exit would need a stand-in kept in the DOM after
  React has removed the row, and nothing has asked for that yet. This is the
  one place the request for "moving streams" was read narrowly.
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
  about four hundred milliseconds — long enough to follow, short enough that a
  row moved by somebody else's message is not an interruption — and no
  measurement of reader behaviour informed them.

## Testing

| Suite | What it covers |
| --- | --- |
| `apps/desktop/src/renderer/lib/list-motion.test.ts` | The planner's classification — one mover, two movers together, a held row, a heading never being the mover, scopes ranked apart so a block shifts as one, a row that moved between containers, an interrupted offset — and the exact keyframes and options each kind plays. |
| `apps/desktop/src/renderer/lib/use-list-motion.test.tsx` | The hook under jsdom: the exit distance measured against the container, shifters starting on the first frame, a row followed across a remount, a held row shifted instead of moved, a render that moved nothing leaving every animation alone, interruption touching only the rows that moved and reading a pending animation's own start, the pointer-events guard surviving a late cancel and released at once on an interruption, reduced motion, and scopes keeping shared keys apart. |
| `apps/desktop/src/renderer/components/sidebar.test.tsx` (`pinned work streams`) | That the sidebar wires it: a pin moves the row's animation with it into the **Pinned** section, and a touch moves it with the row from one recency group into another. |

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

The motion itself is judged in a real window, per
[`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it): pin a
work stream from its right-click menu, then pause every animation with
`document.getAnimations()` and step `currentTime` through the phases to capture
each one.

## Changelog

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
