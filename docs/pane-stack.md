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
| `apps/desktop/src/renderer/App.tsx` | One route, `/channels/:channelId/*`, for the Channel with or without a thread, so the Channel pane stays mounted as threads open and close. |

## How it works

The routes are the stack:

| Route | Panes on screen | Breadcrumbs |
| --- | --- | --- |
| `/channels/:c` | Channel | — |
| `/channels/:c/threads/:t` | Channel, thread | — |
| `/channels/:c/threads/:t?substream=:b` | thread, breakout | Channel |
| …and the breakout opens a panel | breakout, panel | Channel, thread |
| `/workstreams/:t` (a thread with no Channel the person may see) | thread | — |

`ChannelStack` renders the Channel in the left slot and the thread screen in the
right. The thread screen calls `setThreadUsesTwoPanes(true)` while it has a
breakout or a panel open; the stack then shows only its right slot, and the
thread prepends the Channel's pill (`crumb`) to the ancestors of whichever of
its headers is leftmost. The same happens when the window is too narrow for
two panes: `onShownChange` reports the thread standing alone, and the thread
carries the crumb.

Selecting the Channel crumb goes back one step: to the Channel and the thread,
whatever the thread had open. The thread's close button, beside the Channel,
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
  one. Guard: `shifted` in `ChannelStack`.

## Boundary

This owns which panes show and the breadcrumbs. It does not own what is inside
a pane ([`conversation-surfaces.md`](conversation-surfaces.md)), breakout
creation ([`substream-creation.md`](substream-creation.md)), or the one-right-slot
rule inside a thread ([`desktop-shell.md`](desktop-shell.md#one-right-slot)).

## Failure modes and limits

- **Narrow windows:** below two conversation minimums the right pane stands
  alone, with the crumbs: a breakout alone carries its Channel and its thread,
  each of which `onShownChange` reports at its own level. Below 460px a
  pane's header (`@container conversation-pane`) shows the crumbs as marks
  only, so the pane's own pill keeps its room and truncates last.
- **A thread with no visible Channel** opens on `/workstreams/:id`, alone; it
  has nothing to step back to.

## Testing

- `apps/desktop/src/renderer/screens/channel.test.tsx` (a thread opens beside
  the Channel) and `lib/navigation-routes.test.ts`.
- Which panes are visible, and where the crumbs sit, is checked in a real
  window under Xvfb, per [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it).

## Changelog

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
thread belongs in the thread screen's right slot.
