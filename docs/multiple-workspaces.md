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

## Authority and data flow

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

The renderer mounts one WorkspaceDO socket for the active workspace. Background
workspaces get no sockets and expose no items across the boundary. Their stored
credential may call `GET /workspace/attention`, which returns only an addressed
count, its highest-priority reason, and an unread-activity boolean. Focus and
account-menu opening refresh the projection. The fixed periodic cadence and any
device workspace cap remain `LIMIT UNSET`; do not invent either number.

## Membership lifecycle

`DELETE /workspaces/:workspaceId/membership` acts only on the caller. A sole
owner cannot leave other active members without an owner. When the caller is the
last active member, one regional transaction sets `abandoned_at`, suspends that
membership, and revokes pending invitations, conditional on the workspace still
being empty apart from the caller. All admission and refresh paths join
`abandoned_at IS NULL`, and the ordinary access-revocation producer closes every
socket the membership held.

After a successful leave, Electron removes only that workspace's credential,
profile, and drafts, then selects the most recent surviving workspace. With none
left, the retained identity session returns the renderer to workspace setup.
Sign-out is different: it attempts server logout for the identity and every
workspace credential, then removes the complete local sets and all drafts even
when one regional cleanup request fails.

## Desktop behavior

`multiple-workspaces-enabled` controls presentation only. When off, the account
menu keeps its previous one-workspace anatomy; plural membership, credential
storage, lifecycle fences, and singular onboarding compatibility remain active.
When on, rows follow device recency, show a region tag only across mixed regions,
and keep the menu open while a switch is pending. Offline selection is refused
before the current workspace is disturbed.

A meeting window registers live capture with Electron main before recording
starts. Switching, creating, accepting, or leaving the active workspace is
refused until that capture stops. This guard is main-owned because Settings,
meeting, and the main window are separate renderers following one active
workspace.

## Invariants

- A regional workspace credential never becomes a Global discovery credential.
- A workspace ID is never used to infer region; the reconciled route and stored
  binding carry it.
- The flag hides affordances but grants and revokes no authority.
- Background workspaces expose aggregate attention only, never directory rows or
  content, and open no sockets.
- A late activation may be retained but cannot replace a newer selection.
- Leaving one workspace cannot delete another workspace's credential, profile,
  query state, or draft.
- Abandonment retains data and is reversible only by a paired operator action;
  it is not deletion.
- Defensive polling cadence and device-count limits stay open until the team
  chooses their values.

## Failure modes

- A regional activation or attention request that proves the credential unusable
  removes that exact workspace entry; ordinary transport failures retain it.
- Failed attention reads keep the last values and label their relative update
  time. Discovery reconciliation removes a membership that has actually ended.
- An unreachable target region leaves the active workspace intact and reports
  that connectivity is required.
- Setup requests use UUIDv7 operation IDs. Reusing one with identical input
  returns the journaled result; changing action or payload under it is refused.
- Queue publication after membership transition is best effort, as documented in
  `access-revocation.md`; authorization fences still refuse every reconnect.

## Verification

Node tests cover plural schema, setup replay, departure races, stored-set
migration, activation intent ordering, draft scoping, and component states. The
attention aggregation and object admission fences run in the real workerd suite.
Local environment synchronization gives Global the local EU API route, and
`pnpm db:open-authority` opens and seeds both regional authorities so the same-ID
regional fixture can prove an actual Global → EU → Global desktop switch.
The complete manual Global/EU, offline, invitation, removal, sign-out, Lockdown,
and flag-off matrix lives in `e2e.md`.

## Changelog

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
