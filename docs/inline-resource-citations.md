# Inline resource citations

When Rally's answer rests on something — a document it just published, an
attached PDF it read, a page it fetched — the answer says so where the claim is,
and the reference is a live affordance rather than prose. A model cites a
work-stream resource with Markdown link syntax carrying a `resource://` scheme,
announces one with the image form of the same syntax, and cites a grounding
source with a GitHub-flavored footnote. The desktop renderer turns those into an
inline chip, an embed card, and a numbered pill with the source in its popover.

The whole feature is a syntax convention plus a renderer hook. There is no new
message type, no wire field, no table, and no migration: a citation is message
content, carried through the one Markdown renderer on the exact mechanism mention
chips already use. Read this before changing what a citation may name, before
adding a surface that renders agent Markdown, and before touching the footnote
handling in `MarkdownBody`.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/citations.ts` | The protocol. `parseCitationTarget` is the scheme allowlist; `collectFootnoteCitations` pins the footnote-definition grammar; `rewriteCitationsForPlainDelivery` is what surfaces without a renderer send instead. |
| `packages/contracts/src/markdown-code.ts` | Which parts of a Markdown string are code. Shared with the TeX repair, so the two rewriters cannot disagree about it. |
| `apps/desktop/src/renderer/components/citations.tsx` | The renderer registry keyed by (position, scheme), the chip, the embed card, the identity card, the footnote pill, and `liftableFootnoteCitations` — the one function four component overrides consult. |
| `apps/desktop/src/renderer/components/citation-resolution.tsx` | The host that answers what a cited resource is, by id, under the viewer's authorization. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `MarkdownBody`'s overrides: the `a`, `img`, `li`, `section` and `sup` components that dispatch into the registry, and the per-mount footnote id prefix. |
| `apps/desktop/src/renderer/components/document-preview.tsx` | Loading and rendering a resource's own bytes, shared by the attachment lightbox and the rail's resource detail. |
| `apps/desktop/src/renderer/lib/ui-store.ts` | `openResource`, the one action that opens the rail on a resource in the order the rail requires. |
| `apps/api/src/services/email-markdown.ts` | The outbound-email rewrite, applied ahead of all three parts. |
| `packages/connectors/src/slack-markdown.ts` | The Slack rewrite, applied in the splitter both delivery paths go through. |
| `packages/agent-harness/src/prompts/citations.ts` | `CITATION_POLICY`, the emission guidance rendered in every work-stream run. |
| `apps/desktop/src/main/message-export.ts` | The exported card's static rules for the three citation forms. |

## How it works

### The protocol

Three positions, and a scheme allowlist in each:

| Scheme | link `[..](..)` | image `![..](..)` | footnote definition |
| --- | --- | --- | --- |
| `resource://` | inline chip | embed card | pill popover → rail |
| `https` / `http` | external link (unchanged) | **a real image** (unchanged) | pill popover → browser |
| `person:` / `connector:` | mention chip (unchanged) | identity card, non-navigable | pill, no open action |
| malformed `resource://` | plain label text | plain label text | plain label text |
| any other scheme | unchanged | unchanged | unchanged |

The image + `https` cell is deliberately *not* a citation. Markdown images render
today and mean what they mean everywhere, so hijacking that syntax would collide
with a model legitimately embedding one.

The last two rows are different answers, and the difference carries. A malformed
`resource://` target is a citation the model meant and got wrong, so its label is
shown as text rather than as raw syntax. A scheme the protocol does not own is
not a citation at all, and the registry declines it so the renderer does exactly
what it did before citations existed — which is what keeps the pinned
legacy-mention behaviour (a dead anchor carrying its label) intact.

The identifier is an opaque token over `[A-Za-z0-9_-]`, not a UUID pattern: its
shape belongs to the resource system, so a short slug will parse with no change
here. `?v=` is reserved, unparsed syntax — a citation opens the current version,
because a citation in a live conversation means "the document", not "the bytes as
of 2:14 PM". Parsing is lenient across `resource://` and the bare `resource:`
spelling that predates it; the guidance teaches `resource://` only.

