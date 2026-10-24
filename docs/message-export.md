# Saving one of Rally's messages

Under every finished turn from Rally, beside **Copy**, are **Image** and **PDF**.
Each renders that turn onto a card — a splash of colour, a rounded white sheet,
the message set as a document, and the Rally mark over *Saved from Rally* — and
offers to save it wherever the person points the dialog. A picture is one tall
JPEG; a PDF is paginated, with that signature repeated in the footer of every
page.

A thread's or a breakout's title menu offers the same PDF for the whole
conversation, under **More → Export conversation to PDF**; see
[A whole conversation](#a-whole-conversation).

The point is a message that leaves Rally intact: pasted into a deck, mailed to
someone without a seat, or kept. Everything here is about making the saved file
look like the turn the person was reading, which is why the markdown is rendered
by the feed's own component and only the surroundings are new.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/common/message-export.ts` | The request and result contract both processes share, the file-type table, and `messageExportFileName` — the one place a message's text becomes a file name. |
| `apps/desktop/src/renderer/lib/message-export.ts` | The renderer's half: serializes a `MarkdownBody` element to HTML in a detached root, reads the Rally mark out of the bundle once, calls the bridge. |
| `apps/desktop/src/renderer/components/conversation-export.tsx` | A whole conversation: which turns it prints, their bylines, and the one `MarkdownBody` per turn that goes into the same request. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `MessageActions` — the hover row under every message (Thread, Breakout and Channel), its in-flight and failed states. |
| `apps/desktop/src/main/message-export.ts` | Everything about the card: the document, its stylesheet, the splash, the page footer, request validation, and `MessageExporter`, which drives one render at a time and writes the file. |
| `apps/desktop/src/main/index.ts` | The Electron adapter — the hidden `BrowserWindow`, the `rallywithai-export` protocol handler, the save dialog, and the `message-export:save` IPC handler. |
| `packages/ui/src/styles/app.css` | Only the hover row's own styling. The card's stylesheet is not here; see the boundary below. |

## How it works

A click on **Image** or **PDF** starts one pass:

1. **The renderer draws the markdown.** `saveMessageExport` renders
   `<MarkdownBody>` into a detached React root and takes its `innerHTML`. This is
   the same component and therefore the same DOM the feed shows —
   [`markdown-rendering.md`](markdown-rendering.md) owns it. The root is detached
   so nothing about the current screen reaches the markup.
2. **It names the file.** `messageExportFileName` takes the first line of the
   message that carries words, strips markdown punctuation, slugifies it, and
   appends the date from `messageExportDate` — the person's own calendar date,
   not UTC, or an evening's saves west of Greenwich would all be filed under
   tomorrow: `acme-follow-up-2026-08-13`.
3. **It sends the request over the bridge.** HTML, file name, format, and the
   Rally mark as a PNG data URL. The main process re-validates all four; the file
   name in particular must match `^[a-z0-9][a-z0-9-]{0,79}$`, so a name is
   *rejected* rather than sanitized.
4. **The main process builds the document** — `messageExportDocument` — and files
   it under a random token.
5. **A hidden window loads it** from `rallywithai-export://sheet/<token>`. The document
   is served from memory with its own restrictive `Content-Security-Policy`
   response header, and **reading it spends it** — the token resolves once, for
   the one navigation it was minted for.
6. **The bytes are made**, one of two ways, below.
7. **The save dialog opens** over the focused window, defaulting to the person's
   Downloads folder, and the bytes are written to whatever they chose. A dismissed
   dialog writes nothing and is not an error.

### The card

Both formats share a stylesheet built around the class names `MarkdownBody`
emits, so the two stay in step by construction: a class added there is a missing
rule here, visible the first time a card is looked at.

Three things on the card are drawn rather than reproduced: the code block's copy
button is hidden, a task list's checkboxes are redrawn as marks, and a citation
keeps its shape but loses everything that promises interaction — the footnote
pill's hover popover is `display: none`. A
picture of a control is a lie, a greyed system checkbox reads as broken rather
than as a task that is not done, and a hover popover printed into a PNG is a grey
box over the text with no way to dismiss it.

The chip and the embed keep their shape rather than flattening to text, so a
reader recognises the thing they clicked in the app. Interactive pills show an
asterisk. Saved pills keep a number, with neutral ink and grey fill, so each
marker identifies its entry in the printed source list without a hover.

What the card does *not* share with the turn is the footnote lift. The card
renders with `MarkdownBody`'s `still` flag, which keeps the trailing source list
the transcript drops: on screen a pill's sources are one hover away, and here
that hover does not exist and its popover is hidden two paragraphs above. Without
it the card printed numbered pills over nothing — the claims kept their markers
and the sources left the file entirely.

A Mermaid fence is deliberately saved as its highlighted source rather than as
the live diagram. Mermaid rendering is asynchronous, while the detached
`MarkdownBody` root is serialized synchronously; capturing that live branch
would save whichever loading state happened to win the race. The source is the
complete, deterministic content and keeps the diagram reproducible. If exports
need SVG later, the export operation must await a prepared render before taking
`innerHTML`.

The colours are the light inverse of the application's, with one deliberate
exception — a code block stays dark. The highlighter writes its colours as inline
styles chosen for a dark background, and repainting them on white would mean
overriding every one of them for no gain.

The splash is five radial washes plus a diagonal base, placed by percentage so
the colour spreads over a card of any height instead of pooling at the top of a
long one. A small hash of the message's own HTML rotates which colour lands in
which corner, so two saves from the same work stream do not come out identical
and the same message always comes out the same.

### A picture

The window is 960 CSS pixels wide. Once loaded, it is asked — in the page — for
`document.body`'s height, after `document.fonts.ready` and after every `<img>`
has either loaded or failed. The window's content area is then set to exactly
that, at a zoom factor of 2, and captured as JPEG at quality 92.

The measurement is what makes the picture whole: a capture is of the window's
content area, so a window that is not as tall as the card yields a cropped one.
It has a second effect worth knowing about — evaluating anything in a window that
has never been shown is also what gets it to paint, and a capture taken without
it can wait for a frame that never arrives.

### A PDF

The window is 816 CSS pixels — US Letter at 96dpi less the printed margins — and
Chromium paginates it through `printToPDF` with backgrounds on and a footer
template. Two details carry the page design:

- **The splash frame is a box in the flow, not a page background.** Chromium
  clips a page's background to the content area, which the card fills, so a
  background splash is invisible on every page but the last. Instead the card
  sits inside an `.export-sheet` whose padding *is* the frame, and both boxes
  carry `box-decoration-break: clone` so each page's fragment gets its own
  rounded corners, padding, and full gradient.
- **The footer is Chromium's, not the document's.** Header and footer templates
  render in a frame of their own, which is what puts them on every page; it is
  also why the mark travels inline in the template and why the template restates
  `print-color-adjust`.

Headings carry `break-after: avoid-page`, and tables, block quotes, and code
blocks `break-inside: avoid-page`, so a heading is never stranded at the foot of
a page and a table is not split away from its header.

### A whole conversation

**Export conversation to PDF** in a thread's or a breakout's **More** menu
sends the same request with `scope: 'conversation'`. Three things differ from
one message:

1. **The history is read first.** The feed holds only the pages someone has
   scrolled through. `ConversationSurface` reads every gap in the transcript
   snapshot, oldest first and one `TRANSCRIPT_RANGE_BLOCK_SIZE` page at a
   time, through the socket's own `loadTranscriptRange`, retrying on
   `transcript_snapshot_changed` the way paging back does. The pages stay in
   the feed afterwards.
2. **Only what was said is printed.** `conversationExportTurns` keeps text
   turns and a Sidekick's delivered results, each under the byline the feed
   gives it and an absolute date and time. Thinking, tools, system notes,
   open questions and undelivered messages are left out. A person's words are
   drawn as typed (`verbatim`); Rally's carry their citations.
3. **There is no size bound.** A conversation has no `contentHtml` ceiling,
   because the person asked for all of it and a ceiling would refuse exactly
   the long ones. It is always a PDF: the schema rejects a conversation asked
   for as a picture.

A breakout prints its own turns, not the thread turns it started from. The row
is held as **Exporting conversation…** while one is being prepared, and a
failure opens the menu's usual failure dialog.

### One at a time

`MessageExporter` serializes every export through a promise chain. Each one owns
a Chromium window, and two racing costs a window's worth of memory for no gain:
nobody is waiting on the second file while the first save dialog is still open.
The chain recovers from a rejected export rather than wedging behind it.

## Invariants

- **The markdown in a saved file is rendered by `MarkdownBody` and nothing else.**
  A second renderer here would drift from the feed, and the drift would only ever
  be seen by the person who already sent the file. This is the same rule
  [`markdown-rendering.md`](markdown-rendering.md) states, and the reason the
  request carries HTML rather than markdown.
- **The export document is never same-origin with the application.** It is a page
  built out of a model's words; it gets a scheme of its own, no preload, no Node,
  and a policy that forbids script. Serving it from `app://rallywithai` would put it
  inside the renderer's origin for the sake of one fewer scheme.
- **Every class `MarkdownBody` emits has a rule here.** It is not enough to be
  true today: the miss is invisible until somebody opens a saved card, which is
  the wrong place to find out. A parameterised test in `message-export.test.ts`
  names each citation class and fails the build when one has no rule.
- **Nothing on the card depends on a pointer.** Hover, focus and click are all
  absent from a picture, so anything they would have revealed is either drawn
  into the card or lost with it. That is what the `still` flag is for, and it is
  the question to ask of the next affordance that reaches this document.
- **A file name is validated, never sanitized.** The name is derived from message
  text, and text a model wrote reaches `showSaveDialog` as a default path.
  Rejecting is checkable; sanitizing invites the argument about whether the
  stripping was complete.
- **The export window is destroyed on every path.** It is created per export and
  released in a `finally`, including when the render times out. A leaked hidden
  window is invisible by definition.
- **A token is spent by the read that resolves it.** The protocol serves one
  document to one navigation; a second request for the same URL — a reload, a
  request that raced the render — gets nothing. Dropping it when the load
  *finished* was the first attempt, and it left the document readable for as long
  as a capture took.
- **The application's `onHeadersReceived` leaves export responses alone.**
  `installContentSecurityPolicy` asks `isMessageExportUrl` first and returns
  without touching the headers. Falling through would attach the renderer's much
  broader policy to a document built out of model output, and while two policies
  are enforced conjunctively today, that only holds because the two handlers case
  the header name differently. A boundary that survives on header casing is not
  one.
- **The measurement runs before the capture.** Without it the picture is the
  height of whatever the window happened to be, which is a silent crop.

## Boundary

This module owns the card: its markup, its stylesheet, the splash, the footer,
the render sequence, and the write. It exposes exactly one thing to the
renderer — `exportMessage` on the desktop bridge — and one thing to the rest of
main: `MessageExporter`, plus the protocol constants `index.ts` registers.

It does not own the markdown, the message, or how either is styled in the
application. `MarkdownBody` and `.markdown-body` belong to
[`markdown-rendering.md`](markdown-rendering.md); the feed belongs to the
work-stream screen. The card's stylesheet deliberately does **not** live in
`app.css` and deliberately does not reuse the `.markdown-body` group: that group
dresses markdown for a dark application window, and every element in a light card
meant for a document needs a different value, not a filter over the same one.
Sharing them would leave both surfaces fighting one cascade.

It is desktop-only. The renderer hides both buttons where `window.avalon` is
absent, because rendering with Chromium and choosing a place on disk are both
main-process capabilities and a browser has neither.

## Failure modes and limits

- **A dismissed save dialog** answers `{ saved: false }`. Nothing is written and
  the row returns to rest — a dismissal is a decision, not an error.
- **A render or write that fails** turns the button's label into *Image failed* or
  *PDF failed* until the pointer leaves the row or another save starts. Unlike a
  failed copy, there is no other copy of the file to fall back on, so it is worth
  saying — and worth forgetting, because a stale failure under yesterday's turn
  reads as a broken feature.
- **Neither state is visual only.** Each button keeps a fixed accessible name, so
  the spinner and the changed label announce nothing by themselves; the active
  button is marked `aria-busy` and a `role="status"` region in the row speaks
  *Preparing the image…* and *The image could not be saved.*
- **A stalled Chromium** is not waited on: the load is capped at 15 seconds, the
  measurement at 15, and the whole render at 60. The window is destroyed and the
  failure surfaces on the button.
- **A picture taller than 6,000 CSS pixels** renders at 1× instead of 2×, because
  a surface twice that size is more than Chromium will reliably hold. Past 12,000
  CSS pixels the capture is cropped there — a message that long has stopped being
  a picture, and the PDF beside it has no such limit.
- **A picture in the message that fails to load** is waited for and then left out;
  the export is not the place to discover a dead URL. Remote images load over
  HTTPS, matching what the feed itself will already have fetched.
- **A message with no text** has no actions at all: the row only renders for a
  finished turn that has some.
- **A payload past its bounds** — one message's HTML over 600,000 characters, a
  mark over 400,000 — is rejected as an invalid request rather than rendered.
  The error names the rejected field. A conversation's HTML has no bound.
- **A very long conversation** reads its history a page at a time before
  anything renders, and still has the 60-second render cap above. Neither has
  been measured against a long thread.
- **The Rally mark failing to load** fails that export and is retried on the
  next, rather than being cached as a rejection.

## Security and trust model

The document is written from text a model produced, so it is treated the way
[`security.md`](security.md) treats every model output.

- `react-markdown` renders markup in its input as text — no `rehype-raw` — so the
  HTML that crosses the bridge carries no script to begin with. The closed bare
  break-tag rewrite is the one exception and emits only an empty `<br>`.
- The window that renders it has `sandbox`, `contextIsolation`, no preload, no
  Node integration, and no devtools, and the response carries
  `default-src 'none'; img-src data: https:; style-src 'unsafe-inline'`.
- Every field of the request is parsed in the main process before use, and the
  IPC handler is behind `assertTrustedIpcSender` like every other.
- The only thing written to disk is the file the person chose in a native dialog.
  Nothing is written anywhere else, and no document is persisted; the export
  document lives in main-process memory for the length of one render.

## Testing

```bash
pnpm --filter @rally/desktop exec vitest run src/main/message-export.test.ts
pnpm --filter @rally/desktop exec vitest run src/common/message-export.test.ts
pnpm --filter @rally/desktop exec vitest run src/renderer/components/workstream-blocks.test.tsx
```

`src/main/message-export.test.ts` drives `MessageExporter` against a fake window,
which is where the sequence is pinned: what the protocol serves and when it stops
serving it, the resize the capture depends on, the fallback to 1×, that a PDF
never captures, that the window is destroyed on every path, and that a failed
export does not wedge the queue. Its fake asserts that only one window is ever
open at a time, so a change that breaks serialization fails there rather than in
production memory.

What no test here can reach is the policy Chromium actually applies. The suites
assert on the `Response` the handler returns and on `isMessageExportUrl`, which
is what `installContentSecurityPolicy` branches on; whether a *third* handler
later attaches a policy of its own is only visible by loading the document in a
real window and trying something the policy forbids.

Two traps:

- **Nothing in jsdom can see the card.** The component test asserts that the
  right request is sent; the main-process test asserts what the document says.
  Neither can tell you the splash is invisible or the footer overlaps the text.
  Anything visible here is checked by rendering a real card, per
  [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it).
- **The renderer test needs `fetch` stubbed.** The mark is read out of the bundle
  before the bridge is called, and jsdom has no server to read it from. A test
  that renders a feed `MessageBlock` also needs `desktopServicesAvailable` in
  its `../lib/platform` mock. Export buttons and the message-text context menu
  both read it on mount, and a mock that only exports `desktopBridge` throws
  there.

### 2026-10-24 — A whole Thread or Breakout can be saved as a PDF

**What changed:** The thread and breakout menus gained **Export conversation
to PDF**. The request gained `scope`, and a `conversation` scope drops the
`contentHtml` bound and must be a PDF. The card's stylesheet gained the
`.export-turn` rules for a title and per-turn bylines. A rejected request now
names the field it rejected.

**Why:** People asked to take a whole conversation out of Rally, not one turn
at a time. Reusing this module kept the one-renderer rule: each turn is still
drawn by `MarkdownBody`, and Chromium, the protocol and the save dialog are
unchanged. A separate print path (the browser's own print dialog, or a PDF
library in the renderer) was rejected because it would need a second
stylesheet and a second markdown rendering. The feed's paging is reused for
the same reason: the snapshot is the one place the transcript lives.

**What a future change has to respect:** the export reads every page of a
conversation into the live feed's cache. A change that windows or evicts
loaded ranges has to give the export another way to read the full history.
The conversation scope has no size bound by design; if one is wanted, its
number is the team's to set.

### 2026-08-30 — Mermaid diagrams save as source

**What changed:** A `mermaid` fence remains the ordinary highlighted code block
when `MarkdownBody` renders with `still`, even though it becomes an SVG diagram
on live reader surfaces.

**Why:** Mermaid rendering is asynchronous and the export root is intentionally
serialized in one synchronous pass. Mounting the live branch would save a
loading fallback nondeterministically; source preserves every byte needed to
reproduce the diagram and keeps the established no-suspension export contract.

**What a future change has to respect:** rendering diagrams into exports means
preparing the SVG before serialization and awaiting it explicitly. Do not make
the detached root race an effect or add a fixed wait.

### 2026-08-29 — The card draws no preview, because it can never have one

**What changed:** `.citation-card-preview` and `.citation-card-preview-skeleton`
are declared `display: none` here.

**Why:** the renderer's embed card now previews the resource's converted text,
and shows a shimmering skeleton while that text is being prepared. A still is
serialized at one moment, so `MarkdownBody`'s `still` flag stops the card
asking at all — neither element can appear in a saved picture. The rules exist
because the coverage test names every citation class the renderer can emit and
requires an answer here, and the honest answer for a live-loading affordance in
a picture is that it is not drawn.

**What a future change has to respect:** a rule here is not what stops the
preview appearing — `still` is. Removing that flag's effect would put a frozen
skeleton into somebody's saved file, and this stylesheet would hide it only by
accident.

### 2026-08-29 — The embed card follows the renderer's file-tile shape

**What changed:** The `.citation-card` rules here redraw the renderer's reworked
embed card — a fixed-width tile with the kind badge at the head and the title
and kind at the foot — in this document's fixed light palette. The chevron rule
is gone because the renderer no longer emits the element, so the class left the
parameterised coverage list on its own. The renderer's `.citation-card-row`
(a run of embeds sharing one horizontal row) wraps here instead of scrolling:
a still cannot scroll, and a row that clipped would drop cards from the file
somebody keeps.

**Why:** The renderer reshaped the embed card from a one-line row into a file
tile, and this stylesheet mirrors the markup `MarkdownBody` emits — a card
whose rules still describe the row would have drawn the new badge unstyled and
the tile as a squashed line. The palette stays this document's own: the card is
deliberately unthemed, so it takes the shape, not the tokens.

**What a future change has to respect:** the coverage test only proves every
citation class has *a* rule here, not that the rule still matches the
renderer's layout. A reshape over there is a redraw over here, in the same
change.

### 2026-08-28 — The card keeps a citation's sources

**What changed:** The card renders `MarkdownBody` with a new `still` flag, which
stops the footnote lift dropping the trailing source list. Pills and list now
appear together, numbered by the same ordering.

**Why:** The lift trades the source list for a hover popover, and this document
already hides that popover — a hover affordance printed into a PNG is a grey box
with no way to dismiss it. Both rules were right on their own and wrong
together: a saved grounded answer carried a `1` and a `2` after its claims and
said nowhere what either one was. A picture has no scroll to spend, so the
vertical space the lift reclaims is worth nothing here, which is what makes
keeping the list the cheap side of the trade.

**What a future change has to respect:** `still` is the card's, not a general
switch — the transcript's lift is the feature, and turning it off there spends
the space this was all built to reclaim. Anything else the card borrows from an
interaction it cannot have belongs behind the same flag.

### 2026-08-27 — The card styles citations

**What changed:** Rules for the citation chip, the embed card, the footnote pill
and the identity card, written for a light card. The pill's popover and the
card's chevron are hidden, and so is `.sr-only`. A parameterised test names every
citation class the renderer emits and fails when one has no rule here.

**Why:** The card shares `MarkdownBody`'s markup and none of its stylesheet, so
each new class arrived here unstyled — and this document already recorded that
the miss shows up as an unstyled element in the first card anybody looks at,
which is a long way from the change that caused it. Citations added eleven
classes at once, which made "somebody will notice" a worse bet than usual.

The `.sr-only` rule is the one that was not predicted. GFM titles its footnote
section with a heading it expects the host to hide, and this document loads none
of the application stylesheet — so the first captured card printed a bare
"Footnotes" above the list, a word out of the renderer's plumbing in the middle
of somebody's saved picture. It was invisible to every component test and
obvious in the first real capture, which is the whole argument for taking one.

**Consequences:** The guard is the interesting part, not the rules. It turns a
whole category of drift — a class added to the renderer with no rule written
here — into a build failure, which is what this document had been asking for in
prose since the stylesheet split. It does not check that a rule is *good*, only
that one exists; the card is still read from a real capture, as everything
visible here is. Shipped in
[#381](https://github.com/juno-ai-labs/avalon/pull/381). Design:
[`docs/PRDs/2026-08-27_inline-resource-citations/prd.md`](PRDs/2026-08-27_inline-resource-citations/prd.md).

### 2026-08-25 — The export scheme is rallywithai-export://

**What changed:** `MESSAGE_EXPORT_SCHEME` is `rallywithai-export`. No legacy scheme is
registered or accepted.

**Why:** The rebrand to Rally. Unlike the desktop deep link and the renderer
origin, which both kept their superseded values working, this one was renamed
outright: the scheme is registered, served, and loaded entirely inside the main
process, against a single-use token held in memory for one export. Nothing
outside ever receives a URL on it, so there is no party to keep working and a
compatibility alias would have been dead code from the day it shipped.

**Consequences:** The invariant that matters is unchanged and is the reason this
scheme exists at all — an export document must never share an origin with the
application, so it must not be moved onto `app://rallywithai` no matter how convenient
the existing handler looks. See [`domain-migration.md`](domain-migration.md) for
why the schemes were treated differently from each other.
### 2026-08-13 — Rally's messages can be saved as a picture or a PDF

**What changed:** Two buttons joined **Copy** under a finished turn. Both render
the turn's own `MarkdownBody` DOM onto a card in a hidden Chromium window in the
main process — captured as one tall JPEG, or paginated to PDF with the Rally
mark in every page footer — and save it through a native dialog.

**Why:** Messages worth keeping had only one way out of Rally: copying markdown
into something that renders it. The card exists so the file looks like the thing
the person was reading, which is why the markdown is the feed's own component and
only the surroundings are new.

Rendering was put in the main process rather than the renderer because Chromium
is already there. The alternative — drawing the card into a canvas through an SVG
`foreignObject`, the way the browser libraries do it — was rejected: it silently
drops anything it cannot inline, and it would have needed a second layout of the
same markdown to keep, and to keep correct. Doing it server-side was considered
first and rejected for a different reason: the API is a Cloudflare Worker with no
browser binding, so it would have meant adding one and shipping the message's
text off the device to have a picture of it made.

Three details are load-bearing and look arbitrary from inside the file:

- **The document is served over `rallywithai-export://` rather than handed to the
  window as a `data:` URL.** Chromium refuses a top-level `data:` navigation past
  roughly 128 KB, which a message with a table in it reaches; the failure is an
  opaque `ERR_FAILED` at load. A scheme also carries a real CSP response header.
- **The load waits on `did-finish-load` instead of awaiting `loadURL`.** A hidden
  window can stop loading before Chromium reports the load finished, and
  `loadURL`'s promise rejects on that race even though the page is fine.
- **The splash frame in a PDF is a box in the flow with
  `box-decoration-break: clone`, not a page background and not a fixed layer.**
  Chromium clips page backgrounds to the content area, which the card fills, and
  a `position: fixed` layer paints over the flowing content instead of behind it.
  Both were tried; both produced pages that were white where the design called
  for colour.

Review added three constraints that are easy to undo by accident. The
application's own `onHeadersReceived` now returns early for export responses:
it had been attaching the renderer's policy alongside the strict one, and while
two policies are enforced conjunctively — so the export document was never
actually loosened — that held only because the two handlers case the header name
differently, which is not a boundary. A token is spent by the read that resolves
it rather than when the load finishes, so the document is not on offer for the
seconds a capture takes. And the window is created before the token is
published, so a `createWindow` that throws cannot leave a 600 KB document behind
with no `finally` to clear it.

JPEG rather than PNG for the picture, measured on a full sample card: 294 KB
against PNG's 454 KB. The saving is entirely the gradient splash — on a
text-only crop PNG is both smaller and lossless — so the choice follows the card
having a photograph-like background rather than the text having one, and it is
worth re-measuring if the splash ever goes.

**Consequences:** The card's stylesheet is a second place markdown is styled, and
the one thing a future change has to respect is that it is styling *the same
DOM*: a class `MarkdownBody` starts emitting has no rule here until someone adds
one. That is the accepted cost of a light card, and it is why the export test
asserts on class names rather than on rendered output.

The image path is capped rather than unbounded — 2× up to 6,000 CSS pixels, 1×
above it, cropped past 12,000 — because the capture is a single Chromium surface.
If that limit ever needs lifting, the answer is not a bigger window: it is
capturing in tiles, or leaving long messages to the PDF.

`vitest.config.ts` now includes `src/common`, which had never been run. The one
test file already living there had been dark since it was written.
