# Projects implementation plan

This plan implements the adjacent [PRD](prd.md) in behavior-backed vertical
slices. Every scenario is written as an automated test before its production
behavior, run once while red, and broken deliberately after it is green to prove
the assertion observes the named behavior. A phase is complete only when its
authorization, retry, cancellation, stale-generation, offline, and accessibility
cases pass alongside its happy path.

The implementation keeps `WorkspaceDO` as the only project authority. Regional
Queues carry identifiers rather than authority, `WorkstreamDO` owns audience
effects, and `SubstreamAgent` owns resource links and the first-run gate. The
desktop consumes versioned WorkspaceDO projections and sends mutations over the
existing authenticated REST path.

## Working rules

- Before each phase, read the owner documents named by that phase. Read
  [`testing.md`](../../testing.md) before adding tests and
  [`durable-object-sqlite.md`](../../durable-object-sqlite.md) before editing
  object SQL.
- Express behavior in Given/When/Then terms in test names and fixture setup.
  Tests live at the highest runnable boundary: real workerd for Durable Object,
  alarm, Queue, and RPC behavior; real migrated/object SQLite for query and
  constraint behavior; renderer tests for DOM interaction; a real Electron
  window for visible acceptance.
- For every new or materially changed test, make one temporary production-code
  break, capture the focused failing run, verify that it fails for the scenario's
  stated reason, then restore the code. Test-only breakage does not count.
- Capture non-trivial command output in `/tmp`. Every semantic commit leaves
  `pnpm lint`, `pnpm typecheck`, and `pnpm test` green. Queue/configuration phases
  also run both Wrangler dry runs; visible phases run the real-window procedure
  from [`dev-environment.md`](../../dev-environment.md).
- Mark [`state.md`](state.md) `in progress` in the first implementation commit,
  not in this plan-only commit. Mark it `completed` only after every phase,
  documentation update, full gate, and visible acceptance passes.
- Create and register `docs/projects.md` in Phase 0. Keep its current-behavior
  body and newest-first changelog synchronized in every later phase. Update
  existing owner documents in the same commit that changes their behavior.
- Keep scope, audience, membership, default, lifecycle, application, publication,
  and effect generations distinct. An operation captures only the rows and
  generations whose change should invalidate it.
- Leave every defensive count, timeout, retry, and lease duration unset until it
  is derived from an existing product contract or a published Cloudflare limit
  and approved by the team. The schema and loop structure remain bounded-ready
  without inventing a number.

## Phase 0 — Establish project contracts and WorkspaceDO authority

Create the smallest authoritative project that can be created, read, edited,
authorized, and ordered. This locks vocabulary and storage before other objects
or Queues depend on it.

### Behavior first

- **Scenario: a personal project is visible only to its active participants.**
  Given two active workspace members and a personal project created by one,
  when both request the project directory, then only the creator receives it.
- **Scenario: a workspace project is visible to every active workspace member.**
  Given the same members and a workspace project, when both read, then both
  receive the project but inactive workspace members do not.
- **Scenario: presentation input is closed and stable.** Given an unknown icon,
  custom color, blank name, or case-insensitive duplicate, when project creation
  is attempted, then the strict contract rejects it with the documented stable
  error; all 25 Lucide keys and 12 color keys succeed.
- **Scenario: project order belongs to the viewer.** Given two viewers with the
  same projects, when one reorders them, then their next page and another device
  use the new order while the other viewer's order is unchanged.
- **Scenario: presentation edits do not stale unrelated work.** Given a captured
  lifecycle/audience generation and an in-flight placeholder operation, when the
  name, icon, or color changes, then only `presentation_revision` advances.

### Implementation

- Add strict project IDs, icon/color registries, project summaries, mutation
  arguments, stable errors, and socket projection shapes to
  `@rally/contracts`. Generate UI choices from the shared registries rather than
  maintaining a second list.
- Add the Phase 0 project, participant, and per-viewer order tables to the
  WorkspaceDO SQL migration ledger, including normalized-name uniqueness in all
  lifecycle states and the distinct presentation, audience, and lifecycle
  generations.
- Add a focused project repository/protocol beside `workspace-do.ts`; expose
  typed WorkspaceDO RPC methods for create, read, edit, list, and reorder while
  keeping transactions inside the object.
- Add authenticated REST mutations and the versioned project directory to the
  WorkspaceDO subscribe snapshot. Apply the same workspace-role and active
  participant checks on reads and writes.
- Create `docs/projects.md`, register it in `docs/README.md`, update
  `docs/data-model.md`, `docs/workstream-durable-object.md`, and
  `docs/regionalization.md`, and mark `state.md` in progress.

### Gate

- Contract, real object-SQL, real workerd RPC, authorization, normalization,
  pagination, and independent-order scenarios pass.
