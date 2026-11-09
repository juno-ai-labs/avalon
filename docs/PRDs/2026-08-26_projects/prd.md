# Projects

> Created 2026-08-26.
>
> Add projects as an optional way to group related work streams, give them
> shared resources, and find them in the sidebar.
> Companions: [state](state.md), [build plan](plan.md). Subsystem references:
> [data model](../../data-model.md),
> [Queue versus RPC](../../choosing-queues-or-rpc.md),
> [work-stream creation](../../workstream-creation.md),
> [work-stream email addresses](../../workstream-email-addresses.md),
> [work-stream pinning](../../pinning.md). Standing contract:
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

Opening a project through the middle link also expands its accordion. Both plus
controls use the same compact, transparent header-action treatment as the
sidebar ellipsis controls, have no painted hover container, and occupy the same
right-hand grid column so their centers line up.

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
- **Color:** one solid icon color chosen from the fixed project palette below.
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
Every icon option is an outline drawn in the currently selected color, so a
color change previews all 25 choices immediately.

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
streams. Later edits are made directly from the project-space header rather
than through one general settings dialog.

Name, icon, and color are presentation only. Editing them does not change the
project's audience, lifecycle, per-membership, or per-default generations or
invalidate an in-flight audience, resource, membership, start, archive, or
restore operation. Each operation fences only the configuration generations it
actually depends on.

When the person may read at least one archiving, archived, restoring, or
restore-cancelling project, the **New project** dialog footer also offers
**Restore archived project**. It opens a keyboard-searchable recovery picker of
readable inactive projects, ordered by most recent lifecycle activity and
labelled by state.
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
  **Add resource** control aligned at the other side of the section header.
  **Add resource** opens a participant-picker-style modal with selectable
  resource rows rather than an inline dropdown. Each current item uses the
  ordinary Rally resource row and can be removed from the defaults without
  removing it from work streams that already received it.

The project-space header shows the project icon, name, scope, and participants.
Clicking the icon opens the full 25-icon and 12-color grid. Double-clicking the
name edits it inline. The participant face pile opens the same **Add people**
modal pattern used by work streams. Scope is a live Personal/Workspace dropdown;
choosing the other value opens a **Change project access?** confirmation with
**Continue** and **Cancel** before any mutation is sent. There is no general
project Settings button.

A work stream whose project start gate has not released appears in this table
as **Preparing work stream…**, using its persisted opening text and start
operation rather than an active D1 route. A failed setup row offers **Retry**
and **Cancel creation** to an authorized project reader. This row survives
desktop restart and moves into ordinary activity order only after creation
finalization activates the route.

Its menu also provides **Archive project**. Archiving is confirmed because it
removes the project from active navigation and stops new assignments and
default-resource propagation. An archived project space is read-only except for
editing its name, icon, or color, **Restore project**, and removing a retained
work stream from the project. An active participant in an archived personal
project may also **Leave project**, and a workspace owner or admin may remove a
participant, subject to the usual final-reader guard. Adding participants,
changing scope, and changing defaults stay read-only until restoration succeeds.
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
- its defaults stop applying to work streams while it is archiving or archived.

The starting transaction sets `archiving`, prevents unclaimed propagation
targets from being claimed, and supersedes them. **Archiving…** remains visible
in the inactive-project recovery picker while live target leases settle or
expire. The final transaction changes the project to `archived` only after no
project effect can still commit. If no lease is live, start and finalization
happen in the same transaction.

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

The project space shows **Archiving…** until the archive barrier is complete.
Restoration is durable and resumable because it may need to reapply audiences
and default resources across several work streams. It shows **Restoring…**
until every target acknowledges readiness. Closing the desktop does not abandon
either lifecycle operation.

If a restore target fails, the restoring project remains in the recovery picker
with **Retry restore** and **Cancel restore**. Retry requeues only failed
current-generation targets. Cancel first changes the project to
`cancelling_restore`, prevents unclaimed targets from being claimed, and
supersedes those targets. A target with a live WorkspaceDO-issued lease remains
reserved while **Cancelling restore…** is shown. Its effect either settles under
that lease or the lease expires and alarm reconciliation settles its receipt;
only then may cancellation supersede it. The final cancellation transaction
returns the project to `archived` and releases its work-stream reservations
only after no target has a live lease. It does not undo audience expansion or
resource links applied before cancellation completed, but no restore effect can
commit after completion.

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

Creation persists this wait rather than leaving it in the desktop request. The
initial `SubstreamAgent` transaction stores the opening turn, scheduled run, and
a stable start gate in `awaiting_project_setup`; it does not dispatch the
Workflow. `WorkspaceDO` owns a matching project-work-stream start operation and
its audience and resource prerequisites. The transaction that settles the last
required receipt changes that operation to `ready_to_dispatch` and records a
durable finalization intent for its alarm.

While this start operation is nonterminal, `WorkspaceDO` refuses participant
additions, scope, default-resource, archive, and remove-this-membership commands
that would change its captured prerequisites, returning `project_busy`, except
that an access-revoking participant removal preempts setup as described below.
Presentation edits and independent work-stream additions remain available. This
freezes exactly the setup being gated without turning the whole project into a
global lock.

Finalization releases the named `SubstreamAgent` start gate through an
idempotent typed effect. In the same target transaction, `SubstreamAgent`
changes the gate to released and records the normal durable Workflow-dispatch
intent. The finalizer waits for the existing Workflow start round trip, drains
and verifies the directory facts, activates the minimal D1 route and email, and
then settles the WorkspaceDO start receipt. A crash at any point resumes from
the operation, gate, dispatch, and route receipts; a repeated release cannot
start a second run. The HTTP request may wait for this completion when it stays
connected, but request or desktop lifetime is not the durability boundary.

