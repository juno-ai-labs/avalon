# Website comments in the browser client

> Created 2026-10-29.
>
> Make anchored comments on live artifacts and HTML files work in the browser
> client, where they are disabled today with "Website comments require the
> Rally Mac app." Companion: [state](state.md). Related:
> [artifact annotations](../2026-10-19_artifact-annotations/prd.md) (the
> feature this extends), [`artifact-annotations.md`](../../artifact-annotations.md),
> [`live-web-artifacts.md`](../../live-web-artifacts.md),
> [`browser-client.md`](../../browser-client.md),
> [`security.md`](../../security.md).

## Summary

The browser client previews a live artifact in a cross-origin `<iframe>` and
has no way to run trusted code inside it, so Comment mode is disabled there.
The desktop gets trust from an Electron isolated world. A browser has no such
thing: any script that runs in the artifact's document runs with the same
authority as the model-authored page.

This PRD accepts that fact and designs around it instead of pretending it away.
The page-side script becomes a **DOM inspector that only answers questions**,
and every question is asked by the Rally app in response to the person's own
click on a **glass overlay the app draws over the frame**. During Comment mode
no pointer event reaches the page at all. The page cannot start a pin, cannot
read a comment, and cannot answer a question nobody asked. What it can still do
is lie about its own DOM, which it can do today by rendering it.

The same change also fixes the smaller, unrelated reason HTML _files_ cannot
take comments in the browser: the opaque frame's picker asset is built only for
the desktop renderer. Both fixes apply only to content Rally serves, which is the
agreed scope: Rally does not need to support arbitrary third-party iframes.

## What exists today

Read with [`artifact-annotations.md`](../../artifact-annotations.md) open.

**Four HTML surfaces, three transports.** One picker script in
`packages/contracts/src/artifact-picker.ts` does the outline, grow and pin work
everywhere. What differs is how it gets into the document:

| Surface                                              | How the script gets in                                                                                                                  | Who can forge a pin                      | Browser client          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------- |
| HTML file, rail or lightbox                          | `srcdoc` frame, `sandbox="allow-scripts"`, fresh nonce, external `/annotation-frame.js` from the app origin                             | Nobody: the file's own scripts never run | **Disabled**, see gap A |
| Saved site annotation (feed excerpt, draft reattach) | Same opaque frame over frozen HTML from `GET /resources/:id/versions/:v/site-preview`                                                   | Nobody                                   | **Disabled**, gap A     |
| Live site, desktop rail and pop-out                  | `executeJavaScriptInIsolatedWorld(1001)` in the `WebContentsView`; comment cards drawn in the same world; screenshot from `capturePage` | Nobody: the page cannot reach the world  | n/a                     |
| Live site, browser client                            | Nothing. The frame is the artifact's own origin and the app cannot add a script to it                                                   | n/a                                      | **Disabled**, gap B     |

**Gap A is a packaging gap, not a security one.** `annotation-frame.js` is
emitted by `apps/desktop/artifact-picker-plugin.ts`, which only the desktop Vite
build and dev server use. The browser host Worker serves `/assets/*` and five
install files and nothing else. `annotation-surface.tsx` therefore gates picking
on `window.rally`, and `site-resource-detail.tsx` disables Comment mode whenever
`surface.framed` is set. Because the feed's "open at the saved spot" for a site
goes through this same opaque frame rather than the live page, gap A also means a
browser reader cannot see where a saved site comment pointed.

Verified on 2026-10-29 in the sandbox's Chromium: under the browser host's exact
CSP (`script-src 'self'`, `frame-src` naming only the artifact domain), a
`srcdoc` frame with `sandbox="allow-scripts"` loads an external app-origin script
carrying the frame's nonce, blocks the file's own inline script, reports origin
`null`, and is identifiable as `event.source`. Nothing in the policy has to
change.

**Gap B is the real one.** The 2026-10-19 PRD proposed serving-Worker injection
of a page-origin picker for the browser, and its decision log records why it was
not built: it needed a reload with a pick flag, and the page could forge pins
because its scripts share the picker's origin. The requester accepted
native-only website support instead. This PRD reopens that decision with a
design that removes the reload and takes the page out of the input path.

