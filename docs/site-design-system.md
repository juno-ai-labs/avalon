# Site design system

The public site at `rallywith.ai` (the home page, `/start-fast/`, the product
pages `/canvases/` and `/sidekicks/`, the blog, the `/compare/` pages and the
Trust Center) is one visual system in one stylesheet, `apps/site/src/landing.css`.
This document owns that system: the brand decisions behind it, the tokens, the
page architecture, the Canvas demo in the hero, and the rules a change to any
marketing page must keep. It was set in the redesign that followed the
[Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md).

The help center (`/help/`) has its own light and dark theme and is not part of
this system; see [`help-center.md`](help-center.md). The download, Slack and
404 pages still load `styles.css`. What the pages report is
[`landing-page-tracking.md`](landing-page-tracking.md)'s; the three.js figure
in the Technology section is [`landing-technology-schematic.md`](landing-technology-schematic.md)'s.

## The brief

The redesign was run as an agency would run it, from the brand outwards.

1. **Audit.** The old site set everything in uppercase Barlow Semi Condensed
   on near-black with a sunrise photo, and its home page still told the
   Channel and Thread story in places. Rally's launch films and X ads
   (`.agents/skills/rally-motion/`) had meanwhile settled a different, stronger
   look through review: Inter Tight set big and tight, a warm off-white, one
   volt accent, and a recurring cast with named cursors. The site and the ads
   read as two companies.
2. **Strategy.** One brand across film and web. The site adopts the motion
   system's colours, type and cast rather than inventing a third look, so an
   ad's viewer lands on a page that is visibly the same product.
3. **Positioning.** Every other AI tool is built for one person in one chat;
   Rally is for the team. The hero line is the approved end-card line of the
   films, "One place for you, your coworkers, and AI." The closing line is the
   films' hook, "Work isn't single-player."
4. **Story order.** After the pivot the product is two things, so the home
   page says that plainly ("Two parts. That's the whole product.") and then
   explains each: Canvases, then Sidekicks, then the proof (pricing,
   technology, team, comparisons).
5. **Show, don't claim.** The hero is a working Canvas, not a picture: people
   ask, Rally reads their tools, the artifact appears, a teammate comments, and
   Rally publishes a second version.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/landing.css` | The whole system: tokens, type roles, buttons, header, footer, bands, the demo, bento, timeline, pricing, product-page rows, and the blog, compare and Trust Center layouts |
| `apps/site/src/trust.css` | Trust Center layout on top of `landing.css`'s tokens |
| `apps/site/index.html` | The home page hero; everything below it comes from `landing-sections.html` |
| `apps/site/start-fast/index.html` | The home page with its own hero copy and button order |
| `apps/site/src/landing-sections.html` | The home page below the hero, shared with `/start-fast/` |
| `apps/site/src/canvas-demo.html` | The animated Canvas, shared by the home hero, `/start-fast/` and `/canvases/` |
| `apps/site/canvases/index.html`, `apps/site/sidekicks/index.html` | The two product pages |
| `apps/site/src/site-motion.ts` | The demo's timeline and the scroll reveals |
| `apps/site/src/site-chrome.ts` | The header nav, the footer, and the `<!-- rally:… -->` markers that stitch shared markup into pages |
| `apps/site/src/fonts/` | Inter, Inter Tight and Geist Mono, latin, variable weight |
| `apps/site/public/brand/rally-mark-volt.svg` | The mark in volt, for pages on the dark system |

## How it works

### Tokens

Colour is near-black ground (`--ink #070707`, raised surfaces `--raised`,
`--panel`), warm paper type (`--paper #f0efe8`, with `--soft`, `--muted` and
`--faint` as its opacities), and one accent, `--volt #ccff00`, with
`--volt-ink` for text on it. The cast colours, `--blue` (Maya), `--orange`
(Theo) and `--grey` (Priya), mark people only: bubbles, faces, cursors.
`--green` and `--magenta` survive as aliases so older rules keep resolving.

Type is three faces. `--display-font` (Inter Tight, weight 650 to 800,
tracking about -0.045em) for headlines; `--body-font` (Inter) for reading;
`--mono` (Geist Mono) for labels, numbers and anything that reads as
machine output. A headline is two lines in two tones: the claim in paper,
then a second line in `.display em`, dimmed, or volt where it is the page's
one accent.