If setup cannot complete, the opening message and scheduled run remain behind
the gate for an authorized retry, and Rally says that the work stream could not
be started in the project. It does not silently start an unconfigured first
turn. A project with no audience or default-resource work to fan out reaches
`ready_to_dispatch` in the creating transaction and follows the existing
synchronous creation path.

**Cancel creation** is available while the gate is unreleased and no finalizer
holds a live dispatch claim. It changes the start operation to `cancelling`,
blocks new setup claims, and supersedes unclaimed application targets. A target
with a live claim is allowed to settle or expire under the same lease and alarm
reconciliation contract; cancellation does not release the draft or its fence
while a late effect could still commit. It then durably asks each authority to
abandon only this never-activated draft: `SubstreamAgent` marks the gate and
scheduled run cancelled, `WorkspaceDO` removes the draft membership, and the
creation finalizer removes the never-active regional owner and verified D1 route.
The Global email-address claim is a permanent tombstone and is never released or
recycled; stale mail to it cannot find an active regional owner. Applied resource
links disappear with the unactivated draft; this is draft cleanup, not removing
an active work stream from a project. The operation becomes `cancelled` and
releases the project configuration fence only after no setup lease is live and
every supported cleanup receipt is durable. If final dispatch won the claim
first, cancellation returns `project_busy`; creation finishes and the person can
then use the ordinary active-work-stream actions.

### Adding an existing work stream

A person who can read both the project and the work stream can add it in either
of two ways:

- drag the work-stream row onto an expanded or collapsed project row; or
- right-click the work stream, choose **Add to project**, then choose a project
  from a submenu that shows each project's icon, color, and name. This uses the
  shared nested-menu pattern: the submenu opens directly to the right, anchors
  vertically to the parent row, and puts a trailing checkmark on the current
  project.

Before committing an audience change, Rally says what will happen: either
**Everyone in this workspace will be able to open this work stream** or
**These project participants will be added to this work stream**, followed by
the names being added. Drag and menu entry use the same confirmation. If the
project adds nobody and does not change scope, no extra confirmation is needed.

In V1, a work stream has at most one visible project assignment. Adding an
unassigned work stream starts an admission. Choosing a different project for an
assigned work stream starts a move admission. In one `WorkspaceDO` transaction,
Rally validates both projects, reserves the work stream against another
membership command, records a durable membership operation, and creates a
non-visible `joining` row for the destination. A move keeps the old membership
active and visible during setup only while the destination audience remains
compatible with the source project.

The admission captures the destination audience and default generations and
creates durable receipts for its one `WorkstreamDO` audience effect and every
default-resource application. Applying a personal project adds every active
project participant in the local work-stream transaction; applying a workspace
project changes the work stream to `workspace` scope. The destination project
shows **Adding work stream…**. Normal sidebar and Needs attention reads continue
to show only the old active project while doing so remains audience-safe.
Participant additions,
scope, default-resource, archive, and conflicting membership commands that
would change the captured admission return `project_busy` until it is terminal,
except that an access-revoking participant removal preempts the admission.

Before claiming a destination audience effect that would make the work stream
incompatible with its source project, `WorkspaceDO` first runs the source
membership's late-effect barrier and detaches that membership. Only then may
the wider audience commit in `WorkstreamDO`. The work stream is temporarily
unassigned in ordinary navigation, while the destination project continues to
show **Adding work stream…**. The move confirmation warns that cancelling after
this point will not restore the source assignment. This applies, for example,
when moving from a personal project into a workspace project or into a personal
project with additional participants.

After every audience and resource receipt is satisfied, one `WorkspaceDO`
transaction changes the destination row from `joining` to `active` and removes
any still-compatible old active membership. Except for the safe early
detachment above, that final swap is the only point at which the visible
assignment changes. If setup fails, **Retry add/move** resumes only
unfinished targets. **Cancel add/move** prevents new claims, waits for live
leases to settle or expire, removes the `joining` row, and releases the
reservation. A compatible old assignment remains. An early-detached source is
not restored, so that cancellation leaves the work stream unassigned. Any
audience expansion or resource link already applied is kept and named in the
cancellation message; Rally does not pretend those monotonic effects were
rolled back. An initial add likewise leaves the work stream unassigned with the
same already-applied effects. Closing the desktop does not abandon, complete,
or cancel the admission.

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

A project reader can add a workspace resource to the project's **Default
resources** list only when the resource's current audience contains the whole
project audience. A workspace project therefore requires a workspace-visible
resource. A personal project may use a narrower resource only when every active
project participant can read it. A private note visible only to the selecting
person is refused rather than linked invisibly for everybody else. Adding a
default applies it to:

- every work stream already in the project; and
- every work stream added or created later.

The attachment is a link to the existing workspace resource, not a copy of the
resource or its bytes. Deduplication uses the canonical resource identity. If
that resource is already attached to a work stream, Rally keeps the existing
link and records the project application as satisfied. It does not add a second
row or replace the existing relationship metadata.

The same containment check runs before adding a participant or widening a
project to workspace scope. If an existing default would not be readable by the
enlarged audience, Rally returns `project_resource_audience_mismatch`, names
only defaults the caller may read, and asks them to widen or remove those
resources first. A resource-audience mutation is likewise refused while the
resource is a default for a project whose active audience it would no longer
contain. Queue consumers recheck this condition before every application.

