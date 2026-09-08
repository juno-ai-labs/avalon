# Multiple workspaces

One Rally account can belong to workspaces in either data region while each
workspace remains a separate regional authority. The desktop keeps a narrow
Global identity session for discovery plus one regional credential and cached
profile per activated workspace. Exactly one workspace is active on a device;
the account menu changes that selection without merging workspace content.

Read this before changing plural onboarding, stored desktop sessions, workspace
switching, background attention, leaving, or abandonment.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/0098_multiple_workspaces.sql` | Plural Global route bindings, regional abandonment, and the replay journal for setup operations. |
| `apps/api/src/services/platform-onboarding-service.ts` | Cross-region discovery, activation, create/accept coordination, and operation replay. |
| `apps/api/src/services/workspace-service.ts` | Ordinary self-leave, sole-owner refusal, and atomic final-member abandonment. |
| `apps/api/src/services/workspace-attention-service.ts`, `durable-objects/workspace-do.ts` | The regional attention read and WorkspaceDO projection. |
| `apps/desktop/src/main/stored-auth.ts`, `index.ts` | Versioned credential/profile sets, device-local recency, exact-credential refresh and removal, activation races, and complete sign-out. |
| `apps/desktop/src/main/workspace-selection.ts`, `workspace-activation.ts` | The local claim that answers a link to the active workspace, and the platform activation every other addressed link takes. |
| `apps/desktop/src/main/credential-refresh.ts` | One rotation per refresh token: every path that renews a stored credential shares an in-flight refresh of the same token. |
| `apps/desktop/src/main/workspace-directory.ts` | The account menu's directory: the stored set merged with discovery, and the reconciliation that retires a membership a complete discovery no longer lists. |
| `apps/desktop/src/renderer/components/workspace-account-menu.tsx`, `app-shell.tsx` | Flagged switcher, invitations, attention states, switching presentation, and creation in the legacy component variant. |
| `apps/desktop/src/renderer/lib/draft-keys.ts`, `draft-cache.ts`, `app-session.tsx` | Workspace-scoped composer drafts and exact cleanup when one membership ends. |

## How it works

New-user learning and account appearance are described in
[new-user onboarding](new-user-onboarding.md). The identity bridge carries that
narrow revisioned profile into each region; workspace content remains regional.

### Authority and data flow

Google sign-in produces an identity-only session at the Global endpoint. Global
discovery asks each regional Worker for memberships and pending invitations,
then reconciles opaque `(platform_user_id, region, workspace_id)` routes. A
workspace session is minted only by its owning region and authorizes only that
workspace. The identity credential remains stored because an EU workspace
session cannot call the Global onboarding coordinator.

The desktop stores one version-2 auth set and one matching profile set. Each
workspace credential carries its immutable region; the active-workspace binding
and every ordered-recency entry are `(region, workspace_id)` pairs in
device-local presentation state. The pair matters even when UUIDs happen to
collide across regions: credential replacement, profile lookup, attention,
departure, React keys, and the meeting guard all use the complete binding.
Selecting a cached workspace rewrites only that active selection. A network
activation may finish after another selection; its credential and profile are
retained, but an intent generation prevents the late response from taking over
the window.

Regional user IDs are regional identifiers, not account identifiers: the same
Google account may have different user UUIDs in Global and EU. The verified
email in the Global identity session links discovery to the regional account.
An older version-1 workspace-only envelope can be reconnected in place after one
Google exchange, preserving its selected workspace rather than forcing setup.

### Credential renewal

Access tokens live fifteen minutes; refresh tokens rotate on every renewal and
the API honours the token it just retired for sixty seconds more, so a device
whose rotation response was lost can present the old one again. That grace
makes a *concurrent* pair of renewals with the same token succeed twice, each
rotating, and the answer that reaches the desktop first is the one persisted.
The device is then holding a token the service accepts only until the grace
ends; the next renewal is a 401, which is terminal, and the credential is
surrendered. For the identity credential that means the next switch or
creation first sends the person through a browser sign-in, and every
discovered-only workspace gone from the menu until it has.

Every renewal therefore goes through `credential-refresh.ts`: two requests
that found the same access token expired share one rotation and persist the
same result, whether they arrived through discovery, activation, a background
attention read, a departure, or the renderer's own refresh of the active
session. An identity request whose presented credential has already been
replaced adopts the stored one rather than rotating a token the service has
retired, and refreshes it only if it has itself expired.

A renewal rewrites both stored files by merging the renewed session into the
sets on disk, never into whatever this process happens to have read so far.
The credential file is the durable boundary and the profile file beside it a
cache; a credential whose profile is missing is rebuilt by refreshing it,
which is how the identity session recovers as well as a workspace's.

A session's life slides with use. Each renewal moves `expires_at` to thirty
days from that moment, so a person who opens Rally at least once a month is
never signed out by expiry alone, and a session that stops being renewed dies
thirty days after its last renewal. The ceiling is absolute: ninety days from
the session's creation a fresh sign-in is required whatever happened in
between, and a renewal past that ceiling is refused rather than handed a
token the bearer check would reject. The identity credential minted at
sign-in and every workspace credential minted at activation follow the same
rule, so a sign-in on the way into another workspace is expected after ninety
days, or after a month away, and at no other time short of a sign-out or a
revocation.

### The account menu's directory

The menu lists the union of what this device has stored and what Global
discovery answers, in device recency order. Discovery withholds two things the
member belongs to: the demo template, always, and a demo workspace still being
prepared, until it is published — and activation answers
`demo_workspace_preparing` for the latter. Both are decided in the regional
API from the demo operation rows
([`demo-workspaces.md`](demo-workspaces.md#withholding-a-workspace-from-its-own-member)). Discovery is the account's
complete membership and needs the identity credential; the stored set is one
regional credential and cached profile per workspace this device has opened,
readable with no network at all. `getOnboardingState` never rejects on
discovery's account. It reports `identity` as `connected`, `reconnect_required`
(no identity credential is stored), or `unavailable` (discovery failed for
another reason), and lists the stored set either way, merged with the last
discovery this run received so a blip does not shrink the list. The menu
never marks a row on that state and offers no reconnect item of its own: a
switch or a creation that needs the identity credential restores it itself
(see [Switching](#switching)), and `reconnect_required` is read only by the
no-workspace gate, which has nothing to switch to. The caption under the
account's email names the active workspace's data region as US or EU — the
two regions that exist; "Global" was the name of the US one.

A background row's trailing indicator is one green dot, shown when the
WorkspaceDO attention read reports any activity — work streams waiting on the
person or merely something new since they last looked — and nothing
otherwise. The detail the read carries (how many are waiting and the
strongest reason among them, in the order WorkspaceDO ranks them) is kept
for the dot's tooltip and the row's accessible name rather than drawn as a
count.

### Switching

Choosing a workspace is a dissolve, not a cut. While the new credential is
minted the current panes dim in place and the menu row shows its spinner; the
menu stays open so a failure lands under the row the person chose, and closes
itself once the switch took. `activateWorkspace` fetches the new workspace's
record with the new credential before the old workspace is torn down and
seeds it into the cleared cache the moment the session changes, so the shell
never shows a bare "Opening workspace…" between the two; the same panes then
fade back up over the unchanged backdrop showing the new workspace. The
feature flags ride across the same way, stamped stale, so the account menu
keeps its shape until the new workspace's own answer arrives.

A switch that changed the workspace always lands on the new work-stream page.
A work stream open in the previous workspace must never be looked up in the
next one, which is what the route would otherwise do; only an addressed link
opens a specific destination, and it resets the route itself.

A switch or a creation that finds no identity credential on this device signs
the account in on the spot rather than failing. Main answers such a request
with `account_reconnect_required`, a coded failure that crosses the bridge
unchanged where anything else becomes an outage, and `withAccountIdentity` in
`app-session.tsx` opens the browser for the sign-in, tells the row or dialog
that started it — which keeps its spinner with "Finish signing in to Rally in
your browser" beneath — and runs the same request again once the callback has
been exchanged for the credential. The waiter is keyed by the attempt main
minted: choosing the row again starts a newer attempt, main honours only
that one from then on, and the earlier waiter stands down the moment the
newer attempt exists — before its browser opens, so a launch that fails
leaves nothing parked. A callback from a superseded attempt is stale and
settles nothing; one that reports failure lands as the row's error, and so
does a sign-in that never reached the browser ("Rally could not open the
sign-in page"). The create dialog can be left or resubmitted while it
waits; leaving it abandons the creation and not the sign-in, which restores
the credential all the same if it lands. The startup activation of a
discovered workspace and an addressed link into another workspace take the
same path; the opening state says where the person is expected, and a link
relies on the browser showing Rally's sign-in page, because the only
surface a link has is the notice window, whose title reads as a failure and
which the main window cannot take down once the link has opened. A link
waits for its sign-in outside the deep-link queue, which the sign-in's own
callback must be free to come through. A renewal of the identity
credential that the service refuses for good — the surrender in
[Credential renewal](#credential-renewal) — answers the request that needed
it with the same code, so the click that discovered the credential was dead
is the click that signs in, not the one after. The exchange also invalidates
the menu's directory query the moment it lands, so nothing the renderer holds
about the account outlives the sign-in that changed it. There is no timeout
on the wait: that would be a limit with a number nobody has chosen, and the
row stays chosen and choosable instead.

A discovery that succeeds is complete (a regional outage is a 503, never a
shorter list), so a stored background workspace it does not list is a
membership that has ended: removed by an owner, left from another device, or
abandoned. Its credential and profile are removed then. Two are spared: the
active workspace, whose revocation the socket path owns, and anything written
after the discovery request began, because a workspace created or activated
while the request was in flight is exactly what an answer started earlier
fails to list.

The renderer mounts one WorkspaceDO socket for the active workspace. Background
workspaces get no sockets and expose no items across the boundary. Their stored
credential may call `GET /workspace/attention`, which returns only an addressed
count, its highest-priority reason, and an unread-activity boolean. Focus and
account-menu opening refresh the projection. The fixed periodic cadence and any
device workspace cap remain `LIMIT UNSET`; do not invent either number. There is
currently no periodic refresh: focus and menu opening are the only refresh
triggers until the team chooses a cadence.

### Workspace-addressed handoffs

Every newly emitted external destination for workspace content or settings
carries `(region, workspace_id)`. It is a routing coordinate, not a capability.
The native shape is
`rallywithai://workspace/<region>/<workspace-id>/<destination-host>/<destination-path>`.
Its distinct host makes a desktop build from before this contract reject the
link; a query-addressed shape is forbidden because an older work-stream parser
would ignore those coordinates and open relative to the active workspace.

