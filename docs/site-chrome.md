# Site chrome and footer

The header, the column footer, and the other shared markup on the public
site's marketing pages, plus the marker plugin that puts them in place. This
document was `landing-comparisons.md` while the site had "Compared to" pages;
those pages are gone, and the parts they shared with every other page live on
here.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/site-chrome.ts` | `trustPages`, `blogPosts`, the header and footer renderers, the blog sitemap, `/llms.txt`, and the marker table. |
| `apps/site/src/html.ts` | `escapeHtml` and `longDate`, shared by every page rendered at build time. |
| `apps/site/vite.config.ts` | `rally-site-chrome` swaps markers for markup; `rally-markdown-pages` renders the blog, described in [`site-blog.md`](site-blog.md). |
| `apps/site/src/landing.css` | Header and footer styles, in the landing page's tokens. |

## How it works

A page that wants shared markup holds a marker comment. `<!-- rally:site-nav -->`
becomes the header's links and sign-in button and `<!-- rally:site-footer -->`
becomes the column footer, so no page lists header or footer links by hand.
The nav's section links point at `/#pricing` and friends, so the same markup
works on the landing page and on every other page. Markers work anywhere in
the file, attribute values and JSON included. The plugin runs with
`order: 'pre'`, before the access-copy and telemetry plugins. An unknown marker
throws, so a typo fails `vite build` and `vite dev`.

The footer has five columns: Product, Trust Center, Help, Blog, and the brand
block. The Trust Center column reads `trustPages`; the Blog column reads
`blogPosts`.

The footer's legal row links to the security page with "ADA CASA AL1
validated". The landing page uses `<!-- rally:site-footer-without-casa -->`
instead, because it shows the full CASA badge (`<!-- rally:casa-badge -->`,
drawn by `renderCasaBadge`) right below its footer. The badge, the security
page and the FAQ each name July 2026; update all three when the yearly CASA
validation renews.

## Invariants

- **A footer link goes in `renderSiteFooter`, a header link in
  `renderSiteNav`, never in a page.** The Trust Center pages use the same
  footer marker.
- **The footer's help@ link keeps `data-site-action="support-contact-footer"`.**
  The tracking test renders the landing page through `renderSiteChrome` before
  it looks for ids. Guard: `tags every tracked landing link`.

## Boundary

The module owns the shared header, the footer, and the marker plugin. The
Trust Center's own styling is `trust.css`, which loads after `landing.css`.
The blog's pages and cards are [`site-blog.md`](site-blog.md); what the pages
report to PostHog is [`landing-page-tracking.md`](landing-page-tracking.md).

## Testing

`pnpm --filter @rally/site exec vitest run test/site.test.ts` renders the
header and footer and asserts their links, refuses an unknown marker, and runs
the tracking check over the rendered landing page. Layout is verified visually:
build, serve `dist` with `vite preview`, and screenshot the footer at 1440px and
390px.

## Changelog

### 2026-11-17: Every header links the GitHub repository

**What changed:** Rally is open source, so every site header links
`github.com/juno-ai-labs/avalon`. `githubLink(className?)` in `site-icons.ts`
holds the URL and mark; `renderSiteNav`, `renderReadingNav`,
`renderMarketHeader` and the help layout call it, and two markers carry it into
hand-written headers: `rally:github-link` (the homepage) and
`rally:github-header-link` (the Trust Center navs, whose links are
`.header-link`). At 650px and below the homepage and marketplace navs show only
the mark and keep the label for screen readers.

**Why:** Visitors had no way to find the code from the site.

**Considered and rejected:** Copying the SVG into the homepage and Trust Center
HTML. Every page already runs through the marker plugin, and a copy drifts when
the URL or mark changes. A `data-site-action` for the link was also left out:
`SITE_ACTION_LINKS` is a closed set, and counting GitHub clicks would widen it.

**Consequences:** In `landing.css` the `.github-link` rule must stay before the
860px query, or it overrides that query's `.header-link{display:none}` and the
link shows alone beside the sign-in button. The `.github-link` alignment rule
is repeated in `home.css`, `landing.css`, `reading.css` and `help.css`; change
them together. The Trust Center navs are still hand-written, but their GitHub
link comes from the marker.

