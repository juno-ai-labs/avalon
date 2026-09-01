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
| `apps/desktop/src/renderer/components/workspace-account-menu.tsx`, `app-shell.tsx` | Flagged switcher, invitations, creation, attention states, and switching presentation. |
| `apps/desktop/src/renderer/lib/draft-keys.ts`, `draft-cache.ts`, `app-session.tsx` | Workspace-scoped composer drafts and exact cleanup when one membership ends. |

## How it works

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

When a person opens one, the desktop asks main to revalidate the exact target
through Global discovery and regional activation—even when the target is already
active—verifies the returned binding, clears the previous
workspace cache, and only then applies the resource, connector result, Slack
identity challenge, settings section, or automation route.

An explicit handoff is allowed to change the foreground workspace because the
person followed a destination. Background attention and reconciliation never do.
If the meeting guard refuses the change, the credential is missing, or regional
membership has been revoked, activation fails closed: the current workspace and
route remain unchanged and the deep-link failure window explains that the target
could not be accessed. The target pair never substitutes for the regional API's
membership check. The regional denial text includes “access is unavailable,” so
the desktop classifies that exact denial before its broader transient-outage
wording and does not tell a revoked member to check their connection.

Settings opens in a separate window. When an addressed Settings, connector, or
Slack handoff changes workspaces, the main window behind it moves to that
workspace's new-work-stream landing page; closing Settings can therefore never
reveal a resource route retained from the previous workspace. A handoff to the
already-active workspace preserves the main window's route.

Addressed links can start from an identity-only session because the platform
identity, not a current regional workspace, authorizes discovery. Delivery is
serialized across main's cold-start queue and live operating-system callbacks,
so two links cannot finish in the opposite order. A target API also owns normal
credential renewal; an access token expiring between activation and a Slack or
connector request does not change the workspace binding.

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

AutomationAgent also reads the regional workspace lifecycle before compiler or
provider work, scheduling, run provisioning, and delivery. An abandoned
workspace terminalizes its local pending work instead of letting an already
addressed object continue after admission closed.

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

`multiple-workspaces-enabled` controls presentation only. When off, the account
menu keeps its previous one-workspace anatomy; plural membership, credential
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
- An explicitly addressed link always revalidates membership; a locally stored
  credential is never enough to authorize it.
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
- An unreachable target region leaves the active workspace intact and reports
  that connectivity is required.
- Setup requests use UUIDv7 operation IDs. Reusing one with identical input
  returns the journaled result; changing action or payload under it is refused.
  The desktop keeps that ID across identity refresh and transport retries.
- Queue publication after membership transition is best effort, as documented in
  `access-revocation.md`; authorization fences still refuse every reconnect.

## Testing

Node tests cover plural schema, setup replay, departure races, stored-set
migration, activation intent ordering, draft scoping, and component states. The
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
answer, so a transport retry reaches the same journal row.

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
