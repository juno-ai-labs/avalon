# Per-workspace databases

> Created 2026-08-12.
>
> Every workspace's product state moves from the shared per-region D1 database
> into a database of its own — a SQLite-backed Durable Object pinned to the
> workspace's region — with schema migrations shipping inside the Worker and
> applying per workspace on wake. Companion design:
> [`design.md`](./design.md); platform research: [`research.md`](./research.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Rally's canonical product state today is one D1 database per region, with
tenancy enforced by a `workspace_id` column on every tenant-owned table and a
`WHERE` predicate on every query. This PRD replaces that with one database per
workspace: a small control-plane D1 per region keeps identity, sessions, the
workspace registry, and the Global routing directories, while everything a
workspace owns lives in a SQLite-backed Durable Object named for that workspace
and pinned to its region's jurisdiction.

The visible consequences are structural rather than cosmetic: a cross-tenant
read becomes inexpressible in the workspace data path instead of forbidden by
convention; a schema change ships in the same pull request and deploy as the
code that needs it, with no separate migration step and no window in which the
running Worker and the stored schema disagree; a migration failure takes down
one workspace instead of a region; deleting a workspace deletes a database; and
each workspace gets its own 10 GB and its own 30-day point-in-time recovery
instead of sharing a regional ceiling.

## Motivation

Four pressures, all present now:

1. **Migration cadence.** The schema changes almost every other pull request —
   76 migration files already — and every one of them rides a
   deploy pipeline that applies SQL to configured deployments *before* deploying either
   Worker. That ordering is correct and still bit us: the window where the
   previous Worker writes into the new schema turned `0063`'s fail-open default
   into mis-marked production rows, and the runbook now carries a section
   explaining the hazard. The migration *number sequence* has also already
   collided six times across merged branches. The procedure is carrying more
   operational weight than a prototype schema should ever need.

2. **Isolation is query discipline.** Invariant 1 of the data model — every
   tenant-owned table carries `workspace_id`, every lookup includes it — is
   enforced at roughly 460 `workspace_id = ?` predicates today (447 in
   `apps/api/src`, 13 in `packages/db/src`), and each new query is a new
   opportunity to omit one. The document itself calls such an omission "a
   cross-tenant read waiting for an ID to leak."

4. **The compliance road ahead.** The Google Mail + Calendar connector puts
   Rally on the path to a CASA assessment for restricted OAuth scopes, and an
   ISO 27001 posture is a matter of time for a product asking businesses to
   connect their email. Both examine tenant isolation; structural isolation is
   materially easier to evidence than 460 correct `WHERE` clauses.

Now is the cheapest this change will ever be: the only users are the team, the
data is disposable, and every week adds queries, tables, and cron sweeps to the
surface that has to move.

1. Every workspace's product state lives in its own database, in its
   workspace's region, and the workspace registry is the complete inventory of
   those databases.

2. A request's data access is scoped to one workspace's database by
   construction: the handle services receive *is* the tenant boundary, and no
   code path constructs a handle from request-controlled input.

3. A schema change ships in the pull request that needs it and deploys as one
   artifact with the code; no operator migration step exists for workspace
   data, and no deployed code version ever reads a workspace schema from a
   different version.

4. A migration failure affects exactly one workspace and fails closed; every
   other workspace serves normally.

5. A single workspace can be restored to a point in time, exported, and
   deleted — completely, database and all — without touching any other
   workspace.

7. Local development and CI keep single-command setup: creating a local
   workspace produces a correctly migrated local database with no separate
   migrate step.

## Non-goals

1. **Sharding R2, Vectorize, Queues, Workflows, or the existing Durable
   Objects per workspace.** They keep their per-region shape and
   workspace-scoped keys. Deferred: nothing in this design blocks following
   the tenant axis later if isolation or residency pressure reaches them.
2. **Per-tenant D1 databases.** Evaluated and rejected, not deferred: static
   bindings cannot follow dynamic tenants, and the HTTP-API path requires an
   account-scoped Cloudflare token in the Worker — which the security rules
   forbid and which would collapse the region boundary into one credential —
   plus a self-built fleet migration orchestrator. [`design.md`](./design.md)
   carries the full comparison; [`research.md`](./research.md) the platform
   facts.
3. **A productized data migrator.** The cutover carries the team's existing
   test workspaces with a one-shot throwaway script that replays rows from a
   `wrangler d1 export` dump through the new handle — written for the
   cutover, deleted after use. Anything beyond that — a general migrator,
   dual-write, staged backfill — is rejected outright at this stage; there
   are no users to protect.
4. **Enterprise-dedicated deployments.** Dedicated Workers, buckets, keys, and
   observability per customer remain the extension point regionalization
   already reserves — this PRD moves the *database* axis only. Deferred.
5. **Workspace region mobility.** A workspace's region stays immutable;
   per-workspace databases make a future move mechanically simpler, but no
   such feature is proposed. Deferred.
6. **Changing the desktop client's model.** Two regional API endpoints,
   compiled in and allow-listed, exactly as today. The database split is
   invisible above the service layer.

## Product behavior

Nothing about this change is a product surface, and that is the acceptance
bar: a participant creating work streams, running automations, connecting
Google, or receiving digests sees identical behavior before and after. The
behavior that does change:

- **Workspace creation** provisions the workspace's database implicitly and
  instantly — the first request migrates an empty database to the current
  schema. There is no provisioning latency a person can perceive and no
  deploy in the path.
- **A workspace whose database is unavailable or mid-recovery** fails alone:
  its members see request errors in that workspace while every other
  workspace, and sign-in itself, remain healthy. Today the same fault is
  region-wide.
- **Workspace deletion** (when the product grows a surface for it) deletes
  the workspace's database as a unit rather than sweeping rows out of shared
  tables — the difference between disposal and redaction.
- **For operators**, deploying is migrating: the deploy workflow loses its
  remote-migration steps for workspace data, and the runbook's
  migration-window procedure applies only to the small control-plane schema.

## Impact on the product contract

None — this refines infrastructure beneath the existing contract. The brief's
required outcomes that touch this layer — configured deployment signup routing, workspace
region selection at creation, typed tools only, audited external writes — are
preserved unchanged; the region boundary and identity flow described in the
brief are untouched. The public trust-center wording about regional
architecture describes the new shape *more* accurately than the old (see
Provider configuration).

## Decision log

None yet.

## Key design decisions

1. **The tenant database is a SQLite-backed Durable Object, not a per-tenant
   D1 database.** D1 bindings are static and capped (~5,000 per script), so
   dynamic tenants cannot bind; querying per-tenant D1 over the HTTP API needs
   an account-scoped token in the Worker (forbidden by the security rules, and
   one credential spanning configured deployments' tenants), pays an HTTPS round trip
   per query, and leaves fleet schema migration as a self-built orchestrator —
   Cloudflare offers **no managed migration service** for D1
   ([`research.md`](./research.md)). The Durable Object is the engine D1 is
   itself built on, addressed by name, jurisdiction-pinned by the helper the
   codebase already uses, credential-free, and migratable in its constructor.
   Rejected alternatives: per-tenant D1 (both variants) and Workers for
   Platforms, which solves dynamic binding by deploying a Worker per tenant —
   machinery built for third-party code that a first-party API does not need.
2. **The control plane stays in per-region D1.** Identity, sessions, the
   workspace registry, and the Global routing directories are the rows that
   must be readable before a workspace is known, or that span workspaces by
   nature. Two small D1 databases keep the entire existing Wrangler migration
   toolchain at exactly the fleet size it suits. Rejected alternative: moving
   identity into Durable Objects too — it buys no isolation (the control
   plane is inherently cross-tenant) and costs the auth path its simplest
   read.
3. **Migrations ship as ordered code, applied per workspace in the object
   constructor.** An ordered array in `packages/db`, per-workspace version
   bookkeeping, each step in its own transaction under
   `blockConcurrencyWhile`, fail-closed per workspace. Deploying the Worker is
   the migration; the migrate-before-deploy window, the "widen the code before
   the column" ordering rule, and filename-sequence collisions all cease to
   exist for workspace data. Rejected alternative: keeping SQL-file
   migrations and building a fleet-apply loop — the exact over-engineering
   this PRD exists to avoid ([`design.md`](./design.md) appendix records what
   it would take).
4. **The object exposes SQL over RPC in the existing `D1DatabaseLike` shape,
   not domain methods.** Repositories and services keep their architecture;
   the handle changes type while keeping the statement contract, and the seam
   already exists in `packages/db`. The priced exception: the 57 statements
   that today join workspace-owned tables to `users`, `workspace_members`, or
   `workspaces` cannot cross the split as one statement and are reworked per
   the rules in
   [`design.md`](./design.md#cross-store-reads-the-57-joins-that-split) —
   the largest mechanical cost of the cutover, named as such. Rejected
   alternative: moving the service layer into the
   workspace object (the workspace-actor model) — a defensible end state, but
   it couples this change to a rewrite of every service boundary at once, and
   the RPC handle does not foreclose it later.
5. **Hard cutover, no dual-write, no flag.** The team is the only tenant
   population; its test workspaces are carried across by the one-shot
   throwaway script of non-goal 3, and the moved tables in the regional
   databases stay frozen for a 30-day window as rollback, then are dropped.
   Rejected alternative: staged migration with backfill and dual reads —
   machinery for protecting users who do not exist yet.
6. **Cross-tenant cron sweeps become per-workspace work.** Reapers,
   retention, outbox draining, and digest reconciliation run inside each
   workspace (on its own or the `WorkspaceScheduler`'s alarm), with the
   regional cron reduced to control-plane duties. Rejected alternative: a
   regional fan-out loop querying every workspace object from the cron — it
   recreates the shared-database scan with extra hops and wakes cold
   workspaces for no benefit.
7. **Dev-loop workspace SQL access ships as a CLI wrapper from day one.** A
   small pnpm script drives the read-only diagnostic RPC against the local
   Worker, so the tool that replaces `wrangler d1 execute --local` for
   workspace data is the same one used against hosted objects. Rejected
   alternative: leaning on Miniflare's on-disk SQLite files and any `sqlite3`
   client — free, but a second inspection path that diverges from what
   operators actually run.
8. **Object placement is accepted as platform behavior.** A workspace
   database lives where it was first created; a workspace whose members move
   continents keeps its database where it started. This matches the regional
   property D1 already has today, so no phase-1 benchmark is run. Rejected
   alternative: a deliberate remote-object latency measurement — a number
   with no decision attached to it.
9. **Scoped-memory lexical search carries over unchanged.** Cloudflare
   documents the FTS5 module (including `fts5vocab`), the JSON extension, and
   math functions as supported in Durable Object SQLite
   ([`research.md`](./research.md)), so D1 FTS5-based memory search needs no
   fallback. Verified against the platform documentation while this PRD was
   written; had it been absent, the lexical leg would have needed a
   replacement before phase 1.

## Data model

The split follows the grain the schema already has
([`design.md`](./design.md#two-stores-split-by-what-owns-the-row) has the full
table assignment):

- **Control-plane D1 (per region, existing databases):** `users`, `sessions`,
  `oauth_states`, `desktop_login_tickets`, `workspaces`, `workspace_members`,
  `workspace_invitations`, plus the Global-only directories
  (`platform_workspace_bindings`, `regional_onboarding_operations`, the four
  provider route tables, `workstream_email_routes`).
- **Workspace database (one per workspace):** every table whose rows carry
  `workspace_id` today — work streams and everything attached to them,
  automations and runs, memory, schedules, activities and the activity-event
  log, connector connections, notes, audit events. Inside a workspace
  database the `workspace_id` columns are removed: the database is the
  workspace, and a redundant column would be a fossil of the old discipline.
- **Cross-store references:** the schema declares 86 `REFERENCES
  workspaces(id)` and 68 `REFERENCES users(id)` constraints — 42 of the
  latter `ON DELETE CASCADE` — overwhelmingly on tables that move, and none
  of them can be declared across the split. Foreign keys between moved tables
  stay declared inside the workspace database; references to control-plane
  rows become plain IDs whose integrity the application owns, and user
  deletion becomes an explicit control-plane operation that fans out to every
  workspace database the user belonged to. The credential-bearing
  `connector_connections.owner_user_id` cascade is the row this fan-out
  exists for; the design is in
  [`design.md`](./design.md#cross-store-references-and-deletion).
- **Backfill:** none — non-goal 3. The new baseline schema is written fresh
  as migration step 0.

`data-model.md` is rewritten alongside the implementation; its invariant 1
changes from "every query includes `workspace_id`" to "tenant scope is the
database handle, resolved only from the session."

## Security and trust model

**Isolation moves from discipline to structure.** The workspace data path can
no longer express a cross-tenant query: services hold a handle to one
workspace's database, and the handle is derived from the session's resolved
workspace through the namespace helper — never from a request body, preserving
the existing rule that repositories never choose a region (now: a database)
from user-controlled input. SQL injection through any workspace-scoped query
degrades from a potential cross-tenant read to a single-tenant one. The
control-plane D1 remains genuinely multi-tenant and keeps the full existing
query discipline; it is small, slow-moving, and enumerable.

**No new credentials exist.** The chosen design adds zero secrets to either
Worker — the decisive contrast with the per-tenant-D1 alternative, whose
account-scoped API token would have been a standing Worker credential able to
read every tenant in configured deployments, violating the rule that Cloudflare
administration credentials never become Worker variables.

**One surface becomes security-critical and is named as such:** the
derivation of a workspace database handle. It is written once, in the shared
namespace helper, imported everywhere — the same single-expression rule the
codebase applies to work-stream visibility, and the natural place for the
tests that prove a request cannot reach another workspace's name. The session
path is the easy case; the system's other entry points hold no session, and
each class gets its own stated rule for what authorizes the handle:

- **Queue messages and Workflow parameters** carry workspace IDs the Worker
  itself minted, and the consumer re-resolves the ID against the control-plane
  registry at the hop before constructing a handle — the same
  parse-at-the-boundary rule the RPC bridges already enforce.
- **Provider webhooks and inbound email** never name a workspace directly: a
  delivery is signature-verified first, resolved through the verified routing
  directories (`github_installation_routes`, `workstream_email_routes`, and
  peers) second, and only the directory's answer — a control-plane row —
  becomes a handle. Untrusted input selects a directory key; it never selects
  a database.
- **The cron and the schedulers** enumerate the workspace registry itself.

In every class the handle follows a control-plane row; no value that entered
from outside the trust boundary is ever used as an object name.

**CASA.** The Cloud Application Security Assessment (App Defense Alliance,
required by Google for restricted OAuth scopes) verifies the application
against OWASP ASVS; access control and tenant isolation are assessed at the
application layer. This change improves the position an assessor examines:
isolation is architectural (one database per tenant, region-pinned,
credential-free) rather than evidenced query-by-query, and the injection blast
radius is per-tenant. It does not change *whether* CASA applies — the
connector scopes decide that — and the control plane and provisioning path
join the assessed surface, so their discipline is part of the story told.

**ISO 27001.** Cloudflare's own ISO 27001/SOC 2 certifications cover D1 and
Durable Objects alike, so inherited provider controls are unchanged either
way. For Rally's own future ISMS, the change is net-positive with named
costs: asset inventory becomes the workspace registry (complete by
construction); secure disposal becomes real (deleting a workspace deletes a
database, not rows in shared tables); backup and restore become per-tenant
(30-day PITR per workspace instead of region-wide restore as the only
option); access control evidence simplifies as above. The costs: operator
access to tenant data must be rebuilt deliberately — the audited diagnostic
RPC and export path in [`design.md`](./design.md#operator-access) — and
fleet-wide observability (schema-version telemetry, per-workspace failure
alerting) becomes part of the monitoring control set. Neither certification
exists today; this PRD's claim is only that the architecture stops working
against both.

## Provider configuration

No Cloudflare dashboard resources are created or destroyed at cutover — the
Durable Object namespace ships in the Wrangler configurations, and the two D1
databases remain. Two follow-ups outside the repository: the deploy workflow's
remote-migration steps narrow to the control-plane schema, and the site's
security page paragraph describing regional architecture ("workspace
identifiers are included in resource queries") is updated to describe
per-workspace databases — in the same change, per the site's rule against
uncertified claims. After the 30-day rollback window, the legacy rows in the
regional D1 databases are dropped by an ordinary control-plane migration.

## Rollout

No flag, by design decision 5 — the phases are pull requests, not toggles:

1. Land `WorkspaceDatabase`, the migration-step array with the fresh baseline
   schema, the RPC handle, and the container seam, alongside the existing
   path (inert until used).
2. Cut services, Durable Objects, Workflows, the Queue consumer, and the cron
   over to the workspace handle and the control-plane split; delete the
   `workspace_id` plumbing; rewrite the affected docs (`data-model.md`,
   `architecture.md`, `regionalization.md`, `runbook.md`,
   `dev-environment.md`) in the same changes.
3. Deploy, carry the team's workspaces across with the one-shot import
   script (recreating any not worth carrying), verify the acceptance flows.
4. Day 30: delete the legacy regional databases' moved tables and close the
   rollback window.

Turning it off: within the window, redeploy the previous Worker. The *moved
tables* in the regional databases were never written by the new path, so
every pre-cutover workspace serves exactly as it did — but the control plane
is those same two databases and stays live, so a workspace created after
cutover appears to the old Worker with no tenant rows behind it and serves as
empty. Accepted: such workspaces are the team's own and are recreated or
re-imported. After the window, fix forward.

## Acceptance

- The e2e smoke and the manual desktop acceptance flows (sidebar, signup,
  invitations, settings, realtime recovery, dictation) pass unchanged against
  the cutover deploy, in configured deployments.
- Creating a workspace in each region and exercising a work stream, an
  automation run, a connector poll, and a digest shows correct behavior with
  the regional D1 databases' moved tables receiving zero reads or writes.
- A deliberately failing migration step in a staging workspace leaves that
  workspace failing closed while a second workspace serves normally, and the
  corrected deploy heals it without operator action.
- A workspace's database restores to a pre-fault bookmark via the PITR
  runbook entry without any other workspace observing an interruption.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, and both
  Wrangler dry-run builds stay green with the migration-step suite replacing
  the SQL-file suite for workspace schema.