Adding a default resource to a project with existing work streams is performed
through a regional Cloudflare Queue. The `WorkspaceDO` transaction that adds
the default also creates one durable application record for each current work
stream. Its alarm publishes ID-only application pointers to the Queue; the
regional API consumer atomically claims each application from `WorkspaceDO`
with an authority-issued lease, attaches the resource through the owning work
stream's typed RPC, and then settles the application receipt in `WorkspaceDO`.
The target effect carries the application ID, generation, and lease expiry. It
rejects an expired claim and stores its idempotent effect receipt in the same
local transaction as the resource link.

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
The failure consumer claims the named publication from `WorkspaceDO` and marks
that publication exhausted. It changes the application to `failed` only when
every publication for the current delivery attempt is exhausted or past its
configured terminal time and no application lease is live. Another duplicate
or ambiguity-recovery publication can therefore remain deliverable. The
consumer acknowledges the dead-letter message only after `WorkspaceDO` reports
the publication exhausted or already terminal. If that receipt write is
unavailable, the DLQ message retries. The failure consumer never calls the
work-stream resource effect and never retries delivery itself.

`PROJECT_RESOURCE_DLQ` itself dead-letters exhausted failure-consumer messages
to a separate regional `PROJECT_RESOURCE_FAILURE_DLQ`. That terminal Queue has
no automatic consumer: a non-empty backlog is the visible signal that
`WorkspaceDO` could not record failure, and it retains the pointer for
best-effort operational replay within Cloudflare's retention window. It is not
the durable recovery mechanism: the authoritative application row and alarm
reconciliation below can rediscover the work after any Queue copy expires.
Replay into the failure consumer remains idempotent. The implementation leaves
the failure-consumer retry count and lease durations open for the team to set
rather than guessing defensive limits in this PRD.

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

Both removals use the same late-effect barrier as cancellation. The first
transaction marks the default `removing` or membership `leaving`, stops new
claims, and supersedes unclaimed targets. Rally shows **Removing default…** or
**Removing from project…** while live claims settle or expire. The final
transaction removes the configuration row only after no related effect can
still commit. An effect that settles before removal completes is kept under the
rules above; none can appear after Rally reports removal complete.

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

A failed addition also offers **Cancel participant addition**. Cancellation
changes the audience operation to `cancelling`, prevents unclaimed targets from
being claimed, and waits for every live target lease to settle or expire. Every
member work stream where the participant addition did apply is then removed
from the project through the membership late-effect barrier. The participant
and resources already added to that work stream stay there. Only after those
memberships are detached does the final transaction change the never-active
`adding` participant to `removed`, mark the operation `cancelled`, and release
the project fence. The cancellation confirmation names the work streams that
will leave the project. This preserves personal-project audience containment
without pretending the audience expansion was rolled back.

Removing a participant from a personal project starts with the same
authorization and final-reader checks whether or not the project has work
streams. The caller may remove themself; removing somebody else fails with
`participant_removal_denied` unless the caller is a workspace owner or admin.
After that authorization, the same `WorkspaceDO` transaction verifies that at
least one other participant is already `active`. An `adding` participant does
not count. Removing the final active reader fails with
`project_participant_required` and tells the caller to add another participant,
make the project workspace-scoped, or archive it instead. `WorkspaceDO` then
changes the selected project participant from `active` to `removing`. A removing
participant immediately stops being a project reader, cannot receive new
project propagation, and disappears from the active participant list. The
same transaction pauses nonterminal project starts and destination admissions,
prevents their unclaimed setup targets from being claimed, and includes their
`joining` or gated draft work streams in the removal target set. Live setup
claims settle or expire before the removal effect runs on that work stream.
After every removal receipt, `WorkspaceDO` rebases each paused operation onto
the new project-audience generation, creates fresh resource applications for
old-audience attempts that became superseded, and resumes it. Access revocation
therefore changes setup prerequisites; it never waits for unrelated resource
delivery to finish. The project completes this transition to `removed` in the
same transaction when it has no work streams. Otherwise it is one durable
operation, not a sequence the
person must perform by hand, and removes that person from every member work
stream using ID-only messages on the regional `PROJECT_AUDIENCE_QUEUE`. Its
consumer claims each removal target from `WorkspaceDO`, applies a version-fenced
typed effect to the owning `WorkstreamDO`, and records the receipt before acknowledging the
message; the work-stream removal uses the existing access-revocation path. It
marks the project participant `removed` only after every target acknowledges
the removal. Partial failure leaves the safe `removing` state in place, names
the failed work stream to remaining authorized readers, and retries through the
Queue; closing the desktop does not abandon it. During convergence, the person
may still open a not-yet-updated work stream directly but cannot use the project
to discover or open other members. Its region-specific dead-letter consumer
marks an exhausted target `failed` and lets an authorized reader retry it; it
does not restore project access.

Leaving or removing a participant from an archived personal project uses the
same authorization and final-reader checks but completes in one `WorkspaceDO`
transaction. Because retained archived memberships no longer constrain their
work-stream audiences, this explicit inactive-project change removes only the
project participant. It does not remove that person from former member work
streams. A later restore preflight reports those audience conflicts normally.

Every direct participant or scope mutation for a project member work stream is
submitted through `WorkspaceDO` as a durable member-audience mutation. In one
transaction, `WorkspaceDO` validates only memberships that currently constrain
the work-stream audience: an active membership in an active project, a
destination `joining` membership, or a retained membership reserved by a
`restoring` or `cancelling_restore` operation. A merely retained membership in
an archiving or archived project is excluded, so it cannot prevent the former
member work stream from changing audience while the project is inactive. Restore
preflight detects any resulting incompatibility. The transaction records the
intended mutation and expected membership generations, and reserves that work
stream against add, move, restore, and project-audience commands. The
owning `WorkstreamDO` then applies the typed effect only when its local audience
generation matches, and stores an idempotent receipt under the mutation ID in
the same local transaction. `WorkspaceDO` releases the reservation only after
it settles that receipt. Its alarm resumes the same operation after a crash, so
the reservation fences the effect across the cross-object `await` rather than
protecting only the earlier check.

