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
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | The member list (members A-Z by name, then guests A-Z by name), the menu beside each row (promote/demote or make member, and suspend), and the invitation role selector. A guest sees the same page drawn from `GET /workspace/roster`, without addresses or controls. |
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

A successful write also dispatches the workspace relationship deliveries the
membership triggers recorded. Migration 0109 turns any `UPDATE OF role` into a
revision bump and a `workspace_relationship_deliveries` row; `setMemberRole`
hands those to the queue exactly as `removeMember` and `promoteGuest` do,
because a recorded admission change that is never dispatched reaches no socket
holder. That is separate from the sync publish below: one carries the admission
fact, the other invalidates what a window has on screen.

**That publish is post-commit and best effort.** The role has already changed by
the time it runs, so a failure to announce it is logged as
`workspace_member_role_sync_publish_failed` and the request still succeeds.
Reporting it as a failed role change would tell the caller the opposite of what
happened, and on a self-demotion the caller's next request no longer carries the
standing to retry — while the no-op return above means a retry could not
republish anyway. The cost of a lost publish is a stale roster in other open
windows until something else invalidates it; nothing is mis-authorized by it,
because `auth.role` is read per request.

### What a guest sees of the roster

`GET /workspace/members` is the member's roster and stays behind `requireAuth`,
which refuses a guest. `GET /workspace/roster` (`WorkspaceService.listRoster`)
is mounted beside `GET /workspace` on the identity layer, so a guest reaches
it. Each row is `WorkspaceRosterEntrySchema`: id, name, avatar, presentation,
access class and role. It leaves out the email, timezone, dates, status and the
incarnation and revision an administrator's write needs. A guest is often from
outside the company, and those fields are either contact details or
bookkeeping they have no use for.

A guest is shown the active members and themselves, never other guests. Two
guests are often from different companies, shared different Channels, and
neither was told the other exists. Showing a guest the roles is deliberate:
knowing who administers the Organization is how a guest knows whom to ask.

The desktop reads either list through one hook, `useWorkspaceMembers` in
`apps/desktop/src/renderer/lib/workspace-members.ts`: the full roster for a
member, this one for a guest. Every surface that names or draws a person uses
it (the Channel feed, its header, the activity list, a thread's rail), so a
guest sees the same names a member does. A roster person has no email or
timezone, which is why both are optional on `WorkspaceMember`. Another guest
is still drawn as "Someone".

It is not where a guest's mention picker looks. Mentioning somebody outside a
conversation brings them in, so a guest's picker and `messageMentionPayload`
stay on the conversation's own participants.

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
- **A guest holds no role, and never acquires one here.** `workspace_members`
  enforces `access_class = 'guest' AND role IS NULL` with a `CHECK`. Giving a
  guest a role means promoting their *access class* first, through
  `promoteGuest`, which is a different operation on a different field.
- **The role the desktop holds decides what is *drawn*, never what is
  *allowed*.** Every control it draws is refused server-side for a member, so a
  stale role costs a redraw and nothing else. This is also what makes a lost
  sync publish survivable rather than a correctness problem.
- **A committed role change is never reported as a failure.** Anything after
  the `UPDATE` — today only the sync publish — is best effort. A caller told
  that a write failed when it committed will retry, and on a self-demotion the
  retry is refused for a change that already happened.

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
| `member_is_guest` | 409 | The target is a guest, who holds no role until `promoteGuest` moves their access class. |
| `membership_changed` | 409 | The conditional write lost a race; nothing was written. |
| — (logged only) | 200 | The role changed but `publishWorkspaceSync` failed. Logged as `workspace_member_role_sync_publish_failed` with the reason from `diagnosticErrorCode`; other windows keep a stale roster until something else invalidates it. |
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
  is doubled, because it addresses a WorkspaceDO and the Node suite runs none —
  and it is *asserted on*, both for the two topics a committed change publishes
  and for the silence a no-op or a refusal owes. A double nobody asserts on lets
  the call be deleted with the suite still green.
- `apps/api/test/workspace-and-invitations.test.ts` — the invitation role gate.
- `apps/desktop/src/renderer/screens/workspace-settings.test.tsx` — the viewer
  that matters is an administrator who is **not** the owner: rendering the owner
  there would stay green against a renderer regressed to owner-only, which is
  the behaviour under test. The roster it renders holds two people with the same
  display name, so the row menus' accessible names have to be distinct.

The last-administrator guard is exercised by deleting the owner row first. That
state is artificial but not illegitimate: nothing in the schema declares that an
owner row must exist, so the write may not lean on an invariant another module
enforces. A test that seeds an owner can never reach the guard, and would have
proved only that the owner was there.

## Changelog

### 2026-10-24 — Guests can see who is in the Organization

**What changed:** `GET /workspace/roster` returns the roster without addresses
or membership bookkeeping, and is open to guests. The Members page and the
account menu's **Members** item now show for guests, drawn from it; **Add new
member** and the row controls stay hidden. The desktop's `useWorkspaceMembers`
hook picks the right list for the reader, and the Channel feed, its header,
the activity list and a thread's rail now name people for a guest instead of
"Someone".

**Why:** A guest had no way to see who else was in the Organization, so no way
to know whom to ask for access or to recognise who they were working with. In
a shared Channel every member's message and thread read "Someone". The
roster itself was withheld because `/workspace/members` carries every person's
email and the fields an administrator's write needs.

**Considered and rejected:** Serving guests a trimmed `/workspace/members`. Its
schema requires the email, and every member surface reads it; a second shape
behind the same route would make each caller check which one it got. Also
rejected: showing guests the other guests, for the reason under "What a guest
sees of the roster". Also rejected: feeding the roster to a guest's mention
picker, since naming a person outside a conversation brings them in. That is
an access decision, not a display one.

**Consequences:** Anything added to `WorkspaceRosterEntrySchema` reaches people
outside the company. An email, a timezone or a status belongs on
`/workspace/members` instead. `WorkspaceMember.email` and `.timezone` are now
optional, so code that needs either must handle a person read from the guest
roster. A new surface that names people should read `useWorkspaceMembers`
rather than call `getWorkspaceMembers` itself, which refuses a guest.

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

`workspace_members` gained a guest access class (migration 0109) while this
branch was open. A guest's role is `NULL`, so the conditional write refuses one
already — but as `membership_changed`, which reads as a lost race and invites a
retry that can never succeed. `setMemberRole` names it `member_is_guest`
instead, and the roster draws no control beside a guest.

Review raised one correctness bug, fixed here: the sync publish originally ran
inside the endpoint's contract, so a WorkspaceDO that could not be reached made
a *committed* role change answer as a failure. It is now post-commit and best
effort, logged by name. Review also asked for the row controls' accessible
names to carry the person — every row's visible label is identical, so a screen
reader announced four indistinguishable buttons — and they now carry name and
email.

**Consequences:** A workspace can now reach a state with several administrators
and one owner, and code that assumed the administrator was the owner is wrong
rather than merely narrow. Anything new that gates on a role must accept
`owner` or `admin`. The last-administrator guard is the only thing standing
between a demotion and an unrecoverable workspace, and it lives in the `WHERE`
of the write — a future refactor that moves the check ahead of the statement
re-opens the race it was written to close. Ownership is still untransferable;
whoever creates a workspace is its owner forever, and a product that needs that
to change needs a separate operation with its own guards.
