# Implementation plan

Build against merged PR #733 at `d3e292087`, in the isolated
`codex/ashby-installation-lifecycle` worktree. The original checkout contains
unrelated work and remains untouched. Approval authorizes all phases below;
completion still requires the PRD's live acceptance evidence.

## Repository inspection

Existing: connector manifests and cross-validation; scope-specific dynamic hosted
MCP; protected-resource OAuth discovery, DCR, PKCE, refresh; WorkspaceDO OAuth
attempts and workspace-addressed desktop completion; branded credential access;
explicit Test → repair → healthCheck; dynamic Settings inventories; regional
connection routes and activity Queue admission; deterministic event matching;
operator-authenticated regional routes and workspace retirement fences.

New: provider management facet; WorkspaceDO installation and registration
inventory, generation-fenced operation receipts, cleanup-only encrypted snapshots;
shared setup/recovery/removal runner; frozen bulk maintenance targets and command.
At the inspected base, Granola provisioned in ConnectionService and repaired in its adapter.
Neither bulk maintenance nor post-disable credential access existed at that base.

## Phase 1 — Provider contracts and additive foundations

- [ ] Verify official Ashby OAuth metadata, webhook API shapes, signatures, ping,
  payload identity, confidential-data behavior, and unsupported recovery/rotation.
- [x] Add Ashby scope-specific manifest and hosted-MCP declaration, strict
  authorization schemas, registry enrollment, and provider-boundary tests.
- [x] Add typed installation/registration/step contracts and additive WorkspaceDO
  migrations, preserving populated connection children and OAuth receipts.
- [x] Document exact live access gaps rather than substituting invented fixtures
  for evidence of provider compatibility.

Gate: registry and protocol tests; populated migration and concurrency checks on
real workerd. No personal OAuth path can provision workspace webhooks.

## Phase 2 — Shared installation and Granola adoption

- [x] Persist stable identity, administrator/input-bound idempotency, credential
  fingerprint, approved event selection, routing, and secrets before dispatch.
- [x] Atomically reserve one enabled workspace Ashby installation across distinct
  concurrent setup keys; preserve Granola's existing cardinality rule.
- [x] Implement the shared provider-management runner and per-step dispatch,
  inspection, partial failure, unknown outcome, and manual reconciliation.
- [x] Import Granola IDs, credentials, signing secrets, URLs, and grouped events
  without creating/deleting registrations; fence lifecycle ownership.
- [x] Route explicit Test repair through the runner; health and inventory stay
  read-only, with authorization and delivery results separate.

Gate: retries, changed-input conflicts, concurrent administrators, immediate ping,
interruption, ambiguous creation, and no-write Granola adoption runtime coverage.

## Phase 3 — Ashby event ingress and personal lifecycle

- [x] Wire regional personal start/callback/reconnect and live tools through the
  existing attempts, credential authorization, receipts, and completion handoff.
- [x] Verify signed raw webhook bytes, isolate documented pings, enforce selected
  event types, and admit through existing regional payload/Queue processing.
- [ ] Preserve `(webhookActionId, action)` identity and stable occurrence semantics;
  normalize only verified IDs and the approved minimal data/audience mapping.
- [x] Expose operational closed-filter triggers to event-only connection
  authoring without REST recruiting tools, automatic automations, or watches.

Gate: Global/EU isolation, replay and conflicting bytes, related actions, disabled
and retired authority, Queue handoff failure, MCP/event independence.

## Phase 4 — Maintenance, rotation, recovery, and removal

- [x] Implement reviewed version preview/apply/status/resume/cancel using the
  existing regional operator-authenticated entrypoint with explicit connector
  maintenance authorization; add no permanent credential or arbitrary HTTP path.
- [x] Freeze operation targets; derive content-free progress from per-connection
  receipts; skip completed steps and fence every provider dispatch/completion.
- [x] Persist active/pending encrypted signing material before rotation; promote
  only with verified provider cutover evidence, otherwise require manual action.
- [x] Disable ordinary access immediately, retain a separate deletion-only
  snapshot for exact recorded resources, and erase it after confirmed cleanup.
- [x] Retain late still-desired identities for inspection; record obsolete or
  disconnected in-flight creations as cleanup work. Never restore disabled or
  retired authority. Surface unsupported/revoked/unknown cleanup honestly.

Gate: shared synthetic-provider contract tests and real workerd generation,
retirement, stale completion, cleanup capability, and resumability tests.

## Phase 5 — Product surfaces and owning documentation

- [x] One searchable Ashby catalog entry with independent personal/workspace
  setup, prerequisites, privacy disclosure, automatic subscriptions, and readiness.
- [x] Preserve setup identity across retries/reopen; show stage, partial failure,
  verification and delivery times, action required, repair, and cleanup pending.
- [x] Add personal OAuth conversation cards and reconnect, shared tool counts,
  workspace zero-tool inventory, push invalidation, and offline/error behavior.
- [x] Update connector, hosted-MCP, provider-app, data-model, security, regional,
  Settings, digestibility, public support, and operational acceptance docs.
