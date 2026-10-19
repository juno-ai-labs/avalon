# Annotating artifacts and attachments

> Created 2026-10-19.
>
> A person points at part of an artifact or attachment, writes a comment on
> it, and sends it to Rally as part of an ordinary message. Companion:
> [state](state.md), [mockups](design.html). Related:
> [agent attachments](../../agent-attachments.md),
> [markdown rendering](../../markdown-rendering.md),
> [live web artifacts](../../live-web-artifacts.md),
> [conversation surfaces](../../conversation-surfaces.md),
> [security](../../security.md),
> [inline resource citations](../2026-08-27_inline-resource-citations/prd.md).

## Summary

A person can click part of any artifact or attachment (a word, a range, a
paragraph, a list item, a whole section, a spreadsheet range, an element of a
website, a region of an image) and write a short comment on it. The comment box
floats beside the thing it points at. They can drop several before sending. On
send, the pins become **annotations** on one user message, next to its text.

Each annotation carries the content it points at: the selected text, a little
of what comes before and after, and where it sits. A mid-size model (the
medium fallback model, not only a frontier one) can act on "make this shorter"
or "this number is wrong" without fetching anything or guessing what "the
second bullet" meant.

Annotations are not a new kind of record. They exist only inside the message
that carries them. An unsent pin is lost if the app closes.

## Motivation

Today the only way to ask for a change to part of an artifact is to describe
where it is in words: "in the pricing section, the second bullet, the bit
about yearly billing". That is slow to write, and it leaves the model to work
out which spot was meant. That is hardest in a long document, or in a website
where the visible text does not match the source. When it guesses wrong, the
person has to correct it, which costs another run.

This PRD answers a direct product request made on 2026-10-19. No measurement
exists of how often the model picks the wrong spot today. Rally has no metrics
stack to produce one (see "Where we are" in the agent rule sheet), so the case
rests on the request and on what the product cannot do today, set out below.

Nothing in Rally lets a person point today. A person can rename an artifact but
not edit, select, quote or comment on it. The agent edits artifacts in its
sandbox with `edit_file`, which needs an exact `oldString`; a person describing
a location in words gives it nothing exact to use.

## Goals

1. A person can point at part of every artifact and attachment kind in scope
   (see Product behavior) on desktop and in the browser client.
2. Pointing works at several sizes: a word, a dragged range, a block, and the
   section or container around a block.
3. A person can attach a comment to each point and send several in one
   message.
4. Every annotation the model receives includes the content it points at, so
   the model never needs a lookup to understand it.
5. For Markdown and plain text, the quoted content is the exact source string,
   so the agent can pass it to `edit_file` as `oldString` unchanged. HTML is
   not in this goal: its quote is the rendered element (see Key design
   decision 7).
6. An annotation in the feed opens the artifact at the version it was made on
   and scrolls to the spot it points at, where that version can still show it.
   Where it cannot, the feed shows the saved quote instead (see In the feed).

## Non-goals

1. **Stored comment threads on artifacts.** Rejected for now. A comment is
   something a person says to Rally, so it is a user message. There is no
   comment table, no resolve state, and nothing to restore on reopen beyond the
   message itself.
2. **Saving unsent pins.** Deferred. Pins in progress are local UI state. Closing
   the app drops them. [`composer-drafts.md`](../../composer-drafts.md) could
   cover them later.
3. **Audio.** Deferred. Rally does not transcribe audio, and the model cannot
   hear it, so a time-range annotation gives the model nothing to act on. Audio
   returns when audio has a text derivative.
4. **Rendered page views for PDF and PowerPoint.** Deferred. Phase one points
   at the converted text that the preview already shows. Boxes on a rendered
   page or a slide image need a page renderer, which is a separate change.
5. **People editing content directly.** Deferred. An annotation asks Rally to
   change something; it does not change it. A fast path where a small model
   applies a one-word fix without a full run is a natural follow-up.
