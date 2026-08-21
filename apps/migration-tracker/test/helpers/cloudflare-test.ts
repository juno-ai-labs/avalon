/**
 * Centralized, typed construction for the workerd test doubles this package
 * needs, following the pattern in `apps/api/test/helpers/cloudflare-test.ts`.
 *
 * A `MessageBatch` is produced by the runtime and cannot be constructed, so the
 * consumer's batch behavior — which messages get acknowledged and which are
 * left for redelivery — can only be tested against a double. The completeness
 * assertion lives here, where it cannot spread through the test files.
 */

export interface TestMessage<Body> {
  id: string;
  body: Body;
  acked: boolean;
  retried: boolean;
}

export interface TestMessageBatch<Body> {
  batch: MessageBatch<Body>;
  messages: TestMessage<Body>[];
}

/**
 * Build a batch whose per-message `ack()` and `retry()` calls are observable.
 *
 * The recorded flags are the point: the consumer's contract is that a message
 * it cannot ever process is acknowledged, and everything else is left alone so
 * a failed write redelivers it.
 */
export function createTestMessageBatch<Body>(
  bodies: readonly Body[],
  queue = "test-queue",
): TestMessageBatch<Body> {
  const messages: TestMessage<Body>[] = bodies.map((body, index) => ({
    id: `message-${index}`,
    body,
    acked: false,
    retried: false,
  }));

  const batch = {
    queue,
    messages: messages.map((message) => ({
      id: message.id,
      timestamp: new Date(0),
      body: message.body,
      attempts: 1,
      ack: () => {
        message.acked = true;
      },
      retry: () => {
        message.retried = true;
      },
    })),
    ackAll: () => {
      for (const message of messages) message.acked = true;
    },
    retryAll: () => {
      for (const message of messages) message.retried = true;
    },
  };

  return { batch: batch as unknown as MessageBatch<Body>, messages };
}
