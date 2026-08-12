# Design — per-workspace databases

> Created 2026-08-12. Companion to [`prd.md`](./prd.md); platform facts and
> sources are in [`research.md`](./research.md). This file holds the material
> too detailed for the PRD body: the carrier decision, the target architecture,
> the schema-migration procedure and its error handling, capacity math, and the
> cutover.

The architecture below was designed from requirements first, without regard to
the shape of the current code, per the brief that commissioned this PRD. The
[Cutover](#cutover) section is where the existing system enters the picture.

## Requirements, from first principles

A tenant store for Avalon must satisfy, in priority order:

1. **Structural tenant isolation.** Holding a workspace's database handle is
   the authorization to read that workspace and nothing else. Cross-tenant
   reads are impossible to *express* in the data path, not merely forbidden by
   query discipline.
2. **Residency by construction.** A workspace pinned to the EU stores its rows
   in the EU jurisdiction, through the same kind of mechanism that pins its
   Durable Objects today — not through an operator promising to have created
   the right resource.
3. **Schema velocity.** Avalon changes schema almost every other PR. A schema
   change must ship in the same pull request and the same deploy as the code
   that needs it, with no separate operator step, no cross-fleet coordination,
   and no window in which deployed code and stored schema disagree.
4. **No standing platform credentials in Workers.** The repository rule stands:
   Cloudflare administration credentials never become Worker variables. An
   architecture that requires a Worker to hold an account-scoped API token to
   reach its own data is disqualified.
5. **Tenant-scoped failure.** A migration or storage failure in one workspace
   affects that workspace only, and fails closed.
6. **Query latency comparable to today.** The API's repositories are chatty;
   a per-query HTTP round trip is a permanent tax the design must not pay.
7. **Provisioning in the request path.** Creating a workspace creates its
   database synchronously, without deploys and without calling the Cloudflare
   management API from a Worker.

## The carrier decision

Four ways to give each workspace its own database on Cloudflare:

| Option | Verdict | Why |
| --- | --- | --- |
| **A. One D1 database per workspace, bound statically** | Rejected outright | Bindings are fixed at deploy time (~5,000 per script). Workspace creation would require a Worker deployment — requirement 7 fails immediately. |
| **B. One D1 database per workspace, queried over the D1 HTTP API** | Rejected | Requires an account-scoped D1 API token as a Worker secret, violating requirement 4; that one token reads every tenant database in **both** regions, collapsing the Global/EU boundary into a single credential and inverting requirement 1 into a worse posture than today's. Every query becomes an HTTPS request (requirement 6), database creation calls the Cloudflare management API from the signup path (requirement 7), and schema changes need a self-built fleet orchestrator (requirement 3, and see [the fleet procedure below](#appendix-what-fleet-migration-over-per-tenant-d1-would-look-like)). |
| **C. Workers for Platforms — one dispatched user Worker per workspace, each with a D1 binding** | Rejected | Solves dynamic binding by deploying a Worker per tenant through the platform API. Built for running third-party code; for a first-party API it adds a deployment pipeline per workspace and keeps option B's provisioning credential, buying nothing over D. |
| **D. One SQLite-backed Durable Object per workspace** | **Chosen** | D1's own storage engine, used directly. Unlimited objects, 10 GB each, addressed by name (`idFromName`), pinned to the EU jurisdiction through the exact helper the codebase already uses for its other per-workspace objects, no credentials, no management-API calls, synchronous SQL colocated with the object, 30-day point-in-time recovery. Migrations ship inside the Worker bundle and run in the object constructor — requirement 3 is satisfied *by construction*. |

The honest framing of D versus B: D1 **is** a SQLite Durable Object with an
HTTP front end, a dashboard, Wrangler tooling, and Time Travel attached.
Option B buys that tooling at the price of requirements 3, 4, 6, and 7.
Option D gives up the tooling and keeps the engine; the [operator
tooling](#operator-access) we actually need is small and gets built once.

## Target architecture

### Two stores, split by what owns the row

**The regional control plane stays in D1** — one small database per region,
exactly as deployed today, holding only what is *about* tenants or *across*
them:

- Identity and session: `users`, `sessions`, `oauth_states`,
  `desktop_login_tickets`.
- The workspace registry: `workspaces`, `workspace_members`,
  `workspace_invitations` — the rows auth resolves before a tenant database
  handle exists.
- Global-only directories (Global control plane only):
  `platform_workspace_bindings`, `regional_onboarding_operations`,
  `github_installation_routes`, `linear_organization_routes`,
  `notion_workspace_routes`, `slack_installation_routes`,
  `workstream_email_routes`.

This split follows the grain the schema already has: these are precisely the
tables that either carry a `region` column, exist only in Global, or must be
readable before the request's workspace is known. The control-plane schema is
small and slow-moving; two databases keep the whole existing Wrangler migration
toolchain, unchanged, at the fleet size it was designed for.

**Everything a workspace owns moves into that workspace's database object** —
work streams, messages, participants, pins, read states, resources,
automations, subscriptions, runs, harness runs, tool invocations, memory
scopes/items/tables, schedules, wakeups, activities, activity events, digest
schedules/deliveries, connector connections, notes, audit events: every table
whose rows carry `workspace_id` today. Inside a workspace database the
`workspace_id` column disappears — the database *is* the workspace.

### The workspace database object

A new Durable Object class, `WorkspaceDatabase`, bound once in both Wrangler
configurations:

- **Named** `${region}:${workspaceId}` and resolved exclusively through the
  shared helper in `apps/api/src/lib/durable-object-namespace.ts`, which pins
  EU workspaces with `jurisdiction("eu")`. The name is derived from the
  session's resolved workspace — never from a request body — preserving the
  existing invariant that repositories never choose a region (now: a database)
  from a user-controlled object ID.
- **Provisioned implicitly.** A Durable Object exists when first addressed;
  workspace creation writes the `workspaces` row in the control plane and the
  first request to the object runs the full migration set against an empty
  database. No management API, no deploy, nothing to leak.
- **Exposes SQL over RPC, not domain methods.** The object's RPC surface is
  the `D1DatabaseLike` contract that `packages/db` already defines: prepared
  statements, bound parameters, `first`/`all`/`run`, and an atomic `batch`.
  Services keep their current shape — repositories and statement builders in
  `packages/db`, business rules in `apps/api/src/services` — and receive a
  database handle that happens to be an RPC stub instead of a D1 binding.
  Same-colocation RPC is an in-process-class call; the hop that exists is the
  same kind of hop a D1 query pays today, because D1 is the same object model.
- **Serializes writes per workspace.** A Durable Object processes one event at
  a time, which strengthens — for free — the invariants the schema currently
  defends with unique indexes and compare-and-swap: sequence-number
  allocation, scheduled-run convergence, wake-up at-most-once claims, digest
  occurrence claims.
- **Owns per-workspace housekeeping.** The cron sweeps that today scan the
  regional database without a workspace filter — stale harness-run reaping,
  draft-attachment cleanup, activity-event retention, the memory-index outbox,
  digest-default reconciliation — become work the workspace performs for
  itself on an alarm, or on the existing `WorkspaceScheduler`'s alarm. The
  regional cron's remaining job is control-plane work and enumerating the
  workspace registry to nudge objects that should wake.

The auth path orders cleanly: middleware resolves the session and membership
against the control-plane D1 exactly as it does today, then constructs the
request's dependency container around the workspace's database stub. An
unauthenticated request never wakes a workspace object.

### What deliberately does not shard

R2 payloads, Vectorize memory indexes, Queues, Workflows, and the
`WorkstreamRoom` / `WorkspaceScheduler` objects keep their current per-region
shape and their workspace-scoped keys/filters. They follow the tenant axis
later if a need materializes; nothing in this design blocks it.

## Schema migration procedure

This is the answer to "with many databases instead of 2, what does the
migration procedure look like": **for workspace data, there is no migration
procedure left to run.** The procedure becomes a property of deployment.

### Mechanism

- **Migrations are code.** `packages/db` exports an ordered array of migration
  steps — plain SQL strings, exactly like today's files, plus an optional
  data-backfill function for the rare step SQL cannot express. Order is the
  array index: explicit, reviewable, and immune to the filename-sort collisions
  the current directory has already accumulated six of.
- **Each workspace database records its version** — the count of applied
  steps — in its own metadata table, the same bookkeeping `d1_migrations`
  performs for D1.
- **The object migrates itself in its constructor**, inside
  `blockConcurrencyWhile`: compare stored version to the shipped array, apply
  each pending step in its own transaction, bump the recorded version per
  step. No request, RPC, or alarm reaches the object before this completes.
- **Deploying the Worker *is* the migration.** Every workspace object woken
  after the deploy migrates itself before serving its first request. A
  workspace that stays cold stays unmigrated — and unserved — until it wakes,
  which is exactly when its schema matters. A tenant created mid-deploy is
  born at whatever version its first-serving Worker ships; there is no
  provisioning race.
- **The control plane keeps today's procedure** — numbered `.sql` files under
  Wrangler, applied to two databases by the deploy workflow — for the small
  schema where that procedure's cost is already paid and its fleet size is
  fixed.

### What this eliminates

Almost every hazard the current runbook documents around migrations is a
consequence of schema and code deploying *separately*, and dissolves when they
ship as one artifact:

- **The migrate-before-deploy window is gone** for workspace data. Today the
  deploy job applies both regions' migrations before either Worker deploys, so
  the previous Worker writes into the new schema for ~20 seconds — indefinitely
  if the deploy fails between the steps, which is how
  `0063_activity_events_digestible.sql`'s fail-open default mis-marked rows in
  production. A workspace object can never run code against a schema from a
  different release: the code carries its schema with it.
- **"Widen the code before the column" ordering is gone** for workspace data,
  for the same reason — there is no moment when old readers meet new rows.
- **Fleet divergence is impossible to observe.** Databases at different
  versions exist only while cold; version skew between a database and the code
  serving it does not exist.
- **Migration-number collisions are gone** — an array has one order.

### Cadence

The every-other-PR reality gets cheaper, not costlier: a schema change is one
more array element in the same pull request as the code that uses it, exercised
by the same migration test harness that exists today (apply all steps in order
into an in-memory SQLite database; `migrateDatabaseThrough`-style fixtures for
backfills), and shipped by the same deploy with zero operator steps. The
current caveat that the test harness's `node:sqlite` accepts syntax the real
engine rejects carries over unchanged — the engine is the same SQLite either
way, and the dry-run/dev-loop checks remain the backstop.

## Error handling

**A failing migration step fails one workspace, closed.**

- Each step applies in its own transaction: it lands entirely or not at all,
  and the recorded version only advances past durable steps. A failure leaves
  the database at the last good version with no partial step applied.
- The constructor rethrows; the object does not serve. That workspace's
  requests fail with a 500 until fixed; every other workspace — migrated or
  not-yet-woken — is untouched. This is the per-tenant blast radius requirement
  satisfied at its sharpest point.
- Every later request retries the migration from the recorded version, so a
  transient storage failure heals itself on the next request.

**Recovery is fix-forward, preserving the existing rule that a rollback is a
forward migration, never a redeployment of the previous Worker:**

- A step that is *wrong* (fails deterministically) is fixed by deploying a
  corrected step. Steps already applied somewhere are immutable — the current
  migration immutability invariant, unchanged; the fix is a new step, or a
  correction to a step no woken database has applied (knowable from version
  telemetry, but the safe default is: shipped means immutable).
- A step that *damaged data* in a woken workspace is repaired per workspace by
  point-in-time recovery — every workspace database independently rewinds to
  any instant in the last 30 days. Restoring one tenant no longer means
  restoring a region.
- Failures surface in observability keyed by workspace ID and stored version,
  which the existing region-tagged structured logs extend naturally.

**Testing:** the ordered array applies into in-memory SQLite in unit tests
(schema assertions, backfill fixtures), and the local dev loop exercises the
real constructor path on real (Miniflare) objects on every boot — the local
database is created the same way production ones are, which today's separate
`pnpm db:migrate` step only approximates.

## Quotas and capacity

The direct answers to the quota questions, both carriers, from
[`research.md`](./research.md):

| | Today (per-region D1) | Per-tenant D1 (rejected) | Per-workspace DO SQLite (chosen) |
| --- | --- | --- | --- |
| Databases per account | 2 of 50,000 | 50,000 cap (raisable) | Unlimited objects |
| Size per database | 10 GB **per region, all tenants** | 10 GB per tenant | 10 GB per tenant |
| Account storage ceiling | 1 TB (D1 total) | 1 TB (raisable) | Unlimited on Workers Paid |
| Per-query engine limits | 100 KB statement, 2 MB row, 100 columns, 100 parameters | identical | identical — same engine |
| Point-in-time recovery | Time Travel, 30 days, per region | Time Travel, 30 days, per DB | PITR, 30 days, per workspace |
| Throughput bound | 6 simultaneous connections per invocation | API rate limits (unpublished for `/query`) | ~1,000 rps soft cap **per object** — i.e. per workspace, ample |

The capacity story *improves* in every cell that matters: the shared 10 GB
regional ceiling becomes 10 GB per workspace (R2 already carries payloads, so
relational metadata approaching 10 GB for a single workspace is far away), and
the account-level 1 TB D1 cap stops being Avalon's aggregate ceiling at all.

## Operator access

What Wrangler and the dashboard provide for D1 must be replaced for workspace
objects; this is the real cost of option D, and it is bounded:

- **Ad-hoc queries** — a read-only diagnostic RPC on `WorkspaceDatabase`,
  reachable only through an operator-authenticated admin route that logs to
  `audit_events`, mirroring the runbook's existing raw-inference inspection
  posture. Never exposed to product code.
- **Export** — a `dump` RPC streaming a SQL-text dump to the region's R2
  bucket, giving per-workspace backup artifacts `wrangler d1 export` used to
  give per region.
- **Restore** — an operator runbook entry driving the PITR bookmark API.
- **Version telemetry** — each object reports its schema version on wake; the
  health surface aggregates lag so an operator can see fleet skew (expected
  and harmless: cold objects lag by definition).

## Cutover

Prototype posture, applied deliberately: **hard cutover, no data migration, no
dual-write, no feature flag.** The only users are the team; the cheapest
correct migration of a disposable dataset is to not perform one.

1. **Land the data layer.** `WorkspaceDatabase` class, the migration-step
   array (a fresh schema baseline — current schema minus `workspace_id`
   columns and minus control-plane tables — written as step 0), the
   `D1DatabaseLike`-over-RPC handle, and the dependency-container seam that
   hands services a workspace database instead of `env.DB`.
2. **Cut services over** to the workspace handle and the control-plane split.
   The ~268 `workspace_id` predicates in tenant-scoped queries become dead
   weight and are removed with their columns rather than left as fossils —
   clean architecture over migration diff-size, per the brief.
3. **Reset hosted state.** Recreate the team's test workspaces through
   ordinary signup after the cutover deploys. If any test workspace is worth
   keeping, a one-shot throwaway script replays its rows from a
   `wrangler d1 export` dump through the new handle — written only if wanted
   at cutover time, deleted after use, never productized.
4. **Retire the legacy path.** The per-region D1 databases stay untouched (and
   readable through Wrangler) for 30 days as a safety net, then are deleted.
   The control-plane D1 databases live on with only the control-plane tables;
   a control-plane migration drops the moved tables.

**Rollback during the safety window** is redeploying the previous Worker —
its databases were never written to by the new path. After the window, the new
architecture is simply the system; there is nothing to roll back to, which is
the accepted meaning of a hard cutover at this stage.

## Appendix: what fleet migration over per-tenant D1 would look like

Recorded because the PRD's brief asked the question directly, and because it is
the strongest argument for the chosen design. Had option B been taken, schema
change would require a self-built orchestrator with all of the following, on
every-other-PR cadence:

- A registry of every tenant database ID (the control plane), enumerated on
  each deploy by a loop calling `wrangler d1 migrations apply` — or the HTTP
  API — once per database, under an operator/CI credential with account-wide
  D1 write scope.
- **Partial-failure bookkeeping**: with N databases, a failed run leaves the
  fleet straddling versions. The loop needs per-database applied-state
  tracking (each database's `d1_migrations` table), resumability, retry with
  backoff, and an alert when a database stays behind.
- **Skew-tolerant code**: the migrate-before-deploy window multiplies by N —
  deployed code meets both old and new schema for however long the fleet loop
  runs (or stalls), so every schema change must be written and tested to be
  read-compatible across adjacent versions. This is the "over-engineered
  migrations" the brief rejects, imposed by the carrier rather than chosen.
- **Provisioning races**: a workspace created while the loop runs must be
  created at the new baseline but might be created by a Worker still running
  old code; the creation path needs its own version negotiation.
- **A second migration path for local dev**, since Miniflare's D1 simulation
  would need the same fleet loop against however many local tenant databases
  exist.

None of this machinery exists as a product anywhere in Cloudflare's platform
(see [`research.md`](./research.md) — there is no managed migration service),
so every line of it would be Avalon's to write, operate, and audit. The chosen
design deletes the entire category.
