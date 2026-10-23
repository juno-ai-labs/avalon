/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WorkstreamWorkflowInputSchema,
  ServerSocketEventSchema,
  WorkstreamTranscriptSnapshotSchema,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import { runHarness, bindLoopNonSystemMessages } from "@rally/agent-harness";

import { providerRequestView, responsesStreamResponse } from "@rally/agent-harness/test-support/responses-stream";
import { completionVerificationNudge } from "../src/services/completion-verification";

import type { Env } from "../src/env";
import { conversationObjectName, substreamLoopId, workspaceDOName } from "../src/durable-objects/names";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { WorkstreamHarnessRunStorage } from "../src/durable-objects/workstream-harness-run-storage";
import { WorkstreamToolReceiptStorage } from "../src/durable-objects/workstream-tool-receipt-storage";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { readCompletionVerificationSnapshot } from "../src/durable-objects/completion-verification-storage";
import { createTestEnv } from "../test/helpers/cloudflare-test";
import { seedWorkspaceControlPlane, seedWorkstreamRoot } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000701");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000702");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000704");
const LOOP_ID = substreamLoopId(WORKSTREAM_ID);

interface TranscriptOperationExecutor {
  executeTranscriptOperation(input: unknown): Promise<{ status: number; bodyJson: string }>;
}

beforeEach(async () => reset());

