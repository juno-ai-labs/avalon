import "../../../tests/isolated-region";
import { describe, expect, it, vi } from "vitest";
import type { Region } from "@rally/contracts";
import type { Env } from "../src/env";
import {
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
import { createCloudflareTestBinding, createTestD1Database, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const SECRET = "shared-github-webhook-secret";
const NOW = Date.parse("2026-08-01T18:00:00.000Z");

interface RouteRow {
  installationId: string;
  region: Region;
  workspaceId: string;
  status: "active" | "disabled";
}

interface PendingRow extends Record<string, unknown> {
  delivery_id: string;
  installation_id: string;
  event_type: string;
  action: string | null;
  signature_header: string;
  payload_ref: string;
  expires_at: string;
  dispatched_at: string | null;
}

class FakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: FakeDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>(this.database.all(this.sql, this.values));
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.sql, this.values) as T | null;
  }

  async run<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>(this.database.run(this.sql, this.values));
  }
}

class FakeDatabase {
  readonly routes: RouteRow[] = [];
  readonly pending: PendingRow[] = [];
  prepareCalls = 0;

  prepare(sql: string): FakeStatement {
    this.prepareCalls += 1;
    return new FakeStatement(this, sql);
  }

  all(sql: string, values: unknown[]): D1Result<Record<string, unknown>> {
    if (sql.includes("SELECT DISTINCT region FROM github_installation_routes")) {
      const installationId = String(values[0]);
      const regions = [...new Set(this.routes
        .filter((row) => row.installationId === installationId && row.status === "active")
        .map((row) => row.region))].sort();
      return result(0, regions.map((region) => ({ region })));
    }
    if (sql.includes("FROM github_ingress_pending_deliveries") && sql.includes("installation_id = ?")) {
      const installationId = String(values[0]);
      const at = String(values[1]);
      return result(0, this.pending.filter((row) =>
        row.installation_id === installationId
        && row.dispatched_at === null
        && row.expires_at > at));
    }
    if (sql.includes("FROM github_ingress_pending_deliveries") && sql.includes("expires_at <= ?")) {
      const at = String(values[0]);
      const limit = Number(values[1]);
      return result(0, this.pending
        .filter((row) => row.expires_at <= at)
        .slice(0, limit)
        .map((row) => ({ delivery_id: row.delivery_id, payload_ref: row.payload_ref })));
    }
    throw new Error(`Unexpected all query: ${sql}`);
  }

