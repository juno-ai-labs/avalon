# Shadow bans

A shadow ban is a flag an operator sets on a user account. A banned account
cannot create an Organization, and the app never tells it that a ban is the
reason. Everything else stays as it was: the account keeps its Organizations,
its sessions and its sign-in methods, and other people can still add it to
their Organization as a member or a guest. That is deliberate: `search_users`
then lists every Organization the account reaches.

Read this before adding a way to create an Organization, or before making a
ban do more than it does.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/0137_shadow_ban.sql` | `users.shadow_banned_at`, and the trigger on `workspaces` that is the whole guard. |
| `apps/api/src/services/shadow-ban.ts` | `setUserShadowBan`, the one write that sets or lifts a ban, and `shadowBanRefusal`, which turns the trigger's abort into what the caller is told. |
| `apps/api/src/services/platform-onboarding-service.ts` | `createOwnedWorkspace`, where both ways of creating an Organization meet the refusal. |
| `apps/engineering-mcp/src/server.ts` | `set_user_shadow_ban`, and `shadowBannedAt` on `search_users` and `list_users` rows. |

## How it works

`users.shadow_banned_at` holds the time the ban was set, or `NULL`. No service
reads it. The trigger `workspace_shadow_ban_insert` aborts the insert of a new
`workspaces` row whose `created_by_user_id` is banned, with
`account_shadow_banned`, which D1 carries in the error text.

Creating an Organization writes that row in one D1 batch with its owner
membership, the journal entry and, for a person, their session. A batch is one
transaction, so the abort undoes all of it, and the Organization's object is
never initialized. `shadowBanRefusal` turns the abort into an answer:

| Who created | What they are told |
| --- | --- |
| The account itself | 409 `request_unavailable`, "Rally could not complete this request." |
| An operator, through `create_org` for a banned `creatorUserId` | 409 `account_shadow_banned`. |

`set_user_shadow_ban({ region, userId, banned, reason })` runs one statement
in the named region. Setting a ban that is already set keeps its time, so
repeating either call changes nothing.

## Invariants

- **The trigger is the only guard.** A creation path added later is refused
  without knowing bans exist, provided it names its creator in
  `created_by_user_id`. Guard: `apps/api/test/shadow-ban.test.ts`.
- **A ban does not stop an account being added.** Do not add a membership
  check for banned accounts. Guard: "can still be added as a member, and as a
  guest" in the same file.
- **The account is never told the reason.** A new creation path must go
  through `shadowBanRefusal`. A raw D1 error becomes a 500, which the Global
  coordinator treats as an uncertain outcome and answers by keeping a pending
  reservation.
- **A refused create leaves nothing behind.** That holds only while the
  Organization's row is in the same batch as everything that depends on it.
- **An upsert over an existing Organization is not a creation.** The trigger
  skips a row whose id already exists, or the development sign-in, which
  upserts its Organization every time, would fail for a banned account.

## Boundary

This module owns the flag, the trigger, and the wording of the refusal.
Creating an Organization stays with
[`multiple-workspaces.md`](multiple-workspaces.md). A ban does not block
sign-in, end sessions, or take access away; removing a membership is
[`access-revocation.md`](access-revocation.md)'s job.

## Failure modes and limits

- **A ban does not cross deployments.** `users` is one row per deployment and
  the flag is not carried on the platform identity. Global is the only
  configured deployment, so today one row is the whole account.
- **An owner can still be made, just not by creating.** An existing owner can
  add or promote a banned account to owner.
- **Nothing marks an Organization a banned account joins.** Finding them is a
  `search_users` read.
- **A refusal has no log line of its own.** The request log's `request_failed`
  row carries `error_code: account_shadow_banned`.

## Testing

`apps/api/test/shadow-ban.test.ts` runs the trigger and `setUserShadowBan` on
the checked-in migrations. `apps/api/test/regional-workspace-create.test.ts`
covers a banned creator in the app and through the operator's create.

## Changelog

### 2026-11-22 — Shadow bans stop an account creating an Organization, and nothing else

**What changed:** Added `users.shadow_banned_at`, a trigger on `workspaces`
that refuses an Organization a banned account creates, the
`set_user_shadow_ban` operator tool, and the refusal in `createOwnedWorkspace`.

**Why:** The owner asked for a way to mark an account so it can no longer
create Organizations, without telling the account.

**Considered and rejected:** Also refusing a banned account a membership or a
guest relationship. That was built first, as two triggers on
`workspace_members`, and removed before it merged at the owner's request. Also
rejected: a check in the creation service, which covers only the paths
somebody remembered and adds a read to every create; and `RAISE(IGNORE)`,
which skips the row silently and lets the rest of the batch write an owner for
an Organization that does not exist.

**What a future change has to respect:** A ban must not grow a membership
check without a new decision from the owner.
