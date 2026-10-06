# Desktop and web shell

The shell is everything around a conversation's feed: the one navigation
sidebar, the floating title pills and their menus, and the split that puts a
Channel and its open Breakout side by side. The Electron client and the browser
web app mount the same shell, the desktop renderer's `WorkspaceApp`, for
members and guests alike; each host supplies its session and its native
services. What differs by host or by guest is read from `useShellCapabilities()`.

Read this before changing the sidebar's geometry, the Space pills, what a
Channel row shows, either title menu, how a Breakout opens, or who owns the
right panel.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/ui/src/components/resizable-sidebar.tsx` | `ResizableSidebar`. The shell passes `collapsible={false}`: the edge resizes between `MIN_SIDEBAR_WIDTH` and `MAX_SIDEBAR_WIDTH` and never collapses. |
| `packages/ui/src/components/space-pills.tsx` | `SidebarTopActions` (the round buttons beside the window controls), `SpacePillStrip`, `SpacePill`, `SpacePillAddButton`, `SpacePillIconButton` (the 28px mark New space is built on). |
| `packages/ui/src/components/navigation.tsx` | `ChannelRowContent`: glyph, title, time, Space subtitle, activity dot. |
| `packages/ui/src/components/title-pill.tsx` | `TitlePill`, `TitlePillHeader` (ancestors left, current centred, trailing right), the menu building blocks, `TitlePillClose`. |
| `packages/ui/src/components/conversation-menus.tsx` | `ChannelMenu` and `BreakoutMenu`: everything the deleted Channel sidebar held, as title-pill menus. Also `ConversationRowActions` and `PENDING_SUBSTREAM_DRAFT_ID`. |
| `packages/ui/src/components/breakout-marks.tsx` | `BreakoutMark`, `breakoutsByOrigin`, `orderBreakoutsForTicks`, `breakoutHasActivity`, `BreakoutChipRow`, `BreakoutTickBar`. |
| `packages/ui/src/components/split-conversation.tsx` | `SplitConversationLayout`, `SplitConversationMode`, `clampBreakoutWidth`. |
| `packages/ui/src/styles/app.css` | The "Single sidebar", "Title pills", "Breakouts in the Channel" and "Split conversation" blocks. |
| `apps/desktop/src/renderer/components/sidebar.tsx` | The desktop sidebar: top actions, the All filter, pins under All (`allPinPosition`), rows. |
| `apps/desktop/src/renderer/components/space-pills.tsx` | Desktop pills: A–Z order, drop a Channel on a Space, archive, restore. |
| `apps/desktop/src/renderer/lib/space-choices.ts` | `useSpaceChoices`: Space picker order and labels, General first as All, then A–Z. |
| `apps/desktop/src/renderer/screens/workstream.tsx` | The Channel screen: both panes, both pills, the one-slot rule, Breakout creation in the right pane. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | One conversation. Draws chips and ticks for Main, owns its right panel by conversation, honours a scroll-to-turn request. |
| `apps/desktop/src/renderer/lib/browser-rail-links.ts` | Routes a clicked web link to the pane it was clicked in. |
| `apps/browser/src/shell.tsx` | The web app: this shell over the browser's cookie session ([`browser-client.md`](browser-client.md#the-shell)). |

## How it works

### The sidebar

One `ResizableSidebar` on the left, at the width in `useUiStore.sidebarWidth`
(`rally.sidebar-width`; 340px, `SINGLE_SIDEBAR_DEFAULT_WIDTH`, until the person
drags it), clamped to the shared minimum and maximum and to what
the window leaves the conversation. Dragging below the minimum stops there.

Its top bar holds the macOS window controls' inset and the host's actions. The
desktop's are **Restart to update** (only when `useDownloadedUpdate` has
one), the **attention menu** (a red count, or a bell when nothing is waiting;
[`attention-menu.md`](attention-menu.md)), **Search organization**, **Import from ChatGPT or Claude** (the browser
import window, locked to the selected Space), and **New channel** (the Start a
new channel form, opened directly with `NewWorkstreamMenu trigger="direct"`).
In a browser tab the import is absent (it needs the native import window). A guest's bar has no search
and no **New channel**: their sidebar is read-only and filled from the
shared-navigation directory.

Under it, the Space pills, whose row fades at whichever edge has pills scrolled past it (the app's scroll-edge fade, on the inline axis). The round **New space** button, a folder with a plus, leads, and its
right-click offers **Restore archived space**. Then **All**, then each Space by
name, case-insensitive A to Z (`compareAlphabeticalName`). Pills cannot be
reordered by drag or keyboard; dragging a Channel onto a pill still places it
in that Space. **General has no pill.** It is where a Channel lives
when nobody put it in a Space, and All already shows it. A pill filters the
list below and navigates only when it hides the open Channel (see below);
**Open space** is on its right-click menu and
in the Channel menu. The desktop remembers the filter per device
(`useUiStore.sidebarSpaceFilter`, `rally.sidebar-space-filter`). Opening a
Channel the filter would hide, or moving the open Channel out of the filtered
Space, widens the list to All. Picking a pill that hides the open Channel
filters as asked and opens the first Channel the filtered list draws, or the
Space's dashboard when it holds none. Restoring an archived Space selects its
pill the same way, so it can navigate too.

Every Space picker (**Start a new channel**, the import window, **Add to
space**) reads its list through `useSpaceChoices`: General first and named **All**,
matching the first pill, then the rest A to Z. A picker starts on its first
choice, so a new Channel goes to All unless the reader picks a Space or the
sidebar is filtered to one.

The list is **Pinned**, then every other Channel, A to Z by default. The rest
is headed **Channels** whenever it has rows, pinned or not, because that heading
carries the sort toggle; **Pinned** carries a quiet *Drag to reorder* hint when
there are pins to reorder.
The toggle cycles the unpinned Channels through **A–Z** (case-insensitive),
**Recent** (newest `lastActivityAt` first) and **Needs you** (bold rows first,
then the rest, each newest first). Needs you reads
`workstreamHasActivityForViewer`, the same input as the bold title; a Channel
opened while bold stays in the bold half until the reader opens another, so
reading it does not move it out from under the pointer. The choice
is per device, in `rally.sidebar-channel-sort`. A row shows the glyph,
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

At the bottom, below the list and above the line over the account menu, sit
the sidebar's **footer items**: rows the host passes as `footerItems`, drawn by
`SidebarFooterItems` from `@rally/ui`. They stay on screen however long the
list is, since they are outside its scroll, and each is a `SidebarRow`, so a
compact rail collapses it to a tile like a Space row. Today the one item is
**Download the Mac app**, which `AppShell` passes whenever the host is a
browser tab, for members and guests alike; the Mac app passes none and draws
nothing there. Tips or tutorials go here too.

### At phone width

At 640px and narrower the sidebar becomes a 56px top bar over the
conversation: the **menu button** (tabler `menu-2`) at its left, the round top
actions at its right. Everything else in the sidebar (pills, list, footer
items, account) is a full-screen sheet under the bar. The menu button toggles
`useUiStore.sidebarOpen`; the sheet drops in and out with a clip over 260ms,
and reduced motion cuts it. Any route change closes it, whoever navigated (a
row, a search result, the New channel form, a pill that had to leave the open
Channel), as do Escape, the button, and widening past 640px. Picking a pill
that only filters, or re-sorting, does not, since the reader is still
choosing. While it is open, `AppShell` makes `.main-pane` `inert`, so Tab and
a screen reader stay in the sheet, and Escape hands focus back to the button.
Escape is heard in the capture phase and stands down while a menu or dialog
is open, so it closes that first; a tooltip does not count, though Radix marks
its Escape handled.

It is CSS on the same `<aside>`: a `clip-path` hides all but the bar, and
also stops taps on the closed sheet; `visibility` keeps the sheet out of the
tab order once the close finishes. `SidebarTopActions` takes the button
through its `leading` slot. Electron's window has an 860px minimum, so only
the browser reaches this width. `PHONE_LAYOUT_MAX_WIDTH` in `sidebar.tsx`
repeats the CSS's 640.

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

- **Channel menu:** root header is the Space it lives in (with **Open space**). People is the scope (with **Change**, which
  opens the full roster dialog), a search, the participants and suggestions
  to add inline (`TitleMenuPeople`). Each participant's dots menu offers
  **Remove from channel**, or **Leave the channel** on the reader's own row,
  disabled for the last participant; the host confirms in a Cancel/Continue
  dialog before it removes. Sidekicks is the Sidekick section. Breakouts
  is the list, newest activity first, filtered past six. More is **Pinned in
  my sidebar** (the sidebar's own pin action, lent through `useUiStore.pinChannel`),
  **Public to organization** (a switch both ways; a refusal to make it private
  names what holds it public), Import updates, host extras, the Channel's artifacts, and
  **Archive channel** last.
- **Breakout menu:** root header is the Channel it belongs to (with **Show in
  channel**) and the message it started from. People and Sidekicks as above;
  More is Icon and color, **Public to organization**, and **Archive breakout** last.

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
  the origin. At phone width (640px and narrower) the bar is hidden, since it
  would sit on the text, and the transcript keeps even 24px side padding.
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
  `collapsible={false}` prop; no toggle exists to call. At phone width the
  sheet hides the pills and list behind the menu button; that is a different
  layout, not a collapse, and writes no width.

## Boundary

The shell owns layout, navigation chrome and which pane is shown. It does not
own:

- pin authority ([`workstream-pinning.md`](workstream-pinning.md));
- the marker ranking ([`workstream-markers.md`](workstream-markers.md));
- Breakout creation and its row actions ([`substream-creation.md`](substream-creation.md));
- the feed, composer and panels inside a pane ([`conversation-surfaces.md`](conversation-surfaces.md));
- what the desktop restores after relaunch ([`desktop-layout.md`](desktop-layout.md)).

A guest's sidebar reads each Breakout's `originTurnId` and each Space's
`systemRole` from the same socket lists a member's does
([`listing-rules.md`](listing-rules.md)).

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
- **A guest in the shell:** `lib/browser-collaboration.test.tsx`.
- **API side of the origin fields:**
  `apps/api/test-workers/substream-creation-runtime.test.ts`.
- **Window behaviour:** whether panes, pills and ticks are visible and placed
  correctly is checked in a real window under Xvfb, per
  [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it).

## Changelog

### 2026-10-06 — No tick bar at phone width

**What changed:** At 640px and narrower the tick bar is hidden and the
transcript's left padding drops from 48px to the 24px its right side has.

**Why:** A 40px bar starting 12px in cannot sit in a 24px gutter without
covering text, and the 48px gutter it needed left the phone transcript
off-centre.

**Considered and rejected:** A 48px gutter on both sides. It costs 48px of a
390px screen for a bar that chips and the Channel menu already cover.

**Consequences:** On a phone, chips and the Channel menu are the only ways to a
Breakout.

Shipped in [#1116](https://github.com/juno-ai-labs/avalon/pull/1116).

### 2026-10-06 — People can be removed from the title menu

**What changed:** Each participant row in the People level carries a dots
menu with one danger action, Remove from channel/breakout, worded as Leave for
the reader. `TitleMenuPeople.onRemove` hands the person to the host, which
asks in `RemoveParticipantDialog` and then runs the same remove mutation the
roster dialog uses.

**Why:** Removing someone, or leaving, needed the full roster dialog behind
**Change**. The confirm lives in the host rather than the menu because the
menu closes as the dialog takes focus, and state kept inside it would unmount
with it.

### 2026-10-06 — The sidebar is a top bar and sheet at phone width

**What changed:** At 640px and narrower the sidebar's top bar spans the
screen with a `menu-2` button at its left and the round actions at its
right, and the rest of the sidebar is a sheet that button drops in and out.
`SidebarTopActions` gained a `leading` slot. The unused fixed
`mobile-sidebar-trigger` button and its scrim, hidden by CSS at every width,
are gone.

**Why:** On a phone the 340px sidebar left no room for the conversation, and
the web app had no way to reach a phone-sized layout.

**Considered and rejected:** A separate mobile header holding copies of the
actions. Two attention menus and two New channel dialogs would need keeping
in step, so the bar stays the sidebar's own and CSS changes its shape. A
slide-in drawer from the left was also rejected: the aside holds the bar, so a
transform would move the bar too.

**Consequences:** A future change that moves the top actions out of the aside
has to bring the sheet's open state with them. `sidebarOpen` now means "the
pane is inert", so anything that sets it has to be at phone width; the sheet
closes itself on widening and on every route change to keep that true.

### 2026-10-05 — The Space strip has no Refresh

**What changed:** The round **Refresh** that appeared when the Organization
socket was `unavailable` is gone, along with `spacesOutOfDate`,
`onRetrySpaces` and the workspace socket's `reconnect`.

**Why:** The socket is `unavailable` only when offline, which reconnects on
its own, or when closed for good, where `reconnect` was a no-op, so the button
never recovered anything. The close that made it appear after opening a Channel
is fixed at its source; see the 2026-10-05 entry in
[`workstream-durable-object.md`](workstream-durable-object.md#changelog).

**Considered and rejected:** Making the button clear `permanentlyClosed`. A
revoked or inactive session needs access or a sign-in, not a retry, and an
invalid frame would be sent again.

**Consequences:** A stale Space directory has no manual recovery in the strip.
If one is needed later, it needs a socket state it can actually recover from.

Shipped in [#1093](https://github.com/juno-ai-labs/avalon/pull/1093).

### 2026-10-04 — Stale-directory refresh stays a 28px pill

**What changed:** When the Space directory is out of date, the strip now shows
a round **Refresh** control the same 28px as **New space**, in the leading slot
that does not scroll. The 54px `SidebarRefreshRow` is gone from this strip.

**Why:** Opening a Channel can mark the organization socket unavailable, which
painted the list-row refresh between **New space** and **All**. A 54px row in a
28px strip dropped the pills off the titlebar. Quit and reopen looked fine
because the socket was connected and the row was not mounted.

**Considered and rejected:** Clipping a still-present list row, which would
leave a 54px-wide flex item shoving **All** aside. Putting Refresh in the
titlebar next to Search, which would bury a directory recovery action among
window actions.

**Consequences:** A recovery control in this strip has to be a 28px
`space-pill-add` mark. `SidebarRefreshRow` stays the right control for an
actual navigation list, such as Sidekicks.

Shipped in #1090.

### 2026-10-03 — Footer items above the account menu

**What changed:** The sidebar takes `footerItems`, rows drawn above the line
over the account menu and outside the scrolling list. The browser's
**Download the Mac app** is its first user, passed by `AppShell` when the host
is a browser tab, so members and guests both always see it.

**Why:** Product wants the download always on screen in the browser, and
expects tips or tutorials in the same place. On `main` the browser drew the
download itself (`apps/browser/src/mac-download.tsx`), in the guest shell's
own sidebar only, so members never saw it; with every browser user now in the
desktop sidebar, it needed a place there that later items can share.

**Considered and rejected:** Putting the rows inside the scrolling list,
which hides them under a long Channel list; and a sidebar-owned list of
known items, which would make the sidebar decide what a host offers.

**Consequences:** Anything that must stay visible at the bottom of the
sidebar goes through `footerItems` as `SidebarRow`s, not into the list. The
host decides what appears; the sidebar only places it.

Shipped in #1088.


### 2026-10-02 — Space pickers lead with All

**What changed:** Space pickers list General first, labelled **All**, then the
rest A to Z, and start on it. Before, General sorted among the others by name
and the picker defaulted to whichever Space came first.

**Why:** Product asked for one name for the Organization-wide home across the
sidebar and the pickers, and for new Channels to land there unless someone
picks a Space. The pill strip already called it All.

**Considered and rejected:** Renaming the stored General Space. Its name is
data the API and other surfaces read; the label lives only in the pickers, so
the rename stays a client presentation choice keyed on `systemRole`.

**Consequences:** A picker shows General's name as All, including in the
disabled reason ("already in All"). Anything new that lists Spaces for a choice
should read it through `useSpaceChoices` rather than sort on its own: the
rule lives in that one file.

Shipped in #1072.

### 2026-10-02 — Panel dividers stop short of the window's edges

**What changed:** The lines between conversation panels (the Channel and
Breakout split, and the right panel's grab line) no longer run the full window
height. Each starts level with the title pill and ends level with the top of an
empty composer. Two tokens on `:root`, `--panel-divider-inset-top` and
`--panel-divider-inset-bottom`, set both ends. The bottom one is
derived from `--composer-dock-gap` and `--composer-capsule-height`, which the
composer dock and capsule now read too. A Breakout's launcher dock now
uses the same bottom gap as every other dock, so its empty field lines up with
the Channel's beside it (it sat 12px higher on a 28px gap).

**Why:** Design asked for dividers that frame the conversation rather than cut
the window edge to edge. The Breakout pane's `border-left` could not be
shortened, so it became a positioned line.

**Considered and rejected:** Measuring the live composer from script. A draft
that grows would drag the divider with it, and the ask was the empty box's edge. Insetting the sidebars' edges too. Their fill
differs from the pane's, so the colour change runs full height anyway and a
shorter line beside it reads as a mistake.

**Consequences:** Changing the empty composer's height or the gap below it
moves both dividers with it. Both sidebars keep their full-height border.

Shipped in #1071.

### 2026-10-02 — A picked pill filters while a Channel is open

**What changed:** The rule that widens the list to All when the open Channel is
outside the filter now runs only when the open Channel, or its set of Spaces,
changes, not when the reader picks a pill. A pill that hides the open Channel
now opens the first Channel in the filtered list once that Space's Channels
have loaded, or the Space's dashboard when it holds none.

**Why:** The rule ran on every filter change, so with any Channel open,
picking a Space that did not hold it snapped straight back to All. Since a
Channel is almost always open, the pills looked like they did nothing.
Product then asked that the pick open a Channel in that Space rather than
leave the open one off the list.

**Considered and rejected:** Dropping the widen rule. It still earns its place
when a link or a stored filter opens a Channel the list would hide. Keeping the
open Channel and leaving its row off the list: the screen and the list
disagreed about where the reader was.

**Consequences:** The navigation waits for the picked Space's Channels and
drops itself if the route changes or another pill is picked first, but not
if the reader has only started typing in the open Channel. It pushes a history
entry, so Back returns to the earlier Channel and widens to All. Restore
selects through the same path, so the list and the screen agree there too.

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
was also out: the ask was a local preference. So was keeping the **Channels**
heading only when something is pinned, as before. The heading now carries the toggle, so that
rule would hide Recent and Needs you from exactly the reader who has pinned
nothing and most needs them. The heading shows whenever the list has rows.

**Consequences:** The unpinned list always has a heading, so a member with no
pins sees one more row above their Channels than before.

Shipped in #1068.

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
