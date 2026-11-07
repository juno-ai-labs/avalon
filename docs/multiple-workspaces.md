# Multiple workspaces

One Rally account can belong to workspaces in either data region while each
workspace remains a separate regional authority. The desktop keeps a narrow
Global identity session for discovery plus one regional credential and cached
profile per activated workspace. Exactly one workspace is active on a device;
the account menu changes that selection without merging workspace content.

Read this before changing plural onboarding, stored desktop sessions, workspace
switching, background attention, leaving, or abandonment.

Desktop platform discovery and activation offer guest relationships as well as
memberships, to a client that declares `GUEST_WORKSPACES_CLIENT_CONTRACT`;
memberships are listed first. What a guest is refused is decided by
`useShellCapabilities().guest`, and the Mac app's background work that reads
member-only routes (attention, the menu bar) skips guest credentials. Push
registration covers every credential, a guest's included. A guest cannot leave from the Mac app: Leave is in the
member-only Organization section. The 2026-10-03 entry lists every path.
The ordinary member directory includes guests with `accessClass: guest`, a null
administrative role and a Guest badge. It also carries the current incarnation
and revision. An owner or administrator can use Make member in desktop Settings;
`POST /workspace/members/:id/promote` compares both values in the guarded D1 write.
A stale request returns a conflict and refreshes the roster. Promotion retains
identity and session bindings; the durable relationship delivery invalidates
participant/directory views without closing valid conversations.

