# Main window state

Rally's main Electron window remembers its device-local position, normal size,
and maximized state. This document owns the persistence and restore contract,
including the temporary width Rally adds while conversation details are open.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/main/main-window-state.ts` | Validates, reads, writes, and places saved state; removes transient conversation-details width before persistence. |
| `apps/desktop/src/main/index.ts` | Constructs the window from saved state and saves its normal geometry on close. |
| `apps/desktop/src/main/conversation-details-geometry.ts` | Adds and removes the temporary details-rail width while the window is open. |
| `apps/desktop/src/main/main-window-state.test.ts`, `main-window-startup.test.ts` | Cover placement, persistence, and main-process lifecycle wiring. |

## How it works

Before constructing `BrowserWindow`, main reads `main-window-state.json` from
Electron's `userData` directory. A valid version-1 record has integer `x`, `y`,
`width`, and `height` fields and a boolean `maximized` field. Main selects the
display whose work area overlaps the saved rectangle most, preferring the primary
display if none overlaps. It constrains the rectangle to that work area where
the native minimum size permits, then supplies the bounds to the constructor.
After `ready-to-show`, it restores maximization and reveals the window.

On close, main reads `getNormalBounds()` and `isMaximized()`. If the
conversation-details rail added width and the native width still equals the
width applied by that rail, it subtracts the temporary addition. A manual resize
changes that width and therefore remains the user's chosen size. The state is
written through a temporary file and renamed over the prior record.

## Invariants

- **Save normal bounds separately from maximization.** Saving a maximized
  rectangle as the user's size would make unmaximize return to a screen-sized
  window.
- **A temporary details rail is not a window-size preference.** Persisting its
  addition makes the window grow by one rail width on each open-rail/close cycle
  because the renderer does not restore the rail as open.
- **A user resize owns the width.** Subtract the rail's addition only when the
  current width still matches the last width applied by the rail; otherwise
  closing Rally would discard a manual resize.
- **A window that never became ready cannot replace saved state.** Its default
  or partial geometry would overwrite the last usable placement after a failed
  renderer load.
- **The native minimum size remains authoritative.** A smaller work area cannot
  contain that window; keep the minimum dimensions and put its top-left corner
  at the work-area origin rather than calculating a smaller size that Electron
  will expand after placement.

## Boundary

The main process alone owns this state. It is a local window preference in
Electron `userData`, separate for development and packaged Rally, and does not
belong to an account, Organization, renderer store, or regional API. The renderer
can request conversation-details geometry through its existing IPC operation;
it cannot read or write the saved file.

## Failure modes and limits

Missing or malformed state uses the existing 1180×940 default. Other read and
write errors are logged without blocking window creation or close. A display
smaller than the existing 860×640 native minimum necessarily leaves some of the
window outside its work area; its top-left corner remains visible. State is
saved on normal close or quit, so a process killed before close retains the
previous saved geometry.

## Testing

`pnpm --filter @rally/desktop exec vitest run
src/main/main-window-state.test.ts src/main/main-window-startup.test.ts` checks
the file round trip, malformed state, display changes, rail-width ownership, and
the constructor and close-handler wiring. A real Electron close and cold relaunch
checks the visible result, since a Node harness cannot prove native placement.

## Changelog

### 2026-09-22 — Restore the user's window without persisting temporary layout

**What changed:** The main window now saves normal bounds and maximized state
locally, restores them against current displays, and excludes the temporary
conversation-details width unless the user resized the window.

**Why:** The fixed 1180×940 constructor discarded every move and resize on
reopen. Persisting native bounds alone would also turn a transient details rail
into permanent width, adding that width again on each later rail opening.

**Considered and rejected:** Saving `getBounds()` directly. It would store the
maximized rectangle and the details rail's temporary width as user choices.
Lowering the native minimum for small displays would change the app's layout
contract to solve a placement edge case.

**Consequences:** Window geometry is now device-local state owned by main. A
future temporary window adjustment must be removed before saving unless the
user's own resize has taken ownership. Display placement can promise a fully
visible window only when the work area is at least the native minimum.

PR #944.
