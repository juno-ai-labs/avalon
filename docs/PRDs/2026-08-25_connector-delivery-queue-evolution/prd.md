# Connector delivery queue evolution

> Created 2026-08-25. Revised 2026-08-26 after the decision to retain one
> regional activity Queue.
>
> Keep Rally's multiplexed regional activity transport and move canonical
> connector-event processing from a per-event Workflow onto native Queue retry
> and dead-letter semantics. Companion: [state](state.md). Subsystem references:
> [connectors](../../connectors.md),
> [work-stream Durable Objects](../../workstream-durable-object.md), and
> [choosing between a Queue and RPC](../../choosing-queues-or-rpc.md). Standing
> contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Rally retains one `ACTIVITY_QUEUE` and one DLQ in each region. Connector
ingress, work-stream projection and notification effects, and Slack Agent
ingress continue to share that regional transport.

Canonical connector-event processing stops creating one Cloudflare Workflow
per accepted event. After the normalized event commits in `WorkspaceDO`, the
consumer sends an ID-only `connector_event_process` message back to the same
regional Queue. A later delivery claims and loads the authoritative event over
a typed WorkspaceDO RPC, performs the processing unit, and settles it through
another typed RPC. Transient failures use per-message Queue retry; exhausted
messages land in the existing regional activities DLQ. Connector polling
remains a Workflow because it owns provider calls, independently checkpointed
streams, and scheduling.

## Motivation

The 2026-08-25 notification investigation demonstrated that an empty queue is
not proof of provider delivery. It may mean that a message was delivered,
skipped, acknowledged after replay, or exhausted. Structured terminal logs and
authoritative object state—not queue depth—must explain the outcome.

The connector path also had two durable orchestrators for one processing unit.
The regional Queue committed an event to WorkspaceDO, created a deterministic
`CONNECTOR_EVENT_WORKFLOW`, and acknowledged ingress. The Workflow then claimed
the same row, performed one callback, recorded failure, created a numbered
Queue redrive, and settled the row. WorkspaceDO already owns event identity,
processing ownership, attempts, and terminal state. Cloudflare Queue already
owns durable retry and exhausted-message retention. The per-event Workflow
duplicated those responsibilities and introduced an external instance-ID
boundary that connector processing did not otherwise need.

This is not a capacity project. Rally has no observed throughput pressure and
does not need more queue resources to solve the orchestration defect. Keeping
one Queue is cheaper to operate and reverse at the current stage. The accepted
trade-off is that backlog and DLQ names do not identify a product flow; strict
message kinds, correlated logs, and authoritative state provide that meaning.

## Goals

1. A canonical connector event reaches one authoritative terminal state,
   `processed` or `failed`, under at-least-once and out-of-order Queue delivery
   without creating a per-event Workflow.
2. A transient processing failure retries after the producer and original
   ingress invocation are gone; an exhausted delivery remains in the existing
   same-region activities DLQ.
3. Duplicate deliveries cannot concurrently process the same claim attempt,
   and a later Queue delivery can recover an interrupted attempt using only
   typed WorkspaceDO outcomes.
4. Every successful, skipped, deferred, retried, and failed branch remains
   queryable through content-free structured logs with opaque IDs.
5. Global and EU remain independent data planes. No connector payload or
   processing pointer crosses regions.
6. The change introduces no new Cloudflare Queue, DLQ, binding, or dashboard
   provisioning step.

## Non-goals

1. **Split `ACTIVITY_QUEUE` by product flow or provider.** Rejected for this
   evolution. Rally has no capacity or isolation evidence that justifies more
   resources; the single Queue's existing message contracts and regional DLQ
   remain sufficient.
2. **Remove Durable Object outboxes.** Rejected. `queue.send()` cannot commit
   atomically with object SQLite, so a product mutation still commits its
   outbox row in the same transaction and removes it only after downstream
   authority accepts the effect.
3. **Replace connector polling with Queue.** Rejected. Polling owns provider
   calls, stream-local checkpoints, and independent partial outcomes.
4. **Replace opportunity/model Workflows.** Rejected. Those Workflows isolate
   long model compute and retain meaningful multi-step boundaries.
