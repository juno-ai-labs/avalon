import "../../../tests/isolated-region";
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { DurableObjectMigrationReport } from "@rally/contracts/durable-object-migrations";
import { REGISTRY_OBJECT_NAME } from "../src/registry";
import { applyRegistrySchema, REGISTRY_MIGRATIONS } from "../src/schema";
import type { MigrationRegistry } from "../src/registry";
import {
  MigrationRunRequestSchema,
  ObjectQuerySchema,
  REPORTING_CLASSES,
  type InventorySweep,
  type MigrationRun,
} from "../src/protocol";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000a1";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000a2";

function objectId(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

let reportSequence = 0;

/** A fresh id per report; the registry dedupes on it, so fixtures must differ. */
function nextReportId(): string {
  reportSequence += 1;
  return `00000000-0000-7000-8000-${String(reportSequence).padStart(12, "0")}`;
}

/** One report at a time, against the batch method the consumer actually calls. */
function record(registry: MigrationRegistry, ...reports: DurableObjectMigrationReport[]): void {
  registry.recordReports(reports);
}

function report(overrides: Partial<DurableObjectMigrationReport> = {}): DurableObjectMigrationReport {
  return {
    reportId: nextReportId(),
    objectId: objectId("a"),
    objectName: `global:${WORKSPACE_ID}:${WORKSTREAM_ID}`,
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

function sweep(overrides: Partial<InventorySweep> = {}): InventorySweep {
  return {
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    status: "complete",
    namespaces: [],
    truncatedNamespaces: [],
    errorMessage: null,
    ...overrides,
  };
}

/** The head the old key was last seen at, and the one the new key carries. */
const LEGACY_OBSERVED_AT = 1_700_000_000_000;
const RENAMED_OBSERVED_AT = LEGACY_OBSERVED_AT + 60_000;

/**
 * Rewrite every stored component back to the pre-rename key.
 *
 * Reports cannot seed this: `applyReport` normalizes the legacy key on the way
 * in, which is the whole point of the compatibility branch — so a test that
 * seeded through it would prove the migration works against a database that
 * never held the old key. This writes the shape v3 actually meets.
 *
 * `observed_at` is stamped too, because the registry writes it from its own
 * clock: both sides of a collision otherwise land in the same millisecond, and
 * the merge's `MAX` has nothing to choose between.
 */
function rewindToLegacyComponent(state: DurableObjectState): void {
  for (const table of ["durable_objects", "migration_events"]) {
    state.storage.sql.exec(`UPDATE ${table} SET component = 'workstream'`);
  }
  state.storage.sql.exec(
    `UPDATE component_versions SET component = 'workstream', observed_at = ?`,
    LEGACY_OBSERVED_AT,
  );
}

function migrationRun(overrides: Partial<MigrationRun> = {}): MigrationRun {
  return {
    runId: nextReportId(),
    className: "AgentLoopDO",
    region: null,
    requestedBy: "operator@example.test",
    requestedAt: 1_700_000_000_000,
    matched: 1,
    dispatched: 1,
    unroutable: 0,
    truncated: false,
    status: "dispatched",
    errorMessage: null,
    ...overrides,
  };
}

/** A fresh registry per test; the object is a singleton, so it is reset by hand. */
async function withRegistry<T>(
  run: (registry: MigrationRegistry, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  const stub = env.MIGRATION_REGISTRY.get(
    env.MIGRATION_REGISTRY.idFromName(REGISTRY_OBJECT_NAME),
  );
  return runInDurableObject(stub, async (instance, state) => run(instance, state));
}

beforeEach(async () => {
  await withRegistry((_registry, state) => {
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

describe("recordReport", () => {
  it("records a successful migration and marks the object current", async () => {
    const page = await withRegistry((registry) => {
      record(registry, report());
      return registry.listObjects(ObjectQuerySchema.parse({}));
    });

    expect(page.total).toBe(1);
    const object = page.objects[0];
    expect(object?.status).toBe("current");
    expect(object?.schemaVersion).toBe(3);
    expect(object?.componentLatestVersion).toBe(3);
    expect(object?.objectName).toBe(`global:${WORKSPACE_ID}:${WORKSTREAM_ID}`);
    expect(object?.hasStoredData).toBe(true);
  });

  it("marks an object behind once another object reports a higher head", async () => {
    const page = await withRegistry((registry) => {
      record(registry, report({ objectId: objectId("a"), schemaVersion: 3, latestVersion: 3 }));
      record(registry, report({
        objectId: objectId("b"),
        objectName: null,
        schemaVersion: 4,
        latestVersion: 4,
        appliedVersions: [4],
      }));
      return registry.listObjects(ObjectQuerySchema.parse({}));
    });

    const behind = page.objects.find((object) => object.objectId === objectId("a"));
    const current = page.objects.find((object) => object.objectId === objectId("b"));
    expect(behind?.status).toBe("behind");
    expect(behind?.componentLatestVersion).toBe(4);
    expect(current?.status).toBe("current");
  });

  it("keeps the component head monotonic across a rollback", async () => {
    const overview = await withRegistry((registry) => {
      record(registry, report({ schemaVersion: 4, latestVersion: 4 }));
      record(registry, report({
        objectId: objectId("b"),
        objectName: null,
        schemaVersion: 3,
        latestVersion: 3,
        workerVersionId: "0.23.0",
      }));
      return registry.overview();
    });

    expect(overview.components[0]?.latestVersion).toBe(4);
    expect(overview.components[0]?.workerVersionId).toBe("0.24.0");
    expect(overview.totals.behind).toBe(1);
  });

  it("keeps a failure visible with its message and version", async () => {
    const detail = await withRegistry((registry) => {
      record(registry, report({
        status: "failed",
        schemaVersion: 2,
        appliedVersions: [],
        failure: { message: "substream_agent_do_schema_hash_mismatch:3", version: 3 },
      }));
      return registry.objectDetail(objectId("a"));
    });

    expect(detail?.object.status).toBe("failed");
    expect(detail?.object.failureMessage).toBe("substream_agent_do_schema_hash_mismatch:3");
    expect(detail?.object.failureVersion).toBe(3);
    expect(detail?.events).toHaveLength(1);
    expect(detail?.events[0]?.status).toBe("failed");
  });

  it("clears a failure when the object next reports success", async () => {
    const object = await withRegistry((registry) => {
      record(registry, report({
        status: "failed",
        schemaVersion: 2,
        appliedVersions: [],
        failure: { message: "substream_agent_do_schema_hash_mismatch:3", version: 3 },
      }));
      record(registry, report({ status: "applied", schemaVersion: 3, appliedVersions: [3] }));
      return registry.objectDetail(objectId("a"))?.object;
    });

    expect(object?.status).toBe("current");
    expect(object?.failureMessage).toBeNull();
    // The failure stays on the history even though the object recovered.
    const detail = await withRegistry((registry) => registry.objectDetail(objectId("a")));
    expect(detail?.events.map((event) => event.status)).toEqual(["applied", "failed"]);
  });

  it("appends one event per report and preserves the applied versions", async () => {
    const detail = await withRegistry((registry) => {
      record(registry, report({ schemaVersion: 3, appliedVersions: [1, 2, 3] }));
      record(registry, report({ status: "current", appliedVersions: [] }));
      return registry.objectDetail(objectId("a"));
    });

    expect(detail?.events).toHaveLength(2);
    expect(detail?.events[1]?.appliedVersions).toEqual([1, 2, 3]);
    expect(detail?.events[0]?.appliedVersions).toEqual([]);
  });
});

describe("recordSweep", () => {
  it("separates stored objects awaiting a report from empty identities", async () => {
    const result = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-1",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [
            { objectId: objectId("c"), hasStoredData: true },
            { objectId: objectId("d"), hasStoredData: false },
          ],
        }],
      }));
      return {
        page: registry.listObjects(ObjectQuerySchema.parse({})),
        emptyPage: registry.listObjects(ObjectQuerySchema.parse({ status: "empty" })),
      };
    });

    expect(result.page.total).toBe(2);
    expect(new Map(
      result.page.objects.map((object) => [object.objectId, object.status]),
    )).toEqual(new Map([
      [objectId("c"), "unreported"],
      [objectId("d"), "empty"],
    ]));
    expect(result.page.objects.every(
      (object) => object.scriptName === "avalon-api-global",
    )).toBe(true);
    expect(result.emptyPage.objects.map((object) => object.objectId)).toEqual([objectId("d")]);
  });

  it("uses the object's observation time when a later report revives an empty identity", async () => {
    const detail = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-1",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [{
            objectId: objectId("a"),
            hasStoredData: false,
            observedAt: 1_700_000_000_500,
          }],
        }],
      }));
      // This report happened after the object's page was observed but before
      // the whole account sweep finished at 1_700_000_001_000.
      record(registry, report({ occurredAt: 1_700_000_000_750 }));
      return registry.objectDetail(objectId("a"));
    });

    expect(detail?.object.status).toBe("current");
    expect(detail?.object.hasStoredData).toBe(true);
    expect(detail?.object.lastSweptAt).toBe(1_700_000_000_500);
  });

  /** The report changes effective liveness, not the inventory fact it follows. */
  it("keeps the swept storage fact immutable while a newer report makes the object live", async () => {
    const result = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-global",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("a"), hasStoredData: false }],
        }],
      }));
      const lastSweptAt = registry.objectDetail(objectId("a"))?.object.lastSweptAt ?? 0;
      record(registry, report({ occurredAt: lastSweptAt + 1 }));
      return {
        detail: registry.objectDetail(objectId("a")),
        namespace: registry.overview().namespaces[0],
        components: registry.forceableComponents(),
        selection: registry.migrationTargets({ className: "AgentLoopDO" }),
      };
    });

    expect(result.detail?.object.status).toBe("current");
    expect(result.detail?.object.hasStoredData).toBe(true);
    // The object read is current, while the namespace count still truthfully
    // reports that the preceding Cloudflare listing saw no stored data.
    expect(result.namespace?.storedObjectCount).toBe(0);
    expect(result.components[0]?.objects).toBe(1);
    expect(result.selection.targets.map((target) => target.objectId)).toEqual([objectId("a")]);
  });

  it("does not let a stale-occurredAt report revive storage after a sweep found it empty", async () => {
    const result = await withRegistry((registry) => {
      record(registry, report());
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-1",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("a"), hasStoredData: false }],
        }],
      }));
      record(registry, report({ occurredAt: 1_700_000_000_001 }));
      return {
        overview: registry.overview(),
        detail: registry.objectDetail(objectId("a")),
      };
    });

    expect(result.overview.totals.empty).toBe(1);
    expect(result.overview.totals.current).toBe(0);
    expect(result.overview.components[0]?.empty).toBe(1);
    expect(result.overview.components[0]?.total).toBe(0);
    expect(result.detail?.events).toHaveLength(2);
  });

  it("lets an empty inventory observation win a report timestamp tie", async () => {
    const detail = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-1",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [{
            objectId: objectId("a"),
            hasStoredData: false,
            observedAt: 1_700_000_000_500,
          }],
        }],
      }));
      record(registry, report({ occurredAt: 1_700_000_000_500 }));
      return registry.objectDetail(objectId("a"));
    });

    expect(detail?.object.status).toBe("empty");
    expect(detail?.object.hasStoredData).toBe(false);
  });

  it("retires a historical migration failure after its storage is cleared", async () => {
    const result = await withRegistry((registry) => {
      record(registry, report({
        status: "failed",
        appliedVersions: [],
        failure: { message: "substream_agent_do_schema_hash_mismatch:4", version: 4 },
      }));
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-1",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("a"), hasStoredData: false }],
        }],
      }));
      return {
        detail: registry.objectDetail(objectId("a")),
        recentFailures: registry.overview().recentFailures,
      };
    });

    expect(result.detail?.object.status).toBe("empty");
    expect(result.recentFailures).toEqual([]);
  });

  it("joins a swept object to the report that arrives later", async () => {
    const detail = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-1",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("a"), hasStoredData: true }],
        }],
      }));
      record(registry, report());
      return registry.objectDetail(objectId("a"));
    });

    expect(detail?.object.status).toBe("current");
    expect(detail?.object.scriptName).toBe("avalon-api-global");
    expect(detail?.object.namespaceId).toBe("ns-1");
    expect(detail?.object.hasStoredData).toBe(true);
  });

  it("marks an object absent once a complete sweep no longer lists it", async () => {
    const detail = await withRegistry((registry) => {
      const namespace = {
        namespaceId: "ns-1",
        scriptName: "avalon-api-global",
        className: "AgentLoopDO",
        usesSqlite: true,
      };
      registry.recordSweep(sweep({
        namespaces: [{ ...namespace, objects: [{ objectId: objectId("a"), hasStoredData: true }] }],
      }));
      registry.recordSweep(sweep({ namespaces: [{ ...namespace, objects: [] }] }));
      return registry.objectDetail(objectId("a"));
    });

    expect(detail?.object.status).toBe("absent");
    expect(detail?.object.absentSince).not.toBeNull();
  });

  it("never marks an object absent from a truncated namespace listing", async () => {
    const detail = await withRegistry((registry) => {
      const namespace = {
        namespaceId: "ns-1",
        scriptName: "avalon-api-global",
        className: "AgentLoopDO",
        usesSqlite: true,
      };
      registry.recordSweep(sweep({
        namespaces: [{ ...namespace, objects: [{ objectId: objectId("a"), hasStoredData: true }] }],
      }));
      registry.recordSweep(sweep({
        status: "partial",
        namespaces: [{ ...namespace, objects: [] }],
        truncatedNamespaces: ["ns-1"],
      }));
      return registry.objectDetail(objectId("a"));
    });

    expect(detail?.object.status).toBe("unreported");
    expect(detail?.object.absentSince).toBeNull();
  });

  it("brings an absent object back when it reports again", async () => {
    const detail = await withRegistry((registry) => {
      const namespace = {
        namespaceId: "ns-1",
        scriptName: "avalon-api-global",
        className: "AgentLoopDO",
        usesSqlite: true,
      };
      registry.recordSweep(sweep({
        namespaces: [{ ...namespace, objects: [{ objectId: objectId("a"), hasStoredData: true }] }],
      }));
      registry.recordSweep(sweep({ namespaces: [{ ...namespace, objects: [] }] }));
      record(registry, report());
      return registry.objectDetail(objectId("a"));
    });

    expect(detail?.object.status).toBe("current");
    expect(detail?.object.absentSince).toBeNull();
  });

  it("classifies a class that never reports as not_reporting, not unreported", async () => {
    const page = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [
          {
            // The tracker's own object, and the API's container class. Neither
            // runs the reporter, so silence from them means nothing.
            namespaceId: "ns-tracker",
            scriptName: "avalon-migration-tracker",
            className: "MigrationRegistry",
            usesSqlite: true,
            objects: [
              { objectId: objectId("e"), hasStoredData: true },
              { objectId: objectId("h"), hasStoredData: false },
            ],
          },
          {
            namespaceId: "ns-container",
            scriptName: "avalon-api-global",
            className: "CrashSymbolicatorContainer",
            usesSqlite: false,
            objects: [{ objectId: objectId("f"), hasStoredData: true }],
          },
          {
            namespaceId: "ns-agents",
            scriptName: "avalon-api-global",
            className: "AgentLoopDO",
            usesSqlite: true,
            objects: [{ objectId: objectId("c"), hasStoredData: true }],
          },
        ],
      }));
      return registry.listObjects(ObjectQuerySchema.parse({}));
    });

    const byId = new Map(page.objects.map((object) => [object.objectId, object.status]));
    expect(byId.get(objectId("e"))).toBe("not_reporting");
    // Physical storage state is more specific than reporter participation: an
    // infrastructure identity without storage is historical, not actionable.
    expect(byId.get(objectId("h"))).toBe("empty");
    expect(byId.get(objectId("f"))).toBe("not_reporting");
    // Only the class that actually reports counts as one nobody has heard from.
    expect(byId.get(objectId("c"))).toBe("unreported");
  });

  it("keeps a failure visible even on a class that is otherwise not reporting", async () => {
    const detail = await withRegistry((registry) => {
      record(registry, report({
        className: "AgentLoopDO",
        status: "failed",
        appliedVersions: [],
        failure: { message: "substream_agent_do_schema_hash_mismatch:4", version: 4 },
      }));
      return registry.objectDetail(objectId("a"));
    });

    expect(detail?.object.status).toBe("failed");
  });

  it("records the sweep receipt, including which namespaces were truncated", async () => {
    const overview = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        status: "partial",
        namespaces: [{
          namespaceId: "ns-1",
          scriptName: "avalon-api-enterprise",
          className: "WorkspaceDO",
          usesSqlite: true,
          objects: [
            { objectId: objectId("e"), hasStoredData: true },
            { objectId: objectId("f"), hasStoredData: false },
          ],
        }],
        truncatedNamespaces: ["ns-1"],
        errorMessage: "ns-2: cloudflare_api_status_429",
      }));
      return registry.overview();
    });

    expect(overview.latestSweep?.status).toBe("partial");
    expect(overview.latestSweep?.truncatedNamespaces).toEqual(["ns-1"]);
    expect(overview.latestSweep?.errorMessage).toBe("ns-2: cloudflare_api_status_429");
    expect(overview.namespaces[0]?.scriptName).toBe("avalon-api-enterprise");
    expect(overview.namespaces[0]?.objectCount).toBe(2);
    expect(overview.namespaces[0]?.storedObjectCount).toBe(1);
  });

  /**
   * `objects: null` means the per-namespace listing failed, which says nothing
   * about the namespace's size. Recording it as a count of zero, with a fresh
   * sweep time beside it, reads on the site as "this namespace is empty" rather
   * than "this namespace was not enumerated".
   */
  it("keeps the last known object count when a namespace listing failed", async () => {
    const { enumerated, afterFailure } = await withRegistry((registry) => {
      const namespace = {
        namespaceId: "ns-1",
        scriptName: "avalon-api-enterprise",
        className: "AgentLoopDO",
        usesSqlite: true,
      };
      registry.recordSweep(sweep({
        namespaces: [{
          ...namespace,
          objects: [
            { objectId: objectId("f"), hasStoredData: true },
            { objectId: objectId("g"), hasStoredData: true },
          ],
        }],
      }));
      const first = registry.overview().namespaces[0];
      registry.recordSweep(sweep({
        startedAt: 1_700_000_100_000,
        finishedAt: 1_700_000_101_000,
        status: "partial",
        namespaces: [{ ...namespace, objects: null }],
        errorMessage: "ns-1: cloudflare_api_status_500",
      }));
      return { enumerated: first, afterFailure: registry.overview().namespaces[0] };
    });

    expect(enumerated?.objectCount).toBe(2);
    expect(enumerated?.storedObjectCount).toBe(2);
    // Both columns still describe the last sweep that actually listed the
    // namespace, rather than claiming it was just seen to be empty.
    expect(afterFailure?.objectCount).toBe(2);
    expect(afterFailure?.storedObjectCount).toBe(2);
    expect(afterFailure?.lastSweptAt).toBe(enumerated?.lastSweptAt);
  });
});

