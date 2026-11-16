import { SlackIngressQueueMessageSchema } from "@rally/contracts";
import { z } from "zod";

import type { Env } from "../env";

/**
 * Every kind of message the interactive queue carries: inbound work a person
 * is waiting on Rally to answer. Each kind names its `region` and
 * `workspaceId`, which the consumer reads for every kind alike.
 *
 * Adding a kind is two entries: its schema here, and its handler in
 * `queues/interactive-consumer.ts`, whose handler table will not compile
 * without it. See docs/interactive-queue.md for what belongs on this queue.
 */
export const InteractiveQueueMessageSchema = z.discriminatedUnion("kind", [
  SlackIngressQueueMessageSchema,
]);
export type InteractiveQueueMessage = z.infer<typeof InteractiveQueueMessageSchema>;
export type InteractiveKind = InteractiveQueueMessage["kind"];

/** The regional interactive queue, whatever region's config named it. */
export function isInteractiveQueue(queue: string): boolean {
  return queue.endsWith("-interactive");
}

/**
 * Put work a person is waiting on onto the interactive queue. The one way
 * onto it: the message is checked against the registered kinds, so nothing
 * reaches the queue that its consumer cannot read.
 */
export async function sendInteractive(
  env: Pick<Env, "INTERACTIVE_QUEUE">,
  message: InteractiveQueueMessage,
  options: { delaySeconds?: number } = {},
): Promise<void> {
  const body = InteractiveQueueMessageSchema.parse(message);
  if (options.delaySeconds === undefined) await env.INTERACTIVE_QUEUE.send(body);
  else await env.INTERACTIVE_QUEUE.send(body, { delaySeconds: options.delaySeconds });
}
