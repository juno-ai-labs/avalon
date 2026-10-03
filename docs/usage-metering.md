# Usage metering

Usage metering measures what each Organization spends on inference against its
plan's weekly quota. Every model call Rally makes for an Organization sends one
small usage event in the background. One queue consumer adds the events into a
D1 ledger, and one route derives the meter members see: the percentage of this
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
| `apps/api/src/services/usage-metering.ts` | `emitUsage` and `emitInferenceUsage` (the only producers), `applyUsageBatch` (the only ledger writer), `readOrganizationUsage` (the only reader), `setWorkspacePlan`. |
| `apps/api/src/queues/usage-consumer.ts` | The `avalon-<region>-usage` consumer: validates, rejects misrouted messages, applies the batch, logs `usage_batch_applied`. |
| `apps/api/src/routes/workspace.ts` | `GET /workspace/usage`, for every member role. |
| `apps/api/src/routes/workspace-operations.ts` | `POST /internal/workspaces/:id/plan`, the operator route Ace calls. |
| `packages/db/migrations/0117_usage_quota_metering.sql` | `workspaces.plan`, `usage_events`, `usage_rollups`. |
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

The consumer runs one batch at a time (up to 100 messages or 60 seconds). It
drops repeated event IDs within the batch, then IDs already in `usage_events`,
reads each Organization's plan and creation time, and in one `DB.batch()`:

- inserts each event into `usage_events`, recording whether the Organization
  paid (`ORGANIZATION_PAYS` at apply time);
- adds its cost into the `usage_rollups` row for its quota week and monthly
  period, into `organization_microusd` or `rally_microusd`. A new row takes the
  current plan's weekly quota.

The consumer computes no overage. Addition commutes, so the totals do not
depend on arrival order.

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
`setWorkspacePlan` writes `workspaces.plan` and rewrites `quota_microusd` on the
current week's rollups in one batch, so the meter re-prices the current week at
once. Past weeks keep their quota.

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

- `workspaces.plan`: `'starter' | 'growth'`, default `'starter'`.
- `usage_events`: one append-only row per event, keyed by `event_id`. Kept, not
  pruned: it is the per-event history a later breakdown or Stripe sink reads.
  Its growth meets D1's per-database size limit first; moving closed months to
  R2 is the decision to make when that comes close.
- `usage_rollups`: keyed by (`workspace_id`, `week_start`, `period_start`),
  with `quota_microusd`, `organization_microusd` and `rally_microusd`. At most
  two rows per workspace per week.

## Regional impact

Each configured deployment has its own `avalon-<region>-usage` queue and
dead-letter queue behind the one `USAGE_QUEUE` binding, and its consumer writes
only that region's `DB`. Events carry their region and never cross the
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

**What changed:** Every model call now emits a usage event to a regional queue, one
consumer applies it to `usage_events` and `usage_rollups` in D1, and
`GET /workspace/usage` derives the weekly percentage and monthly overage.
Workspaces gained a plan, set from Ace.

**Why:** Pricing was decided (Starter and Growth, twice the price as a weekly
quota) and nothing in the product could say what an Organization had used. The
inference lakehouse had the costs, but it is an archive that says it is not
billing authority, and it missed embeddings, speech, dictation and OCR.

**Considered and rejected:** Cloudflare K2 (pull-only with no dead-letter queue in its beta),
Analytics Engine (samples), Stripe credits (applied only when an invoice is
finalized), and splitting overage when each event arrives (queue order would
decide the month). The PRD has the full reasoning.

**Consequences:** A future change has to keep overage derived on read, keep
one ledger writer, and never let metering block or fail the call it measures.
Five activities are logged as unpriced until a rate exists for them.
