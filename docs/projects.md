# Projects

**Projects are deleted.** WorkspaceDO migration 62 dropped the eight tables that
held them, and the service, storage, protocol, publisher, RPCs, routes, snapshot
topic, alarm phase and Queue handler went with them. Nothing in the tree reads a
Project any more. [`spaces.md`](spaces.md) is the module that replaced this one.

This document is kept for its changelog. The reasoning below is the only record
of why several decisions in Spaces are shaped the way they are — a Space's
default registry, its generation fences and its claim/send/accept publisher are
the Project mechanism carried forward — and a reader who finds a fence there and
wants to know what it was for will find the answer here. Do not build on
anything it describes; the code is gone.

## What was retired, and what survived

`PROJECT_RETIREMENT_STATEMENTS` in
`apps/api/src/durable-objects/workspace-do.ts` is the whole deletion, and it
runs children-before-parents: `PRAGMA foreign_keys = OFF` is a no-op once a
Durable Object event has touched SQLite, so the order is the only thing keeping
a drop from failing on a reference.

| Dropped in migration 62 | What it held |
| --- | --- |
| `projects` | Identity, presentation, scope, status, lifecycle generations. |
| `project_participants` | The per-person roster. |
| `workspace_project_order` | Each person's ordering. |
| `workspace_project_state` | The directory waterline. |
| `project_workstream_memberships` | The many-to-many placement rows. |
| `project_default_resources` | The default registry and its generations. |
| `project_default_resource_targets` | Staged delivery, one row per Channel. |
| `project_default_resource_publications` | The outbox half of that delivery. |

**What settles the undelivered effects.** A default still queued for delivery
is work aimed at a Channel whose audience the Space cutover has just changed,
so the statements invalidate every pending target and publication — targets to
`terminal` with `last_error_code = 'project_retired'`, publications to
`accepted` — in the same transaction that drops the tables. The activity
consumer keeps a tombstone leg for the platform's retry window: a message
published before the cutover finds nothing current, is acknowledged with
`reason: "projects_retired"`, and attaches nothing.

**Those two are the whole shutdown, and there is no barrier beside them.** This
shipped with one — a scratch table whose CHECK asserted no `pending` row was
left — and it could not fire: it counted rows the statements directly above it
had just settled, so the count was zero by construction. `finalizeSpaceBootstrap`
carried a matching `project_effects_pending` gate that could not fire either,
because migration 62 runs in the constructor and the tables are gone before any
caller reaches it. Both are deleted. **An undelivered Project default is
dropped**, which is what the PRD asks for: non-goal 5 deletes Projects rather
than converting them, so a default that never reached a Channel is not owed to
anybody.

**What a Project did to a Channel survives it.** A resource that was delivered
stays attached, a Sidekick that was recommended stays recommended, and a
Channel's audience is whatever its own authority holds. What the drop deletes is
the Organization's record of *why* a resource was delivered, never the delivery.

**`/projects/*` still answers.** `apps/api/src/routes/projects.ts` is a single
`410 client_update_required` naming `/spaces`, and it outlives the authority
deliberately: a client that still speaks Project gets one honest answer instead
of a 404 it would read as a wrong id. It reads nothing and writes nothing.

**What is still in the tree under a Project name:** the five appearance
constants in `packages/contracts/src/projects.ts`, the frozen per-migration
palette snapshots in `workspace-do.ts`, the `--av-sys-color-project-*` tokens
and `lib/project-palette.ts` on the desktop. Those are a colour vocabulary
rather than a module, they are what already-stored Space rows are spelled in,
and [`rally-rebrand-inventory.md`](rally-rebrand-inventory.md) covers renaming
them. `"projects"` also remains in `WORKSPACE_SYNC_TOPICS`, deliberately: a
shipped client's exhaustive map still names it, and removing the value would
break a rolling deploy for nothing.

## Changelog

### 2026-09-19 — The tables are dropped, and the barrier in front of them is deleted too

