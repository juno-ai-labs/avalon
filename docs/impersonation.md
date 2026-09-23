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
| `.github/workflows/release-sideline-macos.yml` | Frozen-commit verification, Developer ID signing, Apple notarization, artifact retention, and R2 publication. |
| `packages/contracts/src/impersonation.ts` | Relationship, catalog, and send wire contracts. |
| `packages/ui/src/components/sideline-composer.tsx` | Browser-safe card-stack presentation and searchable selectors. |

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
the Channels and Breakouts each represented member can currently see.

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
queue, a cheap planner compares the current tip with the newest reachable
`sideline-v<version>` tag. It skips a stale queued run with no remaining release
inputs, keeps `0.1.0` for the first release, and otherwise advances Sideline's
patch version. The workflow commits that version to `main`, freezes the exact
commit, then runs lint, typecheck, Sideline tests, and the portable
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
bumped by hand. Version stamping refuses to absorb a newer `main` tip after
planning, so the packaged contract tree and the deployment revision checked by
the gate cannot diverge; rerunning replans from that newer tip.

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
the background, and offers to restart after the update is ready. Its
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
- The sidecar never observes post-admission work. Polling or sockets would make
  it a second conversation client and invite it to infer harness outcomes.

## Boundary

This module owns the relationship, the impersonation authorization branch,
dual-principal audit correlation, and Sideline's host adapter. The represented
participant's ordinary conversation authority remains in
`ConversationService`, WorkspaceDO/WorkstreamDO, and SubstreamAgent. Message
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

Catalog failure leaves drafts visible but unsendable. Sign-out and process exit
discard drafts and direct results. A successful direct response is final from
Sideline's perspective even when later addressing or harness work fails.

## Testing

`apps/api/test-workers/workspace-impersonation.test.ts` applies the real
WorkspaceDO migrations and proves direction, self-pairs, idempotent setup, and
revocation in workerd. Demo preparation tests cover the producer phase. API
tests cover access, membership, relationship, destination, audit, self-send, and
cross-participant admission boundaries. Sideline tests cover stable-versus-unknown
retry classification, the auto-update host policy, and the shared composer's
empty and validation states; its build covers the isolated main, preload, and
renderer bundles. Release-tooling tests cover update-feed structure and the
publication order through in-memory R2 and public-cache adapters. Run:

```bash
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/workspace-impersonation.test.ts
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