- [x] Add the lifecycle module document and running changelogs.

Gate: inspect changed states in a real Electron window; component and catalog
checks; no credentials in API views, desktop persistence, search, or logs.

## Phase 6 — Verification and release evidence

- [x] Prove each new integration behavior fails under a representative production
  break, revert the break, then rerun the affected file.
- [x] Run repo-wide lint and typecheck, relevant Node and real-workerd suites,
  required script/build checks, and the full tests when warranted by scope.
- [ ] Exercise authorized Ashby and Granola test accounts in both regions,
  including OAuth/refresh, events, adoption, recovery, and provider cutover.
- [ ] Run live recruiting and no-confirmation acceptance on the configured medium
  fallback model using the observed catalog, recording sanitized metadata only.
- [x] Record exact outstanding acceptance checks if live access is unavailable.
  Keep state `in progress` until every required acceptance gate is satisfied.

PR creation and review were subsequently authorized. Deployment and merge remain excluded.

## Product clarifications during implementation

- Workspace Ashby remains event-only; personal OAuth supplies recruiting tools.
- Buttons read **Connect for me** and **Connect for workspace**; the latter is administrator-only.
- Rally never asks for per-tool confirmation. This is recorded in AGENTS.md; stale claims of an existing confirmation gate are corrected. Shared conservative MCP execution/retry classification remains unchanged.
- Ashby uses `ashby.rallywith.ai` on a dedicated Ashby Worker with its own startup graph, an opaque connection-to-region directory, and named regional service bindings. The user explicitly approved a Worker per connector because API bundle size/startup already caused a production engineering incident. Merely assigning a domain to the API Worker does not satisfy that intent; verify emitted imports and size, and identify any provider work that remains in the shared API. Granola URLs remain unchanged.

## Current verification evidence (2026-09-12)

- Ashby and Granola provider suites: 17 tests pass, including OAuth metadata,
  registration, regional callback, exchange, and refresh fixtures. These prove
  Rally's protocol handling, not live Ashby account compatibility.
- Installation lifecycle suites: 62 tests across 9 real-workerd files cover atomic setup, generation
  fences, populated migration, signed raw-byte ingress, both regional bridges,
  Queue admission, cleanup, Granola adoption, key replacement, rotation evidence,
  frozen maintenance, concurrent updates, cancellation, and personal isolation. Review adds authenticated routes, complete local teardown,
  setup telemetry, early Resume and duplicate-delivery races, and real Queue
  consumer dispatch.
- Representative production breaks were observed failing for duplicate setup,
  repeated dispatch, stale create settlement, local disablement, unverified cleanup
  IDs, pending-key persistence, rotation evidence and unresolved-cutover repair,
  provider removal, regional
  routing, signed-byte preservation, signature verification, Queue admission,
  Granola URL adoption, replacement dependencies, repair preserving removals,
  maintenance cancellation/frozen targets/provider updates, credential replacement,
  populated migration, operator roles, and read-only inventory authority. All
  mutations are reverted. Initial migration-selector and frozen-target proofs
  were insufficient; the corrected selector and a real later installation failed
  under the intended breaks.
- Native Electron views inspected: independent connect actions, workspace setup,
  loading, partial/unknown installation, API-key replacement, successful Test status,
  administrator denial, cleanup pending, forgotten cleanup credential, and offline
  controls. Fixtures contained only public status metadata; no provider acceptance
  is inferred from these screenshots. Ashby and Granola public support pages were
  also inspected in a visible browser.
- Script suite: 447 pass. Desktop release invariants: 140 pass. Typecheck passes.
  Lint (zero warnings), docs check, site build, and Global/EU/Ashby dry-run
  builds and local startup checks pass.
- Final `pnpm test` passes: API Node 273 files / 2,919 tests; real workerd
  87 files / 867 tests; desktop 191 files / 2,903 tests; and every other package.
  An earlier run caught a maintenance initialization error; it was corrected,
  the installation file passed, and the full suite then passed. The final
  lifecycle suites also pass independently (62 tests across 9 files).
- Dedicated Ashby artifact: 738.37 KiB (113.15 KiB gzip); local startup sampled
  3.9 ms active. It isolates ingress only. Provider management and hosted MCP still
  execute in the regional API; this change does not reduce the main API bundle
  (10,996.47 KiB / 3,604.54 KiB gzip in both regional dry runs).
  Startup profiles are local diagnostics, not deployed Cloudflare measurements.

## Remaining live acceptance

No Ashby test organization is available. Do not mark this PRD completed or claim
launch readiness until an authorized account can establish:

1. Personal OAuth/DCR, refresh, reconnect, actual tool inventory and recruiting
   query/update behavior in Global and EU, including revoked access and no tool
   confirmations on the configured medium fallback model.
2. API-key permissions, signed ping and the documented 27-event catalog,
   including organization availability and renewed-watermark retries for the email beta,
   provider enable/disable behavior, redelivery, and API-key replacement against
   the same organization. `apiKey.info` proves read access; webhook creation proves
   write access. No undocumented permission-string conversion is assumed.
