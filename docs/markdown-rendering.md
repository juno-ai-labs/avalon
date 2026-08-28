# Rendering markdown in the desktop client

Almost everything Rally shows a person is markdown a model wrote: a work-stream
turn, a HyperSight block, a meeting briefing, a note, an automation's overview.
All of it goes through one component and one block of CSS. This document covers
that renderer — what it adds on top of `react-markdown`, what a surface hosting
it may and may not restyle, and the two tests that keep the arrangement from
quietly coming apart again.

The single renderer is the whole point rather than an implementation detail. It
was three renderers until 2026-08-12, the copies drifted, and a fix applied to
one of them silently missed the others; the changelog records what that cost.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `MarkdownBody` — the only place `react-markdown` is mounted — and its component overrides: `MarkdownCode`, `MarkdownCodeBlock`, `MarkdownTable`, and the `a`, `img`, `li` and `section` renderers that hand a node to the citation matrix. |
| `apps/desktop/src/renderer/components/markdown-citations.tsx` | The citation matrix — every scheme in every position — and the chip, embed card, footnote pill and identity card it renders. |
| `packages/contracts/src/citations.ts` | The protocol itself: the scheme allowlist, the footnote definition grammar, and the plain-text rewrite that outbound email and Slack delivery send instead. |
| `packages/contracts/src/markdown-code.ts` | Which lines of a markdown string are code, which `splitStreamingMarkdown` and the citation rewrite both read rather than each deciding. See [`markdown-code.md`](markdown-code.md). |
| `apps/desktop/src/renderer/lib/use-citations.ts` | What a cited resource resolves to and where clicking one goes. |
| `apps/desktop/src/renderer/styles/app.css` | The `.markdown-body` group: every element style markdown gets. Also the two host overrides, `.note-detail-article` and `.meeting-notes-body`, each of which states a heading scale and nothing else. |
| `apps/desktop/src/renderer/styles/app.css.node.test.ts` | The stylesheet guards: the list markers Tailwind's preflight removes, and the assertion that no host restyles a markdown element. |
| `apps/desktop/src/renderer/components/markdown-renderer.node.test.ts` | The guards that `react-markdown` stays mounted in one place, and that it and `remark-gfm` stay pinned to exact versions. |

Nine call sites, all passing a markdown string as `children`:

| Surface | Call site |
| --- | --- |
| A work-stream turn, and the structured block above it | `workstream-blocks.tsx` |
| A HyperSight dashboard block | `block-dashboard-panel.tsx` |
| An automation's overview while it is being set up | `new-automation.tsx` |
| The Control Tower meeting briefing | `screens/meeting-notes.tsx` |
| A note's body | `screens/note-detail.tsx` |
| A Markdown or converted document attachment in the full-window lightbox | `attachment-lightbox.tsx` |
| A resource's readable content in the rail's detail | `inspector-rail.tsx` |
| A turn being saved as a picture or a PDF | `workstream-blocks.tsx` builds it; `lib/message-export.ts` renders it off-screen for its markup |

## How it works

`MarkdownBody` renders a `div.markdown-body` around `ReactMarkdown` with
`remark-gfm`, so tables, task lists, strikethrough, and autolinks all parse.
Overrides sit on top of the default element mapping: code and tables below, and
the four — `a`, `img`, `li`, `section` — that hand a node to the citation
matrix.

### Code

`MarkdownCode` decides inline from block itself rather than trusting the tag: a
fence carries a `language-*` class, and an indented block ends in a newline.
Inline code becomes `code.markdown-inline-code`; a block becomes
`MarkdownCodeBlock`, which highlights through `prism-react-renderer`. An
unrecognised language falls back to `plain` after one pass through
`markdownLanguageAliases`, so a fence labelled with something Prism has never
heard of still renders as code.

`MarkdownCodeBlock` renders a `.markdown-code-block-header` bar above the
highlighted `pre`: the fence's language on the left as `.markdown-code-language`,
and the copy button — backed by `desktopBridge().copyText` — on the right. The
label is looked up by `codeLanguageLabel` against the Prism-resolved name first
and the fence's own word second, so `mermaid` reads as "Mermaid" even though it
highlights as `plain`. The header sits outside the `pre` deliberately: the code
itself scrolls horizontally in `.markdown-code-block pre`, and a button living
inside that scroll region is only as reachable as whatever the reader has
scrolled to. A fixed header keeps the copy control in the same place regardless
of scroll position.

Because `MarkdownCodeBlock` emits its own `pre`, the `pre` override is a
pass-through fragment. Without it every block would be wrapped in a second one.

### Tables

`MarkdownTable` wraps the table in `div.markdown-table-scroll`, so a table wider
than its surface scrolls inside its own box instead of widening the page. It
counts the header row's cells and publishes the count as
`--markdown-table-columns`, which the stylesheet uses to give the table a minimum
width proportional to how many columns it actually has.

### Mentions

A person mention arrives as a link with a `person:<uuid>` href and a connector
mention as `connector:<type>:<label>`. `urlTransform` lets exactly those two
schemes through untouched — everything else goes through react-markdown's
`defaultUrlTransform` — and the `a` override is where they are decided. A
`person:` href resolves against the `mentions` prop and becomes a `MentionChip`;
a `connector:` href minted by this render's own token becomes a connector chip.
Neither is ever emitted as a navigable link. Every other link renders as an
external one, with `target="_blank"` and `rel="noopener noreferrer"`.

The connector token is created once per mounted body, so a link keeps its
identity across re-renders and a `connector:` string that merely appears in the
model's text cannot impersonate one.

### Citations

A citation is the same mechanism as a mention pointed at content instead of an
identity, and it reuses every part of it: ordinary Markdown syntax, a custom
scheme through `urlTransform`, a component override that decides, and label text
when it cannot. What it adds is a second syntax form and a second position.

`[Title](resource://<id>)` renders as an inline chip.
`![Title](resource://<id>)` renders as a block embed card — image syntax, because
models place an image on its own line by training, so the card lands between
sentences with no renderer heuristic guessing where a block belongs. A GFM
footnote whose definition is one paragraph carrying exactly one link becomes an
inline numbered pill with a hover popover, and its entry is dropped from the
trailing list; a definition that does not fit that grammar keeps classic
footnote rendering, and the section renders only what was left. In the common
all-citations case nothing renders at the bottom at all, which is the vertical
space the feature exists to reclaim.

