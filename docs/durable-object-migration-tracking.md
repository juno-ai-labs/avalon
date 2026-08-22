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
`migrations.internal.rallywith.ai`, fed by two independent sources: **each
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
| `apps/migration-tracker/src/access.ts` | Cloudflare Access assertion verification: signature, issuer, audience. Authorization itself is the Access policy's. |
| `apps/migration-tracker/src/app.ts`, `views.ts` | The Hono application and the server-rendered site. |
| `apps/migration-tracker/wrangler.jsonc` | The deployment: the custom domain, the Access variables, the cron trigger. |
| `apps/api/wrangler.global.jsonc`, `wrangler.eu.jsonc` | The `MIGRATION_REPORT_QUEUE` producer binding in each region. |
| `scripts/ensure-cloudflare-queues.mjs` | The deployment preflight that reads every Wrangler file and creates each queue it declares that the account does not hold, so the configuration stays the single source of truth and no queue is made by hand. |

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

A whole namespace can leave too, when a class is deleted from the Worker. That
is a second pass rather than the same one, because the first iterates the
namespaces the sweep *returned* and a deleted namespace is not among them: after
a `complete` sweep, any namespace still carrying an older `last_sweep_id` is
stamped `retired_at`, and the objects of every retired namespace are marked
`absent`. Both guards on that pass exist to stop it retiring the fleet — the
sweep must be `complete`, and it must have found at least one namespace, since a
successful call returning an empty list would otherwise read as "the account has
no Durable Objects". A namespace that comes back — a rollback restoring a
binding — clears its retirement and its objects' absence on the next sweep.

Because retirement makes a `complete` sweep destructive, the namespace listing
has to *be* the account. It is paged, it stops on a short page or on a page that
adds nothing new — which is what an endpoint ignoring `page` returns on the
second request — and hitting the page cap downgrades the sweep to `partial`. A
namespace payload whose id cannot be read does the same rather than being
skipped: a namespace whose existence is known and whose identity is not is not
one fewer namespace.

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

A component is shown as **retired** when the namespaces its objects live in are
all retired. That is deliberately not the same test as "all of its objects are
absent": a class whose instances are created on demand can legitimately have
none alive, and only the namespace evidence separates a component that is idle
from one that has been deleted.

The link runs through the objects, which is the only place the tracker's two
halves meet — a sweep gives an object its namespace, a report gives it its
component and region — and that is what makes the marker per region. The same
classes are deployed in both Workers, so asking whether any namespace for
`SubstreamAgent` is still live would leave a component looking live in the
region it was deleted from because the other region still runs it. A retired component and a retired namespace both
stay in their tables, dimmed and sorted last — what used to be deployed is
exactly what somebody wants to see when a class disappeared and its objects went
absent on the same sweep.

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
- **A sweep that returned no namespaces at all retires nothing.** It is the same
  claim as a failed listing arriving by a different route, and acting on it
  would mark every object in the account absent at once.
- **Every route on the site is authorized, including the JSON ones.** There is no
  second credential and no exempt path; an unconfigured Access setup refuses
  every request rather than serving the fleet's shape unauthenticated.
- **Renaming a component key requires a registry migration in the same change.**
  The key is the tracker's own identifier — no Durable Object stores it — and it
  is the only join between a report and a head. Renamed on the producer alone, it
  starts a second component at head 0 and strands every object that has not woken
  under the old one, which reads as a healthy fleet rather than an error. Registry
  v3 is the worked example.
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
- The API-side suite uses **a distinct object per test**, because the
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
clock comparison silently skip the step. Namespaces carry the same stamp, and
retirement is the same comparison — a namespace still holding an older sweep id
is one this sweep did not return.

Passing the swept ids into that statement as a `NOT IN` list is the obvious
alternative and does not survive the platform: Durable Object SQL allows **100
bound parameters per query**, an account may hold up to 500 Durable Object
classes, and the statement runs inside the sweep's `transactionSync` — so
crossing that line would lose the whole sweep, not just the retirement.

