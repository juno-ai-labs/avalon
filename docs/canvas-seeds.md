# Canvas seeds

A **Canvas seed** is a Canvas Rally copies into an Organization rather than a
person starting it: a title and a look, the first message of its Chat, and one
site. There is one, **Getting Started with Canvases**, the guide every new
Organization is given.

A seed is data, and copying it is the product's own paths called in order. A
seeded Canvas is an ordinary Canvas afterwards. Read this before changing the
guide, adding a seed, or changing what a new Organization starts with.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `canvas-seeds/getting-started-with-canvases/site/` | The guide's site, as it is published. The single copy of its files; `README.md` there is written for Rally. |
| `canvas-seeds/getting-started-with-canvases/preview/` | A local Worker that hosts the site: `pnpm preview:canvas-guide`, then `/__preview`. Ships nowhere. |
| `apps/api/src/canvas-seeds/` | The seed (the site's files as text, the title, the look, Rally's opening message) and the registry of seeds. |
| `apps/api/src/services/canvas-seed-service.ts` | `CanvasSeed`, the `canvas_seed` job, and `seedCanvas`. The one implementation of the copy. |
| `apps/api/src/services/platform-onboarding-service.ts` | `seedNewOrganization`: where creating an Organization asks for its seeds. |
| `apps/api/src/queues/activity-consumer.ts` | The `canvas_seed` branch of the activity queue's consumer. |

## How it works

