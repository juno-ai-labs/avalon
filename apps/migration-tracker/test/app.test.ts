/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { DurableObjectMigrationReport } from "@avalon/contracts/durable-object-migrations";
import { app, parseObjectQuery } from "../src/app";
import type { Env } from "../src/env";
import { REGISTRY_OBJECT_NAME } from "../src/registry";
import type { MigrationRegistry } from "../src/registry";
import { ObjectQuerySchema } from "../src/protocol";
import { consumeMigrationReports } from "../src/index";
import { createTestMessageBatch } from "./helpers/cloudflare-test";

const OBJECT_ID = "a".repeat(64);
let reportSequence = 0;
const OBJECT_NAME = "global:00000000-0000-7000-8000-0000000000a1:00000000-0000-7000-8000-0000000000a2";

function report(overrides: Partial<DurableObjectMigrationReport> = {}): DurableObjectMigrationReport {
  reportSequence += 1;
  return {
    reportId: `00000000-0000-7000-8000-${String(reportSequence).padStart(12, "0")}`,
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

/** Drive the queue consumer the way the runtime would, one batch at a time. */
async function deliver(...bodies: unknown[]): Promise<ReturnType<typeof createTestMessageBatch>> {
  const delivery = createTestMessageBatch(bodies);
  await consumeMigrationReports(delivery.batch, env);
  return delivery;
}

/** The same bindings the Worker holds, with the local Access bypass turned on. */
function developerEnv(): Env {
  return { ...env, APP_ENV: "development", MIGRATION_TRACKER_DEV_AUTH: "true" };
}

async function get(path: string, environment: Env = developerEnv()): Promise<Response> {
  return app.fetch(
    new Request(`https://migrations.rallywith.ai${path}`),
    environment,
  );
}

async function withRegistry<T>(
  run: (registry: MigrationRegistry, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  const stub = env.MIGRATION_REGISTRY.get(
    env.MIGRATION_REGISTRY.idFromName(REGISTRY_OBJECT_NAME),
  );
  return runInDurableObject(stub, async (instance, state) => run(instance, state));
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
    await deliver(report());

    const response = await get("/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Avalon Durable Object migrations");
    expect(body).toContain("workstream");
    expect(body).toContain("Current");
  });

  it("renders an object's report history", async () => {
    await deliver(report(), report({
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
    await deliver(report());

    const body = await (await get("/objects")).text();

    // The row shows a shortened name and carries the full one as its title, so
    // the timestamp columns stay on screen without losing the identifier.
    expect(body).toContain("global:00000000…:00000000…");
    expect(body).toContain(`title="${OBJECT_NAME}"`);
  });

  it("warns prominently while the inventory sweep is failing", async () => {
    await withRegistry((registry) => {
      registry.recordSweep({
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_001_000,
        status: "complete",
        namespaces: [],
        truncatedNamespaces: [],
        errorMessage: null,
      });
      registry.recordSweep({
        startedAt: 1_700_000_900_000,
        finishedAt: 1_700_000_999_000,
        status: "failed",
        namespaces: [],
        truncatedNamespaces: [],
        errorMessage: "cloudflare_api_error_10000",
      });
    });

    const body = await (await get("/")).text();

    // A failed sweep writes a fresh receipt, so the banner has to key off the
    // last sweep that actually enumerated rather than the newest one.
    expect(body).toContain("The last inventory sweep failed");
    expect(body).toContain("cloudflare_api_error_10000");
  });

  it("answers 404 for an object it has never heard of", async () => {
    expect((await get(`/objects/${"f".repeat(64)}`)).status).toBe(404);
    expect((await get(`/api/objects/${"f".repeat(64)}`)).status).toBe(404);
  });

  it("serves the same data as JSON", async () => {
    await deliver(report());

    const response = await get("/api/objects?status=current");
    const body = await response.json() as { total: number; objects: { objectId: string }[] };

    expect(body.total).toBe(1);
    expect(body.objects[0]?.objectId).toBe(OBJECT_ID);
  });

  it("escapes a failure message rather than rendering it as markup", async () => {
    await deliver(report({
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

  /**
   * A bad value drops its own field, not the operator's whole query. Dropping
   * everything turns "your limit was out of range" into a page showing the
   * entire unfiltered fleet under the component heading they asked for.
   */
  it("keeps the filters that are valid when one value is not", () => {
    const query = parseObjectQuery(
      "https://x/objects?component=workstream&region=eu&status=nonsense&limit=99999",
    );

    expect(query.component).toBe("workstream");
    expect(query.region).toBe("eu");
    expect(query.status).toBeUndefined();
    expect(query.limit).toBe(50);
  });
});

describe("the queue consumer", () => {
  it("acknowledges a malformed message rather than redelivering the batch", async () => {
    const valid = report();
    const delivery = await deliver({ ...report(), objectId: "too-short" }, valid);

    // The malformed one is dropped on purpose: it can never become valid, and
    // leaving it unacknowledged would redeliver the valid report beside it.
    expect(delivery.messages[0]?.acked).toBe(true);
    expect(delivery.messages[1]?.acked).toBe(false);

    const page = await withRegistry((registry) => registry.listObjects(ObjectQuerySchema.parse({})));
    expect(page.total).toBe(1);
  });

  it("refuses a report whose object name is not opaque", async () => {
    const delivery = await deliver({ ...report(), objectName: "eu:acme-corporation:payroll" });

    expect(delivery.messages[0]?.acked).toBe(true);
    const page = await withRegistry((registry) => registry.listObjects(ObjectQuerySchema.parse({})));
    expect(page.total).toBe(0);
  });

  it("leaves a well-formed message unacknowledged so a failed write redelivers it", async () => {
    const delivery = await deliver(report());

    expect(delivery.messages[0]?.acked).toBe(false);
    expect(delivery.messages[0]?.retried).toBe(false);
  });

  it("records a redelivered report once", async () => {
    // Queues deliver at least once; the same message arriving twice is normal.
    const duplicate = report();
    await deliver(duplicate);
    await deliver(duplicate);

    const detail = await withRegistry((registry) => registry.objectDetail(OBJECT_ID));
    expect(detail?.events).toHaveLength(1);
  });

  it("does not let an out-of-order delivery overwrite a newer report", async () => {
    const older = report({ schemaVersion: 3, occurredAt: 1_700_000_000_000 });
    const newer = report({ schemaVersion: 4, latestVersion: 4, occurredAt: 1_700_000_060_000 });

    await deliver(newer);
    await deliver(older);

    const detail = await withRegistry((registry) => registry.objectDetail(OBJECT_ID));
    // The object row keeps the newer version...
    expect(detail?.object.schemaVersion).toBe(4);
    // ...while the history keeps both reports.
    expect(detail?.events).toHaveLength(2);
  });

  it("folds a whole batch into one pass", async () => {
    const delivery = await deliver(
      report({ objectId: "b".repeat(64), objectName: null }),
      report({ objectId: "c".repeat(64), objectName: null }),
      report({ objectId: "d".repeat(64), objectName: null }),
    );

    expect(delivery.messages.every((message) => !message.acked)).toBe(true);
    const page = await withRegistry((registry) => registry.listObjects(ObjectQuerySchema.parse({})));
    expect(page.total).toBe(3);
  });
});
