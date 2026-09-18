# Implementation and acceptance evidence

## Final implementation status

The requested lite collaboration feature is implemented. The current scope and
remaining deployment tasks are in [completion-audit.md](completion-audit.md).
The dated evidence below is a historical implementation log; its intermediate
"pending" and "unfinished" statements do not override this status.

- [x] Ordinary user identities with guest workspace relationships and
  identity-preserving promotion.
- [x] Email magic-link and OTP entry, explicit redemption, resumable cookie
  sessions and invitation acceptance without setup or onboarding.
- [x] Main, independent child and complete-workstream shares, multiple recipients
  and reusable guest relationships across workstreams.
- [x] Parent-owned grants, on-first-share participant migration, monotone local
  admission projections and durable revocation delivery.
- [x] Existing participant, message, resource and connector mutation paths with
  exact conversation admission and ordinary actor attribution.
- [x] Sidekick recommendation, local loading/removal, management, authoring and
  history admission follow their existing scope authorities.
- [x] Existing substream history and saved context remain unchanged; no new
  context-selection or review workflow during sharing.
- [x] Static HTML entry and persistent lite SPA, shared conversation core and
  direct ticketed sockets; no server socket multiplexer.
- [x] Sharing UI, scoped navigation, promotion/session refresh and unsupported
  native guest protocol rejection.
- [x] Existing-member attachment cost preserved; already-seated sends bypass
  grant preparation. Actual additions coordinate with the parent by user choice.
- [x] Final queued-command/active-run source audit completed. Existing runtime
  evidence and final targeted validation are recorded in the completion audit.

Production browser origin/service configuration, email policy and actual mailbox
and deployed stateful-site checks are release tasks, not additional lite-client
features. No deployment is included in this implementation.

## Current evidence

The entries below record incremental implementation and verification. The open
checklist above remains the completion boundary; these backend foundations do
not constitute the complete guest or browser experience.

2026-09-16 foundation validation:

- Eight policy cases passed in the API Node suite.
- Five real-workerd cases passed for durable grant writes, command replay,
  stale revision rejection, exact acknowledgement, transaction rollback,
  independent scopes and populated v13 migration.
- Four deliberate production mutations failed for the expected assertions:
  skip revision admission, discard the grant update, remove transaction atomicity,
  and widen the migrated child audience. All mutations were restored.
- Repository-wide `pnpm lint` and `pnpm typecheck` passed.
- After restoring mutations, both the grant-storage and existing workstream
  schema-migration files passed together: 12 real-workerd tests.

Next: connect grant storage to canonical actor admission and participant migration,
then carry effective access through serving paths before enabling guest sessions.

2026-09-16 identity persistence validation:

- Migration 0108 preserves users and their 21 dependent tables with foreign keys
  enabled, retains existing triggers, permits email-only users and backfills
  verified login bindings for existing Google identities.
- Google sign-in now maintains verified bindings atomically. Email identity
  resolution reuses only a verified primary address and converges first-login
  retries; it is not yet exposed as an authentication endpoint.
- Six scoped identity/auth test files passed (22 cases), the database suite
  passed (40 cases), and repository lint/typecheck passed.
- Deliberately returning a new identity on retry, retaining an old mailbox,
  bypassing verified-address binding and omitting session restoration each
  failed the intended integration case. Production mutations were restored.

Email challenge verification, invitation acceptance and browser session issuance
remain unchecked. Existing Google users must explicitly link a new provider;
matching an email alone never merges accounts.

2026-09-16 relationship persistence validation:

- Migration 0109 and `workspace-relationship-service.ts` implement guest creation,
  non-reactivation of suspended guests, identity-preserving promotion, incarnation
  fences and transactional membership delivery intents. A full membership
  invitation explicitly promotes an existing guest.
- Scoped relationship, invitation and auth tests passed (37 cases); the database
  suite passed (40 cases), and repository lint/typecheck passed.
- Mutation proofs caught reactivating a suspended guest, skipping administrator
  admission, ignoring the incarnation fence, omitting a durable delivery intent,
  and overwriting an existing owner's role during migration. All restored.
- Guest-facing routes and sockets are not enabled. The existing member-only
  middleware rejects null-role relationships until scoped serving is integrated.

2026-09-16 membership delivery validation:

- The existing cron dispatches durable membership intents to the existing access
  revocation queue. Active changes publish WorkspaceDO profile/member/directory
  invalidation; removals and suspension start the existing revocation walk.
- Dispatch and root processing are recorded separately. Neither is an assertion
  that all descendant holders have applied the revocation. The descendant
  acknowledgement tracker and incarnation-aware socket/ticket admission remain open.
- Three real-workerd cases passed using real D1, Queue sends, WorkspaceDO state
  and a real WebSocket. Recovery after a successful send but failed marker write
  preserves the intent for retry.
- Deliberately dropping the send, invalidation and socket-revocation call failed
  the respective tests. The socket case timed out waiting for the missing close
  event. Production mutations were restored.
- The scoped Node revocation/relationship suite passed (37 cases), and repository
  lint/typecheck passed. This does not yet make logout publication durable.

2026-09-16 grant authority validation:

- WorkstreamDO now exposes typed exact-scope read and mutation RPCs backed by
  its grant ledger and current D1 workspace relationships. Main admission is not
  a prerequisite for an independently shared child. Implicit member reading
  cannot be used to share, and inactive recipients cannot receive new grants.
- The first real-runtime run exposed expected denials as unhandled RPC exceptions.
  Denials now use typed results. The corrected run and final storage/authority
  run passed without runtime errors (nine real-workerd cases in the final run).
- Deliberately leaking a child grant into Main, allowing implicit readers to
  share, inheriting a restricted child and admitting a suspended recipient each
  failed its integration case. All production mutations were restored.
- Thirteen scoped Node policy/relationship cases passed. Final repository lint
  and typecheck passed after correcting a narrowed test-helper parameter type.
- Existing participant migration, initial-owner bootstrap, local admission
  projection delivery and replacing legacy serving checks remain incomplete.

2026-09-16 participant handoff validation:

- Substream migration 62 preserves populated v61 participants. Preparing a
  transfer snapshots active participants and freezes admission changes at the
  SQL table, covering callers that bypass identity methods. Read-position
  updates remain available. Same-token prepare and commit retries are stable;
  a different token cannot take over, and commit does not reopen the old ledger.
- Two real-workerd integration cases pass. Disabling the production write
  fence caused both cases to fail because legacy writes unexpectedly succeeded;
  restoring it made both pass again. Repository lint and typecheck pass.
- This storage mechanism is deliberately not invoked by live serving yet.
  Parent import, the admission projection receiver, migration orchestration
  and replacement of legacy participant writers remain required for cutover.

2026-09-16 receiving import validation:

- Added scope import receipts to the unpublished WorkstreamDO migration 14.
  Each scope can import once; a changed token or roster conflicts. A scope with
  existing grants or tombstones cannot be overwritten by a late import.
- Real-workerd cases cover replay after revocation, private-child scope isolation,
  whole-import rollback when the receipt fails, delivery intent creation and
  refusal to overwrite a tombstone. Removing the outer transaction failed the
  rollback case; skipping the receipt lookup failed the replay case. Both
  production mutations were restored.
- The final combined source/receiver run passed all ten workerd cases;
  repository lint and typecheck passed.
- Source and receiver storage are now present. Live migration still requires
  orchestration, a versioned admission projection receiver and writer cutover;
  creating the tables alone does not migrate any existing workstream.

2026-09-16 participant projection validation:

- Added the versioned roster receiver to unpublished Substream migration 62.
  It requires the committed transfer token, records per-user revisions including
  absent-user revocations, rejects same-revision payload conflicts and ignores
  older messages. The projection writes and revision receipt commit atomically
  while the legacy write fence remains closed outside the transaction.
- Re-admission advances participant epoch and clears the opened marker;
  unchanged active access preserves both. Tests cover initial admission,
  revocation, re-admission, delayed delivery, duplicate/conflicting delivery and
  a failed receipt that must roll back both the roster and write permission.
- Removing the stale fence failed two workerd cases. Removing the transaction
  failed the rollback case. Restored source/receiver suites passed all thirteen
  cases; repository lint and typecheck passed.
- This is storage-level receipt application. Parent effective-access production,
  membership incarnation fences, participant lifecycle effects, socket closure,
  durable delivery and live migration orchestration remain to be connected.

2026-09-16 projection RPC and socket validation:

- Added exact-address `SubstreamAgent.applyParticipantProjection`. Roster
  transitions and regional participant/directory effects share one durable
  commit. Retries avoid duplicate effects and still complete interrupted socket
  closure. A fresh local projection read after effect scheduling protects a
  newer admission from a delayed removal.
- The runtime case uses a real admitted feed socket, verifies removal closes it
  with 1008, verifies one directory effect revision across duplicate delivery,
  then re-admits and proves an older removal leaves the new socket open.
