# Shared collaboration UI

## Responsibility

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

## Data and behavior

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

## Validation

Build and typecheck both consumers and the package. Compare Chrome and Electron at
matching sizes in light/dark appearance. Component tests cover interaction, but
screenshots are required to establish layout and visibility.

## Changelog

### 2026-09-17 — Share desktop presentation with the lite browser

The separate browser navigation/header duplicated the app and had already diverged.
Extracting the existing elements and styles makes both hosts use one implementation.
Host adapters retain application behavior; copying styles into a browser-specific
lookalike or moving desktop IPC into the shared package was rejected. Future visual
changes belong in the shared components, while capability/data changes belong in
host adapters.
