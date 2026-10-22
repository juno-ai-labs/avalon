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

### Shared admission and run coordinators

- Real workerd `sidekick-delegation-admission.test.ts` covers manual coordination
  without implicit enrollment, fixed continuation identity, actionable blocked
  runs, fresh later hourly occurrences, conservative legacy migration, retained
  legacy task accounts and human management rights, installed-client self-claim,
  restricted workspace audiences, delivery after withdrawal, and the original
  personal Sheet shape in both Thread and Organization ownership scopes.
- The restored admission/consent/hosted-Sidekick/semantic-trigger lanes passed
  81 cases. Focused authority, Slack assignment, creator catalog and tool schema
  Node suites passed 98 cases; harness prompt and creator tools passed 75 cases.
- Negative controls reintroduced the non-personal ownership cutoff, ignored the
  event audience, ignored coordinator withdrawal, migrated the creator instead
  of the established claimant, and overwrote the human access field during
  coordinator selection. Each failed for its intended behavior and was restored.
  Dropping the blocked-run write has its own negative control and restored run.
- Directory responses retain legacy `runAsUserId` and expose coordinator and
  safe delegation attention separately. The legacy claim endpoint records
  self-consent and an explicit human entitlement without rebinding sources.
- Old task-account identities and provisioned run coordinators are snapshotted
  in the appended WorkspaceDO migration; a durable alarm installs established
  claims, and ambiguous creator attribution remains ungranted.

### Shared Terminal state

- Focused `terminal-plugin-integration.test.ts` and `terminal-coordinator.test.ts`
  passed 55 cases. They exercise the real object-schema queries with a Daytona
  provider double; runtime DO semantics remain covered by the existing workerd
  Terminal suites and the delegation/membership suites above.
- An independent eligible delegate retains the original sandbox and completed
  imports. Cached callers lose access after observed withdrawal. A selected
  personal GitHub connection loses its mounted secrets when its owner withdraws;
  local files remain readable and the typed publisher refuses that connection.
  The coordinator suite retains a generation created under the old principal
  fingerprint for both primary activations and background workers.
- Four production-code negative controls each failed the targeted plugin case:
  removing the consent check admitted an unconsented editor, tying file identity
  to the new coordinator or reauthorizing completed imports deleted retained
  files, and dropping credential removal left the provider credential mounted.
  All mutations were restored and the focused 55-case run passed. A fifth
  control, treating an unknown token expiry as proof of no mount, also failed
  its targeted credential-removal assertion; the guard was restored.
- The fresh workerd admission plus Terminal storage lanes passed 12 cases;
  authority/Slack/catalog/tool-schema Node lanes passed 98, and the harness
  prompt/creator-tool lanes passed 75. These are targeted verification, not
  evidence for remaining operation fallback or UI requirements.
- Lint, repository-wide typecheck and documentation checks pass at this
  checkpoint. Full-suite and real-window UI evidence remain required when the
  remaining implementation is complete.

### Per-operation accounts and durable references

- The assembled connector loader admits eligible delegates' personal connections
  independently of its coordinator. Provider execution uses the selected owner,
  preserving the coordinator's run identity and existing workspace principals.
  Google declares portable file operations and account-scoped mail/calendar IDs;
  undeclared and hosted MCP operations retain their selected connection and
  expose that limitation rather than gaining generic cross-account replay.
- Existing receipt checkpoints record selected/refused/served accounts,
  first selection, actual principal/connection and grant generation. Selection
  commits before provider dispatch. Unresolved effects cannot change account;
  only completed results establish dependent references. Retained attribution
  prevents a completed read from being rebound to another input.
- `tool-receipt-authority.test.ts`: 21 passing real workerd cases, including
  five new account/eviction/lease/rollback/field-diagnostic cases and private serving-account
  continuation across eviction. No new account-selection table or migration.
- Focused API Node lanes passed 126 cases, including 14 resolver cases and
  the final nullable-selector contract checks. They cover creator/source ordering,
  deduplicated fallback, explicit account restrictions, empty searches, named
  senders and replies, provider-reference ambiguity, continuation identity,
  planned writes and observed withdrawal, uncertain effects, workspace
  principals, receipt reuse and existing authoring catalog behavior. The actual
  assembled Google test reads a Sheet after creator refusal, then writes using
  the consenting other owner's credentials and refuses that owner's later
  withdrawal; provider HTTP doubles observe the requests.
- Connector identity projection: 9 passing cases. The pure account-guidance
  renderer's two passing cases distinguish supported selectors from
  fixed-connection tools and quote profile names as data. The combined existing
  prompt/creator-tool lanes and these new cases pass 77 tests. These are assembly/unit evidence, not the
  required configured medium-model behavior evaluations.
- Ten production-code negative controls failed their targeted assertions:
  allowing an unresolved account switch, removing transaction rollback,
  accepting uncompleted bindings, permitting read-receipt rebinding, dropping
  continuation identity, retrying transient/timeout/cancelled effects, changing
  a planned write's account after withdrawal, ignoring explicit account scope,
  omitting pre-dispatch selection, and passing the coordinator rather than the
  selected owner to Google's adapter. All temporary mutations were restored;
  restored workerd and scoped Node lanes passed. An eleventh negative control
  removed RPC account validation; its mismatched-principal request was wrongly
  accepted, and the field-diagnostic test failed. That validation was restored.
  Lint, repository-wide typecheck and documentation checks passed after
  the final nullable-selector input edit. Full-suite and model/UI evidence
  remain required for completion.

### Next integration constraints

The common admission policy is installed. The normal harness can still replay a
completed tool receipt
without entering that tool's executor. Its delegation-specific replay must
reconcile current self-grant state before presenting an old result as current;
the authority's generation check alone does not cover this outer cache.

Configured sources still need reconciliation across delegates' connection-
specific Rally resource IDs, preserving provider resource/occurrence identity.
Account-scoped references originating in an activation event still need
canonical source-account seeding before their first tool read; source preference
alone must not reinterpret a Gmail/Calendar reference as the creator's. Verify
origin context through background-child handoff and resumed inventory snapshots.
Normal activity details still need actual serving-account fields wired from the
receipt checkpoints, alongside the coordinating user. Authorized uncertain-write
reconciliation still needs end-to-end recovery verification; pinning an account
alone is not evidence that an uncertain provider effect was reconciled.
Terminal now checks eligible delegation for every operation and retains its
original file identity across coordinators, including completed imports. Its
single selected repository connection stays explicit; observed withdrawal
removes mounted personal GitHub credentials without deleting files. Actual
serving-account activity presentation remains part of the remaining UI work.
Historical direct-creation provenance still needs its final audit against any
existing creation/tool receipts; no new historical provenance service is planned.
Creator disclosure and all actual controls still need rendering and inspection.
Do not land the creator enrollment UI path without that disclosure, or mark
these foundational checks as evidence for execution, UI or model behavior.

The current harness has no model-visible tool-result byte cap
(`docs/agent-harness.md`, execution limits). Lists remain complete; do not invent
a numeric cap for the PRD's conditional inherited-budget refusal.
