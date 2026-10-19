# Pane stack

Rally shows nested AI work as a stack of panes: a Channel, a thread opened from
it, a breakout opened from the thread, and a panel (an artifact, a resource)
opened from either. **Two panes are on screen at most.** Opening something
deeper moves everything one step left, and what leaves the screen rides as a
breadcrumb in the left pane's header, so a person can always step back.

The stack is not a component of its own. It is the two-slot
`SplitConversationLayout` nested once: the Channel screen holds a Channel and
a thread, and the thread screen it holds already held a thread and a breakout
(or a thread and a panel). Each level keeps both its slots mounted, so moving
along the stack neither reconnects a conversation nor loses a scroll or a
draft. See [the navigation PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/ui/src/components/split-conversation.tsx` | `SplitConversationLayout`: two slots, one resize edge, the narrow fallback, and `onShownChange`, which tells a host nesting it whether the right slot stands alone. |
| `apps/desktop/src/renderer/screens/channel.tsx` | `ChannelScreen` and `ChannelStack`: the outer level, a Channel and one of its threads, and the `ChannelPaneContext` the thread reads. |
| `apps/desktop/src/renderer/screens/workstream.tsx` | The inner level: a thread and its breakout or panel. Reports when it uses both its slots, and draws the Channel crumb when the Channel is off screen. |
| `apps/desktop/src/renderer/lib/navigation-routes.ts` | Routes and `ChannelPaneContext`. |
| `apps/desktop/src/renderer/lib/pane-visibility.tsx` | `PaneVisibility`: marks a pane the layout keeps mounted but is not drawing as not visible, so nothing inside it acknowledges a read. |
| `apps/desktop/src/renderer/App.tsx` | One route, `/channels/:channelId/*`, for the Channel with or without a thread, so the Channel pane stays mounted as threads open and close. |

## How it works

The routes are the stack:

| Route | Panes on screen | Breadcrumbs |
| --- | --- | --- |
| `/channels/:c` | Channel | — |
| `/channels/:c/threads/:t` | Channel, thread | — |
| `/channels/:c/artifacts/:r` | Channel, an artifact a merge shared with it | — |
| `/channels/:c/threads/:t?substream=:b` | thread, breakout | Channel |
| …and the breakout opens a panel | breakout, panel | Channel, thread |
| …a thread's panel, expanded | panel | Channel, thread |
| …a breakout's panel, expanded or on a phone | panel | Channel, thread, breakout |
| `/workstreams/:t` (a thread with no Channel the person may see) | thread | — |

`ChannelStack` renders the Channel in the left slot and the thread screen in the
right. The thread screen calls `setThreadUsesTwoPanes(true)` while it has a
breakout or a panel open; the stack then shows only its right slot, and the
thread prepends the Channel's pill (`crumb`) to the ancestors of whichever of
its headers is leftmost. The same happens when the window is too narrow for
two panes: `onShownChange` reports the thread standing alone, and the thread
carries the crumb.

The reader can also ask for it. A thread beside its Channel, and a breakout
beside its thread, has **Expand** and **Collapse** in its header; expanded,
its level draws in `breakout` mode and the pane carries the crumbs as above.
An expansion is held for the pane it was asked on and dropped when that pane
closes or another opens. A thread's expansion is on hold while the thread has
a breakout or a panel open: the two split the window as they would have, and
closing what the thread opened returns to the thread expanded. A breakout's
expansion ends when the breakout opens a panel.

A **panel** is the last level. An artifact or attachment a conversation opens
sits beside it with the same **Expand**; expanded it covers the pane (the shell's
`rail-expanded`, which reuses the narrow window's full-pane rules). While it stands
alone, expanded or in a window too narrow for it beside its conversation
(`railFillsPane`, which every phone width is), its header carries the crumbs
as one `MarkBridge`: the Channel, when it has stepped off, a breakout's thread
(handed down as `parentCrumbs`), and the conversation. That crumb collapses an expanded panel, and closes one that
cannot sit beside, which also offers neither Expand nor Collapse.
There is no lightbox over a panel any more: a full-window
view of an artifact is the panel expanded. `expandToggle`
(`components/pane-expand-toggle.tsx`) draws the control at every level.

Navigation asks for it too, through location state (`OPEN_EXPANDED`), which
every level reads with `usePaneExpansion`. A navigation onto an artifact
(`openThreadResourceState`, from a pinned artifact's row or its Activity row)
is the panel's request: only the requested artifact honours it, and only once,
so an artifact opened afterwards from the transcript comes up beside, the
requested one included once it has been closed. Behind the browser rail the
panel is not on screen, so it is not expanded and its artifact is not seen. The sidebar's Threads and Activity
rows ask for it, so does the root landing when it reopens the saved thread,
and so does a Channel opening one of its threads, from a feed
row or by starting one in its composer: a thread opened from its Channel takes
the whole window, and Collapse puts it beside the Channel. Other links inside a
pane don't ask, so a breakout or a panel opened from a thread comes up beside
it, holding the thread's expansion as above. A request to open a breakout
expanded is the breakout's alone: the Channel level ignores a request whose
route names a `substream`, so the thread keeps what it had, and closing the
breakout returns to it. The landing therefore asks nothing of a saved breakout;
it names it `restoredBreakout`, so a breakout merged or removed since the route
was saved returns its thread to Main, beside the Channel. Only a live breakout
list may say so: the list seeded from the device at launch can predate the
breakout, so a restored breakout it omits stays open.

Each step is drawn as movement, by `SplitConversationLayout` itself so both
levels share it. A pane that opens beside another slides in from the right; a
pane that takes the whole width slides over from where it was (the distance is
measured at the step, `--split-motion-from`); stepping back reverses that. 240ms
on the curve the side panel uses, and nothing under `prefers-reduced-motion`.

Selecting a crumb opens that level and closes everything nested under it.
The Channel crumb opens the Channel alone: the thread, its breakout, and a
panel either holds all close. The thread crumb closes the breakout and
the panel it held, which on a wide window puts the thread back beside its
Channel. The thread's close button, beside the Channel,
returns to the Channel alone. A breakout's close button returns to its thread.

Widths are stored per pair: the thread beside its Channel under
`thread-width`, a breakout beside its thread under `breakout-width`
([`desktop-layout.md`](desktop-layout.md)).

## Invariants

- **Never more than two panes.** A third would bring back the stacked columns
  the 2026-10-01 shell change removed ([`desktop-shell.md`](desktop-shell.md)).
  Guard: each level is a two-slot layout; verified in a real window.
- **Both slots stay mounted.** Unmounting the Channel when a thread opens lost
  its composer draft in the first build of this. Guard: the single
  `/channels/:channelId/*` route; verified in a real window.
- **The crumb is the Channel's, and only when it is off screen.** A crumb for a
  pane on screen is a second way to the same place that looks like a different
  one. With two panes on screen only the left
  one carries crumbs. Guard: `shifted` in `ChannelStack`, and a panel draws
  crumbs only while it stands alone.
- **A hidden pane acknowledges no read.** Both slots stay mounted, so a Channel
  behind its thread or a thread behind its breakout is still rendered. Each is
  wrapped in `PaneVisibility`, which turns the conversation visibility off
  while the layout is not drawing it; without it, a Channel's dot or a
  thread's unread state cleared for something the person never saw. An outer
  host that hides the whole conversation still wins. Guard:
  `lib/pane-visibility.test.tsx`.

## Boundary

This owns which panes show and the breadcrumbs. It does not own what is inside
a pane ([`conversation-surfaces.md`](conversation-surfaces.md)), breakout
creation ([`substream-creation.md`](substream-creation.md)), or the one-right-slot
rule inside a thread ([`desktop-shell.md`](desktop-shell.md#one-right-slot)).

## Failure modes and limits

- **Narrow windows:** below two conversation minimums the right pane stands
  alone, with the crumbs: a breakout alone carries its Channel and its thread,
  each of which `onShownChange` reports at its own level. The crumbs are one
  `MarkBridge` ([`shared-ui.md`](shared-ui.md)) at every width, each mark
  linking where its pill would. Above phone width the nearest crumb's name ends
  in an ellipsis rather than run under the pill, so the pane's own pill keeps
  its room and truncates last; at 640px and below the bridge shows marks
  alone, and past two crumbs folds all but the nearest into a "…" menu
  ([`shared-ui.md`](shared-ui.md)).
- **Collapse in a narrow window** clears the expansion, but the pane still
  stands alone, as it would unexpanded; Collapse then simply goes away.
- **A thread with no visible Channel** opens on `/workstreams/:id`, alone; it
  has nothing to step back to.

## Testing

- `apps/desktop/src/renderer/screens/channel.test.tsx` (a thread opens from
  its Channel's feed expanded and collapses beside it, expands over it and
  collapses back, a breakout holds the expansion until it closes, a sidebar
  open of a breakout leaves the thread as it was, a thread closed while
  expanded reopens beside the Channel, and a sidebar link opens one expanded);
  `workstream-sidebar-switch.test.tsx` (the real header's Expand and Collapse,
  a breakout expanding, collapsing and reopening beside its thread, and one
  the sidebar opened starting expanded) and `lib/navigation-routes.test.ts`.
- `apps/desktop/src/renderer/lib/pane-visibility.test.tsx`: no read is
  acknowledged in a pane the layout is not drawing, and one is once it is.
- `apps/desktop/src/renderer/components/split-conversation.test.tsx`: the two
  slots' minimum widths, both panes kept mounted, the narrow fallback, the
  keyboard resize, and `onShownChange` telling the host whether two panes fit.
- Which panes are visible, and where the crumbs sit, is checked in a real
  window under Xvfb, per [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it).

## Changelog

### 2026-10-19 — A Channel opens an artifact in its own panel

**What changed:** `/channels/:c/artifacts/:r` opens an artifact beside the
Channel's feed, in the same `InspectorRail` resource panel a thread uses,
which now takes the resource from its host (`resource`) when there is no
conversation to look it up in. A Channel merge's embeds open there.

**Why:** A merge now shares its artifacts with the Channel
([`conversation-merge.md`](conversation-merge.md)), and a reader who cannot
open the thread they came from had nowhere to open them: the thread's panel
closes any artifact not attached to that thread.

**Considered and rejected:** A separate artifact window, which shows only
generated artifacts with a preview.

**Consequences:** The panel sits inside the Channel pane, not in the stack's
second slot, so opening a thread replaces it. It claims the shell's rail
(`railScope` `channel:<id>`) while mounted, as a thread's panel does, which is
what makes the shell narrow the Channel beside it. Its Expand, its crumb back
to the Channel and its live artifacts are the thread panel's own:
`usePaneExpansion`, `expandToggle`, `useRailFillsPane` and `useSiteArtifacts`,
which both panels now share. The
route keeps it across a reload, as a thread's does.

### 2026-10-17 — A panel standing alone carries its crumbs, as one glass bridge

A panel drew its crumbs only while expanded, but at phone width, and in any
window too narrow for the panel beside its conversation, it covers the pane
without being expanded, which left a lone artifact header with no way back but
close. The crumbs now follow whether the panel stands alone, not whether it
was asked to expand: `panelFillsPane` reuses the shell's `useRailFillsPane`,
so the header and the `rail-fills-pane` layout read the same rule. There the
conversation crumb closes the panel, since collapsing would change nothing,
and Expand and Collapse are withheld: either would change nothing on screen. Beside its conversation the panel still has none: the
product wants crumbs on the left pane only when two are on screen.

A breakout's panel dropped the thread from that path, since the surface
only knew the Channel's crumb; the thread screen now hands the breakout's
crumbs down as `parentCrumbs`, the same list its own header draws.

### 2026-10-17 — A panel expands like a pane, and the lightbox goes

**What changed:** An artifact or attachment panel has the stack's
Expand/Collapse. Expanded it covers the pane with the Channel and thread as
crumbs; the artifact's pinned row and its Activity row open it that way. The
panel's old Expand, which opened a full-window lightbox over the panel, is gone.

**Why:** Opening an artifact from the sidebar should read like opening a
thread from it: one pane, expanded, with the same control to put it back.
Two ways to see an artifact full-window, a lightbox and an expanded pane,
would be one too many.

**Considered and rejected:** A route of its own for an artifact. It would need
its own link format on the Mac, the web and iOS; the artifact already opens
through its thread's route (`openResource`), which keeps the thread's access
the gate. The lightbox stays only where there is no panel to expand: search
results and the Channel composer's unsent attachments.

**Consequences:** The expansion is held per panel in component state, as a
thread's is, and is not restored after a relaunch. The shell learns of it
through `useUiStore.railExpanded`, set by the surface that owns the rail. A
request now counts once per navigation at every level: before, a pane closed
and opened again under the same navigation came back expanded.

### 2026-10-17 — A saved thread reopens expanded

**What changed:** When the root landing (`screens/workstream-landing.tsx`)
reopens a saved thread under a Channel, on launch or on a navigation to `/`
that carries no state, it asks for it expanded, so it takes the whole window with the Channel as its crumb. A saved breakout route does not
ask: the request would be the breakout's, so its thread keeps what it had.

**Why:** The saved route held only the path, and expansion lives in location
state, so a thread that was last open came back beside its Channel. The product
asked that a thread left open reopen as it opens from a Channel or the sidebar.

**Considered and rejected:** Saving the expansion beside the route. The product
asked for a reopened thread to be expanded every time, not to reopen as it was
left, so there is nothing to save.

### 2026-10-15 — A Channel opens its threads expanded

**What changed:** A thread opened from its Channel's feed, or started from its
composer, opens expanded over the Channel instead of beside it. A breakout or a
panel the thread opens still comes up beside the thread, and now holds the
thread's expansion rather than ending it, so closing it returns to the thread
expanded.

**Why:** The product asked that a thread opened from a Channel take the whole
window, as one opened from the sidebar already did, with the right pane kept
for what the thread itself opens; and that closing a breakout return to the
expanded thread, not to the Channel and thread side by side.

**Considered and rejected:** Making expanded the default mode of the Channel
level. Links inside the thread that open another thread still open it beside
the Channel, and Collapse has to keep working; asking per navigation, as the
sidebar does, changes only the two openings the product named.

Once the hold replaced the clear, a sidebar open of a breakout expanded its
thread too: both levels read the same request, and nothing cleared the
thread's share any more (the bug 7d44124 had fixed by re-reporting two panes
on every request). The Channel level now ignores a request whose route names a
`substream`, which makes that re-report, and the `request` value
`usePaneExpansion` returned for it, dead; both are removed.

**Consequences:** A level that must not take a request meant for the level
below passes `honorsRequest` false to `usePaneExpansion`.

### 2026-10-13 — The sidebar opens a thread or breakout expanded

**What changed:** A thread or breakout opened from the navigation sidebar
(Threads or Activity) opens expanded, with what it covers as crumbs. Links
inside a pane still open beside it.

**Why:** The product asked that a room reached from the sidebar take the whole
window: the reader came for that room, not for the pair.

**Considered and rejected:** Storing the choice in the UI store. The ask is
about how one navigation opens, so it rides on that navigation's location
state, and Back to that entry opens it the same way.

**Consequences:** Expansion is still not stored. Both levels hold it through
one hook, `usePaneExpansion`, so a new level gets the same rules by calling it.

Shipped in #1229.

### 2026-10-13 — A thread can expand over its Channel, a breakout over its thread

**What changed:** The thread beside a Channel, and a breakout beside its
thread, each have Expand and Collapse actions in their header. Expanded, the
pane takes the whole window and what it covered rides as its crumb.

**Why:** The product asked for a way to give the right pane the whole window
without closing the Channel.

**Considered and rejected:** A third layout mode in `SplitConversationLayout`.
Expanded is the same picture as a thread using both its slots, so it reuses
that mode and the crumb that comes with it.

**Consequences:** Expansion is not stored and lasts only while the pane it
was asked on stays open, and only until that pane opens a breakout or a panel: the product
chose the ordinary thread-and-breakout split there over keeping the breakout
full width. The Channel crumb still opens the Channel alone, closing the thread;
Collapse is the way back to the pair.

Shipped in #1213.

### 2026-10-13 — A crumb opens its level and closes what is nested under it

**What changed:** The Channel crumb opens the Channel alone, closing the
thread, its breakout and any panel either holds. It used to step back one
level, to the Channel and the thread. The thread crumb closes the breakout and
any panel, where before it closed only a panel the breakout held.

**Why:** Collapsed crumbs became one bridge of marks, each a link to its
object, and the product asked that selecting one open that object outright.
One rule for every crumb, full or collapsed, is easier to predict than a step
back that depends on what is open. It also drops the narrow-window special
case: the Channel route is the Channel alone at every width.

**Considered and rejected:** Giving the bridge's marks their own destinations
while full pills kept the step back. The same crumb would go to two places
depending on the window's width.

**Consequences:** No crumb returns to the Channel-and-thread pair with
something closed; the breakout's close button and the thread's are the
one-step-back controls. Neither crumb closes a panel itself: each conversation
surface closes its own panel as it unmounts, and a crumb unmounts every surface
nested under its level. `SplitConversationLayout`'s `onNarrowChange`, which
only the old step back read, is removed.

Shipped in #1203.

### 2026-10-10 — A Channel and its thread are the stack's first two panes

**What changed:** The Channel screen nests the existing two-slot layout one
level above the thread screen, and the thread carries the Channel as a
breadcrumb once it needs both of its own slots.

**Why:** The navigation redesign made a Channel a list of threads, opened
beside it ([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)). The
thread screen already did the same thing one level down for breakouts.

**Considered and rejected:** A generic `PaneStack` taking a list of panes. It
would have re-implemented the thread screen's panel slot and breakout creation
pane, and replaced code that works with code that might; nesting reuses both.

**Consequences:** A deeper level (a breakout of a breakout) would need a third
nesting, which the product does not allow. A new kind of pane opened from a
thread belongs in the thread screen's right slot. A crumb's step back depends
on whether two panes fit: the same route draws two panes on a desktop and one
on a phone, so a crumb that names a pane has to open it alone where only one
fits.
