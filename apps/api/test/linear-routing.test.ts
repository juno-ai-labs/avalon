import "../../../tests/isolated-region";
import type { Region } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  isAllowedLinearIngressRoute,
  isSharedLinearIngress,
  LinearRoutingService,
  serializeLinearRpcResult,
} from "../src/services/linear-routing-service";
import { ApiError } from "../src/lib/api-error";
import { createTestD1Database, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const NOW = Date.parse("2026-08-02T18:00:00.000Z");
const SECRET = "shared-linear-webhook-secret";
const ORGANIZATION_ID = "linear-org-1";
const DELIVERY_ID = "00000000-0000-4000-8000-000000000091";

interface RouteRow {
  organizationId: string;
  region: Region;
  workspaceId: string;
  connectionId: string;
  status: "active" | "disabled";
}

class FakeStatement {
  private values: unknown[] = [];

  constructor(private readonly database: FakeDatabase, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>(this.database.all(this.sql, this.values));
  }

  async run<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>(this.database.run(this.sql, this.values));
  }
}

class FakeDatabase {
  readonly routes: RouteRow[] = [];
  prepareCalls = 0;

  prepare(sql: string): FakeStatement {
    this.prepareCalls += 1;
    return new FakeStatement(this, sql);
  }

  all(sql: string, values: unknown[]): D1Result<Record<string, unknown>> {
    if (!sql.includes("SELECT DISTINCT region FROM linear_organization_routes")) {
      throw new Error(`Unexpected all query: ${sql}`);
    }
    const regions = [...new Set(this.routes
      .filter((row) => row.organizationId === values[0] && row.status === "active")
      .map((row) => row.region))].sort();
    return result(0, regions.map((region) => ({ region })));
  }

  run(sql: string, values: unknown[]): D1Result {
    if (sql.includes("INSERT INTO linear_organization_routes")) {
      const [organizationId, region, workspaceId, connectionId] = values.map(String);
      const existing = this.routes.find((row) => row.connectionId === connectionId);
      if (existing) existing.status = "active";
      else this.routes.push({
        organizationId: organizationId!,
        region: region as Region,
        workspaceId: workspaceId!,
        connectionId: connectionId!,
        status: "active",
      });
      return result(1);
    }
    if (sql.includes("UPDATE linear_organization_routes")) {
      const row = this.routes.find((candidate) =>
        candidate.organizationId === values[3]
        && candidate.region === values[4]
        && candidate.workspaceId === values[5]
        && candidate.connectionId === values[6]);
      if (!row) return result(0);
      row.status = String(values[0]) as RouteRow["status"];
      return result(1);
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }
}

describe("shared Linear app routing", () => {
  it("gates the dedicated hostname to webhook and health only", () => {
    const env = environment(new FakeDatabase());
    expect(isSharedLinearIngress(env, "https://linear.with-avalon.com/ingest/linear")).toBe(true);
    expect(isSharedLinearIngress(env, "https://api.with-avalon.com/ingest/linear")).toBe(false);
    expect(isAllowedLinearIngressRoute("POST", "/ingest/linear")).toBe(true);
    expect(isAllowedLinearIngressRoute("GET", "/health")).toBe(true);
    expect(isAllowedLinearIngressRoute("GET", "/workspace")).toBe(false);
  });

  it("registers one organization in multiple regions and forwards exact bytes", async () => {
    const database = new FakeDatabase();
    const dispatches: Array<{ region: Region; bytes: Uint8Array }> = [];
    const service = new LinearRoutingService(environment(database), {
      now: () => NOW,
      ingestInRegion: async (region, rawBody) => {
        dispatches.push({ region, bytes: new Uint8Array(rawBody) });
        return { accepted: true, duplicate: false, activityCount: 1 };
      },
    });
    await service.registerConnection(route("global", "workspace-global", "connection-global"));
    await service.registerConnection(route("enterprise", "workspace-enterprise", "connection-enterprise"));

    const delivery = await signedDelivery(ORGANIZATION_ID);
    await expect(service.ingestLinear(delivery.bytes, delivery.headers)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      activityCount: 2,
    });
    expect(dispatches.map((entry) => entry.region)).toEqual(["enterprise", "global"]);
    expect(dispatches.every((entry) => bytesEqual(entry.bytes, delivery.bytes))).toBe(true);
  });

  it("verifies before routing and asks Linear to retry an installation race", async () => {
    const database = new FakeDatabase();
    const service = new LinearRoutingService(environment(database), { now: () => NOW });
    const delivery = await signedDelivery(ORGANIZATION_ID);

    await expect(service.ingestLinear(delivery.bytes, {
      ...delivery.headers,
      "linear-signature": "0".repeat(64),
    })).rejects.toMatchObject({ code: "invalid_signature" });
    expect(database.prepareCalls).toBe(0);

    await expect(service.ingestLinear(delivery.bytes, delivery.headers)).rejects.toMatchObject({
      status: 503,
      code: "linear_route_pending",
    });
  });

  it("serializes internal routing failures without losing status", async () => {
    await expect(serializeLinearRpcResult(async () => {
      throw new ApiError(409, "route_conflict", "Route conflict");
    })).resolves.toEqual({
      ok: false,
      error: { status: 409, code: "route_conflict", message: "Route conflict" },
    });
  });
});

function route(region: Region, workspaceId: string, connectionId: string) {
  return { organizationId: ORGANIZATION_ID, region, workspaceId, connectionId };
}

function environment(database: FakeDatabase): Env {
  return createTestEnv({
    DB: createTestD1Database(database),
    AVALON_REGION: "global",
    LINEAR_INGRESS_BASE_URL: "https://linear.with-avalon.com",
    LINEAR_WEBHOOK_SECRET: SECRET,
    WEBHOOK_REPLAY_WINDOW_SECONDS: "300",
    PROVIDER_WEBHOOK_MAX_BYTES: "2000000",
  });
}

async function signedDelivery(organizationId: string) {
  const body = JSON.stringify({
    action: "create",
    type: "Issue",
    organizationId,
    webhookId: "linear-webhook-1",
    webhookTimestamp: NOW,
    createdAt: new Date(NOW).toISOString(),
    data: { id: "issue-1", identifier: "AVA-1", title: "Route Linear" },
  });
  const bytes = new TextEncoder().encode(body);
  return {
    bytes,
    headers: {
      "linear-delivery": DELIVERY_ID,
      "linear-event": "Issue",
      "linear-signature": await hmacHex(SECRET, bytes),
      "linear-timestamp": String(NOW),
    },
  };
}

async function hmacHex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, copy));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesEqual(first: Uint8Array, second: Uint8Array): boolean {
  return first.byteLength === second.byteLength && first.every((byte, index) => byte === second[index]);
}

function result<T = unknown>(changes: number, rows: T[] = []): D1Result<T> {
  return { success: true, results: rows, meta: { changes } as D1Meta & Record<string, unknown> };
}