- The initial effect assertion raced the normal alarm's successful outbox drain.
  The test now uses the existing queue-outage helper to hold effects durably
  until inspected. Production queue behavior remains unchanged.
- Skipping socket closure, trusting the stale request instead of current
  projection, and skipping effect publication each failed this integration case
  at the corresponding assertion. All three mutations were restored.
- The final targeted real-workerd RPC case, repository lint and typecheck pass.
- Producer-side effective-access computation, membership fences, durable delivery
  and orchestration remain outstanding; this RPC is not yet called by live grant
  mutations.

2026-09-16 grant-driven projection delivery:

- Registered conversation targets now receive the union of direct and inherited
  grants. The grant, effective roster payload and retry alarm commit together.
  Newer pending revisions replace older ones; acknowledgement matches the exact
  revision so a delayed response cannot erase later work.
- WorkstreamDO's alarm sends the actual SubstreamAgent RPC. Applied, duplicate
  and superseded results acknowledge the payload; receiver refusal or transport
  failure retains it under the existing scheduler retry policy.
- A real-runtime pipeline case imports an existing roster, registers Main,
  revokes a grant through the parent RPC, runs the real alarm, observes feed
  socket closure and verifies receiver revision plus sender acknowledgement.
  The initial fixture correctly denied its actor because it had not joined the
  workstream; the fixture now creates that actor as a participant before import.
- Storage cases cover overlapping grants, stale acknowledgements and rollback
  when scheduling fails. Removing direct-grant union handling and omitting the
  alarm schedule each failed their respective runtime assertions.
- Skipping the actual child RPC made the end-to-end socket closure case time
  out, proving that acknowledgement alone cannot satisfy it. All production
  mutations were restored. Nineteen storage/authority/handoff workerd cases,
  repository lint and typecheck passed after restoration.
- Both final projection pipeline cases passed after restoration as well.
- Live handoff orchestration and membership incarnation fencing remain
  incomplete. Target registration is still exercised by the migration fixture,
  not invoked automatically on existing production workstreams.

2026-09-16 Main migration orchestration:

- Added an internal parent migration command and stored alarm. Pending state
  fences grant mutations; an existing parent grant ledger prevents starting a
  legacy import. The source checks workspace, parent, Main identity and token.
- The full runtime pipeline now starts the actual orchestration instead of
  preparing/importing the roster directly in fixture SQL. A trigger fails the
  parent completion commit after Main has committed its transfer. The test
  proves the same token survives, grant mutations are refused while pending,
  the retry completes, and a subsequent grant revocation closes a real socket.
- The retry test initially read completion while the real alarm was still
  running. It now waits for the persisted completion record after advancing
  the test's retry gate; no direct private-method call remains in the test.
- Skipping the pending mutation fence failed the expected denial assertion;
  skipping source commit failed the persisted-source-phase assertion. Restoring
  production code passed twenty storage/authority/handoff cases, lint and
  typecheck.
- Both runtime projection cases passed three consecutive runs. The failure
  stage and completion stage wait for durable scheduler state, so an alarm
  already executing when the helper checks cannot make the assertion premature.
- Private-child migration, initial-owner bootstrap, legacy writer replacement,
  membership incarnation fences and activation from application routes remain
  outstanding. Main handoff completion is not full feature completion.

2026-09-16 private-child migration:

- The shared source transfer RPC now checks the exact conversation address.
  Child orchestration freezes the parent's canonical membership rows and imports
  active memberships into exact child grants in one transaction. A stored alarm
  freezes/commits the child's local receiver and registers its projection target.
- Local child participants are only a reconciliation audience. A stale local
  participant gets a removal projection rather than an imported grant. Main's
  roster and authority remain untouched by a child migration.
- Legacy child effect receipts remain stored but are excluded from delivery and
  wake-up selection for migrated children; triggers refuse old membership writes.
  Existing grant ledgers reject migration instead of being overwritten.
- The runtime test starts with a canonical revoked user still active locally
  and a canonical active user absent locally. Migration produces only the active
  canonical user's exact child grant and fixes both local roster discrepancies.
  Removing the active-only import predicate produced a revoked user's grant and
  failed its assertion; disabling the write fence failed the legacy-write check.
- Twenty-one storage/authority/handoff workerd cases, lint and typecheck pass.
  The initial typecheck identified a missing branded SubstreamId type import;
  it was corrected before the passing run.
- Four final pipeline cases pass: child migration, Main migration/revocation,
  direct projection delivery, and the existing unmigrated child message path.
  The migrated child's old effect receipt remains pending with zero attempts,
  confirming it was retained without being replayed as admission authority.
- Application activation, initial-owner bootstrap, legacy writer/serving cutover
  and membership incarnation enforcement remain incomplete.

2026-09-16 migrated child writers:

- Existing child add/remove RPCs now select the canonical grant path after
  migration. They no longer require Main admission or write the frozen legacy
  membership table. Revisionless compatibility actions retain their original
  operation receipt, and explicit-revision mutations share the same admission
  policy. The existing keep-one-participant rule is evaluated across applicable
  grants, including inheritance.
- The child pipeline adds and removes a person through those existing methods,
  retries the original addition after removal and verifies it does not restore
  access. It checks that the old membership version stays untouched and that
  removing the last remaining participant is refused.
- Selecting today's revision instead of the first operation's revision failed
  the real-storage replay test. Disabling the remaining-participant check failed
  the runtime refusal assertion. Both mutations were restored; twenty-two
  storage/authority/handoff cases, lint and typecheck pass.
- Four final pipeline cases pass, including the migrated child writer and the
  existing unmigrated child message path.
- Main participant writers, automatic participant admission from messages and
  connectors, serving checks and initial-owner bootstrap still require cutover.

### Main refresh and Sidekick architecture recheck

- Rebased onto `31afcc6ae`, preserving the unfinished guest implementation.
- Kept upstream receipt-owned pagination migration 61 intact and moved the
  unpublished participant transfer migration to 62. The migration fixture now
  starts from populated version 61.
- Rechecked Sidekick lifecycle and service paths: WorkstreamDO owns explicit
  recommendations, ownership implicitly recommends, and each SubstreamAgent
  persists its own loaded attachments. Section 5A of the design remains the
  guest integration contract; guest-aware Sidekick serving is still outstanding.
- Validation after conflict resolution: 36 focused workerd tests, 18 schema
  tests, repository lint and typecheck passed. The schema check exposed a stale
  version constant and omitted participant tables in its expected inventory;
  both were corrected. No deployment or serving cutover was performed.

### Existing product participant actions after handoff

- Migrated Main and child product add/remove actions use canonical grants and
  preserve the existing retained-content admission check on additions.
- Compatibility commands deliver the newest addressed roster projection before
  replying; the transactional alarm remains the durable retry path. Service
  callers can carry an operation ID across retries. Superseded additions return
  a conflict without restoring access, and last-participant removal is refused.
- Main product endpoint coverage uses a real second-user session after migration
  and exercises add/remove, duplicate commands and superseded-add replay. Guest
  serving, automatic admissions, browser sign-in/UI and full revocation delivery
  remain unfinished; this does not enable live migration.
- Validation: 17 grant authority/storage tests and four selected pipeline tests
  passed in real workerd; repository lint and typecheck passed. Disabling the
  migrated product branch made the endpoint test fail with
  `participant_authority_transferred` from the frozen legacy roster. The branch
  was restored and the pipeline passed again.

### Migrated conversation admission

- Parent viewer admission and canonical AuthorizationService reads now use
  exact grants for migrated conversations, including an independent child with
  no provisioned Main agent. Pending migration and suspended relationships deny
  admission; revocation denies immediately at the parent before roster delivery.
- Projection acknowledgement retains the current canonical payload and revision.
  Pending delivery queries exclude it; newer projections reset acknowledgement.
- Migrated child socket admission uses the applied projection version instead
  of the frozen legacy private-child membership version. A real child socket
  opens after grant delivery and closes with code 1008 when the grant is removed.
- Main socket fencing, guest session contracts, remaining serving surfaces and
  live migration activation are still outstanding.
- Validation: 18 grant/storage tests, four pipeline tests and 23 existing search
  authorization tests passed in workerd; lint and typecheck passed. Disabling
  migrated parent admission denied the independent child; disabling migrated
  local membership admission made its real socket upgrade return 403 instead
  of 101. Both mutations were restored and the affected suites passed again.

### Session membership incarnation

- Migration 0110 binds existing and newly created workspace sessions to their
  admitting membership incarnation. Workspace selection rebinds; assigning the
  same workspace again does not. Promotion preserves the binding.
- HTTP authentication, atomic refresh-token rotation and all three socket
  authorities reject a session from an earlier removed/recreated relationship.
- Guest admission remains disabled at member-only middleware; this session
  fence is a prerequisite, not completion of guest sign-in or browser access.
