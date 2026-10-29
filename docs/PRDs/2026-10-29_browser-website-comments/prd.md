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

The browser client previews a live artifact in an `<iframe>` on the artifact's
own origin, and the one picker script Rally has cannot get into that document
from outside. The desktop puts it there through an Electron isolated world. The
browser has no such thing, so the serving Worker puts it there instead, for
both hosts: every HTML response served to a Rally viewer carries Rally's picker,
dormant until the host speaks to it. The script exposes one in-page API; the
browser reaches it over `postMessage` and the desktop over `executeJavaScript`,
replacing the isolated world. Comment cards render inside the artifact's DOM on
both hosts.

The 2026-10-19 PRD proposed this and then narrowed to native-only because the
page's scripts share the picker's origin and could post a pin. This PRD records
why that is not a threat worth building around: the page is written by the
workspace's own agent through `publish_resource`, nobody edits it by hand, and a
pin a page could forge can only quote what the page is already showing. The
checks that remain are the cheap structural ones the opaque HTML frame already
uses.

The same change fixes the unrelated reason HTML _files_ cannot take comments in
the browser: the opaque frame's picker asset is built only for the desktop.
Both fixes apply to content Rally serves. Arbitrary third-party iframes are out
of scope.

## What exists today

Read with [`artifact-annotations.md`](../../artifact-annotations.md) open.

One picker in `packages/contracts/src/artifact-picker.ts` does the outline,
grow, pin and comment-card work on every HTML surface. What differs is how it
gets into the document:

| Surface                                              | How the script gets in                                                                                          | Browser client      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| HTML file, rail or lightbox                          | `srcdoc` frame, `sandbox="allow-scripts"`, fresh nonce, external `/annotation-frame.js` from the app origin     | **Disabled**, gap A |
| Saved site annotation (feed excerpt, draft reattach) | Same opaque frame over frozen HTML from `GET /resources/:id/versions/:v/site-preview`                           | **Disabled**, gap A |
| Live site, desktop rail and pop-out                  | `executeJavaScriptInIsolatedWorld(1001)` in the `WebContentsView`; cards in the same world; `capturePage` crops | n/a                 |
| Live site, browser client                            | Nothing                                                                                                         | **Disabled**, gap B |

**Gap A is packaging.** `annotation-frame.js` is emitted by
`apps/desktop/artifact-picker-plugin.ts`, which only the desktop build and dev
server use, and the browser host Worker serves `/assets/*` plus five install
files. So `annotation-surface.tsx` gates picking on `window.rally`. Because the
feed's "open at the saved spot" for a site goes through this same opaque frame,
gap A also hides where a saved site comment pointed from a browser reader.

Verified on 2026-10-29 in the sandbox's Chromium: under the browser host's exact
CSP (`script-src 'self'`, `frame-src` naming only the artifact domain), a
`srcdoc` frame with `sandbox="allow-scripts"` loads an external app-origin script
carrying the frame's nonce, blocks the file's own inline script, reports origin
`null`, and is identifiable as `event.source`. The policy does not change.

**Gap B is the missing transport.** `artifactFrameScript()` already contains
everything the live frame needs: it listens for `rally-annotation-comments` from
its parent, draws cards, runs the picker, and posts `rally-artifact-pin` and
`rally-annotation-comment-action` back. It is only ever loaded into the opaque
frame. `site-resource-detail.tsx` disables Comment mode whenever
`surface.framed` is set.

## Motivation

The browser client is a first-class host, and guests have no other host. A
guest shared into a thread about a landing page is exactly the person who wants
to click a button and say "this should say Book a demo". Every other annotation
kind already works in the browser; websites are the one artifact kind a browser
reader can see but not point at.

## Goals

1. Comment mode works on a live artifact in the browser client's inline
   preview, with the desktop's pin sizes: element, word, dragged range, and Alt
   or arrow growth to the container.
2. Comment mode works on an HTML file in the browser client, and a saved site or
   HTML annotation opened from the feed highlights its spot there.
3. Entering Comment mode never reloads the page, and following a link inside
   the site keeps Comment mode on.
4. Public visitors, crawlers and the desktop's own surfaces receive no injected
   script and no behavior change.
