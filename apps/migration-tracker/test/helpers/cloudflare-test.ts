/**
 * Centralized, typed construction for the workerd test doubles this package
 * needs, following the pattern in `apps/api/test/helpers/cloudflare-test.ts`.
 *
 * A `MessageBatch` is produced by the runtime and cannot be constructed, so the
 * consumer's batch behavior — which messages get acknowledged and which are
 * left for redelivery — can only be tested against a double. The completeness
 * assertion lives here, where it cannot spread through the test files.
 */

import type { Env } from "../../src/env";

/**
 * An `Env` with the sweep's two credentials set, cleared, or absent.
 *
 * Here rather than inline in a test because the alternative is an `as Env`
 * cast, and a cast would keep compiling if a required binding were ever added
 * to `Env` — which is the drift the lint rule exists to catch. Omitting a key
 * rather than assigning `undefined` is deliberate: under
 * `exactOptionalPropertyTypes` those are different types, and "absent" is the
 * shape an unconfigured Worker actually has.
 */
export function envWithSweepCredentials(
  base: Env,
  credentials: { accountId?: string; apiToken?: string },
): Env {
  const next = { ...base };
  if (credentials.accountId === undefined) delete next.CLOUDFLARE_ACCOUNT_ID;
  else next.CLOUDFLARE_ACCOUNT_ID = credentials.accountId;
  if (credentials.apiToken === undefined) delete next.CLOUDFLARE_API_TOKEN;
  else next.CLOUDFLARE_API_TOKEN = credentials.apiToken;
  return next;
}

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

export interface RecordingQueue<Body> {
  queue: Queue<Body>;
  /** Every body the queue accepted, flattened across `send` and `sendBatch`. */
  sent: Body[];
  /** One entry per `sendBatch` call, so batching itself can be asserted on. */
  batches: number[];
}

/**
 * A queue binding whose accepted messages are observable.
 *
 * Typed as `Queue<Body>` here rather than cast at each call site, for the same
 * reason `envWithSweepCredentials` exists: a cast would keep compiling if the
 * binding's shape changed, and the dispatcher's whole contract is what it puts
 * on the queue.
 *
 * `failAfter` makes the queue refuse once a given number of messages have been
 * accepted, which is the only way to exercise a fan-out that dies partway — the
 * case where the recorded run has to describe what actually landed rather than
 * what was intended.
 */
export function createRecordingQueue<Body>(
  options: { failAfter?: number } = {},
): RecordingQueue<Body> {
  const sent: Body[] = [];
  const batches: number[] = [];
  const guard = (count: number): void => {
    if (options.failAfter !== undefined && sent.length + count > options.failAfter) {
      throw new Error("queue_refused");
    }
  };
  const queue = {
    send: async (body: Body) => {
      guard(1);
      sent.push(body);
    },
    sendBatch: async (messages: Iterable<{ body: Body }>) => {
      const bodies = [...messages].map((message) => message.body);
      guard(bodies.length);
      batches.push(bodies.length);
      sent.push(...bodies);
    },
  };
  return { queue: queue as unknown as Queue<Body>, sent, batches };
}
