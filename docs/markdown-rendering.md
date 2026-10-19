# Rendering markdown in the desktop client

Almost everything Rally shows a person is markdown a model wrote: a work-stream
turn, a meeting briefing, a note, an automation's overview.
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
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `MarkdownBody` — the only place `react-markdown` is mounted — and its component overrides: `MarkdownCode`, `MarkdownCodeBlock`, `MarkdownTable`, heading collapse, and the `a`, `img`, `li` and `section` renderers that hand a node to the citation matrix. Also the remark rewrites over the parsed tree: `remarkHtmlBreaks`, the opt-in human-message `remarkSoftBreaks`, and the streaming-only `remarkPendingCitations` that stands a skeleton where a footnote reference has no definition yet. |
| `apps/desktop/src/renderer/components/markdown-mermaid.tsx` | The asynchronous Mermaid SVG render, strict untrusted-input configuration, active-token configuration, and source fallback. Mermaid's module-wide configuration and render calls are serialized here so two diagrams cannot race one another's theme. |
| `apps/desktop/src/renderer/components/markdown-mermaid-theme.ts` | Maps Mermaid's rendering roles onto the active computed Rally design tokens. It owns no palette and does not branch on an appearance id. |
| `apps/desktop/src/renderer/lib/markdown-collapse.ts` | Which h2–h6 start a collapsible section, and which nested headings stay in the body. Shared by the renderer and the **Worked for** collapse-all control so they cannot disagree about the ids. |
| `apps/desktop/src/renderer/components/markdown-collapse.tsx` | The accordion chrome: chevron, 3-line preview, expand/collapse-all, and the React context that holds which sections a reader has closed while a later heading streams in. |
| `apps/desktop/src/renderer/components/markdown-citations.tsx` | The citation matrix — every scheme in every position — and the chip, embed card, footnote pill and identity card it renders. |
| `apps/api/src/routes/favicons.ts`, `apps/api/src/services/favicon-service.ts` | The authenticated binary favicon endpoint and its public-host validation, parallel domain-chain resolution, image sniffing, and 30-day platform KV entries. |
| `apps/desktop/src/renderer/lib/favicon-api.tsx` | Narrows the broad app-session context to the stable API capability link icons need, so unrelated session updates do not re-render every Markdown body. Detached exports receive no capability. |
| `apps/desktop/src/renderer/lib/host-favicon.ts` | What the two surfaces that draw a site's icon share: the hostname an HTTP(S) target names, and the request, its object-URL revocation, and a result that is *target*-scoped rather than merely mount-scoped — it is read only for the `{api, hostname}` it was fetched for, and dies with the URL it names. The markup is not shared — a link puts the icon in front of its text, a footnote marker puts it instead of its asterisk. |
| `packages/contracts/src/citations.ts` | The protocol itself: the scheme allowlist, the footnote definition grammar, the reference patterns every reader of raw `[^label]` text shares (`footnoteReferencePattern`, and `openFootnoteReferencePattern` for one still arriving), the image-syntax announcement scan, and the plain-text message rewrite that transactional email, Slack, and Apple push delivery send instead. |
| `packages/contracts/src/markdown-code.ts` | Which lines of a markdown string are code, which `splitStreamingMarkdown` and the citation rewrite both read rather than each deciding. See [`markdown-code.md`](markdown-code.md). |
| `apps/desktop/src/renderer/lib/use-citations.ts` | What a cited resource resolves to and where clicking one goes. |
| `apps/desktop/src/renderer/components/resource-action-menu.tsx`, `lib/breakout-resource-actions.ts` | The right-click menu a resource can wear, drawn from a host-supplied list, and the one list supplied today: **Attach to channel** on a Breakout's artifacts. |
| `packages/ui/src/styles/app.css` | The `.markdown-body` group: every element style markdown gets, and the `--markdown-*` paint properties each of those rules reads instead of a token. Also the one surface that re-points them — `.human-message-bubble .markdown-body`, which restates the whole group, and the highlighter's `syntax` roles with it, as percentages of the bubble's own ink. Also the host overrides: `.note-detail-article` and `.meeting-notes-body` (heading scale), the compact resource embed and intrinsic image treatment, and `.inspector-detail-document` (sizes the body and the host width to the rail, and restyles no markdown element). |

Nine call sites, all passing a markdown string as `children`:

| Surface | Call site |
| --- | --- |
| A work-stream turn, and the structured block above it | `workstream-blocks.tsx` |
| An automation's definition on its page | `screens/automation.tsx` |
| The Control Tower meeting briefing | `screens/meeting-notes.tsx` |
| A note's body | `screens/note-detail.tsx` |
| A Markdown or converted document attachment in the full-window lightbox | `attachment-lightbox.tsx` |
| A resource's readable content in the rail's detail | `inspector-rail.tsx`, reading through `lib/resource-preview.ts`. Hosted as `.inspector-detail-document` in the rail's own scroll, not in a boxed inner pane, and sized to the rail's column so long prose wraps to the panel instead of clipping. |
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

A completed `mermaid` fence instead renders as a diagram. It keeps the same
header and copy button as a code block, so the exact source remains available
without putting another control inside the SVG. Mermaid is configured with
`securityLevel: strict`, HTML labels disabled and its security settings locked:
the markdown is untrusted model or member input, so links, click handlers and
raw HTML are not diagram features here. Its generated SVG is the renderer's one
sanitised-markup insertion point. Render calls are serialized because Mermaid's
configuration is module-global. Each render starts from Mermaid's configurable
base theme and supplies concrete values resolved from Rally's active semantic
tokens: surfaces, text, borders, state washes, chart series, typography, radius,
and stroke width. Connections use `cmp.markdown.diagram-line`, which each theme
aliases to its strongest line-ramp step; actor and cluster outlines remain on
the quieter border roles. The SVG is regenerated when Rally's resolved
appearance changes, so light and dark modes use the same role mapping with their
own values.
The SVG keeps the natural width in Mermaid's `viewBox` instead of obeying its
generated `width="100%"`: wide diagrams scroll inside the code-block surface,
while scaling a sequence diagram down to a narrow message would make its labels
technically present and practically unreadable.
While a turn streams, the fence stays highlighted source. Parsing an open fence
on every reveal commit would start asynchronous work Mermaid cannot cancel and
would discard almost all of it on the next token; the settled turn renders it
once. A glance also keeps source because it lives inside a button, and a saved
still keeps source because export serializes `MarkdownBody` synchronously. A
parse failure says that the diagram could not be rendered and leaves that same
source visible rather than replacing content with an error graphic.

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

A GFM table cell cannot contain a real newline — that ends the row — so models
write `<br/>` inside one. Ordinary paragraphs pick up the same habit. Because
this renderer does not parse HTML, a remark pass after `remark-gfm` turns a
bare break tag (`<br>`, `<br/>`, `<br />`) from its mdast `html` node into a
`break`. Escaped and encoded examples remain text nodes and stay text. Code is
skipped. Every other tag stays as it was. The pass runs on every body,
including `verbatim`: this is a renderer affordance for one tag, not a repair
of what a model meant, and a stored document's table uses the same workaround.

### Human message line breaks

Human message bubbles opt into `preserveLineBreaks`. The `remarkSoftBreaks`
pass turns newlines in parsed text nodes into visible breaks, so Shift+Enter
and pasted multiline input still read as separate lines after sending.
Markdown paragraphs, inline formatting, mentions, and code retain their normal
structure. Newlines bordering a bare HTML break do not add duplicate breaks.
LF, CRLF, and CR line endings all produce the same breaks.
Paragraph edges do not add empty lines, and link labels stay text so mention and
citation resolution can recognize them. The option composes with both streaming
plugin lists, including the open tail's pending citations.

The composer queue deliberately keeps soft wrapping: it is a single-line clipped
preview, where multiline content would hide subsequent lines. Export controls
belong to agent replies and retain their Markdown behavior.

This is separate from `verbatim`: documents and agent replies keep
Markdown soft wrapping, while `verbatim` controls model-text repair.

### Heading collapse

Heading collapse is opt-in and enabled only by the main work-stream message
feed. There, every heading h2 and below is an accordion, one level deep. Every
other Markdown surface — the inspector rail, notes, attachment lightbox,
meeting briefing, and automation setup — renders headings fully
expanded. This keeps compact feed navigation from becoming a surprising
document-reader behavior. It also avoids borrowing `still`, whose citation
behavior belongs to exported pictures rather than interactive screens.

Where collapse is enabled, the section runs from that heading until the next
heading of the same or higher rank (lower number). An h3 under an h2 is content
of the h2, not a nested accordion — nested collapse is how a scan of the
document becomes worse than the scroll it was meant to shorten. An h1 is never
collapsible; it closes the open section and the title that follows waits as
preamble until the next h2+. Lead text before that first h1 is preamble too —
closing an h1 must flush it, or the bytes disappear from the reconstructed
source.

Headings inside code are ignored, through the same `markdownLineKinds`
answer the streaming splitter already uses. Headings inside a list item or
a blockquote stay in that container: `- Item 2\n---` is a list plus a
thematic break, not a setext h2, and `  ## heading` under a list item is
list content, not a section boundary.