The registry's own schema is at v2 and is append-only from v1 onwards, which is
now deployed: the retirement column reaches the live object as an `ALTER TABLE`
inside the constructor's `blockConcurrencyWhile`, so a statement it rejected
would take the tracker down for every read rather than just the new column.

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

The Worker does not trust the proxy's header alone. It verifies the
`Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie) against the
team's JWKS on every request, checking the signature, the issuer, and the
application audience. That keeps the protection standing if a Worker route ever
outlives its Access application — anyone can set a header, so the signature is
what establishes that Access actually spoke.

Those three are facts about the assertion's *provenance*, not a policy. **Who
may read the site is the Access application's rule, and the Worker holds no
second copy of it.** An assertion minted for this application is admitted
whatever address it carries; narrowing that is a policy change in Zero Trust,
with no variable to update and no deploy. The signed-in email is read only to
show in the page header.

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
`APP_VERSION` has just changed: an operator pass walking the fleet to seed or
repair it, or a deploy whose migration arms an immediate alarm in every object
that carries state — as WorkspaceDO migration 5's `schedule_bootstrap` entry
does.

## Changelog

### 2026-08-22 — The queue preflight creates what is missing instead of failing

**What changed:** `ensure-cloudflare-queues.mjs` (formerly
`check-cloudflare-queues.mjs`) still reads every Wrangler file and lists the
account, but a required queue the account does not hold is now created — the
same `POST …/queues` call `wrangler queues create` makes — before either
deployment proceeds. A create refused because a concurrent deployment made the
same queue is resolved by listing again rather than failing. Dead-letter queues
are still left to the platform, and nothing is ever deleted.

**Why:** The check-only form fired for real for the first time on 2026-08-22. A
release bound two new per-region queues, nobody ran the command the gate named,
and every API deployment after it failed at the preflight: five merges, one of
them carrying a D1 migration, sat undeployed until somebody read the logs. A
gate that stops and asks a human to run a command is a manual step with extra
ceremony, and the rule for this pipeline is that nothing is manual short of
break-glass. The reasoning behind the gate — the Wrangler file is the single
source of truth, and a resource it describes must not live in somebody's shell
history — is kept whole; creating from that file is the stronger form of it.

**Considered and rejected:** Creating the two queues by hand once more and
leaving the gate as it was: it would fire again on the next binding, for the
same reason. A Wrangler provisioning flag: none exists in the pinned 4.123.0.
Making the R2 preflight provision the same way: a bucket carries a jurisdiction
and holds data, so one created automatically in the wrong place is not free to
undo, and it stays a check — the one resource still created by hand.

**Consequences:** The deployment token must hold Queues Edit, which the runbook
already required for attaching consumers; a token that can only list fails the
create with `Authentication error [code: 10000]`, and the script names the
permission. A misspelled queue name in a Wrangler file now creates a stray queue
rather than failing the deploy — `SAFE_QUEUE` bounds what can be created, and
`wrangler queues list` shows the strays. A queue removed from the configuration
lingers until an operator deletes it.
### 2026-08-22 — SubstreamAgent's component is named after its class

**What changed:** the component key `SubstreamAgent` reports under is
`substream_agent_do`, renamed from `workstream`, and registry schema v3 carries
the stored history — live rows, the report log, and the per-region head — onto
the new key.

**Why:** the site was showing `workstream` and `workstream_do` next to each
other as if one were the other's namespace. They are two unrelated objects:
`workstream_do` is `WorkstreamDO`'s own control-plane schema, while `workstream`
was the object-store schema that `SubstreamAgent` applies through
`WorkstreamObjectStore`. The key predates the class — it named the history when
`WorkstreamRoom` owned it, and survived the v3 Wrangler `renamed_classes`
migration because that rename was deliberately storage-preserving. Every other
key on the site is derived from its class — snake-cased, `_do` where the class
ends in `DO` — and `workstream` was derived from nothing still in the codebase.
That it read as `workstream_do`'s parent is what made it worse than merely
stale: of the four keys, it was the one an operator was most likely to misread
during an incident.

The rule is derivation, not equality. `block_dashboard_block_agent` carries a
`block` that `BlockDashboardAgent` does not, and `substream_agent_do` takes the
`_do` suffix from its two siblings rather than from `SubstreamAgent`. Both are
recognisable from their class, which is all the key has to be.

The rename is confined to this subsystem, which is what made it worth doing at
all: no Durable Object stores its component key — `_sql_schema_migrations`
records a version, a hash, and a build — so nothing in the fleet migrates, no
receipt moves, and the Cloudflare-facing identifiers (script, class, binding,
namespace, object id) are untouched. Renaming the *class* would have been the
opposite: a `renamed_classes` tag, appended and irreversible, against the
namespace every object's storage hangs off.

The migration runner prefixes its thrown errors with the component, so this
object's failure text changes shape with the key. Failure messages already in
the report log are left exactly as they were reported: unlike the component
column, which is an identifier the tracker assigns, the message is what an
object actually said on the day it broke.

A migration alone does not finish the rename, because it runs once and the two
Workers deploy from independent workflows. The tracker's is much the smaller of
the two and usually lands first, so reports from the outgoing API build keep
arriving under `workstream` after v3 has already swept the tables — and v3
cannot catch them, since its receipt is what stops a migration running twice.
`applyReport` therefore rewrites that one key on the way in. The branch is
bounded and is meant to be deleted: once no deployed build carries the old key,
a report arriving under it is a producer nobody can account for, which is worth
seeing rather than silently renaming.

**Considered and rejected:** letting the new key simply start a second
component, on the theory that objects would migrate to it as they woke. Every
object that has reported and has not woken since the deploy would keep
`component = 'workstream'` and go on resolving against the old head, while the
new key started at 0 and showed everything that had woken as `current` against a
head no build had raised. Not the never-reported objects, though: `recordSweep`
writes no component at all, so a sweep-discovered object is `unreported` under
no key and a producer-side rename cannot strand it. Also rejected: leaving the deploy window
to an operator cleanup, which was the first shape of this change. It
under-counted the damage. Only `durable_objects` heals itself on an object's
next wake; the head row needs a manual delete, and every event written in the
window stays in the log under a key nothing else uses, where no later migration
repairs it. Making the ingestion branch bounded costs less than a permanent one
and less than the repair.

**What a future change has to respect:** the key is the tracker's own
identifier and its only join between a report and a head, so renaming one again
means a registry migration in the same change — `component_versions` is keyed
`(component, region)` and a rename without one splits the fleet silently rather
than failing. It also means a compatibility branch at ingestion for as long as
the old producer can still be deployed, because the migration cannot see what
arrives after it — and there is no third option where the objects simply re-announce
themselves: `_migration_report_state` dedupes on version, status, and build, so
a key that changes without one of those changing is silent until the 24-hour
heartbeat. v3's write to `component_versions` merges rather than updates
for the other order: if `apps/api` lands first, the row already exists, and an
`UPDATE` onto it would collide with the primary key inside the registry's own
constructor and take the tracker down.

Both halves have to be tested below the writer that normalizes the key. A test
that seeds the old key through `recordReports` proves the migration works
against a database that never held it — it passes with every one of v3's
statements removed, which is how this was caught.

### 2026-08-22 — The report tables drop the Applied column

**What changed:** the `Applied` column is gone from the report tables on both the
overview's Recent reports and an object's Report history. Nothing else moved:
the reports still carry `appliedVersions`, the registry still stores
`applied_versions`, and both JSON twins still return the list.

**Why:** it was asked for by the operator who reads this site. Nothing about the
data changed, so the column was removed from the HTML alone rather than from the
protocol or the registry schema — the list is one JSON fetch away for anyone who
needs it, and dropping the field would have made the change irreversible for the
history already recorded.

**What a future change has to respect:** `appliedVersions` is now carried but
unrendered. That is deliberate; do not read it as dead weight and delete it from
`MigrationEvent`, the queue message, or the `migration_events` row on the
strength of the HTML no longer using it.

### 2026-08-21 — A deleted class stops looking deployed

**What changed:** registry schema v2 adds `retired_at` to
`durable_object_namespaces`, and a completed sweep now retires every namespace
it did not return, marking that namespace's objects `absent`. The Components
table gained an Absent count and a retired marker, and the site's `Build` column
was renamed `Worker version`.

**Why:** absence was decided inside the loop over the namespaces a sweep
returned, so it could only ever reach an object whose *namespace* was still
there. Deleting a Durable Object class from the Worker — or deleting the script
— made its namespace vanish from the listing, and nothing visited its objects
again. They kept whatever status they held on the day the class was removed,
with a frozen sweep time; the namespace kept its row; the component kept its
row and its counts. A class that happened to be `behind` when it was retired
stayed red forever, with nothing an operator could do to clear it, which is the
worst possible failure for a dashboard whose entire job is that a red count
means act.

**The alternative that was rejected** was deleting the rows. "This class used to
exist and no longer does" is the answer to a question somebody asks during an
incident — usually while working out whether a deploy removed something it
should not have — and a deleted row cannot answer it. Objects were already
marked `absent` rather than removed for that reason; namespaces now match.

**What review changed, and why it is recorded here:** the first version of this
change shipped three defects that only a reader outside it would have caught,
all of the same family — a safe-looking claim that the platform does not
actually hold up.

- The set difference was a `NOT IN (?, ?, …)` over the swept ids. Durable Object
  SQL allows 100 bound parameters per query and an account may hold up to 500
  Durable Object classes, so it would have thrown at 100 namespaces — inside the
  sweep's `transactionSync`, losing the whole sweep, on every tick, forever.
  Namespaces now carry `last_sweep_id` and the comparison costs three
  parameters at any size.
- Component retirement was derived by asking whether any namespace for the
  *class* was live. Both regional Workers bind the same classes, so deleting one
  from a single region would have left that region's component reading live.
- `sweepInventory` made one unpaged request for the namespace list and silently
  dropped any payload it could not read, while still calling the sweep
  `complete`. Retirement is what made that dangerous rather than untidy: a first
  page mistaken for the account would retire everything behind it.

The through-line is worth keeping: **making a sweep destructive changed what
"complete" has to mean**, and the producer was not audited against the new
meaning at the same time as the consumer. A future change that widens what a
sweep is allowed to delete has to re-audit `inventory.ts` in the same breath.

**What a future change has to respect:** the two guards on the retirement pass
are the whole safety argument, because its blast radius is the entire fleet. It
runs only for a `complete` sweep, and only when that sweep found at least one
namespace. The second is not redundant: a `failed` namespace listing arrives as
`namespaces: []`, and so does a successful call that returns an empty list, and
neither is evidence that the account was emptied. Both are covered by tests that
were proved to fail without them.

`retired` on a component is deliberately decided by the namespaces, not by the
object counts. Every object being absent means only that no instance is alive
right now, which is ordinary for a class whose instances are created on demand;
the namespaces behind it all being retired means it is gone. Deriving it from
the counts instead is a one-line change that passes every test but one, and that
test — "does not call a component retired merely because its objects are gone" —
is there to catch exactly it.

The namespaces reach the component *through its objects*, on `namespace_id` from
the sweep and `component`/`region` from the report. Grouping them by class
instead reads correctly and is wrong: the same classes run in both regions, so a
class deleted from one Worker would go on looking live because the other Worker
still has it. Review caught that in the first version of this change; "retires
only the region whose namespace is gone" is the test that holds it.

The rename is UI-only. `worker_version_id` keeps its name in the schema, the
report contract, and the JSON API; only the four labels changed. `Build`
suggested a commit, and the value is `APP_VERSION` from the API's Wrangler
files — a hand-maintained version string, not a build identifier.

### 2026-08-21 — The hourly sweep starts running

**What changed:** `CLOUDFLARE_ACCOUNT_ID` is set in the tracker's
`wrangler.jsonc`, and the credentials guard in `runInventorySweep` gained tests.

**Why:** the variable shipped empty, so the guard returned on every hourly tick
and the sweep had never run in production. Half of this document's design was
therefore inert: the tracker only knew about objects that had woken and
reported — **7 of roughly 811 that exist** — and nothing on the site indicated
the rest were there.

What made it worth finding was not the count but the question it made
unanswerable. A component missing from the filter list could mean "no objects of
this class exist" or "they all exist and are dormant", and those have opposite
implications. Establishing which required querying Cloudflare by hand, which is
the work this subsystem exists to remove. Both cases were live at once:
`BlockDashboardAgent` genuinely has zero objects, while `WorkspaceScheduler` had
four that had not woken.

The account identifier belongs in checked-in configuration rather than a secret.
It is not a credential — it appears in every dashboard URL and unmasked in this
repository's deploy logs — and it sits beside `ACCESS_TEAM_DOMAIN` and
`ACCESS_APPLICATION_AUD`, which are the same kind of thing. Making it a secret
would be actively wrong: secrets and `vars` share one runtime namespace, so the
next deploy's config would overwrite it and silently restore the bug.

**What a future change has to respect:** the sweep needs *both* halves, and the
second is a Worker secret set outside this repository, so a deploy alone cannot
prove it works. The guard is the thing to be careful with: it is correct to skip
when unconfigured, and a skip and a working sweep both look like "no error" from
outside. `test/sweep.test.ts` therefore asserts on whether the network was
reached rather than on whether anything threw — an earlier version of those tests
used a throwing fetch double and passed even with the guard deleted, because
`sweepInventory` catches its own errors and turns them into a `failed` sweep.

### 2026-08-21 — The deployment check waits for a route it just created

**What changed:** the site reachability half of
`check-migration-tracker-health.mjs` retries a connection failure, six attempts
over roughly a minute, instead of asking once.

**Why:** the first production run of the tracker's deploy workflow failed on a
deploy that was entirely correct. Wrangler returns as soon as the script
uploads; the custom domain it had just provisioned was not resolvable yet, and
the check ran one second later. Everything it was built to catch, it caught —
the queue consumer was attached with the declared batch settings — and then it
reported a broken deployment because it had measured its own impatience. A
verification step that cries wolf on its own first run is worse than none: the
next real failure gets waved through as "the DNS thing again".

Two conditions count as "not settled yet": a connection failure, and a `5xx`.
They are the same phenomenon one layer apart — the name not resolving, and the
name resolving to an edge that does not have the Worker yet. Every other
response is an answer and ends the loop at once, so the `2xx` that would mean
the site is being served unauthenticated is never delayed. On exhaustion the
last `5xx` is reported as the status it served rather than as an unreachable
host, because a Worker that is throwing and a hostname that does not exist have
completely different fixes.

Each attempt carries an `AbortSignal.timeout`, which is what makes the budget a
bound rather than a wish. `fetch` without a signal does not time out on any
useful scale: a connection accepted and then never answered stays pending for
undici's default five minutes, so six attempts could run half an hour — past
this workflow's twenty-minute cap, holding a serialized concurrency group and
blocking the next release behind a check meant to take a minute. Verified
against a socket that accepts and stays silent.

**What a future change has to respect:** the backoff is linear because what is
being waited on is DNS and route propagation for a new hostname, not an
overloaded service. The bound matters in both directions: long enough that
propagation is never mistaken for breakage, short enough that a genuinely broken
deploy fails the job instead of hanging it — and the per-attempt timeout is
load-bearing for the second half of that, not decoration.

### 2026-08-21 — The operator site moves to migrations.internal.rallywith.ai

**What changed:** the tracker's custom domain gained an `internal.` label, and
the `rallywith.ai` zone gained an Advanced Certificate Manager pack covering
`*.internal.rallywith.ai` to serve it.

**Why:** the hostname was originally specified with the `internal.` label and
shipped without it, because the zone carried Universal SSL only — a Universal
pack covers the apex and one wildcard label, so `migrations.internal.` was not
in it, and the certificate would not have validated. That was a real constraint
and it made the shorter name the right call at zero cost. It stopped being the
right call once the naming was worth a per-zone add-on: `internal.` is the label
this account will keep putting operator tools behind, and buying the certificate
once is cheaper than renaming later, when the Access application is bound to the
old hostname and its AUD tag changes with it.

The Worker's own email-domain allowlist went away in the same change, and
`ACCESS_ALLOWED_EMAIL_DOMAINS` with it. It was a second copy of the Access
application's include rule, held in a different system with nothing keeping the
two in step — and the value it shipped with was the *site's* hostname rather
than the domain operators sign in with, so every authorized person would have
passed Access and then been refused by the Worker. Nothing would have caught
that except somebody failing to log in. Who may read the site is one rule and it
lives in the Access policy, where changing it needs no deploy.

Provenance is still verified here: signature, issuer, audience. That is not the
same kind of thing as a policy — it is how the Worker knows Access ran at all,
and it is what keeps the boundary standing if a route ever outlives its Access
application.

**What a future change has to respect:** the certificate is the prerequisite,
not a consequence — Wrangler creates the route and the DNS record whether or not
a certificate covers them, and the hostname then fails TLS in a way that reads as
an outage. The ACM pack is a wildcard rather than the exact hostname so the next
tool under `internal.` needs no new order. Nothing in the Worker knows the
hostname except `wrangler.jsonc`; the deployment health check reads it from
there, so a future move needs no second edit. And the sign-in domain must keep
matching the Access policy's include rule; they are two separate systems that
have to be changed together.

### 2026-08-21 — The tracker deploys itself, and proves it is wired up

**What changed:** `.github/workflows/deploy-migration-tracker.yml` deploys this
Worker on a merge to `main` touching `apps/migration-tracker/` or the shared
report contract, and `scripts/check-migration-tracker-health.mjs` verifies the
result against the live account afterwards.

**Why:** the tracker was the one Avalon surface with no deployment workflow, so
the subsystem was not live until somebody remembered to run
`pnpm deploy:migration-tracker` from a laptop. That is a bad property for a
Worker whose whole job is to be watching when a deploy goes wrong. It is a
separate workflow from `deploy-api.yml`, with its own path filter, rather than a
step inside it: putting them in one pipeline would restore in the release
process exactly the coupling the Queue was chosen to remove from the code, and
would make an urgent API release wait on a monitoring Worker.

The health check exists because a Wrangler deploy reports success once the
script uploads, which says nothing about the two things that matter. A tracker
that deploys without becoming a consumer of `avalon-migration-reports` looks
healthy from every angle while reports pile up unread until they age out — so
the check reads the consumer back from Cloudflare and compares its settings to
what `wrangler.jsonc` declares, batch size included, since a consumer silently
attached at Cloudflare's default of 10 would work and cost ten times the
registry writes this design is budgeted for. It also asserts the site refuses an
unauthenticated request, which turns the fail-closed property into something
checked on every deploy rather than reasoned about once.

**What a future change has to respect:** the expectations are derived from
`wrangler.jsonc`, never restated in the script — a second copy of the batch size
would drift and the check would start confirming itself. And the site assertion
is written as "a `2xx` is the failure", not as a list of acceptable statuses, so
that configuring Access (which changes the refusal from the Worker's `403` to
Access's `302`) does not require editing it.

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

Three smaller findings from the same round: a single malformed query parameter
dropped *every* filter on the request, so a pasted link with a bad `limit` showed
the whole unfiltered fleet under the component heading the operator asked for —
now only the rejected field is dropped. Each Durable Object's migration component
is one constant used by both the runner and the report, because two literals that
drift file an object under a component its own ledger does not use. And the
scheduled handler's `noRetry()` now says why it is correct: the sweep is a full
re-enumeration, so the next hour supersedes a lost one, and a throw still
surfaces as a failed cron invocation.

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
`migrations.internal.rallywith.ai` behind Cloudflare Access. Every Durable
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