6. **Annotations that only notify a teammate.** Deferred. Sending an annotated
   message behaves like sending any message, including whether it wakes Rally.
7. **iOS.** Deferred, per the platform default for new features.

## Product behavior

### Entering pick mode

Every surface that shows an artifact or attachment body has a pick control:

- the contextual right rail's resource preview
- the attachment lightbox
- the attachment panel
- the artifact pop-out window
- live site views, on desktop and in the browser client

With pick mode on, the pointer outlines the element under it. The outline
follows the pointer the way a browser's element inspector does.

- **Hover** outlines the nearest block.
- **Alt (Option) while hovering** grows the outline to the parent: list item,
  then list, then the section. **↑ and ↓** move up and down the same chain. A
  Markdown section runs from a heading to the next heading of the same or
  higher level. Scrolling always scrolls; pick mode is for long documents and
  sites, where a person scrolls to reach the next thing to pin.
- **Click** pins the outlined block at once.
- **Double-click** pins one word. The first click of a double-click has already
  pinned the block, so the double-click replaces that block pin with the word
  pin. Clicks never wait out the double-click interval, which would slow every
  block pin.
- **Click and drag** pins any range of text.
- **Escape** leaves pick mode. Pins already made stay.

### Writing a comment

Pinning opens a small comment box anchored beside the pin. The box has a text
field and a remove button. Enter commits the comment and keeps pick mode on so
the person can pin the next thing. Pins stay highlighted while the composer is
open.

The composer shows a row of chips above the text field, one per pin, each with
a short excerpt. Clicking a chip scrolls to its pin. Removing a chip removes the
pin. A pin's comment may be left empty, for pins the message text speaks to
together ("tighten all of these"). Sending is allowed with no message text when
at least one pin has a comment.

### What each kind supports

| Kind                 | What a person can pin                             | Where it points                      | Content sent                                                           |
| -------------------- | ------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| Markdown             | word, range, block, section                       | source offsets and heading path      | source Markdown                                                        |
| Text                 | word, range, paragraph                            | offsets and line numbers             | source text                                                            |
| PDF                  | word, range, block in the converted text          | page and offsets                     | selected text                                                          |
| Word                 | word, range, block, section in the converted text | heading path and offsets             | selected text                                                          |
| Excel / CSV          | cell, range, row, column, sheet                   | `Sheet!A1:C4`                        | the range as a Markdown table, with its header row                     |
| PowerPoint           | slide, or text on a slide, in the converted text  | slide number and offsets             | selected text and the slide title                                      |
| Image                | a dragged box, or the whole image                 | box as fractions of width and height | a crop of the box as an image, plus the whole image                    |
| HTML file            | element, word, range                              | CSS path and box                     | trimmed `outerHTML` and its visible text                               |
| Live site            | element, word, range                              | page path, CSS path and box          | trimmed `outerHTML`, visible text, and on desktop a cropped screenshot |
| Other (zip, unknown) | the whole file                                    | none                                 | name, type and size                                                    |

Generated artifacts and attachments behave the same. Both are `resources` rows,
and an annotation names a resource and the version the person saw.

### In the feed

An annotated message shows its text, then each annotation as a quoted excerpt
with the comment under it and the artifact's name. Clicking the excerpt opens
the artifact at the annotated version and scrolls to the spot. If that version
is no longer the latest, the preview shows the existing older-version notice.

The spot cannot always be shown again. An older version of a live site serves
frozen assets and never runs the old site's code, and a page's script may read
current data ([live web artifacts](../../live-web-artifacts.md)). So the pinned
element can be missing or show different content. When the locator does not
resolve, or resolves to an element whose text no longer matches the saved
quote, the viewer highlights nothing. It shows the saved quote, and the saved
screenshot when there is one, with a line saying the original page cannot be
shown again. It never highlights a different element.

### States

- **Loading:** pick mode is unavailable until the body has rendered.
- **Converted text not ready** (a PDF or Office file still converting): pick
  mode is unavailable, with the existing "preparing preview" state.
