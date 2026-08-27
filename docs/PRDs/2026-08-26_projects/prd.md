# Projects

> Created 2026-08-26.
>
> Add projects as an optional way to group related work streams, give them
> shared resources, and find them in the sidebar.
> Companion: [state](state.md). Subsystem references:
> [data model](../../data-model.md),
> [Queue versus RPC](../../choosing-queues-or-rpc.md),
> [work-stream creation](../../workstream-creation.md),
> [work-stream pinning](../../workstream-pinning.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Rally adds **Projects** below **Actions** and above **Pinned** in the sidebar. A
project gives related work streams a shared name, icon, color, participant list,
and default-resource set. A recruiter can use a project for a hiring search, a
designer for a campaign, a product manager for a launch, and an accountant for
a close; the feature does not assume that the work is software development.

A person can start a work stream inside a project or add an existing work
stream by dragging it onto the project or using **Add to project** in the work
stream's right-click menu. Joining a personal project seats every project
participant in the work stream; joining a workspace project makes the work
stream workspace-scoped. Project resources are attached to every work stream in
the project. A finished project can be archived without deleting its work
streams or undoing the access and resources already applied to them.

Projects and their cross-work-stream relationships are workspace product state
owned by `WorkspaceDO`. The membership table is many-to-many from the start, so
one work stream can eventually belong to several projects while also being
pinned. V1 lets a person assign a work stream to at most one project, while
read contracts and compact icon piles accept several memberships. Pinning
remains an independent, per-person choice.

## Motivation

Work streams are currently easy to start and pin, but Rally has no durable way
to say that several of them contribute to the same piece of work. People must
attach the same resources again and remember the relationship from titles
alone. Pinning does not solve that: a pin means “keep this work stream handy for
me,” not “these work streams share a goal.”

The product owner raised this as a current, recurring setup problem in the
2026-08-26 direction brief that initiated [PR #350](https://github.com/juno-ai-labs/avalon/pull/350):
recruiting, design, product, accounting, and other company efforts commonly
need several work streams, but each additional work stream repeats resource
setup and leaves the relationship encoded only in titles or one person's pins.
The frequency is therefore per related work stream: setup is repeated every
time another one is created or brought into the effort. The cost is user time,
inconsistent inputs between related work streams, and a grouping that other
participants cannot see.

Rally does not yet have usage measurements or a support-ticket count that can
quantify that frequency. The evidence for doing this now is the direct product
decision above, not a claimed incident or metric. The selected direction makes
the relationship useful rather than merely cosmetic by applying the same
authorized resources to each work stream.

## Goals

1. A person can create a project with a name, one of 25 general-purpose icons,
   and a color.
2. Projects appear immediately below **Actions** and above **Pinned** in a fixed,
   per-person order stored by the server, and a person can rearrange them by
   dragging project rows.
3. A person can start a work stream from the plus button on a project row or add
   an existing one by drag and drop or a right-click submenu.
4. Every work stream in a project receives the project's default resources
   without duplicate resource links.
5. A project can be `personal` or `workspace` scoped and uses Rally's existing
   participant and reader rules.
6. Joining a project enlarges the work-stream audience to include the project's
   audience before its default resources are applied.
7. Removing a work stream from a project leaves resources, participants, and
   workspace scope already applied to the work stream in place.
8. The data model supports many projects per work stream without exposing
   multi-project editing in V1.
9. A work stream in **Needs attention** shows the icon or icon pile for the
   projects it belongs to.
10. A person can archive and restore a project without deleting its work streams
    or rewriting their history.

## Non-goals

1. **Editing several project memberships for one work stream is deferred.** V1
   assignment controls show and edit one project. Read contracts and the Needs
   attention icon pile are plural-ready, but V1 provides no command that creates
   a second membership. The schema must not add a uniqueness rule that prevents
   future many-to-many membership.
2. **Subprojects, portfolios, milestones, task boards, dependencies, budgets,
   and project schedules are deferred.** A project groups work streams and
   supplies shared resources; it is not a second work-management product.
3. **Automatic project assignment is deferred.** Rally does not infer a project
   from a work-stream title, transcript, participant, or resource.
4. **Removing inherited resources is rejected.** Leaving a project or removing
   a project default does not pull a resource out of an existing work stream.
   Removing content after it has entered a work stream would make later runs
   and old transcript references harder to understand.
5. **Project-specific instructions, prompt context, and memory are excluded.**
   A project does not change a work stream's system prompt, create a memory
   scope, or alter the memory available to an agent run.
6. **New project-specific roles are deferred.** Projects use the existing
   personal/workspace scope and participant model rather than adding project
   owners, managers, or guests.
7. **Permanent project deletion is deferred.** V1 supports reversible
   archiving. It does not permanently delete a project or its membership
   history.

## Product behavior

### The sidebar

The sidebar places **Projects** immediately below **Actions** and above
**Pinned**. Unlike **Pinned**, the Projects heading remains visible when empty
because it contains the control for creating the first project.

Each active project row contains these elements from left to right:

1. an accordion button using Tabler's `IconTriangle`, pointing right when
   collapsed and down when expanded, with `aria-expanded` matching that state;
2. the project's colored icon;
3. the project name;
4. flexible empty space; and
5. a new-project-work-stream button using Tabler's `IconPlus`.

The row is a semantic grid rather than one outer button containing other
buttons. The middle project-space link spans the project icon, name, and empty
space, making that visible part of the row open the project space. The triangle
button only expands or collapses the project's work streams. The plus button
only opens **New project work stream** for that project. All three controls have
independent keyboard focus and accessible names; the plus button's name and
tooltip are **New work stream in {project name}**. A personal project carries
the same “only the participants can see this” privacy marker used by other
personal Rally surfaces.

Archived projects do not appear among active project accordions, **Add to
project** menus, or project icon piles.

Project order is a personal preference stored in `WorkspaceDO`. Activity,
renaming, icon changes, and another person's arrangement do not move a project.
A newly visible project is appended to the end of that person's list. The same
order appears on every desktop signed in as that person.

A person reorders projects by dragging one project header between two other
project headers. The drop indicator shows the exact resulting position, and a
failed write returns the project to its server-owned order. Keyboard users can
move the focused project with the same Alt+Up and Alt+Down pattern used for
pinned work streams. Reordering changes no project anyone else sees.

Project-header dragging and work-stream dragging are separate actions. Dragging
a project header between project rows reorders projects. Dragging a work-stream
row onto a project header or its expanded body adds or moves the work stream;
it never reorders the project itself.

Inside an expanded project accordion, work streams are ordered by their own
`lastActivityAt`, newest first, with `workstreamId` as the stable tie-breaker.
Realtime activity can move a work stream inside its accordion, but the project
header stays in its fixed personal position. Expanded or collapsed state
follows `projectId` and does not reset after either kind of reorder.

A work stream can appear under its project and in **Pinned** at the same time.
Pinning is still personal and ordered by the person who pinned it. Project
membership does not pin, unpin, or reorder a work stream.

When projects are loading, the section shows skeleton rows. When there are no
projects at all, it says **No projects yet** and offers **New project**. When
only archived projects remain, it says **No active projects** and offers **New
project**. If a project cannot be refreshed, Rally keeps any previously loaded
rows visible, marks the section as out of date, and offers **Try again**. It
does not replace known project membership with an empty list.

### Project icons in Needs attention

The **Needs attention** section on the **New work stream** screen keeps its
existing membership and ordering rules. Projects do not make a work stream need
attention, and project activity does not replace the row's own
`lastActivityAt`.

When a listed work stream belongs to an active project, the row places that
project's colored icon immediately to the left of the work-stream name. The component
accepts an ordered list and overlaps several icons as a compact project icon
pile. V1 normally supplies one icon because its assignment controls expose one
project, but the row renders every authorized membership returned by the
server. This display does not add a second way to edit multi-project
membership. When several memberships exist, the pile uses the same project
order that this person sees in the sidebar.

The pile is part of the work-stream row, not a separate navigation target.
Clicking it opens the work stream like the rest of the row. Hover text and one
screen-reader description say **Projects: Hiring, Website launch**, using the
current project names in pile order. A work stream with no project has no pile
and reserves no empty space. The existing Needs attention status marker remains
at the leading edge and keeps its existing meaning; the project pile sits
between that marker and the work-stream name.

### Creating and editing a project

**New project** opens a dialog with three required choices:

- **Name:** a non-empty workspace-unique name. Comparison ignores surrounding
  whitespace and letter case so `Hiring` and `hiring` cannot become two
  different projects.
- **Icon:** exactly one icon from the fixed V1 library below.
- **Color:** one solid icon fill chosen from the fixed project palette below.
  Rally stores the palette key rather than a hex value, so the same choice can
  use the right accessible shade in every theme.

The V1 project-color palette contains exactly these choices:

1. **Gray** — `gray`
2. **Brown** — `brown`
3. **Red** — `red`
4. **Orange** — `orange`
5. **Yellow** — `yellow`
6. **Green** — `green`
7. **Teal** — `teal`
8. **Cyan** — `cyan`
9. **Blue** — `blue`
10. **Indigo** — `indigo`
11. **Purple** — `purple`
12. **Pink** — `pink`

The picker shows all 12 swatches in a compact grid with no persistent visible
names. Hovering a swatch shows its color name in a tooltip; keyboard focus shows
the same tooltip, and the swatch always exposes that name to assistive
technology. The selected swatch has a non-color selection indicator. These keys
resolve through new `sys.color.project.<key>` design tokens supplied by every
Rally theme. A theme may change the rendered shade for contrast, but it must
preserve the named hue. V1 does not accept custom colors, opacity, or gradients.

The V1 icon library contains exactly these Lucide choices. The first value is
the `lucide-react` component; the second is the stable stored `icon_key`:

1. `Briefcase` — `briefcase`
2. `Target` — `target`
3. `CalendarDays` — `calendar-days`
4. `ListChecks` — `list-checks`
5. `ClipboardList` — `clipboard-list`
6. `FileText` — `file-text`
7. `Folder` — `folder`
8. `Lightbulb` — `lightbulb`
9. `Star` — `star`
10. `Flag` — `flag`
11. `Rocket` — `rocket`
12. `ChartNoAxesCombined` — `chart-no-axes-combined`
13. `Calculator` — `calculator`
14. `Coins` — `coins`
15. `Users` — `users`
16. `UserSearch` — `user-search`
17. `Handshake` — `handshake`
18. `Megaphone` — `megaphone`
19. `Palette` — `palette`
20. `Image` — `image`
21. `PenTool` — `pen-tool`
22. `Package` — `package`
23. `Building2` — `building-2`
24. `Globe2` — `globe-2`
25. `Heart` — `heart`

The implementation imports these named components from `lucide-react`; it may
alias `Image` locally to avoid colliding with the browser's global `Image`
constructor. The selected project-color token colors the icon glyph. Each icon
has an accessible plain-language name in the picker, works at sidebar size, and
receives a theme-safe outline or surrounding treatment when its color alone
would have poor contrast. V1 does not accept emoji, uploaded art, or arbitrary
SVG.

The creation dialog also chooses **Personal** or **Workspace** scope and starts
with the creator as a participant. Personal is the default, matching new work
streams. Project settings in the project space provide the same fields for
later editing, plus participants.

When the person may read at least one archived or restoring project, the **New
project** dialog footer also offers **Restore archived project**. It opens a
keyboard-searchable recovery picker of readable archived and restoring
projects, ordered by most recent lifecycle activity and labelled by state.
Choosing one opens that project space, where the person can review conflicts,
retry or cancel an unfinished restoration, or restore an archived project.
This is the deliberate route back to inactive projects; they remain absent
from the Projects sidebar section and its menus.

Archived projects continue to reserve their normalized names. A conflicting
create or rename says **A project with that name already exists** without
revealing an archived project the caller cannot read. When the caller may read
the archived project, the error also offers **Open archived project** so they can
rename or restore that one. This contextual link does not add a list or menu for
archived projects.

### The project space

Clicking the project row opens a project space with two main sections:

- **Work streams:** every readable work stream currently in the project, using
  the same table styling, row density, typography, hover and focus treatment,
  and activity/status presentation as the **Needs attention** table. Project
  membership does not itself mean that a work stream needs attention. Rows are
  still ordered by `lastActivityAt DESC, workstreamId`, and clicking a row opens
  that work stream.
- **Default resources:** the project's current default-resource list and an
  **Add resource** control. Each item uses the ordinary Rally resource row and
  can be removed from the defaults without removing it from work streams that
  already received it.

The project-space header shows the project icon, name, scope, and participants.
Its settings affordance edits those fields and the participant list.

Its menu also provides **Archive project**. Archiving is confirmed because it
removes the project from active navigation and stops new assignments and
default-resource propagation. An archived project space is read-only except for
**Restore project** and removing a retained work stream from the project.
A restoring project space is read-only except for **Retry restore**, **Cancel
restore**, and removing a retained work stream through the command that first
supersedes its pending restore targets.

Every project reader can read every work stream admitted to that project: a
personal project's participants are seated in each work stream, and a workspace
project makes each work stream workspace-scoped. The space still checks the
authoritative work-stream audience for every row rather than treating knowledge
of project membership as a substitute for work-stream authorization.

### Archiving and restoring a project

Archiving is reversible and does not dismantle the work already done. Rally
keeps the project, its participants, default-resource configuration, and
work-stream membership rows. It also keeps every resource, participant, and
workspace scope already applied to a work stream.

When archiving starts, the project becomes inactive immediately:

- the project disappears from the active sidebar, assignment menus, and project
  icon piles;
- nobody can start a work stream in it or add or move a work stream into it;
- its defaults stop applying to work streams while it is archived.

Archiving has no effect on an agent run. Projects do not supply system-prompt
content or memory, so there is nothing to add, freeze, remove, or restore in the
agent harness.

An archived membership does not count as the work stream's one active V1
project assignment, so the work stream may join another active project. The
retained membership remains visible in the archived project space and can be
removed there without changing resources, participants, or scope already
applied to the work stream.

While a project is archived, somebody may be added to one of its former work
streams. Before restoring the project, Rally checks that everybody who can open
each retained work stream may also open the project. It also checks that
restoration would not create a second active project assignment in V1. If
either check fails, Rally leaves the project archived and names the work stream
and person or project causing the conflict. The person can fix that audience or
remove the work stream from one project before retrying.

If preflight succeeds, the same `WorkspaceDO` transaction changes the project
to `restoring` and reserves every retained membership against V1 add, move, and
restore commands. An assignment that commits first makes restore preflight
fail; a restore that commits first makes a later assignment return
`project_conflict`. Rally then applies any missing audience expansion and
current default resources, with the usual resource deduplication. The project
remains in `restoring` state until every member work stream is ready. Its final
activation transaction rechecks the reserved memberships and the audience
generations settled by the restore operation before changing the project to
`active`. A restored project is appended to the end of each authorized
person's active project order.

For example, if **Candidate research** retained an archived membership in
**Hiring** and later joined active project **Executive search**, restoring
**Hiring** says **Candidate research is currently in Executive search**. The
person can remove the retained membership from **Hiring** or remove the newer
assignment before retrying. The API returns the stable `project_conflict` code
and the blocking project and work-stream IDs; the desktop names only projects
and work streams the current reader may see.

Archiving is one `WorkspaceDO` transaction; the project space shows
**Archiving…** while that write is pending. Restoration is durable and
resumable because it may need to reapply audiences and default resources across
several work streams. It shows **Restoring…** until every target acknowledges
readiness. Closing the desktop does not abandon restoration.

If a restore target fails, the restoring project remains in the recovery picker
with **Retry restore** and **Cancel restore**. Retry requeues only failed
current-generation targets. Cancel is one `WorkspaceDO` transaction that
returns the project to `archived`, supersedes its unfinished audience and
resource targets, and releases its work-stream reservations. It does not undo
audience expansion or resource links already applied before cancellation.

### Starting a work stream in a project

The row's Tabler `IconPlus` button opens **New project work stream**. This page
uses the ordinary **New work stream** page's composer, attachments, model and
plugin controls, validation, and start behavior, with the project icon and name
shown as a fixed selection. The project cannot be cleared on this page;
starting a work stream outside it uses the ordinary **New work stream** page.

**New project work stream** does not render the **Needs attention** or
**Suggested work** sections. It is a focused creation page for the selected
project, not another project dashboard.

Creation does not launch the first agent run until all of the following are
durable:

1. the work stream and its audience;
2. the project membership;
3. every active personal-project participant seated in a personal work stream,
   or `workspace` scope applied from a workspace project;
4. the current project-default resource links, deduplicated by canonical
   resource identity.

If this setup cannot complete, the opening message remains available for retry
and Rally says that the work stream could not be started in the project. It does
not silently start an unconfigured first turn.

### Adding an existing work stream

A person who can read both the project and the work stream can add it in either
of two ways:

- drag the work-stream row onto an expanded or collapsed project row; or
- right-click the work stream, choose **Add to project**, then choose a project
  from a submenu that shows each project's icon, color, and name.

Before committing an audience change, Rally says what will happen: either
**Everyone in this workspace will be able to open this work stream** or
**These project participants will be added to this work stream**, followed by
the names being added. Drag and menu entry use the same confirmation. If the
project adds nobody and does not change scope, no extra confirmation is needed.

In V1, a work stream has at most one visible project assignment. Adding an
unassigned work stream creates that membership. Choosing a different project
for an assigned work stream moves it: Rally applies the new project first, then
removes the old membership in one WorkspaceDO command after all audience,
participant, scope, and resource checks pass. Applying a personal project adds
every active project participant to the work stream. Applying a workspace
project changes the work stream to `workspace` scope. A failed drag or menu
action leaves the old assignment and audience in place and returns the row to
its previous location.

Some apparent moves are not safe as one action. In particular, a work stream
made workspace-scoped by its old project cannot move directly into a personal
project. The person removes it from the old project, deliberately makes the
work stream personal with the intended participants, and then adds it to the
personal project. Rally explains those steps instead of silently narrowing the
audience.

The persistence contract remains many-to-many. `project_workstreams` is keyed
by `(project_id, workstream_id)` and has no unique constraint on
`workstream_id`. V1's one-project rule belongs in the user-facing command, not
the table.

The work stream's project submenu shows its current project with a checkmark.
The work stream also has **Remove from project**. Removing it does not archive
the work stream or change its pin.

### Default resources

A project reader can add any workspace resource they are authorized to use to
the project's **Default resources** list. Adding a default applies it to:

- every work stream already in the project; and
- every work stream added or created later.

The attachment is a link to the existing workspace resource, not a copy of the
resource or its bytes. Deduplication uses the canonical resource identity. If
that resource is already attached to a work stream, Rally keeps the existing
link and records the project application as satisfied. It does not add a second
row or replace the existing relationship metadata.

Adding a default resource to a project with existing work streams is performed
through a regional Cloudflare Queue. The `WorkspaceDO` transaction that adds
the default also creates one durable application record for each current work
stream. Its alarm publishes ID-only application pointers to the Queue; the
regional API consumer claims each application from `WorkspaceDO`, attaches the
resource through the owning work stream's typed RPC, and then settles the
application receipt in `WorkspaceDO`.

The Queue is at-least-once and unordered. Every application therefore has a
stable ID and captures the project, membership, default-resource, and audience
generations it expects. The consumer reloads and authorizes current state
before applying it. A duplicate delivery is satisfied by the existing receipt
or canonical resource link. A delivery made stale by removing the default,
removing the work stream, archiving the project, or changing its audience is
settled as superseded rather than applying old intent.

The consumer acknowledges or retries each message independently so one bad
application does not replay a successful batch. Transient failures retry on
the Queue. Every regional Queue has its own `PROJECT_RESOURCE_DLQ`, and that
Queue has a regional failure consumer rather than being a passive callback.
The failure consumer claims the application from `WorkspaceDO`, changes the
matching still-queued generation to `failed`, and acknowledges the dead-letter
message only after `WorkspaceDO` reports failed or already terminal. If that
receipt write is unavailable, the DLQ message retries. The failure consumer
never calls the work-stream resource effect and never retries delivery itself.

The project space shows **Adding to work streams…** until every target is
applied, already satisfied, superseded, or failed. A failed target is named by
work-stream title only to readers who may see that work stream and can be
retried without duplicating successful links. Closing the desktop does not
abandon this work.

Restore uses this identical application path. Its `WorkspaceDO` transaction
creates a fresh application generation for every current default and retained
member work stream, including pairs with an older applied receipt. The Queue
consumer then settles each new receipt through the same canonical-resource
deduplication before restoration may become active.

Removing a resource from **Default resources** stops applying it to work
streams added in the future. It does not detach the resource from current work
streams. Removing a work stream from the project follows the same rule: every
resource already attached remains attached. It also does not remove
participants added by the project or return a workspace-scoped work stream to
personal scope. Those are now ordinary work-stream audience choices and may
have been relied on outside the project.

### Scope, participants, and audience safety

The product label **Personal** maps to the existing stored `personal` scope;
this PRD does not introduce a second `user` project-scope value. The existing
`user` directory-audience value remains a separate per-viewer projection.

- A `workspace` project is readable by every active workspace member. Its
  participant list records explicit participation but does not narrow that
  workspace audience.
- A `personal` project is readable only by its active participants. The creator
  is seated at creation. Adding and removing participants follows the same
  rules as a personal work stream.
- Anyone who may read a project may edit its presentation, add participants,
  manage default resources, add a work stream they are also allowed to read,
  and archive or restore it. A participant may remove themself. Removing
  somebody else requires the workspace `owner` or `admin` role, matching the
  current work-stream collaboration model rather than creating a
  project-specific mass-revocation privilege.

Project resources may be applied only after the work stream has the project's
audience:

- joining a workspace project changes the work stream to `workspace` scope
  before project resources apply; and
- joining a personal project requires a personal work stream whose current
  participants are already project participants, then seats every remaining
  active project participant in the work stream before project resources apply.

A personal project cannot contain a workspace-scoped work stream. Rally refuses
that drop or menu action, explains the scope mismatch, and offers the two safe
paths: change the project to workspace scope or first make the work stream
personal with its intended participants. If an existing personal work stream
includes somebody who is not yet a project participant, Rally asks the caller
to add that person to the project first. Once that is done, adding the work
stream seats all other project participants automatically. This makes the two
personal audiences equal at admission without silently sharing the project
with a new person.

Adding a participant to a personal project is one durable audience operation.
`WorkspaceDO` first creates the participant in `adding` state, which does not
authorize project reads, and creates one target for every current member work
stream. Its alarm publishes ID-only target pointers to the regional
`PROJECT_AUDIENCE_QUEUE`. The consumer claims each target from `WorkspaceDO`,
applies a version-fenced typed addition to the owning `WorkstreamDO`, and
records the receipt before acknowledging the message. The participant becomes
`active` and may read the project only after every target is applied or its
membership was removed and the target was superseded. Partial failure leaves
the safe `adding` state in place, shows **Adding participant…** to current
project readers, names only failed work streams they may read, and can be
retried without replaying successful targets. Adding a participant directly to
one of the member work streams is refused until the person has been added to
the project and this operation has completed. An empty project has no targets,
so the participant becomes active in the creating transaction.

Removing a participant from a non-empty personal project is one durable
operation, not a sequence the person must perform by hand. The caller may
remove themself; removing somebody else fails with
`participant_removal_denied` unless the caller is a workspace owner or admin.
After that authorization, `WorkspaceDO` first
changes the project participant from `active` to `removing`. A removing
participant immediately stops being a project reader, cannot receive new
project propagation, and disappears from the active participant list. The
operation then removes that person from every current member work stream using
ID-only messages on the regional `PROJECT_AUDIENCE_QUEUE`. Its consumer claims
each removal target from `WorkspaceDO`, applies a version-fenced typed effect to
the owning `WorkstreamDO`, and records the receipt before acknowledging the
message; the work-stream removal uses the existing access-revocation path. It
marks the project participant `removed` only after every target acknowledges
the removal. Partial failure leaves the safe `removing` state in place, names
the failed work stream to remaining authorized readers, and retries through the
Queue; closing the desktop does not abandon it. During convergence, the person
may still open a not-yet-updated work stream directly but cannot use the project
to discover or open other members. Its region-specific dead-letter consumer
marks an exhausted target `failed` and lets an authorized reader retry it; it
does not restore project access.

Every direct participant or scope mutation for a project member work stream is
mediated by a `WorkspaceDO` project-membership guard before the owning
`WorkstreamDO` applies it. The guard refuses removing an active project
participant directly from one member work stream; the caller removes them from
the project so the durable operation updates every member. It also refuses a
scope change that would make a personal-project work stream workspace-scoped or
a workspace-project work stream personal. The person must first remove the work
stream from the project or make the project scope compatible. Because
membership and these commands serialize in `WorkspaceDO`, a concurrent add,
move, participant change, or scope change cannot pass an earlier check and
commit an incompatible audience afterward.

Changing a personal project to workspace scope uses the same durable audience
operation. The project remains personal and records a pending `workspace`
scope while `PROJECT_AUDIENCE_QUEUE` widens every current member work stream.
The project space shows **Making workspace-visible…** until all target receipts
are applied, then one `WorkspaceDO` transaction changes the project scope to
`workspace`. A partial operation is safe: a work stream may become
workspace-scoped before the others, but the still-personal project never
advertises access that a member work stream lacks. Failed targets remain
retryable and successful targets are not replayed. A workspace project can
change back to personal only when it contains no work streams; Rally never
makes its work streams private as a side effect. Widening an empty project
completes in the creating transaction.

While one of these audience operations is unfinished, `WorkspaceDO` refuses a
second participant or project-scope change and any add, move, new-work-stream,
default-resource, or archive command for that project with a retryable
`project_busy` result. A `participant_add` or `scope_widen` operation cannot
start while the project has an unfinished default-resource application.
Participant removal is an access revocation and is never delayed by resource
delivery; after it settles, `WorkspaceDO` creates a fresh application generation
for each current default/member pair whose earlier application was superseded
by the removal. Removing a member work stream supersedes its still-pending
target before removing the membership. These fences and replacement
generations keep a membership or default created halfway through convergence
from going missing. The ordinary guard permits an operation-authenticated
`scope_widen` target to create the temporary safe state where a personal
project contains some already-workspace-scoped members; no ordinary direct
scope command receives that exception.

The error for an unsafe change states the shortest correction: add or remove
the person through the project, remove the work stream from the project, or
widen the project. Rally does not retain an unsafe membership while quietly
skipping its default resources.

The authorization check uses current scope and participant generations from
the owning authorities. Knowing a project ID, work-stream ID, resource ID, or
participant ID is never enough to read or mutate it.

### Offline and error behavior

Previously loaded projects and their readable work-stream rows remain available
for navigation while offline. Creating or editing a project, changing
membership, changing participants, changing defaults, archiving, and restoring
require a confirmed server write and are disabled offline. Rally does not show
an optimistic project assignment or lifecycle change as complete before
`WorkspaceDO` has accepted it.

If a project mutation races with a scope, participant, resource, or work-stream
revision, Rally rejects the stale mutation and refreshes the affected project.
The person's draft name or opening message remains in the form so it can be
submitted again.

## Impact on the product contract

This extends the Rally implementation brief with an optional organizing layer
above work streams. A work stream remains the unit of conversation, execution,
participants, transcript, resources, and pinning. A project does not become a
channel and does not own or merge its work streams' transcripts.

When this ships, the standing implementation brief should say that related work
streams may share a project, and that project membership can supply authorized
default resources. The existing rule that authorization is based on scope and
participants does not change.

## Decision log

None yet.

## Key design decisions

1. **Projects live in `WorkspaceDO`.** They organize several work streams and
   use workspace resources, so they are workspace product state rather than
   state owned by one `WorkstreamDO`. Putting them in regional D1 would restore
   a product-state authority that Rally has retired.
2. **Membership is many-to-many even though V1 is not.** A join table without a
   unique `workstream_id` keeps the future capability cheap. V1 uses a
   move-style command so the current interface stays simple.
3. **Resources are copied as durable links.**
   A resource remains useful and understandable after a work stream leaves a
   project. Audience changes applied by a project also remain because silently
   revoking access on removal would be unsafe.
4. **Default-resource fan-out uses Cloudflare Queues.** A project may already
   contain several work streams, and no desktop request or `WorkspaceDO`
   invocation should synchronously call every owning work stream. The project
   mutation records the intended applications durably and a regional Queue owns
   delivery, retries, backlog, and dead-lettering. The consumer applies one
   idempotent work-stream effect per message and records its receipt; the
   producer does not also call the target directly or build a second retry loop
   over RPC.
5. **Audience containment is enforced, not patched over.** The rejected
   alternative was to let incompatible projects and work streams remain linked
   while selectively skipping resource inheritance. That would leave project
   membership and the resources it promises out of sync.
6. **Joining expands an audience; leaving never contracts it.** Personal
   project participants are seated in the work stream and a workspace project
   makes it workspace-scoped. Automatically undoing either change on removal
   was rejected because people may have relied on that access after it was
   granted.
7. **Member audience changes are durable operations mediated by
   `WorkspaceDO`.** Project membership and V1's one-active-project rule live
   there, so checking in a desktop or directly in `WorkstreamDO` would race
   with project mutations. A `WorkspaceDO` guard serializes the decision. When
   one change affects several work streams, regional Queue targets and durable
   receipts make partial progress resumable, while version-fenced typed effects
   leave each work-stream authority responsible for its actual audience write.
8. **Project order is personal and manual; work-stream order is by activity.**
   A fixed server-owned project order keeps the sidebar where each person put
   it. Sorting project headers by activity was rejected because a message in
   any child work stream would move the whole accordion. Inside the accordion,
   activity order is useful because it brings the work stream that changed to
   the top without rearranging the person's project map.
9. **The icon catalog is fixed and business-neutral.** Arbitrary uploads and
   emoji were rejected for V1 because they add moderation, rendering, and
   cross-platform consistency problems without improving the core grouping
   workflow.
10. **Archiving deactivates a project; it does not unmake it.** Deleting
   memberships or inherited state was rejected because restoration would have
   to guess what the project previously changed. Archiving retains membership,
   audiences, and attached resource links while stopping new assignments and
   default-resource propagation.

## Data model

All project tables are native `WorkspaceDO` SQLite tables. The object's
singleton already owns the workspace identity, so these tables do not repeat a
meaningless local `workspace_id` column.

- `projects` owns `project_id`, `name`, `normalized_name`, `icon_key`,
  `icon_color_key`, `scope`, `status` (`active`, `archived`, or `restoring`),
  optional `archived_at` and `archived_by_user_id`, `created_by_user_id`,
  `created_at`, `updated_at`, and a monotonic `revision`. `normalized_name` is
  unique among projects in every lifecycle state so restoring a project cannot
  collide with a newer name. `icon_key` is restricted to the 25 V1 keys;
  `icon_color_key` is restricted to the 12 V1 project-color keys.
- `project_participants` owns `adding`, `active`, `removing`, and `removed`
  participant history and the participant generation used by authorization.
  Only `active` rows authorize project reads. Its shape otherwise follows
  work-stream participants even though it lives in a different authority.
- `project_audience_operations` owns one durable root for a `participant_add`,
  `participant_remove`, or `scope_widen`. It stores the operation and project
  IDs, actor, expected project revision, optional participant and pending scope,
  and `pending`, `running`, `failed`, or `applied` state.
- `project_audience_targets` owns one receipt per operation and member work
  stream. It stores the operation, project, participant when applicable, and
  work-stream IDs; expected membership and audience generations; and
  `pending`, `queued`, `applied`, `superseded`, or `failed` state. A participant
  addition or pending scope does not become active, and a removal does not
  become final, until every target is applied or superseded by removing that
  membership.
- `project_workstreams` owns `project_id`, `workstream_id`, who added it, when
  it was added, the admitted project/work-stream audience generations, and the
  application state for audience expansion. Per-resource receipt state lives in
  `project_resource_applications`; the project space reads both sources for
  bulk progress. Its primary key is `(project_id, workstream_id)`. There is
  deliberately no uniqueness constraint on `workstream_id`.
- `workspace_project_order` owns one person's project order. It is keyed by
  `(user_id, project_id)` and stores a dense ascending `position`, following the
  same server-authoritative pattern as `workspace_workstream_pins`. It is a
  viewer preference, not shared project state, and is never broadcast to other
  users.
- `project_default_resources` owns one row per `(project_id, resource_id)` plus
  attribution and attachment time.
- `project_resource_applications` is both the durable enqueue intent and the
  idempotent receipt for one generated application. It owns a stable
  `application_id`; one monotonic `application_generation` sequence per
  `(project_id, resource_id, workstream_id)` tuple, starting at 1 for that
  tuple's first application; the three subject IDs; the expected project,
  membership, default-resource, and audience generations; and `pending`,
  `queued`, `applied`, `superseded`, or `failed` state. A uniqueness rule over
  the three subject IDs and `application_generation` deduplicates Queue
  publication and delivery without preventing a later, newer application.
  Applied receipts are retained when a membership or default is removed because
  the work-stream resource link remains. No resource content is stored here.
- `project_restore_operations` owns resumable restore work. It records the
  project revision, requester, `running`, `failed`, `applied`, or `cancelled`
  state, and each member work stream's audience and resource readiness. A
  restore changes `archived` to `restoring` only after its full safety preflight
  and changes it to `active` only after all targets acknowledge readiness. A
  cancelled operation leaves the project archived and its unfinished targets
  superseded.

The actual resource relationship stays in the owning `SubstreamAgent`'s
`workstream_resource_links`, and the resource metadata stays in `WorkspaceDO`.
Applying a default uses an idempotent typed effect and receipt rather than a
cross-object SQL write. A `WorkspaceDO` alarm drains pending application IDs to
the regional `PROJECT_RESOURCE_QUEUE` binding and marks them queued after
Cloudflare accepts the send. A crash between those two steps may publish the
same ID again, which is safe by contract. After publication, Cloudflare Queue
owns retry and dead-lettering; the alarm does not imitate Queue delivery with a
parallel RPC retry path.

The same alarm drains pending audience-target IDs to
`PROJECT_AUDIENCE_QUEUE`. It marks a target queued only after Cloudflare accepts
the send, and a crash may safely publish the stable target ID again. A failed
target can be returned to pending by an authorized retry without changing the
operation ID or replaying already applied siblings.

The Queue consumer validates the message region, claims and reloads the named
application from `WorkspaceDO`, then uses the same-region typed RPC to ask the
owning `SubstreamAgent` to insert the canonical resource link. It settles the
WorkspaceDO receipt only after the target reports applied or already present.
Messages carry pointers and generations, not project names, resource metadata,
resource bytes, or other user content.

Starting a project work stream uses this same Queue path and waits for all
current-default receipts before dispatching the first run; it does not bypass
the Queue with a direct resource RPC. Project admission uses version-fenced
typed effects. Later multi-work-stream participant and scope changes publish
target IDs through `PROJECT_AUDIENCE_QUEUE` and settle durable receipts in
`WorkspaceDO`; they do not synchronously fan out from a desktop request or
pretend partial completion is success. The project space reads audience and
resource receipts from `WorkspaceDO` to show bulk progress and retryable
failures.

V1 add, move, and restore commands query memberships belonging to `active` or
`restoring` projects in the same `WorkspaceDO` transaction and reject a second
reserved assignment for the work stream. The desktop may preflight that
conflict for a faster explanation, but the server guard is authoritative. The
join table remains many-to-many because archived memberships are retained and
future product versions may permit more than one active row.

Before returning the active project list, `WorkspaceDO` appends any newly
visible active project missing from that person's `workspace_project_order`. A
reorder rewrites the visible IDs as one dense run in a transaction. An inactive
or no-longer-readable project is omitted and its stale order row is removed; if
it becomes active or access returns later, the project is appended as newly
visible. This keeps ordering fixed across devices without making another
user's preference shared state.

Expanded project rows join `project_workstreams` to
`workspace_workstream_directory` locally and order by
`last_activity_at DESC, workstream_id`. The workspace directory response also
carries each readable work stream's project summaries—`projectId`, name,
`iconKey`, and `iconColorKey`—ordered by the current viewer's project
positions, so **Needs attention** can render its icon pile without one request
per row. Only active projects appear in this summary. Project order, lifecycle,
name, icon, membership, and work-stream activity changes publish the
corresponding typed workspace query invalidations.

`workspace_workstream_directory.last_activity_at` remains maintained by the
existing work-stream regional-effect path described in
[Work-stream Durable Object](../../workstream-durable-object.md); Projects do
not introduce a second activity clock.

No existing work stream is backfilled into a project. The initial migration
creates empty project tables.

## Regional impact

Projects live entirely in the workspace's existing region and Durable Object
placement. Project names, icons, colors, participants, resource relationships,
and ordering do not cross between Global and EU. Both regions ship the same
schema and behavior. The Global identity registry gains no project data and
there is no cross-region project lookup.

Default-resource delivery is split by region because each Queue consumer must
bind and call only that region's `WorkspaceDO`, `WorkstreamDO`, and
`SubstreamAgent` namespaces. Global and EU use the same logical
`PROJECT_RESOURCE_QUEUE` producer binding in code, backed by separate
region-named Queue and dead-letter resources in deployment. Both regional
Wrangler configurations declare their producer, primary consumer, DLQ failure
consumer, and dead-letter resource, and deployment preflight rejects an
unpaired or multiply consumed Queue. The region is still present in every
message and is validated by the consumer. A failed EU delivery retries or
dead-letters in EU; it never falls back to Global, and the reverse is also true.

All multi-work-stream audience fan-out follows the same regional rule through
the logical `PROJECT_AUDIENCE_QUEUE` binding and separate region-named
dead-letter resources. Participant additions, participant removals, and scope
widening share its idempotent target-and-receipt path. Its consumer may call
only the same region's `WorkspaceDO` and `WorkstreamDO`; no project audience or
target crosses regions. The regional dead-letter consumer marks an exhausted
still-current target `failed` before acknowledging it so an authorized reader
can retry the operation without repeating applied targets.

## Security and trust model

Every project list, project space, work-stream submenu, drag target, resource
application, participant change, archive, and restore reuses the same personal
or workspace reader rule. Resource attachment enforces the audience-containment
rule before it writes. Stale or unavailable authorization fails closed.

Resource bytes remain in their existing regional R2 objects. Project rows
contain IDs and configuration, not copies of resource content or transcript
content.

Project-resource Queue messages contain only the region, application ID,
workspace ID, and expected generations needed to claim the authoritative work
from `WorkspaceDO`. The consumer derives project, resource, and work-stream
details from current regional authority and repeats authorization immediately
before the typed resource-link effect. Queue contents are not accepted as
authorization or as resource metadata.

Project-audience Queue messages follow the same pointer-not-authority rule.
They contain a region, workspace ID, and audience-target ID; the operation kind
and current participant, scope, membership, and work-stream generations are
reloaded from `WorkspaceDO` before the consumer asks `WorkstreamDO` to apply
the named audience effect.

## Acceptance

1. A person can create and edit a personal or workspace project with a unique
   name, exactly one of the 25 icons, and exactly one of the 12 named project
   colors. The colors appear as a swatch grid whose names are visually shown
   only in hover or focus tooltips and remain available to assistive technology.
   Custom colors are rejected. Archived projects reserve their names; conflicts
   do not disclose an archived project to somebody who cannot read it.
2. Projects render immediately below **Actions** and above **Pinned** in the
   current person's fixed server-owned order. Dragging a project between project
   rows persists that order across devices without changing another person's
   list. Newly visible projects append to the end.
3. Starting a work stream from a project applies every current default resource
   through the regional Cloudflare Queue and receives every application receipt
   before the first agent turn begins. A personal project seats all project
   participants; a workspace project creates a workspace-scoped work stream.
4. Dragging an existing work stream onto a project and choosing **Add to
   project** from its right-click submenu produce the same durable result,
   enlarge its audience as required, and recover cleanly from a failed write.
5. Adding a project default records one durable application for every current
   member and delivers those applications through the regional Cloudflare
   Queue. At-least-once or out-of-order delivery cannot duplicate or overwrite
   an existing resource link. Messages are acknowledged or retried
   independently, and exhausted work reaches a regional dead-letter queue whose
   failure consumer durably changes the matching application to `failed` before
   acknowledging it. Closing the desktop does not stop the fan-out. Future
   members and project restoration use the same application path; restoration
   creates a fresh generation even when an older receipt was applied.
6. Removing a work stream or a default resource leaves every resource already
   attached to a work stream in place. Removing a work stream also leaves its
   participants and scope unchanged.
7. Personal/workspace authorization and audience containment hold for project
   spaces, sidebar rows, work-stream membership, and resources. Every direct
   participant or scope mutation for a member work stream passes through the
   authoritative `WorkspaceDO` membership guard before `WorkstreamDO` changes
   the audience. Any project participant may remove themself; only a workspace
   owner or admin may remove somebody else from a project and its work streams.
8. A work stream can remain pinned while it is in a project. Neither action
   changes the other.
9. V1 moves a work stream between projects, while storage and internal
   contracts accept several `(project_id, workstream_id)` rows and render them
   deterministically. Both the UI and authoritative `WorkspaceDO` commands
   enforce at most one active membership; the table intentionally does not.
10. Loading, empty, stale, error, retry, and offline states are visible and do
    not silently discard known membership or acknowledge an uncommitted change.
11. Keyboard and screen-reader users can create a project, choose all 25 icons,
    expand a project, open a nested work stream, reorder projects, and use the
    same add, move, and remove actions available through drag and drop. They can
    also open a project space, start a project work stream from its plus button,
    archive a project, find a readable archived or restoring project through
    **Restore archived project** in the **New project** dialog, and restore,
    retry, or cancel it. Inactive projects do not return to the Projects sidebar
    section or its menus until restoration completes.
12. A Needs attention row with projects shows their colored icon pile directly
    left of the work-stream name, exposes the project names once to assistive
    technology, preserves the existing status marker, and reserves no gap when
    there is no project.
13. Work streams inside each expanded project are ordered by
    `lastActivityAt DESC, workstreamId`; their realtime activity can reorder
    them without moving the project header.
14. Archiving a project removes it from active navigation and assignment, stops
    future default propagation, and preserves its memberships and all state
    already applied to its work streams. Restoring checks audience
    compatibility, keeps the project inactive until every work stream is ready,
    reapplies current defaults through fresh Queue application generations with
    deduplication, and appends the project to each authorized person's active
    order. A restore refuses to activate a second V1 project assignment with a
    stable `project_conflict` result and identifies the currently active project
    membership the person must remove or keep instead. A project in
    `restoring` reserves every retained work stream against concurrent add,
    move, or restore commands until activation succeeds or restoration is
    cancelled back to archived. A failed restoration remains discoverable and
    offers retry and cancel without undoing already-applied audience or
    resource effects.
15. Every active sidebar project row renders, in order, a stateful Tabler
    `IconTriangle` accordion control, project icon, project name, flexible empty
    space, and a Tabler `IconPlus` control. The middle link opens the project
    space, the triangle changes only accordion state, and the plus opens only
    **New project work stream**.
16. **New project work stream** preserves the ordinary creation controls and
    behavior, shows its fixed project, and omits both **Needs attention** and
    **Suggested work**.
17. The project space presents an activity-ordered work-stream table styled
    like **Needs attention**, a default-resource list with an **Add resource**
    control.
18. Creating, joining, leaving, archiving, or restoring a project does not
    change a work stream's system prompt, compaction behavior, or available
    memory scopes.
19. Removing a personal-project participant immediately ends their project
    read access, durably removes them from every current member work stream
    through the regional project-audience Queue, and remains resumable in
    `removing` state until every work-stream authority acknowledges the change.
    A direct one-work-stream removal cannot bypass this operation or leave the
    project audience inconsistent, and the operation preserves the existing
    self-or-workspace-owner/admin removal rule.
20. Adding a personal-project participant and widening a project to workspace
    scope each create one durable audience target per current work stream and
    converge through the regional project-audience Queue. Project access or
    workspace scope becomes active only after all retained targets acknowledge
    the enlarged audience; failed targets remain visible and retryable without
    replaying successful effects. Default-resource mutations cannot interleave
    with this convergence, and participant addition or scope widening cannot
    start while a default-resource application is unfinished. Participant
    removal remains immediate and replaces any resource applications that its
    audience change superseded.
