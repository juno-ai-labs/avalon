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
browser has no such thing, so the serving Worker puts it there instead: every
HTML response the browser client frames carries Rally's picker, dormant until the
app speaks to it over `postMessage`. Comment cards render inside the artifact's
DOM, exactly as they do on the desktop.

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
5. One picker, one card renderer, three transports. No second implementation.

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

## Design

### The serving Worker injects the picker on framed loads

In the Worker's outer `fetch`, beside `allowBrowserFraming`, a successful
`text/html` response to a request carrying `Sec-Fetch-Dest: iframe` gets
`<script src="/__rally/picker.js" data-app-origin="…"></script>` prepended as
the first child of `<head>`, only when `BROWSER_APP_ORIGIN` is configured. It
mirrors the social-preview injection: a string edit on buffered static HTML, an
`HTMLRewriter` on a streamed active response. `/__rally/picker.js` is served
before the hostname lookup, as `/__rally/open` is, from the contracts source,
with a content-addressed path so a browser caches it. The artifact CSP's
`script-src 'self'` admits it; a page's own `<meta>` policy applies only from
where it is parsed, so head-first keeps the page from blocking it by accident.

Why every framed load rather than a pick flag: this removes the reload the
2026-10-19 PRD worried about. The script is already there when the person
presses Comment and is there again after an in-site link. `frame-ancestors`
admits exactly the browser client, so a framed artifact load is a browser-client
load by construction; a `curl` that spells the header gets a public page with a
public, inert script. Keying on the viewer session instead would exclude
Safari, which refuses the partitioned cookie and views the public page.

### The script is the one that exists

`/__rally/picker.js` is `artifactFrameScript()` with two changes: picking and
restore start on a `rally-annotation-picking` message instead of
`data-annotation-*` attributes, and every message it accepts must have
`event.source === window.parent` and `event.origin` equal to the app origin it
was served with. It installs nothing and draws nothing until the app speaks.

### The app talks to the frame the way it already talks to the opaque frame

`site-resource-detail.tsx` gains a `framed` branch where today it disables the
control. It posts `rally-annotation-picking { on }` and
`rally-annotation-comments { pins }` to the frame and accepts
`rally-annotation-ready`, `rally-artifact-pin` and
`rally-annotation-comment-action` from it. Acceptance is what
`annotation-surface.tsx` does for the opaque frame: `event.source` is the
preview frame's window, `event.origin` is the artifact origin from the minted
access, Comment mode is on, the payload parses with the shared schemas, a
comment action names a pin the app holds, and `screenshot` is deleted before
parsing. The comment editor anchors at `pin.point` offset by the frame's
rectangle. The ready message enables the control; a frame `load` with no ready
message leaves it disabled.

Comment cards render in the page from the same `ARTIFACT_COMMENTS_SOURCE` the
desktop uses, so the person sees the same card in both hosts.

### Gap A

Move `artifact-picker-plugin.ts` beside the contracts it serializes, use it from
the browser build too, serve `/annotation-frame.js` from the browser host
Worker with `nosniff`, and replace the `window.rally` gates in
`annotation-surface.tsx` with a host capability that is true everywhere.

## Trust model

What the page's own scripts can now do that they could not: see a Rally script
in their head, see Comment mode messages from the parent, post a message the
app will read while Comment mode is on, and read the comment cards drawn in
their DOM.

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

### Decision log

**2026-10-29: website picking may share the page's origin in the browser.**
Reverses the 2026-10-19 decision that accepted native-only website support over
serving-Worker injection. The requester judged the forgery boundary not a real
threat for pages the workspace's own agent writes, and asked for a startup-scale
design rather than one hardened against the page's author. Considered and
rejected on the way here, all for cost against a threat that is not real:

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

- `packages/contracts/src/artifact-picker.ts`: `artifactLiveFrameScript(appOrigin)`,
  built from the same pieces as `artifactFrameScript()`, plus the message
  schemas for `rally-annotation-picking` and `rally-annotation-ready`.
- `apps/api/src/artifacts/serving-policy.ts`: `shouldInjectPicker(request,
response, appOrigin)` and the head-first injection (string and
  `HTMLRewriter`); `index.ts` serves `/__rally/picker.js` before the hostname
  lookup and applies the injection in the outer `fetch`.
- `apps/desktop/src/renderer/components/site-resource-detail.tsx`: the
  `framed` branch described above; the disabled reason goes.
- `apps/desktop/artifact-picker-plugin.ts` moves to a shared location;
  `apps/browser/vite.config.ts` uses it; `apps/browser/src/worker.tsx` serves
  the file; `annotation-surface.tsx` drops the `window.rally` gates.
- `live-web-artifacts.md`, `artifact-annotations.md`, `security.md`,
  `browser-client.md` updated in the same change, with changelog entries where
  the mechanism changed. `security.md`'s "Website selection is native-only"
  paragraph is rewritten to the trust model above.

No new defensive limit. Readiness is a message, not a wait.

## Testing

- **API Node:** injection on a framed 2xx HTML response and on nothing else
  (top level, anonymous read, JSON, 401, the neutral page); the script is the
  first child of `<head>`; `/__rally/picker.js` resolves without a hostname
  lookup and carries a cacheable content type.
- **`test-workers/`:** real `HTMLRewriter` on a streamed stateless active
  response, with a production break (skip the `head` handler) to prove the test
  fails.
- **Renderer:** the framed branch accepts a pin from the frame's window and
  origin while picking and ignores one from another source, another origin,
  with Comment mode off, or with a `screenshot`; a comment action for an
  unknown pin is ignored.
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
- A public visitor and a desktop viewer of the same site receive responses
  with no `/__rally/picker.js` reference.

## Open questions

1. Should the desktop's live view move from the isolated world to this same
   injected transport, so there are two transports instead of three? It would
   need the Worker to inject on the desktop's top-level viewer-session loads
   too. Nothing forces it; the isolated world works and costs nothing.
