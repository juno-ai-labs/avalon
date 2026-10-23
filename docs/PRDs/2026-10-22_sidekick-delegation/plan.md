# Implementation plan

The PRD and design remain the complete acceptance contract. This checklist tracks
local implementation and evidence. The earlier implementation was complete locally; the 2026-10-23 scope revision
is complete locally. The branch is unpushed and not deployed; these checks do not claim production verification.

- [x] WorkspaceDO consent authority: membership incarnation, stable grant order,
  prepared generations, withdrawal tombstones, immutable accepted receipts,
  automatic creator enrollment and legacy backfill that preserves withdrawal.
- [x] Signed-in self-service APIs, viewer-authorized discovery, own-grant access
  after losing Organization membership, and existing realtime invalidations.
- [x] Shared event, schedule, manual and continuation eligibility; configured
  source reconciliation, provider occurrence deduplication, and persisted run
  coordinators independent of legacy human access rights.
- [x] Harness operation identity resolver, safe refusal fallback, sticky
  account-relative operations and effect receipts, actual-account attribution,
  and delegation refresh for background children.
- [x] Strict targeted delegation tools in direct and autonomous presentations;
  any current Organization user can be targeted and creators enroll immediately.
- [x] Activation permission-reporting guidance, actionable Needs attention, and
  configured medium fallback model evaluations.
- [x] Shared desktop/web Sidekick list, immediate creation, all
  loading/error/offline/pending/unavailable states and attribution.
- [x] Real workerd and provider-double tests, production-code negative controls,
  lint, typecheck, real Electron/browser inspection and two-session convergence.
- [x] Owning subsystem documents and final requirement-by-requirement audit.

## Scope update

2026-10-23: Remove manager removal, creator consent markers, creation/history
disclosures and direct-human consent restrictions/guidance. Every creation
immediately enrolls its creator, including autonomous creation. The agent tool
becomes `sidekick_set_delegation({ sidekickId, userId, allowed })`, available to
user-driven and autonomous executions for any current Organization user.
Existing withdrawal ordering, identity binding, event audiences, recovery and
Terminal protections remain. Validation of this revision is recorded below; the runtime sweep and focused fixture repair are complete. Evidence
below describes the earlier scope unless explicitly updated for this revision.


The user removed the dedicated Account withdrawal feature. Its unfinished UI
and transport work were discarded, and the separate account HTTP route and
response contract were removed. Sidekick-screen withdrawal, agent own-grant
lookup/self-withdrawal, delegation execution and activity attribution remain.

## 2026-10-23 simplification validation

- Automatic enrollment: new creators are enrolled in the same creation
  transaction, including the real autonomous agent creation path. Migration 131
  queues earlier unenrolled creators, including those with no legacy task-account
  binding. Existing allowed or withdrawn records are never overwritten.
- Removed manager removal throughout UI, API client, HTTP route and RPC. Removed
  creator-consent fields, direct-speaker lookup, creation/history disclosures,
  creation CSS and special quoted/external-event consent guidance.
- Agent mutation is `sidekick_set_delegation({ sidekickId, userId, allowed })`.
  Actor identity stays host-owned. Direct and autonomous runs can target any
  current Organization user. Self-service UI remains self-only.
- Three production breaks failed their intended workerd assertions: dropping
  creation enrollment, restoring self-only targeting and dropping creator
  backfill. Restored consent/admission files pass 30 tests.
- All API Node tests pass (3,859) after updating two old catalog expectations;
  the complete catalog file passes 41. The initial broad root run passed every
  other package, including desktop 4,032, and failed only those two stale tests.
  The workerd sweep passed 180 files and 2,092 tests; one fixture created a
  nonexistent author without Organization membership. The fixture now declares
  that creator as a real member. Its original access-revocation assertions are
  unchanged, and both affected runtime files pass all 58 tests. These results
  combine the broad sweep with the focused repair run; the broad command itself
  was not rerun after that fixture-only correction.
- Three live model cases on the configured fallback pass: direct targeting of
  another member, autonomous enrollment and autonomous withdrawal. Production
  descriptions and schemas were exported; outcomes were fixtures and no real
  provider write occurred.
- Real headed Chrome: Settings → Sidekicks → New Sidekick immediately created a
  draft, with creator already allowed/eligible in the real delegation API.
  Withdrawal survived reload; normal re-enrollment worked. Offline controls were
  disabled and a physical click sent zero mutations. The isolated draft was
  archived afterwards. Native 1280×763 and compact 800×720 Details were inspected,
  with no horizontal overflow, overlapping or covered controls. A labeled GET
  fixture added unavailable Maya to inspect the populated list: no manager
  removal or shared-history disclosure appeared. Screenshots and the new model
  results are in the task's QA artifact directory. Local auth was a cookie
  fixture over the ordinary identity session; login was outside this check.
