# Canvas seeds

A **Canvas seed** is a Canvas Rally copies into an Organization rather than a
person starting it: a title and a look, the first message of its Chat, and one
site. There is one, **Getting Started with Canvases**, the guide every new
Organization is given.

A seed is data, and copying it is nothing but the product's own paths called in
order. A seeded Canvas is an ordinary Canvas afterwards: people rename it,
archive it, and ask Rally to change its site like any other. Read this before
changing the guide, adding a seed, or changing what a new Organization starts
with.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `canvas-seeds/getting-started-with-canvases/site/` | The guide's site, as it is published: one directory, the shape [`live-web-artifacts.md`](live-web-artifacts.md) serves. The single copy of its files. |
| `…/site/index.js` | `SiteData`: the site's server and stored data. The one place a step is decided done. |
| `…/site/index.html` | Every word of the guide. A step's copy is edited here and nowhere else. |
| `…/site/README.md` | What Rally reads before answering in the guide's Chat: how to behave, and the statement to send for each step. |
| `canvas-seeds/getting-started-with-canvases/preview/` | A local Worker that hosts the site: `pnpm preview:canvas-guide`. Ships nowhere. |
| `apps/api/src/canvas-seeds/getting-started-with-canvases.ts` | The seed: the site's files imported as text, plus the title, the look and Rally's opening message. |
| `apps/api/src/canvas-seeds/index.ts` | `CANVAS_SEEDS`, every seed a job may name, and `NEW_ORGANIZATION_CANVAS_SEEDS`, the ones a new Organization is given. |
| `apps/api/src/services/canvas-seed-service.ts` | `CanvasSeed`, the `canvas_seed` job (`enqueueCanvasSeed`, `runCanvasSeed`), and `seedCanvas`, which copies a seed in. The one implementation of the copy. |
| `apps/api/src/services/platform-onboarding-service.ts` | `seedNewOrganization`: where creating an Organization asks for its seeds. |
| `apps/api/src/queues/activity-consumer.ts` | The `canvas_seed` branch of the activity queue's consumer. |

## How it works

### Asking for a seed

