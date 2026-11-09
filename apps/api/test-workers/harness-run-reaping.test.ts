/// <reference types="@cloudflare/vitest-pool-workers/types" />

/** Stale-run terminalization against workerd's real SQLite transaction. */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { WorkstreamWorkflowInputSchema, asSubstreamId } from "@rally/contracts";

import { conversationObjectName, substreamLoopId } from "../src/durable-objects/names";
import { WorkstreamHarnessRunStorage } from "../src/durable-objects/workstream-harness-run-storage";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import {
  USER_ID,
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  seedOpenWorkstreamAuthority,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

const RUN_ID = "00000000-0000-7000-8000-0000000008a1";
const LINKED_RUN_ID = "00000000-0000-7000-8000-0000000008a2";
const AGENT_CANCELLED_RUN_ID = "00000000-0000-7000-8000-0000000008a3";
const NOW = 1_787_000_000_000;

beforeEach(async () => {
  await reset();
  await seedOpenWorkstreamAuthority(env.DB);
}, 30_000);

function agent(): DurableObjectStub {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName(
      "global",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      asSubstreamId("00000000-0000-7000-8000-0000000008a0"),
    ),
  ));
}

function mainAgent(): DurableObjectStub {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
  ));
}

describe("stale-run reaping on real workerd", () => {
  it("releases the exact loop execution with a cancelled pre-claim receipt", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state, NOW);
      const runs = new WorkstreamHarnessRunStorage(state.storage);
      expect(runs.admitRun({
        runId: LINKED_RUN_ID,
        origin: "member_message",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
        status: "admitted",
        startedAt: NOW,
        model: "test/model",
        triggerPartId: null,
        parentRunId: null,
        expectedLatestRunId: null,
        now: NOW,
      })).toEqual({ outcome: "admitted" });
      state.storage.sql.exec(
        `UPDATE runs SET execution_context_json = '{"kind":"test_execution"}' WHERE run_id = ?`,
        LINKED_RUN_ID,
      );
      const loops = new SubstreamLoopStorage(state.storage);
      loops.ensureLoop({ loopId: LINKED_RUN_ID, bindStateRevision: 0, now: NOW });
      loops.activateExecutionReceipt({
        runId: LINKED_RUN_ID,
        loopId: LINKED_RUN_ID,
        executionEpoch: 1,
        leaseOwner: "loop-owner",
        leaseExpiresAt: NOW + 60_000,
        expectedLoopRevision: loops.loop()!.revision,
        expectedBindStateRevision: 0,
        now: NOW,
      });
      const terminalInput = {
        runId: LINKED_RUN_ID,
        attemptId: "attempt-cancelled-before-claim",
        status: "cancelled" as const,
        errorJson: null,
        memberSafePayloadJson: '{"code":"run_cancelled"}',
        lifecycleEventId: "queued-terminal-event",
        loopExecutionFence: {
          loopId: LINKED_RUN_ID,
          executionId: LINKED_RUN_ID,
          executionEpoch: 1,
          leaseOwner: "loop-owner",
        },
        now: NOW + 1,
      };

      expect(runs.terminalizeQueuedRun({ ...terminalInput, loopExecutionFence: null }))
        .toEqual({ outcome: "ownership_lost" });
      expect(loops.loop()).toMatchObject({ status: "executing", active_execution_id: LINKED_RUN_ID });

      expect(runs.terminalizeQueuedRun(terminalInput)).toEqual({ outcome: "terminalized" });
      expect(runs.run({ runId: LINKED_RUN_ID })).toMatchObject({
        status: "cancelled",
        terminalized_at: NOW + 1,
      });
      expect(loops.loop()).toMatchObject({
        status: "idle",
        active_execution_id: null,
        lease_owner: null,
      });
    });
  });

  it("forwards the active loop fence when the agent observes cancellation before claim", async () => {
    const stub = mainAgent();
    await boot(stub);
    const loopId = substreamLoopId(WORKSTREAM_ID);
    const workflowInput = WorkstreamWorkflowInputSchema.parse({
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "canvas",
      parentId: WORKSTREAM_ID,
      substreamId: "0",
      loopId,
      harnessRunId: AGENT_CANCELLED_RUN_ID,
      triggerMessageId: null,
      activityId: null,
      executionPrincipal: { type: "user", userId: USER_ID },
      reason: "user_message",
    });

    await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state, NOW);
      const runs = new WorkstreamHarnessRunStorage(state.storage);
      expect(runs.admitRun({
        runId: AGENT_CANCELLED_RUN_ID,
        origin: "member_message",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
        status: "admitted",
        startedAt: NOW,
        model: "test/model",
        triggerPartId: null,
        parentRunId: null,
        expectedLatestRunId: null,
        now: NOW,
      })).toEqual({ outcome: "admitted" });
      state.storage.sql.exec(
        `UPDATE runs
            SET execution_context_json = ?, cancellation_requested_at = ?,
                cancellation_reason = 'member_stop'
          WHERE run_id = ?`,
        JSON.stringify(workflowInput),
        NOW + 1,
        AGENT_CANCELLED_RUN_ID,
      );
      const loops = new SubstreamLoopStorage(state.storage);
      loops.ensureLoop({ loopId, bindStateRevision: 0, now: NOW });
      expect(loops.activateExecutionReceipt({
        runId: AGENT_CANCELLED_RUN_ID,
        loopId,
        executionEpoch: 1,
        leaseOwner: "loop-owner",
        leaseExpiresAt: Date.now() + 60_000,
        expectedLoopRevision: loops.loop()!.revision,
        expectedBindStateRevision: 0,
        now: NOW,
      }).outcome).toBe("activated");

      const resident = instance as unknown as {
        activeLoopExecution: {
          runId: string;
          executionEpoch: number;
          leaseOwner: string;
        } | null;
        runAgentExecution(input: typeof workflowInput): Promise<{
          status: string;
          errorCode: string | null;
          retryAt: number | null;
        }>;
        resumeExternalSettlementDrain(): void;
      };
      // External metadata delivery is a separate authority and not part of
      // this fence-forwarding proof; the minimal fixture has no WorkspaceDO.
      resident.resumeExternalSettlementDrain = () => undefined;
      resident.activeLoopExecution = {
        runId: AGENT_CANCELLED_RUN_ID,
        executionEpoch: 1,
        leaseOwner: "loop-owner",
      };

      await expect(resident.runAgentExecution(workflowInput)).resolves.toMatchObject({
        status: "stopped",
        errorCode: "run_cancelled",
        retryAt: null,
      });
      expect(runs.run({ runId: AGENT_CANCELLED_RUN_ID })).toMatchObject({
        status: "cancelled",
        terminalized_at: expect.any(Number),
      });
      expect(loops.loop()).toMatchObject({
        status: "idle",
        active_execution_id: null,
        lease_owner: null,
      });
    });
  });

  it("rolls activity and checkpoint cleanup back when terminalization aborts", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state, NOW);
      const runs = new WorkstreamHarnessRunStorage(state.storage);
      expect(runs.admitRun({
        runId: RUN_ID,
        origin: "member_message",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
        status: "admitted",
        startedAt: NOW,
        model: "test/model",
        triggerPartId: null,
        parentRunId: null,
        expectedLatestRunId: null,
        now: NOW,
      })).toEqual({ outcome: "admitted" });
      expect(runs.claimAttempt({
        runId: RUN_ID,
        attemptId: "attempt-1",
        owner: "owner-1",
        leaseSeconds: 60,
        lifecycleEventId: "claim-event",
        now: NOW,
      }).outcome).toBe("claimed");
      state.storage.sql.exec(
        `INSERT INTO transcript_activities
           (activity_id, parent_activity_id, scope, subject_id, call_index, label,
            lifecycle_state, revision, created_at, updated_at)
         VALUES (?, NULL, 'response', ?, NULL, 'Working', 'active', 1, ?, ?)`,
        `${RUN_ID}:activity`,
        RUN_ID,
        NOW,
        NOW,
      );
      state.storage.sql.exec(
        `INSERT INTO transcript_activity_intervals
           (activity_id, interval_id, started_at, stopped_at, duration_ms,
            boundary_source, timing_accuracy, revision)
         VALUES (?, ?, ?, NULL, NULL, 'rally', 'observed', 1)`,
        `${RUN_ID}:activity`,
        `${RUN_ID}:activity:1`,
        NOW,
      );
      state.storage.sql.exec(
        `INSERT INTO active_output_turns
           (run_id, attempt_epoch, turn_id, transcript_sequence, substream_id, status,
            durable_event_seq, durable_through_frame_seq, next_chunk_index, stream_id,
            seen_turn_ids_json, turn_start_offset, started_at, checkpointed_at, updated_at)
         VALUES (?, 1, 'turn-1', 1, '0', 'streaming', 1, 1, 1, ?, '[]', 0, ?, ?, ?)`,
        RUN_ID,
        RUN_ID,
        NOW,
        NOW,
        NOW,
      );
      runs.recordLifecycleEvent({
        eventId: "terminal-event",
        runId: RUN_ID,
        attemptId: "attempt-1",
        eventKey: "collision-seed",
        eventType: "test",
        status: "running",
        memberSafePayloadJson: "{}",
        now: NOW,
      });

      expect(() => runs.reapStaleRoot({
        runId: RUN_ID,
        attemptId: "attempt-1",
        leaseExpiresAt: NOW + 60_000,
        lifecycleEventId: "terminal-event",
        now: NOW + 60_001,
      })).toThrow();

      expect(state.storage.sql.exec(
        `SELECT lifecycle_state, revision FROM transcript_activities WHERE activity_id = ?`,
        `${RUN_ID}:activity`,
      ).one()).toEqual({ lifecycle_state: "active", revision: 1 });
      expect(state.storage.sql.exec(
        `SELECT stopped_at, duration_ms, revision
           FROM transcript_activity_intervals WHERE activity_id = ?`,
        `${RUN_ID}:activity`,
      ).one()).toEqual({ stopped_at: null, duration_ms: null, revision: 1 });
      expect(state.storage.sql.exec(
        `SELECT status FROM active_output_turns WHERE run_id = ?`,
        RUN_ID,
      ).one()).toEqual({ status: "streaming" });
      expect(state.storage.sql.exec(
        `SELECT status, terminalized_at, lease_expires_at FROM runs WHERE run_id = ?`,
        RUN_ID,
      ).one()).toEqual({
        status: "running",
        terminalized_at: null,
        lease_expires_at: NOW + 60_000,
      });
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM run_lifecycle_events
          WHERE run_id = ? AND event_key = 'terminal'`,
        RUN_ID,
      ).one()).toEqual({ count: 0 });
    });
  });
});
