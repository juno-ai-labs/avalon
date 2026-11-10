# Usage quota metering: design

> Companion to [`prd.md`](prd.md). It holds the event shape, the queue, the
> ledger tables, the consumer and the read path. The reasons for each choice
> are in the PRD's **Key design decisions**. The platform comparison is in
> [`research.md`](research.md).

## Shape at a glance

```
call site (DO or Worker)            usage consumer (regional Worker)        D1 `DB`
─────────────────────────           ────────────────────────────────        ──────────
cost known  ──ctx.waitUntil──▶  USAGE_QUEUE  ──batch ≤100, ≤60 s──▶  dedupe, apply payer map,
            (never awaited)       + DLQ          max_concurrency 1         add to totals
                                                                          ──▶ usage_events, usage_rollups
desktop  ──GET /usage (workspace auth)──▶  API Worker  ──one range read──▶  usage_rollups, workspaces
```

Four parts, each usable on its own:

1. **`UsageEvent`**: one record type for anything metered.
2. **`emitUsage()`**: the only producer. It sends and never throws.
3. **The usage consumer**: the only writer of the ledger.
4. **`getOrganizationUsage()`**: the only reader, behind one route.

A new metered activity, whether inference or Firecrawl later, is a new key and
one `emitUsage()` call. None of the four parts change.

## `UsageEvent`

Defined in `@rally/contracts` with Zod, so the consumer validates every message.
A rejected message is logged through `describeZodIssues`, per the rule on
[naming a schema failure](../../naming-a-schema-failure.md).

```ts
type MeteredActivity =
  | 'agent_run' | 'sidekick_run' | 'session_import' | 'context_compaction'
  | 'channel_naming' | 'channel_description' | 'breakout_summary'
  | 'attachment_summary' | 'work_opportunity' | 'addressing_classifier'
  | 'semantic_trigger_gate' | 'memory_embedding' | 'search_embedding'
  | 'image_generation' | 'audio_generation' | 'message_speech'
  | 'dictation' | 'document_ocr';

interface UsageEvent {
  v: 1;
  eventId: string;            // stable; see "Event IDs"
  workspaceId: string;
  region: string;             // the producing deployment; see the consumer
  activity: MeteredActivity;
  occurredAt: string;         // ISO instant the call finished
  costMicrousd: number;       // integer, >= 0
  model: string | null;
  refs: {                     // stored on usage_events for a later breakdown
    userId?: string; workstreamId?: string; substreamId?: string;
    sidekickId?: string;
  };
}
```

There is no zero-cost placeholder. An activity Rally cannot price yet is a
gap to close (see **Gaps to close**), not a zero to record.

### The payer map

```ts
// true: the Organization pays and it counts against quota and overage.
// false: Rally pays; recorded as rally_microusd only.
export const ORGANIZATION_PAYS = {
  agent_run: true, sidekick_run: true, session_import: true,
  context_compaction: true, channel_naming: true, channel_description: true,
  breakout_summary: true, attachment_summary: true, work_opportunity: true,
  addressing_classifier: true, semantic_trigger_gate: true,
  memory_embedding: true, search_embedding: true, image_generation: true,
  audio_generation: true, message_speech: true, dictation: true,
  document_ocr: true,
} as const satisfies Record<MeteredActivity, boolean>;
```

`satisfies Record<MeteredActivity, boolean>` makes adding an activity without a
payer a type error.

### Plans

```ts
export const PLANS = {
  starter: { monthlyPriceUsd: 100 },
  growth:  { monthlyPriceUsd: 250 },
} as const;
export const INCLUDED_USAGE_MULTIPLIER = 2;  // product limit, this PRD
export const LOW_QUOTA_PERCENT = 20;        // warning color below this; PRD decision 13
export const weeklyQuotaMicrousd = (plan) =>
  PLANS[plan].monthlyPriceUsd * INCLUDED_USAGE_MULTIPLIER / 4 * 1_000_000;
```

These are product limits. The PRD sets them; they are not defensive guesses.

### Event IDs

Queue redelivery repeats the same message body, so the dedupe key only has to
be stable when a caller re-runs its own work. Each emitter derives the ID from
something it already owns:

| Activity | Event ID |
| --- | --- |
| Harness inference (runs, compaction, import) | `inf:<inference_request_id>:<attempt>`, the same identity the lakehouse `attempt` row uses |
| Structured inference (naming, summaries, classifier) | `inf:<inference_request_id>` |
| Embeddings | `emb:<request id>` minted once per call |
| Image and audio generation | `gen:<resource id>` |
| Message speech | `tts:<message id>:<speech request id>` |
| Dictation | `stt:<session id>:<segment>` |
| OCR | `ocr:<attachment derivative id>` |

## `emitUsage()`

