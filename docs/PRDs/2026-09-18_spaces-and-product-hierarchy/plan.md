# Spaces and the Organization hierarchy: build plan

> Companion to [the PRD](prd.md). Phases in build order, each with the gate that
> lets the next one start. Migration numbers were rechecked against `main` on
> 2026-09-19: WorkspaceDO is at 60, WorkstreamDO at 17, the Durable Object
> class migration at `v10`, and the shared conversation-object schema at 65
> (the PRD anticipated 62), so the Space parent kind lands as version 66.

## Architecture as built

- **`SpaceDO` is `WorkstreamDO` under a role.** `WorkstreamDO` gains an
  immutable `ConversationParentRole` (`workstream` or `space`) fixed in its
  constructor: the namespace and name it registers itself against, its migration
  component (`space_do`) and ledger, whether it admits client sockets, whether it
  publishes grant-directory and feed effects, and whether it wakes its main
  conversation eagerly. `SpaceDO` supplies the space role and overrides nothing.
  The Space's hidden main conversation is a `SubstreamAgent` whose root row
  carries the closed parent kind `space`; it holds the Space's participants and
  resources exactly as a Channel's does, never admits a feed socket, and never
  starts an agent loop.
- **WorkspaceDO owns the relationship.** New tables hold the Space directory
  projection (fed by the same `directory_common` and `directory_user` effects a
  Channel publishes, routed by parent kind), per-person Space order, the General
  identity, many-to-many Space and Channel memberships with staged generations,
  the default registry and its generation-fenced delivery targets, fenced
  membership intents, and the resumable bootstrap state.
- **Space-derived access is provenance in WorkstreamDO.** WorkstreamDO records
  which Space sources currently reach a Channel and which readers each supplied.
  The one pure effective-audience function derives the Channel's readers from
  its direct source plus its active Space sources, and every change is applied
  through the Channel's existing canonical audience operations (scope update,
  participant add and remove on the main conversation), so the retained-content
  containment preflight and its SQL triggers stay the only fence. Grant rows
  written for a Space source are marked as such and never reach the shared
  scope-grant directory.
- **General is a fallback with a protected identity.** Every Organization has
  one Space with `system_role = 'general'`; creation without a named Space
  establishes membership there. Its archive and personal-audience transitions
  are refused at the WorkspaceDO authority.
- **The cutover is a WorkspaceDO-driven, receipted job.** Migration 61 seeds a
  pending bootstrap row; the alarm claims pages of work, publishes them on the
  activity Queue, and the consumer creates General, places every active and
  archived Channel, and makes formerly personal Channels Organization-wide only
  after the containment preflight passes. Blocked Channels are recorded per
  Organization and reported; nothing partial is published to a client.

## Phases

### Phase 1: contracts, roles, and `SpaceDO`

- `packages/contracts/src/spaces.ts`: Space ids, scope, status, system role,
  summary, directory, snapshot, request shapes, membership and access-source
  shapes, and the closed error codes.
- `ConversationParentKindSchema` admits `space`; every exhaustive branch is
  audited; `workspace-retirement.ts` follows.
- WorkstreamDO role configuration; `SpaceDO`; registration in the Worker entry,
  env contract, names, self-RPC, forced-migration dispatch, tracker classes,
  retirement gate and graph, access-revocation walk, ESLint binding set,
  Wrangler bindings and class migration `v11`.
- Conversation-object migration 66 widens `parent_kind`.

Gate: `pnpm typecheck`, `pnpm lint`, the registration tests
(`forced-migration`, `object-retirement`, `durable-object-self-registration`,
`durable-object-names`, `durable-object-initialization-wiring`) and a workerd
test proving a `SpaceDO` refuses a client socket upgrade and publishes no
grant-directory effect.

### Phase 2: WorkstreamDO migration 18, source-aware access

- Tables for Space access sources and Space-supplied readers; a direct-audience
  record backfilled from the current scope; `scope_grants` provenance columns
  backfilled as direct.
