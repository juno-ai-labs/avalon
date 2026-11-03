import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { connectorRetryAfterMs } from "@rally/connectors";

import type { Env } from "../env";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import {
  InteractiveQueueMessageSchema,
  type InteractiveKind,
  type InteractiveQueueMessage,
} from "../services/interactive-queue";
import { SlackAgentService } from "../services/slack-agent-service";

/**
 * What one kind of interactive work does. `run` does the work and throws to
 * have it retried; everything every kind shares (the region check, ack,
 * retry and backoff, the dead-letter path, the log lines) is the consumer's.
 */
interface InteractiveHandler<K extends InteractiveKind> {
  /** Identifiers that name this message in its log lines; never content. */
  fields(message: Extract<InteractiveQueueMessage, { kind: K }>): Record<string, string>;
  run(env: Env, message: Extract<InteractiveQueueMessage, { kind: K }>): Promise<void>;
}

/** One handler per kind; a kind added to the contract without one does not compile. */
const HANDLERS: { [K in InteractiveKind]: InteractiveHandler<K> } = {
  slack_ingress: {
    fields: (message) => ({ job_id: message.jobId }),
    run: (env, message) => new SlackAgentService(env).processQueuedIngress(message.workspaceId, message.jobId),
  },
};

/**
 * The interactive queue: inbound work a person is waiting on Rally to answer,
 * on its own resource so it never waits behind the activity queue's backlog.
 * See docs/interactive-queue.md.
 */
export async function consumeInteractiveQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    const parsed = InteractiveQueueMessageSchema.safeParse(message.body);
    if (parsed.success) {
      await runInteractiveMessage(message, parsed.data, env);
      return;
    }
    // Nothing reads this body here: a producer bypassed `sendInteractive`, or
    // shipped ahead of this consumer. Retried rather than acked, so it ends
    // in the dead-letter queue, where it is kept and seen.
    logWarn(env, "interactive_queue_message_unrecognized", {
      code: zodDiagnosticCode(parsed.error, "interactive_queue_message") ?? "interactive_queue_message_unrecognized",
      queue_attempts: message.attempts,
    });
    message.retry();
  }));
}

/**
 * Run one interactive message and settle it. Exported for the activity
 * consumer, which hands over any interactive kind it still receives, such as
 * one queued there before its kind moved to this queue.
 */
export async function runInteractiveMessage(
  message: Message<unknown>,
  body: InteractiveQueueMessage,
  env: Env,
): Promise<void> {
  const handler = HANDLERS[body.kind] as InteractiveHandler<InteractiveKind>;
  const fields = {
    workspace_id: body.workspaceId,
    ...handler.fields(body),
    queue_attempts: message.attempts,
  };
  if (body.region !== env.AVALON_REGION) {
    logInfo(env, `${body.kind}_queue_terminal`, { ...fields, outcome: "skipped", reason: "region_mismatch" });
    message.ack();
    return;
  }
  try {
    await handler.run(env, body);
    logInfo(env, `${body.kind}_queue_terminal`, { ...fields, outcome: "processed", reason: "completed" });
    message.ack();
  } catch (error) {
    logWarn(env, `${body.kind}_queue_processing_failed`, {
      ...fields,
      reason: diagnosticErrorCode(error, `${body.kind}_queue_processing_failed`),
    });
    message.retry({ delaySeconds: interactiveRetryDelaySeconds(message.attempts, error) });
  }
}

/**
 * Exponential from 5 s, capped at 300 s, unless a provider asked for longer
 * (capped at 12 hours, the Queue's own ceiling). Carried over unchanged from
 * Slack ingress, whose retry this was.
 */
function interactiveRetryDelaySeconds(attempts: number, error: unknown): number {
  const exponential = Math.min(300, 5 * 2 ** Math.min(Math.max(1, attempts) - 1, 6));
  const provider = Math.ceil((connectorRetryAfterMs(error) ?? 0) / 1_000);
  return Math.min(43_200, Math.max(exponential, provider));
}