- **Site not loaded or failed:** pick mode is unavailable on that view.
- **Offline:** pinning works; sending follows the composer's normal offline
  behavior.

## Impact on the product contract

None. This refines how a person writes a message within the existing contract.
It adds no approval step: an annotation is a request, and Rally acts on it the
same way it acts on any message.

## Decision log

None yet.

## Key design decisions

1. **An annotation is part of a user message.** The person is talking to Rally,
   so the record is what they said. Rejected: a stored comment thread on the
   artifact. It needs storage, resolve rules and sync for something that is
   only ever an instruction.
2. **Every annotation carries its content.** The model never needs a lookup to
   learn what was pointed at. Rejected: sending only a locator and expecting
   the model to call `read_resource`. That costs a tool call per pin and invites
   the model to read the wrong range.
3. **One shape for every kind.** An annotation is
   `{ target, content, comment }` whatever the kind. Only the locator inside
   `target` differs. This follows the W3C Web Annotation selector model
   (a text quote with context, plus a kind-specific position).
4. **Quote with context, not only offsets.** The `before` and `after` windows
   let the agent find the spot again after the file has changed, and tell
   repeated text apart. Offsets alone break on the first edit.
5. **PDF and Office point at their converted text.** That is what the preview
   already shows and what `read_resource` returns, so the model sees the same
   words the person pointed at.
6. **Annotations are not citations.** A citation is the model pointing a reader
   at a resource. An annotation is a person pointing the model at part of one.
7. **HTML quotes are the rendered element, not source.** `outerHTML` is the
   browser's re-serialization of the parsed DOM. It changes attribute quoting,
   entities and implied tags. The static preview also wraps the file in a new
   document, and trimming removes bytes on purpose. So an HTML quote is labelled
   rendered, and the model finds the element in the source before editing.
   Rejected for phase one: mapping each element back to a source span with a
   position-aware parser. It costs more, and labelling the quote is easy to
   reverse later.
8. **One HTML picker, two transports.** A single Rally picker script does the
   outline, grow and pin work on every HTML surface: the static HTML preview
   and live sites, on desktop and in the browser. Only the way it reports a pin
   differs (see Security and trust model). Rejected: the parent page walking a
   same-origin static preview's DOM, plus a separate preload and a separate
   site script. That is three mechanisms to build and three to security-review.

## Data model

No new table. `CreateMessageRequestSchema` gains an optional `annotations`
array, and a participant turn stores it with the turn's other parts.

```ts
Annotation = {
  target: {
    resourceId: string,
    version: number,
    locator: Locator,
  },
  content: {
    exact: string,      // source text, cell table, or trimmed HTML
    source: "exact" | "converted" | "rendered",
    before: string,
    after: string,
    truncated: boolean,
    imageAttachmentId?: string, // draft upload of a crop or site screenshot
  },
  comment: string,      // may be empty
}

Locator =               // discriminated by type, not by the resource's kind
  | { type: "markdown", start, end, headingPath }
  | { type: "text", start, end, lines }
  | { type: "pdf-text", page, start, end }
  | { type: "document-text", headingPath, start, end }
  | { type: "cells", sheet, range }          // "B3:D5"
  | { type: "slide-text", slide, start, end }
  | { type: "region", x, y, w, h }           // fractions of the image
  | { type: "element", pagePath?, css, box } // HTML file or live site
  | { type: "file" }
```

- **The locator names its own type.** `AttachmentKind` cannot tell an HTML file
  from plain text: `.html` is classed as `text`. So the validator checks the
  locator's `type` against what the resource's MIME type allows (an HTML file
  allows `element` and `text`), and the projection picks its guidance from the
  same `type`.

- **No client-supplied kind or size.** The server derives the kind from the
  resource row it already loads for the access check, so a request cannot
  disagree with it. Nothing reads a pin's size (word, block, section): the
  location and the quote already tell the model. Either field can be added
  later; taking one out of a stored message shape cannot.
