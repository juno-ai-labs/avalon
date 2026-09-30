# Impersonation

Impersonation is Rally's workspace-scoped authority for one authenticated member
to act as another member on a product surface that explicitly supports it. The
first surface is Sideline, an internal Electron host for sending an ordinary new
message as the represented participant. Product data keeps that participant as
the author; the audit database keeps the initiating operator and authorization
basis.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/workspace-impersonation-storage.ts` | Directed relationship storage, exact reads, idempotent grants, and revocation. |
| `apps/api/src/services/impersonation-service.ts` | Internal-operator gate, current membership and relationship checks, catalog construction, audit, and handoff to ordinary message admission. |
| `apps/api/src/routes/sideline.ts` | The authenticated catalog and new-message HTTP boundary. |
| `apps/api/src/services/demo-preparation.ts` | Creates the complete ordered relationship set for the people seated by one demo operation. |
| `apps/sideline/` | Narrow Electron host: Google sign-in, encrypted operator session, typed IPC, card state, and native handoff to Rally. |
| `packages/contracts/src/workspace-reach-watch.ts` | Holds a workspace socket for a host without one of its own and reports stale on a `workspace_reach_changed` event or a reconnect. Sideline's main process uses it for the operator's catalog. |
| `apps/sideline/scripts/stamp-release.mjs` | Replans on a moved `main` tip before stamping and emits the final commit and API gate. |
| `.github/workflows/release-sideline-macos.yml` | Frozen-commit verification, Developer ID signing, Apple notarization, artifact retention, and R2 publication. |
| `packages/contracts/src/impersonation.ts` | Relationship, catalog, and send wire contracts. |
| `packages/ui/src/components/sideline-composer.tsx` | Browser-safe card-stack presentation and searchable selectors. |
| `packages/ui/src/components/sideline-sidebar.tsx` | The left rail: Rally's Spaces sidebar parts with one **Impersonate** row, the update button, and the account footer whose menu holds the Organization picker and **Sign out**. |

## How it works

WorkspaceDO migration 67 stores producer-scoped grants for a directed
`impersonator_user_id` to `represented_user_id` relationship, with each grant's
authority basis and revocation state. Producers call the WorkspaceDO writer; reads never infer an edge from
roles, workspace names, or demo records. Demo preparation is one producer and
writes every ordered pair of seated users, including self-pairs, in one
idempotent call.

Sideline authenticates an ordinary Rally user with the dedicated
`sideline://auth/complete` PKCE callback. Its main process keeps the refresh
token in an encrypted session file and exposes only named operations to the
sandboxed renderer. The catalog service returns active represented members and
the Channels and Breakouts each represented member can currently see. Per
person it reads the Channel directory, then asks the Organization object once,
through `listVisiblePrivateChildrenForParents`, for that person's Breakouts
across all of those Channels.

The catalog always includes the signed-in operator through their ordinary
membership and adds other participants from active relationships. When the
operator selects themselves, Sideline calls the generic authenticated
conversation-message API; no impersonation relationship or dual-principal audit
is involved. A represented send still enters the regional impersonation
service, which first writes a content-free attempt audit, then rechecks
internal-sidecar eligibility, both active memberships, the exact directed
relationship, and the destination under the represented participant. Both
paths reach the existing `ConversationService` and conversation object's
`createMessage` method with the caller's idempotency key. The message and all
downstream addressing, realtime, participation, and harness behavior remain the
ordinary path. A separate result audit for represented sends correlates the
operator, represented participant, relationship basis, destination, outcome,
and canonical turn id. Sideline stops at that direct response.

The catalog follows membership without polling. Sideline's main process holds
one workspace socket for the operator and hears `workspace_reach_changed` when
anyone in the catalog joins or leaves a Channel or Breakout, or the operator's
own relationships change ([`realtime-sockets.md`](realtime-sockets.md) owns the
event). It also treats every subscribe answer as stale. The renderer then
rereads the catalog in the background with the cards left on screen; events
that arrive during a read collapse into the one read that follows it. A card
whose participant or destination left the catalog keeps its draft, names what
went away, and cannot send.

## Packaging, release, and updates

Sideline is a separate macOS application with bundle identifier
`ai.rallywith.sideline` and the `sideline:` protocol. It shares Rally's Apple
Developer team, Developer ID Application certificate, App Store Connect API key,
GitHub `desktop-release` environment, public download origin, and R2 bucket. It
does not share Rally's bundle identifier, release version, update manifest, or
object prefix.

