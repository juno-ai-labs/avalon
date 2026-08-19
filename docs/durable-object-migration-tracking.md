# Durable Object migration tracking

Avalon runs five Durable Object classes across two regional Workers, and each
object applies its own SQLite migration history in its constructor. Nothing in
Cloudflare's account model can answer the question that follows from that:
**which objects are on which schema version, and which of them are broken?** A
Durable Object namespace can be enumerated for object IDs, but an ID carries no
version, and an object that fails its migration fails privately, inside a
constructor, on whichever isolate happened to wake it.

This document owns the subsystem that answers the question — a separate Worker,
`avalon-migration-tracker`, serving an operator site at
`migrations.internal.with-avalon.com`, fed by two independent sources: **each
object reports its own migration outcome**, and **an hourly sweep enumerates the
account** so an object that never wakes is still visible as one nobody has heard
from. Read it before changing a migration runner, adding a Durable Object class,
or touching what the tracker stores, serves, or lets in.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/durable-object-migrations.ts` | The one report contract both Workers parse against, and `isOpaqueDurableObjectName` — the guard that decides what may cross the regional boundary. |
| `apps/api/src/durable-objects/migration-reporting.ts` | `withMigrationReport`: wraps a Durable Object's migration call, keeps the object-local report ledger, and delivers the report without ever being able to break the object. |
| `apps/api/src/durable-objects/sqlite-migrations.ts` | The migration runner itself, unchanged by this subsystem. Its `_sql_schema_migrations` ledger is what a report reads. |
| `apps/migration-tracker/src/index.ts` | The Worker's three entry points: the site's `fetch`, the `MigrationReportBridge` RPC entrypoint, and the scheduled sweep. |
| `apps/migration-tracker/src/registry.ts` | `MigrationRegistry`, the single SQLite Durable Object that holds everything the tracker knows, and every query the site runs. |
| `apps/migration-tracker/src/schema.ts` | The registry's append-only schema and its own migration runner. |
| `apps/migration-tracker/src/inventory.ts` | The Cloudflare API sweep: namespaces, then paged object IDs per namespace. |
| `apps/migration-tracker/src/access.ts` | Cloudflare Access assertion verification and the email-domain policy. |
| `apps/migration-tracker/src/app.ts`, `views.ts` | The Hono application and the server-rendered site. |
| `apps/migration-tracker/wrangler.jsonc` | The deployment: the custom domain, the Access variables, the cron trigger. |
| `apps/api/wrangler.global.jsonc`, `wrangler.eu.jsonc` | The `MIGRATION_TRACKER` service binding in each region. |

## How it works

### The report

`withMigrationReport` wraps the migration call in each of the five Durable Object
constructors. It reads the object's version from the runner's own
`_sql_schema_migrations` ledger before and after the call, so it works
identically at the four sites that call the runner directly and at
`SubstreamAgent`, which reaches it through `WorkstreamObjectStore`'s constructor.

Three outcomes reach the tracker:

- **`applied`** — this wake ran migration SQL. The report carries the versions it
  applied and the version the object now sits at.
- **`current`** — nothing ran, and the tracker had not been told this version by
  this build, or the 24-hour heartbeat came due.
- **`failed`** — the migration threw. The report is sent *before* the constructor
  rethrows, because a failing object has no later wake to rely on.

A wake that would tell the tracker nothing new sends nothing. The object keeps a
one-row `_migration_report_state` table — created idempotently by the reporter,
the same way the runner bootstraps its own ledger — holding the version, status,
and build it last had accepted. Delivery is fire-and-forget through
`state.waitUntil`, and the ledger row is written only after the tracker accepts,
so a refused or unreachable delivery is retried on the next wake rather than
being recorded as delivered.

The report travels over a service binding to `MigrationReportBridge`, a
`WorkerEntrypoint`. It is not an HTTP route: an RPC entrypoint has no public
address at all, so the ingress cannot be reached from the internet, with or
without a credential.

### The sweep

Reports only ever describe objects that woke up. An hourly cron trigger closes
that gap by enumerating the account through Cloudflare's API — one call for the
Durable Object namespaces, then a paged call per namespace for the object IDs it
holds. Every ID it finds becomes a row; an ID with no report is `unreported`,
which is a first-class state rather than an absence.

The sweep deliberately does **not** ask each object for its version. A binding
can address another script's class, so it could — and it would wake every
hibernating object in the account every hour, making the monitor the largest
single source of Durable Object duration in the account.

An object that a *complete* namespace listing no longer contains is marked
`absent`. A listing that was truncated at the page cap, or that failed, marks
nothing: it says nothing about the objects it did not reach.

### What the site shows

The two sources join on the Durable Object ID, which is the only identifier both
produce. Each object then resolves to one status, computed in SQL so that the
filter, the count, and the page can never disagree:

```text
absent_since set                          -> absent
last report was a failure                 -> failed
no report at all                          -> unreported
version < the component's observed head   -> behind
otherwise                                 -> current
```

The **head** is the highest version a component has been seen running in a
region. Nothing in the account publishes it, so the tracker learns it from the
reports: the first object to run a new build raises it, and every object still
below it is `behind`. It is monotonic, so a rollback cannot retroactively
declare the fleet current.

The site is server-rendered HTML with no client bundle: an overview of the fleet
and its components, a filterable object list, and one page per object with its
full report history. Every page has a JSON twin under `/api/`.

## Invariants

- **Reporting can never break a Durable Object.** An unbound, unreachable, or
  throwing tracker leaves the object exactly as it would have been. Break this
  and a monitoring outage becomes a product outage, on every object at once.
- **A migration failure is always reported, before the constructor rethrows.**
  Skip it and the one case the subsystem exists for is the one case it misses.
- **A report is written only after the tracker accepts it.** Recording delivery
  optimistically turns one dropped RPC into an object that is silently
  unreported until its next migration.
- **A report crosses the regional boundary carrying only a region and opaque
  record identifiers.** `isOpaqueDurableObjectName` is the enforcement, and its
  allowlist of fixed name segments is the review gate: adding a role word is a
  deliberate one-line change. A name that does not match is dropped by the
  producer and refused by the tracker.
- **The component head is monotonic.** A lower `latestVersion` never lowers it,
  or a partial rollback would mark a stale fleet current.
- **A truncated or failed namespace listing marks nothing absent.** Otherwise
  the sweep erases exactly the objects a large namespace is most likely to hide.
- **Every route on the site is authorized, including the JSON ones.** There is no
  second credential and no exempt path; an unconfigured Access setup refuses
  every request rather than serving the fleet's shape unauthenticated.
- **The tracker imports nothing from `apps/api`.** A build break in the Worker
  being observed must not take down the thing that reports on it — which is why
  the migration runner and the structured logger are deliberate copies.

## Boundary

The tracker owns the inventory of Durable Objects, their reported schema
versions, the report history, and the operator site over both. It exposes
exactly one write surface, `MigrationReportBridge.report`, and reads Cloudflare's
account API with a read-only token.

`apps/api` owns migrations themselves. The tracker never applies one, never
repairs an object, and has no binding to any object it tracks — it is a
read-only observer that objects talk *to*. Fixing a failed migration is a code
change and a deploy, described in [`runbook.md`](runbook.md); the schemas
themselves are owned by
[`workstream-durable-object.md`](workstream-durable-object.md) and
[`data-model.md`](data-model.md).

The tracker holds no workspace product data: no messages, no names, no member
identities. It is not a general telemetry sink — [`telemetry.md`](telemetry.md)
owns that — and adding a product signal to a report is out of scope by design.

## Failure modes and limits

| Situation | Behavior |
| --- | --- |
| `MIGRATION_TRACKER` unbound (local development, tests) | Nothing is sent. Not an error. |
| Tracker unreachable or throwing | Logged as `migration_report_delivery_failed` on the API side; the object is unaffected and retries on its next wake. |
| Report refused by the contract | The bridge throws `migration_report_rejected`; the producer treats it as a delivery failure and logs `migration_report_invalid` if its own parse was the one that failed. |
| Cloudflare API unavailable | The sweep records a `failed` receipt with the reason rather than throwing. Nothing is marked absent. |
| One namespace's listing fails | That namespace's objects stay `null`; the sweep is `partial` and names the namespace in `migration_inventory_sweep_completed`. |
| Namespace larger than the page cap | Listing stops at 20 pages of 1,000, the namespace is recorded as truncated, and the site shows the sweep as `partial`. |
| Access unconfigured | Every request is refused with `access_not_configured`. |
| Registry object unavailable | The site fails; reports fail and are retried by their objects. The API is unaffected. |

Numeric limits: report heartbeat **24 hours**; sweep cadence **hourly**; object
listing **20 pages × 1,000**; retained report events **20,000**, sweep receipts
**200**, per-object history shown **100**; failure message bounded to **1,000
characters**; object list page size **1–200**, default **50**.

The overview shows a banner when the last sweep finished more than three hours
ago, because a stale sweep makes the `unreported` count meaningless.

## Testing

| Suite | Covers |
| --- | --- |
| `pnpm --filter @avalon/migration-tracker test` | The registry's SQL and derived statuses, the sweep against a `fetch` double, Access verification against a locally generated key, and the site's routes and escaping. |
| `pnpm --filter @avalon/api test:workers` (`test-workers/migration-reporting.test.ts`) | The reporter, in workerd against real Durable Object storage: first report, silence on an unchanged wake, a new report after a build change, applied versions, the failure path, retry after refusal, and the two "cannot break the object" cases. |
| `pnpm --filter @avalon/contracts test` | The report contract and the opaque-name guard. |

Traps:

- The whole tracker suite runs in the **workerd pool**, not node — the registry
  owns SQLite storage, and a node double would not exercise it.
- The registry is a **singleton**, so `beforeEach` clears its tables by hand.
  Adding a table means adding it to that list, or a later test inherits rows.
- The API-side suite uses **a distinct scheduler object per test**, because the
  reporter's ledger lives inside the object; sharing one would make every
  assertion depend on execution order.
- Delivery happens in `state.waitUntil`, so those tests `await settle()` before
  asserting rather than racing it.

## Data model

Five tables in the `MigrationRegistry` object, all `STRICT`:
`durable_objects` (one row per object, keyed by Durable Object ID, with
nullable columns because either source may arrive first), `migration_events`
(the append-only report log), `component_versions` (the observed head per
component and region), `durable_object_namespaces`, and `inventory_sweeps`
(one receipt per sweep, whose row id stamps the objects that sweep saw).

Absence is decided by comparing an object's `last_sweep_id` against the current
sweep's row id, not by timestamp: two sweeps inside one millisecond would make a
clock comparison silently skip the step.

## Regional impact

The tracker is one account-wide Worker, so an EU object's report reaches a store
that is not EU-resident. That is admissible only because of what the report
contains, which is the same class of data
[`regionalization.md`](regionalization.md) already permits on Queues and
Workflows: a region plus opaque record identifiers. Concretely — a Durable Object
ID, a name whose every segment is a region token, a UUID, or one of a small fixed
allowlist of role words, a class name, a component key, schema version numbers, a
build identifier, and migration error text that describes code.

The guard is `isOpaqueDurableObjectName`, applied twice: the producer drops a
name that does not match, and the tracker refuses the whole report if one reaches
it anyway. Anything a future change wants to add to a report has to clear the
same bar, in this document and in the contract.

## Security and trust model

The site sits behind **Cloudflare Access**, configured with Google as the login
method and an `email_domain` policy for Avalon's Workspace domain — both of which
Access supports directly, which is why the tracker does not reuse Avalon's own
Google OAuth. Reusing it would mint operator sessions out of the product's user
identity system and leave any account that can sign in to Avalon one
authorization bug away from the fleet's schema state.

The Worker does not trust the proxy alone. It verifies the
`Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie) against the
team's JWKS on every request, checking the signature, the issuer, and the
application audience, and then the email domain. That keeps the protection
standing if a Worker route ever outlives its Access application. The email
domain is taken from the **last** `@`, so a crafted local part cannot impersonate
an allowed domain.