### Footnotes

A definition qualifies as a citation when its content is **a single paragraph
containing exactly one link**. Plain text around the link is permitted and is
carried into the popover. A definition with no link, with more than one, or with
a second block is not a citation: its reference keeps the ordinary superscript
GFM gives it and the definition renders in a classic trailing footnote list.

Nothing here is parser work. `remark-gfm` already emits the reference anchors
(carrying `data-footnote-ref` and a fragment naming the definition) and the
trailing `section[data-footnotes]`. The hook reads the identifier off that
fragment, looks up the lifted definition, renders the pill, and drops the list
item the definition came from; when every definition was lifted the section
renders nothing at all, because an emptied one is still a visually hidden heading
and an empty list, which reads as a gap under the message.

The stored Markdown stays completely standard. Outside Rally the same message
renders as classic numbered footnotes with the list at the bottom, which is the
right degraded form.

### Resolution and navigation

A chip's label is the model's own text, so it is drawn immediately. What the
lookup adds is the icon and the kind. `CitationResolutionProvider` reads the
resource by id over `GET /resources/:id` under the viewer's authorization and
caches the answer for the session; a failed or unauthorized read degrades the
citation to its label text.

Clicking a chip, a card, or an internal pill calls `openResource`, which opens
the context rail and selects the resource inspector — in that order, because
`openRail` deliberately clears the inspector. External targets ride the app's
existing sanctioned external-open path. Nothing else is reachable: the registry
never dispatches an unknown scheme, so message content cannot reach another
protocol handler.

The rail's detail resolves from the **loaded work stream's** resource set, not
from the workspace. A citation whose resource is outside that set lands on the
rail's existing unavailable state, carrying whatever the metadata lookup found.
The detail renders the resource's own content beneath its metadata, through the
authorized preview route and the one Markdown renderer.

### Beyond the desktop

Outbound email and Slack delivery render agent Markdown with no renderer of ours,
and both rewrite citations before sending: chips and embed cards reduce to their
label text, footnote references become plain bracketed numbers, and the
definitions become a trailing source list — titles for internal sources, real
links for external ones. Email applies it ahead of the TeX repair in all three
parts; Slack applies it in `splitSlackMarkdown`, which both the streaming and
chunked paths already go through. The transcript copy of the same answer keeps
its citations; only the copy leaving Rally is rewritten.

## Invariants

- **Nothing outside `citations.ts` decides what a citation target is.** The
  renderer, the email converter, and the Slack splitter all call
  `parseCitationTarget`. A second copy of the scheme test would drift the way
  this repository's three Markdown renderers did, and the drift would be
  invisible: one surface would keep rendering a chip the others had stopped
  recognising.
- **The registry has a value in every cell.** `Record<CitationPosition,
  Record<CitationScheme, …>>` is what makes the compiler demand it. Adding a
  scheme is adding the components it asks for; a cell that says `null` says "not
  a citation, render it as you already do" and is a decision recorded in the
  table rather than a gap.
- **The citation map reaches the components through context, never through
  `MarkdownBody`'s memoised component config.** The map changes on every streamed
  commit; putting it in that config invalidates every settled segment and turns
  the streaming fast path back into a whole-body re-parse, in the client only.
  `workstream-blocks-streaming-cost.test.tsx` is what catches it, and it caught
  exactly this at six times its budget while this feature was being written.
- **Footnote ids are namespaced per mounted body.** GFM writes identical ids
  (`fn-1`, `fnref-1`) into every mount and every message is a mount, so without a
  per-mount `clobberPrefix` an anchor or an ARIA reference in one message
  resolves to a footnote in another.
- **Four overrides agree about which definitions were lifted.** The reference
  that becomes a pill, the list item that must not render it again, the section
  that disappears when all of them went, and the superscript the pill replaces
  all read `liftableFootnoteCitations`. Two of them disagreeing shows as a
  duplicated source or an empty gap, neither of which fails a test that only
  checks the pill.
- **A citation grants no access and discloses nothing the message did not.** The
  label is model-written text that was already on screen; the chip adds
  affordance. An unauthorized target renders as that label and opens nothing.
