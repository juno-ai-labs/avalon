/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  WorkstreamWorkflowInputSchema,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import { bindLoopNonSystemMessages } from "@rally/agent-harness";

import type { Env } from "../src/env";
import { substreamAgentName, substreamLoopId } from "../src/durable-objects/names";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { WorkstreamHarnessRunStorage } from "../src/durable-objects/workstream-harness-run-storage";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { createTestEnv } from "../test/helpers/cloudflare-test";
import { seedWorkstreamRoot } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000701");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000702");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000704");
const LOOP_ID = substreamLoopId(WORKSTREAM_ID);

interface TranscriptOperationExecutor {
  executeTranscriptOperation(input: unknown): Promise<{ status: number; bodyJson: string }>;
}

beforeEach(async () => reset());

describe("work-stream transcript on workerd SQLite", () => {
  it("keeps participant appends off the internal transcript RPC boundary", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const retiredRequest = {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "appendParticipantMessage",
      args: [{
        turnId: "forbidden-human",
        actor: "human",
        authorUserId: "user-1",
        authorSnapshot: { displayName: "User", avatarUrl: null },
        text: "Must use the authenticated product path",
        createdAtUtc: new Date().toISOString(),
        attentionOrdinal: 1,
      }],
    };
    const result = await runInDurableObject(stub, (instance) =>
      (instance as TranscriptOperationExecutor).executeTranscriptOperation(retiredRequest));

    expect(result.status).toBe(400);
    expect(JSON.parse(result.bodyJson)).toMatchObject({ error: "invalid_transcript_operation" });
  });

  it("commits exact projections and repairs an interrupted tool batch before later input", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const receiptRunId = "00000000-0000-7000-8000-000000000703";
    const attemptId = "workerd-test-attempt";
    const attemptOwner = "workerd-test-attempt-owner";
    const now = Date.now();
    const workflowInput = WorkstreamWorkflowInputSchema.parse({
      region: "global",
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      substreamId: "0",
      loopId: LOOP_ID,
      harnessRunId: receiptRunId,
      triggerMessageId: null,
      automationSubscriptionId: null,
      activityId: null,
      executionPrincipal: { type: "user", userId: USER_ID },
      reason: "user_message",
    });
    const snapshot = await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      await transcript.commitBindTransition({
        kind: "state_initialized",
        loopId: LOOP_ID,
        generation: 1,
        stateRevision: 1,
        systemProjection: {
          revision: 1,
          rendererVersion: "workstream-system-v1",
          inputHash: "system-input",
          message: { role: "system", content: "System" },
        },
        nonSystemMessages: [{ role: "user", content: "Question" }],
        nonSystemMessageOrigins: [{
          originKind: "derived",
          sourceKind: "participant_turn",
          sourceId: "message-1",
          sourceRevision: 1,
        }],
      });
      const runs = new WorkstreamHarnessRunStorage(state.storage);
      expect(runs.admitRun({
        runId: receiptRunId,
        origin: "member_message",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
        status: "running",
        startedAt: now,
        model: "test/model",
        triggerPartId: null,
        parentRunId: null,
        expectedLatestRunId: null,
        now,
      })).toEqual({ outcome: "admitted" });
      state.storage.sql.exec(
        `UPDATE runs SET execution_context_json = ? WHERE run_id = ?`,
        JSON.stringify(workflowInput),
        receiptRunId,
      );
      const loop = new SubstreamLoopStorage(state.storage);
      loop.ensureLoop({ loopId: LOOP_ID, bindStateRevision: 1, now });
      const activated = loop.activateExecutionReceipt({
        runId: receiptRunId,
        loopId: LOOP_ID,
        executionEpoch: 1,
        leaseOwner: "workerd-test-owner",
        leaseExpiresAt: now + 60_000,
        expectedLoopRevision: loop.loop()!.revision,
        expectedBindStateRevision: 1,
        now,
      });
      expect(activated.outcome).toBe("activated");
      expect(runs.claimAttempt({
        runId: receiptRunId,
        attemptId,
        owner: attemptOwner,
        leaseSeconds: 60,
        lifecycleEventId: "workerd-test-attempt-claimed",
        now,
      })).toMatchObject({ outcome: "claimed" });
      const reservation = loop.reserveAssistantTurn({
        executionId: receiptRunId,
        executionEpoch: 1,
        leaseOwner: "workerd-test-owner",
        expectedLoopRevision: loop.loop()!.revision,
        receiptRunId,
        turnId: `${LOOP_ID}:turn:1`,
        modelTurnIndex: 1,
        streamId: "workerd-test-stream",
        now,
      });
      expect(reservation.outcome).toBe("reserved");
      await transcript.commitBindTransition({
        kind: "assistant_reserved",
        loopId: LOOP_ID,
        generation: 1,
        stateRevision: 2,
        turnId: `${LOOP_ID}:turn:1`,
        modelTurnIndex: 1,
        transcriptSequence: reservation.reservation.transcript_sequence,
      }, now, {
        executionId: receiptRunId,
        executionEpoch: 1,
        leaseOwner: "workerd-test-owner",
        expectedBindStateRevision: 1,
      });
      await transcript.commitBindTransition({
        kind: "assistant_accepted",
        loopId: LOOP_ID,
        generation: 1,
        stateRevision: 3,
        turnId: `${LOOP_ID}:turn:1`,
        modelTurnIndex: 1,
        transcriptSequence: reservation.reservation.transcript_sequence,
        message: {
          role: "assistant",
          content: "Before",
          tool_calls: [{
            id: "provider-call",
            type: "function",
            function: { name: "search", arguments: "{}" },
          }],
        },
      }, now + 1, {
        executionId: receiptRunId,
        executionEpoch: 1,
        leaseOwner: "workerd-test-owner",
        expectedBindStateRevision: 2,
      });

      const openingSnapshot = transcript.createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null });
      expect(openingSnapshot.ranges[0]!.turns[0]!.blocks.map((block) => block.type))
        .toEqual(["text", "tool"]);
      const projection = transcript.readBindProjection(LOOP_ID);
      expect(projection && bindLoopNonSystemMessages(projection).map((message) => message.role))
        .toEqual(["user", "assistant"]);
      expect(state.storage.sql.exec<{
        origin_kind: string;
        source_kind: string | null;
        source_id: string | null;
      } & Record<string, SqlStorageValue>>(
        `SELECT fact.origin_kind, fact.source_kind, fact.source_id
           FROM bind_loop_state_messages projected
          JOIN transcript_facts fact ON fact.fact_id = projected.fact_id
          WHERE projected.loop_id = ?
            AND projected.message_position = 1`,
        LOOP_ID,
      ).one()).toMatchObject({
        origin_kind: "derived",
        source_kind: "participant_turn",
        source_id: "message-1",
      });
      return openingSnapshot;
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const transcript = new WorkstreamTranscriptStorage(state.storage);

      // Model bytes and the assistant tool batch are durable, but a provider
      // request is not. Drive the replacement host's recovery method inside a
      // real workerd object: a missing receipt proves this call never started,
      // so an explicit terminal tool result must land before any later provider
      // boundary can be crossed.
      const resident = instance as unknown as {
        activeLoopExecution: {
          runId: string;
          leaseOwner: string;
          executionEpoch: number;
        } | null;
        recoverInterruptedToolBatch(
          executionEnv: Env,
          input: WorkstreamWorkflowInput,
          lease: { attemptId: string; owner: string },
        ): Promise<"recovered" | "ambiguous" | "waiting_for_input" | null>;
        claimPersistentLoopExecution(): Promise<{
          input: WorkstreamWorkflowInput;
          execution: { runId: string; leaseOwner: string; executionEpoch: number };
        } | null>;
      };
      const replacementClaim = await resident.claimPersistentLoopExecution();
      expect(replacementClaim).toMatchObject({
        input: { harnessRunId: receiptRunId, loopId: LOOP_ID },
        execution: { runId: receiptRunId, executionEpoch: 2 },
      });
      if (!replacementClaim) throw new Error("replacement_loop_claim_missing");
      resident.activeLoopExecution = replacementClaim.execution;
      await expect(resident.recoverInterruptedToolBatch(
        createTestEnv({ PAYLOADS: env.PAYLOADS }),
        replacementClaim.input,
        { attemptId, owner: attemptOwner },
      )).resolves.toBe("recovered");
      expect(bindLoopNonSystemMessages(transcript.readBindProjection(LOOP_ID)!)
        .map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
      expect(bindLoopNonSystemMessages(transcript.readBindProjection(LOOP_ID)!).at(-1))
        .toMatchObject({ role: "tool", tool_call_id: "provider-call" });
      expect(transcript.participantTurn(`${LOOP_ID}:turn:1`)!.blocks)
        .toEqual(expect.arrayContaining([expect.objectContaining({
          type: "tool",
          toolCallId: `${LOOP_ID}:turn:1:tool:0`,
          status: "failed",
          error: "Rally did not run this tool after recovering the interrupted turn",
        })]));

      await transcript.appendParticipantMessage({
        turnId: "after-fence",
        actor: "human",
        authorUserId: "user-1",
        authorSnapshot: { displayName: "Test user", avatarUrl: null },
        text: "After",
        createdAtUtc: new Date().toISOString(),
        attentionOrdinal: 1,
      });
      expect(transcript.range(snapshot, { startInclusive: 1, endExclusive: 10 }).covered)
        .toEqual({ startInclusive: 1, endExclusive: 2 });
    });
  });

  it("preserves two canonical compaction replacements and both completed edges", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      const systemProjection = {
        revision: 1,
        rendererVersion: "workstream-system-v1",
        inputHash: "system-input",
        message: { role: "system" as const, content: "System" },
      };
      await transcript.commitBindTransition({
        kind: "state_initialized",
        loopId: LOOP_ID,
        generation: 1,
        stateRevision: 1,
        systemProjection,
        nonSystemMessages: [{ role: "user", content: "Question" }],
        nonSystemMessageOrigins: [{
          originKind: "derived",
          sourceKind: "participant_turn",
          sourceId: "question",
          sourceRevision: 1,
        }],
      });
      for (let index = 1; index <= 2; index += 1) {
        const current = transcript.readBindProjection(LOOP_ID)!;
        const eventId = `double-compaction:compaction:${index}`;
        await transcript.reserveCompactionStatus({
          compactionEventId: eventId,
          runId: LOOP_ID,
          trigger: "auto",
          occurredAtUtc: new Date(1_000 + index * 10).toISOString(),
        });
        transcript.upsertActivity({
          activityId: eventId,
          parentActivityId: null,
          scope: "compaction",
          subjectId: String(index),
          callIndex: index - 1,
          label: "Context automatically compacting",
          action: "start",
          revision: 1,
          occurredAtUtc: new Date(1_000 + index * 10).toISOString(),
        });
        if (index === 2) {
          const midCompactionOpen = transcript.createOpeningSnapshot({
            unreadHighWaterAttentionOrdinal: null,
            now: 1_005 + index * 10,
          });
          expect(midCompactionOpen.ranges.flatMap((range) => range.turns)).toContainEqual(
            expect.objectContaining({ turnId: eventId, entryKind: "status" }),
          );
          expect(midCompactionOpen.activeActivities).toContainEqual(expect.objectContaining({
            activityId: eventId,
            state: "active",
            intervals: [expect.objectContaining({ elapsedMsAtSnapshot: 5 })],
          }));
        }
        await transcript.commitBindCompaction({
          commit: {
            checkpoint: {
              trigger: "auto",
              summary: `Summary ${index}`,
              messages: [{ role: "user", content: `Summary ${index}` }],
              model: "openai/test",
              contextTokensBeforeCompaction: 90,
              contextWindowTokens: 100,
              inputTokens: 10,
              outputTokens: 2,
              costCents: 0.01,
            },
            transition: {
              kind: "state_replaced",
              loopId: LOOP_ID,
              generation: current.generation,
              nextGeneration: current.generation + 1,
              stateRevision: current.stateRevision + 1,
              systemProjection,
              nonSystemMessages: [{ role: "user", content: `Summary ${index}` }],
              compactionEventId: eventId,
            },
          },
          continuation: {
            executionPrincipalKey: "user:user-1",
            resourceVisibilityFingerprint: "inventory:0",
            checkpointTemplateVersion: 1,
            compactedThroughSequence: index,
            expectedInventoryRevision: 0,
          },
          now: 1_005 + index * 10,
        });
      }
      const projection = transcript.readBindProjection(LOOP_ID);
      expect(projection).toMatchObject({ generation: 3 });
      expect(bindLoopNonSystemMessages(projection!)).toEqual([
        { role: "user", content: "Summary 2" },
      ]);
      expect(transcript.createOpeningSnapshot({
        unreadHighWaterAttentionOrdinal: null,
        now: 2_000,
      }).activities.filter((activity) => activity.scope === "compaction")).toEqual([
        expect.objectContaining({ activityId: "double-compaction:compaction:1", state: "completed" }),
        expect.objectContaining({ activityId: "double-compaction:compaction:2", state: "completed" }),
      ]);
    });
  });
});
