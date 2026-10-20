# Shared collaboration UI

`@rally/ui` owns the collaboration presentation used by desktop, the lite
browser, and the Sideline internal host. Desktop's current UI is the reference;
each smaller host supplies fewer actions to the same components rather than
drawing a second design.

## Where the code lives

- `packages/ui/src/components`: the shell pieces ([`desktop-shell.md`](desktop-shell.md):
  title pills, the thread, Channel and Breakout menus, Breakout chips and
  ticks, the split layout), navigation frame and rows, resource rows, Sidekick
  section/picker, account trigger, glyphs, avatars and visual primitives — and
  a Channel's mark, `space-icon.tsx` (`SpaceIcon`). A measured share is drawn
  by `Meter` in `primitives.tsx`: a track and a fill, `role="meter"` (or
  `progressbar` for a task moving towards done) with its value attributes, a required label, and a `normal` or `warning` tone, painted
  from the `cmp.meter.*` tokens. The Organization usage line and the onboarding
  checklist both use it, so a new bar adds no CSS. The
  icon catalog's glyphs are `appearance-icons.ts` (`APPEARANCE_ICON_COMPONENTS`)
  and its sectioned grid is `icon-catalog.tsx` (`IconCatalog`), drawn by
  `AppearancePicker`, the one picker a Space and a Channel both open.
- `packages/ui/src/lib`: browser-safe display helpers, theme application and
  device preferences. `packages/ui/src/styles` owns the shared styles/tokens.
- Desktop renderer adapters retain routing, UI stores, IPC, telemetry and data
  queries. Existing import sites re-export shared primitives during migration.
- Sideline composes `SidelineComposer` and `SearchSelect`; its adapter owns
  authentication, catalog reads, send requests, and native Rally handoff.
- The next stacked browser host supplies email entry, cookie session restoration,
  its scoped directory and selected-conversation data. Those screens are not in #824.

The application error boundary is shared, with host-specific error reporting.
The collaboration adapter uses the existing API query defaults: no focus refresh
unless a query opts in, and no retry for a rejected 4xx request.

## How it works

Shared components receive presentation data and callbacks. They never import an
application, fetch authority, establish sockets or call Electron. Optional actions
represent host capabilities; omitting setup and authoring actions keeps the browser
lite. The common feed/composer and resource/participant dialogs remain the existing
ConversationSurface implementation.

The sidebar can omit Main without inventing an accessible Main route. Browser
participants and resources belong to the selected authorized conversation; desktop
can continue supplying parent-owned workstream context. Directory appearance comes
from canonical reads and preserves the existing Main-label boundary.
Desktop and browser both mount the one non-collapsing `ResizableSidebar`
(`collapsible={false}`) and compose the plain `SidebarFooter` with an account
slot ([`desktop-shell.md`](desktop-shell.md)). `SidebarCollapseFooter` and the
primitive's compact layout remain only for Sideline, the one host that still
collapses. A host that keeps a sidebar's width (and, for Sideline, its
collapsed state) across launches does it through `lib/sidebar-preferences.ts`
under its own local-storage keys. A missing or unreadable width falls back to
the default, a readable one is clamped to the sidebar's limits, a missing
collapsed flag reads as expanded, and a refused write leaves the in-memory state
standing.