/**
 * Losing a whole namespace, rather than losing an object inside one.
 *
 * These two are not the same code path and were not the same bug. Absence
 * inside a namespace is decided by iterating the namespaces a sweep returned;
 * a namespace that has left the account is never in that iteration, so before
 * `retireMissingNamespaces` its objects were unreachable — they kept whatever
 * status they held on the day the class was deleted, forever, and a class that
 * happened to be `behind` when it went stayed red with nothing an operator
 * could do about it.
 */
/**
 * The upgrade path, which is the riskiest thing in this change.
 *
 * The live registry has v1 applied, so `retired_at` reaches it as an
 * `ALTER TABLE` run inside the constructor's `blockConcurrencyWhile`. If that
 * statement were rejected, the registry would throw on construction and the
 * tracker would be down — for every read, not just the new column. Every other
 * test here starts from a database where both migrations have already been
 * applied together, so none of them exercises the step production will take.
 */
describe("the registry schema", () => {
  it("brings a deployed v1 database up to the current head", async () => {
    const applied = await withRegistry((_registry, state) => {
      const storage = state.storage;
      // Rewind to v1: drop what the constructor built and replay the first
      // migration only, which is exactly the shape of the deployed registry.
      for (const table of [
        "durable_objects",
        "migration_events",
        "component_versions",
        "inventory_sweeps",
        "durable_object_namespaces",
      ]) {
        storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      storage.sql.exec(`DELETE FROM _sql_schema_migrations`);
      applyRegistrySchema(storage, REGISTRY_MIGRATIONS.slice(0, 1));

      expect(() => storage.sql.exec(`SELECT retired_at FROM durable_object_namespaces`))
        .toThrow();

      // Only through v2: this test owns the v1 -> v2 step, and applying the
      // whole list would make every later migration change its expectation.
      const applied = applyRegistrySchema(storage, REGISTRY_MIGRATIONS.slice(0, 2));

      // Then back to head, because the registry object is a singleton: leaving
      // it two versions short would strand every later test in this file on a
      // database missing the tables and receipts it expects.
      applyRegistrySchema(storage);
      return applied;
    });

    expect(applied).toEqual([2]);

    // And the upgraded database is usable, not merely altered.
    const namespaces = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-1",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [],
        }],
      }));
      return registry.overview().namespaces;
    });
    expect(namespaces[0]?.retiredAt).toBeNull();
  });

  /**
   * v4 adds `migration_runs`. It reaches the deployed registry as a
   * `CREATE TABLE` inside the constructor's `blockConcurrencyWhile`, so a
   * statement it rejected would take the tracker down for every read rather
   * than only for the new page. Replayed on its own, per the step above.
   */
  it("adds the forced-migration run log to a database that predates it", async () => {
    const applied = await withRegistry((_registry, state) => {
      state.storage.sql.exec(`DROP TABLE IF EXISTS migration_runs`);
      state.storage.sql.exec(`DELETE FROM _sql_schema_migrations WHERE version = 4`);
      expect(() => state.storage.sql.exec(`SELECT run_id FROM migration_runs`)).toThrow();
      return applyRegistrySchema(state.storage);
    });
    expect(applied).toEqual([4]);

    const runs = await withRegistry((registry) => {
      registry.recordMigrationRun(migrationRun({}));
      return registry.listMigrationRuns();
    });
    expect(runs).toHaveLength(1);
  });

  it("adds a separate stamp for the last successful namespace object listing", async () => {
    const applied = await withRegistry((_registry, state) => {
      state.storage.sql.exec(
        `ALTER TABLE durable_object_namespaces DROP COLUMN last_listed_sweep_id`,
      );
      state.storage.sql.exec(`DELETE FROM _sql_schema_migrations WHERE version = 5`);
      expect(() => state.storage.sql.exec(
        `SELECT last_listed_sweep_id FROM durable_object_namespaces`,
      )).toThrow();
      return applyRegistrySchema(state.storage);
    });

    expect(applied).toEqual([5]);
  });

  /**
   * v3 renames `AgentLoopDO`'s component key. The rename is only safe
   * because the tracker is the sole holder of that key, which also means the
   * tracker is the only thing that can carry the existing history across: an
   * unmigrated registry would show the fleet split between `workstream` at v15
   * and a new key at head 0. These two tests are the halves of that — the
   * carry, and the collision the carry has to survive when the API deploys
   * first and has already created the row this migration wants to write.
   */
  it("carries the stored history onto the renamed component", async () => {
    const applied = await withRegistry((registry, state) => {
      record(registry, report({ schemaVersion: 15, latestVersion: 15 }));
      rewindToLegacyComponent(state);
      // Rewind to v2: the receipt is what makes the runner skip a migration, so
      // dropping it replays v3 against a database holding the old key.
      state.storage.sql.exec(`DELETE FROM _sql_schema_migrations WHERE version = 3`);
      return applyRegistrySchema(state.storage);
    });
    expect(applied).toEqual([3]);

    const rows = await withRegistry((_registry, state) => ({
      components: state.storage.sql.exec<{ component: string; latest_version: number }>(
        `SELECT component, latest_version FROM component_versions`,
      ).toArray(),
      objects: state.storage.sql.exec<{ component: string }>(
        `SELECT component FROM durable_objects`,
      ).toArray(),
      events: state.storage.sql.exec<{ component: string }>(
        `SELECT component FROM migration_events`,
      ).toArray(),
    }));
    expect(rows.components).toEqual([{ component: "substream_agent_do", latest_version: 15 }]);
    expect(rows.objects).toEqual([{ component: "substream_agent_do" }]);
    expect(rows.events).toEqual([{ component: "substream_agent_do" }]);

    // Renamed and still resolvable: the head carried across, so the object that
    // reported v15 is current rather than behind a head that restarted at 0.
    const overview = await withRegistry((registry) => registry.overview());
    expect(overview.totals.current).toBe(1);
    expect(overview.totals.behind).toBe(0);
    expect(overview.components.map((component) => component.component))
      .toEqual(["substream_agent_do"]);
  });

  /**
   * The migration alone is not enough: it runs once, and the tracker's deploy
   * workflow is the smaller of the two, so it usually lands before the API
   * build that stops sending the old key. A report that arrives in that window
   * would otherwise put the legacy key back into all three tables, where only
   * `durable_objects` heals itself on the object's next wake.
   */
  it("files a report that still carries the legacy key under the new one", async () => {
    const rows = await withRegistry((registry, state) => {
      record(registry, report({ component: "workstream", schemaVersion: 15, latestVersion: 15 }));
      return {
        components: state.storage.sql.exec<{ component: string }>(
          `SELECT DISTINCT component FROM component_versions`,
        ).toArray(),
        objects: state.storage.sql.exec<{ component: string }>(
          `SELECT DISTINCT component FROM durable_objects`,
        ).toArray(),
        events: state.storage.sql.exec<{ component: string }>(
          `SELECT DISTINCT component FROM migration_events`,
        ).toArray(),
      };
    });

    expect(rows.components).toEqual([{ component: "substream_agent_do" }]);
    expect(rows.objects).toEqual([{ component: "substream_agent_do" }]);
    expect(rows.events).toEqual([{ component: "substream_agent_do" }]);
  });

  it("files the conversation class's stored rows under its new name, AgentLoopDO", async () => {
    const applied = await withRegistry((registry, state) => {
      record(registry, report({ schemaVersion: 82, latestVersion: 82 }));
      // The shape v6 meets: every row filed under the class's old name.
      for (const table of ["durable_objects", "migration_events", "component_versions"]) {
        state.storage.sql.exec(`UPDATE ${table} SET class_name = 'SubstreamAgent'`);
      }
      state.storage.sql.exec(
        `INSERT INTO durable_object_namespaces
           (namespace_id, script_name, class_name, uses_sqlite, object_count, first_seen_at, last_swept_at)
         VALUES ('namespace-before-rename', 'avalon-api', 'SubstreamAgent', 1, 1, 1000, 1000)`,
      );
      state.storage.sql.exec(
        `INSERT INTO migration_runs
           (run_id, class_name, region, requested_by, requested_at, matched_count, dispatched_count,
            unroutable_count, truncated, status)
         VALUES ('run-before-rename', 'SubstreamAgent', NULL, 'operator@example.com', 1000, 1, 1, 0, 0, 'dispatched')`,
      );
      state.storage.sql.exec(`DELETE FROM _sql_schema_migrations WHERE version = 6`);
      return applyRegistrySchema(state.storage);
    });
    expect(applied).toEqual([6]);
    const tables = ["durable_objects", "migration_events", "component_versions", "durable_object_namespaces", "migration_runs"];
    const classes = await withRegistry((_registry, state) => tables
      .map((table) => state.storage.sql.exec<{ class_name: string }>(`SELECT DISTINCT class_name FROM ${table}`).toArray()));
    expect(classes).toEqual(tables.map(() => [{ class_name: "AgentLoopDO" }]));
  });

  it("files a report the outgoing build sends under the old class name under the new one", async () => {
    const classes = await withRegistry((registry, state) => {
      record(registry, report({ className: "SubstreamAgent", schemaVersion: 83, latestVersion: 83 }));
      return ["durable_objects", "migration_events", "component_versions"]
        .map((table) => state.storage.sql.exec<{ class_name: string }>(`SELECT DISTINCT class_name FROM ${table}`).toArray());
    });
    expect(classes).toEqual([[{ class_name: "AgentLoopDO" }], [{ class_name: "AgentLoopDO" }], [{ class_name: "AgentLoopDO" }]]);
  });

  it("merges into a head the renamed component already has", async () => {
    const applied = await withRegistry((registry, state) => {
      // The API deployed first, so its reports have already created the row
      // this migration wants to write. The heads differ in both directions,
      // one per region, because the merge has to keep the higher one whichever
      // side of the collision it is on — taking either side unconditionally
      // reads as a passing test against the other region.
      record(
        registry,
        report({ schemaVersion: 15, latestVersion: 15, workerVersionId: "0.23.0" }),
        report({
          objectId: objectId("c"),
          objectName: `enterprise:${WORKSPACE_ID}:${WORKSTREAM_ID}`,
          region: "enterprise",
          schemaVersion: 12,
          latestVersion: 12,
          workerVersionId: "0.23.0",
        }),
      );
      rewindToLegacyComponent(state);
      // Only now the API's side of the collision, which lands under the new key
      // and carries the newer build.
      record(
        registry,
        report({ objectId: objectId("b"), schemaVersion: 12, latestVersion: 12 }),
        report({
          objectId: objectId("d"),
          objectName: `enterprise:${WORKSPACE_ID}:${WORKSTREAM_ID}`,
          region: "enterprise",
          schemaVersion: 15,
          latestVersion: 15,
        }),
      );
      state.storage.sql.exec(
        `UPDATE component_versions SET observed_at = ? WHERE component = 'substream_agent_do'`,
        RENAMED_OBSERVED_AT,
      );
      state.storage.sql.exec(`DELETE FROM _sql_schema_migrations WHERE version = 3`);
      return applyRegistrySchema(state.storage);
    });
    expect(applied).toEqual([3]);

    // The build and the timestamp are asserted beside the version because the
    // merge chooses all three, and the two that the surviving row inherits from
    // the *losing* side are the ones a naive `excluded.<column>` would get
    // wrong without changing any version — a head attributed to a build that
    // never ran it, which is the same wrong-number-no-error failure the merge
    // exists to avoid.
    const components = await withRegistry((_registry, state) =>
      state.storage.sql.exec<{
        component: string;
        region: string;
        latest_version: number;
        worker_version_id: string;
        observed_at: number;
      }>(
        `SELECT component, region, latest_version, worker_version_id, observed_at
           FROM component_versions ORDER BY component, region`,
      ).toArray());
    expect(components).toEqual([
      {
        component: "substream_agent_do",
        region: "enterprise",
        latest_version: 15,
        // The new key was already ahead here, so its build keeps the head.
        worker_version_id: "0.24.0",
        observed_at: RENAMED_OBSERVED_AT,
      },
      {
        component: "substream_agent_do",
        region: "global",
        latest_version: 15,
        // The legacy side was ahead here, so the build that ran v15 keeps it.
        worker_version_id: "0.23.0",
        observed_at: RENAMED_OBSERVED_AT,
      },
    ]);
  });
});