- Validation: 36 auth/room Node tests, six relationship/migration tests and 40
  database tests passed. Runtime coverage passed 76 socket/profile tests, 80
  affected fixture tests, four selected conversation pipeline cases and the
  three relationship-delivery cases. Final lint and typecheck passed.
- Production mutation proofs: removing the HTTP incarnation predicate admitted
  the stale bearer; removing the refresh predicate rotated the stale credential;
  removing WorkspaceDO's predicate left the old socket open. Each corresponding
  test failed, then passed after restoring the predicate. Final reruns passed
  all 11 auth/migration tests and both session-inactive socket cases.

### Passwordless identity backend foundation

- Migration 0111 stores one challenge for link and OTP, encrypted delivery intent
  and a resumable session receipt. POST redemption atomically selects one winner;
  scanner GETs do not consume it. A retry resumes the same identity-only session.
- Rotation/revocation rejects the old receipt. Email delivery retries preserve
  provider key and payload; failures remain pending for scheduled recovery.
- Policy, browser origin and sender require explicit configuration. No production
  policy values were chosen or deployed. Browser cookies/UI, invitations, resend
  policy, retention and guest-aware serving remain unfinished.
- Mutation proof: removing the SQL consumption fence admitted both concurrent
  proof types and failed the test; the fence was restored.
- Validation: all 15 focused email/auth tests and 40 database tests passed;
  repository lint, typecheck and diff whitespace checks passed.

### Guest session representation and workspace selection

- Session/workspace contracts represent guests with `accessClass: guest` and a
  null workspace role; missing access class retains the legacy member contract.
  Invalid combinations are rejected. Desktop session/directory data adapters
  preserve that distinction without assigning a member role.
- Identity middleware recognizes current guest relationships and incarnation
  fencing. Member-only product middleware remains closed to guests until its
  route admission uses scope grants.
- Email-only identities can discover active regional relationships and select
  an authorized workspace via `/auth/workspaces` and `/auth/workspace/select`.
  Refresh retains guest classification and reflects promotion on the same user.
- Validation: 41 auth/onboarding tests, seven contract tests and 21 desktop
  session/directory tests passed. Removing active-membership filtering exposed a
  suspended workspace and failed the new integration test; restored and passed.
  Typecheck passed. Browser UI, cookie transport, full grant-aware product
  admission and cross-deployment provider-independent discovery remain unfinished.
- Final repository lint, typecheck and whitespace checks passed.

### Main socket grant revision fencing

- Migrated Main and child feeds now compare ticket/admission revisions to the
  active local participant projection. Main no longer bypasses this check, and
  its speculative preparation carries the current parent-issued revision.
- A real Main WebSocket test rejects a pre-migration revision, admits the current
  revision and closes the socket after canonical grant revocation. Restoring the
  old Main bypass made the stale handshake return 101 instead of 403 and failed
  the test; the bypass was removed again.
- Guest-aware conversation routes, nullable-role socket protocol and source
  eligibility checks remain unfinished; this change does not enable them.
- Validation: three real-workerd projection/migration/socket cases and 23 Node
  transport/read-state cases passed. The existing re-admission fixture now sends
  its new projection revision, as a real reacquired ticket would. Final repository
  lint, typecheck and whitespace checks passed.

### Guest product and feed identity protocol

- Workspace-bound server identities, product requests, signed feed tickets,
  forwarded admission and hibernating socket attachments preserve a null guest
  role. Missing legacy role fields still trigger reauthorization; null does not.
  No caller synthesizes a member role for guest mutation or connector attribution.
- The real migrated-child case now uses an active guest relationship: it renames
  the child, sends an explicitly addressed message over its feed, is denied Main
  by canonical grants, and loses its socket after child-grant revocation.
- The initial message fixture invoked an unconfigured external classifier. Using
  an explicitly addressed request exercises the existing deterministic admission
  path and avoids requiring a live model for the authentication test.
- Mutation proof: removing null from the product authentication schema rejected
  the guest rename with 400 instead of 200. The schema was restored.
- Public conversation route admission, Sidekick source eligibility and the browser
  remain unfinished; the member-only API gate has not been opened globally.
- Validation: four real-workerd pipeline cases and 18 signed-ticket transport
  tests passed; repository lint, typecheck and whitespace checks passed.

### Public guest conversation access

- Workspace-relationship middleware admits bound guest identities separately
  from member-only routes, retaining request-local authentication and last-seen
  updates. Exact snapshots, feed tickets, read-state and child title changes use
  it; unrelated member routes remain guarded.
- Parent admission accepts a required-grant-authority constraint. Guest calls
  set it, so legacy workspace-public membership cannot expose Main or a sibling.
  Sidekick authoring admission cannot satisfy it until source/history policy is
  integrated. Member behavior retains the existing parent authority paths.
- Added exact substream REST boot recovery. The real-workerd case now uses the
  full application router: guest bearer auth, child rename/read, signed ticket,
  real upgrade, socket message and revocation. Main, siblings and revoked reads
  or tickets return 404; unauthenticated reads return 401.
- Mutation proof initially survived against a personal parent; the fixture was
  strengthened to cover workspace-public legacy visibility. Removing the guest
  grant requirement then exposed Main with 200 instead of 404. Restored it.
- Invitations, additional mutation surfaces, resource/search audience completion,
  Sidekick source/history policies and the browser experience remain unfinished.
- Validation: four real-workerd pipeline cases and 30 auth/conversation/transport
  tests passed; repository lint, typecheck and whitespace checks passed.

### Guest resource metadata and bytes

- Canonical authorization observes workspace access class. Guests cannot inherit
  legacy conversation or Sidekick authoring visibility; non-owned resources need
  a canonical attachment in a granted migrated conversation. Own upload drafts
  keep their existing ownership access.
- Public resource metadata, content, version and preview routes use this policy
  with bound guest sessions. General listing, hydration, resolution, artifacts
  and mutations remain member-gated pending their scoped integrations.
- The real HTTP/R2 case reads a file attached to the guest's child and refuses a
  populated file attached only to Main. Revoking the child grant prevents another
  download. Direct policy coverage also preserves access to the guest's own draft.
- Two mutation proofs independently exposed the Main-only file's bytes with 200:
  removing the guest attachment requirement, and restoring legacy conversation
  fallback. Both changes were restored.
- Existing resource fixtures now declare member access class. The search-universe
  fixture also initializes the canonical workspace used by background resource
  work, even when the directory test itself uses a separately named object.
- Validation: four real pipeline cases, six search-universe cases and 39 Node
  resource/authorization/auth cases passed. Canonical workspace fixture setup
  removed the background identity-mismatch diagnostics. Repository lint,
  typecheck and whitespace checks passed.

### Latest main refresh

- Rebased onto `791905edb391db2af09daae1867e9b1b7de5ba44` and restored all
  uncommitted work without conflicts. Kept the pre-rebase stash as a backup.
- This upstream delta changes release configuration only. Rechecked Sidekick
  lifecycle, recommendation service and source eligibility; section 5A remains
  the integration contract. Updated its source references to this revision.
- Guest-aware Sidekick serving remains unfinished; this refresh does not claim
  that the proposed access rules are implemented.

### Guest uploads, attachment mutations and canonical message delivery

- Guest workspace sessions can upload and delete their own unsent drafts. Exact
  Main/child routes can attach or detach existing resources. Product checks both
  the target conversation and canonical source resource access; a known resource
  ID does not allow copying an inaccessible file into a shared conversation.
- Unpublished uploads enter through message admission. Existing-file attachment
  returns a conflict until publication, preserving draft reservation/deletion
  semantics. After publication, detach and reattach retain the original bytes.
- Real guest message delivery exposed a legacy participant upsert that the
  migrated roster correctly rejects. Active participants now receive only local
  first-opened metadata updates; delivery does not re-grant their membership.
  New automatic participant admission still needs canonical-grant integration.
- Transcript promotion now carries exact input/resource holds in its delivery
  result. Its preparation rows have already been removed when common effects
  are built, so reconstructing holds from those rows dropped publication data.
- The existing Queue consumer publishes accepted conversation reservations in
  WorkspaceDO after parent admission and before acknowledgement, independently
  of workspace directory projection. This handles private children without
  publishing their directory content. Replayed delivery converges and releases
  only the named reservation.
- Real workerd covers multipart upload, private draft bytes, rejected premature
  attachment, canonical socket message delivery, publication and replay, draft
  deletion refusal after sending, detach/reattach, source-resource refusal, and
  revocation. The fixture now includes its child creator, which actual child
  provisioning records and directory delivery requires.
- Four deliberate production mutations failed at the intended boundaries:
  removing source checks exposed an inaccessible file (201); removing the draft
  guard allowed premature attachment (201); dropping publication left the file
  a draft; restoring legacy participant upsert prevented canonical delivery.
  All mutations were restored.