`SidebarRow` still accepts an optional count `badge`, but no host passes one:
the Channel row's count badge was replaced by its unread treatment
([`workstream-markers.md`](workstream-markers.md#channel-row)).

The desktop's pinned section marks itself `data-reorder-list`: a row finds the
slots it is being measured against through that mark rather than by knowing
whose list it is in. A drag's end reads the browser's `none` operation as a
release nothing accepted, including Escape and release outside the list.

The shared Breakout rail, `SpaceRow` and `SpacePlacementList` were removed with
the shell redesign. Breakouts are listed in the Channel title menu
(`ChannelMenu`'s Breakouts level), newest activity first with
`compareAlphabeticalTitle` breaking ties. The Space pills and the Space
dashboard were deleted with the navigation redesign; a Channel's row and screen
are the desktop host's ([`desktop-shell.md`](desktop-shell.md)). Nothing here
fetches, and no component infers a capability from an omitted prop: a Channel
menu with no privacy switch is a host that decided not to draw one.

The guest browser supplies its bounded sharing projection to the same
`ResizableSidebar`, rows, scroll regions and resize geometry as Electron. It
still owns its browser routes, account menu, unsupported-width state and
guest-only loading copy, and it omits management actions that the sharing
projection cannot authorize. At the existing 920px responsive boundary and
below, the host shows an unsupported-width state instead of presenting a
compressed or partial hierarchy.

`MarkBridge` draws a row of `IdentityMark`s as one tinted glass shape, each
mark a control with its own tooltip. The caller supplies names and actions;
the bridge knows nothing about routes. `trailing` joins a control through one
more neck; that control paints itself and stays mounted as ancestor marks load.
`TitlePillHeader` uses it to attach
icon-only ancestors to the existing command pill, preserving its appearance
picker, title popout and separate hover targets. Levels without marks retain
the existing ancestor-pill fallback.

A mark may carry a `menu` of the objects it stands for instead of `onSelect`.
At phone width, past two crumbs, the header folds all but the nearest into one
"…" mark (`Show path`) listing them, so the bridge stays two crumbs wide.

`TitlePillLeadingContext` lets a host supply controls before the breadcrumb.
Electron supplies its history bridge; other hosts leave the slot empty.
`TitlePillLeading` renders the slot in both loaded and opening headers.
A `MarkBridgeItem` may be `disabled`, which disables its action button while
retaining its accessible name.

A title pill's menu always opens below the pill. Its bottom edge never counts
as a Radix collision, so the menu never flips above; its sides still do, so it
shifts to fit a phone's width. Opening it blurs any focused input, textarea or
editable region first, so a phone's keyboard drops.

Theme application stamps the same `data-theme` attribute before rendering, and writes
the applied canvas into any `theme-color` meta the host document carries. Desktop
installs the native theme reporter/broadcast adapter; browser and Sideline install system
appearance observation. Visual primitives share the same theme subscription.

Sidekick management options are requested when management controls open. Transcript
updates continue refreshing existing attachment/recommendation state, but do not
fetch management choices. Canonical management denial hides the picker; unresolved management capability disables
creation and shows a loading row menu only for eligible rows. Attachment updates
seed the selected cache and invalidate siblings without discarding the new seed.

## Invariants

- Shared components import no application, IPC, authentication or transport code.
- Hosts reuse the same semantic styles and presentation elements.
- Host callbacks perform mutations through existing admitted application paths.
- Child-only sharing must not expose Main labels or resource context. Guest hosts
  use the selected conversation socket and omit desktop parent prewarming.

## Boundary

This package owns presentation, display helpers and the theme runtime. Host adapters
own query/cache state, navigation, sockets, authorization and native capabilities.
The existing ConversationSurface still owns the shared feed/composer and dialogs;
this package does not create a second collaboration implementation.

## Failure modes and limits

Omitted capabilities omit their controls. Loading, empty and error states must be
supplied distinctly by host adapters; presentation cannot infer authority from a
missing response. Sidebar and menu error contracts carry state, never transport,
provider, or server messages: presentation owns stable product copy while rich
failure details stay outside its contract. Shared browser-safe theme defaults
apply before first render.
Native theme reporting and cross-window IPC belong only to the desktop adapter.

## Testing

Run `pnpm lint`, `pnpm typecheck`, and `pnpm --filter @rally/desktop exec vitest run
src/renderer/components/sidekick-picker.test.tsx
src/renderer/components/sidekick-section.test.tsx` (as one command). The desktop
suite imports the real shared implementations through their re-export adapters.
Run `pnpm --filter @rally/desktop exec electron-vite build` and inspect the changed
surfaces in Electron. The browser host in #825 adds Chrome verification; no second
component test runner is needed for the same implementations.

## Changelog

### 2026-10-20 — Breadcrumbs attach to the command pill

The product asked for the resource path to sit with the current command pill,
with ancestors as icons and the current pill's appearance and two hover targets
preserved. The header therefore attaches its marks through `MarkBridge`, with
a fixed glass cap beneath the pill. The attached pill omits its standalone
outline, which otherwise cuts across the glass neck; its fill, shadow and hover
targets stay. The pill fill fades in over its left cap so the shared tint
blend remains visible between every adjacent member. A separate raised
connector would leave overlapping rims and
shadows. The backing fades under the cap so the pill keeps its fill and shadow;
future changes must preserve its independent appearance
picker and command popout. No labels or trailing-width measurement remain:
the only visible trailing glass is that fixed cap, regardless of title length.
The pill stays mounted when ancestor metadata arrives, preserving open menus;
the SVG paths fade before filtering so the crumbs keep their full shadow.

### 2026-10-15 — A meter fills in the text colour, not the brand

**What changed:** `cmp.meter.fill` is `sys.color.text.default` in both themes,
where it was `sys.color.brand.base`, and Settings' own override to the text
colour is gone. The product owner asked for a standard theme colour rather than
the volt brand yellow on the Quota bar. The value sits in each theme file, not
`base.json`, because a base token may alias only base tokens.

### 2026-10-13 — Title pill menus never open upward

**What changed:** The title pill's menu passes Radix a collision padding with
no bottom edge, so it always opens below the pill.

**Why:** On a phone, tapping the pill with the keyboard up (the composer
focused) shrinks the visual viewport, which Floating UI measures, while the
menu's `100vh` cap does not shrink with it. The menu no longer fit below, Radix
flipped it above, and nothing re-placed it when the keyboard dropped, so it
opened upward with its top cut off. The pill sits at the top of its pane, so
above is never the better side.

**Considered and rejected:** `avoidCollisions={false}`. It turns off the
sideways shift too, and the menu then overflows a phone's edge when the pill
is off centre.

**Consequences:** When the room below is short, the menu runs past the
bottom of the screen rather than flipping; its `max-height` is what bounds it.

Shipped in #1222.

### 2026-10-17 — A phone folds crumbs past two into "…"

**What changed:** `MarkBridgeItem` can carry a `menu`, which the mark opens as
a dropdown instead of running `onSelect`. At phone width `TitlePillHeader`
folds a bridge of more than two crumbs into a "…" mark listing all but the
nearest, then the nearest.

**Why:** A panel opened from a breakout stands alone on a phone and carries
Channel, thread and breakout. Beside the menu button, the title pill and the
trailing buttons, three crumbs left the panel's name a few letters wide. The
product asked for at most two items: "…" with a dropdown, and the last.

**Considered and rejected:** A separate "…" button beside the bridge, which
would have been a second shape where one glass row reads as one path.

**Consequences:** The fold is phone-only; wider headers keep every crumb, the
nearest named. A folded crumb is reached by its menu row, which shows its
symbol and name; its tooltip is gone with its mark.

### 2026-10-13 — Crumbs are always a `MarkBridge`

**What changed:** `TitlePillHeader` draws its ancestors as a bridge at every
width when each has a mark. It used to draw them as pills and switch to the
bridge only below a pane width (460px for one crumb, 760px for two).

**Why:** Between those widths and the room the names needed, the pills shrank
instead: a lone Channel crumb beside a thread with a panel open closed to a
bare round pill with no tooltip, its icon 2px off centre because the pill's
padding was cut for an icon and a name. The product asked for the bridge at
all times, so one crumb looks the same in every window.

**Considered and rejected:** Measuring whether the pills' names fit and
bridging only when they do. It removed the squeezed pill but kept two looks for
the same crumb, which the product did not want.

**Consequences:** The pill path for ancestors runs only while a level lacks a
mark (a Channel whose appearance has not loaded); the narrow-pane rules that
hide its name remain for that case alone. The bridge names the nearest crumb
on desktop and ellipsizes it to its column, and shows marks alone at phone
width, as before. A mark only opens its level: an ancestor's menu (a thread's
rename, Sidekicks and breakouts beside an expanded breakout) is reached by
opening that level, which the product chose over giving marks a menu. Narrow
panes already worked this way.

Shipped in #1218.

### 2026-10-13 — `MarkBridge` can name its last mark; a lone crumb bridges

**What changed:** `labelLast` stretches the last mark into a pill holding its name, its ends still the circles' radius and its neck to the mark before unchanged. `TitlePillHeader` now bridges one crumb as well as two (below 460px for one), and names the nearest crumb on desktop. On a phone the name is hidden and the crumbs are glass marks alone, where a thread's Channel crumb was a bare round pill.

**Why:** The phone thread header showed its Channel as a plain circle beside the glass shapes a breakout's crumbs got, and a bare mark does not say which Channel it is. The bridge's two-crumb rule dated from the shape it replaced, which only ever joined two.

**Considered and rejected:** A fixed label width, which breaks on any other name or font; measuring with a hidden copy of the text, where measuring the laid-out label needs no second element.

**Consequences:** The shape is measured after layout (`ResizeObserver` on the label and the bridge), so a caller sees one layout pass with the label before the glass fits it. The bridge asks for the name's full width but never grows past its container: Channel and thread names run to 180 characters, so a long one ends in an ellipsis and the pill is drawn to the width the container gave. The circles never shrink. The tint gradient spans the circles and holds the last tint across the stretch.

Shipped in #1209.

### 2026-10-13 — `MarkBridge` fuses a row of marks into one tinted glass shape

**What changed:** `MarkBridge` is new, with `IdentityMark` and its two
builders beside the tile they describe. A breakout's collapsed Channel and
thread crumbs use it.

**Why:** Two loose round buttons read as two unrelated controls; one shape
reads as one path, and the outlines say Channel or thread before a name does.
SVG gradients interpolate in sRGB, which drags two hues through grey, so each
neck's blend is cut into stops mixed in OKLCH. It is its own component so any
row of related objects can use it.

**Considered and rejected:** A CSS goo filter (blur and threshold), which loses
the hairline edge and the sheen; a flat capsule, the first pass, which did not
read as joined marks; drawing the shape behind the existing pills, which tied
its geometry to the pills' CSS.

**Consequences:** The sheen stops above the symbols so each ink sits on its
raw tint, the colour its contrast was measured against. Its tooltips are not
hoverable: a hoverable tip held open over the next mark, 6px away, blocked
that mark's tip.

Shipped in #1203.

### 2026-10-05 — The sidebar's minimum width fits five top-bar buttons beside the traffic lights

**What changed:** `MIN_SIDEBAR_WIDTH` is 306px, up from 240px. A saved width
below it is raised on the next launch by `sidebar-preferences.ts`'s clamp.

**Why:** The attention menu ([`attention-menu.md`](attention-menu.md)) made
the top bar four buttons, five while an update waits. On macOS the bar starts
at 100px to clear the traffic lights (82px inset plus 18px padding) and keeps
14px on the right, which at 240px left 126px for buttons that need 192px
(5 × 32px plus 4 × 8px gaps). 306px fits five 32px buttons; the attention count
stays inside its 32px button by showing 99+ past two digits. The
bar had already overflowed by 26px whenever an update was waiting. Every host
shares the constant, so the web (no inset, no import) and Sideline (no
attention menu) carry a minimum sized for the macOS bar; a per-host minimum is
the change if that cost matters. `loadSidebarWidth` now clamps its fallback
too, because Sideline's 280px default sat below the new minimum.

**Considered and rejected:** Hiding the import button at narrow widths, and
tightening the gaps to 4px, which saves only 16px.

**Consequences:** A sixth top-bar button needs this number raised again, by
40px. Sideline shares the constant: its sidebar now holds at 306px while a drag
continues down to the 210px collapse threshold.

### 2026-10-03 — One Meter primitive for every measured share (#1086)

**What changed:** `Meter` is new in `primitives.tsx`. Settings → Organization →
Usage and the Organization menu draw the weekly quota with it, and the
onboarding checklist's one-off `.onboarding-progress` bar is replaced by it.

**Why:** The usage quota PRD needs the same bar in two sizes and two tones, and
the onboarding bar was already a hand-rolled copy of it with its colours named
inline. A third copy would have been the next drift. Its colours are the new
`cmp.meter.*` tokens: in light a settings card is the same `#f3f3f3` as the
sunken surface, so a meter on `sys.color.surface.sunken` lost its empty track,
and the light track is `ref.color.neutral.5` instead.

**Considered and rejected:** Darkening `sys.color.surface.sunken` in light,
which every other sunken surface reads. A second primitive for progress: the
drawing is the same, so `role` is a prop.

**Consequences:** A meter with no value yet draws its empty track hidden from
the accessibility tree rather than claiming zero, so a caller shows its own
loading text beside it. The label is required by the type.

### 2026-09-30 — One helper keeps a sidebar's size across launches

**What changed:** `lib/sidebar-preferences.ts` holds the load, clamp and save
that Rally's desktop store wrote out once per sidebar. The desktop store now
calls it with its existing keys, and Sideline's sidebar uses it under
`sideline.sidebar-width` and `sideline.sidebar-collapsed`, so Sideline opens at
the size it was left.

**Why:** Sideline's sidebar reset on every launch. Copying the desktop's
functions into a second host would have made three copies of the same
best-effort storage handling.

**Considered and rejected:** Sharing the desktop's keys with Sideline. The two
apps size their rails independently, so each keeps its own keys.

**Consequences:** The desktop keys are unchanged, so saved sizes carry over.
A new host that persists a sidebar should call this helper rather than touch
local storage itself.

PR [#1034](https://github.com/juno-ai-labs/avalon/pull/1034).

### 2026-09-22 — The shared Breakout rail owns stable alphabetical order

**What changed:** `WorkstreamSidebar` sorts named Breakouts with the shared
fixed-locale title comparator, keeps Main first and creation last, and no longer
accepts or reports `substreamDrag` gestures.

**Why:** A navigation directory should put the same destination in the same
place between visits and across the desktop and browser hosts. Host-owned
personal order made the shared component's visible behavior depend on adapter
state and preserved a gesture that contradicted alphabetical navigation.

**Considered and rejected:** Leaving ordering to each host would let the browser
and desktop drift while using the same component. Runtime-locale collation and
base-only title comparison were also rejected because locale differences and
equal titles would fall back to source activity order.

**Consequences:** Hosts cannot rearrange Breakouts through this component.
Stored Channel-container arrangements remain compatibility data, and native iOS
is outside this React shared-component contract.

### 2026-09-22 — Hierarchy rows have one secondary-text contract

**What changed:** `SidebarNavigationRowContent` now accepts one optional
`activity` value beneath its title. The shared component owns that line's muted
type and spacing for Space, Channel, Breakout, resource and Sidekick rows.

**Why:** The shared row exposed both `description` and `activity` for the same
visual slot. Descriptions inherited a seven-pixel hint margin while timestamps
did not, so adjacent hierarchy rows had two title-to-secondary-text rhythms.

**Considered and rejected:** Preserving both names and merely matching their
CSS. Two props for one slot would keep an unnecessary choice at every caller
and allow their presentation to drift again.

**Consequences:** Secondary row copy is activity regardless of whether it names
scope, time, state or resource metadata. Callers provide content; the shared row
alone decides its presentation.

### 2026-09-21 — Sideline composes shared presentation as a third host

**What changed:** `@rally/ui` now owns the represented-message card stack,
searchable selectors, semantic request states, and token-based styling consumed
by Sideline.

**Why:** A small internal sidecar still needs Rally's theme, accessibility, and
interaction behavior. Copying the desktop stylesheet would make every visual
fix depend on synchronizing another product-shaped implementation.

**Considered and rejected:** Sidecar-local controls and CSS. They would turn a
host adapter into a second design system even though the host-specific work is
only authentication, native lifecycle, and API calls.

**Consequences:** Sideline presentation remains browser-safe and callback-driven;
authority, Electron, and network code cannot enter the shared component. Future
host-neutral card improvements belong here.

Design: `docs/PRDs/2026-09-19_impersonation-platform/prd.md`.

### 2026-09-21 — Collapse footers become one layout primitive

**What changed:** The Space, Channel and Breakout sidebars now compose
`SidebarCollapseFooter`. It owns their toggle button, icon swap, accessible
expanded state, constrained state and footer layout. A toggle-only footer has
one shared compact destination that centers its 30px control using animated
padding; a footer with leading account content keeps the two-control layout.

**Why:** The Channel and Breakout rails reached the same visual result through
different sidebar-specific CSS, while Spaces built the same footer structure in
a third component. The Channel rule had drifted and left its compact toggle at
the trailing edge. Fixing that selector alone would preserve the mechanism that
caused the drift, so the footer structure and its two real variants moved below
all three owners instead.

**Consequences:** A hierarchy rail cannot independently choose the compact
position, icon, disabled behavior or ARIA state of its collapse control. New
leading content must use the primitive's explicit slot; new sidebar-specific
footer positioning is not part of the contract. Every footer shares the former
56px Space/browser height so its controls sit on one vertical centerline across
the three adjacent desktop rails.

### 2026-09-21 — Sidebar rows share one optional count badge

**What changed:** `SidebarRow` accepts an optional labelled numeric badge and
owns its expanded trailing-edge and compact icon-corner layouts. Non-positive
counts render no badge.

**Why:** Space and Channel attention totals are the same navigation affordance
at adjacent hierarchy levels. Host-specific markup would make their compact
overlap, padding and accessibility diverge, and would leave the prepared browser
host to reproduce the geometry.

**Considered and rejected:** Putting badges inside `SpaceIcon` and
`WorkstreamGlyph`, which would couple reusable identity marks to one navigation
state and still duplicate expanded-row placement.

**Consequences:** Any host using the shared row gets the same badge behavior by
supplying data; identity components remain usable without navigation state.
The visible count is hidden from the accessibility tree and the
labelled count is attached to the row's accessible description, so focus
announces the destination and its attention total together without exposing a
second, non-interactive element.

### 2026-09-21 — Hierarchy title headers keep one identity composition

**What changed:** `SidebarTitleHeader` now keeps a 20px Space or Channel mark in
its fixed 28px leading slot while expanded. Compact mode collapses only the
title, so both states use the same icon-first composition across desktop and
browser hosts.

**Why:** Expanded hierarchy headers named the current object while withholding
the identity mark already used by its navigation rows. Keeping the mark stable
aligns the adjacent headers and removes the visual swap during collapse.

**Considered and rejected:** Host-specific expanded icons. The shared header
already owns the layout for each host, and local copies would let their order,
size, and transition behavior diverge again.

### 2026-09-21 — Browser navigation uses the Electron hierarchy sidebars

**What changed:** The browser's Space and Channel rails now compose the same
shared resizable sidebar shell, compact geometry, edge interaction, hierarchy
headers, rows and footer collapse controls used by Electron. Selecting a Space
compacts the Space rail and leaves its Channels visible; selecting a Channel
compacts both. At 920px and below, the browser replaces the collaboration shell
with an unsupported-width message rather than compressing the hierarchy into a
mobile drawer.

**Why:** The browser had adopted the shared row geometry but still wrapped it
in two static host-owned panels. That left the same hierarchy behaving
differently by host and made Electron's compact and resize work unavailable to
browser guests. Importing the full desktop sidebar was rejected because it
would also import member-only mutations, socket state and native behavior;
sharing the complete presentation shell preserves the package's host boundary.

**Consequences:** Browser routing and its bounded sharing directory remain
browser-owned, while future geometry and interaction changes to the hierarchy
shell reach both hosts. Guest navigation still exposes no Space or Channel
management action. The browser host applies Electron's complete-hierarchy width
budget: it protects 424px for conversation content and a compact Breakout rail,
caps the Space rail to the remaining room, and forces the Channel rail compact
when its remembered width no longer fits. Returning to the workspace root
restores both outer rails; same-Channel navigation cannot leave a route fence
armed for later history navigation.
### 2026-09-21 — Hierarchy row cadence lives in one shared list

**What changed:** `SidebarList` owns the vertical spacing between hierarchy
rows, and the desktop and browser Space, Channel, and Breakout collections all
compose it inside the shared scroll primitive. Collapsing a rail changes its
horizontal presentation but not its row cadence.

**Why:** The three hierarchy levels had accumulated separate hard-coded gaps
and a Channel-only compact override, so adjacent rails changed rhythm depending
on which ones were collapsed. Fixing individual selectors would leave the same
presentation decision distributed across hosts and make the next sidebar change
able to reintroduce the mismatch.

**Considered and rejected:** A descendant selector that imposed a gap on every
child of `SidebarScroll`. Scroll bodies also contain sections, empty states, and
supporting controls; only an explicit row collection has list cadence.

**Consequences:** Every host that draws hierarchy rows, including the lite
browser, must put the collection in `SidebarList`. Local sidebar selectors do
not set row gaps; changing the shared spacing token changes all three levels at
both widths.

Shipped in #902.

### 2026-09-21 — All three hierarchy sidebars share one resize edge

**What changed:** The Space, Channel, and Breakout sidebars now compose one
shared `ResizableSidebar` shell. Each keeps its own content and remembered
expanded width, while the shell owns their compact/resizing states, motion
channel, 88px compact width, 240–400px expanded range, 210/220px collapse
hysteresis, grip, drag guide, tooltip, keyboard controls, and double-click
toggle. `SidebarHeader`, `SidebarTitle`, `SidebarRow`, `SidebarScroll`, and
`SidebarHorizontalLine` now provide the geometry inside that shell. A
`SidebarHeader` is a 43px specialization of `SidebarRow` followed by a
`SidebarHorizontalLine`, matching the message feed's 44px titlebar as a whole.
`SidebarTitleHeader` owns one stable 28px icon slot containing a 20px mark beside
the title. Compact mode collapses only the title, so header marks stay smaller
than the 36px navigation-row marks beneath them and do not swap composition;
`SidebarScroll` gives every rail the same 8px divider-to-first-row gap and the
same compact gutters. The desktop and browser hosts consume these primitives.
Space, Channel, and Breakout rows also pass their icon, title, optional detail,
and host-owned interaction through `SidebarNavigationRowContent`, so their icon
slot, copy sizing, clipping, and compact motion cannot diverge in local CSS.
The leftmost Space rail intentionally leaves the shared header title empty so
the macOS window controls and trailing create action have a clear titlebar.
The 88px compact width centers the native traffic-light group: its first button
starts 18px from the left and its last button ends 18px from the right. The
Channel and Breakout rails consume that same width.
Before the first
rail expands or resizes, the desktop shell now caps it to the width left after
the protected conversation and compact Channel and Breakout rails.

**Why:** Spaces had become the first level of the adjacent hierarchy without
receiving the resize interaction the next two levels already offered. Copying
the behavior into a third component was rejected because the visible contract
would drift again; the edge interaction now lives below all three surfaces.
Sharing only the edge was not enough: three independently sized rows and
headers could still arrive at different positions during the same transition,
so their structural geometry moved into the same package boundary too.

**Consequences:** A Space width is a device-local preference like the other
sidebar widths. Responsive calculations spend that remembered width when it
fits, cap it when the complete hierarchy has less room, and hold every
expansion control disabled when even the 240px minimum cannot fit. All three
sidebar contents consume the shell's `--sidebar-layout-motion`, while a drag
sets that channel to zero and temporarily removes only the dragged width from
the workspace transition so its edge tracks the pointer without stopping
motion on the neighboring sidebars.

### 2026-09-20 — Space rows can carry host-owned context actions

**What changed:** `SpaceRow` can wrap the visual Space row, excluding its
expanded Channel placements, in the shared Radix context-menu surface while
accepting menu items as a host-owned slot. The desktop uses that slot for the
one destructive archive action; a host without a live, admitted action omits
the menu entirely.

**Why:** Right-clicking the Space row should behave like the Channel rows beside
it while archive authority, confirmation, mutation and failure copy remain
application concerns. Wrapping the expanded placement area was rejected because
empty-state and list gutters are not the Space row; putting the archive mutation
in the shared package was rejected because that package owns presentation, not
transport or authorization.

**Consequences:** Hosts decide both whether a Space row has a menu and which
actions it contains. Expanded child rows retain their own independent targets.

### 2026-09-20 — Space rows stop advertising creation

**What changed:** `SpaceRow` no longer accepts or renders a new-Channel action,
and its layout no longer reserves a trailing action column. Hosts put creation
in their global launcher rather than attaching it to each Space row.

**Why:** Once Rally consolidated creation in the sidebar launcher, the shared
row action had no callers. Keeping it advertised a presentation capability no
host used and preserved layout around a control the product had removed.

**Considered and rejected:** Keeping an optional callback for a future host.
There is no second creation placement to model, and adding one later is cheaper
than maintaining a dead contract now.

**Consequences:** Space rows now have one presentation shape for writable and
read-only reach. A future host that needs row-local creation must make that a new
product decision rather than discovering an unused callback.

Shipped in #876.

### 2026-09-20 — The Space dashboard sheds its retired management lists

**What changed:** `SpaceChannelRow`, `SpaceDefaultList`, and their management
layout were removed from the shared package. `SpaceDashboardSection` now owns
only the titled band around the remaining Channel list, whose Channel and
breakout links the desktop supplies directly at full width.

**Why:** The landing page no longer owns Channel placement or default management,
so shared components whose only job was drawing those controls had no remaining
presentation contract. Keeping them would advertise surfaces that no host uses.

### 2026-09-19 — A Space row may be drawn without its plus

`SpaceRow` required `onNewChannel` on the argument that a host unable to start
a Channel in a Space had no business drawing the row. Rally now has such a
reader: somebody who reaches a Space only because they can read a Channel
placed in it is shown its mark and name so that Channel has somewhere to be
drawn, and every write on it is refused by name. The action is therefore
optional, and the row's grid keeps its third column so the two kinds line up.
This is the only capability the component lets a host withhold; the drag
handlers are still required, because a row that cannot be arranged is a
different component. The reasoning is in
[`spaces.md`](spaces.md#changelog).

### 2026-09-19 — Space presentation is shared; hosts keep routing and authority

**What changed:** `@rally/ui` gains the Space row, the Space appearance picker,
the Space dashboard sections and `SPACE_ICONS`, and the `.project-*` styles move
to `.space-*` with nothing left behind. `project-icons.ts` becomes
`space-icons.ts`.

**Why:** The Spaces PRD's design decision 9 puts reusable Space rows and
management sections here so the desktop and the guest browser cannot drift into
two designs, while authority, data, routing and capability decisions stay with
the host. The guest browser omits Spaces outright rather than inferring
authorization from a missing control.

**Considered and rejected:** Giving `SpaceRow` its own `NavLink` and a `to`
prop. It would have put a router in this package for one component, and the
existing `NavigationRowContent` split — contents here, link at the host — was
already the answer to the same question for a Channel row. Also rejected: two
components for the two kinds of Space default. They are one registry keyed by
`kind` on the server, and the drawing does not depend on the kind, so telling
the list which one it is drawing would have been a prop nothing reads.

**Consequences:** The `--av-sys-color-project-*` tokens and the `project` colour
helpers in `lib/project-palette.ts` stay, per the PRD's 2026-09-19 decision that
renaming them touches every glyph and avatar for no visible change; new Space
code imports them under those names. A host that wants a Space row supplies its
own navigation element, and the rename interaction is not the host's to
reimplement.

### 2026-09-18 — Sidebar failures carry state, not response copy

**What changed:** Sidebar, project, work-stream action, shared conversation
header, Sidekick picker, and inspector/resource rail boundaries accept booleans
or semantic failure states and render Rally-owned copy instead of accepting
arbitrary error messages.

**Why:** A production API-version mismatch returned its router's diagnostic
sentence directly under **Sidekicks**. Sidebar chrome is product presentation;
transport and provider wording is neither stable nor suitable for a person.

**Considered and rejected:** Sanitizing a growing list of known API messages
would still make new failures user-facing by default. Hiding failures entirely
would make a partially stale rail look authoritative.

**Consequences:** Hosts tell presentation only which operation failed. The
repository presentation boundary owns the lint mechanism and file registry;
shared sidebar and rail modules consume only these semantic contracts and own
their user-facing failure language.

### 2026-09-17 — Share desktop presentation with the lite browser

**What changed:** Desktop now renders collaboration chrome through shared
components so the next browser host can supply scoped data and omit unsupported
actions while retaining the same layout and interactions.

**Why:** The browser shell in the original combined change had already diverged
from the app. Sharing the implementations makes subsequent visual changes apply
to both hosts.

**Considered and rejected:** Copying styles into a browser-specific lookalike would
preserve that drift. Moving Electron IPC into the package would couple browser
startup to native capabilities.

**Consequences:** Visual changes belong in shared components; capability/data
changes stay in host adapters. Equivalent browser session refreshes must preserve
the API client and socket; client ownership is not a presentation concern.
