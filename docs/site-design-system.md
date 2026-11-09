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

The redesign was run as an agency would run it, from the brand outwards, and
started from a blank page rather than from any earlier look.

1. **Audit.** The old site set everything in uppercase Barlow Semi Condensed
   on near-black, and its home page still told the Channel and Thread story in
   places. Dark, neon-accented, all-caps pages are also what most AI products
   look like in 2026, so the old look did not set Rally apart.
2. **Concept: the shared page.** Rally is where a team and AI work on the same
   page, so the site is designed as one: warm paper, ink, column guides, ruled
   index lines, figures with captions. The multiplayer idea is shown in the
   material itself: people's selections and name flags sit on the words, the
   way they do in a shared editor.
3. **Three voices, three faces.** A serif (Instrument Serif) for the human
   voice and every headline; a precise grotesk (Geist) for the product and
   body text; a mono (Geist Mono) for labels, numbers and anything a machine
   would say.
4. **One accent, owned by Rally.** Signal ultramarine marks Rally and the one
   thing to act on. People never wear it: Maya, Theo and Priya each have
   their own colour for cursors, bubbles and selections.
5. **Positioning: live first, multiplayer second.** The lead idea is the
   live artifact (a Canvas in the product): a document, spreadsheet,
   dashboard or site that changes as work happens in connected tools,
   because a Sidekick watching those tools publishes a new version. The
   second idea is that a team works from that page together. The hero says
   "Docs that update as work happens.", its kicker says "Live artifacts,
   shared with your team", and the page closes on "Keep it live. Bring
   everyone."
6. **Story order.** The opening statement (documents go stale), then
   **Live artifacts** (`#live`: something happens, a Sidekick reads it, the
   Canvas updates, with four worked examples), then **Then, multiplayer**
   (`#scale`: 1, 3 and 30+ people), then the two parts of the product,
   Canvases, Sidekicks, and the proof (pricing, technology, team,
   comparisons). The product pages follow the same order: `/canvases/`
   leads with "Made once. Kept current." and `/sidekicks/` with "The AI that
   keeps work current."
