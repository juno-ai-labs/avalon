# Desktop and web shell

The shell is everything around a conversation's feed: the one navigation
sidebar, the floating title pills and their menus, and the split that puts a
Channel and its open Breakout side by side. The Electron client and the browser
web app draw it from the same shared components in `packages/ui`. Each host
owns its routing, data and authority; the shared pieces own only shape.

Read this before changing the sidebar's geometry, the Space pills, what a
Channel row shows, either title menu, how a Breakout opens, or who owns the
right panel.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/ui/src/components/resizable-sidebar.tsx` | `ResizableSidebar`. The shell passes `collapsible={false}`: the edge resizes between `MIN_SIDEBAR_WIDTH` and `MAX_SIDEBAR_WIDTH` and never collapses. |
| `packages/ui/src/components/space-pills.tsx` | `SidebarTopActions` (the round buttons beside the window controls), `SpacePillStrip`, `SpacePill`, `SpacePillAddButton`. |
| `packages/ui/src/components/navigation.tsx` | `ChannelRowContent`: glyph, title, time, Space subtitle, activity dot. |
| `packages/ui/src/components/title-pill.tsx` | `TitlePill`, `TitlePillHeader` (ancestors left, current centred, trailing right), the menu building blocks, `TitlePillClose`. |
| `packages/ui/src/components/conversation-menus.tsx` | `ChannelMenu` and `BreakoutMenu`: everything the deleted Channel sidebar held, as title-pill menus. Also `ConversationRowActions` and `PENDING_SUBSTREAM_DRAFT_ID`. |
| `packages/ui/src/components/breakout-marks.tsx` | `BreakoutMark`, `breakoutsByOrigin`, `orderBreakoutsForTicks`, `breakoutHasActivity`, `BreakoutChipRow`, `BreakoutTickBar`. |
| `packages/ui/src/components/split-conversation.tsx` | `SplitConversationLayout`, `SplitConversationMode`, `clampBreakoutWidth`. |
| `packages/ui/src/styles/app.css` | The "Single sidebar", "Title pills", "Breakouts in the Channel" and "Split conversation" blocks. |
| `apps/desktop/src/renderer/components/sidebar.tsx` | The desktop sidebar: top actions, the All filter, pins under All (`allPinPosition`), rows. |
| `apps/desktop/src/renderer/components/space-pills.tsx` | Desktop pills: A–Z order, drop a Channel on a Space, archive, restore. |
| `apps/desktop/src/renderer/screens/workstream.tsx` | The Channel screen: both panes, both pills, the one-slot rule, Breakout creation in the right pane. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | One conversation. Draws chips and ticks for Main, owns its right panel by conversation, honours a scroll-to-turn request. |
| `apps/desktop/src/renderer/lib/browser-rail-links.ts` | Routes a clicked web link to the pane it was clicked in. |
| `apps/browser/src/conversation.tsx`, `apps/browser/src/sidebar-layout.ts` | The web app's sidebar and split screen over the shared navigation directory. |

## How it works

### The sidebar

One `ResizableSidebar` on the left, at the width in `useUiStore.sidebarWidth`
(`rally.sidebar-width`; 340px, `SINGLE_SIDEBAR_DEFAULT_WIDTH`, until the person
drags it), clamped to the shared minimum and maximum and to what
the window leaves the conversation. Dragging below the minimum stops there.

Its top bar holds the macOS window controls' inset and the host's actions. The
desktop has four: **Restart to update** (only when `useDownloadedUpdate` has
one), **Search organization**, **Import from ChatGPT or Claude** (the browser
import window, locked to the selected Space), and **New channel** (the Start a
new channel form, opened directly with `NewWorkstreamMenu trigger="direct"`).
The web app has none of them; the Mac download link sits above its account
menu.

Under it, the Space pills, whose row fades at whichever edge has pills scrolled past it (the app's scroll-edge fade, on the inline axis). The round **New space** button, a folder with a plus, leads, and its
right-click offers **Restore archived space**. Then **All**, then each Space by
name, case-insensitive A to Z (`compareAlphabeticalName`). Pills cannot be
reordered by drag or keyboard; dragging a Channel onto a pill still places it
in that Space. **General has no pill.** It is where a Channel lives
when nobody put it in a Space, and All already shows it. A pill filters the
list below and does not navigate; **Open space** is on its right-click menu and
in the Channel menu. The desktop remembers the filter per device
(`useUiStore.sidebarSpaceFilter`, `rally.sidebar-space-filter`). Opening a
Channel the filter would hide widens the list to All.

The list is **Pinned**, then every other Channel, A to Z by default. With pins
above it the rest is headed **Channels**, and each heading carries a quiet hint
at its far edge (*Drag to reorder* when there are pins to reorder; the sort
toggle on **Channels**); with no pins the list stands alone and has no heading.
The toggle, the current label followed by an `arrows-sort` icon (last, so the
icon stays put when the label changes width), cycles the
unpinned Channels through **A–Z** (case-insensitive, `compareAlphabeticalTitle`),
**Recent** (newest `lastActivityAt` first, ties A to Z) and **Needs you** (every
Channel with something for this reader first, then the rest, each half in
Recent order). "Something for this reader" is `workstreamHasActivityForViewer`,
the same input that makes a row's title bold: unread, or a Breakout (or Main)
that needs them. The desktop
remembers the choice per device (`useUiStore.sidebarChannelSort`,
`rally.sidebar-channel-sort`), and it still applies while the heading is
hidden. A row shows the glyph,
the title and the last activity time. Under them it shows the names of the
Channel's Spaces, without General; a Channel only in General has a one-line
row. An unread row has a semibold title and its dot is red; the weight follows the
same input as the dot, so a Channel whose Breakout needs this reader is bold
too. A Channel with a scheduled run shows a small clock on the second line,
under the time. A public Channel has no
badge on its glyph; the row's description says so. One dot at the leading edge
shows the ranked marker from
[`workstream-markers.md`](workstream-markers.md), with `completed` left out. A
Breakout needing this reader counts as unread on its Channel. The dot replaced
the numeric badge.

### Pins under All

A pin belongs to one placement, and the server keeps one ordered run per Space
([`workstream-pinning.md`](workstream-pinning.md)). All has no run of its own,
so its Pinned section shows every Channel pinned in any Space: General's run
first, then the rest by their first pin (`allPinPosition`).

- **Pinning under All** writes to General when the Channel is there, and
  otherwise to its first Space.
- **Unpinning under All** clears every Space that pins the Channel.
- **Drag reorder under All** works only while every pinned row is a General
  pin, because only then is the section one run.

### Title pills

Every conversation pane's header is a `TitlePillHeader`: its own pill centred,
the pane's controls at the right, and ancestors stacked at the left. A
Channel pill's icon is its appearance picker; the rest of the pill opens its
menu, and its chevron points right while a Breakout is open beside it. A
Breakout pill wears the breakout arrow (`BreakoutPillIcon`) and, once its
whole history is loaded, its reply count (`ConversationHeaderContext.replyCount`,
one per turn of what people and Rally said); its own icon and colour are chosen
from **Icon and color** in its menu (`AppearanceSubmenu`). An open pill fills
solid and drops its lift to the bare ring.

Each menu has a root and levels. The root is a header, a row of action tiles
(Add people, Rename, Copy link, Share, More) and one row each for People,
Sidekicks and, on a Channel, Breakouts, with a count beside each. A row, or the
Add people and More tiles, opens its level in place (`useTitleMenuNav`), and the
pill becomes a breadcrumb, the title quietened and the level after it. The
title, Escape or the left arrow step back to the root before anything closes,
and the menu always reopens at its root. `TitleMenuMorph` measures each level
and travels the popout's width and height between them over 320ms while the
level's rows arrive on a 22ms stagger, sliding in from the side the move came
from; reduced motion turns both off.

- **Channel menu:** root header is the Space it lives in (with **Open space**)
  and Archive is under the rows. People is the scope (with **Change**, which
  opens the full roster dialog), a search, the participants and suggestions
  to add inline (`TitleMenuPeople`). Sidekicks is the Sidekick section. Breakouts
  is the list, newest activity first, filtered past six. More is **Pinned in
  sidebar** (the sidebar's own pin action, lent through `useUiStore.pinChannel`),
  Make public, Import updates, host extras and the Channel's artifacts.
- **Breakout menu:** root header is the Channel it belongs to (with **Show in
  channel**) and the message it started from. People and Sidekicks as above;
  More is Icon and color and Make public.

### Breakouts

A Breakout is still created only from a message. Under Rally's newest reply
the action is a visible line, **Start a breakout from this message**; on every
other message it is **New breakout** among the actions that appear on hover. Its launch surface opens in the right pane: a second Main surface
with `paneKey="launch"`, so it owns its own panel scope. Once created, the
route's `?substream=` names it and it opens in the right pane beside Main. The
route contract is unchanged: deep links, the restored last route and search
hits land in the pane.

Each Breakout row the Channel receives carries `originTurnId` and
`lastActivityAt` ([`hosted-conversation-parents.md`](hosted-conversation-parents.md)).

- **Origin card:** the top of a Breakout's feed shows the Channel message it
  started from as a card, with up to three messages before it, each a step
  fainter the further back (`BreakoutOrigin`). It reads the Channel's own
  transcript cache, so it draws only when the origin is loaded there, and only
  above the Breakout's first message, never above a window with earlier pages.
- **Chips:** `MessageFeed` draws a chip row after the last row of each origin
  turn. A chip shows the title, "N new" when there is news, and "Open" with an
  accent ring when it is the open Breakout.
- **Tick bar:** down Main's leading edge, one tick per Breakout, in origin-turn
  order for turns that are loaded and by creation time after them. Colour says
  news and length says open, at the design's sizes: a quiet tick is 11×2 grey,
  one with news 20×3 in `sys.color.workstream.news`, and the open one 26×4.
  Hovering a tick names it; pressing it opens the Breakout and scrolls Main to
  the origin.
- **Show in channel:** the Breakout menu sends Main a `scrollToTurn` request,
  which waits until that turn is in the loaded transcript.

### One right slot

The right panel (an artifact, or the desktop's embedded browser) and the
Breakout pane share one place. `ConversationSurface` scopes the panel to the
conversation that opened it: `railScope` is the parent id for Main and
`parentId:substreamId` for a Breakout, with `#launch` for the launch surface. A
surface only closes, fades or restores a panel it owns.
`SplitConversationLayout` reads the scope:

