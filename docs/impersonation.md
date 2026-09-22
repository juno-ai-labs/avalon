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

WorkspaceDO migration 67 stores a directed `impersonator_user_id` to
`represented_user_id` relationship with its authority basis and revocation
state. Producers call the WorkspaceDO writer; reads never infer an edge from
roles, workspace names, or demo records. Demo preparation is one producer and
writes every ordered pair of seated users, including self-pairs, in one
idempotent call.

Sideline authenticates an ordinary Rally user with the dedicated
`sideline://auth/complete` PKCE callback. Its main process keeps the refresh
token in an encrypted session file and exposes only named operations to the
sandboxed renderer. The catalog service returns active represented members and
the Channels and Breakouts each represented member can currently see.

For a send, the regional service first writes a content-free attempt audit. It
then rechecks internal-sidecar eligibility, both active memberships, the exact
directed relationship, and the destination under the represented participant.
The existing `ConversationService` and conversation object's `createMessage`
method perform admission with the caller's idempotency key. The message and all
downstream addressing, realtime, participation, and harness behavior remain the
ordinary path. A separate result audit correlates the operator, represented
participant, relationship basis, destination, outcome, and canonical turn id.
Sideline stops at that direct response.

## Packaging, release, and updates

Sideline is a separate macOS application with bundle identifier
`ai.rallywith.sideline` and the `sideline:` protocol. It shares Rally's Apple
Developer team, Developer ID Application certificate, App Store Connect API key,
GitHub `desktop-release` environment, public download origin, and R2 bucket. It
does not share Rally's bundle identifier, release version, update manifest, or
object prefix.

The **Release Sideline for macOS** workflow is deliberately dispatched by hand.
It freezes the selected commit, requires the stable semantic version in
`apps/sideline/package.json` not to have a `sideline-v<version>` tag, then runs
lint, typecheck, Sideline tests, and the portable release-tooling tests before
claiming an Apple Silicon runner. That runner imports the existing Developer ID
identity, builds the arm64 app with hardened runtime, notarizes and staples the
application and DMG, verifies both ZIP and DMG contents, and retains the exact
release directory as a GitHub artifact for 30 days. Increase Sideline's package
version before dispatching another release.

Publication uses the existing desktop-release bucket under the disjoint prefix
`sideline/stable/darwin/arm64/`. Versioned ZIP, DMG, and blockmap objects are
immutable after `latest-mac.yml` commits their version; pre-manifest debris from
an interrupted build can be replaced by its retry. Only
`latest-mac.yml` and `Sideline.dmg` are mutable, and their exact public URLs are
purged and hash-verified after upload. The manifest moves last, after the
versioned payloads and canonical installer are publicly verified, so a retry
after commit only verifies the published bytes and finishes the release tag.
The embedded generic-provider URL points
only at that prefix. A packaged Apple-silicon build checks it at launch and every
three hours, downloads in the background, and offers to restart after the update
is ready. Development, unsigned, non-macOS, and non-arm64 builds never contact
the production feed.

## Invariants

- A relationship is directional and workspace-scoped; reversing either user or
  changing the workspace denies the action, preventing authority from being
  inferred from proximity or membership.
- Self-impersonation requires an explicit self-pair, so it follows the same
  grant and revocation path as every other represented action.
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
arbitrary Organization id, or obtain a represented user's credential.

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
renderer bundles. Release-tooling tests cover update-feed structure. Run:

```bash
pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/workspace-impersonation.test.ts
pnpm --filter @rally/api exec vitest run test/impersonation-service.test.ts test/demo-operations.test.ts
pnpm --filter @rally/sideline test
pnpm --filter @rally/sideline build
pnpm --filter @rally/sideline test:release
```

## Data model

`workspace_impersonation_relationships` is keyed by workspace, impersonator,
and represented user. `authority_basis` identifies the producer; `revoked_at`
removes an edge without erasing its history. Re-granting the same exact edge is
an upsert, not a second row. Audit rows live in the existing independent
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
