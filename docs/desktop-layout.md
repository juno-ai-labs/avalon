# Desktop layout restoration

Rally restores a person's local reading layout when the desktop app reopens. The
Organization still owns which Canvases, Sidekicks and resources exist;
the device remembers only the view the person chose.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/ui-store.ts` | The sidebar's width and open section, and the right slot's state (`railOpen`, `railExpanded`, `railVariant`, `railWidth`, `inspector`). |
| `apps/desktop/src/renderer/lib/rail-split.ts` | The even split an attachment or artifact panel opens or restores at. |
| `apps/desktop/src/renderer/lib/desktop-layout.ts` | Scoped local keys and artifact panel selection. `useSemanticScroll` is still exported and tested, but nothing calls it. |
| `apps/desktop/src/renderer/components/app-shell.tsx`, `screens/landing.tsx`, `lib/landing.ts` | Last route save and startup restoration. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | Artifact panel selection per conversation. |
| `apps/desktop/src/main/artifact-window-state.ts`, `main-window-state.ts`, `main/index.ts` | Native artifact window registry and the display clamp shared with the main window. |
| `apps/desktop/src/renderer/App.tsx` | Fresh content authorization for detached windows after sign-in. |

## How it works

The renderer keeps the sidebar's width and its open section
(`rally.sidebar-section`: `canvases`, `sidekicks` or `activity`) in local storage. Keys
written before the 2026-11 cutover are no longer read: the Threads and Channels
sorts (`rally.sidebar-thread-sort`, `rally.sidebar-channel-sort`), the Space
filter (`rally.sidebar-space-filter`), and the widths of a thread beside its
Channel (`thread-width`) and of a Breakout beside its thread
(`breakout-width`). The sidebar no longer collapses, so there is no collapsed
state to keep. **The sidebar's scroll position is not restored**: neither list
calls `useSemanticScroll`, so each opens at its top. The selected artifact
panel is scoped to a conversation (`artifact-panel:<parent>:<substream>`, for
a Canvas its Chat, `artifact-panel:<canvas>:0`); its resource is looked up in the freshly loaded conversation before the
panel is drawn.

Every attachment and artifact opens its panel at an even split with the
conversation (`openRailAtEvenSplit`, called from `openPanel`). **No panel
resizes the window**: the panel and the conversation share the main pane, and
the split is half of it, in the desktop app and a browser tab alike.

**The panel never floats over the conversation.** At any width above the phone
layout (641px and up) the main pane gives up the panel's width and the panel
sits beside it; there is no dimming layer to click away. The panel's width is
capped by `--rail-max-slot`, which keeps `--conversation-min-width` for the
conversation where the window allows. A panel opens at half the pane, so where
the pane is narrower than two conversation minimums, 2 × 424 = 848px
(`railFillsPane` in `rail-split.ts`, which sets `rail-fills-pane` on the
shell), the even split would squeeze both the Chat and the panel, and the
panel takes the whole pane instead; closing it is the way back. The rule reads
the pane, the window less the sidebar (`mainPaneWidth`, which also follows the
sidebar giving way in a narrow tab, [`desktop-shell.md`](desktop-shell.md#the-sidebar)),
so at the default 416px sidebar (the 76px rail and the design's 340px list)
this is any window or tab narrower than 1264px, and at the 476px maximum
narrower than 1324px, the desktop app's 860px minimum included.
A Canvas's "⋯" and pill menus offer **Open artifact** while it has one: it
navigates onto the newest artifact as arriving does, beside the Chat, so a
panel closed by the person comes back without leaving the Canvas.
At phone width the panel is a full-width sheet.

Switching items in a panel already open for the same conversation keeps the
width the person dragged it to. The split itself is not saved: the width
stored per conversation is the one last dragged to, and it is what a panel
restored on arrival or relaunch comes back at (`restoreRail`). It is stored as
the panel's share of the main pane at the time (`rally.rail-share:<scope>`),
not as pixels, and restored as that share of the pane as it is now, held
between `MIN_RAIL_WIDTH` and the width that leaves the conversation its
minimum (the same bound `--rail-max-slot` draws). A panel dragged to half a
narrow window's pane therefore comes back at half a wide one's. A pixel width
saved before shares (`rally.rail-width:<scope>`) is still read, held inside
the same bounds, until the next drag replaces it. A conversation
with no stored width restores at the even split, the same width a click gives. Double-click or `Enter` on the panel's
edge resets it to the even split it opened at; unlike the opening, the reset is
the person's own act, so it is saved as the conversation's width like a drag.

Every draggable edge, the sidebar's and the right panel's, takes the same hit
width, `--resize-hit-size` in `packages/ui/src/styles/app.css`. The sidebar's
is centred on its line. The panel's sits inside the panel and reaches only 2px
over the conversation, so the transcript's
scrollbar beside them stays draggable. A panel holding a live site or a
browser page is the exception: its native view covers the panel's body and
takes the pointer from anything under it, so there the target reaches over
the conversation instead and covers the scrollbar's last few pixels.

The shell records the Canvas and Sidekick routes (`/canvases`, `/canvases/:id`,
`/sidekicks`, `/sidekicks/:id`) as `last-route`, without a query. The root
landing reopens the saved route when it is one of those (`restorableRoute`); a
Canvas or Sidekick that has gone falls back to its section home without a
dialog ([`desktop-shell.md`](desktop-shell.md#the-landing-and-the-routes)). Otherwise,
including a Channel or Thread route saved before the cutover, it opens
`/canvases`.

Each detached artifact window has a local main-process record with resource
identity, version, title, normal bounds, and display ID. Moving or resizing
updates the in-memory record, while closing or quitting writes its last
placement. Closing the window removes it; signing out forcibly closes the
windows and clears their records. Switching Organizations closes the old
windows but retains their placements for a later return. Application quit
preserves them. On
the next signed-in launch the renderer gets the records for that person and
Organization, fetches the current version, and obtains fresh authorized bytes
or a fresh single-use site URL. Main restores the window on its former display
when present and clamps its bounds into the available work area when a monitor
has gone away.

## Invariants

- Local state is a view preference, never permission to read a resource. A
  restored route opens a screen that reads its own subject and shows the
  unavailable state when the reader cannot open it; a detached window gets
  current authorized content from the API before it is created.
- Single-use site URLs and generated preview bytes never enter the window
  registry. Persisting either would reopen stale content or retain a credential.
- A window's state belongs to one person and Organization. Showing another
  account's saved windows would cross the desktop session boundary.
- Closing a detached window removes its record. Quitting the application keeps
  it, so relaunch means restoring windows that were actually open at quit.

## Boundary

The renderer owns navigation and inline layout. Electron main owns native
window placement. The API owns resource visibility and fresh artifact access.
The registry is not synchronized across devices; pinned order remains
server-owned as described in [pinning](pinning.md).

## Failure modes and limits

Unavailable or malformed local storage leaves the corresponding view at its
normal default. A missing route or resource is skipped. A removed monitor uses
the matching available display's work area. A transient API failure leaves a
detached window's record for a later launch; an authorization or not-found
response removes it. There is no separate cap on saved windows: the list is
the windows the person left open.

## Testing

`screens/landing.test.tsx` checks route restoration;
`desktop-layout.test.tsx` checks the unused semantic row hook;
`artifact-window-state.test.ts` checks the local registry and monitor clamp;
`rail-split.test.ts` checks the width a panel opens and restores at, including
a width saved in a narrow window restored in a wide one.
The desktop acceptance check opens, moves, quits, and relaunches real Electron
windows, and checks that rail positions and panels return visibly.

## Changelog

### 2026-11-08 — A panel's width is saved as its share of the pane

**What changed:** A dragged or reset panel width is saved per conversation as
its share of the main pane (`rally.rail-share:<scope>`), and a restored panel
takes that share of the pane it opens in, held between the minimum and the
width that leaves the conversation its minimum. Pixel widths saved before are
still read, inside the same bounds.

**Why:** The owner's answer to the follow-up "a panel width stored from a
narrow window comes back narrow on a wide one" was "do this". The panel opens
at an even split, which is already a share of the pane, so a share keeps a
drag and the documented default in one unit; a drag to half a narrow pane now
means half of any pane.

**Considered and rejected:** Clamping the stored pixels to the pane's current
minimum and maximum on restore. A width stored narrow is already inside a
wide window's bounds, so the clamp would leave exactly the reported panel
narrow. The clamp is kept, as the bound on a share restored into a pane too
small for it.

**What a future change must respect:** anything that saves a panel width
must save it through `setRailWidth`, which measures the pane; a pixel width
written directly is read as the legacy format.

### 2026-11-08 — The panel takes a pane narrower than two conversation minimums, and a closed panel reopens from the Canvas's menus

**What changed:** An open panel fills the pane where the pane, the window less
the sidebar, is narrower than 848px (twice the conversation's 424px), not
narrower than 424 + 280px: below 1264px with the default sidebar (1324px at
its maximum), where it was 1120px. The pane is measured after the sidebar
gives way in a narrow tab. A Canvas's "⋯" and pill menus gained **Open
artifact**.

**Why:** The sidebar's default became the rail plus design.html's 340px list,
416px (desktop-shell.md), which first moved the old rule's crossing from
1044px to 1120px. The second design inspection (v1-R2-3) then found 1180px
still splitting a 764px pane into about 400px of Chat beside a 350px panel
whose artifact pill was clipped at its left edge: the old rule asked only that
the narrowest panel fit beside the Chat's minimum, but a panel opens at half
the pane, so a pane that passed it still opened cramped. Keying on the split
the panel actually opens at fixes that without a new number. v1-R2-4 found no
way back to a panel once closed short of leaving the Canvas; the menu item
reuses the arrival's navigation onto the newest artifact, which already opens
again on each request.

**What a future change must respect:** `railFillsPane` and the shell's
`--av-cmp-sidebar-width` must agree on the pane; change how the sidebar gives
way in one and the other moves with it.

### 2026-11-07 — The landing reopens a Canvas or Sidekick, or the Canvases home

**What changed:** `last-route` is written only for Canvas and Sidekick routes
and either home, and the landing reopens it or opens `/canvases`. The Channel
fallback chain (first pinned Channel, General, A–Z) and the
directory-checked restore are gone, and the Threads and Channels sorts and the
`thread-width` and `breakout-width` keys are no longer read.

**Why:** Plan step B-1 of the
[Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md):
Channels, Threads and Breakouts are deleted, so a saved route naming one has
nothing to reopen, and the pane widths for a thread beside its Channel and a
Breakout beside its thread describe panes that no longer exist. The restore no
longer waits on a directory because the Canvas and Sidekick screens each read
their own subject and show the unavailable state themselves.

**Consequences:** Old keys stay in a device's local storage, unread and
harmless; nothing removes them. A route added to the shell is restored only
once `restorableRoute` admits it.

### 2026-10-18 — A restored panel nobody resized opens at the even split

**What changed:** Arriving at a conversation that had a panel open, or
navigating to one with an artifact request, restores the panel through
`restoreRail`. It uses the conversation's stored width when there is one and
the even split when there is not. Before, it fell to the 320px default.

**Why:** Only a click went through `openRailAtEvenSplit`. Since the split is
never stored, an artifact opened by a click and never dragged came back at
320px on the next visit, narrow enough that a generated site dropped into its
phone layout.

**Consequences:** A stored width still wins on restore, so a person's drag is
kept. Storing the split itself, so restore needed no check, was rejected: it
would make the split look like the person's choice and break the rule that
only a drag or the edge's reset is saved.

### 2026-10-16 — Opening a panel no longer widens the window

**What changed:** Opening the right panel, for an artifact, an attachment,
resource details, the context rail or the embedded browser, leaves the
window's size and position alone. The panel opens at half the main pane. The
`window:set-conversation-details` IPC, `conversation-details-geometry.ts`, and
the saved-state step that subtracted the panel's width are gone. Windows
1180px wide or narrower no longer float the panel over a dimmed conversation:
it sits beside it at every width above phone layout, and the scrim is gone.
A pane too narrow to keep the conversation's minimum beside it gives the
panel the whole pane instead.
Double-click or `Enter` on the panel's edge now resets it to the even split
instead of 320px.

**Why:** Once panels opened at a 50/50 split, the window grew by the
conversation's whole width on every opening, which moved and resized a window
the person had placed. Opening something to read should not rearrange the
desktop. Without that growth the default 1180px window sat on the floating
side of the old breakpoint, so every panel opened as an overlay; the
product's call was that overlays read as dated and the panel belongs beside
the conversation.
The edge's "reset width" jumped to a 320px nobody had seen since panels began
opening at the split, so it now returns to the width the panel opened at.

**Considered and rejected:** Keeping growth for the context and browser rails
while stopping it for artifacts and attachments. The rails share one slot, so
whether the window moved would depend on what last took it.

**Consequences:** The window's geometry belongs to the person alone; nothing
in the renderer can change it. A panel narrows the conversation, so its width
is half the pane rather than the conversation's present width. Bringing
growth back means rebuilding the width bookkeeping that saved state relied on
to avoid storing a panel's width as the person's choice.


### 2026-10-15 — Panels open 50/50, and every edge is equally easy to grab

**What changed:** Attachments and artifacts open their panel at an even split
with the conversation instead of the 320px default, without saving the split
over the dragged width. Closing a panel now also moves the window back to
where it was. The sidebar, the right panel and the split-conversation divider
share one hit width, 14px, through `--resize-hit-size`; they had been 12px,
10px and 8px.

**Why:** At 320px most generated sites fell into their phone layout and a
document read as a narrow column. The panel's target sat inside its edge,
where a live site's composited view takes the pointer, so only the strip
beside the header could be grabbed and it felt like one pixel; the edges had
also drifted apart one by one. Growing the window by the conversation's whole
width, rather than 320px, made the old leftward drift on close large enough to
notice: a default window on a laptop ended pinned to the screen's left edge.

**Considered and rejected:** Splitting evenly only for live sites, and only
when the panel was narrower than the split, was the first version. Every kind
of panel had the same narrow-column problem, and a rule that sometimes kept
the old width made the opening width hard to predict. Saving the split as the
conversation's width was rejected because every opening would then overwrite
the width the person dragged to. Putting every target over the conversation,
as a live site needs, covered the transcript's scrollbar on every panel.

**Consequences:** The renderer predicts how far the main process will grow the
window; a change to `conversation-details-geometry.ts`'s rules has to move
`rail-split.ts` with it. Double-click reset goes to 320px, not the split. A new
draggable edge should take its width from `--resize-hit-size` and keep clear
of a scrollbar beside it.

Shipped in [#1248](https://github.com/juno-ai-labs/avalon/pull/1248).

### 2026-10-10 — Restore Channel routes and the sidebar's section

**What changed:** The saved route is a Channel route or a lone thread; the
landing falls back to a Channel rather than the most recent thread. The
section switcher's choice, the Threads sort and the thread-beside-Channel
width are kept per device. The sidebar's scroll position is no longer
restored.

**Why:** The navigation redesign makes a Channel where Rally opens
([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)).

**Considered and rejected:** Checking a saved thread against the directory
before reopening it, as the old landing did: the thread pane already shows
an unavailable or request-access state, and the check cost a directory walk
before the first paint.

**Consequences:** A saved route to a thread that was archived opens on that
thread's own unavailable screen, one step from its Channel. The semantic
scroll restore was not wired into the new lists, a scope cut to ship the
switch; a list that wants it back calls `useSemanticScroll` with its rows'
ids.

### 2026-09-22 — Restore the local desktop reading layout

**What changed:** Rally now remembers the hierarchy rails, last open view,
per-conversation artifact panel, and detached artifact windows on this device.

**Why:** Relaunching lost the person's place and closed every artifact they
were using, even though native desktop windows normally resume where they were.
Those are presentation choices and should survive a process restart.

**Considered and rejected:** Saving scroll pixels or artifact access URLs.
Pixels shift when rows reorder, while access URLs are single-use credentials.
Stable row and resource identities let the app restore against current authority.

**Consequences:** Restoration may wait for directory or resource authorization.
New layout state should use the same device scope and leave resource validity
to the API rather than treating a saved identifier as proof of access. Review
found that continuous native move events must not synchronously write the
registry, and switching Organizations must shut the former Organization's
windows before the new session is shown.
