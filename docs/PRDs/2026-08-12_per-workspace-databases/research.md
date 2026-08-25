# Research — platform facts behind the per-workspace database PRD

> Created 2026-08-12. Companion to [`prd.md`](./prd.md) and
> [`design.md`](./design.md). Everything here is a verifiable claim about
> Cloudflare's platform as of August 2026, gathered before the architecture was
> chosen. Nothing in this file is a proposal.

## D1 quotas and account limits

From [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), Workers
Paid plan (the plan Rally deploys on):

| Limit | Value |
| --- | --- |
| Databases per account | **50,000** (raisable on request; 10 on Free) |
| Maximum size per database | **10 GB** (500 MB on Free) |
| Total storage per account | **1 TB** (raisable on request; 5 GB on Free) |
| Queries per Worker invocation | 1,000 |
| Maximum SQL statement length | 100 KB |
| Maximum row / string / BLOB | 2 MB |
| Columns per table | 100 |
| Bound parameters per query | 100 |
| Simultaneous D1 connections per invocation | 6 |
| Bindings per Worker script | ~5,000 |
| Time Travel retention | 30 days (10 restores per 10 minutes per database) |

Two consequences for a per-tenant design:

1. **Database count is not the constraint.** 50,000 databases covers any
   workspace count the prototype will see, and D1 pricing is rows read/written
   plus storage — a thousand mostly idle databases cost roughly what one does.
2. **The 10 GB per-database cap moves from per-region to per-tenant.** Today
   both regions' entire product state shares one 10 GB ceiling each; one
   database per workspace gives every workspace its own 10 GB, with the 1 TB
   account total as the new aggregate ceiling.

## What `wrangler d1 migrations` actually is

