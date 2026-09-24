# Embedded browser

Rally's desktop client can show an ordinary web page beside a Channel in the
existing right sidebar. The browser is a local Electron `WebContentsView`, so a
person can navigate and sign in without handing a remote sandbox their browser
session. It is a reusable page surface; conversation import is one intended
consumer.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/common/embedded-browser.ts` | Typed command, result, state, bounds, and URL validation. |
| `apps/desktop/src/main/embedded-browser.ts` | Guest contents, tabs, navigation, page inspection, input, and native view placement. |
| `apps/desktop/src/main/index.ts` | Account ownership and main-window IPC admission. |
| `apps/desktop/src/preload/index.ts` | The named renderer bridge, without general IPC access. |
| `apps/desktop/src/renderer/components/embedded-browser-rail.tsx` | Browser controls and the visible right-rail page rectangle. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | Places the browser in the existing rail slot. |

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

The browser session uses a persistent partition for the signed-in Rally user.
Changing Rally users disposes the old tabs and selects another partition.
Visited pages get the installed Chromium version's Chrome user agent, without
an Electron token; this does not guarantee that a service will regard Electron
as Google Chrome.

## Invariants

- Remote pages receive no Rally preload or Node integration. If they did, a
  visited website could invoke app IPC or read local application state.
- Main admits browser IPC only from the main Rally window and parses every
  command before executing it. Otherwise another app window could control a
  signed-in browsing session.
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

Conversation listing, selection, conversion, and re-import are owned by
[session import](session-import.md). The browser supplies a signed-in page;
it does not decide what a source conversation means. The selected ChatGPT tab
can be read through its same-origin session and conversation endpoints. Its
access token stays in the visited page; only conversation JSON crosses the
browser command boundary for the existing decoder.

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

### 2026-09-23 — Put a local browser in the Channel rail

**What changed:** The desktop now hosts account-partitioned web tabs in the
existing right sidebar, with ordinary navigation and a typed page-command
surface for later agent use. Browser link and sign-in redirects stay in that
browser session instead of following the app-window external-link policy.

**Why:** A signed-in Chrome session in a Daytona sandbox reached ChatGPT's
page but its backend conversation calls were challenged. A local browser also
lets the person see and control the page alongside the conversation.

**Considered and rejected:** Making the remote Daytona browser the primary
import surface would depend on its login and challenge behavior. Building a
separate browser window would duplicate the right rail and remove the source
conversation from view while browsing.

**Consequences:** Browser state now lives on the user's Mac. A future
agent-to-desktop action bridge can reuse the command path. The selected
signed-in ChatGPT conversation uses the same page command and provider decoder;
agent-driven listing is still a later consumer.
