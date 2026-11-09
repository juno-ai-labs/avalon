# Site brand and design system

The public site at `rallywith.ai` after the Canvases and Sidekicks pivot
([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)): what the brand says,
how it looks, which pages exist, and the parts every marketing page is built
from. It was redesigned from a blank page rather than evolved from the earlier
site, so nothing here is inherited by accident.

The help center has its own look and is owned by
[`help-center.md`](help-center.md). What the pages report is owned by
[`landing-page-tracking.md`](landing-page-tracking.md); the comparison pages'
content rules by [`landing-comparisons.md`](landing-comparisons.md); the blog's
by [`site-blog.md`](site-blog.md).

## Where the code lives

| Path | What it holds |
| --- | --- |
| `apps/site/src/site.css` | The whole system: font faces, tokens, base type, buttons, header, footer, every marketing component, the comparison and blog page styles, motion and reduced motion. |
| `apps/site/src/trust.css` | Trust Center layouts, on top of `site.css` and its tokens. |
| `apps/site/src/start-fast.css` | The `/start-fast/` hero's two-door call to action. |
| `apps/site/src/site-motion.ts` | Reveal on scroll, the Canvas scene's timeline, and the header's rule and ink state. |
| `apps/site/src/site-chrome.ts` | The markers: `site-header`, `site-nav`, `site-footer`, `landing-sections`, `comparison-table`, and the partials. Also `productPages`, the one list of product pages the header and footer read. |
| `apps/site/src/partials/*.html` | Blocks more than one page shows: `live-canvas`, `scale`, `pricing-tiers`, `people`, `closing`. |
| `apps/site/src/landing-sections.html` | Everything on `/` below the hero, shared with `/start-fast/`. |
| `apps/site/index.html`, `start-fast/`, `canvases/`, `sidekicks/`, `pricing/`, `company/` | The pages. |
| `apps/site/src/access-copy.ts` | The home page's title and description. |
| `apps/site/src/fonts/` | Geist, Geist Mono and Instrument Serif (and Barlow, for the help center); see its README. |
| `apps/site/public/rally-og.jpg` | The home, product page and blog-index social card: the hero headline and its three event tags at 1200×630, drawn once in a browser from the site's own fonts and saved as a static JPEG. `scripts/generate-brand-assets.py` still writes the earlier `rally-social*.jpg` cards, which no page references now; they stay published because unfurls already cached point at them. |
| `apps/site/public/brand/rally-mark-paper.svg` | The mark in white, for ink grounds and Rally's avatar. |

## How it works

### The brief

The site argues two things, **in this order**:

1. **Live artifacts first.** A Canvas is a document, spreadsheet or site Rally
   builds from the team's connected tools and **keeps current as things happen
   in them**: a Sidekick wakes on a schedule or an event (a customer email, a
   merged pull request, a call note) and publishes the next version. This is
   the headline, the hero scene, and the first chapter on `/` and
   `/canvases/`.
2. **Multiplayer second.** The same Canvas starts private to one person and
   can be shared with a teammate, a guest or the organization. It is chapter 04
   on `/`, after Connectors and Sidekicks, and chapter 03 on `/canvases/`.
   The `scale` partial (Just you → You and a teammate → The whole team) is the
   one block that shows it; a visitor who is alone must not conclude the
   product is not for them.

Connectors are framed as the signals that keep a Canvas live, and Sidekicks
as the engine that does it (and that also takes repeat work needing no
Canvas). The audience is knowledge workers in small teams, including people
who are not engineers.

The positioning line is **"Make it once. It stays live."** The supporting
idea, used on the company page and the footer, is **"AI is better in
company."** The price argument is unchanged: per organization, no seats, so
going from one person to fifty costs nothing per head.

### Voice

Short declarative sentences, plain words, a concrete example over an
adjective. Headlines are two beats: a plain statement, then a turn set in
the serif italic ("Built from your tools. *Kept current by them.*"). Body copy names
real things a team would recognize (a Granola note, a merged pull request, a
launch plan) and real states from the product ("Needs input", "Live now",
"version 2").

