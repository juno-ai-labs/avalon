/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { DurableObjectMigrationReport } from "@avalon/contracts/durable-object-migrations";
import { app, parseObjectQuery } from "../src/app";
import type { Env } from "../src/env";
import { REGISTRY_OBJECT_NAME } from "../src/registry";
import { MigrationReportBridge } from "../src/index";

const OBJECT_ID = "a".repeat(64);
const OBJECT_NAME = "global:00000000-0000-7000-8000-0000000000a1:00000000-0000-7000-8000-0000000000a2";

function report(overrides: Partial<DurableObjectMigrationReport> = {}): DurableObjectMigrationReport {
  return {
    objectId: OBJECT_ID,
    objectName: OBJECT_NAME,
    className: "SubstreamAgent",
    component: "workstream",
    region: "global",
    appEnv: "production",
    workerVersionId: "0.24.0",
    status: "applied",
    schemaVersion: 3,
    latestVersion: 3,
    appliedVersions: [3],
    failure: null,
    occurredAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** The same bindings the Worker holds, with the local Access bypass turned on. */
function developerEnv(): Env {
  return { ...env, APP_ENV: "development", MIGRATION_TRACKER_DEV_AUTH: "true" };
}

async function get(path: string, environment: Env = developerEnv()): Promise<Response> {
  return app.fetch(
    new Request(`https://migrations.internal.with-avalon.com${path}`),
    environment,
  );
}

beforeEach(async () => {
  const stub = env.MIGRATION_REGISTRY.get(
    env.MIGRATION_REGISTRY.idFromName(REGISTRY_OBJECT_NAME),
  );
  await runInDurableObject(stub, (_instance, state) => {
    const storage = state.storage;
    for (const table of [
      "durable_objects",
      "migration_events",
      "component_versions",
      "inventory_sweeps",
      "durable_object_namespaces",
    ]) {
      storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
});

describe("access enforcement", () => {
  it("refuses an HTML request that carries no Access assertion", async () => {
    const response = await get("/", { ...env, APP_ENV: "production" });

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain("Not authorized");
  });

  it("refuses a JSON request with a machine-readable reason", async () => {
    const response = await get("/api/overview", { ...env, APP_ENV: "production" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_assertion_missing" });
  });

  it("refuses everything when Access is not configured, even in staging", async () => {
    const response = await get("/api/overview", {
      ...env,
      APP_ENV: "staging",
      ACCESS_APPLICATION_AUD: "",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_not_configured" });
  });

  it("ignores the development bypass outside development", async () => {
    const response = await get("/", {
      ...env,
      APP_ENV: "production",
      MIGRATION_TRACKER_DEV_AUTH: "true",
    });

    expect(response.status).toBe(403);
  });
});

describe("the operator site", () => {
  it("renders the overview with the fleet's counts", async () => {
    await new MigrationReportBridge(createExecutionContext(), env).report(report());

    const response = await get("/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Avalon Durable Object migrations");
    expect(body).toContain("workstream");
    expect(body).toContain("Current");
  });

  it("renders an object's report history", async () => {
    const bridge = new MigrationReportBridge(createExecutionContext(), env);
    await bridge.report(report());
    await bridge.report(report({
      status: "failed",
      schemaVersion: 3,
      appliedVersions: [],
      failure: { message: "workstream_schema_hash_mismatch:4", version: 4 },
    }));

    const response = await get(`/objects/${OBJECT_ID}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(OBJECT_NAME);
    expect(body).toContain("workstream_schema_hash_mismatch:4");
    expect(body).toContain("Failed");
  });

  it("abbreviates a name in the list but keeps the whole one reachable", async () => {
    await new MigrationReportBridge(createExecutionContext(), env).report(report());

    const body = await (await get("/objects")).text();

    // The row shows a shortened name and carries the full one as its title, so
    // the timestamp columns stay on screen without losing the identifier.
    expect(body).toContain("global:00000000…:00000000…");
    expect(body).toContain(`title="${OBJECT_NAME}"`);
  });

  it("answers 404 for an object it has never heard of", async () => {
    expect((await get(`/objects/${"f".repeat(64)}`)).status).toBe(404);
    expect((await get(`/api/objects/${"f".repeat(64)}`)).status).toBe(404);
  });

  it("serves the same data as JSON", async () => {
    await new MigrationReportBridge(createExecutionContext(), env).report(report());

    const response = await get("/api/objects?status=current");
    const body = await response.json() as { total: number; objects: { objectId: string }[] };

    expect(body.total).toBe(1);
    expect(body.objects[0]?.objectId).toBe(OBJECT_ID);
  });

  it("escapes a failure message rather than rendering it as markup", async () => {
    await new MigrationReportBridge(createExecutionContext(), env).report(report({
      status: "failed",
      appliedVersions: [],
      failure: { message: "<script>alert(1)</script>", version: null },
    }));

    const body = await (await get(`/objects/${OBJECT_ID}`)).text();

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

describe("parseObjectQuery", () => {
  it("reads every filter the site offers", () => {
    const query = parseObjectQuery(
      "https://x/objects?status=behind&component=workstream&region=eu&script=avalon-api-eu"
      + "&search=abc&limit=10&offset=20",
    );

    expect(query).toMatchObject({
      status: "behind",
      component: "workstream",
      region: "eu",
      scriptName: "avalon-api-eu",
      search: "abc",
      limit: 10,
      offset: 20,
    });
  });

  it("treats the filter form's empty selections as absent", () => {
    const query = parseObjectQuery("https://x/objects?status=&component=workstream&region=&search=");

    expect(query.component).toBe("workstream");
    expect(query.status).toBeUndefined();
    expect(query.limit).toBe(50);
  });

  it("falls back to the default query when a value is unusable", () => {
    const query = parseObjectQuery("https://x/objects?status=nonsense&limit=99999");

    expect(query).toMatchObject({ limit: 50, offset: 0 });
    expect(query.status).toBeUndefined();
  });
});

describe("MigrationReportBridge", () => {
  it("rejects a report that does not match the contract", async () => {
    const bridge = new MigrationReportBridge(createExecutionContext(), env);

    await expect(bridge.report({ ...report(), objectId: "too-short" }))
      .rejects.toThrow("migration_report_rejected");
  });

  it("rejects a report whose object name is not opaque", async () => {
    const bridge = new MigrationReportBridge(createExecutionContext(), env);

    await expect(bridge.report({ ...report(), objectName: "eu:acme-corporation:payroll" }))
      .rejects.toThrow("migration_report_rejected");
  });
});