describe("retiring a namespace that has left the account", () => {
  const LIVE = {
    namespaceId: "ns-1",
    scriptName: "avalon-api-global",
    className: "AgentLoopDO",
    usesSqlite: true,
  };
  const DOOMED = {
    namespaceId: "ns-2",
    scriptName: "avalon-api-global",
    className: "RetiredAgent",
    usesSqlite: true,
  };

  /** Both namespaces populated, which is the state every case below starts from. */
  function seed(registry: MigrationRegistry): void {
    registry.recordSweep(sweep({
      namespaces: [
        { ...LIVE, objects: [{ objectId: objectId("a"), hasStoredData: true }] },
        { ...DOOMED, objects: [{ objectId: objectId("b"), hasStoredData: true }] },
      ],
    }));
  }

  /** A later sweep that found only the surviving namespace. */
  function withoutTheDoomedOne(overrides: Partial<InventorySweep> = {}): InventorySweep {
    return sweep({
      namespaces: [{ ...LIVE, objects: [{ objectId: objectId("a"), hasStoredData: true }] }],
      ...overrides,
    });
  }

  it("marks the objects of a vanished namespace absent", async () => {
    const { gone, survivor } = await withRegistry((registry) => {
      seed(registry);
      registry.recordSweep(withoutTheDoomedOne());
      return {
        gone: registry.objectDetail(objectId("b")),
        survivor: registry.objectDetail(objectId("a")),
      };
    });

    expect(gone?.object.status).toBe("absent");
    expect(gone?.object.absentSince).not.toBeNull();
    // The namespace that is still there must be untouched by the same pass.
    expect(survivor?.object.status).toBe("unreported");
    expect(survivor?.object.absentSince).toBeNull();
  });

  it("records when the namespace itself stopped being there", async () => {
    const namespaces = await withRegistry((registry) => {
      seed(registry);
      registry.recordSweep(withoutTheDoomedOne());
      return registry.overview().namespaces;
    });

    expect(namespaces.find((entry) => entry.namespaceId === "ns-1")?.retiredAt).toBeNull();
    expect(namespaces.find((entry) => entry.namespaceId === "ns-2")?.retiredAt)
      .toEqual(expect.any(Number));
    // Retired namespaces sort last, so the live fleet stays at the top of the
    // table however many classes have been removed over the account's life.
    expect(namespaces.at(-1)?.namespaceId).toBe("ns-2");
  });

  /**
   * The guard that matters most. A `partial` sweep is one where a namespace
   * listing failed or was truncated — it is not evidence about the namespaces
   * it did not return, and treating it as evidence would retire live classes
   * during a Cloudflare API wobble.
   */
  it("retires nothing on a sweep that did not complete", async () => {
    const { detail, namespaces } = await withRegistry((registry) => {
      seed(registry);
      registry.recordSweep(withoutTheDoomedOne({ status: "partial", errorMessage: "ns-2: boom" }));
      return { detail: registry.objectDetail(objectId("b")), namespaces: registry.overview().namespaces };
    });

    expect(detail?.object.status).toBe("not_reporting");
    expect(detail?.object.absentSince).toBeNull();
    expect(namespaces.find((entry) => entry.namespaceId === "ns-2")?.retiredAt).toBeNull();
  });

  /**
   * The other guard, and the one whose blast radius is the whole fleet: a
   * successful call that returns an empty list would otherwise read as "the
   * account has no Durable Objects" and retire every class at once.
   */
  it("retires nothing when a completed sweep found no namespaces at all", async () => {
    const { detail, namespaces } = await withRegistry((registry) => {
      seed(registry);
      registry.recordSweep(sweep({ namespaces: [] }));
      return { detail: registry.objectDetail(objectId("b")), namespaces: registry.overview().namespaces };
    });

    expect(detail?.object.absentSince).toBeNull();
    expect(namespaces.every((entry) => entry.retiredAt === null)).toBe(true);
  });

  it("brings a namespace and its objects back if the class is deployed again", async () => {
    const { detail, namespaces } = await withRegistry((registry) => {
      seed(registry);
      registry.recordSweep(withoutTheDoomedOne());
      seed(registry);
      return { detail: registry.objectDetail(objectId("b")), namespaces: registry.overview().namespaces };
    });

    expect(detail?.object.status).toBe("not_reporting");
    expect(detail?.object.absentSince).toBeNull();
    expect(namespaces.find((entry) => entry.namespaceId === "ns-2")?.retiredAt).toBeNull();
  });

  /**
   * The fleet size the platform actually imposes a limit at.
   *
   * Durable Object SQL allows **100 bound parameters per query**, and an
   * account may hold up to 500 Durable Object classes. Expressing the set
   * difference as `NOT IN (?, ?, …)` over the swept ids is correct code that
   * throws once the account crosses that line — and it throws inside the
   * sweep's `transactionSync`, so the whole sweep is rolled back, not just the
   * retirement. This asserts the receipt survived, which is what distinguishes
   * "the pass ran" from "the sweep was lost".
   */
  it("retires a namespace in a fleet past the SQL parameter limit", async () => {
    const NAMESPACES = 150;
    const paddedId = (index: number): string => String(index).padStart(64, "0");
    const wholeFleet = (count: number) => Array.from({ length: count }, (_unused, index) => ({
      namespaceId: `ns-${index}`,
      scriptName: "avalon-api-global",
      className: `Class${index}`,
      usesSqlite: true,
      objects: [{ objectId: paddedId(index), hasStoredData: true }],
    }));

    const { gone, survivor, receipt } = await withRegistry((registry) => {
      registry.recordSweep(sweep({ namespaces: wholeFleet(NAMESPACES) }));
      // Everything but the first namespace comes back on the next sweep.
      registry.recordSweep(sweep({ namespaces: wholeFleet(NAMESPACES).slice(1) }));
      const overview = registry.overview();
      return {
        gone: registry.objectDetail(paddedId(0)),
        survivor: registry.objectDetail(paddedId(NAMESPACES - 1)),
        receipt: overview.latestSweep,
      };
    });

    expect(gone?.object.status).toBe("absent");
    expect(survivor?.object.absentSince).toBeNull();
    // The second sweep's receipt is present, so its transaction committed.
    expect(receipt?.namespaceCount).toBe(NAMESPACES - 1);
  });

  /**
   * The detail page is where an operator lands after clicking an absent object,
   * and `absent` on its own does not say whether one instance was deleted or
   * the whole class was. The overview tables distinguish those; this is what
   * lets the detail page do the same.
   */
  it("tells an absent object's page that its class is the thing that went", async () => {
    const { retired, ordinary } = await withRegistry((registry) => {
      seed(registry);
      registry.recordSweep(withoutTheDoomedOne());
      return {
        retired: registry.objectDetail(objectId("b")),
        ordinary: registry.objectDetail(objectId("a")),
      };
    });

    expect(retired?.object.namespaceRetiredAt).toEqual(expect.any(Number));
    // An object whose namespace is still there says nothing of the kind.
    expect(ordinary?.object.namespaceRetiredAt).toBeNull();
  });

  it("marks the component retired once its class has no namespace left", async () => {
    const components = await withRegistry((registry) => {
      record(registry, report({ objectId: objectId("b"), className: "RetiredAgent", component: "retired" }));
      seed(registry);
      registry.recordSweep(withoutTheDoomedOne());
      return registry.overview().components;
    });

    const retired = components.find((entry) => entry.component === "retired");
    expect(retired?.retired).toBe(true);
    // Its objects are counted as absent rather than disappearing from the row:
    // "0 live, 1 absent" is the answer to "where did this component go".
    expect(retired?.total).toBe(0);
    expect(retired?.absent).toBe(1);
    expect(retired?.current).toBe(0);
  });

  /**
   * Retirement is per region, not per class.
   *
   * The same Durable Object classes are deployed in `avalon-api-global` and
   * `avalon-api-enterprise`, so a class has one namespace per region and the tracker
   * holds a `component_versions` row per region. Deriving retirement from the
   * class alone — asking whether *any* namespace for `AgentLoopDO` is still
   * live — leaves the global component reading live after the global namespace
   * is deleted, purely because the enterprise one still exists, which is the case the
   * marker exists to show.
   */
  it("retires only the region whose namespace is gone", async () => {
    const enterprise = {
      namespaceId: "ns-enterprise",
      scriptName: "avalon-api-enterprise",
      className: "AgentLoopDO",
      usesSqlite: true,
    };

    const components = await withRegistry((registry) => {
      record(
        registry,
        report({ objectId: objectId("a"), region: "global" }),
        report({ objectId: objectId("e"), region: "enterprise" }),
      );
      registry.recordSweep(sweep({
        namespaces: [
          { ...LIVE, objects: [{ objectId: objectId("a"), hasStoredData: true }] },
          { ...enterprise, objects: [{ objectId: objectId("e"), hasStoredData: true }] },
        ],
      }));
      // Only the global namespace goes; the enterprise one keeps running the class.
      registry.recordSweep(sweep({
        namespaces: [{ ...enterprise, objects: [{ objectId: objectId("e"), hasStoredData: true }] }],
      }));
      return registry.overview().components;
    });

    const global = components.find((entry) => entry.region === "global");
    const isolatedComponent = components.find((entry) => entry.region === "enterprise");
    expect(global?.retired).toBe(true);
    expect(global?.absent).toBe(1);
    expect(isolatedComponent?.retired).toBe(false);
    expect(isolatedComponent?.absent).toBe(0);
  });

  /**
   * The discriminator for the test above. A class whose instances are all gone
   * looks identical in the object counts to a class that has been deleted, and
   * only the namespace evidence tells them apart — so a component with zero
   * live objects and a namespace still in the account is *not* retired.
   */
  it("does not call a component retired merely because its objects are gone", async () => {
    const components = await withRegistry((registry) => {
      record(registry, report({ objectId: objectId("b"), className: "RetiredAgent", component: "retired" }));
      seed(registry);
      registry.recordSweep(sweep({
        namespaces: [
          { ...LIVE, objects: [{ objectId: objectId("a"), hasStoredData: true }] },
          { ...DOOMED, objects: [] },
        ],
      }));
      return registry.overview().components;
    });

    const stillDeployed = components.find((entry) => entry.component === "retired");
    expect(stillDeployed?.retired).toBe(false);
    expect(stillDeployed?.total).toBe(0);
    expect(stillDeployed?.absent).toBe(1);
  });
});

