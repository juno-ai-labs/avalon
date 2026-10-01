# Site blog

The public site's blog: a changelog of posts at `/blog/` and one page per post
at `/blog/<slug>/`, each built from a GitHub-flavored Markdown file at build
time. A new post is
one Markdown file; nothing else needs editing for it to appear in the list, the
footer, the sitemap, `llms.txt`, and the build.

The blog reuses the machinery the comparison pages already have, described in
[`landing-comparisons.md`](landing-comparisons.md): the same Vite plugin turns
Markdown into pages, the same card renderer draws each post's link-preview
image, and the same site-chrome markers supply the header and footer.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/content/blog/YYYY-MM-DD-<title>.md` | One post. The file name gives the date; front matter gives `slug`, `title`, `description` and `author`; the rest is the body. |
| `apps/site/src/blog-pages.ts` | Loads and validates posts; renders the changelog index and each post. |
| `apps/site/src/landing.css` | The `.changelog` index layout and the `.blog` post layout. |
| `apps/site/src/site-chrome.ts` | `blogPosts`, the footer's Blog column, the blog sitemap, and the blog part of `llms.txt`. |
| `apps/site/src/social-cards.ts` | `renderBlogCard`. |
| `apps/site/vite.config.ts` | Registers the pages and emits each post's `social.png`, `index.md`, and `/blog/sitemap.xml`. |

## How it works

`loadBlogPosts` reads every `.md` file in `content/blog/`, takes the date from
its name, validates its front matter (slug included), and sorts by date, newest
first. The `rally-markdown-pages` plugin
treats `blog/index.html` and each `blog/<slug>/index.html` as build inputs that
exist only in memory, exactly as it does for the comparison pages, and the dev
server renders the same HTML for the same paths. A post's body goes through
`marked` with its default GitHub-flavored Markdown. The `/blog/` index is a
changelog: each date sits right-aligned in a left column, then a dot on a rail
that runs down the left edge of the posts. Dates stay sticky beside their post. The newest post shows in full; each older one shows its
title, its first paragraph, and a Read more link. The index uses the home page's
social card; each post gets its own. The header does not link to the blog; the
footer does. The footer's Blog column links to the index and the newest
post only, so it stays two links long however many posts accumulate.

## Invariants

- **One source per post.** The Markdown file feeds the page, the index entry,
  the footer, the sitemap, `llms.txt`, the card, and the build input. Nothing
  else lists posts, so a post added anywhere else would be a link the build
  never emits. Guard: the blog sitemap test checks the sitemap against the
  loaded posts.
- **The file name is the only source of a post's date.** A name not shaped
  `YYYY-MM-DD-<title>.md`, the title in lowercase letters, digits and hyphens,
  throws, and so does front matter that sets `date`, so the two can never
  disagree. `parseBlogPost` throws, which fails the build. Guard: the blog
  rendering test.
- **The front matter `slug` is the URL, and no two posts share one.** It is
  lowercase letters, digits and hyphens, so a path and the dev server accept
  it. A shared slug would build one page over the other, so `loadBlogPosts`
  throws. Guard: the blog rendering and duplicate-slug tests.
- **The date is a real day.** An impossible day such as 2026-02-30 throws
  instead of rendering as a different date. Guard: the blog rendering test.
- **Renaming a file keeps its URL;** changing its `slug` moves it.

## Boundary

The module owns the blog pages, their cards, and the footer's Blog column. It
does not own the header nav, the footer layout, or the marker plugin, which
[`landing-comparisons.md`](landing-comparisons.md) owns. Site telemetry
classifies blog pages as `landing`, like the comparison pages; see
[`public-site-telemetry.md`](public-site-telemetry.md).

## Failure modes and limits

- A front matter error fails `vite build` and `vite dev`, per the invariants.
- `_headers` caches each card for a day, so an edited title can take a day to
  refresh in link previews.

## Testing

`pnpm --filter @rally/site exec vitest run test/site.test.ts` renders a fixture
post and asserts its markup and validation errors, renders a two-post changelog
and asserts which post shows in full and which shows a summary, asserts the
header's links and the footer's Blog column, and checks the blog sitemap
against `content/blog/`. Layout and cards are verified visually: run the site,
screenshot `/blog/` and a post at desktop and phone widths, and open a built
`dist/blog/*/social.png`.

## Changelog

### 2026-10-01: Dated file names, a changelog index, and no header link

**What changed:** Post files are named `YYYY-MM-DD-<title>.md`, and the date
moved out of the front matter into the name. The slug stays in front matter. `/blog/` became a changelog
in the style of Linear's: dates on the left, a dot and rail against the posts, the newest post in full, and
older posts as a title, first paragraph and Read more link. Blog left the
header nav; the footer column stays.

**Why:** The team asked for dated file names so the folder sorts by date, for an
index that reads the latest post without a click, and for a quieter header.

**Considered and rejected:** Keeping `date` in front matter beside the name.
Two copies of the same fact drift, so front matter that repeats it now throws.
Taking the slug from the name too was tried and reverted: the team wanted the
URL set in front matter, so renaming a file never moves a published page. The
cost is that the name no longer keeps slugs unique, so the loader checks. Using the front matter `description` as the summary was
rejected in favour of the body's first paragraph, which is what the reader
would see next anyway.

**Consequences:** Existing URLs hold, since `blastoff` kept its slug. Each
post's published `index.md` no longer carries its date in front matter; the
page and sitemap still do. If the index grows long, pagination belongs in
`renderBlogIndex`.

Shipped in #1053.

### 2026-10-01: The blog is added, with Blastoff as its first post

**What changed:** The site gains `/blog/`, a list of posts, and
`/blog/blastoff/`, the launch post. Posts are Markdown files in
`content/blog/`. Each post gets its own link-preview card, a Markdown copy, a
sitemap entry, and an `llms.txt` line. "Blog" joins the header between Compare
and Download for Mac, and the footer gains a Blog column.

**Why:** Rally launched and needed a place to say so. A plain list of links was
enough for one post.

**Considered and rejected:** A separate rendering path or static HTML per post.
The comparison pages already had a Markdown-to-page plugin, a card renderer,
and shared chrome; generalizing the plugin to any rendered page let the blog use
all three. Listing every post in the footer was rejected because the column
would grow without end.

**Consequences:** A new post is one Markdown file. If the index outgrows a
plain list, pagination or tags belong in `renderBlogIndex`, and the sitemap and
footer need no change.

Shipped in #1052.