- Lint, typecheck, documentation and schema/tool checks pass after the final
  correction. No new PR, push or deployment is part of this revision.

## Evidence

Record executed checks and their actual coverage here as work progresses. Do not
turn an implementation checklist into an assertion that its tests passed.

### Recovery, browser acceptance and final scope checkpoint

- Native Calendar creation now uses the existing provider-key and receipt
  recovery path. Real workerd covers an accepted POST with a lost response,
  eviction, original-delegate withdrawal/regrant, executing and ambiguous
  receipts, and durable R2 completion through the same account/event ID.
  Recovery refuses an omitted default or calendar name rather than resolving
  a potentially different destination. Connector tests cover all three create
  variants, unrelated conflicts, readback capability and unstable targets.
  No new recovery table, provider preflight or retry framework was added.
- Negative controls disabled connector recovery, omitted the original-key
  check, removed the original-delegate fence, and permitted a changed calendar
  target. Each targeted check failed for its named behavior before restoration.
- Twelve live prompt/tool cases passed on the configured fallback model,
  `google/gemini-3.8-flash`, using exported production prompts and schemas.
  These cover direct opt-in/list/withdrawal, someone else's consent, quoted and
  injected consent, unknown targets, response-loss inspection, blocked/partial
  activation reports, quiet successful fallback, and a refused report without
  a delivery claim. Provider/tool outcomes were fixtures; real consent and post
  authority are covered separately on workerd. Results and browser screenshots
  are in this task's Sidekick QA artifact directory.
- Three additional live account-guidance checks passed with the production
  Google tool schemas: “my inbox” selects the current requester, “send as Maya”
  selects Maya, and an unqualified scheduled inbox read retains the configured
  task account even under another coordinator. An empty result may refine the
  query in the same account; it must not switch accounts. These used fixture
  provider outcomes and made no real email writes.
- Real headed Chrome inspected creator disclosure and enrollment, empty and
  populated lists, loading, manager/unavailable rows, pending saves, offline
  controls, read failure/acknowledgement/retry and compact Details. Two actual
  browser sessions converged withdrawal/re-enrollment. Archiving the isolated
  QA draft caused the other session to lose access and remove grant controls.
  Loading, unavailable rows and read failures used response fixtures; creation,
  consent changes, archive and the no-delegate Run now refusal used real local
  APIs. No provider permissions or Organization audience were widened.
- The historical-creation audit found no reverse creation-receipt address on
  legacy directory rows. Direct and autonomous creation wrote the same author
  identity; matching author/run-as therefore retains the documented Needs opt-in
  behavior. No historical consent reconstruction service is needed.
- The broad sweep caught missing STRICT declarations in the new, unpublished
  grant tables and Sidekick-only source fields reaching ordinary Thread watch
  RPCs. The new schemas are STRICT; Thread deliveries project their unchanged
  event shape. Older routing fixtures now explicitly create consenting
  Sidekicks, and the legacy-claim test preserves creator preference.
- Refused activation posts now persist the existing attention field with a
  fixed recovery message. A real archived destination refuses the tool and
  appends no message; the banner survives WorkspaceDO eviction. Removing the
  attention write made the assertion fail. A real browser inspected its message.
- The background continuation timeout was an invalid test ordering assumption.
  A nested worker's completion notice settles independently after its terminal
  receipt and can start an execution in the parent. A controlled delivery/model
  gate reproduced the timeout: the follow-up was consumed as a steer in that
  notice execution, which completed, with no queued inputs or refusals. The
  test incorrectly waited for a separate trigger receipt. It now waits for
  nested notice settlement and the parent's settled idle state before evicting
  completed work and sending an independent follow-up. Waiting only for idle
  was insufficient because the notice could still arrive afterwards. The
  earlier artificial still-owned lease experiment reproduced a symptom but did
  not establish its cause; terminalization closes the linked loop atomically.
  This changes fixture ordering without a new timeout, retry or runtime rule.
  All 20 repetitions of the complete continuation file passed (400 test
  executions), followed by a passing fresh full `pnpm test` with
  `VITEST_MAX_WORKERS=2`: API Node 3,859, real workerd 2,092, desktop 4,032,
  harness 558, contracts 630 and connectors 602 (four existing skips), plus
  all remaining packages. Lint, typecheck and documentation checks also pass.
  The feature is local and unpushed.