| State | Panes |
| --- | --- |
| No Breakout open | `main` |
| Breakout open, no panel | `split`: Channel, resize edge, Breakout |
| Breakout opened a panel | `breakout`: the Breakout takes the Channel's place, the panel takes the right |
| Channel opened a panel | `main`: the Breakout is hidden |
| Reader cannot open Main | `breakout`, always, and no Channel pill is stacked: a Breakout grant says nothing about Main |

A hidden pane stays mounted, so returning to the split neither reconnects nor
loses scroll. When the Breakout has the Channel's place, the Channel's pill
stacks at the left of the Breakout's header, and pressing its title closes the
panel to return to the split. Opening a Breakout while the Channel holds a
panel closes that panel first. The split's width is device-local under
`layoutKey(…, 'breakout-width')` and clamps both panes to the conversation
minimum. A split too narrow for two minimums (under 848px of content) shows
the Breakout alone instead, measured by `SplitConversationLayout` itself; its
close button returns to the Channel.

### Web links

`useBrowserRailLinks` registers one host per surface, with that surface's
element. A single document listener routes a click to the host whose element
contains the anchor, and otherwise to the newest host, so a link opens in the
panel of the pane it was clicked in, once.

## Invariants

- **General is never a pill and never a subtitle.** If it is drawn as a place,
  every Channel that was never placed reads as placed somewhere. Guard:
  component tests in `components/sidebar.test.tsx`.