5. **Promise exactly-once or ordered Queue delivery.** Cloudflare guarantees
   neither. Object-local idempotency, claims, receipts, and waterlines continue
   to make duplicates and reordering safe.
6. **Build a queue-depth dashboard or a second retry ledger.** Native Queue
   state, the existing regional DLQ, authoritative object state, and terminal
   logs are the operating surfaces.
7. **Change connector routing, notification eligibility, or delivery policy.**
   Self-mention, inactive-recipient, audience, watch, automation,
   contextual-routing, and provider capability decisions remain unchanged.

## Product behavior

There is no new desktop or provider surface. Connector activity still reaches
the appropriate work stream or Suggested Work, and ineligible activity is
withheld according to existing rules.

Under failure:

- ingress commits the canonical event before it sends a processing pointer;
- a failed pointer delivery is retried individually on `ACTIVITY_QUEUE`;
- an exhausted pointer is retained by the existing same-region activities DLQ;
- replay reloads canonical content from WorkspaceDO and never trusts a stale
  provider body in the DLQ;
- a processed replay acknowledges without repeating processing;
- work-stream and notification outbox behavior is unchanged; and
- an empty Queue means only that Cloudflare has no pending messages. The
  terminal log and authoritative row explain the product outcome.

## Impact on the product contract

None. This refines reliability and removes an unnecessary orchestration layer;
it does not change what a work stream is, who participates, or what connector
activity should reach a person.

## Decision log

### 2026-08-26 — Retain one regional activity Queue

Keep `ACTIVITY_QUEUE` and its existing regional DLQ as the shared transport.
Implement only the replacement of new per-event connector Workflows with a
native process-message lifecycle. Queue splitting was rejected because the
product has no observed capacity or failure-isolation pressure, new resources
would not improve provider outcome correctness, and flow identity is already
available from strict message kinds and structured logs.

## Key design decisions

1. **Send the process pointer to the same Queue.** The existing consumer parses
   `connector_event_process` before connector ingress and the other strict
   variants. No new producer, consumer, or binding is introduced.
2. **Carry an internal processing owner UUID in the body.** The owner is
   generated once when the canonical event is admitted and remains stable over
   Queue retries. It is not a formatted external platform identifier and does
   not rely on Cloudflare's Queue message ID being stable across deliveries.
3. **Use authority-issued leases to fence concurrent replay.** WorkspaceDO
   generates a fresh lease token on every Queue acquisition and returns its exact
   expiry. An active duplicate is `busy` until that expiry; after it, a successor
   can recover interrupted processing. Every settlement carries the acquired
   token, so an expired handler cannot overwrite its successor. The 15-minute
   duration matches both Cloudflare Queue's maximum consumer wall time and the
   retiring Workflow step timeout, so takeover cannot overlap a still-live
   invocation.
4. **Keep canonical state in WorkspaceDO.** The Queue carries an ID-only wake-up
   after ingress. Claims return the event body, and settlement is a typed domain
   RPC; callers never interpret SQLite write metadata.
5. **Keep the legacy Workflow deployed only for drain compatibility.** No new
   code calls `CONNECTOR_EVENT_WORKFLOW.create`. Instances admitted before the
   cutover may finish and may use their old ingress redrive. The binding, class,
   and legacy input field remain until operators verify that no instance is
   live. Replaying a claim for the exact same Workflow instance remains
   idempotent, covering a claim RPC that committed before the Workflow persisted
   its step result; different Workflow instances remain lease-fenced.
6. **Keep terminal logs.** Shared Queue state describes transport, not product
   or provider outcome. Logs include opaque workspace, connection, event,
   processing-owner, processing-attempt, and Queue-attempt IDs, never provider
   content or credentials.

## Data model

The canonical connector tables remain in WorkspaceDO. The claim protocol now
calls the owner `processingOwnerId` and records whether Queue or legacy
Workflow orchestration is claiming. The physical SQLite column remains
`workflow_instance_id` during the compatibility window, but its current meaning
is the acquisition lease token. A legacy Workflow uses its instance ID as that
token; a Queue acquisition receives a new WorkspaceDO-generated UUID. This lets
new object code and an already-running Workflow read and fence the same row.
Renaming that column is cleanup after the Workflow binding is retired, not a
precondition for correctness.

