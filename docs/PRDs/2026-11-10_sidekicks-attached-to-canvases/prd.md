# Sidekicks attached to Canvases

> Created 2026-11-10.
>
> A Canvas can have Sidekicks attached to it, so a schedule or a stream of
> events keeps its artifacts up to date. A Canvas's Chat can make a Sidekick
> for its own Canvas. Builds on
> [Canvases and Sidekicks](../2026-11-06_canvases-and-sidekicks/prd.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

A person in a Canvas can ask Rally to keep the Canvas current: "update this
inbox every time I get an email", or "update this dashboard every time a pull
request is opened, closed or merged". Rally builds the artifact, makes a
Sidekick for that Canvas, and from then on the Sidekick's runs change the
artifact as each event arrives. Nobody republishes anything by hand.

Zero or more Sidekicks are attached to a Canvas. An attached Sidekick's runs
can read and post in the Canvas's Chat, publish new versions of its artifacts,
and write rows into an artifact that stores its own data.

## Motivation

A Canvas changed only when a person talked to it. A Sidekick could already run
on a schedule or on a connector event, but its output went to a Canvas of its
own, one per run: it could not touch a Canvas a person had made, and a Canvas's
Chat had no way to make a Sidekick that knew about the Canvas. So the two
halves of the product could not be combined into the thing each is for:
recurring events updating shared work.

The owner raised it on 2026-11-10 with two examples, an email client rebuilt
as a Canvas artifact that a Sidekick fills from the inbox, and a pull-request
dashboard. No support thread or usage number is recorded.

## Goals

1. A Sidekick can be attached to a Canvas a person made, and its runs can then
   change that Canvas's artifacts.
2. A Canvas's Chat can make a Sidekick that is attached to that Canvas and to
   no other, without the model naming a Canvas.
3. A run that fires once per event can update an artifact without losing
   another run's update and without making a new version each time.
4. Everyone in a Canvas can see which Sidekicks are attached to it, and can
   change or archive the ones the Canvas made.
5. Archiving a Canvas stops the Sidekicks it made.

## Non-goals

1. **Attaching or detaching an existing Sidekick from the Canvas's Chat.**
   Deferred, the owner's call. A Sidekick's own configuration conversation
   still attaches it to a Canvas (`conversation_attach`), and nothing detaches.
2. **Opening a Canvas-made Sidekick to everyone in the Canvas.** Rejected for
   now. People in the Canvas steer it; they read its conversation and runs only
   if its creator shares it. See the decision log.
3. **Coalescing or queueing a Sidekick's runs.** Deferred. Each event starts a
   run and runs overlap; the row write of goal 3 is what makes that safe.
4. **A trigger that runs a saved tool with no model call.** Deferred. It is
   the next step for the cost of one run per email, and nobody has asked for it.
5. **Pushing a data change to an open page.** Deferred. A site reads its own
   data when it next asks.
6. **An attachment for instruction-only Sidekicks.** Not needed. They are
   offered to every Canvas whose people can read them, as before.

## Product behavior

- **Asking for it.** In a Canvas's Chat a person asks for the Canvas to be
  kept up to date. Rally builds or revises the artifact, makes a Sidekick, and
  briefs its wizard, which chooses the trigger and saves the definition. The
  Chat reports the Sidekick as saved only once the wizard confirms.
- **The Canvas shows its Sidekicks.** The title pill's menu lists each
  attached Sidekick by its hexagon, name and state. Empty: no section. A
  Sidekick the viewer can open is a link to it; one they cannot is named and
  says to ask in the Chat.
- **Changing one.** Anyone in the Canvas asks the Chat, which messages the
  Sidekick's wizard. Anyone in the Canvas can archive one the Canvas made, from
  the menu or by asking the Chat.
- **A run updates the Canvas.** Each run's publish appears as a new version
  attributed to the Sidekick, and the Canvas's card names the run, as a
  Sidekick's own Canvases already do. A row write changes what the site shows
  and makes no version.
- **Archiving the Canvas** says how many Sidekicks will be archived with it,
  and archives them.
- **Error.** A run whose person can no longer open the Canvas, or whose Canvas
  was archived, is refused the write and reports it, as a refused post is
  today.
- **Loading and offline.** Unchanged: the Canvas detail carries the list.

Platforms: macOS and web, which share the renderer.

## Impact on the product contract

None. This refines behavior within the contract the Canvases and Sidekicks PRD
set: a Canvas is the shared home for work and a Sidekick the shared home for an
agent. "A Sidekick's output is a Canvas" widens from the Canvas each run makes
to any Canvas the Sidekick is attached to.

## Decision log

### 2026-11-10 — One attachment grants everything; the writer column keeps one meaning

**Decided:** `sidekick_conversation_attachments` is the single record of which
Canvases a Sidekick works on. It grants Chat read and post, publishing into
the Canvas, and writing its artifacts' data. A Canvas a run makes is attached
as it is made, and existing ones were attached by migration.
`canvas_directory.writer_sidekick_id` keeps only its audience meaning: a Canvas
a run made admits that Sidekick's audience.

**Why:** Two relations linked a Sidekick to a Canvas. The writer column was
one per Canvas, set only at creation, and was the publish grant, so a person's
Canvas could never be published into. The attachment was many to many and
granted only the Chat. A run and the Chat already share an artifact's identity
(`terminal:<canvasId>:<path>`), so the writer check was the only thing in the
way.

**Changes:** Goal 1. Attaching does not change who can open either side.

### 2026-11-10 — Recurring events write rows; publishing is for the artifact's code

**Decided:** A new tool, `write_artifact_data`, lets a Canvas's Chat and the
runs of an attached Sidekick change rows in a stateful artifact. The site's
own code keeps writing its database from viewer traffic, as it always has.

**Why:** Runs are not coalesced. Two runs that each import, edit and republish
a site lose one update, and each republish makes a version and tells every
pinner. A row write is atomic and versionless.

**Changes:** Goal 3. Non-goal 3 stays deferred because of it.

### 2026-11-10 — The Chat's tools are create and archive, locked to its Canvas

**Decided:** In a Canvas's Chat `create_sidekick` always attaches what it
makes to that Canvas, and `archive_sidekick` archives only a Sidekick that
Canvas made. The host takes the Canvas from the loop; no tool has a Canvas
argument. There is no attach or detach tool in the Chat.

**Why:** The owner's call: a Canvas makes Sidekicks for itself and for no
other Canvas, and the first build has the smallest tool set that does it.

**Changes:** Goal 2; non-goal 1.

### 2026-11-10 — A Canvas-made Sidekick is steered by the Canvas, not owned by it

**Decided:** The attachment a Canvas's Chat writes is marked `made_here`.
Everyone the Canvas admits may change or archive such a Sidekick, and archiving
the Canvas archives it. Who can open the Sidekick is unchanged: its creator,
and whoever its creator shares it with.

**Why:** The first build recorded a home Canvas on the Sidekick and made the
Canvas's audience the Sidekick's audience, read live. That rule is read in
about eight places (the library, the sidebar SQL, canonical authorization,
search, memory, notifications), it made Canvas and Sidekick admission
recursive, and it brought back the conversation-owned Sidekick that
Canvases and Sidekicks had just retired. The owner asked whether it coupled
too tightly and chose this instead, accepting that a participant can steer a
Sidekick without reading its run history.

**Changes:** Goal 4 as written; non-goal 2. A participant who changes a
Canvas-made Sidekick changes what runs with its creator's connections. That is
accepted and stated in the Security section.

### 2026-11-10 — Steering is narrower than managing

**Decided:** A member the made-in Canvas admits may change what the Sidekick
does, pause, resume, run and archive it. Changing who opens it, how it looks
or who it runs as stays with its author, the person it runs as and, for an
Organization Sidekick, owners and administrators.

**Why:** Review of the first build, which gave the Canvas's audience every
managed action. That let a participant share the Sidekick with themselves and
read the run history the decision above keeps closed, or claim its run-as
seat.

**Changes:** The Security section.

### 2026-11-10 — A guest of the Canvas steers like a member

**Decided:** A guest the made-in Canvas admits steers its Sidekick exactly as a
member does. There is no guest rule.

**Why:** The owner's call. Review had excluded guests because a Sidekick runs
with a member's connections, and a later build limited which connections a
guest's edit could bind. The owner removed both: a guest has no personal
connections, so the limit guarded nothing and cost a code path.

**Changes:** Goal 4 holds as first written. The Security section.

### 2026-11-10 — Instruction-only Sidekicks stay automatic

**Decided:** A Sidekick with no triggers is still offered to every Canvas
whose people can read it. Nothing attaches one.

**Why:** The owner's call. A shared design or marketing-language Sidekick
already reaches many Canvases this way.

**Changes:** Non-goal 6.

### 2026-11-10 — The Canvas menu lists Sidekicks and archives none

**Decided:** The title pill's menu shows each attached Sidekick and has no
archive action for one. A Sidekick the Canvas made is archived by asking the
Canvas's Chat (`archive_sidekick`), or with the Canvas.

**Why:** The owner's call after seeing the built menu, which had an archive
button on each Canvas-made Sidekick's row. The reason was not recorded.

**Changes:** Product behavior's "from the menu or by asking the Chat" becomes
"by asking the Chat". Goal 4 holds: everyone in the Canvas can still archive
one, through the Chat.

### 2026-11-10 — Each side shows the other on its dashboard card

**Decided:** A Canvas's home card carries a Sidekick facepile, at the right
under the Data badge. A Sidekick's home card carries a pill for each Canvas it
was attached to, at the right, with an up-right arrow, that opens the Canvas.

**Why:** The owner's call, after the header indicator beside the face pile was
left out: the dashboards are where a person scans for which Canvases are kept
current and what a Sidekick works on.

**Changes:** Adds to Product behavior. The Canvas list row gains `sidekicks`
and the Sidekick row `attachedCanvases`. A Sidekick's pills leave out the
Canvas each of its own runs made.

### 2026-11-10 — An MCP client can add a Sidekick to a Canvas

**Decided:** `POST /canvases/:id/sidekicks`, and the same as `sidekick` on
`POST /canvases`, make a Sidekick attached to a Canvas and send its
instructions to its wizard. The MCP server offers them as `add_canvas_sidekick`
and `create_canvas`'s `sidekick` argument. The consent page says a connected
app can set up Sidekicks.

**Why:** The owner wants the MCP server to be a second interface and a way
into the product, and this feature reachable from it at creation or after.

**Changes:** A new goal in effect: a client outside Rally can set up the
recurring update. The MCP token's reach grows by one Canvas route; it still
reaches no Sidekick route. Neither tool is an MCP task.

## Data model

`WorkspaceDO` migration 144: `sidekick_conversation_attachments.made_here`, an
index on `(parent_kind, parent_id)` for the Canvas-side read, and one
attachment for every Canvas whose `writer_sidekick_id` is set.
[`automation-lifecycle.md`](../../automation-lifecycle.md#data-model) owns it.

## Regional impact

None. Every row is in the Organization's own `WorkspaceDO`.

## Security and trust model

- A run acts as its run-as person with that person's connections. Attaching a
  Sidekick sends its output to whoever the Canvas admits, now and later.
- Every write admits the acting person again; losing the Canvas stops it.
- A Canvas-made Sidekick can be changed, paused, run and archived by anyone
  the Canvas admits, guests included, so they decide what runs with its
  creator's connections. Its creator chose that by making it in a shared
  Canvas. Nobody gains the power to change who opens the Sidekick or who it
  runs as.
- The Canvas a tool acts on is the loop's own. A model cannot name another.
- A row write obeys the per-viewer rule reads obey: unattended runs and the
  site's author write any row, and a member's Chat run is refused on a site
  with private tables.

## Agent behavior

The durable contracts are in the owning documents:
[`agent-communication.md`](../../agent-communication.md#in-a-canvass-chat)
for `create_sidekick`, `sidekicks_list` and `archive_sidekick` in a Canvas's
Chat; [`live-web-artifacts.md`](../../live-web-artifacts.md#writing-rows-from-a-run)
for `write_artifact_data`; [`canvases.md`](../../canvases.md#rally-in-a-canvas-chat)
and [`automation-lifecycle.md`](../../automation-lifecycle.md#attached-conversations)
for the `CANVAS CONTEXT` and `ATTACHED CANVASES` messages. In short:

- **`rally_agents` in a Canvas's Chat** (preloaded, user principal). Adds
  `archive_sidekick({ sidekick })`, `write`; a retry after it succeeded
  answers with the same result: `sidekick` is a
  `sidekickId` from `sidekicks_list` or an exact name. It returns
  `{ sidekickId, name, archived }`. Refusals: `sidekick_archive_not_made_here`
  and `sidekick_archive_ambiguous`, each with the names this Canvas made in
  `details.available`. `create_sidekick` returns `attachedToCanvasId` beside
  the wizard's `agentId`. `sidekicks_list` returns the Sidekicks this Canvas
  made.
- **MCP: `add_canvas_sidekick({ canvasId, operationId, instructions })`** and
  `create_canvas({ ..., sidekick: { operationId, instructions } })`. Contract,
  refusals and replay are in
  [`rally-mcp.md`](../../rally-mcp.md#sidekicks-for-a-canvas).
- **`write_artifact_data({ resource, sql, params? })`**, `write`,
  `record_before_execute`. One INSERT, UPDATE, DELETE or REPLACE. Offered to a
  Canvas's Chat for its own artifacts and to a run for artifacts of Canvases
  attached to its Sidekick.
- **Sequence.** The Chat publishes a site that stores data, calls
  `create_sidekick`, sends the wizard the artifact's `resourceId`, its tables
  and what each run writes; the wizard saves the trigger and instructions; each
  run reads `ATTACHED CANVASES`, then calls `write_artifact_data`.

Evaluations on the medium fallback model have not been run.

## Rollout

Ships to everyone on merge, with no flag. The migration only adds a column, an
index and rows.

## Open questions

1. Should a Canvas's Chat attach and detach an existing Sidekick? (Non-goal 1.)
2. Should a run's writes be serialized per Sidekick once a republishing
   Sidekick is common?