- **Messages with only annotations.** `CreateMessageRequestSchema` today
  refuses a message with neither text nor an attachment. Its refine widens to
  accept a message whose only content is annotations, as long as at least one
  has a comment.
- **Crops and screenshots are draft attachments.** The client uploads each one
  as a draft, the same way a composer attachment is uploaded. It puts the
  draft's id in both `content.imageAttachmentId` and the message's
  `attachmentIds`. So it goes through the existing `reserveAttachmentDrafts`
  admission, which accepts only the sender's own unsent drafts, and it counts
  toward the existing cap of 10 attachments per message. The server refuses an
  `imageAttachmentId` that is not also in `attachmentIds`.

One builder and validator for annotations lives in `@rally/contracts`, so the
client and the server trim and check annotations the same way.

## Security and trust model

- **Content is the person's own view.** An annotation quotes a resource the
  sender can already read. This is a new read check, not the attachment path.
  Attachment admission (`reserveAttachmentDrafts`) accepts only the sender's
  own unsent drafts, and would refuse every annotation on an existing artifact
  or sent attachment. Before it accepts the message, the server checks:
  - `resourceId` is visible to the sender under the existing resource access
    rules ([authorization](../../authorization.md)) for the thread or
    workspace the message is posted in
  - `version` exists in that resource's version history
  - nothing is reserved

  Crops and screenshots go through attachment admission instead (see Data
  model).

- **Quoted content is untrusted.** It is projected to the model as quoted data
  inside the user turn, never as instructions.
- **One picker script, two transports** (Key design decision 8). Every HTML
  surface runs the same Rally picker script. Each surface differs only in how
  the script gets into the page and how it reports a pin.
- **Hard constraint: no preview ever combines `allow-scripts` with
  `allow-same-origin`.** A `srcdoc` frame with `allow-same-origin` takes the
  embedding app's own origin. Adding scripts to that runs untrusted HTML as the
  app, which is the standard sandbox escape.
- **Static HTML preview.** Today the preview iframe is `sandbox=""` with a CSP
  of `default-src 'none'`. In pick mode it becomes `sandbox="allow-scripts"`
  (still an opaque origin) and its CSP gains `script-src 'nonce-<random>'`. The
  picker is inlined with that nonce, a new one per render. The file's own
  scripts carry no valid nonce, so they still never run. The picker reports
  over `postMessage`. The app accepts a message only while pick mode is on and
  only when `event.source` is that iframe's window. No other script runs in the
  frame, so no other script can forge a pin. The pop-out window's script-free
  `data:` page cannot host the picker, so pick mode there needs a real renderer
  page.
- **Live sites on desktop.** On entering pick mode, the main process runs the
  picker in an isolated world of the artifact `WebContentsView`
  (`executeJavaScriptInIsolatedWorld`). It needs no preload and no reload. Each
  call resolves with one pin. The site's own scripts cannot reach that world,
  so they cannot forge a pin.
- **Live sites in the browser.** The site's iframe is that artifact's origin,
  and the app has no way to add a script to it from outside. Entering pick mode
  reloads the iframe with a pick flag. For that load only, the serving Worker
  injects `<script src="/__rally/picker.js">` into HTML responses with
  `HTMLRewriter`. That covers static, active and stateful sites. Public
  visitors and normal loads never get the script. The reload loses the page's
  in-memory state, and navigating away ends pick mode.

  The picker shares the origin with the site's own scripts, so the site can
  post a fake pin. Three defenses apply:
  - The app drops messages unless pick mode is on for that view and
    `event.source` is that iframe.
  - Every field runs through the shared `@rally/contracts` validator as
    untrusted input.
  - A forged pin can only carry text the site could already show, and the
    person sees each pin's chip before sending.

  The security review decides whether that remaining risk is acceptable.

- **Reviews.** The static preview's picker and the live-site paths are new
  trust boundaries, and each needs a security review. The injection is a change
  to the serving Worker. [`live-web-artifacts.md`](../../live-web-artifacts.md)
  and [`security.md`](../../security.md) are updated with the result.