When a person opens one, the desktop first asks main whether the target is the
active workspace. If it is, main answers with the session already in use and
takes a selection intent, and the destination applies at once with no request
and no cache reset. Otherwise the desktop asks main to revalidate the exact
target through Global discovery and regional activation, verifies the returned
binding, clears the previous workspace cache, and only then applies the
resource, connector result, Slack identity challenge, settings section, or
automation route.

An explicit handoff is allowed to change the foreground workspace because the
person followed a destination. Background attention and reconciliation never do.
For a handoff into another workspace, if the meeting guard refuses the change,
the credential is missing, or regional membership has been revoked, activation
fails closed: the current workspace and route remain unchanged and the deep-link
failure window explains that the target could not be accessed. A handoff into
the active workspace whose membership has ended is refused by the regional API
on its first read, as any other request under that credential would be. The target pair never substitutes for the regional API's
membership check. The regional denial text includes “access is unavailable,” so
the desktop classifies that exact denial before its broader transient-outage
wording and does not tell a revoked member to check their connection.

Settings opens in a separate window. When an addressed Settings, connector, or
Slack handoff changes workspaces, the main window behind it moves to that
workspace's new-work-stream landing page; closing Settings can therefore never
reveal a resource route retained from the previous workspace. A handoff to the
already-active workspace preserves the main window's route.

