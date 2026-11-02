# Interactive queue

The interactive queue carries inbound work a person is waiting on Rally to
answer, on a Cloudflare Queue of its own, so that work never waits behind the
activity queue's backlog. Today it carries Slack ingress: every event,
interaction and command the Slack edge admits.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/queues/interactive-consumer.ts` | `isInteractiveQueue`, `consumeInteractiveQueue`, and `consumeSlackIngressMessage`, the one handler for a Slack ingress job. |
| `apps/api/src/worker-events.ts` | Dispatches a batch from the interactive queue to its consumer, after the maintenance gate. |
| `apps/api/src/services/slack-agent-service.ts` | The Slack producers: `enqueueIngressJob`, and the recovery and reauthorization re-drives in `maintainIngress`. |
| `apps/api/src/durable-objects/workspace-do.ts` | The Sidekick source-join producer (`slack_ingress` jobs from `enqueueSlackSourceJoins`). |
| `apps/api/wrangler.global.jsonc` | `INTERACTIVE_QUEUE` → `avalon-global-interactive`, its consumer settings, and `avalon-global-interactive-dead-letter`. |

## How it works

1. **A producer sends to `INTERACTIVE_QUEUE`.** The Slack edge writes the
   ingress job to WorkspaceDO, then sends its opaque id as a `slack_ingress`
   message ([`slack-integration.md`](slack-integration.md)). The recovery
   sweep and the reauthorization re-drive send the same message kind to the
   same queue.
2. **The Worker dispatches by queue name.** `isInteractiveQueue` matches
   `*-interactive`, and `worker-events.ts` routes that batch to
   `consumeInteractiveQueue` after the work-stream maintenance gate. Admitting
   a Slack message is new work-stream work, so it waits out maintenance like
   the activity queue does.
3. **The consumer settles each message on its own.** A `slack_ingress` message
   runs `SlackAgentService.processQueuedIngress` and is acked, or retried with
   the delay the job's failure asks for. A body the consumer does not read is
   retried, so it ends in the dead-letter queue rather than vanishing.

## Invariants

- **Only work a person is waiting on.** A reply in a Sidekick's Slack thread,
  a mention, a DM, a slash command. Work nobody is waiting on (projections,
  backfills, search indexing, connector events that trigger Sidekicks) stays
  on the activity queue, or this queue gains a backlog of its own and stops
  being worth having. A job kind goes here whole: Slack ingress includes
  Sidekick source joins and trigger-only channel activity, which is far too
  little volume to be worth splitting one job kind across two transports.
- **One consumer handles a Slack ingress job, whichever queue carried it.**
  `consumeSlackIngressMessage` is shared by both consumers, so a job queued on
  the activity queue before Slack ingress moved still drains.
- **Split per region,** like the activity queue: a job names a workspace whose
  WorkspaceDO lives in that region. The binding is `INTERACTIVE_QUEUE` in every
  region's config.

## Boundary

The queue is transport. What a Slack ingress job does, its lease, retry and
exhaustion live in WorkspaceDO and [`slack-integration.md`](slack-integration.md).
Replies Rally posts back to Slack do not use this queue: the run posts them
directly.

## Failure modes and limits

- **The consumer settings are the activity queue's**, which Slack ingress
  already ran under: one message per invocation, a one-second window, five
  retries, then `avalon-global-interactive-dead-letter`. Moving the jobs
  changed which backlog they wait behind and nothing else. Retuning them is
  the team's call.
- **A non-empty interactive dead-letter queue** means a Slack job, or a
  misrouted message, failed every retry.
- **A long Slack backlog would still delay Slack replies.** Slack's volume is a
  few messages a second at most, against 5,000 per second per queue.

## Testing

- `apps/api/test-workers/queue-dispatch.test.ts` (real workerd): the
  interactive queue waits behind maintenance, reaches its own consumer once
  the gate is open, and retries a body it does not read, where the activity
  consumer acks it.
- `apps/api/test/slack-agent-ingress.test.ts`,
  `slack-workspace-assignment.test.ts`, `slack-thread-audience.test.ts` and
  `slack-account-link.test.ts`: their environments carry only
  `INTERACTIVE_QUEUE` for Slack ingress, so a Slack producer that sends to the
  activity queue fails them.

## Changelog

### 2026-11-02 — Slack ingress gets a queue of its own

**What changed:** Slack ingress jobs moved from `avalon-global-activities` to
the new `avalon-global-interactive` queue, with its own consumer and
dead-letter queue. The activity consumer still drains Slack jobs queued there
before the move.

**Why:** Replies in a Sidekick's Slack thread took 10 to 15 minutes to reach
the run. The Slack edge answered in under a second, but the job then waited
on the activity queue, which takes one message per invocation, behind a
conversation-view backfill looping on one thread (fixed in #1467). Any future
backlog there would have done the same, because Slack ingress shared a queue
with every projection and backfill. The access-revocation queue was split out
for the same reason.

**Rejected:** RPC from the Slack edge straight to the run, which would hold
Slack's three-second acknowledgement open on a cold conversation object and
lose the Queue's retry and dead-letter queue. Splitting `slack_ingress` by
whether a person is waiting, which puts one job kind on two transports for
trigger-only traffic too small to matter. A priority within the activity
queue, which Cloudflare Queues does not offer.

**What a future change has to respect:** put a new kind of work here only if a
person is waiting on Rally's answer to it, and keep everything else on the
activity queue.
