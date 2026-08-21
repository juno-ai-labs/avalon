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
`migrations.rallywith.ai`, fed by two independent sources: **each
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
| `apps/migration-tracker/src/index.ts` | The Worker's three entry points: the site's `fetch`, the report-queue consumer, and the scheduled sweep. |
| `apps/migration-tracker/src/registry.ts` | `MigrationRegistry`, the single SQLite Durable Object that holds everything the tracker knows, and every query the site runs. |
| `apps/migration-tracker/src/schema.ts` | The registry's append-only schema and its own migration runner. |
| `apps/migration-tracker/src/inventory.ts` | The Cloudflare API sweep: namespaces, then paged object IDs per namespace. |
| `apps/migration-tracker/src/access.ts` | Cloudflare Access assertion verification and the email-domain policy. |
| `apps/migration-tracker/src/app.ts`, `views.ts` | The Hono application and the server-rendered site. |
| `apps/migration-tracker/wrangler.jsonc` | The deployment: the custom domain, the Access variables, the cron trigger. |
| `apps/api/wrangler.global.jsonc`, `wrangler.eu.jsonc` | The `MIGRATION_REPORT_QUEUE` producer binding in each region. |
| `scripts/check-cloudflare-queues.mjs` | The deployment preflight that reads every Wrangler file and proves each queue it declares exists, so the configuration stays the single source of truth. |

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
- **`failed`** — the migration threw. The report is sent, and *awaited*, before
  the constructor rethrows, because a failing object has no later wake to rely
  on and the throw itself would otherwise cancel the send.

A wake that would tell the tracker nothing new sends nothing. The object keeps a
one-row `_migration_report_state` table — created idempotently by the reporter,
the same way the runner bootstraps its own ledger — holding the version, status,
and build it last had accepted. A successful report is fire-and-forget through
`state.waitUntil`; a failure report is awaited instead, because the throw that
follows it breaks the object's input gate and workerd aborts the object's pending
work along with it. Either way the ledger row is written only after the queue
accepts the message, so a refused send is retried on the next wake rather than
being recorded as delivered — and the row records `failed` as readily as
`current`, so an object that recovers by rollback is not deduped into silence.