- Reset/eviction proves project and order rows are durable, and a deliberately
  broken authorization predicate makes the personal-project scenario fail.
- No D1 product table or cross-object SQL path is introduced.

## Phase 1 — Ship project creation and the sidebar shell

Make the Phase 0 authority useful from the desktop before adding work-stream
membership.

### Behavior first

- **Scenario: a person creates a project from an empty sidebar.** Given no active
  projects, when they choose **New project**, select one icon and swatch, choose
  scope, and submit a name, then the new row appears below **Actions** and above
  **Pinned** in server order.
- **Scenario: row controls do one job each.** Given an active project row, when
  the triangle, middle link, and plus control are activated separately, then
  they respectively toggle the accordion, open the project space, and open
  **New project work stream** without triggering either neighbor.
- **Scenario: reordering survives failure and restart.** Given three projects,
  when drag or Alt+Arrow reorder succeeds, then restart preserves it; when the
  write fails, then the row returns to the last server order and an actionable
  error appears.
- **Scenario: colors and icons remain accessible.** Given mouse, keyboard, or
  screen-reader navigation, when the picker is traversed, then all choices have
  names, swatch names appear visually only on hover/focus, and selection is not
  communicated by color alone.

### Implementation

- Add project queries/mutations to the desktop API client and cache, including
  stale-data retention and server-version reconciliation.
- Add the always-present Projects sidebar section, independently focusable row
  controls, accordion state keyed by project ID, drag/keyboard ordering, privacy
  marker, loading/empty/stale/error/offline states, and project create/edit UI.
- Add project routes and a project-space shell with empty work-stream and
  default-resource sections. Wire the plus button to the project-specific route
  but leave submission gated until Phase 4.
- Add all `sys.color.project.*` tokens to every theme and use Lucide icons only
  through the shared registry; use Tabler `IconTriangle` and `IconPlus` for the
  row controls.
- Update `docs/theming.md`, `docs/workstream-pinning.md`, and the Projects module
  document and changelog.

### Gate

- Renderer interaction and accessibility scenarios pass for empty, populated,
  loading, stale, failed, and offline states.
- A real Electron window shows the section in the correct location, a complete
  picker, independent row controls, drag ordering, and both light and dark theme
  contrast.

## Phase 2 — Admit, move, and remove work streams safely

Build the staged membership protocol and audience containment before defaults
or project-start depend on membership.

### Behavior first

- **Scenario: joining enlarges audience before membership appears.** Given a
  readable personal work stream and a personal project with additional
  participants, when it is added, then every participant is seated before the
  `joining` row becomes visible and a resource phase could begin.
- **Scenario: an incompatible move detaches its source first.** Given a work
  stream in a personal source and a workspace destination, when destination
  audience setup begins, then the source late-effect barrier removes the source
  membership before workspace scope commits; cancellation leaves it safely
  unassigned.
- **Scenario: a compatible move swaps atomically.** Given compatible source and
  destination audiences, when every target settles, then one transaction makes
  the destination active and removes the source; before that, only the source is
  visible.
- **Scenario: cancellation retains monotonic effects.** Given a failed staged
  admission with an applied participant or scope effect, when it is cancelled,
  then live leases settle, the joining row disappears, applied audience remains,
  and no invalid personal-project membership remains.
- **Scenario: direct audience mutation cannot bypass a project.** Given an
  active/joining/restoring membership, when one work stream is narrowed or a
  project participant is removed directly, then WorkspaceDO reserves and rejects
  the unsafe command; an inert archived membership does not block it.

### Implementation

- Add membership rows, per-row generations, durable admission operations,
  audience targets, direct-member mutation reservations, and idempotent local
  effect receipts.
- Add typed WorkspaceDO claim/settle/cancel operations and WorkstreamDO audience
  effects. Hold no assumption across an external `await`: claims use leases and
  every settlement rereads current authority.
- Add regional project-audience Queue producers/consumers, publication rows,
  ambiguity recovery, DLQ failure consumers, passive terminal DLQs, and
  WorkspaceDO alarm reconciliation.
- Add drag/drop and **Add to project** menus, safe-move confirmation, progress,
  retry, cancel, and **Remove from project**. Keep pinning independent.
- Update `docs/security.md`, `docs/access-revocation.md`,
  `docs/durable-object-alarms.md`, `docs/choosing-queues-or-rpc.md`, both regional
  Wrangler configs, and the Projects document.

### Gate

- Real workerd scenarios cover Queue duplication/out-of-order delivery, object
  eviction, lease expiry, stale generations, concurrent independent admissions,
  unsafe direct mutations, early source detachment, retry, and cancellation.
- Renderer and real-window checks cover drag and menu parity plus all visible
  progress/failure states.

## Phase 3 — Propagate default resources through the Queue

