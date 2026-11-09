# Durable Object migration tracking

Rally runs two migrated Durable Object classes across two regional Workers,
`AgentLoopDO` and `WorkspaceDO`, and each object applies its own SQLite
migration history in its constructor. The legacy `WorkstreamDO`, `SpaceDO` and
`SidekickDO` were tracked here too until each class was deleted; Canvas and
Sidekick parents live in `WorkspaceDO`
([`hosted-conversation-parents.md`](hosted-conversation-parents.md)). Nothing in
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

It also owns the one thing the site can *do* about the answer. An object applies
its schema when it wakes, and an object nobody touches does not wake, so a class
can sit behind a deploy indefinitely with nothing wrong except that nothing has
asked it. **Force a migration** is that ask: an operator picks a class, and every
live object of it is sent one queue message that wakes it. The rest of this
document is in two halves — what the tracker observes, and what it can make
happen.

## Deleted classes

A class leaves `REPORTING_CLASSES`, the consumer's dispatcher map and its head
table in the change that deletes it. The consumer still acknowledges a queued
command that names a deleted class (`WorkstreamDO`, `SpaceDO`, `SidekickDO`,
and `AutomationDO`, `SidekickDO`'s earlier name) rather than retrying it, since
no binding can ever apply it. Tracker rows already recorded for a deleted class
keep their last labels; new sweeps and commands name only live classes.

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
| `apps/migration-tracker/src/dispatch.ts` | The fan-out: registry targets in, one command message per object out, one run row recorded. |
| `apps/api/src/durable-objects/migratable-durable-object.ts` | `MigratableDurableObject` — the base that gives every migrated class its report and its `forceMigration` RPC, and refuses to compile without a declared schema. |
| `apps/api/src/observability/tracing.ts` | Per-wake `initialize` and `schema_migrate` spans and structured duration rows; these diagnose cold starts without changing tracker delivery. |
| `apps/api/src/queues/migration-command-consumer.ts` | The regional consumer that turns one command into one `forceMigration` call, and the map of class names to namespace bindings. |
| `apps/migration-tracker/src/access.ts` | Cloudflare Access assertion verification: signature, issuer, audience. Authorization itself is the Access policy's. |
| `apps/migration-tracker/src/app.ts`, `views.ts` | The Hono application and the server-rendered site. |
| `apps/migration-tracker/wrangler.jsonc` | The deployment: the custom domain, the Access variables, the cron trigger, and the two regional command-queue producer bindings. |
| `scripts/ensure-cloudflare-queues.mjs` | The deployment preflight that reads every Wrangler file and creates each queue it declares that the account does not hold, so the configuration stays the single source of truth and no queue is made by hand. |
| `scripts/force-substream-agent-migrations.mjs` | The explicit one-off fleet wake for `AgentLoopDO`: inventories stored IDs, classifies their encoded jurisdiction, sends only region-addressable IDs through the existing command queues, and verifies queue drain without a new dead letter. |
| `scripts/substream-agent-jurisdiction-probe/` | A remote-development-only Worker that parses enumerated IDs through unrestricted external bindings and returns their encoded jurisdiction without opening an object. |

### The report

`withMigrationReport` wraps the migration call in each of the two Durable Object
constructors. It reads the object's version from the runner's own
`_sql_schema_migrations` ledger before and after the call, so it works
identically at the sites that call the runner directly and at
`AgentLoopDO`, which reaches it through `WorkstreamObjectStore`'s constructor.

Three outcomes reach the tracker:

- **`applied`** — this wake ran migration SQL. The report carries the versions it
  applied and the version the object now sits at.
- **`current`** — nothing ran, and the tracker had not been told this version by
  this build, or the 24-hour heartbeat came due.
- **`failed`** — the migration threw. The report is sent, and *awaited*, before
  the constructor rethrows, because a failing object has no later wake to rely
  on and the throw itself would otherwise cancel the send.

A migration implementation-hash disagreement is deliberately not a fourth
failure outcome. The shared runner emits a structured
`durable_object_schema_hash_mismatch` warning to regional Workers Logs and
continues, so the tracker records the ordinary `current` or `applied` outcome.
The warning preserves the recorded and current fingerprints for diagnosis; an
actual migration SQL failure still reaches the tracker as `failed`.

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
Worker. One queue serves configured deployments, unlike the per-region activity queues:
configured deployments' reports converge on the single registry object by design, so a
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

Tracker dedupe does not make an unchanged migration wake invisible to
operations. Every `withMigrationReport` call is nested in
`durable_object.schema_migrate` and emits a
`durable_object_schema_migration` Workers Log row, whether or not the outcome is
new enough to enqueue. The two migratable classes also route their complete
constructor input gate through `durable_object.initialize`, with a matching
`durable_object_initialization` row. These are latency diagnostics, not fleet
state: they stay in regional Worker traces/logs and never update the registry.
The workerd clock does not advance through synchronous execution, so `0 ms`
means no observable clock advance rather than proof that no SQL ran.

### The sweep

Reports only ever describe objects that woke up. An hourly cron trigger closes
that gap by enumerating the account through Cloudflare's API — one call for the
Durable Object namespaces, then a paged call per namespace for the object IDs it
holds. Cloudflare returns `hasStoredData` with every ID. An ID with stored data
and no report is `unreported`; an ID Cloudflare still enumerates without stored
data is `empty`. Both remain queryable, but only the first is a live migration
target.

The storage flag is required input, even though Cloudflare's generated API type
marks it optional. A payload that omits it makes that namespace listing fail and
the sweep partial. Missing is not false: silently accepting an API shape change
would move the fleet to `empty`, zero the actionable counts, and make forced
migrations report that nothing matched.

The sweep deliberately does **not** ask each object for its version. A binding
can address another script's class, so it could — and it would wake every
hibernating object in the account every hour, making the monitor the largest
single source of Durable Object duration in the account.

An object that a *complete* namespace listing no longer contains is marked
`absent`. That is distinct from `empty`: an empty identity was returned by the
API, while an absent identity was not. A listing that was truncated at the page
cap, or that failed, marks nothing: it says nothing about the objects it did not
reach.

The inventory observation and reports have an explicit time fence. Each object
is stamped when the API page carrying it finishes loading, not later when the
whole account sweep is committed. A report newer than that observation proves
that the identity woke and owns storage again, so it clears `empty`. A delayed
report older than the observation is retained in the event history but cannot
contradict the later `hasStoredData=false` fact. Equal timestamps favor the
inventory observation, the only one that directly inspected storage.

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

### Forcing a migration

The tracker's two sources answer *where every object is*. This answers the
question that follows: **the objects behind the build have not been asked.**

A Durable Object's schema runs in its constructor and nowhere else, so
"migrating" an object is exactly "waking it". There is no bulk operation to
reach for and no way to migrate an object without constructing it. That makes
the work inherently per instance, and it is why the mechanism looks the way it
does.

The class an operator names is checked against the list of classes the API
Worker actually holds a dispatcher for, in `MigrationRunRequestSchema` and again
in the registry query behind it. The page's own list of classes is a rendering
of what is forceable, not a constraint on it — both writes take a class name
from a request body, so a JSON caller or a hand-edited form reaches the schema
directly. Without that check a class like `CrashSymbolicatorContainer`, which
the sweep enumerates and whose region resolves like any other, would be fanned
out in full, retried five times per object, and dead-lettered, while the run row
recorded it as dispatched — filling the queue this system uses as its monitoring
signal with messages that were never going to work.

An operator picks a class on `/migrations`, optionally narrowed to one region.
The tracker asks the registry for every **live** object of that class — `empty`
and `absent` identities are excluded, because addressing either would create
the storage the migration is supposed to update — and writes one message per
object onto that region's command queue, in `sendBatch` groups of a hundred.
The region's own API Worker consumes it, resolves the object by ID, and calls
`forceMigration` on it.

Three deliberate choices, in the order they matter:

- **Split per region, unlike the report queue.** A queue has exactly one
  consumer, and the consumer here *must* be the region's own Worker. That is the
  decisive test in [`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md), and
  it lands the opposite way to the reports, which converge on one registry
  object and therefore share one queue. Same document, same test, different
  answer, because the destination differs.

- **RPC inside the hop.** The consumer calls `forceMigration` and reads the
  answer — the version the object ended on, and whether its receipt was
  accepted — so it can log an object that came back below the version *this
  deployment* ships as a warning rather than a success. A queue per hop, RPC
  inside the hop, is the shape
  [`access-revocation.md`](access-revocation.md) already uses.

`forceMigration` lives on `MigratableDurableObject`, the base every migrated
class now extends, so no class can be added that reports but cannot be reached,
or that is reachable but silently skips the report. A subclass declares its
schema once — component key, class name, migration list — and both the
constructor's report and the forced migration read it from there. Both members
are abstract, so a new Durable Object class that declares neither does not
compile.

The method itself is three lines of substance: check the command names this
object and this class, await the constructor's migration pass, and report. There
is deliberately **no second application of the runner** behind it. Re-running
migrations here would be a code path taken only by an operator, on the objects
least able to afford a surprise, and it would not be the path every other wake
takes. Waking is the migration; this method's job is to make the wake happen and
to say where it landed.

### What a forced migration does to an object that is already awake

Nothing, to its schema. The constructor runs once per isolate instantiation, so
an object already in memory does not re-run it: `migrationsReady()` is an
already-resolved promise, and the call is a report rather than a migration.

That is almost always the outcome to want, because **an awake object is normally
awake on the current build** — deploying a new Worker version cycles Durable
Object isolates, so anything running now constructed after the deploy and
applied that build's migrations on the way up. The forced report is then exactly
what it claims to be: the receipt that this object was reached and is current.

The case that survives is an object still running the *previous* build while a
release propagates. It reports `current` at the old version, and its
`latestVersion` comes from the old build too, so the two agree and the
consumer's `migration_command_applied` warning does not fire. The registry
catches it anyway, because the component head it compares against is the highest
version seen *anywhere* in that region and is monotonic — so the object shows as
`behind` on the site. What the run row cannot say is that this particular object
did not move; it counts messages accepted, not objects advanced. Running the
class again once the release has settled is the remedy, and the `behind` count
on the overview is what says whether it is still needed.

**`ctx.abort()` is the obvious way to close that gap and is deliberately not
used.** It would evict the object and guarantee a fresh constructor, at the cost
of dropping its live sockets and in-memory state — a product-visible outage
inflicted in service of a monitor, on every object in the class, including the
ones that were already current. The whole subsystem's first invariant is that
reporting cannot break an object; a repair that can is worse.

That report is sent **unconditionally**, which is the one place the reporter's
dedupe is deliberately bypassed. An ordinary wake on an unchanged version says
nothing, and that is right — it is what keeps the fleet's traffic proportional
to deploys rather than to hibernation churn. But an operator forcing a class is
asking to be told where every object stands, and the objects that were already
current are precisely the ones whose silence is least informative. The forced
report is the receipt that this object was reached.

### What a run records

The dispatch is fire-and-forget from the tracker's side, so the run row is the
only thing that can say it happened before the reports start arriving. It holds
what was asked for, who asked, how many objects matched, how many messages the
queue actually accepted, and two numbers that exist because they come apart from
each other:

- **`unroutable`** — matched objects the command could not be addressed to, for
  either of two disjoint reasons. Most often the *region* could not be resolved:
  a command picks a queue by region, and the region an object *reports* is the
  one thing an unreported object does not have, so the script name from the
  sweep resolves it instead through `REGION_BY_SCRIPT_NAME` and an object with
  neither has nowhere to go. The other is a region whose command queue this
  deployment holds no binding for at all, which the page also names in a banner.
  One number covers both because the operator's remedy is the same — the object
  was not reached — and it is counted rather than dropped.
- **`truncated`** — the class holds more live objects than one run dispatches.
  The cap is 5,000, which is an order of magnitude above the largest class in
  this account, so in practice it caps nothing. It exists so that an operator who
  picks the wrong class cannot cold-start the entire account from one form, and
  it is recorded rather than silent because a cap nobody sees reads as "this
  covered the class".

  Running a capped class again **continues** rather than repeating itself,
  because targets are selected least-recently-heard-from first and a forced
  object reports as it wakes — so the objects a run reached sort to the back of
  the next one. Ordering by object ID alone would be equally deterministic and
  would leave the tail of an oversized class permanently unreachable while the
  page told the operator to try again. The reports are what advance it, so two
  runs back to back, before any report lands, will re-pick the same slice.

A dispatch that throws partway is recorded too, with the count that actually
landed. That is the same rule the reporter follows on the other side: nothing is
counted as delivered until the queue has taken it.

### What the site shows

The two sources join on the Durable Object ID, which is the only identifier both
produce. Each object then resolves to one status, computed in SQL so that the
filter, the count, and the page can never disagree:

```text
absent_since set                                                -> absent
latest sweep found no stored data, with no newer object report  -> empty
last report was a failure                                       -> failed
class does not run the reporter                                 -> not_reporting
no report at all                                                -> unreported
version < the component's observed head                         -> behind
otherwise                                                       -> current
```

`not_reporting` exists because the sweep enumerates the whole account, which is
more than the classes this Worker observes: the tracker's own `MigrationRegistry`
and the API's `CrashSymbolicatorContainer` are Durable Objects that will never
call `withMigrationReport`. Without that bucket they would sit in `unreported`
forever and make the count worthless for its actual job — spotting an API object
that should have reported and has not. `REPORTING_CLASSES` in
`apps/migration-tracker/src/protocol.ts` is the list, and it has to stay in step
with the call sites of `withMigrationReport`. It is also what a forced run is
allowed to name, which is why it sits in the protocol rather than beside the
queries: the request schema and the registry both read it.

A component is shown as **retired** when the namespaces its objects live in are
all retired. That is deliberately not the same test as "all of its objects are
absent": a class whose instances are created on demand can legitimately have
none alive, and only the namespace evidence separates a component that is idle
from one that has been deleted.

The link runs through the objects, which is the only place the tracker's two
halves meet — a sweep gives an object its namespace, a report gives it its
component and region — and that is what makes the marker per region. The same
classes are deployed in both Workers, so asking whether any namespace for
`AgentLoopDO` is still live would leave a component looking live in the
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
  the migration runner and the structured logger are deliberate copies. The
  forced-migration command travels the same way the report does: through a
  contract in `packages/contracts` that both sides parse, never a shared type.
- **Every migrated Durable Object class extends `MigratableDurableObject`.** The
  report and the `forceMigration` RPC come from there and from nowhere else, and
  both of its members are abstract, so a class that opts out of either does not
  compile. Adding a class means adding it to that base, to `REPORTING_CLASSES`
  in the tracker's protocol, and to the consumer's dispatcher map — the last of
  those is what decides whether a command naming it can be applied at all.
- **A forced migration always reports, even when nothing changed.** It is the
  operator's receipt that this object was reached, and the objects that were
  already current are exactly the ones whose silence says nothing. This is the
  one place the reporter's dedupe is bypassed, and it is bypassed deliberately.
- **A forced migration never applies the runner a second time.** Waking is the
  migration. A second application would be a code path taken only by an
  operator, on the objects least able to afford one.
- **A command is applied by the region that owns the object, or not at all.**
  The consumer drops a command carrying the other region's name rather than
  rerouting it, which is the same no-Global-fallback rule every split queue
  follows.
- **A run can only name a class the API Worker can migrate.** Enforced by the
  request schema and again by the registry query, because the page's class list
  is not a constraint on either write. Dispatching a class with no dispatcher
  fills the dead-letter queue with messages that can never succeed, which
  degrades the one monitoring signal this system has.
- **A capped run continues where the last one stopped.** Targets are ordered
  least-recently-heard-from first, so the objects a run reached sort to the back
  of the next. A deterministic order that does not advance would leave the tail
  of an oversized class unreachable while the page invited a retry.
- **An `empty` or `absent` object is never a target.** Addressing either would
  create storage instead of migrating anything: the former is still enumerated
  without data, while the latter is no longer enumerated at all.
- **A run records what the queue accepted, not what was intended**, and says so
  when it was capped. A cap nobody can see reads as "this covered the class".

## Boundary

The tracker owns the inventory of Durable Objects, their reported schema
versions, the report history, and the operator site over both. It exposes exactly
one write surface — the two regional report queues it consumes — and reads
Cloudflare's account API with a read-only token.

`apps/api` still owns migrations themselves. The tracker does not apply one, does
not repair an object, and holds no binding to any object it tracks — what it can
do is *ask*, by writing a message onto a queue the region's own Worker consumes.
That is the whole of its new authority: it can cause an object to wake on the
build already deployed to it. It cannot change what that build's schema is, skip
a version, roll one back, or repair an object whose migration throws. Fixing a
failed migration is still a code change and a deploy, described in
[`runbook.md`](runbook.md); the schemas themselves are owned by
[`workstream-durable-object.md`](workstream-durable-object.md) and
[`data-model.md`](data-model.md).

The tracker holds no workspace product data: no messages, no names, no member
identities. The one identity it stores is the Access email of the operator who
started a run, and that is a Rally operator's address rather than anything a
workspace owns. It is not a general telemetry sink —
[`telemetry.md`](telemetry.md) owns that — and adding a product signal to a
report is out of scope by design.

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
| An object payload omits its ID or `hasStoredData` | That namespace listing fails visibly, its prior objects and counts remain unchanged, and the sweep is `partial`; missing never becomes absence or `false`. |
| Cloudflare keeps listing an ID after its storage is cleared | The latest `hasStoredData=false` observation makes it `empty`. It stays in history but leaves live totals and forced-migration targets. |
| Storage is cleared after a failed migration report | `empty` supersedes `failed`: the historical event remains, but the object leaves recent failures and forced-migration targets because no schema remains to repair. |
| One namespace's listing fails | That namespace's objects stay `null`; the sweep is `partial` and names the namespace in `migration_inventory_sweep_completed`. |
| Namespace larger than the page cap | Listing stops at 20 pages of 1,000, the namespace is recorded as truncated, and the site shows the sweep as `partial`. |
| Access unconfigured | Every request is refused with `access_not_configured`. |
| Registry object unavailable | The site fails; reports fail and are retried by their objects. The API is unaffected. |
| A command queue unbound on the tracker | That region cannot be reached. Its objects are counted as `unroutable` on the run and named in a banner on the page; nothing is silently dropped. |
| A command names a class the API Worker does not deploy | `migration_command_unknown_class`; the message is retried and eventually dead-lettered, because a deploy could still make it valid. The dispatcher is looked up with `Object.hasOwn`, so a name off `Object.prototype` — `constructor`, `toString` — is refused here rather than resolving to a function and being acknowledged as applied. |
| One region's command queue refuses a send | Only that region's remaining batches stop. The other region is dispatched normally, and the run's `errorMessage` names the region that failed, so the gap between `matched` and `dispatched` has an explanation. |
| A command names a class whose namespace was deleted (`WorkstreamDO`, `SpaceDO`) | Logged as `migration_command_class_deleted`, acknowledged, dropped. No deploy can bring the class back, so retrying it would only fill the dead-letter queue. |
| A command names the other region | Logged as `migration_command_misrouted`, acknowledged, dropped. Rerouting it would be a Global fallback. |
| A forced migration throws | The object reports its failure on the way past and the message is retried, then dead-lettered. The dead-letter queue's depth is the count of objects that are stuck. |
| A forced migration lands but the report queue refuses | `reported: false` on the outcome and in `migration_command_applied`. The object migrated; the tracker will not show it until its next wake. |
| The object is already awake | Its constructor does not run again, so nothing is applied; the call reports the version it is already on. Normally that version is current, because a deploy cycles isolates. An object still running the previous build reports the old version and stays `behind` on the site — the run row cannot say it did not move. |
| The dispatch throws partway through a run | The run is recorded as `failed` with the count that actually landed. The messages already accepted are still delivered. |
| A class holds more objects than one run sends | The run stops at 5,000, is marked `truncated`, and the page says so. Running it again continues. |
| The manual fleet wake cannot reach its local jurisdiction probe | Apply mode refuses to enqueue anything. A dry run without the probe reports only stored-object counts and leaves eligible/skipped counts unknown. |
| The transcript backfill sees an active writer, moved source, partial projection, or conflicting checkpoint | The object-local transaction commits nothing and no receipt. The fleet command records the object error locally and exits nonzero; it never skips the conflict or reports partial success. |
| The transcript backfill is replayed | The object recomputes its source digest, exact participant-prefix order, and checkpoint counts. It writes nothing and returns the original receipt with `applied=false`, or fails reconciliation if an owning source row changed. |

Numeric limits: report heartbeat **24 hours**; sweep cadence **hourly**; object
listing **20 pages × 1,000**; report consumer batch **100 messages / 10 seconds**
with **5 retries** before the dead-letter queue; command consumer the same;
objects per forced run **5,000**, sent in `sendBatch` groups of **100**; retained
report events **20,000**, sweep receipts **200**, runs **200**, runs shown
**25**, per-object history shown **100**; failure message bounded to **1,000
characters**; object list page size **1–200**, default **50**.

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
| `pnpm --filter @rally/migration-tracker test` | The registry's SQL and derived statuses, including stored/unreported versus enumerated/empty identities, status filtering and precedence, per-object observation fencing, equal and stale report timestamps, immutable inventory facts with newer effective liveness, failed-listing count retention, the v5 listing-stamp upgrade, empty identities being excluded from both forceable-component counts and migration targets, malformed Cloudflare object payloads failing visibly, and the UI's separate Stored/IDs counts and empty-object explanation even when report history exists. It also covers the queue consumer's acknowledgement, dedupe, and out-of-order behavior, the sweep against a `fetch` double, Access verification against a locally generated key, and the site's routes and escaping. `dispatch.test.ts` covers the fan-out against the real registry and queue doubles: routing by script name, per-region grouping, an unbound region, a send that fails partway, the 100-message batch, and the run cap. |
| `pnpm --filter @rally/api test:workers` (`test-workers/migration-reporting.test.ts`) | The reporter, in workerd against real Durable Object storage: first report, silence on an unchanged wake, a new report after a build change, applied versions, the failure path, retry after refusal, and the two "cannot break the object" cases. |
| `pnpm --filter @rally/api test:workers` (`test-workers/forced-migration.test.ts`) | `forceMigration` through a real Durable Object stub, its two identity guards, the unconditional report, and the consumer's ack/retry contract. |
| `pnpm --filter @rally/contracts test` | The report contract, the command contract, the opaque-name guard, and the queue-name predicates. |
| `node --test scripts/force-substream-agent-migrations.test.mjs` | Dry-run safety, stored-object filtering, jurisdiction filtering, 100-message queue batches, queue drain, DLQ growth, and ambiguous resource discovery. |
| `pnpm --filter @rally/api test:workers` (`test-workers/workstream-transcript-runtime.test.ts`) | The production object RPC against real workerd SQLite, including a real PITR bookmark, atomic projection receipt, and idempotent reconciliation. |

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
- **A throw crossing an RPC boundary is delivered twice under the workers pool**
  — once to the caller and once as an uncaught rejection inside the object — and
  the second fails the run on an error the production consumer catches and
  retries. `forceMigration`'s guards are therefore driven through
  `runInDurableObject` on the instance. What is under test there is the guard,
  not the transport.
- **The report queue is deliberately unbound in `wrangler.test.jsonc`.** Binding
  it would make every object's constructor write its own report ledger row
  before a test's first assertion, so the reporter suite's "first wake" cases
  would silently stop being first wakes. The forced-report tests inject a queue
  double into the context instead.

## Data model

Six tables in the `MigrationRegistry` object, all `STRICT`:
`durable_objects` (one row per object, keyed by Durable Object ID, with
nullable columns because either source may arrive first), `migration_events`
(the append-only report log), `component_versions` (the observed head per
component and region), `durable_object_namespaces`, `inventory_sweeps`
(one receipt per sweep, whose row id stamps the objects that sweep saw), and
`migration_runs` (one row per forced run, added in v4).

`migration_runs` exists because the dispatch is otherwise invisible. The
objects report their own state afterwards, which is what the rest of the site
renders — but those reports are indistinguishable from ordinary traffic, so
without a run row an operator cannot tell a run that dispatched nine hundred
messages from one that matched nothing. `matched` and `dispatched` are separate
columns because they come apart in two ways that both need to be visible: an
object with no resolvable region is matched and never dispatched, and a run over
a class larger than the cap stops early.

`durable_objects.has_stored_data` is the latest immutable inventory fact, not a
second source of migration state. A swept `false` resolves to `empty`. A later
object report makes the effective read projection stored, because waking and
reporting proves storage exists, but it does not rewrite what the sweep saw; a
Queue-delayed report whose `occurredAt` precedes the observation does neither.
Report-only rows are treated as stored until their first inventory observation,
because producing a migration report itself required the object to wake and
apply its SQLite ledger.

The namespace table shows both counts Cloudflare exposes operationally: `IDs`
is every identity in the latest successful listing, while `Stored` is the
subset from that same listing whose `hasStoredData` flag was true. The latter is
the useful live-storage count; the former explains why cleared identities can
remain visible in Cloudflare inventory. Namespace discovery and successful
object listing have separate receipt stamps: a failed listing proves the
namespace still exists but must leave both counts paired to the prior successful
listing.

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

The registry's own schema is at v5 and is append-only from v1 onwards, which is
now deployed: every later version reaches the live object inside the
constructor's `blockConcurrencyWhile` — v2's retirement column as an
`ALTER TABLE`, v3's component rename as three `UPDATE`s, v4's run log as a
`CREATE TABLE`, and v5's successful-listing stamp as an `ALTER TABLE` plus
backfill — so a statement any of them rejected would take the tracker down for
every read rather than only for the thing it added.

## Regional impact

One tracker and one queue serve configured deployments, because **a migration report is
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

A command carries less than a report does: a class name, an object ID, an opaque
object name, a region, and two UUIDs the tracker minted. It clears the same bar
through the same guard, and the same review gate applies — the day a Durable
Object name grows a legible field, this stops carrying it.

The guard is `isOpaqueDurableObjectName`, applied twice: the producer drops a
name that does not match, and the tracker refuses the whole report if one reaches
it anyway. It costs nothing and it exists for the change nobody has made yet —
the day a Durable Object name grows a workspace slug or an address, this report
stops carrying it instead of quietly shipping it. Anything a future change wants
to add to a report has to clear the same bar, in this document and in the
contract.

## Security and trust model

The site sits behind **Cloudflare Access**, configured with Google as the login
method and an `email_domain` policy for Rally's Workspace domain — both of which
Access supports directly, which is why the tracker does not reuse Rally's own
Google OAuth. Reusing it would mint operator sessions out of the product's user
identity system and leave any account that can sign in to Rally one
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
producer binding, which only a deployed Worker in this account can hold. The
command egress is the mirror of that: the tracker writes to a queue, and only a
Worker in this account holds the consumer, so a forced migration has no public
address either.

**The two writes carry an origin check on top of Access.** Access is
authentication, not intent: an operator's session cookie travels with a form
another site submits, so the assertion on such a request is genuine and proves
the wrong thing. `POST /migrations` and `POST /api/migrations` refuse a request
whose `Origin` header names another site. The header is checked when present
rather than required, because `Origin` is a browser header and its absence is
what a script has — a browser sends it on every cross-origin `POST`, which is
the case this exists to catch, while a `curl` against the JSON twin is not a
confused deputy. Every read stays as it was; there is nothing to protect a `GET`
from.

Who may force a migration is still the Access application's policy, and there is
still no second copy of it in the Worker. The Worker records the assertion's
email on the run row, which is the one place it stores an identity rather than
displaying one, and it does so because a fan-out over a production fleet is the
one action here that somebody may later need to attribute.

The tracker's Cloudflare API token is read-only and used solely to enumerate
namespaces and object IDs. Failure text and object names are the two fields that
originate outside the Worker; both are bounded, and every value the site renders
goes through `hono/html` escaping.

## Operations

- The site itself is the first stop: the overview names every component behind or
  failing, and the object page carries the failure message and the version it
  broke on.
- **A class is behind and nothing is waking it** is what the *Force a migration*
  page is for. Pick the class, leave the region on "both" unless the deploy only
  went to one, and read the run row it creates. The objects report as they wake,
  so the overview is where the result arrives — not the run row, which only says
  the ask was made. A run whose `unroutable` count is not zero has objects the
  tracker cannot address; a run marked `truncated` covered part of the class and
  should be run again.
- Workers Logs carry, on the tracker: `migration_reports_recorded` once per
  consumed batch, `migration_report_rejected` for a message the contract refused,
  `migration_run_dispatched` once per forced run, and
  `migration_inventory_sweep_completed` /
  `migration_inventory_sweep_skipped` for the cron sweep. On the API side:
  `migration_command_applied` once per forced object — a `warn` when the object
  came back below the build's head — plus `migration_command_failed`,
  `migration_command_misrouted`, and `migration_command_invalid`. On the API
  side also:
  `migration_report_enqueue_failed` means the queue refused the message — not
  that a migration failed — and `migration_report_invalid` means a producer and
  the contract have drifted. Those last two are the pair to search when reports
  have stopped arriving; the names here are the literal strings, because an
  operator pastes them into Workers Logs verbatim.
- Deploy order does not matter: reports travel on a Queue, which is a resource
  both sides bind to, so neither Worker's deploy depends on the other's script
  existing. What both require is that the queue exists first — which
  the deployment preflight creates if it is absent.
  [`runbook.md`](runbook.md#the-durable-object-migration-tracker) has the
  provisioning steps.
- The explicit `AgentLoopDO` fleet wake is for a coordinated release that
  needs every currently addressable object constructed immediately rather than
  waiting for ordinary traffic. Start its local jurisdiction classifier in one
  terminal, using credentials from a trusted checkout rather than copying them:

  ```bash
  pnpm exec dotenv -e <credential-repo>/.env.local -- \
    pnpm migrate:substream-agents:probe
  ```

  In another terminal, inventory first and then apply exactly the inventory the
  probe says each regional binding can address:

  ```bash
  pnpm exec dotenv -e <credential-repo>/.env.local -- \
    pnpm migrate:substream-agents -- \
      --jurisdiction-probe-url=http://localhost:8790

  pnpm exec dotenv -e <credential-repo>/.env.local -- \
    pnpm migrate:substream-agents -- --apply \
      --jurisdiction-probe-url=http://localhost:8790
  ```

  The probe is a Wrangler remote preview, not a deployed production Worker. In
  its default classifier mode it parses IDs only and never opens an object.
  Stop it after the apply reports both command queues drained. The apply fails
  if either DLQ grows from its starting depth. This operation runs object-local
  schema migrations only.

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
`APP_VERSION` has just changed: a deploy whose migration arms an immediate alarm
in every object that carries state — as WorkspaceDO migration 5's
`schedule_bootstrap` entry does — or, now, an operator pressing the button.

A forced run is that herd on purpose, and the arithmetic is what makes it
affordable. The largest class in this account is in the hundreds of objects, and
the ceiling is 5,000 messages a second per queue, so the queue is nowhere near
the constraint; what the run actually costs is one Durable Object cold start per
object, taken 100 at a time by a consumer with 10 seconds of batch window in
front of it. Those objects then report, which is a second fan-out into the
report queue — bounded by the same object count, and folded by that consumer
into one registry transaction per batch. A run over the whole fleet is therefore
a few tens of registry writes, not a few hundred.

The run cap of 5,000 is not a capacity estimate; it is a guard on the blast
radius of a misclick. It sits an order of magnitude above the largest class, so
it does not shape the cost of any run somebody means to make.

## Changelog

### 2026-11-07 — `SubstreamAgent` is tracked as `AgentLoopDO`

**What changed:** The conversation class was renamed `AgentLoopDO` (Wrangler
tag v15). `REPORTING_CLASSES`, the API's forced-migration dispatchers and heads
name it; registry migration v6 rewrites `class_name` from `SubstreamAgent` in
the live rows, the report log, the heads, the namespaces and the run log; a
report still carrying the old class name is filed under the new one
(`RENAMED_CLASS_FROM`), and a forced-migration command queued under it is
dispatched to the renamed class (`RENAMED_MIGRATION_CLASSES`). The component
key stays `substream_agent_do`.

**Why:** The Canvases and Sidekicks decision to rename the class. The two
Workers deploy independently, so for a while the outgoing API build reports
under the old name and an older tracker may queue commands under it; without
the translations those reports would refile objects under a second class and
those commands would dead-letter as unknown, filling the queue this platform
reads as its signal for stuck migrations.

**Considered and rejected:** The Sidekick rename's staged dual-export release:
it existed because that class's objects were moved under a compatibility
export; this rename is one `renamed_classes` tag on one namespace, and the
translations cover the overlap. Renaming the component key: the schema did not
change, so its history should not split.

**Consequences:** Delete both translations, and their tests, once no deployed
build of either Worker carries the old name. This section heading was missing;
the entries below it were already the changelog.

Shipped in juno-ai-labs/avalon#1490.

### 2026-10-06 — SidekickDO leaves the tracked fleet

**What changed:** `SidekickDO` and `AutomationDO` were removed from
`REPORTING_CLASSES`, the migration-command dispatcher map and its head table.
The consumer acknowledges a queued command for either name as a deleted class.
The registry's guard that kept a `SidekickDO` label from reverting to
`AutomationDO` is gone: no live object reports either name.

**Why:** Every Sidekick now lives in its Organization's `WorkspaceDO`, and the
class was deleted with Wrangler tag `v13`
([`hosted-conversation-parents.md`](hosted-conversation-parents.md)). Keeping
the class listed would park every one of its objects in `unreported`.

**Considered and rejected:** Keeping the rename guard for late reports. A report
can only come from a live object, and the class has none.

**Consequences:** Historical rows may still name either class. Deleting the
namespace is irreversible; rollback cannot restore its objects.

### 2026-09-21 — Hash drift warns without becoming fleet failure

**What changed:** Implementation-hash disagreement is now a regional structured
console warning rather than a thrown migration failure. The tracker records the
object's otherwise successful current or applied outcome.

**Why:** A comment-only edit changed a receipt without changing the usable
schema and took every existing live artifact page offline. The tracker made the
failure observable, but observability did not justify denying every request to
the object.

**Considered and rejected:** Adding hash warnings to the tracker contract. The
regional warning already carries both hashes and the tracker is the source of
fleet migration state, not a second log store. Keeping the throw would preserve
a red fleet state by preserving the user outage that created it.

**Consequences:** Operators investigate hash drift in Workers Logs. Tracker
failures now represent concrete migration or initialization failures; receipt
drift alone cannot make an object unavailable.

### 2026-09-19 — SpaceDO joins the tracked fleet under its own component

**What changed:** `REPORTING_CLASSES`, the consumer's dispatcher map and head
table, and the regional Wrangler bindings all name `SpaceDO`. It reports
component `space_do`, applying `WORKSTREAM_DO_SCHEMA_MIGRATIONS` — the array
`workstream_do` applies — so the two components share a head.

**Why:** A Space is `WorkstreamDO` under a different role, so nothing about the
code is new — but a Durable Object namespace is bound to a class name, so a
second namespace needs a second class, and a second class that wakes is a class
this tracker has to be able to see and to force.

**Considered and rejected:** Sharing the `workstream_do` component, which would
have avoided a new rollup entirely. It puts two classes with unrelated version
histories under one component count, so the operator page would report a
component "behind" whenever the two heads differed, forever. It also empties
`forceMigration`'s class fence, which is what stops a command minted for one
class from being applied to another. Also rejected — after it had been written
— a second ledger rendering the work-stream schema's current shape in one
version, which avoided replaying three `durable_outbox` rebuilds per new Space
and charged a dual-write obligation for it: every table change in two arrays,
held together only by a Node test comparing `sqlite_master`.

**Consequences:** `MIGRATION_COMMAND_HEADS.SpaceDO` and `.WorkstreamDO` are the
same number and will stay that way; an operator reading one component "behind"
the other is reading a deployment that has not rolled out, never a ledger
somebody forgot to write. Adding the class to the dispatcher map and to
`REPORTING_CLASSES` in the same change remains manual, as it was for
`AutomationDO`; `forced-migration.test.ts` asserts the two lists agree.

### 2026-09-08 — Keep renamed current identities monotonic

Late legacy reports retain their original labels in event history but cannot
replace a current SidekickDO object or component label with AutomationDO.
Queue delivery is unordered, so accepting both names without this guard could
hide renamed objects from the operator's exact-class migration selection.
Chronology alone is insufficient for objects discovered by a namespace sweep
before their first report. Namespace sweeps remain authoritative.

### 2026-09-08 — Stage the Sidekick namespace rename with operational compatibility

Append the class rename only after the dual-export release is verified. Keep
`automation_do` schema history and object-name bytes, and translate already-queued
legacy commands so strict owner class checks do not turn the rollout into a dead
letter backlog. The tracker accepts both labels before either regional rename;
removing the old Worker export remains a separately verified third deployment.

### 2026-09-08 — Sidekick compatibility rollout

Sidekick source code currently deploys through the `AutomationDO` compatibility
export and continues reporting that deployed class to the tracker. Both regional
configs remain at v9. A later class-rename release must change tracker class
contracts, report identities, inventory grouping, and force-migration dispatch
together with the regional binding; changing only the Cloudflare class would
strand the operational migration view. Verify existing objects in configured deployments
before that release and retain the old export until verification completes.

### 2026-09-03 — AutomationDO joins the tracked fleet and AutomationAgent leaves it

**What changed:** `REPORTING_CLASSES`, the consumer's dispatcher map, and the
set of classes extending `MigratableDurableObject` all name `AutomationDO` and
no longer name `AutomationAgent`. Wrangler tag `v9` deletes the old class and
adds the new one in the same tag, so the fleet still has four migrated classes.

**Why:** The automation object was rebuilt as a conversation parent with a
fresh one-migration ledger ([`automation-lifecycle.md`](automation-lifecycle.md)).
A class with a new ledger is a new component to the tracker; carrying the old
name would have shown thirteen released versions as a head the new objects
never reach.

**Consequences:** The three lists that have to agree changed together, which is
the rule above. Historical tracker rows may still name `AutomationAgent`;
sweeps and commands enumerate only the live class. Deleting the namespace is
irreversible; rollback cannot restore its objects.

### 2026-09-03 — The retired dashboard class leaves the tracked fleet

**What changed:** `BlockDashboardAgent` was removed from the reporting catalog,
opaque-name allowlist, regional migration-command dispatch, and both production
Wrangler namespaces. The tracker now describes four live classes and three
direct migration-runner call sites plus `SubstreamAgent`.

**Why:** HyperSight and its authority were deleted. Continuing to inventory or
offer force-migration actions for the deleted class would present an absent
namespace as operational state.

**Considered and rejected:** Keeping a tombstone class in the live catalog.
Cloudflare's `deleted_classes` migration is already the durable record of the
retirement, while a live tracker entry would imply that objects could still be
woken or migrated.

**Consequences:** Historical tracker rows may still name the retired class, but
new sweeps and commands enumerate only live authorities. Deleting the namespace
is irreversible; rollback cannot restore its objects.

Shipped in #541.

### 2026-08-28 — The migration queue carries the one-shot automation cutover

**What changed:** Before deployment, the cutover script compares regional D1
workspace inventory with stored WorkspaceDO inventory and sends ordinary
WorkspaceDO migration wakes through the old Workers. After both new Workers are
healthy, the same regional queues carry typed named-workspace cutover commands.

**Why:** The new schema bootstrap must distinguish a fresh object from a legacy
object, and the destructive authority switch needs retryable per-workspace work
without a public maintenance endpoint.

**Consequences:** Any inventory mismatch, command DLQ increase, or failed health
check stops the merge deployment. Completed workspaces roll forward from their
cutover ledger and never reopen the removed tables.

### 2026-08-27 — Cleared object identities stop looking live

**What changed:** `hasStoredData=false` is now a first-class `empty` object
status. Empty identities remain inspectable but are excluded from live
component totals and forced-migration targets. The namespace inventory shows
stored objects and enumerated IDs separately, and a report may revive an empty
identity only when it is newer than the inventory observation.

**Why:** The development cleanup cleared 264 obsolete `SubstreamAgent` SQLite
databases, but Cloudflare continued enumerating their IDs with
`hasStoredData=false`. Treating every enumerated ID as live left those objects
`unreported` and eligible for a forced migration that would recreate storage.

**Considered and rejected:** Mapping cleared IDs to `absent`, because the API
still returns them; deleting their registry rows, because that loses useful
inventory history; and waiting for Cloudflare to stop enumerating them, because
the next complete hourly sweep retained them and the listing already supplies
the authoritative storage flag.

**Consequences:** Operators can distinguish historical identities from stored
objects without losing audit history. Empty and absent identities cannot be
woken by a migration run. Registry schema v5 automatically adds a distinct
successful-listing stamp; no manual data migration is required because
`has_stored_data` has been stored since v1.

### 2026-08-27 — Completed transcript operators retired after ownership transfer

**What changed:** Schema v32 consumes the verified per-object transfer state and
then removes the legacy tables, receipts, operator RPCs, package commands, and
fleet script. The jurisdiction probe returns only classification/resolution.

**Why:** These commands were intentionally single-use. Keeping callable
migration paths after their source tables disappear creates misleading and
untestable operational surface.

**Consequences:** Deployment order is the stack order: complete and verify the
v30 fleet transfer, then deploy v32. A v32 object with unverified retained source
data refuses to migrate instead of deleting it.

### 2026-08-27 — Payload ownership transfer is a second receipted fleet pass

**What changed:** The transcript fleet operator has an explicit
`--payload-transfer` mode and package command. It invokes the v30 ownership RPC,
validates message/checkpoint source counts against canonical projections, and
persists per-object bookmarks, digests, relation counts, outcomes, and errors.

**Why:** Projection backfill made old work streams readable but intentionally
did not move their owning bytes. Legacy tables cannot be retired on the strength
of a projection-only receipt.

**Considered and rejected:** Extending constructor migration SQL to hash the
complete transcript, and accepting only aggregate fleet success. Content-sized
work must be explicit, resumable per object, and auditable after partial failure.

**What a future change has to respect:** Deploy v30, run and replay the exact
regional fleet transfer, inspect representative SQLite rows, then deploy the
stacked table-retirement release. A missing/unverified receipt, active writer,
open immutable snapshot, or source movement is a hard per-object failure; it is
never permission to drop legacy owners.

### 2026-08-26 — Transcript content backfill has per-object recovery evidence

**What changed:** a second operator command uses the jurisdiction classifier to
invoke the deployed `SubstreamAgent` transcript-backfill RPC for exactly the
reviewed regional fleet. It persists each object's PITR bookmark, source and
projection counts, reconciliation result, and error to a mode-0600 local
receipt. Apply rejects inventory drift before mutation; a complete replay is the
fleet audit. Before a first-time object receipt, the RPC invokes only the
terminal-run residual-receipt phase of the existing reaper; it cannot expire or
terminalize a nonterminal root or child. A successfully repaired tool lifecycle is
part of the source subsequently hashed and projected; any repair failure aborts
that object, and receipt replay remains read-only. The probe first invokes a
separate operator cleanup that may terminalize only active rows predating v27
whose attempt, lease, heartbeat, and open-receipt fields prove no executor can
still own them. Schema v29 stores the original operator and cleanup count in the
same object-local transaction as abandonment. The protected fleet receipt keeps
that evidence even if the following backfill fails, and retry returns the same
count; any other active shape remains a hard failure.

**Why:** waking the fleet installed schema v27 but did not project existing
participant/checkpoint facts into the new canonical indexes. This is content
work and therefore cannot run as unbounded constructor SQL. The account
inventory is still the only complete object list, and its mixed-jurisdiction
shape still requires Cloudflare's own ID parser before any regional RPC.

**Considered and rejected:** using the migration-command Queue for a payload-
scanning operation, because that protocol proves schema wake rather than content
reconciliation; adding a permanent production admin endpoint, because a
one-time operation does not justify a new attack surface; and treating a
successful HTTP batch as sufficient evidence, because it would lose the
per-object rollback bookmark and partial-failure boundary.

**What a future change has to respect:** schema migration and content migration
are distinct operations. Content apply requires explicit fleet-count witnesses,
regional classification, an authoritative target set when the namespace also
contains unrelated regional objects, durable object-local atomic receipts, protected local
recovery evidence, nonzero exit on any unverified object, and a full idempotent
replay before completion. The first mutating pass may invoke only the
established terminal-run residual-receipt repair before it captures the source;
it may not bypass or weaken the subsequent quiescence fence. An object with a
still-open tool receipt or a connected transcript snapshot is ineligible; the
fleet command must record the failure and retry after settlement or
disconnection, preserving both the source digest and every client's immutable
sequence fence. An orphaned historical pending card has no future writer and is
therefore retained as `started`, not treated as live execution.
The only nonterminal cleanup is the separate pre-v27 abandonment RPC, fenced by
the schema timestamp and absence of every durable attempt/lease/heartbeat and
open receipt. It records an explicit failure reason and may never select a
current or leased run. Cleanup terminalization and its singleton receipt are one
transaction; probe and fleet receipts must preserve that cleanup outcome when a
later backfill RPC fails.

### 2026-08-26 — A manual SubstreamAgent fleet wake respects jurisdictions

**Why:** the ordered-transcript schema release needed current workstreams awake
immediately instead of eventually on traffic. The Cloudflare account inventory
is the only complete list, but its namespace listing spans jurisdictional and
legacy unrestricted IDs while the production bindings are intentionally
regional. A first production pass exposed that boundary: valid regional IDs
reached schema v27, while unrestricted legacy IDs were retried with
`idFromString called on jurisdictional subnamespace with an ID from a different
jurisdiction`. Inferring jurisdiction from ID bytes outside the runtime is not a
supported API. The preview Worker uses Cloudflare's own parser without opening
the object, which preserves residency and keeps invalid commands out of the
DLQ.

**Considered and rejected:** dispatching every namespace ID and treating the
resulting DLQ as the filter, because five retries per known-unaddressable object
turn expected inventory into an incident signal. Adding a production admin
endpoint or weakening the API Worker's jurisdictional namespace, because a
one-off schema wake does not justify a permanent surface or a residency bypass.
Using only the tracker registry, because its region comes from prior reports and
is absent for exactly the never-woken objects this operation exists to reach.

**What a future change has to respect:** the account list is not a regional
list. Apply must classify every ID with the runtime, must not wake an ID merely
to classify it, and must fail before queue sends if classification is incomplete
or malformed. Skipped legacy IDs are not migrated or rewritten; changing their
ownership is a separate data-migration decision.

### 2026-08-26 — Every migration pass and constructor gate is timed

**What changed:** `withMigrationReport` now wraps every schema pass in a custom
`durable_object.schema_migrate` span and structured timing row. The shared
`MigratableDurableObject` base owns an instrumented `blockConcurrencyWhile`
gate for the four migrated product classes, producing the encompassing
`durable_object.initialize` span and row. Tracker report dedupe and delivery are
unchanged.

**Why:** An observed 1.95-second socket-upgrade tail ended at an automatic
Durable Object binding span, but no producer measured how much was constructor
initialization or schema migration. The tracker recorded only schema state and
intentionally emitted nothing for most current-schema wakes, so it could not
answer a latency question.

**Considered and rejected:** Sending every wake to the tracker would couple
routine hibernation churn to the cross-region queue and single registry object,
undoing its deploy/build/heartbeat dedupe. A guessed constructor timeout would
change product behavior without locating the delay. Nested platform spans plus
one regional structured row per phase expose the timing without either change.

**Consequences:** A cold binding trace can separate the complete constructor
gate, its nested migration pass, and the residual platform-wake/binding time;
Workers Logs can aggregate both phases even without a retained trace. Failures
are logged and marked on the span, then rethrown unchanged. Workerd may report
`0 ms` for synchronous CPU or SQLite work because its clock is pinned, so a
zero is not an assertion that no migration work occurred.

### 2026-08-22 — The tracker can force a class through a migration

**Why:** the tracker could say a class was behind and nothing could be done
about it from here. A Durable Object applies its schema when it wakes, and an
object nobody touches does not wake, so a class could sit behind a deploy
indefinitely with nothing actually wrong — and the only way to move it was to
find each object and provoke it through the product. The site that knows which
objects are behind is the right place to ask them to catch up; it already has
the list, and the list is the hard part.

**The design decisions worth keeping:**

- **A queue, split per region, rather than the tracker calling objects.** The
  tracker holds no binding to any object it observes and could not hold one that
  reached configured deployments — a Durable Object is addressable only from a Worker that
  binds its namespace. A queue has exactly one consumer, and the consumer here
  *must* be the region's own Worker, which is the decisive test in
  [`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md) and the reason these
  are split where the report queue is shared. Same document, same test, opposite
  answer, because the destination differs. The RPC leg inside each hop is there
  because the consumer reads the version back and logs an object that came back
  still behind as a warning.
- **On the base class rather than four times over.** The alternative — adding a
  `forceMigration` method to each of the four classes — was rejected because the
  cost is not writing it four times, it is the fifth class. A class added later
  would have compiled, deployed, and been quietly unreachable, which is exactly
  the failure the tracker was built to make impossible for reporting. Both
  members are abstract, so that class does not compile now.
- **Waking is the migration; the method does not re-run the runner.** A second
  application would be a code path taken only by an operator, on the objects
  least able to afford a surprise, and it would not be the path every other wake
  takes.
- **The forced report bypasses the dedupe.** An ordinary wake on an unchanged
  version deliberately says nothing, and the objects that were already current
  are exactly the ones whose silence tells an operator nothing. The forced report
  is the receipt that the object was reached.
- **An `empty` or `absent` object is never a target.** `get()` would create
  storage for either — a migration pass that manufactures objects is worse than
  one that skips them.
- **The region a command is sent to comes from the script name when no report
  has ever named one.** This is the detail the feature turns on and it is easy
  to miss: the object an operator most wants to force is one the sweep found and
  that has never woken, and that object has no reported region at all. Routing
  on the reported region alone would have silently skipped precisely the
  population the page exists for. `REGION_BY_SCRIPT_NAME` is the map, and an
  object with neither is counted as `unroutable` and shown rather than guessed
  at.

**What review caught, and why it is recorded here:** two reviewers independently
found that `MigrationRunRequestSchema` constrained `className` to an identifier
pattern rather than to the classes that can actually be migrated, and that
`migrationTargets` applied the reporting-class filter only to the page's list.
A JSON caller could therefore fan out `CrashSymbolicatorContainer` — enumerated
by the sweep, region resolvable like any other — into a run every message of
which was going to dead-letter, with the run row recording it as dispatched. The
through-line is worth keeping: **a list rendered in a form is not a constraint on
the endpoint behind it**, and the page's own vocabulary was mistaken for the
schema's. A further finding was the same mistake in the consumer: it decided
"this object came back behind" by comparing the two version fields the outcome
carries, which are both read inside the object's isolate after a successful
migration pass and are therefore equal by construction. The branch could never
fire, and the case its own comment named — a stale isolate on the previous
build — was precisely the one it stayed silent on, because that object's head
is the old build's head too. It now compares against the consumer's own head,
which the reviewer thought unavailable and is not: the consumer runs in the same
Worker as the classes and can read their migration lists directly. A third
finding, that the capped selection never advanced, was the
same shape of error one layer down — the documentation promised a retry would
continue and the `ORDER BY` made that impossible.

**What a future change has to respect:**

- `REPORTING_CLASSES` lives in the tracker's protocol rather than beside the
  registry's queries because it is now two things at once: the classes whose
  silence means something, and the classes a run may name. Moving it back beside
  the queries puts the request schema out of reach of it.
- The target ordering is load-bearing, not cosmetic. `ORDER BY object_id` is the
  obvious deterministic choice and it silently strands the tail of any class
  larger than the cap.
- The shortfall check must compare against the *consumer's* head, never the two
  version fields the outcome carries. Those are both read inside the object's
  isolate after a successful pass, so they are equal by construction and a
  comparison between them is dead code that looks like a check. The first
  version of this shipped exactly that, and it was silent on the one case it
  named in its own comment.
- The two guards inside `forceMigration` — the class and the object ID — are not
  defence against a hostile caller; a queue has no public address. They catch a
  wiring mistake in the consumer's dispatcher map, where a class name paired
  with the wrong binding would let every ID in it parse cleanly and create empty
  objects in the wrong namespace. Cloudflare refuses an ID that belongs to a
  different namespace, which is the outer half of the same protection and is
  asserted in the suite rather than assumed.
- `REPORTING_CLASSES` in the tracker's protocol, the dispatcher map in the consumer, and
  the set of classes extending the base are three lists that have to agree. A
  class missing from the first is never offered; missing from the second, a
  command naming it is retried until it dead-letters.
- The origin check on the two writes is load-bearing and is not redundant with
  Access. Access proves who is signed in, not that they meant to submit this
  form; the cookie travels with a cross-site `POST` either way.
- The run cap is a guard on the blast radius of a misclick, not a capacity
  estimate, and `truncated` is what keeps it honest. A cap nobody can see reads
  as "this covered the class", which is the one thing a run row must never
  imply.
- An object that is already awake is reported, not migrated, and the one way to
  change that — `ctx.abort()` — is rejected rather than merely unimplemented.
  Evicting an object drops its live sockets and in-memory state, which is a
  product-visible outage inflicted on every object in the class, including the
  ones that were already current, in service of a monitor. The section above
  records what that costs and what catches the gap instead.

### 2026-08-22 — The queue preflight creates what is missing instead of failing

**What changed:** `ensure-cloudflare-queues.mjs` (formerly
`check-cloudflare-queues.mjs`) still reads every Wrangler file and lists the
account, but a required queue the account does not hold is now created — the
same `POST …/queues` call `wrangler queues create` makes — before either
deployment proceeds. A create refused for any reason other than permission is
followed by one more listing, and passes if the queue exists by then, because
the API and tracker deployments both declare `avalon-migration-reports` and can
race on it. A queue that only a producer or only a consumer names, across all
three files, is refused before anything is created. `--check` keeps the old
read-only form for `pnpm cloudflare:resources:check`. Dead-letter queues are
still left to the platform, and nothing is ever deleted.

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
undo, and it stays a check — the one preflighted resource still created by
hand; the runbook's required-resources list is the full manual set. A queue
carries no jurisdiction and the create takes a name and nothing else, so unlike
R2 no residency choice is being made here; that is the assumption to re-check
if the create API ever grows a placement field. Matching Cloudflare's
duplicate-name error code to detect the race: the code is undocumented surface,
so the create's outcome is checked instead — a permission refusal is excluded
first, because the other deployment winning the race would otherwise hide a
token that can no longer create.

**Consequences:** The deployment token must hold Queues Edit, which the runbook
already required for attaching consumers; a token that can only list fails the
create with `Authentication error [code: 10000]`, and the script names the
permission. The old gate was, by accident, the only thing proving a queue name in a Wrangler
file was a real, consumed queue: a misspelled binding would now be created and
attached, the deploy would go green, and messages would sit in a queue nothing
drains — where the dead-letter signal this platform uses as monitoring can
never fire. So the pairing is asserted on purpose, before any create, and a
future binding must name its queue on both sides. A typo that survives that
(both sides misspelled the same way) yields one stray, well-formed queue,
visible in `wrangler queues list`. A queue removed from the configuration
lingers until an operator deletes it.

Shipped in #240.

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
instead reads correctly and is wrong: the same classes run in configured deployments, so a
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

**Why:** the tracker was the one Rally surface with no deployment workflow, so
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
- *Reusing Rally's Google OAuth for the site.* Access already supports Google as
  a login method and `email_domain` policies, so reusing the product's identity
  system would add an authorization surface without adding a capability, and
  would put the operator boundary inside the product.

**Consequences:** `avalon-migration-reports` and its dead-letter queue are hosted
resources that must exist before either Worker deploys; in exchange there is no
script-to-script deploy ordering, which an RPC binding would have imposed. It is
one queue for configured deployments on purpose — see **Regional impact** — so anything
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