The report ingress is not protected by Access at all — it does not need to be. It
is a `WorkerEntrypoint` method, reachable over a service binding and by nothing
else.

The tracker's Cloudflare API token is read-only and used solely to enumerate
namespaces and object IDs. Failure text and object names are the two fields that
originate outside the Worker; both are bounded, and every value the site renders
goes through `hono/html` escaping.

## Operations

- The site itself is the first stop: the overview names every component behind or
  failing, and the object page carries the failure message and the version it
  broke on.
- Workers Logs carry `migration_report_recorded` (at `error` level for a
  failure), `migration_inventory_sweep_completed`, and
  `migration_inventory_sweep_skipped`. On the API side,
  `migration_report_delivery_failed` means the tracker is unreachable, not that a
  migration failed.
- Deployment order matters: `avalon-migration-tracker` must exist before either
  API Worker deploys, because a service binding to a missing script fails the
  deploy. [`runbook.md`](runbook.md#the-durable-object-migration-tracker) has the
  provisioning steps.

## Performance and cost

The design's budget is one subrequest per object per schema change, plus one per
object per day. A report on every wake was rejected for that reason: it would
scale with hibernation churn rather than with deploys, and every one of those
writes lands on a single Durable Object. The sweep costs one Cloudflare API call
per namespace per hour, plus one per additional 1,000 objects.

The registry is a single object on purpose. Both writers are low-volume and every
read the site performs is a cross-cutting aggregate, so sharding would buy
throughput nothing needs and turn each read into a scatter-gather.

## Changelog

### 2026-08-19 — Durable Object migration state becomes observable

**What changed:** A new Worker, `avalon-migration-tracker`, serves
`migrations.internal.with-avalon.com` behind Cloudflare Access. Every Durable
Object in `apps/api` now reports its migration outcome — version on success,
error on failure — through a service binding, and an hourly sweep enumerates the
account so objects that have never woken are visible as `unreported`.

**Why:** Nothing could say which objects were on which schema version. The
migration runner is careful — append-only, hash-checked, transactional — but its
verdict is delivered by throwing inside a constructor on one isolate, and its
success is silent. A half-landed deploy was therefore invisible until something
downstream broke, and `component_schema_hash_mismatch` had no reader. Enumerating
the namespaces gives IDs without versions; only the object knows its version, and
only at the moment it applies one.

**Considered and rejected:**

- *Polling each object for its version.* A binding can address another script's
  class, so the tracker could ask. It would wake every hibernating object in the
  account every hour, making the monitor the account's largest source of Durable
  Object duration. Enumerate cheaply, let objects report on their own wakes, and
  treat "seen but never reported" as a real state instead.
- *Reporting on every constructor run.* Simple, and it converges instantly, but
  it scales with hibernation churn rather than with deploys, and every write
  lands on one object. The object-local ledger plus a 24-hour heartbeat gets the
  same coverage at a fraction of the traffic.
- *D1 for the tracker's store.* It has to be created, named, and pasted into the
  Wrangler file before the first deploy. This Worker's whole job is to still work
  when a deploy went wrong, and a Durable Object namespace is created by the
  deploy itself.
- *An HTTP ingest route with a shared secret.* Another secret to rotate in three
  places, protecting a path that would still be publicly addressable. A
  `WorkerEntrypoint` has no public address, which is a stronger statement than
  any secret on a public path.
- *Reusing Avalon's Google OAuth for the site.* Access already supports Google as
  a login method and `email_domain` policies, so reusing the product's identity
  system would add an authorization surface without adding a capability, and
  would put the operator boundary inside the product.

**Consequences:** Both API Workers now have a hard deploy-order dependency on
`avalon-migration-tracker`; deploying the API first fails on the missing service.
A new Durable Object class must wrap its migration call in `withMigrationReport`
or it is invisible to the tracker — nothing enforces that automatically. Any
field added to the report has to clear the opaque-identifier bar in **Regional
impact**, and any new fixed segment in a Durable Object name has to be added to
the allowlist in `isOpaqueDurableObjectName` or every report from that object
loses its name. The reporter creates `_migration_report_state` in every tracked
object's SQLite outside the migration history, deliberately, for the same reason
the runner bootstraps its own ledger that way.

Shipped in the pull request for `claude/do-migration-tracker-d1fkab`.