**What changed:** WorkspaceDO migration 62 deleted the eight Project tables and
everything that addressed them. The Queue's `project_default_resource` branch is
now a tombstone: it parses a non-strict shape of its own, logs
`reason: "projects_retired"` and acks, because a message published before the
cutover is still in flight and a nack would retry it to the dead-letter queue
forever.

**Why:** Phase 5's whole point. Two authorities answering "which container holds
this Channel" is the state every Space invariant is written to exclude, and
leaving the dormant one in place meant every future change to membership,
audience or defaults had to be reasoned about twice.

Review found that the shutdown barrier in front of the drops could not fire:
it counted `pending` rows immediately after the statements that settled every
one of them, and `finalizeSpaceBootstrap`'s matching gate ran after the
constructor had already dropped the tables. A barrier that reads its own writes
is not a gate, and keeping it would have left two mechanisms claiming to
enforce something neither one could. Both are deleted; the invalidation and the
tombstone consumer, which do the work, stay.

**Considered and rejected:** Dropping the tables unconditionally and letting a
queued default fail on a missing table. The durable half of an at-least-once
delivery is exactly what stops a message still in flight from attaching a
resource to a Channel whose audience the cutover has just changed, so the
migration settles what it can before it drops anything. Also rejected: making
the barrier *work*, by counting before the invalidation or by holding the
cutover open until an operator drained the Queue. Nothing is owed — non-goal 5
deletes Projects rather than converting them — so the gate would have held
every Organization's hierarchy closed to protect work the PRD says to discard.

**Consequences:** Migration 62 is released once it ships and is not edited.
There is no operator step in front of it: the retirement is unconditional, and
what an operator watches is the dead-letter queue, which [`runbook.md`](runbook.md)
holds.

### 2026-09-18 — Project sidebar failures carry operations, not response text

**What changed:** The project sidebar represents reorder and work-stream
assignment failures as a closed union whose exhaustive copy table owns the
visible sentence.

**Why:** Project actions share persistent navigation with unrelated requests;
rendering an exception there can make a server diagnostic look like project
content long after the rejected action.

**Considered and rejected:** Keeping strings in mutation catch blocks. That
leaves every caller able to pass arbitrary provider or transport text and makes
new project actions choose copy without an exhaustive check.

**Consequences:** Project mutations retain their diagnostics below the renderer,
while adding another visible failure requires adding its authored copy to the
same exhaustive table.

### 2026-09-10 — Add to project leaves the work-stream context menu

**What changed:** The sidebar work-stream right-click menu no longer offers the
**Add to project** submenu. Nothing else in the menu moved.

**Why:** Requested. The menu carries pin, unread, rename, scope, and archive on
the row people open most often to rename or archive, and this was the one item
in it that fanned out to a list with no ceiling — every project the viewer can
see.

**Considered and rejected:** Keeping the submenu behind a project-count
threshold. That trades a predictable menu for one whose shape depends on how
many projects happen to exist, which is worse to learn than either answer.

**Consequences:** No surface the desktop shell renders can now add an *existing*
work stream to a project. `app-shell.tsx` passes `conversationOnly` to the
sidebar unconditionally, and that flag is what suppresses
`ProjectSidebarSection` — so the project rows that accept a work-stream drop are
not on screen, and this submenu was the last reachable path to
`addWorkstreamToProject`. The project space has no equivalent control. Starting
a work stream *inside* a project is unaffected, and every server path
(WorkspaceDO staging, audience enlargement, default-resource attachment) is
untouched and still exercised by its tests. `WorkstreamRow` keeps its `projects`
prop only to gate `draggable`; when the sidebar's project section comes back,
that drop target works again with no further change. `ContextNestedMenu` and
`DropdownNestedMenu` in
`apps/desktop/src/renderer/components/nested-menu.tsx` now have no callers; the
component and its `.nested-menu-*` styles are left in place as the shared
submenu primitive rather than deleted and rebuilt by the next menu that needs
one.

### 2026-09-09 — New projects start blue, because the palette has no neutral left

