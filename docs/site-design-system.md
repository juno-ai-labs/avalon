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

## Homepage: the Rally neighborhood

The root homepage uses the approved organic colored-pencil direction: loose
pencil contours, simple graphite eyes and smiles, restrained shading, natural
poses, and clear space around each scene. A peach rectangular-headed colleague
in lilac and a sage triangular-headed teammate appear in the Canvas and closing
scenes. The Sidekick is a distinct cornflower-blue character with a softly
rounded hexagonal head, echoing the product's avatar, in the handoff scene.
The background stays transparent; a brown wash or fuzzy halo is not part of the
art direction.

Warm paper, sage, lilac, peach, blue, and ink stay light in either browser
appearance. Instrument Serif roman sets the headlines, Geist sets the copy and
interface, and Instrument Serif italic sets the illustration captions and the
example requests. Sections use open space and asymmetrical arrangements rather
than a series of bordered cards.

- `apps/site/index.html` owns the complete root page and metadata. It uses
  build-time markers for the illustrations and shared footer, plus the existing
  telemetry entry. The earlier carousel, technology scene, `landing.css`, and
  shared landing sections are not loaded on the homepage.
- `apps/site/src/home.css` owns its responsive layout, typography, local color
  tokens, and the soft pencil composition. The Canvas example remains a clear
  product window; the surrounding illustrations are freeform vignettes.
- `apps/site/public/illustrations/rally-pencil-master.webp` is the single
  coordinated artwork, 1448 × 1086 pixels. The upper-left quadrant is the Canvas
  scene, upper-right the Sidekick handoff, and lower-left the closing scene;
  lower-right is transparent. Editing scenes independently caused their faces,
  textures and shading to drift. Update and compare the complete set together.
- `apps/site/src/home-illustrations.ts` renders each scene as an accessible SVG
  view of that master, clipped to a 724 × 543 quadrant with its own clip id and
  description. The browser downloads the image once. Preserve the dimensions
  and offsets when replacing the master; nothing should cross a quadrant edge.
  The homepage preloads the artwork and headline font.
- `apps/site/public/rally-pencil-social.png` is the matching social preview.
  Update it when the headline or hero artwork changes.
- `apps/site/src/home.ts` controls three **illustrative** examples: a launch
  plan, meeting follow-ups, and a weekly update. Tabs support arrow keys, Home,
  and End. The Sidekick button applies a deterministic example change and
  announces the simulated receipt; it never connects to a tool or starts a
  real job. Choosing a different example resets its state. The launch example
  is fully readable in the server HTML without JavaScript.
- Signup, platform download, pricing, demo, and support action IDs survive.
  `web-app-offer` is now the inline browser-trial link below pricing; there is
  no timed pilot popup on the homepage. `/start-fast/` retains its earlier
  design and shared sections.

The homepage adds no automatic animation or theme switch. Reduced motion
turns off smooth scrolling and hover transitions. FAQs use native `details`;
all content and links remain available without JavaScript. The examples do not
imply that people directly edit the generated document: they ask in Chat and a
Sidekick publishes a new version.

Homepage pricing is rendered at build time by `home-pricing.ts` from the
product catalog in `@rally/contracts/plans`. Start is free, followed by Grow,
Max and Ultra. Prices, included effective usage, and weekly allocations come
from that catalog rather than a second set of numbers in the homepage. Every
plan includes Canvases, Sidekicks and connected tools with one Organization-wide
quota and no seat limit; the tiers do not impose team-size recommendations.
The open four-column layout becomes two columns on smaller desktops and one
on phones, with Grow retaining its irregular sage backing. FAQs explain the
creation-time trial, its team extension, and optional paid-plan overages.

## Reading pages

`reading.css` loads the shared theme and owns the blog's index, articles, header,
and footer. The latest post stays complete on the index and older posts keep
their summaries. The cover pairs a large serif heading with the walking
colleagues; articles use a quieter 820px reading column. The Trust Center loads
`trust.css`, which imports the same reading base: its directory and controls
are open rows and columns, policies have a quiet navigation rail, and tables
scroll within their own wrapper on phones. Policy text, dates and anchors stay
in the existing HTML files. The overview uses the shared-plan pencil scene.

