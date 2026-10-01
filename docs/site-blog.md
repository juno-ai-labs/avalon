# Site blog

The public site's blog: a list of posts at `/blog/` and one page per post at
`/blog/<slug>/`, each built from a Markdown file at build time. A new post is
one Markdown file; nothing else needs editing for it to appear in the list, the
footer, the sitemap, `llms.txt`, and the build.

The blog reuses the machinery the comparison pages already have, described in
[`landing-comparisons.md`](landing-comparisons.md): the same Vite plugin turns
Markdown into pages, the same card renderer draws each post's link-preview
image, and the same site-chrome markers supply the header and footer.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/content/blog/<slug>.md` | One post: front matter (`slug`, `title`, `description`, `date`, `author`) and a Markdown body. |
| `apps/site/src/blog-pages.ts` | Loads and validates posts; renders the index and each post. |
| `apps/site/src/site-chrome.ts` | `blogPosts`, the footer's Blog column, the blog sitemap, and the blog part of `llms.txt`. |
| `apps/site/src/social-cards.ts` | `renderBlogCard`. |
| `apps/site/vite.config.ts` | Registers the pages and emits each post's `social.png`, `index.md`, and `/blog/sitemap.xml`. |

## How it works

`loadBlogPosts` reads every `.md` file in `content/blog/`, validates its front
matter, and sorts by `date`, newest first. The `rally-markdown-pages` plugin
treats `blog/index.html` and each `blog/<slug>/index.html` as build inputs that
exist only in memory, exactly as it does for the comparison pages, and the dev
server renders the same HTML for the same paths. A post's body goes through
`marked` unchanged. The `/blog/` index uses the home page's social card; each
post gets its own. The footer's Blog column links to the index and the newest
post only, so it stays two links long however many posts accumulate.

## Invariants

- **One source per post.** The Markdown file feeds the page, the index entry,
  the footer, the sitemap, `llms.txt`, the card, and the build input. Nothing
  else lists posts, so a post added anywhere else would be a link the build
  never emits. Guard: the blog sitemap test checks the sitemap against the
  loaded posts.
- **A file's name is its slug, and the slug is lowercase letters, digits and
  hyphens.** The URL comes from the slug and the build input from the file, so
  a mismatch would publish a page nothing links to. `loadBlogPosts` and
  `parseBlogPost` throw, which fails the build. Guard: the blog rendering test.
- **`date` is a real `YYYY-MM-DD` day.** An impossible day such as 2026-02-30
  throws instead of rendering as a different date. Guard: the blog rendering
  test.

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
post and the index and asserts their markup and validation errors, asserts the
header's link order and the footer's Blog column, and checks the blog sitemap
against `content/blog/`. Layout and cards are verified visually: run the site,
screenshot `/blog/` and a post at desktop and phone widths, and open a built
`dist/blog/*/social.png`.

## Changelog

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