## Motivation

The browser client is a first-class host: members and guests use it, and guests
have no other host. A guest shared into a thread about a landing page is exactly
the person who wants to click a button and say "this should say Book a demo",
and today they get a disabled icon and a tooltip telling them to install a Mac
app they may not have a Mac for. Every other annotation kind already works in
the browser, so websites are the one artifact kind a browser reader can see but
not point at.

## Goals

1. Comment mode works on a live artifact in the browser client's inline preview,
   with the same pin sizes as the desktop: element, word, dragged range, and
   Alt or arrow growth to the container.
2. Comment mode works on an HTML file in the browser client, and a saved site
   or HTML annotation opened from the feed highlights its spot there.
3. A hostile or buggy page cannot create a pin, cannot read a comment, and
   cannot receive any pointer or keyboard input while Comment mode is on.
4. Entering Comment mode never reloads the page or loses its state, and
   following a link inside the site keeps Comment mode on.
5. Public visitors, crawlers and the desktop's own surfaces receive no injected
   script and no behavior change.
6. The desktop and the browser share one inspector implementation; only the
   driver that feeds it input differs.

## Non-goals

1. **Comments in the browser pop-out.** It is a plain `window.open` tab with no
   Rally parent to drive it. Deferred; the inline preview is the surface.
2. **A screenshot with a browser pin.** A cross-origin frame cannot be captured
   from the app, and bytes supplied by the page are refused on purpose. The
   model receives the element HTML, visible text and context, as it does for a
   static HTML file. A server-rendered crop (Cloudflare Browser Rendering of the
   saved version) is a possible follow-up, not part of this.
3. **Arbitrary third-party iframes.** Only Rally-served artifact responses carry
   the inspector. Nothing here applies to a page Rally does not serve.
4. **Protecting the page from the person.** Comment mode is a tool the viewer
   points at a page they can already read; this PRD protects the viewer and the
   app from the page, not the reverse.
5. **iOS.** Per the platform default.

## Product behavior

Identical to the desktop as described in the annotations PRD, with these
differences a person can notice:

- In the browser, the Comment control is enabled once the preview reports it is
  ready to take comments. On the public neutral page, a protected site's 401 or
  an error page it stays disabled, with the tooltip "This page cannot take
  comments here."
- While Comment mode is on, the page does not react to the pointer: buttons do
  not hover, links do not follow, and the site's own drag behavior is off. The
  page still scrolls under the wheel, and the hover outline, cursor and comment
  cards are drawn by Rally over the page.
- Pins made in the browser carry no screenshot. The composer chip and the feed
  excerpt look the same as a desktop pin without one.
- Following a link inside the site while in Comment mode keeps Comment mode
  on; the new page is ready after it loads. Leaving the artifact origin is not
  possible from the frame, as today.

## Key design decisions

### 1. The page-side script answers questions; it never initiates

Today's picker listens for the page's own `mousemove`, `click`, `dblclick` and
`keydown`, decides what was selected, and reports a pin. In a browser the page's
scripts can dispatch those events, remove the listeners' effects, or post a
pin themselves. So the browser transport inverts the direction: the script
registers one `message` listener and otherwise does nothing. Each message is a
request with a `requestId` from the app, and each produces at most one reply
carrying that id. The app ignores a reply whose id it did not issue or has
already consumed. A page that forges messages can only answer a question that
was really asked, once, and the only questions are "what block is at this
point", "what is this element's description", "scroll here", "select between
these points" and "where are these anchors now".

Rejected: keeping the event-driven picker and gating accepted pins on
`navigator.userActivation.isActive` in the app, which browsers propagate from a
frame click to its ancestors. It bounds forged pins to one per real click but
leaves the page in the input path: it sees every pointer event, can suppress
the outline, and can swap the pinned element between hover and click.

### 2. A glass overlay owns every input while Comment mode is on

