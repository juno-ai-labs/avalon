import "../../../tests/isolated-region";
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  DurableObjectMigrationCommand,
  DurableObjectMigrationReport,
} from "@rally/contracts/durable-object-migrations";
import { app, parseObjectQuery } from "../src/app";
import type { Env } from "../src/env";
import { REGISTRY_OBJECT_NAME } from "../src/registry";
import type { MigrationRegistry } from "../src/registry";
import { ObjectQuerySchema } from "../src/protocol";
import { consumeMigrationReports } from "../src/index";
import { createRecordingQueue, createTestMessageBatch } from "./helpers/cloudflare-test";

const OBJECT_ID = "a".repeat(64);
const SITE_ORIGIN = "https://migrations.internal.rallywith.ai";
let reportSequence = 0;
const OBJECT_NAME = "global:00000000-0000-7000-8000-0000000000a1:00000000-0000-7000-8000-0000000000a2";

function report(overrides: Partial<DurableObjectMigrationReport> = {}): DurableObjectMigrationReport {
  reportSequence += 1;
  return {
    reportId: `00000000-0000-7000-8000-${String(reportSequence).padStart(12, "0")}`,
    objectId: OBJECT_ID,
    objectName: OBJECT_NAME,
    className: "AgentLoopDO",
    component: "substream_agent_do",
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
    new Request(`https://migrations.internal.rallywith.ai${path}`),
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
      "migration_runs",
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

/** The header cells of every table on a page, one array per table. */
function tableHeaders(body: string): string[][] {
  return [...body.matchAll(/<thead>([\s\S]*?)<\/thead>/g)].map((table) =>
    [...table[1]!.matchAll(/<th>([\s\S]*?)<\/th>/g)].map((cell) => cell[1]!.trim()),
  );
}

describe("the operator site", () => {
  it("renders the overview with the fleet's counts", async () => {
    await deliver(report());

    const response = await get("/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Avalon Durable Object migrations");
    expect(body).toContain("substream_agent_do");
    expect(body).toContain("Current");
  });

  it("shows enumerated empty identities separately from stored objects", async () => {
    await deliver(report());
    await withRegistry((registry) => {
      registry.recordSweep({
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_001_000,
        status: "complete",
        namespaces: [{
          namespaceId: "ns-global",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [
            { objectId: OBJECT_ID, hasStoredData: false },
            { objectId: "b".repeat(64), hasStoredData: true },
          ],
        }],
        truncatedNamespaces: [],
        errorMessage: null,
      });
    });

    const overview = await (await get("/")).text();
    const emptyObject = await (await get(`/objects/${OBJECT_ID}`)).text();
    const emptyText = emptyObject.replace(/\s+/gu, " ");

    expect(overview).toMatch(/<div class="n">1<\/div>\s*<div class="k">Empty<\/div>/u);
    expect(overview).toContain(".empty-state { padding: 22px");
    expect(overview).not.toContain(".empty { padding: 22px");
    expect(tableHeaders(overview)).toContainEqual(
      ["Script", "Class", "Storage", "Stored", "IDs", "Swept"],
    );
    expect(emptyText).toContain("latest inventory sweep found no stored data");
    expect(emptyText).toContain("not a forced-migration target");
    expect(emptyObject).toContain("Report history");
  });

  it("renders an object's report history", async () => {
    await deliver(report(), report({
      status: "failed",
      schemaVersion: 3,
      appliedVersions: [],
      failure: { message: "substream_agent_do_schema_hash_mismatch:4", version: 4 },
    }));

    const response = await get(`/objects/${OBJECT_ID}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(OBJECT_NAME);
    expect(body).toContain("substream_agent_do_schema_hash_mismatch:4");
    expect(body).toContain("Failed");
  });

  it("keeps the applied versions out of both report tables", async () => {
    await deliver(report({ schemaVersion: 11, latestVersion: 11, appliedVersions: [7, 11] }));

    const overview = await (await get("/")).text();
    const objectHistory = await (await get(`/objects/${OBJECT_ID}`)).text();

    // Both report tables come from the same `eventTable`, and the column an
    // operator asked to be rid of is the one a later change is most likely to
    // put back by rendering the field that is still on `MigrationEvent`. Assert
    // the whole header sequence rather than the absence of one cell: a stray
    // `<th>` would otherwise slide `Worker version` and `Detail` one column
    // left, which reads as plausible markup and wrong data.
    expect(tableHeaders(overview)).toContainEqual(
      ["When", "Object", "Status", "Version", "Head", "Worker version", "Detail"],
    );
    expect(tableHeaders(objectHistory)).toContainEqual(
      ["When", "Status", "Version", "Head", "Worker version", "Detail"],
    );
    expect(overview).not.toContain("7, 11");
    expect(objectHistory).not.toContain("7, 11");
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
      "https://x/objects?status=behind&component=substream_agent_do&region=enterprise&script=avalon-api-enterprise"
      + "&search=abc&limit=10&offset=20",
    );

    expect(query).toMatchObject({
      status: "behind",
      component: "substream_agent_do",
      region: "enterprise",
      scriptName: "avalon-api-enterprise",
      search: "abc",
      limit: 10,
      offset: 20,
    });
  });

  it("treats the filter form's empty selections as absent", () => {
    const query = parseObjectQuery("https://x/objects?status=&component=substream_agent_do&region=&search=");

    expect(query.component).toBe("substream_agent_do");
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
      "https://x/objects?component=substream_agent_do&region=enterprise&status=nonsense&limit=99999",
    );

    expect(query.component).toBe("substream_agent_do");
    expect(query.region).toBe("enterprise");
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
    const delivery = await deliver({ ...report(), objectName: "enterprise:acme-corporation:payroll" });

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

/**
 * The **Force a migration** page, which is the only route on this site that
 * writes anything.
 */
describe("the force a migration page", () => {
  function sweepIn(className: string, region: string, ids: string[]): Promise<void> {
    return withRegistry((registry) => {
      registry.recordSweep({
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_001_000,
        status: "complete",
        namespaces: [{
          namespaceId: `ns-${region}`,
          scriptName: `avalon-api-${region}`,
          className,
          usesSqlite: true,
          objects: ids.map((id) => ({ objectId: id, hasStoredData: true })),
        }],
        truncatedNamespaces: [],
        errorMessage: null,
      });
    });
  }

  async function post(
    body: BodyInit,
    headers: Record<string, string>,
    environment: Env,
  ): Promise<Response> {
    return app.fetch(
      new Request("https://migrations.internal.rallywith.ai/migrations", {
        method: "POST",
        headers,
        body,
      }),
      environment,
    );
  }

  it("offers only the classes an inventory sweep has found", async () => {
    await sweepIn("WorkspaceDO", "global", [OBJECT_ID]);

    const body = await (await get("/migrations")).text();

    expect(body).toContain("WorkspaceDO");
    expect(body).toContain("Migrate every object");
    // The size of the run is on the page before the button is pressed, not
    // discovered from the result afterwards.
    expect(tableHeaders(body)[0]).toEqual([
      "Class", "Region", "Objects", "Behind", "Failed", "Unreported",
    ]);
  });

  it("dispatches a run and redirects to the row it created", async () => {
    await sweepIn("WorkspaceDO", "global", [OBJECT_ID]);
    const queue = createRecordingQueue<DurableObjectMigrationCommand>();
    const environment: Env = { ...developerEnv(), GLOBAL_MIGRATION_COMMAND_QUEUE: queue.queue };

    const response = await post(
      new URLSearchParams({ className: "WorkspaceDO", region: "" }),
      { "content-type": "application/x-www-form-urlencoded", origin: SITE_ORIGIN },
      environment,
    );

    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/migrations\?run=/u);
    expect(queue.sent.map((command) => command.objectId)).toEqual([OBJECT_ID]);

    const page = await (await get(location, environment)).text();
    expect(page).toContain("dispatched");
    expect(page).toContain("developer@localhost");
  });

  /**
   * Access authenticates the operator; it says nothing about whether they meant
   * to submit this. Their session cookie travels with a form another site
   * posts, so the assertion on such a request is genuine and proves the wrong
   * thing.
   */
  it("refuses a write that a browser reports as coming from another site", async () => {
    await sweepIn("WorkspaceDO", "global", [OBJECT_ID]);
    const queue = createRecordingQueue<DurableObjectMigrationCommand>();
    const environment: Env = { ...developerEnv(), GLOBAL_MIGRATION_COMMAND_QUEUE: queue.queue };

    const response = await post(
      new URLSearchParams({ className: "WorkspaceDO" }),
      { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      environment,
    );

    expect(response.status).toBe(403);
    expect(queue.sent).toEqual([]);
  });

  it("refuses a JSON run from another origin the same way", async () => {
    const response = await app.fetch(
      new Request("https://migrations.internal.rallywith.ai/api/migrations", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ className: "WorkspaceDO" }),
      }),
      developerEnv(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "cross_origin_write" });
  });

  it("answers a run with no class with the page and a 400", async () => {
    const response = await post(
      new URLSearchParams({ className: "" }),
      { "content-type": "application/x-www-form-urlencoded", origin: SITE_ORIGIN },
      developerEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Pick a class to migrate.");
  });

  /**
   * The page's class list is a rendering of what is forceable, not a constraint
   * on it: both writes take a class name from a request body. A class no Worker
   * can migrate has to be refused before anything is queued, or every object of
   * it is dispatched, retried, and dead-lettered while the run says otherwise.
   */
  it("refuses a class no Worker can migrate, from JSON", async () => {
    const queue = createRecordingQueue<DurableObjectMigrationCommand>();
    const environment: Env = { ...developerEnv(), GLOBAL_MIGRATION_COMMAND_QUEUE: queue.queue };

    const response = await app.fetch(
      new Request("https://migrations.internal.rallywith.ai/api/migrations", {
        method: "POST",
        headers: { "content-type": "application/json", origin: SITE_ORIGIN },
        body: JSON.stringify({ className: "CrashSymbolicatorContainer" }),
      }),
      environment,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_migration_run_request",
    });
    expect(queue.sent).toEqual([]);
  });

  it("refuses the same class from a hand-edited form", async () => {
    await sweepIn("WorkspaceDO", "global", [OBJECT_ID]);
    const queue = createRecordingQueue<DurableObjectMigrationCommand>();
    const environment: Env = { ...developerEnv(), GLOBAL_MIGRATION_COMMAND_QUEUE: queue.queue };

    const response = await post(
      new URLSearchParams({ className: "MigrationRegistry" }),
      { "content-type": "application/x-www-form-urlencoded", origin: SITE_ORIGIN },
      environment,
    );

    expect(response.status).toBe(400);
    expect(queue.sent).toEqual([]);
  });

  it("serves the same run list as JSON", async () => {
    await sweepIn("WorkspaceDO", "enterprise", [OBJECT_ID]);

    const body = await (await get("/api/migrations")).json();

    expect(body).toMatchObject({
      components: [{ className: "WorkspaceDO", region: "enterprise", objects: 1 }],
      runs: [],
      dispatchableRegions: [],
    });
  });

  it("is behind the same Access check as every other route", async () => {
    const response = await get("/migrations", { ...env, APP_ENV: "production" });

    expect(response.status).toBe(403);
  });
});