The validation refuses removing an active project participant directly from
one member work stream; the caller removes them from the project so the durable
operation updates every member. It also refuses a scope change that would make
a personal-project work stream workspace-scoped or a workspace-project work
stream personal. The person must first remove the work stream from the project
or make the project scope compatible. A concurrent membership or audience
command sees the reservation and returns `project_busy`; it cannot commit
between guard approval and the `WorkstreamDO` effect.

Changing a personal project to workspace scope uses the same durable audience
operation. The project remains personal and records a pending `workspace`
scope while `PROJECT_AUDIENCE_QUEUE` widens every current member work stream.
The project space shows **Making workspace-visible…** until all target receipts
are applied, then one `WorkspaceDO` transaction changes the project scope to
`workspace`. A partial operation is safe: a work stream may become
workspace-scoped before the others, but the still-personal project never
advertises access that a member work stream lacks. Failed targets remain
retryable and successful targets are not replayed. A workspace project can
change back to personal only when it contains no work streams. The caller must
already be an active participant; otherwise the confirmation says that Rally
will make them a participant, and the scope transaction seats them before
narrowing. The command can therefore never create a personal project with no
reader or make its work streams private as a side effect. Widening an empty
project completes in the creating transaction.

A failed widening also offers **Cancel scope change**. It uses the same
`cancelling` state and live-lease barrier: unclaimed targets stop, live claims
settle or expire. Every work stream that did become workspace-scoped is then
removed from the personal project through the membership late-effect barrier;
its wider scope and inherited resources remain. Only after those memberships
are detached does the final transaction clear the pending workspace scope,
leave the project personal, mark the operation `cancelled`, and release the
project fence. The confirmation names the work streams that will leave. This
keeps the remaining personal-project membership contained without attempting
to narrow an already-widened work stream.

While one of these audience operations is unfinished, `WorkspaceDO` refuses a
second participant addition or project-scope change and any add, move,
new-work-stream, default-resource, or archive command for that project with a
retryable `project_busy` result. Participant removal preempts and rebases those operations
under the revocation rule above. A `participant_add` or `scope_widen` operation cannot
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
participants does not change. Project-start creation adds a durable setup gate
before the opening Workflow dispatch; it does not change the work stream as the
unit of the run, and ordinary non-project creation keeps its current path.

## Decision log

None yet.

## Key design decisions

1. **Projects live in `WorkspaceDO`.** They organize several work streams and
   use workspace resources, so they are workspace product state rather than
   state owned by one `WorkstreamDO`. Putting them in regional D1 would restore
   a product-state authority that Rally has retired.
2. **Membership is many-to-many even though V1 is not.** A join table without a
   unique `workstream_id` keeps the future capability cheap. V1 uses a
   staged move with one visible active row so the current interface stays
   simple without pretending cross-object setup is atomic.
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
   over RPC. Physical publications have their own durable IDs, so an exhausted
   ambiguous copy cannot fail another copy that Cloudflare can still deliver.
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
   A direct one-work-stream mutation holds a durable `WorkspaceDO` reservation
   until that authority settles its idempotent effect, because a check that
   ends before the cross-object `await` would not fence the later commit.
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
11. **Project reads come down the workspace socket; project changes go up over
    REST.** The subscribe response includes the current viewer's active and
    inactive projects. Every committed mutation sends a new viewer-shaped
    snapshot to every subscribed workspace socket, including sockets belonging
    to somebody whose project access was just removed. A socket event carries
    project state, not an invalidation that triggers a GET. The REST response
    may support read-your-write for its caller, but the socket snapshot is what
    converges every window and reconnect.

## Data model

All project tables are native `WorkspaceDO` SQLite tables. The object's
singleton already owns the workspace identity, so these tables do not repeat a
meaningless local `workspace_id` column.

- `projects` owns `project_id`, `name`, `normalized_name`, `icon_key`,
  `icon_color_key`, `scope`, `status` (`active`, `archiving`, `archived`,
  `restoring`, or `cancelling_restore`), optional `archived_at` and
  `archived_by_user_id`, `created_by_user_id`,
  `created_at`, `updated_at`, a monotonic `presentation_revision`, and a
  monotonic `audience_generation` and `lifecycle_generation`. Name, icon, and
  color edits advance only presentation revision. Scope and participant changes
  advance the audience generation. Archive, restore, and cancellation lifecycle
  transitions advance the lifecycle generation. Membership and default rows
  own their narrower generations; changing one membership never invalidates an
  operation for a different work stream. Duplicate normalized names are
  allowed: project identity and navigation use `project_id`, and rejecting a
  duplicate would leak the names of personal projects the caller cannot read.
  `icon_key` is restricted to the 25 V1 keys; `icon_color_key` is restricted to
  the 12 V1 project-color keys.
- `project_participants` owns `adding`, `active`, `removing`, and `removed`
  participant history and the participant generation used by authorization.
  Only `active` rows authorize project reads. Its shape otherwise follows
  work-stream participants even though it lives in a different authority. A
  personal-project removal command atomically refuses the transition from one
  active participant to zero; pending additions do not satisfy that invariant.
