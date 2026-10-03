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
| `packages/contracts/src/usage.ts` | The single source for plans, the 18 metered activities, the `ORGANIZATION_PAYS` payer map, `UsageEvent`, the `GET /workspace/usage` response, and the week, period and overage arithmetic (`usageWeekStart`, `usagePeriod`, `deriveOrganizationUsage`). |
| `apps/api/src/services/usage-metering.ts` | `emitUsage` and `emitInferenceUsage` (the only producers), `applyUsageBatch` (the only D1 ledger writer), `readOrganizationUsage` (the only reader), `setWorkspacePlan`, `pruneUsageEvents` and `USAGE_EVENTS_D1_RETENTION_DAYS`. |
| `apps/api/src/queues/usage-consumer.ts` | The `avalon-<region>-usage` consumer: validates, rejects misrouted messages, sends the batch to the usage lakehouse, applies it to D1, logs `usage_batch_applied`. `usageLakehouseRecord` shapes the R2 row. |
| `apps/api/src/routes/workspace.ts` | `GET /workspace/usage`, for every member role. |
| `apps/api/src/routes/workspace-operations.ts` | `POST /internal/workspaces/:id/plan`, the operator route Ace calls. |
| `packages/db/migrations/0118_usage_quota_metering.sql` | `workspaces.plan`, in the regional `DB`. |
| `packages/db/usage-migrations/` | `usage_events` and `usage_rollups`, in `USAGE_DB` (`avalon-<region>-usage`). Applied by `pnpm --filter @rally/api db:usage:migrate` (local, part of `db:migrate`) and `db:usage:migrate:remote` (deploy). |
| `config/usage-lakehouse.json`, `config/usage-lakehouse-stream-schema.json` | The usage lakehouse: the `USAGE_LAKEHOUSE` Pipeline into the Iceberg table `avalon.usage_events` in R2, provisioned by `scripts/ensure-cloudflare-inference-lakehouse.mjs` like the other lakehouses. |
| `apps/ace/src/client/workspaces.tsx` | The plan control on Ace's workspaces tab. |
| `apps/desktop/src/renderer/lib/organization-usage.ts` | The desktop's read: `useOrganizationUsage`, the `usage` local-cache slice, and the formatters. |
| `apps/desktop/src/renderer/components/organization-usage.tsx` | Settings → Organization → Usage, and the Organization menu's meter (under the active row, or on its own when the Organizations list is hidden). |
| `packages/ui/src/components/primitives.tsx` (`Meter`) | The shared meter primitive and its `cmp.meter.*` tokens. |

Call sites that emit, each next to where the cost is already known:

| Activity | Emitted from |
| --- | --- |
| `agent_run`, `sidekick_run`, `session_import`, `context_compaction` | `createAgentInferenceLogger` (`agent-inference-logging.ts`), per harness attempt. The run's activity is set in `runWorkstreamHarness`; an attempt whose turn ID carries `:compaction:` is `context_compaction`. |
| `channel_naming`, `channel_description`, `breakout_summary`, `attachment_summary`, `work_opportunity` | `runStructuredInference`, which requires every caller to declare its `activity`. |
| `addressing_classifier`, `semantic_trigger_gate` | `createClassifierDiagnosticSink`, whose `role` is the activity. |
| `memory_embedding`, `search_embedding` | `runEmbeddingInference`. |
| `image_generation`, `audio_generation` | The multimodal generation plugin, keyed by the published resource. |
| `message_speech` | `POST /speech`. |
| `dictation` | The realtime transcription socket upgrade. |
| `document_ocr` | `ocrPdfWithWorkersAi`. |

## How it works

### Sending

A call site calls `emitInferenceUsage` with the cost in cents as the provider or
Rally's rate card reported it. It converts to micro-USD, validates the event,
and hands `USAGE_QUEUE.send` to the caller's `waitUntil`. It returns at once.
When the cost is unknown it sends nothing and logs `usage_unpriced` with the
event ID and activity. When the send fails it logs `usage_emit_failed` with the
event ID and cost. A host without the binding (local tests) skips metering.