### Requirement audit

| PRD acceptance | Implementation and evidence |
| --- | --- |
| 1. Creator consent and migration | Workerd covers immediate creation through the autonomous service, creator backfill with or without an old task-account binding, and preservation of withdrawals. |
| 2. Self-service UI | Real Electron and browser windows; all listed visual states, real two-session grant convergence and archive/access-loss convergence. Response fixtures are identified above. |
| 3. Agent self-consent | Strict target-user schemas, autonomous changes to another Organization user and out-of-Organization refusal are covered on workerd. Three new live model cases pass. |
| 4. Event/schedule consistency | Shared admission and source-reconciliation workerd lanes; assembled connector cases exercise the same permission shape with and without event origin. Providers are doubled; no production Sheet permissions changed. |
| 5. Eligible fallback | Resolver/assembled Google tests prove permission-only fallback and refreshed withdrawal. Snapshot-authorized in-flight work remains permitted. |
| 6. Account-dependent meaning | Empty searches, named users, private IDs, replies, pagination and legacy task-account bindings are covered by resolver and pagination lanes. |
| 7. Writes and recovery | Refusal-only write fallback plus real-workerd/provider-double Calendar recovery; ambiguous/cancelled effects never move to a different account. |
| 8. Revocation and continuation | Membership incarnation, delayed old allow, accepted/interrupted receipt replay, persisted coordination and same-Sidekick background references are covered on workerd. |
| 9. Multiple operation identities | Durable per-operation account checkpoints, servedThrough results, activity details and separate coordinator history; shared Terminal retains files and removes observed withdrawn credentials. |
| 10. Runtime and quality gates | Negative controls, Electron/browser QA and live model checks recorded above. The post-fix full suite, 20 continuation repetitions, lint, typecheck and docs checks all pass. |
| 11. Permission reports | Production activation guidance, four live reporting cases and a durable refused-post attention test with eviction and a production-break control. |

### Completed-reference background handoff and later executions

- Same-Sidekick agent exchanges carry host-derived connection IDs and completed
  provider reference keys. Nested assignments and replies merge inherited
  references; the receiving resolver applies its own delegation snapshot. These
  fields never become model tool inputs or rendered message text. Another
  Sidekick's references and unresolved effects cannot establish an origin.
- The existing completed-receipt query supports an explicit execution or its
  containing conversation. Later executions of an occurrence retain completed
  bindings; a new occurrence's separate conversation starts afresh. Authoring
  queries remain execution-scoped. No migration or additional ledger is added.
- Restored workerd receipt/continuation/admission lanes passed 56 cases. Real
  RPCs, message admission, nested workers and eviction preserve the literal
  origin reference and exclude an unresolved result. Scoped resolver, assembled
  connector, message renderer, pagination and run-authority lanes passed 83 cases.
  They cover opaque-ID origin, ambiguous-ID refusal, observed withdrawal,
  unchanged empty-search default and provider use of a handed-off connection.
- Five production-code negative controls dropped resolver reference use,
  conversation scope, loader propagation, inherited nested references or the
  conversation receipt query. Each targeted assertion failed and the changes
  were restored. Initial broader continuation failures were deterministic stale
  fixtures: direct creation omitted creator consent, and two cases still used
  mutable legacy run-as metadata as the admitted coordinator. The fixtures now
  authorize direct creation, test inherited-principal mismatch and coordinator
  withdrawal, and prove a legacy human-access change leaves coordination fixed.
- The complete contracts suite passed 630 cases, including rejection of forged
  host-reference fields in start, send and reply model inputs. Lint,
  repository-wide typecheck and documentation checks passed on restored sources.
- The full PRD remains incomplete. Provider-write recovery end to end, configured
  medium-model behavior evaluations, remaining browser/reader-access acceptance
  and the final requirement audit are still required.

### Simplification after antagonistic review

- Connector execution and Terminal reuse one inventory delegation snapshot.
  Continuations and later runs rebuild it; stale snapshots may finish, while
  refreshed inventories refuse withdrawn delegates and remove their mounted
  repository credentials. Serving connection capability and credential checks,
  coordinator liveness, identity pins and durable receipts remain.
- Enrollment is authorized once at mutation, after intent preparation; empty
  resource-key operations skip the resource-binding RPC. Source changes coalesce
  into one stored alarm per Sidekick, with strictly advancing due instants so
  an older handler cannot erase work queued during its await.