- `project_audience_operations` owns one durable root for a `participant_add`,
  `participant_remove`, or `scope_widen`. It stores the operation and project
  IDs, actor, expected project lifecycle and audience generations, optional
  participant and pending scope, and `pending`, `running`, `failed`,
  `cancelling`, `applied`, or `cancelled` state. Cancelling an addition removes
  the never-active participant after live claims finish and detaches every
  membership whose participant target applied; cancelling a widening detaches
  every membership whose scope target applied before clearing pending scope.
  Neither path reverses audience or resources already applied to a work stream.
- `project_audience_targets` owns one receipt per operation and member work
  stream. It stores the operation, project, participant when applicable, and
  work-stream IDs; expected membership and audience generations; and
  `pending`, `queued`, `applying`, `reconciling`, `applied`, `superseded`, or
  `failed` state. A queued row owns its delivery attempt and references its
  publication rows; an applying row owns its authority-issued claim lease. A
  participant addition or pending scope does not become active, and a removal
  does not become final, until every target is applied or superseded by removing
  that membership.
- `project_member_audience_mutations` owns the durable reservation for one
  direct work-stream participant or scope command. It stores the mutation,
  work-stream, actor, intended effect, expected project-membership and local
  audience generations, and `pending`, `applying`, `applied`, or `failed`
  state. One nonterminal reservation per work stream blocks a project mutation
  from invalidating the guard before `WorkstreamDO` records its effect receipt.
- `project_workstreams` owns `project_id`, `workstream_id`, who added it, when
  it was added, a monotonic `membership_generation`, the admitted project and
  work-stream audience generations, and the `joining`, `active`, or `leaving`
  admission state. Per-resource receipt state
  lives in `project_resource_applications`; the project space reads both sources
  for bulk progress. Its primary key is `(project_id, workstream_id)`. There is
  deliberately no uniqueness constraint on `workstream_id`.
- `project_membership_operations` owns a staged add, move, or removal. It stores
  the operation, work-stream, optional source and destination project IDs;
  expected destination lifecycle and audience generations, that membership's
  generation, each captured default row's generation, and whether an
  audience-incompatible source was durably detached before destination setup;
  `configuring`, `ready`, `cancelling`, `applied`, `failed`, or `cancelled`
  state; its audience target; and the resource-application set. One nonterminal
  operation reserves the work stream. The destination becomes active and the
  compatible old membership is removed only in the final transaction after
  every target receipt or removal barrier is satisfied; an incompatible source
  is removed through its earlier barrier before destination audience expansion.
- `project_workstream_starts` owns the resumable gate for a work stream created
  from a project. It stores a stable start-operation ID; project, work-stream,
  substream, run, and target-gate IDs; the project lifecycle and audience
  generations, draft membership generation, and each captured default row and
  application generation; `configuring`,
  `ready_to_dispatch`, `dispatching`, `active`, `failed`, `cancelling`, or
  `cancelled` state; and the finalization attempt and receipt. The last
  prerequisite receipt and transition to `ready_to_dispatch` commit together.
- `workspace_project_order` owns one person's project order. It is keyed by
  `(user_id, project_id)` and stores a dense ascending `position`, following the
  same server-authoritative pattern as `workspace_workstream_pins`. It is a
  viewer preference, not shared project state, and is never broadcast to other
  users.
- `project_default_resources` owns one `active` or `removing` row per
  `(project_id, resource_id)` plus a monotonic `default_generation`, attribution,
  and attachment time.
- `project_resource_applications` is both the durable enqueue intent and the
  idempotent receipt for one generated application. It owns a stable
  `application_id`; one monotonic `application_generation` sequence per
  `(project_id, resource_id, workstream_id)` tuple, starting at 1 for that
  tuple's first application; the three subject IDs; the expected project
  lifecycle and audience generations, that work stream's membership generation,
  and that default row's generation; `pending`, `queued`, `applying`,
  `reconciling`, `applied`,
  `superseded`, or `failed` state; and the delivery attempt or authority-issued
  claim lease used by that state. A uniqueness rule over the three subject IDs and
  `application_generation` deduplicates Queue publication and delivery without
  preventing a later, newer application. Applied receipts are retained when a
  membership or default is removed because the work-stream resource link
  remains. No resource content is stored here.
- `project_queue_publications` owns every physical publication attempt for a
  resource application or audience target. It stores a stable publication ID;
  target kind, ID, generation, and delivery attempt; publisher lease and expiry;
  send start, a conservative `latest_acceptance_at`, optional confirmed
  `accepted_at`, and `delivery_terminal_at`; and `publishing`, `accepted`,
  `exhausted`, or `superseded` state. Confirmed acceptance sets terminal time to
  `accepted_at` plus the configured primary Queue retention. An ambiguous send
  uses `latest_acceptance_at` plus retention. Publisher-lease expiry alone never
  proves delivery terminal. A target fails only after all of its current
  publication rows prove terminal and no effect claim is live.
- `project_restore_operations` owns resumable restore work. It records the
  project lifecycle and audience generations, requester, `running`, `failed`,
  `cancelling`, `applied`, or `cancelled` state, and each member work stream's
  captured membership generation, audience readiness, and per-default
  generations and resource readiness. A restore changes `archived` to
  `restoring` only after its full safety preflight and changes it to `active`
  only after all targets acknowledge readiness. Cancellation holds
  `cancelling_restore` and the
  work-stream reservations until every live claim settles or expires; only then
  does a cancelled operation leave the project archived.

