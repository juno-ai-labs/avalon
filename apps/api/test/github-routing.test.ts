import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Region } from "@rally/contracts";
import type { Env } from "../src/env";
import { consumeActivityQueue } from "../src/queues/activity-consumer";
import { webhookIngestionRoutes } from "../src/routes/connections";
import {
  consumeGitHubDeliveryMessage,
  GitHubDeliveryQueueMessageSchema,
  GitHubRoutingService,
  isAllowedGitHubIngressRoute,
  isSharedGitHubIngress,
  serializeGitHubRegionalRpcResult,
} from "../src/services/github-routing-service";
import { ApiError } from "../src/lib/api-error";
import {
  createGitHubInstallState,
  githubRegionFromInstallState,
} from "../src/lib/github-install-state";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// The route table is the real migrated schema. The Queue and R2 are doubles
// because neither runs under Node; the regional ingest is a double because it
// is `ProviderWebhookService`, which `provider-webhooks.test.ts` covers —
// including that `ingestVerifiedGitHub` performs no signature check.

const SECRET = "shared-github-webhook-secret";
const NOW = Date.parse("2026-08-01T18:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
});

class FakeBucket {
  readonly values = new Map<string, ArrayBuffer>();
  readonly deleted: string[] = [];

  async put(key: string, value: ArrayBuffer): Promise<void> {
    this.values.set(key, value.slice(0));
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const value = this.values.get(key);
    return value ? { arrayBuffer: async () => value.slice(0) } : null;
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.values.delete(key);
  }
}

class FakeQueue {
  readonly messages: unknown[] = [];

  async send(message: unknown): Promise<void> {
    this.messages.push(message);
  }
}

interface Fixture {
  sql: DatabaseSync;
  db: D1Database;
  bucket: FakeBucket;
  queue: FakeQueue;
  env: Env;
}

function fixture(): Fixture {
  const sql = migratedSqliteDatabase();
  const db = sqliteD1(sql);
  const bucket = new FakeBucket();
  const queue = new FakeQueue();
  const env = createTestEnv({
    AVALON_REGION: "global",
    GITHUB_INGRESS_BASE_URL: "https://github.with-avalon.com",
    GITHUB_WEBHOOK_SECRET: SECRET,
    PROVIDER_WEBHOOK_MAX_BYTES: "2000000",
    DB: db,
    PAYLOADS: createCloudflareTestBinding<R2Bucket>(bucket),
    ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>(queue),
  });
  return { sql, db, bucket, queue, env };
}

