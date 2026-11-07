# Desktop and web shell

The shell is everything around a pane: the navigation sidebar (a rail of two
sections beside one list), the floating title pills and their menus, and the
one right slot a pane's artifact or attachment opens in. The Electron client
and the browser web app mount the same shell, the desktop renderer's
`WorkspaceApp`, for members and guests alike; each host supplies its session
and its native services. What differs by host or by guest is read from
`useShellCapabilities()`.

The product has two sections, **Canvases** and **Sidekicks**
([the Canvases and Sidekicks PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)).
Channels, Threads, Breakouts, Activity and the Pinned and Artifacts sections
were removed at the 2026-11 cutover; the changelog below records them.

Read this before changing the rail, a list, what a row shows, the landing, the
routes the shell serves, or who owns the right panel.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/App.tsx` | `WorkspaceApp` and its routes: `/` (the landing), `/canvases`, `/canvases/:id`, `/sidekicks`, `/sidekicks/new`, `/sidekicks/:id`, `/automations/:id`, `/settings`, `/opening`, and the redirects of the removed routes. |
| `apps/desktop/src/renderer/screens/landing.tsx`, `lib/landing.ts` | The root route: the restorable `last-route`, else `/canvases`, once onboarding is finished. `LANDING_ROUTE`, `restorableRoute`, `RESTORED_ROUTE`, `useRestoredRouteFallback`, `useOpenLanding`. |
| `apps/desktop/src/renderer/components/app-shell.tsx` | The shell around the routes: the sidebar, the main pane, the right slot's width, search, the dock badge, and the `last-route` and presence writes. |
| `packages/ui/src/components/resizable-sidebar.tsx` | `ResizableSidebar`. The shell passes `collapsible={false}`: the edge resizes between `MIN_SIDEBAR_WIDTH` and `MAX_SIDEBAR_WIDTH` and never collapses. |
| `apps/desktop/src/renderer/components/navigation-sidebar.tsx` | `NavigationSidebar`: the rail (Canvases, Sidekicks), the account menu under it, the list's header and its actions, and the phone sheet; `useSectionCounts`, the rail's counts the dock badge adds up. |
| `apps/desktop/src/common/sidebar-attention.ts` | `canvasNeedsAttention` and `sidekickNeedsAttention`: what counts as needing attention, shared by `useSectionCounts` and the menu bar ([`menu-bar.md`](menu-bar.md)). |
| `apps/desktop/src/renderer/components/canvas-sidebar-section.tsx`, `sidekick-sidebar-section.tsx` | `CanvasesSection` and `SidekicksSection`, and the counts their tiles carry (`useUnreadCanvasCount`, `useSidekickAttentionCount`). |
| `apps/desktop/src/renderer/components/navigation-rows.tsx` | The row primitives both lists draw: `RowLayout`, `SectionHeading`, `PinnedSection`, `useSectionMotion`, `PinnableRow`, `usePinWrite`, `splitPinned`, `useRowPinDrop`. |
| `apps/desktop/src/renderer/components/rail-item.tsx` | `RailItem`: one tile of the rail, the account menu's trigger included. |
| `apps/desktop/src/renderer/screens/canvases-home.tsx`, `canvas.tsx` | `/canvases` and `/canvases/:id` ([`canvases.md`](canvases.md#in-the-client)). |
| `apps/desktop/src/renderer/screens/sidekicks-library.tsx`, `automation.tsx` | `/sidekicks` and `/sidekicks/:id` ([`automation-lifecycle.md`](automation-lifecycle.md)). |
| `packages/ui/src/components/title-pill.tsx` | `TitlePill`, `TitlePillHeader`, the menu building blocks, `TitlePillAction` and `TitlePillClose`. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | One conversation: a Canvas's Chat or a Sidekick's conversation. Owns its right panel by conversation. |
| `apps/desktop/src/renderer/lib/browser-rail-links.ts` | Routes a clicked web link to the pane it was clicked in. |
| `packages/ui/src/styles/app.css` | The "Single sidebar" and "Title pills" blocks. |
| `apps/browser/src/shell.tsx` | The web app: this shell over the browser's cookie session ([`browser-client.md`](browser-client.md#the-shell)). |

## How it works

### Electron navigation history

The leftmost visible pane header carries Back and Forward before its breadcrumb,
as one neutral two-mark liquid glass bridge with Tabler chevrons. The desktop
shell's `NavigationHistoryProvider` supplies the shared header's leading slot;
the browser host leaves it empty. Buttons traverse HashRouter's existing entries,
including query parameters and location state. Session actions and desktop deep
links use `navigateAppRoute`, bridged to the main window's router by
`AppRouteNavigation`, so each visit has the same index as an in-app link. Before
the router mounts, the helper sets the initial hash for the router to index.
Opening and launch skeletons carry the same leading slot as loaded headers.
PUSH drops the forward branch,
REPLACE keeps it, and POP moves the cursor. Unavailable directions are disabled.
The cursor belongs to the shell, so changing the pane that draws the controls
does not reset it. A new shell starts at the current entry with no forward visits
recorded; history is not persisted separately.

### The sidebar

One `ResizableSidebar` on the left, at the width in `useUiStore.sidebarWidth`
(`rally.sidebar-width`; 340px, `SINGLE_SIDEBAR_DEFAULT_WIDTH`, until the person
drags it), clamped to the shared minimum and maximum. It holds two columns:

- **The rail**, a 76px column under the macOS window controls, which the main
  window centers over it per macOS version (the width is
  `--navigation-rail-width`; change it and the light position together):
  **Canvases**, a page outline (the sheet every artifact tile draws), and
  **Sidekicks**, the Tabler hexagon a Sidekick is drawn in, then the account
  menu at the bottom, labelled Settings. Every entry, the account menu's
  trigger included, is one `RailItem`: a 34px tile around a 22px shape, so they
  share size, hover and the active tint, which a menu's trigger also takes
  while its menu is open. The choice is a device preference
  (`rally.sidebar-section`, default `canvases`); a value stored before the
  cutover (`channels`, `threads`, `pinned`, `artifacts`, `activity`) reads as
  the default. Each section carries a red count (`RailBadge`; nothing at zero,
  `99+` past two digits): **Canvases**, each Canvas holding something this
  person has not read; **Sidekicks**, each Sidekick that needs input or holds
  something unread. Both are read from the lists the workspace socket keeps,
  the same rows the lists draw. The desktop host renders a top spacer for
  macOS window controls and a window-drag region on Windows and Linux. The
  browser host omits it.
- **One list**, titled with the section's name. **Canvases** is a Pinned
  group, then every Canvas by recent activity; its action is **New Canvas**
  (`POST /canvases`, then the new Canvas's route). **Sidekicks** is **Needs
  input**, then Pinned, then every Sidekick; its action is **New Sidekick**
  (`/sidekicks/new`). A guest gets neither New action. Each list has **Restart
  to update** when one is downloaded, and **Search organization** last, so it
  holds its place as the person moves between the two.
  [`canvases.md`](canvases.md#in-the-client) says what a Canvas row shows, and
  [`pinning.md`](pinning.md) owns the Pinned group.

Every row in the lists is one layout (`RowLayout`): an `IdentityTile`
(`packages/ui/src/components/identity-tile.tsx`), a name with a time, and a
second line with the unread dot at its end. A tile is a shape in the object's
pastel pair with its glyph, and can carry small badges on its corner, each in
a ring painted the row's own background (`--tile-ring`) so it reads as cut out
of the tile on a plain, hovered or selected row. A badge can carry one smaller
badge on its own corner, for a chain of containers; the parent moves up and
left so it shows clear of the nested one, and the deepest badge's corner lands
where a lone badge's would. A badge with a `label` names itself in a tooltip
on hover; the tip sits on the badge's fill rather than its ring, so hovering a
nested badge opens only its own. A badge either draws a symbol in its own
ink and fill, or holds `content` the caller draws, such as an avatar; an
`.avatar` is sized to the badge.

Every row is a link, so a modified click opens it elsewhere (a new tab, in the
web app). Each list draws placeholder rows until the socket has said what it
holds. A row that changes place travels to its new slot rather than
reappearing there; [`list-motion.md`](list-motion.md) owns the motion.

### The landing and the routes

`/` is the landing (`LandingScreen`). It reopens the route this person last had
open on this device, `rally.desktop-layout:<organization>:<user>:last-route`,
when that is a Canvas, a Sidekick or either home (`restorableRoute`), and
otherwise opens `/canvases`. The app shell writes `last-route` on every
navigation to such a route. A screen that leaves because what it showed is gone
uses `useOpenLanding`, which replaces the entry so Back cannot return to it.

The landing restores nothing while onboarding is pending: it waits on the same
conversation-admission context the onboarding gates set
([`new-user-onboarding.md`](new-user-onboarding.md)), and draws an opening
state until both journeys are known to be finished. Finishing onboarding lands
on `/canvases` itself. A restored route carries `RESTORED_ROUTE` as its
`location.state`, and the Sidekick and Canvas screens read it through
`useRestoredRouteFallback`: when the object answers 404 on a restored route,
the screen replaces itself with its section home (`/sidekicks` or `/canvases`)
and logs one `restored_route_not_found` line, with no dialog. The same 404 on a
route someone opened deliberately (a click, a link) still raises the screen's
**could not be opened** notice.

The removed surfaces' routes, `/channels/*`, `/spaces/*`, `/workstreams/*`,
`/projects/*`, `/activity` and `/artifacts`, redirect to `/canvases`, so a
stored route, a bookmark or an old link opens the Canvases home rather than a
dead screen. A deep link that names Activity opens the Canvases section.
`/opening` is inert: a deep link that changes organization parks the pane there
while its destination resolves. Settings opens in its own window on the desktop
and as `/settings` in the browser.

The open Canvas is the shell's foreground conversation: the app shell passes
its id to `setForegroundWorkstreamId`, which is how presence learns who is in a
Canvas ([`canvases.md`](canvases.md#presence)).

### At phone width

The screen has one header. A pane with a `TitlePillHeader` is that header:
the app shell provides `PhoneHeaderContext`, and at phone width the header
leads its crumbs with a round menu button that opens the sheet, drawn like
the trailing buttons and apart from the crumbs' glass `MarkBridge`, and puts
**Search organization** first in its folded "⋯" menu. Loading skeletons draw
the button alone (`TitlePillNavigation`). A right-slot panel fills the phone,
so its header carries the same. A window surface in a browser tab draws no
sidebar, so the app shell provides no context there.

The sidebar is a sheet behind the list's own header: the close button at the
left, the section's title centred, its actions at the right. The rail is a row
of tabs under it: Canvases, Sidekicks, then the account menu as a last tab
labelled Settings. While a visible pane header carries the menu button
(`PHONE_NAVIGATION_CONTROL`), the shut sheet keeps no bar and is hidden whole;
a screen without one keeps the sheet's header as its top bar. Opening the sheet
from a pane header moves focus to its close button; closing hands focus back
to the opener, or to the visible menu button when the opener is gone
(`useSheetOpener`). Opening anything from it closes it, as do Escape and
widening past 640px; switching sections does not navigate, so the sheet stays
open on the list just picked. An open menu, dialog or error popup takes Escape
before the sheet does. Code that navigates and wants the sheet open afterwards
sets `sheetAfterNavigation` instead of `sidebarOpen`: the sidebar's reset on
mount and route change reads it and opens the sheet once.

### Title pills

Every pane's header is a `TitlePillHeader`: its ancestors attached to its own
pill as one centred glass control, and the pane's controls at the right. The
header row is 64px in every pane. Each control at the right is a
`TitlePillAction`, the raised circle the pills wear. A narrow pane fits its
pill between the leading and trailing controls and truncates the title, and
that layout disables the crowding shift: shifting a pill already sized by the
grid can move it across the pane boundary. An open pill fills solid and drops
its lift to the bare ring. Each menu has a root and levels; a row opens its
level in place (`useTitleMenuNav`), the title, Escape or the left arrow step
back to the root, and `TitleMenuMorph` travels the popout's size between
levels; reduced motion turns that off.

- **Artifact menu** (`InspectorRail`, shared by the side panel, expanded panel,
  and detached artifact windows): the root offers Download for available files,
  Rename and Copy link as tiles, plus More when archiving is available.
  Secondary action rows sit above Versions.
  Live sites also offer Open in browser as a top-row tile; their copy tile is
  **Copy public link**, copying its stable public URL rather than its Rally
  navigation address. Both copy actions report success or failure after the
  menu closes. The main menu rows hold **Pinned in my sidebar**,
  **Open in a new window**, Open source for other resources, and Refresh where
  supported, followed by Versions. **Archive** lives inside More. A detached window
  omits Open in a new window. Historical file previews identify their revision,
  download those original bytes, and offer **Return to current**. Detached live-site
  history is listed without opening manifest bytes as a document. Stateful sites expose **Stored data** as a
  navigation row above Versions. It opens the table picker, stored rows, and CSV
  export inside the pop-out menu; the preview stays mounted behind it.
  Comment mode, Expand/Collapse, and Close remain in the header. Shared title-menu action,
  navigation, and switch rows align their icons and labels consistently; compact
  resource lists retain their own sizing.
  Rename is offered on a generated artifact. The detached window offers rename,
  copy link, archive and pinning only when it was opened as editable from a
  conversation's Main (`"0"`); it uses that saved eligibility and conversation
  context for these actions and retains its annotation draft when opening
  menus. Rename uses
  `PATCH /conversations/:parentId/resources/:resourceId`. Download reads original
  bytes separately from readable previews, including files without a preview.

### One right slot

The right panel holds the desktop's embedded browser, or whatever the
conversation opened: a Canvas's artifact with its actions, an attachment, a
citation's file, or a prior version. None of these opens as a modal. The
panel's header is a pane header: the item's title pill, its actions in the
pill's menu, and the round close button. At phone width (640px and under) the
panel takes the whole width, with no resize edge. Above it, an attachment or
artifact opens the panel at an even split with the conversation, and a browser
tab splits its window in half; [`desktop-layout.md`](desktop-layout.md) owns
the width and its resize edge. `ConversationSurface` scopes the panel to the
conversation that opened it (`railScope`, the parent id), and a surface only
closes, fades or restores a panel it owns.

A pane header's trailing buttons are one `IconGroup`
(`packages/ui/src/components/icon-group.tsx`), which spaces them. Its `actions`
fold into a "⋯" dropdown at phone width (640px and under), and whenever
`TitlePillHeader` measures the unfolded row coming closer to the centred pill
than the gap between the buttons. Folded, the pill moves left just far enough
to keep that same gap from "⋯", and no further. The measure is taken from the
unfolded, centred layout rather than from where things sit, so folding or
moving the pill never undoes the decision; read live, the distance would grow
as soon as the row folded and the header would flip back.

A detail's own actions (a live site's Stored data, New window, Copy link and
Open in browser) reach the header through `useDetailHeaderActions`, as data.
The rail places opening and copy actions in the menu's main tiles or rows,
including Stored data for a stateful site. Viewing controls such as Comment
mode stay in the header beside Expand and Close.
`TitlePillHeader` and `TitlePillClose` take a `tooltipSide` for every label in
the header. The rail sets it to `left` over a live site, whose composited page
would cover a label hanging down; upward does not fit at the window's top.

### Web links

`useBrowserRailLinks` registers one host per surface, with that surface's
element. A single document listener routes a click to the host whose element
contains the anchor, and otherwise to the newest host, so a link opens in the
panel of the pane it was clicked in, once.

## Invariants

- **A tile's count is its list's rows.** Both read the list the workspace
  socket keeps; a second definition would let the rail and the list disagree.
  Guard: `components/navigation-sidebar.test.tsx`.
- **A surface touches only the panel scope it owns.** Guard: verified visually;
  the scope comparison is in each close path of `conversation-surface.tsx`.
- **One link listener, however many hosts.** Two listeners open a link twice,
  as two browser tabs. Guard: `lib/browser-rail-links.test.ts`.
- **A restore never interrupts.** No stored route is applied before onboarding
  has finished, and a restored object that is gone falls back to its section
  home without a dialog; a dialog is for something the person just asked to
  open. Guard: `screens/landing.test.tsx`.
- **A removed route never draws a dead screen.** Stored and linked addresses of
  removed surfaces redirect to `/canvases`. Guard: `App.session-gate.test.tsx`,
  `screens/landing.test.tsx`.
- **The sidebar never collapses, and never stacks rails.** It is one list with a
  rail beside it. Guard: `collapsible={false}`; no toggle exists to call. At
  phone width the sheet is a different layout, not a collapse, and writes no
  width.

## Boundary

The shell owns layout, navigation chrome, the routes and which pane is shown.
It does not own:

- what a Canvas is and who may open it ([`canvases.md`](canvases.md));
- a Sidekick's screens and lifecycle ([`automation-lifecycle.md`](automation-lifecycle.md));
- pin authority ([`pinning.md`](pinning.md));
- the feed, composer and panels inside a pane ([`conversation-surfaces.md`](conversation-surfaces.md));
- what the desktop restores after relaunch ([`desktop-layout.md`](desktop-layout.md)).

## Failure modes and limits

- **No restorable route:** a device that saved none, or saved a route of a
  removed surface, lands on `/canvases`.
- **A saved Canvas or Sidekick that is gone:** the landing reopens it, the
  object answers 404, and the screen falls back to `/canvases` or `/sidekicks`
  with a `restored_route_not_found` warning in the renderer log. A 403 is not
  treated as gone and still shows the screen's unavailable state
  ([`canvases.md`](canvases.md)).
- **Lists not yet delivered:** both lists draw placeholder rows and both tiles
  count nothing until the workspace socket answers.

## Testing

- **Desktop component tests:** `components/navigation-sidebar.test.tsx` (the
  rail, both sections, the phone sheet), `screens/landing.test.tsx`,
  `App.session-gate.test.tsx` (routes and redirects), `lib/ui-store.test.ts`
  (the stored section), `lib/browser-rail-links.test.ts`. Run with
  `pnpm --filter @rally/desktop exec vitest run <path>`.
- **A guest in the shell:** `lib/browser-collaboration.test.tsx`.
- **Window behaviour:** whether the rail, lists and panes are visible and placed
  correctly is checked in a real window under Xvfb, per
  [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it).

## Changelog

### 2026-11-07 — A restored route waits for onboarding and falls back silently

**What changed:** The landing applies no stored `last-route` until
conversation admission says onboarding is finished, and opens a restored route
with `RESTORED_ROUTE` state. The Sidekick and Canvas screens, on a 404 for a
restored route, replace themselves with their section home and log
`restored_route_not_found` instead of raising **could not be opened**.

**Why:** A real-window pass after a fresh `db:migrate && db:seed` showed
"Sidekick could not be opened / This Sidekick does not exist" over the "This is
you in Rally" onboarding screen. The `last-route` from an earlier database named
a Sidekick that no longer existed; the landing restored it while the journey
was still loading (the gate renders the workspace until it knows the journey is
unfinished), the Sidekick screen published its error to the window's notice
queue, and the queue outlived the screen once onboarding replaced it. A dialog
is for an open the person just asked for; a restore is the app's own guess.
Admission was reused rather than adding an onboarding flag because it already
composes both onboarding gates and means exactly "the workspace may be used".

**Consequences:** Only a 404 counts as gone; a 403 still shows the screen's
error, since access can come back. A new restorable route kind (beyond Canvas
and Sidekick) needs its screen to call `useRestoredRouteFallback`, or a stale
one will raise a dialog at launch.

### 2026-11-07 — The shell becomes Canvases and Sidekicks; Channels, Threads and Breakouts are deleted

**What changed:** The rail lists two sections, Canvases and Sidekicks, with
Settings at the bottom; `SidebarSection` is `'canvases' | 'sidekicks'` and a
section stored before the cutover reads as Canvases. Their lists reuse the
section switcher, the row primitives and the badge record. The landing opens
the restorable `last-route` or `/canvases`, replacing the Channel fallback
chain (pinned Channel, General, A–Z); `last-route` is written only for Canvas
and Sidekick routes, and the Channel, Space, Thread, Project, Activity and
Artifacts routes redirect to `/canvases`. The open Canvas is the shell's
foreground conversation for presence. The phone row's More tab
(`MoreSections`, `PHONE_RAIL_SECTIONS`) is gone. The Channel screen, the Thread
screen, the Breakout launch surface, the old landing
(`lib/workstream-landing.ts`), the Thread directory and its caches, the Thread
socket pool, the access-request dialog, the attention ranking behind the
Threads count, the per-device Thread and Channel sorts, and the Channel and
Space places in search are deleted, and the workspace socket no longer applies
Space snapshots, Thread pages, recency, state or rail frames, access requests
or Space nudges. **`pane-stack.md` is retired**: it described the stack a
Channel, a thread, a breakout and a panel formed, two on screen with the rest
as breadcrumbs; what survives of it is the right panel expanding over its
conversation (`usePaneExpansion`, `expandToggle`, now in
`lib/navigation-routes.ts`). **`attention-menu.md` is retired**: it kept what
counted as needing attention (`attentionItems`) for the Threads count and the
dock badge; both now count the Canvases and Sidekicks lists
(`useSectionCounts`, by the predicates in `common/sidebar-attention.ts` that
the menu bar shares), and the dock badge is the rail's counts added up. A
search result opens its Canvas on the turn it names.

**Why:** Plan steps A-14, B-1 and B-3 of the
[Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md):
Threads, Breakouts and Channels are deleted (decision log, 2026-11-06), and the
PRD's rail is Canvases, Sidekicks, then Settings. The new sections landed first
as sections reachable by URL beside the untouched old shell, so the cutover was
a switch of which sections the rail lists rather than new work. Redirecting
removed routes to `/canvases`, as `/projects/*` already went to the landing,
keeps every stored route and old link landing somewhere real. The More tab
existed only because five sections did not fit a phone row with Settings; with
two it can never fold. The app shell named only an open Thread as the
foreground conversation, so a Canvas's face pile never saw anyone; a Canvas id
is a conversation-parent id, so the same field carries it. Both retired
documents described mechanisms that no longer have code; their decisions are
summarised here so the reasoning is not lost.

**Considered and rejected:** A second sidebar for the new sections. The
existing switcher, row primitives and badge record already did what the two
lists need.

**Consequences:** A server mid-deployment still sends the Thread and Space
frames; the socket ignores a type it no longer reads, as it does any unknown
type. The saved `rally.sidebar-section` may read `canvases` or `sidekicks`, so
the preference's allowed list must keep them. Adding a third section is a
`SECTIONS` entry and a `SidebarSection` value; if a phone row ever overflows
again, the fold has to be rebuilt rather than restored, and opening a second
pane beside a conversation would likewise have to be built again.

### 2026-10-21 — Keep artifacts directly discoverable in thread menus

**What changed:** Artifacts is a permanent row below People, opening its own
level instead of living in More. The row stays visible at zero; unknown
inventory has no count and shows a loading state. Levels without enabled
controls keep focus on their frame so keyboard navigation still works.

**Why:** Artifacts belong alongside the conversation's people and Sidekicks.
Hiding the row when empty would make that location change as artifacts arrive;
reporting an unknown inventory as zero would confuse loading with absence.
The existing resource rows and menu navigation are reused rather than adding
another artifact browser.

**Consequences:** Preserve the permanent row and distinguish unknown inventory
from an answered empty list. Entering an enabled list still focuses its first
item; empty and disabled levels must retain a keyboard route back.

### 2026-10-21 — Share thread lifecycle reconciliation across menus

**What changed:** The sidebar and title menus share archive/resolve commands,
archive confirmation, and resolution refusal copy. Confirmed archive receipts
reconcile every later thread-list read, and navigation completions are fenced
by visits and unmounts.

**Why:** Pruning one cached page let a later stale projection resurrect an
archived thread, while unconditional pruning could hide a newer restore. The
sidebar also outlived its navigation guard when its section closed. Keeping
separate lifecycle implementations had already produced different errors and
cache behavior between the menus. The directory's version ordering must keep
winning over older command responses, without an extra backend read.

### 2026-10-21 — Resolved work sits below ongoing work

Resolved conversations were as prominent as ongoing work and could outrank it
when unread. They now use Activity's read-row treatment and the final Needs
attention group. Archived rows stay out of navigation even when still pinned.
The existing versioned breakout roster reconciles cached navigation copies;
visibility tombstones reread authority rather than guessing whether archive or
membership changed. Pin drop slots follow the visible rows while preserving
hidden pins in the stored order.
An open unresolved row keeps its held slot above the resolved group; resolving
it releases that hold so completed work cannot remain above ongoing work.

### 2026-10-21 — Opening a thread holds its slot in Needs attention

**What changed:** The open thread or Breakout keeps its last displayed position
under Needs attention, including after its unread state clears. Navigating away
releases it; an explicit sort change starts a fresh order.

**Why:** Treating the open thread as needing attention promoted already-read
threads on selection. The intended protection against a row dropping while
being read instead made the list jump when someone opened it.

**Considered and rejected:** Removing the hold entirely would let an unread
thread drop as soon as opening it marks it read. Freezing the whole list would
hide unrelated attention and activity changes.

**Consequences:** Selection never supplies attention rank. Only the open row's
slot is held locally; the other rows continue sorting from current data. A
Breakout's own ID from the query owns the hold and highlight, leaving its
parent free to reorder.

PR: [#1379](https://github.com/juno-ai-labs/avalon/pull/1379).

### 2026-10-19 — Electron history controls before the breadcrumb

The product asked for direct history navigation beside the breadcrumb. Reusing
the router instead of a separate resource stack preserves queries and expansion
state. Session actions and deep links must use that router too: direct hash
writes create unindexed visits and break traversal. The browser keeps its own
controls.

### 2026-10-19 — One artifact menu across panels and detached windows

**What changed:** Artifacts show pinning and Open in a new window as rows
in the main title menu, above Versions, and Archive inside More. Live sites offer Open in browser
as a main tile and Stored data as a pop-out level above Versions. Public-link copying moves into
its root tile, replacing the internal-link tile; the header keeps viewing
controls. The shared action, navigation, and switch row styles use one icon
column and vertical rhythm across title menus. Detached windows reuse `InspectorRail` for the header, versions,
rename and archive dialogs, with a resource-confined main-process action bridge.

**Why:** Website actions crowded the header and offered two differently scoped
links, while detached windows had a separate header with only Comment mode.
Keeping separate menus would make every future action drift between surfaces.
The shared host accepts the detached window's existing media/annotation body,
so unifying the menu does not replace its players or annotation transfer.

**Consequences:** Detached windows cannot request arbitrary API paths or target
another resource. Opening a website externally mints fresh access; copying its
public URL never copies a single-use access code. File links retain their Rally
navigation semantics. Detached windows omit the redundant New window action.


### 2026-10-19 — Open Channels at the server read waterline

The feed captures the server's first-unread position for each visit and opens
there with preceding context, loading earlier pages only when needed. Visible
rows advance the server read waterline; only reaching the end acknowledges its
latest number. Opening refreshes invalidated or missing read state, waits for
a missing unread row during entry refetch, and keeps unread visible even after
a tall context row. A failed opening request leaves a retryable, usable feed
without silently acknowledging the missing history. Settled merge reveals finish
even when another arrival has overtaken their target.

Always opening at the newest row and acknowledging the whole
feed would skip unread work and erase the saved position on every visit.

Positioning runs only while the pane has visible layout, retaining the
reader's chosen offset while an expanded thread hides it. Previously the hidden
pane reported zero geometry, and returning through the Channel breadcrumb could
leave the feed at the top. An empty Channel also resets the scroll visit, so a
return cannot reuse another visit's history-prepend baseline. Repositioning on
every return to the newest row was rejected because it would discard a reader's
deliberate scroll into older history.

The existing feed cursor can require sequential requests through a long unread
Channel. No page cap was added: stopping early would skip the server-saved
waterline requested by the reader. An indexed read-position feed endpoint would
remove that latency without changing the opening contract.

### 2026-10-19 — Thread, Breakout and Channel menus gain a Memory level

**What changed:** Each of the three conversation menus has a Memory row and
level listing the facts Rally remembers about that conversation, with Remove
where the server allows it. The Personal Channel's "What Rally remembers"
panel, which sat between the Channel's header and its feed, is gone; a
person's own and the Organization's facts moved to Settings.

**Why:** The product owner decided memory is reviewed where its subject
lives: a conversation's facts in that conversation's menu, beside its People
and Sidekicks, rather than one list of everything in one Channel.

**Considered and rejected:** Reading the facts with the conversation, so the
row's count shows on the menu's first open. That is a read on every
conversation opened for a level most opens never visit; the count waits for
the level instead.

**Consequences:** `packages/ui` cannot import the desktop's API, so the menus
take the facts and the removal as a prop and the screens own the query. The
shared clock (`useNow`) moved to `packages/ui/src/lib/clock.ts` so the rows'
horizons tick inside the menu as they do on a page.

### 2026-10-18 — The artifact menu gains Rename, Copy link and Pin

**What changed:** The right panel's artifact menu offers Rename, Copy link and
Pin/Unpin as tiles, the same three a thread's menu offers. Rename is a new
route, `PATCH /conversations/:parentId/resources/:resourceId`; the link is the
existing `/a/` artifact link; the pin is the existing artifact pin.

**Why:** The product owner asked for parity with the thread menu. Pins and
artifact links already existed, reachable only from a citation card's menu
and a pinned artifact's push.

**Considered and rejected:** Putting Pin behind More as a switch, as a thread
does. An artifact menu has no More level, and four tiles fit its row.

**Consequences:** The `/a/` link is now minted where any desktop app can
receive it; one older than that segment refuses it. All three actions are
limited to an artifact in the thread's Main, since a pin and a link both open
Main onto it.

### 2026-10-18 — The phone's menu leaves the crumbs' glass bridge

**What changed:** At phone width the menu is a round button like the
header's trailing ones ("⋯", close), ahead of the crumbs, instead of the
first mark of their `MarkBridge`. It has no circle outline, and the bridge
holds only the path.

**Why:** The product owner reversed the 2026-10-16 call. Fused into the
bridge, the menu read as one more crumb in the path, its outlined circle
matching the Channel and thread marks beside it.

**Consequences:** The `has-phone-navigation` class moved to the button's own
wrapper, so `PHONE_NAVIGATION_CONTROL` and the rule that drops the sheet's bar
still find it. A bridge never carries a control that is not a level of the
path.

### 2026-10-18 — A Breakout pill no longer shows its reply count

**What changed:** The Breakout title pill dropped its "N replies" count, and
with it `ConversationHeaderContext.replyCount`, `conversationReplyCount` and
the pill's `meta` slot, which nothing else used.

**Why:** The product owner judged the count useless. It also held its width
while the name shrank, so a phone showed "A. 7 replies" for a Breakout named
"Acme follow-up email".

### 2026-10-17 — The phone row folds its fifth section into More

**What changed:** At phone width the section switcher draws four sections,
then a **More** "⋯" tab, then Settings. The sections past the fourth
(Artifacts, for a member) are a dropdown under More: radio rows with their own
counts and a check on the open one. More's tile carries their counts added up
and takes the active tint while one of them is open. A guest, whose four
sections all fit, gets no More. The wide rail is unchanged.

**Why:** Six tiles across a phone crowded the row, and the product owner asked
for five elements and a "⋯" menu holding the rest. The count of four is theirs
(`PHONE_RAIL_SECTIONS`), a layout choice rather than a measured limit.

**Considered and rejected:** Folding in CSS as `IconGroup` does, with every
section and a More tile always rendered and the stylesheet hiding one set at
each width. Which sections fold depends on the person (a guest has nothing to
fold), and More's count and selected state are computed from them, so the
sidebar decides with `usePhoneLayout`, as the title pills decide how many marks
to draw.

**Consequences:** A section added to `SECTIONS` past the fourth lands in More
on a phone without further work, and the order of `SECTIONS` is the order of
the row and the menu. More is a `RailItem` wrapped by a Radix trigger, as the
account menu is, so it takes the open tint the rail already gives a trigger.

### 2026-10-16 — A navigation can ask for the phone sheet

**What changed:** `useUiStore` has `sheetAfterNavigation`, a one-shot request
that the sidebar's mount-and-route reset reads in place of closing the sheet.

**Why:** The digest's Activity link, opened at phone width in an organization
that is not the active one, switches organization and moves the route. The
sidebar remounts and resets the sheet after the link has set it, so the sheet
it opened closed again.

**Considered and rejected:** Opening the sheet on a timer after the route
change, which races the remount; and exempting deep links from the reset,
which would break "opening anything closes the sheet".

**Consequences:** The reset is still the only place the sheet's state changes
on navigation. Set the request only at phone width: an open sheet makes the
pane inert (the 2026-10-06 entry, "The sidebar is a top bar and sheet").

### 2026-10-16 — The account menu is a rail tile like the sections

**What changed:** The account menu's trigger in the section switcher is a
`RailItem`, the same component the four sections draw, labelled Settings at
every width. A support session's staff avatar sits on the tile's corner.

**Why:** The trigger was the footer's `AccountTrigger` (avatar, name, chevron)
squeezed into the rail by CSS that hid its copy and resized its avatar, so it
came out a different size and shape from the sections beside it, and the phone
tab rebuilt it again with its own rules and a `::after` label.

**Considered and rejected:** Keeping `AccountTrigger` and matching the tile in
CSS. That fixed the size once, but left two components that have to be kept in
step by hand.

**Consequences:** A new rail entry, menu or not, is a `RailItem`; a Radix
trigger wraps it with `asChild`. `WorkspaceAccountMenu` now only renders in the
rail. `AccountTrigger` stays for the Sideline footer.

### 2026-10-16 — Pinned's rail icon is the pin

**What changed:** The Pinned section's icon is `IconPin` at 22px and a 1.8
stroke, replacing `ShapeGrid`. `ShapeGrid` and the hexagon outline it alone
used are gone from `identity-tile.tsx`.

**Why:** The grid did not sit with its neighbours. It spanned 2.4 to 21.6 of the
24-unit grid against the outlines' 3.6 keyline, and its 1.2 stroke made four
thin shapes that read as grey texture beside single 1.8 outlines. A tuned grid,
a squircle-and-circle pair, a nested squircle, a diamond and a star were drawn
and compared; the product owner chose the pin because it names the section
and matches the control that fills it. It breaks the rule that each section's
icon is the outline of what it holds, so a later section should not take that
as precedent: the pin is an exception for a list defined by an action, not by
a kind.

### 2026-10-16 — New breakout and Merge lead every message's hover row

**What changed:** **New breakout** is the first hover action on every message,
Rally's newest reply included, and **Merge** follows it. The visible line
under Rally's newest reply, **Start a breakout from this message**, is gone.

**Why:** Merge-back added a second action that moves work between levels, and
the product owner asked for both in one place, at the front of the row, with
the permanent line folded into it.

**Considered and rejected:** Keeping the permanent line beside the hover row,
which put the same action on screen twice under the newest reply.

**Consequences:** No message has a breakout control outside its hover row. The
row never wraps (`flex-wrap: nowrap`), so a long row runs under the title
menu's pop-out instead of breaking. Mechanism: `conversation-merge.md` (retired).

### 2026-10-16 — One header at phone width; counts on every section

**What changed:** At phone width a pane's title-pill header is the screen's
only header. It carries the menu mark, fused into the front of its crumbs'
`MarkBridge`, and Search in its "⋯" menu, through `PhoneHeaderContext`. The
sheet's own header now shows only while the sheet is open (close, centred
title, actions), unless the screen has no title-pill header to stand in for
it. `PHONE_LAYOUT_MAX_WIDTH` moved to `packages/ui/src/lib/phone-layout.ts`
beside `usePhoneLayout`.

**Why:** The product owner asked for one header on a phone. The sheet's bar
and the pane's pill row stacked 120px of chrome, with the menu and Search in
one row and the conversation's crumbs and actions in the other.

**Considered and rejected:** Moving the pane's pill into the sheet's bar. The
pill and its menu belong to the pane, and the Breakout and right-slot panes
each have their own; one bar would need to know which pane is in front. A
separate menu button beside the crumbs instead of a mark in their bridge: the
product owner asked for one glass group holding both. Hiding the bar whenever
a title-pill header exists: a hidden pane's header still matches, which left
a Breakout draft and the browser panel with no way to the navigation, so the
rule keys on a visible menu mark. Making the right-slot panel a
`conversation-pane` container to truncate its title: under 460px it also
re-laid out the desktop panel, which is that wide by default.

A site in the right slot showed the problem worst: its three actions crowded
the header, and the shift that keeps the pill clear of them moved its long
title off the screen's left edge.

The same change gave the Pinned, Channels and Activity buttons counts. They
carried none before, and why was not recorded. On a phone those buttons are the first
thing the sheet shows, and the Activity and Channel rows held red dots that
nothing pointed to. Each count reads a query the list already holds, so no
new request backs it: the first Activity page is 250 rows, as the menu bar's
count is, and exact up to that.

**Consequences:** Whether the bar shows is a stylesheet decision keyed on
`.has-phone-navigation`, so a pane header drawn without `TitlePillHeader` or
`TitlePillNavigation` keeps the bar above it, and a new full-screen panel that
draws no mark must be excluded from that rule as the browser panel is.

### 2026-10-16 — A Pinned section in the switcher

**What changed:** The switcher gains **Pinned**, first, whose list is every
pin grouped by kind: Channels, then Threads. Its icon is `ShapeGrid`, four
outlines in a two-by-two grid, and `ShapeOutline` learns the Sidekick hexagon.
`ChannelsSection` and `ThreadsSection` take the Pinned tab's shared list
motion, and given it draw only their Pinned part, titled with the kind, with
placeholders while its rows are read.

**Why:** Pins were split across two tabs, so reaching a pinned Channel and a
pinned thread meant switching between them. More pinnable kinds are coming,
and each would add another tab to check.

**Considered and rejected:** A separate pinned list component. Reusing each
tab's own Pinned part keeps one drawing of a pinned row, one reorder path and
one empty state per kind, so a fix to either tab reaches Pinned too.

**Consequences:** A new pinnable kind adds its section to `PinnedPanel` and,
once it has one, its shape to the grid. Two list motions over one scroll box
would each animate every row, so a section drawn inside `PinnedPanel` takes
the tab's `useListMotionPass` and runs it on its own commits: a drag preview
re-renders only its section, so a pass run by the tab alone would miss it
([`list-motion.md`](list-motion.md)). A desktop link opened while Pinned is
showing scrolls to the row if it is pinned and does not page through the
Threads list for it. Unpinning on Pinned takes the row off the tab, so the pin
reveal hands focus to the row that was beside it, or to the Pinned button when
none is left, rather than leaving it on the page body.

### 2026-10-15 — Breakouts in a thread are cards, like threads in a Channel

**What changed:** The Channel feed's thread entry is now `ConversationCard` in
`packages/ui`, and a thread's feed draws each Breakout under its origin turn
with it, on the trailing side as a person started it, in place of
`BreakoutChipRow`, which is gone.
A Breakout's card has no summary; its byline names who started it and when.
The card, not its caller, drops the news on the open conversation, so an open
Breakout stops saying "New" as an open thread already did.
`BreakoutMark` gains `createdByUserId` for that byline.

**Why:** The product owner asked for the Channel's thread entry to be one
component used for Breakouts too. A thread and a Breakout are the same kind
of thing one level apart, and two drawings of it had already drifted.

**Considered and rejected:** Keeping a list component beside the tick bar in
`breakout-marks.tsx`: the card reads `breakoutNewsLabel` from that file, so
the list there made an import cycle. `MessageFeed` maps the cards itself.

**Consequences:** A change to the card reaches both feeds. A Breakout has no
stored description, so its card has no summary until one exists. The
Activity list's `breakout_started` row still borrows the `.breakout-chip`
styles; those rules stay for it.

### 2026-10-13 — Activity badges draw the real avatar

**What changed:** A `TileBadge` is either a symbol in its own fill and ink, or
`content` the caller draws; the `text` option is gone. An Activity row's actor
badge holds `RallyAvatar` for Rally and `Avatar` for a person. `RallyAvatar`
is new in the shared primitives, and the composer's mention list uses it too.

**Why:** The badge drew Rally as a sparkle and every person as initials on one
accent wash, so it matched neither the mention list nor the person's own look.
The product owner asked for the sidebar to show the avatar people see
everywhere else.

**Considered and rejected:** Keeping `text` and passing the person's colour and
initials through it. It cannot draw a shape or a photo, and every later change
to the avatar would need repeating in the badge.

**Consequences:** A badge that stands for a person or Rally holds the shared
avatar, never a copy of its colours. The badge's CSS strips the avatar's
border and lets its initials take the badge's size; an avatar that needs more
than that to fit a badge has to change here too.

Shipped in [#1217](https://github.com/juno-ai-labs/avalon/pull/1217).

### 2026-10-13 — A Breakout pill wears its glyph, like a thread pill

**What changed:** The Breakout pill's icon is now the Breakout's own glyph and
appearance picker, the same as a thread pill, instead of the fixed breakout
arrow. `BreakoutPillIcon` is gone. A thread pill's chevron no longer turns
right while a Breakout is open beside it; every pill's chevron points down.

**Why:** The two pills sat side by side and looked like different controls for
the same kind of thing, down to a thread chevron pointing right beside a Breakout
chevron pointing down. The arrow said "breakout", but the stacked thread pill
beside it already says that. Breakout chips and rows keep the arrow; only the
title pill changed.

**Considered and rejected:** Keeping the right chevron on the thread pill and
turning the Breakout's right too, so both pointed the same way. A Breakout pill
has nothing beside it to point at, and a down chevron is what opens a menu on
every other pill.

**Consequences:** A pill's chevron always means "open this menu", never a
direction. A new kind of title pill wears its own glyph through `icon` and, when
it can change its appearance, an `AppearancePicker` through `iconAction`, rather
than a fixed type mark.

Shipped in [#1216](https://github.com/juno-ai-labs/avalon/pull/1216).

### 2026-10-13 — The right slot holds every opened item, with a pane header

**What changed:** The right panel now holds whatever a conversation opens, not
only an artifact or the browser, and heads itself like a pane: a title pill and
round buttons. A pane header's trailing buttons are an `IconGroup`, whose
actions fold into "⋯" at phone width or when they would crowd the pill. Starting
a Breakout from a message closes the thread's panel, as opening one did. At
phone width the panel is full width. `conversation-surfaces.md` has the entry
for the panel itself.

**Why:** The navigation PRD opens anything from a conversation in the pane
beside it, and the product owner asked for the panel's header to match the
panes'. A Breakout started from a message opened behind the thread's panel.

**Considered and rejected:** Re-centring a crowded pill in the room the buttons
leave; the product owner asked for it to move only as far as one gap needs.

**Consequences:** Anything new that opens beside a conversation goes in this
slot. A pane header's trailing controls go through `IconGroup` rather than a
wrapper of their own, so their spacing and folding stay in one place.

### 2026-10-13 — Tile badges name themselves on hover

**What changed:** A `TileBadge` takes an optional `label`, drawn as a tooltip
on the badge's fill; Channel and thread badges set it to their names. A nested
badge's parent moves in 5px instead of 2px, so it shows above and left of the
nested badge. A breakout row's second line drops its `↳`, starts with the
thread's name, and puts a right chevron between it and the Channels' names.

**Why:** The product owner asked for both badges of a breakout's tile to say
what they are, and for the middle badge to show more of itself; at 2px the
nested badge hid most of it. The product owner also asked for the arrow on
the second line to go; the nested tile already marks the row as a breakout.

**Considered and rejected:** The tip on the badge's ring, the outer element.
The nested badge sits inside its parent's ring, so hovering it would open both
tips at once.

**Consequences:** A badge's tip must stay on its fill. A badge drawn without a
`label` shows no tip, so a new caller of `TileBadge` has to name it to get one.
The 5px inset covers more of the tile under the parent badge; a deeper nest
would need the geometry worked out again.

Shipped in [#1208](https://github.com/juno-ai-labs/avalon/pull/1208).

### 2026-10-13 — Channel rows count new threads only; no Archived list

**What changed:** A Channel row's second line no longer reads "N threads". It
is empty until a thread is placed in the Channel since the person last opened
it, and then reads "N new threads" in red, beside the unread dot. The
folded **Archived** section and its **Restore** under the Channels list are
gone. The time's tooltip reads "Last update at <time>", and the Pinned
heading's pin always has a tooltip: how to pin until two rows can be
reordered, then "Drag to reorder".

**Why:** The product owner asked for all of these. A total thread count said nothing
the person could act on, while the count of new ones is the reason to open
the Channel. The Archived section was clutter at the foot of a list people
scan often.

**Considered and rejected:** Deriving the count on the client from the
waterline and read position, capped at `threadCount`. A placement moved out
keeps its number, and `threadCount` leaves out private threads a member sees
as locked rows, so the derivation both overcounted and could draw a Channel
with new private threads as read. The server counts `newThreadCount` instead
([`spaces.md`](spaces.md#changelog)).

**Consequences:** There is no way left in the app to restore an archived
Channel; `restoreSpace` and the inactive Space directory stay in the API and
the socket for whatever brings that back.

Shipped in [#1205](https://github.com/juno-ai-labs/avalon/pull/1205).

### 2026-10-13 — The Channel feed reads thread-first

**What changed:** Each thread in a Channel's feed is a trailing-side entry:
title and caret, a three-line description, the starter's avatar and when, and
the thread's own mark beside it. The whole entry opens the thread, replacing
the breakout-style chip. Day separators split the feed, and it fades under the
pill. `formatDayLabel` names the day; the sidebar's activity time now reuses it.

**Why:** The product owner shared a design for the feed (thread-first, no
bubble) and asked for Channels to match it. The chip made the title a small
control under the description; the thread is the thing in a Channel, so its
title leads.

**Considered and rejected:** The design also shows "merged by" rows, where a
thread's outcome is posted back into the Channel with any document it made.
No such event exists on the server or in the feed contract, so the client
does not fake one; it waits on that work.

**Consequences:** The feed no longer uses `BreakoutChipRow`, so a change to
the chip does not reach it. The entry's accessible name is the chip's (title,
news, "Open"), so the feed reads the same to a screen reader.

### 2026-10-13 — The thread menu drops its Channels row

**What changed:** A thread's title-pill menu no longer has a **Channels** row
or level, so the desktop no longer lists, adds or removes a thread's Channel
placements from it. `lib/thread-channels.tsx`, the `channels` prop of
`ChannelMenu`, and the client's `addChannelToSpace` and
`removeChannelFromSpace` went with it.

**Why:** The product owner asked for the row to go. The reasoning beyond that
was not recorded.

**Consequences:** The desktop has no way to add a thread to another Channel or
take it out of one. The server routes stay for older desktops, so bringing
placement editing back needs only client methods and a UI. Such a change
should decide where that UI lives rather than restore this row by default.

Shipped in [#1204](https://github.com/juno-ai-labs/avalon/pull/1204).

### 2026-10-12 — The Channel menu gains Copy link and More; its icon picks its look

**What changed:** The Channel menu's tiles are now Add people, Rename, Copy
link and More, the same four a thread's menu has. Its two switches and
**Archive channel** moved from the root into More, under an **Icon** row,
and **Private to its members** became **Public to organization**, the same
switch, the same way round, as a thread's. The
Channel pill's icon opens the same icon-and-colour picker in place, as a
thread's icon already did, and the pill draws the Channel as the sidebar's
squircle tile (`ChannelGlyph`), as a thread's pill draws its circle. General gained Rename: the client had hidden it,
though the server refuses only archiving General or making it private.

**Why:** The product owner asked for the Channel and thread menus to match,
and for a Channel's look to be changed from its mark. A space's icon and colour
are not a patch on the server: `PATCH /spaces/:id` takes name, icon and colour
together. So the screen sends every presentation write, picks and renames
alike, through one queue, each built from the last one sent for the same
Channel. Without it, an icon picked and then a rename sent before the first
save answered would send the old icon back.

**Considered and rejected:** Making `PATCH /spaces/:id` accept any of the three
fields and apply only those present, which would drop the queue. It is a
contract and server change to a write path other clients use, larger than the
menu change it would serve; the queue is a few lines in one component.

**Consequences:** Any new write of a Channel's name, icon or colour from this
screen must go through `writePresentation`, or it can undo a pick or rename
still in flight. The pending presentation is keyed by Channel id because the
header stays mounted from one Channel to the next. If the endpoint becomes a
patch, the queue can go.

Shipped in [#1202](https://github.com/juno-ai-labs/avalon/pull/1202).

### 2026-10-12 — Threads loses its New thread button

**What changed:** The Threads header no longer carries a **+**. The composer's
`focusComposer` navigation state, which only that button set, is gone too. The
list's heading reads **All threads** instead of Recent, which also named one
of its sorts.

**Why:** The product owner asked for it removed. A thread starts from a
Channel's composer and nowhere else (the PRD's non-goal 6), so the button only
jumped to a Channel the person could open from the Channels tab.

**Consequences:** A later change that brings the button back has to restore a
way to focus an already mounted composer.

Shipped in [#1201](https://github.com/juno-ai-labs/avalon/pull/1201).

### 2026-10-12 — A breakout's tile nests its thread and Channel

**What changed:** A breakout row's tile is badged with its thread, and the
thread badge carries the Channel on its own corner. `TileBadge` gained an
optional nested `badge`, drawn 15px in the same ring. The thread badge moves
in so the nested badge's corner matches a lone badge's, keeping every row's
corner in one place.

**Why:** The product owner asked for nested badges on breakouts. With
Channel badges alone, a breakout's tile looked like a thread's, and only the
second line said where it sat.

**Considered and rejected:** The thread and Channel side by side as two
corner badges: that reads as two containers of the breakout, not one inside
the other.

**Consequences:** A breakout tile names one Channel, its thread's first; the
second line still names them all. Nesting is one level: the 15px badge has no
room for another.

Shipped in [#1200](https://github.com/juno-ai-labs/avalon/pull/1200).


### 2026-10-12 — Shape says Channel or Thread; rows carry tiles and times

**What changed:** The section switcher draws outlines instead of icons; every row in the three lists is one layout around an
`IdentityTile`, a squircle for a Channel and a circle for a Thread, a thread
badged with its Channels and an Activity row with who acted. Thread rows gain
their time and lose the run-state dot. The panel header gains New channel,
New thread and Mark all read, and Activity gains All, Unread and Mentions.
Showing Activity no longer reads it; Mark all read does.

**Why:** The founder's sidebar mock (4a, "squircle channels, circle threads")
makes the two kinds of thing easy to tell apart at a glance, since the redesign put
both in lists that look alike. The product owner chose unread only on a
thread row: the run state is the thread's to show, and the row answers whether
there is something new for this person. Reading Activity on open emptied
the Unread chip on the first refetch, so the product owner moved the read to
Mark all read.

**Considered and rejected:** A client-side Mentions filter: mentions are
sparse and paging could show an empty list with more behind it. The mock's
58px rail: macOS 26 draws a 60px group of window controls, which cannot sit
centred in it, so the rail keeps the 76px the main window centres them over.
Painting a badge's symbol white on the hue: in the dark appearance the ink is
light, so the badge inverts the pastel pair instead.

**Consequences:** A new list row uses `RowLayout` and `IdentityTile` rather
than its own grid. A thread's run state is no longer visible in the sidebar
([`workstream-markers.md`](workstream-markers.md)). The Activity query key
carries its filter (`['activity', 'all' | 'mentions']`), so invalidating
`['activity']` still reaches every chip.

Shipped in [#1199](https://github.com/juno-ai-labs/avalon/pull/1199); PRD:
[Channels, Threads, and navigation](PRDs/2026-10-10_channels-threads-navigation/prd.md).

### 2026-10-12 — The sidebar takes back what the redesign dropped

**What changed:** Rows are links again, thread rows warm their socket on hover
and start the open-latency measurement on a click, and guests lose the
Channels section. `telemetrySurfaceForPath` now recognizes
`/channels/:id/threads/:id`.

**Why:** The redesign left these out without a decision in its PRD. Every open
was cold, and open latency went unmeasured, because the route parser only
knew `/workstreams/:id` and dropped every open from the new route.

**Considered and rejected:** The hover preview card, the "Mark all as read"
group menus and scroll-position memory, left out on request.

**Consequences:** A new route that shows a thread must be added to
`telemetrySurfaceForPath`, or opens to it are dropped.

Shipped in [#1197](https://github.com/juno-ai-labs/avalon/pull/1197).

### 2026-10-10 — A section switcher and a pane stack replace the Space sidebar

**What changed:** The sidebar is a rail of three sections (Threads, Channels,
Activity) beside one list. The Space pills, the All filter, the attention
pop-out, the Space dashboard and the Space-scoped new-channel screen are
deleted. A Channel has its own screen, and a thread opens beside it; opening a
breakout or a panel moves the Channel into the first breadcrumb
(the pane stack, retired 2026-11).

**Why:** The hierarchy became Channel, thread, breakout
([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)). People need to
find a Channel quickly and pop into a thread quickly, and a thread list is
where a person goes back to their own work. The 2026-10-01 entry removed three
stacked rails because they spent the window on navigation; the switcher keeps
one list on screen and changes which list it is, so that reasoning holds.

**Considered and rejected:** Keeping the Space pills as a filter over the
Channels list: Spaces are hidden for now. A Channels list with a Recent sort
and a "new threads" count: the product owner asked for A–Z only and no count.
Within the same change that was revisited once a Channel gained its own unread
state: a row now carries a dot rather than a count, and the sort control came
back with A–Z as its default so the list still opens in the order asked for.

**Consequences:** The attention count moved from a pop-out to the Threads
button; its definition did not change. Old Space links redirect to the
Channel they now are. The sidebar's list motion was not carried over: rows in
the three lists move without animating, a scope cut made to ship the switch,
and [`list-motion.md`](list-motion.md) says what bringing it back takes. Menu
copy follows the product words: the thread menu ends with **Archive thread**,
a breakout's header offers **Show in thread**, and a thread menu gained a
**Channels** level, since a thread may sit in several Channels.

### 2026-10-08 — Settings sections are a sheet at phone width

**What changed:** At 640px and narrower, Settings drops its two columns. The
sections list is a sheet under the header, toggled by a menu button there, and
open when Settings opens. Each row stacks its label over its control.

**Why:** On a phone the 174px list left the page about 200px wide, so rows
wrapped a word to a line and fields were cut off. Even at full width a row
split into label and control left each side too narrow.

**Considered and rejected:** Opening on the Account page with the sheet shut.
On a phone the list is how a reader finds the page they came for, so starting
there saves a tap; a link that names a section still opens on that page.

**Consequences:** The open state lives in the Settings screen, not
`useUiStore`, since only that screen reads it. Like the shell's sheet, the open
sheet makes the page behind it inert and shuts on Escape, returning focus to the
button; both apply only at phone width, where the sheet covers the page.

Shipped in [#1174](https://github.com/juno-ai-labs/avalon/pull/1174).

### 2026-10-08 — A Breakout waiting on a question is badged in Main

**What changed:** A Breakout whose run is paused on a question shows a red
**Needs input** badge on its chip, and its tick's card says "Needs input". The
badge outranks an unread count and clears when the question is answered.

**Why:** A new user answered a Breakout's question only by finding it in the
Breakout; Main showed the same "New" it shows for any reply. They asked for a
blocked Breakout to look blocked from Main. Before the fix in
[#1164](https://github.com/juno-ai-labs/avalon/pull/1164), Main showed the
question itself, which it could not answer.

**Considered and rejected:** Showing the question in Main again, routed to the
Breakout. Main would then repeat every Breakout's questions to people who may
not be members of a private one, which is the leak #1164 closed.

**Consequences:** The badge reads `harnessStatus` the parent already projects
to each Breakout's members, so a guest outside a private Breakout never sees
it, and there is no new field or server change. The open Breakout reads its
own detail, which is newer than its row. A row built from the
shared-parent navigation alone carries only `needsAttention`, so it shows
"New" rather than the badge until its live directory entry arrives.

Shipped in [#1171](https://github.com/juno-ai-labs/avalon/pull/1171).

### 2026-10-07 — Switching Spaces keeps the phone sheet open

**What changed:** At phone width, a pill that leaves the open Channel for its
Space's first Channel (or its new-Channel screen) no longer closes the sheet.

**Why:** A reader picks a Space to browse its Channels. Closing the sheet on
that hop dropped them into a Channel they never chose, and they had to open
the menu again to pick the one they wanted.

**Considered and rejected:** Not navigating at all on a phone. The open
Channel would then sit behind a list that no longer shows it, and closing the
sheet would land somewhere the pills do not match.

**Consequences:** The pill's own navigation sets a one-shot flag the
route-change effect consumes, so every other route change still closes the
sheet.

Shipped in [#1158](https://github.com/juno-ai-labs/avalon/pull/1158).

### 2026-10-07 — With no Spaces, the browser folds New space into the top bar and drops All

**What changed:** In a browser tab wider than the phone layout, when the only
Space is General, `SpacePills` portals **New space** into a slot at the end of
`SidebarTopActions` (`inlineTarget`) and draws no strip, so **All** is gone
too. The first Space, or a restore, brings the strip back; archiving the last
folds it again.

**Why:** A new Organization's second row held one button and an All filter
that filters nothing, and cost a row of height for it.

**Considered and rejected:** Doing it on the Mac app too, where the top bar
shares its space with the window controls. Moving the whole `SpacePills`
between the two places, which remounted it and dropped an open archive or
restore dialog when the window crossed the phone breakpoint; only the button
moves now.

**Consequences:** The New space menu itself still remounts when it moves, so a
create-space form open while the window crosses 640px closes.

Shipped in [#1148](https://github.com/juno-ai-labs/avalon/pull/1148).

### 2026-10-07 — Add people invites guests; Share and the Space header leave the title menu

**What changed:** The People level's search takes email addresses. Enter adds
anyone already in the Organization and invites any other address as a guest
of that Channel or Breakout, without closing the menu, and pending invitations
list beside the participants with **Cancel invite**. The **Share** tile, the
scope row with **Change**, the Channel menu's **In space** header and **Copy
channel email address** are gone. The Channel's More gains **Icon and
color**, as the Breakout's has.

**Why:** Share and Add people were two doors to one job, inviting someone in,
and Share's dialog closed after each send. Folding the guest invite into the
People search makes one place to bring anyone in, and keeping the menu open
lets several be added in a row. The scope row repeated what **More** already
switches, and the Space header pushed the actions down for a link the sidebar
already gives.

**Considered and rejected:** Keeping the Share dialog behind the tile. It
duplicated the People level and could not show members and invitations
together.

**Consequences:** `useScopeInvitations` is the one client for a
conversation's invitations; the share panel and the People level read one
cache entry, so a cancel in either shows in both. It keeps one retry id per
batch, so a retried invite replays its own operation rather than making a
second. A submission's adds run in order because each add returns the whole
roster and the cache takes the last one to arrive. The roster dialog
(`AddParticipantDialog`) is no longer reachable from the title menus.

### 2026-10-07 — The phone menu button shows when the sheet is open

**What changed:** At phone width the menu button turns from a menu glyph into
a close mark while the sheet is open, and wears the same 32px raised round
fill as the top actions beside it.

**Why:** The button looked the same open or shut; only its accessible name
changed. The open sheet covers the screen, so the button's one job then is to
close it, and a close mark says so. Without a fill it was the one bare control
in a row of round buttons.

**Considered and rejected:** Tinting the button while open. It reads as a
pressed or hover state, and sits next to the red attention count. A
sidebar-collapse glyph, which suits a sidebar beside content but not a sheet
over it.

**Consequences:** Both glyphs stay mounted and CSS keys on `aria-expanded`, so
the state the button shows cannot drift from the state it announces.

Shipped in [#1134](https://github.com/juno-ai-labs/avalon/pull/1134).

### 2026-10-07 — No Mac download on phones and tablets

**What changed:** The browser no longer passes **Download the Mac app** as a
footer item on iOS, iPadOS or Android. Connectors a browser cannot start say
**Connect this from the Mac app.** there, as plain text, instead of linking the
download.

**Why:** A phone or tablet cannot run the Mac build, so the row was a dead end
in a footer with little room.

**What to respect:** iPadOS reports itself as a Mac; only a touch count above
one marks it, so a check on the user agent alone would show the row there.

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
