# Workspace member roles

Who may administer a Rally workspace, and how that set changes. Every workspace
membership carries exactly one role — `owner`, `admin`, or `member` — and every
admin-gated action in the product means the same thing by "administrator": the
caller's role is `owner` **or** `admin`. This document owns that vocabulary, the
one write that assigns a role, and the invariant that keeps a workspace from
ending up with nobody who can administer it.

Read it before adding an admin-gated action, before changing how a role is
assigned, and before assuming anywhere that a workspace has one administrator.
Ending a membership belongs to [`access-revocation.md`](access-revocation.md);
the read-side authorization primitive that composes resource access belongs to
[`authorization.md`](authorization.md); roles are not an input to either.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/0001_initial.sql` | `workspace_members(workspace_id, user_id, role, status, …)` — one row per person per workspace, `role` constrained to `owner`/`admin`/`member`. Unchanged since the first migration. |
| `packages/contracts/src/index.ts` | `MemberRoleSchema` (all three roles, as read) and `AssignableMemberRoleSchema` (`admin`/`member` — the roles an administrator may hand out). `WorkspaceInvitationRoleSchema` is the same schema, so an invitation and a promotion cannot drift. |
| `apps/api/src/middleware/auth.ts` | Resolves `auth.role` from `workspace_members` on **every** request, and `requireWorkspaceAdmin` — the route-level gate. |
| `apps/api/src/services/workspace-service.ts` | `setMemberRole` (the one write that changes a role), `createInvitation` (the role a future membership arrives with), `removeMember` and `leaveWorkspace` (the owner counts that keep a workspace owned), and the private `requireAdmin` every workspace-administration method starts with. |
| `apps/api/src/routes/workspace.ts` | `PATCH /workspace/members/:userId/role`. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | The member list, the promote/demote control beside each row, and the invitation role selector. |
| `apps/desktop/src/renderer/lib/session-workspace.ts` | Why the role the desktop holds is a *presentation* input and never an authorization one. |

## How it works

A role is one column on one row. `auth.role` is read from that row on every
authenticated request — there is no cache, no token claim, and nothing to
invalidate — so a role change takes effect on the next request the person makes,
including one already in flight from a window that has not redrawn yet.

A membership acquires its role in one of three ways:

- **Creation.** Whoever creates a workspace is inserted as `owner`
  (`auth-service.ts`, `platform-onboarding-service.ts`).
- **Invitation.** `createInvitation` stores an `AssignableMemberRole` on the
  invitation row, and acceptance copies it onto the new membership. Acceptance
  never *lowers* a role that already exists: its `ON CONFLICT` clause keeps an
  existing `owner` or `admin`.
- **Assignment.** `WorkspaceService.setMemberRole` sets the role on a membership
  that already exists. This is the only way a workspace grows a second
  administrator after the fact, and it is what `PATCH
  /workspace/members/:userId/role` calls.

`setMemberRole` reads the target membership, refuses the three cases the next
section names, and then writes with a conditional `UPDATE` that re-asserts every
one of them in its own `WHERE`. The re-assertion is not belt-and-braces: the
reads happen in an earlier round trip and D1 auto-commits in between, so two
administrators demoting each other at the same moment both pass the reads.
SQLite serializes the two statements, whichever runs second finds the invariant
it needed already gone, changes nothing, and answers `409`.

A successful write publishes `member_directory` and `workspace_profile` on the
workspace sync log. The first refreshes every administrator's roster; the second
refreshes `GET /workspace`, which is where a person's own role — and therefore
whether their window draws the administrator controls at all — comes from.

## Invariants

- **"Administrator" is `owner` or `admin`, everywhere.** Every gate in the tree
  spells it that way. A new gate that checks only `owner` re-creates the
  single-administrator problem this module exists to remove, silently, in one
  feature.
- **A workspace always has at least one active administrator.** A workspace with
  none cannot be recovered from inside the product: no administrator means no
  invitation, no promotion, and no way back. `setMemberRole` refuses a demotion
  that would empty the set, with `last_workspace_administrator`.
- **`owner` is not assignable, and an owner is not a target.** The founding
  membership is what `leaveWorkspace` and `removeMember` count when they refuse
  to leave a workspace unowned; letting `setMemberRole` hand it around would put
  a second module in charge of an invariant those two enforce. Transferring
  ownership is a separate operation that does not exist yet.
- **Only an active membership has a role to change.** Somebody who has not
  accepted their invitation is not a member to promote — the invitation carries
  their role, and reissuing one is how it changes.
- **The role the desktop holds decides what is *drawn*, never what is
  *allowed*.** Every control it draws is refused server-side for a member, so a
  stale role costs a redraw and nothing else.

## Boundary

This module owns the role column, its vocabulary, and the single write that
assigns it. It does **not** own:

- **Ending a membership** — `removeMember` and `leaveWorkspace`, and the
  revocation each publishes. See
  [`access-revocation.md`](access-revocation.md).
- **What an administrator may then do.** Each feature gates itself; connector
  scope, Terminal network policy, projects, memory and invitations each hold
  their own check against `auth.role`.
- **Resource-level read decisions**, which compose owner facts rather than
  workspace roles. See [`authorization.md`](authorization.md).
- **Per-resource permissions or a role hierarchy beyond these three.** Neither
  exists, and nothing here is built as a step toward one.

Callers are the authenticated desktop client through
`PATCH /workspace/members/:userId/role`. There is no operator door and no
Durable Object path: roles live in regional D1 and only the Worker writes them.

## Failure modes and limits

| Code | Status | When |
| --- | --- | --- |
| `workspace_admin_required` | 403 | The caller is an ordinary member. |
| `member_not_found` | 404 | Nobody by that id belongs to this workspace. |
| `cannot_change_owner_role` | 403 | The target is the workspace owner. |
| `member_not_active` | 409 | The target has not accepted their invitation. |
| `last_workspace_administrator` | 409 | The demotion would leave the workspace with no administrator. |
| `membership_changed` | 409 | The conditional write lost a race; nothing was written. |
| `member_role_invalid:…` | 400 | The role is not one an administrator may assign. The code carries the failing path and Zod issue code, from `zodDiagnosticCode` — see [`naming-a-schema-failure.md`](naming-a-schema-failure.md). |

Assigning the role somebody already holds is a no-op: it returns without a write
and without a publish, so a double-click costs nothing and announces nothing.

There is no limit on how many administrators a workspace may have. None was
asked for, and inventing a ceiling here would be
[a number nobody set](adding-security-defensive-and-other-limits.md).

## Testing

- `apps/api/test/workspace-member-roles.test.ts` — the whole write against the
  checked-in migrations through `migratedSqliteDatabase()`, so the column's
  `CHECK` and the conditional `WHERE` are the production ones. The sync publish
  is doubled, because it addresses a WorkspaceDO and the Node suite runs none.
- `apps/api/test/workspace-and-invitations.test.ts` — the invitation role gate.
- `apps/desktop/src/renderer/screens/workspace-settings.test.tsx` — that an
  administrator is offered the control beside every row but the owner's, and an
  ordinary member is offered none.

The last-administrator guard is exercised by deleting the owner row first. That
state is artificial but not illegitimate: nothing in the schema declares that an
owner row must exist, so the write may not lean on an invariant another module
enforces. A test that seeds an owner can never reach the guard, and would have
proved only that the owner was there.

## Changelog

### 2026-09-18 — A workspace can have more than one administrator

**What changed:** `WorkspaceService.setMemberRole` and
`PATCH /workspace/members/:userId/role` assign `admin` or `member` to a
membership that already exists, with promote/demote exposed beside every member
in Workspace settings. Any administrator may now invite another administrator;
that was previously the owner's alone. A demotion that would leave the workspace
with no active administrator is refused as `last_workspace_administrator`.

**Why:** A single administrator per workspace was a single point of failure that
blocked real work. On a design call on 2026-09-17 somebody tried to demo a
connector flow, could not — workspace connections require an administrator — and
there was no in-product way to make them one: a role arrived on an invitation
and nothing could ever change it afterwards. The person who *was* the
administrator had to be present for every administrator action, and if they were
away, unreachable, or gone, the workspace was stuck.

**Considered and rejected:** Adding a second `admin_user_id` column on
`workspaces`. `workspace_members.role` has been a per-membership column since
migration 0001, so N administrators were always representable — the constraint
was never the schema, and every gate in the tree already accepted `owner` **or**
`admin`. A second column would have been a second authority for the same fact
and the first bug in it would have been the two disagreeing. Also rejected:
keeping administrator invitations owner-only. An administrator who can promote
an existing member can reach the same end state in two steps, so the gate
stopped anything except the convenient path.

**Consequences:** A workspace can now reach a state with several administrators
and one owner, and code that assumed the administrator was the owner is wrong
rather than merely narrow. Anything new that gates on a role must accept
`owner` or `admin`. The last-administrator guard is the only thing standing
between a demotion and an unrecoverable workspace, and it lives in the `WHERE`
of the write — a future refactor that moves the check ahead of the statement
re-opens the race it was written to close. Ownership is still untransferable;
whoever creates a workspace is its owner forever, and a product that needs that
to change needs a separate operation with its own guards.
