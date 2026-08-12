# Rendering markdown in the desktop client

Almost everything Avalon shows a person is markdown a model wrote: a work-stream
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
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `MarkdownBody` — the only place `react-markdown` is mounted — and its four component overrides: `MarkdownCode`, `MarkdownCodeBlock`, `MarkdownTable`, and the `a` renderer that turns mention links into chips. |
| `apps/desktop/src/renderer/styles/app.css` | The `.markdown-body` group: every element style markdown gets. Also the two host overrides, `.note-detail-article` and `.meeting-notes-body`, each of which states a heading scale and nothing else. |
| `apps/desktop/src/renderer/styles/app.css.node.test.ts` | The stylesheet guards: the list markers Tailwind's preflight removes, and the assertion that no host restyles a markdown element. |
| `apps/desktop/src/renderer/components/markdown-renderer.node.test.ts` | The guard that `react-markdown` stays mounted in one place. |

Six call sites, all passing a markdown string as `children`:

| Surface | Call site |
| --- | --- |
| A work-stream turn, and the structured block above it | `workstream-blocks.tsx` |
| A HyperSight dashboard block | `hypersight-panel.tsx` |
| An automation's overview while it is being set up | `new-automation.tsx` |
| The Control Tower meeting briefing | `screens/meeting-notes.tsx` |
| A note's body | `screens/note-detail.tsx` |

## How it works

`MarkdownBody` renders a `div.markdown-body` around `ReactMarkdown` with
`remark-gfm`, so tables, task lists, strikethrough, and autolinks all parse. Four
overrides sit on top of the default element mapping.

### Code

`MarkdownCode` decides inline from block itself rather than trusting the tag: a
fence carries a `language-*` class, and an indented block ends in a newline.
Inline code becomes `code.markdown-inline-code`; a block becomes
`MarkdownCodeBlock`, which highlights through `prism-react-renderer` and adds a
copy button backed by `desktopBridge().copyText`. An unrecognised language falls
back to `plain` after one pass through `markdownLanguageAliases`, so a fence
labelled with something Prism has never heard of still renders as code.

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
  the declaration describes the surface or the markdown. A heading scale, a
  measure, and a text colour describe the surface; a list indent, a code
  background, and a table border describe the markdown.
- **A mention link is never navigable.** `person:` and `connector:` survive
  `urlTransform` only so the `a` override can turn them into chips or, failing
  that, into inert text. If one ever reached the DOM as an `href`, a model would
  be choosing a destination.
- **A connector chip requires this render's token.** Without it the link is text
  someone wrote rather than a mention Avalon minted, and it renders as a
  fallback span.

## Boundary

This module owns how a markdown string becomes DOM in the renderer, and how that
DOM is styled. It exposes exactly one thing: `MarkdownBody`, taking a markdown
string and an optional `mentions` array.

It does not own the markdown itself. Where a briefing's text comes from is
[`meeting-notes.md`](meeting-notes.md); a HyperSight block's is
[`AGENT_HARNESS.md`](AGENT_HARNESS.md); an automation overview's is
[`automation-drafts.md`](automation-drafts.md). It does not own the surrounding
screen either — a note's page geometry belongs to the note screen, and this
document has an opinion only about the part of it that is markdown.

It renders untrusted text: everything it is given was written by a model, a
meeting participant, or an inbound email. `react-markdown` does not evaluate HTML
in its input and no `rehype-raw` is configured, so markup in the source is text.
[`SECURITY.md`](SECURITY.md) owns the wider trust model.

Markdown rendered anywhere other than the desktop renderer is a different
problem with different constraints, and is deliberately not shared with this:
the digest email has its own converter, for the reason
[`DIGESTS.md`](DIGESTS.md) records — a general markdown library emits far more
than an email client will honour.

## Failure modes and limits

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
- **A very long markdown string** is rendered in full. Nothing here truncates;
  the surfaces that need a cap impose it themselves, as the system-message clamp
  in `app.css` does.

## Testing

Two suites, and they cover different failures — neither subsumes the other.

```bash
pnpm --filter @avalon/desktop exec vitest run src/renderer/styles/app.css.node.test.ts
pnpm --filter @avalon/desktop exec vitest run src/renderer/components/markdown-renderer.node.test.ts
pnpm --filter @avalon/desktop exec vitest run src/renderer/components/workstream-blocks.test.tsx
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
