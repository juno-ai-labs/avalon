# Pinning

A person pins what they want to hand: a Canvas or a Sidekick. Each of the two
sidebar sections has a **Pinned** group above its list, and the pin lives on
the server, so the same person opening Rally on another machine finds their
list as they left it. Thread, Channel, Breakout and artifact pins, and the
Pinned, Threads, Channels and Artifacts sections that drew them, were removed
at the 2026-11 cutover; the changelog below records them.

A pin is **one person's opinion about one item**. Pinning tells nobody else
anything, changes nothing about who may read the item, and does not appear on
anyone else's screen. Who may open a Canvas is its audience
([`canvases.md`](canvases.md)); who may open a Sidekick is its share list
([`automation-lifecycle.md`](automation-lifecycle.md)).

**`workspace_pins` is the one source of whether something is pinned.** A
Canvas's or a Sidekick's pin is a row there, and reaches the client as its
list row's `pinnedPosition`, so nothing else answers the question.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/workspace-pin-storage.ts` | `workspace_pins` and `WorkspacePinStorage`: one person's pins of one kind and their order. Visibility of the item is the caller's question. |
| `apps/api/src/durable-objects/canvas-schema.ts` | WorkspaceDO migration 141, which admits `canvas` and `sidekick` in `workspace_pins.item_kind`. |
| `apps/api/src/durable-objects/workspace-do.ts` | `setSidebarPin` and `reorderSidebarPins`, the visibility check on a pin, and the republish of the pinner's list. |
| `apps/api/src/routes/canvases.ts`, `apps/api/src/routes/automations.ts` | `POST /canvases/:id/pin` and `POST /sidekicks/:id/pin` (`{pinned}`; `/automations/:id/pin` is the same route under the storage name). Both are mounted on `identityApi`, so a guest pins as a member does. |
| `apps/api/src/routes/workspace.ts` | `PUT /workspace/pinned-order` (`{kind, itemIds}`): one person's order for one list's Pinned group. |
| `apps/api/src/routes/navigation.ts` | `GET /navigation/artifact-pins`, kept for the detached artifact window and always empty (see [Artifact pins](#artifact-pins)). |
| `packages/contracts/src/canvases.ts` | `SidebarPinRequestSchema`, `SidebarPinOrderRequestSchema`. |
| `apps/desktop/src/renderer/components/navigation-rows.tsx` | The Pinned group both sections draw: `PinnedSection`, `PinnableRow`, `usePinWrite`, `splitPinned`, `useRowPinDrop`. |
| `apps/desktop/src/renderer/components/canvas-sidebar-section.tsx`, `sidekick-sidebar-section.tsx` | Each list's Pinned group above its other rows. |
| `apps/desktop/src/renderer/screens/canvas.tsx` | The Canvas title menu's pin switch. |

## How it works

### One pin list per kind

`workspace_pins(user_id, item_kind, item_id, parent_id, position, …)` is
keyed `(user_id, item_kind, item_id)`. A Canvas or a Sidekick names no parent.
The table still admits the retired kinds (`thread`, `channel`, `breakout`,
`artifact`), whose rows no reader lists.

- **Pin and unpin.** `POST /canvases/:id/pin` and `POST /sidekicks/:id/pin`
  (the client's paths; `/automations/:id/pin` is the same route) take
  `{pinned}`, for members and guests alike. A pin is refused as `canvas_not_found` or
  `sidekick_not_found` for an item the person may not open (a Canvas outside
  its audience, a Sidekick outside its share list); an unpin is never refused.
  A pin appends at the end of the person's group.
- **Order.** `PUT /workspace/pinned-order` takes one kind and its ids, first
  to last. It sits under the member-only `/workspace` routes, so a guest cannot
  reorder; no client calls it yet. An id that is not pinned is dropped; a pin the request leaves out
  keeps its relative order behind the ones it names, so a second window that
  pinned something a moment ago loses its *position*, never its pin.
- **Delivery.** A pin write moves that list's waterline and republishes the
  person's Canvases or Sidekicks list on the workspace socket, so their other
  windows follow. The Canvas list is a per-reader projection already; the
  Sidekicks list is republished to that person alone.
- **Reading.** Each list's query joins `workspace_pins` for the reader and
  carries `pinnedPosition` on the row: null when unpinned. A pin whose item the
  person can no longer open is simply not on a row they are sent.

### In the sidebar

`splitPinned` draws the rows with a position, in position order, above every
other row. Dragging an unpinned row into the group pins it (`useRowPinDrop`),
at the end of the group; a row's context menu pins and unpins it, and so does
a Canvas's title menu. A Sidekick that needs input is drawn in that section's
**Needs input** group, above Pinned, rather than twice. A refused pin puts the
row back and says so above the list (`usePinWrite`). The client does not
reorder the group yet: both sections pass `reorderable={false}`, so the order
route has no caller.

### Ordering

Positions are unique and ascending per person and kind. `pin` chooses its
position inside the insert statement, as `MAX(position) + 1`, rather than
reading the list and binding a number back in — a read-then-write hands the
same position to two pins made at once. An unpin leaves a hole, which is
harmless and closes on the next reorder.

### Artifact pins

An artifact pin named the Thread whose Main generated it and was listed only
while that Main could be opened. Every Thread is retired, so no stored artifact
pin can be listed: `GET /navigation/artifact-pins` answers an empty list, which
the detached artifact window reads as "not pinned". A Canvas's artifact is
reached by pinning the Canvas.

### Recent work streams

The per-viewer recency that ordered the Threads list
(`workspace_workstream_access`) went with Threads. The Canvases list is ordered
by the Canvas's own recent activity, newest first
([`canvases.md`](canvases.md#in-the-client)); the Sidekicks list by title, A–Z.
The table stays in storage, unread, with the per-Space pin tables below.

## Invariants

- **`workspace_pins` is the one answer to "is this pinned".** The rows'
  `pinnedPosition` is read from it, and nothing else stores a pin.
- **A pin is one person's.** Nothing in the table is readable by, or visible
  to, anybody but its owner, and a pin write republishes only that person's
  view of the list.
- **A new pinnable kind rides its own list's rows, not a shared `pins` list.**
  A released client parsed `PinKind` as a closed enum, so one unknown kind in a
  shared list would have failed its whole sidebar.
- **Pinning is gated on readability; unpinning is not.** Removing a pin is
  never a question about the item, and a pin that has gone dark can only be
  reached by a caller that already knows the id.

## Boundary

This module owns `workspace_pins`, the pin and order routes, and the Pinned
group of both sidebar sections. It owns no part of what a Canvas or a Sidekick
*is* or who may read it, and it does not decide membership: D1 remains
current membership authority, and WorkspaceDO's audience and share-list checks
decide whether a member or a guest may pin an item. [`canvases.md`](canvases.md)
holds what is Canvas-specific about a Canvas row; the Pinned group mechanism
is this document's, for both kinds.

## Failure modes and limits

- **No count limit.** The per-person cap
  (`MAX_WORKSTREAM_PIN_PLACEMENTS_PER_USER`, 1,000 placements) counted Thread,
  Channel and Breakout pins and does not apply to these kinds; a Canvas or
  Sidekick pin is bounded by the items a person can open.
- **A refused pin or drag reverts.** The group re-renders from what the
  server holds, which is what the person's other devices are showing.
- **A pin whose item is gone contributes nothing.** It is not on any row; the
  stored row survives, so a Canvas a person is let back into comes back in its
  old place.

## Testing

| Suite | What it covers |
| --- | --- |
| `apps/desktop/src/renderer/components/canvas-sidebar-section.test.tsx` | The Canvases list's Pinned group above every other row, and a drop into it pinning the row. |
| `apps/desktop/src/renderer/components/sidekick-sidebar-section.test.tsx` | The Sidekicks list's Needs input and Pinned groups. |

One trap in the desktop tests: jsdom implements no `DataTransfer`, so a drag
event needs a small stub rather than `new DataTransfer()`.

## Data model

`WorkspaceDO.workspace_pins` (migration 97, rebuilt by 110 and 141) is keyed
`(user_id, item_kind, item_id)`, with `parent_id` set exactly when `item_kind`
is `breakout` or `artifact`, ordered by `workspace_pins_order_idx (user_id,
item_kind, position, item_id)` and indexed by item for removal
(`workspace_pins_item_idx`). It has no foreign key, for the reason
`space_invitees` gave: a key would make a rebuild of the item table cascade
here. A pin whose item is gone is dropped where it is read. The older per-Space
`workspace_workstream_pins` and `workspace_pinned_order` tables, and the Thread
recency table `workspace_workstream_access`, stay in storage until a migration
drops them (plan step C-7); nothing reads or writes them.

## Changelog

### 2026-11-07 — A Canvas and a Sidekick are what a person pins; Thread, Channel, Breakout and artifact pins are removed

**What changed:** WorkspaceDO migration 141 admits `canvas` and `sidekick` in
`workspace_pins.item_kind`. `setSidebarPin` and `reorderSidebarPins` pin and
order them in their lists' Pinned groups (`POST /canvases/:id/pin`,
`POST /sidekicks/:id/pin`, `PUT /workspace/pinned-order`), and each list's
rows carry `pinnedPosition`. The client pins from a row's context menu, a
Canvas's title menu, or by dragging the row into its section's Pinned group
(`useRowPinDrop`, the list-agnostic sibling of the deleted `usePinDrop`), at
the end of the group; a Sidekick that needs input is drawn in Needs input
rather than twice. The Pinned, Threads, Channels and Artifacts sections, their
drag to reorder (`usePinnedDrag`), the personal order (`personal-order.ts`),
the pin hooks (`lib/pins.ts`), the artifact pin actions, the landing that
opened the first pinned Channel, the shared `pins` list and its
`/navigation/pins` routes, and the older per-Space routes are deleted;
`GET /navigation/artifact-pins` stays for the detached artifact window and
answers empty. `WorkspacePinStorage` loses `list`, `artifactPinners`,
`listArtifacts` and `count`, which read the retired kinds, and `pin` no longer
takes a parent (`StoredPinKind` is `canvas | sidekick`). This document was
`workstream-pinning.md` and is renamed `pinning.md`.

**Why:** Plan steps A-8, A-14, B-3 and C-1 of the
[Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md):
the PRD keeps "a Pinned group in each list" and removes the Pinned section,
and the pinnable kinds other than Canvases and Sidekicks are deleted with
Threads, Channels and Breakouts (decision log, 2026-11-06). An artifact pin was
listed only while its Thread's Main could be opened, so no stored one can be
listed now. In plan step C-2, `WorkspacePinStorage`'s `list`,
`artifactPinners`, `listArtifacts` and `count` reads lost their last callers
with the Thread routes and the old sidebar sections, so they were deleted.

**Considered and rejected:** Widening `PinKind` and carrying the new kinds in
`pins`: a released client parsed `PinKind` as a closed enum, so every released
desktop would have dropped its whole sidebar payload. Folding this document
into `canvases.md`, as plan step D-3 proposed: the Pinned group is one
mechanism shared by Canvases and Sidekicks, so a Canvas document would have
owned half of a Sidekick behaviour, and server documents and code comments
link this document's anchors.

**Consequences:** A new pinnable kind rides its own list's rows, not a shared
list. The retired kinds' rows stay in `workspace_pins`, and the per-Space
tables in storage, until a data migration drops them (plan step C-7); no
reader lists them. The client offers no reorder yet, since both sections pass
`reorderable={false}`; the order route is ready for it. See
[`canvases.md`](canvases.md#the-canvas-list).

### 2026-10-17 — Generated artifacts can be pinned

**What changed:** An artifact Rally generated in a thread's Main can be pinned
from its card's new `⋯` menu or its right-click menu. Migration 110 rebuilds
`workspace_pins` so `item_kind` admits `artifact`, carrying its thread as
`parent_id`. The pins travel as `artifactPins` with routes of their own, and
the sidebar gains an **Artifacts** tab and an Artifacts part in Pinned. A new
version somebody else makes of a pinned artifact makes it unread, counts on
the Artifacts and Pinned buttons, is an `artifact_updated` Activity row and a
push; migration 111 adds the ledger and trigger that notice it.

**Why:** People wanted a generated deliverable at hand without finding the
message it came in. Pinning was already one person's ordered list of things
to hand, so an artifact joins it rather than starting a second mechanism.

**Considered and rejected:** A seen-version column on the pin. The Activity
feed already keeps one waterline per person per subject; an artifact as a
subject, its version as the ordinal, gives the pin and its rows one answer and
reuses the read event, sync topic and clear-rule language as they stand.
Logging an Activity event per version: the version history is already the
log, as the directory is for starts and finishes. A fourth `PinKind` in `pins`. A shipped desktop
parses `Pin` strictly, so the first artifact pin would empty its Pinned lists;
a separate key costs a second list in the client and nothing on the old one.
A table of its own: the order, limit and write paths are the same, and the
rebuild is three statements on a table nothing references. Checking a
breakout's artifact against its conversation object: one more hop on every pin
and list read, for a case attaching the artifact to its thread already covers.

**Consequences:** `list` filters `artifact` out, so every reader of the shared
list keeps answering for three kinds; a new reader of `workspace_pins` must do
the same. The pin limit counts artifacts. A pinned artifact's row reflects its
thread's title and access as of the last connect or pin write, not live.


### 2026-10-12 — Dragging a row into Pinned pins it again

**What changed:** Pinned is always drawn, and an unpinned row dragged into it
is pinned at the slot it is dropped in.

**Why:** The redesign dropped this without a decision in the PRD; with nothing
pinned, nothing on screen said pinning existed.

**Considered and rejected:** A pin-at-position call. Append plus
`PUT /navigation/pins` does the same with no API change.

**Consequences:** A drop is two writes. The second is skipped when a newer pin
write has started (`latestPinWrite`), so it cannot overwrite that write's order.
The visible slot is translated through its next visible pin into the full
returned order, or appended when there is no next pin. Hidden pin records
therefore cannot shift the dropped row away from the slot the person chose.

Shipped in [#1197](https://github.com/juno-ai-labs/avalon/pull/1197).

### 2026-10-10 — One pin table for threads, Channels and breakouts

**What changed:** Migration 97 adds `workspace_pins`, copied from the per-Space
pins, with routes under `/navigation/pins`. It is the one source of whether
something is pinned: the sidebar, the title menus, the background
socket pool and telemetry read it. The old routes stay for older desktops and
mirror one way into it. A pin write sends the person's own sockets a small
frame rather than a Space snapshot. A directory row's `spacePins` and the
snapshot's `pinnedOrder` are the old per-Space pins, read only by older
desktops. The landing now returns to the Channel a screen left, then the
first pinned Channel, then General, and never opens a thread.

**Why:** The new sidebar has a Channels tab and a Threads tab, each with a
Pinned section that is the person's alone and not tied to a Space
([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)). A thread pinned in
two Spaces is one pin there. Two tables read by different consumers gave two
answers for any pin made on the new client, which is never written back. The
old landing picked a thread by recency, which read a thread the person had not
chosen, and its Space-scoped rules had no Space left to scope to.

**Considered and rejected:** A table per kind: three of every read, write and
delivery for one question. A new `container_kind` in
`workspace_container_order`: a shipped desktop drops an order kind it does not
know, the reason All's order got a table of its own. Writing new pins back to
the per-Space table: a thread pin has no Space to file it under.

**Consequences:** Until the old routes are removed, an unpin on an old desktop
keeps the thread pinned while any other Space still pins it, and a pin made on
the new client does not appear on an old desktop. A new reader of pin state
reads `workspace_pins`. The sidebar's row motion between sections is gone with
the old sidebar.

### 2026-10-08 — A touch drag no longer opens the row menus over itself

**What changed:** A row's menu and the channel list's empty-space menu are
now controlled. A row's menu closes when the row is dragged and refuses to open
until the next press; the list's menu refuses to open for a press that began on
a row, link or button.

**Why:** In Safari on iPhone a long press on a channel lifted it into a drag
and also opened two menus: the row's own and the list's "Start New Channel".
Radix opens a context menu 700ms into a touch press and cancels only on a
pointer move, up or cancel, none of which iOS sends the page when it starts a
native drag. The list's check for "a row has its own menu" ran only on
`contextmenu`, which a touch long press never fires. With a modal menu open
the rest of the page ignores the pointer, so the drag found no drop target and
the Pinned placeholder never appeared.

**Considered and rejected:** Turning the drag off on touch screens and leaving
Pin in the menu as the touch path. It removes a gesture iPad users expect.
Calling `preventDefault` on the list's touch `pointerdown`, which makes Radix
skip its timer: it cancels every tap on a row too, and WebKit ties a tap's
`click` and gestures to that event. Sending a synthetic `pointercancel` and
Escape to the uncontrolled menus worked in tests but leaned on Radix
internals.

**Consequences:** Both menus own their `open` state now; anything else that
opens or closes them has to go through it. Not yet confirmed on a device:
iOS's timing of the drag start against the 700ms timer was inferred from a
screenshot.

Shipped in juno-ai-labs/avalon#1169, a follow-up to juno-ai-labs/avalon#1166.

### 2026-10-07 — Pinned holds a slot open for a Channel dragged into it

**What changed:** Dragging an unpinned Channel over **Pinned** now draws a
faded copy of it where it would land and pushes the pinned rows below aside. A
release pins it there: the pin, then a reorder unless the slot is the end of a
Space's run.

**Why:** The drop zone only said "pin". With pins already present the reader
could not tell where the Channel would land, and it always landed at the end,
which then needed a second drag. Reordering inside the section already showed
the row in place, so a drag in from outside read as a cruder action.

**Considered and rejected:** A pin-and-place endpoint that takes the slot.
Two existing writes cover it, and a release at the end of a Space's run, the
common case, still costs one.

**Consequences:** The placeholder carries no `data-workstream-id`, so the
reveal effect and the slot lookups never mistake it for a pinned row; keep it
that way. Keep the preview order from the release until the pin lands, or the
new row flashes at the end first. Under All an end drop must still save the
order, because an unpin leaves the Channel in All's saved order. A second pin
to the same Space issued while the first is in flight supersedes its response,
and the first Channel then stays at the end; this was accepted rather than
serializing the two writes.

Shipped in juno-ai-labs/avalon#1166.

### 2026-10-07 — Leaving a Channel lands on its Space's top sidebar row

**What changed:** Leaving a Channel's Main now opens the row the sidebar draws
first in that Space: its first pin, or else the first Channel under the
reader's sort, opened the way that row opens (a Breakout when Main is not the
reader's). A Space the leave emptied opens on starting a Channel there. The
Space is the sidebar's filter when the Channel is in it, otherwise the
Channel's first Space, and the destination carries `?space=` so the sidebar
selects it and the landed row is the top row on screen. The sidebar's order moved into
`sidebar-channel-order.ts` and the conversation directory's row rule into
`conversation-directory.ts`, so the sidebar and the landing read one copy.

**Why:** Leaving a personal Channel left the reader on "Channel could not be
opened". The server closes the leaver's socket before it answers the DELETE,
and that close evicts the cached detail; the leave handler read the scope from
the cache in `onSuccess`, found nothing, and never left the route. It now
snapshots the scope and Space in `onMutate`, before the request. The landing's
old answer, the most recent Channel across the Organization, also dropped the
reader out of the Space they were working in.

**Considered and rejected:** Keeping the detail through the revocation.
Evicting on revoke is the access boundary in `docs/access-revocation.md`, and
the leave only needs two facts it already had. A recency-only pick inside the
Space was the first cut; it disagreed with the sidebar whenever a pin or an
A–Z sort put another row on top, which is what "first channel" means to the
reader.

**Consequences:** A Space landing waits for that Space's whole list, as the
sidebar does, because its first pin can sit on a later page than a row that
matches. Any new reader of "the top row" must call `firstSidebarChannelInSpace`
rather than sort on its own. Leaving an Organization-wide Channel still stays
put, since the reader keeps read access.

Shipped in juno-ai-labs/avalon#1141.

### 2026-10-02 — All's Pinned section keeps an order of its own, and is always there

**What changed:** WorkspaceDO migration 87 adds `workspace_pinned_order`, one
person's order for All's Pinned section. `reorderAllPinned` (`PUT
/workspace/pinned-order`) stores it, keeping only Channels the person can list
and merging with what they had; the sidebar payload and the Space snapshot
carry it as `pinnedOrder`. The sidebar draws All's pins in that order, saves it
on a drag or Alt+Arrow, always shows the section with a drop zone when it is
empty, and lets any unpinned row be dragged into it under All.

**Why:** All shows pins from several Spaces, and each Space keeps its own run,
so All had no order a drag could write. Asked for a drag that is the same on
every device, the order follows the account as every other Rally order does; a
device-only order was rejected. A first cut added a `pinned` kind to
`workspace_container_order`. Review rejected it: shipped desktops parse
`ordering` strictly and one entry of an unknown kind drops the whole snapshot,
blanking their sidebar, and an older Worker after a rollback would fail to
parse a stored `pinned` row. A separate table and a separate optional field are
invisible to both.

**Consequences:** Rows name Channels, not pins. Unpinning does not remove a
Channel's row, so pinning it again under All returns it to its old place; the
client draws only what is pinned. Any future order that older builds must not
see takes the same route: its own field, never a new `OrderedContainer` kind.

### 2026-09-21 — Pins belong to Channel placements in Spaces

**What changed:** Pin identity and ordering are now keyed by person, Space, and
Channel. Every write names the Space; the desktop derives its displayed pin
position from the selected Space; removing a Channel from a Space removes only
that placement's pin. Migration 66 clears legacy Organization-wide pins while
rebuilding the table with the new key. Surfaces without a selected Space no
longer expose pin controls or a pinned section.

**Why:** A shared Channel can appear in several Spaces, and “pinned” is a choice
about where it appears in one Space rather than a global property of the
Channel. Carrying the old row forward would impose one ambiguous choice on all
placements.

**Considered and rejected:** Copying each legacy pin into every Space would
create choices the person never made; assigning it to one Space would require
an arbitrary winner. Both were rejected in favor of the explicit clean cutover
requested for the migration.

**Consequences:** Existing pin lists start empty after migration. The wire keeps
the legacy scalar null and carries `spacePins`; a client must have a selected
Space before it can mutate or display a pin. Any future non-Space surface that
wants pins must first define which Space it represents. A batch filter that
distinguishes pinned from unpinned rows also names its Space, so a Channel pinned
elsewhere remains unpinned in the selected Space's recency group, while a Channel
without an active viewer-visible placement there is outside both groups. An
optimistic reorder carries that same Space identity until its request settles,
so switching Spaces cannot apply or persist another Space's preview.

### 2026-09-18 — Sidebar actions own their failure copy

**What changed:** Pin, unpin, visibility, archive, and pinned-order failures now cross into the
sidebar as a closed operation union. The sidebar maps each operation to stable
title and recovery copy.

**Why:** Persistent navigation outlives the request that failed. A server
sentence shown there reads as product content, and styling the recovery sentence
as a second red alert made the otherwise calm dialog visually contradictory.

**Considered and rejected:** Filtering specific router messages. The next
unknown response would still become UI copy by default.

**Consequences:** The reassuring modal body keeps ordinary modal styling, and
transport diagnostics remain available below the presentation boundary but are
not navigation text.

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


### 2026-09-19 — The pinned list keeps its own table beside the container-order primitive

**What changed:** `workspace_space_order` became `workspace_container_order`, a
per-person order keyed by the container being arranged — the Organization's
Spaces, a Space's Channels, a Channel's Breakouts. `workspace_workstream_pins`
was deliberately left out of it. `orderPinnedWorkstreams` now calls the shared
`orderByStoredIds`, so the four hand-arranged lists agree on what "stored first,
then the rest" means, but the pin rows, their dense rewrite, their allocation in
SQL and their travel on the directory page are unchanged. The section's
neighbour changed: a member session no longer has a recency-grouped list below
it, so the rule that a pin leaves that list now bites only in a guest session.

**Why:** A pin is not an ordering of a container. It is two facts at once —
*this Channel is one I want to hand* and *it goes here in that shortlist* — and
the container-order table stores only the second. Folding it in would have meant
either storing the first somewhere else, which is two answers to one question,
or teaching the container primitive a pseudo-container whose membership it
alone decides. Neither is a generalization; both are a special case wearing the
primitive's name.

**Considered and rejected:** A `pinned` container kind whose items are the
pinned Channel ids, with membership derived from the presence of a row. It
collapses two facts into one and makes "is this pinned" a question about
position, so an ordering write that dropped an id would silently unpin it —
which is exactly what the container kinds are allowed to do when they filter.

**Consequences:** Two drag protocols and two tables remain. What folding them in
would need, if it is ever worth doing: pinning has to stop being expressible as
an ordering — that is, the table would need a column saying a row is a *member*
independently of its position, at which point the ordering primitive is being
asked to hold membership and the merge has stopped paying. The honest version is
the reverse: teach the pins table nothing, and keep sharing only the client
helper, which is what this change did.

Design: `docs/PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md`.

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
