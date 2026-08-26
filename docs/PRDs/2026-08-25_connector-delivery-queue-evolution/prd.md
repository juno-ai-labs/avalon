# Connector delivery queue evolution

> Created 2026-08-25.
>
> Separate Rally's multiplexed regional activity transport into purpose-owned
> Cloudflare Queues and move canonical connector-event processing from a
> per-event Workflow onto Queue retry and dead-letter semantics. Companion:
> [state](state.md). Subsystem references:
> [connectors](../../connectors.md),
> [work-stream Durable Objects](../../workstream-durable-object.md), and
> [choosing between a Queue and RPC](../../choosing-queues-or-rpc.md). Standing
> contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Connector activity, work-stream projection and notification effects, and Slack
Agent ingress no longer share one regional `ACTIVITY_QUEUE`. Each flow has one
purpose-owned Global queue and one purpose-owned EU queue, with its own
dead-letter queue. A queue's backlog, pause state, retry policy, and dead-letter
contents therefore describe one contract rather than three unrelated systems.

Canonical connector-event processing also stops creating one Cloudflare
Workflow per accepted event. After a connector event commits in `WorkspaceDO`,
the connector queue carries an opaque processing pointer. The consumer claims
and settles authoritative state in `WorkspaceDO`; transient failures use native
Queue retry, and an exhausted delivery remains both `failed` in the object and
present in the connector queue's DLQ for replay. Connector polling remains a
Workflow because it owns provider calls and independently checkpointed streams.

## Motivation

The notification incident on 2026-08-25 exposed two different observability
failures in one path. First, an empty `avalon-<region>-activities` queue could
not say whether a mention had reached Slack: it could mean that the message had
been delivered, skipped, acknowledged after a replay, or exhausted. Second, the
same queue carried connector ingress, work-stream effects, and Slack Agent jobs,
so even a non-empty backlog or DLQ could not identify which product contract was
stuck without downloading and parsing messages.

The connector half adds a second orchestration system after the Queue. The
regional consumer commits an event to `WorkspaceDO`, creates a deterministic
`CONNECTOR_EVENT_WORKFLOW` instance, and acknowledges the Queue message. That
Workflow then claims the same object row, performs one processing unit, records
failure, creates a numbered redrive message, and settles the row. `WorkspaceDO`
already owns the authoritative event, processing lease, attempt, and terminal
state. The Workflow is therefore being used primarily for retry and terminal
retention—the capabilities Cloudflare Queues already provides through
at-least-once delivery, per-message acknowledgement, explicit retry, and a DLQ.

This is not a capacity project. Rally has no observed throughput pressure, and
the published limit of 5,000 messages per second per queue is far above one
message per connector event, work-stream effect, or Slack ingress action at the
product's present scale. The reason to split is current operational meaning and
failure isolation: Cloudflare recommends separate queues when use cases and
processing requirements differ so an error in one consumer path does not affect
the others. The resources are cheap to recombine if that reasoning changes.

## Goals

1. An operator can identify the affected product flow from the primary queue or
   DLQ name alone: connector event, work-stream effect, or Slack ingress.
2. A canonical connector event reaches exactly one authoritative terminal state
   (`processed` or `failed`) under at-least-once and out-of-order Queue delivery,
   without depending on a per-event Workflow instance.
3. A transient connector-processing failure retries after the producer and the
   original ingress invocation are gone; an exhausted failure remains
   discoverable and replayable from a dedicated regional DLQ.
4. A work-stream mention or participant notification retains the existing
   transactionally committed outbox handoff and gains a dedicated regional
   Queue/DLQ whose backlog is not mixed with connector or Slack Agent work.
5. Every successful, skipped, deferred, retried, failed, and dead-letter-bound
   branch remains queryable through correlated structured logs; queue depth is
   never presented as proof of provider delivery.
6. Global and EU remain independent data planes, with no connector event,
   notification payload, or Slack ingress body crossing regions.
7. All new queues and DLQs are provisioned and verified idempotently by the
   existing deployment preflight, with no Cloudflare dashboard step.

## Non-goals

1. **Remove Durable Object outboxes.** Rejected outright. `queue.send()` cannot
   commit atomically with object SQLite, so a product mutation still commits its
   outbox row in the same transaction and removes it only after the downstream
   authority acknowledges the effect.
2. **Replace connector polling with Queue.** Rejected for this evolution.
   `CONNECTOR_POLL_WORKFLOW` owns provider network calls, stream-local
   checkpoints, and independently recorded partial outcomes; the incident and
   duplicated retry machinery are on the post-ingress event processor.