The **Release Sideline for macOS** workflow runs when a merge to `main` changes
the Sideline app, its shared UI or contracts, workspace install/build inputs, or
the shared macOS release helpers it consumes. Inside one non-cancelling release
queue, the verification job compares the current tip with the newest reachable
`sideline-v<version>` tag. It skips a stale queued run with no remaining release
inputs, keeps `0.1.0` for the first release, and otherwise advances Sideline's
patch version. If a concurrent workflow moves `main` before stamping, it
replans on the new tip and recomputes the API deployment gate. The workflow
commits the version to `main`, freezes the exact commit, then runs lint,
typecheck, Sideline tests, and the portable
release-tooling tests before claiming an Apple Silicon runner. That runner
imports the existing Developer ID identity, builds the arm64 app with hardened
runtime, notarizes and staples the application and DMG, verifies both ZIP and
DMG contents, and retains the exact release directory as a GitHub artifact for
30 days. A separate publication job downloads that artifact, so retrying a
failed publication never repeats signing or notarization and never substitutes
new bytes under the same versioned names. When shared contracts changed,
distribution waits for the successful API deployment associated with the newest
first-parent commit that introduced them to `main`. A manual dispatch uses the
same planner when no signed artifact exists; release versions are no longer
bumped by hand. The packaged contract tree and the deployment revision checked
by the gate come from the final successful plan.

Publication uses the existing desktop-release bucket under the disjoint prefix
`sideline/stable/darwin/arm64/`. Versioned ZIP, DMG, and blockmap objects are
immutable after `latest-mac.yml` commits their version. Before that commit, a
selected preserved artifact can reconcile objects left by an interrupted
attempt. The publisher verifies each candidate against R2, purges the Sideline
channel prefix, then SHA-512 checks the exact public URLs. A failed check leaves
the manifest where it was; retrying the failed publication job reads the same
signed artifact. Only `latest-mac.yml` and `Sideline.dmg` are mutable. The
canonical DMG is hash-verified against R2, then fully SHA-512 checked at its
exact public URL. The manifest moves last, after the versioned payloads and
canonical installer are publicly verified, so a retry after commit verifies
that the live manifest is byte-identical to the local release before it finishes
the release tag. The channel prefix is purged again after the manifest upload
before its exact URL is verified. Both the version-stamping job and the final
publication boundary refuse a candidate tag that already exists. The embedded
generic-provider URL points only at that prefix. A signed release build on
packaged Apple Silicon checks it at launch and every three hours, downloads in
the background, and then shows a restart button (Tabler `device-desktop-down`)
in the sidebar header, and **Restart to Update** in the account menu, without
interrupting. The native restart dialog appears
only once the running build is more than 48 hours old
(`STALE_BUILD_PROMPT_AGE_MS` in `src/main/updater.ts`), once per downloaded
version; the age comes from `__SIDELINE_BUILD_TIME__`, stamped into the main
bundle by `electron.vite.config.ts`, and an unstamped build never prompts. Its
application menu also exposes **Check
for Updates…** for an immediate manual check through the same updater. The item
remains visible but disabled when updates are unavailable. Development, unsigned local packages,
non-macOS, and non-arm64 builds never contact the production feed.

## Invariants

- A relationship is directional and workspace-scoped; reversing either user or
  changing the workspace denies the action, preventing authority from being
  inferred from proximity or membership.
- Acting as yourself is ordinary authenticated authority, not impersonation;
  self-pairs neither gate nor audit that path.
- Demo state is never an authorization input. Coupling the read path to the demo
  register would turn a platform relationship into a hidden demo capability.
- The attempt audit succeeds before message admission. Otherwise a represented
  effect could exist without a durable record of the actual operator.
- Message and transcript schemas contain no impersonation field. Adding one
  would fork ordinary rendering, export, projection, and harness contracts for
  an authorization fact already owned by audit.
- The same logical retry keeps the same client message id, so the existing
  admission receipt is the only duplicate-send authority.
- The sidecar never observes post-admission work. It opens no conversation feed
  and reads nothing from its workspace socket but membership nudges; a feed
  would make it a second conversation client and invite it to infer harness
  outcomes.

## Boundary