3. The actual confidential payload and allowed workspace audience. Current Ashby
   activities contain verified IDs only and deny workspace automation admission.
   Both event-driven automation and personal tools are required for launch; this
   restriction is an outstanding acceptance dependency, not a feature flag.
4. Existing Granola credentials, exact callback URLs, all four existing event
   subscriptions, provider recovery and removal in authorized test workspaces.
5. Signing-key cutover where the provider supplies verifiable evidence. Current
   Ashby/Granola controls give explicit manual recreation guidance with a stated
   delivery gap; they do not claim verified automatic rotation.
6. After a separate deployment request, dedicated-domain/service-binding behavior
   and actual regional Worker startup acceptance. The first rollout requires a
   Global-only router bootstrap before EU can bind the new entrypoint, then the
   dedicated ingress. Do not merge into automatic EU-first deployment before that
   bootstrap. No bootstrap or deployment was performed.

## Review evidence

The nine-persona review swarm is complete, with all findings corrected and
follow-up verification. Opus was unavailable; reviewers used GPT-6 Astra at high
effort in batches of three. The additional GitHub automated review findings and
reasoned non-findings are recorded in [review.md](review.md).

Review regression proofs deliberately removed late-create retention, signing
material verification, repeated-disconnect idempotency, credential settlement
generation advancement, workspace role refusal, audit writes and replay dedupe,
credential preservation and validation, event-specific signing authority, saved
event selection, streamed byte limits, atomic target updates, cancellation and
settled-target guards. Additional breaks restored the preview-resume bypass,
blocked-maintenance stall, unrecoverable version mismatch, missing Test audit and
wrong operator identity. Each affected file failed for its intended behavior,
and all changes were restored. The first saved-selection proof stopped at a
response-code mismatch; moving the no-persistence assertion first then proved
that removing the early guard writes unauthorized R2 content before the later
normalization refusal. The onboarding regression also failed before its fix.

Further isolated proofs removed only the same-step claim generation check,
runnable-target deferral, ingress readiness checks, routing region-conflict guard,
setup telemetry, local teardown guarantee, complete installation disconnect,
cleanup dispatch classification, and stable public refusals. Each failed its
actual authority/persistence or completion assertion. Removing maintenance Queue
dispatch leaves the real consumed operation running and fails completion. Early
Resume failed before its fix by reporting current with the old destination.
All production mutations are restored. Final gate typecheck also caught two
new renderer fixtures using an unnormalized status and missing plugin identity;
the fixtures now match the API client contract.

Native Electron captures: [workspace setup](evidence/workspace-setup.png) and
[installation recovery and permission denial](evidence/installation-recovery.png).
These are synthetic public-status fixtures, not evidence of live provider success.


CI follow-up: its full-history Gitleaks scan flagged the synthetic Granola fixture
encoding of `provider-issued-secret`. A literal-only anchored exception and a
regression rejecting other/longer keys preserve the scan boundary. The pinned
CI Gitleaks version scanned 3,783 local commits with no leaks. Script tests now
pass 447 cases; application test/build results above remain unchanged.


## Follow-up — Automatic complete event subscriptions (2026-09-13)

- [x] Share the documented 27-event vocabulary and readable labels; default new
  workspace setup to all events while retaining existing explicit grants.
- [x] Remove the event selection form/search entry and describe automatic events.
- [x] Normalize the expanded event catalog through existing signed ingress and
  Queue processing without inventing provider record fields or REST tools.
- [x] Handle the documented beta email signal's changing retry watermark without
  duplicate logical events or weakening identity conflicts for other events.
- [x] Prove all-event setup, partial provider failure, signed delivery and beta
  retry behavior on workerd, plus meaningful production mutation proofs.
- [x] Inspect the simplified native Settings form; update owning docs and PR,
  run quality gates, and retain live acceptance as outstanding.

EU retirement will not block this work. The existing first-rollout ordering issue
is still unresolved and is not made safe by these subscription changes.

Validation: full `pnpm test` passed (API Node 2,919, workerd 870, desktop
2,902; other packages passed), along with lint, typecheck, Global/EU/Ashby
build/startup checks and the site build. The new route file passes 17 tests;
Ashby adapter tests pass 34; installation UI tests pass 9. Native Electron setup
and the local public support page were inspected. The refreshed setup capture
shows no event checkboxes.

Representative production breaks in `connector-installation-routes.test.ts`
failed as required, then were reverted:

| Break | Observed failure |
| --- | --- |
| Default setup to the old two-event subset | 2 registrations instead of 27 |
| Drop normalization of `jobCreate` | Signed ingress returns 400 instead of 200 |
| Compare renewed email delivery raw bytes | Only 1 accepted ingress receipt instead of 2 |
| Stop the runner after an uncertain provider write | Only 5 registrations current instead of 26 |

Live acceptance remains unavailable, including organization eligibility for the
email beta, actual payloads across the catalog, and the confidential audience.
No provider credentials, deployment, or fleet operation were used.
