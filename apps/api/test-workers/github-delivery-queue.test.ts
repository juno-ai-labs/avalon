import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  GitHubDeliveryQueueMessageSchema,
  GitHubRoutingService,
} from "../src/services/github-routing-service";

/**
 * A GitHub delivery through a real Queue, from the Global receiver to the
 * consumer's parse.
 *
 * This lives here rather than in the Node suite because the Queue's own
 * serialization is the behavior under test: the Node suite's queue double
 * hands the consumer the sender's object, so it passed while every inline
 * delivery in production arrived with its ArrayBuffer turned into `{}`.
 */
const SECRET = "shared-github-webhook-secret";

async function signedDelivery(deliveryId: string, payload: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return {
    bytes,
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    },
  };
}

describe("GitHub delivery Queue", () => {
  it("delivers an inline body the consumer can parse and route", async () => {
    const probe = env.QUEUE_PROBE;
    const received = env.QUEUE_PROBE_TEST;
    if (!probe || !received) throw new Error("the queue probe bindings are unavailable");
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS github_installation_routes (
         installation_id TEXT NOT NULL, region TEXT NOT NULL, workspace_id TEXT NOT NULL,
         status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, disabled_at TEXT,
         PRIMARY KEY (installation_id, region))`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO github_installation_routes VALUES ('4242', 'global', 'workspace-global', 'active', ?, ?, NULL)`,
    ).bind(new Date().toISOString(), new Date().toISOString()).run();

    const routingEnv: Env = { ...env, ACTIVITY_QUEUE: probe, GITHUB_WEBHOOK_SECRET: SECRET };
    const dispatched: Uint8Array[] = [];
    const service = new GitHubRoutingService(routingEnv, {
      ingestInRegion: async (_region, delivery) => {
        dispatched.push(new Uint8Array(delivery.rawBody));
        return { accepted: true, duplicate: false, activityCount: 1 };
      },
    });
    const delivery = await signedDelivery("queue-inline-delivery", {
      action: "opened",
      installation: { id: 4242 },
    });

    await service.ingestGitHub(delivery.bytes, delivery.headers);
    const bodies = await vi.waitFor(async () => {
      const all = await received.received();
      expect(all).toHaveLength(1);
      return all;
    }, { timeout: 10_000, interval: 50 });

    const parsed = GitHubDeliveryQueueMessageSchema.safeParse(bodies[0]);
    expect(parsed.error?.issues ?? []).toEqual([]);
    await expect(service.consumeDelivery(parsed.data!)).resolves.toBe("dispatched");
    expect(dispatched).toEqual([delivery.bytes]);
  });
});