### Page architecture

A page is a header, a hero, then **bands**: `.band` sections at the shared
max width, each opening with an `.eyebrow` (a volt dot, a two-digit number,
a name) and a two-tone `.display` headline in `.band-head`. Content inside a
band is cards on `--raised` with hairline borders and a 20px radius. Every
marketing page ends with the `.closer` band and the footer, whose oversized
outlined wordmark closes the page.

Shared markup is never copied between pages. A page holds a marker such as
`<!-- rally:canvas-demo -->` and `renderSiteChrome` in `site-chrome.ts`
replaces it at build time and in the dev server.

### The Canvas demo

`canvas-demo.html` is plain HTML. `site-motion.ts` steps it through six
states: each step adds `s<n>` to the figure, so CSS places the cursors and
swaps the artifact's version per step, and turns on every `[data-at]`
element whose step has arrived. The loop runs only while the figure is on
screen. The timings live in `STEP_HOLD`.

### Motion

Elements marked `data-reveal` rise in as they enter the screen.
`site-motion.ts` adds the `reveals` class to `<html>` only when it runs and
motion is allowed, so with no script every element is visible. With reduced
motion the demo shows its final step, the connector strip stops and wraps,
and nothing reveals or drifts.

## Invariants

- **One volt idea per view.** Volt marks the one thing to look at: the main
  button, the hero's last line, the live state. Two volt headlines on one
  screen means one of them is wrong (the motion films' rule, kept here).
- **Product truth.** Every claim on these pages must be something the
  product does, in the product's words. The demo shows people present, a
  comment on a line and a published version, all of which ship; it does not
  show live co-editing or a cursor for Rally, which do not. A badge such as
  "Most teams" needs a source before it ships.
- **No inline style or script.** The Content-Security-Policy is
  `style-src 'self'` and `script-src 'self'`. A `style=""` attribute or an
  inline `<script>` is blocked in production while working in the dev
  server. State goes through classes, as the demo does.
- **Tracked links keep their ids.** Every `data-site-action` link in
  [`landing-page-tracking.md`](landing-page-tracking.md) stays on `/`.
  A new call to action that signs people up must use a tracked id, not a bare
  link to the web app.
- **Content is visible without script.** Hidden-until-revealed states hang
  off a class the script adds, never off the default stylesheet.

## Boundary

This system styles the marketing pages only. The help center keeps its own
tokens, and the social cards drawn at build time (`social-cards.ts`) still
set Barlow from the `@fontsource` packages: moving them to Inter Tight means
shipping WOFF copies of these faces, since `opentype.js` cannot read WOFF2.
The download, Slack and 404 pages still use `styles.css`.

## Failure modes and limits

- **Fonts load late.** All three faces use `font-display: swap`; a slow
  connection shows the system sans first. The three files total about 125 KB.
- **The demo at mid widths.** Cursors are placed in percent of the demo body,
  so they drift off their targets as the body changes shape; below 1100px
  they are hidden and below 860px the demo stacks.
- **Cross-page drift.** Blog, compare and trust markup is generated or
  written separately; a class renamed here must be renamed there.

## Testing

`apps/site/test/site.test.ts` checks the header's links, that every tracked
id is on the home page, and the footer columns. The look itself has no
automated test: it is checked in a real browser at desktop and phone widths
before a change ships, as the repository's rule on visible changes requires.

## Changelog

### 2026-11-09 — The site adopts the motion films' brand and tells the two-part product

**What changed:** The marketing site was redesigned from the ground up. One
stylesheet now sets the system the launch films use (Inter Tight, Inter and
Geist Mono; near-black, paper and one volt accent; the Maya, Theo and Priya
cast), the home page leads with an animated Canvas and is organised around
Canvases and Sidekicks, `/canvases/` and `/sidekicks/` were added, and the
blog, comparison and Trust Center pages took on the same system.

**Why:** The pivot to Canvases and Sidekicks left the home page telling an
older story, and the site's uppercase Barlow look no longer matched the ads
that send people to it. The rejected alternative was a fresh visual identity
for the site alone, which would have left film and web as two brands.

**Respect:** Keep the CSP rules (no inline style or script), the tracked
link ids, and product truth in the demo. A new marketing page starts from
`landing.css` and the band pattern rather than a stylesheet of its own.