`site-resource-detail.tsx` draws a transparent `div` over the whole frame when
`picking` is true. The overlay has focus and receives every pointer, wheel and
key event. Pointer moves become `inspect` requests, clicks become `pin`
requests, wheel deltas become `scroll` requests, drags become `select`
requests, and Alt, ↑, ↓ and Escape are handled in the app exactly as the
Markdown surface handles them. The hover outline and the comment-mode cursor are
app DOM over the frame, positioned from the rects the frame reports, so the
page cannot hide them.

Verified on 2026-10-29 in the sandbox's Chromium with a two-origin harness: with
the overlay in place the framed page observed zero `click` and zero
`mousemove` events; an app click produced an `inspect` reply with the element's
rect; a forwarded wheel scrolled the frame; a later click resolved a different
element; `caretPositionFromPoint` answered for drag selection.

Rejected: `pointer-events: none` on the overlay with input entering the page.
That is today's desktop model and it depends on an isolated world to be safe.

### 3. The inspector is injected on every framed load, dormant until spoken to

The serving Worker prepends `<script src="/__rally/picker.js" data-app-origin="…">`
as the first child of `<head>` on a successful `text/html` response whose
request carries `Sec-Fetch-Dest: iframe`, and only when `BROWSER_APP_ORIGIN`
is configured. The script captures the native DOM functions it needs, installs
one `message` listener that accepts only `event.source === window.parent` with
`event.origin` equal to the configured app origin, and returns. It adds nothing
to the DOM and runs nothing until the app sends `hello`.

Why framed loads rather than a pick flag: this is what removes the reload. The
script is already in the document when the person presses Comment, and it is in
the next document after an in-site link, so Comment mode survives navigation.

Why framed loads rather than viewer sessions: `frame-ancestors` admits exactly
the browser client, so a framed artifact response is a Rally browser-client
load by construction. Keying on the session instead would exclude Safari, which
refuses the partitioned viewer cookie and views the public representation. A
`curl` that spells the header gets a public page with a public, inert script.

Why first in `<head>`: it precedes any page `<meta>` CSP, which applies only
from the point it is parsed, and it captures native functions before page code
can replace them. The artifact CSP's `script-src 'self'` already admits it.

Rejected: inlining the script with a nonce. The page's own `unsafe-inline`
policy makes that no tighter, and an external same-origin file is cacheable.

### 4. Comment cards live in the app, not in the page

The desktop draws confirmed comment cards inside the page because a
`WebContentsView` composites above the app's DOM. A frame does not, so the
browser draws `AnchoredAnnotationComment` over the frame, as the Markdown and
image surfaces already do, and asks the frame only for the anchors' rects. The
comment text never enters the page. Edit and remove are app clicks with no
`isTrusted` dance.

### 5. One inspector, two drivers

`artifact-picker.ts` is split into **primitives** that take elements and points
and return data, and **drivers** that feed them. The primitives are
`blockAt(point)`, `grow(element)`, `shrink(element, leaf)`,
`describe(element)` (CSS path, fractional box, trimmed HTML, visible text,
before and after context, page path), `selectBetween(a, b)` and
`anchors(locators)`. The existing event-driven picker becomes the **event
driver**: the same listeners as today, calling the primitives, used by the
desktop isolated world and the opaque `srcdoc` frame. The new **message driver**
exposes the primitives over `postMessage` for the browser's live frame. Element
identity across requests is an opaque token the frame mints per document,
backed by a `WeakRef`, cleared on `end`.

This is the platform split: the picker becomes a block, and each host composes
it with the input it can trust.

### 6. The pin shape does not change

A browser pin is an `ArtifactPickerPin` minus `point` and `screenshot`. The app
knows the point because it received the click, and it strips `screenshot` from
anything a frame sends before parsing, so the page cannot supply image bytes.
The server-side schema and the stored annotation are untouched.

## Protocol

Messages from the app to the frame, each with a `requestId`; every reply echoes
it. All shapes are Zod schemas in `@rally/contracts` and are parsed on both
sides as untrusted input.

