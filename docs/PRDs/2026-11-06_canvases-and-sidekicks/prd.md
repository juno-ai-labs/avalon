# Canvases and Sidekicks

> Created 2026-11-06.
>
> Rally narrows to two modes: Canvases (live artifacts several people edit with
> Rally) and Sidekicks (AI agents several people share). Channels, Threads,
> Breakouts, Activity and the Pinned section are removed. Mockups:
> [design.html](design.html). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Replaces the navigation in
> [Channels and Threads navigation](../2026-10-10_channels-threads-navigation/prd.md).

## Summary

The desktop and browser clients show two sections instead of five. **Canvases**
lists live pages that people and Rally build together; opening one shows who is
in it, their cursors, and a side panel with the Canvas's own chat with Rally and
its comments. **Sidekicks** lists shared AI agents; opening one shows a single
conversation everyone it is shared with can join, with its runs and the Canvases
it writes inline, beside its settings.

The change has two halves of very different size. Removing Channels, Threads,
Breakouts, Activity and the Pinned section is mostly deletion. Making a Canvas
something several people and Rally edit at once is **new work and the larger
half**: today a live artifact is a directory a Thread's run publishes, and
nobody edits it directly. Live editing, presence, cursors and Rally's pending
edits need a real-time collaboration layer that does not exist yet.

## Motivation

The current product, built around Channels, Threads and Breakouts, failed to
win market interest. Continuing to build on it means more work on something the
market has not asked for.

Both new modes reuse parts that already exist, live artifacts and Sidekicks, so
the pivot keeps that work and removes the surfaces around it. Why these two
modes in particular, and the evidence behind the lack of interest (prospect
conversations, usage or pipeline numbers), are not recorded here.

## Goals

1. The section rail shows exactly two sections, Canvases and Sidekicks, on
   macOS and web.
2. A person can see from the sidebar which Canvases have people in them now.
3. A person can see from the sidebar which Sidekicks need input from them.
4. Several people and Rally can edit one Canvas at once and see each other's
   cursors, selections and pending edits.
5. Several people can talk to one Sidekick in one shared conversation.
6. A Sidekick's output that people work on afterwards is a Canvas, reachable
   from both the Sidekick conversation and the Canvases list.

## Non-goals

1. **iOS.** Deferred; iOS is a prototype and follows once desktop and web ship.
2. **A grouping layer above Canvases and Sidekicks** (folders, teams,
   Channels). Rejected for now; sharing is per Canvas and per Sidekick.
3. **A separate notification inbox.** Rejected; unread dots, "Needs input" and
   rail badges carry what Activity did.

## Product behavior

See [design.html](design.html) for every screen in light and dark.

- **Rail.** Canvases and Sidekicks, then Settings at the bottom. Each section
  shows a badge for unread items.
- **Canvases sidebar.** A Pinned group, then all Canvases sorted by recent
  activity. Each row shows the Canvas mark, its name, a green dot and names
  when people are in it, otherwise the last editor. Unread rows are bold with a
  red dot.
- **Canvases home.** Title, New Canvas, search, filter chips (Everyone, Made by
  me, Shared with me, From Sidekicks), a Live now group, then Recent.
- **Canvas open.** The header pill names the Canvas; to its right are the
  people present, Share and a menu. The conversation fills the main pane, open
  to everyone in the Canvas, and the artifact sits in the right panel once one
  exists, with its version. A quoted selection travels with a message, and
  comments are the artifact annotations people drop, arriving in the
  conversation as today. Rally changes the artifact by publishing a version.
- **Sidekicks sidebar.** Needs input, then Pinned, then all Sidekicks. Rows
  show the hexagon mark and current state (working, next run, paused). "Needs
  input" means the Sidekick is missing information only a person has; it never
  means a Sidekick is waiting to be allowed to run a tool.
- **Sidekicks home.** Today's library, moved into the main window, as rows with
  status, who it is shared with, and when it next wakes.
- **Sidekick open.** One shared conversation, with runs as collapsed rows and
  Canvases as cards. People talk to each other there; a message addressed to
  the Sidekick starts a run, whose row carries the reply. Managers edit the
  Sidekick in the same conversation through the wizard, as today. The details
  column keeps today's Sidekick page (status, Pause, delegation, schedule) and
  adds triggers, tools and the Canvases it writes to.

### States

