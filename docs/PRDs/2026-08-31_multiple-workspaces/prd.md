# Multiple workspaces per account

> Created 2026-08-31.
>
> One Rally account belongs to several workspaces, moves between them without
> signing out, and can tell which of the ones it is not looking at has something
> waiting. Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Folder conventions: [`../../prds.md`](../../prds.md).

## Summary

A Rally account belongs to exactly one workspace today, and the binding is
permanent — there is no route that adds a second membership, none that ends one,
and none that removes a workspace. This change makes membership plural. A person
signs in once, sees every workspace they belong to in the account menu at the
foot of the sidebar, and moves between them in one action without signing out of
any of them. They create another workspace while already in one, accept an
invitation to a second workspace from the email link or from inside the app, and
leave a workspace they no longer want.

Each row in that menu says what is waiting there: a count of things addressed to
this person — a mention, a work stream they were put in and have not opened, a
work stream whose agent has stopped and is waiting for input — and a plain dot
for unread activity that is not addressed to them. That count is what makes a
workspace nobody is currently looking at worth keeping open in the app.

Nothing changes for an account with one workspace. It sees the account menu it
sees today, holding one row.

## Motivation

**Every path into a second workspace is refused today, and the refusal is a dead
end.** Six places enforce one workspace per account:

- `PlatformOnboardingService.createWorkspace` refuses with
  `workspace_membership_conflict` when discovery finds any existing membership.
- `PlatformOnboardingService.acceptInvitation` refuses the same way.
- `PlatformOnboardingService.resolveWorkspaceBinding` raises the same conflict
  when discovery returns more than one membership — so if two memberships ever
  did exist, that account could not open Rally at all.
- `RegionalOnboardingService.create` re-checks with `firstMembership`.
- `acceptInvitationForUser` in `workspace-service.ts` re-checks for another
  active membership.
- `platform_workspace_bindings` has `platform_user_id` as its primary key, so
  the Global registry can physically hold only one workspace per account.

There is no exit either. `WorkspaceService.removeMember` refuses self-removal
with `cannot_remove_self`, no route deletes a workspace, and no route changes a
member's role after they join.

What that costs, concretely: an administrator invites somebody who already uses
Rally. The invitation is created, the email sends, the link opens the desktop
app, and the accept call answers 409 with the sentence *"This Avalon account
already belongs to another organization"* — which also puts the internal code
name in front of a customer, against the naming rule in
[`../../rally-rebrand-inventory.md`](../../rally-rebrand-inventory.md). Neither
person has a next step: the invitee cannot join, the invitation sits pending in
the inviter's Settings until it expires seven days later, and nothing in the
product explains why.

The same rule makes trying Rally expensive. Somebody who signs in, creates a
workspace to look around, and is then invited to their company's real workspace
is holding the wrong one permanently — they cannot join the real one, cannot
leave the throwaway, and cannot delete it. The only recovery is a second Google
account.

**No measurement of how often this is hit exists, and none can be produced
here** — the guard means the event never reaches a success path to count. The
argument for doing it now is that the flow is already built and already fails at
its last step: invitations are created, emailed, previewed, deep-linked, and
discovered across both regions, and the only thing missing between that machinery
and a working second membership is the guard and a place to put the result.

## Goals

1. A person belongs to any number of workspaces using one Rally account and one
   sign-in.
2. A member of one workspace creates another without leaving the first, and
   chooses that new workspace's data region independently.
3. A person who is already a member accepts an invitation to a second workspace —
   from the emailed link or from inside the app — and lands in it.
4. Switching workspaces takes one action, leaves every other workspace signed in
   and reachable, and keeps each workspace's traffic inside its own region.
5. Without switching, a person can see which of their other workspaces has
   something waiting for them, and how much.
6. A person leaves a workspace, and it disappears from their switcher for good.
7. A workspace created by mistake can be got rid of by the person who created
   it, so goal 2 does not produce permanent clutter.

## Non-goals

1. **Deleting a workspace and its data.** Deferred. Destroying a workspace means
   D1 cascades plus five Durable Object types plus R2 objects, and nothing today
   walks that tree for deletion. Goal 7 is met by *abandoning* a workspace — it
   leaves every switcher and refuses every new session, and its data stays put
   until a deletion path exists. Abandonment is reversible by an operator; a
   delete is not.