- Final validation: 4 focused pipeline tests, 8 reservation/effect-queue tests,
  73 resource/transcript Node tests, repository lint/typecheck and diff check
  passed. No uncaught runtime diagnostics remained. No deployment or UI claim.

### Guest Sidekick summaries, use and local removal

- Exact conversation routes now expose recommended and locally loaded Sidekick
  summaries to guests. Recommendations combine workstream ownership with
  explicit recommendations; child reads never preflight Main.
- Source-owned summary reads expose only ID, name, description and availability.
  They share the instruction reader's source/audience policy, independently of
  source authoring or history. Paused sources remain visible but unavailable for
  new loads. Missing/deleted or ineligible discovery IDs cannot disclose metadata.
- New guest executions discover existing recommendations, workstream-owned and
  conversation-local sources. They do not enumerate unrelated workspace skills.
  Already admitted snapshots retain existing source revalidation semantics.
- Local removal checks the selected SubstreamAgent's participation and archive
  state and uses the existing automations invalidation. It preserves Main,
  sibling attachments and shared recommendations.
- A real workerd guest socket message drives the ordinary agent runtime through
  an external-provider test double, calls load_skill, completes, and persists the
  local attachment. Public reads/removal then verify child-only effects and
  reject reads after revocation. Main and authoring history remain inaccessible.
- Four deliberate production mutations failed: bypassing summary source policy
  disclosed private/other-workstream sources; skipping guest selection exposed
  an unrelated workspace skill; skipping conversation admission admitted Main;
  dropping local deletion left the attachment present. All were restored.
- Final validation: all 28 automation runtime tests, 4 focused guest pipeline
  tests, 11 related Node tests, lint, typecheck and diff check passed. Workstream
  management grants, source authoring/history, invitation flows and browser
  presentation remain incomplete. Nothing deployed.

### Review findings: relationship lifetime, directory and client compatibility

- Grants now bind the recipient's membership incarnation. Removal and reinvitation
  leave old grants inactive; promotion retains them. A new sharing operation may
  bind the new relationship, while replay returns the original receipt. Legacy
  Main migration freezes its incarnation map in the pending journal; child import
  freezes the map in the same local transaction as its receipt.
- Membership removal uses null-safe role comparison plus incarnation/revision
  fencing. The ordinary member directory preserves a guest's null role and
  explicit access class; Settings displays Guest alongside ordinary member roles.
- Membership revocation carries the removed incarnation through descendant hops.
  Holders compare immutable D1 session bindings before closing sockets or removing
  artifact viewer sessions. Artifact deletion uses the app-session binding because
  redeeming an open code can rotate its viewer digest during that D1 await.
- Desktop platform discovery/activation withholds guests until its scoped shell
  exists. Regional browser/API discovery and selection remain guest-aware. This
  prevents a successful activation followed by a failed member-only bootstrap.
- Both optional email-login variables are documented and serialized into local
  regional Worker configuration. No deployment policy values were invented.
  Authorization and revocation docs now match the implemented scope boundaries.
- Validation: 49 focused Node tests, 104 Workers tests, 21 artifact runtime tests,
  155 Settings tests and 454 script tests passed. Restored artifact/revocation
  files passed together (26 tests). Six deliberate negative controls failed at
  the intended boundaries and were restored. Lint, typecheck, document headings
  and diff checks passed.
- The broader Workers run logged a Miniflare QueueBroker disconnected-request
  diagnostic despite all tests passing; the focused final revocation/artifact run
  did not. This is not evidence of a production failure or a failed assertion.
- Visually inspected the actual Settings component in an isolated Electron window
  with owner/guest fixture data: names, emails and Owner/Guest badges were legible
  and aligned. This verifies presentation, not end-to-end invitation onboarding.
  Browser shell and invitations remain unfinished. No deployment or commit.

### Lite browser scope and guest promotion

- The user clarified that the browser is a lite collaboration client with no
  workspace setup, connector setup, onboarding or desktop settings. The PRD and
  architecture now state that scope; shared conversations, resources, scoped
  mutations, existing connectors and eligible Sidekicks remain required.
- Desktop workspace Settings now offers Make member to administrators for guests.
  The shared directory carries membership incarnation/revision; the public
  promotion route guards both along with the current actor's administrator role.
  It upgrades the existing relationship and records the existing durable delivery
  intent. Refresh retains the original user's session binding and exposes member
  access. A conflict refreshes the directory for a subsequent deliberate action.
- `test/auth-router.test.ts` and `test/workspace-relationship-service.test.ts`
  passed (16 tests); the complete Settings test file passed (156 tests).
  A deliberate production mutation that preserved guest access instead of
  upgrading it failed the route test. After restoration, all 10 auth-router
  tests passed. Lint and typecheck passed.
- Inspected the actual Settings component in an isolated Electron window before
  and after clicking Make member with fixture data. The guest label and button
  fit the row; the refreshed row retained the person's name/email and displayed
  Member with no promotion button. Server behavior is independently covered by
  the migrated-SQLite route tests, rather than claimed from the UI fixture.
- Invitations and the lite browser client remain open work. No PR was opened.

### Durable scoped invitation protocol

- WorkstreamDO now owns recipient/target invitation batches, immutable operation
  receipts, encrypted email intents and the existing alarm-driven delivery path.
  Retry preserves the invitation IDs and frozen credentials; changed input conflicts.
- Public `/sharing` creation/revocation takes its actor from the session.
  `/sharing/accept` accepts identity-only sessions and independently verifies the
  recipient mailbox, secret, inviter membership incarnation and sharing authority.
- Acceptance reuses the guest or full-member relationship, then commits every
  target grant with its acceptance receipt in one owner-local transaction. A
  failed target rolls all grants back. Replaying acceptance cannot restore a
  revoked grant or recreate a removed membership. Adding another workstream
  preserves the same user and relationship; full members retain their role.
- Creation refuses targets whose participant-authority handoff is incomplete,
  rather than installing grants that would conflict with later legacy import.
  Public sharing controls and the live migration/bootstrap path remain necessary.
- Ten real-workerd invitation tests cover D1, owner SQLite, real RPC/alarms and
  authenticated HTTP routes. The invitation, grant-authority and grant-storage
  files passed together (29 tests). The restored invitation file passed again.
- Four deliberate production mutations failed as intended: bypass mailbox proof,
  remove acceptance transaction atomicity, drop target grant writes, and skip the
  handoff readiness gate. All were restored. Lint, typecheck, document headings
  and diff checks passed. An expected SQL rejection is caught inside the real
  object to avoid the test RPC bridge's duplicate unhandled-rejection report.
- This completes the backend owner-local invitation protocol, not the sharing
  interface or lite browser acceptance experience. No email was sent externally,
  and no PR or deployment was performed.

### First-share participant preparation

- Invitation creation now prepares addressed legacy scopes in the foreground,
  retaining the existing durable transfer token and alarm for interrupted work.
  Main uses its canonical source roster; children use parent-owned membership.
  Workspace-public reads and stale child rosters cannot initiate cutover.
- Current relationship/grant authorization still runs after preparation, before
  invitation storage. Child-only preparation leaves Main untouched. Conflicting
  legacy imports remain a retryable migration result rather than stranding grants.
- Real workerd invitation and message-pipeline files passed all 49 tests. Three
  deliberate production breaks (skip preparation, bypass Main participation,
  reverse the active child membership predicate) each failed the relevant test.
  After restoration, both changed integration cases passed again.
- Lint, typecheck, documentation checks and whitespace checks passed. This is
  backend progress; browser presentation, remaining participant writers and the
  full end-to-end acceptance audit are still open. No PR was opened.

### Message participation after handoff

- Human-message admission now routes self-joins and canonical, confirmed person
  mentions through the grant owner before the message commits. A self-join can
  only add that user to a writable conversation, never grant its workstream or
  another person. Existing inherited grants remain inherited.
- Stable message/user operation IDs preserve retries. The owner delivers its
  latest projection, and admission verifies the resulting participant rather
  than trusting an old successful grant receipt.
- Transcript activation after handoff only retains already-active participants;
  an older queued message cannot write new legacy participant rows. A real
  queued-before-handoff case still reaches the provider boundary without
  activating its ungranted mention recipient.
- Validation: 59 worker cases across the message pipeline, grant authority and
  invitations, plus 49 transcript-storage cases passed. Deliberately skipping
  grant preparation, adding a direct grant over inherited access, and restoring
  legacy queued participant writes each failed the relevant integration case.
  All three restored integration cases passed.
- Participant controls, external/connector participant writers and the lite
  browser client still need completion. This evidence does not close those
  acceptance items or authorize a PR before the complete feature is ready.

### Main participant controls and inherited access

- A migrated Main participant action now targets the Main conversation grant,
  allowing a Main-only guest to add/remove collaborators without workstream
  authority. It never silently creates a parent grant.
- Effective participant removal refuses inherited access before changing either
  overlapping grant. Parent sharing must be managed explicitly. A removal retry
  superseded by a later share reports continuing access and emits no false
  participant-removed event.
