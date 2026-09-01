# Multiple workspaces per account

> Created 2026-08-31.
>
> One Rally account belongs to several workspaces, moves between them without
> signing out, and can tell which of the ones it is not looking at has something
> waiting. Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Build plan: [`plan.md`](plan.md).
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
4. While online, switching workspaces takes one action, leaves every other
   workspace credential stored and usable, and keeps each workspace's traffic
   inside its own region.
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
   menu-bar count for a background workspace. Deferred. Background attention is
   refreshed on focus and menu-open while its periodic cadence remains unset;
   that is appropriate for a menu hint and wrong for something that interrupts
   somebody.
8. **Joining by email domain, SSO, or one person holding two identity
   providers.** Deferred. Membership still grows only by explicit invitation to
   one address.
9. **Switching workspaces while offline, or an offline workspace-content
   cache.** Deferred. Rally does not persist a workspace directory or transcript
   for offline browsing today; a saved credential and profile can identify a
   workspace but cannot truthfully open its current product state. Going offline
   keeps the active workspace on screen and preserves drafts, but opening another
   workspace waits for a network connection.

## Product behavior

### The mocks, and how much of them to follow

The surfaces below are drawn at
[the workspace-switcher canvas](https://claude.ai/code/artifact/1f202c7b-016f-4c92-85f1-a853ce09b9bc)
— six artboards: the closed account button, the open switcher, a switch in
flight beside a failed one, the loading and offline count states, the invitation
a signed-in person sees, and leaving or closing a workspace.

**Follow the anatomy, not the pixels.** What binds is the composition: which
element sits where in a row, what each row shows and in what order, which states
exist, and the density. What does not bind is the content — the workspace
names, the counts, the initials, and the copy in the dialogs are examples, on the
same footing as the product-specific labels in
[`../../assumptions.md`](../../assumptions.md) item 9.

**Never take a colour or a size out of the mock.** The artboards carry literal
hex because they are drawn outside the app; the renderer names tokens and states
no colour of its own, and a test fails when it does — see
[`../../theming.md`](../../theming.md). Every value in the artboards resolves to
an existing token, and the implementation uses the token:

| In the mock | What to write |
| --- | --- |
| The account button and its menu | The existing `.account-trigger`, `.menu-content`, `.menu-item`, `.menu-label`, and `.menu-separator`. The switcher is rows added to the menu that is already there, not a new surface. |
| Workspace row height, 34px | Slightly taller than `--av-cmp-row-height` because of the 18px mark. One new rule; everything else is `.menu-item`'s own padding and radius. |
| The count pill's colour | `--av-sys-color-workstream-mentioned`, `--av-sys-color-workstream-needs-input`, or `--av-sys-color-workstream-unseen`, picked by the highest-priority reason in that workspace. |
| The activity dot | `--av-sys-color-workstream-unread`, at `--av-cmp-marker-inline-size` and `--av-cmp-marker-radius` — the same dot the sidebar rows already draw. |
| Section captions (`Workspaces`, `Invitations`) | `--av-ref-color-neutral-9` with `--av-sys-label-font-size`, `--av-sys-label-weight`, and `--av-sys-label-tracking` — the sidebar group heading's own treatment. |
| The region tag | `--av-sys-color-surface-subtle` on `--av-sys-color-border-subtle`, pill radius, `--av-sys-font-size-meta`. |
| **Join** in the invitation dialog | `.button-primary`. It is brand, not accent. |
| **Leave** and **Leave and close** | `--av-sys-color-danger-base` and `--av-sys-color-danger-tint`, matching `.menu-item-danger`. |
| Dialog and menu shadows | `--av-sys-elevation-shadow-lg` and `--av-sys-elevation-shadow-md`. |

**One element in the mocks does not exist yet.** The rounded square holding a
workspace's first letter has no counterpart in Rally today — there is no
workspace avatar anywhere in the product. It is drawn because four rows of plain
text are hard to scan, but it is a new piece of vocabulary rather than something
lifted from the app, and it is the one part of these mocks worth arguing about
before it is built.

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

- **One row per workspace** the account belongs to, ordered by this device's
  most-recently-active history, with a check against the active one. A new device
  has no history and uses discovery's stable membership order until the person
  switches. Each row shows the workspace name, its attention count, and — only
  when the account holds workspaces in more than one region — a `Global` or
  `European Union` tag, so the region is visible exactly when it distinguishes two
  rows.
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
and cached profile for that workspace, the switch is immediate: the sidebar, the
transcript, and the right rail redraw against the new workspace, and the workspace
socket for the old one closes. If it does not, the row shows an inline spinner
while the account session activates that workspace, which is the same call the app
already makes on launch, and the window shows *Opening <name>…* over the shell.

Switching never signs anybody out of anything. The sessions for the other
workspaces stay valid and stay stored.

While a switch is in flight the menu stays open and the other rows stay
selectable; choosing a different one supersedes the first switch rather than
queueing behind it. A late successful activation is retained as that background
workspace's credential and profile but never takes over the window; retaining it
also means sign-out still knows which server session to revoke. If activation
fails, the row keeps its place and shows the reason inline — *Rally could not open
this workspace* for a transport failure, and *You are no longer a member of this
workspace* for `workspace_access_denied`, which also removes the row.

Switching while offline is refused before the active workspace is torn down. The
selected row reads *Connect to open this workspace*, the existing active surface
stays in place, and no credential is dropped. A cached profile is enough to name a
workspace while offline; it is not a cache of that workspace's directory or
content (non-goal 9).

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
workspaces*, and recording cannot start while a workspace transition is already
pending — a recording is a live capture bound to one workspace's storage, and
moving it is not a thing that can be made to mean anything.

### What the attention count counts

`GET /workspace/attention`, answered by WorkspaceDO against the session for that
workspace, reports two things about the person holding the session:

- **Waiting for you** — a number. It counts the work streams where the person is
  a participant and any of these holds: a mention of them sits above their read
  waterline, they were put in the work stream and have not opened it once, or the
  work stream's harness has stopped in `needs_input`. The viewer directory row
  already carries all three inputs — personal mention and unseen projections plus
  the shared exact run state — which is what makes this a read rather than a new
  counter.
- **Activity** — a dot, no number, when nothing is addressed to them but at least
  one work stream they can see has unread messages.

A row with neither shows nothing. The active workspace's own row shows no count,
because its sidebar is already on screen saying the same thing in more detail.
The account button itself carries a dot whenever any *other* workspace has a
count, so somebody can tell the menu is worth opening without opening it.

Counts are refreshed for background workspaces when the window regains focus and
when the menu opens. A fixed interval is deliberately not implemented while its
cadence remains `LIMIT UNSET`. Counts are never derived from a socket to a
workspace nobody is looking at.

### The states of the count

- **Empty** — no other workspace has anything: no dot on the account button, no
  numbers in the menu.
- **Loading** — first fetch after launch: rows render with the workspace names and
  no count, never with a zero. A count that has not arrived is not a count of
  nothing.
- **Stale** — a fetch failed or the machine is offline: the last known counts stay
  on the rows, and the menu footer reads *Counts last updated <relative time>*.
  Rows are still selectable; the switch itself will report its own failure.
- **Unauthorized** — the bearer is rejected with `session_revoked`, or renewing
  it answers `workspace_access_denied`, because the membership ended. Either code
  removes that row and only that workspace's credential and profile; raw HTTP
  status is not the contract, because an expired access token is also a 401 and
  must first be renewed. The active workspace learns it was revoked through the
  access-revocation close, drops the same local state, and switches to the most
  recently active remaining workspace.

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

Every create or acceptance carries a client-generated operation id that is both
its telemetry id and its durable idempotency key. The Global coordinator records
the action, its request fingerprint, and its chosen destination before calling a
region. Retrying the same operation after an unknown or lost response returns a
session for that same membership; it never allocates another workspace or consumes
another invitation. Reusing an operation id for a different action or invitation
is a conflict. The existing regional operation journal receives the same id, so
the Global and regional halves agree about which write is being replayed (design
decision 8).

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
that workspace's sessions are made unusable by the membership check and its
sockets are closed by the existing access-revocation path, the credential and
profile for it are dropped from the device, and the switcher moves to the most
recently active remaining workspace. Leaving the last one returns the person to
first-run onboarding, still signed in. The next account discovery marks the
Global route inactive; regional membership is the authority, so a stale route in
the interval cannot activate or authorize anything (design decision 3).

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
it again. One regional transaction sets `abandoned_at`, suspends rather than
deletes the final membership so an operator can reverse the action, and revokes
every pending invitation. The conditional write succeeds only while that person
is still the sole active member; invitation acceptance and member addition reject
an abandoned workspace, so neither can race a new active member in after the
check. The membership transition publishes the ordinary workspace-wide access
revocation, closing sockets on every device, and all authorization and refresh
queries require both an active membership and `abandoned_at IS NULL`. The local
credential and profile are dropped.

The delete request carries the outcome that confirmation described (`leave` or
`abandon`). If membership changed between preview and confirmation, the API
answers `409` instead of silently applying a newly destructive outcome.

The workspace then leaves every switcher, no existing or new session can use it,
and its retained data is unreachable. Reversal is an operator action that clears
`abandoned_at` and reactivates the suspended final membership together. This is
the answer to a workspace created by mistake, and it is the only
destructive-looking action in this change — it destroys nothing.

### Being removed from a workspace

For the workspace on screen, the removal publishes an access revocation, the
sockets close, the credential and profile are dropped, and the app opens the most
recently active remaining workspace or first-run onboarding. For a background
workspace, the next attention request receives `session_revoked`; if the client
tries renewal first, refresh receives `workspace_access_denied`. Either stable
code removes the row and its local state. Nothing announces it — a workspace
somebody was removed from quietly disappearing from a menu is the right amount of
noise.

### Signing out

Sign-out ends local access to every workspace, not only the active one. It
snapshots the stored account and workspace credentials, deletes the complete
local credential/profile sets and drafts, closes authenticated windows, and only
then attempts one remote revocation per captured session at its own endpoint.
Immediate server-side revocation is therefore best effort, as it is today: an
offline request cannot be retried after its only local refresh token is
deliberately erased, and the server session expires on its ordinary deadline.
The hard guarantee is that sign-out leaves no usable local credential or draft
behind before network cleanup starts.

## Impact on the product contract

**Two clauses were checked; neither moves.**

The brief says Rally has no global activity feed and no global inbox. The
attention count is neither: it reports a *number per workspace* and lists no
items, links to no item, and merges nothing across workspaces. Acting on it means
switching to that workspace and using its own sidebar. If a later change makes
those counts expand into a list of the underlying work streams, that *is* a
contract change and belongs in its own conversation.

The brief does not say an account belongs to one workspace — that rule lives only
in the implementation. Three documents state it as current behavior and are
corrected in the same change as the code:
[`../../data-model.md`](../../data-model.md), whose identity section says
`workspace_invitations` "supports explicit membership growth without introducing
a workspace switcher in V1";
[`../../regionalization.md`](../../regionalization.md), whose V1 boundary
describes discovery resolving to a single workspace; and
[`../../assumptions.md`](../../assumptions.md) item 1, which says the prototype
uses one workspace per authenticated user and that "workspace switching is
deferred". The switcher is the thing all three said was not being built.

## Decision log

- **2026-09-01 — Regional user UUIDs are not account identity.** Discovery and
  invitation routing link the same Google account by verified email; Global and
  EU may mint different user UUIDs.
- **2026-09-01 — One setup intent keeps one operation ID.** Identity refresh and
  transport retries reuse the original UUIDv7 so the durable journal, rather
  than a new request, decides replay.
- **2026-09-01 — Departure confirms one named outcome.** The desktop sends
  `leave` or `abandon`; a changed membership shape returns `409` and requires a
  new confirmation.
- **2026-09-01 — Recording and workspace transitions exclude each other in both
  directions.** Main owns the pending transition as well as live capture so the
  losing operation is refused before either authority changes.
- **2026-09-01 — Sign-out is local-first.** Local authority and drafts are erased
  before best-effort remote revocation, so a slow or unreachable region cannot
  prolong access on the device.
- **2026-09-01 — Abandonment is an AutomationAgent operational fence.** Every
  compiler/provider, schedule, provisioning, and outbox lane checks regional D1
  before external work; an already-addressed object cannot outlive the workspace.

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

2. **Workspace recency is device-local; the server stores no default.** Rejected:
   a `default_workspace_id` on `users`. The device keeps an ordered recency entry
   per workspace, not only the last id, so it can order the whole switcher. A new
   device has no local history and starts from discovery's stable order. A
   server-side default is a second thing that can disagree with what the person
   last did on this device.

3. **`platform_workspace_bindings` is a reconciled route registry, not membership
   authority.** It becomes one row per account and workspace route, with
   `pending`, `active`, and `inactive` states, and at most one pending row per
   account. Regional `workspace_members` remains the authority. After both regions
   answer successfully, Global discovery reconciles the active routes against the
   complete membership lists it already receives, marking a missing route
   inactive; a failed or partial discovery changes no route. Activation always
   rechecks regional membership, so a stale active route between reconciliations
   grants nothing.
   Rejected: an EU-to-Global removal message, which adds a cross-region lifecycle
   only to make a cache immediately tidy; deleting the registry, which loses the
   opaque placement route; and keeping a single "current workspace" row that every
   switch has to write.

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
   change puts one click away. Abandonment suspends the final membership and
   fences every authorization path in the same regional transition, rather than
   leaving a reversible row active behind an `abandoned_at` presentation filter.

7. **The user-facing word is "workspace".** Rejected: keeping "organization" in
   onboarding copy while the code, the schema, the API, and Settings all say
   workspace. The renderer mentions *organization* in thirteen places; a
   switcher that says *Switch organization* over a Settings page called
   **Workspace** is worse than renaming them. Ten of the thirteen are visible
   copy; one is the Settings search-terms list, one is a comment, and one is the
   HTML `autocomplete="organization"` token on the name field, which is a browser
   vocabulary word and stays. "Terminal workspace" is a sandbox path with no
   user-facing label, so nothing collides.

8. **Workspace setup is idempotent by the client operation id.** Rejected: using
   the one-pending-binding rule alone. That serializes simultaneous attempts but
   cannot recognize a successful create whose HTTP response was lost; after its
   binding becomes active, a retry would be free to allocate another workspace.
   The Global coordinator durably maps an operation id and request fingerprint to
   one destination before the regional call, and the regional journal uses that
   same id. A retry therefore resumes or returns the first result.

## Data model

Regional D1, changed:

- **`workspaces` gains `abandoned_at TEXT`** — null for every existing row.
  Discovery, activation, invitation acceptance, session refresh, and ordinary
  authenticated requests all require it to be null.
- **`workspace_members` keeps its schema.** Its primary key is already
  `(workspace_id, user_id)`, so it has always described a many-to-many
  relationship, and its existing `suspended` state holds the final member of an
  abandoned workspace so reversal does not have to reconstruct their role.
- **`sessions` is unchanged.** Its `workspace_id` is already nullable, one row per
  session, and multiple live sessions per user are already possible — that is what
  makes two devices work. The identity load and request-authentication joins add
  the workspace lifecycle check above.
- **`workspace_invitations` keeps its schema.** Abandonment writes `revoked_at` on
  every pending row in its transaction.

Global D1, changed:

- **`platform_workspace_bindings`** moves from primary key `platform_user_id` to
  primary key `(platform_user_id, region, workspace_id)`, adds `inactive` to its
  status vocabulary, and has a partial unique index allowing at most one `pending`
  row per `platform_user_id`. Existing rows migrate as active. The table rebuild
  also recreates `platform_workspace_binding_placement_default` against the full
  composite key; its current `WHERE platform_user_id = NEW.platform_user_id`
  would otherwise rewrite every route for a multi-workspace account.
- **`platform_workspace_operations` is new.** One row per client operation id
  records the platform user, `create` or `accept`, a hash of the request fields,
  the chosen region and workspace id, the invitation id when present, and whether
  the operation is pending or complete. It contains opaque ids and a hash, not a
  workspace name or invited address. The first request chooses the destination;
  an exact retry reads it, and a different request under the same id conflicts.

Desktop, changed:

- **The stored credential file** goes from one `storedAuth` record to a versioned
  set: the account credential plus one workspace credential per membership. The
  disposable profile-cache file likewise becomes one profile per credential, and
  device preferences keep a recency value per regional workspace binding plus the
  active binding. A version-1 credential and profile migrate to sets of one; if
  that legacy workspace-only envelope lacks the retained Global identity, one
  Google exchange reconnects it in place. A credential file that cannot be parsed
  signs the person out, which is what it already does; a missing or invalid
  profile drops only that cache entry and is rebuilt by refreshing its credential.

No product-data backfill is needed: every existing account has zero or one
membership and stays exactly as valid. The binding migration marks every existing
row active, the new operation table starts empty, and the desktop wraps its one
credential and profile as one-element sets.

## Regional impact

Nothing new crosses the boundary. Discovery already asks both regional Workers,
over the named RPC bridge, what an identity belongs to, and already returns
memberships and invitations from both — that is the mechanism this change stops
throwing away. What is new is only that the answer may hold more than one entry.

- The switcher may list workspaces in Global and in the European Union at the
  same time. Each row's session, socket, and attention fetch address only that
  workspace's regional API base URL. There is no request that names two regions.
- Attention counts never leave their region (design decision 5).
- The Global route registry keeps what it keeps today per binding: opaque
  workspace id, region, and placement affinity. It gains rows and an inactive
  lifecycle. A regional leave or removal sends no new EU-to-Global message;
  ordinary discovery reconciles the route from the membership answer it already
  receives.
- Workspace setup sends the same opaque operation id over the existing regional
  onboarding RPC. Its request hash remains in Global, and no workspace name or
  invitation address is added to the control-plane operation row.
- Region selection stays per workspace, at creation, and immutable.
- The identity endpoint is still one and still Global.

## Security and trust model

- **A device holds several live credentials instead of one.** In Rally's default
  mode the set uses the existing application-wide-key AES-GCM envelope; Lockdown
  mode instead uses Electron `safeStorage` and binds the whole set to the OS
  keystore. Holding several credentials increases the consequence of disclosure
  in default mode from one workspace session to every workspace session saved on
  that device. That trade is accepted for one-action switching; each credential
  still authorizes exactly one workspace in one region, and the account credential
  authorizes discovery and onboarding only. No refresh token enters the renderer.
- **Lockdown mode and the credential-clearing paths must clear the whole set.**
  Anything that deletes stored credentials today deletes one record; leaving a
  background workspace's credential behind after a lockdown or a sign-out would be
  a silently retained key. This is the failure most likely to be missed, so it is
  named here and in [Acceptance](#acceptance).
- **A background session is a credential for a workspace nobody is watching.**
  Removal stops it resolving immediately because every authorization query joins
  active membership and a non-abandoned workspace. `session_revoked` and
  `workspace_access_denied` are terminal for only that credential; an HTTP status
  alone is not. The existing access-revocation queue closes any socket it holds.
- **Sign-out guarantees local deletion and attempts remote revocation.**
  `AuthService.logout` revokes one session per call, so the desktop snapshots the
  set, erases local credentials and drafts, then calls each captured credential's
  own endpoint. A failed network call is not described as a revoked server
  session: local deletion has already won, and the unreachable server session
  expires normally.
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
- **Order.** Schema first: `abandoned_at`, the rebuilt binding table and corrected
  placement trigger, and the Global setup-operation journal. They are inert until
  the server uses them. Then an additive onboarding response ships with both the
  existing singular `workspace` compatibility field and the new `workspaces`
  list; an older desktop ignores the list and activates the stable first
  membership, while the new desktop uses all of it. Then the idempotent server
  coordinator, leave and atomic abandonment, the removed single-membership
  guards, and discovery reconciliation ship. Then the desktop credential/profile
  sets, which are the riskiest step because they rewrite files that hold the only
  thing standing between a person and signing in again; they ship with version-1
  migrations and no behavior change. Then the switcher behind the flag. Then
  attention counts.
- **Turning it off.** Clearing the flag hides the switcher. An account that
  already holds two memberships keeps them and the new client continues to open
  its device-local active one. An older client receives the singular compatibility
  workspace and remains usable; it does not expose the other memberships. Turning
  the flag off never asks the server to collapse or delete membership.
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
   disappears without a dialog after the `session_revoked`/`workspace_access_denied`
   path, B's next visit is impossible, and the following discovery marks its
   Global route inactive.
5. B leaves workspace 3 as its sole member and confirms **Leave and close** while
   another device holds a live session. Both devices' sockets close, ordinary
   requests and refresh are refused, pending invitations cannot race the close,
   and signing in again does not surface it.
6. A create response is lost after the regional write commits. Retrying with the
   same client operation id returns the same workspace and membership; the
   switcher, Global bindings, and regional operation journal each contain one.
   Reusing that id with a different name, action, or invitation is refused.
7. One account has a Global and an EU binding. Inserting either route leaves the
   other's placement affinity unchanged, and migrating an existing single row
   produces the same two valid routes after the second is added.
8. B signs out online with three workspace credentials plus the account
   credential stored. Every successful logout call revokes its server session,
   and the credential, profile, and draft stores are empty.
9. B signs out with one region unreachable. Local credential, profile, and draft
   stores are still empty; the failed server revocation is reported as cleanup
   failure rather than claimed as complete.
10. Lockdown mode is enabled with three credentials stored. The whole set is
    re-encrypted under `safeStorage`, and disabling Lockdown or clearing credentials
    leaves none behind.
11. The machine goes offline with two workspaces known. Counts hold their last
    value with the *last updated* line, selecting the background workspace reads
    *Connect to open this workspace*, the active workspace stays on screen, and no
    credential is discarded.
12. With the flag off, and separately from an older desktop build, an account with
    two memberships opens one compatible workspace instead of failing onboarding.

Items 1–5 and 8–12 belong in the manual desktop acceptance flows in
[`../../e2e.md`](../../e2e.md), which already covers signup and invitations.
Items 6 and 7 are durable service and migration tests: each must first be proved
red by replaying the request without the operation journal, and by leaving the
placement trigger keyed only to `platform_user_id`, respectively.

## Open questions

- **How often should a background workspace's counts refresh, and how many
  workspaces should one device poll at all?** Both are limits and neither number is
  the author's to pick, per
  [`../../adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).
  Focus and menu-open refreshes ship. The periodic guard and its cadence remain
  `LIMIT UNSET`, so no interval is scheduled until the team chooses the number;
  the same is true of a device polling cap. This no longer blocks the
  attention-count phase.
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
