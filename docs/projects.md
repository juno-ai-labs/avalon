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

An active workspace member calls a typed WorkspaceDO RPC with their workspace
and user identifiers. The object rechecks active membership in regional D1,
then performs the project mutation or read synchronously against its own SQLite
authority. Creating a project writes the project, makes its creator an active
participant, and appends it to that person's stored order in one transaction.

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
- Names are unique after trimming, Unicode normalization, and case folding
  across every lifecycle state. Reusing an archived name would make restore and
  navigation ambiguous.
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
- Projects add no prompt text, project memory, or compaction snapshot.

## Boundary

This module owns project metadata and project-level authorization inside one
workspace. It exposes validated contracts and WorkspaceDO RPCs; regional HTTP
routes and the desktop call those RPCs instead of accessing SQLite. Regional D1
remains the authority for active workspace membership and placement only.

Workstream content and audience remain owned by WorkstreamDO, while resources
remain owned by the existing regional resource authority. WorkspaceDO records
the relationship and fenced delivery state; it never writes a child object's
SQLite directly.

## Failure modes and limits

Malformed inputs fail strict contract parsing. An inactive workspace member
receives `project_access_denied`; a normalized-name collision receives
`project_name_conflict`; and an unreadable or inactive project receives
`project_not_found`. Transactions are local to one WorkspaceDO, so a failed
write leaves no partial project, participant, or ordering row.

There is no product-level project-count or name-length ceiling in this slice.
Those are product decisions and must not be invented as defensive limits.

## Testing

`packages/contracts/src/projects.test.ts` proves the exact picker registries and
closed schemas. `apps/api/test/workspace-project-schema.test.ts` applies the
real migration ledger to SQLite and proves constraints through version 15.
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

`projects` stores one row per project, including its normalized unique name,
closed presentation keys, scope/status, creator, archive fields, timestamps,
and three independent revisions. `project_participants` is keyed by project and
user and carries a state plus per-membership generation. `workspace_project_order`
is keyed by user and project and stores a non-negative position. Foreign keys
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

Migration version 15 is visible through the existing Durable Object migration
tracker. A project RPC failing before its transaction returns its stable domain
error; a migration or SQLite failure remains an object invocation failure and is
handled by the existing Worker logging and migration reporting paths.

## Performance and cost

All authoritative writes are synchronous SQLite operations in one Durable
Object. Directory reads lazily add missing order rows and then return the visible
ordered set. This intentionally avoids a cache or secondary projection while
the product has no project load history; later pagination can extend the typed
directory without moving authority.

## Changelog

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