- Restored scoped checks passed 82 real workerd consent/admission/hosted-Sidekick
  cases and 81 Node schema/connector/Terminal/resolver/run-authority cases.
  Lint and repository-wide typecheck passed. Production-code negative controls
  restored per-call grant reads or dropped wake advancement; the targeted
  assertions failed for stale-snapshot rejection and erasure of the newer wake.
  Full-suite and model behavior evidence remain open.
- UI acknowledgements now update the confirmed delegation list immediately;
  ordinary background refetch failures leave accepted actions usable. Unknown
  mutation outcomes still require successful reconciliation. The removed Account
  surface's unused query invalidation is deleted.
- The shared desktop adapter's seven component cases cover stalled/failed
  background reads, uncertain response recovery, offline behavior, retained
  creator identity and overlapping self/manager acknowledgements. Real Electron
  response/cache fixtures were inspected at native 960×720 and compact 800×720:
  pending, accepted while refreshing, refresh error with usable controls,
  uncertain withdrawal with disabled controls, successful refresh recovery,
  unavailable delegate and pending manager removal. Independent acknowledgements
  preserved the self grant after the other delegate's removal. These fixtures
  made no provider or consent writes and do not replace full browser-host,
  model or multi-session authorization acceptance.

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

### Canonical activation references

- The run opening stores an authored adapter projection of provider IDs with the
  canonical event's source connection. The host reads normalized subject and
  resource columns, never an account or reference list from event metadata.
  Old run openings can recover the reference from the canonical event row;
  old queue deliveries do not need the new source fields to retain this origin.
- Account-scoped first reads/replies remain with that source. Portable file reads
  prefer it and retain safe refusal fallback. New inbox searches still use the
  task account. Background children load only origin references through their
  existing root-run authority, not the root's instruction or tool configuration.
- Restored real workerd admission lane: 12 passing cases, including the canonical
  source, forged metadata, old queue/opening and root-child reference behavior.
  Focused Node resolver/assembled Google/opening lanes: 26 passing cases.
  Authored Google reference projections: 10 passing cases.
- Five production-code negative controls failed at the intended assertions:
  dropping admission's source capture, old-opening recovery, account-reference
  pinning, assembled loader propagation, and rooted child origin loading. All
  mutations were restored; the complete 12-case workerd and 26-case Node lanes
  then passed. Lint and repository-wide typecheck passed on restored sources;
  documentation checks also passed. No new migration, provider preflight or
  cross-object revocation barrier was added. UI and model evidence remain open.

### Completed consent replay

- Completed self-consent tools have a read-only replay check. The canonical
  speaker, target, intent, source and original effect ID must match the existing
  receipt and preparation; current generation and allowed-grant eligibility
  determine whether the acknowledgement still applies. No new grant, receipt
  or preparation is written by the inspection.
- The host checks before loading/emitting a cached success. Bind presents a
  typed authorization refusal without executing or changing the historical
  completed effect. Current withdrawals remain inspectable after access loss.
- Real workerd consent lane: 12 passing cases after restoration. The exact
  action receipt is read through the real RPC; an old acknowledgement stays
  stale after withdrawal and fresh regrant to the same eligible person.
  Harness index/prompt lanes passed 245 cases, including model-visible refusal
  with its stable code and no new plan/executor/terminal effect event. Focused
  API tool-schema, presentation and idempotency lanes passed 18 cases.
- Production-code negative controls removed generation comparison, eligibility,
  and the cache replay validator; each failed its intended assertion. The
  stronger withdrawal/regrant control returned an old accepted acknowledgement
  when its generation comparison was removed. Every mutation was restored;
  the complete 12-case workerd and 245-case harness lanes then passed. Lint and
  repository-wide typecheck passed. This adds no consent table or migration;
  interrupted response-loss recovery is covered in the next evidence section.

### Interrupted consent recovery

- Direct-speaker consent tools reconcile accepted actions by their original
  effect IDs. Missing or superseded acceptance refuses recovery without a new
  preparation. Startup repair builds only the existing applicable consent
  subset, reads the canonical speaker, and uses ordinary run/lease authority.
- Real workerd scenarios exercise both tool presentations and executing/ambiguous
  outer receipts after eviction and a real replacement lease claim. The accepted
  outcome must be completed durably and readable from R2. Missing and
  superseded actions after withdrawal must remain stale without another grant.