| Request                                      | Reply                                             | Notes                                                                                                                |
| -------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `hello`                                      | `ready { pagePath }`                              | Sent after each frame `load`. No reply means no Comment mode.                                                        |
| `begin`                                      | none                                              | Installs the cursor-free picking state; captures nothing.                                                            |
| `inspect { x, y, level }`                    | `inspected { hit: { token, rect, tag } \| null }` | Point in frame CSS pixels; `level` is the grow depth from the hovered leaf.                                          |
| `pin { token }`                              | `pinned { pin }`                                  | `pin` is `ArtifactPickerPin` without `point` or `screenshot`.                                                        |
| `pin { x, y, word: true }`                   | `pinned { pin }`                                  | Caret at point, expanded to a word where the browser can; else the block.                                            |
| `select { from, to }`                        | `selected { rect }`                               | Sets the native selection between two caret positions so the person sees it.                                         |
| `pin { selection: true }`                    | `pinned { pin }`                                  | The selection's text and its common block.                                                                           |
| `scroll { x, y, dx, dy }`                    | `scrolled`                                        | Scrolls the nearest scrollable ancestor at the point.                                                                |
| `anchors { pins: [{ id, locator, exact }] }` | `anchored { rects }` then pushes                  | The only unsolicited message: `anchors-moved { rects }`, throttled to animation frames while anchors are registered. |
| `end`                                        | none                                              | Clears tokens, selection and anchors.                                                                                |

Acceptance rules in the app, in order: `event.source` is the preview frame's
window; `event.origin` is the artifact origin from the minted access; the
message parses; for replies, the `requestId` is outstanding, and it is consumed
on first use; `anchors-moved` is accepted only while anchors are registered and
only repositions cards. Nothing the frame sends can add, confirm, edit or
remove a pin. There are no timeouts: an unanswered `inspect` draws no outline
and an unanswered `pin` adds nothing, and the next click issues a new request
that supersedes the old id.

## Security and trust model

What this changes for a page Rally serves, and only when it is framed by the
browser client:

- The page gains a Rally script in its head. It can read the script, which is
  public source. It can replace the DOM functions the script uses, but the
  script captured the native ones first.
- While Comment mode is on, the page learns pointer coordinates and receives
  scroll deltas. It receives no pointer, wheel or key events and no user
  activation, so it cannot open a popup, start a download or follow a link on
  the person's click.
- The page can answer a question with a lie: a different element's HTML, a
  wrong rect. The person sees the resulting chip and the outline before they
  type a comment, the model already treats quoted content as untrusted data,
  and the locator is verified against frozen HTML before it is ever
  highlighted again. This is the same power the page has by rendering.
- The page never sees a comment, a viewer identity, an attachment id or a
  draft. The only thing the app sends about a pin is its locator and trimmed
  HTML, both of which the page produced.

What stays closed: `allow-scripts` and `allow-same-origin` are never combined
on an opaque frame; the frame sandbox for a live artifact is unchanged; the
desktop renderer still never frames; prior-version mounts are untouched
because the feed opens a saved spot through frozen HTML, not the live origin;
public, top-level and crawler responses are byte-identical to today.

Both new boundaries, the serving-Worker injection and the message driver, get a
security review before Comment mode is enabled in the browser, and
[`security.md`](../../security.md) records the result.

## Change outline

Grouped by the gap each closes. Gap A is independent and small; ship it first.

**Gap A, HTML files and saved spots in the browser**

- Move `artifact-picker-plugin.ts` beside the contracts it serializes and use
  it from `apps/browser/vite.config.ts` as well as the desktop build.
- `apps/browser/src/worker.tsx`: serve `/annotation-frame.js` from assets with
  `nosniff`, beside the install files.
- `annotation-surface.tsx`: replace the `window.rally` gates with a host
  capability from `useShellCapabilities`, true on both hosts.
- `security.md`: the opaque-frame rule is host-independent; verify in a real
  browser window per [`dev-environment.md`](../../dev-environment.md).

**Gap B, live sites in the browser**

- `packages/contracts/src/artifact-picker.ts`: split into primitives, the event
  driver and the message driver; add the protocol schemas. The desktop
  isolated-world calls and the opaque frame keep their behavior through the
  event driver.
