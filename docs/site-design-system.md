# Site design system

The homepage, blog, Trust Center, and Help Center share the organic pencil
identity: warm paper, sage and ink, Instrument Serif headlines, Geist reading
text, and one coordinated illustration master. `apps/site/src/site-theme.css`
owns their shared fonts and palette. The homepage keeps its own composition;
`reading.css` provides the blog and Trust Center's reading layouts and shared
chrome, and `help.css` provides the manual's navigation and reading interface.

The product pages, `/start-fast/`, and comparison pages continue to use the
earlier `landing.css` system described later in this document. The download,
Slack, and 404 pages still load `styles.css`.

This document owns the visual decisions. The renderers and content contracts
belong to [`site-blog.md`](site-blog.md) and [`help-center.md`](help-center.md).
Tracking belongs to [`landing-page-tracking.md`](landing-page-tracking.md), and
the three.js figure to [`landing-technology-schematic.md`](landing-technology-schematic.md).

## Pencil-site boundaries

The migrated pages stay light in either system appearance. Shared type and
palette belong in `site-theme.css`; normal secondary text must remain readable
on paper, sunken surfaces and sage. The homepage owns its composition in
`home.css` and its illustrative examples in `home.ts`. Reading pages use
`reading.css`, with `trust.css` and `help.css` retaining their own layouts.

- **One artwork source:** `home-illustrations.ts` owns the 1448 × 1086 master
  and its 724 × 543 quadrant crops. `getIllustration` supplies both SVG viewports
  and raster preview crops. Update that geometry when replacing the master;
  browser and card code must not keep separate coordinates. Retain the distinct
  blue hexagonal Sidekick and compare the drawings as a set.
- **Illustrative actions:** The homepage's example Canvas is a chat beside one
  artifact, with no app sidebar. Its three examples (a Gmail pipeline dashboard,
  a Granola feature-request board with voting, a podcast feed) each draw their
  own artifact in `index.html`. The GTM example's chat also shows the Sidekick's
  delegation card, in the app's own words, with Theo and Priya allowing it to act
  as them (Maya, its creator, is enrolled already), then Theo changing its
  behavior and Rally showing the instruction it added to the Sidekick; "Run the Sidekick" only swaps local markup to
  version 2 (`data-new` rows appear, `data-v2` text replaces the original).
  They do not run jobs or connect to tools. Preserve that distinction
  and the acquisition action IDs. The historical offer action is now an inline
  browser-entry link; the timed offer card was removed.
- **One plan catalog:** Homepage pricing reads `@rally/contracts/plans`, also
  re-exported by the usage module. The separate, dependency-free entry lets
  native Node site builds consume the catalog without traversing the runtime
  schemas' extensionless imports. Trial terms are Organization-specific; the
  static FAQ directs readers to Usage settings rather than promising defaults.
- **One preview renderer:** Blog and help previews share `reading-card.ts` and
  local static TTF derivatives, avoiding network/system font dependencies.
  Titles and descriptions fit their columns before rasterization. Bump the help
  card design version when its rendering changes, since its URLs are immutable.
  Unversioned public pencil artwork and the homepage preview cache for one day.

The following decisions apply to the earlier pages using `landing.css`.

## Decisions