- Restored real workerd consent lane: 14 passing cases, including both repair
  scenarios. They use canonical human turns, real object ports and lease claims,
  eviction, R2 and durable receipt settlement; no inference is activated.
  Background contexts cannot reconstruct consent tools. After withdrawal,
  both an unaccepted call and an accepted-but-superseded call remain named stale
  actions and the consent receipt count does not grow through repair.
- Three production-code negative controls removed the consent reconciler,
  recovery dispatch and ambiguous-result settlement flag; each failed its
  intended assertion. Without reconciliation, an unaccepted old action was
  executed and reported completed after withdrawal. A fourth control removed
  deadline cleanup and left a timer after both landed and unknown reconciliation.
  All changes were restored. The final consent lane passed 14 cases; focused
  Terminal recovery/tool-schema/presentation Node lanes passed 22, including
  the two deadline cleanup cases. Lint and repository-wide typecheck passed.
  Documentation checks passed. No grant
  migration, new retry loop or authorization barrier was introduced.

### Configured source reconciliation

- Authored activity identity now distinguishes portable provider resources from
  account-relative references. Configured Google files expand through eligible
  delegates' connections using the existing resource resolver and exact provider
  IDs, never titles. Private Gmail/calendar sources stay on their configured
  account. Aliases retain the saved evaluator ID as provenance; queued delivery
  still checks the current definition and current delegation.
- Differential updates preserve unchanged registration IDs and sequence cutoffs;
  new registrations start at the current cutoff. The Drive normalizer supplies
  the same provider-version occurrence identity through different accounts.
  Real workerd scenarios verify one run for duplicate observations, a later
  independent occurrence under the remaining delegate, no creator re-enrollment,
  no unrelated same-title match and removal after membership loss.
- Consent and its source wake commit atomically in the existing alarm lane.
  Connection authority triggers, membership and existing reader-reach
  invalidations queue reconciliation. Cursor/token writes are excluded. A real
  connection RPC advances a parked native alarm when a newly enabled account
  becomes available. Migration 130 also wakes existing active configured
  Sidekicks; the migrated SQLite upgrade case excludes paused/empty definitions.
- Twelve production-code negative controls failed their intended assertions:
  admitting an unconsented owner, copying private references, resetting an
  unchanged cutoff, resolving by title, dropping alias provenance, dropping the
  connection trigger, omitting native re-arming, omitting membership invalidation,
  omitting the upgrade wake, omitting the grant wake, removing the outer consent
  transaction, and omitting the normalizer's common occurrence key. All were
  restored. In the transaction control the failed wake left a grant committed;
  the restored fault case proves that both grant and receipt roll back.
- Restored checks: 81 real workerd admission/consent/hosted-Sidekick cases,
  34 Node schema/catalog/alarm-instrumentation cases, and 176 connector cases.
  Lint, repository-wide typecheck and documentation checks passed. The initial
  fault fixture asserted an expected RPC exception across the test boundary and
  produced an unhandled rejection; asserting inside the real owning object
  corrected the fixture. Reader-reach wake wiring is installed but still needs
  explicit multi-session acceptance evidence. No provider preflight, global
  authorization barrier, new retry policy or historical-event replay was added.

### Shared Sidekick controls and creator disclosure

- The shared desktop/web Sidekick screen now renders the allowed list,
  You/Creator markers, public identity presentation, eligibility, self allow/
  withdraw and manager removal. The creator remains separately identified after
  withdrawal. The owner computes management capability with the same check used
  by writes; a viewer's opt-in confers no management right.
- The ordinary Create action follows the standing-work/configured-sharing/
  existing-history disclosure. There is no extra confirmation. A response after
  leaving a pending creation does not navigate the person back; an uncertain
  creation is not repeated automatically.
- Writes keep the last confirmed list until acknowledgement and a fresh read.
  A lost response reads authority rather than repeating consent. If the read
  also fails, Refresh is required before another mutation. Offline controls
  neither dispatch nor queue writes. Each person's pending action is separate.
  Existing automation invalidation and the existing cross-window relay feed the
  query; no additional socket or authorization barrier was added.
- Restored checks passed 129 desktop component/API cases and 81 real workerd
  consent/admission/hosted-Sidekick cases, plus lint, repository-wide typecheck
  and docs checks. Two production-code negative controls made every viewer a
  manager in the response, or dropped creator identity when their active grant
  was absent. Each failed its literal authority assertion and was restored.
