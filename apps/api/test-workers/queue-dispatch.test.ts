import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { AccessRevocationMessageSchema } from "../src/services/access-revocation";

/**
 * The Worker's own queue entry point, on real workerd.
 *
 * It lives here rather than in the Node suite because importing `src/index.ts`
 * pulls in `cloudflare:workers`, which only the runtime provides.
 */
const WORKSPACE = "00000000-0000-7000-8000-0000000000f1";
const USER = "00000000-0000-7000-8000-0000000000f2";

function batchOf(queue: string, body: unknown): MessageBatch<unknown> {
  return {
    queue,
    messages: [{
      id: "one",
      timestamp: new Date("2026-08-22T12:00:00.000Z"),
      body,
      attempts: 1,
      ack: () => undefined,
      retry: () => undefined,
    }],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: () => undefined,
    ackAll: () => undefined,
  } satisfies MessageBatch<unknown>;
}

/**
 * The runtime environment plus the contract keys `wrangler.test.jsonc` does not
 * carry. `withEnvContract` checks presence, not shape, and none of these is on
 * the path under test — the bindings that are (D1, the object namespaces, the
 * queues) come from the real runtime env.
 */
const contractComplete = {
  ...env,
  AI: {}, PAYLOADS: {}, TELEMETRY_PAYLOADS: {}, IMAGES: {},
  RUN_ANALYTICS: {}, TERMINAL_ANALYTICS: {}, CRASH_SYMBOLICATOR: {},
  CONNECTOR_POLL_WORKFLOW: {}, CONNECTOR_EVENT_WORKFLOW: {},
  CONNECTOR_CREDENTIALS_KEY: "credentials-secret",
  CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
  OAUTH_STATE_ENCRYPTION_KEY: "oauth-secret",
  SESSION_SIGNING_KEY: "session-secret",
  OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
  OPENROUTER_FALLBACK_MODEL: "google/gemini-3.6-flash",
  OPENROUTER_FASTER_MODEL: "google/gemini-2.5-flash-lite",
  TOOL_DEFAULT_TIMEOUT_MS: "30000",
  WEB_SEARCH_MAX_RESULTS: "8",
  WEB_FETCH_MAX_BYTES: "2000000",
  MAX_ATTACHMENT_BYTES: "25000000",
  WEBHOOK_REPLAY_WINDOW_SECONDS: "300",
} as unknown as typeof env;

/** A one-message batch whose ack and retry can be observed. */
function settledBatch(queue: string, body: unknown, attempts = 1) {
  const ack = vi.fn();
  const retry = vi.fn();
  const base = batchOf(queue, body);
  const batch = { ...base, messages: [{ ...base.messages[0]!, attempts, ack, retry }] };
  return { batch: batch satisfies MessageBatch<unknown>, ack, retry };
}

/** Open the work-stream authority, so batches pass the maintenance gate. */
async function openAuthority(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL, serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
  ]);
}

const revocation = AccessRevocationMessageSchema.parse({
  kind: "access_revoked",
  reason: "workspace_membership_removed",
  workspaceId: WORKSPACE,
  userId: USER,
  sessionId: null,
  target: { scope: "workspace" },
  occurredAt: "2026-08-22T12:00:00.000Z",
});

it("routes HTTP without reading the completed Channel cutover row", async () => {
  // D1 has no schema in this fixture. The retired global gate returned 503
  // before Hono could reach its authentication middleware.
  const response = await worker.fetch(
    new Request("https://api.rallywith.ai/no-such-route"),
    contractComplete,
    createExecutionContext(),
  );
  expect(response.status).toBe(401);
});