**What changed:** The new-project dialog's initial and reset colour is `blue`.
`gray` was retired from the picker with the palette change, and `black` — the
only other candidate for a neutral — is reserved for account accents and never
offered for a project. Both call sites now read one `PROJECT_COLOR_DEFAULT`
constant instead of repeating the literal.

**Why:** The earlier default, gray, was chosen deliberately — a neutral start
that does not imply the creator picked a colour. That option no longer exists:
the palette is fourteen hues, and the one achromatic key belongs to accounts. So
the default is now a hue like any other, chosen for being the quietest rather
than for meaning "unset", and it is the team's to change. The two hard-coded
`'gray'` literals in the same component were how the initial value and the reset
value could disagree, which is why they collapsed into one constant.

**Consequences:** Projects created before this keep `gray` and still render; the
key remains storable, it simply cannot be chosen again. Nothing signals "no
colour chosen" any more — if that distinction is wanted back it needs a nullable
column, not a palette entry. Creation-flow checks assert `Blue` is pressed and
icon previews stroke `var(--av-sys-color-project-blue)`.

### 2026-09-02 — A project counts the members it can show

**What changed:** `ProjectSummary.workstreamIds` is now the active memberships
whose work stream is not archived, joined against the workspace directory
WorkspaceDO already holds. The membership itself is unchanged and is read
through a new `listProjectMembers` RPC, which the audience fan-out in
`ProjectService.updateAudience` now uses in place of the summary. A directory
projection that moves a work stream into or out of the archive advances the
project waterline and republishes the project snapshot, but only when one of
the affected work streams is in a project.

**Why:** Archiving a work stream never touched its project membership, while
every list of work streams filters archived ones out — so a project counted
members no surface could render. A workspace with three of a project's four
work streams archived sat on "Showing 1 of 4 work streams. Load more in the
sidebar to see all", pointing at a **load more** that could never produce the
other three, and the sidebar accordion said "4 work streams; load more to see
all" beside one row. Both counts came from this field.

**Considered and rejected:** Removing the membership when the work stream is
archived. It reads as the tidier fix and throws away the only record of where
the work stream belongs, so unarchiving would return it to no project, and the
write would have to cross from the work stream's own object into WorkspaceDO as
a queued effect rather than a transaction. Carrying the archived members as a
second field on `ProjectSummary`: it would have kept the fan-out reading one
shape, but that object is nested in the socket's opening sidebar payload and
parsed by a strict schema, so an added key makes a desktop build that shipped
before it drop the whole payload — work streams, automations and notes included
— rather than just ignoring a field. Publishing the project snapshot on every
directory projection: those arrive on ordinary activity, and republishing both
project lists to every socket that often costs far more than the count is
worth.

The publication sits before the awaits that follow the envelope loop and
outside the `directoryChanged` gate at the foot of that method, and a replayed
common effect is reconciled the way the watch registrations beside it already
are. The directory row and its receipt commit inside the loop while those
publications happen after it, so a rejection in any of them redelivers an
envelope whose archival is already recorded and has nothing left to compare
against: acknowledging that replay without republishing would leave every open
window on exactly the count this change exists to correct. A replay cannot be
told from an ordinary edit, so every replayed common effect is treated as one;
the membership test is what keeps that off the sockets, and a replay only
happens on the retry path.

The waterline advance is not incidental. A project directory at a waterline a
client already holds is dropped as a replay, so the first version of this
published a corrected snapshot that every open window discarded: driving the
archive from the app left the project page saying "1 work stream" over "Load
more recent work streams in the sidebar" until a reload, which is the bug this
change is about. `noteMemberArchivalChange` tests the membership and advances the
waterline in one transaction, and its answer is what decides whether to
publish.

The one loading announcement in the sidebar is now tied to the wait rather than
to the work-stream section's own placeholder. The three lists finish at
different moments — a person who already has a note but no work streams sees
that section's list while the projects and automations above are still
placeholders — and an announcement nested in the branch that renders the
work-stream skeletons went with them, leaving the remaining placeholders
unannounced.

