# Daytona terminal plugin implementation plan

This plan implements the approved [product requirements](./prd.md) and
[design](./design.md) in test-first vertical slices. Each phase begins with a
failing behavior or contract test, adds only enough production code to make the
test pass, then refactors behind the green test boundary. A phase is not complete
until its focused tests and the repository gates named for that phase pass.

The plan deliberately keeps Daytona behind one regional adapter and keeps Bind,
resource, GitHub, scheduling, and transcript behavior in their existing owners.
It does not add model-facing lifecycle, polling, PTY, directory-listing, network,
or raw-provider tools.

## Independent plan review

An independent documentation/design subagent reviewed the plan before
implementation. Its actionable findings were incorporated: Phase 0 ends green;
the runtime plugin registers only after all eight executors exist; publication
authority and its two-hour durable grant are recorded in the PRD/design rather
than invented only here; and each phase updates its owner documents and running
changelogs instead of deferring documentation to the final phase. The approved
canonical command name remains `run_command`, matching the PRD and frozen tool
contract.

## Phase 0 — Freeze the seams and acceptance matrix

- [x] Add contract tests that pin the Terminal plugin identity, exact prompt,
  eight canonical tools, wire names, modes, idempotency classes, serial flags,
  strict argument schemas, clamps, output schemas, and recovery codes from the
  PRD.
- [x] Add an API-level Daytona adapter contract with a deterministic fake for
  tests and the production SDK implementation behind the same interface.
- [x] Add provider configuration tests for region capability, missing or invalid
  configuration, the emergency circuit breaker, snapshot identity, and fail-
  closed defaults.
- [x] Implement the minimum shared definitions, strict schemas, configuration
  parser, and adapter types that make those contract tests green. Keep the
  runtime plugin unregistered until every one of its eight executors exists.
- [x] Record the acceptance matrix in focused test names so every PRD acceptance
  criterion points to an executable test, a provider probe, or a visible-window
  check.

Acceptance gate: each new test is observed red before its matching minimum
implementation, then the complete Phase 0 contract suite and existing
`@rally/agent-harness`, contracts, and API tests are green.

## Phase 1 — Persist the regional control plane

- [x] Write migration tests first for tenant-first keys, constraints, indexes,
  cascade behavior, and replay uniqueness across sandbox, policy, task,
  publication-grant, and repository-publication tables.
- [x] Add migration `0074` with the minimum approved records: one sandbox per
  work stream, one workspace policy and its domains, mutation reconciliation,
  durable command tasks, publication provenance, and convergent optional typed
  PR publication receipts.
- [x] Add repository tests for optimistic sandbox transitions, exclusive
  Terminal-run mutation leases, operation serialization, policy compare-and-
  swap, task terminalization/one continuation, repeated publication provenance,
  and PR target convergence.
- [x] Bind each reusable sandbox generation to the frozen execution-principal,
  repository/connection, and resource-visibility authority fingerprint. Test
  that a principal change or narrowing/revocation destroys and reprovisions the
  generation before another tool can read its filesystem.
- [x] Implement small D1 repositories in the regional API; no generic workflow
  engine or second tool-receipt ledger is introduced.
- [x] Update `data-model.md` and start the registered Terminal module document
  in the same change as the migration and repositories, including their running
  changelogs.

Acceptance gate: migration upgrade, clean-install, tenant-isolation, and focused
repository race tests pass repeatedly.

## Phase 2 — Compile and enforce workspace network policy

- [x] Write table-driven tests for Trusted-only baseline expansion, custom exact
  and wildcard normalization, deduplication, immutable baseline targets, slot
  accounting, malformed/public-suffix input, and Daytona's 20-target ceiling.
- [x] Write policy-transition tests for preview-before-confirmation, revision
  conflict, affected active sandboxes, cancel-before-stop, pending/verified/
  failed reconciliation, and no auto-restart after a policy change.
- [x] Implement the compiler and owner/admin settings service using only
  Daytona's `domainAllowList`; Full internet clears it. CIDR and an Rally proxy
  remain absent.
- [x] Add production-provider probe hooks for effective-policy read-back, allowed
  targets, denied targets, redirects, direct IP, and private/special-use DNS
  rebinding. A failed probe disables Trusted only for that provider version.
- [x] Update the Terminal module, security, regionalization, and runbook owner
  docs in the same change as the policy/configuration behavior.

Acceptance gate: policy unit and service tests pass, and the fake provider proves
that no command can enter a sandbox with an unverified or stale revision.