The actual resource relationship stays in the owning `SubstreamAgent`'s
`workstream_resource_links`, and the resource metadata stays in `WorkspaceDO`.
`SubstreamAgent` also stores the idempotent project-resource effect receipt;
`WorkstreamDO` stores receipts for project-audience targets and direct
member-audience mutations. These local receipts contain operation identity and
generation, not a second copy of project authority.
`SubstreamAgent` also owns the start gate beside the scheduled run and the
idempotent release-to-Workflow-dispatch receipt. The D1 route stays `verified`
and email stays inactive until the existing creation finalizer has both that
receipt and the directory-publication fence.
Applying a default uses an idempotent typed effect and receipt rather than a
cross-object SQL write. A `WorkspaceDO` alarm drains pending application IDs to
the regional `PROJECT_RESOURCE_QUEUE` binding. Before leaving the object, it
atomically claims the target under a publisher lease, creates a durable
publication row and ID, and moves the target to queued. Before invoking the
Queue binding, it records the send start and a conservative
`latest_acceptance_at` derived from the platform-enforced latest time that this
invocation's in-flight send can still be accepted. That bound is deliberately
separate from the authority publisher lease and is chosen from Cloudflare's
published execution limit rather than guessed here. The Queue message includes
both publication and target IDs. After Cloudflare accepts the send, the alarm
records `accepted_at` and sets `delivery_terminal_at` to that timestamp plus the
regional primary Queue's configured retention. If the outcome remains
ambiguous, terminal time is the conservative latest-acceptance bound plus the
same retention.

A crash before or after the send leaves the publication row authoritative.
After its publisher lease expires, the alarm may create a new publication ID
for the same delivery attempt; it never erases the ambiguous earlier one. Both
copies therefore remain independently visible to failure settlement. This is
outbox ambiguity recovery, not a second application-delivery loop: after an
accepted publication, Cloudflare owns its retry and dead-lettering.

The same alarm drains pending audience-target IDs to
`PROJECT_AUDIENCE_QUEUE` through the same publication rows and publisher leases.
A failed target can be returned to pending by an authorized retry without
changing the operation ID or replaying already applied siblings.

The alarm also reconciles authoritative resource applications and audience
targets after proof that their delivery or effect can no longer be live. For a
queued row it waits until every publication for the current delivery attempt is
marked exhausted or has passed its own `delivery_terminal_at`; a live duplicate,
backlog, or ordinary retry keeps the target queued. For an applying row it waits
for the authority-issued claim lease to expire. It atomically changes the
still-current attempt to `reconciling` before any external call. A queued row
whose publications all prove terminal becomes `failed`. For an expired applying
claim, the alarm asks the owning `SubstreamAgent` or `WorkstreamDO` for the
idempotent effect receipt: a receipt settles the row as applied, while no
receipt settles it as failed. The target authority rejects a late effect after
its WorkspaceDO-issued lease expires, so it cannot commit after reconciliation
observed no receipt.

This path starts from SQLite state, not a Queue message, and therefore still
works after terminal-DLQ retention expires. It never republishes the same
target delivery after all of its publications are terminal. An authorized retry
atomically supersedes the old delivery attempt and its publication rows, then
publishes a new attempt that old pointers cannot claim; superseded intent
creates the fresh application generation described above. Queue retention and
claim-lease duration are explicit deployment decisions left open for the team
to set, and deployment preflight verifies that the value used by WorkspaceDO
matches the Queue configuration.

The Queue consumer validates the message region, publication, and delivery
attempt, then claims and reloads the named application from `WorkspaceDO`. A
duplicate publication cannot claim an application already applying or terminal.
The consumer uses the same-region typed RPC to ask the owning `SubstreamAgent`
to insert the canonical resource link and effect receipt. It settles the
WorkspaceDO receipt only after the target reports applied or already present.
Audience consumers use the same lease-and-receipt contract with `WorkstreamDO`.
Messages carry pointers and generations, not project names, resource metadata,
resource bytes, or other user content.

Starting a project work stream uses this same Queue path and the durable
`project_workstream_starts` gate before dispatching the first run; it does not
bypass the Queue with a direct resource RPC or depend on the create request
remaining alive. Project admission uses version-fenced typed effects. Later
multi-work-stream participant and scope changes publish target IDs through
`PROJECT_AUDIENCE_QUEUE` and settle durable receipts in `WorkspaceDO`; they do
not synchronously fan out from a desktop request or pretend partial completion
is success. The project space reads audience, resource, and start receipts from
`WorkspaceDO` to show bulk progress and retryable failures.

V1 add, move, and restore commands query memberships belonging to `active` or
`restoring` projects plus nonterminal joining and mutation reservations in the
same `WorkspaceDO` transaction, and reject a second reserved assignment for the
work stream. The desktop may preflight that conflict for a faster explanation,
but the server guard is authoritative. The join table remains many-to-many
because archived memberships are retained and future product versions may
permit more than one active row.

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
name, icon, membership, default-resource, and work-stream membership changes
publish the complete active-and-inactive project snapshot to every subscribed
workspace socket, filtered and ordered for that socket's user. Work-stream
activity continues to arrive through the existing versioned workspace
work-stream state path.

`workspace_workstream_directory.last_activity_at` remains maintained by the
existing work-stream regional-effect path described in
[Work-stream Durable Object](../../workstream-durable-object.md); Projects do
not introduce a second activity clock.

No existing work stream is backfilled into a project. The initial migration
creates empty project tables.

## Regional impact

Projects live entirely in the workspace's existing region and Durable Object
placement. Project names, icons, colors, participants, resource relationships,
and ordering do not cross between configured deployments. Configured deployments ship the same
schema and behavior. The Global identity registry gains no project data and
there is no cross-region project lookup.