### 2026-11-16: The comparison pages are removed

**What changed:** The five `/compare/<slug>/` pages, their Markdown in
`content/compare/`, their social cards, `/compare/sitemap.xml`, the "Compared
to" footer column, the header's Compare link, the landing page's "Compared to"
section, and the "Compared to" block of `/llms.txt` are gone, and so are the
redirects that sent removed rival pages to the footer. `comparison-pages.ts`, `social-cards.ts`,
`section-nav.ts`, the hero image and the `@fontsource/barlow` packages that only
the comparison cards used are deleted; `escapeHtml` and `longDate` move to
`html.ts` and `renderBlogCard` to `blog-pages.ts`. This document is renamed
from `landing-comparisons.md`.

**Why:** The product owner asked for the comparison pages to be removed
completely. The previous entry had already taken them off the landing page;
this one takes them off the site.

**Considered and rejected:** Keeping the pages live but unlinked. Copy that
makes claims about rivals has to be re-checked to stay true, and nobody would
see it to notice it had gone stale.

**Consequences:** Bringing comparisons back is a new decision and new code; the
git history before this change has the renderer and the Markdown. The blog and
the marketplace template pages are now the only users of `rally-markdown-pages`.

Shipped in #1639.

### 2026-11-16: The footer and landing page carry the CASA AL1 validation

**What changed:** The footer's legal row links "ADA CASA AL1 validated" to the
security page. A `casa-badge` marker draws a hexagon badge, which the security
page shows in its hero and the landing page shows below its footer. The landing
page uses a `site-footer-without-casa` marker so the footer link doesn't repeat
the badge right below it.

**Why:** Rally completed an App Defense Alliance CASA assessment (Tier 2, now
called AL1) in July 2026, and the site still said Rally claimed no
certification. The product owner asked for the claim in the footer and for the
footer link to leave the landing page. The badge is Rally's own design because
neither ADA nor Google publishes one for AL1.

**Consequences:** The validation renews every year. When it does, update the
date in `renderCasaBadge`, the security page and the help center's privacy and
security articles. If Rally moves to a new Google OAuth project, the validation
does not carry over and the claim must come down.

### 2026-11-16: The landing page drops its comparison section

**What changed:** The homepage no longer lists rivals. `/compare/` redirects,
the header's Compare link and each page's breadcrumb point at the footer's
"Compared to" column (`/#footer-compared`) instead of `/#compare`.

**Why:** The product owner asked for the comparison to leave the landing page.
The footer column is on every page, so it is the one place left that lists them.

**Consequences:** The comparison pages still ship and are still linked from the
footer. A new landing-page section for them needs a new decision.

### 2026-10-01: Drop the closing buttons, render quotes anywhere

**What changed:** The "See Rally pricing" and "Compare Rally with other tools"
buttons no longer close each comparison page. A blockquote in the short answer
now has its own quiet style, and anything after the "Side by side" table
renders instead of being dropped.

**Why:** The team asked for the buttons to go; the header and footer already
link to pricing and the other comparisons. The ChatGPT page put a blockquote
under its short answer, which rendered with browser defaults, and the table
section silently discarded anything after the table.

**Considered and rejected:** Moving every blockquote into the closing aside, as
"Where Rally wins" does. The ChatGPT quote belongs next to the short answer it
qualifies, not at the foot of a later section.

**Consequences:** A comparison page ends at its last section; a call to action
there needs a new decision, not a restored constant. A blockquote's place in the
Markdown is where it renders, except in "Where Rally wins", where it is still
the aside.

Shipped in #1054.

### 2026-10-01: The header's links become a shared marker

**What changed:** The landing page and the comparison pages each carried their
own copy of the header nav. Both now hold `<!-- rally:site-nav -->`, rendered by
`renderSiteNav`, which adds a Blog link between Compare and Download for Mac.
The plugin that renders comparison pages is renamed `rally-markdown-pages` and
also renders the blog, described in [`site-blog.md`](site-blog.md).

**Why:** Adding the Blog link meant editing two copies of the nav, and the copies
already differed only in whether links started with `/`. One renderer keeps them
identical.