The decisions a future editor must keep. The story of how they were reached
is in the pull request that introduced this document (#1535); the words on
the page live in the pages and in `access-copy.ts`, not here.

1. **The shared page.** The site is set as a printed page a team works on:
   warm paper and ink, column guides, ruled section heads, captioned figures.
   It is deliberately not the dark, neon look most AI products use.
2. **Three faces, three voices.** Instrument Serif for headlines (the human
   voice), Geist for text and interface (the product), Geist Mono for labels
   and captions (what a machine would say).
3. **The accent is Rally's.** Ultramarine marks Rally, links and the one
   thing to act on. People are drawn only in their own colours.
4. **Live first, multiplayer second.** Every page leads with artifacts that
   update from activity in connected tools, and follows with the team
   working from them. The product owner set this order.
5. **Show, don't claim.** The mechanism is shown working (the hero carousel,
   then figures the reader can scrub), never only asserted.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/site-theme.css` | Shared pencil-site fonts and paper, ink, sage tokens |
| `apps/site/src/reading.css` | Blog layouts and reading-page header, footer and typography |
| `apps/site/src/reading-card.ts` | Matching blog and manual social cards from local fonts and shared artwork |
| `apps/site/src/landing.css` | The earlier product, start-fast and comparison system: tokens, chrome, demos, pricing and page layouts |
| `apps/site/src/trust.css` | Trust Center and policy layouts on top of `reading.css` |
| `apps/site/index.html` | The independently designed root homepage; see the pencil-site boundaries above |
| `apps/site/marketplace/index.html`, `apps/site/src/marketplace.css`, `apps/site/src/marketplace.ts` | The artifact marketplace: example artifacts by kind, a client-side kind filter, and links into the web app. Styles build on `home.css` |
| `apps/site/src/home-illustrations.ts` | Shared artwork geometry and accessible SVG views |
| `apps/site/src/home-pricing.ts` | Homepage plan markup from the product catalog and weekly allocation function |
| `apps/site/start-fast/index.html` | The earlier landing design, with copy from `access-copy.ts` and shared sections |
| `apps/site/src/landing-sections.html` | Sections below the hero on `/start-fast/` |
| `apps/site/src/canvas-demo.html` | The detailed launch-tracker figure on `/start-fast/` and `/canvases/` |
| `apps/site/src/steps.ts` | `applyStep`, the step primitive the Canvas demo and the carousel share, and `whenVisible` |
| `apps/site/canvases/index.html`, `apps/site/sidekicks/index.html` | The two product pages |
| `apps/site/src/site-motion.ts` | The demo's timeline and the scroll reveals |
| `apps/site/src/live-examples.ts` | The hero carousel's seven examples as data, and `renderLiveCarousel`, which writes the carousel at build time (Node only) |
| `apps/site/src/live-carousel.ts` | Plays the carousel: rotation, each slide's steps, the dot that flies from an event to the row it changed, the pause button |
| `apps/site/src/explorable-figures.ts` | Figures 2 and 4 as SVG, rendered at build time; all their geometry |
| `apps/site/src/explorables.ts` | Drives Figures 2 and 4: the time slider and playback, and the people slider |
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
`--card` with hairline borders and a 14px radius. The `/start-fast/` hero sets its
headline across faint twelve-column guides, then puts the introduction and
the actions on a ruled line below it, then Figure 1. Every marketing page
ends with the `.closer` plate and the footer, whose oversized italic
wordmark closes the page.

The hero stacks three equal-width actions vertically: web entry, macOS download,
then Linux x64 Debian download, labeled Linux (.deb). The group is rendered by
`rally:desktop-downloads` on `/start-fast/`. At narrower widths the
hero columns stack and the buttons fill the available width on small screens; touch-only devices retain the web
entry as their action.

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

Pricing uses a two-column card grid for Start, Grow, Max and Ultra, stacking to
one column at the existing phone breakpoint so the Ultra price stays legible.

### Steps: the demo and the carousel

Both the launch-tracker demo and each carousel slide are drawn at build time
at their last step, so they read without a script. `applyStep` (`steps.ts`)
puts one at any step n: `s1` to `s<n>` on the root for CSS that places things
per step, `is-on` on every `[data-at]` at or below n, `is-done` on every
`[data-done]` at or below n, `is-current` on the `[data-status]` equal to n,
and `is-new` on what changed at n when the step is played rather than set.
Each caller owns its timing (`STEP_HOLD`) and runs only while on screen
(`whenVisible`).

The demo (`site-motion.ts`) plays three tool events, each publishing a
version, then Maya asking and Rally answering while Theo comments. Its tool
events sit in a rail (`.signals`) beside the window on a wide screen, above it
on a narrow one, and only the newest shows on a phone.

### The hero carousel

An example is data: its audience, artifact, Sidekick, three events, rows,
a status line per step and a payoff (`LiveExample` in `live-examples.ts`).
`renderLiveCarousel` turns all seven into tabs and slides, each slide in its
finished state, so the page reads without a script. `live-carousel.ts` then
plays one slide at a time with `applyStep`: step 0 is the page before, steps 1 to 3 are tool
events (rows arrive with `at`, are ticked with `done`, the version and byline
move on, a dot flies from the event to the row), and step 4 is a person
ticking what they own, with the payoff card. A row with `approve` is ticked
in the accent and stays at full strength, so "advance this candidate" never
reads as "crossed off". Ranks are a CSS counter over the rows that have
arrived. A slide's height is the tallest slide's, so rotating never moves the
page. A click on a tab plays that slide from the start; the pause button
stops rotation.

To add an audience, add an entry to `liveExamples`. Its events must be ones a
Sidekick can be started by, as the help center's Triggers and schedules page
lists them; a tool read on a schedule (Google Drive, Calendar) is labelled
as the schedule. Every example is a **Site**: its people tick rows, and
nobody types into a Document or Spreadsheet directly, while a reactive site that
remembers things takes visitors' entries and a Sidekick's runs write rows
into it.

### Moving content

Anything that moves on its own for more than a few seconds has a pause
control (WCAG 2.2.2): the carousel and the Canvas demo each have a pause
button, and Fig. 02 a play and pause button. The connector names are a static
list, not a marquee. Only a person's choice scrolls the carousel's tab row:
an automatic scroll would count as page input in `traffic-signals.ts`.

### Explorable figures

Figures 2 and 4 draw any state from scratch from one input, a time `t` or a
head count, so playing, scrubbing and reduced motion are the same code.
Their SVG is rendered at build time from `explorable-figures.ts`, which owns
every coordinate and every word, including the Sidekick's status lines
(`data-arriving`, `data-reading` on each tool) and the version labels; the
client reads those, moves a pulse along a path, sets transforms and opacity,
and toggles classes. Figure 4 counts only what is true at any size (people,
copies of the page, seats); it does not pretend to pick a share setting. Figure 2 plays while on screen
until the reader touches it. On a phone a figure keeps a minimum width and
scrolls sideways rather than shrinking its labels. Figure numbers are a CSS
counter, so moving or reusing a figure never leaves a stale number.

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

### 2026-11-16 — Reactive, multi-human artifacts on the homepage, and a marketplace

**What changed:** The hero now says Rally creates reactive, multi-human
artifacts. The example Canvas dropped its app sidebar and shows three different
artifacts (dashboard, voting micro-app, podcast feed) instead of three task
lists. The Sidekicks band and the "See how Rally compares" block left the
homepage. A static `/marketplace/` page lists example artifacts by kind.

**Why:** The product owner repositioned the homepage around reactive artifacts
that a team shapes together, and asked that the examples look different from
one another. Three task lists in one template could not show that.

**Considered and rejected:** Keeping one shared document template filled from
data. It made every example look the same, which was the complaint.

**Consequences:** Each example's artifact is its own markup, so a new example
needs new markup and styles, not only data. The marketplace is illustrative:
there is no marketplace in the product, and its cards open the web app. The
`demo-request` link moved to the closing band and keeps its `sidekicks`
placement so its history stays comparable.

### 2026-11-12 — A pencil identity for the homepage and reading pages

**What changed:** The homepage has an independent pencil composition and manual
Canvas/Sidekick examples. Blog, Trust Center and help share its theme and artwork;
pricing reads the current product catalog. The earlier homepage remains at
`/start-fast/`.

**Why:** The requested direction was a fresh design around the current product.
A shared theme and illustration master keep the new pages consistent, while
pricing from the product catalog avoids a second set of plan amounts.

**Considered and rejected:** Restyling `landing.css` would carry the earlier
carousel and figures into a brief that asked for a fresh start, and would change
product/comparison pages outside the migration. Generating scenes independently
caused style drift, so browser views and card crops share one coordinated master.

**Consequences:** Shared brand changes belong in `site-theme.css`. Keep one
homepage rule per selector and breakpoint, one source for artwork geometry,
illustrative-only demo actions, catalog-driven pricing, and acquisition IDs.

### 2026-11-09 — The site becomes "the shared page" and leads with reactive artifacts

**What changed:** The marketing site was redesigned from a blank page: one
stylesheet with light and dark tokens, three typefaces, a single accent for
Rally and a colour per person. The home page leads with a carousel of reactive
artifacts, one per audience, explains the mechanism with scrubbable figures,
and follows with multiplayer. `/canvases/` and `/sidekicks/` were added, and
the blog, comparison and Trust Center pages took on the same system.

**Why:** The product owner set the order, reactive artifacts first and
multiplayer second, and the pivot to Canvases and Sidekicks had left the home
page telling an older story. A first pass borrowed the launch films' dark,
volt style; it was set aside for a system designed for the site, so the films
can follow the site.

**Respect:** Every colour in a token, checked in both themes; no inline style
or script; the tracked link ids; product truth in every figure.
