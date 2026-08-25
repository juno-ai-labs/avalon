/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asWorkspaceId } from "@rally/contracts";
import type { DurableObjectMigrationReport } from "@rally/contracts/durable-object-migrations";
import type { Env } from "../src/env";
import { createCloudflareTestBinding } from "../test/helpers/cloudflare-test";
import {
  latestMigrationVersion,
  withMigrationReport,
} from "../src/durable-objects/migration-reporting";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "../src/durable-objects/sqlite-migrations";
import { workspaceDOName } from "../src/durable-objects/names";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const WORKSPACE_PREFIX = "00000000-0000-7000-8000-0000005000";

interface Tracker {
  reports: DurableObjectMigrationReport[];
  binding: NonNullable<Env["MIGRATION_REPORT_QUEUE"]>;
}

/**
 * A report-queue double that records what was sent, and optionally refuses it.
 *
 * Only `send` is exercised: the reporter sends one message at a time, because
 * the batching that makes this subsystem cheap happens on the consumer, not on
 * the producer — each object has exactly one report to send.
 */
function tracker(options: { reject?: boolean } = {}): Tracker {
  const reports: DurableObjectMigrationReport[] = [];
  return {
    reports,
    binding: createCloudflareTestBinding<NonNullable<Env["MIGRATION_REPORT_QUEUE"]>>({
      send: async (input: DurableObjectMigrationReport) => {
        reports.push(input);
        if (options.reject) throw new Error("queue_send_failed");
      },
    }),
  };
}

function context(
  state: DurableObjectState,
  environment: Env,
): Parameters<typeof withMigrationReport>[0] {
  return {
    state,
    env: environment,
    component: "workspace_do",
    className: "WorkspaceDO",
    latestVersion: latestMigrationVersion(WORKSPACE_DO_SCHEMA_MIGRATIONS),
  };
}

/** `waitUntil` runs outside the call, so the assertion waits for it rather than racing it. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * A distinct object per test. The reporter keeps its ledger inside the object,
 * so sharing one between tests would make every assertion depend on the order
 * they ran in.
 */