7. **Show, don't claim.** Figure 1 is a working Canvas, not a picture: a
   launch tracker that a Sidekick updates from Linear, Slack and Granola,
   one event and one new version at a time, with the event shown beside the
   window as it lands; then Maya asks Rally what is still open, Rally
   answers from the page, and Theo comments on a row.

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
| `apps/site/src/fonts/` | Instrument Serif (roman and italic), Geist and Geist Mono, latin |
| `apps/site/public/brand/rally-mark-paper.svg` | The mark in paper, drawn on the accent (Rally's avatar, the Sidekick hexagon) |

## How it works

### Tokens

Every colour is a token on `:root`, with a light set (the default) and a dark
set under `prefers-color-scheme: dark`; a rule never names a colour itself.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f3f0e8` | `#121210` | The page |
| `--surface`, `--card`, `--page` | warm greys to near-white | lifted greys | Sunken panels, cards, a document's page |
| `--text`, `--text-2` to `--text-4` | ink `#15140f` and its opacities | paper `#eeebe2` and its opacities | Type, from headline to faint label |
| `--rule`, `--rule-2` | ink at 12% and 24% | paper at 11% and 22% | Hairlines and stronger lines |
| `--accent` | `#3341ff` | `#7d87ff` | Rally, links, the one thing to act on |
| `--maya`, `--theo`, `--priya` | vermilion, moss, ochre | same | A person's cursor, bubble and selection |
| `--plate`, `--on-plate` | ink panel, paper type | paper panel, ink type | The inverted closing band and featured price |

`--ink`, `--paper`, `--muted`, `--hairline`, `--green`, `--volt` and the other
older names are aliases of these, kept so `trust.css` and the comparison pages
resolve; new rules use the semantic names.

Type is three faces: `--display-font` (Instrument Serif, roman and italic,
tracking about -0.03em) for headlines; `--body-font` (Geist, variable) for
reading and interface; `--mono` (Geist Mono) for labels and captions. A
headline is a roman claim and an italic turn; the italic takes the accent
only in the hero, the product-page heroes and the closing band.

The Technology figure is always a dark plate, in both themes, because the
three.js scene draws light points that disappear on paper.

### Page architecture

A page is a header, a hero, then **bands**. Each `.band` opens on a ruled
index line (`.band-head`): the `.eyebrow` (a two-digit number and a name, in
mono) sits in the left margin, three twelfths wide, and the serif headline and
lede sit in the text column beside it. Content inside a band is cards on
`--card` with hairline borders and a 14px radius. The home hero sets its
headline across faint twelve-column guides, then puts the introduction and
the actions on a ruled line below it, then Figure 1. Every marketing page
ends with the `.closer` plate and the footer, whose oversized italic
wordmark closes the page.

A **highlight** (`<mark class="hl hl-maya" data-name="Maya">`) is a person's
selection: their colour behind the words, a bar at the start and their name
flag above, drawn from `data-name`. The "Why Rally" statement uses three.

The **scale** band (`.scale`) is three stages on one ruled line that ends in
an arrow. Each stage is a crowd of faces, a head count in the serif, a
heading, a sentence, and its audience labels (`.scale-states`). The labels
are the product's own: "Only you", "Specific people" and "Everyone in the
Organization" for a Canvas; "Only you", "Shared · 3 people" and
"Organization" for a Sidekick.

Shared markup is never copied between pages. A page holds a marker such as
`<!-- rally:canvas-demo -->` and `renderSiteChrome` in `site-chrome.ts`
replaces it at build time and in the dev server.

### The Canvas demo

`canvas-demo.html` is plain HTML. `site-motion.ts` steps it through six
states (Linear, Slack and Granola events, each publishing a version; Maya
asks; Rally answers while Theo comments). The tool events sit in a rail
(`.signals`) beside the window on a wide screen, above it on a narrow one,
and only the newest shows on a phone: each step adds `s<n>` to the figure, so CSS places the cursors and
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

- **The accent is Rally's.** Ultramarine marks Rally, links and the one thing
  to act on. People are never drawn in it, and Rally is never drawn in a
  person's colour.
- **Both themes, from tokens.** A colour written into a rule instead of a
  token breaks one of the two themes; check both before shipping.
- **Live first, then multiplayer.** Every page that sells Rally leads with
  artifacts that update from activity in connected tools, and follows with
  the team working from them, from one person to the whole organization.
  Copy that leads with chat, or with collaboration alone, breaks the
  positioning.
- **Every live claim names its mechanism.** A Canvas changes because a
  Sidekick, triggered by a schedule or an event in a connected tool,
  publishes a new version. Do not show a Canvas changing by itself, or a
  connector the product does not have.
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
set Barlow from the `@fontsource` packages: moving them to Instrument Serif and Geist means
shipping WOFF copies of these faces, since `opentype.js` cannot read WOFF2.
The download, Slack and 404 pages still use `styles.css`.

## Failure modes and limits

- **Fonts load late.** Every face uses `font-display: swap`; a slow
  connection shows the system serif and sans first. The four files total
  about 96 KB.
- **The demo at mid widths.** Cursors are placed in percent of the demo body,
  so they drift off their targets as the body changes shape; below 1100px
  they are hidden and below 860px the demo stacks.
- **Cross-page drift.** Blog, compare and trust markup is generated or
  written separately; a class renamed here must be renamed there.

## Testing

`apps/site/test/site.test.ts` checks the header's links, that every tracked
id is on the home page, and the footer columns. The look itself has no
automated test: it is checked in a real browser at desktop and phone widths,
in light and dark, before a change ships, as the repository's rule on visible changes requires.

## Changelog

### 2026-11-09 — The site becomes "the shared page" and leads with live artifacts

**What changed:** The marketing site was redesigned from a blank page. One
stylesheet now sets a new system: warm paper and ink in light and dark
themes, Instrument Serif, Geist and Geist Mono, a single ultramarine accent
for Rally and a colour for each person. The home page leads with an animated
live Canvas as Figure 1, leads with live artifacts (Canvases a Sidekick
updates from activity in connected tools) and follows with multiplayer;
`/canvases/` and `/sidekicks/` were added; the blog, comparison and Trust
Center pages took on the same system.

**Why:** The product owner set the order: live artifacts first, multiplayer
second. The pivot to Canvases and Sidekicks also left the home page telling an
older story, and the dark, uppercase look matched most other AI products
rather than setting Rally apart. A first pass on this branch borrowed the
launch films' dark and volt style; it was set aside for a system designed
for the site on its own terms, so the films may follow the site rather than
the other way round.

**Respect:** Keep every colour in a token and check both themes, keep the CSP
rules (no inline style or script), the tracked link ids, and product truth in
the demo. A new marketing page starts from `landing.css` and the band pattern
rather than a stylesheet of its own.