All multi-work-stream audience fan-out follows the same regional rule through
the logical `PROJECT_AUDIENCE_QUEUE` binding and separate region-named
dead-letter resources. Participant additions, participant removals, and scope
widening share its idempotent target-and-receipt path. Its consumer may call
only the same region's `WorkspaceDO` and `WorkstreamDO`; no project audience or
target crosses regions. The regional dead-letter consumer marks the named
publication exhausted and fails the target only when no current publication or
effect lease remains live, so an authorized reader can retry without repeating
applied targets. Its own exhausted messages go to a passive regional
`PROJECT_AUDIENCE_FAILURE_DLQ`, with the same visible-backlog and idempotent
operational-replay contract as the resource failure chain.

## Security and trust model

Every project list, project space, work-stream submenu, drag target, resource
application, participant change, archive, and restore reuses the same personal
or workspace reader rule. Resource attachment enforces the audience-containment
rule before it writes. Stale or unavailable authorization fails closed.

Resource bytes remain in their existing regional R2 objects. Project rows
contain IDs and configuration, not copies of resource content or transcript
content.

Project-resource Queue messages contain only the region, publication and
application IDs, delivery attempt, workspace ID, and expected generations
needed to claim the authoritative work from `WorkspaceDO`. The consumer derives
project, resource, and work-stream details from current regional authority and
repeats authorization immediately before the typed resource-link effect. Queue
contents are not accepted as authorization or as resource metadata.

Project-audience Queue messages follow the same pointer-not-authority rule.
They contain a region, workspace ID, publication and audience-target IDs, and
delivery attempt; the operation kind and current participant, scope,
membership, and work-stream generations are reloaded from `WorkspaceDO` before
the consumer asks `WorkstreamDO` to apply the named audience effect.

## Acceptance

1. A person can create and edit a personal or workspace project with a unique
   name, exactly one of the 25 icons, and exactly one of the 12 named project
   colors. The colors appear as a swatch grid whose names are visually shown
   only in hover or focus tooltips and remain available to assistive technology.
   Custom colors are rejected. Archived projects reserve their names; conflicts
   do not disclose an archived project to somebody who cannot read it. A reader
   may open an archived conflict and edit its name, icon, or color without
   restoring it. Presentation edits advance a separate revision and do not
   invalidate lifecycle, audience, membership, default, or application receipts.
2. Projects render immediately below **Actions** and above **Pinned** in the
   current person's fixed server-owned order. Dragging a project between project
   rows persists that order across devices without changing another person's
   list. Newly visible projects append to the end.
3. Starting a work stream from a project applies every current default resource
   through the regional Cloudflare Queue and receives every application receipt
   before the first agent turn begins. A durable WorkspaceDO start operation and
   SubstreamAgent gate release the scheduled run exactly once after the final
   receipt, even when the create request or desktop has gone away. The D1 route
   and email do not activate before the existing Workflow and directory fences.
   A personal project seats all project participants; a workspace project
   creates a workspace-scoped work stream.
4. Dragging an existing work stream onto a project and choosing **Add to
   project** from its right-click submenu create the same durable staged
   admission. The old project remains the only visible assignment until every
   destination audience and resource receipt settles when its audience remains
   compatible. If destination setup must change the audience incompatibly, the
   source membership's late-effect barrier completes and detaches it before that
   effect can commit. Failure offers retry or cancellation; cancellation removes
   the joining membership after live leases finish, does not restore an
   early-detached unsafe source, and explicitly keeps any monotonic audience or
   resource effects that already applied. Participant removal preempts and
   rebases the admission instead of waiting behind its setup fence.
5. Adding a project default records one durable application for every current
   member and delivers those applications through the regional Cloudflare
   Queue. The default's audience must contain the complete current project
   audience; participant additions, scope widening, direct resource-audience
   changes, and each Queue application revalidate that containment. A private
   resource cannot become invisibly unusable to part of the project.
   At-least-once or out-of-order delivery cannot duplicate or overwrite an
   existing resource link. Ambiguous sends create separately identified
   durable publication rows. Messages are acknowledged or retried independently,
   and a dead-letter consumer marks only its publication exhausted; the target
   fails only when every current publication and effect lease proves terminal.
   If that consumer also exhausts retries, a separate passive regional terminal
   DLQ provides a visible, idempotently replayable signal. Independent
   `WorkspaceDO` alarm reconciliation applies the same all-publications-terminal
   or effect-lease-expired proof from authoritative SQLite even after every
   Queue copy expires. It does not fail an ordinary live duplicate or backlog.
   Closing the desktop does not stop the fan-out. Future members and project
   restoration use the same application path; restoration creates a fresh
   generation even when an older receipt was applied.
6. Removing a work stream or a default resource leaves every resource already
   attached to a work stream in place. Removing a work stream also leaves its
   participants and scope unchanged. Each removal stops new claims and waits
   for live effect leases before reporting completion, so no inherited effect
   appears afterward.
7. Personal/workspace authorization and audience containment hold for project
   spaces, sidebar rows, work-stream membership, and resources. Every direct
   participant or scope mutation for a member work stream passes through the
   authoritative `WorkspaceDO` membership guard for active, joining, restoring,
   or restore-cancelling memberships and holds a durable reservation until
   `WorkstreamDO` stores and returns its idempotent effect receipt. A retained
   archiving or archived membership does not constrain direct audience changes;
   restore preflight catches any new mismatch. A project membership command
   cannot commit in the cross-object gap. Any project participant may remove
   themself; only a workspace owner or admin may
   remove somebody else from a project and its work streams.
8. A work stream can remain pinned while it is in a project. Neither action
   changes the other.
9. V1 moves a work stream between projects, while storage and internal
   contracts accept several `(project_id, workstream_id)` rows and render them
   deterministically. Both the UI and authoritative `WorkspaceDO` commands
   enforce at most one visible active membership and reserve nonterminal joining
   rows against a second command; the table intentionally does not impose
   one-project uniqueness.
