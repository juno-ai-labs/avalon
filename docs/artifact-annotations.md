# Artifact annotations

Annotations let a person point at part of a resource and send that selection,
its surrounding context and a comment as an ordinary user message. The saved
version and quote travel with the message. Confirmed unsent pins live in the device-local composer draft cache; there is no
server annotation table or artifact comment thread. Unconfirmed selections are not cached.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/artifact-annotations.ts` | Shared locators, builder, admission rules and model projection. |
| `packages/contracts/src/artifact-picker.ts` | HTML inspector, restoration and the Tabler pointer-collaboration cursor, shared by all HTML transports. |
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

Image panels initially fit the image's width without enlarging small images;
tall images scroll vertically. Zoom in/out, the percentage button (100%), and
Fit sit outside the image's scroll viewport. Overflow scrolls on both axes.
Double-clicking or double-tapping an image toggles between 100% and Fit; zooming
in keeps the tapped image point under the pointer. Comment mode keeps these
gestures for selecting image regions instead. Touch scrolling and pinch zoom
remain native; double-tap zoom applies to the image rather than the page.
The focusable viewport supports native arrow-key scrolling; gallery arrow-key
navigation applies outside that viewport.
Lightboxes initially fit the whole image, and their full-size toggle selects
100%. Image regions use the image's layout dimensions at every zoom, so crops
and highlights retain their normalized coordinates. These controls are shared
by desktop and browser previews, including images without annotation metadata.

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

The canonical turn's existing `structuredContent` contains
`{kind: 'artifact_annotations', annotations, names}`. Image annotations also
retain server-built immutable image descriptors, version identity and model-image metadata for replay; clients cannot
supply those R2 references through message admission. Feed rendering, replay and
overheard turns use that same content. Opening a feed excerpt loads its saved
version. Source ranges and cell tables must match the saved quote before they
are highlighted. HTML restoration verifies the trimmed element and visible
text. An unresolved spot shows the saved quote and available screenshot.

### HTML trust boundaries

Static HTML stays in an opaque iframe. Comment mode adds only `allow-scripts`,
never `allow-same-origin`. A fresh nonce authorizes a bundled app-origin picker script. Using an external
script satisfies the app CSP inherited by `srcdoc`; an inline nonce alone does
not. The file's own scripts remain blocked. Parent messages are accepted only from that
frame while picking, through the shared pin schema.

Desktop live views install the same picker in an isolated JavaScript world.
Confirmed comment cards render in that world, with closed shadow roots and
text-only content. The owner-window IPC synchronizes typed pins and returns only
trusted edit/remove clicks; it fences results against the current native view.
Opaque HTML previews use the same card renderer with source-checked messages.
The main process captures the selected viewport rectangle; page scripts cannot
supply screenshot bytes. The controller fences results against the current
view. The site cannot access the picker world's callback or queue even if it creates
identically named globals in its own world. Browser website previews keep the Comment icon visible and disabled, with the
explanation “Website comments require the Rally Mac app.” on hover or keyboard focus. Other annotation kinds share the desktop/web renderer.

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
outside the image viewport while leaving viewport keys available for scrolling.
Image scroll bounds, Fit, double-click/tap focal zoom, gallery resets and region
alignment are verified in real Electron and browser windows; jsdom has no layout.
API Node tests cover live and overheard projections;
`test-workers/artifact-annotations.test.ts` covers canonical resource/version
reads and durable turn storage. The workerd target/version and canonical-storage tests have production mutation
proofs. No serving-Worker injection is shipped.

Run scoped files with the package's Vitest command, and run repository lint and
typecheck. Visual checks use the real Electron app with local Workers and
ordinary uploaded fixtures. Prompt evaluations live under
`packages/agent-harness/evals/artifact-annotations/`; they test editing decisions
on the configured medium fallback model, separately from end-to-end tool edits.

## Changelog

### 2026-10-21 — Image previews own a scroll viewport

**What changed:** Annotated and ordinary images share a two-axis scroll viewport
and zoom controls, including double-click/tap to toggle 100% and Fit. Region
overlays scale with the image's actual layout box.

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