describe("work-stream transcript on workerd SQLite", () => {
  it.each(["wide", "deep"] as const)("hydrates a %s activity graph above SQLite's parameter ceiling", async (shape) => {
    await seedWorkspaceControlPlane(env.DB, {
      workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId: "activity-graph-session",
    });
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
    await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      const activity = (activityId: string, parentActivityId: string | null, callIndex: number | null, active = false) => {
        const edge = {
          activityId, parentActivityId, callIndex,
          scope: "tool_call" as const, subjectId: activityId, label: activityId,
        };
        transcript.upsertActivity({ ...edge, action: "start", revision: 1, occurredAtUtc: "2026-01-01T00:00:01.000Z" });
        if (!active) transcript.upsertActivity({
          ...edge, action: "complete", revision: 2, occurredAtUtc: "2026-01-01T00:00:02.000Z",
        });
      };
      activity("shared-root", null, null);
      for (let index = 0; index < 105; index += 1) {
        activity(`activity-${index}`, shape === "wide" || index === 0 ? "shared-root" : `activity-${index - 1}`, index);
        if (shape === "deep" && index !== 104) continue;
        const sequence = shape === "wide" ? index + 1 : 1;
        const turnId = `turn-${index}`;
        await transcript.seedDevelopmentConversationTurn({
          turnId, clientMessageId: null, actor: "assistant", authorUserId: null,
          authorSnapshot: null, externalActorJson: null, messageType: "text",
          text: `Result ${index}`, structuredContentJson: null, producedByRunId: null,
          expectedTranscriptSequence: sequence, createdAtUtc: "2026-01-01T00:00:02.000Z",
        });
        state.storage.sql.exec(
          `UPDATE participant_transcript_turns SET activity_id = ? WHERE turn_id = ?`,
          `activity-${index}`, turnId,
        );
      }
      activity("live-outside-range", null, null, true);
      activity("unrelated-completed", null, null);
    });

    // Wide exceeds the seed parameter ceiling; deep expands a single seed
    // past the interval-hydration ceiling. Neither may truncate the graph.
    const opening = await stub.executeTranscriptOperation({
      workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID,
      operation: "createOpeningSnapshot",
      args: [{ unreadHighWaterAttentionOrdinal: null, now: Date.parse("2026-01-01T00:00:03.000Z") }],
    });
    expect(opening.status).toBe(200);
    const snapshot = WorkstreamTranscriptSnapshotSchema.parse(JSON.parse(opening.bodyJson).value);
    expect(snapshot.activities).toHaveLength(107);
    expect(snapshot.activeActivities).toEqual([expect.objectContaining({
      activityId: "live-outside-range", intervals: [expect.objectContaining({ elapsedMsAtSnapshot: 2_000 })],
    })]);
    expect(snapshot.activities.some((entry) => entry.activityId === "unrelated-completed")).toBe(false);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": "activity-graph-session",
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000705",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const nextEvent = (type: "snapshot" | "transcript_range") => new Promise<unknown>((resolve, reject) => {
      const onClose = (event: CloseEvent) => {
        socket.removeEventListener("message", onMessage);
        reject(new Error(`Socket closed: ${event.code} ${event.reason}`));
      };
      const onMessage = (event: MessageEvent) => {
        const decoded = ServerSocketEventSchema.parse(JSON.parse(String(event.data)));
        if (decoded.type !== type && decoded.type !== "error" && decoded.type !== "resync_required") return;
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        resolve(decoded);
      };
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose, { once: true });
    });
    try {
      const subscribed = nextEvent("snapshot");
      socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
      const frame = ServerSocketEventSchema.parse(await subscribed);
      expect(frame.type).toBe("snapshot");
      if (frame.type !== "snapshot") throw new Error(`Expected snapshot, got ${frame.type}`);
      expect(frame.transcript.activities).toHaveLength(107);

      const loaded = nextEvent("transcript_range");
      socket.send(JSON.stringify({
        type: "load_transcript_range",
        requestId: "00000000-0000-7000-8000-000000000706",
        request: {
          snapshotId: frame.transcript.snapshotId,
          range: { startInclusive: 1, endExclusive: snapshot.snapshotThrough + 1 },
          resumeAfterEventSequence: frame.sequence,
        },
      }));
      const rangeFrame = ServerSocketEventSchema.parse(await loaded);
      expect(rangeFrame.type).toBe("transcript_range");
      if (rangeFrame.type !== "transcript_range") throw new Error(`Expected range, got ${rangeFrame.type}`);
      const range = rangeFrame.result;
      expect(range.activities).toHaveLength(106);
      expect(range.activities[0]).toMatchObject({ activityId: "shared-root", parentActivityId: null });
      expect(range.activities[105]).toMatchObject({ activityId: "activity-104", callIndex: 104 });
      expect(range.activities.filter((entry) => entry.activityId === "shared-root")).toHaveLength(1);
      expect(range.activities.every((entry) => entry.state === "completed"
        && entry.intervals.length === 1 && entry.intervals[0]!.durationMs === 1_000)).toBe(true);
      expect(range.turns[0]?.blocks[0]).toMatchObject({ type: "text", text: shape === "wide" ? "Result 0" : "Result 104" });
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("keeps completion verification consumed across compaction and eviction", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const runId = "00000000-0000-7000-8000-0000000007f1";
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      const now = Date.now();
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      const systemProjection = { revision: 1, rendererVersion: "workstream-system-v1", inputHash: "test",
        message: { role: "system", content: "System" } };
      await transcript.commitBindTransition({ kind: "state_initialized", loopId: LOOP_ID,
        generation: 1, stateRevision: 1, systemProjection, nonSystemMessages: [], nonSystemMessageOrigins: [] });
      const runs = new WorkstreamHarnessRunStorage(state.storage);
      expect(runs.admitRun({ runId, origin: "member_message", executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
        status: "running", startedAt: now, model: "test/model", triggerPartId: null,
        parentRunId: null, expectedLatestRunId: null, now })).toEqual({ outcome: "admitted" });
      state.storage.sql.exec(`UPDATE runs SET execution_context_json = '{}' WHERE run_id = ?`, runId);
      const loop = new SubstreamLoopStorage(state.storage);
      loop.ensureLoop({ loopId: LOOP_ID, bindStateRevision: 1, now });
      loop.activateExecutionReceipt({ runId, loopId: LOOP_ID, executionEpoch: 1, leaseOwner: "test-owner",
        leaseExpiresAt: now + 60_000, expectedLoopRevision: loop.loop()!.revision, expectedBindStateRevision: 1, now });
      expect(readCompletionVerificationSnapshot(state.storage, runId, null).lifecycle).toBe("ready");
      state.storage.sql.exec(`UPDATE runs SET cancellation_requested_at = ? WHERE run_id = ?`, now, runId);
      expect(readCompletionVerificationSnapshot(state.storage, runId, null).lifecycle).toBe("cancelled");
      state.storage.sql.exec(`UPDATE runs SET cancellation_requested_at = NULL WHERE run_id = ?`, runId);
      state.storage.sql.exec(`INSERT INTO elicitation_requests
        (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json, minimum_selections, status, created_at)
        VALUES ('question', ?, 'question-call', 'Which publication?', 'text', '[]', 0, 'pending', ?)`, runId, now);
      expect(readCompletionVerificationSnapshot(state.storage, runId, null).lifecycle).toBe("input_required");
      state.storage.sql.exec(`UPDATE elicitation_requests SET status = 'answered', answer_json = '"Blog"' WHERE elicitation_id = 'question'`);
      state.storage.sql.exec(`INSERT INTO tool_effects
        (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name, mode,
         request_hash, authority_revision, status, tool_call_id, input_json, output_summary, output_ref)
        VALUES ('effect', ?, 1, 0, 'occurrence', 'publish_article', 'write', 'request', 'authority',
          'executing', 'tool-1', '{}', NULL, NULL)`, runId);
      expect(readCompletionVerificationSnapshot(state.storage, runId, null).lifecycle).toBe("background_pending");
      state.storage.sql.exec(`UPDATE tool_effects SET status = 'ambiguous' WHERE effect_intent_id = 'effect'`);
      expect(readCompletionVerificationSnapshot(state.storage, runId, null).lifecycle).toBe("ambiguous_write");
      state.storage.sql.exec(`UPDATE tool_effects SET status = 'completed', output_summary = 'Published', output_ref = 'article-ref' WHERE effect_intent_id = 'effect'`);
      expect(readCompletionVerificationSnapshot(state.storage, runId, null)).toMatchObject({ lifecycle: "ready",
        receipts: [{ id: "tool-1", operation: "publish_article", status: "completed", summary: "Published", output_refs: ["article-ref"] }] });
      await transcript.commitBindTransition({ kind: "protocol_user_appended", loopId: LOOP_ID,
        generation: 1, stateRevision: 2, message: { role: "user", content: "Verify completion once." },
        provenance: { originKind: "derived", sourceKind: "completion_verification", sourceId: runId, sourceRevision: null },
        activationInputId: null });
      expect(readCompletionVerificationSnapshot(state.storage, runId, null).lifecycle).toBe("recovery_used");
      await transcript.commitBindTransition({ kind: "state_replaced", loopId: LOOP_ID,
        generation: 1, nextGeneration: 2, stateRevision: 3, systemProjection,
        nonSystemMessages: [{ role: "user", content: "Compacted conversation" }], compactionEventId: "completion-test-compaction" });
      expect(bindLoopNonSystemMessages(transcript.readBindProjection(LOOP_ID)!)).toEqual([
        { role: "user", content: "Compacted conversation" },
      ]);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) => {
      expect(readCompletionVerificationSnapshot(state.storage, runId, null).lifecycle).toBe("recovery_used");
      expect(readCompletionVerificationSnapshot(state.storage, "another-execution", null).lifecycle).toBe("unknown");
    });
  });

  it("delivers the committed completion verification prompt after eviction without a second recovery", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const runId = "00000000-0000-7000-8000-0000000007f2";
    const requests: Array<Record<string, unknown>> = [];
    let judgments = 0;
    let interruptedAfterCommit = false;
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      const now = Date.now();
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      await transcript.commitBindTransition({ kind: "state_initialized", loopId: LOOP_ID,
        generation: 1, stateRevision: 1,
        systemProjection: { revision: 1, rendererVersion: "workstream-system-v1", inputHash: "test",
          message: { role: "system", content: "Be useful." } },
        nonSystemMessages: [{ role: "user", content: "Write an article." }],
        nonSystemMessageOrigins: [{ originKind: "derived", sourceKind: "participant_turn", sourceId: "request", sourceRevision: 1 }] });
      const runs = new WorkstreamHarnessRunStorage(state.storage);
      runs.admitRun({ runId, origin: "member_message", executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
        status: "running", startedAt: now, model: "test/model", triggerPartId: null,
        parentRunId: null, expectedLatestRunId: null, now });
      state.storage.sql.exec(`UPDATE runs SET execution_context_json = ? WHERE run_id = ?`, JSON.stringify(
        WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID, parentKind: "workstream",
          parentId: WORKSTREAM_ID, substreamId: "0", loopId: LOOP_ID, harnessRunId: runId, triggerMessageId: null,
          activityId: null, executionPrincipal: { type: "user", userId: USER_ID }, reason: "user_message" }),
      ), runId);
      const loop = new SubstreamLoopStorage(state.storage);
      loop.ensureLoop({ loopId: LOOP_ID, bindStateRevision: 1, now });
      loop.activateExecutionReceipt({ runId, loopId: LOOP_ID, executionEpoch: 1, leaseOwner: "restart-test",
        leaseExpiresAt: now + 60_000, expectedLoopRevision: loop.loop()!.revision, expectedBindStateRevision: 1, now });
    });
    const execute = (interruptAfterCommit: boolean) => runInDurableObject(stub, async (instance, state) => {
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      const loop = new SubstreamLoopStorage(state.storage);
      let fence = { executionId: runId, executionEpoch: 1, leaseOwner: "restart-test" };
      if (!interruptAfterCommit) {
        await state.storage.deleteAlarm();
        const host = instance as unknown as { claimPersistentLoopExecution(): Promise<{
          execution: { runId: string; executionEpoch: number; leaseOwner: string };
        } | null> };
        const claim = await host.claimPersistentLoopExecution();
        expect(claim).toMatchObject({ execution: { runId, executionEpoch: 2 } });
        fence = { executionId: claim!.execution.runId, executionEpoch: claim!.execution.executionEpoch, leaseOwner: claim!.execution.leaseOwner };
      }
      return runHarness({
        config: { apiKey: "test-key", primaryModel: "test/model", maxIterations: 4, maxToolCalls: 10,
          maxWallClockMs: 120_000, toolTimeoutMs: 30_000, maxWebResults: 4,
          fetch: async (_request, init) => {
            requests.push(providerRequestView(JSON.parse(String(init?.body))));
            return responsesStreamResponse([{ choices: [{ delta: { content: interruptAfterCommit
              ? "I'm writing it now." : "Here is the completed article." }, finish_reason: "stop" }] }]);
          } },
        workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, loopId: LOOP_ID, harnessRunId: runId,
        executionPrincipal: { type: "user", userId: USER_ID }, systemPrompt: "Be useful.",
        messages: [], corePlugins: [], onEvent: () => {},
        bindLoopProjection: transcript.readBindProjection(LOOP_ID)!,
        modelIterationsUsed: loop.assistantTurnCountForExecution(runId),
        onAssistantTurnReserved: ({ turnId, modelTurnIndex }) => {
          const result = loop.reserveAssistantTurn({ ...fence, expectedLoopRevision: loop.loop()!.revision,
            receiptRunId: runId, turnId, modelTurnIndex, streamId: "restart-stream", now: Date.now() });
          return { transcriptSequence: result.reservation.transcript_sequence };
        },
        onBindLoopTransition: async (transition) => {
          await transcript.commitBindTransition(transition, Date.now(), {
            ...fence, expectedBindStateRevision: loop.loop()!.bind_state_revision,
          });
          // Simulate process loss at the exact durable boundary. No host
          // terminalization runs: the same execution is resumed from SQLite.
          if (interruptAfterCommit && transition.kind === "protocol_user_appended"
            && transition.provenance.sourceKind === "completion_verification") {
            interruptedAfterCommit = true;
            throw new Error("injected_process_loss_after_nudge_commit");
          }
        },
        onStepSettled: () => ({ transitions: [], stop: false }),
        onTurnWouldEnd: ({ assistantContent, messages }) => completionVerificationNudge({
          runId, assistantContent, messages, signal: new AbortController().signal,
          snapshot: () => readCompletionVerificationSnapshot(state.storage, runId, null),
          pendingDelegation: async () => false,
          judge: async () => { judgments += 1; return { reprompt: true, answer: null, model: null, failureKind: "timeout" }; },
        }),
      });
    });
    const interrupted = await execute(true);
    expect(interrupted, JSON.stringify(interrupted)).toMatchObject({ status: "failed" });
    expect(interruptedAfterCommit, JSON.stringify(interrupted)).toBe(true);
    expect(judgments).toBe(1);
    expect(requests).toHaveLength(1);
    await evictDurableObject(stub);
    const resumed = await execute(false);
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: "completed", content: "Here is the completed article." });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages).toEqual(expect.arrayContaining([
      { role: "user", content: expect.stringContaining("Check existing artifacts and tool receipts before repeating any action.") },
    ]));
    expect(judgments).toBe(1);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM transcript_facts WHERE source_kind = 'completion_verification' AND source_id = ?`, runId,
    ).one().n)).toBe(1);
  });

  it("reports preparing and queued delegated input as pending work while the loop is idle", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      const loop = new SubstreamLoopStorage(state.storage);
      loop.ensureLoop({ loopId: LOOP_ID, bindStateRevision: 0, now: Date.now() });
    });
    expect(await stub.agentRuntimeInfo()).toMatchObject({ status: "idle", pendingWork: false });
    await runInDurableObject(stub, (_instance, state) => {
      new SubstreamLoopStorage(state.storage).reserveInputPreparation({ inputId: "delegated-input", loopId: LOOP_ID,
        clientMessageId: "delegated-input", preparationKind: "automation_activation", envelopeJson: "{}", now: Date.now() });
    });
    expect(await stub.agentRuntimeInfo()).toMatchObject({ status: "idle", pendingWork: true });
    await runInDurableObject(stub, (_instance, state) => {
      new SubstreamLoopStorage(state.storage).completeInputPreparation({
        inputId: "delegated-input", preparedTurnId: "delegated-input", mode: "queue", actor: "system",
        authorUserId: null, authorNameSnapshot: null, authorAvatarUrlSnapshot: null, clientMessageId: "delegated-input",
        externalActorJson: null, messageType: "system", preparedPayloadId: "delegated-payload", preparedFactId: "delegated-fact",
        preparedPayloadAudience: "shared", preparedPayloadMediaType: "application/json",
        preparedPayloadJson: '{"role":"user","content":"Research this."}', preparedPayloadSha256: "0".repeat(64),
        preparedPayloadByteLength: 42, bindPayloadJson: '{"role":"user","content":"Research this."}',
        provenanceJson: JSON.stringify({ originKind: "derived", sourceKind: "agent_message", sourceId: "delegated-input", sourceRevision: 1 }),
        authorizationJson: JSON.stringify({ executionPrincipal: { type: "user", userId: USER_ID }, reason: "agent_message" }),
        attachmentsJson: "[]", mentionsJson: "[]", now: Date.now(),
      });
    });
    expect(await stub.agentRuntimeInfo()).toMatchObject({ status: "idle", pendingWork: true });
  });

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

  /**
   * A run interrupted mid-batch, exactly as the 2026-09-19 incident left one: a
   * provider-keyed `publish_resource` still `executing`, a `request_elicitation`
   * whose answer is owed to a person, and an assistant turn holding both.
   *
   * Shared by claim, relocation, and failure-cleanup tests; `reset()` gives
   * each test a clean object.
   */
  async function seedInterruptedWriteBatch(stub: DurableObjectStub, options: {
    receiptRunId: string;
    loopId?: string;
    attemptId: string;
    attemptOwner: string;
  }): Promise<{ toolCallId: string }> {
    const { receiptRunId, attemptId, attemptOwner, loopId = LOOP_ID } = options;
    const now = Date.now();
    const workflowInput = WorkstreamWorkflowInputSchema.parse({
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      substreamId: "0",
      loopId,
      harnessRunId: receiptRunId,
      triggerMessageId: null,
      activityId: null,
      executionPrincipal: { type: "user", userId: USER_ID },
      reason: "user_message",
    });
    const toolCallId = `${loopId}:turn:1:tool:0`;

    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      await transcript.commitBindTransition({
        kind: "state_initialized",
        loopId,
        generation: 1,
        stateRevision: 1,
        systemProjection: {
          revision: 1,
          rendererVersion: "workstream-system-v1",
          inputHash: "system-input",
          message: { role: "system", content: "System" },
        },
        nonSystemMessages: [{ role: "user", content: "Publish the document" }],
        nonSystemMessageOrigins: [{
          originKind: "derived",
          sourceKind: "participant_turn",
          sourceId: "message-1",
          sourceRevision: 1,
        }],
      });
      const runs = new WorkstreamHarnessRunStorage(state.storage);
      runs.admitRun({
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
      });
      state.storage.sql.exec(
        `UPDATE runs SET execution_context_json = ? WHERE run_id = ?`,
        JSON.stringify(workflowInput),
        receiptRunId,
      );
      const loop = new SubstreamLoopStorage(state.storage);
      loop.ensureLoop({ loopId, bindStateRevision: 1, now });
      loop.activateExecutionReceipt({
        runId: receiptRunId,
        loopId,
        executionEpoch: 1,
        leaseOwner: "workerd-test-owner",
        leaseExpiresAt: now + 60_000,
        expectedLoopRevision: loop.loop()!.revision,
        expectedBindStateRevision: 1,
        now,
      });
      runs.claimAttempt({
        runId: receiptRunId,
        attemptId,
        owner: attemptOwner,
        leaseSeconds: 60,
        lifecycleEventId: "workerd-write-attempt-claimed",
        now,
      });
      const reservation = loop.reserveAssistantTurn({
        executionId: receiptRunId,
        executionEpoch: 1,
        leaseOwner: "workerd-test-owner",
        expectedLoopRevision: loop.loop()!.revision,
        receiptRunId,
        turnId: `${loopId}:turn:1`,
        modelTurnIndex: 1,
        streamId: "workerd-write-stream",
        now,
      });
      await transcript.commitBindTransition({
        kind: "assistant_reserved",
        loopId,
        generation: 1,
        stateRevision: 2,
        turnId: `${loopId}:turn:1`,
        modelTurnIndex: 1,
        transcriptSequence: reservation.reservation!.transcript_sequence,
      }, now, {
        executionId: receiptRunId,
        executionEpoch: 1,
        leaseOwner: "workerd-test-owner",
        expectedBindStateRevision: 1,
      });
      await transcript.commitBindTransition({
        kind: "assistant_accepted",
        loopId,
        generation: 1,
        stateRevision: 3,
        turnId: `${loopId}:turn:1`,
        modelTurnIndex: 1,
        transcriptSequence: reservation.reservation!.transcript_sequence,
        message: {
          role: "assistant",
          content: "Publishing",
          tool_calls: [{
            id: "provider-call",
            type: "function",
            function: { name: "publish_resource", arguments: "{}" },
          }, {
            id: "provider-question",
            type: "function",
            function: { name: "request_elicitation", arguments: "{}" },
          }],
        },
      }, now + 1, {
        executionId: receiptRunId,
        executionEpoch: 1,
        leaseOwner: "workerd-test-owner",
        expectedBindStateRevision: 2,
      });
      // A question already put to a person, whose protocol result is withheld
      // until they answer. The repair filters it out of the calls it settles.
      state.storage.sql.exec(
        `INSERT INTO elicitation_requests
           (elicitation_id, run_id, prompt, response_type, options_json,
            minimum_selections, status, created_at, tool_call_id)
         VALUES ('elicitation-1', ?, 'Which one?', 'single_select', '[]', 1, 'pending', ?, ?)`,
        receiptRunId,
        now,
        `${loopId}:turn:1:tool:1`,
      );
      // The shape the incident left behind: a provider-keyed write admitted
      // and still `executing` when the isolate went away. Written directly
      // because reaching it through Bind would mean running a real sandbox.
      state.storage.sql.exec(
        `INSERT INTO tool_effects
           (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
            tool_name, mode, request_hash, authority_revision, status, tool_call_id,
            connection_id, input_json, execution_plan_hash, execution_plan_json,
            provider_idempotency_key, started_at, checkpoint_index)
         VALUES ('effect-publish', ?, 0, 0, 'runtime:effect-publish', 'publish_resource',
                 'write', 'request-hash', 'plan-hash', 'executing', ?, NULL,
                 '{"filePath":"prd.md"}', 'plan-hash',
                 '{"pluginId":"rally:terminal","canonicalToolName":"publish_resource","capability":"terminal.resource.publish","mode":"write","idempotency":"provider_key"}',
                 ?, ?, 0)`,
        receiptRunId,
        toolCallId,
        `${loopId}:turn:1:tool:0`,
        now,
      );
    });
    return { toolCallId };
  }

  it.each([
    { receiptStatus: "executing", recovery: "ambiguous", success: false },
    { receiptStatus: "completed", recovery: "completed", success: true },
    { receiptStatus: "missing", recovery: "not_run", success: false },
  ])("recovers a relocated $receiptStatus receipt and releases the loop without answering its elicitation", async ({ receiptStatus, recovery, success }) => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const receiptRunId = "00000000-0000-7000-8000-000000000708";
    const attemptId = "relocated-attempt";
    const attemptOwner = "relocated-owner";
    const historicalLoopId = substreamLoopId(asWorkstreamId("00000000-0000-7000-8000-000000000709"));
    const relocatedLoopId = LOOP_ID;
    const { toolCallId } = await seedInterruptedWriteBatch(stub, { receiptRunId, attemptId, attemptOwner, loopId: historicalLoopId });
    await runInDurableObject(stub, (_instance, state) => {
      // Copy the operator's relational remap, leaving immutable turns, receipts,
      // and the elicitation at their original IDs.
      state.storage.transactionSync(() => {
        state.storage.sql.exec(`PRAGMA defer_foreign_keys = ON`);
        for (const table of ["substream_loops", "bind_loop_heads", "bind_loop_state_messages",
          "bind_provider_boundaries", "bind_activation_inputs", "assistant_turn_reservations"]) {
          state.storage.sql.exec(`UPDATE ${table} SET loop_id = ? WHERE loop_id = ?`, relocatedLoopId, historicalLoopId);
        }
        state.storage.sql.exec(
          `UPDATE runs SET substream_loop_id = ?, execution_context_json = json_set(execution_context_json, '$.loopId', ?)
            WHERE run_id = ?`, relocatedLoopId, relocatedLoopId, receiptRunId,
        );
      });
      if (receiptStatus === "completed") {
        state.storage.sql.exec(`UPDATE tool_effects SET status = 'completed', output_summary = 'Already published', settled_at = ?`, Date.now());
      } else if (receiptStatus === "missing") {
        state.storage.sql.exec(`DELETE FROM tool_effects`);
      }
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const resident = instance as unknown as {
        activeLoopExecution: { runId: string; leaseOwner: string; executionEpoch: number } | null;
        claimPersistentLoopExecution(): Promise<{
          input: WorkstreamWorkflowInput;
          execution: { runId: string; leaseOwner: string; executionEpoch: number };
        } | null>;
        recoverInterruptedToolBatch(executionEnv: Env, input: WorkstreamWorkflowInput,
          fence: { attemptId: string; owner: string }): Promise<string | null>;
        product: { recordWorkflowFailed(runId: string, error: { code: string; message: string },
          execution: { loopId: string; executionId: string; executionEpoch: number; leaseOwner: string }): Promise<void> };
      };
      const claim = await resident.claimPersistentLoopExecution();
      if (!claim) throw new Error("replacement_loop_claim_missing");
      expect(claim.input.loopId).toBe(relocatedLoopId);
      resident.activeLoopExecution = claim.execution;
      state.storage.sql.exec(
        `UPDATE runs SET legacy_attempt_id = ?, lease_owner = ?, lease_expires_at = ? WHERE run_id = ?`,
        attemptId, attemptOwner, Date.now() + 600_000, receiptRunId,
      );
      await expect(resident.recoverInterruptedToolBatch(
        createTestEnv({ PAYLOADS: env.PAYLOADS }), claim.input, { attemptId, owner: attemptOwner },
      )).resolves.toBe("waiting_for_input");
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      const messages = bindLoopNonSystemMessages(transcript.readBindProjection(relocatedLoopId)!);
      const results = messages.filter((message) => message.role === "tool");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ tool_call_id: "provider-call" });
      const result = JSON.parse(z.object({ content: z.string() }).parse(results[0]).content);
      expect(result.success).toBe(success);
      if (success) expect(result.data).toMatchObject({ summary: "Already published" });
      else expect(result.data.recovery).toBe(recovery);
      expect(transcript.participantTurn(`${historicalLoopId}:turn:1`)!.blocks).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool", toolCallId, status: success ? "completed" : recovery === "ambiguous" ? "ambiguous" : "failed" }),
      ]));
      expect(state.storage.sql.exec<{ status: string }>(`SELECT status FROM elicitation_requests WHERE elicitation_id = 'elicitation-1'`).one())
        .toEqual({ status: "pending" });
      expect(transcript.unsettledToolBatchBlockingRelease(relocatedLoopId)).toBeNull();
      await resident.product.recordWorkflowFailed(receiptRunId,
        { code: "agent_loop_failed", message: "Interrupted execution" }, {
          loopId: relocatedLoopId, executionId: receiptRunId,
          executionEpoch: claim.execution.executionEpoch, leaseOwner: claim.execution.leaseOwner,
        });
      expect(new SubstreamLoopStorage(state.storage).loop()).toMatchObject({ status: "idle" });
      expect(state.storage.sql.exec<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, receiptRunId).one())
        .toEqual({ status: "failed" });
    });
  });

  it("names the interrupted write it could not confirm, and repairs the batch anyway", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const receiptRunId = "00000000-0000-7000-8000-000000000706";
    const attemptId = "workerd-write-attempt";
    const attemptOwner = "workerd-write-attempt-owner";
    const { toolCallId } = await seedInterruptedWriteBatch(stub, { receiptRunId, attemptId, attemptOwner });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      const resident = instance as unknown as {
        activeLoopExecution: { runId: string; leaseOwner: string; executionEpoch: number } | null;
        recoverInterruptedToolBatch(
          executionEnv: Env,
          input: WorkstreamWorkflowInput,
          fence: { attemptId: string; owner: string },
          lease?: { attemptId: string; owner: string; attemptNumber: number; leaseExpiresAt: number },
        ): Promise<"recovered" | "ambiguous" | "waiting_for_input" | null>;
        claimPersistentLoopExecution(): Promise<{
          input: WorkstreamWorkflowInput;
          execution: { runId: string; leaseOwner: string; executionEpoch: number };
        } | null>;
      };
      const replacementClaim = await resident.claimPersistentLoopExecution();
      if (!replacementClaim) throw new Error("replacement_loop_claim_missing");
      resident.activeLoopExecution = replacementClaim.execution;
      // The replacement isolate expires the dead one's attempt lease on the
      // way in. Model it re-claiming, which `runHarnessAttempt` does before it
      // reaches the repair; the settlements below are fenced on it.
      state.storage.sql.exec(
        "UPDATE runs SET legacy_attempt_id = ?, lease_owner = ?, lease_expires_at = ? WHERE run_id = ?",
        attemptId,
        attemptOwner,
        Date.now() + 600_000,
        receiptRunId,
      );

      // Terminal is unconfigured in this suite, so its plugin cannot be built
      // and the write cannot be asked what it did. That is the one path that
      // still ends in ambiguity — and it repairs the batch rather than
      // throwing, because the protocol array has to be whole either way.
      // `waiting_for_input`, not `ambiguous`, and the order is the whole
      // point: this batch holds both. While an ambiguity failed the cycle the
      // two could never collide, so reporting it first was harmless; now that
      // it continues, it would discard the withheld elicitation and start the
      // harness on an assistant turn whose second tool call has no result.
      await expect(resident.recoverInterruptedToolBatch(
        createTestEnv({ PAYLOADS: env.PAYLOADS }),
        replacementClaim.input,
        { attemptId, owner: attemptOwner },
        { attemptId, owner: attemptOwner, attemptNumber: 1, leaseExpiresAt: Date.now() + 600_000 },
      )).resolves.toBe("waiting_for_input");

      // The tool is named. A member reading `ambiguous_external_write` alone
      // cannot tell which of a batch's calls is in doubt, and neither can an
      // operator reading the receipt's error.
      expect(transcript.participantTurn(`${LOOP_ID}:turn:1`)!.blocks)
        .toEqual(expect.arrayContaining([expect.objectContaining({
          type: "tool",
          toolCallId,
          status: "ambiguous",
          error: expect.stringContaining("publish_resource"),
        })]));
      expect(state.storage.sql.exec<{ status: string; error_json: string | null } & Record<string, SqlStorageValue>>(
        `SELECT status, error_json FROM tool_effects WHERE effect_intent_id = 'effect-publish'`,
      ).one()).toMatchObject({
        status: "ambiguous",
        error_json: expect.stringContaining("publish_resource"),
      });

      // Repaired, not abandoned: the batch has its result, so the loop can
      // carry the ambiguity to the model instead of the run dying on it.
      const recovered = bindLoopNonSystemMessages(transcript.readBindProjection(LOOP_ID)!).at(-1);
      expect(recovered).toMatchObject({ role: "tool", tool_call_id: "provider-call" });

      // And the model is told what the member is told. Continuing past an
      // ambiguity is only defensible if the one reader able to repeat the
      // write knows not to; a bare `ambiguous_external_write` code left it
      // free to reissue the call on a fresh receipt coordinate.
      const modelResult = JSON.parse(
        z.object({ content: z.string() }).parse(recovered).content,
      ) as { success: boolean; kind: string; data: Record<string, unknown> };
      expect(modelResult).toMatchObject({ success: false, kind: "ambiguous_external_write" });
      expect(modelResult.data).toMatchObject({
        code: "ambiguous_external_write",
        recovery: "ambiguous",
        toolName: "publish_resource",
      });
      expect(String(modelResult.data.instruction)).toContain("publish_resource");
      expect(String(modelResult.data.instruction)).toContain("Do not repeat it");
      // Authority is revalidated before the tool is reached, so this run —
      // which has no seeded membership — never gets as far as building the
      // plugin, let alone re-entering the write. The live path proves the same
      // thing in `beforeToolCall`; crash repair bypasses that hook entirely, so
      // without this the interrupted write of a principal who lost access
      // between the interruption and the repair would still execute. The value
      // is the ordering: any later refusal would report its own code here.
      expect(modelResult.data.reason).toBe("run_authority_lost");
    });
  });

  it("will not ask an interrupted write anything without a claim to record the answer under", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const receiptRunId = "00000000-0000-7000-8000-000000000707";
    const attemptId = "workerd-unleased-attempt";
    const attemptOwner = "workerd-unleased-attempt-owner";
    await seedInterruptedWriteBatch(stub, { receiptRunId, attemptId, attemptOwner });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const resident = instance as unknown as {
        activeLoopExecution: { runId: string; leaseOwner: string; executionEpoch: number } | null;
        recoverInterruptedToolBatch(
          executionEnv: Env,
          input: WorkstreamWorkflowInput,
          fence: { attemptId: string; owner: string },
          lease?: { attemptId: string; owner: string; attemptNumber: number; leaseExpiresAt: number },
        ): Promise<"recovered" | "ambiguous" | "waiting_for_input" | null>;
        claimPersistentLoopExecution(): Promise<{
          input: WorkstreamWorkflowInput;
          execution: { runId: string; leaseOwner: string; executionEpoch: number };
        } | null>;
      };
      const replacementClaim = await resident.claimPersistentLoopExecution();
      if (!replacementClaim) throw new Error("replacement_loop_claim_missing");
      resident.activeLoopExecution = replacementClaim.execution;
      state.storage.sql.exec(
        "UPDATE runs SET legacy_attempt_id = ?, lease_owner = ?, lease_expires_at = ? WHERE run_id = ?",
        attemptId,
        attemptOwner,
        Date.now() + 600_000,
        receiptRunId,
      );

      // The failure-settlement caller reconstructs an owner rather than
      // minting a lease, so it can fence a settlement but cannot hold one open
      // across a tool call. Asking anyway would mean obtaining an answer with
      // no claim to record it under, which is worse than not asking.
      await resident.recoverInterruptedToolBatch(
        createTestEnv({ PAYLOADS: env.PAYLOADS }),
        replacementClaim.input,
        { attemptId, owner: attemptOwner },
      );

      expect(state.storage.sql.exec<{ status: string; error_json: string | null } & Record<string, SqlStorageValue>>(
        `SELECT status, error_json FROM tool_effects WHERE effect_intent_id = 'effect-publish'`,
      ).one()).toMatchObject({
        status: "ambiguous",
        // Named, not silent: "nobody asked" and "the question failed" are
        // different repairs, and only one of them is worth chasing.
        error_json: expect.stringContaining("no_repair_lease"),
      });
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
      await runInDurableObject(stub, async (instance, state) => {
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
        // A real run holds an attempt, and two things select on it: the
        // residual receipt sweep, and the settlement's check that this isolate
        // still owns the attempt it is about to fence a receipt write with. The
        // owner is therefore the object's own, not a string of the test's
        // choosing — a fixture with an invented owner is not a run this code
        // ever sees, and would quietly take the stand-down path instead.
        runs.claimAttempt({
          runId: RUN_ID,
          attemptId: ATTEMPT_ID,
          owner: (instance as unknown as {
            harnessAttemptOwner: (
              input: { substreamId: string | null; harnessRunId: string },
              attemptId: string,
            ) => string;
          }).harnessAttemptOwner({ substreamId: "0", harnessRunId: RUN_ID }, ATTEMPT_ID),
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

    /**
     * The deferral branch, which exists so that a settlement this run cannot do
     * becomes a slow recovery rather than a silent wedge.
     *
     * Its selector is a caught error, so review's point stands: nothing else
     * here executes it, and a rename at either throw site would send the throw
     * on to `drainLoopToCompletion` as a plain `substream_loop_drain_failed` —
     * the invisible hot retry this whole change removes. The attempt lease is
     * cleared to reach it, which is exactly what `settleInterruptedToolBatchForFailure`
     * stands down on.
     */
    it("leaves the loop executing when the batch cannot be settled by this run", async () => {
      const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
      ));
      await wedgeLoop(stub);

      await runInDurableObject(stub, async (instance, state) => {
        // No attempt owner this isolate can prove, so the settlement declines
        // rather than fencing a receipt write against a row that vouches for
        // itself.
        state.storage.sql.exec(
          `UPDATE runs SET lease_owner = 'taken-over-by-someone-else', updated_at = ?
            WHERE run_id = ?`,
          Date.now(),
          RUN_ID,
        );
        state.storage.sql.exec(
          `UPDATE substream_loops SET lease_expires_at = 1, revision = revision + 1,
                  updated_at = MAX(updated_at, ?) WHERE id = 1`,
          Date.now(),
        );

        const resident = instance as unknown as {
          executeAgentRun: (input: WorkstreamWorkflowInput) => Promise<unknown>;
          drainPersistentLoop: (ownsDrain: () => boolean) => Promise<void>;
        };
        resident.executeAgentRun = () =>
          Promise.reject(new Error("tool_receipt_persistence_failed"));

        // The deferral returns rather than throwing: a throw here is the
        // regression the typed error exists to prevent.
        await expect(resident.drainPersistentLoop(() => true)).resolves.toBeUndefined();
      });

      await runInDurableObject(stub, (_instance, state) => {
        const transcript = new WorkstreamTranscriptStorage(state.storage);
        // Nothing was settled and nothing was released: the batch is still
        // owed, and the run is still the only thing that can be asked for it.
        expect(transcript.unsettledToolBatchBlockingRelease(LOOP_ID)).not.toBeNull();
        expect(new SubstreamLoopStorage(state.storage).loop()).toMatchObject({
          status: "executing",
          active_execution_id: RUN_ID,
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

    it.each(["pending", "cancelled"])("allows release with a %s elicitation call withheld", async (status) => {
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

        // An answer or the next ordinary input supplies the withheld result.
        // Neither call needs a running execution to settle it.
        expect(transcript.unsettledToolBatchBlockingRelease(LOOP_ID)).toBeNull();
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
        const terminalizedAtFloor = Date.now();
        state.storage.sql.exec(
          `INSERT INTO active_output_turns
             (run_id, attempt_epoch, turn_id, transcript_sequence, substream_id, status,
              durable_event_seq, durable_through_frame_seq, next_chunk_index, stream_id,
              seen_turn_ids_json, turn_start_offset, started_at, checkpointed_at, updated_at)
           VALUES (?, 1, 'failure-turn', 1, '0', 'streaming', 1, 1, 1,
                   'failure-stream', '[]', 0, ?, ?, ?)`,
          RUN_ID,
          terminalizedAtFloor,
          terminalizedAtFloor,
          terminalizedAtFloor,
        );
        state.storage.sql.exec(
          `INSERT INTO inference_delay_status
             (inference_request_id, run_id, execution_id, root_attempt_id,
              attempt_id, turn_id, active)
           VALUES ('failure-inference', ?, ?, ?, ?, 'failure-turn', 1)`,
          RUN_ID,
          RUN_ID,
          ATTEMPT_ID,
          ATTEMPT_ID,
        );

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
        state.storage.sql.exec(
          `UPDATE substream_loops SET lease_expires_at = 1 WHERE id = 1`,
        );
        await expect(resident.product.recordWorkflowFailed(
          RUN_ID,
          { code: "agent_loop_failed", message: "Rally could not complete this execution" },
          { loopId: LOOP_ID, executionId: RUN_ID, executionEpoch: 1, leaseOwner: OWNER },
        )).rejects.toThrow("workstream_run_failure_fenced");
        expect(state.storage.sql.exec<{ status: string } & Record<string, SqlStorageValue>>(
          `SELECT status FROM runs WHERE run_id = ?`,
          RUN_ID,
        ).one()).toEqual({ status: "running" });
        state.storage.sql.exec(
          `UPDATE substream_loops SET lease_expires_at = ? WHERE id = 1`,
          Date.now() + 60_000,
        );
        await resident.product.recordWorkflowFailed(
          RUN_ID,
          { code: "agent_loop_failed", message: "Rally could not complete this execution" },
          { loopId: LOOP_ID, executionId: RUN_ID, executionEpoch: 1, leaseOwner: OWNER },
        );

        // The object-local terminal commit cannot settle an external receipt.
        // Its absent marker keeps this run eligible for the durable sweep.
        expect(state.storage.sql.exec<{ status: string } & Record<string, SqlStorageValue>>(
          `SELECT status FROM tool_effects WHERE effect_intent_id = 'open-effect'`,
        ).one().status).toBe("executing");
        expect(state.storage.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
          `SELECT COUNT(*) AS count FROM active_output_turns WHERE run_id = ?`,
          RUN_ID,
        ).one()).toEqual({ count: 0 });
        expect(state.storage.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
          `SELECT COUNT(*) AS count FROM inference_delay_status WHERE run_id = ?`,
          RUN_ID,
        ).one()).toEqual({ count: 0 });
        expect(state.storage.sql.exec<{
          status: string;
          terminal_reason: string | null;
        } & Record<string, SqlStorageValue>>(
          `SELECT status, terminal_reason FROM runs WHERE run_id = ?`,
          RUN_ID,
        ).one()).toEqual({ status: "failed", terminal_reason: "failed" });
        expect(state.storage.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
          `SELECT COUNT(*) AS count FROM run_lifecycle_events
            WHERE run_id = ? AND event_key = 'terminal'`,
          RUN_ID,
        ).one()).toEqual({ count: 1 });

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