An addressed link's target is routing, not authority. A link to the active
workspace is answered by main through `workspace:reselect-active`, which returns
the session in use and takes a selection intent so a late network activation
cannot take over the window; the regional API re-checks membership on each
request that credential makes, which is the same check a fresh activation would
have minted a credential for. A link to any other workspace, including one this
device holds a credential for, goes through platform activation, because a
membership that ended leaves its session row alive and only the platform
refuses the link before the window moves. That path can start from an
identity-only session because the platform identity, not a current regional
workspace, authorizes discovery. Delivery is serialized across main's cold-start
queue and live operating-system callbacks, so two links cannot finish in the
opposite order. A target API also owns normal credential renewal; an access
token expiring between activation and a Slack or connector request does not
change the workspace binding.

Addressed connector results are delivered only to the main renderer, which owns
the serialized activation and then opens Connections. Legacy unaddressed results
also reach an already-open Settings renderer to preserve its active-relative
cache refresh; treating a path-addressed result as legacy would run the same
activation concurrently in both renderer processes.

Each delivered item catches and reports its own terminal window or bridge
failure before the serialization tail resolves. A Settings-window failure,
cancel cleanup failure, or other escaped action therefore cannot poison the
promise tail and silently suppress all later operating-system links.

ID-only links already in mail, Slack history, and older clients remain readable
against the active workspace. They are compatibility inputs only; searching
every credential for a matching resource would create a cross-workspace directory
and is deliberately not done.

### Membership lifecycle

`DELETE /workspaces/:workspaceId/membership` acts only on the caller. A sole
owner cannot leave other active members without an owner. When the caller is the
last active member, one regional transaction sets `abandoned_at`, suspends that
membership, and revokes pending invitations, conditional on the workspace still
being empty apart from the caller. The confirmation carries the outcome the
desktop presented (`leave` or `abandon`); if membership changed before the
delete, the API returns `409` instead of applying a newly destructive outcome.
All admission and refresh paths join `abandoned_at IS NULL`, and the ordinary
access-revocation producer closes every socket the membership held.

An automation's runs are conversations under its `AutomationDO`, and their
loops re-check the execution principal's membership before every provider
write; a run whose principal lost the workspace stops there. The automation
object itself reads no workspace lifecycle before its alarms fire, so a
schedule of an abandoned workspace still admits an occurrence and provisions a
run whose loop then refuses to act.

After a successful leave, Electron removes only that workspace's credential,
profile, and drafts, then selects the most recent surviving workspace. With none
left, the retained identity session returns the renderer to workspace setup.
When the active credential is revoked, the desktop removes exactly that
regional credential/profile and its drafts, then makes the same surviving
selection. Sign-out is different: it deletes the complete local set and drafts
first, closes the authenticated windows, then attempts server logout for the
identity and every captured workspace credential. A failed regional request is
reported but cannot restore local authority.

### Desktop behavior

The bottom-bar account popup shows Settings, the enabled workspace and invitation
rows, and Log out last, separated by a divider above it. It omits About, Help
Center, Send Feedback, workspace creation, and a trailing divider. The shipped
shell always selects this compact presentation: existing members have no
in-session workspace-creation entry point. Initial workspace setup remains in
onboarding. The legacy component variant retains creation code and tests, but
it is not a reachable product surface. Overflowing menus scroll within the
available window height so Settings and Log out remain reachable.

