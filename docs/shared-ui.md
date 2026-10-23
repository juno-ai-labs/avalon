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

## Sidekick delegation

`components/sidekick-delegation.tsx` renders the allowed people and the shared
standing-consent/history disclosure. Desktop's adapter of the same name supplies
the API reads and actions to both desktop and web screens. Creator identity is
separate from active grants, so withdrawal retains the Creator marker without
presenting an allowed user. Remove actions depend on the owner's `canManage`
projection; they never turn a viewer into a manager. Existing identity avatars
and personal presentation are reused.

The query lives under `['automation', id, 'delegation']`, using the existing
automation invalidation and window relay. It refreshes on reconnect/focus too.
Each affected person's action stays pending through acknowledgement and a fresh
read. No grant is optimistic. A lost response triggers a read, never an automatic
repeat of the write. If that read also fails, the last confirmed list stays and
Refresh is required before another mutation. Offline actions are disabled and
never queued for reconnect. Failures use the ordinary acknowledged error popup.

New Sidekick opens a creation surface with the delegation/history disclosure;
the normal Create action submits the request. It adds no separate consent
confirmation. Leaving a pending creation does not navigate back when it finishes,
and an uncertain response sends the person to inspect their Sidekicks rather
than automatically creating another. Delegation appears inside the profile's
padded layout ahead of timing. An existing delegate can expand the full scope
explanation; a person opting in sees it before the action.