3. **Replace opportunity/model Workflows.** Rejected for this evolution. Those
   Workflows isolate long model compute and persist meaningful multi-step
   boundaries; they are not one Queue-shaped processing callback.
4. **Create one queue per connector provider.** Rejected outright at Rally's
   scale. GitHub, Google, Linear, Notion, and the other adapters share one
   normalized event contract and one consumer policy. Provider-specific queues
   would add resources without changing the destination or failure semantics.
5. **Promise exactly-once Queue delivery or ordered delivery.** Rejected because
   Cloudflare guarantees neither. Idempotency receipts, processing claims,
   authority generations, and waterlines continue to make duplicates and
   reordering safe.
6. **Build a queue-depth dashboard or a second retry ledger.** Rejected. Native
   Queue state, a dedicated DLQ, authoritative object state, and structured
   terminal logs are the operating surfaces.
7. **Change notification eligibility or connector routing policy.** Self-mention,
   inactive-recipient, audience, watch, automation, contextual-routing, and
   provider capability decisions remain exactly as they are.

## Product behavior

There is no new desktop or Slack surface. A person mentions a colleague, adds a
participant, connects a provider, or waits for a polled event exactly as before.
The expected visible result remains the existing one: eligible notifications
arrive through configured Slack/email destinations, connector activity reaches
the appropriate work stream or Suggested Work, and ineligible activity is
silently withheld according to current product rules.

The behavior under failure becomes explicit:

- A transient connector, object, inference, Slack, or email failure does not
  depend on the originating Worker invocation remaining alive. Its owning queue
  retries the message.
- A permanent failure moves to the purpose-owned regional DLQ after the declared
  retry policy. Successful siblings continue on their own queues.
- Replaying a connector DLQ message reloads the canonical event from
  `WorkspaceDO`; it does not trust a stale provider body in the DLQ.
- Replaying a work-stream effect remains idempotent through the parent outbox,
  WorkspaceDO receipt, notification intent, and provider idempotency key.
- An empty queue means only that Cloudflare has no pending messages in that
  lane. The correlated terminal log and authoritative row say what happened.

## Impact on the product contract

None—this refines the reliability and operability of connector activity,
notifications, and Slack ingress within the existing Rally contract. It does
not change what a work stream is, who participates, what an agent may do, or
which activity should reach a person.

## Decision log

None yet.

## Key design decisions

1. **Split by processing contract, not provider.** The three lanes are
   `connector-events`, `workstream-effects`, and `slack-ingress`, each split by
   region. Their destinations, payload shapes, and terminal outcomes differ
   today. The rejected alternatives were the current multiplexed queue, whose
   operational state is ambiguous, and per-provider queues, whose consumers and
   policies would be identical.
2. **Use Queue retry for canonical connector processing.** A
   `connector_event_process` message carries only region, workspace ID, and
   canonical event ID. The consumer loads, claims, and settles the event in
   `WorkspaceDO`. The rejected alternative was retaining a Workflow whose one
   substantive step performs the same unit and whose surrounding steps
   duplicate the object's attempt and settlement ledger.
3. **Keep the transactional outbox before every Queue send that follows a
   product mutation.** Native Queue provides durable delivery after acceptance;
   it does not make acceptance atomic with SQLite. Removing the outbox would
   reintroduce the crash window this architecture exists to close.
4. **Give each regional primary queue its own regional DLQ.** A shared DLQ would
   merge the flows and regions again at the exact point where isolation matters.
   The rejected alternative was relying on logs alone: logs explain outcomes,
   but they do not retain an exhausted message for replay.
5. **Keep terminal logs even after queues are separated.** Queue state describes
   transport, not product or provider state. A notification can be correctly
   skipped after the queue drains, and a connector event can be accepted by a
   queue before any product mutation happens.
6. **Use platform-generated Queue message IDs as processing lease owners.** The
   Queue supplies the delivery identity; Rally does not build another external
   identifier template. WorkspaceDO remains the dedupe authority for duplicate
   messages with different delivery IDs.

## Data model

The canonical connector tables stay in `WorkspaceDO`. The connector-event
processing claim is renamed conceptually from Workflow ownership to delivery
ownership:

- `workflow_instance_id` becomes `processing_owner_id` on the authoritative
  event and claim protocol.
