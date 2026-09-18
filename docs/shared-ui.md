# Shared collaboration UI

`@rally/ui` owns the collaboration presentation used by desktop and the lite
browser. Desktop's current UI is the reference; a browser host supplies fewer
actions to the same components rather than drawing a second design.

## Where the code lives

- `packages/ui/src/components`: conversation header, navigation frame and rows,
  workstream sidebar, resource rows, Sidekick section/picker, account trigger,
  glyphs, avatars and visual primitives.
- `packages/ui/src/lib`: browser-safe display helpers, theme application and
  device preferences. `packages/ui/src/styles` owns the shared styles/tokens.
- Desktop renderer adapters retain routing, UI stores, IPC, telemetry and data
  queries. Existing import sites re-export shared primitives during migration.
- The browser host owns email entry, cookie session restoration and its scoped
  directory. Its collaboration adapter supplies selected-conversation data.

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

Theme application stamps the same `data-theme` attribute before rendering. Desktop
installs the native theme reporter/broadcast adapter; browser installs system
appearance observation. Visual primitives share the same theme subscription.

Sidekick management options are requested when management controls open. Transcript
updates continue refreshing existing attachment/recommendation state, but do not
fetch management choices. Mutation handlers invalidate the existing scoped keys.

## Invariants

- Shared components import no application, IPC, authentication or transport code.
- Desktop and browser consume the same semantic styles and presentation elements.
- Host callbacks perform mutations through existing admitted application paths.
- Child-only sharing must not expose Main labels or resource context.

## Boundary

This package owns presentation, display helpers and the theme runtime. Host adapters
own query/cache state, navigation, sockets, authorization and native capabilities.
The existing ConversationSurface still owns the shared feed/composer and dialogs;
this package does not create a second collaboration implementation.

## Failure modes and limits

Omitted capabilities omit their controls. Loading, empty and error states must be
supplied distinctly by host adapters; presentation cannot infer authority from a
missing response. Shared browser-safe theme defaults apply before first render.
Native theme reporting and cross-window IPC belong only to the desktop adapter.

## Testing

Build and typecheck both consumers and the package. Compare Chrome and Electron at
matching sizes in light/dark appearance. Component tests cover interaction, but
screenshots are required to establish layout and visibility.

## Changelog

### 2026-09-17 — Share desktop presentation with the lite browser

**What changed:** Extracted the current desktop header, navigation rows, context
sidebar, primitives and theme styles into a package consumed by both clients.

**Why:** The separate browser shell had already diverged from the app.

**Considered and rejected:** Copying styles into a browser-specific lookalike would
preserve that drift. Moving Electron IPC into the package would couple browser
startup to native capabilities.

**Consequences:** Visual changes belong in shared components; capability/data
changes stay in host adapters. Equivalent browser session refreshes must preserve
the API client and socket; client ownership is not a presentation concern.
