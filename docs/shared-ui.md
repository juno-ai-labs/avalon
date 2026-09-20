# Shared collaboration UI

`@rally/ui` owns the collaboration presentation used by desktop and prepared for the lite
browser in the next stacked change (#825). Desktop's current UI is the reference; a browser host supplies fewer
actions to the same components rather than drawing a second design.

## Where the code lives

- `packages/ui/src/components`: conversation header, navigation frame and rows,
  workstream sidebar, resource rows, Sidekick section/picker, account trigger,
  glyphs, avatars and visual primitives — and the Space surfaces: `space-row.tsx`
  (`SpaceRow`, `SpaceRowContent`, `SpacePlacementList`),
  `space-appearance-picker.tsx` (`SpaceAppearancePicker`, `SpaceIcon`),
  `space-dashboard.tsx` (`SpaceDashboardHeader`, `SpaceDashboardSection`,
  `SpaceDefaultList`) and `space-icons.ts` (`SPACE_ICONS`).
- `packages/ui/src/lib`: browser-safe display helpers, theme application and
  device preferences. `packages/ui/src/styles` owns the shared styles/tokens.
- Desktop renderer adapters retain routing, UI stores, IPC, telemetry and data
  queries. Existing import sites re-export shared primitives during migration.
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

Two lists here are arranged by hand, and both follow the split. `SpacePlacementList`
marks itself `data-reorder-list`: a host's row finds the slots it is being
measured against through that mark rather than by knowing whose list it is in,
which is what lets the desktop's pinned section and a Space's placements share
one row and one drag. The Breakout rail takes an optional `substreamDrag` and
draws the order it is given, reporting the gesture and nothing else — the
arrangement is stored per person on the Organization, so it is the host's. A
host that omits it draws rows that are not draggable at all, which is what a
guest gets: their write is refused by the same gate every Space write is behind,
and a gesture that can only fail is worse than no gesture.

Every one of these `onDragEnd` callbacks takes a `cancelled` flag, and each
reads it the same way: the drag operation the browser reports is `none` when
nothing accepted the release, which is what `Escape` and a release outside the
list both look like. It is one reading rather than four because it decides
whether a gesture somebody backed out of is written to every session they have
open, and the list that was missing it wrote the arrangement the pointer
happened to build on its way past.

The Space components follow the same split, one step further. A `SpaceRow` draws
the geometry, the accordion, the hover-revealed plus and the motion keys, and
takes the host's own navigation element as a slot — routing is a host decision
under the Spaces PRD's design decision 9, the way `NavigationRowContent` already
treats a Channel row. `SpaceDashboardHeader` owns the rename *interaction*
(double-click, F2, Enter to commit, Escape to abandon, blur to commit) because
that is presentation; the host only ever learns the committed name. Nothing here
fetches, and no component infers a capability from an omitted prop: a Space with
no audience control is a host that decided not to draw one.

`SpaceRow` still requires the drag handlers and **the new-Channel action is
optional**, which is the one capability this component lets a host withhold. A
host may hand a reader a Space they can see and may write nothing on — Rally
does, for a Space reached only through a Channel placed in it
([`spaces.md`](spaces.md#who-may-see-a-space-and-why)) — and a plus that can
only fail is worse than no plus. The row's grid keeps its third column either
way, so a list mixing the two kinds does not have its names in two different
places. The Space dashboard's Channel and breakout entries are host-owned links,
not shared removable rows; the landing page draws both at full width and keeps
placement management in its owning surfaces.

A Space's resources and its Sidekick recommendations are one list. They are one
registry keyed by `kind` on the server, and nothing about the drawing depends on
which kind it is, so `SpaceDefaultList` is not told — the kind branches in the
host's copy table and in its two `/spaces/:id/defaults` calls, where it means
something. The guest browser passes no Space props at all and draws no Space
navigation.

Theme application stamps the same `data-theme` attribute before rendering. Desktop
installs the native theme reporter/broadcast adapter; browser installs system
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
missing response. Sidebar and rail error contracts carry state, never transport,
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

### 2026-09-20 — The Space dashboard no longer exports a removable Channel row

**What changed:** `SpaceChannelRow` and its hidden control-column layout were
removed from the shared package. The desktop Space dashboard now supplies its
Channel and breakout links directly, at full width.

**Why:** The landing page no longer owns Channel-placement controls, so a shared
component whose only distinction was whether to render or reserve **Remove** had
no remaining presentation contract. Keeping it would advertise a management
surface that no host uses.

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