```ts
emitUsage(env, waitUntil, event): void
```

- It calls `waitUntil(env.USAGE_QUEUE.send(event))` and returns. The caller
  never awaits it.
- If the send fails, it logs `usage_emit_failed` with the event ID, activity
  and the send error's code. It never rethrows. A lost event costs a few cents
  of accuracy, which the PRD accepts. A thrown error would fail a user's run,
  which it does not.
- It runs where the cost is already known, next to the existing lakehouse write
  or `recordInferenceAttempt`, so no new provider read is added.

## Queue

`apps/api/wrangler.global.jsonc`, named per
[choosing a Queue or RPC](../../choosing-queues-or-rpc.md):

| Setting | Value | Source |
| --- | --- | --- |
| Queue / DLQ | `avalon-global-usage` / `avalon-global-usage-dead-letter` | The `-dead-letter` convention the other queues in `wrangler.global.jsonc` use |
| Binding | `USAGE_QUEUE` | One name in every region |
| `max_batch_size` | 100 | Platform maximum (Queues limits, 2026-10-03) |
| `max_batch_timeout` | 60 s | Platform maximum. The PRD tolerates minutes. |
| `max_concurrency` | 1 | Correctness, not a guard: one writer means the dedupe check and the rollup update cannot race |
| `max_retries` | Platform default | |

Capacity at one consumer: one batch of 100 is a single D1 batch, roughly tens
of milliseconds. That is thousands of events a second against a queue ceiling
of 5,000 a second. Today's volume is a few events per agent turn, orders of
magnitude below either. If the consumer ever falls behind, the backlog grows
and the meter lags. That is the failure the PRD says it can live with.

## Consumer

`apps/api/src/queues/usage-consumer.ts`. One run per batch:

