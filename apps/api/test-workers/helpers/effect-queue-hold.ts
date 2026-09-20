/**
 * Keep effect envelopes in their outboxes until a test delivers them.
 *
 * The test Worker binds `ACTIVITY_QUEUE` as a producer with no consumer, and
 * Miniflare accepts a `sendBatch` to such a queue: the object's drain alarm
 * sends, deletes its rows, and the envelope is gone before a test can read it
 * with `pendingChildEffects` or hand it to the consumer with
 * `deliverChildEffects`. Measured, not assumed: an automation's sidebar row was
 * enqueued by `create` and had already left `durable_outbox` by the time the
 * RPC returned.
 *
 * This replaces `sendBatch` for effect envelopes only, on the binding's
 * prototype, which every object in the isolate resolves its call through. A
 * held batch is refused the way a Queue outage refuses it, so the producer
 * defers the rows and keeps them `pending`, and the helpers in
 * `conversation-effects.ts` deliver exactly those rows on demand. Any other
 * message kind passes through to the real binding untouched.
 *
 * Refusing rather than delivering in place is deliberate: a test that wants to
 * assert the state *between* the two legs, or the order in which a parent saw
 * its children, needs the delivery to happen when it says so.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";

import { EffectQueueMessageSchema } from "@rally/contracts/conversation-effects";

type QueueBinding = { sendBatch: (messages: Iterable<MessageSendRequest<unknown>>) => Promise<void> };

function isEffectBody(body: unknown): boolean {
  return EffectQueueMessageSchema.safeParse(body).success;
}

/** Hold every effect envelope produced during each test of the enclosing file. */
export function useHeldEffectQueue(): void {
  beforeEach(() => {
    const prototype = Object.getPrototypeOf(env.ACTIVITY_QUEUE) as QueueBinding;
    const original = prototype.sendBatch;
    vi.spyOn(prototype, "sendBatch").mockImplementation(async function (
      this: QueueBinding,
      messages: Iterable<MessageSendRequest<unknown>>,
    ) {
      const batch = [...messages];
      if (batch.some((message) => isEffectBody(message.body))) {
        throw new Error("effect_queue_held_by_test");
      }
      return original.call(this, batch);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}