`processing_attempt`, `processing_status`, error, and terminal timestamps stay
authoritative. `processing_attempt` retains its bounded legacy/redrive meaning;
native Queue delivery attempts are independent transport telemetry. This is
necessary because a compatibility pointer may begin at attempt 5 and still need
all native Queue redeliveries to recover a failed or expired claim.

The shared Queue accepts two strict connector variants:

- `workspace_connector_event`: the current bounded normalized event, content
  hash, region, workspace, ingress ID, and requested initial attempt; and
- `connector_event_process`: schema version, region, workspace ID, canonical
  event ID, stable processing-owner UUID, and initial processing attempt.

No regional D1 product row or cross-workspace index is introduced.

## Regional impact

There are no resource changes. Global continues to use
`avalon-global-activities` and its DLQ; EU continues to use
`avalon-eu-activities` and its DLQ. Every connector message carries and
validates its region. A misrouted message is terminally skipped in that region;
there is no Global fallback. Raw provider bytes remain in regional R2 and
connector state remains in the workspace's regional Durable Object.

## Security and trust model

Provider webhooks are verified and polling credentials authorized before
enqueue. Every Queue body is parsed with a strict schema. Processing reloads
canonical content from WorkspaceDO rather than treating a replayed pointer as
authority.

Logs retain pure opaque IDs needed for correlation—workspace, work stream,
connection, event, user, channel, message, Queue delivery, and processing owner.
Provider content, credentials, emails, names, work-stream text, and notification
bodies remain excluded.

## Provider configuration

No Google, Slack, GitHub, Linear, Notion, email, Cloudflare Queue, or other
provider configuration changes. Existing regional Wrangler declarations and
deployment preflight remain unchanged.

## Rollout

1. Add the strict process-message variant and typed Queue claim semantics.
   After WorkspaceDO ingress commits, send a pointer to the existing regional
   `ACTIVITY_QUEUE`; stop creating new connector-event Workflow instances.
2. Keep `ConnectorEventWorkflow`, its binding, and its export deployed while
   instances admitted before cutover finish. Its old redrive message remains
   compatible: ingress dedupes in WorkspaceDO and admits a Queue process
   pointer for the released failed attempt.
3. Verify production logs show new events entering
   `connector_event_process_*`, settling in WorkspaceDO, and never creating a
   new connector-event Workflow. Verify no old instances remain live.
4. In a later cleanup, remove the Workflow binding/class/input, then optionally
   rename the physical SQLite owner column. Do not combine that irreversible
   cleanup with the behavioral cutover.

The behavioral change deploys EU-first then Global under the existing health
gate. There is no dual write and no dashboard mutation.

## Acceptance

1. A contract test proves connector ingress commits once, sends one
   `connector_event_process` message to the same `ACTIVITY_QUEUE`, acknowledges
   ingress, and never calls `CONNECTOR_EVENT_WORKFLOW.create`.
2. An injected transient processing failure settles `failed`, requests an
   individual Queue retry, reclaims with the same stable owner and a fresh lease
   even when the pointer begins at legacy attempt 5, settles `processed`, and
   acknowledges.
3. Real-workerd coverage proves duplicate/provider ingress convergence,
   processed replay, stale-lease settlement fencing, an active Queue claim
   returning `busy` with its exact retry time, expired-lease recovery, and a
   later failed claim being reclaimable at the legacy attempt ceiling.
4. Wrong-region process messages acknowledge with a correlated skipped
   terminal log; unparseable legacy messages retain their existing behavior.
5. No new Queue, DLQ, binding, or deployment-script inventory is present in
   either region.
6. Connector logs distinguish enqueue, authoritative ingest, claim, busy,
   processing failure, delivery failure, processed, already processed, and
   region mismatch using stable opaque IDs.
7. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, and both API
   Wrangler dry-run builds pass on the final implementation.
