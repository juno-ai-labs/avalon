# Usage quota metering: research

> Companion to [`prd.md`](prd.md). These are the options weighed for moving
> usage events off the hot path, storing them, and reading a counter. The facts
> were gathered on 2026-10-03 from vendor documentation. Anything marked beta
> can change, so re-check it before relying on it.

## What the design needs

- Producing an event costs the caller nothing it waits on.
- At-least-once delivery that can be deduplicated, plus a signal when delivery
  fails.
- An exact sum per Organization per week. An estimate is not good enough.
- Minutes of lag are fine.
- A path to Stripe later, without re-instrumenting call sites.

## Transport

### Cloudflare K2 event streams (public beta, launched 2026-10-01)

K2 is the newest primitive and the closest fit in shape: a durable, ordered,
append-only log stored on R2. Several independent subscriptions can each read
every record, so one stream could feed the lakehouse, this ledger and a future
Stripe sink.

- **Limits in beta:** 10 GB stored per account; 30 MB/s produced per stream;
  retention from 1 hour to 30 days (default 7); about 1 MB per record; consume
  up to 10,000 records or 10 MB per request; 100 subscriptions per stream.
- **Delivery:** at-least-once. Each batch is leased to one consumer for 5
  minutes and acked, nacked or extended. A batch the consumer cannot process is
  redelivered and holds up the subscription. There is no dead-letter queue.
- **API:** a Workers `send()` binding to produce. Consuming is HTTP pull only.
  A push consumer Worker, key ordering and Kafka compatibility are on the
  roadmap.
- **Pricing after beta:** $0.04/GB produced, $0.04/GB consumed, $0.02/GB-month
  stored.
- **Sources:** <https://blog.cloudflare.com/cloudflare-k2-streams/>,
  <https://developers.cloudflare.com/k2/>,
  <https://developers.cloudflare.com/k2/platform/limits/>

**Verdict: not yet.** With no push consumer, the aggregator would be a polling
cron or alarm, and with no dead-letter queue a poison message stalls the
subscription silently. That is the opposite of the failure Rally wants to
notice. Revisit when push consumers ship. The `UsageEvent` and the ledger carry
over unchanged.

### Cloudflare Queues (GA)

- **Limits:** 128 KB per message; batches up to 100 messages and a 60-second
  wait; 5,000 messages a second per queue; 25 GB backlog; up to 100 retries,
  then the dead-letter queue; retention from 60 seconds to 14 days.
- **Delivery:** at-least-once with no ordering. Cloudflare advises using a
  unique message ID as the database primary key to absorb duplicates.
- **Pricing:** $0.40 per million operations beyond 1 million a month; a
  delivered message is three operations.
- **Sources:** <https://developers.cloudflare.com/queues/platform/limits/>,
  <https://developers.cloudflare.com/queues/reference/delivery-guarantees/>

**Verdict: use it.** Rally already runs eight queues with dead-letter queues,
and [choosing a Queue or RPC](../../choosing-queues-or-rpc.md) makes a Queue
the default for exactly this kind of hop.

### Basin (formerly Pipelines, R2 Data Catalog and R2 SQL; GA 2026-10-01)

Basin ingests events into Iceberg tables on R2 and queries them with SQL. It is
where the inference lakehouse already lands. It is an archive and analytics
sink with no consumer to aggregate from, so it cannot drive a live counter.
<https://developers.cloudflare.com/basin/>

## Store and counter

### Workers Analytics Engine

`writeDataPoint` is free of latency, and Cloudflare lists usage-based billing as
a use. However, it samples on write when one index receives data quickly, and
again at query time. The docs say "There is no guarantee you can retrieve any
one individual record." Data is kept for three months. That is fine for a
dashboard, but an estimate cannot be invoiced. Rally's `RUN_ANALYTICS` dataset
is also indexed by source and region, not by Organization.
<https://developers.cloudflare.com/analytics/analytics-engine/sampling/>

### Stripe

- **Meters:** 1,000 calls a second per account (v1); deduplicated by
  `identifier`; events backdated up to 35 days; processed asynchronously.
  <https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api>
- **Billing credits** (credit grants): applied only when an invoice is
  finalized, so the balance does not burn down in near real time. A weekly
  reset would need weekly expiring grants. Not suitable for a live percentage.
  <https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits>
- **Real-time credit burndown and token billing** now run through Metronome,
  which Stripe acquired (closed January 2026). Metronome meters in real time,
  keeps credit ledgers, and sends finished invoices to Stripe.
  <https://docs.stripe.com/billing/how-metronome-works-with-stripe>,
  <https://docs.stripe.com/billing/token-billing>
- **Before a card is on file:** customers, meters and meter events exist
  without a payment method. That is inferred from the API rather than stated in
  the docs. Only the last 35 days could be replayed into Stripe when charging
  starts.

**Verdict: later.** Stripe is the invoicing sink once a later PRD adds charging. Our
ledger stays the source of the live percentage and of history older than 35
days.

### Third-party metering

The market has consolidated: Stripe bought Metronome, Kong bought OpenMeter,
and Adyen bought Orb. Lago remains open source and can be self-hosted. All of
them offer real-time balances and credit wallets. None is needed until pricing
grows complex; when it does, Metronome is the Stripe-native choice.

### D1 rollups (chosen)

Exact integer sums, one row per Organization per week. Deduplication uses a
primary key, and each batch is one transaction. Reads are a single primary-key
lookup. This is already the regional store that holds `workspaces`.

## What already exists in the repository

Found while exploring for this PRD:

- **The inference lakehouse**, Iceberg table `avalon.llm_inference`, has
  `workspace_id`, tokens and `cost_microusd` per request and attempt. Its
  document says it is not billing authority, and it does not cover embeddings,
  speech, dictation, OCR or media.
- **`SubstreamAgent` SQLite** has `runs`, `inference_attempts` and
  `compaction_checkpoints` with `cost_micros`, all per Channel, with no
  Organization rollup.
- **A run budget.** The harness supports `maxCostCents`, but Channel runs do not
  set it. `HARNESS_CHILD_MAX_COST_CENTS` is declared and nothing reads it.
- **No plan, quota, seat or billing column** exists in any D1 database.