describe("dispatching a queue batch", () => {
  // This suite's D1 starts with no schema, so `workstream_authority_control`
  // does not exist and the authority reads as the legacy open state, whose
  // serving contract the gate refuses as new work-stream work.
  it("carries a revocation while maintenance refuses everything else", async () => {
    // Nothing else closes an open socket, so a revocation held behind the gate
    // retries into the dead-letter queue while the sockets it names keep
    // receiving. It reaches the object; only the activity batch is refused.
    const carried = settledBatch("avalon-do-runtime-test-access-revocations", revocation);
    await worker.queue?.(carried.batch, contractComplete);
    expect([carried.ack.mock.calls.length, carried.retry.mock.calls]).toEqual([1, []]);

    const held = settledBatch("avalon-do-runtime-test-activities", {});
    await worker.queue?.(held.batch, contractComplete);
    expect(held.ack).not.toHaveBeenCalled();
    expect(held.retry.mock.calls).toEqual([[{ delaySeconds: 5 }]]);
  });

  it("backs off a refused batch instead of redelivering it at once", async () => {
    const third = settledBatch("avalon-do-runtime-test-activities", {}, 3);
    await worker.queue?.(third.batch, contractComplete);
    expect(third.ack).not.toHaveBeenCalled();
    expect(third.retry.mock.calls).toEqual([[{ delaySeconds: 20 }]]);
  });

  it("names why the authority read failed closed when it refuses a batch", async () => {
    // A table with no control row fails closed as `quarantined`, the same
    // branch a D1 error takes; the log is the only record of the reason.
    await env.DB.exec("CREATE TABLE IF NOT EXISTS workstream_authority_control (id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL, required_serving_contract_version INTEGER NOT NULL, serving_contract_version INTEGER NOT NULL)");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const held = settledBatch("avalon-do-runtime-test-activities", {});
      await worker.queue?.(held.batch, { ...contractComplete, LOG_LEVEL: "warn" } as typeof env);
      expect(held.retry.mock.calls).toEqual([[{ delaySeconds: 5 }]]);
      const logged = warn.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter((entry) => entry.event === "queue_maintenance_retry")
        .map((entry) => [entry.code, entry.queue_attempts]);
      expect(logged).toEqual([["workstream_maintenance:quarantined:0:authority_control_row_missing", 1]]);
    } finally {
      warn.mockRestore();
      await env.DB.exec("DROP TABLE IF EXISTS workstream_authority_control");
    }
  });

  it("carries inference lakehouse delivery while maintenance refuses product work", async () => {
    // An invalid pointer is poison and is acknowledged by the inference
    // consumer. Reaching that consumer proves dispatch happens before the D1
    // maintenance fence; an unknown queue would reject below instead.
    const carried = settledBatch("avalon-global-inference-lakehouse", { invalid: true });
    await worker.queue?.(carried.batch, contractComplete);
    expect([carried.ack.mock.calls.length, carried.retry.mock.calls]).toEqual([1, []]);
  });

  it("carries usage while maintenance refuses product work", async () => {
    // An unreadable usage event is acknowledged by the usage consumer, so
    // reaching it proves the meter is dispatched before maintenance.
    const carried = settledBatch("avalon-global-usage", { invalid: true });
    await worker.queue?.(carried.batch, contractComplete);
    expect([carried.ack.mock.calls.length, carried.retry.mock.calls]).toEqual([1, []]);
  });

});

describe("dispatching interactive work", () => {
  const INTERACTIVE = "avalon-do-runtime-test-interactive";

  it("holds interactive work behind the maintenance gate, as new work-stream work", async () => {
    const held = settledBatch(INTERACTIVE, {});
    await worker.queue?.(held.batch, contractComplete);
    expect(held.ack).not.toHaveBeenCalled();
    expect(held.retry.mock.calls).toEqual([[{ delaySeconds: 5 }]]);
  });

  it("hands the interactive queue to its own consumer once the gate is open", async () => {
    await openAuthority();
    try {
      // A Slack job named for another region is settled and acknowledged.
      const slack = settledBatch(INTERACTIVE, {
        kind: "slack_ingress", region: "eu", workspaceId: WORKSPACE, jobId: "event:Ev1",
      });
      await worker.queue?.(slack.batch, contractComplete);
      expect([slack.ack.mock.calls.length, slack.retry.mock.calls.length]).toEqual([1, 0]);

      // A body nothing reads is retried toward the interactive dead-letter
      // queue. The activity consumer would acknowledge it, so this also shows
      // which consumer ran.
      const unknown = settledBatch(INTERACTIVE, { kind: "not_interactive" });
      await worker.queue?.(unknown.batch, contractComplete);
      expect([unknown.ack.mock.calls.length, unknown.retry.mock.calls.length]).toEqual([0, 1]);
    } finally {
      await env.DB.exec("DROP TABLE IF EXISTS workstream_authority_control");
    }
  });
});
