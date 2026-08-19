/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DurableObjectMigrationReport } from "@avalon/contracts/durable-object-migrations";
import type { Env } from "../src/env";
import {
  latestMigrationVersion,
  withMigrationReport,
} from "../src/durable-objects/migration-reporting";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "../src/durable-objects/sqlite-migrations";
import { workspaceDOName } from "../src/durable-objects/names";
import { WORKSPACE_SCHEDULER_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-scheduler";

const WORKSPACE_PREFIX = "00000000-0000-7000-8000-0000005000";

interface Tracker {
  reports: DurableObjectMigrationReport[];
  binding: NonNullable<Env["MIGRATION_TRACKER"]>;
}

/** A tracker double that records what it was told, and optionally refuses it. */
function tracker(options: { reject?: boolean } = {}): Tracker {
  const reports: DurableObjectMigrationReport[] = [];
  return {
    reports,
    binding: {
      report: async (input: DurableObjectMigrationReport) => {
        reports.push(input);
        if (options.reject) throw new Error("migration_report_rejected");
      },
    },
  };
}

function context(
  state: DurableObjectState,
  environment: Env,
): Parameters<typeof withMigrationReport>[0] {
  return {
    state,
    env: environment,
    component: "workspace_scheduler",
    className: "WorkspaceScheduler",
    latestVersion: latestMigrationVersion(WORKSPACE_SCHEDULER_SCHEMA_MIGRATIONS),
  };
}

/** `waitUntil` runs outside the call, so the assertion waits for it rather than racing it. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * A distinct scheduler object per test. The reporter keeps its ledger inside the
 * object, so sharing one between tests would make every assertion depend on the
 * order they ran in.
 */
async function withScheduler<T>(
  seed: string,
  run: (state: DurableObjectState) => Promise<T> | T,
): Promise<T> {
  const name = workspaceDOName("global", `${WORKSPACE_PREFIX}${seed}`);
  const stub = env.WORKSPACE_SCHEDULERS.get(env.WORKSPACE_SCHEDULERS.idFromName(name));
  return runInDurableObject(stub, async (_instance, state) => run(state));
}

function reportState(state: DurableObjectState): {
  reported_version: number;
  reported_status: string;
} | undefined {
  return state.storage.sql.exec<{ reported_version: number; reported_status: string }>(
    `SELECT reported_version, reported_status FROM _migration_report_state WHERE id = 1`,
  ).toArray()[0];
}

describe("withMigrationReport", () => {
  it("reports the object's current schema version on its first wake", async () => {
    const observer = tracker();
    await withScheduler("01", async (state) => {
      withMigrationReport(
        context(state, { ...env, MIGRATION_TRACKER: observer.binding }),
        () => undefined,
      );
      await settle();
    });

    expect(observer.reports).toHaveLength(1);
    const report = observer.reports[0];
    expect(report?.component).toBe("workspace_scheduler");
    expect(report?.className).toBe("WorkspaceScheduler");
    expect(report?.status).toBe("current");
    expect(report?.region).toBe("global");
    expect(report?.schemaVersion)
      .toBe(latestMigrationVersion(WORKSPACE_SCHEDULER_SCHEMA_MIGRATIONS));
    expect(report?.objectId).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("says nothing on a later wake that changes nothing", async () => {
    const observer = tracker();
    await withScheduler("02", async (state) => {
      const reportContext = context(state, { ...env, MIGRATION_TRACKER: observer.binding });
      withMigrationReport(reportContext, () => undefined);
      await settle();
      withMigrationReport(reportContext, () => undefined);
      withMigrationReport(reportContext, () => undefined);
      await settle();
    });

    expect(observer.reports).toHaveLength(1);
  });

  it("reports again once the running build changes", async () => {
    const observer = tracker();
    await withScheduler("03", async (state) => {
      withMigrationReport(
        context(state, { ...env, MIGRATION_TRACKER: observer.binding }),
        () => undefined,
      );
      await settle();
      withMigrationReport(
        context(state, {
          ...env,
          APP_VERSION: "next-build",
          MIGRATION_TRACKER: observer.binding,
        }),
        () => undefined,
      );
      await settle();
    });

    expect(observer.reports.map((report) => report.workerVersionId))
      .toEqual(["workerd-test", "next-build"]);
  });

  it("reports the versions a wake actually applied", async () => {
    const observer = tracker();
    const extended: DurableObjectSqliteMigration[] = [
      ...WORKSPACE_SCHEDULER_SCHEMA_MIGRATIONS,
      {
        version: 900,
        description: "test-only trailing migration",
        statements: ["CREATE TABLE IF NOT EXISTS migration_report_probe (id INTEGER PRIMARY KEY) STRICT"],
      },
    ];

    await withScheduler("04", async (state) => {
      withMigrationReport(
        { ...context(state, { ...env, MIGRATION_TRACKER: observer.binding }), latestVersion: 900 },
        () => applyDurableObjectSqliteMigrations({
          storage: state.storage,
          migrations: extended,
          component: "workspace_scheduler",
          workerVersionId: "workerd-test",
        }),
      );
      await settle();
    });

    expect(observer.reports[0]?.status).toBe("applied");
    expect(observer.reports[0]?.appliedVersions).toEqual([900]);
    expect(observer.reports[0]?.schemaVersion).toBe(900);
    expect(observer.reports[0]?.latestVersion).toBe(900);
  });

  it("reports a failure with the version that broke, then rethrows", async () => {
    const observer = tracker();
    await withScheduler("05", async (state) => {
      expect(() => withMigrationReport(
        context(state, { ...env, MIGRATION_TRACKER: observer.binding }),
        () => {
          throw new Error("workspace_scheduler_schema_hash_mismatch:1");
        },
      )).toThrow("workspace_scheduler_schema_hash_mismatch:1");
      await settle();
    });

    expect(observer.reports).toHaveLength(1);
    expect(observer.reports[0]?.status).toBe("failed");
    expect(observer.reports[0]?.failure).toEqual({
      message: "workspace_scheduler_schema_hash_mismatch:1",
      version: 1,
    });
  });

  it("retries on the next wake when the tracker refused the report", async () => {
    const observer = tracker({ reject: true });
    const recorded = await withScheduler("06", async (state) => {
      const reportContext = context(state, { ...env, MIGRATION_TRACKER: observer.binding });
      withMigrationReport(reportContext, () => undefined);
      await settle();
      withMigrationReport(reportContext, () => undefined);
      await settle();
      return reportState(state);
    });

    expect(observer.reports).toHaveLength(2);
    expect(recorded).toBeUndefined();
  });

  it("leaves the object alone when no tracker is bound", async () => {
    const applied = await withScheduler("07", async (state) => {
      const value = withMigrationReport(context(state, { ...env }), () => "constructed");
      await settle();
      return value;
    });

    expect(applied).toBe("constructed");
  });

  it("never lets a broken tracker fail the object", async () => {
    const exploding = {
      report: () => {
        throw new Error("tracker_is_down");
      },
    };
    const applied = await withScheduler("08", async (state) => {
      const value = withMigrationReport(
        context(state, { ...env, MIGRATION_TRACKER: exploding }),
        () => "constructed",
      );
      await settle();
      return value;
    });

    expect(applied).toBe("constructed");
  });
});
