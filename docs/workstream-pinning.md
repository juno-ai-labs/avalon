# Work-stream pinning

A pinned work stream leaves the list sorted by last access and moves into a
**Pinned** section under **Automations**, where it stays until it is unpinned.
The section is arranged by hand — dragged into order, never sorted — and both the
pin and the arrangement live on the server, so the same person opening Rally on
another machine finds their list exactly as they left it.

A pin is **one person's opinion about a shared row**. Pinning a work stream tells
nobody else anything, changes nothing about who may read it, and does not appear
on anyone else's screen. Read that alongside
[`data-model.md`](data-model.md#work-streams), where `workstreams.scope` answers
the different question of who a work stream is *for*.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/0064_workstream_pins.sql`, `0090_drop_legacy_product_tables.sql` | Historical D1 pin source through 0089, then its final removal after import. |
| `packages/contracts/src/index.ts` | `WorkstreamSchema.pinPosition` — the per-viewer position on the wire — and `ReorderWorkstreamPinsRequestSchema`. |
| `apps/api/src/durable-objects/workspace-do.ts` | Authoritative `workspace_workstream_pins`, transactional position rewrites, readability checks, directory waterline, and socket invalidation. |
| `apps/api/src/services/workstream-directory-service.ts` | Typed Worker-to-WorkspaceDO pin/unpin/reorder adapter used by the existing HTTP command routes. |
| `apps/api/src/routes/workstreams.ts` | `PUT /workstreams/:id/pin`, `DELETE /workstreams/:id/pin`, `PUT /workstreams/pins`. |
| `apps/desktop/src/renderer/components/sidebar.tsx` | The **Pinned** section, the right-click **Pin** / **Unpin** item, and the drag-and-keyboard reorder. `orderPinnedWorkstreams` decides what the section renders. |
| `apps/desktop/src/renderer/lib/workstreams-cache.ts` | The flat-array cache key and the only typed write boundary for it. |
| `apps/desktop/src/renderer/components/app-shell.tsx` | `applyPinnedWorkstreams` derives the new pin positions before handing the list update to the cache boundary. |
| `apps/desktop/src/renderer/screens/workstream-landing.tsx` | The root route: resolves to the first pin, else the most recent row, else the composer. |
| `apps/desktop/src/renderer/lib/workstream-landing.ts` | Shared landing selection and `useOpenFirstWorkstream`, the one way a screen leaves for that route, and the `skipWorkstreamIds` state it carries. |

## How it works

### Pinning

The sidebar's right-click menu offers **Pin** on an unpinned work stream and
**Unpin** on a pinned one, named for the state the item moves to the way every
other toggle in those menus is. Pinning issues `PUT /workstreams/:id/pin`; the
Worker invokes the workspace's typed RPC, which requires that the caller can
read the authoritative directory row and then appends a
`workspace_workstream_pins` row at the end of their list. The end rather than the top: the
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

### Recent work streams

Unpinned work streams sort by **this viewer's last access**, newest first.
WorkspaceDO stores integer millisecond timestamps in `workspace_workstream_access`,
keyed by user and work stream. A validated foreground-presence transition records
an access; background socket prewarming and shared activity do not. An unvisited
row uses its creation time until the first visit. The timestamp travels as
`lastAccessedAt`, independently of shared activity and read markers.

The directory page and cursor use the same timestamp, with work-stream ID as the
tie-breaker. Foreground visits push one `workspace_workstream_recency` row only to
that user's subscribed sessions. Reconnect reconstructs the order from SQL.
Desktop applies access and pin fields under the directory waterline, separately
from the child-owned common and viewer waterlines, so delayed activity snapshots
cannot erase a visit. Child REST responses omit access metadata; the API mapper
preserves that omission so ordinary response merges cannot erase a newer visit.
An absent access field means an older server and retains activity ordering and
legacy bulk requests; explicit null means an unvisited row on a supporting server.
A cursor whose timestamp no longer matches its row restarts at page one, covering
old activity cursors during upgrade and visits made during a paged walk. Project-contained work streams use the same access order.

The recency headings use access time too. Their bulk commands select
`recency: "access"`; existing activity-based API callers retain their original
meaning. Notes retain activity-based grouping, and automations keep their own
section ordering. Pins remain manually ordered.

### Leaving for the first work stream

The root route resolves to the same row the sidebar shows at the top — the
first pin, else the most recent by the viewer's access — and it is where every
screen goes when what it was showing is no longer there to show: an archived
work stream, note, or project, a deleted automation or archived draft, a work
stream the reader left, one they marked unread, the not-found screen's way out,
the end of onboarding, and the main window's hand-off to the Sidekicks window.
Only a workspace with nothing in it lands on the composer. The composer is
otherwise reached by an explicit New action alone: the sidebar's New buttons,
a project's plus, and the `workstreams/new` and `automations/new` deep links,
which are create intents even though the second no longer has a builder to open.
The macOS status menu no longer offers one — see [`menu-bar.md`](menu-bar.md).

`useOpenFirstWorkstream` is the one way a screen leaves. It always replaces the
history entry, so Back cannot return to a screen the API refuses, and it names
the rows the landing must pass over for that one landing. No leaving screen
patches the directory: the WorkstreamDO tombstone the socket delivers is what
removes an archived row, under the directory waterline that orders the removal
against everything else in flight for it. What a leaving screen does do is
evict the archived or left work stream's own cache entries, and that eviction
also drops its row from the list the landing reads. So the skip is doing three
different jobs. For a single archive or a left personal stream it is a belt
over that eviction, covering the frame in which a directory page re-delivers
the row ahead of the tombstone, where it would be the most recent one. For a
batch archive it is load-bearing: only the open row is evicted, the others the
batch took stay until their tombstones arrive, and the landing would open the
next most recent of them. And a row marked unread stays in the list for good
and is skipped because opening it is what reads it.

The batch's skip list is a reconstruction, `batchArchiveSkipIds`, run over the
cached rows against the filter the server also evaluated. The response says how
many went and never which, so a row whose recency crossed the filter's edge
between the client's snapshot and the server's evaluation lands on the wrong
side. The two errors are not symmetric: skipping a row that survived costs a
landing on an older row or a page fetch, while opening a row that went costs
an error screen. The reconstruction is therefore allowed to be wide, and it
applies to one landing only, so a live row it wrongly names is passed over
once rather than for the session.

**Landing opens a work stream, and opening it reads it.** That is true of the
row the landing chooses after an archive, which is what a mail client does, and
it is true after mark-as-unread too: leaving the row for later spends the
unread state of the row landed on instead. That is a deliberate choice and not
an oversight. The alternative of staying put would re-read the row that was
just marked, which is the one outcome the action exists to prevent, and the
composer this used to fall back to was inert only by being nowhere. A reader
who wants neither can mark the next row unread in turn.

A skip list that empties every loaded page is not an empty workspace: a batch
can take the whole first page — the day's work streams, say — while older ones
sit beyond the cursor. The landing then asks the directory query for its next
page and keeps its opening state until a candidate arrives or the pages run
out. It requests a page once per change to the list rather than once per
settled fetch, because `fetchMore` leaves its cursor in place after a failed
page; re-requesting on settle would retry that page forever. A failed page
therefore waits, and the socket's own delivery of the archive's tombstones is
what changes the list and asks again. If the socket is what is down, nothing
changes the list and the landing keeps its opening state; the sidebar is
rendered around it and stays usable, which is the way out.

Telemetry still names `/workstreams/new` the `workspace_home` surface. The
name dates from when the composer was the home; after this change it is the
New action, and a funnel keyed on that surface reads the leaves above as
`workstream` views instead. The mapping is left alone rather than migrated,
but the reading changes meaning at this change.

The one deliberate exception is the inert composer route a cross-workspace deep
link parks on while its resource action resolves. Landing there would open and
record a visit to an unrelated room in the new workspace a moment before the
link's own destination arrives.

### In the sidebar

`orderPinnedWorkstreams` merges two orders. `pinPosition` is what the server last
confirmed and the only order that survives a reload. During a drag, the sidebar
holds a local arrangement that wins, so rows settle under the pointer rather than
after the round trip; it is discarded once the response lands, whether the
response accepted the arrangement or refused it. The slot the pointer is over is
the one laid out there, resolved with `layoutRowAt` from
[`list-motion.md`](list-motion.md), not the row drawn there — mid-motion the
row drawn under the pointer is one gliding out of the slot the dragged row just
took, and reordering against it would send it straight back.

A pinned work stream is removed from the recency-grouped list entirely rather
than shown in both places — which is the same thing the WorkspaceDO page does,
so the two agree. `Alt`+`ArrowUp` / `Alt`+`ArrowDown` on a focused pinned row moves
it one step, and each row announces its position to a screen reader, so the
order is not reachable by pointer alone. Plain arrows are left to move focus.

In Electron, every pinned row also keeps its WorkstreamDO control socket and
substream `0` feed socket proactively connected. It joins the active work
stream, the five most recently active unpinned rows, and any running work stream
in the socket pool; pin order does not sequence their handshakes. WorkspaceDO
supplements the first 250-row recent page with every visible running row, so an
older active run is not omitted from that pool by pagination.

Command-number navigation and its hint overlay are retired. Pinning, pointer
reordering, and Alt+Arrow keyboard reordering remain unchanged. Historical
shortcut telemetry schemas remain for older clients; this client emits neither
shortcut-discovery nor shortcut-use events.

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
against a later socket invalidation and fire whenever the state happens to match.

**The row travels rather than reappears.** Whichever section it moves to, the
row slides out of its old slot to the left, the rows between close the gap, and
it slides in from the left at its new slot — the same motion a message lifting
a row to the top of its group plays, and the one a drag or an `Alt`+`Arrow`
move in the pinned list plays, with the row under the pointer placed rather
than made to leave on every step. [`list-motion.md`](list-motion.md) owns that
motion; the sidebar only marks its rows and holds the dragged one. The reveal
and the motion compose: the scroll follows the row to its new section, and the
row is on its way in as the viewport arrives. The reveal is a layout effect
declared before the motion's hook, and has to stay one: `scrollIntoView`
scrolls to the box as transformed, and the motion's first frame puts the row
back where it came from, so a scroll made after it finds nothing to scroll to.

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

- **A pin is per person.** Nothing about `workspace_workstream_pins` is readable by, or
  visible to, anybody but its owner. A surface that treated `pinPosition` as a
  property of the work stream would show one member's arrangement to another.
- **Positions are ascending per person and rewritten densely.** A tie makes "what order is
  this list in" ambiguous, and the sidebar's sort would then depend on
  row-arrival order. WorkspaceDO's list and pinned-return queries break a tie on
  `workstream_id` for the same reason: two readers that break it differently
  disagree, and the disagreement only surfaces when a rewrite silently swaps a
  pair nobody touched.
- **A rewrite covers every stored pin, not just the visible ones.** Skipping a
  pin whose work stream has gone out of sight strands it at a position the
  visible run is about to reuse.
- **A work stream is returned exactly once across a WorkspaceDO directory walk.** Pins are
  excluded from the paged query and appended to the first page instead. Leaving
  them in both would return a quiet pin twice — once appended, once on whichever
  cursor page its access-or-creation timestamp falls in. Pins are the only rows that leave
  the order: a system work stream is paged like any other when `includeSystem`
  asks for it, and is appended only when it is also pinned.
- **The sidebar pages.** It requests one page and follows `nextCursor` when the
  scroll approaches the bottom, so a rule that only holds on the first page no
  longer holds where anybody looks. Any future merge into the first page has to
  keep the row out of the cursor pages, not merely out of the first one.
- **The cursor contains recency and work-stream ID.** Timestamps tie; using only
  the access-or-creation timestamp can skip a row when the next page starts below a tie. The
  cursor is opaque to Electron and must be returned unchanged.
- **At most 1,000 pins belong to one person.** The WorkspaceDO transaction counts
  every stored pin, including one currently hidden by visibility, before
  accepting a new one. That bounds the pin-derived reorder and response work;
  the independently complete live-state supplement may make the combined first
  page larger.
- **Pinning is gated on readability; unpinning is not.** Removing a pin is never
  a question about the work stream, and a pin that has gone dark can only be
  reached by a caller that already knows the id.
- **`useOpenFirstWorkstream` is the one way a screen leaves for the root
  route, and every leave replaces.** A screen that navigates to `/` or sets
  the hash itself pushes an entry the API will refuse on Back, and cannot name
  the rows the landing must pass over.
- **No leaving screen patches the directory.** It may evict the work stream it
  is leaving; which rows the list holds is the socket's, under the directory
  waterline. A landing that needs a row gone tells the landing, it does not
  remove the row.
- **The composer is a create action.** It is reached by an explicit New
  action or by an empty workspace, never as the place a screen falls back to.

## Boundary

This module owns `WorkspaceDO.workspace_workstream_pins`, the three pin endpoints, `pinPosition` on the
work-stream contract, `workspace_workstream_access`/`lastAccessedAt`, and the
Pinned and recent work-stream sections of the sidebar. The macOS menu bar
item renders a second, read-only view of the same arrangement — its top five,
above its own recent list — and [`menu-bar.md`](menu-bar.md) owns that; it reads
`pinPosition` and `lastAccessedAt` and changes neither. The recency grouping the
two surfaces share lives in `apps/desktop/src/common/recency-groups.ts` so the
sidebar's headings and the menu's cannot disagree. It owns no part of
what a work stream *is* or who may read it.

It deliberately does not:

- **Broadcast to other users or a WorkstreamDO.** A pin changes nothing another
  person can see. WorkspaceDO does publish `workstream_directory` on its own
  socket so the same person's other windows converge without polling.
- **Decide workspace membership.** D1 remains current membership authority;
  WorkspaceDO applies its local common/viewer directory to decide whether that
  active member may pin the work stream — see [`data-model.md`](data-model.md#work-streams).
- **Pin anything but a work stream.** Automations and notes have their own
  sections and no pin.

## Failure modes and limits

- **A person may pin at most 1,000 work streams.** The same bound applies to a
  reorder request. The first WorkspaceDO page may contain all pins, at most 250
  recent unpinned rows, and every visible live-state row; that combined response
  intentionally has no separate guessed row cap. Pinning the 1,001st row fails
  with `workstream_pin_limit_reached`; existing pins remain unchanged.
- **A refused drag reverts.** The local arrangement is dropped and the section
  re-renders from what the server holds, which is what the person's other
  devices are showing. The dialog says so rather than leaving a list that
  silently disagrees with the server.
- **A pin whose work stream is gone contributes nothing.** Archived or no longer
  readable, it is filtered out of every read; the row survives, so a work stream
  reopened to the workspace comes back in its old place. An archived one does not
  come back: archiving is one-way from the client, so its pin keeps a stored row
  — and a slot against the per-person cap — with no visible row to unpin. That
  became reachable when the sidebar's **Archive work stream** action was wired
  up; before it, nothing a person could click reached this state.
- **A drag that ends where it started, or that was cancelled, sends nothing.**
  Rewriting every position for a drag that went nowhere is a write with no change
  behind it, and committing one that was backed out of would make Escape the
  slowest way to reorder rather than the way to stop.
- **Overlapping moves keep the newer arrangement.** Two `Alt`+arrow moves in
  quick succession overlap; the local order is cleared only if it is still the
  one that call set, so the first response cannot snap the list back to an order
  the reader has already moved past.

## Testing

| Suite | What it covers |
| --- | --- |
| `apps/api/test-workers/durable-object-runtime.test.ts` | Real SQLite-backed WorkspaceDO append/idempotency, per-person isolation, dense unpin, tolerant reorder, pinned-first listing, and hibernating page delivery. |
| `apps/desktop/src/renderer/components/sidebar.test.tsx` (`pinned work streams`) | The section appearing only when something is pinned, rows leaving the recent list, stored order beating activity order, absence of retired Command-number hints and navigation, the menu toggle, live reorder during a drag, the keyboard move, both error dialogs, and the row's motion following it into the section and between recency groups. |
| `apps/desktop/src/renderer/components/app-shell.test.tsx` (`applyPinnedWorkstreams`) | That a pin response rewrites every row's position, including the ones it does not name. |
| `apps/desktop/src/renderer/screens/workstream-landing.test.tsx` | Pin-then-recency resolution, the pending, empty, and failed states, and that named rows are passed over whatever their rank. |
| `apps/desktop/src/renderer/lib/workstream-landing.test.tsx` | That leaving replaces the entry and carries the skip list, and that a malformed state reads as no skip. |

Two traps in the desktop tests. jsdom implements no `DataTransfer`, so a drag
event needs the small stub in that file rather than `new DataTransfer()`. And an
open error dialog hides the sidebar from the accessibility tree, so the pinned
order can only be read back after the dialog is dismissed. The keyboard reorder
callback also fires before `commitPinnedOrder` clears its optimistic order in a
`finally`; a test that clears its spy and sends another key immediately after
observing the callback races that cleanup. Wait for the rendered order that the
next assertion is meant to act on.

The legacy API suite runs the checked-in D1 migrations against `node:sqlite` in
memory. Post-cutover ownership assertions belong in the workerd suite; do not
replace its real Durable Object SQL transaction with a D1 shim.

## Data model

`WorkspaceDO.workspace_workstream_pins` is keyed `(user_id, workstream_id)`,
references `workspace_workstream_directory(workstream_id)` with cascade, and
carries `position`, `created_at`, and `updated_at`. Its order index is
`(user_id, position, workstream_id)`. It is deliberately **not** uniquely
indexed on `(user_id, position)`: a reorder
rewrites every row of the run, and any intermediate state of that rewrite
collides with itself. Positions are therefore kept unique by how they are
allocated — `MAX(position) + 1` inside the insert — rather than by the schema.

## Changelog

### 2026-09-09 — Warm the root landing before workspace details finish

Startup and the root route now share the pin-then-viewer-recency selection.
The existing connection pool starts from the workspace directory while profile
loading continues, and includes the chosen landing even when its activity falls
outside the five recent background rows. This removes serial connection setup
without changing navigation order, skip lists, empty-directory handling, or
explicit New/deep-link routes. Warming still does not count as viewing.


### 2026-09-09 — Every leaving screen opens the first work stream

Archiving the open work stream, a batch archive that took it, marking it
unread, leaving it, archiving the open note or project, deleting the open
automation, finishing onboarding, the not-found screen, and the Sidekicks
hand-off all landed on the new-work-stream composer. That made the composer
the app's fallback home rather than a create action, and archiving the room
someone was reading answered with an empty draft instead of the next room. Each
now leaves through `useOpenFirstWorkstream` for the root route, which already
resolved the top sidebar row on startup; the composer is reached only by an
explicit New action or an empty workspace.

The landing gained a `skipWorkstreamIds` state for the same reason the archive
handler never patched the list: the tombstone or refetch that removes the row
lands after the screen has to leave, and the row that was open is the most
recent one. Patching the cache instead was rejected because the directory
waterline is what orders that removal against everything else in flight for
the row. Every leave now replaces rather than pushes — the note archive and
mark-unread paths used to push — since Back returning to a refused note, or
reopening and thereby reading a work stream just marked unread, was the wrong
half of that inconsistency to keep. The cross-workspace deep link's inert
composer route is unchanged; a landing there would visit an unrelated room
before the link's destination arrives.

Review found two gaps in the first cut. The not-found screen set the hash,
which pushes, so Back returned to the route that had nothing to show; it now
leaves through the same hook. And a skip list covering every loaded page read
as an empty workspace while more pages existed, so the landing now pages past
skipped rows before opening the composer, requesting once per list change so
a failed page cannot loop.

A second round corrected the record more than the code. The rationale above
had said the skip exists because the archived row sits in the list until its
tombstone; `evictCachedWorkstream` in fact drops the row from the list as it
clears the work stream's other entries, so at the single-archive and leave
sites the skip covers only a re-delivered page, and the chained-archive race a
reviewer raised does not reach the landing for the same reason. The batch is
where the skip is load-bearing, so its derivation became `batchArchiveSkipIds`,
exported and tested, with its best-effort nature and the direction it is
allowed to err in written down. Onboarding's finish, the last leave still
setting the hash, moved to the hook. And the mark-as-unread landing reading
the next row was recorded as the decision it is rather than left implicit.

### 2026-09-08 — A moved row travels to its new section

**What changed:** A pin, an unpin, a drag, and an `Alt`+`Arrow` move now play
the sidebar's list motion: the row slides out to the left, the rows between
close the gap, and it slides in at its new slot. The sidebar marks every
work-stream and note row with `data-motion-key`, marks the **Pinned** heading
and every recency-group heading as held rows so they travel with the column,
marks the row being dragged with `data-motion-hold`, and attaches
`useListMotion` to its scroll box; project rows are held too, and project
member lists carry their own `data-motion-scope`, which is also the list their
rows are ranked within, so a project reordered past another glides with its
members.

**Why:** The reveal scrolls the viewport to a pinned row, but the row itself
still vanished from one section and appeared in another. The motion is the
other half of following it, and it covers the moves the reader did not cause.

**Considered and rejected:** Building the motion into this section. Rows move
for many reasons besides pinning, and a sidebar-wide primitive that classifies
every row by what actually changed place is what makes one message and one pin
look like the same kind of event. [`list-motion.md`](list-motion.md) records
the design.

**Consequences:** The reveal must run before the motion's hook, as the layout
effect declared ahead of it; a passive effect there scrolls to nothing. The
dragged row must keep `data-motion-hold` while `dragOrder` is live, or every
`dragover` makes it leave and re-enter, and the row's `dragover` must keep
resolving its target through `layoutRowAt`. An `Alt`+`Arrow` move glides
rather than travels, because the focused row is the reader's own.

Shipped in #612. The
project section's scope is what keeps a member row from being taken for the
recent list's copy of the same work stream; a new place that renders the same
row twice needs one of its own.


### 2026-09-08 — Preserve visit authority across response paths

**What changed:** Visit pushes carry one row, including system rows, instead of
rebuilding the recent page. Child responses cannot clear workspace-owned visits;
legacy servers retain activity semantics. One renderer helper owns ordering and
bulk-route matching and default landing selection, and incompatible cursor
anchors restart the directory walk.

**Why:** Review exposed response merges that erased visits, mismatched batch
cleanup, unnecessary per-focus page work, and rollout compatibility gaps.

**Considered and rejected:** Reading access time into every child response adds a
cross-object read and still permits an older response to overwrite a newer push.
Defaulting missing access fields to null would erase the legacy/support distinction.
Workspace-wide invalidation would notify other members about one user's visit.

**Consequences:** Keep live user-scoped pushes for session synchronization. The
directory waterline orders workspace-owned fields, including visits; it is not a
read marker. Unvisited rows intentionally use creation time rather than activity.


### 2026-09-07 — Order recent work streams by the viewer's access

**What changed:** WorkspaceDO records foreground visits per user, pages by those
visits, and pushes the saved order to the user's other sessions. Sidebar groups,
project rows, and group bulk selection use the same access-or-creation timestamp.

**Why:** Shared activity moved rows even when this person had not opened them;
the requested order must follow the person across sessions.

**Considered and rejected:** Device-local history would disagree between sessions.
Counting pooled sockets as visits would promote rows the person never viewed.

**Consequences:** Preserve the independent directory waterline for workspace-owned
access fields, keep pins manual, and do not reinterpret message activity as visits.


### 2026-09-07 — Make startup failure and explicit-route coverage match the real shell

The landing now surfaces an unavailable workspace socket even before the list
query is enabled. Query errors alone cannot report a failed opening connection.
Explicit New and work-stream destinations are covered through the actual app
route table; cross-workspace deep links keep an inert composer route while their
resource action resolves, so the default landing cannot open an unrelated room.


### 2026-09-05 — Open the first sidebar work stream by default

Startup and workspace activation now resolve the root route from the shared
socket-backed directory: the first stored pin, otherwise the first recency-grouped
work stream, using the sidebar's existing ordering functions. Missing directory
data shows an opening state; only a confirmed empty list opens the new composer.
This replaces the unconditional new-workstream landing because returning members
should enter their existing conversations. Explicit New actions and deep links
retain their destinations, and later directory updates never redirect an open
conversation. The landing component tests cover ordering, pending/empty/error
states; app-route tests cover explicit destinations and session tests cover cross-workspace route reset.

### 2026-09-04 — Retire numbered navigation, retain pin ordering

Command-number hints and activation were removed to simplify navigation. Pin
ordering and its keyboard controls remain; do not restore number handlers when
changing pins. Historical entries below describe the retired feature.

### 2026-09-04 — Search reorders only visible pin slots

**What changed and why:** A filtered drag or keyboard move now merges the visible
order back into the complete stored arrangement before sending it. Sending only
matches made the server append hidden pins, moving work the reader never touched.
Hidden pins keep their positions, matching the reference app's slot-preserving
reorder behavior; the server still receives the complete list.


### 2026-08-30 — Command-number pills share the automation You chip

**What changed:** The held-Command `⌘1`–`⌘9` overlay now renders through the
same `Badge` + `scope-badge` chrome as an automation row's You / Workspace
chip, instead of a taller, shadowed, warmer pill of its own.

**Why:** The two chips sit in the same sidebar, and the command hints were
reading as a second control language — larger, raised, and a different grey —
next to the flat You badges they were meant to sit beside.

**Considered and rejected:** Restating the You-chip colours and padding on
`.command-shortcut-pill`. That would match once and drift the next time either
rule moved. Sharing the classes is the thing that keeps them the same.

**Consequences:** Overlay-only extras (the fade-in, tabular numbers, and the
command glyph) live on `.scope-badge.command-shortcut-pill` so they cannot lose
to `.scope-badge` on source order. Changing the automation badge now changes
the command hints too; that is the point.

### 2026-08-27 — Project ordering stays independent from pins

**What changed:** The sidebar now renders a separately draggable Projects
section before Pinned, backed by `workspace_project_order`; no pin schema or
ordering behavior changed.

**Why:** A project groups shared work while a pin keeps one work stream handy
for one person. Sharing either ordering would make one gesture silently rewrite
the other concept.

**Considered and rejected:** Reusing pin positions or removing a pinned work
stream from Pinned when it joins a project.

**Consequences:** A work stream may eventually appear inside a project and in
Pinned simultaneously, and the two drag protocols remain separate.

Design: `docs/PRDs/2026-08-26_projects/prd.md`.

### 2026-08-26 — The complete live-state supplement is independent of the pin cap

**What changed:** The initial WorkspaceDO directory contract no longer caps the
combined pins, recent rows, and live-state supplement at 1,250 entries. The
existing 1,000-pin product limit and 250-row recency cursor remain unchanged.

**Why:** Every live-state row must be available for proactive sockets even when
a workspace already has the maximum pins and recent page. Reusing the arithmetic
sum as a parser maximum made valid product states reject the entire sync frame.

**Considered and rejected:** Truncating live rows would silently violate the
warming policy. Lowering the pin or recency limits would change unrelated
product decisions to accommodate a transport-schema shortcut.

**Consequences:** The first page can exceed 1,250 rows, while later recency pages
remain cursor-bounded. Any future defensive payload limit needs its own measured
product decision rather than an inferred row count.

Shipped in #341.

### 2026-08-26 — Pins proactively retain both work-stream sockets

**What changed:** Every pinned work stream now participates in Electron's
background realtime pool with both its WorkstreamDO control connection and
substream `0` feed connection. The same pool retains the five most recently
active unpinned rows and any other running work stream. WorkspaceDO supplements
its first recent page with all visible running rows so pagination cannot hide a
connection target.

**Why:** A pin is the user's durable declaration that a work stream should be
immediately reachable. Warming only the visible row or only its metadata still
leaves the feed handshake and snapshot on the critical path when the pin is
opened.

**Considered and rejected:** Warming a fixed number of pins would silently make
pin order a performance priority and invent a cap the product did not choose.
Opening pins sequentially would recreate the cold queue this transport change
removes.

**Consequences:** Pinning and unpinning change the background connection set as
soon as the directory cache updates. The pool still deduplicates active,
running, recently viewed, recent-unpinned, and pinned roles by work-stream ID.

Shipped in #341.

### 2026-08-20 — The imported D1 pin source is removed

**What changed:** Migration 0090 drops `workstream_pins` and its writer fences,
and the obsolete D1 pin/list service and Node fixture are deleted. The real
workerd suite now owns pin-order and per-user isolation coverage against
WorkspaceDO SQLite.

**Why:** Import is complete, and retaining an empty regional pin table leaves a
second schema that a misrouted read can mistake for authority. The old Node test
proved SQLite statements against that dead table, not the deployed owner.

**Considered and rejected:** Keeping the D1 test as compatibility coverage.
Pin commands are native typed WorkspaceDO RPCs, so there is no regional SQL
dialect to preserve.

**Consequences:** A WorkspaceDO outage fails the pin surface closed. D1 contains
neither pin data nor a fallback query.

### 2026-08-18 — Pin pages use the workspace directory waterline

**What changed:** The WorkspaceDO page clock and wire field are now explicitly
named `directoryWaterline`. Pin responses still replace the complete personal
order, while other windows receive a waterlined workspace socket invalidation.

**Why:** Work-stream common/viewer state now has separate authority-local
waterlines. Calling the independent pin/page clock a generic version obscured
which receiver ordering rule it belongs to.

**Considered and rejected:** Folding pins into WorkstreamDO viewer waterlines.
One personal reorder spans many work streams and must remain one WorkspaceDO
transaction.

**Consequences:** Pin fields reconcile under the workspace page/invalidation
waterline, not either work-stream state waterline. Electron records the last
directory waterline observed per work stream and refuses an older page's pin
value, while reconnect reloads a resident directory to repair missed pushes.

### 2026-08-18 — Pins become WorkspaceDO product state

**What changed:** Pins, position rewrites, readability checks, and pinned-first
directory pages now execute in WorkspaceDO SQLite. The command endpoints are
retained as thin RPC adapters, while other windows converge from the workspace
socket. Maintenance imports frozen D1 pins before a route opens and D1 rejects
post-cutover pin writes. A 1,000-pin bound now matches request and page limits.

**Why:** A user-specific sidebar arrangement belongs beside the authoritative
workspace directory it reorders. Leaving pins in D1 would require joining or
merging two serving authorities for every page.

**Considered and rejected:** Keeping D1 pins as the one exception, or storing
pins in each WorkstreamDO. The first preserves split authority; the second turns
one reorder into N object mutations with no atomic order.

**Consequences:** WorkspaceDO is the only post-cutover pin writer. Its directory
waterline changes after each effective mutation, and the first page may contain
up to 1,000 pins in addition to at most 250 recent rows.

### 2026-08-13 — Command shortcut discovery and use are distinct signals

**What changed:** Holding Command reports one reveal per physical hold, and a
successful numbered navigation reports the selected number plus a bounded
destination class. Repeated keydowns, unavailable numbers, and dialog-blocked
attempts are excluded.

**Why:** Navigation outcomes alone could not distinguish discovering the
numbered overlay from using it, while raw route or work-stream identifiers would
create unnecessary high-cardinality analytics.

**Considered and rejected:** Reporting every Meta keydown, route paths, titles,
or failed shortcut attempts. Those respectively inflate long holds, expose
content or identifiers, and count interactions the product intentionally did
not perform.

**Consequences:** The reveal event's available count remains capped at nine and
the use event taxonomy must stay aligned with the pinned-then-recent target
builder. Product analytics opt-out suppresses both.
### 2026-08-12 — Command numbering continues into recent work

**What changed:** The `⌘1` through `⌘9` sequence now starts with the manually
ordered pinned rows and uses any numbers left over for recent work streams and
notes in their displayed recency order. With three pins, the first recent row is
therefore `⌘4`. The recent links expose the same mapping through
`aria-keyshortcuts`, and their held-Command pills use the existing row overlay.

**Why:** Ending the sequence at the Pinned heading made the keyboard order stop
while the visual list continued. A reader with fewer than nine pins saw unused
number keys beside immediately adjacent destinations, including digest rows,
and had to switch back to pointer or focus navigation at that arbitrary section
boundary.

**Considered and rejected:** Restarting recent rows at `⌘1` would make the same
shortcut name two visible destinations. Numbering Automations and primary
actions too would shift every work-stream shortcut when unrelated content
changed and would no longer preserve Pinned as the stable start of the run.

**Consequences:** Pinning, unpinning, or reordering changes the number assigned
to recent rows because pins always lead. Recent notes participate exactly where
they appear among work streams, so the visual order and keyboard order cannot
diverge. The nine-key ceiling remains unchanged and `0` remains unused. The
derived pinned, recent, target, and lookup collections are memoized together so
unrelated sidebar state does not tear down and re-register the global shortcut
listeners.

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

### 2026-08-12 — A page cannot become the list by sharing its cache key

**What changed:** Every write to the renderer's `workstreams` query now goes
through `setCachedWorkstreams`, which binds the key to `WorkstreamSummary[]` and
asserts the array category again at runtime. Socket reconciliation writes the
`items` from `getWorkstreams`, not the page that contains them. ESLint forbids a
direct `setQueryData` or `setQueriesData` write to that key outside the helper,
and also forbids desktop tests from casting a partial double to `RallyApi`.
Those consumers now declare the smaller API capability they actually use, and
their mocks prove it with `satisfies`.

**Why:** The pagination change below widened `getWorkstreams` from an array to
`{ items, nextCursor }` and updated the list query, but missed two direct calls
in socket reconciliation. React Query inferred the page object as a perfectly
valid generic cache value because its query key carries no value type; the
sidebar independently read the same key as an array and crashed on `.filter`.
The socket tests returned the obsolete array shape behind `as unknown as
RallyApi`, so the API signature change could not break them.

**Considered and rejected:** Parsing every internal cache update with a full
Zod schema. The server response had already passed its page schema; the defect
was choosing the page instead of its valid `items`. Re-validating every mapped
field would duplicate the external boundary without restoring the missing
key/value relationship. The helper therefore uses TypeScript for the full
shape and a cheap runtime array assertion for the category error that caused
the crash.

**Consequences:** A new producer cannot write this cache directly without
failing lint, and a renamed API return shape now fails every contract-checked
socket mock. The runtime assertion is a backstop for type escapes, not a second
wire parser: external HTTP, socket, IPC, and storage boundaries continue to use
Zod. Canonical socket refreshes merge their first page over the flat cache
rather than replacing it, so already-loaded later pages and debug-only system
rows remain visible until the paginated invalidation completes. Any future
change from a flat list to a page must change the helper and all of its readers
deliberately rather than arriving through one caller.

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

Server-side rather than device-local because a person uses Rally on more than
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
  room, which is a channel Rally does not have yet.
- `MAX_PINNED_WORKSTREAMS` is a contract constant and bounds the reorder
  request. Raising it raises the size of the rewrite batch with it.