This module owns the relationship, the impersonation authorization branch,
dual-principal audit correlation, and Sideline's host adapter. The represented
participant's ordinary conversation authority remains in
`ConversationService`, WorkspaceDO (including the Channel's hosted parent), and
SubstreamAgent. Message
addressing and harness execution remain owned by the standard durable
conversation loop documented in [workstream-durable-object.md](workstream-durable-object.md).

Only trusted Worker code can write relationships. Sideline cannot administer
them, retrieve transcript history, answer elicitations, choose a region or
arbitrary Organization id, or obtain a represented user's credential. Its
current-user send uses the generic conversation API with its own session; its
represented send uses the impersonation endpoint.

## Failure modes and limits

An absent or revoked relationship, inactive membership, retired Organization,
or stale destination fails before admission and receives a safe result audit.
If the attempt audit cannot be written, no represented effect starts. A known
HTTP rejection is retryable as a new logical send; a lost network response is
reported as unknown and retains the same idempotency key. Existing message-size
and admission limits apply unchanged. There is no sidecar-specific card,
frequency, concurrency, timeout, or session limit.

Catalog failure leaves drafts visible but unsendable. A failed background
reread keeps the catalog already on screen, and the next nudge or subscribe
reads again. A change to what a person can see without a join or leave (a
Channel's scope, a new workspace-scoped Channel, an archive) is not nudged and
appears on the next reread. A refused workspace-socket handshake or ticket is
logged by name in the main-process terminal; the catalog then refreshes only
on sign-in until the socket connects. A token refresh that fails without the
server refusing the token (offline, a 5xx) keeps the session and its drafts.
Sign-out and process exit
discard drafts and direct results. A successful direct response is final from
Sideline's perspective even when later addressing or harness work fails.

## Testing

`apps/api/test-workers/workspace-impersonation.test.ts` applies the real
WorkspaceDO migrations and proves direction, self-pairs, idempotent setup, and
revocation in workerd. `apps/api/test-workers/sideline-catalog.test.ts` builds
the catalog against the real Organization object and D1 for an operator and one
represented person over three Channels, and pins each person's destinations
and one Breakout read per person. Demo preparation tests cover the producer phase. API
tests cover access, membership, relationship, destination, audit, self-send, and
cross-participant admission boundaries.
`apps/api/test-workers/workspace-reach-changed.test.ts` proves on real sockets
that a Channel or Breakout join or leave reaches the person and their
operator, and nobody else, and that an unread-only projection stays quiet.
The listener's own tests (`packages/contracts/src/workspace-reach-watch.test.ts`)
cover subscribe, heartbeat, reconnect, ticket failure and revocation. Sideline
tests cover the stale-selection notices, stable-versus-unknown
retry classification, the auto-update host policy, and the shared composer's
empty and validation states; its build covers the isolated main, preload, and
renderer bundles. Release-tooling tests cover update-feed structure and the
publication order through in-memory R2 and public-cache adapters. Run:

```bash
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/workspace-impersonation.test.ts test-workers/workspace-reach-changed.test.ts test-workers/sideline-catalog.test.ts
pnpm --filter @rally/api exec vitest run test/impersonation-service.test.ts test/demo-operations.test.ts
pnpm --filter @rally/sideline test
pnpm --filter @rally/sideline build
pnpm --filter @rally/sideline test:release
```

## Data model

`workspace_impersonation_relationships` is keyed by workspace, impersonator,
represented user, and authority basis. Each producer therefore owns an
independent grant, and revoking one authority basis cannot remove another
producer's authorization for the same pair. Re-granting the same exact
producer-owned edge is an upsert, not a second row. Audit rows live in the existing independent
`audit_events` database and contain a SHA-256 content digest rather than the
message body.

## Regional impact

The selected regional session determines the immutable Organization region.
Relationship authority lives in that Organization's WorkspaceDO; membership,
destination admission, audit, message content, and conversation state stay in
the same configured deployment. Global identity establishes and selects the
regional session but never receives represented message content.

## Security and trust model

Renderer IDs, labels, and messages are untrusted. The regional service derives
the operator from the bearer session and the effective participant from current
canonical state. Sideline uses `contextIsolation`, sandboxing, no Node
integration, denied navigation/popups, a renderer CSP with no network access,
validated IPC inputs, encrypted main-process session storage, and no packaged
operator key. It registers only `sideline:`, while **Open in Rally** emits the
existing `rallywithai:` deep link for the main app.

## Changelog

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