Run history preserves the coordinating user independently of the legacy run-as
field. Names reuse the delegation query already mounted by the Sidekick screen;
an unavailable historical identity retains its ID. Connector activity exposes
actual acting accounts through the existing work breakdown; [plugin activity
rows](plugin-activity-rows.md#delegated-account-details) owns that projection.

## Error popups

Operational failures across Electron and browser are acknowledged popups with
an **OK** button. Inline error messages and banners are banned. Declare
`ErrorNotice` alongside the state that owns the failure; by default it occupies
no layout space. `ErrorNoticeProvider` at each host root queues distinct
failures, merges simultaneous identical copy, and keeps an error available after its menu closes.
Standalone component hosts can render `ErrorNotice` without a provider.

Acknowledgement dismisses presentation only: drafts, failed mutations, and retry
controls remain owned by their original screen. A persistent query or mutation
passes its error object as `occurrence` so another failed attempt with the same
copy opens again. Ordinary rerenders do not reopen an acknowledged failure.
The popup owns the tooltip context for copy controls carried from a failure,
focuses OK and returns focus to the interrupted control when it still exists.
OK is its only visible close control; Escape also dismisses it. A failure inside
an existing dialog opens above it and keeps the underlying form intact.
Window paste handlers and the phone sheet's Escape handler treat alert dialogs
as owning their input, just like other dialogs. Tooltip portals render above
the popup so copy controls keep their labels visible.

Use `AcknowledgedErrorDialog` when the caller already owns explicit notice and
acknowledgement state. Existing native deep-link error windows also say OK.
Loading indicators, unavailable capabilities, and historical run/tool status are
not new error events. Keep recovery controls available after acknowledgement;
do not turn stored transcript content into a stream of popups. Use
`automatic={false}` with `detailsLabel` for stored diagram, run and connector
failures and persistent menu read failures. Details remain in an OK popup,
opened on demand; failure copy never returns inline. Full-screen recovery views
also keep a Details action after acknowledgement. Explicit `occurrence` values
are remembered by the window queue across source remounts, so reopening a
surface does not replay an acknowledged event. Runs already failed when a
conversation opens expose Run details; runs observed active open a notice when
they fail.

`rally/no-inline-errors` rejects the retired `InlineError` primitive, DOM alerts,
and error-message styling in shared UI and both client source trees. It does
not infer error semantics from arbitrary prose; reviews must also catch custom
error copy without those markers.

## How it works

`Button` accepts `disabledReason` for an unavailable action that must remain
focusable; it sets `aria-disabled`, blocks activation and shows `Tip` only for
that explanation. `MenuActionItem` in `components/menu-action-item.tsx` owns the
equivalent dropdown behavior, keeping explained items in the arrow-key path and
preventing disabled selections from closing the menu. Conversation Merge/Resolve
and Sidekick actions use this same primitive. Ordinary disabled controls still
use native disabling, and enabled text controls add no redundant tooltip.

Shared components receive presentation data and callbacks. They never import an
application, fetch authority, establish sockets or call Electron. Optional actions
represent host capabilities; omitting setup and authoring actions keeps the browser
lite. The common feed/composer and resource/participant dialogs remain the existing
ConversationSurface implementation.

`Toast` is the controlled confirmation pill. Its shared presence hook also
drives conversation activity and Jump to latest; native previews honour its
`data-native-overlay` marker through the end of its exit. Operational failures
use acknowledged error popups.

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

### People picker order

The People level keeps the current participants and pending conversation
invitations first, then requests to join. A single **Suggested** list shows at
most five people total. Its ranking tiers are the top five collaborators in
this Channel, the top five other collaborators in the Organization, remaining
Members alphabetically, then Guests alphabetically. The tiers are internal
ordering rules, not separate visible sections. Deduplication and eligibility
filtering happen before taking the final five: current participants, inactive
accounts and people who asked to join are excluded. Pending Organization
invitees follow registered Members, with their Invited label. Search exposes
all matching names and email addresses in that order, without the suggestion cap.

`GET /navigation/people-ranking?channelId=…` returns ordered person ids from
`workspace-people-ranking.ts`; [the activity log](digests.md#people-interaction-ranking)
owns the scoring and indexed read. Thread ranking uses the route's Channel
pane context; standalone Threads use Organization ranking alone.

The title pill's `onMenuOpen` starts the host's optional ranking read before
People is selected. People snapshots that order on entering the level: late
responses apply on its next opening, so an Add button never moves under the
pointer. Pending or failed reads silently keep the directory fallback usable.
The host gates both automatic and manual reads on API, person and member
eligibility, and shares any in-flight refresh on reopening.

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

`pnpm --filter @rally/desktop exec vitest run
src/renderer/components/primitives.test.tsx
src/renderer/components/title-pill-menu.test.tsx
src/renderer/components/automation-header.test.tsx` covers explained disabled
buttons and the shared menu action's keyboard focus, tooltip and selection guards.

`pnpm --filter @rally/desktop exec vitest run src/renderer/components/toast.test.tsx
src/renderer/components/conversation-motion.test.tsx` covers announcements,
retained content, interruption, reduced motion and cleanup. Real-window
inspection covers placement, theme contrast and native preview composition.

Run `pnpm lint`, `pnpm typecheck`, and `pnpm --filter @rally/desktop exec vitest run
src/renderer/components/sidekick-picker.test.tsx
src/renderer/components/sidekick-section.test.tsx` (as one command). The desktop
suite imports the real shared implementations through their re-export adapters.
Run `pnpm --filter @rally/desktop exec vitest run
src/renderer/components/error-notice.test.tsx
src/renderer/components/acknowledged-error-dialog.test.tsx
src/renderer/components/sideline-composer.test.tsx` for the popup queue,
acknowledgement, focus, nested-dialog behavior and Sideline message validation.
Sideline validation uses this DOM harness because static HTML cannot represent
a client-side popup.
Run `pnpm --filter @rally/desktop exec electron-vite build` and inspect the changed
surfaces in Electron. The browser host in #825 adds Chrome verification; no second
component test runner is needed for the same implementations.

## Changelog

### 2026-10-22 — Show standing Sidekick delegation before and after consent

**What changed:** The shared Sidekick screen displays allowed identities,
availability, You/Creator markers, self allow/withdraw and manager removal.
Creation shows the standing-work and existing-history disclosure before the
request. Current authority is read after writes, including a lost response.

**Why:** People need to understand whose access a Sidekick can use and withdraw
their own grant without replacing another person or acquiring management rights.
Automatic creator opt-in also needs its explanation before creation.

**Considered and rejected:** Optimistic grants or offline queued consent could
present permission the authority never accepted. A separate confirmation dialog
would repeat the normal create/allow action instead of explaining it in place.

**Consequences:** Pending actions are scoped to the affected person. Other
windows use the existing invalidation path. Run history preserves the coordinator,
while activity shows receipt-backed serving accounts through the work breakdown.
The dedicated Account withdrawal feature was removed at the user's request.
Sidekick-screen self-withdrawal remains.

### 2026-10-22 — Share explained disabled controls

**What changed:** `Button.disabledReason` and `MenuActionItem` own the focusable,
inert action and its explanatory tooltip. Conversation Merge/Resolve and Sidekick
menus use the same menu item; disabled button hover styling is shared too.

**Why:** Sidekick actions must remain discoverable even when unavailable
([the product decision](automation-lifecycle.md#2026-10-22--keep-sidekick-actions-discoverable-across-lifecycle-states)).
Copying the menu's existing guards at each use would let focus and activation
behavior diverge.

**Considered and rejected:** Surface-specific wrappers duplicate selection and
tooltip policy. Native disabling alone removes an explanation from keyboard users.

**Consequences:** Explained actions must remain focusable and prevent activation.
Enabled text actions must not acquire redundant tooltips, and disabled actions
must retain disabled styling on hover.

PR: [#1409](https://github.com/juno-ai-labs/avalon/pull/1409).

### 2026-10-21 — Failures require acknowledgement

Inline failures below a composer or deep inside Settings could be missed and
looked like persistent page content. The product requested popups with OK
throughout Electron and browser. Both hosts now use one shared acknowledgement
primitive and a per-window queue rather than independently styled banners.

The queue retains failures when a menu unmounts and coalesces simultaneous
identical messages so one outage does not stack duplicate dialogs. Dismissing a
notice does not clear mutation state or a draft. Callers must distinguish retry
attempts when identical failure copy stays mounted. The retired inline primitive
and recognisable inline alert markup are lint errors; adding another banner is
not an alternative presentation path. Historical failures open their details
on demand so navigating or scrolling does not replay old interruptions.
The alert-dialog role also participates in existing paste and Escape guards;
otherwise an acknowledged interruption could upload into a hidden draft or
dismiss the navigation sheet underneath it. Copy tooltips share the popup's
stacking tier, above its overlay.

### 2026-10-21 — People start with frequent collaborators

**What changed:** The picker shows five eligible people total, ranked by Channel
collaborators, Organization collaborators, Members and Guests. Search exposes
everyone else. Indexed candidate seeks read existing human reply and mention
facts. The title menu warms ranking before People is selected; each People
opening keeps one order while late results wait for the next opening.

**Why:** Five alphabetical suggestions gave unrelated accounts the same
prominence as teammates. The first ranking query scanned all retained
Organization activity: 10,000 unrelated replies increased its reads from 34 to
60,034. Ranking must stay off the menu's opening path and exclude unrelated
traffic from its read work.

**Considered and rejected:** A second relationship ledger or a stale-result
time window would add another state lifecycle. One partial author index and
the existing target/conversation indexes keep the source facts authoritative.
Connector activity does not contribute to the requested Rally-only ranking.

**Consequences:** Keep Channel context route-owned, filter access at read time,
and deduplicate before the final five-person limit. Guard manual reads as well
as automatic queries for guests. Keep the visible order stable until People is
reopened. Preserve the indexed candidate seeks and expression affinity; the real-workerd read-cost regression
must remain independent of unrelated Organization history.

PR: #1367.

### 2026-10-20 — Breadcrumbs attach to the command pill

The product asked for the resource path beside the current command pill, with
ancestors as icons and the pill's two hover targets preserved. Reusing
`MarkBridge` with a fixed cap avoids measuring titles or maintaining unused
label modes. The pill fill fades over that cap so adjacent tints blend.

A separate raised connector, or the pill's standalone outline and shadow,
leaves a curved seam through the neck. The attached group therefore gets one
shadow after composition. Keep the icon picker and title popout independent,
and keep the pill mounted when ancestor metadata arrives so menus stay open.

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