- Updated the participant dialog to name the main conversation and removed the
  obsolete claim that child collaborators need parent access. Viewed the actual
  dialog in Electron for Main, the inherited-access error, and a child; text and
  controls were legible. These were isolated UI fixtures, not browser acceptance.
- Validation: 60 real worker tests passed across the pipeline, scope authority
  and invitations; 115 renderer tests passed across both affected screen files.
  Restoring parent-wide Main writes, bypassing the inherited-access guard, and
  reporting success for superseded removals each failed the integration case.
  Lint, typecheck, docs and whitespace checks passed.
- The broad worker run printed workerd alarm-timing/request-drain diagnostics
  while all tests passed; no assertion or unhandled-test failure was reported.
  Workstream sharing management, remaining legacy writers and the lite browser
  remain unfinished. No PR was opened.

### Regional browser session boundary

- Added migration 0112: an opaque credential hash addresses an ordinary identity
  session, and a per-browser/workspace map selects ordinary workspace sessions.
  Concurrent tabs do not share an active-workspace field. A conditional mapping
  write retires unused concurrent activation sessions.
- Added browser email redemption, HttpOnly host-only cookies, session metadata,
  workspace discovery/selection, existing-policy renewal and whole-browser
  logout. Browser JSON does not expose access or refresh tokens. Link GETs do
  not redeem credentials; mutations require the configured Origin.
- The HTTP adapter accepts only product route families, chooses auth from the
  cookie and addressed workspace, strips development identity headers, and
  forwards through the ordinary API. Bearer and browser transports share the
  same session/incarnation authentication helper.
- Validation: 23 Node cases across browser sessions, auth routing and email
  login passed using real migrations. A real workerd/D1 case additionally
  verified concurrent activation and independent tab sessions across rejoin.
  Five deliberate Node breaks (Origin, workspace selection, incarnation,
  lifetime ceiling and child logout) failed; removing the conditional mapping
  write also failed the real-D1 test by leaving an extra live session. Restored
  suites passed. Lint, typecheck, docs and whitespace checks passed.
- The same-origin frontend host, SSR entry, shared application core, navigation,
  invitation UI and sockets are still open work. These backend tests do not
  establish a usable browser application or complete the feature. No PR opened.


### Browser host and passwordless entry

- Added `apps/browser`: a Vite client and a Worker that server-renders email
  entry, serves built assets and forwards `/regional/global/browser/*` through
  the configured API service binding. No arbitrary upstream hosts are accepted.
- Moved credential-free session and email exchange schemas into contracts. Email
  magic links now carry their configured deployment in the fragment.
- Added email/OTP entry, explicit magic-link confirmation, session restoration,
  workspace list and sign-out. Magic proofs are removed from history and kept
  only in document memory. Failed email issuance retries preserve the operation
  ID; redemption retries preserve their ID. No setup/onboarding flow was added.
- Three real workerd host tests pass. Deliberately removing SSR content, dropping
  the forwarded request, and bypassing the browser-route allowlist each caused
  the relevant test to fail; restored tests pass. The existing 23 backend email,
  session and auth tests pass after sharing the schemas.
- Inspected actual Electron Chromium windows at desktop and mobile sizes. The
  built SSR page hydrated without browser errors; OTP, explicit magic redemption,
  failed-issuance retry with the same ID, workspace metadata rendering and logout
  passed with mocked API responses. Screenshots were read. This is client flow
  evidence, not end-to-end email/invitation evidence.
- Lint, typecheck, docs check, diff check and browser Worker dry-run build pass.
  Dependency resolution was constrained back to the existing lockfile versions;
  the lockfile adds only the new workspace importer.
- Invitation acceptance, canonical destination activation, shared collaboration,
  socket routing/handoff and remaining guest authorization work are still open.
  The browser has no production hostname or deployment, and no PR was opened.


### Browser invitation acceptance

- Invitation fragments now validate the configured region and scope identifiers,
  remove the secret from history, and retain it in document memory. Email entry
  asks for the invited mailbox without exposing private scope metadata.
- Focusing the invitation tab restores a session established by a magic link in
  another tab. Session reads have an ordering fence so a response started before
  a completed sign-in/sign-out cannot overwrite that later result.
- Explicit acceptance calls the identity-only sharing endpoint, then activates
  the exact workspace. Failure leaves the invitation available for retry or
  account switching. Accepted child links use the canonical child destination
  directly; Main is not opened as an intermediate scope.
- Five browser package tests pass. A real Chromium window with API fixture
  responses exercised unsigned entry, cross-tab sign-in restoration, explicit
  acceptance, refusal without workspace activation, successful retry, and direct
  child destination links. Desktop and mobile screenshots were inspected.
  Temporarily skipping the production acceptance handler made the visual flow
  fail; restoring it returned the flow to green. These are frontend integration
  checks; the fixture does not prove live invitation authority or delivery.
- Lint and full workspace typecheck pass. Shared collaboration rendering,
  automatic post-accept navigation, socket integration, the sharing management UI
  and the remaining authorization/lifecycle checklist are still unfinished.

### Shared API cookie mode and browser socket forwarding

- Extracted credential-free `ClientSession` presentation from the desktop token
  type. Added a browser metadata adapter and explicit cookie mode to the existing
  `RallyApi`, preserving its reads, scoped mutations, upload and validation paths.
  Cookie requests do not expose or refresh native bearer credentials.
- Browser ticket results now use same-origin regional socket URLs while retaining
  ticket subprotocols. The browser Worker forwards those upgrades directly through
  the configured service binding, strips cookie/bearer headers, and requires its
  exact browser Origin. It does not accept WebSockets or relay frames itself.
- Nine browser package tests pass, including a real workerd WebSocketPair behind
  the service binding. Dropping cookie stripping or Origin enforcement made the
  corresponding test fail; restored checks pass. These tests prove transport,
  not source-object guest admission or a mounted collaboration UI.
- Seventy-one shared API adapter tests pass, including cookie reads/mutations,
  upload headers, socket-ticket rewriting, and native refresh compatibility.
  A pending native renewal is fenced from restoring a signed-out session, while
  the provider may publish the exact renewed credential before returning it.
- Lint, full typecheck, docs and diff checks pass. Shared session context,
  conversation mounting, guest navigation, subscription selection and the
  remaining authorization/lifecycle items are still open. No PR was opened.


### Collaboration session context

- Conversation rendering, workstream/automation views, the Sidekick picker and
  favicon access now consume the small collaboration context instead of desktop
  account/onboarding controls. Desktop installs the context with its existing
  identity and API; browser sessions require no fake bearer or desktop bridge.
- Connector setup is an explicit host capability. A lite host omits setup cards
  and their provider-discovery query. Native pending OAuth reconciliation and
  external navigation use the supplied capability; existing connector chips and
  scoped tool execution are not changed by this presentation boundary.
- The ten-file compatibility run passed 240 tests, including conversation open,
  navigation, Sidekick controls, native sessions, connector cards and app gates.
  Ten focused context/connector tests pass, including two new cases for browser
  identity and absent setup. Native session probes additionally verify that both
  contexts receive the same session/API with setup enabled.
- The full desktop regression suite passed: 203 files and 2,973 tests. This
  verifies compatibility of the shared context with existing desktop surfaces;
  browser collaboration remains subject to its own end-to-end acceptance.
- Real Electron Chromium windows showed the production Slack setup card with the
  native capability and no setup CTA without it. Screenshots were inspected;
  this is a component embedding check, not full browser collaboration evidence.
- Shared UI mounting, guest workspace presence/navigation, subscription ownership
  and remaining authorization/lifecycle work remain unfinished. No PR was opened.

### Sidekick creation host capability

- The shared Sidekick picker no longer reaches directly into the desktop bridge.
  The native session host supplies its creation action; lite hosts omit it while
  retaining attachment of eligible existing Sidekicks.
- The context, native session and picker suites passed 85 tests. Real Chromium
  windows verified the native creation callback, the lite menu without creation,
  and the existing-Sidekick attachment dialog. This proves the host boundary,
  not guest library authorization or the unfinished browser conversation shell.
- Removing the production visibility guard made the visual check fail because
  the lite menu exposed creation; restoring it passed. The native session test
  also invokes the supplied action and verifies the existing bridge destination.

### Canonical browser conversation mounting

- Canonical workspace-addressed Main and child routes activate the exact workspace
  cookie session and mount the shared conversation screen, with scoped query and
  router providers and a workspace/sign-out toolbar. No setup route is mounted.
- Browser and Worker typechecking now use separate runtime globals. Shared styles
  reuse the desktop theme build; entry form selectors no longer style feed controls.
- A real Chromium window over the built browser Worker verified workspace activation,
  exact child feed admission and the visible connection-failure state, with no
  JavaScript exceptions. It does not prove successful feed bootstrap or mutations.