**Consequences:** A count on a screen and the membership can now disagree, and
that is the point — anything acting on the project's behalf must read
`listProjectMembers` rather than the summary, or it will silently skip archived
members. `workstreamIds` is left-joined against the directory, so a work stream
that is a member before its first projection lands still counts. Existing rows
need no migration: the join is evaluated per read, so the projects in this
state correct themselves on the next list.

### 2026-08-30 — Nested project work streams use the sidebar's own row

**What changed:** Expanding a project now renders each member through the same
work-stream row the rest of the sidebar uses — title, description, marker, and
context menu — starting where the accordion control ends. The project row
itself wears the shared `.sidebar-row` hover fill, radius, and padding, and
its plus control is visible only while that row is hovered or focused.

**Why:** The accordion had been a second, thinner list: title-only children
indented past the project icon, a private hover fill, and a standing column of
pluses. That made a work stream inside a project look like a different object
from the same work stream in the recent list, and the pluses competed with the
names they sat beside.

**Considered and rejected:** Restyling `.project-sidebar-workstream` to
approximate the shared row. Matching font, hover, and a description by copying
rules would have drifted the moment either surface moved, which is how the two
lists got out of step. Passing the existing row in is the cheaper thing to
keep true.

**Consequences:** Nested members are the sidebar work-stream row, including
its context menu and drag payload. Command-number hints stay on the
pinned-then-recent run, not the accordion. The plus on the Projects heading
stays visible; only the per-row plus is hover-revealed.

### 2026-08-27 — Direct participant removal keeps the project audience fence

**What changed:** The work-stream participant DELETE route now goes through
`WorkstreamService.removeParticipant`, so an active project refuses a direct
audience change and reserves participant convergence for the project mutation.

**Why:** The service already carried the project constraint, but the regional
HTTP route constructed `WorkstreamObjectClient` directly. The new participant
management UI made that bypass reachable by every current reader of a project
work stream.

**Considered and rejected:** Duplicating the WorkspaceDO project lookup in the
route or inside the child work-stream object. The service is the existing
orchestrator for this cross-object rule; copying project authority into the
child would give two objects an answer to the same audience question.

**Consequences:** Direct removal from an active project returns
`project_audience_managed_by_project`. Project-driven removals continue through
the explicit `projectEffect` path after the project service has applied its role
and audience checks.

### 2026-08-27 — Project creation lands on its result

**What changed:** The New project dialog now waits for the create mutation,
inserts its returned project into the socket-owned directory cache, and then
opens that project's dashboard with its sidebar row selected and accordion
expanded. Clicking the selected row again closes the accordion. Needs attention
rows now reserve a project-facepile track and pin their time and chevron to
explicit columns whether or not a project or automation source is present.

**Why:** Successful creation previously left the person on the screen behind the
dialog, even though the server had returned the complete project. Separately,
the optional project pile became an extra anonymous grid child, shifting the
title into a content-sized track and moving the chevron away from the common
right edge.

**Considered and rejected:** Navigating before the create response, waiting for
a later socket snapshot to discover the new ID, and compensating for the pile
with negative margins. The mutation response already carries the authoritative
ID and presentation, while explicit grid tracks express the row relationship
without depending on which optional children render.

**Consequences:** Project creation callbacks return `ProjectSummary`; the dialog
does not navigate on a rejected mutation. Every Needs attention row renders an
empty project slot when it has no memberships so conditional content cannot
renumber the remaining tracks.

### 2026-08-27 — Project editing moves onto the owning surfaces, reads become socket-owned state, and review closes audience and delivery gaps

**What changed:** The project icon opens the shared icon/color grid, the name
renames inline, the participant face pile opens the shared people picker, and
scope changes through a confirming live dropdown. Default resources use a
right-aligned modal picker. Project navigation expands its accordion, sidebar
plus actions align without painted hover containers, and Add to project uses a
reusable nested-menu component with a selected checkmark. The creation form
uses the shared dropdown and themed text field, and its icon grid previews the
currently selected project color across every icon.