describe("staleness", () => {
  it("measures the last enumeration, not the last receipt, so a failing sweep still warns", async () => {
    const overview = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        finishedAt: 1_700_000_001_000,
        namespaces: [{
          namespaceId: "ns-1",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("c"), hasStoredData: true }],
        }],
      }));
      // Cloudflare's API then goes down: every hour writes a fresh receipt that
      // enumerated nothing at all.
      registry.recordSweep(sweep({
        status: "failed",
        finishedAt: 1_700_000_999_000,
        namespaces: [],
        errorMessage: "cloudflare_api_error_10000",
      }));
      return registry.overview();
    });

    expect(overview.latestSweep?.status).toBe("failed");
    expect(overview.latestSweep?.finishedAt).toBe(1_700_000_999_000);
    // The banner reads this one, so the fresh failed receipt cannot hide it.
    expect(overview.latestEnumeration?.status).toBe("complete");
    expect(overview.latestEnumeration?.finishedAt).toBe(1_700_000_001_000);
  });

  it("reports no enumeration at all when every sweep has failed", async () => {
    const overview = await withRegistry((registry) => {
      registry.recordSweep(sweep({ status: "failed", namespaces: [], errorMessage: "boom" }));
      return registry.overview();
    });

    expect(overview.latestSweep?.status).toBe("failed");
    expect(overview.latestEnumeration).toBeNull();
  });

  it("counts a partial sweep as an enumeration, because it did enumerate", async () => {
    const overview = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        status: "partial",
        namespaces: [{
          namespaceId: "ns-1",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("c"), hasStoredData: true }],
        }],
        truncatedNamespaces: ["ns-1"],
      }));
      return registry.overview();
    });

    expect(overview.latestEnumeration?.status).toBe("partial");
  });
});