Documented at [D1
migrations](https://developers.cloudflare.com/d1/reference/migrations/):

- **Client-side tooling, not a managed service.** Wrangler reads sequential
  `.sql` files from `migrations_dir`, tracks what has been applied in a
  `d1_migrations` table *inside the target database*, and applies the pending
  ones in filename order. All orchestration — ordering relative to deploys,
  retries, fleets — is the caller's problem.
- **One database per invocation.** `wrangler d1 migrations apply DB` targets
  the single database the named binding resolves to in the given config.
  There is no fleet mode; N databases means N invocations of your own loop.
- **A failing migration file rolls back as a unit** and leaves earlier applied
  migrations in place ([Wrangler
  commands](https://developers.cloudflare.com/d1/wrangler-commands/)). D1 does
  not support SQL `BEGIN TRANSACTION` / `SAVEPOINT`; atomicity comes from the
  batch API, which is all-or-nothing.

## Does Cloudflare have a managed migration service or product?

**No.** There is no Cloudflare product that manages schema migration — nothing
comparable to RDS Blue/Green deployments or PlanetScale deploy requests, and
nothing that applies a schema change across a fleet of D1 databases. The
adjacent things that exist, and what they are instead:

- **Wrangler migrations** — the client-side bookkeeping above.
- **[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)**
  — 30-day point-in-time *data* restore per database. Disaster recovery, not
  schema management.
- **`wrangler d1 export` / `import`** — whole-database SQL dump and load
  (5 GB file cap).
- **Third-party tools** (Drizzle Kit, Prisma Migrate, Atlas) — generate and
  apply migrations through the same client-side path; none orchestrate fleets
  of D1 databases.

Anyone running database-per-tenant on D1 writes their own control loop over the
[D1 HTTP API](https://developers.cloudflare.com/api/resources/d1/) to create
databases and apply schema to each. Community threads confirm this is the
state of the art ([workerd discussion
#3564](https://github.com/cloudflare/workerd/discussions/3564), [Cloudflare
community](https://community.cloudflare.com/t/dynamically-create-d1-instance/515284)).

## Why per-tenant D1 cannot use bindings, and what the workarounds cost

- **Bindings are static.** A `d1_databases` entry is declared in Wrangler
  configuration at deploy time. A new tenant database can only become a binding
  through a redeploy, and the practical ceiling is ~5,000 bindings per script.
  Workspace creation must not require a Worker deployment, so bindings are out.
- **The D1 HTTP API works but changes the trust model.** `/query` and `/raw`
  are now served at the nearest PoP rather than proxying through the control
  plane (50–500 ms better than it was), but every query is still an HTTPS
  request, and authentication is a Cloudflare **account-scoped API token**. D1
  tokens scope to the account's D1, not to a subset of databases — a single
  credential held by a Worker could query *every* tenant database in *both*
  regions.
- **Workers for Platforms** gives each tenant a dispatched user Worker with its
  own static bindings
  ([docs](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/bindings/)).
  It is built for running third-party code; adopting it for a first-party API
  means a Worker deployment per workspace via the platform API.

## SQLite-backed Durable Objects

From the [GA announcement (April
2025)](https://developers.cloudflare.com/changelog/2025-04-07-sqlite-in-durable-objects-ga),
[SQLite storage API
docs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
and [Durable Objects
limits](https://developers.cloudflare.com/durable-objects/platform/limits/):

| Limit | Value |
| --- | --- |
| SQLite storage per object | **10 GB** |
| Number of objects | **Unlimited** (per account and per class) |
| Total SQLite storage per account | **Unlimited** on Workers Paid |
| Statement length / row size / columns / bound parameters | 100 KB / 2 MB / 100 / 100 — same engine limits as D1 |
| Requests per object | ~1,000 rps soft limit per object |
| Point-in-time recovery | 30 days, via the storage API's `getCurrentBookmark` / `onNextSessionRestoreBookmark` |

Relevant properties:

- **FTS5 is supported.** The [SQLite storage API
  docs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
  list the supported extensions: the "FTS5 module for full-text search
  (including `fts5vocab`)", the JSON extension, and math functions — so
  D1-style FTS5 full-text search carries over to Durable Object SQLite.
- **This is the primitive D1 is built on.** A D1 database *is* a SQLite-backed
  Durable Object plus an HTTP/binding front end and dashboard tooling
  ([Cloudflare blog](https://blog.cloudflare.com/sqlite-in-durable-objects/)).
  Choosing DO SQLite per tenant is choosing D1's engine while replacing its
  per-database tooling with code.
- **Synchronous SQL, colocated with compute.** `ctx.storage.sql.exec()` runs
  in-process with implicit write coalescing; there is no per-query network hop
  once execution is inside the object.
- **Objects are addressed by name and pinned by jurisdiction.**
  `idFromName(...)` plus `namespace.jurisdiction("eu")` — the exact mechanism
  `apps/api/src/lib/durable-object-namespace.ts` already uses for
  `WorkstreamRoom` and `WorkspaceScheduler` — creates and keeps an object
  inside the EU jurisdiction.
- **The community-standard migration pattern** is versioned migrations applied
  in the object constructor inside `blockConcurrencyWhile`, tracked per object
  ([Cloudflare's own guidance](https://blog.cloudflare.com/sqlite-in-durable-objects/),
  [Boris Tane — database per
  user](https://boristane.com/blog/durable-objects-database-per-user/),
  [SQLite migrations in Durable
  Objects](https://www.cris-o.com/notes/sqlite-migrations-durable-objects/)).
  No request reaches the object before its schema is current, and a tenant that
  is never woken is never migrated — the schema always matches the code that is
  about to run against it.

## Compliance facts

- **Cloudflare's certifications cover both candidate stores.** D1 and Durable
  Objects sit inside the scope of Cloudflare's ISO 27001 and SOC 2 Type II
  certifications of the global cloud platform ([D1 data
  security](https://developers.cloudflare.com/d1/reference/data-security/),
  [Cloudflare ISO
  certifications](https://www.cloudflare.com/trust-hub/compliance-resources/iso-certifications/)).
  Encryption at rest and in transit apply to both. The choice between them
  neither gains nor loses inherited provider controls.
- **CASA** (Cloud Application Security Assessment) is the [App Defense
  Alliance](https://appdefensealliance.dev/casa) assessment Google requires of
  applications holding **restricted OAuth scopes** — which Rally's Google Mail
  + Calendar connector will put in scope. It verifies the *application* against
  OWASP ASVS categories; tenant isolation and access control (ASVS V4) are
  assessed at the application layer, so the architecture's isolation story is
  what gets examined — there is no per-database checkbox, but structural
  isolation is materially easier to evidence than query-discipline isolation.
- **ISO 27001 for Rally itself** would assess Rally's ISMS, not Cloudflare's.
  The controls a per-tenant store touches are asset management (a database
  inventory that must track a dynamic fleet), access control, backup/restore
  (per-tenant PITR), secure disposal (deleting a tenant deletes a database),
  and logging.

## Sources

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 data security](https://developers.cloudflare.com/d1/reference/data-security/)
- [SQLite in Durable Objects GA changelog](https://developers.cloudflare.com/changelog/2025-04-07-sqlite-in-durable-objects-ga)
- [Zero-latency SQLite storage in every Durable Object — Cloudflare blog](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Workers for Platforms bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/bindings/)
- [workerd discussion #3564 — dynamic D1 bindings](https://github.com/cloudflare/workerd/discussions/3564)
- [One database per user with Durable Objects — Boris Tane](https://boristane.com/blog/durable-objects-database-per-user/)
- [SQLite migrations in Durable Objects — Cris O.](https://www.cris-o.com/notes/sqlite-migrations-durable-objects/)
- [App Defense Alliance — CASA](https://appdefensealliance.dev/casa)
- [Cloudflare ISO certifications](https://www.cloudflare.com/trust-hub/compliance-resources/iso-certifications/)
