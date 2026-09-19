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
import { conversationObjectName, substreamLoopId } from "../src/durable-objects/names";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { WorkstreamHarnessRunStorage } from "../src/durable-objects/workstream-harness-run-storage";
import { WorkstreamToolReceiptStorage } from "../src/durable-objects/workstream-tool-receipt-storage";
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
  it("keeps transaction-local transcript mutations off the internal RPC boundary", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
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

    const bindResult = await runInDurableObject(stub, (instance) =>
      (instance as TranscriptOperationExecutor).executeTranscriptOperation({
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        operation: "commitBindTransition",
        args: [],
      }));
    expect(bindResult.status).toBe(400);
    expect(JSON.parse(bindResult.bodyJson)).toMatchObject({ error: "invalid_transcript_operation" });
  });

  it("commits exact projections and authoritative assistant mentions before repairing an interrupted tool batch", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const receiptRunId = "00000000-0000-7000-8000-000000000703";
    const attemptId = "workerd-test-attempt";
    const attemptOwner = "workerd-test-attempt-owner";
    const now = Date.now();
    const workflowInput = WorkstreamWorkflowInputSchema.parse({
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      substreamId: "0",
      loopId: LOOP_ID,
      harnessRunId: receiptRunId,
      triggerMessageId: null,
      activityId: null,
      executionPrincipal: { type: "user", userId: USER_ID },
      reason: "user_message",
    });
    const snapshot = await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      state.storage.sql.exec(
        `INSERT INTO participants
           (user_id, participation_reason, added_by_user_id, status, participant_epoch,
            added_at, removed_at, first_opened_at, updated_at)
         VALUES (?, 'explicit', ?, 'active', 0, ?, NULL, NULL, ?)`,
        USER_ID,
        USER_ID,
        now,
        now,
      );
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
      let deliveredUserIds: readonly string[] | undefined;
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
          content: `Before [@Member](person://${USER_ID})`,
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
      }, (effects) => {
        deliveredUserIds = effects[0]?.mentionedUserIds;
      });
      expect(deliveredUserIds).toEqual([USER_ID]);

      const openingSnapshot = transcript.createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null });
      expect(openingSnapshot.ranges[0]!.turns[0]!.blocks.map((block) => block.type))
        .toEqual(["text", "tool"]);
      expect(openingSnapshot.ranges[0]!.turns[0]!.attentionOrdinal).toBe(1);
      expect(openingSnapshot.ranges[0]!.turns[0]!.blocks[0]).toMatchObject({
        mentions: [expect.objectContaining({ type: "person", userId: USER_ID })],
      });
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

  it("keeps an interrupted assistant reservation recoverable after eviction", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const receiptRunId = "00000000-0000-7000-8000-000000000705";
    const now = Date.now();
    const workflowInput = WorkstreamWorkflowInputSchema.parse({
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      substreamId: "0",
      loopId: LOOP_ID,
      harnessRunId: receiptRunId,
      triggerMessageId: null,
      activityId: null,
      executionPrincipal: { type: "user", userId: USER_ID },
      reason: "user_message",
    });
    const reservedTurnId = `${LOOP_ID}:turn:1`;

    await runInDurableObject(stub, async (_instance, state) => {
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
      expect(loop.activateExecutionReceipt({
        runId: receiptRunId,
        loopId: LOOP_ID,
        executionEpoch: 1,
        leaseOwner: "owner-that-will-be-evicted",
        leaseExpiresAt: now + 60_000,
        expectedLoopRevision: loop.loop()!.revision,
        expectedBindStateRevision: 1,
        now,
      }).outcome).toBe("activated");
      expect(runs.claimAttempt({
        runId: receiptRunId,
        attemptId: "attempt-that-will-be-evicted",
        owner: "attempt-owner-that-will-be-evicted",
        leaseSeconds: 60,
        lifecycleEventId: "interrupted-assistant-attempt",
        now,
      }).outcome).toBe("claimed");
      const reservation = loop.reserveAssistantTurn({
        executionId: receiptRunId,
        executionEpoch: 1,
        leaseOwner: "owner-that-will-be-evicted",
        expectedLoopRevision: loop.loop()!.revision,
        receiptRunId,
        turnId: reservedTurnId,
        modelTurnIndex: 1,
        streamId: "interrupted-stream",
        now,
      });
      expect(reservation.outcome).toBe("reserved");
      await transcript.commitBindTransition({
        kind: "assistant_reserved",
        loopId: LOOP_ID,
        generation: 1,
        stateRevision: 2,
        turnId: reservedTurnId,
        modelTurnIndex: 1,
        transcriptSequence: reservation.reservation.transcript_sequence,
      }, now, {
        executionId: receiptRunId,
        executionEpoch: 1,
        leaseOwner: "owner-that-will-be-evicted",
        expectedBindStateRevision: 1,
      });
      expect(loop.startAssistantTurn({
        executionId: receiptRunId,
        executionEpoch: 1,
        leaseOwner: "owner-that-will-be-evicted",
        expectedLoopRevision: loop.loop()!.revision,
        turnId: reservedTurnId,
        now,
      })).toBe("started");
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      const resident = instance as unknown as {
        activeLoopExecution: {
          runId: string;
          leaseOwner: string;
          executionEpoch: number;
        } | null;
        claimPersistentLoopExecution(): Promise<{
          input: WorkstreamWorkflowInput;
          execution: { runId: string; leaseOwner: string; executionEpoch: number };
        } | null>;
        settleInterruptedAssistantReservation(
          input: WorkstreamWorkflowInput,
        ): Promise<"retry" | "stopped" | null>;
      };
      const replacementClaim = await resident.claimPersistentLoopExecution();
      expect(replacementClaim).toMatchObject({
        input: { harnessRunId: receiptRunId },
        execution: { runId: receiptRunId, executionEpoch: 2 },
      });
      if (!replacementClaim) throw new Error("replacement_loop_claim_missing");
      resident.activeLoopExecution = replacementClaim.execution;

      await expect(resident.settleInterruptedAssistantReservation(replacementClaim.input))
        .resolves.toBe("retry");

      const transcript = new WorkstreamTranscriptStorage(state.storage);
      expect(new SubstreamLoopStorage(state.storage).loop()).toMatchObject({
        status: "executing",
        active_execution_id: receiptRunId,
        active_execution_epoch: 2,
      });
      expect(new SubstreamLoopStorage(state.storage)
        .assistantTurnCountForExecution(receiptRunId)).toBe(1);
      expect(new SubstreamLoopStorage(state.storage)
        .assistantTurnCountForExecution("another-execution")).toBe(0);
      expect(transcript.readBindProjection(LOOP_ID)?.lastAssistantReservation).toMatchObject({
        turnId: reservedTurnId,
        modelTurnIndex: 1,
        status: "failed",
      });
      expect(transcript.participantTurn(reservedTurnId)).toMatchObject({
        actor: "system",
        blocks: [expect.objectContaining({
          type: "text",
          text: "Response interrupted before it completed",
        })],
      });
    });
  });

  it("reports plugin runs for a turn whose blocks carry no activity id", async () => {
    // The shape that rendered "Rally worked for 0ms" in production. The
    // snapshot's activity walk seeds from `turn.activity_id` and
    // `block.activity_id` and recurses upward to parents; both columns are
    // nullable, and a development-seeded tool turn leaves both NULL. The plugin
    // and tool-call activities are therefore unreachable from that walk even
    // though they exist and are timed, and a client rebuilding the row from
    // `activities` had no timing to show and no way to say so.
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      const turnId = "run-one:turn:1";
      await transcript.seedDevelopmentConversationTurn({
        turnId,
        clientMessageId: null,
        actor: "assistant",
        authorUserId: null,
        authorSnapshot: null,
        externalActorJson: null,
        messageType: "tool",
        text: "",
        structuredContentJson: JSON.stringify({
          invocation: { toolCallId: "call-0", toolName: "memory_search", status: "completed" },
        }),
        producedByRunId: null,
        expectedTranscriptSequence: 1,
        createdAtUtc: new Date(1_000).toISOString(),
      });
      transcript.upsertActivity({
        activityId: `${turnId}:activity`,
        parentActivityId: null,
        scope: "assistant_turn",
        subjectId: turnId,
        callIndex: 0,
        label: "Assistant turn",
        action: "start",
        revision: 1,
        occurredAtUtc: new Date(1_000).toISOString(),
      });
      transcript.upsertActivity({
        activityId: `${turnId}:plugin:rally:memory`,
        parentActivityId: `${turnId}:activity`,
        scope: "plugin",
        subjectId: "rally:memory",
        callIndex: 0,
        label: "rally:memory",
        action: "start",
        revision: 1,
        occurredAtUtc: new Date(1_000).toISOString(),
      });
      transcript.upsertActivity({
        activityId: "call-0:activity",
        parentActivityId: `${turnId}:plugin:rally:memory`,
        scope: "tool_call",
        subjectId: "call-0",
        callIndex: 0,
        label: "memory_search",
        action: "start",
        revision: 1,
        occurredAtUtc: new Date(1_000).toISOString(),
      });
      // Everything settles: an activity still running would seed the opening
      // snapshot's `includeActive` clause and be reachable that way, which is
      // not the state a finished run two days old is read in.
      transcript.upsertActivity({
        activityId: "call-0:activity",
        parentActivityId: `${turnId}:plugin:rally:memory`,
        scope: "tool_call",
        subjectId: "call-0",
        callIndex: 0,
        label: "memory_search",
        action: "complete",
        revision: 2,
        occurredAtUtc: new Date(7_770).toISOString(),
      });
      transcript.upsertActivity({
        activityId: `${turnId}:plugin:rally:memory`,
        parentActivityId: `${turnId}:activity`,
        scope: "plugin",
        subjectId: "rally:memory",
        callIndex: 0,
        label: "rally:memory",
        action: "complete",
        revision: 2,
        occurredAtUtc: new Date(7_770).toISOString(),
      });
      transcript.upsertActivity({
        activityId: `${turnId}:activity`,
        parentActivityId: null,
        scope: "assistant_turn",
        subjectId: turnId,
        callIndex: 0,
        label: "Assistant turn",
        action: "complete",
        revision: 2,
        occurredAtUtc: new Date(7_770).toISOString(),
      });

      const snapshot = transcript.createOpeningSnapshot({
        unreadHighWaterAttentionOrdinal: null,
        now: 9_000,
      });

      // The old surface cannot see it: nothing seeds the walk that would reach
      // a plugin activity, so this is the state the client used to render from.
      expect(snapshot.activities.map((activity) => activity.activityId))
        .not.toContain(`${turnId}:plugin:rally:memory`);
      // The new one states it outright, with the duration actually measured.
      expect(snapshot.pluginRuns).toEqual([expect.objectContaining({
        pluginRunId: `${turnId}:plugin:rally:memory`,
        turnId,
        pluginId: "rally:memory",
        displayName: "rally:memory",
        state: "completed",
        durationMs: 6_770,
        toolCallIds: ["call-0"],
      })]);

      // A range loaded later covers turns the opening snapshot never did, so it
      // has to carry their runs too: the client cannot re-derive them from the
      // activities a range ships for exactly the reason above.
      const range = transcript.range(snapshot, { startInclusive: 1, endExclusive: 2 });
      expect(range.pluginRuns).toEqual([expect.objectContaining({
        pluginRunId: `${turnId}:plugin:rally:memory`,
        turnId,
        durationMs: 6_770,
      })]);
    });
  });

  it("preserves two canonical compaction replacements and both completed edges", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
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

  /**
   * The wedge of 2026-09-19, at the two places that produced and prolonged it.
   *
   * A run failed between accepting an assistant tool batch and accepting its
   * results. `recordWorkflowFailed` released the loop to `idle` anyway — it
   * checked only for an unmaterialized assistant turn, while the sibling
   * release in `WorkstreamHarnessRunStorage` had always checked for the batch
   * too. From `idle` the batch can never be settled: the repair needs a live
   * execution, and the only route to one is admitting a pending input, which
   * `applyBindLoopTransition` refuses while the last assistant step is
   * unsettled. The queue then still looked like work, so the object re-armed at
   * `now` and re-entered as fast as it could return — about six
   * `substream_loop_drain_failed` a second for a day.
   */
  describe("a run that fails holding an unsettled tool batch", () => {
    const RUN_ID = "00000000-0000-7000-8000-000000000801";
    const OWNER = "wedge-test-owner";
    const ATTEMPT_ID = "wedge-test-attempt";

    /**
     * Drive a real object to the exact shape: an accepted assistant turn with
     * one tool call and no result, under a live execution.
     */
    async function wedgeLoop(
      stub: DurableObjectStub,
      options: { toolCalls?: boolean } = {},
    ): Promise<void> {
      const withToolCalls = options.toolCalls !== false;
      const now = Date.now();
      const workflowInput = WorkstreamWorkflowInputSchema.parse({
        region: "global",
        workspaceId: WORKSPACE_ID,
        parentKind: "workstream",
        parentId: WORKSTREAM_ID,
        substreamId: "0",
        loopId: LOOP_ID,
        harnessRunId: RUN_ID,
        triggerMessageId: null,
        activityId: null,
        executionPrincipal: { type: "user", userId: USER_ID },
        reason: "user_message",
      });
      await runInDurableObject(stub, async (_instance, state) => {
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
        runs.admitRun({
          runId: RUN_ID,
          origin: "member_message",
          executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
          status: "running",
          startedAt: now,
          model: "test/model",
          triggerPartId: null,
          parentRunId: null,
          expectedLatestRunId: null,
          now,
        });
        state.storage.sql.exec(
          `UPDATE runs SET execution_context_json = ? WHERE run_id = ?`,
          JSON.stringify(workflowInput),
          RUN_ID,
        );
        const loop = new SubstreamLoopStorage(state.storage);
        loop.ensureLoop({ loopId: LOOP_ID, bindStateRevision: 1, now });
        loop.activateExecutionReceipt({
          runId: RUN_ID,
          loopId: LOOP_ID,
          executionEpoch: 1,
          leaseOwner: OWNER,
          leaseExpiresAt: now + 60_000,
          expectedLoopRevision: loop.loop()!.revision,
          expectedBindStateRevision: 1,
          now,
        });
        // A real run holds an attempt, and the residual receipt sweep selects
        // on it: a fixture without one is not a run this code ever sees.
        runs.claimAttempt({
          runId: RUN_ID,
          attemptId: ATTEMPT_ID,
          owner: `${OWNER}:attempt`,
          leaseSeconds: 60,
          lifecycleEventId: "wedge-test-attempt-claimed",
          now,
        });
        const reservation = loop.reserveAssistantTurn({
          executionId: RUN_ID,
          executionEpoch: 1,
          leaseOwner: OWNER,
          expectedLoopRevision: loop.loop()!.revision,
          receiptRunId: RUN_ID,
          turnId: `${LOOP_ID}:turn:1`,
          modelTurnIndex: 1,
          streamId: "wedge-test-stream",
          now,
        });
        await transcript.commitBindTransition({
          kind: "assistant_reserved",
          loopId: LOOP_ID,
          generation: 1,
          stateRevision: 2,
          turnId: `${LOOP_ID}:turn:1`,
          modelTurnIndex: 1,
          transcriptSequence: reservation.reservation.transcript_sequence,
        }, now, {
          executionId: RUN_ID,
          executionEpoch: 1,
          leaseOwner: OWNER,
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
            content: "Looking that up",
            ...(withToolCalls
              ? {
                  tool_calls: [{
                    id: "provider-call",
                    type: "function",
                    function: { name: "search", arguments: "{}" },
                  }],
                }
              : {}),
          },
        }, now + 1, {
          executionId: RUN_ID,
          executionEpoch: 1,
          leaseOwner: OWNER,
          expectedBindStateRevision: 2,
        });
        // The state under test, stated rather than assumed.
        expect(transcript.unsettledToolBatchBlockingRelease(LOOP_ID)).toEqual(
          withToolCalls
            ? expect.objectContaining({
                turnId: `${LOOP_ID}:turn:1`,
                calls: [expect.objectContaining({ providerToolCallId: "provider-call" })],
              })
            : null,
        );
      });
    }

    it("keeps the loop executing so the lease expiry can hand the batch to the repair", async () => {
      const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
      ));
      await wedgeLoop(stub);

      await runInDurableObject(stub, async (instance, state) => {
        const product = (instance as unknown as {
          product: {
            recordWorkflowFailed(
              runId: string,
              error: { code: string; message: string },
              execution: {
                loopId: string;
                executionId: string;
                executionEpoch: number;
                leaseOwner: string;
              },
            ): Promise<void>;
          };
        }).product;

        await expect(product.recordWorkflowFailed(
          RUN_ID,
          { code: "agent_loop_failed", message: "Rally could not complete this execution" },
          { loopId: LOOP_ID, executionId: RUN_ID, executionEpoch: 1, leaseOwner: OWNER },
        )).rejects.toThrow("substream_loop_has_unsettled_tool_batch");

        // Both halves of the refusal matter. The loop keeps its execution, so
        // the lease can expire into `claimPersistentLoopExecution`'s recovery
        // branch; and the run stays un-terminalized, which is the only state in
        // which `recoverInterruptedToolBatch` can settle its tool receipts.
        const loop = new SubstreamLoopStorage(state.storage).loop()!;
        expect(loop).toMatchObject({
          status: "executing",
          active_execution_id: RUN_ID,
          lease_owner: OWNER,
        });
        expect(state.storage.sql.exec<{
          status: string;
          terminalized_at: number | null;
        } & Record<string, SqlStorageValue>>(
          `SELECT status, terminalized_at FROM runs WHERE run_id = ?`,
          RUN_ID,
        ).one()).toMatchObject({ status: "running", terminalized_at: null });
      });
    });

    it("settles the batch as it fails, so the loop releases without waiting out the lease", async () => {
      const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
      ));
      await wedgeLoop(stub);

      const workflowInput = WorkstreamWorkflowInputSchema.parse({
        region: "global",
        workspaceId: WORKSPACE_ID,
        parentKind: "workstream",
        parentId: WORKSTREAM_ID,
        substreamId: "0",
        loopId: LOOP_ID,
        harnessRunId: RUN_ID,
        triggerMessageId: null,
        activityId: null,
        executionPrincipal: { type: "user", userId: USER_ID },
        reason: "user_message",
      });

      await runInDurableObject(stub, async (instance, state) => {
        const transcript = new WorkstreamTranscriptStorage(state.storage);
        const resident = instance as unknown as {
          activeLoopExecution: {
            runId: string;
            leaseOwner: string;
            executionEpoch: number;
          } | null;
          settleInterruptedToolBatchForFailure(input: WorkstreamWorkflowInput): Promise<void>;
          product: {
            recordWorkflowFailed(
              runId: string,
              error: { code: string; message: string },
              execution: {
                loopId: string;
                executionId: string;
                executionEpoch: number;
                leaseOwner: string;
              },
            ): Promise<void>;
          };
        };
        resident.activeLoopExecution = {
          runId: RUN_ID,
          leaseOwner: OWNER,
          executionEpoch: 1,
        };

        // The call has no receipt at all — the shape a run refused before its
        // tool ran leaves behind, and the one that made a five-minute deferral
        // the wrong answer.
        await resident.settleInterruptedToolBatchForFailure(workflowInput);

        expect(bindLoopNonSystemMessages(transcript.readBindProjection(LOOP_ID)!)
          .map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
        expect(transcript.unsettledToolBatchBlockingRelease(LOOP_ID)).toBeNull();

        // Settled, so the ordinary failure now completes rather than being
        // refused: the run terminalizes and the loop is free for the queue.
        await resident.product.recordWorkflowFailed(
          RUN_ID,
          { code: "agent_loop_failed", message: "Rally could not complete this execution" },
          { loopId: LOOP_ID, executionId: RUN_ID, executionEpoch: 1, leaseOwner: OWNER },
        );
        expect(new SubstreamLoopStorage(state.storage).loop()).toMatchObject({ status: "idle" });
        expect(state.storage.sql.exec<{
          status: string;
          terminalized_at: number | null;
        } & Record<string, SqlStorageValue>>(
          `SELECT status, terminalized_at FROM runs WHERE run_id = ?`,
          RUN_ID,
        ).one()).toMatchObject({ status: "failed", terminalized_at: expect.any(Number) });
      });
    });

    it("offers Bind no queued input it would have to refuse", async () => {
      const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
      ));
      await wedgeLoop(stub);

      await runInDurableObject(stub, (_instance, state) => {
        const now = Date.now();
        const loop = new SubstreamLoopStorage(state.storage);
        const transcript = new WorkstreamTranscriptStorage(state.storage);
        loop.reserveInputPreparation({
          inputId: "queued-behind-the-batch",
          loopId: LOOP_ID,
          clientMessageId: "queued-behind-the-batch",
          preparationKind: "human_message",
          envelopeJson: JSON.stringify({ text: "Anyone there?" }),
          now,
        });
        loop.completeInputPreparation({
          inputId: "queued-behind-the-batch",
          preparedTurnId: "queued-behind-the-batch",
          mode: "queue",
          actor: "human",
          authorUserId: USER_ID,
          authorNameSnapshot: "Member",
          authorAvatarUrlSnapshot: null,
          clientMessageId: "queued-behind-the-batch",
          externalActorJson: null,
          messageType: "message",
          preparedPayloadId: "queued-payload",
          preparedFactId: "queued-fact",
          preparedPayloadAudience: "shared",
          preparedPayloadMediaType: "application/json",
          preparedPayloadJson: JSON.stringify({ role: "user", content: "Anyone there?" }),
          preparedPayloadSha256: "0".repeat(64),
          preparedPayloadByteLength: 12,
          bindPayloadJson: JSON.stringify({ role: "user", content: "Anyone there?" }),
          provenanceJson: JSON.stringify({
            originKind: "derived",
            sourceKind: "participant_turn",
            sourceId: "queued-behind-the-batch",
            sourceRevision: 1,
          }),
          authorizationJson: JSON.stringify({
            executionPrincipal: { type: "user", userId: USER_ID },
            reason: "user_message",
          }),
          attachmentsJson: "[]",
          mentionsJson: "[]",
          now,
        });

        // The input is durably queued and stays queued: what it is waiting for
        // is the host repair, not a turn of its own. Returning it here is what
        // made `nextLoopWorkAt` derive a wake at `now` on every alarm.
        expect(loop.pendingInputs().map((row) => row.input_id))
          .toEqual(["queued-behind-the-batch"]);
        expect(transcript.nextActivationInput(LOOP_ID)).toBeUndefined();
      });
    });

    /**
     * The production ordering, through the real drain rather than its parts.
     *
     * The cases above call the two repair helpers directly, which proves each
     * one works and proves nothing about whether `drainPersistentLoop` calls
     * them. Removing either call site left every one of them green. This drives
     * a failing run through the real catch block and asserts what it leaves
     * behind, so the wiring and its order are covered too.
     */
    it("settles the batch, terminalizes, and closes the open receipt in one failed drain", async () => {
      const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
      ));
      await wedgeLoop(stub);

      await runInDurableObject(stub, async (instance, state) => {
        const receipts = new WorkstreamToolReceiptStorage(state.storage);
        receipts.seedDevelopmentReceipt({
          effectIntentId: "drain-open-effect",
          runId: RUN_ID,
          toolPosition: 0,
          toolCallId: `${LOOP_ID}:turn:1:tool:0`,
          toolName: "web_fetch",
          mode: "read",
          requestHash: "request-hash",
          status: "executing",
          connectionId: null,
          inputJson: "{}",
          outputSummary: null,
          executionPlanJson: JSON.stringify({ capability: "web.fetch", mode: "read" }),
          startedAt: Date.now(),
          settledAt: null,
        });
        // Expire the loop lease so the drain's recovery branch adopts this
        // execution, which is how it reaches the failure path at all.
        state.storage.sql.exec(
          `UPDATE substream_loops SET lease_expires_at = 1, revision = revision + 1,
                  updated_at = MAX(updated_at, ?) WHERE id = 1`,
          Date.now(),
        );

        const resident = instance as unknown as {
          executeAgentRun: (input: WorkstreamWorkflowInput) => Promise<unknown>;
          drainPersistentLoop: (ownsDrain: () => boolean) => Promise<void>;
        };
        // The run throws where a real one does: inside the execution, after the
        // assistant batch was accepted and before its results were.
        resident.executeAgentRun = () =>
          Promise.reject(new Error("tool_receipt_persistence_failed"));

        await resident.drainPersistentLoop(() => true);
      });

      await runInDurableObject(stub, (_instance, state) => {
        const transcript = new WorkstreamTranscriptStorage(state.storage);
        // Settled before the release, so the projection is a shape Bind accepts.
        expect(transcript.unsettledToolBatchBlockingRelease(LOOP_ID)).toBeNull();
        expect(bindLoopNonSystemMessages(transcript.readBindProjection(LOOP_ID)!)
          .map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
        // Released, because the batch was settled first.
        expect(new SubstreamLoopStorage(state.storage).loop()).toMatchObject({ status: "idle" });
        expect(state.storage.sql.exec<{
          status: string;
          terminalized_at: number | null;
        } & Record<string, SqlStorageValue>>(
          `SELECT status, terminalized_at FROM runs WHERE run_id = ?`,
          RUN_ID,
        ).one()).toMatchObject({ status: "failed", terminalized_at: expect.any(Number) });
        // And the card the failed run had open is closed, with the marker that
        // keeps the bounded sweep from rescanning it.
        expect(state.storage.sql.exec<{ status: string } & Record<string, SqlStorageValue>>(
          `SELECT status FROM tool_effects WHERE effect_intent_id = 'drain-open-effect'`,
        ).one().status).toBe("failed");
        expect(state.storage.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
          `SELECT COUNT(*) AS count FROM run_lifecycle_events
            WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
          RUN_ID,
        ).one().count).toBe(1);
      });
    });

    it.each([
      { status: "pending", answerable: true },
      { status: "cancelled", answerable: false },
    ])("treats a $status question as answerable=$answerable when the batch is withheld", async ({
      status,
      answerable,
    }) => {
      const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
      ));
      await wedgeLoop(stub);

      await runInDurableObject(stub, (_instance, state) => {
        const now = Date.now();
        const transcript = new WorkstreamTranscriptStorage(state.storage);
        // The withheld call is this loop's turn-1 tool 0, addressed the way
        // `pendingBindToolBatch` derives a receipt coordinate.
        state.storage.sql.exec(
          `INSERT INTO elicitation_requests
             (elicitation_id, run_id, prompt, response_type, options_json,
              minimum_selections, maximum_selections, target_user_id, status,
              answer_json, answered_by_user_id, external_actor_json,
              created_at, answered_at, tool_call_id)
           VALUES (?, ?, 'Which one?', 'select', '[]', 1, 1, ?, ?,
                   NULL, NULL, NULL, ?, NULL, ?)`,
          `elicitation-${status}`,
          RUN_ID,
          USER_ID,
          status,
          now,
          `${LOOP_ID}:turn:1:tool:0`,
        );

        // A question somebody can still answer is not withheld work: the room
        // releases itself when they reply, so the release is allowed and the
        // answer is admissible. A cancelled one has no answer coming, so the
        // batch is the host's to settle and the release must be refused —
        // reading `cancelled` as open is how the queue used to park for ever
        // on an input nobody would ever send.
        expect(transcript.unsettledToolBatchBlockingRelease(LOOP_ID)).toEqual(
          answerable ? null : expect.objectContaining({ turnId: `${LOOP_ID}:turn:1` }),
        );
      });
    });

    it("closes the tool cards a failed run left open", async () => {
      const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
      ));
      // The same failure, but with the batch already settled, so the release is
      // allowed and the run really does terminalize. What it leaves behind is
      // the subject here.
      await wedgeLoop(stub, { toolCalls: false });

      const workflowInput = WorkstreamWorkflowInputSchema.parse({
        region: "global",
        workspaceId: WORKSPACE_ID,
        parentKind: "workstream",
        parentId: WORKSTREAM_ID,
        substreamId: "0",
        loopId: LOOP_ID,
        harnessRunId: RUN_ID,
        triggerMessageId: null,
        activityId: null,
        executionPrincipal: { type: "user", userId: USER_ID },
        reason: "user_message",
      });

      await runInDurableObject(stub, async (instance, state) => {
        const receipts = new WorkstreamToolReceiptStorage(state.storage);
        receipts.seedDevelopmentReceipt({
          effectIntentId: "open-effect",
          runId: RUN_ID,
          toolPosition: 0,
          toolCallId: `${LOOP_ID}:turn:1:tool:0`,
          toolName: "web_fetch",
          mode: "read",
          requestHash: "request-hash",
          status: "executing",
          connectionId: null,
          inputJson: "{}",
          outputSummary: null,
          // The mode the sweep reads is the plan's, not the column's: a receipt
          // with no plan is treated as a possible write and settles
          // `ambiguous`. A real `web_fetch` carries `"mode":"read"`, so this
          // fixture does too, and the settlement can say the call did not land.
          executionPlanJson: JSON.stringify({
            canonicalToolName: "fetch",
            capability: "web.fetch",
            connectionId: null,
            idempotency: "safe",
            mode: "read",
            pluginId: "rally:web",
          }),
          startedAt: Date.now(),
          settledAt: null,
        });

        const resident = instance as unknown as {
          product: {
            recordWorkflowFailed(
              runId: string,
              error: { code: string; message: string },
              execution: {
                loopId: string;
                executionId: string;
                executionEpoch: number;
                leaseOwner: string;
              },
            ): Promise<void>;
          };
          settleResidualReceiptsAfterFailure(input: WorkstreamWorkflowInput): Promise<void>;
        };
        await resident.product.recordWorkflowFailed(
          RUN_ID,
          { code: "agent_loop_failed", message: "Rally could not complete this execution" },
          { loopId: LOOP_ID, executionId: RUN_ID, executionEpoch: 1, leaseOwner: OWNER },
        );

        // `recordWorkflowFailed` terminalizes with its own SQL, so it writes no
        // settlement marker and closes nothing. This is the gap.
        expect(state.storage.sql.exec<{ status: string } & Record<string, SqlStorageValue>>(
          `SELECT status FROM tool_effects WHERE effect_intent_id = 'open-effect'`,
        ).one().status).toBe("executing");

        await resident.settleResidualReceiptsAfterFailure(workflowInput);

        expect(state.storage.sql.exec<{
          status: string;
          settled_at: number | null;
        } & Record<string, SqlStorageValue>>(
          `SELECT status, settled_at FROM tool_effects WHERE effect_intent_id = 'open-effect'`,
        ).one()).toMatchObject({ status: "failed", settled_at: expect.any(Number) });
        // The marker is what stops the bounded sweep rescanning this run for
        // ever, so it is as much the fix as the settled receipt is.
        expect(state.storage.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
          `SELECT COUNT(*) AS count FROM run_lifecycle_events
            WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
          RUN_ID,
        ).one().count).toBe(1);
      });
    });
  });
});
