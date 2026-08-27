# Projects

Projects are workspace-owned containers that give people a stable way to group
related work streams. `WorkspaceDO` is the authority for project identity,
presentation, scope, participants, lifecycle generations, and each person's
project order. The first implementation slice establishes that authority and
its typed contracts; work-stream membership, default resources, lifecycle
transitions, and desktop presentation are added in later slices of the approved
[Projects design](PRDs/2026-08-26_projects/prd.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/projects.ts` | Closed project IDs, icon/color registries, scopes, statuses, and wire shapes. |
| `apps/api/src/durable-objects/workspace-do.ts` | WorkspaceDO schema migration and authenticated project RPC entry points. |
| `apps/api/src/durable-objects/workspace-project-protocol.ts` | Strict RPC requests, results, and stable error codes. |
| `apps/api/src/durable-objects/workspace-project-storage.ts` | Synchronous project transactions, visibility filtering, and per-person ordering. |

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

## Boundary

This module owns project metadata and project-level authorization inside one
workspace. It exposes validated contracts and WorkspaceDO RPCs; regional HTTP
routes and the desktop call those RPCs instead of accessing SQLite. Regional D1
remains the authority for active workspace membership and placement only.

Workstream content and audience remain owned by WorkstreamDO, while resources
remain owned by the work-stream resource authority. Their project protocols are
not part of the Phase 0 slice described here.

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
real migration ledger to SQLite and proves constraints and version-12 upgrade
safety. `apps/api/test-workers/project-authority.test.ts` runs the RPC behavior
on workerd with real Durable Object storage and D1 membership rows.

Run the focused checks with:

```bash
pnpm --filter @rally/contracts test -- projects.test.ts
pnpm --filter @rally/api exec vitest run test/workspace-project-schema.test.ts
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/project-authority.test.ts
```

The workerd fixture clears the three project tables before each scenario but
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

Migration version 13 is visible through the existing Durable Object migration
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
