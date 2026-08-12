# Work-stream pinning

A pinned work stream leaves the recency-sorted sidebar and moves into a
**Pinned** section under **Automations**, where it stays until it is unpinned.
The section is arranged by hand — dragged into order, never sorted — and both the
pin and the arrangement live on the server, so the same person opening Avalon on
another machine finds their list exactly as they left it.

A pin is **one person's opinion about a shared row**. Pinning a work stream tells
nobody else anything, changes nothing about who may read it, and does not appear
on anyone else's screen. Read that alongside
[`data-model.md`](data-model.md#work-streams), where `workstreams.scope` answers
the different question of who a work stream is *for*.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/0064_workstream_pins.sql` | The `workstream_pins` table: one row per (work stream, person), carrying the manual `position`. |
| `packages/contracts/src/index.ts` | `WorkstreamSchema.pinPosition` — the per-viewer position on the wire — and `ReorderWorkstreamPinsRequestSchema`. |
| `apps/api/src/mappers/workstream.ts` | `WORKSTREAM_VIEWER_JOINS_SQL` joins the reader's pin; `workstreamViewerBindings` is the one place the viewer's id is bound for those joins. |
| `apps/api/src/services/workstream-service.ts` | `pin`, `unpin`, `reorderPins`, and the position rewrite behind them. `list` excludes pins from the recency order and attaches them to the first page. |
| `apps/api/src/routes/workstreams.ts` | `PUT /workstreams/:id/pin`, `DELETE /workstreams/:id/pin`, `PUT /workstreams/pins`. |
| `apps/desktop/src/renderer/components/sidebar.tsx` | The **Pinned** section, the right-click **Pin** / **Unpin** item, and the drag-and-keyboard reorder. `orderPinnedWorkstreams` decides what the section renders. |
| `apps/desktop/src/renderer/components/app-shell.tsx` | `applyPinnedWorkstreams` writes a pin response into the cached work-stream list. |

## How it works

### Pinning

The sidebar's right-click menu offers **Pin** on an unpinned work stream and
**Unpin** on a pinned one, named for the state the item moves to the way every
other toggle in those menus is. Pinning issues `PUT /workstreams/:id/pin`, which
requires that the caller can read the work stream and then appends a
`workstream_pins` row at the end of their list. The end rather than the top: the
list is arranged by hand, and appending is the only placement that disturbs none
of that arrangement.

Unpinning issues `DELETE /workstreams/:id/pin`, removes the row, and rewrites the
survivors so the positions stay a dense `0..n-1` run.

### Ordering

Positions are unique and ascending per person, and `unpin` and `reorderPins`
rewrite them as a dense `0..n-1` run. `pin` chooses its position inside the
insert statement, as `MAX(position) + 1`, rather than reading the list and
binding a number back in — a read-then-write hands the same position to two pins
made at once, and it also collides with a hole left by a work stream that was
deleted outright and took its pin with it by cascade. A hole is harmless and
closes on the next rewrite.

`PUT /workstreams/pins` takes the **entire arrangement**, not a move of one row:
a drag produces a complete list, and sending that list is what lets the server
write positions without inferring them from an index whose meaning depends on a
list state the client may no longer share.

The reorder is deliberately tolerant. An id the caller names that is no longer
pinned is dropped; a pin the caller does not name keeps its relative order behind
the ones it did. A second window that pinned something a moment ago therefore
loses its *position*, never its pin.

All three endpoints answer with the same shape — the caller's whole pinned list,
in order — so the client replaces what it holds rather than reasoning about which
row moved.

### In the sidebar

`orderPinnedWorkstreams` merges two orders. `pinPosition` is what the server last
confirmed and the only order that survives a reload. During a drag, the sidebar
holds a local arrangement that wins, so rows settle under the pointer rather than
after the round trip; it is discarded once the response lands, whether the
response accepted the arrangement or refused it.

A pinned work stream is removed from the recency-grouped list entirely rather
than shown in both places — which is the same thing `GET /workstreams` does, so
the two agree. `Alt`+`ArrowUp` / `Alt`+`ArrowDown` on a focused pinned row moves
it one step, and each row announces its position to a screen reader, so the
order is not reachable by pointer alone. Plain arrows are left to move focus.

Holding Command overlays `⌘1` through `⌘9` on the first nine pinned rows, and
pressing one of those physical number-row keys while Command remains down opens
the pin at that visible position. Reading the physical key keeps the mapping
true on symbol-first layouts such as AZERTY. Automations, primary actions,
recent work streams, and a tenth or later pin are not numbered. An auto-repeated
keydown is ignored so one press creates one history entry, and shortcuts pause
while a modal dialog is open rather than changing the route underneath it. The
hint is absolutely positioned over the row, with a short gradient into the
row's current normal, hover, or selected background; long copy disappears
underneath it instead of shrinking the row or touching the pill. Each numbered
link also declares its `Meta+<number>` shortcut to assistive technology when the
visual hint is hidden.

A drag is committed only when something accepted the drop. `dragend` fires
whatever ended the drag, so the handler reads `dataTransfer.dropEffect`: `none`
means Escape, or a release outside the pinned list, and the arrangement built
while the pointer passed over other rows is abandoned. The pinned list is itself
a drop target, so a release in the gap between two rows still counts as a drop.

### Following the row

Pinning and unpinning both move a row between two sections that can be a whole
screen apart, so the sidebar scrolls it back into view afterwards — otherwise the
action reads as the row vanishing from under the cursor, which is the likely case
rather than the exotic one: somebody pins a work stream *because* they were tired
of hunting for it, which means they were scrolled down when they did it.

Three details carry the behaviour. `scrollIntoView({ block: 'nearest' })` scrolls
the least it can, so a row already on screen is not moved at all, and the motion
is `smooth` unless the reader has asked for reduced motion.

The scroll waits for the *list* to carry the change rather than for the request
to resolve: the reveal records which side of the sidebar the row was moved to,
and the effect does nothing until the work stream it is holding actually reports
that `pinPosition`. The cache write reaches the component through React Query's
scheduler a tick or more after the action resolves, so a scroll on the first
render after the await lands on the row's *old* position and is left pointing at
empty space — the same failure, one render earlier.

And only the action whose response was applied arms the reveal at all.
`onPinWorkstream` answers whether its response was the one that took the list,
because the shell discards a response a later pin superseded: without that,
two pins made close together let the older completion drag the viewport back to
a row the reader has already finished with. A reveal is also dropped rather than
held when the row leaves the list entirely, and in any case expires after
`REVEAL_DEADLINE_MS`, so an intent the list never honours cannot sit armed
against a fifteen-second poll and fire whenever the state happens to match.

**Focus moves with the row, not just the viewport.** The two sections are
separate subtrees, so a row moving between them is unmounted and remounted, and
the focus Radix restores when the context menu closes has nothing left to
restore to — it lands on the body, and the next Tab restarts at the top of the
window. For somebody driving the sidebar from the keyboard, *where I was* is
focus rather than `scrollTop`, so scrolling alone follows the row for the
pointer half of the audience and abandons the half with the least other way to
find it again. The reveal therefore focuses the moved row's link with
`preventScroll: true` — but only when focus was lost, which is exactly the case
it repairs. Focus resting anywhere real belongs to whoever put it there.

## Invariants

- **A pin is per person.** Nothing about `workstream_pins` is readable by, or
  visible to, anybody but its owner. A surface that treated `pinPosition` as a
  property of the work stream would show one member's arrangement to another.
- **Positions are unique and ascending per person.** A tie makes "what order is
  this list in" ambiguous, and the sidebar's sort would then depend on
  row-arrival order. Both readers of the list —
  `loadPinnedWorkstreamIds` and `loadPinnedWorkstreamRows` — break a tie on
  `workstream_id` for the same reason: two readers that break it differently
  disagree, and the disagreement only surfaces when a rewrite silently swaps a
  pair nobody touched.
- **A rewrite covers every stored pin, not just the visible ones.** Skipping a
  pin whose work stream has gone out of sight strands it at a position the
  visible run is about to reuse.
- **`WORKSTREAM_VIEWER_JOINS_SQL` binds the viewer's id twice.** Use
  `workstreamViewerBindings`. A call site that binds one id where two are
  consumed shifts every binding after it, which SQLite reports as a type error
  somewhere unrelated rather than as the missing parameter it is.
- **A work stream is returned exactly once across `GET /workstreams`.** Pins are
  excluded from the paged query and appended to the first page instead. Leaving
  them in both would return a quiet pin twice — once appended, once on whichever
  cursor page its `last_activity_at` falls in. Pins are the only rows that leave
  the order: a system work stream is paged like any other when `includeSystem`
  asks for it, and is appended only when it is also pinned.
- **The sidebar pages.** It requests one page and follows `nextCursor` when the
  scroll approaches the bottom, so a rule that only holds on the first page no
  longer holds where anybody looks. Any future merge into the first page has to
  keep the row out of the cursor pages, not merely out of the first one.
- **Nothing counts pins against a limit.** Two limits were tried and both broke
  on the same rock — a pin whose work stream has gone out of sight renders
  nothing and offers no menu, so it cannot be counted, and once it is not
  counted the list can outgrow any bound the reorder request enforces. Anything
  that reintroduces a count has to answer both.
- **Pinning is gated on readability; unpinning is not.** Removing a pin is never
  a question about the work stream, and a pin that has gone dark can only be
  reached by a caller that already knows the id.

## Boundary

This module owns `workstream_pins`, the three pin endpoints, `pinPosition` on the
work-stream contract, and the Pinned section of the sidebar. The macOS menu bar
item renders a second, read-only view of the same arrangement — its top five —
and [`menu-bar.md`](menu-bar.md) owns that; it reads `pinPosition` and changes
nothing. It owns no part of
what a work stream *is*, who may read it, or how the recent list is sorted.

It deliberately does not:

- **Broadcast anything.** A pin changes nothing another person can see, so no
  socket event is sent and the work-stream room knows nothing about it. The same
  person's other windows converge on the sidebar's 15-second poll.
- **Decide visibility.** `apps/api/src/lib/workstream-visibility.ts` remains the
  single answer to "may this person read this work stream", and every pin read
  applies it — see [`data-model.md`](data-model.md#work-streams).
- **Pin anything but a work stream.** Automations and notes have their own
  sections and no pin.

## Failure modes and limits

- **No limit on how many a person may pin**, and none on how many ids one
  arrangement may name. The section is as long as its owner made it. Two things
  scale with that length, and are what a future bound would have to be argued
  against rather than assumed: a reorder writes one `UPDATE` per pin in a single
  `batch`, and the first page of `GET /workstreams` carries one extra row per
  pin.
- **A refused drag reverts.** The local arrangement is dropped and the section
  re-renders from what the server holds, which is what the person's other
  devices are showing. The dialog says so rather than leaving a list that
  silently disagrees with the server.
- **A pin whose work stream is gone contributes nothing.** Archived or no longer
  readable, it is filtered out of every read; the row survives, so a work stream
  reopened to the workspace comes back in its old place.
- **A drag that ends where it started, or that was cancelled, sends nothing.**
  Rewriting every position for a drag that went nowhere is a write with no change
  behind it, and committing one that was backed out of would make Escape the
  slowest way to reorder rather than the way to stop.
- **Overlapping moves keep the newer arrangement.** Two `Alt`+arrow moves in
  quick succession overlap; the local order is cleared only if it is still the
  one that call set, so the first response cannot snap the list back to an order
  the reader has already moved past.
- **Only the first nine pins have Command shortcuts.** Numbering begins at one
  and never wraps to zero; a tenth or later pin remains reachable by the list,
  search, and ordinary navigation but has no numbered shortcut.

## Testing

| Suite | What it covers |
| --- | --- |
| `apps/api/test/workstream-pinning.test.ts` | Append-on-pin, per-person isolation, dense rewrite on unpin, tolerant reorder, the first-page backfill, and that an unreadable work stream cannot be pinned but a stale pin can be removed. |
| `apps/desktop/src/renderer/components/sidebar.test.tsx` (`pinned work streams`) | The section appearing only when something is pinned, rows leaving the recent list, stored order beating activity order, held-Command hints and number navigation for only the first nine pins, the menu toggle, live reorder during a drag, the keyboard move, and both error dialogs. |
| `apps/desktop/src/renderer/components/app-shell.test.tsx` (`applyPinnedWorkstreams`) | That a pin response rewrites every row's position, including the ones it does not name. |

Two traps in the desktop tests. jsdom implements no `DataTransfer`, so a drag
event needs the small stub in that file rather than `new DataTransfer()`. And an
open error dialog hides the sidebar from the accessibility tree, so the pinned
order can only be read back after the dialog is dismissed.

The API suite runs the checked-in migrations against `node:sqlite` in memory and
supplies its own `D1Database` shim; that shim needs a `batch` that runs its
statements, because the position rewrite uses one.

## Data model

`workstream_pins` is keyed `(workstream_id, user_id)` and carries
`workspace_id`, `position`, `created_at`, and `updated_at`, with
`workstream_pins_user_idx` on `(workspace_id, user_id, position)`. It is
deliberately **not** uniquely indexed on `(user_id, position)`: a reorder
rewrites every row of the run, and any intermediate state of that rewrite
collides with itself. Positions are therefore kept unique by how they are
allocated — `MAX(position) + 1` inside the insert — rather than by the schema.

## Changelog

### 2026-08-12 — Command reveals the first nine pins as direct destinations

**What changed:** Holding Command overlays `⌘1` through `⌘9` on the first nine
rows of the Pinned section. Pressing the corresponding number while Command is
held opens that work stream; the links expose the same mapping through
`aria-keyshortcuts` even while the visual hints are absent.

**Why:** Pinning already turns the sidebar into the reader's deliberately
ordered short list, but reaching an item still required moving to and clicking
the sidebar. The requested held-modifier treatment makes that existing order
temporarily legible as a set of keyboard destinations without adding permanent
visual weight to every row.

**Considered and rejected:** Numbering the primary commands and Automations
before Pinned, and using `0` for a tenth destination. Both would make the pin
numbers depend on unrelated sections and contradict the requested one-through-
nine mapping. Permanently reserving space for the pills was also rejected: the
hints are transient, and shortening every title when they are absent would make
the ordinary sidebar pay for a state it is not showing.

**Consequences:** Reordering pins reassigns shortcuts immediately because the
mapping follows rendered order. Pins after the ninth stay unnumbered. The pills
overlay row content behind a gradient matched to the row's normal, hover, or
selected background, so future row backgrounds must keep that gradient in step.
The handler follows physical `Digit1`–`Digit9` codes, ignores repeated keydowns,
and yields whenever a modal dialog owns interaction.

### 2026-08-12 — The sidebar follows the cursor it was throwing away

**What changed:** `getWorkstreams` returns `nextCursor` instead of discarding it,
and `useWorkstreamsQuery` walks pages: the sidebar asks for the next one as the
scroll comes within 400px of the bottom, and appends it. The ordinary list also
gained a partial recency index, since it now steps over a population that grows
on its own.

**Why:** The list was one request for 250 rows, and everything past that was
simply not in the product — `nextCursor` was parsed and dropped. That was
survivable while the only thing producing work streams was people making them.
Digests now create one per occurrence and nothing reaps them, so a Debug-enabled
account accumulates rows at a rate nobody chose, and the 250th row stopped being
a theoretical boundary.

**Considered and rejected:** `useInfiniteQuery`, which is the obvious tool and
the wrong one here. It stores `{ pages, pageParams }` under its key, and eight
call sites in the realtime socket handlers and the app shell patch this cache
entry as a flat `WorkstreamSummary[]` — a rename, an unread count, a scope
change, a pin reorder. Adopting the paged shape would strand every one of them
silently: the write lands on a value nobody reads and the sidebar sits stale
until the next poll. The flat array is the contract those writers were built
against, so paging lives in the fetcher and the stored value keeps its shape.

Also rejected: shrinking the page. A smaller first page would exercise the new
path constantly and cost every ordinary workspace a second request for a list
that already fitted in one.

**Consequences:** Two rules now hold that a hand-rolled pager does not get for
free, and both are covered by tests. A refetch — the poll runs every fifteen
seconds — walks *every page already on screen*, or the list would truncate under
somebody who had scrolled; `pagesLoaded` is that count. And a failed page leaves
its cursor in place, so the next scroll retries it rather than ending the list
quietly. Toggling Debug enabled resets to one page, because the rows are a
different population. `nextCursor` continues to come from the paged rows alone,
which is what keeps both appends out of the cursor pages.

### 2026-08-11 — Following the row means focus too, and the intent to follow expires

**What changed:** The reveal added below now also moves focus to the row it
scrolled to, when focus was lost by the move. Only the pin whose response was
applied arms it, and any reveal the list does not honour within
`REVEAL_DEADLINE_MS` is dropped.

**Why:** Three things the scroll on its own got wrong, all found in review.

Focus was the substantive one. A row moving between the two sections is
unmounted and remounted, so Radix's focus restore on menu close has nothing left
to restore to and focus falls to the body — confirmed by probe: an action that
leaves the row in place ends with focus on the row's link, and **Pin** ends with
focus on `document.body`. Scrolling repairs "the row vanished" for people who
can see where it went, and leaves it exactly as broken for the people who
cannot. That is the wrong half to fix.

The other two are the same defect at two removes. The reveal armed on any pin
that resolved, including one whose response the shell had already discarded as
superseded, so overlapping pins could drag the viewport back to a row the reader
had finished with. And because the reveal only cleared once the list agreed, an
intent that was never honoured stayed armed against a fifteen-second poll and
fired whenever the state eventually matched — scrolling, now also moving focus,
under somebody a minute past caring.

**Considered and rejected:** Detecting whether the reader is on the keyboard
before moving focus. Radix restores focus to the trigger whichever way the menu
was opened, so both pointer and keyboard end on the body and the modality is not
observable at the point it would be needed. Restoring only when focus was
*lost* is the same guarantee without the guess, and it cannot take focus from a
composer or a dialog because those are not the body.

**Consequences:** The deadline makes following a row a promise with a limit
rather than a standing intent — anything that arms a reveal has to expect it to
expire, and lengthening the wait re-opens the poll problem. The focus move is
conditional on `document.activeElement`, so a future path that arms a reveal
while focus sits somewhere real will scroll without moving focus, which is
deliberate.

### 2026-08-11 — Pinning scrolls the row it moved back into view

**What changed:** After a pin or an unpin, the sidebar scrolls the row into view
in its new section. `block: 'nearest'` means a row already on screen is not
moved; the scroll waits for the work-stream list to report the new
`pinPosition` rather than firing when the request resolves.

**Why:** The row was simply disappearing. Pinning moves it from the recency list
to a section above, and the scroll position did not follow — so a pin made from
anywhere below the fold looked like the row had been deleted. That is the
ordinary case rather than the edge one, because being tired of hunting for
something down the list is the reason to pin it. The same is true in reverse for
unpinning, which drops the row into whatever date group its `lastActivityAt`
puts it in, potentially far below.

This was not caught when the feature shipped because the seeded workspace holds
two work streams, so the sidebar never scrolled in any of the manual passes. The
gap was in the fixture, not just the feature.

**Considered and rejected:** Scrolling on the render immediately after the
request resolved — the obvious implementation, and it is wrong. React Query
delivers the cache write through its own scheduler, a tick or more later, so
that render still has the row in the section it is leaving: the scroll lands on
the old position and is left pointing at empty space once the real update
arrives. It was measured doing exactly that in a real window before the fix, and
an instant `behavior` did not help, which ruled out the animation as the cause.

**Consequences:** The reveal is keyed to a `{ id, pinned }` pair rather than an
id, because "has the list caught up yet" is only answerable against the state
the action asked for. Any future path that moves a row between these sections —
a bulk pin, an unpin triggered by archiving — has to set that pair or the row
will move without being followed. Rows carry `data-workstream-id` so the sidebar
can find one after re-rendering; it is a hook for this, not a test seam.

`onPinWorkstream` now returns whether its response was applied rather than
`void`, which makes "did this action actually change anything" a question the
sidebar can ask. Anything else that arms the reveal has to answer it too:
scrolling on a superseded response points the viewport at work the reader has
moved past.

### 2026-08-11 — There is no limit on how many work streams a person may pin

**What changed:** `MAX_PINNED_WORKSTREAMS` is gone, along with the
`pin_limit_reached` refusal and the bound on `ReorderWorkstreamPinsRequestSchema`.
Nothing counts pins, and an arrangement may name as many ids as the person has
pinned. This reverses the third bullet of the entry below, which had just moved
that cap onto a visibility-filtered count.

**Why:** The cap could not be made to work in either of its two possible forms,
and both failures were the cap's, not the list's.

Counting *stored* rows meant a pin whose work stream had been archived or made
private without its owner spent a slot forever: the row renders nothing and
offers no menu, so nobody could free it. That was found in the first review round
and fixed by counting only *visible* pins — which promptly created the opposite
failure, found in the second round by two independent reviewers. A dark pin that
comes back makes the visible list longer than the cap the reorder request
enforces, and because an arrangement is all-or-nothing, that request is refused
rather than truncated. The list becomes permanently unreorderable until its owner
unpins something. A limit that only holds while nothing goes out of sight is not
a limit, it is a trap.

**Considered and rejected:**

- **A hard cap that evicts the oldest dark pin** when a new pin is made at the
  ceiling. It restores a single clean invariant — stored equals visible, both
  bounded — but pays for it by silently deleting something its owner chose,
  reachable again the moment the work stream reappeared.
- **A larger bound on the reorder request** than on pinning, sized as a request
  guard rather than the product limit. This just moves the cliff: the stored set
  still grows without bound as pins go dark, so the same "unreorderable list"
  failure waits at the larger number.
- **A `BEFORE INSERT` trigger**, which is how this schema states its other
  invariants and would close the read-then-write race in the cap. Wrong tool for
  this one: the count that mattered was of *visible* pins, so the trigger would
  have to restate `workstream-visibility.ts` in SQL inside a migration that is
  immutable once deployed — and the one time that rule was duplicated by hand,
  the copy lost `scope`.

**Consequences:** Two things now scale with the length of somebody's pinned list
and are the argument any future bound has to beat: a reorder writes one `UPDATE`
per pin in one `batch`, and the first page of `GET /workstreams` carries one
extra row per pin. Neither is bounded by anything but the person's own patience.
The `includeSystem` question the cap raised — that `loadPinnedWorkstreams`
defaults to `true` while the sidebar reads its list with the viewer's debug
preference — disappears with the count that asked it; the reads that render still
take the caller's value.

### 2026-08-11 — Pins leave the recency order, and a position is allocated in SQL

**What changed:** Four corrections to the design in the entry below, all found in
review before it shipped.

- A pinned work stream is now excluded from the paged `GET /workstreams` query
  rather than merely appended to the first page. It was being returned twice —
  once appended, once on whichever cursor page its `last_activity_at` fell in.
- `pin` allocates its position as `MAX(position) + 1` inside the insert instead
  of binding the row count read a moment earlier. The count is wrong whenever
  the run has a hole in it, which a work stream deleted outright produces by
  cascade, and two pins made at once both read the same number.
- `MAX_PINNED_WORKSTREAMS` counts pins the reader can actually see. A pin whose
  work stream is archived or no longer visible renders nothing and offers no
  menu, so counting it spent a slot with no way to free it; fifty of them wedged
  pinning shut behind an empty section.
- A cancelled drag no longer commits. `dragend` fires on Escape and on a release
  outside the list, and the rows have already moved by then, so the handler now
  reads `dropEffect` and abandons the arrangement when nothing accepted it. The
  pinned list became a drop target of its own so a release in a gap between rows
  still counts as a drop, and an in-flight reorder no longer clears a local order
  a later move has replaced.

**Why:** Each was a case where the first design read correctly and behaved
differently. The paging one is the instructive one: the rule "a pin appended to
page one is older than that page's last row" is true, and it is exactly why the
row reappears further down the same walk — being older is what puts it on a later
cursor page. Appending to one page cannot be the whole answer to "this row is not
sorted by activity"; taking it out of the activity order is.

**Considered and rejected:** Deduplicating on the client instead of fixing the
pagination. The desktop reads only the first page, so nothing visible was broken
— which is the argument for leaving an API that returns the same row twice, and
it is worth nothing to the next caller that pages properly.

**Consequences:** A cursor page never contains a pinned work stream, so a caller
walking the whole list gets pins on the first page and the recency order
everywhere else. Positions are unique and ascending rather than strictly dense:
a hole is now possible between rewrites and must stay harmless. The pin cap is
enforced against a visibility-filtered read, so the stored row count may exceed
`MAX_PINNED_WORKSTREAMS`, and the check remains a read-then-write that two
simultaneous pins can both pass.

### 2026-08-11 — Work streams can be pinned, and the pinned list is arranged by hand

**What changed:** A new `workstream_pins` table, three endpoints under
`/workstreams`, a `pinPosition` field on the work-stream contract, and a
**Pinned** section in the sidebar with drag-and-drop and keyboard reordering.

**Why:** The sidebar sorted work streams by activity and nothing else, so the
handful of things somebody is actually carrying across a week were pushed down
by whatever ran most recently — including automation output they were not
reading. Sorting cannot express "this one matters to me", because it is a
different question from "this one moved".

Server-side rather than device-local because a person uses Avalon on more than
one machine and a pinned list that disagrees between them is worse than no
pinned list: it teaches them not to trust the section.

**Considered and rejected:**

- **A `pinned` column on `workstreams`.** One column, no join — and one person's
  arrangement imposed on everybody in the workspace. A pin is an opinion about a
  shared row, which is exactly the shape `workstream_read_states` already has,
  so it is keyed the same way.
- **Sparse or fractional positions**, so a move writes one row instead of the
  run. The lists are bounded at 50 by a product limit, so the rewrite is small,
  and a dense run is the only representation in which "what order is this list
  in" has one answer. Fractional indices also drift toward precision loss under
  repeated moves at the same spot, which is a rare bug that is very hard to see.
- **A move endpoint** taking one id and a target index. The index only means
  something relative to a list the client painted moments ago, so a concurrent
  pin from another window silently lands the row in the wrong place. Sending the
  whole arrangement makes the client's intent unambiguous.
- **Sorting the pinned section by activity anyway**, with pinning as a filter.
  That is a second recent list, and it loses the thing manual order buys: rows
  that stay where they were put.

**Consequences:**

- `WORKSTREAM_VIEWER_JOINS_SQL` now binds the viewer's id **twice**. Every
  existing call site was updated to `workstreamViewerBindings`; a new one that
  binds a single id will fail somewhere that does not name the cause.
- `GET /workstreams` no longer returns strictly the top `limit` rows by activity
  on its first page — it appends the viewer's visible pins. `nextCursor` is
  derived from the paged rows, not from the last item returned, so a future
  change to the merge must keep those two separate.
- Nothing is broadcast on a pin. If pins ever need to converge faster than the
  sidebar poll, that is a socket event to the *user*, not to the work-stream
  room, which is a channel Avalon does not have yet.
- `MAX_PINNED_WORKSTREAMS` is a contract constant and bounds the reorder
  request. Raising it raises the size of the rewrite batch with it.