`multiple-workspaces-enabled` controls presentation only. When off, the account
menu shows Settings, one divider, and Log out; plural membership, credential
storage, lifecycle fences, and singular onboarding compatibility remain active.
When on, rows follow device recency, show a region tag only across mixed regions,
and keep the menu open while a switch is pending. Offline selection is refused
before the current workspace is disturbed.

A meeting window registers live capture with Electron main before recording
starts. Switching, creating, accepting, or leaving the active workspace is
refused until that capture stops, and recording cannot start while any of those
workspace transitions is pending. This bidirectional guard is main-owned because
Settings, meeting, and the main window are separate renderers following one
active workspace.

## Invariants

- A regional workspace credential never becomes a Global discovery credential.
- A workspace ID is never used to infer region; the reconciled route and stored
  binding carry it.
- The flag hides affordances but grants and revokes no authority.
- Background workspaces expose aggregate attention only, never directory rows or
  content, and open no sockets.
- A late activation may be retained but cannot replace a newer selection.
- An addressed link into a workspace that is not active always revalidates
  membership through platform activation; a locally stored credential is never
  enough to switch on. A link into the active workspace opens with the
  credential in use, which the regional API re-checks on every request.
- A stored workspace stays on the account menu whether or not discovery can be
  reached. Only a complete discovery that no longer lists it, a departure, a
  revocation of its credential, or sign-out removes it. A complete discovery
  omits the demo template and an unpublished demo candidate on purpose, so a
  device that opened either while it was reachable reconciles its stored
  credential away on the next complete answer; that is the withholding working
  as designed, not a lost membership.
- This device rotates one refresh token at most once at a time.
- Leaving one workspace cannot delete another workspace's credential, profile,
  query state, or draft.
- Abandonment retains data and is reversible only by a paired operator action;
  it is not deletion.
- Defensive polling cadence and device-count limits stay open until the team
  chooses their values.

## Boundary

Global owns Google identity, discovery, invitation routing, and setup replay.
Each regional Worker owns its workspace sessions, membership lifecycle, product
objects, and attention projection. Electron owns only encrypted credentials,
cached profiles, drafts, the active selection, and recency for one device. It
never turns aggregate attention into a content cache, and background workspaces
never acquire a product WebSocket.

## Failure modes and limits

- A regional activation or attention request that proves the credential unusable
  removes that exact workspace entry; ordinary transport failures retain it.
- Failed attention reads keep the last values and label their relative update
  time. Discovery reconciliation removes a membership that has actually ended.
- Discovery that cannot run leaves the stored set listed and says which state
  the account is in; a missing identity credential is restored by the next
  switch or creation through a browser sign-in, never shown as a menu item
  that comes and goes or a caption that outlives the reconnect.
- An unreachable target region leaves the active workspace intact and reports
  that connectivity is required. A link into the active workspace needs no
  connectivity to open and fails on its first read like any other request.
- Setup requests use UUIDv7 operation IDs. Reusing one with identical input
  returns the journaled result; changing action or payload under it is refused.
  The desktop keeps that ID across identity refresh and transport retries.
- Queue publication after membership transition is best effort, as documented in
  `access-revocation.md`; authorization fences still refuse every reconnect.

## Testing

Node tests cover plural schema, setup replay, departure races, stored-set
migration, activation intent ordering, the active-workspace claim a link takes
before activating, session cache scope, draft scoping, and component states. The
attention aggregation and object admission fences run in the real workerd suite.
Local environment synchronization gives Global the local EU API route, and
`pnpm db:open-authority` opens and seeds both regional authorities so the same-ID
regional fixture can prove an actual Global → EU → Global desktop switch.
The complete manual Global/EU, offline, invitation, removal, sign-out, Lockdown,
and flag-off matrix lives in `e2e.md`.

## Data model