function addRoute(sql: DatabaseSync, installationId: string, region: Region, workspaceId: string): void {
  const at = new Date(NOW).toISOString();
  sql.prepare(
    `INSERT INTO github_installation_routes
     (installation_id, region, workspace_id, status, created_at, updated_at, disabled_at)
     VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
  ).run(installationId, region, workspaceId, at, at);
}

function routeStatuses(sql: DatabaseSync, installationId: string): string[] {
  return (sql.prepare(
    "SELECT status FROM github_installation_routes WHERE installation_id = ? ORDER BY region",
  ).all(installationId) as Array<{ status: string }>).map((row) => row.status);
}

interface Dispatch {
  region: Region;
  bytes: Uint8Array;
  deliveryId: string;
  event: string;
}

function routingService(env: Env, dispatches: Dispatch[] = []): GitHubRoutingService {
  return new GitHubRoutingService(env, {
    now: () => NOW,
    ingestInRegion: async (region, delivery) => {
      dispatches.push({
        region,
        bytes: new Uint8Array(delivery.rawBody),
        deliveryId: delivery.deliveryId,
        event: delivery.event,
      });
      return { accepted: true, duplicate: false, activityCount: 1 };
    },
  });
}

function queued(body: unknown) {
  return {
    id: "message-1",
    timestamp: new Date(NOW),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies Message<unknown>;
}

/** Every HMAC the Web Crypto API computes or checks, wherever it is called from. */
function hmacOperations() {
  const verify = vi.spyOn(crypto.subtle, "verify");
  const sign = vi.spyOn(crypto.subtle, "sign");
  return () => verify.mock.calls.length + sign.mock.calls.length;
}

describe("shared GitHub App routing", () => {
  it("uses the region prefix while keeping the rest of state opaque", () => {
    expect(createGitHubInstallState("enterprise", "c".repeat(32))).toBe(`enterprise.${"c".repeat(32)}`);
    expect(githubRegionFromInstallState(`global.${"a".repeat(32)}`)).toBe("global");
    expect(githubRegionFromInstallState(`enterprise.${"b".repeat(32)}`)).toBe("enterprise");
    expect(() => githubRegionFromInstallState("opaque-without-region")).toThrow(/state/i);
  });

  it("serializes regional business failures without losing their HTTP status", async () => {
    await expect(serializeGitHubRegionalRpcResult(async () => {
      throw new ApiError(409, "installation_conflict", "Installation is already routed");
    })).resolves.toEqual({
      ok: false,
      error: {
        status: 409,
        code: "installation_conflict",
        message: "Installation is already routed",
      },
    });
  });

  it("gates the dedicated hostname to setup, webhook, and health only", () => {
    const { env } = fixture();
    expect(isSharedGitHubIngress(env, "https://github.with-avalon.com/ingest/github")).toBe(true);
    expect(isSharedGitHubIngress(env, "https://api.with-avalon.com/ingest/github")).toBe(false);
    expect(isAllowedGitHubIngressRoute("GET", "/connections/github/setup")).toBe(true);
    expect(isAllowedGitHubIngressRoute("POST", "/ingest/github")).toBe(true);
    expect(isAllowedGitHubIngressRoute("GET", "/health")).toBe(true);
    expect(isAllowedGitHubIngressRoute("GET", "/workspace")).toBe(false);
  });

  it("rejects a bad signature with one check, before anything is read or enqueued", async () => {
    const { env, db, queue } = fixture();
    const delivery = await signedDelivery("delivery-tampered", "installation", { installation: { id: 42 } });
    const prepare = vi.spyOn(db, "prepare");
    const hmacs = hmacOperations();

    await expect(routingService(env).ingestGitHub(delivery.bytes, {
      ...delivery.headers,
      "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
    })).rejects.toMatchObject({ code: "invalid_signature" });
    expect(hmacs()).toBe(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(queue.messages).toHaveLength(0);
  });

  it("answers the webhook route before any installation matching runs", async () => {
    const { env, sql, db, bucket, queue } = fixture();
    addRoute(sql, "42", "global", "workspace-global");
    const prepare = vi.spyOn(db, "prepare");
    const delivery = await signedDelivery("issue-opened", "issues", {
      action: "opened",
      installation: { id: 42 },
    });

    const response = await webhookIngestionRoutes.request(
      "https://github.with-avalon.com/github",
      { method: "POST", headers: delivery.headers, body: new TextDecoder().decode(delivery.bytes) },
      env,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, duplicate: false, activityCount: 0 });
    // The route read nothing: the installation's regions are looked up by the
    // consumer, not while GitHub waits.
    expect(prepare).not.toHaveBeenCalled();
    expect(bucket.values.size).toBe(0);
    expect(queue.messages).toHaveLength(1);
    expect(GitHubDeliveryQueueMessageSchema.parse(queue.messages[0])).toMatchObject({
      kind: "github_webhook_delivery_v1",
      deliveryId: "issue-opened",
      event: "issues",
      body: { kind: "inline" },
    });
  });

  it("verifies a delivery once across the receiver and the consumer", async () => {
    const { env, sql, queue } = fixture();
    addRoute(sql, "42", "global", "workspace-global");
    const dispatches: Dispatch[] = [];
    const service = routingService(env, dispatches);
    const delivery = await signedDelivery("verified-once", "issues", {
      action: "opened",
      installation: { id: 42 },
    });
    const hmacs = hmacOperations();

    await service.ingestGitHub(delivery.bytes, delivery.headers);
    expect(hmacs()).toBe(1);

    const message = queued(queue.messages[0]);
    await consumeGitHubDeliveryMessage(message, env, service);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(dispatches).toHaveLength(1);
    expect(hmacs()).toBe(1);
  });

  it("processes an enqueued delivery through the activity queue consumer", async () => {
    const { env, queue } = fixture();
    const delivery = await signedDelivery("unrouted-created", "installation", {
      action: "created",
      installation: { id: 77 },
    });
    await routingService(env).ingestGitHub(delivery.bytes, delivery.headers);
    const message = queued(queue.messages[0]);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await consumeActivityQueue({
      queue: "avalon-global-activities",
      messages: [message],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies MessageBatch<unknown>, env);

    // An installation no region has connected yet — every new installation's
    // `installation.created` — is consumed and acknowledged, not retried into
    // the dead-letter queue.
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(info.mock.calls.map((call) => call[0])).toContainEqual(expect.objectContaining({
      event: "github_delivery_consumed",
      delivery_id: "unrouted-created",
      outcome: "unrouted",
    }));
  });

  it("routes the verified bytes to every connected region and disables routes on deletion", async () => {
    const { env, sql, queue } = fixture();
    addRoute(sql, "42", "global", "workspace-global");
    addRoute(sql, "42", "enterprise", "workspace-enterprise");
    const dispatches: Dispatch[] = [];
    const service = routingService(env, dispatches);
    const deleted = await signedDelivery("installation-deleted", "installation", {
      action: "deleted",
      installation: { id: 42 },
    });

    await service.ingestGitHub(deleted.bytes, deleted.headers);
    expect(dispatches).toHaveLength(0);
    expect(routeStatuses(sql, "42")).toEqual(["active", "active"]);

    const message = queued(queue.messages[0]);
    await consumeGitHubDeliveryMessage(message, env, service);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(dispatches.map((entry) => entry.region).sort()).toEqual(["enterprise", "global"]);
    expect(dispatches[0]).toMatchObject({ deliveryId: "installation-deleted", event: "installation" });
    expect(dispatches[0]?.bytes).toEqual(deleted.bytes);
    expect(routeStatuses(sql, "42")).toEqual(["disabled", "disabled"]);
  });

  it("broadcasts user authorization revocation to every region from the consumer", async () => {
    const { env, queue } = fixture();
    const dispatches: Dispatch[] = [];
    const service = routingService(env, dispatches);
    const ping = await signedDelivery("ping-delivery", "ping", { zen: "Keep it logically awesome." });
    await expect(service.ingestGitHub(ping.bytes, ping.headers)).resolves.toMatchObject({ accepted: true });
    expect(queue.messages).toHaveLength(0);

    const revoked = await signedDelivery("auth-revoked", "github_app_authorization", {
      action: "revoked",
      sender: { id: 7, login: "octocat" },
    });
    await service.ingestGitHub(revoked.bytes, revoked.headers);
    await consumeGitHubDeliveryMessage(queued(queue.messages[0]), env, service);
    expect(dispatches.map((entry) => entry.region).sort()).toEqual(["enterprise", "global"]);
    expect(dispatches[0]?.bytes).toEqual(revoked.bytes);
  });

  it("discards check runs and unfinished workflow runs without enqueueing them", async () => {
    const { env, queue } = fixture();
    const service = routingService(env);
    const deliveries = [
      await signedDelivery("check-created", "check_run", { action: "created", installation: { id: 42 } }),
      await signedDelivery("check-completed", "check_run", { action: "completed", installation: { id: 42 } }),
      await signedDelivery("run-requested", "workflow_run", { action: "requested", installation: { id: 42 } }),
      await signedDelivery("run-in-progress", "workflow_run", { action: "in_progress", installation: { id: 42 } }),
    ];
    for (const delivery of deliveries) {
      await expect(service.ingestGitHub(delivery.bytes, delivery.headers)).resolves.toEqual({
        accepted: true,
        duplicate: false,
        activityCount: 0,
      });
    }
    expect(queue.messages).toHaveLength(0);

    const completed = await signedDelivery("run-completed", "workflow_run", {
      action: "completed",
      installation: { id: 42 },
    });
    await service.ingestGitHub(completed.bytes, completed.headers);
    expect(queue.messages).toHaveLength(1);
  });

  it("stages a body too large for a Queue message in R2 and removes it once routed", async () => {
    const { env, sql, bucket, queue } = fixture();
    addRoute(sql, "42", "global", "workspace-global");
    const dispatches: Dispatch[] = [];
    const service = routingService(env, dispatches);
    const large = await signedDelivery("large-push", "push", {
      installation: { id: 42 },
      padding: "x".repeat(200_000),
    });

    await service.ingestGitHub(large.bytes, large.headers);
    const message = GitHubDeliveryQueueMessageSchema.parse(queue.messages[0]);
    expect(message.body.kind).toBe("staged");
    expect(bucket.values.size).toBe(1);

    const first = queued(message);
    await consumeGitHubDeliveryMessage(first, env, service);
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(dispatches[0]?.bytes).toEqual(large.bytes);
    expect(bucket.values.size).toBe(0);

    // A second copy of the same delivery finds its body gone and is
    // acknowledged without routing it again.
    const again = queued(message);
    await consumeGitHubDeliveryMessage(again, env, service);
    expect(again.ack).toHaveBeenCalledTimes(1);
    expect(dispatches).toHaveLength(1);
  });

  it("retries a delivery a region could not take, keeping its staged body", async () => {
    const { env, sql, bucket, queue } = fixture();
    addRoute(sql, "42", "global", "workspace-global");
    const service = new GitHubRoutingService(env, {
      now: () => NOW,
      ingestInRegion: async () => {
        throw new ApiError(503, "github_region_unavailable", "The region is unavailable");
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const large = await signedDelivery("region-down", "push", {
      installation: { id: 42 },
      padding: "x".repeat(200_000),
    });
    await service.ingestGitHub(large.bytes, large.headers);

    const message = queued(queue.messages[0]);
    await consumeGitHubDeliveryMessage(message, env, service);
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(bucket.values.size).toBe(1);
  });

  it("names the field a malformed delivery message failed on", async () => {
    const { env } = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const message = queued({
      kind: "github_webhook_delivery_v1",
      deliveryId: "d",
      event: "issues",
      receivedAt: "not-a-time",
      body: { kind: "inline", bytes: new ArrayBuffer(0) },
    });

    await consumeGitHubDeliveryMessage(message, env, routingService(env));
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls.map((call) => call[0])).toContainEqual(expect.objectContaining({
      event: "github_delivery_message_invalid",
      error_code: expect.stringContaining("receivedAt"),
    }));
  });

  it("records the installation's region when setup completes, and routes to it afterwards", async () => {
    const { env, sql, queue } = fixture();
    const dispatches: Dispatch[] = [];
    const setupInRegion = vi.fn(async () => ({
      url: "https://github.com/login/oauth/authorize?state=regional",
      workspaceId: "workspace-enterprise",
    }));
    const service = new GitHubRoutingService(env, {
      now: () => NOW,
      setupInRegion,
      ingestInRegion: async (region, delivery) => {
        dispatches.push({ region, bytes: new Uint8Array(delivery.rawBody), deliveryId: delivery.deliveryId, event: delivery.event });
        return { accepted: true, duplicate: false, activityCount: 0 };
      },
    });

    await expect(service.setupGitHub("42", `enterprise.${"x".repeat(32)}`)).resolves.toContain("github.com");
    expect(setupInRegion).toHaveBeenCalledWith("enterprise", "42", `enterprise.${"x".repeat(32)}`);
    expect(routeStatuses(sql, "42")).toEqual(["active"]);

    const added = await signedDelivery("repositories-added", "installation_repositories", {
      action: "added",
      installation: { id: 42 },
    });
    await service.ingestGitHub(added.bytes, added.headers);
    await consumeGitHubDeliveryMessage(queued(queue.messages[0]), env, service);
    expect(dispatches.map((entry) => entry.region)).toEqual(["enterprise"]);
  });

  it("routes an intermediate setup failure back to the owning regional OAuth attempt", async () => {
    const { env } = fixture();
    const failSetupInRegion = vi.fn(async () =>
      `avalon://auth/complete?provider=github&region=enterprise&status=failed&error=github_setup_failed`);
    const service = new GitHubRoutingService(env, { failSetupInRegion });
    const state = `enterprise.${"x".repeat(32)}`;

    await expect(service.failGitHubSetup(state, "github_setup_failed")).resolves.toContain("provider=github");
    expect(failSetupInRegion).toHaveBeenCalledWith("enterprise", state, "github_setup_failed");
  });
});

async function signedDelivery(
  deliveryId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<{ bytes: Uint8Array; headers: Record<string, string> }> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
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
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${[...signature]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")}`,
    },
  };
}