describe("listObjects", () => {
  it("filters by status, component, region, and identifier prefix", async () => {
    const results = await withRegistry((registry) => {
      record(registry, report({ objectId: objectId("a"), schemaVersion: 4, latestVersion: 4 }));
      record(registry, report({
        objectId: objectId("b"),
        objectName: null,
        schemaVersion: 3,
        latestVersion: 3,
      }));
      record(registry, report({
        objectId: objectId("c"),
        objectName: null,
        component: "workspace_do",
        className: "WorkspaceDO",
        region: "enterprise",
      }));
      return {
        behind: registry.listObjects(ObjectQuerySchema.parse({ status: "behind" })),
        component: registry.listObjects(ObjectQuerySchema.parse({ component: "workspace_do" })),
        region: registry.listObjects(ObjectQuerySchema.parse({ region: "enterprise" })),
        search: registry.listObjects(ObjectQuerySchema.parse({ search: objectId("a").slice(0, 8) })),
      };
    });

    expect(results.behind.objects.map((object) => object.objectId)).toEqual([objectId("b")]);
    expect(results.component.total).toBe(1);
    expect(results.region.objects[0]?.region).toBe("enterprise");
    expect(results.search.objects.map((object) => object.objectId)).toEqual([objectId("a")]);
  });

  it("treats a wildcard in the search box as a literal", async () => {
    const page = await withRegistry((registry) => {
      record(registry, report());
      return registry.listObjects(ObjectQuerySchema.parse({ search: "%" }));
    });

    expect(page.total).toBe(0);
  });

  it("orders failures first and pages through the rest", async () => {
    const page = await withRegistry((registry) => {
      for (const seed of ["1", "2", "3", "4"]) {
        record(registry, report({ objectId: objectId(seed), objectName: null }));
      }
      record(registry, report({
        objectId: objectId("9"),
        objectName: null,
        status: "failed",
        failure: { message: "substream_agent_do_schema_ahead:9", version: 9 },
      }));
      return registry.listObjects(ObjectQuerySchema.parse({ limit: 2 }));
    });

    expect(page.total).toBe(5);
    expect(page.objects).toHaveLength(2);
    expect(page.objects[0]?.status).toBe("failed");
  });
});

