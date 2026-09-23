# Desktop layout restoration

Rally restores a person's local reading layout when the desktop app reopens. The
Organization still owns which Spaces, Channels, Breakouts, and resources exist;
the device remembers only the view the person chose.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/ui-store.ts` | Rail widths and collapse preferences. |
| `apps/desktop/src/renderer/lib/desktop-layout.ts` | Scoped local keys, artifact panel selection, and semantic list position. |
| `apps/desktop/src/renderer/components/app-shell.tsx`, `screens/workstream-landing.tsx` | Last route save and directory-checked startup restoration. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | Artifact panel selection per Channel or Breakout. |
| `apps/desktop/src/main/artifact-window-state.ts`, `main-window-state.ts`, `main/index.ts` | Native artifact window registry and the display clamp shared with the main window. |
| `apps/desktop/src/renderer/App.tsx` | Fresh content authorization for detached windows after sign-in. |

## How it works

The renderer keeps rail widths, collapsed state, and first visible Space or
Channel row in local storage. The row key is an ID, so a reordered directory
opens at the same object instead of yesterday's pixel offset. Scroll events are
coalesced into one layout read per animation frame. A missing saved Channel row
asks for the next directory page once per loaded list revision, so a failed
page does not start a retry loop. The opening Channel page exposes its cursor
in the same render as its rows, so a saved row beyond page one can request it
before passive effects run. Channel position
is scoped to the selected Space. The selected artifact panel is scoped to a
Channel and Breakout address; its resource is looked up in the freshly loaded
conversation before the panel is drawn.

The shell records only Space and Channel routes, including a Breakout query; it
omits transient search-result turn and sequence parameters.
The root landing checks the saved target against the current directory before
opening it. A saved Breakout is checked against the Channel's child directory
before it remains selected. Explicit departures carry route state and keep their existing
recency-based landing. A missing saved target falls back to that landing.

Each detached artifact window has a local main-process record with resource
identity, version, title, normal bounds, and display ID. Moving or resizing
updates the in-memory record, while closing or quitting writes its last
placement. Closing the window removes it; signing out forcibly closes the
windows and clears their records. Switching Organizations closes the old
windows but retains their placements for a later return. Application quit
preserves them. On
the next signed-in launch the renderer gets the records for that person and
Organization, fetches the current version, and obtains fresh authorized bytes
or a fresh single-use site URL. Main restores the window on its former display
when present and clamps its bounds into the available work area when a monitor
has gone away.

## Invariants

- Local state is a view preference, never permission to read a resource. A
  restored route waits for the directory; a detached window gets current
  authorized content from the API before it is created.
- Single-use site URLs and generated preview bytes never enter the window
  registry. Persisting either would reopen stale content or retain a credential.
- A window's state belongs to one person and Organization. Showing another
  account's saved windows would cross the desktop session boundary.
- Closing a detached window removes its record. Quitting the application keeps
  it, so relaunch means restoring windows that were actually open at quit.

## Boundary

The renderer owns navigation and inline layout. Electron main owns native
window placement. The API owns resource visibility and fresh artifact access.
The registry is not synchronized across devices; Space and Channel order
remain server-owned as described in [work-stream pinning](workstream-pinning.md).

## Failure modes and limits

Unavailable or malformed local storage leaves the corresponding view at its
normal default. A missing route or resource is skipped. A removed monitor uses
the matching available display's work area. A transient API failure leaves a
detached window's record for a later launch; an authorization or not-found
response removes it. There is no separate cap on saved windows: the list is
the windows the person left open.

## Testing

`workstream-landing.test.tsx` checks directory-gated route restoration;
`desktop-layout.test.tsx` checks semantic row restoration;
`artifact-window-state.test.ts` checks the local registry and monitor clamp.
The desktop acceptance check opens, moves, quits, and relaunches real Electron
windows, and checks that rail positions and panels return visibly.

## Changelog

### 2026-09-22 — Restore the local desktop reading layout

**What changed:** Rally now remembers the hierarchy rails, last open view,
per-conversation artifact panel, and detached artifact windows on this device.

**Why:** Relaunching lost the person's place and closed every artifact they
were using, even though native desktop windows normally resume where they were.
Those are presentation choices and should survive a process restart.

**Considered and rejected:** Saving scroll pixels or artifact access URLs.
Pixels shift when rows reorder, while access URLs are single-use credentials.
Stable row and resource identities let the app restore against current authority.

**Consequences:** Restoration may wait for directory or resource authorization.
New layout state should use the same device scope and leave resource validity
to the API rather than treating a saved identifier as proof of access. Review
found that continuous native move events must not synchronously write the
registry, and switching Organizations must shut the former Organization's
windows before the new session is shown.
