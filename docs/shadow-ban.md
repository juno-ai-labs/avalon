# Shadow bans

A shadow ban is a flag an operator sets on a user account. A banned account
cannot create an Organization, become a member of one, or be added to one as a
guest. It keeps every Organization it already belongs to, its sessions and its
sign-in methods, and the app never tells it, or whoever tried to add it, that a
ban is the reason.

Read this before adding a path that writes `workspace_members`, before changing
what a refused write tells its caller, or before making a ban do more than it
does.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/0137_shadow_ban.sql` | `users.shadow_banned_at`, and the two triggers on `workspace_members` that are the whole guard. |
| `apps/api/src/services/shadow-ban.ts` | `setUserShadowBan` (the one write that sets or lifts a ban), `isShadowBanAbort`, and `shadowBanRefusal`, the one place a refused write is turned into what its caller is told. |
| `apps/api/src/services/platform-onboarding-service.ts` | `createOwnedWorkspace`: both ways an Organization is created answer a refused batch through `shadowBanRefusal`. |
| `apps/api/src/services/workspace-service.ts` | `addMember`, `acceptInvitationForUser` and `promoteGuest` do the same. |
| `apps/api/src/durable-objects/scope-invitation-service.ts` | A Canvas share: `prepareRecipients` runs its batch again without the banned accounts, and `claimOne` answers a refused guest relationship as a denial. |
| `apps/api/src/engineering-inspection-bridge.ts`, `apps/engineering-mcp/src/server.ts` | The operator door: `set_user_shadow_ban`, and `shadowBannedAt` on every `search_users` and `list_users` row. |

## How it works

`users.shadow_banned_at` holds the time the ban was set, or `NULL`. Nothing in
the app reads it to decide anything. The decision is made in D1, by two
triggers on `workspace_members`:

- **`workspace_member_shadow_ban_insert`** aborts an insert that would give a
  banned account a row it does not have yet, member or guest.
- **`workspace_member_shadow_ban_update`** aborts an update that makes a banned
  account's guest row a member, or makes a row that is not active active again.

Both abort with `account_shadow_banned`, which D1 carries in the error text.
Every way an account gains an Organization writes a membership row in the same
batch as the rest of its work, and D1 runs a batch as one transaction, so the
abort undoes all of it:

| What was tried | What the abort undoes | What the caller is told |
| --- | --- | --- |
| Creating an Organization (the app, or `create_org`) | The Organization, its owner, any initial members, the journal entry and the creator's session. The object is never initialized and no Canvas is seeded. | 409 `request_unavailable`; an operator gets `account_shadow_banned`. |
| `addMember` (`POST /workspace/members`, the legacy invitations route, `add_org_member`) | The membership, and the revocation of an invitation waiting for the address. No email is sent. | The same pair. |
| Accepting an invitation sent before adding replaced invitations | The membership and the invitation's acceptance, so the invitation stays pending. | 409 `request_unavailable`. |
| `promoteGuest` | The promotion. | 409 `request_unavailable`. |
| A Canvas shared with the account's address | Nothing of the share. See below. | The sharer sees a pending share. |

`shadowBanRefusal` builds those answers. A person is told "Rally could not
complete this request." under a code that names nothing, with
`account_shadow_banned` as the error's `diagnosticCode`, which never reaches a
response body. A call made through the engineering MCP (`auth.principal ===
"engineering"`, or the operator-only create) is told the reason, since the
operator is the one who can lift the ban. Every refusal logs one
`shadow_ban_refused` line with the action, the Organization and the account.

### A Canvas share

A share is recorded by address and claimed by whoever proves the address
([`scope-invitations.md`](scope-invitations.md)), so a share to a banned
account is recorded like any other and simply never claimed while the ban
stands:

- **When the share is made**, one batch gives a guest relationship to every
  recipient who already has an account. A banned recipient aborts that batch
  for everyone, so `prepareRecipients` runs it once more with the banned
  accounts left out. The others are admitted; the banned account's share stays
  pending, exactly as a share to an address with no account does. Only a share
  that names a banned account pays for the second round trip.
- **When the banned account signs in**, the claim asks for a guest
  relationship, the insert aborts, and `claimOne` answers
  `relationship_required`. The sign-in carries on, the share stays pending and
  keeps its lookup row, and the first sign-in after the ban is lifted claims
  it.

The invitation email is still sent. Its link opens nothing the account can
reach.

### Setting and lifting a ban

`set_user_shadow_ban({ region, userId, banned, reason })` on the engineering
MCP is the only door. It runs one statement in the named region: `banned: true`
sets the time unless one is already set, and `banned: false` clears it, so
repeating either changes nothing. The reason is written to the audit record
beside the operator, and the call is in the tool-call audit lakehouse like any
other ([`engineering-mcp.md`](engineering-mcp.md#tool-call-audit-log)).

## Invariants

- **The triggers are the guard, and the only one.** No service reads
  `shadow_banned_at` before writing a membership. A path added later that
  inserts into `workspace_members` is refused without knowing bans exist; a
  check in a service would cover only the paths somebody remembered. Guard: the
  membership cases in `apps/api/test/shadow-ban.test.ts`, on the checked-in
  migrations.
- **A ban freezes what an account can reach; it takes nothing away.** An
  existing membership or guest relationship stays, and can still be suspended,
  removed, or given a different role. Inside an Organization the account
  already belongs to, it can still be added to a Canvas or shared one. Taking
  access away is [`access-revocation.md`](access-revocation.md)'s job, by
  removing the membership.
- **A person is never told the reason.** `account_shadow_banned` reaches a
  response only through the engineering principal. A new refusal site must go
  through `shadowBanRefusal`, or a raw D1 error becomes a 500 that names the
  ban in the server log and, worse, leaves a pending Global reservation behind
  on a create: `completeRegionalAction` releases a reservation only for a
  refusal below 500.
- **A refused write leaves nothing behind.** Each path's membership row is in
  the same D1 batch as the writes that depend on it. Moving one of those
  writes out of the batch would let it survive the refusal.
- **Creating an Organization is refused because its owner row is.** Every
  creator writes the Organization and its owner in one batch. A path that
  created an Organization without an owner membership in that batch would not
  be covered.

## Boundary

This module owns the flag, the two triggers, and the wording of a refusal. It
does not own any of the writes it refuses: those stay with
[`workspace-member-roles.md`](workspace-member-roles.md),
[`multiple-workspaces.md`](multiple-workspaces.md) and
[`scope-invitations.md`](scope-invitations.md).

It deliberately does not:

- block sign-in, end sessions, or stop the account using an Organization it is
  already in;
- stop the person making a second account under another address;
- hide the account from rosters or pickers;
- run on its own: nothing sets a ban but an operator.

## Failure modes and limits

- **A ban does not cross deployments.** `users` is one row per deployment, and
  the flag is not carried on the platform identity Global hands a region.
  Global is the only configured deployment, so today one row is the whole
  account. With a second deployment, an operator bans each row `search_users`
  lists, and an account an administrator made there by address stays unbanned
  until someone bans that row.
- **The other side of a refusal can infer it.** An administrator who cannot
  add one particular address, and a sharer whose share to a known colleague
  never leaves pending, each see something unusual. Nothing says why.
- **An operator's create names no account.** `create_org` writes the owner and
  the initial members in one batch, and the abort does not say which row it
  refused. The refusal says one of them is banned; `search_users` says which.
- **A banned account's pending shares cost each of its sign-ins a claim
  attempt**, one object call per Canvas holding one, and a `shadow_ban_refused`
  line each.
- **Hand-written SQL is refused too.** A `run_d1_sql` insert of a membership
  for a banned account aborts like any other. Lift the ban first.

## Testing

- `apps/api/test/shadow-ban.test.ts`: the guard and every member path, against
  the checked-in migrations through `migratedSqliteDatabase()`. The fixture
  bans one account with no Organization and one that is already a guest,
  because the two triggers are reached by different accounts.
- `apps/api/test/regional-workspace-create.test.ts`: a banned creator and a
  banned initial member, with a count of every table the create writes.
- `apps/api/test-workers/scope-invitations.test.ts`: a share on the real
  Organization object and workerd's D1. That suite's D1 has no schema, so the
  cases apply the checked-in migration itself through
  `helpers/shadow-ban-schema.ts` rather than a copy of its triggers.
- `apps/api/test/engineering-inspection-routes.test.ts` and
  `apps/engineering-mcp/test/server.test.ts`: the search column and the tool's
  routing to one region.

The first refusal check to break is `isShadowBanAbort`: with it answering
false, every member and creation case fails on a raw `account_shadow_banned`
error instead of a refusal.

## Regional impact

See the first entry under [Failure modes and limits](#failure-modes-and-limits).
Nothing crosses a deployment boundary: the flag is read and written only in
the deployment that holds the row.

## Operations

`search_users` shows `shadowBannedAt`. To see what a ban has refused, query
Worker logs for `event = shadow_ban_refused`; each line carries `action`,
`workspace_id` and `user_id`. To see who set or lifted a ban and why, query
`engineering_mcp_audit` for `tool = 'set_user_shadow_ban'`.

## Changelog

### 2026-11-22 — Shadow bans, guarded by triggers on the membership table

**What changed:** Added `users.shadow_banned_at`, two triggers on
`workspace_members` that refuse a banned account a new relationship, the
`set_user_shadow_ban` operator tool, and a refusal at each of the six writes
the triggers can abort.

**Why:** The owner asked for a way to mark an account so it can no longer
create Organizations, join them, or be added as a guest, without telling the
account.

**Considered and rejected:** A check in each service before its write. There
are eight statements that insert a membership, in five files, and a ninth
would have to remember the check; each check is also a read the unbanned
common case pays for. The triggers cost nothing on that path and cover a
writer nobody has written yet. Also rejected: `RAISE(IGNORE)`, which skips the
row silently. It would have needed no refusal code at all, and would have
created an Organization with no owner and marked an invitation accepted with
no membership behind it. Also rejected: filtering banned accounts out of every
share's recipient batch, which adds a subquery to every share to serve a case
that almost never happens; the batch is retried without them only when it
aborts. Also rejected: carrying the flag to other deployments on the platform
identity, for a second deployment that does not exist.

**What a future change has to respect:** A new way to gain an Organization is
covered only if it writes its membership row in the batch with everything
that depends on it, and only reads as a refusal if it goes through
`shadowBanRefusal`. A ban that should also remove access, block sign-in or
reach another deployment is a new decision, not an extension of this one.