### Type

- **Geist** (variable) for headlines and body. Headlines are weight 500 with
  tight tracking (about −0.045em); the hero goes to −0.06em.
- **Instrument Serif italic** for the turning word or phrase of a headline,
  and only there. It is the brand's one flourish; a page that uses it in body
  copy dilutes it.
- **Geist Mono** for labels: kickers, timestamps, version numbers, table
  headings. Uppercase with light tracking.

The scale is fluid (`--step-hero`, `--step-1`, `--step-2`, `--step-3`,
`--step-lede`), so a page sets a role, not a size.

### Colour

Two grounds and one voice:

- **Paper** `#f4f2ed`, the default: a Canvas is a page.
- **Ink** `#0c0c11`, for Sidekick chapters, the closing call and the footer:
  work that runs while you are away.
- **Ultra** `#3a2bff`, Rally's own colour: its avatar, its tag, its version
  numbers, the accent dot of a kicker.
- **Person colours** (Maya coral, Theo green, Priya amber) mark the people in
  a scene. They are never used for chrome.

Components read semantic tokens (`--bg`, `--surface`, `--fg`, `--fg-2`,
`--fg-3`, `--line`, `--accent`). A `.night` block re-points them, so one rule
serves both grounds. The header turns to ink while an ink block is under it.

### Layout and components

A 1360px measure with a fluid gutter. A chapter is a kicker (`01 Canvases`), a
headline, and a lede aligned to the headline's foot (`.chapter-head.split`),
then its body: `cells` (a 12-column card grid), `runs` (Sidekick run rows with
a `state`), `principles` (four numbered columns), `tiers`, `steps`, `faq`,
`people`, or the comparison table. Buttons are pills; cards have an 18px
radius and a hairline.

### The Canvas scene

`partials/live-canvas.html` is a live Canvas drawn in HTML: a header with a
"Live · kept by Pipeline keeper" badge, a versions list on the left, and a
spreadsheet on the right. Its markup ships with every step class (`is-1` …
`is-7`) on, which is the finished scene. `site-motion.ts` clears them and
turns them on one by one while the scene is on screen: a Gmail reply from
Acme arrives and the Sidekick publishes version 13 (Acme moves to
Negotiation); a Granola call note arrives and version 14 adds Northwind; then
Maya and Theo open it, Maya asks for a next-step column, and Rally publishes
version 15. The order is the message order: live first, people second. It
pauses off screen and loops.

### Pages

| Page | Job |
| --- | --- |
| `/` | The whole argument in one scroll: hero and scene, statement, Canvases, Sidekicks, connectors, how it's built, pricing, team, comparison, closing. Carries every tracked link. |
| `/start-fast/` | `/` with a hero that offers the web app and the Mac app side by side. Not indexed. |
| `/canvases/` | How a Canvas works, what Rally makes, presence and sharing. |
| `/sidekicks/` | The shared conversation, triggers, and delegated access. |
| `/pricing/` | The plans and the questions people ask about them. |
| `/company/` | What the company believes, and the founders. |

## Invariants

- **The scene shows only what the product does.** Live co-editing, shared
  cursors and the pending-edit shimmer were cut from the pivot (see the PRD's
  plan). The scene shows a Sidekick publishing versions on events, presence,
  a shared chat and published versions; the hero's tags are events and a
  version, not cursors. "Live" means a new version published on a signal,
  never in-place streaming edits.
  Drawing a cursor editing the document would advertise a feature that does
  not exist.
- **Without script, everything is visible.** `.reveal` hides content only under
  `.motion`, which `site-motion.ts` sets, and the scene's default markup is the
  finished state. A page whose script fails must still read in full.
- **Reduced motion gets the finished page.** No reveal, no scene timeline, no
  marquee, no label wheel; the header's colour change stays because it is not
  movement.
- **No inline styles or inline scripts.** The site's CSP is `style-src 'self'`
  and `script-src 'self'`; a `style=""` attribute or `<style>` block is
  dropped in production while working in a local preview without the header.
