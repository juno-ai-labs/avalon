# Implementation plan

The PRD and design remain the complete acceptance contract. This checklist tracks
implementation and evidence; an unchecked item is not shipped or verified.

- [ ] WorkspaceDO consent authority: membership incarnation, stable grant order,
  prepared generations, withdrawal tombstones, immutable accepted receipts,
  creator initialization, manager removal, and conservative legacy migration.
- [ ] Signed-in self-service APIs, viewer-authorized discovery, own-grant access
  after losing Organization membership, and existing realtime invalidations.
- [ ] Shared event, schedule, manual and continuation eligibility; configured
  source reconciliation, provider occurrence deduplication, and persisted run
  coordinators independent of legacy human access rights.
- [ ] Harness operation identity resolver, safe refusal fallback, sticky
  account-relative operations and effect receipts, actual-account attribution,
  and delegation refresh for background children.
- [ ] Strict delegation tools in both existing plugin presentations; direct-user
  provenance for tools and creation; no autonomous consent tools.
- [ ] Activation permission-reporting guidance, actionable Needs attention, and
  configured medium fallback model evaluations.
- [ ] Shared desktop/web Sidekick list, creator disclosure, Account withdrawal
  controls, all loading/error/offline/pending/unavailable states and attribution.
- [ ] Real workerd and provider-double tests, production-code negative controls,
  lint, typecheck, real Electron/browser inspection and two-session convergence.
- [ ] Owning subsystem documents and final requirement-by-requirement audit.

## Evidence

Record executed checks and their actual coverage here as work progresses. Do not
turn an implementation checklist into an assertion that its tests passed.

### Consent installation

- `test-workers/sidekick-delegation.test.ts`: 10 passing real workerd cases,
  through production RPCs and services. Covers direct/autonomous creation,
  independent viewer consent without management, current legacy run-as access
  remaining unchanged, delayed first delivery, accepted receipt replay, manager
  removal, membership removal/rejoin, own withdrawal after access loss,
  viewer-authorized name/link discovery, regional account recovery, canonical
  human speaker binding, strict inputs and the two presentations' wire names.
- Production-code negative controls failed for the intended reason when the
  generation fence, accepted-receipt generation check, membership-incarnation
  check, canonical human author comparison, or withdrawal storage write was
  removed. Dropping account recovery routing also failed its discovery/recovery
  test. All six mutations were restored; the restored 10-case file passed.
- Existing `test-workers/hosted-sidekick.test.ts`: 53 passing cases.
- Focused API Node suites (`automation-routes`, `automation-service-actor`,
  `automation-creator-catalog`, `sidekick-presentation`,
  `agent-communication-prompts`): 30 passing cases.
- Harness `src/prompts.test.ts`: 46 passing cases, including the actual
  activation prompt's permission-reporting guidance. This proves prompt assembly,
  not model behavior; the medium fallback model evaluations remain required.
- Actual plugin presentation/schema tests: 3 passing cases, including retained
  room recommendations, absent autonomous tools, stable names, required fields
  and rejection of all six forbidden actor/version input fields.
- Recovery routing against all checked-in D1 migrations: 1 passing case.
  Existing database baseline suite: 32 passing cases. Lint and repository-wide
  typecheck and `pnpm docs:check` passed for the consent installation; repeat
  the applicable gates after subsequent edits.

### Next integration constraints

The consent APIs and tool executors do not enable delegation-aware execution
yet. In particular, the normal harness can replay a completed tool receipt
without entering that tool's executor. Its delegation-specific replay must
reconcile current self-grant state before presenting an old result as current;
the authority's generation check alone does not cover this outer cache.

The legacy claim endpoint, event/schedule policy, source registrations,
per-operation accounts, run coordinator and receipts still need integration.
Creator disclosure and all actual controls still need rendering and inspection.
Do not land the creator enrollment UI path without that disclosure, or mark
these foundational checks as evidence for execution, UI or model behavior.

The current harness has no model-visible tool-result byte cap
(`docs/agent-harness.md`, execution limits). Lists remain complete; do not invent
a numeric cap for the PRD's conditional inherited-budget refusal.