- Existing nonterminal Workflow-owned rows remain readable during rollout and
  are either completed by their existing Workflow or released for Queue claim
  by the reconciliation phase.
- `processing_attempt`, `processing_status`, error code, and terminal timestamps
  remain authoritative and retain their current meaning.

The Queue carries two strict connector message variants:

- `connector_event_ingress`: the current bounded normalized event, content hash,
  region, workspace, ingress ID, and requested attempt.
- `connector_event_process`: schema version, region, workspace ID, and canonical
  event ID only. The body is loaded from the object after claim.

No regional D1 product row or new cross-workspace index is introduced.

## Regional impact

Global gets `avalon-global-connector-events`,
`avalon-global-workstream-effects`, and `avalon-global-slack-ingress`, plus one
DLQ named after each. EU gets the corresponding `avalon-eu-*` resources. The
same binding names point at different physical queues in the two Wrangler files.

Every message carries and validates its region even though the binding implies
it. A misrouted message fails in that region; there is no Global fallback. Raw
provider bytes remain in regional R2, connector product state and notification
intents remain in the workspace's regional Durable Objects, and EU messages are
consumed only by the EU Worker.

## Security and trust model

The trust boundaries do not widen. Provider webhooks are verified and polling
credentials authorized before enqueue. Every queue body is parsed with a strict
schema at the consumer. Connector processing reloads canonical content from
WorkspaceDO rather than treating a replayed pointer as authority. Work-stream
effects continue to verify their payload hash, route generation, current
membership, recipient activity, audience, and directory version before
delivery.

Logs include opaque Rally and provider IDs needed for correlation—workspace,
work stream, connection, event, user, channel, message, notification intent,
Queue delivery, and processing owner IDs. Provider content, credentials,
emails, names, work-stream text, Slack message bodies, and notification bodies
remain excluded.

## Provider configuration

No Google, Slack, GitHub, Linear, Notion, email, or other provider setting
changes. Cloudflare resources are declared in both regional Wrangler files and
created or updated by `scripts/ensure-cloudflare-queues.mjs` during deploy. A
deployment fails before either region ships if a producer/consumer name is
unpaired, a queue has two consumers, or the declared inventory is incomplete.

## Rollout

1. Declare and automatically provision the six regional primary queues and six
   DLQs. Add explicit `batch.queue` dispatch and contract tests before moving a
   producer.
2. Move work-stream effect and Slack ingress producers to their dedicated
   bindings. Preserve the current batch window and retry policy during cutover;
   changing those numbers is a separate decision requiring evidence.
3. Move connector ingress to `CONNECTOR_EVENT_QUEUE`, add the canonical process
   message, and let new events use Queue processing. Keep
   `ConnectorEventWorkflow` deployed for instances admitted before the cutover.
4. Reconcile nonterminal connector rows: leave live Workflow claims alone;
   enqueue only rows with no live owner or a released failed claim. Both paths
   settle through the same WorkspaceDO fence.
5. After the old activity queues are empty and their DLQs have no unresolved
   messages, remove their consumers and producer bindings. After the Workflow
   retention window and reconciliation are clear, remove
   `CONNECTOR_EVENT_WORKFLOW` and its class/export.

Every phase is an ordinary EU-first then Global deployment with the existing
health gate. There is no dual write and no dashboard mutation.

## Acceptance

1. Configuration and deployment-script tests prove every new primary queue has
   exactly one producer declaration, one regional consumer, one same-region
   DLQ, and an explicit dispatch branch.
2. Contract tests reject a connector, effect, or Slack message delivered to the
   wrong queue handler or region; no handler falls through to another schema.
3. Duplicate and out-of-order connector process messages converge on one
   authoritative event. A processed event acknowledges without repeating side
   effects; an active claim defers; a released failed claim advances one
   attempt.
4. An injected transient connector-processing failure retries and later settles
   `processed`. An injected permanent failure settles `failed`, exhausts into
   the connector DLQ, and a replay converges without re-ingesting provider
   content.
5. Work-stream effect tests prove the child/parent outbox row survives Queue send
   failure, is removed only after WorkspaceDO acceptance, and duplicate Queue
   delivery does not duplicate an activity or notification.
6. Notification tests cover delivered, self-mention, inactive recipient,
   missing destination, provider rejection, provider retry, and already-terminal
   replay, with one correlated terminal/deferred/failure log on every branch.
7. Global and EU Wrangler dry-run builds expose only their own queue names and
   bindings. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, and
   both API builds pass on the final implementation.