- `apps/api/src/artifacts/serving-policy.ts`: `shouldInjectInspector(request,
response, appOrigin)` and the `<head>`-first injection, by string on buffered
  static HTML and by `HTMLRewriter` on a streamed active response, next to the
  social-preview injection it mirrors. Serve `/__rally/picker.js` before the
  hostname lookup, as `/__rally/open` is, from the contracts source, with a
  content-addressed path so it caches.
- `apps/desktop/src/renderer/lib/framed-artifact-picker.ts`: the message
  driver's app half: request ids, origin checks, the overlay's event handling,
  and a `surface`-shaped result (`pick`, `stopPicking`, `anchors`) so
  `site-resource-detail.tsx` branches on `framed` once for the overlay and the
  cards and otherwise runs the loop it runs today.
- `site-resource-detail.tsx`: the glass overlay, the app-drawn outline and
  cursor, app-side keyboard handling, cards from `anchors`, the ready-gated
  Comment control, and the `screenshot` strip on framed pins.
- `live-web-artifacts.md`, `artifact-annotations.md`, `security.md`,
  `browser-client.md`: update in the same change, with changelog entries where
  the mechanism changed.

No new defensive limit is introduced. Replies are bounded by request ids rather
than counts, and readiness is an event rather than a wait.

## Testing

- **Contracts:** primitives against a jsdom document for description, path
  and context; the message driver's acceptance rules with forged `source`,
  wrong origin, unsolicited reply, reused id and an unregistered anchor push.
- **API Node:** injection on a framed 2xx HTML response and on nothing else
  (top level, anonymous read, JSON, 401, the neutral page); the script is the
  first child of `<head>`, and the page's own head content follows it;
  `/__rally/picker.js` resolves without a hostname lookup.
- **`test-workers/`:** real `HTMLRewriter` on a streamed stateless active
  response, with a production break (skip the `head` handler) to prove the test
  fails.
- **Browser lane:** a Playwright check in Chromium against a local two-origin
  harness like the one used for this PRD: the page sees no input in Comment
  mode; inspect, pin, word, drag, scroll and anchors round-trip; a page that
  overrides `elementFromPoint` and posts forged pins produces no pin.
- **Visual:** both gaps checked in a real browser window and the desktop
  rechecked for no change, per the rule in the agent rule sheet.

## Rollout

Gap A ships to everybody on merge. Gap B ships behind the existing
`liveArtifactsEnabled` client flag's host check: the serving Worker injection
is inert without an app sending `hello`, so it can deploy first, and the client
enables the browser Comment control once the security review passes. Turning it
off is reverting the client change; the injection may stay.

## Acceptance

- In the browser client, pin a button on a live site, type a comment, send. The
  model's turn shows the element's HTML and visible text, and Rally edits it.
- Pin a word by double-click and a range by drag on the same site.
- Follow a link inside the site while in Comment mode; pin on the new page.
- Open a feed excerpt for a site annotation in the browser; the saved spot is
  highlighted in the frozen page, or the saved quote shows when it cannot be.
- Pin a button on an HTML file attachment in the browser.
- A hostile test page that posts `pinned` messages on load and on a timer adds
  no pin, and its `click` and `mousemove` listeners never fire during Comment
  mode.
- A public visitor and a desktop viewer of the same site receive responses
  with no `/__rally/picker.js` reference.

## Open questions

1. **Safari before 18.4** lacks `caretPositionFromPoint`; the driver falls back
   to `caretRangeFromPoint`, and where neither exists a double-click pins the
   block. Confirm the floor the team supports.
2. **Keyboard scrolling** inside Comment mode (space, Page Down) is forwarded
   as `scroll`; arrow keys are taken by grow and shrink as on the desktop.
   Decide whether that is acceptable or whether arrows should scroll when no
   block is outlined.
3. **Should the desktop move to the message driver too?** It cannot use the
   glass overlay (the native view composites above the DOM), so it keeps the
   event driver in its isolated world. Revisit if the desktop ever frames.
