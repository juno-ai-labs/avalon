# Artifact annotations

Annotations let a person point at part of a resource and send that selection,
its surrounding context and a comment as an ordinary user message. The saved
version and quote travel with the message. Confirmed unsent pins live in the device-local composer draft cache; there is no
server annotation table or artifact comment thread. Unconfirmed selections are not cached.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/artifact-annotations.ts` | Shared locators, builder, admission rules and model projection. |
| `packages/contracts/src/artifact-annotation-script.ts` | The one annotation script: the inspector, the comment cards, restoration and the Tabler pointer-collaboration cursor, behind the in-page `rallyAnnotations` API and its `postMessage` bridge. A leaf module, because the Vite plugins import it. |
| `packages/contracts/src/artifact-picker.ts` | The message schemas a host and a framed document exchange over that bridge. |
| `apps/api/src/artifacts/annotation-script.ts` | Who gets the script (a viewer session, or the browser client's frame), the served file, and its head-first injection into static and streamed HTML. |
| `apps/desktop/artifact-picker-plugin.ts` | Emits the same script as `/annotation-frame.js` on the desktop and browser app origins, for the opaque HTML-file frame. |
| `apps/desktop/src/main/artifact-viewers.ts` | `artifactPageAnnotations`: the desktop's calls into the page API through `executeJavaScript`, and the preview controller's readiness. |
| `apps/desktop/src/renderer/components/annotation-surface.tsx` | Text, converted document, image and opaque HTML selection. |
| `apps/desktop/src/renderer/components/image-viewport.tsx` | Two-axis image scrolling, sizing and zoom shared by annotated and ordinary previews. |
| `apps/desktop/src/renderer/lib/annotation-source.ts` | Parser source positions and reversible rendered/source range mapping. |
| `apps/desktop/src/renderer/components/annotation-sheet.tsx` | Cell, range, row, column and sheet selection. |
| `apps/desktop/src/renderer/components/artifact-annotations.tsx` | Transient composer pins, chips and feed excerpts. |
| `apps/desktop/src/renderer/components/site-resource-detail.tsx` | Live-site selection and desktop screenshot uploads. |
| `apps/desktop/src/renderer/screens/artifact-window.tsx` | Renderer-based pop-outs and acknowledged pin transfer to the originating composer. |
| `apps/api/src/services/annotation-model-sources.ts` | Server-built immutable original-image descriptors for replay. |
| `apps/api/src/services/resource-service.ts` | Canonical target read/version checks and frozen historical site HTML. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Message admission and canonical structured content. |

## How it works

Comment mode appears in the panel header immediately before Expand. These two
controls stay visible when other header actions fold. Hover outlines the block
that clicking will pin. Option or Up grows to a containing list or section;
Down shrinks. Click is immediate, double-click replaces its block pin with a
word, and dragging selects a range. Escape exits the mode while preserving
confirmed pins and discarding the unfinished selection.
The button and cursor use Tabler's `pointer-collaboration` icon. While enabled,
the button has the update action's blue fill and light icon. Standalone controls
use dark label text for contrast on that fill.

A selection opens a floating comment field with a top-right × to remove it.
The field shows only the authored comment; selected words appear in the composer
chip after confirmation. Enter or Send keeps a nonempty comment and adds the pin
to the composer. Confirmed comments stay visible beside their selected elements,
including after leaving Comment mode or starting another pin. They follow scroll
and resize; clicking a comment reopens its editor, and × removes it. Empty and
whitespace-only comments stay in the editor, and typing alone never adds a pin
to the message. Dismissing an unfinished comment or starting another selection
discards that pending pin. Accepting a message also clears unfinished selections,
so no abandoned highlight remains without a removal control. Website chips and saved excerpts
show selected visible words (or “Selected area”); trimmed HTML remains model
context. Composer chips reveal, edit or remove pins. Sending accepts an empty
message when a pin has a comment. Draft images use the ordinary upload path,
and their IDs accompany both the annotation and `attachmentIds`. The send
captures confirmed pins and clears those IDs only after acceptance.

Markdown uses parser offsets so emphasis, list markers and entities are quoted
from original bytes. Plain text uses paragraph spans. PDF and Office use their
existing converted text. Sheets serialize the selected range as a Markdown
table with headers. Image regions upload PNG crops; the original image remains
a separate model source. The shared model projection escapes resource data,
labels exact/converted/rendered content, and requires a fresh read for truncated
selections and reconciliation before editing an older version.

Image panels, lightboxes and annotated previews share `ImageViewport`. Its
scroll bounds and region overlays use the image's layout dimensions rather than
transforms; auto margins keep oversized content reachable from the scroll origin.
Controls stay outside the scroller. Lightbox controls share one zoom state, and
image comments observe the image box so zoom updates their anchors even without
scrolling. Horizontal arrows navigate the gallery when the image fits and scroll
when it overflows; blank image-stage clicks retain lightbox backdrop dismissal.
The viewport reserves a stable scrollbar gutter so width fitting cannot oscillate
with scrollbar visibility. Detached image hosts bound the viewport with flex
layout, while unavailable saved-image quotes retain the host's ordinary scroller.
Comment mode reserves image gestures for selection.

Target checks reuse ordinary resource-sharing rules, including personal-connection
ownership, and run once per distinct resource/version before participant changes.
Targets load concurrently. Stored turns use a read schema without admission-time
truncation or size policy. Authored comments count toward activation and naming;
quoted resource data never becomes addressing input. The existing message length
bound applies to each newly composed comment.

Preview bytes open immediately. Entering Comment mode resolves and reloads a
version-bound preview through the canonical MIME policy (including native image
normalization and original CSV bytes), so cached thumbnails cannot be relabeled with a
new revision. Sheets keep sparse coordinates and render the visible viewport;
committed highlights derive from all remaining pins on the active sheet.
Composer chips provide a comment editor even after their original preview closes.
Annotation-bearing sends exclude another submission until the receipt returns;
an open elicitation must be answered before artifact comments are sent.

A pin made in a frame carries the window the person saw it in: the element
locator's optional `viewport` (CSS-pixel width and height, the page's scroll
offsets, the device pixel ratio and the color scheme), which the picker reads
when it reports the pin. A rendered annotation with no screenshot (every
browser-client website pin, since a browser cannot capture its frame) projects
that window into the model's guidance, and the `building-live-sites` skill's
"Recreating a person's view" step holds the Playwright recipe that rebuilds it
in the Terminal sandbox from the imported site, so the agent sees what the
person saw rather than the page at a width they never used. A desktop pin
still carries its own crop and gets no such instruction.

The canonical turn's existing `structuredContent` contains
`{kind: 'artifact_annotations', annotations, names}`. Image annotations also
retain server-built immutable image descriptors, version identity and model-image metadata for replay; clients cannot
supply those R2 references through message admission. Feed rendering, replay and
overheard turns use that same content. Opening a feed excerpt loads its saved
version. Source ranges and cell tables must match the saved quote before they
are highlighted. HTML restoration verifies the trimmed element and visible
text. An unresolved spot shows the saved quote and available screenshot.

### One script, one in-page API

Every HTML surface runs the same script, which installs
`globalThis.rallyAnnotations`: `pick()` starts the inspector and resolves with
the next pin (or `null` on Escape, with early pins queued), `stopPicking()`
removes it, `comments(pins, selected)` draws the confirmed cards, keeps
`selected` highlighted, and resolves with an edit or remove click,
`restore(locator, exact)` highlights a saved selection, and `rect(css)` answers
an element's viewport rectangle. `comments` and `restore` look their elements up
once the document has parsed: the script runs from the head and announces
itself at once, so a host may answer while the page is still streaming in, and
a card asked for then must still appear. A host that keeps a restored
selection names it as `selected` on every comment sync, since a sync with
`null` clears it. The script does nothing until a host calls it. What differs
per surface is how the script gets into the document and how the host reaches
it:

| Surface | How the script gets in | How the host calls it |
| --- | --- | --- |
| Live site, desktop rail and pop-out | The serving Worker prepends it to every HTML response for a request carrying a valid viewer session | `executeJavaScript` from the main process, parsed on return |
| Live site, browser client | The same injection, also for any framed request when `BROWSER_APP_ORIGIN` is configured, since Safari views the frame without the partitioned cookie | `postMessage` to the frame at the artifact origin; replies accepted only from that frame's window at that origin |
| HTML file, rail or lightbox, and a saved site spot | `/annotation-frame.js` from the app origin, under a fresh nonce, in an opaque `srcdoc` frame | `postMessage` to the frame; replies accepted only from that frame's window |

The bridge is the same three host messages (`rally-annotation-picking`,
`rally-annotation-comments`, `rally-annotation-restore`) and five replies
(`rally-annotation-ready`, `rally-artifact-pin`,
`rally-annotation-comment-action`, `rally-annotation-restored`,
`rally-annotation-anchor`), all parsed with the shared schemas. A framed document announces itself with the ready message
while it parses, so the host learns a new page after an in-site link and tells
it what it is doing; the Comment control is enabled only once a page has said
so, and a page without the script (the neutral page, a protected site's
refusal, an error page) keeps it disabled with "This page cannot take comments
here." The script accepts messages only from `window.parent`, and on an
artifact origin only when that parent is the configured app origin.

### What the script draws, and how it keeps up

The inspector outlines the nearest block under the pointer and never the
document or its body: a pointer over empty page shows nothing, and a click
there pins nothing. Once a block is pinned it stays highlighted as the
selection until its comment is confirmed or discarded; the host says which
selection is open through `comments(pins, selected)`, so the highlight survives
a frame reload and clears when the editor closes. Confirmed cards use the app's
own card look, sit to the right of their element with a connector when there is
room and below it when there is not, and hide while the element is out of the
viewport or scrolled out of an ancestor that clips it. Each card keeps an
outline around the element it is about, so the comment's scope stays visible
without hovering; hovering the card strengthens that outline. Cards are laid
out together each frame, in document order, and a card slides down past any
card or commented element already in its way, so no card covers another
comment's card or element.

Everything drawn is kept in place by one frame-synced tracker inside the
script: it runs only while something is on screen, reads each tracked
element's rectangle once per frame, and moves what changed. That is what makes
an outline, a selection or a card follow a scroll in any container, a resize,
a transition or a layout shift without a listener for each, and it is why the
hover outline re-resolves what is under a still pointer after the page scrolls
beneath it. A framed host gets the selection's rectangle as
`rally-annotation-anchor` whenever it moves, and `placeAnnotationEditor` in
`lib/annotation-anchor.ts` puts the comment editor beside the element, below it
when the window has no room to the right, and parked at the frame's edge when
the element has scrolled out of the frame. The desktop's editor opens over a
still of the page, so nothing scrolls under it there.

### HTML trust boundaries

A live artifact's page is written by the workspace's own agent through
`publish_resource`; nobody edits it by hand and guests cannot publish. So the
script shares the page's origin on every host, and the page's own scripts can
see it, replace it, and post the same messages. That is accepted on purpose: a
pin a page could forge quotes only what the page already shows, the person
sees the chip before typing a comment, and the model already treats quoted
content as untrusted. The desktop used an isolated world for this until
2026-10-29 only because Electron made one free; it was not a boundary anything
depended on. What is kept is cheap and structural: a host accepts a reply only
from its own frame or view, at the expected origin, only in a shape the schema
admits, only while Comment mode is on for a pin, and only for a pin it holds
for a card action. A pin's `screenshot` never comes from the page: the desktop
sets it from its own `capturePage`, and the framed schema omits the field.

An **uploaded** HTML file is not agent-authored, so it stays in an opaque
`srcdoc` frame where its own scripts never run: Comment mode adds only
`allow-scripts`, never `allow-same-origin`, and the fresh nonce admits only the
app-origin script. Using an external script satisfies the app CSP inherited by
`srcdoc`; an inline nonce alone does not. All annotation kinds share the
desktop/web renderer, and website and HTML-file comments work in the browser
client as on the desktop; only the browser pop-out, a plain tab with no Rally
parent, has no Comment mode.

A pop-out has a real isolated app renderer, with narrow IPC for its own preview,
picker and transfer. It does not receive the main app's general IPC authority.
Transfers require the registered original composer scope and an acknowledgment
from it; closing the destination preserves pins in the pop-out on failure.
Historical sites read frozen manifest assets without running the old worker.

## Draft restoration and new revisions

Confirmed comments restore into their originating conversation, including its
breakout identity. The cache preserves original evidence and a separately resolved
annotation. The provider checks restored selections, visible artifact revision
changes, window focus, and submission against the latest resource revision.

`annotation-resolution.ts` uses exact text and surrounding context, section/page/
slide boundaries for changed text, exact cell tables and headers, or unique HTML
content. Sheet matches must be unique even when the old coordinates still match.
Changed HTML requires a unique stable element ID plus both neighboring
texts (bounded to the shared context budget); positional selectors alone are insufficient. Image regions carry forward
only when image bytes are unchanged. Whole-file comments retain resource identity.
No model or approximate similarity threshold chooses a replacement target.
HTML matching reads frozen static HTML; content created or changed by page scripts
may require manual reattachment in the live site.

Unresolved comments show their saved quote, explanation, Reattach and Retry.
Reattach opens the current artifact and copies the existing comment into a new
selection editor. Confirmation replaces its target; cancelling keeps the original.
Missing or inaccessible artifacts remain in the draft. Rebased HTML discards stale
screenshots rather than presenting an old capture as current evidence.

The composer reports ready and retained comment counts. Only ready annotations
and their image attachment IDs enter optimistic messages and requests. Ordinary
text and valid comments can send while unresolved comments remain behind; an
otherwise empty message with only unresolved comments cannot send. Acceptance
clears only the submitted edit generations, so later edits survive. Concurrent
checks share in-flight work; a superseded submission follows the newer check.
Resource and preview reads are shared across pins within each check. A changed
revision is verified again after its bytes load, including image regions.
Submission gates run against the resolved snapshot, before optimistic rendering.

## Invariants

- Target readability and version existence are checked separately from draft
  attachment admission. Reusing attachment admission would reject every sent
  resource, or accidentally reserve it. Guard: real workerd target tests.
- Crop IDs must also be message attachment IDs; otherwise an arbitrary upload
  could become a model image. Guard: shared schema tests and ordinary upload
  reservations.
- Source offsets must produce the exact saved source slice. Highlighting another
  occurrence would misrepresent what the person asked. Guard: component tests,
  plus real Electron range and hover checks.
- Preview HTML never receives both scripts and app origin. Violating this grants
  an untrusted file app privileges. Guard: opaque-frame construction and real
  Electron hostile-script checks.
- Pins clear only after admission or an acknowledged pop-out transfer. Clearing
  on submit loses comments on a refusal. Guard: send/transfer lifecycle; verified
  visually, no automated guard.

## Boundary

This module owns pointing and user-message content. Resource access remains
owned by [authorization](authorization.md), uploaded bytes and model image
hydration by [agent attachments](agent-attachments.md), ordinary draft
persistence by [composer drafts](composer-drafts.md), and site publication by
[live web artifacts](live-web-artifacts.md). It adds no editing tool, approvals,
artifact comment records or iOS surface.

## Failure modes and limits

Loading, failed previews and audio cannot enter Comment mode. A resource that
changes during preview loading must be reopened before picking. Failed crop
uploads leave an error beside the preview; sending waits for uploads. Offline
send follows the normal composer lifecycle. Missing historical content falls
back to the saved quote rather than highlighting guessed content.

Client schema rejections name the rejected field. A broken stored execution
context remains a server error and preserves that field in its receipt and log.

The existing ten-attachment cap includes crops and screenshots. The shared
per-selection and serialized-payload character guards are intentionally
`Infinity` (`LIMIT UNSET`) pending team-set numbers. The former truncates the
middle and labels the quote; the latter returns `annotations_too_large` with
422. Context uses the PRD's proposed 200 characters on each side.

## Testing

Contracts cover admission, source policy, locators and escaped model guidance.
`annotation-resolution.test.ts` covers moved, changed, ambiguous and missing
selections, HTML identity, sheet headers and image identity.
Renderer tests cover exact Markdown selection, growth, comments, removal and
sheet serialization. Attachment panel tests preserve gallery keyboard navigation
when images fit while leaving overflowing viewport keys available for scrolling.
Lightbox tests cover backdrop dismissal and synchronized zoom controls.
Image scroll bounds, Fit, double-click/tap focal zoom, gallery resets and region
alignment are verified in real Electron and browser windows; jsdom has no layout.
API Node tests cover live and overheard projections;
`test-workers/artifact-annotations.test.ts` covers canonical resource/version
reads and durable turn storage. The workerd target/version and canonical-storage tests have production mutation
proofs. `annotation-script.test.ts` covers who gets the script and its head-first
placement in static HTML; `artifact-serving-hostname.test.ts` covers the served
file and a viewer's, a framed and a public page end to end;
`test-workers/artifact-annotation-script-runtime.test.ts` covers the streamed
`HTMLRewriter` path with a production-break proof. `annotation-script.test.ts`
in the renderer evaluates the script inside a jsdom frame for the API's
lifecycle and the bridge's source check; `artifact-viewers.test.ts` covers the
desktop's calls over a fake `executeJavaScript`; the site-detail tests cover the
framed branch's acceptance rules. Pins and card clicks need trusted events,
which jsdom cannot dispatch, so those are verified in real windows.

Run scoped files with the package's Vitest command, and run repository lint and
typecheck. Visual checks use the real Electron app with local Workers and
ordinary uploaded fixtures. Prompt evaluations live under
`packages/agent-harness/evals/artifact-annotations/`; they test editing decisions
on the configured medium fallback model, separately from end-to-end tool edits.

## Changelog

### 2026-10-29 — One annotation script on every host, injected by the serving Worker

**What changed:** The picker, cards and restore became one script that installs
`rallyAnnotations` in the page. The serving Worker prepends it to every HTML
response for a viewer session or a framed browser-client request; the desktop
calls it through `executeJavaScript` instead of evaluating sources in an
isolated world; the browser client's framed preview and the opaque HTML-file
frame drive it over the same `postMessage` bridge; and the browser host serves
`/annotation-frame.js`, so HTML files and saved site spots work there too.
Website comments in the browser client went from disabled to working. The
inspector stopped offering the document body as a target, the pinned element
stays highlighted while its comment is written, cards took the app's own look
and placement, and one frame-synced tracker keeps the outline, the selection,
the cards and the framed hosts' editor beside their elements through scrolls
in any container, resizes and layout shifts. The editor goes beside, below or
above its element rather than over it, a confirmed card keeps its element
outlined so the comment's scope is visible, and the surface root no longer
draws a focus ring when the editor hands focus back to it. Website pins now
record the viewer's window, and a rendered pin without a screenshot tells the
model to rebuild that window in its sandbox before a visual edit, with the
recipe in the site skill, so browser-client comments lose nothing the model
needs that a desktop crop would have given it.

**Why:** The browser client had no way to put a script into a cross-origin
artifact frame, and the opaque frame's script was built only for the desktop.
The requester judged that isolating the picker from a page the workspace's own
agent wrote defends against the page's author, and asked for a startup-scale
design with one transport for both hosts rather than keeping a second one
that happened to be free.

**Considered and rejected:** A glass overlay in the app taking every input in
Comment mode and driving a query-only page script; freezing the page into a
Browser Run render and picking against a screenshot; a remote canvas display.
Each was cost against a threat that is not real. See
[the PRD](PRDs/2026-10-29_browser-website-comments/prd.md).

**Consequences:** The script shares the page's origin everywhere; acceptance is
source, origin, mode and schema, not isolation. A page without the script
keeps Comment mode disabled, so the serving Worker's injection rule is what
decides where comments are offered. Public, crawler and unfurled responses stay
as published, which the hostname tests pin.

### 2026-10-21 — Image previews own a scroll viewport

**What changed:** Annotated and ordinary images share a two-axis scroll viewport
and zoom controls, including double-click/tap to toggle 100% and Fit. Region
overlays scale with the image's actual layout box, and comment anchors observe
that box. Lightbox controls share one zoom state; fit images retain gallery keys
and backdrop dismissal. Toolbar zoom preserves the viewport centre.
Detached hosts bound the image viewport, saved quotes remain scrollable on load
failure, and a stable scrollbar gutter prevents width-fitting resize loops.

**Why:** Tall images in expanded panels overflowed a centered flex container,
leaving content outside the reachable scroll area. Width constraints also
prevented inspecting wide images at their original resolution.

**Considered and rejected:** Scaling with a CSS transform leaves the original
layout box in place, which makes scroll bounds and annotation overlays diverge.

**Consequences:** Image sizing must change layout dimensions. The scroll origin
must remain reachable when an image exceeds either viewport dimension, and zoom
controls must remain outside that scrolling content.

PR #1373.

### 2026-10-20 — Restore comment drafts and reconcile artifact revisions

Confirmed comments are cached with their original evidence and resolved against
current revisions before sending. Ambiguous targets remain visibly repairable
and never reach the model, while valid feedback can still send. Deterministic
matching and explicit repair replace guessing a new target or silently sending
stale feedback. Submission snapshots preserve newer edits and retained comments;
detached windows share stable draft identities and edit generations through their
existing IPC boundary. Delayed transfers cannot overwrite later edits or recreate
removed comments. Revision checking remains client-side so ambiguous feedback never
reaches the model; shared reads reduce its cost without removing that guarantee.

PR #1360.


### 2026-10-19 — Confirm comments before adding composer pins

Selections remain local to the preview until a nonempty comment is confirmed
with Enter or Send. Typing no longer adds a pin to the outgoing message. Confirmed
comments remain anchored to their elements as the preview scrolls or resizes, so confirming one or selecting another does not hide earlier comments.
The shared preview comment field omits the selected quote and uses a top-right ×;
composer chips retain the quote and comment. This keeps selecting an element
from silently attaching unfinished instructions to a message.

### 2026-10-19 — Send pointed resource content as user-message annotations

**What changed:** Selections and comments travel as versioned content on ordinary
user turns, with transient composer pins, source-aware previews and native HTML
inspection. Shared resource-sharing rules authorize new selections before
participant changes. Image originals retain their version and saved model metadata.

**Why:** People needed to ask for changes to a precise spot without describing
its position or making the model fetch it to understand the request. Review also
caught stale image identity, blocked preview opens and draft lifecycle gaps that
would have lost or duplicated those requests.

**Considered and rejected:** A separate artifact-comment table duplicates message
ownership. Serving-Worker injection adds a navigation and same-origin forgery
boundary; the requester accepted native website selection instead. An inline
nonce did not satisfy inherited app CSP, so static HTML loads a bundled asset.

**Consequences:** New selections must preserve sharing authorization, exact saved
versions and source fidelity. Historical reads do not reapply admission budgets.
Native page input must be trusted, HTML stays opaque, popouts retain narrow IPC,
and draft pins clear only on acceptance or acknowledged transfer. Preview opening
must remain independent of annotation metadata availability.

PR #1322; design: `docs/PRDs/2026-10-19_artifact-annotations/prd.md`.
