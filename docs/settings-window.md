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
| `apps/desktop/src/renderer/App.tsx` | `WorkspaceApp`, which holds that placeholder and picks the surface out of `?surface=`; `useWindowRevealed`, which is how the settings surface learns it is on screen. |
| `apps/desktop/src/preload/index.ts` | The `settings:revealed` latch, beside the section queue it mirrors. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | The screen, and the freshness each of its reads is held to. |
| `apps/desktop/src/common/settings.ts` | `DesktopSettingsSection`, shared by the URL, the IPC channel and the screen. |

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

`mayPrewarm` refuses when there is no session with a workspace, while a sign-out
is in progress, or when there is no main window. A window built then would boot
to the sign-in screen, and `logout` closes this window rather than replacing it.

### A speculative window must never hold the application open

A hidden window is still a window to Electron, and `window-all-closed` — the
only path that quits Rally off macOS — fires only once every one of them has
gone. So a prewarmed window left in place when somebody closes the main window
keeps the process alive with nothing on screen. It is worse than an idle
process: it holds the single-instance lock, and the `second-instance` handler
needs a `mainWindow` to raise, so a relaunch does nothing either. Rally could
then be neither seen nor quit.

Two things prevent it, and both are needed. The main window's `closed` handler
calls `releasePrewarmed()`, which destroys a window nobody asked for and does
*not* build a replacement; and `mayPrewarm` declines to build one while there is
no main window, so the next token refresh does not undo it. A window that was
actually opened is left alone — that one is somebody's open Settings, not a
cache. Prewarming resumes when a main window exists again, through the same
`auth:consume-pending-deep-links` trigger as a cold launch.

### Readiness and the wish to be seen are separate

An on-demand window reveals itself from `ready-to-show`. A prewarmed one must
not, so the controller tracks two things and reveals when the second arrives:
`ready`, set by `ready-to-show`, and `pendingReveal`, set by `open`. Whichever
lands second calls `revealIfReady`, and `pendingReveal` is consumed there so one
`open` produces exactly one reveal — while a later `open` on a window already on
screen still raises it.

Both `ready-to-show` and `closed` are wired by the factory at construction rather
than by the controller afterwards, because both can fire during the load:
`ready-to-show` routinely beats `loadURL`, and a window can be closed before it
finishes. A listener attached after the load is a listener attached after the
event. For the same reason the controller adopts the window *before* starting
the load, so that readiness arriving mid-load has a window to reveal.

### A window whose load fails is disposed of, by the controller

Electron does not dispose a window whose `loadURL` rejected: the `BrowserWindow`
and its renderer process stay exactly where they were, hidden and blank. Nothing
else holds a reference, so a controller that merely forgot it would strand both
for the life of the process — and the next attempt would strand another. With
prewarming that next attempt is not rare: `prewarm` runs on every session
broadcast, which includes every token refresh.

So the handle exposes `load()` and `destroy()` and the controller owns both. It
adopts the window, awaits `load()`, and on rejection forgets the window,
destroys it, and rethrows. The factory's `destroy()` detaches its `closed`
listener first, because `destroy()` still emits `closed` and the controller
already knows this window is finished — letting the callback run would have it
read a disposal as somebody closing Settings and build a replacement, which for
a window that cannot load is a loop.

This is the same disposal `createDeepLinkErrorWindow` does for the same reason;
that one is the older worked example.

The requested section takes whichever of two paths is cheaper. A window built for
this request carries the section in its URL, so its first paint is already the
right pane. A window that was prewarmed is told over IPC — `settings:section-requested`
— before it is shown, so the reveal still shows the right pane rather than
Account and then a switch.

### The renderer is told when it is on screen

A prewarmed renderer mounts long before anybody looks at it, and it cannot tell:
`document.visibilityState` reported `visible` for a `show: false` window under
Xvfb with no window manager while this was being verified, so the renderer has no
trustworthy local signal. Main does know, so the controller sends
`settings:revealed` the first time it reveals a window, and the preload latches
it — a reveal is a state the window is in from then on, not an event a late
listener may miss.

Once per window, not once per `open`: raising a window already on screen is not a
person arriving at Settings, and before prewarming it did not even remount the
renderer.

The one thing waiting on it today is the surface's own `surface_viewed` report;
`telemetry.md` owns why. Anything else in the settings surface that should happen
when a person actually looks at it belongs behind the same signal.

### The screen draws on the session, not on a round trip