- **Every Rally-owned surface that renders agent Markdown without the shared
  renderer rewrites citations first.** A new one that does not leaks raw
  `resource://` syntax, literal `[^1]` markers, and — for the embed form — a
  broken image.

## Boundary

This module owns the citation *protocol* and the three renderings of it. It does
not own the Markdown renderer around them
([`markdown-rendering.md`](markdown-rendering.md)), the repair applied to model
text on the way in ([`model-text-normalization.md`](model-text-normalization.md)),
the exported card's stylesheet ([`message-export.md`](message-export.md)), the
resource records it cites ([`data-model.md`](data-model.md)), or the email and
Slack delivery paths it hands rewritten text to ([`digests.md`](digests.md),
[`slack-integration.md`](slack-integration.md)).

It exposes three things to the rest of the system: `parseCitationTarget` and
`collectFootnoteCitations` for anything that has to understand the syntax,
`rewriteCitationsForPlainDelivery` for anything that has to render it without a
renderer, and `CitationResolutionContext` for a host that can answer what a
resource is. A surface that renders `MarkdownBody` gets citations with no
knowledge of any of this; a surface with no resolution host installed — the
export card's detached root, a component test — gets chips drawn from labels
alone, which is the correct degradation rather than a missing feature.

It deliberately does not verify that a citation is *true*. A model can cite the
wrong source; the defences are the emission guidance and, when Rally has an
evaluation suite, evals — not a verification pipeline.

## Failure modes and limits

- **A malformed, unknown, or unauthorized target** renders as the citation's
  plain label text. No affordance, no error, nothing the message did not say.
- **A resource cited from outside the loaded work stream** renders as a chip and
  opens the rail's unavailable state. Fetch-by-id detail for an arbitrary cited
  resource is named follow-up work, not a defect.
- **A footnote reference with no definition** renders as the literal `[^1]` text,
  because that is what GFM makes of it and what every other Markdown renderer
  shows. The delivery rewrite leaves it alone for the same reason.
- **While a message streams**, a reference in one settled segment and its
  definition in another are not a footnote yet, and the reference renders
  literally. The commit that ends the stream parses the source whole and heals
  it — the renderer's existing behaviour for a split footnote, and no worse for a
  citation than for a classic one.
- **An unresolved lookup** still renders the chip, with a generic document icon.
  Only a *failed* lookup degrades to text, so the common case never flickers.
- **An old desktop build** renders a link-form citation as a dead anchor carrying
  its label and an image-form citation as a broken image.
- **No remote content is fetched at render or hover time.** No favicons, no
  external previews, no unfurling: a popover renders from what the message and
  the local resource record already carry.
- No new numeric limit is introduced anywhere in this module. The identifier
  grammar is an alphabet, not a length bound.

## Testing

```bash
pnpm --filter @rally/contracts exec vitest run src/citations.test.ts
pnpm --filter @rally/desktop exec vitest run --project renderer src/renderer/components/citations.test.tsx
pnpm --filter @rally/desktop exec vitest run --project renderer src/renderer/components/workstream-blocks-streaming-cost.test.tsx
pnpm --filter @rally/desktop exec vitest run --project main src/main/message-export.test.ts
pnpm --filter @rally/connectors exec vitest run src/slack-markdown.test.ts
pnpm --filter @rally/api exec vitest run test/email-markdown.test.ts
pnpm --filter @rally/agent-harness exec vitest run src/prompts.test.ts
```

The traps:

- **The streaming-cost suite is part of this module's coverage even though it
  names none of it.** It is the only test that fails when the citation map is
  threaded through the memoised component config, and its failure looks like a
  performance regression rather than a citation bug.