The Help Center imports the shared theme directly into `help.css`; it keeps its
own search, chapter navigation, outline and Markdown controls. Its cover uses
the blue hexagonal Sidekick and an open two-column chapter directory, followed
by the original introduction. Articles use sentence-case serif titles and
Geist text, with the same paper and sage accents. These pages stay light in
either system appearance, matching the homepage. Alert and syntax colors remain
separate semantic tokens. Print styles omit navigation and cover illustrations.

`reading-card.ts` renders blog and help link previews from the same type and
pencil master. Checked-in static TTFs, derived from the local WOFF2 faces, supply
font outlines without relying on system fonts or network access. The Help
Center's card design version changes when its look changes, so immutable image
URLs refresh. The earlier comparison cards retain their separate renderer.

The following decisions and implementation details apply to the supporting
pages that continue to use `landing.css`.

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
| `apps/site/src/landing.css` | The whole system: tokens, type roles, buttons, header, footer, bands, the demo, bento, timeline, pricing, product-page rows, and the blog, compare and Trust Center layouts |
| `apps/site/src/trust.css` | Trust Center and policy layouts on top of `reading.css` |
| `apps/site/index.html` | The independently designed root homepage; see the neighborhood section above |
| `apps/site/src/home-illustrations.ts` | The three accessible views of the coordinated homepage artwork |
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
nobody types into a Document or Spreadsheet directly, while a live site that
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

### 2026-11-12 — A pencil identity for the homepage and reading pages

**What changed:** The root homepage now uses a coordinated set of organic pencil
illustrations, serif headlines, open layouts, a manual Canvas/Sidekick example,
and its own stylesheet. One artwork master supplies all three scenes, including
the blue hexagonal Sidekick. The blog, Trust Center and manual now share its
palette, type and artwork, including matching blog/help link previews. Pricing
uses the current Start, Grow, Max and Ultra catalog, and the entry copy leads with the free Start plan.
The previous homepage sections remain in use by `/start-fast/`.

**Why:** The requested direction was a fresh design inspired by Val Town,
independent of earlier marketing designs. The selected pencil drawings make the
product feel human; consistent faces, linework and shading matter across scenes.
The examples explain Canvases and Sidekicks without inventing testimonials or
product behavior. The new free tier and expanded paid catalog also require
usage-based comparisons rather than the previous team-size recommendations.

**Considered and rejected:** Restyling `landing.css` would couple the new
direction to the supporting pages and carry their earlier carousel and figures
into a brief that explicitly asked for a fresh start. The homepage instead
owns its composition, illustrations, and small manual example. Generating the
scenes separately also caused visual drift, so they now share one coordinated
master rather than three independently rendered files.
Pricing reads the product's dependency-free catalog instead of duplicating
plan amounts in marketing HTML; metering retains its existing catalog exports.

**Consequences:** Changes to the root page belong in `home.css` and `home.ts`,
with shared type and palette changes in `site-theme.css`. Its example actions
must stay clearly illustrative. Keep the artwork consistent as a set, including the hexagonal blue
Sidekick, and preserve its clip geometry. Render pricing from the shared product
catalog so future plan changes do not leave the homepage's numbers behind.
Keep acquisition IDs and CSP restrictions intact; the root
page no longer runs the timed pilot offer.

### 2026-11-09 — The site becomes "the shared page" and leads with live artifacts

**What changed:** The marketing site was redesigned from a blank page: one
stylesheet with light and dark tokens, three typefaces, a single accent for
Rally and a colour per person. The home page leads with a carousel of live
artifacts, one per audience, explains the mechanism with scrubbable figures,
and follows with multiplayer. `/canvases/` and `/sidekicks/` were added, and
the blog, comparison and Trust Center pages took on the same system.

**Why:** The product owner set the order, live artifacts first and
multiplayer second, and the pivot to Canvases and Sidekicks had left the home
page telling an older story. A first pass borrowed the launch films' dark,
volt style; it was set aside for a system designed for the site, so the films
can follow the site.

**Respect:** Every colour in a token, checked in both themes; no inline style
or script; the tracked link ids; product truth in every figure.
