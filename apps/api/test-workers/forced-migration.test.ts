import "../../../tests/isolated-region";
/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Forcing a Durable Object onto the running build's schema, end to end inside
 * the runtime.
 *
 * The two halves are tested where each one lives. `forceMigration` is exercised
 * through a real Durable Object stub, because what it claims — that reaching the
 * method at all means the object woke and applied its schema — is a fact about
 * workerd's constructor semantics and cannot be observed against a double. The
 * unconditional report is exercised against an injected queue binding, the same
 * way `migration-reporting.test.ts` does, because the workerd test config
 * deliberately leaves the report queue unbound.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asWorkspaceId } from "@rally/contracts";
import type {
  DurableObjectMigrationCommand,
  DurableObjectMigrationReport,
} from "@rally/contracts/durable-object-migrations";

import { workspaceDOName } from "../src/durable-objects/names";
import {
  latestMigrationVersion,
  reportForcedMigration,
} from "../src/durable-objects/migration-reporting";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import type { Env } from "../src/env";
import {
  applyMigrationCommand,
  consumeMigrationCommandQueue,
  migrationCommandDispatchers,
  migrationShortfall,
  MIGRATION_COMMAND_HEADS,
} from "../src/queues/migration-command-consumer";
import { createCloudflareTestBinding } from "../test/helpers/cloudflare-test";

const WORKSPACE_PREFIX = "00000000-0000-7000-8000-0000006000";
const WORKSPACE_HEAD = latestMigrationVersion(WORKSPACE_DO_SCHEMA_MIGRATIONS);

/** A distinct object per test, so no assertion depends on execution order. */
function workspaceObjectId(seed: string): string {
  const name = workspaceDOName("global", asWorkspaceId(`${WORKSPACE_PREFIX}${seed}`));
  return env.WORKSPACE_DOS.idFromName(name).toString();
}

let commandSequence = 0;

function command(overrides: Partial<DurableObjectMigrationCommand> = {}): DurableObjectMigrationCommand {
  commandSequence += 1;
  return {
    commandId: `00000000-0000-7000-8000-${String(commandSequence).padStart(12, "0")}`,
    runId: "00000000-0000-7000-8000-00000000ffff",
    className: "WorkspaceDO",
    objectId: workspaceObjectId("01"),
    objectName: null,
    region: "global",
    requestedAt: 1_700_000_000_000,
    ...overrides,
  };
}

interface TestMessage {
  id: string;
  acked: boolean;
  retried: boolean;
}

/**
 * A batch whose per-message `ack()`/`retry()` is observable. `MessageBatch` is
 * produced by the runtime and cannot be constructed, so the consumer's actual
 * contract with the platform is only assertable against a double.
 */
function batch(bodies: unknown[], queue = "avalon-global-migration-commands"): {
  batch: MessageBatch<unknown>;
  messages: TestMessage[];
} {
  const messages: TestMessage[] = bodies.map((_body, index) => ({
    id: `message-${index}`,
    acked: false,
    retried: false,
  }));
  const value = {
    queue,
    messages: bodies.map((body, index) => ({
      id: `message-${index}`,
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack: () => {
        messages[index]!.acked = true;
      },
      retry: () => {
        messages[index]!.retried = true;
      },
    })),
    ackAll: () => {
      for (const message of messages) message.acked = true;
    },
    retryAll: () => {
      for (const message of messages) message.retried = true;
    },
  };
  return { batch: value as unknown as MessageBatch<unknown>, messages };
}

