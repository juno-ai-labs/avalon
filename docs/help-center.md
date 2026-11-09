# Help center

The help center is Rally's user manual, published at `rallywith.ai/help/`. Its
source is a folder of Markdown files with front matter in `apps/site/help/`,
written by people and by agents, and the public site's Vite build turns that
folder into static pages. The manual is ordered like a book: chapters run from
installing Rally to running Sidekicks across an Organization, and each page
assumes the ones before it.

Every page is built for two readers. People get a three-column page: chapters on
the left, the rendered Markdown in the middle, and on the right an outline of the
page's H1 to H3 headings with the page's Markdown actions under it. Language
models get the same content as Markdown at a predictable URL, an
[`llms.txt`](https://llmstxt.org/) index, and the whole manual in one file. How
to write a page, and the voice the manual is written in, is in
[`apps/site/help/README.md`](../apps/site/help/README.md); this document covers
the machinery.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/help/` | The content: `index.md` is the cover, each `NN-slug/` folder a chapter with an `index.md` opener, each `NN-slug.md` a page. `README.md` is the authoring guide and is not published. |
| `apps/site/build/help/content.ts` | Reads the folder into chapters and pages, parses and validates front matter, and decides order, slugs, URLs, and chapter numbers. The single source of a page's URL. |
| `apps/site/build/help/markdown.ts` | Renders one page body: GitHub-flavored Markdown, GitHub's HTML sanitizer, `> [!NOTE]` alerts, syntax highlighting, heading ids and anchors, table and code-block wrappers, and the plain text used by search. |
| `apps/site/build/help/layout.ts` | The page template: header, chapters sidebar, article header for each page kind, chapter contents, previous/next links, outline, and the search dialog. |
| `apps/site/build/help/site.ts` | Builds every output file: resolves and checks links, publishes images, writes the Markdown copies, `llms.txt`, `llms-full.txt`, `search-index.json` and `sitemap.xml`. |
| `apps/site/worker/index.ts` | The site's only Worker code. It runs for `/`, `/help` and `/help/*` alone (`run_worker_first` in `wrangler.jsonc`): on the homepage it sets the landing CSP (`worker/landing-csp.ts`); under `/help/` it answers `Accept: text/markdown` with the page's Markdown copy and adds the discovery headers. |
| `apps/site/build/help/plugin.ts` | The Vite plugin: serves pages on request under `vite dev`, and emits every output during `vite build`, linking the `help` entry's hashed script and stylesheet, and naming other entries a page script loads itself (`entryMeta`, the PostHog SDK) in meta tags. |
| `apps/site/src/help.ts`, `src/help-search.ts` | The browser script: phone menu, copy buttons, the outline's current-section marker, and search. Ranking lives in `help-search.ts` so it can be tested without a DOM. |
| `apps/site/build/help/og.ts` | Each page's social card: a 1200×630 PNG laid out by Satori and rasterized by resvg (WebAssembly), named by a hash of its words. |
| `apps/site/public/_redirects` | Sends every retired `/support/...` address, and every help page removed or renamed since, with its `.md` copy, to the page that now covers its subject. |
| `apps/site/src/help.css` | All styling. Colours and type are `--help-*` tokens; the light and dark themes are the only places colours are set. |

## How it works

### From folder to pages

`loadHelpSite` reads `help/` two levels deep. A chapter is a folder named
`NN-slug` with an `index.md`; a page is a file named `NN-slug.md` inside one. The
number orders; it never appears in a URL, and readers see chapters counted from
one and pages as `3.2`, so a chapter can be slotted in as `25-` without
renumbering. URLs are `/help/`, `/help/<chapter>/` and `/help/<chapter>/<page>/`,
and every page's Markdown copy is the same path with `.md` in place of the
trailing slash (`/help/index.md` for the cover).

Front matter allows `title`, `description`, `nav_title` and `draft`, and nothing
else. A draft is left out of the build and shown, badged, in `vite dev`.

Reading order is the cover, then each chapter's opener followed by its pages.
That order drives the previous/next links, `llms.txt`, and `llms-full.txt`.

### Rendering

`renderMarkdown` runs `remark-parse` and `remark-gfm`, converts to HTML with raw
HTML allowed, and sanitizes with `rehype-sanitize`'s default schema, which is
GitHub's. After sanitizing, it adds what the page needs: GitHub alerts become
`div.markdown-alert`, code is highlighted by `rehype-highlight` (classes only,
coloured by tokens), headings get GitHub-style ids and a `#` anchor, tables are
wrapped to scroll on their own, and code blocks get a header with the language
and a copy button. Mermaid blocks stay code.

The front matter `title` is the page's H1. Body headings from `#` to `###` are
listed in the outline, under the title.

### Links

Authors link pages by relative file path, as they would on GitHub. `site.ts`
resolves each link against the source file: a `.md` file or a folder becomes the
target page's URL, a `#fragment` must name a heading the target has, and any
other file inside `help/` is published under `/help/_assets/` with a content hash
in its name. An absolute `/help/...` link must name a page. A link that resolves
to nothing, leaves the folder, or points at a draft fails the build, and so does
an image on another site, since the site CSP loads images only from `'self'` and
`data:`. In the
Markdown copies, the same links become absolute URLs of the targets' Markdown
copies, so an agent reading one page can follow the manual without HTML.

### Outputs

| Output | For |
| --- | --- |
| `help/**/index.html` | People. Static and complete without the script. |
| `help/**.md` | Agents, and the "Copy page as Markdown" button. The author's text byte for byte, under a `# title` and `> description`, with links made absolute. Each HTML page names it in `<link rel="alternate" type="text/markdown">`. |
| `help/llms.txt` | Agents: the manual's contents with one-line descriptions and Markdown URLs. |
| `help/<chapter>/llms.txt` | Agents: one chapter's index, so an agent can load a chapter without the whole book. |
| `help/llms-full.txt` | Agents: the index followed by every page, in reading order. |
| `help/search-index.json` | The search dialog. Title, chapter, URL, description, headings, and body text per page. |
| `help/sitemap.xml` | Crawlers. `public/robots.txt` lists it beside the site's own sitemap. |
| `help/_assets/*` | Images the pages reference. |
| `help/_og/*.png` | One social card per page, for link previews in Slack, iMessage, X and the rest. |

### Social cards

Every page names its own card in `og:image` and `twitter:image`, with its
size and alt text. The card shows the chapter, the page number, the title and
the description in the landing page's type on its dark ground; chapter openers
and the cover set the title in capitals with the chapter number behind it.
`renderOgImages` draws them in `generateBundle`, about a tenth of a second
each, and `vite dev` draws one on request. The file name carries a hash of the
card's words and `DESIGN_VERSION`, so `_headers` caches `/help/_og/*` as
immutable and a changed title gets a new URL that unfurlers fetch fresh. Bump
`DESIGN_VERSION` after changing the card's design.

### For agents

Agents are the second audience, and they arrive three ways, each handled:

- **Asking for Markdown.** Claude Code, Cursor and OpenCode send
  `Accept: text/markdown`. The Worker answers any page URL with that page's
  Markdown copy (`Content-Type: text/markdown`, `Vary: Accept`,
  `X-Robots-Tag: noindex` so search engines index only the HTML). The decision
  is `prefersMarkdown`: Markdown must outrank `text/html`, or tie it and be
  listed first. A browser's `Accept` never names Markdown, so it always gets
  HTML.
- **Reading the HTML.** Copilot, Codex and Gemini CLI send `*/*` and read
  HTML, so the HTML is kept small: the article comes first in the source (the
  grid draws the sidebar on its left), the sidebar lists only the current
  chapter's pages, class names are short, highlighting classes use the `hl-`
  prefix, and the search dialog is built by the script rather than shipped in
  every page. JSON-LD (`TechArticle` and `BreadcrumbList`) names the page, its
  place in the manual, and its Markdown copy.
- **Looking for an index.** Every `/help/` response carries
  `Link: </help/llms.txt>; rel="llms-txt", …` and `X-Llms-Txt`; every page has
  `<link rel="alternate" type="text/markdown">`; every Markdown copy opens with
  a two-line pointer to `llms.txt` and the chapter's own index, placed first so
  an agent that truncates still sees it.

### In the browser

The script is an enhancement: every page works without it. It opens the
chapters list on phones, copies code blocks and pages, marks the outline entry
for the section in view, and runs search. Search fetches `search-index.json`
the first time it opens and ranks in the browser: every word must appear
somewhere; title matches outrank heading matches, which outrank the description
and the body; a heading match links straight to that section. `/`, `⌘K` and
`Ctrl K` open it.

The pages load `src/site-entry.ts`, so they report page views like the rest of
the site, classed as `support` in `telemetry.ts`.

### Theming

`help.css` reads every colour and font from `--help-*` custom properties. There
are two themes, light and dark, chosen by `prefers-color-scheme`; setting
`data-theme="light"` or `"dark"` on `<html>` forces one. A new look is a change
to those token blocks, not to the rules below them. Type is the landing page's:
Barlow for text, Barlow Semi Condensed for display, and a monospace for labels.

## Invariants

- **The build fails on any broken page, link, heading anchor, image, or front
  matter key, and names every problem at once.** An agent writing pages in bulk
  gets one list to fix rather than one error per build, and a published manual
  has no dead links. Guarded by `test/help-center.test.ts`, which also builds the
  real `help/` folder.
- **A page's URL comes only from its folder and file slugs.** Renaming a file
  moves the page; nothing else does. `llms.txt`, the Markdown copies, and other
  sites' links depend on it.
- **The Markdown copy keeps the author's text.** Only link and image targets
  are rewritten, by source position. A formatter round-trip would reflow tables
  and escape characters agents then have to read through. Guarded by
  `test/help-center.test.ts`.
- **Pages ship no inline script or style.** The site's CSP is `script-src
  'self'` and `style-src 'self'`, so highlighting is class-based and the theme
  is set in the stylesheet. An inline `style` attribute would be blocked
  silently. Verified visually, no automated guard.
- **The Worker runs only for `/help` and the homepage.** `run_worker_first`
  lists `/`, `/help` and `/help/*`; `/` is there only so the Worker can set the
  landing CSP, which [`landing-page-tracking.md`](landing-page-tracking.md)
  and the Worker's own header comment own. Downloads, handoff and every other
  page stay pure static assets with no Worker invocation. Widening it puts a
  script in front of pages whose latency and headers were designed without one.
- **Search and "Copy page" fetch same-origin files**, so `connect-src` includes
  `'self'` on `/help/*` only. `public/_headers` removes the global CSP there
  (`! Content-Security-Policy`) and sets a copy that differs only in
  `connect-src`; adding a second CSP instead would be enforced alongside the
  first, and the stricter would win. Every other page keeps its own
  `connect-src` from `_headers`, or, on the homepage, from the Worker. Change the two CSP lines together.

## Boundary

The help center owns `/help/` on the public site, and the redirects that retire
the old `/support/` pages into it. It depends on the site's Vite build, its
fonts and brand marks, and `site-entry.ts` for telemetry. It does not own the
Trust Center. The connector installation pane's **Get help** button and the
Slack App Home footer's **Help** link open it (the desktop Help menu has only
**Rally website**, `apps/desktop/src/main/application-menu.ts`); the Slack app manifest's `support_url` still names `/support`, which
redirects, until the manifest is next pushed to Slack. It renders what is in the folder and
does not check that the words are true: what a page claims about the product is
the author's job, and the product's own documents in `docs/` remain the
engineering reference.

## Failure modes and limits

- A content problem fails `vite build` (and so the deploy) with the list of
  problems. Under `vite dev` the same list is served as a plain-text 500 for any
  `/help/` request, so a writer sees it on reload.
- An unknown fenced-code language renders as plain code.
- If `search-index.json` cannot load, the dialog says so and the chapters still
  work.
- There is no size limit on the folder. Every page is rebuilt on every `vite
  dev` request, which is fine for a manual of this size and is the first thing to
  cache if it stops being.

## Testing

`pnpm --filter @rally/site exec vitest run test/help-center.test.ts` covers
ordering and numbering, front matter and layout errors, drafts, rendering
(alerts, sanitizing, heading ids, highlighting, link rewriting), the full build
of a temporary folder (outputs, assets, Markdown copies, `llms.txt`), link and
anchor failures, the real `help/` folder, search ranking, and the Worker's
`Accept` negotiation. The Worker's headers were checked end to end under
`wrangler dev`. Each test writes
its own folder under the system temp directory and removes it afterwards.

Visual changes are checked in a browser: `pnpm --filter @rally/site build`,
`vite preview`, and Playwright screenshots in light and dark at desktop and
phone widths.

## Changelog

### 2026-11-07 — Manual restructured around Canvases and Sidekicks

**What changed:** The two chapters on working in a Channel and on Spaces and
Breakouts became one Canvases chapter (chapter 2), and the Sidekicks chapter
moved up to chapter 3. Getting started, the tour, who-can-see-what and the
glossary were rewritten for the new rail, sidebar and per-Canvas sharing, and
every other chapter's wording followed. Pages whose subject no longer exists
(Channel name and icon, session import, Sidekicks in Channels, email into
Rally, the digest, the two iPhone pages) were deleted. Every removed or
renamed page, and its Markdown copy, has a 301 in `_redirects` to the page that
now covers its subject, or to its chapter when nothing does. The authoring
guide's list of today's names changed with it.

**Why:** The Canvases and Sidekicks PRD
(`docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`) removes Channels,
Threads, Breakouts, Activity, digests and the iPhone app, and its decision log
puts the help center and site copy in the same cutover train as the code, so
the manual cannot describe a product that is gone. The Sidekicks folder
moved from `07-` to `03-` and kept its pages' addresses, because the number
never reaches a URL; only changed slugs needed redirects. Redirects are
exact paths rather than chapter splats, so a page added later under an old
chapter slug is never shadowed. Old names stay only in the glossary and in
"where did it go" notes, in the past tense, because readers arrive with old
links and old words.

Shipped in juno-ai-labs/avalon#1490.

### 2026-10-01 — Help center built from Markdown at /help/

**What changed:** Added the help center: a content folder, a build step that
renders it into static pages, Markdown copies, `llms.txt` (whole manual and per
chapter), a search index and a sitemap, a browser script for search and the
phone menu, and a Worker in front of `/help/` that serves Markdown to agents
that ask for it.

**Why:** The `/support/` pages it replaces were hand-written HTML, which people
rarely updated and agents couldn't easily write; they are deleted and each
address redirects to its page in the manual. A folder of Markdown files with a
fixed shape is something both can write, review in a pull request, and read
back. The manual is meant to be read by agents as well as people, so it
publishes the Markdown it was written in.

Agents were designed for from the start rather than bolted on: as of 2026 the
coding agents split between those that send `Accept: text/markdown` and those
that read HTML, so the help center serves the first Markdown at the same URL
and keeps its HTML small for the second.

**Considered and rejected:** Cloudflare's zone-level Markdown for Agents, which
converts HTML at the edge: the author's own Markdown is already built and is
better than a conversion of the rendered page. A documentation framework (Astro Starlight,
VitePress, Docusaurus). Each brings its own build, theme system and client
runtime to a site that is otherwise a plain Vite build with a strict CSP; the
renderer here is a few hundred lines on the same `unified` libraries those
frameworks use. Client-side Mermaid, and Shiki's inline-styled highlighting,
were rejected because the CSP blocks inline styles.

Each page has its own social card because a help link is most often shared by
pasting it into Slack, where a generic site card says nothing about the answer.
Cards are drawn without a browser (Satori and resvg) so the build needs nothing
CI does not already have.

**Consequences:** Anything a page needs that GitHub Markdown can't express
needs a change to the renderer, not a custom component in the page. Adding a
front matter key means adding it to `KNOWN_KEYS` in `content.ts`.

Shipped in #1041.