1. Parse each message with the Zod schema. Ack and log any that are invalid;
   retrying will not fix them. A message whose `region` is not this
   deployment's is a misrouted producer. It fails and retries here until it
   reaches the dead-letter queue, and is never rerouted, per
   [choosing a Queue or RPC](../../choosing-queues-or-rpc.md#splitting-per-region).
2. Drop repeated `eventId`s within the batch, keeping the first. Then select
   the IDs already in `usage_events` and drop those messages too. Without the
   in-batch step, two copies in one batch would both be applied.
3. Read each affected Organization's `plan` and `created_at` from `workspaces`.
4. For each event, sum into its rollup key:
   - `weekStart = created_at + 7d × floor((occurredAt − created_at) / 7d)`
   - `periodStart`: the latest monthly sign-up anniversary at or before
     `occurredAt`, clamped to the month's last day (PRD decision 10).
   - If `ORGANIZATION_PAYS[activity]` is true, add the cost to
     `organization_microusd`; otherwise to `rally_microusd`.
5. Write everything in one `DB.batch()`: insert the events with
   `ON CONFLICT (event_id) DO NOTHING` as a safety net, then upsert the
   rollups with `ON CONFLICT … DO UPDATE SET x = x + excluded.x`. A new rollup
   row takes `quota_microusd` from the current plan; an existing row's quota is
   left alone. A D1 batch is
   one transaction, so a crash leaves nothing half applied, and the redelivery
   is dropped at step 2.
6. Log one `usage_batch_applied` line with counts per activity. This line is
   the monitoring, per
   [deciding without measurement](../../choosing-queues-or-rpc.md#deciding-without-measurement).

The consumer computes no overage. Addition commutes, so the rollups come out
the same whatever order events arrive in.

**Retention.** `usage_events` is kept. It is the history the PRD exists to
collect, and the only per-event source a Stripe sink could replay from. Its
growth meets D1's per-database size limit long before anything else does. When
that comes close, moving closed months to the inference lakehouse's R2 is the
next step, and that is a decision to make then, not now.

## Read path

`GET /usage` on the workspace-auth router, so the Organization comes from
`getWorkspaceAuth(c)` and the existing membership check applies. Any member role
may call it:

```ts
{
  plan: 'starter' | 'growth',
  quotaRemainingPercent: number,   // integer 0..100, rounded down
  weekResetsAt: string,            // ISO
  overage: {
    amountMicrousd: number,
    periodStart: string, periodEndsAt: string,
    billed: false,
  },
}
```

It reads the Organization's `workspaces` row and its `usage_rollups` rows with
`week_start` from seven days before the current period's start up to now. That
is one range on the primary key, about a dozen rows at most. Then:

- **Percentage:** the current week's `organization_microusd` summed across its
  rows, against `quota_microusd`. No rows means 100%.
- **Overage, per week:** with `Q` the week's quota, `A` the earlier period's
  total and `B` the later one's, the earlier part's overage is
  `max(0, A − Q)` and the later part's is `max(0, A + B − Q) − max(0, A − Q)`.
  A week inside one period has only `A`.
- **Overage, this month:** the sum of the overage parts whose `period_start` is
  the current period.

A plan change applies at once (PRD decision 12) because Ace rewrites
`quota_microusd` on the current week's rows. A Starter Organization that has
spent $70 and moves to Growth reads 44% left, with no overage for the week.

Allowance dollars and spend dollars are never in the response. The quota stays
opaque on the wire as well as in the interface.

The client caches the last response per Organization in the
[local cache](../../local-cache.md). It renders the cached value first and
refreshes when the Usage section or the Organization menu opens.

## Setting a plan

Ace's workspaces tab, which already finds any workspace and retires it, gains a
plan control: Starter or Growth. It writes `workspaces.plan`, and rewrites
`quota_microusd` on the Organization's current-week `usage_rollups` rows, in one
D1 batch through the same regional path the retire action uses. Past weeks keep
the quota they had. There is no customer-facing control.

## DDL sketch

```sql
ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'starter'
  CHECK (plan IN ('starter', 'growth'));

CREATE TABLE usage_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  activity TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  cost_microusd INTEGER NOT NULL,
  model TEXT,
  user_id TEXT,
  workstream_id TEXT,
  substream_id TEXT,
  sidekick_id TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX usage_events_workspace_occurred
  ON usage_events (workspace_id, occurred_at);

CREATE TABLE usage_rollups (
  workspace_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  period_start TEXT NOT NULL,
  quota_microusd INTEGER NOT NULL,
  organization_microusd INTEGER NOT NULL DEFAULT 0,
  rally_microusd INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, week_start, period_start)
);
```

The rollups are small, at most two rows per Organization per week,
and they are what the read path uses. `usage_events` is the history behind
them.

## Gaps to close

These call sites compute no cost today, according to the exploration done for
this PRD. Each needs a cost before Goal 2 holds:

| Activity | Site | Proposed cost |
| --- | --- | --- |
| `memory_embedding`, `search_embedding` | `runEmbeddingInference` drops `usage` (`structured-inference.ts`) | `usage.cost` alone is not enough: on a bring-your-own-key account it is only OpenRouter's fee, and the SDK's embeddings shape omits `cost_details.upstream_inference_cost` ([inference lakehouse](../../inference-lakehouse.md)). Read both fields from the raw `/v1/embeddings` response that `OpenRouterClient.embed` already fetches, and add them as `openRouterCallCostUsd` does for chat. If the upstream field is absent, price from the rate card. |
| `audio_generation` | `multimodal-generation/plugin.ts` logs `usage_unavailable` | Azure rate card by characters or seconds |
| `message_speech` | `message-speech-service.ts` | Same rate card |
| `dictation` | `realtime-transcription-service.ts` captures nothing | Azure realtime rate card by audio seconds |
| `document_ocr` | `attachment-derivative-service.ts` (`ai.toMarkdown`) | Workers AI published price per page or neuron |
| `addressing_classifier` (JEV leg), `semantic_trigger_gate` | `jev/client.ts` returns tokens only | Needs a rate from the provider (PRD open question 1) |

Rate cards extend the existing `INFERENCE_PRICING_CACHE` and
`createAzureModelPricingResolver` rather than adding a second pricing store.

## Testing

- **Node suite, real migrations:** the consumer applied to a batch with a
  duplicate, a Rally-paid activity and a week that straddles a monthly
  boundary, delivered in two different orders. Assert the rollup rows and the
  read's percentage and overage against literals. Prove it can fail by removing
  the in-batch dedupe.
- **Emitters, one per activity:** run each call site with the provider stubbed
  to return a known cost, and assert it sends exactly one `UsageEvent` with the
  expected activity, cost and event ID. Run it twice and assert the event ID is
  the same both times. This is what catches a call site that emits nothing,
  emits twice, or mints a new ID when it retries.
- **Unit:** week and period boundaries, including month-end clamping and
  daylight-saving weeks. Payer map exhaustiveness is enforced by typecheck and
  needs no test.
- **Desktop:** the `Meter` primitive's states. Screenshot Settings → Usage and
  the Organization menu in light and dark, per
  [verifying visible changes](../../../AGENTS.md#verifying-visible-changes).

## Documents to update when built

A new `docs/usage-metering.md` module document, registered in the index, owns
this subsystem. [`data-model.md`](../../data-model.md) gains the tables.
[`inference-lakehouse.md`](../../inference-lakehouse.md) gains a line saying
billing reads the usage ledger, not the lakehouse.
[`settings-search.md`](../../settings-search.md) gains the Usage entry.
`ace.md` (retired app) gains the plan control.
[`local-cache.md`](../../local-cache.md) gains the usage slice, with a changelog
entry, because the client caches the last response there.