/**
 * The queries behind the **Force a migration** page.
 *
 * The one thing worth being careful about here is where a target's region comes
 * from. A command picks a queue by region, and the object an operator most wants
 * to force — one an inventory sweep found and that has never woken — has no
 * reported region at all. The script name its namespace carries is what resolves
 * it, and an object with neither is unroutable rather than guessed at.
 */
describe("forced migration targets", () => {
  it("offers only the classes that run the reporter, in a region it can name", async () => {
    const components = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-global",
          scriptName: "avalon-api-global",
          className: "AgentLoopDO",
          usesSqlite: true,
          objects: [
            { objectId: objectId("a"), hasStoredData: true },
            { objectId: objectId("b"), hasStoredData: true },
          ],
        }, {
          // A class in the same Worker that runs no schema at all. It has to be
          // excluded by the class filter rather than by anything else, which is
          // why it is seeded in a script whose region *is* resolvable.
          namespaceId: "ns-container",
          scriptName: "avalon-api-global",
          className: "CrashSymbolicatorContainer",
          usesSqlite: false,
          objects: [{ objectId: objectId("c"), hasStoredData: true }],
        }, {
          // A migrating class in a Worker this tracker cannot route to. There
          // is no queue to send it on, so offering it would be offering a run
          // that reaches nothing.
          namespaceId: "ns-elsewhere",
          scriptName: "some-other-worker",
          className: "WorkspaceDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("d"), hasStoredData: true }],
        }],
      }));
      record(registry, report({ objectId: objectId("a"), schemaVersion: 2, latestVersion: 3 }));
      return registry.forceableComponents();
    });

    expect(components).toEqual([{
      className: "AgentLoopDO",
      region: "global",
      objects: 2,
      behind: 1,
      unreported: 1,
      failed: 0,
    }]);
  });

  it("routes an object that has never reported by its script name", async () => {
    const selection = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-enterprise",
          scriptName: "avalon-api-enterprise",
          className: "WorkspaceDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("d"), hasStoredData: true }],
        }],
      }));
      return registry.migrationTargets({ className: "WorkspaceDO" });
    });

    expect(selection.targets).toEqual([{
      objectId: objectId("d"),
      objectName: null,
      region: "enterprise",
    }]);
    expect(selection.unroutable).toBe(0);
  });

  it("counts an object whose region cannot be resolved as unroutable", async () => {
    const selection = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-unknown",
          scriptName: "some-other-worker",
          className: "WorkspaceDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("e"), hasStoredData: true }],
        }],
      }));
      return registry.migrationTargets({ className: "WorkspaceDO" });
    });

    expect(selection.targets).toEqual([]);
    expect(selection.matched).toBe(1);
    expect(selection.unroutable).toBe(1);
  });

  it("narrows to one region when the run asks for one", async () => {
    const selection = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-global",
          scriptName: "avalon-api-global",
          className: "WorkspaceDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("a"), hasStoredData: true }],
        }, {
          namespaceId: "ns-enterprise",
          scriptName: "avalon-api-enterprise",
          className: "WorkspaceDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("b"), hasStoredData: true }],
        }],
      }));
      return registry.migrationTargets({ className: "WorkspaceDO", region: "enterprise" });
    });

    expect(selection.targets.map((target) => target.objectId)).toEqual([objectId("b")]);
    expect(selection.matched).toBe(1);
  });

  /**
   * An absent object's ID no longer has an object behind it, so addressing it
   * would create an empty one — the opposite of migrating anything.
   */
  it("does not target an object a sweep has marked absent", async () => {
    const selection = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-global",
          scriptName: "avalon-api-global",
          className: "WorkspaceDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("a"), hasStoredData: true }],
        }],
      }));
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-global",
          scriptName: "avalon-api-global",
          className: "WorkspaceDO",
          usesSqlite: true,
          objects: [],
        }],
      }));
      return registry.migrationTargets({ className: "WorkspaceDO" });
    });

    expect(selection.matched).toBe(0);
    expect(selection.targets).toEqual([]);
  });

  /**
   * Cloudflare keeps enumerating an ID after its storage is cleared. Waking it
   * would create the data the cleanup deliberately removed.
   */
  it("does not target an identity the latest sweep found empty", async () => {
    const result = await withRegistry((registry) => {
      registry.recordSweep(sweep({
        namespaces: [{
          namespaceId: "ns-global",
          scriptName: "avalon-api-global",
          className: "WorkspaceDO",
          usesSqlite: true,
          objects: [{ objectId: objectId("a"), hasStoredData: false }],
        }],
      }));
      return {
        components: registry.forceableComponents(),
        selection: registry.migrationTargets({ className: "WorkspaceDO" }),
      };
    });

    expect(result.components).toEqual([]);
    expect(result.selection.matched).toBe(0);
    expect(result.selection.targets).toEqual([]);
  });
});

