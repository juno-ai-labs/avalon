/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The fan-out: one queue message per Durable Object, on the queue of the region
 * that owns it.
 *
 * These run against the real registry object in workerd, because what is being
 * asserted is mostly what the registry's SQL selects — which objects are live,
 * which region each belongs to, and what happens at the cap. The queues
 * themselves are doubles, since a queue binding cannot be observed from inside
 * the Worker that writes to it.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { DurableObjectMigrationCommand } from "@rally/contracts/durable-object-migrations";

import { dispatchableRegions, dispatchMigrationRun } from "../src/dispatch";
import type { Env } from "../src/env";
import type { InventoryNamespace } from "../src/protocol";
import { REGISTRY_OBJECT_NAME } from "../src/registry";
import type { MigrationRegistry } from "../src/registry";
import { createRecordingQueue, type RecordingQueue } from "./helpers/cloudflare-test";

function objectId(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function registryStub(): DurableObjectStub<MigrationRegistry> {
  return env.MIGRATION_REGISTRY.get(env.MIGRATION_REGISTRY.idFromName(REGISTRY_OBJECT_NAME));
}

/** Seed the inventory the way an hourly sweep would, so targets are routable. */
async function sweepIn(namespaces: InventoryNamespace[]): Promise<void> {
  await runInDurableObject(registryStub(), (registry: MigrationRegistry) => {
    registry.recordSweep({
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      status: "complete",
      namespaces,
      truncatedNamespaces: [],
      errorMessage: null,
    });
  });
}

function namespaceOf(
  region: "global" | "eu",
  className: string,
  objectIds: string[],
): InventoryNamespace {
  return {
    namespaceId: `ns-${region}-${className}`,
    scriptName: `avalon-api-${region}`,
    className,
    usesSqlite: true,
    objects: objectIds.map((id) => ({ objectId: id, hasStoredData: true })),
  };
}

interface Queues {
  env: Env;
  global: RecordingQueue<DurableObjectMigrationCommand>;
  eu: RecordingQueue<DurableObjectMigrationCommand>;
}

function boundEnv(options: {
  regions?: ("global" | "eu")[];
  failAfter?: number;
} = {}): Queues {
  const regions = options.regions ?? ["global", "eu"];
  const global = createRecordingQueue<DurableObjectMigrationCommand>(
    options.failAfter === undefined ? {} : { failAfter: options.failAfter },
  );
  const eu = createRecordingQueue<DurableObjectMigrationCommand>();
  const bound: Env = { ...env };
  if (regions.includes("global")) bound.GLOBAL_MIGRATION_COMMAND_QUEUE = global.queue;
  else delete bound.GLOBAL_MIGRATION_COMMAND_QUEUE;
  if (regions.includes("eu")) bound.EU_MIGRATION_COMMAND_QUEUE = eu.queue;
  else delete bound.EU_MIGRATION_COMMAND_QUEUE;
  return { env: bound, global, eu };
}

beforeEach(async () => {
  await runInDurableObject(registryStub(), (_registry, state) => {
    for (const table of [
      "durable_objects",
      "migration_events",
      "component_versions",
      "inventory_sweeps",
      "durable_object_namespaces",
      "migration_runs",
    ]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
});

describe("dispatchMigrationRun", () => {
  it("sends one command per object, to the queue of the region that owns it", async () => {
    await sweepIn([
      namespaceOf("global", "WorkspaceDO", [objectId("a"), objectId("b")]),
      namespaceOf("eu", "WorkspaceDO", [objectId("c")]),
    ]);
    const queues = boundEnv();

    const run = await dispatchMigrationRun(
      queues.env,
      registryStub(),
      { className: "WorkspaceDO" },
      "operator@example.test",
    );

    expect(run.dispatched).toBe(3);
    expect(run.matched).toBe(3);
    expect(run.status).toBe("dispatched");
    expect(queues.global.sent.map((command) => command.objectId).sort())
      .toEqual([objectId("a"), objectId("b")].sort());
    expect(queues.eu.sent.map((command) => command.objectId)).toEqual([objectId("c")]);
    // Every message carries the region of the queue it went on, so a misrouted
    // producer is catchable by the consumer rather than only by the queue name.
    expect(queues.global.sent.every((command) => command.region === "global")).toBe(true);
    expect(queues.eu.sent[0]?.region).toBe("eu");
    // One run, one `runId`, distinct `commandId`s.
    expect(new Set(queues.global.sent.map((command) => command.runId))).toEqual(new Set([run.runId]));
    expect(new Set([...queues.global.sent, ...queues.eu.sent].map((c) => c.commandId)).size).toBe(3);
  });

  it("sends only the region the run asked for", async () => {
    await sweepIn([
      namespaceOf("global", "WorkstreamDO", [objectId("a")]),
      namespaceOf("eu", "WorkstreamDO", [objectId("b")]),
    ]);
    const queues = boundEnv();

    const run = await dispatchMigrationRun(
      queues.env,
      registryStub(),
      { className: "WorkstreamDO", region: "eu" },
      "operator@example.test",
    );

    expect(run.dispatched).toBe(1);
    expect(queues.global.sent).toEqual([]);
    expect(queues.eu.sent.map((command) => command.objectId)).toEqual([objectId("b")]);
  });

  /**
   * A region this deployment holds no binding for cannot be reached at all, and
   * reporting its objects as dispatched would be the one lie this page must not
   * tell — an operator would read a clean run and stop looking.
   */
  it("counts a region with no bound queue as unroutable rather than sent", async () => {
    await sweepIn([
      namespaceOf("global", "WorkspaceDO", [objectId("a")]),
      namespaceOf("eu", "WorkspaceDO", [objectId("b")]),
    ]);
    const queues = boundEnv({ regions: ["global"] });

    const run = await dispatchMigrationRun(
      queues.env,
      registryStub(),
      { className: "WorkspaceDO" },
      "operator@example.test",
    );

    expect(run.dispatched).toBe(1);
    expect(run.unroutable).toBe(1);
    expect(dispatchableRegions(queues.env)).toEqual(["global"]);
  });

  /**
   * The two causes are disjoint, and a review read them as double-counting.
   * An object with no resolvable region never reaches `targets` — the registry
   * filters it out — so the dispatcher only ever adds the *other* kind, whose
   * region is known but whose queue this deployment does not bind. Three
   * objects, two unreachable for different reasons, is `unroutable: 2`.
   */
  it("counts both causes of unroutable exactly once", async () => {
    await sweepIn([
      namespaceOf("global", "WorkspaceDO", [objectId("a")]),
      namespaceOf("eu", "WorkspaceDO", [objectId("b")]),
      // Region resolvable from neither a report nor a known script name.
      {
        namespaceId: "ns-elsewhere",
        scriptName: "some-other-worker",
        className: "WorkspaceDO",
        usesSqlite: true,
        objects: [{ objectId: objectId("c"), hasStoredData: true }],
      },
    ]);
    const queues = boundEnv({ regions: ["global"] });

    const run = await dispatchMigrationRun(
      queues.env,
      registryStub(),
      { className: "WorkspaceDO" },
      "operator@example.test",
    );

    expect(run.matched).toBe(3);
    expect(run.dispatched).toBe(1);
    expect(run.unroutable).toBe(2);
    expect(queues.global.sent.map((command) => command.objectId)).toEqual([objectId("a")]);
  });

  it("records what landed when the queue refuses partway", async () => {
    await sweepIn([namespaceOf("global", "WorkspaceDO", [objectId("a"), objectId("b")])]);
    const queues = boundEnv({ regions: ["global"], failAfter: 0 });

    const run = await dispatchMigrationRun(
      queues.env,
      registryStub(),
      { className: "WorkspaceDO" },
      "operator@example.test",
    );

    expect(run.status).toBe("failed");
    expect(run.dispatched).toBe(0);
    expect(run.errorMessage).toContain("queue_refused");

    const stored = await runInDurableObject(
      registryStub(),
      (registry: MigrationRegistry) => registry.listMigrationRuns(),
    );
    expect(stored[0]).toMatchObject({
      runId: run.runId,
      status: "failed",
      dispatched: 0,
      requestedBy: "operator@example.test",
    });
  });

  /**
   * The two regions are separate queues, so one refusing says nothing about the
   * other. Failing both because Global was walked first would turn one region's
   * outage into two, and the EU objects would go unreached with nothing in the
   * run row explaining why.
   */
  it("still reaches the healthy region when the other one refuses", async () => {
    await sweepIn([
      namespaceOf("global", "WorkspaceDO", [objectId("a")]),
      namespaceOf("eu", "WorkspaceDO", [objectId("b")]),
    ]);
    const queues = boundEnv({ failAfter: 0 });

    const run = await dispatchMigrationRun(
      queues.env,
      registryStub(),
      { className: "WorkspaceDO" },
      "operator@example.test",
    );

    expect(queues.global.sent).toEqual([]);
    expect(queues.eu.sent.map((command) => command.objectId)).toEqual([objectId("b")]);
    expect(run.dispatched).toBe(1);
    expect(run.status).toBe("failed");
    // Named, so the gap between matched and dispatched has an explanation.
    expect(run.errorMessage).toContain("global");
  });

  it("records a run that matched nothing as empty", async () => {
    const queues = boundEnv();

    const run = await dispatchMigrationRun(
      queues.env,
      registryStub(),
      { className: "WorkspaceDO" },
      "operator@example.test",
    );

    expect(run).toMatchObject({ status: "empty", matched: 0, dispatched: 0 });
  });

  /**
   * Cloudflare accepts at most 100 messages in one `sendBatch`, and the run cap
   * is 5,000 objects. Both bounds are asserted on the same fixture because a
   * change to either is a change to how a large class is covered, and the cap
   * is the one that must never be silent: `truncated` is what tells an operator
   * that a class they believe they migrated is only partly done.
   */
  /**
   * A capped run has to make progress, or "run it again to continue" is a lie
   * and the tail of a large class can never be forced. The order is
   * least-recently-heard-from first, and a forced object reports as it wakes,
   * so the second run reaches the objects the first one did not.
   */
  it("reaches different objects on a second run over a capped class", async () => {
    await runInDurableObject(registryStub(), (_registry, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE counter(i) AS (
           SELECT 1 UNION ALL SELECT i + 1 FROM counter WHERE i < 5001
         )
         INSERT INTO durable_objects
           (object_id, namespace_id, script_name, class_name, has_stored_data,
            first_seen_at, last_reported_at)
         SELECT printf('%064x', i), 'ns-global-WorkspaceDO', 'avalon-api-global',
                'WorkspaceDO', 1, 0, NULL
           FROM counter`,
      );
    });
    const queues = boundEnv({ regions: ["global"] });

    const first = await dispatchMigrationRun(
      queues.env,
      registryStub(),
      { className: "WorkspaceDO" },
      "operator@example.test",
    );
    expect(first.truncated).toBe(true);
    const firstIds = new Set(queues.global.sent.map((command) => command.objectId));

    // The objects that were reached report as they wake, which is what moves
    // them to the back of the next selection.
    await runInDurableObject(registryStub(), (_registry, state) => {
      state.storage.sql.exec(
        `UPDATE durable_objects SET last_reported_at = 1 WHERE object_id IN (
           SELECT object_id FROM durable_objects
            ORDER BY COALESCE(last_reported_at, 0), object_id LIMIT 5000)`,
      );
    });

    queues.global.sent.length = 0;
    await dispatchMigrationRun(
      queues.env,
      registryStub(),
      { className: "WorkspaceDO" },
      "operator@example.test",
    );

    // The one object the first run could not reach is in the second run.
    const secondIds = queues.global.sent.map((command) => command.objectId);
    expect(secondIds.some((id) => !firstIds.has(id))).toBe(true);
  });

  it("batches at a hundred and reports a run that hit the cap", async () => {
    await runInDurableObject(registryStub(), (_registry, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE counter(i) AS (
           SELECT 1 UNION ALL SELECT i + 1 FROM counter WHERE i < 5001
         )
         INSERT INTO durable_objects
           (object_id, namespace_id, script_name, class_name, has_stored_data, first_seen_at)
         SELECT printf('%064x', i), 'ns-global-WorkspaceDO', 'avalon-api-global',
                'WorkspaceDO', 1, 0
           FROM counter`,
      );
    });
    const queues = boundEnv({ regions: ["global"] });

    const run = await dispatchMigrationRun(
      queues.env,
      registryStub(),
      { className: "WorkspaceDO" },
      "operator@example.test",
    );

    expect(run.matched).toBe(5_001);
    expect(run.dispatched).toBe(5_000);
    expect(run.truncated).toBe(true);
    expect(queues.global.batches).toHaveLength(50);
    expect(new Set(queues.global.batches)).toEqual(new Set([100]));
  });
});
