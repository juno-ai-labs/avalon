# Embedded browser

Rally's desktop client can show an ordinary web page beside a Channel in the
existing right sidebar, or in a window of its own for importing a conversation.
The browser is a local Electron `WebContentsView`, so a person can navigate and
sign in without handing a remote sandbox their browser session. It is a
reusable page surface; the import window is its first dedicated consumer.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/common/embedded-browser.ts` | Typed command, result, state, bounds, and URL validation. |
| `apps/desktop/src/main/embedded-browser.ts` | Guest contents, tabs, navigation, page inspection, input, and native view placement. |
| `apps/desktop/src/main/index.ts` | Account ownership, the per-window browser, IPC admission, and the import window. |
| `apps/desktop/src/common/browser-import.ts` | The Spaces the main window hands the import window, and the imported Channel id it hands back. |
| `apps/desktop/src/preload/index.ts` | The named renderer bridge, without general IPC access. |
| `apps/desktop/src/renderer/components/embedded-browser-view.tsx` | The shared pieces: tab state and commands, native page placement, navigation toolbar, and tab strip. |
| `apps/desktop/src/renderer/components/embedded-browser-rail.tsx` | The right-rail host. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | Places the browser in the existing rail slot. |
| `apps/desktop/src/renderer/screens/browser-import.tsx` | The import window: toolbar with Import and Close, start page, and the name-and-Space sheet. |

## How it works

The Channel header opens the existing right rail with its browser variant.
The renderer creates a blank tab on first use, measures the page rectangle, and
sends its CSS-pixel bounds to main. Main converts them using the Rally window's
zoom factor before placing the active tab's native `WebContentsView`. Closing
the rail hides the view but keeps its tabs and page
state. Reopening the rail restores them. Dialogs and menus hide the native view
while they are open so they can appear above it.

The address field navigates to an HTTP or HTTPS URL. Tabs, back, forward, and
reload use the same typed command entry point as DOM inspection, screenshots,
input, page JavaScript, and Chrome DevTools Protocol commands. A website popup
destination opens in another rail tab. Sign-in flows that require a child
window to call back through `window.opener` are not yet supported.
The browser view owns link and redirect navigation. Rally's global app-window
navigation fence does not send those URLs to the system browser; the browser's
own URL guard still rejects non-web destinations.

**Import window.** On the desktop, the sidebar's *Import Channel from Claude
or ChatGPT* item asks main to open one `surface=browser-import` window,
passing the Spaces the menu offers. The window is a Rally renderer surface with
its own browser: back, forward, reload and the address field form its title
bar, with Import and Close at the trailing edge, and a tab strip appears only
when a site has opened a second tab. A blank tab shows a numbered start page
instead of the native view. Import is enabled while the active tab shows a
ChatGPT or claude.ai conversation — the person's own (`/c/<id>`, `/chat/<id>`)
or a shared link (`/share/<id>`). It reads that conversation (see
[session import](session-import.md)), then a sheet asks for
the Channel's name, pre-filled with the chat's title, and its Space. After the
import, main opens the new Channel in the main window through the same
deep-link path a menu-bar pick uses, and closes the import window along with
its tabs. This window is the only way to import; the web host, which has no
browser, offers no import.

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
- Main admits browser IPC only from the main Rally window and the import
  window, each addressing its own browser, and parses every command before
  executing it. Otherwise another app window could control a signed-in
  browsing session.
- A browser partition belongs to one Rally user. Reusing a partition across
  users would expose one person's website sessions to another.
- Native page bounds follow the rail and are hidden behind Rally overlays.
  Otherwise a guest page can paint above a dialog or outside the browser rail.

## Boundary

The browser owns local website state, navigation, page inspection, and page
input. The Rally renderer owns the controls and layout; it cannot receive a
`WebContents` or an arbitrary IPC channel. The API agent loop does not yet call
the browser. When that is added, a small typed desktop-action request and
result can carry browser commands, then later a settings-page navigation action.
That transport should identify the owning user and live desktop session and
use the same main-process browser command path rather than introducing another
page controller. Agent tool receipts and retry policy remain the harness's
responsibility.

Conversation reading, conversion, and re-import are owned by
[session import](session-import.md). The browser supplies a signed-in page and
two primitives the readers build on: page script (`evaluate`) and, for a file on
an origin the page may not read, DevTools' network loader (`cdp`) with the tab's
own session. It does not decide what a source conversation means.

## Failure modes and limits

An invalid or non-web URL is rejected. A failed browser command produces a
stable error in the rail; navigation can be retried from the address field.
Browser tabs remain in the process while the rail is closed and their website
storage remains on disk in the account partition. The user may have to sign in
to each website separately from Chrome or another app. Website fingerprinting,
CAPTCHAs, and provider policy can still prevent sign-in or access.
Electron's native popup from this `WebContentsView` stayed blank in a live
local-window test, so the rail opens its destination as a new tab instead.

The native view cannot be layered under renderer dialogs, so the renderer hides
it for dialogs and menus. Agent access has no transport yet; the command types
alone do not make a browser action available to a model.

## Testing

Run `pnpm --filter @rally/desktop typecheck` and `pnpm lint`. In a real Electron
window, open the rail, navigate to an ordinary page and ChatGPT's signed-out
page, open a Rally dialog over the page, close it, and check tab persistence.
DOM tests alone cannot verify the native view's bounds or layering.
The development client commonly runs with a non-default renderer zoom factor;
check that the guest page starts exactly below the rail toolbar and does not
cover the conversation.

## Changelog

### 2026-09-24 — Put a local browser in Rally, and import through it

**What changed:** The desktop hosts account-partitioned web tabs, in the
Channel's right rail and in an import window with Import and Close in its title
bar and a numbered start page. Each window has its own tabs over the shared
account partition; browser IPC resolves the calling window. A typed command
surface covers navigation, page inspection, input, page script, and DevTools
commands. Browser link and sign-in redirects stay in that browser session
instead of following the app-window external-link policy.

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