describe("forceMigration", () => {
  it("wakes the object and answers with the version it is on", async () => {
    const outcome = await applyMigrationCommand(env, command({
      objectId: workspaceObjectId("01"),
    }));

    expect(outcome).toMatchObject({
      objectId: workspaceObjectId("01"),
      className: "WorkspaceDO",
      component: "workspace_do",
      schemaVersion: WORKSPACE_HEAD,
      latestVersion: WORKSPACE_HEAD,
    });
    // Reaching the method means the constructor's migration pass completed, so
    // the object's own ledger has to agree with what came back.
    const applied = await runInDurableObject(
      env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromString(workspaceObjectId("01"))),
      (_instance, state) => state.storage.sql.exec<{ version: number | null }>(
        `SELECT MAX(version) AS version FROM _sql_schema_migrations`,
      ).toArray()[0]?.version ?? 0,
    );
    expect(applied).toBe(WORKSPACE_HEAD);
  });

  /**
   * The platform validates an ID against the namespace it is parsed in, so a
   * command naming the wrong class never reaches an object at all — it is
   * refused before `get()`. Worth asserting rather than assuming: it is the
   * reason a misrouted command cannot silently create an empty object in a
   * namespace it does not belong to.
   */
  it("cannot address an object through another class's namespace", async () => {
    await expect(applyMigrationCommand(env, command({
      objectId: workspaceObjectId("02"),
      className: "AgentLoopDO",
    }))).rejects.toThrow(/not valid for this namespace/u);
  });

  /**
   * The object's own two guards, which sit behind that one. They are not
   * defence against a hostile caller — a queue has no public address — but
   * against a wiring mistake in the dispatcher map, where a class name would be
   * paired with the wrong binding and every ID in it would parse cleanly.
   */
  it("refuses a command whose class or object is not the one it reached", async () => {
    // Called on the instance rather than through the stub. A throw crossing an
    // RPC boundary is delivered twice under the workers pool — once to the
    // caller and once as an uncaught rejection inside the object — which fails
    // the run on an error the production consumer catches and retries. What is
    // under test is the guard, not the transport.
    const stub = env.WORKSPACE_DOS.get(
      env.WORKSPACE_DOS.idFromString(workspaceObjectId("03")),
    );

    await runInDurableObject(stub, async (instance) => {
      await expect(instance.forceMigration(command({
        objectId: workspaceObjectId("03"),
        className: "AgentLoopDO",
      }))).rejects.toThrow(/durable_object_migration_command_class_mismatch/u);

      await expect(instance.forceMigration(command({
        objectId: workspaceObjectId("04"),
      }))).rejects.toThrow(/durable_object_migration_command_object_mismatch/u);
    });
  });

  it("has a dispatcher for every class the tracker may name", () => {
    expect(Object.keys(migrationCommandDispatchers(env)).sort())
      .toEqual(["AgentLoopDO", "WorkspaceDO"]);
  });

  it("carries a command queued under the conversation class's old name to the renamed class", async () => {
    const objectId = env.SUBSTREAM_AGENTS.idFromName(`global:${WORKSPACE_PREFIX}0f:00000000-0000-7000-8000-00000060ff0f`).toString();
    const outcome = await applyMigrationCommand(env, command({ className: "SubstreamAgent", objectId }));
    expect(outcome).toMatchObject({ objectId, className: "AgentLoopDO" });
  });

  it("refuses a class this Worker does not deploy", async () => {
    await expect(applyMigrationCommand(env, command({ className: "MigrationRegistry" })))
      .rejects.toThrow(/migration_command_unknown_class:MigrationRegistry/u);
  });

  /**
   * A name off `Object.prototype` is a class name as far as the command
   * contract is concerned — `constructor` matches its regex — and looking the
   * dispatcher up with a plain index finds `Object` rather than `undefined`.
   * The unknown-class guard then passes, `Object(command)` returns the command,
   * and the consumer acknowledges a message as applied having woken nothing.
   */
  it("refuses a class name inherited from Object.prototype", async () => {
    for (const className of ["constructor", "toString", "valueOf"]) {
      await expect(applyMigrationCommand(env, command({ className })))
        .rejects.toThrow(new RegExp(`migration_command_unknown_class:${className}`, "u"));
    }
  });
});

/**
 * The forced report is the operator's receipt that a specific object was
 * reached, so it is sent whether or not anything about the object changed —
 * which is the opposite of what an ordinary wake does.
 */