- That check exposed an unintended parent control subscription in the standalone
  hook. Standalone feeds now omit it; desktop pools retain ownership. Two regression
  cases cover Main/child selection and unmount closure. Guest directory, successful
  collaboration, session cleanup and the remaining authorization work stay open.
- Existing email and invitation visual flows still pass. The mounted browser
  toolbar signs out to the email entry. Browser host tests pass (9 cases), shared
  feed ownership tests pass (20 cases), and removing the standalone control-socket
  exclusion makes both new ownership cases fail; restoration passes.
- The full desktop regression suite passes all 2,976 tests across 203 files.

### Browser feed and attachment rendering

- A real Chromium window now exercises a valid child feed snapshot through the
  production browser WebSocket adapter, renders the shared composer, submits a
  message on that socket, accepts its private receipt and returns to entry on
  sign-out. The API and socket authority are fixtures; this does not establish
  server authorization, durable message persistence or model execution.
- The attachment policy check failed under the original CSP because authenticated
  attachment previews use local blob URLs. The host now allows image and media
  blobs while leaving script and frame policies unchanged.
- After the policy change, image loading and audio metadata decoding from local
  blobs pass in Chromium. Desktop and 390px mobile feed screenshots were inspected,
  including the admitted message and composer. All nine browser host tests, lint,
  typecheck and documentation checks pass.

### Conversation-scoped guest discovery

- Guests use the selected conversation's participant and connection payloads;
  member-only workspace inventory queries are disabled and their cached results
  are ignored. Member behavior remains unchanged. Guest mention resolution uses
  explicitly selected identities without a full workspace roster request.
- Chromium verified selecting a participant from the shared roster and sending
  the mention on the child socket, with no workspace member or connection
  inventory request. A cached hidden-member test covers the UI boundary.
- Workspace-level guest navigation still needs its scoped discovery projection;
  this change does not expose the existing member directory to guests.
- The API/conversation suites pass 118 tests. Removing each guest boundary makes
  its focused regression fail; restoring both passes. Browser build, lint,
  typecheck and documentation checks pass.

### Guest directory delivery foundation — 2026-09-17

- Grant mutation now schedules discovery delivery in the same local transaction.
  The parent alarm atomically transfers pending grant intents to the existing
  durable outbox; WorkstreamDO migration 15 admits the new effect and preserves
  pending/inflight deliveries.
- WorkspaceDO migration 60 adds a typed-only candidate index. Queue consumption
  validates address/hash and generation/version, keeps revocation tombstones,
  and queries by exact membership incarnation. Candidate IDs are not admission.
- Three workerd files passed 23 tests, including production mutation → real alarm
  → persisted outbox under refused Queue transport → actual consumer → candidate
  lookup. Receiver tests cover replay, stale revocation, incarnation replacement
  and generation changes. A populated migration test preserves queued rows.
- Deliberately dropping the source handoff failed the source test; bypassing the
  stale-delivery guard failed both ordering tests; dropping migration row copying
  failed the populated upgrade test. Each production change was restored.
- Repository lint, typecheck, documentation headings and whitespace checks passed.
  Canonical admission for directory results and browser navigation remain open;
  this backend foundation does not complete guest discovery or the overall feature.

### Canonical directory serving and lite navigation — 2026-09-17

- Added `/sharing/directory`: candidate lookup is followed by canonical parent
  reads, then a final relationship incarnation/revision check. Parent reads filter
  each conversation through current grant/lifecycle policy without another await
  before releasing labels. Child-only entries have no Main-derived parent title.
- Readable archived conversations remain listed under the existing policy;
  reserved/failed children and ungranted restricted siblings are omitted. Legacy
  imported grants without a current incarnation can be delivered but are never
  returned for an active relationship.
- Browser workspace roots now activate their workspace session and mount a
  collapsible shared-conversation sidebar. Router links switch the exact feed;
  focus/manual refresh reloads the directory. No member directory or extra
  workspace/control socket is opened, and no setup/onboarding flow was added.
- Three workerd files passed 26 tests and the browser host's nine tests passed.
  Deliberately bypassing canonical admission failed three authority tests;
  returning Main's title for child-only entries failed two. Restored production
  code passed. The service test retains a stale active candidate after canonical
  revocation and verifies the response immediately becomes empty.
- A real Electron Chromium window against the built browser Worker showed the
  workspace landing, scoped sidebar, child feed, composer and mobile expanded /
  collapsed navigation. Screenshots were inspected. The fixture also verified
  scoped mentions, no broad inventory requests and sign-out. Its API/socket
  responses are fixtures, not a real email-to-backend acceptance proof.
- Remaining directory work includes broader multi-workspace/lifecycle acceptance,
  notification-driven refresh and promotion behavior. Sharing-management UI,
  remaining participant writers, Sidekick management and full lifecycle integration
  remain open; no PR has been created.

### Email sharing interface and invitation management — 2026-09-17

- Added owner-authorized invitation-summary listing and authenticated `/sharing/list`
  routing. An invitation is visible only when the actor can share every included
  target; combined invitations cannot disclose other scopes after partial loss of
  authority. Credentials and delivery payloads remain private.
- Added the shared email panel to the browser conversation header and native
  participant dialog. It normalizes/deduplicates recipients, keeps operation IDs
  across unchanged retries, lists invitation status and revokes pending entries at
  their displayed revision. Main plus inheriting children is available when the
  owner reports workstream sharing authority, with restricted-child exclusions
  stated explicitly. Scope-independent invitations can be sent from each scope.
- Twelve real-workerd invitation tests and 48 focused renderer tests passed.
  Removing the all-target listing check failed its authorization test; replacing
  stable operation IDs on retry failed the API-backed panel test. Restored code
  passed. Lint, typecheck, documentation headings and whitespace checks passed.
- Real Electron Chromium against the browser Worker exercised invite failure,
  unchanged retry, exact child target, pending list and revocation, then ordinary
  scoped posting/sign-out. Desktop/mobile dialog screenshots were inspected.
  API/socket responses in this visible check are fixtures; no external email was
  sent, and native full-window acceptance remains open.
- Still incomplete: selecting several independent scopes in one UI operation,
  complete-workstream coverage including explicit restricted children, legacy
  first-share capability discovery for the whole-workstream option, accepted-grant
  management and broader end-to-end/lifecycle acceptance. The overall feature
  remains in progress and no PR was opened.

### Multiple scopes and complete workstream selection — 2026-09-17

- Added read-only sharing choices from the canonical parent. Legacy Main choices
  consult its real participant authority, legacy child choices consult the
  parent-owned private roster, and transferred scopes use current grants. Merely
  opening the choices performs no participant-authority handoff.
- The panel now selects multiple independent scopes. Complete workstream selection
  is available only when the parent and every ready restricted child are
  shareable. It creates a parent grant plus explicit restricted-child grants,
  avoiding independent Main/inherited-child grants that would outlive parent
  revocation. Future restricted children remain explicitly excluded.
- `completeWorkstream` is revalidated against the current child registry after
  external awaits and immediately before new invitation storage. A stale list
  returns `scope_changed`; an already committed invitation retains its receipt
  when later children appear.
- Fixed whole-workstream preparation to transfer existing inheriting children as
  well as Main. Creation/acceptance refuse incomplete inherited-child handoff.
  The real pipeline test provisions an inheriting child without an explicit
  private membership and verifies both authority transfer and inherited projection.
- Thirteen invitation workerd tests, five selected real Main/child pipeline cases,
  and 49 focused renderer tests passed. Removing inherited preparation failed its
  pipeline case; bypassing legacy participant admission failed four cases; dropping
  complete coverage validation failed the invitation case. Production code was
  restored and the affected files passed.
- Real Electron Chromium against the browser Worker exercised complete selection,
  stable retry, the exact parent/restricted target set, pending revocation and
  normal child collaboration. Desktop/mobile screenshots were inspected. Those
  visible checks use API/socket fixtures; they are not full backend acceptance.
- Still open: accepted-grant management, future-child initialization and other
  participant writers, Sidekick/context integration, multi-workspace lifecycle
  acceptance and rollout. No PR was opened; the full goal remains in progress.

### Accepted-share management — 2026-09-17

- Added exact-scope direct-grant listing and revocation routes. The owner admits
  management before reading grantee profiles, then repeats relationship and
  local authority checks after those awaits. Profile lookup is limited to that
  scope's grants; the workspace member directory is not exposed.
- The sharing panel shows direct shares in selected scopes and removes the exact
  grant at its displayed revision. Removal retains an operation identity across
  retries. Conflicts refresh for a new explicit action; success refetches current
  grants rather than interpreting an old receipt as current access. Other Main,
  child and parent shares remain intact.
- Fifteen real-workerd invitation/management tests and 50 focused renderer tests
  passed. HTTP tests cover exact child removal while Main remains available,
  actor override rejection, stale revision conflicts and replay after a re-share.
  A real D1 read is paused to prove suspension during profile lookup denies the
  result. Removing revalidation, widening the target query, and changing removal
  retry IDs each failed their intended test. Restored production code passed.