The dispatch is a **matrix, not an if-chain**: three
`Record<CitationScheme, …>` tables, one per position, so a scheme added to the
protocol is a type error until somebody has decided what it looks like as a
link, as an embed, and as a source. Two cells are worth knowing about:

- **`image` × `https` is a real image**, deliberately. Markdown images render
  today and the CSP permits them, so hijacking that syntax as a web-citation
  card would collide with the model legitimately embedding an image.
- **`link` × unknown keeps react-markdown's default.** That cell is where
  `mailto:`, `tel:` and relative targets live; rendering it as text would be a
  regression dressed as a degradation.

Resolution is the loaded work stream's resource set, and nothing wider. A cited
resource it carries resolves synchronously, so the chip is on the first paint;
anything else renders as its label text. That is a deliberate narrowing rather
than a missing tier: the rail resolves an inspector target from the same set, so
a chip dressed from a wider lookup opens a panel saying the resource "may have
been removed" — of something that exists and that the reader may be entitled to
see. Label text says less and says nothing false. The wider lookup returns with
the rail's fetch-by-id detail, and the two have to land together.

A citation rendered into a **still** — the saved card — keeps its pills *and*
its trailing source list. Lifting a definition trades the list for a popover,
which is the right trade on a surface that can be hovered and the wrong one in a
picture: the export stylesheet hides the popover, so a lifted card showed bare
numbers over nothing and the sources were gone from the file somebody kept.

Two things here are structural rather than incidental:

- **The citation context travels by React context, not by prop.** A host-owned
  object in the components' dependency list would invalidate the memoised
  component config on every commit, exactly as a `mentions = []` default does,
  and turn the streaming fast path back into a whole-body re-parse. Context
  updates cross a `memo` boundary, so a footnote definition that arrives
  mid-stream still reaches its pill while the settled segments around it are
  reused untouched.
- **Footnote ids are namespaced per mounted body** through remark-rehype's
  `clobberPrefix`. GFM writes identical `fn-1`/`fnref-1` ids into every message,
  and a transcript is dozens of mounts of it.

`react-markdown` and `remark-gfm` are pinned to exact versions, and a guard in
`markdown-renderer.node.test.ts` keeps them that way. The footnote DOM those two
produce — the `data-footnote-ref` anchors, the `.footnotes` section — is read
here by attribute and class name, so a minor release renaming either would
degrade every citation to a plain superscript with no build error to catch it.

### Streaming

A message that is still growing renders through `MarkdownBody`'s `streaming`
mode: `splitStreamingMarkdown` cuts the source into settled segments plus an
open tail, and each settled segment renders through a memoised component keyed
on its source string. A commit that only appended to the tail re-parses the
tail alone; the settled body's elements are reused untouched. Cuts are decided
only at complete lines — the still-arriving final line decides nothing,
because its classification can change as it grows (a bare `1` is a paragraph
until the `.` makes it a list item), and that deferral is what makes the
settled prefix unconditionally stable — and land, outside code fences (whose
boundaries are [`markdown-code.md`](markdown-code.md)'s answer, shared with the
delivery rewrites), in two places: at a non-blank line after a blank line that does not continue the
previous block (a blockquote line or an indented continuation still does),
and at a top-level list item that follows an item of the same marker, blank
line between or not. The list cut exists because a list-dominant reply — a
very ordinary "here is the plan" — otherwise has *no* safe blank-line
boundaries at all, settles nothing, and re-parses whole on every commit at
the paced reveal's rate.

Streaming rendering is therefore an approximation the settled re-render
heals: each settled list item renders as its own single-item list while the
message streams (ordered numbering survives via the `start` attribute; a
loose item renders tight — without its paragraph wrapper — until the turn
completes), and a reference link or a GFM footnote whose definition arrives
in a later segment renders literally until then. The commit that ends the
stream renders the source whole again.