**Considered and rejected:** Keeping per-page navs with relative `#features`
links on the landing page. The absolute `/#features` form works on every page,
and on the landing page it scrolls without a reload.

**Consequences:** A header link goes in `renderSiteNav`, never in a page. The
Trust Center pages still write their own nav, so a link added there is separate.

Shipped in #1052.

### 2026-10-01: Trust Center pages take the landing's chrome

**What changed:** The eight `/trust/` pages drop their own light header,
footer and Arial stylesheet. They load `landing.css`, use the landing's
`site-header`, and replace their hand-written `legal-footer` with
`<!-- rally:site-footer -->`. `information.css` becomes `trust.css`, holding
only the Trust Center's layouts, written against the landing's tokens.

**Why:** The Trust Center looked like a different company's site from the
landing page it links from. Sharing the stylesheet and the footer marker keeps
them from drifting again, and the eight copies of the footer link list, which
had already diverged in order and tagline, collapse into `trustPages`.

**Considered and rejected:** Restyling `information.css` in place and keeping
each page's own header and footer. That matches the look today but leaves nine
copies of the chrome to drift, which is how the footers diverged.

**Consequences:** `trust.css` assumes `landing.css` loads first for fonts,
tokens, the header, buttons and `.eyebrow`. A trust page that links only
`trust.css` renders unstyled. A change to the landing's header, footer or tokens
now also changes the Trust Center.

Shipped in #1046.

### 2026-10-01: Comparison pages keep only the table and Rally's case, and the hub is removed

**What changed:** Each rival page drops "Where <name> shines", "Which one
should you pick?", "Questions" and "Sources", along with the `FAQPage` JSON-LD
and the verdict and sources styles. The pricing and comparison buttons that sat
under the verdicts now follow "Where Rally wins". Instinct, Notion AI and
Microsoft Teams are removed, leaving six rivals, and the comparison table loses
its dated caption. The `/compare/` hub page, its social card, and the
count, names and item-list markers only it used are removed; every link that
pointed at it now points at the landing table, and `_redirects` sends
`/compare/` and the three removed rival pages there too.

**Why:** The team wanted shorter pages that make Rally's case and stop there,
and the hub only repeated the landing page's table.

**Considered and rejected:** Keeping the sections in the Markdown and hiding
them in the renderer: copy nobody shows still has to be kept true.

**Consequences:** The pages no longer carry the FAQ markup or source links
that the first entry gave as the reason AI search engines cite them. If that
traffic matters later, bring back `## Questions` first. The `/compare/`
redirects match exact paths, so they must stay exact or they would swallow
the remaining rival pages.

Shipped in #1045.

### 2026-10-01: Comparison pages, their social cards, and a column footer are added

**What changed:** The landing page gains a "Compared to" section after
Technology, the site gains `/compare/` and nine "Rally vs X" pages rendered at
build time from Markdown, each with its own drawn social card, and the landing
footer becomes columns: Compared to, Trust Center, and Help.

**Why:** Buyers ask AI search engines "Rally vs Slack" and similar before they
visit, and comparison pages with a direct answer, a table, an FAQ and sources
are what those engines cite. Links to these pages get shared in Slack and on X,
where a generic card hides what the page is about. The old footer was one flat
row of links with no room for nine more.

**Considered and rejected:** Hand-written HTML per page, which was the first
version: copy edits meant editing markup, and nine copies of the same layout
drift. Committed PNG cards made by a script: they go stale the first time
someone edits a page's `edge`. Sharp's built-in text rendering for the cards:
it fell back to the system font without an error. A copied footer in every
page: eleven copies of the rival list would drift.

**Consequences:** A new rival is one Markdown file. A new footer link goes in `renderSiteFooter`, never in a page.
The site build now depends on `sharp`'s native binary and on the `@fontsource`
packages for the card fonts. `opentype.js` is pinned to exactly 1.3.4: npm's 1.3.5 is a
mistaken publish of 2.0.0, deprecated by its maintainers. `sharp` follows the
0.35.2 the workspace already locks, so the site adds no second copy.

Shipped in #1040.