- Real local Electron inspection covered the 960×720 default Sidekicks window,
  creation before its request, acknowledged creator enrollment, withdrawal,
  retained creator identity, re-enrollment, offline labeling and disabled
  actions, and an 800×720 compact Details view. Screenshots exposed missing
  padding and a below-fold primary action; placing the section inside the
  profile and avoiding an empty list's spacing fixed those cases. Creator
  disclosure and populated/withdrawn/offline/error/compact screenshots are saved
  in this task's visualization artifacts. The profile intentionally scrolls for
  secondary metadata and longer content.
- Two independent Electron sessions observed withdrawal and re-enrollment in
  both directions without manual reload. Dropping the primary session's POST
  response after the real local server accepted it produced the acknowledged
  error popup, a fresh withdrawn state in both sessions, and exactly one POST.
  Physical input on the offline action produced no deferred withdrawal after
  reconnect. No production data or external provider was involved.
- Additional manager/unavailable/loading/pending visual states and browser-host
  inspection remain unverified. Attempting a staged manager visual fixture lost
  the interactive controller; the orphaned Electron process later showed a
  native `write EPIPE` alert from its closed output pipe. That fixture did not
  produce accepted visual evidence. The Account recovery UI was subsequently
  removed from scope. The complete acceptance audit remains outstanding.

### Receipt-backed activity attribution

- Existing execution-account checkpoints now project participant-safe acting
  user/connection, selected/refused/served state and first-account fallback into
  live invocations and canonical transcript facts. Attribution follows the
  actual checkpoint account rather than the requested connector. Consent
  generations and provider payloads are omitted. Ordinary non-Sidekick tools
  do not add an account-authority read.
- The normal grouped activity keeps account details per operation, including
  within settled work. An ambiguous attempt explicitly says its outcome is
  unconfirmed; missing historical names retain IDs. The feed's existing
  disclosure state retains expanded details through parent remounts. Run history
  preserves its coordinator separately, reusing the mounted delegation query
  for names rather than adding another identity inventory.
- Scoped checks passed 456 desktop cases, 97 API Node cases, and all 22 real
  workerd transcript cases. Production-code negative controls dropped stored
  account attribution or its interrupted-settlement forwarding. Each failed its
  literal assertion and was restored; the restored files passed. Lint,
  repository-wide typecheck, docs and the desktop build passed.
- Real Electron inspection used documented local transcript-cache fixtures:
  960×720 and 800×720, account details within settled work, successful fallback,
  an uncertain Organization-account attempt, missing names/retained IDs, and
  coordinator history. Closing and reopening the outer work disclosure retained
  expanded accounts. These are rendering checks, not live provider execution
  or evidence that full uncertain-write recovery is complete. Screenshot and
  QA inventory artifacts are saved in this task's visualization directory.

### Next integration constraints

The common admission policy, completed-consent replay checks and interrupted
consent receipt reconciliation are installed. Completed and interrupted replay
read current own-grant generation and eligibility without repeating the consent
mutation. The live configured-fallback checks above now cover uncertain
responses; storage/protocol tests alone are not semantic model evidence.

Configured source reconciliation now preserves connection-specific Rally IDs,
provider resource/occurrence identity and unchanged registration cutoffs, as
proved above. The real browser archive check above also covers multi-session
reader-access invalidation.
Canonical activation-event references now retain their source account before
the first tool read. Rooted background children read that host-derived reference
from their existing root-run authority without inheriting instructions or tools.
Provider references produced by completed tool results now move through the
existing host-derived agent exchange within the same Sidekick. Receivers retain
origin identity under their own delegation snapshots, nested handoffs merge
those references, and later executions of an occurrence read its completed
conversation receipts. Unresolved effects and cross-Sidekick messages export no
such context. Validation is recorded in the handoff evidence section below.
Normal activity details now retain serving-account fields from receipt
checkpoints, alongside the separate coordinating user. The Calendar recovery
checkpoint above now covers authorized uncertain-write reconciliation through
real workerd and a provider double; pinning an account alone is not that proof.
Terminal now reuses eligible delegation from its inventory snapshot and retains its
original file identity across coordinators, including completed imports. Its
single selected repository connection stays explicit; observed withdrawal
removes mounted personal GitHub credentials without deleting files. Actual
serving-account activity presentation is wired as described above.
The historical creation, browser and model checkpoints are recorded above.
The final full suite and requirement-by-requirement local signoff are complete.
Real API acceptance and staged UI states are identified separately;
neither a rendering fixture nor a provider double proves production delivery.

The current harness has no model-visible tool-result byte cap
(`docs/agent-harness.md`, execution limits). Lists remain complete; do not invent
a numeric cap for the PRD's conditional inherited-budget refusal.