async function withObject<T>(
  seed: string,
  run: (state: DurableObjectState) => Promise<T> | T,
): Promise<T> {
  const name = workspaceDOName("global", asWorkspaceId(`${WORKSPACE_PREFIX}${seed}`));
  const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(name));
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
    await withObject("01", async (state) => {
      await withMigrationReport(
        context(state, { ...env, MIGRATION_REPORT_QUEUE: observer.binding }),
        () => undefined,
      );
      await settle();
    });

    expect(observer.reports).toHaveLength(1);
    const report = observer.reports[0];
    expect(report?.component).toBe("workspace_do");
    expect(report?.className).toBe("WorkspaceDO");
    expect(report?.status).toBe("current");
    expect(report?.region).toBe("global");
    expect(report?.schemaVersion)
      .toBe(latestMigrationVersion(WORKSPACE_DO_SCHEMA_MIGRATIONS));
    expect(report?.objectId).toMatch(/^[0-9a-f]{64}$/u);
    expect(report?.reportId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("gives every send its own report id, so a redelivery is distinguishable", async () => {
    const observer = tracker();
    await withObject("09", async (state) => {
      await withMigrationReport(
        context(state, { ...env, MIGRATION_REPORT_QUEUE: observer.binding }),
        () => undefined,
      );
      await settle();
      await withMigrationReport(
        context(state, {
          ...env,
          APP_VERSION: "next-build",
          MIGRATION_REPORT_QUEUE: observer.binding,
        }),
        () => undefined,
      );
      await settle();
    });

    const ids = observer.reports.map((report) => report.reportId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("says nothing on a later wake that changes nothing", async () => {
    const observer = tracker();
    await withObject("02", async (state) => {
      const reportContext = context(state, { ...env, MIGRATION_REPORT_QUEUE: observer.binding });
      await withMigrationReport(reportContext, () => undefined);
      await settle();
      await withMigrationReport(reportContext, () => undefined);
      await withMigrationReport(reportContext, () => undefined);
      await settle();
    });

    expect(observer.reports).toHaveLength(1);
  });

  it("reports again once the running build changes", async () => {
    const observer = tracker();
    await withObject("03", async (state) => {
      await withMigrationReport(
        context(state, { ...env, MIGRATION_REPORT_QUEUE: observer.binding }),
        () => undefined,
      );
      await settle();
      await withMigrationReport(
        context(state, {
          ...env,
          APP_VERSION: "next-build",
          MIGRATION_REPORT_QUEUE: observer.binding,
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
      ...WORKSPACE_DO_SCHEMA_MIGRATIONS,
      {
        version: 900,
        description: "test-only trailing migration",
        statements: ["CREATE TABLE IF NOT EXISTS migration_report_probe (id INTEGER PRIMARY KEY) STRICT"],
      },
    ];

    await withObject("04", async (state) => {
      await withMigrationReport(
        { ...context(state, { ...env, MIGRATION_REPORT_QUEUE: observer.binding }), latestVersion: 900 },
        () => applyDurableObjectSqliteMigrations({
          storage: state.storage,
          migrations: extended,
          component: "workspace_do",
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
    await withObject("05", async (state) => {
      await expect(withMigrationReport(
        context(state, { ...env, MIGRATION_REPORT_QUEUE: observer.binding }),
        () => {
          throw new Error("workspace_do_schema_hash_mismatch:1");
        },
      )).rejects.toThrow("workspace_do_schema_hash_mismatch:1");
      await settle();
    });

    expect(observer.reports).toHaveLength(1);
    expect(observer.reports[0]?.status).toBe("failed");
    expect(observer.reports[0]?.failure).toEqual({
      message: "workspace_do_schema_hash_mismatch:1",
      version: 1,
    });
  });

  it("retries on the next wake when the queue refused the message", async () => {
    const observer = tracker({ reject: true });
    const recorded = await withObject("06", async (state) => {
      const reportContext = context(state, { ...env, MIGRATION_REPORT_QUEUE: observer.binding });
      await withMigrationReport(reportContext, () => undefined);
      await settle();
      await withMigrationReport(reportContext, () => undefined);
      await settle();
      return reportState(state);
    });

    expect(observer.reports).toHaveLength(2);
    expect(recorded).toBeUndefined();
  });

  it("leaves the object alone when no report queue is bound", async () => {
    const applied = await withObject("07", async (state) => {
      const value = await withMigrationReport(context(state, { ...env }), () => "constructed");
      await settle();
      return value;
    });

    expect(applied).toBe("constructed");
  });

  it("never lets a broken queue fail the object", async () => {
    const exploding = createCloudflareTestBinding<NonNullable<Env["MIGRATION_REPORT_QUEUE"]>>({
      send: () => {
        throw new Error("queue_is_down");
      },
    });
    const applied = await withObject("08", async (state) => {
      const value = await withMigrationReport(
        context(state, { ...env, MIGRATION_REPORT_QUEUE: exploding }),
        () => "constructed",
      );
      await settle();
      return value;
    });

    expect(applied).toBe("constructed");
  });

  /**
   * The regression the reviewers found. Four of the five call sites run the
   * reporter inside `blockConcurrencyWhile`, and a throw out of that callback
   * breaks the object's input gate — workerd then aborts the object's pending
   * work, including a send left to `waitUntil`. So the failure report, the one
   * this whole subsystem exists for, was entered and never delivered.
   *
   * This has to be driven through a real `blockConcurrencyWhile`: the test
   * above calls the reporter from an ordinary request context, where nothing
   * breaks the input gate and a `waitUntil` send completes happily.
   */
  it("delivers the failure report even though the throw breaks the input gate", async () => {
    const delivered: string[] = [];
    const slow = createCloudflareTestBinding<NonNullable<Env["MIGRATION_REPORT_QUEUE"]>>({
      send: async (input: DurableObjectMigrationReport) => {
        // A send that does not resolve in the same microtask, which is what any
        // real queue send is. An immediate resolve would pass either way.
        await new Promise((resolve) => setTimeout(resolve, 5));
        delivered.push(input.status);
      },
    });

    // Breaking the input gate aborts the object, so the rejection surfaces from
    // `runInDurableObject` itself rather than from the inner call — which is
    // precisely the teardown that used to take the report with it.
    await expect(withObject("10", async (state) => {
      await state.blockConcurrencyWhile(async () => {
        await withMigrationReport(
          context(state, { ...env, MIGRATION_REPORT_QUEUE: slow }),
          () => {
            throw new Error("workspace_do_schema_hash_mismatch:1");
          },
        );
      });
    })).rejects.toThrow("workspace_do_schema_hash_mismatch:1");
    await settle();

    expect(delivered).toEqual(["failed"]);
  });

  /**
   * A failure has to reach the ledger, or the dedupe check keeps comparing
   * against the last *successful* report. A build that is rolled back to
   * exactly the one the object last reported then looks unchanged, and the
   * tracker goes on showing a broken object that has already recovered.
   */
  it("reports the recovery when a rollback restores the build it last reported", async () => {
    const observer = tracker();
    await withObject("11", async (state) => {
      const reportContext = context(state, { ...env, MIGRATION_REPORT_QUEUE: observer.binding });
      await withMigrationReport(reportContext, () => undefined);
      await settle();

      await expect(withMigrationReport(reportContext, () => {
        throw new Error("workspace_do_schema_hash_mismatch:1");
      })).rejects.toThrow();
      await settle();

      // The rollback: same build, same version, nothing to apply. Byte-identical
      // to the first wake, and inside the heartbeat.
      await withMigrationReport(reportContext, () => undefined);
      await settle();
    });

    expect(observer.reports.map((report) => report.status))
      .toEqual(["current", "failed", "current"]);
  });
});
