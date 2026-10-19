import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
  CONNECTOR_POLL_WORKFLOW: {}, CONNECTOR_EVENT_WORKFLOW: {}, WORK_OPPORTUNITY_WORKFLOW: {},
  DEMO_PREPARATION_WORKFLOW: {},
  CONNECTOR_CREDENTIALS_KEY: "credentials-secret",
  CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
  OAUTH_STATE_ENCRYPTION_KEY: "oauth-secret",
  SESSION_SIGNING_KEY: "session-secret",
  OPENROUTER_PRIMARY_MODEL: "x-ai/grok-4.3",
  OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash",
  OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
  OPENROUTER_STRUCTURED_MODEL: "google/gemini-2.5-flash-lite",
  TOOL_DEFAULT_TIMEOUT_MS: "30000",
  WEB_SEARCH_MAX_RESULTS: "8",
  WEB_FETCH_MAX_BYTES: "2000000",
  MAX_ATTACHMENT_BYTES: "25000000",
  WEBHOOK_REPLAY_WINDOW_SECONDS: "300",
} as unknown as typeof env;

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
  // does not exist and the authority reads as quarantined — the state in which
  // the gate refuses new work-stream work.
  it("carries a revocation while maintenance refuses everything else", async () => {
    // Nothing else closes an open socket, so a revocation held behind the gate
    // retries into the dead-letter queue while the sockets it names keep
    // receiving. It reaches the object; only the activity batch is refused.
    await expect(
      worker.queue?.(batchOf("avalon-do-runtime-test-access-revocations", revocation), contractComplete),
    ).resolves.toBeUndefined();

    await expect(worker.queue?.(batchOf("avalon-do-runtime-test-activities", {}), contractComplete))
      .rejects.toThrow(/workstream_maintenance/);
  });

  it("carries inference lakehouse delivery while maintenance refuses product work", async () => {
    // An invalid pointer is poison and is acknowledged by the inference
    // consumer. Reaching that consumer proves dispatch happens before the D1
    // maintenance fence; an unknown queue would reject below instead.
    await expect(
      worker.queue?.(
        batchOf("avalon-global-inference-lakehouse", { invalid: true }),
        contractComplete,
      ),
    ).resolves.toBeUndefined();
  });

  it("carries usage while maintenance refuses product work", async () => {
    // An unreadable usage event is acknowledged by the usage consumer, so
    // reaching it proves the meter is dispatched before maintenance.
    await expect(worker.queue?.(
      batchOf("avalon-global-usage", { invalid: true }),
      contractComplete,
    )).resolves.toBeUndefined();
  });

  it("carries product flag notifications while maintenance refuses product work", async () => {
    // An unreadable message is poison and is acknowledged. Reaching that
    // consumer proves the configuration path is dispatched before maintenance.
    await expect(worker.queue?.(
      batchOf("avalon-global-product-feature-flags", { invalid: true }),
      contractComplete,
    )).resolves.toBeUndefined();
  });
});