describe("reportForcedMigration", () => {
  function tracker(options: { reject?: boolean } = {}): {
    reports: DurableObjectMigrationReport[];
    binding: NonNullable<Env["MIGRATION_REPORT_QUEUE"]>;
  } {
    const reports: DurableObjectMigrationReport[] = [];
    return {
      reports,
      binding: createCloudflareTestBinding<NonNullable<Env["MIGRATION_REPORT_QUEUE"]>>({
        send: async (input: DurableObjectMigrationReport) => {
          if (options.reject) throw new Error("queue_send_failed");
          reports.push(input);
        },
      }),
    };
  }

  function context(state: DurableObjectState, environment: Env): Parameters<typeof reportForcedMigration>[0] {
    return {
      state,
      env: environment,
      component: "workspace_do",
      className: "WorkspaceDO",
      latestVersion: WORKSPACE_HEAD,
    };
  }

  async function withObject<T>(
    seed: string,
    run: (state: DurableObjectState) => Promise<T> | T,
  ): Promise<T> {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromString(workspaceObjectId(seed)));
    return runInDurableObject(stub, async (_instance, state) => run(state));
  }

  it("reports every time it is asked, including when nothing changed", async () => {
    const observer = tracker();
    const ledger = (state: DurableObjectState): number => state.storage
      .sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM _sql_schema_migrations`)
      .toArray()[0]?.count ?? 0;

    const { outcome, before, after } = await withObject("10", async (state) => {
      const environment: Env = { ...env, MIGRATION_REPORT_QUEUE: observer.binding };
      const start = ledger(state);
      await reportForcedMigration(context(state, environment), null);
      const result = await reportForcedMigration(context(state, environment), null);
      return { outcome: result, before: start, after: ledger(state) };
    });

    // The object was already constructed, so nothing was applied — reporting an
    // object twice must not touch its schema. This is what a forced migration
    // does to an object that is already awake, and it is the whole of it.
    expect(after).toBe(before);
    expect(observer.reports.every((report) => report.appliedVersions.length === 0)).toBe(true);
    expect(observer.reports).toHaveLength(2);
    expect(observer.reports.map((report) => report.status)).toEqual(["current", "current"]);
    // Distinct report ids, or the tracker's dedupe would collapse the second
    // into the first and the operator's receipt would go missing.
    expect(new Set(observer.reports.map((report) => report.reportId)).size).toBe(2);
    expect(outcome.reported).toBe(true);
  });

  it("comes back unreported rather than throwing when the queue refuses", async () => {
    const outcome = await withObject("11", (state) => reportForcedMigration(
      context(state, { ...env, MIGRATION_REPORT_QUEUE: tracker({ reject: true }).binding }),
      null,
    ));

    expect(outcome.reported).toBe(false);
    expect(outcome.schemaVersion).toBe(WORKSPACE_HEAD);
  });

  it("comes back unreported when no tracker is bound at all", async () => {
    const outcome = await withObject("12", (state) => reportForcedMigration(
      context(state, env),
      null,
    ));

    expect(outcome.reported).toBe(false);
  });
});

describe("consumeMigrationCommandQueue", () => {
  it("acknowledges a command it applied", async () => {
    const delivery = batch([command({ objectId: workspaceObjectId("20") })]);
    await consumeMigrationCommandQueue(delivery.batch, env);

    expect(delivery.messages[0]).toMatchObject({ acked: true, retried: false });
  });

  /**
   * Neither of these can ever become valid, so both are dropped rather than
   * retried into the dead-letter queue — where they would spend a redelivery
   * budget that belongs to the objects that genuinely failed.
   */
  it("drops a message the contract refuses", async () => {
    const delivery = batch([{ className: "WorkspaceDO" }]);
    await consumeMigrationCommandQueue(delivery.batch, env);

    expect(delivery.messages[0]).toMatchObject({ acked: true, retried: false });
  });

  /**
   * Rerouting is the Global fallback `choosing-queues-or-rpc.md` forbids: a
   * command is applied by the region that owns the object or not at all.
   *
   * The command carries an ID that is not this namespace's, so applying it
   * would throw and the message would be retried. Acknowledging it is therefore
   * evidence that nothing was attempted, which a command that could have been
   * applied successfully could not give — the consumer would ack either way.
   */
  it("drops a command addressed to the other region rather than rerouting it", async () => {
    const foreign = env.SUBSTREAM_AGENTS.idFromName("global:not-this-namespace").toString();
    const delivery = batch([command({ region: "enterprise", objectId: foreign })]);
    await consumeMigrationCommandQueue(delivery.batch, env);

    expect(delivery.messages[0]).toMatchObject({ acked: true, retried: false });
  });

  it("acknowledges a command for a deleted class instead of retrying it", async () => {
    // A run dispatched before WorkstreamDO, SpaceDO and SidekickDO were
    // deleted can still be queued after; no binding can ever apply it.
    // AutomationDO is SidekickDO's earlier name, which old commands carry.
    const delivery = batch([
      command({ className: "WorkstreamDO", objectId: workspaceObjectId("05") }),
      command({ className: "SpaceDO", objectId: workspaceObjectId("06") }),
      command({ className: "SidekickDO", objectId: workspaceObjectId("07") }),
      command({ className: "AutomationDO", objectId: workspaceObjectId("08") }),
    ]);
    await consumeMigrationCommandQueue(delivery.batch, env);

    for (const message of delivery.messages) expect(message).toMatchObject({ acked: true, retried: false });
  });

  it("retries a command whose object could not be reached", async () => {
    const delivery = batch([command({ className: "MigrationRegistry" })]);
    await consumeMigrationCommandQueue(delivery.batch, env);

    expect(delivery.messages[0]).toMatchObject({ acked: false, retried: true });
  });

  it("handles each message in a batch independently", async () => {
    const delivery = batch([
      command({ objectId: workspaceObjectId("22") }),
      command({ className: "MigrationRegistry" }),
      { nonsense: true },
    ]);
    await consumeMigrationCommandQueue(delivery.batch, env);

    expect(delivery.messages.map((message) => message.retried)).toEqual([false, true, false]);
    expect(delivery.messages.map((message) => message.acked)).toEqual([true, false, true]);
  });
});

/**
 * The shortfall check, which used to compare an outcome's own two versions and
 * therefore could never fire: both are read inside the object's isolate after a
 * successful migration pass, so they are equal by construction. The case worth
 * flagging — an object still awake on a previous build — has *both* numbers
 * from that older build, so it read as a clean apply.
 */
describe("migrationShortfall", () => {
  it("has a head for every class a command can name", () => {
    expect(Object.keys(MIGRATION_COMMAND_HEADS).sort())
      .toEqual(Object.keys(migrationCommandDispatchers(env)).sort());
    for (const head of Object.values(MIGRATION_COMMAND_HEADS)) expect(head).toBeGreaterThan(0);
  });

  it("says nothing when the object is on the version this build ships", () => {
    expect(migrationShortfall({
      className: "WorkspaceDO",
      schemaVersion: MIGRATION_COMMAND_HEADS.WorkspaceDO!,
    })).toBeNull();
  });

  /**
   * The stale-isolate case. It reports a version below this deployment's head
   * while its own `latestVersion` agrees with it, which is exactly why the old
   * self-comparison stayed silent here.
   */
  it("names this build's head when the object answered from an older one", () => {
    const head = MIGRATION_COMMAND_HEADS.WorkspaceDO!;
    expect(migrationShortfall({ className: "WorkspaceDO", schemaVersion: head - 1 })).toBe(head);
  });

  it("says nothing for a class this Worker has no head for", () => {
    expect(migrationShortfall({ className: "MigrationRegistry", schemaVersion: 0 })).toBeNull();
  });
});
