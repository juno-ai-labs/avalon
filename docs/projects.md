# Projects

Projects are workspace-owned containers that give people a stable way to group
related work streams. `WorkspaceDO` is the authority for project identity,
presentation, scope, participants, lifecycle generations, each person's
project order, many-to-many membership, default-resource delivery targets, and
reversible lifecycle state. The desktop presents V1 assignment as one active
project per work stream while reads and storage remain plural-ready. The full
behavior is in the approved [Projects design](PRDs/2026-08-26_projects/prd.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/projects.ts` | Closed project IDs, icon/color registries, scopes, statuses, and wire shapes. |
| `apps/api/src/durable-objects/workspace-do.ts` | WorkspaceDO schema migration and authenticated project RPC entry points. |
| `apps/api/src/durable-objects/workspace-project-protocol.ts` | Strict RPC requests, results, and stable error codes. |
| `apps/api/src/durable-objects/workspace-project-storage.ts` | Synchronous project transactions, visibility filtering, and per-person ordering. |
| `apps/api/src/services/project-service.ts` | Cross-object audience effects, membership settlement, and Queue publication. |
| `apps/api/src/queues/activity-consumer.ts` | Fenced default-resource attachment through the regional activity Queue. |
| `apps/desktop/src/renderer/screens/project-space.tsx` | Project dashboard: work-stream list, default resources, inline presentation and audience controls. The Work streams heading plus opens the same **New project work stream** route as the sidebar row plus. |
| `apps/desktop/src/renderer/components/project-sidebar-section.tsx` | Creation, fixed ordering, accordion membership, drag targets, and recovery. Nested members render through the sidebar's work-stream row. |
| `apps/desktop/src/renderer/components/sidebar-skeleton.tsx` | The sidebar's placeholder rows, shared by this section and the lists below it while the first answer is in flight. |

## How it works

Project changes go up through authenticated HTTP mutations, which call typed
WorkspaceDO RPCs with the workspace and user identifiers. The object rechecks
active membership in regional D1, then performs the project mutation
synchronously against its own SQLite authority. Creating a project writes the
project, makes its creator an active participant, and appends it to that
person's stored order in one transaction.

Project reads do not use HTTP. The workspace socket's subscribe response carries
the viewer's active and inactive project directories. After every committed
project mutation, WorkspaceDO reads that pair again for every subscribed user
and pushes `workspace_project_snapshot`. Personal-project visibility and order
are therefore evaluated separately for each socket. The active and inactive
lists carry the same WorkspaceDO project waterline and land through one desktop
receiver; a reconnect sends the same pair, and an equal or older pair is
dropped. Removing somebody from a personal project reaches their open socket as
a newer snapshot in which that project is absent.

Personal projects are returned only to active project participants. Workspace
projects are returned to every active workspace member. The first time a person
can see a project, its ID is appended to that person's order; reordering one
person's rows cannot change another person's order. Presentation changes update
the normalized name, icon, and color and advance only
`presentation_revision`.

A project's membership and the members it can show are not the same list.
Archiving a work stream takes it out of every listing and leaves its membership
untouched, so `ProjectSummary.workstreamIds` — what a screen counts and renders
— is the active memberships whose work stream the workspace directory does not
have archived, and `listProjectMembers` is how anything acting on the project's
behalf reads the whole membership. An audience change fans out over the
membership; a count on a screen reads the summary. Nothing on the wire carries
the archived members: `ProjectSummary` is a strict schema nested in the socket's
opening sidebar payload, and a field a shipped desktop build does not know makes
it drop that payload whole.

Adding an existing work stream is staged. WorkspaceDO first records a `joining`
membership and determines whether a previous active project can remain until
the final swap. The service enlarges the WorkstreamDO audience, attaches the
current defaults with canonical resource-link deduplication, and only then
activates the membership. Removing membership changes no WorkstreamDO audience
or resource link.

Adding a default resource writes one generation-fenced pending target for every
active membership and publishes those targets through the existing regional
activity Queue. The consumer rereads project, membership, default, and active
workspace-member authority before attaching. Duplicate delivery is safe; a
removed default or archived project makes an old target stale; the existing
regional activity DLQ remains the terminal failure signal.
Before accepting the default, the service performs the ordinary authoritative
resource read as every project reader. That read routes resource, connector,
note, upload, and inbound-email visibility through WorkspaceDO; regional D1 is
used only to enumerate active workspace members for a workspace-scoped project.

Starting from a project sends an authorized project ID through ordinary
work-stream creation. The coordinator derives scope, participants, and default
resources from WorkspaceDO. WorkstreamDO writes those audience and resource
rows in the initialization transaction that admits the first run, so the run
cannot observe a pre-project resource set.

## Invariants

- WorkspaceDO is the sole project authority. Copying project state into D1 or a
  child object would create two answers for authorization and ordering.
- Every RPC rechecks active workspace membership before reading or mutating.
  Without that check, a removed member could keep using a retained object stub.
- Personal visibility requires an active participant row; workspace visibility
  still requires active workspace membership. Scope never bypasses admission.
- Names are display labels rather than identity. Duplicate visible and private
  names are allowed; navigation and mutation use the project ID.
- Icon and color keys come from the shared closed registries. Persisting an
  arbitrary key would create rows no supported client can render consistently.
- Presentation, audience, and lifecycle revisions advance independently. A
  rename must not invalidate work whose safety depends only on audience or
  lifecycle state.
- Order belongs to `(user_id, project_id)` and is stored on the server. A device
  restart or second device therefore observes the same order without imposing
  it on another participant.
- Membership is keyed by project and work stream. V1 moves one active
  assignment at a time without a uniqueness constraint that would block later
  multi-project editing.
- Project effects are monotonic. Removing membership, removing a default, or
  archiving never removes audience or resources already applied to a work
  stream.
- An active project fences direct participant removal; a workspace-scoped
  project also fences direct work-stream scope narrowing. Audience changes go
  through the project so retained work streams converge first.
- Project mutation authorization is deliberately flat in V1: anyone who may
  read a project may rename it, manage defaults, change its audience, archive
  it, or restore it. A workspace project's creator has no extra privilege.
  Removing another participant is the exception and requires a workspace owner
  or admin; a regular member may remove only themselves.
- Projects add no prompt text, project memory, or compaction snapshot.
- Project state comes down the workspace socket. HTTP project routes mutate
  only; a project sync event must carry the state itself and must never trigger
  a project GET.

## Boundary

This module owns project metadata and project-level authorization inside one
workspace. It exposes validated contracts and WorkspaceDO RPCs; regional HTTP
mutation routes call those RPCs instead of accessing SQLite, while WorkspaceDO
publishes reads directly on the admitted workspace socket. Regional D1 remains
the authority for active workspace membership and placement only.

Workstream content and audience remain owned by WorkstreamDO, while resources
remain owned by the existing regional resource authority. WorkspaceDO records
the relationship and fenced delivery state; it never writes a child object's
SQLite directly.

## Failure modes and limits

Malformed inputs fail strict contract parsing. An inactive workspace member
receives `project_access_denied`, and an unreadable or inactive project receives
`project_not_found`. Project names are not a shared workspace namespace:
duplicate names are allowed because identity and navigation use project IDs,
and a conflict would reveal the names of personal projects. Transactions are local to one WorkspaceDO, so a failed
write leaves no partial project, participant, or ordering row.

There is no product-level project-count, default-resource-count, or name-length
ceiling in this slice. The prior eight-item `originResourceIds` transport cap
was removed because project defaults use that initialization field and a hidden
ninth-item failure would make an otherwise valid project unable to start a work
stream. Choosing a product ceiling is a team decision; the implementation does
not substitute the old attachment-oriented number for one. Those limits must
not be invented as defensive details.

## Testing

`packages/contracts/src/projects.test.ts` proves the exact picker registries and
closed schemas. `apps/api/test/workspace-project-schema.test.ts` applies the
real migration ledger to SQLite and proves constraints through version 17.
`apps/api/test-workers/project-authority.test.ts` runs the RPC behavior
on workerd with real Durable Object storage and D1 membership rows.

`apps/desktop/src/renderer/screens/project-space-screen.test.tsx` covers the
Work streams heading plus, the empty-state copy for active and archived
projects, and the other inline project-space mutations.
`apps/api/test/workstream-project-start.test.ts` proves project-start audience
resolution, including that a personal project seats its full roster, that
current default resources are attached in the initialize payload, and that an
origin already in the project's defaults is not attached twice.

Run the focused checks with:

```bash
pnpm --filter @rally/contracts test -- projects.test.ts
pnpm --filter @rally/api exec vitest run test/workspace-project-schema.test.ts
pnpm --filter @rally/api exec vitest run test/workstream-project-start.test.ts
pnpm --filter @rally/desktop exec vitest run src/renderer/screens/project-space-screen.test.tsx
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/project-authority.test.ts
```

The workerd fixture clears project state before each scenario but
keeps one object identity, which catches accidental reliance on object creation
order.

## Data model

`projects` stores one row per project, including its normalized display name,
closed presentation keys, scope/status, creator, archive fields, timestamps,
and three independent revisions. `project_participants` is keyed by project and
user and carries a state plus per-membership generation. `workspace_project_order`
is keyed by user and project and stores a non-negative position. Default target
and publication rows share the target generation key, so their insertion is one
SQLite transaction and Queue publication can resume after a failed send.
Foreign keys
are local to WorkspaceDO and cascade only from a deleted project.

## Regional impact

Each project's SQLite rows live in the WorkspaceDO selected by the workspace's
immutable regional placement. The only external read is the same-region D1
active-membership check. No project content or product state crosses between
configured deployments.

## Security and trust model

RPC payloads are untrusted and parsed at the object boundary. Workspace identity
is pinned by the object and asserted on every call. Active D1 membership is
checked before project-level visibility is evaluated, and project storage never
accepts SQL fragments or client-selected revision values.

## Operations

Migration version 17 is visible through the existing Durable Object migration
tracker. A project RPC failing before its transaction returns its stable domain
error; a migration or SQLite failure remains an object invocation failure and is
handled by the existing Worker logging and migration reporting paths.

## Performance and cost

All authoritative writes are synchronous SQLite operations in one Durable
Object. Directory reads lazily add missing order rows and then return the visible
ordered set. Each write re-reads the viewer-shaped snapshot once per subscribed
socket; this intentionally avoids a cache or secondary projection while the
product has no project load history. Later pagination can extend the typed
socket directory without moving authority or adding an HTTP read.
Default-resource target publication is the one external await: the WorkspaceDO alarm claims at most 100 due outbox rows,
advances their durable retry gates, and then sends one Queue batch. A rejected
send leaves them pending for a later alarm; accepted messages remain safe to
duplicate because the consumer rechecks target generations.

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
