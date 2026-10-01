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
| `apps/site/content/blog/<slug>.md` | One post: front matter (`slug`, `title`, `description`, `date`, `author`) and a plain Markdown body. The only place its copy lives. |
| `apps/site/src/blog-pages.ts` | Reads and validates posts (`loadBlogPosts`, `parseBlogPost`) and renders the index (`renderBlogIndex`) and a post (`renderBlogPost`). |
| `apps/site/src/site-chrome.ts` | `blogPosts` (the loaded list, newest first), the footer's Blog column, the shared header nav, the blog sitemap, and the blog section of `llms.txt`. |
| `apps/site/src/social-cards.ts` | `renderBlogCard`: a post's 1200x630 link-preview card. |
| `apps/site/vite.config.ts` | `rally-markdown-pages` registers `/blog/` and each `/blog/<slug>/` as build inputs, and emits each post's `social.png`, `index.md`, and `/blog/sitemap.xml`. |
| `apps/site/src/landing.css` | The `.blog*` styles, in the landing page's tokens. |

## How it works

`loadBlogPosts` reads every `.md` file in `content/blog/`, validates its front
matter, and sorts by `date`, newest first. `vite.config.ts` registers
`blog/index.html` and `blog/<slug>/index.html` as build inputs that exist only
in memory; the plugin's `load` hook answers them with the rendered HTML, and
Vite then treats them like any other page. In development, a middleware renders
the same HTML for the same paths.

A post's body goes through `marked` unchanged, so anything Markdown can express
renders. The page carries `BlogPosting` structured data, a canonical URL, an
`rel="alternate"` link to its own Markdown at `index.md`, and its own social
card. The `/blog/` index uses the home page's card.

The footer's Blog column links to the index and the newest post only, so the
column stays two links long however many posts accumulate.

## Invariants

- **One source per post.** The Markdown file feeds the page, the index entry,
  the footer, the sitemap, `llms.txt`, the card, and the build input. Nothing
  else lists posts. Guard: the blog sitemap test asserts the sitemap against the
  files on disk.
- **A file's name is its slug.** `loadBlogPosts` throws when they differ, which
  fails the build, because the URL comes from the slug and the build input from
  the file.
- **`date` is a `YYYY-MM-DD` day.** YAML reads an unquoted date as a JavaScript
  date; `parseBlogPost` converts it back so the page, sitemap, and sort all use
  the day as written. A malformed date throws. Guard: the blog rendering test.

## Boundary

The module owns the blog pages, their cards, and the footer's Blog column. It
does not own the header nav, the footer layout, or the marker plugin, which
[`landing-comparisons.md`](landing-comparisons.md) owns. Site telemetry
classifies blog pages as `landing`, like the comparison pages; see
[`public-site-telemetry.md`](public-site-telemetry.md).

## Failure modes and limits

- A missing front matter field, a slug that does not match its file name, or a
  malformed date throws, so `vite build` and `vite dev` fail loudly.
- A `description` too long for two lines on the card is cut with an ellipsis;
  the page shows it in full.
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
