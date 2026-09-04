import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceConnectorEventQueueMessageSchema } from "../src/durable-objects/workspace-connector-event-protocol";
import type { HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { devRoutes } from "../src/routes/dev";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";

/** The routes behind the app's error boundary, so a refusal reads as the API answers it. */
const app = new Hono<HonoAppEnv>().onError(errorHandler).route("/dev", devRoutes);

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000f1";
const CONNECTION_ID = "00000000-0000-7000-8000-0000000000f2";

function eventBody(providerEventId: string, title = "Deploy finished") {
  return {
    workspaceId: WORKSPACE_ID,
    connectorType: "generic_webhook",
    activity: {
      connectionId: CONNECTION_ID,
      provider: "generic_webhook",
      providerEventId,
      eventType: "deploy.finished",
      title,
      occurredAt: "2026-09-04T00:00:00.000Z",
      metadata: { environment: "production" },
    },
  };
}

async function post(env: ReturnType<typeof createTestEnv>, body: unknown) {
  const response = await app.request("/dev/connector-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, env);
  return { status: response.status, json: await response.json() as { activityId?: string } };
}

describe("the synthetic connector-event ingress", () => {
  it("gives the same provider event the same identity on every post, so a replay is a replay", async () => {
    const sent: unknown[] = [];
    const env = createTestEnv({
      APP_ENV: "development",
      RALLY_DEV_AUTH: "true",
      AVALON_REGION: "global",
      ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({
        send: vi.fn(async (message: unknown) => {
          sent.push(message);
        }),
      }),
    });

    const first = await post(env, eventBody("evt-1"));
    const replay = await post(env, eventBody("evt-1"));
    const other = await post(env, eventBody("evt-2"));

    // The workspace ledger keys an event on its id and refuses the id when the
    // content differs. A fresh id per post could never express a replay, and
    // a replay with different content under the same id is the poison pill
    // the consumer now drops; both need the id to follow the event.
    expect(first.status).toBe(202);
    expect(replay.json.activityId).toBe(first.json.activityId);
    expect(other.json.activityId).not.toBe(first.json.activityId);

    const messages = sent.map((message) => WorkspaceConnectorEventQueueMessageSchema.parse(message));
    expect(messages.map((message) => message.request.ingressEventId)).toEqual([
      first.json.activityId,
      first.json.activityId,
      other.json.activityId,
    ]);
    expect(messages[0]!.request.payloadHash).toBe(messages[1]!.request.payloadHash);
  });

  it("is absent outside development", async () => {
    const env = createTestEnv({
      APP_ENV: "test",
      RALLY_DEV_AUTH: "true",
      AVALON_REGION: "global",
      ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({ send: vi.fn(async () => undefined) }),
    });

    const response = await app.request("/dev/connector-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(eventBody("evt-1")),
    }, env);

    expect(response.status).toBe(404);
  });
});
