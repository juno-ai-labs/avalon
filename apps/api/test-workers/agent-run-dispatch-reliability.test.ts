/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Crash/retry behavior for the v35 singleton SubstreamAgent loop.
 *
 * Substream execution no longer has a dispatch table. Durable work is either
 * an immutable subordinate `runs` receipt or an ordered pending loop input;
 * one `substream_loops` row owns admission, execution, and recovery. These
 * workerd tests assert those product invariants through real SQLite
 * transactions, object eviction, and alarm restoration.
 *
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import type { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import {
  LOOP_ID,
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
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // takes every object's input gate, so this hook can wait out a full reset
  // before it gets to run at all. The seed itself takes milliseconds — a
  // failure here is a hang, never a slow query.
}, 30_000);

let unique = 100;
const testStubs: DurableObjectStub[] = [];

function substreamStub(): DurableObjectStub {
  unique += 1;
  const substreamId = asSubstreamId(
    `00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`,
  );
  const name = conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, substreamId);
  const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(name));
  testStubs.push(stub);
  return stub;
}

afterEach(async () => {
  // These cases deliberately reconstruct due alarms. Drain each object's input
  // gate and disarm it before Vitest tears down the shared worker; otherwise a
  // legal alarm RPC can still be resolving when the environment closes.
  await Promise.all(testStubs.splice(0).map(async (stub) => {
    try {
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    } catch {
      // A case may evict the object before it reaches its assertion.
    }
  }));
});

async function readySubstream(): Promise<DurableObjectStub> {
  const stub = substreamStub();
  await boot(stub);
  await runInDurableObject(stub, (_instance, state) => {
    seedWorkstreamRoot(state);
    // This fixture starts after initial projection delivery; only the receipt/timer is pending.
    state.storage.sql.exec('DELETE FROM authorization_projection_outbox');
    state.storage.sql.exec('UPDATE conversation_view_changes SET pending = 0, in_flight_revision = NULL, in_flight_until = NULL');
  });
  return stub;
}


const RUN_A = "00000000-0000-7000-8000-0000000005a1";
const RUN_B = "00000000-0000-7000-8000-0000000005a2";
const INPUT_A = "00000000-0000-7000-8000-0000000005b1";
const INPUT_B = "00000000-0000-7000-8000-0000000005b2";
const INPUT_C = "00000000-0000-7000-8000-0000000005b3";