- **Fonts are self-hosted.** The CSP allows fonts from `'self'` only; a font
  CDN link fails silently in production.
- **Every installer and web-entry link keeps its `data-site-action`.** The
  ids and their rules are in
  [`landing-page-tracking.md`](landing-page-tracking.md#dont-lose-on-a-redesign);
  the site tests fail when one is missing or unknown, on the home page and the
  product pages.
- **A block on more than one page is a partial.** Pricing tiers, founders, the
  closing call and the scene each live once in `src/partials/`; copying one into
  a page is how the earlier pricing copy drifted between pages.

## Boundary

This document owns the look, the copy and the structure of the marketing pages
and the Trust Center's look. It does not own the Trust Center's policy text
(its pages hold it), the help center's layout, the comparison pages' claims,
the social cards drawn for comparison and blog pages (`social-cards.ts`, still
in the earlier style), the desktop handoff pages (`desktop-handoff.css`), or the
utility pages on `styles.css` (`/download/`, `/slack/`, the 404 page).

## Failure modes and limits

- A missing partial or an unknown marker throws at build time
  (`Unknown site chrome marker`), so a typo cannot ship an empty block.
- If `site-motion.ts` fails to load, the page shows everything, unanimated,
  with the header's ink state off.
- The marquee duplicates its list for the loop, so its visible text is hidden
  from assistive technology and a visually hidden sentence lists the
  connectors once.

## Testing

`pnpm --filter @rally/site test` renders the home page, `/start-fast/` and the
four product pages through the markers and checks every tracked id is known,
every id is on the home page, and every installer link carries its own id; it
also checks the header links and the footer columns. Look is checked by eye:
build the site, serve `dist/`, and screenshot each page at desktop and phone
widths with reduced motion on and off, as
[`docs/dev-environment.md`](dev-environment.md#driving-and-screenshotting-it)
describes.

## Open questions

- The comparison and blog social cards still use the earlier look and Barlow.
  Redrawing them in Geist needs WOFF copies of the faces for `opentype.js`.
- `/download/`, `/slack/` and the 404 page still load `styles.css`.

## Changelog

### 2026-11-09: The site is redesigned from a blank page for Canvases and Sidekicks

**What changed:** A new design system (`site.css`) replaces `landing.css`
across the home page, its variant, the blog, the comparison pages and the
Trust Center. Four product pages were added (`/canvases/`, `/sidekicks/`,
`/pricing/`, `/company/`), the header became one `site-header` marker with
links to them, repeated blocks moved into `src/partials/`, and the home page's
three.js Technology schematic was deleted with its loader, tests, document
(`landing-technology-schematic.md`) and the `three` dependency. The closing
call gained a tracked web-entry link, `web-app-closing`.

**Why:** The owner set the focus: live artifacts (Canvases that change with
activity in connected tools) first, multiplayer second, and it must be obvious
Rally works for one person and scales to many. The pivot deleted Channels, Threads and Breakouts and left two modes;
the old page sold a "shared chat between multiple humans" that no longer
describes the product. The owner asked for the site to be rethought from
nothing, as a brand agency would, rather than reworded. The schematic drew five
layers of the old architecture and cost a 3D library on the home page.

**Considered and rejected:** Restyling the old page with new copy, which would
have kept a structure built around a product that no longer exists. A dark-only
site, which reads as one more AI lab page and loses the paper and ink split
that maps to Canvases and Sidekicks. Shared cursors as the hero motif, which
the pivot's plan cut from scope. Adding a new placement for the closing link,
which would need the API deployed first; `body` already existed.

**Consequences:** Live artifacts lead and multiplayer follows, on every page
and in the scene; a new section goes after the live chapters unless it is
about live Canvases. Copy must keep the one-person case visible: a line that
only speaks to teams ("bring everyone", "for the whole room") needs a
solo counterpart nearby. Any new marketing page loads `site.css` and the `site-header`
and `site-footer` markers. A page that shows a block another page shows uses a
partial. The scene must change when the product changes what a Canvas shows.
The help center, the social cards and the utility pages are still in the old
style.