- **Empty.** A first-run Canvases list shows only New Canvas and a "Start from
  a prompt" card; the Sidekicks list shows New Sidekick and the existing library
  empty copy.
- **Loading.** Lists draw the existing sidebar skeleton. An opening Canvas draws
  its last cached version and joins the live session behind it, so opening is
  never blocked on presence.
- **Error.** A Canvas that cannot be opened, or that the person lost access to,
  shows the existing unavailable state for a resource.
- **Offline.** A Canvas opened offline shows its last cached version read-only,
  with a notice that live edits resume on reconnect; other people's cursors are
  hidden rather than frozen. Chat and Comments queue the same way the composer
  does today.

### What each feature becomes

| Today                                                 | After                                                 |
| ----------------------------------------------------- | ----------------------------------------------------- |
| Channels, Channel feed, General, Personal Channel     | Removed                                               |
| Threads and the Thread conversation                   | Removed; the Canvas Chat tab and Sidekicks replace it |
| Breakouts, merge-back, breakout and merge suggestions | Removed                                               |
| Activity section                                      | Folded into unread dots, "Needs input" and badges     |
| Pinned section                                        | A Pinned group in each list                           |
| Artifacts section, live web artifacts, annotations    | Become Canvases                                       |
| Sidekicks window and library                          | Move into the main window                             |

## Impact on the product contract