The subscribe payload now carries active and inactive project directories, and
every successful project write broadcasts a versioned, viewer-specific
replacement to all subscribed workspace sockets. Public project GET routes and
desktop project fetchers were removed.

Project participant removals now require the documented role and converge
through member work streams, personal-project admission rejects a broader
work-stream audience, project-start creation derives its audience from the
project, and default-resource Queue publication uses a WorkspaceDO outbox. The
desktop also orders project snapshots by waterline, keeps project controls as
independent mutations, and reports drag failures honestly. Duplicate names are
allowed.

**Why:** One Settings dialog hid unrelated actions behind an extra step and
made a partially saved multi-mutation form possible. The inline resource
dropdown also left the section visually unbalanced and did not scale to choosing
more than one resource.

Project invalidation followed by REST could race its own mutation and left
another person's open window stale. Rally's socket boundary requires data, not
change notifications, to come down the connection.

Review found paths that could widen a personal project, strand a committed
default before Queue admission, overwrite a newer project directory, or
disclose an invisible personal-project name. These are authority and user trust
failures rather than presentation polish.

**Considered and rejected:** Keeping the general Settings dialog and styling
only this one project submenu. Direct controls make each mutation's boundary
visible, while a shared nested-menu primitive keeps submenu spacing and selected
state consistent for later consumers.

Keeping `projects` as a generic workspace-sync topic and invalidating React
Query. That preserves two readers for one authority and pays a second round
trip whenever project state changes.

Direct Queue sends after the RPC, a workspace-wide project-name namespace, and
one combined settings save spanning two mutations. They respectively lose
committed work, leak private metadata, and create a partial-write interaction
the project space does not need.

**Consequences:** WorkspaceDO alarms now include project publication work;
Queue consumers prefer the requester but can use another active participant.
Duplicate display names must always be disambiguated by project ID and context.

### 2026-08-27 — Membership, Queue defaults, lifecycle, and desktop flows ship

**What changed:** Added staged one-active-project assignment over a many-to-many
membership table, monotonic audience propagation, generation-fenced default
resource targets on the regional Cloudflare Queue, project-aware work-stream
creation, archive/restore conflict checks, and the desktop navigation,
project-space, recovery, and project-icon-pile surfaces. Default-resource
audience preflight reuses the authoritative WorkspaceDO resource-read path
rather than querying retired D1 product tables.

**Why:** A project is useful only when its grouping and shared resources remain
correct across retries, moves, caller disconnects, and archive. The UI also has
to expose the same authority through drag and menu paths rather than leaving the
relationship as server-only scaffolding.

**Considered and rejected:** Copying project IDs into WorkstreamDO as a second
authority, applying defaults synchronously in one long WorkspaceDO call, and
undoing inherited audience or resources on removal. Those choices respectively
split ownership, make fan-out fragile, and rewrite context a work stream may
already have used.

**Consequences:** Queue delivery and membership settlement must carry and
recheck generations. Archived memberships remain historical rows and do not
block a new active V1 assignment; restoration must recheck that conflict before
activation.

### 2026-08-27 — WorkspaceDO becomes the project authority

**What changed:** Added closed project contracts, WorkspaceDO project,
participant, and per-person order tables, and authenticated RPC behavior for
create, list, reorder, and presentation updates.

**Why:** Projects need one regional authority before work-stream membership,
default resources, lifecycle propagation, or desktop state can safely depend on
them. Establishing visibility and generation boundaries first prevents later
slices from inventing incompatible storage or authorization rules.

**Considered and rejected:** D1 product tables and client-local ordering. D1
would split product authority from the workspace object, while local ordering
would not survive a second device and could not be reconciled authoritatively.

**Consequences:** Later slices must extend the WorkspaceDO migration ledger and
typed project protocol. They must preserve the three independent revisions and
must not infer active workspace membership from a project row alone.

Design: `docs/PRDs/2026-08-26_projects/prd.md`.