- Real Electron Chromium exercised accepted-share removal after a failed response,
  stable retry IDs/revision/target, pending-invitation operations, scoped posting
  and sign-out. Desktop/mobile dialogs and the fully scrolled mobile grant row
  were inspected. A fixture synchronization race in the subsequent posting check
  was fixed by awaiting the received socket message instead of an unrelated
  cleared textarea. These visible API/socket responses remain fixtures.
- Lint, typecheck, documentation headings and whitespace checks passed. Remaining
  work includes future-child/owner bootstrap and legacy writers, Sidekick/context
  and lifecycle integration, real multi-workspace acceptance and rollout. The
  feature remains in progress; no PR was opened.

### Future child publication under grant authority — 2026-09-17

- New child publication under a Main that has begun grant migration now records
  readiness, canonical initial participant import and durable child-handoff alarm
  in the same parent transaction. Foreground completion reuses the existing
  source prepare/commit and participant projection protocol. An interruption
  retains the pending transfer for alarm recovery rather than leaving a new
  child indefinitely on legacy participant authority.
- Real workerd creation tests cover an existing parent grant reaching a newly
  inheriting child, exclusion from a newly restricted child, source roster write
  fencing, confirmation replay, and recovery after a SQLite trigger rejects the
  handoff completion write. The inherited audience is set in the test registry;
  the current creation UI continues to create restricted children.
- All 21 tests in `substream-creation-runtime.test.ts` passed. Disabling the
  publication handoff made both new audience tests fail on the missing durable
  migration record; the production change was restored before the final run.
  Lint, typecheck, documentation headings and diff whitespace checks passed.
- New-owner bootstrap, remaining legacy participant writers, and end-to-end
  browser acceptance remain open. This is not full feature completion.

### Initial Main authority on standard workstream creation — 2026-09-17

- The standard workstream creation service now completes the durable Main
  participant handoff before activating the D1 route. Its existing initializer
  remains the source of the initial roster; the parent imports that roster into
  workstream grants and commits Main's legacy-write fence. Creation replay uses
  the original transfer and grant receipts.
- All six real-workerd conversation-creation tests and four Node audience tests
  passed. The new test checks the initial workstream grant, completed parent
  transfer, source projection mode, canonical writable access and unchanged
  transfer/grants on creation replay. Removing the creation-service handoff made
  that test fail on the missing migration record; restoring it passed again.
- System provisioning paths (including connector, digest and automation
  producers) still need review before new-owner bootstrap is considered complete.
  Browser acceptance and the remaining authorization work remain open.

### System-created workstream grant initialization — 2026-09-17

- Slack workspace creation and digest provisioning now call the shared
  `provisionWorkstreamWithGrants` helper. It reserves the canonical parent,
  provisions Main, and completes the durable participant handoff before the
  producer proceeds. Automation authoring and run conversations retain their
  separate automation parent rather than being mistaken for workstreams.
- Real workerd tests cover recipient-owned digest workstreams, ordinary
  system-created workstreams, and ownerless workspace-visible connector
  workstreams. Empty initial rosters create no fabricated user grants; ordinary
  member Main access still follows workspace visibility. Provisioning replay
  preserves the existing transfer token and grants.
- All nine conversation-creation tests and 77 focused Slack, origin-attachment
  and digest tests passed. Removing the helper's handoff made all three system
  creation tests fail; restoring it passed those tests. Node fixtures model the
  new parent RPC dependency; durable authority is proven in the workerd tests.
- Remaining participant writers, ownerless-workstream sharing management,
  Sidekick authorization, lifecycle refresh and browser end-to-end acceptance
  remain open. The full feature is not yet complete.

### Connector audience admission after grant handoff — 2026-09-17

- `admitConnectorAudience` now sends the stable incoming event identity and
  resolved audience to WorkstreamDO. Migrated Main scopes use exact Main grants;
  unmigrated scopes retain the existing identity writer. Existing inherited
  access stays inherited, and guests acquire no new scope through connector
  identity mapping.
- WorkstreamDO migration 16 adds an immutable admission-batch receipt. The
  canonical audience and grant mutations commit together. A replay cannot
  restore a removed grant or grant a formerly skipped guest after promotion.
  A new connector event can re-admit an ordinary member, preserving the source
  conversation's existing arrival semantics. Changed audiences under the same
  event identity are rejected. Durable roster projections publish membership.
- All 11 real-workerd creation/admission tests and 47 focused connector tests
  passed. Tests use the actual Worker-side admission service, parent, Main and
  D1 relationship rows. Forcing the legacy writer after handoff failed both
  admission tests at the source write fence; removing the guest guard failed
  the guest-access assertion. Both negative controls were restored. Lint,
  typecheck, documentation headings and diff whitespace checks passed.
- Slack creator adoption still calls the legacy identity mutation and needs
  separate treatment. Automation viewer seating belongs to its own parent and
  must not be redirected to workstream grants. Full browser acceptance and
  the other unchecked requirements remain open.

### Connector creator attribution after participant handoff — 2026-09-17

- `adoptCreator` now reports whether the source still owns participants. After
  transfer it changes creator attribution only: it cannot seat, re-admit or
  reclassify participants behind the parent grant authority. Unmigrated sources
  retain their existing atomic creator/participant behavior.
- Slack session assignment uses shared connector creator reconciliation. After
  attribution, migrated workstreams request exact Main admission with a stable
  session/user receipt. Creator identity does not itself grant a guest access,
  and replay does not restore a removed grant. Correcting attribution leaves
  the previous user's grants intact.
- All 13 workerd creation/admission tests and 50 focused connector tests passed.
  Both member and guest cases inject failure at the admission-receipt write,
  verify attribution committed without a source roster write, then retry through
  the parent authority. Re-enabling the legacy source writer made both cases fail
  at the transferred-authority SQL fence; restoring it passed. Lint, typecheck,
  documentation headings and diff whitespace checks passed.
- The remaining work includes ownerless-workstream sharing management, guest
  Sidekick management/history, context and source audience enforcement, lifecycle
  refresh, and browser end-to-end acceptance. The goal remains incomplete.

### Lite sidebar identity and focus revalidation — 2026-09-17

- Added workspace name and the existing themed initial badge to the collapsible
  shared-navigation header. The current workspace model has no configurable icon
  or color fields; this reuses existing presentation without introducing setup.
- Root-session refresh now reselects the workspace even for the same user,
  updating relationship metadata after promotion and unmounting collaboration on
  an authorization denial. Routine revalidation keeps the feed mounted so an
  unsent draft survives. Transient failures show an error without discarding it.
- Real Electron Chromium windows at desktop and mobile sizes verified the badge,
  child-only directory navigation, feed submission and sign-out. An extended
  browser fixture verified same-user focus revalidation, draft preservation and
  removal of the composer when workspace selection returns 403. API responses
  and socket authority were fixtures; this does not prove backend revocation or
  immediate cross-tab notification.
- Negative control restored the former user-ID-only effect dependency: the
  browser check failed at “Focus must revalidate the same user workspace.” The
  production fix was restored, rebuilt, and the browser check passed. Lint,
  typecheck, documentation headings and diff whitespace checks passed.
- Immediate lifecycle delivery, renewal scheduling and real-backend end-to-end
  acceptance remain open. The feature is not complete and no PR was opened.

### Browser cross-tab session invalidation — 2026-09-17

- Successful email redemption and sign-out now notify other same-origin tabs
  through a regional BroadcastChannel. Messages carry only an invalidation;
  recipients re-read authoritative session and workspace metadata. No identity,
  credentials or invitation proofs are shared. Focus remains the fallback when
  BroadcastChannel is unavailable.
- Magic-link entry retains its explicit redemption step while installing the
  same listener, so signing in from that page updates an already-open workspace
  tab without requiring a focus change.
- Added a renderer regression test using the real Node BroadcastChannel and
  fixture HTTP responses. It covers promotion of the same user, draft retention,
  workspace denial, logout and subsequent sign-in. Disabling the production
  channel listener made it fail at the expected member-state assertion; restoring
  the listener passed.
- Two real Electron Chromium windows verified logout and explicit magic-link
  sign-in propagate without focus-driven restoration. HTTP authority was a
  fixture; this is client lifecycle evidence, not backend end-to-end acceptance.
- Lint and typecheck passed. Automatic renewal and the remaining feature-wide
  acceptance audit remain open. No PR was opened.

### Browser session renewal — 2026-09-17

- Wired the existing server renewal endpoint into foreground session lifecycle.
  A visible tab renews halfway through its remaining issued lifetime; focus,
  visibility and online events also renew. The server's existing inactivity
  window and absolute ceiling remain authoritative. An unchanged expiry does
  not rearm its timer, preventing a renewal loop at the ceiling.