Event IDs are stable for the work they describe, so a caller that re-runs its
own work produces the same ID: `inf:<inferenceRequestId>` for model calls,
`gen:<resourceId>` for generated media.

Embedding cost is read from the raw response by `embeddingCallCostUsd`, because
the SDK's embeddings shape drops the bring-your-own-key upstream charge.

### Applying

The consumer runs one batch at a time (up to 100 messages or 60 seconds).
First it sends the whole batch to the usage lakehouse. Only then does it touch
D1: it drops repeated event IDs within the batch, then IDs already in
`usage_events`, reads each Organization's plan and creation time from `DB`, and
in one `USAGE_DB.batch()`:

- inserts each event into `usage_events`, recording whether the Organization
  paid (`ORGANIZATION_PAYS` at apply time);
- adds its cost into the `usage_rollups` row for its quota week and monthly
  period, into `organization_microusd` or `rally_microusd`. A new row takes the
  weekly quota of the plan in force at the end of its week (see
  [Plans](#plans)).

The consumer computes no overage. Addition commutes, so the totals do not
depend on arrival order.

### Retention

D1 keeps `usage_events` for `USAGE_EVENTS_D1_RETENTION_DAYS` (90) from receipt;
the scheduled tick deletes older rows. `usage_rollups` is kept for good, so the
meter never reads a pruned row. The lakehouse in R2 keeps every event for good:
it is the history a Stripe replay, a per-person breakdown or a support question
older than 90 days reads, through Basin SQL (read-only, over its REST API with
an account token; $2.50 per TB scanned, checked 2026-10-03). Readers there
deduplicate by `event_id`, since a retried batch can be written twice.

### Reading

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

Every workspace starts on Starter. An operator changes the plan from Ace;
`setWorkspacePlan` records the change in `usage_plan_changes` (with the plan it
replaced) and rewrites `quota_microusd` on the current week's rollups, in one
`USAGE_DB` transaction, so the meter re-prices the current week at once. Then it
writes `workspaces.plan` in `DB`, which the meter and Ace display; if that
second write fails, Ace shows the error and saving again finishes it.

A new rollup row's quota is computed inside the consumer's insert from
`usage_plan_changes`: the plan in force at the end of the row's week (the
latest change before the week ended, else the plan the first later change
replaced, else the plan `DB` holds). Past weeks therefore keep the plan they
had, even for an event that arrives late.

## Invariants

- **Only `applyUsageBatch` writes the ledger, and it runs one batch at a time.**
  The in-batch dedupe and the rollup upserts assume no concurrent batch carries
  a copy of the same event; a second concurrent writer could count an event
  twice. Guard: `max_concurrency: 1` on the consumer, and
  `test/usage-metering.test.ts` ("counts an event once…").
- **Overage is never stored.** It is derived on read from totals and the week's
  quota. Storing a split at apply time would let queue order decide which month
  gets overage and would go stale on a plan change. Guard:
  `test/usage-metering.test.ts` ("derives the same overage whichever order…")
  and `packages/contracts/src/usage.test.ts`.
- **Metering never throws into a call site and is never awaited by one.** A
  failure would fail or slow the run it measures. Guard:
  `test/agent-inference-logging.test.ts` ("…never fails on a lost send").
- **A call with no known cost is logged as unpriced, never recorded as zero.**
  A zero would read as a free activity and understate every meter. Guard: the
  same test, and `emitInferenceUsage` taking `costCents: number | undefined`.
- **Every metered activity has a payer.** `ORGANIZATION_PAYS` uses `satisfies
  Record<MeteredActivity, boolean>`, so adding an activity without one is a type
  error. Guard: the type.
- **Every structured inference call declares its activity.** `activity` is
  required on `runStructuredInference`, so a new caller cannot go unmetered.
  Guard: the type.
- **Allowance and spend dollars never cross the wire.** The quota is opaque to
  members; the response carries a percentage and the overage only. Guard:
  `OrganizationUsageSchema`, parsed by the route.
- **A usage event is processed only in its own region.** A message whose
  `region` differs from the consumer's retries until the dead-letter queue and
  is never applied. Guard: `test/usage-metering.test.ts` ("…retries one from
  another region").

- **A batch reaches the lakehouse before D1.** If the send fails the batch
  retries before D1 has seen it, so no event is in D1 without being in R2.
  The other order would let D1's dedupe drop the retry and lose the event from
  R2 for good. Guard: `test/usage-metering.test.ts` ("sends the whole batch to
  the lakehouse before D1…").
- **D1 keeps an event for longer than its message can be redelivered.** The
  prune keys on `received_at` and the window (90 days) is far above the usage
  queue's message retention (at most 14 days); a shorter window would let a
  redelivery find its row gone and be counted twice. Guard:
  `test/usage-metering.test.ts` ("deletes rows received before the 90-day
  window…").
- **A new rollup row's quota comes from `usage_plan_changes` at insert time,
  never from the batch's earlier read of `DB`.** D1 runs one transaction at a
  time, so a plan change either commits first and the insert reads it, or
  commits after and rewrites the row; with the quota taken from the earlier
  read, a change landing between the read and the insert would be lost, and a
  late event for a past week would get today's plan. Guard:
  `test/usage-metering.test.ts` ("rollup quota").
- **The ledger stays out of `DB`.** D1's 10 GB limit is per database, so a full
  ledger in `DB` would stop every regional write, sign-in included. Guard: none
  automated; the tables exist only in `packages/db/usage-migrations/`.

## Boundary

This module owns the ledger, the meter's arithmetic, and the plan column. It
exposes `emitInferenceUsage` to call sites, `GET /workspace/usage` to the
desktop, and `POST /internal/workspaces/:id/plan` to Ace.

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
  lands in `avalon-<region>-usage-dead-letter`. The meter lags until it drains.
  A non-empty dead-letter queue is the alarm.
- **Unknown workspace** (retired, or never existed here): the event is dropped
  and counted in `usage_batch_applied.unknown_workspace`.
- **Lag:** up to the 60-second batch window plus retries. The PRD tolerates
  minutes, and an Organization can run a little past 0% before the meter shows
  it. That usage is overage, so nothing is lost.
- **Unpriced activities:** the JEV leg of the classifiers, `audio_generation`
  (until pricing for the text-to-speech model is in the pricing cache),
  `message_speech`, `dictation` and `document_ocr` log `usage_unpriced` and do
  not move the meter. See the PRD's decision log.
- **Lakehouse send fails:** the batch retries, D1 is not touched, and the meter
  lags until the Pipeline recovers or the batch reaches the dead-letter queue.
- **`USAGE_DB` fills:** only metering stops; the consumer fails into the
  dead-letter queue. Shorten `USAGE_EVENTS_D1_RETENTION_DAYS` (never below the
  queue's message retention). At about 12,000 events a day and 391 bytes a row,
  90 days is about 0.4 GB; the 10 GB limit is reached at roughly 20 times
  today's volume.
- **An unprovisioned lakehouse:** the manifest ships an all-zero stream ID until
  `pnpm cloudflare:lakehouses:ensure` pins the real one, and materializing the
  deploy bindings refuses it, so the deploy fails rather than every batch.
- **Numbers:** batch size 100 and wait 60 seconds are the Queues platform
  maxima (checked 2026-10-03). Plan prices, the 2× multiplier and the 20% warning
  threshold are product limits from the PRD.

## Testing

- `pnpm --filter @rally/contracts exec vitest run src/usage.test.ts`: week and
  period boundaries, month-end clamping, overage derivation, plan re-pricing.
- `pnpm --filter @rally/api exec vitest run test/usage-metering.test.ts`: the
  consumer and reader against the real migrations. In-batch dedupe, straddling
  weeks, arrival-order independence, plan change, misrouted and invalid
  messages.
- The same file covers the lakehouse-before-D1 order and the prune. It runs the
  regional schema and the usage schema on separate connections
  (`migratedUsageSqliteDatabase`), as production does.
- `scripts/ensure-cloudflare-inference-lakehouse.test.mjs`: deploy refuses an
  unprovisioned stream.
- `test/workspace-operations.test.ts`: the plan route, including the refusal
  of another region's workspace.
- `test/agent-inference-logging.test.ts` and
  `test/structured-inference-deferral.test.ts`: what the emitters send,
  compaction classification, unpriced and lost-send logging.
- `packages/agent-harness/src/embedding-cost.test.ts`: the bring-your-own-key
  embedding cost.
- Ace: `apps/ace/test/workspaces-client.test.tsx` (plan control) and
  `directory.test.ts`.

A test that seeds a workspace must set `created_at`, since every week and
period is computed from it.

## Data model

- `workspaces.plan` (`DB`): `'starter' | 'growth'`, default `'starter'`.
- `usage_events` (`USAGE_DB`): one row per event, keyed by `event_id`, kept 90
  days from `received_at` (indexed for the prune).
- `avalon.usage_events` (R2, Iceberg): every event for good, with the same
  fields plus `schema_version` and `region`. May hold duplicates.
- `usage_plan_changes` (`USAGE_DB`): one row per plan change, keyed by
  (`workspace_id`, `effective_at`), with the new and the previous plan.
- `usage_rollups` (`USAGE_DB`): kept for good, keyed by (`workspace_id`, `week_start`, `period_start`),
  with `quota_microusd`, `organization_microusd` and `rally_microusd`. At most
  two rows per workspace per week.

## Regional impact

Each configured deployment has its own `avalon-<region>-usage` queue and
dead-letter queue behind the one `USAGE_QUEUE` binding, its own `USAGE_DB`, and
its own lakehouse, and its consumer writes only that region's stores. Events carry their region and never cross the
boundary. Global is the only configured deployment today.

## Security and trust model

A usage event carries IDs, an activity, a model ID and a cost: no prompt,
output or tool argument. Only server call sites produce events; members cannot
write usage. The read route sits behind the member-only workspace auth, and
every role may read it, since usage is shared by design. The plan route sits
behind the regional operator credential in the `demos` role, the same one Ace
uses to retire a workspace.

## Operations

- `usage_batch_applied` (one per batch) carries applied, duplicate,
  unknown-workspace, invalid and misrouted counts and a per-activity count.
- `usage_unpriced` and `usage_emit_failed` name what was not metered.
- A non-empty `avalon-<region>-usage-dead-letter` queue means the consumer is
  failing; its messages replay safely, since redelivery is deduplicated.

## Changelog

### 2026-10-03: Usage metering introduced

**What changed:** Every model call now emits a usage event to a regional queue.
One consumer sends each batch to a usage lakehouse in R2 and then applies it
to `usage_events` and `usage_rollups` in a D1 database of its own, which keeps
events for 90 days and totals for good. `GET /workspace/usage` derives the
weekly percentage and monthly overage. Workspaces gained a plan, set from Ace.

**Why:** Pricing was decided (Starter and Growth, twice the price as a weekly
quota) and nothing in the product could say what an Organization had used. The
inference lakehouse had the costs, but it is an archive that says it is not
billing authority, and it missed embeddings, speech, dictation and OCR.

**Considered and rejected:** Cloudflare K2 (pull-only with no dead-letter queue in its beta),
Analytics Engine (samples), Stripe credits (applied only when an invoice is
finalized), and splitting overage when each event arrives (queue order would
decide the month). For the history: keeping every event in D1 (the 10 GB
per-database limit, shared with sign-in if in `DB`), a monthly export job to R2
(Basin SQL reads only Parquet, which a Worker would have to write), and
Turbopuffer (no multi-document atomicity or increment, and aggregations its
vendor does not recommend for latency-sensitive reads past 1M documents). The
PRD has the full reasoning.

**Consequences:** A future change has to keep overage derived on read, keep
one ledger writer, send to the lakehouse before D1, keep the D1 window above
the queue's message retention, and never let metering block or fail the call
it measures.
Five activities are logged as unpriced until a rate exists for them.