- **A surface touches only the panel scope it owns.** Two surfaces of one
  Channel are mounted at once; one that closed the panel unconditionally would
  close the other's on unmount. Guard: verified visually; the scope comparison
  is in each close path of `conversation-surface.tsx`.
- **One link listener, however many hosts.** Two listeners open a link twice,
  as two browser tabs. Guard: `lib/browser-rail-links.test.ts`.
- **Main's search target and the Breakout's are exclusive.** When `?substream=`
  names a Breakout, Main does not honour `?turn=&sequence=`, which only ever
  names a turn in the open Breakout. Guard: `honorsSearchTarget`, verified by
  route behaviour.
- **The sidebar never collapses.** Nothing may write a collapsed width or hide
  the pills; the icon rail and its storage keys are gone. Guard: the
  `collapsible={false}` prop; no toggle exists to call.

## Boundary

The shell owns layout, navigation chrome and which pane is shown. It does not
own:

- pin authority ([`workstream-pinning.md`](workstream-pinning.md));
- the marker ranking ([`workstream-markers.md`](workstream-markers.md));
- Breakout creation and its row actions ([`substream-creation.md`](substream-creation.md));
- the feed, composer and panels inside a pane ([`conversation-surfaces.md`](conversation-surfaces.md));
- what the desktop restores after relaunch ([`desktop-layout.md`](desktop-layout.md)).

The web app reads each Breakout's `originTurnId` and each Space's `systemRole`
from the shared navigation directory.

## Failure modes and limits

- **No `originTurnId`:** a Breakout made before origins were recorded, or a
  server older than the field, has no chip. Its tick sorts after the placed
  ones, and it stays reachable from the Channel menu.
- **Origin turn not loaded:** the chip draws once the page holding the turn
  loads. Show in channel waits for it rather than fetching the range.
