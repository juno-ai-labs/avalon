import type { DatabaseRole } from "@avalon/postgres";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as envModule from "../src/env";
import type { HonoAppEnv } from "../src/env";
import type * as postgresRuntime from "../src/postgres/runtime";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

const mocks = vi.hoisted(() => ({
  createPostgresClient: vi.fn(),
}));

vi.mock("../src/env", async (importOriginal) => ({
  ...await importOriginal<typeof envModule>(),
  assertEnvContract: vi.fn(),
}));

vi.mock("../src/postgres/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof postgresRuntime>(),
  createPostgresClient: mocks.createPostgresClient,
}));

vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async ping(): Promise<{ region: "global"; domain: string }> {
      return { region: "global", domain: "automation.with-avalon.com" };
    }
  },
}));

const { EXPECTED_POSTGRES_ROLE } = await import("../src/postgres/runtime");
const { healthRoutes } = await import("../src/routes/health");

function healthEnv() {
  const room = { fetch: async () => new Response(null, { status: 200 }) };
  return createTestEnv({
    DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }) },
    PAYLOADS: { list: async () => ({ objects: [] }) },
    WORKSTREAM_ROOMS: createCloudflareTestBinding<DurableObjectNamespace>({
      idFromName: () => createTestDurableObjectId("id"),
      get: () => room,
    }),
    ACTIVITY_QUEUE: { send: async () => ({}) },
    WORKSTREAM_LOOP_WORKFLOW: { create: async () => ({ id: "instance" }) },
    POSTGRES_AGENT_LOOP_WORKFLOW: { create: async () => ({ id: "instance" }) },
    CONNECTOR_POLL_WORKFLOW: { create: async () => ({ id: "instance" }) },
    PRODUCT_DATA_AUTHORITY: "postgres",
    SUPABASE_GLOBAL_ROUTER_DATABASE_URL: "postgres://global",
    SUPABASE_REGIONAL_ROUTER_DATABASE_URL: "postgres://regional",
    SUPABASE_WORKFLOW_DATABASE_URL: "postgres://workflow",
    SUPABASE_QUEUE_DATABASE_URL: "postgres://queue",
    AVALON_REGION: "global",
    APP_ENV: "development",
  });
}

async function probe(): Promise<Response> {
  const app = new Hono<HonoAppEnv>();
  app.route("/health", healthRoutes);
  return app.request("/health", undefined, healthEnv());
}

function installClients(resultFor: (role: DatabaseRole) => string | Error): void {
  mocks.createPostgresClient.mockImplementation((_env: unknown, role: DatabaseRole) => ({
    health: async () => {
      const result = resultFor(role);
      if (result instanceof Error) throw result;
      return { databaseTime: new Date(0), role: result };
    },
    close: async () => undefined,
  }));
}

describe("Postgres authority health", () => {
  beforeEach(() => {
    mocks.createPostgresClient.mockReset();
  });

  it("probes every database role required by the Global Worker", async () => {
    installClients((role) => EXPECTED_POSTGRES_ROLE[role]);

    const response = await probe();
    const body = await response.json() as {
      checks: Record<string, { ok: boolean; message: string }>;
    };

    expect(response.status).toBe(200);
    expect(mocks.createPostgresClient.mock.calls.map((call) => call[1])).toEqual([
      "regional_router",
      "workflow_runner",
      "queue_runner",
      "global_router",
    ]);
    expect(body.checks.postgres).toEqual({ ok: true, message: "postgres authority available" });
    for (const role of ["regional_router", "workflow_runner", "queue_runner", "global_router"] as const) {
      expect(body.checks[`postgres.${role}`]).toEqual({ ok: true, message: "available" });
    }
  });

  it("fails authority health when a required role has the wrong credentials", async () => {
    installClients((role) => role === "queue_runner"
      ? EXPECTED_POSTGRES_ROLE.workflow_runner
      : EXPECTED_POSTGRES_ROLE[role]);

    const response = await probe();
    const body = await response.json() as {
      checks: Record<string, { ok: boolean; message: string }>;
    };

    expect(response.status).toBe(503);
    expect(body.checks["postgres.queue_runner"]).toEqual({ ok: false, message: "unexpected database role" });
    expect(body.checks.postgres).toEqual({
      ok: false,
      message: "postgres authority unavailable: queue_runner",
    });
  });

  it("fails authority health when a required database is unavailable", async () => {
    installClients((role) => role === "regional_router"
      ? new Error("database unavailable")
      : EXPECTED_POSTGRES_ROLE[role]);

    const response = await probe();
    const body = await response.json() as {
      checks: Record<string, { ok: boolean; message: string }>;
    };

    expect(response.status).toBe(503);
    expect(body.checks["postgres.regional_router"]).toEqual({ ok: false, message: "unavailable" });
    expect(body.checks.postgres?.ok).toBe(false);
  });
});