## Phase 3 — Acquire, reuse, stop, archive, restore, and expire sandboxes

- [x] Write coordinator tests for lazy first-use creation, stable-name recovery
  after ambiguous creation, explicit restart/restore, five-minute warm stop,
  Daytona's 15-minute backstop, 60-minute archive, 30-day expiry, retryable
  failures, cancellation, and a fresh root after expiry.
- [x] Implement the Daytona SDK adapter with a configured managed snapshot, idempotent compatibility bootstrap, stable labels,
  configured region target, no public preview, native domain policy, and bounded
  provider timeouts.
- [x] Extend the existing `WorkspaceScheduler` target union and alarm handling
  with claimed Terminal lifecycle transitions. Deadlines live in D1; duplicate
  alarms reconcile provider state before mutating it.
- [x] Before deletion, persist the bounded final diff and complete eligible logs
  through the existing generated-resource path, then remove provider secrets and
  the sandbox. Do not create a cold filesystem archive.
- [x] Update the scheduler and Terminal module docs and changelogs in the same
  change as lifecycle ownership.

Acceptance gate: coordinator and scheduler tests pass under duplicate alarms and
ambiguous provider responses, including archive/restore and expiry cleanup.

## Phase 4 — Ship typed file and command tools through Bind

- [x] For `read_file`, `edit_file`, `write_file`, and `apply_patch`, write red
  tests for happy paths, root-relative/symlink containment, exact-match repair,
  patch context, atomic per-file application, binary/directory handling, size
  limits, lost-response reconciliation, and the PRD's actionable errors.
- [x] For `run_command`, write red tests for the non-interactive envelope,
  `cwd`, timeout clamps, nonzero exit as a normal result, head/tail truncation,
  complete-log publication, secret/control-sequence scrubbing, forbidden
  PTY/background/service patterns, obvious `git push`/mutating `gh`, timeout,
  cancellation, descendant cleanup, and ambiguous replay.
- [x] Implement the file/command executors against the Phase 0 descriptor and
  adapter contract, but do not register the loadable runtime plugin while its
  resource and publication executors are still absent.
- [x] Implement durable command submission and host auto-resume using stable
  `sandbox_tasks`; provider observation never becomes a model-facing poll tool.
  The model receives one final command result.
- [x] Add medium-model sequencing fixtures for create/read/edit/patch/search,
  package installation, nonzero-exit repair, and ordinary prose/connector cases
  where Terminal should remain unloaded and no sandbox should exist.
- [x] Update the agent-tools, agent-harness, prompt, and Terminal module docs and
  changelogs in the same change as the Bind and command behavior.

Acceptance gate: tool contract, adapter, receipt/replay, and Bind integration
tests pass; the exact plugin prompt and complete always-visible tool family are
golden-tested.

## Phase 5 — Import and publish work-stream resources

- [x] Write authorization and replay tests before implementation for automatic
  and explicit `import_resource`, create-only destinations, explicit overwrite,
  revoked/detached resources, regional R2 streaming, byte/hash verification,
  deterministic `.avalon/resources/` reuse, and Git exclusion.
- [x] Write publication tests for `publish_resource` path containment, regular
  stable files, count/byte limits, MIME classification, unsupported binaries,
  receipt-derived identity, replay after detach/delete/hash drift, and cleanup
  outbox convergence.
- [x] Implement both tools through the existing current-principal resource
  visibility and PR #144 lifecycle. Daytona receives no R2 credential or signed
  URL, and resource bytes never enter model context.
- [x] Update the attachment and Terminal module docs and changelogs in the same
  change as resource exchange.

Acceptance gate: attachment subsystem regression tests plus Terminal resource
tests pass, including cleanup and inventory-revision behavior.

## Phase 6 — Bootstrap one authorized repository and support GitHub CLI

- [x] Write repository-selection tests for scratch, loading, no connection, no
  repository, revoked, cancelled, and one selected repository. Never infer the
  first repository when selection is ambiguous.
- [x] Write GitHub bootstrap tests for exact installation/repository/base SHA,
  one-hour repository tokens matching read-only/full connector policy, Daytona
  host-scoped secret placeholders, canonical URL-scoped Git headers, word-based
  branch creation/restoration and checkout, rotation, and policy invalidation.
- [x] Write run-provenance tests showing that request prose is not a second
  authorization parser and one active participant run may publish multiple
  commits to the same branch/PR.
- [x] Write publisher tests for dirty/wrong branches, missing ancestry, bundle
  and object limits, workflow-file changes, expected-old-SHA races, protected or
  default refs, non-fast-forward updates, revoked authority, open PR update,
  closed/merged PR refusal, duplicate calls, and lost provider responses.