- **A component test cannot see whether any of this is visible.** jsdom lays
  nothing out, so a test asserting a pill rendered passes just as happily when it
  sits behind the text or is the wrong size. The three forms are checked in a
  real window, in both themes, per
  [`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it).
- **The prompt suite carries byte-stable goldens.** Editing `CITATION_POLICY`
  changes three of them; the hashes are updated deliberately, not regenerated
  without reading the diff.
- **`remark-gfm` is pinned.** Its footnote output — the `data-footnote-ref`
  attribute, the `section[data-footnotes]` wrapper, the `clobberPrefix` option —
  is load-bearing here rather than incidental, so the manifest names an exact
  version rather than `latest`.

## Security and trust model

Everything a citation carries is model-written text, and it is treated that way.
Parsing and rendering stay inside the single shared Markdown renderer and inherit
its posture: no `rehype-raw`, so markup in the source is text. The scheme
dispatch is a strict allowlist, and an unknown scheme is never dressed as
anything — a citation adds no navigation capability and no IPC.

Internal navigation reaches only the rail's existing resource detail, under the
viewer's existing authorization; external opens go exclusively through the app's
sanctioned external-open path with its existing URL validation. A resource
identifier is matched against a safe alphabet before it is used, so a target with
a path segment, a slash, or a query in it is not an identifier and is refused
rather than passed on.

The metadata lookup is the one new read. It is the viewer's own authorized `GET`,
and a denial is indistinguishable from a missing resource by design: telling a
reader that a resource they cannot see exists would be a disclosure the message
did not make. [`security.md`](security.md) owns the wider model.

## Open questions

- **Popover depth.** Title, the definition's surrounding text, and an open
  affordance today. Whether an excerpt of the source belongs there depends on
  deciding what text is safe and local to show.
- **Embed card contents.** Icon, title, and kind now. An inline excerpt or a live
  preview inside the card is a presentation call worth revisiting now that the
  rail preview exists to compare it against.

## Changelog

### 2026-08-27 — Citations ship as content, on the mechanism mention chips already use

**What changed:** A model can now cite a work-stream resource with
`[Title](resource://<id>)` for an inline chip and `![Title](resource://<id>)` for
an embed card, and cite grounding sources with GFM footnotes that render as
inline numbered pills with no trailing source list. Clicking any of them opens
the resource in the right rail, whose detail view gained a readable content
preview it never had. Outbound email and Slack rewrite citations to readable text
before sending, and standing policy teaches the emission.

**Why:** Two pains met one mechanism that was already in production. The
terminal-generation work publishes documents the chat could only *talk about* —
the announcement was prose and the affordance was off in the rail, so a
collaborator scanning the transcript had nothing to click at the moment the
document was named. And grounded answers showed nothing about which claim leaned
on which source, which on a multiplayer surface means "go check for yourself"
costs re-reading everything. The renderer already hijacks link syntax for
`person:` and `connector:` chips and models emit that shape reliably today, which
is evidence that a bracketed-link protocol with a custom scheme is squarely
inside what models do well.

**Considered and rejected:** A dedicated message type with a card, which the
superseded combined PRD proposed — a wire enum, cache and dispatch branches, and
version-skew handling on every client, to deliver what a link already carries. A
reference is content, not message structure. Invisible-delimiter encodings, which
survive copy/paste into places that cannot render them, corrupt stored content
with invisible bytes, and are out-of-distribution syntax — the opposite of the
familiarity this protocol optimizes for. Rendering the GFM footnote list as-is,
which spends exactly the vertical space the feature exists to reclaim. Pinning a
citation to the version current when it was written, which optimizes for the
archival reading at the cost of the collaborative one; the transcript already
serves the archival reading.

**Consequences:** The stored Markdown is standard and degrades correctly
everywhere outside Rally, which is what makes the email and Slack rewrites
load-bearing rather than cosmetic — a new Rally-owned surface that renders agent
Markdown without them leaks raw syntax and a broken image. `remark-gfm` is now
pinned, because its footnote output is a contract this module reads rather than
an implementation detail. The rail's resource detail is no longer metadata-only,
and the loader behind it is shared with the attachment lightbox rather than
copied. And the streaming fast path has a new way to be broken: anything that
gives `MarkdownBody`'s component config a per-commit identity — the citation map
was the first — silently re-parses every settled segment, which only the
streaming-cost guard will tell you about.

Design: `docs/PRDs/2026-08-27_inline-resource-citations/prd.md`.
