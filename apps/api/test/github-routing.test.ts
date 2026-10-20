import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Region } from "@rally/contracts";

// The Node stand-in for `cloudflare:workers` has no entrypoint base class; the
// bridge needs only the `env` the runtime hands it.
vi.mock("cloudflare:workers", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  WorkerEntrypoint: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}));

import type { Env } from "../src/env";
import { GitHubRegionalBridge } from "../src/github-regional-bridge";
import { consumeActivityQueue } from "../src/queues/activity-consumer";
import { webhookIngestionRoutes } from "../src/routes/connections";
import {
  consumeGitHubDeliveryMessage,
  GitHubDeliveryQueueMessageSchema,
  GitHubRoutingService,
  isAllowedGitHubIngressRoute,
  isSharedGitHubIngress,
  serializeGitHubRegionalRpcResult,
  type GitHubRegionalBridgeRpcBinding,
} from "../src/services/github-routing-service";
import { ApiError } from "../src/lib/api-error";
import { ConnectorError } from "@rally/connectors";
import {
  createGitHubInstallState,
  githubRegionFromInstallState,
} from "../src/lib/github-install-state";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, testWorkspaceObjectBinding } from "./helpers/workspace-object-rpcs";
import { openWorkstreamAuthorityForTest } from "./helpers/durable-authority";
import { encryptString } from "../src/lib/crypto";

