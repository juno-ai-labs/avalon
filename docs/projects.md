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
| `apps/desktop/src/renderer/components/project-sidebar-section.tsx` | Creation, fixed ordering, accordion membership, drag targets, and recovery. |

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

Run the focused checks with:

```bash
pnpm --filter @rally/contracts test -- projects.test.ts
pnpm --filter @rally/api exec vitest run test/workspace-project-schema.test.ts
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
Global and EU.

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

## Changelog

### 2026-08-27 — Project editing moves onto the owning surfaces

**What changed:** The project icon opens the shared icon/color grid, the name
renames inline, the participant face pile opens the shared people picker, and
scope changes through a confirming live dropdown. Default resources use a
right-aligned modal picker. Project navigation expands its accordion, sidebar
plus actions align without painted hover containers, and Add to project uses a
reusable nested-menu component with a selected checkmark.

**Why:** One Settings dialog hid unrelated actions behind an extra step and
made a partially saved multi-mutation form possible. The inline resource
dropdown also left the section visually unbalanced and did not scale to choosing
more than one resource.

**Considered and rejected:** Keeping the general Settings dialog and styling
only this one project submenu. Direct controls make each mutation's boundary
visible, while a shared nested-menu primitive keeps submenu spacing and selected
state consistent for later consumers.

### 2026-08-27 — Project reads become socket-owned state

**What changed:** The subscribe payload now carries active and inactive project
directories, and every successful project write broadcasts a versioned,
viewer-specific replacement to all subscribed workspace sockets. Public project
GET routes and desktop project fetchers were removed.

**Why:** Project invalidation followed by REST could race its own mutation and
left another person's open window stale. Rally's socket boundary requires data,
not change notifications, to come down the connection.

**Considered and rejected:** Keeping `projects` as a generic workspace-sync
topic and invalidating React Query. That preserves two readers for one authority
and pays a second round trip whenever project state changes.

### 2026-08-27 — Review closes audience and delivery gaps

**What changed:** Project participant removals now require the documented role
and converge through member work streams, personal-project admission rejects a
broader work-stream audience, project-start creation derives its audience from
the project, and default-resource Queue publication uses a WorkspaceDO outbox.
The desktop also orders project snapshots by waterline, keeps project controls
as independent mutations, and reports drag failures honestly. Duplicate names
are allowed.

**Why:** Review found paths that could widen a personal project, strand a
committed default before Queue admission, overwrite a newer project directory,
or disclose an invisible personal-project name. These are authority and user
trust failures rather than presentation polish.

**Considered and rejected:** Direct Queue sends after the RPC, a workspace-wide
project-name namespace, and one combined settings save spanning two mutations.
They respectively lose committed work, leak private metadata, and create a
partial-write interaction the project space does not need.

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