Attach shared resources only after membership audience is safe, with durable
fan-out and deduplication.

### Behavior first

- **Scenario: a new default reaches every current member once.** Given several
  project work streams and one already-linked resource, when an audience-safe
  default is added, then the Queue produces one current application per pair and
  every work stream ends with one canonical link.
- **Scenario: a default must cover the whole project audience.** Given a private
  note unreadable by another project participant, when it is selected or the
  project audience later expands, then Rally rejects the operation with
  `project_resource_audience_mismatch` before any inaccessible default applies.
- **Scenario: an ambiguous send remains live long enough.** Given a send that
  may be accepted after publisher-lease expiry, when reconciliation runs, then
  the publication remains nonterminal until confirmed `accepted_at` or the
  conservative `latest_acceptance_at` plus Queue retention has passed.
- **Scenario: removal stops future effects without undoing history.** Given an
  applying resource claim, when the default or membership is removed, then new
  claims stop, live claims settle or expire, and any existing resource link
  remains.

### Implementation

- Add default rows with per-row generations, resource applications with
  per-tuple generations, physical publication attempts, and effect receipts.
- Add the regional resource Queue, failure consumer, terminal DLQ signal, alarm
  reconciliation, retry, cancellation, and bulk progress reads. Derive Queue
  terminality from actual or latest possible acceptance, never publisher-lease
  expiry.
- Add typed SubstreamAgent resource-link effects and canonical deduplication.
  Reauthorize project, membership, default, audience, and resource visibility
  immediately before the local transaction.
- Add project-space default-resource controls and progress/error disclosure that
  names only work streams the reader may see.
- Update `docs/data-model.md`, `docs/workstream-durable-object.md`,
  `docs/durable-object-alarms.md`, `docs/security.md`, and the Projects document.

### Gate

- Real Queue/workerd scenarios prove duplicate, reordered, ambiguous, exhausted,
  replayed, cancelled, and alarm-only recovery paths, including eviction at
  every cross-object boundary.
- UI and real-window acceptance show add, progress, retry, remove, deduplication,
  and inaccessible-resource refusal.

## Phase 4 — Start a work stream from a project before its first turn

Reuse ordinary work-stream creation while adding a persisted setup gate for
audience and defaults.

### Behavior first

- **Scenario: project setup precedes the first turn.** Given a project with
  participants and defaults, when a work stream is started from its plus button,
  then audience and every default receipt settle before Workflow dispatch, D1
  route activation, email activation, or agent execution.
- **Scenario: setup survives the caller.** Given the create request and desktop
  disappear after admission, when Queue/alarm work completes, then finalization
  dispatches exactly once and the persisted **Preparing work stream…** row
  becomes active.
- **Scenario: cancel creation never activates the draft.** Given failed setup or
  an in-flight claim, when cancellation is requested, then new claims stop, live
  claims settle, regional draft state is abandoned, the Global email tombstone
  remains, and no first turn starts.
- **Scenario: participant revocation preempts setup.** Given a gated draft and a
  participant removal, when revocation starts, then setup pauses, removes that
  person from the draft, regenerates superseded resource applications, and only
  then resumes.

### Implementation

- Add `project_workstream_starts`, the draft membership generation, setup target
  gate, and SubstreamAgent `awaiting_project_setup` state beside the scheduled
  run.
- Extend the existing creation finalizer so the project gate is another explicit
  prerequisite rather than a second creation path. Preserve Workflow,
  directory-publication, D1-route, notification, and email fences.
- Build **New project work stream** from the ordinary composer while fixing its
  project and omitting **Needs attention** and **Suggested work**. Persist and
  restore the Preparing row with retry and cancellation.
- Update `docs/workstream-creation.md`, `docs/workstream-email-addresses.md`,
  `docs/workstream-durable-object.md`, and the Projects document.

### Gate

- Workerd creation tests prove no early turn or route, exactly-once finalization,
  restart/eviction recovery, revocation preemption, retry, and cancellation.
- Real-window acceptance starts one personal and one workspace project work
  stream and inspects the Preparing, failure, cancellation, and active states.

## Phase 5 — Add participant, scope, archive, and restore lifecycles

Finish the long-running project operations and their recovery surfaces.

### Behavior first

- **Scenario: participant and scope expansion activate only after convergence.**
  Given current members, when adding a participant or widening scope, then the
  project audience remains unchanged until all retained targets settle.
- **Scenario: cancelling partial expansion restores containment.** Given some
  audience targets applied and one failed, when cancellation runs, then applied
  member work streams detach through their barriers before the adding participant
  or pending scope is cleared.
- **Scenario: access revocation wins.** Given any nonterminal start, admission,
  default, or audience operation, when an authorized participant removal begins,
  then project read access ends immediately and the other operation is paused,
  rebased, and resumed without delaying revocation.
