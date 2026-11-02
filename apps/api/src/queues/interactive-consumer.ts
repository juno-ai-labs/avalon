import { SlackIngressQueueMessageSchema, type SlackIngressQueueMessage } from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { connectorRetryAfterMs } from "@rally/connectors";

import type { Env } from "../env";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import { SlackAgentService } from "../services/slack-agent-service";

/**
 * The interactive queue: inbound work a person is waiting on Rally to answer.
 *
 * It is its own resource so that this work never waits behind the activity
 * queue's backlog of projections, backfills and search indexing. Today it
 * carries Slack ingress; anything else a person addresses to Rally and
 * waits on belongs here too, and nothing else does. See
 * docs/interactive-queue.md.
 */
export function isInteractiveQueue(queue: string): boolean {
  return queue.endsWith("-interactive");
}

/** Each message is handled and settled on its own, so one failure retries alone. */
export async function consumeInteractiveQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map((message) => consumeInteractiveMessage(message, env)));
}

async function consumeInteractiveMessage(message: Message<unknown>, env: Env): Promise<void> {
  const slackIngress = SlackIngressQueueMessageSchema.safeParse(message.body);
  if (slackIngress.success) {
    await consumeSlackIngressMessage(message, slackIngress.data, env);
    return;
  }
  // Nothing reads this body here: a producer sent work to the wrong queue, or
  // shipped ahead of this consumer. Retried rather than acked, so it ends in
  // the dead-letter queue, where it is kept and seen, instead of vanishing.
  logWarn(env, "interactive_queue_message_unrecognized", {
    code: zodDiagnosticCode(slackIngress.error, "interactive_queue_message") ?? "interactive_queue_message_unrecognized",
    queue_attempts: message.attempts,
  });
  message.retry();
}

/**
 * One Slack ingress job: the event, interaction or command WorkspaceDO
 * admitted at the edge, run now. Shared with the activity consumer, which
 * still drains jobs queued there before Slack ingress moved here.
 */
export async function consumeSlackIngressMessage(
  message: Message<unknown>,
  job: SlackIngressQueueMessage,
  env: Env,
): Promise<void> {
  if (job.region !== env.AVALON_REGION) {
    logInfo(env, "slack_ingress_queue_terminal", {
      workspace_id: job.workspaceId,
      job_id: job.jobId,
      outcome: "skipped",
      reason: "region_mismatch",
      queue_attempts: message.attempts,
    });
    message.ack();
    return;
  }
  try {
    await new SlackAgentService(env).processQueuedIngress(job.workspaceId, job.jobId);
    logInfo(env, "slack_ingress_queue_terminal", {
      workspace_id: job.workspaceId,
      job_id: job.jobId,
      outcome: "processed",
      reason: "ingress_job_completed",
      queue_attempts: message.attempts,
    });
    message.ack();
  } catch (error) {
    logWarn(env, "slack_ingress_queue_processing_failed", {
      workspace_id: job.workspaceId,
      job_id: job.jobId,
      queue_attempts: message.attempts,
      reason: diagnosticErrorCode(error, "slack_ingress_queue_processing_failed"),
    });
    const attempts = Math.max(1, message.attempts);
    const exponentialDelay = Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6));
    const providerDelay = Math.ceil((connectorRetryAfterMs(error) ?? 0) / 1_000);
    message.retry({ delaySeconds: Math.min(43_200, Math.max(exponentialDelay, providerDelay)) });
  }
}