- RPCs to read access sources, apply a Space source (returning the audience
  delta to apply), confirm what was seated, and retract a source (returning what
  to withdraw); every commit re-reads the Space revision and membership
  generation it was fenced on.
- `apps/api/src/lib/channel-audience.ts`: the pure effective-audience function
  and its retraction plan, unit tested.
- `WorkstreamService` learns to apply and retract a Space source through the
  canonical main-conversation operations, and the direct scope and participant
  routes go through the service so direct provenance is recorded.

Gate: Node tests against the real migration ledger for the provenance tables,
unit tests for the audience function, and a workerd negative control proving
that skipping the union recomputation after a retraction leaves a reader the
test expects to be gone.

### Phase 3: WorkspaceDO migration 63, Space authority, service, routes, socket

- Space directory and viewer projections, order, waterline, memberships,
  intents, default registry and delivery targets and publications, bootstrap
  state, General identity, and the widened retirement-graph parent kind.
- `SpaceService`: create (through the creation coordinator in Space mode),
  presentation, audience (with fleet preflight over member Channels), reorder,
  add and remove a Channel (final-membership and audience-discoverability
  invariant), archive and restore, defaults (resources and Sidekicks) with
  generation-fenced delivery through the activity Queue.
- `/spaces` routes; `workspace_space_snapshot` socket event; the sidebar connect
  payload carries `spaces`; Channel rows carry their `spaceIds`; `/projects`
  routes answer with an update-required refusal.
- Paginated `GET /spaces/:id/channels` and `GET /workstreams/:id/access`.

Gate: workerd `space-authority` tests for every RPC, including the four negative
controls the PRD names (skipped finalization, skipped union recomputation,
post-await generation fencing, feed suppression), and the Node service tests.

### Phase 4: creation paths

- Every creation path that names no Space establishes membership in General
  inside the creation coordinator; a named Space establishes membership or fails
  before a visible Channel is published; the replayed-receipt path reconciles
  the same way.
- Connectors, imports, demos, recovery, scheduled Sidekick runs and the
  opportunity path are covered by the coordinator, and each is proved by a test.

Gate: the creation tests, including one proving a Channel created without a
Space lands in General and one proving a failed membership publishes nothing.

### Phase 5: cutover and Project retirement

- Bootstrap driver: alarm-claimed pages, Queue messages, consumer work, receipts,
  blocker reports, resumption after interruption; new Organizations create
  General before their first usable session.
- Project freeze: mutations refused, uncommitted default targets invalidated,
  the Project outbox drained, and Project authority deleted behind the shutdown
  barrier in migration 63's follow-on step.
- Retirement enumerates Spaces and their hidden children.

Gate: a workerd test driving an Organization with active, archived, personal and
Organization-wide Channels through bootstrap twice with an interruption between,
proving General is created once and every Channel has one active membership; the
retirement graph test covers a Space node.

### Phase 6: desktop and shared UI

- Shared `@rally/ui` Space row, appearance picker and dashboard sections; the
  desktop sidebar Spaces section with General, expandable placements, per-row
  new-Channel action, drag to add, and **Add to Space**; the Space dashboard;
  **New Space**; **Manage access** replacing **Make private**; loading, failed
  refresh, offline and Organization-opening states; local cache slice.
- Project screens, routes, API methods and cache slices removed.

Gate: component tests, and Electron screenshots of the sidebar, a Space
dashboard, the new-Space dialog and Manage access; Chrome screenshot of the lite
browser showing no Space navigation.

### Phase 7: product language

- Organization, Space, Channel and Breakout on every visible desktop, browser,
  shared-UI, email and iOS string; the implementation brief's hierarchy clauses.

Gate: the desktop, browser, UI, contracts and API suites that assert on copy.

### Phase 8: documentation and verification

- `docs/spaces.md` module document; `docs/projects.md` recorded as retired;
  updates to the data model, authorization, retirement, migration tracking,
  workstream creation, shared UI, local cache and access-revocation documents;
  the README index; the PRD decision log; `state.md` completed.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm docs:check`.
