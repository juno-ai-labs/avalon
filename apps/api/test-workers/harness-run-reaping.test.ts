/// <reference types="@cloudflare/vitest-pool-workers/types" />

/** Stale-run terminalization against workerd's real SQLite transaction. */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import { WorkstreamHarnessRunStorage } from "../src/durable-objects/workstream-harness-run-storage";
import {
  USER_ID,
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  seedOpenWorkstreamAuthority,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

const RUN_ID = "00000000-0000-7000-8000-0000000008a1";
const NOW = 1_787_000_000_000;

beforeEach(async () => {
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

describe("stale-run reaping on real workerd", () => {
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