This exists because the paced reveal
([`streaming-reveal.md`](streaming-reveal.md)) commits up to once per painted
frame, and re-parsing and re-highlighting a whole reply per commit grows with
its length: measured before the change, a 20,000-character streaming reply
held the main thread for ~27 of every 30 seconds and dropped the transcript to
17 frames per second. With segmentation the per-commit cost is flat in reply
length — ~57fps with zero long tasks from 500 through 20,000 characters,
measured for a heading/paragraph/fence body and for a list-dominant one (the
harness's two corpora). The cost is guarded by
`workstream-blocks-streaming-cost.test.tsx`, which asserts, for both of those
shapes, that ten tail appends together cost less than one initial parse.

The memoisation is only as good as its inputs' identity, and the trap that
has already bitten — twice, in the same change that introduced this — is a
`mentions = []` parameter default: a new array per render invalidates the
memoised component config and silently turns every commit back into a
whole-body re-parse, in the client only, where the message flows through
`AssistantMessageContent`. Both defaults now share the hoisted `NO_MENTIONS`
constant; anything feeding `MarkdownBody` per-render object identities gets
the same failure back.

### Styling

The `.markdown-body` group in `app.css` styles every element markdown produces.
It exists in the form it does because `@tailwind base` pulls in a preflight that
sets `list-style: none` on every `ul` and `ol`; the group takes that back, and
restates the browser's own `disc → circle → square` progression, counting depth
in list ancestors of either kind so that an `ol` holding a `ul` is a second level.

A surface hosting `MarkdownBody` may override typography — a heading scale, a
measure — because that is a property of the surface. It may not restyle a
markdown element. Two surfaces take the exemption: a note reads as a document
page and steps its headings 22/17/14, and the meeting briefing sits in a narrow
rail beside a transcript and holds every level at 15px.

Both write the exemption as `<host> .markdown-body :is(h1, …)`, naming the shared
container even though the host alone would select the same elements. That is
deliberate. `.note-detail-article h1` ties `.markdown-body h1` at (0,1,1) and
wins only by sitting lower in the file, so the override would survive exactly as
long as nobody split the stylesheet or moved a block. With `.markdown-body` in
the selector it is (0,2,1) and the question does not arise. A host override that
cannot be written this way is a sign it is not a typography override.

## Invariants

- **`react-markdown` is mounted in exactly one place.** A second mount is a
  second renderer, and the styling written for the first will not reach it. This
  is not hypothetical: it is what happened, and what the surfaces that had it
  looked like was *nothing* — no error, no visual break, just a list without
  markers that nobody connected to a CSS change made elsewhere.
- **Markdown element styling lives in the `.markdown-body` group and nowhere
  else.** A rule like `.note-detail-article ul` ties `.markdown-body ul` on
  specificity, so which one applies is decided by which is further down a
  3,000-line file. Nobody editing a screen's styles is thinking about that.
- **A host may override typography, not elements.** The distinction is whether
  the declaration describes the surface or the markdown. A heading scale and a
  measure describe the surface; a list indent, a code background, and a table
  border describe the markdown. Text colour is on neither list, because it is
  not a host's to set at all — see the failure modes below.
- **A host override wins on specificity, not source order.** Name
  `.markdown-body` in the selector. Anything relying on being further down the
  file is a regression waiting for the next person who splits a stylesheet, and
  it fails silently and visually, which is the combination this module has
  already been bitten by once.
- **A mention link is never navigable.** `person:` and `connector:` survive
  `urlTransform` only so the `a` override can turn them into chips or, failing
  that, into inert text. If one ever reached the DOM as an `href`, a model would
  be choosing a destination.
- **A connector chip requires this render's token.** Without it the link is text
  someone wrote rather than a mention Rally minted, and it renders as a
  fallback span.
- **A citation that cannot be resolved renders as its label text, and nothing
  else.** A chip adds an affordance, never disclosure: the label is the model's
  own words, already in the message. This is also what an unauthorized target
  renders as, which is why it is indistinguishable from one that does not exist.
- **`urlTransform` passes exactly three schemes, in two positions.** `resource:`,
  `person:` and `connector:`, on `a[href]` and `img[src]`. Everything else goes
  through `defaultUrlTransform`, which empties what it rejects. Widening this is
  how a model-chosen destination reaches the DOM.
- **The matrix has no fallthrough.** Every cell is written, or the compiler
  refuses the table. An `else` branch here is a silent gap by another name.
- **A citation's sources are reachable on whatever surface it renders on.** In
  the transcript that is the pill's popover, which is why the trailing list can
  go; in a still it is the list, because a picture cannot be hovered. A surface
  that has neither is a surface where the sources were lost.
- **A footnote identifier is keyed as GFM keys it, percent-encoding included.**
  GFM writes the DOM id as `normalizeUri(id.toLowerCase())`, so `[^café]`
  arrives as `fn-caf%C3%A9`. The renderer undoes the escape rather than assuming
  every identifier a model writes is ASCII.
- **The rail's preview waits the delay the route names, and invents none of its
  own.** `409 resource_processing` is the preview route saying a derivative is
  still being materialized, and it carries a `retryAfterMs`: the route knows
  whether it is waiting on a claim, a hash write or a conversion, and answers
  250ms or 1s accordingly. A backoff schedule written in the renderer would be a
  second opinion about something only the server can see. What the renderer does
  own is *how long it keeps asking*, and that is a wall-clock budget rather than
  a count of attempts, because the same count means 100 seconds or 6½ minutes
  depending on which delay it meets.
- **The preview poll is what performs the conversion, not just what observes
  it.** `ResourceService.preview` calls `materializeAttachmentDerivative` inside
  the request, and its only other caller is the agent's attachment tool — there
  is no queue, workflow, or alarm doing this in the background. So a
  `processing` answer means another in-flight request holds the claim, and the
  attempt that wins the claim is the one that converts. Replacing the poll with
  a subscription would deadlock the case where nobody else is asking; a push
  model needs a durable owner of the conversion first.
- **Every divergence between this grammar and remark-gfm degrades toward showing
  too much.** A definition this module does not recognise keeps classic GFM
  rendering; a footnote section it recognised nothing in still renders. The one
  case that degraded the other way — an empty map satisfying the section guard's
  equality vacuously — is now guarded, because a redundant source list is a
  blemish and a missing one is content loss.

## Boundary

This module owns how a markdown string becomes DOM in the renderer, and how that
DOM is styled. It exposes `MarkdownBody` — taking a markdown string, an optional
`mentions` array and an optional `citations` context — plus the citation matrix
and `ResourceIcon`, which the inspector rail renders too so that one resource
kind draws one glyph everywhere.

**It does not own where a citation goes.** The host supplies resolution and
click routing as `CitationContext` (`lib/use-citations.ts` builds the
work-stream screen's), and a surface that supplies none is not broken — every
citation on it degrades to the label text the message already carried. That
split is deliberate: the renderer knows the protocol, the host knows the
application, and neither should be guessing about the other. The two
non-renderer delivery surfaces own their own reductions rather than borrowing
this one; [`digests.md`](digests.md) and
[`slack-integration.md`](slack-integration.md) hold those rules.

It does not own the repair applied to that string before it is parsed, either.
`MarkdownBody` calls `normalizeModelMarkdown` on its children so a model's TeX
becomes the characters it stood for;
[`model-text-normalization.md`](model-text-normalization.md) owns what that maps
and why it refuses to touch a price.

It does not own the markdown itself. Where a briefing's text comes from is
[`meeting-notes.md`](meeting-notes.md); a HyperSight block's is
[`agent-harness.md`](agent-harness.md); an automation overview's is
[`automation-drafts.md`](automation-drafts.md). It does not own the surrounding
screen either — a note's page geometry belongs to the note screen, and this
document has an opinion only about the part of it that is markdown.

It renders untrusted text: everything it is given was written by a model, a
meeting participant, or an inbound email. `react-markdown` does not evaluate HTML
in its input and no `rehype-raw` is configured, so markup in the source is text.
[`security.md`](security.md) owns the wider trust model.

The *protocol* is shared; the *rendering* is not. `@rally/contracts/citations`
holds the scheme allowlist, the footnote grammar, and the plain-text reduction,
because three surfaces have to agree on what a citation is and the cost of them
disagreeing is invisible until somebody reads an email. How a markdown string
becomes DOM is still this module's alone, and deliberately not shared:
Rally's outbound email has one shared converter,
`apps/api/src/services/email-markdown.ts`, for the reason
[`digests.md`](digests.md) records — a general markdown library emits far more
than an email client will honour. Every email surface renders through that one,
rather than growing a second.

The exported message card is the one place outside this stylesheet that styles
this DOM, and it is not an exception to the invariant above — it is a different
document. A saved picture or PDF is rendered in a hidden window that loads
`app.css` not at all, so it needs a full set of element rules of its own, written
for a light card rather than a dark application. What it shares is the markup:
`MarkdownBody`'s classes are its contract, so a class introduced here has no rule
there until someone writes one, and the miss shows up as an unstyled element in
the first card anyone looks at. [`message-export.md`](message-export.md) owns
that stylesheet and the reasoning behind not deriving it from this one.

## Failure modes and limits

**The citation grammar approximates CommonMark's link syntax with a regex.** It
matches the inline forms — balanced brackets in a label, an angle-bracketed
target, a title, one level of balanced parentheses in a destination — but not a
reference-style link (`[label][ref]` with a separate `[ref]: resource://…`),
which remark-gfm resolves and this leaves alone. The desktop draws that as a
chip and the delivery rewrite ships its raw target. No model has been seen to
write one, and the guidance teaches the inline form, so the gap is named rather
than closed with a second Markdown parser inside `@rally/contracts`. Whoever
needs it should parse rather than widen the pattern again.

- **A language Prism does not know** renders as `plain`. No error, no missing
  block.
- **A failed copy** leaves the button in its idle state. `copyText` rejecting is
  swallowed deliberately; there is nothing useful to tell someone whose
  clipboard is unavailable, and the code is on screen either way.
- **A `person:` href with no matching entry in `mentions`** renders as
  `span.mention-text-fallback` — the label as plain text. This is the expected
  path for a mention of someone who has since left the workspace.
- **A table wider than its surface** scrolls inside `.markdown-table-scroll`. It
  never widens the page, which matters most in the meeting rail, the narrowest
  surface that renders one.
- **A `color` set on a host does not reach the markdown.** `.markdown-body`
  declares its own, and a declaration beats an inherited value, so the colour
  stops at the wrapper. This is the one override that fails by doing nothing at
  all rather than by losing a cascade fight, which makes it the one most likely
  to be met with `!important` or a second `.markdown-body` rule — the divergence
  the rest of this document exists to prevent. A surface that genuinely needs a
  different body colour has to restate it inside the wrapper, and should say why
  in the same breath. `.note-detail-article` carried a dead `color` of this kind
  until 2026-08-12.
- **A `resource://` target that is malformed, unknown, or invisible to the
  viewer** renders as the citation's label text — no chip, no card, no anchor.
- **A footnote reference whose definition never arrived** renders literally,
  which is the existing behavior for a split footnote and is what streaming
  shows until the message settles.
- **A same-length fence nested inside another cuts the outer block while it
  streams.** The shared close rule closes a block on any run of the opener's
  character at least as long, info string or not, where this splitter used to
  demand a bare closer. Transient by construction: the commit that ends the
  stream re-renders the source whole. The rule and the argument for its
  looseness are in [`markdown-code.md`](markdown-code.md).
- **A preview the server is still preparing** is waited out rather than
  reported. Every *other* rejection from `GET /resources/:id/preview` — content
  that was never hydrated, an object that has since gone, a format the server
  will not convert — is terminal, and the panel says "This preview is not
  available." with the metadata above it untouched. A `resource_processing`
  answer carrying no usable delay is read as terminal too: the alternative is a
  retry cadence nobody chose, driving a route that converts documents.
- **A very long markdown string** is rendered in full. Nothing here truncates;
  the surfaces that need a cap impose it themselves, as the system-message clamp
  in `app.css` does.

## Testing

Two source guards and several component suites cover different failures — none
subsumes the others.

```bash
pnpm --filter @rally/desktop exec vitest run src/renderer/styles/app.css.node.test.ts
pnpm --filter @rally/desktop exec vitest run src/renderer/components/markdown-renderer.node.test.ts
pnpm --filter @rally/desktop exec vitest run src/renderer/components/workstream-blocks.test.tsx
pnpm --filter @rally/desktop exec vitest run src/renderer/components/attachments.test.tsx
pnpm --filter @rally/desktop exec vitest run src/renderer/components/citations.test.tsx
pnpm --filter @rally/desktop exec vitest run src/renderer/lib/use-citations.test.tsx
pnpm --filter @rally/contracts exec vitest run src/citations.test.ts
```

Both guards are `.node.test.ts` files: they read source off disk with `node:fs`,
which `tsconfig.node.json` keeps out of the renderer program. They read from
`process.cwd()`, so they must be run from the package directory —
`--filter … exec` already does that.

The traps, both of which have bitten:

- **The stylesheet guard reads selector preludes, not the raw file.** A search
  for the substring `.note-detail-article ul` misses
  `:is(.note-detail-article, .meeting-notes-body) ul` and
  `.note-detail-article > li`, which style the same thing. If you extend the
  guard, extend it against those forms.
- **A component test cannot see any of this.** jsdom lays nothing out, so a test
  asserting that a `ul` rendered passes just as happily when the list has no
  markers, sits at the wrong indent, or is invisible. Anything visible here is
  checked in a real window, per
  [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it), with
  a fixture that exercises the nesting — a three-level bulleted list alone
  exercises none of the `ol` selectors.

## Changelog

### 2026-08-28 — Copy reduces private citation targets before leaving Rally

**What changed:** The finished-turn Copy action now sends its Markdown through
the shared citation rewrite before placing it on the clipboard. Resource links
become their model-authored labels, while grounded footnotes become ordinary
numbered markers and a trailing source list, matching email and Slack delivery.

**Why:** A transcript citation is interactive only because Rally resolves its
`resource://` target against the loaded work stream. The clipboard crosses that
renderer boundary: pasted text previously exposed an internal URI that no
destination could open, even though the other outbound paths already reduced
the same protocol. Reusing the contracts rewrite keeps all non-Rally renderers
on one interpretation instead of adding a clipboard-only parser.

**What a future change has to respect:** Copy is an outbound citation surface.
It may preserve the message's Markdown, but it must reduce private schemes with
the same shared grammar as email and Slack before the text leaves the app.

### 2026-08-28 — A preview still being prepared is not a preview that failed

**What changed:** `ResourceContentPreview` in `inspector-rail.tsx` keeps the
typed `ApiError` its `.catch` used to discard, and on `409 resource_processing`
re-asks the preview route after the `retryAfterMs` the response named, under the
effect's existing `AbortSignal`. Every other rejection lands where it always did.
The read moved into `readResourcePreviewText`, which gives up once a wall-clock
budget derived from the server's own lease and converter timeouts would be
overspent.

**Why:** The preview route does not only fail terminally. A PDF or an Office file
attached moments ago has no text derivative yet, and the route says so with a 409
and a delay rather than a verdict — but the rail mapped every rejection to "This
preview is not available." So opening a citation to a freshly attached document
landed on the failed state and stayed there for the life of that mount, seconds
after the derivative was ready, and the reader had to close the rail and reopen
it to discover the preview existed. The whole point of dressing a citation is
that clicking it is worth doing; a dead end that is *wrong* is worse than the
metadata-only card the preview replaced. The wait is read off the response
because the route is the only party that knows what it is waiting for, and a
schedule invented in the renderer would be a guess wearing a constant's name.

**What a future change has to respect:** The `.catch` is the whole defect — a
rejection collapsed to a boolean cannot tell a verdict from a "come back in
250ms", and that is what made the failed state permanent. Anything added to this
path keeps the typed error until it has been read. `MAX_RESOURCE_PREVIEW_WAIT_MS`
is not a number this module chose: it is
`ATTACHMENT_PROCESSING_LEASE_MS + ATTACHMENT_CONVERTER_TIMEOUT_MS`, computed from
the two constants the derivative service enforces, which moved into
`@rally/contracts` in the same change so the client cannot drift from the server
that defines them. Their sum is the slowest case that still *converges* —
another request's claim running out its whole lease without publishing, then this
client's next attempt taking the stale claim and converting — and the lifecycle
half of that argument, including what happens past it, belongs to
[`agent-attachments.md`](agent-attachments.md), which owns the route. Read it
before changing the bound. It is wall clock rather than an attempt count
deliberately — the route's two cadences differ fourfold, so a count bounds
nothing a reader can feel — and enforcement takes the budget as a parameter so
the deadline stays provable without a test spending it. The tempting rewrite is a
socket subscription in place of the poll; read the second invariant above before
attempting it.

### 2026-08-28 — The streaming splitter stopped deciding where a fence ends

**What changed:** `FENCE_OPEN` and `FENCE_CLOSE` are gone from
`workstream-blocks.tsx`, and `splitStreamingMarkdown` reads `markdownLineKinds`
from `@rally/contracts/markdown-code` instead. Its cut rules, its list handling
and the `settled.join('') + tail === source` property are untouched.

**Why:** this splitter held one of five copies of the same question — where does
a block of code start and end — and the copies did not agree with one another.
The commit before this one collapsed the three inside `citations.ts` onto a
private classifier; [`markdown-code.md`](markdown-code.md) records moving that
classifier somewhere the other four could read it.

The rule the splitter gave up was its **strict** closer: it required a closing
fence's rest-of-line to be bare, where the shared rule accepts any run of the
opener's character at least as long, whatever follows it. That was a real
choice, not an accident, and it was given up rather than kept because a
disagreement between five rewriters about where a block ends is the defect, and
the cost here is the cheapest of them: measured against a vendored copy of the
old function over 104,976 documents, 195 differ, all of that one cause. In each,
a same-length nested fence cuts the outer block in two while the message
streams, and the commit that ends the stream re-renders it whole. The Slack
chunker made the opposite call for the opposite reason — a severed block in a
delivered message has nothing to heal it — and is deliberately still outside the
shared module.

The splitter reads only the *fence* kinds, not the classifier's indented-code
answer. A fence is a block boundary in this function's model and an indented
chunk is not; `CONTINUES_ACROSS_BLANK` already refuses to cut before an indented
line, so there was nothing for the extra kind to buy here.

**Consequences:** where a block ends is one edit with seven readers now, and the
number that matters — how much of a streaming reply is re-parsed per commit — is
unchanged, since neither the cut rules nor the memo chain moved.

### 2026-08-28 — One answer about what is code, indented blocks included

**What changed:** The three passes over a document in `@rally/contracts/citations`
— the reference scan, the definition strip, and the body rewrite — read one
`codeLines` classifier instead of carrying a fence state machine each. It
recognises indented code blocks as well as fences, under CommonMark's rule that
an indented chunk cannot interrupt a paragraph. The link pattern also accepts one
level of balanced parentheses in a destination.

**Why:** An indented block is the other ordinary way a model shows this syntax,
and the rewrite was deleting it — `    See [the deck](resource://abc).` arrived
in an inbox as `    See the deck.`, silently editing the example being taught.
The scan had the matching half of it: a `[^1]` inside an indented block earned a
number, so a real footnote beside it was renumbered against the transcript. That
is the same defect the inline-span fix closed a commit earlier, one syntax over,
which is the argument for the three passes reading one answer rather than three
agreeing ones. The paragraph rule is the part that cannot be skipped: without it
a lazily-indented continuation line reads as code and a real `resource://` target
leaves Rally, which is the failure the module exists to prevent.

**What a future change has to respect:** `codeLines` is the only place that
decides what code is, and a pass that grows its own copy reintroduces the class
of bug this removed. Erring toward "this is code" is safe for the *rewrite* and
unsafe for nothing else — except the paragraph rule, where it inverts: a
continuation wrongly called code is a leak, not a redundancy.

### 2026-08-28 — A citation keys on the id GFM wrote, and a section is never deleted blind

**What changed:** The renderer derives a footnote identifier by undoing GFM's
percent-encoding before it looks one up, and the trailing section's guard gained
a `numbers.size > 0` term. `resource:` and `connector:` scheme tests are now
case-insensitive, like `person:` and `https:` already were.

**Why:** GFM writes `${clobberPrefix}fn-${normalizeUri(id.toLowerCase())}` and
this module keyed by the plain text, so the two agreed only while every
identifier stayed ASCII. `[^café]` and `[^100%]` are ordinary model output — the
guidance teaches numeric identifiers without constraining them — and the
disagreement did not merely lose the pill: the reference fell through to a
classic anchor while the section guard, reading the unencoded keys that *did*
match each other, dropped the whole footnote section. The source left the
message. That is the same content loss the saved-card fix closed, still open in
the transcript, and it is why the guard now refuses to fire on an empty map at
all: the next divergence should cost a redundant list, not a vanished one.

**What a future change has to respect:** The identifier in the DOM and the
identifier in the grammar are two spellings of one thing, and remark-gfm owns
the transform between them. A change that reads an id out of the DOM without
undoing that transform reintroduces this exact bug in whatever it reads.

### 2026-08-28 — A saved card keeps its sources, and the grammar reads what GFM reads

**What changed:** `MarkdownBody` gained a `still` flag, set by the saved-card
path alone: a still render keeps the footnote pills and stops dropping the
trailing source list. In `@rally/contracts/citations`, the footnote reference
scan now reads a line with its code spans removed, and the inline-link pattern
matches what remark-gfm matches — a label carrying one level of balanced
brackets, an angle-bracketed target, and a trailing title. The Citations section
above also lost a paragraph describing a workspace-wide resolution tier that had
already been removed from the code.

**Why:** Three defects, each invisible from inside the surface that had it.
The saved card is the artifact people keep, and it hides the popover on purpose
— a hover box printed into a PNG has no way to dismiss it — so lifting every
definition left a card whose claims carried numbers pointing at nothing. Keeping
the list only in a still is the narrowest fix: the transcript's reclaimed
vertical space is the whole point of the lift, and a picture has no scroll to
spend it on. Separately, a `[^1]` inside a code span was counted as a reference,
so a message *explaining* the syntax was delivered with an invented source list
under it, and any real footnote alongside it was renumbered — the transcript said
1 where the email said 2, which is precisely the disagreement the shared
ordering exists to prevent. And a link the renderer drew as a chip but this
pattern did not match reached an inbox as raw `resource://` syntax; the three
forms it missed are ordinary CommonMark, so the pattern had to be as wide as the
parser it describes rather than as wide as the examples in the guidance.

**What a future change has to respect:** The reference scan and the rewrite must
agree about what is code — they share `INLINE_CODE_SPAN` for that reason, and a
second spelling of it is a numbering bug nobody will see until they compare an
email to a transcript. Widening the link pattern further means widening what the
delivery rewrite reduces, which is the safe direction; narrowing it is how a raw
scheme leaks out of Rally.

### 2026-08-27 — Citations render as chips, cards and footnote pills

**What changed:** `MarkdownBody` gained a citation layer. Link and image syntax
carrying a `resource://` target render as an inline chip and a block embed card;
a GFM footnote whose definition is one paragraph with exactly one link renders
as an inline numbered pill with a popover and no trailing list entry. The
dispatch is a typed matrix keyed by scheme and position rather than a branch in
the `a` override, and it now covers `img`, `li` and `section` as well. The
protocol — the scheme allowlist, the footnote grammar, and the plain-text
rewrite for outbound email and Slack — moved into
`packages/contracts/src/citations.ts`, shared with those two surfaces.
`react-markdown` and `remark-gfm` are pinned exactly, footnote ids are
namespaced per mount, and `ResourceIcon` moved here from the inspector rail so
one mapping serves both.

**Why:** Two pains, one proven mechanism. The terminal-generation sibling
publishes documents the chat could only talk about in prose — the affordance
was off in the rail, and a collaborator scanning the transcript had nothing to
click where the document was named. And a grounded answer showed nothing about
which claim leaned on which source, which on a multiplayer surface means "go
check for yourself" is a re-read of everything. Mention chips were already the
proof that a bracketed-scheme protocol is squarely inside what models emit
reliably, so citations are one more scheme on that mechanism rather than a new
message type. The rejected alternative, a dedicated message type with a card,
costs a wire enum, cache and dispatch branches, and version-skew handling on
every client to deliver what a link already carries.

**Consequences:** Two visual defects were found in the real window and not by
any test, which is the reason that pass exists: the pill first rendered as a
coloured speck no reader could tell from another, and it was drawn with
`brand-ink` on a solid tint — the pairing written for a *tinted* ground, washed
out on a solid one. A marker at superscript size needs the brand's own
on-colour and a heavier weight than an inline chip does. A future scheme is
three type errors, not three places to
remember — that is the reason the matrix is a table. Two cells are load-bearing
and easy to "fix" wrongly: `image` × `https` stays a real image, because that
syntax is live and means what it means everywhere, and `link` × unknown keeps
the default anchor, because that cell is where `mailto:` and `tel:` live. The
citation context travels by React context specifically so it stays out of the
memoised component config; putting it in a prop would silently restore the
whole-body re-parse the streaming segmentation exists to prevent, and the
streaming-cost test is what would catch it. The pinned dependency versions are
now part of the contract: the footnote DOM is read by attribute and class name,
so unpinning them reintroduces a failure that shows up as citations quietly
becoming superscripts. Shipped in
[#381](https://github.com/juno-ai-labs/avalon/pull/381). Design:
[`docs/PRDs/2026-08-27_inline-resource-citations/prd.md`](PRDs/2026-08-27_inline-resource-citations/prd.md).

### 2026-08-23 — A code block gets a header bar instead of a floating button

**What changed:** `MarkdownCodeBlock` now renders a `.markdown-code-block-header`
row above the highlighted code — the fence's language on the left, the copy
button on the right — instead of overlaying the button on top of the `pre` at
`position: absolute`. The exported message card's stylesheet moved its
`display: none` for the button from `.markdown-code-block > button` to
`.markdown-code-block-header button` to match, and now also declares
`.markdown-code-block-header { display: block; }` so the card keeps the
label-above-code layout its `.markdown-code-language` rule already assumed.

**Why:** The floating button sat at a fixed offset from the block's own edge,
not the visible edge of whatever the reader had scrolled the code to. On a
block with a long line, that put the button over the code's own text, legible
only after scrolling horizontally past the text into the empty space beyond it
— the opposite of discoverable. A header outside the scrolling `pre` is
reachable at a fixed position regardless of scroll offset, and it also gave the
block a place to put the language, which nothing had shown before.

**Consequences:** `codeLanguageLabel` adds a second lookup beyond
`markdownLanguageAliases`: a display name a reader recognises ("TypeScript",
"HTML") rather than the fence's own shorthand or Prism's internal name. A
language neither table knows is title-cased from the fence word, the same
fallback `markdownLanguageAliases` already uses for highlighting. The
`data-language` attribute on `.markdown-code-block` is unchanged — it stays the
fence's raw lowercased word — so nothing reading that attribute needed to
change.

A fence that names no language gets no header label at all, rather than the
"Plain text" every one of `data-language`'s internal defaults would otherwise
surface — review caught that an unlabelled fence, the most common kind in a
transcript, was rendering a caption ("PLAIN TEXT", uppercased by the header's
own styling) nobody wrote and nothing asked for. `MarkdownCodeBlock` now reads
whether a language was actually named off the raw prop, before it is defaulted
to `'plain'` for highlighting and for `data-language` — those two stay
unaffected, since the default is applied after the label decision rather than
instead of it. The exported card's `.markdown-code-language` rule also picked
up `display: block`: it is a `<span>`, and the `margin-bottom` the rule already
declared is a no-op on an inline box, so the label sat flush against the code
with none of the gap the layout was written to have.

### 2026-08-23 — The renderer repairs a model's TeX, and stops emitting a dead mention link

**What changed:** `MarkdownBody` passes its children through
`normalizeModelMarkdown` before `react-markdown` sees them, so `$\rightarrow$`
renders as `→` — unless the caller marks the text `verbatim`, which the human
message bubble and the attachment lightbox do, because a member's own words and
an attached file's bytes are not a model's to fix. And every `person:` href now
survives `urlTransform` so the `a` component can decide it: a real id resolves
to a chip, anything else renders as `span.mention-text-fallback`.

**Why:** Several of the models Rally routes to write TeX when they want a
symbol, and this renderer has never rendered any — so the delimiters and the
command name were shown to people verbatim, in the surface they read most. The
repair is shared rather than local because the digest email had the identical
gap, and separate copies of it would drift the way the three renderers this
module replaced did. [`model-text-normalization.md`](model-text-normalization.md)
owns the mapping and, more importantly, the rule deciding what is math.

The mention fix came out of auditing the same path. `defaultUrlTransform`
empties a scheme it does not recognise instead of rejecting it, so a malformed
`person:` link became `<a href="" target="_blank">` — a chip-shaped thing that
opens a blank window. The first attempt guarded inside the `a` component,
which is unreachable: react-markdown rewrites hrefs during its tree visit,
*before* components render, so the guard saw `''` and the dead anchor still
shipped. Review caught it by rendering; the fix is in `urlTransform`, the only
place the scheme still exists — mirroring how `connector:` already passes
through whole for the component to refuse.

**Consequences:** Normalization runs *after* `withConnectorMentionLinks`, and the
order is load-bearing: connector mentions carry offsets measured against the
stored text, and normalizing first shifts a slice off its `@` and silently
drops the chip. The call site says so and points at the module document.
Nothing here rewrites what is stored — a turn still exports and re-reads as the
model wrote it, and the Copy button deliberately copies the stored bytes while
the export file name takes the repaired first line.

Shipped in #257.

### 2026-08-23 — A streaming body re-parses its tail, not its length

**What changed:** `MarkdownBody` gained a `streaming` mode: the source is
split at settled-block boundaries (`splitStreamingMarkdown`) — blank-line
boundaries plus, after review caught list-dominant replies settling nothing
at all, per-item cuts inside top-level same-marker lists — and every settled
segment renders through a memoised component, so a commit that appends
streamed text re-parses only the open tail. Cuts are decided only at complete
lines, which is what makes the settled prefix unconditionally stable as text
arrives character by character. A settled body's rendered element is also
memoised on its source, so commits elsewhere on the screen skip finished
messages entirely. Both `mentions` parameter defaults were hoisted to one
`NO_MENTIONS` constant.

**Why:** The paced reveal ([`streaming-reveal.md`](streaming-reveal.md))
commits up to once per painted frame, and the whole-body re-parse made that
cost O(reply length) per commit. Measured in the running client: at 20,000
characters the pre-change renderer spent ~27s of a 30s window in long tasks
and painted at 17fps — and a plain-text control at the same length painted at
59fps with zero long tasks, which is what attributed the entire length-scaling
cost to this pipeline. After segmentation the same measurement shows 57fps and
zero long tasks, flat from 500 to 20,000 characters.

**Considered and rejected:** Rendering the streaming message as plain text
until the turn settles — cheapest and seamless-proof, but the reply would
visibly snap from unformatted to formatted at completion, and live markdown is
the norm this product is judged against. A second react-markdown mount for the
streaming path was never on the table; the mode lives inside `MarkdownBody`
and the single-renderer guard still passes.

**Consequences:** While a message streams, its rendering is an approximation
healed at completion: a settled list item renders as its own single-item list
(numbering preserved via `start`; a loose item renders tight until the turn
settles), and reference-link or footnote definitions later in the stream do
not reach earlier segments until the settled re-render. The memo chain is
identity-fragile by nature — the `NO_MENTIONS` hoist exists because a `= []`
default two components up silently restored the whole-body re-parse,
observable only as client-side jank — and
`workstream-blocks-streaming-cost.test.tsx` pins the cost ratio for a
heading/paragraph/fence body *and* a list-dominant one, because the second
shape is exactly the one the first version of the splitter silently missed:
its every candidate blank-line cut point is a list line, so it settled zero
segments and kept the whole-body re-parse at the paced commit rate.

Shipped in #258.

### 2026-08-13 — A saved message is this renderer's DOM, rendered off-screen

**What changed:** Saving one of Rally's turns as a picture or a PDF renders
`MarkdownBody` into a detached React root and takes its markup, rather than
sending the markdown anywhere to be rendered again. An eighth call site, and the
first that never mounts in the document.

**Why:** The alternative was a markdown library in the main process, where the
card is assembled. That is the drift this module exists to prevent, and it would
have been the worst instance of it yet: the divergence would only ever be seen by
whoever received the file, long after it was sent.

**Consequences:** `MarkdownBody` is now serialized as well as displayed, so it
must stay renderable outside a screen — nothing in it may depend on layout,
measurement, or an ancestor's styling to produce correct markup. The exported
card carries its own element stylesheet against these class names; the boundary
section says why that is not a second copy of the `.markdown-body` group, and
[`message-export.md`](message-export.md) owns it.

### 2026-08-12 — Attachment documents join the shared renderer

**What changed:** The full-window attachment lightbox sends Markdown files and
the semantic derivatives of PDF and Office attachments through `MarkdownBody`.
Plain text is intentionally excluded and rendered literally in a monospace
`pre`, while images keep their intrinsic dimensions until the window requires
scaling.

**Why:** Message-feed attachments beyond images had no readable surface, and the
existing server-side derivative already expresses document structure as
Markdown. Mounting another Markdown library inside the lightbox would recreate
the renderer drift this module exists to prevent.

**Consequences:** Attachment Markdown receives the same tables, code, links,
list markers, and trust boundary as every other surface. Lightbox geometry may
style the `.attachment-lightbox-document` host, but Markdown element styling
still belongs only to `.markdown-body`.

### 2026-08-12 — One markdown renderer, so there is one place to fix markdown

**What changed:** The note detail screen and the meeting Control Tower briefing
render `MarkdownBody` instead of mounting `ReactMarkdown` themselves. The
per-container marker, list-geometry, and first/last-child rules those two
surfaces carried are gone; `.markdown-body` owns all of it. Each keeps exactly
one override — a note's descending heading scale, a briefing's flat one — and the
stylesheet test asserts that neither host states any other markdown element
styling. This document was created in the same change, because until then
markdown rendering had no document and its history was accumulating in
[`workstream-creation.md`](workstream-creation.md), whose scope is the create
path and explicitly not the screens a work stream is read on.

**Why:** The entry below restored the list markers by naming all three containers
in every rule. That worked and was the right shape for a fix under review, but it
left the underlying condition in place: three renderers, three copies of the
element styling, and no mechanism that makes a fix to one reach the others. The
copies had already drifted — list indents of 20px, 22px, and 26px, line heights
of 1.6, 1.65, and 1.68, none of it decided — and the reason the markers went
missing on two surfaces for as long as they did is that a reasonable person
fixing `.markdown-body` had no way to discover the other two. Converging is what
removes the next instance of that, not another exhaustive selector list.

**Consequences:** A note's body text is now `.markdown-body`'s `#dfded9` at
line-height 1.6 rather than `--ink-soft` at 1.68, and a briefing's is 1.6 rather
than 1.65. Those differences were drift, and collapsing them is the point; if any
surface ever wants its own again it should say so in one declaration and say why.
What must be respected: element styling for markdown goes in the `.markdown-body`
group and nowhere else. Overriding typography — a heading scale, a measure — is
still legitimate on a host, because that is a property of the surface rather than
of markdown; the two heading rules that remain are the model for it. Both screens
were checked in a real window against a fixture covering `h1`–`h6`, three-level
mixed `ol`/`ul` nesting, task lists, nested blockquotes, code in a list item,
tables, and `hr`.

Review caught two things about the two heading overrides that survived. They were
first written as `.note-detail-article :is(h1, …)`, which ties the shared scale on
specificity and wins only on source order — the exact hazard stated three
paragraphs up in this document, and the one the guard fails a list rule for. The
element was never the reason a competing rule is dangerous; the tie is. They name
`.markdown-body` now, and a test asserts they keep doing so, because prose is
what the guards in this change exist to replace. Pinning the source order with an
`indexOf` assertion was the alternative and was rejected: it preserves the
fragility and tests that nobody disturbs it.

And `.note-detail-article` kept a `color: var(--ink-soft)` that had stopped
reaching anything — the markdown takes `.markdown-body`'s colour, and the empty
state sets its own. It is gone, and the invariant that offered "a text colour" as
a legitimate host override is corrected, because a bullet promising an override
that silently does nothing is worse than no bullet.

The first version of the stylesheet guard searched the file for the substring
`<host> <element>`. Review pointed out that it misses
`:is(.note-detail-article, .meeting-notes-body) ul` and `.note-detail-article >
li`, which is to say it missed most of the ways to write the rule it existed to
catch. It reads selector preludes now. A guard written as a search for one
spelling of a mistake is worth roughly nothing, and reads as protection.

### 2026-08-12 — Markdown lists get their markers back, on every surface that renders one

**What changed:** `list-style` is declared for `ul` and `ol` under each of the
three containers that render markdown — `.markdown-body`, `.note-detail-article`,
and `.meeting-generated-notes` — with the nested levels and the task-list
exception restated alongside. A stylesheet test pins all of it.

**Why:** Tailwind's preflight sets `list-style: none` on every `ol` and `ul`, and
nothing took it back. The surrounding rules read as though something had — they
set the indent a marker needs and a colour for `li::marker` — so a bulleted list
rendered as indented paragraphs and a numbered one lost its numbers, everywhere
markdown appears. The work-stream message bubble entry in
[`workstream-creation.md`](workstream-creation.md) had reported this against the
`tw-fade` preflight, which was wrong; that sentence is corrected in place there,
and this entry is where the repair itself is recorded.

**Consequences:** Depth is counted in list ancestors of either kind, matching the
UA rules being restored: an `ol` holding a `ul` is a second level, not a first.
The three containers are named explicitly because they do not share a component —
two of them render `ReactMarkdown` under a class of their own, and a fix applied
only to `.markdown-body` looks complete while leaving them untouched. That is the
mistake this change was reviewed for, and the reason the test names all three.
The entry above supersedes this arrangement: there is one container now.