describe("migration runs", () => {
  it("lists the newest run first and keeps what it could not reach", async () => {
    const runs = await withRegistry((registry) => {
      registry.recordMigrationRun(migrationRun({ className: "WorkspaceDO" }));
      registry.recordMigrationRun(migrationRun({
        className: "AgentLoopDO",
        region: "enterprise",
        matched: 40,
        dispatched: 25,
        unroutable: 15,
        truncated: true,
        status: "failed",
        errorMessage: "queue refused the batch",
      }));
      return registry.listMigrationRuns();
    });

    expect(runs.map((run) => run.className)).toEqual(["AgentLoopDO", "WorkspaceDO"]);
    expect(runs[0]).toMatchObject({
      region: "enterprise",
      matched: 40,
      dispatched: 25,
      unroutable: 15,
      truncated: true,
      status: "failed",
      errorMessage: "queue refused the batch",
    });
  });

  it("ignores a run id it has already recorded", async () => {
    const runs = await withRegistry((registry) => {
      const run = migrationRun({ dispatched: 3 });
      registry.recordMigrationRun(run);
      registry.recordMigrationRun({ ...run, dispatched: 99 });
      return registry.listMigrationRuns();
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.dispatched).toBe(3);
  });
});

/**
 * The class an operator names arrives in a request body, and the page's own
 * list of classes is a rendering of what is forceable rather than a constraint
 * on it — a JSON caller or a hand-edited form reaches this schema directly.
 *
 * A class the API Worker holds no dispatcher for would otherwise be fanned out
 * in full, retried five times per object, and dead-lettered, while the run row
 * recorded it as dispatched. `CrashSymbolicatorContainer` is the one that makes
 * it concrete: the sweep enumerates it, it lives in an API script so its region
 * resolves like any other, and nothing downstream would have stopped it.
 */
describe("which classes a run may name", () => {
  it("accepts every class that runs the reporter", () => {
    for (const className of REPORTING_CLASSES) {
      expect(MigrationRunRequestSchema.safeParse({ className }).success).toBe(true);
    }
  });

  it("refuses a class no Worker can migrate", () => {
    for (const className of ["CrashSymbolicatorContainer", "MigrationRegistry", "WorkspaceScheduler"]) {
      expect(MigrationRunRequestSchema.safeParse({ className }).success).toBe(false);
    }
  });
});