All three ways to create an Organization (the desktop, the browser, and the
engineering MCP's `create_org`) reach `RegionalOnboardingService`, and
`seedNewOrganization` runs in the one place they share: `createOwnedWorkspace`,
after the creation batch commits and the Organization's object is
initialized. It sends one `canvas_seed` job per seed to `ACTIVITY_QUEUE`:

```json
{ "kind": "canvas_seed", "workspaceId": "…", "creatorUserId": "…", "seedKey": "getting-started-with-canvases", "region": "global" }
```

It is a queue, not a call, because creating an Organization must not wait on a
Canvas, a publish and a message, and nothing the creator is answered with
depends on them ([`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md)).
Both regional replay branches send it again, because a first attempt may have
stopped before the send; the job makes that safe.

### Copying it in

`seedCanvas` runs these in order, each through the path the product already
has:

1. **The Canvas.** `createCanvas`, with the Organization's owner as creator, the
   seed's title, and an id named from the Organization and the seed.
2. **Its look.** `canvasUpdate` with the seed's icon and colour.
3. **Its site.** `publishSeedSite`: the files, the manifest, the public
   hostname, the resource row, the registry row and the serving pointer, in the
   order every site publish uses, then attached to the Chat and noted on the
   Canvas as Rally's. The artifact carries the Canvas's title, not its
   directory's name, and keeps it when Rally republishes without naming one.
4. **Its audience.** `canvasSetAudience`, to the whole Organization.
5. **Rally's opening message.** The message port's `appendMessage`, authored as
   the agent with no run, the append a scheduled wake-up's notice makes.

The audience is set after the site so a member never opens a Canvas with no
artifact, and the opening message is last because it is the mark that the seed
finished (see [Invariants](#invariants)).

Three things about that copy are not obvious:

- **The site is published with no sandbox.** Rally's own publish reads a site's
  files out of a Canvas's sandbox, and a person's publish is refused an
  `index.js`. A seed's files are Rally's own code, imported as text, so
  `publishSeedSite` calls the shared site writes directly as their third
  caller. Its identity is `terminal:<canvasId>:<path>`, the one Rally's
  publish of that path from this Canvas's Chat computes, so the first time
  Rally revises the guide that is version 2 of this artifact and not a second
  site.
- **Nobody is its author.** The first version is authored as `system`: an
  `agent` version must name its run (`resource_versions_provenance_fence_insert`),
  and no run made this one. The resource has no uploader, so no member is the
  site's author for the purposes of its stored data.
- **Rally's message opens the Chat.** No person has written yet, so the
  model's first run in a seeded Canvas would be handed an assistant turn
  first, which not every provider accepts; the projector hands it over as
  context instead ([`canvases.md`](canvases.md#rally-in-a-canvas-chat)).

### The files reach the Worker as text

The API Worker has no filesystem. A Wrangler `Text` rule
(`**/canvas-seeds/*/site/*`) makes an import of any file under a seed's `site/`
its text, the same mechanism that carries the sandbox scripts; the Node test
run mirrors it with the `rally:text-modules` plugin, and
`src/types/text-modules.d.ts` declares each file name a seed imports. So the
directory under `canvas-seeds/` is the only copy: the preview serves it, and
the Worker publishes it.

### The guide

A stateful live site: six steps above a shared wall of idea cards people add
and vote on. Each step has the person do one real thing, on the page or in the
Canvas's Chat.

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

**The page cannot post to the Chat.** A live site has no such bridge, so each
Chat step shows a prompt with a copy button, filled in from what the person
types beside it.

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

- **A seed job is safe to run any number of times.** Every id is named from
  the Organization and the seed (`seededCanvasId`, and the resource, artifact
  and message ids beside it), and each step answers a replay with what it
  made. Guard: `test-workers/canvas-seed.test.ts`.
- **A finished seed is never reapplied.** `seedCanvas` returns at once when the
  opening message exists, and that message is written last. Without it, a job
  replayed from the dead-letter queue weeks later would reopen a Canvas its
  owner had closed and reset its look. Guard: the same test, which closes and
  restyles the Canvas between two deliveries.
- **A seed only ever writes version 1.** A resource row at the seed's identity
  that holds other content was published since, by Rally from the Chat, and is
  left alone. A replay must never put the original guide back over a team's
  page.
- **No table of the guide has a `private_to_viewer` column.** On a site with
  one, a `write_artifact_data` asked for by anyone but the site's author is
  refused with `private_rows`, and a seeded site has no author, so step 2
  would fail for every member. Guide progress is a shared table for that
  reason. No automated guard.
- **The guide answers 401 without `x-rally-viewer-id`**, before routing and
  before serving a file. The wall shows people's names and a site is public by
  default. Guard: `test-workers/canvas-seed.test.ts`, through Rally's own host.
- **The statements in `site/README.md` match the schema in `site/index.js`.**
  Rally sends what the README says; a renamed column there fails in a person's
  first conversation. The preview's Rally buttons send the same statements,
  which is the check. No automated guard.
- **The wall updates card by card and the steps' HTML is never re-rendered.**
  A full re-render on each poll would detach the element a person is
  commenting on in Comment mode. Verified visually, no automated guard.
- **The guide's schema only grows.** A copy's data outlives every version
  Rally publishes of it in that Organization.

## Boundary

This module owns what a seed is, the job that asks for one, and the order of
the copy. It owns none of the mechanisms the copy uses: a Canvas and its
audience are [`canvases.md`](canvases.md)'s, the site writes and serving are
[`live-web-artifacts.md`](live-web-artifacts.md)'s, the Chat's transcript is
[`workstream-durable-object.md`](workstream-durable-object.md)'s, and creating
an Organization is [`new-user-onboarding.md`](new-user-onboarding.md)'s. It
adds no table, no migration, no Durable Object method and no route.

It deliberately does not seed Sidekicks, does not copy an existing Canvas, and
does not give a member who joins later a Canvas of their own: the guide is one
per Organization and later members find it in the list.

## Failure modes and limits

- **The queue refuses the job** when the Organization is created: logged as
  `canvas_seed_enqueue_failed` with the Organization's id, and the creation
  succeeds without its guide. A replay of the same creation sends it again.
  Nothing else notices, by design: a person is not refused their Organization
  over a tutorial.
- **A step of the copy fails:** the consumer throws, the queue retries, and
  after its retries the job is in the activity queue's dead-letter queue. A
  retry resumes: ids are named, so it rewrites the same objects and finishes
  what was left.
- **The job names a seed this Worker does not carry** (sent by a newer
  version): `canvas_seed_unknown`, thrown so the retry or the dead-letter
  queue reaches a version that has it.
- **The Organization was retired** before the job ran: the object's
  retirement refusal is acknowledged, not retried.
- **A person opens the Canvases home before the job lands:** they see the
  empty state, and the guide arrives on the list's next frame.
- **In the guide itself:** a failed request says so and the person tries
  again; polling backs off with jitter. The page stops polling on 401 or 403
  and shows a sign-in link, so the site's own refusals never use 403. A
  refused clipboard falls back to the older copy command, then to selecting
  the prompt's text. A row Rally did not write is ticked by hand.
- The guide's poll interval is 4 seconds. There is no cap on a card's length
  or on the number of cards; neither has been asked for.

## Testing

- `apps/api/test-workers/canvas-seed.test.ts`, on real workerd, delivers a
  `canvas_seed` job to the real consumer and reads back the Canvas as a member
  who was never added to it, the registry row, and Rally's message. It then
  fetches the guide through `ArtifactHostDO.fetchThroughFacet`, which is the
  guide's own `index.js` running as a facet with its own SQLite. Run it with
  `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/canvas-seed.test.ts`.
  It initializes the Organization's object in `beforeEach`, as creation does
  before it asks; without that the resource insert is refused as
  `workspace_identity_mismatch`.
- `apps/api/test/regional-workspace-create.test.ts` proves the creation sends
  the job, sends it again on a replay, and survives a refused send.
- `apps/api/test/model-protocol-transcript.test.ts` proves a leading agent
  message is handed over as context and a later one as an assistant turn.
- Nothing can run a model here, so Rally following the README in a real Chat
  is unproved by any test.
- Verified in a real window on the local stack: an Organization created
  through `POST /onboarding/workspace` shows the guide on its Canvases home,
  unread, with its icon, and the Canvas opens to Rally's message. The site
  inside the panel cannot be drawn locally
  ([`dev-environment.md`](dev-environment.md#what-cannot-be-verified-in-a-sandbox)).

## Open questions

- **Organizations that already exist** have no guide. Sending a `canvas_seed`
  job for each is all it would take; nobody has decided to.
- **A page-to-Chat bridge.** Prompts are copied by hand today. A site that
  could draft a message into the composer would remove a step from every Chat
  step of the guide.

## Changelog

### 2026-11-10 — The guide, and seeding it into every new Organization

The owner asked for a Getting Started Canvas copied into every new
Organization, that guides people through what Rally is by having them use a
Canvas. Nothing was seeded at creation before, and nothing could copy a
Canvas, a transcript or an artifact.

Decided with the owner: one guide per Organization rather than one per person;
copy-to-clipboard buttons rather than a page-to-Chat bridge; a seeded opening
message from Rally that says it can tell which messages are meant for it, with
no tagging; and people land on the Canvases home and open the guide
themselves.

A seed is data copied in through existing paths, not a copy of a stored
Canvas, because nothing existed to copy from and every path it needed already
did: the site writes had two callers and took a third, and the message port
already admitted an agent's message with no run. That kept the change to no
new table, object method or route. Copying a template Canvas out of an
internal Organization was rejected: it would need a cross-Organization read
path and a deployed fixture, to arrive at the same rows.

The job rides `ACTIVITY_QUEUE` with no outbox row beside the creation batch.
A send that fails after the batch commits loses the guide for that
Organization unless the creation is replayed; that was accepted over a
pending-outbox table whose only job would be redelivery
([`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md)).

Guide progress was first drawn as a per-viewer private table. It is shared
instead, because one private table makes every non-author member's row writes
fail, and a seeded site has no author. The site's first version was first
written as an `agent` revision with no run and was refused by the provenance
fence; it is `system`. A future change that wants private data in a seed, or a
run-less agent revision, has to solve those first.