describe("singleton loop durability", () => {
  it("preserves a persisted non-main substream identity when a replacement isolate starts", async () => {
    const stub = await readySubstream();
    const childSubstreamId = "00000000-0000-7000-8000-0000000005c1";
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE substream_agent_identity
            SET external_substream_id = ?, updated_at = 2
          WHERE id = 1`,
        childSubstreamId,
      );
      state.storage.sql.exec(`DELETE FROM substream_loops`);
    });

    await evictDurableObject(stub);
    await boot(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ external_substream_id: string }>(
        `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
      ).one()).toEqual({ external_substream_id: childSubstreamId });
      expect(state.storage.sql.exec<{ loop_id: string }>(
        `SELECT loop_id FROM substream_loops WHERE id = 1`,
      ).one().loop_id).toContain(`substream:${childSubstreamId}:loop`);
    });
  });

  it("keeps one stable loop identity across activation retries and later receipts", async () => {
    const stub = await readySubstream();

    await runInDurableObject(stub, async (instance, state) => {
      seedRun(state, RUN_A);
      seedRun(state, RUN_B);
      const resident = instance as unknown as {
        activateLoop(input: ReturnType<typeof runInput>): Promise<{ status: number }>;
      };

      expect((await resident.activateLoop(runInput(RUN_A))).status).toBe(202);
      expect((await resident.activateLoop(runInput(RUN_A))).status).toBe(202);
      expect((await resident.activateLoop(runInput(RUN_B))).status).toBe(202);

      expect(state.storage.sql.exec<{ loop_id: string }>(
        `SELECT loop_id FROM substream_loops`,
      ).toArray()).toEqual([{ loop_id: LOOP_ID }]);
      expect(executionReceipts(state).map((receipt) => receipt.run_id))
        .toEqual([RUN_A, RUN_B]);
      expect(executionReceipts(state).every((receipt) =>
        JSON.parse(receipt.execution_context_json!).loopId === LOOP_ID)).toBe(true);
    });
  });

  it("reconstructs an alarm from an admitted receipt after eviction", async () => {
    const stub = await readySubstream();
    const dueAt = Date.now() + 60_000;

    await runInDurableObject(stub, async (_instance, state) => {
      seedExecutionReceipt(state, RUN_A, runInput(RUN_A), dueAt);
      ensureFixtureLoop(state, 1);
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(dueAt);
      expect(executionReceipts(state)).toHaveLength(1);
      expect(executionReceipts(state)[0]!.substream_loop_id).toBeNull();
    });
  });

  it("takes over an expired lease without creating or relinking a receipt", async () => {
    const stub = await readySubstream();

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
      expect(executionReceipts(state)[0]).toMatchObject({
        run_id: RUN_A,
        substream_loop_id: LOOP_ID,
        loop_execution_id: RUN_A,
        loop_execution_sequence: 1,
        loop_execution_epoch: 2,
      });
      const loop = new SubstreamLoopStorage(state.storage).loop()!;
      expect(new SubstreamLoopStorage(state.storage).recoverExecution({
        executionId: RUN_A,
        newExecutionEpoch: 2,
        leaseOwner: loop.lease_owner!,
        leaseExpiresAt: loop.lease_expires_at!,
        expectedLoopRevision: loop.revision,
        now,
      })).toMatchObject({ outcome: "reused", loop: { active_execution_epoch: 2 } });
    });
  });

  it("expires the vanished isolate's live loop lease and recovers immediately after eviction", async () => {
    const stub = await readySubstream();
    const beforeEviction = Date.now();

    await runInDurableObject(stub, async (_instance, state) => {
      seedExecutionReceipt(state, RUN_A, runInput(RUN_A), beforeEviction - 1);
      activateFixtureReceipt(state, RUN_A, {
        leaseOwner: "loop-owner-that-vanished",
        leaseExpiresAt: beforeEviction + 300_000,
        now: beforeEviction,
      });
      state.storage.sql.exec(
        `UPDATE runs
            SET legacy_attempt_id = 'attempt-that-vanished',
                lease_owner = 'attempt-owner-that-vanished',
                lease_expires_at = ?
          WHERE run_id = ?`,
        beforeEviction + 300_000,
        RUN_A,
      );
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      const resident = instance as unknown as {
        claimPersistentLoopExecution(): Promise<{
          execution: { runId: string; executionEpoch: number };
        } | null>;
      };
      const recovered = await resident.claimPersistentLoopExecution();

      expect(recovered).toMatchObject({
        execution: { runId: RUN_A, executionEpoch: 2 },
      });
      expect(new SubstreamLoopStorage(state.storage).loop()).toMatchObject({
        active_execution_id: RUN_A,
        active_execution_epoch: 2,
        status: "executing",
      });
      expect(executionReceipts(state)[0]).toMatchObject({
        run_id: RUN_A,
        loop_execution_epoch: 2,
      });
    });
  });

  it("expires a due singleton lease after eviction even when no provider attempt was acquired", async () => {
    const stub = await readySubstream();
    const beforeEviction = Date.now();

    await runInDurableObject(stub, async (_instance, state) => {
      seedExecutionReceipt(state, RUN_A, runInput(RUN_A), beforeEviction - 1);
      activateFixtureReceipt(state, RUN_A, {
        leaseOwner: "loop-owner-without-provider-attempt",
        leaseExpiresAt: beforeEviction + 300_000,
        now: beforeEviction,
      });
      expect(state.storage.sql.exec<{ legacy_attempt_id: string | null }>(
        `SELECT legacy_attempt_id FROM runs WHERE run_id = ?`,
        RUN_A,
      ).one()).toEqual({ legacy_attempt_id: null });
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      const recovered = await (instance as unknown as {
        claimPersistentLoopExecution(): Promise<{
          execution: { runId: string; executionEpoch: number };
        } | null>;
      }).claimPersistentLoopExecution();

      expect(recovered).toMatchObject({
        execution: { runId: RUN_A, executionEpoch: 2 },
      });
      expect(new SubstreamLoopStorage(state.storage).loop()).toMatchObject({
        active_execution_id: RUN_A,
        active_execution_epoch: 2,
        status: "executing",
      });
    });
  });

  it("defers one active receipt without ending its cycle, then recovers it once", async () => {
    const stub = await readySubstream();
    const now = Date.now();
    const availableAt = now + 30_000;

    await runInDurableObject(stub, async (instance, state) => {
      seedExecutionReceipt(state, RUN_A, runInput(RUN_A), now - 1);
      ensureFixtureLoop(state, now - 1);
      const resident = instance as unknown as {
        claimPersistentLoopExecution(): Promise<{
          execution: { runId: string; leaseOwner: string; executionEpoch: number };
        } | null>;
      };
      const claimed = await resident.claimPersistentLoopExecution();
      expect(claimed).not.toBeNull();
      const loops = new SubstreamLoopStorage(state.storage);
      const before = loops.loop()!;
      loops.deferExecution({
        executionId: claimed!.execution.runId,
        executionEpoch: claimed!.execution.executionEpoch,
        leaseOwner: claimed!.execution.leaseOwner,
        expectedLoopRevision: before.revision,
        availableAt,
        errorCode: "provider_unavailable",
        now,
      });

      expect(await resident.claimPersistentLoopExecution()).toBeNull();
      expect(loops.loop()).toMatchObject({
        loop_id: LOOP_ID,
        status: "executing",
        cycle_ordinal: 1,
        active_execution_id: RUN_A,
        active_execution_epoch: 1,
        lease_expires_at: availableAt,
      });
      expect(executionReceipts(state)[0]).toMatchObject({
        run_id: RUN_A,
        loop_cycle_ordinal: 1,
        loop_execution_epoch: 1,
        execution_available_at: availableAt,
      });
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    await boot(stub);

    await runInDurableObject(stub, async (instance, state) => {
      const resident = instance as unknown as {
        claimPersistentLoopExecution(): Promise<{
          execution: { runId: string; leaseOwner: string; executionEpoch: number };
        } | null>;
        product: WorkstreamObjectProductService;
      };
      const loops = new SubstreamLoopStorage(state.storage);
      expect(await state.storage.getAlarm()).toBe(availableAt);
      expect(await resident.claimPersistentLoopExecution()).toBeNull();
      expect(loops.loop()).toMatchObject({
        loop_id: LOOP_ID,
        status: "executing",
        cycle_ordinal: 1,
        active_execution_id: RUN_A,
        active_execution_epoch: 1,
        lease_expires_at: availableAt,
      });

      state.storage.sql.exec(
        `UPDATE substream_loops SET lease_expires_at = ? WHERE id = 1`,
        now - 1,
      );
      state.storage.sql.exec(
        `UPDATE runs SET execution_available_at = ? WHERE run_id = ?`,
        now - 1,
        RUN_A,
      );
      const recovered = await resident.claimPersistentLoopExecution();
      expect(recovered).toMatchObject({
        execution: { runId: RUN_A, executionEpoch: 2 },
      });
      expect(executionReceipts(state)).toHaveLength(1);
      expect(executionReceipts(state)[0]).toMatchObject({
        run_id: RUN_A,
        status: "running",
        loop_cycle_ordinal: 1,
        loop_execution_sequence: 1,
        loop_execution_epoch: 2,
        execution_available_at: null,
      });

      const recoveredLoop = loops.loop()!;
      await resident.product.recordWorkflowFailed(
        RUN_A,
        { code: "provider_unavailable", message: "Provider remains unavailable" },
        {
          loopId: recoveredLoop.loop_id,
          executionId: RUN_A,
          executionEpoch: 2,
          leaseOwner: recovered!.execution.leaseOwner,
        },
      );
      expect(executionReceipts(state)[0]).toMatchObject({
        run_id: RUN_A,
        status: "failed",
        loop_execution_epoch: 2,
      });
      expect(loops.loop()).toMatchObject({
        status: "idle",
        cycle_ordinal: 1,
        active_execution_id: null,
      });
    });
  });

  it("preserves pending input FIFO and modes across eviction", async () => {
    const stub = await readySubstream();
    const admittedAt = Date.now();

    await runInDurableObject(stub, async (_instance, state) => {
      ensureFixtureLoop(state, admittedAt);
      await admitFixturePendingInput(state, {
        inputId: INPUT_A, text: "first", mode: "steer", now: admittedAt + 30,
      });
      await admitFixturePendingInput(state, {
        inputId: INPUT_B, text: "second", mode: "queue", now: admittedAt + 10,
      });
      await admitFixturePendingInput(state, {
        inputId: INPUT_C, text: "third", mode: "steer", now: admittedAt + 20,
      });
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);
    // Re-enter through one held event so the replacement constructor can
    // derive its alarm but the immediately-due drain cannot consume the rows
    // before this durability assertion observes them. A separate health fetch
    // opens the input gate before the read and turns this into an alarm race,
    // which tests scheduler timing rather than persisted FIFO.
    await runInDurableObject(stub, async (_instance, state) => {
      const pending = new SubstreamLoopStorage(state.storage).pendingInputs();
      expect(pending.map(({ input_id, input_sequence, mode }) => ({
        input_id, input_sequence, mode,
      }))).toEqual([
        { input_id: INPUT_A, input_sequence: 1, mode: "steer" },
        { input_id: INPUT_B, input_sequence: 2, mode: "queue" },
        { input_id: INPUT_C, input_sequence: 3, mode: "steer" },
      ]);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("claims an indexed receipt exactly once under workerd write accounting", async () => {
    const stub = await readySubstream();

    await runInDurableObject(stub, async (instance, state) => {
      seedExecutionReceipt(state, RUN_A, runInput(RUN_A), 1);
      ensureFixtureLoop(state, 1);
      const resident = instance as unknown as {
        claimPersistentLoopExecution(): Promise<unknown>;
      };

      const first = await resident.claimPersistentLoopExecution();
      const duplicate = await resident.claimPersistentLoopExecution();

      // `runs_execution_due_idx` and `runs_loop_recovery_idx` both change
      // during this transition. Workerd counts those physical index writes;
      // the product result must come from the returned receipt/loop identities,
      // never from an assumed `rowsWritten === 1` logical-row count.
      expect(first).toMatchObject({
        input: { harnessRunId: RUN_A },
        execution: { runId: RUN_A, executionEpoch: 1 },
      });
      expect(duplicate).toBeNull();
      expect(executionReceipts(state)).toHaveLength(1);
      expect(state.storage.sql.exec<{ next_execution_sequence: number }>(
        `SELECT next_execution_sequence FROM substream_loops WHERE id = 1`,
      ).one()).toEqual({ next_execution_sequence: 2 });
    });
  });
});