- [x] Implement standard Git and `gh` through `run_command`: read-only token
  permissions block remote writes and full access permits them after automatic
  branch preparation. Retain `publish_branch_and_pr` as an optional convergent
  typed write using a fresh narrowed token and verified bundle.
- [x] Register the deferred built-in Terminal plugin only now, when all eight
  always-visible tools have complete executors. Loading it remains allocation-
  free; the first sandbox-dependent execution acquires the work-stream mutation
  lease and sandbox.
- [x] Update the security, agent harness, GitHub boundary, and Terminal module
  docs and changelogs in the same change as repository publication.

Acceptance gate: no plaintext GitHub credential can be observed in the sandbox
fake; read-only rejects remote writes, full access supports standard Git/CLI,
and all bootstrap/publication/replay tests pass.

## Phase 7 — Add participant-visible settings and work-stream state

- [x] Write API and renderer tests first for workspace network mode, immutable
  target groups, custom-domain validation and slots, Full-internet warning,
  preview/confirmation, revision conflicts, pending/verified/failure states, and
  region-unavailable explanations.
- [x] Write transcript/right-rail tests for repository selection and sandbox
  `absent`, `starting`, `running`, `stopped`, `archived`, `restoring`, `expired`,
  and `failed` states; last activity; retention warnings; durable versus local
  output labels; final diff; and explicit fresh-start behavior.
- [x] Implement the smallest API projections and desktop components that satisfy
  those states, reusing existing settings forms, structured transcript rows,
  resource inventory, and inspector rail.
- [x] Verify keyboard, loading, empty, error, offline, and permission-disabled
  behavior. Settings mutations remain owner/admin-only; all participants may
  see current sandbox state and generated resources.
- [x] Update the relevant desktop/settings and Terminal module docs and
  changelogs in the same change as participant-visible behavior.

Acceptance gate: focused API/renderer tests pass and every changed state is
inspected in a real desktop window under Xvfb at normal and narrow widths.

## Phase 8 — Operational proof, documentation, and completion

- [x] Add structured logs/metrics for lifecycle transitions, task duration and
  exit, policy reconciliation, provider failures, publication outcomes, retained
  bytes, and cost-driving sandbox time without secrets or raw sandbox output.
- [x] Add snapshot-manifest and provider acceptance scripts for every supported
  language/manager pair and the network/secret behavior required by the PRD.
- [x] Update the standing implementation brief and architecture map, then audit
  the phase-owned agent harness, agent tools, attachments, data model,
  regionalization, security, prompt, runbook, desktop/settings, and registered
  `terminal-workspaces.md` documents for consistency and valid links. Do not
  postpone a module's first behavior/changelog update to this phase.
- [x] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, both
  Wrangler dry-run builds, and any release-invariant suite touched by the work,
  capturing complete output as required by `AGENTS.md`. Fix any flake instead of
  rerunning past it.
- [ ] Run the fake-provider end-to-end acceptance suite and the configured
  Daytona provider probe. Keep a region `unsupported` until its real provider
  probe and residency requirements pass; unsupported is a truthful shipped
  state, not a skipped implementation.
  The fake-provider suite is green. No Daytona credentials, snapshot, or
  controlled probe endpoints are configured in this worktree, so the real
  probe remains an activation gate and both checked-in regions remain
  `unsupported`.
- [ ] Tick the PRD `completed` box only after all executable acceptance gates and
  visible checks are green. Once completed, freeze the PRD and plan.

Acceptance gate: every repository quality gate is green, visible behavior has
been inspected, subsystem documentation describes the shipped system, and the
PRD acceptance matrix has no unaccounted item.

## TDD working rule

For every checkbox above, keep the cycle visible in history and command output:

1. **Red:** add the smallest failing test for one observable behavior and run it
   alone to confirm the expected failure.
2. **Green:** implement the narrowest behavior that passes that test without
   weakening an existing invariant.
3. **Refactor:** remove duplication and improve names only while the focused
   suite stays green.
4. **Integrate:** run the owning package suite before beginning the next slice.
5. **Regress:** at each phase gate, run the relevant cross-package suites; at
   completion, run the full repository gates once.

Provider calls, time, randomness, GitHub, R2, and Daytona are injected at the
owning boundary. Tests assert durable state and externally visible results, not
private method call order, except where call ordering is itself a security
contract such as cancel-before-stop or receipt-before-write.