## Agent behavior

No new tool. Annotations reach the model inside the user turn, after the
message text:

```
<annotation artifact="Pricing page" resource="r_123" version="4"
            kind="markdown" location="## Pricing › item 2">
<before>…Starter plan is </before>
<selected>$12 per seat, billed yearly</selected>
<after>. Teams over 50…</after>
<comment>Make this monthly and add the yearly discount</comment>
</annotation>
```

- For Markdown and text (`source="exact"`), the projection says `<selected>` is
  the exact source text, which the model can use as `edit_file`'s `oldString`
  after `import_resource`.
- For HTML files and live sites (`source="rendered"`), it says `<selected>` is
  the rendered element, not source. The model finds that element in the source
  before editing, using the CSS path, the visible text and the screenshot.
- For PDF, Word, Excel, CSV and PowerPoint (`source="converted"`), it says the
  text is converted. A spreadsheet range arrives as a Markdown table, which is
  never the file's own bytes, even for a CSV. The model must rebuild the file
  rather than string-replace it.
- When `truncated` is true, it says the selection was cut, and that the model
  should run `read_resource` before editing.
- Image crops and site screenshots ride as image parts beside the annotation.
- An annotation with an empty comment is projected without `<comment>`; the
  message text speaks to it.

Acceptance includes prompt evaluations on the medium fallback model, covering:

- one annotation
- several annotations in one message
- a truncated selection
- an annotation on an older version
- a converted-text kind
- a rendered HTML element whose quote is not in the source byte for byte

## Rollout

Ships to everybody on merge, with no flag, on desktop and the browser client.
Turning it off is a revert. Two parts each wait for their security review to
pass: picking in the static HTML preview (the nonce-gated picker) and live-site
picking (the isolated world on desktop, the injected script in the browser). The other kinds do not wait for either
review.

## Acceptance

- Pin a word, a range, a list item and a whole section in a Markdown artifact.
  Comment on each and send. The model's turn shows each with the exact source
  text, and Rally edits all four correctly.
- Pin a range in a spreadsheet attachment. The model receives it as a table
  with headers.
- Pin a box on an uploaded image. The model receives the crop.
- Pin a button on a live site, on desktop and in the browser. The model
  receives its HTML and, on desktop, a screenshot.
- Click an annotation in the feed after the artifact has a newer version. The
  older version opens at the pinned spot.
- Click an annotation on a live site whose older version no longer shows the
  pinned element. The saved quote and screenshot show, and nothing is
  highlighted.

## Open questions

1. **Size guards.** Per [the limits rule](../../adding-security-defensive-and-other-limits.md),
   two guards are defined, wired at the open value, and left for the team to
   set. Neither blocks the build. Both live in the shared annotation builder
   in `@rally/contracts`, so the client and the server apply the same numbers.
   - **Most characters of `content.exact` in one annotation.** This one
     truncates rather than rejects: it cuts the middle, keeps the head and
     tail, and sets `truncated`. For scale, a long Markdown section runs about
     2,000 to 4,000 characters, and a trimmed HTML card about 1,000 to 5,000.
   - **Most characters of the whole `annotations` payload in one message,** as
     serialized. It covers every field: comments, `before` and `after`,
     locators, image references and the number of annotations. This one
     rejects. The composer blocks Send and says the pins are too large to send
     together. The server refuses a message over it with the code
     `annotations_too_large`.

   Images need no new guard. Crops and screenshots are draft attachments, so the
   existing cap of 10 attachments per message and the existing upload limits
   already bound them.

2. **Context window size.** How many characters go in `before` and `after`.
   This is a product choice, not a guard; about 200 each is the proposal.
3. **HTML trimming.** What to strip from `outerHTML` before measuring. The
   proposal is inline `<script>` and `<style>` bodies, `data:` URLs, SVG path
   data, and runs of whitespace. Tighter trimming keeps more of an element
   under the cap.