// The route table is the real migrated schema. The Queue and R2 are doubles
// because neither runs under Node. Most tests double the regional ingest,
// which `provider-webhooks.test.ts` covers — including that
// `ingestVerifiedGitHub` performs no signature check. The "regional data
// plane" block below does not: it runs the consumer into a real
// `ProviderWebhookService` over a migrated regional database and a real
// `WorkspaceDO`, in-process and across the real `GitHubRegionalBridge`.

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
  failuresRemaining = 0;

  async send(message: unknown, options?: QueueSendOptions): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("injected queue failure");
    }
    // The Queue's default content type is `json`; only `v8` keeps an
    // ArrayBuffer (`test-workers/github-delivery-queue.test.ts` proves it on
    // a real Queue).
    this.messages.push(options?.contentType === "v8" ? message : JSON.parse(JSON.stringify(message)));
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

  it("carries GitHub's own status across the regional hop for the log, not the caller", async () => {
    // The hop rewrites every GitHub failure to 502 `provider_error`; the status
    // GitHub answered rides as `diagnosticCode`, which `request_failed` and
    // `github_delivery_retry` log and the response body never carries.
    await expect(serializeGitHubRegionalRpcResult(async () => {
      throw new ConnectorError("provider_error", "Not Found", { status: 404 });
    })).resolves.toEqual({
      ok: false,
      error: {
        status: 502,
        code: "provider_error",
        message: "Not Found",
        diagnosticCode: "provider_error:http_404",
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
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(bucket.values.size).toBe(1);
  });

  it("backs a retry off by attempt, and waits out a GitHub rate limit's Retry-After", async () => {
    const { env, sql, queue } = fixture();
    addRoute(sql, "42", "global", "workspace-global");
    let failure: Error = new ApiError(503, "github_region_unavailable", "The region is unavailable");
    const service = new GitHubRoutingService(env, {
      now: () => NOW,
      ingestInRegion: async () => {
        throw failure;
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const delivery = await signedDelivery("rate-limited", "issues", { action: "opened", installation: { id: 42 } });
    await service.ingestGitHub(delivery.bytes, delivery.headers);

    const third = { ...queued(queue.messages[0]), attempts: 3 };
    await consumeGitHubDeliveryMessage(third, env, service);
    expect(third.retry).toHaveBeenCalledWith({ delaySeconds: 20 });

    failure = new ConnectorError("provider_error", "API rate limit exceeded", {
      status: 403,
      rateLimited: true,
      retryAfterMs: 900_000,
    });
    const limited = queued(queue.messages[0]);
    await consumeGitHubDeliveryMessage(limited, env, service);
    expect(limited.retry).toHaveBeenCalledWith({ delaySeconds: 900 });
    // `provider_error` alone is what GitHub's 404, its rate limit and an outage
    // all say; the adapter recorded which.
    expect(vi.mocked(console.warn).mock.calls.map((call) => call[0])).toContainEqual(expect.objectContaining({
      event: "github_delivery_retry",
      error_code: "provider_error:http_403:rate_limited",
    }));
  });

  it("removes a staged body when the delivery cannot be enqueued", async () => {
    const { env, bucket, queue } = fixture();
    queue.failuresRemaining = 1;
    const large = await signedDelivery("enqueue-failed", "push", {
      installation: { id: 42 },
      padding: "x".repeat(200_000),
    });

    await expect(routingService(env).ingestGitHub(large.bytes, large.headers)).rejects.toThrow("injected queue failure");
    expect(bucket.deleted).toHaveLength(1);
    expect(bucket.values.size).toBe(0);
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
      delivery_id: "d",
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

const WORKSPACE = "00000000-0000-7000-8000-0000000000a1";
const OWNER = "00000000-0000-7000-8000-0000000000a2";
const CONNECTION = "00000000-0000-7000-8000-0000000000a3";
const CREDENTIALS_KEY = "github-routing-test-credentials-key";

interface RegionPlane {
  env: Env;
  regional: DatabaseSync;
  object: DatabaseSync;
  queue: FakeQueue;
}

/**
 * One region's data plane as the consumer reaches it: the migrated regional
 * database, a real `WorkspaceDO` holding one workspace-scoped GitHub connection
 * for installation 42, and the connection's ingress route.
 */
async function regionPlane(region: Region, databases: DatabaseSync[]): Promise<RegionPlane> {
  const regional = migratedSqliteDatabase();
  databases.push(regional);
  openWorkstreamAuthorityForTest(regional);
  const at = new Date(NOW).toISOString();
  const credentials = await encryptString(
    JSON.stringify({ installationId: "42", tokenKind: "installation" }),
    CREDENTIALS_KEY,
    CONNECTION,
  );
  regional.prepare(
    `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
     VALUES (?, 'google-owner', 'owner@example.test', 'Owner', ?, ?)`,
  ).run(OWNER, at, at);
  regional.prepare(
    `INSERT INTO workspaces(id, name, slug, region, created_by_user_id, created_at, updated_at, placement_affinity)
     VALUES (?, 'Test', 'test', ?, ?, ?, ?, ?)`,
  ).run(WORKSPACE, region, OWNER, at, at, region === "global" ? "wnam" : "weur");
  regional.prepare(
    `INSERT INTO connector_ingress_routes
     (connection_id, workspace_id, region, connector_type, scope, provider_account_id,
      provider_user_id, status, updated_at)
     VALUES (?, ?, ?, 'github', 'workspace', '42', NULL, 'active', ?)`,
  ).run(CONNECTION, WORKSPACE, region, at);
  const { instance, objectDatabase } = createTestWorkspaceDO({
    workspaceId: WORKSPACE,
    regionalDatabase: regional,
    region,
    register: (database) => databases.push(database),
  });
  objectDatabase.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
      display_name, encrypted_credentials, credential_iv, credential_key_version,
      status, created_at, updated_at, model_plugin_id)
     VALUES (?, ?, 'github', 'workspace', NULL, '42', 'GitHub', ?, ?, 1, 'healthy', ?, ?, 'github-plugin')`,
  ).run(CONNECTION, WORKSPACE, credentials.ciphertext, credentials.iv, at, at);
  const queue = new FakeQueue();
  const env = createTestEnv({
    AVALON_REGION: region,
    APP_ENV: "test",
    CONNECTOR_CREDENTIALS_KEY: CREDENTIALS_KEY,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    GITHUB_INGRESS_BASE_URL: "https://github.with-avalon.com",
    GITHUB_WEBHOOK_SECRET: SECRET,
    DB: sqliteD1(regional),
    WORKSPACE_DOS: testWorkspaceObjectBinding(instance, ["executeRuntimeSql", "upsertDiscoveredResources", "publishSync"]),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>(new FakeBucket()),
    ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>(queue),
  });
  return { env, regional, object: objectDatabase, queue };
}

function connectionStatus(plane: RegionPlane): string {
  return (plane.object.prepare("SELECT status FROM connector_connections WHERE id = ?")
    .get(CONNECTION) as { status: string }).status;
}

function receipt(plane: RegionPlane, deliveryId: string): { processed_at: string | null } | undefined {
  return plane.regional.prepare(
    "SELECT processed_at FROM provider_webhook_receipts WHERE provider = 'github' AND delivery_id = ?",
  ).get(deliveryId) as { processed_at: string | null } | undefined;
}

/** A delivery message as the receiver enqueues it, received at `receivedAt`. */
function deliveryMessage(
  deliveryId: string,
  event: string,
  payload: Record<string, unknown>,
  receivedAt = new Date(NOW).toISOString(),
) {
  const bytes = new TextEncoder().encode(JSON.stringify({
    installation: { id: 42, account: { login: "acme" } },
    sender: { login: "octocat" },
    ...payload,
  }));
  return queued(GitHubDeliveryQueueMessageSchema.parse({
    kind: "github_webhook_delivery_v1",
    deliveryId,
    event,
    receivedAt,
    body: { kind: "inline", bytes: bytes.buffer },
  }));
}

/** An installation lifecycle delivery, received at `receivedAt`. */
function lifecycleMessage(deliveryId: string, action: string, receivedAt?: string) {
  return deliveryMessage(deliveryId, "installation", { action }, receivedAt);
}

const ISSUE_OPENED = {
  action: "opened",
  repository: { id: 10, full_name: "acme/app", html_url: "https://github.com/acme/app", owner: { login: "acme" } },
  issue: { id: 20, number: 1, title: "Retried", html_url: "https://github.com/acme/app/issues/1" },
};

describe("the regional data plane behind the GitHub consumer", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("finishes a delivery whose first attempt failed after its receipt committed", async () => {
    const plane = await regionPlane("global", databases);
    addRoute(plane.regional, "42", "global", WORKSPACE);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = new GitHubRoutingService(plane.env, { now: () => NOW });

    // The receipt commits and then the connector event cannot be enqueued:
    // the consumer retries the message.
    plane.queue.failuresRemaining = 1;
    const first = deliveryMessage("issue-retried", "issues", ISSUE_OPENED);
    await consumeGitHubDeliveryMessage(first, plane.env, service);
    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(receipt(plane, "issue-retried")).toEqual({ processed_at: null });
    expect(plane.queue.messages).toHaveLength(0);

    const again = deliveryMessage("issue-retried", "issues", ISSUE_OPENED);
    await consumeGitHubDeliveryMessage(again, plane.env, service);
    expect(again.retry).not.toHaveBeenCalled();
    expect(again.ack).toHaveBeenCalledTimes(1);
    expect(receipt(plane, "issue-retried")?.processed_at).not.toBeNull();
    expect(plane.queue.messages).toEqual([
      expect.objectContaining({ kind: "workspace_connector_event" }),
    ]);
  });

  it("does not let a retried older lifecycle event overwrite a newer one", async () => {
    const plane = await regionPlane("global", databases);
    addRoute(plane.regional, "42", "global", WORKSPACE);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = new GitHubRoutingService(plane.env, { now: () => NOW });
    const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

    // `unsuspend` was received first but its first attempt failed; `suspend`,
    // received after it, applies; the retried `unsuspend` then arrives.
    await consumeGitHubDeliveryMessage(lifecycleMessage("suspend-newer", "suspend", at(2_000)), plane.env, service);
    expect(connectionStatus(plane)).toBe("needs_reconnect");
    const older = lifecycleMessage("unsuspend-older", "unsuspend", at(1_000));
    await consumeGitHubDeliveryMessage(older, plane.env, service);
    expect(older.ack).toHaveBeenCalledTimes(1);
    expect(connectionStatus(plane)).toBe("needs_reconnect");

    // A lifecycle event received after the newest one applied still applies.
    await consumeGitHubDeliveryMessage(lifecycleMessage("unsuspend-latest", "unsuspend", at(3_000)), plane.env, service);
    expect(connectionStatus(plane)).toBe("healthy");
  });

  it("hands the verified bytes across the real regional bridge", async () => {
    const global = fixture();
    databases.push(global.sql);
    addRoute(global.sql, "42", "enterprise", WORKSPACE);
    const enterprise = await regionPlane("enterprise", databases);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bridge = new GitHubRegionalBridge({} as ExecutionContext, enterprise.env);
    // A service binding copies its argument with structured clone; so does this.
    const binding: Pick<GitHubRegionalBridgeRpcBinding, "ingestVerifiedGitHub"> = {
      ingestVerifiedGitHub: async (input) => bridge.ingestVerifiedGitHub(structuredClone(input)),
    };
    const env = createTestEnv({
      ...global.env,
      REGION_ENTERPRISE_GITHUB_BRIDGE: binding as GitHubRegionalBridgeRpcBinding,
    });
    const service = new GitHubRoutingService(env, { now: () => NOW });

    const message = lifecycleMessage("bridged-suspend", "suspend");
    await consumeGitHubDeliveryMessage(message, env, service);
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(receipt(enterprise, "bridged-suspend")?.processed_at).not.toBeNull();
    expect(connectionStatus(enterprise)).toBe("needs_reconnect");
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
