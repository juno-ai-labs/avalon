# Supabase workspace and work-stream conversations implementation plan

This plan implements the approved PRD without making an unreviewed authority
cutover. The existing D1/R2 system remains authoritative until a workspace has
completed the PRD's copy, verification, source-closure, and route activation
protocol. The implementation therefore ships as an independently deployable
global Supabase project, a repeatable regional Supabase project template, and
Cloudflare runtime adapters selected by an explicit authority route.

## Implementation status on 2026-08-17

Phase 1 and the schema/client foundation of Phase 2 are implemented behind
`PRODUCT_DATA_AUTHORITY`, which remains `d1` in both checked-in deployments.
The source-local authority gate, schema-wide direct/inherited D1 write fences,
and destination receipt check fail closed, but
the desktop Supabase session/Realtime transport is not implemented, so a
Postgres-routed workspace is deliberately refused by legacy Worker routes
rather than falling through to D1. Phase 3 has tested relational commands for
conversation ordering, active-output recovery, queue/steer, access-revision
revocation, sidebar snapshots, compaction, connector ingress/activity,
suggestion acceptance, search, and the first full-loop Workflow host. The
Workflow retry finalizes an already-recorded model outcome without reinference,
supersedes an unresumable partial stream, and refuses to replay a previously
claimed tool effect without reconciliation. The approved
Postgres-native plugin surface, complete Daytona reconciliation, and consumers
for connector/derived-content/maintenance queues remain outstanding. Phase 4
has source gates, import/route receipts, leased migration slices, and pause
fences; export execution, observability dashboards, and a live internal
migration remain outstanding. Phases 2–5 therefore remain rollout work, and no
workspace is authorized to cut over from this branch alone. This is enforced in
code: `POSTGRES_AUTHORITY_RUNTIME_BLOCKERS` makes health and per-workspace
authority resolution fail closed until those named surfaces land.

## Phase 1 — Reproducible platform projects

- Pin the Supabase CLI and Postgres client versions.
- Check in separate local Supabase projects for the global control database and
  regional product shard template.
- Create forward-only migrations for extensions, roles, schemas, grants,
  tables, indexes, functions, Realtime authorization, queues, Cron metadata,
  Storage policy, and vector search.
- Add SQL tests that prove UUIDv7 behavior, tenant isolation, command
  idempotency, conversation ordering, streaming checkpoint recovery, and route
  fencing against a real local Postgres/Supabase stack.

Exit: both projects rebuild from an empty database and their SQL tests pass.

## Phase 2 — Typed Cloudflare data plane

- Add one workerd-compatible Postgres package using transaction-pooled
  connections with prepared statements disabled.
- Expose only typed global-routing, regional-command, Workflow-checkpoint, and
  queue RPCs; ordinary call sites do not issue raw SQL.
- Add regional/global configuration validation and health probes without
  logging connection strings or credentials.
- Keep D1 as the default authority. A route may select `shadow` only for
  comparison writes or `postgres` only after a durable cutover receipt exists.

Exit: Workers and Workflows can execute the reviewed Postgres RPC surface and
the D1 path remains unchanged for unrouted workspaces.

## Phase 3 — Product command path

- Implement workspace/work-stream creation, message admission, queue versus
  steer semantics, seen waterlines, sidebar/home queries, durable cursor
  recovery, active-output checkpoint/finalization, and Realtime topic
  resolution as atomic Postgres commands.
- Implement Workflow run/action/signal/effect receipts and Daytona terminal
  reconciliation over those commands.
- Implement connector ingress, activity normalization, digest/suggestion jobs,
  content references, exact/vector search, and sparse mention materialization.

Exit: the stress studies' accepted state changes are representable through one
transactional API and have deterministic retry behavior.

## Phase 4 — Migration and operations

- Implement D1/R2 export manifests, immutable import chunks, reconciliation,
  maintenance-window source closure, destination activation, and global route
  convergence.
- Implement bounded migration, export, retention, deletion, storage
  reconciliation, dead-letter, and audit workers.
- Add observability for pool saturation, lock time, queue age/read count,
  checkpoint write amplification, Realtime fallback, RLS denial, and authority
  drift.

Exit: an internal workspace can migrate, verify, cut over, recover, and delete
without two writable authorities.

## Phase 5 — Canary and retirement

- Run shadow comparisons without dual-authority writes.
- Canary internal workspaces by region and stop on invariant drift.
- Measure the PRD's connection, write, Realtime-message, storage, and vector
  budgets before widening the cohort.
- Retire a source workspace only after its closure evidence and rollback window
  satisfy the runbook.

Exit: the production authority may be widened by a separately reviewed routing
change. Completion of this implementation plan does not itself authorize that
rollout.

## Required gates for every phase

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:scripts`.
- Both Wrangler dry-run builds whenever Worker bindings or dependencies change.
- `supabase db reset` and `supabase test db` for each project whenever SQL
  changes.
- Supabase security and performance advisors on linked staging projects before
  production migrations.
- No committed project passwords, secret keys, provider secrets, or raw
  customer content in fixtures and logs.