10. Loading, empty, stale, error, retry, and offline states are visible and do
    not silently discard known membership or acknowledge an uncommitted change.
11. Keyboard and screen-reader users can create a project, choose all 25 icons,
    expand a project, open a nested work stream, reorder projects, and use the
    same add, move, and remove actions available through drag and drop. They can
    retry or cancel a failed staged add or move. They can
    also open a project space, start a project work stream from its plus button,
    archive a project, find a readable archiving, archived, restoring, or
    restore-cancelling project through **Restore archived project** in the **New
    project** dialog, and restore, retry, or cancel it. Inactive projects do not
    return to the Projects sidebar section or its menus until restoration
    completes.
12. A Needs attention row with projects shows their colored icon pile directly
    left of the work-stream name, exposes the project names once to assistive
    technology, preserves the existing status marker, and reserves no gap when
    there is no project.
13. Work streams inside each expanded project are ordered by
    `lastActivityAt DESC, workstreamId`; their realtime activity can reorder
    them without moving the project header.
14. Archiving a project removes it from active navigation and assignment, stops
    new propagation claims, waits for live effect leases, and preserves its
    memberships and all state already applied to its work streams. No project
    effect commits after archiving completes. Restoring checks audience
    compatibility, keeps the project inactive until every work stream is ready,
    reapplies current defaults through fresh Queue application generations with
    deduplication, and appends the project to each authorized person's active
    order. A restore refuses to activate a second V1 project assignment with a
    stable `project_conflict` result and identifies the currently active project
    membership the person must remove or keep instead. A project in
    `restoring` reserves every retained work stream against concurrent add,
    move, or restore commands until activation succeeds or restoration is
    cancelled back to archived. A failed restoration remains discoverable and
    offers retry and cancel without undoing already-applied audience or resource
    effects. Cancellation retains reservations and waits for every live target
    lease to settle or expire before returning to archived, so no restore effect
    commits after cancellation completes. An active participant may leave an
    archived personal project, and a workspace owner or admin may remove one,
    without restoring it; the final-reader guard still applies, former member
    work-stream audiences stay unchanged, and restore preflight reports any
    resulting conflict.
15. Every active sidebar project row renders, in order, a stateful Tabler
    `IconTriangle` accordion control, project icon, project name, flexible empty
    space, and a Tabler `IconPlus` control. The middle link opens the project
    space and expands its accordion, the triangle changes only accordion state,
    and the plus opens only **New project work stream**. Section and row plus
    controls align and use the transparent sidebar-header action style.
16. **New project work stream** preserves the ordinary creation controls and
    behavior, shows its fixed project, and omits both **Needs attention** and
    **Suggested work**.
17. The project space presents an activity-ordered work-stream table styled
    like **Needs attention**, a default-resource list with a right-aligned
    **Add resource** modal selector, direct icon/color and inline-name editors,
    a participant face-pile modal, and a live scope dropdown with a confirmation
    step. A persisted start operation that has not activated its route
    remains discoverable there as **Preparing work stream…** with retry and
    cancellation on failure, including after a desktop restart. Cancellation
    waits for live setup claims, durably abandons the gated run and draft
    regional authorities, retains the permanent Global email-address tombstone,
    then releases the project configuration fence without activating the route.
18. Creating, joining, leaving, archiving, or restoring a project does not
    change a work stream's system prompt, compaction behavior, or available
    memory scopes.
19. Removing an active personal-project participant immediately ends their project
    read access, durably removes them from every current member work stream
    through the regional project-audience Queue, and remains resumable in
    `removing` state until every work-stream authority acknowledges the change.
    A direct one-work-stream removal cannot bypass this operation or leave the
    project audience inconsistent, and the operation preserves the existing
    self-or-workspace-owner/admin removal rule. Removing the final active reader
    is refused until another participant is active or the project becomes
    workspace-scoped. Revocation pauses and rebases nonterminal starts and
    admissions, includes their draft or joining work streams in its targets,
    and is never blocked by their resource delivery.
20. Adding a personal-project participant and widening a project to workspace
    scope each create one durable audience target per current work stream and
    converge through the regional project-audience Queue. Project access or
    workspace scope becomes active only after all retained targets acknowledge
    the enlarged audience; failed targets remain visible and retryable without
    replaying successful effects. Either failed operation can also be cancelled:
    cancellation blocks new claims, waits for live leases, detaches every member
    whose audience was already enlarged, and then removes the never-active
    `adding` participant or clears the pending workspace scope. It keeps audience
    and resource effects already applied to the detached work streams and
    releases `project_busy` only after containment is restored in its terminal
    transaction. Default-resource mutations
    cannot interleave with this convergence, and participant addition or scope
    widening cannot start while a default-resource application is unfinished.
    Participant removal remains immediate and replaces any resource applications
    that its audience change superseded. An exhausted audience failure-consumer message
    is likewise preserved in a passive regional terminal DLQ for visible,
    idempotent operational replay, while authority-owned alarm reconciliation
    remains able to settle the target after the configured primary delivery is
    provably terminal. Live Queue backlog is not failed by an independent
    timeout.
21. Changing an empty workspace project to personal scope requires the caller
    to be an active participant or atomically seats them with confirmation
    before narrowing, so the resulting personal project always has a reader.
22. Project list reads use no REST route. The workspace subscribe payload and
    later `workspace_project_snapshot` frames carry active and inactive
    directories with one WorkspaceDO waterline. Every successful project
    mutation is sent to all subscribed users in viewer-specific form; a removed
    participant receives a newer snapshot with the project absent. Reconnect
    installs the same canonical pair, and equal or older pairs cannot overwrite
    newer state.