- **Scenario: archive is a late-effect barrier.** Given live project claims,
  when archive starts, then the project disappears from active navigation and
  becomes archived only after no project effect can still commit.
- **Scenario: restore never creates a hidden conflict.** Given an archived
  membership whose work stream joined another active project or changed
  audience, when restore preflight runs, then it remains archived and returns
  only authorized conflict details; successful restore reserves memberships and
  replays current defaults with fresh generations.
- **Scenario: an archived participant may leave.** Given an archived personal
  project with two readers, when one leaves, then only their project access is
  removed and former work-stream audiences remain; the last reader cannot leave.

### Implementation

- Complete audience-operation roots/targets, cancellation detachment, removal
  preemption, scope transitions, final-reader enforcement, and default-audience
  preflight.
- Add archive/restore operation tables, membership reservations, late-effect
  barriers, conflict-safe activation, retry/cancel, and per-viewer order append.
- Add the inactive-project recovery picker only to the **New project** dialog
  footer; keep inactive projects out of sidebar and project menus. Add archived,
  archiving, restoring, and cancelling project-space states.
- Update `docs/security.md`, `docs/access-revocation.md`,
  `docs/durable-object-alarms.md`, `docs/data-model.md`, and the Projects
  document.

### Gate

- Real workerd interleaving tests cover every operation pair that shares a
  project/work-stream reservation, including crash, late settlement, stale
  generation, retry, and cancellation.
- Renderer and real-window acceptance cover authorized/denied participant
  actions, scope change, archive discovery, restore conflicts, retry, cancel,
  and inactive-project self-removal.

## Phase 6 — Complete project presentation and integrated acceptance

Finish plural-ready project projections and validate the complete product in a
real window.

### Behavior first

- **Scenario: expanded children follow activity, not project order.** Given
  several projects and member work streams, when realtime activity changes, then
  only children reorder by `lastActivityAt DESC, workstreamId`; project headers
  retain viewer order and accordion state.
- **Scenario: Needs attention shows projects without changing attention.** Given
  an otherwise eligible row with zero, one, or several authorized active project
  memberships, when it renders, then it shows no gap, one icon, or an ordered
  icon pile left of the name while preserving the existing marker and eligibility.
- **Scenario: inaccessible memberships never leak.** Given a multi-project read
  containing an unreadable personal project, when sidebar, project space,
  submenu, and Needs attention projections are built, then no ID, name, icon,
  count, or conflict detail from that project reaches the viewer.
- **Scenario: offline state never claims a mutation succeeded.** Given cached
  projects and no server connection, when the person navigates, then known rows
  remain readable while create/edit/membership/default/lifecycle controls are
  disabled with an explanation.

### Implementation

- Complete accordion child reads, activity reordering, project-space table,
  project icon piles, plural-ready contracts, accessible descriptions, and
  authorized project submenus.
- Add stale/error/offline reconciliation across sidebar, Needs attention,
  project space, and setup operations without optimistic acknowledgement of an
  uncommitted authority write.
- Add the Projects scenarios to `docs/e2e.md`; finish `docs/projects.md` and all
  owner-document changelogs; audit the PRD decision log; mark `state.md`
  completed only after the full gate and visible checks pass.

### Gate

- All focused suites pass and every new/changed test has a recorded red and
  deliberate-break proof.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, desktop
  release tests, both Wrangler dry runs, and `pnpm smoke:local` pass with full
  output captured.
- A real Electron session verifies create/edit/reorder, accordion behavior,
  pin coexistence, drag/menu admission, default resources, project start,
  participant/scope changes, archive/restore, Needs attention icon piles,
  keyboard use, offline behavior, and both themes. Screenshots are inspected,
  not merely captured.

## Cross-cutting acceptance

- **Authorization:** IDs and Queue messages never grant authority. Every read,
  mutation, target claim, effect, retry, conflict response, and projection
  reloads current workspace, project, work-stream, participant, membership,
  lifecycle, and resource authority as applicable.
- **Concurrency:** external awaits may interleave. WorkspaceDO claims and local
  effect receipts use leases, generations, idempotency keys, and final authority
  rereads; unrelated work-stream membership generations do not stale each other.
- **Regionalization:** project product state stays in the workspace's regional
  object. configured deployments use separate Queue/DLQ sets and carry only opaque IDs and
  bounded routing metadata.
- **No prompt change:** no project name, instruction, memory, or resource list is
  added to the system prompt or compaction checkpoint. Resources affect a work
  stream only through its ordinary resource links.
- **Operations:** a non-empty terminal DLQ is visible, every failed operation is
  resumable or safely cancellable, and WorkspaceDO alarm reconciliation remains
  sufficient after Queue copies expire.
