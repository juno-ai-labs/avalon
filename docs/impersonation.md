# Impersonation

Impersonation is Rally's authority for one authenticated person to act as
another. **Rally access** lets Rally staff (members of Juno Labs) open a whole
session as any member or guest of another Organization, for as long as that
Organization's seven-day grant lasts. Product data keeps the represented person
as the author; the audit database keeps who actually acted.

Beneath it sits a workspace-scoped, directed **can impersonate** relationship
between two members, kept by the Organization object and written by demo
preparation. No surface reads the relationship today: its one reader was
deleted on 2026-11-06 with the Canvases and Sidekicks pivot (the changelog
says what it was). The relationship, its storage and its producer stay as the
platform primitive a later represented-action surface would build on.

## Where the code lives

| Path                                                                                            | Responsibility                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/durable-objects/workspace-impersonation-storage.ts`                               | Directed relationship storage, exact reads, idempotent grants, and revocation.                                                                                                                                                            |
| `apps/api/src/durable-objects/workspace-do.ts`                                                  | `upsertImpersonationRelationships`, `listImpersonationRelationships`, `authorizeImpersonation` and `revokeImpersonationRelationships`, the only way in. |
| `apps/api/src/services/demo-preparation.ts`                                                     | Creates the complete ordered relationship set for the people seated by one demo operation.                                                                                                                                                |
| `packages/contracts/src/impersonation.ts`                                                       | Relationship, upsert and revoke wire contracts.                                                                                                                                                                                           |
| `packages/db/migrations/0122_support_access.sql`                                                | `support_access_grants` and `sessions.impersonator_user_id`.                                                                                                                                                                              |
| `apps/api/src/services/support-access.ts`                                                       | Rally access: the hard-coded staff Organization, the seven-day grant, staff discovery and roster, starting a support session, `supportSessionLiveSql` (the one definition of a live support session) and `revokeSupportSessions`.         |
| `apps/api/src/services/session-authentication.ts`, `auth-service.ts`                            | Every request and every renewal re-checks a support session with `supportSessionLiveSql`; renewal never moves its expiry past the grant's. `createSupportSession` is the one writer.                                                      |
| `apps/api/src/routes/workspace.ts`, `auth.ts`, `browser.ts`                                     | `GET/PUT/DELETE /workspace/support-access`; `/auth/support/*` for the Mac app's identity credential; `/browser/support/*` for the browser cookie.                                                                                         |
| `apps/desktop/src/main/index.ts`, `stored-auth.ts`                                              | The support credential stored like any Organization credential and marked by its profile's `impersonator`; dropped whenever another Organization is selected; never registered for push.                                                  |
| `apps/desktop/src/renderer/components/support-access-setting.tsx`                               | **Allow Rally access** under Organization preferences.                                                                                                                                                                                    |
| `apps/desktop/src/renderer/components/support-workspace-menu.tsx`, `workspace-account-menu.tsx` | A granting Organization's row in the account menu and its submenu of people; **End impersonation** in place of signing out; the account tile in the section switcher shows the staff member's avatar over its corner.                     |

## How it works

WorkspaceDO migration 67 stores producer-scoped grants for a directed
`impersonator_user_id` to `represented_user_id` relationship, with each grant's
authority basis and revocation state. Producers call the WorkspaceDO writer; reads never infer an edge from
roles, workspace names, or demo records. Demo preparation is one producer and
writes every ordered pair of seated users, including self-pairs, in one
idempotent call.

Nothing reads a relationship for authority today; the one surface that did
was deleted with its endpoint, its regional service and its catalog (see the
changelog). `AuthContext.principal` keeps its `impersonation` value, and
`AgentLoopDO` still answers `impersonation_member_revoked` for it, though no
caller sets it now. A surface that brings the relationship back into use
starts from the invariants below, which record what that surface's send path
had to guarantee.

### Support access

Rally staff are the active **members** (not guests) of Juno Labs, whose
Organization id is hard-coded as `SUPPORT_ORGANIZATION_ID`; local development
uses its seeded Organization instead. Nothing else makes somebody staff.

An owner or administrator of any other Organization presses **Grant access**
under **Settings → Organization → Allow Rally access**. `PUT
/workspace/support-access` upserts the Organization's one
`support_access_grants` row with an expiry seven days out, and `DELETE`
removes the row. The row offers **Grant access** only while no grant is live. Every member can read the
state, which the settings row counts down against the shared clock. A support
session cannot grant (`support_access_grant_requires_member`), so staff cannot
extend access nobody gave them; it can revoke.

A staff member's account menu reads `GET /auth/support/workspaces` with the
account's identity credential (the browser uses its cookie's identity session).
It lists every Organization with a live grant, with a spy mark beside it.
The app reads that list when it starts and again every ten minutes in the
background (`useSupportWorkspaces`), never when the menu opens. **View →
Refresh Organization List** in the Mac app rereads it at once.
Opening a row reads that Organization's members, then guests. Choosing a person
calls `POST /auth/support/session`, whose single `INSERT … SELECT` writes a
session for the represented person only if the grant is live, the caller is
staff, and the person is an active member or guest. Its
`impersonator_user_id` names the staff member, `impersonator_incarnation` the
staff membership that admitted them, and its expiry is the grant's.
The answer is an ordinary `Session` with an `impersonator`.

From there the session is the represented person's in every way the platform
checks: the token's subject, membership, role, incarnation, socket admission and
every object's re-check all read the represented person, so staff see and do
exactly what that person can. What sets it apart:

- `authenticateSession` and renewal also require `supportSessionLiveSql`: a live
  grant for the session's Organization and a live staff membership for its
  `impersonator_user_id` with the same incarnation it was opened under, so a
  staff member removed and invited back does not bring an old session back
  with them. Renewal adds it to its own statement; authentication
  reads `impersonator_user_id` in the statement it was already making and runs
  the check as a second one only when that is set, so an ordinary session pays
  nothing for it. The answer carries `impersonatorUserId` on the auth context.
- Renewal keeps the session's expiry at or before the grant's.
- `touchLastSeen` skips it: staff being around is not the person being around.
- `refuseSupportSession` turns it away from `/auth/workspaces`,
  `/auth/workspace/select`, `/onboarding/*` and `/push-devices/*`. Those mint
  another credential or bind a device to the person, which would outlive the
  grant or reach beyond the Organization.
- Revoking the grant, and a Juno Labs relationship delivery that ends a staff
  membership (for that membership's incarnation only), call
  `revokeSupportSessions`. It expires the sessions at once and publishes
  [access revocations](access-revocation.md) so open sockets close; one whose
  announcement fails is left to the expiry sweep, which retries.
- The Mac app stores it as that Organization's credential with the impersonator
  on its cached profile. It is left out of the Organizations list, push
  registration and the account's own onboarding, profile and appearance (which
  belong to the signed-in account, i.e. the staff member). Selecting any other
  Organization, or another person in the same one, drops and revokes it.
  **End impersonation** revokes it and returns to the Organization the device
  used before.
- Composer drafts are keyed by Organization and conversation, not person, so
  entering or leaving a support session clears that Organization's drafts on
  both hosts, while the staff member's drafts elsewhere stay.
- The browser puts it in the Organization's slot of its cookie session
  (`browser_workspace_sessions`), replacing whatever was there, and
  `/browser/support/end` takes it out again.

The footer shows the represented person and, on the right, the staff member's
avatar; signing out reads **End impersonation**.

Grants, revocations and session starts are written to `audit_events`
(`support_access.granted`, `support_access.revoked`, `support_session.started`)
with the acting person and, from a support session, the staff member behind it.
A grant and a session start are recorded before they take effect, so access is
never live without its record; a write that then fails leaves a record of an
attempt. A revocation is recorded after it, since the failure there is the safe
one.
Every write a support session makes is also recorded, after it runs and off
the response path, so it adds no latency: a non-GET HTTP request as
`support_session.request` (method, path, status) from `auditSupportWrites` in
`apps/api/src/middleware/auth.ts`, and a conversation socket command that writes
(sending a message, editing, reacting, and the like) as
`support_session.socket_command` from `AgentLoopDO`. Both carry the staff
member as actor, the person as target, and the session id. Reads are not
recorded. A failed write to the audit database is logged
(`support_action_audit_failed`) and does not fail the action; the session row
still says who held the session.

A support session looks without leaving a trace on the person's own state. It
does not mark a conversation opened or read, does not advance or set unread
(`acknowledge_read` and `mark_unread` succeed without an effect), and counts
in nobody's presence or viewer list. The socket ticket carries the staff
member (`imp`), and `SocketService` and `WorkspaceSocketService` pass it to the
Durable Objects as `x-rally-socket-impersonator-id`, which store it on the
socket. A message sent from the session still moves the person's seen marker
past it, as anyone's own message does, and analytics are unchanged.

## Invariants

- A relationship is directional and workspace-scoped; reversing either user or
  changing the workspace denies the action, preventing authority from being
  inferred from proximity or membership.
- Acting as yourself is ordinary authenticated authority, not impersonation;
  self-pairs neither gate nor audit that path.
- Demo state is never an authorization input. Coupling the read path to the demo
  register would turn a platform relationship into a hidden demo capability.
- A represented action writes its attempt audit before it takes effect, then
  rechecks both memberships, the exact directed relationship, and the target
  under the represented person. Otherwise a represented effect could exist
  without a durable record of the actual operator.
- Message and transcript schemas contain no impersonation field. Adding one
  would fork ordinary rendering, export, projection, and harness contracts for
  an authorization fact already owned by audit.
- A support session is an ordinary `sessions` row of the represented person.
  Giving it a different principal would fork every authorization path that
  re-reads `sessions`; the extra fact it carries is checked beside them.
- Only a member of the staff Organization is staff, and only a live grant admits
  a support session. Both are re-checked on every request and renewal, never
  cached, so a revoke or a removal takes effect on the next request.
- A support session cannot grant Rally access, start another one, mint any
  other credential, or register a device for the person's notifications.
- A support session is bound to the staff membership incarnation that opened
  it, as an ordinary session is to its own membership's.
- A grant and a support session are audited before they exist. A write made
  from the session is audited after it, in the background, and never waits on
  or fails because of the audit database.
- A support session leaves the person's read state and presence alone. A new per-person mark (seen, opened, visited) checks
  `impersonatorUserId` on the request or socket the same way.
- A support session never outlives its grant. What it creates (an invitation,
  a connection) is the Organization's and stays, as anyone's would. Renewal is capped at the grant's
  expiry, which is also what lets the ordinary expiry sweep close its sockets.

## Boundary

This module owns the relationship, its storage and producers, and Rally
access. The represented person's ordinary authority remains in
`ConversationService`, WorkspaceDO, and AgentLoopDO; a support session is
checked there as that person.

Rally access does not use the **can impersonate** relationship: its authority is
the Organization's grant plus Juno Labs membership, and it covers every person
in the Organization at once. The two share only the vocabulary and the audit
database.

Only trusted Worker code can write relationships; no client endpoint
administers them.

## Failure modes and limits

A support session fails closed: a revoked or expired grant, or a staff member
who left Juno Labs, ends it on the next request and closes its sockets. There
is no support-session-specific frequency, concurrency, or timeout limit beyond
the grant's seven days.

## Testing

`apps/api/test/support-access.test.ts` runs Rally access against the
checked-in migrations: staff-only discovery and roster order, the session's
impersonator and its expiry capped at the grant across a renewal, the refusal
without a grant, who may grant, and that a revoke, an expired grant, or leaving
Juno Labs each end a live session on the next request (and a revoke publishes
its socket revocation). It also opens and ends a support session in a browser
cookie's Organization slot, and records an audit row for a write made from
the session and carries the staff member in its workspace socket ticket.
The workerd proof that a support session's reads and socket leave the
person's read state alone, that a socket write is audited and that the socket
is not a viewer went with `unseen-workstream-state.test.ts` in plan step C-2
and has not been replaced against a Canvas's Chat. `apps/desktop/src/renderer/components/support-access.test.tsx`
covers the settings row's countdown and buttons and the account menu's rows,
submenu and **End impersonation**; `src/main/workspace-directory.test.ts`
covers how a stored support credential is told apart.

`apps/api/test-workers/workspace-impersonation.test.ts` applies the real
WorkspaceDO migrations and proves direction, self-pairs, idempotent setup, and
revocation in workerd. `apps/api/test/demo-operations.test.ts` covers the
producer's ordered pairs.
Run:

```bash
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/workspace-impersonation.test.ts
pnpm --filter @rally/api exec vitest run test/support-access.test.ts test/demo-operations.test.ts
```

## Data model

`workspace_impersonation_relationships` is keyed by workspace, impersonator,
represented user, and authority basis. Each producer therefore owns an
independent grant, and revoking one authority basis cannot remove another
producer's authorization for the same pair. Re-granting the same exact
producer-owned edge is an upsert, not a second row. Rally access's audit rows
live in the existing independent `audit_events` database.

## Regional impact

Rally access assumes the staff Organization and the granting Organization share
a deployment, which is true while Global is the only one: discovery lists only
Organizations in the caller's region, and a support session is written in the
same D1 statement that checks staff membership. A second deployment needs the
grant list and the staff check to cross the identity bridge.

Relationships live in the Organization's WorkspaceDO, in the Organization's
own region, beside the memberships they relate.

## Security and trust model

A support session's authority is re-derived on every request from
`supportSessionLiveSql`, never from the client: the staff member, the grant and
the represented person's membership are all read from D1. Clients cannot write
relationships.

## Changelog

### 2026-11-06 — Sideline is deleted; the relationship stays

**What changed:** Sideline is gone: the `apps/sideline` Electron app, its macOS
release workflow, the `/sideline` catalog and send routes, the regional
`ImpersonationService` behind them (relationship-gated represented send, attempt
and result audits, and the per-person Channel and Breakout catalog), the
Sideline contract shapes, its shared composer and sidebar, its
`sideline://auth/complete` sign-in callback, and its `app://sideline` socket
origin. The **can impersonate** relationship, its WorkspaceDO storage and RPCs,
the demo producer, the `workspace_reach_changed` nudge on a relationship change,
and Rally access are unchanged.

**Why:** The Canvases and Sidekicks PRD
(`docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`, decision of 2026-11-06,
"iOS, Sideline, browser import and Thread-scoped Sidekicks") retires Threads.
Every Sideline destination was a Thread, so it had no home after the pivot; the
product owner chose deletion over porting it.

**Considered and rejected:** Keeping `ImpersonationService` and its represented
send for a later surface. With its only route gone it had no caller, and its
request and catalog shapes named Sideline and Thread destinations, so keeping
it meant inventing a new contract for a surface nobody has asked for. Deleting
the relationship as well, which would discard a working platform primitive
whose demo producer still runs.

**Consequences:** No represented action exists today; the relationship is
written but read only by the reach nudge. A surface that brings it back owns the
attempt-before-effect audit and the rechecks the invariants list, and can start
from the service this change deleted. `principal: "impersonation"` and
`impersonation_member_revoked` remain in the auth enums with no producer.
`AccountTrigger` and `SidebarCollapseFooter` in `@rally/ui` lost their only host
and are left for the shared-UI pruning that follows.

PRD: `docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md` (step B-10 of its plan).

### 2026-10-07 — The Rally access list rereads on a timer, not on open

**What changed:** Staff's list of granting Organizations is reread every ten
minutes in the background instead of each time the account menu opens, and the
Mac app's View menu gained **Refresh Organization List**, which rereads it at
once. The account's own Organizations still reread when the menu opens.

**Why:** A read started on open finished after the menu was drawn, so a newly
granted Organization appeared a moment later and pushed the rows below it down.
Adam chose the ten-minute timer and the menu item on 2026-10-07.

**Considered and rejected:** Starting the read when the pointer reaches the
account button, which only narrows the race. Pushing grants to staff sessions,
which nothing else needs yet.

**Consequences:** A grant can take up to ten minutes to appear unless staff use
the View menu item. A revoked grant can stay listed as long; choosing a person
there is refused by the server, as before.

PR [#1159](https://github.com/juno-ai-labs/avalon/pull/1159), following
[#1152](https://github.com/juno-ai-labs/avalon/pull/1152).

### 2026-10-07 — Rally access: staff sessions as another Organization's people

**What changed:** Rally access, described under
[Support access](#support-access): a seven-day grant from Organization
preferences, and staff sessions as the granting Organization's people.

**Why:** Rally staff set up, configure and support customers' Organizations
hands-on, and need to see and do exactly what a given person can. Asked for
by Adam on 2026-10-07, who named the seven calendar days, the hard-coded staff
Organization, and the menu, footer and settings design.

**Considered and rejected:** Reusing the **can impersonate** relationship,
which would need a row per staff member per person per Organization and a
producer to keep them in step with a grant, for an authority that is really
"this Organization lets Juno Labs in". A separate principal for support
sessions, which would fork every path that re-reads `sessions`. Caching the
grant or staff check, which would let a revoke lag.

**Consequences:** Anything that authorizes from `sessions` treats a support
session as its person, by design; a new check that must not (like granting
access, or minting another credential) reads `impersonatorUserId`. Durable
things a session creates as an administrator (an invitation, a role change, a
connection) outlive the grant like any administrator's. Identity-scoped account state (onboarding,
profile, appearance) is the staff member's and is hidden on a support session.
Each write from a support session is audited in the background, and the
session leaves the person's read state, recency and presence alone: Adam asked
for both, with the audit kept off the response path. A second
deployment needs the staff check and grant list to cross regions.

PR [#1152](https://github.com/juno-ai-labs/avalon/pull/1152).

### 2026-10-01 — R2 reads abort on idle, not on total time

**What changed:** The publisher's R2 existence checks and post-upload hashes
download through `downloadReleaseObject` from the desktop release helpers,
instead of a `fetch` capped at 5 minutes of total time.

**Why:** The 0.1.42 publish uploaded its ~149 MiB DMG, then aborted while
reading it back to hash it, exactly 5 minutes in. The run was already signed
and notarized, and nothing went live. Rally's publisher had dropped the same
cap in #1037, but Sideline kept its own copy of the R2 read.

**Considered and rejected:** A longer wall-clock cap. Any fixed total-time
limit fails a healthy slow transfer of a large installer.

**Consequences:** A stalled read now fails fast instead of passing, and the
publish job is the cheap one to rerun. New R2 reads should reuse the shared
helper; a separate Sideline read path is how this drifted from Rally's.

### 2026-09-30 — A Rally-style sidebar, and updates that wait behind it

**What changed:** Sideline gained a left rail built from Rally's Spaces
sidebar parts (`ResizableSidebar`, `SidebarHeader`, `SidebarRow`,
`SidebarCollapseFooter`, `AccountTrigger`) and its classes. It lists a single
**Impersonate** row for now, and its account menu holds an **Organizations**
picker like Rally's and **Sign out**, which left the composer header. Choosing
an Organization selects a session for it with the current one, checks that
Sideline's catalog admits it, and only then swaps it in and revokes the old
session; a refusal leaves the operator where they were and names why under the
row. Sideline also no longer opens a restart dialog the
moment an update finishes downloading: the sidebar header and the account menu
offer the restart, and the dialog returns only when the running build is more
than 48 hours old, once per downloaded version.

**Why:** The rail gives Sideline the same shape as Rally and a place for more
tools than impersonation; reusing the parts and classes keeps the two rails one
design. The update change landed in Rally's desktop app at the same time, where
the dialog interrupted work on every release; Sideline ships as often. The team set
Sideline's threshold at 48 hours against Rally's seven days; the reasoning for
the shorter window was not recorded.

**Consequences:** The rail reuses `.spaces-sidebar` styling, so a change to
Rally's Spaces sidebar lands in Sideline too; width and collapse are not yet
saved across launches. Install-on-quit still applies, so a person who never presses
the button updates at their next quit. A build without the timestamp (local
and test builds) never prompts.

PR [#1029](https://github.com/juno-ai-labs/avalon/pull/1029).

### 2026-09-28 — The catalog reads each person's Breakouts in one call

**What changed:** For each person in the catalog, the service asks the
Organization object once, through `listVisiblePrivateChildrenForParents`, for
their Breakouts across every Channel their directory lists, instead of calling
`listVisiblePrivateChildren` once per Channel; the object answers from
`visiblePrivateChildren`'s single multi-parent statement, the one the sidebar's
control socket uses. A person with no Channels makes no Breakout call. The
single-parent RPC is gone.

**Why:** Production measurements on 2026-09-27 showed the catalog making 92
Organization calls to open, and it rereads in the background on every
`workspace_reach_changed`. Every Channel is a hosted parent of that one
object, so the per-Channel calls were round trips to the same place; the count
grew with people times Channels.

**Considered and rejected:** Looping the per-parent read inside the object,
which kept its `conversation_parent_missing` throw for a parent it does not
host. The catalog already treats a Channel with no answer as having no
Breakouts, its Channels come from this object's own directory, and one missing
parent failing the whole catalog for every person is the worse outcome.

**Consequences:** The catalog now costs one relationship read plus two calls
per person (directory page and Breakouts). A new per-Channel detail in a
destination belongs in the batched read, not in a loop around it.

### 2026-09-28 — The API gate waits for a deployment it cannot list yet

**What changed:** When no `deploy-api.yml` run contains the contract commit,
the shared-contract API gate checks again every 30 seconds instead of failing,
and fetches `main` before each check. The job's timeout bounds the wait. It also
filters runs itself rather than through GitHub's `branch` and `event` query
filters, and stops at the first run older than the contract commit.

**Why:** The #1007 merge (`a34092be`) failed Sideline's gate with "No
main-line API deployment contains contract commit" while that commit's own API
deployment was in progress on the same push. The listing did not return the
in-progress run, so the gate walked every completed ancestor for about 40
seconds and exited. The API run finished green about nine minutes later. Why
the run was missing was not observed; the filtered query may omit a run just
created.

**Considered and rejected:** Failing fast and rerunning by hand, which is what
this replaces and which costs a full lint and typecheck per attempt.

**Consequences:** Every contract change matches `deploy-api.yml`'s `packages/**`
path, so a missing run means one not listed or created yet. A gate that truly
finds none now fails at the job timeout rather than at once. Adam set the
30-second interval: about 90 `GITHUB_TOKEN` calls over a full 45-minute wait,
against 1,000 an hour.

### 2026-09-24 — Sideline's catalog follows membership changes

**What changed:** Sideline's main process holds the operator's workspace socket
and rereads the catalog in the background on `workspace_reach_changed` or on
any subscribe answer. The composer names a chosen participant or destination
that left the catalog and keeps the draft. Token refresh is now single-flight
and ends the session only when the server refuses the refresh token.

**Why:** The dropdowns reflected sign-in time. When someone was added to a
Breakout mid-demo, the operator had to restart Sideline to send there, and a
removal only showed up as a rejected send.

**Considered and rejected:** Polling the catalog, which contradicts the latency
goal and adds a timer number nobody set. The event's own design and its
alternatives are recorded in [`realtime-sockets.md`](realtime-sockets.md).

**Consequences:** The socket is the first unattended caller of token refresh,
which is why refresh had to become single-flight and stop treating a network
failure as sign-out. `ALLOWED_ORIGINS` must admit `app://sideline`.

### 2026-09-23 — Replan a Sideline stamp after main moves

**What changed:** Sideline now plans and stamps in one verification job. When a
concurrent release stamp wins the push to `main`, Sideline fetches the new tip,
recomputes its release version and shared-contract API deployment gate, and
tries the stamp again. The successful plan's commit feeds verification, signing,
artifact naming, and publication.

**Why:** Rally and Sideline have independent release queues but both stamp
`main`. Rally's 1.446.0 bump landed between Sideline's plan and stamp, causing
the 0.1.6 run to fail before building even though no Sideline publisher held its
queue. A later bot-authored bump does not necessarily trigger another Sideline
workflow, so failing for a manual replan can strand a relevant release.

**Considered and rejected:** Combining both application releases into one long
workflow would couple their signing and failure lifecycles and still leave
ordinary merges able to advance `main`. Resetting to the new tip under the old
plan would sign code whose contract deployment gate had not been recomputed.

**Consequences:** A lost stamp push can retry without changing the immutable
artifact or publication stages. The final planned tip, API gate, and stamped
commit must stay together; verification and signing never follow a newer tip
after the stamp succeeds.

### 2026-09-22 — Retry publication from one signed artifact

**What changed:** Signing and notarization now finish in an artifact-producing
job. A separate job publishes the preserved artifact and records the tag. A
failed publication retries only that job. The publisher checks R2 bytes, purges
the Sideline channel prefix, and fully hashes the exact public URLs before
moving the feed.

**Why:** The 0.1.3 publisher uploaded the correct installer, but the configured
`desktop-release` Cloudflare zone ID was not the `rallywith.ai` zone. Purge
requests succeeded against the wrong zone while the runner's PoP continued
serving the previous DMG to the full-body hash check. The release stopped
before moving the manifest. A failed-job retry then rebuilt different
notarized bytes and hit the same stale-cache failure at the overwritten
versioned DMG. Correcting the environment's zone ID let a publish-only retry
verify the exact public URLs, move the feed, and tag the stamped commit.

**Considered and rejected:** A cache-busting query would check a different cache
key, leaving the updater's exact URL unproved. Rebuilding on retry changes
notarized bytes while reusing versioned names and can strand the CDN on a prior
candidate. Longer retries do not fix that identity problem.
The manual publish-only dispatch used to recover 0.1.3 is not retained: a failed
publication job can now be rerun against its preserved artifact directly.

**Consequences:** The manifest stays the commit point. A stale CDN response can
still fail a publication attempt, but the next publish-only retry uses identical
bytes. The exact updater and recovery-installer URLs must serve those bytes
before the feed moves. A channel prefix purge evicts other Sideline download
objects as well; Rally's separate prefix is unaffected.

### 2026-09-22 — Current-user sends use ordinary message authority

**What changed:** Sideline's catalog includes the signed-in operator without a
self-impersonation grant. Selecting that participant sends through the generic
authenticated conversation-message API, while selecting somebody else keeps
using the relationship-gated, dual-principal impersonation endpoint. The old
Sideline endpoint also admits a self-send through ordinary authority for
rolling-release compatibility, records no impersonation audit for it, and
preserves the request-received timestamp for message telemetry. The composer
labels the mixed self and represented send surface accordingly.

**Why:** Acting as the signed-in user is not impersonation. Requiring a
self-pair made an ordinary member action depend on a separate administrative
grant and described the resulting audit as two-principal activity when there
was only one principal.

**Considered and rejected:** Giving every operator a self-pair would preserve
one transport at the cost of the wrong authority model. Giving Sideline a
conversation socket would add a transcript client, subscriptions, and recovery
state to a command-only tool.

**Consequences:** Sideline can send as its current user in any visible writable
Channel or Breakout without relationship setup. Represented sends retain their
existing authorization and audit guarantees. Rally's conversation UI remains
on its lower-latency socket command path.

### 2026-09-21 — Sideline release recovery and app identity

**What changed:** Sideline's release planner now searches first-parent history
when identifying a shared-contract change, then accepts the newest main-line
API deployment whose commit contains that change. Sideline also owns its
supplied macOS icon and exposes a standard **Check for Updates…** menu command
backed by the existing updater.

**Why:** A merge commit can contain a contract change from its second parent,
but deployment workflows run for the merge SHA pushed to `main`, not the
feature-branch commit. Following unrestricted history selected that
feature-branch SHA and blocked the resumable `0.1.1` release even after its API
deployment succeeded.
An exact merge-SHA match could fail again when the API deployment queue
collapsed that run into a newer main-line deployment containing the same
contracts.
Sideline otherwise inherited Rally's icon and gave operators no visible way to
request the updater check that already happened automatically.

**Considered and rejected:** Dispatching or fabricating an API deployment for
the feature SHA would bind release coordination to a commit that never entered
`main`. Removing the gate would restore the client-before-API race it prevents.

**Consequences:** Contract-driven Sideline releases wait on the newest API run
that contains the main-line contract change, including a successor run selected
by the API deployment queue. The existing unpublished version remains the retry
authority and does not need to be reverted. Installed release builds are
visually distinct and can request an update check from the application menu
without changing download or restart behavior.

### 2026-09-21 — Relevant main changes automatically rebuild Sideline

**What changed:** Sideline's macOS release workflow now watches its application,
shared UI and contracts, workspace build inputs, and shared desktop release
helpers. A queued planner uses the last Sideline tag as a watermark, advances an
independent patch version, and skips stale runs whose inputs were already built.
Contract-driven builds wait for the API deployment produced by the newest
contract commit, and candidate tags are checked again immediately before R2
publication. Version stamping is bound to the exact tip the planner classified
and must replan if `main` advances.

**Why:** Sideline already had an isolated R2 update channel, but its manual-only
workflow could leave installed copies behind changes that had merged to the
application or a shared dependency.

**Considered and rejected:** Releasing every queued trigger without a watermark
would publish empty versions when a prior run included a newer main tip. Reusing
Rally's version or release record would couple two independent update channels.

**Consequences:** A relevant merge can claim the signed macOS release lane and
publish an update without a human version bump. The release tag remains the
durable build watermark, failed untagged versions remain resumable, and a
client built from new shared contracts cannot publish ahead of their API.

### 2026-09-21 — One platform relationship feeds the first represented-action surface

**What changed:** Rally gained a directed workspace-scoped **can impersonate**
relationship, dual-principal attempt/result auditing, and Sideline as its first
surface. Demo preparation creates relationships but demo status does not grant
or constrain them. Sideline is packaged as its own signed and notarized macOS
application and owns an isolated auto-update feed within Rally's existing R2
release bucket.

**Why:** Live multiplayer demonstrations need operator-timed participant turns,
while reusing the scripted `demo_seed` path would bypass ordinary addressing and
the production harness. The authority also needs to remain reusable for later
support surfaces without inventing another way to decide who may represent whom.

**Considered and rejected:** A demo-only endpoint, participant credential
recovery, a second transcript writer, and capability-specific impersonation
grants. Each either forks standard product behavior, exposes the wrong
credential, or makes one relationship answer a growing matrix of product policy.

**Consequences:** Every supporting surface must explicitly opt into
impersonation, reapply the represented participant's ordinary authority, and
write audit before effects. Relationship administration and support operate-as
sessions remain separate future product work. Sideline releases reuse the
existing Apple and Cloudflare credentials but advance their own package version
and tag; they cannot promote or overwrite Rally's update channel.

Design: `docs/PRDs/2026-09-19_impersonation-platform/prd.md`.