This changes the contract. These clauses of
[the brief's Product contract](../2026-08-05_avalon-implementation-brief/prd.md#product-contract)
move:

- **A Thread is the durable, multiplayer home for a task.** Replaced: a Canvas
  is the shared home for work, and a Sidekick is the shared home for an agent.
- **A Channel is a stable, named list of Threads.** Removed.
- **A Breakout is a private or shared conversation inside a Thread.** Removed.
- **Rally is inherent in every Thread.** Becomes: Rally is inherent in every
  Canvas's Chat.
- **Every admitted automation run owns exactly one Thread.** Becomes: every run
  is a child of its Sidekick's shared conversation.
- **Connected activities … appear as an in-stream routing suggestion; Activity
  lists events about the viewer.** Open: with no streams, routing suggestions
  have no home, and Activity is removed. See Open questions.
- **Where structured elicitation appears.** Moves to the Canvas Chat tab and
  the Sidekick conversation.

The brief needs its own update once this PRD is approved.

## Decision log

The implementation plan written against these decisions is
[plan.md](plan.md).

### 2026-11-08 — A Canvas's icon and colour can be chosen

**Decided:** Anyone a Canvas admits can choose its icon and colour, from the
catalog and ring a Sidekick's appearance uses, through **Change appearance**
in the Canvas pill's menu. A Canvas nobody dressed keeps its defaults: the
sketch of its newest artifact's kind and the hue its id gives it. The
Sidekick's picker stays as it is. The product owner, 2026-11-08: "keep the
ability to manually choose a color and icon for a canvas (and sidekick)".
That anyone the Canvas admits may choose, as anyone it admits may retitle it,
is the implementer's reading and open to the owner's reversal.

**Why:** The owner's call. Before, a Canvas took its hue from its id and its
mark from its artifact's kind, with no choice, while a Sidekick kept its
picker.

**Changes:** Replaces "a Canvas stores no colour" (the 2026-11-08 design
entry's per-Canvas hue). `PATCH /canvases/:id` takes `appearance`;
docs/canvases.md, docs/automation-lifecycle.md, docs/activity.md.

### 2026-11-06 — Existing Threads, Breakouts and Channels are deleted

**Decided:** At cutover, every Thread, Breakout and Channel is deleted through
the workspace-retirement walk, object by object. No read-only mode, export or
conversion into Canvases.

**Why:** The product owner's call on open question 1. The old product drew no
market interest, and keeping its data reachable means keeping its readers
deployed.

**Changes:** Open question 1 closes. The Rollout section's no-flag default now
holds. Deletion is irreversible, so it runs as a guarded operator operation
after the readers are gone.

### 2026-11-06 — A Canvas has its own participant list

**Decided:** A Canvas is visible to its creator by default. The creator can add
participants, including guests, or open it to the whole Organization. The
public per-artifact origin keeps its current rules.

**Why:** The product owner's call on the first half of open question 2. Sharing
is per Canvas, with no grouping layer (non-goal 2).

**Changes:** Open question 2's first half closes. The Security and trust model's
first boundary is now decided.

### 2026-11-06 — A shared Sidekick uses delegate access only for its own runs

**Decided:** Anyone a Sidekick is shared with can talk to it. Delegate access is
used for runs its triggers start or that a delegate asks for. A request from a
person who is not a delegate runs under that person's own access, and a tool
that would need a delegate is refused with a named reason.

**Why:** The product owner's call on the second half of open question 2. A
person must not read, through the Sidekick, what they cannot read themselves.

**Changes:** Open question 2 closes. The Security and trust model's second
boundary is now decided.

### 2026-11-06 — Editing stays as it is; live co-editing is out of scope

**Decided:** Rally changes a Canvas by republishing it, as it does today, and
people comment through the existing annotations. Several people editing one
Canvas at once, live cursors and selections, in-place typed edit tools and the
pending-edit shimmer are not built.

**Why:** The product owner's call. The two modes already exist in the codebase
and are being pulled to the front; the collaboration layer the Summary names as
the larger half is the one part that does not exist, and the commenting feature
covers working together on a Canvas for now.

**Changes:** Goal 4 narrows to presence: people see who is in a Canvas. The
Product behavior for an open Canvas loses cursors and the shimmer. The Agent
behavior clause "republishing a whole directory is not how a Canvas changes"
is withdrawn; republishing is how a Canvas changes, and each version is
attributed to Rally. The tool contract the build PRD was to hold is the
existing `publish_resource`, scoped to a Canvas.

### 2026-11-06 — Connector ingress stops creating conversations

**Decided:** A Slack mention of Rally and inbound email no longer create a
conversation. Slack and email remain Sidekick triggers and delivery, and a
Slack reply still continues the Sidekick run it answers. Routing suggestions and
Suggested Work are deleted. Digests are deleted. Push notifications stay for
mentions in a Canvas Chat or Sidekick conversation, "Needs input" and finished
runs.

**Why:** The product owner's call on open question 3 and the ingress paths the
survey found. Routing suggestions were retired on 2026-08-30 and Suggested Work
has rendered nothing since 2026-09-11; both only ever created Threads.

**Changes:** Open question 3 closes. The Activity-derived clauses of the brief's
contract are removed rather than relocated.

### 2026-11-06 — A Canvas is any generated artifact, not only a live site

**Decided:** Every artifact Rally generates is a Canvas: documents,
spreadsheets, images, PDFs, archives and live sites. A Canvas is one resource
with versions and its own Chat; a site Canvas also has its per-artifact origin.

**Why:** The product owner's call. The Summary and the "What each feature
becomes" table read as if only live web artifacts became Canvases, which would
leave every other generated file with no home.

**Changes:** The "Artifacts section, live web artifacts, annotations" row of
that table covers all artifacts. The Canvas viewer is chosen by kind, reusing
the existing previews. Annotations already work across these kinds.

### 2026-11-06 — A Canvas is identified by its conversation and starts empty

**Decided:** A Canvas's id is the id of its own conversation (the agent loop's
parent coordinate), not an artifact or resource id. The artifacts a Canvas
generates hang off that conversation, one today and possibly several later. A
new Canvas has no artifacts; the first publish from its Chat creates the first
one as version 1.

**Why:** The product owner's call, after the plan first keyed a Canvas by its
resource and started it with a synthetic empty document. A resource version is
a pointer snapshot with provenance, and an empty file nobody made has none. The
conversation is the one thing that exists from the moment a Canvas is created,
and keying on it leaves room for one Canvas to produce many artifacts.

**Changes:** Nothing in the agreed scope. The artifact-to-conversation link
that exists today keeps its role, with the Canvas in the place a Thread held.

### 2026-11-06 — An open Canvas reuses the conversation layout

**Decided:** Opening a Canvas shows its conversation in the main pane and, once
an artifact exists, that artifact in the right panel, the way a Thread shows a
generated artifact today. Comments stay annotations in the conversation.

**Why:** The product owner's call. The layout, the artifact panel and the
annotation flow already exist for Threads; the mockup's artifact-first pane
with Chat and Comments tabs would have been the one new client primitive in the
pivot.

**Changes:** The Product behavior for "Canvas open" changes, and section 2 and
the dark frame in section 5 of [design.html](design.html) were redrawn the same
day: transcript in the main pane, artifact in the right panel with its version,
no cursors or pending-edit shimmer. The header pill, people present, Share and
the menu stay as drawn.

### 2026-11-06 — The shared Sidekick conversation keeps the wizard and run separation

**Decided:** In a Sidekick's shared conversation, a message addressed to the
Sidekick starts a run under its definition, the same path a manual trigger
takes, and the run's row carries its reply. Managers keep editing the Sidekick
through the wizard in that conversation. The conversation itself never runs the
Sidekick's definition directly.

**Why:** The product owner's call. Today's split between the authoring
conversation and runs is what makes a run auditable and delegatable; collapsing
them would make the conversation's loop act with delegate access on any
message.

**Changes:** The Product behavior for "Sidekick open" and the prose of section
4 of [design.html](design.html) now say so. The frames are unchanged.

### 2026-11-07 — Administrators can open what they manage; a Sidekick's Canvas reads the Sidekick's audience live

**Decided:** An Organization's owners and administrators can open every
Canvas, since they manage every Canvas's audience and cannot manage what they
cannot see. A Canvas a Sidekick writes admits the Sidekick's audience as it
stands, read live from the Sidekick, plus whoever its managers add to the
Canvas itself; nothing copies the Sidekick's list into the Canvas.

**Why:** The first build refused an administrator a private Canvas, so a
creator leaving the company stranded their Canvases. The first build also
copied the Sidekick's audience at creation and read it live, two sources of
truth that disagreed as soon as either list changed. Reading it live stores
nothing twice and keeps a Sidekick's Canvases open to whoever joins the
Sidekick later.

**Changes:** Plan steps A-6 and A-7. The earlier entry's "starts out open to
the people the Sidekick is shared with" means this live rule.

### 2026-11-07 — Who manages a Canvas's participants, and who can open a Sidekick's Canvas

**Decided:** A Canvas's creator, and the Organization's owners and
administrators, manage who can open it: add people, invite guests, or open
it to the Organization. Other participants read and take part but do not
change the audience. A Canvas a Sidekick makes starts out open to the people
the Sidekick is shared with, and the Sidekick's managers manage its audience
from then on.

**Why:** The help center had to say who can add people and found no decision.
Goal 6 needs a Sidekick's Canvas reachable from the Sidekick's conversation by
everyone in it, which a creator-only default would break. Keeping audience
changes with the creator and administrators matches the roles the product
already has.

**Changes:** Plan steps A-6 (participant management) and A-9 (a Sidekick's
Canvas inherits the Sidekick's audience). The help center's
who-can-see-what and where-results-go pages say the same.

### 2026-11-07 — A manager marks a wizard edit explicitly

**Decided:** In a Sidekick's shared conversation, every message addressed to
the Sidekick starts a run, from a manager as much as from anyone else. A
manager edits the Sidekick by marking a message as a wizard edit with an
explicit intent carried on the message; the server accepts that intent only
from a manager. Nothing infers which of the two a manager meant.

**Why:** The first build of the routing sent every manager message to the
wizard, so a manager could never ask the Sidekick to do work from its own
conversation. Inferring wizard-versus-run from the text would be a new
classifier with its own failure mode; an explicit mark is cheaper, faster and
cannot misroute.

**Changes:** Plan step A-1 and the composer in step A-13 (a wizard-edit
affordance for managers). The wizard and run separation from the earlier
entry stands.

### 2026-11-08 — design.html is the authority over the documents

**Decided:** Where a module document and this PRD's design.html disagreed on
a screen, the design wins and the document is corrected to it, in the same
change. Where the design is silent (Activity, the naming skeleton, the
browser's development sign-in) the owning document is the authority.

**Why:** The first visual inspection found the client had followed the
written documents in several places where they had diverged from the design
(the list width, grey Canvas marks, the home drawn as rows, the header pill
centred, other people's messages drawn as the viewer's own, the Sidekick page
laid out mirror-image). This PRD's Screens section says to see design.html
for every screen, so the documents were the ones out of date.

**Changes:** The design-conformance round (docs/desktop-shell.md,
desktop-layout.md, canvases.md, automation-lifecycle.md, browser-client.md
changelogs of 2026-11-08); the plan's section 9 records the decisions made as
the implementer's reading and open to reversal.

### 2026-11-08 — Activity returns, and Threads with artifacts become Canvases

**Decided:** The product gets a third rail section, Activity: each person's
feed of what happened to them in Canvases and Sidekicks (a mention, being
added to a Canvas, a Sidekick run that needs their input, a run they asked
for that finished), written beside the push intent for the same event and
cleared by the read cursor the Organization already keeps per conversation,
or by Mark all seen. The rail dock badge and the menu bar stay Needs
attention only. And a Thread that has artifacts is not deleted: the operator
converts it into a Canvas in place, keeping its id, before `retire_threads`
runs (`convert_threads_to_canvases`, dry run by default). Production held 60
such Threads across 7 Organizations when counted.

**Why:** The product owner's call after the pivot landed. Activity was
deleted with the Threads it listed; its return is sourced from the four push
events so the feed and push cannot disagree, and seen is derived rather than
written per item so the feed and a Canvas row's unread never drift apart.
Converting keeps artifact, search and memory rows reachable without
rewriting any id-keyed table; creating new Canvases and copying was
rejected for that reason.

**Changes:** docs/activity.md, docs/workspace-retirement.md; the deploy
order in the plan's section 9 is dump, convert, retire.

### 2026-11-08 — A Canvas made with no title is titled from its first message

**Decided:** A Canvas a person makes with no title is titled from the first
message of its Chat, by the `workstream_naming` model role the Thread product
named a Thread's opening message with. It reads as `naming` until the title
lands and `settled` after; a person who retitles it first keeps their title,
and a model that answers nothing leaves it **Untitled Canvas**. A Canvas a
Sidekick run makes, or one made with a title, is not renamed. This was the
implementer's reading, made while fixing the end-to-end pass's finding that a
new Canvas stayed **Untitled Canvas** forever, and is open to the product
owner's reversal.

**Why:** Nothing titled a Canvas, so a list of Canvases a person had started
from the composer read as a column of **Untitled Canvas**. The Thread product
titled from the opening message, and the role survived the pivot for pasted
text.

**Changes:** `HostedCanvas.nameFromOpening`, `canvas-naming.ts`, WorkspaceDO
migration 149 (`docs/canvases.md`).

### 2026-11-08 — Opening Activity opens its top row, and only a rail pick leaves Activity

**Decided:** Entering the Activity section selects its top row and opens that
row's target in the pane, the way a mail client opens the first message of the
folder it opens. Entering is the rail's Activity button (a push, so Back
returns to what was open), a launch with Activity stored (a replace of the
Canvases-home landing, so Back does not return to it; a Canvas or Sidekick
the window lands on, restored from this device or opened by a link, is kept),
and a link that names Activity. The first list
after entering decides: an empty feed opens nothing, and rows arriving, Mark
all seen or a click on another row never move the pane until Activity is left
and entered again. Once in Activity, the rail and the list stay there whatever
the pane opens, a row, an in-pane link, a push or a deep link; the person
leaves only by picking another section. The product owner, 2026-11-08: "When
opening the first activity on top should be auto selected and that should be
shown in the panels." and "Stay in activity sidebar." That a launch keeps
a restored Canvas rather than opening the top row is the implementer's
reading, so a person who quit with a Canvas open relaunches where they were;
it is open to the owner's reversal.

**Why:** The owner's call. Before, entering Activity left the pane on the
route it had, so the person saw a list beside whatever was open before and
had to click to start reading; and two paths still moved the rail off
Activity without a pick (closing the phone sheet without a navigation, and
the Activity link, which still opened the Canvases section from when Activity
was gone).

**Changes:** Replaces "the pane kept its route" on entering Activity.
`navigation-sidebar.tsx`, the Activity deep link in `app-session.tsx`;
docs/desktop-shell.md, docs/activity.md.

### 2026-11-07 — Anyone a Canvas admits can retitle it

**Decided:** Retitling a Canvas is open to anyone the Canvas admits, as
taking part in it is: anyone it admits already changes its artifacts from its
Chat. Who can open it stays with its creator and the Organization's owners and
administrators. This was the implementer's reading, made during plan step C-1
when `PATCH /canvases/:id` was added, and is open to the product owner's
reversal.

**Why:** The client's Rename Canvas needed a route and no decision said who
may use it. The title is no more protected than the artifacts it names.

**Changes:** Plan step C-1 (`HostedCanvas.rename`).

### 2026-11-06 — Canvas conversations stay in the conversation object, which is renamed

**Decided:** A Canvas's conversation is an ordinary conversation object, the
class today called `SubstreamAgent`, hosted in WorkspaceDO by one hosting
primitive shared with Sidekicks. The class is renamed `AgentLoopDO`; no new
Durable Object is added.

**Why:** The product owner's call. The object already hosts every kind of
conversation; the name describes a Breakout that no longer exists.

**Changes:** Nothing in the agreed scope. The rename is a `renamed_classes`
migration, as the earlier `WorkstreamRoom` to `SubstreamAgent` rename was.

### 2026-11-06 — Transcripts are dumped to R2 before Threads are retired

**Decided:** Before any Thread or Breakout is retired, its transcript is written
to R2 as text by a one-off operator operation. The dump is for operators, not a
product surface.

**Why:** Retirement is irreversible and the product owner chose deletion; the
dump costs one pass the retirement walk already makes.

**Changes:** Adds one step before deletion. Slack mentions and the browser
session import stay deleted; a Canvas conversation could have hosted them, and
the product owner chose not to.

### 2026-11-06 — iOS, Sideline, browser import and Thread-scoped Sidekicks

**Decided:** All iOS code is deleted rather than left to follow later. Sideline,
the represented-messaging app whose destinations are Threads, is deleted. The
ChatGPT and Claude session import is deleted. Thread-scoped Sidekicks convert to
Organization scope. Help center and site copy change in the same train as the
code.

**Why:** The product owner's call. Each either targets a Thread or is a
prototype with no home after the pivot.

**Changes:** Non-goal 1 (iOS deferred) becomes a deletion. The rollout is one
cutover train with no flag.

## Key design decisions

1. **Sidekicks move into the main window.** As one of only two sections, they
   need the same sidebar and shell as Canvases. Rejected: keeping the separate
   Sidekicks window, which would leave the main window with one section.
2. **A Canvas carries its own Chat with Rally.** With Threads gone, talking to
   Rally about shared work happens next to the Canvas, open to everyone in it.
   Rejected: a separate Rally conversation that links to Canvases, which brings
   back a Thread under another name.
3. **A Sidekick's output is a Canvas.** This links the two modes without a third
   concept. Rejected: Sidekick-only output (messages, files) that people cannot
   edit together.

## Security and trust model

Two trust boundaries change, and neither has a decided answer yet. Both block
the build:

- **Who can open a Canvas.** Today an artifact inherits the audience of the
  Thread that published it. With Threads gone, a Canvas needs its own access
  model: who can open it, who can invite, and how that interacts with the public
  per-artifact origin described in
  [live web artifacts](../../live-web-artifacts.md).
- **Whose access a shared Sidekick uses.** Today a Sidekick acts as anyone on
  its Delegation allowed list, using their current access
  ([Sidekick delegation](../2026-10-22_sidekick-delegation/prd.md)). Joining its
  conversation grants no delegation. Once anyone it is shared with can ask it
  things, the PRD must say whether a person who is not a delegate can have the
  Sidekick read, through a delegate's connector, something that person cannot
  read themselves.

## Agent behavior

- In a Canvas's Chat, Rally runs with the Canvas's current content and the
  Chat transcript as context. It edits the Canvas through typed tools that
  change part of it in place, so people see each edit land; republishing a whole
  directory is not how a Canvas changes.
- Rally's edits run without asking anyone first, per the
  [tool execution product policy](../../../CLAUDE.md#tool-execution-product-policy),
  and each one is attributed to Rally in the Canvas's history.
- A Sidekick acts within the access it already has, and asks people only for
  information it lacks.

The tool contract itself belongs in the build PRD.

## Rollout

Per [`docs/prds.md`](../../prds.md), the default is that this ships to everyone
on merge, with no flag. That default cannot hold until the open question on
existing data is answered, because shipping removes surfaces that hold users'
Threads and Breakouts. Whether to stage it behind a flag is an engineer's call
when the build starts.

The [Channels and Threads navigation](../2026-10-10_channels-threads-navigation/prd.md)
PRD is `in progress`. Its build stops when this PRD is approved; this change
adds the supersession note to its `state.md`.

## Open questions

All three were answered on 2026-11-06; see the decision log.

1. **What happens to existing Threads, Breakouts and their transcripts?**
   Deleted.
2. **Who can open a Canvas, and whose access a shared Sidekick uses.** A
   per-Canvas participant list, creator-only by default; a shared Sidekick uses
   delegate access only for its own runs.
3. **Where connector routing suggestions go.** Nowhere; they are deleted.
