# Landing comparisons and site footer

The public site's "Compared to" pages and the column footer they share with the
landing page. `rallywith.ai/compare/` lists nine rival products in one table, and
each rival has its own page at `/compare/<slug>/` that answers "Rally vs X"
for a person or an AI search engine. The landing page carries the same table as
its "Compared to" section. The footer lists every comparison in one column and
every Trust Center page in another.

The copy is written by the Rally team and says so on every page. It is meant to
be biased toward Rally but not wrong about anyone else, so every claim about a
rival should be checkable on that rival's public pages as of the date the page
carries.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/site-chrome.ts` | The single list of rivals (`comparisons`) and Trust Center pages (`trustPages`), and the renderers for the footer and the comparison table. |
| `apps/site/vite.config.ts` | The `rally-site-chrome` plugin that swaps markers for markup, and one build input per comparison page, derived from `comparisons`. |
| `apps/site/compare/index.html` | The hub page: answer, table, method, FAQ. |
| `apps/site/compare/<slug>/index.html` | One page per rival. Static HTML. |
| `apps/site/src/landing.css` | Footer, table, and comparison page styles, in the landing page's tokens. |
| `apps/site/public/sitemap.xml`, `public/llms.txt` | Crawler and agent entry points that list the pages. |

## How it works

A page that wants shared markup holds a marker comment. `<!-- rally:site-footer -->`
becomes the column footer and `<!-- rally:comparison-table -->` becomes the
table of rivals. The plugin runs in `transformIndexHtml` with `order: 'pre'`,
so the markers are gone before the access-copy and telemetry plugins see the
page, in development and in the build alike. An unknown marker throws, which
fails the build rather than shipping a page with a hole in it.

The table and the footer both read `comparisons`, so adding a rival is one entry
there plus its page. The table is a real `<table>` with a caption and scoped
headers because AI crawlers and screen readers both parse tables well; below
900px CSS turns each row into a stacked card labelled from `data-label`.

Each comparison page follows one shape so a reader can line two of them up:

1. A one-paragraph **short answer** under the title. AI search engines quote the
   first direct answer on a page, so it comes first.
2. **Side by side**: the same eight questions on every page (who it's for,
   shared conversation, shared context, private work, tools, running on its own,
   models, pricing), Rally's column first.
3. **Where the rival shines**: honest credit. A comparison that admits
   strengths reads as trustworthy to people and to the engines that rank it.
4. **Where Rally wins**, ending with one dad joke.
5. **Which to pick**: two short lists.
6. **FAQ** as `<details>`, mirrored in `FAQPage` JSON-LD.

Every page carries JSON-LD (`WebPage` or `CollectionPage`, the Rally
`SoftwareApplication` with its two plan prices, `BreadcrumbList`, `FAQPage`), a
visible "Updated" date in a `<time>` element, and `article:modified_time`. The
pages reuse the landing page's header, `section-nav.ts` for the left rail, and
the landing stylesheet. Class names are whole words that say what the element is
(`compare-answer`, `versus-table`, `footer-heading`) so the markup stays legible
to an agent reading the HTML.

## Invariants

- **One list of rivals.** `comparisons` in `site-chrome.ts` feeds the footer,
  the table, and the build inputs. A rival added anywhere else drifts: a
  footer link to a page the build never emits is a 404. Guard: the site tests
  render the footer and table and assert the exact links.
- **Every comparison page has a directory under `compare/`.** The build input is
  derived from `comparisons`, so a missing file fails `vite build`. No other guard.
- **The footer's help@ link keeps `data-site-action="support-contact-footer"`.**
  It now lives in `renderSiteFooter`, not in `index.html`, so the tracking test
  renders the landing page through `renderSiteChrome` before it looks for ids.
  Guard: `tags every tracked landing link` in `apps/site/test/site.test.ts`.
- **Each page's date is true.** The "Updated" date, `dateModified`, and the
  sitemap `lastmod` say when the claims were last checked against the rivals'
  public pages. Bump all three only after re-checking. No automated guard.
- **Claims about a rival stay to what its own pages say.** Biased framing is
  fine; a wrong fact is not. No automated guard; reviewed by hand.

## Boundary

The module owns the comparison pages, the landing page's comparison section, and
the footer on those pages. It does not own the Trust Center or Support pages'
own footers (`legal-footer` in `information.css`), which keep their layout, or
the access-copy headline, which [`private-access.md`](private-access.md) owns.
What the pages report to PostHog is in
[`landing-page-tracking.md`](landing-page-tracking.md).

## Failure modes and limits

- A marker with a typo throws in the plugin, so `vite build` and `vite dev` fail
  loudly.
- The comparison pages classify as `landing` in site telemetry because
  `sitePageForPath` has no `compare` class. Their page views therefore appear
  beside the home page's with a different `$pathname`; the landing dashboards
  filter on `$pathname = '/'` and are unaffected.
- Rival facts go stale. Each page shows its date so a reader, human or model,
  can judge freshness.

## Testing

`pnpm --filter @rally/site exec vitest run test/site.test.ts` renders the footer
and the table and asserts their links and one row's text, and runs the tracking
check over the rendered landing page. Layout is verified visually: build, serve
with `vite preview`, and screenshot the landing section, the footer, one rival
page, and the hub at 1440px and 390px.

## Changelog

### 2026-10-01: Comparison pages and a column footer are added

**What changed:** The landing page gains a "Compared to" section, the site gains
`/compare/` and nine "Rally vs X" pages, and the landing footer becomes columns:
Compared to, Trust Center, and Help.

**Why:** Buyers ask AI search engines "Rally vs Slack" and similar before they
visit, and comparison pages with a direct answer, a table, and an FAQ are what
those engines cite. The old footer was one flat row of links that had no room
for nine more.

**Considered and rejected:** Generating the nine pages at build time from data.
Their prose differs page to page and is edited by people, so static HTML that
reads like the page is easier to change than strings in TypeScript; only the
parts that repeat on every page (footer, table) are shared. A copied footer in
every page was also rejected: eleven copies of the rival list would drift.

**Consequences:** A new rival needs an entry in `comparisons`, a page under
`compare/`, and a sitemap and `llms.txt` line. A new footer link goes in
`renderSiteFooter`, never in a page.