**Asking.** `seedNewOrganization` runs in `createOwnedWorkspace`, the one place
the desktop, the browser and the engineering MCP's `create_org` share, after
the creation batch commits. It sends one `canvas_seed` job per seed to
`ACTIVITY_QUEUE` (`workspaceId`, `creatorUserId`, `seedKey`, `region`), and
both regional replay branches send it again. It is a queue because creating an
Organization must not wait on a Canvas, a publish and a message
([`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md)).

**Copying.** `seedCanvas` calls, in order: `createCanvas` (the owner as
creator, an id named from the Organization and the seed), `canvasUpdate` (icon
and colour), `publishSeedSite`, `canvasSetAudience` (the whole Organization),
and the message port's `appendMessage` (Rally's opening message, authored as
the agent with no run). The audience follows the site so no member opens a
Canvas with no artifact. The message is last because it marks the seed as
finished.

**Publishing with no sandbox.** Rally's own publish reads a site out of a
Canvas's sandbox, and a person's publish is refused an `index.js`. A seed's
files are Rally's own, so `publishSeedSite` calls the shared site writes
directly, in the order every site publish uses. Its identity is
`terminal:<canvasId>:<path>`, the one Rally's publish of that path from this
Chat computes, so Rally's first revision is version 2 of this artifact. Its
first version is authored as `system`, because an `agent` version must name
its run.

**The files reach the Worker as text.** A Wrangler `Text` rule
(`**/canvas-seeds/*/site/*`) makes an import of a seed's site file its text;
the Node test run mirrors it in `vitest.config.ts`, and
`src/types/text-modules.d.ts` declares each file name.

**The guide.** Six steps above a shared wall of idea cards. Wherever it can,
the site decides a step from what it can see for itself:

| Step | Where | Ticked by |
| --- | --- | --- |
| `use_the_page`: add a card, vote for one | Page | The stored rows |
| `ask_rally`: ask Rally to add ideas | Chat | A card Rally wrote |
| `comment`: Comment mode on the wall's title | Page, then Chat | A row Rally writes, or the person |
| `make_it_yours`: team name and a section of their own. Team step | Chat | The page having been republished |
| `teammate`: a second person adds a card. Team step | Together | The stored rows |
| `own_canvas`: copy a starter prompt | Page | The page, on copy |

A card written from the Chat with only its text is Rally's by the table's
defaults. One with `asked_by_id` ticks step 2 for that person; one without
ticks it for everyone. Step 4 is proved by `index.html` no longer matching the
page the site first ran with, the wall's title aside (`pageWasRemade`). Anyone
can tick any step by hand. The page cannot post to the Chat, so each Chat step
shows a prompt with a copy button.

**Rally's side** is the site's `README.md` and three comments in `index.html`
that point to it from the places Rally must edit. Nothing in the product hands
either to the model: an instruction file is not looked for under
`.rally-output`, where an imported site lives. That is why no step depends on
Rally having read them, except step 3's tick.

## Invariants

- **A seed job is safe to run any number of times.** Every id is named from
  the Organization and the seed, and each step answers a replay with what it
  made. Guard: `test-workers/canvas-seed.test.ts`.
- **A finished seed is never reapplied.** `seedCanvas` returns when the
  opening message exists. Without that, a job replayed from the dead-letter
  queue weeks later would reopen a Canvas its owner had closed. Guard: the
  same test.
- **A seed only ever writes version 1, and judges an existing row by its
  stored manifest's version, never its bytes.** Past version 1, Rally
  published since. At version 1, an earlier attempt stopped and is finished
  from the bytes it stored: a deploy between attempts changes the seed's
  files, and a byte comparison would abandon a site that never served. Guard:
  the same test.
- **No table of the guide has a `private_to_viewer` column.** On a site with
  one, a row write asked for by anyone but the site's author is refused, and a
  seeded site has no author, so step 2 would fail for every member. No
  automated guard.
- **The guide answers 401 without `x-rally-viewer-id`**, before routing and
  before serving a file: the wall shows people's names. Guard: the same test.
- **`id="wall-title"` and the `data-` attributes stay in `index.html`.** The
  step 4 check and `app.js` are keyed on them. No automated guard.
- **The wall updates card by card; the steps' HTML is never re-rendered.** A
  full re-render would detach the element a person is commenting on. Verified
  visually.

## Boundary

This module owns what a seed is, the job that asks for one, and the order of
the copy. It adds no table, migration, Durable Object method or route. A
Canvas and its audience are [`canvases.md`](canvases.md)'s, the site writes
and serving are [`live-web-artifacts.md`](live-web-artifacts.md)'s, and
creating an Organization is
[`new-user-onboarding.md`](new-user-onboarding.md)'s.

It does not seed Sidekicks, copy an existing Canvas, or give a member who
joins later a Canvas of their own.

## Failure modes and limits

- **The queue refuses the job:** logged as `canvas_seed_enqueue_failed`, and
  the Organization is created without its guide. A replay of the creation
  sends it again.
- **A step of the copy fails:** the consumer throws, the queue retries, then
  the dead-letter queue holds it. A retry resumes where the last one stopped.
- **The job names a seed this Worker does not carry:** `canvas_seed_unknown`,
  thrown so a retry reaches a version that has it.
- **The Organization was retired first, or the guide was archived:**
  acknowledged, not retried. An archived guide is a finished seed.
- **Rally never reads the README:** steps 2 and 4 still tick; step 3 is ticked
  by hand.
- The guide polls every 4 seconds and stops on 401 or 403, so its own
  refusals never use 403. A card has no length cap and the wall no card cap.

## Testing

- `apps/api/test-workers/canvas-seed.test.ts`, on real workerd, delivers the
  job to the real consumer and runs the guide's own `index.js` as a facet
  through `ArtifactHostDO`. It initializes the Organization's object first, as
  creation does; without that the resource insert is refused as
  `workspace_identity_mismatch`.
- `apps/api/test/regional-workspace-create.test.ts` covers the send, the
  replay and a refused send.
- Not runnable here: a model, so Rally following the README is unproved; and
  a live site inside the artifact panel
  ([`dev-environment.md`](dev-environment.md#what-cannot-be-verified-in-a-sandbox)).

## Open questions

- **Organizations that already exist** have no guide. A `canvas_seed` job for
  each would do it; nobody has decided to.
- **Getting a site's README to Rally.** Nothing hands it over. A general
  answer (a site's instruction file, or an artifact's description in the
  Canvas context) would let step 3 tick on its own and serves every site.

## Changelog

### 2026-11-10 — The guide, and seeding it into every new Organization

The owner asked for a Getting Started Canvas copied into every new
Organization, that teaches what Rally is by having people use a Canvas.
Nothing was seeded at creation before, and nothing could copy a Canvas, a
transcript or an artifact.

Decided with the owner: one guide per Organization; copy-to-clipboard prompts
rather than a page-to-Chat bridge; an opening message from Rally that says it
can tell which messages are meant for it; and people open the guide from the
Canvases home themselves.

A seed is data copied in through existing paths because every path it needed
already existed, which kept the change to no new table, object method or
route. Copying a template Canvas out of an internal Organization was rejected:
it needs a cross-Organization read path and a deployed fixture to arrive at
the same rows. The job has no outbox row beside the creation batch; a lost
send loses that Organization's guide, accepted over a table whose only job
would be redelivery.

Three things were learned the hard way and a future change has to respect
them. Guide progress cannot be a per-viewer private table, because that makes
every non-author member's row writes fail. A version with no run is `system`,
not `agent`. And the steps were first ticked by rows Rally was told to write
in the site's README, until review pointed out that nothing shows Rally that
file; the site now proves steps 2 and 4 itself.
