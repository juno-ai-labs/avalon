# Site audience pages and stories

The public site sells one use first: connect Gmail and get a dashboard, board
or table of your work in five minutes. The homepage makes that case for
everyone, and each audience Rally targets has its own page at `/for/<slug>/`
that makes it in that audience's words and can be linked to directly from an
ad or an email.

Every one of those pages shows the product the same way: a **story**, an
example page drawn without any app chrome that changes as emails arrive. This
document owns the audience pages, the story player and the kit of page pieces
stories are drawn with. The look of the pencil pages belongs to
[`site-design-system.md`](site-design-system.md), the header and footer to
[`site-chrome.md`](site-chrome.md), and what the pages report to
[`landing-page-tracking.md`](landing-page-tracking.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/site/src/audiences.ts` | The audiences, in homepage order: slug, name, one line, the Marketplace template its page starts, and the headline and pitch of each page's link preview. Also the homepage grid, the "other audiences" list and `/for/sitemap.xml`. |
| `apps/site/for/<slug>/index.html` | One audience's page. Hand-written, not rendered from a template. |
| `apps/site/src/for/<slug>.css` | That page's own layout, artifacts and motion. Imports `home.css`. |
| `apps/site/src/story.ts` | The story player: steps, tabs, pause, the stage's height, the `story:step` event. |
| `apps/site/src/story.css` | The player's styles and the kit (`kit-*`): pills, faces, boards, rows, stats, checklists, timelines. Imported by `home.css`. |
| `apps/site/src/steps.ts` | `applyStep`, the step primitive the player shares with the earlier demo and carousel. |
| `apps/site/src/home-story.html` | The homepage's hero story: one slide per audience, each a different kind of page. |
| `apps/site/src/word-swap.ts`, `apps/site/src/home.ts` | The homepage headline's two words, which follow the hero story's slide. `home.ts` loads it before the player. |
| `apps/site/src/home-header.ts` | The header of every pencil page. |
| `packages/skills/marketplace-skills/<category>/` | Each audience's template: the request its page's buttons start a new person on ([`desktop-shell.md`](desktop-shell.md)). |
| `apps/site/developer-mode/index.html` | The page for everything that is not an inbox: the general-purpose pitch and the three-example Canvas, played by `src/canvas-example.ts`. |

## How it works

### An audience page

A page is a file. It holds markers for what is shared (`<!-- rally:home-header -->`,
`<!-- rally:site-footer -->`, `<!-- rally:audience-others <slug> -->`,
`<!-- rally:gmail-mark -->`, `<!-- rally:arrow -->`) and writes everything
else itself: its headline, its sections, its example pages and how they move.
It links its own stylesheet and `/src/story.ts`.

The pages are deliberately not one template filled seven times. A recruiter
and an in-house lawyer do not track the same things, read the same words or
trust the same proof, and a page that only swaps nouns reads as a form letter.
Each page has its own layout, its own artifacts and its own motion. What they
share is the promise (Gmail in, one page out, five minutes), the pencil look,
and the parts below.

Every sign-up button on an audience page links to that audience's Marketplace
template on the web app, `/app/templates/<template>`
([`links.md`](links.md#template-links)). The link signs the person up and opens
a Canvas whose first message is already the request for their page (an order
board, a docket, a checklist), so the first thing a new person does is answer
Rally's one or two questions, not work out what to type. That is what stands
behind "five minutes".

Adding an audience is a row in `audiences.ts`, its template and the two files. The row puts
the page in the homepage grid, the footer, the other pages' lists, the sitemap
and `llms.txt`, registers it as a build entry, and draws its link preview from
`headline` and `pitch`. The build fails if `headline` is not the page's `<h1>`.

### A story

A story is drawn at its last step, so it reads with no script. `story.ts`
rewinds it and plays it forward: step 0 is the page as first built, and each
later step is one email and what it changed.

Every step tells the same small story, so a reader learns it once and
recognises it in every example on every page: **an email arrives as a little
Gmail card, travels on and fades away, and as it goes a value on the page
changes.** Emails come in, the page updates. How the card travels is each
example's own: floating down from the top, crossing from left to right, or
several landing together as a burst.

```html
<div class="story" data-story>
  <div class="story-bar">
    <div class="story-tabs" role="tablist" aria-label="…">
      <button type="button" role="tab" id="…" aria-controls="…" aria-selected="true">
        Order board<i class="story-progress" aria-hidden="true"></i>
      </button>
    </div>
    <button class="story-pause" type="button" data-story-pause hidden
      aria-label="Pause the example" aria-pressed="false"></button>
  </div>
  <div class="story-stage">
    <article class="story-slide" data-slide role="tabpanel" id="…" aria-labelledby="…">
      <div class="story-mail">
        <div class="story-ask" data-until="1">…the sentence a person types…</div>
        <div class="story-email" data-at="1" data-until="2">…the first email…</div>
        <div class="story-email" data-at="2" data-until="3">…</div>
        <div class="story-email" data-at="3">…</div>
      </div>
      <div class="story-page">…the page the emails change…</div>
    </article>
  </div>
</div>
```

Everything that changes says when, with five attributes, inside a
`.story-mail` or a `.story-page`:

| Attribute | Meaning |
| --- | --- |
| `data-at="n"` | Appears at step n. |
| `data-until="n"` | Is gone from step n. A value that changes is two elements: the old one with `data-until`, the new one with `data-at`. |
| `data-done="n"` | Gets `is-done` from step n: a tick, a finished row. |
| `data-touch="1 3"` | Gets `is-touched` when one of those steps plays, for a highlight. |
| `data-key="x"` | Two elements with one key, one leaving and one arriving at the same step, are one thing that moved: the arrival slides in from where the other sat. |

On the slide, `data-steps` sets how many steps it has (3 if left out). On the
story, `data-story-manual` keeps it on the slide a person chose and replays
that one. A story with one slide needs no tabs.

The player only keeps time. A step lasts 4.2 seconds: the email arrives at
once (`is-new`), at 1.9 seconds it starts to leave (`is-leaving` replaces
`is-new` on whatever in `.story-mail` arrived this step), and at 2.4 seconds
the page changes, so the eye reads cause, then effect. The player sets `s1` …
`s<n>` on each `.story-mail` and `.story-page`, the classes above, and `is-new`
on what arrived, then sends `story:step` (with `detail.step`) from the slide.
When a slide comes up it sends `story:slide` (with `detail.slide`) from the
story. How a change looks is the page's own stylesheet: a rule on `.s2 .thing`,
a transition, an animation on `.is-touched`. A page that needs more than CSS
listens for `story:step` in its own script.

`story.css` gives an email its look and three ways to travel, which a page
uses or replaces with its own rules on `.is-new` and `.is-leaving`:

- **Down**, the default: the card floats in from above, then keeps sinking
  toward the page and dissolves into it.
- **Across**, `data-flow="across"` on the `.story-mail`: in from the left, out
  to the right.
- **A burst**, several cards in a `<div class="story-burst" data-at="n">`: the
  first is the email the page acts on, the rest (`is-small`) are other mail
  landing at the same moment, each a beat behind the last. On a phone the
  small ones sit in a row under the first.

A story starts once a person has scrolled to it (its top has come into the
upper 70% of the screen, or they picked one of its tabs), and from then on
plays while any of it is on screen.

The stage is held at the height of its tallest slide's last step, and the mail
slot at the height of its tallest message, so playing never moves the page
below. Stories run only while on screen.

### The homepage's headline

The homepage's examples are seven different kinds of page (a dashboard, a
board, a pipeline, a table, a tracker, a checklist, a timeline), because the
pitch is a single view onto your work in whatever shape suits it, not
dashboards only. The headline says so: "Get a dashboard of your leads" becomes
"Get a board of your orders" with the story. Each slide carries `data-kind` and
`data-word`, and each word in the `<h1>` names the story and the attribute it
shows:

```html
<span class="swap" data-swap="home-story:word"><span class="swap-now">leads</span></span>
```

`word-swap.ts` hears `story:slide` and changes both words together. The
headline wraps on its own, so a longer word can turn its lines somewhere else;
every word is measured before and after and glides to its new place, while the
old word drifts up and the new one rises in. The `<h1>` keeps room for its
longest wording so nothing below it moves.

### The kit

`story.css` holds plain page pieces under `kit-`: `kit-head` (the page's
title) with `kit-live` (the mark that it updates itself, and from one inbox or
several), `kit-face`,
`kit-pill` (`new`, `wait`, `late`, `good`), `kit-board`, `kit-rows`,
`kit-table`, `kit-stats`, `kit-matrix` and `kit-tick`, `kit-steps`,
`kit-timeline`, `kit-meter`. A page
uses them where they fit and draws its own artifact where they do not. The
homepage story uses only the kit.

## Invariants

- **Every claim is something the product does.** Rally searches and reads
  Gmail. When asked, it also writes drafts, sends mail, and labels, archives,
  marks as spam or moves mail to Trash; it has no tool that deletes mail for
  good ([`google-workflows.md`](google-workflows.md#inbox-management)). So a
  page may say "a page like this only needs to read" and "Rally cannot
  permanently delete mail", and must not say Rally cannot change a mailbox.
  A page updates when an email arrives or on a schedule. Several people's
  inboxes feed one page when each of them connects their own Gmail and allows
  it. Pages can be shared with teammates, with a guest by email, or with
  everyone, and can send email and push notifications. Rally does not connect
  to Outlook, and a story must not show Rally reading inside an attachment or
  a tool it has no connector for. A false claim on a page aimed at one trade
  is the first thing that trade notices. Verified by review, no automated
  guard.
- **Every example says it updates itself.** Whichever page a story shows, it
  carries the `kit-live` mark ("Updates itself from your Gmail", or its own
  equivalent), the copy beside it says so in plain words, and every change in
  the animation is caused by an email, never by a person clicking. A reader who
  takes the example for a spreadsheet they would have to keep up has missed the
  product. The player pulses `kit-live` (`is-updated`) on each step. Verified
  visually.
- **Mail arrives, leaves, and the page changes.** In every example an email is
  a little Gmail card (the mark, the sender, the subject, what Rally did) that
  comes in, travels and fades, with the page's value changing as it goes. No
  email stays on screen after its step, and nothing on a page changes without
  one. The flow may differ between examples; the idea may not, because it is
  the one thing a reader is meant to take from every example. A burst is
  honest: each extra card either changes the page too or is plainly other
  mail. Verified visually.
- **Nothing plays before it is scrolled to.** A story below the fold that has
  already run when the reader arrives has shown its point to nobody. Guard:
  `starts only once a person has scrolled to it`.
- **Plain words on the homepage and audience pages.** No "Canvas", "Sidekick",
  "reactive" or "artifact": these readers have not met the product. The
  product's own names appear on `/canvases/`, `/sidekicks/` and
  `/developer-mode/`. Verified by review.
- **A story reads with no script, and at any width.** Drawn at its last step;
  nothing is hidden unless the player has run (`.story.is-live`). No fixed
  widths that overflow a 390px screen. Verified visually.
- **Text wraps on its own.** No `<br>` and no other forced break on the
  homepage, the audience pages or `/developer-mode/`: headings use
  `text-wrap: balance`, paragraphs `pretty`, and a `max-width` sets the measure.
  A hand-placed break is right at one width and wrong at the rest, and these
  pages are read on phones first. Verified visually.
- **Anything that moves has a pause.** A story plays for longer than five
  seconds, so its bar carries the pause button (WCAG 2.2.2). The homepage
  headline's word changes only with the story, so the same button stops it.
- **Only a person scrolls.** Autoplay never scrolls the tab row or the page:
  `traffic-signals.ts` reads scrolling as a person's input.
- **No inline style or script.** The site's Content-Security-Policy is
  `style-src 'self'; script-src 'self'`. A `style=""` attribute works in the
  dev server and is blocked in production. Sizes that vary go through classes
  or attributes (`kit-meter[data-fill]`), and motion through the stylesheet or
  the Web Animations API.
- **Sign-up links start the audience's template, and are tracked.** Every link
  to the web app on an audience page is its row's template link and carries
  `data-site-action="web-app-template"` (`sign-in-header` in the header), so its
  click and the signup that follows are joined; the page's path says which
  audience it was. A template renamed or dropped from the catalog would send
  every visitor to an empty Canvases home, because a slug the catalog does not
  hold starts nothing. Guard: `starts each audience page from its own
  Marketplace template`.
- **A page's headline is its row's `headline`.** Guard: the `rally-page-cards`
  build plugin.

## Boundary

This module owns `/for/`, the homepage's hero story, the story player and the
kit. It does not own the app. An audience page hands a person to the app
through its template link and nothing else: the web app drops a query on its
root at sign-in ([`links.md`](links.md#template-links)), so nothing is passed in
the URL beside the template's own path. The templates' words are product
content that the app's Marketplace also offers; they live with the other
templates and follow [`writing-skills.md`](writing-skills.md). The homepage and
`/developer-mode/` still open the web app's front door.

Examples are illustrations. They run no jobs and read no mail.

## Failure modes and limits

- **No script, or reduced motion:** every slide shows its last step. With no
  script the slides of a story stack one after another; with reduced motion the
  tabs still switch slides and nothing plays.
- **Late fonts:** the stage is measured again when the web fonts arrive, since
  they change every height.
- **A missing page file:** `audiences.ts` registers each slug as a build entry,
  so a row without its `for/<slug>/index.html` fails the build.
- **Phones:** a board keeps three columns at 390px, so card titles stay short
  (about 14 characters) and details shorter than a line.

## Testing

`pnpm --filter @rally/site exec vitest run test/site.test.ts` renders the
shared header, the footer's audience column, the audience grid and sitemap,
and checks the tracked ids on the homepage. `test/story.test.ts` plays a story
in jsdom and checks each step's state (the email arriving, leaving, and the
page changing after it) and that it waits to be scrolled to, and `test/word-swap.test.ts` checks the
headline's words follow a slide. How a page looks and moves has no
automated test: run `pnpm --filter @rally/site dev`, open the page at 1440px
and 390px, and watch each story through, as the repository's rule on visible
changes requires.

## Changelog

### 2026-11-19 — The site leads with Gmail, with a page per audience

**What changed:** The homepage's pitch changed from "reactive, multi-human
artifacts" to "connect Gmail, get a dashboard in five minutes", in plain words
with no product vocabulary. Seven audiences (wholesalers, agencies, in-house
legal, accountants, recruiters, brokers, event planners) each got a
hand-written page at `/for/<slug>/`. The homepage's three-example Canvas, its
capability list and its general pitch moved to `/developer-mode/`, named as a
nod to the readers it is for. A story
player and kit replaced the homepage's hero drawing.

**Why:** The product owner chose one first use to sell: people who run their
work from email, alone or as a team, and who do not use a tracker such as Jira
or Linear, so the state of their work lives in their heads. They are far less
technical than the earlier audience, and the earlier homepage asked them to
understand an abstraction before it showed them anything they would want.

**Considered and rejected:** One template rendered from a table of audiences.
It was built first and thrown away: the product owner asked that no page be a
copy of another with the nouns changed, in layout, artifacts or motion. Pages
are files so that each can be shaped to its reader. Passing the audience to the
web app in a query was also dropped, because the app loses a root query at
sign-in and the click's path already names the audience. Sending every audience
to the app's front door was the first version: it left a new person in an empty
app to work out what to ask, so each page now starts a Marketplace template
written for it.

The first version of the examples left each email on screen until the next
one replaced it, and each page drew its emails its own way, some as wide
strips. The product owner asked for one idea a reader meets everywhere: little
Gmail cards that arrive, travel and dissipate while a value updates. So the
leaving is in the player (`is-leaving`), the card's look and three flows are in
`story.css`, and a page chooses a flow instead of inventing a presentation.

**Consequences:** Seven pages means seven places a claim can go stale; the
invariants above are the list to check each against. A page and its template
describe the same thing in two places, so a change to what a page promises is
a change to its template's request too. Shared behavior belongs in
`story.ts` and the kit, never copied between pages, and a page's own look
belongs in its own stylesheet. The earlier hero carousel (`live-examples.ts`,
`live-carousel.ts`) still serves `/start-fast/` and is untouched.
