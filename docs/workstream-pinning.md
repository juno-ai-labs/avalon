# Work-stream pinning

A pinned work stream leaves the recency-sorted sidebar and moves into a
**Pinned** section under **Automations**, where it stays until it is unpinned.
The section is arranged by hand — dragged into order, never sorted — and both the
pin and the arrangement live on the server, so the same person opening Avalon on
another machine finds their list exactly as they left it.

A pin is **one person's opinion about a shared row**. Pinning a work stream tells
nobody else anything, changes nothing about who may read it, and does not appear
on anyone else's screen. Read that alongside
[`DATA_MODEL.md`](DATA_MODEL.md#work-streams), where `workstreams.scope` answers
the different question of who a work stream is *for*.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/0063_workstream_pins.sql` | The `workstream_pins` table: one row per (work stream, person), carrying the manual `position`. |
| `packages/contracts/src/index.ts` | `WorkstreamSchema.pinPosition` — the per-viewer position on the wire — plus `MAX_PINNED_WORKSTREAMS` and `ReorderWorkstreamPinsRequestSchema`. |
| `apps/api/src/mappers/workstream.ts` | `WORKSTREAM_VIEWER_JOINS_SQL` joins the reader's pin; `workstreamViewerBindings` is the one place the viewer's id is bound for those joins. |
| `apps/api/src/services/workstream-service.ts` | `pin`, `unpin`, `reorderPins`, and the dense-position rewrite behind them. `list` backfills pins onto the first page. |
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

Positions are dense and are rewritten in full on every change. `PUT
/workstreams/pins` takes the **entire arrangement**, not a move of one row: a
drag produces a complete list, and sending that list is what lets the server
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
than shown in both places. `Alt`+`ArrowUp` / `Alt`+`ArrowDown` on a focused
pinned row moves it one step, and each row announces its position to a screen
reader, so the order is not reachable by pointer alone. Plain arrows are left to
move focus.

## Invariants

- **A pin is per person.** Nothing about `workstream_pins` is readable by, or
  visible to, anybody but its owner. A surface that treated `pinPosition` as a
  property of the work stream would show one member's arrangement to another.
- **Positions are a dense ascending run per person.** Every path that removes or
  reorders rewrites the whole run. A gap or a tie makes "what order is this list
  in" ambiguous, and the sidebar's sort would then depend on row-arrival order.
- **`WORKSTREAM_VIEWER_JOINS_SQL` binds the viewer's id twice.** Use
  `workstreamViewerBindings`. A call site that binds one id where two are
  consumed shifts every binding after it, which SQLite reports as a type error
  somewhere unrelated rather than as the missing parameter it is.
- **The first page of `GET /workstreams` carries every visible pin**, whatever
  its activity. Without that, pinning something quiet and reloading loses it from
  the section it was deliberately put in. Cursor pages do not repeat them.
- **Pinning is gated on readability; unpinning is not.** A pin left behind by a
  work stream that has since been archived, or made private without this person
  in it, must stay removable — the row is the viewer's own, and there is no other
  way to be rid of it.

## Boundary

This module owns `workstream_pins`, the three pin endpoints, `pinPosition` on the
work-stream contract, and the Pinned section of the sidebar. It owns no part of
what a work stream *is*, who may read it, or how the recent list is sorted.

It deliberately does not:

- **Broadcast anything.** A pin changes nothing another person can see, so no
  socket event is sent and the work-stream room knows nothing about it. The same
  person's other windows converge on the sidebar's 15-second poll.
- **Decide visibility.** `apps/api/src/lib/workstream-visibility.ts` remains the
  single answer to "may this person read this work stream", and every pin read
  applies it — see [`DATA_MODEL.md`](DATA_MODEL.md#work-streams).
- **Pin anything but a work stream.** Automations and notes have their own
  sections and no pin.

## Failure modes and limits

- **50 pins per person** (`MAX_PINNED_WORKSTREAMS`). The 51st is refused with
  `422 pin_limit_reached`, and the sidebar raises it as an error dialog naming
  the limit. It is a product limit — the section's whole value is that a glance
  takes it in — not a storage one.
- **A refused drag reverts.** The local arrangement is dropped and the section
  re-renders from what the server holds, which is what the person's other
  devices are showing. The dialog says so rather than leaving a list that
  silently disagrees with the server.
- **A pin whose work stream is gone contributes nothing.** Archived or no longer
  readable, it is filtered out of every read; the row survives, so a work stream
  reopened to the workspace comes back in its old place.
- **A drag that ends where it started sends nothing.** `dragend` fires on a
  cancelled drag too, and rewriting every position for a drag that went nowhere
  is a write with no change behind it.

## Testing

| Suite | What it covers |
| --- | --- |
| `apps/api/test/workstream-pinning.test.ts` | Append-on-pin, per-person isolation, dense rewrite on unpin, tolerant reorder, the first-page backfill, and that an unreadable work stream cannot be pinned but a stale pin can be removed. |
| `apps/desktop/src/renderer/components/sidebar.test.tsx` (`pinned work streams`) | The section appearing only when something is pinned, rows leaving the recent list, stored order beating activity order, the menu toggle, live reorder during a drag, the keyboard move, and both error dialogs. |
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
collides with itself.

## Changelog

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