- **Breakout list not answered yet:** the Channel menu says "Loading
  breakouts…", and there are no chips or ticks.
- **Display counts:** the Channel menu lists six Breakouts before "Show N
  more", and the filter field appears past six. These are display choices, not
  limits.

## Testing

- **Desktop component tests:** `components/sidebar.test.tsx`,
  `components/space-pills.test.tsx`, `components/message-feed.test.tsx`,
  `components/breakout-marks.test.tsx`, `lib/browser-rail-links.test.ts`. Run
  with `pnpm --filter @rally/desktop exec vitest run <path>`.
- **Web layout math:** `apps/browser/test/sidebar-layout.test.ts`.
- **API side of the origin fields:**
  `apps/api/test-workers/substream-creation-runtime.test.ts`.
- **Window behaviour:** whether panes, pills and ticks are visible and placed
  correctly is checked in a real window under Xvfb, per
  [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it).

## Changelog

### 2026-10-02 — Channels sort toggle: A–Z, Recent, or Needs you

**What changed:** The **Channels** heading's *A–Z* hint became a button with an
`arrows-sort` icon that cycles the unpinned list through A to Z, most recent
activity, and Needs you (bold rows first, then the rest, each newest first).
The choice is a per-device preference in `localStorage`. Needs you reads the
same `workstreamHasActivityForViewer` the row's bold title does, so a row
cannot sort as needing the reader while drawn as read, or the reverse.

**Why:** Product asked for a way to see the Channels that moved last without
pinning them, and for the choice to survive a restart.

**Considered and rejected:** Ordering Recent by `workstreamRecencyAt`, which
prefers when this reader last opened the Channel. The ask was most recent
update, and the row's time already shows `lastActivityAt`, so ordering by it
keeps the list and its times in agreement. Storing the choice on the server
was also out: the ask was a local preference.

**Consequences:** The toggle lives in the heading, which only shows when
something is pinned; without pins the stored order still applies but cannot be
changed from the sidebar. Showing the control without pins means giving the
lone list a heading, which this document deliberately avoids.

### 2026-10-02 — Space pills sort A to Z

**What changed:** The Space pills lost drag and `Alt`+`Arrow` reordering. All
leads, then every Space sorts by name, case-insensitive, through the same
collator the Channel list uses. The placement and creation pickers follow the
same order, so General now sorts among them by name rather than sitting in its
stored place, and the Start a new channel picker defaults to the first Space
alphabetically.

**Why:** Product asked for a fixed, predictable order. A hand-arranged strip
cost a drag gesture that competed with clicking a pill and with dropping a
Channel on one, plus an optimistic-preview path shared across four surfaces.

**Considered and rejected:** Deleting the `organization` order from the server
and the socket payload. Shipped desktops still parse and send it, so removing
it needs a coordinated cutover for no gain to this change.

**Consequences:** The server still stores and serves the `organization`
container order, and `PUT /workspace/order` still accepts it; the desktop just
no longer reads or writes it. Bringing hand ordering back is a client change
only.

Shipped in #1061.

### 2026-10-01 — One sidebar, title pills, and Breakouts beside their Channel

**What changed:** The Spaces rail, the Channels rail and the per-Channel
Breakout rail became one non-collapsing sidebar with Space pills, four top
actions and a new row. Each conversation's header became a floating title pill
whose menu holds what the Channel rail held. A Breakout opens in a right pane
beside Main, shows as a chip under the message it came from, and has a tick on
Main's edge. The right slot is shared by the Breakout and any panel by the
rule above. The web app moved to the same components.

**Why:** Three nested rails spent most of the window on navigation, and opening
a Breakout replaced the Channel it came from. That cut the thread of the
conversation at exactly the moment someone branched from it, and nothing in the
feed said where a Breakout had started. Putting the two side by side, and
marking the origin message, keeps both in view. General is hidden because it
is the absence of a choice, and showing it as a place made every unplaced
Channel look placed.

**Considered and rejected:**
- **Keep the Breakout list in a rail.** It would keep a third column for
  navigation that the chips, ticks and the Channel menu now cover.
- **Pin under All as General's run only.** A pin needs a placement, so
  Channels outside General could not be pinned from All at all.
- **One panel scope per Channel.** With two surfaces of one Channel mounted,
  either could close or fade the other's panel.

**Consequences:**
- Anything that opens, closes or reads the right panel inside a surface must go
  through that surface's scope.
- A new pane-level control belongs in a title menu, not a header row.
- A Breakout's reply count is derived from its loaded history, so it appears
  only on its own title pill once that history is fully loaded; showing it
  anywhere else (a chip, a tick, the Channel menu) needs a counted field on the
  Breakout row.