- Expiry triggers authoritative restoration rather than trusting local-clock
  logout. Another tab may have renewed, or the device clock may differ. HTTP
  denial clears the session; network failures remain visible and recover on
  foreground/online activity. Existing request generations fence late responses.
- Added a deadline helper that splits waits at the published signed-32-bit
  browser timer boundary, because an ordinary 30-day session exceeds one timer.
  This is a platform representation bound, not a new session policy.
- Five renderer tests passed, covering cross-tab/promotion behavior, renewal,
  unchanged ceiling, late renewal after logout and long deadlines. Removing the
  renewal call failed the renewal cases; removing the response-generation fence
  made the late-response test incorrectly restore signed-in UI. Both production
  changes were restored and all five tests passed again.
- The real two-window sign-in/sign-out check passed with renewal enabled. Its
  HTTP authority remains a fixture. Lint, typecheck, browser build, documentation
  and whitespace checks passed. Real-backend end-to-end acceptance and other
  open requirements still prevent feature completion; no PR was opened.

### Lite participant and resource controls — 2026-09-17

- Added participant and resource controls to the browser conversation header.
  Participants use the existing exact-conversation dialog; resources use the
  existing authenticated lightbox. The shared surface exposes a resource opener
  bound to the selected conversation, while its desktop parent sidebar retains
  a parent-bound opener. No Main inventory is loaded for a child-only view.
- Browser header rows size to their content so controls wrap on narrow screens.
  Real Electron Chromium screenshots verified participant rendering, resource
  contents and the mobile header. HTTP/socket authority was a fixture.
- A negative control bound the header to the parent-resource opener and the
  child-resource content check failed. The production callback was restored.
  The extended visual check then exposed an assertion race: composer clearing
  preceded delivery of the frame to the socket fixture. The harness now awaits
  that actual frame before asserting its mentions; this was a smoke-harness
  synchronization defect, not evidence of a missing production mutation.
- The existing conversation-opening and resource-inspector suites passed: 105
  tests. Full repository tests were started in `/tmp/guest-full-test.log` after
  the harness correction; their outcome is not yet recorded here. Other open
  acceptance requirements still prevent completion. No PR was opened.

Full-suite follow-up for the lite controls:

- The corrected real-window scenario passed three consecutive runs after waiting
  for actual socket frame arrival. The parent-opener negative control failed at
  child-resource content visibility, and the restored callback passed.
- `pnpm test` completed with all 2,987 desktop tests passing. API Node results
  were 3,050 passing and five failing; its workerd stage did not run because the
  Node command failed. Other package test commands passed.
- Fixed the scoped-memory compatibility fixture by applying the real guest
  membership migration to its historical regional membership table; all 18
  scoped-memory tests then passed. Classified `scope_grant_directory` as owned
  exclusively by typed RPCs in routing coverage; all nine routing tests passed.
- Three API Node failures remain to investigate: automation-creator resource
  catalog discovery, resource-slug listing authorization, and unauthenticated
  substream message-length validation. Full-suite validation remains incomplete.

### API regression fixes and exact-conversation recommendation reads — 2026-09-17

- Fixed the remaining three API Node failures from the first full run. Resource
  slug and automation-catalog fixtures now include the member access class used
  by authorization. Substream confirmation's length-only guard again precedes
  session processing, preserving the actionable oversized-message response;
  accepted bodies still pass workspace authentication. The three files passed
  together: 30 tests. The earlier scoped-memory and routing fixes also passed.
- Found and fixed a separate client integration gap: recommendation reads used
  the member/Main endpoint even while viewing a child. The API client now uses
  the exact-conversation endpoint, and query keys include substream identity.
  Recommendation mutation responses populate only Main's key; older reads are
  cancelled and all conversation-specific answers are invalidated for refetch.
- 84 scoped client tests passed. A new route-switch test verifies child-specific
  source metadata replaces Main's metadata. Omitting the substream argument made
  that test fail at the child recommendation; the production call was restored
  and the complete five-test Sidekick screen file passed. Lint, typecheck,
  documentation and whitespace checks passed.
- The second full repository run is still active in `/tmp/guest-full-test-fixed.log`
  (terminal session 57315 at this checkpoint). Its desktop stage passed 2,987
  tests before the subsequent recommendation-client edits; the targeted 84-test
  run covers those edits separately. Do not claim the API/workerd full run passed
  until its terminal result is inspected. Browser Sidekick presentation and
  management/source-history integration remain open, along with the broader
  acceptance checklist. No PR was opened.

### Lite Sidekick menu and full-suite runtime follow-up

The lite header now shows exact-conversation Sidekick recommendations and loaded
attachments. Removing a local attachment leaves the shared recommendation in the
menu. The fixture-backed real-browser smoke passed this interaction along with
participants, authenticated resource rendering, native WebSocket composer
admission, focus revalidation and sign-out. The desktop and mobile screenshots
were inspected. This proves client interaction, not end-to-end email delivery or
production authorization. Scoped recommendation renderer tests and API URL tests
also pass; authoring and setup remain outside the lite client.

The full repository run reached all API workerd tests: 1,005 passed and 15 failed.
The failures exposed stale runtime fixture membership/session columns, migration
version assertions, a changed creator-adoption result, duplicate recommendation
refresh publication, and demo uploads bypassing draft admission. The four scoped
runtime suites for connector routes, parent contracts, identity, and migration
retirement now pass all 56 tests. Demo preparation/readiness passed after routing
uploads through ordinary attachment-message admission. The seeder's four tests
also pass with attachment-only transcript turns and replay of a lost upload
receipt. A fresh full-suite result is still required; the earlier full run is
not green.

The seeder negative control removed the resource ID from message admission while
still sending a turn; the real workerd test failed because the workstream had no
document. Restoring the attachment restored all four seeder tests. Repository
lint, typecheck, and diff whitespace checks passed after the final edits. A new
full repository run is recorded in `/tmp/guest-full-test-runtime-fixed.log`; do
not treat a started run as completed validation.


### Parent recommendation authority — 2026-09-17

WorkstreamDO now owns an explicit management-access read. Recommendation writes
recheck it at the canonical parent: migrated Main participation does not stand in
for a parent grant, while pre-transfer ordinary members retain their existing
participant rule. Conversation-addressed mutation routes admit guests through
workspace relationship authentication and return only the addressed conversation's
source summaries. Guest managers can reuse already recommended or loaded sources;
a raw unrelated workspace Sidekick ID cannot create its own discovery permission.

The direct grant test proves Main-only denial, parent-grant admission, and refusal
after parent revocation while Main access remains. The real workerd guest HTTP
case proves child-only denial, parent-granted PUT/DELETE, unrelated-source denial,
and revoked-parent denial. Both focused cases passed. The existing 20 parent
contract tests passed, and 80 renderer API/picker tests passed. These changes do
not yet supply the parent-management browser controls or finish authoring/history.

The concurrently running full suite compiled an intermediate management RPC
before its strict-input fix; its result cannot establish the final source state.
A full run after the final restoration is required. This is a known intermediate
source failure, not a test that was rerun without explaining its cause.

Parent-management verification follow-up: the canonical authority negative control
bypassed the parent grant check; the Main-only guest test failed because the write
succeeded. A separate service negative control bypassed the guest source set; the
real guest HTTP test failed because an unrelated workspace source returned 200
instead of 403. Both production checks were restored. The runtime authority,
creation, substream creation and automation suites passed 74 tests; two focused
HTTP/agent cases then passed with the final source checks. The agent case now also
checks successful tool receipts, so a mutation followed by a failed result read
cannot masquerade as a successful tool call.

The full-suite failures in creation were duplicate `revision` fixture columns:
`seedWorkspaceControlPlane` now owns that field, and its consumers no longer add
it again. These cases passed after the fixture correction. The other full-run
failures were the intermediate strict-RPC-input errors addressed above. No full
suite result for a stable final source snapshot has been claimed yet.

The delegated-agent result-read negative control returned through its hidden
substream; the tool receipt assertion failed with `conversation_not_found` even
though the recommendation had changed. Restoring the visible Main result scope
for host-authorized background execution restored the test. Normal human requests
retain their selected child result scope. Final lint, typecheck and whitespace
checks passed. The next full run uses `/tmp/guest-full-test-management-stable.log`;
keep production sources unchanged until its process reaches a terminal result.

### Browser session continuity across shares and promotion

The scope-invitation workerd suite now combines two workstream owners with an
ordinary browser identity/session: accept the second child share through the
cookie adapter, promote the guest through guarded D1, and select the workspace
again through the browser route. The same user and workspace session survive;
both child grants remain writable, and neither private Main becomes readable.
A deliberate incarnation rotation during promotion fails this case at session
authentication. The case now starts through the browser email-code routes,
reads the synthetic encrypted outbox, verifies wrong-code and replay handling,
and accepts both invitations using the resulting HttpOnly cookie. It does not
claim delivery to a real mailbox or a rendered live-backend browser journey.