  first(sql: string, values: unknown[]): Record<string, unknown> | null {
    if (sql.includes("FROM github_ingress_pending_deliveries")) {
      const row = this.pending.find((candidate) => candidate.delivery_id === values[0]);
      return row ? { event_type: row.event_type, payload_ref: row.payload_ref } : null;
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  run(sql: string, values: unknown[]): D1Result {
    if (sql.includes("INSERT INTO github_installation_routes")) {
      const [installationId, region, workspaceId] = values.map(String);
      const existing = this.routes.find((row) =>
        row.installationId === installationId
        && row.region === region
        && row.workspaceId === workspaceId);
      if (existing) existing.status = "active";
      else this.routes.push({
        installationId: installationId!,
        region: region as Region,
        workspaceId: workspaceId!,
        status: "active",
      });
      return result(1);
    }
    if (sql.includes("INSERT INTO github_ingress_pending_deliveries")) {
      const [deliveryId, installationId, eventType, action, signature, payloadRef, , expiresAt] = values;
      if (this.pending.some((row) => row.delivery_id === deliveryId)) return result(0);
      this.pending.push({
        delivery_id: String(deliveryId),
        installation_id: String(installationId),
        event_type: String(eventType),
        action: action == null ? null : String(action),
        signature_header: String(signature),
        payload_ref: String(payloadRef),
        expires_at: String(expiresAt),
        dispatched_at: null,
      });
      return result(1);
    }
    if (sql.includes("SET dispatched_at")) {
      const row = this.pending.find((candidate) => candidate.delivery_id === values[1]);
      if (row) row.dispatched_at ??= String(values[0]);
      return result(row ? 1 : 0);
    }
    if (sql.includes("UPDATE github_installation_routes") && sql.includes("status = 'disabled'")) {
      let changes = 0;
      for (const row of this.routes) {
        if (row.installationId === values[2] && row.status === "active") {
          row.status = "disabled";
          changes += 1;
        }
      }
      return result(changes);
    }
    if (sql.includes("DELETE FROM github_ingress_pending_deliveries")) {
      const index = this.pending.findIndex((row) => row.delivery_id === values[0] && row.expires_at <= String(values[1]));
      if (index < 0) return result(0);
      this.pending.splice(index, 1);
      return result(1);
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }
}

class FakeBucket {
  readonly values = new Map<string, ArrayBuffer>();
  readonly deleted: string[] = [];

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    const bytes = typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    this.values.set(key, copy);
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
    const env = environment(new FakeDatabase(), new FakeBucket());
    expect(isSharedGitHubIngress(env, "https://github.with-avalon.com/ingest/github")).toBe(true);
    expect(isSharedGitHubIngress(env, "https://api.with-avalon.com/ingest/github")).toBe(false);
    expect(isAllowedGitHubIngressRoute("GET", "/connections/github/setup")).toBe(true);
    expect(isAllowedGitHubIngressRoute("POST", "/ingest/github")).toBe(true);
    expect(isAllowedGitHubIngressRoute("GET", "/health")).toBe(true);
    expect(isAllowedGitHubIngressRoute("GET", "/workspace")).toBe(false);
  });

  it("verifies the exact ingress bytes before any database lookup", async () => {
    const database = new FakeDatabase();
    const rawBody = new TextEncoder().encode('{"installation":{"id":42}}');
    const service = new GitHubRoutingService(environment(database, new FakeBucket()));

    await expect(service.ingestGitHub(rawBody, {
      "x-github-delivery": "delivery-tampered",
      "x-github-event": "installation",
      "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
    })).rejects.toMatchObject({ code: "invalid_signature" });
    expect(database.prepareCalls).toBe(0);
  });

  it("accepts ping and broadcasts user authorization revocation to both regions", async () => {
    const database = new FakeDatabase();
    const bucket = new FakeBucket();
    const dispatches: Array<{ region: Region; bytes: Uint8Array }> = [];
    const service = new GitHubRoutingService(environment(database, bucket), {
      now: () => NOW,
      ingestInRegion: async (region, rawBody) => {
        dispatches.push({ region, bytes: new Uint8Array(rawBody) });
        return { accepted: true, duplicate: false, activityCount: 0 };
      },
    });
    const ping = await signedDelivery("ping-delivery", "ping", { zen: "Keep it logically awesome." });
    await expect(service.ingestGitHub(ping.bytes, ping.headers)).resolves.toMatchObject({ accepted: true });
    expect(dispatches).toHaveLength(0);

    const revoked = await signedDelivery("auth-revoked", "github_app_authorization", {
      action: "revoked",
      sender: { id: 7, login: "octocat" },
    });
    await expect(service.ingestGitHub(revoked.bytes, revoked.headers)).resolves.toMatchObject({ accepted: true });
    expect(dispatches.map((entry) => entry.region)).toEqual(["global", "enterprise"]);
    expect(dispatches[0]?.bytes).toEqual(revoked.bytes);
  });

  it("removes bounded expired pending bodies during ordinary ingress", async () => {
    const database = new FakeDatabase();
    const bucket = new FakeBucket();
    const payloadRef = "global/github-ingress/pending/expired.json";
    database.pending.push({
      delivery_id: "expired-delivery",
      installation_id: "99",
      event_type: "installation",
      action: "created",
      signature_header: `sha256=${"0".repeat(64)}`,
      payload_ref: payloadRef,
      expires_at: new Date(NOW - 1).toISOString(),
      dispatched_at: null,
    });
    bucket.values.set(payloadRef, new ArrayBuffer(0));
    const service = new GitHubRoutingService(environment(database, bucket), {
      now: () => NOW,
    });
    const ping = await signedDelivery("cleanup-ping", "ping", { zen: "cleanup" });

    await service.ingestGitHub(ping.bytes, ping.headers);
    expect(database.pending).toHaveLength(0);
    expect(bucket.deleted).toEqual([payloadRef]);
  });

  it("rejects an early lifecycle delivery without retaining opaque bytes before setup", async () => {
    const database = new FakeDatabase();
    const bucket = new FakeBucket();
    const dispatches: Array<{ region: Region; bytes: Uint8Array }> = [];
    const setupInRegion = vi.fn(async () => ({
      url: "https://github.com/login/oauth/authorize?state=regional",
      workspaceId: "workspace-enterprise",
    }));
    const service = new GitHubRoutingService(environment(database, bucket), {
      now: () => NOW,
      setupInRegion,
      ingestInRegion: async (region, rawBody) => {
        dispatches.push({ region, bytes: new Uint8Array(rawBody) });
        return { accepted: true, duplicate: false, activityCount: 0 };
      },
    });
    const created = await signedDelivery("installation-created", "installation", {
      action: "created",
      installation: { id: 42 },
    });

    await expect(service.ingestGitHub(created.bytes, created.headers)).rejects.toMatchObject({
      status: 503,
      code: "github_route_pending",
    });
    expect(database.pending).toHaveLength(0);
    expect(bucket.values.size).toBe(0);
    expect(dispatches).toHaveLength(0);

    await expect(service.setupGitHub("42", `enterprise.${"x".repeat(32)}`)).resolves.toContain("github.com");
    expect(setupInRegion).toHaveBeenCalledWith("enterprise", "42", `enterprise.${"x".repeat(32)}`);
    expect(database.routes).toEqual([{
      installationId: "42",
      region: "enterprise",
      workspaceId: "workspace-enterprise",
      status: "active",
    }]);
    expect(dispatches).toHaveLength(0);
    expect(bucket.values.size).toBe(0);
  });

  it("routes an intermediate setup failure back to the owning regional OAuth attempt", async () => {
    const database = new FakeDatabase();
    const bucket = new FakeBucket();
    const failSetupInRegion = vi.fn(async () =>
      `avalon://auth/complete?provider=github&region=enterprise&status=failed&error=github_setup_failed`);
    const service = new GitHubRoutingService(environment(database, bucket), {
      failSetupInRegion,
    });
    const state = `enterprise.${"x".repeat(32)}`;

    await expect(service.failGitHubSetup(state, "github_setup_failed")).resolves.toContain("provider=github");
    expect(failSetupInRegion).toHaveBeenCalledWith("enterprise", state, "github_setup_failed");
  });

  it("fans out installation deliveries and disables every route after deletion", async () => {
    const database = new FakeDatabase();
    database.routes.push(
      { installationId: "42", region: "global", workspaceId: "workspace-global", status: "active" },
      { installationId: "42", region: "enterprise", workspaceId: "workspace-enterprise", status: "active" },
    );
    const regions: Region[] = [];
    const service = new GitHubRoutingService(environment(database, new FakeBucket()), {
      now: () => NOW,
      ingestInRegion: async (region) => {
        regions.push(region);
        return { accepted: true, duplicate: false, activityCount: 0 };
      },
    });
    const deleted = await signedDelivery("installation-deleted", "installation", {
      action: "deleted",
      installation: { id: 42 },
    });

    await expect(service.ingestGitHub(deleted.bytes, deleted.headers)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 0,
    });
    expect(regions).toEqual(["enterprise", "global"]);
    expect(database.routes.every((route) => route.status === "disabled")).toBe(true);
  });
});

function environment(database: FakeDatabase, bucket: FakeBucket): Env {
  return createTestEnv({
    AVALON_REGION: "global",
    GITHUB_INGRESS_BASE_URL: "https://github.with-avalon.com",
    GITHUB_WEBHOOK_SECRET: SECRET,
    PROVIDER_WEBHOOK_MAX_BYTES: "2000000",
    DB: createTestD1Database(database),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>(bucket),
  });
}

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

function result<T>(
  changes: number,
  results: T[] = [],
): D1Result<T> {
  return createTestD1Result<T>({
    success: true,
    results,
    meta: { changes },
  });
}
