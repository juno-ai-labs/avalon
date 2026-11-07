# Usage metering

Usage metering measures what each Organization spends on inference against its
plan's weekly quota. Every model call Rally makes for an Organization sends one
small usage event in the background. One queue consumer adds the events into a
ledger, a recent window in its own D1 database and the full history in R2, and
one route derives the meter members see: the percentage of this
week's quota left, and this month's overage. Nothing is charged; the overage is
shown as not billed.

The promise to the rest of the system: metering never waits on the work it
measures and never fails it. A call site sends and forgets, and a lost event is
logged with its cost. The product contract and the reasoning behind each choice
are in
[the usage quota PRD](PRDs/2026-10-03_usage-quota-metering/prd.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/usage.ts` | The single source for plans, metered activities, the `ORGANIZATION_PAYS` payer map, `UsageEvent`, the `GET /workspace/usage` response, and the week, period and overage arithmetic (`usageWeekStart`, `usagePeriod`, `deriveOrganizationUsage`). |
| `apps/api/src/services/usage-metering.ts` | `emitUsage` and `emitInferenceUsage` (the only producers), `applyUsageBatch` (the only D1 ledger writer), `readOrganizationUsage` (the only reader), `setWorkspacePlan`, `publishOrganizationUsage`, `pruneUsageEvents` and `USAGE_EVENTS_D1_RETENTION_DAYS`. |
| `apps/api/src/durable-objects/workspace-do.ts` (`publishUsage`) | Sends the meter after a plan change to every subscribed member socket as `workspace_usage` (`WorkspaceUsageEventSchema`), never a guest's, and drops a meter read before the last one sent. |
| `apps/api/src/queues/usage-consumer.ts` | The `avalon-<region>-usage` consumer: validates, rejects misrouted messages, applies the batch to D1, then sends it to the usage lakehouse, logs `usage_batch_applied`. `usageLakehouseRecord` shapes the R2 row. |
| `apps/api/src/routes/workspace.ts` | `GET /workspace/usage`, for every member role, and `PUT /workspace/plan`, for administrators (`WorkspaceService.setPlan`). |
| `apps/api/src/routes/workspace-operations.ts` | `POST /internal/workspaces/:id/plan`, the operator route Ace calls. |
| `packages/db/migrations/0118_usage_quota_metering.sql` | `workspaces.plan`, in the regional `DB`. |
| `packages/db/usage-migrations/` | `usage_events`, `usage_rollups` and `usage_plan_changes`, in `USAGE_DB` (`avalon-<region>-usage`). Applied by `pnpm --filter @rally/api db:usage:migrate` (local, part of `db:migrate`) and `db:usage:migrate:remote` (deploy). |
| `config/usage-lakehouse.json`, `config/usage-lakehouse-stream-schema.json` | The usage lakehouse: the `USAGE_LAKEHOUSE` Pipeline into the Iceberg table `avalon.usage_events` in R2, provisioned by `scripts/ensure-cloudflare-inference-lakehouse.mjs` like the other lakehouses. |
| `apps/ace/src/client/workspaces.tsx` | The plan control on Ace's workspaces tab. |
| `apps/desktop/src/renderer/lib/organization-usage.ts` | The desktop's read: `useOrganizationUsage`, `useSetOrganizationPlan`, `applyPushedOrganizationUsage`, the `usage` local-cache slice, and the formatters. `lib/workspace-socket.tsx` applies the push, marks the meter stale on every subscribe answer, and relays both to the Settings window as `usage`. |
| `apps/desktop/src/renderer/components/organization-usage.tsx` | Settings → Organization → Usage with its plan picker, and the account menu's meter (a full row right under Settings). |
| `packages/ui/src/components/primitives.tsx` (`Meter`) | The shared meter primitive and its `cmp.meter.*` tokens. |

Each call site emits next to where its cost is already known; searching for
`emitInferenceUsage` lists them. The turn-disposition classifier's JEV calls
are recorded as `turn_disposition_classifier` through the classifier
diagnostic sink, and the words a suggestion carries as `suggestion_draft`
through `runStructuredInference`; both are the Organization's, like the other
classifier and structured activities ([`conversation-suggestions.md`](conversation-suggestions.md)). Two rules keep new callers metered:
`runStructuredInference` requires an `activity`, and an agent attempt whose
turn ID carries `:compaction:` is metered as `context_compaction`.

## How it works

### Sending

A call site calls `emitInferenceUsage` with the cost in cents as the provider or
Rally's rate card reported it. It converts to micro-USD, validates the event,
and hands `USAGE_QUEUE.send` to the caller's `waitUntil`. It returns at once.
When the cost is unknown it sends nothing and logs `usage_unpriced`. When the
send fails it logs `usage_emit_failed` with the cost. A host without the
binding (local tests) skips metering.

Event IDs are stable for the work they describe, so a caller that re-runs its
own work produces the same ID: `inf:<inferenceRequestId>` for model calls,
`gen:<resourceId>` for generated media. Embedding cost is read from the raw
response by `embeddingCallCostUsd`, because the SDK's embeddings shape drops
the bring-your-own-key upstream charge.

Completion-stop JEV calls use `completion_verification`, recorded by the same
classifier diagnostic sink and Organization payer policy as the other classifiers.
The additional main-model verification turn remains ordinary agent-run usage.

### Applying

The consumer runs one batch at a time (up to 100 messages or 60 seconds). It
drops repeated event IDs within the batch and IDs already in `usage_events`,
reads each Organization's plan and creation time from `DB`, and in one
`USAGE_DB.batch()`, for each event:

- inserts it into `usage_events`, recording whether the Organization paid
  (`ORGANIZATION_PAYS` at apply time);
- only if that insert added a row (`changes() = 1`), adds its cost into the
  `usage_rollups` row for its quota week and monthly period, into
  `organization_microusd` or `rally_microusd`. A new row takes the quota of the
  plan in force at the end of its week (see [Plans](#plans)).

Then it sends the whole batch to the usage lakehouse and acks. If that send
fails the batch retries: D1 skips what it already holds, and the batch is sent
again, so R2 can hold an event twice. The consumer computes no overage.

### Retention

D1 keeps `usage_events` for `USAGE_EVENTS_D1_RETENTION_DAYS` (90) from receipt;
the scheduled tick deletes older rows. `usage_rollups` is kept for good, so the
meter never reads a pruned row. The lakehouse in R2 keeps every event: it is
the history a Stripe replay, a per-person breakdown or an older support
question reads, through Basin SQL (read-only, over its REST API; $2.50 per TB
scanned, checked 2026-10-03). Readers there deduplicate by `event_id`.

### Reading

`usage_events_sidekick_occurred` (`sidekick_id, occurred_at`, partial on
Sidekick rows) serves a Sidekick's cost over a window and one run's (the same
read narrowed by `substream_id`), for operator reads through the engineering
MCP's `run_d1_sql`.

`readOrganizationUsage` reads the workspace row and the rollups from seven days
before the current period's start (a week that straddles the boundary) to now,
and `deriveOrganizationUsage` computes:

- **Percentage left:** the current week's Organization-paid total against its
  quota, rounded down, never below 0. No rows means 100%.
- **Overage:** per week, the part of the total above the week's quota. In a
  week that crosses a period boundary the earlier period uses the quota first.
  This month's overage sums the parts whose period is the current one.

The week starts at the workspace's creation instant and repeats every 168
hours. The period runs from one monthly anniversary of that instant to the
next, clamped to the last day of a short month, in UTC.

### Plans

| Plan | Price | Weekly quota |
| --- | --- | --- |
| Starter | $100 a month | $50 |
| Growth | $250 a month | $125 |

The weekly quota is twice the monthly price, divided by four
(`INCLUDED_USAGE_MULTIPLIER`). The meter turns the warning colour below 20%
left (`LOW_QUOTA_PERCENT`). Overage is priced at cost. All three are product
decisions, set in `packages/contracts/src/usage.ts`.

Every workspace starts on Starter. An administrator changes the plan from the
picker at the top of Settings → Organization → Usage, and an operator from Ace;
both reach `setWorkspacePlan`. There is no checkout behind either yet, so a
change moves the quota and nothing is charged. `setWorkspacePlan` records the change in `usage_plan_changes` (with the plan it
replaced) and rewrites `quota_microusd` on the current week's rollups, in one
`USAGE_DB` transaction, so the meter re-prices the current week at once. Then it
writes `workspaces.plan` in `DB`; if that second write fails, the caller shows
the error and choosing again finishes it. The Settings route answers with the
meter under the new plan, which the picker writes straight into the read and
the cache.

After the response, both routes call `publishOrganizationUsage`. It reads
the meter, stamped with when the read started, and WorkspaceDO sends it to
every member socket (not a guest's) as `workspace_usage`, dropping a meter
read before the last one it sent. The desktop writes it into its read and its
cache, cancelling a read in flight, and the main window relays it to the
Settings window as the relay-only name `usage`. The push is not replayed: the
desktop marks the meter stale on every subscribe answer and relays `usage`
then too.

A new rollup row's quota is computed inside the consumer's insert from
`usage_plan_changes`: the latest change before the row's week ended, else the
plan the first later change replaced, else the plan `DB` holds. Past weeks
therefore keep the plan they had, even for an event that arrives late.

## Invariants

- **An event is added to the totals once.** Its rollup increment runs only if
  its `usage_events` insert added a row, in the same transaction, so a
  redelivery or two overlapping batches count it once without relying on
  `max_concurrency: 1`. Guard: `test/usage-metering.test.ts` and
  `test-workers/usage-ledger.test.ts` ("…two batches carrying it overlap").
- **Overage is never stored.** It is derived on read from totals and the week's
  quota. Storing a split at apply time would let queue order decide which month
  gets overage and would go stale on a plan change. Guard:
  `test/usage-metering.test.ts` ("derives the same overage whichever order…")
  and `packages/contracts/src/usage.test.ts`.
- **Metering never throws into a call site and is never awaited by one.** A
  failure would fail or slow the run it measures. Guard:
  `test/agent-inference-logging.test.ts` ("…never fails on a lost send").
- **A call with no known cost is logged as unpriced, never recorded as zero.**
  A zero would read as a free activity and understate every meter. Guard:
  `emitInferenceUsage` taking `costCents: number | undefined`, and the same test.
- **Every metered activity has a payer, and every structured call an
  activity.** `ORGANIZATION_PAYS` uses `satisfies Record<MeteredActivity,
  boolean>` and `activity` is required on `runStructuredInference`. Guard: the
  types.
- **Allowance and spend dollars never cross the wire.** The quota is opaque to
  members; the response carries a percentage and the overage only. Guard:
  `OrganizationUsageSchema`, parsed by the route.
- **D1 before the lakehouse.** A Pipelines outage must not stall the meter.
  Guard: `test/usage-metering.test.ts` ("applies the batch to D1 before the
  lakehouse…").
- **D1 keeps an event for longer than its message can be redelivered.** The
  prune keys on `received_at`, and 90 days is far above the queue's message
  retention (at most 14 days); a shorter window would let a redelivery find its
  row gone and count it twice. Guard: `test/usage-metering.test.ts` ("deletes
  rows received before the 90-day window…").
- **A plan change reaches every connected member without a request, and no
  guest.** Guard:
  `test/usage-metering.test.ts` and `test/workspace-operations.test.ts`
  (each route publishes the re-priced meter),
  `test-workers/durable-object-runtime.test.ts` ("sends the meter after a plan
  change to every member socket…") and the desktop's
  `lib/workspace-socket.test.tsx`.
- **The last plan wins whatever order the pushes arrive in.** WorkspaceDO
  drops a meter read before the last one it sent. Guard: the same
  `test-workers` test.
- **A new rollup row's quota comes from `usage_plan_changes` at insert time,
  never from the batch's earlier read of `DB`.** D1 runs one transaction at a
  time, so a plan change either commits first and the insert reads it, or
  commits after and rewrites the row. Guard: `test/usage-metering.test.ts`
  ("rollup quota") and `test/workspace-operations.test.ts`.
- **The ledger stays out of `DB`.** D1's 10 GB limit is per database, so a full
  ledger in `DB` would stop every regional write, sign-in included. Guard: none
  automated; the tables exist only in `packages/db/usage-migrations/`.

## Boundary

This module owns the ledger, the meter's arithmetic, and the plan column. It
exposes `emitInferenceUsage` to call sites, `GET /workspace/usage` and
`PUT /workspace/plan` to the desktop, `POST /internal/workspaces/:id/plan`
to Ace, and the `workspace_usage` socket event to every member after a plan
change. The socket itself is [`realtime-sockets.md`](realtime-sockets.md)'s.

It does not stop, slow or gate any work when the quota is spent: the product
never asks permission before a tool call (`AGENTS.md`), and no run reads the
meter. It does not charge anyone or talk to Stripe. It is not the inference
archive: the [inference lakehouse](inference-lakehouse.md) keeps exact request
and response records, and this ledger keeps only cost, activity and IDs. The
desktop meter is owned by the settings screens and
[the local cache](local-cache.md).

## Failure modes and limits

- **Queue send fails:** the event is lost and `usage_emit_failed` is logged with
  its cost. The PRD accepts this best-effort loss for this phase.
- **Consumer fails:** the batch retries with the platform's defaults and then
  lands in `avalon-<region>-usage-dead-letter`. A non-empty dead-letter queue
  is the alarm; its messages replay safely.
- **Lakehouse send fails:** the meter stays current, since D1 is written first.
  The batch retries, and after the retries it lands in the dead-letter queue:
  those events are in D1 but not R2 until it is replayed, and the 90-day prune
  makes the gap permanent if it is not.
- **A workspace row with an unknown plan:** `plan` has no CHECK, so
  `PlanIdSchema` is the guard; the batch or read fails with
  `workspace_plan_invalid:…` rather than guessing a quota.
- **Unknown workspace** (retired, or never existed here): the event is dropped
  and counted in `usage_batch_applied.unknown_workspace`.
- **Lag:** up to the 60-second batch window plus retries. The PRD tolerates
  minutes. Usage past 0% before the meter shows it is overage, so nothing is
  lost.
- **Unpriced activities:** the JEV leg of the classifiers, `audio_generation`
  (until the text-to-speech model is in the pricing cache), `message_speech`,
  `dictation` and `document_ocr` log `usage_unpriced` and do not move the
  meter. See the PRD's decision log.
- **`USAGE_DB` fills:** only metering stops. At about 12,000 events a day and
  391 bytes a row, 90 days is about 0.4 GB; the limit is about 20 times today's
  volume away.
- **An unprovisioned lakehouse:** a manifest with the all-zero stream ID is
  refused when the deploy materializes bindings, so a new region's deploy fails
  until `pnpm cloudflare:lakehouses:ensure` creates the stream and its ID is
  pinned, rather than every batch failing.
- **Plan-change push fails** (WorkspaceDO unreachable, or the read after the
  change fails): `usage_publish_failed` names the workspace and the code. The
  plan has changed; other members see the old meter until theirs reads again,
  when a meter opens or the socket reconnects.
- **Numbers:** batch size 100 and wait 60 seconds are the Queues platform
  maxima (checked 2026-10-03).

## Testing

- `packages/contracts/src/usage.test.ts`: week and period boundaries,
  month-end clamping, overage derivation, plan re-pricing.
- `apps/api/test/usage-metering.test.ts`: the consumer, the reader and
  `GET /workspace/usage` and `PUT /workspace/plan` against the real migrations, with the regional and
  usage schemas on separate connections (`migratedUsageSqliteDatabase`), as in
  production.
- `apps/api/test-workers/usage-ledger.test.ts`: the once-only count on real D1,
  where `changes()` inside a `batch()` is the runtime's to honour.
- `apps/api/test-workers/queue-dispatch.test.ts`: the usage queue is
  dispatched ahead of the maintenance fence.
- `apps/api/test/workspace-operations.test.ts`: the plan route, its
  credential, its refusals, the current week's re-pricing, and the push.
- `apps/api/test-workers/durable-object-runtime.test.ts`: WorkspaceDO sends
  `workspace_usage` to every member socket, skips a guest's, and drops a
  stale meter.
- `apps/desktop/src/renderer/lib/workspace-socket.test.tsx`: the push lands in
  the read and the `usage` slice, a subscribe answer marks the meter stale,
  and both are relayed to the Settings window, which reads again.
- `test/agent-inference-logging.test.ts` and
  `test/structured-inference-deferral.test.ts`: what the emitters send.
- `packages/agent-harness/src/embedding-cost.test.ts`: the bring-your-own-key
  embedding cost.
- Ace: `workspaces.test.ts` (the plan relay), `workspaces-client.test.tsx`
  (the control) and `directory.test.ts` (a region without the column yet).

A test that seeds a workspace must set `created_at`, since every week and
period is computed from it.

## Regional impact

Each configured deployment has its own `avalon-<region>-usage` queue and
dead-letter queue, its own `USAGE_DB` and its own lakehouse, and its consumer
writes only that region's stores. Global is the only configured deployment
today.

## Security and trust model

A usage event carries IDs, an activity, a model ID and a cost: no prompt,
output or tool argument. Only server call sites produce events. The read route
sits behind member-only workspace auth, and every role may read it, since
usage is shared by design. `PUT /workspace/plan` is for owners and
administrators, like every other Organization-wide setting; a member gets
`workspace_admin_required`. The operator plan route sits behind the regional
operator credential in the `demos` role, the same one Ace uses to retire a
workspace.

## Operations

- `usage_batch_applied` (one per batch) carries applied, duplicate,
  unknown-workspace, invalid and misrouted counts and a per-activity count.
- `usage_unpriced` and `usage_emit_failed` name what was not metered.

## Changelog

### 2026-11-07 — Index the ledger by Sidekick

**What changed:** Migration `0002_usage_events_sidekick.sql` adds a partial
index on `usage_events(sidekick_id, occurred_at)` for Sidekick rows.

**Why:** A Sidekick's cost, or one run's, has no index of its own. Grouping one
Sidekick's runs over three days by `sidekick_id` scanned the whole ledger
(266,973 rows on 2026-11-07); scoped by Organization through
`usage_events_workspace_occurred` it still reads every event that Organization
logged in the window (17,474 for Juno Labs over those three days) to find about
1,300. Those reads come back whenever a Sidekick's cost is in question.

**Considered and rejected:** An index on `substream_id` alone: it serves one run
but not a Sidekick over time, and a run's rows sit inside its Sidekick's.
A full index: most events are not a Sidekick's, so the partial one is smaller
for the same reads.

**Consequences:** Every insert of a Sidekick event also writes the index. A
query must say `sidekick_id = ?` to use it; one by `substream_id` alone still
scans.

### 2026-10-08 — A plan change pushes the new meter to every member

**What changed:** After either plan route answers, `publishOrganizationUsage`
reads the meter under the new plan and WorkspaceDO sends it to every
subscribed member socket as `workspace_usage`, never to a guest, dropping a
meter read before the last one sent. The desktop writes it into the meter's
read and the `usage` slice, marks the meter stale on every subscribe answer,
and relays both to the Settings window as `usage`. The quota and overage
arithmetic is unchanged: `setWorkspacePlan` already re-priced the current
week, and overage is still derived on read.

**Why:** Only the window that made the change saw the new quota. Every other
member, and every other window of the same person, kept the old meter until
they reopened it, so an upgrade made to lift a spent quota still read "All
used" for the rest of the team.

**Considered and rejected:** A `usage` sync topic that tells each desktop to
read again. The topic enum is closed, so older desktops would reject the
subscribe answer, and a nudge costs every member a request for a value that is
the same for all of them and that the server had just read. Reading at send
time alone to order two quick changes: the first push can still arrive last,
so each carries when its read started and WorkspaceDO keeps the newest.
Carrying the value as a sync topic on the Electron relay: that enum is the
server's, so the relay gained its own name, `usage`. Putting the push on the
waterline and replaying it: the meter changes as usage accrues too, so a
replayed value would be stale, and a reread on subscribe is cheaper and
current.

**Consequences:** The push is best effort and post-commit; it never fails or
delays the change. Guests are never sent it, since the read route refuses
them. Only the plan change pushes; accrued usage still lags by
the consumer's batch window and is read when a meter opens. When checkout
lands, a plan change made by the payment flow has to call
`publishOrganizationUsage` too.

Shipped in #1173.

### 2026-10-07 — Administrators choose the plan in Settings

**What changed:** Settings → Organization → Usage is now two standard rows:
Plan, with its picker, above Weekly quota, with the meter as its value. The
Plan row is backed by `PUT /workspace/plan`. Owners and administrators can
change the plan; other members see it locked. The account menu's meter fills
in the viewer's own accent; the Settings meter fills in the text colour,
near-black in light and near-white in dark. In that menu the meter moved from
under the active Organization's row to a full row right under Settings, titled
Quota.

**Why:** The usage PRD deferred self-serve plan choice until checkout existed
(non-goal 5), so every plan change needed an operator in Ace. The product owner
chose to let administrators pick the plan now, before billing. The menu meter
moved because under the active row it only appeared when the Organizations
list was shown, and it had no label saying what the bar measured.

**Considered and rejected:** Letting any member change the plan. The plan sets
a quota the whole Organization shares, so it follows every other
Organization-wide setting and needs an administrator. A second route with its
own re-pricing logic was also rejected: the new route calls `setWorkspacePlan`,
so the rule for re-pricing the current week stays in one place.

**Consequences:** Nothing charges for a plan change yet; when checkout lands,
this route is where payment has to gate the change. Two administrators choosing
opposite plans at the same instant can leave `workspaces.plan` and the
current week's quota on different plans, the same exposure Ace's route already
had; choosing again repairs it. A usage read in flight is cancelled before a
plan change, so a read that saw the old plan cannot overwrite the new one.

Shipped in #1156. Design: `docs/PRDs/2026-10-03_usage-quota-metering/prd.md`.

### 2026-10-03 — Usage metering introduced (#1086)

**What changed:** Every model call now emits a usage event to a regional queue.
One consumer applies each batch to `usage_events` and `usage_rollups` in a D1
database of its own, which keeps events for 90 days and totals for good, and
then sends it to a usage lakehouse in R2 that keeps every event.
`GET /workspace/usage` derives the weekly percentage and monthly overage.
Workspaces gained a plan, set from Ace.

**Why:** Pricing was decided (Starter and Growth, twice the price as a weekly
quota) and nothing in the product could say what an Organization had used. The
inference lakehouse had the costs, but it is an archive that says it is not
billing authority, and it missed embeddings, speech, dictation and OCR.

**Considered and rejected:** the PRD's decision log
(`docs/PRDs/2026-10-03_usage-quota-metering/prd.md`) has each option and why.
In short: Cloudflare K2, Analytics Engine, Stripe credits, splitting overage on
arrival, keeping every event in D1, a monthly export job, and Turbopuffer.

**Consequences:** A future change has to keep overage derived on read, keep an
event's rollup increment conditional on its insert, keep D1 ahead of the
lakehouse and the D1 window above the queue's message retention, and never let
metering block or fail the call it measures. Five activities are logged as
unpriced until a rate exists for them.
