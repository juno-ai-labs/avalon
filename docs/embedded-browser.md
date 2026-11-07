# Embedded browser

Rally's desktop client can show an ordinary web page beside a Canvas's Chat in
the existing right sidebar. The browser is a local Electron `WebContentsView`,
so a person can navigate and sign in without handing a remote sandbox their
browser session. It is a reusable page surface; the import window that was its
first dedicated consumer was removed with the browser session import
(2026-11).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/common/embedded-browser.ts` | Typed command, result, state, bounds, and URL validation. |
| `apps/desktop/src/main/embedded-browser.ts` | Guest contents, tabs, navigation, page inspection, input, and native view placement. |
| `apps/desktop/src/main/index.ts` | Account ownership, the main window's browser, and IPC admission. |
| `apps/desktop/src/preload/index.ts` | The named renderer bridge, without general IPC access. |
| `apps/desktop/src/renderer/components/embedded-browser-view.tsx` | The shared pieces: tab state and commands, native page placement, navigation toolbar, tab strip, and keyboard shortcuts. |
| `apps/desktop/src/renderer/components/embedded-browser-rail.tsx` | The right-rail host. |
| `apps/desktop/src/renderer/lib/browser-rail-links.ts` | Sends web links to the rail while a Canvas is on screen, else to the system browser. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | Places the browser in the existing rail slot. |

## How it works

A web link clicked in a Canvas's Chat opens the existing right rail with its
browser variant, as a new tab on that address. The Canvas header has no
button of its own for the browser. `renderer/lib/browser-rail-links.ts` holds
the one decision: while a Canvas's conversation surface is mounted on the
desktop, it registers itself as the rail host (`useBrowserRailLinks`; a
Sidekick's surface shares the component but does not register), and `openLink`
sends an http or https URL there. Any other scheme, and any link clicked where
no Canvas is on screen, takes the `openExternal` path it took before, where
main's allowlist still admits only web URLs. Anchors reach it through one
document listener (`captureLinkClicks`), which leaves alone a click a component
already handled and Rally's own same-origin routes; citations, search link results and
a resource's *Open source* call `openLink` directly. A link opened while an artifact
panel holds the rail covers it rather than closing it: the panel's saved
layout is left alone, and closing the browser returns to the panel. Sign-in and connector
authorization keep calling `openExternal`, since their callbacks return to the
app through the system browser. Links inside an artifact's own view are
decided by the artifact surface and still leave for the system browser.
The renderer creates a blank tab on first use, measures the page rectangle, and
sends its CSS-pixel bounds to main. Main converts them using the Rally window's
zoom factor before placing the active tab's native `WebContentsView`. Closing
the rail hides the view but keeps its tabs and page
state. Reopening the rail restores them. Dialogs hide the native view
while they are open. Menus hide it only when their positioned bounds overlap
the page, so a title-pill menu in the left pane leaves the browser visible. The
placement observer tracks positioning and sizing styles only within menus and
their positioned wrappers, so unrelated composer or transcript styles do not
trigger browser placement.

The address field navigates to an HTTP or HTTPS URL. Tabs, back, forward, and
reload use the same typed command entry point as DOM inspection, screenshots,
input, page JavaScript, and Chrome DevTools Protocol commands. A website popup
destination opens in another rail tab. Sign-in flows that require a child
window to call back through `window.opener` are not yet supported.
The browser view owns link and redirect navigation. Rally's global app-window
navigation fence does not send those URLs to the system browser; the browser's
own URL guard still rejects non-web destinations.

**Tabs.** The rail has one tab strip. A tab shows its page's icon (an https
or image-data icon only), or a spinner while loading, and its title, with the
title and address as its tooltip; the active tab is Rally's selected pill, as
in search filters and sidebar rows, not a Chrome tab. A new-tab button follows
the tabs, tabs shrink to share the strip, and the strip scrolls to keep the
active tab visible. A middle click or the close button closes a tab, closing
selects the neighbour to its right (else left), and closing the last tab leaves
a blank one. In the rail, closing the only tab (by the close button, a middle
click, Delete or ⌘W) also closes the rail; a blank tab is left in place rather
than closed. ⌘W pressed inside the page reaches main first, which hands the
close of the only tab to the window's controls as a `close-last-tab` host
request, so it takes the same path. Tabs drag to reorder (`move`). The strip is one tab stop: arrows,
Home and End move between tabs and Delete closes one. `embeddedBrowserShortcut`
defines the browser shortcuts once — ⌘T, ⌘W, ⌘1–⌘9, ⌃Tab and ⌘⇧[ / ], ⌘L, ⌘R,
⌘[ / ] — for a key pressed in Rally's controls (the renderer's listener) and
one pressed inside a page (main's `before-input-event`, which then hands the
address field focus back to the renderer). In the rail they act only while
focus is inside the browser, so they never take ⌘W or ⌘T from the rest of Rally.
Import reads the foreground tab.

Each host window gets its own `EmbeddedBrowser`: its own tabs and placement,
over the one account partition. Signing in within the import window therefore
signs the rail in too, and neither window can address the other's tabs.

The browser session uses a persistent partition for the signed-in Rally user.
Changing Rally users disposes the old tabs and selects another partition.
Visited pages get the installed Chromium version's Chrome user agent, without
an Electron token; this does not guarantee that a service will regard Electron
as Google Chrome.

## Invariants

- Remote pages receive no Rally preload or Node integration. If they did, a
  visited website could invoke app IPC or read local application state.
- Main admits browser IPC only from the main Rally window, and parses every
  command before executing it. Otherwise another app window could control a signed-in
  browsing session.
- A browser partition belongs to one Rally user. Reusing a partition across
  users would expose one person's website sessions to another.
- Native page bounds follow the rail and are hidden behind dialogs and
  overlapping Rally menus.
  Otherwise a guest page can paint above a dialog or outside the browser rail.
- In a browser an agent drives — the import window's, `agentDriven` — every
  tab records its page's network responses from creation through DevTools, and
  copies Fetch and XHR bodies as each finishes, up to `NETWORK_BODY_BYTES_MAX`
  (open: the team's number to set); a new document clears the record. The
  rail's browser records nothing: a person's own browsing keeps no responses in
  the main process. An agent reads the data a web app loaded instead of
  rebuilding the request that loaded it, and reads it again after Chromium has
  evicted its own copy. A tab under an open DevTools window records nothing,
  because only one debugger can attach.
- Hidden is parked, not collapsed: the active tab keeps its size outside the
  window, without keyboard focus, and — in an agent-driven browser only —
  unthrottled. An agent driving it reads,
  captures and clicks the same page whether or not a Rally overlay covers it,
  and the person cannot reach it while one does.

## Boundary

The browser owns local website state, navigation, page inspection, and page
input. The Rally renderer owns the controls and layout; it cannot receive a
`WebContents` or an arbitrary IPC channel. An API agent loop reaches the browser
through [desktop actions](desktop-actions.md): a typed request on the
conversation's socket that the window's renderer executes through this same
`command()` path, on one tab, never through another page controller. Tool
receipts and retry policy stay with the harness.

What a conversation import reads, and how, is owned by [session
import](session-import.md): its agent drives this browser through those actions.
The browser supplies the signed-in page and its primitives — page script
(`evaluate`), the accessibility tree (`snapshot`), a screenshot sized in DIPs so
its pixels are input coordinates, input, and DevTools' network loader (`cdp`)
for a file on an origin the page may not read. It does not decide what a
conversation means.

## Failure modes and limits

An invalid or non-web URL is rejected. A failed browser command produces a
stable error in the rail; navigation can be retried from the address field.
Browser tabs remain in the process while the rail is closed and their website
storage remains on disk in the account partition. The user may have to sign in
to each website separately from Chrome or another app. Website fingerprinting,
CAPTCHAs, and provider policy can still prevent sign-in or access.
Electron's native popup from this `WebContentsView` stayed blank in a live
local-window test, so the rail opens its destination as a new tab instead.
WebAuthn is off in visited pages on macOS and Linux. Electron draws no
passkey prompt there, so a request no plugged-in security key can answer, such
as a synced passkey, hung with nothing on screen. With it off, a site offers
its other sign-in methods, and security keys, which did work, no longer do.
A page that calls `navigator.credentials.get({ publicKey })` without checking
for `PublicKeyCredential` still waits forever.

The native view cannot be layered under renderer dialogs, so the renderer hides
it for dialogs and overlapping menus, and CSS — a blur, a scrim — cannot
reach it. A surface that wants the page visible behind an overlay draws a capture of it instead, as
the import window's run does. In the import window a parked active tab renders
at full speed, so a covered page costs what a visible one does; the rail's
throttles as Chromium does for any hidden page.

## Testing

Run `pnpm --filter @rally/desktop typecheck` and `pnpm lint`. In a real Electron
window, open the rail, navigate to an ordinary page and ChatGPT's signed-out
page, open a Rally dialog over the page, close it, and check tab persistence.
`embedded-browser-view.test.tsx` covers the visibility commands for menus outside
the page, overlapping menus that move or close, and modal dismissal.
DOM tests alone cannot verify the native view's bounds or layering.
The development client commonly runs with a non-default renderer zoom factor;
check that the guest page starts exactly below the rail toolbar and does not
cover the conversation.
WebAuthn being off has no unit test, since a mocked `WebContentsView` cannot
show whether Electron honors the flag. On macOS or Linux, evaluate
`typeof PublicKeyCredential` in a guest tab and expect `'undefined'`.

The model-facing orchestration realm and its handles are owned by
[browser script runtime](browser-script-runtime.md). This browser owns the
run-to-realm map and disposes associated realms when tabs or the browser close,
or when the owning renderer reloads or loses its process.

## Changelog

### 2026-11-07 — A Canvas hosts the rail browser; the import window is removed

**What changed:** The rail browser's host is a Canvas's Chat, where it was a
Channel's conversation, and main admits browser IPC from the main window
alone. The import window (`surface=browser-import`, `browser-import:*` IPC,
`common/browser-import.ts`, `screens/browser-import.tsx`) is deleted.

**Why:** Plan step B-3 of the
[Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md):
Channels are deleted and the ChatGPT and Claude session import is deleted
(decision log, 2026-11-06), since an import landed in a Thread or Breakout. A
Canvas's Chat is the conversation with a right rail beside it, so it takes the
Channel's place as the rail's host.

**Consequences:** Paragraphs below that describe the import window's agent
driving its browser (`agentDriven`) describe code main no longer reaches; the
`EmbeddedBrowser` flag stays false until that path is removed with the server's
session import in phase C.

### 2026-10-22 — Leave the browser visible beside a thread menu

**What changed:** Browser placement measures a menu's positioned wrapper and
parks the native page only while the menu overlaps it. Positioning and sizing
style changes within menus and their wrappers trigger a fresh placement check;
unrelated inline styles are ignored. Dialogs still park the page globally.

**Why:** Opening the thread menu in the conversation pane blanked the browser
beside it: the global overlay check treated any menu as covering the window.
Keeping the native view visible for all menus would let it cover menus that
actually reach into the browser, so the decision follows their geometry.

**Consequences:** Menu positioning must remain observable by the placement hook.
The existing window-wide treatment of dialogs is preserved, including non-modal
`role="dialog"` popovers; this change only narrows menu occlusion.

### 2026-10-19 — Closing the only tab closes the rail, whatever it holds

**What changed:** `closeTab` hands any close of the only tab to `onCloseLast`,
not just a blank one. A tab that holds a page is closed first, so the rail
opens next time on a fresh blank tab. Main's in-page ⌘W no longer closes the
only tab itself: the focus-address callback became a general host request
(`focus-address` or `close-last-tab`, on `embedded-browser:host-request`), and
the renderer runs the last close through `closeTab`.

**Why:** Closing a lone page tab left the rail showing an empty new tab, which
people read as a broken close. The 2026-09-25 change covered only the blank
case.

**Considered and rejected:** Hiding the rail and keeping the page tab. Closing a
tab should close it; reopening the rail on a page the person closed would
surprise them.

**Consequences:** The last close now needs a listening host. The import window
disables its shortcuts while a run is going, so an in-page ⌘W on its only tab
does nothing then, as ⌘L already did.

Shipped in #1307.

### 2026-10-02 — Own disposable browser script realms beside pinned tabs

**What changed:** The native browser maps executor-owned runtime IDs to one pinned
tab and disposes those isolated realms on reset, tab close, browser teardown,
renderer reload or renderer process loss.

**Why:** Models need persistent orchestration handles without moving execution
into Rally's authenticated renderer or losing bindings when a provider page
navigates. Tab ownership belongs here; the API cannot select another native tab.

**Consequences:** Keep native tab and runtime lifetimes linked. Reloading or
losing the owning renderer disposes its script realms while preserving native
tabs; an abandoned renderer cannot leave hidden orchestration views alive. The model-facing
subset and realm internals live in [browser script runtime](browser-script-runtime.md),
while this module continues to own signed-in tabs, input and recorded responses.

### 2026-10-01 — Turn WebAuthn off in visited pages on macOS and Linux

**What changed:** Browser tabs open with `disableBlinkFeatures: 'WebAuth'`
outside Windows, so `PublicKeyCredential` is undefined in visited pages.

**Why:** Signing in to Google with a passkey during a ChatGPT import spun on
"Verifying it's you" for good on a Mac. Electron draws no passkey prompt and,
until `app.configureWebAuthn` is called, has no platform authenticator, so
`navigator.credentials.get()` stays pending past its own timeout. A local
Electron 43 run on Linux showed the same: a 3s-timeout request still pending
after 8s. With the feature off, a site sees no WebAuthn support and offers
password or phone sign-in.

**Considered and rejected:** `app.configureWebAuthn({ touchID })`. It needs a
`keychain-access-groups` entitlement, and its passkeys are bound to this Mac and
held in Rally's own keychain group, so a person's existing iCloud or Chrome
passkey still would not appear. Using those needs Apple's managed browser
passkey entitlement. A page script that makes `credentials.get` reject was
also rejected: visited pages deliberately get no preload, and injecting one
through DevTools for every tab and frame is more machinery than this needs.

**Consequences:** Security keys stop working in the browser on macOS and Linux.
Windows keeps WebAuthn on the assumption that Windows' own prompt serves it;
that has not been tried in Rally, and a hang there would look like this one.
Adding passkey support later means removing this flag in the same change.

Shipped in #1056.

### 2026-10-01 — Let an agent drive a tab: DIP screenshots, parked tabs, recorded network

**What changed:** Screenshots are resized to the view's DIP bounds and return
their size. A hidden active tab is parked outside the window at full size and
without keyboard focus, instead of collapsed to 0×0. In a browser an agent
drives (the import window's), tabs record their network responses from
creation and keep Fetch and XHR bodies, cleared on a new document, and a
parked tab is unthrottled.

**Why:** The agent-to-desktop boundary this document planned now exists as
[desktop actions](desktop-actions.md), and its first user clicks where a
screenshot shows something. `capturePage` returns device pixels while
`sendInputEvent` takes DIPs, so on a high-density display every click landed at
twice the coordinates. A collapsed tab stalled the agent whenever a dialog —
the import window's own progress modal included — covered the page. Chromium
keeps a body only if recording began before the request, so recording cannot
wait for an agent to ask, and it evicts its own copy, so Fetch and XHR bodies
— where a web app's data arrives — are copied.

**Considered and rejected:** An input-swallowing overlay view over the page,
which needs a second renderer; parked, the page is unreachable for being out of
the window. Recording in every browser, including the rail's: review found it
kept every site's responses, auth included, in the main process during ordinary
browsing, and a single-page app rarely starts a new document to clear them.
Recording only the pinned tab once a run starts: Chromium keeps no body for a
request made before recording began, and the page loads its conversation
first.

**Consequences:** The screenshot and input commands must stay in the same
units. A new agent surface passes `agentDriven` or gets no network panel.
`NETWORK_BODY_BYTES_MAX` is open; past it a body is listed but not copied. A
parked agent-driven tab renders at full speed, so a covered page costs what a
visible one does. A tab under an open DevTools window records nothing, because
only one debugger can attach.

Shipped in #1058.

### 2026-09-25 — Closing the only blank tab closes the rail

**What changed:** `EmbeddedBrowserTabs` and `useEmbeddedBrowserShortcuts` take
an optional `onCloseLast`. When the tab being closed is the only one and is
blank, they call it instead of sending `close`. The rail passes its own close.

**Why:** Main replaces a closed last tab with a blank one, so closing a lone
blank tab did nothing visible. People expected the X to dismiss the browser.

**Considered and rejected:** Closing the rail from main when the last tab
closes. Main does not own the rail's open state, and the import window must
keep its blank tab.

**Consequences:** A host that omits `onCloseLast` keeps the old behavior, as
the import window does. Closing the last tab when it holds a page still leaves
a blank tab.

### 2026-09-24 — Open web links in the rail instead of from a header button

**What changed:** The Channel header's *Open browser* button is gone. A web
link clicked on a Channel (a message anchor, a citation, a search link result,
a resource's *Open source*) opens as a rail tab. `openLink` is the one routing
decision; a Channel's conversation surface registers as its host while
mounted.

**Why:** The browser was a place a person had to choose to go to; links are
how people actually arrive at a page. Opening them beside the conversation
keeps the Channel in view.

**Considered and rejected:** Routing in main through the main window's
`setWindowOpenHandler`. Main cannot tell whether a Channel, and so a rail, is
on screen, and would need a new IPC event to ask; the renderer already knows.

**Consequences:** Only screens that draw the rail register a host; any new one
must register too, or its links keep going to the system browser. Sign-in and
authorization flows must keep calling `openExternal`, not `openLink`.

### 2026-09-24 — Put a local browser in Rally, and import through it

**What changed:** The desktop hosts account-partitioned web tabs, in the
Channel's right rail and in an import window with Import and Close in its title
bar and a numbered start page. Each window has its own tabs over the shared
account partition; browser IPC resolves the calling window. A typed command
surface covers navigation, page inspection, input, page script, and DevTools
commands. Browser link and sign-in redirects stay in that browser session
instead of following the app-window external-link policy. Both hosts share one
tab strip in Rally's own style, with drag reordering and browser shortcuts that
also work from inside a page; a page's popups reuse one tab per tab the person
opened.

**Why:** A signed-in Chrome session in a Daytona sandbox reached ChatGPT's page
but its backend conversation calls were challenged; a local browser uses the
person's own sign-in and lets them see and control the page. Importing needs a
page the person browses to and signs in on, which is cramped in a rail beside a
Channel, and the page they are looking at should be the one Import reads.

**Considered and rejected:** Making the remote Daytona browser the import
surface, which depends on its login and challenge behavior. Moving the rail's
single browser between windows, which would take a signed-in page away from a
Channel without saying so. Asking for the Space in the title bar; the name and
Space are asked once the conversation has been read and its title is known.

**Consequences:** Browser state lives on the user's Mac, and website sign-in
persists in the partition, so the import window's tabs can close with it. A
future host needs a window and the shared components; `embeddedBrowserHost` in
main is the one place that admits it. An agent-to-desktop action bridge can reuse
the command path.