Global `platform_workspace_bindings` is keyed by `(platform_user_id, region,
workspace_id)`. Regional membership and product state retain their existing
workspace IDs and gain only the nullable `workspaces.abandoned_at` lifecycle
column. `platform_workspace_operations` journals UUIDv7 create/accept operations;
the desktop retains one operation ID until its request reaches a terminal
answer, so a transport retry reaches the same journal row. The regional create
path has a second caller: demo preparation creates the presenter's workspace
through `createWorkspaceForMember` — the same rows, journal, placement check and
object initialization as `create`, with no session — journaled under the demo
operation's own id, which Ace mints as a random UUID. The journal keys on the
id's identity, not its version
([`demo-workspaces.md`](demo-workspaces.md#preparing-a-demo)).

The desktop's encrypted version-2 envelope stores one identity credential and a
map of regional workspace credentials. Its presentation file stores only the
active regional binding and ordered recency. Composer draft keys include region
and workspace ID so even same-ID regional fixtures cannot collide.

## Regional impact

Create and accept are coordinated through Global but committed in the selected
region. The operation journal records the regional result so a retry cannot
create a second workspace or consume an invitation twice. Discovery reconciles
opaque regional routes by verified account email; it does not require regional
user UUIDs to match. EU credentials call only EU product routes, while the
retained Global identity credential remains the only discovery authority.

## Security and trust model

Refresh material stays in Electron main and is never exposed through preload.
Each workspace credential is bearer authority for exactly one regional
workspace; selecting a workspace does not broaden it. The feature flag changes
presentation only. On revocation or departure, main removes exactly the affected
credential/profile/drafts before another workspace becomes active. Lockdown
encrypts the complete account set, while sign-out erases it locally before
best-effort remote revocation.

## Changelog

### 2026-09-08 — Demo preparation creates a workspace without a session

**What changed:** `RegionalOnboardingService.createWorkspaceForMember` is the
session-less sibling of `create`, journaled under the caller's operation id;
demo preparation is its one caller. The candidate filter withholds an
unpublished demo whatever its status, so an abandoned one never appears.

**Why:** A demo workspace is the presenter's own — owner membership, journal,
placement and object exactly as if they had created it — but a session minted
on their behalf by an operator is a credential nobody signed in for. Owned by
[`demo-workspaces.md`](demo-workspaces.md).

### 2026-09-07 — Discovery withholds the demo template and an unpublished candidate

**What changed:** Regional discovery drops the demo template and a demo
workspace still being prepared from its answer, and activation refuses the
latter with `demo_workspace_preparing`.

**Why:** A presenter who opened a half-seeded demo would see a sidebar the
pack had not finished writing, and nobody should find the template — which
holds the cast's real connections — in their switcher. The filter is the
regional API's, keyed by the demo operation rows, so the desktop changes
nothing; but the invariant above that a complete discovery removes a stored
workspace now has two deliberate cases. Owned by
[`demo-workspaces.md`](demo-workspaces.md).

**Consequences:** `endedStoredWorkspaces` treats an absence from a complete
discovery as a lost membership; for these two workspaces that is the intended
outcome, and a change that wants either to survive on a device has to change
the filter, not the reconciliation.

### 2026-09-07 — Simplify the bottom-bar account popup

**What changed:** The compact popup keeps Settings, workspace switching,
invitations, and Log out last with a divider above it. Rows share side padding,
icon spacing, and minimum height; overflowing lists scroll within the window.

**Why:** The product request explicitly removed About, support links, and Create
a workspace to shorten the popup. This deliberately reverses the creation part
of the 2026-09-04 entry: creating an additional workspace is no longer reachable
from the shipped desktop shell. Moving creation or support to another surface
was not requested. Initial onboarding still creates a first workspace; the
legacy component variant is retained, not advertised as a product alternative.
Review also exposed that moving Log out below an unbounded list could make it
unreachable, so the popup now shares the legacy menu's available-height scroll
behavior. Future changes must preserve switching, invitations, and reachable
account actions in the compact presentation.
### 2026-09-05 — Project account appearance

The identity bridge now carries revisioned new-account eligibility and appearance
so a person sees the same avatar and color when activating either region. Global
remains the writer; regional copies cannot overwrite a newer revision.


### 2026-09-04 — Keep workspace capabilities in the compact account presentation

**What changed and why:** The Grok-style account menu now performs discovery on
open and includes the same flagged switching, invitation, and creation controls
as the workspace presentation. The prior presentation branch accidentally
excluded them. Styling is not a capability boundary; nonfunctional usage and
iOS placeholders were removed instead of pretending Rally implements them.


### 2026-09-02 — A switch signs the account in itself, and the regions are US and EU

**What changed:** A switch or a creation that finds no identity credential on
this device opens the browser for a sign-in and runs again once the callback
has landed, with "Finish signing in to Rally in your browser" under the row
or in the dialog meanwhile. The "Reconnect account…" item, the row caption,
its tooltip, and the switch guard that read the renderer's copy of the
account state are gone. Main names that failure `account_reconnect_required`
and lets it cross the bridge unchanged, and the ticket exchange invalidates
the directory query the moment the credential is back. The region under the
account's email, the row tags, the legacy one-workspace menu, the region
picker, the invitation card, and Settings say US or United States rather
than Global.

**Why:** Field feedback on 1.259.0, the first build carrying the earlier
fixes: after choosing "Reconnect account…" and finishing the browser sign-in,
the menu still said "Reconnect your account to open this workspace" under the
other workspace, and it opened only on the next choice of the row. The
renderer gated the switch on `identity` from its last directory answer, and
nothing refreshed that answer when the exchange landed — the focus refetch
ran before the callback was exchanged and the next menu open deduplicated
into it — so a row chosen inside that window was refused with an error
caption that then outlived the reconnect. Beyond the bug, a separate
reconnect step was the wrong shape: choosing the workspace already said what
the person wanted. And "Global" named a region whose data lives in the
United States; the product has two regions, not a global one.

**Considered and rejected:** Refetching the directory after the exchange and
keeping the guard, which leaves every switch at the mercy of a query the
renderer might be holding stale. A timeout on the wait for the browser,
which is a limit with a number nobody has chosen; the row stays chosen and
can be chosen again instead. A progress notice for an addressed link in the
notice window, whose title reads as a failure and which the main window
cannot take down once the link has opened.

**Review adjustments, same day:** The waiter is keyed by attempt and stood
down as soon as main honours a newer attempt, so a callback from a
superseded tab settles nothing and a launch that fails leaves nothing
parked; the activation mark that holds the shell up during a switch is
compared by identity before it is cleared, so a superseded attempt cannot
clear a newer one's; the shell's error write carries the same attempt check
as its other writes; the create dialog can be resubmitted or left while it
waits, abandoning the creation and not the sign-in; the startup activation
says where the person is expected and an addressed link signs in in place,
waiting outside the deep-link queue its own callback arrives through; and
the invitation email, the setup-required screen, and the telemetry
diagnostics say United States or US as well.

**Consequences:** An action that needs the identity credential goes through
`withAccountIdentity` rather than reading the directory's `identity`, which
now serves only the no-workspace gate. A failure that already carries an
activation code is thrown as one; `workspaceActivationBridgeError` passes it
through and wraps everything else as an outage. A terminal renewal of the
identity credential is reported as that code too, by `identityRenewalFailure`
in main, so surrendering the credential and asking for the sign-in are one
answer rather than two clicks. Anything that settles a sign-in must name the
attempt it heard from, and nothing may wait for a sign-in from inside the
deep-link queue.

### 2026-09-02 — A session's life slides with use, under a ninety-day ceiling

**What changed:** `AuthService.refresh` moves `expires_at` to thirty days
from the renewal, never past ninety days from the session's creation, and
refuses a renewal for a session already past that ceiling.

**Why:** Every session had a fixed thirty-day life stamped at creation, so a
daily user was still signed out — and asked to reconnect the account for
switching — thirty days after their last Google sign-in, on a schedule that
had nothing to do with how they used Rally. Both numbers are the team's:
thirty days of inactivity before a session lapses, ninety days at most before
a fresh sign-in regardless.

**Considered and rejected:** A pure sliding window with no ceiling, which lets
a leaked refresh token keep itself alive indefinitely. Sliding on every
request rather than on renewal, which would write the sessions table on every
call for no gain over a fifteen-minute access token.

**Consequences:** The ceiling is enforced in the renewal statement itself, so
no code path can extend a session past it. A session created before this
change carries its original thirty-day expiry until its first renewal, which
slides it like any other.

### 2026-09-02 — A renewal merges into the files on disk, and an identity rebuilds its profile

**What changed:** `writeSplitSessionFiles` merges a renewed session into the
profile set read from disk when this process has not read it yet, and
`loadStoredIdentitySession` refreshes an identity credential whose profile is
missing instead of reporting no identity. A workspace counts as stored by its
credential alone when the directory decides whose attention to read.

**Why:** After a restart, the menu came up asking for a reconnect and listing
only the active workspace while the credential file still held three
credentials. The launch-time analytics preference sync had found its access
token expired, refreshed the active credential, and rewritten both files by
merging into an in-memory profile set nothing had loaded yet — one profile
survived. An identity credential without its profile then read as no
identity at all. This reproduces the reported symptom on its own, with no
token race involved.

**Considered and rejected:** Loading the auth set inside the write the same
way. The auth set's loader falls back to migrating a legacy session file,
which itself writes, and every caller already holds the auth set it is
renewing; the profile set is the one nothing guaranteed had been read.

**Consequences:** A write never narrows the stored sets to what one process
has seen. A missing profile is a cache miss that a refresh fills, not a
missing credential.

### 2026-09-02 — One dot for any activity

**What changed:** The account menu's background rows show a single green dot
when the attention read reports anything at all, and nothing otherwise. The
coloured count is gone; its detail lives on in the tooltip and the accessible
name.

**Why:** The count needed explaining — what the number was, what its colour
meant, why one row had a dot and another a number — and the person reading
the menu only wanted to know whether there was anything to look at.

**Considered and rejected:** Keeping the count with its tooltip. A mark that
needs a legend is not pulling its weight in a menu opened for a second.

**Consequences:** The attention contract is unchanged; only its presentation
narrowed. A future need to rank workspaces by urgency has the data already.

### 2026-09-02 — A switch dissolves, lands on the new work-stream page, and the menu explains its marks

**What changed:** Selecting a workspace from the account menu now dims the
current panes in place, prefetches the new workspace's record before the old
one is torn down, resets the route to the new work-stream page, fades the same
panes back up, and closes the menu once the switch took. The scrim overlay and
its "Opening …" caption are gone. Rows the account cannot open show a muted
caption and a tooltip instead of a red outline, and the attention count and
activity dot explain themselves on hover.

**Why:** Field feedback on the first round. Starting a work stream in one
workspace and switching to another before the reply arrived left the new
workspace trying to open the old work stream, because a menu switch — unlike
an addressed link — never touched the route. The switch itself read as
jerky: a scrim with a caption, then a full-screen "Opening workspace…" while
the shell was torn down and rebuilt, then the shell again. And the red outline
on unopenable rows did not belong to the product's own idiom, which marks a
connector that needs reconnecting with a muted dot and a caption rather than
an alarm. The green dot and the coloured count had to be explained in person.

**Considered and rejected:** Keeping the previous shell mounted under the new
one with the old workspace's data as a placeholder, which would have put a
socket for one workspace under an API client for another. A full crossfade
of the whole window including the backdrop, which restarts an animated
theme backdrop on every switch. Dismissing the menu the moment a row is
chosen, which hides the row a failure needs to be shown beneath.

**Consequences:** Any path that applies an activated session should go through
`applyActivatedSession` so it prefetches, resets the route, and carries the
flags; deep-link activation keeps its own route reset. The enter animation's
length lives in one place in the shell and must match `workspace-enter` in
`app.css`.

### 2026-09-02 — Stored workspaces outlive discovery, and one token rotates once

**What changed:** The account menu lists the device's stored workspaces
merged with discovery rather than discovery alone, `getOnboardingState`
reports the account's identity state instead of rejecting, background rows
are outlined with a tooltip while the account needs reconnecting, a complete
discovery retires stored memberships it no longer lists, and every renewal of
a stored credential is single-flight per refresh token. The create-workspace
dialog's name field took the app's form-field styling, and menu items stopped
showing the text cursor.

**Why:** A field report: "Reconnect account…" appeared some five seconds
after the menu opened, and a workspace created the day before was missing
from the menu until the account was reconnected. The missing workspace was
the menu listing only discovery, which needs the identity credential. The
credential had been surrendered by a terminal 401 on refresh, and the way to
reach one without the token expiring is the rotation race in
[Credential renewal](#credential-renewal): two identity requests that found
the same access token expired — a focus refetch and a deep link, a menu open
and a switch — each rotated the token, and the earlier answer was persisted.
The five seconds were React Query retrying a thrown "sign in first" error
twice before surfacing it, and clearing it again on every refetch while the
query had never succeeded.

**Considered and rejected:** Refusing the second concurrent rotation on the
server, which would turn the lost-response recovery the grace exists for into
a forced sign-in. Caching discovery to disk so a never-opened workspace also
survives a discovery failure, which makes the device a content directory it
does not own; the stored set is what the device has authority for. Keeping a
stored row that a complete discovery no longer lists, which is a ghost that
can never open.

**Consequences:** A device's own workspaces never leave the menu on the
account's failure, and the menu distinguishes "reconnect" from "try later"
without inspecting error text. Any new path that renews a stored credential
must go through `credential-refresh.ts`. A stored workspace absent from a
successful discovery is removed, so a regional discovery that could ever
return a partial list would have to stop failing closed before that rule was
safe.

### 2026-09-02 — A link to the active workspace opens without re-activating it

**What changed:** A workspace-addressed link whose target is the active
workspace no longer asks the platform to re-activate it. Main answers through a
new `workspace:reselect-active` bridge call with the session already in use and
takes a selection intent; the destination applies at once. A link to any other
workspace still goes through platform activation. The renderer also stops
clearing its query cache when an applied session names the same user,
workspace, region, and role as the one it replaces.

**Why:** Opening a work-stream link to the current workspace took two visible
steps: a platform round trip that minted a fresh credential, then a full shell
reload because the new session cleared every cached list, and only then the
work stream. For the active workspace the round trip bought no enforcement —
the regional API re-checks membership on every request the credential in use
makes, and a fresh credential goes through the identical check — so the cost
was paid for nothing. The unconditional cache clear also made every credential
renewal reload the shell.

**Considered and rejected:** Selecting a stored credential locally for a link
into *another* workspace. Review showed a membership that ends leaves its
session row alive and `/auth/refresh` has no membership join, so the desktop
would persist a switch into a workspace it can no longer load and, offline,
into one it cannot leave; the platform round trip is what refuses that link
before the window moves, and it stays. Also rejected: keeping the round trip
for the active workspace but skipping the cache clear, which still left a
network wait in front of the workspace already on screen.

**Consequences:** The 2026-09-01 "Addressed links revalidate membership and
fail closed on old builds" entry below is narrowed: revalidation is for a link
into a workspace that is not active. The ordering guarantee is kept because the
local claim takes a selection intent, so an activation still in flight cannot
take over the window after a link opened. The deep-link failure copy still
folds a missing identity credential into the connectivity message; that is
deferred, not fixed here.

Shipped in #484.

### 2026-09-01 — Targeted Settings leaves a safe workspace landing page

**What changed:** An addressed Settings, connector-result, or Slack handoff that
changes workspaces resets the main window behind Settings to the new workspace's
landing page. Same-workspace handoffs preserve the current route, and regional
membership denials retain access-failure wording through Electron IPC. Addressed
connector results are main-only instead of being duplicated into Settings, and
each queued link isolates its failure from later deliveries.

**Why:** Real-window connector verification showed that authorization remained
correct but closing Settings could expose the previous workspace's resource
route, which then failed to load under the newly active credential. A suspended
local membership also proved that the server's “access is unavailable” denial
was being mistaken for a network outage. Follow-up review found the Settings
delivery gate still looking for the removed query-addressed workspace field,
which made path-addressed results race activation in two renderer processes. A
second follow-up showed that an escaped window failure rejected the serialized
promise tail and prevented all subsequent links from running.

**Considered and rejected:** Leaving the stale route to fail closed, and always
resetting the main window. The first turns a successful connector return into a
confusing access error; the second discards a person's place when no workspace
change occurred.

**Consequences:** A cross-workspace handoff has an unambiguous background screen
as well as an unambiguous credential. Resource and automation destinations still
navigate directly to their addressed route.

Shipped in #464.

### 2026-09-01 — Addressed links revalidate membership and fail closed on old builds

**What changed:** The native target moved from query coordinates on a known host
to a versioned `workspace/<region>/<workspace>/<destination>` path. Every explicit
target now reaches platform activation even when already selected, works from an
identity-only session, processes in delivery order, and renews credentials inside
the activated target. Connector attempt state survives Settings remounts.

**Why:** Review showed that a previous desktop could ignore the query target, a
locally cached credential could outlive membership, and an expired target bearer
or concurrent callback could apply a valid link in the wrong order or context.

**Considered and rejected:** Keeping query routing with a minimum-version notice,
and trusting a matching cached credential. The first cannot stop an installed old
reader from silently accepting the URL; the second makes local state a membership
authority.

**Consequences:** Addressed links need connectivity and older builds reject them.
Legacy unaddressed links remain active-workspace compatibility inputs.

Shipped in #464.

### 2026-09-01 — Explicit links activate their addressed workspace

**What changed:** Connector callbacks and all current workspace-scoped external
links carry a region/workspace target. The desktop activates and verifies that
target before applying the destination, while pending connector polling pauses
outside the workspace that created the attempt.

**Why:** Switching from A to B while provider consent was open left the callback
owned by A but the renderer applying or polling B. Resource links had the same
ambiguity and navigated under the active workspace regardless of their origin.

**Considered and rejected:** Binding callbacks to whatever is active, showing a
choice after every callback, and scanning all stored workspaces. The first writes
the wrong context, the second asks the person to reconstruct state OAuth already
knows, and the third weakens workspace isolation into discovery by resource ID.

**Consequences:** Following a targeted link may switch the foreground workspace;
background work may not. Membership and the meeting guard remain authoritative,
so a refused switch changes neither workspace nor route.

Shipped in #464.

### 2026-09-01 — Review closes regional and lifecycle races

**What changed:** Regional user identities and draft keys are isolated, legacy
workspace-only sessions reconnect in place, setup retries retain their operation
IDs, departure confirmation carries its expected outcome, recording exclusion
is bidirectional, active revocation selects a surviving workspace, and abandoned
AutomationAgents retire their pending work.

**Why:** Adversarial review found that same-account regional UUIDs, delayed
responses, and already-addressed Durable Objects could otherwise cross a
boundary or apply an outcome the person had not confirmed.

**Considered and rejected:** Treating one user UUID as account-wide, minting a
new operation ID after refresh, letting the server silently escalate a leave to
abandonment, and relying only on route admission. Each made an asynchronous
retry or background object a second authority.

**Consequences:** Account identity is linked by verified email, destructive
membership outcomes are optimistic-concurrency checked, and background runtime
work fails closed once its regional workspace is abandoned. Polling cadence and
device cap remain `LIMIT UNSET`.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-31 — Regional binding is the desktop identity

**What changed:** Desktop credential/profile sets, selection, recency,
attention, errors, departure, and meeting capture now key workspaces by region
and UUID together. Local environment sync routes Global onboarding to the local
EU Worker, and the authority bootstrap now opens and seeds both regions.

**Why:** Global and EU local fixtures deliberately share a workspace UUID. A
real-window pass showed that UUID-only state replaced one credential with the
other, marked both rows current, and made a successful EU activation impossible
to exercise after its authority refused product traffic.

**Considered and rejected:** Making fixture UUIDs globally unique would conceal
the invariant the production design relies on. Leaving EU in `legacy_open`
would preserve an old bootstrap convention at the cost of making cross-region
desktop behavior unverifiable.

**Consequences:** Any new desktop state keyed to a workspace must carry the
region too. Local bootstrap takes the same authority transition in Global and
EU and imports the product fixtures into both object namespaces.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-31 — One account retains several region-bound workspaces

**What changed:** Plural control-plane routes and idempotent setup coordination,
workspace leave and abandonment, versioned desktop credential/profile sets, the
flagged account-menu switcher, aggregate background attention, workspace-scoped
drafts, and meeting-capture switching guards shipped as one module.

**Why:** Members need to create, accept, and move among independent Rally
workspaces without signing out or weakening each workspace's regional boundary.

**Considered and rejected:** Rebinding one session on every switch, opening a
socket per background workspace, merging items into a global inbox, and deleting
an empty workspace's data. The first cannot leave EU for Global discovery; the
next two cross the product boundary; the last has no complete object/R2 deletion
walk.

**Consequences:** Global retains opaque routing and identity authority, regional
Workers retain all workspace authority, and the desktop becomes the owner of one
device's active selection and recency. Poll cadence and a device workspace cap
remain explicit open decisions.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).