5. One script with one in-page API on every host. The desktop drops its
   isolated-world transport and calls the same API the browser does, so there
   is one thing to change and one thing to test.

## Non-goals

1. **Comments in the browser pop-out.** It is a plain `window.open` tab with no
   Rally parent to drive it. Deferred.
2. **A screenshot with a browser pin.** A cross-origin frame cannot be captured
   from the app, and the page is not asked for one. The model receives the
   element HTML, visible text and context, as it does for an HTML file.
3. **Isolating the picker from the page's own scripts.** See
   [Trust model](#trust-model).
4. **iOS.** Per the platform default.

## Product behavior

Identical to the desktop, with these differences a person can notice:

- The Comment control is enabled once the frame's picker reports ready. On the
  public neutral page, a protected site's 401 or an error page it stays
  disabled, with the tooltip "This page cannot take comments here."
- Browser pins carry no screenshot. The composer chip and the feed excerpt look
  the same as a desktop pin without one.
- Following a link inside the site in Comment mode keeps Comment mode on; the
  next page is ready after it loads.

## Impact on the product contract

None. This refines behavior within the existing contract: the browser client
gains a pin kind the Mac app already had, and what the agent is allowed to do
with a pin is unchanged. The one new thing the agent is told is to rebuild
the person's window before a visual edit when no screenshot came with the pin.

## Decision log

### 2026-10-29 — The script's path carries its content hash and the app origin lives in its body

**Decided:** The served file is `/__rally/picker-<hash>.js`, where the hash is
over the script text including the app origin, and the bridge reads its
`parentOrigin` from that text rather than from a `data-app-origin` attribute.
The Worker answers any hash spelling, but sends a year-long cache header only
when the hash is its own.

**Why:** A browser caches the file for a year, so a different app origin has to
be a different file, and a page must not be able to change the origin the
bridge listens to by editing an attribute. The cache rule keeps an older
isolate, asked for a newer path during a deploy, from pinning its script under
that name.

**Changes:** The design section's `<script src="/__rally/picker.js"
data-app-origin="…">`. Shipped in #1452.

### 2026-10-29 — The desktop's own surfaces move onto the injected script

**Decided:** The desktop's rail view and pop-out load the same injected script
and call it through `executeJavaScript`; the isolated world is retired.

**Why:** Goal 5 asked for one script and one API on every host, and a second
transport that happened to be free was still a second thing to change and
test.

**Changes:** Goal 4 narrows: public visitors and crawlers still get no script
and no change, but the desktop's own surfaces do change transport. Shipped in
#1452.

### 2026-10-29 — A browser pin carries the viewer's window, not a screenshot

**Decided:** The element locator gains an optional `viewport` (CSS-pixel size,
scroll offsets, device pixel ratio, color scheme), the picker records it, and
a rendered pin without a screenshot tells the model to rebuild that window in
its sandbox with the recipe in the building-live-sites skill. The page sets a
pin's `pagePath` and `css`, so neither is copied into that guidance; they
stay quoted in `<location>`.

**Why:** A browser cannot capture its frame, and the desktop's crop was what
let the model see a visual request. Rebuilding the view costs the agent one
command and no new service. `viewport` is a new key on a strict schema, so a
desktop build older than this change shows no chip for a message carrying a
browser website pin; accepted over keeping the window out of the locator.

**Changes:** Product behavior gains the window on a pin; nothing else in the
agreed scope. Shipped in #1452.

### 2026-10-29 — The tag is deferred, and a navigated opaque frame loses its scripts

**Decided:** The injected tag carries `defer`, so a page parses without waiting
on the fetch; `comments()` and `restore()` look elements up once the document
has parsed. The uploaded-file frame's `allow-scripts` lets the file navigate
its frame, so the surface treats a second load of the frame as a document it
did not write: it remounts the frame without scripts, ends Comment mode and
ignores its messages.

**Why:** Review of #1452. The parser block cost every artifact open a round
trip for a script most opens never use, and a navigated frame would have run a
page's scripts inside the Rally pane with the pane still listening to it.

**Changes:** Nothing in the agreed scope; the trust model's "the file's own
scripts never run" gains the navigation caveat. Shipped in #1452.

### 2026-10-29 — The opaque frame's bridge carries a per-document key, and injection is for navigations only

**Decided:** The surface puts the frame's nonce into the script URL as a key;
the script echoes it on every message and the surface refuses any without it,
and the script announces its leaving as it unloads, at which the surface stops
sending to the window before the next document can run.
The host names the open selection as the pin's CSS path, page path and quoted
markup, which the script verifies as it does a card's element. The Worker
injects the script only into navigations, not into a page's own fetches. A
locator's `pagePath` must be one absolute path.

**Why:** Second review of #1452. A document the file navigated to shares the
frame's `contentWindow` and could post before its `load` fired; a bare CSS
path lit up a look-alike element on another page; a viewer's page fetching a
partial got Rally markup prepended to it; and a protocol-relative page path
would have sent the skill's recipe to another host.

**Changes:** Nothing in the agreed scope. Shipped in #1452.

## Design

### The serving Worker injects the picker for Rally viewers

In `serveCurrent`, where the admitted viewer is known and the social-preview
injection already runs, a successful `text/html` response gets
`<script src="/__rally/picker.js" data-app-origin="…"></script>` prepended as
the first child of `<head>` when the request carried a valid viewer session
(`admitted.viewerId`) or arrived framed (`Sec-Fetch-Dest: iframe`, with
`BROWSER_APP_ORIGIN` configured). The viewer session covers the desktop's
`WebContentsView` and pop-out, which load top-level with the `Lax` cookie; the
framed rule covers Safari, which refuses the partitioned cookie and views the
public page. An anonymous public read, a crawler and an unfurler get no script.
The injection mirrors the social-preview one: a string edit on buffered static
HTML, an `HTMLRewriter` on a streamed active response. `/__rally/picker.js` is
served before the hostname lookup, as `/__rally/open` is, from the contracts
source, with a content-addressed path so a browser caches it. The artifact
CSP's `script-src 'self'` admits it; a page's own `<meta>` policy applies only
from where it is parsed, so head-first keeps the page from blocking it by
accident.

Why every viewer load rather than a pick flag: this removes the reload the
2026-10-19 PRD worried about. The script is already there when the person
presses Comment and is there again after an in-site link. A person who used
"Open in browser" and holds a redeemed session gets the same inert script in
their own tab; nothing there speaks to it.

### One script, one in-page API

`/__rally/picker.js` is built from the pieces of today's `artifactFrameScript()`
and installs `globalThis.rallyAnnotations` with:

| Call                      | Does                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `pick()`                  | Starts picking if not started; resolves with the next `ArtifactPickerPin`, or `null` on Escape. |
| `stopPicking()`           | Removes the cursor, outline and listeners; resolves any waiting `pick()` with `null`.           |
| `comments(pins)`          | Draws cards for the pins; resolves with the edit or remove action when a card is clicked.       |
| `restore(locator, exact)` | Highlights the saved element and resolves whether it was found.                                 |
| `rect(css)`               | The element's viewport rectangle, for the desktop's screenshot crop.                            |

The queue-and-waiter state that `index.ts` builds today inside the isolated
world lives in the script. It installs nothing and draws nothing until a host
calls it.

### Two ways to call it

**The browser client** cannot call into a cross-origin frame, so the script
also listens for `message` events from `window.parent` whose `event.origin`
equals the app origin it was served with, and maps `rally-annotation-picking`,
`rally-annotation-comments` and `rally-annotation-restore` onto the API,
posting `rally-annotation-ready` on install and `rally-artifact-pin`,
`rally-annotation-comment-action` and `rally-annotation-restored` back.
`site-resource-detail.tsx` gains a `framed` branch where today it disables the
control. Acceptance is what `annotation-surface.tsx` does for the opaque frame:
`event.source` is the preview frame's window, `event.origin` is the artifact
origin from the minted access, Comment mode is on, the payload parses with the
shared schemas, a comment action names a pin the app holds, and `screenshot` is
deleted before parsing. The comment editor anchors at `pin.point` offset by the
frame's rectangle. The ready message enables the control; a frame `load` with
no ready message leaves it disabled.

**The desktop** owns the `WebContentsView` and calls the API directly:
`contents.executeJavaScript('globalThis.rallyAnnotations?.pick() ?? null')`
and likewise for the others, in place of today's
`executeJavaScriptInIsolatedWorld(1001, …)` with the picker source inlined.
`ArtifactViewHandle.pick`, `comments` and `stopPicking` keep their signatures,
so the renderer, the IPC fences and the pop-out are untouched. The handle gains
`ready()`, which asks whether `rallyAnnotations` exists after `dom-ready`, and
the rail enables Comment mode on it exactly as the browser does. The screenshot
crop stays in main through `capturePage`, with the element rectangle read from
`rect(css)`.

**The opaque HTML-file frame** loads the same script as `/annotation-frame.js`
from the app origin under its nonce and uses the same messages, with the
`data-annotation-*` attributes replaced by `rally-annotation-restore` and
`rally-annotation-picking` sent after `rally-annotation-ready`.

Comment cards render in the page from one card renderer, so the person sees
the same card on every host.

### Gap A

Move `artifact-picker-plugin.ts` beside the contracts it serializes, use it from
the browser build too, serve `/annotation-frame.js` from the browser host
Worker with `nosniff`, and replace the `window.rally` gates in
`annotation-surface.tsx` with a host capability that is true everywhere.

## Trust model

What the page's own scripts can now do that they could not: see a Rally script
in their head and the `rallyAnnotations` API on `globalThis`, replace or call
it, see Comment mode messages from a parent, post a message the browser app
will read while Comment mode is on, and read the comment cards drawn in their
DOM. On the desktop this is new too: the isolated world kept all of it out of
the page's reach, and it goes because Electron made that isolation free, not
because anyone needed it.

Why none of that is worth defending against:

- **The author is the workspace's agent.** A live artifact is published by
  `publish_resource` from a Terminal run acting for this workspace. Members do
  not edit the files by hand and guests cannot publish. A page that posts a
  forged pin was written by the same agent that will receive the pin.
- **A forged pin is content the page shows.** The pin carries a CSS path,
  trimmed HTML, visible text and context. The person sees the chip before
  typing a comment, and the model already treats quoted content as untrusted
  data. The page could show the same text on screen with less effort.
- **Comments are already the page's audience.** A comment is an instruction
  about this page that goes to the agent that wrote it, in a thread the page's
  workspace owns. Egress from the page is closed by the artifact CSP, so the
  text cannot leave the origin; a stateful site storing it writes to data the
  workspace can read anyway.
- **The checks that stay are free.** Source, origin, mode and schema checks are
  a few lines, catch bugs and stray messages, and are the same lines the opaque
  frame runs today. Nothing about the sandbox, the CSP egress fences, the
  fetch-metadata fence or the viewer-session rules changes.

What stays closed, because those are real threats: an **uploaded** HTML file is
not agent-authored, so it keeps the opaque `srcdoc` frame where its own scripts
never run, and `allow-scripts` and `allow-same-origin` are never combined
there. Model-authored content is still never same-origin with the app. Public,
top-level and crawler responses are byte-identical to today. The desktop
renderer still never frames.

### The decision behind the trust model

**2026-10-29: website picking shares the page's origin on every host.**
Reverses the 2026-10-19 decision that accepted native-only website support over
serving-Worker injection, and retires the desktop's isolated world with it. The
requester judged the forgery boundary not a real threat for pages the
workspace's own agent writes, asked for a startup-scale design rather than one
hardened against the page's author, and chose one transport for both hosts
over keeping a second one that happened to be free. Considered and rejected on
the way here, all for cost against a threat that is not real:

- A **glass overlay** in the app taking every pointer and key event in Comment
  mode and driving the page script as a query-only inspector. Verified
  workable in Chromium; adds a request protocol, scroll and selection
  forwarding, and app-drawn cards, to deny the page input it may as well have.
- **Freeze-to-canvas**: render the page in Cloudflare Browser Run on entering
  Comment mode, read a DOM map from an isolated world, pick against a
  screenshot. Adds a browser binding, a warm-session object and a second of
  latency per entry, and loses client-side state, to keep Rally code out of a
  page Rally's agent wrote.
- **Full remote display** of every artifact through a streamed canvas. Worse
  page for members than for strangers, per-view browser cost, and against the
  low-latency rule for opening resources.

## Change outline

- `packages/contracts/src/artifact-picker.ts`: `artifactAnnotationScript(appOrigin)`,
  one source that installs `rallyAnnotations` and the message bridge, replacing
  `ARTIFACT_PICKER_SOURCE`, `ARTIFACT_COMMENTS_SOURCE`, `ARTIFACT_RESTORE_SOURCE`
  and `artifactFrameScript()` as separately embedded strings; the message
  schemas for the bridge.
- `apps/api/src/artifacts/serving-policy.ts`: `shouldInjectPicker(admitted,
request, response, appOrigin)` and the head-first injection (string and
  `HTMLRewriter`); `index.ts` serves `/__rally/picker.js` before the hostname
  lookup and applies the injection in `serveCurrent`.
- `apps/desktop/src/main/index.ts`: `pick`, `comments` and `stopPicking` call
  the page API through `executeJavaScript`; the isolated-world code and the
  inlined picker sources go. `artifact-viewers.ts`: `ArtifactViewHandle.ready()`
  and the controller's use of it.
- `apps/desktop/src/renderer/components/site-resource-detail.tsx`: the
  `framed` branch described above and the ready gate on both hosts; the
  disabled reason goes.
- `apps/desktop/artifact-picker-plugin.ts` moves to a shared location;
  `apps/browser/vite.config.ts` uses it; `apps/browser/src/worker.tsx` serves
  the file; `annotation-surface.tsx` drops the `window.rally` gates.
- `live-web-artifacts.md`, `artifact-annotations.md`, `security.md`,
  `browser-client.md` updated in the same change, with changelog entries where
  the mechanism changed. `security.md`'s "Website selection is native-only"
  paragraph and its isolated-world claims are rewritten to the trust model
  above.

No new defensive limit. Readiness is a message, not a wait.

## Testing

- **API Node:** injection on a viewer-session or framed 2xx HTML response and
  on nothing else (anonymous read, JSON, 401, the neutral page); the script is the
  first child of `<head>`; `/__rally/picker.js` resolves without a hostname
  lookup and carries a cacheable content type.
- **`test-workers/`:** real `HTMLRewriter` on a streamed stateless active
  response, with a production break (skip the `head` handler) to prove the test
  fails.
- **Renderer:** the framed branch accepts a pin from the frame's window and
  origin while picking and ignores one from another source, another origin,
  with Comment mode off, or with a `screenshot`; a comment action for an
  unknown pin is ignored.
- **Desktop main:** the handle's `pick`, `comments`, `stopPicking` and `ready`
  against a fake `executeJavaScript`, including a page where the API is absent
  (ready false, pick null).
- **Contracts:** the in-page API against a jsdom document: a `pick()` waiting
  before a click resolves with that pin, a pin before any `pick()` is queued,
  `stopPicking()` resolves a waiter with `null`, and `comments()` resolves on a
  card's click.
- **Visual:** both gaps in a real browser window, and the desktop rechecked for
  no change, per the rule in the agent rule sheet.

## Rollout

Ships to everybody on merge. The injection is inert without an app that sends
`rally-annotation-picking`, so the Worker can deploy ahead of the client.
Turning it off is reverting the client change.

## Acceptance

- In the browser client, pin a button on a live site, type a comment, send.
  The model's turn shows the element's HTML and visible text, and Rally edits
  it.
- Pin a word by double-click and a range by drag on the same site.
- Follow a link inside the site in Comment mode; pin on the new page.
- Open a feed excerpt for a site annotation in the browser; the saved spot is
  highlighted in the frozen page, or the saved quote shows when it cannot be.
- Pin a button on an HTML file attachment in the browser.
- Pin a button on a live site in the desktop rail and in the desktop pop-out;
  the pin carries a screenshot crop, as today.
- A public visitor of the same site receives a response with no
  `/__rally/picker.js` reference.

## Open questions

None. The desktop's move to the injected transport was decided on 2026-10-29
(see the decision log and the trust model).