Every surface hangs below one `GET /workspace`, and until it landed `WorkspaceApp`
rendered `Opening organization…` for the whole tree. Settings therefore had not
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
selected: `/workspace/terminal`, or, on a connection's own page, that
connection's GitHub repository access or custom MCP tools.
The Connections section adds none: each row's tool count arrives in
`/connections` itself ([`connectors.md`](connectors.md#settings-tool-counts)).

The roster the Workspace section draws is also where a member is made an
administrator or handed back: each row an administrator may act on carries a
promote/demote control that `PATCH`es `/workspace/members/:userId/role`, and the
answer invalidates both the roster and `['workspace']` — the second because the
viewer may have just demoted themselves.
[`workspace-member-roles.md`](workspace-member-roles.md) owns the rules behind
that control and what the server refuses.

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
- **A window that fails to load is destroyed, never merely forgotten.** Electron
  keeps it and its renderer process alive otherwise, and nothing else holds a
  reference — so forgetting one leaks a process, and a prewarm that runs on every
  token refresh leaks one per failure.
- **A failed creation clears the request that asked for it.** `pendingReveal`
  left set outlives the window it belonged to, and the next window built for any
  reason — a token refresh reaches `prewarm` — inherits it and shows and focuses
  itself with nobody having asked. This holds for a construction that threw as
  much as for a load that rejected.
- **Work that means "somebody is looking at this" waits for `settings:revealed`.**
  The renderer cannot detect the condition itself, and a prewarm that acts as
  though it had been opened reports events nobody caused — or, worse, consumes
  the one report the real open would have made.
- **A prewarmed window is never the reason the application cannot exit.** Off
  macOS nothing quits Rally but `window-all-closed`, which counts hidden windows.
  A window built on speculation is released when the main window closes and is
  not rebuilt while there is none.
- **Disposing a window must not run `onClosed`.** `destroy()` emits `closed`, and
  the controller treats a close as "this person uses Settings" and rebuilds. A
  disposal that reaches that callback turns a window which cannot load into an
  endless rebuild.
- **The placeholder workspace is all-or-nothing.** `workspaceFromSession` returns
  a complete `Workspace` or `null`. A partial one would put invented values —
  a guessed timezone above all — on screen as though they had been read.
- **The placeholder's `role` is presentation, never authorization.** It decides
  which admin controls are drawn; the API refuses every one of them for a member
  regardless, so a stale role can never grant anything. It can still *withhold*
  something, which is why no gate may read it: a role now changes while somebody
  is signed in — see
  [`workspace-member-roles.md`](workspace-member-roles.md) — and the session's
  copy moves only when its access token rotates. Gates read the `['workspace']`
  query through `renderer/lib/use-workspace.ts`, which the `workspace_profile`
  sync topic invalidates; the placeholder is what the first paint uses while
  that read is in flight.
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
- **The workspace socket.** The settings surface holds none while the main
  window is publishing one: it consumes that socket through main
  (`relay="consume"`), so its reads — flags included — are invalidated by the
  same topics, and the connector authorization reconcile re-runs on the
  relayed `connector_oauth_attempts` waterline and connection state, live from
  the moment the window is built, prewarmed or not. It dials its own only while
  nobody publishes, which on a Mac is the ordinary case of Settings left open
  after the main window was closed. This replaces the 2026-09-10 reasoning below
  that an idle prewarmed socket was nearly free: it was, idle, but it also took
  the full sidebar, a second copy of every push, and a second read of
  everything on each open.
  [`websocket-architecture.md`](websocket-architecture.md#one-workspace-socket-per-desktop-the-organization-sync-relay)
  owns the relay, the socket, and the reasoning.
- **The renderer bundle.** Opening any window still parses the whole application,
  because the renderer has no code splitting; prewarming moves that cost off the
  click but does not reduce it. See [Open questions](#open-questions).

`workspaceFromSession` lives in the renderer's shared `lib/` rather than beside
the settings screen, because `WorkspaceApp` is shared: the main surface mounts on
the same placeholder.

## Failure modes and limits

- **A load that fails** destroys the window, clears the shared `settingsWindow`
  reference, and rethrows. Under `prewarm` that is reported through `reportError`
  and swallowed; under `open` it reaches the caller. Either way exactly one
  window is built per attempt and none is left behind.
- **A window closed while it loads** has already run `onClosed`, so the load
  settling finds the controller's state cleared and reveals nothing.
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
| Holding no socket while the main window publishes, reading once, refetching on relayed news, and falling back to its own socket while nobody publishes | `apps/desktop/src/renderer/lib/workspace-socket.test.tsx` (`the organization-sync relay between windows`) |

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

**Consequences:** Prewarming makes a hidden window a permanent fixture of a
signed-in session, and three things that were previously safe stopped being so:
a mounted settings renderer no longer means a person is looking at Settings, so
anything that would act on that waits for `settings:revealed`;
`settingsWindow` being non-null no longer means anybody wants Settings, and a
window existing no longer means the application should stay alive. The second is
the sharper one — off macOS nothing quits Rally but `window-all-closed` — so any
future window built on speculation has to be released the same way. A window
whose renderer load fails is now this controller's to destroy — Electron does not, nothing else holds it, and `prewarm` runs often
enough (every token refresh) that forgetting one would leak a renderer process
per failure. Any future path that abandons a settings window disposes of it, and
does so without running `onClosed`, or the rebuild that callback triggers becomes
a loop. A settings window now exists for most of a signed-in session,
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
