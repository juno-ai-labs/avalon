/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Behavioural coverage for the v35 persistent AgentLoopDO loop.
 *
 * The retired dispatch table is deliberately absent. A subordinate `runs`
 * receipt with immutable execution context is the durable activation, while
 * one `substream_loops` row owns execution, ordering, leases, and recovery.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import {
  LOOP_ID,
  USER_ID,
  WORKSPACE_ID,
  WORKSTREAM_ID,
  activateFixtureReceipt,
  admitFixturePendingInput,
  boot,
  ensureFixtureLoop,
  executionReceipts,
  runInput,
  seedExecutionReceipt,
  seedOpenWorkstreamAuthority,
  seedRun,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeEach(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (access_class TEXT NOT NULL DEFAULT 'member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, incarnation TEXT NOT NULL DEFAULT 'existing-member', PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members
      (workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-20T00:00:00.000Z')
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET status = 'active'`)
      .bind(WORKSPACE_ID, USER_ID),
  ]);
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // takes every object's input gate, so this hook can wait out a full reset
  // before it gets to run at all. The seed itself takes milliseconds — a
  // failure here is a hang, never a slow query.
}, 30_000);

let unique = 0;

function agent(): DurableObjectStub {
  unique += 1;
  const substreamId = asSubstreamId(
    `00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`,
  );
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, substreamId),
  ));
}

async function readyAgent(): Promise<DurableObjectStub> {
  const stub = agent();
  await boot(stub);
  await runInDurableObject(stub, (_instance, state) => {
    seedWorkstreamRoot(state);
    // This fixture starts after initial projection delivery; only the receipt/timer is pending.
    state.storage.sql.exec('DELETE FROM authorization_projection_outbox');
    state.storage.sql.exec('UPDATE conversation_view_changes SET pending = 0, in_flight_revision = NULL, in_flight_until = NULL');
  });
  return stub;
}

type ActivationResponse = { status: number; payload: unknown };
type ActivationRpcResult = { status: number; bodyJson: string };

function activationResponse(result: ActivationRpcResult): ActivationResponse {
  return { status: result.status, payload: JSON.parse(result.bodyJson) as unknown };
}

async function activate(
  stub: DurableObjectStub,
  input: ReturnType<typeof runInput>,
): Promise<ActivationResponse> {
  const result = await (stub as unknown as {
    activateLoop(value: ReturnType<typeof runInput>): Promise<ActivationRpcResult>;
  }).activateLoop(input);
  return activationResponse(result);
}

const RUN_A = "00000000-0000-7000-8000-0000000004b1";
const RUN_B = "00000000-0000-7000-8000-0000000004b2";

it("activates an admitted input when the loop was created after the caller clock", async () => {
  const stub = await readyAgent();
  await runInDurableObject(stub, async (_instance, state) => {
    await admitFixturePendingInput(state, {
      inputId: "00000000-0000-7000-8000-0000000009f1", text: "Clock regression fixture", now: Date.now() - 1_000,
    });
    // Reproduce an older activation snapshot, including a wall-clock rollback.
    const createdAt = Date.now() + 60_000;
    state.storage.sql.exec("UPDATE substream_loops SET created_at = ?, updated_at = ?", createdAt, createdAt);
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  await runDurableObjectAlarm(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(executionReceipts(state)).toHaveLength(1);
    expect(state.storage.sql.exec("SELECT input_id FROM pending_loop_inputs").toArray()).toEqual([]);
    expect(state.storage.sql.exec<{ monotonic: number }>(
      "SELECT updated_at >= created_at AS monotonic FROM substream_loops",
    ).one().monotonic).toBe(1);
    await state.storage.deleteAlarm();
  });
});

describe("admitting a subordinate execution receipt", () => {
  it("arms one stable loop and absorbs an ambiguous-response retry", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, async (instance, state) => {
      seedRun(state, RUN_A);
      const resident = instance as unknown as {
        activateLoop(value: ReturnType<typeof runInput>): Promise<ActivationRpcResult>;
      };
      // Keep both calls in one object event so this is specifically an
      // ambiguous-response admission replay, not a race with the alarm that
      // is allowed to begin executing after the first response.
      const first = activationResponse(await resident.activateLoop(runInput(RUN_A)));
      const replay = activationResponse(await resident.activateLoop(runInput(RUN_A)));
      expect(first).toMatchObject({ status: 202, payload: { accepted: true } });
      expect(replay).toMatchObject({ status: 202, payload: { accepted: true } });
      expect(executionReceipts(state)).toHaveLength(1);
      expect(JSON.parse(executionReceipts(state)[0]!.execution_context_json!))
        .toEqual(runInput(RUN_A));
      expect(state.storage.sql.exec<{ loop_id: string }>(
        `SELECT loop_id FROM substream_loops`,
      ).toArray()).toEqual([{ loop_id: LOOP_ID }]);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("rejects a receipt for another work stream or logical loop", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, (_instance, state) => {
      seedRun(state, RUN_A);
      seedRun(state, RUN_B);
    });

    await expect(activate(stub, runInput(RUN_A, {
      parentId: "00000000-0000-7000-8000-0000000004ff",
    }))).resolves.toMatchObject({
      status: 409,
      payload: { error: "substream_run_identity_mismatch" },
    });
    await expect(activate(stub, runInput(RUN_B, {
      loopId: "message-owned-loop",
    }))).resolves.toMatchObject({
      status: 409,
      payload: { error: "substream_loop_identity_mismatch" },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(executionReceipts(state)).toEqual([]);
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM substream_loops`).one())
        .toEqual({ count: 1 });
    });
  });

  it("does not synthesize an execution when its receipt is missing", async () => {
    const stub = await readyAgent();

    await expect(activate(stub, runInput(RUN_A))).resolves.toMatchObject({
      status: 409,
      payload: { error: "substream_loop_execution_receipt_not_found" },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM runs`).one())
        .toEqual({ count: 0 });
    });
  });

});

describe("executing the singleton loop", () => {
  it("claims one receipt once while the loop lease is live", async () => {
    const stub = await readyAgent();

    await runInDurableObject(stub, async (instance, state) => {
      seedExecutionReceipt(state, RUN_A, runInput(RUN_A), Date.now());
      ensureFixtureLoop(state, Date.now());
      const resident = instance as unknown as {
        claimPersistentLoopExecution(): Promise<unknown>;
      };
      const first = await resident.claimPersistentLoopExecution();
      const repeat = await resident.claimPersistentLoopExecution();
      expect(first).toMatchObject({
        input: { harnessRunId: RUN_A, loopId: LOOP_ID },
        execution: { runId: RUN_A, executionEpoch: 1 },
      });
      expect(repeat).toBeNull();
      expect(executionReceipts(state)).toHaveLength(1);
      expect(executionReceipts(state)[0]).toMatchObject({
        run_id: RUN_A,
        substream_loop_id: LOOP_ID,
        loop_execution_id: RUN_A,
        loop_execution_epoch: 1,
        loop_execution_sequence: 1,
      });
    });
  });

  it("takes over an expired lease without minting a second receipt", async () => {
    const stub = await readyAgent();

    await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      seedExecutionReceipt(state, RUN_A, runInput(RUN_A), now - 10_000);
      activateFixtureReceipt(state, RUN_A, {
        leaseOwner: "owner-that-vanished",
        leaseExpiresAt: now - 1,
        now: now - 10_000,
      });
      const recovered = await (instance as unknown as {
        claimPersistentLoopExecution(): Promise<unknown>;
      }).claimPersistentLoopExecution();

      expect(recovered).toMatchObject({
        input: { harnessRunId: RUN_A, loopId: LOOP_ID },
        execution: { runId: RUN_A, executionEpoch: 2 },
      });
      expect(executionReceipts(state)).toHaveLength(1);
      expect(state.storage.sql.exec<{
        active_execution_id: string;
        active_execution_epoch: number;
      }>(`SELECT active_execution_id, active_execution_epoch
             FROM substream_loops WHERE id = 1`).one()).toEqual({
        active_execution_id: RUN_A,
        active_execution_epoch: 2,
      });
      expect(executionReceipts(state)[0]!.loop_execution_epoch).toBe(2);
    });
  });
});

describe("recovering durable loop work", () => {
  it("re-arms an admitted receipt after eviction loses every in-memory hint", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, async (_instance, state) => {
      seedExecutionReceipt(state, RUN_A, runInput(RUN_A), Date.now() + 60_000);
      ensureFixtureLoop(state, Date.now());
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(executionReceipts(state)).toHaveLength(1);
      expect(executionReceipts(state)[0]!.substream_loop_id).toBeNull();
    });
  });

  it("does not keep waking for a fully settled receipt", async () => {
    const stub = await readyAgent();
    await runInDurableObject(stub, async (_instance, state) => {
      seedExecutionReceipt(state, RUN_A, runInput(RUN_A), 1);
      ensureFixtureLoop(state, 1);
      state.storage.sql.exec(
        `UPDATE runs SET status = 'failed', terminalized_at = 1,
                external_settled_at = 1, execution_available_at = NULL
          WHERE run_id = ?`,
        RUN_A,
      );
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});

describe("waking for product timers beside the loop", () => {
  it("still schedules the next pending wake-up without a run ledger", async () => {
    const stub = await readyAgent();
    const dueAt = Date.now() + 5 * 60_000;
    await runInDurableObject(stub, async (_instance, state) => {
      seedRun(state, RUN_A);
      state.storage.sql.exec(
        `INSERT INTO workstream_wakeups
           (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
            status, idempotency_key, version, created_at, updated_at)
         VALUES ('wake-1', ?, '{"type":"system"}', 'follow up', ?, 'pending', 'k1', 1, 1, 1)`,
        RUN_A,
        dueAt,
      );
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub);

    const alarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm());
    expect(alarm).toBe(dueAt);
  });
});