When enabled, a section starts expanded: the state a section is in when nobody
has touched it is open, and the set the controller keeps is of the sections a
reader has *closed*. A closed section keeps its heading fully visible; its body shows
approximately the first three line-heights of whatever follows — a
paragraph, the top of a table, the start of a fence — behind an opacity
mask that starts at 60% on the first pixel and reaches transparent on the
last, so the content fades into the next heading rather than cutting off
as a hard clip. The chevron sits in a left gutter, coloured
with `sys.color.text.muted` (the receding control tone, the same token the
citation chip's icon uses), and carries a tooltip. Clicking the heading or
the chevron toggles the section; a click that follows a text selection does
not, so copying a heading does not collapse it.

Clicking the faded preview opens the section too, and only ever opens it:
a click inside an open body belongs to the text it landed on, never to the
accordion. The collapsed body is `inert`, which takes it out of hit testing,
so the click lands on the section itself rather than on the paragraph under
the fade — which is why the collapsed section, not its body, carries the
pointer cursor. A click that started inside the heading is left to the
heading, whose own rules decide when it should *not* toggle: a link in a
collapsed heading is followed without the section opening underneath it. The
chevron remains the keyboard and assistive-technology control; the preview is
a pointer affordance only, and adds no second button to the accessibility
tree.

A glance is already a four-line clamp inside a button, and a still is a
picture that cannot be toggled, so neither grows accordions. The exported
card therefore prints the document in full, without chevrons.

The **Speak** action likewise uses the complete stored Markdown source rather
than reading this collapsed DOM. Its server-side plain-text reduction and PCM
stream are owned by [`message-speech.md`](message-speech.md); collapse is only a
view state and must never decide which words are audible.

The collapse-all control lives in the agent-message header, immediately to
the right of **Worked for**. It expands or collapses every section in that
turn, and it offers **Collapse all** until every section is already closed:
a turn with some sections closed is a reader who has been folding, and the
action to hand them is folding the rest. New sections that stream in are open
regardless of that control's last action, because a heading that has only just
arrived is not one the reader has chosen to close.

Streaming keeps the existing settled-segment memo: complete sections
render as memoised chunks, and only the last section's body goes through
`splitStreamingMarkdown`. A collapsed section stays collapsed as its body
grows. Because collapse keeps one `react-markdown` mount per section even
after the stream settles, GFM footnote definitions and link-reference
definitions that live under a later heading are appended onto fragments
that do not already carry them, so a `[^1]` or `[text][ref]` in Claims
still resolves. The parse that already owns the definition is left
untouched — identity of the fragment string is the signal — and a
borrowed definition does not emit a second `.footnotes` list, which
would duplicate `fn-` ids with the section that actually wrote the
definition.

### Mentions

A person mention arrives as a link with a `person://<uuid>` href — bare
`person:<uuid>` is still accepted so stored transcript text keeps resolving.
A connector mention is minted at render time as
`connector://<token>:<type>` (bare `connector:<token>:<type>` still accepted)
and is *not* a citation scheme. `urlTransform` lets `resource:`, `person:`, and
those connector mention hrefs through untouched — everything else goes through
react-markdown's `defaultUrlTransform` — and the `a` override is where they are
decided. A `person:` / `person://` href resolves against the `mentions` prop and
becomes a `MentionChip`; a tokened connector href becomes a connector chip via
the identity path before the citation matrix. Neither is ever emitted as a
navigable link. Every other link renders as an external one, with
`target="_blank"` and `rel="noopener noreferrer"`.

The connector token is created once per mounted body, so a link keeps its
identity across re-renders and a `connector:` string that merely appears in the
model's text cannot impersonate one.

Rally itself has no stored mention identity: the composer inserts plain
`@Rally`. A body that passes `rallyMentions` (human bubbles only) runs
`remarkRallyMentions`, which turns each `@Rally` in a text node into a chip
with Rally's avatar, using the composer highlight's boundaries. It emits spans
through `hName` nodes, not a link, so there is no scheme for message text to
forge, and code and link labels stay as written.

The same pass draws a typed `@address`. That is how a message names somebody
invited to the Organization who has no account yet
([scope invitations](scope-invitations.md#invitees-in-the-people-pickers)), so
the address is the whole mention. GFM autolinks a bare address, so the pass
reads two shapes: `@address` in one text node, and an `@` closing a text node
followed by the `mailto:` link GFM made of the address, told from an
explicitly written `[a@b.com](mailto:a@b.com)` by its source span, since an
explicit link is never a mention. The reading lives in
`@rally/contracts/email-mentions`, and the composer uses the same one to decide
whom a message shares the conversation with, so an address in code or in a link
is neither a chip nor a share, and `@dana@example.com.au` never names
`dana@example.com`. Both shapes become a span
carrying `data-email-mention`, whose text is the address as written. The `span`
override resolves it against `EmailMentionContext`, which the Channel and
new-Channel screens fill from the roster and the invitees: a member who holds
the address draws as their person chip, an invitee as `.mention-chip-invited`
(an outline and muted italic address rather than a fill), and anybody else as the text.
Resolving at render rather than at parse is what turns the chip into the
person's name once they join, with nothing rewritten in the stored message.

### Web links and favicons

`remark-gfm` owns autolinking as well as tables and footnotes. A naked
`https://…` or `http://…` URL therefore reaches the same anchor renderer as a
named Markdown link; `www.…` is GFM's other literal form and receives an HTTP
target. Rally does not rewrite domain-shaped prose such as `docs.example.com`
without a scheme or `www.` because that is not a GFM autolink and guessing at
prose would create navigable destinations the author did not write.

When a message renders, every HTTP(S) anchor asks the authenticated regional API
for the hostname's favicon. The renderer never contacts the destination itself.
One `RallyApi` coalesces concurrent requests for the same normalized hostname.
Successful and missing responses require browser revalidation, which keeps the
30-day KV entry as the one cache clock instead of extending a nearly expired
entry in Chromium. The renderer displays returned bytes through a short-lived
object URL, marks the image presentational, and revokes the URL when the link
unmounts. A missing or failed favicon changes nothing about the link. Glances
remain inert text and synchronous still exports do not start asynchronous
decoration.

Markers are requesters in their own right, not free riders on the links: a
lifted definition's link is never rendered, so before markers wore icons those
hosts were fetched only when the body also linked them. The endpoint answers
`private, no-cache` and `RallyApi` coalesces only *in-flight* calls, so every
mount asks again and a miss is not remembered in the client — a scroll back
through a grounded answer in a virtualised transcript re-requests every marker's
host. The 30-day KV entry absorbs that, and this is deliberately not the place
to invent a client cache; `host-favicon.ts` is simply the one module that would
own a `Map<hostname, Promise<Blob | null>>` if the churn ever shows up as a
cost.

The API resolves a deep hostname and its registrable domain in parallel. The
exact host returns as soon as it produces an icon, without waiting for the
already-started primary-domain fallback; that fallback is registered with the
request execution context so its provider response and KV write survive the
early HTTP response. Intermediate labels are deliberately not scraped because
the product contract asks for the authored subdomain and the primary-domain
fallback. Each candidate asks the shared Firecrawl client
for uncached `branding.images.favicon` metadata, accepts only a public HTTPS
image URL, rejects image redirects, reads no more than Cloudflare KV's 25 MiB
value boundary through a stream limiter without retaining a second chunk copy,
and applies one team-selected 25-second deadline across branding discovery plus
the image response headers and body. It validates the bytes as an image and
stores either the icon or a confirmed miss in the dedicated platform-wide
`FAVICON_CACHE`. A transient
Firecrawl, network, rate-limit, or server failure is not negative-cached, and a
failure for one candidate cannot discard a valid result from the other. Each KV
entry expires after 30 days; the next read fetches and overwrites it, so no stale
generation is retained.

### Citations

A citation is the same mechanism as a mention pointed at content instead of an
identity, and it reuses every part of it: ordinary Markdown syntax, a custom
scheme through `urlTransform`, a component override that decides, and label text
when it cannot. What it adds is a second syntax form and a second position.

`[Title](resource://<id>)` renders as an inline chip.
`![Title](resource://<id>)` renders as a block embed card — image syntax, because
models place an image on its own line by training, so the card lands between
sentences with no renderer heuristic guessing where a block belongs. A run of
consecutive embeds — adjacent embed-only paragraphs, or several in one
paragraph — is merged by `rehypeCitationEmbedRows` into a single
`.citation-card-row`. Images, videos, and audio use square tiles with centered cover previews.
Other files retain horizontal cards. Standard CSS grid wraps and tiles all items
without hiding additional media. A lone embed keeps its paragraph. Audio includes
an on-demand inline player.
**The pass groups only what this render will actually draw as a card**: it is
given a predicate over the citation context's own resolver, so a surface with no
context, or a target this work stream does not carry, keeps the paragraphs it
already had rather than becoming a horizontal scroller full of sentences. It
also rewrites the root's children alone, so embeds inside a blockquote or a list
item stay a column — deliberately, because the placement bet is that models put
an image on a line of its own, and a pass that walked the whole tree would start
grouping across prose that happens to sit between them.
While a message streams, consecutive standalone resource embeds stay in one
Markdown segment, so settling the message preserves the image/file grouping.
Still exports retain every image as a titled file card, including every gallery entry.

An image embed reads its source bytes and renders in a square with centered
cover scaling, matching message attachment tiles. It shows
a shimmering media skeleton while those bytes load. Other resource kinds do
not fetch original bytes for feed decoration: audio and video use square tiles,
while sites, documents, and other files use 54px-high icon, filename, and kind
cards that fit two grid tracks. Clicking a `generated_file` or `generated_site`
opens the host's standard artifact inspector, with its artifact management
controls. Source files open the host's attachment preview; generated resources
are excluded from its galleries so stepping through source attachments cannot
bypass the artifact inspector. Feed excerpts still use the shared preview reader.

On a work stream, rendering or receiving an embed never opens the right-side
inspector automatically. The transcript stays where the person left it until
they click an embed, chip, or other explicit preview control. This applies on
initial load, reconnect, and while an agent response streams.

A GFM
footnote whose definition is one paragraph carrying exactly one link becomes an
inline marker with a hover popover, and its entry is dropped from the
trailing list; a definition that does not fit that grammar keeps classic
footnote rendering, and the section renders only what was left. In the common
all-citations case nothing renders at the bottom at all, which is the vertical
space the feature exists to reclaim.

**A web source's marker is the site's own favicon; everything else keeps the
asterisk pill.** The icon is the same one drawn in front of a link to that host,
requested the same way, so the two readings of one destination agree — and at
one character it is the only marker that can say *which* source before the
popover is open. It is decoration in the accessibility tree: the pill's own
`aria-label` still carries `Source <n>: <label>`, and the popover still names
the source and where it opens. Everything a favicon cannot answer for degrades
to the asterisk, in one direction: a resource or a person has no host, a host
has no icon, the request has not landed yet, the surface has no API to ask, or
the bytes that came back will not paint — the endpoint serves SVG among other
formats, so a good response can still fail to decode here, and the `<img>`'s
`onError` is part of the hook's contract rather than each caller's business.
The plate the asterisk sits on — tint, border, pill radius, raise and hover —
stays exactly as it is and the icon sits inside it, because a sentence citing a
web page and an internal document cites both the same way and a marker that
changed shape by target would read as two mechanisms. The icon is sized to the
box that is already there rather than the other way round, so the two markers
are identical in height and within a pixel and a half in width.

**In dark appearance the icon is given a ground of its own.** A favicon is
commonly a dark glyph on a transparent field, drawn for a browser's light tab
strip, and the plate is `text-default` at 16% — a few percent above the surface
in dark appearance, so the icon lands nearly black on nearly black. The ground
is `neutral-14`, the appearance's own high-contrast end, which in dark is the
near-white the artwork assumes; the plate's tint stays as the ring around it, so
the geometry does not move. It is deliberately not applied in light appearance:
the mirror case there is a *light* glyph on transparent, which a light ground
makes invisible rather than faint — which is what a browser's own light tab
strip does with the same file, and is a property of the artwork rather than of
this surface.

**While a turn streams, a reference whose definition has not arrived wears the
pill's own box with the marker not yet in it** — `.citation-pill-pending`, the
same tint, border, padding and raise as the pill, holding a shimmering block
whose width follows the asterisk glyph in the active font. What is under [Streaming](#streaming) is why it exists:
until the definition lands, remark-gfm reads `[^avalon]` as ordinary text, and
raw markup in the middle of a paragraph is the one thing a reader of a grounded
answer should never see. The skeleton is `aria-hidden`, because it names
nothing; the source reaches assistive technology when the pill arrives with its
label. It is drawn only while `streaming` is on: a settled reference nothing
ever defined keeps its literal marker, since there is no source coming and a
permanent skeleton would promise one.

The dispatch is a **matrix, not an if-chain**: three
`Record<CitationScheme, …>` tables, one per position, so a scheme added to the
protocol is a type error until somebody has decided what it looks like as a
link, as an embed, and as a source. Two cells are worth knowing about:

- **`image` × `https` is a real image**, deliberately — except in the embed
  card's glance, which reduces it to alt text. Markdown images render today
  and the CSP permits them, so hijacking that syntax as a web-citation card
  would collide with the model legitimately embedding an image. The glance is
  a four-line hint inside a button, and loading the URL would tell the host
  the card painted.
- **A glance keeps mention chips and drops every other link to its text.** A
  `person:` or connector href still goes through `renderIdentity`, because a
  chip is a span with no destination and is valid inside the card's button.
  The Channel feed's thread summary is a glance, and its names are the point
  of it.
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

**A resolved chip, embed card or media tile can carry a right-click menu.** The
citation context's optional `actions` lists what it offers per resource; with no
list, and always on a still, the element renders untouched. Today only a
Breakout fills it, with **Attach to channel** on its generated artifacts
(`lib/breakout-resource-actions.ts`); the
[changelog](#2026-09-24--a-resource-citation-can-carry-a-hosts-right-click-menu)
has why.

A citation rendered into a **still** — the saved card — keeps numbered pills
instead of asterisks or icons, so they identify entries in its trailing source
list. A still is rendered synchronously and photographed, so it asks for no
icon at all: one arriving after the shutter is an empty box in the file somebody
keeps. Lifting a definition trades the list for a popover,
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

`react-markdown` and `remark-gfm` are pinned to exact versions, with no automated
guard keeping them that way. The footnote DOM those two
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
heals when heading collapse is off: each settled list item renders as its own
single-item list while the message streams (ordered numbering survives via the
`start` attribute; a loose item renders tight — without its paragraph wrapper
— until the turn completes), and a reference link whose definition arrives in a
later segment renders literally until then. The commit that ends the stream
renders the source whole again.

A **footnote** reference is the one seam that does not wait, because the wait is
too long to look at. A model writes `[^avalon]` mid-sentence and the
`[^avalon]: [file](resource://…)` that defines it at the bottom of the answer,
so remark-gfm reads the marker as text for most of the turn's life and the
reader watches raw `[^avalon]` sit in a paragraph. Two hoisted plugin lists —
`STREAMING_REMARK_PLUGINS` for a settled segment, `STREAMING_TAIL_REMARK_PLUGINS`
for the open tail — add `remarkPendingCitations` on top of the settled list, and
it replaces such a marker with the pending pill above. The tail's variant also
covers the reference that is still being *typed*: the document's last text leaf,
when it ends in a `[^` whose bracket has not closed, which is the same raw
markup arriving one character at a time.

That rewrite asks the document no questions and reads no definitions, which is
what keeps both lists hoisted constants that the settled segments' memo can
compare by identity. A reference this parse *can* resolve is already a
`footnoteReference` node and never reaches a text node, so "still a `[^…]` in
the text" is exactly "not resolved here" — decided by the parser rather than
restated. Code is skipped for free: an inline span and a fenced block hold their
source as their own `value`, not as text children, so a message explaining
footnote syntax grows no skeletons. Where the pill actually resolves *before*
settle is the collapse path below, which copies definitions onto the fragments
that do not carry them; that is the path the main transcript takes.

**A text node is the decoded run, so the rewrite checks it against its own
source span before believing it.** `\[^avalon]` and `&#91;^avalon]` both reach
a plugin as the characters `[^avalon]` — micromark consumes the escape and the
entity before any transformer runs — and covering those would put a skeleton
over syntax somebody escaped in order to *show*, then take it away at settle
when the whole source is re-parsed and the escape is honoured.
`undecodedPrefixLength` compares the node's characters against
`source.slice(start, end)` and returns the length of their common prefix: the
point up to which nothing has been decoded. A match ending at or before it came
from literal characters; a match reaching past it is left alone.

**A prefix, not a verdict on the run** — and the difference is a flicker, not a
nicety. A run-level verdict drops a real citation's skeleton because an escape
appears *later in the same paragraph*, which while streaming means the skeleton
is drawn and then reverts to raw `[^avalon]` as the escape arrives behind it.
With a prefix, whether a match qualifies depends only on the text before it,
which has already arrived and cannot change, so a skeleton drawn once is never
taken back. What a prefix gives up is the case where an escape *precedes* a real
citation in one run: everything after the escape keeps its literal marker.
Buying that back means mapping a decoded offset through the escape, which is a
second decoder to keep in step with micromark's.

**The bare `[` at the end of the tail is dropped, not covered.** One character
in, the stream has not said whether it opens a citation, a link, a task list's
box, or nothing; a skeleton there would flash a pill in front of every link,
and leaving it puts a citation's opening bracket on screen for a frame. Showing
nothing until the next character decides is the only answer that is right
whichever it turns out to be, which is why `openFootnoteReferencePattern`
matches the bracket alone and the caller — not the pattern — decides that a
bare one draws nothing.

When collapse is on, that whole-document re-parse cannot happen — each
section is still its own mount after settle — so definitions are copied
onto fragments that do not already contain them. A reference whose
definition has not arrived yet still renders literally, matching the
streaming seam; once the definition exists anywhere in the document, every
section parse can see it.

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

Every paint in that group is a substitution rather than a token reference:
`.markdown-body` declares its rule-local properties — `--markdown-ink`, its one
stronger step and its three quieter ones, `--markdown-wash`,
`--markdown-surface`, `--markdown-rule`, `--markdown-quote-bar`,
`--markdown-border`, the two link roles, and the two GFM affordances that are
painted without being text, `--markdown-mark` for a task box's tick and
`--markdown-scrollbar-thumb` for the bar under a wide table — from the
appearance's own tokens, and every element rule reads one of those.

The indirection is there because not every markdown surface sits on the
appearance's canvas. A person's turn is drawn on a filled bubble — near-black in
the light appearance, mid-grey in the dark one, or the sender's profile colour —
carrying whichever of the two absolute palette inks that fill takes. A ramp step
knows nothing about that fill, and the bubble had been patching over the
consequences one element at a time: two rules forced `p`, `strong`, `em`, `code`
and `a` to the bubble's foreground and left the chip behind
`.markdown-inline-code` on `neutral-4`, so a `/goal` in a message was a
near-white word on a near-white chip. The heading, the quote bar, list markers,
a table's cells, a thematic break, a ticked task box and a wide table's
scrollbar thumb each had a quieter version of the same problem. The fenced block
did not: it carried its own `surface-raised` ground, which is why it now opts
out below rather than joining them.

So a surface that fills itself re-points the group — `.human-message-bubble
.markdown-body` does, from `currentColor` — instead of restating element rules.
Percentages of the bubble's own ink contrast by construction whichever fill is
underneath, which is what the mention chip and the in-flight sweep on the same
bubble already do, and an element added to the group is painted correctly on
every surface the day it lands. They compound where a parent is itself a tint:
a chip inside a blockquote is 14% of the quote's 82%, which is a quote receding
as a whole.

**A fenced block opts out, and takes the whole group back to the appearance.**
Both kinds of contents it can hold are resolved from the root and cannot follow
a surface: `markdownCodeTheme` hands the highlighter inline references to the
`syntax` group, and `readMermaidThemeConfig` resolves a diagram against
`document.documentElement` once per window. Painting the panel from the group
instead costs contrast exactly where the quietest roles live — a language label
on the dark appearance's default bubble measured 2.93:1 against the 4.14:1 the
appearance's own panel gives it, and 2.00:1 on a saturated profile fill — so the
block re-points `--markdown-ink` and its quieter steps, `--markdown-wash`,
`--markdown-surface` and `--markdown-border` back to the appearance's tokens,
its header included. The cost is that a code panel inside a coloured bubble
reads as a panel from somewhere else; that is the arrangement this group found
and deliberately kept.

A surface hosting `MarkdownBody` may override typography — a heading scale, a
measure — because that is a property of the surface. It may not restyle a
markdown element, and it paints by re-pointing the group rather than by naming
an element. Two surfaces take the exemption: a note reads as a document
page and steps its headings 22/17/14, the meeting briefing sits in a narrow
rail beside a transcript and holds every level at 15px. Compact resource rows
no longer contain a markdown glance or its heading override.

Each writes the heading exemption as `<host> .markdown-body :is(h1, …)`, naming
the shared container even though the host alone would select the same elements.
That is deliberate. `.note-detail-article h1` ties `.markdown-body h1` at
(0,1,1) and wins only by sitting lower in the file, so the override would
survive exactly as long as nobody split the stylesheet or moved a block. With
`.markdown-body` in the selector it is (0,2,1) and the question does not arise.
The embed card goes one step further: the feed already paints `.markdown-body`
at (0,3,0), so the preview names `.citation-card` and the wrapper's `div` to
sit at (0,3,1). Block margins and list markers recede through `*` and
`::marker` rather than by naming `p` or `li`. A host override that cannot be
written this way is a sign it is not a typography override.

## Invariants

- **`react-markdown` is mounted in exactly one place.** A second mount is a
  second renderer, and the styling written for the first will not reach it. This
  is not hypothetical: it is what happened, and what the surfaces that had it
  looked like was *nothing* — no error, no visual break, just a list without
  markers that nobody connected to a CSS change made elsewhere.
- **A bare break tag is the only HTML that becomes an element.** `<br>`,
  `<br/>`, and `<br />` parsed as `html` become a `<br>` element; escaped or
  encoded examples stay text, and a tagged `<br class="…">` and every other
  element stay characters. Widening the pattern is how this becomes an HTML
  parser. Code is not rewritten. The pass runs on `verbatim` bodies too — it is
  not TeX repair.
- **Markdown element styling lives in the `.markdown-body` group and nowhere
  else.** A rule like `.note-detail-article ul` ties `.markdown-body ul` on
  specificity, so which one applies is decided by which is further down a
  3,000-line file. Nobody editing a screen's styles is thinking about that.
- **A host may override typography, not elements.** The distinction is whether
  the declaration describes the surface or the markdown. A heading scale and a
  measure describe the surface; a list indent, a code background, and a table
  border describe the markdown. Text colour is on neither list: a surface that
  needs different paint re-points the group below, and one that does not fill
  itself has no business changing it — see the failure modes below.
- **Markdown paint is a group, and only a surface with a fill of its own
  re-points it.** Every element rule reads `--markdown-*`, never a ramp step, so
  the whole of markdown can be moved onto another ground in one block. The
  bubble's block is that block; a host copying it without filling itself is
  restyling markdown with extra steps. Re-point the whole group when you do it:
  half a group is how the inline-code chip stayed on the neutral ramp under ink
  the bubble had already forced to near-white, and no automated
  test compares the two sets of names, so check them in a real window.
- **A host override wins on specificity, not source order.** Name
  `.markdown-body` in the selector. Anything relying on being further down the
  file is a regression waiting for the next person who splits a stylesheet, and
  it fails silently and visually, which is the combination this module has
  already been bitten by once.
- **A mention link is never navigable.** `person:` / `person://` and
  render-minted `connector:` / `connector://` hrefs survive
  `urlTransform` only so the `a` override can turn them into chips or, failing
  that, into inert text. If one ever reached the DOM as an `href`, a model would
  be choosing a destination. Connector is not a citation scheme; chips go
  through the identity path before the matrix.
- **A connector chip requires this render's token.** Without it the link is text
  someone wrote rather than a mention Rally minted, and it renders as a
  fallback span.
- **A citation that cannot be resolved renders as its label text, and nothing
  else.** A chip adds an affordance, never disclosure: the label is the model's
  own words, already in the message. This is also what an unauthorized target
  renders as, which is why it is indistinguishable from one that does not exist.
- **`urlTransform` passes citation schemes plus connector mention hrefs, in two
  positions.** `resource:`, `person:` / `person://`, and `connector:` /
  `connector://`, on `a[href]` and `img[src]`. Everything else goes through
  `defaultUrlTransform`, which empties what it rejects. Widening this is how a
  model-chosen destination reaches the DOM.
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
`mentions` array, an optional `citations` context, and `glance` / `verbatim` /
`still` / `streaming` / `collapseHeadings` / `preserveLineBreaks` flags — plus the citation matrix and
`ResourceIcon`, which the inspector rail and the work-stream sidebar render too
so that one resource kind draws one glyph everywhere. **It takes the resource,
never a type string**, and calls the exported `resourceIconType` itself: a
provenance type (`generated_file`, `uploaded_file`) says who made the resource
rather than what it is, and only that function replaces it with the attachment
kind its MIME and filename classify to. A caller holding a raw `resourceType`
cannot see that a `generated_file` carrying the site manifest is a live site.
The glyph is then chosen by substrings of that one name, with a published site
matched whole ahead of the chain — under both `generated_site` and `site` — and
drawn as a Tabler `app-window`. Heading collapse is off unless a host explicitly
sets `collapseHeadings`; the main work-stream feed is the intended opt-in host.
Its collapse-all control is a sibling in the agent-message header and shares
section ids with the body through `MarkdownCollapseController`.

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
[`meeting-notes.md`](meeting-notes.md); an automation definition's is
[`automation-lifecycle.md`](automation-lifecycle.md). It does not own the surrounding
screen either — a note's page geometry belongs to the note screen, and this
document has an opinion only about the part of it that is markdown.

It renders untrusted text: everything it is given was written by a model, a
meeting participant, or an inbound email. `react-markdown` does not evaluate HTML
in its input and no `rehype-raw` is configured, so markup in the source is text.
The first closed exception is a bare `<br>` / `<br/>` / `<br />`, rewritten to
a real line break; that is not HTML parsing, and a tagged `<br class="…">` or
any other element stays characters. Mermaid is the generated-markup exception:
it receives only a `mermaid`
fence, runs in strict mode with HTML labels and interaction disabled, and
inserts the SVG Mermaid sanitised. Invalid input falls back to source.
[`security.md`](security.md) owns the wider trust model.

The *protocol* is shared; the *rendering* is not. `@rally/contracts/citations`
holds the scheme allowlist, the footnote grammar, and the plain-text reduction,
because every rendered and outbound surface has to agree on what a citation or
person mention is, and the cost of them
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
- **A Mermaid parse that rejects** renders a short failure line and the original
  highlighted source. Mermaid does not write its own error SVG into the page.
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
  declares its own — now `var(--markdown-ink)` — and a declaration beats an
  inherited value, so the colour stops at the wrapper. Re-pointing
  `--markdown-ink` is how a surface says it meant it; inside a filled bubble
  that value is `currentColor`, which is the one spelling that does resolve back
  to the host's ink. This is the one override that fails by doing nothing at
  all rather than by losing a cascade fight, which makes it the one most likely
  to be met with `!important` or a second `.markdown-body` rule — the divergence
  the rest of this document exists to prevent. A surface that genuinely needs a
  different body colour has to restate it inside the wrapper, and should say why
  in the same breath. `.note-detail-article` carried a dead `color` of this kind
  until 2026-08-12.
- **A fenced block does not follow its surface**, per the styling section
  above: it is an island of the appearance, so a code panel or a diagram inside
  a coloured bubble is drawn in the window's colours on the window's ground.
  The alternatives were a per-surface syntax palette, which for Mermaid means
  deriving its whole role set — surfaces through chart series — from one ink,
  and reducing a fence to the surface's ink at three strengths, which reads well
  on a dark fill and measured 2.00:1 for a comment on a saturated one.
- **A `resource://` target that is malformed, unknown, or invisible to the
  viewer** renders as the citation's label text — no chip, no card, no anchor.
- **A footnote reference whose definition never arrived** renders literally on a
  settled message — the honest rendering of a reference to nothing. While the
  turn is still streaming the same marker is a pending pill instead, on the bet
  that a definition is still coming; the commit that ends the stream is what
  turns an unkept promise back into text.
- **An escaped or entity-written marker** — `\[^1]`, `&#91;^1]` — renders
  literally in both, streaming included. So does a real reference that *follows*
  one in the same text run, which is the deliberate cost of the prefix rule; it
  is the rendering that surface had before the pending pill existed, not a new
  degradation. A real reference *before* the escape keeps its skeleton.
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

Several component suites cover different failures — none subsumes the others.

```bash
pnpm --filter @rally/desktop exec vitest run src/renderer/components/workstream-blocks.test.tsx
pnpm --filter @rally/desktop exec vitest run src/renderer/lib/markdown-collapse.test.ts
pnpm --filter @rally/desktop exec vitest run src/renderer/components/attachments.test.tsx
pnpm --filter @rally/desktop exec vitest run src/renderer/components/citations.test.tsx
pnpm --filter @rally/desktop exec vitest run src/renderer/lib/use-citations.test.tsx
pnpm --filter @rally/contracts exec vitest run src/citations.test.ts
pnpm --filter @rally/api exec vitest run test/favicon-service.test.ts test/firecrawl-web-tools.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/favicon-runtime.test.ts
```

Both guards are `.node.test.ts` files: they read source off disk with `node:fs`,
which `tsconfig.node.json` keeps out of the renderer program. They read from
`process.cwd()`, so they must be run from the package directory —
`--filter … exec` already does that.

The favicon service's Node suite proves selection, caching, validation and
failure policy against provider doubles. The workerd route test keeps Firecrawl
and the image origin doubled but uses the real KV binding and execution context:
it verifies binary metadata round-trips and that the primary-domain fallback is
registered with `waitUntil` before the exact-host response returns.

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

### Annotation source positions

`MarkdownBody` accepts `sourcePositions` for artifact selection. A rehype pass
retains parser offsets on blocks and rendered text; code tokens preserve their
source span through the existing code renderer. This mode pairs with `verbatim`
so the selected bytes come from the displayed resource source. The normal feed
renderer keeps its existing parsing and code behavior. Source/range mapping and
restoration are owned by [artifact annotations](artifact-annotations.md).

## Changelog

### 2026-10-19 — Preserve source spans for artifact selection

**What changed:** Parser positions let active annotation previews quote original Markdown slices.

**Why:** Rendered list and emphasis nodes omit the exact syntax needed for source edits.

**Considered and rejected:** Visible-text searching is ambiguous for repeated words and markup, so the source mapper retains parser offsets.

**Consequences:** Transforms used while picking or restoring selections must preserve offsets; ordinary previews avoid the extra span rendering. See [artifact annotations](artifact-annotations.md).

PR #1322; design: `docs/PRDs/2026-10-19_artifact-annotations/prd.md`.

### 2026-10-19 — Generated files open with artifact controls

Citation clicks route `generated_file` resources to the standard artifact
inspector, alongside `generated_site`, and exclude them from source attachment
galleries. Generated Markdown previously opened a generic Attachment menu with
only Download and Details, hiding the artifact's management controls behind a
second click. Reusing the inspector keeps those controls in one place rather
than duplicating them in the attachment preview. Source attachment previews and
feed excerpts keep their existing readers.

### 2026-10-13 — A glance draws mentions as chips

**What changed:** In `glance` mode the `a` override routes `person:` and
connector hrefs through `renderIdentity` instead of flattening them to text.
The Channel feed's thread card renders its summary with `MarkdownBody` in that
mode, after `typedMentionRendering` rewrites the summary's typed `@Name`s into
`person://` links the way the send path resolves them.

**Why:** A thread's summary in the feed printed `@Casey Lane` as plain text
and raw Markdown, unlike the message it came from. The summary is stored
without its mention rows, so the names have to be found again before the shared
renderer can chip them.

**Considered and rejected:** A feed-only splitter that matched member names and
drew its own chip. It worked, but was a second renderer for message text that
would drift from this one, and drew no Markdown. Storing the opening message's
mentions on the thread summary would be exact, but needs a server and contract
change for a line the client can already resolve with the roster it holds.

**Consequences:** The feed card is the one glance today, and any later glance
draws mention chips too; anything added to the identity cells must stay a span with no
destination, or it puts a link inside a card's button. A summary's names are
only as good as the member roster: a guest, who has none, sees plain text, and
two members with one name resolve to neither, as they do on send.

Shipped in [#1212](https://github.com/juno-ai-labs/avalon/pull/1212).

### 2026-10-08 — A person's typed `@address` draws as a chip

**Changed:** `remarkRallyMentions` also turns `@address` into a span the `span`
override resolves against `EmailMentionContext`: the member who holds the
address, an invitee drawn muted, or the text as written.

**Why:** An invitee has no user, so their mention cannot be a `person://`
link, and a plain `@katherine@…` read as an address rather than a tag. The
address resolves at render so the chip becomes the person once they join.

**Considered and rejected:** An `invitee://` link through the `a` override.
It would widen `urlTransform`, the one gate that keeps a model-chosen
destination out of the DOM, for a mention that needs no destination. The
`mailto:` GFM makes of an address after an `@` is no longer drawn as a link in
a person's message, which is the price.

### 2026-10-05 — A person's typed `@Rally` draws as a chip

**Changed:** Human bubbles opt into `remarkRallyMentions`, which renders
`@Rally` as a mention chip with Rally's avatar (brand yellow "R" on a
near-black disc), matching the mention list.

**Why:** Person and connector mentions drew as chips while `@Rally` stayed
plain text, so the one mention that wakes the agent was the least visible.
Rally has no `MessageMention` row to resolve against, so the text match is the
mention; it uses the composer highlight's boundaries so what was highlighted
while typing is what draws as a chip.

**Considered and rejected:** A tokened `rally://` link through the `a`
override like connector chips. That needs the token inside a remark plugin,
which would stop the plugin lists being hoisted constants; `hName` spans need
no destination at all. Agent messages stay plain: a reply that tells someone
to "mention @Rally" is text about Rally, not addressed to it.

### 2026-09-24 — A resource citation can carry a host's right-click menu

**What changed:** `CitationContext` gained an optional `actions`, and the chip,
the embed card and the audio/video tile wrap themselves in the new generic
`ResourceActionMenu` when it returns anything. The conversation surface fills it
in a Breakout with one item, **Attach to channel**, for the Breakout's generated
artifacts; everywhere else it is absent and nothing changes.

**Why:** Work done in a Breakout stayed there: a site or document it produced
could be shared with the Channel only by re-creating it in Main. The server
already had the primitive — attaching an existing resource to Main, where the
new link grants the Channel's readers without touching the Breakout's — so the
missing piece was a way to reach it from the artifact. The menu is a list the
host supplies rather than an attach button baked into the card, so the next
per-resource action is an entry in a list, not another renderer change.

**Considered and rejected:** Copying the artifact into Main, which would fork
one resource into two that drift apart on the next version. A new server route
for "promote to Channel", which would duplicate the attach path and its checks.
Hiding the item once the Channel holds the artifact, which leaves a right-click
that does nothing and says nothing; it stays, disabled.

**What a future change has to respect:** the action list is keyed on what it
reads (resource ids and directions), not on the arrays, because a socket
snapshot replaces those unchanged and a new context identity re-renders every
citation on screen. Attaches run one at a time, with every item disabled while
one is in flight: each answers with the whole Channel detail, and two landing
out of order would drop one resource from the cache until the socket repaired
it. Radix's trigger prevents the event's default, which is what keeps the
message body's copy/speak menu from opening underneath; a wrapper that stops
doing so reopens that. A still never shows a menu.

### 2026-09-19 — A web source's footnote marker is the site's favicon

**What changed:** A lifted footnote whose target is an HTTP(S) URL draws that
host's favicon as its inline marker in place of the asterisk, through the same
authenticated endpoint and cache the link decoration already uses. It keeps the
asterisk pill's plate and sits inside it. The fetch,
the mount-scoped lifetime and the object-URL revocation moved out of
`workstream-blocks.tsx` into `lib/host-favicon.ts`, which both callers now
share; `favicon-api.tsx` stays what it was, the context that narrows the session
to one capability. Everything without a host, without an icon, or without an API
to ask keeps the asterisk, and a still keeps its numbers and asks for nothing.

**Why:** The asterisk is the same character for every source, so a grounded
paragraph with several of them says only *that* it is grounded; the reader has
to hover each one to learn which is the pricing page and which is the deck. The
mark for that already existed one position away — the icon in front of a link to
the same host — so the marker could carry it without a new request path, a new
cache, or any renderer egress. Two positions drawing one host's icon two ways
was the thing to avoid, which is what the shared hook now prevents.

**Considered and rejected:** Dropping the plate and letting the icon sit bare on
the line, which was built and looked at first — it reads as a cleaner mark on
its own, and as a different mechanism the moment a paragraph cites a web page
and a document in the same sentence, which is the common case. Also: sharing a
decorated `<img>` component rather than the hook, which cannot serve both
positions because the absent case is empty space in front of a link and a glyph
in a marker; and letting a still fetch icons, which would print whatever had
arrived by the moment the card was photographed. Also: giving the icon its
light ground in *both* appearances rather than only in dark, which reads as one
rule instead of a fork — rejected on the screenshots, because in light
appearance the case it would have to fix is a light glyph, which a light ground
turns from faint into invisible.

**Consequences:** The icon is decoration only — the source still reaches
assistive technology through the pill's `aria-label`, and the popover now also
names the host, so "which source" has an answer in words for a reader whose
glance did not land on the mark. `useHostFavicon` returns an `onError` alongside
the source, its result carries the `api` and `hostname` it was fetched for, and
that result dies with the object URL it names: a target that changes under a
mount React keeps, one that changes and comes back, a request that rejects, and
a blob that will not decode all degrade to the asterisk rather than leaving a
broken or empty plate where the marker belongs.

Shape and format are not special-cased: a non-square mark is letterboxed into
the square box by `object-fit: contain` rather than distorted or allowed to
change the plate, and an SVG blob paints like any other — with the `onError`
above as the answer for one that does not.

**One case is accepted rather than fixed:** a favicon that is a *light* glyph on
a transparent field, in light appearance, is a plate with nothing legible in it.
The ground that rescues the dark case makes this one worse rather than better,
and it is what a browser's own light tab strip does with the same file, so it is
a property of that artwork rather than of this surface —
[`using-company-brand-icons.md`](using-company-brand-icons.md) is where the same
comparison was run for connector marks, whose answer was to draw them in
`currentColor`, which is not available to a favicon. What keeps this from being
an invisible citation is the plate: the marker is still there to be found and
hovered, and the popover names the host. `app.css.node.test.ts` now guards both inline-icon rules — this one and
`.markdown-link-favicon` — because the margin collision below is invisible to
every DOM assertion. The icon rule is qualified as
`.markdown-body .citation-pill-favicon img` and sets `margin: 0`: the
block-image rule further down that stylesheet carries `margin: var(--space-4) 0`,
which on an icon inside a sentence grows the line box of every line in the
paragraph, and an unqualified rule ties it on specificity and loses on source
order. Sizing the icon under one em of the pill's own reduced type is what keeps
it inside the existing line box; a larger one would resize the plate and part
the two markers. A future surface that wants a host's icon takes the hook rather
than reimplementing the lifetime.

### 2026-09-19 — Markdown paint is a group a filled surface re-points

**What changed:** Every colour in the `.markdown-body` group is now a
substitution. `.markdown-body` declares fourteen rule-local `--markdown-*`
properties from the same appearance tokens the element rules used to name
directly — including the two that are painted without being text, a task box's
`accent-color` and the thumb under a wide table — and each rule reads one of
them. `.human-message-bubble .markdown-body` re-points all of them as
percentages of `currentColor`. A fenced block re-points them back to the
appearance. The two rules that forced `p`, `strong`, `em`, `code` and `a` to the
bubble's foreground are gone, and so is the `color` an agent turn restated.
Computed paint on every other markdown surface is byte-identical, checked
element by element in a real window before and after.

**Why:** A person's turn is the one markdown surface whose ground is not the
appearance's canvas: it is near-black in the light appearance, mid-grey in the
dark one, or the sender's profile colour, under whichever of the two absolute
palette inks that fill carries. An absolute ramp step cannot be right on a
ground the ramp has never seen, and the symptom was routine — a `/goal` in a
message was near-white text on a `neutral-4` chip, because the bubble had forced
the ink and nothing had moved the chip under it. Patching each element as
somebody notices it is how that state was reached, and the elements nobody had
noticed yet — a heading, a quote bar, list markers, a table's cells, a thematic
break, a ticked task box in the reader's accent rather than the sender's ink,
and a scrollbar thumb at `#2f2f2f` on a `#070707` bubble — were sitting in the
same bubble. The full catalogue is in the styling section above rather than
here.

**Considered and rejected:** Adding a third element override to the pair the
bubble already had, which is the fix that produced the bug and does nothing for
the next element. Promoting the group to registry tokens, which the appearance
files cannot express: what a theme has an opinion about is which colours exist,
not which of them a surface that paints its own fill should be using instead, so
these sit beside `--sweep-ink` and `--turn-bubble-radius` in the stylesheet's
own namespace. Reducing a fence to the surface's ink at three strengths, which
this change shipped first and review measured: a ground washed toward a
surface's own ink has less headroom for that ink than the appearance's ground
does, and a language label came out at 2.93:1 on the dark appearance's default
bubble and 2.00:1 on a saturated profile fill, against 4.14:1 before. A fence is
an island of the appearance instead — the arrangement that already existed,
kept deliberately this time, with the reasoning written down.

**Consequences:** A new element rule in this group names a `--markdown-*`
property, not a token, or it is wrong on the first filled surface it reaches;
`app.css.node.test.ts` scans for that directly, and its two exemptions — the
fence island and a failure notice's `danger-soft` — are the argued list a third
has to join. A role added to the group has to be re-pointed in the bubble's
block, which the same file's name comparison catches. Anything inside a fence,
highlighting and Mermaid alike, keeps the appearance's palette and needs no
per-surface mapping. The mixes are percentages of the ink rather than fixed
values, so a palette colour added to the product needs no rule here; they were
checked in both appearances against both default fills, a dark profile fill and
a light one, which are the two ink cases the palette can produce. Nothing
outside a bubble moved.


### 2026-09-15 — Non-renderer deliveries share one plain-text reduction

**What changed:** `rewriteMessageAsPlainText` now composes citation,
person-mention, and general Markdown reduction for transactional email, Slack,
and Apple push. A person mention
leaves Rally as its visible `@Name`, never as `[Name](person://<uuid>)`; each
surface still chooses whether its citation source list is Markdown, plain text,
or omitted.

**Why:** Email and Slack had independently composed the same two reducers, while
push sent stored message text straight to APNs. That made a Mac alert expose the
internal person link shown as a chip in Rally. Keeping the composition at the
protocol boundary makes adding another outbound surface a choice of source-list
shape rather than another chance to forget one internal syntax.

**Consequences:** Formatting punctuation such as headings, emphasis, strike,
code spans, and inline or reference-style link destinations does not reach
these plain-text surfaces. Escaped punctuation and intraword underscores remain
literal instead of being mistaken for formatting.
Lists retain their source depth. Fenced, indented, and variable-backtick inline
code retain literal content while their delimiters are removed, including a
multiline code span and a fence nested in a blockquote; only the enclosing quote
depth is removed from fenced or indented code content. Inline formatting may
cross a paragraph's soft line breaks and a list item's continuation lines.
Fences nested directly under list markers remain literal code. Reference definitions are removed with a
title continued onto the following line and when nested in a blockquote, but a
definition- or footnote-shaped line inside multiline code remains literal. The
renderer's supported `<br>` spellings become line breaks rather than literal
tags, and ATX headings accept CommonMark's three-space indent. Citation and
person-mention syntax inside code remains literal; prose references reduce to
their visible labels.
### 2026-09-15 — Web links carry the site's current mark

**What changed:** GFM literal HTTP(S) URLs and named HTTP(S) Markdown links now
share one favicon decoration. The authenticated API asks the existing Firecrawl
client for the exact hostname's and registrable domain's branding metadata in
parallel, prefers the exact-host result, validates the returned image, and
caches icons and confirmed misses in a dedicated Cloudflare KV namespace for 30
days before replacement. The desktop loads every message link and coalesces
concurrent requests by hostname.

**Why:** A naked URL and a named link are the same navigation affordance after
parsing, but only the text distinguished one site from another. Fetching in the
renderer would disclose every painted link to its destination and repeat the
same work on every device; one server-owned cache gives the platform a reusable
mark without widening renderer egress.

**Considered and rejected:** A client-side favicon request, direct page scraping
alongside the existing web provider, and caching by full URL. The first turns
rendering into third-party tracking, the second creates a parallel scraping
boundary, and the third stores duplicates even though favicons belong to hosts.
Parent fallback is concurrent rather than serial so a missing deep-host icon
adds no extra Firecrawl round trip before the primary-domain result can be used;
intermediate labels are not queried because they are neither endpoint the
product contract selected.

**Consequences:** Favicon discovery requires the regional `FIRECRAWL_API_KEY`.
Only public HTTPS image URLs returned by Firecrawl are fetched, and image
redirects are rejected rather than followed. Each complete candidate lookup is
bounded at 25 seconds, selected by the team to match Firecrawl's existing
branding scrape budget and stay inside Cloudflare's 30-second `waitUntil`
window; the same abort signal covers Firecrawl plus the image headers and body.
Transient failures are not stored as 30-day misses, a missing mark is silent,
browser responses revalidate against KV, and synchronous saved-message rendering
intentionally omits this live decoration. The existing GFM autolinker remains
the syntax authority and now has explicit regression tests for a naked URL and
for loading every message link without viewport bookkeeping.

### 2026-09-10 — A published site gets its own mark

**What changed:** `ResourceIcon` draws a Tabler `rosette-asterisk` for
`generated_site` and for the `site` attachment kind, checked as whole-string
membership before the substring chain rather than as another `includes` in it.
Its parameter changed with it: it takes the **resource** and calls
`resourceIconType` itself, where it used to take a `type` string each caller
derived — or did not. `resourceIconType` is exported for that, over the shared
`ResourceKindInput` shape both `CitationResource` and the rails'
`WorkstreamResource` satisfy. All four surfaces now pass the resource: the
inline chip, the embed card, the inspector rail, and the work-stream sidebar's
artifact list.

**Why:** A site fell off the end of the substring chain to the generic file
mark, so the one artifact kind that is a page somebody opens looked identical to
the ones they download — the sidebar showed a live site under the same sheet of
paper as a `.docx`. The chain itself is why the match is exact and comes first:
`includes('site')` would claim a `website` or `web_page` type that the `web`
branch below already answers correctly with a link mark.

Taking the resource is the other half, and it is not tidiness. Only the two
citation call sites ever called `resourceIconType`; both rails passed
`resource.resourceType` raw, so the `site` half of the match was unreachable
there. That is not a hypothetical gap: `assertKindTransitionAllowed` lets an
`archive → site` republish through by design, and `swapPublishedContent`'s
`UPDATE` rewrites `mime_type` without ever touching `resource_type` — nothing in
`apps/api/src` does — so a folder republished with an entry file stays
`generated_file` with the site manifest MIME. A live site, drawn as a file, in
the very rail this change set out to fix. The inspector rail disagreed with
itself over it: its `isSiteResource` classifies by MIME and opens the row as a
live page, beside an icon that called it a document.

**Considered and rejected:** Exporting `resourceIconType` and calling it at the
two rail call sites. Same pixels, but it leaves the trap armed — a fifth caller
with a `resourceType` in hand still type-checks, and this is the second time
that shape has produced this bug.

**What a future change has to respect:** Do not add a `type` escape hatch back
to `ResourceIcon`. Both names have to stay in the set: `resourceIconType`
resolves a `generated_site` to itself and a provenance-typed site to `site`, and
a site reaches the UI both ways — the sidebar test covers both, because a test
that goes through `MarkdownBody` alone exercises only the citation path and
passed throughout the window this was broken.

### 2026-09-09 — Human messages retain composer line breaks

**Changed:** Human bubbles opt into a shared renderer pass that turns text-node
newlines into breaks. Code nodes and existing hard breaks remain intact.

**Why:** A three-line composer draft appeared as one line after sending even
though its text retained the newlines. Markdown soft wrapping caused the loss
in presentation. Rewriting the submitted text would alter stored input;
changing every Markdown surface would change document formatting.

**Consequences:** Keep this opt-in distinct from `verbatim`, which also serves
attached documents. Full human-message readers should use the same rendering
mode; the composer queue intentionally remains a single-line preview.

### 2026-09-09 — Shared media tiles with host-specific layouts

Attachments and embeds share square media and horizontal file cards. Feed media
is 108px square, twice the 54px file-card height; the input uses the same
components at 54px in one scrolling row. Feed grids use media-sized tracks with
file cards spanning two tracks, replacing full-width file rows to tile mixed
content while keeping every delivered item visible. Image galleries retain all
entries and keyboard navigation; still exports retain every title.

This follows the requested compact media style and fixes layout changes when
consecutive embeds finish streaming. Fixed media dimensions supersede intrinsic
ratios, and the input's compact row deliberately differs from feed wrapping.
Video originals load only when opened; gallery placeholders do not fetch full
originals for thumbnails. Audio uses compact playback controls with full preview
available. Resource access remains checked against the current citation map.

### 2026-09-08 — A run of embed cards wraps instead of scrolling sideways

**What changed:** `.citation-card-row` no longer scrolls horizontally. It
wraps, a file card inside it takes the row's full width, and an image tile
keeps its intrinsic width.

**Why:** A run's third published file sat behind a horizontal scrollbar that a
reader had no reason to notice, so the message read as "here are two files"
when three had been delivered. The row was built for runs of image tiles,
where a column of 200-pixel tiles between two sentences was the problem; a
run of file cards has the opposite problem, and wrapping serves both: tiles
still sit side by side, files stack as a list with whole titles.

**Considered and rejected:** A column for everything, which brings back the
tile column the row was created to avoid. Keeping the 340-pixel card width in
the list, which truncates titles a full-width card shows whole; a lone card
keeps 340 pixels, since one card is not a list.

**Consequences:** The export stylesheet already wrapped this row, so a saved
message and the feed now agree. Anything that adds a third card kind to the
row says whether it stacks or tiles.

### 2026-09-04 — Explicit resource clicks use lightboxes

The right shell rail is parked. Artifact and citation clicks open a preview;
generated sites retain the dedicated native viewer in a resource lightbox.
File previews expose Resource details there, preserving versions and management.
Citation hints say "Opens in preview". Missing content shows an unavailable state
without download, and failed downloads report an error. New embeds never open a
panel automatically. Earlier rail-host history below does not describe current
navigation; the retained inspector content is shared with the lightbox.

### 2026-09-04 — Compact embeds replace glances, inline players and auto-opening, and inline chips share the explicit preview

**What changed and why:** The requested GrokBot presentation replaces the old
markdown glance and inline audio transport with compact file rows; images use
their intrinsic aspect ratio. Audio remains playable in the explicit preview.
An arriving embed no longer opens the inspector, including on initial load or
reconnect, because it must not take over the reader's window or scroll position.
These decisions supersede the earlier glance, recording-player, and auto-open
entries below; their historical rationale is retained rather than deleted.
Do not restore those feed surfaces as a fallback for failed preview loading.

Inline resource chips now pass their activating button to `openPreview`, like
block embeds. The previous branch still opened the right inspector for the same
resource, making placement change navigation behavior. Unsupported/unavailable
content and live generated sites retain the established inspector fallback.
Preview failure and still-render guards are tested with image resources that
actually enter the thumbnail-loading path.

### 2026-09-03 — A streaming citation is a skeleton, not raw `[^label]`

**What changed:** `MarkdownBody` renders a streaming body through
`STREAMING_REMARK_PLUGINS`, and its open tail through
`STREAMING_TAIL_REMARK_PLUGINS`; both add `remarkPendingCitations`, which
replaces a `[^label]` left sitting in a text node with a
`.citation-pill-pending` — the citation pill's own box, tint and raise, holding
a shimmering block where the number will be. The tail's variant also swallows a
`[^` whose bracket has not arrived. `SettledMarkdownSegment` takes its remark
list as a prop so the two lists reach it; both are hoisted, so the memo that
makes the paced reveal affordable is untouched. `citations.ts` now exports
`footnoteReferencePattern` and `openFootnoteReferencePattern` so the renderer and
the grammar cannot drift about what a reference looks like. The pill's shared
geometry moved into a two-selector rule rather than being restated.

**Why:** A footnote reference is only a reference to a parser that can already
see its definition, and a model writes the marker mid-sentence and the
definition at the bottom of the answer. For most of a grounded turn's life,
then, the reader watched raw `[^avalon]` sit in the middle of a paragraph — on a
long answer, most of the answer's lifetime, and the one place Rally shows
somebody its own markup. The pill's box was already the right shape to wait in.

**Considered and rejected:** synthesising a definition for the reference so GFM
would resolve it, which would have invented a source and renumbered the real
ones; and letting the plugin consult the message's definitions, which would have
made both lists per-render closures and re-parsed every settled segment each
time a definition arrived. The parser already answers the question — a reference
it resolved is not a text node — so the rewrite needs no knowledge of its own.

**Follow-up in the same change (bot review):** the first version trusted the
text node's value, which is the *decoded* run — so `\[^1]` and `&#91;^1]`, both
of which reach a plugin as bare `[^1]`, grew a skeleton over syntax that had
been escaped in order to be shown, and lost it again at settle. Each run is now
compared against its own source span. The open-tail pattern also grew the bare
`[`: it previously began matching at `^`, so the opening bracket of every
citation appeared for one frame, against this change's own claim. A bare bracket
draws nothing rather than a pill, because at one character it could equally be a
link or prose.

**Follow-up, second round:** that source check started as a verdict on the whole
run, and a live window showed what the tests had not — a real citation's
skeleton appearing and then *vanishing* mid-turn as an escaped marker streamed
in behind it in the same paragraph, which is the original defect arriving by the
other door. The check is now the length of the undecoded prefix, so a match is
judged only on text that has already arrived and a skeleton once drawn is never
taken back. The remaining give is a real citation that follows an escape in one
run; it keeps the literal marker that surface had before this feature.

**Follow-up, third round:** two review findings that were not defects are
recorded here so the next reader does not re-derive them. A tail ending
`…[^ava\n` is *not* missed by the end-anchored open pattern — remark strips a
paragraph's trailing newline, so the text node ends at the marker — and
`…[^ava more`, where text follows, is prose containing a bracket rather than a
reference being typed, which is why the anchor is right to reject it; both are
now pinned by tests. And the module-shared `FOOTNOTE_REFERENCE` is not a
`lastIndex` hazard: its readers use `matchAll` (which clones) and `replace`
(which resets), while `exec` — the one call that would advance it — always takes
a fresh copy from the factory. That rule is now written at the constant, because
it is the kind of thing a later refactor breaks silently.

**What a future change has to respect:** the skeleton is streaming-only. A
settled reference nothing ever defined must stay literal text, because a
permanent skeleton promises a source that is never coming; `still` and `glance`
never stream and so never draw one. And the pending pill's geometry is shared
with `.citation-pill` in one rule *because* the line must not move when the
number lands — restating the padding or the raise in a second rule is how that
starts twitching. Its inner block is about a digit wide, deliberately between
the narrowest figure and the widest, since a skeleton cannot know whether it is
standing in for `1` or for `12`.

### 2026-09-02 — The heading gutter is margin, so an answer is never indented

**What changed:** `.markdown-body:has(> .markdown-collapse) { padding-left: 20px }`
is gone. The heading chevron keeps its `left: -20px`, which now places it
outside the body rather than inside a strip the body had been padded to make
for it. Every line of an answer — headings, paragraphs, cards, code — starts on
the same left edge as the author line above it.

**Why:** That padding indented the *whole answer* by 20px, and only for answers
that happened to contain h2+ headings. So the column a reader scans down stepped
in and out from turn to turn, and an answer with headings sat 20px off the
"Rally" that introduced it. A gutter is the margin outside the text; putting the
text inside it instead was the defect.

**Considered and rejected:** Padding the author line to match, which would have
squared the two up by indenting more rather than less, and would have left the
feed's one text column starting at two different places depending on whether a
turn had headings.

**What a future change has to respect:** the chevron is now outside the content
column, so the transcript's left padding is load-bearing — it has to clear the
20px outdent *plus* the 3px this chevron's `:focus-visible` ring reaches beyond
its own box, and `.transcript-scroll` is `overflow-x: hidden`, so anything less
is cut off rather than scrolled to. Every padding on that column is currently
above that floor, but only because the `max-width: 760px` override was raised
from 18px to 24px in this change; it is the one to check when either number
moves.
The work accordion's chevron
([`plugin-activity-rows.md`](plugin-activity-rows.md)) hangs at the same offset
for the same reason; the two are meant to line up, and they do.

### 2026-09-02 — An announced recording gets a player, not its own bytes as text

**What changed:** Audio joins images on the raw-bytes preview path in
`useCitations`, and an embed card whose resource classifies as audio renders a
transport: a play/pause button in the badge slot, a played bar drawn from
`--citation-card-played`, an `m:ss` clock, and the title block as the button
that opens the rail. That card is a container rather than a single button, so
the whole-card hover moved to `button.citation-card:hover`. Starting one card
pauses whichever was sounding, and a card leaving the transcript pauses its own
element. The export stylesheet keeps the tile and drops the playback, since a
picture of a transport is a dead bar with a stopped clock.

**Why:** Every non-image resource went through the derivative reader, which
calls `Blob.text()`. An audio file has no readable derivative — the preview
route returns its bytes verbatim, the same answer it gives for an image — so a
card announcing a recording rendered a paragraph of replacement characters where
its glance belongs, under a title that said "Audio". Fixing only the decode
would have left the card a picture of nothing; what a reader wants from an
announced recording is to play it, and the rail already proves the bytes play by
handing the same blob to `<audio controls>`.

**Follow-up in the same change (bot review):** exclusivity moved from the `play`
event to the click, because `play()` is asynchronous and the earlier of two
quick clicks could come back and pause the card the reader had moved to; `ended`
now clears the request rather than leaving it pointing at a stopped element; the
play control gained `aria-pressed` to match the header's toggles; and the export
stylesheet's `.citation-card-open` moved below `.citation-card-text`, since the
open button carries both classes and their shared declarations were being
decided by source order.

**Follow-up in the same change (design):** the badge went back to the speaker
glyph and the play/pause control moved out of it, into a button under the bar
and the clock. The badge is what every card uses to say what it is, and spending
it on the one card's control both hid the kind and put the control above the
position it moves. That button is the shared `.icon-button`, so it matches the
header's icons rather than inventing a control shape for one card; only its
hover fill is resolved against the card's surface.

**Follow-up in the same change (review):** the object URL is held per blob and
the asking state merges rather than replaces, so a `resource_attached` arriving
mid-playback no longer returns a listener to 0:00; the card classifies with
`classifyAttachmentKind` rather than through the icon mapping, so a connector's
own audio file gets the transport instead of an empty room; and the transport's
reduced-motion answer moved *below* the rule it overrides, because a media query
adds no specificity and the earlier placement lost on source order.

**What a future change has to respect:** the card's container is a `span` and
everything in it is phrasing content, because a lone embed renders inside a
paragraph and the export reparses the serialized DOM — the first draft used a
`div`, which Chromium's parser lifted out of its paragraph and replaced with a
stray empty one, so the saved picture and the live turn disagreed. The card's
shape is decided from the *record*, not from the settled preview — deciding it on arriving bytes would
swap a button for a container under a reader who had already focused it. Keep
the two controls separately named; the accessible name of the play button is the
only place the playing state is announced, and it must keep following the
element's events rather than the click. Keep the played position in the custom
property rather than in a child element. A new class the card can emit needs a
rule in the export stylesheet — `message-export.test.ts` reads the class list off
this renderer and fails without one — and the track colour must be a fill token
rather than a line token: on the dark themes the line ramp is within a few
points of the card surface, and the empty bar disappeared. The transport is
deliberately not seekable; the rail's own `<audio controls>` is the full reader,
and adding a scrubber here means deciding it is worth the target size, not
merely that it is possible.

### 2026-09-02 — Clicking a collapsed preview opens its section

**What changed:** A click anywhere on a collapsed section's faded preview
expands it. There is no inverse: a click inside an open body does nothing, so
selecting or following text in an open section cannot fold it. The collapsed
section carries `cursor: pointer` so the preview reads as the control it is.

**Why:** The three faded lines are the part of a collapsed section a reader is
already looking at when they decide they want the rest, and the chevron is a
14px target in the gutter. Making the text they are reading the target removes
the aim without adding a control.

**What a future change has to respect:** the handler sits on the section rather
than on the body because the collapsed body is `inert` and so is not a hit
target; a handler on the body would never run. It is attached only while the
section is collapsed, which is the whole of the no-inverse rule, and it expands
rather than toggles so that a heading click bubbling into it cannot undo what
the heading just did. The heading check is the load-bearing one: without it,
the click that the heading deliberately declines to toggle on — a link in the
heading, or one that follows a text selection — would expand the section
anyway. It also stays out of the accessibility tree: the chevron is the button,
and a second control naming the same action would be read twice. The test
dispatches its click at the section rather than at the body, because jsdom
applies no CSS and lays nothing out: a click aimed at the body bubbles to the
section there and would pass with the handler on either element, while in a
real window only one of the two arrangements works.

### 2026-09-02 — Heading sections start open

**What changed:** `MarkdownCollapseController` now keeps the set of sections a
reader has *closed* rather than the set they have opened, so a section with no
recorded state renders expanded. The feed's first paint shows every heading's
body, the chevron starts rotated, and the header control starts as **Collapse
all sections**. A section that streams in after a collapse-all is open, the
mirror of the previous rule.

**Why:** Default-collapsed was chosen so a long streaming reply would land as a
scannable outline, but in the feed it hid the answer behind a click for every
reply, including the short ones where there was nothing to scan. Reading is the
common case and folding is the exception, so the exception is what a reader now
asks for.

The entry this supersedes gave a second reason, and it is the one that has to
be answered rather than outvoted: default-collapsed was "the right first paint
for a streaming reply, which would otherwise push the viewport by a full
section on every heading that lands". An open section is no longer clipped at
`3lh`, so that growth is now unbounded — but it does not land on the reader.
A transcript that is at the end follows the newest message as it grows
(`use-transcript-follow.ts`), and a reader who has scrolled away has released
that follow and sits *above* the streaming tail, which grows below them. The
push the earlier entry feared needed a viewport pinned mid-reply while the
content above it grew, and the transcript has no such state.
`estimateSize: () => 140` in `message-feed.tsx` is left as it was: it is the
guess for a row the virtualizer has not measured yet, `measureElement`
corrects it as each row renders, and a better number is one to set from what
rows actually measure rather than from this change.

**What a future change has to respect:** the stored set is *collapsed* ids —
membership means closed, and absence means open. Inverting it back is what
makes a streamed-in heading default the wrong way, because the id of a section
that does not exist yet cannot be in any set. Keep the collapse-all control's
`allCollapsed` derived from that set rather than tracked separately, or the
button and the sections will disagree after a stream appends a heading. That
control reads `allCollapsed` and not its opposite on purpose: the mixed state
is a reader partway through folding, and the pre-flip control answered it with
**Expand all**, which is the one direction they had just declined.

### 2026-08-31 — Image embed cards preview the image

**What changed:** An embed card whose resource classifies as an image keeps the
preview route's blob as image bytes and renders it in the card. The thumbnail
fills a fixed-height box with centered `object-fit: cover`; the card revokes its
object URL when the resource changes or the card unmounts. Its badge uses the
image glyph rather than the generic file glyph. Document previews remain
markdown glances on the existing conversion-and-retry path. Because Chromium
cannot decode Rally's supported TIFF and HEIF/HEIC sources, the preview route
normalizes those through the existing bounded image-conversion path before the
card receives them. Any remaining browser decode failure falls back to the
ordinary card instead of leaving a broken thumbnail, and off-screen thumbnails
defer decoding with native lazy loading.

**Why:** Image bytes were decoded as text by the generic document-preview path,
so PNG data appeared as replacement characters while the card still showed a
generic file badge. The route already returns the source blob and the inspector
already distinguishes images from readable documents; the embed needed the
same classification at the shared read boundary and in the shared resource-icon
mapping.

**What a future change has to respect:** keep the image preview presentational
so the card remains the only control and its accessible name remains the title.
Revoke every object URL, preserve centered cover scaling, and do not send
non-image resources around the derivative reader that waits out conversion. A
still does not fetch previews, so its fixed-light export stylesheet must keep an
explicit hidden answer for the image-preview class just as it does for text and
skeleton previews. Formats added to Rally's image allowlist must either be
browser-decodable or be normalized at the preview boundary; the renderer's
decode-error fallback remains required because metadata and bytes can disagree.

### 2026-08-30 — Heading collapse belongs only to the main message feed

**What changed:** `MarkdownBody` and the shared `MessageBlock` make heading
collapse opt-in. The main work-stream message feed enables it explicitly; the
inspector rail, automation setup, launch conversation, and every other Markdown
host inherit the fully expanded renderer. The rail still renders the file
verbatim through the shared Markdown and citation renderer, without heading
accordions, chevrons, or faded previews.

**Why:** Heading collapse was introduced for long transcript replies, where it
shortens the feed. Making it the shared renderer's default also collapsed
documents and secondary surfaces whose readers never asked for compact message
navigation.

**What a future change has to respect:** A new Markdown host stays fully
expanded unless it is part of the main message feed. Do not use `still` to
suppress collapse on an interactive reader; `still` changes citation behavior
for exported images.

### 2026-08-30 — A bare `<br/>` becomes a line break, in tables and in prose

**What changed:** `MarkdownBody` runs a remark pass after `remark-gfm` that
turns a bare break tag's mdast `html` node into a `break`. Tables and ordinary
paragraphs both get it; escaped and encoded examples stay text. Code is skipped.
`verbatim` bodies get it too. The
email renderer does the same rewrite on prose (after escaping, after parking
code spans) and turns the tag into a newline in the plain-text part.

**Why:** Models write `<br/>` for a line break inside a GFM table cell because a
real newline ends the row, and they write the same tag in body copy. The
renderer does not parse HTML, so those tags printed as characters — a
deliverables column that was meant to be a list became one wrapped run with
visible `<br/>` in it. Table-only would have left the identical glitch in
paragraphs; converting to a real newline *before* parse would have broken the
table the tag was holding together.

**Considered and rejected:** Enabling `rehype-raw`. That is an HTML parser over
untrusted model text, and the whole point of leaving it off is that markup is
characters. Also rejected: replacing the tag with a Markdown hard break in
`normalizeModelMarkdown`. A newline inside a table row is how GFM *ends* the
row. Also rejected: skipping `verbatim`. The inspector and the lightbox are
verbatim so TeX repair cannot rewrite a file; a break tag in that file is still
a line break the file asked for.

**What a future change has to respect:** this is a closed pattern — a bare
`<br>` with optional whitespace and optional slash, nothing else. Widening it
to other tags is how this becomes the HTML parser it is written not to be.
Do not put the rewrite into `normalizeModelMarkdown`; the table grammar cannot
survive a pre-parse newline. Email tables stay preformatted, so a break tag
inside one still shows as characters there — that renderer has no table model.

### 2026-08-30 — Mermaid fences render as diagrams, drawn in Rally's active tokens

**What changed:** A completed fenced block labelled `mermaid` renders Mermaid's
sanitised SVG in every live `MarkdownBody` surface. It retains the code-block
header and copy action, follows the current light or dark appearance, and falls
back to highlighted source when parsing fails. Streaming turns, embed glances,
and saved stills keep the source form. Mermaid runs with strict security, HTML
labels disabled, post-render links removed, and serialized configure/render
calls. Each queued job resolves the active tokens only when it starts; an
unmounted job leaves the queue before it initializes Mermaid or after its
resource preflight completes. Before parsing, the adapter applies Mermaid's
initialized and secured text-size ceiling. `accTitle` and `accDescr` become the
rendered image's accessible metadata; without them, the source remains available
as its screen-reader description. A source preflight rejects external CSS
resource functions in Mermaid style directives, and parsed flowchart image nodes
and block styles are rejected before rendering, because Mermaid can load them
while measuring or drawing. Labels remain ordinary text even when they contain
CSS-looking words. SVG styling may use local `url(#fragment)` references for
markers and gradients; parsed-style and output scans repeat the resource check
as defense in depth.

The Mermaid adapter resolves the active theme's semantic tokens into Mermaid's
base-theme roles instead of choosing Mermaid's generic `neutral` or `dark`
palette. The mapping covers common nodes and connections, sequence actors and
notes, states, tasks, requirements, chart series, font, radius, and stroke
width. A dedicated `cmp.markdown.diagram-line` component token keeps arrows and
message lines visible without promoting every diagram border to the same
emphasis.

**Why:** Mermaid syntax was already arriving in agent answers, but the generic
unknown-language fallback printed it as code — the failure shown in the product
was a valid sequence diagram presented as implementation text. The renderer is
the one markdown authority, so handling the fence there fixes work streams,
notes, briefings, attachments and dashboard blocks together. Rendering only
after a stream settles avoids launching an uncancellable asynchronous parse on
every partial line; keeping source in a still preserves the export path's
synchronous contract rather than saving a transient loading state.

Brightness-aware was not design-system-aware. The generic Mermaid themes
produced their own greys, borders, accent fills, typeface, and corner shape
inside a Rally code block, so the diagram looked embedded rather than native in
both modes.

**Considered and rejected:** a second markdown renderer or a rehype Mermaid
plug-in would split ownership or inject generated markup before the component
could preserve copy/failure behavior. Loose Mermaid security was rejected
because these diagrams are untrusted input and Rally does not need model-chosen
HTML, links or click callbacks. Dynamic-importing Mermaid was rejected by the
repository's static-import rule. Mermaid's published Tiny package was also
rejected: its own package documentation says it is a CDN artifact that is not
meant to be installed directly from npm, and using it through the bundler fails
at runtime.

For theming, per-theme configuration objects would duplicate the theme JSON and
require every future appearance to update component code. Broad CSS overrides
would couple the application to generated selectors that vary by diagram kind.
Resolving the already-active custom properties at the Mermaid boundary keeps
theme ownership in the token files.

**What a future change has to respect:** `mermaid.initialize` and `render` are a
single serialized operation because configuration is global. Do not expose
`bindFunctions`, loosen `securityLevel`, or let frontmatter re-enable HTML
labels or replace Rally's theme inputs. Keep the post-render link removal and
pre-render image-node and external-CSS-resource rejection, and keep the lifecycle
check before token resolution so recycled transcript rows do not spend work on
discarded diagrams. If saved diagrams become a requirement, make export await a
completed render; do not serialize a live component's loading state.

Do not add literal colours or theme-id branches to the Mermaid adapter. Map a
new Mermaid role to a design token, and inspect both lighting modes in
Electron; token names do not by themselves prove readable contrast. Keep
structural connections on the component line token and container outlines on
the quieter border tokens.

### 2026-08-30 — Connector chips use the `connector://` house form, leave the citation scheme, and show connection state

**What changed:** The desktop renderer mints per-render connector chips as
`[@Label](connector://<token>:<type>)`. The chip matcher accepts both that
spelling and the legacy bare `connector:<token>:<type>`. Shared helpers live
beside the person-mention ones in `packages/contracts/src/citations.ts`.

`CitationTarget` / `citationScheme` no longer recognize `connector:`. Connector
mention chips still pass `urlTransform`, but `CitationLink` routes them through
the identity path before the matrix; the matrix has no connector cell.

Inline connector chips gain a brand mark and an aggregate connection status.
Image-syntax `![Name](connector://<type>)` renders a horizontal card
(citation-card tokens, provider-card content) with personal and workspace
status. Connector chips and marks use neutral transcript surfaces; only
connection status carries success or warning colour. The compact card uses one
consistent inset and keeps its bare provider mark at the top left. The inline
chip omits the composer's leading `@`; stored text and offsets retain it. The
work-stream screen supplies live `/connections` data via
`ConnectorConnectionsProvider`. A still-loading or failed query supplies no
status, because an unresolved list is not evidence that a connection is
missing. Once resolved, every matching credential in a scope contributes to a
stable status and capability union. Google Mail/Calendar and Drive/Docs/Sheets
remain the real shared `google` connector type; the visible label selects the
capability family, so one bundle cannot claim that the other is connected.

**Why:** Person mentions and `resource://` citations already teach URL-style
schemes. Connector chips were the last bare-form holdout in the same render
path, and keeping two styles for adjacent identity schemes invites the same
generalization miss person mentions already hit.

Connector mentions are presentation minted from stored offsets, not something a
model cites. Keeping them in the citation allowlist forced every new scheme
position (link / embed / footnote) to invent a connector look, and conflated
two different protocols.

Offset-backed connector mentions were label-only text chips, so a reader could
not tell whether the named connector was usable. Resource embeds already set
the transcript card vocabulary; connector announcements reuse that surface
language rather than inventing a third card system.

**What a future change has to respect:** Emit through `connectorMentionHref`;
read through `connectorTypeFromMentionHref`. Stored messages still carry plain
`@Label` text plus offsets — only the render-time mint uses the scheme, and
chip minting still requires the per-render token; embeds use the bare
`connector://<type>` form. Keep connector href parsing in
`@rally/contracts/citations` so chip and embed syntax cannot drift.

Do not re-add `connector` to `CitationTarget`; identity routing stays ahead of
the matrix.

Status comes from the connections list, never from the message text. Treat the
list as unresolved until query data exists, and aggregate all same-scope
credentials rather than choosing the first.

### 2026-08-30 — Person mentions use the URL-style `person://` house form

**What changed:** New person mentions are authored as
`[@Name](person://<uuid>)`. The desktop chip matcher, email/Slack mention
reducers, and `isCanonicalPersonMention` accept both that spelling and the
legacy bare `person:<uuid>` so stored transcript text keeps resolving. Shared
helpers live beside the citation scheme allowlist in
`packages/contracts/src/citations.ts`.

**Why:** Guidance and `resource://` citations already teach URL-style schemes.
Keeping person mentions on the bare form meant every prompt that mentioned both
had to teach two styles, and models that generalized to `person://` produced
links the chip matcher and notification reducers silently failed to recognize.
One house form with dual accept is the same pattern `resource:` / `resource://`
already uses.

**What a future change has to respect:** Emit through `personMentionHref`; read
through `personIdFromMentionHref` / `personMentionMarkdownPattern`. A surface
that matches only one spelling reintroduces the chip/reduction miss for the
other.

### 2026-08-30 — Heading collapse keeps footnotes, list structure, and lead text

**What changed:** The splitter flushes lead text when an h1 arrives with no
section open, so preamble before the first title is not dropped. Setext
underlines after a list item (or blockquote) are not headings, and ATX
inside a list item is not a section boundary. Each section parse receives
GFM footnote and link-reference definitions that live elsewhere in the
document, without emitting a second footnotes list. Clicking a heading
after selecting its text no longer toggles the accordion. The collapse
controller keeps section-id identity with setState during render rather
than a ref write.

**Why:** Collapse splits the source into one `react-markdown` mount per
section, including after the stream settles. That is the shape streaming
cannot avoid — a rehype wrap cannot span segment boundaries — but it also
broke GFM's document-scoped definitions, which the pre-collapse renderer
healed by re-parsing the whole source. Independently, the h1 path moved
`cursor` without flushing when no section was open, so `Lead.\n\n# Title\n\n## Next`
lost `Lead.` and violated the reconstruct invariant. List-item setext and
indented ATX are CommonMark constructs the classifier's `prose` kind cannot
see, because it does not distinguish a list from a paragraph.

**Considered and rejected:** wrapping with a rehype plugin after a single
parse, which still cannot span streaming segments. Re-parsing the whole
document once the stream ends would restore footnotes but would throw away
the per-section memo the paced reveal is built on. Using `#000` for the
preview mask is still rejected: `app.css` cannot name that colour, and
`text-default` plus `mask-mode: alpha` is the token-legal equivalent.

**What a future change has to respect:** do not treat a heading inside a
list or a fence as a section. Appended definitions must not land on the
heading-only parse (that slot is the title, not the body). A nested
`MarkdownBody` reuses the parent collapse controller only when the section
ids match — the embed glance is `glance` and has none.

### 2026-08-30 — Headings h2 and below collapse, with a three-line preview

**What changed:** The main message feed asks `MarkdownBody` to turn every h2–h6
that is not nested under a higher-rank collapsible heading into an accordion.
Within that feed, the default is collapsed. The
heading stays in full; the body is clipped to about three line-heights with a
strong opacity fade. A chevron in the left gutter, in `sys.color.text.muted`,
carries a tooltip and toggles with a click on the heading. Nested headings
(an h3 inside an h2) are not themselves collapsible. A glance and a still do
not collapse. The agent-message header gained an expand/collapse-all control
immediately to the right of **Worked for**. Streaming keeps the settled-segment
memo: complete sections stay memoised, only the last section's body is the
open tail, and an expanded section stays open as later headings arrive
collapsed.

**Why:** Long agent replies are structured as a sequence of topics. Reading
one meant scrolling through every section in full, including the ones the
reader had already decided were not the topic. Hiding the body entirely would
make it impossible to tell a section from its title; a nested accordion under
every h3 would recreate the scroll, one click deeper. The three-line preview
is the compromise that lets a table or a paragraph identify itself without
opening. Default-collapsed is the right first paint for a streaming reply,
which would otherwise push the viewport by a full section on every heading
that lands.

**Considered and rejected:** wrapping with a rehype plugin inside a single
`react-markdown` tree. That cannot span the streaming splitter's segment
boundaries, so a heading in one settled chunk and its body in the next would
not be one accordion. Splitting the source into sections first, then
streaming only the last body, is what keeps the paced-reveal memo intact.
`<details>` cannot show a faded preview of the first three lines.

**What a future change has to respect:** do not nest accordions. The ids are
`section-${index}` and must stay stable as the source grows, or an expanded
section would snap shut when the next heading arrives. Do not put collapse
on a glance or a still. The chevron colour is `text.muted`, not a hardcoded
light-theme sample — that token is the receding control tone in every theme.
The collapse-all control is a sibling of **Worked for**, not a prop on
`MarkdownBody`, because the header is not inside the body.

### 2026-08-30 — The rail shows an image resource, and the document host joins the guard

**What changed:** An image opened in the inspector renders as an `img` in
`.inspector-detail-document`, sized to the rail, rather than last-updated over
an empty panel. The host joined the stylesheet guard that forbids restyling
markdown elements (not the heading-scale guard — this host has no heading
override). Future `capturedAt` values no longer fall through an unbounded
"this month".

**Why:** Dropping the metadata card removed the only signal an image had. The
rail is still not a lightbox; the image is the document analog of the markdown
body. The guard was the rule the changelog already named and did not enforce.

**What a future change has to respect:** do not style `img` (or any other
markdown element) as a descendant of `.inspector-detail-document`. Size the
image through `.inspector-detail-image` on the element itself.

### 2026-08-30 — The rail renders a resource as a document, not a card of one

**What changed:** `ResourceContentPreview` in `inspector-rail.tsx` dropped the
boxed, independently scrolling `.inspector-detail-preview`. The markdown now
lives in `.inspector-detail-document` under last-updated, and both move with
`.rail-scroll`. The host sizes the body (`font-size: 13px`) and restyles no
markdown element.

**Why:** A citation that opened the rail landed on a metadata card with a
preview window inside it. The box existed so **Remove** and **Refresh from
source** stayed reachable under a long file; those actions left the body
(archive is in the header, refresh stays above the document for sources), so
the second scroller was trapping the timestamp above a document nobody could
read as one.

**What a future change has to respect:** do not put `max-height` or `overflow`
back on the document host. A long file scrolls the rail. A heading-scale
override here would have to name `.markdown-body` the way `.note-detail-article`
does, and join that guard; sizing the container is the allowed exception.

### 2026-08-30 — The embed card glance leaves the markdown intact and nests no controls

**What changed:** `previewExcerpt` no longer collapses blank lines. The nested
body is `MarkdownBody glance`, which renders links as their text, images as
their alt, and fenced blocks without a copy button. Block margins zero through
the existing descendant `*`, and `::marker` inherits the glance's tone.

**Why:** collapsing blank lines was a plain-text trick. Once the string is
parsed, those blanks *are* the block grammar — two paragraphs became one,
a paragraph above `---` became a heading, and the sentence after a list was
swallowed into its last item. The clamp's seams belong in CSS (`margin: 0`),
not in the source. `inert` on an `aria-hidden` glance also made the "no nested
control" tests unable to fail: `queryAllByRole` ignores hidden subtrees, while
a fence still put a real `<button>` inside the card's `<button>`. Glance keeps
those nodes out of the DOM. An external image in the derivative would fetch
from a URL the document chose merely because the card painted; alt text does
not.

**Why not name `p` / `ul` / `ol` for the margin reset:** a host may override
typography, not markdown elements, and the stylesheet guard exists to keep
that from quietly coming back. `*` is a measure of the four-line box, the
same way it already carries colour.

**What a future change has to respect:** do not reintroduce the blank-line
collapse to "spend the clamp on text"; the seams are CSS. Do not assert
absence of nested controls with `queryAllByRole` on an `aria-hidden` node.
A glance must not grow a copy control, an `<a href>`, or an `<img src>`
for a URL the derivative named.

### 2026-08-30 — The embed card kind is the file, and the preview type is normal weight

**What changed:** a generated or uploaded file's kind label classifies from MIME
and filename (`Document`, `Deck`, `Spreadsheet`, …) instead of printing
`Generated file`. The preview's weight moved from `sys.label.weight` (560) to
`normal` (400).

**Why:** `generated_file` is provenance, not a kind a person can tell cards
apart by — every published file is one. The attachment-kind vocabulary already
answers "what is this file", and "Deck" is the word the rest of the product
uses for a slide deck rather than "Presentation". The preview sat on
`sys.label.weight`, which is the same 560 as the title's `sys.font.weight.strong`,
so the glance competed with the line it is meant to recede from. The named
weights only go up from `strong`; `normal` is the step down that exists without
inventing a number. Headings inherit it, so `**Author:**` (markdown's own 660)
actually reads as emphasis against the glance.

**What a future change has to respect:** do not relabel a connector type
(`github_pull_request`) from MIME — those identifiers are the kind. Do not put
the preview back on `sys.label.weight` to "match the kind label"; the kind
label is a caption, the preview is body type at caption size.

### 2026-08-30 — The embed card preview wins its tone on specificity, not source order

**What changed:** the preview's inherit and heading scale are now
`.citation-card .citation-card-preview div.markdown-body`, and a descendant `*`
carries `color: inherit` so `strong` (and `a`, `th`) recede with the glance.

**Why:** the feed already paints `.markdown-body` at (0,3,0) —
`:is(.workstream-screen, .automation-chat-surface) .agent-message .markdown-body`
and the human-bubble twin. The host written as
`.citation-card-preview .markdown-body` was (0,2,0) and lost, so inherit never
landed: headings kept the shared scale, `**Author:**` stayed `text.default`, and
the four-line clamp spent itself on the title. The card is a nested
`MarkdownBody` inside a turn, so a wrapper that only beats the shared group is
not enough.

**Why not restyle `p` or `strong` on the host:** a host may override typography,
not markdown elements, and the stylesheet guard exists to keep that from
quietly coming back. `*` inherits the tone without naming those elements.
Naming the card and the wrapper's element is the same move the heading-scale
guard already requires: win on specificity, not on sitting lower in the file.

**What a future change has to respect:** a selector that drops `.citation-card`
or `div` falls back to losing against the feed. Do not "fix" the glance by
painting `p` or `strong` on `.citation-card-preview`.

### 2026-08-30 — The embed card preview renders markdown, in the faintest text tone

**What changed:** the embed card's preview is a nested `MarkdownBody` — verbatim,
no citations — rather than a plain-text slice that stripped heading hashes and
left `**Author:**` as characters. The preview node is `inert` as well as
`aria-hidden`. Its colour moved from `ref.color.neutral.9` to
`sys.color.text.disabled`. The card's heading scale collapses every level to the
kind label's size.

**Why:** the derivative *is* markdown — a Word file's conversion, a PDF's OCR —
and printing its markers made the glance noisier than the document it was
hinting at. The rail one click away already renders the same bytes through
`MarkdownBody`; a second parser inside the button would be the copy that
drifts. The earlier excerpt's own changelog named this as the next step.

**Why not import `MarkdownBody` from the citation module:** that module is
already imported by the renderer for the matrix, so a reverse import is a cycle.
`CitationRender.PreviewBody` is the body handing itself in, the same way the
citation context already travels. No citations on that nested body: a document
that cites another resource would otherwise draw a card inside this card.

**Why `text.disabled`, having previously refused it:** `sys.color.text` is
strongest to faintest, and the preview is the layer that should recede from the
title. `text.muted` is already the kind label. The previous ramp step sat
between those two because `text.disabled` was read as a claim about the button;
the token names a contrast, not the control's state, and the button stays
enabled. The number on the ramp was the team's, and this replaces it with the
vocabulary that already means "this type is not the thing to read."

**What a future change has to respect:** the preview is presentation — `inert`
and `aria-hidden`, the button's accessible name stays the title, and nothing
inside the card may become independently focusable or scrollable while the card
is a button. Nested `MarkdownBody` must not receive the outer citation context.
A still must never ask.

### 2026-08-30 — An embed card in the last two turns opens the inspector

**What changed:** `embeddedResourceCitations` in the citation protocol names
the image-syntax announcements a message actually makes, and the work-stream
screen auto-opens the inspector onto the latest resolvable one in the last
two text turns — when the feed first belongs to the route, and when a
streamed turn grows a card that was not there. Closing the rail for that
announcement does not reopen it; leaving the work stream and coming back
does.

**Why:** a published document was reachable from the card and from the rail's
list, but arriving at the work stream — or watching the announcement stream
in — still left the reader on the transcript with the document itself one
click away. The card is the announcement; opening the rail is what the click
already did.

**Why the last two text turns, and why only the card:** a follow-up that does
not re-announce the file is still about that file, so looking only at the
latest turn would miss it; looking past two would steal the rail for a
document the conversation has moved on from. Plugin and thought rows sit
between turns without announcing anything, so they are not counted. A chip
is a passing reference inside prose, a footnote is grounding, and a sample
inside code is syntax being shown — none of those are the announcement, and
auto-opening any of them would fight the placement the protocol already
chose.

**What a future change has to respect:** the visit key is the **turn** and the
canonical resource id together — `transcriptTurnId`, falling back to the
row id — and it clears when the route's work stream changes even if the new
feed has no embed. Keying on the flattened row id is how closing the rail
during a live stream reopened the same card when the canonical block
replaced the overlay. Skipping the visit-key clear is how coming back to a
document stays closed. Only agent text is scanned: a human or external
`![…](resource://…)` is not a card, because those turns render verbatim
without the citation context. The lookback groups by turn, not by text
row, because `orderedTranscriptMessages` emits one row per block.
`open` is skipped when the rail is already showing that document, because
`openRail` clears the inspector before selecting and would flash the list.
The scan lives in the protocol module so the desktop cannot disagree with
the rewrite about which image syntax is a citation. An escaped bang is
not a card; CommonMark renders it as a chip.

### 2026-08-30 — The preview reader leaves the rail, and the row's class joins the export guard

**What changed:** `readResourcePreviewText`, its retry predicate, its `wait`,
and `MAX_RESOURCE_PREVIEW_WAIT_MS` moved from `components/inspector-rail.tsx` to
`lib/resource-preview.ts`, which both the rail and `useCitations` import. The
export's class-coverage scanner also reads `className: ['citation-…']` arrays,
not only JSX string literals. The excerpt strips a heading's own hashes, the row
takes `scrollbar-width: thin` and `overscroll-behavior-x: contain`, and the
preview carries a `max-height` beside its line clamp.

**Why:** a hook in `lib/` was importing a screen-sized component module for four
protocol-level exports — no cycle today, since the rail imports `ResourceIcon`
from the citation module rather than the hook, but one import away from one, and
it pulled the rail's chrome into every test that touched the reader.

**Why the scanner mattered more than it looks:** it is the mechanism that makes
"a class the renderer can emit has an answer in the export" true by
construction, and it only saw JSX. `.citation-card-row` is built as hast by the
rehype pass, so the one class added by this whole change was the one class
outside the guard. The export's wrap rule could have been deleted with CI green.

**Smaller things, each with a reason:** `## Revenue` printed its hashes at label
size and spent one of four clamped lines on them; the row could chain a swipe
outward into a back gesture and drew a full-size overlay scrollbar into the gap
under the tiles; and `-webkit-line-clamp` beside `white-space: pre-wrap` is a
known Chromium pairing, so the clamp now has a height that bounds it if it ever
fails to apply.

**What a future change has to respect:** the excerpt strips heading markers and
nothing else. Emphasis, links and list markers stay, because the next step is a
markdown renderer inside a button — and the rail, one click away, already
renders the same bytes properly.

### 2026-08-30 — The row groups only what becomes a card

**What changed:** `rehypeCitationEmbedRows` takes a predicate saying which
`resource://` targets this render will draw as cards, and groups nothing else.
`MarkdownBody` builds it from the citation context's resolver, and passes a
hoisted empty plugin list when there is no context at all. The transcript's
wheel handler also ignores a predominantly horizontal gesture.

**Why:** the pass grouped on the scheme alone, but five surfaces render
`MarkdownBody` with no citations — the block dashboard, note detail, meeting
notes, the automation draft — and there every `resource://` image is *label
text*. A run of them was being laid side by side inside an `overflow-x` strip,
turning a block of sentences into a horizontal scroller. The single-image case
in the original reasoning was sound and the run case was not, which is the kind
of gap a design note can hide.

**Why the wheel handler moved with it:** the row is the first horizontal
scroller inside the transcript, and `useTranscriptFollow` reads any upward
`deltaY` as the reader leaving the end. A trackpad swipe across a row of cards
carries enough vertical drift to look like that, which would drop a reader out
of follow mid-stream. A horizontal-dominant wheel is now not read as vertical
intent at all.

**What a future change has to respect:** the row is a rendering decision that
depends on what the *matrix* does, and the matrix's answer depends on the host's
context — so anything that widens what renders as a card has to widen the
predicate with it, or the two disagree in exactly one direction: prose in a
scroll strip. Both were review findings; the grouping one had a test the same
day, the wheel one is guarded by the handler's own comment.

### 2026-08-29 — The embed card previews the document it names

**What changed:** `CitationContext` gained `preview`, and the embed card draws
the opening lines of the resource's markdown-converted text between its badge
and its title, at the kind label's size and weight, clamped to four lines and
scrollable in neither axis. While the derivative is still being prepared the
card shows a shimmering three-bar skeleton on the preview's own grid, so the
card does not resize when the text lands. `useCitations` supplies the reader,
and every read is shared per resource and cached across mounts.

**Why:** the tile said what a resource *is* and nothing about what it *says*,
so a run of three cards was three identical grey boxes distinguishable only by
title. A few lines of the document is what makes one card worth clicking over
another — and it is free of a new route, because the rail's detail already
reads exactly this derivative.

**Why the read is shared and cached:** the preview route materializes the
derivative *inside the request*, so each read causes the conversion. A per-card
read would convert a Word file once per citation and again every time the reader
scrolled it back into view. The promise is cached rather than the text, so a card
mounting mid-flight joins the read already running.

**What the key is, and which rejections survive it.** Reads are keyed by id
*and* `currentVersion`: a watched source re-ingested in place keeps its id, so
an id-only key served version N's excerpt on a card the work stream had already
moved to N+1 — a citation substantiating a claim with the wrong revision, and
the same defect the rail's own preview effect keys on `currentVersion` to avoid.
Only a rejection that is a verdict about the document is cached — 4xx other than
408 and 429, so gone, forbidden and unconvertible are remembered. A dropped
connection or a 5xx evicts itself, because caching it meant a card that failed
once never showed a preview again however long the reader stayed in the room.
Both were review findings on the pull request, and neither had a test until they
were fixed.

**Why the reads are built lazily rather than in an effect:** React runs a
child's effect before its parent's, so a card mounting in the same commit as
the hook asked before an effect-initialized ref existed, was told there is no
preview, and — its own effect depending on a stable callback — never asked
again. Found in a real window: every card rendered its empty room and no
request was ever made, with every test passing.

**Why the preview's tone comes off the neutral ramp:** `ref.color.neutral.9`
sits one step below `text.muted` and one above `text.disabled`, which is the
tone this wants and neither of those is. The card is a button, and preview type
dark enough to read comfortably competes with the title for the click;
`text.disabled` would say something untrue about a control that is enabled.
Because the ramp is ordered by contrast rather than lightness, one token dims
correctly in a light theme and in a dark one — measured in all four.

**What a future change has to respect:** the preview is presentation — it is
`aria-hidden`, the button's accessible name stays the title, and nothing inside
the card may become independently focusable or scrollable while the card is a
button. A still (`render.still`) must never ask: a picture serialized
mid-skeleton would keep that skeleton forever.

### 2026-08-29 — The embed card becomes a file tile, and runs of them a row

**What changed:** `ResourceEmbedCard` reshaped from a one-line row — icon,
title, kind, trailing chevron — into a fixed-width tile: the kind badge (a
bordered square holding the resource icon) at the head, the title and kind at
the foot, empty room between. The chevron is gone. In `app.css` the card now
draws from `surface-elevated`, `radius-lg` and the line ramp, and the kind
label takes the theme's own label voice (`sys.label.*`) instead of a hardcoded
size. `rehypeCitationEmbedRows` — a hast pass run by every `MarkdownBody`
render — merges consecutive embed-only paragraphs into one `.citation-card-row`
that scrolls horizontally, so a run of announced resources costs one card's
height instead of a column.

**Why:** The row form read as another line of the sentence; the announcement
form exists to say "a thing was produced here", and the file-tile shape —
the one attachment cards across chat products have converged on — says that at
a glance. Styling stayed entirely in semantic tokens rather than per-theme
rules, which is what lets one rule land correctly in both light and dark without
the component knowing which appearance is running.

**Considered and rejected:** a `cmp.citation-card.*` token group. Every value
the card needs already has a semantic answer (`surface-elevated`, the line
ramp, `sys.label.*`), and a component group would restate values in both
appearances to express decisions the vocabulary already makes.

**What a future change has to respect:** the exported message card mirrors this
markup with its own fixed-light rules in `message-export.ts` — a reshape here
is a redraw there, in the same change. The kind label's transform belongs to
the theme; hardcoding a `text-transform` here would overwrite Air's voice. The
row pass groups only the `resource:` scheme and only runs of two or more: a
lone embed keeps the paragraph every existing assertion and surface expects,
and a real image or identity card beside an embed keeps the run ungrouped.

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