The report goes onto the `avalon-migration-reports` Queue, consumed by this
Worker. One queue serves both regions, unlike the per-region activity queues:
both regions' reports converge on the single registry object by design, so a
second queue would split the transport without splitting the destination. The
region travels in the message body, where the contract validates it. Not a
service-binding RPC, for the reasons in [`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md):
every object in the fleet converges on one registry object, which is
single-threaded and tops out near a thousand requests a second, and an
operator-driven fan-out wakes hundreds of objects at once. A queue also means the
report path has no public address, and that neither API Worker's deploy depends
on this script existing.

The consumer folds a whole batch into **one registry transaction**, so a herd
costs one write rather than one per reporter. That is what lets the registry stay
a single object.

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
class does not run the reporter           -> not_reporting
no report at all                          -> unreported
version < the component's observed head   -> behind
otherwise                                 -> current
```

`not_reporting` exists because the sweep enumerates the whole account, which is
more than the classes this Worker observes: the tracker's own `MigrationRegistry`
and the API's `CrashSymbolicatorContainer` are Durable Objects that will never
call `withMigrationReport`. Without that bucket they would sit in `unreported`
forever and make the count worthless for its actual job — spotting an API object
that should have reported and has not. `REPORTING_CLASSES` in
`apps/migration-tracker/src/registry.ts` is the list, and it has to stay in step
with the call sites of `withMigrationReport`.

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
- **A migration failure is always reported, and the send completes before the
  constructor rethrows.** Skip it and the one case the subsystem exists for is
  the one case it misses — and handing it to `waitUntil` is skipping it, because
  the throw aborts the object's pending work. Any future call site must keep the
  `await` in front of the throw.
- **A report is written only after the queue accepts the message.** Recording
  delivery optimistically turns one dropped send into an object that is silently
  unreported until its next migration.
- **Every status the CTE can produce is in `ObjectStatusSchema`.** The guard in
  `toTrackedObject` reads the enum's own options for exactly this reason: a
  status the guard does not recognise is mapped to `unreported`, so a mismatch
  would surface as a quietly wrong count rather than an error.
- **The consumer is safe against redelivery and reordering**, because Queues
  guarantee neither. Every report carries a `reportId` with a unique index
  behind it, and the object row is only updated when the arriving report's
  `occurredAt` is at least the one already stored. Drop either guard and a
  redelivered batch doubles an object's history, or a late message rewinds a
  current object to a version it has already left.
- **A message that can never be valid is acknowledged, not retried.** An
  unacknowledged failure redelivers the *whole* batch, so one malformed message
  would otherwise hold every valid report beside it hostage.
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
versions, the report history, and the operator site over both. It exposes exactly
one write surface — the two regional report queues it consumes — and reads
Cloudflare's account API with a read-only token.

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
| `MIGRATION_REPORT_QUEUE` unbound (local development, tests) | Nothing is sent. Not an error. |
| Queue send fails | Logged as `migration_report_enqueue_failed` on the API side; the object is unaffected and retries on its next wake. |
| Report refused by the producer's own contract | Logged as `migration_report_invalid`; nothing is sent. |
| Message refused by the consumer's contract | Logged as `migration_report_rejected`, acknowledged, and dropped. It could never become valid. |
| Registry write throws | The batch is left unacknowledged and redelivered, up to `max_retries`, then dead-lettered. |
| Report delivered twice | The second is ignored — `report_id` carries a unique index. |
| Reports delivered out of order | The older one updates nothing on the object row; both stay in the history. |
| Cloudflare API unavailable | The sweep records a `failed` receipt with the reason rather than throwing. Nothing is marked absent. |
| One namespace's listing fails | That namespace's objects stay `null`; the sweep is `partial` and names the namespace in `migration_inventory_sweep_completed`. |
| Namespace larger than the page cap | Listing stops at 20 pages of 1,000, the namespace is recorded as truncated, and the site shows the sweep as `partial`. |
| Access unconfigured | Every request is refused with `access_not_configured`. |
| Registry object unavailable | The site fails; reports fail and are retried by their objects. The API is unaffected. |

Numeric limits: report heartbeat **24 hours**; sweep cadence **hourly**; object
listing **20 pages × 1,000**; consumer batch **100 messages / 10 seconds** with
**5 retries** before the dead-letter queue; retained report events **20,000**,
sweep receipts **200**, per-object history shown **100**; failure message bounded
to **1,000 characters**; object list page size **1–200**, default **50**.

The overview shows a banner when the last sweep that actually **enumerated**
anything finished more than three hours ago, because a stale sweep makes the
`unreported` count meaningless. Staleness deliberately ignores failed sweeps: a
failed sweep enumerates nothing but still writes a receipt with a fresh
timestamp, so keying off the newest receipt would suppress the banner for the
whole of a Cloudflare outage. A currently failing sweep gets its own, louder
banner carrying the error.

## Testing

| Suite | Covers |
| --- | --- |
| `pnpm --filter @avalon/migration-tracker test` | The registry's SQL and derived statuses, the queue consumer's acknowledgement, dedupe, and out-of-order behavior, the sweep against a `fetch` double, Access verification against a locally generated key, and the site's routes and escaping. |
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
- A successful report is delivered in `state.waitUntil`, so those tests
  `await settle()` before asserting rather than racing it. A failure report is
  awaited by the reporter itself, and the test that proves it drives a real
  `blockConcurrencyWhile` that throws — an ordinary call cannot fail, because
  nothing breaks the input gate there.
- A `MessageBatch` cannot be constructed, so the consumer tests drive
  `createTestMessageBatch` from `test/helpers/cloudflare-test.ts`, which records
  each message's `ack()`/`retry()`. Assert on those flags — they are the
  consumer's actual contract with the runtime.
- Report fixtures need a **distinct `reportId` per report**, or the registry's
  dedupe silently collapses them and the test asserts on one row instead of two.

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

One tracker and one queue serve both regions, because **a migration report is
operational metadata about infrastructure, not workspace content**: an opaque
object identifier, a class name, a schema version, and a migration error that
describes code. There is no personal data in it and nothing a workspace owns, so
there is nothing here for a per-region boundary to protect.

That is the same class of data [`regionalization.md`](regionalization.md) already
permits on Queues and Workflows — a region plus opaque record identifiers — and
the point of the guard below is to keep it that way as the system changes, not to
gate a crossing that needs gating today. The report now literally
travels on a Queue, so it is the same crossing under the same rule rather than an
analogous one.

The queue is shared between the regions rather than split like
`avalon-eu-activities`. The split there exists because an EU activity's payload
must be handled in region. Nothing in a migration report has that property, and
the destination is one account-wide registry object either way, so a second queue
would double the resources while isolating nothing. Concretely — a Durable Object
ID, a name whose every segment is a region token, a UUID, or one of a small fixed
allowlist of role words, a class name, a component key, schema version numbers, a
build identifier, and migration error text that describes code.

The guard is `isOpaqueDurableObjectName`, applied twice: the producer drops a
name that does not match, and the tracker refuses the whole report if one reaches
it anyway. It costs nothing and it exists for the change nobody has made yet —
the day a Durable Object name grows a workspace slug or an address, this report
stops carrying it instead of quietly shipping it. Anything a future change wants
to add to a report has to clear the same bar, in this document and in the
contract.

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
is a Queue consumer, which has no public address: the only way to reach it is a
producer binding, which only a deployed Worker in this account can hold.

The tracker's Cloudflare API token is read-only and used solely to enumerate
namespaces and object IDs. Failure text and object names are the two fields that
originate outside the Worker; both are bounded, and every value the site renders
goes through `hono/html` escaping.

## Operations

- The site itself is the first stop: the overview names every component behind or
  failing, and the object page carries the failure message and the version it
  broke on.
- Workers Logs carry, on the tracker: `migration_reports_recorded` once per
  consumed batch, `migration_report_rejected` for a message the contract refused,
  and `migration_inventory_sweep_completed` /
  `migration_inventory_sweep_skipped` for the cron sweep. On the API side:
  `migration_report_enqueue_failed` means the queue refused the message — not
  that a migration failed — and `migration_report_invalid` means a producer and
  the contract have drifted. Those last two are the pair to search when reports
  have stopped arriving; the names here are the literal strings, because an
  operator pastes them into Workers Logs verbatim.
- Deploy order does not matter: reports travel on a Queue, which is a resource
  both sides bind to, so neither Worker's deploy depends on the other's script
  existing. What both require is that the queue exists first — which
  `pnpm cloudflare:resources:check` proves before any deploy runs.
  [`runbook.md`](runbook.md#the-durable-object-migration-tracker) has the
  provisioning steps.

## Performance and cost

The design's budget is one queue send per object per schema change, plus one per
object per day. A report on every wake was rejected for that reason: it would
scale with hibernation churn rather than with deploys.

The registry is a single object on purpose, and the queue is what keeps that
affordable. One Durable Object is single-threaded with a soft ceiling near a
thousand requests a second, so a synchronous hop would serialize a herd of
reporters behind each other; batching turns a batch of 100 into one transaction,
which is roughly two orders of magnitude of headroom on the same object. Every
read the site performs is a cross-cutting aggregate, so sharding would buy
throughput nothing needs and turn each read into a scatter-gather.

The steady state is not the case this is built for. Objects do not wake *because*
of a deploy, so an ordinary release produces a trickle shaped by user traffic.
The herd is any fan-out that touches many objects at once on a build whose
`APP_VERSION` has just changed: `WorkspaceScheduler` sweeping every workspace's
due schedules, watches, and wake-ups, or an operator pass walking the fleet to
seed or repair it.

## Changelog

### 2026-08-21 — The failure report survives the throw that causes it

**What changed:** `withMigrationReport` is now `async`, and the failure report is
awaited before the migration error is rethrown; the failure outcome is also
written to the object's `_migration_report_state` ledger. `SubstreamAgent`'s
store construction moved from the constructor body into its existing
`blockConcurrencyWhile` callback so that it, too, has somewhere to await. On the
tracker, a namespace whose object listing failed no longer has its `object_count`
overwritten with zero and its `last_swept_at` refreshed.

**Why:** Review found that the report this subsystem exists for was never
delivered. Four of the five call sites run the reporter inside
`blockConcurrencyWhile`; a throw out of that callback breaks the object's input
gate, and workerd aborts the object's pending work with it — so the `waitUntil`
send was entered and cancelled every time. Confirmed on real workerd before the
fix and covered by a test that drives a real gate. Fire-and-forget was the wrong
default for precisely the one case that cannot rely on a later wake.

The ledger write closes a second gap found in the same review: without it the
ledger described the last *successful* report, so a build rolled back to exactly
the one the object last reported deduped to silence and left the tracker showing
a broken object that had already recovered for up to 24 hours. It also makes the
`reported_status !== "failed"` term in the dedupe check reachable, which it never
was.

**What a future change has to respect:** the `await` in front of the rethrow is
load-bearing, and so is the fact that `apply()` still runs before any `await` —
the migration must stay in the caller's synchronous prologue. A sixth call site
that hands the failure report to `waitUntil` reintroduces the bug silently, and
`SubstreamAgent`'s two non-`readonly` fields are the price of having an `await`
available there; anything reading them must keep waiting on `initialized` first.
The rejected alternative was leaving the send to `waitUntil` and accepting the
loss, on the theory that the hourly sweep would surface the object anyway — it
would not: the sweep sees an id, never a version or an error.

### 2026-08-19 — Durable Object migration state becomes observable

**What changed:** A new Worker, `avalon-migration-tracker`, serves
`migrations.rallywith.ai` behind Cloudflare Access. Every Durable
Object in `apps/api` now reports its migration outcome — version on success,
error on failure — onto a regional Queue that the tracker consumes in batches,
and an hourly sweep enumerates the account so objects that have never woken are
visible as `unreported`.

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
- *A service-binding RPC to a `WorkerEntrypoint` on the tracker.* This was built
  first and replaced before shipping. It is the obvious shape — the report is
  one small call — and it is wrong for the load: every object in the account
  converges on one registry object, which is single-threaded with a soft ceiling
  near a thousand requests a second, so a herd serializes behind itself. Each
  reporter is a Durable Object held open on `waitUntil` for the whole wait, and
  an RPC that times out defers the report to the object's next wake, which for a
  hibernating object may be days. The herd is real: the scheduler's due-work
  fan-out, and any operator pass over the fleet, each touch hundreds of objects
  at once. Batching 100 messages into one transaction is what makes the single
  registry object affordable, and only a queue can hand a consumer a batch.
- *An HTTP ingest route with a shared secret.* Another secret to rotate in three
  places, protecting a path that would still be publicly addressable. Neither a
  queue nor a `WorkerEntrypoint` has a public address, which is a stronger
  statement than any secret on a public path.
- *Keeping RPC alongside the queue for the failure path*, so a migration that is
  about to break an object reports without waiting for a batch. Rejected as two
  code paths for one message, where the rarely-exercised one is the one that
  matters: the queue's retry and dead-letter queue are a better home for exactly
  that report, and ten seconds of batch latency is nothing to a monitor. See
  [`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md).
- *Reusing Avalon's Google OAuth for the site.* Access already supports Google as
  a login method and `email_domain` policies, so reusing the product's identity
  system would add an authorization surface without adding a capability, and
  would put the operator boundary inside the product.

**Consequences:** `avalon-migration-reports` and its dead-letter queue are hosted
resources that must exist before either Worker deploys; in exchange there is no
script-to-script deploy ordering, which an RPC binding would have imposed. It is
one queue for both regions on purpose — see **Regional impact** — so anything
that later needs per-region isolation of the transport has to justify why the
shared destination is no longer acceptable. A new Durable Object class must wrap its migration call in
`withMigrationReport` or it is invisible to the tracker — nothing enforces that
automatically. The consumer may never assume a message arrives once or in order;
the `report_id` unique index and the `occurredAt` guard on the object row are
load-bearing, not defensive. Any field added to the report has to clear the
opaque-identifier bar in **Regional impact**, and any new fixed segment in a
Durable Object name has to be added to the allowlist in
`isOpaqueDurableObjectName` or every report from that object loses its name. The
reporter creates `_migration_report_state` in every tracked object's SQLite
outside the migration history, deliberately, for the same reason the runner
bootstraps its own ledger that way.

Shipped in the pull request for `claude/do-migration-tracker-d1fkab`.
