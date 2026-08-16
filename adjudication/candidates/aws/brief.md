# AWS data-plane advocate brief

## 1. The stack, named exactly

Launch one `us-east-2` stack: **Amazon Aurora PostgreSQL-Compatible Edition Serverless v2, I/O-Optimized**, accessed through **Amazon RDS Data API**; PostgreSQL FTS and `pgvector` stay in that database ([Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/)). **AWS AppSync GraphQL subscriptions** provide WebSocket fan-out ([pricing](https://aws.amazon.com/appsync/pricing/)); **Amazon SQS FIFO** plus a FIFO DLQ is the queue ([pricing](https://aws.amazon.com/sqs/pricing/)); **AWS Lambda Durable Functions** drive loops, while a standard **AWS Lambda Function URL** runs the retained Hono API ([pricing](https://aws.amazon.com/lambda/pricing/)). Blobs use **Amazon S3 Standard** with Versioning and Cross-Region Replication ([pricing](https://aws.amazon.com/s3/pricing/)). Auth is **Amazon Cognito User Pools Essentials** ([pricing](https://aws.amazon.com/cognito/pricing/)). Clocks and outbox recovery use **Amazon EventBridge Scheduler** ([pricing](https://aws.amazon.com/eventbridge/pricing/)); credentials use **AWS Secrets Manager** ([pricing](https://aws.amazon.com/secrets-manager/pricing/)); telemetry uses **Amazon CloudWatch** ([pricing](https://aws.amazon.com/cloudwatch/pricing/)). No other database, vector store, broker, or executor is proposed.

## 2. Hard constraints

| # | Constraint | Mechanism and failure behavior |
| ---: | --- | --- |
| 1 | Per-work-stream order and atomic projections | One PostgreSQL transaction locks the `workstreams` row with `SELECT … FOR UPDATE`, increments `next_event_sequence`, and writes the command/delta, card, sparse overlays, durable event, and outbox row. PostgreSQL row locks serialize conflicting writers; rollback is atomic ([locking](https://www.postgresql.org/docs/current/explicit-locking.html), [transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)). This chooses lock contention over sequence allocation: a late commit can never hide below a client's watermark. Transactions are kept to one statement/stored procedure; at overload streaming checkpoints coalesce before user commands queue behind them. |
| 2 | Durable monotonic catch-up | Aurora, not AppSync, stores append-only deltas keyed by `(workspace_id, workstream_id, sequence)`. Monthly range partitions include `created_month`; uniqueness comes from the locked allocator, not a cross-partition sequence. `min_retained_sequence` survives partition retirement: an older cursor receives a full snapshot plus a scanned-through watermark. Aurora supports managed PostgreSQL partitioning with `pg_partman` ([docs](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/PostgreSQL_Partitions.html)). |
| 3 | Live revocation | Preferred push mode has a **≤60 s publication bound**: content carries a random `delivery_epoch` rotated at least every 60 s; only a currently authorized REST read returns the next epoch, and old subscription filters no longer match. Removal also calls AppSync subscription invalidation, which forcibly unsubscribes and closes the WebSocket ([docs](https://docs.aws.amazon.com/appsync/latest/devguide/aws-appsync-real-time-invalidation.html)). AWS documents no invalidation/delivery-latency SLA, so the strict immediate mode sends only opaque cursors and performs every content read through live Aurora authorization. Already-returned bytes cannot be revoked. |
| 4 | Durable 2 h+ execution; long action | SQS invokes a short starter Lambda, which starts a named durable execution asynchronously; asynchronous executions run up to one year and survive waits/deploys ([invocation lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/durable-invoking.html)). Each active invocation still has a 900 s limit ([timeout](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html)), satisfying the ~10-minute requirement. A model call is aborted at 14 m 30 s, emits `attempt_reset`, and restarts as a new non-resumable provider call: turns longer than that do not complete. Continuation occurs before 2,400 of the non-adjustable 3,000-operation/100 MB limits ([quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)). |
| 5 | At-least-once job queue | The state transaction inserts an outbox row; post-commit fast-path sends its ID to SQS FIFO, and a one-minute repair sweep retries unsent rows. `MessageGroupId=workstream_id`; `MessageDeduplicationId=outbox_id`; the consumer also claims a unique DB receipt because SQS can redeliver ([visibility semantics](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)). A DLQ captures poison jobs. Thus enqueue is convergent, not cross-service atomic; worst repair delay is 60 s plus Scheduler jitter. |
| 6 | Two regions/residency | Launch is Global-only. The future EU path stamps the same independent stack into `eu-west-1`, in a separate account, with no Global Database or cross-residency replication. Electron selects its pinned endpoint; absent/unknown `home_region` fails closed. Durable Functions and AppSync are available in Ireland ([Lambda region expansion](https://aws.amazon.com/about-aws/whats-new/2025/12/lambda-durable-functions-14-additional-regions/), [AppSync endpoints](https://docs.aws.amazon.com/general/latest/gr/appsync.html)); the AWS DPA limits transfers outside the selected Region to stated service/legal cases ([summary](https://docs.aws.amazon.com/whitepapers/latest/navigating-gdpr-compliance/in-summary.html)). Exact subprocess/log coverage is **UNKNOWN — counsel's service-by-service DPA review resolves it** before EU launch. |
| 7 | Server-side tenant authorization, FTS/vector | Clients reach only Lambda/AppSync. Cognito JWT identity is passed to a DB role that has `EXECUTE` on authorization-aware functions but no table rights; policies/functions join `workspace_memberships` and require `workspace_id` on every row. PostgreSQL row-security policies default-deny when enabled without a policy ([docs](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)). FTS (`GIN/to_tsvector`) and `pgvector` HNSW queries put the membership/workspace predicate inside the same SQL statement; Aurora documents both indexes ([docs](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.VectorDB.html)). Cognito clients can subscribe but cannot call backend-only publish mutations; the subscription resolver consumes an Aurora rolling-window token per subject before checking membership. Connection-only floods before subscription remain **UNKNOWN — an abuse test resolves whether a separate edge control is required**. Sparse overlay absence means `last_read_sequence=0`; “Unread” starts from indexed memberships and left-joins overlays. |
| 8 | Blob backup/DR | S3 objects are **not** inside Aurora PITR. Source and DR buckets have Versioning; CRR copies versions to `us-west-2` ([requirements](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-requirements.html)). Aurora continuous backups retain 28 days, and Scheduler/Lambda copies a daily encrypted snapshot cross-Region; copied snapshots are independent and incur transfer/storage ([PITR](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Managing.Backups.html), [snapshot copy](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_CopyDBClusterSnapshot.CrossRegion.html)). Quarterly drills restore both and verify DB object references. |
| 9 | D1/R2 single-writer migration | A maintenance cutover stops Cloudflare writes, exports both D1 databases and R2 buckets, transforms/checksums into Aurora/S3, verifies tenant counts and cursors, then changes the Electron endpoints. There is never dual authority. Details and rewrite scope are in §5. |

## 3. UX proxies

**1 — Streaming cadence.** In bounded-push mode, Lambda appends and publishes every 333 ms, with a 250 ms floor. At S=20 that is 60 mutations/s and 120 deliveries/s; at S=300, 900 and 1,800. Both sit below AppSync's published 10,000 request-token/s and 1,000,000 outbound-message/s quotas, although tokens consumed per resolver are not fixed ([quotas](https://docs.aws.amazon.com/general/latest/gr/appsync.html)). The adaptive coalescer moves 333 ms → 500 ms → 1 s → 2 s at 70/85/95% pressure; 2 s is the worst connected cadence, then the client is told to REST-resync. Immediate mode adds an authorized pull per frame: 120 QPS at S=20, 1,800 at S=300.

**2 — Time-to-first-token.** Admission commits the command/outbox, the fast path sends SQS, a starter Lambda asynchronously invokes the named durable execution, and its first provider bytes become an Aurora delta/AppSync mutation. SQS-to-start and Lambda cold-start p99 have no contractual latency: **UNKNOWN — a production-shaped cold/warm load test resolves it**. The launch gate is p99 infrastructure dispatch ≤1.5 s so the product's 1–5 s target retains provider budget. If the fast-path enqueue is lost, the explicit worst case is the 60 s outbox sweep.

**3 — Interaction latency and coherence.** Send returns only after one Aurora transaction commits transcript, card, overlays, event, and outbox; sidebar and transcript therefore cannot represent different durable facts. AppSync runs after commit and may reach views at different times. Every frame carries the same cursor; a gap triggers catch-up. Missing per-user overlay rows mean “never read,” not “not a member.” Publish latency p99 is **UNKNOWN — the S=300 load test resolves it**.

**4 — Visible consistency artifacts.** Clients deduplicate by `(workstream_id, cursor)` and merge append-only attempt deltas. Reconnect subscribes first, buffers live frames, fetches durable state through a server-attested watermark, then merges; this closes the fetch/subscribe race. A crashed or fenced attempt emits `attempt_reset`, so provisional text is visibly retracted rather than silently becoming history. Sealing compacts deltas into the final part; no growing buffer is rewritten.

**5 — Steering responsiveness.** The Electron renderer stops locally within 100 ms. The API CAS-increments the single `workstreams.steering_revision`; the running model step checks each chunk and a concurrent one-second Data API timer, then aborts its fetch. With the fast path absent, the engineered healthy-service worst case is 2.5 s (poll + one timed DB call + abort). Every tool/model receipt commits only if revision, attempt, and lease still match, so an outage can delay stopping but cannot let a stale attempt commit.

**6 — Reconnect/wake.** Electron holds one regional AppSync WebSocket with multiple workstream subscriptions, replacing today's socket-per-workstream DO connection. Last durable cursors stay local. A wake uses subscribe-buffer-fetch-merge, so a mid-stream join receives the full prefix from Aurora, not AppSync memory. For the assumed 30 KB buffer, catch-up p95 is **UNKNOWN — desktop-to-region testing resolves it**.

**7 — Behavior at the limit.** Writer or request-token pressure first coalesces deltas, then rejects new runs with retry metadata while existing durable executions continue. Cursor gaps and outbox age are explicit; clients REST-resync or show “reconnecting.” No content frame is accepted as durable truth, so throttle cannot create silent transcript holes. Cognito or Aurora failure fails authorization closed.

## 4. Cost

Preferred **bounded-push (≤60 s)** list-price estimate: **≈$945/month at 10k users (S≈20)** and **≈$13,340/month at S=300**. Strict immediate pull mode is **≈$1,185/month** and **≈$16,150/month**, respectively. AppSync costs one $4/M mutation plus two $2/M delivered updates per ≤5 KB checkpoint: $8/M logical updates ([pricing](https://aws.amazon.com/appsync/pricing/)). It documents forced invalidation but no latency SLA; bounded mode's epoch is the hard publication cutoff. Immediate mode keeps the same cursor fan-out and adds 6×S authorized Function-URL/Data-API reads per second.

| Monthly line item (USD, `us-east-2`) | Rate/allowance | S≈20 | S=300 |
| --- | --- | ---: | ---: |
| Aurora I/O-Optimized compute | $0.156/ACU-hour ([pricing](https://aws.amazon.com/rds/aurora/pricing/)) | 399 | 2,961 |
| Aurora storage | $0.225/GB-month; read/write I/O included ([pricing](https://aws.amazon.com/rds/aurora/pricing/)) | 23 | 230 |
| RDS Data API | $0.35/M under 1B, metered per 32 KB ([pricing](https://aws.amazon.com/rds/aurora/pricing/)) | 18 | 228 |
| Aurora 28-day PITR + DR snapshot | backup up to 100% of cluster volume included; excess/copy metered ([pricing](https://aws.amazon.com/rds/aurora/pricing/)) | 5 | 43 |
| AppSync GraphQL fan-out | $4/M mutations + $2/M updates + $0.08/M connection-minutes ([pricing](https://aws.amazon.com/appsync/pricing/)) | 304 | 4,562 |
| Lambda loop active compute | Arm $0.0000133334/GB-s ([pricing](https://aws.amazon.com/lambda/pricing/)) | 84 | 1,267 |
| Lambda durable meters | $8/M operations + $0.25/GB written + $0.15/GB-month retained ([pricing](https://aws.amazon.com/lambda/pricing/)) | 5 | 73 |
| Lambda API/starter | $0.20/M requests plus compute ([pricing](https://aws.amazon.com/lambda/pricing/)) | 4 | 43 |
| SQS FIFO + DLQ | first 1M requests/month included; then $0.50/M ([pricing](https://aws.amazon.com/sqs/pricing/)) | 0 | 2 |
| S3 source + replica | Standard storage/request/replication meters ([pricing](https://aws.amazon.com/s3/pricing/)) | 5 | 50 |
| Internet egress | first 100 GB/month aggregate allowance, then assumed $0.09/GB ([pricing](https://aws.amazon.com/s3/pricing/)) | 0 | 83 |
| Cognito Essentials | 10k direct/social MAU included; then $0.015/MAU ([pricing](https://aws.amazon.com/cognito/pricing/)) | 0 | 3,600 |
| EventBridge Scheduler | 14M invocations/month included; then $1/M ([pricing](https://aws.amazon.com/eventbridge/pricing/)) | 0 | 0 |
| Secrets Manager | $0.40/secret-month + $0.05/10k API calls ([pricing](https://aws.amazon.com/secrets-manager/pricing/)) | 0.40 | 0.40 |
| CloudWatch | assumed logs at $0.50/GB after allowance ([pricing](https://aws.amazon.com/cloudwatch/pricing/)) | 25 | 125 |
| Full staging stack | usage-priced; Aurora dominates | 72 | 72 |
| **Bounded-push total** | no base plan/contact-sales rate | **943** | **13,339** |
| **Immediate-pull delta** | 76.0M / 1.140B extra reads, Lambda, Data API, assumed DB ACU | **+240** | **+2,810** |

Free credits that expire are excluded. Model/tool-provider spend, taxes, enterprise support, and EU are excluded. Secrets Manager calls made internally by Data API are **UNKNOWN — a one-week bill probe resolves whether caching changes that line**.

## 5. Migration plan

**Estimate: 12 product-weeks; with two backend/client engineers, about 6 calendar weeks of feature freeze.** Assumes near-zero users, no EU-resident rows, existing tests remain reusable, and no connector contract changes.

Keep shared domain packages, Hono routes, agent/tool logic, Electron UI, typed HTTP contracts, immutable migration discipline, workspace IDs, and the cursor/resync protocol. Rewrite Cloudflare runtime bindings and storage calls. Specifically, the existing Hono **Cloudflare Worker** does not remain the API tier: adapt the same Hono app to a standard Lambda Function URL, replace Worker RPC/region routing with the pinned AWS endpoint, then retire both Workers. Pricing references for the departing services are [Workers/Durable Objects/Workflows](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), and [R2](https://developers.cloudflare.com/r2/pricing/).

Port SQLite DDL/queries to PostgreSQL, add the locked cursor allocator, append partitions, outbox, DB authorization functions, GIN/`pgvector` indexes, and Postgres-specific invariant tests. Rewrite Queue consumers to SQS starters and Workflows to Lambda Durable Functions; preserve attempt/lease/revision fences. Replace each Electron workstream DO socket with one Cognito-authenticated AppSync connection, subscription invalidation, epoch renewal, and subscribe-buffer-fetch recovery. Replace R2 signed access with S3 presigned access. Move login/session issuance to Cognito social federation; preserve Avalon user IDs by linking the verified external subject on first sign-in.

Cutover in one maintenance window: deploy AWS dark; block Cloudflare mutations; drain/cancel loops; export Global and EU D1/R2; assert EU is empty or stop; transform/import; checksum objects and compare every tenant/table/cursor count; run read-only smoke tests; ship a required Electron update with Lambda/AppSync endpoints; enable AWS writes. Old clients receive `upgrade_required`; Workers remain read-only for seven days, then are deleted. No dual-write rollback: before first AWS write, revert endpoints; afterward restore the pre-cutover snapshot only by an explicit incident decision.

Product-week allocation: PostgreSQL/schema 2.5; API/runtime 3; durable queue/driver 2; AppSync/Electron 2; auth/blob 1; rehearsal, load/security gates 1.5.

## 6. Operations at team-size-small

Pages: Aurora capacity/lock/failover, Data API error rate, AppSync throttles/disconnects/invalidation failures, oldest outbox/SQS message and DLQ depth, failed/stuck durable executions, Lambda throttles/timeouts, Cognito auth errors, and S3 replication age. A single correlation ID spans HTTP command, outbox ID, durable execution name, attempt, and cursor.

An on-caller must understand **nine AWS products** and five important protocols/concepts: PostgreSQL/Data API, Lambda/durable replay, AppSync GraphQL/WebSockets, SQS/outbox/idempotency, S3 replication, Cognito/OIDC, Scheduler, Secrets Manager, and CloudWatch. This is the proposal's clearest simplicity liability.

Production state remains inspectable with read-only SQL through Data API: membership, cursor, outbox, attempt, lease, and projection are joins, not actor archaeology. Durable history and SQS/DLQ are separately inspectable; CloudWatch links them by IDs. A quarterly restore creates an isolated Aurora cluster, restores sampled S3 versions/replicas, runs invariants, and deletes it; estimated hands-on effort is 2–4 engineer-hours. Restore time/RTO is **UNKNOWN — the first drill resolves it**.

## 7. Infrastructure as code & deployment

Terraform `hashicorp/aws` v6.55.0 owns every AWS resource; checked-in forward-only PostgreSQL SQL owns schema. The provider exposes Lambda `durable_config` and AppSync resources ([Lambda resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function), [AppSync resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/appsync_graphql_api)).

| Component | Exact IaC | Dashboard/support remainder |
| --- | --- | --- |
| Aurora/Data API/Postgres search | `aws_rds_cluster`, `aws_rds_cluster_instance`, parameter groups; checked-in SQL runner | Major-version choice and restore approval are human; capacity is declarative. |
| AppSync | `aws_appsync_graphql_api`, data sources, resolvers, schema | Request-token/connection/outbound raises require provider approval through Service Quotas; invalidations are fixed at 100/s ([quota](https://docs.aws.amazon.com/general/latest/gr/appsync.html)). |
| Lambda API + durable driver | `aws_lambda_function`, `aws_lambda_function_url`, versions/aliases/event mappings | Enabling durable execution requires function replacement; account concurrency raises require quota approval. |
| SQS/DLQ | `aws_sqs_queue`, redrive policy | None. |
| S3/CRR | `aws_s3_bucket` plus versioning, lifecycle, replication | Restore promotion is human. |
| Cognito | user pool, client, domain, identity-provider resources | External social-provider consent/credentials require its dashboard; AWS settings are declarative. |
| Scheduler | `aws_scheduler_schedule_group`, `aws_scheduler_schedule` | None. |
| Secrets Manager | secret resources; CI writes secret versions | Secret values never enter source; Terraform state is sensitive. |
| CloudWatch | log groups, metrics, alarms, dashboards | None. |

Separate accounts stamp prod/staging from one module; previews stamp usage-priced resources with Aurora auto-pause and no DR replica. Full staging is ≈$72/month; idle previews are assumed <$5. A deploy is expand SQL → deploy backward-compatible Lambda/AppSync versions → shift aliases → drain old durable versions → contract in a later release. Thus old code may run against a wider schema but never an incompatible one; destructive constraints wait up to the configured 24-hour execution deadline or executions are stopped. Rollback shifts aliases; schema rolls forward. Nightly `terraform plan` detects drift. Expected deploy is 15–30 minutes per environment; a major Aurora upgrade or parameter requiring reboot is the routine downtime case.

## 8. Top three risks

**Revocation may not mean what policy means (25%, high blast radius).** AppSync documents forced closure, not completion latency or whether an already-queued frame can arrive afterward. The 60-second random epoch stops new publications, but a strict receipt-time interpretation is **UNKNOWN — a removal/publish race soak plus AWS contractual clarification resolves it**. Any failure selects immediate cursor-only/pull mode before launch, adding the cost in §4.

**The database sizing assumption may be false (35%, platform-wide).** Data API v2 has no v1 1,000-RPS cap, but every Data API query—including authorized FTS/vector reads—runs on the writer ([limitations](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.limitations.html)). The 3.5/26 average-ACU estimates are not benchmarks. If S=300's 600–1,200 writes/s plus search exceeds one 256-ACU writer, the design requires workspace sharding, not a checkbox. Launch requires replaying the supplied demand model with tenant-skew and backup enabled.

**Durable Functions is young and bounded (15%, loop-wide).** Steps are at-least-once by default, so every external action still needs an Avalon idempotency receipt ([docs](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html)); 3,000 operations and 100 MB are hard. A >14 m 30 s provider call is deliberately aborted and cannot resume. Chaos tests must cover deploy during tool effects, callback loss, checkpoint-before/after crashes, continuation, and alias rollback; otherwise keep the current executor until they pass.

## 9. What breaks first

The first published pressure is AppSync's regional **10,000 request-token/s** default: S=300 emits 900 publish mutations/s, but token allocation depends on resolver resource use. If a mutation averages >11 tokens, S=300 already fails; **UNKNOWN — `RequestCount`/token metrics in the load test resolve it**. The quota is adjustable through the published Service Quotas path, so the first fix is configuration, not architecture.

Next is the single Aurora writer. Data API cannot send reads to replicas; Aurora Serverless v2 tops at 256 ACU ([capacity range](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.requirements.html)). Money/tuning covers S=300 only if the benchmark validates 26 average ACU. Beyond that, partitioning tenants across clusters changes routing, migrations, search, and operations: an architectural break, which is why S=2,000 is a tripwire rather than a promise.

## 10. Tripwires

- Any content arrives after the accepted revocation bound in 100,000 removal/publish race trials, or AppSync invalidation p99 exceeds 2 s: launch immediate pull mode or reopen the substrate.
- At S=50 replay, Aurora averages >64 ACU, cursor-lock p95 exceeds 50 ms, or the S=300 test cannot sustain 1,200 append writes/s with search enabled.
- AppSync request-token utilization exceeds 70% or publish p99 exceeds 250 ms at S=50 after an approved quota increase.
- AWS platform spend exceeds $1,500/month at S≈20, or realtime/auth exceeds 60% of the bill for two months.
- More than 0.1% of model turns reach 12 minutes, or durable replay/duplicate-action defects occur in any chaos release gate.

## 11. Assumptions register

| Assumption introduced here | Value / what resolves it |
| --- | --- |
| Workload inputs inherited from packet | 3 updates/s, V=2, 176 h/month, 15-minute loop, 40 durable operations/loop, 30 KB active buffer. |
| Derived monthly activity | S=20: 38.016M checkpoints, 14,080 loops; S=300: 570.24M checkpoints, 211,200 loops. |
| Region/month | `us-east-2`; 730 billable hours; USD list prices; expiring credits excluded. |
| AppSync shape | One ≤5 KB mutation plus two ≤5 KB deliveries/checkpoint; connection/subscription/invalidation operations round to <$1. Tokens/mutation UNKNOWN until load test. |
| Revocation/cadence | Random epoch ≤60 s; local stop 100 ms; 1 s steering poll; 2.5 s healthy-service abort bound; coalesce at 70/85/95% to 500 ms/1 s/2 s. Delivery tail remains UNKNOWN. |
| Aurora | Average 3.5 ACU/100 GB at S=20; 26 ACU/1 TB at S=300; 50M/650M Data API calls. Immediate pull adds 1.5/16 average ACU. Benchmark resolves. |
| DB backup | 28-day PITR; daily cross-Region snapshot; estimated excess/replica cost $5/$43. Actual changed-block volume resolves. |
| Lambda loops | Arm, 512 MB, entire 15-minute average loop billed active; waits would reduce this conservative estimate; 2 KB persisted per durable operation, 14-day history. |
| API/queue | 5M/50M API calls at 100 ms and 512 MB; 1M/5M SQS requests; 60 s outbox sweep. Production telemetry resolves. |
| Blob/network | 100 GB/1 TB source plus replica; 50 GB/1 TB Internet egress; 20% new replicated bytes/month. Object inventory resolves. |
| Auth | 10k direct/social MAU at launch; packet's 250k growth MAU at S=300. Enterprise federation is not priced. |
| Observability/staging/preview | 50/250 GB logs; staging averages 0.5 ACU plus 20 GB and ≈$72/month; idle preview <$5; deploy 15–30 minutes. Bill probe resolves. |
| Immediate-pull delta | 76.032M/1.14048B extra reads at 50 ms/512 MB, plus Data API and assumed ACU; no extra AppSync operations. Load test resolves DB component. |
| Migration/operations | 12 product-weeks, two engineers, 6 calendar weeks; read-only Worker grace 7 days; durable deadline 24 h; quarterly restore 2–4 hands-on hours. First rehearsal/drill resolves. |
| Risk priors and tripwire thresholds | 25% revocation-definition failure, 35% DB-sizing failure, 15% durable-runtime failure; thresholds in §10 are advocate priors, to be replaced by measured baselines. |
