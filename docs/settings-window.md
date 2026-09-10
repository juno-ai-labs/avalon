# The Settings window

Settings is not a route inside the running application. It is its own
`BrowserWindow`, with its own renderer process, its own React tree and its own
query cache, and none of that is shared with the window the person clicked in.
This document owns how that window comes to be on screen, and what it is allowed
to read before it can draw anything.

The pane contents are somebody else's: [`settings-search.md`](settings-search.md)
owns the setting definitions, the navigation and the search index. This document
owns the window and the boot around it.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/main/settings-window-controller.ts` | The whole lifecycle: whether a window exists, whether it may be built before it is wanted, and when it is revealed. No Electron import — the window arrives through an injected factory. |
| `apps/desktop/src/main/index.ts` | The factory that builds the real `BrowserWindow`, the two prewarm triggers, and `revealedSettingsWindow` — the one place that decides whether a settings window counts as a destination. |
| `apps/desktop/src/renderer/lib/session-workspace.ts` | `workspaceFromSession`: the workspace a signed-in session already describes, used as the placeholder every surface renders on while `GET /workspace` is in flight. |
| `apps/desktop/src/renderer/App.tsx` | `WorkspaceApp`, which holds that placeholder and picks the surface out of `?surface=`. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | The screen, and the freshness each of its reads is held to. |
| `apps/desktop/src/common/settings.ts` | `DesktopSettingsSection`, shared by the URL, the IPC channel and the screen. |

## How it works

### The window is built before it is asked for

`createSettingsWindow` used to run on the click. That meant spawning a renderer
process, parsing the renderer bundle, booting the session and mounting React
before one row of settings could exist — every bit of it after the click, none of
it dependent on anything the click supplies.

`SettingsWindowController` moves that work in front of the request. It builds the
window hidden, and the click costs a `show()`. Two things ask it to:

- **`broadcastSessionChanged`**, the single choke point every session arrival
  passes through, so a sign-in leaves a window ready. It also fires on every
  token refresh, which is why `prewarm` is idempotent.
- **`auth:consume-pending-deep-links`**, which the main renderer invokes once it
  has mounted. A relaunch onto a stored session broadcasts no session change, so
  this is the trigger that covers it.

Closing the window builds another one, hidden, immediately: somebody who has just
used Settings is the likeliest person to use it again, and the machine is idle in
that moment.

`mayPrewarm` refuses when there is no session with a workspace, or while a
sign-out is in progress. A window built then would boot to the sign-in screen,
and `logout` closes this window rather than replacing it.

### Readiness and the wish to be seen are separate

An on-demand window reveals itself from `ready-to-show`. A prewarmed one must
not, so the controller tracks two things and reveals when the second arrives:
`ready`, set by `ready-to-show`, and `pendingReveal`, set by `open`. Whichever
lands second calls `revealIfReady`, and `pendingReveal` is consumed there so one
`open` produces exactly one reveal — while a later `open` on a window already on
screen still raises it.

Both `ready-to-show` and `closed` are wired by the factory at construction rather
than by the controller afterwards. `ready-to-show` routinely fires before
`loadURL` resolves, and a window whose load fails is destroyed before the promise
settles; a listener attached after the await is a listener attached after the
event.

The requested section takes whichever of two paths is cheaper. A window built for
this request carries the section in its URL, so its first paint is already the
right pane. A window that was prewarmed is told over IPC — `settings:section-requested`
— before it is shown, so the reveal still shows the right pane rather than
Account and then a switch.

### The screen draws on the session, not on a round trip

Every surface hangs below one `GET /workspace`, and until it landed `WorkspaceApp`
rendered `Opening workspace…` for the whole tree. Settings therefore had not
mounted, and none of its own reads had started, until a round trip had returned
a profile the desktop already held: `stored-session.ts` requires both timezones
and the member role, which with the id, name and region is every field the
renderer's `Workspace` carries.

`workspaceFromSession` supplies that as React Query `placeholderData`. The tree
mounts on it, the read replaces it in place, and the settings screen's own reads
start about a round trip earlier than they used to. When the session cannot
describe the workspace in full the function returns `null` and the surface waits
exactly as before — a placeholder is a claim that the value is already known, and
half of one is a claim that is false.

### What the screen reads, and how fresh it insists on being

Mounting the screen starts `/workspace/members`, `/connections`,
`/connections/catalog`, `/feature-flags`, `/workspace/invitations` for an admin,
and `getApplicationSettings` over IPC. A section adds one more when it is
selected: `/workspace/terminal`, GitHub repository access, or custom MCP tools.

Two of those used to be read twice per open, and both because staleness had been
bypassed rather than tuned:

- **The member roster** was `refetchOnMount: 'always'`, forcing a read past a
  cache `App.tsx` fills for the shell at `staleTime: Infinity`. Staleness is per
  observer, so this screen's own 30 seconds already refreshes a roster old enough
  for somebody to have joined or left; `'always'` only added a second read of a
  list fetched milliseconds earlier by the boot the screen is mounting inside of.
- **Connections** was `refetchOnWindowFocus: 'always'`. The refresh itself is
  needed — authorizing a connector happens in a browser and coming back is when
  the answer exists — but `'always'` ignores `staleTime`, and this window is
  *shown* rather than created now. Every reveal raises `visibilitychange`,
  including the one right after a cold mount, so the read the mount had just
  issued was immediately repeated.

Both now use the staleness-respecting form. `staleTime` is what decides, and its
value is what the reveal is measured against.

## Invariants

- **A settings window existing is not a person wanting one.** One is hidden and
  ready for most of a signed-in session, so anything meaning "settings is where
  this belongs" — raising it, handing it a deep link — asks
  `revealedSettingsWindow()`, never whether `settingsWindow` is non-null. Get
  this wrong and a prewarmed window silently steals results the person is waiting
  on in the window they are actually looking at, and pops up unbidden to do it.
- **A prewarmed window is never shown by anything but `open`.** The factory
  builds with `show: false` and hands `ready-to-show` to the controller; a
  `show()` anywhere else puts an unrequested window in front of somebody.
- **`prewarm` never rejects; `open` does.** Nobody asked for a prewarmed window,
  so a failure to build one has no one to report to and must not surface as an
  unhandled rejection in the main process. A failure under `open` is the person's
  to see.
- **The placeholder workspace is all-or-nothing.** `workspaceFromSession` returns
  a complete `Workspace` or `null`. A partial one would put invented values —
  a guessed timezone above all — on screen as though they had been read.
- **The placeholder's `role` is presentation, never authorization.** It decides
  which admin controls are drawn; the API refuses every one of them for a member
  regardless, so a role the session has not caught up on costs a redraw.
- **The module-scope `settingsWindow` stays in step with the controller.** It is
  what `rallyWindows()` broadcasts to, what `logout` closes and what
  `assertTrustedIpcSender` trusts — all of which a hidden window must still be
  part of. The factory assigns it and the `closed` handler clears it.

## Boundary

This document owns the window's lifecycle and the boot in front of the settings
screen. It does not own:

- **What is in the panes**, or how they are searched and revealed —
  [`settings-search.md`](settings-search.md).
- **Which window a deep link is delivered to**, and what a refused one looks like
  — [`deep-link-failures.md`](deep-link-failures.md). This module supplies
  `revealedSettingsWindow()`, which that routing now asks.
- **The workspace socket.** The settings surface opens one like every other
  surface, and a prewarmed window opens it at prewarm time. That is deliberate:
  WorkspaceDO accepts these sockets through the hibernation API and auto-responds
  to their heartbeats, so an idle extra socket does not hold an object awake, and
  the connector-authorization reconciliation the screen depends on is live the
  moment the window is shown. [`websocket-architecture.md`](websocket-architecture.md)
  owns the socket itself.
- **The renderer bundle.** Opening any window still parses the whole application,
  because the renderer has no code splitting; prewarming moves that cost off the
  click but does not reduce it. See [Open questions](#open-questions).

`workspaceFromSession` lives in the renderer's shared `lib/` rather than beside
the settings screen, because `WorkspaceApp` is shared: the main, sidekicks and
meeting surfaces mount on the same placeholder.

## Failure modes and limits

- **A prewarm that fails to load** is reported through `reportError` and leaves no
  window. The next `open` builds one and surfaces its own failure. A window
  destroyed while it loads is never adopted, so the controller cannot end up
  holding a destroyed window.
- **A prewarm that fails while a window is closing** is skipped rather than
  retried, because the in-flight creation is still recorded. That is what keeps a
  window which cannot load from being rebuilt in a loop.
- **Data can be older than the window.** A window prewarmed at launch and opened
  hours later shows what it read at prewarm time, then refreshes on the reveal:
  connections through `refetchOnWindowFocus`, everything else on its own
  staleness. This is stale-while-revalidate and it is the point — the alternative
  is a loading state on every open.
- **A workspace switch is followed, not special-cased.** The hidden window
  receives `session:changed` like every other Rally window and clears its cache
  when the scope changes.
- **The standing cost is one hidden renderer process per signed-in session**,
  whether or not that person ever opens Settings. That is the trade this design
  makes, and it is the number to revisit first if desktop memory becomes a
  complaint.

## Testing

| What | Where |
| --- | --- |
| The window lifecycle — prewarm, reveal ordering, section delivery, close-and-rebuild, both failure paths | `apps/desktop/src/main/settings-window-controller.test.ts` (node project) |
| `workspaceFromSession` field by field, and its refusals | `apps/desktop/src/renderer/lib/session-workspace.test.ts` |
| The surface drawing on the session before the read lands, and the read replacing it | `apps/desktop/src/renderer/App.session-gate.test.tsx` |
| The two reads not being issued twice, and still refreshing when they have gone stale | `apps/desktop/src/renderer/screens/workspace-settings.test.tsx` |

Two traps in the settings-screen tests, both already paid for once:

- **React Query's focus manager listens on `window`, not `document`.** A
  `visibilitychange` dispatched on the document does not bubble to it from a
  test, so a reveal simulated that way reaches nothing and the test passes while
  proving nothing. `revealWindow()` in that file dispatches on `window`.
- **Age a cache entry only after its data has landed.** A read that has merely
  started has no `dataUpdatedAt` to move, and will overwrite one on the way in.
  Wait on `getQueryState(...).dataUpdatedAt`, not on the mock's call count.

The lifecycle suite drives `ready-to-show`, `closed` and the load promise by
hand, in both orders, because the order between them is the thing the controller
exists to survive and Electron does not guarantee it.

## Open questions

- **The renderer bundle is the remaining cost.** The entry chunk measures about
  5 MB, unminified — `electron-vite` defaults the renderer to `minify: false` and
  the config does not override it — and there is no code splitting, so the
  settings window parses the transcript renderer, the diagram engine and the
  markdown stack to draw a list of toggles. Prewarming hides this from the click.
  Fixing it would speed up every window, including the first one, which
  prewarming cannot help.
- **Whether prewarming should be conditional.** It is unconditional today. A
  machine under memory pressure is the case that would argue otherwise, and the
  threshold for that is a number nobody here can currently derive.

## Changelog

### 2026-09-10 — Settings opens a window that already exists, drawn on the session

**What changed:** The settings `BrowserWindow` is now built hidden ahead of being
asked for — on sign-in and once the main renderer has mounted — and opening
Settings shows it. `WorkspaceApp` renders every surface on a workspace built from
the desktop session while `GET /workspace` is in flight, instead of holding the
tree behind that read. The settings screen's member and connection reads went
from `'always'` to the staleness-respecting forms of the same options.

**Why:** Opening Settings was several seconds of work that all happened after the
click and none of which needed the click. Three costs stacked: a renderer process
and a whole application bundle; a `GET /workspace` that gated the tree, so the
screen had not mounted and none of its own reads had started until it returned;
and then those reads, two of which were issued twice on every open. The
double-reads were not a tuning mistake but a bypass — `refetchOnMount: 'always'`
was there because `App.tsx` pins the same member cache at `staleTime: Infinity`
for the shell, and `refetchOnWindowFocus: 'always'` because a connector is
authorized in a browser. Both intents survive under `staleTime`; what did not
survive is reading data fetched milliseconds earlier. Measured in a real window
afterwards: click to a fully populated, correct pane in about 140 ms, and a
sectioned open lands on its section with no intermediate frame.

**Considered and rejected:** *Folding `/connections/catalog` into another
response* to remove its round trip. It is a synchronous, IO-free read of the
Worker's connector registry, so it looks free to move — but the desktop's runtime
config is main-process state and cannot know it, `WorkspaceSchema` is a shared
profile record used for workspaces the viewer is not even in, and merging it into
`/connections` changes a contract and an onboarding consumer. With the tree no
longer gated, it is one request in a parallel batch that nothing waits on. Not
worth a contract change; revisit if the batch itself ever becomes the wait.
*Deferring the prewarmed window's reads and socket until it is revealed*, to
avoid spending them on a window nobody opens. Rejected because it makes the open
slower for the exact case this change is for: the reads are what make the
revealed window complete, and WorkspaceDO's hibernation API plus its heartbeat
auto-response make the idle socket close to free. *Revealing on `did-finish-load`
as a safety net* in case `ready-to-show` never fires for a hidden window. It
fires — confirmed by opening the real app — and the fallback would trade a
guaranteed reveal for a window shown before it has painted.

**Consequences:** A settings window now exists for most of a signed-in session,
so `settingsWindow` being non-null no longer means anybody wants one. Deep-link
routing asks `revealedSettingsWindow()` instead, and any future caller that means
"settings is the destination" must do the same or it will raise a window at
somebody unbidden. The standing cost is one hidden renderer process per session
whether or not Settings is ever opened. The placeholder makes every surface draw
before its workspace read returns, so a surface that needs certainty must check
`isPlaceholderData` rather than assume `data` came from the server; `role` in
particular is presentation-only and always was. The reads a window makes can now
be older than the window, which is what the reveal-time refresh is for.

Shipped in #673.
