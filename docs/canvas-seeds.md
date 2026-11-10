# Canvas seeds

A **Canvas seed** is a Canvas Rally means to copy into an Organization rather
than have a person start: its site's files, checked in under `canvas-seeds/`.
There is one, **Getting Started with Canvases**, the guide a new Organization
is meant to find in its Canvases list.

**Nothing copies a seed into an Organization yet.** What exists is the guide's
site and a local preview that runs it. Creating an Organization still seeds
nothing ([`new-user-onboarding.md`](new-user-onboarding.md)); the copy is the
next piece of work and is listed under [Open questions](#open-questions). Read
this before changing the guide, and before building that copy.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `canvas-seeds/getting-started-with-canvases/site/` | The site, as it would be published: one directory, the shape [`live-web-artifacts.md`](live-web-artifacts.md) serves. |
| `…/site/index.js` | `SiteData`: the server and the stored data. The one place a step is decided done. |
| `…/site/index.html` | Every word of the guide. A step's copy is edited here and nowhere else. |
| `…/site/app.js`, `styles.css` | Fills in what the server knows (greeting, done steps, the wall); the 400px-first stylesheet. |
| `…/site/README.md` | What Rally reads before answering in the guide's Chat: how to behave, and the statement to send for each step. |
| `canvas-seeds/getting-started-with-canvases/preview/` | A local Worker that hosts the site: `pnpm preview:canvas-guide`. Ships nowhere. |

## How it works

The guide is a stateful live site: six steps above a shared wall of idea cards
people add and vote on. Each step has the person do one real thing, on the page
or in the Canvas's Chat.

| Step | Where | Ticked by |
| --- | --- | --- |
| `use_the_page`: add a card, vote for one | Page | The stored rows |
| `ask_rally`: ask Rally to add ideas | Chat | The cards Rally inserts with `asked_by_id` |
| `comment`: Comment mode on the wall's title | Page, then Chat | A row Rally writes |
| `make_it_yours`: team name and a section of their own | Chat | A row Rally writes. Team step |
| `teammate`: a second person adds a card | Together | The stored rows. Team step |
| `own_canvas`: copy a starter prompt | Page | The page, on copy |

A step the stored rows already prove is read from them (`SiteData.steps`); the
rest are rows in `guide_steps_done`. Team steps are done once for everyone and
name who did them; the other four are per person. Anyone can tick a step by
hand, so a row Rally forgot to write leaves nobody stuck.

**The page cannot post to the Chat.** A live site has no such bridge
([`live-web-artifacts.md`](live-web-artifacts.md)), so each Chat step shows a
prompt with a copy button, filled in from what the person types beside it.

**Rally's side is the README.** The site's `README.md` is the only thing that
tells Rally this Canvas is a tutorial: it gives the `write_artifact_data`
statement for each step and the rules for revising the site. There is no
special system prompt and no guide-specific code in the product.

**The preview** (`preview/worker.js`) composes `SiteData` the way Rally's
facet host does, on workerd with real Durable Object SQLite, and supplies what
Rally would: the viewer headers, the published files, the artifact
Content-Security-Policy, and the Chat's row writes. `/__preview` frames the
page with a switch between three people, buttons that send the README's
statements as Rally, a 400px pane width, and a reset.

## Invariants

- **No table has a `private_to_viewer` column.** On a site with one, a
  `write_artifact_data` asked for by anyone but the site's author is refused
  with `private_rows`, so step 2 would work for one person in the Organization
  and fail for the rest. Guide progress is therefore stored in a shared table.
  No automated guard.
- **The site answers 401 without `x-rally-viewer-id`**, before routing and
  before serving a file. The wall shows people's names and a site is public by
  default. Verified in the preview (`/?signed-out`); no automated guard.
- **The statements in `site/README.md` match the schema in `site/index.js`.**
  Rally sends what the README says; a renamed column there fails in a person's
  first conversation. The preview's Rally buttons send the same statements,
  which is the check. No automated guard.
- **The wall updates card by card and the steps' HTML is never re-rendered.**
  A full re-render on each poll would detach the element a person is
  commenting on in Comment mode. Verified visually, no automated guard.
- **The schema only grows.** A copy's data outlives every version Rally
  publishes of it in that Organization.

## Boundary

The seed owns the guide's files. It does not own how a site is served, stored
or versioned ([`live-web-artifacts.md`](live-web-artifacts.md)), Comment mode
([`artifact-annotations.md`](artifact-annotations.md)), or what a Canvas is
([`canvases.md`](canvases.md)). It depends on the viewer headers, the asset
binding and `write_artifact_data` exactly as any site Rally builds does, and on
nothing else. The preview is a development tool and no test or deploy reads it.

## Failure modes and limits

- **A request fails:** the wall says so and the person tries again. Polling
  backs off with jitter and never speeds up.
- **The viewer's session ends:** the page stops polling on 401 or 403 and shows
  a sign-in link. For that reason the site's own refusals never use 403.
- **The clipboard is refused** (a framed page is not granted the clipboard
  API): the page falls back to the older copy command, and failing that
  selects the prompt's text.
- **Rally does not write a step's row:** the person ticks the step by hand.
- The poll interval is 4 seconds. There is no cap on a card's length or on the
  number of cards; neither has been asked for.

## Testing

No suite covers the seed yet. It was verified by driving the preview in a
browser as three people through all six steps, at 400px and 1280px, light and
dark. A runnable test belongs with the copy, where the site first runs behind
Rally's own facet host (`apps/api/test-workers/artifact-facet.test.ts` is the
pattern).

## Open questions

- **The copy.** A generic "seed a Canvas from a bundle" step after
  Organization creation: title, appearance, the whole Organization as
  audience, an opening message from Rally, and this site. It needs three
  things production cannot do today: publish a site that has an `index.js`
  without Rally's sandbox, write a Rally message without running a model, and
  decide who the Canvas's creator is.
- **Who the site's author is.** It decides whose `write_artifact_data` calls
  the product treats as unscoped, and matters only if a table ever becomes
  private.

## Changelog

### 2026-11-10 — The guide's site, and a preview to run it

The owner asked for a Getting Started Canvas copied into every new
Organization, and chose to see the page before committing to the copy. So the
site is checked in on its own, with a local preview, and nothing seeds it yet.

Decided with the owner: one guide per Organization rather than one per person;
copy-to-clipboard buttons rather than a page-to-Chat bridge; a seeded opening
message from Rally that says it can tell which messages are meant for it, with
no tagging; and people land on the Canvases home and open the guide themselves.

Progress was first drawn as a per-viewer private table. It is shared instead,
because one private table makes every other member's row writes fail (see
Invariants). A future change that wants private data in a seed has to solve
that first.