A Rally access support session ([`impersonation.md`](impersonation.md#support-access))
is stored in the same set as the Organization's credential, marked by an
`impersonator` on its cached profile. It is not one of the account's
Organizations: the directory, push registration and background reads skip it,
and selecting any other Organization drops it.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/0098_multiple_workspaces.sql` | Plural Global route bindings, regional abandonment, and the replay journal for setup operations. |
| `apps/api/src/services/platform-onboarding-service.ts` | Cross-region discovery, activation, create/accept coordination, and operation replay. |
| `apps/api/src/services/workspace-service.ts` | Ordinary self-leave, sole-owner refusal, and atomic final-member abandonment. |
| `apps/api/src/services/workspace-attention-service.ts`, `durable-objects/workspace-do.ts` | The regional attention read, `membershipAttention` over a person's memberships, and WorkspaceDO projection. |
| `apps/api/src/routes/browser.ts` (`/workspaces/attention`), `apps/browser/src/entry.tsx` | The browser organization list's activity counts, across deployments. |
| `apps/desktop/src/main/stored-auth.ts`, `index.ts` | Versioned credential/profile sets, device-local recency, exact-credential refresh and removal, activation races, and complete sign-out. |
| `apps/desktop/src/main/workspace-selection.ts`, `workspace-activation.ts` | The local claim that answers a link to the active workspace, and the platform activation every other addressed link takes. |
| `apps/desktop/src/main/credential-refresh.ts` | One rotation per refresh token: every path that renews a stored credential shares an in-flight refresh of the same token. |
| `apps/desktop/src/main/workspace-directory.ts` | The account menu's directory: the stored set merged with discovery, and the reconciliation that retires a membership a complete discovery no longer lists. |
| `apps/desktop/src/renderer/components/workspace-account-menu.tsx`, `app-shell.tsx` | Flagged switcher, invitations, attention states, switching presentation, and creation in the legacy component variant. |
| `apps/desktop/src/renderer/lib/draft-keys.ts`, `draft-cache.ts`, `app-session.tsx` | Workspace-scoped composer drafts and exact cleanup when one membership ends. |
| `apps/desktop/src/renderer/lib/app-session.tsx` (`applyActivatedSession`), `account-onboarding-query.ts` | Landing a switch or a creation: the pending mark, the route reset, and what crosses the cache reset. |

## How it works

New-user learning and account appearance are described in
[new-user onboarding](new-user-onboarding.md). The identity bridge carries that
narrow revisioned profile into each region; workspace content remains regional.

### Authority and data flow

The desktop stores one version-2 auth set and one matching profile set. Each
workspace credential carries its immutable region; the active-workspace binding
and every ordered-recency entry are `(region, workspace_id)` pairs in
device-local presentation state. The pair matters even when UUIDs happen to
collide across regions: credential replacement, profile lookup, attention,
departure and React keys all use the complete binding.
Selecting a cached workspace rewrites only that active selection. A network
activation may finish after another selection; its credential and profile are
retained, but an intent generation prevents the late response from taking over
the window.

Regional user IDs are regional identifiers, not account identifiers: the same
account may have different user UUIDs in configured deployments. Global sends a
deployment the account's platform user ID and every sign-in method it has
verified, as `loginIdentities` of provider and subject (`google` and its
subject, `email` and its address). The deployment finds its user by platform ID,
or else by any of those methods (and, for a user this bridge made before it
recorded them, by `users.google_subject`), and records the methods it was sent.
A method already held by a different regional user is a 409
`regional_identity_conflict`, and an account with no method at all is refused a
new regional user with `login_identity_required`. A new provider, such as Apple
or GitHub, needs only its sign-in code: neither the bridge nor the table names
the providers.
An older version-1 workspace-only envelope can be reconnected in place after one
Google exchange, preserving its selected workspace rather than forcing setup.
A live sign-in attempt that lands on stored credentials with no organization
session to show (an identity credential whose profile could not be rebuilt, an
active entry whose profile is gone, or an active selection naming a credential
that is not stored) takes over: the renderer drew the sign-in screen for that
state. When the stored identity credential is the same user's, only it is
replaced and revoked, the organizations stay, and the selection is cleared.
Otherwise the whole set is cleared, revoked in the background, and the new
identity stored. A stored organization session for the same email keeps its
selection and gains the identity credential; one for a different email refuses
the sign-in. A displaced identity credential is always revoked.

### Credential renewal

Access tokens live fifteen minutes; refresh tokens rotate on every renewal and
the API keeps honouring the token it just retired until the device first
presents its successor, so a device whose rotation response was lost can
present the old one again, even hours later after the Mac slept. A renewal with
the retired token issues a new successor and keeps the retired one valid. That
makes a *concurrent* pair of renewals with the same token dangerous: both
succeed, and the second retires the first answer's token at once. A device that
persisted the first answer then gets a 401 on its next renewal, which is
terminal, and the credential is surrendered. On the Mac app, a terminal
identity renewal failure ends the entire local session and shows **Your Rally
session has ended.** in a native modal. A signed-in organization with no account credential takes the same path
when an account request discovers it. Main clears all credentials and profiles,
broadcasts sign-out, and closes auxiliary windows before showing the notice;
the person returns to sign-in rather than continuing with broken account
settings. Existing server sessions are revoked in the background using the
same revocation path as explicit sign-out; an unreachable server cannot delay
the local cleanup or notice. Network errors and server failures retain credentials for retry.
The cleanup compares the rejected credential with the current one under the
session mutation lock, so an old failure cannot erase a newer sign-in.

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

A background row's trailing indicator is a count badge, the sidebar's unread
red with white digits (`ActivityCountBadge` in `@rally/ui`), showing the
attention read's `readerAttentionCount`: the conversations unread, unseen or
mentioning the person. It is the same number as that Organization's attention
menu and dock badge, it reads 99+ past two digits, and a zero shows nothing.
An agent waiting on input (`needs_input`) with nothing unread counts zero, as in
the attention menu.
When some of those conversations are waiting on the person, the strongest
reason, in the order WorkspaceDO ranks them, is the badge's tooltip and part of
the row's accessible name. The browser's organization list shows the same
badge, read through `GET /browser/workspaces/attention` (below).

### Switching

Choosing a workspace is a dissolve, not a cut. While the new credential is
minted the current panes dim in place and the menu row shows its spinner; the
menu stays open so a failure lands under the row the person chose, and closes
itself once the switch took. The new shell draws its first frame from the
session itself, which already describes the workspace (`workspaceFromSession`
is its placeholder for `GET /workspace`), so the switch lands the moment main
answers; the record is fetched before the old workspace is torn down only for
a session too incomplete to describe it, so the shell never shows a bare
"Opening workspace…" between the two. The same panes then fade back up over
the unchanged backdrop showing the new workspace. The feature flags ride
across the cache reset, stamped stale, so the account menu keeps its shape
and its directory read starts on the first frame rather than after the new
workspace's flags answer; the account's onboarding state, read at identity
scope, rides across with them so the setup journey's read starts on the
first frame too. A creation carries it only when it already says eligible: a
first organization can make an ineligible account eligible, never the
reverse, and a stale `false` would admit the creator past their journey.

Creating a workspace lands through the same path (`applyActivatedSession`).
Main announces the new session the moment it is persisted, before the create
call returns; the renderer holds that announcement while its own creation is
in flight, as a switch does, so the old shell is not torn down early on the
previous workspace's route with an empty cache. A creation does not know its
workspace's id until main answers, so it holds any workspace in the region it
asked for, though a renewal of the workspace on screen passes; main's answer
is its active session, and a creation that fails applies the last broadcast it
held instead. The account
menu's create action does not refetch the directory afterwards: the landing
remounts the shell, and the new one reads discovery itself.

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
callback must be free to come through. A terminal identity renewal now ends
the whole local session as described in [Credential renewal](#credential-renewal),
rather than preserving an organization with no account identity. The exchange also invalidates
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
credential may call `GET /workspace/attention`, which returns an addressed
count, its highest-priority reason, an unread-activity boolean, and
`readerAttentionCount` (the sidebar attention menu's count; Apple push uses it
as `aps.badge`). Focus and account-menu opening refresh the projection. The fixed periodic cadence and any
device workspace cap remain `LIMIT UNSET`; do not invent either number. There is
currently no periodic refresh: focus and menu opening are the only refresh
triggers until the team chooses a cadence.

The browser holds no workspace credential before it opens an Organization, so
its organization list reads attention through its identity cookie instead:
`GET /browser/workspaces/attention` answers for every membership the list
holds. Global reads its own WorkspaceDOs and asks each other deployment over
the identity bridge's `attention`, which looks up the person's regional id by
platform id and writes nothing: linking is `discover`'s job, and the list ran
it first. A person not linked there yet has no membership there to count. Guest relationships are skipped, as on the Mac. One
workspace or deployment that fails is left out and logged as
`browser_workspace_attention_failed`, naming the region, the workspace and a
code that carries a schema rejection's field; the rest still answer. The list is read
first and the counts after it, so the list never waits on a Durable Object.

### Workspace-addressed handoffs

Every newly emitted external destination for workspace content or settings
carries `(region, workspace_id)`. It is a routing coordinate, not a capability.
The native shape is
`rallywithai://workspace/<region>/<workspace-id>/<destination-host>/<destination-path>`.
Its distinct host makes a desktop build from before this contract reject the
link; a query-addressed shape is forbidden because an older work-stream parser
would ignore those coordinates and open relative to the active workspace.

Work-stream destinations may append `/substreams/<child-id>` to select a private
child. The canonical HTTPS link, website handoff and desktop intent preserve that
suffix; after workspace activation the renderer opens the parent route with its
`substream` selection. The normal child membership check still applies.

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
For a handoff into another workspace, if the credential is missing, or regional membership has been revoked, activation
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

An automation's runs are conversations under its Sidekick, and their
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

Built-in meeting windows and their workspace-switching guard have been retired.
Composer dictation remains tied to its composer lifecycle.

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
- The active workspace's row on the account menu takes its name from
  `GET /workspace`, not from discovery. Discovery is rerun by no sync topic,
  while the `workspace_profile` topic refreshes that read when an
  administrator renames the Organization, so dropping the overlay in
  `app-shell.tsx` would leave the old name showing until the next discovery.
- This device rotates one refresh token at most once at a time.
- Leaving one workspace cannot delete another workspace's credential, profile,
  query state, or draft.
- Abandonment retains data and is reversible only by a paired operator action;
  it is not deletion.
- Defensive polling cadence and device-count limits stay open until the team
  chooses their values.
- Nothing reads a Global operation's `status`. That is what lets its
  completion run beside the binding's activation; a reader of it would have to
  order the two again.

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
- Temporary discovery failures leave the stored set listed and report that
  account information is unavailable. On the Mac app, a missing account
  credential in a signed-in organization or a terminal account renewal failure
  clears the complete local session and shows the native sign-in notice.
- An unreachable target region leaves the active workspace intact and reports
  that connectivity is required. A link into the active workspace needs no
  connectivity to open and fails on its first read like any other request.
- Setup requests use UUIDv7 operation IDs. Reusing one with identical input
  returns the journaled result; changing action or payload under it is refused.
  The desktop keeps that ID across identity refresh and transport retries.
- Queue publication after membership transition is best effort, as documented in
  `access-revocation.md`; authorization fences still refuse every reconnect.
- A regional profile refresh reports `regional_identity_conflict` only for a
  uniqueness refusal (another regional user holds the verified email). Any
  other database failure keeps its own error.

## Data model

Global `platform_workspace_bindings` is keyed by `(platform_user_id, region,
workspace_id)`. Regional membership and product state retain their existing
workspace IDs and gain only the nullable `workspaces.abandoned_at` lifecycle
column. `platform_workspace_operations` journals UUIDv7 create/accept operations;
the desktop retains one operation ID until its request reaches a terminal
answer, so a transport retry reaches the same journal row. The regional create
path also serves demo preparation and Engineering MCP through
`createWorkspaceForMember` — the same rows, journal, placement check and
object initialization as `create`, with no session — journaled under the demo
operation's own id (or the Engineering MCP creation UUID). An optional initial
member list is validated first and committed with the owner in the same batch;
ordinary member seating runs after initialization and on replay. The journal keys on the
id's identity, not its version
([`demo-workspaces.md`](demo-workspaces.md#preparing-a-demo)).

The desktop's encrypted version-2 envelope stores one identity credential and a
map of regional workspace credentials. Its presentation file stores only the
active regional binding and ordered recency. Composer draft keys include region
and workspace ID so even same-ID regional fixtures cannot collide.

## Security and trust model

Refresh material stays in Electron main and is never exposed through preload.
Each workspace credential is bearer authority for exactly one regional
workspace; selecting a workspace does not broaden it. The feature flag changes
presentation only. On revocation or departure, main removes exactly the affected
organization credential/profile/drafts before another workspace becomes active.
A terminal account failure ends all local sessions instead. Lockdown
encrypts the complete account set, while sign-out erases it locally before
best-effort remote revocation.

## Changelog

### 2026-10-21 — Initial members through shared Organization creation

**What changed:** The session-less `createWorkspaceForMember` entryway accepts
initial member IDs. It validates them before creating anything, commits their
memberships with the owner, and runs ordinary member seating after initialization
and on replay. Engineering MCP is another caller of that entryway.

**Why:** An operator creating an Organization with users needs the same journal,
placement, membership deliveries and General/Personal Channel bootstrap as the
app, without recreating setup writes in an MCP adapter or minting credentials.

**Considered and rejected:** Adding member rows in the adapter after onboarding;
that duplicates the membership entrance and can leave partial membership setup.

**Consequences:** Callers retry the original creation and member list. Memberships
commit together; unfinished Channel seating is resumed rather than re-created.


### 2026-10-12: A retired refresh token lasts until its successor is used

**What changed:** `AuthService.refresh` accepts the token it retired until the
device presents the successor, instead of for sixty seconds, and a renewal with
the retired token no longer replaces it with the successor the device never
received. `logout` honours the retired token the same way.

**Why:** People were signed out with "Your Rally session has ended." after
their Mac slept. On wake, and on the short background wakes macOS makes while
asleep, the network comes back, TanStack Query refetches the account directory,
and the expired identity token is renewed while Wi-Fi is still settling or just
before the Mac sleeps again. When the service rotated but the answer was lost,
the device kept a token that died sixty seconds later, and the next renewal was
a terminal 401. Only the successor's first use proves the device received it,
so that, not a clock, now retires the old token.

**Considered and rejected:** A longer fixed window. Any number is a guess at
how long a laptop sleeps. A client-only fix: the desktop cannot tell a lost
rotation from a revoked session, so the service has to keep the old token alive.

**Consequences:** A stolen retired token now works until the device next
renews, the same exposure a stolen current token has. The sessions' thirty-day
sliding and ninety-day ceiling still bound both. Concurrent renewals with one
token remain harmful, so every renewal in the desktop's main process must still
go through `credential-refresh.ts`. The browser bridge's `refreshSession` does
not yet single-flight.

Shipped in #1193.

### 2026-10-10: A sign-in replaces stored credentials the app could not show

**What changed:** `exchangeDesktopTicket` no longer refuses a live attempt
because an identity credential is already stored. When the stored set has no
organization session to show, a sign-in by the same user replaces only the
identity credential and clears the selection, keeping their organizations;
anyone else's sign-in clears the whole set. A stored organization session
keeps its old rule: same email gains the identity credential, a different
email is refused. Every displaced credential is revoked in the background.

**Why:** A person was stuck on the sign-in screen with "Another Rally sign-in
completed first". `session:get` answers null when the identity credential's
profile is missing and the rebuilding refresh fails without being terminal, so
the credential stays on disk while the renderer shows sign-in. The exchange
then read that leftover credential as a competing sign-in and refused every
attempt, with no path back in short of deleting app data.

**Considered and rejected:** Keeping the refusal and clearing the credential
in `session:get` instead. A network blip there must not sign anyone out, which
is why it keeps the credential; the sign-in is the moment the person has
asked to replace it.

Clearing the whole set for the same user was rejected too: the common way in
is that person signing back in after a network blip, and dropping their
organizations costs them every one they had stored.

**Consequences:** The guard against a late callback replacing a newer sign-in
is the attempt registry alone: creating an attempt retires every earlier one,
and a completed exchange retires it. Attempt creation does not take the
session lock, so the exchange reads stored state first and checks the attempt
with nothing that yields between that check and clearing the registry. A
future change that lets an attempt outlive a completed sign-in, or adds an
await there, must restore a check here.

Shipped in #1184.

### 2026-10-08: Organization rows show an activity count, on the Mac and in the browser

**What changed:** The account menu's background rows show
`readerAttentionCount` as a red count badge instead of the green dot, and show
nothing at zero. The browser's organization list shows the same badge, through
a new identity-cookie route, `GET /browser/workspaces/attention`, backed by a
new identity-bridge method, `attention`. Both reuse one per-workspace read,
`membershipAttention`, which the existing `GET /workspace/attention` shares.

**Why:** A product request: the person choosing an Organization wanted to see
how much is waiting in each, on the iPhone's web sign-in list as well as the
Mac. This reverses the 2026-09-02 decision to replace the count with a dot,
which held that the count needed a legend. The answer here is one number in
one colour, the same number as the attention menu and the dock badge, so it
means the same thing wherever it appears.

**Considered and rejected:** Adding attention to `/browser/workspaces` itself.
That makes the list wait on one Durable Object read per Organization, in every
deployment, before it paints; a second read lets the list paint first. Minting
a workspace credential per Organization in the browser so it could call
`/workspace/attention`: a browser keeps only its active organization's session
by design.

**Consequences:** The account trigger's dot now marks a background
Organization with a non-zero count, so trigger and rows agree. The web
shell's own account menu still shows no background counts: the browser
platform refuses attention for any Organization but the active one, and
moving it onto the new route is a separate change.


### 2026-10-07: Creating an organization takes fewer round trips, and lands like a switch

**What changed:** `finishWorkspaceSetup` marks its creation pending and lands
through `applyActivatedSession`, the switch's path, which now carries the
account onboarding state with the flags and fetches `GET /workspace` before the
swap only when the session cannot describe the workspace. The create handler no
longer refetches the directory, and main loads the onboarding identity once. On
the server, Global reads the identity, its sign-in methods, a replayed
operation and the preference in parallel, `begin` and `reserve` are each one
batch, and activation, completion and eligibility run together after the
region commits; the region refreshes a returning user in one batch and creates
the Organization, its session row and General's anchor in one more
([`spaces.md`](spaces.md) has General's half).

**Why:** Creating an organization was slower than switching to one. Most of
the server's serial round trips read rows the same request had written or
already held, and on desktop main's early broadcast cleared the cache and
remounted the shell on the previous workspace's route before the create call
returned, after which the directory and the setup journey each waited on
another read.

**Considered and rejected:** Prefetching the workspace socket ticket with the
session. With no blocking read left before the swap the head start is one
React commit, and tickets are minted per dial with a sixty-second life.

**Consequences:** A creation's pending mark matches by region and holds any
other workspace's broadcast there; a renewal of the workspace on screen passes,
and a creation that fails applies the last one it held. A session that
describes its workspace lands without `GET /workspace` in hand. The preference
is read before the reservation, since a read failing after it would leave a
pending binding nothing releases.

Shipped in #1142.

### 2026-10-06 — A deployment links a person by any sign-in method

**What changed:** The platform identity carries `loginIdentities`, every verified
provider and subject from Global's `user_login_identities`, instead of one
`googleSubject`. `RegionalOnboardingService` resolves a regional user by
platform ID, then by any of those methods, and records them on the user.
Migration 0120 replaces the table's fixed `google`/`email` provider list with a
check on the provider name's shape. `otherDeploymentWorkspaces` now asks other
deployments for any account with a sign-in method, not only a Google one.
`createWorkspace` also marks an account eligible for the creator's setup journey
when it is a member of no organization yet, and the ambiguous-action 503 now
logs the cause it replaced. Organization slugs take the random tail of the
UUIDv7 id rather than its timestamp head.

**Why:** Creating an organization from the browser failed for an email-only
account: the schema required a Google subject, though on Global the user is
already linked by platform ID. Product asked for the identity to take any
provider now, with Apple and GitHub next. The slug change fixes a collision
found while testing: two organizations of the same name created within about
a minute shared a slug, and the second create failed as an unconfirmed 503.

**Considered and rejected:** Making `googleSubject` nullable and confining an
email-only identity to Global. It unblocked the browser but left the bridge
keyed on one provider, which the next provider would have had to undo.

**Consequences:** Linking by email trusts that Global verified the mailbox, as
it does for the email login identity itself. A deployment keeps only the email
addresses Global currently sends, as Global does, so a changed mailbox cannot
block its next owner. Email-only accounts, mostly guests, now get the same
discovery Google accounts already had: the browser's list asks each other
deployment in parallel, and each creates a regional user for the account on
first contact. With Global the only deployment this costs nothing today. Every regional user the bridge
touches gains login identity rows. A new provider's name must fit the shape
migration 0120 checks and the API's `loginIdentitySchema`.

PR: [#1129](https://github.com/juno-ai-labs/avalon/pull/1129).

### 2026-10-05 — A terminal account failure ends the desktop session

**What changed:** Missing account identity in an otherwise signed-in desktop,
and terminal account refresh failures, clear the complete local session and
show one main-process-owned native notice across concurrent requests. Each
request checks its own credential before notice coalescing, so a stale rejection
cannot suppress recovery for the current credential.

**Why:** Preserving organization credentials after losing account identity left
the app apparently signed in while Account settings could no longer load.
Silent partial credential removal and in-place account reconnection were rejected
in favor of an explicit sign-out. Transient failures still retain credentials,
and delayed failures must respect a newer credential's binding and tokens.

### 2026-10-03 — The Mac app lists, activates and opens guest workspaces

**What changed:** `RegionalOnboardingService.discover` and `requireMembership`
no longer require `access_class = 'member'`, and discovery orders memberships
before guest relationships. The Electron-only paths that call member-only routes
now skip a guest: background attention in the account menu, the menu bar
(`MenuBarContentStore`'s `available`, from `storedCredentialIsGuest` in
`stored-auth.ts`), the Settings window's first section, and the Sidekicks
window's library and creation routes. A guest's Channel rows
offer only Share, a stale new-Channel link goes to the landing route, and the
renderer renews the session when the workspace profile reports a different
access class, so a promotion takes effect without waiting out the access token.
The Slack-link deep link is withheld from a guest, and the menu bar decides
from the stored profile, so a login launch with a guest workspace active asks
nothing. Push registration, search and Speak are a guest's too: `/push-devices`,
`/search` and `/speech` moved from the member-only stack to the workspace-auth
stack, and push registers and deregisters every stored credential. Global offers
guest rows only to a client declaring contract 3 (`clientOpensGuestWorkspaces`);
bindings still reconcile against every relationship. `AppSessionValueProvider`
withholds connector setup and Sidekick creation from a guest on both hosts,
replacing the browser shell's own copy of that rule.

**Why:** The browser already mounts the desktop shell for guests; the Mac app
withheld them only because these paths had not been checked. Each one answered
a guest with 403 `workspace_setup_required`, and two of them failed for members
too: one guest's attention read failed the whole batch, and one guest's push
registration ended the loop before the credentials after it.

**Considered and rejected:** Opening `/workspace/attention` to guests. It is an
Organization-wide read that needs a product decision about what a guest is
told. Push, search and Speak had that decision made in review: each answers
only for what the person may already reach (their own devices, their search
audience, the text they send), so they were opened rather than skipped. Ordering
discovery by `joined_at` alone, which lands a fresh sign-in in whichever
Organization the person was shared into first. Lifting the filter for every
client, which hands shipped desktops guest rows they would fail on.

**Consequences:** A build that does not declare contract 3, including every
desktop shipped before this change, is offered no guest rows and cannot activate
one, so it never meets the member-only paths above. A push registration belongs
to the account in a deployment, so a guest workspace's notifications still reach
a device a membership there registered. A new Electron path that calls a
member-only route must check guest first; `desktop-guest-collaboration.test.tsx` mounts the real `App` for a guest in
the main and Settings windows and fails on any such request. The
browser's list of other deployments' workspaces uses the same discovery, so it
now includes guest relationships there too.

### 2026-09-14 — Configurable deployment isolation

Workspace creation uses Global without asking for a geographical choice. Stored credentials and profile caches drop removed deployments while retaining the Global account and other configured workspaces. This reuses existing session reconciliation; it does not migrate sessions or add enterprise provisioning.

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
a workspace to shorten the popup. This deliberately reverses the creation
control the compact presentation had gained on 2026-09-04: creating an
additional workspace is no longer reachable from the shipped desktop shell.
Moving creation or support to another surface
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
United States; the product has configured deployments, not a global one.

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

### 2026-09-02 — A renewal merges into the files on disk, an identity rebuilds its profile, and one dot marks any activity

**What changed:** `writeSplitSessionFiles` merges a renewed session into the
profile set read from disk when this process has not read it yet, and
`loadStoredIdentitySession` refreshes an identity credential whose profile is
missing instead of reporting no identity. A workspace counts as stored by its
credential alone when the directory decides whose attention to read. The
account menu's background rows show a single green dot when the attention read
reports anything at all, and nothing otherwise; the coloured count is gone, and
its detail lives on in the tooltip and the accessible name.

**Why:** After a restart, the menu came up asking for a reconnect and listing
only the active workspace while the credential file still held three
credentials. The launch-time analytics preference sync had found its access
token expired, refreshed the active credential, and rewritten both files by
merging into an in-memory profile set nothing had loaded yet — one profile
survived. An identity credential without its profile then read as no
identity at all. This reproduces the reported symptom on its own, with no
token race involved.

The count needed explaining — what the number was, what its colour meant, why
one row had a dot and another a number — and the person reading the menu only
wanted to know whether there was anything to look at.

**Considered and rejected:** Loading the auth set inside the write the same
way. The auth set's loader falls back to migrating a legacy session file,
which itself writes, and every caller already holds the auth set it is
renewing; the profile set is the one nothing guaranteed had been read. Keeping
the count with its tooltip: a mark that needs a legend is not pulling its
weight in a menu opened for a second.

**Consequences:** A write never narrows the stored sets to what one process
has seen. A missing profile is a cache miss that a refresh fills, not a
missing credential. The attention contract is unchanged; only its presentation
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

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-31 — One account retains several region-bound workspaces

**What changed:** Plural control-plane routes and idempotent setup coordination,
workspace leave and abandonment, versioned desktop credential/profile sets, the
flagged account-menu switcher, aggregate background attention, workspace-scoped
drafts, and meeting-capture switching guards shipped as one module.

**Why:** Members need to create, accept, and move among independent Rally
workspaces without signing out or weakening each workspace's regional boundary.

**Consequences:** Global retains opaque routing and identity authority, regional
Workers retain all workspace authority, and the desktop becomes the owner of one
device's active selection and recency. Poll cadence and a device workspace cap
remain explicit open decisions.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).