2. **Changing a member's role, or transferring ownership.** Deferred; it does not
   exist today either. The consequence is stated rather than hidden: the sole
   owner of a workspace that has other members cannot leave it, because there is
   nobody to hand it to. See [Open questions](#open-questions).
3. **A separate window per workspace.** Rejected for this change. The desktop has
   one main window plus Settings and meeting windows; a second main window
   multiplies the socket swarm, the menu bar item, and the tray without moving
   any of goals 1–7. Switching happens inside the one window.
4. **Cross-workspace search, a merged sidebar, or a unified inbox.** Rejected
   outright. The product contract has no global inbox and no global search, and
   this change does not open one. The switcher shows *counts per workspace*, never
   items from more than one workspace in one list.
5. **Live sockets for workspaces that are not on screen.** Deferred. The
   WebSocket topology has exactly one WorkspaceDO socket, for the active
   workspace, and that is what keeps it out of the brokered swarm; see
   [`../../websocket-architecture.md`](../../websocket-architecture.md). Background
   attention is a poll (design decision 4).
6. **Moving a workspace between regions, or one workspace spanning both.**
   Rejected outright. A workspace's region is immutable and enforced by the
   `workspaces_region_immutable` trigger. An account may hold workspaces in both
   regions; a workspace still belongs to one.
7. **Notifications outside the app** — a Dock badge, an OS notification, or a
   menu-bar count for a background workspace. Deferred. The poll cadence in
   design decision 4 makes background counts minutes old, which is fine for a
   number sitting in a menu and wrong for something that interrupts somebody.
8. **Joining by email domain, SSO, or one person holding two identity
   providers.** Deferred. Membership still grows only by explicit invitation to
   one address.

## Product behavior

### Signing in for the first time

Unchanged. Google sign-in produces an identity-scoped session at the Global
endpoint, and discovery asks both regions what this email belongs to. With no
membership and no invitation, the person names a workspace and picks its region.
With invitations and no membership, they see them and accept or decline. The one
difference at the end: the account session is **kept** rather than revoked, and
the workspace session is stored beside it (design decision 1).

### The switcher lives in the account menu

The account button at the foot of the sidebar already shows the person's name
over the current workspace name. Its menu gains a workspace list above the
existing label:

- **One row per workspace** the account belongs to, ordered by most recently
  active, with a check against the active one. Each row shows the workspace name,
  its attention count, and — only when the account holds workspaces in more than
  one region — a `Global` or `European Union` tag, so the region is visible exactly
  when it distinguishes two rows.
- **One row per pending invitation** addressed to this person's email, reading
  *Join <workspace name>*, with the inviter's name beneath it. Accepting joins
  and switches; declining removes the row.
- **Create a workspace**, which opens the existing workspace-setup form with the
  region choice, now reachable from inside a signed-in session.
- Then the existing separator, the email/region label for the *active*
  workspace, **Settings…**, and **Sign out**.

With one workspace and no invitations the menu is what it is today: one row, a
label, Settings, Sign out. The list is not a new screen and does not appear in
Settings — Settings is scoped to the active workspace and stays that way.

### Switching

Selecting another row switches to it. If the device already holds a live session
for that workspace, the switch is immediate: the sidebar, the transcript, and the
right rail redraw against the new workspace, and the workspace socket for the old
one closes. If it does not, the row shows an inline spinner while the account
session activates that workspace, which is the same call the app already makes on
launch, and the window shows *Opening <name>…* over the shell.

Switching never signs anybody out of anything. The sessions for the other
workspaces stay valid and stay stored.

While a switch is in flight the menu stays open and the other rows stay
selectable; choosing a different one abandons the first switch rather than
queueing behind it. If activation fails, the row keeps its place and shows the
reason inline — *Rally could not open this workspace* for a transport failure,
and *You are no longer a member of this workspace* for a 403, which also removes
the row.

Unsent composer text survives the switch. It does not today: any session change
that names a different workspace calls `clearAllDrafts`, which empties the whole
IndexedDB draft store rather than the part belonging to the workspace being left.
That is correct while a switch can only mean a different account or a
sign-out — and wrong the moment switching is a thing people do several times an
hour. Draft keys therefore carry the workspace, and leaving a workspace clears
only its own drafts.

The menu bar item, the Settings window, and any open meeting window follow the
active workspace. A meeting window recording against the workspace being left
blocks the switch with *Finish or stop the recording before switching
workspaces* — a recording is a live capture bound to one workspace's storage, and
moving it is not a thing that can be made to mean anything.

### What the attention count counts

`GET /workspace/attention`, answered by WorkspaceDO against the session for that
workspace, reports two things about the person holding the session:

- **Waiting for you** — a number. It counts the work streams where the person is
  a participant and any of these holds: a mention of them sits above their read
  waterline, they were put in the work stream and have not opened it once, or the
  work stream's harness has stopped in `needs_input`. All three already exist as
  per-viewer projections in WorkspaceDO's directory, which is what makes this a
  read rather than a new counter.
- **Activity** — a dot, no number, when nothing is addressed to them but at least
  one work stream they can see has unread messages.

A row with neither shows nothing. The active workspace's own row shows no count,
because its sidebar is already on screen saying the same thing in more detail.
The account button itself carries a dot whenever any *other* workspace has a
count, so somebody can tell the menu is worth opening without opening it.

Counts are refreshed for background workspaces on a fixed interval, when the
window regains focus, and when the menu opens. They are never derived from a
socket to a workspace nobody is looking at.

### The states of the count

- **Empty** — no other workspace has anything: no dot on the account button, no
  numbers in the menu.
- **Loading** — first fetch after launch: rows render with the workspace names and
  no count, never with a zero. A count that has not arrived is not a count of
  nothing.
- **Stale** — a fetch failed or the machine is offline: the last known counts stay
  on the rows, and the menu footer reads *Counts last updated <relative time>*.
  Rows are still selectable; the switch itself will report its own failure.
- **Unauthorized** — the fetch answers 403 because the membership ended: the row
  disappears and its credential is dropped. This only ever applies to a
  background workspace; the active one learns it was revoked through the access
  revocation that closes its sockets, which is unchanged.

### Creating another workspace

**Create a workspace** opens the same form first-run uses: a name, and Global or
European Union, with the standing note that the region cannot be changed later. On
success, the new workspace is created with the person as its owner, the switcher
moves to it, and the app opens the empty-workspace sidebar it opens for any new
workspace.

Only one workspace creation or invitation acceptance may be in flight for an
account at a time. A second attempt while one is running answers *Workspace setup
is already in progress* rather than creating two workspaces, which is what the
account's pending onboarding reservation already means today.

### Inviting, unchanged

Owners and admins invite by email from Settings → Workspace; only an owner may
invite an admin; links expire after seven days and are single-use and bound to
the address they were sent to. Nothing in that flow changes, and one thing stops
failing: an invitation to somebody who already has a Rally account now works.

The invitation copy stops saying *organization* and says *workspace* (design
decision 7).

### Accepting an invitation

**From the emailed link, signed in.** The link opens the invite page, which
hands the desktop a `rallywithai://invitations/accept` deep link. Today that sets
a pending invitation which only the first-run onboarding gate reads, so a
signed-in person's click does nothing visible. It now surfaces wherever they are:
a modal naming the workspace, who invited them, and the role, with **Join** and
**Not now**. Joining switches to the new workspace; **Not now** leaves the
invitation pending and puts it in the account menu.

**From the account menu.** Pending invitations discovered for this email appear
as rows, from both regions. Accept and decline behave as they do on first run.

**Failures.** An invitation that was revoked, expired, or already used answers
*This invitation is invalid, expired, or no longer available* and drops out of
the list on the next refresh. An invitation addressed to a different email
answers *Sign in with <address> to accept this invitation* — the existing
behavior, and still correct: invitations are bound to an address, not to a person.

### Leaving a workspace

Settings → Workspace gains **Leave this workspace**, at the bottom, under a
confirmation naming the workspace. On confirmation the membership row is deleted,
that workspace's session is revoked and its sockets are closed by the existing
access-revocation path, the credential for it is dropped from the device, and the
switcher moves to the most recently active remaining workspace. Leaving the last
one returns the person to first-run onboarding, still signed in.

Two refusals:

- **An owner who is the only owner and has other members** cannot leave: *You are
  the only owner of this workspace. Another owner has to exist before you can
  leave.* Non-goal 2 says why that is currently unresolvable, and
  [Open questions](#open-questions) carries it.
- **Anyone whose leaving would empty the workspace** is instead offered
  abandonment, below.

### Abandoning a workspace

When the person leaving is the only active member, the confirmation reads
**Leave and close this workspace** and explains that nobody will be able to open
it again. On confirmation the workspace is marked abandoned: it leaves every
switcher, no session can be activated against it, its pending invitations are
void, and its data is retained and unreachable. This is the answer to a workspace
created by mistake, and it is the only destructive-looking action in this change —
it destroys nothing.

### Being removed from a workspace

Unchanged for the workspace on screen: the removal publishes an access
revocation, the sockets close, and the app returns to whatever it shows when a
session stops resolving. New behavior for a background workspace: the next
attention fetch answers 403, the row leaves the switcher, and its stored
credential is dropped. Nothing announces it — a workspace somebody was removed
from quietly disappearing from a menu is the right amount of noise.

### Signing out

Sign-out ends every session on the device, not the active one: one revocation per
stored credential, plus the account session, then the stored credentials are
deleted. A revocation that fails to reach the server still deletes the local
credential, because a device that cannot reach Rally must not be left holding
usable ones.

## Impact on the product contract

**Two clauses were checked; neither moves.**

The brief says Rally has no global activity feed and no global inbox. The
attention count is neither: it reports a *number per workspace* and lists no
items, links to no item, and merges nothing across workspaces. Acting on it means
switching to that workspace and using its own sidebar. If a later change makes
those counts expand into a list of the underlying work streams, that *is* a
contract change and belongs in its own conversation.

The brief does not say an account belongs to one workspace — that rule lives only
in the implementation. Two subsystem documents state it as current behavior and
are corrected in the same change as the code:
[`../../data-model.md`](../../data-model.md), whose identity section says
`workspace_invitations` "supports explicit membership growth without introducing
a workspace switcher in V1", and
[`../../regionalization.md`](../../regionalization.md), whose V1 boundary
describes discovery resolving to a single workspace. The switcher is the thing
both sentences said was not being built.

## Decision log

None yet.

## Key design decisions

1. **The device holds one account session plus one session per workspace.**
   Rejected: a single session re-bound to a different workspace on each switch.
   Sessions are regional — an EU session talks to `eu.api.rallywith.ai` and cannot
   reach the Global control plane at all, and `PlatformOnboardingService` refuses
   any caller whose region is not `global`. A single re-bound session therefore
   could not switch *out* of an EU workspace without a fresh sign-in. Keeping the
   identity-scoped account session is also the smaller trust surface: it can read
   discovery and nothing else, which is already true of it today for the minutes it
   currently lives.

2. **The device remembers which workspace was last active; the server does not.**
   Rejected: a `default_workspace_id` on `users`. The device already stores the
   selected region and workspace name in device preferences, a new device picking
   the most recently active workspace from discovery is good enough, and a
   server-side default is a second thing that can disagree with what the person
   last did.

3. **`platform_workspace_bindings` becomes one row per membership, and an account
   may have at most one pending binding.** Rejected: deleting the table, which is
   the Global registry's only record of which region an account's workspaces live
   in and holds the opaque placement route; and rejected: keeping the single row
   as "current workspace" with a second table for the set, which would make the
   current row a thing every switch has to write. The single-pending rule preserves
   what the primary key was doing that is still wanted — one setup at a time —
   while allowing many completed bindings.

4. **Background attention is polled; only the active workspace holds a socket.**
   Rejected: a WorkspaceDO socket per workspace. Exactly one WorkspaceDO socket is
   what keeps it in Chromium and out of the brokered swarm, and a socket per
   workspace wakes a Durable Object per workspace for a number nobody is looking
   at. A poll is also the option that is cheapest to reverse: if the counts turn
   out to need to be live, the socket can be added later without unwinding
   anything.

5. **Each workspace's counts are answered by its own region.** Rejected: one
   Global endpoint that aggregates both regions. A count of an EU workspace's
   unread work streams is EU workspace data about an EU member; assembling it in
   Global would put it on the wrong side of the boundary for a menu label. The
   desktop already holds a session per region it has a workspace in, so it asks
   each region for its own.

6. **A workspace is abandoned rather than deleted.** Rejected: building deletion
   now (non-goal 1), and rejected: no exit at all, which would make "create a
   workspace" a decision nobody can undo — a bad property for an action this
   change puts one click away.

7. **The user-facing word is "workspace".** Rejected: keeping "organization" in
   onboarding copy while the code, the schema, the API, and Settings all say
   workspace. The renderer mentions *organization* in thirteen places; a
   switcher that says *Switch organization* over a Settings page called
   **Workspace** is worse than renaming them. Ten of the thirteen are visible
   copy; one is the Settings search-terms list, one is a comment, and one is the
   HTML `autocomplete="organization"` token on the name field, which is a browser
   vocabulary word and stays. "Terminal workspace" is a sandbox path with no
   user-facing label, so nothing collides.

## Data model

Regional D1, changed:

- **`workspaces` gains `abandoned_at TEXT`** — null for every existing row.
  Discovery, activation, and invitation acceptance all exclude non-null rows.
- **`workspace_members` is unchanged.** Its primary key is already
  `(workspace_id, user_id)`, so it has always described a many-to-many
  relationship; only the guards above it made membership singular. This is most of
  why the change is small.
- **`sessions` is unchanged.** Its `workspace_id` is already nullable, one row per
  session, and multiple live sessions per user are already possible — that is what
  makes two devices work.
- **`workspace_invitations` is unchanged.**

Global D1, changed:

- **`platform_workspace_bindings`** moves from primary key `platform_user_id` to
  primary key `(platform_user_id, region, workspace_id)`, with a partial unique
  index allowing at most one `pending` row per `platform_user_id`. Existing rows
  migrate as-is.

Desktop, changed:

- **The stored credential file** goes from one `storedAuth` record to a versioned
  set: the account credential, plus one workspace credential per membership, plus
  the id of the last active one. A version-1 file migrates to a set of one. A file
  that cannot be parsed signs the person out, which is what it already does.

No backfill is needed anywhere: every existing account has zero or one membership
and stays exactly as valid.

## Regional impact

Nothing new crosses the boundary. Discovery already asks both regional Workers,
over the named RPC bridge, what an identity belongs to, and already returns
memberships and invitations from both — that is the mechanism this change stops
throwing away. What is new is only that the answer may hold more than one entry.

- The switcher may list workspaces in Global and in the European Union at the
  same time. Each row's session, socket, and attention fetch address only that
  workspace's regional API base URL. There is no request that names two regions.
- Attention counts never leave their region (design decision 5).
- The Global registry keeps what it keeps today per binding: opaque workspace id,
  region, and placement affinity. It gains rows, not fields.
- Region selection stays per workspace, at creation, and immutable.
- The identity endpoint is still one and still Global.

## Security and trust model

- **A device holds several live credentials instead of one.** They are stored in
  the same encrypted file under the same `safeStorage` protection, and each one
  authorizes exactly one workspace in one region. The account credential
  authorizes discovery and onboarding only — it cannot read workspace data,
  because the workspace-scoped routes require a workspace-bound session.
- **Lockdown mode and the credential-clearing paths must clear the whole set.**
  Anything that deletes stored credentials today deletes one record; leaving a
  background workspace's credential behind after a lockdown or a sign-out would be
  a silently retained key. This is the failure most likely to be missed, so it is
  named here and in [Acceptance](#acceptance).
- **A background session is a credential for a workspace nobody is watching.**
  Removal from that workspace stops it resolving immediately — every authorization
  query joins membership, so the row disappearing is the revocation — and the
  existing access-revocation queue closes any socket it still holds.
- **Sign-out revokes every session.** `AuthService.logout` revokes one session per
  call, so signing out issues one call per stored credential, to each credential's
  own region.
- **Nothing gains cross-workspace authority.** No route accepts two workspace ids,
  no object is addressed from another workspace's session, and the workspace
  membership route keeps its existing check that the path's workspace is the one
  the caller is authenticated for.

## Rollout

- **Flag:** `multiple-workspaces-enabled` (boolean, default `false`), served
  through `GET /feature-flags` as `multipleWorkspacesEnabled`, following the
  `Enabled` naming rule in [`../../feature-flags.md`](../../feature-flags.md). Like
  the other managed product Booleans it is presentation-only: it decides whether
  the desktop offers the switcher, **Create a workspace**, and in-app invitation
  acceptance. It is not an authorization gate, and the API accepts a second
  membership whether or not it is on.
- **Order.** Schema first (`abandoned_at`, the binding key change) — both are
  inert on their own. Then the server guards: removing the five code refusals,
  adding leave and abandon, and stopping discovery from hiding invitations once a
  membership exists. Then the desktop credential set, which is the riskiest step
  because it rewrites a file that holds the only thing standing between a person
  and signing in again; it ships with the migration from version 1 and no
  behavior change. Then the switcher behind the flag. Then attention counts.
- **Turning it off.** Clearing the flag hides the switcher. An account that
  already holds two memberships keeps them and continues to open the most recently
  active one — the client falls back to activating one workspace, which is what it
  does today.
- **Documentation.** Nothing in `docs/` owns switching, the credential set, or
  cross-workspace attention, so this ships with a new module document —
  `docs/multiple-workspaces.md`, written to
  [`../../module-documents.md`](../../module-documents.md) and registered in
  [`../../README.md`](../../README.md). Four existing documents change in the same
  commits as the code they describe:
  [`../../data-model.md`](../../data-model.md) and
  [`../../regionalization.md`](../../regionalization.md) for the sentences quoted
  above, [`../../access-revocation.md`](../../access-revocation.md) for its fourth
  producer (leaving a workspace), and
  [`../../websocket-architecture.md`](../../websocket-architecture.md) for the
  restatement of its one-WorkspaceDO-socket rule as one socket for the *active*
  workspace.

## Acceptance

Walk these in a real window, per the repository's rule on visible changes:

1. Two accounts, one workspace each. A invites B; B accepts from the emailed link
   while signed in; B ends in two workspaces and can switch between them.
2. B creates a third workspace in the other region from the account menu, and
   switches Global → European Union → Global. The sidebar redraws each time, and
   no work-stream or workspace-product request addresses the region just left —
   the only traffic to it is that workspace's own attention fetch.
3. B has an unread mention in workspace 1 while looking at workspace 2. The
   account button shows a dot and workspace 1's row shows `1`. Opening it clears
   both.
4. A removes B from workspace 1 while B is in workspace 2. Workspace 1's row
   disappears without a dialog, and B's next visit to it is impossible.
5. B leaves workspace 3 (sole member) and confirms **Leave and close**. It is gone
   from the switcher, and signing in again does not surface it.
6. B signs out with three credentials stored. Every session is revoked
   server-side, and the stored file holds nothing.
7. Lockdown mode is enabled with three credentials stored. All three are cleared.
8. The machine goes offline with two workspaces open. Counts hold their last value
   with the *last updated* line, and switching to a cached workspace still works
   until its access token expires.

Items 1–5 belong in the manual desktop acceptance flows in
[`../../e2e.md`](../../e2e.md), which already covers signup and invitations.

## Open questions

- **How often should a background workspace's counts refresh, and how many
  workspaces should one device poll at all?** Both are limits and neither number is
  the author's to pick, per
  [`../../adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).
  The behavior is written so the guard exists with the number left open: a fixed
  interval, plus focus, plus menu-open. Blocks the attention-count phase, not the
  switcher.
- **What does the sole owner of a populated workspace do?** They cannot leave
  (non-goal 2) and cannot promote anyone. Either ownership transfer comes into
  scope, or the refusal ships and the answer is "ask another member to be made an
  owner by support". This does not block the rest.
- **Should an unanswered elicitation count separately from a `needs_input`
  harness?** The count uses the harness state because it is already in the
  workspace directory; a per-viewer elicitation projection does not exist at
  workspace level and would be new work. If they differ often enough to matter,
  that is a follow-up.
- **Is there a cap on how many workspaces one account may create?** None is
  proposed. If one is wanted it is a number for the team, and it belongs on
  creation rather than on membership — being invited to many workspaces is somebody
  else's decision, not a resource this account spends.
