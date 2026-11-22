# Shadow bans

A shadow ban is a flag an operator sets on a user account. A banned account
cannot create an Organization, and the app never tells it that a ban is the
reason. Everything else stays as it was: the account keeps its Organizations,
its sessions and its sign-in methods, and other people can still add it to
their Organization as a member or a guest.

That last part is deliberate. A banned account that gets added somewhere shows
which other Organizations belong to the same ring, and `search_users` lists
every one of them.

Read this before adding a way to create an Organization, before changing what
the refusal tells its caller, or before making a ban do more than it does.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/0137_shadow_ban.sql` | `users.shadow_banned_at`, and the trigger on `workspaces` that is the whole guard. |
| `apps/api/src/services/shadow-ban.ts` | `setUserShadowBan` (the one write that sets or lifts a ban), `isShadowBanAbort`, and `shadowBanRefusal`, the one place the refused write is turned into what its caller is told. |
| `apps/api/src/services/platform-onboarding-service.ts` | `createOwnedWorkspace`: both ways an Organization is created answer a refused batch through `shadowBanRefusal`. |
| `apps/api/src/engineering-inspection-bridge.ts`, `apps/engineering-mcp/src/server.ts` | The operator door: `set_user_shadow_ban`, and `shadowBannedAt` on every `search_users` and `list_users` row. |

## How it works

`users.shadow_banned_at` holds the time the ban was set, or `NULL`. No service
reads it to decide anything. The decision is made in D1, by one trigger:
**`workspace_shadow_ban_insert`** aborts the insert of a new `workspaces` row
whose `created_by_user_id` is a banned account, with `account_shadow_banned`,
which D1 carries in the error text.

Creating an Organization writes that row in one batch with its owner
membership, the journal entry and, for a person, their session. D1 runs a
batch as one transaction, so the abort undoes all of it. The Organization's
object is never initialized and no Canvas is seeded.

`shadowBanRefusal` turns the abort into an answer:

| Who created | What they are told |
| --- | --- |
| The account itself, in the app or the browser | 409 `request_unavailable`, "Rally could not complete this request." The error's `diagnosticCode` is `account_shadow_banned`, which never reaches a response body. |
| An operator, through `create_org` for a banned `creatorUserId` | 409 `account_shadow_banned`, since the operator is the one who can lift the ban. |

Either way one `shadow_ban_refused` line is logged with the account and the
Organization id that was asked for. The refusal is a regional business
refusal, so the Global coordinator releases its reservation as it does for
any other, and a later attempt is not left "in progress".

### Being added to an Organization

Nothing stops it. `addMember`, an invitation sent before adding replaced
invitations, `promoteGuest`, a Canvas share by address, and `create_org` with
the banned account among its initial members all work as they do for anyone.
`search_users` shows the banned account's Organizations, with role, guest or
member, and when it was last seen in each.

### Setting and lifting a ban

`set_user_shadow_ban({ region, userId, banned, reason })` on the engineering
MCP is the only door. It runs one statement in the named region: `banned: true`
sets the time unless one is already set, and `banned: false` clears it, so
repeating either changes nothing. The reason is written to the audit record
beside the operator, and the call is in the tool-call audit lakehouse like any
other ([`engineering-mcp.md`](engineering-mcp.md#tool-call-audit-log)).

## Invariants

- **The trigger is the guard, and the only one.** No service checks the flag
  before creating. A creation path added later is refused without knowing bans
  exist, provided it names its creator in `created_by_user_id`. Guard: the
  Organization cases in `apps/api/test/shadow-ban.test.ts`, on the checked-in
  migrations.
- **A ban does not stop an account being added.** Do not add a membership
  check for banned accounts: the product wants those rows written, because
  they are how a ring's other Organizations are found. Guard: "can still be
  added as a member, and as a guest" in the same file.
- **The account is never told the reason.** `account_shadow_banned` reaches a
  response only on the operator's create. A new creation path must go through
  `shadowBanRefusal`, or the raw D1 error becomes a 500, which the Global
  coordinator treats as an uncertain outcome and answers by keeping a pending
  reservation.
- **A refused create leaves nothing behind.** The Organization's row is in the
  same D1 batch as everything that depends on it. Moving a write out of that
  batch would let it survive the refusal.
- **An upsert over an existing Organization is not a creation.** The trigger
  skips a row whose id already exists, so the development sign-in, which
  upserts its Organization on every sign-in, keeps working for a banned
  account.

## Boundary

This module owns the flag, the trigger, and the wording of the refusal.
Creating an Organization stays with
[`multiple-workspaces.md`](multiple-workspaces.md) and
[`new-user-onboarding.md`](new-user-onboarding.md).

It deliberately does not:

- stop the account being added to an Organization, or mark the Organizations
  it is added to;
- block sign-in, end sessions, or take any access away
  ([`access-revocation.md`](access-revocation.md) owns that);
- stop the person making a second account under another address;
- run on its own: nothing sets a ban but an operator.

## Failure modes and limits

- **A ban does not cross deployments.** `users` is one row per deployment, and
  the flag is not carried on the platform identity Global hands a region.
  Global is the only configured deployment, so today one row is the whole
  account. With a second deployment, an operator bans each row `search_users`
  lists.
- **An owner can still be made, just not by creating.** An existing owner can
  add a banned account as an owner, or promote it. That is being added, which
  the ban allows.
- **Nothing marks an Organization a banned account joins.** Finding them is a
  `search_users` read, not a stored flag.
- **Hand-written SQL is refused too.** A `run_d1_sql` insert of an
  Organization created by a banned account aborts like any other.

## Testing

- `apps/api/test/shadow-ban.test.ts`: the trigger, that a banned account can
  still be added as a member and as a guest, and `setUserShadowBan`, against
  the checked-in migrations through `migratedSqliteDatabase()`.
- `apps/api/test/regional-workspace-create.test.ts`: a banned creator in the
  app and through the operator's create, with a count of every table the
  create writes, and a banned initial member being seated.
- `apps/api/test/engineering-inspection-routes.test.ts` and
  `apps/engineering-mcp/test/server.test.ts`: the search column and the tool's
  routing to one region.

## Regional impact

See the first entry under [Failure modes and limits](#failure-modes-and-limits).
Nothing crosses a deployment boundary: the flag is read and written only in
the deployment that holds the row.

## Operations

`search_users` shows `shadowBannedAt` and every Organization the account is
in. To see what a ban has refused, query Worker logs for `event =
shadow_ban_refused`; each line carries `workspace_id` and `user_id`. To see
who set or lifted a ban and why, query `engineering_mcp_audit` for `tool =
'set_user_shadow_ban'`.

## Changelog

### 2026-11-22 — Shadow bans stop an account creating an Organization, and nothing else

**What changed:** Added `users.shadow_banned_at`, a trigger on `workspaces`
that refuses an Organization a banned account creates, the
`set_user_shadow_ban` operator tool, and the refusal in `createOwnedWorkspace`.

**Why:** The owner asked for a way to mark an account so it can no longer
create Organizations, without telling the account.

**Considered and rejected:** Also refusing a banned account a membership or a
guest relationship. That was built first, as two triggers on
`workspace_members` with a refusal at each write, and removed before it
merged: the owner wants a banned account to stay addable, so the other
Organizations of its ring show themselves. Also rejected: a check in the
creation service instead of a trigger, which covers only the paths somebody
remembered and adds a read to every create. Also rejected: `RAISE(IGNORE)`,
which skips the row silently and would let the rest of the batch write an
owner for an Organization that does not exist. Also rejected: carrying the
flag to other deployments on the platform identity, for a second deployment
that does not exist.

**What a future change has to respect:** A ban must not grow a membership
check without a new decision from the owner. A new way to create an
Organization is covered only if it names its creator in `created_by_user_id`
and writes everything else in the same batch, and only reads as a refusal if
it goes through `shadowBanRefusal`. Marking the Organizations a banned
account joins was discussed and not built.
